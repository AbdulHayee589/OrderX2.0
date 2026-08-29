import { formatNumber } from "./format";

const moneyFormatterCache = new Map();
const DEFAULT_USD_TO_PKR_RATE = 278;

function getMoneyFormatter(currency = "USD") {
  const code =
    String(currency || "USD")
      .trim()
      .toUpperCase() || "USD";
  if (moneyFormatterCache.has(code)) return moneyFormatterCache.get(code);
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: code,
    minimumFractionDigits: code === "USD" ? 2 : 0,
    maximumFractionDigits: code === "USD" ? 4 : 2,
  });
  moneyFormatterCache.set(code, formatter);
  return formatter;
}

export function shouldShowPkrInfo(timeZone = "") {
  const tz = String(timeZone || "")
    .trim()
    .toLowerCase();
  return tz === "asia/karachi" || tz === "pkt";
}

export function formatMoney(amount, currency = "USD") {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "—";
  return getMoneyFormatter(currency).format(n);
}

export function formatDualCurrency({ usd = 0, pkr = 0, showPkrInfo = false }) {
  if (showPkrInfo) {
    return `${formatMoney(pkr, "PKR")} | ${formatMoney(usd, "USD")}`;
  }
  return formatMoney(usd, "USD");
}

function normalizeRegionalPricing(options = {}) {
  const regionalPricing =
    options?.regionalPricing && typeof options.regionalPricing === "object"
      ? options.regionalPricing
      : {};
  return {
    storeCountryCode:
      String(regionalPricing?.storeCountryCode || "")
        .trim()
        .toUpperCase() || "",
    storeCountryName: String(regionalPricing?.storeCountryName || "").trim(),
    growthStoreRateUsd: Number(regionalPricing?.growthStoreRateUsd || 0),
    byonUtilityTemplateUsd: Number(
      regionalPricing?.byonUtilityTemplateUsd || 0,
    ),
  };
}

function resolveIncludedMessageCap(plan) {
  const rawCap =
    plan?.outboundMessageCap == null
      ? plan?.templateMessageCap
      : plan?.outboundMessageCap;
  return Number.isFinite(Number(rawCap)) ? Math.max(0, Number(rawCap)) : null;
}

export function describePlanPrice(plan, options = {}) {
  const billingType = String(plan?.billingType || "").trim();
  const showPkrInfo = options?.showPkrInfo === true;
  const fx = Number(options?.usdToPkrRate || DEFAULT_USD_TO_PKR_RATE);
  const regionalPricing = normalizeRegionalPricing(options);
  const templateCap = resolveIncludedMessageCap(plan);

  if (
    billingType === "free_cap" &&
    String(plan?.senderMode || "").trim() === "own_number"
  ) {
    const days = Number(plan?.trialDays || 7);
    return Number.isFinite(days) && days > 0
      ? `Free for ${formatNumber(days)} days`
      : "Free trial";
  }
  if (billingType === "free_cap") return "Free";
  if (billingType === "shopify_metered") {
    const usdAmount =
      regionalPricing.growthStoreRateUsd > 0
        ? regionalPricing.growthStoreRateUsd
        : Number(plan?.usagePrice?.amount || 0);
    const baselineLabel = regionalPricing.storeCountryCode
      ? ` (${regionalPricing.storeCountryCode} baseline)`
      : "";
    const base = `${formatMoney(plan?.price || 0, "USD")} / month + ${formatMoney(usdAmount, "USD")} / message${baselineLabel}`;
    if (showPkrInfo && Number.isFinite(fx) && fx > 0) {
      return `${base} (~${formatMoney(usdAmount * fx, "PKR")} / message)`;
    }
    return base;
  }
  if (plan?.quotaManagedByMeta === true) {
    const base = `${formatMoney(plan?.price || 0, "USD")} / month`;
    const overageUsd = Number(plan?.usagePrice?.amount || 0);
    if (templateCap && templateCap > 0 && overageUsd > 0) {
      return `${base}, ${formatNumber(templateCap)} outbound messages included, then ${formatMoney(overageUsd, "USD")} / message`;
    }
    return templateCap && templateCap > 0
      ? `${base} for ${formatNumber(templateCap)} outbound messages`
      : `${base} for unlimited outbound messages`;
  }
  if (Number(plan?.price) > 0) {
    return `${formatMoney(plan.price, "USD")} / month`;
  }
  return "";
}

export function describePlanDetail(plan, options = {}) {
  const billingType = String(plan?.billingType || "").trim();
  const regionalPricing = normalizeRegionalPricing(options);
  const templateCap = resolveIncludedMessageCap(plan);
  if (billingType === "free_cap") {
    if (String(plan?.senderMode || "").trim() === "own_number") {
      const cap = Number(plan?.trialMessageCap || templateCap || 200);
      return ` ${formatNumber(cap)} outbound messages total. One trial per store.`;
    }
    return `${formatNumber(plan?.includedConfirmations || 0)} template messages total`;
  }
  if (billingType === "shopify_metered") {
    return regionalPricing.storeCountryCode
      ? `Actual billing follows the recipient country. ${regionalPricing.storeCountryCode} baseline shown here for cap planning.`
      : "Actual billing follows the recipient country. Store baseline shown here for cap planning.";
  }
  if (plan?.quotaManagedByMeta === true) {
    const overageUsd = Number(plan?.usagePrice?.amount || 0);
    const capLabel =
      templateCap && templateCap > 0
        ? `${formatNumber(templateCap)} outbound messages each billing cycle.`
        : "Unlimited OrderX outbound allowance each billing cycle.";
    const overageLabel =
      templateCap && templateCap > 0 && overageUsd > 0
        ? `After these msg limits: ${formatMoney(overageUsd, "USD")} per outbound message.`
        : "";
    return `${capLabel} ${overageLabel} Uses your own Meta billing account for WhatsApp delivery.`;
  }
  return Number.isFinite(Number(plan?.monthlyMessages))
    ? `~${formatNumber(plan?.monthlyMessages || 0)} / month`
    : "";
}
