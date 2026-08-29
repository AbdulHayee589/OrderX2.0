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
    const orderGids = buildOrderGidVariants(payload?.orders_to_redact);

    const or = [];
    if (phone) or.push({ phoneE164: phone });
    if (orderGids.length) or.push({ orderGid: { $in: orderGids } });
    if (!or.length) {
      return res.json({
        ok: true,
        shop,
        attemptsMatched: 0,
        attemptsRedacted: 0,
        blockedDeleted: 0,
      });
    }

    const redactFilter = { shop, $or: or };
    const attemptsResult = await CodAttempt.updateMany(redactFilter, {
      $set: {
        customerName: "REDACTED",
        phoneE164: null,
        countryCode: null,
        timezone: null,
      },
    });

    let blockedDeleted = 0;
    let messagesDeleted = 0;
    let threadsDeleted = 0;
    if (phone) {
      const [blockedResult, messagesResult, threadsResult] = await Promise.all([
        BlockedContact.deleteMany({ shop, phoneE164: phone }),
        WaMessageLog.deleteMany({ shop, toE164: phone }),
        ConversationThread.deleteMany({
          shop,
          $or: [{ threadKey: phone }, { partnerE164: phone }],
        }),
      ]);
      blockedDeleted = Number(blockedResult?.deletedCount || 0);
      messagesDeleted = Number(messagesResult?.deletedCount || 0);
      threadsDeleted = Number(threadsResult?.deletedCount || 0);
    }

    return res.json({
      ok: true,
      shop,
      attemptsMatched: Number(attemptsResult?.matchedCount || 0),
      attemptsRedacted: Number(attemptsResult?.modifiedCount || 0),
      blockedDeleted,
      messagesDeleted,
      threadsDeleted,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

router.post("/privacy/shop-redact", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const [
      attempts,
      metrics,
      purchases,
      blocked,
      messages,
      threads,
      agentSessions,
      agentAccounts,
      shopRecord,
    ] = await Promise.all([
        CodAttempt.deleteMany({ shop }),
        Metric.deleteMany({ shop }),
        PlanPurchase.deleteMany({ shop }),
        BlockedContact.deleteMany({ shop }),
        WaMessageLog.deleteMany({ shop }),
        ConversationThread.deleteMany({ shop }),
        AgentSession.deleteMany({ shop }),
        AgentAccount.deleteMany({ shop }),
        Shop.deleteOne({ shop }),
      ]);

    return res.json({
      ok: true,
      shop,
      deleted: {
        attempts: Number(attempts?.deletedCount || 0),
        metrics: Number(metrics?.deletedCount || 0),
        purchases: Number(purchases?.deletedCount || 0),
        blockedContacts: Number(blocked?.deletedCount || 0),
        messages: Number(messages?.deletedCount || 0),
        conversationThreads: Number(threads?.deletedCount || 0),
        agentSessions: Number(agentSessions?.deletedCount || 0),
        agentAccounts: Number(agentAccounts?.deletedCount || 0),
        shops: Number(shopRecord?.deletedCount || 0),
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

export default router;
