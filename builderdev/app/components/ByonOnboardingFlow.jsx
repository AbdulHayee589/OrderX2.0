import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Form,
  useActionData,
  useFetcher,
  useNavigation,
  useSubmit,
} from "react-router";

import { SurfaceCard } from "./AppSurface";
import { isMetaCallbackForActiveState } from "../utils/metaCallbackState";
import {
  buildMetaEmbeddedSignupOptions,
  reserveMetaEmbeddedSignupPopup,
  runMetaLoginInReservedPopup,
} from "../utils/metaEmbeddedSignup";

const BYON_META_CALLBACK_MESSAGE = "ORDERX_BYON_META_CALLBACK";
const BYON_META_CALLBACK_STORAGE_KEY = "ORDERX_BYON_META_CALLBACK_PAYLOAD";
const META_PAYMENT_METHOD_URL =
  "https://business.facebook.com/billing_hub/payment_methods";
const META_SDK_SCRIPT_ID = "orderx-meta-sdk";

let metaSdkPromise = null;
let metaSdkInitKey = "";
const META_SDK_LOAD_TIMEOUT_MS = 12_000;

const toObject = (v) => (v && typeof v === "object" ? v : {});
const toGraphId = (v) =>
  /^[0-9]{5,}$/.test(String(v || "").trim()) ? String(v).trim() : "";

function isMetaEmbeddedOrigin(originValue) {
  try {
    const parsed = new URL(String(originValue || "").trim());
    const host = String(parsed.hostname || "")
      .trim()
      .toLowerCase();
    if (parsed.protocol !== "https:") return false;
    return host === "facebook.com" || host.endsWith(".facebook.com");
  } catch {
    return false;
  }
}

function firstNonEmptyString(values = []) {
  for (const raw of Array.isArray(values) ? values : []) {
    const value = String(raw || "").trim();
    if (value) return value;
  }
  return "";
}

function firstGraphId(values = []) {
  for (const raw of Array.isArray(values) ? values : []) {
    const id = toGraphId(raw);
    if (id) return id;
  }
  return "";
}

function parseJsonObject(value) {
  if (value && typeof value === "object") return value;
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function parseLooseJson(value) {
  if (value && typeof value === "object") return value;
  const raw = String(value || "").trim();
  if (!raw) return null;

  const candidates = [raw];
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) candidates.push(decoded);
  } catch {
    // ignore decode failures
  }

  for (const candidate of candidates) {
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // ignore parse failures
    }
  }

  return null;
}

function findFirstValueByKeys(input, keys, depth = 0) {
  if (!input || depth > 8) return "";
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = findFirstValueByKeys(item, keys, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof input !== "object") return "";

  for (const [key, value] of Object.entries(input)) {
    if (keys.has(key)) {
      const str = String(value || "").trim();
      if (str) return str;
    }
  }

  for (const value of Object.values(input)) {
    const found = findFirstValueByKeys(value, keys, depth + 1);
    if (found) return found;
  }

  return "";
}

function findGraphIdInKnownObjects(source, keys = []) {
  const base = toObject(source);
  for (const key of keys) {
    const node = base?.[key];
    if (!node || typeof node !== "object") continue;
    const nestedId = firstGraphId([
      node?.id,
      node?.waba_id,
      node?.wabaId,
      node?.phone_number_id,
      node?.phoneNumberId,
      node?.business_id,
      node?.businessId,
      node?.meta_business_id,
      node?.metaBusinessId,
    ]);
    if (nestedId) return nestedId;
  }
  return "";
}

function extractMetaRoutingPayload(payload) {
  const base = toObject(payload);
  const parsedPayloads = [base];
  const maybeNested = [
    base?.extras,
    base?.extra,
    base?.sessionInfo,
    base?.session_info,
    base?.data,
    base?.response,
  ];
  for (const value of maybeNested) {
    const parsed = parseLooseJson(value);
    if (parsed) parsedPayloads.push(parsed);
  }

  const wabaKeys = new Set([
    "waba_id",
    "wabaId",
    "selected_waba_id",
    "selected_whatsapp_business_account_id",
    "whatsapp_business_account_id",
    "whatsappBusinessAccountId",
    "whatsapp_account_id",
  ]);
  const phoneKeys = new Set([
    "phone_number_id",
    "phoneNumberId",
    "phone_id",
    "selected_phone_number_id",
    "selected_phone_id",
    "whatsapp_phone_number_id",
  ]);
  const bizKeys = new Set([
    "business_id",
    "businessId",
    "business_account_id",
    "selected_business_id",
    "business_manager_id",
    "meta_business_id",
    "metaBusinessId",
  ]);
  const displayKeys = new Set(["display_phone_number", "displayPhoneNumber"]);

  let wabaId = "";
  let phoneNumberId = "";
  let metaBusinessId = "";
  let displayPhoneNumber = "";

  for (const source of parsedPayloads) {
    if (!wabaId) {
      wabaId = toGraphId(findFirstValueByKeys(source, wabaKeys));
    }
    if (!phoneNumberId) {
      phoneNumberId = toGraphId(findFirstValueByKeys(source, phoneKeys));
    }
    if (!metaBusinessId) {
      metaBusinessId = toGraphId(findFirstValueByKeys(source, bizKeys));
    }
    if (!displayPhoneNumber) {
      displayPhoneNumber = String(
        findFirstValueByKeys(source, displayKeys) || "",
      ).trim();
    }

    if (!wabaId) {
      wabaId = findGraphIdInKnownObjects(source, [
        "waba",
        "whatsapp_business_account",
        "whatsappBusinessAccount",
        "whatsapp_account",
      ]);
    }
    if (!phoneNumberId) {
      phoneNumberId = findGraphIdInKnownObjects(source, [
        "phone_number",
        "phoneNumber",
        "phone",
      ]);
    }
    if (!metaBusinessId) {
      metaBusinessId = findGraphIdInKnownObjects(source, [
        "business",
        "business_account",
        "business_manager",
      ]);
    }
  }

  return { wabaId, phoneNumberId, metaBusinessId, displayPhoneNumber };
}

function parseMetaEmbeddedSignupEvent(event) {
  const origin = String(event?.origin || "").trim();
  if (!isMetaEmbeddedOrigin(origin)) return null;

  const parsed = parseJsonObject(event?.data);
  if (!parsed) return null;
  if (String(parsed?.type || "").trim() !== "WA_EMBEDDED_SIGNUP") return null;

  const eventName = String(parsed?.event || "")
    .trim()
    .toUpperCase();
  const payload = toObject(parsed?.data);
  const routing = extractMetaRoutingPayload(payload);
  const errorMessage = firstNonEmptyString([
    payload?.error_message,
    payload?.errorDescription,
    payload?.error_description,
    payload?.message,
  ]);

  return {
    eventName,
    routing,
    errorMessage,
  };
}

function normalizeMetaApiVersion(raw) {
  const version = String(raw || "v25.0").trim() || "v25.0";
  return version.startsWith("v") ? version : `v${version}`;
}

function loadMetaSdk() {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Meta SDK can only load in the browser"));
  }

  if (window.FB?.login) return Promise.resolve(window.FB);
  if (metaSdkPromise) return metaSdkPromise;

  metaSdkPromise = new Promise((resolve, reject) => {
    const existingScript = document.getElementById(META_SDK_SCRIPT_ID);
    let settled = false;
    let timeoutId = null;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (timeoutId) window.clearTimeout(timeoutId);
      existingScript?.removeEventListener?.("load", finishInit);
      existingScript?.removeEventListener?.("error", failLoad);
      callback();
    };

    const finishInit = () => {
      if (window.FB?.login) {
        finish(() => resolve(window.FB));
      }
    };

    const failLoad = () => {
      finish(() => {
        metaSdkPromise = null;
        reject(new Error("Failed to load Meta SDK"));
      });
    };

    const previousFbAsyncInit = window.fbAsyncInit;
    window.fbAsyncInit = () => {
      if (typeof previousFbAsyncInit === "function") {
        try {
          previousFbAsyncInit();
        } catch {
          // Another SDK consumer must not prevent OrderX from continuing.
        }
      }
      finishInit();
    };

    timeoutId = window.setTimeout(() => {
      if (window.FB?.login) {
        finishInit();
        return;
      }
      failLoad();
    }, META_SDK_LOAD_TIMEOUT_MS);

    if (existingScript) {
      existingScript.addEventListener("load", finishInit, { once: true });
      existingScript.addEventListener("error", failLoad, { once: true });
      // The script may have completed before this component mounted.
      window.setTimeout(() => {
        if (window.FB?.login) finishInit();
      }, 0);
      return;
    }

    const script = document.createElement("script");
    script.id = META_SDK_SCRIPT_ID;
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.addEventListener("load", finishInit, { once: true });
    script.addEventListener("error", failLoad, { once: true });
    document.body.appendChild(script);
  });

  return metaSdkPromise;
}

function launchMetaEmbeddedSignup({
  appId,
  configId,
  apiVersion,
  featureType,
  solutionId,
  popupWindow,
  onResponse,
}) {
  const normalizedAppId = String(appId || "").trim();
  const normalizedConfigId = String(configId || "").trim();
  if (!normalizedAppId || !normalizedConfigId) {
    throw new Error("Meta Embedded Signup is not configured correctly");
  }

  const normalizedVersion = normalizeMetaApiVersion(apiVersion);
  const initKey = `${normalizedAppId}:${normalizedVersion}`;
  const loginOptions = buildMetaEmbeddedSignupOptions({
    configId: normalizedConfigId,
    featureType,
    solutionId,
  });

  const openWithSdk = (FB) => {
    if (!FB?.login) throw new Error("Meta SDK is not ready");

    if (typeof FB.init === "function" && metaSdkInitKey !== initKey) {
      FB.init({
        appId: normalizedAppId,
        xfbml: false,
        cookie: true,
        autoLogAppEvents: false,
        fedCM: false,
        version: normalizedVersion,
      });
      metaSdkInitKey = initKey;
    }

    return new Promise((resolve, reject) => {
      try {
        const openLogin = () =>
          FB.login((response) => {
            try {
              if (typeof onResponse === "function") onResponse(response);
              resolve(response);
            } catch (error) {
              reject(error);
            }
          }, loginOptions);

        if (popupWindow) {
          runMetaLoginInReservedPopup({
            browserWindow: window,
            popupWindow,
            openLogin,
          });
        } else {
          openLogin();
        }
      } catch (error) {
        reject(error);
      }
    });
  };

  // On reconnect the SDK is normally warm. Calling FB.login synchronously in
  // the click handler preserves the browser's popup permission.
  if (window.FB?.login) return openWithSdk(window.FB);
  return loadMetaSdk().then(openWithSdk);
}

function tonePalette(tone = "neutral") {
  switch (tone) {
    case "success":
      return {
        text: "#166534",
        border: "rgba(22, 101, 52, 0.16)",
        bg: "#ecfdf3",
      };
    case "warning":
      return {
        text: "#a15c00",
        border: "rgba(161, 92, 0, 0.18)",
        bg: "#fff7e6",
      };
    case "critical":
      return {
        text: "#b42318",
        border: "rgba(180, 35, 24, 0.14)",
        bg: "#fef3f2",
      };
    case "info":
      return {
        text: "#175cd3",
        border: "rgba(23, 92, 211, 0.16)",
        bg: "#eff8ff",
      };
    default:
      return {
        text: "#475467",
        border: "rgba(71, 84, 103, 0.14)",
        bg: "#f8fafc",
      };
  }
}

function StatusPill({ label, tone = "neutral" }) {
  const palette = tonePalette(tone);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 700,
        background: palette.bg,
        color: palette.text,
        border: `1px solid ${palette.border}`,
      }}
    >
      {label}
    </span>
  );
}

function Stepper({ steps, currentStep, setCurrentStep }) {
  const completedCount = steps.filter((step) => step.complete).length;

  return (
    <div style={{ width: "100%" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 800, color: "#101828" }}>
          Setup progress
        </div>

        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: "#475467",
            background: "#f9fafb",
            border: "1px solid #eaecf0",
            borderRadius: 999,
            padding: "3px 8px",
            whiteSpace: "nowrap",
          }}
        >
          {completedCount}/{steps.length} done
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          width: "100%",
          overflowX: "auto",
          padding: "2px 1px 4px",
        }}
      >
        {steps.map((step, index) => {
          const isCurrent = step.id === currentStep;
          const isDone = step.complete;
          const isDisabled = !step.enabled;

          return (
            <div
              key={step.id}
              style={{
                position: "relative",
                flex: "1 1 0",
                minWidth: 92,
              }}
            >
              {index < steps.length - 1 && (
                <div
                  style={{
                    position: "absolute",
                    top: 13,
                    left: "calc(50% + 16px)",
                    right: "calc(-50% + 16px)",
                    height: 2,
                    background: isDone ? "#16a34a" : "#e4e7ec",
                    borderRadius: 999,
                    zIndex: 0,
                  }}
                />
              )}

              <button
                type="button"
                disabled={isDisabled}
                onClick={() => {
                  if (step.enabled) setCurrentStep(step.id);
                }}
                style={{
                  position: "relative",
                  zIndex: 1,
                  width: "100%",
                  border: "none",
                  background: "transparent",
                  padding: 0,
                  cursor: step.enabled ? "pointer" : "not-allowed",
                  opacity: isDisabled ? 0.45 : 1,
                  textAlign: "center",
                }}
              >
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    margin: "0 auto",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: isDone
                      ? "#16a34a"
                      : isCurrent
                        ? "#fff7ed"
                        : "#ffffff",
                    color: isDone
                      ? "#ffffff"
                      : isCurrent
                        ? "#ea580c"
                        : "#667085",
                    border: `2px solid ${
                      isDone ? "#16a34a" : isCurrent ? "#f97316" : "#d0d5dd"
                    }`,
                    fontSize: isDone ? 13 : 11,
                    fontWeight: 900,
                    boxShadow: isCurrent
                      ? "0 0 0 4px rgba(249, 115, 22, 0.12)"
                      : "0 3px 8px rgba(15, 23, 42, 0.06)",
                  }}
                >
                  {isDone ? "✓" : index + 1}
                </div>

                <div
                  style={{
                    marginTop: 6,
                    padding: "5px 4px",
                    borderRadius: 10,
                    background: isCurrent ? "#fff7ed" : "transparent",
                    border: isCurrent
                      ? "1px solid #fed7aa"
                      : "1px solid transparent",
                  }}
                >
                  <div
                    style={{
                      fontSize: 9,
                      fontWeight: 800,
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                      color: isDone
                        ? "#15803d"
                        : isCurrent
                          ? "#ea580c"
                          : "#98a2b3",
                      marginBottom: 2,
                    }}
                  >
                    {isDone
                      ? "Done"
                      : isCurrent
                        ? "Current"
                        : `Step ${index + 1}`}
                  </div>

                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 800,
                      color: isCurrent ? "#9a3412" : "#101828",
                      lineHeight: 1.15,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                    title={step.label}
                  >
                    {step.label}
                  </div>
                </div>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StepSection({ eyebrow, title, description, status, children }) {
  return (
    <SurfaceCard padding="base">
      <div style={{ display: "grid", gap: 18 }}>
        <div style={{ display: "grid", gap: 10 }}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
              {eyebrow ? (
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 800,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: "#475467",
                  }}
                >
                  {eyebrow}
                </div>
              ) : null}
              <div
                style={{
                  fontSize: 24,
                  lineHeight: 1.15,
                  fontWeight: 800,
                  color: "#101828",
                }}
              >
                {title}
              </div>
              {description ? (
                <p
                  style={{
                    margin: 0,
                    color: "#475467",
                    fontSize: 14,
                    lineHeight: 1.65,
                    maxWidth: 760,
                  }}
                >
                  {description}
                </p>
              ) : null}
            </div>
            {status ? (
              <StatusPill label={status.label} tone={status.tone} />
            ) : null}
          </div>
        </div>
        {children}
      </div>
    </SurfaceCard>
  );
}

function TemplateRow({ template }) {
  const label = String(template?.key || "")
    .replace(/^cod_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
  const status = String(template?.status || "missing")
    .trim()
    .toLowerCase();
  const tone =
    status === "approved"
      ? "success"
      : ["pending", "in_review", "pending_deletion"].includes(status)
        ? "warning"
        : ["rejected", "error", "paused", "disabled"].includes(status)
          ? "critical"
          : "neutral";
  const friendlyStatus =
    status === "in_review"
      ? "In review"
      : status === "pending_deletion"
        ? "Pending deletion"
        : status.charAt(0).toUpperCase() + status.slice(1);

  return (
    <div
      style={{
        display: "grid",
        gap: 8,
        padding: "14px 16px",
        borderRadius: 16,
        border: "1px solid rgba(15, 23, 42, 0.08)",
        background: "#ffffff",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#101828" }}>
            {label}
          </div>
          <div style={{ fontSize: 13, color: "#667085" }}>
            {template?.templateName || "Template name pending"}
          </div>
        </div>
        <StatusPill label={friendlyStatus} tone={tone} />
      </div>
      {template?.lastError ? (
        <div style={{ fontSize: 13, color: "#b42318", lineHeight: 1.55 }}>
          {template.lastError}
        </div>
      ) : null}
    </div>
  );
}

function StepActions({ onBack, backLabel = "Back", children }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div>
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            style={{
              border: "1px solid rgba(15, 23, 42, 0.12)",
              background: "#fff",
              color: "#344054",
              borderRadius: 12,
              padding: "10px 16px",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {backLabel}
          </button>
        ) : null}
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {children}
      </div>
    </div>
  );
}

function StepNotice({ tone = "info", title, children }) {
  const palette = tonePalette(tone);
  return (
    <div
      style={{
        borderRadius: 16,
        padding: "14px 16px",
        border: `1px solid ${palette.border}`,
        background: palette.bg,
        display: "grid",
        gap: 6,
      }}
    >
      {title ? (
        <div style={{ fontSize: 14, fontWeight: 700, color: palette.text }}>
          {title}
        </div>
      ) : null}
      <div style={{ fontSize: 13, color: palette.text, lineHeight: 1.6 }}>
        {children}
      </div>
    </div>
  );
}

function deriveTemplateSummary(templates = []) {
  const rows = Array.isArray(templates) ? templates : [];
  return {
    total: rows.length,
    approved: rows.filter((tpl) => String(tpl?.status || "") === "approved")
      .length,
    pending: rows.filter((tpl) =>
      ["pending", "in_review", "pending_deletion"].includes(
        String(tpl?.status || ""),
      ),
    ).length,
    missing: rows.filter((tpl) => String(tpl?.status || "") === "missing")
      .length,
    attention: rows.filter((tpl) =>
      ["rejected", "error", "paused", "disabled"].includes(
        String(tpl?.status || ""),
      ),
    ).length,
  };
}

function findStepError(actionData, intents = []) {
  const intent = String(actionData?.intent || "");
  if (!actionData?.error) return null;
  return intents.includes(intent) ? String(actionData.error || "") : null;
}

function metaConnectNeedsBusinessDetails(errorMessage) {
  const value = String(errorMessage || "")
    .trim()
    .toLowerCase();
  if (!value) return false;
  return value.includes("save business details before starting meta connect");
}

const formFieldStyles = {
  display: "grid",
  gap: 6,
};

const formLabelStyles = {
  fontSize: 13,
  fontWeight: 700,
  color: "#344054",
};

const formInputStyles = {
  width: "100%",
  borderRadius: 12,
  border: "1px solid rgba(15, 23, 42, 0.12)",
  padding: "11px 13px",
  fontSize: 14,
  lineHeight: 1.4,
  color: "#101828",
  background: "#fff",
  boxSizing: "border-box",
};

const metaConnectButtonStyles = {
  border: "1px solid #303030",
  background: "#303030",
  color: "#fff",
  borderRadius: 12,
  padding: "11px 17px",
  minHeight: 40,
  fontSize: 14,
  fontWeight: 700,
};

function buildRecommendedStep({
  linkedDevicesAcknowledged,
  metaConnected,
  paymentMethodAdded,
  showPlanStep,
  planStepComplete,
}) {
  if (!linkedDevicesAcknowledged) return "linked_devices";
  if (!metaConnected) return "meta";
  if (!paymentMethodAdded) return "payment";
  if (showPlanStep && !planStepComplete) return "plan";
  return "templates";
}

export default function ByonOnboardingFlow({
  sender,
  senderMetaConfig,
  showProgressTiles = true,
  planStepContent = null,
  planStepComplete = false,
  hidePlanStep = false,
  planStepLockedMessage = "Choose your BYON plan after Meta connect and payment setup.",
  settingsHref = null,
  dashboardHref = null,
  initialStep = "",
}) {
  const actionData = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();
  const metaConnectFetcher = useFetcher();

  const senderView = toObject(sender);
  const metaConfig = toObject(senderMetaConfig);
  const ownSender = toObject(senderView?.ownNumber);
  const ownProgress = toObject(ownSender?.progress);
  const ownTemplates = Array.isArray(ownSender?.templates)
    ? ownSender.templates
    : [];
  const templateSummary = deriveTemplateSummary(ownTemplates);
  const ownStatus = String(ownSender?.status || "not_started");
  const cloudRegistration = toObject(ownSender?.cloudRegistration);
  const cloudRegistrationStatus = String(
    cloudRegistration?.status || "unknown",
  );
  const cloudRegistrationOutcome = String(
    cloudRegistration?.outcome || "",
  ).trim();
  const cloudRegistrationError = String(cloudRegistration?.error || "").trim();
  const cloudConnected =
    String(cloudRegistration?.platformType || "")
      .trim()
      .toUpperCase() === "CLOUD_API" &&
    String(cloudRegistration?.phoneStatus || "")
      .trim()
      .toUpperCase() === "CONNECTED";
  const cloudRegistrationReady =
    cloudRegistrationStatus === "registered" || cloudConnected;
  const metaConnected = !!ownProgress?.metaConnected;
  const webhookReady = !!ownProgress?.webhookReady;
  const webhookSubscriptionError = String(
    ownSender?.webhookSubscriptionError || "",
  ).trim();
  const apiConnectionReady = cloudRegistrationReady && webhookReady;
  const paymentMethodAdded = !!ownProgress?.paymentMethodAdded;
  const templatePackProvisioned = !!ownProgress?.templatePackProvisioned;
  const templatesApproved = !!ownProgress?.templatesApproved;
  const templatesPendingApproval = !!ownProgress?.templatesPendingApproval;
  const showPlanStep = !hidePlanStep;
  const computedPlanStepComplete = hidePlanStep ? true : !!planStepComplete;
  const [linkedDevicesAcknowledged, setLinkedDevicesAcknowledged] = useState(
    () => metaConnected,
  );
  const recommendedStep = buildRecommendedStep({
    linkedDevicesAcknowledged,
    metaConnected,
    paymentMethodAdded,
    showPlanStep,
    planStepComplete: computedPlanStepComplete,
  });
  const normalizedInitialStep = [
    "linked_devices",
    "meta",
    "payment",
    "plan",
    "templates",
  ].includes(String(initialStep || "").trim())
    ? String(initialStep || "").trim()
    : "";
  const [currentStep, setCurrentStep] = useState(
    normalizedInitialStep || recommendedStep,
  );
  const [metaClientError, setMetaClientError] = useState("");
  const [preparedMetaConnect, setPreparedMetaConnect] = useState(null);
  const [metaSdkReady, setMetaSdkReady] = useState(false);
  const detailsFormRef = useRef(null);

  useEffect(() => {
    if (metaConfig?.embeddedSignupEnabled === false) return;
    let active = true;
    void loadMetaSdk()
      .then(() => {
        if (active) setMetaSdkReady(true);
      })
      .catch((error) => {
        if (active) {
          setMetaSdkReady(false);
          setMetaClientError(
            error?.message || "Could not load Meta Embedded Signup",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [metaConfig?.embeddedSignupEnabled]);

  useEffect(() => {
    if (metaConnected) setLinkedDevicesAcknowledged(true);
  }, [metaConnected]);

  useEffect(() => {
    setCurrentStep((prev) => {
      const order = [
        "linked_devices",
        "meta",
        "payment",
        ...(showPlanStep ? ["plan"] : []),
        "templates",
      ];
      const prevIndex = order.indexOf(prev);
      const recommendedIndex = order.indexOf(recommendedStep);
      if (prevIndex === -1) return recommendedStep;
      if (recommendedIndex > prevIndex) return recommendedStep;
      return prev;
    });
  }, [recommendedStep, showPlanStep]);

  useEffect(() => {
    if (!normalizedInitialStep) return;
    setCurrentStep(normalizedInitialStep);
  }, [normalizedInitialStep]);

  useEffect(() => {
    if (
      actionData?.ok &&
      String(actionData?.intent || "") === "activate_byon_free_trial"
    ) {
      setCurrentStep("templates");
    }
  }, [actionData]);

  const metaEmbeddedRoutingRef = useRef({
    wabaId: "",
    phoneNumberId: "",
    metaBusinessId: "",
    displayPhoneNumber: "",
  });
  const metaEmbeddedErrorRef = useRef("");
  const lastMetaCallbackRef = useRef("");
  const lastAutoOpenedMetaStateRef = useRef("");
  const pendingMetaConnectStateRef = useRef("");
  const pendingMetaConnectRedirectUriRef = useRef("");
  const metaSessionPreparationRequestedRef = useRef(false);
  const reservedMetaPopupRef = useRef(null);
  const pendingReservedMetaLaunchRef = useRef(false);

  const closeReservedMetaPopup = useCallback(() => {
    const popup = reservedMetaPopupRef.current;
    reservedMetaPopupRef.current = null;
    pendingReservedMetaLaunchRef.current = false;
    try {
      if (popup && !popup.closed) popup.close();
    } catch {
      // The browser may deny access after Meta navigates the popup.
    }
  }, []);

  useEffect(() => {
    if (currentStep !== "meta") {
      metaSessionPreparationRequestedRef.current = false;
      return;
    }

    const preparedState = String(preparedMetaConnect?.state || "").trim();
    const preparedExpiresAt = new Date(
      preparedMetaConnect?.expiresAt || 0,
    ).getTime();
    const preparedIsUsable =
      preparedState &&
      Number.isFinite(preparedExpiresAt) &&
      preparedExpiresAt > Date.now();
    if (
      preparedIsUsable ||
      metaConfig?.embeddedSignupEnabled === false ||
      metaConnectFetcher.state !== "idle" ||
      metaSessionPreparationRequestedRef.current
    ) {
      return;
    }

    metaSessionPreparationRequestedRef.current = true;
    const fd = new FormData();
    fd.set("intent", "byon_meta_connect_session_prepare");
    fd.set("metaFeatureType", String(metaConfig?.featureType || "").trim());
    metaConnectFetcher.submit(fd, { method: "POST" });
  }, [
    currentStep,
    metaConfig?.embeddedSignupEnabled,
    metaConfig?.featureType,
    metaConnectFetcher,
    preparedMetaConnect?.expiresAt,
    preparedMetaConnect?.state,
  ]);

  useEffect(() => {
    const data = toObject(metaConnectFetcher.data);
    if (String(data?.intent || "") !== "byon_meta_connect_session_prepare") {
      return;
    }
    if (!data?.ok || !data?.metaConnect) {
      closeReservedMetaPopup();
      setMetaClientError(
        String(data?.error || "Could not prepare Meta reconnect").trim(),
      );
      return;
    }

    const metaConnect = toObject(data.metaConnect);
    const nextState = String(metaConnect.state || "").trim();
    pendingMetaConnectStateRef.current = nextState;
    pendingMetaConnectRedirectUriRef.current = String(
      metaConnect.redirectUri || "",
    );
    metaEmbeddedRoutingRef.current = {
      wabaId: "",
      phoneNumberId: "",
      metaBusinessId: "",
      displayPhoneNumber: "",
    };
    metaEmbeddedErrorRef.current = "";
    lastMetaCallbackRef.current = "";
    setPreparedMetaConnect(metaConnect);
    setMetaClientError("");
  }, [closeReservedMetaPopup, metaConnectFetcher.data]);

  const submitMetaFinalize = useCallback(
    (
      payload,
      { checkOrigin = true, origin = "", allowMissingState = false } = {},
    ) => {
      const fallbackRedirectUri = String(
        pendingMetaConnectRedirectUriRef.current || "",
      );
      const fallbackState = String(pendingMetaConnectStateRef.current || "");
      const payloadState = String(toObject(payload)?.state || "").trim();
      // A callback is valid only while this component owns an active connect
      // attempt. Ignore old popup/localStorage payloads from earlier attempts.
      if (
        !isMetaCallbackForActiveState(fallbackState, payloadState, {
          allowMissingCallbackState: allowMissingState,
        })
      ) {
        return false;
      }
      if (checkOrigin && fallbackRedirectUri) {
        try {
          const callbackOrigin = new URL(fallbackRedirectUri).origin;
          if (origin !== callbackOrigin && origin !== window.location.origin) {
            return false;
          }
        } catch {
          // rely on backend state validation
        }
      }

      const safePayload = toObject(payload);
      const routing = extractMetaRoutingPayload(safePayload);
      const embeddedRouting = toObject(metaEmbeddedRoutingRef.current);
      const embeddedError = String(metaEmbeddedErrorRef.current || "").trim();
      const resolvedCode = String(safePayload.code || "").trim();
      const callbackKey = [
        fallbackState,
        resolvedCode,
        String(safePayload.error || "").trim(),
      ].join("|");
      if (
        callbackKey &&
        callbackKey === String(lastMetaCallbackRef.current || "")
      ) {
        return false;
      }
      if (callbackKey) lastMetaCallbackRef.current = callbackKey;

      const resolvedError = firstNonEmptyString([
        String(safePayload.error || "").trim(),
        embeddedError ? "embedded_signup_incomplete" : "",
        !resolvedCode ? "embedded_signup_incomplete" : "",
      ]);
      const resolvedErrorDescription = firstNonEmptyString([
        String(
          safePayload.error_description || safePayload.errorDescription || "",
        ).trim(),
        embeddedError,
        !resolvedCode
          ? "Meta did not return an authorization code. Complete the official Meta flow and try again."
          : "",
      ]);

      const fd = new FormData();
      fd.set("intent", "byon_meta_connect_finalize");
      fd.set("state", fallbackState);
      fd.set("code", resolvedCode);
      fd.set("redirectUri", String(safePayload.redirect_uri || "").trim());
      fd.set(
        "wabaId",
        firstGraphId([
          safePayload.waba_id,
          safePayload.wabaId,
          routing.wabaId,
          embeddedRouting.wabaId,
        ]),
      );
      fd.set(
        "phoneNumberId",
        firstGraphId([
          safePayload.phone_number_id,
          safePayload.phoneNumberId,
          routing.phoneNumberId,
          embeddedRouting.phoneNumberId,
        ]),
      );
      fd.set(
        "metaBusinessId",
        firstGraphId([
          safePayload.business_id,
          safePayload.metaBusinessId,
          routing.metaBusinessId,
          embeddedRouting.metaBusinessId,
        ]),
      );
      fd.set(
        "displayPhoneNumber",
        firstNonEmptyString([
          safePayload.display_phone_number,
          safePayload.displayPhoneNumber,
          routing.displayPhoneNumber,
          embeddedRouting.displayPhoneNumber,
        ]),
      );
      fd.set("metaError", resolvedError);
      fd.set("metaErrorDescription", resolvedErrorDescription);
      submit(fd, { method: "POST" });
      return true;
    },
    [submit],
  );

  const openPreparedMetaPopup = useCallback(
    (connectPayload) => {
      const metaConnect = toObject(connectPayload);
      if (!String(metaConnect?.state || "").trim()) return false;

      const popupWindow = reservedMetaPopupRef.current;
      reservedMetaPopupRef.current = null;
      pendingReservedMetaLaunchRef.current = false;

      setMetaClientError("");
      void launchMetaEmbeddedSignup({
        appId: metaConnect.appId,
        configId: metaConnect.configId,
        apiVersion: metaConnect.apiVersion,
        featureType: metaConnect.featureType,
        solutionId: metaConnect.solutionId,
        popupWindow,
        onResponse: (response) => {
          const code = String(response?.authResponse?.code || "").trim();
          if (code) {
            submitMetaFinalize(
              {
                code,
                state: String(metaConnect.state || "").trim(),
              },
              { checkOrigin: false, allowMissingState: true },
            );
            return;
          }

          const embeddedError = String(
            metaEmbeddedErrorRef.current || "",
          ).trim();
          if (embeddedError) {
            submitMetaFinalize(
              {
                state: String(metaConnect.state || "").trim(),
                error: "embedded_signup_incomplete",
                errorDescription: embeddedError,
              },
              { checkOrigin: false },
            );
            return;
          }

          setMetaClientError(
            "Meta did not open or the popup was closed. Allow popups for OrderX, then click Reconnect WhatsApp Business App again.",
          );
        },
      }).catch((error) => {
        try {
          if (popupWindow && !popupWindow.closed) popupWindow.close();
        } catch {
          // The window may already belong to Meta.
        }
        setMetaClientError(
          `${error?.message || "Could not open Meta Embedded Signup"}. Click Reconnect WhatsApp Business App to retry.`,
        );
      });
      return true;
    },
    [submitMetaFinalize],
  );

  useEffect(() => {
    if (!pendingReservedMetaLaunchRef.current) return;

    const prepared = toObject(preparedMetaConnect);
    const preparedState = String(prepared?.state || "").trim();
    const preparedExpiresAt = new Date(prepared?.expiresAt || 0).getTime();
    const preparedIsUsable =
      preparedState &&
      (!Number.isFinite(preparedExpiresAt) || preparedExpiresAt > Date.now()) &&
      preparedState === String(pendingMetaConnectStateRef.current || "").trim();

    if (preparedIsUsable) openPreparedMetaPopup(prepared);
  }, [openPreparedMetaPopup, preparedMetaConnect]);

  useEffect(
    () => () => {
      closeReservedMetaPopup();
    },
    [closeReservedMetaPopup],
  );

  useEffect(() => {
    const actionIntent = String(actionData?.intent || "");
    const isMetaPreparation = [
      "byon_meta_connect_begin",
      "byon_meta_connect_prepare",
    ].includes(actionIntent);

    if (isMetaPreparation && actionData?.ok === false) {
      closeReservedMetaPopup();
      return undefined;
    }

    if (!actionData?.ok || !isMetaPreparation || !actionData?.metaConnect) {
      return undefined;
    }

    const metaConnect = toObject(actionData.metaConnect);
    metaEmbeddedRoutingRef.current = {
      wabaId: "",
      phoneNumberId: "",
      metaBusinessId: "",
      displayPhoneNumber: "",
    };
    metaEmbeddedErrorRef.current = "";
    lastMetaCallbackRef.current = "";
    const nextState = String(metaConnect.state || "");
    try {
      // Never allow a callback saved by a previous connection attempt to race
      // the new FB.login response.
      window.localStorage.removeItem(BYON_META_CALLBACK_STORAGE_KEY);
    } catch {
      // ignore storage errors
    }
    pendingMetaConnectStateRef.current = nextState;
    pendingMetaConnectRedirectUriRef.current = String(
      metaConnect.redirectUri || "",
    );
    setPreparedMetaConnect(metaConnect);
    setMetaClientError("");
    if (lastAutoOpenedMetaStateRef.current !== nextState) {
      lastAutoOpenedMetaStateRef.current = nextState;
      openPreparedMetaPopup(metaConnect);
    }
    return undefined;
  }, [actionData, closeReservedMetaPopup, openPreparedMetaPopup]);

  useEffect(() => {
    if (String(actionData?.intent || "") === "byon_meta_connect_finalize") {
      setPreparedMetaConnect(null);
    }
  }, [actionData]);

  useEffect(() => {
    const onMessage = (event) => {
      const embeddedSignup = parseMetaEmbeddedSignupEvent(event);
      if (embeddedSignup) {
        if (
          embeddedSignup.eventName === "FINISH" ||
          embeddedSignup.eventName === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"
        ) {
          const prev = toObject(metaEmbeddedRoutingRef.current);
          metaEmbeddedRoutingRef.current = {
            wabaId: firstGraphId([
              embeddedSignup.routing?.wabaId,
              prev?.wabaId,
            ]),
            phoneNumberId: firstGraphId([
              embeddedSignup.routing?.phoneNumberId,
              prev?.phoneNumberId,
            ]),
            metaBusinessId: firstGraphId([
              embeddedSignup.routing?.metaBusinessId,
              prev?.metaBusinessId,
            ]),
            displayPhoneNumber: firstNonEmptyString([
              embeddedSignup.routing?.displayPhoneNumber,
              prev?.displayPhoneNumber,
            ]),
          };
          metaEmbeddedErrorRef.current = "";
        } else if (
          embeddedSignup.eventName === "ERROR" ||
          embeddedSignup.eventName === "CANCEL" ||
          embeddedSignup.eventName === "CANCELLED"
        ) {
          metaEmbeddedErrorRef.current = firstNonEmptyString([
            embeddedSignup.errorMessage,
            "Embedded Signup was not completed.",
          ]);
          setMetaClientError(metaEmbeddedErrorRef.current);
        }
        return;
      }

      const data = event.data || {};
      if (data?.type !== BYON_META_CALLBACK_MESSAGE) return;
      submitMetaFinalize(toObject(data?.payload), {
        checkOrigin: true,
        origin: String(event.origin || ""),
      });
    };

    const consumeStoredCallbackPayload = () => {
      try {
        const raw = window.localStorage.getItem(BYON_META_CALLBACK_STORAGE_KEY);
        if (!raw) return;
        const parsed = parseLooseJson(raw);
        const body = toObject(parsed);
        const payload =
          body?.type === BYON_META_CALLBACK_MESSAGE
            ? toObject(body?.payload)
            : toObject(body);
        if (!Object.keys(payload).length) return;
        const activeState = String(
          pendingMetaConnectStateRef.current || "",
        ).trim();
        const storedState = String(payload?.state || "").trim();
        if (!isMetaCallbackForActiveState(activeState, storedState)) {
          // It belongs to a closed or superseded connection attempt.
          window.localStorage.removeItem(BYON_META_CALLBACK_STORAGE_KEY);
          return;
        }
        const consumed = submitMetaFinalize(payload, { checkOrigin: false });
        if (consumed) {
          window.localStorage.removeItem(BYON_META_CALLBACK_STORAGE_KEY);
        }
      } catch {
        // ignore storage errors
      }
    };

    const onStorage = (event) => {
      if (event.key !== BYON_META_CALLBACK_STORAGE_KEY) return;
      consumeStoredCallbackPayload();
    };

    consumeStoredCallbackPayload();

    window.addEventListener("message", onMessage);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("storage", onStorage);
    };
  }, [submitMetaFinalize]);

  const submittingIntent =
    navigation.state === "submitting"
      ? String(navigation.formData?.get("intent") || "")
      : "";
  const metaStepError = findStepError(actionData, [
    "byon_meta_connect_begin",
    "byon_meta_connect_prepare",
    "byon_meta_connect_finalize",
  ]);
  const metaNeedsBusinessDetails =
    metaConnectNeedsBusinessDetails(metaStepError);
  const effectiveMetaStepError = metaStepError || metaClientError;
  const paymentStepError = findStepError(actionData, [
    "byon_confirm_payment_method",
  ]);
  const templateStepError = findStepError(actionData, [
    "byon_templates_provision",
    "byon_templates_sync",
  ]);

  const metaStatus = metaConnected
    ? apiConnectionReady
      ? { label: "Connected and API ready", tone: "success" }
      : {
          label: cloudRegistrationReady
            ? "Webhook subscription pending"
            : "Cloud registration pending",
          tone: "warning",
        }
    : metaConfig?.embeddedSignupEnabled === false
      ? { label: "Meta connect unavailable", tone: "critical" }
      : ownStatus === "registration_pending"
        ? { label: "Cloud registration pending", tone: "warning" }
        : ownStatus === "reauth_required"
          ? { label: "Reconnect required", tone: "critical" }
          : { label: "Needs Meta connect", tone: "warning" };
  const paymentStatus = paymentMethodAdded
    ? { label: "Confirmed", tone: "success" }
    : { label: "Pending", tone: "warning" };
  const templatesStatus = templatesApproved
    ? { label: "Approved", tone: "success" }
    : templatesPendingApproval
      ? { label: "Pending approval", tone: "warning" }
      : templatePackProvisioned
        ? { label: "Needs attention", tone: "critical" }
        : { label: "Not added yet", tone: "warning" };

  const steps = useMemo(() => {
    const canOpenMeta = linkedDevicesAcknowledged;
    const canOpenPayment = linkedDevicesAcknowledged && metaConnected;
    const canOpenPlan = canOpenPayment && paymentMethodAdded;
    return [
      {
        id: "linked_devices",
        label: "Linked devices",
        complete: linkedDevicesAcknowledged,
        enabled: true,
      },
      {
        id: "meta",
        label: "Meta connect",
        complete: metaConnected,
        enabled: canOpenMeta,
      },
      {
        id: "payment",
        label: "Add payment method",
        complete: paymentMethodAdded,
        enabled: canOpenPayment,
      },
      ...(showPlanStep
        ? [
            {
              id: "plan",
              label: "Select plan",
              complete: computedPlanStepComplete,
              enabled: canOpenPlan,
            },
          ]
        : []),
      {
        id: "templates",
        label: "Templates",
        complete: templatesApproved,
        enabled: canOpenPlan && (!showPlanStep || computedPlanStepComplete),
      },
    ];
  }, [
    computedPlanStepComplete,
    linkedDevicesAcknowledged,
    metaConnected,
    paymentMethodAdded,
    showPlanStep,
    templatesApproved,
  ]);

  const currentStepIndex = steps.findIndex((step) => step.id === currentStep);
  const canGoBack = currentStepIndex > 0;
  const goBack = canGoBack
    ? () =>
        setCurrentStep(
          steps[Math.max(0, currentStepIndex - 1)]?.id || "linked_devices",
        )
    : null;

  const metaConnectSubmitLoading = [
    "byon_meta_connect_begin",
    "byon_meta_connect_prepare",
  ].includes(submittingIntent);
  const metaSessionPreparing = metaConnectFetcher.state !== "idle";
  const preparedMetaState = String(preparedMetaConnect?.state || "").trim();
  const preparedMetaExpiresAt = new Date(
    preparedMetaConnect?.expiresAt || 0,
  ).getTime();
  const hasUsablePreparedMetaSession =
    !!preparedMetaState &&
    Number.isFinite(preparedMetaExpiresAt) &&
    preparedMetaExpiresAt > Date.now();
  const metaConnectButtonDisabled = metaConnectSubmitLoading;
  const metaConnectPreparing =
    metaConnectSubmitLoading ||
    metaSessionPreparing ||
    (!metaSdkReady && !hasUsablePreparedMetaSession);

  const launchWhatsAppEmbeddedSignup = () => {
    setMetaClientError("");

    if (metaConfig?.embeddedSignupEnabled === false) {
      setMetaClientError(
        "Meta Embedded Signup is not configured for this store.",
      );
      return;
    }

    const existingPopup = reservedMetaPopupRef.current;
    if (existingPopup && !existingPopup.closed) {
      existingPopup.focus?.();
      return;
    }

    const popupWindow = reserveMetaEmbeddedSignupPopup(window);
    if (!popupWindow) {
      setMetaClientError(
        "Your browser blocked the Meta popup. Allow popups for app.orderxapp.com, then click the button again.",
      );
      return;
    }
    reservedMetaPopupRef.current = popupWindow;
    pendingReservedMetaLaunchRef.current = true;

    if (metaNeedsBusinessDetails && detailsFormRef.current) {
      const fd = new FormData(detailsFormRef.current);
      fd.set("intent", "byon_meta_connect_prepare");
      fd.set("metaFeatureType", String(metaConfig?.featureType || "").trim());
      submit(fd, { method: "POST" });
      return;
    }

    const prepared = toObject(preparedMetaConnect);
    const preparedState = String(prepared?.state || "").trim();
    const preparedExpiresAt = new Date(prepared?.expiresAt || 0).getTime();
    if (
      preparedState &&
      (!Number.isFinite(preparedExpiresAt) || preparedExpiresAt > Date.now()) &&
      preparedState === String(pendingMetaConnectStateRef.current || "").trim()
    ) {
      openPreparedMetaPopup(prepared);
      return;
    }
    if (preparedState) setPreparedMetaConnect(null);

    const fd = new FormData();
    fd.set("intent", "byon_meta_connect_session_prepare");
    fd.set("metaFeatureType", String(metaConfig?.featureType || "").trim());
    metaSessionPreparationRequestedRef.current = true;
    metaConnectFetcher.submit(fd, { method: "POST" });
  };

  const metaConnectButtonLabel = metaConnected
    ? "Reconnect WhatsApp Business App"
    : "Connect WhatsApp Business App";

  const renderLinkedDevicesStep = () => (
    <StepSection
      eyebrow="Step 1"
      title="Do not use linked devices"
      description="Log out of all linked devices before connecting this WhatsApp number to OrderX. This helps prevent WhatsApp restrictions and keeps customer replies reliable."
      status={{ label: "Important", tone: "warning" }}
    >
      <div style={{ display: "grid", gap: 14 }}>
        {/* <StepNotice tone="warning" title="Important before you continue">
          Log out of all linked devices from the WhatsApp Business app before
          using Meta onboarding here. If the number stays active on extra linked
          devices, WhatsApp may restrict the account or replies may not reach
          OrderX correctly.
        </StepNotice> */}

        <StepActions>
          <s-button
            type="button"
            variant="primary"
            onClick={() => {
              setLinkedDevicesAcknowledged(true);
              setCurrentStep("meta");
            }}
          >
            Next Step
          </s-button>
        </StepActions>
      </div>
    </StepSection>
  );

  const renderMetaStep = () => (
    <StepSection
      eyebrow="Step 2"
      title="Connect Whatsapp"
      description="Use Meta’s official WhatsApp Business App onboarding flow to connect the whatsapp business number that already runs in WhatsApp Business App."
      status={metaStatus}
    >
      <div style={{ display: "grid", gap: 14 }}>
        {/* {String(metaConfig?.featureType || "").trim() ===
        "whatsapp_business_app_onboarding" ? (
          <StepNotice tone="info" title="Coexistence enabled">
            In the Meta popup, choose the option to connect your existing
            WhatsApp Business App account. Your number stays usable in the
            mobile app while OrderX connects it to Cloud API.
          </StepNotice>
        ) : null} */}
        {/* {showByonRequiredBanner ? (
          <StepNotice tone="info" title="What this step does">
            OrderX opens Meta’s official WhatsApp Business App onboarding
            popup for the existing business-app number you want to connect. Once
            the Meta flow finishes, OrderX continues with the same onboarding,
            template checks, and dashboard setup automatically.
          </StepNotice>
        ) : null} */}

        {/* <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 12,
          }}
        >
          {infoRows.slice(0, 2).map((row) => (
            <div
              key={row.label}
              style={{
                border: "1px solid rgba(15, 23, 42, 0.08)",
                borderRadius: 16,
                padding: 16,
                background: "#fff",
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "#667085",
                  fontWeight: 700,
                }}
              >
                {row.label}
              </div>
              <div
                style={{
                  marginTop: 8,
                  fontSize: 14,
                  lineHeight: 1.55,
                  color: "#101828",
                  fontWeight: 600,
                  wordBreak: "break-word",
                }}
              >
                {row.value}
              </div>
            </div>
          ))}
        </div> */}

        {effectiveMetaStepError && !metaNeedsBusinessDetails ? (
          <StepNotice tone="critical" title="Meta connection issue">
            {effectiveMetaStepError}
          </StepNotice>
        ) : null}

        {metaConnected && cloudRegistrationReady && !webhookReady ? (
          <StepNotice tone="warning" title="Webhook subscription pending">
            {webhookSubscriptionError ||
              "OrderX saved the number, but Meta has not confirmed the WABA webhook subscription yet. Use Retry Cloud registration after checking the app webhook configuration."}
          </StepNotice>
        ) : null}

        {metaNeedsBusinessDetails ? (
          <StepNotice
            tone="warning"
            title="Meta needs a few business details first"
          >
            Your live Meta setup is still asking OrderX for the merchant details
            before opening Embedded Signup. Save them once here, then we’ll
            reopen the Meta popup right away.
          </StepNotice>
        ) : metaConfig?.embeddedSignupEnabled === false ? (
          <StepNotice
            tone="critical"
            title="Meta Embedded Signup is not configured"
          >
            OrderX could not find the required Meta app configuration for this
            store. Recheck the Meta app setup before the merchant continues.
          </StepNotice>
        ) : null}

        {metaNeedsBusinessDetails ? (
          <Form
            ref={detailsFormRef}
            method="post"
            style={{ display: "grid", gap: 14 }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 12,
              }}
            >
              <label style={formFieldStyles}>
                <span style={formLabelStyles}>Business name</span>
                <input
                  type="text"
                  name="byonBusinessName"
                  defaultValue={String(ownSender?.businessName || "")}
                  style={formInputStyles}
                  placeholder="OrderX Store"
                  autoComplete="organization"
                />
              </label>
              <label style={formFieldStyles}>
                <span style={formLabelStyles}>Contact name</span>
                <input
                  type="text"
                  name="byonContactName"
                  defaultValue={String(ownSender?.contactName || "")}
                  style={formInputStyles}
                  placeholder="Store owner"
                  autoComplete="name"
                />
              </label>
              <label style={formFieldStyles}>
                <span style={formLabelStyles}>Contact email</span>
                <input
                  type="email"
                  name="byonContactEmail"
                  defaultValue={String(ownSender?.contactEmail || "")}
                  style={formInputStyles}
                  placeholder="owner@store.com"
                  autoComplete="email"
                />
              </label>
              <label style={formFieldStyles}>
                <span style={formLabelStyles}>WhatsApp number</span>
                <input
                  type="text"
                  name="byonRequestedPhoneNumber"
                  defaultValue={String(ownSender?.requestedPhoneNumber || "")}
                  style={formInputStyles}
                  placeholder="+923001234567"
                  autoComplete="tel"
                />
              </label>
            </div>

            <StepActions onBack={goBack}>
              <button
                type="button"
                onClick={launchWhatsAppEmbeddedSignup}
                disabled={metaConnectButtonDisabled}
                aria-busy={metaConnectPreparing ? "true" : "false"}
                style={{
                  ...metaConnectButtonStyles,
                  cursor: metaConnectButtonDisabled ? "wait" : "pointer",
                  opacity: metaConnectButtonDisabled ? 0.7 : 1,
                }}
              >
                {metaConnectButtonLabel}
              </button>
              {metaConnected ? (
                <button
                  type="button"
                  onClick={() => setCurrentStep("payment")}
                  style={{
                    border: "1px solid rgba(15, 23, 42, 0.12)",
                    background: "#fff",
                    color: "#344054",
                    borderRadius: 12,
                    padding: "10px 16px",
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  Continue to payment step
                </button>
              ) : null}
            </StepActions>
          </Form>
        ) : (
          <StepActions>
            <button
              type="button"
              onClick={launchWhatsAppEmbeddedSignup}
              disabled={metaConnectButtonDisabled}
              aria-busy={metaConnectPreparing ? "true" : "false"}
              style={{
                ...metaConnectButtonStyles,
                cursor: metaConnectButtonDisabled ? "wait" : "pointer",
                opacity: metaConnectButtonDisabled ? 0.7 : 1,
              }}
            >
              {metaConnectButtonLabel}
            </button>
            {metaConnected ? (
              <button
                type="button"
                onClick={() => setCurrentStep("payment")}
                style={{
                  border: "1px solid rgba(15, 23, 42, 0.12)",
                  background: "#fff",
                  color: "#344054",
                  borderRadius: 12,
                  padding: "10px 16px",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Continue to payment step
              </button>
            ) : null}
          </StepActions>
        )}
      </div>
    </StepSection>
  );

  const renderPaymentStep = () => (
    <StepSection
      eyebrow="Step 3"
      title="Add payment method to Meta"
      description="Required for message delivery. Payment method must be set as default not backup. You pay Meta directly, no markup."
      status={paymentStatus}
    >
      <div style={{ display: "grid", gap: 14 }}>
        {/* <StepNotice tone="warning" title="Why this matters">
          Without a Meta payment method, the template pack cannot move cleanly
          into approval and live sending may stay blocked.
        </StepNotice> */}

        {/* <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 12,
          }}
        >
          {infoRows.slice(2).map((row) => (
            <div
              key={row.label}
              style={{
                border: "1px solid rgba(15, 23, 42, 0.08)",
                borderRadius: 16,
                padding: 16,
                background: "#fff",
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "#667085",
                  fontWeight: 700,
                }}
              >
                {row.label}
              </div>
              <div
                style={{
                  marginTop: 8,
                  fontSize: 14,
                  lineHeight: 1.55,
                  color: "#101828",
                  fontWeight: 600,
                }}
              >
                {row.value}
              </div>
            </div>
          ))}
        </div> */}

        {paymentStepError ? (
          <StepNotice tone="critical" title="Payment step issue">
            {paymentStepError}
          </StepNotice>
        ) : null}

        <StepActions onBack={goBack}>
          <a href={META_PAYMENT_METHOD_URL} target="_blank" rel="noreferrer">
            <s-button variant="secondary">Open Meta billing hub</s-button>
          </a>
          <Form method="post">
            <input
              type="hidden"
              name="intent"
              value="byon_confirm_payment_method"
            />
            {cloudRegistrationOutcome === "NEED_PIN" &&
            !cloudRegistrationReady ? (
              <label style={{ ...formFieldStyles, marginBottom: 12 }}>
                <span style={formLabelStyles}>
                  Existing WhatsApp two-step PIN
                </span>
                <input
                  type="password"
                  name="registrationPin"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  minLength={6}
                  maxLength={6}
                  required
                  autoComplete="off"
                  style={formInputStyles}
                  placeholder="6-digit PIN"
                />
              </label>
            ) : null}
            <s-button
              type="submit"
              variant="primary"
              {...(submittingIntent === "byon_confirm_payment_method"
                ? { loading: true }
                : {})}
            >
              I added the Meta payment method
            </s-button>
          </Form>
        </StepActions>
      </div>
    </StepSection>
  );

  const renderPlanStep = () => (
    <StepSection
      eyebrow="Step 4"
      title="Select plan"
      description="Choose Your plan, Start with the 7 days trial plan for free. Switch to paid plan when ready."
      status={{
        label: computedPlanStepComplete ? "Plan selected" : "Action needed",
        tone: computedPlanStepComplete ? "success" : "warning",
      }}
    >
      <div style={{ display: "grid", gap: 14 }}>
        {/* {showSubscriptionStepHint ? (
          <StepNotice tone="info" title="Plan step">
            Subscribe to the BYON package here. Template review does not block
            entry to the app dashboard after this step.
          </StepNotice>
        ) : null} */}
        {!paymentMethodAdded ? (
          <StepNotice tone="warning" title="Finish the previous steps first">
            {planStepLockedMessage}
          </StepNotice>
        ) : null}
        <div>{planStepContent}</div>
        <StepActions onBack={goBack}>
          {computedPlanStepComplete ? (
            <button
              type="button"
              onClick={() => setCurrentStep("templates")}
              style={{
                border: "1px solid rgba(15, 23, 42, 0.12)",
                background: "#fff",
                color: "#344054",
                borderRadius: 12,
                padding: "10px 16px",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Continue to templates
            </button>
          ) : null}
        </StepActions>
      </div>
    </StepSection>
  );

  const renderTemplatesStep = () => (
    <StepSection
      eyebrow={`Step ${showPlanStep ? "5" : "4"}`}
      title="Templates"
      description="OrderX checks the English template pack automatically. If the pack already exists, we’ll show the latest status instead of asking the merchant to add it again."
      status={templatesStatus}
    >
      <div style={{ display: "grid", gap: 14 }}>
        {templatesPendingApproval ? (
          <StepNotice tone="warning" title="Meta review is still in progress">
            Template approval usually lands within a few hours and can sometimes
            take up to 48 hours. OrderX will start automation automatically as
            soon as Meta approves the pack.
          </StepNotice>
        ) : templatesApproved ? (
          <StepNotice tone="success" title="Template pack is ready">
            The required English template pack is approved. OrderX can begin
            using your own number as soon as your BYON plan is active.
          </StepNotice>
        ) : null}

        {paymentMethodAdded && !apiConnectionReady ? (
          <StepNotice
            tone="warning"
            title="API connection still needs attention"
          >
            {cloudRegistrationReady && !webhookReady
              ? webhookSubscriptionError ||
                "Meta has not confirmed the WABA webhook subscription yet. Retry after checking the app webhook configuration."
              : cloudRegistrationOutcome === "NEED_RECONNECT"
                ? "This onboarding session expired. Please reconnect your number through Meta Embedded Signup."
                : cloudRegistrationOutcome === "NEED_PIN"
                  ? cloudRegistrationError ||
                    "Enter the existing 6-digit WhatsApp two-step verification PIN for this number, then retry registration."
                  : cloudRegistrationError ||
                    "OrderX is still waiting for Meta to confirm Cloud readiness for this number. Try the retry action only if Meta support confirms registration is still required."}
          </StepNotice>
        ) : null}

        {!computedPlanStepComplete && showPlanStep ? (
          <StepNotice tone="warning" title="Plan selection comes first">
            Choose the BYON plan before asking OrderX to add or refresh the
            template pack.
          </StepNotice>
        ) : null}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 12,
          }}
        >
          {[
            { label: "Total", value: templateSummary.total || 5 },
            { label: "Approved", value: templateSummary.approved },
            { label: "Pending", value: templateSummary.pending },
            { label: "Attention", value: templateSummary.attention },
          ].map((tile) => (
            <div
              key={tile.label}
              style={{
                borderRadius: 16,
                padding: 16,
                border: "1px solid rgba(15, 23, 42, 0.08)",
                background: "#f8fafc",
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "#667085",
                  fontWeight: 700,
                }}
              >
                {tile.label}
              </div>
              <div
                style={{
                  marginTop: 8,
                  fontSize: 24,
                  fontWeight: 800,
                  color: "#101828",
                }}
              >
                {tile.value}
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          {ownTemplates.map((template) => (
            <TemplateRow key={template.key} template={template} />
          ))}
        </div>

        {templateStepError ? (
          <StepNotice tone="critical" title="Template step issue">
            {templateStepError}
          </StepNotice>
        ) : null}

        <StepActions onBack={goBack}>
          {!computedPlanStepComplete && showPlanStep ? null : (
            <>
              <Form method="post">
                <input
                  type="hidden"
                  name="intent"
                  value="byon_templates_sync"
                />
                <s-button
                  type="submit"
                  variant="secondary"
                  {...(submittingIntent === "byon_templates_sync"
                    ? { loading: true }
                    : {})}
                >
                  Refresh template status
                </s-button>
              </Form>
              {paymentMethodAdded && !apiConnectionReady ? (
                <Form method="post" style={{ display: "grid", gap: 10 }}>
                  <input
                    type="hidden"
                    name="intent"
                    value="byon_confirm_payment_method"
                  />
                  {cloudRegistrationOutcome === "NEED_PIN" ? (
                    <label style={formFieldStyles}>
                      <span style={formLabelStyles}>
                        Existing WhatsApp two-step PIN
                      </span>
                      <input
                        type="password"
                        name="registrationPin"
                        inputMode="numeric"
                        pattern="[0-9]{6}"
                        minLength={6}
                        maxLength={6}
                        required
                        autoComplete="off"
                        style={formInputStyles}
                        placeholder="6-digit PIN"
                      />
                    </label>
                  ) : null}
                  <s-button
                    type="submit"
                    variant="primary"
                    {...(submittingIntent === "byon_confirm_payment_method"
                      ? { loading: true }
                      : {})}
                  >
                    Retry Cloud registration
                  </s-button>
                </Form>
              ) : null}
              {!templatePackProvisioned ||
              templateSummary.missing > 0 ||
              templateSummary.attention > 0 ? (
                <Form method="post">
                  <input
                    type="hidden"
                    name="intent"
                    value="byon_templates_provision"
                  />
                  <s-button
                    type="submit"
                    variant="primary"
                    {...(submittingIntent === "byon_templates_provision"
                      ? { loading: true }
                      : {})}
                  >
                    {templatePackProvisioned
                      ? "Repair template pack"
                      : "Add English template pack"}
                  </s-button>
                </Form>
              ) : null}
            </>
          )}
          {dashboardHref &&
          (templatesApproved ||
            templatesPendingApproval ||
            templatePackProvisioned) ? (
            <a href={dashboardHref}>
              <s-button variant="secondary">Go to dashboard</s-button>
            </a>
          ) : null}
          {settingsHref &&
          (templatesApproved ||
            templatesPendingApproval ||
            templatePackProvisioned) ? (
            <a href={settingsHref}>
              <s-button variant="secondary">Settings</s-button>
            </a>
          ) : null}
        </StepActions>
      </div>
    </StepSection>
  );

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {/* {intro && intro} */}
      {/* {intro ? (
        <StepNotice tone="info" title="Your Own Number setup">
          {intro}
        </StepNotice>
      ) : null} */}

      {/* {showStatusHeader ? (
        <SurfaceCard padding="base" soft>
          <div
            style={{
              display: "grid",
              gap: 14,
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            }}
          >
            <div style={{ display: "grid", gap: 6 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 800,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "#667085",
                }}
              >
                Setup status
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <StatusPill label={metaStatus.label} tone={metaStatus.tone} />
                <StatusPill
                  label={paymentStatus.label}
                  tone={paymentStatus.tone}
                />
                <StatusPill
                  label={templatesStatus.label}
                  tone={templatesStatus.tone}
                />
              </div>
            </div>
            <div style={{ display: "grid", gap: 6 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 800,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "#667085",
                }}
              >
                Connected WhatsApp
              </div>
              <div style={{ color: "#101828", fontWeight: 700 }}>
                {ownSender?.displayPhoneNumber ||
                  ownSender?.requestedPhoneNumber ||
                  "Not connected yet"}
              </div>
            </div>
          </div>
        </SurfaceCard>
      ) : null} */}
      <div
        style={{
          // padding: "8px",
          // background: "#f9fafb",
          // border: "1px solid #e5e7eb",
          borderRadius: "10px",
          fontSize: "14px",
          lineHeight: "1.6",
          color: "#374151",
        }}
      >
        Click to{" "}
        <a
          href="https://www.youtube.com/watch?v=eILcNoIuh6w"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: "red",
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          Watch the setup guide video
        </a>
        .
      </div>
      {showProgressTiles ? (
        <Stepper
          steps={steps}
          currentStep={currentStep}
          setCurrentStep={setCurrentStep}
        />
      ) : null}

      {currentStep === "linked_devices" ? renderLinkedDevicesStep() : null}
      {currentStep === "meta" ? renderMetaStep() : null}
      {currentStep === "payment" ? renderPaymentStep() : null}
      {currentStep === "plan" ? renderPlanStep() : null}
      {currentStep === "templates" ? renderTemplatesStep() : null}
    </div>
  );
}
