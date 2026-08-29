import Shop from "../models/Shop.js";
import {
  BYON_TRIAL_DAYS,
  BYON_TRIAL_MESSAGE_CAP,
  getPlan,
  getPlansForClient,
  PLAN_BILLING_TYPES,
  PLAN_KEYS,
  SENDER_MODES,
  TRIAL_DAYS,
} from "./plans.js";
import { getStorePricingContext } from "./countryPricing.js";

const TRIAL_MESSAGE_CAP = (() => {
  const value = Number(process.env.TRIAL_MESSAGE_CAP);
  return Number.isFinite(value) && value > 0 ? value : 10;
})();
const FREE_CONFIRMATION_CAP = (() => {
  const value = Number(process.env.BILLING_ORDERX_FREE_CONFIRMATION_CAP);
  return Number.isFinite(value) && value > 0 ? value : 10;
})();
const BILLING_CYCLE_DAYS = 30;

function now() {
  return new Date();
}

function toValidDate(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function isByonFreeTrialPlan(plan) {
  return (
    String(plan?.senderMode || "").trim() === SENDER_MODES.OWN_NUMBER &&
    String(plan?.billingType || "").trim() === PLAN_BILLING_TYPES.FREE_CAP
  );
}

function resolveTrialDays(plan) {
  const value = Number(plan?.trialDays || 0);
  return Number.isFinite(value) && value > 0 ? value : TRIAL_DAYS;
}

function resolveTrialMessageCap(plan) {
  const value = Number(
    plan?.trialMessageCap || plan?.outboundMessageCap || plan?.templateMessageCap || 0,
  );
  return Number.isFinite(value) && value > 0 ? value : TRIAL_MESSAGE_CAP;
}

export function resolveRecurringCycleWindow(
  billing = {},
  referenceDate = new Date(),
  options = {},
) {
  const reference =
    referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  if (!Number.isFinite(reference.getTime())) return null;

  let startAt = toValidDate(billing?.currentPeriodStart);
  let endAt = toValidDate(billing?.currentPeriodEnd);
  const fallbackStart = toValidDate(options?.fallbackStart);
  const anchorAt =
    toValidDate(billing?.cycleAnchorAt) || startAt || fallbackStart;

  if (!startAt && endAt) {
    startAt = addDays(endAt, -BILLING_CYCLE_DAYS);
  } else if (startAt && !endAt) {
    endAt = addDays(startAt, BILLING_CYCLE_DAYS);
  } else if (!startAt && !endAt && anchorAt) {
    startAt = anchorAt;
    endAt = addDays(startAt, BILLING_CYCLE_DAYS);
  }

  if (!startAt) return null;
  if (!endAt || endAt <= startAt) {
    endAt = addDays(startAt, BILLING_CYCLE_DAYS);
  }

  if (options?.rollForward !== false) {
    while (reference >= endAt) {
      startAt = endAt;
      endAt = addDays(startAt, BILLING_CYCLE_DAYS);
    }
  }

  if (options?.rollBackward === true) {
    while (reference < startAt) {
      endAt = startAt;
      startAt = addDays(startAt, -BILLING_CYCLE_DAYS);
    }
  }

  return {
    startAt,
    endAt,
    anchorAt: anchorAt || startAt,
  };
}

/**
 * Billing status source of truth (Mongo-stored).
 *
 * We treat a shop as active ONLY if:
 * - TRIAL and not expired, OR
 * - ACTIVE and within its current cycle (Shopify subscription, rolling free cycle, or legacy no-expiry state)
 *
 * This lets you hard-block sending WhatsApp if not paid.
 */
export async function getBillingStatus(shop) {
  const s = await Shop.findOne({ shop }).lean();
  if (!s) {
    const plan = getPlan(PLAN_KEYS.ORDERX_FREE_5);
    const regionalPricing = await getStorePricingContext({});
    return {
      active: false,
      status: "NONE",
      planKey: PLAN_KEYS.ORDERX_FREE_5,
      plan,
      plans: getPlansForClient(),
      storeCountryCode: regionalPricing.storeCountryCode,
      storeCountryName: regionalPricing.storeCountryName,
      storeCurrencyCode: null,
      regionalPricing,
      trialEndsAt: null,
      trialStartedAt: null,
      trialUsed: false,
      subscriptionId: null,
      subscriptionTest: false,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cycleAnchorAt: null,
      cancelAtPeriodEnd: false,
      cancelledAt: null,
      lastCheckedAt: null,
      trialMessagesUsed: 0,
      trialMessageCap: TRIAL_MESSAGE_CAP,
      byonTrialUsed: false,
      byonTrialStartedAt: null,
      byonTrialEndsAt: null,
      byonTrialMessagesUsed: 0,
      byonTrialMessageCap: BYON_TRIAL_MESSAGE_CAP,
      freeConfirmationMessagesUsed: 0,
      freeConfirmationCap: FREE_CONFIRMATION_CAP,
      usageSubscriptionLineItemId: null,
      usageCappedAmount: null,
      usageCappedCurrencyCode: null,
      usageBalanceUsedAmount: 0,
      usageBalanceUsedCurrencyCode: null,
      forcedTestBillingAllowed: false,
      shopifyShopPlanName: null,
      shopifyShopPlanPartnerDevelopment: false,
      shopifyShopPlanShopifyPlus: false,
    };
  }

  const b = s.billing || {};
  const currentTime = now();
  const nowMs = currentTime.getTime();
  const plan = getPlan(b.planKey);
  const regionalPricing = await getStorePricingContext({
    shop,
    storeCountryCode: s?.storeCountryCode,
  });
  const hardStoppedAt = b.hardStoppedAt
    ? new Date(b.hardStoppedAt).getTime()
    : null;

  const trialEndsAt = b.trialEndsAt ? new Date(b.trialEndsAt).getTime() : null;
  const periodEndsAt = b.currentPeriodEnd
    ? new Date(b.currentPeriodEnd).getTime()
    : null;
  const hasShopifySubscription = !!b.subscriptionId;

  // TRIAL valid window (one trial total; if window is active, treat as trial)
  const isTrial = trialEndsAt && nowMs < trialEndsAt;

  const freeCycleWindow =
    b.status === "ACTIVE" &&
    String(plan?.billingType || "").trim() === PLAN_BILLING_TYPES.FREE_CAP
      ? resolveRecurringCycleWindow(b, currentTime, {
          fallbackStart:
            s?.billing?.currentPeriodStart ||
            s?.billing?.cycleAnchorAt ||
            s?.installedAt ||
            s?.createdAt ||
            currentTime,
        })
      : null;

  // ACTIVE (paid)
  // NOTE:
  // - For Shopify Billing subscriptions, `currentPeriodEnd` is the end of the *current cycle* and will advance on renewal.
  //   We treat ACTIVE as active even if we haven't synced a newer currentPeriodEnd yet.
  // - For any legacy/manual billing where there's no subscriptionId, we keep the expiry check.
  const activeCycleSatisfied =
    hasShopifySubscription ||
    (String(plan?.billingType || "").trim() === PLAN_BILLING_TYPES.FREE_CAP
      ? !!freeCycleWindow
      : !periodEndsAt || nowMs < periodEndsAt);
  const isActive = b.status === "ACTIVE" && activeCycleSatisfied;

  const active = !hardStoppedAt && (isActive || isTrial);

  return {
    active,
    // Prefer TRIAL label while the trial window is still active.
    status: hardStoppedAt
      ? "NONE"
      : isTrial
        ? "TRIAL"
        : isActive
          ? "ACTIVE"
          : "NONE",
    planKey: b.planKey,
    plan,
    plans: getPlansForClient(),
    storeCountryCode: regionalPricing.storeCountryCode,
    storeCountryName: s?.storeCountryName || regionalPricing.storeCountryName,
    storeCurrencyCode: s?.storeCurrencyCode || null,
    regionalPricing,
    trialEndsAt: b.trialEndsAt || null,
    trialStartedAt: b.trialStartedAt || null,
    trialUsed: !!b.trialUsed || !!b.trialEndsAt,
    subscriptionId: b.subscriptionId || null,
    subscriptionTest: !!b.subscriptionTest,
    usageSubscriptionLineItemId: b.usageSubscriptionLineItemId || null,
    usageCappedAmount:
      Number.isFinite(Number(b.usageCappedAmount)) &&
      Number(b.usageCappedAmount) > 0
        ? Number(b.usageCappedAmount)
        : null,
    usageCappedCurrencyCode: b.usageCappedCurrencyCode || null,
    usageBalanceUsedAmount: Number(b.usageBalanceUsedAmount || 0),
    usageBalanceUsedCurrencyCode: b.usageBalanceUsedCurrencyCode || null,
    currentPeriodStart:
      freeCycleWindow?.startAt || b.currentPeriodStart || null,
    currentPeriodEnd: freeCycleWindow?.endAt || b.currentPeriodEnd || null,
    cycleAnchorAt: freeCycleWindow?.anchorAt || b.cycleAnchorAt || null,
    cancelAtPeriodEnd: !!b.cancelAtPeriodEnd,
    cancelledAt: b.cancelledAt || null,
    hardStoppedAt: b.hardStoppedAt || null,
    lastCheckedAt: b.lastCheckedAt || null,

    // ✅ expose cap info
    trialMessagesUsed: b.trialMessagesUsed || 0,
    trialMessageCap: Number(
      b.trialMessageCap ||
        (isByonFreeTrialPlan(plan)
          ? plan?.trialMessageCap || plan?.outboundMessageCap
          : null) ||
        TRIAL_MESSAGE_CAP,
    ),
    byonTrialUsed: !!b.byonTrialUsed,
    byonTrialStartedAt: b.byonTrialStartedAt || null,
    byonTrialEndsAt: b.byonTrialEndsAt || null,
    byonTrialMessagesUsed: Number(
      b.byonTrialMessagesUsed || b.trialMessagesUsed || 0,
    ),
    byonTrialMessageCap: Number(
      b.byonTrialMessageCap ||
        plan?.trialMessageCap ||
        plan?.outboundMessageCap ||
        BYON_TRIAL_MESSAGE_CAP,
    ),
    freeConfirmationMessagesUsed: Number(b.freeConfirmationMessagesUsed || 0),
    freeConfirmationCap: Number(b.freeConfirmationCap || FREE_CONFIRMATION_CAP),
    forcedTestBillingAllowed: !!b.forcedTestBillingAllowed,
    shopifyShopPlanName: b.shopifyShopPlanName || null,
    shopifyShopPlanPartnerDevelopment: !!b.shopifyShopPlanPartnerDevelopment,
    shopifyShopPlanShopifyPlus: !!b.shopifyShopPlanShopifyPlus,
  };
}
/**
 * Dev-friendly "subscribe".
 *
 * Since Shopify Billing API isn't enabled yet for private/dev apps,
 * we start a TRIAL for TRIAL_DAYS and store the selected plan.
 *
 * In production:
 * - Replace this with Shopify Billing API (or your payment provider)
 * - Then update Shop.billing.status to ACTIVE when paid
 */
export async function startTrialOrSubscribe(shop, planKey) {
  const plan = getPlan(planKey);
  const t = now();
  const nextSenderMode = String(
    plan?.senderMode || SENDER_MODES.ORDERX_NUMBER,
  ).trim();
  const senderSyncUpdate = {
    "whatsappSender.preferenceMode": nextSenderMode,
    ...(nextSenderMode === SENDER_MODES.ORDERX_NUMBER
      ? { "whatsappSender.activeMode": SENDER_MODES.ORDERX_NUMBER }
      : {}),
  };

  const existing = await Shop.findOne({ shop }).lean();
  const b = existing?.billing || {};

  if (isByonFreeTrialPlan(plan)) {
    if (
      String(b.subscriptionId || "").trim() &&
      String(b.status || "").trim() === "ACTIVE"
    ) {
      return {
        ok: false,
        error:
          "Cancel the current paid subscription first before starting the Your Own Number free trial.",
        requiresCancellation: true,
        billing: b,
        plan,
      };
    }

    const byonTrialAlreadyUsed =
      !!b.byonTrialUsed || !!b.byonTrialStartedAt || !!b.byonTrialEndsAt;
    const currentTrialActive =
      String(b.planKey || "").trim() === String(plan.key || "").trim() &&
      String(b.status || "").trim() === "TRIAL" &&
      b.trialEndsAt &&
      new Date(b.trialEndsAt).getTime() > t.getTime();

    if (byonTrialAlreadyUsed && !currentTrialActive) {
      const next = {
        ...b,
        planKey: b.planKey || plan.key,
        status: "NONE",
        lastCheckedAt: t,
        hardStoppedAt: null,
      };

      await Shop.findOneAndUpdate(
        { shop },
        { $set: { billing: next, ...senderSyncUpdate } },
        { upsert: true },
      );

      return {
        ok: false,
        error:
          "Your Own Number free trial was already used. Choose Starter, Scale, or Unlimited to continue sending.",
        requiresPayment: true,
        billing: next,
        plan,
      };
    }

    if (currentTrialActive) {
      return {
        ok: true,
        shop,
        billing: b,
        plan,
      };
    }

    const trialDays = resolveTrialDays({
      ...plan,
      trialDays: plan?.trialDays || BYON_TRIAL_DAYS,
    });
    const trialMessageCap = resolveTrialMessageCap({
      ...plan,
      trialMessageCap: plan?.trialMessageCap || BYON_TRIAL_MESSAGE_CAP,
    });
    const trialEndsAt = addDays(t, trialDays);
    const next = {
      ...b,
      planKey: plan.key,
      status: "TRIAL",
      subscriptionId: null,
      subscriptionTest: false,
      usageSubscriptionLineItemId: null,
      usageCappedAmount: null,
      usageCappedCurrencyCode: null,
      usageBalanceUsedAmount: 0,
      usageBalanceUsedCurrencyCode: null,
      currentPeriodStart: t,
      currentPeriodEnd: trialEndsAt,
      cycleAnchorAt: t,
      trialDays,
      trialStartedAt: t,
      trialEndsAt,
      trialUsed: true,
      trialMessagesUsed: 0,
      trialMessageCap,
      byonTrialUsed: true,
      byonTrialStartedAt: t,
      byonTrialEndsAt: trialEndsAt,
      byonTrialMessagesUsed: 0,
      byonTrialMessageCap: trialMessageCap,
      lastCheckedAt: t,
      cancelAtPeriodEnd: false,
      cancelledAt: null,
      hardStoppedAt: null,
    };

    const record = await Shop.findOneAndUpdate(
      { shop },
      { $set: { billing: next, ...senderSyncUpdate } },
      { upsert: true, new: true },
    ).lean();

    return {
      ok: true,
      shop: record.shop,
      billing: next,
      plan,
    };
  }

  if (plan.billingType === PLAN_BILLING_TYPES.FREE_CAP) {
    if (
      String(b.subscriptionId || "").trim() &&
      String(b.status || "").trim() === "ACTIVE"
    ) {
      return {
        ok: false,
        error:
          "Cancel the current paid subscription first before switching back to the free OrderX plan.",
        requiresCancellation: true,
        billing: b,
        plan,
      };
    }

    const existingWindow = resolveRecurringCycleWindow(b, t, {
      rollForward: false,
    });
    const hasCurrentCycle =
      !!existingWindow &&
      existingWindow.endAt > existingWindow.startAt &&
      t < existingWindow.endAt;
    const nextWindow = hasCurrentCycle
      ? existingWindow
      : {
          startAt: t,
          endAt: addDays(t, BILLING_CYCLE_DAYS),
          anchorAt: t,
        };

    const next = {
      ...b,
      planKey: plan.key,
      status: "ACTIVE",
      subscriptionId: null,
      subscriptionTest: false,
      usageSubscriptionLineItemId: null,
      usageCappedAmount: null,
      usageCappedCurrencyCode: null,
      usageBalanceUsedAmount: 0,
      usageBalanceUsedCurrencyCode: null,
      currentPeriodStart: nextWindow.startAt,
      currentPeriodEnd: nextWindow.endAt,
      cycleAnchorAt: nextWindow.anchorAt,
      trialDays: 0,
      trialStartedAt: null,
      trialEndsAt: null,
      trialUsed: !!b.trialUsed,
      trialMessagesUsed: Number(b.trialMessagesUsed || 0),
      trialMessageCap: TRIAL_MESSAGE_CAP,
      freeConfirmationMessagesUsed: hasCurrentCycle
        ? Number(b.freeConfirmationMessagesUsed || 0)
        : 0,
      freeConfirmationCap: Number(
        b.freeConfirmationCap ||
          plan.includedConfirmations ||
          FREE_CONFIRMATION_CAP,
      ),
      lastCheckedAt: t,
      cancelAtPeriodEnd: false,
      cancelledAt: null,
      hardStoppedAt: null,
    };

    const record = await Shop.findOneAndUpdate(
      { shop },
      { $set: { billing: next, ...senderSyncUpdate } },
      { upsert: true, new: true },
    ).lean();

    return {
      ok: true,
      shop: record.shop,
      billing: next,
      plan,
    };
  }

  if (
    plan.billingType === PLAN_BILLING_TYPES.SHOPIFY_METERED ||
    plan.billingType === PLAN_BILLING_TYPES.SHOPIFY_FLAT
  ) {
    const next = {
      ...b,
      planKey: plan.key,
      status: String(b.status || "").trim() === "ACTIVE" ? "ACTIVE" : "NONE",
      usageCappedAmount:
        plan.billingType === PLAN_BILLING_TYPES.SHOPIFY_METERED
          ? Number(
              plan?.usageCappedAmount?.amount || b.usageCappedAmount || 0,
            ) || null
          : null,
      usageCappedCurrencyCode:
        plan.billingType === PLAN_BILLING_TYPES.SHOPIFY_METERED
          ? plan?.usageCappedAmount?.currencyCode ||
            b.usageCappedCurrencyCode ||
            null
          : null,
      usageBalanceUsedAmount: Number(b.usageBalanceUsedAmount || 0),
      usageBalanceUsedCurrencyCode:
        plan.billingType === PLAN_BILLING_TYPES.SHOPIFY_METERED
          ? plan?.usageCappedAmount?.currencyCode ||
            b.usageBalanceUsedCurrencyCode ||
            null
          : null,
      lastCheckedAt: t,
      trialUsed: true,
      cancelAtPeriodEnd: false,
      cancelledAt: null,
      hardStoppedAt: null,
    };

    await Shop.findOneAndUpdate(
      { shop },
      { $set: { billing: next, ...senderSyncUpdate } },
      { upsert: true },
    );

    return {
      ok: false,
      error: "Payment approval is required before this plan becomes active.",
      requiresPayment: true,
      billing: next,
      plan,
    };
  }

  const trialEndsAt = b.trialEndsAt ? new Date(b.trialEndsAt).getTime() : null;
  const trialActive = trialEndsAt && t.getTime() < trialEndsAt;
  const trialUsed = !!b.trialUsed || !!trialEndsAt;

  // Already paid: just switch plan, no new trial
  if (b.status === "ACTIVE") {
    const next = {
      ...b,
      planKey: plan.key,
      status: "ACTIVE",
      lastCheckedAt: t,
      trialUsed: true, // once paid, trial is gone forever
      cancelAtPeriodEnd: false,
      cancelledAt: null,
      hardStoppedAt: null,
    };

    const record = await Shop.findOneAndUpdate(
      { shop },
      { $set: { billing: next, ...senderSyncUpdate } },
      { upsert: true, new: true },
    ).lean();

    return {
      ok: true,
      shop: record.shop,
      billing: next,
      plan: { ...plan, monthlyMessages: plan.dailyMessages * 30 },
    };
  }

  // Trial is still active: keep the SAME window (no reset)
  if (trialActive) {
    const next = {
      ...b,
      planKey: plan.key,
      status: "TRIAL",
      lastCheckedAt: t,
      trialUsed: true,
      trialMessageCap: TRIAL_MESSAGE_CAP,
      cancelAtPeriodEnd: false,
      cancelledAt: null,
      hardStoppedAt: null,
    };

    const record = await Shop.findOneAndUpdate(
      { shop },
      { $set: { billing: next, ...senderSyncUpdate } },
      { upsert: true, new: true },
    ).lean();

    return {
      ok: true,
      shop: record.shop,
      billing: next,
      plan: { ...plan, monthlyMessages: plan.dailyMessages * 30 },
    };
  }

  // Start the ONLY trial (if never used before)
  if (!trialUsed) {
    const next = {
      planKey: plan.key,
      status: "TRIAL",
      trialDays: TRIAL_DAYS,
      trialStartedAt: t,
      trialEndsAt: addDays(t, TRIAL_DAYS),
      trialUsed: true,
      trialMessagesUsed: b.trialMessagesUsed || 0,
      trialMessageCap: TRIAL_MESSAGE_CAP,
      // In future, set these after payment:
      subscriptionId: null,
      subscriptionTest: false,
      currentPeriodEnd: null,
      lastCheckedAt: t,
      cancelAtPeriodEnd: false,
      cancelledAt: null,
      hardStoppedAt: null,
    };

    const record = await Shop.findOneAndUpdate(
      { shop },
      { $set: { billing: next, ...senderSyncUpdate } },
      { upsert: true, new: true },
    ).lean();

    return {
      ok: true,
      shop: record.shop,
      billing: next,
      plan: { ...plan, monthlyMessages: plan.dailyMessages * 30 },
    };
  }

  // Trial already used and not active => require paid activation
  const next = {
    ...b,
    planKey: plan.key,
    status: "NONE",
    lastCheckedAt: t,
    trialUsed: true,
    cancelAtPeriodEnd: false,
    cancelledAt: null,
    hardStoppedAt: null,
  };

  await Shop.findOneAndUpdate(
    { shop },
    { $set: { billing: next, ...senderSyncUpdate } },
    { upsert: true },
  );

  return {
    ok: false,
    error:
      "Trial already used. Please activate a paid plan to continue sending.",
    requiresPayment: true,
    billing: next,
    plan: { ...plan, monthlyMessages: plan.dailyMessages * 30 },
  };
}

/**
 * Admin/dev helper to mark the shop as paid (ACTIVE).
 * (Optional for now; you can wire this to your payment confirmation later.)
 */
export async function markPaidActive(shop, currentPeriodEnd = null) {
  const t = now();
  const record = await Shop.findOne({ shop }).lean();
  if (!record) throw new Error("Shop not found");

  const billing = record.billing || {};
  const planKey = billing.planKey || PLAN_KEYS.ORDERX_FREE_5;
  const plan = getPlan(planKey);
  const nextSenderMode = String(
    plan?.senderMode || SENDER_MODES.ORDERX_NUMBER,
  ).trim();
  const periodEnd = currentPeriodEnd ? new Date(currentPeriodEnd) : null;
  const periodStart = periodEnd
    ? new Date(periodEnd.getTime() - 30 * 24 * 60 * 60 * 1000)
    : t;

  const next = {
    ...billing,
    planKey,
    status: "ACTIVE",
    usageSubscriptionLineItemId: billing.usageSubscriptionLineItemId || null,
    usageCappedAmount:
      Number.isFinite(Number(billing.usageCappedAmount)) &&
      Number(billing.usageCappedAmount) > 0
        ? Number(billing.usageCappedAmount)
        : Number(plan?.usageCappedAmount?.amount || 0) || null,
    usageCappedCurrencyCode:
      billing.usageCappedCurrencyCode ||
      plan?.usageCappedAmount?.currencyCode ||
      null,
    usageBalanceUsedAmount: Number(billing.usageBalanceUsedAmount || 0),
    usageBalanceUsedCurrencyCode:
      billing.usageBalanceUsedCurrencyCode ||
      plan?.usageCappedAmount?.currencyCode ||
      null,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    cycleAnchorAt: periodStart,
    lastCheckedAt: t,
    trialUsed: true, // once paid, trial is gone forever
    trialStartedAt: null,
    trialEndsAt: null,
    trialMessagesUsed: 0,
    byonTrialUsed:
      nextSenderMode === SENDER_MODES.OWN_NUMBER
        ? true
        : !!billing.byonTrialUsed,
    cancelAtPeriodEnd: false,
    cancelledAt: null,
    hardStoppedAt: null,
    freeConfirmationCap: Number(
      billing.freeConfirmationCap || FREE_CONFIRMATION_CAP,
    ),
  };

  await Shop.findOneAndUpdate(
    { shop },
    {
      $set: {
        billing: next,
        "whatsappSender.preferenceMode": nextSenderMode,
        ...(nextSenderMode === SENDER_MODES.ORDERX_NUMBER
          ? { "whatsappSender.activeMode": SENDER_MODES.ORDERX_NUMBER }
          : {}),
      },
    },
  );
  return getBillingStatus(shop);
}

export async function ensureBillingActive(shop) {
  const status = await getBillingStatus(shop);
  if (!status.active) {
    const err = new Error("Billing inactive");
    err.statusCode = 402;
    err.data = status;
    throw err;
  }
  return status;
}
