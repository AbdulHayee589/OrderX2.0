import dotenv from "dotenv";
import mongoose from "mongoose";

import Shop from "../models/Shop.js";
import { getBillingStatus } from "../services/billing.js";
import { getInitiatedConversationQuotaStatus } from "../services/usage.js";
import { SENDER_MODES } from "../services/plans.js";

dotenv.config();

function parseShopArg(argv) {
  const eq = argv.find((arg) => String(arg).startsWith("--shop="));
  if (eq) return String(eq.split("=")[1] || "").trim();
  const idx = argv.findIndex((arg) => arg === "--shop");
  if (idx >= 0 && argv[idx + 1]) return String(argv[idx + 1]).trim();
  return "";
}

function formatDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

async function main() {
  const shop = parseShopArg(process.argv.slice(2));
  if (!shop) {
    console.error("Usage: node server/scripts/qaFlowSnapshot.js --shop <shop.myshopify.com>");
    process.exit(1);
  }
  if (!process.env.MONGO_URI) {
    console.error("Missing MONGO_URI");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  try {
    const [record, billing] = await Promise.all([
      Shop.findOne({ shop }).lean(),
      getBillingStatus(shop),
    ]);
    if (!record) {
      console.error(`Shop not found: ${shop}`);
      process.exit(2);
    }

    const sender = record?.whatsappSender || {};
    const own = sender?.ownNumber || {};
    const preferenceMode = String(sender?.preferenceMode || "").trim();
    const ownStatus = String(own?.status || "").trim();
    const ownReady = ownStatus === "ready";
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
      ["templates_pending", "ready"].includes(ownStatus);
    const byonOnboardingComplete =
      metaConnected && paymentMethodAdded && hasAccessToken && !tokenExpired;
    const billingSenderMode = String(
      billing?.plan?.senderMode || SENDER_MODES.ORDERX_NUMBER,
    ).trim();
    const byonPlanSelected = billingSenderMode === SENDER_MODES.OWN_NUMBER;
    const canPurchaseByonPlan = byonOnboardingComplete;
    const initiated = await getInitiatedConversationQuotaStatus(shop, { billing });

    const snapshot = {
      shop,
      billing: {
        active: !!billing?.active,
        status: billing?.status || null,
        planKey: billing?.planKey || null,
        planName: billing?.plan?.name || null,
        senderMode: billingSenderMode || null,
        trialUsed: !!billing?.trialUsed,
        trialEndsAt: formatDate(billing?.trialEndsAt),
        currentPeriodEnd: formatDate(billing?.currentPeriodEnd),
      },
      sender: {
        preferenceMode: preferenceMode || null,
        activeMode: String(sender?.activeMode || "").trim() || null,
        ownNumber: {
          status: String(own?.status || "").trim() || "not_started",
          wabaIdPresent: !!String(own?.wabaId || "").trim(),
          phoneNumberIdPresent: !!String(own?.phoneNumberId || "").trim(),
          accessTokenPresent: !!String(own?.accessToken || "").trim(),
          accessTokenExpiresAt: formatDate(own?.accessTokenExpiresAt),
          templatesLastSyncedAt: formatDate(own?.templatesLastSyncedAt),
          webhookSubscribedAt: formatDate(own?.webhookSubscribedAt),
          webhookSubscriptionError: own?.webhookSubscriptionError || null,
          paymentMethodConfirmedAt: formatDate(own?.paymentMethodConfirmedAt),
          templatesReadyAt: formatDate(own?.templatesReadyAt),
          readyAt: formatDate(own?.readyAt),
          testMessageSentAt: formatDate(own?.testMessageSentAt),
          onboardingCompletedAt: formatDate(own?.onboardingCompletedAt),
          onboardingComplete: byonOnboardingComplete,
          checks: {
            metaConnected,
            paymentMethodAdded,
            hasAccessToken,
            tokenExpired,
            ready: ownReady,
          },
        },
      },
      checks: {
        byonPlanSelected,
        canPurchaseByonPlan,
        byonPurchaseBlockedReason:
          canPurchaseByonPlan
            ? null
            : "BYON onboarding incomplete (requires Meta connection, payment step confirmation, and a healthy own-number token).",
      },
      initiatedConversations24h: initiated,
    };

    console.log(JSON.stringify(snapshot, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (err) => {
  console.error(err?.stack || err?.message || err);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
