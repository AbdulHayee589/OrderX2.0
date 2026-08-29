// app.settings.jsx
import { useEffect, useState } from "react";
import {
  useActionData,
  useLoaderData,
  useLocation,
  useNavigation,
  useSubmit,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { backendGet, backendPost } from "../server/backend.server";
import { handleByonRouteAction } from "../server/byonActions.server";
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
import { shouldShowPkrInfo } from "../utils/billingPresentation";
import { getMerchantTimezone } from "../utils/shopTimezone.server";
import { resolvePublicAppOrigin } from "../utils/publicOrigin";

const toObject = (v) => (v && typeof v === "object" ? v : {});
const toArray = (v) => (Array.isArray(v) ? v : []);
const SENDER_MODE_ORDERX = "orderx_number";
const SENDER_MODE_OWN = "own_number";
const ORDERX_FREE_PLAN_KEY = "orderx_free_5";
const BYON_FREE_TRIAL_PLAN_KEY = "own_number_free_trial_200";
const BILLING_TYPE_FREE_CAP = "free_cap";
const BILLING_TYPE_SHOPIFY_METERED = "shopify_metered";
const FLOW_ORDER_CONFIRMATION = "order_confirmation";
const FLOW_ORDER_CHANGE_REQUEST = "order_change_request";
const FLOW_ORDER_DISPATCHED = "order_dispatched";
const FLOW_TRACKING_UPDATED = "tracking_updated";
const FLOW_ORDER_CANCELLED = "order_cancelled";
const FLOW_REVIEW_REQUEST = "review_request";
const FLOW_ABANDONED_CART = "abandoned_cart_recovery";
const DEFAULT_CONFIRM_REPLY_TEXT =
  "*Order Confirmed*\n{{order_number_label}} from {{store_name}} has been confirmed.";
const DEFAULT_CANCEL_REPLY_TEXT =
  "*Order Cancelled*\nThank you for your response,\n{{order_number_label}} has been cancelled.";
const AUTOMATION_FLOW_DEFAULTS = [
  { flowKey: FLOW_ORDER_CONFIRMATION, enabled: true, config: {} },
  { flowKey: FLOW_ORDER_CHANGE_REQUEST, enabled: true, config: {} },
  { flowKey: FLOW_ORDER_DISPATCHED, enabled: true, config: {} },
  { flowKey: FLOW_TRACKING_UPDATED, enabled: true, config: {} },
  { flowKey: FLOW_ORDER_CANCELLED, enabled: true, config: {} },
  { flowKey: FLOW_REVIEW_REQUEST, enabled: false, config: {} },
  { flowKey: FLOW_ABANDONED_CART, enabled: false, config: {} },
];

function inferSenderModeFromPlanKey(planKey) {
  return String(planKey || "").startsWith("own_number_")
    ? SENDER_MODE_OWN
    : SENDER_MODE_ORDERX;
}

function senderModeLabel(mode) {
  return mode === SENDER_MODE_OWN ? "Your Own Number" : "OrderX Number";
}

function resolveAppOrigin(reqUrl) {
  return (
    resolvePublicAppOrigin(
      reqUrl?.toString?.() || reqUrl?.origin || "",
      process.env.SHOPIFY_APP_URL || process.env.APP_URL || "",
    ) || reqUrl.origin
  );
}

function collectBillingSubscriptions(target, checkResult, isTest) {
  const subs = Array.isArray(checkResult?.appSubscriptions)
    ? checkResult.appSubscriptions
    : [];
  for (const sub of subs) {
    const id = String(sub?.id || "").trim();
    if (!id || target.has(id)) continue;
    target.set(id, { ...sub, isTest });
  }
}

function normalizeSupportWhatsAppNumber(v) {
  const raw = String(v || "").trim();
  if (!raw) return "";

  // Keep only digits and a single leading "+" (E.164-ish cleanup).
  const cleaned = raw.replace(/[^\d+]/g, "");
  const digits = cleaned.startsWith("+")
    ? cleaned.slice(1).replace(/[^\d]/g, "")
    : cleaned.replace(/[^\d]/g, "");

  return digits ? `+${digits}` : "";
}

function isValidE164(v) {
  return /^\+[1-9]\d{7,14}$/.test(String(v || "").trim());
}

function normalizeAutomationFlows(flows) {
  const source = Array.isArray(flows) ? flows : [];
  return AUTOMATION_FLOW_DEFAULTS.map((row) => {
    const existing = source.find((item) => item?.flowKey === row.flowKey);
    return {
      ...row,
      ...(existing && typeof existing === "object" ? existing : {}),
      config:
        existing?.config && typeof existing.config === "object"
          ? existing.config
          : row.config,
    };
  });
}

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const merchantTimezone = await getMerchantTimezone(admin);

  const settings = toObject(
    await backendGet("/api/settings", shop).catch(() => ({})),
  );
  const billing = toObject(
    await backendGet("/api/billing/status", shop).catch(() => ({
      active: false,
      plans: {},
    })),
  );
  const sender = toObject(
    await backendGet(
      "/api/sender?refreshTemplates=1&forceTemplateRefresh=1",
      shop,
    ).catch(() => ({
      ok: false,
      sender: null,
    })),
  );
  const senderMetaConfig = toObject(
    await backendGet("/api/sender/byon/meta-config", shop).catch(() => ({
      ok: false,
      config: null,
    })),
  );

  let usage = null;
  if (billing?.active) {
    usage = toObject(await backendGet("/api/usage", shop).catch(() => null));
  }

  const blocklistRaw = toObject(
    await backendGet("/api/blocklist", shop).catch(() => ({ items: [] })),
  );
  const blocklist = toArray(blocklistRaw.items);

  const historyRaw = toObject(
    await backendGet("/api/billing/history", shop).catch(() => ({ items: [] })),
  );
  const billingHistory = toArray(historyRaw.items);

  const auditRaw = toObject(
    await backendGet("/api/audit?limit=80", shop).catch(() => ({ items: [] })),
  );
  const audit = toArray(auditRaw.items);

  return {
    settings,
    billing,
    usage,
    blocklist,
    billingHistory,
    audit,
    sender: toObject(sender?.sender),
    senderMetaConfig: toObject(senderMetaConfig?.config),
    serverNow: Date.now(),
    merchantTimezone,
  };
};

export const action = async ({ request }) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = session.shop;

  const form = await request.formData();
  const intent = String(form.get("intent") || "save");

  if (intent === "sync_billing") {
    try {
      await backendPost("/api/billing/sync?force=1", shop, {});
      const billingStatus = await backendGet("/api/billing/status", shop).catch(
        () => null,
      );
      return { ok: true, intent, billing: billingStatus };
    } catch (e) {
      return {
        ok: false,
        intent,
        error: e?.message || "Failed to refresh billing status",
        errorData: e?.data || e?.errorData || null,
      };
    }
  }

  if (intent === "sender_select_mode") {
    const mode = String(form.get("mode") || "").trim();
    try {
      const resp = await backendPost("/api/sender/select-mode", shop, { mode });
      return { ok: true, intent, sender: resp?.sender || null };
    } catch (e) {
      return {
        ok: false,
        intent,
        error: e?.message || "Failed to update messaging setup",
        errorData: e?.data || e?.errorData || null,
      };
    }
  }

  const byonActionResult = await handleByonRouteAction({
    intent,
    form,
    shop,
    requestUrl: request.url,
  });
  if (byonActionResult) return byonActionResult;

  if (intent === "block_add") {
    const phone = String(form.get("phone") || "").trim();
    const note = String(form.get("note") || "").trim();
    if (!phone) return { ok: false, intent, error: "Missing phone" };

    try {
      await backendPost("/api/blocklist", shop, { phone, note });
      return { ok: true, intent };
    } catch (e) {
      return { ok: false, intent, error: e?.message || "Failed to add" };
    }
  }

  if (intent === "block_remove") {
    const id = String(form.get("id") || "").trim();
    if (!id) return { ok: false, intent, error: "Missing id" };

    try {
      await backendPost("/api/blocklist/remove", shop, { id });
      return { ok: true, intent };
    } catch (e) {
      return { ok: false, intent, error: e?.message || "Failed to remove" };
    }
  }

  if (intent === "upgrade") {
    const planKey = String(form.get("planKey") || "");
    if (!planKey) return { ok: false, intent, error: "Missing planKey" };

    const current = toObject(
      await backendGet("/api/billing/status", shop).catch(() => ({})),
    );

    const isTest = false;
    const targetSenderMode = inferSenderModeFromPlanKey(planKey);
    const currentSenderMode = inferSenderModeFromPlanKey(current?.planKey);
    const switchingSenderMode =
      currentSenderMode !== targetSenderMode &&
      (current?.active ||
        current?.status === "TRIAL" ||
        current?.subscriptionId);
    const confirmSetupSwitch =
      String(form.get("confirmSetupSwitch") || "") === "1";

    if (switchingSenderMode && !confirmSetupSwitch) {
      return {
        ok: false,
        intent,
        needsSetupSwitchConfirm: true,
        currentSenderMode,
        targetSenderMode,
        targetPlanKey: planKey,
        error: `Switching from ${senderModeLabel(currentSenderMode)} to ${senderModeLabel(targetSenderMode)} will replace the current OrderX subscription in Shopify Billing. Confirm to continue.`,
      };
    }

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
            intent: "activate_free_plan",
            error: start?.error || "Failed to activate free plan",
            errorData: start || null,
          };
        }
        const billingStatus = await backendGet(
          "/api/billing/status",
          shop,
        ).catch(() => null);
        return {
          ok: true,
          intent:
            planKey === BYON_FREE_TRIAL_PLAN_KEY
              ? "activate_byon_free_trial"
              : "activate_free_plan",
          billing: billingStatus,
        };
      } catch (e) {
        return {
          ok: false,
          intent:
            planKey === BYON_FREE_TRIAL_PLAN_KEY
              ? "activate_byon_free_trial"
              : "activate_free_plan",
          error: e?.message || "Failed to activate free plan",
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
          intent,
          error: `Backend check failed: ${e?.message || "Failed"}`,
          errorData: e?.data || e?.errorData || null,
        };
      }

      // This call throws a redirect Response to Shopify billing confirmation.
      try {
        await billing.request({
          plan: planKey,
          isTest,
          returnUrl: returnUrl.toString(),
        });
      } catch (e) {
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
          intent,
          error: `Shopify billing failed: ${e?.message || "Failed"}`,
          errorData: e?.data || e?.errorData || null,
        };
      }
    } catch (e) {
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
        intent,
        error: e?.message || "Billing failed",
        errorData: e?.data || e?.errorData || null,
      };
    }
  }

  if (intent === "cancel_subscription") {
    try {
      const currentStatus = toObject(
        await backendGet("/api/billing/status", shop).catch(() => ({})),
      );
      const currentBillingType = String(
        currentStatus?.plan?.billingType || "",
      ).trim();

      if (
        currentBillingType === "free_cap" &&
        currentStatus?.active &&
        !currentStatus?.subscriptionId
      ) {
        const resp = await backendPost(
          "/api/billing/deactivate-free",
          shop,
          {},
        );
        const billingStatus = toObject(resp?.billing);
        return {
          ok: true,
          intent,
          cancelledFreePlan: true,
          billing:
            Object.keys(billingStatus).length > 0
              ? billingStatus
              : await backendGet("/api/billing/status", shop).catch(() => null),
        };
      }

      const subscriptionsById = new Map();
      const liveCheck = await billing
        .check({ isTest: false })
        .catch(() => null);
      collectBillingSubscriptions(subscriptionsById, liveCheck, false);

      // Shopify review / development-style shops can only approve test charges.
      // We keep real subscriptions preferred, then cancel test subscriptions only
      // when Shopify actually reports them for this app installation.
      const testCheck = await billing.check({ isTest: true }).catch(() => null);
      collectBillingSubscriptions(subscriptionsById, testCheck, true);

      const subs = Array.from(subscriptionsById.values());

      if (!subs.length) {
        const stopped = await backendPost("/api/billing/hard-stop", shop, {});
        const initialBilling = toObject(stopped?.billing);
        const billingStatus =
          Object.keys(initialBilling).length > 0
            ? initialBilling
            : await backendGet("/api/billing/status", shop).catch(() => null);
        return { ok: true, intent, billing: billingStatus };
      }

      // Cancel all active subscriptions for this app (normally there should be only one).
      for (const sub of subs) {
        if (sub?.id) {
          await billing.cancel({
            subscriptionId: sub.id,
            isTest: sub.isTest === true,
            // Do not request a refund credit from Shopify. We stop app access
            // immediately in a follow-up hard-stop step below.
            prorate: false,
          });
        }
      }

      // Stop locally right away so the UI and message gating match the
      // immediate-cancel experience we want in production.
      const stopped = await backendPost("/api/billing/hard-stop", shop, {});
      let billingStatus = toObject(stopped?.billing);
      if (Object.keys(billingStatus).length === 0) {
        billingStatus = await backendGet("/api/billing/status", shop).catch(
          () => null,
        );
      }
      return { ok: true, intent, billing: billingStatus };
    } catch (e) {
      if (e instanceof Response) throw e;

      return {
        ok: false,
        intent,
        error: e?.message || "Failed to cancel subscription",
        errorData: e?.data || e?.errorData || null,
      };
    }
  }

  if (intent === "hard_stop_subscription") {
    try {
      const resp = await backendPost("/api/billing/hard-stop", shop, {});
      const initialBilling = toObject(resp?.billing);
      const billingStatus =
        Object.keys(initialBilling).length > 0
          ? initialBilling
          : await backendGet("/api/billing/status", shop).catch(() => null);
      return {
        ok: true,
        intent,
        hardStopped: true,
        billing: billingStatus,
      };
    } catch (e) {
      return {
        ok: false,
        intent,
        error: e?.message || "Failed to stop subscription immediately",
        errorData: e?.data || e?.errorData || null,
      };
    }
  }

  if (intent === "increase_usage_cap") {
    const cappedAmount = Number(form.get("cappedAmount") || 0);
    if (!Number.isFinite(cappedAmount) || cappedAmount <= 0) {
      return { ok: false, intent, error: "Missing usage cap amount" };
    }

    try {
      const resp = await backendPost("/api/billing/usage-cap", shop, {
        cappedAmount,
      });
      const confirmationUrl = String(resp?.confirmationUrl || "").trim();
      if (confirmationUrl) {
        return { ok: true, intent, confirmationUrl };
      }

      const billingStatus = await backendGet("/api/billing/status", shop).catch(
        () => null,
      );
      return { ok: true, intent, billing: billingStatus };
    } catch (e) {
      if (e instanceof Response) throw e;
      return {
        ok: false,
        intent,
        error: e?.message || "Failed to increase usage cap",
        errorData: e?.data || e?.errorData || null,
      };
    }
  }

  // Save settings intent
  const payload = {
    confirmationDelayMin: Number(form.get("confirmationDelayMin") || 60),
    orderPollingScope: String(form.get("orderPollingScope") || "all_orders"),
    orderUpdatesScope: String(form.get("orderUpdatesScope") || "all_orders"),
    workStartHour: Number(form.get("workStartHour") || 9),
    workEndHour: Number(form.get("workEndHour") || 21),
    enableWhatsApp: form.get("enableWhatsApp") === "true",
    orderConfirmationEnabled: form.get("orderConfirmationEnabled") === "true",
    orderChangeRequestEnabled: form.get("orderChangeRequestEnabled") === "true",
    supportWhatsAppNumber: String(
      form.get("supportWhatsAppNumber") || "",
    ).trim(),
    confirmReplyText: String(form.get("confirmReplyText") || ""),
    cancelReplyText: String(form.get("cancelReplyText") || ""),
    autoCancelUnconfirmed: form.get("autoCancelUnconfirmed") === "true",
    autoTagOrders: form.get("autoTagOrders") === "true",
    applyRequestedChangesToOrder:
      form.get("applyRequestedChangesToOrder") === "true",
    enableOrderUpdates: form.get("enableOrderUpdates") === "true",
    orderUpdatesDispatched: form.get("orderUpdatesDispatched") === "true",
    orderUpdatesTrackingUpdated:
      form.get("orderUpdatesTrackingUpdated") === "true",
    orderUpdatesCancelled: form.get("orderUpdatesCancelled") === "true",
    reviewRequestEnabled: form.get("reviewRequestEnabled") === "true",
    abandonedCartEnabled: form.get("abandonedCartEnabled") === "true",
    reviewRequestUrl: String(form.get("reviewRequestUrl") || "").trim(),
    reviewRequestDelayHours: Number(form.get("reviewRequestDelayHours") || 96),
    reviewRequestLinkMode: String(
      form.get("reviewRequestLinkMode") || "store",
    ).trim(),
    abandonedCartDelayMinutes: Number(
      form.get("abandonedCartDelayMinutes") || 90,
    ),
    automationFlows: String(form.get("automationFlows") || "[]"),

    // Rules (free features)
    skipOrderTags: String(form.get("skipOrderTags") || "").trim(),
    includeCountries: String(form.get("includeCountries") || "").trim(),
    excludeCountries: String(form.get("excludeCountries") || "").trim(),
    maxAttemptAgeHours: Number(form.get("maxAttemptAgeHours") || 72),
    byonMaxInitiatedConversations24h: Number(
      form.get("byonMaxInitiatedConversations24h") || 250,
    ),
  };

  try {
    const settings = await backendPost("/api/settings", shop, payload);
    return { ok: true, intent, settings };
  } catch (e) {
    return {
      ok: false,
      intent,
      error: e?.message || "Failed to save settings",
    };
  }
};

function SettingSwitchRow({
  title,
  description,
  checked,
  onChange,
  disabled = false,
}) {
  const [isHovering, setIsHovering] = useState(false);

  const handleToggle = () => {
    if (disabled) return;

    const nextChecked = !checked;

    onChange?.({
      target: { checked: nextChecked },
      currentTarget: { checked: nextChecked },
    });
  };

  return (
    <button
      type="button"
      onClick={handleToggle}
      disabled={disabled}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
      style={{
        width: "100%",
        border: checked ? "1px solid #bbf7d0" : "1px solid #e5e7eb",
        borderRadius: 18,
        padding: "16px 18px",
        background: checked
          ? "linear-gradient(180deg, #ffffff 0%, #f0fdf4 100%)"
          : "#ffffff",
        boxShadow:
          isHovering && !disabled
            ? "0 0 24px rgba(15, 23, 42, 0.10)"
            : "0 0 16px rgba(15, 23, 42, 0.06)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.65 : 1,
        textAlign: "left",
        transition: "all 0.18s ease",
        transform:
          isHovering && !disabled ? "translateY(-1px)" : "translateY(0)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 18,
        }}
      >
        <div
          style={{
            minWidth: 0,
            flex: "1 1 auto",
            display: "grid",
            gap: 6,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <div
              style={{
                fontSize: 14,
                fontWeight: 850,
                color: "#101828",
                lineHeight: 1.25,
              }}
            >
              {title}
            </div>

            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "3px 9px",
                borderRadius: 999,
                fontSize: 11,
                fontWeight: 800,
                lineHeight: 1,
                background: checked ? "#dcfce7" : "#f3f4f6",
                color: checked ? "#166534" : "#667085",
                border: checked ? "1px solid #bbf7d0" : "1px solid #e5e7eb",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: checked ? "#16a34a" : "#98a2b3",
                }}
              />
              {checked ? "Enabled" : "Disabled"}
            </span>
          </div>

          {description ? (
            <div
              style={{
                fontSize: 13,
                color: "#667085",
                lineHeight: 1.5,
                maxWidth: 680,
              }}
            >
              {description}
            </div>
          ) : null}
        </div>

        <div
          role="switch"
          aria-label={title}
          aria-checked={checked}
          style={{
            width: 46,
            height: 26,
            borderRadius: 999,
            padding: 3,
            flexShrink: 0,
            background: checked ? "#16a34a" : "#e5e7eb",
            border: checked ? "1px solid #15803d" : "1px solid #d0d5dd",
            boxShadow: checked
              ? "inset 0 1px 2px rgba(0,0,0,0.16)"
              : "inset 0 1px 2px rgba(0,0,0,0.10)",
            transition: "all 0.18s ease",
            boxSizing: "border-box",
          }}
        >
          <div
            style={{
              width: 18,
              height: 18,
              borderRadius: "50%",
              background: "#ffffff",
              transform: checked ? "translateX(20px)" : "translateX(0)",
              transition: "all 0.18s ease",
              boxShadow: "0 2px 5px rgba(15, 23, 42, 0.25)",
            }}
          />
        </div>
      </div>
    </button>
  );
}

function ReplyTextareaField({
  label,
  value,
  onChange,
  details,
  placeholder = "",
}) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <label
        style={{
          fontSize: 14,
          fontWeight: 700,
          color: "#101828",
        }}
      >
        {label}
      </label>
      <textarea
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        rows={4}
        style={{
          width: "100%",
          borderRadius: 14,
          border: "1px solid #d0d5dd",
          padding: "14px 16px",
          fontSize: 14,
          lineHeight: 1.55,
          color: "#0f172a",
          background: "#ffffff",
          resize: "vertical",
          minHeight: 112,
          boxSizing: "border-box",
          fontFamily:
            '"SF Pro Text", "Segoe UI", ui-sans-serif, system-ui, sans-serif',
        }}
      />
      {details ? (
        <div
          style={{
            fontSize: 12,
            color: "#667085",
            lineHeight: 1.5,
          }}
        >
          {details}
        </div>
      ) : null}
    </div>
  );
}

export default function SettingsPage() {
  const shopify = useAppBridge();
  const {
    settings,
    billing,
    usage,
    blocklist,
    audit,
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
  const billingSenderMode =
    String(billing?.plan?.senderMode || "").trim() ||
    inferSenderModeFromPlanKey(billing?.planKey);
  const marketingAutomationAllowed = billingSenderMode === SENDER_MODE_OWN;

  const [state, setState] = useState({
    confirmationDelayMin: settings.confirmationDelayMin ?? 60,
    orderPollingScope: settings.orderPollingScope ?? "all_orders",
    orderUpdatesScope: settings.orderUpdatesScope ?? "all_orders",
    enableWhatsApp: settings.enableWhatsApp ?? true,
    workStartHour: settings.workStartHour ?? 9,
    workEndHour: settings.workEndHour ?? 21,
    supportWhatsAppNumber: settings.supportWhatsAppNumber ?? "",
    confirmReplyText:
      String(settings.confirmReplyText || "").trim() ||
      DEFAULT_CONFIRM_REPLY_TEXT,
    cancelReplyText:
      String(settings.cancelReplyText || "").trim() ||
      DEFAULT_CANCEL_REPLY_TEXT,
    autoCancelUnconfirmed: !!settings.autoCancelUnconfirmed,
    autoTagOrders: settings.autoTagOrders ?? true,
    applyRequestedChangesToOrder: !!settings.applyRequestedChangesToOrder,
    enableOrderUpdates: !!settings.enableOrderUpdates,
    orderUpdatesDispatched: settings.orderUpdatesDispatched ?? true,
    orderUpdatesTrackingUpdated: settings.orderUpdatesTrackingUpdated ?? true,
    orderUpdatesCancelled: settings.orderUpdatesCancelled ?? true,
    reviewRequestEnabled: normalizeAutomationFlows(
      settings.automationFlows,
    ).find((flow) => flow.flowKey === FLOW_REVIEW_REQUEST)?.enabled,
    abandonedCartEnabled: normalizeAutomationFlows(
      settings.automationFlows,
    ).find((flow) => flow.flowKey === FLOW_ABANDONED_CART)?.enabled,
    reviewRequestUrl: settings.reviewRequestUrl ?? "",
    reviewRequestDelayHours:
      normalizeAutomationFlows(settings.automationFlows).find(
        (flow) => flow.flowKey === FLOW_REVIEW_REQUEST,
      )?.config?.delayHours ??
      settings.reviewRequestDelayHours ??
      96,
    reviewRequestLinkMode:
      normalizeAutomationFlows(settings.automationFlows).find(
        (flow) => flow.flowKey === FLOW_REVIEW_REQUEST,
      )?.config?.linkMode ??
      settings.reviewRequestLinkMode ??
      "store",
    abandonedCartDelayMinutes:
      normalizeAutomationFlows(settings.automationFlows).find(
        (flow) => flow.flowKey === FLOW_ABANDONED_CART,
      )?.config?.delayMinutes ??
      settings.abandonedCartDelayMinutes ??
      90,
    automationFlows: normalizeAutomationFlows(settings.automationFlows),

    skipOrderTags: Array.isArray(settings.skipOrderTags)
      ? settings.skipOrderTags.join(", ")
      : "",
    includeCountries: Array.isArray(settings.includeCountries)
      ? settings.includeCountries.join(", ")
      : "",
    excludeCountries: Array.isArray(settings.excludeCountries)
      ? settings.excludeCountries.join(", ")
      : "",
    maxAttemptAgeHours: settings.maxAttemptAgeHours ?? 72,
    byonMaxInitiatedConversations24h:
      settings.byonMaxInitiatedConversations24h ?? 250,
  });

  const [blockForm, setBlockForm] = useState({ phone: "", note: "" });
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const submittingIntent =
    navigation.state === "submitting"
      ? navigation.formData?.get("intent")
      : null;

  const getFlow = (flowKey) =>
    toArray(state.automationFlows).find((flow) => flow?.flowKey === flowKey) ||
    null;
  const isFlowEnabled = (flowKey, fallback = false) => {
    const flow = getFlow(flowKey);
    return typeof flow?.enabled === "boolean" ? flow.enabled : fallback;
  };
  const setFlowEnabled = (flowKey, enabled) => {
    setState((current) => {
      const flows = normalizeAutomationFlows(current.automationFlows);
      return {
        ...current,
        automationFlows: flows.map((flow) =>
          flow.flowKey === flowKey ? { ...flow, enabled } : flow,
        ),
      };
    });
  };

  useEffect(() => {
    if (actionData?.ok) {
      if (actionData?.intent === "save" && actionData?.settings) {
        const saved = toObject(actionData.settings);
        setState((current) => {
          const savedFlows = normalizeAutomationFlows(
            saved.automationFlows ?? current.automationFlows,
          );
          return {
            ...current,
            confirmationDelayMin:
              saved.confirmationDelayMin ?? current.confirmationDelayMin,
            orderPollingScope:
              saved.orderPollingScope ?? current.orderPollingScope,
            orderUpdatesScope:
              saved.orderUpdatesScope ?? current.orderUpdatesScope,
            enableWhatsApp: saved.enableWhatsApp ?? current.enableWhatsApp,
            workStartHour: saved.workStartHour ?? current.workStartHour,
            workEndHour: saved.workEndHour ?? current.workEndHour,
            supportWhatsAppNumber:
              saved.supportWhatsAppNumber ?? current.supportWhatsAppNumber,
            confirmReplyText:
              String(saved.confirmReplyText || "").trim() ||
              DEFAULT_CONFIRM_REPLY_TEXT,
            cancelReplyText:
              String(saved.cancelReplyText || "").trim() ||
              DEFAULT_CANCEL_REPLY_TEXT,
            autoCancelUnconfirmed:
              saved.autoCancelUnconfirmed ?? current.autoCancelUnconfirmed,
            autoTagOrders: saved.autoTagOrders ?? current.autoTagOrders,
            applyRequestedChangesToOrder:
              saved.applyRequestedChangesToOrder ??
              current.applyRequestedChangesToOrder,
            enableOrderUpdates:
              saved.enableOrderUpdates ?? current.enableOrderUpdates,
            orderUpdatesDispatched:
              saved.orderUpdatesDispatched ?? current.orderUpdatesDispatched,
            orderUpdatesTrackingUpdated:
              saved.orderUpdatesTrackingUpdated ??
              current.orderUpdatesTrackingUpdated,
            orderUpdatesCancelled:
              saved.orderUpdatesCancelled ?? current.orderUpdatesCancelled,
            reviewRequestUrl:
              saved.reviewRequestUrl ?? current.reviewRequestUrl,
            reviewRequestDelayHours:
              saved.reviewRequestDelayHours ?? current.reviewRequestDelayHours,
            reviewRequestLinkMode:
              saved.reviewRequestLinkMode ?? current.reviewRequestLinkMode,
            abandonedCartDelayMinutes:
              saved.abandonedCartDelayMinutes ??
              current.abandonedCartDelayMinutes,
            skipOrderTags: Array.isArray(saved.skipOrderTags)
              ? saved.skipOrderTags.join(", ")
              : current.skipOrderTags,
            includeCountries: Array.isArray(saved.includeCountries)
              ? saved.includeCountries.join(", ")
              : current.includeCountries,
            excludeCountries: Array.isArray(saved.excludeCountries)
              ? saved.excludeCountries.join(", ")
              : current.excludeCountries,
            maxAttemptAgeHours:
              saved.maxAttemptAgeHours ?? current.maxAttemptAgeHours,
            byonMaxInitiatedConversations24h:
              saved.byonMaxInitiatedConversations24h ??
              current.byonMaxInitiatedConversations24h,
            automationFlows: savedFlows,
            reviewRequestEnabled: savedFlows.find(
              (flow) => flow.flowKey === FLOW_REVIEW_REQUEST,
            )?.enabled,
            abandonedCartEnabled: savedFlows.find(
              (flow) => flow.flowKey === FLOW_ABANDONED_CART,
            )?.enabled,
          };
        });
      }
      if (actionData?.intent === "block_add") {
        shopify.toast.show("Added to blocklist");
        setBlockForm({ phone: "", note: "" });
      } else if (actionData?.intent === "block_remove") {
        shopify.toast.show("Removed from blocklist");
      } else if (actionData?.intent === "cancel_subscription") {
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
          window.open(confirmationUrl, "_blank", "noopener");
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
      } else if (actionData?.intent === "save") {
        shopify.toast.show("Settings saved");
      } else if (actionData?.intent === "byon_confirm_payment_method") {
        shopify.toast.show("Meta payment step marked as complete");
      } else if (actionData?.intent === "byon_templates_provision") {
        shopify.toast.show(
          actionData?.note || "Template pack request submitted",
        );
      } else if (actionData?.intent === "byon_templates_sync") {
        shopify.toast.show("Template statuses refreshed");
      } else if (
        ["byon_meta_connect_begin", "byon_meta_connect_prepare"].includes(
          actionData?.intent,
        )
      ) {
        shopify.toast.show("Opening Meta connect");
      } else if (actionData?.intent === "byon_meta_connect_finalize") {
        shopify.toast.show("Meta connection saved");
      } else if (actionData?.intent === "byon_webhook_simulate") {
        shopify.toast.show("Webhook simulation sent to backend");
      }
    } else if (actionData?.intent === "save" && actionData?.error) {
      shopify.toast.show(actionData.error);
    } else if (
      actionData?.intent === "cancel_subscription" &&
      actionData?.error
    ) {
      shopify.toast.show(actionData.error);
    } else if (
      [
        "start_trial",
        "activate_free_plan",
        "activate_byon_free_trial",
        "increase_usage_cap",
      ].includes(actionData?.intent) &&
      actionData?.error
    ) {
      shopify.toast.show(actionData.error);
    } else if (
      [
        "byon_confirm_payment_method",
        "byon_templates_provision",
        "byon_templates_sync",
        "byon_meta_connect_begin",
        "byon_meta_connect_prepare",
        "byon_meta_connect_finalize",
        "byon_webhook_simulate",
      ].includes(actionData?.intent) &&
      actionData?.error
    ) {
      shopify.toast.show(actionData.error);
    } else if (actionData?.intent === "sync_billing" && actionData?.error) {
      shopify.toast.show(actionData.error);
    }
  }, [actionData, shopify]);

  useEffect(() => {
    const params = new URLSearchParams(location.search || "");
    const billingResult = params.get("billing");
    if (billingResult === "success") {
      shopify.toast.show("Plan updated");
    } else if (billingResult === "failed") {
      shopify.toast.show("Payment not completed");
    }
  }, [location.search, shopify]);

  const used = Number(usage?.usage?.month ?? usage?.usage?.waMessagesSent ?? 0);
  const usageSummary = toObject(usage?.usage);
  const freePlanUsage = toObject(usageSummary.freePlanUsage);
  const growthUsage = toObject(usageSummary.growthUsage);
  const byonUsage = toObject(usageSummary.byonUsage);
  const limit =
    Number(
      usage?.usage?.limitMonthly ||
        usage?.usage?.limit ||
        billing?.plan?.monthlyMessages ||
        (Number(billing?.plan?.dailyMessages || 0) > 0
          ? Number(billing?.plan?.dailyMessages || 0) * 30
          : 0),
    ) || 0;
  const billingType = String(billing?.plan?.billingType || "").trim();
  const billingPlanSenderMode = String(billing?.plan?.senderMode || "").trim();
  const isByonPlan =
    billingPlanSenderMode === SENDER_MODE_OWN ||
    billing?.plan?.quotaManagedByMeta === true;
  const isByonFreeTrial = isByonPlan && billingType === BILLING_TYPE_FREE_CAP;
  const isOrderXFreePlan =
    !isByonPlan && billingType === BILLING_TYPE_FREE_CAP;
  const byonTemplateCap = Number(
    byonUsage.outboundMessageCap ??
      billing?.plan?.outboundMessageCap ??
      byonUsage.templateMessageCap ??
      billing?.plan?.templateMessageCap ??
      0,
  );
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

  const trialCap = Number(
    usage?.usage?.trialMessageCap ?? billing?.trialMessageCap ?? 10,
  );
  const trialMsgsUsed = Number(
    usage?.usage?.trialMessagesUsed ?? billing?.trialMessagesUsed ?? 0,
  );

  const trialEndsAt = billing?.trialEndsAt
    ? new Date(billing.trialEndsAt)
    : null;
  const trialActive = billing?.status === "TRIAL";
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

  const onSave = () => {
    const normalizedSupport = normalizeSupportWhatsAppNumber(
      state.supportWhatsAppNumber,
    );
    if (
      isFlowEnabled(FLOW_ORDER_CONFIRMATION, state.enableWhatsApp) &&
      !isValidE164(normalizedSupport)
    ) {
      shopify.toast.show(
        "Support WhatsApp number is required (E.164, e.g. +15551234567)",
      );
      return;
    }

    const reviewEnabled =
      isFlowEnabled(FLOW_REVIEW_REQUEST, !!state.reviewRequestEnabled) &&
      marketingAutomationAllowed;
    const abandonedEnabled =
      isFlowEnabled(FLOW_ABANDONED_CART, !!state.abandonedCartEnabled) &&
      marketingAutomationAllowed;
    const automationFlows = state.automationFlows.map((flow) => {
      if (flow.flowKey === FLOW_REVIEW_REQUEST) {
        return {
          ...flow,
          enabled: reviewEnabled,
          config: {
            ...(flow?.config && typeof flow.config === "object"
              ? flow.config
              : {}),
            reviewUrl: String(state.reviewRequestUrl || "").trim(),
            delayHours: Math.max(
              0,
              Math.min(
                24 * 30,
                Number.isFinite(Number(state.reviewRequestDelayHours))
                  ? Number(state.reviewRequestDelayHours)
                  : 96,
              ),
            ),
            linkMode:
              String(state.reviewRequestLinkMode || "store")
                .trim()
                .toLowerCase() === "product"
                ? "product"
                : "store",
          },
        };
      }
      if (flow.flowKey === FLOW_ABANDONED_CART) {
        return {
          ...flow,
          enabled: abandonedEnabled,
          config: {
            ...(flow?.config && typeof flow.config === "object"
              ? flow.config
              : {}),
            delayMinutes: Math.max(
              15,
              Math.min(
                7 * 24 * 60,
                Number(state.abandonedCartDelayMinutes || 90) || 90,
              ),
            ),
          },
        };
      }
      return flow;
    });
    const orderConfirmationEnabled = isFlowEnabled(
      FLOW_ORDER_CONFIRMATION,
      state.enableWhatsApp,
    );
    const orderChangeRequestEnabled = isFlowEnabled(
      FLOW_ORDER_CHANGE_REQUEST,
      true,
    );
    const dispatchedEnabled = isFlowEnabled(
      FLOW_ORDER_DISPATCHED,
      state.orderUpdatesDispatched,
    );
    const trackingEnabled = isFlowEnabled(
      FLOW_TRACKING_UPDATED,
      state.orderUpdatesTrackingUpdated,
    );
    const cancelledEnabled = isFlowEnabled(
      FLOW_ORDER_CANCELLED,
      state.orderUpdatesCancelled,
    );
    const enableOrderUpdates =
      dispatchedEnabled || trackingEnabled || cancelledEnabled || reviewEnabled;

    const fd = new FormData();
    fd.set("intent", "save");
    fd.set("confirmationDelayMin", String(state.confirmationDelayMin));
    fd.set(
      "orderPollingScope",
      String(state.orderPollingScope || "all_orders"),
    );
    fd.set(
      "orderUpdatesScope",
      String(state.orderUpdatesScope || "all_orders"),
    );
    fd.set("enableWhatsApp", String(orderConfirmationEnabled));
    fd.set("orderConfirmationEnabled", String(orderConfirmationEnabled));
    fd.set("orderChangeRequestEnabled", String(orderChangeRequestEnabled));
    fd.set("workStartHour", String(state.workStartHour));
    fd.set("workEndHour", String(state.workEndHour));
    fd.set("supportWhatsAppNumber", String(normalizedSupport || ""));
    fd.set("confirmReplyText", String(state.confirmReplyText || ""));
    fd.set("cancelReplyText", String(state.cancelReplyText || ""));
    fd.set("autoCancelUnconfirmed", String(state.autoCancelUnconfirmed));
    fd.set("autoTagOrders", String(state.autoTagOrders));
    fd.set(
      "applyRequestedChangesToOrder",
      String(state.applyRequestedChangesToOrder),
    );
    fd.set("enableOrderUpdates", String(enableOrderUpdates));
    fd.set("orderUpdatesDispatched", String(dispatchedEnabled));
    fd.set("orderUpdatesTrackingUpdated", String(trackingEnabled));
    fd.set("orderUpdatesCancelled", String(cancelledEnabled));
    fd.set("reviewRequestEnabled", String(reviewEnabled));
    fd.set("abandonedCartEnabled", String(abandonedEnabled));
    fd.set("reviewRequestUrl", String(state.reviewRequestUrl || ""));
    fd.set(
      "reviewRequestDelayHours",
      String(
        Math.max(
          0,
          Math.min(
            24 * 30,
            Number.isFinite(Number(state.reviewRequestDelayHours))
              ? Number(state.reviewRequestDelayHours)
              : 96,
          ),
        ),
      ),
    );
    fd.set(
      "reviewRequestLinkMode",
      String(state.reviewRequestLinkMode || "store")
        .trim()
        .toLowerCase() === "product"
        ? "product"
        : "store",
    );
    fd.set(
      "abandonedCartDelayMinutes",
      String(
        Math.max(
          15,
          Math.min(
            7 * 24 * 60,
            Number(state.abandonedCartDelayMinutes || 90) || 90,
          ),
        ),
      ),
    );
    fd.set("automationFlows", JSON.stringify(automationFlows));
    fd.set("skipOrderTags", String(state.skipOrderTags || ""));
    fd.set("includeCountries", String(state.includeCountries || ""));
    fd.set("excludeCountries", String(state.excludeCountries || ""));
    fd.set("maxAttemptAgeHours", String(state.maxAttemptAgeHours || 72));
    fd.set(
      "byonMaxInitiatedConversations24h",
      String(
        Math.max(1, Number(state.byonMaxInitiatedConversations24h || 250)),
      ),
    );
    submit(fd, { method: "POST" });
  };

  const confirmCancelSubscription = () => {
    setCancelDialogOpen(false);
    const fd = new FormData();
    fd.set("intent", "cancel_subscription");
    submit(fd, { method: "POST" });
  };

  const DELAY_OPTIONS = [
    { label: "Immediately", value: 0 },
    { label: "5 minutes", value: 5 },
    { label: "10 minutes", value: 10 },
    { label: "15 minutes", value: 15 },
    { label: "30 minutes", value: 30 },
    { label: "45 minutes", value: 45 },
    { label: "60 minutes (recommended)", value: 60 },
    { label: "90 minutes", value: 90 },
    { label: "120 minutes", value: 120 },
    { label: "3 hours", value: 180 },
    { label: "4 hours", value: 240 },
    { label: "6 hours", value: 360 },
    { label: "8 hours", value: 480 },
    { label: "12 hours", value: 720 },
    { label: "24 hours", value: 1440 },
  ];

  const normalizedSupport = normalizeSupportWhatsAppNumber(
    state.supportWhatsAppNumber,
  );
  const supportInvalid =
    isFlowEnabled(FLOW_ORDER_CONFIRMATION, state.enableWhatsApp) &&
    !isValidE164(normalizedSupport);
  const senderView = toObject(sender);
  const ownSender = toObject(senderView?.ownNumber);
  const ownSenderProgress = toObject(ownSender?.progress);
  const activeSenderMode = String(
    billing?.plan?.senderMode || senderView?.currentBillingSenderMode || "",
  ).trim();
  const hasOwnNumberSetup =
    activeSenderMode === SENDER_MODE_OWN ||
    (!!String(ownSender?.status || "").trim() &&
      String(ownSender?.status || "").trim() !== "not_started") ||
    !!String(ownSender?.wabaId || "").trim() ||
    !!String(ownSender?.requestedPhoneNumber || "").trim();
  const byonLimitApplies = activeSenderMode === SENDER_MODE_OWN;
  const initiatedConversations24h =
    usage?.usage?.initiatedConversations24h || null;
  return (
    <s-page suppressHydrationWarning>
      <s-button slot="primary-action" onClick={onSave}>
        Save settings
      </s-button>

      <s-box style={surface.shell}>
        <HeroBanner
          title="Configure confirmation flow and rules"
          subtitle="Manage WhatsApp behavior, support routing, and guardrails for reliable COD confirmations."
          chips={[
            `Status: ${statusLabel}`,
            `Plan: ${billing?.plan?.name || billing?.planKey || "None"}`,
            billing?.active
              ? isByonFreeTrial && byonTemplateCap > 0
                ? `BYON trial: ${byonUsage.messagesSent || 0}/${byonTemplateCap}`
                : trialActive
                  ? `Trial usage: ${trialMsgsUsed}/${trialCap}`
                  : isByonPlan && byonTemplateCap > 0
                    ? `BYON usage: ${byonUsage.messagesSent || 0}/${byonTemplateCap}`
                    : `Cycle usage: ${used}/${limit}`
              : "Billing inactive",
          ]}
        />

        <s-section heading="Plans & billing">
          {billing?.hardStoppedAt ? (
            <s-banner tone="critical">
              Subscription was stopped immediately at{" "}
              <strong>
                {formatDateTime(billing.hardStoppedAt, merchantTimezone)}
              </strong>
              . Billing access is blocked until you activate a new plan.
            </s-banner>
          ) : null}
          <SurfaceCard padding="base">
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="base" wrap>
                <MetricTile
                  label="Status"
                  value={statusLabel}
                  hint={billing?.plan?.name || billing?.planKey || "No plan"}
                  soft
                />
                <MetricTile
                  label="Cycle usage"
                  value={
                    !billing?.active
                      ? "—"
                      : isByonPlan && byonTemplateCap > 0
                        ? `${byonUsage.messagesSent || 0}/${byonTemplateCap}`
                        : isOrderXFreePlan
                          ? `${freeConfirmationUsed}/${freeConfirmationCap}`
                          : billingType === BILLING_TYPE_SHOPIFY_METERED
                            ? formatNumber(growthUsage.messagesSent || 0)
                            : activeSenderMode === SENDER_MODE_OWN
                              ? formatNumber(byonUsage.messagesSent || 0)
                              : trialActive
                                ? `${trialMsgsUsed}/${trialCap}`
                                : `${used}/${limit}`
                  }
                  hint={
                    !billing?.active
                      ? "Billing inactive"
                      : isByonFreeTrial
                        ? "BYON free trial outbound messages"
                        : isByonPlan
                          ? "BYON outbound messages this cycle"
                          : isOrderXFreePlan
                            ? "Template messages used"
                            : billingType === BILLING_TYPE_SHOPIFY_METERED
                              ? "Metered outbound messages this cycle"
                              : activeSenderMode === SENDER_MODE_OWN
                                ? "Template messages this cycle"
                                : "Current usage"
                  }
                  soft
                />
              </s-stack>
              <s-stack direction="inline" gap="base" wrap>
                <s-button href={appHref("/app/plans")} variant="secondary">
                  Manage subscription
                </s-button>
              </s-stack>
            </s-stack>
          </SurfaceCard>
        </s-section>
        <ConfirmDialog
          open={cancelDialogOpen}
          title={
            isOrderXFreePlan && billing?.active && !billing?.subscriptionId
              ? "Deactivate OrderX Free?"
              : "Cancel subscription and stop immediately?"
          }
          message={
            isOrderXFreePlan && billing?.active && !billing?.subscriptionId
              ? "This will deactivate OrderX Free and block all OrderX sending right away."
              : "This will cancel the Shopify subscription and stop all OrderX sending immediately."
          }
          details={
            isOrderXFreePlan && billing?.active && !billing?.subscriptionId
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
            isOrderXFreePlan && billing?.active && !billing?.subscriptionId
              ? "Deactivate free plan"
              : "Cancel and stop now"
          }
          cancelLabel="Keep subscription"
          destructive
          loading={submittingIntent === "cancel_subscription"}
          onCancel={() => setCancelDialogOpen(false)}
          onConfirm={confirmCancelSubscription}
        />
        <SectionDivider />
        {hasOwnNumberSetup ? (
          <>
            <s-section heading="Your WhatsApp connection">
              {activeSenderMode === SENDER_MODE_OWN ? null : ( // </s-banner> //   status before asking you to add anything again. //   OrderX will automatically refresh the English template pack //   reconnect to a different number or WhatsApp Business account, //   Manage the connected WhatsApp number from here. If you // <s-banner tone="info">
                <s-banner tone="warning">
                  You are not currently sending through Your Own Number, but
                  OrderX has a saved BYON setup. You can reconnect or refresh
                  it here before switching plans.
                </s-banner>
              )}
              <SurfaceCard padding="base">
                <ByonOnboardingFlow
                  sender={senderView}
                  senderMetaConfig={senderMetaConfig}
                  merchantTimezone={merchantTimezone}
                  intro={
                    activeSenderMode === SENDER_MODE_OWN
                      ? "Reconnect or change the connected WhatsApp, confirm Meta billing, and keep the required template pack healthy from one place."
                      : "Prepare or refresh your own-number setup before switching plans. OrderX will keep your current live setup intact until you choose a BYON package."
                  }
                  showStatusHeader
                  showByonRequiredBanner
                  hidePlanStep
                  settingsHref={appHref("/app/settings")}
                  dashboardHref={appHref("/app")}
                />
              </SurfaceCard>
              {/* <SurfaceCard padding="base">
                <s-stack direction="block" gap="base">
                  <s-stack direction="block" gap="tight">
                    <s-heading>Inbound webhook simulator</s-heading>
                    <s-text tone="subdued">
                      Send a synthetic inbound WhatsApp reply to your backend
                      without changing Meta&apos;s live webhook settings. Use
                      the customer number that should reply, not your sender
                      number.
                    </s-text>
                  </s-stack>
                  <s-stack direction="inline" gap="base" wrap>
                    <s-text-field
                      label="From number (E.164)"
                      value={webhookSimulator.fromE164}
                      onChange={(e) =>
                        setWebhookSimulator({
                          ...webhookSimulator,
                          fromE164: e.currentTarget.value,
                        })
                      }
                      placeholder="+923001112233"
                    />
                    <s-text-field
                      label="Reply text"
                      value={webhookSimulator.text}
                      onChange={(e) =>
                        setWebhookSimulator({
                          ...webhookSimulator,
                          text: e.currentTarget.value,
                        })
                      }
                      placeholder="Yes, Confirmed."
                    />
                    <s-button
                      onClick={() => {
                        const fd = new FormData();
                        fd.set("intent", "byon_webhook_simulate");
                        fd.set(
                          "byonWebhookSimFromE164",
                          webhookSimulator.fromE164,
                        );
                        fd.set("byonWebhookSimText", webhookSimulator.text);
                        submit(fd, { method: "POST" });
                      }}
                    >
                      Send to backend
                    </s-button>
                  </s-stack>
                  <s-paragraph tone="warning">
                    This is only for backend testing. It creates a synthetic
                    webhook payload and runs it through your live webhook
                    handler.
                  </s-paragraph>
                </s-stack>
              </SurfaceCard> */}
              {ownSenderProgress?.templatesPendingApproval ? (
                <div style={{ marginTop: 12 }}>
                  <s-banner tone="warning">
                    Meta is still reviewing the English template pack. Approval
                    often lands within a few hours and can sometimes take up to
                    48 hours. OrderX will start automation automatically as
                    soon as approval is complete.
                  </s-banner>
                </div>
              ) : null}
            </s-section>
            <div style={{ height: "20px" }} />
          </>
        ) : null}
        <s-section heading="Flow settings ">
          <SurfaceCard padding="base">
            <s-stack direction="block" gap="base">
              <SettingSwitchRow
                title="Enable WhatsApp confirmations"
                description="Turns OrderX confirmation messages on or off for new eligible orders."
                checked={isFlowEnabled(
                  FLOW_ORDER_CONFIRMATION,
                  state.enableWhatsApp,
                )}
                onChange={(e) =>
                  setFlowEnabled(FLOW_ORDER_CONFIRMATION, e.target.checked)
                }
              />
              <s-select
                label="Confirmation delay"
                value={String(state.confirmationDelayMin)}
                onChange={(e) =>
                  setState({
                    ...state,
                    confirmationDelayMin: Number(e.target.value),
                  })
                }
              >
                {DELAY_OPTIONS.map((opt) => (
                  <s-option key={opt.value} value={opt.value}>
                    {opt.label}
                  </s-option>
                ))}
              </s-select>

              <s-select
                label="Send order confirmation messages to:"
                value={String(state.orderPollingScope || "all_orders")}
                onChange={(e) =>
                  setState({
                    ...state,
                    orderPollingScope: e.target.value,
                  })
                }
              >
                <s-option value="all_orders">All orders</s-option>
                <s-option value="cod_only">COD orders only</s-option>
              </s-select>

              <s-stack direction="inline" gap="base" wrap>
                <s-select
                  label="Messages start sending at (order timezone)"
                  value={String(state.workStartHour)}
                  onChange={(e) =>
                    setState({
                      ...state,
                      workStartHour: Number(e.target.value),
                    })
                  }
                >
                  {Array.from({ length: 24 }).map((_, h) => (
                    <s-option key={h} value={h}>
                      {String(h).padStart(2, "0")}:00
                    </s-option>
                  ))}
                </s-select>

                <s-select
                  label="Messages stop sending at (order timezone)"
                  value={String(state.workEndHour)}
                  onChange={(e) =>
                    setState({ ...state, workEndHour: Number(e.target.value) })
                  }
                >
                  {Array.from({ length: 24 }).map((_, h) => (
                    <s-option key={h} value={h}>
                      {String(h).padStart(2, "0")}:00
                    </s-option>
                  ))}
                </s-select>
              </s-stack>

              <s-text-field
                label="Support WhatsApp number (required)"
                value={state.supportWhatsAppNumber}
                onChange={(e) =>
                  setState({
                    ...state,
                    supportWhatsAppNumber: e.currentTarget.value,
                  })
                }
                placeholder="+15551234567"
                details="Sent to customers if they message anything other than the Confirm/Cancel quick replies."
              />
              {supportInvalid ? (
                <s-paragraph tone="critical">
                  Please enter a valid E.164 number (example: +15551234567).
                </s-paragraph>
              ) : null}

              <ReplyTextareaField
                label="Reply after customer confirms"
                value={state.confirmReplyText}
                onChange={(e) =>
                  setState({
                    ...state,
                    confirmReplyText: e.currentTarget.value,
                  })
                }
                details="Supported placeholders: {{customer_name}}, {{store_name}}, {{order_number}}, {{order_number_label}}, {{support_whatsapp_number}}"
                placeholder={DEFAULT_CONFIRM_REPLY_TEXT}
              />

              <ReplyTextareaField
                label="Reply after customer cancels"
                value={state.cancelReplyText}
                onChange={(e) =>
                  setState({
                    ...state,
                    cancelReplyText: e.currentTarget.value,
                  })
                }
                details="Supported placeholders: {{customer_name}}, {{store_name}}, {{order_number}}, {{order_number_label}}, {{support_whatsapp_number}}"
                placeholder={DEFAULT_CANCEL_REPLY_TEXT}
              />

              <SettingSwitchRow
                title="Enable Request Changes follow-up"
                description="Keeps the in-chat Request Changes automation active after the customer taps the fixed confirmation button."
                checked={isFlowEnabled(FLOW_ORDER_CHANGE_REQUEST, true)}
                onChange={(e) =>
                  setFlowEnabled(FLOW_ORDER_CHANGE_REQUEST, e.target.checked)
                }
              />

              <SettingSwitchRow
                title="Auto-tag Shopify orders"
                description="Adds OrderX tags in Shopify (sent, confirmed, cancelled, change requests, etc.). Recommended."
                checked={state.autoTagOrders}
                onChange={(e) =>
                  setState({
                    ...state,
                    autoTagOrders: e.target.checked,
                  })
                }
              />

              <SettingSwitchRow
                title="Apply confirmed requested changes to Shopify order"
                description="When enabled, confirmed Request Changes edits (name, address, quantity) are also applied to the Shopify order when supported."
                checked={state.applyRequestedChangesToOrder}
                onChange={(e) =>
                  setState({
                    ...state,
                    applyRequestedChangesToOrder: e.target.checked,
                  })
                }
              />

              <s-select
                label="Send order updates to"
                value={String(state.orderUpdatesScope || "all_orders")}
                details="Choose whether dispatch, tracking, cancelled, and review-request automations should send for all eligible orders or only orders confirmed through OrderX."
                onChange={(e) =>
                  setState({
                    ...state,
                    orderUpdatesScope: e.target.value,
                  })
                }
              >
                <s-option value="all_orders">All eligible orders</s-option>
                <s-option value="confirmed_only">
                  Confirmed orders only
                </s-option>
              </s-select>

              <SettingSwitchRow
                title="Send dispatched update"
                description="Sent when Shopify creates a fulfillment for the order."
                checked={isFlowEnabled(
                  FLOW_ORDER_DISPATCHED,
                  state.orderUpdatesDispatched,
                )}
                onChange={(e) =>
                  setFlowEnabled(FLOW_ORDER_DISPATCHED, e.target.checked)
                }
              />

              <SettingSwitchRow
                title="Send tracking-updated update"
                description="Sent when Shopify fulfillment tracking number, courier, or tracking link is updated."
                checked={isFlowEnabled(
                  FLOW_TRACKING_UPDATED,
                  state.orderUpdatesTrackingUpdated,
                )}
                onChange={(e) =>
                  setFlowEnabled(FLOW_TRACKING_UPDATED, e.target.checked)
                }
              />

              <SettingSwitchRow
                title="Send cancelled update"
                description="Sent when Shopify marks the order as cancelled."
                checked={isFlowEnabled(
                  FLOW_ORDER_CANCELLED,
                  state.orderUpdatesCancelled,
                )}
                onChange={(e) =>
                  setFlowEnabled(FLOW_ORDER_CANCELLED, e.target.checked)
                }
              />

              {marketingAutomationAllowed ? (
                <>
                  <SettingSwitchRow
                    title="Send review request after delivery"
                    description="Uses the assigned Marketing template after Shopify marks the fulfillment as delivered."
                    checked={isFlowEnabled(
                      FLOW_REVIEW_REQUEST,
                      !!state.reviewRequestEnabled,
                    )}
                    onChange={(e) =>
                      setFlowEnabled(FLOW_REVIEW_REQUEST, e.target.checked)
                    }
                  />

                  <s-text-field
                    label={
                      String(state.reviewRequestLinkMode || "store") ===
                      "product"
                        ? "Fallback store review URL"
                        : "Store review URL"
                    }
                    value={state.reviewRequestUrl}
                    placeholder="https://yourstore.com/reviews"
                    details={
                      String(state.reviewRequestLinkMode || "store") ===
                      "product"
                        ? "Used only if OrderX cannot find the first product link from the fulfilled order."
                        : "Inserted into the review-request Marketing template when that automation is enabled."
                    }
                    onChange={(e) =>
                      setState({
                        ...state,
                        reviewRequestUrl: e.currentTarget.value,
                      })
                    }
                  />

                  <s-stack direction="inline" gap="base" wrap>
                    <s-text-field
                      label="Send review request after (hours)"
                      type="number"
                      min="0"
                      max={String(24 * 30)}
                      value={String(state.reviewRequestDelayHours ?? 96)}
                      details="Default is 96 hours after fulfillment. OrderX checks eligible fulfilled orders every 30 minutes."
                      onChange={(e) =>
                        setState({
                          ...state,
                          reviewRequestDelayHours: e.currentTarget.value,
                        })
                      }
                    />

                    <s-select
                      label="Review link type"
                      value={String(state.reviewRequestLinkMode || "store")}
                      onChange={(e) =>
                        setState({
                          ...state,
                          reviewRequestLinkMode: e.target.value,
                        })
                      }
                    >
                      <s-option value="store">One store review link</s-option>
                      <s-option value="product">
                        First product link from order
                      </s-option>
                    </s-select>
                  </s-stack>

                  <SettingSwitchRow
                    title="Send abandoned cart recovery"
                    description="Uses the assigned Marketing template for checkouts that stay incomplete past your chosen delay."
                    checked={isFlowEnabled(
                      FLOW_ABANDONED_CART,
                      !!state.abandonedCartEnabled,
                    )}
                    onChange={(e) =>
                      setFlowEnabled(FLOW_ABANDONED_CART, e.target.checked)
                    }
                  />

                  <s-text-field
                    label="Abandoned cart delay (minutes)"
                    value={String(state.abandonedCartDelayMinutes ?? 90)}
                    details="OrderX polls Shopify abandoned checkouts and sends the assigned Marketing template after this delay."
                    onChange={(e) =>
                      setState({
                        ...state,
                        abandonedCartDelayMinutes: e.currentTarget.value,
                      })
                    }
                  />

                  <SurfaceCard soft padding="base">
                    <s-paragraph>
                      Leave Review and Abandoned Cart Recovery are Marketing
                      template flows. Make sure the assigned Marketing template
                      is approved from the Templates page before turning either
                      one on.
                    </s-paragraph>
                  </SurfaceCard>
                </>
              ) : (
                <SurfaceCard soft padding="base">
                  <s-paragraph>
                    Leave Review and Abandoned Cart Recovery are available only
                    on <strong>Your Own Number</strong> plans. OrderX Number
                    plans do not support custom Marketing-template automations.
                  </s-paragraph>
                </SurfaceCard>
              )}
              {/* <SurfaceCard soft padding="base">
                <s-paragraph>
                  Messages run only between{" "}
                  <strong>
                    {String(state.workStartHour).padStart(2, "0")}:00 –{" "}
                    {String(state.workEndHour).padStart(2, "0")}:00
                  </strong>{" "}
                  in the order timezone.
                </s-paragraph>
              </SurfaceCard> */}
            </s-stack>
          </SurfaceCard>
        </s-section>
        <div style={{ height: "20px" }} />
        <s-section heading="BYON initiated conversations (24h)">
          <SurfaceCard padding="base">
            <s-stack direction="block" gap="tight">
              <s-text-field
                type="number"
                label="Max unique initiated conversations in 24 hours"
                details="Used only on Your Own Number plan. Default: 250."
                value={String(state.byonMaxInitiatedConversations24h)}
                onChange={(e) =>
                  setState({
                    ...state,
                    byonMaxInitiatedConversations24h: Number(
                      e.currentTarget.value,
                    ),
                  })
                }
                min={1}
              />
              <s-paragraph tone="warning">
                Set this limit according to your Meta daily allowed limits.
              </s-paragraph>
              <s-text tone="subdued">
                {byonLimitApplies
                  ? "This limit is active for your current sender mode."
                  : "This limit is saved now and becomes active when you switch to Your Own Number."}
              </s-text>
              {byonLimitApplies && initiatedConversations24h ? (
                <s-text tone="subdued">
                  Current 24h initiated conversations:{" "}
                  <strong>
                    {formatNumber(initiatedConversations24h.count24h || 0)}
                  </strong>{" "}
                  /{" "}
                  <strong>
                    {formatNumber(initiatedConversations24h.limit24h || 0)}
                  </strong>
                </s-text>
              ) : null}
            </s-stack>
          </SurfaceCard>
        </s-section>

        {/* <div style={{ height: "20px" }} /> */}
        {/* <s-section heading="Smart order updates ">
          <SurfaceCard padding="base">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Choose which Shopify-driven follow-up automations stay active.
                Each automation still uses the approved template assigned from
                the Templates page.
              </s-paragraph>
            </s-stack>
          </SurfaceCard>
        </s-section> */}
        <div style={{ height: "20px" }} />
        <s-section heading="Advanced rules">
          <SurfaceCard padding="base">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                These rules help prevent unwanted messages and reduce spam.
              </s-paragraph>

              <s-text-field
                label="Skip orders with tags (comma-separated)"
                details="Example: cod_skip, do_not_message"
                value={state.skipOrderTags}
                onChange={(e) =>
                  setState({ ...state, skipOrderTags: e.currentTarget.value })
                }
              />

              <s-text-field
                label="Only send to countries (ISO2, comma-separated)"
                details="Leave empty to allow all. Example: US, CA"
                value={state.includeCountries}
                onChange={(e) =>
                  setState({
                    ...state,
                    includeCountries: e.currentTarget.value,
                  })
                }
              />

              <s-text-field
                label="Never send to countries (ISO2, comma-separated)"
                details="Example: PK, IN"
                value={state.excludeCountries}
                onChange={(e) =>
                  setState({
                    ...state,
                    excludeCountries: e.currentTarget.value,
                  })
                }
              />

              <s-text-field
                type="number"
                label="Stop sending after (hours)"
                details="After this many hours without a customer response, the attempt is marked expired (default 72)."
                value={String(state.maxAttemptAgeHours)}
                onChange={(e) =>
                  setState({
                    ...state,
                    maxAttemptAgeHours: Number(e.currentTarget.value),
                  })
                }
              />
            </s-stack>
          </SurfaceCard>
        </s-section>
        <div style={{ height: "20px" }} />
        <s-section heading="Blocklist (opt-out)">
          <SurfaceCard padding="base">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Add phone numbers that should never receive OrderX WhatsApp
                messages.
              </s-paragraph>

              <s-stack direction="inline" gap="base" wrap>
                <s-text-field
                  label="Phone (E.164)"
                  value={blockForm.phone}
                  onChange={(e) =>
                    setBlockForm({ ...blockForm, phone: e.currentTarget.value })
                  }
                  placeholder="+15551234567"
                />
                <s-text-field
                  label="Note (optional)"
                  value={blockForm.note}
                  onChange={(e) =>
                    setBlockForm({ ...blockForm, note: e.currentTarget.value })
                  }
                  placeholder="Customer requested opt-out"
                />
                <s-button
                  onClick={() => {
                    const fd = new FormData();
                    fd.set("intent", "block_add");
                    fd.set("phone", blockForm.phone);
                    fd.set("note", blockForm.note);
                    submit(fd, { method: "POST" });
                  }}
                >
                  Add
                </s-button>
              </s-stack>

              {!blocklist?.length ? (
                <s-paragraph tone="subdued">
                  No blocked numbers yet.
                </s-paragraph>
              ) : (
                <s-stack direction="block" gap="tight">
                  {blocklist.map((b) => (
                    <SurfaceCard key={b._id} soft padding="base">
                      <s-stack direction="inline" gap="base" wrap>
                        <s-text>
                          <strong>{b.phoneE164}</strong>
                        </s-text>
                        <s-text tone="subdued">{b.note || "—"}</s-text>
                        <s-text tone="subdued">
                          {b.createdAt
                            ? formatDateTime(b.createdAt, merchantTimezone)
                            : ""}
                        </s-text>
                        <s-button
                          variant="secondary"
                          onClick={() => {
                            const fd = new FormData();
                            fd.set("intent", "block_remove");
                            fd.set("id", b._id);
                            submit(fd, { method: "POST" });
                          }}
                        >
                          Remove
                        </s-button>
                      </s-stack>
                    </SurfaceCard>
                  ))}
                </s-stack>
              )}

              {actionData?.intent?.startsWith("block_") && actionData?.error ? (
                <s-paragraph tone="critical">{actionData.error}</s-paragraph>
              ) : null}
            </s-stack>
          </SurfaceCard>
        </s-section>
        <div style={{ height: "20px" }} />
        <s-section heading="Activity log">
          <SurfaceCard padding="base">
            <s-stack direction="block" gap="tight">
              <s-heading>Recent activity</s-heading>
              {!audit?.length ? (
                <s-text tone="subdued">No activity yet.</s-text>
              ) : (
                <s-unordered-list>
                  {audit.slice(0, 20).map((item) => {
                    const meta = toObject(item?.meta);
                    const details = meta?.planKey
                      ? `plan=${meta.planKey}`
                      : Array.isArray(meta?.changedKeys) &&
                          meta.changedKeys.length
                        ? `changed=${meta.changedKeys.join(", ")}`
                        : meta?.orderName
                          ? `order=${meta.orderName}`
                          : "";
                    return (
                      <s-list-item key={item._id}>
                        {item?.createdAt
                          ? formatDateTime(item.createdAt, merchantTimezone)
                          : "—"}{" "}
                        — <strong>{item?.action || "event"}</strong>
                        {details ? ` (${details})` : ""}
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
                <s-heading>Need help?</s-heading>
                <s-text tone="subdued">
                  Keep support number updated so customers can reach your store
                  if they send custom replies.
                </s-text>
              </s-stack>
            </SurfaceCard>
          </s-stack>
        </s-section>
      </s-box>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
