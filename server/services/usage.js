// server/services/usage.js
import Shop from "../models/Shop.js";
import Metric from "../models/Metric.js"; // your daily metrics collection
import ConversationInitiation from "../models/ConversationInitiation.js";
import BillingUsageCharge from "../models/BillingUsageCharge.js";
import WaMessageLog from "../models/WaMessageLog.js";

import { getBillingStatus } from "./billing.js";
import { getPlan, PLAN_BILLING_TYPES, SENDER_MODES } from "./plans.js";
import {
  getCountryMessageRate,
  getStorePricingContext,
  resolveGrowthMessagePricing,
} from "./countryPricing.js";
import { resolveOwnNumberRegistrationStatus } from "./ownNumberRegistration.js";
import { getRuntimeConfig } from "./runtimeConfig.js";
import { isAgentBillingTestShop } from "./agentAccess.js";

const BILLING_CYCLE_DAYS = 30;
const BILLING_CYCLE_MS = BILLING_CYCLE_DAYS * 24 * 60 * 60 * 1000;
const INITIATED_WINDOW_MS = 24 * 60 * 60 * 1000;
export const AGENT_REPLY_KIND_RE = /^agent_reply_/;

export function shouldCountWhatsAppUsageTowardsCap(options = {}) {
  return options?.excludeFromCap !== true;
}
function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function envDecimal(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const DEFAULT_BYON_INITIATED_LIMIT_24H = envNumber(
  "BYON_DEFAULT_INITIATED_CONVERSATIONS_24H",
  250,
);
const USD_TO_PKR_RATE = envDecimal("USD_TO_PKR_RATE", 278);
const META_TEMPLATE_ESTIMATED_USD = envDecimal(
  "BYON_META_TEMPLATE_ESTIMATED_USD",
  0.01,
);
const GROWTH_CAP_WARNING_REMAINING_MESSAGES = envNumber(
  "BILLING_ORDERX_METERED_WARNING_MESSAGES",
  300,
);
const GROWTH_CAP_CRITICAL_REMAINING_MESSAGES = envNumber(
  "BILLING_ORDERX_METERED_CRITICAL_MESSAGES",
  100,
);
const OWN_NUMBER_READY_INFERENCE_BLOCKED_STATUSES = new Set([
  "not_started",
  "collecting_details",
  "meta_connect_pending",
  "registration_pending",
  "reauth_required",
  "error",
]);

function resolvePlanTemplateCap(plan = {}) {
  const rawCap =
    plan?.outboundMessageCap == null
      ? plan?.templateMessageCap
      : plan?.outboundMessageCap;
  if (rawCap == null) return null;
  const cap = Number(rawCap);
  return Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : null;
}

function resolveByonOverageRate(plan = {}, billing = {}) {
  const amount = Number(
    billing?.plan?.usagePrice?.amount ??
      plan?.usagePrice?.amount ??
      getPlan(billing?.planKey)?.usagePrice?.amount ??
      0,
  );
  return Number.isFinite(amount) && amount > 0 ? roundCurrency(amount, 4) : 0;
}

function resolveByonUsageCapUsd(plan = {}, billing = {}) {
  const amount = Number(
    billing?.usageCappedAmount ??
      plan?.usageCappedAmount?.amount ??
      getPlan(billing?.planKey)?.usageCappedAmount?.amount ??
      0,
  );
  return Number.isFinite(amount) && amount > 0
    ? roundCurrency(amount, 2)
    : null;
}

function getByonCapThresholds(cap) {
  const normalizedCap = Number(cap || 0);
  if (!Number.isFinite(normalizedCap) || normalizedCap <= 0) {
    return { nearCapThreshold: null, criticalCapThreshold: null };
  }
  return {
    nearCapThreshold: Math.max(100, Math.floor(normalizedCap * 0.1)),
    criticalCapThreshold: Math.max(25, Math.floor(normalizedCap * 0.03)),
  };
}

function dayKey(d = new Date()) {
  // YYYY-MM-DD
  return new Date(d).toISOString().slice(0, 10);
}

function startOfWeek(d = new Date()) {
  const x = new Date(d);
  const day = x.getUTCDay(); // 0=Sun
  const diff = (day + 6) % 7; // make Monday start
  x.setUTCDate(x.getUTCDate() - diff);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

function startOfMonth(d = new Date()) {
  const x = new Date(d);
  x.setUTCDate(1);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

function toValidDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function roundCurrency(value, digits = 2) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(digits));
}

function convertUsdToPkr(usdAmount) {
  return roundCurrency(Number(usdAmount || 0) * USD_TO_PKR_RATE, 2);
}

function buildDateRangeFilter(field, startAt, endAt) {
  if (!startAt && !endAt) return {};
  const match = {};
  if (startAt) match.$gte = startAt;
  if (endAt) match.$lt = endAt;
  return { [field]: match };
}

function shiftMs(date, deltaMs) {
  return new Date(date.getTime() + deltaMs);
}

function normalizeToE164(v) {
  const raw = String(v || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/[^\d]/g, "");
  return digits ? `+${digits}` : "";
}

function resolveConversationScope({
  shop,
  planSenderMode,
  settings,
  senderPhoneNumberId = "",
  ownPhoneNumberId = "",
  orderxLimit24h = 2000,
}) {
  const normalizedSenderPhoneId = String(
    senderPhoneNumberId ||
      (String(planSenderMode || "").trim() === SENDER_MODES.OWN_NUMBER
        ? ownPhoneNumberId
        : process.env.WA_PHONE_NUMBER_ID || ""),
  ).trim();
  const senderMode = String(planSenderMode || "").trim();
  if (senderMode === SENDER_MODES.OWN_NUMBER) {
    const merchantLimit = Number(settings?.byonMaxInitiatedConversations24h);
    const limit =
      Number.isFinite(merchantLimit) && merchantLimit > 0
        ? Math.floor(merchantLimit)
        : DEFAULT_BYON_INITIATED_LIMIT_24H;
    return {
      scopeType: "own_number",
      scopeKey: normalizedSenderPhoneId || `shop:${String(shop || "").trim()}`,
      shop: String(shop || "").trim(),
      senderMode,
      senderPhoneNumberId: normalizedSenderPhoneId || null,
      limit24h: limit,
      label: "BYON initiated conversations limit (24h)",
    };
  }

  return {
    scopeType: "orderx_number",
    scopeKey: normalizedSenderPhoneId || "orderx_shared",
    shop: null,
    senderMode: SENDER_MODES.ORDERX_NUMBER,
    senderPhoneNumberId: normalizedSenderPhoneId || null,
    limit24h: Math.max(1, Number(orderxLimit24h || 2000)),
    label: "OrderX initiated conversations limit (24h)",
  };
}

async function getConversationScopeUsage(scope, now = new Date()) {
  if (!scope?.scopeType || !scope?.scopeKey) {
    return {
      count24h: 0,
      limit24h: 0,
      remaining24h: null,
      cutoffAt: new Date(now.getTime() - INITIATED_WINDOW_MS),
    };
  }
  const cutoffAt = new Date(now.getTime() - INITIATED_WINDOW_MS);
  const count24h = await ConversationInitiation.countDocuments({
    scopeType: scope.scopeType,
    scopeKey: scope.scopeKey,
    lastInitiatedAt: { $gte: cutoffAt },
  });
  const limit24h = Number(scope?.limit24h || 0);
  return {
    count24h: Number(count24h || 0),
    limit24h,
    remaining24h:
      limit24h > 0 ? Math.max(0, limit24h - Number(count24h || 0)) : null,
    cutoffAt,
  };
}

async function hasActiveConversationInWindow(scope, toE164, now = new Date()) {
  const to = normalizeToE164(toE164);
  if (!to || !scope?.scopeType || !scope?.scopeKey) return false;
  const cutoffAt = new Date(now.getTime() - INITIATED_WINDOW_MS);
  const hit = await ConversationInitiation.exists({
    scopeType: scope.scopeType,
    scopeKey: scope.scopeKey,
    toE164: to,
    lastInitiatedAt: { $gte: cutoffAt },
  });
  return !!hit;
}

async function markConversationInitiated(scope, toE164, now = new Date()) {
  const to = normalizeToE164(toE164);
  if (!to || !scope?.scopeType || !scope?.scopeKey) {
    return { counted: false, reason: "missing_scope_or_phone" };
  }
  const cutoffAt = new Date(now.getTime() - INITIATED_WINDOW_MS);
  const existing = await ConversationInitiation.findOne({
    scopeType: scope.scopeType,
    scopeKey: scope.scopeKey,
    toE164: to,
  })
    .select({ _id: 1, lastInitiatedAt: 1 })
    .lean();

  if (
    existing?.lastInitiatedAt &&
    new Date(existing.lastInitiatedAt) >= cutoffAt
  ) {
    return { counted: false, reason: "already_in_window" };
  }

  await ConversationInitiation.findOneAndUpdate(
    {
      scopeType: scope.scopeType,
      scopeKey: scope.scopeKey,
      toE164: to,
    },
    {
      $set: {
        shop: scope.shop || null,
        lastInitiatedAt: now,
      },
      $setOnInsert: {
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
        toE164: to,
      },
    },
    { upsert: true, new: true },
  );

  return { counted: true, reason: "new_or_reopened_window" };
}

export async function getInitiatedConversationQuotaStatus(shop, options = {}) {
  const shopDomain = String(shop || "").trim();
  if (!shopDomain) return null;

  const now = toValidDate(options.referenceDate) || new Date();
  const billing = options.billing || (await getBillingStatus(shopDomain));
  const runtimeConfig = await getRuntimeConfig();
  const planSenderMode = String(billing?.plan?.senderMode || "").trim();
  const record = await Shop.findOne({ shop: shopDomain })
    .select({ settings: 1, "whatsappSender.ownNumber.phoneNumberId": 1 })
    .lean();
  const ownPhoneNumberId = String(
    record?.whatsappSender?.ownNumber?.phoneNumberId || "",
  ).trim();
  const senderPhoneNumberId = String(options?.senderPhoneNumberId || "").trim();
  const scope = resolveConversationScope({
    shop: shopDomain,
    planSenderMode,
    settings: record?.settings || {},
    senderPhoneNumberId,
    ownPhoneNumberId,
    orderxLimit24h: runtimeConfig?.orderxMaxInitiatedConversations24h,
  });
  const usage = await getConversationScopeUsage(scope, now);
  return {
    senderMode: scope.senderMode,
    scopeType: scope.scopeType,
    scopeKey: scope.scopeKey,
    senderPhoneNumberId: scope.senderPhoneNumberId || null,
    label: scope.label,
    count24h: usage.count24h,
    limit24h: usage.limit24h,
    remaining24h: usage.remaining24h,
    merchantConfiguredLimit24h:
      scope.senderMode === SENDER_MODES.OWN_NUMBER ? scope.limit24h : null,
  };
}

export function resolveBillingCycleWindow(billing, now = new Date()) {
  if (!billing || billing.status !== "ACTIVE") return null;

  let startAt = toValidDate(billing.currentPeriodStart);
  let endAt = toValidDate(billing.currentPeriodEnd);
  const anchorAt = toValidDate(billing.cycleAnchorAt);

  if (!startAt && endAt) {
    startAt = shiftMs(endAt, -BILLING_CYCLE_MS);
  } else if (startAt && !endAt) {
    endAt = shiftMs(startAt, BILLING_CYCLE_MS);
  } else if (!startAt && !endAt && anchorAt) {
    startAt = anchorAt;
    endAt = shiftMs(startAt, BILLING_CYCLE_MS);
  }

  if (!startAt || !endAt || endAt <= startAt) return null;

  if (now >= endAt) {
    const elapsed = now.getTime() - startAt.getTime();
    const jumps = Math.floor(elapsed / BILLING_CYCLE_MS);
    startAt = shiftMs(startAt, jumps * BILLING_CYCLE_MS);
    endAt = shiftMs(startAt, BILLING_CYCLE_MS);
  }

  if (now < startAt) {
    while (now < startAt) {
      endAt = startAt;
      startAt = shiftMs(startAt, -BILLING_CYCLE_MS);
    }
  }

  return { startAt, endAt };
}

function resolveGrowthCapAmount(billing) {
  const billingCap = Number(billing?.usageCappedAmount || 0);
  if (Number.isFinite(billingCap) && billingCap > 0) return billingCap;
  return Number(getPlan(billing?.planKey)?.usageCappedAmount?.amount || 0);
}

function resolveGrowthUsageAmount(billing) {
  const amount = Number(billing?.plan?.usagePrice?.amount || 0);
  if (Number.isFinite(amount) && amount > 0) return amount;
  return Number(getPlan(billing?.planKey)?.usagePrice?.amount || 0);
}

async function countOutboundMessages({
  shop,
  senderMode = null,
  templateOnly = false,
  startAt = null,
  endAt = null,
}) {
  const query = {
    shop,
    direction: "outbound",
    ...(senderMode ? { senderMode } : {}),
    ...buildDateRangeFilter("createdAt", startAt, endAt),
  };
  if (templateOnly) {
    query.templateName = { $exists: true, $nin: [null, ""] };
  }
  return Number(await WaMessageLog.countDocuments(query));
}

async function summarizeGrowthUsage(
  shop,
  billing,
  cycleWindow,
  now = new Date(),
) {
  const currentBilling = billing || (await getBillingStatus(shop));
  const pricingContext = await getStorePricingContext({
    shop,
    storeCountryCode: currentBilling?.storeCountryCode,
  });
  const senderMode = String(currentBilling?.plan?.senderMode || "").trim();
  const planBillingType = String(
    currentBilling?.plan?.billingType || "",
  ).trim();
  const capUsd = roundCurrency(resolveGrowthCapAmount(currentBilling), 2);
  const storeRateUsd = roundCurrency(
    pricingContext?.growthPriceUsd || resolveGrowthUsageAmount(currentBilling),
    4,
  );
  const approximateCapMessages =
    capUsd > 0 && storeRateUsd > 0
      ? Math.max(0, Math.floor((capUsd + 1e-9) / storeRateUsd))
      : null;
  if (
    senderMode !== SENDER_MODES.ORDERX_NUMBER ||
    planBillingType !== PLAN_BILLING_TYPES.SHOPIFY_METERED
  ) {
    return {
      messagesSent: 0,
      loggedOutboundMessages: 0,
      submittedMessages: 0,
      pendingMessages: 0,
      usageCostUsd: 0,
      usageCostPkr: 0,
      estimatedMonthlyCostUsd: 0,
      estimatedMonthlyCostPkr: 0,
      capUsd,
      capPkr: convertUsdToPkr(capUsd),
      remainingUsd: capUsd,
      remainingPkr: convertUsdToPkr(capUsd),
      remainingMessages: approximateCapMessages,
      nearCap: false,
      criticalCap: false,
      blocked: false,
      internalCostUsd: 0,
      externalCostUsd: Number(currentBilling?.usageBalanceUsedAmount || 0),
      externalCostPkr: convertUsdToPkr(
        currentBilling?.usageBalanceUsedAmount || 0,
      ),
      messageUnitUsd: storeRateUsd,
      storeCountryCode: pricingContext?.storeCountryCode || null,
      storeCountryName: pricingContext?.storeCountryName || null,
      capUnitsUsed: 0,
      approximateCapMessages,
    };
  }

  const startAt = cycleWindow?.startAt || startOfMonth(now);
  const endAt = cycleWindow?.endAt || null;
  const loggedOutboundMessages = await countOutboundMessages({
    shop,
    senderMode: SENDER_MODES.ORDERX_NUMBER,
    startAt,
    endAt,
  });

  const match = {
    shop,
    planKey: currentBilling?.planKey || null,
    ...buildDateRangeFilter("createdAt", startAt, endAt),
  };
  const aggregates = await BillingUsageCharge.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalMessages: {
          $sum: {
            $cond: [{ $ne: ["$status", "skipped"] }, 1, 0],
          },
        },
        submittedMessages: {
          $sum: {
            $cond: [{ $in: ["$status", ["submitted", "settled"]] }, 1, 0],
          },
        },
        pendingMessages: {
          $sum: {
            $cond: [{ $in: ["$status", ["pending", "buffered"]] }, 1, 0],
          },
        },
        failedMessages: {
          $sum: {
            $cond: [{ $eq: ["$status", "failed"] }, 1, 0],
          },
        },
        submittedAmount: {
          $sum: {
            $cond: [{ $eq: ["$status", "submitted"] }, "$amount", 0],
          },
        },
        pendingAmount: {
          $sum: {
            $cond: [{ $eq: ["$status", "pending"] }, "$amount", 0],
          },
        },
        failedAmount: {
          $sum: {
            $cond: [{ $eq: ["$status", "failed"] }, "$amount", 0],
          },
        },
        internalAccruedAmount: {
          $sum: {
            $cond: [
              {
                $in: ["$status", ["pending", "submitted", "settled", "failed"]],
              },
              { $ifNull: ["$pricingBasisUsd", "$amount"] },
              0,
            ],
          },
        },
        capUnitsUsed: {
          $sum: {
            $cond: [
              {
                $in: ["$status", ["pending", "submitted", "settled", "failed"]],
              },
              { $ifNull: ["$capUnitsConsumed", 1] },
              0,
            ],
          },
        },
      },
    },
  ]);
  const totals = aggregates?.[0] || {};
  const totalMessages = Number(totals?.totalMessages || 0);
  const submittedMessages = Number(totals?.submittedMessages || 0);
  const failedMessages = Number(totals?.failedMessages || 0);
  const submittedCostUsd = roundCurrency(totals?.submittedAmount || 0, 4);
  const pendingMessages = Number(totals?.pendingMessages || 0);
  const pendingCostUsd = roundCurrency(totals?.pendingAmount || 0, 4);
  const failedCostUsd = roundCurrency(totals?.failedAmount || 0, 4);
  const capUnitsUsed = Number(totals?.capUnitsUsed || 0);
  const meteredMessages = totalMessages;
  const internalCostUsd = roundCurrency(totals?.internalAccruedAmount || 0, 4);
  const externalCostUsd = roundCurrency(
    currentBilling?.usageBalanceUsedAmount || 0,
    4,
  );
  const displayCostUsd =
    meteredMessages > 0 || internalCostUsd > 0
      ? internalCostUsd
      : externalCostUsd;
  const syncedBalanceDriftUsd = roundCurrency(
    externalCostUsd - internalCostUsd,
    4,
  );
  const displayedCapUnitsUsed =
    capUnitsUsed > 0
      ? capUnitsUsed
      : storeRateUsd > 0 && externalCostUsd > 0
        ? Math.max(1, Math.ceil((externalCostUsd + 1e-9) / storeRateUsd))
        : 0;
  const remainingUsd =
    capUsd > 0 ? roundCurrency(Math.max(0, capUsd - displayCostUsd), 4) : null;
  const remainingMessages =
    approximateCapMessages !== null
      ? Math.max(0, approximateCapMessages - displayedCapUnitsUsed)
      : null;
  const elapsedMs = Math.max(
    24 * 60 * 60 * 1000,
    now.getTime() - startAt.getTime(),
  );
  const elapsedDays = elapsedMs / (24 * 60 * 60 * 1000);
  const cycleDays =
    cycleWindow?.startAt && cycleWindow?.endAt
      ? Math.max(
          1,
          (cycleWindow.endAt.getTime() - cycleWindow.startAt.getTime()) /
            (24 * 60 * 60 * 1000),
        )
      : BILLING_CYCLE_DAYS;
  const estimatedMonthlyCostUsd = roundCurrency(
    elapsedDays > 0
      ? (displayCostUsd / elapsedDays) * cycleDays
      : displayCostUsd,
    4,
  );
  const remainingCount = Number.isFinite(remainingMessages)
    ? remainingMessages
    : null;

  return {
    messagesSent: meteredMessages,
    loggedOutboundMessages,
    submittedMessages,
    pendingMessages,
    usageCostUsd: displayCostUsd,
    usageCostPkr: convertUsdToPkr(displayCostUsd),
    estimatedMonthlyCostUsd,
    estimatedMonthlyCostPkr: convertUsdToPkr(estimatedMonthlyCostUsd),
    capUsd,
    capPkr: convertUsdToPkr(capUsd),
    remainingUsd,
    remainingPkr: remainingUsd === null ? null : convertUsdToPkr(remainingUsd),
    remainingMessages: remainingCount,
    approximateCapMessages,
    capUnitsUsed: displayedCapUnitsUsed,
    nearCap:
      remainingCount !== null &&
      remainingCount <= GROWTH_CAP_WARNING_REMAINING_MESSAGES,
    criticalCap:
      remainingCount !== null &&
      remainingCount <= GROWTH_CAP_CRITICAL_REMAINING_MESSAGES,
    blocked: remainingUsd !== null && remainingUsd <= 0,
    internalCostUsd,
    externalCostUsd,
    externalCostPkr: convertUsdToPkr(externalCostUsd),
    syncedBalanceDriftUsd,
    hasSyncedBalanceDrift: Math.abs(syncedBalanceDriftUsd) >= 0.0005,
    messageUnitUsd: storeRateUsd,
    storeCountryCode: pricingContext?.storeCountryCode || null,
    storeCountryName: pricingContext?.storeCountryName || null,
    failedMessages,
    failedCostUsd,
    billingIssueDetected: failedMessages > 0,
  };
}

async function summarizeByonUsage(
  shop,
  billing,
  cycleWindow,
  now = new Date(),
) {
  const pricingContext = await getStorePricingContext({
    shop,
    storeCountryCode: billing?.storeCountryCode,
  });
  const senderMode = String(billing?.plan?.senderMode || "").trim();
  const templateMessageCap = resolvePlanTemplateCap(billing?.plan);
  if (senderMode !== SENDER_MODES.OWN_NUMBER) {
    return {
      messagesSent: 0,
      templateMessagesSent: 0,
      metaUsageCostUsd: 0,
      metaUsageCostPkr: 0,
      estimatedMonthlyMetaCostUsd: 0,
      estimatedMonthlyMetaCostPkr: 0,
      orderxUsageCostUsd: 0,
      orderxUsageCostPkr: 0,
      orderxUsageRateUsd: 0,
      overageMessages: 0,
      overageChargePerMessageUsd: 0,
      templateRateUsd: roundCurrency(
        pricingContext?.byonUtilityTemplateUsd || META_TEMPLATE_ESTIMATED_USD,
        4,
      ),
      outboundMessageCap: templateMessageCap,
      templateMessageCap,
      remainingMessages: templateMessageCap,
      nearCap: false,
      criticalCap: false,
      blocked: false,
      overageBillingEnabled: false,
      usageCapUsd: null,
      remainingUsageCapUsd: null,
      blockedReason: null,
      storeCountryCode: pricingContext?.storeCountryCode || null,
      storeCountryName: pricingContext?.storeCountryName || null,
      crossBorderTemplateCount: 0,
    };
  }

  const startAt = cycleWindow?.startAt || startOfMonth(now);
  const endAt = cycleWindow?.endAt || null;
  const outboundMatch = {
    shop,
    direction: "outbound",
    senderMode: SENDER_MODES.OWN_NUMBER,
    // Human support replies are service-window messages, not OrderX
    // automation quota. Keep historical and future agent logs out of caps.
    kind: { $not: AGENT_REPLY_KIND_RE },
    ...buildDateRangeFilter("createdAt", startAt, endAt),
  };
  const messagesSent = await WaMessageLog.countDocuments(outboundMatch);
  const templateMatch = {
    ...outboundMatch,
    templateName: { $exists: true, $nin: [null, ""] },
  };
  const byCountry = await WaMessageLog.aggregate([
    { $match: templateMatch },
    {
      $group: {
        _id: "$recipientCountryCode",
        count: { $sum: 1 },
      },
    },
  ]);
  let templateMessagesSent = 0;
  let metaUsageCostUsd = 0;
  let crossBorderTemplateCount = 0;
  for (const row of byCountry) {
    const count = Number(row?.count || 0);
    const countryCode =
      String(row?._id || "")
        .trim()
        .toUpperCase() ||
      pricingContext?.storeCountryCode ||
      null;
    const rateRow = await getCountryMessageRate(countryCode);
    const rateUsd = roundCurrency(
      rateRow?.byonUtilityTemplateUsd ||
        pricingContext?.byonUtilityTemplateUsd ||
        META_TEMPLATE_ESTIMATED_USD,
      4,
    );
    templateMessagesSent += count;
    metaUsageCostUsd += count * rateUsd;
    if (
      countryCode &&
      pricingContext?.storeCountryCode &&
      countryCode !== pricingContext.storeCountryCode
    ) {
      crossBorderTemplateCount += count;
    }
  }
  metaUsageCostUsd = roundCurrency(metaUsageCostUsd, 4);
  const elapsedMs = Math.max(
    24 * 60 * 60 * 1000,
    now.getTime() - startAt.getTime(),
  );
  const elapsedDays = elapsedMs / (24 * 60 * 60 * 1000);
  const cycleDays =
    cycleWindow?.startAt && cycleWindow?.endAt
      ? Math.max(
          1,
          (cycleWindow.endAt.getTime() - cycleWindow.startAt.getTime()) /
            (24 * 60 * 60 * 1000),
        )
      : BILLING_CYCLE_DAYS;
  const estimatedMonthlyMetaCostUsd = roundCurrency(
    elapsedDays > 0
      ? (metaUsageCostUsd / elapsedDays) * cycleDays
      : metaUsageCostUsd,
  );
  const remainingMessages =
    templateMessageCap != null
      ? Math.max(0, templateMessageCap - messagesSent)
      : null;
  const overageMessages =
    templateMessageCap != null
      ? Math.max(0, messagesSent - templateMessageCap)
      : 0;
  const overageChargePerMessageUsd = resolveByonOverageRate(
    billing?.plan,
    billing,
  );
  const usageCapUsd = resolveByonUsageCapUsd(billing?.plan, billing);
  const overageBillingEnabled =
    overageChargePerMessageUsd > 0 &&
    !!String(billing?.usageSubscriptionLineItemId || "").trim();
  const overageAgg = await BillingUsageCharge.aggregate([
    {
      $match: {
        shop,
        planKey: billing?.planKey || null,
        ...buildDateRangeFilter("createdAt", startAt, endAt),
      },
    },
    {
      $group: {
        _id: null,
        messages: {
          $sum: {
            $cond: [
              {
                $in: ["$status", ["pending", "submitted", "settled", "failed"]],
              },
              1,
              0,
            ],
          },
        },
        amount: {
          $sum: {
            $cond: [
              {
                $in: ["$status", ["pending", "submitted", "settled", "failed"]],
              },
              { $ifNull: ["$amount", 0] },
              0,
            ],
          },
        },
      },
    },
  ]);
  const orderxUsageMessages = Number(overageAgg?.[0]?.messages || 0);
  const orderxUsageCostUsd = roundCurrency(overageAgg?.[0]?.amount || 0, 2);
  const remainingUsageCapUsd =
    usageCapUsd != null
      ? roundCurrency(Math.max(0, usageCapUsd - orderxUsageCostUsd), 2)
      : null;
  const nextMessageRequiresOverage =
    templateMessageCap != null &&
    Number(messagesSent || 0) >= templateMessageCap;
  const nextOverageWouldExceedCap =
    nextMessageRequiresOverage &&
    usageCapUsd != null &&
    overageChargePerMessageUsd > 0 &&
    orderxUsageCostUsd + overageChargePerMessageUsd > usageCapUsd + 1e-9;
  const blockedReason = !nextMessageRequiresOverage
    ? null
    : String(billing?.plan?.billingType || "").trim() ===
        PLAN_BILLING_TYPES.FREE_CAP
      ? "Your Own Number free trial message limit reached. Choose Starter, Scale, or Unlimited to continue sending."
      : !overageBillingEnabled
        ? "Own-number overage billing is not approved on the active Shopify subscription."
        : nextOverageWouldExceedCap
          ? "Own-number overage billing cap reached for this cycle."
          : null;
  const { nearCapThreshold, criticalCapThreshold } =
    getByonCapThresholds(templateMessageCap);

  return {
    messagesSent,
    templateMessagesSent,
    metaUsageCostUsd,
    metaUsageCostPkr: convertUsdToPkr(metaUsageCostUsd),
    estimatedMonthlyMetaCostUsd,
    estimatedMonthlyMetaCostPkr: convertUsdToPkr(estimatedMonthlyMetaCostUsd),
    orderxUsageMessages,
    orderxUsageCostUsd,
    orderxUsageCostPkr: convertUsdToPkr(orderxUsageCostUsd),
    orderxUsageRateUsd: overageChargePerMessageUsd,
    overageMessages,
    overageChargePerMessageUsd,
    templateRateUsd: roundCurrency(
      pricingContext?.byonUtilityTemplateUsd || META_TEMPLATE_ESTIMATED_USD,
      4,
    ),
    outboundMessageCap: templateMessageCap,
    templateMessageCap,
    remainingMessages,
    nearCap:
      remainingMessages != null &&
      nearCapThreshold != null &&
      remainingMessages <= nearCapThreshold,
    criticalCap:
      remainingMessages != null &&
      criticalCapThreshold != null &&
      remainingMessages <= criticalCapThreshold,
    blocked: !!blockedReason,
    overageBillingEnabled,
    usageCapUsd,
    remainingUsageCapUsd,
    blockedReason,
    storeCountryCode: pricingContext?.storeCountryCode || null,
    storeCountryName: pricingContext?.storeCountryName || null,
    crossBorderTemplateCount,
  };
}

async function summarizeFreePlanUsage(shop, billing) {
  if (
    String(
      billing?.plan?.senderMode || getPlan(billing?.planKey)?.senderMode || "",
    ).trim() === SENDER_MODES.OWN_NUMBER
  ) {
    return {
      used: 0,
      limit: 0,
      remaining: null,
    };
  }

  const freeCap = Number(
    billing?.freeConfirmationCap ||
      billing?.plan?.includedConfirmations ||
      getPlan(billing?.planKey)?.includedConfirmations ||
      0,
  );
  const cycleWindow = resolveBillingCycleWindow(billing, new Date());
  const used = await countOutboundMessages({
    shop,
    senderMode: SENDER_MODES.ORDERX_NUMBER,
    templateOnly: true,
    startAt: cycleWindow?.startAt || null,
    endAt: cycleWindow?.endAt || null,
  });
  return {
    used,
    limit: freeCap,
    remaining: freeCap > 0 ? Math.max(0, freeCap - used) : null,
  };
}

export async function checkOutboundBillingAllowance(shop, options = {}) {
  const shopDomain = String(shop || "").trim();
  if (!shopDomain) return { ok: false, reason: "Missing shop" };
  const billing = options.billing || (await getBillingStatus(shopDomain));
  if (!billing?.active) {
    return { ok: false, reason: "Billing inactive", billing };
  }

  const senderMode = String(
    options?.senderMode || billing?.plan?.senderMode || "",
  ).trim();
  const billingType = String(billing?.plan?.billingType || "").trim();
  const isTemplateMessage =
    options?.isTemplateMessage === true || options?.isTemplate === true;

  if (
    senderMode === SENDER_MODES.OWN_NUMBER &&
    String(billing?.plan?.senderMode || "").trim() === SENDER_MODES.OWN_NUMBER
  ) {
    const cycleWindow = resolveBillingCycleWindow(billing, new Date());
    const byonUsage = await summarizeByonUsage(
      shopDomain,
      billing,
      cycleWindow,
      new Date(),
    );
    if (byonUsage?.blocked) {
      return {
        ok: false,
        reason:
          byonUsage?.blockedReason || "BYON outbound billing limit reached",
        billing,
        byonUsage,
        upgradePlanKey: billing?.plan?.upgradePlanKey || null,
      };
    }
    return { ok: true, billing, byonUsage };
  }

  if (senderMode !== SENDER_MODES.ORDERX_NUMBER) {
    return { ok: true, billing };
  }

  if (billingType === PLAN_BILLING_TYPES.FREE_CAP && isTemplateMessage) {
    const freeUsage = await summarizeFreePlanUsage(shopDomain, billing);
    if (freeUsage.limit > 0 && freeUsage.used >= freeUsage.limit) {
      return {
        ok: false,
        reason: "OrderX Free template limit reached",
        billing,
        freeUsage,
      };
    }
    return { ok: true, billing, freeUsage };
  }

  if (billingType === PLAN_BILLING_TYPES.SHOPIFY_METERED) {
    const usageSubscriptionLineItemId = String(
      billing?.usageSubscriptionLineItemId || "",
    ).trim();
    const subscriptionId = String(billing?.subscriptionId || "").trim();
    if (!subscriptionId || !usageSubscriptionLineItemId) {
      return {
        ok: false,
        reason:
          "OrderX Growth billing is not fully connected. Refresh billing or reactivate the plan before sending more messages.",
        billing,
      };
    }

    const cycleWindow = resolveBillingCycleWindow(billing, new Date());
    const growthUsage = await summarizeGrowthUsage(
      shopDomain,
      billing,
      cycleWindow,
      new Date(),
    );
    const nextPricing = await resolveGrowthMessagePricing({
      shop: shopDomain,
      toE164: options?.toE164 || options?.to || "",
      recipientCountryCode: options?.recipientCountryCode || "",
      storeCountryCode: billing?.storeCountryCode || "",
    });
    if (
      growthUsage.remainingUsd !== null &&
      growthUsage.remainingUsd + 1e-9 <
        Number(nextPricing?.recipientRateUsd || 0)
    ) {
      return {
        ok: false,
        reason: "OrderX Growth usage cap reached",
        billing,
        growthUsage,
        nextPricing,
      };
    }
    return { ok: true, billing, growthUsage, nextPricing };
  }

  return { ok: true, billing };
}

export async function getUsageRanges(shop, options = {}) {
  const now = toValidDate(options.referenceDate) || new Date();
  const billing = options.billing || null;
  const today = dayKey(now);
  const weekStart = dayKey(startOfWeek(now));
  const calendarMonthStart = dayKey(startOfMonth(now));
  const cycleWindow = resolveBillingCycleWindow(billing, now);
  const cycleStart = cycleWindow
    ? dayKey(cycleWindow.startAt)
    : calendarMonthStart;
  const cycleEndExclusive = cycleWindow ? dayKey(cycleWindow.endAt) : null;

  // metrics are per day; we can sum them
  const metrics = await Metric.find({ shop }).lean();

  const sumFrom = (startDay) =>
    metrics
      .filter((m) => String(m.day) >= String(startDay))
      .reduce((acc, m) => acc + Number(m.waMessagesSent || 0), 0);

  const sumTemplatesFrom = (startDay) =>
    metrics
      .filter((m) => String(m.day) >= String(startDay))
      .reduce((acc, m) => acc + Number(m.waTemplateMessagesSent || 0), 0);

  const sumBillableConfirmationsFrom = (startDay) =>
    metrics
      .filter((m) => String(m.day) >= String(startDay))
      .reduce(
        (acc, m) => acc + Number(m.waBillableConfirmationMessagesSent || 0),
        0,
      );

  const sumBetween = (startDay, endDayExclusive) =>
    metrics
      .filter(
        (m) =>
          String(m.day) >= String(startDay) &&
          String(m.day) < String(endDayExclusive),
      )
      .reduce((acc, m) => acc + Number(m.waMessagesSent || 0), 0);

  const sumTemplatesBetween = (startDay, endDayExclusive) =>
    metrics
      .filter(
        (m) =>
          String(m.day) >= String(startDay) &&
          String(m.day) < String(endDayExclusive),
      )
      .reduce((acc, m) => acc + Number(m.waTemplateMessagesSent || 0), 0);

  const sumBillableConfirmationsBetween = (startDay, endDayExclusive) =>
    metrics
      .filter(
        (m) =>
          String(m.day) >= String(startDay) &&
          String(m.day) < String(endDayExclusive),
      )
      .reduce(
        (acc, m) => acc + Number(m.waBillableConfirmationMessagesSent || 0),
        0,
      );

  const todayCount =
    metrics.find((m) => String(m.day) === today)?.waMessagesSent || 0;
  const todayTemplates =
    metrics.find((m) => String(m.day) === today)?.waTemplateMessagesSent || 0;
  const todayBillableConfirmations =
    metrics.find((m) => String(m.day) === today)
      ?.waBillableConfirmationMessagesSent || 0;
  const monthCount = cycleEndExclusive
    ? sumBetween(cycleStart, cycleEndExclusive)
    : sumFrom(cycleStart);
  const monthTemplateCount = cycleEndExclusive
    ? sumTemplatesBetween(cycleStart, cycleEndExclusive)
    : sumTemplatesFrom(cycleStart);
  const monthBillableConfirmationCount = cycleEndExclusive
    ? sumBillableConfirmationsBetween(cycleStart, cycleEndExclusive)
    : sumBillableConfirmationsFrom(cycleStart);
  const totalBillableConfirmations = sumBillableConfirmationsFrom("0000-00-00");
  const [freePlanUsage, growthUsage, byonUsage] = await Promise.all([
    summarizeFreePlanUsage(shop, billing || {}),
    summarizeGrowthUsage(shop, billing || {}, cycleWindow, now),
    summarizeByonUsage(shop, billing || {}, cycleWindow, now),
  ]);

  return {
    today: Number(todayCount) || 0,
    todayTemplates: Number(todayTemplates) || 0,
    todayBillableConfirmations: Number(todayBillableConfirmations) || 0,
    week: Number(sumFrom(weekStart)) || 0,
    // Backward-compatible key used in existing UI and gates.
    month: Number(monthCount) || 0,
    calendarMonth: Number(sumFrom(calendarMonthStart)) || 0,
    // Calendar month template messages (1st -> last day of the month).
    calendarMonthTemplates: Number(sumTemplatesFrom(calendarMonthStart)) || 0,
    // Billing-cycle template messages (30-day window anchored by charge date).
    monthTemplates: Number(monthTemplateCount) || 0,
    monthBillableConfirmations: Number(monthBillableConfirmationCount) || 0,
    totalBillableConfirmations: Number(totalBillableConfirmations) || 0,
    cycleStartAt: cycleWindow?.startAt || null,
    cycleEndAt: cycleWindow?.endAt || null,
    cycleDays: BILLING_CYCLE_DAYS,
    freePlanUsage,
    growthUsage,
    byonUsage,
    fx: {
      usdToPkr: USD_TO_PKR_RATE,
    },
  };
}

/**
 * ✅ Enforce:
 * - If ACTIVE: use plan.monthlyMessages per month
 * - If TRIAL: allow ONLY trialMessageCap total messages
 */
export async function canSendWhatsApp(shop, options = {}) {
  const billing = await getBillingStatus(shop);
  const agentReply = options?.agentReply === true;
  const agentBillingTestBypass =
    options?.agentBillingTestBypass === true && isAgentBillingTestShop(shop);
  if (!billing.active && !agentBillingTestBypass) {
    return { ok: false, reason: "Billing inactive" };
  }
  const runtimeConfig = await getRuntimeConfig();

  const s = await Shop.findOne({ shop }).lean();
  const b = s?.billing || {};
  const planSenderMode = String(billing?.plan?.senderMode || "").trim();
  const ownNumberStatus = String(
    s?.whatsappSender?.ownNumber?.status || "",
  ).trim();
  const ownPhoneNumberId = String(
    s?.whatsappSender?.ownNumber?.phoneNumberId || "",
  ).trim();
  const ownAccessToken = String(
    s?.whatsappSender?.ownNumber?.accessToken || "",
  ).trim();
  const ownRegistrationStatus = resolveOwnNumberRegistrationStatus(
    s?.whatsappSender?.ownNumber || {},
  );
  const ownRegistrationError = String(
    s?.whatsappSender?.ownNumber?.registrationError || "",
  ).trim();
  const ownTemplatesApproved =
    Array.isArray(s?.whatsappSender?.ownNumber?.templates) &&
    s.whatsappSender.ownNumber.templates.length > 0 &&
    s.whatsappSender.ownNumber.templates.every(
      (tpl) =>
        String(tpl?.status || "")
          .trim()
          .toLowerCase() === "approved",
    );
  const canInferOwnNumberReady =
    !OWN_NUMBER_READY_INFERENCE_BLOCKED_STATUSES.has(ownNumberStatus);
  const effectiveOwnNumberStatus =
    ownNumberStatus === "ready" ||
    (canInferOwnNumberReady &&
      ownPhoneNumberId &&
      ownAccessToken &&
      ownRegistrationStatus === "registered" &&
      ownTemplatesApproved)
      ? "ready"
      : ownNumberStatus;
  const ownPauseSending = !!s?.whatsappSender?.ownNumber?.pauseSending;
  const ownPauseReason = String(
    s?.whatsappSender?.ownNumber?.pauseReason || "",
  ).trim();
  const ownSendErrorStreak = Number(
    s?.whatsappSender?.ownNumber?.sendErrorStreak || 0,
  );
  const toE164 = normalizeToE164(options?.toE164 || options?.to || "");
  const explicitSenderPhoneNumberId = String(
    options?.senderPhoneNumberId || "",
  ).trim();
  const orderxPhoneNumberId = String(
    process.env.WA_PHONE_NUMBER_ID || "",
  ).trim();
  const scope = resolveConversationScope({
    shop,
    planSenderMode,
    settings: s?.settings || {},
    senderPhoneNumberId:
      explicitSenderPhoneNumberId ||
      (planSenderMode === SENDER_MODES.OWN_NUMBER
        ? ownPhoneNumberId
        : orderxPhoneNumberId),
    ownPhoneNumberId,
    orderxLimit24h: runtimeConfig?.orderxMaxInitiatedConversations24h,
  });
  const scopeUsage = await getConversationScopeUsage(scope, new Date());
  const alreadyInConversationWindow =
    options?.alreadyInConversationWindow === true ||
    options?.activeConversationWindow === true
      ? true
      : toE164
        ? await hasActiveConversationInWindow(scope, toE164, new Date())
        : false;
  const wouldConsumeInitiation = !!toE164 && !alreadyInConversationWindow;
  const planBillingType = String(billing?.plan?.billingType || "").trim();
  const isTemplateMessage =
    options?.isTemplate === true ||
    options?.template === true ||
    options?.templateMessage === true;

  if (agentReply && planSenderMode !== SENDER_MODES.OWN_NUMBER) {
    return {
      ok: false,
      reason:
        "Agent Messenger is available only for merchants using their own connected WhatsApp number.",
      billing,
      code: "agent_byon_required",
    };
  }

  if (
    wouldConsumeInitiation &&
    scopeUsage.limit24h > 0 &&
    scopeUsage.count24h >= scopeUsage.limit24h
  ) {
    return {
      ok: false,
      reason: `${scope.label} reached`,
      billing,
      initiatedConversations24h: {
        senderMode: scope.senderMode,
        count: scopeUsage.count24h,
        limit: scopeUsage.limit24h,
        remaining: 0,
      },
    };
  }

  if (planSenderMode === "own_number") {
    if (ownPauseSending) {
      return {
        ok: false,
        reason:
          ownPauseReason ||
          "Own number sending is paused after repeated send errors. Press Retry now to resume.",
        billing,
        senderStatus: ownNumberStatus || "ready",
        senderPaused: true,
        senderErrorStreak: ownSendErrorStreak,
      };
    }

    if (effectiveOwnNumberStatus !== "ready") {
      return {
        ok: false,
        reason:
          effectiveOwnNumberStatus === "reauth_required"
            ? "Own number reconnect required"
            : effectiveOwnNumberStatus === "registration_pending"
              ? ownRegistrationError ||
                "Own number Cloud API registration is not complete yet"
              : "Own number setup not completed",
        billing,
        senderStatus: effectiveOwnNumberStatus || "not_started",
      };
    }

    if (ownRegistrationStatus !== "registered") {
      return {
        ok: false,
        reason:
          ownRegistrationError ||
          "Own number Cloud API registration is not complete yet",
        billing,
        senderStatus: effectiveOwnNumberStatus || "not_started",
        senderRegistrationStatus: ownRegistrationStatus || "unknown",
      };
    }

    if (!ownPhoneNumberId || !ownAccessToken) {
      return {
        ok: false,
        reason: "Own number credentials missing or expired",
        billing,
        senderStatus: effectiveOwnNumberStatus || "not_started",
        senderNeedsReconnect: true,
      };
    }
  }

  if (agentReply) {
    return {
      ok: true,
      mode: agentBillingTestBypass
        ? "AGENT_TEST_BYPASS"
        : "AGENT_REPLY_CAP_EXEMPT",
      remaining: null,
      billing,
      capExempt: true,
      initiatedConversations24h: {
        senderMode: scope.senderMode,
        count: scopeUsage.count24h,
        limit: scopeUsage.limit24h,
        remaining: scopeUsage.remaining24h,
        consuming: false,
      },
    };
  }

  if (agentBillingTestBypass) {
    return {
      ok: true,
      mode: "AGENT_TEST_BYPASS",
      remaining: null,
      billing,
      initiatedConversations24h: {
        senderMode: scope.senderMode,
        count: scopeUsage.count24h,
        limit: scopeUsage.limit24h,
        remaining: scopeUsage.remaining24h,
        consuming: wouldConsumeInitiation,
      },
    };
  }

  if (billing.status === "TRIAL") {
    const byonTrialUsage =
      planSenderMode === SENDER_MODES.OWN_NUMBER
        ? (await getUsageRanges(shop, { billing }))?.byonUsage || null
        : null;
    const used = Number(
      byonTrialUsage ? byonTrialUsage.messagesSent : b.trialMessagesUsed || 0,
    );
    const cap = Number(billing.trialMessageCap ?? 10);
    if (used >= cap) {
      return {
        ok: false,
        reason:
          planSenderMode === SENDER_MODES.OWN_NUMBER
            ? "Your Own Number free trial message limit reached. Choose Starter, Scale, or Unlimited to continue sending."
            : "Trial message cap reached",
        billing,
      };
    }
    return {
      ok: true,
      mode: "TRIAL",
      remaining: cap - used,
      billing,
      initiatedConversations24h: {
        senderMode: scope.senderMode,
        count: scopeUsage.count24h,
        limit: scopeUsage.limit24h,
        remaining: scopeUsage.remaining24h,
        consuming: wouldConsumeInitiation,
      },
    };
  }

  // ACTIVE: OrderX-number plans still enforce monthly cap.
  if (planSenderMode === SENDER_MODES.OWN_NUMBER) {
    const ranges = await getUsageRanges(shop, { billing });
    const byonUsage = ranges?.byonUsage || null;
    if (byonUsage?.blocked) {
      return {
        ok: false,
        reason:
          byonUsage?.blockedReason || "BYON outbound billing limit reached",
        billing,
        senderStatus: ownNumberStatus || "not_started",
        byonUsage,
        upgradePlanKey: billing?.plan?.upgradePlanKey || null,
      };
    }

    return {
      ok: true,
      mode: "ACTIVE",
      remaining:
        resolvePlanTemplateCap(billing?.plan) != null
          ? Math.max(0, Number(byonUsage?.remainingMessages ?? 0))
          : null,
      billing,
      ...(byonUsage ? { byonUsage } : {}),
      initiatedConversations24h: {
        senderMode: scope.senderMode,
        count: scopeUsage.count24h,
        limit: scopeUsage.limit24h,
        remaining: scopeUsage.remaining24h,
        consuming: wouldConsumeInitiation,
      },
    };
  }

  if (planBillingType === PLAN_BILLING_TYPES.FREE_CAP) {
    const freeUsage = await summarizeFreePlanUsage(shop, billing);
    if (
      isTemplateMessage &&
      Number(freeUsage.limit || 0) > 0 &&
      Number(freeUsage.used || 0) >= Number(freeUsage.limit || 0)
    ) {
      return {
        ok: false,
        reason: "OrderX Free template limit reached",
        billing,
        remaining: 0,
        freeConfirmationUsage: {
          used: Number(freeUsage.used || 0),
          limit: Number(freeUsage.limit || 0),
          remaining: 0,
        },
      };
    }
    return {
      ok: true,
      mode: "ACTIVE",
      remaining:
        Number(freeUsage.limit || 0) > 0
          ? Math.max(
              0,
              Number(freeUsage.limit || 0) - Number(freeUsage.used || 0),
            )
          : null,
      billing,
      freeConfirmationUsage: {
        used: Number(freeUsage.used || 0),
        limit: Number(freeUsage.limit || 0),
        remaining:
          Number(freeUsage.limit || 0) > 0
            ? Math.max(
                0,
                Number(freeUsage.limit || 0) - Number(freeUsage.used || 0),
              )
            : null,
      },
      initiatedConversations24h: {
        senderMode: scope.senderMode,
        count: scopeUsage.count24h,
        limit: scopeUsage.limit24h,
        remaining: scopeUsage.remaining24h,
        consuming: wouldConsumeInitiation,
      },
    };
  }

  if (planBillingType === PLAN_BILLING_TYPES.SHOPIFY_METERED) {
    const ranges = await getUsageRanges(shop, { billing });
    return {
      ok: !ranges?.growthUsage?.blocked,
      mode: "ACTIVE",
      remaining: ranges?.growthUsage?.remainingMessages ?? null,
      billing,
      meteredConfirmationUsage: {
        cycleCount: Number(ranges?.growthUsage?.messagesSent || 0),
      },
      growthUsage: ranges?.growthUsage || null,
      initiatedConversations24h: {
        senderMode: scope.senderMode,
        count: scopeUsage.count24h,
        limit: scopeUsage.limit24h,
        remaining: scopeUsage.remaining24h,
        consuming: wouldConsumeInitiation,
      },
      ...(ranges?.growthUsage?.blocked
        ? { reason: "OrderX Growth usage cap reached" }
        : {}),
    };
  }

  // ACTIVE OrderX: per billing-cycle (30-day) limit
  const ranges = await getUsageRanges(shop, { billing });
  const monthlyLimit = Number(
    billing.plan?.monthlyMessages ||
      (Number(billing.plan?.dailyMessages || 0) > 0
        ? Number(billing.plan?.dailyMessages || 0) * 30
        : 0),
  );

  if (monthlyLimit > 0 && ranges.month >= monthlyLimit) {
    return { ok: false, reason: "Billing cycle limit exceeded", billing };
  }

  return {
    ok: true,
    mode: "ACTIVE",
    remaining: monthlyLimit > 0 ? monthlyLimit - ranges.month : null,
    billing,
    initiatedConversations24h: {
      senderMode: scope.senderMode,
      count: scopeUsage.count24h,
      limit: scopeUsage.limit24h,
      remaining: scopeUsage.remaining24h,
      consuming: wouldConsumeInitiation,
    },
  };
}

export async function incrementWhatsAppUsage(shop, count = 1, options = {}) {
  const billing = await getBillingStatus(shop);
  const c = Number(count || 0);
  const countTowardsCap = shouldCountWhatsAppUsageTowardsCap(options);
  const template =
    options?.isTemplate === true ||
    options?.template === true ||
    options?.templateMessage === true;
  const templateCountRaw = Number(options?.templateCount);
  const templateCount = Number.isFinite(templateCountRaw)
    ? Math.max(0, templateCountRaw)
    : template
      ? c
      : 0;
  const billableConfirmationCountRaw = Number(
    options?.billableConfirmationCount,
  );
  const billableConfirmationCount = Number.isFinite(
    billableConfirmationCountRaw,
  )
    ? Math.max(0, billableConfirmationCountRaw)
    : options?.billableConfirmation === true
      ? c
      : 0;

  // update metric day counter (for day/week/month analytics)
  const today = dayKey();
  await Metric.updateOne(
    { shop, day: today },
    {
      $inc: {
        waMessagesSent: c,
        ...(templateCount > 0 ? { waTemplateMessagesSent: templateCount } : {}),
        ...(billableConfirmationCount > 0
          ? {
              waBillableConfirmationMessagesSent: billableConfirmationCount,
            }
          : {}),
      },
    },
    { upsert: true },
  );

  // if trial, increment trialMessagesUsed total
  if (billing.status === "TRIAL" && countTowardsCap) {
    await Shop.updateOne(
      { shop },
      {
        $inc: {
          "billing.trialMessagesUsed": c,
          ...(String(billing?.plan?.senderMode || "").trim() ===
          SENDER_MODES.OWN_NUMBER
            ? { "billing.byonTrialMessagesUsed": c }
            : {}),
        },
      },
    );
  }

  if (
    countTowardsCap &&
    String(billing?.plan?.billingType || "").trim() ===
      PLAN_BILLING_TYPES.FREE_CAP &&
    String(billing?.plan?.senderMode || "").trim() ===
      SENDER_MODES.ORDERX_NUMBER &&
    templateCount > 0
  ) {
    await Shop.updateOne(
      { shop },
      {
        $inc: {
          "billing.freeConfirmationMessagesUsed": templateCount,
        },
        $set: {
          "billing.freeConfirmationCap": Number(
            billing?.freeConfirmationCap ||
              billing?.plan?.includedConfirmations ||
              10,
          ),
        },
      },
    );
  }

  const toE164 = normalizeToE164(options?.toE164 || options?.to || "");
  const countInitiatedConversation =
    options?.countInitiatedConversation === true ||
    options?.countInitiated === true;
  if (countInitiatedConversation && toE164) {
    const runtimeConfig = await getRuntimeConfig();
    const shopRecord = await Shop.findOne({ shop })
      .select({ settings: 1, "whatsappSender.ownNumber.phoneNumberId": 1 })
      .lean();
    const ownPhoneNumberId = String(
      shopRecord?.whatsappSender?.ownNumber?.phoneNumberId || "",
    ).trim();
    const explicitSenderPhoneNumberId = String(
      options?.senderPhoneNumberId || "",
    ).trim();
    const orderxPhoneNumberId = String(
      process.env.WA_PHONE_NUMBER_ID || "",
    ).trim();
    const scope = resolveConversationScope({
      shop,
      planSenderMode: String(billing?.plan?.senderMode || "").trim(),
      settings: shopRecord?.settings || {},
      senderPhoneNumberId:
        explicitSenderPhoneNumberId ||
        (String(billing?.plan?.senderMode || "").trim() ===
        SENDER_MODES.OWN_NUMBER
          ? ownPhoneNumberId
          : orderxPhoneNumberId),
      ownPhoneNumberId,
      orderxLimit24h: runtimeConfig?.orderxMaxInitiatedConversations24h,
    });
    await markConversationInitiated(scope, toE164, new Date());
  }

  return true;
}
