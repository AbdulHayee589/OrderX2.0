import { useEffect, useMemo, useRef, useState } from "react";
import {
  useActionData,
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigation,
  useRouteError,
  useSubmit,
} from "react-router";
import { Modal, TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { backendGet, backendPost } from "../server/backend.server";
import {
  buildCampaignOrdersRequestKey,
  normalizeCampaignOrderQuery,
  resolveCampaignOrdersView,
} from "../utils/campaignOrderPicker";
import { withShopParams } from "../utils/embedded";

const toArray = (value) => (Array.isArray(value) ? value : []);
const toObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

const DEFAULT_BODY =
  "Hi {{customer_name}},\n\n" +
  "We have an update from {{store_name}} for your order {{order_number}}.\n\n" +
  "Products: {{product_list}}\n" +
  "Total: {{total_price}}\n\n" +
  "Reply using the buttons below if you need help.";

const DEFAULT_BUTTONS = [
  {
    type: "QUICK_REPLY",
    text: "Interested",
    responseText: "Thanks. Our team will contact you shortly.",
    tag: "CAMPAIGN_INTERESTED",
    url: "",
  },
];

function createEmptyCampaignDraft() {
  return {
    templateId: "",
    displayName: "Campaign Message",
    language: "en",
    headerType: "TEXT",
    headerText: "Special update",
    sampleMediaUrl: "",
    useProductImageHeader: true,
    bodyText: DEFAULT_BODY,
    footerText: "",
    buttons: DEFAULT_BUTTONS.map((button, index) => cleanButton(button, index)),
  };
}

const CAMPAIGN_VARIABLES = [
  { key: "customer_name", label: "Customer name", sample: "Abdul" },
  { key: "store_name", label: "Store name", sample: "OrderX Store" },
  { key: "order_number", label: "Order number", sample: "#10321" },
  { key: "product_name", label: "Product name", sample: "Classic T-Shirt" },
  {
    key: "product_list",
    label: "Product list",
    sample: "2x T-shirt, 1x Shoes",
  },
  { key: "total_price", label: "Total price", sample: "PKR 3,250" },
  {
    key: "delivery_address",
    label: "Delivery address",
    sample: "123 Main Street, Lahore",
  },
  {
    key: "product_url",
    label: "Product URL",
    sample: "https://example.com/products/classic-t-shirt",
  },
  {
    key: "support_whatsapp_number",
    label: "Support WhatsApp",
    sample: "+923001234567",
  },
  { key: "courier_name", label: "Courier name", sample: "Leopards" },
  {
    key: "tracking_number",
    label: "Tracking number",
    sample: "LP123456789",
  },
  {
    key: "tracking_url",
    label: "Tracking URL",
    sample: "https://track.example/LP123456789",
  },
  {
    key: "cancel_reason",
    label: "Cancel reason",
    sample: "Customer requested cancellation",
  },
  { key: "update_title", label: "Update title", sample: "Delivery delayed" },
  {
    key: "update_details",
    label: "Update details",
    sample: "Your parcel is delayed due to weather conditions.",
  },
  {
    key: "review_url",
    label: "Review URL",
    sample: "https://example.com/review/123",
  },
  {
    key: "checkout_url",
    label: "Checkout URL",
    sample: "https://store.myshopify.com/checkouts/abc123",
  },
  {
    key: "abandoned_minutes",
    label: "Minutes abandoned",
    sample: "90",
  },
];

const CAMPAIGN_VARIABLE_KEYS = new Set(
  CAMPAIGN_VARIABLES.map((variable) => variable.key),
);
const CUSTOM_RECIPIENT_SAFE_VARIABLES = new Set([
  "store_name",
  "support_whatsapp_number",
]);
const VARIABLE_SAMPLES = Object.fromEntries(
  CAMPAIGN_VARIABLES.map((variable) => [variable.key, variable.sample]),
);
const VARIABLE_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const RTL_LANGUAGE_BASES = new Set([
  "ar",
  "fa",
  "he",
  "iw",
  "ur",
  "ps",
  "sd",
  "ku",
  "ug",
  "yi",
]);

function extractVariables(text = "") {
  const found = [];
  String(text || "").replace(VARIABLE_RE, (_match, key) => {
    found.push(String(key || "").trim());
    return "";
  });
  return found;
}

function getTemplateVariableKeys(template = {}) {
  return Array.from(
    new Set(
      [
        ...extractVariables(
          template?.headerText || template?.preview?.header || "",
        ),
        ...extractVariables(
          template?.bodyText || template?.preview?.body || "",
        ),
        ...toArray(template?.buttons).flatMap((button) =>
          String(button?.type || "")
            .trim()
            .toUpperCase() === "URL"
            ? extractVariables(button?.url || "")
            : [],
        ),
      ]
        .map((key) =>
          String(key || "")
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  );
}

function getOrderDependentTemplateVariables(template = {}) {
  return getTemplateVariableKeys(template).filter(
    (key) => !CUSTOM_RECIPIENT_SAFE_VARIABLES.has(key),
  );
}

function hasBadVariablePlacement(text = "") {
  const value = String(text || "");
  if (!value.trim()) return false;
  return (
    /^\s*\{\{\s*[a-zA-Z0-9_]+\s*\}\}/.test(value) ||
    /\{\{\s*[a-zA-Z0-9_]+\s*\}\}\s*$/.test(value)
  );
}

function hasDuplicateVariables(text = "") {
  const counts = new Map();
  for (const key of extractVariables(text)) {
    counts.set(key, Number(counts.get(key) || 0) + 1);
  }
  return Array.from(counts.values()).some((count) => count > 1);
}

function normalizeLanguageCode(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
}

function getTemplateTextDirection(language, text = "") {
  const normalizedLanguage = normalizeLanguageCode(language);
  const languageBase = normalizedLanguage.split("-")[0] || "";
  if (RTL_LANGUAGE_BASES.has(languageBase)) return "rtl";
  if (/[\u0590-\u08FF]/u.test(String(text || ""))) return "rtl";
  return "ltr";
}

function ownSenderStatusMeta(status) {
  switch (String(status || "").trim()) {
    case "ready":
      return { label: "Ready", tone: "success" };
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
      return { label: "Not connected", tone: "warning" };
  }
}

function resolvePreviewText(text = "") {
  return String(text || "").replace(VARIABLE_RE, (_match, key) => {
    return VARIABLE_SAMPLES[key] || `{{${key}}}`;
  });
}

function renderPreviewNodes(text = "") {
  const resolved = resolvePreviewText(text);
  if (!String(resolved || "").trim()) return [];
  let counter = 0;
  const nextKey = (prefix) => `${prefix}-${counter++}`;
  const parseResolved = (input) => {
    const nodes = [];
    let index = 0;
    let plainStart = 0;
    const flushPlain = (end) => {
      if (end > plainStart) nodes.push(input.slice(plainStart, end));
    };
    while (index < input.length) {
      if (input.startsWith("```", index)) {
        const end = input.indexOf("```", index + 3);
        if (end !== -1) {
          flushPlain(index);
          nodes.push(
            <span
              key={nextKey("mono")}
              style={{
                fontFamily:
                  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
                background: "rgba(15,23,42,0.05)",
                borderRadius: 4,
                padding: "0 4px",
              }}
            >
              {input.slice(index + 3, end)}
            </span>,
          );
          index = end + 3;
          plainStart = index;
          continue;
        }
      }

      const marker = input[index];
      if (marker === "*" || marker === "_" || marker === "~") {
        const end = input.indexOf(marker, index + 1);
        if (end !== -1) {
          flushPlain(index);
          const inner = input.slice(index + 1, end);
          const style =
            marker === "*"
              ? { fontWeight: 800 }
              : marker === "_"
                ? { fontStyle: "italic" }
                : { textDecoration: "line-through" };
          nodes.push(
            <span key={nextKey("fmt")} style={style}>
              {parseResolved(inner)}
            </span>,
          );
          index = end + 1;
          plainStart = index;
          continue;
        }
      }

      index += 1;
    }
    flushPlain(input.length);
    return nodes;
  };

  return parseResolved(resolved);
}

function isHttpsUrl(value = "") {
  return /^https:\/\/\S+/i.test(String(value || "").trim());
}

function getCampaignTemplateChecks(draft = {}) {
  const headerType = String(draft.headerType || "NONE").toUpperCase();
  const bodyText = String(draft.bodyText || "");
  const headerText = String(draft.headerText || "");
  const footerText = String(draft.footerText || "");
  const buttons = toArray(draft.buttons).map(cleanButton);
  const allVariables = [
    ...extractVariables(headerType === "TEXT" ? headerText : ""),
    ...extractVariables(bodyText),
    ...buttons.flatMap((button) =>
      button.type === "URL" ? extractVariables(button.url) : [],
    ),
  ];
  const unsupported = allVariables.filter(
    (key) => !CAMPAIGN_VARIABLE_KEYS.has(key),
  );
  const urlButtonCount = buttons.filter(
    (button) => button.type === "URL",
  ).length;

  return [
    {
      ok: String(draft.displayName || "").trim().length > 0,
      label: "Template name is added",
      help: "Used only inside OrderX.",
    },
    {
      ok: String(draft.language || "").trim().length > 0,
      label: "Language is selected",
      help: "This becomes the Meta template language.",
    },
    {
      ok:
        headerType !== "TEXT" ||
        (headerText.trim().length > 0 &&
          headerText.length <= 60 &&
          !hasBadVariablePlacement(headerText) &&
          !hasDuplicateVariables(headerText)),
      label: "Header follows Meta rules",
      help: "Text headers must be 60 characters or less. Variables cannot be first, last, or repeated.",
    },
    {
      ok: headerType !== "IMAGE" || isHttpsUrl(draft.sampleMediaUrl),
      label: "Image header has a sample URL",
      help: "Meta needs a public https JPG or PNG sample before review.",
    },
    {
      ok:
        bodyText.trim().length > 0 &&
        bodyText.length <= 1024 &&
        !hasBadVariablePlacement(bodyText) &&
        !hasDuplicateVariables(bodyText),
      label: "Body follows Meta rules",
      help: "Body must be 1-1024 characters. Variables cannot be first, last, or repeated.",
    },
    {
      ok: footerText.length <= 60 && extractVariables(footerText).length === 0,
      label: "Footer is valid",
      help: "Footer is optional, max 60 characters, and cannot contain variables.",
    },
    {
      ok: !unsupported.length,
      label: "Only supported variables are used",
      help: unsupported.length
        ? `Unsupported: ${Array.from(new Set(unsupported)).join(", ")}`
        : "All variables can be filled from selected orders.",
    },
    {
      ok:
        buttons.length <= 10 &&
        urlButtonCount <= 2 &&
        buttons.every((button) => {
          const textOk =
            String(button.text || "").trim().length > 0 &&
            String(button.text || "").length <= 25;
          if (button.type !== "URL") return textOk;
          return textOk && isHttpsUrl(button.url);
        }),
      label: "Buttons are ready",
      help: "Meta allows up to 10 buttons, up to 2 URL buttons. Button text max is 25 characters.",
    },
  ];
}

function insertTokenAtCursor({ ref, field, token, setDraft }) {
  const safeToken = `{{${String(token || "").trim()}}}`;
  setDraft((current) => {
    const currentText = String(current?.[field] || "");
    const el = ref?.current;
    const start =
      el && typeof el.selectionStart === "number"
        ? Number(el.selectionStart)
        : currentText.length;
    const end =
      el && typeof el.selectionEnd === "number"
        ? Number(el.selectionEnd)
        : start;
    const before = currentText.slice(0, start);
    const after = currentText.slice(end);
    const prefix = before && !/\s$/.test(before) ? " " : "";
    const suffix = after && !/^\s/.test(after) ? " " : "";
    const nextText = `${before}${prefix}${safeToken}${suffix}${after}`;
    const cursor =
      before.length + prefix.length + safeToken.length + suffix.length;
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(cursor, cursor);
    });
    return { ...current, [field]: nextText };
  });
}

function replaceSelection({
  ref,
  value,
  onChange,
  buildText,
  getCursorOffset,
}) {
  const currentText = String(value || "");
  const el = ref?.current || null;
  const start =
    el && typeof el.selectionStart === "number"
      ? Number(el.selectionStart)
      : currentText.length;
  const end =
    el && typeof el.selectionEnd === "number" ? Number(el.selectionEnd) : start;
  const next = buildText(currentText, start, end);
  onChange(next);
  requestAnimationFrame(() => {
    if (!el) return;
    const cursor = getCursorOffset ? getCursorOffset(start, end, next) : start;
    el.focus();
    el.setSelectionRange(cursor, cursor);
  });
}

function applyWrapToSelection({
  ref,
  value,
  onChange,
  prefix,
  suffix = prefix,
}) {
  replaceSelection({
    ref,
    value,
    onChange,
    buildText: (text, start, end) => {
      const selected = text.slice(start, end) || "text";
      return `${text.slice(0, start)}${prefix}${selected}${suffix}${text.slice(end)}`;
    },
    getCursorOffset: (start, end) => {
      const selectedLength = Math.max(0, end - start) || 4;
      return start + prefix.length + selectedLength;
    },
  });
}

function insertTextAtSelection({ ref, value, onChange, text }) {
  replaceSelection({
    ref,
    value,
    onChange,
    buildText: (current, start, end) =>
      `${current.slice(0, start)}${text}${current.slice(end)}`,
    getCursorOffset: (start) => start + String(text || "").length,
  });
}

function templateStatus(template) {
  return String(template?.status || template?.rawStatus || "draft")
    .trim()
    .toLowerCase();
}

function isApproved(template) {
  return templateStatus(template) === "approved";
}

function isTested(template) {
  const status = String(template?.testMessageStatus || "")
    .trim()
    .toLowerCase();
  return (
    !!template?.testMessageSentAt &&
    !template?.testMessageLastError &&
    ["accepted", "sent", "delivered", "read"].includes(status || "accepted")
  );
}

function statusLabel(template) {
  const status = templateStatus(template);
  if (status === "in_review") return "In review";
  if (status === "approved") return "Approved";
  if (status === "pending") return "Pending";
  if (status === "rejected") return "Rejected";
  if (status === "missing") return "Missing";
  return "Draft";
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizeCustomPhone(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const cleaned = raw.replace(/[^\d+]/g, "");
  if (cleaned.startsWith("+"))
    return `+${cleaned.slice(1).replace(/[^\d]/g, "")}`;
  return cleaned.replace(/[^\d]/g, "");
}

function isValidCustomPhone(value = "") {
  return /^\+[1-9]\d{7,14}$/.test(String(value || "").trim());
}

function parseCustomPhoneInput(value = "") {
  return Array.from(
    new Set(
      String(value || "")
        .split(/[\n,\t; ]+/)
        .map((part) => normalizeCustomPhone(part))
        .filter(Boolean),
    ),
  );
}

function cleanButton(button = {}, index = 0) {
  const type = String(button.type || "QUICK_REPLY").toUpperCase();
  return {
    type: type === "URL" ? "URL" : "QUICK_REPLY",
    text: String(button.text || "").slice(0, 25),
    url: String(button.url || ""),
    responseText: String(button.responseText || ""),
    tag: String(button.tag || ""),
    action: String(button.action || `campaign_button_${index}`),
  };
}

function hydrateCampaignDraft(template = {}) {
  return {
    templateId: String(template?.id || "").trim(),
    displayName:
      String(template?.displayName || "").trim() || "Campaign Message",
    language: String(template?.language || "en").trim() || "en",
    headerType: String(template?.headerType || "TEXT").trim() || "TEXT",
    headerText: String(template?.headerText || "").trim(),
    sampleMediaUrl: String(template?.sampleMediaUrl || "").trim(),
    useProductImageHeader: template?.useProductImageHeader !== false,
    bodyText: String(template?.bodyText || DEFAULT_BODY),
    footerText: String(template?.footerText || ""),
    buttons: toArray(template?.buttons).map(cleanButton),
  };
}

function normalizeTemplatePreviewModel(template = {}) {
  const headerType = String(
    template?.headerType || template?.preview?.headerType || "NONE",
  )
    .trim()
    .toUpperCase();
  return {
    headerType,
    headerText:
      String(template?.preview?.header || "").trim() ||
      String(template?.headerText || "").trim(),
    bodyText:
      String(template?.preview?.body || "").trim() ||
      String(template?.bodyText || "").trim(),
    footerText:
      String(template?.preview?.footer || "").trim() ||
      String(template?.footerText || "").trim(),
    sampleMediaUrl: String(
      template?.preview?.sampleMediaUrl || template?.sampleMediaUrl || "",
    ).trim(),
    buttons: toArray(template?.buttons).map(cleanButton),
    language:
      String(template?.language || template?.languageCode || "").trim() || "en",
  };
}

function getPreviewButtonLayout(buttons = []) {
  const cleanButtons = toArray(buttons).map(cleanButton);
  if (cleanButtons.length <= 3) {
    return {
      visibleButtons: cleanButtons,
      overflowCount: 0,
      hasOverflow: false,
    };
  }
  return {
    visibleButtons: [
      cleanButtons[0],
      cleanButtons[1],
      {
        type: "OVERFLOW",
        text: "See all options",
        action: "overflow",
      },
    ].filter(Boolean),
    overflowCount: cleanButtons.length - 2,
    hasOverflow: true,
  };
}

function templateIdentityKey(template = {}) {
  const metaTemplateId = String(template?.metaTemplateId || "").trim();
  if (metaTemplateId) return `meta:${metaTemplateId}`;
  return [
    "name",
    String(template?.metaTemplateName || "")
      .trim()
      .toLowerCase(),
    String(template?.language || "")
      .trim()
      .toLowerCase(),
  ].join("|");
}

function templatePriorityScore(template = {}) {
  const source = String(template?.source || "").trim();
  return (
    (source !== "meta_library" ? 20 : 0) +
    (isApproved(template) ? 8 : 0) +
    (isTested(template) ? 6 : 0) +
    (source === "default_pack" ? 2 : 0)
  );
}

function mergeTemplateLibrary(...collections) {
  const byIdentity = new Map();
  for (const template of collections.flatMap((items) => toArray(items))) {
    const identity = templateIdentityKey(template);
    const current = byIdentity.get(identity);
    if (
      !current ||
      templatePriorityScore(template) > templatePriorityScore(current)
    ) {
      byIdentity.set(identity, template);
    }
  }
  return Array.from(byIdentity.values()).sort((a, b) => {
    const statusWeight = Number(isApproved(b)) - Number(isApproved(a));
    if (statusWeight) return statusWeight;
    const aTime = new Date(a?.updatedAt || a?.createdAt || 0).getTime();
    const bTime = new Date(b?.updatedAt || b?.createdAt || 0).getTime();
    return bTime - aTime;
  });
}

function canSubmitTemplate(template = {}) {
  if (String(template?.source || "").trim() === "meta_library") return false;
  return ["draft", "rejected", "missing"].includes(templateStatus(template));
}

function getTemplateOriginLabel(template = {}) {
  if (String(template?.source || "").trim() === "meta_library") {
    return "Imported from Meta";
  }
  if (String(template?.flowKey || "").trim() === "campaign") {
    return "Campaign template";
  }
  return String(template?.flowLabel || "Automation template").trim();
}

function getTemplateLastActivity(template = {}) {
  return (
    template?.updatedAt ||
    template?.lastSyncedAt ||
    template?.submittedAt ||
    template?.approvedAt ||
    template?.createdAt ||
    null
  );
}

function buildTemplateSearchText(template = {}) {
  return [
    template?.displayName,
    template?.flowLabel,
    template?.metaTemplateName,
    template?.languageLabel,
    template?.category,
    getTemplateOriginLabel(template),
    template?.headerText,
    template?.bodyText,
    template?.footerText,
  ]
    .map((value) =>
      String(value || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean)
    .join(" ");
}

function getTemplateActionState(
  template = {},
  {
    busy = false,
    templateManagementAllowed = true,
    senderCapabilities = {},
  } = {},
) {
  const approved = isApproved(template);
  const tested = isTested(template);
  const waiting = isWaitingOnMeta(template);
  const isDraft = templateStatus(template) === "draft";
  const canSubmit = canSubmitTemplate(template);
  const submitAllowed =
    senderCapabilities.submitAllowed ?? templateManagementAllowed;
  const testAllowed =
    senderCapabilities.testAllowed ?? templateManagementAllowed;
  const sendAllowed =
    senderCapabilities.sendAllowed ?? templateManagementAllowed;
  const submitBlockedReason = String(
    senderCapabilities.submitBlockedReason || "",
  ).trim();
  const testBlockedReason = String(
    senderCapabilities.testBlockedReason || "",
  ).trim();
  const sendBlockedReason = String(
    senderCapabilities.sendBlockedReason || "",
  ).trim();

  const submitDisabledReason = !templateManagementAllowed
    ? "Connect Your Own Number first so this campaign template can be submitted to your Meta account."
    : !submitAllowed
      ? submitBlockedReason ||
        "Connect Meta first before submitting campaign templates."
    : busy
      ? "Please wait for the current action to finish."
      : waiting
        ? "This template is already under review in Meta."
        : approved
          ? "This template is already approved in Meta."
          : !canSubmit
            ? "Imported Meta templates cannot be submitted from OrderX."
            : "";

  const testDisabledReason = !templateManagementAllowed
    ? "Connect Your Own Number first so this template can be tested."
    : !testAllowed
      ? testBlockedReason ||
        "Finish connecting your own WhatsApp number before testing campaign templates."
    : busy
      ? "Please wait for the current action to finish."
      : !approved
        ? "Only Meta-approved templates can be tested."
        : "";

  const sendDisabledReason = !templateManagementAllowed
    ? "Connect Your Own Number first so this template can be used in a campaign."
    : !sendAllowed
      ? sendBlockedReason ||
        "Finish connecting your own WhatsApp number before launching campaigns."
    : busy
      ? "Please wait for the current action to finish."
      : !approved
        ? "Only Meta-approved templates can be used in a campaign."
        : !tested
          ? "Send one successful test first, then this template becomes ready for campaigns."
          : "";

  return {
    approved,
    tested,
    waiting,
    isDraft,
    canSubmit,
    submitDisabledReason,
    testDisabledReason,
    sendDisabledReason,
  };
}

function isWaitingOnMeta(template = {}) {
  return ["pending", "in_review"].includes(templateStatus(template));
}

function TooltipButton({
  title = "",
  disabled = false,
  className = "",
  children,
  ...props
}) {
  const tooltip = String(title || "").trim();
  if (!disabled) {
    return (
      <button className={className} disabled={disabled} {...props}>
        {children}
      </button>
    );
  }
  return (
    <span className="tooltip-wrap" title={tooltip}>
      <button className={className} disabled={disabled} {...props}>
        {children}
      </button>
    </span>
  );
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const [templateResponse, campaignLibraryResponse, campaignRunsResponse] =
    await Promise.all([
      backendGet("/api/templates", shop).catch(() => ({
        templateSystem: {},
      })),
      backendGet("/api/campaigns/templates", shop).catch(() => ({
        templates: [],
        templateManagementAllowed: false,
        updatedAt: null,
        sender: {},
      })),
      backendGet("/api/campaigns/runs", shop).catch(() => ({
        runs: [],
        summary: {},
      })),
    ]);
  return {
    templateSystem: toObject(toObject(templateResponse).templateSystem),
    campaignLibrary: {
      templates: toArray(toObject(campaignLibraryResponse).templates),
      templateManagementAllowed:
        toObject(campaignLibraryResponse).templateManagementAllowed === true,
      updatedAt: toObject(campaignLibraryResponse).updatedAt || null,
      sender: toObject(toObject(campaignLibraryResponse).sender),
    },
    campaignRuns: {
      runs: toArray(toObject(campaignRunsResponse).runs),
      summary: toObject(campaignRunsResponse).summary,
    },
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") || "").trim();

  try {
    if (intent === "save_campaign_template") {
      const buttons = JSON.parse(String(form.get("buttons") || "[]"));
      await backendPost("/api/templates/save", shop, {
        templateId: String(form.get("templateId") || "").trim() || null,
        flowKey: "campaign",
        displayName: String(
          form.get("displayName") || "Campaign Message",
        ).trim(),
        headerType: String(form.get("headerType") || "TEXT").trim(),
        headerText: String(form.get("headerText") || "").trim(),
        sampleMediaUrl: String(form.get("sampleMediaUrl") || "").trim(),
        useProductImageHeader:
          String(form.get("useProductImageHeader") || "") === "true",
        bodyText: String(form.get("bodyText") || "").trim(),
        footerText: String(form.get("footerText") || "").trim(),
        buttons,
        category: "UTILITY",
        language: String(form.get("language") || "en").trim(),
      });
      return { ok: true, intent, note: "Campaign template draft saved" };
    }

    if (intent === "submit_template") {
      await backendPost("/api/templates/submit", shop, {
        templateId: String(form.get("templateId") || "").trim(),
      });
      return { ok: true, intent, note: "Template sent to Meta for review" };
    }

    if (intent === "send_template_test") {
      await backendPost("/api/campaigns/templates/send-test", shop, {
        templateId: String(form.get("templateId") || "").trim(),
        to: String(form.get("to") || "").trim(),
      });
      return { ok: true, intent, note: "Test message sent" };
    }

    if (intent === "refresh_templates") {
      const response = await backendPost(
        "/api/campaigns/templates/refresh",
        shop,
        {},
      );
      return {
        ok: true,
        intent,
        note: `Imported ${response?.importedCount || 0} supported Meta templates`,
      };
    }

    if (intent === "delete_template") {
      await backendPost("/api/templates/delete", shop, {
        templateId: String(form.get("templateId") || "").trim(),
      });
      return { ok: true, intent, note: "Draft template deleted" };
    }

    if (intent === "send_campaign") {
      const response = await backendPost("/api/campaigns/send", shop, {
        templateId: String(form.get("templateId") || "").trim(),
        orderGids: JSON.parse(String(form.get("orderGids") || "[]")),
        customRecipients: JSON.parse(
          String(form.get("customRecipients") || "[]"),
        ),
        scheduleMode: String(form.get("scheduleMode") || "immediate").trim(),
        scheduledFor: String(form.get("scheduledFor") || "").trim(),
      });
      const summary = toObject(response?.summary);
      const sent = Number(summary?.sent || 0);
      const failed = Number(summary?.failed || 0);
      const skipped = Number(summary?.skipped || 0);
      const skippedNote = skipped
        ? `, ${skipped} duplicate${skipped === 1 ? "" : "s"} skipped`
        : "";
      return {
        ok: true,
        intent,
        note: response?.scheduled
          ? `Campaign scheduled for ${formatDate(
              response?.run?.scheduledFor || new Date(),
            )}`
          : response?.queued
            ? `Campaign queued for ${Number(summary?.selected || 0)} recipient${Number(summary?.selected || 0) === 1 ? "" : "s"}${skippedNote}`
          : `Campaign sent: ${sent} sent, ${failed} failed${skippedNote}`,
        campaignResult: response,
      };
    }

    if (intent === "retry_campaign_recipient") {
      const response = await backendPost(
        "/api/campaigns/runs/retry-recipient",
        shop,
        {
          runId: String(form.get("runId") || "").trim(),
          recipientId: String(form.get("recipientId") || "").trim(),
        },
      );
      return {
        ok: true,
        intent,
        note: "Campaign recipient retried",
        run: response?.run || null,
      };
    }

    return { ok: false, intent, error: "Unknown action" };
  } catch (error) {
    return {
      ok: false,
      intent,
      error: error?.message || "Action failed",
      errorData: error?.data || null,
    };
  }
};

export default function CompaignsPage() {
  const { templateSystem, campaignLibrary, campaignRuns } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const location = useLocation();
  const submit = useSubmit();
  const shopify = useAppBridge();
  const ordersFetcher = useFetcher();
  const loadOrders = ordersFetcher.load;
  const campaignRunsFetcher = useFetcher();
  const loadCampaignRuns = campaignRunsFetcher.load;
  const headerInputRef = useRef(null);
  const bodyInputRef = useRef(null);

  const templates = toArray(templateSystem?.templates);
  const importedTemplates = toArray(campaignLibrary?.templates);
  const languageOptions = toArray(templateSystem?.languageOptions);
  const campaignTemplates = templates.filter(
    (template) => String(template?.flowKey || "") === "campaign",
  );
  const campaignPageTemplates = useMemo(
    () =>
      mergeTemplateLibrary(
        campaignTemplates,
        templates.filter(isApproved),
        importedTemplates,
      ),
    [campaignTemplates, importedTemplates, templates],
  );
  const templateManagementAllowed =
    templateSystem?.templateManagementAllowed === true;
  const campaignSender = toObject(campaignLibrary?.sender);
  const campaignSenderStatus = String(
    campaignSender?.status || "not_started",
  ).trim();
  const campaignSenderStatusView = ownSenderStatusMeta(campaignSenderStatus);
  const campaignHasMetaConnection = Boolean(
    String(campaignSender?.wabaId || "").trim(),
  );
  const campaignHasPhoneConnection = Boolean(
    String(campaignSender?.phoneNumberId || "").trim() ||
      String(campaignSender?.displayPhoneNumber || "").trim(),
  );
  const campaignSubmitAllowed =
    templateManagementAllowed && campaignHasMetaConnection;
  const campaignSendReady =
    templateManagementAllowed &&
    campaignSenderStatus === "ready" &&
    campaignHasMetaConnection &&
    campaignHasPhoneConnection;
  const refreshTemplatesAllowed =
    templateManagementAllowed && campaignHasMetaConnection;
  const senderCapabilities = {
    submitAllowed: campaignSubmitAllowed,
    testAllowed: campaignSendReady,
    sendAllowed: campaignSendReady,
    submitBlockedReason: templateManagementAllowed
      ? "You can keep drafting campaign templates, but connect Meta first before submitting them for approval."
      : "",
    testBlockedReason: templateManagementAllowed
      ? campaignHasMetaConnection
        ? "Your Own Number setup is not ready yet. Finish WhatsApp connection and wait for the sender to show Ready before testing."
        : "Connect Meta and your WhatsApp number first before sending campaign tests."
      : "",
    sendBlockedReason: templateManagementAllowed
      ? campaignHasMetaConnection
        ? "Your Own Number setup is not ready yet. Finish WhatsApp connection and wait for the sender to show Ready before launching campaigns."
        : "Connect Meta and your WhatsApp number first before launching campaigns."
      : "",
  };
  const isSubmitting = navigation.state !== "idle";

  const [createOpen, setCreateOpen] = useState(false);
  const [ordersOpen, setOrdersOpen] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [testPhone, setTestPhone] = useState("");
  const [orderQuery, setOrderQuery] = useState("");
  const [debouncedOrderQuery, setDebouncedOrderQuery] = useState("");
  const [ordersSessionKey, setOrdersSessionKey] = useState(0);
  const [afterCursor, setAfterCursor] = useState("");
  const [cursorStack, setCursorStack] = useState([]);
  const [selectedOrders, setSelectedOrders] = useState([]);
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [customRecipientInput, setCustomRecipientInput] = useState("");
  const [customRecipients, setCustomRecipients] = useState([]);
  const [scheduleMode, setScheduleMode] = useState("immediate");
  const [scheduledAtInput, setScheduledAtInput] = useState("");
  const [campaignModalStep, setCampaignModalStep] = useState(1);
  const [templateTab, setTemplateTab] = useState("all");
  const [templateSearch, setTemplateSearch] = useState("");
  const [templateStatusFilter, setTemplateStatusFilter] = useState("all");
  const [templatePage, setTemplatePage] = useState(1);
  const [expandedRunIds, setExpandedRunIds] = useState([]);
  const [detailsTemplate, setDetailsTemplate] = useState(null);
  const [draft, setDraft] = useState(createEmptyCampaignDraft);

  const draftDirection = useMemo(
    () =>
      getTemplateTextDirection(
        draft.language,
        `${draft.headerText || ""} ${draft.bodyText || ""} ${draft.footerText || ""}`,
      ),
    [draft.bodyText, draft.footerText, draft.headerText, draft.language],
  );
  const draftAlign = draftDirection === "rtl" ? "right" : "left";

  const normalizedOrderQuery = normalizeCampaignOrderQuery(orderQuery);
  const orderSearchPending =
    ordersOpen && normalizedOrderQuery !== debouncedOrderQuery;
  const expectedOrdersRequestKey = buildCampaignOrdersRequestKey({
    sessionKey: ordersSessionKey,
    query: debouncedOrderQuery,
    after: afterCursor,
  });
  const ordersView = resolveCampaignOrdersView({
    data: ordersFetcher.data,
    expectedRequestKey: expectedOrdersRequestKey,
    fetcherState: ordersFetcher.state,
    searchPending: orderSearchPending,
  });
  const orders = ordersOpen ? ordersView.orders : [];
  const pageInfo = ordersOpen ? ordersView.pageInfo : {};
  const ordersLoading = ordersOpen && ordersView.loading;
  const ordersError = ordersOpen ? ordersView.error : "";
  const selectedTemplate = campaignPageTemplates.find(
    (template) => String(template?.id || "") === selectedTemplateId,
  );
  const refreshedCampaignRuns = toObject(
    campaignRunsFetcher.data?.campaignRuns,
  );
  const loaderCampaignRunTime = new Date(
    toArray(campaignRuns?.runs)?.[0]?.updatedAt ||
      toArray(campaignRuns?.runs)?.[0]?.createdAt ||
      0,
  ).getTime();
  const refreshedCampaignRunTime = new Date(
    toArray(refreshedCampaignRuns?.runs)?.[0]?.updatedAt ||
      toArray(refreshedCampaignRuns?.runs)?.[0]?.createdAt ||
      0,
  ).getTime();
  const activeCampaignRuns =
    Array.isArray(refreshedCampaignRuns?.runs) &&
    refreshedCampaignRunTime >= loaderCampaignRunTime
      ? refreshedCampaignRuns
      : campaignRuns;
  const campaignRunList = toArray(activeCampaignRuns?.runs);
  const campaignRunSummary = toObject(activeCampaignRuns?.summary);
  const campaignRunPollingActive = campaignRunList.some((run) => {
    if (String(run?.status || "") === "processing") return true;
    const createdAt = new Date(run?.createdAt || 0).getTime();
    const recentlyCreated =
      Number.isFinite(createdAt) && Date.now() - createdAt < 2 * 60_000;
    return (
      recentlyCreated &&
      Number(run?.sentCount || 0) > Number(run?.deliveredCount || 0)
    );
  });
  const campaignChecks = useMemo(
    () => getCampaignTemplateChecks(draft),
    [draft],
  );
  const canSaveCampaignDraft = campaignChecks.every((check) => check.ok);
  const approvedTemplateCount = campaignPageTemplates.filter(isApproved).length;
  const testedTemplateCount = campaignPageTemplates.filter(isTested).length;
  const draftTemplateCount = campaignPageTemplates.filter(
    (template) => templateStatus(template) === "draft",
  ).length;
  const archivedTemplateCount = campaignPageTemplates.filter((template) =>
    ["rejected", "missing"].includes(templateStatus(template)),
  ).length;
  const filteredTemplates = useMemo(() => {
    const query = String(templateSearch || "")
      .trim()
      .toLowerCase();
    return campaignPageTemplates.filter((template) => {
      const status = templateStatus(template);
      const tested = isTested(template);
      const approved = isApproved(template);
      const tabMatch =
        templateTab === "all"
          ? true
          : templateTab === "active"
            ? approved
            : templateTab === "tested"
              ? tested
              : templateTab === "drafts"
                ? status === "draft"
                : ["rejected", "missing"].includes(status);
      const statusMatch =
        templateStatusFilter === "all"
          ? true
          : templateStatusFilter === "ready"
            ? approved && tested
            : templateStatusFilter === "approved"
              ? approved
              : status === templateStatusFilter;
      const searchMatch = query
        ? buildTemplateSearchText(template).includes(query)
        : true;
      return tabMatch && statusMatch && searchMatch;
    });
  }, [
    campaignPageTemplates,
    templateSearch,
    templateTab,
    templateStatusFilter,
  ]);
  const sortedTemplates = useMemo(() => {
    return [...filteredTemplates].sort((left, right) => {
      const leftReady = Number(isApproved(left) && isTested(left));
      const rightReady = Number(isApproved(right) && isTested(right));
      if (rightReady !== leftReady) return rightReady - leftReady;

      const leftApproved = Number(isApproved(left));
      const rightApproved = Number(isApproved(right));
      if (rightApproved !== leftApproved) return rightApproved - leftApproved;

      const leftDraft = Number(templateStatus(left) === "draft");
      const rightDraft = Number(templateStatus(right) === "draft");
      if (rightDraft !== leftDraft) return rightDraft - leftDraft;

      const leftActivity = new Date(
        getTemplateLastActivity(left) || 0,
      ).getTime();
      const rightActivity = new Date(
        getTemplateLastActivity(right) || 0,
      ).getTime();
      return rightActivity - leftActivity;
    });
  }, [filteredTemplates]);
  const templatesPerPage = 12;
  const templatePageCount = Math.max(
    1,
    Math.ceil(sortedTemplates.length / templatesPerPage),
  );
  const paginatedTemplates = useMemo(() => {
    const start = (templatePage - 1) * templatesPerPage;
    return sortedTemplates.slice(start, start + templatesPerPage);
  }, [sortedTemplates, templatePage]);
  const selectedTemplateOrderDependentVariables = useMemo(
    () => getOrderDependentTemplateVariables(selectedTemplate || {}),
    [selectedTemplate],
  );
  const pendingCustomRecipients = useMemo(
    () => parseCustomPhoneInput(customRecipientInput),
    [customRecipientInput],
  );
  const customRecipientsBlockedByVariables =
    customRecipients.length > 0 &&
    selectedTemplateOrderDependentVariables.length > 0;
  const invalidCustomRecipients = useMemo(
    () => customRecipients.filter((phone) => !isValidCustomPhone(phone)),
    [customRecipients],
  );
  const scheduledDate =
    scheduleMode === "scheduled" && scheduledAtInput
      ? new Date(scheduledAtInput)
      : null;
  const scheduledAtIso =
    scheduledDate && Number.isFinite(scheduledDate.getTime())
      ? scheduledDate.toISOString()
      : "";
  const scheduledAtValid =
    scheduleMode !== "scheduled" ||
    (scheduledAtInput &&
      scheduledDate &&
      Number.isFinite(scheduledDate.getTime()) &&
      scheduledDate.getTime() > Date.now() + 30_000);
  const selectedOrderCount = selectedOrders.length;
  const selectedRecipientCount = selectedOrderCount + customRecipients.length;
  const canSendCampaignNow =
    (selectedOrderCount > 0 || customRecipients.length > 0) &&
    !invalidCustomRecipients.length &&
    !customRecipientsBlockedByVariables &&
    scheduledAtValid &&
    campaignSendReady &&
    !isSubmitting;
  const sendCampaignDisabledReason =
    !selectedOrderCount && !customRecipients.length
      ? "Select at least one order or add one custom number first."
      : invalidCustomRecipients.length
        ? "Fix invalid custom numbers first. Use E.164 format like +923001234567."
        : customRecipientsBlockedByVariables
          ? `This template needs order data: ${selectedTemplateOrderDependentVariables.join(", ")}. Remove custom numbers or use a template without order-linked variables.`
          : !campaignSendReady
            ? senderCapabilities.sendBlockedReason
          : !scheduledAtValid
            ? "Choose a future schedule time at least 1 minute ahead."
            : isSubmitting
              ? "Please wait for the current action to finish."
              : "";
  const recipientsStepDisabledReason =
    !selectedOrderCount && !customRecipients.length
      ? "Select at least one Shopify order or add one custom number first."
      : invalidCustomRecipients.length
        ? "Fix invalid custom numbers first. Use E.164 format like +923001234567."
        : customRecipientsBlockedByVariables
          ? `This template needs order data: ${selectedTemplateOrderDependentVariables.join(", ")}. Remove custom numbers or use a template without order-linked variables.`
          : "";
  const canProceedToSchedule = !recipientsStepDisabledReason;
  const testPhoneValid = isValidCustomPhone(normalizeCustomPhone(testPhone));

  const updateBodyText = (value) => updateDraft({ bodyText: value });
  const applyBodyWrap = (prefix, suffix = prefix) =>
    applyWrapToSelection({
      ref: bodyInputRef,
      value: draft.bodyText,
      onChange: updateBodyText,
      prefix,
      suffix,
    });
  const insertBodyText = (text) =>
    insertTextAtSelection({
      ref: bodyInputRef,
      value: draft.bodyText,
      onChange: updateBodyText,
      text,
    });

  useEffect(() => {
    if (!ordersOpen) return;
    if (normalizedOrderQuery === debouncedOrderQuery) return;
    const timeout = window.setTimeout(() => {
      setDebouncedOrderQuery(normalizedOrderQuery);
    }, 350);
    return () => window.clearTimeout(timeout);
  }, [debouncedOrderQuery, normalizedOrderQuery, ordersOpen]);

  useEffect(() => {
    if (!ordersOpen || orderSearchPending) return;
    const params = new URLSearchParams();
    params.set("first", "25");
    params.set("requestKey", expectedOrdersRequestKey);
    if (debouncedOrderQuery) params.set("q", debouncedOrderQuery);
    if (afterCursor) params.set("after", afterCursor);
    loadOrders(
      withShopParams(
        `/app/attempts/orders?${params.toString()}`,
        location.search,
      ),
    );
  }, [
    afterCursor,
    debouncedOrderQuery,
    expectedOrdersRequestKey,
    loadOrders,
    location.search,
    orderSearchPending,
    ordersOpen,
  ]);

  useEffect(() => {
    if (
      !campaignRunPollingActive ||
      campaignRunsFetcher.state !== "idle"
    ) {
      return undefined;
    }
    const timeout = window.setTimeout(() => {
      loadCampaignRuns(
        withShopParams("/app/campaign-runs", location.search),
      );
    }, 4000);
    return () => window.clearTimeout(timeout);
  }, [
    campaignRunPollingActive,
    campaignRunsFetcher.state,
    loadCampaignRuns,
    location.search,
  ]);

  useEffect(() => {
    const hasSelectedTemplate = campaignPageTemplates.some(
      (template) => String(template?.id || "") === selectedTemplateId,
    );
    if (hasSelectedTemplate) return;
    const fallbackId =
      String(filteredTemplates?.[0]?.id || "").trim() ||
      String(campaignPageTemplates?.[0]?.id || "").trim();
    if (fallbackId) {
      setSelectedTemplateId(fallbackId);
    }
  }, [campaignPageTemplates, filteredTemplates, selectedTemplateId]);

  useEffect(() => {
    setTemplatePage(1);
  }, [templateSearch, templateStatusFilter, templateTab]);

  useEffect(() => {
    if (templatePage <= templatePageCount) return;
    setTemplatePage(templatePageCount);
  }, [templatePage, templatePageCount]);

  useEffect(() => {
    if (actionData?.ok && actionData.intent === "save_campaign_template") {
      setDraft(createEmptyCampaignDraft());
      setCreateOpen(false);
    }
    if (actionData?.ok && actionData.intent === "send_campaign") {
      setOrdersOpen(false);
      setCampaignModalStep(1);
      setSelectedOrders([]);
      setRangeStart("");
      setRangeEnd("");
      setCustomRecipientInput("");
      setCustomRecipients([]);
      setScheduleMode("immediate");
      setScheduledAtInput("");
    }
  }, [actionData]);

  useEffect(() => {
    if (!actionData) return;
    if (actionData?.ok && actionData?.note) {
      shopify.toast.show(String(actionData.note));
      return;
    }
    if (actionData?.error) {
      shopify.toast.show(String(actionData.error));
    }
  }, [actionData, shopify]);

  const selectedSet = useMemo(() => new Set(selectedOrders), [selectedOrders]);

  const updateDraft = (patch) =>
    setDraft((current) => ({ ...current, ...patch }));
  const updateButton = (index, patch) => {
    setDraft((current) => ({
      ...current,
      buttons: current.buttons.map((button, i) =>
        i === index ? cleanButton({ ...button, ...patch }, i) : button,
      ),
    }));
  };

  const addButton = () => {
    setDraft((current) => {
      if (current.buttons.length >= 10) return current;
      return {
        ...current,
        buttons: [
          ...current.buttons,
          cleanButton(
            { type: "QUICK_REPLY", text: "Reply" },
            current.buttons.length,
          ),
        ],
      };
    });
  };

  const removeButton = (index) => {
    setDraft((current) => ({
      ...current,
      buttons: current.buttons.filter((_, i) => i !== index).map(cleanButton),
    }));
  };

  const saveTemplate = () => {
    if (!canSaveCampaignDraft) return;
    const form = new FormData();
    form.set("intent", "save_campaign_template");
    form.set("templateId", String(draft.templateId || "").trim());
    form.set("displayName", draft.displayName);
    form.set("language", draft.language);
    form.set("headerType", draft.headerType);
    form.set(
      "headerText",
      String(draft.headerType || "").toUpperCase() === "TEXT"
        ? draft.headerText
        : "",
    );
    form.set("sampleMediaUrl", draft.sampleMediaUrl);
    form.set("useProductImageHeader", String(draft.useProductImageHeader));
    form.set("bodyText", draft.bodyText);
    form.set("footerText", draft.footerText);
    form.set("buttons", JSON.stringify(draft.buttons.map(cleanButton)));
    submit(form, { method: "post" });
  };

  const postTemplateAction = (intent, templateId) => {
    const form = new FormData();
    form.set("intent", intent);
    form.set("templateId", templateId);
    if (intent === "send_template_test") form.set("to", testPhone);
    submit(form, { method: "post" });
  };

  const openOrders = (templateId) => {
    setSelectedTemplateId(templateId);
    setCampaignModalStep(1);
    setOrderQuery("");
    setDebouncedOrderQuery("");
    setOrdersSessionKey((current) => current + 1);
    setSelectedOrders([]);
    setRangeStart("");
    setRangeEnd("");
    setCustomRecipientInput("");
    setCustomRecipients([]);
    setScheduleMode("immediate");
    setScheduledAtInput("");
    setAfterCursor("");
    setCursorStack([]);
    setOrdersOpen(true);
  };

  const closeOrdersModal = () => {
    setOrdersOpen(false);
    setCampaignModalStep(1);
  };

  const toggleRun = (runId) => {
    setExpandedRunIds((current) =>
      current.includes(runId)
        ? current.filter((row) => row !== runId)
        : [...current, runId],
    );
  };

  const toggleOrder = (orderGid) => {
    setSelectedOrders((current) => {
      const next = new Set(current);
      if (next.has(orderGid)) next.delete(orderGid);
      else next.add(orderGid);
      return Array.from(next);
    });
  };

  const selectRange = () => {
    const startIndex = orders.findIndex(
      (order) => order.orderGid === rangeStart,
    );
    const endIndex = orders.findIndex((order) => order.orderGid === rangeEnd);
    if (startIndex < 0 || endIndex < 0) return;
    const [from, to] = [
      Math.min(startIndex, endIndex),
      Math.max(startIndex, endIndex),
    ];
    const gids = orders.slice(from, to + 1).map((order) => order.orderGid);
    setSelectedOrders((current) => Array.from(new Set([...current, ...gids])));
  };

  const sendCampaign = () => {
    const form = new FormData();
    form.set("intent", "send_campaign");
    form.set("templateId", selectedTemplateId);
    form.set("orderGids", JSON.stringify(selectedOrders));
    form.set("customRecipients", JSON.stringify(customRecipients));
    form.set("scheduleMode", scheduleMode);
    form.set(
      "scheduledFor",
      scheduleMode === "scheduled" ? scheduledAtIso : "",
    );
    submit(form, { method: "post" });
  };

  const addCustomRecipient = () => {
    if (!pendingCustomRecipients.length) return;
    setCustomRecipients((current) =>
      Array.from(new Set([...current, ...pendingCustomRecipients])),
    );
    setCustomRecipientInput("");
  };

  const removeCustomRecipient = (phone) => {
    setCustomRecipients((current) => current.filter((row) => row !== phone));
  };

  const clearCustomRecipients = () => {
    setCustomRecipients([]);
    setCustomRecipientInput("");
  };

  const startNewCampaignTemplate = () => {
    setDraft(createEmptyCampaignDraft());
    setCreateOpen(true);
  };

  const continueEditingTemplate = (template) => {
    setDraft(hydrateCampaignDraft(template));
    setCreateOpen(true);
  };

  const duplicateTemplate = (template) => {
    const nextDraft = hydrateCampaignDraft(template);
    setDraft({
      ...nextDraft,
      templateId: "",
      displayName: `${nextDraft.displayName || "Campaign Message"} Copy`,
    });
    setCreateOpen(true);
  };

  const focusTemplate = (templateId) => {
    setSelectedTemplateId(String(templateId || "").trim());
  };

  const templateTabs = [
    { key: "all", label: "All", count: campaignPageTemplates.length },
    { key: "active", label: "Active", count: approvedTemplateCount },
    { key: "tested", label: "Tested", count: testedTemplateCount },
    { key: "drafts", label: "Drafts", count: draftTemplateCount },
    {
      key: "archived",
      label: "Archived",
      count: archivedTemplateCount,
    },
  ];

  return (
    <s-page suppressHydrationWarning>
      <main className="campaign-page">
        <style>{styles}</style>

        <section className="hero-card">
          <div>
            <p className="eyebrow">WhatsApp broadcasts</p>
            <h1>Campaigns</h1>
            <p>
              Create Meta-approved campaign templates, preview them clearly,
              test them once, then send them to selected Shopify orders with
              OrderX billing and BYON conversation checks.
            </p>
          </div>
          <TooltipButton
            type="button"
            className="primary hero-button"
            onClick={() => setCreateOpen(true)}
            disabled={!templateManagementAllowed}
            title={
              templateManagementAllowed
                ? ""
                : "Campaign templates require a Your Own Number plan connected to the merchant Meta account."
            }
          >
            Create campaign template
          </TooltipButton>
        </section>

        {!templateManagementAllowed ? (
          <section className="campaign-guidance-card locked">
            <div>
              <strong>Campaigns are available only on Your Own Number plans.</strong>
              <p>
                OrderX Number plans can keep using the normal automation
                flows, but campaign drafts, tests, and launches are reserved
                for merchants sending from their own Meta WhatsApp account.
              </p>
            </div>
          </section>
        ) : !campaignHasMetaConnection ? (
          <section className="campaign-guidance-card warning">
            <div>
              <strong>Drafts are open. Connect Meta before approval or sending.</strong>
              <p>
                You can create and edit campaign templates right now. Refresh
                from Meta, submit to Meta, test send, and campaign launch will
                unlock after the WhatsApp connection is completed.
              </p>
            </div>
            <span className={`status ${campaignSenderStatusView.tone}`}>
              {campaignSenderStatusView.label}
            </span>
          </section>
        ) : !campaignSendReady ? (
          <section className="campaign-guidance-card info">
            <div>
              <strong>Meta is connected, but the sender is not ready yet.</strong>
              <p>
                You can draft templates and sync the Meta library now. Test
                sends and live campaigns will unlock once your WhatsApp sender
                finishes setup and shows Ready.
              </p>
            </div>
            <span className={`status ${campaignSenderStatusView.tone}`}>
              {campaignSenderStatusView.label}
            </span>
          </section>
        ) : null}

        <section className="panel campaign-library-shell">
          <div className="campaign-library-head">
            <div>
              <p className="eyebrow">Template library</p>
              <h2>Campaign templates</h2>
              <p>
                Search quickly, recognize templates from their message preview,
                and launch the right one without digging through a long list.
              </p>
            </div>
            <div className="campaign-library-actions">
              <TooltipButton
                type="button"
                className="ghost"
                onClick={() => {
                  const form = new FormData();
                  form.set("intent", "refresh_templates");
                  submit(form, { method: "post" });
                }}
                disabled={!refreshTemplatesAllowed || isSubmitting}
                title={
                  !templateManagementAllowed
                    ? "Connect Your Own Number first so OrderX can read templates from your Meta account."
                    : !refreshTemplatesAllowed
                      ? "Finish connecting Meta first. You can keep drafting templates now and import the Meta library after connection."
                    : isSubmitting
                      ? "Please wait for the current action to finish."
                      : ""
                }
              >
                Refresh from Meta
              </TooltipButton>
              <TooltipButton
                type="button"
                className="primary"
                onClick={startNewCampaignTemplate}
                disabled={!templateManagementAllowed}
                title={
                  templateManagementAllowed
                    ? ""
                    : "Campaign templates require a Your Own Number plan connected to the merchant Meta account."
                }
              >
                Create campaign template
              </TooltipButton>
            </div>
          </div>

          <div className="campaign-library-toolbar">
            <div className="campaign-library-search">
              <label className="campaign-search-field">
                <span>⌕</span>
                <input
                  value={templateSearch}
                  onChange={(event) => setTemplateSearch(event.target.value)}
                  placeholder="Search by template name, Meta name, language, or preview text"
                />
              </label>
              <select
                value={templateStatusFilter}
                onChange={(event) =>
                  setTemplateStatusFilter(event.target.value)
                }
              >
                <option value="all">All statuses</option>
                <option value="ready">Ready</option>
                <option value="approved">Approved</option>
                <option value="draft">Draft</option>
                <option value="pending">Pending</option>
                <option value="in_review">In review</option>
                <option value="rejected">Rejected</option>
                <option value="missing">Missing</option>
              </select>
            </div>

            <div className="campaign-library-quickbar">
              <label className="campaign-test-phone-field">
                <span>Default test number</span>
                <input
                  value={testPhone}
                  onChange={(event) => setTestPhone(event.target.value)}
                  placeholder="+923001234567"
                />
              </label>
              <div className="campaign-library-inline-note">
                <strong>{sortedTemplates.length}</strong> templates found. Add
                one valid test number here once, then use it across all cards.
              </div>
            </div>
          </div>

          <div className="campaign-tab-row">
            {templateTabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={`campaign-tab ${
                  templateTab === tab.key ? "active" : ""
                }`}
                onClick={() => setTemplateTab(tab.key)}
              >
                <span>{tab.label}</span>
                <small>{tab.count}</small>
              </button>
            ))}
          </div>

          {sortedTemplates.length ? (
            <>
              <div className="campaign-template-grid">
                {paginatedTemplates.map((template) => (
                  <CampaignTemplateGridCard
                    key={template.id}
                    template={template}
                    selected={String(template?.id || "") === selectedTemplateId}
                    testPhoneValid={testPhoneValid}
                    onSelect={() => focusTemplate(template.id)}
                    onViewDetails={() => setDetailsTemplate(template)}
                    onEdit={() => continueEditingTemplate(template)}
                    onDuplicate={() => duplicateTemplate(template)}
                    onDelete={() => {
                      const form = new FormData();
                      form.set("intent", "delete_template");
                      form.set("templateId", template.id);
                      submit(form, { method: "post" });
                    }}
                    onSubmit={() =>
                      postTemplateAction("submit_template", template.id)
                    }
                    onTest={() =>
                      postTemplateAction("send_template_test", template.id)
                    }
                    onSend={() => openOrders(template.id)}
                    busy={isSubmitting}
                    templateManagementAllowed={templateManagementAllowed}
                    senderCapabilities={senderCapabilities}
                  />
                ))}
              </div>

              {templatePageCount > 1 ? (
                <div className="campaign-pagination">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setTemplatePage((current) => current - 1)}
                    disabled={templatePage <= 1}
                  >
                    Previous
                  </button>
                  <div className="campaign-pagination-pages">
                    {Array.from({ length: templatePageCount }, (_, index) => {
                      const page = index + 1;
                      const isActive = page === templatePage;
                      return (
                        <button
                          key={page}
                          type="button"
                          className={`campaign-page-pill ${
                            isActive ? "active" : ""
                          }`}
                          onClick={() => setTemplatePage(page)}
                        >
                          {page}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setTemplatePage((current) => current + 1)}
                    disabled={templatePage >= templatePageCount}
                  >
                    Next
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <div className="empty campaign-empty-state">
              No templates match this search yet. Try another phrase or switch
              the status filter.
            </div>
          )}
        </section>

        <section className="panel campaign-runs-panel campaign-history-panel">
          <div className="section-head">
            <div>
              <h2>Campaign records</h2>
              <p>
                Track Meta acceptance, delivery, reads, and exact failure
                reasons. Failed recipients can be retried individually.
              </p>
            </div>
            <span className="pill muted">
              {campaignRunSummary.campaignCount || 0} campaign
              {Number(campaignRunSummary.campaignCount || 0) === 1 ? "" : "s"}
            </span>
          </div>
          {campaignRunList.length ? (
            <div className="run-list">
              {campaignRunList.map((run) => (
                <CampaignRunCard
                  key={run.id}
                  run={run}
                  expanded={expandedRunIds.includes(run.id)}
                  onToggle={() => toggleRun(run.id)}
                  onRetry={(recipientId) => {
                    const form = new FormData();
                    form.set("intent", "retry_campaign_recipient");
                    form.set("runId", run.id);
                    form.set("recipientId", recipientId);
                    submit(form, { method: "post" });
                  }}
                  busy={isSubmitting}
                />
              ))}
            </div>
          ) : (
            <div className="empty">
              No campaign runs yet. Once you send or schedule one, the full
              record appears here.
            </div>
          )}
        </section>

        <Modal
          id="create-campaign-template-modal"
          variant="max"
          open={createOpen}
          onHide={() => setCreateOpen(false)}
        >
          <TitleBar title="Create campaign template">
            <button
              variant="secondary"
              type="button"
              onClick={() => setCreateOpen(false)}
            >
              Cancel
            </button>
            <button
              variant="primary"
              type="button"
              onClick={saveTemplate}
              disabled={isSubmitting || !canSaveCampaignDraft}
            >
              Save draft
            </button>
          </TitleBar>
          <div className="campaign-template-builder">
            <div className="campaign-template-editor">
              <div className="campaign-editor-card">
                <div className="builder-step">
                  <span>1</span>
                  <div>
                    <h3>Template setup</h3>
                    <p>
                      Campaign templates are submitted as Utility first. Meta
                      may recategorize them during review.
                    </p>
                  </div>
                </div>

                <div className="form-grid">
                  <label>
                    Template name
                    <input
                      value={draft.displayName}
                      onChange={(e) =>
                        updateDraft({ displayName: e.target.value })
                      }
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Language
                    <select
                      value={draft.language}
                      onChange={(e) =>
                        updateDraft({ language: e.target.value })
                      }
                    >
                      {languageOptions.map((option) => (
                        <option key={option.code} value={option.code}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Meta category
                    <input value="Utility" disabled readOnly />
                  </label>
                  <label>
                    Header type
                    <select
                      value={draft.headerType}
                      onChange={(e) =>
                        updateDraft({ headerType: e.target.value })
                      }
                    >
                      <option value="TEXT">Text</option>
                      <option value="IMAGE">Image</option>
                      <option value="NONE">None</option>
                    </select>
                  </label>
                </div>
              </div>

              <div className="campaign-editor-card">
                <div className="builder-step">
                  <span>2</span>
                  <div>
                    <h3>Header and body</h3>
                    <p>
                      Add variables with the chips so Meta receives real
                      template variables.
                    </p>
                  </div>
                </div>

                {draft.headerType === "TEXT" ? (
                  <>
                    <label className="full">
                      Header text
                      <input
                        ref={headerInputRef}
                        value={draft.headerText}
                        onChange={(e) =>
                          updateDraft({ headerText: e.target.value })
                        }
                        maxLength={60}
                        dir={draftDirection}
                        lang={draft.language || "en"}
                        style={{
                          textAlign: draftAlign,
                          direction: draftDirection,
                          unicodeBidi: "plaintext",
                        }}
                      />
                    </label>
                    <div className="variable-section compact">
                      <p>Header variables</p>
                      <div className="variable-grid">
                        {CAMPAIGN_VARIABLES.slice(0, 4).map((variable) => (
                          <button
                            key={variable.key}
                            type="button"
                            className="variable-chip"
                            onClick={() =>
                              insertTokenAtCursor({
                                ref: headerInputRef,
                                field: "headerText",
                                token: variable.key,
                                setDraft,
                              })
                            }
                          >
                            {variable.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                ) : null}

                {draft.headerType === "IMAGE" ? (
                  <div className="form-grid">
                    <label>
                      Sample image URL
                      <input
                        value={draft.sampleMediaUrl}
                        onChange={(e) =>
                          updateDraft({ sampleMediaUrl: e.target.value })
                        }
                        placeholder="https://cdn.example.com/product.jpg"
                      />
                    </label>
                    <div style={{ display: "flex" }}>
                      <label className="check-line image-check">
                        <input
                          type="checkbox"
                          checked={draft.useProductImageHeader}
                          onChange={(e) =>
                            updateDraft({
                              useProductImageHeader: e.target.checked,
                            })
                          }
                        />
                        Use first product image when sending
                      </label>
                    </div>
                  </div>
                ) : null}

                <label className="full">
                  Body
                  <div className="format-toolbar">
                    {[
                      {
                        label: "Bold",
                        onClick: () => applyBodyWrap("*"),
                      },
                      {
                        label: "Italic",
                        onClick: () => applyBodyWrap("_"),
                      },
                      {
                        label: "Strike",
                        onClick: () => applyBodyWrap("~"),
                      },
                      {
                        label: "Monospace",
                        onClick: () => applyBodyWrap("```", "```"),
                      },
                    ].map((tool) => (
                      <button
                        key={tool.label}
                        type="button"
                        className="format-chip"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={tool.onClick}
                      >
                        {tool.label}
                      </button>
                    ))}
                    {["✅", "📦", "⏳", "📍", "🔁"].map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        className="format-emoji"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => insertBodyText(emoji)}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                  <textarea
                    ref={bodyInputRef}
                    value={draft.bodyText}
                    onChange={(e) => updateDraft({ bodyText: e.target.value })}
                    maxLength={1024}
                    rows={12}
                    dir={draftDirection}
                    lang={draft.language || "en"}
                    style={{
                      textAlign: draftAlign,
                      direction: draftDirection,
                      unicodeBidi: "plaintext",
                    }}
                  />
                </label>
                <div className="field-meta">
                  <span>
                    {String(draft.bodyText || "").length}/1024 characters
                  </span>
                  <span>Variables cannot be first, last, or repeated.</span>
                </div>

                <div className="variable-section">
                  <p>Insert variables</p>
                  <div className="variable-grid">
                    {CAMPAIGN_VARIABLES.map((variable) => (
                      <button
                        key={variable.key}
                        type="button"
                        className="variable-chip"
                        title={`Sample: ${variable.sample}`}
                        onClick={() =>
                          insertTokenAtCursor({
                            ref: bodyInputRef,
                            field: "bodyText",
                            token: variable.key,
                            setDraft,
                          })
                        }
                      >
                        {variable.label}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="full">
                  Footer
                  <input
                    value={draft.footerText}
                    onChange={(e) =>
                      updateDraft({ footerText: e.target.value })
                    }
                    maxLength={60}
                    placeholder="Optional footer"
                    dir={draftDirection}
                    lang={draft.language || "en"}
                    style={{
                      textAlign: draftAlign,
                      direction: draftDirection,
                      unicodeBidi: "plaintext",
                    }}
                  />
                </label>
                <div className="field-meta">
                  <span>
                    {String(draft.footerText || "").length}/60 characters
                  </span>
                  <span>Footer cannot contain variables.</span>
                </div>
              </div>

              <div className="campaign-editor-card">
                <div className="section-head small">
                  <div>
                    <h3>Buttons</h3>
                    <p>
                      Quick replies can send an automatic response and apply an
                      order tag.
                    </p>
                  </div>
                  <button type="button" onClick={addButton}>
                    Add button
                  </button>
                </div>
                <div className="button-editor embedded">
                  {draft.buttons.map((button, index) => (
                    <div
                      className="button-row"
                      key={`${button.action}-${index}`}
                    >
                      <label>
                        Type
                        <select
                          value={button.type}
                          onChange={(e) =>
                            updateButton(index, { type: e.target.value })
                          }
                        >
                          <option value="QUICK_REPLY">Quick reply</option>
                          <option value="URL">Link</option>
                        </select>
                      </label>
                      <label>
                        Button text
                        <input
                          value={button.text}
                          onChange={(e) =>
                            updateButton(index, { text: e.target.value })
                          }
                          placeholder="Button text"
                          maxLength={25}
                        />
                      </label>
                      {button.type === "URL" ? (
                        <label>
                          Link URL
                          <input
                            value={button.url}
                            onChange={(e) =>
                              updateButton(index, { url: e.target.value })
                            }
                            placeholder="https://example.com"
                          />
                        </label>
                      ) : (
                        <label>
                          Auto response
                          <input
                            value={button.responseText}
                            onChange={(e) =>
                              updateButton(index, {
                                responseText: e.target.value,
                              })
                            }
                            placeholder="Thanks. Our team will contact you shortly."
                          />
                        </label>
                      )}
                      <label>
                        Optional tag
                        <input
                          value={button.tag}
                          onChange={(e) =>
                            updateButton(index, { tag: e.target.value })
                          }
                          placeholder="CAMPAIGN_INTERESTED"
                          maxLength={40}
                        />
                      </label>
                      <button
                        type="button"
                        className="ghost danger"
                        onClick={() => removeButton(index)}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  {!draft.buttons.length ? (
                    <div className="empty small-empty">
                      No buttons added. You can submit a campaign template
                      without buttons.
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            <aside className="campaign-template-side">
              <CampaignTemplatePreview draft={draft} />
              <CampaignValidationChecklist checks={campaignChecks} />
            </aside>
          </div>
        </Modal>

        <Modal
          id="campaign-orders-modal"
          variant="max"
          open={ordersOpen}
          onHide={closeOrdersModal}
        >
          <TitleBar title="Select campaign recipients" />
          <div className="modal-body orders-modal">
            <div className="campaign-modal-stepper">
              <button
                type="button"
                className={`campaign-modal-step ${campaignModalStep === 1 ? "active" : ""} ${selectedRecipientCount > 0 ? "complete" : ""}`}
                onClick={() => setCampaignModalStep(1)}
              >
                <span className="campaign-modal-step-number">1</span>
                <span className="campaign-modal-step-copy">
                  <strong>Select recipients</strong>
                  <small>Choose Shopify orders and add custom numbers.</small>
                </span>
              </button>
              <button
                type="button"
                className={`campaign-modal-step ${campaignModalStep === 2 ? "active" : ""}`}
                disabled={!canProceedToSchedule && campaignModalStep !== 2}
                onClick={() => {
                  if (canProceedToSchedule) setCampaignModalStep(2);
                }}
              >
                <span className="campaign-modal-step-number">2</span>
                <span className="campaign-modal-step-copy">
                  <strong>Choose timing</strong>
                  <small>Send now or schedule it for later.</small>
                </span>
              </button>
            </div>

            {campaignModalStep === 1 ? (
              <div className="orders-modal-layout recipients-step-layout">
                <div className="orders-panel">
                  <div className="orders-section-head">
                    <div>
                      <strong>Step 1: Shopify orders</strong>
                      <p>
                        Search orders, select them one by one, grab the whole
                        page, or choose a start and end order from this page.
                      </p>
                    </div>
                    <span className="pill muted">
                      {selectedOrderCount} order
                      {selectedOrderCount === 1 ? "" : "s"} selected
                    </span>
                  </div>

                  <div className="orders-toolbar">
                    <input
                      value={orderQuery}
                      onChange={(e) => {
                        setOrderQuery(e.target.value);
                        setAfterCursor("");
                        setCursorStack([]);
                        setRangeStart("");
                        setRangeEnd("");
                      }}
                      placeholder="Search orders, phone, email, #1001"
                      aria-label="Search Shopify orders"
                    />
                    <div className="orders-toolbar-actions">
                      <button
                        type="button"
                        onClick={() => {
                          const pageGids = orders.map(
                            (order) => order.orderGid,
                          );
                          setSelectedOrders((current) =>
                            Array.from(new Set([...current, ...pageGids])),
                          );
                        }}
                        disabled={ordersLoading || !orders.length}
                      >
                        Select page
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const pageSet = new Set(
                            orders.map((order) => order.orderGid),
                          );
                          setSelectedOrders((current) =>
                            current.filter((gid) => !pageSet.has(gid)),
                          );
                        }}
                        disabled={ordersLoading || !orders.length}
                      >
                        Clear page
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedOrders([])}
                      >
                        Clear all orders
                      </button>
                    </div>
                  </div>

                  <div className="range-picker-card">
                    <div className="range-picker-head">
                      <div>
                        <strong>Select a start-to-end range</strong>
                        <p>
                          Choose the first and last order on this page and
                          OrderX will select everything in between.
                        </p>
                      </div>
                      {rangeStart || rangeEnd ? (
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => {
                            setRangeStart("");
                            setRangeEnd("");
                          }}
                        >
                          Clear range
                        </button>
                      ) : null}
                    </div>
                    <div className="range-picker">
                      <label>
                        Start order
                        <select
                          value={rangeStart}
                          onChange={(e) => setRangeStart(e.target.value)}
                          disabled={ordersLoading || !orders.length}
                        >
                          <option value="">Choose start order</option>
                          {orders.map((order) => (
                            <option key={order.orderGid} value={order.orderGid}>
                              {order.orderName}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        End order
                        <select
                          value={rangeEnd}
                          onChange={(e) => setRangeEnd(e.target.value)}
                          disabled={ordersLoading || !orders.length}
                        >
                          <option value="">Choose end order</option>
                          {orders.map((order) => (
                            <option key={order.orderGid} value={order.orderGid}>
                              {order.orderName}
                            </option>
                          ))}
                        </select>
                      </label>
                      <TooltipButton
                        type="button"
                        className="range-picker-action"
                        onClick={selectRange}
                        disabled={
                          ordersLoading || !rangeStart || !rangeEnd
                        }
                        title={
                          rangeStart && rangeEnd
                            ? ""
                            : "Choose both a start order and an end order first."
                        }
                      >
                        Select range
                      </TooltipButton>
                    </div>
                  </div>

                  <div className="orders-list">
                    {ordersLoading ? (
                      <div className="loading">Loading orders...</div>
                    ) : ordersError ? (
                      <div className="notice error compact-notice" role="alert">
                        {ordersError}
                      </div>
                    ) : orders.length ? (
                      orders.map((order) => (
                        <label className="order-row" key={order.orderGid}>
                          <input
                            type="checkbox"
                            checked={selectedSet.has(order.orderGid)}
                            onChange={() => toggleOrder(order.orderGid)}
                          />
                          <div>
                            <strong>{order.orderName}</strong>
                            <span>
                              {order.customerName} ·{" "}
                              {order.customerPhone ||
                                order.shippingPhone ||
                                "No phone"}
                            </span>
                            <small>
                              {toArray(order.lineSummary).join(", ")}
                            </small>
                          </div>
                          <em>{formatDate(order.createdAt)}</em>
                        </label>
                      ))
                    ) : (
                      <div className="empty">No orders found.</div>
                    )}
                  </div>

                  <div className="pager">
                    <button
                      type="button"
                      disabled={ordersLoading || !cursorStack.length}
                      onClick={() => {
                        const nextStack = cursorStack.slice(0, -1);
                        setAfterCursor(nextStack[nextStack.length - 1] || "");
                        setCursorStack(nextStack);
                        setRangeStart("");
                        setRangeEnd("");
                      }}
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      disabled={
                        ordersLoading ||
                        !pageInfo.hasNextPage ||
                        !pageInfo.endCursor
                      }
                      onClick={() => {
                        setCursorStack((current) => [
                          ...current,
                          pageInfo.endCursor,
                        ]);
                        setAfterCursor(pageInfo.endCursor);
                        setRangeStart("");
                        setRangeEnd("");
                      }}
                    >
                      Next
                    </button>
                  </div>
                </div>

                <aside className="orders-sidebar">
                  <div className="campaign-step-summary-card">
                    <strong>Recipient summary</strong>
                    <div className="campaign-step-summary-grid">
                      <div>
                        <span>Total selected</span>
                        <strong>{selectedRecipientCount}</strong>
                      </div>
                      <div>
                        <span>Orders</span>
                        <strong>{selectedOrderCount}</strong>
                      </div>
                      <div>
                        <span>Custom numbers</span>
                        <strong>{customRecipients.length}</strong>
                      </div>
                    </div>
                    <small>
                      Once the recipient list looks right, move to the next step
                      and choose when the campaign should go out.
                    </small>
                  </div>
                  <div className="custom-recipient-card">
                    <div className="custom-recipient-head">
                      <div>
                        <strong>Step 1B: Add custom WhatsApp numbers</strong>
                        <p>
                          Paste one number per line or separate them with
                          commas. Use E.164 format like{" "}
                          <code>+923001234567</code>.
                        </p>
                      </div>
                      <span className="pill muted">
                        {customRecipients.length} custom
                      </span>
                    </div>

                    <div className="custom-recipient-entry">
                      <textarea
                        value={customRecipientInput}
                        onChange={(e) =>
                          setCustomRecipientInput(e.target.value)
                        }
                        rows={5}
                        placeholder={"+923001234567\n+923111111111"}
                      />
                      <div className="custom-recipient-actions">
                        <TooltipButton
                          type="button"
                          onClick={addCustomRecipient}
                          disabled={!pendingCustomRecipients.length}
                          title={
                            pendingCustomRecipients.length
                              ? ""
                              : "Paste at least one valid number first."
                          }
                        >
                          {pendingCustomRecipients.length
                            ? `Add ${pendingCustomRecipients.length} number${
                                pendingCustomRecipients.length === 1 ? "" : "s"
                              }`
                            : "Add numbers"}
                        </TooltipButton>
                        <TooltipButton
                          type="button"
                          onClick={clearCustomRecipients}
                          disabled={
                            !customRecipients.length &&
                            !customRecipientInput.trim()
                          }
                          title={
                            customRecipients.length ||
                            customRecipientInput.trim()
                              ? ""
                              : "There are no custom numbers to clear."
                          }
                        >
                          Clear custom
                        </TooltipButton>
                      </div>
                    </div>
                    <div className="custom-recipient-hint">
                      Custom numbers are best for broad updates. If a template
                      needs order-specific variables, OrderX will block custom
                      recipients and explain why.
                    </div>

                    {customRecipientsBlockedByVariables ? (
                      <div className="notice warning compact-notice">
                        This template uses order-linked variables:{" "}
                        {selectedTemplateOrderDependentVariables.join(", ")}.
                        Custom numbers can only be used with templates that do
                        not depend on order data.
                      </div>
                    ) : null}

                    {customRecipients.length ? (
                      <div className="custom-recipient-list">
                        {customRecipients.map((phone) => (
                          <div
                            className={`custom-recipient-chip ${
                              isValidCustomPhone(phone) ? "" : "invalid"
                            }`}
                            key={phone}
                          >
                            <div>
                              <strong>{phone}</strong>
                              {!isValidCustomPhone(phone) ? (
                                <small>
                                  Use full E.164 format like +923001234567
                                </small>
                              ) : (
                                <small>No Shopify order linked</small>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() => removeCustomRecipient(phone)}
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="empty small-empty">
                        No custom numbers added yet.
                      </div>
                    )}
                  </div>
                  {selectedTemplate ? (
                    <div className="campaign-modal-template-panel">
                      <div className="campaign-modal-template-head">
                        <div>
                          <strong>
                            {selectedTemplate?.displayName ||
                              "Campaign template"}
                          </strong>
                          <span>{selectedTemplate?.metaTemplateName}</span>
                          <small>
                            This approved template stays locked for the whole
                            campaign.
                          </small>
                        </div>
                        <div className="selected-template-badges">
                          <span
                            className={`status ${templateStatus(
                              selectedTemplate,
                            )}`}
                          >
                            {statusLabel(selectedTemplate)}
                          </span>
                          <span className="pill muted">
                            {toArray(selectedTemplate?.buttons).length} button
                            {toArray(selectedTemplate?.buttons).length === 1
                              ? ""
                              : "s"}
                          </span>
                        </div>
                      </div>
                      <div className="campaign-modal-template-preview">
                        <CampaignWhatsappPreview
                          template={selectedTemplate}
                          compact
                        />
                      </div>
                    </div>
                  ) : null}
                </aside>
              </div>
            ) : (
              <div className="orders-modal-layout schedule-step-layout">
                <div className="campaign-schedule-stage">
                  <div className="orders-section-head">
                    <div>
                      <strong>Step 2: Choose campaign timing</strong>
                      <p>
                        Send the campaign immediately or queue it for a future
                        time once your recipients are locked in.
                      </p>
                    </div>
                    <span className="pill muted">
                      {scheduleMode === "scheduled" && scheduledAtInput
                        ? "Scheduled"
                        : "Immediate"}
                    </span>
                  </div>

                  <div className="campaign-schedule-options">
                    <button
                      type="button"
                      className={`campaign-schedule-option ${
                        scheduleMode === "immediate" ? "active" : ""
                      }`}
                      onClick={() => setScheduleMode("immediate")}
                    >
                      <strong>Send immediately</strong>
                      <p>
                        OrderX will start sending as soon as you confirm the
                        campaign.
                      </p>
                    </button>
                    <button
                      type="button"
                      className={`campaign-schedule-option ${
                        scheduleMode === "scheduled" ? "active" : ""
                      }`}
                      onClick={() => setScheduleMode("scheduled")}
                    >
                      <strong>Schedule for later</strong>
                      <p>
                        Pick a future date and time if you want to launch the
                        campaign later.
                      </p>
                    </button>
                  </div>

                  {scheduleMode === "scheduled" ? (
                    <label className="campaign-schedule-time-field">
                      <span>Schedule time</span>
                      <input
                        type="datetime-local"
                        value={scheduledAtInput}
                        onChange={(event) =>
                          setScheduledAtInput(event.target.value)
                        }
                      />
                      <small>
                        Choose a time at least 1 minute in the future.
                      </small>
                    </label>
                  ) : null}

                  <div className="campaign-step-summary-card">
                    <strong>What will happen next</strong>
                    <small>
                      {scheduleMode === "scheduled" && scheduledAtInput
                        ? `This campaign will be queued for ${formatDate(
                            scheduledDate,
                          )}.`
                        : "As soon as you confirm, OrderX will start sending to the selected recipients."}
                    </small>
                  </div>
                </div>

                <aside className="orders-sidebar">
                  {selectedTemplate ? (
                    <div className="campaign-modal-template-panel">
                      <div className="campaign-modal-template-head">
                        <div>
                          <strong>
                            {selectedTemplate?.displayName ||
                              "Campaign template"}
                          </strong>
                          <span>{selectedTemplate?.metaTemplateName}</span>
                          <small>
                            Final preview of the exact template that will be
                            sent.
                          </small>
                        </div>
                        <div className="selected-template-badges">
                          <span
                            className={`status ${templateStatus(
                              selectedTemplate,
                            )}`}
                          >
                            {statusLabel(selectedTemplate)}
                          </span>
                          <span className="pill muted">
                            {selectedRecipientCount} selected
                          </span>
                        </div>
                      </div>
                      <div className="campaign-modal-template-preview">
                        <CampaignWhatsappPreview
                          template={selectedTemplate}
                          compact
                        />
                      </div>
                    </div>
                  ) : null}

                  <div className="campaign-final-review-card">
                    <div className="custom-recipient-head">
                      <div>
                        <strong>Final review</strong>
                        <p>
                          Double-check the audience and timing before launching.
                        </p>
                      </div>
                      <span className="pill">
                        {selectedRecipientCount} recipient
                        {selectedRecipientCount === 1 ? "" : "s"}
                      </span>
                    </div>

                    <div className="campaign-step-summary-grid review-grid">
                      <div>
                        <span>Shopify orders</span>
                        <strong>{selectedOrderCount}</strong>
                      </div>
                      <div>
                        <span>Custom numbers</span>
                        <strong>{customRecipients.length}</strong>
                      </div>
                      <div>
                        <span>Delivery mode</span>
                        <strong>
                          {scheduleMode === "scheduled"
                            ? "Scheduled"
                            : "Immediate"}
                        </strong>
                      </div>
                      <div>
                        <span>Template status</span>
                        <strong>{statusLabel(selectedTemplate)}</strong>
                      </div>
                    </div>

                    {invalidCustomRecipients.length ? (
                      <div className="notice warning compact-notice">
                        Fix invalid custom numbers before sending this campaign.
                      </div>
                    ) : null}

                    {selectedOrders.length ? (
                      <div className="campaign-review-list">
                        <strong>Selected orders</strong>
                        <small>
                          {selectedOrders.length > 6
                            ? `${selectedOrders.length} orders selected on this campaign.`
                            : orders
                                .filter((order) =>
                                  selectedSet.has(order.orderGid),
                                )
                                .map((order) => order.orderName)
                                .join(", ")}
                        </small>
                      </div>
                    ) : null}

                    {customRecipients.length ? (
                      <div className="campaign-review-list">
                        <strong>Custom numbers</strong>
                        <small>{customRecipients.join(", ")}</small>
                      </div>
                    ) : null}
                  </div>
                </aside>
              </div>
            )}
            <div className="modal-actions sticky-actions">
              <button type="button" onClick={closeOrdersModal}>
                Cancel
              </button>
              <div className="campaign-modal-footer-actions">
                {campaignModalStep === 2 ? (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setCampaignModalStep(1)}
                  >
                    Back to recipients
                  </button>
                ) : null}
                {campaignModalStep === 1 ? (
                  <TooltipButton
                    type="button"
                    className="primary"
                    onClick={() => setCampaignModalStep(2)}
                    disabled={!canProceedToSchedule}
                    title={recipientsStepDisabledReason}
                  >
                    Next: choose timing
                  </TooltipButton>
                ) : (
                  <TooltipButton
                    type="button"
                    className="primary"
                    onClick={sendCampaign}
                    disabled={!canSendCampaignNow}
                    title={sendCampaignDisabledReason}
                  >
                    {scheduleMode === "scheduled"
                      ? "Schedule campaign"
                      : "Send campaign"}
                  </TooltipButton>
                )}
              </div>
            </div>
          </div>
        </Modal>

        <Modal
          id="campaign-template-details-modal"
          variant="max"
          open={Boolean(detailsTemplate)}
          onHide={() => setDetailsTemplate(null)}
        >
          <TitleBar title="Template details" />
          {detailsTemplate ? (
            <div className="modal-body details-modal">
              <div className="details-grid">
                <div className="details-panel">
                  <div className="details-card">
                    <div className="section-head small">
                      <div>
                        <h3>
                          {detailsTemplate.displayName ||
                            detailsTemplate.flowLabel}
                        </h3>
                        <p>{detailsTemplate.metaTemplateName}</p>
                      </div>
                      <span
                        className={`status ${templateStatus(detailsTemplate)}`}
                      >
                        {statusLabel(detailsTemplate)}
                      </span>
                    </div>
                    <div className="details-list">
                      <div>
                        <strong>Language</strong>
                        <span>{detailsTemplate.languageLabel}</span>
                      </div>
                      <div>
                        <strong>Category</strong>
                        <span>{detailsTemplate.category}</span>
                      </div>
                      <div>
                        <strong>Header type</strong>
                        <span>{detailsTemplate.headerType}</span>
                      </div>
                      <div>
                        <strong>Use product image</strong>
                        <span>
                          {detailsTemplate.useProductImageHeader ? "Yes" : "No"}
                        </span>
                      </div>
                      <div>
                        <strong>Sample image URL</strong>
                        <span>{detailsTemplate.sampleMediaUrl || "—"}</span>
                      </div>
                      <div>
                        <strong>Footer</strong>
                        <span>{detailsTemplate.footerText || "—"}</span>
                      </div>
                      <div>
                        <strong>Last error</strong>
                        <span>
                          {detailsTemplate.lastError ||
                            detailsTemplate.rejectionReason ||
                            "—"}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="details-card">
                    <h3>Header</h3>
                    <pre>{detailsTemplate.headerText || "No text header"}</pre>
                    <h3>Body</h3>
                    <pre>{detailsTemplate.bodyText || "—"}</pre>
                  </div>
                  <div className="details-card">
                    <h3>Buttons</h3>
                    {toArray(detailsTemplate.buttons).length ? (
                      <div className="details-button-list">
                        {toArray(detailsTemplate.buttons).map(
                          (button, index) => (
                            <div
                              key={`${detailsTemplate.id}-button-${index}`}
                              className="details-button-row"
                            >
                              <strong>
                                {button.text || `Button ${index + 1}`}
                              </strong>
                              <span>Type: {button.type || "QUICK_REPLY"}</span>
                              <span>Action: {button.action || "—"}</span>
                              <span>Reply: {button.responseText || "—"}</span>
                              <span>Tag: {button.tag || "—"}</span>
                              <span>URL: {button.url || "—"}</span>
                            </div>
                          ),
                        )}
                      </div>
                    ) : (
                      <div className="empty small-empty">
                        No buttons on this template.
                      </div>
                    )}
                  </div>
                </div>
                <aside className="details-preview-side">
                  <CampaignWhatsappPreview template={detailsTemplate} />
                </aside>
              </div>
            </div>
          ) : null}
        </Modal>
      </main>
    </s-page>
  );
}

function getCampaignTemplateStage(template = {}) {
  if (isApproved(template) && isTested(template)) {
    return { label: "Ready", className: "approved" };
  }
  const status = templateStatus(template);
  if (status === "approved") {
    return { label: "Approved", className: "approved" };
  }
  if (status === "in_review") {
    return { label: "In review", className: "in_review" };
  }
  if (status === "pending") {
    return { label: "Pending", className: "pending" };
  }
  if (status === "rejected") {
    return { label: "Rejected", className: "rejected" };
  }
  if (status === "missing") {
    return { label: "Missing", className: "rejected" };
  }
  return { label: "Draft", className: "draft" };
}

function CampaignTemplateGridCard({
  template,
  selected = false,
  testPhoneValid = false,
  onSelect = () => {},
  onViewDetails = () => {},
  onEdit = () => {},
  onDuplicate = () => {},
  onDelete = () => {},
  onSubmit = () => {},
  onTest = () => {},
  onSend = () => {},
  busy = false,
  templateManagementAllowed = true,
  senderCapabilities = {},
}) {
  const stage = getCampaignTemplateStage(template);
  const actionState = getTemplateActionState(template, {
    busy,
    templateManagementAllowed,
    senderCapabilities,
  });
  const lastActivity = getTemplateLastActivity(template);
  const preview = normalizeTemplatePreviewModel(template);
  const testDisabledReason = !testPhoneValid
    ? "Add a valid test number above first. Use E.164 format like +923001234567."
    : actionState.testDisabledReason;

  return (
    <article
      className={`campaign-grid-card ${selected ? "selected" : ""}`}
    >
      <div className="campaign-grid-card-top">
        <span className={`status ${stage.className}`}>{stage.label}</span>
        {selected ? (
          <span className="campaign-selected-pill">Selected</span>
        ) : null}
      </div>

      <button
        type="button"
        className="campaign-grid-preview"
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
      >
        <CampaignWhatsappPreview template={template} compact />
      </button>

      <div className="campaign-grid-card-body">
        <div className="campaign-grid-card-head">
          <div>
            <h3>{template.displayName || template.flowLabel || "Template"}</h3>
            <p>{getTemplateOriginLabel(template)}</p>
          </div>
          <small>
            {lastActivity ? `Updated ${formatDate(lastActivity)}` : "Draft"}
          </small>
        </div>

        <div className="chips campaign-grid-card-chips">
          <span>
            {template.languageLabel || template.language || "English"}
          </span>
          <span>{template.category || "UTILITY"}</span>
          <span>
            {toArray(template.buttons).length} button
            {toArray(template.buttons).length === 1 ? "" : "s"}
          </span>
          {String(template?.source || "").trim() === "meta_library" ? (
            <span>Imported</span>
          ) : null}
          {actionState.tested ? <span className="good">Ready</span> : null}
        </div>

        <div className="campaign-grid-card-meta">
          <span>{template.metaTemplateName || "Draft template"}</span>
          {preview.headerType === "IMAGE" && preview.sampleMediaUrl ? (
            <span>Image header</span>
          ) : (
            <span>
              {preview.headerType === "TEXT" ? "Text header" : "No header"}
            </span>
          )}
        </div>

        {template.rejectionReason || template.lastError ? (
          <div className="template-alert">
            {template.rejectionReason || template.lastError}
          </div>
        ) : null}

        <div className="campaign-grid-card-actions secondary">
          {!actionState.isDraft ? (
            <button
              type="button"
              className="ghost"
              onClick={(event) => {
                event.stopPropagation();
                onViewDetails();
              }}
            >
              View details
            </button>
          ) : (
            <button
              type="button"
              className="ghost"
              onClick={(event) => {
                event.stopPropagation();
                onEdit();
              }}
            >
              Continue editing
            </button>
          )}

          <button
            type="button"
            className="ghost"
            onClick={(event) => {
              event.stopPropagation();
              onDuplicate();
            }}
          >
            Duplicate
          </button>

          {actionState.isDraft ? (
            <button
              type="button"
              className="ghost danger"
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
            >
              Delete draft
            </button>
          ) : null}
        </div>

        <div className="campaign-grid-card-actions primary-row">
          {actionState.canSubmit ? (
            <TooltipButton
              type="button"
              className="ghost"
              onClick={(event) => {
                event.stopPropagation();
                onSubmit();
              }}
              disabled={!actionState.canSubmit || busy}
              title={actionState.submitDisabledReason}
            >
              Submit to Meta
            </TooltipButton>
          ) : (
            <TooltipButton
              type="button"
              className="ghost"
              disabled
              title={actionState.submitDisabledReason}
            >
              {actionState.waiting
                ? "Waiting on Meta"
                : actionState.approved
                  ? "Approved in Meta"
                  : "Imported from Meta"}
            </TooltipButton>
          )}

          <TooltipButton
            type="button"
            className="ghost"
            onClick={(event) => {
              event.stopPropagation();
              onTest();
            }}
            disabled={!actionState.approved || busy || !testPhoneValid}
            title={testDisabledReason}
          >
            {actionState.tested ? "Test again" : "Send test"}
          </TooltipButton>

          <TooltipButton
            type="button"
            className="primary"
            onClick={(event) => {
              event.stopPropagation();
              onSend();
            }}
            disabled={!actionState.approved || !actionState.tested || busy}
            title={actionState.sendDisabledReason}
          >
            Use in campaign
          </TooltipButton>
        </div>
      </div>
    </article>
  );
}

function CampaignRunCard({
  run,
  expanded = false,
  onToggle = () => {},
  onRetry = () => {},
  busy = false,
}) {
  const status = String(run?.status || "scheduled");
  const recipients = toArray(run?.recipients);

  return (
    <article className="campaign-run-card">
      <div className="template-card-head">
        <div>
          <h3>{run.templateDisplayName || "Campaign"}</h3>
          <p>
            {run.templateMetaTemplateName} · {run.templateLanguage} ·{" "}
            {run.templateCategory}
          </p>
        </div>
        <span className={`status ${status}`}>{status.replace(/_/g, " ")}</span>
      </div>
      <div className="chips">
        <span>
          {run.scheduleMode === "scheduled" ? "Scheduled" : "Immediate"}
        </span>
        <span>{run.totalRecipients || 0} recipients</span>
        <span>{run.sentCount || 0} accepted</span>
        <span>{run.deliveredCount || 0} delivered</span>
        {Number(run.readCount || 0) > 0 ? (
          <span>{run.readCount} read</span>
        ) : null}
        <span>{run.failedCount || 0} failed</span>
        {Number(run.skippedCount || 0) > 0 ? (
          <span>{run.skippedCount} skipped</span>
        ) : null}
      </div>
      <div className="run-meta-grid">
        <div>
          <strong>Created</strong>
          <span>{formatDate(run.createdAt)}</span>
        </div>
        <div>
          <strong>Scheduled for</strong>
          <span>
            {run.scheduledFor ? formatDate(run.scheduledFor) : "Immediately"}
          </span>
        </div>
        <div>
          <strong>Accepted rate</strong>
          <span>{Number(run.successRate || 0)}%</span>
        </div>
        <div>
          <strong>Delivery rate</strong>
          <span>{Number(run.deliveryRate || 0)}%</span>
        </div>
        <div>
          <strong>Failure rate</strong>
          <span>{Number(run.failureRate || 0)}%</span>
        </div>
      </div>
      <div className="template-utility-row">
        <button type="button" className="ghost" onClick={onToggle}>
          {expanded ? "Hide recipients" : "Show recipients"}
        </button>
        {run.lastError ? (
          <div className="run-last-error">{run.lastError}</div>
        ) : null}
      </div>
      {expanded ? (
        <div className="campaign-recipient-table">
          {recipients.length ? (
            recipients.map((recipient) => {
              const visibleStatus =
                recipient.status === "sent"
                  ? recipient.deliveryStatus || "accepted"
                  : recipient.status;
              const failureMessage =
                recipient.deliveryError ||
                recipient.errorMessage ||
                recipient.failureReason ||
                "";
              const failureLabel = [
                recipient.metaErrorCode
                  ? `Meta #${recipient.metaErrorCode}`
                  : "",
                recipient.failureReason,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
              <div key={recipient.id} className="campaign-recipient-row">
                <div>
                  <strong>
                    {recipient.orderName ||
                      (recipient.recipientType === "custom"
                        ? "Custom recipient"
                        : "Shopify order")}
                  </strong>
                  <span>
                    {recipient.phoneE164 || "No phone"} ·{" "}
                    {recipient.recipientType === "custom"
                      ? "Custom number"
                      : "Shopify order"}
                  </span>
                  {failureMessage ? (
                    <small>
                      {failureLabel ? `${failureLabel}: ` : ""}
                      {failureMessage}
                    </small>
                  ) : null}
                </div>
                <div className="campaign-recipient-actions">
                  <span className={`status ${visibleStatus}`}>
                    {visibleStatus.replace(/_/g, " ")}
                  </span>
                  <TooltipButton
                    type="button"
                    onClick={() => onRetry(recipient.id)}
                    disabled={!recipient.canRetry || busy}
                    title={
                      recipient.canRetry
                        ? busy
                          ? "Please wait for the current action to finish."
                          : ""
                        : "Only failed recipients can be retried."
                    }
                  >
                    Retry
                  </TooltipButton>
                </div>
              </div>
              );
            })
          ) : (
            <div className="empty small-empty">No recipients recorded yet.</div>
          )}
        </div>
      ) : null}
    </article>
  );
}

function CampaignWhatsappPreview({ template, compact = false }) {
  const preview = normalizeTemplatePreviewModel(template);
  const headerType = preview.headerType;
  const bodySource = preview.bodyText || DEFAULT_BODY;
  const direction = getTemplateTextDirection(
    preview.language,
    `${preview.headerText || ""} ${bodySource} ${preview.footerText || ""}`,
  );
  const align = direction === "rtl" ? "right" : "left";
  const headerNodes = renderPreviewNodes(preview.headerText);
  const bodyNodes = renderPreviewNodes(bodySource);
  const footerNodes = renderPreviewNodes(preview.footerText);
  const { visibleButtons, overflowCount, hasOverflow } = getPreviewButtonLayout(
    preview.buttons,
  );

  return (
    <div
      className={`campaign-preview-shell ${compact ? "compact" : ""}`}
      data-compact={compact ? "true" : "false"}
    >
      <div className={`campaign-phone ${compact ? "compact" : ""}`}>
        <div className="campaign-phone-header">
          <span>B</span>
          <div>
            <strong>Business</strong>
            <small>Template preview</small>
          </div>
        </div>
        <div className="campaign-phone-body">
          <div className="campaign-message">
            {headerType === "IMAGE" ? (
              isHttpsUrl(preview.sampleMediaUrl) ? (
                <img
                  className="campaign-preview-image"
                  src={preview.sampleMediaUrl}
                  alt="Campaign template header"
                />
              ) : (
                <div className="campaign-preview-placeholder">
                  Image header preview
                </div>
              )
            ) : null}
            {headerType === "TEXT" && headerNodes.length ? (
              <strong
                className="campaign-preview-header"
                dir={direction}
                lang={preview.language || "en"}
                style={{
                  textAlign: align,
                  direction,
                  unicodeBidi: "plaintext",
                }}
              >
                {headerNodes}
              </strong>
            ) : null}
            <div
              className="campaign-preview-body"
              dir={direction}
              lang={preview.language || "en"}
              style={{
                textAlign: align,
                direction,
                unicodeBidi: "plaintext",
              }}
            >
              {bodyNodes.length ? bodyNodes : resolvePreviewText(bodySource)}
            </div>
            {footerNodes.length ? (
              <div
                className="campaign-preview-footer"
                dir={direction}
                lang={preview.language || "en"}
                style={{
                  textAlign: align,
                  direction,
                  unicodeBidi: "plaintext",
                }}
              >
                {footerNodes}
              </div>
            ) : null}
            <div className="campaign-preview-time">✓✓ 09:41</div>
          </div>
          {visibleButtons.length ? (
            <div className="preview-buttons">
              {visibleButtons.map((button, index) => (
                <div
                  className={`preview-button ${
                    button.type === "OVERFLOW" ? "overflow" : ""
                  }`}
                  key={`${button.action || button.text}-${index}`}
                >
                  <span>
                    {button.type === "URL"
                      ? "↗"
                      : button.type === "OVERFLOW"
                        ? "☰"
                        : "↩"}
                  </span>
                  {button.text || "Button text"}
                </div>
              ))}
            </div>
          ) : null}
          {hasOverflow ? (
            <div className="preview-overflow-note">
              Meta groups the other {overflowCount} buttons inside the options
              list.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CampaignTemplatePreview({ draft }) {
  return (
    <div className="preview-panel">
      <div className="side-heading">
        <h3>Live preview</h3>
        <p>
          This is how the WhatsApp template will look with sample order data.
        </p>
      </div>
      <CampaignWhatsappPreview template={draft} />
    </div>
  );
}

function CampaignValidationChecklist({ checks }) {
  return (
    <div className="checklist-panel">
      <div className="side-heading">
        <h3>Template checks</h3>
        <p>Fix anything red before saving the draft.</p>
      </div>
      <div className="checklist">
        {checks.map((check) => (
          <div
            className={`check-row ${check.ok ? "ok" : "bad"}`}
            key={check.label}
          >
            <span>{check.ok ? "✓" : "!"}</span>
            <div>
              <strong>{check.label}</strong>
              <small>{check.help}</small>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const styles = `
.campaign-page {
  padding: 18px;
  max-width: 1480px;
  margin: 0 auto;
  color: #172033;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.hero-card,
.panel {
  background: #fff;
  border: 1px solid #dfe6ee;
  border-radius: 24px;
  box-shadow: 0 14px 40px rgba(15, 23, 42, 0.08);
}

.hero-card {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  align-items: center;
  padding: 30px;
  margin-bottom: 18px;
  background: linear-gradient(135deg, #effaf5 0%, #f8fbff 56%, #fff7ed 100%);
}

.eyebrow {
  text-transform: uppercase;
  letter-spacing: 0.16em;
  font-weight: 800;
  color: #0f766e;
  margin: 0 0 6px;
}

.hero-card h1 {
  font-size: 42px;
  line-height: 1;
  margin: 0 0 10px;
}

.hero-card p {
  font-size: 16px;
  max-width: 780px;
  color: #5f6b7a;
  margin: 0;
}

.primary {
  background: #0f766e;
  color: #fff;
  border-color: #0f766e;
}

.hero-button {
  min-width: 240px;
}

.campaign-guidance-card {
  margin-bottom: 16px;
  border-radius: 20px;
  border: 1px solid #dfe6ee;
  background: #fff;
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.06);
  padding: 16px 18px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.campaign-guidance-card strong,
.campaign-guidance-card p {
  display: block;
}

.campaign-guidance-card strong {
  color: #172033;
  font-size: 15px;
}

.campaign-guidance-card p {
  margin: 6px 0 0;
  color: #667085;
  line-height: 1.5;
  font-size: 14px;
  max-width: 920px;
}

.campaign-guidance-card.locked {
  border-color: #fecaca;
  background: linear-gradient(135deg, #fff7f7 0%, #fff 100%);
}

.campaign-guidance-card.warning {
  border-color: #fde68a;
  background: linear-gradient(135deg, #fffbea 0%, #fff 100%);
}

.campaign-guidance-card.info {
  border-color: #bfdbfe;
  background: linear-gradient(135deg, #eff6ff 0%, #fff 100%);
}

.campaign-step-strip {
  margin-bottom: 18px;
}

.campaign-step-rail {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.campaign-step-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  border: 1px solid #e5edf5;
  background: linear-gradient(180deg, #ffffff 0%, #f8fbff 100%);
  border-radius: 18px;
  padding: 14px 16px;
}

.campaign-step-number {
  width: 34px;
  height: 34px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #0f766e;
  color: #fff;
  font-weight: 900;
  box-shadow: 0 8px 20px rgba(15, 118, 110, 0.18);
}

.campaign-step-copy strong,
.campaign-step-copy small {
  display: block;
}

.campaign-step-copy strong {
  color: #111827;
  font-size: 15px;
}

.campaign-step-copy small {
  margin-top: 4px;
  color: #667085;
  line-height: 1.35;
}

.campaign-step-arrow {
  color: #98a2b3;
  font-size: 22px;
  line-height: 1;
}

.campaign-stats-grid-refined {
  margin-bottom: 18px;
}

.campaign-overview-stat {
  display: flex;
  align-items: center;
  gap: 14px;
  border: 1px solid #e5edf5;
  border-radius: 22px;
  background: linear-gradient(180deg, #ffffff 0%, #fbfdff 100%);
  padding: 18px;
  min-height: 118px;
  box-shadow: 0 12px 28px rgba(15, 23, 42, 0.06);
}

.campaign-overview-icon {
  width: 56px;
  height: 56px;
  border-radius: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  font-weight: 900;
  flex: 0 0 auto;
}

.campaign-overview-icon.green {
  color: #0f766e;
  background: #dcfce7;
}

.campaign-overview-icon.mint {
  color: #047857;
  background: #d1fae5;
}

.campaign-overview-icon.amber {
  color: #b45309;
  background: #fef3c7;
}

.campaign-overview-icon.blue {
  color: #1d4ed8;
  background: #dbeafe;
}

.campaign-overview-icon.emerald {
  color: #166534;
  background: #dcfce7;
}

.campaign-overview-icon.rose {
  color: #be123c;
  background: #ffe4e6;
}

.campaign-overview-copy {
  min-width: 0;
}

.campaign-overview-copy strong,
.campaign-overview-copy span,
.campaign-overview-copy small {
  display: block;
}

.campaign-overview-copy strong {
  font-size: 32px;
  line-height: 1;
  color: #111827;
}

.campaign-overview-copy span {
  margin-top: 7px;
  color: #475467;
  font-weight: 800;
}

.campaign-overview-copy small {
  margin-top: 4px;
  color: #98a2b3;
}

.campaign-dashboard-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.65fr);
  gap: 18px;
  align-items: start;
  margin-bottom: 18px;
}

.campaign-dashboard-main {
  display: grid;
  gap: 18px;
}

.campaign-dashboard-head {
  display: flex;
  justify-content: space-between;
  gap: 18px;
  align-items: flex-start;
}

.campaign-dashboard-head h2 {
  margin: 6px 0 0;
  font-size: 34px;
  line-height: 1.05;
}

.campaign-dashboard-head p {
  margin: 8px 0 0;
  max-width: 760px;
  color: #667085;
}

.campaign-dashboard-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: flex-end;
}

.campaign-filter-shell {
  display: grid;
  gap: 14px;
}

.campaign-tab-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.campaign-tab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 1px solid #e4ebf3;
  background: #fff;
  color: #475467;
  border-radius: 999px;
  padding: 10px 14px;
  font-weight: 800;
}

.campaign-tab small {
  color: #98a2b3;
}

.campaign-tab.active {
  border-color: #8fe3cb;
  background: #ecfdf5;
  color: #0f766e;
  box-shadow: inset 0 0 0 1px rgba(15, 118, 110, 0.08);
}

.campaign-tab.active small {
  color: #0f766e;
}

.campaign-filter-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 190px;
  gap: 12px;
}

.campaign-search-field {
  position: relative;
  display: block;
}

.campaign-search-field > span {
  position: absolute;
  top: 50%;
  left: 14px;
  transform: translateY(-50%);
  color: #98a2b3;
  font-size: 18px;
  pointer-events: none;
}

.campaign-search-field input {
  margin-top: 0;
  padding-left: 40px;
}

.campaign-template-board {
  display: grid;
  gap: 14px;
}

.campaign-template-row-card {
  border: 1px solid #e5edf5;
  border-radius: 24px;
  background: linear-gradient(180deg, #ffffff 0%, #fbfdff 100%);
  padding: 18px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 18px;
  align-items: start;
  box-shadow: 0 14px 36px rgba(15, 23, 42, 0.05);
  transition: border-color 0.18s ease, box-shadow 0.18s ease,
    transform 0.18s ease;
}

.campaign-template-row-card:hover,
.campaign-template-row-card.focused {
  border-color: #a7f3d0;
  box-shadow: 0 18px 38px rgba(15, 118, 110, 0.09);
}

.campaign-template-row-main {
  display: flex;
  gap: 14px;
  min-width: 0;
}

.campaign-template-icon {
  width: 54px;
  height: 54px;
  border-radius: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  font-weight: 900;
  flex: 0 0 auto;
}

.campaign-template-icon.green {
  color: #0f766e;
  background: #dcfce7;
}

.campaign-template-icon.mint {
  color: #047857;
  background: #d1fae5;
}

.campaign-template-icon.blue {
  color: #1d4ed8;
  background: #dbeafe;
}

.campaign-template-icon.violet {
  color: #6d28d9;
  background: #ede9fe;
}

.campaign-template-icon.amber {
  color: #b45309;
  background: #fef3c7;
}

.campaign-template-icon.rose {
  color: #be123c;
  background: #ffe4e6;
}

.campaign-template-icon.peach {
  color: #c2410c;
  background: #ffedd5;
}

.campaign-template-icon.slate {
  color: #334155;
  background: #e2e8f0;
}

.campaign-template-row-copy {
  min-width: 0;
}

.campaign-template-row-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.campaign-template-row-title h3 {
  margin: 0;
  font-size: 28px;
  line-height: 1.05;
  color: #111827;
}

.campaign-template-row-subtitle {
  margin: 8px 0 0;
  color: #667085;
  font-size: 15px;
}

.campaign-template-row-chips {
  margin-top: 12px;
}

.campaign-template-row-side {
  min-width: 310px;
  display: grid;
  gap: 14px;
  justify-items: end;
}

.campaign-template-row-meta {
  text-align: right;
}

.campaign-template-row-meta strong,
.campaign-template-row-meta span {
  display: block;
}

.campaign-template-row-meta strong {
  color: #475467;
  font-size: 13px;
}

.campaign-template-row-meta span {
  margin-top: 4px;
  color: #111827;
  font-weight: 700;
}

.campaign-template-row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: flex-end;
}

.campaign-template-inline-preview {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: minmax(320px, 360px) minmax(0, 1fr);
  gap: 16px;
  padding-top: 6px;
}

.campaign-template-inline-preview-frame {
  border: 1px solid #e5edf5;
  border-radius: 22px;
  overflow: hidden;
  background: #fff;
}

.campaign-template-inline-notes {
  display: grid;
  gap: 12px;
  align-content: start;
}

.campaign-inline-note {
  border: 1px solid #edf2f7;
  border-radius: 18px;
  background: #f8fafc;
  padding: 14px;
}

.campaign-inline-note strong,
.campaign-inline-note span {
  display: block;
}

.campaign-inline-note strong {
  color: #344054;
  font-size: 13px;
}

.campaign-inline-note span {
  margin-top: 6px;
  color: #667085;
  line-height: 1.5;
}

.campaign-table-footer {
  color: #98a2b3;
  font-size: 13px;
}

.campaign-preview-sidebar {
  position: sticky;
  top: 18px;
  display: grid;
  align-content: start;
}

.campaign-live-sidebar {
  display: grid;
  gap: 16px;
}

.campaign-live-sidebar-top {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}

.campaign-live-sidebar-kicker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: #344054;
  font-weight: 800;
}

.live-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #22c55e;
  display: inline-block;
}

.campaign-live-sidebar-heading h3 {
  margin: 0;
  font-size: 26px;
  line-height: 1.05;
}

.campaign-live-sidebar-heading p {
  margin: 8px 0 0;
  color: #667085;
}

.campaign-live-sidebar-mini-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.campaign-sidebar-collapsed-preview {
  border: 1px dashed #cbd5e1;
  border-radius: 22px;
  background: linear-gradient(135deg, #f8fbff 0%, #f6fff8 100%);
  padding: 18px;
}

.campaign-sidebar-collapsed-preview strong,
.campaign-sidebar-collapsed-preview p,
.campaign-sidebar-collapsed-preview small {
  display: block;
}

.campaign-sidebar-collapsed-preview p {
  margin: 10px 0 0;
  color: #172033;
  line-height: 1.55;
}

.campaign-sidebar-collapsed-preview small {
  margin-top: 8px;
  color: #98a2b3;
}

.campaign-sidebar-action-card {
  display: grid;
  gap: 12px;
  border: 1px solid #e5edf5;
  border-radius: 22px;
  background: #fff;
  padding: 16px;
}

.campaign-sidebar-test-input {
  margin: 0;
}

.campaign-sidebar-test-input span {
  display: block;
  color: #344054;
  font-weight: 800;
  margin-bottom: 8px;
}

.campaign-sidebar-test-input input {
  margin-top: 0;
}

.campaign-sidebar-test-button,
.campaign-sidebar-launch-button {
  width: 100%;
}

.campaign-sidebar-readiness {
  display: grid;
  gap: 10px;
  border: 1px solid #e5edf5;
  border-radius: 22px;
  background: #fff;
  padding: 16px;
}

.campaign-sidebar-check {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 10px;
  align-items: center;
}

.campaign-sidebar-checkmark {
  width: 26px;
  height: 26px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #eef2f6;
  color: #98a2b3;
  font-weight: 900;
}

.campaign-sidebar-checkmark.ok {
  background: #dcfce7;
  color: #166534;
}

.campaign-sidebar-check strong,
.campaign-sidebar-check small {
  display: block;
}

.campaign-sidebar-check strong {
  color: #344054;
}

.campaign-sidebar-check small {
  margin-top: 2px;
  color: #98a2b3;
}

.campaign-library-shell {
  display: grid;
  gap: 18px;
  margin-bottom: 18px;
  background: linear-gradient(180deg, #ffffff 0%, #fbfdff 100%);
}

.campaign-library-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
}

.campaign-library-head h2 {
  margin: 6px 0 0;
  font-size: 34px;
  line-height: 1.05;
}

.campaign-library-head p {
  margin: 8px 0 0;
  max-width: 760px;
  color: #667085;
}

.campaign-library-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: flex-end;
}

.campaign-library-toolbar {
  display: grid;
  gap: 14px;
  padding: 18px;
  border: 1px solid #e7eef5;
  border-radius: 22px;
  background: linear-gradient(135deg, #f7fbff 0%, #f8fffb 100%);
}

.campaign-library-search {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 220px;
  gap: 12px;
}

.campaign-library-quickbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
}

.campaign-test-phone-field {
  display: grid;
  gap: 8px;
  margin: 0;
  min-width: min(100%, 320px);
}

.campaign-test-phone-field span {
  font-weight: 800;
  color: #344054;
}

.campaign-test-phone-field input {
  margin-top: 0;
}


.campaign-library-inline-note {
  
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 48px;
  border-radius: 16px;
  padding: 10px 14px;
  background: #f8fafc;
  border: 1px solid #dfe8ef;
  color: #667085;
  font-size: 13px;
  line-height: 1.5;
}

.campaign-library-inline-note strong {
  color: #172033;
}

.campaign-template-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 16px;
}

.campaign-grid-card {
  display: grid;
  gap: 10px;
  padding: 14px;
  border-radius: 20px;
  border: 1px solid #dfe8ef;
  background: #fff;
  box-shadow: 0 14px 30px rgba(15, 23, 42, 0.05);
  transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
  cursor: pointer;
}

.campaign-grid-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 18px 36px rgba(15, 118, 110, 0.08);
  border-color: #b7e8d8;
}

.campaign-grid-card.selected {
  border-color: #8adbc1;
  box-shadow: 0 20px 38px rgba(15, 118, 110, 0.12);
}

.campaign-grid-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.campaign-selected-pill {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 6px 10px;
  background: #ecfdf5;
  color: #0f766e;
  font-weight: 800;
  font-size: 12px;
}

.campaign-grid-preview {
  border: 0;
  padding: 0;
  background: transparent;
  text-align: left;
}

.campaign-grid-preview .campaign-preview-shell {
  margin: 0;
}

.campaign-grid-card-body {
  display: grid;
  gap: 10px;
}

.campaign-grid-card-head {
  display: flex;
  gap: 14px;
  justify-content: space-between;
  align-items: flex-start;
}

.campaign-grid-card-head h3 {
  margin: 0;
  font-size: 20px;
  line-height: 1.08;
  color: #101828;
}

.campaign-grid-card-head p {
  margin: 4px 0 0;
  color: #667085;
  font-size: 13px;
}

.campaign-grid-card-head small {
  color: #98a2b3;
  font-weight: 700;
  text-align: right;
  font-size: 12px;
}

.campaign-grid-card-chips {
  gap: 8px;
}

.campaign-grid-card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.campaign-grid-card-meta span {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 6px 10px;
  background: #f5f8fb;
  color: #475467;
  font-size: 12px;
  font-weight: 700;
}

.campaign-grid-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.campaign-grid-card-actions.secondary {
  padding-top: 4px;
}

.campaign-grid-card-actions.primary-row > button,
.campaign-grid-card-actions.primary-row > .tooltip-wrap,
.campaign-grid-card-actions.primary-row > .tooltip-wrap > button {
  flex: 1 1 0;
}

.campaign-grid-card-actions.secondary > button,
.campaign-grid-card-actions.secondary > .tooltip-wrap,
.campaign-grid-card-actions.secondary > .tooltip-wrap > button {
  flex: 1 1 calc(50% - 5px);
}

.campaign-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding-top: 4px;
}

.campaign-pagination-pages {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}

.campaign-page-pill {
  min-width: 42px;
  height: 42px;
  border-radius: 999px;
  border: 1px solid #d8e2ea;
  background: #fff;
  color: #475467;
  font-weight: 800;
}

.campaign-page-pill.active {
  border-color: #0f766e;
  background: #0f766e;
  color: #fff;
  box-shadow: 0 12px 24px rgba(15, 118, 110, 0.22);
}

.campaign-empty-state {
  min-height: 220px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed #d7e3ea;
  border-radius: 24px;
  background: linear-gradient(135deg, #fbfdff 0%, #f6fffb 100%);
}

.campaign-history-panel {
  margin-bottom: 18px;
}

.grid.two {
  display: grid;
  grid-template-columns: minmax(0, 1.08fr) minmax(380px, 0.92fr);
  gap: 18px;
}

.side-stack {
  display: grid;
  gap: 18px;
}

.panel {
  padding: 22px;
}

.section-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 14px;
  margin-bottom: 16px;
}

.section-head.small {
  align-items: center;
  margin-top: 18px;
}

.section-head h2,
.section-head h3 {
  margin: 0;
  color: #111827;
}

.section-head p {
  margin: 4px 0 0;
  color: #667085;
}

.section-actions,
.row-actions,
.card-actions,
.test-line,
.modal-actions,
.orders-toolbar,
.range-picker,
.pager,
.selected-template-copy {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.row-actions {
  justify-content: flex-end;
}

.pill,
.chips span {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  background: #e8f7ef;
  color: #10745d;
  font-weight: 750;
  padding: 6px 12px;
}

.pill.muted {
  background: #f1f5f9;
  color: #64748b;
}

.notice {
  padding: 14px 16px;
  border-radius: 16px;
  margin: 14px 0;
  font-weight: 750;
}

.notice.success {
  background: #ecfdf5;
  color: #047857;
}

.notice.error {
  background: #fef2f2;
  color: #b42318;
}

.notice.warning {
  background: #fffbeb;
  color: #92400e;
}

.template-list {
  display: grid;
  gap: 14px;
}

.template-card,
.template-row {
  border: 1px solid #e3e9f1;
  border-radius: 18px;
  background: #fbfdff;
  padding: 16px;
}

.template-card {
  display: grid;
  gap: 14px;
}

.template-card-head,
.template-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.template-card h3 {
  margin: 0;
  font-size: 20px;
}

.template-card p,
.template-row span {
  margin: 4px 0 0;
  color: #667085;
}

.template-alert {
  padding: 10px 12px;
  border-radius: 12px;
  background: #fff7ed;
  color: #9a3412;
  font-weight: 700;
}

.status {
  border-radius: 999px;
  padding: 6px 12px;
  background: #eef2ff;
  color: #334155;
  font-weight: 800;
  white-space: nowrap;
}

.status.approved {
  background: #dcfce7;
  color: #166534;
}

.status.draft {
  background: #eef2ff;
  color: #4338ca;
}

.status.rejected {
  background: #fee2e2;
  color: #991b1b;
}

.status.pending,
.status.in_review {
  background: #fef3c7;
  color: #92400e;
}

.status.failed,
.status.completed_with_failures {
  background: #fee2e2;
  color: #991b1b;
}

.status.processing,
.status.scheduled,
.status.completed,
.status.sent,
.status.accepted,
.status.delivered,
.status.read {
  background: #dcfce7;
  color: #166534;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chips span {
  background: #f1f5f9;
  color: #475569;
  font-size: 13px;
}

.chips .good {
  background: #dcfce7;
  color: #166534;
}

.template-preview-frame {
  border: 1px solid #e5e7eb;
  border-radius: 18px;
  background: #fff;
  overflow: hidden;
}

.template-utility-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.card-helper {
  font-size: 13px;
  line-height: 1.45;
  color: #667085;
}

.template-row > div {
  min-width: 0;
}

.template-row strong {
  display: block;
}

.template-row button {
  flex: 0 0 auto;
}

.status-row small {
  display: block;
  margin-top: 6px;
  color: #991b1b;
}

.empty,
.loading {
  border: 1px dashed #cbd5e1;
  border-radius: 16px;
  padding: 22px;
  text-align: center;
  color: #64748b;
  background: #f8fafc;
}

.modal-body {
  padding: 24px;
  max-height: 76vh;
  overflow: auto;
  color: #172033;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.details-modal {
  max-height: 86vh;
}

.details-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 0.9fr);
  gap: 18px;
}

.details-panel {
  display: grid;
  gap: 14px;
}

.details-card {
  border: 1px solid #e5e7eb;
  border-radius: 18px;
  background: #fff;
  padding: 16px;
  display: grid;
  gap: 12px;
}

.details-card pre {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  color: #172033;
}

.details-list {
  display: grid;
  gap: 10px;
}

.details-list div,
.details-button-row {
  border: 1px solid #edf2f7;
  border-radius: 14px;
  background: #f8fafc;
  padding: 12px;
  display: grid;
  gap: 4px;
}

.details-list span,
.details-button-row span {
  color: #667085;
  font-size: 13px;
  overflow-wrap: anywhere;
}

.details-button-list {
  display: grid;
  gap: 10px;
}

.details-preview-side {
  position: sticky;
  top: 0;
  align-self: start;
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

.full {
  display: block;
  margin-top: 14px;
}

.check-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.modal-body label,
.campaign-page label,
.campaign-template-builder label {
  display: block;
  font-weight: 800;
  color: #344054;
}

.modal-body input,
.modal-body select,
.modal-body textarea,
.campaign-page input,
.campaign-page select,
.campaign-page textarea,
.campaign-template-builder input,
.campaign-template-builder select,
.campaign-template-builder textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #cbd5e1;
  border-radius: 12px;
  padding: 11px 12px;
  font: inherit;
  margin-top: 6px;
  background: #fff;
}

.modal-body textarea,
.campaign-page textarea,
.campaign-template-builder textarea {
  resize: vertical;
}

.check-line input {
  width: auto;
  margin: 0;
}

.button-editor {
  border-top: 1px solid #e5e7eb;
  margin-top: 18px;
}

.button-row {
  display: grid;
  grid-template-columns: 150px 1fr 1.4fr 1fr auto;
  gap: 10px;
  align-items: end;
  margin-top: 10px;
  padding: 10px;
  border: 1px solid #edf2f7;
  border-radius: 14px;
  background: #f8fafc;
}

.ghost {
  background: #fff;
}

.ghost.danger {
  color: #b42318;
  border-color: #fecaca;
}

.orders-modal {
  display: grid;
  gap: 14px;
  max-height: calc(100vh - 56px);
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 4px;
}

.modal-body.orders-modal {
  
  overflow-y: auto;
}

.campaign-modal-stepper {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.campaign-modal-step {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  border: 1px solid #e5edf5;
  border-radius: 18px;
  background: linear-gradient(180deg, #ffffff 0%, #f9fbff 100%);
  padding: 14px 16px;
  text-align: left;
}

.campaign-modal-step.active {
  border-color: #8fe3cb;
  box-shadow: 0 14px 28px rgba(15, 118, 110, 0.1);
}

.campaign-modal-step.complete:not(.active) {
  border-color: #bbf7d0;
  background: #f0fdf4;
}

.campaign-modal-step-number {
  width: 34px;
  height: 34px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #e5edf5;
  color: #344054;
  font-weight: 900;
}

.campaign-modal-step.active .campaign-modal-step-number,
.campaign-modal-step.complete .campaign-modal-step-number {
  background: #0f766e;
  color: #fff;
}

.campaign-modal-step-copy strong,
.campaign-modal-step-copy small {
  display: block;
}

.campaign-modal-step-copy strong {
  color: #111827;
  font-size: 15px;
}

.campaign-modal-step-copy small {
  margin-top: 4px;
  color: #667085;
  line-height: 1.4;
}

.campaign-runs-panel {
  display: grid;
  gap: 16px;
  margin-bottom: 20px;
}

.campaign-stats-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 12px;
}

.stat-card {
  border: 1px solid #e5e7eb;
  border-radius: 18px;
  background: #f8fafc;
  padding: 16px;
  display: grid;
  gap: 6px;
}

.stat-card strong {
  font-size: 28px;
  line-height: 1;
  color: #111827;
}

.stat-card span {
  color: #667085;
  font-size: 13px;
}

.run-list {
  display: grid;
  gap: 14px;
}

.campaign-run-card {
  border: 1px solid #e5e7eb;
  border-radius: 22px;
  background: #fff;
  padding: 18px;
  display: grid;
  gap: 14px;
}

.run-meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}

.run-meta-grid div {
  border: 1px solid #edf2f7;
  border-radius: 14px;
  background: #f8fafc;
  padding: 12px;
}

.run-meta-grid strong,
.run-meta-grid span {
  display: block;
}

.run-meta-grid span {
  color: #667085;
  margin-top: 4px;
}

.run-last-error {
  color: #b42318;
  font-size: 13px;
  font-weight: 700;
}

.campaign-recipient-table {
  display: grid;
  gap: 10px;
}

.campaign-recipient-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  border: 1px solid #edf2f7;
  border-radius: 16px;
  padding: 12px;
  background: #f8fafc;
}

.campaign-recipient-row span,
.campaign-recipient-row small {
  display: block;
  color: #667085;
}

.campaign-recipient-row small {
  margin-top: 4px;
}

.campaign-recipient-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.orders-toolbar input {
  margin-top: 0;
}

.orders-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
}

.orders-modal-header-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px 14px;
}

.orders-modal-helper {
  color: #667085;
  font-size: 13px;
  line-height: 1.45;
}

.orders-modal-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(330px, 0.85fr);
  gap: 14px;
  align-items: start;
  overflow: visible;
}

.orders-sidebar {
  display: grid;
  gap: 14px;
  align-content: start;
}

.recipients-step-layout {
  align-items: start;
}

.schedule-step-layout {
  grid-template-columns: minmax(0, 1.08fr) minmax(340px, 0.92fr);
  align-items: start;
}

.range-picker {
  align-items: end;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 10px;
}

.range-picker-card {
  border: 1px solid #edf2f7;
  border-radius: 16px;
  background: #f8fafc;
  padding: 12px;
  display: grid;
  gap: 12px;
}

.range-picker-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.range-picker-head p {
  margin: 4px 0 0;
  color: #667085;
  font-size: 13px;
  line-height: 1.45;
}

.range-picker label {
  margin: 0;
}

.range-picker select {
  margin-top: 6px;
}

.range-picker-action {
  height: fit-content;
  align-self: end;
}

.orders-panel {
  border: 1px solid #e5e7eb;
  border-radius: 18px;
  background: #fff;
  padding: 14px;
  display: grid;
  gap: 12px;
  align-content: start;
}

.orders-section-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.orders-section-head p {
  margin: 4px 0 0;
  color: #667085;
  font-size: 13px;
  line-height: 1.45;
}

.campaign-send-schedule {
  display: flex;
  gap: 12px;
  align-items: end;
  flex-wrap: wrap;
}

.campaign-send-schedule label {
  min-width: 180px;
  flex: 1 1 180px;
}

.campaign-send-schedule label span {
  display: block;
  margin-bottom: 6px;
  color: #344054;
  font-weight: 800;
}

.orders-toolbar-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: flex-end;
}

.orders-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: min(44vh, 440px);
  overflow: auto;
  padding-right: 4px;
  padding-bottom: 4px;
  align-content: start;
}

.order-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  border: 1px solid #e5e7eb;
  border-radius: 16px;
  padding: 12px;
  background: #fff;
}

.order-row input {
  width: auto;
  margin: 0;
}

.order-row span,
.order-row small {
  display: block;
  color: #667085;
  font-weight: 500;
}

.order-row em {
  font-style: normal;
  color: #94a3b8;
  font-weight: 700;
}

.selected-template-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.campaign-modal-template-panel {
  border: 1px solid #dfe8ef;
  border-radius: 18px;
  background: linear-gradient(135deg, #edf9f3 0%, #f6fbff 100%);
  padding: 14px;
  display: grid;
  gap: 12px;
}

.campaign-modal-template-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.campaign-modal-template-head strong,
.campaign-modal-template-head span,
.campaign-modal-template-head small {
  display: block;
}

.campaign-modal-template-head span {
  margin-top: 3px;
  color: #667085;
  font-size: 13px;
}

.campaign-modal-template-head small {
  margin-top: 7px;
  color: #4b5563;
  font-size: 12px;
  line-height: 1.45;
}

.campaign-modal-template-preview .campaign-preview-shell.compact {
  margin: 0;
}

.campaign-recipient-summary {
  width: 100%;
  padding: 10px;
  display: grid;
  gap: 8px;
  background: linear-gradient(135deg, #edf9f3 0%, #f4f9ff 100%);
}

.campaign-recipient-summary-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.campaign-recipient-summary-avatar {
  width: 34px;
  height: 34px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0f6f60;
  color: #fff;
  font-weight: 900;
  flex: 0 0 auto;
}

.campaign-recipient-summary-head strong,
.campaign-recipient-summary-head small {
  display: block;
}

.campaign-recipient-summary-head small {
  color: #667085;
}

.campaign-recipient-summary-bubble {
  border-radius: 16px;
  background: #fff;
  border: 1px solid #e2e8f0;
  padding: 12px;
  box-shadow: 0 8px 18px rgba(15, 23, 42, 0.08);
}

.campaign-recipient-summary-bubble strong,
.campaign-recipient-summary-bubble small,
.campaign-recipient-summary-bubble p {
  display: block;
}

.campaign-recipient-summary-bubble p {
  margin: 6px 0;
  color: #172033;
  font-size: 12px;
  line-height: 1.45;
}

.campaign-recipient-summary-bubble small {
  color: #667085;
  font-size: 12px;
}

.custom-recipient-card {
  border: 1px solid #e5e7eb;
  border-radius: 16px;
  background: #f8fafc;
  padding: 14px;
  display: grid;
  gap: 12px;
  align-content: start;
}

.campaign-schedule-card {
  border: 1px solid #e5e7eb;
  border-radius: 16px;
  background: #fff;
  padding: 14px;
  display: grid;
  gap: 12px;
  align-content: start;
}

.schedule-card-layout {
  margin-right: 0;
}

.campaign-schedule-stage {
  display: grid;
  gap: 14px;
  border: 1px solid #e5e7eb;
  border-radius: 18px;
  background: #fff;
  padding: 16px;
  align-content: start;
}

.campaign-schedule-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.campaign-schedule-option {
  display: grid;
  gap: 6px;
  text-align: left;
  border-radius: 18px;
  border: 1px solid #dbe5ef;
  background: linear-gradient(180deg, #ffffff 0%, #f9fbff 100%);
  padding: 16px;
}

.campaign-schedule-option.active {
  border-color: #8fe3cb;
  background: #ecfdf5;
  box-shadow: 0 14px 28px rgba(15, 118, 110, 0.08);
}

.campaign-schedule-option strong {
  color: #111827;
  font-size: 15px;
}

.campaign-schedule-option p {
  margin: 0;
  color: #667085;
  line-height: 1.5;
  font-size: 13px;
}

.campaign-schedule-time-field {
  display: grid;
  gap: 8px;
  margin: 0;
}

.campaign-schedule-time-field span {
  color: #344054;
  font-weight: 800;
}

.campaign-schedule-time-field input {
  margin-top: 0;
}

.campaign-schedule-time-field small {
  color: #667085;
}

.campaign-step-summary-card,
.campaign-final-review-card {
  border: 1px solid #e5edf5;
  border-radius: 18px;
  background: linear-gradient(180deg, #ffffff 0%, #f9fbff 100%);
  padding: 16px;
  display: grid;
  gap: 12px;
}

.campaign-step-summary-card > strong,
.campaign-final-review-card > strong {
  color: #111827;
}

.campaign-step-summary-card > small {
  color: #667085;
  line-height: 1.45;
}

.campaign-step-summary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.campaign-step-summary-grid.review-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.campaign-step-summary-grid div {
  border: 1px solid #edf2f7;
  border-radius: 14px;
  background: #fff;
  padding: 12px;
}

.campaign-step-summary-grid span,
.campaign-step-summary-grid strong {
  display: block;
}

.campaign-step-summary-grid span {
  color: #667085;
  font-size: 12px;
}

.campaign-step-summary-grid strong {
  margin-top: 6px;
  color: #111827;
  font-size: 24px;
  line-height: 1;
}

.campaign-review-list {
  display: grid;
  gap: 6px;
}

.campaign-review-list small {
  color: #667085;
  line-height: 1.45;
}

.custom-recipient-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.custom-recipient-head p {
  margin: 4px 0 0;
  color: #667085;
  font-size: 13px;
  line-height: 1.45;
}

.custom-recipient-entry {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
}

.custom-recipient-entry textarea {
  margin-top: 0;
  resize: vertical;
  min-height: 74px;
}

.custom-recipient-actions {
  display: grid;
  gap: 10px;
  align-content: start;
}

.custom-recipient-hint {
  color: #667085;
  font-size: 12px;
  line-height: 1.45;
}

.custom-recipient-list {
  display: grid;
  gap: 10px;
}

.custom-recipient-chip {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  border: 1px solid #dbe5ef;
  border-radius: 14px;
  background: #fff;
  padding: 12px;
}

.custom-recipient-chip.invalid {
  border-color: #fecaca;
  background: #fef2f2;
}

.custom-recipient-chip strong,
.custom-recipient-chip small {
  display: block;
}

.custom-recipient-chip small {
  margin-top: 4px;
  color: #667085;
  font-size: 12px;
}

.compact-notice {
  margin: 0;
  padding: 12px 14px;
  font-size: 13px;
}

.pager {
  justify-content: center;
  margin-top: 2px;
}

.sticky-actions {
  position: sticky;
  bottom: -24px;
  background: #fff;
  border-top: 1px solid #e5e7eb;
  padding-top: 14px;
  margin-top: 4px;
  flex: 0 0 auto;
}

.campaign-modal-footer-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: flex-end;
}

.tooltip-wrap {
  display: inline-flex;
}

button {
  border: 1px solid #cbd5e1;
  background: #fff;
  border-radius: 12px;
  padding: 10px 14px;
  font-weight: 800;
  cursor: pointer;
}

button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.format-toolbar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}

.format-chip,
.format-emoji {
  border-radius: 999px;
  background: #fff;
  padding: 8px 14px;
}

.format-emoji {
  padding: 8px 10px;
  min-width: 42px;
}

.campaign-template-builder {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(360px, 0.7fr);
  min-height: 76vh;
  max-height: 86vh;
  background: #f6f9fc;
  color: #172033;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.campaign-template-editor {
  display: grid;
  gap: 18px;
  align-content: start;
  overflow: auto;
  
  padding: 24px 28px;
  min-width: 0;
}

.campaign-template-side {
  border-left: 1px solid #e5e7eb;
  background: linear-gradient(180deg, #f8fbff 0%, #f7fff9 100%);
  overflow: auto;
  padding: 22px;
  display: grid;
  gap: 16px;
  align-content: start;
}


.campaign-editor-card,
.preview-panel,
.checklist-panel {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 22px;
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.07);
  padding: 18px;
}

.builder-step {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 16px;
}

.builder-step > span {
  width: 34px;
  height: 34px;
  border-radius: 999px;
  background: #0f766e;
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 900;
  flex: 0 0 auto;
}

.builder-step h3,
.side-heading h3 {
  margin: 0;
  color: #111827;
  font-size: 20px;
}

.builder-step p,
.side-heading p {
  margin: 4px 0 0;
  color: #667085;
  line-height: 1.4;
}

.field-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  color: #667085;
  font-size: 13px;
  margin-top: 7px;
}

.variable-section {
  margin-top: 14px;
}

.variable-section.compact {
  margin-top: 10px;
}

.variable-section p {
  margin: 0 0 8px;
  color: #344054;
  font-weight: 900;
}

.variable-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.variable-chip {
  border-color: #bfdbfe;
  background: #eff6ff;
  color: #1d4ed8;
  border-radius: 999px;
  padding: 9px 12px;
}

.image-check {
  height: 100%;
  align-items: center;
  justify-content: flex-start;
  border: 1px solid #dbeafe;
  background: #eff6ff;
  border-radius: 14px;
  padding: 12px;
  margin-top: 25px;
}

.button-editor.embedded {
  border-top: 0;
  margin-top: 0;
}

.button-editor.embedded .button-row {
  grid-template-columns: 140px minmax(160px, 1fr) minmax(190px, 1.3fr) minmax(150px, 0.8fr) auto;
  align-items: end;
  background: #f8fafc;
  border-color: #e2e8f0;
}

.button-editor.embedded .button-row label {
  font-size: 13px;
}

.small-empty {
  padding: 14px;
  margin-top: 10px;
}

.preview-panel,
.checklist-panel {
  position: relative;
}

.campaign-preview-shell {
  margin-top: 14px;
  border-radius: 22px;
  padding: 26px;
  background: linear-gradient(135deg, #e6f6ef 0%, #eff8ff 58%, #f8f4ff 100%);
  border: 1px solid #e2e8f0;
}

.campaign-preview-shell.compact {
  margin-top: 0;
  padding: 10px;
  border-radius: 14px;
}

.campaign-phone {
  max-width: 340px;
  margin: 0 auto;
  background: #e2d8ce;
  border-radius: 24px;
  overflow: hidden;
  box-shadow: 0 24px 45px rgba(15, 23, 42, 0.18);
}

.campaign-phone.compact {
  max-width: 232px;
  border-radius: 16px;
  box-shadow: 0 12px 24px rgba(15, 23, 42, 0.12);
}

.campaign-phone-header {
  display: flex;
  gap: 12px;
  align-items: center;
  background: #0f6f60;
  color: #fff;
  padding: 16px;
}

.campaign-phone.compact .campaign-phone-header {
  padding: 9px 11px;
  gap: 8px;
}

.campaign-phone.compact .campaign-phone-header span {
  width: 32px;
  height: 32px;
  font-size: 13px;
}

.campaign-phone.compact .campaign-phone-header strong {
  font-size: 14px;
}

.campaign-phone.compact .campaign-phone-header small {
  font-size: 11px;
}

.campaign-phone-header span {
  width: 42px;
  height: 42px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.18);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 900;
}

.campaign-phone-header strong,
.campaign-phone-header small {
  display: block;
}

.campaign-phone-header small {
  opacity: 0.72;
}

.campaign-phone-body {
  padding: 14px;
}

.campaign-phone.compact .campaign-phone-body {
  padding: 10px;
}

.campaign-phone.compact .campaign-message {
  border-radius: 14px;
  padding: 10px;
}

.campaign-message {
  background: #fff;
  border-radius: 16px;
  padding: 14px;
  box-shadow: 0 2px 6px rgba(15, 23, 42, 0.12);
  color: #172033;
}

.campaign-preview-image {
  width: 100%;
  height: 150px;
  object-fit: cover;
  border-radius: 12px;
  margin-bottom: 12px;
}

.campaign-preview-placeholder {
  height: 150px;
  border-radius: 12px;
  margin-bottom: 12px;
  background: linear-gradient(135deg, #dbeafe, #f0fdf4);
  border: 1px dashed #93c5fd;
  color: #2563eb;
  font-weight: 900;
  display: flex;
  align-items: center;
  justify-content: center;
}

.campaign-phone.compact .campaign-preview-image,
.campaign-phone.compact .campaign-preview-placeholder {
  height: 92px;
  border-radius: 10px;
  margin-bottom: 8px;
}

.campaign-preview-header {
  display: block;
  font-size: 16px;
  margin-bottom: 8px;
}

.campaign-preview-body {
  white-space: pre-wrap;
  font-size: 15px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.campaign-phone.compact .campaign-preview-header {
  font-size: 13px;
  margin-bottom: 6px;
}

.campaign-phone.compact .campaign-preview-body {
  font-size: 11px;
  line-height: 1.38;
}

.campaign-preview-footer {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid #e5e7eb;
  color: #8a94a6;
  font-size: 13px;
}

.campaign-preview-time {
  text-align: right;
  color: #98a2b3;
  font-size: 12px;
  margin-top: 8px;
}

.campaign-phone.compact .campaign-preview-footer {
  margin-top: 8px;
  padding-top: 7px;
  font-size: 11px;
}

.campaign-phone.compact .campaign-preview-time {
  margin-top: 6px;
  font-size: 10px;
}

.preview-buttons {
  display: grid;
  gap: 8px;
  margin-top: 10px;
}

.campaign-phone.compact .preview-buttons {
  gap: 6px;
  margin-top: 8px;
}

.preview-button {
  background: #fff;
  color: #0f766e;
  border-radius: 12px;
  padding: 11px;
  text-align: center;
  font-weight: 900;
  box-shadow: 0 1px 4px rgba(15, 23, 42, 0.12);
  overflow-wrap: anywhere;
}

.campaign-phone.compact .preview-button {
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 11px;
}

.preview-button.overflow {
  color: #1f8a6e;
}

.preview-button span {
  margin-right: 6px;
}

.preview-overflow-note {
  margin-top: 8px;
  text-align: center;
  color: #6b7280;
  font-size: 12px;
  line-height: 1.4;
}

.campaign-phone.compact .preview-overflow-note {
  margin-top: 6px;
  font-size: 10px;
}

.checklist {
  display: grid;
  gap: 10px;
  margin-top: 14px;
}

.check-row {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 10px;
  align-items: flex-start;
  border-radius: 16px;
  border: 1px solid #e5e7eb;
  padding: 12px;
  background: #f8fafc;
}

.check-row > span {
  width: 24px;
  height: 24px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 900;
}

.check-row.ok {
  background: #f0fdf4;
  border-color: #bbf7d0;
}

.check-row.ok > span {
  background: #16a34a;
  color: #fff;
}

.check-row.bad {
  background: #fff7ed;
  border-color: #fed7aa;
}

.check-row.bad > span {
  background: #f97316;
  color: #fff;
}

.check-row strong,
.check-row small {
  display: block;
}

.check-row small {
  color: #667085;
  margin-top: 3px;
  line-height: 1.35;
}

.campaign-page {
  padding: 20px 22px 34px;
  max-width: 1580px;
  margin: 0 auto;
}

.panel {
  padding: 24px;
}

.hero-card {
  padding: 26px 28px;
  margin-bottom: 16px;
}

.hero-card h1 {
  font-size: 34px;
  line-height: 1.04;
}

.hero-card p {
  max-width: 760px;
  color: #667085;
}

.hero-button {
  min-width: 210px;
}

.campaign-step-strip {
  padding: 16px;
}

.campaign-step-rail {
  gap: 10px;
}

.campaign-step-card {
  padding: 12px 14px;
  border-radius: 16px;
}

.campaign-stats-grid-refined {
  gap: 14px;
}

.campaign-overview-stat {
  min-height: 104px;
  padding: 16px 18px;
}

.campaign-overview-copy strong {
  font-size: 28px;
}

.campaign-dashboard-grid {
  grid-template-columns: minmax(0, 1.55fr) minmax(360px, 0.7fr);
  gap: 18px;
}

.campaign-dashboard-main {
  gap: 16px;
}

.campaign-dashboard-head {
  align-items: flex-end;
}

.campaign-dashboard-head h2 {
  font-size: 28px;
  margin-top: 4px;
}

.campaign-dashboard-actions {
  align-items: center;
}

.campaign-filter-shell {
  gap: 12px;
}

.campaign-filter-row {
  grid-template-columns: minmax(0, 1fr) 220px;
  gap: 14px;
}

.campaign-template-board {
  gap: 12px;
}

.campaign-template-row-card {
  padding: 18px 20px;
  gap: 14px;
  border-radius: 20px;
  grid-template-columns: 1fr;
}

.campaign-template-row-shell {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 16px;
  align-items: start;
}

.campaign-template-row-main {
  gap: 16px;
  min-width: 0;
}

.campaign-template-icon {
  width: 50px;
  height: 50px;
  border-radius: 16px;
  font-size: 22px;
}

.campaign-template-row-copy {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.campaign-template-row-title {
  gap: 10px;
  align-items: center;
}

.campaign-template-row-title h3 {
  font-size: 18px;
  line-height: 1.2;
  max-width: 100%;
  overflow-wrap: anywhere;
}

.campaign-template-row-subtitle {
  margin: 0;
  font-size: 13px;
  color: #667085;
}

.campaign-template-row-chips {
  margin-top: 0;
}

.campaign-template-row-side {
  min-width: 0;
  display: grid;
  gap: 12px;
  justify-items: stretch;
  align-items: start;
}

.campaign-template-row-meta {
  text-align: right;
  background: #f8fafc;
  border: 1px solid #e5edf5;
  border-radius: 16px;
  padding: 12px 14px;
  min-width: 180px;
}

.campaign-template-row-meta strong {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #98a2b3;
}

.campaign-template-row-meta span {
  margin-top: 6px;
  font-size: 14px;
}

.campaign-template-row-meta small {
  display: block;
  margin-top: 6px;
  color: #667085;
  font-size: 12px;
}

.campaign-template-row-actions {
  justify-content: flex-end;
  gap: 8px;
}

.campaign-template-row-actions button,
.campaign-template-row-actions .tooltip-wrap {
  flex: 0 0 auto;
}

.campaign-template-row-actions .primary {
  min-width: 154px;
}

.campaign-template-inline-preview {
  grid-template-columns: minmax(280px, 320px) minmax(0, 1fr);
  gap: 14px;
  margin-top: 4px;
}

.campaign-template-inline-preview-frame {
  border-radius: 18px;
}

.campaign-inline-note {
  border-radius: 16px;
  padding: 12px 14px;
}

.campaign-preview-sidebar {
  padding: 22px;
  border-radius: 24px;
  min-height: 100%;
}

.campaign-live-sidebar {
  gap: 14px;
}

.campaign-live-sidebar-heading h3 {
  font-size: 20px;
  line-height: 1.15;
}

.campaign-live-sidebar-heading p {
  margin-top: 6px;
  font-size: 13px;
}

.campaign-live-sidebar-mini-actions {
  gap: 8px;
}

.campaign-live-preview-wrap .campaign-preview-shell {
  margin-top: 0;
  padding: 18px 16px;
  border-radius: 18px;
}

.campaign-live-preview-wrap .campaign-phone {
  max-width: 290px;
}

.campaign-sidebar-collapsed-preview {
  border-radius: 18px;
  padding: 16px;
}

.campaign-sidebar-collapsed-preview strong {
  font-size: 15px;
}

.campaign-sidebar-collapsed-preview p {
  line-height: 1.6;
  margin-top: 8px;
}

.campaign-sidebar-action-card,
.campaign-sidebar-readiness {
  border-radius: 18px;
  padding: 14px;
}

.campaign-sidebar-launch-button,
.campaign-sidebar-test-button {
  min-height: 44px;
}

.campaign-history-panel {
  padding: 24px;
}

.run-list {
  gap: 12px;
}

.campaign-run-card {
  border-radius: 20px;
}

.campaign-table-footer {
  padding-top: 2px;
}

@media (max-width: 1350px) {
  .campaign-step-rail,
  .campaign-stats-grid,
  .campaign-dashboard-grid,
  .campaign-filter-row,
  .campaign-template-inline-preview,
  .orders-modal-layout,
  .campaign-step-summary-grid,
  .campaign-schedule-options {
    grid-template-columns: 1fr;
  }

  .campaign-library-search {
    grid-template-columns: 1fr;
  }

  .campaign-library-quickbar {
    flex-direction: column;
    align-items: stretch;
  }

  .campaign-library-summary-strip {
    justify-content: flex-start;
  }

  .campaign-template-row-shell {
    grid-template-columns: 1fr;
  }

  .campaign-preview-sidebar {
    position: static;
  }

  .campaign-template-row-card {
    grid-template-columns: 1fr;
  }

  .campaign-template-row-side {
    min-width: 0;
    justify-items: stretch;
  }

  .campaign-template-row-meta {
    text-align: left;
    min-width: 0;
  }

  .campaign-template-row-actions {
    justify-content: flex-start;
  }

  .campaign-template-builder {
    grid-template-columns: 1fr;
    max-height: none;
  }

  .campaign-template-side {
    border-left: 0;
    border-top: 1px solid #e5e7eb;
  }

  .campaign-template-editor {
    overflow: visible;
  }

  .campaign-phone {
    max-width: 380px;
  }
}

@media (max-width: 900px) {
  .hero-card,
  .template-card-head,
  .template-row,
  .section-actions,
  .row-actions,
  .template-utility-row,
  .test-line,
  .modal-actions,
  .selected-template-copy,
  .card-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .grid.two,
  .details-grid,
  .form-grid,
  .orders-modal-layout,
  .orders-toolbar,
  .range-picker,
  .custom-recipient-entry,
  .campaign-modal-stepper,
  .campaign-step-summary-grid.review-grid {
    grid-template-columns: 1fr;
  }

  .campaign-stats-grid,
  .run-meta-grid {
    grid-template-columns: 1fr 1fr;
  }

  .campaign-step-card,
  .campaign-overview-stat,
  .campaign-template-row-main,
  .campaign-live-sidebar-top,
  .campaign-live-sidebar-mini-actions,
  .campaign-dashboard-head,
  .campaign-dashboard-actions,
  .campaign-template-row-title,
  .campaign-library-head,
  .campaign-library-actions,
  .campaign-grid-card-head {
    align-items: stretch;
    flex-direction: column;
  }

  .campaign-guidance-card {
    flex-direction: column;
    align-items: stretch;
  }

  .campaign-grid-card-actions.secondary > button,
  .campaign-grid-card-actions.secondary > .tooltip-wrap,
  .campaign-grid-card-actions.secondary > .tooltip-wrap > button,
  .campaign-grid-card-actions.primary-row > button,
  .campaign-grid-card-actions.primary-row > .tooltip-wrap,
  .campaign-grid-card-actions.primary-row > .tooltip-wrap > button {
    flex: 1 1 100%;
    width: 100%;
  }

  .campaign-template-row-actions {
    width: 100%;
  }

  .campaign-template-row-actions > button,
  .campaign-template-row-actions > .tooltip-wrap,
  .campaign-template-row-actions > .tooltip-wrap > button {
    width: 100%;
  }

  .campaign-step-card {
    grid-template-columns: 1fr;
  }

  .campaign-step-arrow {
    display: none;
  }

  .button-row,
  .button-editor.embedded .button-row {
    grid-template-columns: 1fr;
  }

  .order-row {
    grid-template-columns: auto 1fr;
  }

  .order-row em {
    grid-column: 2;
  }

  .hero-card h1 {
    font-size: 34px;
  }

  .hero-button {
    min-width: 0;
    width: 100%;
  }

  .selected-template-card {
    grid-template-columns: 1fr;
  }

  .selected-template-preview {
    width: 100%;
    justify-self: stretch;
  }

  .campaign-template-inline-preview-frame {
    max-width: 100%;
  }

  .orders-section-head,
  .orders-toolbar-actions,
  .orders-modal-header-row,
  .range-picker-head,
  .campaign-send-schedule,
  .custom-recipient-head,
  .custom-recipient-chip,
  .campaign-pagination,
  .campaign-modal-footer-actions {
    flex-direction: column;
    align-items: stretch;
  }

  .campaign-recipient-row {
    grid-template-columns: 1fr;
  }

  .campaign-recipient-actions {
    justify-content: flex-start;
  }

  .campaign-pagination-pages {
    justify-content: flex-start;
  }

  .sticky-actions {
    bottom: 0;
  }
}
`;

export const headers = (headersArgs) => boundary.headers(headersArgs);
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
