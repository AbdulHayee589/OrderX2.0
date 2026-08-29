// Central pricing / quota configuration.
//
// IMPORTANT:
// We intentionally avoid Shopify Billing API in dev because Shopify restricts
// Billing API usage for apps without public distribution.
// Instead we store a plan in Mongo and enforce quotas server-side.
// When the app is ready for public distribution, you can replace the
// subscribe flow with Shopify's Billing API.

export const TRIAL_DAYS = 3;

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envDecimal(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const BILLING_CURRENCY = process.env.BILLING_CURRENCY || "USD";
const METERED_USAGE_CURRENCY =
  process.env.BILLING_ORDERX_METERED_USAGE_CURRENCY || "USD";
const FREE_CONFIRMATION_CAP = envNumber(
  "BILLING_ORDERX_FREE_CONFIRMATION_CAP",
  10,
);
const METERED_USAGE_AMOUNT = envDecimal(
  "BILLING_ORDERX_METERED_USAGE_AMOUNT",
  0.01,
);
const METERED_USAGE_CAP_MESSAGES = envNumber(
  "BILLING_ORDERX_METERED_USAGE_CAP_MESSAGES",
  3000,
);
const METERED_USAGE_CAP = envNumber(
  "BILLING_ORDERX_METERED_USAGE_CAP",
  Number((METERED_USAGE_AMOUNT * METERED_USAGE_CAP_MESSAGES).toFixed(2)),
);
const OWN_NUMBER_OVERAGE_AMOUNT = envDecimal(
  "BILLING_OWN_NUMBER_OVERAGE_AMOUNT",
  0.01,
);
export const BYON_TRIAL_DAYS = envNumber(
  "BILLING_OWN_NUMBER_FREE_TRIAL_DAYS",
  7,
);
export const BYON_TRIAL_MESSAGE_CAP = envNumber(
  "BILLING_OWN_NUMBER_FREE_TRIAL_MESSAGES",
  200,
);

export const SENDER_MODES = {
  ORDERX_NUMBER: "orderx_number",
  OWN_NUMBER: "own_number",
};

export const PLAN_BILLING_TYPES = {
  FREE_CAP: "free_cap",
  SHOPIFY_METERED: "shopify_metered",
  SHOPIFY_FLAT: "shopify_flat",
  LEGACY_QUOTA: "legacy_quota",
};

export const PLAN_KEYS = {
  ORDERX_FREE_5: "orderx_free_5",
  ORDERX_METERED_4: "orderx_metered_4",
  OWN_NUMBER_FREE_TRIAL_200: "own_number_free_trial_200",
  OWN_NUMBER_SCALE_10: "own_number_scale_10",
  OWN_NUMBER_STARTER_5: "own_number_starter_5",
  OWN_NUMBER_UNLIMITED_15: "own_number_unlimited_15",
  OWN_NUMBER_FLAT_8: "own_number_flat_8",
};

// Usage-based packages (messages/day).
// dailyMessages is the hard enforcement cap.
// monthlyMessages is informational (dailyMessages * 30).
export const PLANS = {
  [PLAN_KEYS.ORDERX_FREE_5]: {
    key: PLAN_KEYS.ORDERX_FREE_5,
    name: "OrderX Free",
    price: 0,
    currencyCode: BILLING_CURRENCY,
    senderMode: SENDER_MODES.ORDERX_NUMBER,
    billingType: PLAN_BILLING_TYPES.FREE_CAP,
    includedConfirmations: FREE_CONFIRMATION_CAP,
    visible: true,
  },
  [PLAN_KEYS.ORDERX_METERED_4]: {
    key: PLAN_KEYS.ORDERX_METERED_4,
    name: "OrderX Growth",
    price: envDecimal("BILLING_ORDERX_METERED_4_PRICE", 2.99),
    currencyCode: BILLING_CURRENCY,
    senderMode: SENDER_MODES.ORDERX_NUMBER,
    billingType: PLAN_BILLING_TYPES.SHOPIFY_METERED,
    usagePrice: {
      amount: METERED_USAGE_AMOUNT,
      currencyCode: METERED_USAGE_CURRENCY,
      terms:
        "Country-based rate per WhatsApp message sent through OrderX. Recipient-country rates apply.",
    },
    usageCappedAmount: {
      amount: METERED_USAGE_CAP,
      currencyCode: METERED_USAGE_CURRENCY,
    },
    visible: true,
  },

  [PLAN_KEYS.OWN_NUMBER_FREE_TRIAL_200]: {
    key: PLAN_KEYS.OWN_NUMBER_FREE_TRIAL_200,
    name: "Your Own Number Free Trial",
    price: 0,
    currencyCode: BILLING_CURRENCY,
    dailyMessages: 0,
    senderMode: SENDER_MODES.OWN_NUMBER,
    quotaManagedByMeta: true,
    billingType: PLAN_BILLING_TYPES.FREE_CAP,
    outboundMessageCap: BYON_TRIAL_MESSAGE_CAP,
    trialDays: BYON_TRIAL_DAYS,
    trialMessageCap: BYON_TRIAL_MESSAGE_CAP,
    oneTimeTrial: true,
    upgradePlanKey: PLAN_KEYS.OWN_NUMBER_STARTER_5,
    visible: true,
  },

  [PLAN_KEYS.OWN_NUMBER_SCALE_10]: {
    key: PLAN_KEYS.OWN_NUMBER_SCALE_10,
    name: "Your Own Number Scale",
    price: envNumber("BILLING_OWN_NUMBER_SCALE_10_PRICE", 10),
    currencyCode: BILLING_CURRENCY,
    dailyMessages: 0,
    senderMode: SENDER_MODES.OWN_NUMBER,
    quotaManagedByMeta: true,
    billingType: PLAN_BILLING_TYPES.SHOPIFY_FLAT,
    outboundMessageCap: envNumber(
      "BILLING_OWN_NUMBER_SCALE_10_OUTBOUND_CAP",
      7500,
    ),
    usagePrice: {
      amount: OWN_NUMBER_OVERAGE_AMOUNT,
      currencyCode: BILLING_CURRENCY,
      terms:
        "USD 0.01 per outbound OrderX message after 7500 included messages each 30-day billing cycle.",
    },
    usageCappedAmount: {
      amount: envNumber("BILLING_OWN_NUMBER_SCALE_10_USAGE_CAP", 100),
      currencyCode: BILLING_CURRENCY,
    },
    upgradePlanKey: PLAN_KEYS.OWN_NUMBER_UNLIMITED_15,
    visible: true,
  },
  [PLAN_KEYS.OWN_NUMBER_STARTER_5]: {
    key: PLAN_KEYS.OWN_NUMBER_STARTER_5,
    name: "Your Own Number Starter",
    price: envNumber("BILLING_OWN_NUMBER_STARTER_5_PRICE", 5),
    currencyCode: BILLING_CURRENCY,
    dailyMessages: 0,
    senderMode: SENDER_MODES.OWN_NUMBER,
    quotaManagedByMeta: true,
    billingType: PLAN_BILLING_TYPES.SHOPIFY_FLAT,
    outboundMessageCap: envNumber(
      "BILLING_OWN_NUMBER_STARTER_5_OUTBOUND_CAP",
      2500,
    ),
    usagePrice: {
      amount: OWN_NUMBER_OVERAGE_AMOUNT,
      currencyCode: BILLING_CURRENCY,
      terms:
        "USD 0.01 per outbound OrderX message after 2500 included messages each 30-day billing cycle.",
    },
    usageCappedAmount: {
      amount: envNumber("BILLING_OWN_NUMBER_STARTER_5_USAGE_CAP", 100),
      currencyCode: BILLING_CURRENCY,
    },
    upgradePlanKey: PLAN_KEYS.OWN_NUMBER_SCALE_10,
    visible: true,
  },
  [PLAN_KEYS.OWN_NUMBER_FLAT_8]: {
    key: PLAN_KEYS.OWN_NUMBER_FLAT_8,
    name: "Your Own Number Legacy",
    price: envNumber("BILLING_OWN_NUMBER_FLAT_8_PRICE", 8),
    currencyCode: BILLING_CURRENCY,
    dailyMessages: 0,
    senderMode: SENDER_MODES.OWN_NUMBER,
    quotaManagedByMeta: true,
    billingType: PLAN_BILLING_TYPES.SHOPIFY_FLAT,
    outboundMessageCap: envNumber(
      "BILLING_OWN_NUMBER_FLAT_8_OUTBOUND_CAP",
      7500,
    ),
    usagePrice: {
      amount: OWN_NUMBER_OVERAGE_AMOUNT,
      currencyCode: BILLING_CURRENCY,
      terms:
        "USD 0.01 per outbound OrderX message after 7500 included messages each 30-day billing cycle.",
    },
    usageCappedAmount: {
      amount: envNumber("BILLING_OWN_NUMBER_FLAT_8_USAGE_CAP", 100),
      currencyCode: BILLING_CURRENCY,
    },
    upgradePlanKey: PLAN_KEYS.OWN_NUMBER_SCALE_10,
    visible: false,
  },
  [PLAN_KEYS.OWN_NUMBER_UNLIMITED_15]: {
    key: PLAN_KEYS.OWN_NUMBER_UNLIMITED_15,
    name: "Your Own Number Unlimited",
    price: envNumber("BILLING_OWN_NUMBER_UNLIMITED_15_PRICE", 20),
    currencyCode: BILLING_CURRENCY,
    dailyMessages: 0,
    senderMode: SENDER_MODES.OWN_NUMBER,
    quotaManagedByMeta: true,
    billingType: PLAN_BILLING_TYPES.SHOPIFY_FLAT,
    outboundMessageCap: null,
    visible: true,
  },
  lite_20: {
    key: "lite_20",
    name: "Lite 20 (600/month)",
    price: envNumber("BILLING_LITE_20_PRICE", 5),
    currencyCode: BILLING_CURRENCY,
    dailyMessages: 20,
    senderMode: SENDER_MODES.ORDERX_NUMBER,
    billingType: PLAN_BILLING_TYPES.LEGACY_QUOTA,
    visible: false,
  },
  basic_50: {
    key: "basic_50",
    name: "Basic 50 (1500/month)",
    price: envNumber("BILLING_BASIC_50_PRICE", 10),
    currencyCode: BILLING_CURRENCY,
    dailyMessages: 50,
    senderMode: SENDER_MODES.ORDERX_NUMBER,
    billingType: PLAN_BILLING_TYPES.LEGACY_QUOTA,
    visible: false,
  },
  starter_100: {
    key: "starter_100",
    name: "Starter 100 (3000/month)",
    price: envNumber("BILLING_STARTER_100_PRICE", 15), // Monthly
    currencyCode: BILLING_CURRENCY,
    dailyMessages: 100,
    senderMode: SENDER_MODES.ORDERX_NUMBER,
    billingType: PLAN_BILLING_TYPES.LEGACY_QUOTA,
    visible: false,
  },
  medium_200: {
    key: "medium_200",
    name: "Medium 200 (6000/month)",
    price: envNumber("BILLING_MEDIUM_200_PRICE", 25),
    currencyCode: BILLING_CURRENCY,
    dailyMessages: 200,
    senderMode: SENDER_MODES.ORDERX_NUMBER,
    billingType: PLAN_BILLING_TYPES.LEGACY_QUOTA,
    visible: false,
  },
  growth_300: {
    key: "growth_300",
    name: "Growth 300 (9000/month)",
    price: envNumber("BILLING_GROWTH_300_PRICE", 40),
    currencyCode: BILLING_CURRENCY,
    dailyMessages: 300,
    senderMode: SENDER_MODES.ORDERX_NUMBER,
    billingType: PLAN_BILLING_TYPES.LEGACY_QUOTA,
    visible: false,
  },
  plus_400: {
    key: "plus_400",
    name: "Plus 400 (12000/month)",
    price: envNumber("BILLING_PLUS_400_PRICE", 50),
    currencyCode: BILLING_CURRENCY,
    dailyMessages: 400,
    senderMode: SENDER_MODES.ORDERX_NUMBER,
    billingType: PLAN_BILLING_TYPES.LEGACY_QUOTA,
    visible: false,
  },
  pro_500: {
    key: "pro_500",
    name: "Pro 500 (15000/month)",
    price: envNumber("BILLING_PRO_500_PRICE", 60),
    currencyCode: BILLING_CURRENCY,
    dailyMessages: 500,
    senderMode: SENDER_MODES.ORDERX_NUMBER,
    billingType: PLAN_BILLING_TYPES.LEGACY_QUOTA,
    visible: false,
  },
  scale_1000: {
    key: "scale_1000",
    name: "Scale 1000 (30000/month)",
    price: envNumber("BILLING_SCALE_1000_PRICE", 130),
    currencyCode: BILLING_CURRENCY,
    dailyMessages: 1000,
    senderMode: SENDER_MODES.ORDERX_NUMBER,
    billingType: PLAN_BILLING_TYPES.LEGACY_QUOTA,
    visible: false,
  },
  enterprise_2000: {
    key: "enterprise_2000",
    name: "Enterprise 2000 (60000/month)",
    price: envNumber("BILLING_ENTERPRISE_2000_PRICE", 200),
    currencyCode: BILLING_CURRENCY,
    dailyMessages: 2000,
    senderMode: SENDER_MODES.ORDERX_NUMBER,
    billingType: PLAN_BILLING_TYPES.LEGACY_QUOTA,
    visible: false,
  },
};

function enrichPlan(p) {
  const quotaManagedByMeta = p?.quotaManagedByMeta === true;
  const outboundMessageCap =
    p?.outboundMessageCap == null
      ? p?.templateMessageCap
      : p?.outboundMessageCap;
  return {
    ...p,
    senderMode: p?.senderMode || SENDER_MODES.ORDERX_NUMBER,
    quotaManagedByMeta,
    billingType: p?.billingType || PLAN_BILLING_TYPES.LEGACY_QUOTA,
    includedConfirmations: Number(p?.includedConfirmations || 0),
    outboundMessageCap:
      outboundMessageCap == null
        ? null
        : Number.isFinite(Number(outboundMessageCap))
          ? Math.max(0, Number(outboundMessageCap))
          : null,
    templateMessageCap:
      outboundMessageCap == null
        ? null
        : Number.isFinite(Number(outboundMessageCap))
          ? Math.max(0, Number(outboundMessageCap))
          : null,
    upgradePlanKey: String(p?.upgradePlanKey || "").trim() || null,
    usagePrice:
      p?.usagePrice && Number(p.usagePrice.amount) > 0
        ? {
            amount: Number(p.usagePrice.amount),
            currencyCode: String(
              p.usagePrice.currencyCode || METERED_USAGE_CURRENCY,
            ).trim(),
            terms: String(p.usagePrice.terms || "").trim(),
          }
        : null,
    usageCappedAmount:
      p?.usageCappedAmount && Number(p.usageCappedAmount.amount) > 0
        ? {
            amount: Number(p.usageCappedAmount.amount),
            currencyCode: String(
              p.usageCappedAmount.currencyCode || METERED_USAGE_CURRENCY,
            ).trim(),
          }
        : null,
    visible: p?.visible !== false,
    monthlyMessages: quotaManagedByMeta
      ? null
      : Number.isFinite(Number(p?.dailyMessages))
        ? Number(p.dailyMessages) * 30
        : 0,
  };
}

export function getPlansForClient() {
  return Object.fromEntries(
    Object.entries(PLANS).map(([k, p]) => [k, enrichPlan(p)]),
  );
}

export function getPlan(planKey) {
  const p = PLANS[planKey] || PLANS[PLAN_KEYS.ORDERX_FREE_5];
  return enrichPlan(p);
}

export function isKnownPlanKey(planKey) {
  return Boolean(PLANS[planKey]);
}
