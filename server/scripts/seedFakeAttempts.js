import crypto from "crypto";
import dotenv from "dotenv";
import mongoose from "mongoose";

import BillingUsageCharge from "../models/BillingUsageCharge.js";
import CodAttempt from "../models/CodAttempt.js";
import Metric from "../models/Metric.js";
import Shop from "../models/Shop.js";
import WaMessageLog from "../models/WaMessageLog.js";
import { getBillingStatus } from "../services/billing.js";
import {
  getPlan,
  PLAN_BILLING_TYPES,
  SENDER_MODES,
} from "../services/plans.js";
import { resolveGrowthMessagePricing } from "../services/countryPricing.js";
import { resolveBillingCycleWindow } from "../services/usage.js";

dotenv.config();

const TEMPLATE_NAMES = [
  "orderx_cod_confirm_new",
  "orderx_cod_order_dispatched",
  "orderx_cod_tracking_updated",
  "orderx_cod_order_cancelled",
  "orderx_cod_order_update_generic",
];

const STATUS_PATTERN = [
  "confirmed",
  "cancelled",
  "expired",
  "wa_sent",
  "failed",
  "skipped",
];

function parseArg(argv, name, fallback = "") {
  const eq = argv.find((arg) => String(arg).startsWith(`--${name}=`));
  if (eq) return String(eq.split("=").slice(1).join("=") || "").trim();
  const idx = argv.findIndex((arg) => arg === `--${name}`);
  if (idx >= 0 && argv[idx + 1]) return String(argv[idx + 1]).trim();
  return fallback;
}

function parseIntArg(argv, name, fallback) {
  const raw = parseArg(argv, name, "");
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function parseBoolArg(argv, name, fallback = false) {
  const raw = parseArg(argv, name, "");
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function dayKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function formatUsage() {
  return [
    "Usage:",
    "  node server/scripts/seedFakeAttempts.js --shop <shop.myshopify.com>",
    "Options:",
    "  --count <n>          Number of fake attempts (default: 36)",
    "  --days <n>           Spread attempts across the last N days (default: 45)",
    "  --senderMode <mode>  orderx_number | own_number (default: current billing sender mode)",
    "  --reset <1|0>        Delete existing QA-seeded attempts/logs/charges before seeding (default: 1)",
    "  --followUps <1|0>    Add extra outbound follow-up messages (default: 0)",
    "  --metrics <1|0>      Also increment Metric day counters (default: 0)",
    "",
    "Notes:",
    "  - This script uses QA-prefixed rows only: order names start with #QA- and waMessageId starts with qa-seed:",
    "  - --reset only removes prior QA-seeded attempts/logs/charges. It does not touch real data.",
    "  - Metrics are aggregate rows, so --metrics=1 should be used only on a disposable dev shop.",
  ].join("\n");
}

function resolveStatus(index) {
  return STATUS_PATTERN[index % STATUS_PATTERN.length];
}

function buildSenderPhoneNumberId({ senderMode, shopRecord }) {
  if (senderMode === SENDER_MODES.OWN_NUMBER) {
    return (
      String(
        shopRecord?.whatsappSender?.ownNumber?.phoneNumberId || "",
      ).trim() || "qa-own-number"
    );
  }
  return (
    String(process.env.WA_PHONE_NUMBER_ID || "").trim() || "qa-orderx-number"
  );
}

function buildSenderQueueKey(senderMode, senderPhoneNumberId) {
  return `${String(senderMode || "unknown").trim()}:${String(
    senderPhoneNumberId || "unknown",
  ).trim()}`;
}

function buildCreatedAt(index, count, days, now) {
  const rangeMs = Math.max(1, days) * 24 * 60 * 60 * 1000;
  const stepMs = Math.max(
    60 * 60 * 1000,
    Math.floor(rangeMs / Math.max(count, 1)),
  );
  const offsetMs = Math.min(rangeMs - 1, index * stepMs);
  return new Date(now.getTime() - offsetMs);
}

function withinWindow(date, startAt, endAt) {
  const ts = new Date(date).getTime();
  const startMs = startAt ? new Date(startAt).getTime() : null;
  const endMs = endAt ? new Date(endAt).getTime() : null;
  return (
    (!Number.isFinite(startMs) || ts >= startMs) &&
    (!Number.isFinite(endMs) || ts < endMs)
  );
}

function summarizeResults({
  attempts,
  outboundLogs,
  inboundLogs,
  charges,
  metrics,
}) {
  const byStatus = attempts.reduce((acc, row) => {
    const key = String(row.status || "unknown");
    acc[key] = Number(acc[key] || 0) + 1;
    return acc;
  }, {});

  return {
    attemptsInserted: attempts.length,
    outboundLogsInserted: outboundLogs.length,
    inboundLogsInserted: inboundLogs.length,
    usageChargesInserted: charges.length,
    metricDaysUpdated: metrics.length,
    attemptsByStatus: byStatus,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const shop = parseArg(argv, "shop", "");
  const count = parseIntArg(argv, "count", 36);
  const days = parseIntArg(argv, "days", 45);
  const reset = parseBoolArg(argv, "reset", true);
  const seedFollowUps = parseBoolArg(argv, "followUps", false);
  const seedMetrics = parseBoolArg(argv, "metrics", false);
  const explicitSenderMode = parseArg(argv, "senderMode", "");

  if (!shop) {
    console.error(formatUsage());
    process.exit(1);
  }
  if (!process.env.MONGO_URI) {
    console.error("Missing MONGO_URI");
    process.exit(1);
  }
  if (reset && seedMetrics) {
    console.error(
      "--reset cannot be combined with --metrics because Metric rows are aggregate counters and cannot be safely subtracted.",
    );
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  try {
    const [shopRecord, billing] = await Promise.all([
      Shop.findOne({ shop }).lean(),
      getBillingStatus(shop),
    ]);
    if (!shopRecord) {
      console.error(`Shop not found: ${shop}`);
      process.exit(2);
    }

    const senderMode =
      explicitSenderMode === SENDER_MODES.ORDERX_NUMBER ||
      explicitSenderMode === SENDER_MODES.OWN_NUMBER
        ? explicitSenderMode
        : String(billing?.plan?.senderMode || "").trim() ||
          SENDER_MODES.ORDERX_NUMBER;
    const senderPhoneNumberId = buildSenderPhoneNumberId({
      senderMode,
      shopRecord,
    });
    const senderQueueKey = buildSenderQueueKey(senderMode, senderPhoneNumberId);
    const plan = getPlan(billing?.planKey);
    const now = new Date();
    const seedRunId = Date.now();
    const cycleWindow = resolveBillingCycleWindow(billing, now);
    const usageCurrencyCode =
      String(plan?.usagePrice?.currencyCode || "USD").trim() || "USD";
    const cycleId =
      cycleWindow?.startAt && cycleWindow?.endAt
        ? `${new Date(cycleWindow.startAt).toISOString()}__${new Date(
            cycleWindow.endAt,
          ).toISOString()}`
        : null;

    if (reset) {
      await Promise.all([
        CodAttempt.deleteMany({
          shop,
          orderName: { $regex: /^#QA-/ },
        }),
        WaMessageLog.deleteMany({
          shop,
          waMessageId: { $regex: /^qa-seed:/ },
        }),
        BillingUsageCharge.deleteMany({
          shop,
          waMessageId: { $regex: /^qa-seed:/ },
        }),
      ]);
    }

    const attempts = [];
    const outboundLogs = [];
    const inboundLogs = [];
    const usageCharges = [];
    const metricIncrements = new Map();

    for (let index = 0; index < count; index += 1) {
      const status = resolveStatus(index);
      const attemptId = new mongoose.Types.ObjectId();
      const orderNumericId = seedRunId * 1000 + index;
      const orderGid = `gid://shopify/Order/${orderNumericId}`;
      const orderName = `#QA-${seedRunId}-${String(index + 1).padStart(4, "0")}`;
      const createdAt = buildCreatedAt(index, count, days, now);
      const scheduledAt = addMinutes(createdAt, 10);
      const waSentAt =
        status === "skipped" ? null : addMinutes(createdAt, 25 + (index % 7));
      const templateName = TEMPLATE_NAMES[index % TEMPLATE_NAMES.length];
      const primaryWaMessageId =
        status === "skipped"
          ? null
          : `qa-seed:${shop}:${orderNumericId}:primary`;
      const replyWaMessageId =
        status === "confirmed" || status === "cancelled"
          ? `qa-seed:${shop}:${orderNumericId}:reply`
          : null;
      const phoneSuffix = String(1000 + (index % 9)).padStart(4, "0");
      const phoneE164 = `+1555000${phoneSuffix}`;
      const growthPricing =
        senderMode === SENDER_MODES.ORDERX_NUMBER &&
        String(plan?.billingType || "").trim() ===
          PLAN_BILLING_TYPES.SHOPIFY_METERED
          ? await resolveGrowthMessagePricing({
              shop,
              toE164: phoneE164,
              storeCountryCode: shopRecord?.storeCountryCode,
            })
          : null;
      const customerName = `QA Customer ${index + 1}`;
      const processedAt =
        status === "confirmed" ||
        status === "cancelled" ||
        status === "expired" ||
        status === "failed" ||
        status === "skipped"
          ? addMinutes(createdAt, 90 + (index % 20))
          : null;

      attempts.push({
        _id: attemptId,
        shop,
        orderGid,
        orderName,
        orderAmount: 1000 + index * 11,
        orderCurrency: "PKR",
        customerName,
        storeName: shopRecord?.shop,
        phoneE164,
        countryCode: "US",
        timezone: "Asia/Karachi",
        stage: "pre_dispatch",
        duplicateRole: "none",
        phoneQueueRole: "none",
        senderMode,
        senderPhoneNumberId,
        senderQueueKey,
        status,
        scheduledAt,
        lastTriedAt: waSentAt || scheduledAt,
        waMessageId: primaryWaMessageId,
        waTemplateUsed: primaryWaMessageId ? templateName : null,
        waSentAt,
        confirmTokenHash: crypto
          .createHash("sha256")
          .update(`qa-confirm:${orderGid}`)
          .digest("hex"),
        cancelTokenHash: crypto
          .createHash("sha256")
          .update(`qa-cancel:${orderGid}`)
          .digest("hex"),
        tokenExpiresAt: addMinutes(createdAt, 60 * 48),
        confirmedAt: status === "confirmed" ? processedAt : null,
        cancelledAt: status === "cancelled" ? processedAt : null,
        confirmSource: status === "confirmed" ? "qa_seed" : null,
        cancelSource: status === "cancelled" ? "qa_seed" : null,
        expiredAt: status === "expired" ? processedAt : null,
        expireSource: status === "expired" ? "qa_seed" : null,
        processedAt,
        lastError:
          status === "failed" ? "QA seeded delivery failure for testing" : null,
        lastErrorAt: status === "failed" ? processedAt || waSentAt : null,
        retryCount: status === "failed" ? 2 : 0,
        createdAt,
        updatedAt: processedAt || waSentAt || scheduledAt,
      });

      if (!primaryWaMessageId || !waSentAt) continue;

      outboundLogs.push({
        shop,
        toE164: phoneE164,
        direction: "outbound",
        kind: "cod_confirmation",
        text: `QA seeded confirmation for ${orderName}`,
        templateName,
        waMessageId: primaryWaMessageId,
        senderMode,
        senderPhoneNumberId,
        recipientCountryCode: growthPricing?.recipientCountryCode || null,
        storeCountryCode: growthPricing?.storeCountryCode || null,
        crossBorderRateApplied: !!growthPricing?.crossBorderRateApplied,
        usageChargeUsd: growthPricing?.recipientRateUsd ?? null,
        capUnitsConsumed: growthPricing?.capUnitsConsumed ?? null,
        attemptId,
        orderGid,
        meta: { qaSeed: true, orderName },
        createdAt: waSentAt,
        updatedAt: waSentAt,
      });

      const metricKey = dayKey(waSentAt);
      const currentMetric = metricIncrements.get(metricKey) || {
        waMessagesSent: 0,
        waTemplateMessagesSent: 0,
        waBillableConfirmationMessagesSent: 0,
      };
      currentMetric.waMessagesSent += 1;
      currentMetric.waTemplateMessagesSent += 1;
      currentMetric.waBillableConfirmationMessagesSent += 1;
      metricIncrements.set(metricKey, currentMetric);

      if (seedFollowUps && index % 3 === 0) {
        const followUpAt = addMinutes(waSentAt, 35);
        const followUpWaMessageId = `qa-seed:${shop}:${orderNumericId}:followup`;
        outboundLogs.push({
          shop,
          toE164: phoneE164,
          direction: "outbound",
          kind: "support_info",
          text: `QA seeded follow-up for ${orderName}`,
          templateName: null,
          waMessageId: followUpWaMessageId,
          senderMode,
          senderPhoneNumberId,
          recipientCountryCode: growthPricing?.recipientCountryCode || null,
          storeCountryCode: growthPricing?.storeCountryCode || null,
          crossBorderRateApplied: !!growthPricing?.crossBorderRateApplied,
          usageChargeUsd: growthPricing?.recipientRateUsd ?? null,
          capUnitsConsumed: growthPricing?.capUnitsConsumed ?? null,
          attemptId,
          orderGid,
          meta: { qaSeed: true, orderName, followUp: true },
          createdAt: followUpAt,
          updatedAt: followUpAt,
        });
        currentMetric.waMessagesSent += 1;

        if (
          senderMode === SENDER_MODES.ORDERX_NUMBER &&
          String(plan?.billingType || "").trim() ===
            PLAN_BILLING_TYPES.SHOPIFY_METERED &&
          cycleId &&
          withinWindow(followUpAt, cycleWindow?.startAt, cycleWindow?.endAt)
        ) {
          usageCharges.push({
            shop,
            planKey: plan.key,
            subscriptionId: billing?.subscriptionId || null,
            subscriptionLineItemId:
              billing?.usageSubscriptionLineItemId ||
              "qa-subscription-line-item",
            billingCycleId: cycleId,
            billingCycleStartedAt: cycleWindow?.startAt || null,
            billingCycleEndsAt: cycleWindow?.endAt || null,
            waMessageId: followUpWaMessageId,
            attemptId,
            orderGid,
            quantity: 1,
            amount: usageAmount,
            currencyCode: usageCurrencyCode,
            description: `QA seeded follow-up for ${orderName}`,
            idempotencyKey: `qa-seed:${followUpWaMessageId}`,
            usageRecordId: `gid://shopify/AppUsageRecord/${orderNumericId}01`,
            status:
              followUpAt < addMinutes(now, -24 * 60) ? "submitted" : "pending",
            submittedAt:
              followUpAt < addMinutes(now, -24 * 60) ? followUpAt : null,
            createdAt: followUpAt,
            updatedAt: followUpAt,
          });
        }
      }

      if (replyWaMessageId) {
        const inboundAt = addMinutes(waSentAt, 55);
        inboundLogs.push({
          shop,
          toE164: phoneE164,
          direction: "inbound",
          kind: "interactive_reply",
          text: status === "confirmed" ? "Yes, Confirmed." : "No, Cancel it.",
          templateName: null,
          waMessageId: replyWaMessageId,
          senderMode,
          senderPhoneNumberId,
          attemptId,
          orderGid,
          meta: { qaSeed: true, orderName },
          createdAt: inboundAt,
          updatedAt: inboundAt,
        });
      }

      if (
        senderMode === SENDER_MODES.ORDERX_NUMBER &&
        String(plan?.billingType || "").trim() ===
          PLAN_BILLING_TYPES.SHOPIFY_METERED &&
        cycleId &&
        withinWindow(waSentAt, cycleWindow?.startAt, cycleWindow?.endAt)
      ) {
        usageCharges.push({
          shop,
          planKey: plan.key,
          subscriptionId: billing?.subscriptionId || null,
          subscriptionLineItemId:
            billing?.usageSubscriptionLineItemId || "qa-subscription-line-item",
          billingCycleId: cycleId,
          billingCycleStartedAt: cycleWindow?.startAt || null,
          billingCycleEndsAt: cycleWindow?.endAt || null,
          waMessageId: primaryWaMessageId,
          attemptId,
          orderGid,
          quantity: 1,
          amount: Number(growthPricing?.recipientRateUsd || plan?.usagePrice?.amount || 0.01),
          currencyCode: usageCurrencyCode,
          recipientCountryCode: growthPricing?.recipientCountryCode || null,
          storeCountryCode: growthPricing?.storeCountryCode || null,
          crossBorderRateApplied: !!growthPricing?.crossBorderRateApplied,
          capUnitsConsumed: Number(growthPricing?.capUnitsConsumed || 1),
          description: `QA seeded message for ${orderName}`,
          idempotencyKey: `qa-seed:${primaryWaMessageId}`,
          usageRecordId: `gid://shopify/AppUsageRecord/${orderNumericId}`,
          status:
            waSentAt < addMinutes(now, -24 * 60) ? "submitted" : "pending",
          submittedAt: waSentAt < addMinutes(now, -24 * 60) ? waSentAt : null,
          createdAt: waSentAt,
          updatedAt: waSentAt,
        });
      }
    }

    if (attempts.length) {
      await CodAttempt.insertMany(attempts, { ordered: false });
    }
    if (outboundLogs.length || inboundLogs.length) {
      await WaMessageLog.insertMany([...outboundLogs, ...inboundLogs], {
        ordered: false,
      });
    }
    if (usageCharges.length) {
      await BillingUsageCharge.insertMany(usageCharges, { ordered: false });
    }
    if (seedMetrics && metricIncrements.size) {
      await Metric.bulkWrite(
        Array.from(metricIncrements.entries()).map(([day, inc]) => ({
          updateOne: {
            filter: { shop, day },
            update: { $inc: inc },
            upsert: true,
          },
        })),
      );
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          shop,
          senderMode,
          planKey: billing?.planKey || null,
          billingType: plan?.billingType || null,
          resetApplied: reset,
          followUpsSeeded: seedFollowUps,
          metricsSeeded: seedMetrics,
          ...summarizeResults({
            attempts,
            outboundLogs,
            inboundLogs,
            charges: usageCharges,
            metrics: Array.from(metricIncrements.keys()),
          }),
        },
        null,
        2,
      ),
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (error) => {
  console.error(error?.stack || error?.message || error);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore disconnect errors
  }
  process.exit(1);
});
