import { useEffect, useMemo, useRef, useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useLocation,
  useNavigation,
  useSubmit,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { UsageWidget } from "../components/AnalyticsWidgets";
import ByonOnboardingFlow from "../components/ByonOnboardingFlow";
import ConfirmDialog from "../components/ConfirmDialog";
import {
  HeroBanner,
  MetricTile,
  SectionDivider,
  SurfaceCard,
  surface,
} from "../components/AppSurface";
import { withShopParams } from "../utils/embedded";
import { formatDateTime, formatNumber } from "../utils/format";
import {
  describePlanDetail,
  describePlanPrice,
  formatDualCurrency,
  formatMoney,
  shouldShowPkrInfo,
} from "../utils/billingPresentation";

export { loader, action } from "./app.settings.jsx";

const SENDER_MODE_ORDERX = "orderx_number";
const SENDER_MODE_OWN = "own_number";
const BILLING_TYPE_FREE_CAP = "free_cap";
const BILLING_TYPE_SHOPIFY_METERED = "shopify_metered";
const BILLING_TYPE_SHOPIFY_FLAT = "shopify_flat";
const ORDERX_FREE_PLAN_KEY = "orderx_free_5";
const BYON_FREE_TRIAL_PLAN_KEY = "own_number_free_trial_200";
const toObject = (v) => (v && typeof v === "object" ? v : {});

function inferSenderModeFromPlanKey(planKey) {
  return String(planKey || "").startsWith("own_number_")
    ? SENDER_MODE_OWN
    : SENDER_MODE_ORDERX;
}

function planSenderMode(plan, planKey) {
  const raw = String(plan?.senderMode || "").trim();
  if (raw === SENDER_MODE_ORDERX || raw === SENDER_MODE_OWN) return raw;
  return inferSenderModeFromPlanKey(planKey);
}

function senderModeLabel(mode) {
  return mode === SENDER_MODE_OWN ? "Your Own Number" : "OrderX Number";
}

function PlanCard({
  name,
  priceLabel,
  detailLabel,
  badgeText,
  badgeTone,
  buttonText,
  disabled,
  action,
}) {
  const highlighted = !!badgeText;

  return (
    <SurfaceCard
      padding="base"
      soft={highlighted}
      style={{
        minWidth: 250,
        flex: "1 1 250px",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderTop: `4px solid ${highlighted ? "#0f766e" : "#d0d5dd"}`,
        boxShadow: highlighted
          ? "0 18px 38px rgba(15, 23, 42, 0.08)"
          : "0 10px 26px rgba(15, 23, 42, 0.04)",
      }}
    >
      <s-stack direction="block" gap="tight">
        <s-stack direction="inline" gap="base" wrap>
          <s-heading>{name}</s-heading>
          {badgeText ? (
            <s-badge tone={badgeTone || "success"}>{badgeText}</s-badge>
          ) : null}
        </s-stack>
        {priceLabel ? <s-text tone="subdued">{priceLabel}</s-text> : null}
        {detailLabel ? <s-text tone="subdued">{detailLabel}</s-text> : null}
        {action || (
          <s-button disabled={disabled}>{buttonText || "Upgrade"}</s-button>
        )}
      </s-stack>
    </SurfaceCard>
  );
}

export default function PlansPage() {
  const shopify = useAppBridge();
  const {
    billing,
    usage,
    billingHistory,
    sender,
    senderMetaConfig,
    serverNow,
    merchantTimezone,
  } = useLoaderData();
  const actionData = useActionData();
  const location = useLocation();
  const navigation = useNavigation();
  const submit = useSubmit();
  const appHref = (href) => withShopParams(href, location.search);
  const onboardingStep = String(
    new URLSearchParams(location.search).get("onboardingStep") || "",
  ).trim();
  const usageCapApprovalWindowRef = useRef(null);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);

  useEffect(() => {
    if (actionData?.ok) {
      if (actionData?.intent === "cancel_subscription") {
        if (actionData?.cancelledFreePlan) {
          shopify.toast.show("Free plan deactivated");
        } else {
          shopify.toast.show("Subscription cancelled and stopped immediately");
        }
      } else if (actionData?.intent === "increase_usage_cap") {
        const confirmationUrl = String(
          actionData?.confirmationUrl || "",
        ).trim();
        if (confirmationUrl) {
          const popup = usageCapApprovalWindowRef.current;
          usageCapApprovalWindowRef.current = null;
          if (popup && !popup.closed) {
            popup.location.assign(confirmationUrl);
          } else {
            window.open(confirmationUrl, "_blank", "noopener");
          }
          shopify.toast.show(
            "Approve the new cap in the Shopify tab. This keeps the same billing cycle.",
          );
          return;
        }
        shopify.toast.show("Usage cap updated");
      } else if (actionData?.intent === "start_trial") {
        shopify.toast.show("Trial started");
      } else if (actionData?.intent === "activate_free_plan") {
        shopify.toast.show("Free plan activated");
      } else if (actionData?.intent === "activate_byon_free_trial") {
        shopify.toast.show("Your Own Number free trial started");
      } else if (actionData?.intent === "sync_billing") {
        shopify.toast.show("Billing refreshed");
      } else if (actionData?.intent === "byon_start") {
        shopify.toast.show("Own-number setup started");
      } else if (actionData?.intent === "byon_save_details") {
        shopify.toast.show("Own-number setup details saved");
      } else if (actionData?.intent === "byon_reset") {
        shopify.toast.show("Own-number setup reset");
      } else if (actionData?.intent === "sender_select_mode") {
        shopify.toast.show("Messaging setup preference updated");
      } else if (actionData?.intent === "byon_templates_provision") {
        shopify.toast.show(
          actionData?.note || "Template provisioning prepared",
        );
      } else if (actionData?.intent === "byon_templates_sync") {
        shopify.toast.show("Template statuses refreshed");
      } else if (actionData?.intent === "byon_confirm_payment_method") {
        shopify.toast.show("Meta payment step marked as complete");
      } else if (
        ["byon_meta_connect_begin", "byon_meta_connect_prepare"].includes(
          actionData?.intent,
        )
      ) {
        shopify.toast.show("Opening Meta connect");
      } else if (actionData?.intent === "byon_meta_connect_finalize") {
        if (actionData?.waitingForIds) {
          if (actionData?.hasWaba && !actionData?.hasPhone) {
            shopify.toast.show(
              "Meta connected to WABA, but phone number ID is still missing. Complete phone setup in Embedded Signup and reconnect.",
            );
          } else {
            shopify.toast.show(
              "Meta connected. Complete Embedded Signup to capture WABA and phone details.",
            );
          }
        } else {
          shopify.toast.show("Meta connection saved");
        }
      } else if (actionData?.intent === "byon_test_send") {
        shopify.toast.show(
          "Live test message submitted. Ask recipient to reply on that same WhatsApp message, then check status.",
        );
      } else if (actionData?.intent === "byon_webhook_test_start") {
        shopify.toast.show(
          "Webhook verification now runs in live test flow. Send live test first.",
        );
      } else if (actionData?.intent === "byon_webhook_test_check") {
        const status = String(actionData?.webhookTest?.status || "").trim();
        if (status === "received") {
          shopify.toast.show("Webhook reply received");
        } else if (status === "waiting_reply") {
          shopify.toast.show("Waiting for merchant reply");
        } else if (status === "failed") {
          shopify.toast.show("Webhook test needs restart");
        } else {
          shopify.toast.show("Webhook test status refreshed");
        }
      } else if (actionData?.intent === "byon_test_status_check") {
        const status = String(actionData?.testMessage?.status || "").trim();
        if (status === "failed") {
          shopify.toast.show("Delivery failed");
        } else if (status === "delivered" || status === "read") {
          shopify.toast.show("Delivery verified");
        } else if (status === "sent") {
          shopify.toast.show("Message sent to WhatsApp");
        } else if (status === "queued") {
          shopify.toast.show("Delivery still pending");
        } else {
          shopify.toast.show("Delivery status refreshed");
        }
      } else if (actionData?.intent === "byon_retry_now") {
        const queued = Number(actionData?.retryNow?.attemptsQueued || 0);
        shopify.toast.show(
          queued > 0
            ? `BYON resumed. Requeued ${queued} pending attempts.`
            : "BYON resumed.",
        );
      }
    } else if (
      [
        "cancel_subscription",
        "increase_usage_cap",
        "start_trial",
        "activate_free_plan",
        "activate_byon_free_trial",
        "sync_billing",
        "byon_start",
        "byon_save_details",
        "byon_reset",
        "sender_select_mode",
        "byon_templates_provision",
        "byon_templates_sync",
        "byon_confirm_payment_method",
        "byon_meta_connect_begin",
        "byon_meta_connect_prepare",
        "byon_meta_connect_finalize",
        "byon_test_status_check",
        "byon_webhook_test_start",
        "byon_webhook_test_check",
        "byon_retry_now",
      ].includes(actionData?.intent) &&
      actionData?.error
    ) {
      if (actionData?.intent === "increase_usage_cap") {
        const popup = usageCapApprovalWindowRef.current;
        usageCapApprovalWindowRef.current = null;
        if (popup && !popup.closed) popup.close();
      }
      shopify.toast.show(actionData.error);
    }
  }, [actionData, merchantTimezone, shopify]);

  useEffect(() => {
    const params = new URLSearchParams(location.search || "");
    const billingResult = params.get("billing");
    if (billingResult === "success") {
      shopify.toast.show("Plan updated");
    } else if (billingResult === "failed") {
      shopify.toast.show("Payment not completed");
    }
  }, [location.search, shopify]);

  const plans = useMemo(() => {
    const raw =
      billing?.plans && Object.keys(billing.plans).length
        ? billing.plans
        : {
            own_number_scale_10: {
              name: "Your Own Number Scale",
              monthlyMessages: null,
              outboundMessageCap: 7500,
              templateMessageCap: 7500,
              price: 10,
              dailyMessages: 0,
              senderMode: SENDER_MODE_OWN,
              quotaManagedByMeta: true,
              billingType: BILLING_TYPE_SHOPIFY_FLAT,
              usagePrice: {
                amount: 0.01,
                currencyCode: "USD",
              },
            },

            own_number_free_trial_200: {
              name: "Your Own Number Free Trial",
              monthlyMessages: null,
              outboundMessageCap: 200,
              templateMessageCap: 200,
              trialMessageCap: 200,
              trialDays: 7,
              price: 0,
              dailyMessages: 0,
              senderMode: SENDER_MODE_OWN,
              quotaManagedByMeta: true,
              billingType: BILLING_TYPE_FREE_CAP,
              oneTimeTrial: true,
              upgradePlanKey: "own_number_starter_5",
            },

            own_number_flat_8: {
              name: "Your Own Number Legacy",
              monthlyMessages: null,
              outboundMessageCap: 7500,
              templateMessageCap: 7500,
              price: 8,
              dailyMessages: 0,
              senderMode: SENDER_MODE_OWN,
              quotaManagedByMeta: true,
              billingType: BILLING_TYPE_SHOPIFY_FLAT,
              usagePrice: {
                amount: 0.01,
                currencyCode: "USD",
              },
              visible: false,
            },
            own_number_starter_5: {
              name: "Your Own Number Starter",
              monthlyMessages: null,
              outboundMessageCap: 2500,
              templateMessageCap: 2500,
              price: 5,
              dailyMessages: 0,
              senderMode: SENDER_MODE_OWN,
              quotaManagedByMeta: true,
              billingType: BILLING_TYPE_SHOPIFY_FLAT,
              usagePrice: {
                amount: 0.01,
                currencyCode: "USD",
              },
            },
            own_number_unlimited_15: {
              name: "Your Own Number Unlimited",
              monthlyMessages: null,
              templateMessageCap: null,
              price: 20,
              dailyMessages: 0,
              senderMode: SENDER_MODE_OWN,
              quotaManagedByMeta: true,
              billingType: BILLING_TYPE_SHOPIFY_FLAT,
            },

            orderx_free_5: {
              name: "OrderX Free",
              price: 0,
              senderMode: SENDER_MODE_ORDERX,
              billingType: BILLING_TYPE_FREE_CAP,
              includedConfirmations: 10,
            },
            orderx_metered_4: {
              name: "OrderX Growth",
              price: 2.99,
              senderMode: SENDER_MODE_ORDERX,
              billingType: BILLING_TYPE_SHOPIFY_METERED,
              usagePrice: {
                amount: 0.01,
                currencyCode: "USD",
              },
            },
          };
    return Object.entries(raw).map(([key, p]) => ({
      key,
      name: p?.name || key,
      price: Number(p?.price || 0),
      senderMode: planSenderMode(p, key),
      billingType: String(p?.billingType || "").trim(),
      quotaManagedByMeta: p?.quotaManagedByMeta === true,
      visible: p?.visible !== false,
      trialDays: Number.isFinite(Number(p?.trialDays))
        ? Number(p.trialDays)
        : null,
      trialMessageCap: Number.isFinite(Number(p?.trialMessageCap))
        ? Number(p.trialMessageCap)
        : null,
      oneTimeTrial: p?.oneTimeTrial === true,
      upgradePlanKey: String(p?.upgradePlanKey || "").trim() || null,
      includedConfirmations: Number(p?.includedConfirmations || 0),
      outboundMessageCap:
        p?.outboundMessageCap == null
          ? p?.templateMessageCap == null
            ? null
            : Number.isFinite(Number(p?.templateMessageCap))
              ? Number(p.templateMessageCap)
              : null
          : Number.isFinite(Number(p?.outboundMessageCap))
            ? Number(p.outboundMessageCap)
            : null,
      templateMessageCap:
        p?.outboundMessageCap == null
          ? p?.templateMessageCap == null
            ? null
            : Number.isFinite(Number(p?.templateMessageCap))
              ? Number(p.templateMessageCap)
              : null
          : Number.isFinite(Number(p?.outboundMessageCap))
            ? Number(p.outboundMessageCap)
            : null,
      usagePrice:
        p?.usagePrice && Number(p.usagePrice.amount) > 0
          ? {
              amount: Number(p.usagePrice.amount),
              currencyCode: String(p.usagePrice.currencyCode || "USD").trim(),
            }
          : null,
      monthlyMessages: Number.isFinite(Number(p?.monthlyMessages))
        ? Number(p?.monthlyMessages)
        : Number(p?.dailyMessages || 0) * 30,
    }));
  }, [billing]);

  const billingSenderMode = planSenderMode(billing?.plan, billing?.planKey);
  const senderPreferenceMode = String(sender?.preferenceMode || "").trim();
  const hasActiveBillingChoice =
    !!billing?.subscriptionId ||
    billing?.status === "TRIAL" ||
    billing?.status === "ACTIVE" ||
    !!billing?.active;
  const currentSenderMode = hasActiveBillingChoice
    ? billingSenderMode
    : senderPreferenceMode === SENDER_MODE_ORDERX ||
        senderPreferenceMode === SENDER_MODE_OWN
      ? senderPreferenceMode
      : billingSenderMode;
  const senderModeParam = new URLSearchParams(location.search || "").get(
    "senderMode",
  );
  const selectedSenderMode =
    senderModeParam === SENDER_MODE_ORDERX ||
    senderModeParam === SENDER_MODE_OWN
      ? senderModeParam
      : currentSenderMode;
  const senderView = toObject(sender);
  const ownSender = toObject(senderView?.ownNumber);
  const ownSenderProgress = toObject(ownSender?.progress);
  const byonPlanStepReady =
    !!ownSenderProgress?.metaConnected &&
    !!ownSenderProgress?.paymentMethodAdded;
  const byonPlanSelected =
    currentSenderMode === SENDER_MODE_OWN &&
    (!!billing?.active ||
      billing?.status === "TRIAL" ||
      billing?.status === "ACTIVE" ||
      !!billing?.subscriptionId);
  const visiblePlans = plans
    .filter((p) => {
      if (p.senderMode !== selectedSenderMode) return false;
      return p.visible !== false || billing?.planKey === p.key;
    })
    .sort((a, b) => Number(a?.price || 0) - Number(b?.price || 0));
  const byonPaidSwitchPlans = plans
    .filter((p) => {
      if (p.senderMode !== SENDER_MODE_OWN) return false;
      if (p.key === BYON_FREE_TRIAL_PLAN_KEY) return false;
      return p.visible !== false || billing?.planKey === p.key;
    })
    .sort((a, b) => Number(a?.price || 0) - Number(b?.price || 0));
  const quotaManagedByMetaPlan = billing?.plan?.quotaManagedByMeta === true;
  const billingType = String(billing?.plan?.billingType || "").trim();
  const activePlanSenderMode = String(billing?.plan?.senderMode || "").trim();
  const isByonPlan =
    activePlanSenderMode === SENDER_MODE_OWN || quotaManagedByMetaPlan;
  const isByonFreeTrial = isByonPlan && billingType === BILLING_TYPE_FREE_CAP;
  const isOrderXFreePlan =
    !isByonPlan && billingType === BILLING_TYPE_FREE_CAP;
  const hasLiveBillingToReplace =
    !!billing?.subscriptionId ||
    billing?.status === "ACTIVE" ||
    billing?.status === "TRIAL";
  const isViewingDifferentSetup = selectedSenderMode !== currentSenderMode;
  const setupSwitchNeedsConfirm =
    actionData?.intent === "upgrade" &&
    actionData?.needsSetupSwitchConfirm === true;
  const setupSwitchTargetPlanKey = String(actionData?.targetPlanKey || "");
  const setupSwitchCurrentMode = String(
    actionData?.currentSenderMode || currentSenderMode,
  );
  const setupSwitchTargetMode = String(
    actionData?.targetSenderMode || selectedSenderMode,
  );
  const trialActive = billing?.status === "TRIAL";
  const hasCurrentPlanSelection =
    !!billing?.planKey &&
    (!!billing?.active ||
      billing?.status === "TRIAL" ||
      billing?.status === "ACTIVE" ||
      !!billing?.subscriptionId);
  const showByonTrialPaidSwitchOptions =
    trialActive && isByonFreeTrial && byonPaidSwitchPlans.length > 0;
  const fallbackTrialUpgradePlanKey = String(
    billing?.plan?.upgradePlanKey || byonPaidSwitchPlans[0]?.key || "",
  ).trim();
  const fallbackTrialUpgradeLabel =
    byonPaidSwitchPlans.find((plan) => plan.key === fallbackTrialUpgradePlanKey)
      ?.name || "paid plan";

  const usageSummary = toObject(usage?.usage);
  const freePlanUsage = toObject(usageSummary.freePlanUsage);
  const growthUsage = toObject(usageSummary.growthUsage);
  const byonUsage = toObject(usageSummary.byonUsage);
  const byonTemplateCap = Number(
    byonUsage.outboundMessageCap ??
      billing?.plan?.outboundMessageCap ??
      byonUsage.templateMessageCap ??
      billing?.plan?.templateMessageCap ??
      0,
  );
  const byonRemainingMessages =
    byonTemplateCap > 0
      ? Math.max(0, Number(byonUsage.remainingMessages ?? byonTemplateCap))
      : null;
  const regionalPricing = toObject(billing?.regionalPricing);
  const growthPricingAvailable =
    regionalPricing?.growthPricingAvailable !== false;
  const growthPlanBlockedReason =
    regionalPricing?.requestedStoreCountryCode ||
    regionalPricing?.storeCountryCode
      ? `OrderX Growth is not available yet for stores based in ${
          regionalPricing?.storeCountryName ||
          regionalPricing?.requestedStoreCountryCode ||
          regionalPricing?.storeCountryCode
        }.`
      : "OrderX Growth is only available after OrderX can detect your store billing country.";
  const showPkrInfo = shouldShowPkrInfo(merchantTimezone);
  const used = Number(usageSummary.month ?? usageSummary.waMessagesSent ?? 0);
  const freeConfirmationCap = Number(
    freePlanUsage.limit ??
      usageSummary.freeConfirmationCap ??
      billing?.freeConfirmationCap ??
      10,
  );
  const freeConfirmationUsed = Number(
    freePlanUsage.used ??
      usageSummary.freeConfirmationMessagesUsed ??
      billing?.freeConfirmationMessagesUsed ??
      0,
  );
  const freeConfirmationRemaining = Math.max(
    0,
    Number(
      freePlanUsage.remaining ?? freeConfirmationCap - freeConfirmationUsed,
    ),
  );
  const cycleBillableConfirmations = Number(growthUsage.messagesSent ?? 0);
  const limit =
    Number(
      usageSummary.limitMonthly ||
        usageSummary.limit ||
        billing?.plan?.monthlyMessages ||
        (Number(billing?.plan?.dailyMessages || 0) > 0
          ? Number(billing?.plan?.dailyMessages || 0) * 30
          : 0),
    ) || 0;
  const remaining = Math.max(0, limit - used);
  const pct = limit ? Math.round((used / limit) * 100) : 0;
  const trialCap = Number(
    usageSummary.trialMessageCap ?? billing?.trialMessageCap ?? 10,
  );
  const trialMsgsUsed = Number(
    usageSummary.trialMessagesUsed ?? billing?.trialMessagesUsed ?? 0,
  );
  const trialRemaining = Math.max(0, trialCap - trialMsgsUsed);
  const trialEndsAt = billing?.trialEndsAt
    ? new Date(billing.trialEndsAt)
    : null;

  const trialExpired =
    !billing?.active &&
    trialEndsAt &&
    trialEndsAt.getTime() < Number(serverNow || 0);
  const statusLabel = trialActive
    ? "Trial active"
    : billing?.hardStoppedAt
      ? "Stopped"
      : billing?.active
        ? "Active"
        : trialExpired
          ? "Trial expired"
          : "Inactive";

  const isTrial = trialActive;
  const isPaid = billing?.status === "ACTIVE";
  const isNearLimit =
    billingType === BILLING_TYPE_SHOPIFY_METERED
      ? growthUsage.nearCap === true
      : !quotaManagedByMetaPlan &&
        billing?.active &&
        !isTrial &&
        limit > 0 &&
        pct >= 90;
  const isLimitReached =
    billingType === BILLING_TYPE_SHOPIFY_METERED
      ? growthUsage.blocked === true
      : !quotaManagedByMetaPlan &&
        billingType !== BILLING_TYPE_FREE_CAP &&
        billingType !== BILLING_TYPE_SHOPIFY_METERED &&
        billing?.active &&
        !isTrial &&
        limit > 0 &&
        remaining <= 0;
  const isTrialReached = billing?.active && isTrial && trialRemaining <= 0;
  const growthMessageUnitUsd = Number(
    growthUsage.messageUnitUsd ||
      regionalPricing.growthStoreRateUsd ||
      regionalPricing.growthPriceUsd ||
      0.01,
  );
  const growthCapUsd = Number(
    growthUsage.capUsd ?? billing?.usageCappedAmount ?? 30,
  );
  const growthApproxCapMessages = Number(
    growthUsage.approximateCapMessages ??
      (growthCapUsd > 0 && growthMessageUnitUsd > 0
        ? Math.floor(growthCapUsd / growthMessageUnitUsd)
        : 3000),
  );
  const growthRemainingMessages = Number(growthUsage.remainingMessages ?? 0);
  const growthStoreCountryCode = String(
    growthUsage.storeCountryCode ||
      billing?.storeCountryCode ||
      regionalPricing.storeCountryCode ||
      "",
  ).trim();
  const nextGrowthCapMessages = growthApproxCapMessages + 3000;
  const nextGrowthCapUsd = Number(
    (nextGrowthCapMessages * growthMessageUnitUsd).toFixed(2),
  );
  const planCta = isPaid ? "Change plan" : isTrial ? "Upgrade" : "Choose plan";
  const plansHeading =
    selectedSenderMode === SENDER_MODE_OWN
      ? "Your Own Number package"
      : "Choose a plan";
  const submittingPlanKey =
    navigation.state === "submitting"
      ? navigation.formData?.get("planKey")
      : null;
  const submittingIntent =
    navigation.state === "submitting"
      ? navigation.formData?.get("intent")
      : null;
  const pricingError =
    actionData?.intent === "upgrade" ? String(actionData?.error || "") : "";
  const byonStepError = String(actionData?.intent || "").startsWith("byon_")
    ? String(actionData?.error || "")
    : "";
  const byonPlanSelectionContent =
    selectedSenderMode === SENDER_MODE_OWN ? (
      <div>
        {isViewingDifferentSetup && hasLiveBillingToReplace ? (
          <s-banner tone="info">
            Finish the setup first. OrderX will only replace your current{" "}
            <strong>{senderModeLabel(currentSenderMode)}</strong> package after
            you confirm the BYON package below.
          </s-banner>
        ) : null}
        {setupSwitchNeedsConfirm && setupSwitchTargetPlanKey ? (
          <s-banner tone="warning">
            <s-stack direction="block" gap="tight">
              <s-heading>Confirm setup switch</s-heading>
              <s-paragraph>
                You are switching from{" "}
                <strong>{senderModeLabel(setupSwitchCurrentMode)}</strong> to{" "}
                <strong>{senderModeLabel(setupSwitchTargetMode)}</strong>.
                Continue to Shopify billing to replace the current OrderX
                subscription.
              </s-paragraph>
              <Form method="post">
                <input type="hidden" name="intent" value="upgrade" />
                <input
                  type="hidden"
                  name="planKey"
                  value={setupSwitchTargetPlanKey}
                />
                <input type="hidden" name="confirmSetupSwitch" value="1" />
                <s-stack direction="inline" gap="base" wrap>
                  <s-button type="submit" variant="primary">
                    Confirm switch and continue
                  </s-button>
                  <s-button
                    href={appHref(
                      `/app/plans?senderMode=${setupSwitchCurrentMode}`,
                    )}
                    variant="secondary"
                  >
                    Keep current setup
                  </s-button>
                </s-stack>
              </Form>
            </s-stack>
          </s-banner>
        ) : null}

        {byonStepError ? (
          <s-banner tone="critical">
            <s-stack direction="block" gap="tight">
              <s-heading>BYON setup needs attention</s-heading>
              <s-paragraph>{byonStepError}</s-paragraph>
            </s-stack>
          </s-banner>
        ) : null}

        {pricingError ? (
          <s-banner tone="critical">
            <s-stack direction="block" gap="tight">
              <s-heading>Couldn’t start billing</s-heading>
              <s-paragraph>{pricingError}</s-paragraph>
            </s-stack>
          </s-banner>
        ) : null}
        <div
          style={{
            display: "grid",
            gap: 14,
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          }}
        >
          {/* <SurfaceCard soft padding="base">
          <s-paragraph>
            Select the <strong>Your Own Number</strong> package once Meta is
            connected and Meta billing is ready. If you are switching from
            OrderX Number, the current live package keeps running until you
            explicitly activate this package.
          </s-paragraph>
        </SurfaceCard> */}

          <div
            style={{
              display: "grid",
              gap: 14,
              gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            }}
          >
            <div
              className="byon-plan-grid"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                gap: 16,
                alignItems: "stretch",
              }}
            >
              {visiblePlans
                .slice()
                .reverse()
                .map((p) => {
                  const isCurrent = billing?.planKey === p.key;
                  const isCurrentSelectedPlan =
                    isCurrent && hasCurrentPlanSelection;
                  const isCurrentFreePlan =
                    isCurrentSelectedPlan &&
                    billingType === BILLING_TYPE_FREE_CAP &&
                    billing?.active;
                  const isByonFreeTrialUsed =
                    p.key === BYON_FREE_TRIAL_PLAN_KEY &&
                    billing?.byonTrialUsed &&
                    !isCurrentSelectedPlan;
                  const isRecommended = p.key === "own_number_scale_10";
                  const disabled =
                    isCurrentSelectedPlan ||
                    isCurrentFreePlan ||
                    isByonFreeTrialUsed ||
                    !byonPlanStepReady;
                  const buttonText = disabled
                    ? isCurrentSelectedPlan
                      ? "Active"
                      : isCurrentFreePlan
                        ? "Active"
                        : isByonFreeTrialUsed
                          ? "Trial used"
                          : "Available after Meta + payment steps"
                    : isTrial && isCurrent
                      ? "Upgrade to paid"
                      : isViewingDifferentSetup && hasLiveBillingToReplace
                        ? "Switch to this package"
                        : p.key === BYON_FREE_TRIAL_PLAN_KEY
                          ? "Start free trial"
                          : planCta;
                  const isSubmitting =
                    submittingIntent === "upgrade" &&
                    submittingPlanKey === p.key;

                  return (
                    <div
                      key={p.key}
                      className={`byon-plan-grid-item ${
                        isRecommended
                          ? "byon-plan-grid-item--scale"
                          : p.key === "own_number_starter_5"
                            ? "byon-plan-grid-item--starter"
                            : ""
                      }`.trim()}
                    >
                      <SurfaceCard
                        padding="base"
                        soft={isRecommended}
                        style={{
                          height: "100%",
                          border: "1px solid rgba(15, 23, 42, 0.08)",
                          borderTop: `4px solid ${isRecommended ? "#0f766e" : "#d0d5dd"}`,
                          boxShadow: isRecommended
                            ? "0 18px 38px rgba(15, 23, 42, 0.08)"
                            : "0 10px 26px rgba(15, 23, 42, 0.04)",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 12,
                            height: "100%",
                          }}
                        >
                          <div style={{ flex: 1 }}>
                            <s-stack direction="block" gap="tight">
                              <s-stack direction="inline" gap="base" wrap>
                                <s-heading>{p.name}</s-heading>
                                {isRecommended ? (
                                  <s-badge tone="success">Recommended</s-badge>
                                ) : null}
                                {isCurrentSelectedPlan ? (
                                  <s-badge
                                    tone={isTrial ? "warning" : "success"}
                                  >
                                    {isTrial ? "Trial" : "Current"}
                                  </s-badge>
                                ) : null}
                              </s-stack>
                              {describePlanPrice(p, {
                                showPkrInfo:
                                  shouldShowPkrInfo(merchantTimezone),
                                usdToPkrRate: usage?.usage?.fx?.usdToPkr,
                                regionalPricing: billing?.regionalPricing,
                              }) ? (
                                <s-text tone="subdued">
                                  {describePlanPrice(p, {
                                    showPkrInfo:
                                      shouldShowPkrInfo(merchantTimezone),
                                    usdToPkrRate: usage?.usage?.fx?.usdToPkr,
                                    regionalPricing: billing?.regionalPricing,
                                  })}
                                </s-text>
                              ) : null}
                              {describePlanDetail(p, {
                                regionalPricing: billing?.regionalPricing,
                              }) ? (
                                <s-text tone="subdued">
                                  {describePlanDetail(p, {
                                    regionalPricing: billing?.regionalPricing,
                                  })}
                                </s-text>
                              ) : null}
                            </s-stack>
                          </div>
                          <Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value="upgrade"
                            />
                            <input type="hidden" name="planKey" value={p.key} />
                            <input
                              type="hidden"
                              name="senderMode"
                              value={selectedSenderMode}
                            />
                            <s-button
                              type="submit"
                              variant={disabled ? "secondary" : "primary"}
                              disabled={disabled}
                              {...(isSubmitting ? { loading: true } : {})}
                            >
                              {buttonText || "Upgrade"}
                            </s-button>
                          </Form>
                        </div>
                      </SurfaceCard>
                    </div>
                  );
                })}
            </div>
          </div>
          <style
            dangerouslySetInnerHTML={{
              __html: `
              @media (max-width: 1024px) {
                .byon-plan-grid {
                  grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
                }
              }

              @media (max-width: 720px) {
                .byon-plan-grid {
                  grid-template-columns: 1fr !important;
                }

                .byon-plan-grid-item--scale {
                  order: -2;
                }

                .byon-plan-grid-item--starter {
                  order: -1;
                }
              }
            `,
            }}
          />
        </div>
      </div>
    ) : null;

  const byonPlanStepContent =
    selectedSenderMode === SENDER_MODE_OWN ? (
      <SurfaceCard soft padding="base">
        <s-stack direction="block" gap="tight">
          <s-text tone="subdued">
            Choose your BYON package from the plan cards above in Plan &
            billing.
          </s-text>
          <s-text tone="subdued">
            After the plan is active, continue to the Templates step.
          </s-text>
        </s-stack>
      </SurfaceCard>
    ) : null;

  const orderxPlanSelectionContent =
    selectedSenderMode !== SENDER_MODE_OWN ? (
      <>
        <SurfaceCard soft padding="base">
          <s-paragraph>
            OrderX Free includes 10 template messages total. OrderX Growth
            uses Shopify billing with a{" "}
            {formatMoney(
              Number(billing?.plans?.orderx_metered_4?.price || 2.99),
              "USD",
            )}{" "}
            monthly base fee and country-aware outbound usage pricing.
          </s-paragraph>
        </SurfaceCard>

        {!growthPricingAvailable ? (
          <s-banner tone="warning">
            {growthPlanBlockedReason} You can still activate OrderX Free or
            switch to Your Own Number.
          </s-banner>
        ) : null}

        {isViewingDifferentSetup && hasLiveBillingToReplace ? (
          <s-banner tone="warning">
            <s-stack direction="block" gap="tight">
              <s-heading>Switching messaging setup</s-heading>
              <s-paragraph>
                You currently have{" "}
                <strong>{senderModeLabel(currentSenderMode)}</strong> active.
                Choosing a package below will replace the current OrderX
                Shopify subscription with a{" "}
                <strong>{senderModeLabel(selectedSenderMode)}</strong> package.
              </s-paragraph>
            </s-stack>
          </s-banner>
        ) : null}

        {setupSwitchNeedsConfirm && setupSwitchTargetPlanKey ? (
          <s-banner tone="warning">
            <s-stack direction="block" gap="tight">
              <s-heading>Confirm setup switch</s-heading>
              <s-paragraph>
                You are switching from{" "}
                <strong>{senderModeLabel(setupSwitchCurrentMode)}</strong> to{" "}
                <strong>{senderModeLabel(setupSwitchTargetMode)}</strong>.
                Continue to Shopify billing to replace the current OrderX
                subscription.
              </s-paragraph>
              <Form method="post">
                <input type="hidden" name="intent" value="upgrade" />
                <input
                  type="hidden"
                  name="planKey"
                  value={setupSwitchTargetPlanKey}
                />
                <input type="hidden" name="confirmSetupSwitch" value="1" />
                <s-stack direction="inline" gap="base" wrap>
                  <s-button type="submit" variant="primary">
                    Confirm switch and continue
                  </s-button>
                  <s-button
                    href={appHref(
                      `/app/plans?senderMode=${setupSwitchCurrentMode}`,
                    )}
                    variant="secondary"
                  >
                    Keep current setup
                  </s-button>
                </s-stack>
              </Form>
            </s-stack>
          </s-banner>
        ) : null}

        <s-stack direction="inline" gap="base" wrap style={{ marginTop: 14 }}>
          {visiblePlans.map((p) => {
            const isCurrent = billing?.planKey === p.key;
            const isCurrentSelectedPlan =
              isCurrent && hasCurrentPlanSelection;
            const isCurrentFreePlan =
              isCurrentSelectedPlan &&
              billingType === BILLING_TYPE_FREE_CAP &&
              billing?.active;
            const isGrowthPlanBlocked =
              p.key === "orderx_metered_4" && !growthPricingAvailable;
            const badgeText = isCurrent
              ? isPaid
                ? "Current"
                : isTrial
                  ? "Trial"
                  : isCurrentFreePlan
                    ? "Current"
                    : null
              : null;
            const badgeTone = isPaid
              ? "success"
              : isTrial
                ? "warning"
                : "success";
            const disabled =
              isCurrentSelectedPlan ||
              isCurrentFreePlan ||
              isGrowthPlanBlocked;
            const buttonText = disabled
              ? isCurrentSelectedPlan
                ? "Active"
                : isCurrentFreePlan
                  ? "Active"
                  : "Not available yet"
              : isTrial && isCurrent
                ? "Upgrade to paid"
                : p.key === ORDERX_FREE_PLAN_KEY
                  ? "Activate free plan"
                  : p.key === BYON_FREE_TRIAL_PLAN_KEY
                    ? "Start free trial"
                    : isViewingDifferentSetup && hasLiveBillingToReplace
                      ? "Switch to this package"
                      : planCta;
            const isSubmitting =
              submittingIntent === "upgrade" && submittingPlanKey === p.key;

            return (
              <PlanCard
                key={p.key}
                name={p.name}
                priceLabel={
                  isGrowthPlanBlocked
                    ? "Not available in your store country yet"
                    : describePlanPrice(p, {
                        showPkrInfo: shouldShowPkrInfo(merchantTimezone),
                        usdToPkrRate: usage?.usage?.fx?.usdToPkr,
                        regionalPricing: billing?.regionalPricing,
                      })
                }
                detailLabel={
                  isGrowthPlanBlocked
                    ? growthPlanBlockedReason
                    : describePlanDetail(p, {
                        regionalPricing: billing?.regionalPricing,
                      })
                }
                badgeText={badgeText}
                badgeTone={badgeTone}
                buttonText={buttonText}
                disabled={disabled}
                action={
                  <Form method="post">
                    <input type="hidden" name="intent" value="upgrade" />
                    <input type="hidden" name="planKey" value={p.key} />
                    <input
                      type="hidden"
                      name="senderMode"
                      value={selectedSenderMode}
                    />
                    <s-button
                      type="submit"
                      variant={disabled ? "secondary" : "primary"}
                      disabled={disabled}
                      {...(isSubmitting ? { loading: true } : {})}
                    >
                      {buttonText || "Upgrade"}
                    </s-button>
                  </Form>
                }
              />
            );
          })}
        </s-stack>

        {actionData?.intent === "upgrade" &&
        actionData?.error &&
        !actionData?.needsSetupSwitchConfirm ? (
          <s-banner tone="critical">
            <s-stack direction="block" gap="tight">
              <s-heading>Couldn’t update billing</s-heading>
              <s-paragraph>{actionData.error}</s-paragraph>
            </s-stack>
          </s-banner>
        ) : null}
      </>
    ) : null;

  const onRefreshBilling = () => {
    const fd = new FormData();
    fd.set("intent", "sync_billing");
    submit(fd, { method: "POST" });
  };

  const onCancelSubscription = () => {
    setCancelDialogOpen(true);
  };

  const confirmCancelSubscription = () => {
    setCancelDialogOpen(false);
    const fd = new FormData();
    fd.set("intent", "cancel_subscription");
    submit(fd, { method: "POST" });
  };

  const onIncreaseUsageCap = () => {
    if (typeof window !== "undefined") {
      usageCapApprovalWindowRef.current = window.open(
        "about:blank",
        "_blank",
        "noopener",
      );
    }
    const fd = new FormData();
    fd.set("intent", "increase_usage_cap");
    fd.set("cappedAmount", String(nextGrowthCapUsd));
    submit(fd, { method: "POST" });
  };

  return (
    <s-page suppressHydrationWarning>
      <s-box style={surface.shell}>
        <HeroBanner
          title="Plans & billing"
          // subtitle={
          //   selectedSenderMode === SENDER_MODE_OWN
          //     ? "Use your own WhatsApp number and your own Meta billing. OrderX charges a flat fee and keeps the same automation dashboard."
          //     : "Manage subscription, refresh billing status, and upgrade before your cycle limit interrupts sending."
          // }
          // chips={[
          //   selectedSenderMode === SENDER_MODE_OWN
          //     ? "Your number + your Meta billing"
          //     : "OrderX managed number",
          //   `Status: ${statusLabel}`,
          //   `Plan: ${billing?.plan?.name || billing?.planKey || "None"}`,
          //   billing?.active
          //     ? trialActive
          //       ? `Trial usage: ${trialMsgsUsed}/${trialCap}`
          //       : quotaManagedByMetaPlan
          //         ? `Cycle usage: ${used} (Meta billed)`
          //         : `Cycle usage: ${used}/${limit}`
          //     : "Billing inactive",
          // ]}
        />
        <s-section heading="Messaging setup">
          <SurfaceCard soft padding="base">
            <s-stack direction="inline" gap="base" wrap>
              <s-button
                href={appHref(`/app/plans?senderMode=${SENDER_MODE_ORDERX}`)}
                variant={
                  selectedSenderMode === SENDER_MODE_ORDERX
                    ? "primary"
                    : "secondary"
                }
              >
                {currentSenderMode === SENDER_MODE_ORDERX
                  ? selectedSenderMode === SENDER_MODE_ORDERX
                    ? "OrderX Number (Current)"
                    : "Back to OrderX Number"
                  : "Switch to OrderX Number"}
              </s-button>
              <s-button
                href={appHref(`/app/plans?senderMode=${SENDER_MODE_OWN}`)}
                variant={
                  selectedSenderMode === SENDER_MODE_OWN
                    ? "primary"
                    : "secondary"
                }
              >
                {currentSenderMode === SENDER_MODE_OWN
                  ? selectedSenderMode === SENDER_MODE_OWN
                    ? "Your Own Number (Current)"
                    : "Back to Your Own Number"
                  : "Switch to Your Own Number"}
              </s-button>
            </s-stack>
            <s-paragraph style={{ marginTop: 10 }}>
              {isViewingDifferentSetup && hasLiveBillingToReplace
                ? selectedSenderMode === SENDER_MODE_OWN
                  ? `Your current ${senderModeLabel(currentSenderMode)} package stays live while you finish own-number onboarding. Nothing switches until you activate a ${senderModeLabel(selectedSenderMode)} package.`
                  : `Your current ${senderModeLabel(currentSenderMode)} package stays live until you choose a ${senderModeLabel(selectedSenderMode)} package below.`
                : selectedSenderMode === SENDER_MODE_OWN
                  ? "Recommended for big stores. You pay Meta directly, and OrderX automates setup and message flows."
                  : `Fastest setup with OrderX number. Free includes 10 template messages total. Growth is ${formatMoney(Number(billing?.plans?.orderx_metered_4?.price || 2.99), "USD")}/month plus ${formatMoney(growthMessageUnitUsd, "USD")} per outbound message on your ${growthStoreCountryCode || "store"} baseline. Cross-border destinations are billed by the recipient country.`}
            </s-paragraph>
          </SurfaceCard>
        </s-section>

        <SectionDivider />

        <s-section heading={plansHeading}>
          {selectedSenderMode === SENDER_MODE_OWN
            ? byonPlanSelectionContent
            : orderxPlanSelectionContent}
        </s-section>

        <SectionDivider />

        {selectedSenderMode === SENDER_MODE_OWN ? (
          <>
            <s-section heading="Your Own Number setup">
              <SurfaceCard padding="base">
                <ByonOnboardingFlow
                  sender={sender}
                  senderMetaConfig={senderMetaConfig}
                  merchantTimezone={merchantTimezone}
                  intro="OrderX keeps the process inside the app and automates template setup for the merchant's own number. Meta billing stays on the merchant account."
                  showStatusHeader
                  showByonRequiredBanner
                  showSubscriptionStepHint
                  planStepContent={byonPlanStepContent}
                  planStepComplete={byonPlanSelected}
                  planStepLockedMessage="Complete Meta connect and confirm the Meta payment method to unlock the BYON plan step."
                  settingsHref={appHref("/app/settings")}
                  dashboardHref={appHref("/app")}
                  initialStep={onboardingStep}
                />
              </SurfaceCard>
            </s-section>

            <SectionDivider />
          </>
        ) : null}

        <s-section heading="Plan & billing">
          {billing?.hardStoppedAt ? (
            <s-banner tone="critical">
              Subscription was stopped immediately at{" "}
              <strong>
                {formatDateTime(billing.hardStoppedAt, merchantTimezone)}
              </strong>
              . Billing access is blocked until you activate a new plan.
            </s-banner>
          ) : null}
          <s-stack direction="inline" gap="base" wrap>
            <s-box style={{ flex: "1 1 360px", minWidth: 320 }}>
              <SurfaceCard padding="base">
                <s-stack direction="block" gap="tight">
                  <s-text tone="subdued">Status</s-text>
                  <s-heading>{statusLabel}</s-heading>
                  <s-text tone="subdued">
                    {billing?.active ? "Plan:" : "Last plan:"}{" "}
                    <strong>
                      {billing?.plan?.name || billing?.planKey || "—"}
                    </strong>
                  </s-text>
                  <s-stack direction="inline" gap="base" wrap>
                    <s-button variant="secondary" onClick={onRefreshBilling}>
                      Refresh billing
                    </s-button>
                    {trialActive && !showByonTrialPaidSwitchOptions ? (
                      <Form method="post">
                        <input type="hidden" name="intent" value="upgrade" />
                        <input
                          type="hidden"
                          name="planKey"
                          value={
                            fallbackTrialUpgradePlanKey ||
                            billing?.planKey ||
                            ORDERX_FREE_PLAN_KEY
                          }
                        />
                        <input
                          type="hidden"
                          name="senderMode"
                          value={
                            isByonPlan ? SENDER_MODE_OWN : SENDER_MODE_ORDERX
                          }
                        />
                        <s-button
                          type="submit"
                          variant="primary"
                          disabled={!fallbackTrialUpgradePlanKey}
                          {...(submittingIntent === "upgrade" &&
                          submittingPlanKey === fallbackTrialUpgradePlanKey
                            ? { loading: true }
                            : {})}
                        >
                          {fallbackTrialUpgradePlanKey
                            ? `Switch to ${fallbackTrialUpgradeLabel}`
                            : "Upgrade to paid"}
                        </s-button>
                      </Form>
                    ) : null}
                    {billing?.subscriptionId ||
                    (isOrderXFreePlan && billing?.active) ? (
                      <s-button
                        variant="secondary"
                        onClick={onCancelSubscription}
                        {...(submittingIntent === "cancel_subscription"
                          ? { loading: true }
                          : {})}
                      >
                        {isOrderXFreePlan
                          ? "Deactivate free plan"
                          : "Cancel subscription"}
                      </s-button>
                    ) : null}
                  </s-stack>
                  <s-text tone="subdued">
                    Period end:{" "}
                    <strong>
                      {billing?.currentPeriodEnd
                        ? formatDateTime(
                            billing.currentPeriodEnd,
                            merchantTimezone,
                          )
                        : "—"}
                    </strong>
                  </s-text>
                  <s-text tone="subdued">
                    Last sync:{" "}
                    <strong>
                      {billing?.lastCheckedAt
                        ? formatDateTime(
                            billing.lastCheckedAt,
                            merchantTimezone,
                          )
                        : "—"}
                    </strong>
                  </s-text>
                  {trialEndsAt && trialActive ? (
                    <s-text tone="subdued">
                      Trial ends:{" "}
                      {formatDateTime(trialEndsAt, merchantTimezone)}
                    </s-text>
                  ) : null}
                  {showByonTrialPaidSwitchOptions &&
                  selectedSenderMode === SENDER_MODE_OWN ? (
                    <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
                      <div
                        style={{
                          display: "grid",
                          gap: 12,
                          gridTemplateColumns:
                            "repeat(auto-fit, minmax(240px, 1fr))",
                        }}
                      >
                        {byonPaidSwitchPlans.map((plan) => {
                          const isRecommended =
                            plan.key === "own_number_scale_10";
                          const isSubmitting =
                            submittingIntent === "upgrade" &&
                            submittingPlanKey === plan.key;
                          return (
                            <SurfaceCard
                              key={plan.key}
                              padding="base"
                              soft={isRecommended}
                              style={{
                                border: "1px solid rgba(15, 23, 42, 0.08)",
                                borderTop: `4px solid ${
                                  isRecommended ? "#0f766e" : "#d0d5dd"
                                }`,
                              }}
                            >
                              <s-stack direction="block" gap="tight">
                                <s-stack direction="inline" gap="base" wrap>
                                  <s-heading>{plan.name}</s-heading>
                                  {isRecommended ? (
                                    <s-badge tone="success">
                                      Recommended
                                    </s-badge>
                                  ) : null}
                                </s-stack>
                                <s-text tone="subdued">
                                  {describePlanPrice(plan, {
                                    showPkrInfo:
                                      shouldShowPkrInfo(merchantTimezone),
                                    usdToPkrRate: usage?.usage?.fx?.usdToPkr,
                                    regionalPricing: billing?.regionalPricing,
                                  })}
                                </s-text>
                                <s-text tone="subdued">
                                  {describePlanDetail(plan, {
                                    regionalPricing: billing?.regionalPricing,
                                  })}
                                </s-text>
                                <Form method="post">
                                  <input
                                    type="hidden"
                                    name="intent"
                                    value="upgrade"
                                  />
                                  <input
                                    type="hidden"
                                    name="planKey"
                                    value={plan.key}
                                  />
                                  <input
                                    type="hidden"
                                    name="senderMode"
                                    value={SENDER_MODE_OWN}
                                  />
                                  <s-button
                                    type="submit"
                                    variant="primary"
                                    {...(isSubmitting ? { loading: true } : {})}
                                  >
                                    Switch to {plan.name}
                                  </s-button>
                                </Form>
                              </s-stack>
                            </SurfaceCard>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </s-stack>
              </SurfaceCard>
              <ConfirmDialog
                open={cancelDialogOpen}
                title={
                  isOrderXFreePlan &&
                  billing?.active &&
                  !billing?.subscriptionId
                    ? "Deactivate OrderX Free?"
                    : "Cancel subscription and stop immediately?"
                }
                message={
                  isOrderXFreePlan &&
                  billing?.active &&
                  !billing?.subscriptionId
                    ? "This will deactivate OrderX Free and block all OrderX sending right away."
                    : "This will cancel the Shopify subscription and stop all OrderX sending immediately."
                }
                details={
                  isOrderXFreePlan &&
                  billing?.active &&
                  !billing?.subscriptionId
                    ? [
                        "If you reactivate the free plan before the current 30-day cycle ends, usage continues from the same allowance.",
                      ]
                    : [
                        "Future renewals stop immediately.",
                        "Current app access ends immediately after cancellation.",
                        "Already-accrued Shopify charges may still appear on the billing statement.",
                        "This action does not request a refund or proration.",
                      ]
                }
                confirmLabel={
                  isOrderXFreePlan &&
                  billing?.active &&
                  !billing?.subscriptionId
                    ? "Deactivate free plan"
                    : "Cancel and stop now"
                }
                cancelLabel="Keep subscription"
                destructive
                loading={submittingIntent === "cancel_subscription"}
                onCancel={() => setCancelDialogOpen(false)}
                onConfirm={confirmCancelSubscription}
              />
            </s-box>

            <s-box style={{ flex: "1 1 420px", minWidth: 320 }}>
              <SurfaceCard padding="base">
                <s-stack direction="block" gap="tight">
                  <s-text tone="subdued">
                    {isByonFreeTrial
                      ? "Your Own Number trial usage"
                      : isOrderXFreePlan
                        ? "OrderX Free usage"
                        : billingType === BILLING_TYPE_SHOPIFY_METERED
                          ? "This month usage"
                          : trialActive
                            ? "Trial WhatsApp usage"
                            : "Billing cycle WhatsApp usage"}
                  </s-text>
                  <s-heading>
                    {!billing?.active
                      ? "—"
                      : isByonPlan && byonTemplateCap > 0
                        ? `${byonUsage.messagesSent || 0} / ${byonTemplateCap}`
                        : isOrderXFreePlan
                          ? `${freeConfirmationUsed} / ${freeConfirmationCap}`
                          : billingType === BILLING_TYPE_SHOPIFY_METERED
                            ? `${cycleBillableConfirmations}`
                            : trialActive
                              ? `${trialMsgsUsed} / ${trialCap}`
                              : quotaManagedByMetaPlan
                                ? byonTemplateCap > 0
                                  ? `${byonUsage.messagesSent || 0} / ${byonTemplateCap}`
                                  : `${byonUsage.messagesSent || 0}`
                                : `${used} / ${limit}`}
                  </s-heading>
                  {billing?.active ? (
                    <>
                      <s-text tone="subdued">
                        {isByonPlan && byonTemplateCap > 0
                          ? `Remaining: ${formatNumber(byonRemainingMessages)} outbound messages`
                          : isOrderXFreePlan
                            ? `Remaining: ${freeConfirmationRemaining}`
                            : trialActive
                              ? `Remaining: ${trialRemaining}`
                              : quotaManagedByMetaPlan
                                ? byonTemplateCap > 0
                                  ? `Remaining: ${formatNumber(byonRemainingMessages)} outbound messages · OrderX overage: ${formatDualCurrency(
                                      {
                                        usd:
                                          byonUsage.orderxUsageCostUsd || 0,
                                        pkr:
                                          byonUsage.orderxUsageCostPkr || 0,
                                        showPkrInfo,
                                      },
                                    )}`
                                  : "No OrderX message cap on this BYON plan"
                                : billingType === BILLING_TYPE_SHOPIFY_METERED
                                  ? `Usage cost: ${formatDualCurrency({
                                      usd: growthUsage.usageCostUsd || 0,
                                      pkr: growthUsage.usageCostPkr || 0,
                                      showPkrInfo,
                                    })}`
                                  : `Remaining: ${remaining}`}
                      </s-text>
                      <SurfaceCard soft padding="tight">
                        <s-text tone="subdued">
                          {isByonFreeTrial
                            ? `${formatNumber(byonTemplateCap || trialCap)} outbound messages included for the 7-day Your Own Number free trial.`
                            : isOrderXFreePlan
                              ? "Counts template messages sent from the OrderX number"
                              : trialActive
                                ? "Trial cap (total messages)"
                                : quotaManagedByMetaPlan
                                  ? byonTemplateCap > 0
                                    ? `${formatNumber(byonTemplateCap)} outbound messages are included each cycle, then ${formatMoney(
                                        Number(
                                          billing?.plan?.usagePrice?.amount ||
                                            0.01,
                                        ),
                                        "USD",
                                      )} per outbound message.`
                                    : "Your Own Number Unlimited has no OrderX message cap."
                                  : billingType === BILLING_TYPE_SHOPIFY_METERED
                                    ? `Approx. remaining before cap: ${formatNumber(growthRemainingMessages)} messages (${growthStoreCountryCode || "store"} baseline)`
                                    : `Usage: ${pct}%`}
                        </s-text>
                      </SurfaceCard>
                      {billingType === BILLING_TYPE_SHOPIFY_METERED ? (
                        <s-button
                          type="button"
                          variant="secondary"
                          onClick={onIncreaseUsageCap}
                          {...(submittingIntent === "increase_usage_cap"
                            ? { loading: true }
                            : {})}
                        >
                          Increase cap to {formatNumber(nextGrowthCapMessages)}{" "}
                          approx. messages
                        </s-button>
                      ) : null}
                    </>
                  ) : (
                    <s-paragraph tone="critical">
                      Billing inactive — WhatsApp sending is blocked.
                    </s-paragraph>
                  )}
                </s-stack>
              </SurfaceCard>
            </s-box>
          </s-stack>

          <s-stack direction="inline" gap="base" wrap style={{ marginTop: 16 }}>
            <MetricTile
              label="Cycle Sent"
              value={
                !billing?.active
                  ? "—"
                  : isByonPlan
                    ? byonUsage.messagesSent || 0
                    : isOrderXFreePlan
                      ? freeConfirmationUsed
                      : billingType === BILLING_TYPE_SHOPIFY_METERED
                        ? cycleBillableConfirmations
                        : trialActive
                          ? trialMsgsUsed
                          : quotaManagedByMetaPlan
                            ? byonUsage.messagesSent || 0
                            : used
              }
              hint={
                isByonFreeTrial
                  ? "Trial outbound messages"
                  : isOrderXFreePlan
                    ? "Used template messages"
                    : billingType === BILLING_TYPE_SHOPIFY_METERED
                      ? "Metered outbound messages this billing cycle"
                      : trialActive
                        ? "Trial period messages"
                        : quotaManagedByMetaPlan
                          ? byonTemplateCap > 0
                            ? `Outbound messages this billing cycle (included: ${formatNumber(byonTemplateCap)})`
                            : "Outbound messages this billing cycle"
                          : "Current cycle usage"
              }
              soft
            />
            <MetricTile
              label={
                billingType === BILLING_TYPE_SHOPIFY_METERED
                  ? "Approx. Cap Remaining"
                  : "Remaining"
              }
              value={
                !billing?.active
                  ? "—"
                  : isByonPlan && byonTemplateCap > 0
                    ? byonRemainingMessages
                    : isOrderXFreePlan
                      ? freeConfirmationRemaining
                      : billingType === BILLING_TYPE_SHOPIFY_METERED
                        ? growthRemainingMessages
                        : trialActive
                          ? trialRemaining
                          : quotaManagedByMetaPlan
                            ? byonTemplateCap > 0
                              ? byonRemainingMessages
                              : "No cap"
                            : remaining
              }
              hint={
                isByonFreeTrial
                  ? "Free trial outbound messages left"
                  : isOrderXFreePlan
                    ? "Free template messages left"
                    : quotaManagedByMetaPlan
                      ? byonTemplateCap > 0
                        ? "Included outbound messages left before OrderX overage billing starts"
                        : "No OrderX cap on this plan"
                      : billingType === BILLING_TYPE_SHOPIFY_METERED
                        ? `Approx. messages left before the current usage cap (${growthStoreCountryCode || "store"} baseline)`
                        : "Messages left before limit"
              }
              soft
            />
            <MetricTile
              label={
                billingType === BILLING_TYPE_SHOPIFY_METERED
                  ? "Usage Cost"
                  : "Subscription"
              }
              value={
                billingType === BILLING_TYPE_SHOPIFY_METERED
                  ? formatDualCurrency({
                      usd: growthUsage.usageCostUsd || 0,
                      pkr: growthUsage.usageCostPkr || 0,
                      showPkrInfo,
                    })
                  : billingType === BILLING_TYPE_FREE_CAP
                    ? isByonFreeTrial
                      ? "Free trial"
                      : "Free plan"
                    : billing?.subscriptionId
                      ? "Connected"
                      : "Not linked"
              }
              hint={
                billingType === BILLING_TYPE_SHOPIFY_METERED
                  ? `Current cap: ${formatMoney(growthCapUsd || 0, "USD")}`
                  : billingType === BILLING_TYPE_FREE_CAP
                    ? isByonFreeTrial
                      ? "No Shopify charge during the BYON trial"
                      : "No Shopify charge required"
                    : quotaManagedByMetaPlan && byonTemplateCap > 0
                      ? `${formatNumber(byonTemplateCap)} outbound messages included every billing cycle, then ${formatMoney(
                          Number(billing?.plan?.usagePrice?.amount || 0.01),
                          "USD",
                        )} per message`
                      : billing?.subscriptionId
                        ? null
                        : "No active Shopify subscription"
              }
              soft
            />
          </s-stack>

          {isOrderXFreePlan && freeConfirmationRemaining <= 0 ? (
            <s-banner tone="warning">
              Free plan limit reached — upgrade to continue sending template
              messages.
            </s-banner>
          ) : isTrialReached ? (
            <s-banner tone="warning">
              Trial cap reached — upgrade to continue sending WhatsApp
              confirmations.
            </s-banner>
          ) : isLimitReached ? (
            <s-banner tone="warning">
              {billingType === BILLING_TYPE_SHOPIFY_METERED
                ? "Growth usage cap reached — increase the USD cap before OrderX sends the next message."
                : "Limit reached — upgrade to continue sending WhatsApp confirmations this billing cycle."}
            </s-banner>
          ) : quotaManagedByMetaPlan &&
            byonTemplateCap > 0 &&
            byonUsage.blocked ? (
            <s-banner tone="warning">
              {isByonFreeTrial
                ? "Your Own Number free trial limit reached. Choose Starter, Scale, or Unlimited to continue sending."
                : "BYON overage billing can’t continue on the current subscription. Refresh billing or switch packages before sending more outbound messages this cycle."}
            </s-banner>
          ) : quotaManagedByMetaPlan &&
            byonTemplateCap > 0 &&
            byonUsage.nearCap ? (
            <s-banner tone="warning">
              Only {formatNumber(byonRemainingMessages)} included BYON outbound
              messages remain on the current package before OrderX starts
              billing{" "}
              {formatMoney(
                Number(billing?.plan?.usagePrice?.amount || 0.01),
                "USD",
              )}{" "}
              per extra outbound message.
            </s-banner>
          ) : isNearLimit ? (
            <s-banner tone="warning">
              {billingType === BILLING_TYPE_SHOPIFY_METERED
                ? `Only ${formatNumber(growthRemainingMessages)} approx. messages remain at your ${growthStoreCountryCode || "store"} baseline before the current cap is reached.`
                : "You’re close to your billing cycle limit — consider upgrading to avoid interruptions."}
            </s-banner>
          ) : null}

          <SurfaceCard padding="base">
            <s-stack direction="block" gap="tight">
              <s-heading>Billing history</s-heading>
              {!billingHistory?.length ? (
                <s-text tone="subdued">No billing history yet.</s-text>
              ) : (
                <s-unordered-list>
                  {billingHistory.slice(0, 10).map((h) => {
                    const name =
                      billing?.plans?.[h.planKey]?.name || h.planKey || "—";
                    const startedAt = h.startedAt
                      ? formatDateTime(h.startedAt, merchantTimezone)
                      : "—";
                    const endedAt = h.endedAt
                      ? formatDateTime(h.endedAt, merchantTimezone)
                      : null;
                    const periodEnd = h.currentPeriodEnd
                      ? formatDateTime(h.currentPeriodEnd, merchantTimezone)
                      : null;
                    const suffix = endedAt
                      ? `Ended: ${endedAt}`
                      : periodEnd
                        ? `Renews: ${periodEnd}`
                        : "Active";
                    return (
                      <s-list-item key={h._id}>
                        <strong>{name}</strong> — {startedAt} — {suffix}
                        {h.test ? " (test)" : ""}
                      </s-list-item>
                    );
                  })}
                </s-unordered-list>
              )}
            </s-stack>
          </SurfaceCard>
        </s-section>

        <div style={{ height: "20px" }} />

        <s-section slot="aside" heading="Usage">
          <s-stack direction="block" gap="base">
            <SurfaceCard padding="base">
              <UsageWidget
                billing={billing}
                usage={usage}
                upgradeHref={appHref("/app/plans")}
                framed={false}
                showPkrInfo={shouldShowPkrInfo(merchantTimezone)}
              />
            </SurfaceCard>
            <SurfaceCard soft padding="base">
              <s-stack direction="block" gap="tight">
                <s-heading>Settings</s-heading>
                <s-text tone="subdued">
                  Confirmation timings, support number, and rules are in
                  Settings.
                </s-text>
                <s-button href={appHref("/app/settings")} variant="secondary">
                  Open settings
                </s-button>
              </s-stack>
            </SurfaceCard>
          </s-stack>
        </s-section>
      </s-box>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
