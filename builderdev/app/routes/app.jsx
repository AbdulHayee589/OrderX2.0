// app.jsx
import { useEffect, useRef, useState } from "react";
import {
  Outlet,
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigate,
  useNavigation,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { backendPost } from "../server/backend.server";
import { prepareShopifyOfflineSession } from "../server/shopifyOfflineSession.server";
import { withShopParams } from "../utils/embedded";
import { formatMoney } from "../utils/billingPresentation";

const toObject = (v) => (v && typeof v === "object" ? v : {});

export const loader = async ({ request }) => {
  const { session, redirect } = await authenticate.admin(request);

  const shop = session.shop;
  const url = new URL(request.url);
  const hostParam = url.searchParams.get("host");
  const host = hostParam || session.host || "";

  // Keep embedded params stable
  if (!hostParam && host) {
    const next = new URL(url);
    next.searchParams.set("shop", shop);
    next.searchParams.set("host", host);
    next.searchParams.set("embedded", "1");
    return redirect(`${next.pathname}?${next.searchParams.toString()}`);
  }

  // Never block the first embedded render, but always start the canonical
  // offline-session sync. This makes a fresh install/reinstall available to
  // workers even if the merchant leaves before the dashboard resource loads.
  void prepareShopifyOfflineSession({ shop, fallbackSession: session, host }).catch(
    () => null,
  );

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    billing: null,
    usage: null,
    sender: null,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "").trim();

  if (intent === "byon_retry_now") {
    try {
      const resp = await backendPost(
        "/api/sender/byon/retry-now",
        session.shop,
        {},
      );
      return {
        ok: true,
        intent,
        sender: resp?.sender || null,
        retryNow: resp?.retryNow || null,
      };
    } catch (e) {
      return {
        ok: false,
        intent,
        error: e?.message || "Failed to resume WhatsApp sending",
        errorData: e?.data || e?.errorData || null,
      };
    }
  }

  return { ok: false, intent, error: "Unsupported action" };
};

function SupportWhatsAppFloatingButton() {
  const phoneE164 = "+923176070546";
  const waNumber = "923176070546";
  const href = `https://wa.me/${waNumber}?text=${encodeURIComponent(
    "Hi! I need help with OrderX.",
  )}`;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Chat with support on WhatsApp (${phoneE164})`}
      title={`Chat with support on WhatsApp (${phoneE164})`}
      style={{
        position: "fixed",
        right: 16,
        bottom: 60,
        width: 56,
        height: 56,
        borderRadius: 28,
        background: "#FFF",
        color: "#000",
        display: "flex",
        alignItems: "center",
        textAlign: "center",
        fontSize: "10px",
        justifyContent: "center",
        textDecoration: "none",
        fontWeight: 800,
        letterSpacing: "0.5px",
        boxShadow: "0 10px 28px rgba(0,0,0,0.25)",
        zIndex: 10000,
      }}
    >
      Whatsapp Support
    </a>
  );
}

function GlobalSendingPausedBanner({ sender, appHref }) {
  const fetcher = useFetcher();
  const [dismissed, setDismissed] = useState(false);
  const ownNumber = toObject(sender?.ownNumber);
  const sendHealth = toObject(ownNumber?.sendHealth);
  const ownStatus = String(ownNumber?.status || "").trim();
  const reconnectRequired = ownStatus === "reauth_required";
  const paused =
    sendHealth?.paused === true ||
    ownNumber?.progress?.sendingPaused === true ||
    reconnectRequired;
  const pauseReason = String(
    sendHealth?.pauseReason ||
      ownNumber?.pauseReason ||
      "OrderX paused sending after repeated WhatsApp errors to protect your sender.",
  ).trim();
  const lastError = String(sendHealth?.lastError || "").trim();
  const isSubmitting =
    fetcher.state !== "idle" &&
    String(fetcher.formData?.get("intent") || "") === "byon_retry_now";
  const resumeSucceeded =
    fetcher.data?.intent === "byon_retry_now" && fetcher.data?.ok === true;

  useEffect(() => {
    if (!paused) setDismissed(false);
  }, [paused]);

  if (!paused || dismissed || resumeSucceeded) return null;

  const title = reconnectRequired
    ? "WhatsApp number disconnected"
    : "WhatsApp sending is paused";
  const body = reconnectRequired
    ? "Your WhatsApp number appears to be disconnected or the Meta connection has expired. Please reconnect your WhatsApp number."
    : "Your WhatsApp sending is paused due to recent sending issues. Fix the issue in Meta or WhatsApp first, then resume sending from here.";

  return (
    <div
      role="alert"
      style={{
        margin: "12px",
        border: "1px solid #c93b2b",
        borderRadius: 14,
        background: "#ffffff",
        boxShadow: "0 2px 6px rgba(0,0,0,0.16)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "8px",
          background: "#d9301f",
          color: "#ffffff",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 16,
            height: 16,
            border: "2px solid currentColor",
            borderRadius: 6,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            transform: "rotate(45deg)",
            flex: "0 0 auto",
            fontWeight: 900,
            lineHeight: 1,
          }}
        >
          <span style={{ transform: "rotate(-45deg)" }}>!</span>
        </span>
        <div
          style={{
            fontSize: 14,
            fontWeight: 800,
            lineHeight: 1.2,
            flex: 1,
            fontFamily: "system-ui,-apple-system,Segoe UI,Roboto,Arial",
          }}
        >
          {title}
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss sending paused warning"
          style={{
            appearance: "none",
            border: 0,
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
            fontSize: 32,
            lineHeight: 1,
            padding: 0,
          }}
        >
          ×
        </button>
      </div>
      <div style={{ padding: "12px 20px" }}>
        <p
          style={{
            margin: "0 0 16px",
            color: "#303030",
            fontFamily: "system-ui,-apple-system,Segoe UI,Roboto,Arial",
            fontSize: 16,
          }}
        >
          {body}
        </p>
        <p
          style={{
            margin: "0 0 18px",
            color: "#616161",
            fontSize: 14,
            lineHeight: 1.45,
          }}
        >
          Reason: {pauseReason}
          {lastError && lastError !== pauseReason
            ? ` Last error: ${lastError}`
            : ""}
        </p>
        {fetcher.data?.intent === "byon_retry_now" && fetcher.data?.error ? (
          <p
            style={{
              margin: "0 0 14px",
              color: "#b42318",
              fontSize: 14,
              fontWeight: 700,
              fontFamily: "system-ui,-apple-system,Segoe UI,Roboto,Arial",
            }}
          >
            {fetcher.data.error}
          </p>
        ) : null}
        {reconnectRequired ? (
          <a
            href={appHref("/app/settings")}
            style={{
              display: "inline-block",
              border: "1px solid #c9c9c9",
              borderRadius: 10,
              background: "#ffffff",
              color: "#303030",
              cursor: "pointer",
              fontSize: 16,
              fontWeight: 800,
              padding: "10px 16px",
              textDecoration: "none",
              fontFamily: "system-ui,-apple-system,Segoe UI,Roboto,Arial",
              boxShadow: "0 1px 0 rgba(0,0,0,0.12)",
            }}
          >
            Reconnect WhatsApp
          </a>
        ) : (
          <fetcher.Form method="post" action={appHref("/app")}>
            <input type="hidden" name="intent" value="byon_retry_now" />
            <button
              type="submit"
              variant={"primary"}
              disabled={isSubmitting}
              style={{
                appearance: "none",
                fontFamily: "system-ui,-apple-system,Segoe UI,Roboto,Arial",
                border: "1px solid #c9c9c9",
                borderRadius: 10,
                background: "#ffffff",
                color: "#303030",
                cursor: isSubmitting ? "wait" : "pointer",
                fontSize: 12,
                fontWeight: 800,
                padding: "8px",
                boxShadow: "0 1px 0 rgba(0,0,0,0.12)",
              }}
            >
              {isSubmitting ? "Resuming sending..." : "I have fixed the issue"}
            </button>
          </fetcher.Form>
        )}
      </div>
    </div>
  );
}

function GlobalPlanBanner({ billing, usage, sender, appHref }) {
  const billingType = String(billing?.plan?.billingType || "").trim();
  const planSenderMode = String(billing?.plan?.senderMode || "").trim();
  const isByonPlan =
    planSenderMode === "own_number" ||
    billing?.plan?.quotaManagedByMeta === true;
  const hasBillingHistory =
    !!billing?.trialUsed ||
    !!billing?.trialStartedAt ||
    !!billing?.trialEndsAt ||
    !!billing?.byonTrialUsed ||
    !!billing?.subscriptionId ||
    !!billing?.currentPeriodStart ||
    !!billing?.currentPeriodEnd;

  if (!billing?.active && hasBillingHistory) {
    return (
      <s-banner tone="critical">
        <s-stack direction="block" gap="tight">
          <s-heading>OrderX is paused</s-heading>
          <s-paragraph>
            Your trial or billing is not active. WhatsApp messages will continue
            once you start/renew a plan.
          </s-paragraph>
          <s-button href={appHref("/app/plans")}>Choose a plan</s-button>
        </s-stack>
      </s-banner>
    );
  }

  if (!billing?.active) return null;

  const isTrial = billing?.status === "TRIAL";
  const usageSummary = usage?.usage || {};
  if (isByonPlan && isTrial) {
    const byonUsage = usageSummary?.byonUsage || {};
    const cap = Number(
      byonUsage?.outboundMessageCap ??
        byonUsage?.templateMessageCap ??
        billing?.plan?.outboundMessageCap ??
        billing?.trialMessageCap ??
        200,
    );
    const used = Number(
      byonUsage?.messagesSent ??
        usageSummary?.trialMessagesUsed ??
        billing?.trialMessagesUsed ??
        0,
    );
    const remaining = Math.max(0, cap - used);

    if (remaining <= 0) {
      return (
        <s-banner tone="warning">
          <s-stack direction="block" gap="tight">
            <s-heading>Your Own Number trial limit reached</s-heading>
            <s-paragraph>
              You’ve used <strong>{used}</strong> of <strong>{cap}</strong> free
              trial outbound messages. Choose Starter, Scale, or Unlimited to
              keep sending through your own number.
            </s-paragraph>
            <s-button href={appHref("/app/plans")}>Choose paid plan</s-button>
          </s-stack>
        </s-banner>
      );
    }
    return null;
  }

  if (billingType === "free_cap" && !isByonPlan) {
    const cap = Number(
      usageSummary?.freePlanUsage?.limit ??
        usageSummary?.freeConfirmationCap ??
        billing?.freeConfirmationCap ??
        10,
    );
    const used = Number(
      usageSummary?.freePlanUsage?.used ??
        usageSummary?.freeConfirmationMessagesUsed ??
        billing?.freeConfirmationMessagesUsed ??
        0,
    );
    const remaining = Math.max(0, cap - used);
    if (remaining <= 0) {
      return (
        <s-banner tone="warning">
          <s-stack direction="block" gap="tight">
            <s-heading>Free plan limit reached</s-heading>
            <s-paragraph>
              You’ve used <strong>{used}</strong> of <strong>{cap}</strong>{" "}
              template messages. Upgrade to keep sending new customer messages
              through OrderX.
            </s-paragraph>
            <s-button href={appHref("/app/plans")}>Upgrade plan</s-button>
          </s-stack>
        </s-banner>
      );
    }
    return null;
  }

  if (isTrial) {
    const cap = Number(
      usage?.usage?.trialMessageCap ?? billing?.trialMessageCap ?? 10,
    );
    const used = Number(
      usage?.usage?.trialMessagesUsed ?? billing?.trialMessagesUsed ?? 0,
    );
    const remaining = Math.max(0, cap - used);

    if (remaining <= 0) {
      return (
        <s-banner tone="warning">
          <s-stack direction="block" gap="tight">
            <s-heading>Trial message cap reached</s-heading>
            <s-paragraph>
              You’ve used <strong>{used}</strong> of <strong>{cap}</strong>{" "}
              trial WhatsApp messages. Upgrade to resume sending.
            </s-paragraph>
            <s-button href={appHref("/app/plans")}>Upgrade plan</s-button>
          </s-stack>
        </s-banner>
      );
    }
    return null;
  }

  if (billingType === "shopify_metered") {
    const growthUsage = usageSummary?.growthUsage || {};
    const remainingMessages = Number(growthUsage?.remainingMessages ?? 0);
    const messagesSent = Number(growthUsage?.messagesSent ?? 0);
    const blocked = growthUsage?.blocked === true;
    const nearCap = growthUsage?.nearCap === true;
    const storeCountryCode = String(
      growthUsage?.storeCountryCode ||
        billing?.storeCountryCode ||
        billing?.regionalPricing?.storeCountryCode ||
        "",
    ).trim();
    return (
      <s-banner tone={blocked || nearCap ? "warning" : "success"}>
        <s-stack direction="block" gap="tight">
          <s-heading>OrderX Growth is active</s-heading>
          <s-paragraph>
            This billing cycle: <strong>{messagesSent}</strong> outbound
            messages sent. Approx. remaining before cap:{" "}
            <strong>{remainingMessages}</strong>
            {storeCountryCode ? ` (${storeCountryCode} baseline)` : ""}.
          </s-paragraph>
          <s-button href={appHref("/app/plans")} variant="secondary">
            {blocked || nearCap ? "Increase usage cap" : "Manage plans"}
          </s-button>
        </s-stack>
      </s-banner>
    );
  }

  const ownProgress = toObject(sender?.ownNumber?.progress);
  const ownStatus = String(sender?.ownNumber?.status || "").trim();
  const activeSenderMode = String(
    billing?.plan?.senderMode || sender?.currentBillingSenderMode || "",
  ).trim();
  const byonUsage = usageSummary?.byonUsage || {};
  const byonTemplateCap = Number(
    byonUsage?.outboundMessageCap ??
      billing?.plan?.outboundMessageCap ??
      byonUsage?.templateMessageCap ??
      billing?.plan?.templateMessageCap ??
      0,
  );
  const byonRemainingMessages =
    byonTemplateCap > 0
      ? Math.max(0, Number(byonUsage?.remainingMessages ?? byonTemplateCap))
      : null;

  if (
    billing?.active &&
    activeSenderMode === "own_number" &&
    ownProgress?.metaConnected &&
    ownProgress?.paymentMethodAdded &&
    ownProgress?.templatesPendingApproval
  ) {
    return (
      <s-banner tone="warning">
        <s-stack direction="block" gap="tight">
          <s-heading>Meta templates are pending approval</s-heading>
          <s-paragraph>
            OrderX has already connected your own WhatsApp number, but Meta is
            still reviewing the required English template pack. Approval often
            lands within a few hours and can sometimes take up to 48 hours.
            Automation will start automatically as soon as the templates are
            approved, and you can keep adjusting your settings and flows in the
            meantime.
          </s-paragraph>
          <s-stack direction="inline" gap="base" wrap>
            <s-button href={appHref("/app/settings")}>Settings</s-button>
            <s-button href={appHref("/app/plans")} variant="secondary">
              View BYON status
            </s-button>
          </s-stack>
        </s-stack>
      </s-banner>
    );
  }

  if (
    billing?.active &&
    activeSenderMode === "own_number" &&
    ownStatus === "reauth_required" &&
    sender?.ownNumber?.sendHealth?.paused !== true
  ) {
    return (
      <s-banner tone="critical">
        <s-stack direction="block" gap="tight">
          <s-heading>Reconnect your Meta sender</s-heading>
          <s-paragraph>
            OrderX needs a fresh Meta connection before it can keep sending on
            your own number.
          </s-paragraph>
          <s-button href={appHref("/app/settings")}>
            Reconnect in settings
          </s-button>
        </s-stack>
      </s-banner>
    );
  }

  if (
    billing?.active &&
    activeSenderMode === "own_number" &&
    byonTemplateCap > 0 &&
    byonUsage?.blocked === true
  ) {
    return (
      <s-banner tone="warning">
        <s-stack direction="block" gap="tight">
          <s-heading>BYON overage billing is blocked</s-heading>
          <s-paragraph>
            OrderX can’t bill more outbound messages on the current BYON
            subscription right now. Refresh billing or switch packages before
            sending more messages this cycle.
          </s-paragraph>
          <s-button href={appHref("/app/plans")}>Open plans</s-button>
        </s-stack>
      </s-banner>
    );
  }

  if (
    billing?.active &&
    activeSenderMode === "own_number" &&
    byonTemplateCap > 0 &&
    byonUsage?.nearCap === true
  ) {
    return (
      <s-banner tone="warning">
        <s-stack direction="block" gap="tight">
          <s-heading>
            BYON package is close to its included message limit
          </s-heading>
          <s-paragraph>
            Only <strong>{byonRemainingMessages}</strong> included outbound
            messages remain on the current BYON package this billing cycle.
            After that, OrderX bills{" "}
            <strong>
              {formatMoney(
                Number(billing?.plan?.usagePrice?.amount || 0.01),
                "USD",
              )}
            </strong>{" "}
            per extra outbound message.
          </s-paragraph>
          <s-button href={appHref("/app/plans")} variant="secondary">
            View plans
          </s-button>
        </s-stack>
      </s-banner>
    );
  }

  const used = Number(usageSummary?.month ?? usageSummary?.waMessagesSent ?? 0);
  const limit =
    Number(
      usageSummary?.limitMonthly ||
        usageSummary?.limit ||
        billing?.plan?.monthlyMessages ||
        (Number(billing?.plan?.dailyMessages || 0) > 0
          ? Number(billing?.plan?.dailyMessages || 0) * 30
          : 0),
    ) || 0;

  if (!limit) return null;

  const remaining = Math.max(0, limit - used);
  const pct = Math.round((used / limit) * 100);

  if (remaining <= 0) {
    return (
      <s-banner tone="warning">
        <s-stack direction="block" gap="tight">
          <s-heading>Billing cycle message limit reached</s-heading>
          <s-paragraph>
            You’ve used <strong>{used}</strong> of <strong>{limit}</strong>{" "}
            WhatsApp messages in the current billing cycle. OrderX will stop
            sending until the next cycle or you upgrade.
          </s-paragraph>
          <s-button href={appHref("/app/plans")} variant="secondary">
            Upgrade plan
          </s-button>
        </s-stack>
      </s-banner>
    );
  }

  if (pct >= 90) {
    return (
      <s-banner tone="warning">
        <s-stack direction="block" gap="tight">
          <s-heading>You’re close to your billing cycle limit</s-heading>
          <s-paragraph>
            Used <strong>{used}</strong> / <strong>{limit}</strong> in the
            current cycle. Remaining: <strong>{remaining}</strong>.
          </s-paragraph>
          <s-button href={appHref("/app/plans")} variant="secondary">
            Upgrade plan
          </s-button>
        </s-stack>
      </s-banner>
    );
  }

  return null;
}

export default function App() {
  const initialData = useLoaderData();
  const location = useLocation();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const shellFetcher = useFetcher();
  const shellRequested = useRef(false);
  const refreshShellAfterAction = useRef(false);
  const appHref = (href) => withShopParams(href, location.search);
  const shellData = toObject(shellFetcher.data);
  const apiKey = initialData.apiKey;
  const billing = toObject(shellData.billing || initialData.billing);
  const usage = shellData.usage || initialData.usage || null;
  const sender = toObject(shellData.sender || initialData.sender);
  const showAgentAccounts =
    String(billing?.plan?.senderMode || "").trim() === "own_number";

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const shop = String(params.get("shop") || "").trim();
    const host = String(params.get("host") || "").trim();
    if (!shop || !host) return;

    try {
      // Shopify can navigate the app title back to `/` without query params.
      // Keep this tab's verified embedded context so the entry route can
      // return to the dashboard instead of exposing the fallback login page.
      window.sessionStorage.setItem(
        "orderx:embedded-search",
        params.toString(),
      );
    } catch {
      // Storage can be unavailable in privacy-restricted browsers. Normal
      // query-param navigation continues to work without this fallback.
    }
  }, [location.search]);

  useEffect(() => {
    if (shellRequested.current) return;
    shellRequested.current = true;
    shellFetcher.load(withShopParams("/app/shell-data", location.search));
  }, [location.search, shellFetcher]);

  useEffect(() => {
    if (navigation.state !== "idle") {
      if (navigation.formData || navigation.formMethod) {
        refreshShellAfterAction.current = true;
      }
      return;
    }
    if (!refreshShellAfterAction.current) return;
    refreshShellAfterAction.current = false;
    shellFetcher.load(withShopParams("/app/shell-data", location.search));
  }, [
    location.search,
    navigation.formData,
    navigation.formMethod,
    navigation.state,
    shellFetcher,
  ]);

  useEffect(() => {
    function findShopifyHref(event) {
      const path =
        typeof event.composedPath === "function" ? event.composedPath() : [];

      for (const node of path) {
        if (!node || typeof node !== "object") continue;

        const tag = node.tagName ? String(node.tagName).toLowerCase() : "";
        if (tag !== "s-link" && tag !== "s-button") continue;

        if (typeof node.getAttribute !== "function") continue;

        const href = node.getAttribute("href");
        if (!href) continue;

        const target = node.getAttribute("target") || "";
        if (String(target).toLowerCase() === "_blank") return null;

        return href;
      }
      return null;
    }

    function intercept(event) {
      if (event.defaultPrevented) return;

      // Only left-click interactions
      if ("button" in event && event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;

      const href = findShopifyHref(event);
      if (!href || !href.startsWith("/app")) return;

      // 🔥 Strongest stop: prevents web component internal navigation
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }

      navigate(withShopParams(href, location.search));
    }

    document.addEventListener("click", intercept, true);

    return () => {
      document.removeEventListener("click", intercept, true);
    };
  }, [navigate, location.search]);

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href={appHref("/app")}>Dashboard</s-link>
        <s-link href={appHref("/app/attempts")}>Order Confirmations</s-link>
        <s-link href={appHref("/app/messages")}>Messages</s-link>
        {showAgentAccounts ? (
          <s-link href={appHref("/app/agents")}>Agent Accounts</s-link>
        ) : null}
        <s-link href={appHref("/app/templates")}>Flows</s-link>
        <s-link href={appHref("/app/compaigns")}>Compaigns</s-link>
        <s-link href={appHref("/app/plans")}>Plans</s-link>
        <s-link href={appHref("/app/settings")}>Settings</s-link>
      </s-app-nav>

      <div style={{ padding: 12 }}>
        <GlobalSendingPausedBanner sender={sender} appHref={appHref} />
        <GlobalPlanBanner
          billing={billing}
          usage={usage}
          sender={sender}
          appHref={appHref}
        />
      </div>

      <Outlet />
      <SupportWhatsAppFloatingButton />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
