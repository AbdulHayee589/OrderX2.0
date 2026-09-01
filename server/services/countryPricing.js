import Shop from "../models/Shop.js";
import CountryMessageRate from "../models/CountryMessageRate.js";
import { inferCountryCodeFromE164 } from "./phone.js";

const CACHE_TTL_MS = Number(process.env.COUNTRY_RATE_CACHE_MS || 5 * 60_000);
const SHOP_CONTEXT_CACHE_TTL_MS = Number(
  process.env.SHOP_CONTEXT_CACHE_MS || 5 * 60_000,
);
const DEFAULT_STORE_COUNTRY_CODE = String(
  process.env.DEFAULT_STORE_COUNTRY_CODE || "PK",
)
  .trim()
  .toUpperCase();
const DEFAULT_GROWTH_PRICE_USD = Number(
  process.env.BILLING_ORDERX_METERED_USAGE_AMOUNT || 0.01,
);
const DEFAULT_BYON_TEMPLATE_USD = Number(
  process.env.BYON_META_TEMPLATE_ESTIMATED_USD || 0.01,
);

const DEFAULT_COUNTRY_MESSAGE_RATES = [
  {
    countryCode: "PK",
    countryName: "Pakistan",
    growthPriceUsd: 0.01,
    byonUtilityTemplateUsd: 0.01,
  },
  {
    countryCode: "IN",
    countryName: "India",
    growthPriceUsd: 0.01,
    byonUtilityTemplateUsd: 0.0014,
  },
  {
    countryCode: "EG",
    countryName: "Egypt",
    growthPriceUsd: 0.01,
    byonUtilityTemplateUsd: 0.0036,
  },
  {
    countryCode: "SA",
    countryName: "Saudi Arabia",
    growthPriceUsd: 0.02,
    byonUtilityTemplateUsd: 0.0107,
  },
  {
    countryCode: "AE",
    countryName: "United Arab Emirates",
    growthPriceUsd: 0.02,
    byonUtilityTemplateUsd: 0.0157,
  },
  {
    countryCode: "MY",
    countryName: "Malaysia",
    growthPriceUsd: 0.02,
    byonUtilityTemplateUsd: 0.014,
  },
  {
    countryCode: "ID",
    countryName: "Indonesia",
    growthPriceUsd: 0.03,
    byonUtilityTemplateUsd: 0.025,
  },
];

const COUNTRY_CODE_ALIASES = new Map([
  ["PAK", "PK"],
  ["PAKISTAN", "PK"],
  ["IND", "IN"],
  ["INDIA", "IN"],
  ["EGY", "EG"],
  ["EGYPT", "EG"],
  ["SAU", "SA"],
  ["SAUDI ARABIA", "SA"],
  ["ARE", "AE"],
  ["UAE", "AE"],
  ["UNITED ARAB EMIRATES", "AE"],
  ["MYS", "MY"],
  ["MALAYSIA", "MY"],
  ["IDN", "ID"],
  ["INDONESIA", "ID"],
]);

let countryRateCache = {
  expiresAt: 0,
  map: new Map(),
};

const shopContextCache = new Map();

function nowMs() {
  return Date.now();
}

export function normalizeCountryCode(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  return COUNTRY_CODE_ALIASES.get(normalized) || normalized;
}

export function resolveConfiguredStoreRate(
  rateMap,
  { explicitStoreCountryCode = "", resolvedStoreCountryCode = "" } = {},
) {
  const countryCode =
    normalizeCountryCode(explicitStoreCountryCode) ||
    normalizeCountryCode(resolvedStoreCountryCode);
  return countryCode ? rateMap?.get(countryCode) || null : null;
}

function roundUsd(value, digits = 4) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(digits));
}

function normalizeRateRow(row) {
  return {
    countryCode: normalizeCountryCode(row?.countryCode),
    countryName: String(row?.countryName || "").trim(),
    growthPriceUsd: roundUsd(row?.growthPriceUsd || DEFAULT_GROWTH_PRICE_USD),
    byonUtilityTemplateUsd: roundUsd(
      row?.byonUtilityTemplateUsd || DEFAULT_BYON_TEMPLATE_USD,
      4,
    ),
    active: row?.active !== false,
  };
}

async function ensureDefaultCountryMessageRates() {
  const operations = DEFAULT_COUNTRY_MESSAGE_RATES.map((row) => ({
    updateOne: {
      filter: { countryCode: row.countryCode },
      update: { $setOnInsert: row },
      upsert: true,
    },
  }));
  if (!operations.length) return;
  await CountryMessageRate.bulkWrite(operations, { ordered: false }).catch(
    () => {},
  );
  await CountryMessageRate.updateOne(
    { countryCode: "PK" },
    {
      $set: {
        countryName: "Pakistan",
        growthPriceUsd: 0.01,
        byonUtilityTemplateUsd: 0.01,
        active: true,
      },
    },
    { upsert: true },
  ).catch(() => {});
}

async function loadCountryRateMap(options = {}) {
  const force = options?.force === true;
  if (
    !force &&
    countryRateCache.expiresAt > nowMs() &&
    countryRateCache.map.size
  ) {
    return countryRateCache.map;
  }

  await ensureDefaultCountryMessageRates();
  const rows = await CountryMessageRate.find({ active: true })
    .sort({ countryCode: 1 })
    .lean();
  const nextMap = new Map();
  for (const row of rows) {
    const normalized = normalizeRateRow(row);
    if (!normalized.countryCode) continue;
    nextMap.set(normalized.countryCode, normalized);
  }
  if (!nextMap.size) {
    for (const row of DEFAULT_COUNTRY_MESSAGE_RATES) {
      const normalized = normalizeRateRow(row);
      nextMap.set(normalized.countryCode, normalized);
    }
  }
  countryRateCache = {
    map: nextMap,
    expiresAt: nowMs() + CACHE_TTL_MS,
  };
  return nextMap;
}

async function getStoredShopContext(shop) {
  const shopDomain = String(shop || "").trim();
  if (!shopDomain) return null;
  const cached = shopContextCache.get(shopDomain);
  if (cached && cached.expiresAt > nowMs()) return cached.value;

  const record = await Shop.findOne({ shop: shopDomain })
    .select({
      storeCountryCode: 1,
      storeCountryName: 1,
    })
    .lean();
  const value = {
    storeCountryCode: normalizeCountryCode(record?.storeCountryCode),
    storeCountryName: String(record?.storeCountryName || "").trim() || null,
  };
  shopContextCache.set(shopDomain, {
    value,
    expiresAt: nowMs() + SHOP_CONTEXT_CACHE_TTL_MS,
  });
  return value;
}

export function getDefaultStoreCountryCode() {
  return DEFAULT_STORE_COUNTRY_CODE || "PK";
}

export function invalidateStorePricingContextCache(shop = "") {
  const shopDomain = String(shop || "").trim();
  if (shopDomain) shopContextCache.delete(shopDomain);
}

export async function getCountryMessageRate(countryCode, options = {}) {
  const normalizedCountryCode = normalizeCountryCode(countryCode);
  const rateMap = await loadCountryRateMap(options);
  return rateMap.get(normalizedCountryCode) || null;
}

export async function getStorePricingContext({
  shop = "",
  storeCountryCode = "",
} = {}) {
  const storedContext = await getStoredShopContext(shop);
  const explicitStoreCountryCode =
    normalizeCountryCode(storeCountryCode) ||
    normalizeCountryCode(storedContext?.storeCountryCode);
  const resolvedStoreCountryCode =
    explicitStoreCountryCode || getDefaultStoreCountryCode();
  const rateMap = await loadCountryRateMap();
  const matchedStoreRate = resolveConfiguredStoreRate(rateMap, {
    explicitStoreCountryCode,
    resolvedStoreCountryCode,
  });
  const storeRate =
    matchedStoreRate ||
    normalizeRateRow({
      countryCode: resolvedStoreCountryCode,
      countryName: storedContext?.storeCountryName || resolvedStoreCountryCode,
      growthPriceUsd: DEFAULT_GROWTH_PRICE_USD,
      byonUtilityTemplateUsd: DEFAULT_BYON_TEMPLATE_USD,
    });
  return {
    storeCountryCode: storeRate.countryCode,
    storeCountryName: storeRate.countryName || storeRate.countryCode,
    growthPriceUsd: roundUsd(storeRate.growthPriceUsd),
    growthStoreRateUsd: roundUsd(storeRate.growthPriceUsd),
    byonUtilityTemplateUsd: roundUsd(storeRate.byonUtilityTemplateUsd, 4),
    growthPricingAvailable: !!matchedStoreRate,
    growthPricingAvailabilitySource: matchedStoreRate
      ? explicitStoreCountryCode
        ? "explicit"
        : "configured_default"
      : "fallback",
    requestedStoreCountryCode: explicitStoreCountryCode || null,
  };
}

export async function getGrowthPlanAvailabilityForStore({
  shop = "",
  storeCountryCode = "",
} = {}) {
  const pricingContext = await getStorePricingContext({
    shop,
    storeCountryCode,
  });
  const countryLabel =
    pricingContext.storeCountryName ||
    pricingContext.requestedStoreCountryCode ||
    pricingContext.storeCountryCode ||
    "this store";
  if (pricingContext.growthPricingAvailable) {
    return {
      available: true,
      storeCountryCode:
        pricingContext.requestedStoreCountryCode ||
        pricingContext.storeCountryCode ||
        null,
      storeCountryName: pricingContext.storeCountryName || null,
      reason: null,
      pricingContext,
    };
  }

  const reason = pricingContext.requestedStoreCountryCode
    ? `OrderX Growth is not available yet for stores based in ${countryLabel}.`
    : "OrderX Growth is only available after OrderX can detect your store billing country.";

  return {
    available: false,
    storeCountryCode:
      pricingContext.requestedStoreCountryCode ||
      pricingContext.storeCountryCode ||
      null,
    storeCountryName: pricingContext.storeCountryName || null,
    reason,
    pricingContext,
  };
}

export async function resolveMessageCountryContext({
  shop = "",
  toE164 = "",
  recipientCountryCode = "",
  storeCountryCode = "",
} = {}) {
  const pricingContext = await getStorePricingContext({
    shop,
    storeCountryCode,
  });
  const inferredRecipientCountryCode =
    normalizeCountryCode(recipientCountryCode) ||
    normalizeCountryCode(inferCountryCodeFromE164(toE164)) ||
    pricingContext.storeCountryCode;

  return {
    storeCountryCode: pricingContext.storeCountryCode,
    storeCountryName: pricingContext.storeCountryName,
    recipientCountryCode: inferredRecipientCountryCode,
    crossBorderRateApplied:
      !!inferredRecipientCountryCode &&
      inferredRecipientCountryCode !== pricingContext.storeCountryCode,
  };
}

export async function resolveGrowthMessagePricing({
  shop = "",
  toE164 = "",
  recipientCountryCode = "",
  storeCountryCode = "",
} = {}) {
  const context = await resolveMessageCountryContext({
    shop,
    toE164,
    recipientCountryCode,
    storeCountryCode,
  });
  const storeRateRow =
    (await getCountryMessageRate(context.storeCountryCode)) ||
    normalizeRateRow({
      countryCode: context.storeCountryCode,
      countryName: context.storeCountryName,
      growthPriceUsd: DEFAULT_GROWTH_PRICE_USD,
      byonUtilityTemplateUsd: DEFAULT_BYON_TEMPLATE_USD,
    });
  const recipientRateRow =
    (await getCountryMessageRate(context.recipientCountryCode)) || storeRateRow;
  const storeRateUsd = roundUsd(storeRateRow.growthPriceUsd);
  const recipientRateUsd = roundUsd(recipientRateRow.growthPriceUsd);
  const capUnitsConsumed = Math.max(
    1,
    Math.ceil((recipientRateUsd + 1e-9) / Math.max(storeRateUsd, 0.0001)),
  );

  return {
    ...context,
    storeRateUsd,
    recipientRateUsd,
    capUnitsConsumed,
  };
}

export async function resolveByonTemplatePricing({
  shop = "",
  toE164 = "",
  recipientCountryCode = "",
  storeCountryCode = "",
} = {}) {
  const context = await resolveMessageCountryContext({
    shop,
    toE164,
    recipientCountryCode,
    storeCountryCode,
  });
  const storeRateRow =
    (await getCountryMessageRate(context.storeCountryCode)) ||
    normalizeRateRow({
      countryCode: context.storeCountryCode,
      countryName: context.storeCountryName,
      growthPriceUsd: DEFAULT_GROWTH_PRICE_USD,
      byonUtilityTemplateUsd: DEFAULT_BYON_TEMPLATE_USD,
    });
  const recipientRateRow =
    (await getCountryMessageRate(context.recipientCountryCode)) || storeRateRow;

  return {
    ...context,
    storeRateUsd: roundUsd(storeRateRow.byonUtilityTemplateUsd, 4),
    recipientRateUsd: roundUsd(recipientRateRow.byonUtilityTemplateUsd, 4),
  };
}
