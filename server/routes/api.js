import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import Shop from "../models/Shop.js";
import CodAttempt from "../models/CodAttempt.js";
import Metric from "../models/Metric.js";
import AuditLog from "../models/AuditLog.js";
import WaMessageLog from "../models/WaMessageLog.js";
import { requireBilling } from "../middleware/requireBilling.js";
import billingRoutes from "./billing.js";
import blocklistRoutes from "./blocklist.js";
import agentManagementRoutes from "./agentManagement.js";

import { getBillingStatus } from "../services/billing.js";
import {
  canSendWhatsApp,
  getInitiatedConversationQuotaStatus,
  getUsageRanges,
  incrementWhatsAppUsage,
} from "../services/usage.js";
import { agenda } from "../jobs/agenda.js";
import { logAudit } from "../services/audit.js";
import { getAdminClient, listShopifyOrders } from "../services/shopifyAdmin.js";
import { getPlan, PLAN_KEYS, SENDER_MODES } from "../services/plans.js";
import { inferCountryCodeFromE164 } from "../services/phone.js";
import {
  ensureOwnNumberCloudRegistration,
  sendCodConfirmReplyTemplate,
  sendWhatsAppText,
} from "../services/whatsapp.js";
import {
  debugMetaAccessToken,
  exchangeMetaLongLivedToken,
  exchangeMetaOAuthCode,
  getMetaTokenDebugHints,
  getMetaTokenExpiryDate,
  isMetaAccessTokenExpired,
  maybeRefreshByonAccessToken,
} from "../services/metaByonAuth.js";
import {
  isStoredOwnNumberCloudConnected,
  resolveOwnNumberRegistrationStatus,
} from "../services/ownNumberRegistration.js";
import templateAutomationRoutes from "./templateAutomation.js";
import campaignRoutes from "./campaigns.js";
import {
  ensureAutomationFlowConfigs,
  FLOW_KEYS,
} from "../services/templateCatalog.js";
import {
  listConversationMessages,
  listConversationThreads,
} from "../services/messageInbox.js";
import { scheduleAttemptFromShopifyOrder } from "../services/codFlow.js";

const router = express.Router();

router.use("/agents", agentManagementRoutes);
const META_FEATURE_TYPE_WABA_APP = "whatsapp_business_app_onboarding";
const META_STANDARD_WEBHOOK_FIELDS = [
  "messages",
  "message_template_status_update",
];
const META_COEXISTENCE_WEBHOOK_FIELDS = [
  "history",
  "smb_app_state_sync",
  "smb_message_echoes",
];

const OWN_NUMBER_TEMPLATE_PACK = [
  {
    key: "cod_confirm_new",
    templateName: "orderx_cod_confirm_new",
    language: "en",
  },
  {
    key: "cod_order_dispatched",
    templateName: "orderx_cod_order_dispatched",
    language: "en",
  },
  {
    key: "cod_tracking_updated",
    templateName: "orderx_cod_tracking_updated",
    language: "en",
  },
  {
    key: "cod_order_cancelled",
    templateName: "orderx_cod_order_cancelled",
    language: "en",
  },
  {
    key: "cod_order_update_generic",
    templateName: "orderx_cod_order_update_generic",
    language: "en",
  },
];

const OWN_NUMBER_TEMPLATE_DEFINITIONS = {
  cod_confirm_new: {
    key: "cod_confirm_new",
    templateName: "orderx_cod_confirm_new",
    language: "en",
    category: "UTILITY",
    exampleBodyValues: [
      "Abdul",
      "OrderX Store",
      "#10321",
      "2x T-shirt, 1x Shoes",
      "PKR 3,250",
      "123 Main Street, Lahore",
    ],
    components: [
      { type: "HEADER", format: "TEXT", text: "Order Confirmation" },
      {
        type: "BODY",
        text:
          "Hi {{1}},\n" +
          "We received your order at {{2}}.\n\n" +
          "Order Summary\n" +
          "Order Number: {{3}}\n" +
          "Products: {{4}}\n" +
          "Amount: {{5}}\n" +
          "Delivery Address: {{6}}\n\n" +
          "Select an option below to proceed.",
      },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Yes, Confirmed." },
          { type: "QUICK_REPLY", text: "No, Cancel it." },
          { type: "QUICK_REPLY", text: "Request Changes" },
        ],
      },
    ],
  },
  cod_order_dispatched: {
    key: "cod_order_dispatched",
    templateName: "orderx_cod_order_dispatched",
    language: "en",
    category: "UTILITY",
    exampleBodyValues: [
      "Abdul",
      "#10321",
      "OrderX Store",
      "2x T-shirt, 1x Shoes",
      "Leopards",
      "LP123456789",
      "https://track.example/LP123456789",
    ],
    components: [
      { type: "HEADER", format: "TEXT", text: "Order dispatched" },
      {
        type: "BODY",
        text:
          "Hi {{1}},\n\n" +
          "Your order {{2}} from {{3}} has been dispatched.\n\n" +
          "Order Summary\n" +
          "Products: {{4}}\n" +
          "Courier: {{5}}\n" +
          "Tracking Number: {{6}}\n" +
          "Tracking Link: {{7}}\n\n" +
          "This is an order update regarding your recent purchase.",
      },
    ],
  },
  cod_tracking_updated: {
    key: "cod_tracking_updated",
    templateName: "orderx_cod_tracking_updated",
    language: "en",
    category: "UTILITY",
    exampleBodyValues: [
      "Abdul",
      "#10321",
      "OrderX Store",
      "Leopards",
      "LP123456789",
      "https://track.example/LP123456789",
    ],
    components: [
      { type: "HEADER", format: "TEXT", text: "Tracking updated" },
      {
        type: "BODY",
        text:
          "Hi {{1}},\n\n" +
          "Tracking details for your order {{2}} from {{3}} have been updated.\n\n" +
          "Courier: {{4}}\n" +
          "Tracking Number: {{5}}\n" +
          "Tracking Link: {{6}}\n\n" +
          "This is an order update from your recent purchase.",
      },
    ],
  },
  cod_order_cancelled: {
    key: "cod_order_cancelled",
    templateName: "orderx_cod_order_cancelled",
    language: "en",
    category: "UTILITY",
    exampleBodyValues: [
      "Abdul",
      "#10321",
      "OrderX Store",
      "Customer requested cancellation",
    ],
    components: [
      { type: "HEADER", format: "TEXT", text: "Order cancelled" },
      {
        type: "BODY",
        text:
          "Hi {{1}},\n\n" +
          "Your order {{2}} from {{3}} has been cancelled.\n\n" +
          "Reason: {{4}}\n\n" +
          "If you need help, please contact the store's support.",
      },
    ],
  },
  cod_order_update_generic: {
    key: "cod_order_update_generic",
    templateName: "orderx_cod_order_update_generic",
    language: "en",
    category: "UTILITY",
    exampleBodyValues: [
      "Abdul",
      "#10321",
      "OrderX Store",
      "Delivery delayed",
      "Your parcel is delayed due to weather conditions.",
    ],
    components: [
      { type: "HEADER", format: "TEXT", text: "Order update" },
      {
        type: "BODY",
        text:
          "Hi {{1}},\n\n" +
          "There is an update for your order {{2}} from {{3}}.\n\n" +
          "Update: {{4}}\n" +
          "Details: {{5}}\n\n" +
          "This is an order update from your recent purchase.",
      },
    ],
  },
};

const BYON_TEMPLATE_AUTO_SYNC_MS = Number(
  process.env.BYON_TEMPLATE_AUTO_SYNC_MS || 60_000,
);
const BYON_TEMPLATE_APPROVED_SYNC_MS = Number(
  process.env.BYON_TEMPLATE_APPROVED_SYNC_MS || 60 * 60_000,
);
const BYON_TEMPLATE_FORCE_MIN_INTERVAL_MS = Number(
  process.env.BYON_TEMPLATE_FORCE_MIN_INTERVAL_MS || 5_000,
);
const byonTemplateSyncInflight = new Map();

const OWN_NUMBER_STATUS_VALUES = new Set([
  "not_started",
  "collecting_details",
  "meta_connect_pending",
  "templates_pending",
  "registration_pending",
  "ready",
  "reauth_required",
  "error",
]);

const OWN_TEMPLATE_KEY_ALIASES = {
  cod_confirm_new: "cod_confirm_new",
  orderx_cod_confirm_new: "cod_confirm_new",
  cod_order_dispatched: "cod_order_dispatched",
  orderx_cod_order_dispatched: "cod_order_dispatched",
  cod_tracking_updated: "cod_tracking_updated",
  orderx_cod_tracking_updated: "cod_tracking_updated",
  cod_order_cancelled: "cod_order_cancelled",
  orderx_cod_order_cancelled: "cod_order_cancelled",
  cod_order_update_generic: "cod_order_update_generic",
  orderx_cod_order_update_generic: "cod_order_update_generic",
};

function toStringArray(v) {
  if (Array.isArray(v))
    return v.map((x) => String(x || "").trim()).filter(Boolean);
  if (typeof v === "string") {
    return v
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return [];
}

function toCountryCodes(v) {
  return toStringArray(v)
    .map((x) => String(x).trim().toUpperCase())
    .filter((x) => /^[A-Z]{2}$/.test(x));
}

function normalizeSupportWhatsAppNumber(v) {
  const raw = String(v || "").trim();
  if (!raw) return "";

  // Allow merchants to paste formatted numbers; keep only digits and a leading "+".
  const cleaned = raw.replace(/[^\d+]/g, "");
  const digits = cleaned.startsWith("+")
    ? cleaned.slice(1).replace(/[^\d]/g, "")
    : cleaned.replace(/[^\d]/g, "");

  return digits ? `+${digits}` : "";
}

function isValidE164(v) {
  // E.164: "+" followed by 8-15 digits (first digit can't be 0).
  return /^\+[1-9]\d{7,14}$/.test(String(v || "").trim());
}

function normalizeDigits(v) {
  return String(v || "").replace(/[^\d]/g, "");
}

function e164Matches(a, b) {
  const da = normalizeDigits(a);
  const db = normalizeDigits(b);
  if (!da || !db) return false;
  return da === db;
}

function normalizeWaDeliveryStatus(v) {
  return String(v || "")
    .trim()
    .toLowerCase();
}

function isSuccessfulWaDeliveryStatus(v) {
  const s = normalizeWaDeliveryStatus(v);
  return s === "sent" || s === "delivered" || s === "read";
}

function isLikelyEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());
}

function isGraphId(v) {
  return /^[0-9]{5,}$/.test(String(v || "").trim());
}

function isMetaAuthHttpError(err) {
  const status = Number(err?.httpStatus || err?.status || err?.statusCode || 0);
  return status === 401 || status === 403;
}

function normalizeSenderMode(v, fallback = SENDER_MODES.ORDERX_NUMBER) {
  const raw = String(v || "").trim();
  if (raw === SENDER_MODES.ORDERX_NUMBER || raw === SENDER_MODES.OWN_NUMBER) {
    return raw;
  }
  return fallback;
}

function getBillingSenderModeForRecord(record) {
  const planKey = String(
    record?.billing?.planKey || PLAN_KEYS.ORDERX_FREE_5,
  ).trim();
  const plan = getPlan(planKey);
  return normalizeSenderMode(plan?.senderMode, SENDER_MODES.ORDERX_NUMBER);
}

function ensureOwnNumberPlanAccess(record) {
  if (getBillingSenderModeForRecord(record) === SENDER_MODES.OWN_NUMBER) {
    return;
  }
  const error = new Error(
    "This feature is available only on Your Own Number plans",
  );
  error.httpStatus = 409;
  throw error;
}

function normalizeOwnNumberStatus(v) {
  const raw = String(v || "").trim();
  return OWN_NUMBER_STATUS_VALUES.has(raw) ? raw : "not_started";
}

const OWN_NUMBER_READY_INFERENCE_BLOCKED_STATUSES = new Set([
  "not_started",
  "collecting_details",
  "meta_connect_pending",
  "registration_pending",
  "reauth_required",
  "error",
]);

function generateWebhookReplyCode() {
  const n = Math.floor(100000 + Math.random() * 900000);
  return `WT${n}`;
}

function normalizeTemplateStatus(v) {
  const raw = String(v || "")
    .trim()
    .toLowerCase();
  if (
    [
      "approved",
      "pending",
      "in_review",
      "pending_deletion",
      "rejected",
      "paused",
      "disabled",
      "missing",
      "error",
    ].includes(raw)
  ) {
    return raw;
  }
  return "missing";
}

function normalizeOwnTemplateKey(v) {
  const raw = String(v || "")
    .trim()
    .toLowerCase();
  if (!raw) return "";
  return OWN_TEMPLATE_KEY_ALIASES[raw] || raw;
}

function languageMatches(left, right) {
  const a = String(left || "")
    .trim()
    .toLowerCase();
  const b = String(right || "")
    .trim()
    .toLowerCase();
  if (!a || !b) return true;
  if (a === b) return true;
  return (a === "en" && b === "en_us") || (a === "en_us" && b === "en");
}

function mapMetaTemplateStatus(v) {
  const raw = String(v || "")
    .trim()
    .toUpperCase();
  if (raw === "APPROVED") return "approved";
  if (raw === "IN_REVIEW") return "in_review";
  if (raw === "PENDING") return "pending";
  if (raw === "PENDING_DELETION") return "pending_deletion";
  if (raw === "REJECTED") return "rejected";
  if (raw === "PAUSED") return "paused";
  if (raw === "DISABLED") return "disabled";
  if (["FAILED"].includes(raw)) return "error";
  return "missing";
}

function isTemplateProvisionRetryStatus(status) {
  const normalized = normalizeTemplateStatus(status);
  return (
    normalized === "rejected" ||
    normalized === "error" ||
    normalized === "paused" ||
    normalized === "disabled"
  );
}

function buildRetryTemplateName(baseName, metaTemplates = [], options = {}) {
  const base = String(baseName || "")
    .trim()
    .toLowerCase();
  if (!base) return "";
  const forceUnique = !!options?.forceUnique;

  const existing = new Set(
    (Array.isArray(metaTemplates) ? metaTemplates : [])
      .map((row) =>
        String(row?.name || "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  );

  if (!forceUnique && !existing.has(base)) return base;

  for (let i = 2; i <= 50; i += 1) {
    const candidate = `${base}_v${i}`;
    if (!existing.has(candidate)) return candidate;
  }

  const ts = new Date().toISOString().replace(/[^\d]/g, "").slice(2, 14);
  for (let i = 0; i < 20; i += 1) {
    const rand = Math.floor(Math.random() * 900 + 100);
    const candidate = `${base}_r${ts}${i}${rand}`;
    if (!existing.has(candidate)) return candidate;
  }

  return `${base}_r${Date.now().toString().slice(-10)}`;
}

function isMetaTemplateLanguageDeletingError(errorLike) {
  const msg = summarizeMetaApiError(errorLike).toLowerCase();
  return (
    msg.includes("language is being deleted") ||
    msg.includes("content can't be added while the existing") ||
    msg.includes("content cannot be added while the existing")
  );
}

function summarizeMetaTemplateReason(row) {
  if (!row || typeof row !== "object") return "";
  const pieces = [
    row?.rejected_reason,
    row?.rejection_reason,
    row?.reason,
    row?.rejectedReason,
    row?.rejectionReason,
  ]
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  if (!pieces.length) return "";
  return pieces[0].replace(/[_\-]+/g, " ").slice(0, 220);
}

function summarizeTemplateDebugRows(templates = []) {
  return (Array.isArray(templates) ? templates : []).map((row) => ({
    id:
      String(
        row?.id || row?.message_template_id || row?.template_id || "",
      ).trim() || null,
    rawStatus: String(row?.status || "").trim() || null,
    key: String(row?.key || "").trim() || null,
    name: String(row?.templateName || row?.name || "").trim() || null,
    language: String(row?.language || "").trim() || null,
    status:
      String(
        row?.key
          ? normalizeTemplateStatus(row?.status)
          : mapMetaTemplateStatus(row?.status),
      ).trim() || "missing",
    qualityScore:
      row?.quality_score && typeof row.quality_score === "object"
        ? {
            score: String(row.quality_score?.score || "").trim() || null,
            reasons: Array.isArray(row.quality_score?.reasons)
              ? row.quality_score.reasons
              : [],
          }
        : row?.quality_score || null,
    lastUpdatedTime: row?.last_updated_time || null,
    lastCheckedAt: row?.lastCheckedAt || null,
    lastError: row?.lastError || null,
  }));
}

function logByonTemplateSync(label, payload = {}) {
  try {
    console.log(
      `[BYON_TEMPLATE_SYNC] ${label}`,
      JSON.stringify(payload, null, 2),
    );
  } catch {
    console.log(`[BYON_TEMPLATE_SYNC] ${label}`, payload);
  }
}

function buildOwnNumberTemplatePack(existing = []) {
  const existingByKey = new Map();
  for (const item of Array.isArray(existing) ? existing : []) {
    const key = normalizeOwnTemplateKey(item?.key || item?.templateName);
    if (!key) continue;
    existingByKey.set(key, item);
  }
  return OWN_NUMBER_TEMPLATE_PACK.map((base) => {
    const prev = existingByKey.get(base.key) || {};
    const hasPreviousName = !!String(prev?.templateName || "").trim();
    return {
      key: base.key,
      templateName: String(
        hasPreviousName ? prev.templateName : base.templateName,
      ),
      language: String(prev.language || base.language || "en"),
      status:
        String(prev.status || "").trim() ||
        (prev.lastError ? "error" : "missing"),
      lastCheckedAt: prev.lastCheckedAt || null,
      lastError: prev.lastError || null,
    };
  });
}

function buildResetOwnNumberTemplatePack(existing = []) {
  const existingByKey = new Map();
  for (const item of Array.isArray(existing) ? existing : []) {
    const key = normalizeOwnTemplateKey(item?.key || item?.templateName);
    if (!key) continue;
    existingByKey.set(key, item);
  }
  return OWN_NUMBER_TEMPLATE_PACK.map((base) => {
    const prev = existingByKey.get(base.key) || {};
    return {
      key: base.key,
      templateName: String(base.templateName || "").trim(),
      language: String(prev.language || base.language || "en"),
      status: "missing",
      lastCheckedAt: null,
      lastError: null,
    };
  });
}

async function fetchMetaTemplateStatuses({ wabaId, accessToken }) {
  const url = new URL(
    `https://graph.facebook.com/${getMetaGraphVersion()}/${wabaId}/message_templates`,
  );
  url.searchParams.set(
    "fields",
    [
      "id",
      "name",
      "status",
      "language",
      "category",
      "rejected_reason",
      "rejection_reason",
      "quality_score",
      "last_updated_time",
    ].join(","),
  );
  url.searchParams.set("limit", "200");

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    logByonTemplateSync("meta_fetch_error", {
      wabaId,
      httpStatus: res.status,
      response: data,
    });
    const err = new Error(data?.error?.message || "Failed to fetch templates");
    err.meta = data;
    err.httpStatus = res.status;
    throw err;
  }

  const rows = Array.isArray(data?.data) ? data.data : [];
  logByonTemplateSync("meta_fetch_success", {
    wabaId,
    count: rows.length,
    templates: summarizeTemplateDebugRows(rows),
  });
  return rows;
}

function getMetaGraphVersion() {
  return String(process.env.META_GRAPH_VERSION || "v25.0").trim() || "v25.0";
}

function summarizeMetaApiError(errorLike) {
  const meta = errorLike?.meta || {};
  const parts = [
    meta?.error?.error_user_title,
    meta?.error?.error_user_msg,
    meta?.error?.message,
    errorLike?.message,
  ]
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  const msg = parts.join(" | ");
  return msg.slice(0, 400) || "Meta API request failed";
}

function extractMetaErrorCode(errorLike) {
  const code = Number(errorLike?.meta?.error?.code || 0);
  return Number.isFinite(code) && code > 0 ? code : null;
}

function friendlyByonSendError(errorLike, fallback) {
  const code = extractMetaErrorCode(errorLike);
  if (code === 133010) {
    return (
      "WhatsApp Cloud registration is not complete for this number yet. " +
      "Finish Cloud registration first, then retry the send."
    );
  }
  if (code === 2) {
    return "Meta service is temporarily unavailable. Please retry in about 1 minute.";
  }
  if (code === 133016) {
    return "Meta temporarily blocked Cloud registration due to too many attempts. Wait 10 minutes, then use OrderX's retry registration action once.";
  }
  return String(errorLike?.message || fallback || "Failed");
}

function extractPlaceholderIndexes(text) {
  const source = String(text || "");
  const set = new Set();
  const re = /\{\{(\d+)\}\}/g;
  let match = re.exec(source);
  while (match) {
    const n = Number(match?.[1] || 0);
    if (Number.isFinite(n) && n > 0) set.add(Math.floor(n));
    match = re.exec(source);
  }
  return [...set].sort((a, b) => a - b);
}

function withTemplateExamples(definition) {
  const components = Array.isArray(definition?.components)
    ? definition.components.map((c) => ({ ...c }))
    : [];
  const examples = Array.isArray(definition?.exampleBodyValues)
    ? definition.exampleBodyValues.map((v) => String(v || "").trim())
    : [];

  return components.map((component) => {
    const type = String(component?.type || "")
      .trim()
      .toUpperCase();
    if (type !== "BODY") return component;
    const indexes = extractPlaceholderIndexes(component?.text);
    if (!indexes.length) return component;

    const maxIndex = Math.max(...indexes);
    const sample = [];
    for (let i = 1; i <= maxIndex; i += 1) {
      sample.push(examples[i - 1] || `Sample ${i}`);
    }

    return {
      ...component,
      example: {
        body_text: [sample],
      },
    };
  });
}

async function createMetaTemplate({ wabaId, accessToken, definition }) {
  const apiVersion = getMetaGraphVersion();
  const url = `https://graph.facebook.com/${apiVersion}/${wabaId}/message_templates`;
  const payload = {
    name: String(definition?.templateName || "").trim(),
    language: String(definition?.language || "en").trim() || "en",
    category: String(definition?.category || "UTILITY").trim() || "UTILITY",
    components: withTemplateExamples(definition),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || "Failed to create template");
    err.meta = data;
    err.httpStatus = res.status;
    throw err;
  }
  return data;
}

function isMetaTemplateAlreadyExistsError(error) {
  const msg = String(error?.message || "").toLowerCase();
  return (
    msg.includes("already exists") ||
    msg.includes("duplicate") ||
    msg.includes("same name")
  );
}

function buildTemplateNameCandidates(templateName, templateKey = "") {
  const name = String(templateName || "").trim();
  const normalizedKey = normalizeOwnTemplateKey(templateKey);
  const canonicalName = String(
    OWN_NUMBER_TEMPLATE_DEFINITIONS[normalizedKey]?.templateName || "",
  ).trim();

  return Array.from(
    new Set(
      [name, canonicalName].filter(Boolean).flatMap((candidateName) =>
        [candidateName]
          .concat(
            candidateName.startsWith("orderx_")
              ? [candidateName.slice("orderx_".length)]
              : [`orderx_${candidateName}`],
          )
          .map((n) =>
            String(n || "")
              .trim()
              .toLowerCase(),
          )
          .filter(Boolean),
      ),
    ),
  );
}

function resolveOwnTemplateKeyFromRemoteName(templateName) {
  const raw = String(templateName || "")
    .trim()
    .toLowerCase();
  if (!raw) return "";

  const direct = normalizeOwnTemplateKey(raw);
  if (OWN_NUMBER_TEMPLATE_DEFINITIONS[direct]) return direct;

  for (const definition of OWN_NUMBER_TEMPLATE_PACK) {
    const candidates = buildTemplateNameCandidates(
      definition.templateName,
      definition.key,
    );
    const matched = candidates.some(
      (candidate) =>
        raw === candidate ||
        raw.startsWith(`${candidate}_v`) ||
        raw.startsWith(`${candidate}_r`),
    );
    if (matched) return definition.key;
  }

  return "";
}

function parseMetaTemplateUpdatedAt(row) {
  const ts = new Date(row?.last_updated_time || 0).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function buildRemoteTemplateIndex(metaTemplates = []) {
  const byKey = new Map();
  for (const row of Array.isArray(metaTemplates) ? metaTemplates : []) {
    const key = resolveOwnTemplateKeyFromRemoteName(row?.name);
    if (!key) continue;
    const previous = byKey.get(key);
    const currentUpdatedAt = parseMetaTemplateUpdatedAt(row);
    const previousUpdatedAt = parseMetaTemplateUpdatedAt(previous);
    if (!previous || currentUpdatedAt >= previousUpdatedAt) {
      byKey.set(key, row);
    }
  }
  return byKey;
}

function findRemoteTemplate(
  metaTemplates,
  templateName,
  language,
  templateKey = "",
) {
  const lang = String(language || "")
    .trim()
    .toLowerCase();
  const nameCandidates = buildTemplateNameCandidates(templateName, templateKey);
  const matches = (Array.isArray(metaTemplates) ? metaTemplates : [])
    .map((row) => {
      const rowName = String(row?.name || "")
        .trim()
        .toLowerCase();
      const rowLang = String(row?.language || "")
        .trim()
        .toLowerCase();
      if (!languageMatches(rowLang, lang)) return null;

      const exact = nameCandidates.includes(rowName);
      const retryVariant =
        !exact &&
        nameCandidates.some(
          (candidate) =>
            rowName.startsWith(`${candidate}_v`) ||
            rowName.startsWith(`${candidate}_r`),
        );

      if (!exact && !retryVariant) return null;
      return {
        row,
        exact,
        updatedAt: parseMetaTemplateUpdatedAt(row),
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (left.updatedAt !== right.updatedAt) {
        return right.updatedAt - left.updatedAt;
      }
      if (left.exact !== right.exact) return left.exact ? -1 : 1;
      return 0;
    });

  return matches[0]?.row || null;
}

function mergeTemplateStatusesWithMeta(existing, metaTemplates = []) {
  const base = buildOwnNumberTemplatePack(existing);
  const now = new Date();
  const remoteByKey = buildRemoteTemplateIndex(metaTemplates);

  return base.map((tpl) => {
    const remote =
      remoteByKey.get(String(tpl.key || "").trim()) ||
      findRemoteTemplate(
        metaTemplates,
        String(tpl.templateName || "").trim(),
        String(tpl.language || "en").trim(),
        String(tpl.key || "").trim(),
      );
    if (!remote) {
      return {
        ...tpl,
        status: "missing",
        lastCheckedAt: now,
        lastError: null,
      };
    }
    const remoteStatus = mapMetaTemplateStatus(remote.status);
    const rejectionReason = summarizeMetaTemplateReason(remote);
    const hasActionNeededStatus = [
      "rejected",
      "paused",
      "disabled",
      "error",
    ].includes(remoteStatus);
    return {
      ...tpl,
      templateName: String(remote.name || tpl.templateName || "").trim(),
      language: String(remote.language || tpl.language || "en"),
      status: remoteStatus,
      lastCheckedAt: now,
      lastError:
        remoteStatus === "rejected"
          ? rejectionReason || "Rejected by Meta policy review"
          : remoteStatus === "paused"
            ? rejectionReason || "Template paused by Meta"
            : remoteStatus === "disabled"
              ? rejectionReason || "Template disabled by Meta"
              : remoteStatus === "error"
                ? rejectionReason || "Template could not be processed by Meta"
                : hasActionNeededStatus
                  ? rejectionReason || "Template needs attention"
                  : null,
    };
  });
}

function allTemplatesApproved(templates = []) {
  return (
    Array.isArray(templates) &&
    templates.length > 0 &&
    templates.every((t) => normalizeTemplateStatus(t?.status) === "approved")
  );
}

function hasProvisionedTemplates(templates = []) {
  return Array.isArray(templates)
    ? templates.some(
        (tpl) => normalizeTemplateStatus(tpl?.status) !== "missing",
      )
    : false;
}

function isOwnNumberPaymentMethodComplete(own = {}, templates = []) {
  if (own?.paymentMethodConfirmedAt) return true;
  if (own?.templatesReadyAt || own?.readyAt || own?.onboardingCompletedAt) {
    return true;
  }
  return false;
}

function resolveOwnNumberSetupStatus({
  own = {},
  templates = [],
  hasMetaConnection = false,
  hasAccessToken = false,
  tokenExpired = false,
  registrationStatus = "",
  webhookReady = true,
}) {
  if (tokenExpired) return "reauth_required";
  if (!hasMetaConnection) return "meta_connect_pending";
  if (!hasAccessToken) return "reauth_required";
  if (!allTemplatesApproved(templates)) return "templates_pending";
  if (
    String(registrationStatus || "")
      .trim()
      .toLowerCase() !== "registered"
  ) {
    return "registration_pending";
  }
  if (!webhookReady) return "error";
  return "ready";
}

function getByonMetaClientConfig() {
  const appId = String(process.env.META_APP_ID || "").trim();
  const appSecretConfigured = !!String(
    process.env.META_APP_SECRET || "",
  ).trim();
  const configId = String(
    process.env.META_EMBEDDED_SIGNUP_CONFIG_ID || "",
  ).trim();
  const solutionId = String(process.env.META_SOLUTION_ID || "").trim();
  const apiVersion = String(process.env.META_GRAPH_VERSION || "v25.0").trim();
  const configuredFeatureType = String(
    process.env.META_EMBEDDED_SIGNUP_FEATURE_TYPE || META_FEATURE_TYPE_WABA_APP,
  )
    .trim()
    .toLowerCase();
  const featureType =
    configuredFeatureType === META_FEATURE_TYPE_WABA_APP
      ? META_FEATURE_TYPE_WABA_APP
      : "";
  return {
    embeddedSignupEnabled: !!appId && !!configId,
    appIdConfigured: !!appId,
    appSecretConfigured,
    configIdConfigured: !!configId,
    solutionIdConfigured: !!solutionId,
    appId: appId || null,
    configId: configId || null,
    solutionId: solutionId || null,
    apiVersion,
    featureType: featureType || null,
  };
}

function generateMetaConnectState() {
  return crypto.randomBytes(24).toString("hex");
}

function hashMetaConnectState(value) {
  const state = String(value || "").trim();
  return state ? crypto.createHash("sha256").update(state).digest("hex") : "";
}

function isExpiredDate(v) {
  const d = v ? new Date(v) : null;
  if (!d || !Number.isFinite(d.getTime())) return true;
  return d.getTime() <= Date.now();
}

function firstNonEmptyString(values = []) {
  for (const raw of Array.isArray(values) ? values : []) {
    const value = String(raw || "").trim();
    if (value) return value;
  }
  return "";
}

function toGraphId(v) {
  const raw = String(v || "").trim();
  return isGraphId(raw) ? raw : "";
}

function firstGraphId(values = []) {
  for (const raw of Array.isArray(values) ? values : []) {
    if (raw && typeof raw === "object") {
      const idFromObject = toGraphId(raw?.id);
      if (idFromObject) return idFromObject;
      continue;
    }
    const id = toGraphId(raw);
    if (id) return id;
  }
  return "";
}

function toConnectionRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function normalizePhoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function scoreMetaRoutingCandidate(candidate, requestedDigits = "") {
  let score = 0;
  if (candidate?.wabaId) score += 20;
  if (candidate?.phoneNumberId) score += 40;
  if (candidate?.metaBusinessId) score += 6;
  if (candidate?.displayPhoneNumber) score += 4;
  const candidateDigits = normalizePhoneDigits(candidate?.displayPhoneNumber);
  if (requestedDigits && candidateDigits) {
    if (candidateDigits === requestedDigits) score += 120;
    else if (
      candidateDigits.endsWith(requestedDigits) ||
      requestedDigits.endsWith(candidateDigits)
    ) {
      score += 80;
    }
  }
  return score;
}

function addMetaRoutingCandidates(
  candidates,
  rows,
  { metaBusinessId = "", source = "" } = {},
) {
  const businessId = toGraphId(metaBusinessId);
  for (const row of toConnectionRows(rows)) {
    const wabaId = toGraphId(row?.id);
    if (!wabaId) continue;
    const phoneRows = toConnectionRows(row?.phone_numbers);
    if (!phoneRows.length) {
      candidates.push({
        wabaId,
        phoneNumberId: "",
        metaBusinessId: businessId || "",
        displayPhoneNumber: "",
        source,
      });
      continue;
    }
    for (const phone of phoneRows) {
      candidates.push({
        wabaId,
        phoneNumberId: toGraphId(phone?.id),
        metaBusinessId: businessId || "",
        displayPhoneNumber: String(phone?.display_phone_number || "").trim(),
        source,
      });
    }
  }
}

function dedupeMetaRoutingCandidates(candidates = []) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(candidates) ? candidates : []) {
    const wabaId = toGraphId(row?.wabaId);
    if (!wabaId) continue;
    const phoneNumberId = toGraphId(row?.phoneNumberId);
    const metaBusinessId = toGraphId(row?.metaBusinessId);
    const displayPhoneNumber = String(row?.displayPhoneNumber || "").trim();
    const source = String(row?.source || "").trim();
    const key = `${wabaId}|${phoneNumberId || "-"}|${displayPhoneNumber || "-"}|${metaBusinessId || "-"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      wabaId,
      phoneNumberId: phoneNumberId || "",
      metaBusinessId: metaBusinessId || "",
      displayPhoneNumber,
      source,
    });
  }
  return out;
}

async function fetchMetaGraphJson({ path, accessToken, params = {} }) {
  const url = new URL(
    `https://graph.facebook.com/${getMetaGraphVersion()}/${path}`,
  );
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    const stringValue = String(value || "").trim();
    if (!stringValue) continue;
    url.searchParams.set(key, stringValue);
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || "Meta API request failed");
    err.httpStatus = res.status;
    err.meta = data;
    throw err;
  }
  return data;
}

async function subscribeMetaAppToWaba({
  wabaId,
  accessToken,
  featureType = "",
}) {
  const url = `https://graph.facebook.com/${getMetaGraphVersion()}/${wabaId}/subscribed_apps`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  const attempt = async (body) => {
    const res = await fetch(url, {
      method: "POST",
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };

  const isCoexistence =
    String(featureType || "")
      .trim()
      .toLowerCase() === META_FEATURE_TYPE_WABA_APP;
  const subscribedFields = [
    ...META_STANDARD_WEBHOOK_FIELDS,
    ...(isCoexistence ? META_COEXISTENCE_WEBHOOK_FIELDS : []),
  ];
  const first = await attempt({ subscribed_fields: subscribedFields });
  if (first.res.ok) return first.data;

  const retryWithoutFields = Number(first?.data?.error?.code || 0) === 100;
  if (retryWithoutFields) {
    const second = await attempt(null);
    if (second.res.ok) return second.data;
    const err = new Error(
      second.data?.error?.message || "Failed to subscribe webhook",
    );
    err.httpStatus = second.res.status;
    err.meta = second.data;
    throw err;
  }

  const err = new Error(
    first.data?.error?.message || "Failed to subscribe webhook",
  );
  err.httpStatus = first.res.status;
  err.meta = first.data;
  throw err;
}

async function ensureOwnNumberWebhookSubscription({
  shop,
  wabaId,
  accessToken,
  featureType = "",
}) {
  const shopDomain = String(shop || "").trim();
  const waba = String(wabaId || "").trim();
  const token = String(accessToken || "").trim();
  if (!shopDomain || !waba || !token) {
    return {
      ok: false,
      skipped: true,
      error: "Missing webhook subscription inputs",
    };
  }

  const now = new Date();
  const current = await Shop.findOne({ shop: shopDomain })
    .select({
      "whatsappSender.ownNumber.webhookSubscribedAt": 1,
      "whatsappSender.ownNumber.webhookSubscriptionError": 1,
      "whatsappSender.ownNumber.metaFeatureType": 1,
    })
    .lean()
    .catch(() => null);
  const lastSubscribedAt =
    current?.whatsappSender?.ownNumber?.webhookSubscribedAt || null;
  const existingError = String(
    current?.whatsappSender?.ownNumber?.webhookSubscriptionError || "",
  ).trim();
  const effectiveFeatureType = String(
    featureType || current?.whatsappSender?.ownNumber?.metaFeatureType || "",
  ).trim();
  const ensureCooldownSec = Math.max(
    60,
    Number(process.env.BYON_WEBHOOK_ENSURE_COOLDOWN_SEC || 300),
  );
  const withinCooldown =
    lastSubscribedAt &&
    Date.now() - new Date(lastSubscribedAt).getTime() <
      ensureCooldownSec * 1000;
  if (withinCooldown && !existingError) {
    return {
      ok: true,
      skipped: true,
      subscribedAt: lastSubscribedAt,
      error: null,
    };
  }

  try {
    await subscribeMetaAppToWaba({
      wabaId: waba,
      accessToken: token,
      featureType: effectiveFeatureType,
    });
    await Shop.updateOne(
      { shop: shopDomain },
      {
        $set: {
          "whatsappSender.ownNumber.webhookSubscribedAt": now,
          "whatsappSender.ownNumber.webhookSubscriptionError": null,
          "whatsappSender.ownNumber.webhookSubscriptionErrorAt": null,
        },
      },
    ).catch(() => {});
    return { ok: true, subscribedAt: now, error: null };
  } catch (err) {
    const message = summarizeMetaApiError(err);
    await Shop.updateOne(
      { shop: shopDomain },
      {
        $set: {
          "whatsappSender.ownNumber.webhookSubscriptionError": message,
          "whatsappSender.ownNumber.webhookSubscriptionErrorAt": now,
        },
      },
    ).catch(() => {});
    return {
      ok: false,
      subscribedAt: null,
      error: message,
      status:
        Number(err?.httpStatus || err?.status || err?.statusCode || 0) || null,
    };
  }
}

async function resolveMetaRoutingFromGraph({
  accessToken,
  requestedPhoneNumber,
  metaBusinessIdHint = "",
  metaBusinessIdHints = [],
  wabaIdHints = [],
}) {
  const token = String(accessToken || "").trim();
  if (!token) {
    return {
      wabaId: "",
      phoneNumberId: "",
      metaBusinessId: "",
      displayPhoneNumber: "",
      source: null,
      probeErrors: [],
    };
  }

  const candidates = [];
  const probeErrors = [];
  const requestedDigits = normalizePhoneDigits(requestedPhoneNumber);
  const hintedBusinessIds = [
    ...new Set(
      [
        metaBusinessIdHint,
        ...(Array.isArray(metaBusinessIdHints) ? metaBusinessIdHints : []),
      ]
        .map((value) => toGraphId(value))
        .filter(Boolean),
    ),
  ].slice(0, 8);
  const hintedWabaIds = [
    ...new Set(
      (Array.isArray(wabaIdHints) ? wabaIdHints : [])
        .map((value) => toGraphId(value))
        .filter(Boolean),
    ),
  ].slice(0, 12);

  for (const hintedWabaId of hintedWabaIds) {
    candidates.push({
      wabaId: hintedWabaId,
      phoneNumberId: "",
      metaBusinessId: "",
      displayPhoneNumber: "",
      source: "hinted_waba",
    });
  }

  const safeProbe = async (name, fn) => {
    try {
      return await fn();
    } catch (e) {
      probeErrors.push({
        probe: name,
        status:
          Number(e?.httpStatus || e?.status || e?.statusCode || 0) || null,
        message: String(e?.message || "Probe failed"),
      });
      return null;
    }
  };

  const meWithWabas = await safeProbe("me_with_wabas", () =>
    fetchMetaGraphJson({
      path: "me",
      accessToken: token,
      params: {
        fields:
          "id,name,whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name}}",
      },
    }),
  );
  if (meWithWabas) {
    addMetaRoutingCandidates(
      candidates,
      meWithWabas?.whatsapp_business_accounts,
      {
        metaBusinessId: meWithWabas?.id,
        source: "me.whatsapp_business_accounts",
      },
    );
  }

  const meWabaEdge = await safeProbe("me_waba_edge", () =>
    fetchMetaGraphJson({
      path: "me/whatsapp_business_accounts",
      accessToken: token,
      params: {
        fields: "id,name,phone_numbers{id,display_phone_number,verified_name}",
        limit: "50",
      },
    }),
  );
  if (meWabaEdge) {
    addMetaRoutingCandidates(candidates, meWabaEdge?.data, {
      source: "me/whatsapp_business_accounts",
    });
  }

  const meBusinesses = await safeProbe("me_businesses", () =>
    fetchMetaGraphJson({
      path: "me/businesses",
      accessToken: token,
      params: {
        fields:
          "id,name,owned_whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name}},client_whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name}}",
        limit: "50",
      },
    }),
  );
  if (meBusinesses) {
    for (const biz of toConnectionRows(meBusinesses?.data)) {
      const businessId = toGraphId(biz?.id);
      addMetaRoutingCandidates(
        candidates,
        biz?.owned_whatsapp_business_accounts,
        {
          metaBusinessId: businessId,
          source: "me/businesses.owned_whatsapp_business_accounts",
        },
      );
      addMetaRoutingCandidates(
        candidates,
        biz?.client_whatsapp_business_accounts,
        {
          metaBusinessId: businessId,
          source: "me/businesses.client_whatsapp_business_accounts",
        },
      );
    }
  }

  for (const hintedBusinessId of hintedBusinessIds) {
    const hintedBusiness = await safeProbe(
      `hinted_business:${hintedBusinessId}`,
      () =>
        fetchMetaGraphJson({
          path: hintedBusinessId,
          accessToken: token,
          params: {
            fields:
              "id,name,owned_whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name}},client_whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name}}",
          },
        }),
    );
    if (hintedBusiness) {
      const businessId = toGraphId(hintedBusiness?.id) || hintedBusinessId;
      addMetaRoutingCandidates(
        candidates,
        hintedBusiness?.owned_whatsapp_business_accounts,
        {
          metaBusinessId: businessId,
          source: "hinted_business.owned_whatsapp_business_accounts",
        },
      );
      addMetaRoutingCandidates(
        candidates,
        hintedBusiness?.client_whatsapp_business_accounts,
        {
          metaBusinessId: businessId,
          source: "hinted_business.client_whatsapp_business_accounts",
        },
      );
    }

    const hintedOwnedEdge = await safeProbe(
      `hinted_business_owned_edge:${hintedBusinessId}`,
      () =>
        fetchMetaGraphJson({
          path: `${hintedBusinessId}/owned_whatsapp_business_accounts`,
          accessToken: token,
          params: {
            fields:
              "id,name,phone_numbers{id,display_phone_number,verified_name}",
            limit: "50",
          },
        }),
    );
    if (hintedOwnedEdge) {
      addMetaRoutingCandidates(candidates, hintedOwnedEdge?.data, {
        metaBusinessId: hintedBusinessId,
        source: "hinted_business/owned_whatsapp_business_accounts",
      });
    }

    const hintedClientEdge = await safeProbe(
      `hinted_business_client_edge:${hintedBusinessId}`,
      () =>
        fetchMetaGraphJson({
          path: `${hintedBusinessId}/client_whatsapp_business_accounts`,
          accessToken: token,
          params: {
            fields:
              "id,name,phone_numbers{id,display_phone_number,verified_name}",
            limit: "50",
          },
        }),
    );
    if (hintedClientEdge) {
      addMetaRoutingCandidates(candidates, hintedClientEdge?.data, {
        metaBusinessId: hintedBusinessId,
        source: "hinted_business/client_whatsapp_business_accounts",
      });
    }
  }

  const dedupedBeforeEdge = dedupeMetaRoutingCandidates(candidates);
  const wabaIdsNeedingPhoneLookup = [
    ...new Set([
      ...dedupedBeforeEdge.filter((c) => c.wabaId).map((c) => c.wabaId),
      ...hintedWabaIds,
    ]),
  ].slice(0, 8);

  for (const wabaId of wabaIdsNeedingPhoneLookup) {
    const phoneEdge = await safeProbe(`waba_phone_edge:${wabaId}`, () =>
      fetchMetaGraphJson({
        path: `${wabaId}/phone_numbers`,
        accessToken: token,
        params: {
          fields: "id,display_phone_number,verified_name",
          limit: "100",
        },
      }),
    );
    if (!phoneEdge) continue;
    for (const phone of toConnectionRows(phoneEdge?.data)) {
      candidates.push({
        wabaId,
        phoneNumberId: toGraphId(phone?.id),
        metaBusinessId: "",
        displayPhoneNumber: String(phone?.display_phone_number || "").trim(),
        source: `${wabaId}/phone_numbers`,
      });
    }
  }

  const deduped = dedupeMetaRoutingCandidates(candidates);
  if (!deduped.length) {
    return {
      wabaId: "",
      phoneNumberId: "",
      metaBusinessId: "",
      displayPhoneNumber: "",
      source: null,
      probeErrors,
    };
  }

  deduped.sort((a, b) => {
    const diff =
      scoreMetaRoutingCandidate(b, requestedDigits) -
      scoreMetaRoutingCandidate(a, requestedDigits);
    if (diff !== 0) return diff;
    if (!!b.phoneNumberId !== !!a.phoneNumberId) {
      return b.phoneNumberId ? 1 : -1;
    }
    return 0;
  });

  const best = deduped[0];
  return {
    wabaId: best?.wabaId || "",
    phoneNumberId: best?.phoneNumberId || "",
    metaBusinessId: best?.metaBusinessId || "",
    displayPhoneNumber: best?.displayPhoneNumber || "",
    source: best?.source || null,
    probeErrors,
  };
}

async function resolveFreshOwnNumberAccessToken({ shop, own }) {
  const fallbackToken = String(own?.accessToken || "").trim();
  const fallbackExpiresAt = own?.accessTokenExpiresAt || null;
  if (!fallbackToken) {
    return {
      accessToken: "",
      accessTokenExpiresAt: fallbackExpiresAt,
      refreshed: false,
      refreshError: null,
    };
  }

  try {
    const refreshed = await maybeRefreshByonAccessToken({
      shop,
      ownNumber: own,
      force: false,
    });
    return {
      accessToken: String(refreshed?.token || fallbackToken).trim(),
      accessTokenExpiresAt: refreshed?.expiresAt || fallbackExpiresAt || null,
      refreshed: !!refreshed?.refreshed,
      refreshError: refreshed?.error || null,
    };
  } catch (err) {
    return {
      accessToken: fallbackToken,
      accessTokenExpiresAt: fallbackExpiresAt,
      refreshed: false,
      refreshError: err,
    };
  }
}

async function syncOwnNumberTemplatesState({
  shop,
  force = false,
  billing = null,
  source = "auto",
} = {}) {
  const shopDomain = String(shop || "").trim();
  if (!shopDomain) {
    return { ok: false, skipped: true, reason: "missing_shop" };
  }

  let record = await Shop.findOne({ shop: shopDomain }).lean();
  if (!record) {
    return { ok: false, skipped: true, reason: "missing_shop_record" };
  }

  const own = record?.whatsappSender?.ownNumber || {};
  const wabaId = String(own?.wabaId || "").trim();
  const phoneNumberId = String(own?.phoneNumberId || "").trim();
  if (!wabaId) {
    return {
      ok: false,
      skipped: true,
      reason: "missing_waba",
      record,
      billing,
    };
  }

  const lastSyncedAt = own?.templatesLastSyncedAt
    ? new Date(own.templatesLastSyncedAt)
    : null;
  const timeSinceLastSyncMs =
    lastSyncedAt && Number.isFinite(lastSyncedAt.getTime())
      ? Date.now() - lastSyncedAt.getTime()
      : Number.POSITIVE_INFINITY;
  const storedTemplates = buildOwnNumberTemplatePack(own?.templates);
  const storedTemplatesApproved = allTemplatesApproved(storedTemplates);
  const shouldSkipApprovedCooldown =
    lastSyncedAt &&
    Number.isFinite(lastSyncedAt.getTime()) &&
    storedTemplatesApproved &&
    timeSinceLastSyncMs < BYON_TEMPLATE_APPROVED_SYNC_MS;
  if (shouldSkipApprovedCooldown) {
    logByonTemplateSync("skip_approved_sync_cooldown", {
      shop: shopDomain,
      force: !!force,
      source,
      wabaId,
      phoneNumberId,
      lastSyncedAt,
      approvedSyncCooldownMs: BYON_TEMPLATE_APPROVED_SYNC_MS,
      storedTemplates: summarizeTemplateDebugRows(storedTemplates),
    });
    return {
      ok: true,
      skipped: true,
      reason: "approved_sync_cooldown",
      record,
      billing,
    };
  }

  const shouldSkipForFreshness =
    lastSyncedAt &&
    Number.isFinite(lastSyncedAt.getTime()) &&
    ((!force && timeSinceLastSyncMs < BYON_TEMPLATE_AUTO_SYNC_MS) ||
      (force &&
        source !== "manual" &&
        timeSinceLastSyncMs < BYON_TEMPLATE_FORCE_MIN_INTERVAL_MS));
  if (shouldSkipForFreshness) {
    logByonTemplateSync("skip_recent_sync", {
      shop: shopDomain,
      force: !!force,
      source,
      wabaId,
      phoneNumberId,
      lastSyncedAt,
      storedTemplates: summarizeTemplateDebugRows(storedTemplates),
    });
    return {
      ok: true,
      skipped: true,
      reason: "recently_synced",
      record,
      billing,
    };
  }

  const tokenState = await resolveFreshOwnNumberAccessToken({
    shop: shopDomain,
    own,
  });
  const accessToken = String(tokenState?.accessToken || "").trim();
  const tokenExpired = isMetaAccessTokenExpired(
    tokenState?.accessTokenExpiresAt,
  );
  if (!accessToken || tokenExpired) {
    const now = new Date();
    logByonTemplateSync("skip_missing_or_expired_token", {
      shop: shopDomain,
      wabaId,
      phoneNumberId,
      tokenExpired,
      hasAccessToken: !!accessToken,
      storedTemplates: summarizeTemplateDebugRows(storedTemplates),
    });
    await Shop.updateOne(
      { shop: shopDomain },
      {
        $set: {
          "whatsappSender.ownNumber.status": "reauth_required",
          "whatsappSender.ownNumber.lastError":
            "Meta access token is missing or expired. Reconnect Meta to refresh templates.",
          "whatsappSender.ownNumber.lastErrorMeta": {
            reason: "missing_or_expired_meta_token",
            wabaId,
            phoneNumberId,
            tokenExpired,
          },
          "whatsappSender.ownNumber.lastErrorAt": now,
        },
      },
    ).catch(() => {});
    record = await Shop.findOne({ shop: shopDomain }).lean();
    return {
      ok: false,
      skipped: true,
      reason: "reauth_required",
      record,
      billing,
    };
  }

  const storedRegistrationStatus = resolveOwnNumberRegistrationStatus(own);

  const [metaTemplates, webhookEnsure] = await Promise.all([
    fetchMetaTemplateStatuses({ wabaId, accessToken }),
    ensureOwnNumberWebhookSubscription({
      shop: shopDomain,
      wabaId,
      accessToken,
    }),
  ]);

  const templates = mergeTemplateStatusesWithMeta(
    own?.templates,
    metaTemplates,
  );
  const now = new Date();
  const registrationReady = isStoredOwnNumberCloudConnected(own);
  const webhookReady = webhookEnsure?.ok === true;
  const ready =
    !!phoneNumberId &&
    allTemplatesApproved(templates) &&
    registrationReady &&
    webhookReady;
  logByonTemplateSync("sync_result", {
    shop: shopDomain,
    force: !!force,
    source,
    wabaId,
    phoneNumberId,
    flowType: String(own?.metaFeatureType || "").trim(),
    storedTemplates: summarizeTemplateDebugRows(storedTemplates),
    remoteTemplates: summarizeTemplateDebugRows(metaTemplates),
    mergedTemplates: summarizeTemplateDebugRows(templates),
    registrationStatus: registrationReady
      ? "registered"
      : storedRegistrationStatus || "unknown",
    registrationOutcome: registrationReady
      ? "READY"
      : own?.registrationOutcome || null,
    registrationError: registrationReady
      ? null
      : own?.registrationError || null,
    webhookEnsure: webhookEnsure?.ok
      ? { ok: true, subscribedAt: webhookEnsure?.subscribedAt || null }
      : { ok: false, error: webhookEnsure?.error || null },
    ready,
  });
  const paymentMethodConfirmedAt = isOwnNumberPaymentMethodComplete(
    own,
    templates,
  )
    ? own?.paymentMethodConfirmedAt ||
      own?.templatesReadyAt ||
      own?.readyAt ||
      own?.onboardingCompletedAt ||
      own?.metaConnectedAt ||
      now
    : null;
  const nextStatus = resolveOwnNumberSetupStatus({
    own,
    templates,
    hasMetaConnection: !!wabaId && !!phoneNumberId,
    hasAccessToken: !!accessToken,
    tokenExpired: false,
    registrationStatus: registrationReady
      ? "registered"
      : own?.registrationStatus,
    webhookReady,
  });
  const templatesReadyAt = ready
    ? own?.templatesReadyAt || own?.readyAt || now
    : null;
  const readyAt = ready ? own?.readyAt || own?.templatesReadyAt || now : null;

  await Shop.updateOne(
    { shop: shopDomain },
    {
      $set: {
        "whatsappSender.ownNumber.templates": templates,
        "whatsappSender.ownNumber.templatesLastSyncedAt": now,
        "whatsappSender.ownNumber.status": nextStatus,
        ...(registrationReady
          ? {
              "whatsappSender.ownNumber.registrationStatus": "registered",
              "whatsappSender.ownNumber.registrationOutcome": "READY",
              "whatsappSender.ownNumber.registrationError": null,
              "whatsappSender.ownNumber.registrationErrorAt": null,
              "whatsappSender.ownNumber.registrationRegisteredAt":
                own?.registrationRegisteredAt || now,
              "whatsappSender.ownNumber.lastError": null,
              "whatsappSender.ownNumber.lastErrorMeta": null,
              "whatsappSender.ownNumber.lastErrorAt": null,
            }
          : {}),
        ...(!webhookReady
          ? {
              "whatsappSender.ownNumber.lastError":
                webhookEnsure?.error ||
                "Meta webhook subscription is not confirmed yet.",
              "whatsappSender.ownNumber.lastErrorMeta": {
                reason: "webhook_subscription_not_ready",
                webhookEnsure,
              },
              "whatsappSender.ownNumber.lastErrorAt": now,
            }
          : {}),
        "whatsappSender.ownNumber.templatesReadyAt": templatesReadyAt,
        "whatsappSender.ownNumber.readyAt": readyAt,
        "whatsappSender.ownNumber.paymentMethodConfirmedAt":
          paymentMethodConfirmedAt,
        ...(tokenState?.accessTokenExpiresAt
          ? {
              "whatsappSender.ownNumber.accessTokenExpiresAt":
                tokenState.accessTokenExpiresAt,
            }
          : {}),
        ...(tokenState?.refreshed
          ? {
              "whatsappSender.ownNumber.accessToken": accessToken,
              "whatsappSender.ownNumber.accessTokenUpdatedAt": now,
            }
          : {}),
        ...(webhookEnsure?.ok
          ? {
              "whatsappSender.ownNumber.webhookSubscribedAt":
                webhookEnsure.subscribedAt || now,
              "whatsappSender.ownNumber.webhookSubscriptionError": null,
              "whatsappSender.ownNumber.webhookSubscriptionErrorAt": null,
            }
          : webhookEnsure?.error
            ? {
                "whatsappSender.ownNumber.webhookSubscriptionError":
                  webhookEnsure.error,
                "whatsappSender.ownNumber.webhookSubscriptionErrorAt": now,
              }
            : {}),
      },
    },
  );

  record = await Shop.findOne({ shop: shopDomain }).lean();
  const effectiveBilling =
    billing || (await getBillingStatus(shopDomain).catch(() => null));
  return {
    ok: true,
    refreshed: true,
    record,
    billing: effectiveBilling,
    templates,
    ready,
    webhookSubscriptionError: webhookEnsure?.ok
      ? null
      : webhookEnsure?.error || null,
  };
}

async function runOwnNumberTemplateSync(options = {}) {
  const shopDomain = String(options?.shop || "").trim();
  if (!shopDomain) {
    return syncOwnNumberTemplatesState(options);
  }
  const existing = byonTemplateSyncInflight.get(shopDomain);
  if (existing) return existing;
  const task = syncOwnNumberTemplatesState(options).finally(() => {
    if (byonTemplateSyncInflight.get(shopDomain) === task) {
      byonTemplateSyncInflight.delete(shopDomain);
    }
  });
  byonTemplateSyncInflight.set(shopDomain, task);
  return task;
}

function serializeSender(record, billing = null) {
  const sender = record?.whatsappSender || {};
  const own = sender?.ownNumber || {};
  const templates = buildOwnNumberTemplatePack(own?.templates);
  const ownTokenExpired = isMetaAccessTokenExpired(own?.accessTokenExpiresAt);
  const billingSenderMode = normalizeSenderMode(
    billing?.plan?.senderMode,
    SENDER_MODES.ORDERX_NUMBER,
  );
  const hasSavedBillingChoice =
    !!billing &&
    (billing.active ||
      billing.status === "TRIAL" ||
      billing.status === "ACTIVE" ||
      !!billing.subscriptionId);
  const ownRegistrationReady = isStoredOwnNumberCloudConnected(own);
  const rawOwnTestMessageStatus = String(own?.testMessageStatus || "")
    .trim()
    .toLowerCase();
  const ownTestMessageStatus =
    rawOwnTestMessageStatus === "queued"
      ? "sent"
      : rawOwnTestMessageStatus || "not_started";
  const paymentMethodAdded = isOwnNumberPaymentMethodComplete(own, templates);
  const templatesApproved = allTemplatesApproved(templates);
  const templatePackProvisioned = hasProvisionedTemplates(templates);
  const webhookReady =
    !!own?.webhookSubscribedAt &&
    !String(own?.webhookSubscriptionError || "").trim();
  const rawOwnStatus = normalizeOwnNumberStatus(own?.status);
  const canInferOwnReady =
    !OWN_NUMBER_READY_INFERENCE_BLOCKED_STATUSES.has(rawOwnStatus);
  const ownStatus = normalizeOwnNumberStatus(
    rawOwnStatus === "ready" ||
      (canInferOwnReady &&
        ownRegistrationReady &&
        !!String(own?.phoneNumberId || "").trim() &&
        !!String(own?.accessToken || "").trim() &&
        !ownTokenExpired &&
        webhookReady &&
        templatesApproved)
      ? "ready"
      : rawOwnStatus,
  );
  const ownReadyWithCreds =
    ownStatus === "ready" &&
    !!String(own?.phoneNumberId || "").trim() &&
    !!String(own?.accessToken || "").trim() &&
    !ownTokenExpired &&
    ownRegistrationReady;
  const dashboardReady =
    !!String(own?.wabaId || "").trim() &&
    !!String(own?.phoneNumberId || "").trim() &&
    paymentMethodAdded &&
    ownRegistrationReady &&
    webhookReady;
  const ownTestDelivered = ["sent", "delivered", "read"].includes(
    ownTestMessageStatus,
  );
  const ownWebhookVerified =
    String(own?.webhookTestStatus || "")
      .trim()
      .toLowerCase() === "received";
  const inferredOnboardingComplete = dashboardReady;
  const computedActiveMode = (() => {
    const stored = normalizeSenderMode(sender?.activeMode, "");

    // Once billing/trial is selected, billing is the source of truth for sender mode.
    // Ignore stale stored activeMode values that may be left from a previous flow.
    if (hasSavedBillingChoice) {
      if (billingSenderMode === SENDER_MODES.OWN_NUMBER) {
        return ownReadyWithCreds ? SENDER_MODES.OWN_NUMBER : null;
      }
      return SENDER_MODES.ORDERX_NUMBER;
    }

    if (stored === SENDER_MODES.OWN_NUMBER) {
      return ownReadyWithCreds ? SENDER_MODES.OWN_NUMBER : null;
    }
    if (stored) return stored;
    return ownReadyWithCreds ? SENDER_MODES.OWN_NUMBER : null;
  })();
  const reportedPreferenceMode = hasSavedBillingChoice
    ? billingSenderMode
    : normalizeSenderMode(sender?.preferenceMode, billingSenderMode);

  return {
    preferenceMode: reportedPreferenceMode,
    activeMode: computedActiveMode,
    currentBillingSenderMode: billingSenderMode,
    byonRequired: billingSenderMode === SENDER_MODES.OWN_NUMBER,
    ownNumber: {
      status: ownStatus,
      businessName: String(own?.businessName || ""),
      contactName: String(own?.contactName || ""),
      contactEmail: String(own?.contactEmail || ""),
      requestedPhoneNumber: String(own?.requestedPhoneNumber || ""),
      displayPhoneNumber: String(own?.displayPhoneNumber || ""),
      wabaId: String(own?.wabaId || ""),
      phoneNumberId: String(own?.phoneNumberId || ""),
      metaFeatureType: String(own?.metaFeatureType || ""),
      metaBusinessId: String(own?.metaBusinessId || ""),
      templateLanguage: String(own?.templateLanguage || "en"),
      accessTokenConnected:
        !!String(own?.accessToken || "").trim() && !ownTokenExpired,
      accessTokenExpiresAt: own?.accessTokenExpiresAt || null,
      accessTokenExpired: ownTokenExpired,
      accessTokenRefreshError: own?.accessTokenRefreshError || null,
      accessTokenRefreshErrorAt: own?.accessTokenRefreshErrorAt || null,
      cloudRegistration: {
        status: ownRegistrationReady
          ? "registered"
          : String(own?.registrationStatus || "unknown"),
        flowType: String(own?.metaFeatureType || ""),
        outcome: ownRegistrationReady
          ? "READY"
          : String(own?.registrationOutcome || ""),
        lastAttemptAt: own?.registrationLastAttemptAt || null,
        error: ownRegistrationReady ? null : own?.registrationError || null,
        errorAt: ownRegistrationReady ? null : own?.registrationErrorAt || null,
        registeredAt: own?.registrationRegisteredAt || null,
        displayPhoneNumber: String(own?.registrationDisplayPhoneNumber || ""),
        verifiedName: String(own?.registrationVerifiedName || ""),
        codeVerificationStatus: String(
          own?.registrationCodeVerificationStatus || "",
        ),
        platformType: String(own?.registrationPlatformType || ""),
        phoneStatus: String(own?.registrationPhoneStatus || ""),
        accountMode: String(own?.registrationAccountMode || ""),
        lastMetadataAt: own?.registrationLastMetadataAt || null,
      },
      webhookSubscribedAt: own?.webhookSubscribedAt || null,
      webhookSubscriptionError: own?.webhookSubscriptionError || null,
      webhookSubscriptionErrorAt: own?.webhookSubscriptionErrorAt || null,
      paymentMethodConfirmedAt: own?.paymentMethodConfirmedAt || null,
      webhookTest: {
        status: String(own?.webhookTestStatus || "not_started"),
        targetPhoneE164: String(own?.webhookTestTargetPhoneE164 || ""),
        expectedReplyCode: String(own?.webhookTestExpectedReplyCode || ""),
        sentAt: own?.webhookTestSentAt || null,
        outboundMessageId: own?.webhookTestOutboundMessageId || null,
        replyReceivedAt: own?.webhookTestReplyReceivedAt || null,
        replyMessageId: own?.webhookTestReplyMessageId || null,
        replyText: String(own?.webhookTestReplyText || ""),
        lastError: own?.webhookTestLastError || null,
        lastErrorAt: own?.webhookTestLastErrorAt || null,
      },
      sendHealth: {
        errorStreak: Number(own?.sendErrorStreak || 0),
        lastError: own?.lastSendError || null,
        lastErrorAt: own?.lastSendErrorAt || null,
        paused: !!own?.pauseSending,
        pauseReason: own?.pauseReason || null,
        pauseSetAt: own?.pauseSetAt || null,
      },
      pendingConnectStateExpiresAt: own?.pendingConnectStateExpiresAt || null,
      templatesLastSyncedAt: own?.templatesLastSyncedAt || null,
      startedAt: own?.startedAt || null,
      detailsSubmittedAt: own?.detailsSubmittedAt || null,
      metaConnectedAt: own?.metaConnectedAt || null,
      templatesReadyAt: own?.templatesReadyAt || null,
      readyAt: own?.readyAt || null,
      testMessageSentAt: own?.testMessageSentAt || null,
      testMessage: {
        targetPhoneE164: String(own?.testMessageTargetPhoneE164 || ""),
        outboundMessageId: own?.testMessageOutboundMessageId || null,
        status: ownTestMessageStatus,
        statusAt: own?.testMessageStatusAt || null,
        lastError: own?.testMessageLastError || null,
        lastErrorMeta: own?.testMessageLastErrorMeta || null,
        lastErrorAt: own?.testMessageLastErrorAt || null,
      },
      onboardingCompletedAt: own?.onboardingCompletedAt || null,
      lastError: own?.lastError || null,
      lastErrorAt: own?.lastErrorAt || null,
      wabaConnected: !!own?.wabaId && !!own?.phoneNumberId,
      templates: templates.map((t) => ({
        key: t.key,
        templateName: t.templateName,
        language: t.language,
        status: String(t.status || "missing"),
        lastCheckedAt: t.lastCheckedAt || null,
        lastError: t.lastError || null,
      })),
      progress: {
        detailsComplete:
          !!String(own?.businessName || "").trim() ||
          !!String(own?.contactName || "").trim() ||
          !!String(own?.contactEmail || "").trim() ||
          isValidE164(String(own?.requestedPhoneNumber || "").trim()) ||
          !!String(own?.wabaId || "").trim(),
        metaConnected: !!own?.wabaId && !!own?.phoneNumberId,
        paymentMethodAdded,
        registrationReady: ownRegistrationReady,
        webhookReady,
        templatePackProvisioned,
        templatesReady: templatesApproved,
        templatesApproved,
        templatesPendingApproval: templatePackProvisioned && !templatesApproved,
        dashboardReady,
        webhookReplyVerified:
          String(own?.webhookTestStatus || "").trim() === "received",
        sendingPaused: !!own?.pauseSending,
        testMessageSent: !!own?.onboardingCompletedAt || ownTestDelivered,
        onboardingComplete: inferredOnboardingComplete,
      },
    },
  };
}

async function getSenderResponse(shop, options = {}) {
  const shopDomain = String(shop || "").trim();
  let [record, billing] = await Promise.all([
    Shop.findOne({ shop: shopDomain }).lean(),
    options?.billing || getBillingStatus(shopDomain).catch(() => null),
  ]);

  if (options?.refreshTemplates && record?.whatsappSender?.ownNumber?.wabaId) {
    const refreshed = await runOwnNumberTemplateSync({
      shop: shopDomain,
      force: options?.forceTemplateRefresh === true,
      billing,
      source: options?.syncSource || "auto",
    }).catch(() => null);
    if (refreshed?.record) {
      record = refreshed.record;
    }
    if (refreshed?.billing) {
      billing = refreshed.billing;
    }
  }

  const sender = serializeSender(record, billing);

  if (record) {
    const currentPreferenceMode = normalizeSenderMode(
      record?.whatsappSender?.preferenceMode,
      "",
    );
    const currentActiveMode = normalizeSenderMode(
      record?.whatsappSender?.activeMode,
      "",
    );
    const nextPreferenceMode = normalizeSenderMode(sender?.preferenceMode, "");
    const nextActiveMode = normalizeSenderMode(sender?.activeMode, "");

    if (
      currentPreferenceMode !== nextPreferenceMode ||
      currentActiveMode !== nextActiveMode
    ) {
      await Shop.updateOne(
        { shop },
        {
          $set: {
            "whatsappSender.preferenceMode": nextPreferenceMode,
            "whatsappSender.activeMode": nextActiveMode || null,
          },
        },
      ).catch(() => null);
    }
  }

  return sender;
}

// Billing endpoints (Mongo-stored plans)
router.use("/billing", billingRoutes);
router.use("/blocklist", blocklistRoutes);
router.use("/", templateAutomationRoutes);
router.use("/", campaignRoutes);

router.get("/usage", async (req, res) => {
  const shop = String(req.query.shop || "").trim();
  if (!shop) return res.status(400).json({ error: "Missing shop" });

  const billing = await getBillingStatus(shop);
  if (!billing.active) {
    return res.status(200).json({ billing, usage: null });
  }

  const [ranges, initiatedConversations24h] = await Promise.all([
    getUsageRanges(shop, { billing }),
    getInitiatedConversationQuotaStatus(shop, { billing }),
  ]);
  const today = Number(ranges.today || 0);
  const todayTemplates = Number(ranges.todayTemplates || 0);
  const todayBillableConfirmations = Number(
    ranges.todayBillableConfirmations || 0,
  );
  const week = Number(ranges.week || 0);
  const cycleUsed = Number(ranges.month || 0);
  const cycleTemplates = Number(ranges.monthTemplates || 0);
  const cycleBillableConfirmations = Number(
    ranges.monthBillableConfirmations || 0,
  );
  const totalBillableConfirmations = Number(
    ranges.totalBillableConfirmations || 0,
  );
  const calendarMonthTemplates = Number(ranges.calendarMonthTemplates || 0);
  const limitDaily = Number(billing.plan?.dailyMessages || 0);
  const limitMonthly = Number(
    billing.plan?.monthlyMessages || (limitDaily > 0 ? limitDaily * 30 : 0),
  );
  const remainingMonthly =
    limitMonthly > 0 ? Math.max(0, limitMonthly - cycleUsed) : null;

  return res.json({
    billing,
    usage: {
      today,
      todayTemplates,
      todayBillableConfirmations,
      week,
      month: cycleUsed,
      monthTemplates: cycleTemplates,
      monthBillableConfirmations: cycleBillableConfirmations,
      totalBillableConfirmations,
      calendarMonthTemplates,
      cycleStartAt: ranges.cycleStartAt || null,
      cycleEndAt: ranges.cycleEndAt || null,
      cycleDays: Number(ranges.cycleDays || 30),
      freePlanUsage: ranges.freePlanUsage || null,
      growthUsage: ranges.growthUsage || null,
      byonUsage: ranges.byonUsage || null,
      fx: ranges.fx || null,

      // Informational, not used for quota enforcement.
      limitDaily,
      limitMonthly,
      remainingMonthly,

      // Backward-compatible fields consumed by existing UI paths.
      waMessagesSent: cycleUsed,
      limit: limitMonthly,

      // ✅ trial cap info for UI
      trialMessageCap: billing.trialMessageCap ?? 10,
      trialMessagesUsed:
        String(billing?.plan?.senderMode || "").trim() ===
        SENDER_MODES.OWN_NUMBER
          ? Number(ranges.byonUsage?.messagesSent || 0)
          : Number(billing.trialMessagesUsed || 0),
      freeConfirmationCap:
        ranges.freePlanUsage?.limit ?? billing.freeConfirmationCap ?? 10,
      freeConfirmationMessagesUsed:
        ranges.freePlanUsage?.used ?? billing.freeConfirmationMessagesUsed ?? 0,
      initiatedConversations24h,
    },
  });
});

router.get("/settings", async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).json({ error: "Missing shop" });
  const record = await Shop.findOne({ shop });
  res.json(record?.settings || {});
});

router.get("/sender", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });
    const refreshTemplates =
      String(req.query.refreshTemplates || "").trim() === "1" ||
      String(req.query.refreshTemplates || "")
        .trim()
        .toLowerCase() === "true";
    const forceTemplateRefresh =
      String(req.query.forceTemplateRefresh || "").trim() === "1" ||
      String(req.query.forceTemplateRefresh || "")
        .trim()
        .toLowerCase() === "true";
    const sender = await getSenderResponse(shop, {
      refreshTemplates,
      forceTemplateRefresh,
    });
    return res.json({ ok: true, sender });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

router.get("/sender/byon/meta-config", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });
    return res.json({ ok: true, config: getByonMetaClientConfig() });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

router.post("/sender/byon/meta-connect/prepare", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const cfg = getByonMetaClientConfig();
    const selectedFeatureType = String(cfg.featureType || "").trim();
    if (!cfg.embeddedSignupEnabled || !cfg.appId || !cfg.configId) {
      return res.status(409).json({
        error: "Meta Embedded Signup is not configured on server",
        config: cfg,
      });
    }

    const state = generateMetaConnectState();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const savedConnect = await Shop.findOneAndUpdate(
      { shop },
      {
        $set: {
          "whatsappSender.ownNumber.metaFeatureType": selectedFeatureType,
          "whatsappSender.ownNumber.pendingConnectState": state,
          "whatsappSender.ownNumber.pendingConnectStateExpiresAt": expiresAt,
        },
        $setOnInsert: { shop },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    const savedPendingState = String(
      savedConnect?.whatsappSender?.ownNumber?.pendingConnectState || "",
    ).trim();
    if (savedPendingState !== state) {
      throw new Error("Failed to prepare Meta connect session state");
    }

    void logAudit({
      shop,
      actor: "merchant",
      action: "byon_meta_connect_prepared",
      meta: {
        expiresAt: expiresAt.toISOString(),
        featureType: selectedFeatureType,
        configId: cfg.configId,
      },
    });

    return res.json({
      ok: true,
      state,
      expiresAt,
      meta: {
        appId: cfg.appId,
        configId: cfg.configId,
        solutionId: cfg.solutionId,
        apiVersion: cfg.apiVersion,
        featureType: selectedFeatureType,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

router.post("/sender/byon/meta-connect/begin", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const cfg = getByonMetaClientConfig();
    const selectedFeatureType = String(cfg.featureType || "").trim();

    if (!cfg.embeddedSignupEnabled || !cfg.appId || !cfg.configId) {
      return res.status(409).json({
        error: "Meta Embedded Signup is not configured on server",
        config: cfg,
      });
    }

    const current = await Shop.findOne({ shop }).lean();
    const own = current?.whatsappSender?.ownNumber || {};

    const state = generateMetaConnectState();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const now = new Date();

    const savedConnect = await Shop.findOneAndUpdate(
      { shop },
      {
        $set: {
          "whatsappSender.preferenceMode": SENDER_MODES.OWN_NUMBER,
          "whatsappSender.ownNumber.status": "meta_connect_pending",
          "whatsappSender.ownNumber.metaFeatureType": selectedFeatureType,
          "whatsappSender.ownNumber.startedAt": own?.startedAt || now,
          "whatsappSender.ownNumber.pendingConnectState": state,
          "whatsappSender.ownNumber.pendingConnectStateExpiresAt": expiresAt,
          "whatsappSender.ownNumber.lastError": null,
          "whatsappSender.ownNumber.lastErrorMeta": null,
          "whatsappSender.ownNumber.lastErrorAt": null,
        },
        $setOnInsert: { shop },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    const savedPendingState = String(
      savedConnect?.whatsappSender?.ownNumber?.pendingConnectState || "",
    ).trim();
    if (savedPendingState !== state) {
      throw new Error("Failed to persist Meta connect session state");
    }

    void logAudit({
      shop,
      actor: "merchant",
      action: "byon_meta_connect_begin",
      meta: {
        expiresAt: expiresAt.toISOString(),
        featureType: selectedFeatureType,
        configId: cfg.configId,
      },
    });

    return res.json({
      ok: true,
      state,
      expiresAt,
      meta: {
        appId: cfg.appId,
        configId: cfg.configId,
        solutionId: cfg.solutionId,
        apiVersion: cfg.apiVersion,
        featureType: selectedFeatureType,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

router.post("/sender/byon/payment-method/confirm", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const registrationPinInput = String(req.body?.registrationPin || "").trim();
    const registrationPin = registrationPinInput.trim().replace(/[^\d]/g, "");
    if (registrationPinInput && !/^\d{6}$/.test(registrationPin)) {
      return res.status(400).json({
        error: "WhatsApp two-step verification PIN must contain 6 digits",
      });
    }

    const current = await Shop.findOne({ shop }).lean();
    const own = current?.whatsappSender?.ownNumber || {};
    const hasMetaConnection =
      !!String(own?.wabaId || "").trim() &&
      !!String(own?.phoneNumberId || "").trim();
    if (!hasMetaConnection) {
      return res.status(409).json({
        error:
          "Connect Meta to a WhatsApp Business account before confirming payment setup.",
      });
    }

    const now = new Date();
    const tokenState = await resolveFreshOwnNumberAccessToken({
      shop,
      own,
    });
    const accessToken = String(tokenState?.accessToken || "").trim();
    const tokenExpired = isMetaAccessTokenExpired(
      tokenState?.accessTokenExpiresAt,
    );
    const phoneId = String(own?.phoneNumberId || "").trim();

    let registrationError = null;
    let registrationOk = isStoredOwnNumberCloudConnected(own);
    if (!tokenExpired && accessToken && phoneId && !registrationOk) {
      try {
        const registration = await ensureOwnNumberCloudRegistration({
          shop,
          phoneId,
          token: accessToken,
          preferredPin:
            registrationPin || String(own?.registrationPin || "").trim(),
          flowType: String(own?.metaFeatureType || "").trim(),
        });
        registrationOk = registration?.ok === true;
        if (!registrationOk) {
          registrationError = String(
            registration?.error?.message ||
              "WhatsApp Cloud registration is not complete yet.",
          ).slice(0, 400);
        }
      } catch (error) {
        registrationError = String(
          error?.message || "WhatsApp Cloud registration is not complete yet.",
        ).slice(0, 400);
      }
    }

    const webhookEnsure =
      !tokenExpired && accessToken && String(own?.wabaId || "").trim()
        ? await ensureOwnNumberWebhookSubscription({
            shop,
            wabaId: String(own?.wabaId || "").trim(),
            accessToken,
          })
        : { ok: false, error: "Meta webhook subscription is not ready" };
    const readinessError =
      registrationError || (webhookEnsure?.ok ? null : webhookEnsure?.error);

    const templates = buildOwnNumberTemplatePack(own?.templates);
    const nextStatus = resolveOwnNumberSetupStatus({
      own,
      templates,
      hasMetaConnection,
      hasAccessToken: !!accessToken,
      tokenExpired,
      registrationStatus: registrationOk
        ? "registered"
        : own?.registrationStatus,
      webhookReady: webhookEnsure?.ok === true,
    });

    await Shop.updateOne(
      { shop },
      {
        $set: {
          "whatsappSender.preferenceMode": SENDER_MODES.OWN_NUMBER,
          "whatsappSender.ownNumber.paymentMethodConfirmedAt":
            own?.paymentMethodConfirmedAt || now,
          "whatsappSender.ownNumber.status": nextStatus,
          "whatsappSender.ownNumber.lastError": readinessError,
          "whatsappSender.ownNumber.lastErrorMeta": readinessError
            ? {
                reason: registrationError
                  ? "payment_method_or_registration_not_ready"
                  : "webhook_subscription_incomplete",
                registrationOk,
                hasMetaConnection,
                hasAccessToken: !!accessToken,
                tokenExpired,
                webhookReady: webhookEnsure?.ok === true,
              }
            : null,
          "whatsappSender.ownNumber.lastErrorAt": readinessError ? now : null,
          ...(tokenState?.accessTokenExpiresAt
            ? {
                "whatsappSender.ownNumber.accessTokenExpiresAt":
                  tokenState.accessTokenExpiresAt,
              }
            : {}),
        },
      },
    );

    void logAudit({
      shop,
      actor: "merchant",
      action: "byon_payment_method_confirmed",
      meta: {},
    });

    const sender = await getSenderResponse(shop);
    return res.json({ ok: true, sender });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

router.post("/sender/select-mode", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });
    const mode = normalizeSenderMode(req.body?.mode, "");
    if (!mode) {
      return res.status(400).json({ error: "Invalid mode" });
    }

    await Shop.findOneAndUpdate(
      { shop },
      {
        $set: { "whatsappSender.preferenceMode": mode },
        $setOnInsert: { shop },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );

    void logAudit({
      shop,
      actor: "merchant",
      action: "sender_mode_selected",
      meta: { mode },
    });

    const sender = await getSenderResponse(shop, {
      refreshTemplates: hasIds && effectiveHasAccessToken,
      forceTemplateRefresh: hasIds && effectiveHasAccessToken,
    });
    return res.json({ ok: true, mode, sender });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

router.post("/sender/byon/start", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const now = new Date();
    const current = await Shop.findOne({ shop }).lean();
    const currentOwn = current?.whatsappSender?.ownNumber || {};
    const templates = buildResetOwnNumberTemplatePack(currentOwn?.templates);

    await Shop.findOneAndUpdate(
      { shop },
      {
        $set: {
          "whatsappSender.preferenceMode": SENDER_MODES.OWN_NUMBER,
          "whatsappSender.ownNumber.status": "collecting_details",
          "whatsappSender.ownNumber.startedAt": currentOwn?.startedAt || now,
          "whatsappSender.ownNumber.templatesReadyAt": null,
          "whatsappSender.ownNumber.readyAt": null,
          "whatsappSender.ownNumber.lastError": null,
          "whatsappSender.ownNumber.lastErrorMeta": null,
          "whatsappSender.ownNumber.lastErrorAt": null,
          "whatsappSender.ownNumber.testMessageSentAt": null,
          "whatsappSender.ownNumber.testMessageTargetPhoneE164": "",
          "whatsappSender.ownNumber.testMessageOutboundMessageId": null,
          "whatsappSender.ownNumber.testMessageStatus": "not_started",
          "whatsappSender.ownNumber.testMessageStatusAt": null,
          "whatsappSender.ownNumber.testMessageLastError": null,
          "whatsappSender.ownNumber.testMessageLastErrorMeta": null,
          "whatsappSender.ownNumber.testMessageLastErrorAt": null,
          "whatsappSender.ownNumber.onboardingCompletedAt": null,
          "whatsappSender.ownNumber.webhookTestStatus": "not_started",
          "whatsappSender.ownNumber.webhookTestTargetPhoneE164": "",
          "whatsappSender.ownNumber.webhookTestExpectedReplyCode": "",
          "whatsappSender.ownNumber.webhookTestSentAt": null,
          "whatsappSender.ownNumber.webhookTestOutboundMessageId": null,
          "whatsappSender.ownNumber.webhookTestReplyReceivedAt": null,
          "whatsappSender.ownNumber.webhookTestReplyMessageId": null,
          "whatsappSender.ownNumber.webhookTestReplyText": "",
          "whatsappSender.ownNumber.webhookTestLastError": null,
          "whatsappSender.ownNumber.webhookTestLastErrorAt": null,
          "whatsappSender.ownNumber.sendErrorStreak": 0,
          "whatsappSender.ownNumber.sendFailureEvents": [],
          "whatsappSender.ownNumber.lastSendError": null,
          "whatsappSender.ownNumber.lastSendErrorMeta": null,
          "whatsappSender.ownNumber.lastSendErrorAt": null,
          "whatsappSender.ownNumber.pauseSending": false,
          "whatsappSender.ownNumber.pauseReason": null,
          "whatsappSender.ownNumber.pauseSetAt": null,
          "whatsappSender.ownNumber.registrationStatus": "unknown",
          "whatsappSender.ownNumber.registrationLastAttemptAt": null,
          "whatsappSender.ownNumber.registrationError": null,
          "whatsappSender.ownNumber.registrationErrorAt": null,
          "whatsappSender.ownNumber.registrationRegisteredAt": null,
          "whatsappSender.ownNumber.templateLanguage":
            currentOwn?.templateLanguage || "en",
          "whatsappSender.ownNumber.templates": templates,
        },
        $setOnInsert: { shop },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );

    void logAudit({
      shop,
      actor: "merchant",
      action: "byon_onboarding_started",
      meta: {},
    });

    const sender = await getSenderResponse(shop, {
      refreshTemplates: hasIds && effectiveHasAccessToken,
      forceTemplateRefresh: hasIds && effectiveHasAccessToken,
    });
    return res.json({ ok: true, sender });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

router.post("/sender/byon/details", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const businessName = String(req.body?.businessName || "").trim();
    const contactName = String(req.body?.contactName || "").trim();
    const contactEmail = String(req.body?.contactEmail || "")
      .trim()
      .toLowerCase();
    const requestedPhoneNumber = normalizeSupportWhatsAppNumber(
      req.body?.requestedPhoneNumber,
    );

    if (!businessName) {
      return res.status(400).json({ error: "Business name is required" });
    }
    if (!contactName) {
      return res.status(400).json({ error: "Contact name is required" });
    }
    if (!contactEmail || !isLikelyEmail(contactEmail)) {
      return res.status(400).json({ error: "Valid contact email is required" });
    }
    if (!requestedPhoneNumber || !isValidE164(requestedPhoneNumber)) {
      return res.status(400).json({
        error: "Valid WhatsApp number is required (E.164, e.g. +923001234567)",
      });
    }

    const now = new Date();
    const current = await Shop.findOne({ shop }).lean();
    const currentOwn = current?.whatsappSender?.ownNumber || {};
    const templates = buildResetOwnNumberTemplatePack(currentOwn?.templates);
    const currentStatus = normalizeOwnNumberStatus(currentOwn?.status);
    const nextStatus =
      currentStatus === "ready"
        ? "ready"
        : currentStatus === "templates_pending"
          ? "templates_pending"
          : "meta_connect_pending";

    await Shop.findOneAndUpdate(
      { shop },
      {
        $set: {
          "whatsappSender.preferenceMode": SENDER_MODES.OWN_NUMBER,
          "whatsappSender.ownNumber.status": nextStatus,
          "whatsappSender.ownNumber.businessName": businessName,
          "whatsappSender.ownNumber.contactName": contactName,
          "whatsappSender.ownNumber.contactEmail": contactEmail,
          "whatsappSender.ownNumber.requestedPhoneNumber": requestedPhoneNumber,
          "whatsappSender.ownNumber.templateLanguage": "en",
          "whatsappSender.ownNumber.detailsSubmittedAt": now,
          "whatsappSender.ownNumber.lastError": null,
          "whatsappSender.ownNumber.lastErrorMeta": null,
          "whatsappSender.ownNumber.lastErrorAt": null,
          "whatsappSender.ownNumber.templates": templates,
          "whatsappSender.ownNumber.startedAt": currentOwn?.startedAt || now,
        },
        $setOnInsert: { shop },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );

    void logAudit({
      shop,
      actor: "merchant",
      action: "byon_details_saved",
      meta: {
        requestedPhoneNumber,
        contactEmail,
      },
    });

    const sender = serializeSender(
      synced?.record || null,
      synced?.billing || null,
    );
    return res.json({ ok: true, sender });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

router.post("/sender/byon/meta-connect/finalize", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const state = String(req.body?.state || "").trim();
    const code = String(req.body?.code || "").trim();
    const wabaId = String(req.body?.wabaId || "").trim();
    const phoneNumberId = String(req.body?.phoneNumberId || "").trim();
    const metaBusinessId = String(req.body?.metaBusinessId || "").trim();
    const displayPhoneNumber = String(
      req.body?.displayPhoneNumber || "",
    ).trim();
    const errorCode = String(req.body?.error || "").trim();
    const errorDescription = String(req.body?.errorDescription || "").trim();

    const current = await Shop.findOne({ shop }).lean();
    const own = current?.whatsappSender?.ownNumber || {};
    const redirectUri = String(req.body?.redirectUri || "").trim();
    const pendingState = String(own?.pendingConnectState || "").trim();
    if (!pendingState || !state || pendingState !== state) {
      const completedStateHash = String(
        own?.lastCompletedConnectStateHash || "",
      ).trim();
      if (
        state &&
        completedStateHash &&
        hashMetaConnectState(state) === completedStateHash
      ) {
        const sender = await getSenderResponse(shop);
        const duplicateOwn = sender?.ownNumber || {};
        return res.json({
          ok: true,
          duplicate: true,
          sender,
          hasAccessToken: !!duplicateOwn?.accessTokenConnected,
          waitingForIds: !(
            String(duplicateOwn?.wabaId || "").trim() &&
            String(duplicateOwn?.phoneNumberId || "").trim()
          ),
          hasWaba: !!String(duplicateOwn?.wabaId || "").trim(),
          hasPhone: !!String(duplicateOwn?.phoneNumberId || "").trim(),
          registrationReady:
            String(duplicateOwn?.cloudRegistration?.status || "") ===
            "registered",
          webhookSubscribed: !!duplicateOwn?.progress?.webhookReady,
        });
      }
      return res
        .status(409)
        .json({ error: "Meta connect session expired or invalid state" });
    }
    if (isExpiredDate(own?.pendingConnectStateExpiresAt)) {
      return res
        .status(409)
        .json({ error: "Meta connect session expired. Start again." });
    }

    if (errorCode) {
      const msg = errorDescription || errorCode || "Meta connect cancelled";
      await Shop.updateOne(
        { shop },
        {
          $set: {
            "whatsappSender.ownNumber.status": "error",
            "whatsappSender.ownNumber.lastError": msg,
            "whatsappSender.ownNumber.lastErrorAt": new Date(),
            "whatsappSender.ownNumber.pendingConnectState": null,
            "whatsappSender.ownNumber.pendingConnectStateExpiresAt": null,
          },
        },
      );
      return res.status(400).json({ error: msg });
    }

    const currentOwn = current?.whatsappSender?.ownNumber || {};
    const hasIncomingRoutingHints =
      isGraphId(wabaId) || isGraphId(phoneNumberId);
    const existingAccessToken = String(currentOwn?.accessToken || "").trim();
    if (
      !code &&
      !errorCode &&
      !hasIncomingRoutingHints &&
      !existingAccessToken
    ) {
      const msg =
        "Embedded Signup did not complete. Please continue through all Meta steps (business + WhatsApp account + phone) and try again.";
      await Shop.updateOne(
        { shop },
        {
          $set: {
            "whatsappSender.ownNumber.status": "error",
            "whatsappSender.ownNumber.lastError": msg,
            "whatsappSender.ownNumber.lastErrorAt": new Date(),
            "whatsappSender.ownNumber.pendingConnectState": null,
            "whatsappSender.ownNumber.pendingConnectStateExpiresAt": null,
          },
        },
      ).catch(() => {});
      return res.status(409).json({ error: msg });
    }

    let exchanged = null;
    let exchangedLongLived = null;
    let debugTokenPayload = null;
    let tokenDebugHints = {
      tokenIsValid: null,
      profileId: "",
      hintIds: [],
      debugExpiresAt: null,
    };
    let accessToken = null;
    let accessTokenExpiresAt = currentOwn?.accessTokenExpiresAt || null;
    let tokenRefreshError = null;
    let tokenRefreshAttempted = false;
    if (code) {
      exchanged = await exchangeMetaOAuthCode({ code, redirectUri });
      accessToken = String(exchanged?.access_token || "").trim() || null;
      const exchangedExpiry = getMetaTokenExpiryDate({
        expiresInSec: exchanged?.expires_in,
      });
      if (exchangedExpiry) {
        accessTokenExpiresAt = exchangedExpiry;
      }

      if (accessToken) {
        tokenRefreshAttempted = true;
        try {
          exchangedLongLived = await exchangeMetaLongLivedToken({
            accessToken,
          });
          const longLivedToken =
            String(exchangedLongLived?.access_token || "").trim() || null;
          if (longLivedToken) {
            accessToken = longLivedToken;
          }
          const longLivedExpiry = getMetaTokenExpiryDate({
            expiresInSec: exchangedLongLived?.expires_in,
          });
          if (longLivedExpiry) {
            accessTokenExpiresAt = longLivedExpiry;
          }
        } catch (err) {
          tokenRefreshError = err;
        }

        try {
          debugTokenPayload = await debugMetaAccessToken({ accessToken });
          tokenDebugHints = getMetaTokenDebugHints(debugTokenPayload);
          if (tokenDebugHints?.debugExpiresAt) {
            accessTokenExpiresAt = tokenDebugHints.debugExpiresAt;
          }
        } catch (err) {
          if (!tokenRefreshError) tokenRefreshError = err;
        }
      }
    }

    const now = new Date();
    const templates = buildResetOwnNumberTemplatePack(currentOwn?.templates);

    let resolvedWabaId = firstGraphId([
      wabaId,
      exchanged?.waba_id,
      exchanged?.wabaId,
      exchanged?.whatsapp_business_account_id,
      exchanged?.whatsapp_business_account,
    ]);
    let resolvedPhoneNumberId = firstGraphId([
      phoneNumberId,
      exchanged?.phone_number_id,
      exchanged?.phoneNumberId,
      exchanged?.whatsapp_phone_number_id,
      exchanged?.phone_number,
    ]);
    let resolvedMetaBusinessId = firstGraphId([
      metaBusinessId,
      exchanged?.business_id,
      exchanged?.businessId,
      exchanged?.meta_business_id,
      exchanged?.metaBusinessId,
      currentOwn?.metaBusinessId,
    ]);
    let resolvedDisplayPhoneNumber = firstNonEmptyString([
      displayPhoneNumber,
      exchanged?.display_phone_number,
      exchanged?.displayPhoneNumber,
      currentOwn?.displayPhoneNumber,
    ]);

    const effectiveAccessToken =
      accessToken || String(currentOwn?.accessToken || "").trim() || null;
    const effectiveAccessTokenExpiresAt =
      accessTokenExpiresAt || currentOwn?.accessTokenExpiresAt || null;
    const tokenHintIds = Array.isArray(tokenDebugHints?.hintIds)
      ? tokenDebugHints.hintIds
      : [];

    let routingResolutionSource = null;
    let routingProbeErrors = [];
    if ((!resolvedWabaId || !resolvedPhoneNumberId) && effectiveAccessToken) {
      const routingMetaBusinessHints = [
        resolvedMetaBusinessId,
        metaBusinessId,
        currentOwn?.metaBusinessId,
        tokenDebugHints?.profileId,
        ...tokenHintIds,
      ];
      const routingWabaHints = [
        resolvedWabaId,
        wabaId,
        currentOwn?.wabaId,
        ...tokenHintIds,
      ];
      const discovered = await resolveMetaRoutingFromGraph({
        accessToken: effectiveAccessToken,
        requestedPhoneNumber: firstNonEmptyString([
          currentOwn?.requestedPhoneNumber,
          resolvedDisplayPhoneNumber,
        ]),
        metaBusinessIdHint: firstGraphId([
          resolvedMetaBusinessId,
          metaBusinessId,
          currentOwn?.metaBusinessId,
          tokenDebugHints?.profileId,
        ]),
        metaBusinessIdHints: routingMetaBusinessHints,
        wabaIdHints: routingWabaHints,
      });

      routingProbeErrors = Array.isArray(discovered?.probeErrors)
        ? discovered.probeErrors
        : [];
      routingResolutionSource = String(discovered?.source || "").trim() || null;

      if (!resolvedWabaId) {
        resolvedWabaId = toGraphId(discovered?.wabaId);
      }
      if (!resolvedPhoneNumberId) {
        resolvedPhoneNumberId = toGraphId(discovered?.phoneNumberId);
      }
      if (!resolvedMetaBusinessId) {
        resolvedMetaBusinessId = toGraphId(discovered?.metaBusinessId);
      }
      if (!resolvedDisplayPhoneNumber) {
        resolvedDisplayPhoneNumber = firstNonEmptyString([
          discovered?.displayPhoneNumber,
        ]);
      }
    }

    const hasWaba = isGraphId(resolvedWabaId);
    const hasPhone = isGraphId(resolvedPhoneNumberId);
    const hasIds = hasWaba && hasPhone;
    const previousWabaId = toGraphId(currentOwn?.wabaId);
    const previousPhoneNumberId = toGraphId(currentOwn?.phoneNumberId);
    const metaConnectionChanged =
      (!!resolvedWabaId && resolvedWabaId !== previousWabaId) ||
      (!!resolvedPhoneNumberId &&
        resolvedPhoneNumberId !== previousPhoneNumberId);
    const effectiveHasAccessToken =
      !!effectiveAccessToken &&
      !isMetaAccessTokenExpired(effectiveAccessTokenExpiresAt);
    const tokenExpired =
      !!effectiveAccessToken &&
      isMetaAccessTokenExpired(effectiveAccessTokenExpiresAt);
    const hasAuthProbeError = routingProbeErrors.some((row) => {
      const status = Number(row?.status || 0);
      return status === 401 || status === 403;
    });

    let webhookSubscribedAt = null;
    let webhookSubscriptionError = null;
    const previousRegistrationStatus = String(
      currentOwn?.registrationStatus || "",
    )
      .trim()
      .toLowerCase();
    const preservedRegistrationStatus =
      metaConnectionChanged || !hasIds ? "unknown" : previousRegistrationStatus;
    if (hasIds && effectiveHasAccessToken) {
      try {
        await subscribeMetaAppToWaba({
          wabaId: resolvedWabaId,
          accessToken: effectiveAccessToken,
          featureType: String(currentOwn?.metaFeatureType || "").trim(),
        });
        webhookSubscribedAt = now;
      } catch (err) {
        webhookSubscriptionError = summarizeMetaApiError(err);
      }
    }

    const nextStatus = hasIds
      ? effectiveHasAccessToken
        ? "templates_pending"
        : "reauth_required"
      : "meta_connect_pending";
    let nextError = null;
    if (!hasIds) {
      if (!effectiveAccessToken || tokenExpired) {
        nextError =
          "Meta access token is missing or expired. Reconnect Meta to continue template setup.";
      } else if (!hasWaba && hasAuthProbeError) {
        nextError =
          "Meta connected, but OrderX cannot access WhatsApp assets for this account. Verify Meta Advanced Access + Tech Provider onboarding, then reconnect.";
      } else if (!hasWaba) {
        nextError =
          "Meta auth saved, but no WhatsApp Business Account was found for this connection. Complete Embedded Signup and retry.";
      } else {
        nextError =
          "Meta auth saved and WABA connected, but phone number ID was not returned yet. Complete phone setup in Embedded Signup and retry.";
      }
    } else if (!effectiveHasAccessToken) {
      nextError =
        "Meta access token is missing or expired. Reconnect Meta to continue template setup.";
    }

    await Shop.updateOne(
      { shop },
      {
        $set: {
          "whatsappSender.preferenceMode": SENDER_MODES.OWN_NUMBER,
          "whatsappSender.ownNumber.status": nextStatus,
          "whatsappSender.ownNumber.metaConnectedAt": now,
          "whatsappSender.ownNumber.lastError": nextError,
          "whatsappSender.ownNumber.lastErrorMeta": nextError
            ? {
                reason: "meta_connect_finalize_incomplete",
                hasWaba,
                hasPhone,
                tokenExpired,
                hasAuthProbeError,
                routingResolutionSource,
                routingProbeErrors,
              }
            : null,
          "whatsappSender.ownNumber.lastErrorAt": nextError ? now : null,
          "whatsappSender.ownNumber.pendingConnectState": null,
          "whatsappSender.ownNumber.pendingConnectStateExpiresAt": null,
          "whatsappSender.ownNumber.lastCompletedConnectStateHash":
            hashMetaConnectState(state),
          "whatsappSender.ownNumber.lastCompletedConnectAt": now,
          "whatsappSender.ownNumber.templates": templates,
          ...(metaConnectionChanged
            ? {
                "whatsappSender.ownNumber.metaFeatureType": String(
                  currentOwn?.metaFeatureType || "",
                ).trim(),
                "whatsappSender.ownNumber.paymentMethodConfirmedAt": null,
                "whatsappSender.ownNumber.templatesReadyAt": null,
                "whatsappSender.ownNumber.readyAt": null,
                "whatsappSender.ownNumber.onboardingCompletedAt": null,
                "whatsappSender.ownNumber.registrationStatus": "unknown",
                "whatsappSender.ownNumber.registrationOutcome": null,
                "whatsappSender.ownNumber.registrationPin": null,
                "whatsappSender.ownNumber.registrationLastAttemptAt": null,
                "whatsappSender.ownNumber.registrationError": null,
                "whatsappSender.ownNumber.registrationErrorAt": null,
                "whatsappSender.ownNumber.registrationRegisteredAt": null,
                "whatsappSender.ownNumber.registrationDisplayPhoneNumber": null,
                "whatsappSender.ownNumber.registrationVerifiedName": null,
                "whatsappSender.ownNumber.registrationCodeVerificationStatus":
                  null,
                "whatsappSender.ownNumber.registrationPlatformType": null,
                "whatsappSender.ownNumber.registrationPhoneStatus": null,
                "whatsappSender.ownNumber.registrationAccountMode": null,
                "whatsappSender.ownNumber.registrationLastMetadataAt": null,
              }
            : {}),
          ...(!metaConnectionChanged
            ? {
                "whatsappSender.ownNumber.metaFeatureType":
                  currentOwn?.metaFeatureType || "",
              }
            : {}),
          ...(hasWaba
            ? {
                "whatsappSender.ownNumber.wabaId": resolvedWabaId,
              }
            : {}),
          ...(hasPhone
            ? {
                "whatsappSender.ownNumber.phoneNumberId": resolvedPhoneNumberId,
              }
            : {}),
          ...(resolvedMetaBusinessId
            ? {
                "whatsappSender.ownNumber.metaBusinessId":
                  resolvedMetaBusinessId || null,
              }
            : {}),
          ...(resolvedDisplayPhoneNumber
            ? {
                "whatsappSender.ownNumber.displayPhoneNumber":
                  resolvedDisplayPhoneNumber || "",
              }
            : {}),
          ...(accessToken
            ? {
                "whatsappSender.ownNumber.accessToken": accessToken,
                "whatsappSender.ownNumber.accessTokenUpdatedAt": now,
                "whatsappSender.ownNumber.accessTokenExpiresAt":
                  effectiveAccessTokenExpiresAt || null,
                "whatsappSender.ownNumber.accessTokenRefreshAttemptedAt": now,
                "whatsappSender.ownNumber.accessTokenRefreshError":
                  tokenRefreshError && !debugTokenPayload
                    ? String(
                        tokenRefreshError?.message ||
                          "Meta token refresh failed",
                      )
                    : null,
                "whatsappSender.ownNumber.accessTokenRefreshErrorAt":
                  tokenRefreshError && !debugTokenPayload ? now : null,
              }
            : {}),
          ...(webhookSubscribedAt
            ? {
                "whatsappSender.ownNumber.webhookSubscribedAt":
                  webhookSubscribedAt,
                "whatsappSender.ownNumber.webhookSubscriptionError": null,
                "whatsappSender.ownNumber.webhookSubscriptionErrorAt": null,
              }
            : {}),
          ...(webhookSubscriptionError
            ? {
                "whatsappSender.ownNumber.webhookSubscriptionError":
                  webhookSubscriptionError,
                "whatsappSender.ownNumber.webhookSubscriptionErrorAt": now,
              }
            : {}),
          ...(!metaConnectionChanged
            ? {
                "whatsappSender.ownNumber.registrationStatus":
                  preservedRegistrationStatus || "unknown",
              }
            : {}),
        },
      },
    );

    let registrationReady = false;
    let registrationError = null;
    if (hasIds && effectiveHasAccessToken) {
      try {
        const registration = await ensureOwnNumberCloudRegistration({
          shop,
          phoneId: resolvedPhoneNumberId,
          token: effectiveAccessToken,
          preferredPin: metaConnectionChanged
            ? ""
            : String(currentOwn?.registrationPin || "").trim(),
          flowType: String(currentOwn?.metaFeatureType || "").trim(),
        });
        registrationReady = registration?.ok === true;
        if (!registrationReady) {
          registrationError = String(
            registration?.error?.message ||
              "WhatsApp Cloud API registration is not complete yet.",
          ).slice(0, 400);
        }
      } catch (error) {
        registrationError = String(
          error?.message || "WhatsApp Cloud API registration failed.",
        ).slice(0, 400);
      }

      const readinessError =
        registrationError || webhookSubscriptionError || null;
      await Shop.updateOne(
        { shop },
        {
          $set: {
            "whatsappSender.ownNumber.status": registrationReady
              ? webhookSubscriptionError
                ? "error"
                : "templates_pending"
              : "registration_pending",
            "whatsappSender.ownNumber.lastError": readinessError,
            "whatsappSender.ownNumber.lastErrorMeta": readinessError
              ? {
                  reason: registrationError
                    ? "cloud_registration_incomplete"
                    : "webhook_subscription_incomplete",
                  registrationReady,
                  webhookSubscribed: !!webhookSubscribedAt,
                }
              : null,
            "whatsappSender.ownNumber.lastErrorAt": readinessError ? now : null,
          },
        },
      );
    }

    void logAudit({
      shop,
      actor: "merchant",
      action: "byon_meta_connect_finalized",
      meta: {
        hasCode: !!code,
        hasAccessToken: effectiveHasAccessToken,
        receivedNewAccessToken: !!accessToken,
        accessTokenExpiresAt: effectiveAccessTokenExpiresAt
          ? new Date(effectiveAccessTokenExpiresAt).toISOString()
          : null,
        tokenRefreshAttempted,
        tokenRefreshHadError: !!tokenRefreshError,
        hasIds,
        hasWaba,
        hasPhone,
        routingResolvedViaGraph: !!routingResolutionSource,
        routingResolutionSource,
        routingProbeErrorCount: routingProbeErrors.length,
        tokenDebugHintCount: tokenHintIds.length,
        webhookSubscribed: !!webhookSubscribedAt,
        webhookSubscriptionError: webhookSubscriptionError || null,
        registrationReady,
        registrationError,
      },
    });

    const sender = await getSenderResponse(shop, {
      refreshTemplates: true,
      forceTemplateRefresh: true,
    });
    if (!hasIds) {
      return res.status(409).json({
        error:
          nextError ||
          "Meta connection is incomplete. Complete Embedded Signup and retry.",
        sender,
        hasAccessToken: effectiveHasAccessToken,
        waitingForIds: true,
        hasWaba,
        hasPhone,
        resolvedViaGraph: !!routingResolutionSource,
        tokenRefreshError:
          tokenRefreshError && !debugTokenPayload
            ? String(tokenRefreshError?.message || "Meta token refresh failed")
            : null,
        webhookSubscribed: !!webhookSubscribedAt,
        webhookSubscriptionError,
        probeErrors: routingProbeErrors.slice(0, 5),
      });
    }

    return res.json({
      ok: true,
      sender,
      hasAccessToken: effectiveHasAccessToken,
      waitingForIds: false,
      hasWaba,
      hasPhone,
      resolvedViaGraph: !!routingResolutionSource,
      tokenRefreshError:
        tokenRefreshError && !debugTokenPayload
          ? String(tokenRefreshError?.message || "Meta token refresh failed")
          : null,
      webhookSubscribed: !!webhookSubscribedAt,
      webhookSubscriptionError,
      registrationReady,
      registrationError,
    });
  } catch (e) {
    const shop = String(req.query.shop || "").trim();
    if (shop) {
      await Shop.updateOne(
        { shop },
        {
          $set: {
            "whatsappSender.ownNumber.status": "error",
            "whatsappSender.ownNumber.lastError": String(
              e?.message || "Meta connect failed",
            ),
            "whatsappSender.ownNumber.lastErrorAt": new Date(),
            "whatsappSender.ownNumber.pendingConnectState": null,
            "whatsappSender.ownNumber.pendingConnectStateExpiresAt": null,
          },
        },
      ).catch(() => {});
    }
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

router.post("/sender/byon/templates/provision", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const current = await Shop.findOne({ shop }).lean();
    ensureOwnNumberPlanAccess(current);
    const own = current?.whatsappSender?.ownNumber || {};
    const wabaId = String(own?.wabaId || "").trim();
    const phoneNumberId = String(own?.phoneNumberId || "").trim();
    const tokenState = await resolveFreshOwnNumberAccessToken({ shop, own });
    const accessToken = String(tokenState?.accessToken || "").trim();
    if (!wabaId || !phoneNumberId) {
      return res
        .status(409)
        .json({ error: "Meta connection is required first" });
    }
    if (!accessToken) {
      return res.status(409).json({
        error:
          "Meta access token is not stored yet. Complete Meta connect and retry.",
      });
    }
    if (isMetaAccessTokenExpired(tokenState?.accessTokenExpiresAt)) {
      return res.status(409).json({
        error:
          "Meta access token has expired. Reconnect Meta before provisioning templates.",
      });
    }
    const webhookEnsure = await ensureOwnNumberWebhookSubscription({
      shop,
      wabaId,
      accessToken,
    });

    const startingTemplates = buildOwnNumberTemplatePack(own?.templates);
    const createResults = {};
    let remoteTemplates = [];
    try {
      remoteTemplates = await fetchMetaTemplateStatuses({
        wabaId,
        accessToken,
      });
    } catch (e) {
      const err = new Error(
        e?.message || "Failed to load existing Meta templates",
      );
      err.httpStatus = e?.httpStatus;
      err.status = e?.status;
      err.statusCode = e?.statusCode;
      err.meta = e?.meta || null;
      throw err;
    }

    const nextTemplateNameByKey = new Map();
    for (const tpl of startingTemplates) {
      const key = String(tpl?.key || "").trim();
      if (!key) continue;
      const definition = OWN_NUMBER_TEMPLATE_DEFINITIONS[key];
      nextTemplateNameByKey.set(
        key,
        String(tpl?.templateName || definition?.templateName || "")
          .trim()
          .toLowerCase(),
      );
    }

    for (const tpl of startingTemplates) {
      const key = String(tpl?.key || "").trim();
      const definition = OWN_NUMBER_TEMPLATE_DEFINITIONS[key];
      if (!definition) continue;
      const configuredTemplateName = String(
        nextTemplateNameByKey.get(key) ||
          tpl.templateName ||
          definition.templateName,
      )
        .trim()
        .toLowerCase();
      const exists = findRemoteTemplate(
        remoteTemplates,
        configuredTemplateName,
        tpl.language || definition.language,
      );
      const existsStatus = mapMetaTemplateStatus(exists?.status);
      const existsErrored = isTemplateProvisionRetryStatus(existsStatus);

      let createTemplateName = configuredTemplateName;
      let shouldCreate = !exists;
      if (exists && !existsErrored) {
        createResults[key] = { action: "exists", status: existsStatus };
        continue;
      }
      if (exists && existsErrored) {
        createTemplateName = buildRetryTemplateName(
          definition.templateName,
          remoteTemplates,
          { forceUnique: true },
        );
        shouldCreate =
          !!createTemplateName &&
          createTemplateName.toLowerCase() !== configuredTemplateName;
        if (!shouldCreate) {
          createResults[key] = {
            action: "exists",
            status: existsStatus,
            message:
              summarizeMetaTemplateReason(exists) ||
              "Template exists in rejected state and no retry name is available",
          };
          continue;
        }
      }

      const createDefinition = {
        ...definition,
        templateName: createTemplateName,
        language: String(tpl.language || definition.language || "en"),
      };

      try {
        const created = await createMetaTemplate({
          wabaId,
          accessToken,
          definition: createDefinition,
        });
        nextTemplateNameByKey.set(key, createTemplateName);
        createResults[key] = {
          action: existsErrored ? "recreated" : "created",
          status: "in_review",
          templateName: createTemplateName,
          previousTemplateName: existsErrored ? configuredTemplateName : null,
        };
        remoteTemplates.push({
          id:
            String(
              created?.id ||
                created?.message_template_id ||
                created?.template_id ||
                "",
            ).trim() || undefined,
          name: createTemplateName,
          language: createDefinition.language,
          status: "IN_REVIEW",
        });
      } catch (e) {
        if (isMetaAuthHttpError(e)) {
          throw e;
        }

        if (isMetaTemplateLanguageDeletingError(e)) {
          const retryTemplateName = buildRetryTemplateName(
            definition.templateName,
            remoteTemplates,
            { forceUnique: true },
          );
          if (retryTemplateName) {
            try {
              const retryDefinition = {
                ...definition,
                templateName: retryTemplateName,
                language: String(tpl.language || definition.language || "en"),
              };
              const retryCreated = await createMetaTemplate({
                wabaId,
                accessToken,
                definition: retryDefinition,
              });
              nextTemplateNameByKey.set(key, retryTemplateName);
              createResults[key] = {
                action: "recreated",
                status: "in_review",
                templateName: retryTemplateName,
                previousTemplateName: createTemplateName,
              };
              remoteTemplates.push({
                id:
                  String(
                    retryCreated?.id ||
                      retryCreated?.message_template_id ||
                      retryCreated?.template_id ||
                      "",
                  ).trim() || undefined,
                name: retryTemplateName,
                language: retryDefinition.language,
                status: "IN_REVIEW",
              });
              continue;
            } catch (retryErr) {
              if (isMetaAuthHttpError(retryErr)) {
                throw retryErr;
              }
              createResults[key] = {
                action: "error",
                message: summarizeMetaApiError(retryErr),
              };
              continue;
            }
          }
        }

        if (isMetaTemplateAlreadyExistsError(e)) {
          nextTemplateNameByKey.set(key, createTemplateName);
          createResults[key] = {
            action: "exists",
            status: "in_review",
            templateName: createTemplateName,
          };
        } else {
          createResults[key] = {
            action: "error",
            message: summarizeMetaApiError(e),
          };
        }
      }
    }

    let syncedRemoteTemplates = remoteTemplates;
    try {
      syncedRemoteTemplates = await fetchMetaTemplateStatuses({
        wabaId,
        accessToken,
      });
    } catch {
      // Keep create results and proceed with best-effort local state if sync fails.
      syncedRemoteTemplates = remoteTemplates;
    }

    const templatesForMerge = startingTemplates.map((tpl) => {
      const key = String(tpl?.key || "").trim();
      const definition = OWN_NUMBER_TEMPLATE_DEFINITIONS[key];
      const fallbackName = String(
        tpl?.templateName || definition?.templateName || "",
      )
        .trim()
        .toLowerCase();
      const resolvedName = String(
        nextTemplateNameByKey.get(key) || fallbackName,
      ).trim();
      return {
        ...tpl,
        templateName: resolvedName || fallbackName,
      };
    });

    const syncedBase = mergeTemplateStatusesWithMeta(
      templatesForMerge,
      syncedRemoteTemplates,
    );
    const now = new Date();
    const templates = syncedBase.map((tpl) => {
      const result = createResults[String(tpl.key || "").trim()];
      if (!result || result.action !== "error") return tpl;
      return {
        ...tpl,
        status:
          normalizeTemplateStatus(tpl.status) === "approved"
            ? "approved"
            : "error",
        lastCheckedAt: now,
        lastError: result.message,
      };
    });
    const registrationReady = isStoredOwnNumberCloudConnected(own);
    const webhookReady =
      !!own?.webhookSubscribedAt &&
      !String(own?.webhookSubscriptionError || "").trim();
    const ready =
      !!phoneNumberId &&
      allTemplatesApproved(templates) &&
      registrationReady &&
      webhookReady;
    const createdCount = Object.values(createResults).filter((r) =>
      ["created", "recreated"].includes(String(r?.action || "")),
    ).length;
    const failedCount = Object.values(createResults).filter(
      (r) => r?.action === "error",
    ).length;
    const templatesReadyAt = ready
      ? own?.templatesReadyAt || own?.readyAt || now
      : null;
    const readyAt = ready ? own?.readyAt || own?.templatesReadyAt || now : null;

    await Shop.updateOne(
      { shop },
      {
        $set: {
          "whatsappSender.ownNumber.templates": templates,
          "whatsappSender.ownNumber.templatesLastSyncedAt": now,
          "whatsappSender.ownNumber.status": ready
            ? "ready"
            : registrationReady
              ? webhookReady
                ? "templates_pending"
                : "error"
              : "registration_pending",
          "whatsappSender.ownNumber.templatesReadyAt": templatesReadyAt,
          "whatsappSender.ownNumber.readyAt": readyAt,
          "whatsappSender.ownNumber.lastError":
            failedCount > 0 ? "Some templates could not be created" : null,
          "whatsappSender.ownNumber.lastErrorAt": failedCount > 0 ? now : null,
        },
      },
    );

    void logAudit({
      shop,
      actor: "merchant",
      action: "byon_templates_provision_requested",
      meta: { ready, createdCount, failedCount },
    });

    const sender = await getSenderResponse(shop, {
      refreshTemplates: true,
      forceTemplateRefresh: true,
    });
    return res.json({
      ok: true,
      sender,
      createdCount,
      failedCount,
      webhookSubscriptionError: webhookEnsure?.ok
        ? null
        : webhookEnsure?.error || null,
      note:
        failedCount > 0
          ? `Created ${createdCount} template(s). ${failedCount} template(s) need retry.`
          : createdCount > 0
            ? `Created ${createdCount} template(s). Meta approval may still be pending.`
            : "Template pack already exists or is already synced.",
    });
  } catch (e) {
    const shop = String(req.query.shop || "").trim();
    if (shop) {
      const nextStatus = isMetaAuthHttpError(e) ? "reauth_required" : "error";
      await Shop.updateOne(
        { shop },
        {
          $set: {
            "whatsappSender.ownNumber.lastError": String(
              e?.message ||
                (nextStatus === "reauth_required"
                  ? "Meta authorization failed. Reconnect Meta and retry."
                  : "Template provisioning failed"),
            ),
            "whatsappSender.ownNumber.lastErrorAt": new Date(),
            "whatsappSender.ownNumber.status": nextStatus,
          },
        },
      ).catch(() => {});
    }
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

router.post("/sender/byon/templates/sync", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });
    const current = await Shop.findOne({ shop }).lean();
    ensureOwnNumberPlanAccess(current);
    logByonTemplateSync("manual_sync_requested", {
      shop,
    });
    const synced = await runOwnNumberTemplateSync({
      shop,
      force: true,
      source: "manual",
    });
    if (!synced?.ok && synced?.reason === "missing_waba") {
      return res
        .status(409)
        .json({ error: "Meta connection is required first" });
    }
    if (!synced?.ok && synced?.reason === "reauth_required") {
      return res.status(409).json({
        error:
          "Meta access token has expired. Reconnect Meta before syncing template statuses.",
        sender: serializeSender(synced?.record, synced?.billing || null),
      });
    }

    void logAudit({
      shop,
      actor: "merchant",
      action: "byon_templates_synced",
      meta: {
        ready: !!synced?.ready,
        approvedCount: Array.isArray(synced?.templates)
          ? synced.templates.filter((t) => t.status === "approved").length
          : 0,
      },
    });

    const sender = await getSenderResponse(shop, {
      refreshTemplates: true,
      forceTemplateRefresh: true,
    });
    logByonTemplateSync("manual_sync_response", {
      shop,
      senderTemplates: summarizeTemplateDebugRows(
        sender?.ownNumber?.templates || [],
      ),
      ownStatus: sender?.ownNumber?.status || null,
    });
    return res.json({
      ok: true,
      sender,
      webhookSubscriptionError: synced?.webhookSubscriptionError || null,
    });
  } catch (e) {
    const shop = String(req.query.shop || "").trim();
    if (shop) {
      const nextStatus = isMetaAuthHttpError(e) ? "reauth_required" : "error";
      await Shop.updateOne(
        { shop },
        {
          $set: {
            "whatsappSender.ownNumber.lastError": String(
              e?.message ||
                (nextStatus === "reauth_required"
                  ? "Meta authorization failed. Reconnect Meta and retry."
                  : "Failed"),
            ),
            "whatsappSender.ownNumber.lastErrorAt": new Date(),
            "whatsappSender.ownNumber.status": nextStatus,
          },
        },
      ).catch(() => {});
    }
    return res
      .status(Number(e?.httpStatus || 500) || 500)
      .json({ error: e?.message || "Failed" });
  }
});

router.post("/sender/byon/reset", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const templates = buildOwnNumberTemplatePack([]);
    await Shop.findOneAndUpdate(
      { shop },
      {
        $set: {
          "whatsappSender.preferenceMode": SENDER_MODES.OWN_NUMBER,
          "whatsappSender.ownNumber.status": "not_started",
          "whatsappSender.ownNumber.lastError": null,
          "whatsappSender.ownNumber.lastErrorMeta": null,
          "whatsappSender.ownNumber.lastErrorAt": null,
          "whatsappSender.ownNumber.startedAt": null,
          "whatsappSender.ownNumber.detailsSubmittedAt": null,
          "whatsappSender.ownNumber.metaConnectedAt": null,
          "whatsappSender.ownNumber.templatesReadyAt": null,
          "whatsappSender.ownNumber.readyAt": null,
          "whatsappSender.ownNumber.metaBusinessId": null,
          "whatsappSender.ownNumber.wabaId": null,
          "whatsappSender.ownNumber.phoneNumberId": null,
          "whatsappSender.ownNumber.metaFeatureType": null,
          "whatsappSender.ownNumber.accessToken": null,
          "whatsappSender.ownNumber.accessTokenUpdatedAt": null,
          "whatsappSender.ownNumber.accessTokenExpiresAt": null,
          "whatsappSender.ownNumber.accessTokenRefreshAttemptedAt": null,
          "whatsappSender.ownNumber.accessTokenRefreshError": null,
          "whatsappSender.ownNumber.accessTokenRefreshErrorAt": null,
          "whatsappSender.ownNumber.webhookSubscribedAt": null,
          "whatsappSender.ownNumber.webhookSubscriptionError": null,
          "whatsappSender.ownNumber.webhookSubscriptionErrorAt": null,
          "whatsappSender.ownNumber.paymentMethodConfirmedAt": null,
          "whatsappSender.ownNumber.webhookTestStatus": "not_started",
          "whatsappSender.ownNumber.webhookTestTargetPhoneE164": "",
          "whatsappSender.ownNumber.webhookTestExpectedReplyCode": "",
          "whatsappSender.ownNumber.webhookTestSentAt": null,
          "whatsappSender.ownNumber.webhookTestOutboundMessageId": null,
          "whatsappSender.ownNumber.webhookTestReplyReceivedAt": null,
          "whatsappSender.ownNumber.webhookTestReplyMessageId": null,
          "whatsappSender.ownNumber.webhookTestReplyText": "",
          "whatsappSender.ownNumber.webhookTestLastError": null,
          "whatsappSender.ownNumber.webhookTestLastErrorAt": null,
          "whatsappSender.ownNumber.sendErrorStreak": 0,
          "whatsappSender.ownNumber.sendFailureEvents": [],
          "whatsappSender.ownNumber.lastSendError": null,
          "whatsappSender.ownNumber.lastSendErrorMeta": null,
          "whatsappSender.ownNumber.lastSendErrorAt": null,
          "whatsappSender.ownNumber.pauseSending": false,
          "whatsappSender.ownNumber.pauseReason": null,
          "whatsappSender.ownNumber.pauseSetAt": null,
          "whatsappSender.ownNumber.registrationStatus": "unknown",
          "whatsappSender.ownNumber.registrationOutcome": null,
          "whatsappSender.ownNumber.registrationPin": null,
          "whatsappSender.ownNumber.registrationLastAttemptAt": null,
          "whatsappSender.ownNumber.registrationError": null,
          "whatsappSender.ownNumber.registrationErrorAt": null,
          "whatsappSender.ownNumber.registrationRegisteredAt": null,
          "whatsappSender.ownNumber.registrationDisplayPhoneNumber": null,
          "whatsappSender.ownNumber.registrationVerifiedName": null,
          "whatsappSender.ownNumber.registrationCodeVerificationStatus": null,
          "whatsappSender.ownNumber.registrationPlatformType": null,
          "whatsappSender.ownNumber.registrationPhoneStatus": null,
          "whatsappSender.ownNumber.registrationAccountMode": null,
          "whatsappSender.ownNumber.registrationLastMetadataAt": null,
          "whatsappSender.ownNumber.testMessageSentAt": null,
          "whatsappSender.ownNumber.testMessageTargetPhoneE164": "",
          "whatsappSender.ownNumber.testMessageOutboundMessageId": null,
          "whatsappSender.ownNumber.testMessageStatus": "not_started",
          "whatsappSender.ownNumber.testMessageStatusAt": null,
          "whatsappSender.ownNumber.testMessageLastError": null,
          "whatsappSender.ownNumber.testMessageLastErrorMeta": null,
          "whatsappSender.ownNumber.testMessageLastErrorAt": null,
          "whatsappSender.ownNumber.onboardingCompletedAt": null,
          "whatsappSender.ownNumber.pendingConnectState": null,
          "whatsappSender.ownNumber.pendingConnectStateExpiresAt": null,
          "whatsappSender.ownNumber.lastCompletedConnectStateHash": null,
          "whatsappSender.ownNumber.lastCompletedConnectAt": null,
          "whatsappSender.ownNumber.displayPhoneNumber": "",
          "whatsappSender.ownNumber.templatesLastSyncedAt": null,
          "whatsappSender.ownNumber.businessName": "",
          "whatsappSender.ownNumber.contactName": "",
          "whatsappSender.ownNumber.contactEmail": "",
          "whatsappSender.ownNumber.requestedPhoneNumber": "",
          "whatsappSender.ownNumber.templateLanguage": "en",
          "whatsappSender.ownNumber.templates": templates,
        },
        $setOnInsert: { shop },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );

    void logAudit({
      shop,
      actor: "merchant",
      action: "byon_onboarding_reset",
      meta: {},
    });

    const sender = await getSenderResponse(shop, {
      refreshTemplates: true,
      forceTemplateRefresh: true,
    });
    return res.json({ ok: true, sender });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

router.post("/sender/byon/test-send", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const to = normalizeSupportWhatsAppNumber(
      req.body?.to || req.body?.phone || req.body?.toE164,
    );
    const customerName = String(req.body?.customerName || "")
      .trim()
      .slice(0, 120);

    if (!to || !isValidE164(to)) {
      return res.status(400).json({
        error: "Valid WhatsApp number is required (E.164, e.g. +923001234567)",
      });
    }

    const [record, billing] = await Promise.all([
      Shop.findOne({ shop }).lean(),
      getBillingStatus(shop),
    ]);

    const planSenderMode = normalizeSenderMode(
      billing?.plan?.senderMode,
      SENDER_MODES.ORDERX_NUMBER,
    );
    const preferenceMode = normalizeSenderMode(
      record?.whatsappSender?.preferenceMode,
      "",
    );
    const isBillingActive = !!billing?.active;
    if (
      (isBillingActive && planSenderMode !== SENDER_MODES.OWN_NUMBER) ||
      (!isBillingActive && preferenceMode !== SENDER_MODES.OWN_NUMBER)
    ) {
      const sender = await getSenderResponse(shop, {
        refreshTemplates: true,
        forceTemplateRefresh: true,
      }).catch(() => null);
      return res.status(409).json({
        error: "BYON test send is only available in the Your Own Number flow",
        sender,
      });
    }

    const own = record?.whatsappSender?.ownNumber || {};
    const senderPhoneForTest = String(
      own?.displayPhoneNumber || own?.requestedPhoneNumber || "",
    ).trim();
    if (senderPhoneForTest && e164Matches(to, senderPhoneForTest)) {
      return res.status(400).json({
        error:
          "Use a different WhatsApp number for testing. Test destination cannot be the same as your connected sender number.",
      });
    }
    if (!isBillingActive && own?.onboardingCompletedAt) {
      const sender = await getSenderResponse(shop, {
        refreshTemplates: true,
        forceTemplateRefresh: true,
      }).catch(() => null);
      return res.status(409).json({
        error:
          "Onboarding test is already complete. Subscribe to the BYON package to continue sending.",
        sender,
      });
    }
    const ownTemplatesApproved =
      Array.isArray(own?.templates) &&
      own.templates.length > 0 &&
      own.templates.every(
        (tpl) =>
          String(tpl?.status || "")
            .trim()
            .toLowerCase() === "approved",
      );
    const registrationStatus = resolveOwnNumberRegistrationStatus(own);
    const rawOwnStatus = normalizeOwnNumberStatus(own?.status);
    const canInferOwnReady =
      !OWN_NUMBER_READY_INFERENCE_BLOCKED_STATUSES.has(rawOwnStatus);
    const ownStatus = normalizeOwnNumberStatus(
      rawOwnStatus === "ready" ||
        (canInferOwnReady &&
          registrationStatus === "registered" &&
          !!String(own?.phoneNumberId || "").trim() &&
          !!String(own?.accessToken || "").trim() &&
          ownTemplatesApproved)
        ? "ready"
        : rawOwnStatus,
    );
    if (ownStatus !== "ready" || registrationStatus !== "registered") {
      const sender = await getSenderResponse(shop, {
        refreshTemplates: true,
        forceTemplateRefresh: true,
      }).catch(() => null);
      return res.status(409).json({
        error:
          ownStatus === "reauth_required"
            ? "Meta reconnect required before sending a test message"
            : registrationStatus !== "registered"
              ? own?.registrationError ||
                "WhatsApp Cloud registration is not complete yet"
              : "Own number setup is not complete yet",
        sender,
      });
    }

    const tokenState = await resolveFreshOwnNumberAccessToken({ shop, own });
    const hasPhoneId = !!String(own?.phoneNumberId || "").trim();
    const hasAccessToken = !!String(tokenState?.accessToken || "").trim();
    const tokenExpired = isMetaAccessTokenExpired(
      tokenState?.accessTokenExpiresAt,
    );

    if (!hasPhoneId || !hasAccessToken || tokenExpired) {
      await Shop.updateOne(
        { shop },
        {
          $set: {
            "whatsappSender.ownNumber.status": "reauth_required",
            "whatsappSender.ownNumber.lastError":
              "Meta access token is missing or expired. Reconnect Meta and retry.",
            "whatsappSender.ownNumber.lastErrorAt": new Date(),
          },
        },
      ).catch(() => {});

      const sender = await getSenderResponse(shop, {
        refreshTemplates: true,
        forceTemplateRefresh: true,
      }).catch(() => null);
      return res.status(409).json({
        error:
          "Meta access token is missing or expired. Reconnect Meta and retry.",
        sender,
      });
    }

    const wabaId = String(own?.wabaId || "").trim();
    const webhookEnsure =
      wabaId && hasAccessToken && !tokenExpired
        ? await ensureOwnNumberWebhookSubscription({
            shop,
            wabaId,
            accessToken: tokenState.accessToken,
          })
        : {
            ok: false,
            skipped: true,
            error: "Missing WABA/token for webhook subscribe",
          };

    const templates = buildOwnNumberTemplatePack(own?.templates);
    const testTemplate = templates.find((t) => t.key === "cod_confirm_new");
    const approvedTestTemplateStatus = normalizeTemplateStatus(
      testTemplate?.status,
    );
    if (approvedTestTemplateStatus !== "approved") {
      const sender = await getSenderResponse(shop, {
        refreshTemplates: true,
        forceTemplateRefresh: true,
      }).catch(() => null);
      return res.status(409).json({
        error:
          "Test template is not approved yet. Approve/sync templates first and retry.",
        templateKey: "cod_confirm_new",
        templateStatus: approvedTestTemplateStatus,
        sender,
      });
    }

    if (isBillingActive) {
      const byonPhoneId = String(own?.phoneNumberId || "").trim();
      const gate = await canSendWhatsApp(shop, {
        toE164: to,
        senderPhoneNumberId: byonPhoneId,
        isTemplate: true,
      });
      if (!gate?.ok) {
        const sender = await getSenderResponse(shop, {
          refreshTemplates: true,
          forceTemplateRefresh: true,
        }).catch(() => null);
        return res.status(409).json({
          error: gate?.reason || "Cannot send right now",
          gate,
          sender,
        });
      }
    }

    const storeName =
      String(own?.businessName || "").trim() ||
      String(record?.shop || "")
        .replace(".myshopify.com", "")
        .trim() ||
      "Your Store";
    const orderNumber = `#BYON-TEST-${String(Date.now()).slice(-6)}`;
    const sent = await sendCodConfirmReplyTemplate({
      to,
      customerName: customerName || "Customer",
      storeName,
      orderNumber,
      productsText: "Test Product x1",
      amountText: "PKR 100",
      deliveryAddressText: "Test Address",
      shop,
      kind: "byon_live_test_template",
      skipBillingCheck: !isBillingActive,
      meta: {
        source: "byon_live_test_send",
        templateKey: "cod_confirm_new",
      },
    });

    let usageCounted = true;
    try {
      await incrementWhatsAppUsage(shop, 1, {
        isTemplate: true,
        toE164: to,
        countInitiatedConversation: isBillingActive,
        senderPhoneNumberId: String(own?.phoneNumberId || "").trim(),
      });
    } catch (e) {
      usageCounted = false;
      console.error("[byon_test_send_usage]", shop, e?.message || e);
    }

    const queuedAt = new Date();
    const testWaMessageId = sent?.data?.messages?.[0]?.id || null;
    if (!testWaMessageId) {
      const err = new Error(
        "Meta did not return a message ID for the live test send. Please retry.",
      );
      err.httpStatus = 502;
      throw err;
    }
    await Shop.updateOne(
      { shop },
      {
        $set: {
          "whatsappSender.ownNumber.templatesReadyAt":
            own?.templatesReadyAt || own?.readyAt || queuedAt,
          "whatsappSender.ownNumber.readyAt":
            own?.readyAt || own?.templatesReadyAt || queuedAt,
          "whatsappSender.preferenceMode": SENDER_MODES.OWN_NUMBER,
          "whatsappSender.ownNumber.status": "ready",
          "whatsappSender.ownNumber.lastError": null,
          "whatsappSender.ownNumber.lastErrorMeta": null,
          "whatsappSender.ownNumber.lastErrorAt": null,
          "whatsappSender.ownNumber.registrationStatus": "registered",
          "whatsappSender.ownNumber.registrationOutcome": "READY",
          "whatsappSender.ownNumber.registrationError": null,
          "whatsappSender.ownNumber.registrationErrorAt": null,
          "whatsappSender.ownNumber.registrationRegisteredAt":
            own?.registrationRegisteredAt || queuedAt,
          "whatsappSender.ownNumber.testMessageSentAt": queuedAt,
          "whatsappSender.ownNumber.testMessageTargetPhoneE164": to,
          "whatsappSender.ownNumber.testMessageOutboundMessageId":
            testWaMessageId,
          // Meta accepted the message request, so mark this as sent immediately.
          // Later status webhooks can still upgrade to delivered/read or downgrade to failed.
          "whatsappSender.ownNumber.testMessageStatus": "sent",
          "whatsappSender.ownNumber.testMessageStatusAt": queuedAt,
          "whatsappSender.ownNumber.testMessageLastError": null,
          "whatsappSender.ownNumber.testMessageLastErrorMeta": null,
          "whatsappSender.ownNumber.testMessageLastErrorAt": null,
          "whatsappSender.ownNumber.onboardingCompletedAt": null,
          "whatsappSender.ownNumber.webhookTestStatus": "waiting_reply",
          "whatsappSender.ownNumber.webhookTestTargetPhoneE164": to,
          "whatsappSender.ownNumber.webhookTestExpectedReplyCode": "",
          "whatsappSender.ownNumber.webhookTestSentAt": queuedAt,
          "whatsappSender.ownNumber.webhookTestOutboundMessageId":
            testWaMessageId,
          "whatsappSender.ownNumber.webhookTestReplyReceivedAt": null,
          "whatsappSender.ownNumber.webhookTestReplyMessageId": null,
          "whatsappSender.ownNumber.webhookTestReplyText": "",
          "whatsappSender.ownNumber.webhookTestLastError": webhookEnsure?.ok
            ? null
            : webhookEnsure?.error || null,
          "whatsappSender.ownNumber.webhookTestLastErrorAt": webhookEnsure?.ok
            ? null
            : queuedAt,
        },
      },
    ).catch(() => {});

    void logAudit({
      shop,
      actor: "merchant",
      action: "byon_test_send",
      meta: {
        to,
        templateKey: "cod_confirm_new",
        waMessageId: sent?.data?.messages?.[0]?.id || null,
      },
    });

    const sender = await getSenderResponse(shop, {
      refreshTemplates: true,
      forceTemplateRefresh: true,
    }).catch(() => null);
    return res.json({
      ok: true,
      sender,
      testSend: {
        mode: "template",
        to,
        templateKey: "cod_confirm_new",
        templateUsed: sent?.templateUsed || null,
        waMessageId: testWaMessageId,
        sentAt: queuedAt,
        countsTowardUsage: usageCounted && isBillingActive,
      },
      webhookSubscriptionError: webhookEnsure?.ok
        ? null
        : webhookEnsure?.error || null,
    });
  } catch (e) {
    const shop = String(req.query.shop || "").trim();
    const now = new Date();
    if (shop) {
      const maybeTo = normalizeSupportWhatsAppNumber(
        req.body?.to || req.body?.phone || req.body?.toE164,
      );
      const shortError = String(
        friendlyByonSendError(e, "Failed to send BYON test message"),
      ).slice(0, 400);
      await Shop.updateOne(
        { shop },
        {
          $set: {
            "whatsappSender.ownNumber.testMessageStatus": "failed",
            "whatsappSender.ownNumber.testMessageStatusAt": now,
            "whatsappSender.ownNumber.testMessageLastError": shortError,
            "whatsappSender.ownNumber.testMessageLastErrorMeta":
              e?.meta || null,
            "whatsappSender.ownNumber.testMessageLastErrorAt": now,
            "whatsappSender.ownNumber.lastError": shortError,
            "whatsappSender.ownNumber.lastErrorAt": now,
            ...(maybeTo
              ? {
                  "whatsappSender.ownNumber.testMessageTargetPhoneE164":
                    maybeTo,
                }
              : {}),
            "whatsappSender.ownNumber.webhookTestStatus": "not_started",
            "whatsappSender.ownNumber.webhookTestTargetPhoneE164": "",
            "whatsappSender.ownNumber.webhookTestExpectedReplyCode": "",
            "whatsappSender.ownNumber.webhookTestSentAt": null,
            "whatsappSender.ownNumber.webhookTestOutboundMessageId": null,
            "whatsappSender.ownNumber.webhookTestReplyReceivedAt": null,
            "whatsappSender.ownNumber.webhookTestReplyMessageId": null,
            "whatsappSender.ownNumber.webhookTestReplyText": "",
            "whatsappSender.ownNumber.webhookTestLastError": null,
            "whatsappSender.ownNumber.webhookTestLastErrorAt": null,
            "whatsappSender.ownNumber.onboardingCompletedAt": null,
          },
        },
      ).catch(() => {});
    }
    const sender = shop
      ? await getSenderResponse(shop, {
          refreshTemplates: true,
          forceTemplateRefresh: true,
        }).catch(() => null)
      : null;
    const status = Number(e?.httpStatus || e?.status || e?.statusCode || 500);
    const safeStatus = status >= 400 && status < 600 ? status : 500;
    return res.status(safeStatus).json({
      error: friendlyByonSendError(e, "Failed to send BYON test message"),
      ...(e?.meta ? { meta: e.meta } : {}),
      ...(sender ? { sender } : {}),
    });
  }
});

router.post("/sender/byon/test-status/check", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });
    const row = await Shop.findOne({ shop })
      .select({
        shop: 1,
        "whatsappSender.ownNumber.testMessageStatus": 1,
        "whatsappSender.ownNumber.testMessageStatusAt": 1,
        "whatsappSender.ownNumber.testMessageSentAt": 1,
        "whatsappSender.ownNumber.testMessageOutboundMessageId": 1,
        "whatsappSender.ownNumber.testMessageLastError": 1,
        "whatsappSender.ownNumber.testMessageLastErrorAt": 1,
        "whatsappSender.ownNumber.webhookTestStatus": 1,
        "whatsappSender.ownNumber.webhookTestLastError": 1,
        "whatsappSender.ownNumber.webhookTestLastErrorAt": 1,
        "whatsappSender.ownNumber.onboardingCompletedAt": 1,
        "whatsappSender.ownNumber.wabaId": 1,
        "whatsappSender.ownNumber.accessToken": 1,
        "whatsappSender.ownNumber.phoneNumberId": 1,
      })
      .lean();

    const own = row?.whatsappSender?.ownNumber || {};
    const outboundMessageId = String(
      own?.testMessageOutboundMessageId || "",
    ).trim();
    const currentStatus = normalizeWaDeliveryStatus(own?.testMessageStatus);

    if (outboundMessageId) {
      const msgLog = await WaMessageLog.findOne({
        shop,
        waMessageId: outboundMessageId,
      })
        .sort({ createdAt: -1 })
        .select({ meta: 1 })
        .lean()
        .catch(() => null);
      const logStatus = normalizeWaDeliveryStatus(msgLog?.meta?.deliveryStatus);
      const logError = String(msgLog?.meta?.deliveryError || "").trim();
      const now = new Date();

      if (logStatus && logStatus !== currentStatus) {
        const success = isSuccessfulWaDeliveryStatus(logStatus);
        await Shop.updateOne(
          { shop },
          {
            $set: {
              "whatsappSender.ownNumber.testMessageStatus": logStatus,
              "whatsappSender.ownNumber.testMessageStatusAt": now,
              "whatsappSender.ownNumber.testMessageLastError": success
                ? null
                : logError || "Message delivery failed",
              "whatsappSender.ownNumber.testMessageLastErrorAt": success
                ? null
                : now,
              ...(success
                ? {}
                : {
                    "whatsappSender.ownNumber.webhookTestStatus": "failed",
                    "whatsappSender.ownNumber.webhookTestLastError":
                      logError || "Live test delivery failed. Send test again.",
                    "whatsappSender.ownNumber.webhookTestLastErrorAt": now,
                  }),
              "whatsappSender.ownNumber.onboardingCompletedAt": null,
            },
          },
        ).catch(() => {});
      } else if (currentStatus === "queued" && !logStatus) {
        // If Meta accepted the send but we still don't have a webhook status event,
        // treat this as sent so the UI does not remain stuck in pending forever.
        await Shop.updateOne(
          { shop },
          {
            $set: {
              "whatsappSender.ownNumber.testMessageStatus": "sent",
              "whatsappSender.ownNumber.testMessageStatusAt": now,
              "whatsappSender.ownNumber.testMessageLastError": null,
              "whatsappSender.ownNumber.testMessageLastErrorAt": null,
            },
          },
        ).catch(() => {});
      }
    }

    const sender = await getSenderResponse(shop, {
      refreshTemplates: true,
      forceTemplateRefresh: true,
    });
    const testMessage = sender?.ownNumber?.testMessage || null;
    const webhookTest = sender?.ownNumber?.webhookTest || null;
    return res.json({ ok: true, sender, testMessage, webhookTest });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

function buildSimulatedWebhookBody({
  fromE164,
  text,
  receiverPhoneNumberId,
  displayPhoneNumber,
  inboundWaMessageId,
  contextMessageId,
}) {
  const fromDigits = normalizeDigits(fromE164);
  const phoneNumberId = String(receiverPhoneNumberId || "").trim();
  const messageId =
    String(inboundWaMessageId || "").trim() ||
    `SIMULATED-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const replyText = String(text || "").trim();
  const replyContextId = String(contextMessageId || "").trim();
  const message = replyContextId
    ? {
        from: fromDigits,
        id: messageId,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: "button",
        button: {
          text: replyText,
          payload: replyText,
        },
        context: {
          id: replyContextId,
        },
      }
    : {
        from: fromDigits,
        id: messageId,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: "text",
        text: { body: replyText },
      };

  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: phoneNumberId,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: String(displayPhoneNumber || "").trim(),
                phone_number_id: phoneNumberId,
              },
              contacts: [
                {
                  wa_id: fromDigits,
                  profile: { name: "Webhook Simulator" },
                },
              ],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

function buildWebhookSignature(rawBody) {
  const secret = String(
    process.env.WA_APP_SECRET || process.env.WA_SECRET || "",
  ).trim();
  if (!secret) return "";
  return `sha256=${crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex")}`;
}

function getLocalWebhookTargetUrl() {
  return (
    String(process.env.WHATSAPP_WEBHOOK_SIMULATOR_BASE_URL || "").trim() ||
    `http://127.0.0.1:${process.env.PORT || 8081}`
  );
}

router.post("/sender/byon/webhook-simulate", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const fromE164 = normalizeSupportWhatsAppNumber(
      req.body?.fromE164 || req.body?.from || req.body?.phone || "",
    );
    const text = String(req.body?.text || "").trim();
    const requestedReceiverPhoneNumberId = String(
      req.body?.receiverPhoneNumberId || "",
    ).trim();

    if (!fromE164) {
      return res.status(400).json({ error: "Missing fromE164" });
    }
    if (!text) {
      return res.status(400).json({ error: "Missing text" });
    }

    const own = await Shop.findOne({ shop })
      .select({
        "whatsappSender.ownNumber.phoneNumberId": 1,
        "whatsappSender.ownNumber.displayPhoneNumber": 1,
      })
      .lean();
    const receiverPhoneNumberId =
      requestedReceiverPhoneNumberId ||
      String(own?.whatsappSender?.ownNumber?.phoneNumberId || "").trim();
    if (!receiverPhoneNumberId) {
      return res.status(409).json({
        error:
          "Missing connected WhatsApp phone_number_id. Connect BYON first or pass receiverPhoneNumberId.",
      });
    }

    const inferredContextMessageId =
      String(req.body?.messageId || req.body?.contextMessageId || "").trim() ||
      String(
        (
          await WaMessageLog.findOne({
            shop,
            direction: "outbound",
            toE164: fromE164,
            senderPhoneNumberId: receiverPhoneNumberId,
          })
            .sort({ createdAt: -1 })
            .select({ waMessageId: 1 })
            .lean()
            .catch(() => null)
        )?.waMessageId || "",
      ).trim();

    const body = buildSimulatedWebhookBody({
      fromE164,
      text,
      receiverPhoneNumberId,
      displayPhoneNumber:
        own?.whatsappSender?.ownNumber?.displayPhoneNumber || "",
      contextMessageId: inferredContextMessageId,
    });
    const rawBody = JSON.stringify(body);
    const webhookSecret = String(
      process.env.WA_APP_SECRET || process.env.WA_SECRET || "",
    ).trim();
    const allowUnsigned =
      String(process.env.ALLOW_UNSIGNED_WA_WEBHOOK || "").toLowerCase() ===
        "true" ||
      String(process.env.NODE_ENV || "").toLowerCase() !== "production";
    const headers = {
      "Content-Type": "application/json",
    };
    const signature = buildWebhookSignature(rawBody);
    if (signature) {
      headers["X-Hub-Signature-256"] = signature;
    } else if (!allowUnsigned) {
      return res.status(409).json({
        error:
          "WA_APP_SECRET or WA_SECRET is required to simulate a signed webhook in production.",
      });
    }

    const targetUrl = new URL("/whatsapp/webhook", getLocalWebhookTargetUrl());
    const forwardedRes = await fetch(targetUrl.toString(), {
      method: "POST",
      headers,
      body: rawBody,
    });
    const forwardedText = await forwardedRes.text().catch(() => "");
    let forwardedBody = {};
    if (forwardedText) {
      try {
        forwardedBody = JSON.parse(forwardedText);
      } catch {
        forwardedBody = { raw: forwardedText.slice(0, 500) };
      }
    }

    void logAudit({
      shop,
      actor: "merchant",
      action: "byon_webhook_simulate",
      meta: {
        fromE164,
        text: text.slice(0, 200),
        receiverPhoneNumberId,
      },
    });

    return res.json({
      ok: true,
      webhookSimulation: {
        forwarded: true,
        forwardedStatus: forwardedRes.status,
        forwardedResponse: forwardedBody,
        fromE164,
        receiverPhoneNumberId,
        text,
        messageId:
          body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.id || null,
        contextMessageId:
          body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.context?.id ||
          null,
      },
    });
  } catch (e) {
    const shop = String(req.query.shop || "").trim();
    const sender = shop
      ? await getSenderResponse(shop, {
          refreshTemplates: true,
          forceTemplateRefresh: true,
        }).catch(() => null)
      : null;
    return res.status(500).json({
      error: e?.message || "Failed to simulate webhook reply",
      ...(sender ? { sender } : {}),
    });
  }
});

router.post("/sender/byon/webhook-test/start", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });
    const sender = await getSenderResponse(shop, {
      refreshTemplates: true,
      forceTemplateRefresh: true,
    }).catch(() => null);
    return res.status(409).json({
      error:
        "Webhook verification now runs in the same live test flow. Send the live test template first, then reply to that same message and check status.",
      ...(sender ? { sender } : {}),
    });
  } catch (e) {
    const shop = String(req.query.shop || "").trim();
    const sender = shop
      ? await getSenderResponse(shop, {
          refreshTemplates: true,
          forceTemplateRefresh: true,
        }).catch(() => null)
      : null;
    const status = Number(e?.httpStatus || e?.status || e?.statusCode || 500);
    const safeStatus = status >= 400 && status < 600 ? status : 500;
    return res.status(safeStatus).json({
      error: friendlyByonSendError(e, "Failed to start webhook reply test"),
      ...(e?.meta ? { meta: e.meta } : {}),
      ...(sender ? { sender } : {}),
    });
  }
});

router.post("/sender/byon/webhook-test/check", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });
    const sender = await getSenderResponse(shop, {
      refreshTemplates: true,
      forceTemplateRefresh: true,
    });
    const webhookTest = sender?.ownNumber?.webhookTest || null;
    return res.json({ ok: true, sender, webhookTest });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

router.post("/sender/byon/retry-now", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const now = new Date();
    await Shop.updateOne(
      { shop },
      {
        $set: {
          "whatsappSender.preferenceMode": SENDER_MODES.OWN_NUMBER,
          "whatsappSender.ownNumber.pauseSending": false,
          "whatsappSender.ownNumber.pauseReason": null,
          "whatsappSender.ownNumber.pauseSetAt": null,
          "whatsappSender.ownNumber.sendErrorStreak": 0,
          "whatsappSender.ownNumber.sendFailureEvents": [],
          "whatsappSender.ownNumber.lastSendError": null,
          "whatsappSender.ownNumber.lastSendErrorMeta": null,
          "whatsappSender.ownNumber.lastSendErrorAt": null,
        },
      },
    );

    const retryLimit = Math.max(
      10,
      Math.min(300, Number(process.env.BYON_RETRY_NOW_ATTEMPT_LIMIT || 120)),
    );
    const [scheduledRows, failedRows] = await Promise.all([
      CodAttempt.find({
        shop,
        status: "scheduled",
        waSentAt: { $in: [null] },
      })
        .select({ _id: 1 })
        .sort({ scheduledAt: 1, createdAt: 1 })
        .limit(retryLimit)
        .lean(),
      CodAttempt.find({
        shop,
        status: "failed",
        waSentAt: { $in: [null] },
        $or: [
          {
            "lastErrorMeta.classified.reason": {
              $in: [
                "wa_rate_limited",
                "wa_server_error",
                "wa_unknown",
                "wa_auth",
              ],
            },
          },
          { lastError: /whatsapp|meta|rate|timeout|network/i },
        ],
      })
        .select({ _id: 1 })
        .sort({ lastErrorAt: -1, createdAt: -1 })
        .limit(retryLimit)
        .lean(),
    ]);

    const ids = Array.from(
      new Set(
        [...scheduledRows, ...failedRows]
          .map((x) => String(x?._id || "").trim())
          .filter(Boolean),
      ),
    ).slice(0, retryLimit);

    if (ids.length) {
      await CodAttempt.updateMany(
        { _id: { $in: ids } },
        {
          $set: {
            status: "scheduled",
            scheduledAt: now,
            lastError: null,
            lastErrorAt: null,
            lastErrorMeta: null,
          },
        },
      );

      for (const attemptId of ids) {
        await agenda
          .schedule(now, "attempt_cod_confirmation", { attemptId })
          .catch(() => {});
      }
    }

    void logAudit({
      shop,
      actor: "merchant",
      action: "byon_retry_now",
      meta: {
        resumedAt: now.toISOString(),
        attemptsQueued: ids.length,
      },
    });

    const sender = await getSenderResponse(shop, {
      refreshTemplates: true,
      forceTemplateRefresh: true,
    });
    return res.json({
      ok: true,
      sender,
      retryNow: {
        resumedAt: now,
        attemptsQueued: ids.length,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

router.get("/diagnostics", async (req, res) => {
  const shop = String(req.query.shop || "").trim();
  if (!shop) return res.status(400).json({ error: "Missing shop" });
  const record = await Shop.findOne({ shop }).lean();
  const diagnostics = record?.diagnostics || {};
  const billing = await getBillingStatus(shop).catch(() => null);

  const hasOfflineToken = !!record?.accessToken;
  const tokenType = record?.accessTokenType || null;
  const scopes = String(record?.scopes || "").trim() || null;

  const waEnv = {
    configured:
      !!process.env.WA_PHONE_NUMBER_ID && !!process.env.WA_ACCESS_TOKEN,
    hasPhoneNumberId: !!process.env.WA_PHONE_NUMBER_ID,
    hasAccessToken: !!process.env.WA_ACCESS_TOKEN,
    signatureVerificationEnabled:
      !!process.env.WA_SECRET || !!process.env.WA_APP_SECRET,
    allowUnsignedWebhook:
      String(process.env.ALLOW_UNSIGNED_WA_WEBHOOK || "").toLowerCase() ===
        "true" ||
      String(process.env.NODE_ENV || "").toLowerCase() !== "production",
  };

  // Never expose raw backend/Shopify error strings to merchant UI.
  return res.json({
    ok: true,
    diagnostics: {
      hasOfflineToken,
      tokenType,
      scopes,
      billingActive: !!billing?.active,
      billingStatus: billing?.status || null,
      planKey: billing?.planKey || null,

      orderAccessBlocked: !!diagnostics.orderAccessBlocked,
      orderAccessBlockedAt: diagnostics.orderAccessBlockedAt || null,
      orderAccessErrorAt: diagnostics.orderAccessErrorAt || null,

      shopifyAccessOk:
        typeof diagnostics.shopifyAccessOk === "boolean"
          ? diagnostics.shopifyAccessOk
          : null,
      shopifyAccessCheckedAt: diagnostics.shopifyAccessCheckedAt || null,
      shopifyAccessErrorAt: diagnostics.shopifyAccessErrorAt || null,

      whatsapp: waEnv,
    },
  });
});

router.post("/diagnostics/run", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const record = await Shop.findOne({ shop }).lean();
    if (!record) {
      return res.status(404).json({ error: "Shop not installed" });
    }

    const now = new Date();
    let ok = false;
    let errMsg = null;
    try {
      const admin = await getAdminClient(shop, {
        accessToken: record.accessToken || "",
        record,
      });
      await admin.query({
        data: `#graphql
          query {
            shop { name }
          }
        `,
      });
      ok = true;
    } catch (e) {
      ok = false;
      errMsg = String(e?.message || e || "").slice(0, 500);
    }

    await Shop.updateOne(
      { shop },
      {
        $set: {
          "diagnostics.shopifyAccessOk": ok,
          "diagnostics.shopifyAccessCheckedAt": now,
          "diagnostics.shopifyAccessErrorAt": ok ? null : now,
          "diagnostics.shopifyAccessError": ok ? null : errMsg,
        },
      },
    );

    void logAudit({
      shop,
      actor: "merchant",
      action: "diagnostics_run",
      meta: { shopifyAccessOk: ok },
    });

    return res.json({ ok: true, shopifyAccessOk: ok });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

router.get("/audit", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const limitRaw = Number(req.query.limit ?? 200);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(500, Math.max(1, Math.floor(limitRaw)))
      : 200;

    const items = await AuditLog.find({ shop })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

router.post("/settings", async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).json({ error: "Missing shop" });

  const body = req.body || {};
  const before = await Shop.findOne({ shop }).lean();
  const billingPlanKey = String(
    before?.billing?.planKey || PLAN_KEYS.ORDERX_FREE_5,
  ).trim();
  const billingSenderMode = String(
    getPlan(billingPlanKey)?.senderMode || SENDER_MODES.ORDERX_NUMBER,
  ).trim();
  const marketingFlowsAllowed = billingSenderMode === SENDER_MODES.OWN_NUMBER;

  const confirmationDelayMin = Number(body.confirmationDelayMin ?? 60);
  if (
    !Number.isFinite(confirmationDelayMin) ||
    confirmationDelayMin < 0 ||
    confirmationDelayMin > 1440
  ) {
    return res.status(400).json({ error: "Invalid confirmationDelayMin" });
  }
  const rawOrderPollingScope = String(
    body.orderPollingScope ??
      before?.settings?.orderPollingScope ??
      "all_orders",
  )
    .trim()
    .toLowerCase();
  const orderPollingScope =
    rawOrderPollingScope === "cod_only" ? "cod_only" : "all_orders";
  const rawOrderUpdatesScope = String(
    body.orderUpdatesScope ??
      before?.settings?.orderUpdatesScope ??
      "all_orders",
  )
    .trim()
    .toLowerCase();
  const orderUpdatesScope =
    rawOrderUpdatesScope === "confirmed_only" ? "confirmed_only" : "all_orders";

  const workStartHour = Number(body.workStartHour ?? 9);
  const workEndHour = Number(body.workEndHour ?? 21);
  if (
    !Number.isFinite(workStartHour) ||
    !Number.isFinite(workEndHour) ||
    workStartHour < 0 ||
    workStartHour > 23 ||
    workEndHour < 0 ||
    workEndHour > 23
  ) {
    return res.status(400).json({ error: "Invalid working hours" });
  }
  if (workStartHour >= workEndHour) {
    return res
      .status(400)
      .json({ error: "Invalid working hours (start must be < end)" });
  }

  const enableWhatsApp = body.enableWhatsApp !== false;
  const autoTagOrders = body.autoTagOrders !== false;

  const supportWhatsAppNumber = normalizeSupportWhatsAppNumber(
    body.supportWhatsAppNumber,
  );
  const confirmReplyText = String(
    body.confirmReplyText ?? before?.settings?.confirmReplyText ?? "",
  )
    .trim()
    .slice(0, 2000);
  const cancelReplyText = String(
    body.cancelReplyText ?? before?.settings?.cancelReplyText ?? "",
  )
    .trim()
    .slice(0, 2000);
  if (enableWhatsApp && !supportWhatsAppNumber) {
    return res.status(400).json({
      error: "supportWhatsAppNumber is required (E.164, e.g. +15551234567)",
    });
  }
  if (supportWhatsAppNumber && !isValidE164(supportWhatsAppNumber)) {
    return res.status(400).json({
      error: "Invalid supportWhatsAppNumber (must be E.164, e.g. +15551234567)",
    });
  }

  const skipOrderTags = toStringArray(body.skipOrderTags);
  const includeCountries = toCountryCodes(body.includeCountries);
  const excludeCountries = toCountryCodes(body.excludeCountries);

  const maxAttemptAgeHours = Number(body.maxAttemptAgeHours ?? 72);
  if (
    !Number.isFinite(maxAttemptAgeHours) ||
    maxAttemptAgeHours < 1 ||
    maxAttemptAgeHours > 24 * 30
  ) {
    return res.status(400).json({ error: "Invalid maxAttemptAgeHours" });
  }
  const byonMaxInitiatedConversations24h = Number(
    body.byonMaxInitiatedConversations24h ?? 250,
  );
  if (
    !Number.isFinite(byonMaxInitiatedConversations24h) ||
    byonMaxInitiatedConversations24h < 1 ||
    byonMaxInitiatedConversations24h > 100000
  ) {
    return res
      .status(400)
      .json({ error: "Invalid byonMaxInitiatedConversations24h" });
  }

  let automationFlows = [];
  if (body.automationFlows) {
    try {
      const parsed =
        typeof body.automationFlows === "string"
          ? JSON.parse(body.automationFlows)
          : body.automationFlows;
      automationFlows = ensureAutomationFlowConfigs(parsed);
    } catch {
      return res.status(400).json({ error: "Invalid automationFlows payload" });
    }
  }

  if (!automationFlows.length) {
    automationFlows = ensureAutomationFlowConfigs(
      before?.settings?.automationFlows,
    );
  }

  const nextOrderConfirmationEnabled =
    body.orderConfirmationEnabled != null
      ? body.orderConfirmationEnabled !== false &&
        body.orderConfirmationEnabled !== "false"
      : (before?.settings?.enableWhatsApp ?? body.enableWhatsApp !== false);
  const nextOrderChangeRequestEnabled =
    body.orderChangeRequestEnabled != null
      ? body.orderChangeRequestEnabled !== false &&
        body.orderChangeRequestEnabled !== "false"
      : (automationFlows.find(
          (flow) => flow.flowKey === FLOW_KEYS.ORDER_CHANGE_REQUEST,
        )?.enabled ?? true);
  const nextDispatchedEnabled =
    body.orderUpdatesDispatched != null
      ? body.orderUpdatesDispatched !== false &&
        body.orderUpdatesDispatched !== "false"
      : (automationFlows.find(
          (flow) => flow.flowKey === FLOW_KEYS.ORDER_DISPATCHED,
        )?.enabled ??
        before?.settings?.orderUpdatesDispatched ??
        true);
  const nextTrackingEnabled =
    body.orderUpdatesTrackingUpdated != null
      ? body.orderUpdatesTrackingUpdated !== false &&
        body.orderUpdatesTrackingUpdated !== "false"
      : (automationFlows.find(
          (flow) => flow.flowKey === FLOW_KEYS.TRACKING_UPDATED,
        )?.enabled ??
        before?.settings?.orderUpdatesTrackingUpdated ??
        true);
  const nextCancelledEnabled =
    body.orderUpdatesCancelled != null
      ? body.orderUpdatesCancelled !== false &&
        body.orderUpdatesCancelled !== "false"
      : (automationFlows.find(
          (flow) => flow.flowKey === FLOW_KEYS.ORDER_CANCELLED,
        )?.enabled ??
        before?.settings?.orderUpdatesCancelled ??
        true);
  const nextReviewEnabled = !marketingFlowsAllowed
    ? false
    : body.reviewRequestEnabled != null
      ? body.reviewRequestEnabled !== false &&
        body.reviewRequestEnabled !== "false"
      : (automationFlows.find(
          (flow) => flow.flowKey === FLOW_KEYS.REVIEW_REQUEST,
        )?.enabled ?? false);
  const nextAbandonedCartEnabled = !marketingFlowsAllowed
    ? false
    : body.abandonedCartEnabled != null
      ? body.abandonedCartEnabled !== false &&
        body.abandonedCartEnabled !== "false"
      : (automationFlows.find(
          (flow) => flow.flowKey === FLOW_KEYS.ABANDONED_CART,
        )?.enabled ?? false);
  const nextReviewRequestUrl =
    body.reviewRequestUrl != null
      ? String(body.reviewRequestUrl || "").trim()
      : String(before?.settings?.reviewRequestUrl || "").trim();
  const rawReviewLinkMode =
    body.reviewRequestLinkMode != null
      ? String(body.reviewRequestLinkMode || "")
          .trim()
          .toLowerCase()
      : String(before?.settings?.reviewRequestLinkMode || "store")
          .trim()
          .toLowerCase();
  const nextReviewRequestLinkMode =
    rawReviewLinkMode === "product" ? "product" : "store";
  const rawReviewDelayHours =
    body.reviewRequestDelayHours ?? before?.settings?.reviewRequestDelayHours;
  const parsedReviewDelayHours = Number(rawReviewDelayHours);
  const nextReviewRequestDelayHours = Math.max(
    0,
    Math.min(
      24 * 30,
      Number.isFinite(parsedReviewDelayHours) ? parsedReviewDelayHours : 96,
    ),
  );
  const nextAbandonedCartDelayMinutes = Math.max(
    15,
    Math.min(
      7 * 24 * 60,
      Number(
        body.abandonedCartDelayMinutes ??
          before?.settings?.abandonedCartDelayMinutes ??
          90,
      ) || 90,
    ),
  );

  automationFlows = automationFlows.map((flow) => {
    if (flow.flowKey === FLOW_KEYS.ORDER_CONFIRMATION) {
      return { ...flow, enabled: nextOrderConfirmationEnabled };
    }
    if (flow.flowKey === FLOW_KEYS.ORDER_CHANGE_REQUEST) {
      return { ...flow, enabled: nextOrderChangeRequestEnabled };
    }
    if (flow.flowKey === FLOW_KEYS.ORDER_DISPATCHED) {
      return { ...flow, enabled: nextDispatchedEnabled };
    }
    if (flow.flowKey === FLOW_KEYS.TRACKING_UPDATED) {
      return { ...flow, enabled: nextTrackingEnabled };
    }
    if (flow.flowKey === FLOW_KEYS.ORDER_CANCELLED) {
      return { ...flow, enabled: nextCancelledEnabled };
    }
    if (
      flow.flowKey === FLOW_KEYS.REVIEW_REQUEST &&
      body.reviewRequestEnabled != null
    ) {
      return {
        ...flow,
        enabled: nextReviewEnabled,
        config: {
          ...(flow?.config && typeof flow.config === "object"
            ? flow.config
            : {}),
          reviewUrl: nextReviewRequestUrl,
          delayHours: nextReviewRequestDelayHours,
          linkMode: nextReviewRequestLinkMode,
        },
      };
    }
    if (
      flow.flowKey === FLOW_KEYS.ABANDONED_CART &&
      body.abandonedCartEnabled != null
    ) {
      return {
        ...flow,
        enabled: nextAbandonedCartEnabled,
        config: {
          ...(flow?.config && typeof flow.config === "object"
            ? flow.config
            : {}),
          delayMinutes: nextAbandonedCartDelayMinutes,
        },
      };
    }
    if (flow.flowKey === FLOW_KEYS.REVIEW_REQUEST) {
      return {
        ...flow,
        enabled: marketingFlowsAllowed ? flow.enabled : false,
        config: {
          ...(flow?.config && typeof flow.config === "object"
            ? flow.config
            : {}),
          reviewUrl: nextReviewRequestUrl,
          delayHours: nextReviewRequestDelayHours,
          linkMode: nextReviewRequestLinkMode,
        },
      };
    }
    if (flow.flowKey === FLOW_KEYS.ABANDONED_CART) {
      return {
        ...flow,
        enabled: marketingFlowsAllowed ? flow.enabled : false,
        config: {
          ...(flow?.config && typeof flow.config === "object"
            ? flow.config
            : {}),
          delayMinutes: nextAbandonedCartDelayMinutes,
        },
      };
    }
    return flow;
  });

  const settings = {
    confirmationDelayMin,
    orderPollingScope,
    orderUpdatesScope,
    workStartHour,
    workEndHour,

    // WhatsApp-only
    enableWhatsApp,
    autoTagOrders,

    // Shown/sent to customers so they can contact the store for questions.
    supportWhatsAppNumber,
    confirmReplyText,
    cancelReplyText,

    // Rules (free features)
    skipOrderTags,
    includeCountries,
    excludeCountries,
    maxAttemptAgeHours,
    byonMaxInitiatedConversations24h: Math.floor(
      byonMaxInitiatedConversations24h,
    ),
    automationFlows,
    reviewRequestUrl: nextReviewRequestUrl,
    reviewRequestDelayHours: nextReviewRequestDelayHours,
    reviewRequestLinkMode: nextReviewRequestLinkMode,
    abandonedCartDelayMinutes: nextAbandonedCartDelayMinutes,

    autoCancelUnconfirmed: !!body.autoCancelUnconfirmed,
    applyRequestedChangesToOrder: !!body.applyRequestedChangesToOrder,
    enableOrderUpdates:
      !!body.enableOrderUpdates ||
      nextDispatchedEnabled ||
      nextTrackingEnabled ||
      nextCancelledEnabled ||
      nextReviewEnabled,
    orderUpdatesDispatched: nextDispatchedEnabled,
    orderUpdatesTrackingUpdated: nextTrackingEnabled,
    orderUpdatesCancelled: nextCancelledEnabled,
  };

  const record = await Shop.findOneAndUpdate(
    { shop },
    { $set: { settings } },
    { new: true, upsert: true },
  );

  try {
    const prev = before?.settings || {};
    const changedKeys = Object.keys(settings).filter((k) => {
      const a = prev?.[k];
      const b = settings?.[k];
      return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
    });
    void logAudit({
      shop,
      actor: "merchant",
      action: "settings_save",
      meta: {
        changedKeys,
        enableWhatsApp: settings.enableWhatsApp,
      },
    });
  } catch {
    // ignore
  }

  res.json(record.settings);
});

const ATTEMPT_DEFAULT_PAGE_SIZE = 25;
const ATTEMPT_MAX_PAGE_SIZE = 100;
const ATTEMPT_EXPORT_MAX_ROWS = 5000;
const ATTEMPT_SEARCH_FIELDS = {
  order: ["orderName", "orderGid"],
  customer: ["customerName"],
  phone: ["phoneE164"],
  status: ["status"],
  stage: ["stage"],
  template: ["waTemplateUsed"],
  change: ["changeState"],
  error: ["lastError"],
  store: ["storeName"],
  sender: ["senderMode", "senderPhoneNumberId"],
};
const ATTEMPT_GENERAL_SEARCH_FIELDS = [
  "orderName",
  "orderGid",
  "customerName",
  "phoneE164",
  "status",
  "stage",
  "changeState",
  "waTemplateUsed",
  "lastError",
  "storeName",
  "senderMode",
  "senderPhoneNumberId",
];

function parsePositiveInt(value, fallback, options = {}) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  const min = Number.isFinite(options.min) ? options.min : 1;
  const max = Number.isFinite(options.max)
    ? options.max
    : Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(parsed, min), max);
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenizeAttemptSearch(raw) {
  const input = String(raw || "").trim();
  if (!input) return [];
  return input.match(/"[^"]+"|[^\s]+/g) || [];
}

function buildAttemptSearchMatch(raw) {
  const tokens = tokenizeAttemptSearch(raw);
  if (!tokens.length) return null;

  const clauses = tokens
    .map((token) => token.replace(/^"|"$/g, "").trim())
    .filter(Boolean)
    .map((token) => {
      const separatorIndex = token.indexOf(":");
      if (separatorIndex > 0) {
        const prefix = token.slice(0, separatorIndex).trim().toLowerCase();
        const value = token.slice(separatorIndex + 1).trim();
        const fields = ATTEMPT_SEARCH_FIELDS[prefix];
        if (value && Array.isArray(fields) && fields.length) {
          const regex = new RegExp(escapeRegex(value), "i");
          return {
            $or: fields.map((field) => ({ [field]: regex })),
          };
        }
      }

      const regex = new RegExp(escapeRegex(token), "i");
      return {
        $or: ATTEMPT_GENERAL_SEARCH_FIELDS.map((field) => ({ [field]: regex })),
      };
    });

  return clauses.length ? { $and: clauses } : null;
}

function startOfUtcDay(referenceDate = new Date()) {
  const value = new Date(referenceDate);
  value.setUTCHours(0, 0, 0, 0);
  return value;
}

function addUtcDays(referenceDate, days) {
  const value = new Date(referenceDate);
  value.setUTCDate(value.getUTCDate() + days);
  return value;
}

function addUtcMonths(referenceDate, months) {
  const value = new Date(referenceDate);
  value.setUTCMonth(value.getUTCMonth() + months);
  return value;
}

function toValidDate(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function resolveAttemptRange(rangeKey, billing, referenceDate = new Date()) {
  const now = new Date(referenceDate);
  const todayStart = startOfUtcDay(now);
  const nextDay = addUtcDays(todayStart, 1);
  const normalized = String(rangeKey || "this_cycle")
    .trim()
    .toLowerCase();
  switch (normalized) {
    case "today":
      return {
        key: "today",
        label: "Today",
        startAt: todayStart,
        endAt: nextDay,
      };
    case "last_week":
      return {
        key: "last_week",
        label: "Last week",
        startAt: addUtcDays(now, -7),
        endAt: now,
      };
    case "last_30_days":
      return {
        key: "last_30_days",
        label: "Last 30 days",
        startAt: addUtcDays(now, -30),
        endAt: now,
      };
    case "last_6_months":
      return {
        key: "last_6_months",
        label: "Last 6 months",
        startAt: addUtcMonths(now, -6),
        endAt: now,
      };
    case "last_12_months":
      return {
        key: "last_12_months",
        label: "Last 12 months",
        startAt: addUtcMonths(now, -12),
        endAt: now,
      };
    case "this_cycle":
    default: {
      const cycleStartAt = toValidDate(billing?.currentPeriodStart);
      return {
        key: "this_cycle",
        label: "This cycle",
        startAt: cycleStartAt || addUtcDays(now, -30),
        endAt: now,
      };
    }
  }
}

router.get("/attempts", requireBilling, async (req, res) => {
  const shop = String(req.query.shop || "").trim();
  if (!shop) return res.status(400).json({ error: "Missing shop" });

  const billing = await getBillingStatus(shop);
  const range = resolveAttemptRange(req.query.range, billing, new Date());
  const q = String(req.query.q || "").trim();
  const exportRequested = String(req.query.export || "").trim() === "1";
  const pageSize = exportRequested
    ? ATTEMPT_EXPORT_MAX_ROWS
    : parsePositiveInt(req.query.pageSize, ATTEMPT_DEFAULT_PAGE_SIZE, {
        min: 10,
        max: ATTEMPT_MAX_PAGE_SIZE,
      });
  const page = exportRequested
    ? 1
    : parsePositiveInt(req.query.page, 1, { min: 1, max: 10000 });

  const match = {
    shop,
    createdAt: {
      ...(range.startAt ? { $gte: range.startAt } : {}),
      ...(range.endAt ? { $lt: range.endAt } : {}),
    },
  };
  const searchMatch = buildAttemptSearchMatch(q);
  if (searchMatch?.$and?.length) {
    match.$and = searchMatch.$and;
  }

  const total = await CodAttempt.countDocuments(match);
  const totalPages = exportRequested
    ? 1
    : Math.max(1, Math.ceil(total / pageSize));
  const safePage = exportRequested ? 1 : Math.min(page, totalPages);
  const skip = exportRequested ? 0 : (safePage - 1) * pageSize;

  const [attempts, statusRows] = await Promise.all([
    CodAttempt.find(match)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .lean(),
    CodAttempt.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const byStatus = Object.fromEntries(
    statusRows.map((row) => [String(row?._id || ""), Number(row?.count || 0)]),
  );
  const pending =
    Number(byStatus.pending || 0) +
    Number(byStatus.scheduled || 0) +
    Number(byStatus.wa_sent || 0);
  const storeCountryCode = String(billing?.storeCountryCode || "")
    .trim()
    .toUpperCase();
  const items = attempts.map((attempt) => {
    const recipientCountryCodeResolved = String(
      inferCountryCodeFromE164(attempt?.phoneE164) || "",
    )
      .trim()
      .toUpperCase();
    return {
      ...attempt,
      storeCountryCode: storeCountryCode || null,
      recipientCountryCodeResolved: recipientCountryCodeResolved || null,
      crossBorderRateApplied:
        !!storeCountryCode &&
        !!recipientCountryCodeResolved &&
        recipientCountryCodeResolved !== storeCountryCode,
    };
  });
  const crossBorder = items.filter(
    (attempt) => attempt.crossBorderRateApplied === true,
  ).length;

  res.json({
    items,
    pagination: {
      page: safePage,
      pageSize,
      total,
      totalPages,
      hasPrevious: safePage > 1,
      hasNext: safePage < totalPages,
      rowStart: total > 0 ? skip + 1 : 0,
      rowEnd: Math.min(total, skip + items.length),
    },
    filters: {
      range: range.key,
      rangeLabel: range.label,
      q,
      exportRequested,
      startAt: range.startAt,
      endAt: range.endAt,
    },
    summary: {
      total,
      confirmed: Number(byStatus.confirmed || 0),
      cancelled: Number(byStatus.cancelled || 0),
      pending,
      failed: Number(byStatus.failed || 0),
      expired: Number(byStatus.expired || 0),
      skipped: Number(byStatus.skipped || 0),
      crossBorder,
    },
  });
});

router.get("/shopify/orders", requireBilling, async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const shopRecord = await Shop.findOne({ shop }).lean();
    if (!shopRecord) {
      return res.status(404).json({ error: "Shop not installed" });
    }

    const first = Math.min(
      Math.max(Number.parseInt(String(req.query.first || "10"), 10) || 10, 1),
      50,
    );
    const after = String(req.query.after || "").trim() || null;
    const query = String(req.query.q || "").trim();

    const admin = await getAdminClient(shop, {
      accessToken: shopRecord.accessToken || "",
      record: shopRecord,
    });
    const result = await listShopifyOrders(admin, { first, after, query });

    return res.json({
      ok: true,
      orders: result.items,
      pageInfo: result.pageInfo,
      query: result.query,
    });
  } catch (e) {
    return res.status(500).json({
      error: e?.message || "Failed to load orders",
    });
  }
});

// Manual retry / schedule: posts a job that will run the WhatsApp flow again (with billing + quota gating).
router.post("/attempts/trigger", requireBilling, async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const attemptId = String(req.body?.attemptId || "").trim();
    const orderLookup = String(req.body?.orderLookup || "").trim();
    if (!attemptId && !orderLookup) {
      return res
        .status(400)
        .json({ error: "Missing attemptId or orderLookup" });
    }

    let attempt = null;
    if (attemptId) {
      attempt = await CodAttempt.findOne({ _id: attemptId, shop });
    } else {
      const normalizedLookup = orderLookup.replace(/^#/, "").trim();
      const byExactOrderName = new RegExp(
        `^#?${escapeRegex(normalizedLookup)}$`,
        "i",
      );
      const byRawLookup = new RegExp(escapeRegex(orderLookup), "i");
      const byOrderNumericId =
        normalizedLookup && /^\d+$/.test(normalizedLookup)
          ? new RegExp(`/Order/${escapeRegex(normalizedLookup)}$`, "i")
          : null;

      const findQuery = {
        shop,
        $or: [
          { orderName: byExactOrderName },
          { orderName: byRawLookup },
          { orderGid: byRawLookup },
        ],
      };
      if (byOrderNumericId) {
        findQuery.$or.push({ orderGid: byOrderNumericId });
      }

      attempt = await CodAttempt.findOne(findQuery).sort({ createdAt: -1 });
    }
    if (!attempt) return res.status(404).json({ error: "Attempt not found" });

    // Don't allow resending once a WhatsApp message was already sent (avoid duplicate messaging).
    if (attempt.status === "wa_sent") {
      return res.status(409).json({
        error: "WhatsApp already sent for this attempt",
      });
    }

    if (attempt.status === "pending") {
      return res.status(409).json({
        error: "Attempt is currently sending",
      });
    }

    if (["confirmed", "cancelled"].includes(attempt.status)) {
      return res.status(409).json({
        error: `Attempt is already ${attempt.status}`,
      });
    }
    const previousStatus = String(attempt.status || "").trim() || null;

    const whenRaw = req.body?.when ? String(req.body.when) : "";
    const when = whenRaw ? new Date(whenRaw) : new Date();
    if (whenRaw && !Number.isFinite(when.getTime())) {
      return res.status(400).json({ error: "Invalid when" });
    }

    attempt.status = "scheduled";
    attempt.scheduledAt = when;
    attempt.lastError = null;
    attempt.lastErrorAt = null;
    attempt.lastErrorMeta = null;
    attempt.retryCount = 0;
    attempt.manualRescheduledAt = new Date();
    attempt.expiredAt = null;
    attempt.expireSource = null;
    attempt.processedAt = null;
    attempt.confirmTokenHash = null;
    attempt.cancelTokenHash = null;
    attempt.tokenExpiresAt = null;
    attempt.tokenUsedAt = null;
    await attempt.save();

    await agenda.schedule(when, "attempt_cod_confirmation", {
      attemptId: attempt._id.toString(),
    });

    void logAudit({
      shop,
      actor: "merchant",
      action: "attempt_trigger",
      meta: {
        source: attemptId ? "attempt_id" : "order_lookup",
        attemptId: attempt._id.toString(),
        orderLookup: orderLookup || null,
        orderName: attempt.orderName || null,
        stage: attempt.stage || null,
        when: when.toISOString(),
        previousStatus,
      },
    });

    return res.json({ ok: true, attempt });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

router.post("/attempts/schedule-bulk", requireBilling, async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const rawOrderGids = [
      ...(Array.isArray(req.body?.orderGids)
        ? req.body.orderGids
        : req.body?.orderGids
          ? [req.body.orderGids]
          : []),
      ...(Array.isArray(req.body?.orderGid)
        ? req.body.orderGid
        : req.body?.orderGid
          ? [req.body.orderGid]
          : []),
    ];

    const orderGids = Array.from(
      new Set(
        rawOrderGids.map((value) => String(value || "").trim()).filter(Boolean),
      ),
    );

    if (!orderGids.length) {
      return res.status(400).json({ error: "Missing orderGids" });
    }
    if (orderGids.length > 50) {
      return res
        .status(400)
        .json({ error: "Select 50 or fewer orders at once" });
    }

    const whenRaw = req.body?.when ? String(req.body.when) : "";
    const when = whenRaw ? new Date(whenRaw) : new Date();
    if (whenRaw && !Number.isFinite(when.getTime())) {
      return res.status(400).json({ error: "Invalid when" });
    }

    const results = [];
    for (const orderGid of orderGids) {
      try {
        const scheduled = await scheduleAttemptFromShopifyOrder({
          shop,
          orderGid,
          when,
          requireCodEligible: false,
        });
        const attempt = scheduled?.attempt || null;
        results.push({
          ok: true,
          orderGid,
          attemptId: attempt?._id ? String(attempt._id) : null,
          orderName: attempt?.orderName || null,
          created: !!scheduled?.created,
          scheduledAt: attempt?.scheduledAt
            ? new Date(attempt.scheduledAt).toISOString()
            : null,
        });
      } catch (e) {
        results.push({
          ok: false,
          orderGid,
          error: e?.message || "Failed to schedule order",
        });
      }
    }

    const summary = {
      total: results.length,
      scheduled: results.filter((row) => row.ok).length,
      failed: results.filter((row) => !row.ok).length,
      created: results.filter((row) => row.ok && row.created).length,
      updated: results.filter((row) => row.ok && !row.created).length,
    };

    void logAudit({
      shop,
      actor: "merchant",
      action: "attempt_schedule_bulk",
      meta: {
        total: summary.total,
        scheduled: summary.scheduled,
        failed: summary.failed,
        when: when.toISOString(),
      },
    });

    return res.json({
      ok: summary.failed === 0,
      summary,
      results,
      when: when.toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

router.get("/messages", requireBilling, async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const scope = String(req.query.scope || "inbox")
      .trim()
      .toLowerCase();
    const q = String(req.query.q || "").trim();
    const thread = String(req.query.thread || req.query.threadKey || "").trim();
    const before = String(req.query.before || "").trim();
    const requestKey = String(req.query.requestKey || "").trim() || null;
    const page = parsePositiveInt(req.query.page, 1, { min: 1, max: 100000 });
    const pageSize = parsePositiveInt(req.query.pageSize, 20, {
      min: 5,
      max: 100,
    });
    const messagePageSize = parsePositiveInt(req.query.messagePageSize, 30, {
      min: 10,
      max: 200,
    });
    const forceBackfill =
      String(req.query.refresh || "").trim() === "1" ||
      String(req.query.force || "").trim() === "1";

    if (scope === "threads") {
      const threads = await listConversationThreads({
        shop,
        q,
        page,
        pageSize,
        selectedThreadKey: thread,
        forceBackfill,
      });
      return res.json({
        ok: true,
        scope,
        requestKey,
        q,
        thread: thread || threads.selectedThreadKey || null,
        ...threads,
      });
    }

    if (scope === "messages") {
      if (!thread) {
        return res.status(400).json({ error: "Missing thread" });
      }
      const messages = await listConversationMessages({
        shop,
        threadKey: thread,
        before,
        pageSize: messagePageSize,
      });
      return res.json({
        ok: true,
        scope,
        requestKey,
        q,
        thread,
        selectedThread: messages.thread || null,
        messages: messages.items,
        messagePagination: messages.pagination,
      });
    }

    const threads = await listConversationThreads({
      shop,
      q,
      page,
      pageSize,
      selectedThreadKey: thread,
      forceBackfill,
    });
    const selectedThreadKey = threads.selectedThreadKey || thread || null;
    const messages = selectedThreadKey
      ? await listConversationMessages({
          shop,
          threadKey: selectedThreadKey,
          pageSize: messagePageSize,
        })
      : {
          thread: null,
          items: [],
          pagination: {
            pageSize: messagePageSize,
            hasMoreBefore: false,
            beforeCursor: null,
            nextBefore: null,
            loadedCount: 0,
          },
        };

    return res.json({
      ok: true,
      scope: "inbox",
      requestKey,
      q,
      thread: selectedThreadKey,
      ...threads,
      selectedThread: messages.thread || threads.selectedThread || null,
      messages: messages.items,
      messagePagination: messages.pagination,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ error: error?.message || "Failed to load messages" });
  }
});

router.get("/metrics", requireBilling, async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).json({ error: "Missing shop" });
  const metrics = await Metric.find({ shop }).sort({ day: -1 }).limit(30);
  res.json(metrics);
});

export default router;
