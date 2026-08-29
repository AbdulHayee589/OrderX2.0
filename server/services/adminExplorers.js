import Shop from "../models/Shop.js";
import WaMessageLog from "../models/WaMessageLog.js";
import CodAttempt from "../models/CodAttempt.js";
import BillingUsageCharge from "../models/BillingUsageCharge.js";
import PlanPurchase from "../models/PlanPurchase.js";
import Metric from "../models/Metric.js";
import OrderUpdateDispatch from "../models/OrderUpdateDispatch.js";
import ConversationInitiation from "../models/ConversationInitiation.js";
import BlockedContact from "../models/BlockedContact.js";
import CountryMessageRate from "../models/CountryMessageRate.js";
import AuditLog from "../models/AuditLog.js";
import { getPlan, PLAN_KEYS } from "./plans.js";
import { inferCountryCodeFromE164 } from "./phone.js";
import { getRuntimeConfig, updateRuntimeConfig } from "./runtimeConfig.js";
import { logAudit } from "./audit.js";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const EXPORT_MAX_ROWS = 5000;
const GLOBAL_AUDIT_SCOPE = "_global";

const ATTEMPT_SEARCH_FIELDS = {
  order: ["orderName", "orderGid"],
  customer: ["customerName"],
  phone: ["phoneE164"],
  status: ["status"],
  stage: ["stage"],
  template: ["waTemplateUsed"],
  change: ["changeState"],
  error: ["lastError"],
  store: ["storeName", "shop"],
  sender: ["senderMode", "senderPhoneNumberId"],
};

const ATTEMPT_GENERAL_SEARCH_FIELDS = [
  "shop",
  "orderName",
  "orderGid",
  "customerName",
  "phoneE164",
  "status",
  "stage",
  "changeState",
  "waTemplateUsed",
  "lastError",
  "storeName",
  "senderMode",
  "senderPhoneNumberId",
];
const ACTIVE_PLAN_PURCHASE_STATUSES = new Set(["ACTIVE", "ACCEPTED"]);

function safeText(value, fallback = "") {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function clampInteger(value, min, max, fallback) {
  const numeric = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function roundCurrency(value, digits = 2) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(digits));
}

function toDate(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function isActivePaidBillingShop(shop) {
  const status = safeText(shop?.billing?.status);
  const subscriptionId = safeText(shop?.billing?.subscriptionId);
  const plan = getPlan(shop?.billing?.planKey);
  return (
    status === "ACTIVE" &&
    subscriptionId &&
    !shop?.billing?.subscriptionTest &&
    !toDate(shop?.billing?.hardStoppedAt) &&
    Number(plan?.price || 0) > 0
  );
}

function buildActiveSubscriptionRevenue(shops = [], purchases = []) {
  const activePurchaseBySubscription = new Map();
  for (const purchase of purchases || []) {
    const shop = safeText(purchase?.shop);
    const subscriptionId = safeText(purchase?.subscriptionId);
    const status = safeText(purchase?.status).toUpperCase();
    if (!shop || !subscriptionId) continue;
    if (purchase?.test === true) continue;
    if (toDate(purchase?.endedAt)) continue;
    if (!ACTIVE_PLAN_PURCHASE_STATUSES.has(status)) continue;
    activePurchaseBySubscription.set(`${shop}::${subscriptionId}`, purchase);
  }

  const seenShops = new Set();
  const rows = [];
  for (const shop of shops || []) {
    const shopDomain = safeText(shop?.shop);
    const subscriptionId = safeText(shop?.billing?.subscriptionId);
    if (!shopDomain || seenShops.has(shopDomain)) continue;
    if (!isActivePaidBillingShop(shop)) continue;

    const purchase = activePurchaseBySubscription.get(
      `${shopDomain}::${subscriptionId}`,
    );
    if (!purchase) continue;

    const planKey = safeText(shop?.billing?.planKey, purchase?.planKey);
    const plan = getPlan(planKey);
    const monthlyPriceUsd = roundCurrency(plan?.price || 0);
    if (monthlyPriceUsd <= 0) continue;

    seenShops.add(shopDomain);
    rows.push({
      shop: shopDomain,
      planKey,
      subscriptionId,
      monthlyPriceUsd,
    });
  }

  return {
    subscriptionRevenueUsd: roundCurrency(
      rows.reduce((sum, item) => sum + Number(item.monthlyPriceUsd || 0), 0),
    ),
    activeSubscriptionCount: rows.length,
    activeSubscriptions: rows,
  };
}

function buildDateRange(field, from, to) {
  const startAt = toDate(from);
  const endAt = toDate(to);
  if (!startAt && !endAt) return null;
  return {
    [field]: {
      ...(startAt ? { $gte: startAt } : {}),
      ...(endAt ? { $lte: endAt } : {}),
    },
  };
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeBooleanFilter(value) {
  const normalized = safeText(value).toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) return true;
  if (["0", "false", "no"].includes(normalized)) return false;
  return null;
}

function buildPagination(query = {}) {
  const exportRequested =
    safeText(query.export) === "1" ||
    ["csv", "json"].includes(safeText(query.format).toLowerCase());
  const pageSize = exportRequested
    ? EXPORT_MAX_ROWS
    : clampInteger(query.pageSize, 10, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  const page = exportRequested
    ? 1
    : clampInteger(query.page, 1, 100000, 1);
  return {
    exportRequested,
    format: safeText(query.format).toLowerCase(),
    page,
    pageSize,
    skip: exportRequested ? 0 : (page - 1) * pageSize,
  };
}

function buildPaginationMeta(total, page, pageSize, exportRequested) {
  const totalPages = exportRequested ? 1 : Math.max(1, Math.ceil(total / pageSize));
  const safePage = exportRequested ? 1 : Math.min(page, totalPages);
  return {
    page: safePage,
    pageSize,
    total,
    totalPages,
    hasPrevious: safePage > 1,
    hasNext: safePage < totalPages,
  };
}

function tokenizeAttemptSearch(raw) {
  const input = safeText(raw);
  if (!input) return [];
  return input.match(/"[^"]+"|[^\s]+/g) || [];
}

function buildAttemptSearchMatch(raw) {
  const tokens = tokenizeAttemptSearch(raw);
  if (!tokens.length) return null;

  const clauses = tokens
    .map((token) => token.replace(/^"|"$/g, "").trim())
    .filter(Boolean)
    .map((token) => {
      const separatorIndex = token.indexOf(":");
      if (separatorIndex > 0) {
        const prefix = token.slice(0, separatorIndex).trim().toLowerCase();
        const value = token.slice(separatorIndex + 1).trim();
        const fields = ATTEMPT_SEARCH_FIELDS[prefix];
        if (value && Array.isArray(fields) && fields.length) {
          const regex = new RegExp(escapeRegex(value), "i");
          return {
            $or: fields.map((field) => ({ [field]: regex })),
          };
        }
      }

      const regex = new RegExp(escapeRegex(token), "i");
      return {
        $or: ATTEMPT_GENERAL_SEARCH_FIELDS.map((field) => ({ [field]: regex })),
      };
    });

  return clauses.length ? { $and: clauses } : null;
}

function formatCsvCell(value) {
  const stringValue =
    typeof value === "string" ? value : JSON.stringify(value ?? "");
  return `"${String(stringValue).replace(/"/g, '""')}"`;
}

export function serializeExport(items, format = "json") {
  const normalized = safeText(format, "json").toLowerCase();
  if (normalized === "csv") {
    const rows = Array.isArray(items) ? items : [];
    const keys = Array.from(
      rows.reduce((set, row) => {
        Object.keys(row || {}).forEach((key) => set.add(key));
        return set;
      }, new Set()),
    );
    const header = keys.map(formatCsvCell).join(",");
    const body = rows
      .map((row) => keys.map((key) => formatCsvCell(row?.[key])).join(","))
      .join("\n");
    return {
      contentType: "text/csv; charset=utf-8",
      body: `${header}\n${body}`,
    };
  }

  return {
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(items, null, 2),
  };
}

function maskAccessToken(value) {
  const raw = safeText(value);
  if (!raw) return null;
  if (raw.length <= 8) return "••••••••";
  return `${raw.slice(0, 4)}••••${raw.slice(-4)}`;
}

function sanitizeShopForList(shop) {
  const planKey = safeText(shop?.billing?.planKey, PLAN_KEYS.ORDERX_FREE_5);
  const plan = getPlan(planKey);
  const hardStoppedAt = toDate(shop?.billing?.hardStoppedAt);
  const status = safeText(shop?.billing?.status, "NONE");
  const active = !hardStoppedAt && (status === "ACTIVE" || status === "TRIAL");
  return {
    shop: safeText(shop?.shop),
    active,
    planKey,
    planName: safeText(plan?.name, planKey),
    billingStatus: status,
    senderMode:
      safeText(shop?.whatsappSender?.activeMode) ||
      safeText(shop?.whatsappSender?.preferenceMode) ||
      safeText(plan?.senderMode, "unknown"),
    storeCountryCode: shop?.storeCountryCode || null,
    storeCountryName: shop?.storeCountryName || null,
    storeCurrencyCode: shop?.storeCurrencyCode || null,
    currentPeriodEnd: toDate(shop?.billing?.currentPeriodEnd)?.toISOString() || null,
    cancelAtPeriodEnd: Boolean(shop?.billing?.cancelAtPeriodEnd),
    hardStoppedAt: hardStoppedAt?.toISOString() || null,
    installedAt: toDate(shop?.installedAt)?.toISOString() || null,
    accessTokenUpdatedAt:
      toDate(shop?.accessTokenUpdatedAt)?.toISOString() || null,
    hasAccessToken: Boolean(shop?.accessToken),
    accessTokenMasked: maskAccessToken(shop?.accessToken),
  };
}

async function getStoreWindowStats(shopDomains = []) {
  if (!shopDomains.length) return new Map();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [messageRows, chargeRows, attemptRows] = await Promise.all([
    WaMessageLog.aggregate([
      {
        $match: {
          shop: { $in: shopDomains },
          createdAt: { $gte: since },
        },
      },
      {
        $group: {
          _id: "$shop",
          outboundMessages30d: {
            $sum: { $cond: [{ $eq: ["$direction", "outbound"] }, 1, 0] },
          },
          inboundMessages30d: {
            $sum: { $cond: [{ $eq: ["$direction", "inbound"] }, 1, 0] },
          },
          templateMessages30d: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$direction", "outbound"] },
                    { $ne: ["$templateName", null] },
                    { $ne: ["$templateName", ""] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          metaCostUsd30d: { $sum: { $ifNull: ["$estimatedMetaCostUsd", 0] } },
        },
      },
    ]),
    BillingUsageCharge.aggregate([
      {
        $match: {
          shop: { $in: shopDomains },
          status: "submitted",
          $or: [{ submittedAt: { $gte: since } }, { createdAt: { $gte: since } }],
        },
      },
      {
        $group: {
          _id: "$shop",
          usageRevenueUsd30d: { $sum: { $ifNull: ["$amount", 0] } },
        },
      },
    ]),
    CodAttempt.aggregate([
      {
        $match: {
          shop: { $in: shopDomains },
          confirmedAt: { $gte: since },
        },
      },
      {
        $group: {
          _id: "$shop",
          confirmedOrders30d: { $sum: 1 },
          confirmedSalesUsd30d: { $sum: { $ifNull: ["$orderAmount", 0] } },
        },
      },
    ]),
  ]);

  const output = new Map();
  for (const shop of shopDomains) output.set(shop, {});

  for (const row of messageRows) {
    output.set(String(row?._id || ""), {
      ...(output.get(String(row?._id || "")) || {}),
      outboundMessages30d: Number(row?.outboundMessages30d || 0),
      inboundMessages30d: Number(row?.inboundMessages30d || 0),
      templateMessages30d: Number(row?.templateMessages30d || 0),
      metaCostUsd30d: roundCurrency(row?.metaCostUsd30d || 0),
    });
  }
  for (const row of chargeRows) {
    output.set(String(row?._id || ""), {
      ...(output.get(String(row?._id || "")) || {}),
      usageRevenueUsd30d: roundCurrency(row?.usageRevenueUsd30d || 0),
    });
  }
  for (const row of attemptRows) {
    output.set(String(row?._id || ""), {
      ...(output.get(String(row?._id || "")) || {}),
      confirmedOrders30d: Number(row?.confirmedOrders30d || 0),
      confirmedSalesUsd30d: roundCurrency(row?.confirmedSalesUsd30d || 0),
    });
  }

  return output;
}

export async function listAdminStores(query = {}) {
  const pagination = buildPagination(query);
  const match = {};
  const shopSearch = safeText(query.shop || query.q);
  if (shopSearch) {
    match.shop = new RegExp(escapeRegex(shopSearch), "i");
  }

  const planKey = safeText(query.planKey);
  if (planKey) match["billing.planKey"] = planKey;

  const billingStatus = safeText(query.billingStatus);
  if (billingStatus) match["billing.status"] = billingStatus;

  const senderMode = safeText(query.senderMode);
  if (senderMode) {
    match.$or = [
      { "whatsappSender.activeMode": senderMode },
      { "whatsappSender.preferenceMode": senderMode },
    ];
  }

  const country = safeText(query.storeCountryCode).toUpperCase();
  if (country) match.storeCountryCode = country;

  const activeState = safeText(query.activeState).toLowerCase();
  if (activeState === "active") {
    match["billing.hardStoppedAt"] = null;
    match["billing.status"] = { $in: ["ACTIVE", "TRIAL"] };
  } else if (activeState === "hard_stopped") {
    match["billing.hardStoppedAt"] = { $ne: null };
  } else if (activeState === "inactive") {
    match.$and = [
      ...(match.$and || []),
      {
        $or: [
          { "billing.hardStoppedAt": { $ne: null } },
          { "billing.status": { $nin: ["ACTIVE", "TRIAL"] } },
        ],
      },
    ];
  }

  const accessToken = safeText(query.accessToken).toLowerCase();
  if (accessToken === "present") {
    match.accessToken = { $nin: [null, ""] };
  } else if (accessToken === "missing") {
    match.$and = [...(match.$and || []), { $or: [{ accessToken: null }, { accessToken: "" }] }];
  }

  const installedRange = buildDateRange(
    "installedAt",
    query.installedFrom,
    query.installedTo,
  );
  if (installedRange) match.installedAt = installedRange.installedAt;

  const periodRange = buildDateRange(
    "billing.currentPeriodEnd",
    query.periodEndFrom,
    query.periodEndTo,
  );
  if (periodRange) {
    match["billing.currentPeriodEnd"] = periodRange["billing.currentPeriodEnd"];
  }

  const total = await Shop.countDocuments(match);
  const items = await Shop.find(match)
    .sort({ installedAt: -1, updatedAt: -1 })
    .skip(pagination.skip)
    .limit(pagination.pageSize)
    .lean();

  const sanitized = items.map(sanitizeShopForList);
  const statsMap = await getStoreWindowStats(sanitized.map((item) => item.shop));
  const rows = sanitized.map((item) => ({
    ...item,
    ...(statsMap.get(item.shop) || {
      outboundMessages30d: 0,
      inboundMessages30d: 0,
      templateMessages30d: 0,
      usageRevenueUsd30d: 0,
      metaCostUsd30d: 0,
      confirmedOrders30d: 0,
      confirmedSalesUsd30d: 0,
    }),
  }));

  const summary = await Shop.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        active: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$billing.hardStoppedAt", null] },
                  { $in: ["$billing.status", ["ACTIVE", "TRIAL"]] },
                ],
              },
              1,
              0,
            ],
          },
        },
        hardStopped: {
          $sum: {
            $cond: [{ $ne: ["$billing.hardStoppedAt", null] }, 1, 0],
          },
        },
      },
    },
  ]);

  return {
    items: rows,
    pagination: buildPaginationMeta(
      total,
      pagination.page,
      pagination.pageSize,
      pagination.exportRequested,
    ),
    filters: {
      shop: shopSearch,
      planKey,
      billingStatus,
      senderMode,
      storeCountryCode: country,
      activeState,
      accessToken,
    },
    summary: {
      total: Number(summary?.[0]?.total || total),
      active: Number(summary?.[0]?.active || 0),
      hardStopped: Number(summary?.[0]?.hardStopped || 0),
    },
  };
}

export async function listAdminMessages(query = {}) {
  const pagination = buildPagination(query);
  const match = {};

  if (safeText(query.shop)) match.shop = safeText(query.shop);
  if (safeText(query.waMessageId)) match.waMessageId = safeText(query.waMessageId);
  if (safeText(query.toE164)) {
    match.toE164 = new RegExp(escapeRegex(safeText(query.toE164)), "i");
  }
  if (safeText(query.direction)) match.direction = safeText(query.direction);
  if (safeText(query.templateName)) match.templateName = safeText(query.templateName);
  if (safeText(query.senderMode)) match.senderMode = safeText(query.senderMode);
  if (safeText(query.senderPhoneNumberId)) {
    match.senderPhoneNumberId = safeText(query.senderPhoneNumberId);
  }
  if (safeText(query.recipientCountryCode)) {
    match.recipientCountryCode = safeText(query.recipientCountryCode).toUpperCase();
  }
  if (safeText(query.storeCountryCode)) {
    match.storeCountryCode = safeText(query.storeCountryCode).toUpperCase();
  }
  const templateState = safeText(query.templateState).toLowerCase();
  if (templateState === "present") {
    match.templateName = { $nin: [null, ""] };
  } else if (templateState === "missing") {
    match.$and = [
      ...(match.$and || []),
      {
        $or: [{ templateName: null }, { templateName: "" }],
      },
    ];
  }
  const crossBorder = normalizeBooleanFilter(query.crossBorderRateApplied);
  if (crossBorder !== null) match.crossBorderRateApplied = crossBorder;
  if (safeText(query.attemptId)) match.attemptId = safeText(query.attemptId);
  if (safeText(query.orderGid)) match.orderGid = safeText(query.orderGid);
  const dateRange = buildDateRange("createdAt", query.from, query.to);
  if (dateRange) match.createdAt = dateRange.createdAt;
  if (safeText(query.q)) match.text = new RegExp(escapeRegex(safeText(query.q)), "i");

  const usageMin = Number(query.usageChargeUsdMin);
  const usageMax = Number(query.usageChargeUsdMax);
  if (Number.isFinite(usageMin) || Number.isFinite(usageMax)) {
    match.usageChargeUsd = {
      ...(Number.isFinite(usageMin) ? { $gte: usageMin } : {}),
      ...(Number.isFinite(usageMax) ? { $lte: usageMax } : {}),
    };
  }

  const metaMin = Number(query.estimatedMetaCostUsdMin);
  const metaMax = Number(query.estimatedMetaCostUsdMax);
  if (Number.isFinite(metaMin) || Number.isFinite(metaMax)) {
    match.estimatedMetaCostUsd = {
      ...(Number.isFinite(metaMin) ? { $gte: metaMin } : {}),
      ...(Number.isFinite(metaMax) ? { $lte: metaMax } : {}),
    };
  }

  const total = await WaMessageLog.countDocuments(match);
  const items = await WaMessageLog.find(match)
    .sort({ createdAt: -1 })
    .skip(pagination.skip)
    .limit(pagination.pageSize)
    .lean();

  const summaryRows = await WaMessageLog.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$direction",
        count: { $sum: 1 },
        metaCostUsd: { $sum: { $ifNull: ["$estimatedMetaCostUsd", 0] } },
        usageRevenueUsd: { $sum: { $ifNull: ["$usageChargeUsd", 0] } },
      },
    },
  ]);

  const byDirection = Object.fromEntries(
    summaryRows.map((row) => [safeText(row?._id), row]),
  );
  return {
    items: items.map((item) => ({
      id: safeText(item?._id),
      createdAt: toDate(item?.createdAt)?.toISOString() || null,
      shop: safeText(item?.shop),
      direction: safeText(item?.direction),
      kind: safeText(item?.kind),
      text: safeText(item?.text),
      templateName: item?.templateName || null,
      waMessageId: item?.waMessageId || null,
      senderMode: item?.senderMode || null,
      senderPhoneNumberId: item?.senderPhoneNumberId || null,
      toE164: item?.toE164 || null,
      recipientCountryCode: item?.recipientCountryCode || null,
      storeCountryCode: item?.storeCountryCode || null,
      crossBorderRateApplied: Boolean(item?.crossBorderRateApplied),
      estimatedMetaCostUsd: roundCurrency(item?.estimatedMetaCostUsd || 0),
      usageChargeUsd: roundCurrency(item?.usageChargeUsd || 0),
      capUnitsConsumed: Number(item?.capUnitsConsumed || 0),
      attemptId: item?.attemptId ? String(item.attemptId) : null,
      orderGid: item?.orderGid || null,
      metaPreview: safeText(JSON.stringify(item?.meta || {})).slice(0, 180),
      meta: item?.meta || null,
    })),
    pagination: buildPaginationMeta(
      total,
      pagination.page,
      pagination.pageSize,
      pagination.exportRequested,
    ),
    summary: {
      total,
      outbound: Number(byDirection?.outbound?.count || 0),
      inbound: Number(byDirection?.inbound?.count || 0),
      metaCostUsd: roundCurrency(
        Number(byDirection?.outbound?.metaCostUsd || 0) +
          Number(byDirection?.inbound?.metaCostUsd || 0),
      ),
      usageRevenueUsd: roundCurrency(
        Number(byDirection?.outbound?.usageRevenueUsd || 0) +
          Number(byDirection?.inbound?.usageRevenueUsd || 0),
      ),
    },
    filters: {
      ...query,
    },
  };
}

export async function listAdminAttempts(query = {}) {
  const pagination = buildPagination(query);
  const match = {};
  const searchMatch = buildAttemptSearchMatch(query.q);
  if (searchMatch?.$and?.length) match.$and = searchMatch.$and;
  if (safeText(query.status)) match.status = safeText(query.status);
  if (safeText(query.stage)) match.stage = safeText(query.stage);
  if (safeText(query.senderMode)) match.senderMode = safeText(query.senderMode);
  if (safeText(query.duplicateRole)) match.duplicateRole = safeText(query.duplicateRole);
  if (safeText(query.phoneQueueRole)) match.phoneQueueRole = safeText(query.phoneQueueRole);
  if (safeText(query.shop)) match.shop = safeText(query.shop);

  const retryCount = normalizeBooleanFilter(query.retryCountGt0);
  if (retryCount === true) {
    match.retryCount = { $gt: 0 };
  }
  const hasErrors = normalizeBooleanFilter(query.hasErrors);
  if (hasErrors === true) {
    match.lastError = { $nin: [null, ""] };
  }
  const hasChangeRequests = normalizeBooleanFilter(query.hasChangeRequests);
  if (hasChangeRequests === true) {
    match.changeRequestCount = { $gt: 0 };
  }
  const dateRange = buildDateRange("createdAt", query.from, query.to);
  if (dateRange) match.createdAt = dateRange.createdAt;

  const total = await CodAttempt.countDocuments(match);
  const items = await CodAttempt.find(match)
    .sort({ createdAt: -1 })
    .skip(pagination.skip)
    .limit(pagination.pageSize)
    .lean();

  const shopDomains = [...new Set(items.map((item) => safeText(item?.shop)).filter(Boolean))];
  const shopRows = shopDomains.length
    ? await Shop.find({ shop: { $in: shopDomains } })
        .select({ shop: 1, storeCountryCode: 1 })
        .lean()
    : [];
  const storeCountryMap = new Map(
    shopRows.map((item) => [safeText(item?.shop), safeText(item?.storeCountryCode).toUpperCase()]),
  );

  const rows = items
    .map((item) => {
      const storeCountryCode = storeCountryMap.get(safeText(item?.shop)) || null;
      const recipientCountryCode =
        safeText(item?.countryCode).toUpperCase() ||
        safeText(inferCountryCodeFromE164(item?.phoneE164)).toUpperCase() ||
        null;
      return {
        id: safeText(item?._id),
        createdAt: toDate(item?.createdAt)?.toISOString() || null,
        shop: safeText(item?.shop),
        orderName: safeText(item?.orderName),
        orderAmount: roundCurrency(item?.orderAmount || 0),
        orderCurrency: item?.orderCurrency || null,
        customerName: safeText(item?.customerName),
        phoneE164: item?.phoneE164 || null,
        stage: item?.stage || null,
        status: item?.status || null,
        senderMode: item?.senderMode || null,
        senderPhoneNumberId: item?.senderPhoneNumberId || null,
        duplicateRole: item?.duplicateRole || null,
        phoneQueueRole: item?.phoneQueueRole || null,
        waTemplateUsed: item?.waTemplateUsed || null,
        waMessageId: item?.waMessageId || null,
        retryCount: Number(item?.retryCount || 0),
        changeState: item?.changeState || null,
        supportInfoCount: Number(item?.supportInfoCount || 0),
        lastError: item?.lastError || null,
        confirmedAt: toDate(item?.confirmedAt)?.toISOString() || null,
        cancelledAt: toDate(item?.cancelledAt)?.toISOString() || null,
        waSentAt: toDate(item?.waSentAt)?.toISOString() || null,
        crossBorder:
          !!storeCountryCode &&
          !!recipientCountryCode &&
          recipientCountryCode !== storeCountryCode,
      };
    })
    .filter((item) =>
      normalizeBooleanFilter(query.crossBorder) === null
        ? true
        : item.crossBorder === normalizeBooleanFilter(query.crossBorder),
    );

  return {
    items: rows,
    pagination: buildPaginationMeta(
      total,
      pagination.page,
      pagination.pageSize,
      pagination.exportRequested,
    ),
    summary: {
      total,
      confirmed: rows.filter((item) => item.status === "confirmed").length,
      cancelled: rows.filter((item) => item.status === "cancelled").length,
      failed: rows.filter((item) => item.status === "failed").length,
      withErrors: rows.filter((item) => !!item.lastError).length,
    },
    filters: {
      ...query,
    },
  };
}

export async function listAdminBillingUsageCharges(query = {}) {
  const pagination = buildPagination(query);
  const match = {};
  if (safeText(query.shop)) match.shop = safeText(query.shop);
  if (safeText(query.planKey)) match.planKey = safeText(query.planKey);
  if (safeText(query.status)) match.status = safeText(query.status);
  if (safeText(query.billingCycleId)) match.billingCycleId = safeText(query.billingCycleId);
  if (safeText(query.waMessageId)) match.waMessageId = safeText(query.waMessageId);
  if (safeText(query.orderGid)) match.orderGid = safeText(query.orderGid);
  if (safeText(query.recipientCountryCode)) {
    match.recipientCountryCode = safeText(query.recipientCountryCode).toUpperCase();
  }
  if (safeText(query.storeCountryCode)) {
    match.storeCountryCode = safeText(query.storeCountryCode).toUpperCase();
  }
  const dateRange = buildDateRange(
    safeText(query.useSubmittedAt).toLowerCase() === "1" ? "submittedAt" : "createdAt",
    query.from,
    query.to,
  );
  if (dateRange) {
    Object.assign(match, dateRange);
  }
  const total = await BillingUsageCharge.countDocuments(match);
  const items = await BillingUsageCharge.find(match)
    .sort({ createdAt: -1 })
    .skip(pagination.skip)
    .limit(pagination.pageSize)
    .lean();
  const summary = await BillingUsageCharge.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$status",
        totalAmount: { $sum: { $ifNull: ["$amount", 0] } },
        count: { $sum: 1 },
      },
    },
  ]);
  const byStatus = Object.fromEntries(summary.map((row) => [safeText(row?._id), row]));
  return {
    items: items.map((item) => ({
      id: safeText(item?._id),
      createdAt: toDate(item?.createdAt)?.toISOString() || null,
      shop: safeText(item?.shop),
      planKey: safeText(item?.planKey),
      subscriptionId: item?.subscriptionId || null,
      subscriptionLineItemId: item?.subscriptionLineItemId || null,
      billingCycleId: item?.billingCycleId || null,
      billingCycleStartedAt:
        toDate(item?.billingCycleStartedAt)?.toISOString() || null,
      billingCycleEndsAt:
        toDate(item?.billingCycleEndsAt)?.toISOString() || null,
      waMessageId: item?.waMessageId || null,
      attemptId: item?.attemptId ? String(item.attemptId) : null,
      orderGid: item?.orderGid || null,
      quantity: Number(item?.quantity || 0),
      amount: roundCurrency(item?.amount || 0),
      currencyCode: item?.currencyCode || null,
      recipientCountryCode: item?.recipientCountryCode || null,
      storeCountryCode: item?.storeCountryCode || null,
      crossBorderRateApplied: Boolean(item?.crossBorderRateApplied),
      capUnitsConsumed: Number(item?.capUnitsConsumed || 0),
      description: safeText(item?.description),
      idempotencyKey: safeText(item?.idempotencyKey),
      usageRecordId: item?.usageRecordId || null,
      status: safeText(item?.status),
      error: item?.error || null,
      errorAt: toDate(item?.errorAt)?.toISOString() || null,
      submittedAt: toDate(item?.submittedAt)?.toISOString() || null,
    })),
    pagination: buildPaginationMeta(
      total,
      pagination.page,
      pagination.pageSize,
      pagination.exportRequested,
    ),
    summary: {
      total,
      submittedAmountUsd: roundCurrency(byStatus?.submitted?.totalAmount || 0),
      failedCount: Number(byStatus?.failed?.count || 0),
      skippedCount: Number(byStatus?.skipped?.count || 0),
    },
  };
}

export async function listAdminPlanPurchases(query = {}) {
  const pagination = buildPagination(query);
  const match = {};
  if (safeText(query.shop)) match.shop = safeText(query.shop);
  if (safeText(query.planKey)) match.planKey = safeText(query.planKey);
  if (safeText(query.status)) match.status = safeText(query.status);
  const testFilter = normalizeBooleanFilter(query.test);
  if (testFilter !== null) match.test = testFilter;
  const dateRange = buildDateRange("startedAt", query.from, query.to);
  if (dateRange) match.startedAt = dateRange.startedAt;
  const total = await PlanPurchase.countDocuments(match);
  const items = await PlanPurchase.find(match)
    .sort({ startedAt: -1, createdAt: -1 })
    .skip(pagination.skip)
    .limit(pagination.pageSize)
    .lean();
  return {
    items: items.map((item) => ({
      id: safeText(item?._id),
      shop: safeText(item?.shop),
      planKey: safeText(item?.planKey),
      subscriptionId: safeText(item?.subscriptionId),
      status: safeText(item?.status),
      test: Boolean(item?.test),
      startedAt: toDate(item?.startedAt)?.toISOString() || null,
      currentPeriodEnd: toDate(item?.currentPeriodEnd)?.toISOString() || null,
      endedAt: toDate(item?.endedAt)?.toISOString() || null,
      source: safeText(item?.source),
    })),
    pagination: buildPaginationMeta(
      total,
      pagination.page,
      pagination.pageSize,
      pagination.exportRequested,
    ),
  };
}

export async function getAdminBillingOverview(referenceDate = new Date()) {
  const monthStart = new Date(referenceDate);
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [
    charges,
    messages,
    activePurchases,
    activeSubscriptionShops,
    storesNearCap,
  ] = await Promise.all([
    BillingUsageCharge.aggregate([
      {
        $match: {
          status: "submitted",
          $or: [
            { submittedAt: { $gte: monthStart } },
            { createdAt: { $gte: monthStart } },
          ],
        },
      },
      {
        $group: {
          _id: null,
          usageRevenueUsd: { $sum: { $ifNull: ["$amount", 0] } },
          billableOutboundMessages: { $sum: { $ifNull: ["$quantity", 1] } },
        },
      },
    ]),
    WaMessageLog.aggregate([
      {
        $match: {
          createdAt: { $gte: monthStart },
          direction: "outbound",
        },
      },
      {
        $group: {
          _id: null,
          orderxNumberMetaCostUsd: {
            $sum: {
              $cond: [
                { $eq: ["$senderMode", "orderx_number"] },
                { $ifNull: ["$estimatedMetaCostUsd", 0] },
                0,
              ],
            },
          },
          orderxNumberTemplateMessages: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$senderMode", "orderx_number"] },
                    { $ne: ["$templateName", null] },
                    { $ne: ["$templateName", ""] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
    PlanPurchase.find({
      endedAt: null,
      test: { $ne: true },
    }).lean(),
    Shop.find({
      "billing.status": "ACTIVE",
      "billing.subscriptionId": { $nin: [null, ""] },
      "billing.hardStoppedAt": null,
    })
      .select({
        shop: 1,
        "billing.planKey": 1,
        "billing.status": 1,
        "billing.subscriptionId": 1,
        "billing.subscriptionTest": 1,
        "billing.hardStoppedAt": 1,
      })
      .lean(),
    Shop.find({
      "billing.usageCappedAmount": { $gt: 0 },
      "billing.usageBalanceUsedAmount": { $gt: 0 },
    })
      .select({
        shop: 1,
        "billing.usageCappedAmount": 1,
        "billing.usageBalanceUsedAmount": 1,
        "billing.planKey": 1,
      })
      .lean(),
  ]);

  const subscriptionRevenue = buildActiveSubscriptionRevenue(
    activeSubscriptionShops,
    activePurchases,
  );
  const subscriptionRevenueUsd = subscriptionRevenue.subscriptionRevenueUsd;

  return {
    subscriptionRevenueUsd,
    activeSubscriptionCount: subscriptionRevenue.activeSubscriptionCount,
    usageRevenueUsd: roundCurrency(charges?.[0]?.usageRevenueUsd || 0),
    totalRevenueUsd: roundCurrency(
      subscriptionRevenueUsd + Number(charges?.[0]?.usageRevenueUsd || 0),
    ),
    orderxNumberMetaCostUsd: roundCurrency(
      messages?.[0]?.orderxNumberMetaCostUsd || 0,
    ),
    orderxNumberTemplateMessages: Number(
      messages?.[0]?.orderxNumberTemplateMessages || 0,
    ),
    billableOutboundMessages: Number(
      charges?.[0]?.billableOutboundMessages || 0,
    ),
    storesNearCap: storesNearCap
      .map((item) => ({
        shop: safeText(item?.shop),
        planKey: safeText(item?.billing?.planKey),
        cap: roundCurrency(item?.billing?.usageCappedAmount || 0),
        used: roundCurrency(item?.billing?.usageBalanceUsedAmount || 0),
        utilization: roundCurrency(
          Number(item?.billing?.usageCappedAmount || 0) > 0
            ? (Number(item?.billing?.usageBalanceUsedAmount || 0) /
                Number(item?.billing?.usageCappedAmount || 1)) *
                100
            : 0,
          1,
        ),
      }))
      .sort((left, right) => right.utilization - left.utilization)
      .slice(0, 20),
  };
}

export async function listAdminOrderUpdateDispatches(query = {}) {
  const pagination = buildPagination(query);
  const match = {};
  if (safeText(query.shop)) match.shop = safeText(query.shop);
  if (safeText(query.topic)) match.topic = safeText(query.topic);
  if (safeText(query.eventType)) match.eventType = safeText(query.eventType);
  if (safeText(query.status)) match.status = safeText(query.status);
  if (safeText(query.channel)) match.channel = safeText(query.channel);
  if (safeText(query.templateUsed)) match.templateUsed = safeText(query.templateUsed);
  if (safeText(query.phoneE164)) {
    match.phoneE164 = new RegExp(escapeRegex(safeText(query.phoneE164)), "i");
  }
  if (safeText(query.orderLookup)) {
    match.$or = [
      { orderId: safeText(query.orderLookup) },
      { orderGid: safeText(query.orderLookup) },
    ];
  }
  if (safeText(query.webhookId)) match.webhookId = safeText(query.webhookId);
  const dateRange = buildDateRange("createdAt", query.from, query.to);
  if (dateRange) match.createdAt = dateRange.createdAt;
  const total = await OrderUpdateDispatch.countDocuments(match);
  const items = await OrderUpdateDispatch.find(match)
    .sort({ createdAt: -1 })
    .skip(pagination.skip)
    .limit(pagination.pageSize)
    .lean();
  return {
    items: items.map((item) => ({
      id: safeText(item?._id),
      createdAt: toDate(item?.createdAt)?.toISOString() || null,
      shop: safeText(item?.shop),
      topic: safeText(item?.topic),
      eventType: safeText(item?.eventType),
      dedupeKey: safeText(item?.dedupeKey),
      webhookId: item?.webhookId || null,
      orderId: item?.orderId || null,
      orderGid: item?.orderGid || null,
      fulfillmentId: item?.fulfillmentId || null,
      trackingFingerprint: item?.trackingFingerprint || null,
      phoneE164: item?.phoneE164 || null,
      attemptId: item?.attemptId ? String(item.attemptId) : null,
      status: safeText(item?.status),
      skippedReason: item?.skippedReason || null,
      channel: item?.channel || null,
      templateUsed: item?.templateUsed || null,
      waMessageId: item?.waMessageId || null,
      sentAt: toDate(item?.sentAt)?.toISOString() || null,
      errorMessage: item?.errorMessage || null,
      errorMeta: item?.errorMeta || null,
      meta: item?.meta || null,
    })),
    pagination: buildPaginationMeta(
      total,
      pagination.page,
      pagination.pageSize,
      pagination.exportRequested,
    ),
  };
}

export async function listAdminAuditLogs(query = {}) {
  const pagination = buildPagination(query);
  const match = {};
  if (safeText(query.shop)) match.shop = safeText(query.shop);
  if (safeText(query.actor)) match.actor = safeText(query.actor);
  if (safeText(query.action)) match.action = safeText(query.action);
  if (safeText(query.level)) match.level = safeText(query.level);
  if (safeText(query.q)) match.message = new RegExp(escapeRegex(safeText(query.q)), "i");
  const dateRange = buildDateRange("createdAt", query.from, query.to);
  if (dateRange) match.createdAt = dateRange.createdAt;
  const total = await AuditLog.countDocuments(match);
  const items = await AuditLog.find(match)
    .sort({ createdAt: -1 })
    .skip(pagination.skip)
    .limit(pagination.pageSize)
    .lean();
  return {
    items: items.map((item) => ({
      id: safeText(item?._id),
      createdAt: toDate(item?.createdAt)?.toISOString() || null,
      shop: safeText(item?.shop),
      actor: safeText(item?.actor),
      action: safeText(item?.action),
      level: safeText(item?.level),
      message: safeText(item?.message),
      meta: item?.meta || null,
    })),
    pagination: buildPaginationMeta(
      total,
      pagination.page,
      pagination.pageSize,
      pagination.exportRequested,
    ),
  };
}

export async function listAdminBlockedContacts(query = {}) {
  const pagination = buildPagination(query);
  const match = {};
  if (safeText(query.shop)) match.shop = safeText(query.shop);
  if (safeText(query.phoneE164)) {
    match.phoneE164 = new RegExp(escapeRegex(safeText(query.phoneE164)), "i");
  }
  if (safeText(query.note)) match.note = new RegExp(escapeRegex(safeText(query.note)), "i");
  const total = await BlockedContact.countDocuments(match);
  const items = await BlockedContact.find(match)
    .sort({ createdAt: -1 })
    .skip(pagination.skip)
    .limit(pagination.pageSize)
    .lean();
  return {
    items: items.map((item) => ({
      id: safeText(item?._id),
      createdAt: toDate(item?.createdAt)?.toISOString() || null,
      shop: safeText(item?.shop),
      phoneE164: item?.phoneE164 || null,
      note: safeText(item?.note),
    })),
    pagination: buildPaginationMeta(
      total,
      pagination.page,
      pagination.pageSize,
      pagination.exportRequested,
    ),
  };
}

export async function listAdminConversationInitiations(query = {}) {
  const pagination = buildPagination(query);
  const match = {};
  if (safeText(query.scopeType)) match.scopeType = safeText(query.scopeType);
  if (safeText(query.scopeKey)) match.scopeKey = safeText(query.scopeKey);
  if (safeText(query.shop)) match.shop = safeText(query.shop);
  if (safeText(query.toE164)) {
    match.toE164 = new RegExp(escapeRegex(safeText(query.toE164)), "i");
  }
  const dateRange = buildDateRange("lastInitiatedAt", query.from, query.to);
  if (dateRange) match.lastInitiatedAt = dateRange.lastInitiatedAt;
  const total = await ConversationInitiation.countDocuments(match);
  const items = await ConversationInitiation.find(match)
    .sort({ lastInitiatedAt: -1 })
    .skip(pagination.skip)
    .limit(pagination.pageSize)
    .lean();

  const runtimeConfig = await getRuntimeConfig();
  const used = await ConversationInitiation.countDocuments({
    scopeType: "orderx_number",
    lastInitiatedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  });
  const topByonStores = await ConversationInitiation.aggregate([
    {
      $match: {
        scopeType: "own_number",
        lastInitiatedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        shop: { $nin: [null, ""] },
      },
    },
    {
      $group: {
        _id: "$shop",
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1 } },
    { $limit: 10 },
  ]);

  return {
    items: items.map((item) => ({
      id: safeText(item?._id),
      scopeType: safeText(item?.scopeType),
      scopeKey: safeText(item?.scopeKey),
      shop: item?.shop || null,
      toE164: item?.toE164 || null,
      lastInitiatedAt: toDate(item?.lastInitiatedAt)?.toISOString() || null,
    })),
    pagination: buildPaginationMeta(
      total,
      pagination.page,
      pagination.pageSize,
      pagination.exportRequested,
    ),
    summary: {
      sharedSenderUsed: used,
      sharedSenderLimit: Number(
        runtimeConfig?.orderxMaxInitiatedConversations24h || 0,
      ),
      sharedSenderRemaining: Math.max(
        0,
        Number(runtimeConfig?.orderxMaxInitiatedConversations24h || 0) -
          Number(used || 0),
      ),
      topByonStores: topByonStores.map((item) => ({
        shop: safeText(item?._id),
        count: Number(item?.count || 0),
      })),
    },
  };
}

export async function listAdminCountryRates(query = {}) {
  const search = safeText(query.q).toUpperCase();
  const active = normalizeBooleanFilter(query.active);
  const match = {
    ...(search
      ? {
          $or: [
            { countryCode: new RegExp(escapeRegex(search), "i") },
            { countryName: new RegExp(escapeRegex(search), "i") },
          ],
        }
      : {}),
    ...(active !== null ? { active } : {}),
  };
  const items = await CountryMessageRate.find(match).sort({ countryCode: 1 }).lean();
  return {
    items: items.map((item) => ({
      id: safeText(item?._id),
      countryCode: safeText(item?.countryCode),
      countryName: safeText(item?.countryName),
      growthPriceUsd: roundCurrency(item?.growthPriceUsd || 0, 3),
      byonUtilityTemplateUsd: roundCurrency(item?.byonUtilityTemplateUsd || 0, 4),
      active: Boolean(item?.active),
      createdAt: toDate(item?.createdAt)?.toISOString() || null,
      updatedAt: toDate(item?.updatedAt)?.toISOString() || null,
    })),
  };
}

export async function saveAdminCountryRate(input = {}, actor = "admin") {
  const countryCode = safeText(input.countryCode).toUpperCase();
  const countryName = safeText(input.countryName);
  if (!countryCode || !countryName) {
    throw new Error("countryCode and countryName are required");
  }
  const growthPriceUsd = Number(input.growthPriceUsd);
  const byonUtilityTemplateUsd = Number(input.byonUtilityTemplateUsd);
  if (!Number.isFinite(growthPriceUsd) || growthPriceUsd < 0) {
    throw new Error("growthPriceUsd must be a positive number");
  }
  if (!Number.isFinite(byonUtilityTemplateUsd) || byonUtilityTemplateUsd < 0) {
    throw new Error("byonUtilityTemplateUsd must be a positive number");
  }
  const active = input.active !== false;
  const record = await CountryMessageRate.findOneAndUpdate(
    { countryCode },
    {
      $set: {
        countryCode,
        countryName,
        growthPriceUsd,
        byonUtilityTemplateUsd,
        active,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  await logAudit({
    shop: GLOBAL_AUDIT_SCOPE,
    actor,
    action: "country_rate_upsert",
    message: `Country rate updated for ${countryCode}.`,
    meta: {
      countryCode,
      growthPriceUsd,
      byonUtilityTemplateUsd,
      active,
    },
  });

  return record;
}

export async function getAdminRuntimeConfigWithHistory(limit = 50) {
  const [config, history] = await Promise.all([
    getRuntimeConfig({ force: true }),
    AuditLog.find({
      shop: GLOBAL_AUDIT_SCOPE,
      action: { $in: ["runtime_config_update", "country_rate_upsert"] },
    })
      .sort({ createdAt: -1 })
      .limit(clampInteger(limit, 1, 200, 50))
      .lean(),
  ]);
  return {
    config,
    history: history.map((item) => ({
      id: safeText(item?._id),
      createdAt: toDate(item?.createdAt)?.toISOString() || null,
      actor: safeText(item?.actor),
      action: safeText(item?.action),
      level: safeText(item?.level),
      message: safeText(item?.message),
      meta: item?.meta || null,
    })),
  };
}

export async function saveAdminRuntimeConfig(input = {}, actor = "admin") {
  const next = await updateRuntimeConfig({
    orderxMaxInitiatedConversations24h:
      input?.orderxMaxInitiatedConversations24h,
  });
  await logAudit({
    shop: GLOBAL_AUDIT_SCOPE,
    actor,
    action: "runtime_config_update",
    message: "Runtime config updated.",
    meta: next,
  });
  return next;
}

export async function getAdminByonMonitoring() {
  const match = {
    $or: [
      { "whatsappSender.preferenceMode": "own_number" },
      { "whatsappSender.activeMode": "own_number" },
      { "whatsappSender.ownNumber.status": { $ne: "not_started" } },
    ],
  };
  const items = await Shop.find(match)
    .select({
      shop: 1,
      installedAt: 1,
      "whatsappSender.preferenceMode": 1,
      "whatsappSender.activeMode": 1,
      "whatsappSender.ownNumber": 1,
      billing: 1,
    })
    .sort({ installedAt: -1 })
    .lean();

  const statusDistribution = {};
  let webhookSubscribed = 0;
  let webhookNotSubscribed = 0;
  let paused = 0;
  let reauthRequired = 0;
  for (const item of items) {
    const status = safeText(item?.whatsappSender?.ownNumber?.status, "unknown");
    statusDistribution[status] = Number(statusDistribution[status] || 0) + 1;
    if (item?.whatsappSender?.ownNumber?.webhookSubscribedAt) webhookSubscribed += 1;
    else webhookNotSubscribed += 1;
    if (item?.whatsappSender?.ownNumber?.pauseSending) paused += 1;
    if (status === "reauth_required") reauthRequired += 1;
  }

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const monthly = await WaMessageLog.aggregate([
    {
      $match: {
        direction: "outbound",
        senderMode: "own_number",
        createdAt: { $gte: monthStart },
      },
    },
    {
      $group: {
        _id: null,
        templateMessages: {
          $sum: {
            $cond: [
              { $and: [{ $ne: ["$templateName", null] }, { $ne: ["$templateName", ""] }] },
              1,
              0,
            ],
          },
        },
        estimatedMetaCostUsd: { $sum: { $ifNull: ["$estimatedMetaCostUsd", 0] } },
      },
    },
  ]);

  return {
    summary: {
      totalStores: items.length,
      statusDistribution,
      webhookSubscribed,
      webhookNotSubscribed,
      paused,
      reauthRequired,
      templateMessagesThisMonth: Number(monthly?.[0]?.templateMessages || 0),
      estimatedMetaCostUsdThisMonth: roundCurrency(
        monthly?.[0]?.estimatedMetaCostUsd || 0,
      ),
    },
    items: items.map((item) => ({
      shop: safeText(item?.shop),
      installedAt: toDate(item?.installedAt)?.toISOString() || null,
      planKey: safeText(item?.billing?.planKey),
      billingStatus: safeText(item?.billing?.status),
      preferenceMode: safeText(item?.whatsappSender?.preferenceMode),
      activeMode: safeText(item?.whatsappSender?.activeMode),
      ownNumberStatus: safeText(item?.whatsappSender?.ownNumber?.status),
      businessName: safeText(item?.whatsappSender?.ownNumber?.businessName),
      contactName: safeText(item?.whatsappSender?.ownNumber?.contactName),
      contactEmail: safeText(item?.whatsappSender?.ownNumber?.contactEmail),
      requestedPhoneNumber:
        item?.whatsappSender?.ownNumber?.requestedPhoneNumber || null,
      displayPhoneNumber:
        item?.whatsappSender?.ownNumber?.displayPhoneNumber || null,
      wabaId: item?.whatsappSender?.ownNumber?.wabaId || null,
      phoneNumberId: item?.whatsappSender?.ownNumber?.phoneNumberId || null,
      webhookSubscribedAt:
        toDate(item?.whatsappSender?.ownNumber?.webhookSubscribedAt)?.toISOString() ||
        null,
      webhookTestStatus:
        safeText(item?.whatsappSender?.ownNumber?.webhookTestStatus),
      sendErrorStreak: Number(item?.whatsappSender?.ownNumber?.sendErrorStreak || 0),
      pauseSending: Boolean(item?.whatsappSender?.ownNumber?.pauseSending),
      pauseReason: item?.whatsappSender?.ownNumber?.pauseReason || null,
      accessTokenExpiresAt:
        toDate(item?.whatsappSender?.ownNumber?.accessTokenExpiresAt)?.toISOString() ||
        null,
      accessTokenMasked: maskAccessToken(
        item?.whatsappSender?.ownNumber?.accessToken,
      ),
      registrationPinMasked: item?.whatsappSender?.ownNumber?.registrationPin
        ? "••••••"
        : null,
      templates:
        (item?.whatsappSender?.ownNumber?.templates || []).map((tpl) => ({
          key: safeText(tpl?.key),
          templateName: safeText(tpl?.templateName),
          language: safeText(tpl?.language),
          status: safeText(tpl?.status),
          lastCheckedAt: toDate(tpl?.lastCheckedAt)?.toISOString() || null,
          lastError: tpl?.lastError || null,
        })) || [],
    })),
  };
}

export async function getAdminOrderXOperations(referenceDate = new Date()) {
  const monthStart = new Date(referenceDate);
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const [messages, charges, countries, templates, topStores, sharedSender] =
    await Promise.all([
      WaMessageLog.aggregate([
        {
          $match: {
            createdAt: { $gte: monthStart },
            direction: "outbound",
            senderMode: "orderx_number",
          },
        },
        {
          $group: {
            _id: null,
            totalOutboundMessages: { $sum: 1 },
            templateMessages: {
              $sum: {
                $cond: [
                  { $and: [{ $ne: ["$templateName", null] }, { $ne: ["$templateName", ""] }] },
                  1,
                  0,
                ],
              },
            },
            estimatedMetaCostUsd: { $sum: { $ifNull: ["$estimatedMetaCostUsd", 0] } },
          },
        },
      ]),
      BillingUsageCharge.aggregate([
        {
          $match: {
            createdAt: { $gte: monthStart },
            status: "submitted",
            planKey: PLAN_KEYS.ORDERX_METERED_4,
          },
        },
        {
          $group: {
            _id: null,
            usageRevenueUsd: { $sum: { $ifNull: ["$amount", 0] } },
          },
        },
      ]),
      WaMessageLog.aggregate([
        {
          $match: {
            createdAt: { $gte: monthStart },
            direction: "outbound",
            senderMode: "orderx_number",
          },
        },
        {
          $group: {
            _id: "$recipientCountryCode",
            messages: { $sum: 1 },
            metaCostUsd: { $sum: { $ifNull: ["$estimatedMetaCostUsd", 0] } },
            usageRevenueUsd: { $sum: { $ifNull: ["$usageChargeUsd", 0] } },
          },
        },
        { $sort: { messages: -1 } },
        { $limit: 12 },
      ]),
      WaMessageLog.aggregate([
        {
          $match: {
            createdAt: { $gte: monthStart },
            direction: "outbound",
            senderMode: "orderx_number",
            templateName: { $nin: [null, ""] },
          },
        },
        {
          $group: {
            _id: "$templateName",
            messages: { $sum: 1 },
          },
        },
        { $sort: { messages: -1 } },
        { $limit: 10 },
      ]),
      WaMessageLog.aggregate([
        {
          $match: {
            createdAt: { $gte: monthStart },
            direction: "outbound",
            senderMode: "orderx_number",
          },
        },
        {
          $group: {
            _id: "$shop",
            messages: { $sum: 1 },
            metaCostUsd: { $sum: { $ifNull: ["$estimatedMetaCostUsd", 0] } },
            usageRevenueUsd: { $sum: { $ifNull: ["$usageChargeUsd", 0] } },
          },
        },
        { $sort: { usageRevenueUsd: -1, messages: -1 } },
        { $limit: 10 },
      ]),
      getRuntimeConfig(),
    ]);

  const sharedUsed = await ConversationInitiation.countDocuments({
    scopeType: "orderx_number",
    lastInitiatedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  });

  const revenue = Number(charges?.[0]?.usageRevenueUsd || 0);
  const cost = Number(messages?.[0]?.estimatedMetaCostUsd || 0);
  return {
    summary: {
      totalOutboundMessages: Number(messages?.[0]?.totalOutboundMessages || 0),
      templateMessages: Number(messages?.[0]?.templateMessages || 0),
      estimatedMetaCostUsd: roundCurrency(cost),
      usageRevenueUsd: roundCurrency(revenue),
      estimatedGrossMarginUsd: roundCurrency(revenue - cost),
      sharedSenderQuotaUsed: sharedUsed,
      sharedSenderQuotaLimit: Number(
        sharedSender?.orderxMaxInitiatedConversations24h || 0,
      ),
      sharedSenderQuotaRemaining: Math.max(
        0,
        Number(sharedSender?.orderxMaxInitiatedConversations24h || 0) - sharedUsed,
      ),
    },
    topTemplates: templates.map((item) => ({
      templateName: safeText(item?._id, "Unknown"),
      messages: Number(item?.messages || 0),
    })),
    topRecipientCountries: countries.map((item) => ({
      countryCode: safeText(item?._id, "Unknown"),
      messages: Number(item?.messages || 0),
      metaCostUsd: roundCurrency(item?.metaCostUsd || 0),
      usageRevenueUsd: roundCurrency(item?.usageRevenueUsd || 0),
    })),
    topStores: topStores.map((item) => ({
      shop: safeText(item?._id),
      messages: Number(item?.messages || 0),
      metaCostUsd: roundCurrency(item?.metaCostUsd || 0),
      usageRevenueUsd: roundCurrency(item?.usageRevenueUsd || 0),
    })),
  };
}

export async function getAdminDashboardAdditions(referenceDate = new Date()) {
  const monthStart = new Date(referenceDate);
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [senderSplit, countryMix, topTemplates, topRevenueStores, topMessageStores] =
    await Promise.all([
      WaMessageLog.aggregate([
        {
          $match: {
            direction: "outbound",
            createdAt: { $gte: monthStart },
          },
        },
        {
          $group: {
            _id: "$senderMode",
            messages: { $sum: 1 },
            metaCostUsd: { $sum: { $ifNull: ["$estimatedMetaCostUsd", 0] } },
          },
        },
      ]),
      WaMessageLog.aggregate([
        {
          $match: {
            direction: "outbound",
            createdAt: { $gte: monthStart },
          },
        },
        {
          $group: {
            _id: "$recipientCountryCode",
            messages: { $sum: 1 },
            metaCostUsd: { $sum: { $ifNull: ["$estimatedMetaCostUsd", 0] } },
            usageRevenueUsd: { $sum: { $ifNull: ["$usageChargeUsd", 0] } },
          },
        },
        { $sort: { messages: -1 } },
        { $limit: 10 },
      ]),
      WaMessageLog.aggregate([
        {
          $match: {
            direction: "outbound",
            createdAt: { $gte: monthStart },
            templateName: { $nin: [null, ""] },
          },
        },
        {
          $group: {
            _id: "$templateName",
            messages: { $sum: 1 },
          },
        },
        { $sort: { messages: -1 } },
        { $limit: 10 },
      ]),
      BillingUsageCharge.aggregate([
        {
          $match: {
            status: "submitted",
            $or: [{ submittedAt: { $gte: monthStart } }, { createdAt: { $gte: monthStart } }],
          },
        },
        {
          $group: {
            _id: "$shop",
            revenueUsd: { $sum: { $ifNull: ["$amount", 0] } },
          },
        },
        { $sort: { revenueUsd: -1 } },
        { $limit: 10 },
      ]),
      WaMessageLog.aggregate([
        {
          $match: {
            createdAt: { $gte: monthStart },
            direction: "outbound",
          },
        },
        {
          $group: {
            _id: "$shop",
            messages: { $sum: 1 },
          },
        },
        { $sort: { messages: -1 } },
        { $limit: 10 },
      ]),
    ]);

  return {
    senderModeSplit: senderSplit.map((item) => ({
      senderMode: safeText(item?._id, "unknown"),
      messages: Number(item?.messages || 0),
      metaCostUsd: roundCurrency(item?.metaCostUsd || 0),
    })),
    destinationCountryMix: countryMix.map((item) => ({
      countryCode: safeText(item?._id, "Unknown"),
      messages: Number(item?.messages || 0),
      metaCostUsd: roundCurrency(item?.metaCostUsd || 0),
      usageRevenueUsd: roundCurrency(item?.usageRevenueUsd || 0),
    })),
    topTemplates: topTemplates.map((item) => ({
      templateName: safeText(item?._id, "Unknown"),
      messages: Number(item?.messages || 0),
    })),
    topStoresByRevenue: topRevenueStores.map((item) => ({
      shop: safeText(item?._id),
      revenueUsd: roundCurrency(item?.revenueUsd || 0),
    })),
    topStoresByMessageVolume: topMessageStores.map((item) => ({
      shop: safeText(item?._id),
      messages: Number(item?.messages || 0),
    })),
  };
}
