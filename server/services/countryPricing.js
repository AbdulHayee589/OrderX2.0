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
    countryCode: "US",
    countryName: "United States",
    growthPriceUsd: 0.01,
    byonUtilityTemplateUsd: 0.01,
  },
  {
    countryCode: "PK",
    countryName: "Pakistan",
    growthPriceUsd: 0.02,
    byonUtilityTemplateUsd: 0.02,
  },
  {
    countryCode: "IN",
    countryName: "India",
    growthPriceUsd: 0.01,
    byonUtilityTemplateUsd: 0.01,
  },
  {
    countryCode: "EG",
    countryName: "Egypt",
    growthPriceUsd: 0.01,
    byonUtilityTemplateUsd: 0.01,
  },
  {
    countryCode: "SA",
    countryName: "Saudi Arabia",
    growthPriceUsd: 0.02,
    byonUtilityTemplateUsd: 0.02,
  },
  {
    countryCode: "AE",
    countryName: "United Arab Emirates",
    growthPriceUsd: 0.02,
    byonUtilityTemplateUsd: 0.02,
  },
  {
    countryCode: "MY",
    countryName: "Malaysia",
    growthPriceUsd: 0.02,
    byonUtilityTemplateUsd: 0.02,
  },
  {
    countryCode: "ID",
    countryName: "Indonesia",
    growthPriceUsd: 0.03,
    byonUtilityTemplateUsd: 0.03,
  },
];

const COUNTRY_CODE_ALIASES = new Map([
  ["USA", "US"],
  ["UNITED STATES", "US"],
  ["UNITED STATES OF AMERICA", "US"],
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
  const growthPriceUsd = Number(row?.growthPriceUsd);
  const byonUtilityTemplateUsd = Number(row?.byonUtilityTemplateUsd);
  return {
    countryCode: normalizeCountryCode(row?.countryCode),
    countryName: String(row?.countryName || "").trim(),
    growthPriceUsd: roundUsd(
      Number.isFinite(growthPriceUsd) && growthPriceUsd > 0
        ? growthPriceUsd
        : DEFAULT_GROWTH_PRICE_USD,
    ),
    byonUtilityTemplateUsd: roundUsd(
      Number.isFinite(byonUtilityTemplateUsd) && byonUtilityTemplateUsd >= 0
        ? byonUtilityTemplateUsd
        : DEFAULT_BYON_TEMPLATE_USD,
      4,
    ),
    active: row?.active !== false,
  };
}

export function buildActiveCountryRateMap(rows = []) {
  const rateMap = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.active === false) continue;
    const normalized = normalizeRateRow(row);
    if (!normalized.countryCode) continue;
    rateMap.set(normalized.countryCode, normalized);
  }
  return rateMap;
}

export function calculateGrowthCapUnits(recipientRateUsd, storeRateUsd) {
  const recipientRateUnits = Math.round(Number(recipientRateUsd || 0) * 10_000);
  const storeRateUnits = Math.round(Number(storeRateUsd || 0) * 10_000);
  if (recipientRateUnits <= 0 || storeRateUnits <= 0) return 1;
  return Math.max(1, Math.ceil(recipientRateUnits / storeRateUnits));
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
}

async function loadCountryRateMap(options = {}) {
  const force = options?.force === true;
  if (!force && countryRateCache.expiresAt > nowMs()) {
    return countryRateCache.map;
  }

  await ensureDefaultCountryMessageRates();
  const rows = await CountryMessageRate.find({ active: true })
    .sort({ countryCode: 1 })
    .lean();
  const nextMap = buildActiveCountryRateMap(rows);
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

export function invalidateCountryRateCache() {
  countryRateCache = {
    expiresAt: 0,
    map: new Map(),
  };
}

export async function getCountryMessageRate(countryCode, options = {}) {
  const normalizedCountryCode = normalizeCountryCode(countryCode);
  const rateMap = await loadCountryRateMap(options);
  return rateMap.get(normalizedCountryCode) || null;
}

export async function getStorePricingContext({
  shop = "",
  storeCountryCode = "",
  forceCountryRateRefresh = false,
} = {}) {
  const storedContext = await getStoredShopContext(shop);
  const explicitStoreCountryCode =
    normalizeCountryCode(storeCountryCode) ||
    normalizeCountryCode(storedContext?.storeCountryCode);
  const resolvedStoreCountryCode =
    explicitStoreCountryCode || getDefaultStoreCountryCode();
  const rateMap = await loadCountryRateMap({ force: forceCountryRateRefresh });
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
  forceCountryRateRefresh = false,
} = {}) {
  const pricingContext = await getStorePricingContext({
    shop,
    storeCountryCode,
    forceCountryRateRefresh,
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
  const capUnitsConsumed = calculateGrowthCapUnits(
    recipientRateUsd,
    storeRateUsd,
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
