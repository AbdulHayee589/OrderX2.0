import BillingUsageCharge from "../models/BillingUsageCharge.js";
import Shop from "../models/Shop.js";
import WaMessageLog from "../models/WaMessageLog.js";
import { logAudit } from "./audit.js";
import {
  getPlan,
  PLAN_BILLING_TYPES,
  PLAN_KEYS,
  SENDER_MODES,
} from "./plans.js";
import { resolveBillingCycleWindow } from "./usage.js";
import { getAdminClient } from "../utils/shopifyAdmin.js";
import { resolveGrowthMessagePricing } from "./countryPricing.js";
import { buildShopifyCredentialCandidateQuery } from "./shopifyTokenState.js";

const SHOPIFY_MIN_USAGE_AMOUNT_USD = 0.01;
const USAGE_BATCH_LOCK_WINDOW_MS = Number(
  process.env.USAGE_BATCH_LOCK_WINDOW_MS ||
    process.env.PAKISTAN_BATCH_LOCK_WINDOW_MS ||
    15_000,
);
const USAGE_BATCH_LOCK_RETRY_MS = Number(
  process.env.USAGE_BATCH_LOCK_RETRY_MS ||
    process.env.PAKISTAN_BATCH_LOCK_RETRY_MS ||
    150,
);
const USAGE_BATCH_LOCK_ATTEMPTS = Number(
  process.env.USAGE_BATCH_LOCK_ATTEMPTS ||
    process.env.PAKISTAN_BATCH_LOCK_ATTEMPTS ||
    25,
);
const USAGE_CHARGE_LOCK_WINDOW_MS = Number(
  process.env.USAGE_CHARGE_LOCK_WINDOW_MS || 15_000,
);
const USAGE_CHARGE_LOCK_RETRY_MS = Number(
  process.env.USAGE_CHARGE_LOCK_RETRY_MS || 200,
);
const USAGE_CHARGE_LOCK_ATTEMPTS = Number(
  process.env.USAGE_CHARGE_LOCK_ATTEMPTS || 40,
);
const USAGE_CHARGE_RETRY_LIMIT = Number(
  process.env.USAGE_CHARGE_RETRY_LIMIT || 8,
);
const USAGE_CHARGE_RETRY_MAX_DELAY_MS = Number(
  process.env.USAGE_CHARGE_RETRY_MAX_DELAY_MS || 60 * 60 * 1000,
);

function roundCurrency(value, digits = 2) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(digits));
}

export function shouldUseThresholdBatch(pricingBasisUsd) {
  const amount = Number(pricingBasisUsd || 0);
  if (!Number.isFinite(amount) || amount <= 0) return false;
  return amount + 1e-9 < SHOPIFY_MIN_USAGE_AMOUNT_USD;
}

export function calculateThresholdBatchCharge({ accruedUsd, reservedOrChargedUsd }) {
  const outstandingUsd = roundCurrency(
    Math.max(0, Number(accruedUsd || 0) - Number(reservedOrChargedUsd || 0)),
    4,
  );
  const chargeAmount = roundCurrency(
    Math.floor((outstandingUsd + 1e-9) / SHOPIFY_MIN_USAGE_AMOUNT_USD) *
      SHOPIFY_MIN_USAGE_AMOUNT_USD,
    2,
  );
  return {
    outstandingUsd,
    chargeAmount:
      chargeAmount >= SHOPIFY_MIN_USAGE_AMOUNT_USD ? chargeAmount : 0,
    carryAfterUsd: roundCurrency(Math.max(0, outstandingUsd - chargeAmount), 4),
  };
}

function resolveOwnNumberIncludedCap(plan) {
  const rawCap =
    plan?.outboundMessageCap == null
      ? plan?.templateMessageCap
      : plan?.outboundMessageCap;
  const cap = Number(rawCap || 0);
  return Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : null;
}

function resolveOwnNumberOverageRate(plan) {
  const amount = Number(plan?.usagePrice?.amount || 0);
  return Number.isFinite(amount) && amount > 0 ? roundCurrency(amount, 4) : 0;
}

function resolveCycleContext(billing, plan) {
  const now = new Date();
  const cycleWindow = resolveBillingCycleWindow(
    {
      ...billing,
      plan: plan || getPlan(billing?.planKey),
    },
    now,
  );
  const startAt =
    cycleWindow?.startAt ||
    (billing?.currentPeriodStart ? new Date(billing.currentPeriodStart) : now);
  const endAt =
    cycleWindow?.endAt ||
    (billing?.currentPeriodEnd
      ? new Date(billing.currentPeriodEnd)
      : new Date(startAt.getTime() + 30 * 24 * 60 * 60 * 1000));
  const cycleId = `${startAt.toISOString()}__${endAt.toISOString()}`;
  return { cycleId, startAt, endAt };
}

function buildDescription({
  kind,
  orderGid,
  attemptId,
  recipientCountryCode = "",
  chargeAmount = 0,
  quantity = 1,
}) {
  const orderPart = orderGid ? String(orderGid).split("/").pop() || "" : "";
  const normalizedCountryCode = String(recipientCountryCode || "")
    .trim()
    .toUpperCase();
  if (normalizedCountryCode) {
    const amountPart = chargeAmount > 0 ? ` (${chargeAmount.toFixed(2)} USD)` : "";
    return `${normalizedCountryCode} WhatsApp usage batch for ${quantity} message${quantity === 1 ? "" : "s"}${orderPart ? ` — order ${orderPart}` : ""}${amountPart}`;
  }
  if (kind) {
    return `WhatsApp message (${String(kind)})${orderPart ? ` for order ${orderPart}` : ""}`;
  }
  if (orderPart) return `WhatsApp message for order ${orderPart}`;
  if (attemptId) return `WhatsApp message for attempt ${String(attemptId)}`;
  return "WhatsApp message sent through OrderX";
}

async function createUsageRecord({
  shop,
  accessToken,
  subscriptionLineItemId,
  description,
  amount,
  currencyCode,
  idempotencyKey,
}) {
  const admin = await getAdminClient(shop, accessToken);
  const mutation = `#graphql
    mutation AppUsageRecordCreate(
      $subscriptionLineItemId: ID!
      $description: String!
      $price: MoneyInput!
      $idempotencyKey: String!
    ) {
      appUsageRecordCreate(
        subscriptionLineItemId: $subscriptionLineItemId
        description: $description
        price: $price
        idempotencyKey: $idempotencyKey
      ) {
        appUsageRecord {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const out = await admin.query({
    data: {
      query: mutation,
      variables: {
        subscriptionLineItemId,
        description,
        price: { amount, currencyCode },
        idempotencyKey,
      },
    },
  });

  const payload = out?.body?.data?.appUsageRecordCreate || {};
  const userErrors = Array.isArray(payload?.userErrors) ? payload.userErrors : [];
  if (userErrors.length) {
    const msg = userErrors
      .map((item) => String(item?.message || "").trim())
      .filter(Boolean)
      .join(" | ");
    throw new Error(msg || "Shopify usage record creation failed");
  }

  const usageRecordId = String(payload?.appUsageRecord?.id || "").trim();
  if (!usageRecordId) {
    throw new Error("Shopify did not return a usage record ID");
  }

  return usageRecordId;
}

function isCapExceededError(errorMessage) {
  const msg = String(errorMessage || "").trim().toLowerCase();
  return (
    msg.includes("exceeds balance remaining") ||
    msg.includes("capped amount") ||
    msg.includes("usage cap")
  );
}

function isAlreadyProcessedStatus(status) {
  return ["buffered", "pending", "submitted", "settled", "failed", "skipped"].includes(
    String(status || "").trim(),
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isUsageRecordInProgressError(errorMessage) {
  const msg = String(errorMessage || "").trim().toLowerCase();
  return (
    msg.includes("another usage record creation is in progress") ||
    msg.includes("another request for the same shop, app, idempotency key is in progress") ||
    msg.includes("usage record creation is in progress") ||
    msg.includes("already creating a usage charge") ||
    msg.includes("usage charge for this store")
  );
}

function parseUsageRetryableDelayMs(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const num = Number(raw);
  if (Number.isFinite(num) && num > 0) {
    return num > 1000 ? Math.floor(num) : Math.floor(num * 1000);
  }
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) {
    const delay = parsed - Date.now();
    return delay > 0 ? delay : null;
  }
  return null;
}

function classifyUsageRecordError(error) {
  const message = String(error?.message || "").trim() || "Failed to create Shopify usage record";
  const httpStatus = Number(error?.httpStatus || error?.status || error?.statusCode || 0) || null;
  const errorCode =
    String(error?.meta?.error?.code || error?.code || error?.userErrors?.[0]?.code || "")
      .trim() || null;
  const lower = message.toLowerCase();
  const retryableByMessage =
    isUsageRecordInProgressError(lower) ||
    lower.includes("this request is currently in progress, please try again") ||
    lower.includes("failed to create usage charge") ||
    lower.includes("temporarily unavailable") ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("socket hang up") ||
    lower.includes("fetch failed") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("eai_again") ||
    lower.includes("service unavailable") ||
    lower.includes("internal server error");
  const retryable =
    httpStatus === 429 ||
    httpStatus >= 500 ||
    retryableByMessage ||
    errorCode === "IDEMPOTENCY_CONCURRENT_REQUEST";
  const retryAfterMs = parseUsageRetryableDelayMs(
    error?.retryAfterMs || error?.retryAfter || error?.retryAfterSec || null,
  );
  return {
    message,
    httpStatus,
    errorCode,
    retryable,
    retryAfterMs,
  };
}

function usageRetryDelayMs({ retryCount = 0, retryAfterMs = null, error = null }) {
  const retryAfterDelay = Number(retryAfterMs || 0);
  if (Number.isFinite(retryAfterDelay) && retryAfterDelay > 0) {
    return Math.min(USAGE_CHARGE_RETRY_MAX_DELAY_MS, retryAfterDelay);
  }
  const classified = classifyUsageRecordError(error);
  if (classified?.retryable && classified?.httpStatus === 429) {
    return Math.min(
      USAGE_CHARGE_RETRY_MAX_DELAY_MS,
      parseUsageRetryableDelayMs(error?.retryAfter || error?.retryAfterSec || null) ||
        Math.min(10 * 60 * 1000, 5000 * Math.max(1, Number(retryCount || 1))),
    );
  }
  const baseMs = isUsageRecordInProgressError(classified?.message)
    ? 750
    : classified?.httpStatus >= 500
      ? 15000
      : 30000;
  const exponent = Math.max(0, Math.min(6, Number(retryCount || 0)));
  const delay = baseMs * Math.pow(2, exponent);
  return Math.min(USAGE_CHARGE_RETRY_MAX_DELAY_MS, Math.max(baseMs, delay));
}

async function markUsageChargeRetryScheduled({
  row,
  error,
  nextRetryAt = null,
}) {
  const rowId = row?._id || null;
  if (!rowId) return null;
  const message = String(error?.message || "").trim() || "Failed to create Shopify usage record";
  const nextRetryDate =
    nextRetryAt instanceof Date
      ? nextRetryAt
      : nextRetryAt
        ? new Date(nextRetryAt)
        : null;
  await BillingUsageCharge.updateOne(
    { _id: rowId },
    {
      $set: {
        status: "pending",
        error: message,
        errorAt: new Date(),
        lastAttemptAt: new Date(),
        nextRetryAt: nextRetryDate,
      },
      $inc: {
        retryCount: 1,
      },
    },
  ).catch((error) => {
    console.warn(
      "[shopify_usage_charge_retry_mark_failed]",
      row?.shop || "",
      row?.waMessageId || "",
      error?.message || error,
    );
  });
  void logAudit({
    shop: row?.shop || null,
    actor: "system",
    action: "shopify_usage_charge_retry_scheduled",
    level: "warning",
    message,
    meta: {
      waMessageId: row?.waMessageId || null,
      planKey: row?.planKey || null,
      billingCycleId: row?.billingCycleId || null,
      billingStrategy: row?.billingStrategy || null,
      retryCount: Number(row?.retryCount || 0) + 1,
      nextRetryAt: nextRetryDate ? nextRetryDate.toISOString() : null,
    },
  });
  return {
    ok: false,
    retryScheduled: true,
    reason: "shopify_usage_retry_scheduled",
    error: message,
    nextRetryAt: nextRetryDate,
  };
}

async function markUsageChargeTerminalFailure({ row, error, skipped = false }) {
  const rowId = row?._id || null;
  if (!rowId) return null;
  const message = String(error?.message || "").trim() || "Failed to create Shopify usage record";
  const nextStatus = skipped ? "skipped" : "failed";
  await BillingUsageCharge.updateOne(
    { _id: rowId },
    {
      $set: {
        status: nextStatus,
        amount: nextStatus === "skipped" ? 0 : Number(row?.amount || 0),
        error: message,
        errorAt: new Date(),
        lastAttemptAt: new Date(),
        nextRetryAt: null,
      },
    },
  ).catch((error) => {
    console.warn(
      "[shopify_usage_charge_terminal_mark_failed]",
      row?.shop || "",
      row?.waMessageId || "",
      error?.message || error,
    );
  });
  void logAudit({
    shop: row?.shop || null,
    actor: "system",
    action: "shopify_usage_charge_failed",
    level: nextStatus === "skipped" ? "warning" : "error",
    message,
    meta: {
      waMessageId: row?.waMessageId || null,
      planKey: row?.planKey || null,
      billingCycleId: row?.billingCycleId || null,
      billingStrategy: row?.billingStrategy || null,
      batchGroupKey: row?.batchGroupKey || null,
      skipped,
    },
  });
  return {
    ok: false,
    skipped,
    reason: skipped ? "cap_reached" : "shopify_usage_error",
    error: message,
  };
}

async function withUsageBatchLock(shop, fn) {
  const shopDomain = String(shop || "").trim();
  if (!shopDomain) throw new Error("Missing shop for usage batching");

  for (let attempt = 0; attempt < USAGE_BATCH_LOCK_ATTEMPTS; attempt += 1) {
    const lockUntil = new Date(Date.now() + USAGE_BATCH_LOCK_WINDOW_MS);
    const acquired = await Shop.findOneAndUpdate(
      {
        shop: shopDomain,
        $or: [
          { "billing.usageBatchLockUntil": { $exists: false } },
          { "billing.usageBatchLockUntil": null },
          { "billing.usageBatchLockUntil": { $lt: new Date() } },
        ],
      },
      {
        $set: {
          "billing.usageBatchLockUntil": lockUntil,
        },
      },
      {
        new: true,
        projection: { _id: 1 },
      },
    ).lean();

    if (acquired?._id) {
      try {
        return await fn();
      } finally {
        await Shop.updateOne(
          { shop: shopDomain },
          { $set: { "billing.usageBatchLockUntil": null } },
        ).catch(() => {});
      }
    }

    await wait(USAGE_BATCH_LOCK_RETRY_MS);
  }

  throw new Error(
    "OrderX could not acquire the usage billing lock. Please retry in a few seconds.",
  );
}

async function withUsageChargeLock(shop, lockKey, fn) {
  const shopDomain = String(shop || "").trim();
  const usageLockKey = String(lockKey || "").trim();
  if (!shopDomain || !usageLockKey) {
    throw new Error("Missing shop or usage lock key");
  }

  for (let attempt = 0; attempt < USAGE_CHARGE_LOCK_ATTEMPTS; attempt += 1) {
    const lockUntil = new Date(Date.now() + USAGE_CHARGE_LOCK_WINDOW_MS);
    const acquired = await Shop.findOneAndUpdate(
      {
        shop: shopDomain,
        $or: [
          { "billing.usageChargeLockUntil": { $exists: false } },
          { "billing.usageChargeLockUntil": null },
          { "billing.usageChargeLockUntil": { $lt: new Date() } },
        ],
      },
      {
        $set: {
          "billing.usageChargeLockUntil": lockUntil,
          "billing.usageChargeLockKey": usageLockKey,
        },
      },
      {
        new: true,
        projection: { _id: 1 },
      },
    ).lean();

    if (acquired?._id) {
      try {
        return await fn();
      } finally {
        await Shop.updateOne(
          { shop: shopDomain },
          {
            $set: {
              "billing.usageChargeLockUntil": null,
              "billing.usageChargeLockKey": null,
            },
          },
        ).catch(() => {});
      }
    }

    await wait(USAGE_CHARGE_LOCK_RETRY_MS);
  }

  throw new Error(
    "OrderX is already creating a usage charge for this store. Please retry in a few seconds.",
  );
}

async function aggregateCycleUsageLedger({ shop, billingCycleId, countryCode = null }) {
  const match = {
    shop,
    billingCycleId,
  };
  if (countryCode) {
    match.recipientCountryCode = String(countryCode || "").trim().toUpperCase();
  }

  const rows = await BillingUsageCharge.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        accruedUsd: {
          $sum: {
            $cond: [
              { $ne: ["$status", "skipped"] },
              { $ifNull: ["$pricingBasisUsd", "$amount"] },
              0,
            ],
          },
        },
        reservedOrChargedUsd: {
          $sum: {
            $cond: [
              { $in: ["$status", ["pending", "submitted", "failed"]] },
              { $ifNull: ["$amount", 0] },
              0,
            ],
          },
        },
      },
    },
  ]);

  return {
    accruedUsd: roundCurrency(rows?.[0]?.accruedUsd || 0, 4),
    reservedOrChargedUsd: roundCurrency(
      rows?.[0]?.reservedOrChargedUsd || 0,
      4,
    ),
  };
}

async function updateWaMessageUsageLog({
  shop,
  waMessageId,
  recipientCountryCode,
  storeCountryCode,
  crossBorderRateApplied,
  usagePricingBasisUsd,
  usageChargeUsd,
  usageChargeState,
  usageBillingStrategy,
  usageBatchGroupKey,
  capUnitsConsumed,
}) {
  const shopDomain = String(shop || "").trim();
  const messageId = String(waMessageId || "").trim();
  if (!shopDomain || !messageId) return;

  await WaMessageLog.updateOne(
    { shop: shopDomain, waMessageId: messageId },
    {
      $set: {
        recipientCountryCode: recipientCountryCode || null,
        storeCountryCode: storeCountryCode || null,
        crossBorderRateApplied: !!crossBorderRateApplied,
        usagePricingBasisUsd:
          Number.isFinite(Number(usagePricingBasisUsd))
            ? roundCurrency(usagePricingBasisUsd, 4)
            : null,
        usageChargeUsd:
          Number.isFinite(Number(usageChargeUsd)) && Number(usageChargeUsd) > 0
            ? roundCurrency(usageChargeUsd, 2)
            : 0,
        usageChargeState: usageChargeState || null,
        usageBillingStrategy: usageBillingStrategy || null,
        usageBatchGroupKey: usageBatchGroupKey || null,
        capUnitsConsumed: Number(capUnitsConsumed || 1),
      },
    },
  ).catch(() => {});
}

async function settleBufferedThresholdRows({
  shop,
  billingCycleId,
  recipientCountryCode,
  currentWaMessageId,
  batchGroupKey,
  pricingBasisUsd,
  chargeAmount,
}) {
  const countryCode = String(recipientCountryCode || "").trim().toUpperCase();
  if (!countryCode) return [];
  const settleCount = Math.max(
    0,
    Math.ceil(Number(chargeAmount || 0) / Math.max(Number(pricingBasisUsd || 0), 0.0001)) - 1,
  );
  if (!settleCount) return [];

  const rows = await BillingUsageCharge.find({
    shop,
    billingCycleId,
    recipientCountryCode: countryCode,
    status: "buffered",
    waMessageId: { $ne: currentWaMessageId },
  })
    .sort({ createdAt: 1 })
    .limit(settleCount)
    .select({ _id: 1, waMessageId: 1 })
    .lean();

  if (!rows.length) return [];

  await BillingUsageCharge.updateMany(
    { _id: { $in: rows.map((row) => row._id) } },
    {
      $set: {
        status: "settled",
        settledByWaMessageId: currentWaMessageId,
        settledAt: new Date(),
        batchGroupKey: batchGroupKey || null,
      },
    },
  );

  await Promise.all(
    rows.map((row) =>
      updateWaMessageUsageLog({
        shop,
        waMessageId: row.waMessageId,
        usageChargeState: "settled",
        usageBillingStrategy: "threshold_batch",
        usageBatchGroupKey: batchGroupKey,
      }),
    ),
  );

  return rows;
}

async function submitPendingUsageRow({
  shop,
  accessToken,
  subscriptionLineItemId,
  row,
}) {
  const shopDomain = String(shop || "").trim();
  const usageLockKey = String(subscriptionLineItemId || "").trim() || "unknown";
  return withUsageChargeLock(shopDomain, usageLockKey, async () => {
    const description =
      String(row?.description || "").trim() ||
      buildDescription({
        kind: row?.kind,
        orderGid: row?.orderGid,
        attemptId: row?.attemptId,
        recipientCountryCode: row?.recipientCountryCode,
        chargeAmount: row?.amount,
        quantity: Number(row?.quantity || 1),
      });

    let usageRecordId = null;
    let lastError = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        usageRecordId = await createUsageRecord({
          shop: shopDomain,
          accessToken,
          subscriptionLineItemId,
          description,
          amount: roundCurrency(row?.amount || 0, 2),
          currencyCode: String(row?.currencyCode || "USD").trim() || "USD",
          idempotencyKey: String(row?.idempotencyKey || "").trim(),
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        const classified = classifyUsageRecordError(error);
        if (
          !classified?.retryable ||
          attempt >= 3 ||
          isCapExceededError(classified?.message)
        ) {
          break;
        }
        const waitMs = usageRetryDelayMs({
          retryCount: Number(row?.retryCount || 0) + attempt + 1,
          retryAfterMs: classified?.retryAfterMs || null,
          error,
        });
        await wait(Math.max(250, Math.min(waitMs, 5000)));
      }
    }

    if (!usageRecordId) {
      const classified = classifyUsageRecordError(lastError);
      if (isCapExceededError(classified?.message)) {
        return markUsageChargeTerminalFailure({
          row,
          error: lastError,
          skipped: true,
        });
      }

      if (classified?.retryable) {
        const nextRetryAt = new Date(
          Date.now() +
            usageRetryDelayMs({
              retryCount: Number(row?.retryCount || 0) + 1,
              retryAfterMs: classified?.retryAfterMs || null,
              error: lastError,
            }),
        );
        return markUsageChargeRetryScheduled({
          row,
          error: lastError,
          retryCount: Number(row?.retryCount || 0) + 1,
          nextRetryAt,
        });
      }

      return markUsageChargeTerminalFailure({
        row,
        error: lastError,
        skipped: false,
      });
    }

    await BillingUsageCharge.updateOne(
      { _id: row._id },
      {
        $set: {
          status: "submitted",
          usageRecordId,
          submittedAt: new Date(),
          error: null,
          errorAt: null,
          lastAttemptAt: new Date(),
          nextRetryAt: null,
        },
      },
    ).catch((err) => {
      console.warn(
        "[shopify_usage_charge_row_update_failed]",
        shop,
        row?.waMessageId || "",
        err?.message || err,
      );
    });

    if (
      ["threshold_batch", "pakistan_threshold_batch"].includes(
        row?.billingStrategy,
      )
    ) {
      await settleBufferedThresholdRows({
        shop,
        billingCycleId: row?.billingCycleId,
        recipientCountryCode: row?.recipientCountryCode,
        currentWaMessageId: row?.waMessageId,
        batchGroupKey: row?.batchGroupKey,
        pricingBasisUsd: row?.pricingBasisUsd,
        chargeAmount: row?.amount,
      }).catch((err) => {
        console.warn(
          "[shopify_usage_batch_settle_failed]",
          shop,
          row?.waMessageId || "",
          err?.message || err,
        );
      });
    }

    await updateWaMessageUsageLog({
      shop,
      waMessageId: row?.waMessageId,
      recipientCountryCode: row?.recipientCountryCode || null,
      storeCountryCode: row?.storeCountryCode || null,
      crossBorderRateApplied: !!row?.crossBorderRateApplied,
      usagePricingBasisUsd: row?.pricingBasisUsd,
      usageChargeUsd: row?.amount,
      usageChargeState: "submitted",
      usageBillingStrategy: row?.billingStrategy || "per_message",
      usageBatchGroupKey: row?.batchGroupKey || null,
      capUnitsConsumed: row?.capUnitsConsumed || 1,
    });

    return {
      ok: true,
      usageRecordId,
      rowId: String(row?._id || ""),
    };
  });
}

async function applySubmittedChargeSideEffects({
  shop,
  record,
  plan,
  amount,
  currencyCode,
  auditMeta,
  billingChargeId = null,
}) {
  const chargeId = String(billingChargeId || "").trim();
  if (chargeId) {
    const claimed = await BillingUsageCharge.findOneAndUpdate(
      {
        _id: chargeId,
        $or: [
          { balanceAppliedAt: { $exists: false } },
          { balanceAppliedAt: null },
        ],
      },
      {
        $set: {
          balanceAppliedAt: new Date(),
          balanceAppliedError: null,
        },
      },
      { new: true, projection: { _id: 1 } },
    ).lean();
    if (!claimed?._id) {
      return {
        ok: true,
        skipped: true,
        reason: "balance_already_applied",
      };
    }
  }

  try {
    await Shop.updateOne(
      { shop },
      {
        $inc: { "billing.usageBalanceUsedAmount": roundCurrency(amount, 2) },
        $set: {
          "billing.usageBalanceUsedCurrencyCode": currencyCode,
          "billing.usageCappedAmount":
            Number(
              record?.billing?.usageCappedAmount || plan?.usageCappedAmount?.amount || 0,
            ) || null,
          "billing.usageCappedCurrencyCode":
            record?.billing?.usageCappedCurrencyCode ||
            plan?.usageCappedAmount?.currencyCode ||
            currencyCode,
        },
      },
    );
  } catch (error) {
    if (chargeId) {
      await BillingUsageCharge.updateOne(
        { _id: chargeId },
        {
          $set: {
            balanceAppliedError: String(error?.message || error || "").trim() || null,
          },
        },
      ).catch(() => {});
    }
    throw error;
  }

  if (chargeId) {
    await BillingUsageCharge.updateOne(
      { _id: chargeId },
      {
        $set: {
          balanceAppliedError: null,
        },
      },
    ).catch(() => {});
  }

  void logAudit({
    shop,
    actor: "system",
    action: "shopify_usage_charge_created",
    meta: auditMeta,
  });

  return {
    ok: true,
    skipped: false,
    reason: null,
  };
}

function buildExistingResult(existing) {
  const status = String(existing?.status || "").trim();
  if (status === "submitted") {
    return {
      ok: true,
      skipped: true,
      reason: "already_submitted",
      usageRecordId: existing?.usageRecordId || null,
    };
  }
  if (status === "pending") {
    return {
      ok: true,
      skipped: true,
      reason: "already_pending",
      usageRecordId: existing?.usageRecordId || null,
    };
  }
  if (status === "buffered" || status === "settled") {
    return {
      ok: true,
      skipped: true,
      reason: "already_buffered",
      usageRecordId: existing?.usageRecordId || null,
    };
  }
  return {
    ok: false,
    skipped: true,
    reason: `already_${status || "processed"}`,
    usageRecordId: existing?.usageRecordId || null,
    error: existing?.error || null,
  };
}

async function resumeAnyPendingThresholdBatch({
  shop,
  accessToken,
  subscriptionLineItemId,
  record,
  plan,
}) {
  const pendingRow = await BillingUsageCharge.findOne({
    shop,
    planKey: plan.key,
    billingStrategy: { $in: ["threshold_batch", "pakistan_threshold_batch"] },
    status: "pending",
  })
    .sort({ createdAt: 1 })
    .lean();

  if (!pendingRow?._id) return null;

  try {
    const submitResult = await submitPendingUsageRow({
      shop,
      accessToken,
      subscriptionLineItemId,
      row: pendingRow,
    });

    if (!submitResult?.ok) {
      return submitResult;
    }

    try {
      await applySubmittedChargeSideEffects({
        shop,
        record,
        plan,
        amount: pendingRow.amount,
        currencyCode: pendingRow.currencyCode,
        billingChargeId: pendingRow._id,
        auditMeta: {
          planKey: plan.key,
          waMessageId: pendingRow.waMessageId,
          usageRecordId: submitResult.usageRecordId,
          amount: pendingRow.amount,
          currencyCode: pendingRow.currencyCode,
          billingCycleId: pendingRow.billingCycleId,
          recipientCountryCode: pendingRow.recipientCountryCode || null,
          storeCountryCode: pendingRow.storeCountryCode || null,
          capUnitsConsumed: Number(pendingRow.capUnitsConsumed || 1),
          billingStrategy: pendingRow.billingStrategy || "per_message",
          batchGroupKey: pendingRow.batchGroupKey || null,
        },
      });
    } catch (sideEffectError) {
      console.warn(
        "[shopify_usage_charge_side_effect_failed]",
        shop,
        pendingRow?.waMessageId || "",
        sideEffectError?.message || sideEffectError,
      );
      await recalculateShopUsageBalance({
        shop,
        billing: record?.billing || null,
        now: new Date(),
      }).catch(() => {});
    }

    return { ok: true, usageRecordId: submitResult.usageRecordId, row: pendingRow };
  } catch (error) {
    const message = error?.message || "Failed to resume Shopify usage batch";
    const nextStatus = isCapExceededError(message) ? "skipped" : "failed";
    await BillingUsageCharge.updateOne(
      { _id: pendingRow._id },
      {
        $set: {
          status: nextStatus,
          amount: nextStatus === "skipped" ? 0 : pendingRow.amount,
          error: message,
          errorAt: new Date(),
        },
      },
    );
    await updateWaMessageUsageLog({
      shop,
      waMessageId: pendingRow.waMessageId,
      recipientCountryCode: pendingRow.recipientCountryCode || null,
      storeCountryCode: pendingRow.storeCountryCode || null,
      crossBorderRateApplied: !!pendingRow.crossBorderRateApplied,
      usagePricingBasisUsd: pendingRow.pricingBasisUsd,
      usageChargeUsd: nextStatus === "skipped" ? 0 : pendingRow.amount,
      usageChargeState: nextStatus,
      usageBillingStrategy: pendingRow.billingStrategy || "per_message",
      usageBatchGroupKey: pendingRow.batchGroupKey || null,
      capUnitsConsumed: pendingRow.capUnitsConsumed || 1,
    });
    void logAudit({
      shop,
      actor: "system",
      action: "shopify_usage_charge_failed",
      level: nextStatus === "skipped" ? "warning" : "error",
      message,
      meta: {
        planKey: plan.key,
        waMessageId: pendingRow.waMessageId,
        billingCycleId: pendingRow.billingCycleId,
        recipientCountryCode: pendingRow.recipientCountryCode || null,
        billingStrategy: pendingRow.billingStrategy || "per_message",
      },
    });
    return {
      ok: false,
      skipped: nextStatus === "skipped",
      reason: nextStatus === "skipped" ? "cap_reached" : "shopify_usage_error",
      error: message,
      row: pendingRow,
    };
  }
}

async function recordThresholdBatchedGrowthUsageMessage({
  shop,
  record,
  plan,
  messageId,
  attemptId,
  orderGid,
  kind,
  pricing,
  subscriptionLineItemId,
}) {
  const recipientCountryCode = String(pricing?.recipientCountryCode || "")
    .trim()
    .toUpperCase();
  if (!recipientCountryCode) {
    return { ok: false, skipped: true, reason: "missing_recipient_country" };
  }
  return withUsageBatchLock(shop, async () => {
    const existing = await BillingUsageCharge.findOne({
      shop,
      waMessageId: messageId,
    }).lean();
    if (existing && isAlreadyProcessedStatus(existing.status)) {
      return buildExistingResult(existing);
    }

    const { cycleId, startAt, endAt } = resolveCycleContext(
      record?.billing || {},
      plan,
    );

    const pendingResume = await resumeAnyPendingThresholdBatch({
      shop,
      accessToken: record.accessToken,
      subscriptionLineItemId,
      record,
      plan,
    });
    if (pendingResume?.ok === false) {
      return pendingResume;
    }

    const messageBasisUsd = roundCurrency(Number(pricing?.recipientRateUsd || 0), 4);
    const fullCycleLedger = await aggregateCycleUsageLedger({
      shop,
      billingCycleId: cycleId,
    });
    const capAmount = roundCurrency(
      Number(
        record?.billing?.usageCappedAmount || plan?.usageCappedAmount?.amount || 0,
      ),
      2,
    );
    if (capAmount > 0 && fullCycleLedger.accruedUsd + messageBasisUsd > capAmount + 1e-9) {
      await BillingUsageCharge.findOneAndUpdate(
        { shop, waMessageId: messageId },
        {
          $setOnInsert: {
            shop,
            planKey: plan.key,
            subscriptionId: record?.billing?.subscriptionId || null,
            subscriptionLineItemId,
            billingCycleId: cycleId,
            billingCycleStartedAt: startAt,
            billingCycleEndsAt: endAt,
            waMessageId: messageId,
            attemptId: attemptId || null,
            orderGid: orderGid || null,
            quantity: 1,
            amount: 0,
            pricingBasisUsd: messageBasisUsd,
            currencyCode:
              String(plan?.usagePrice?.currencyCode || "USD").trim() || "USD",
            recipientCountryCode,
            storeCountryCode: pricing?.storeCountryCode || null,
            crossBorderRateApplied: !!pricing?.crossBorderRateApplied,
            capUnitsConsumed: Number(pricing?.capUnitsConsumed || 1),
            billingStrategy: "threshold_batch",
            description: buildDescription({ kind, orderGid, attemptId }),
            idempotencyKey: `orderx:${shop}:${messageId}:usage-buffer`,
          },
          $set: {
            status: "skipped",
            error: "Growth usage cap reached before recording the next message.",
            errorAt: new Date(),
          },
        },
        { upsert: true, new: true },
      );
      await updateWaMessageUsageLog({
        shop,
        waMessageId: messageId,
        recipientCountryCode: pricing?.recipientCountryCode || null,
        storeCountryCode: pricing?.storeCountryCode || null,
        crossBorderRateApplied: !!pricing?.crossBorderRateApplied,
        usagePricingBasisUsd: messageBasisUsd,
        usageChargeUsd: 0,
        usageChargeState: "skipped",
        usageBillingStrategy: "threshold_batch",
        usageBatchGroupKey: null,
        capUnitsConsumed: Number(pricing?.capUnitsConsumed || 1),
      });
      return { ok: false, skipped: true, reason: "cap_reached" };
    }

    const description = buildDescription({ kind, orderGid, attemptId });
    await BillingUsageCharge.findOneAndUpdate(
      { shop, waMessageId: messageId },
      {
        $setOnInsert: {
          shop,
          planKey: plan.key,
          subscriptionId: record?.billing?.subscriptionId || null,
          subscriptionLineItemId,
          billingCycleId: cycleId,
          billingCycleStartedAt: startAt,
          billingCycleEndsAt: endAt,
          waMessageId: messageId,
          attemptId: attemptId || null,
          orderGid: orderGid || null,
          quantity: 1,
          amount: 0,
          pricingBasisUsd: messageBasisUsd,
          currencyCode: String(plan?.usagePrice?.currencyCode || "USD").trim() || "USD",
          recipientCountryCode,
          storeCountryCode: pricing?.storeCountryCode || null,
          crossBorderRateApplied: !!pricing?.crossBorderRateApplied,
          capUnitsConsumed: Number(pricing?.capUnitsConsumed || 1),
          billingStrategy: "threshold_batch",
          description,
          idempotencyKey: `orderx:${shop}:${messageId}:usage-buffer`,
        },
        $set: {
          status: "buffered",
          error: null,
          errorAt: null,
          carryBeforeUsd: null,
          carryAfterUsd: null,
          batchGroupKey: null,
          settledByWaMessageId: null,
          settledAt: null,
        },
      },
      { upsert: true, new: true },
    );

    const totals = await aggregateCycleUsageLedger({
      shop,
      billingCycleId: cycleId,
      countryCode: recipientCountryCode,
    });
    const { outstandingUsd, chargeAmount, carryAfterUsd } =
      calculateThresholdBatchCharge(totals);

    if (chargeAmount < SHOPIFY_MIN_USAGE_AMOUNT_USD) {
      await BillingUsageCharge.updateOne(
        { shop, waMessageId: messageId },
        {
          $set: {
            status: "buffered",
            amount: 0,
            carryBeforeUsd: roundCurrency(
              Math.max(0, outstandingUsd - messageBasisUsd),
              4,
            ),
            carryAfterUsd,
          },
        },
      );
      await updateWaMessageUsageLog({
        shop,
        waMessageId: messageId,
        recipientCountryCode: pricing?.recipientCountryCode || null,
        storeCountryCode: pricing?.storeCountryCode || null,
        crossBorderRateApplied: !!pricing?.crossBorderRateApplied,
        usagePricingBasisUsd: messageBasisUsd,
        usageChargeUsd: 0,
        usageChargeState: "buffered",
        usageBillingStrategy: "threshold_batch",
        usageBatchGroupKey: null,
        capUnitsConsumed: Number(pricing?.capUnitsConsumed || 1),
      });
      return {
        ok: true,
        skipped: true,
        reason: "buffered_until_next_cent",
        buffered: true,
        pendingCarryUsd: carryAfterUsd,
      };
    }

    const chargedBeforeUsd = roundCurrency(totals.reservedOrChargedUsd, 2);
    const batchIndex = Math.floor((chargedBeforeUsd + 1e-9) / SHOPIFY_MIN_USAGE_AMOUNT_USD) + 1;
    const batchGroupKey = `${shop}:${cycleId}:${recipientCountryCode}:batch:${batchIndex}`;
    const idempotencyKey = `orderx:usage-batch:${shop}:${cycleId}:${recipientCountryCode}:${batchIndex}:${chargeAmount.toFixed(2)}`;
    const carryBeforeUsd = outstandingUsd;

    const quantity = Math.max(
      1,
      Math.ceil(chargeAmount / Math.max(messageBasisUsd, 0.0001)),
    );
    const batchDescription = buildDescription({
      kind,
      orderGid,
      attemptId,
      recipientCountryCode,
      chargeAmount,
      quantity,
    });

    const pendingRow = await BillingUsageCharge.findOneAndUpdate(
      { shop, waMessageId: messageId },
      {
        $set: {
          status: "pending",
          quantity,
          amount: chargeAmount,
          pricingBasisUsd: messageBasisUsd,
          currencyCode: String(plan?.usagePrice?.currencyCode || "USD").trim() || "USD",
          billingStrategy: "threshold_batch",
          batchGroupKey,
          idempotencyKey,
          description: batchDescription,
          carryBeforeUsd,
          carryAfterUsd,
          error: null,
          errorAt: null,
        },
      },
      { new: true },
    ).lean();

    await updateWaMessageUsageLog({
      shop,
      waMessageId: messageId,
      recipientCountryCode: pricing?.recipientCountryCode || null,
      storeCountryCode: pricing?.storeCountryCode || null,
      crossBorderRateApplied: !!pricing?.crossBorderRateApplied,
      usagePricingBasisUsd: messageBasisUsd,
      usageChargeUsd: chargeAmount,
      usageChargeState: "pending",
      usageBillingStrategy: "threshold_batch",
      usageBatchGroupKey: batchGroupKey,
      capUnitsConsumed: Number(pricing?.capUnitsConsumed || 1),
    });

    try {
      const submitResult = await submitPendingUsageRow({
        shop,
        accessToken: record.accessToken,
        subscriptionLineItemId,
        row: pendingRow,
      });

      if (!submitResult?.ok) {
        return submitResult;
      }
      const usageRecordId = submitResult.usageRecordId;

      try {
        await applySubmittedChargeSideEffects({
          shop,
          record,
          plan,
          amount: chargeAmount,
          currencyCode: pendingRow.currencyCode,
          billingChargeId: pendingRow._id,
          auditMeta: {
            planKey: plan.key,
            waMessageId: messageId,
            usageRecordId,
            amount: chargeAmount,
            currencyCode: pendingRow.currencyCode,
            billingCycleId: cycleId,
            recipientCountryCode: pricing?.recipientCountryCode || null,
            storeCountryCode: pricing?.storeCountryCode || null,
            capUnitsConsumed: Number(pricing?.capUnitsConsumed || 1),
            billingStrategy: "threshold_batch",
            batchGroupKey,
            pricingBasisUsd: messageBasisUsd,
          },
        });
    } catch (sideEffectError) {
      console.warn(
        "[shopify_usage_charge_side_effect_failed]",
        shop,
        messageId,
        sideEffectError?.message || sideEffectError,
      );
      await recalculateShopUsageBalance({
        shop,
        billing: record?.billing || null,
        now: new Date(),
      }).catch(() => {});
    }

      return { ok: true, usageRecordId, batchGroupKey };
    } catch (error) {
      const message = error?.message || "Failed to create Shopify usage record";
      const classified = classifyUsageRecordError(error);
      if (!isCapExceededError(message) && classified?.retryable) {
        const nextRetryAt = new Date(
          Date.now() +
            usageRetryDelayMs({
              retryCount: Number(pendingRow?.retryCount || 0) + 1,
              retryAfterMs: classified?.retryAfterMs || null,
              error,
            }),
        );
        return markUsageChargeRetryScheduled({
          row: pendingRow,
          error,
          nextRetryAt,
        });
      }
      const nextStatus = isCapExceededError(message) ? "skipped" : "failed";
      await BillingUsageCharge.updateOne(
        { shop, waMessageId: messageId },
        {
          $set: {
            status: nextStatus,
            amount: nextStatus === "skipped" ? 0 : chargeAmount,
            error: message,
            errorAt: new Date(),
          },
        },
      );
      await updateWaMessageUsageLog({
        shop,
        waMessageId: messageId,
        recipientCountryCode: pricing?.recipientCountryCode || null,
        storeCountryCode: pricing?.storeCountryCode || null,
        crossBorderRateApplied: !!pricing?.crossBorderRateApplied,
        usagePricingBasisUsd: messageBasisUsd,
        usageChargeUsd: nextStatus === "skipped" ? 0 : chargeAmount,
        usageChargeState: nextStatus,
        usageBillingStrategy: "threshold_batch",
        usageBatchGroupKey: batchGroupKey,
        capUnitsConsumed: Number(pricing?.capUnitsConsumed || 1),
      });
      void logAudit({
        shop,
        actor: "system",
        action: "shopify_usage_charge_failed",
        level: nextStatus === "skipped" ? "warning" : "error",
        message,
        meta: {
          planKey: plan.key,
          waMessageId: messageId,
          billingCycleId: cycleId,
          recipientCountryCode: pricing?.recipientCountryCode || null,
          billingStrategy: "threshold_batch",
          batchGroupKey,
        },
      });
      return {
        ok: false,
        skipped: nextStatus === "skipped",
        reason: nextStatus === "skipped" ? "cap_reached" : "shopify_usage_error",
        error: message,
      };
    }
  });
}

export async function recordGrowthUsageMessage({
  shop,
  waMessageId,
  attemptId = null,
  orderGid = null,
  kind = "",
  toE164 = "",
  recipientCountryCode = "",
  senderMode = SENDER_MODES.ORDERX_NUMBER,
}) {
  const shopDomain = String(shop || "").trim();
  const messageId = String(waMessageId || "").trim();
  const normalizedSenderMode = String(senderMode || "").trim();
  if (!shopDomain || !messageId) {
    return { ok: false, skipped: true, reason: "missing_shop_or_message_id" };
  }
  if (normalizedSenderMode !== SENDER_MODES.ORDERX_NUMBER) {
    return { ok: false, skipped: true, reason: "sender_not_metered" };
  }

  const record = await Shop.findOne({ shop: shopDomain })
    .select({ accessToken: 1, billing: 1, storeCountryCode: 1 })
    .lean();
  if (!record) {
    return { ok: false, skipped: true, reason: "missing_access_token" };
  }

  const plan = getPlan(record?.billing?.planKey);
  if (
    plan?.key !== PLAN_KEYS.ORDERX_METERED_4 ||
    String(plan?.billingType || "").trim() !== PLAN_BILLING_TYPES.SHOPIFY_METERED
  ) {
    return { ok: false, skipped: true, reason: "plan_not_metered" };
  }

  const subscriptionLineItemId = String(
    record?.billing?.usageSubscriptionLineItemId || "",
  ).trim();
  if (!subscriptionLineItemId) {
    return { ok: false, skipped: true, reason: "missing_usage_line_item" };
  }

  const pendingBatchResume = await resumeAnyPendingThresholdBatch({
    shop: shopDomain,
    accessToken: record.accessToken,
    subscriptionLineItemId,
    record,
    plan,
  });
  if (pendingBatchResume?.ok === false) {
    return pendingBatchResume;
  }

  const pricing = await resolveGrowthMessagePricing({
    shop: shopDomain,
    toE164,
    recipientCountryCode,
    storeCountryCode: record?.storeCountryCode,
  });
  const pricingBasisUsd = roundCurrency(Number(pricing?.recipientRateUsd || 0), 4);
  const currencyCode = String(plan?.usagePrice?.currencyCode || "USD").trim() || "USD";
  if (pricingBasisUsd <= 0) {
    return { ok: false, skipped: true, reason: "missing_usage_price" };
  }

  if (shouldUseThresholdBatch(pricingBasisUsd)) {
    return recordThresholdBatchedGrowthUsageMessage({
      shop: shopDomain,
      record,
      plan,
      messageId,
      attemptId,
      orderGid,
      kind,
      pricing,
      subscriptionLineItemId,
    });
  }

  const { cycleId, startAt, endAt } = resolveCycleContext(record?.billing || {}, plan);
  const existing = await BillingUsageCharge.findOne({
    shop: shopDomain,
    waMessageId: messageId,
  }).lean();
  if (existing && isAlreadyProcessedStatus(existing.status)) {
    return buildExistingResult(existing);
  }

  const cycleLedger = await aggregateCycleUsageLedger({
    shop: shopDomain,
    billingCycleId: cycleId,
  });
  const capAmount = roundCurrency(
    Number(record?.billing?.usageCappedAmount || plan?.usageCappedAmount?.amount || 0),
    2,
  );
  if (capAmount > 0 && cycleLedger.accruedUsd + pricingBasisUsd > capAmount + 1e-9) {
    await BillingUsageCharge.findOneAndUpdate(
      { shop: shopDomain, waMessageId: messageId },
      {
        $setOnInsert: {
          shop: shopDomain,
          planKey: plan.key,
          subscriptionId: record?.billing?.subscriptionId || null,
          subscriptionLineItemId,
          billingCycleId: cycleId,
          billingCycleStartedAt: startAt,
          billingCycleEndsAt: endAt,
          waMessageId: messageId,
          attemptId: attemptId || null,
          orderGid: orderGid || null,
          quantity: 1,
          amount: 0,
          pricingBasisUsd,
          currencyCode,
          recipientCountryCode: pricing?.recipientCountryCode || null,
          storeCountryCode: pricing?.storeCountryCode || null,
          crossBorderRateApplied: !!pricing?.crossBorderRateApplied,
          capUnitsConsumed: Number(pricing?.capUnitsConsumed || 1),
          billingStrategy: "per_message",
          description: buildDescription({ kind, orderGid, attemptId }),
          idempotencyKey: `orderx:${shopDomain}:${messageId}`,
        },
        $set: {
          status: "skipped",
          error: "Growth usage cap reached before recording the next message.",
          errorAt: new Date(),
        },
      },
      { upsert: true, new: true },
    );
    await updateWaMessageUsageLog({
      shop: shopDomain,
      waMessageId: messageId,
      recipientCountryCode: pricing?.recipientCountryCode || null,
      storeCountryCode: pricing?.storeCountryCode || null,
      crossBorderRateApplied: !!pricing?.crossBorderRateApplied,
      usagePricingBasisUsd: pricingBasisUsd,
      usageChargeUsd: 0,
      usageChargeState: "skipped",
      usageBillingStrategy: "per_message",
      usageBatchGroupKey: null,
      capUnitsConsumed: Number(pricing?.capUnitsConsumed || 1),
    });
    return { ok: false, skipped: true, reason: "cap_reached" };
  }

  const description = buildDescription({ kind, orderGid, attemptId });
  const idempotencyKey = `orderx:${shopDomain}:${messageId}`;
  const pendingRow = await BillingUsageCharge.findOneAndUpdate(
    { shop: shopDomain, waMessageId: messageId },
    {
      $setOnInsert: {
        shop: shopDomain,
        planKey: plan.key,
        subscriptionId: record?.billing?.subscriptionId || null,
        subscriptionLineItemId,
        billingCycleId: cycleId,
        billingCycleStartedAt: startAt,
        billingCycleEndsAt: endAt,
        waMessageId: messageId,
        attemptId: attemptId || null,
        orderGid: orderGid || null,
        quantity: 1,
        amount: roundCurrency(pricingBasisUsd, 4),
        pricingBasisUsd,
        currencyCode,
        recipientCountryCode: pricing?.recipientCountryCode || null,
        storeCountryCode: pricing?.storeCountryCode || null,
        crossBorderRateApplied: !!pricing?.crossBorderRateApplied,
        capUnitsConsumed: Number(pricing?.capUnitsConsumed || 1),
        billingStrategy: "per_message",
        description,
        idempotencyKey,
      },
      $set: {
        status: "pending",
        error: null,
        errorAt: null,
      },
    },
    { upsert: true, new: true },
  ).lean();

  await updateWaMessageUsageLog({
    shop: shopDomain,
    waMessageId: messageId,
    recipientCountryCode: pricing?.recipientCountryCode || null,
    storeCountryCode: pricing?.storeCountryCode || null,
    crossBorderRateApplied: !!pricing?.crossBorderRateApplied,
    usagePricingBasisUsd: pricingBasisUsd,
    usageChargeUsd: pricingBasisUsd,
    usageChargeState: "pending",
    usageBillingStrategy: "per_message",
    usageBatchGroupKey: null,
    capUnitsConsumed: Number(pricing?.capUnitsConsumed || 1),
  });

  try {
    const submitResult = await submitPendingUsageRow({
      shop: shopDomain,
      accessToken: record.accessToken,
      subscriptionLineItemId,
      row: pendingRow,
    });

    if (!submitResult?.ok) {
      return submitResult;
    }
    const usageRecordId = submitResult.usageRecordId;

    try {
      await applySubmittedChargeSideEffects({
        shop: shopDomain,
        record,
        plan,
        amount: pricingBasisUsd,
        currencyCode,
        billingChargeId: pendingRow._id,
        auditMeta: {
          planKey: plan.key,
          waMessageId: messageId,
          usageRecordId,
          amount: pricingBasisUsd,
          currencyCode,
          billingCycleId: cycleId,
          recipientCountryCode: pricing?.recipientCountryCode || null,
          storeCountryCode: pricing?.storeCountryCode || null,
          capUnitsConsumed: Number(pricing?.capUnitsConsumed || 1),
          billingStrategy: "per_message",
        },
      });
    } catch (sideEffectError) {
      console.warn(
        "[shopify_usage_charge_side_effect_failed]",
        shopDomain,
        messageId,
        sideEffectError?.message || sideEffectError,
      );
      await recalculateShopUsageBalance({
        shop: shopDomain,
        billing: record?.billing || null,
        now: new Date(),
      }).catch(() => {});
    }

    return { ok: true, usageRecordId };
  } catch (error) {
    const message = error?.message || "Failed to create Shopify usage record";
    const classified = classifyUsageRecordError(error);
    if (!isCapExceededError(message) && classified?.retryable) {
      const nextRetryAt = new Date(
        Date.now() +
          usageRetryDelayMs({
            retryCount: Number(pendingRow?.retryCount || 0) + 1,
            retryAfterMs: classified?.retryAfterMs || null,
            error,
          }),
      );
      return markUsageChargeRetryScheduled({
        row: pendingRow,
        error,
        nextRetryAt,
      });
    }
    const nextStatus = isCapExceededError(message) ? "skipped" : "failed";
    await BillingUsageCharge.updateOne(
      { shop: shopDomain, waMessageId: messageId },
      {
        $set: {
          status: nextStatus,
          amount: nextStatus === "skipped" ? 0 : pricingBasisUsd,
          error: message,
          errorAt: new Date(),
        },
      },
    );
    await updateWaMessageUsageLog({
      shop: shopDomain,
      waMessageId: messageId,
      recipientCountryCode: pricing?.recipientCountryCode || null,
      storeCountryCode: pricing?.storeCountryCode || null,
      crossBorderRateApplied: !!pricing?.crossBorderRateApplied,
      usagePricingBasisUsd: pricingBasisUsd,
      usageChargeUsd: nextStatus === "skipped" ? 0 : pricingBasisUsd,
      usageChargeState: nextStatus,
      usageBillingStrategy: "per_message",
      usageBatchGroupKey: null,
      capUnitsConsumed: Number(pricing?.capUnitsConsumed || 1),
    });
    void logAudit({
      shop: shopDomain,
      actor: "system",
      action: "shopify_usage_charge_failed",
      level: nextStatus === "skipped" ? "warning" : "error",
      message,
      meta: {
        planKey: plan.key,
        waMessageId: messageId,
        billingCycleId: cycleId,
        recipientCountryCode: pricing?.recipientCountryCode || null,
        billingStrategy: "per_message",
      },
    });
    return {
      ok: false,
      skipped: nextStatus === "skipped",
      reason: nextStatus === "skipped" ? "cap_reached" : "shopify_usage_error",
      error: message,
    };
  }
}

export async function recordOwnNumberOverageMessage({
  shop,
  waMessageId,
  attemptId = null,
  orderGid = null,
  kind = "",
  senderMode = SENDER_MODES.OWN_NUMBER,
}) {
  const shopDomain = String(shop || "").trim();
  const messageId = String(waMessageId || "").trim();
  const normalizedSenderMode = String(senderMode || "").trim();
  if (!shopDomain || !messageId) {
    return { ok: false, skipped: true, reason: "missing_shop_or_message_id" };
  }
  if (normalizedSenderMode !== SENDER_MODES.OWN_NUMBER) {
    return { ok: false, skipped: true, reason: "sender_not_byon" };
  }

  const record = await Shop.findOne({ shop: shopDomain })
    .select({ accessToken: 1, billing: 1 })
    .lean();
  if (!record) {
    return { ok: false, skipped: true, reason: "missing_access_token" };
  }

  const plan = getPlan(record?.billing?.planKey);
  if (String(plan?.senderMode || "").trim() !== SENDER_MODES.OWN_NUMBER) {
    return { ok: false, skipped: true, reason: "plan_not_byon" };
  }

  const includedCap = resolveOwnNumberIncludedCap(plan);
  const overageRateUsd = resolveOwnNumberOverageRate(plan);
  if (includedCap == null || overageRateUsd <= 0) {
    return { ok: true, skipped: true, reason: "no_overage_billing" };
  }

  const { cycleId, startAt, endAt } = resolveCycleContext(record?.billing || {}, plan);
  const outboundCount = Number(
    await WaMessageLog.countDocuments({
      shop: shopDomain,
      direction: "outbound",
      senderMode: SENDER_MODES.OWN_NUMBER,
      createdAt: {
        $gte: startAt,
        $lt: endAt,
      },
    }),
  );

  if (outboundCount <= includedCap) {
    await updateWaMessageUsageLog({
      shop: shopDomain,
      waMessageId: messageId,
      usagePricingBasisUsd: overageRateUsd,
      usageChargeUsd: 0,
      usageChargeState: "included",
      usageBillingStrategy: "per_message",
      usageBatchGroupKey: null,
      capUnitsConsumed: 1,
    });
    return {
      ok: true,
      skipped: true,
      reason: "included_message",
      outboundCount,
      includedCap,
    };
  }

  const subscriptionLineItemId = String(
    record?.billing?.usageSubscriptionLineItemId || "",
  ).trim();
  if (!subscriptionLineItemId) {
    await updateWaMessageUsageLog({
      shop: shopDomain,
      waMessageId: messageId,
      usagePricingBasisUsd: overageRateUsd,
      usageChargeUsd: 0,
      usageChargeState: "blocked",
      usageBillingStrategy: "per_message",
      usageBatchGroupKey: null,
      capUnitsConsumed: 1,
    });
    return {
      ok: false,
      skipped: true,
      reason: "missing_usage_line_item",
      outboundCount,
      includedCap,
    };
  }

  const existing = await BillingUsageCharge.findOne({
    shop: shopDomain,
    waMessageId: messageId,
  }).lean();
  if (existing && isAlreadyProcessedStatus(existing.status)) {
    return buildExistingResult(existing);
  }

  const cycleLedger = await aggregateCycleUsageLedger({
    shop: shopDomain,
    billingCycleId: cycleId,
  });
  const capAmount = roundCurrency(
    Number(
      record?.billing?.usageCappedAmount || plan?.usageCappedAmount?.amount || 0,
    ),
    2,
  );
  if (capAmount > 0 && cycleLedger.accruedUsd + overageRateUsd > capAmount + 1e-9) {
    await BillingUsageCharge.findOneAndUpdate(
      { shop: shopDomain, waMessageId: messageId },
      {
        $setOnInsert: {
          shop: shopDomain,
          planKey: plan.key,
          subscriptionId: record?.billing?.subscriptionId || null,
          subscriptionLineItemId,
          billingCycleId: cycleId,
          billingCycleStartedAt: startAt,
          billingCycleEndsAt: endAt,
          waMessageId: messageId,
          attemptId: attemptId || null,
          orderGid: orderGid || null,
          quantity: 1,
          amount: 0,
          pricingBasisUsd: overageRateUsd,
          currencyCode: String(plan?.usagePrice?.currencyCode || "USD").trim() || "USD",
          recipientCountryCode: null,
          storeCountryCode: null,
          crossBorderRateApplied: false,
          capUnitsConsumed: 1,
          billingStrategy: "per_message",
          description: buildDescription({ kind, orderGid, attemptId }),
          idempotencyKey: `orderx:byon:${shopDomain}:${messageId}`,
        },
        $set: {
          status: "skipped",
          error: "BYON overage usage cap reached before recording the next message.",
          errorAt: new Date(),
        },
      },
      { upsert: true, new: true },
    );
    await updateWaMessageUsageLog({
      shop: shopDomain,
      waMessageId: messageId,
      usagePricingBasisUsd: overageRateUsd,
      usageChargeUsd: 0,
      usageChargeState: "skipped",
      usageBillingStrategy: "per_message",
      usageBatchGroupKey: null,
      capUnitsConsumed: 1,
    });
    return { ok: false, skipped: true, reason: "cap_reached" };
  }

  const pendingRow = await BillingUsageCharge.findOneAndUpdate(
    { shop: shopDomain, waMessageId: messageId },
    {
      $setOnInsert: {
        shop: shopDomain,
        planKey: plan.key,
        subscriptionId: record?.billing?.subscriptionId || null,
        subscriptionLineItemId,
        billingCycleId: cycleId,
        billingCycleStartedAt: startAt,
        billingCycleEndsAt: endAt,
        waMessageId: messageId,
        attemptId: attemptId || null,
        orderGid: orderGid || null,
        quantity: 1,
        amount: roundCurrency(overageRateUsd, 2),
        pricingBasisUsd: overageRateUsd,
        currencyCode: String(plan?.usagePrice?.currencyCode || "USD").trim() || "USD",
        recipientCountryCode: null,
        storeCountryCode: null,
        crossBorderRateApplied: false,
        capUnitsConsumed: 1,
        billingStrategy: "per_message",
        description: buildDescription({ kind, orderGid, attemptId }),
        idempotencyKey: `orderx:byon:${shopDomain}:${messageId}`,
      },
      $set: {
        status: "pending",
        error: null,
        errorAt: null,
      },
    },
    { upsert: true, new: true },
  ).lean();

  await updateWaMessageUsageLog({
    shop: shopDomain,
    waMessageId: messageId,
    usagePricingBasisUsd: overageRateUsd,
    usageChargeUsd: overageRateUsd,
    usageChargeState: "pending",
    usageBillingStrategy: "per_message",
    usageBatchGroupKey: null,
    capUnitsConsumed: 1,
  });

  try {
    const submitResult = await submitPendingUsageRow({
      shop: shopDomain,
      accessToken: record.accessToken,
      subscriptionLineItemId,
      row: pendingRow,
    });

    if (!submitResult?.ok) {
      return submitResult;
    }
    const usageRecordId = submitResult.usageRecordId;

    try {
      await applySubmittedChargeSideEffects({
        shop: shopDomain,
        record,
        plan,
        amount: overageRateUsd,
        currencyCode: pendingRow.currencyCode,
        billingChargeId: pendingRow._id,
        auditMeta: {
          planKey: plan.key,
          waMessageId: messageId,
          usageRecordId,
          amount: overageRateUsd,
          currencyCode: pendingRow.currencyCode,
          billingCycleId: cycleId,
          billingStrategy: "per_message",
          includedCap,
          outboundCount,
        },
      });
    } catch (sideEffectError) {
      console.warn(
        "[shopify_usage_charge_side_effect_failed]",
        shopDomain,
        messageId,
        sideEffectError?.message || sideEffectError,
      );
      await recalculateShopUsageBalance({
        shop: shopDomain,
        billing: record?.billing || null,
        now: new Date(),
      }).catch(() => {});
    }

    return { ok: true, usageRecordId, outboundCount, includedCap };
  } catch (error) {
    const message = error?.message || "Failed to create Shopify usage record";
    const classified = classifyUsageRecordError(error);
    if (!isCapExceededError(message) && classified?.retryable) {
      const nextRetryAt = new Date(
        Date.now() +
          usageRetryDelayMs({
            retryCount: Number(pendingRow?.retryCount || 0) + 1,
            retryAfterMs: classified?.retryAfterMs || null,
            error,
          }),
      );
      return markUsageChargeRetryScheduled({
        row: pendingRow,
        error,
        nextRetryAt,
      });
    }
    const nextStatus = isCapExceededError(message) ? "skipped" : "failed";
    await BillingUsageCharge.updateOne(
      { shop: shopDomain, waMessageId: messageId },
      {
        $set: {
          status: nextStatus,
          amount: nextStatus === "skipped" ? 0 : roundCurrency(overageRateUsd, 2),
          error: message,
          errorAt: new Date(),
        },
      },
    );
    await updateWaMessageUsageLog({
      shop: shopDomain,
      waMessageId: messageId,
      usagePricingBasisUsd: overageRateUsd,
      usageChargeUsd: nextStatus === "skipped" ? 0 : overageRateUsd,
      usageChargeState: nextStatus,
      usageBillingStrategy: "per_message",
      usageBatchGroupKey: null,
      capUnitsConsumed: 1,
    });
    void logAudit({
      shop: shopDomain,
      actor: "system",
      action: "shopify_usage_charge_failed",
      level: nextStatus === "skipped" ? "warning" : "error",
      message,
      meta: {
        planKey: plan.key,
        waMessageId: messageId,
        billingCycleId: cycleId,
        billingStrategy: "per_message",
        includedCap,
        outboundCount,
      },
    });
    return {
      ok: false,
      skipped: nextStatus === "skipped",
      reason: nextStatus === "skipped" ? "cap_reached" : "shopify_usage_error",
      error: message,
    };
  }
}

export const recordByonOverageMessage = recordOwnNumberOverageMessage;

export async function requestGrowthUsageCapIncrease({ shop, cappedAmount }) {
  const shopDomain = String(shop || "").trim();
  const nextCappedAmount = roundCurrency(cappedAmount);
  if (!shopDomain || nextCappedAmount <= 0) {
    throw new Error("Missing shop or capped amount");
  }

  const record = await Shop.findOne({ shop: shopDomain })
    .select({ accessToken: 1, billing: 1 })
    .lean();
  if (!record) {
    throw new Error("Missing shop access token");
  }

  const plan = getPlan(record?.billing?.planKey);
  if (
    plan?.key !== PLAN_KEYS.ORDERX_METERED_4 ||
    String(plan?.billingType || "").trim() !== PLAN_BILLING_TYPES.SHOPIFY_METERED
  ) {
    throw new Error(
      "Growth usage cap can only be updated on the active OrderX Growth plan",
    );
  }

  const currencyCode = String(
    record?.billing?.usageCappedCurrencyCode ||
      plan?.usageCappedAmount?.currencyCode ||
      "USD",
  ).trim();
  const lineItemId = String(record?.billing?.usageSubscriptionLineItemId || "").trim();
  if (!lineItemId) {
    throw new Error("Missing Shopify usage line item");
  }
  const admin = await getAdminClient(shopDomain, record.accessToken);
  const mutation = `#graphql
    mutation AppSubscriptionLineItemUpdate(
      $id: ID!
      $cappedAmount: MoneyInput!
    ) {
      appSubscriptionLineItemUpdate(
        id: $id
        cappedAmount: $cappedAmount
      ) {
        confirmationUrl
        userErrors {
          field
          message
        }
      }
    }
  `;

  const out = await admin.query({
    data: {
      query: mutation,
      variables: {
        id: lineItemId,
        cappedAmount: {
          amount: nextCappedAmount,
          currencyCode,
        },
      },
    },
  });

  const payload = out?.body?.data?.appSubscriptionLineItemUpdate || {};
  const userErrors = Array.isArray(payload?.userErrors) ? payload.userErrors : [];
  if (userErrors.length) {
    const msg = userErrors
      .map((item) => String(item?.message || "").trim())
      .filter(Boolean)
      .join(" | ");
    throw new Error(msg || "Failed to update Shopify usage cap");
  }

  return {
    ok: true,
    confirmationUrl: String(payload?.confirmationUrl || "").trim() || null,
    cappedAmount: nextCappedAmount,
    currencyCode,
  };
}

export async function chargeBillableConfirmation(args) {
  return recordGrowthUsageMessage(args);
}

async function recalculateShopUsageBalance({ shop, billing = null, now = new Date() }) {
  const shopDomain = String(shop || "").trim();
  if (!shopDomain) return null;
  const currentBilling = billing || (await Shop.findOne({ shop: shopDomain }).select({ billing: 1 }).lean())?.billing || {};
  const plan = getPlan(currentBilling?.planKey);
  const cycleWindow = resolveBillingCycleWindow(
    {
      ...currentBilling,
      plan,
    },
    now,
  );
  const startAt = cycleWindow?.startAt || currentBilling?.currentPeriodStart || null;
  const endAt = cycleWindow?.endAt || currentBilling?.currentPeriodEnd || null;
  const match = {
    shop: shopDomain,
    planKey: currentBilling?.planKey || plan?.key || null,
    status: { $in: ["submitted", "settled"] },
  };
  if (startAt || endAt) {
    match.createdAt = {};
    if (startAt) match.createdAt.$gte = startAt;
    if (endAt) match.createdAt.$lt = endAt;
  }

  const rows = await BillingUsageCharge.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalAmount: { $sum: { $ifNull: ["$amount", 0] } },
      },
    },
  ]);
  const totalAmount = roundCurrency(rows?.[0]?.totalAmount || 0, 2);
  const currencyCode =
    String(
      currentBilling?.usageBalanceUsedCurrencyCode ||
        plan?.usagePrice?.currencyCode ||
        "USD",
    ).trim() || "USD";

  await Shop.updateOne(
    { shop: shopDomain },
    {
      $set: {
        "billing.usageBalanceUsedAmount": totalAmount,
        "billing.usageBalanceUsedCurrencyCode": currencyCode,
      },
    },
  ).catch(() => {});

  return {
    ok: true,
    shop: shopDomain,
    totalAmount,
    currencyCode,
    cycleStart: startAt || null,
    cycleEnd: endAt || null,
  };
}

async function processUsageChargeRow({ row, now = new Date() }) {
  if (!row?._id || !row?.shop) {
    return { ok: false, skipped: true, reason: "missing_row" };
  }
  const rowStatus = String(row?.status || "").trim();
  const hasRetryWindow =
    rowStatus === "pending" &&
    (!row?.nextRetryAt || new Date(row.nextRetryAt).getTime() <= now.getTime());
  const retryableFailedRow =
    rowStatus === "failed" &&
    Number(row?.retryCount || 0) < USAGE_CHARGE_RETRY_LIMIT &&
    classifyUsageRecordError({ message: row?.error || "" }).retryable;
  if (!hasRetryWindow && !retryableFailedRow) {
    return { ok: true, skipped: true, reason: "not_due" };
  }

  const shopRecord = await Shop.findOne({ shop: row.shop })
    .select({
      accessToken: 1,
      billing: 1,
      storeCountryCode: 1,
    })
    .lean();
  if (!shopRecord || !row?.subscriptionLineItemId) {
    return {
      ok: false,
      skipped: true,
      reason: "missing_access_token_or_line_item",
    };
  }

  const submitResult = await submitPendingUsageRow({
    shop: row.shop,
    accessToken: shopRecord.accessToken,
    subscriptionLineItemId: row.subscriptionLineItemId,
    row,
  });

  if (!submitResult?.ok) {
    return submitResult;
  }

  try {
    const plan = getPlan(shopRecord?.billing?.planKey);
    await applySubmittedChargeSideEffects({
      shop: row.shop,
      record: shopRecord,
      plan,
      amount: row.amount,
      currencyCode: row.currencyCode,
      billingChargeId: row._id,
      auditMeta: {
        planKey: plan?.key || row.planKey || null,
        waMessageId: row.waMessageId,
        usageRecordId: submitResult.usageRecordId,
        amount: row.amount,
        currencyCode: row.currencyCode,
        billingCycleId: row.billingCycleId,
        recipientCountryCode: row.recipientCountryCode || null,
        storeCountryCode: row.storeCountryCode || null,
        capUnitsConsumed: Number(row.capUnitsConsumed || 1),
        billingStrategy: row.billingStrategy || "per_message",
        batchGroupKey: row.batchGroupKey || null,
      },
    });
  } catch (sideEffectError) {
    console.warn(
      "[shopify_usage_charge_side_effect_failed]",
      row.shop,
      row?.waMessageId || "",
      sideEffectError?.message || sideEffectError,
    );
    await recalculateShopUsageBalance({
      shop: row.shop,
      billing: shopRecord?.billing || null,
      now,
    }).catch(() => {});
  }

  return submitResult;
}

export async function reconcilePendingShopifyUsageCharges({ now = new Date(), limit = 100 } = {}) {
  const dueRows = await BillingUsageCharge.find({
    $or: [
      {
        status: "pending",
        $or: [
          { nextRetryAt: { $exists: false } },
          { nextRetryAt: null },
          { nextRetryAt: { $lte: now } },
        ],
      },
      {
        status: "failed",
        retryCount: { $lt: USAGE_CHARGE_RETRY_LIMIT },
      },
    ],
  })
    .sort({ updatedAt: 1, createdAt: 1 })
    .limit(Math.max(1, Number(limit || 100)))
    .lean();

  const results = [];
  for (const row of dueRows) {
    try {
      const result = await processUsageChargeRow({ row, now });
      results.push({
        shop: row.shop,
        waMessageId: row.waMessageId,
        ...result,
      });
    } catch (error) {
      const message = error?.message || "Failed to reconcile Shopify usage charge";
      console.error("[reconcile_pending_usage_charge]", row.shop, row.waMessageId, message);
      results.push({
        shop: row.shop,
        waMessageId: row.waMessageId,
        ok: false,
        error: message,
      });
    }
  }

  return {
    ok: true,
    scanned: dueRows.length,
    results,
  };
}

export async function reconcileShopifyUsageBalances({ now = new Date(), limit = 200 } = {}) {
  const shops = await Shop.find(buildShopifyCredentialCandidateQuery())
    .sort({ updatedAt: -1 })
    .limit(Math.max(1, Number(limit || 200)))
    .select({ shop: 1, billing: 1 })
    .lean();

  const results = [];
  for (const shopRecord of shops) {
    try {
      const result = await recalculateShopUsageBalance({
        shop: shopRecord.shop,
        billing: shopRecord.billing || null,
        now,
      });
      results.push(result);
    } catch (error) {
      const message = error?.message || "Failed to reconcile usage balance";
      console.error("[reconcile_usage_balance]", shopRecord.shop, message);
      results.push({
        ok: false,
        shop: shopRecord.shop,
        error: message,
      });
    }
  }

  return {
    ok: true,
    scanned: shops.length,
    results,
  };
}
