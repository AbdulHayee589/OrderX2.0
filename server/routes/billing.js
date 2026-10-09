import express from "express";
import Shop from "../models/Shop.js";
import PlanPurchase from "../models/PlanPurchase.js";
import { logAudit } from "../services/audit.js";
import {
  getBillingStatus,
  startTrialOrSubscribe,
  markPaidActive,
} from "../services/billing.js";
import { getGrowthPlanAvailabilityForStore } from "../services/countryPricing.js";
import {
  getPlan,
  isKnownPlanKey,
  PLAN_BILLING_TYPES,
  PLAN_KEYS,
  SENDER_MODES,
} from "../services/plans.js";
import { getUsageRanges } from "../services/usage.js";
import { requestGrowthUsageCapIncrease } from "../services/shopifyUsageBilling.js";
import { syncBillingFromShopify } from "../services/shopifyBillingSync.js";
import { maybeSyncStoreContext } from "../services/storeContext.js";

const router = express.Router();

function isByonPlan(planKey) {
  const plan = getPlan(planKey);
  return String(plan?.senderMode || "").trim() === SENDER_MODES.OWN_NUMBER;
}

function isByonFreeTrialPlan(plan) {
  return (
    String(plan?.senderMode || "").trim() === SENDER_MODES.OWN_NUMBER &&
    String(plan?.billingType || "").trim() === PLAN_BILLING_TYPES.FREE_CAP
  );
}

async function getCurrentGrowthAvailability(shop) {
  const shopRecord = await Shop.findOne({ shop })
    .select({ accessToken: 1, storeCountryCode: 1 })
    .lean();

  // Older installs can predate store-country persistence. Fill that gap at
  // the moment it matters so an allowed country is not rejected just because
  // the install record is stale. A temporary Shopify read failure should not
  // hide an already stored country or the configured default fallback.
  if (shopRecord && !String(shopRecord.storeCountryCode || "").trim()) {
    await maybeSyncStoreContext({
      shop,
      accessToken: shopRecord.accessToken,
      force: true,
    }).catch((error) => {
      console.warn(
        "[billing_store_context_sync_failed]",
        shop,
        error?.message || error,
      );
    });
  }

  return getGrowthPlanAvailabilityForStore({
    shop,
    forceCountryRateRefresh: true,
  });
}

async function assertByonOnboardingComplete(shop) {
  const record = await Shop.findOne({ shop })
    .select({
      "whatsappSender.ownNumber.status": 1,
      "whatsappSender.ownNumber.wabaId": 1,
      "whatsappSender.ownNumber.phoneNumberId": 1,
      "whatsappSender.ownNumber.accessToken": 1,
      "whatsappSender.ownNumber.accessTokenExpiresAt": 1,
      "whatsappSender.ownNumber.paymentMethodConfirmedAt": 1,
      "whatsappSender.ownNumber.templatesReadyAt": 1,
      "whatsappSender.ownNumber.readyAt": 1,
      "whatsappSender.ownNumber.onboardingCompletedAt": 1,
    })
    .lean();
  const own = record?.whatsappSender?.ownNumber || {};
  const status = String(own?.status || "").trim();
  const metaConnected =
    !!String(own?.wabaId || "").trim() &&
    !!String(own?.phoneNumberId || "").trim();
  const hasAccessToken = !!String(own?.accessToken || "").trim();
  const tokenExpiry = own?.accessTokenExpiresAt
    ? new Date(own.accessTokenExpiresAt)
    : null;
  const tokenExpired =
    !!tokenExpiry &&
    Number.isFinite(tokenExpiry.getTime()) &&
    tokenExpiry.getTime() <= Date.now();
  const paymentMethodAdded =
    !!own?.paymentMethodConfirmedAt ||
    !!own?.templatesReadyAt ||
    !!own?.readyAt ||
    !!own?.onboardingCompletedAt ||
    ["templates_pending", "ready"].includes(status);
  if (metaConnected && paymentMethodAdded && hasAccessToken && !tokenExpired) {
    return { metaConnected, paymentMethodAdded };
  }
  const err = new Error(
    "Complete BYON setup first: connect Meta, confirm your Meta payment method, and make sure the own-number connection is healthy before selecting the Your Own Number plan.",
  );
  err.statusCode = 409;
  err.data = {
    code: "BYON_ONBOARDING_INCOMPLETE",
    byon: {
      metaConnected,
      paymentMethodAdded,
      hasAccessToken,
      tokenExpired,
      status,
    },
  };
  throw err;
}

/**
 * Billing endpoints (Mongo-stored plans)
 *
 * GET  /api/billing/status?shop=xxx.myshopify.com
 * POST /api/billing/subscribe?shop=xxx.myshopify.com
 *      { "planKey": "starter_100" }
 *
 * DEV ONLY:
 * POST /api/billing/activate?shop=xxx.myshopify.com
 *      { "currentPeriodEnd": "2026-03-04T00:00:00.000Z" } // optional
 */

router.get("/status", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const status = await getBillingStatus(shop);
    return res.json(status);
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

router.post("/subscribe", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const planKey = String(req.body?.planKey || "").trim();
    if (!planKey) return res.status(400).json({ error: "Missing planKey" });
    if (isByonPlan(planKey)) {
      await assertByonOnboardingComplete(shop);
    }
    const plan = getPlan(planKey);
    if (
      String(plan?.billingType || "").trim() ===
      PLAN_BILLING_TYPES.SHOPIFY_METERED
    ) {
      const growthAvailability = await getCurrentGrowthAvailability(shop);
      if (!growthAvailability.available) {
        return res.status(409).json({
          error: growthAvailability.reason,
          code: "GROWTH_PRICING_UNAVAILABLE",
          planKey,
          storeCountryCode: growthAvailability.storeCountryCode,
          storeCountryName: growthAvailability.storeCountryName,
        });
      }
    }

    const result = await startTrialOrSubscribe(shop, planKey);
    void logAudit({
      shop,
      actor: "merchant",
      action: "billing_subscribe",
      meta: {
        planKey,
        ok: !!result?.ok,
        requiresPayment: !!result?.requiresPayment,
      },
    });
    return res.json(result);
  } catch (e) {
    const msg = e?.message || "Failed";
    const shop = String(req.query.shop || "").trim();
    if (shop) {
      void logAudit({
        shop,
        actor: "merchant",
        action: "billing_subscribe_error",
        level: "error",
        message: msg,
      });
    }
    const status = Number(e?.statusCode || e?.status || 0);
    if (status >= 400 && status < 600) {
      return res.status(status).json({
        error: msg,
        ...(e?.data ? { ...e.data } : {}),
      });
    }
    const code = msg.toLowerCase().includes("unknown plan") ? 400 : 500;
    return res.status(code).json({ error: msg });
  }
});

router.post("/activate", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const currentPeriodEnd = req.body?.currentPeriodEnd || null;
    const status = await markPaidActive(shop, currentPeriodEnd);
    void logAudit({
      shop,
      actor: "merchant",
      action: "billing_activate",
      meta: { currentPeriodEnd: currentPeriodEnd || null },
    });
    return res.json(status);
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

/**
 * Sync Mongo billing cache from Shopify Billing API (activeSubscriptions).
 *
 * POST /api/billing/sync?shop=xxx.myshopify.com
 * Optional query: force=1
 */
router.post("/sync", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const force = String(req.query.force || "") === "1";
    const ttlMin = Number(process.env.BILLING_SYNC_TTL_MIN || 15);

    const record = await Shop.findOne({ shop }).lean();
    if (!record) {
      return res.status(404).json({ error: "Shop not installed" });
    }

    const lastCheckedAt = record.billing?.lastCheckedAt
      ? new Date(record.billing.lastCheckedAt).getTime()
      : null;
    const ageMs = lastCheckedAt ? Date.now() - lastCheckedAt : Infinity;
    const isFresh = !force && Number.isFinite(ttlMin) && ageMs < ttlMin * 60e3;

    if (isFresh) {
      return res.json(await getBillingStatus(shop));
    }

    const preferredPlanKey = String(req.body?.planKey || "").trim() || null;
    await syncBillingFromShopify(
      shop,
      record.accessToken || "",
      preferredPlanKey,
    );
    void logAudit({
      shop,
      actor: "merchant",
      action: "billing_sync",
      meta: { force, preferredPlanKey },
    });

    return res.json(await getBillingStatus(shop));
  } catch (e) {
    const shop = String(req.query.shop || "").trim();
    if (shop) {
      void logAudit({
        shop,
        actor: "merchant",
        action: "billing_sync_error",
        level: "error",
        message: e?.message || "Sync failed",
      });
    }
    return res.status(500).json({ error: e?.message || "Sync failed" });
  }
});

router.post("/deactivate-free", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const record = await Shop.findOne({ shop })
      .select({ billing: 1, shop: 1 })
      .lean();
    if (!record) return res.status(404).json({ error: "Shop not found" });

    const current = record.billing || {};
    const currentPlan = getPlan(current.planKey || PLAN_KEYS.ORDERX_FREE_5);
    if (
      String(currentPlan?.billingType || "").trim() !==
      PLAN_BILLING_TYPES.FREE_CAP
    ) {
      return res.status(409).json({
        error: "Only the free OrderX plan can be deactivated here.",
        code: "FREE_PLAN_NOT_ACTIVE",
      });
    }
    if (String(current.status || "").trim() !== "ACTIVE") {
      return res.status(409).json({
        error: "The free OrderX plan is not active.",
        code: "FREE_PLAN_ALREADY_INACTIVE",
      });
    }

    const now = new Date();
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
          "billing.cancelAtPeriodEnd": false,
          "billing.cancelledAt": now,
          "billing.hardStoppedAt": null,
          "billing.lastCheckedAt": now,
        },
      },
    );

    void logAudit({
      shop,
      actor: "merchant",
      action: "billing_free_plan_deactivated",
      level: "warning",
      meta: {
        planKey: current.planKey || PLAN_KEYS.ORDERX_FREE_5,
        currentPeriodEnd: current.currentPeriodEnd || null,
      },
    });

    return res.json({
      ok: true,
      deactivated: true,
      billing: await getBillingStatus(shop),
    });
  } catch (e) {
    return res
      .status(500)
      .json({ error: e?.message || "Failed to deactivate free plan" });
  }
});

/**
 * Immediate hard stop (merchant-requested).
 *
 * POST /api/billing/hard-stop?shop=xxx.myshopify.com
 *
 * Intended usage:
 * - Merchant wants app access/sending blocked immediately.
 * - Used right after subscription cancellation so OrderX stops at once.
 */
router.post("/hard-stop", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const record = await Shop.findOne({ shop })
      .select({ billing: 1, shop: 1 })
      .lean();
    if (!record) return res.status(404).json({ error: "Shop not found" });

    const current = record.billing || {};

    const now = new Date();
    await Shop.updateOne(
      { shop },
      {
        $set: {
          "billing.status": "NONE",
          "billing.subscriptionId": null,
          "billing.subscriptionTest": false,
          "billing.currentPeriodStart": null,
          "billing.currentPeriodEnd": null,
          "billing.cycleAnchorAt": null,
          "billing.cancelAtPeriodEnd": false,
          "billing.cancelledAt": current.cancelledAt || now,
          "billing.hardStoppedAt": now,
          "billing.lastCheckedAt": now,
        },
      },
    );

    void logAudit({
      shop,
      actor: "merchant",
      action: "billing_hard_stop",
      level: "warning",
      meta: {
        previousPlanKey: current.planKey || null,
      },
    });

    return res.json({
      ok: true,
      hardStopped: true,
      billing: await getBillingStatus(shop),
    });
  } catch (e) {
    const shop = String(req.query.shop || "").trim();
    if (shop) {
      void logAudit({
        shop,
        actor: "merchant",
        action: "billing_hard_stop_error",
        level: "error",
        message: e?.message || "Hard stop failed",
      });
    }
    return res.status(500).json({ error: e?.message || "Hard stop failed" });
  }
});

router.post("/usage-cap", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const cappedAmount = Number(req.body?.cappedAmount || 0);
    if (!Number.isFinite(cappedAmount) || cappedAmount <= 0) {
      return res.status(400).json({
        error: "Missing cappedAmount",
      });
    }

    const billing = await getBillingStatus(shop);
    if (
      String(billing?.plan?.billingType || "").trim() !==
        PLAN_BILLING_TYPES.SHOPIFY_METERED ||
      String(billing?.plan?.senderMode || "").trim() !==
        SENDER_MODES.ORDERX_NUMBER
    ) {
      return res.status(409).json({
        error:
          "Usage cap can only be updated on the active OrderX Growth plan.",
      });
    }

    const result = await requestGrowthUsageCapIncrease({
      shop,
      cappedAmount,
    });

    void logAudit({
      shop,
      actor: "merchant",
      action: "billing_usage_cap_update_requested",
      meta: {
        cappedAmount: result.cappedAmount,
        currencyCode: result.currencyCode,
      },
    });

    return res.json(result);
  } catch (e) {
    return res
      .status(500)
      .json({ error: e?.message || "Failed to update usage cap" });
  }
});

/**
 * Validate plan change rules (server-side enforcement).
 *
 * POST /api/billing/validate-change?shop=xxx.myshopify.com
 * Body: { targetPlanKey: "starter_100" }
 *
 * Rule: if downgrading, current usage must fit inside the target plan limits.
 */
router.post("/validate-change", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const targetPlanKey = String(
      req.body?.targetPlanKey || req.body?.planKey || "",
    ).trim();

    if (!targetPlanKey)
      return res.status(400).json({ error: "Missing targetPlanKey" });

    if (!isKnownPlanKey(targetPlanKey)) {
      return res.status(400).json({ error: "Unknown plan" });
    }
    if (isByonPlan(targetPlanKey)) {
      await assertByonOnboardingComplete(shop);
    }
    const targetPlan = getPlan(targetPlanKey);
    if (
      String(targetPlan?.billingType || "").trim() ===
      PLAN_BILLING_TYPES.SHOPIFY_METERED
    ) {
      const growthAvailability = await getCurrentGrowthAvailability(shop);
      if (!growthAvailability.available) {
        return res.status(409).json({
          error: growthAvailability.reason,
          code: "GROWTH_PRICING_UNAVAILABLE",
          targetPlanKey,
          storeCountryCode: growthAvailability.storeCountryCode,
          storeCountryName: growthAvailability.storeCountryName,
        });
      }
    }

    const billing = await getBillingStatus(shop);
    const currentPlanKeyResolved =
      billing?.planKey || PLAN_KEYS.ORDERX_FREE_5;

    const currentPlan = getPlan(currentPlanKeyResolved);
    const currentQuotaManagedByMeta = currentPlan?.quotaManagedByMeta === true;
    const targetQuotaManagedByMeta = targetPlan?.quotaManagedByMeta === true;
    const targetByonTemplateCap = Number(
      targetPlan?.outboundMessageCap ?? targetPlan?.templateMessageCap ?? 0,
    );
    const targetByonHasOverage =
      targetQuotaManagedByMeta &&
      Number(targetPlan?.usagePrice?.amount || 0) > 0;
    const targetIsFreePlan =
      String(targetPlan?.billingType || "").trim() ===
      PLAN_BILLING_TYPES.FREE_CAP;
    const currentHasPaidSubscription =
      !!String(billing?.subscriptionId || "").trim() &&
      String(billing?.status || "").trim() === "ACTIVE";

    if (targetIsFreePlan && currentHasPaidSubscription) {
      return res.status(409).json({
        error: isByonFreeTrialPlan(targetPlan)
          ? "Cancel the current paid subscription first before starting the Your Own Number free trial."
          : "Cancel the current paid subscription first before switching back to the free OrderX plan.",
        code: "FREE_PLAN_REQUIRES_CANCELLATION",
        currentPlanKey: currentPlanKeyResolved,
        targetPlanKey,
      });
    }

    if (
      isByonFreeTrialPlan(targetPlan) &&
      billing?.byonTrialUsed &&
      !(billing?.planKey === targetPlanKey && billing?.active)
    ) {
      return res.status(409).json({
        error:
          "Your Own Number free trial was already used. Choose Starter, Scale, or Unlimited to continue sending.",
        code: "BYON_FREE_TRIAL_ALREADY_USED",
        currentPlanKey: currentPlanKeyResolved,
        targetPlanKey,
      });
    }

    const currentMonthly = Number(
      currentPlan.monthlyMessages ||
        (Number(currentPlan.dailyMessages || 0) > 0
          ? Number(currentPlan.dailyMessages || 0) * 30
          : 0),
    );
    const targetMonthly = Number(
      targetPlan.monthlyMessages ||
        (Number(targetPlan.dailyMessages || 0) > 0
          ? Number(targetPlan.dailyMessages || 0) * 30
          : 0),
    );
    // BYON / Meta-billed plans do not use OrderX monthly caps, so quota-based downgrade
    // validation should not block switching into them.
    const downgrade =
      !targetQuotaManagedByMeta &&
      !currentQuotaManagedByMeta &&
      targetMonthly < currentMonthly;

    const ranges = await getUsageRanges(shop, { billing });
    const cycleUsed = Number(ranges.month || 0);
    const byonCycleUsed = Number(ranges?.byonUsage?.messagesSent || 0);

    if (
      targetQuotaManagedByMeta &&
      !targetByonHasOverage &&
      targetByonTemplateCap > 0 &&
      byonCycleUsed > targetByonTemplateCap
    ) {
      return res.status(409).json({
        error:
          `You already sent ${byonCycleUsed} BYON template messages in the current billing cycle. ` +
          `You can’t switch to ${targetPlan.name} (${targetByonTemplateCap} templates / 30 days) until the next cycle.`,
        code: "DOWNGRADE_BYON_TEMPLATE_CAP_EXCEEDED",
        usage: ranges,
        currentPlanKey: currentPlanKeyResolved,
        targetPlanKey,
      });
    }

    if (downgrade) {
      if (targetMonthly > 0 && cycleUsed > targetMonthly) {
        return res.status(409).json({
          error:
            `You already sent ${cycleUsed} messages in the current billing cycle. ` +
            `You can’t downgrade to ${targetPlan.name} (limit ~${targetMonthly}/30 days) until the next cycle.`,
          code: "DOWNGRADE_MONTHLY_EXCEEDED",
          usage: ranges,
          currentPlanKey: currentPlanKeyResolved,
          targetPlanKey,
        });
      }
    }

    return res.json({
      ok: true,
      downgrade,
      usage: ranges,
      currentPlanKey: currentPlanKeyResolved,
      targetPlanKey,
    });
  } catch (e) {
    const status = Number(e?.statusCode || e?.status || 0);
    if (status >= 400 && status < 600) {
      return res.status(status).json({
        error: e?.message || "Validation failed",
        ...(e?.data ? { ...e.data } : {}),
      });
    }
    return res.status(500).json({ error: e?.message || "Validation failed" });
  }
});

/**
 * Billing history (all packages bought).
 *
 * GET /api/billing/history?shop=xxx.myshopify.com
 */
router.get("/history", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const items = await PlanPurchase.find({ shop })
      .sort({ startedAt: -1 })
      .limit(100)
      .lean();

    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

export default router;
