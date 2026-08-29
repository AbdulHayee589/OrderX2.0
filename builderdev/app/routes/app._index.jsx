// app._index.jsx
import { useEffect, useMemo, useRef } from "react";
import {
  Form,
  redirect,
  useActionData,
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigation,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  UsageWidget,
  AttemptsAnalytics,
  AnalyticsSummary,
} from "../components/AnalyticsWidgets";
import ByonOnboardingFlow from "../components/ByonOnboardingFlow";
import {
  MetricTile,
  SurfaceCard,
  surface,
  HeroBanner,
  EmptyState,
  SectionDivider,
  tokens,
} from "../components/AppSurface";
import { backendPost } from "../server/backend.server";
import { handleByonRouteAction } from "../server/byonActions.server";
import { withShopParams } from "../utils/embedded";
import { resolvePublicAppOrigin } from "../utils/publicOrigin";
import {
  describePlanDetail,
  describePlanPrice,
  formatMoney,
  shouldShowPkrInfo,
} from "../utils/billingPresentation";

const toObject = (v) => (v && typeof v === "object" ? v : {});
const SENDER_MODE_ORDERX = "orderx_number";
const SENDER_MODE_OWN = "own_number";
const BILLING_TYPE_FREE_CAP = "free_cap";
const BILLING_TYPE_SHOPIFY_METERED = "shopify_metered";
const BILLING_TYPE_SHOPIFY_FLAT = "shopify_flat";
const ORDERX_FREE_PLAN_KEY = "orderx_free_5";
const BYON_FREE_TRIAL_PLAN_KEY = "own_number_free_trial_200";

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

function ownSenderStatusMeta(status) {
  switch (String(status || "")) {
    case "ready":
      return { label: "Ready", tone: "success" };
    case "templates_pending":
      return { label: "Templates pending approval", tone: "warning" };
    case "registration_pending":
      return { label: "Cloud registration pending", tone: "warning" };
    case "meta_connect_pending":
      return { label: "Meta connection pending", tone: "warning" };
    case "collecting_details":
      return { label: "Details required", tone: "warning" };
    case "reauth_required":
      return { label: "Reconnect Meta required", tone: "critical" };
    case "error":
      return { label: "Setup issue", tone: "critical" };
    default:
      return { label: "Not started", tone: "warning" };
  }
}

function resolveAppOrigin(reqUrl) {
  return (
    resolvePublicAppOrigin(
      reqUrl?.toString?.() || reqUrl?.origin || "",
      process.env.SHOPIFY_APP_URL || process.env.APP_URL || "",
    ) || reqUrl.origin
  );
}

function attemptTone(status) {
  if (status === "confirmed") return "success";
  if (status === "cancelled" || status === "failed") return "critical";
  if (["scheduled", "pending", "wa_sent"].includes(status)) return "warning";
  return "subdued";
}

function attemptBorder(status) {
  if (status === "confirmed") return "#059669";
  if (status === "cancelled" || status === "failed") return "#dc2626";
  if (["scheduled", "pending", "wa_sent"].includes(status)) return "#d97706";
  return "#94a3b8";
}

function BackButtonIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      style={{ flexShrink: 0 }}
    >
      <path
        d="M15 18l-6-6 6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  return {
    ok: true,
    dashboardShell: true,
    coreLoaded: false,
    analyticsLoaded: false,
    analyticsAvailable: false,
    metricsLoaded: false,
    attemptsLoaded: false,
    billing: null,
    usage: null,
    confirmed: 0,
    cancelled: 0,
    pending: 0,
    attemptTotal: 0,
    metrics: [],
    attempts: [],
    recentAttempts: [],
    sender: {},
    senderMetaConfig: {},
    merchantTimezone: "UTC",
    warnings: [],
    error: "",
  };
};

export const action = async ({ request }) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = session.shop;

  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  const byonActionResult = await handleByonRouteAction({
    intent,
    form,
    shop,
    requestUrl: request.url,
  });
  if (byonActionResult) return byonActionResult;

  const planKey = String(form.get("planKey") || ORDERX_FREE_PLAN_KEY);

  const isTest = false;

  if (
    planKey === ORDERX_FREE_PLAN_KEY ||
    planKey === BYON_FREE_TRIAL_PLAN_KEY
  ) {
    try {
      await backendPost("/api/billing/validate-change", shop, {
        targetPlanKey: planKey,
      });
      const start = await backendPost("/api/billing/subscribe", shop, {
        planKey,
      });
      if (!start?.ok) {
        return {
          ok: false,
          error: start?.error || "Failed to activate free plan",
          errorData: start || null,
        };
      }
      const url = new URL(request.url);
      if (planKey === BYON_FREE_TRIAL_PLAN_KEY) {
        const nextUrl = new URL("/app/plans", url.origin);
        url.searchParams.forEach((value, key) => {
          nextUrl.searchParams.set(key, value);
        });
        nextUrl.searchParams.set("senderMode", SENDER_MODE_OWN);
        nextUrl.searchParams.set("onboardingStep", "templates");
        throw redirect(
          `${nextUrl.pathname}?${nextUrl.searchParams.toString()}`,
        );
      }
      throw redirect(`${url.pathname}?${url.searchParams.toString()}`);
    } catch (e) {
      if (e instanceof Response) throw e;
      return {
        ok: false,
        error: `Failed to activate free plan: ${e?.message || "Failed"}`,
        errorData: e?.data || e?.errorData || null,
      };
    }
  }

  const reqUrl = new URL(request.url);
  const appOrigin = resolveAppOrigin(reqUrl);
  const returnUrl = new URL("/app/billing/confirm", appOrigin);
  returnUrl.searchParams.set("shop", shop);
  const host = reqUrl.searchParams.get("host") || session.host || "";
  if (host) returnUrl.searchParams.set("host", host);
  returnUrl.searchParams.set("embedded", "1");
  returnUrl.searchParams.set("plan", planKey);

  try {
    // Enforce plan-change rules (e.g., prevent downgrades beyond current usage).
    try {
      await backendPost("/api/billing/validate-change", shop, {
        targetPlanKey: planKey,
      });
    } catch (e) {
      return {
        ok: false,
        error: `Backend check failed: ${e?.message || "Failed"}`,
        errorData: e?.data || e?.errorData || null,
      };
    }

    try {
      await billing.request({
        plan: planKey,
        isTest,
        returnUrl: returnUrl.toString(),
      });
    } catch (e) {
      // billing.request throws a Response redirect when successful; don't swallow it.
      if (e instanceof Response) throw e;

      console.error("[billing.request]", {
        shop,
        planKey,
        isTest,
        returnUrl: returnUrl.toString(),
        message: e?.message,
        errorData: e?.errorData,
      });

      return {
        ok: false,
        error: `Shopify billing failed: ${e?.message || "Failed"}`,
        errorData: e?.data || e?.errorData || null,
      };
    }
  } catch (e) {
    // billing.request throws a Response redirect when successful; don't swallow it.
    if (e instanceof Response) throw e;

    console.error("[billing.request]", {
      shop,
      planKey,
      isTest,
      returnUrl: returnUrl.toString(),
      message: e?.message,
      errorData: e?.errorData,
    });

    return {
      ok: false,
      error: e?.message || "Billing failed",
      errorData: e?.data || e?.errorData || null,
    };
  }
};

export default function Index() {
  const initialData = useLoaderData();
  const actionData = useActionData();
  const location = useLocation();
  const navigation = useNavigation();
  const dashboardFetcher = useFetcher();
  const dashboardRequested = useRef(false);
  const refreshDashboardAfterAction = useRef(false);
  const appHref = (href) => withShopParams(href, location.search);
  const fetchedData = useMemo(
    () => toObject(dashboardFetcher.data),
    [dashboardFetcher.data],
  );
  const hasFetchedData = Object.keys(fetchedData).length > 0;
  const data = useMemo(() => {
    if (!hasFetchedData) return initialData;
    const initialWarnings = Array.isArray(initialData.warnings)
      ? initialData.warnings
      : [];
    const fetchedWarnings = Array.isArray(fetchedData.warnings)
      ? fetchedData.warnings
      : [];
    return {
      ...initialData,
      ...fetchedData,
      warnings: Array.from(
        new Set(
          fetchedData.scope === "all"
            ? fetchedWarnings
            : [...initialWarnings, ...fetchedWarnings],
        ),
      ),
    };
  }, [fetchedData, hasFetchedData, initialData]);
  const dashboardReady = data.coreLoaded === true;
  const analyticsLoaded = data.analyticsLoaded === true;
  const attemptsLoaded = data.attemptsLoaded === true;
  const dashboardLoading =
    dashboardFetcher.state !== "idle" ||
    (!hasFetchedData && initialData.coreLoaded !== true);
  const dashboardWarnings = Array.isArray(data.warnings) ? data.warnings : [];

  const loadDashboardData = (scope = "all") => {
    dashboardFetcher.load(
      withShopParams(`/app/dashboard-data?scope=${scope}`, location.search),
    );
  };

  useEffect(() => {
    if (dashboardRequested.current) return;
    dashboardRequested.current = true;
    dashboardFetcher.load(
      withShopParams(
        `/app/dashboard-data?scope=${initialData.coreLoaded ? "analytics" : "all"}`,
        location.search,
      ),
    );
  }, [dashboardFetcher, initialData.coreLoaded, location.search]);

  useEffect(() => {
    if (navigation.state !== "idle") {
      if (navigation.formData || navigation.formMethod) {
        refreshDashboardAfterAction.current = true;
      }
      return;
    }
    if (!refreshDashboardAfterAction.current) return;
    refreshDashboardAfterAction.current = false;
    dashboardFetcher.load(
      withShopParams("/app/dashboard-data?scope=all", location.search),
    );
  }, [
    dashboardFetcher,
    location.search,
    navigation.formData,
    navigation.formMethod,
    navigation.state,
  ]);
  const senderView = toObject(data.sender);
  const ownSender = toObject(senderView?.ownNumber);
  const ownSenderProgress = toObject(ownSender?.progress);
  const ownSenderTemplates = Array.isArray(ownSender?.templates)
    ? ownSender.templates
    : [];
  const byonTestTemplate = ownSenderTemplates.find(
    (t) => String(t?.key || "") === "cod_confirm_new",
  );
  const byonTestTemplateApproved =
    String(byonTestTemplate?.status || "") === "approved";
  const ownCloudRegistration = toObject(ownSender?.cloudRegistration);
  const ownCloudPlatform = String(
    ownCloudRegistration?.platformType || "",
  ).trim();
  const ownCloudPhoneStatus = String(
    ownCloudRegistration?.phoneStatus || "",
  ).trim();
  const ownCloudConnected =
    ownCloudPlatform.toUpperCase() === "CLOUD_API" &&
    ownCloudPhoneStatus.toUpperCase() === "CONNECTED";
  const byonSetupReady =
    String(ownSender?.status || "") === "ready" ||
    !!ownSenderProgress?.dashboardReady;
  const ownCloudOutcome = String(ownCloudRegistration?.outcome || "").trim();
  const isOwnNumberPlanActive =
    String(data.billing?.plan?.senderMode || "").trim() === SENDER_MODE_OWN;
  const showByonLiveTest =
    isOwnNumberPlanActive && byonSetupReady && byonTestTemplateApproved;
  const byonStatusUi = ownSenderStatusMeta(String(ownSender?.status || ""));
  const byonTestDisabledReason = !showByonLiveTest
    ? "BYON test is only available once Your Own Number setup is fully ready."
    : !ownSenderProgress?.metaConnected
      ? "Complete Meta connection first."
      : !(
            String(ownSender?.cloudRegistration?.status || "") ===
              "registered" || ownCloudConnected
          )
        ? ownCloudOutcome === "NEED_RECONNECT"
          ? "This onboarding session expired. Reconnect your number through Meta Embedded Signup."
          : ownCloudOutcome === "NEED_PIN"
            ? ownSender?.cloudRegistration?.error ||
              "Enter the existing 6-digit WhatsApp two-step PIN before testing."
            : ownSender?.cloudRegistration?.error ||
              "OrderX is still waiting for Meta to confirm Cloud readiness before testing."
        : !ownSender?.accessTokenConnected
          ? "Reconnect Meta and save a valid access token first."
          : "";
  const isSubmittingByonTest =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "byon_test_send";
  const byonTestSendResult =
    actionData?.intent === "byon_test_send" && actionData?.ok
      ? toObject(actionData?.testSend)
      : null;
  const byonTestSendError =
    actionData?.intent === "byon_test_send" && !actionData?.ok
      ? String(actionData?.error || "Failed")
      : "";
  const formInputStyle = {
    width: "100%",
    maxWidth: "100%",
    minWidth: 0,
    display: "block",
    boxSizing: "border-box",
    border: "1px solid #c9cccf",
    borderRadius: 8,
    padding: "10px 12px",
    background: "#fff",
  };

  const totalAttempts = Number(data.attemptTotal ?? data.attempts?.length ?? 0);
  const usageSummary = toObject(data.usage?.usage);
  const monthUsed = Number(
    usageSummary.month ?? usageSummary.waMessagesSent ?? 0,
  );
  const freePlanUsage = toObject(usageSummary.freePlanUsage);
  const growthUsage = toObject(usageSummary.growthUsage);
  const byonUsage = toObject(usageSummary.byonUsage);
  const regionalPricing = toObject(data.billing?.regionalPricing);
  const billingType = String(data.billing?.plan?.billingType || "").trim();
  const billingPlanSenderMode = String(
    data.billing?.plan?.senderMode || "",
  ).trim();
  const monthLimit = Number(
    usageSummary.limitMonthly ||
      usageSummary.limit ||
      data.billing?.plan?.monthlyMessages ||
      (Number(data.billing?.plan?.dailyMessages || 0) > 0
        ? Number(data.billing?.plan?.dailyMessages || 0) * 30
        : 0),
  );
  const quotaManagedByMetaPlan =
    data.billing?.plan?.quotaManagedByMeta === true;
  const isByonPlan =
    billingPlanSenderMode === SENDER_MODE_OWN || quotaManagedByMetaPlan;
  const byonTemplateCap = Number(
    byonUsage.outboundMessageCap ??
      data.billing?.plan?.outboundMessageCap ??
      byonUsage.templateMessageCap ??
      data.billing?.plan?.templateMessageCap ??
      0,
  );
  const effectiveByonTestDisabledReason =
    byonTestDisabledReason ||
    (quotaManagedByMetaPlan && byonTemplateCap > 0 && byonUsage.blocked
      ? "This BYON package can’t bill more outbound messages right now. Refresh billing or switch packages before testing again."
      : "");
  const monthRemaining = monthLimit ? Math.max(0, monthLimit - monthUsed) : 0;
  const confirmedRate = attemptsLoaded
    ? totalAttempts
      ? `${Math.round((data.confirmed / totalAttempts) * 100)}%`
      : "0%"
    : "—";

  const kpis = useMemo(
    () => [
      {
        label: "Confirmed",
        value: attemptsLoaded ? data.confirmed : "—",
        hint: attemptsLoaded
          ? `${confirmedRate} success rate`
          : "Loading cycle activity",
        accent: tokens.color.success,
      },
      {
        label: "Cancelled",
        value: attemptsLoaded ? data.cancelled : "—",
        hint: attemptsLoaded
          ? "Customer cancellations"
          : "Loading cycle activity",
        accent: tokens.color.critical,
      },
      {
        label: "Pending",
        value: attemptsLoaded ? data.pending : "—",
        hint: attemptsLoaded
          ? "Waiting customer action"
          : "Loading cycle activity",
        accent: tokens.color.warning,
      },
      {
        label: "Cycle Remaining",
        value:
          isByonPlan && byonTemplateCap > 0
            ? (byonUsage.remainingMessages ?? "N/A")
            : billingType === BILLING_TYPE_FREE_CAP
              ? (freePlanUsage.remaining ?? "N/A")
              : billingType === BILLING_TYPE_SHOPIFY_METERED
                ? (growthUsage.remainingMessages ?? "N/A")
                : monthLimit
                  ? monthRemaining
                  : "N/A",
        hint:
          isByonPlan && byonTemplateCap > 0
            ? `${byonUsage.messagesSent || 0}/${byonTemplateCap} BYON outbound messages used.`
            : billingType === BILLING_TYPE_FREE_CAP
              ? `${freePlanUsage.used || 0}/${freePlanUsage.limit || 0} template messages used`
              : billingType === BILLING_TYPE_SHOPIFY_METERED
                ? `${growthUsage.messagesSent || 0} metered outbound messages this billing cycle. Approx. remaining shown at the ${growthUsage.storeCountryCode || data.billing?.storeCountryCode || regionalPricing.storeCountryCode || "store"} baseline.`
                : monthLimit
                  ? quotaManagedByMetaPlan
                    ? `${byonUsage.messagesSent || 0} outbound messages this billing cycle`
                    : `${monthUsed}/${monthLimit} used this billing cycle`
                  : "No active cap",
        accent: tokens.color.info,
      },
    ],
    [
      billingType,
      attemptsLoaded,
      confirmedRate,
      freePlanUsage.limit,
      freePlanUsage.remaining,
      freePlanUsage.used,
      growthUsage.messagesSent,
      growthUsage.remainingMessages,
      growthUsage.storeCountryCode,
      monthLimit,
      monthRemaining,
      monthUsed,
      regionalPricing.storeCountryCode,
      byonTemplateCap,
      byonUsage.messagesSent,
      byonUsage.remainingMessages,
      data,
      isByonPlan,
      quotaManagedByMetaPlan,
    ],
  );

  if (!dashboardReady) {
    return (
      <s-page suppressHydrationWarning>
        <s-button
          slot="primary-action"
          href={appHref("/app/settings")}
          suppressHydrationWarning
        >
          Settings
        </s-button>
        <s-box style={surface.shell}>
          <HeroBanner title="COD confirmations at a glance" />
          <s-section heading="Store connection">
            <SurfaceCard soft padding="base">
              <div
                role="alert"
                aria-busy={dashboardLoading ? "true" : "false"}
                style={{ display: "grid", gap: 12 }}
              >
                <strong style={{ color: tokens.color.text }}>
                  {dashboardLoading
                    ? "Loading your store dashboard"
                    : "The dashboard data service took too long to respond"}
                </strong>
                <span style={{ color: tokens.color.textSub, lineHeight: 1.5 }}>
                  {data.error ||
                    "Your COD and WhatsApp automations continue running in the background. Retry this view without refreshing the whole Shopify app."}
                </span>
                <div>
                  <button
                    type="button"
                    onClick={() => loadDashboardData("all")}
                    disabled={dashboardLoading}
                    style={{
                      minHeight: 40,
                      padding: "0 16px",
                      border: 0,
                      borderRadius: 10,
                      background: "#08745a",
                      color: "#fff",
                      fontWeight: 800,
                      cursor: dashboardLoading ? "wait" : "pointer",
                      opacity: dashboardLoading ? 0.7 : 1,
                    }}
                  >
                    {dashboardLoading ? "Connecting..." : "Retry dashboard"}
                  </button>
                </div>
              </div>
            </SurfaceCard>
          </s-section>
        </s-box>
      </s-page>
    );
  }

  if (!data.billing?.active) {
    const submittingPlanKey =
      navigation.state === "submitting"
        ? navigation.formData?.get("planKey")
        : null;
    return (
      <PricingScreen
        billing={data.billing}
        actionData={actionData}
        submittingPlanKey={submittingPlanKey}
        merchantTimezone={data.merchantTimezone}
        appHref={appHref}
        locationSearch={location.search}
        sender={data.sender}
        senderMetaConfig={data.senderMetaConfig}
      />
    );
  }

  return (
    <s-page suppressHydrationWarning>
      <s-button
        slot="primary-action"
        href={appHref("/app/settings")}
        suppressHydrationWarning
      >
        Settings
      </s-button>

      <s-box style={surface.shell}>
        <HeroBanner title="COD confirmations at a glance" />

        {planSenderMode(data.billing?.plan, data.billing?.planKey) ===
        SENDER_MODE_OWN ? (
          <div
            role="note"
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              marginBottom: 18,
              padding: "18px 20px",
              border: "1px solid #efd28a",
              borderRadius: 18,
              background:
                "linear-gradient(135deg, #fff8e7 0%, #fffdf7 62%, #eef8f2 100%)",
              boxShadow: "0 10px 28px rgba(72, 54, 20, 0.07)",
            }}
          >
            <div style={{ flex: "1 1 520px", minWidth: 0 }}>
              <div
                style={{
                  marginBottom: 5,
                  color: "#8a5a00",
                  fontSize: 13,
                  fontWeight: 900,
                }}
              >
                Use Agent Accounts for customer support
              </div>
              <div style={{ color: "#5f5848", lineHeight: 1.5 }}>
                For the most reliable WhatsApp Cloud API connection, avoid using
                WhatsApp Linked Devices for staff support. Give your team secure
                OrderX Agent Accounts instead, without sharing your Meta
                credentials.
              </div>
            </div>
            <a
              href={appHref("/app/agents")}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                minHeight: 42,
                padding: "0 17px",
                border: "1px solid #075e54",
                borderRadius: 12,
                background: "#075e54",
                color: "#fff",
                fontWeight: 850,
                textDecoration: "none",
                whiteSpace: "nowrap",
              }}
            >
              Set up Agent Accounts
            </a>
          </div>
        ) : null}

        {dashboardWarnings.length ? (
          <s-banner tone="warning">
            <s-stack direction="block" gap="tight">
              <s-heading>Some dashboard details are delayed</s-heading>
              <s-paragraph>{dashboardWarnings.join(" ")}</s-paragraph>
              <div>
                <button
                  type="button"
                  onClick={() => loadDashboardData("all")}
                  disabled={dashboardLoading}
                  style={{
                    minHeight: 36,
                    padding: "0 14px",
                    border: "1px solid #b98a24",
                    borderRadius: 9,
                    background: "#fff",
                    color: "#6b4a00",
                    fontWeight: 800,
                    cursor: dashboardLoading ? "wait" : "pointer",
                  }}
                >
                  {dashboardLoading ? "Retrying..." : "Retry delayed details"}
                </button>
              </div>
            </s-stack>
          </s-banner>
        ) : null}

        <s-section heading="Performance snapshot">
          <s-stack direction="inline" gap="base" wrap>
            {kpis.map((kpi) => (
              <MetricTile
                key={kpi.label}
                label={kpi.label}
                value={kpi.value}
                hint={kpi.hint}
                accent={kpi.accent}
                soft
              />
            ))}
          </s-stack>
        </s-section>

        <SectionDivider />

        <s-section heading="Usage">
          <SurfaceCard padding="base">
            <UsageWidget
              billing={data.billing}
              usage={data.usage}
              upgradeHref={appHref("/app/plans")}
              framed={false}
              showPkrInfo={shouldShowPkrInfo(data.merchantTimezone)}
            />
          </SurfaceCard>
        </s-section>

        <SectionDivider />

        <s-section heading="Analytics">
          {!analyticsLoaded ? (
            <SurfaceCard soft padding="base">
              <div
                aria-busy="true"
                style={{ color: tokens.color.textSub, lineHeight: 1.5 }}
              >
                Loading analytics in the background. You can continue using
                OrderX while this finishes.
              </div>
            </SurfaceCard>
          ) : data.analyticsAvailable ? (
            <s-stack direction="block" gap="base">
              <SurfaceCard padding="base">
                <s-stack direction="block" gap="tight">
                  <div
                    style={{
                      fontWeight: 700,
                      fontSize: 14,
                      color: tokens.color.text,
                      marginBottom: 4,
                    }}
                  >
                    Store analytics
                  </div>
                  <AnalyticsSummary metrics={data.metrics} />
                </s-stack>
              </SurfaceCard>
              <SurfaceCard padding="base">
                <AttemptsAnalytics attempts={data.attempts} />
              </SurfaceCard>
            </s-stack>
          ) : (
            <SurfaceCard soft padding="base">
              <div style={{ color: tokens.color.textSub, lineHeight: 1.5 }}>
                Analytics could not be loaded right now. The dashboard remains
                usable, and you can retry the delayed details above.
              </div>
            </SurfaceCard>
          )}
        </s-section>

        {showByonLiveTest ? (
          <>
            <SectionDivider />
            <s-section heading="BYON live test">
              <SurfaceCard padding="base">
                <s-stack direction="block" gap="base">
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 8,
                      alignItems: "center",
                    }}
                  >
                    <s-badge tone={byonStatusUi.tone}>
                      Sender: {byonStatusUi.label}
                    </s-badge>
                    <s-badge
                      tone={
                        ownSender?.accessTokenConnected ? "success" : "warning"
                      }
                    >
                      {ownSender?.accessTokenConnected
                        ? "Meta token saved"
                        : "Meta token missing"}
                    </s-badge>
                    <s-badge
                      tone={byonTestTemplateApproved ? "success" : "warning"}
                    >
                      Template:{" "}
                      {byonTestTemplateApproved
                        ? "Approved"
                        : String(byonTestTemplate?.status || "missing")}
                    </s-badge>
                  </div>

                  <s-paragraph>
                    Send a real template test using your own WhatsApp number
                    sender after Meta setup and the full English template pack
                    are approved. This test counts toward your trial/plan usage.
                  </s-paragraph>

                  {byonTestSendError ? (
                    <s-banner tone="critical">
                      <s-stack direction="block" gap="tight">
                        <s-heading>Test message failed</s-heading>
                        <s-paragraph>{byonTestSendError}</s-paragraph>
                      </s-stack>
                    </s-banner>
                  ) : null}

                  {byonTestSendResult?.waMessageId ? (
                    <s-banner tone="success">
                      <s-stack direction="block" gap="tight">
                        <s-heading>Test message sent</s-heading>
                        <s-paragraph>
                          Sent to <strong>{byonTestSendResult.to}</strong> using{" "}
                          <code>
                            {byonTestSendResult.templateUsed ||
                              byonTestSendResult.templateKey ||
                              "template"}
                          </code>
                          .
                        </s-paragraph>
                        <s-text tone="subdued">
                          Message ID: {byonTestSendResult.waMessageId}
                        </s-text>
                      </s-stack>
                    </s-banner>
                  ) : null}

                  <Form method="post">
                    <input type="hidden" name="intent" value="byon_test_send" />
                    <div style={{ display: "grid", gap: 14, maxWidth: 480 }}>
                      <label style={{ display: "grid", gap: 6 }}>
                        <span
                          style={{
                            fontWeight: 600,
                            fontSize: 13,
                            color: tokens.color.textSub,
                          }}
                        >
                          Test phone number (E.164)
                        </span>
                        <input
                          name="byonTestPhone"
                          type="tel"
                          placeholder="+923001234567"
                          defaultValue={String(
                            ownSender?.requestedPhoneNumber ||
                              ownSender?.displayPhoneNumber ||
                              "",
                          )}
                          style={formInputStyle}
                        />
                      </label>
                      <label style={{ display: "grid", gap: 6 }}>
                        <span
                          style={{
                            fontWeight: 600,
                            fontSize: 13,
                            color: tokens.color.textSub,
                          }}
                        >
                          Customer name (optional)
                        </span>
                        <input
                          name="byonTestCustomerName"
                          placeholder="Test Customer"
                          defaultValue=""
                          style={formInputStyle}
                        />
                      </label>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          flexWrap: "wrap",
                        }}
                      >
                        <s-button
                          type="submit"
                          variant="primary"
                          disabled={!!effectiveByonTestDisabledReason}
                          {...(isSubmittingByonTest ? { loading: true } : {})}
                        >
                          Send test message
                        </s-button>
                        {effectiveByonTestDisabledReason ? (
                          <s-text tone="critical">
                            {effectiveByonTestDisabledReason}
                          </s-text>
                        ) : null}
                      </div>
                    </div>
                  </Form>
                </s-stack>
              </SurfaceCard>
            </s-section>
          </>
        ) : null}

        <SectionDivider />

        <s-section heading="Recent attempts">
          {!analyticsLoaded ? (
            <SurfaceCard soft padding="base">
              <div
                aria-busy="true"
                style={{ color: tokens.color.textSub, lineHeight: 1.5 }}
              >
                Loading recent confirmations...
              </div>
            </SurfaceCard>
          ) : !attemptsLoaded ? (
            <SurfaceCard soft padding="base">
              <div style={{ color: tokens.color.textSub, lineHeight: 1.5 }}>
                Recent confirmations could not be loaded right now. Retry the
                delayed details above.
              </div>
            </SurfaceCard>
          ) : !data.recentAttempts?.length ? (
            <SurfaceCard soft padding="none">
              <EmptyState
                title="No attempts yet"
                message="OrderX will show recent WhatsApp confirmation attempts here once your first COD orders come in."
                action={
                  <s-button href={appHref("/app/attempts")} variant="secondary">
                    View Order confimations
                  </s-button>
                }
              />
            </SurfaceCard>
          ) : (
            <>
              <div
                style={{
                  display: "grid",
                  gap: 8,
                }}
              >
                {data.recentAttempts.map((attempt) => (
                  <div
                    key={attempt._id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "12px 16px",
                      borderRadius: tokens.radius.lg,
                      border: `1px solid ${tokens.color.border}`,
                      background: tokens.color.bg,
                      boxShadow: tokens.shadow.xs,
                      borderLeft: `3px solid ${attemptBorder(attempt.status)}`,
                      flexWrap: "wrap",
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 700,
                        fontSize: 14,
                        color: tokens.color.text,
                        minWidth: 80,
                      }}
                    >
                      {attempt.orderName || "Order"}
                    </div>
                    <s-badge tone={attemptTone(attempt.status)}>
                      {attempt.status || "unknown"}
                    </s-badge>
                    {attempt.customerName ? (
                      <div
                        style={{
                          fontSize: 13,
                          color: tokens.color.textSub,
                          flex: "1 1 120px",
                        }}
                      >
                        {attempt.customerName}
                      </div>
                    ) : null}
                    <div
                      style={{
                        fontSize: 13,
                        color: tokens.color.textMuted,
                        flex: "1 1 120px",
                      }}
                    >
                      {attempt.phoneE164 || "—"}
                    </div>
                    {attempt.waTemplateUsed ? (
                      <div
                        style={{
                          fontSize: 12,
                          color: tokens.color.textMuted,
                          flex: "1 1 160px",
                          fontStyle: "italic",
                        }}
                      >
                        {attempt.waTemplateUsed}
                      </div>
                    ) : null}
                    {attempt.lastError ? (
                      <div
                        style={{
                          fontSize: 12,
                          color: tokens.color.critical,
                          background: tokens.color.criticalBg,
                          borderRadius: tokens.radius.sm,
                          padding: "2px 8px",
                          flex: "1 1 160px",
                        }}
                      >
                        {attempt.lastError}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 14 }}>
                <s-button href={appHref("/app/attempts")} variant="secondary">
                  View all attempts
                </s-button>
              </div>
            </>
          )}
        </s-section>
      </s-box>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);

function PricingScreen({
  billing,
  actionData,
  submittingPlanKey,
  merchantTimezone,
  appHref,
  locationSearch,
  sender,
  senderMetaConfig,
}) {
  const plans =
    billing?.plans && Object.keys(billing.plans).length
      ? billing.plans
      : {
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

  const planEntries = Object.entries(plans);
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
  const hasSavedPlanChoice = hasActiveBillingChoice;
  const senderModeParam = new URLSearchParams(locationSearch || "").get(
    "senderMode",
  );
  // Once a trial/plan exists, the active billing plan is the source of truth.
  // Ignore any stale `senderMode` query param to prevent UI mismatches.
  const selectedSenderMode = hasSavedPlanChoice
    ? currentSenderMode
    : senderModeParam === SENDER_MODE_ORDERX ||
        senderModeParam === SENDER_MODE_OWN
      ? senderModeParam
      : null;
  const hasExplicitModeChoice =
    selectedSenderMode === SENDER_MODE_ORDERX ||
    selectedSenderMode === SENDER_MODE_OWN;

  const visiblePlanEntries = planEntries
    .filter(([key, plan]) => {
      return (
        planSenderMode(plan, key) === selectedSenderMode &&
        (plan?.visible !== false || billing?.planKey === key)
      );
    })
    .sort(([, a], [, b]) => Number(a?.price || 0) - Number(b?.price || 0));

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
  const hasCurrentPlanSelection =
    !!billing?.planKey &&
    (!!billing?.active ||
      billing?.status === "TRIAL" ||
      billing?.status === "ACTIVE" ||
      !!billing?.subscriptionId);
  const actionIntent = String(actionData?.intent || "");
  const isByonSetupAction = actionIntent.startsWith("byon_");
  const pricingError = !isByonSetupAction ? actionData?.error || null : null;
  const pricingErrorTitle = "Couldn’t start billing";
  const byonPlanStepContent =
    selectedSenderMode === SENDER_MODE_OWN ? (
      <div>
        {pricingError ? (
          <s-banner tone="critical">
            <s-stack direction="block" gap="tight">
              <s-heading>{pricingErrorTitle}</s-heading>
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
            Choose the <strong>Your Own Number</strong> package after Meta
            connect and Meta billing are ready. OrderX charges a flat monthly
            fee here, while Meta message charges stay on the merchant’s Meta
            account.
          </s-paragraph>
        </SurfaceCard> */}

          {/* {byonSetupError ? ( */}

          {/* ) : null} */}

          <div
            className="byon-plan-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 16,
              alignItems: "stretch",
            }}
          >
            {visiblePlanEntries
              .slice()
              .reverse()
              .map(([key, plan]) => {
                const isCurrentActivePlan =
                  billing?.planKey === key && hasCurrentPlanSelection;
                const isByonFreeTrialUsed =
                  key === BYON_FREE_TRIAL_PLAN_KEY &&
                  billing?.byonTrialUsed &&
                  !isCurrentActivePlan;
                const disabled =
                  !byonPlanStepReady ||
                  isCurrentActivePlan ||
                  isByonFreeTrialUsed;
                const isRecommended = key === "own_number_scale_10";
                return (
                  <div
                    key={key}
                    className={`byon-plan-grid-item ${
                      isRecommended
                        ? "byon-plan-grid-item--scale"
                        : key === "own_number_starter_5"
                          ? "byon-plan-grid-item--starter"
                          : ""
                    }`.trim()}
                    style={{
                      background: "#fff",
                      padding: "12px",
                      boxShadow:
                        "0 0 24px rgba(15, 23, 42, 0.18), 0 0 8px rgba(15, 23, 42, 0.10)",
                      borderRadius: "12px",
                    }}
                  >
                    {/* <SurfaceCard
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
                  > */}
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 12,
                        justifyContent: "space-between",
                        height: "100%",
                      }}
                    >
                      <div style={{ flex: 1 }}>
                        <s-stack direction="block" gap="tight">
                          <s-stack direction="inline" gap="base" wrap>
                            <s-heading>{plan.name}</s-heading>
                            {isRecommended ? (
                              <s-badge tone="success">Recommended</s-badge>
                            ) : null}
                            {isCurrentActivePlan ? (
                              <s-badge tone="success">Current</s-badge>
                            ) : null}
                          </s-stack>
                          <div style={{ marginTop: "12px" }}>
                            {describePlanPrice(plan, {
                              showPkrInfo: shouldShowPkrInfo(merchantTimezone),
                              regionalPricing,
                            }) ? (
                              <s-text tone="subdued">
                                {describePlanPrice(plan, {
                                  showPkrInfo:
                                    shouldShowPkrInfo(merchantTimezone),
                                  regionalPricing,
                                })}
                              </s-text>
                            ) : null}
                            {describePlanDetail(plan, { regionalPricing }) ? (
                              <s-text tone="subdued">
                                {describePlanDetail(plan, { regionalPricing })}
                              </s-text>
                            ) : null}
                          </div>
                        </s-stack>
                      </div>
                      <Form method="post">
                        <input type="hidden" name="planKey" value={key} />
                        <s-button
                          type="submit"
                          variant="primary"
                          disabled={disabled}
                          {...(submittingPlanKey === key
                            ? { loading: true }
                            : {})}
                        >
                          {disabled
                            ? isCurrentActivePlan
                              ? "Active"
                              : isByonFreeTrialUsed
                                ? "Trial used"
                                : "Available after Meta + payment steps"
                            : key === BYON_FREE_TRIAL_PLAN_KEY
                              ? "Start free trial"
                              : byonPlanSelected
                                ? "Upgrade"
                                : "Activate own number plan"}
                        </s-button>
                      </Form>
                    </div>
                    {/* </SurfaceCard> */}
                  </div>
                );
              })}
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

  if (!hasExplicitModeChoice) {
    return (
      <s-page suppressHydrationWarning>
        <s-box style={surface.shell}>
          <s-section heading="Choose which number to send your messages from:">
            {/* GRID WRAPPER */}

            {/* MOBILE RESPONSIVE (no media queries needed if you can’t use CSS files)
          If your environment supports it, prefer CSS media queries.
          Otherwise, you can optionally swap to 1 column based on window width in JS. */}
            <style
              dangerouslySetInnerHTML={{
                __html: `
            @media (max-width: 720px) {
              .senderGrid {
                grid-template-columns: 1fr !important;
              }
            }
          `,
              }}
            />
          </s-section>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
              gap: 16,
              alignItems: "stretch",
              marginTop: "12px",
            }}
          >
            {/* LEFT CARD */}
            <s-section heading="1) Your Whatsapp Number">
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                }}
              >
                <div style={{ display: "flex" }}>
                  {" "}
                  <div
                    style={{
                      padding: "2px 8px",
                      borderRadius: "12px",
                      fontSize: "12px",
                      background: "#3ae57f",
                    }}
                  >
                    Recommended{" "}
                  </div>
                </div>
                <SurfaceCard
                  padding="base"
                  soft
                  style={{
                    border: "1px solid #cbd5e1",
                    borderTop: "4px solid #7c3aed",
                    height: "100%",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      height: "100%",
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <s-stack direction="block" gap="tight">
                        {/* HEADER ROW */}

                        <s-unordered-list>
                          <s-list-item>
                            Recommended for high order volumes
                          </s-list-item>
                          <s-list-item>Under 5 minutes Setup</s-list-item>
                          <s-list-item>In-app Meta setup</s-list-item>
                          <s-list-item>
                            You pay your own Meta charges
                          </s-list-item>
                          <s-list-item>Flat monthly service fee</s-list-item>
                        </s-unordered-list>
                      </s-stack>
                    </div>

                    <div
                      style={{
                        marginTop: 12,
                        display: "flex",
                        gap: "12px",
                        flexWrap: "wrap",
                      }}
                    >
                      <s-button
                        href={appHref(`/app?senderMode=${SENDER_MODE_OWN}`)}
                        variant="primary"
                      >
                        Connect Your Whatsapp
                      </s-button>
                    </div>
                  </div>
                </SurfaceCard>
              </div>
            </s-section>
            <s-section heading="2) OrderX Number">
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  height: "85%",
                }}
              >
                <div />
                <SurfaceCard
                  padding="base"
                  style={{
                    border: "1px solid #cbd5e1",
                    borderTop: "4px solid #0e7490",
                    height: "100%",
                  }}
                >
                  {/* CARD LAYOUT: content + footer */}
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      height: "100%",
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <s-stack direction="block" gap="tight">
                        {/* <s-heading>OrderX Number</s-heading> */}

                        <s-unordered-list>
                          <s-list-item>
                            Recommended for low to mid-range order volumes.
                          </s-list-item>
                          <s-list-item>Fastest start: plug & play.</s-list-item>

                          <s-list-item>No Meta setup required.</s-list-item>
                          <s-list-item>No extra meta payments.</s-list-item>

                          <s-list-item>Multiple plan options.</s-list-item>
                        </s-unordered-list>
                      </s-stack>
                    </div>

                    <div style={{ marginTop: 12 }}>
                      <s-button
                        href={appHref(
                          `/app?senderMode=${SENDER_MODE_ORDERX}`,
                        )}
                        variant="secondary"
                      >
                        Continue with OrderX Number
                      </s-button>
                    </div>
                  </div>
                </SurfaceCard>
              </div>
            </s-section>
            {/* RIGHT CARD */}
          </div>
        </s-box>
      </s-page>
    );
  }

  return (
    <s-page suppressHydrationWarning>
      <s-box style={surface.shell}>
        {/* <HeroBanner
          title={
            selectedSenderMode === SENDER_MODE_OWN
              ? "Your own number setup"
              : trialUsed
                ? "Choose your active plan"
                : "Start your 3-day free trial"
          }
          subtitle={
            selectedSenderMode === SENDER_MODE_OWN
              ? "Big-store setup: use your own WhatsApp number and pay Meta directly. OrderX charges a flat monthly fee and keeps the same dashboard and automation experience."
              : trialUsed
                ? "Trial has already been used. Pick a paid package to re-enable WhatsApp confirmations."
                : "Trial starts instantly and includes 10 free WhatsApp messages before paid billing starts."
          }
          chips={[
            selectedSenderMode === SENDER_MODE_OWN
              ? "Your number + your Meta billing"
              : "Official Meta WhatsApp API",
            "Shopify billing integrated",
            selectedSenderMode === SENDER_MODE_OWN
              ? "Recommended for big stores"
              : "Zero setup delay",
            selectedSenderMode === SENDER_MODE_OWN
              ? "Flat OrderX fee"
              : "No Whatsapp Bans",
            selectedSenderMode === SENDER_MODE_OWN
              ? "Switch later from Plans page"
              : "No linking required",
          ]}
        /> */}

        {/* <s-section heading="Setup type">
          <SurfaceCard padding="base" soft>
            <s-stack direction="inline" gap="base" wrap>
              <s-button
                href={appHref(`/app?senderMode=${SENDER_MODE_ORDERX}`)}
                variant={
                  selectedSenderMode === SENDER_MODE_ORDERX
                    ? "primary"
                    : "secondary"
                }
              >
                OrderX Number
              </s-button>
              <s-button
                href={appHref(`/app?senderMode=${SENDER_MODE_OWN}`)}
                variant={
                  selectedSenderMode === SENDER_MODE_OWN
                    ? "primary"
                    : "secondary"
                }
              >
                Your Own Number
              </s-button>
            </s-stack>
          </SurfaceCard>
        </s-section> */}
        <s-button href={appHref(`/app`)} variant={"secondary"}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <BackButtonIcon />
            <span>Back</span>
          </span>
        </s-button>
        <div style={{ height: "20px" }} />

        {selectedSenderMode === SENDER_MODE_OWN ? (
          <>
            <s-section heading="Follow these steps to get your app up and running">
              <SurfaceCard padding="none">
                <ByonOnboardingFlow
                  sender={sender}
                  senderMetaConfig={senderMetaConfig}
                  merchantTimezone={merchantTimezone}
                  showSubscriptionStepHint
                  showByonRequiredBanner
                  planStepContent={byonPlanStepContent}
                  planStepComplete={byonPlanSelected}
                  planStepLockedMessage="Complete Meta connect and confirm your Meta payment method to unlock plan selection."
                  settingsHref={appHref("/app/settings")}
                  dashboardHref={appHref("/app")}
                />
              </SurfaceCard>
            </s-section>
            <div style={{ height: "20px" }} />
          </>
        ) : null}

        {selectedSenderMode !== SENDER_MODE_OWN ? (
          <div
            style={{ display: "flex", flexDirection: "column", gap: "12px" }}
          >
            {" "}
            {pricingError ? (
              <s-banner tone="critical">
                <s-stack direction="block" gap="tight">
                  <s-heading>{pricingErrorTitle}</s-heading>
                  <s-paragraph>{pricingError}</s-paragraph>
                </s-stack>
              </s-banner>
            ) : null}
            {!growthPricingAvailable ? (
              <s-banner tone="warning">
                {growthPlanBlockedReason} You can still activate OrderX Free
                or switch to Your Own Number.
              </s-banner>
            ) : null}
            {/* <s-section heading="Plans">
             

              <s-paragraph>
                OrderX Number offers <strong> two packages</strong>:
              </s-paragraph>
              
            </s-section> */}
          </div>
        ) : null}
        <div style={{ height: "20px" }} />
        {selectedSenderMode !== SENDER_MODE_OWN ? (
          <div
            style={{
              display: "grid",
              gap: "12px",
              gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            }}
          >
            {visiblePlanEntries.map(([key, plan]) => {
              const isCurrentActivePlan =
                billing?.planKey === key && hasCurrentPlanSelection;
              const isGrowthPlanBlocked =
                key === "orderx_metered_4" && !growthPricingAvailable;
              const isByonFreeTrialUsed =
                key === BYON_FREE_TRIAL_PLAN_KEY &&
                billing?.byonTrialUsed &&
                !isCurrentActivePlan;
              return (
                <s-section
                  heading={plan.name}
                  key={key}
                  padding="base"
                  style={{
                    minWidth: 250,
                    flex: "1 1 250px",
                    border: "1px solid #cbd5e1",
                    borderTop: "4px solid #0e7490",
                  }}
                >
                  <s-stack direction="block" gap="tight">
                    <s-stack direction="inline" gap="base" wrap>
                      {/* <s-heading>{plan.name}</s-heading> */}
                      {isCurrentActivePlan ? (
                        <s-badge tone="success">Current</s-badge>
                      ) : null}
                    </s-stack>
                    {describePlanPrice(plan, {
                      showPkrInfo: shouldShowPkrInfo(merchantTimezone),
                      regionalPricing,
                    }) ? (
                      <s-text tone="subdued">
                        <strong>
                          {isGrowthPlanBlocked
                            ? "Not available in your store country yet"
                            : describePlanPrice(plan, {
                                showPkrInfo:
                                  shouldShowPkrInfo(merchantTimezone),
                                regionalPricing,
                              })}
                        </strong>
                      </s-text>
                    ) : null}
                    {describePlanDetail(plan, { regionalPricing }) ? (
                      <s-text tone="subdued">
                        {isGrowthPlanBlocked
                          ? growthPlanBlockedReason
                          : describePlanDetail(plan, { regionalPricing })}
                      </s-text>
                    ) : null}
                    <Form method="post">
                      <input type="hidden" name="planKey" value={key} />
                      <s-button
                        type="submit"
                        variant="primary"
                        disabled={
                          isCurrentActivePlan ||
                          isGrowthPlanBlocked ||
                          isByonFreeTrialUsed
                        }
                        {...(submittingPlanKey === key
                          ? { loading: true }
                          : {})}
                      >
                        {isCurrentActivePlan
                          ? "Active"
                          : isGrowthPlanBlocked
                            ? "Not available yet"
                            : isByonFreeTrialUsed
                              ? "Trial used"
                              : key === ORDERX_FREE_PLAN_KEY
                                ? "Activate free plan"
                                : key === BYON_FREE_TRIAL_PLAN_KEY
                                  ? "Start free trial"
                                  : "Continue to billing"}
                      </s-button>
                    </Form>
                  </s-stack>
                </s-section>
              );
            })}
          </div>
        ) : null}
        <div style={{ height: "20px" }} />

        <s-section heading="Notes">
          <SurfaceCard padding="base">
            <s-stack direction="block" gap="tight">
              <s-text>
                OrderX uses the official WhatsApp Business API and follows
                policy-safe messaging for order flows.{" "}
                <s-strong>No Whatsapp Bans.</s-strong>
              </s-text>
              <s-text tone="subdued">
                <strong>About pricing:</strong>{" "}
                {selectedSenderMode === SENDER_MODE_OWN
                  ? `With Your Own Number, you pay Meta message charges directly. OrderX shows an estimate using the ${regionalPricing.storeCountryCode || "store"} baseline, but recipient-country rates apply.`
                  : `OrderX Free includes 10 template messages total. OrderX Growth charges a ${formatMoney(Number(plans?.orderx_metered_4?.price || 2.99), "USD")} monthly base fee plus ${describePlanPrice(
                      plans.orderx_metered_4 || {},
                      {
                        regionalPricing,
                      },
                    ).replace(
                      `${formatMoney(Number(plans?.orderx_metered_4?.price || 2.99), "USD")} / month + `,
                      "",
                    )}.`}
              </s-text>
              <s-paragraph>
                We want to make sure you have a perfect companion for your
                store, We will be adding more and more features and we also take
                recommendations.
              </s-paragraph>
            </s-stack>
          </SurfaceCard>
        </s-section>
        <div style={{ height: "20px" }} />
      </s-box>
    </s-page>
  );
}
