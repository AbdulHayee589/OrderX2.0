import Shop from "../models/Shop.js";
import CodAttempt from "../models/CodAttempt.js";
import { agenda } from "../jobs/agenda.js";
import { resolveTimezoneFromCountry, nextAllowedTimeUTC } from "./timezone.js";
import { normalizePhoneE164 } from "./phone.js";
import {
  fetchOrderForCodConfirmTemplate,
  getAdminClient,
} from "./shopifyAdmin.js";

/**
 * NOTE:
 * These functions are meant for ORDER WEBHOOKS.
 * You currently cannot subscribe to orders/create & orders/updated
 * until your app is approved for Protected Customer Data.
 *
 * For MVP, polling job is the source of truth.
 * Keep these for later enablement.
 */

const DEBUG = process.env.DEBUG_ORDERX === "true";
const dbg = (...args) => {
  if (DEBUG) console.log(...args);
};

function isCOD(order) {
  const g = order?.payment_gateway_names || [];
  return g.some((x) => {
    const v = String(x || "").toLowerCase();
    return v.includes("cash") || v.includes("cod");
  });
}

function pickPhone(order) {
  return (
    order?.shipping_address?.phone ||
    order?.billing_address?.phone ||
    order?.phone ||
    null
  );
}

function pickCountry(order) {
  return (
    order?.shipping_address?.country_code ||
    order?.billing_address?.country_code ||
    null
  );
}

function pickCountryFromGraphOrder(order) {
  return (
    order?.shippingAddress?.countryCode ||
    order?.billingAddress?.countryCode ||
    null
  );
}

function pickPhoneFromGraphOrder(order) {
  return (
    order?.shippingAddress?.phone ||
    order?.billingAddress?.phone ||
    order?.customer?.phone ||
    null
  );
}

function pickCustomerNameFromGraphOrder(order) {
  return (
    order?.shippingAddress?.name ||
    [order?.customer?.firstName, order?.customer?.lastName]
      .filter(Boolean)
      .join(" ")
      .trim() ||
    order?.customer?.displayName ||
    ""
  );
}

function isCodEligibleGraphOrder(order) {
  const gateways = Array.isArray(order?.paymentGatewayNames)
    ? order.paymentGatewayNames
    : [];
  return gateways.some((gateway) => {
    const v = String(gateway || "").toLowerCase();
    return v.includes("cash") || v.includes("cod");
  });
}

async function upsertAttemptFromGraphOrder({
  shop,
  shopRecord,
  order,
  stage = "pre_dispatch",
  when = null,
}) {
  if (!order) throw new Error("Order not found");

  const orderGid = String(order?.id || "").trim();
  if (!orderGid) throw new Error("Missing order id");

  const rawPhone = pickPhoneFromGraphOrder(order);
  const countryCode = pickCountryFromGraphOrder(order);
  const phoneE164 = normalizePhoneE164(rawPhone, countryCode);
  if (!phoneE164) throw new Error("Missing phone number");

  const tz =
    shopRecord?.settings?.timezone ||
    resolveTimezoneFromCountry(countryCode) ||
    "UTC";

  const currentTotalMoney = order?.currentTotalPriceSet?.shopMoney || {};
  const amount = Number(currentTotalMoney?.amount || 0);
  const currency = String(currentTotalMoney?.currencyCode || "").trim() || null;
  const scheduleAt = when instanceof Date && Number.isFinite(when.getTime())
    ? when
    : new Date();

  const payload = {
    shop,
    orderGid,
    orderName: String(order?.name || "").trim(),
    orderAmount: Number.isFinite(amount) ? amount : null,
    orderCurrency: currency,
    customerName: pickCustomerNameFromGraphOrder(order),
    storeName: String(shopRecord?.storeName || "").trim() || null,
    phoneE164,
    countryCode,
    timezone: tz,
    stage,
    status: "scheduled",
    scheduledAt: scheduleAt,
    manualRescheduledAt: new Date(),
    lastError: null,
    lastErrorAt: null,
    lastErrorMeta: null,
    retryCount: 0,
    expiredAt: null,
    expireSource: null,
    processedAt: null,
    confirmedAt: null,
    cancelledAt: null,
  };

  const existing = await CodAttempt.findOne({
    shop,
    orderGid,
    stage,
  }).sort({ createdAt: -1 });

  if (existing) {
    if (["confirmed", "cancelled", "wa_sent"].includes(existing.status)) {
      throw new Error(`Attempt is already ${existing.status}`);
    }

    existing.orderName = payload.orderName || existing.orderName;
    existing.orderAmount = payload.orderAmount ?? existing.orderAmount;
    existing.orderCurrency = payload.orderCurrency || existing.orderCurrency;
    existing.customerName = payload.customerName || existing.customerName;
    existing.storeName = payload.storeName || existing.storeName;
    existing.phoneE164 = payload.phoneE164 || existing.phoneE164;
    existing.countryCode = payload.countryCode || existing.countryCode;
    existing.timezone = payload.timezone || existing.timezone;
    existing.status = "scheduled";
    existing.scheduledAt = scheduleAt;
    existing.manualRescheduledAt = new Date();
    existing.lastError = null;
    existing.lastErrorAt = null;
    existing.lastErrorMeta = null;
    existing.retryCount = 0;
    existing.expiredAt = null;
    existing.expireSource = null;
    existing.processedAt = null;
    existing.confirmedAt = null;
    existing.cancelledAt = null;
    existing.confirmSource = null;
    existing.cancelSource = null;
    existing.confirmTokenHash = null;
    existing.cancelTokenHash = null;
    existing.tokenExpiresAt = null;
    existing.tokenUsedAt = null;
    existing.waMessageId = null;
    existing.waTemplateUsed = null;
    existing.waSentAt = null;
    existing.waDeliveryStatus = null;
    existing.waDeliveryStatusAt = null;
    existing.waDeliveryError = null;
    existing.supportInfoSentAt = null;
    existing.supportInfoCount = 0;
    existing.changeState = "none";
    existing.changeKindPending = null;
    existing.changeRequestCount = 0;
    existing.changeRequestedAt = null;
    existing.changePromptSentAt = null;
    existing.changeDetailsReceivedAt = null;
    existing.changeReconfirmSentAt = null;
    existing.changeReconfirmWaMessageId = null;
    existing.changeProposedName = null;
    existing.changeProposedAddress = null;
    existing.changeProposedQuantity = null;
    existing.changeProposedQuantityLineIndex = null;
    existing.changeProposedQuantityProductLabel = null;
    existing.changeProposedQuantityOverrides = [];
    existing.changeProposedAmountText = null;
    existing.changeQtyTargetLineIndex = null;
    existing.changeQtyTargetProductLabel = null;
    existing.changeRequests = [];
    existing.duplicateGroupId = null;
    existing.duplicateRole = "none";
    existing.duplicateQueuedAt = null;
    existing.duplicateReleasedAt = null;
    existing.duplicatePromptSentAt = null;
    existing.duplicateNotifyOnSend = false;
    existing.duplicateReferenceAttemptId = null;
    existing.phoneQueueGroupId = null;
    existing.phoneQueueRole = "none";
    existing.phoneQueuedAt = null;
    existing.phoneReleasedAt = null;
    existing.senderMode = null;
    existing.senderPhoneNumberId = null;
    existing.senderQueueKey = null;
    await existing.save();

    await agenda.schedule(scheduleAt, "attempt_cod_confirmation", {
      attemptId: existing._id.toString(),
    });

    return { attempt: existing, created: false };
  }

  const attempt = await CodAttempt.create(payload);
  await agenda.schedule(scheduleAt, "attempt_cod_confirmation", {
    attemptId: attempt._id.toString(),
  });
  return { attempt, created: true };
}

export async function scheduleFromOrderCreate(shop, order) {
  if (!isCOD(order)) return;

  const shopRecord = await Shop.findOne({ shop });
  if (!shopRecord) return;

  const countryCode = pickCountry(order);
  const tz =
    shopRecord.settings?.timezone ||
    resolveTimezoneFromCountry(countryCode) ||
    "UTC";

  const delayMin = Number(shopRecord.settings?.confirmationDelayMin ?? 60);
  const startHour = Number(shopRecord.settings?.workStartHour ?? 9);
  const endHour = Number(shopRecord.settings?.workEndHour ?? 21);
  const scheduleAt = nextAllowedTimeUTC(tz, delayMin, startHour, endHour);
  dbg("[codFlow_schedule_create]", {
    shop,
    orderName: order?.name,
    timezone: tz,
    delayMin,
    window: `${startHour}-${endHour}`,
    scheduledAt: scheduleAt?.toISOString?.() || String(scheduleAt),
  });

  const rawPhone = pickPhone(order);
  const phoneE164 = normalizePhoneE164(rawPhone, countryCode);
  if (!phoneE164) return;

  const orderGid = order.admin_graphql_api_id;
  if (!orderGid) return;

  // Idempotency guard
  const exists = await CodAttempt.findOne({ shop, orderGid });
  if (exists) return;

  const attempt = await CodAttempt.create({
    shop,
    orderGid,
    orderName: order.name,
    phoneE164,
    countryCode,
    timezone: tz,
    stage: "pre_dispatch",
    status: "scheduled",
    scheduledAt: scheduleAt,
  });

  await agenda.schedule(scheduleAt, "attempt_cod_confirmation", {
    attemptId: attempt._id.toString(),
  });
}

export async function scheduleAttemptFromShopifyOrder({
  shop,
  accessToken,
  orderGid,
  when = null,
  stage = "pre_dispatch",
  requireCodEligible = false,
}) {
  const shopRecord = await Shop.findOne({ shop }).lean();
  if (!shopRecord && !accessToken) {
    throw new Error("Shop not installed");
  }

  const admin = await getAdminClient(shop, {
    accessToken: accessToken || shopRecord?.accessToken || "",
    record: shopRecord || null,
  });
  const fetched = await fetchOrderForCodConfirmTemplate(admin, orderGid);
  const order = fetched?.order || null;
  if (!order) throw new Error("Order not found");

  if (requireCodEligible && !isCodEligibleGraphOrder(order)) {
    throw new Error("Order is not COD eligible");
  }

  const scheduledAt =
    when instanceof Date && Number.isFinite(when.getTime()) ? when : new Date();

  return upsertAttemptFromGraphOrder({
    shop,
    shopRecord: {
      ...shopRecord,
      storeName: fetched?.shopName || shopRecord?.storeName || "",
    },
    order,
    stage,
    when: scheduledAt,
  });
}

export async function scheduleFromOrderUpdated(shop, order) {
  // MVP trigger: merchant adds tag "delivery_failed"
  const tags = String(order?.tags || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  if (!tags.includes("delivery_failed")) return;

  const shopRecord = await Shop.findOne({ shop });
  if (!shopRecord) return;

  const countryCode = pickCountry(order);
  const tz =
    shopRecord.settings?.timezone ||
    resolveTimezoneFromCountry(countryCode) ||
    "UTC";

  // Retry quickly for failed delivery
  const startHour = Number(shopRecord.settings?.workStartHour ?? 9);
  const endHour = Number(shopRecord.settings?.workEndHour ?? 21);
  const scheduleAt = nextAllowedTimeUTC(tz, 15, startHour, endHour);
  dbg("[codFlow_schedule_failed_delivery]", {
    shop,
    orderName: order?.name,
    timezone: tz,
    delayMin: 15,
    window: `${startHour}-${endHour}`,
    scheduledAt: scheduleAt?.toISOString?.() || String(scheduleAt),
  });

  const rawPhone = pickPhone(order);
  const phoneE164 = normalizePhoneE164(rawPhone, countryCode);
  if (!phoneE164) return;

  const orderGid = order.admin_graphql_api_id;
  if (!orderGid) return;

  // You may allow multiple post_failed_delivery attempts, but don't spam:
  // if last attempt exists within last 6 hours, skip
  const last = await CodAttempt.findOne({ shop, orderGid })
    .sort({ createdAt: -1 })
    .lean();

  if (last?.stage === "post_failed_delivery") {
    const ageMs = Date.now() - new Date(last.createdAt).getTime();
    if (ageMs < 6 * 60 * 60 * 1000) return;
  }

  const attempt = await CodAttempt.create({
    shop,
    orderGid,
    orderName: order.name,
    phoneE164,
    countryCode,
    timezone: tz,
    stage: "post_failed_delivery",
    status: "scheduled",
    scheduledAt: scheduleAt,
  });

  await agenda.schedule(scheduleAt, "attempt_cod_confirmation", {
    attemptId: attempt._id.toString(),
  });
}
