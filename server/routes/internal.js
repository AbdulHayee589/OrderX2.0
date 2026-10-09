import express from "express";
import Shop from "../models/Shop.js";
import CodAttempt from "../models/CodAttempt.js";
import Metric from "../models/Metric.js";
import PlanPurchase from "../models/PlanPurchase.js";
import BlockedContact from "../models/BlockedContact.js";
import AgentAccount from "../models/AgentAccount.js";
import AgentSession from "../models/AgentSession.js";
import ConversationThread from "../models/ConversationThread.js";
import WaMessageLog from "../models/WaMessageLog.js";
import AbandonedCheckoutDispatch from "../models/AbandonedCheckoutDispatch.js";
import AgentConversationState from "../models/AgentConversationState.js";
import AgentSendReceipt from "../models/AgentSendReceipt.js";
import AuditLog from "../models/AuditLog.js";
import BillingUsageCharge from "../models/BillingUsageCharge.js";
import CampaignRecipient from "../models/CampaignRecipient.js";
import CampaignRun from "../models/CampaignRun.js";
import ConversationInitiation from "../models/ConversationInitiation.js";
import OrderUpdateDispatch from "../models/OrderUpdateDispatch.js";
import TeamInboxLabel from "../models/TeamInboxLabel.js";
import TeamInboxNote from "../models/TeamInboxNote.js";
import TeamInboxQuickReply from "../models/TeamInboxQuickReply.js";
import { agenda } from "../jobs/agenda.js";
import { processShopifyOrderUpdateWebhook } from "../services/orderUpdates.js";
import { maybeSyncStoreContext } from "../services/storeContext.js";
import { logAudit } from "../services/audit.js";
import {
  persistOfflineTokenPayload,
  revokeShopifyTokenState,
} from "../services/shopifyTokenService.js";

const router = express.Router();
const DEBUG = process.env.DEBUG_ORDERX === "true";
const dbg = (...args) => {
  if (DEBUG) console.log(...args);
};

function toStringArray(v) {
  if (Array.isArray(v)) {
    return v.map((x) => String(x || "").trim()).filter(Boolean);
  }
  if (typeof v === "string") {
    return v
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizePhoneE164ish(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  const digits = value.replace(/[^\d]/g, "");
  if (!digits) return "";
  return `+${digits}`;
}

function extractPrivacyPayload(req) {
  const body = req.body || {};
  if (body?.payload && typeof body.payload === "object") {
    return body.payload;
  }
  return body;
}

function buildOrderGidVariants(ids) {
  const out = new Set();
  for (const id of toStringArray(ids)) {
    out.add(id);
    if (/^\d+$/.test(id)) {
      out.add(`gid://shopify/Order/${id}`);
    }
  }
  return [...out];
}

// Server-to-server token sync from the embedded app template.
// This stores the offline access token in MongoDB so Agenda jobs and billing
// can call the Admin API without relying on the frontend DB.
router.post("/sync", async (req, res) => {
  try {
    const shop = req.query.shop;

    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const body = req.body || {};
    const { accessToken, host } = body;
    const tokenTypeRaw = String(req.body?.tokenType || "").trim().toLowerCase();
    const tokenType = tokenTypeRaw === "online" ? "online" : "offline";

    if (!accessToken)
      return res.status(400).json({ error: "Missing accessToken" });
    if (tokenType !== "offline") {
      return res.status(400).json({
        error: "Background Shopify access requires an offline token",
      });
    }

    const scopes = String(process.env.SCOPES);

    dbg("[internal_sync]", {
      shop,
      tokenType,
      hasAccessToken: true,
      hasRefreshToken: !!String(body?.refreshToken || "").trim(),
    });

    const tokenResult = await persistOfflineTokenPayload({
      shop,
      payload: {
        accessToken,
        tokenType,
        scopes,
        ...(Object.prototype.hasOwnProperty.call(body, "accessTokenExpiresAt")
          ? { accessTokenExpiresAt: body.accessTokenExpiresAt }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(body, "refreshToken")
          ? { refreshToken: body.refreshToken }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(body, "refreshTokenExpiresAt")
          ? { refreshTokenExpiresAt: body.refreshTokenExpiresAt }
          : {}),
      },
      host: host || null,
      scopes,
      installedAt: new Date(),
    });
    const record = await Shop.findOne({ shop }).lean();
    const effectiveAccessToken = tokenResult?.bundle?.accessToken;

    try {
      await maybeSyncStoreContext({
        shop,
        accessToken: effectiveAccessToken || record?.accessToken,
      });
    } catch (syncError) {
      console.warn(
        "[internal_sync_store_context]",
        shop,
        syncError?.message || syncError,
      );
    }

    dbg("[internal_sync_saved]", {
      shop: record.shop,
      tokenType: record.accessTokenType,
      updatedAt: record.accessTokenUpdatedAt,
    });

    return res.json({
      ok: true,
      shop: record.shop,
      tokenStored: tokenResult?.saved === true,
      tokenConflictRecovered: tokenResult?.conflict === true,
      tokenType: record.accessTokenType,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Called from Shopify app/uninstalled webhook handler (frontend) to revoke tokens in this backend.
router.post("/uninstall", async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!shop) return res.status(400).json({ error: "Missing shop" });
    const now = new Date();

    // Remove the canonical offline session and the mirrored Shop token in one
    // transaction so a stale session can never resurrect an uninstalled shop.
    await revokeShopifyTokenState(shop);

    await Shop.updateOne(
      { shop },
      {
        $set: {
          // keep settings for possible re-install, but disable billing/sending
          "billing.status": "NONE",
          "billing.subscriptionId": null,
          "billing.subscriptionTest": false,
          "billing.currentPeriodStart": null,
          "billing.currentPeriodEnd": null,
          "billing.cycleAnchorAt": null,
          "billing.cancelAtPeriodEnd": false,
          "billing.cancelledAt": now,
          "billing.hardStoppedAt": now,
          "billing.lastCheckedAt": now,
        },
      }
    );

    // An uninstalled merchant must not remain reachable through a previously
    // issued support-agent login.
    await Promise.all([
      AgentSession.deleteMany({ shop }),
      AgentAccount.deleteMany({ shop }),
    ]);

    void logAudit({
      shop,
      actor: "system",
      action: "app_uninstall",
      level: "warn",
      message: "Store uninstall or access revocation received.",
    });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

router.post("/shopify-order-update", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const topic = String(req.body?.topic || "").trim();
    const payload = req.body?.payload && typeof req.body.payload === "object"
      ? req.body.payload
      : null;
    const webhookId = String(req.body?.webhookId || "").trim() || null;

    if (!topic || !payload) {
      return res.status(400).json({ error: "Missing topic or payload" });
    }

    // Acknowledge quickly so the Shopify-facing webhook route can return fast.
    res.status(202).json({ ok: true, accepted: true });

    setImmediate(() => {
      processShopifyOrderUpdateWebhook({ shop, topic, payload, webhookId }).catch(
        (e) => {
          console.error(
            "[shopify_order_update_webhook]",
            shop,
            topic,
            e?.message || e,
          );
        },
      );
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

router.post("/shopify-order-created", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    res.status(202).json({ ok: true, accepted: true });

    setImmediate(() => {
      agenda
        .now("poll_cod_orders", { shop })
        .then(() => {
          dbg("[shopify_order_created_poll_now]", shop);
        })
        .catch((e) => {
          console.error(
            "[shopify_order_created_poll_now]",
            shop,
            e?.message || e,
          );
        });
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

router.post("/privacy/customers-data-request", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const payload = extractPrivacyPayload(req);
    const customer = payload?.customer || {};
    const phone = normalizePhoneE164ish(customer?.phone || payload?.phone);
    const orderGids = buildOrderGidVariants(payload?.orders_requested);

    const or = [];
    if (phone) or.push({ phoneE164: phone });
    if (orderGids.length) or.push({ orderGid: { $in: orderGids } });

    const filter = or.length ? { shop, $or: or } : { shop };
    const matchedAttempts = await CodAttempt.countDocuments(filter);

    console.log("[privacy_data_request]", {
      shop,
      matchedAttempts,
      hasPhone: !!phone,
      ordersRequested: orderGids.length,
    });

    return res.json({ ok: true, shop, matchedAttempts });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

router.post("/privacy/customers-redact", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const payload = extractPrivacyPayload(req);
    const customer = payload?.customer || {};
    const phone = normalizePhoneE164ish(customer?.phone || payload?.phone);
    const email = String(customer?.email || payload?.email || "")
      .trim()
      .toLowerCase();
    const customerId = String(customer?.id || payload?.customer_id || "").trim();
    const orderGids = buildOrderGidVariants(payload?.orders_to_redact);

    const or = [];
    if (phone) or.push({ phoneE164: phone });
    if (orderGids.length) or.push({ orderGid: { $in: orderGids } });
    if (!or.length && !email && !customerId) {
      return res.json({
        ok: true,
        shop,
        attemptsMatched: 0,
        attemptsRedacted: 0,
        blockedDeleted: 0,
      });
    }

    const attemptFilter = or.length ? { shop, $or: or } : { shop, _id: null };
    const attempts = await CodAttempt.find(attemptFilter)
      .select({ _id: 1, orderGid: 1 })
      .lean();
    const attemptIds = attempts.map((item) => item._id);
    const relatedOrderGids = Array.from(
      new Set([
        ...orderGids,
        ...attempts.map((item) => String(item?.orderGid || "")).filter(Boolean),
      ]),
    );
    let threadKeys = phone ? [phone, phone.replace(/^\+/, "")] : [];

    const messageOr = [];
    if (attemptIds.length) messageOr.push({ attemptId: { $in: attemptIds } });
    if (relatedOrderGids.length) {
      messageOr.push({ orderGid: { $in: relatedOrderGids } });
    }
    const threadOr = [];
    if (threadKeys.length) {
      threadOr.push(
        { threadKey: { $in: threadKeys } },
        { partnerE164: phone },
      );
    }
    if (email) threadOr.push({ customerEmail: email });
    if (customerId) {
      threadOr.push(
        { shopifyCustomerId: customerId },
        { shopifyCustomerId: `gid://shopify/Customer/${customerId}` },
      );
    }
    if (relatedOrderGids.length) {
      threadOr.push({ lastOrderGid: { $in: relatedOrderGids } });
    }
    if (threadOr.length) {
      const matchedThreads = await ConversationThread.find({
        shop,
        $or: threadOr,
      })
        .select({ threadKey: 1 })
        .lean();
      threadKeys = Array.from(
        new Set([
          ...threadKeys,
          ...matchedThreads
            .map((item) => String(item?.threadKey || "").trim())
            .filter(Boolean),
        ]),
      );
    }
    if (threadKeys.length) {
      messageOr.push({ toE164: { $in: threadKeys } });
    }

    const [
      attemptsResult,
      blockedResult,
      messagesResult,
      threadsResult,
      campaignRecipientsResult,
      abandonedResult,
      updatesResult,
      initiationsResult,
      agentStateResult,
      sendReceiptsResult,
      notesResult,
      usageChargesResult,
      campaignClaimsResult,
      auditsResult,
    ] = await Promise.all([
      CodAttempt.deleteMany({ _id: { $in: attemptIds } }),
      threadKeys.length
        ? BlockedContact.deleteMany({ shop, phoneE164: { $in: threadKeys } })
        : Promise.resolve({ deletedCount: 0 }),
      messageOr.length
        ? WaMessageLog.deleteMany({ shop, $or: messageOr })
        : Promise.resolve({ deletedCount: 0 }),
      threadOr.length
        ? ConversationThread.deleteMany({ shop, $or: threadOr })
        : Promise.resolve({ deletedCount: 0 }),
      threadKeys.length || relatedOrderGids.length
        ? CampaignRecipient.deleteMany({
            shop,
            $or: [
              ...(threadKeys.length
                ? [{ toE164: { $in: threadKeys } }]
                : []),
              ...(relatedOrderGids.length
                ? [{ orderGid: { $in: relatedOrderGids } }]
                : []),
            ],
          })
        : Promise.resolve({ deletedCount: 0 }),
      threadKeys.length || email
        ? AbandonedCheckoutDispatch.deleteMany({
            shop,
            $or: [
              ...(threadKeys.length
                ? [{ phoneE164: { $in: threadKeys } }]
                : []),
              ...(email ? [{ customerEmail: email }] : []),
            ],
          })
        : Promise.resolve({ deletedCount: 0 }),
      threadKeys.length || relatedOrderGids.length
        ? OrderUpdateDispatch.deleteMany({
            shop,
            $or: [
              ...(threadKeys.length
                ? [{ phoneE164: { $in: threadKeys } }]
                : []),
              ...(relatedOrderGids.length
                ? [{ orderGid: { $in: relatedOrderGids } }]
                : []),
            ],
          })
        : Promise.resolve({ deletedCount: 0 }),
      threadKeys.length
        ? ConversationInitiation.deleteMany({
            shop,
            toE164: { $in: threadKeys },
          })
        : Promise.resolve({ deletedCount: 0 }),
      threadKeys.length
        ? AgentConversationState.deleteMany({
            shop,
            threadKey: { $in: threadKeys },
          })
        : Promise.resolve({ deletedCount: 0 }),
      threadKeys.length
        ? AgentSendReceipt.deleteMany({ shop, threadKey: { $in: threadKeys } })
        : Promise.resolve({ deletedCount: 0 }),
      threadKeys.length
        ? TeamInboxNote.deleteMany({ shop, threadKey: { $in: threadKeys } })
        : Promise.resolve({ deletedCount: 0 }),
      relatedOrderGids.length
        ? BillingUsageCharge.deleteMany({
            shop,
            orderGid: { $in: relatedOrderGids },
          })
        : Promise.resolve({ deletedCount: 0 }),
      threadKeys.length
        ? CampaignRun.updateMany(
            { shop },
            {
              $pull: {
                recipientPhoneClaims: { phoneKey: { $in: threadKeys } },
              },
            },
          )
        : Promise.resolve({ modifiedCount: 0 }),
      threadKeys.length || relatedOrderGids.length
        ? AuditLog.deleteMany({
            shop,
            $or: [
              ...(threadKeys.length
                ? [
                    { "meta.phoneE164": { $in: threadKeys } },
                    { "meta.toE164": { $in: threadKeys } },
                    { "meta.threadKey": { $in: threadKeys } },
                  ]
                : []),
              ...(relatedOrderGids.length
                ? [{ "meta.orderGid": { $in: relatedOrderGids } }]
                : []),
            ],
          })
        : Promise.resolve({ deletedCount: 0 }),
    ]);

    return res.json({
      ok: true,
      shop,
      deleted: {
        attempts: Number(attemptsResult?.deletedCount || 0),
        blockedContacts: Number(blockedResult?.deletedCount || 0),
        messages: Number(messagesResult?.deletedCount || 0),
        conversationThreads: Number(threadsResult?.deletedCount || 0),
        campaignRecipients: Number(campaignRecipientsResult?.deletedCount || 0),
        abandonedCheckouts: Number(abandonedResult?.deletedCount || 0),
        orderUpdates: Number(updatesResult?.deletedCount || 0),
        conversationInitiations: Number(initiationsResult?.deletedCount || 0),
        agentConversationStates: Number(agentStateResult?.deletedCount || 0),
        agentSendReceipts: Number(sendReceiptsResult?.deletedCount || 0),
        inboxNotes: Number(notesResult?.deletedCount || 0),
        billingUsageCharges: Number(usageChargesResult?.deletedCount || 0),
        campaignPhoneClaims: Number(campaignClaimsResult?.modifiedCount || 0),
        auditLogs: Number(auditsResult?.deletedCount || 0),
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

router.post("/privacy/shop-redact", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const [attemptRows, campaignRows] = await Promise.all([
      CodAttempt.find({ shop }).select({ _id: 1 }).lean(),
      CampaignRun.find({ shop }).select({ _id: 1 }).lean(),
    ]);
    const attemptIds = attemptRows.map((item) => String(item._id));
    const campaignRunIds = campaignRows.map((item) => String(item._id));

    // Remove the canonical Shopify session before deleting the Shop mirror.
    await revokeShopifyTokenState(shop);
    await agenda.cancel({
      $or: [
        { "data.shop": shop },
        ...(attemptIds.length
          ? [{ "data.attemptId": { $in: attemptIds } }]
          : []),
        ...(campaignRunIds.length
          ? [{ "data.campaignRunId": { $in: campaignRunIds } }]
          : []),
      ],
    });

    const shopScopedModels = {
      abandonedCheckoutDispatches: AbandonedCheckoutDispatch,
      agentAccounts: AgentAccount,
      agentConversationStates: AgentConversationState,
      agentSendReceipts: AgentSendReceipt,
      agentSessions: AgentSession,
      attempts: CodAttempt,
      auditLogs: AuditLog,
      billingUsageCharges: BillingUsageCharge,
      blockedContacts: BlockedContact,
      campaignRecipients: CampaignRecipient,
      campaignRuns: CampaignRun,
      conversationInitiations: ConversationInitiation,
      conversationThreads: ConversationThread,
      inboxLabels: TeamInboxLabel,
      inboxNotes: TeamInboxNote,
      inboxQuickReplies: TeamInboxQuickReply,
      messages: WaMessageLog,
      metrics: Metric,
      orderUpdateDispatches: OrderUpdateDispatch,
      planPurchases: PlanPurchase,
    };
    const entries = Object.entries(shopScopedModels);
    const results = await Promise.all(
      entries.map(([, Model]) => Model.deleteMany({ shop })),
    );
    const deleted = Object.fromEntries(
      entries.map(([key], index) => [
        key,
        Number(results[index]?.deletedCount || 0),
      ]),
    );
    const shopRecord = await Shop.deleteOne({ shop });
    deleted.shops = Number(shopRecord?.deletedCount || 0);

    return res.json({
      ok: true,
      shop,
      deleted,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

export default router;
