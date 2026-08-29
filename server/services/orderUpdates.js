import crypto from "crypto";

import BlockedContact from "../models/BlockedContact.js";
import CodAttempt from "../models/CodAttempt.js";
import OrderUpdateDispatch from "../models/OrderUpdateDispatch.js";
import Shop from "../models/Shop.js";

import { canSendWhatsApp, incrementWhatsAppUsage } from "./usage.js";
import {
  fetchOrderForCodConfirmTemplate,
  getAdminClient,
} from "./shopifyAdmin.js";
import { ensureAutomationFlowConfigs, FLOW_KEYS } from "./templateCatalog.js";
import {
  tagOrderForMetaSendError,
} from "./noWhatsappTag.js";
import {
  resolveRuntimeConfig,
  sendOrderCancelledUpdateTemplate,
  sendOrderDispatchedTemplate,
  sendReviewRequestTemplate,
  sendTrackingUpdatedTemplate,
} from "./whatsapp.js";
import { hasRecentInboundForSender } from "./waSessionWindow.js";
import { summarizeSendGateForStorage } from "./storageSanitizer.js";

function normalizeTopic(topic) {
  return String(topic || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "/");
}

function asString(v) {
  return String(v ?? "").trim();
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

function normalizePhoneE164(raw) {
  const digits = String(raw || "").replace(/[^\d]/g, "");
  return digits ? `+${digits}` : "";
}

function toOrderGid(payload = {}) {
  const directGid = asString(payload?.admin_graphql_api_id);
  if (directGid.startsWith("gid://shopify/Order/")) return directGid;

  const orderGraphqlId = asString(payload?.order_admin_graphql_api_id);
  if (orderGraphqlId.startsWith("gid://shopify/Order/")) return orderGraphqlId;

  const orderId = asString(payload?.order_id || payload?.id);
  if (/^\d+$/.test(orderId)) return `gid://shopify/Order/${orderId}`;
  return "";
}

function getOrderIdString(payload = {}, topic = "") {
  const t = normalizeTopic(topic);
  const candidate =
    t === "orders/cancelled" ? payload?.id : payload?.order_id || payload?.id;
  const id = asString(candidate);
  return id || null;
}

function extractTrackingInfo(payload = {}) {
  const infoRows = Array.isArray(payload?.tracking_info)
    ? payload.tracking_info
    : [];
  if (infoRows.length) {
    const companies = infoRows.map((x) => asString(x?.company)).filter(Boolean);
    const numbers = infoRows
      .flatMap((x) => (Array.isArray(x?.number) ? x.number : [x?.number]))
      .map(asString)
      .filter(Boolean);
    const urls = infoRows
      .flatMap((x) => (Array.isArray(x?.url) ? x.url : [x?.url]))
      .map(asString)
      .filter(Boolean);
    return {
      company: companies[0] || asString(payload?.tracking_company),
      numbers,
      urls,
    };
  }

  const numbers = []
    .concat(payload?.tracking_numbers || [])
    .map(asString)
    .filter(Boolean);
  const urls = []
    .concat(payload?.tracking_urls || [])
    .map(asString)
    .filter(Boolean);

  const singleNumber = asString(payload?.tracking_number);
  const singleUrl = asString(payload?.tracking_url);
  if (singleNumber && !numbers.includes(singleNumber))
    numbers.unshift(singleNumber);
  if (singleUrl && !urls.includes(singleUrl)) urls.unshift(singleUrl);

  return {
    company: asString(payload?.tracking_company),
    numbers,
    urls,
  };
}

function extractShipmentStatus(payload = {}) {
  const candidates = [
    payload?.shipment_status,
    payload?.shipmentStatus,
    payload?.status,
  ]
    .concat(
      Array.isArray(payload?.tracking_info)
        ? payload.tracking_info.flatMap((row) => [
            row?.shipment_status,
            row?.shipmentStatus,
            row?.status,
          ])
        : [],
    )
    .map(asString)
    .filter(Boolean)
    .map((value) => value.toLowerCase());

  return candidates.find(Boolean) || "";
}

function isReviewRequestDeliveredStatus(status) {
  const normalized = String(status || "")
    .trim()
    .toLowerCase();
  return normalized === "delivered";
}

function trackingFingerprint(info) {
  const payload = JSON.stringify({
    company: asString(info?.company).toLowerCase(),
    numbers: (Array.isArray(info?.numbers) ? info.numbers : []).map((x) =>
      asString(x).toLowerCase(),
    ),
    urls: (Array.isArray(info?.urls) ? info.urls : []).map((x) =>
      asString(x).toLowerCase(),
    ),
  });
  return crypto.createHash("sha1").update(payload).digest("hex");
}

function hashKey(prefix, raw) {
  const digest = crypto
    .createHash("sha1")
    .update(String(raw || ""))
    .digest("hex");
  return `${prefix}:${digest}`;
}

function buildProductsTextFromOrder(order) {
  const edges = Array.isArray(order?.lineItems?.edges)
    ? order.lineItems.edges
    : [];
  const lines = edges
    .map((edge) => edge?.node)
    .filter(Boolean)
    .map((li) => {
      const title = asString(li?.title);
      const qty = Number(li?.quantity || 0);
      const variant = asString(li?.variantTitle);
      if (!title || !Number.isFinite(qty) || qty <= 0) return "";
      const variantPart =
        variant && variant.toLowerCase() !== "default title"
          ? ` (${variant})`
          : "";
      return `${title}${variantPart} Qty ${qty}`;
    })
    .filter(Boolean);
  return lines.join("\n");
}

function firstProductImageUrl(order) {
  const edges = Array.isArray(order?.lineItems?.edges)
    ? order.lineItems.edges
    : [];
  for (const edge of edges) {
    const line = edge?.node || {};
    const candidates = [
      line?.image?.url,
      line?.variant?.image?.url,
      line?.variant?.product?.featuredImage?.url,
      line?.product?.featuredImage?.url,
    ];
    const hit = candidates
      .map(asString)
      .find((value) => /^https:\/\//i.test(value));
    if (hit) return hit;
  }
  return "";
}

function firstProductUrl(order, shopUrl = "") {
  const edges = Array.isArray(order?.lineItems?.edges)
    ? order.lineItems.edges
    : [];
  const normalizedShopUrl = asString(shopUrl).replace(/\/+$/, "");
  for (const edge of edges) {
    const line = edge?.node || {};
    const candidates = [
      line?.product?.onlineStoreUrl,
      line?.variant?.product?.onlineStoreUrl,
    ];
    const hit = candidates
      .map(asString)
      .find((value) => /^https?:\/\//i.test(value));
    if (hit) return hit;

    const handle = asString(
      line?.product?.handle || line?.variant?.product?.handle,
    );
    if (handle && /^https?:\/\//i.test(normalizedShopUrl)) {
      return `${normalizedShopUrl}/products/${encodeURIComponent(handle)}`;
    }
  }
  return "";
}

function buildProductsTextFromFulfillmentPayload(payload = {}) {
  const items = Array.isArray(payload?.line_items) ? payload.line_items : [];
  const lines = items
    .map((li) => {
      const title = asString(li?.name || li?.title);
      const qty = Number(li?.quantity || 0);
      const variant = asString(li?.variant_title || li?.variantTitle);
      if (!title || !Number.isFinite(qty) || qty <= 0) return "";
      const variantPart =
        variant && variant.toLowerCase() !== "default title"
          ? ` (${variant})`
          : "";
      return `${title}${variantPart} Qty ${qty}`;
    })
    .filter(Boolean);
  return lines.join("\n");
}

function resolveOrderPhone(order = {}) {
  return normalizePhoneE164(
    order?.shippingAddress?.phone ||
      order?.billingAddress?.phone ||
      order?.customer?.phone ||
      "",
  );
}

function formatAmountText(order) {
  const amount = Number(order?.currentTotalPriceSet?.shopMoney?.amount);
  const currency = asString(
    order?.currentTotalPriceSet?.shopMoney?.currencyCode,
  );
  if (!Number.isFinite(amount) || !currency) return "Not available";
  return `${amount.toFixed(2)} ${currency}`;
}

function formatCancelReason(payload = {}) {
  const note = asString(payload?.cancel_reason || payload?.cancelReason);
  if (!note) return "No reason provided";
  return note.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

async function claimDispatch(seed) {
  const result = await OrderUpdateDispatch.updateOne(
    { dedupeKey: seed.dedupeKey },
    {
      $setOnInsert: {
        shop: seed.shop,
        topic: seed.topic,
        eventType: seed.eventType,
        dedupeKey: seed.dedupeKey,
        webhookId: seed.webhookId || null,
        orderId: seed.orderId || null,
        orderGid: seed.orderGid || null,
        fulfillmentId: seed.fulfillmentId || null,
        trackingFingerprint: seed.trackingFingerprint || null,
        status: "processing",
        meta: seed.meta || null,
      },
    },
    { upsert: true },
  );

  return Number(result?.upsertedCount || 0) > 0;
}

async function markDispatch(dedupeKey, patch = {}) {
  await OrderUpdateDispatch.updateOne(
    { dedupeKey },
    {
      $set: patch,
    },
  );
}

function buildEventSeed({ shop, topic, payload, webhookId }) {
  const normalizedTopic = normalizeTopic(topic);
  const orderId = getOrderIdString(payload, normalizedTopic);
  const orderGid = toOrderGid(payload);

  if (normalizedTopic === "fulfillments/create") {
    const fulfillmentId = asString(
      payload?.id || payload?.admin_graphql_api_id,
    );
    const rawKey = `${shop}|${normalizedTopic}|${fulfillmentId || "missing"}`;
    return {
      eventType: "dispatched",
      shop,
      topic: normalizedTopic,
      webhookId,
      orderId,
      orderGid,
      fulfillmentId: fulfillmentId || null,
      dedupeKey: hashKey("order_update_dispatched", rawKey),
      trackingFingerprint: null,
      meta: null,
    };
  }

  if (normalizedTopic === "fulfillments/update") {
    const fulfillmentId = asString(
      payload?.id || payload?.admin_graphql_api_id,
    );
    const shipmentStatus = extractShipmentStatus(payload);
    if (isReviewRequestDeliveredStatus(shipmentStatus)) {
      const rawKey = `${shop}|${normalizedTopic}|${fulfillmentId || "missing"}|review_request|${shipmentStatus}`;
      return {
        eventType: "review_request",
        shop,
        topic: normalizedTopic,
        webhookId,
        orderId,
        orderGid,
        fulfillmentId: fulfillmentId || null,
        dedupeKey: hashKey("order_update_review_request", rawKey),
        trackingFingerprint: null,
        meta: {
          shipmentStatus,
        },
      };
    }
    const tracking = extractTrackingInfo(payload);
    const hasTracking =
      asString(tracking.company) ||
      (tracking.numbers && tracking.numbers.length) ||
      (tracking.urls && tracking.urls.length);
    if (!hasTracking) return null;
    const fingerprint = trackingFingerprint(tracking);
    const rawKey = `${shop}|${normalizedTopic}|${fulfillmentId || "missing"}|${fingerprint}`;
    return {
      eventType: "tracking_updated",
      shop,
      topic: normalizedTopic,
      webhookId,
      orderId,
      orderGid,
      fulfillmentId: fulfillmentId || null,
      dedupeKey: hashKey("order_update_tracking", rawKey),
      trackingFingerprint: fingerprint,
      meta: {
        trackingCompany: tracking.company || null,
        trackingNumbers: tracking.numbers || [],
        trackingUrls: tracking.urls || [],
      },
    };
  }

  if (normalizedTopic === "orders/cancelled") {
    const cancelledAt = asString(
      payload?.cancelled_at || payload?.updated_at || payload?.processed_at,
    );
    const rawKey = `${shop}|${normalizedTopic}|${orderId || "missing"}|${cancelledAt || "none"}`;
    return {
      eventType: "cancelled",
      shop,
      topic: normalizedTopic,
      webhookId,
      orderId,
      orderGid,
      fulfillmentId: null,
      dedupeKey: hashKey("order_update_cancelled", rawKey),
      trackingFingerprint: null,
      meta: {
        cancelledAt: cancelledAt || null,
        cancelReason:
          asString(payload?.cancel_reason || payload?.cancelReason) || null,
      },
    };
  }

  return null;
}

function buildTemplateArgs(eventType, common, eventSpecific) {
  if (eventType === "dispatched") {
    return {
      fn: sendOrderDispatchedTemplate,
      templateArgs: {
        ...common,
        productsText: eventSpecific.productsText,
        productImageUrl: eventSpecific.productImageUrl,
        courierName: eventSpecific.courierName,
        trackingNumber: eventSpecific.trackingNumber,
        trackingLink: eventSpecific.trackingLink,
      },
    };
  }

  if (eventType === "tracking_updated") {
    return {
      fn: sendTrackingUpdatedTemplate,
      templateArgs: {
        ...common,
        courierName: eventSpecific.courierName,
        trackingNumber: eventSpecific.trackingNumber,
        trackingLink: eventSpecific.trackingLink,
      },
    };
  }

  if (eventType === "review_request") {
    return {
      fn: sendReviewRequestTemplate,
      templateArgs: {
        ...common,
        productsText: eventSpecific.productsText,
        productImageUrl: eventSpecific.productImageUrl,
        reviewUrl: eventSpecific.reviewUrl,
      },
    };
  }

  return {
    fn: sendOrderCancelledUpdateTemplate,
    templateArgs: {
      ...common,
      reasonText: eventSpecific.reasonText,
    },
  };
}

async function sendBestChannel({
  shop,
  phoneE164,
  eventType,
  commonArgs,
  eventArgs,
  attemptId,
  orderGid,
  hasSessionWindow = null,
}) {
  const { fn, templateArgs } = buildTemplateArgs(
    eventType,
    commonArgs,
    eventArgs,
  );

  const sessionWindowOpen =
    typeof hasSessionWindow === "boolean" ? hasSessionWindow : false;

  const template = await fn({
    ...templateArgs,
    to: phoneE164,
    shop,
    kind: `order_update_${eventType}_template`,
    attemptId,
    orderGid,
    meta: {
      source: "shopify_order_updates",
      eventType,
      ...(sessionWindowOpen ? { sessionWindowOpen: true } : {}),
    },
  });

  return {
    channel: "template",
    data: template.data,
    templateUsed: template.templateUsed || null,
  };
}

function isAutomationFlowEnabled(shopRecord, flowKey, fallback = false) {
  const flows = ensureAutomationFlowConfigs(
    shopRecord?.settings?.automationFlows,
  );
  const row = flows.find((entry) => entry.flowKey === flowKey);
  if (row && typeof row.enabled === "boolean") return row.enabled;
  return fallback;
}

function normalizeReviewDelayHours(shopRecord, config = {}) {
  const raw =
    config?.delayHours ?? shopRecord?.settings?.reviewRequestDelayHours;
  const parsed = Number(raw);
  return Math.max(0, Math.min(24 * 30, Number.isFinite(parsed) ? parsed : 96));
}

function getAutomationFlowConfig(shopRecord, flowKey) {
  const flows = ensureAutomationFlowConfigs(
    shopRecord?.settings?.automationFlows,
  );
  const row = flows.find((entry) => entry.flowKey === flowKey);
  return row?.config && typeof row.config === "object" ? row.config : {};
}

export async function processShopifyOrderUpdateWebhook({
  shop,
  topic,
  payload,
  webhookId = null,
}) {
  const shopDomain = asString(shop);
  const seed = buildEventSeed({
    shop: shopDomain,
    topic,
    payload: payload || {},
    webhookId,
  });

  if (!shopDomain) return { ok: false, reason: "missing_shop" };
  if (!seed)
    return { ok: true, skipped: true, reason: "unsupported_or_no_tracking" };
  if (!seed.orderGid) {
    return { ok: true, skipped: true, reason: "missing_order_gid" };
  }

  const claimed = await claimDispatch(seed);
  if (!claimed) {
    return { ok: true, skipped: true, reason: "duplicate_event" };
  }

  let shopRecord = null;
  try {
    shopRecord = await Shop.findOne({ shop: shopDomain }).lean();
    if (!shopRecord) {
      await markDispatch(seed.dedupeKey, {
        status: "skipped",
        skippedReason: "shop_not_installed",
      });
      return { ok: true, skipped: true, reason: "shop_not_installed" };
    }

    if (shopRecord?.settings?.enableWhatsApp === false) {
      await markDispatch(seed.dedupeKey, {
        status: "skipped",
        skippedReason: "whatsapp_disabled",
      });
      return { ok: true, skipped: true, reason: "whatsapp_disabled" };
    }

    const updatesEnabled =
      !!shopRecord?.settings?.enableOrderUpdates ||
      isAutomationFlowEnabled(
        shopRecord,
        FLOW_KEYS.ORDER_DISPATCHED,
        shopRecord?.settings?.orderUpdatesDispatched !== false,
      ) ||
      isAutomationFlowEnabled(
        shopRecord,
        FLOW_KEYS.TRACKING_UPDATED,
        shopRecord?.settings?.orderUpdatesTrackingUpdated !== false,
      ) ||
      isAutomationFlowEnabled(
        shopRecord,
        FLOW_KEYS.ORDER_CANCELLED,
        shopRecord?.settings?.orderUpdatesCancelled !== false,
      ) ||
      isAutomationFlowEnabled(shopRecord, FLOW_KEYS.REVIEW_REQUEST, false);
    if (!updatesEnabled) {
      await markDispatch(seed.dedupeKey, {
        status: "skipped",
        skippedReason: "order_updates_disabled",
      });
      return { ok: true, skipped: true, reason: "order_updates_disabled" };
    }

    const eventToggleMap = {
      dispatched: isAutomationFlowEnabled(
        shopRecord,
        FLOW_KEYS.ORDER_DISPATCHED,
        shopRecord?.settings?.orderUpdatesDispatched !== false,
      ),
      tracking_updated: isAutomationFlowEnabled(
        shopRecord,
        FLOW_KEYS.TRACKING_UPDATED,
        shopRecord?.settings?.orderUpdatesTrackingUpdated !== false,
      ),
      cancelled: isAutomationFlowEnabled(
        shopRecord,
        FLOW_KEYS.ORDER_CANCELLED,
        shopRecord?.settings?.orderUpdatesCancelled !== false,
      ),
      review_request: isAutomationFlowEnabled(
        shopRecord,
        FLOW_KEYS.REVIEW_REQUEST,
        false,
      ),
    };
    const reviewFlowConfig = getAutomationFlowConfig(
      shopRecord,
      FLOW_KEYS.REVIEW_REQUEST,
    );
    const reviewDelayHours = normalizeReviewDelayHours(
      shopRecord,
      reviewFlowConfig,
    );
    const reviewLinkMode = asString(
      reviewFlowConfig?.linkMode || shopRecord?.settings?.reviewRequestLinkMode,
    ).toLowerCase();
    if (eventToggleMap[seed.eventType] === false) {
      await markDispatch(seed.dedupeKey, {
        status: "skipped",
        skippedReason: `event_disabled_${seed.eventType}`,
      });
      return {
        ok: true,
        skipped: true,
        reason: `event_disabled_${seed.eventType}`,
      };
    }

    if (seed.eventType === "review_request" && reviewDelayHours > 0) {
      await markDispatch(seed.dedupeKey, {
        status: "skipped",
        skippedReason: "deferred_to_review_poll",
        meta: {
          ...(seed.meta || {}),
          delayHours: reviewDelayHours,
        },
      });
      return { ok: true, skipped: true, reason: "deferred_to_review_poll" };
    }

    const attempt = await CodAttempt.findOne({
      shop: shopDomain,
      orderGid: seed.orderGid,
      stage: "pre_dispatch",
    })
      .sort({ createdAt: -1 })
      .lean();

    const requireConfirmedUpdates = requiresConfirmedOrderUpdates(shopRecord);
    if (requireConfirmedUpdates && attempt?.status !== "confirmed") {
      await markDispatch(seed.dedupeKey, {
        status: "skipped",
        skippedReason: "attempt_not_confirmed",
        attemptId: attempt?._id || null,
        phoneE164: attempt?.phoneE164 || null,
      });
      return { ok: true, skipped: true, reason: "attempt_not_confirmed" };
    }

    if (seed.eventType === "review_request") {
      const alreadySent = await OrderUpdateDispatch.exists({
        shop: shopDomain,
        orderGid: seed.orderGid,
        eventType: { $in: ["review_request", "review_request_poll"] },
        status: "sent",
      });
      if (alreadySent) {
        await markDispatch(seed.dedupeKey, {
          status: "skipped",
          skippedReason: "already_sent",
          attemptId: attempt?._id || null,
          phoneE164: attempt?.phoneE164 || null,
        });
        return { ok: true, skipped: true, reason: "already_sent" };
      }
    }

    const admin = await getAdminClient(shopDomain, {
      accessToken: shopRecord.accessToken || "",
      record: shopRecord,
    });
    const fetched = await fetchOrderForCodConfirmTemplate(admin, seed.orderGid);
    const order = fetched?.order || null;
    const resolvedPhone =
      asString(attempt?.phoneE164) || resolveOrderPhone(order);

    if (!resolvedPhone) {
      await markDispatch(seed.dedupeKey, {
        status: "skipped",
        skippedReason: "no_cod_attempt_or_phone",
        attemptId: attempt?._id || null,
      });
      return { ok: true, skipped: true, reason: "no_cod_attempt_or_phone" };
    }

    const blocked = await BlockedContact.exists({
      shop: shopDomain,
      phoneE164: resolvedPhone,
    });
    if (blocked) {
      await markDispatch(seed.dedupeKey, {
        status: "skipped",
        skippedReason: "blocked_contact",
        attemptId: attempt?._id || null,
        phoneE164: resolvedPhone,
      });
      return { ok: true, skipped: true, reason: "blocked_contact" };
    }

    const senderRuntime = await resolveRuntimeConfig(shopDomain).catch(
      () => null,
    );
    if (
      seed.eventType === "review_request" &&
      String(senderRuntime?.senderMode || "").trim() !== "own_number"
    ) {
      await markDispatch(seed.dedupeKey, {
        status: "skipped",
        skippedReason: "requires_own_number_plan",
        attemptId: attempt?._id || null,
        phoneE164: resolvedPhone,
      });
      return { ok: true, skipped: true, reason: "requires_own_number_plan" };
    }
    const hasSessionWindow = await hasRecentInboundForSender({
      shop: shopDomain,
      phoneE164: resolvedPhone,
      senderPhoneNumberId: senderRuntime?.phoneId || "",
      senderMode: senderRuntime?.senderMode || "",
      withinHours: 23,
    }).catch(() => false);
    const gate = await canSendWhatsApp(shopDomain, {
      toE164: resolvedPhone,
      alreadyInConversationWindow: hasSessionWindow,
      senderPhoneNumberId: senderRuntime?.phoneId || "",
      isTemplate: !hasSessionWindow,
    });
    if (!gate?.ok) {
      await markDispatch(seed.dedupeKey, {
        status: "skipped",
        skippedReason: "billing_or_usage_blocked",
        attemptId: attempt?._id || null,
        phoneE164: resolvedPhone,
        errorMeta: summarizeSendGateForStorage(gate),
      });
      return { ok: true, skipped: true, reason: "billing_or_usage_blocked" };
    }
    const storeName =
      asString(fetched?.shopName) ||
      asString(attempt?.storeName) ||
      shopDomain.replace(".myshopify.com", "");

    const commonArgs = {
      customerName:
        asString(attempt?.customerName) ||
        asString(order?.shippingAddress?.name) ||
        "Customer",
      storeName,
      orderNumber:
        asString(order?.name) ||
        asString(payload?.name) ||
        `#${seed.orderId || ""}`,
      supportWhatsAppNumber: asString(
        shopRecord?.settings?.supportWhatsAppNumber,
      ),
    };
    const productImageUrl = firstProductImageUrl(order);
    const productUrl = firstProductUrl(order, fetched?.shopUrl || "");

    const tracking = extractTrackingInfo(payload || {});
    const eventArgs =
      seed.eventType === "dispatched"
        ? {
            productsText:
              buildProductsTextFromFulfillmentPayload(payload) ||
              buildProductsTextFromOrder(order) ||
              "Not available",
            courierName: asString(tracking.company) || "Not available",
            trackingNumber: asString(tracking.numbers?.[0]) || "Not available",
            trackingLink: asString(tracking.urls?.[0]) || "Not available",
            amountText: formatAmountText(order),
            productImageUrl,
          }
        : seed.eventType === "review_request"
          ? {
              productsText:
                buildProductsTextFromFulfillmentPayload(payload) ||
                buildProductsTextFromOrder(order) ||
                "Not available",
              productImageUrl,
              reviewUrl:
                reviewLinkMode === "product"
                  ? productUrl ||
                    asString(reviewFlowConfig?.reviewUrl) ||
                    asString(shopRecord?.settings?.reviewRequestUrl) ||
                    ""
                  : asString(reviewFlowConfig?.reviewUrl) ||
                    asString(shopRecord?.settings?.reviewRequestUrl) ||
                    "",
              reviewLinkMode:
                reviewLinkMode === "product" ? "product" : "store",
              productUrl,
            }
          : seed.eventType === "tracking_updated"
            ? {
                courierName: asString(tracking.company) || "Not available",
                trackingNumber:
                  asString(tracking.numbers?.[0]) || "Not available",
                trackingLink: asString(tracking.urls?.[0]) || "Not available",
              }
            : {
                reasonText: formatCancelReason(payload),
              };

    if (seed.eventType === "review_request" && !asString(eventArgs.reviewUrl)) {
      await markDispatch(seed.dedupeKey, {
        status: "skipped",
        skippedReason: "missing_review_url",
        attemptId: attempt?._id || null,
        phoneE164: resolvedPhone,
      });
      return { ok: true, skipped: true, reason: "missing_review_url" };
    }

    const sendResult = await sendBestChannel({
      shop: shopDomain,
      phoneE164: resolvedPhone,
      eventType: seed.eventType,
      commonArgs,
      eventArgs,
      attemptId: attempt?._id || null,
      orderGid: seed.orderGid,
      hasSessionWindow,
    });

    if (sendResult.channel === "template") {
      await incrementWhatsAppUsage(shopDomain, 1, {
        isTemplate: true,
        toE164: resolvedPhone,
        countInitiatedConversation: true,
        senderPhoneNumberId: senderRuntime?.phoneId || "",
      });
    } else {
      await incrementWhatsAppUsage(shopDomain, 1);
    }

    await markDispatch(seed.dedupeKey, {
      status: "sent",
      attemptId: attempt?._id || null,
      phoneE164: resolvedPhone,
      channel: sendResult.channel,
      templateUsed: sendResult.templateUsed || null,
      waMessageId: sendResult?.data?.messages?.[0]?.id || null,
      sentAt: new Date(),
      meta: {
        ...(seed.meta || {}),
        orderName: commonArgs.orderNumber,
        eventType: seed.eventType,
      },
    });

    return { ok: true, sent: true, eventType: seed.eventType };
  } catch (e) {
    await tagOrderForMetaSendError({
      shop: shopDomain,
      accessToken: shopRecord?.accessToken,
      orderGid: seed.orderGid,
      error: e,
      label: "order_update_error_tag",
    });
    await markDispatch(seed.dedupeKey, {
      status: "failed",
      errorMessage: e?.message || "order update send failed",
      errorMeta: e?.meta || e?.data || null,
    });
    throw e;
  }
}
