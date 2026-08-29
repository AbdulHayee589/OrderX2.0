import Shop from "../models/Shop.js";
import PlanPurchase from "../models/PlanPurchase.js";
import BillingUsageCharge from "../models/BillingUsageCharge.js";
import ConversationInitiation from "../models/ConversationInitiation.js";
import WaMessageLog from "../models/WaMessageLog.js";
import CodAttempt from "../models/CodAttempt.js";
import Metric from "../models/Metric.js";
import AuditLog from "../models/AuditLog.js";
import { getPlan, PLAN_KEYS } from "./plans.js";
import { getRuntimeConfig } from "./runtimeConfig.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_PLAN_PURCHASE_STATUSES = new Set(["ACTIVE", "ACCEPTED"]);

function clampInteger(value, min, max, fallback) {
  const numeric = Number.parseInt(value, 10);
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
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function startOfMonth(value = new Date()) {
  const date = new Date(value);
  date.setUTCDate(1);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function addMonths(value, amount) {
  const date = new Date(value);
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + amount);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function monthKey(value) {
  const date = toDate(value);
  return date ? date.toISOString().slice(0, 7) : "";
}

function monthLabel(key) {
  const date = toDate(`${key}-01T00:00:00.000Z`);
  if (!date) return key;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function safeText(value, fallback = "") {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function isActiveBillingStatus(shop) {
  const status = String(shop?.billing?.status || "").trim();
  const hardStoppedAt = toDate(shop?.billing?.hardStoppedAt);
  return !hardStoppedAt && (status === "ACTIVE" || status === "TRIAL");
}

function isActivePaidBillingShop(shop) {
  const status = String(shop?.billing?.status || "").trim();
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

function buildActivePurchaseByShop(shops = [], planPurchases = []) {
  const activePurchaseBySubscription = new Map();
  for (const purchase of planPurchases || []) {
    const shop = safeText(purchase?.shop);
    const subscriptionId = safeText(purchase?.subscriptionId);
    const status = safeText(purchase?.status).toUpperCase();
    if (!shop || !subscriptionId) continue;
    if (purchase?.test === true) continue;
    if (toDate(purchase?.endedAt)) continue;
    if (!ACTIVE_PLAN_PURCHASE_STATUSES.has(status)) continue;
    activePurchaseBySubscription.set(`${shop}::${subscriptionId}`, purchase);
  }

  const activeByShop = new Map();
  for (const shop of shops || []) {
    const shopDomain = safeText(shop?.shop);
    const subscriptionId = safeText(shop?.billing?.subscriptionId);
    if (!shopDomain || activeByShop.has(shopDomain)) continue;
    if (!isActivePaidBillingShop(shop)) continue;

    const purchase = activePurchaseBySubscription.get(
      `${shopDomain}::${subscriptionId}`,
    );
    if (!purchase) continue;

    const planKey = safeText(shop?.billing?.planKey, purchase?.planKey);
    const plan = getPlan(planKey);
    const monthlyPriceUsd = roundCurrency(plan?.price || 0);
    if (monthlyPriceUsd <= 0) continue;

    activeByShop.set(shopDomain, {
      shop: shopDomain,
      planKey,
      subscriptionId,
      monthlyPriceUsd,
      purchase,
    });
  }
  return activeByShop;
}

function buildMonthlyBuckets(months) {
  const currentMonthStart = startOfMonth(new Date());
  const buckets = [];
  const monthMap = new Map();

  for (let offset = months - 1; offset >= 0; offset -= 1) {
    const startAt = addMonths(currentMonthStart, -offset);
    const key = monthKey(startAt);
    const bucket = {
      monthKey: key,
      label: monthLabel(key),
      subscriptionRevenueUsd: 0,
      usageRevenueUsd: 0,
      revenueUsd: 0,
      metaCostUsd: 0,
      installs: 0,
      deactivatedStores: 0,
      confirmedSalesUsd: 0,
      savedRevenueUsd: 0,
      savedOrders: 0,
      outboundMessages: 0,
      inboundMessages: 0,
      templateMessages: 0,
      orderxNumberTemplateMessages: 0,
      ownNumberTemplateMessages: 0,
      growthFreeMessages: 0,
    };
    buckets.push(bucket);
    monthMap.set(key, bucket);
  }

  return {
    buckets,
    monthMap,
    startAt: buckets.length ? toDate(`${buckets[0].monthKey}-01T00:00:00.000Z`) : currentMonthStart,
  };
}

function createPlanAccumulator(planKey) {
  const plan = getPlan(planKey);
  return {
    planKey,
    planName: String(plan?.name || planKey || "Unknown plan"),
    monthlyPriceUsd: roundCurrency(plan?.price || 0),
    shopCount: 0,
    activeShopCount: 0,
    estimatedMrrUsd: 0,
    subscriptionRevenueUsd: 0,
    usageRevenueUsd: 0,
    totalRevenueUsd: 0,
  };
}

function getPlanAccumulator(map, planKey) {
  const normalizedKey = String(planKey || PLAN_KEYS.ORDERX_FREE_5);
  if (!map.has(normalizedKey)) {
    map.set(normalizedKey, createPlanAccumulator(normalizedKey));
  }
  return map.get(normalizedKey);
}

async function getInstallCounts(startAt) {
  return Shop.aggregate([
    {
      $match: {
        installedAt: { $gte: startAt },
      },
    },
    {
      $group: {
        _id: {
          $dateToString: {
            format: "%Y-%m",
            date: "$installedAt",
          },
        },
        installs: { $sum: 1 },
      },
    },
  ]);
}

async function getDeactivationCounts(startAt) {
  return Shop.aggregate([
    {
      $match: {
        "billing.hardStoppedAt": { $gte: startAt },
      },
    },
    {
      $group: {
        _id: {
          $dateToString: {
            format: "%Y-%m",
            date: "$billing.hardStoppedAt",
          },
        },
        deactivatedStores: { $sum: 1 },
      },
    },
  ]);
}

async function getUsageRevenueCounts(startAt) {
  return BillingUsageCharge.aggregate([
    {
      $match: {
        status: "submitted",
        $or: [
          { submittedAt: { $gte: startAt } },
          { createdAt: { $gte: startAt } },
        ],
      },
    },
    {
      $project: {
        planKey: 1,
        amount: { $ifNull: ["$amount", 0] },
        monthKey: {
          $dateToString: {
            format: "%Y-%m",
            date: { $ifNull: ["$submittedAt", "$createdAt"] },
          },
        },
      },
    },
    {
      $group: {
        _id: { monthKey: "$monthKey", planKey: "$planKey" },
        revenueUsd: { $sum: "$amount" },
      },
    },
  ]);
}

async function getMessageCounts(startAt) {
  return WaMessageLog.aggregate([
    {
      $match: {
        createdAt: { $gte: startAt },
      },
    },
    {
      $project: {
        direction: 1,
        templateName: 1,
        senderMode: 1,
        usageChargeUsd: { $ifNull: ["$usageChargeUsd", 0] },
        metaCostUsd: { $ifNull: ["$estimatedMetaCostUsd", 0] },
        monthKey: {
          $dateToString: { format: "%Y-%m", date: "$createdAt" },
        },
      },
    },
    {
      $group: {
        _id: "$monthKey",
        outboundMessages: {
          $sum: {
            $cond: [{ $eq: ["$direction", "outbound"] }, 1, 0],
          },
        },
        inboundMessages: {
          $sum: {
            $cond: [{ $eq: ["$direction", "inbound"] }, 1, 0],
          },
        },
        templateMessages: {
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
        orderxNumberTemplateMessages: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$direction", "outbound"] },
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
        ownNumberTemplateMessages: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$direction", "outbound"] },
                  { $eq: ["$senderMode", "own_number"] },
                  { $ne: ["$templateName", null] },
                  { $ne: ["$templateName", ""] },
                ],
              },
              1,
              0,
            ],
          },
        },
        growthFreeMessages: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$direction", "outbound"] },
                  { $lte: ["$usageChargeUsd", 0] },
                ],
              },
              1,
              0,
            ],
          },
        },
        metaCostUsd: { $sum: "$metaCostUsd" },
      },
    },
  ]);
}

async function getConfirmedSales(startAt) {
  return CodAttempt.aggregate([
    {
      $match: {
        confirmedAt: { $gte: startAt },
      },
    },
    {
      $group: {
        _id: {
          $dateToString: {
            format: "%Y-%m",
            date: "$confirmedAt",
          },
        },
        confirmedSalesUsd: { $sum: { $ifNull: ["$orderAmount", 0] } },
      },
    },
  ]);
}

async function getMetricRevenue(startDay) {
  return Metric.aggregate([
    {
      $match: {
        day: { $gte: startDay },
      },
    },
    {
      $group: {
        _id: { $substr: ["$day", 0, 7] },
        savedRevenueUsd: { $sum: { $ifNull: ["$savedRevenue", 0] } },
        savedOrders: { $sum: { $ifNull: ["$savedOrders", 0] } },
      },
    },
  ]);
}

async function getTemplateBreakdown(startAt, options = {}) {
  const senderMode = safeText(options?.senderMode);
  return WaMessageLog.aggregate([
    {
      $match: {
        direction: "outbound",
        createdAt: { $gte: startAt },
        templateName: { $nin: [null, ""] },
        ...(senderMode ? { senderMode } : {}),
      },
    },
    {
      $group: {
        _id: "$templateName",
        outboundMessages: { $sum: 1 },
        metaCostUsd: { $sum: { $ifNull: ["$estimatedMetaCostUsd", 0] } },
        usageRevenueUsd: { $sum: { $ifNull: ["$usageChargeUsd", 0] } },
      },
    },
    { $sort: { outboundMessages: -1 } },
    { $limit: 10 },
  ]);
}

async function getStoreMessageWindow(startAt) {
  return WaMessageLog.aggregate([
    {
      $match: {
        direction: "outbound",
        createdAt: { $gte: startAt },
      },
    },
    {
      $group: {
        _id: "$shop",
        outboundMessages: { $sum: 1 },
        templateMessages: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $ne: ["$templateName", null] },
                  { $ne: ["$templateName", ""] },
                ],
              },
              1,
              0,
            ],
          },
        },
        metaCostUsd: { $sum: { $ifNull: ["$estimatedMetaCostUsd", 0] } },
      },
    },
  ]);
}

async function getStoreUsageWindow(startAt) {
  return BillingUsageCharge.aggregate([
    {
      $match: {
        status: "submitted",
        $or: [
          { submittedAt: { $gte: startAt } },
          { createdAt: { $gte: startAt } },
        ],
      },
    },
    {
      $group: {
        _id: "$shop",
        usageRevenueUsd: { $sum: { $ifNull: ["$amount", 0] } },
        billableMessages: { $sum: { $ifNull: ["$quantity", 1] } },
      },
    },
  ]);
}

async function getStoreSalesWindow(startAt) {
  return CodAttempt.aggregate([
    {
      $match: {
        confirmedAt: { $gte: startAt },
      },
    },
    {
      $group: {
        _id: "$shop",
        confirmedOrders: { $sum: 1 },
        confirmedSalesUsd: { $sum: { $ifNull: ["$orderAmount", 0] } },
      },
    },
  ]);
}

function toMap(rows, keyName = "_id") {
  const map = new Map();
  for (const row of rows || []) {
    map.set(String(row?.[keyName] || ""), row);
  }
  return map;
}

function buildMonthlySubscriptionRevenue(
  planPurchases,
  monthMap,
  planBreakdown,
  { activePurchaseByShop = new Map(), referenceDate = new Date() } = {},
) {
  const selectionsByMonth = new Map();
  const currentMonthKey = monthKey(referenceDate);

  for (const key of monthMap.keys()) {
    selectionsByMonth.set(key, new Map());
  }

  for (const purchase of planPurchases || []) {
    const shop = safeText(purchase?.shop);
    const subscriptionId = safeText(purchase?.subscriptionId);
    const planKey = safeText(purchase?.planKey);
    const plan = getPlan(planKey);
    const planPriceUsd = roundCurrency(plan?.price || 0);
    if (!shop || !subscriptionId || planPriceUsd <= 0) continue;
    if (purchase?.test === true) continue;

    const startAt = toDate(purchase?.startedAt);
    const endedAt = toDate(purchase?.endedAt);
    const endAt = endedAt || referenceDate;
    if (!startAt || !endAt || endAt <= startAt) continue;

    for (const key of monthMap.keys()) {
      const bucketStart = toDate(`${key}-01T00:00:00.000Z`);
      const bucketEnd = addMonths(bucketStart, 1);
      if (startAt >= bucketEnd || endAt <= bucketStart) continue;

      const activePurchase = activePurchaseByShop.get(shop);
      if (key === currentMonthKey) {
        if (!activePurchase) continue;
        if (activePurchase.subscriptionId !== subscriptionId) continue;
      }

      const monthSelections = selectionsByMonth.get(key);
      const current = monthSelections.get(shop);
      const currentStartedAt = toDate(current?.startedAt);
      if (!current || (currentStartedAt && startAt > currentStartedAt)) {
        monthSelections.set(shop, purchase);
      }
    }
  }

  for (const [key, monthSelections] of selectionsByMonth.entries()) {
    const bucket = monthMap.get(key);
    if (!bucket) continue;
    for (const purchase of monthSelections.values()) {
      const plan = getPlan(purchase?.planKey);
      const planPriceUsd = roundCurrency(plan?.price || 0);
      if (planPriceUsd <= 0) continue;

      bucket.subscriptionRevenueUsd += planPriceUsd;
      bucket.revenueUsd += planPriceUsd;

      const accumulator = getPlanAccumulator(planBreakdown, purchase?.planKey);
      accumulator.subscriptionRevenueUsd += planPriceUsd;
      accumulator.totalRevenueUsd += planPriceUsd;
    }
  }
}

export async function getAdminDashboardData(options = {}) {
  const months = clampInteger(options?.months, 1, 18, 6);
  const storeLimit = clampInteger(options?.storeLimit, 5, 100, 24);
  const { buckets, monthMap, startAt } = buildMonthlyBuckets(months);
  const startDay = `${monthKey(startAt)}-01`;
  const storesWindowStart = new Date(Date.now() - 30 * DAY_MS);

  const [
    shops,
    planPurchases,
    installRows,
    deactivationRows,
    usageRows,
    messageRows,
    confirmedRows,
    metricRows,
    templateRows,
    orderxTemplateRows,
    storeMessageRows,
    storeUsageRows,
    storeSalesRows,
    runtimeConfig,
    sharedSenderUsed24h,
    totalShops,
  ] = await Promise.all([
    Shop.find({})
      .select({
        shop: 1,
        installedAt: 1,
        createdAt: 1,
        storeCountryCode: 1,
        storeCurrencyCode: 1,
        accessToken: 1,
        billing: 1,
        whatsappSender: 1,
      })
      .lean(),
    PlanPurchase.find({}).lean(),
    getInstallCounts(startAt),
    getDeactivationCounts(startAt),
    getUsageRevenueCounts(startAt),
    getMessageCounts(startAt),
    getConfirmedSales(startAt),
    getMetricRevenue(startDay),
    getTemplateBreakdown(startAt),
    getTemplateBreakdown(startAt, { senderMode: "orderx_number" }),
    getStoreMessageWindow(storesWindowStart),
    getStoreUsageWindow(storesWindowStart),
    getStoreSalesWindow(storesWindowStart),
    getRuntimeConfig(),
    ConversationInitiation.countDocuments({
      scopeType: "orderx_number",
      lastInitiatedAt: { $gte: new Date(Date.now() - DAY_MS) },
    }),
    Shop.countDocuments(),
  ]);

  const planBreakdown = new Map();
  const activeShops = shops.filter(isActiveBillingStatus);
  const activePurchaseByShop = buildActivePurchaseByShop(shops, planPurchases);
  const growthPlanKey = PLAN_KEYS.ORDERX_METERED_4;
  const growthShopSet = new Set();

  for (const shop of shops) {
    const shopDomain = String(shop?.shop || "");
    const planKey = String(shop?.billing?.planKey || PLAN_KEYS.ORDERX_FREE_5);
    const accumulator = getPlanAccumulator(planBreakdown, planKey);
    accumulator.shopCount += 1;
    if (isActiveBillingStatus(shop)) {
      accumulator.activeShopCount += 1;
    }
    const activePurchase = activePurchaseByShop.get(shopDomain);
    if (activePurchase?.planKey === planKey) {
      accumulator.estimatedMrrUsd += roundCurrency(
        activePurchase.monthlyPriceUsd || 0,
      );
    }
    if (planKey === growthPlanKey) {
      growthShopSet.add(shopDomain);
    }
  }

  buildMonthlySubscriptionRevenue(planPurchases, monthMap, planBreakdown, {
    activePurchaseByShop,
    referenceDate: new Date(),
  });

  for (const row of installRows) {
    const bucket = monthMap.get(String(row?._id || ""));
    if (bucket) {
      bucket.installs = Number(row?.installs || 0);
    }
  }

  for (const row of deactivationRows) {
    const bucket = monthMap.get(String(row?._id || ""));
    if (bucket) {
      bucket.deactivatedStores = Number(row?.deactivatedStores || 0);
    }
  }

  for (const row of usageRows) {
    const key = String(row?._id?.monthKey || "");
    const planKey = String(row?._id?.planKey || PLAN_KEYS.ORDERX_FREE_5);
    const revenueUsd = roundCurrency(row?.revenueUsd || 0);
    const bucket = monthMap.get(key);
    if (bucket) {
      bucket.usageRevenueUsd += revenueUsd;
      bucket.revenueUsd += revenueUsd;
    }
    const accumulator = getPlanAccumulator(planBreakdown, planKey);
    accumulator.usageRevenueUsd += revenueUsd;
    accumulator.totalRevenueUsd += revenueUsd;
  }

  for (const row of messageRows) {
    const bucket = monthMap.get(String(row?._id || ""));
    if (!bucket) continue;
    bucket.outboundMessages = Number(row?.outboundMessages || 0);
    bucket.inboundMessages = Number(row?.inboundMessages || 0);
    bucket.templateMessages = Number(row?.templateMessages || 0);
    bucket.orderxNumberTemplateMessages = Number(
      row?.orderxNumberTemplateMessages || 0,
    );
    bucket.ownNumberTemplateMessages = Number(
      row?.ownNumberTemplateMessages || 0,
    );
    bucket.growthFreeMessages = Number(row?.growthFreeMessages || 0);
    bucket.metaCostUsd = roundCurrency(row?.metaCostUsd || 0);
  }

  for (const row of confirmedRows) {
    const bucket = monthMap.get(String(row?._id || ""));
    if (bucket) {
      bucket.confirmedSalesUsd = roundCurrency(row?.confirmedSalesUsd || 0);
    }
  }

  for (const row of metricRows) {
    const bucket = monthMap.get(String(row?._id || ""));
    if (bucket) {
      bucket.savedRevenueUsd = roundCurrency(row?.savedRevenueUsd || 0);
      bucket.savedOrders = Number(row?.savedOrders || 0);
    }
  }

  const currentMonth = buckets[buckets.length - 1] || null;
  const previousMonth = buckets[buckets.length - 2] || null;

  const storeMessageMap = toMap(storeMessageRows);
  const storeUsageMap = toMap(storeUsageRows);
  const storeSalesMap = toMap(storeSalesRows);

  const stores = shops
    .map((shop) => {
      const shopKey = String(shop?.shop || "");
      const messageStats = storeMessageMap.get(shopKey) || {};
      const usageStats = storeUsageMap.get(shopKey) || {};
      const salesStats = storeSalesMap.get(shopKey) || {};
      const planKey = String(shop?.billing?.planKey || PLAN_KEYS.ORDERX_FREE_5);
      const currentPlan = getPlan(planKey);
      const activePurchase = activePurchaseByShop.get(shopKey);
      return {
        shop: shopKey,
        planKey,
        planName: String(currentPlan?.name || planKey),
        billingStatus: String(shop?.billing?.status || "NONE"),
        installedAt: toDate(shop?.installedAt || shop?.createdAt)?.toISOString() || null,
        currentPeriodEnd: toDate(shop?.billing?.currentPeriodEnd)?.toISOString() || null,
        cancelAtPeriodEnd: Boolean(shop?.billing?.cancelAtPeriodEnd),
        cancelledAt: toDate(shop?.billing?.cancelledAt)?.toISOString() || null,
        hardStoppedAt: toDate(shop?.billing?.hardStoppedAt)?.toISOString() || null,
        senderMode:
          String(shop?.whatsappSender?.activeMode || "") ||
          String(currentPlan?.senderMode || ""),
        storeCountryCode: shop?.storeCountryCode || null,
        storeCurrencyCode: shop?.storeCurrencyCode || null,
        currentMonthlyPriceUsd: roundCurrency(
          activePurchase?.planKey === planKey
            ? activePurchase.monthlyPriceUsd || 0
            : 0,
        ),
        outboundMessages30d: Number(messageStats?.outboundMessages || 0),
        templateMessages30d: Number(messageStats?.templateMessages || 0),
        metaCostUsd30d: roundCurrency(messageStats?.metaCostUsd || 0),
        usageRevenueUsd30d: roundCurrency(usageStats?.usageRevenueUsd || 0),
        billableMessages30d: Number(usageStats?.billableMessages || 0),
        confirmedOrders30d: Number(salesStats?.confirmedOrders || 0),
        confirmedSalesUsd30d: roundCurrency(salesStats?.confirmedSalesUsd || 0),
        hasAccessToken: Boolean(shop?.accessToken),
        active: isActiveBillingStatus(shop),
      };
    })
    .sort((left, right) => {
      const rightRevenue =
        Number(right?.usageRevenueUsd30d || 0) +
        Number(right?.currentMonthlyPriceUsd || 0);
      const leftRevenue =
        Number(left?.usageRevenueUsd30d || 0) +
        Number(left?.currentMonthlyPriceUsd || 0);
      return rightRevenue - leftRevenue;
    })
    .slice(0, storeLimit);

  const growthMessageStats = await WaMessageLog.aggregate([
    {
      $match: {
        direction: "outbound",
        shop: { $in: [...growthShopSet] },
      },
    },
    {
      $group: {
        _id: null,
        templateMessages: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $ne: ["$templateName", null] },
                  { $ne: ["$templateName", ""] },
                ],
              },
              1,
              0,
            ],
          },
        },
        freeMessages: {
          $sum: {
            $cond: [{ $lte: [{ $ifNull: ["$usageChargeUsd", 0] }, 0] }, 1, 0],
          },
        },
      },
    },
  ]);

  const growthStats = growthMessageStats[0] || {};

  const overview = {
    totalShops: Number(totalShops || shops.length || 0),
    activeShops: activeShops.length,
    installsThisMonth: Number(currentMonth?.installs || 0),
    estimatedRevenueThisMonthUsd: roundCurrency(currentMonth?.revenueUsd || 0),
    estimatedRevenueLastMonthUsd: roundCurrency(previousMonth?.revenueUsd || 0),
    metaCostThisMonthUsd: roundCurrency(currentMonth?.metaCostUsd || 0),
    totalMetaCostUsd: roundCurrency(
      buckets.reduce((sum, bucket) => sum + Number(bucket.metaCostUsd || 0), 0),
    ),
    totalConfirmedSalesUsd: roundCurrency(
      buckets.reduce(
        (sum, bucket) => sum + Number(bucket.confirmedSalesUsd || 0),
        0,
      ),
    ),
    totalSavedRevenueUsd: roundCurrency(
      buckets.reduce((sum, bucket) => sum + Number(bucket.savedRevenueUsd || 0), 0),
    ),
    totalSavedOrders: buckets.reduce(
      (sum, bucket) => sum + Number(bucket.savedOrders || 0),
      0,
    ),
    totalOutboundMessages: buckets.reduce(
      (sum, bucket) => sum + Number(bucket.outboundMessages || 0),
      0,
    ),
    totalTemplateMessages: buckets.reduce(
      (sum, bucket) => sum + Number(bucket.templateMessages || 0),
      0,
    ),
    growthTemplateMessages: Number(growthStats?.templateMessages || 0),
    growthFreeMessages: Number(growthStats?.freeMessages || 0),
    sharedSenderQuota24h: {
      used: Number(sharedSenderUsed24h || 0),
      limit: Number(runtimeConfig?.orderxMaxInitiatedConversations24h || 0),
      remaining: Math.max(
        0,
        Number(runtimeConfig?.orderxMaxInitiatedConversations24h || 0) -
          Number(sharedSenderUsed24h || 0),
      ),
    },
  };

  const normalizedPlanBreakdown = [...planBreakdown.values()]
    .map((item) => ({
      ...item,
      estimatedMrrUsd: roundCurrency(item.estimatedMrrUsd),
      subscriptionRevenueUsd: roundCurrency(item.subscriptionRevenueUsd),
      usageRevenueUsd: roundCurrency(item.usageRevenueUsd),
      totalRevenueUsd: roundCurrency(item.totalRevenueUsd),
    }))
    .sort((left, right) => right.totalRevenueUsd - left.totalRevenueUsd);

  const monthlyTrend = buckets.map((bucket) => ({
    ...bucket,
    subscriptionRevenueUsd: roundCurrency(bucket.subscriptionRevenueUsd),
    usageRevenueUsd: roundCurrency(bucket.usageRevenueUsd),
    revenueUsd: roundCurrency(bucket.revenueUsd),
    metaCostUsd: roundCurrency(bucket.metaCostUsd),
    confirmedSalesUsd: roundCurrency(bucket.confirmedSalesUsd),
    savedRevenueUsd: roundCurrency(bucket.savedRevenueUsd),
  }));

  const templateBreakdown = (templateRows || []).map((row) => ({
    templateName: String(row?._id || "Unknown template"),
    outboundMessages: Number(row?.outboundMessages || 0),
    metaCostUsd: roundCurrency(row?.metaCostUsd || 0),
    usageRevenueUsd: roundCurrency(row?.usageRevenueUsd || 0),
  }));

  const orderxTemplateBreakdown = (orderxTemplateRows || []).map((row) => ({
    templateName: String(row?._id || "Unknown template"),
    outboundMessages: Number(row?.outboundMessages || 0),
    metaCostUsd: roundCurrency(row?.metaCostUsd || 0),
    usageRevenueUsd: roundCurrency(row?.usageRevenueUsd || 0),
  }));

  return {
    generatedAt: new Date().toISOString(),
    range: {
      months,
      fromMonth: monthlyTrend[0]?.monthKey || null,
      toMonth: currentMonth?.monthKey || null,
      storeLookbackDays: 30,
    },
    overview,
    monthlyTrend,
    monthlyRecords: monthlyTrend,
    planBreakdown: normalizedPlanBreakdown,
    templateBreakdown,
    orderxTemplateBreakdown,
    stores,
    config: runtimeConfig,
  };
}

function sanitizeShopRecord(shop) {
  return {
    shop: safeText(shop?.shop),
    installedAt: toDate(shop?.installedAt || shop?.createdAt)?.toISOString() || null,
    updatedAt: toDate(shop?.updatedAt)?.toISOString() || null,
    accessTokenUpdatedAt:
      toDate(shop?.accessTokenUpdatedAt)?.toISOString() || null,
    storeCountryName: shop?.storeCountryName || null,
    storeCountryCode: shop?.storeCountryCode || null,
    storeCurrencyCode: shop?.storeCurrencyCode || null,
    storeContextSyncedAt:
      toDate(shop?.storeContextSyncedAt)?.toISOString() || null,
    hasAccessToken: Boolean(shop?.accessToken),
    accessTokenMasked: shop?.accessToken ? "••••••••" : null,
    scopes: safeText(shop?.scopes),
    settings: shop?.settings || {},
    diagnostics: shop?.diagnostics || {},
    billing: shop?.billing || {},
    whatsappSender: {
      preferenceMode: shop?.whatsappSender?.preferenceMode || null,
      activeMode: shop?.whatsappSender?.activeMode || null,
      ownNumber: {
        status: shop?.whatsappSender?.ownNumber?.status || null,
        businessName: shop?.whatsappSender?.ownNumber?.businessName || "",
        contactName: shop?.whatsappSender?.ownNumber?.contactName || "",
        contactEmail: shop?.whatsappSender?.ownNumber?.contactEmail || "",
        displayPhoneNumber:
          shop?.whatsappSender?.ownNumber?.displayPhoneNumber || "",
        requestedPhoneNumber:
          shop?.whatsappSender?.ownNumber?.requestedPhoneNumber || "",
        metaBusinessId: shop?.whatsappSender?.ownNumber?.metaBusinessId || null,
        wabaId: shop?.whatsappSender?.ownNumber?.wabaId || null,
        phoneNumberId: shop?.whatsappSender?.ownNumber?.phoneNumberId || null,
        accessTokenMasked: shop?.whatsappSender?.ownNumber?.accessToken
          ? "••••••••"
          : null,
        accessTokenUpdatedAt:
          toDate(
            shop?.whatsappSender?.ownNumber?.accessTokenUpdatedAt,
          )?.toISOString() || null,
        accessTokenExpiresAt:
          toDate(
            shop?.whatsappSender?.ownNumber?.accessTokenExpiresAt,
          )?.toISOString() || null,
        accessTokenRefreshAttemptedAt:
          toDate(
            shop?.whatsappSender?.ownNumber?.accessTokenRefreshAttemptedAt,
          )?.toISOString() || null,
        accessTokenRefreshError:
          shop?.whatsappSender?.ownNumber?.accessTokenRefreshError || null,
        accessTokenRefreshErrorAt:
          toDate(
            shop?.whatsappSender?.ownNumber?.accessTokenRefreshErrorAt,
          )?.toISOString() || null,
        registrationStatus:
          shop?.whatsappSender?.ownNumber?.registrationStatus || null,
        registrationPinMasked:
          shop?.whatsappSender?.ownNumber?.registrationPin ? "••••••" : null,
        registrationLastAttemptAt:
          toDate(
            shop?.whatsappSender?.ownNumber?.registrationLastAttemptAt,
          )?.toISOString() || null,
        registrationError:
          shop?.whatsappSender?.ownNumber?.registrationError || null,
        registrationErrorAt:
          toDate(
            shop?.whatsappSender?.ownNumber?.registrationErrorAt,
          )?.toISOString() || null,
        registrationRegisteredAt:
          toDate(
            shop?.whatsappSender?.ownNumber?.registrationRegisteredAt,
          )?.toISOString() || null,
        webhookSubscribedAt:
          toDate(
            shop?.whatsappSender?.ownNumber?.webhookSubscribedAt,
          )?.toISOString() || null,
        webhookSubscriptionError:
          shop?.whatsappSender?.ownNumber?.webhookSubscriptionError || null,
        webhookSubscriptionErrorAt:
          toDate(
            shop?.whatsappSender?.ownNumber?.webhookSubscriptionErrorAt,
          )?.toISOString() || null,
        webhookTestStatus:
          shop?.whatsappSender?.ownNumber?.webhookTestStatus || null,
        webhookTestTargetPhoneE164:
          shop?.whatsappSender?.ownNumber?.webhookTestTargetPhoneE164 || "",
        webhookTestExpectedReplyCode:
          shop?.whatsappSender?.ownNumber?.webhookTestExpectedReplyCode || "",
        webhookTestSentAt:
          toDate(
            shop?.whatsappSender?.ownNumber?.webhookTestSentAt,
          )?.toISOString() || null,
        webhookTestOutboundMessageId:
          shop?.whatsappSender?.ownNumber?.webhookTestOutboundMessageId || null,
        webhookTestReplyReceivedAt:
          toDate(
            shop?.whatsappSender?.ownNumber?.webhookTestReplyReceivedAt,
          )?.toISOString() || null,
        webhookTestReplyMessageId:
          shop?.whatsappSender?.ownNumber?.webhookTestReplyMessageId || null,
        webhookTestReplyText:
          shop?.whatsappSender?.ownNumber?.webhookTestReplyText || "",
        webhookTestLastError:
          shop?.whatsappSender?.ownNumber?.webhookTestLastError || null,
        webhookTestLastErrorAt:
          toDate(
            shop?.whatsappSender?.ownNumber?.webhookTestLastErrorAt,
          )?.toISOString() || null,
        sendErrorStreak:
          Number(shop?.whatsappSender?.ownNumber?.sendErrorStreak || 0),
        lastSendError: shop?.whatsappSender?.ownNumber?.lastSendError || null,
        lastSendErrorAt:
          toDate(
            shop?.whatsappSender?.ownNumber?.lastSendErrorAt,
          )?.toISOString() || null,
        pauseSending: Boolean(shop?.whatsappSender?.ownNumber?.pauseSending),
        pauseReason: shop?.whatsappSender?.ownNumber?.pauseReason || null,
        pauseSetAt:
          toDate(shop?.whatsappSender?.ownNumber?.pauseSetAt)?.toISOString() ||
          null,
        testMessageSentAt:
          toDate(
            shop?.whatsappSender?.ownNumber?.testMessageSentAt,
          )?.toISOString() || null,
        testMessageTargetPhoneE164:
          shop?.whatsappSender?.ownNumber?.testMessageTargetPhoneE164 || "",
        testMessageOutboundMessageId:
          shop?.whatsappSender?.ownNumber?.testMessageOutboundMessageId || null,
        testMessageStatus:
          shop?.whatsappSender?.ownNumber?.testMessageStatus || null,
        testMessageStatusAt:
          toDate(
            shop?.whatsappSender?.ownNumber?.testMessageStatusAt,
          )?.toISOString() || null,
        testMessageLastError:
          shop?.whatsappSender?.ownNumber?.testMessageLastError || null,
        testMessageLastErrorAt:
          toDate(
            shop?.whatsappSender?.ownNumber?.testMessageLastErrorAt,
          )?.toISOString() || null,
        onboardingCompletedAt:
          toDate(
            shop?.whatsappSender?.ownNumber?.onboardingCompletedAt,
          )?.toISOString() || null,
        pendingConnectState:
          shop?.whatsappSender?.ownNumber?.pendingConnectState || null,
        pendingConnectStateExpiresAt:
          toDate(
            shop?.whatsappSender?.ownNumber?.pendingConnectStateExpiresAt,
          )?.toISOString() || null,
        templatesLastSyncedAt:
          toDate(
            shop?.whatsappSender?.ownNumber?.templatesLastSyncedAt,
          )?.toISOString() || null,
        templateLanguage:
          shop?.whatsappSender?.ownNumber?.templateLanguage || null,
        readyAt:
          toDate(shop?.whatsappSender?.ownNumber?.readyAt)?.toISOString() || null,
        startedAt:
          toDate(shop?.whatsappSender?.ownNumber?.startedAt)?.toISOString() ||
          null,
        detailsSubmittedAt:
          toDate(
            shop?.whatsappSender?.ownNumber?.detailsSubmittedAt,
          )?.toISOString() || null,
        metaConnectedAt:
          toDate(shop?.whatsappSender?.ownNumber?.metaConnectedAt)?.toISOString() ||
          null,
        templatesReadyAt:
          toDate(
            shop?.whatsappSender?.ownNumber?.templatesReadyAt,
          )?.toISOString() || null,
        onboardingError:
          shop?.whatsappSender?.ownNumber?.lastError || null,
        onboardingErrorAt:
          toDate(shop?.whatsappSender?.ownNumber?.lastErrorAt)?.toISOString() ||
          null,
        templates:
          (shop?.whatsappSender?.ownNumber?.templates || []).map((item) => ({
            key: item?.key || "",
            templateName: item?.templateName || "",
            language: item?.language || "",
            status: item?.status || "",
            lastCheckedAt:
              toDate(item?.lastCheckedAt)?.toISOString() || null,
            lastError: item?.lastError || null,
          })) || [],
      },
    },
  };
}

function buildStoreLifecycle(shopRecord, planPurchases, auditLogs) {
  const events = [];
  const shopName = safeText(shopRecord?.shop);

  if (shopRecord?.installedAt || shopRecord?.createdAt) {
    events.push({
      at: toDate(shopRecord?.installedAt || shopRecord?.createdAt)?.toISOString(),
      type: "install",
      title: "App installed",
      detail: `Store ${shopName} installed OrderX.`,
    });
  }

  for (const purchase of planPurchases || []) {
    events.push({
      at: toDate(purchase?.startedAt)?.toISOString() || null,
      type: "plan_started",
      title: `Plan started: ${safeText(purchase?.planKey)}`,
      detail: `Subscription ${safeText(purchase?.subscriptionId)} became active.`,
    });
    if (purchase?.endedAt) {
      events.push({
        at: toDate(purchase?.endedAt)?.toISOString() || null,
        type: "plan_ended",
        title: `Plan ended: ${safeText(purchase?.planKey)}`,
        detail: `Status ${safeText(purchase?.status, "unknown")}.`,
      });
    }
  }

  if (shopRecord?.billing?.cancelledAt) {
    events.push({
      at: toDate(shopRecord.billing.cancelledAt)?.toISOString() || null,
      type: "billing_cancelled",
      title: "Billing cancelled",
      detail: shopRecord?.billing?.cancelAtPeriodEnd
        ? "Cancellation scheduled at period end."
        : "Billing access ended.",
    });
  }

  if (shopRecord?.billing?.hardStoppedAt) {
    events.push({
      at: toDate(shopRecord.billing.hardStoppedAt)?.toISOString() || null,
      type: "deactivated",
      title: shopRecord?.accessToken ? "Store deactivated" : "App uninstalled or access revoked",
      detail: shopRecord?.accessToken
        ? "Billing or access hard-stopped."
        : "Access token removed and sending disabled.",
    });
  }

  for (const audit of auditLogs || []) {
    events.push({
      at: toDate(audit?.createdAt)?.toISOString() || null,
      type: `audit:${safeText(audit?.action)}`,
      title: safeText(audit?.action),
      detail: safeText(audit?.message, "Audit event recorded."),
      level: safeText(audit?.level, "info"),
    });
  }

  return events
    .filter((item) => item.at)
    .sort((left, right) => new Date(right.at) - new Date(left.at));
}

export async function getAdminStoreDetail(shop, options = {}) {
  const shopDomain = safeText(shop);
  if (!shopDomain) {
    throw new Error("Missing shop");
  }

  const messageLimit = clampInteger(options?.messageLimit, 10, 250, 120);
  const attemptLimit = clampInteger(options?.attemptLimit, 10, 250, 100);
  const auditLimit = clampInteger(options?.auditLimit, 10, 250, 100);
  const dayMetricLimit = clampInteger(options?.dayMetricLimit, 10, 180, 90);

  const [shopRecord, planPurchases, messages, attempts, auditLogs, dailyMetrics] =
    await Promise.all([
      Shop.findOne({ shop: shopDomain }).lean(),
      PlanPurchase.find({ shop: shopDomain }).sort({ startedAt: -1 }).lean(),
      WaMessageLog.find({ shop: shopDomain })
        .sort({ createdAt: -1 })
        .limit(messageLimit)
        .lean(),
      CodAttempt.find({ shop: shopDomain })
        .sort({ createdAt: -1 })
        .limit(attemptLimit)
        .lean(),
      AuditLog.find({ shop: shopDomain }).sort({ createdAt: -1 }).limit(auditLimit).lean(),
      Metric.find({ shop: shopDomain }).sort({ day: -1 }).limit(dayMetricLimit).lean(),
    ]);

  if (!shopRecord) {
    throw new Error("Store not found");
  }

  const currentPlan = getPlan(shopRecord?.billing?.planKey || PLAN_KEYS.ORDERX_FREE_5);
  const outboundMessages = messages.filter((item) => item.direction === "outbound");
  const inboundMessages = messages.filter((item) => item.direction === "inbound");
  const lifecycle = buildStoreLifecycle(shopRecord, planPurchases, auditLogs);

  return {
    shop: sanitizeShopRecord(shopRecord),
    currentPlan: {
      key: safeText(shopRecord?.billing?.planKey || PLAN_KEYS.ORDERX_FREE_5),
      name: safeText(currentPlan?.name, shopRecord?.billing?.planKey || PLAN_KEYS.ORDERX_FREE_5),
      monthlyPriceUsd: roundCurrency(currentPlan?.price || 0),
      status: safeText(shopRecord?.billing?.status, "NONE"),
      cancelAtPeriodEnd: Boolean(shopRecord?.billing?.cancelAtPeriodEnd),
      currentPeriodStart:
        toDate(shopRecord?.billing?.currentPeriodStart)?.toISOString() || null,
      currentPeriodEnd:
        toDate(shopRecord?.billing?.currentPeriodEnd)?.toISOString() || null,
      cancelledAt:
        toDate(shopRecord?.billing?.cancelledAt)?.toISOString() || null,
      hardStoppedAt:
        toDate(shopRecord?.billing?.hardStoppedAt)?.toISOString() || null,
    },
    counts: {
      recentOutboundMessages: outboundMessages.length,
      recentInboundMessages: inboundMessages.length,
      recentAttempts: attempts.length,
      recentAuditEvents: auditLogs.length,
    },
    lifecycle,
    planHistory: planPurchases.map((item) => ({
      planKey: safeText(item?.planKey),
      subscriptionId: safeText(item?.subscriptionId),
      status: safeText(item?.status),
      source: safeText(item?.source),
      test: Boolean(item?.test),
      startedAt: toDate(item?.startedAt)?.toISOString() || null,
      currentPeriodEnd: toDate(item?.currentPeriodEnd)?.toISOString() || null,
      endedAt: toDate(item?.endedAt)?.toISOString() || null,
      createdAt: toDate(item?.createdAt)?.toISOString() || null,
    })),
    messages: messages.map((item) => ({
      id: safeText(item?._id),
      direction: safeText(item?.direction),
      kind: safeText(item?.kind),
      text: safeText(item?.text),
      templateName: item?.templateName || null,
      senderMode: item?.senderMode || null,
      senderPhoneNumberId: item?.senderPhoneNumberId || null,
      waMessageId: item?.waMessageId || null,
      toE164: item?.toE164 || null,
      orderGid: item?.orderGid || null,
      metaCostUsd: roundCurrency(item?.estimatedMetaCostUsd || 0),
      usageChargeUsd: roundCurrency(item?.usageChargeUsd || 0),
      createdAt: toDate(item?.createdAt)?.toISOString() || null,
      meta: item?.meta || null,
    })),
    attempts: attempts.map((item) => ({
      id: safeText(item?._id),
      orderName: safeText(item?.orderName),
      orderAmount: roundCurrency(item?.orderAmount || 0),
      orderCurrency: item?.orderCurrency || null,
      customerName: safeText(item?.customerName),
      phoneE164: item?.phoneE164 || null,
      stage: item?.stage || null,
      status: item?.status || null,
      senderMode: item?.senderMode || null,
      waTemplateUsed: item?.waTemplateUsed || null,
      retryCount: Number(item?.retryCount || 0),
      changeState: item?.changeState || null,
      supportInfoCount: Number(item?.supportInfoCount || 0),
      lastError: item?.lastError || null,
      createdAt: toDate(item?.createdAt)?.toISOString() || null,
      confirmedAt: toDate(item?.confirmedAt)?.toISOString() || null,
      cancelledAt: toDate(item?.cancelledAt)?.toISOString() || null,
      waSentAt: toDate(item?.waSentAt)?.toISOString() || null,
    })),
    auditLogs: auditLogs.map((item) => ({
      id: safeText(item?._id),
      actor: safeText(item?.actor),
      action: safeText(item?.action),
      level: safeText(item?.level),
      message: safeText(item?.message),
      createdAt: toDate(item?.createdAt)?.toISOString() || null,
      meta: item?.meta || null,
    })),
    dailyMetrics: dailyMetrics.map((item) => ({
      day: safeText(item?.day),
      waMessagesSent: Number(item?.waMessagesSent || 0),
      waTemplateMessagesSent: Number(item?.waTemplateMessagesSent || 0),
      waBillableConfirmationMessagesSent: Number(
        item?.waBillableConfirmationMessagesSent || 0,
      ),
      savedOrders: Number(item?.savedOrders || 0),
      savedRevenue: roundCurrency(item?.savedRevenue || 0),
    })),
  };
}
