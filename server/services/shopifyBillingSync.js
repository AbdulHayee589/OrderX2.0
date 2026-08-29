import Shop from "../models/Shop.js";
import PlanPurchase from "../models/PlanPurchase.js";
import { getAdminClient } from "../utils/shopifyAdmin.js";
import { resolveRecurringCycleWindow } from "./billing.js";
import {
  getPlan,
  PLAN_BILLING_TYPES,
  PLAN_KEYS,
  SENDER_MODES,
} from "./plans.js";

const KNOWN_PLANS = new Set([
  "orderx_free_5",
  "orderx_metered_4",
  "own_number_starter_5",
  "own_number_scale_10",
  "own_number_flat_8",
  "own_number_unlimited_15",
  "lite_20",
  "basic_50",
  "starter_100",
  "medium_200",
  "growth_300",
  "plus_400",
  "pro_500",
  "scale_1000",
  "enterprise_2000",
]);

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["ACTIVE", "ACCEPTED"]);
const FORCED_TEST_BILLING_SHOP_PLAN_NAMES = new Set([
  "development",
  "shop component",
  "staff business",
]);

function normalizeShopPlanName(value = "") {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function getShopPlanMeta(shopPlan = {}) {
  const publicDisplayName = String(shopPlan?.publicDisplayName || "").trim();
  const displayName = String(shopPlan?.displayName || "").trim();
  const planName = publicDisplayName || displayName || null;
  const normalizedPlanName = normalizeShopPlanName(planName);
  const partnerDevelopment = shopPlan?.partnerDevelopment === true;
  const shopifyPlus = shopPlan?.shopifyPlus === true;
  const forcedTestBillingAllowed =
    partnerDevelopment ||
    FORCED_TEST_BILLING_SHOP_PLAN_NAMES.has(normalizedPlanName);

  return {
    planName,
    normalizedPlanName,
    partnerDevelopment,
    shopifyPlus,
    forcedTestBillingAllowed,
  };
}

function pickUsageLineItemId(subscription) {
  const items = Array.isArray(subscription?.lineItems)
    ? subscription.lineItems
    : [];
  const usageItem = items.find((item) => {
    const typeName = String(
      item?.plan?.pricingDetails?.__typename || "",
    ).trim();
    return typeName === "AppUsagePricing";
  });
  return String(usageItem?.id || "").trim() || null;
}

function pickUsagePricingDetails(subscription) {
  const items = Array.isArray(subscription?.lineItems)
    ? subscription.lineItems
    : [];
  const usageItem = items.find((item) => {
    const typeName = String(
      item?.plan?.pricingDetails?.__typename || "",
    ).trim();
    return typeName === "AppUsagePricing";
  });
  const pricing = usageItem?.plan?.pricingDetails || {};
  const cappedAmount = pricing?.cappedAmount || null;
  const balanceUsed = pricing?.balanceUsed || null;

  return {
    cappedAmount:
      Number.isFinite(Number(cappedAmount?.amount)) &&
      Number(cappedAmount.amount) > 0
        ? Number(cappedAmount.amount)
        : null,
    cappedCurrencyCode: String(cappedAmount?.currencyCode || "").trim() || null,
    balanceUsedAmount: Number.isFinite(Number(balanceUsed?.amount))
      ? Number(balanceUsed.amount)
      : 0,
    balanceUsedCurrencyCode:
      String(balanceUsed?.currencyCode || "").trim() || null,
  };
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function minusDays(date, days) {
  return new Date(date.getTime() - days * 24 * 60 * 60 * 1000);
}

function pickBestSubscription(
  subscriptions,
  preferredPlanKey = null,
  { allowForcedTestBilling = false } = {},
) {
  const activeCandidates = (subscriptions || []).filter((s) => {
    const status = String(s?.status || "");
    return ACTIVE_SUBSCRIPTION_STATUSES.has(status);
  });
  const liveCandidates = activeCandidates.filter((s) => !Boolean(s?.test));
  const testCandidates = allowForcedTestBilling
    ? activeCandidates.filter((s) => Boolean(s?.test))
    : [];
  const candidates = liveCandidates.length ? liveCandidates : testCandidates;

  if (preferredPlanKey) {
    const exact = candidates.find((s) => String(s?.name) === preferredPlanKey);
    if (exact) return exact;
  }

  // Prefer the subscription with the furthest period end.
  return (
    candidates.sort((a, b) => {
      const at = new Date(a?.currentPeriodEnd || 0).getTime();
      const bt = new Date(b?.currentPeriodEnd || 0).getTime();
      return bt - at;
    })[0] || null
  );
}

/**
 * Syncs Shop.billing from Shopify Billing API activeSubscriptions.
 *
 * Returns the picked subscription (or null) for logging/inspection.
 */
export async function syncBillingFromShopify(
  shop,
  accessToken,
  preferredPlanKey = null,
) {
  if (!shop) throw new Error("Missing shop");

  let existing = await Shop.findOne({ shop }).lean();

  const admin = await getAdminClient(shop, {
    accessToken: accessToken || existing?.accessToken || "",
    record: existing,
  });

  // The central token service can restore a Shop mirror from the canonical
  // Shopify session during a reinstall or a partially completed migration.
  if (!existing) existing = await Shop.findOne({ shop }).lean();
  if (!existing) throw new Error("Shop not found");

  const query = `#graphql
    query GetActiveSubscriptionsAndShopPlan {
      currentAppInstallation {
        activeSubscriptions {
          id
          name
          test
          status
          trialDays
          createdAt
	          currentPeriodEnd
	          lineItems {
	            id
	            plan {
	              pricingDetails {
	                __typename
	                ... on AppUsagePricing {
	                  cappedAmount {
	                    amount
	                    currencyCode
	                  }
	                  balanceUsed {
	                    amount
	                    currencyCode
	                  }
	                  terms
	                }
	              }
	            }
	          }
	        }
      }
      shop {
        plan {
          partnerDevelopment
          publicDisplayName
          shopifyPlus
        }
      }
    }
  `;

  const out = await admin.query({ data: query });
  const subs =
    out?.body?.data?.currentAppInstallation?.activeSubscriptions || [];
  const shopPlanMeta = getShopPlanMeta(out?.body?.data?.shop?.plan || {});
  const billingShopPlanUpdate = {
    "billing.forcedTestBillingAllowed":
      shopPlanMeta.forcedTestBillingAllowed,
    "billing.shopifyShopPlanName": shopPlanMeta.planName,
    "billing.shopifyShopPlanPartnerDevelopment":
      shopPlanMeta.partnerDevelopment,
    "billing.shopifyShopPlanShopifyPlus": shopPlanMeta.shopifyPlus,
  };

  const picked = pickBestSubscription(subs, preferredPlanKey, {
    allowForcedTestBilling: shopPlanMeta.forcedTestBillingAllowed,
  });
  const now = new Date();
  const hardStoppedAt = existing?.billing?.hardStoppedAt
    ? new Date(existing.billing.hardStoppedAt)
    : null;
  const hardStopped = Number.isFinite(hardStoppedAt?.getTime?.());
  const reactivationRequested = !!String(preferredPlanKey || "").trim();
  const prevSubId = existing?.billing?.subscriptionId
    ? String(existing.billing.subscriptionId)
    : null;
  const existingPlan = getPlan(existing?.billing?.planKey);

  if (!picked) {
    if (
      !hardStopped &&
      String(existingPlan?.billingType || "").trim() ===
        PLAN_BILLING_TYPES.FREE_CAP
    ) {
      const existingStatus = String(existing.billing?.status || "").trim();
      const freeCycleWindow =
        existingStatus === "ACTIVE"
          ? resolveRecurringCycleWindow(existing.billing || {}, now, {
              fallbackStart:
                existing.billing?.currentPeriodStart ||
                existing.billing?.cycleAnchorAt ||
                existing.installedAt ||
                existing.createdAt ||
                now,
            })
          : resolveRecurringCycleWindow(existing.billing || {}, now, {
              rollForward: false,
            });

      await Shop.updateOne(
        { shop },
        {
          $set: {
            "billing.planKey":
              existing.billing?.planKey || PLAN_KEYS.ORDERX_FREE_5,
            "billing.status": existingStatus === "ACTIVE" ? "ACTIVE" : "NONE",
            "billing.subscriptionId": null,
            "billing.subscriptionTest": false,
            "billing.usageSubscriptionLineItemId": null,
            "billing.usageCappedAmount": null,
            "billing.usageCappedCurrencyCode": null,
            "billing.usageBalanceUsedAmount": 0,
            "billing.usageBalanceUsedCurrencyCode": null,
            "billing.currentPeriodStart":
              freeCycleWindow?.startAt ||
              existing.billing?.currentPeriodStart ||
              null,
            "billing.currentPeriodEnd":
              freeCycleWindow?.endAt ||
              existing.billing?.currentPeriodEnd ||
              null,
            "billing.cycleAnchorAt":
              freeCycleWindow?.anchorAt ||
              existing.billing?.cycleAnchorAt ||
              null,
            "billing.cancelAtPeriodEnd": false,
            "billing.cancelledAt": null,
            "billing.hardStoppedAt": null,
            "billing.lastCheckedAt": now,
            ...billingShopPlanUpdate,
          },
        },
      );

      return {
        picked: null,
        subscriptions: subs,
        shopPlan: shopPlanMeta,
        preservedFreePlan: true,
      };
    }

    const trialEndsAt = existing.billing?.trialEndsAt
      ? new Date(existing.billing.trialEndsAt).getTime()
      : null;
    const existingPeriodEndAt = existing.billing?.currentPeriodEnd
      ? new Date(existing.billing.currentPeriodEnd).getTime()
      : null;
    const pendingCancelAtPeriodEnd =
      existing.billing?.cancelAtPeriodEnd === true;
    const hasRemainingPaidWindow = false;
    // OrderX now treats subscription cancellation as an immediate stop.
    // If Shopify no longer reports an active subscription, we end access
    // immediately instead of preserving the remainder of the billing window.
    const keepTrialWindow = !prevSubId && !pendingCancelAtPeriodEnd;
    const trialStillActive =
      keepTrialWindow && trialEndsAt && Date.now() < trialEndsAt;

    // Close the latest subscription record if we previously had one.
    if (prevSubId) {
      const planPurchaseEndedAt =
        hasRemainingPaidWindow && existing.billing?.currentPeriodEnd
          ? new Date(existing.billing.currentPeriodEnd)
          : now;
      await PlanPurchase.updateOne(
        { shop, subscriptionId: prevSubId, endedAt: null },
        {
          $set: {
            endedAt: planPurchaseEndedAt,
            status: hasRemainingPaidWindow
              ? "CANCELLED_PENDING_END"
              : "CANCELLED",
          },
        },
      ).catch(() => null);
    }

    const update = {
      "billing.status": hasRemainingPaidWindow
        ? "ACTIVE"
        : trialStillActive
          ? "TRIAL"
          : "NONE",
      "billing.subscriptionId": null,
      "billing.subscriptionTest": false,
      "billing.usageSubscriptionLineItemId": null,
      "billing.usageCappedAmount": hasRemainingPaidWindow
        ? Number(existing.billing?.usageCappedAmount || 0) || null
        : null,
      "billing.usageCappedCurrencyCode": hasRemainingPaidWindow
        ? existing.billing?.usageCappedCurrencyCode || null
        : null,
      "billing.usageBalanceUsedAmount": hasRemainingPaidWindow
        ? Number(existing.billing?.usageBalanceUsedAmount || 0)
        : 0,
      "billing.usageBalanceUsedCurrencyCode": hasRemainingPaidWindow
        ? existing.billing?.usageBalanceUsedCurrencyCode || null
        : null,
      "billing.cancelAtPeriodEnd": false,
      "billing.cancelledAt": prevSubId
        ? existing.billing?.cancelledAt || now
        : null,
      "billing.currentPeriodStart": null,
      "billing.currentPeriodEnd": null,
      "billing.cycleAnchorAt": null,
      "billing.lastCheckedAt": now,
      "billing.hardStoppedAt": hardStopped ? hardStoppedAt || now : null,
      ...billingShopPlanUpdate,
    };

    if (prevSubId) {
      update["billing.trialDays"] = 0;
      update["billing.trialStartedAt"] = null;
      update["billing.trialEndsAt"] = null;
    }

    await Shop.updateOne(
      { shop },
      {
        $set: update,
      },
    );

    return { picked: null, subscriptions: subs, shopPlan: shopPlanMeta };
  }

  const nextPlanKey = KNOWN_PLANS.has(String(picked.name))
    ? String(picked.name)
    : String(existing.billing?.planKey || PLAN_KEYS.ORDERX_FREE_5);
  const usageSubscriptionLineItemId = pickUsageLineItemId(picked);
  const usagePricingDetails = pickUsagePricingDetails(picked);
  const nextPlan = getPlan(nextPlanKey);
  const nextSenderMode = String(
    nextPlan?.senderMode || SENDER_MODES.ORDERX_NUMBER,
  ).trim();

  const nextSubId = String(picked.id);
  if (prevSubId && prevSubId !== nextSubId) {
    await PlanPurchase.updateOne(
      { shop, subscriptionId: prevSubId, endedAt: null },
      { $set: { endedAt: now, status: "REPLACED" } },
    ).catch(() => null);
  }

  // Upsert a purchase record so we keep a full history of packages bought.
  await PlanPurchase.updateOne(
    { shop, subscriptionId: nextSubId },
    {
      $setOnInsert: {
        shop,
        subscriptionId: nextSubId,
        startedAt: picked.createdAt ? new Date(picked.createdAt) : now,
        source: "shopify_sync",
      },
      $set: {
        planKey: nextPlanKey,
        status: String(picked.status || "ACTIVE"),
        test: Boolean(picked.test),
        currentPeriodEnd: picked.currentPeriodEnd
          ? new Date(picked.currentPeriodEnd)
          : null,
        endedAt: null,
      },
    },
    { upsert: true },
  ).catch(() => null);

  if (hardStopped && !reactivationRequested) {
    await Shop.updateOne(
      { shop },
      {
        $set: {
          "billing.status": "NONE",
          "billing.subscriptionId": null,
          "billing.subscriptionTest": false,
          "billing.usageSubscriptionLineItemId": null,
          "billing.usageCappedAmount": null,
          "billing.usageCappedCurrencyCode": null,
          "billing.usageBalanceUsedAmount": 0,
          "billing.usageBalanceUsedCurrencyCode": null,
          "billing.currentPeriodStart": null,
          "billing.currentPeriodEnd": null,
          "billing.cycleAnchorAt": null,
          "billing.lastCheckedAt": now,
          "billing.cancelAtPeriodEnd": false,
          "billing.cancelledAt":
            existing.billing?.cancelledAt || hardStoppedAt || now,
          "billing.hardStoppedAt": hardStoppedAt || now,
          ...billingShopPlanUpdate,
        },
      },
    );
    return {
      picked,
      subscriptions: subs,
      shopPlan: shopPlanMeta,
      hardStopped: true,
    };
  }

  const update = {
    "billing.planKey": nextPlanKey,
    "billing.status": "ACTIVE",
    "billing.subscriptionId": nextSubId,
    "billing.subscriptionTest": Boolean(picked.test),
    "billing.usageSubscriptionLineItemId": usageSubscriptionLineItemId,
    "billing.usageCappedAmount":
      usagePricingDetails.cappedAmount ||
      Number(nextPlan?.usageCappedAmount?.amount || 0) ||
      null,
    "billing.usageCappedCurrencyCode":
      usagePricingDetails.cappedCurrencyCode ||
      nextPlan?.usageCappedAmount?.currencyCode ||
      null,
    "billing.usageBalanceUsedAmount": Number(
      usagePricingDetails.balanceUsedAmount || 0,
    ),
    "billing.usageBalanceUsedCurrencyCode":
      usagePricingDetails.balanceUsedCurrencyCode ||
      nextPlan?.usageCappedAmount?.currencyCode ||
      null,
    "billing.currentPeriodStart": picked.currentPeriodEnd
      ? minusDays(new Date(picked.currentPeriodEnd), 30)
      : picked.createdAt
        ? new Date(picked.createdAt)
        : null,
    "billing.currentPeriodEnd": picked.currentPeriodEnd
      ? new Date(picked.currentPeriodEnd)
      : null,
    "billing.cycleAnchorAt": picked.createdAt
      ? new Date(picked.createdAt)
      : null,
    "billing.lastCheckedAt": now,
    "billing.trialUsed": true,
    "billing.cancelAtPeriodEnd": false,
    "billing.cancelledAt": null,
    "billing.hardStoppedAt": null,
    ...billingShopPlanUpdate,
    "whatsappSender.preferenceMode": nextSenderMode,
    ...(nextSenderMode === SENDER_MODES.ORDERX_NUMBER
      ? { "whatsappSender.activeMode": SENDER_MODES.ORDERX_NUMBER }
      : {}),
  };

  const trialDays = Number(picked.trialDays || 0);
  if (trialDays > 0 && picked.createdAt) {
    const startedAt = new Date(picked.createdAt);
    update["billing.trialDays"] = trialDays;
    update["billing.trialStartedAt"] = startedAt;
    update["billing.trialEndsAt"] = addDays(startedAt, trialDays);
  } else {
    // Once a paid subscription is active, the trial should be considered over forever.
    // Clear any historical trial window so we don't mistakenly gate a paid shop as TRIAL.
    update["billing.trialDays"] = 0;
    update["billing.trialStartedAt"] = null;
    update["billing.trialEndsAt"] = null;
  }

  await Shop.updateOne({ shop }, { $set: update });

  return { picked, subscriptions: subs, shopPlan: shopPlanMeta };
}
