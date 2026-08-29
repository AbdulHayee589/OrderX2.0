import crypto from "crypto";

import BlockedContact from "../models/BlockedContact.js";
import CodAttempt from "../models/CodAttempt.js";
import OrderUpdateDispatch from "../models/OrderUpdateDispatch.js";
import Shop from "../models/Shop.js";
import { buildShopifyCredentialCandidateQuery } from "./shopifyTokenState.js";

import { canSendWhatsApp, incrementWhatsAppUsage } from "./usage.js";
import { normalizePhoneE164 } from "./phone.js";
import {
  getAdminClient,
  listOrdersForReviewRequests,
} from "./shopifyAdmin.js";
import {
  ensureAutomationFlowConfigs,
  ensureManagedTemplateCatalog,
  FLOW_KEYS,
  isTemplateApproved,
  resolveAssignedTemplateForFlow,
} from "./templateCatalog.js";
import {
  tagOrderForMetaSendError,
} from "./noWhatsappTag.js";
import { getPlan, SENDER_MODES } from "./plans.js";
import {
  resolveRuntimeConfig,
  sendReviewRequestTemplate,
} from "./whatsapp.js";
import { summarizeSendGateForStorage } from "./storageSanitizer.js";

const POLL_BATCH_SIZE = Math.max(
  1,
  Math.min(50, Number(process.env.REVIEW_REQUEST_POLL_BATCH_SIZE || 25) || 25),
);
const MAX_PER_SHOP = Math.max(
  1,
  Math.min(200, Number(process.env.REVIEW_REQUEST_MAX_PER_SHOP || 75) || 75),
);
const RETRY_COOLDOWN_MINUTES = Math.max(
  5,
  Number(process.env.REVIEW_REQUEST_RETRY_COOLDOWN_MINUTES || 180) || 180,
);
const LOOKBACK_HOURS = Math.max(
  24,
  Number(process.env.REVIEW_REQUEST_LOOKBACK_HOURS || 24 * 14) || 24 * 14,
);
const DEFAULT_DELAY_HOURS = Math.max(
  0,
  Number(process.env.REVIEW_REQUEST_DEFAULT_DELAY_HOURS || 96) || 96,
);

function asString(value) {
  return String(value || "").trim();
}

function normalizeOrderUpdatesScope(value) {
  return asString(value).toLowerCase() === "confirmed_only"
    ? "confirmed_only"
    : "all_orders";
}

function requiresConfirmedOrderUpdates(shopRecord) {
  return (
    normalizeOrderUpdatesScope(shopRecord?.settings?.orderUpdatesScope) ===
    "confirmed_only"
  );
}

function hashKey(prefix, raw) {
  const digest = crypto
    .createHash("sha1")
    .update(String(raw || ""))
    .digest("hex");
  return `${prefix}:${digest}`;
}

function isOwnNumberPlanRecord(record) {
  const plan = getPlan(record?.billing?.planKey);
  return String(plan?.senderMode || "").trim() === SENDER_MODES.OWN_NUMBER;
}

function getReviewFlow(shopRecord) {
  const flows = ensureAutomationFlowConfigs(shopRecord?.settings?.automationFlows);
  const row = flows.find((flow) => flow.flowKey === FLOW_KEYS.REVIEW_REQUEST);
  const rawDelay =
    row?.config?.delayHours ?? shopRecord?.settings?.reviewRequestDelayHours;
  const parsedDelay = Number(rawDelay);
  const linkMode = asString(
    row?.config?.linkMode || shopRecord?.settings?.reviewRequestLinkMode || "store",
  ).toLowerCase();
  return {
    flows,
    row: row || null,
    enabled: !!row?.enabled,
    delayHours: Math.max(
      0,
      Math.min(
        24 * 30,
        Number.isFinite(parsedDelay) ? parsedDelay : DEFAULT_DELAY_HOURS,
      ),
    ),
    linkMode: linkMode === "product" ? "product" : "store",
    reviewUrl:
      asString(row?.config?.reviewUrl) ||
      asString(shopRecord?.settings?.reviewRequestUrl) ||
      "",
  };
}

function isRetryReady(existing, now = new Date()) {
  if (!existing) return true;
  const status = asString(existing.status).toLowerCase();
  if (status === "sent") return false;
  const updatedAt = existing.updatedAt ? new Date(existing.updatedAt) : null;
  if (!updatedAt || !Number.isFinite(updatedAt.getTime())) return true;
  return (
    now.getTime() - updatedAt.getTime() >= RETRY_COOLDOWN_MINUTES * 60 * 1000
  );
}

function formatAmount(value, currency) {
  const amount = Number(value || 0);
  const code = asString(currency);
  if (!Number.isFinite(amount) || !code) return "";
  return `${code} ${amount.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

function normalizeOrderPhone(order) {
  const countryCode = asString(order?.countryCode || "").toUpperCase() || undefined;
  return (
    normalizePhoneE164(order?.customerPhone, countryCode) ||
    normalizePhoneE164(order?.shippingPhone, countryCode) ||
    normalizePhoneE164(order?.billingPhone, countryCode) ||
    ""
  );
}

function buildAddressText(order) {
  const parts = [
    order?.shippingAddress?.address1,
    order?.shippingAddress?.city,
    order?.shippingAddress?.zip,
  ]
    .map(asString)
    .filter(Boolean);
  return parts.join(", ");
}

function buildSearchQuery(windowStart, cutoff) {
  const startIso = new Date(windowStart).toISOString();
  const cutoffIso = new Date(cutoff).toISOString();
  return [
    "status:any",
    "fulfillment_status:fulfilled",
    `updated_at:>='${startIso}'`,
    `updated_at:<='${cutoffIso}'`,
  ].join(" ");
}

async function markDispatchByDedupe(dedupeKey, patch = {}) {
  await OrderUpdateDispatch.updateOne(
    { dedupeKey },
    {
      $set: patch,
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );
}

async function alreadySentReviewRequest(shop, orderGid) {
  return OrderUpdateDispatch.exists({
    shop,
    orderGid,
    eventType: { $in: ["review_request", "review_request_poll"] },
    status: "sent",
  });
}

async function processOrder({ shopRecord, order, flow, now }) {
  const shop = asString(shopRecord?.shop);
  const orderGid = asString(order?.id);
  const dedupeKey = hashKey("review_request_poll", `${shop}|${orderGid}`);
  const existing = await OrderUpdateDispatch.findOne({ dedupeKey }).lean();
  if (!isRetryReady(existing, now)) {
    return { ok: true, skipped: true, reason: "cooldown", dedupeKey };
  }

  const phoneE164 = normalizeOrderPhone(order);
  const cutoffTime = order?.updatedAt ? new Date(order.updatedAt) : null;
  const ageHours = cutoffTime
    ? Math.max(0, Math.floor((now.getTime() - cutoffTime.getTime()) / 3600000))
    : flow.delayHours;
  const productUrl = asString(order?.productUrl);
  const reviewUrl =
    flow.linkMode === "product"
      ? productUrl || asString(flow.reviewUrl) || ""
      : asString(flow.reviewUrl) || "";

  const baseMeta = {
    orderName: asString(order?.name) || null,
    orderUpdatedAt: cutoffTime || null,
    delayHours: flow.delayHours,
    ageHours,
    lineSummary: Array.isArray(order?.lineSummary) ? order.lineSummary : [],
    productImageUrl: asString(order?.productImageUrl) || null,
    productUrl: productUrl || null,
    reviewLinkMode: flow.linkMode,
    reviewUrl: reviewUrl || null,
  };

  if (!phoneE164) {
    await markDispatchByDedupe(dedupeKey, {
      shop,
      topic: "poll/review_request",
      eventType: "review_request_poll",
      dedupeKey,
      orderGid,
      orderId: asString(orderGid.split("/").pop()) || null,
      phoneE164: null,
      status: "skipped",
      skippedReason: "missing_phone",
      meta: baseMeta,
    });
    return { ok: true, skipped: true, reason: "missing_phone", dedupeKey };
  }

  if (!reviewUrl) {
    await markDispatchByDedupe(dedupeKey, {
      shop,
      topic: "poll/review_request",
      eventType: "review_request_poll",
      dedupeKey,
      orderGid,
      orderId: asString(orderGid.split("/").pop()) || null,
      phoneE164,
      status: "skipped",
      skippedReason: "missing_review_url",
      meta: baseMeta,
    });
    return { ok: true, skipped: true, reason: "missing_review_url", dedupeKey };
  }

  if (await alreadySentReviewRequest(shop, orderGid)) {
    await markDispatchByDedupe(dedupeKey, {
      shop,
      topic: "poll/review_request",
      eventType: "review_request_poll",
      dedupeKey,
      orderGid,
      orderId: asString(orderGid.split("/").pop()) || null,
      phoneE164,
      status: "skipped",
      skippedReason: "already_sent",
      meta: baseMeta,
    });
    return { ok: true, skipped: true, reason: "already_sent", dedupeKey };
  }

  const attempt = await CodAttempt.findOne({
    shop,
    orderGid,
    stage: "pre_dispatch",
  })
    .sort({ createdAt: -1 })
    .lean();
  const requireConfirmedUpdates = requiresConfirmedOrderUpdates(shopRecord);
  const resolvedPhone = asString(attempt?.phoneE164) || phoneE164;

  if (!resolvedPhone) {
    await markDispatchByDedupe(dedupeKey, {
      shop,
      topic: "poll/review_request",
      eventType: "review_request_poll",
      dedupeKey,
      orderGid,
      orderId: asString(orderGid.split("/").pop()) || null,
      phoneE164: null,
      status: "skipped",
      skippedReason: "no_cod_attempt_or_phone",
      meta: baseMeta,
    });
    return { ok: true, skipped: true, reason: "no_cod_attempt_or_phone", dedupeKey };
  }

  if (requireConfirmedUpdates && String(attempt?.status || "").trim().toLowerCase() !== "confirmed") {
    await markDispatchByDedupe(dedupeKey, {
      shop,
      topic: "poll/review_request",
      eventType: "review_request_poll",
      dedupeKey,
      orderGid,
      orderId: asString(orderGid.split("/").pop()) || null,
      phoneE164: resolvedPhone,
      attemptId: attempt?._id || null,
      status: "skipped",
      skippedReason: "attempt_not_confirmed",
      meta: baseMeta,
    });
    return { ok: true, skipped: true, reason: "attempt_not_confirmed", dedupeKey };
  }

  const blocked = await BlockedContact.exists({
    shop,
    phoneE164: resolvedPhone,
  });
  if (blocked) {
    await markDispatchByDedupe(dedupeKey, {
      shop,
      topic: "poll/review_request",
      eventType: "review_request_poll",
      dedupeKey,
      orderGid,
      orderId: asString(orderGid.split("/").pop()) || null,
      phoneE164: resolvedPhone,
      attemptId: attempt?._id || null,
      status: "skipped",
      skippedReason: "blocked_contact",
      meta: baseMeta,
    });
    return { ok: true, skipped: true, reason: "blocked_contact", dedupeKey };
  }

  const runtime = await resolveRuntimeConfig(shop).catch(() => null);
  if (
    String(runtime?.senderMode || "").trim() !== SENDER_MODES.OWN_NUMBER ||
    runtime?.senderUnavailableReason
  ) {
    await markDispatchByDedupe(dedupeKey, {
      shop,
      topic: "poll/review_request",
      eventType: "review_request_poll",
      dedupeKey,
      orderGid,
      orderId: asString(orderGid.split("/").pop()) || null,
      phoneE164: resolvedPhone,
      attemptId: attempt?._id || null,
      status: "skipped",
      skippedReason: "sender_not_ready",
      errorMeta: runtime?.senderUnavailableReason
        ? { senderUnavailableReason: runtime.senderUnavailableReason }
        : null,
      meta: baseMeta,
    });
    return { ok: true, skipped: true, reason: "sender_not_ready", dedupeKey };
  }

  const gate = await canSendWhatsApp(shop, {
    toE164: resolvedPhone,
    alreadyInConversationWindow: false,
    senderPhoneNumberId: runtime?.phoneId || "",
    isTemplate: true,
  });
  if (!gate?.ok) {
    await markDispatchByDedupe(dedupeKey, {
      shop,
      topic: "poll/review_request",
      eventType: "review_request_poll",
      dedupeKey,
      orderGid,
      orderId: asString(orderGid.split("/").pop()) || null,
      phoneE164: resolvedPhone,
      attemptId: attempt?._id || null,
      status: "skipped",
      skippedReason: "billing_or_usage_blocked",
      errorMeta: summarizeSendGateForStorage(gate),
      meta: baseMeta,
    });
    return {
      ok: true,
      skipped: true,
      reason: "billing_or_usage_blocked",
      dedupeKey,
    };
  }

  await markDispatchByDedupe(dedupeKey, {
    shop,
    topic: "poll/review_request",
    eventType: "review_request_poll",
    dedupeKey,
    orderGid,
    orderId: asString(orderGid.split("/").pop()) || null,
    phoneE164: resolvedPhone,
    attemptId: attempt?._id || null,
    status: "processing",
    skippedReason: null,
    errorMessage: null,
    errorMeta: null,
    meta: baseMeta,
  });

  const productsText = Array.isArray(order?.lineSummary)
    ? order.lineSummary.join("\n")
    : "";
  const sendResult = await sendReviewRequestTemplate({
    to: resolvedPhone,
    customerName:
      asString(attempt?.customerName) || asString(order?.customerName) || "Customer",
    storeName:
      asString(order?.shopName) || shop.replace(".myshopify.com", ""),
    orderNumber: asString(order?.name),
    productsText,
    productImageUrl: asString(order?.productImageUrl) || "",
    reviewUrl,
    shop,
    attemptId: attempt?._id || null,
    orderGid,
    meta: {
      source: "review_request_poll",
      eventType: "review_request_poll",
      orderName: asString(order?.name) || null,
      reviewUrl,
      totalPrice: formatAmount(order?.amount, order?.currencyCode),
      deliveryAddress: buildAddressText(order),
    },
  });

  await incrementWhatsAppUsage(shop, 1, {
    isTemplate: true,
    toE164: resolvedPhone,
    countInitiatedConversation: true,
    senderPhoneNumberId: runtime?.phoneId || "",
  });

  await markDispatchByDedupe(dedupeKey, {
    shop,
    topic: "poll/review_request",
    eventType: "review_request_poll",
    dedupeKey,
    orderGid,
    orderId: asString(orderGid.split("/").pop()) || null,
    phoneE164: resolvedPhone,
    attemptId: attempt?._id || null,
    status: "sent",
    skippedReason: null,
    channel: "template",
    templateUsed: sendResult?.templateUsed || null,
    waMessageId: sendResult?.data?.messages?.[0]?.id || null,
    sentAt: new Date(),
    errorMessage: null,
    errorMeta: null,
    meta: {
      ...baseMeta,
      orderName: asString(order?.name) || null,
    },
  });

  return {
    ok: true,
    sent: true,
    dedupeKey,
    waMessageId: sendResult?.data?.messages?.[0]?.id || null,
  };
}

async function processShop(shopRecord, now) {
  const shop = asString(shopRecord?.shop);
  const flow = getReviewFlow(shopRecord);
  if (!shop || !flow.enabled) {
    return { shop, scanned: 0, sent: 0, skipped: 0, failed: 0 };
  }
  if (!isOwnNumberPlanRecord(shopRecord)) {
    return {
      shop,
      scanned: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      reason: "requires_own_number_plan",
    };
  }

  const catalog = ensureManagedTemplateCatalog(
    shopRecord?.whatsappSender?.ownNumber?.managedTemplates,
  );
  const assignedTemplate = resolveAssignedTemplateForFlow({
    catalog,
    flows: flow.flows,
    flowKey: FLOW_KEYS.REVIEW_REQUEST,
  });
  if (!assignedTemplate || !isTemplateApproved(assignedTemplate)) {
    return {
      shop,
      scanned: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      reason: "template_not_ready",
    };
  }
  const admin = await getAdminClient(shop, {
    accessToken: shopRecord.accessToken || "",
    record: shopRecord,
  });
  const cutoff = new Date(now.getTime() - flow.delayHours * 60 * 60 * 1000);
  const windowStart = new Date(now.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000);
  const query = buildSearchQuery(windowStart, cutoff);

  let after = null;
  let scanned = 0;
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  while (scanned < MAX_PER_SHOP) {
    const page = await listOrdersForReviewRequests(admin, {
      first: Math.min(POLL_BATCH_SIZE, MAX_PER_SHOP - scanned),
      after,
      query,
    });
    const items = Array.isArray(page?.items) ? page.items : [];
    if (!items.length) break;

    for (const order of items) {
      scanned += 1;
      try {
        const result = await processOrder({ shopRecord, order, flow, now });
        if (result?.sent) sent += 1;
        else skipped += 1;
      } catch (error) {
        failed += 1;
        const dedupeKey = hashKey(
          "review_request_poll",
          `${shop}|${asString(order?.id)}`,
        );
        await markDispatchByDedupe(dedupeKey, {
          shop,
          topic: "poll/review_request",
          eventType: "review_request_poll",
          dedupeKey,
          orderGid: asString(order?.id),
          orderId: asString(asString(order?.id).split("/").pop()) || null,
          phoneE164: normalizeOrderPhone(order) || null,
          status: "failed",
          errorMessage: error?.message || "review request poll failed",
          errorMeta: error?.meta || error?.data || null,
          meta: {
            orderName: asString(order?.name) || null,
          },
        });
        await tagOrderForMetaSendError({
          shop,
          accessToken: shopRecord?.accessToken,
          orderGid: asString(order?.id),
          error,
          label: "review_request_error_tag",
        });
      }
      if (scanned >= MAX_PER_SHOP) break;
    }

    if (!page?.pageInfo?.hasNextPage || !page?.pageInfo?.endCursor) break;
    after = page.pageInfo.endCursor;
  }

  return { shop, scanned, sent, skipped, failed };
}

export async function pollReviewRequestRecoveries({ now = new Date() } = {}) {
  const shops = await Shop.find(
    {
      ...buildShopifyCredentialCandidateQuery(),
      "settings.automationFlows": {
        $elemMatch: {
          flowKey: FLOW_KEYS.REVIEW_REQUEST,
          enabled: true,
        },
      },
    },
    {
      shop: 1,
      accessToken: 1,
      settings: 1,
      billing: 1,
      whatsappSender: 1,
    },
  ).lean();

  const results = [];
  for (const shopRecord of shops) {
    try {
      results.push(await processShop(shopRecord, now));
    } catch (error) {
      results.push({
        shop: asString(shopRecord?.shop),
        scanned: 0,
        sent: 0,
        skipped: 0,
        failed: 1,
        error: error?.message || "review request poll failed",
      });
    }
  }

  return {
    ok: true,
    shopCount: shops.length,
    results,
  };
}
