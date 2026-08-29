import dotenv from "dotenv";
import mongoose from "mongoose";

import Shop from "../models/Shop.js";
import { getBillingStatus } from "../services/billing.js";
import {
  getPlansForClient,
  PLAN_BILLING_TYPES,
  PLAN_KEYS,
  SENDER_MODES,
} from "../services/plans.js";
import { getUsageRanges } from "../services/usage.js";

dotenv.config();

function parseArg(argv, name, fallback = "") {
  const eq = argv.find((arg) => String(arg).startsWith(`--${name}=`));
  if (eq) return String(eq.split("=").slice(1).join("=") || "").trim();
  const idx = argv.findIndex((arg) => arg === `--${name}`);
  if (idx >= 0 && argv[idx + 1]) return String(argv[idx + 1]).trim();
  return fallback;
}

function result(name, ok, detail, severity = ok ? "pass" : "fail") {
  return { name, ok, severity, detail };
}

function summarize(results) {
  return results.reduce(
    (acc, row) => {
      const key = row.ok ? "passed" : row.severity === "warn" ? "warnings" : "failed";
      acc[key] += 1;
      return acc;
    },
    { passed: 0, warnings: 0, failed: 0 },
  );
}

function auditPlanCatalog() {
  const plans = getPlansForClient();
  const visibleKeys = Object.values(plans)
    .filter((plan) => plan?.visible !== false)
    .map((plan) => String(plan?.key || "").trim())
    .sort();
  const freePlan = plans[PLAN_KEYS.ORDERX_FREE_5];
  const growthPlan = plans[PLAN_KEYS.ORDERX_METERED_4];
  const byonStarterPlan = plans[PLAN_KEYS.OWN_NUMBER_STARTER_5];
  const byonScalePlan = plans[PLAN_KEYS.OWN_NUMBER_SCALE_10];
  const byonLegacyPlan = plans[PLAN_KEYS.OWN_NUMBER_FLAT_8];
  const byonUnlimitedPlan = plans[PLAN_KEYS.OWN_NUMBER_UNLIMITED_15];

  return [
    result(
      "visible_plan_count",
      visibleKeys.length === 6,
      `Visible plans: ${visibleKeys.join(", ") || "none"}`,
    ),
    result(
      "free_plan_shape",
      freePlan?.billingType === PLAN_BILLING_TYPES.FREE_CAP &&
        freePlan?.senderMode === SENDER_MODES.ORDERX_NUMBER &&
        Number(freePlan?.includedConfirmations || 0) === 10 &&
        Number(freePlan?.price || 0) === 0,
      {
        billingType: freePlan?.billingType || null,
        senderMode: freePlan?.senderMode || null,
        includedConfirmations: Number(freePlan?.includedConfirmations || 0),
        price: Number(freePlan?.price || 0),
      },
    ),
    result(
      "growth_plan_shape",
      growthPlan?.billingType === PLAN_BILLING_TYPES.SHOPIFY_METERED &&
        growthPlan?.senderMode === SENDER_MODES.ORDERX_NUMBER &&
        Number(growthPlan?.price || 0) === 2.99 &&
        Number(growthPlan?.usagePrice?.amount || 0) > 0 &&
        Number(growthPlan?.usageCappedAmount?.amount || 0) >= 30,
      {
        billingType: growthPlan?.billingType || null,
        senderMode: growthPlan?.senderMode || null,
        recurringPrice: Number(growthPlan?.price || 0),
        usagePrice: Number(growthPlan?.usagePrice?.amount || 0),
        usageCap: Number(growthPlan?.usageCappedAmount?.amount || 0),
      },
    ),
    result(
      "byon_starter_plan_shape",
      byonStarterPlan?.billingType === PLAN_BILLING_TYPES.SHOPIFY_FLAT &&
        byonStarterPlan?.senderMode === SENDER_MODES.OWN_NUMBER &&
        byonStarterPlan?.quotaManagedByMeta === true &&
        Number(byonStarterPlan?.price || 0) === 5 &&
        Number(byonStarterPlan?.outboundMessageCap || 0) === 2500 &&
        Number(byonStarterPlan?.usagePrice?.amount || 0) === 0.01,
      {
        billingType: byonStarterPlan?.billingType || null,
        senderMode: byonStarterPlan?.senderMode || null,
        quotaManagedByMeta: byonStarterPlan?.quotaManagedByMeta === true,
        recurringPrice: Number(byonStarterPlan?.price || 0),
        outboundMessageCap: Number(byonStarterPlan?.outboundMessageCap || 0),
        usagePrice: Number(byonStarterPlan?.usagePrice?.amount || 0),
      },
    ),
    result(
      "byon_scale_plan_shape",
      byonScalePlan?.billingType === PLAN_BILLING_TYPES.SHOPIFY_FLAT &&
        byonScalePlan?.senderMode === SENDER_MODES.OWN_NUMBER &&
        byonScalePlan?.quotaManagedByMeta === true &&
        Number(byonScalePlan?.price || 0) === 10 &&
        Number(byonScalePlan?.outboundMessageCap || 0) === 7500 &&
        Number(byonScalePlan?.usagePrice?.amount || 0) === 0.01,
      {
        billingType: byonScalePlan?.billingType || null,
        senderMode: byonScalePlan?.senderMode || null,
        quotaManagedByMeta: byonScalePlan?.quotaManagedByMeta === true,
        recurringPrice: Number(byonScalePlan?.price || 0),
        outboundMessageCap: Number(byonScalePlan?.outboundMessageCap || 0),
        usagePrice: Number(byonScalePlan?.usagePrice?.amount || 0),
      },
    ),
    result(
      "byon_legacy_plan_shape",
      byonLegacyPlan?.billingType === PLAN_BILLING_TYPES.SHOPIFY_FLAT &&
        byonLegacyPlan?.senderMode === SENDER_MODES.OWN_NUMBER &&
        byonLegacyPlan?.quotaManagedByMeta === true &&
        Number(byonLegacyPlan?.price || 0) === 8 &&
        Number(byonLegacyPlan?.outboundMessageCap || 0) === 7500 &&
        byonLegacyPlan?.visible === false,
      {
        billingType: byonLegacyPlan?.billingType || null,
        senderMode: byonLegacyPlan?.senderMode || null,
        quotaManagedByMeta: byonLegacyPlan?.quotaManagedByMeta === true,
        recurringPrice: Number(byonLegacyPlan?.price || 0),
        outboundMessageCap: Number(byonLegacyPlan?.outboundMessageCap || 0),
        visible: byonLegacyPlan?.visible !== false,
      },
    ),
    result(
      "byon_unlimited_plan_shape",
      byonUnlimitedPlan?.billingType === PLAN_BILLING_TYPES.SHOPIFY_FLAT &&
        byonUnlimitedPlan?.senderMode === SENDER_MODES.OWN_NUMBER &&
        byonUnlimitedPlan?.quotaManagedByMeta === true &&
        Number(byonUnlimitedPlan?.price || 0) === 20 &&
        byonUnlimitedPlan?.outboundMessageCap == null &&
        byonUnlimitedPlan?.visible === true,
      {
        billingType: byonUnlimitedPlan?.billingType || null,
        senderMode: byonUnlimitedPlan?.senderMode || null,
        quotaManagedByMeta: byonUnlimitedPlan?.quotaManagedByMeta === true,
        recurringPrice: Number(byonUnlimitedPlan?.price || 0),
        outboundMessageCap:
          byonUnlimitedPlan?.outboundMessageCap == null
            ? null
            : Number(byonUnlimitedPlan?.outboundMessageCap || 0),
        visible: byonUnlimitedPlan?.visible !== false,
      },
    ),
  ];
}

async function auditShop(shop) {
  const [record, billing] = await Promise.all([
    Shop.findOne({ shop }).lean(),
    getBillingStatus(shop),
  ]);
  if (!record) {
    return [result("shop_exists", false, `Shop not found: ${shop}`)];
  }

  const results = [];
  const own = record?.whatsappSender?.ownNumber || {};
  const billingType = String(billing?.plan?.billingType || "").trim();
  const senderMode = String(billing?.plan?.senderMode || "").trim();
  const usage = await getUsageRanges(shop, { billing });
  const freeUsage = usage?.freePlanUsage || {};
  const growthUsage = usage?.growthUsage || {};
  const byonUsage = usage?.byonUsage || {};

  results.push(
    result(
      "billing_plan_known",
      Boolean(billing?.planKey),
      {
        planKey: billing?.planKey || null,
        status: billing?.status || null,
        active: !!billing?.active,
        senderMode: senderMode || null,
      },
    ),
  );

  results.push(
    result(
      "billing_state_not_conflicting",
      !(billing?.cancelAtPeriodEnd && billing?.hardStoppedAt),
      {
        cancelAtPeriodEnd: !!billing?.cancelAtPeriodEnd,
        hardStoppedAt: billing?.hardStoppedAt || null,
      },
    ),
  );

  if (
    billingType === PLAN_BILLING_TYPES.FREE_CAP &&
    billing?.active &&
    senderMode !== SENDER_MODES.OWN_NUMBER
  ) {
    results.push(
      result(
        "free_plan_no_shopify_subscription",
        !billing?.subscriptionId,
        {
          subscriptionId: billing?.subscriptionId || null,
        },
      ),
    );
    results.push(
      result(
        "free_plan_cycle_present",
        !!billing?.currentPeriodStart && !!billing?.currentPeriodEnd,
        {
          currentPeriodStart: billing?.currentPeriodStart || null,
          currentPeriodEnd: billing?.currentPeriodEnd || null,
        },
      ),
    );
    results.push(
      result(
        "free_plan_usage_in_bounds",
        Number(freeUsage.used || 0) <= Number(freeUsage.limit || 0),
        {
          used: Number(freeUsage.used || 0),
          limit: Number(freeUsage.limit || 0),
          remaining: Number(freeUsage.remaining || 0),
        },
      ),
    );
  }

  if (
    billingType === PLAN_BILLING_TYPES.FREE_CAP &&
    billing?.active &&
    senderMode === SENDER_MODES.OWN_NUMBER
  ) {
    results.push(
      result(
        "byon_trial_no_shopify_subscription",
        !billing?.subscriptionId,
        {
          subscriptionId: billing?.subscriptionId || null,
        },
      ),
    );
    results.push(
      result(
        "byon_trial_cycle_present",
        !!billing?.currentPeriodStart && !!billing?.currentPeriodEnd,
        {
          currentPeriodStart: billing?.currentPeriodStart || null,
          currentPeriodEnd: billing?.currentPeriodEnd || null,
        },
      ),
    );
    results.push(
      result(
        "byon_trial_usage_in_bounds",
        Number(byonUsage.messagesSent || 0) <=
          Number(byonUsage.outboundMessageCap || 0),
        {
          used: Number(byonUsage.messagesSent || 0),
          limit: Number(byonUsage.outboundMessageCap || 0),
          remaining: Number(byonUsage.remainingMessages || 0),
        },
      ),
    );
  }

  if (billingType === PLAN_BILLING_TYPES.SHOPIFY_METERED && billing?.active) {
    results.push(
      result(
        "growth_subscription_present",
        !!billing?.subscriptionId,
        {
          subscriptionId: billing?.subscriptionId || null,
        },
      ),
    );
    results.push(
      result(
        "growth_usage_line_item_present",
        !!billing?.usageSubscriptionLineItemId,
        {
          usageSubscriptionLineItemId:
            billing?.usageSubscriptionLineItemId || null,
        },
      ),
    );
    results.push(
      result(
        "growth_usage_cap_present",
        Number(billing?.usageCappedAmount || 0) > 0,
        {
          usageCappedAmount: Number(billing?.usageCappedAmount || 0),
          usageBalanceUsedAmount: Number(billing?.usageBalanceUsedAmount || 0),
        },
      ),
    );
    results.push(
      result(
        "growth_usage_snapshot_consistent",
        Number(growthUsage.usageCostUsd || 0) <=
          Number(growthUsage.capUsd || 0) + 0.01,
        {
          messagesSent: Number(growthUsage.messagesSent || 0),
          usageCostUsd: Number(growthUsage.usageCostUsd || 0),
          capUsd: Number(growthUsage.capUsd || 0),
          remainingMessages: Number(growthUsage.remainingMessages || 0),
        },
      ),
    );
  }

  if (senderMode === SENDER_MODES.OWN_NUMBER && billing?.active) {
    const readyByState = String(own?.status || "").trim() === "ready";
    const onboardingEvidence =
      !!own?.testMessageSentAt ||
      !!own?.onboardingCompletedAt ||
      !!own?.readyAt ||
      !!own?.templatesReadyAt;
    results.push(
      result(
        "byon_sender_ready",
        readyByState,
        {
          status: String(own?.status || "").trim() || null,
        },
      ),
    );
    results.push(
      result(
        "byon_credentials_present",
        !!String(own?.phoneNumberId || "").trim() &&
          !!String(own?.accessToken || "").trim(),
        {
          phoneNumberIdPresent: !!String(own?.phoneNumberId || "").trim(),
          accessTokenPresent: !!String(own?.accessToken || "").trim(),
        },
      ),
    );
    results.push(
      result(
        "byon_onboarding_complete",
        readyByState && onboardingEvidence,
        {
          testMessageSentAt: own?.testMessageSentAt || null,
          onboardingCompletedAt: own?.onboardingCompletedAt || null,
          readyAt: own?.readyAt || null,
          templatesReadyAt: own?.templatesReadyAt || null,
          templateMessagesThisCycle: Number(byonUsage.messagesSent || 0),
        },
      ),
    );
  }

  if (!billing?.active) {
    results.push(
      result(
        "inactive_billing_has_no_live_access",
        String(billing?.status || "").trim() === "NONE",
        {
          status: billing?.status || null,
          currentPeriodEnd: billing?.currentPeriodEnd || null,
        },
      ),
    );
  }

  results.push(
    result(
      "sender_preference_matches_active_plan",
      !billing?.active ||
        String(record?.whatsappSender?.preferenceMode || "").trim() === senderMode,
      {
        preferenceMode: String(record?.whatsappSender?.preferenceMode || "").trim() || null,
        senderMode: senderMode || null,
      },
      !billing?.active ||
        String(record?.whatsappSender?.preferenceMode || "").trim() === senderMode
        ? "pass"
        : "warn",
    ),
  );

  return results;
}

async function main() {
  const shop = parseArg(process.argv.slice(2), "shop", "");
  const catalogResults = auditPlanCatalog();
  if (!shop) {
    console.log(
      JSON.stringify(
        {
          ok: !catalogResults.some(
            (row) => !row.ok && row.severity !== "warn",
          ),
          shop: null,
          summary: summarize(catalogResults),
          results: catalogResults,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!process.env.MONGO_URI) {
    console.error("Missing MONGO_URI");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  try {
    const shopResults = await auditShop(shop);
    const allResults = [...catalogResults, ...shopResults];
    console.log(
      JSON.stringify(
        {
          ok: !allResults.some((row) => !row.ok && row.severity !== "warn"),
          shop: shop || null,
          summary: summarize(allResults),
          results: allResults,
        },
        null,
        2,
      ),
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (error) => {
  console.error(error?.stack || error?.message || error);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
