import crypto from "node:crypto";
import fetch from "node-fetch";
import WaMessageLog from "../models/WaMessageLog.js";
import Shop from "../models/Shop.js";
import { SENDER_MODES } from "./plans.js";
import { getBillingStatus } from "./billing.js";
import { checkOutboundBillingAllowance } from "./usage.js";
import {
  recordOwnNumberOverageMessage,
  recordGrowthUsageMessage,
} from "./shopifyUsageBilling.js";
import {
  resolveByonTemplatePricing,
  resolveGrowthMessagePricing,
} from "./countryPricing.js";
import {
  isMetaAccessTokenExpired,
  maybeRefreshByonAccessToken,
} from "./metaByonAuth.js";
import {
  isPhoneMetadataCloudConnected,
  resolveOwnNumberRegistrationStatus,
} from "./ownNumberRegistration.js";
import { isRecipientNoWhatsappError } from "./noWhatsappTag.js";
import {
  ensureAutomationFlowConfigs,
  ensureManagedTemplateCatalog,
  isTemplateApproved,
  resolveAssignedTemplateForFlow,
  resolveTemplateVariableValues,
} from "./templateCatalog.js";
import { touchConversationThreadFromLog } from "./messageInbox.js";
import {
  fetchOrderForCodConfirmTemplate,
  getAdminClient,
} from "./shopifyAdmin.js";

/**
 * Meta WhatsApp Cloud API sender
 *
 * REQUIRED ENV:
 * WA_PHONE_NUMBER_ID=...
 * WA_ACCESS_TOKEN=...
 *
 * TEMPLATE ENV (defaults match your current template IDs):
 * WA_TEMPLATE_COD_CONFIRM=cod_confirm
 * WA_TEMPLATE_COD_CONFIRMED=cod_confirmed
 * WA_TEMPLATE_DELIVERY_FAILED_REDELIVER=delivery_failed_redeliver
 * WA_TEMPLATE_ORDER_CANCEL=order_cancel
 * WA_TEMPLATE_ORDER_DISPATCHED=cod_order_dispatched
 * WA_TEMPLATE_TRACKING_UPDATED=cod_tracking_updated
 * WA_TEMPLATE_ORDER_CANCELLED_UPDATE=cod_order_cancelled
 * WA_TEMPLATE_ORDER_UPDATE_GENERIC=cod_order_update_generic
 *
 * TEST TEMPLATE ENV:
 * WA_TEMPLATE_TEST_COD_CONFIRM_REQUEST=cod_confirm_request
 *
 * Language ENV (optional; defaults match your template language codes):
 * WA_TEMPLATE_LANG_COD_CONFIRM=en_US
 * WA_TEMPLATE_LANG_COD_CONFIRMED=en_US
 * WA_TEMPLATE_LANG_DELIVERY_FAILED_REDELIVER=en
 * WA_TEMPLATE_LANG_ORDER_CANCEL=en
 * WA_TEMPLATE_LANG_ORDER_DISPATCHED=en
 * WA_TEMPLATE_LANG_TRACKING_UPDATED=en
 * WA_TEMPLATE_LANG_ORDER_CANCELLED_UPDATE=en
 * WA_TEMPLATE_LANG_ORDER_UPDATE_GENERIC=en
 * WA_TEMPLATE_LANG_TEST_COD_CONFIRM_REQUEST=en
 *
 * Global fallback (rarely needed if per-template langs are set):
 * WA_TEMPLATE_LANG=en_US
 */

function must(name, val) {
  if (!val) throw new Error(`Missing env: ${name}`);
  return val;
}

function getByonPauseErrorThreshold() {
  const raw = Number(process.env.BYON_CONSECUTIVE_SEND_ERRORS_TO_PAUSE || 5);
  if (!Number.isFinite(raw)) return 5;
  return Math.min(10, Math.max(5, Math.floor(raw)));
}

const OWN_NUMBER_READY_INFERENCE_BLOCKED_STATUSES = new Set([
  "not_started",
  "collecting_details",
  "meta_connect_pending",
  "registration_pending",
  "reauth_required",
  "error",
]);
const OWN_NUMBER_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
const OWN_NUMBER_FAILURE_EVENT_LIMIT = 25;

function getConfig() {
  const phoneId = must("WA_PHONE_NUMBER_ID", process.env.WA_PHONE_NUMBER_ID);
  const token = must("WA_ACCESS_TOKEN", process.env.WA_ACCESS_TOKEN);

  // Some templates are created as "en", others as "en_US".
  // Keep per-template defaults aligned with the language codes in Meta.
  const langDefault = process.env.WA_TEMPLATE_LANG || "en_US";
  const langCodConfirm = process.env.WA_TEMPLATE_LANG_COD_CONFIRM || "en_US";
  const langCodConfirmed =
    process.env.WA_TEMPLATE_LANG_COD_CONFIRMED || "en_US";
  const langDeliveryFailedRedeliver =
    process.env.WA_TEMPLATE_LANG_DELIVERY_FAILED_REDELIVER || "en";
  const langOrderCancel = process.env.WA_TEMPLATE_LANG_ORDER_CANCEL || "en";
  const langOrderDispatched =
    process.env.WA_TEMPLATE_LANG_ORDER_DISPATCHED || "en";
  const langTrackingUpdated =
    process.env.WA_TEMPLATE_LANG_TRACKING_UPDATED || "en";
  const langOrderCancelledUpdate =
    process.env.WA_TEMPLATE_LANG_ORDER_CANCELLED_UPDATE || "en";
  const langOrderUpdateGeneric =
    process.env.WA_TEMPLATE_LANG_ORDER_UPDATE_GENERIC || "en";
  const langTestCodConfirmRequest =
    process.env.WA_TEMPLATE_LANG_TEST_COD_CONFIRM_REQUEST || "en";

  return {
    phoneId,
    token,
    langDefault,
    langCodConfirm,
    langCodConfirmed,
    langDeliveryFailedRedeliver,
    langOrderCancel,
    langOrderDispatched,
    langTrackingUpdated,
    langOrderCancelledUpdate,
    langOrderUpdateGeneric,
    langTestCodConfirmRequest,
    // Backward-compat: WA_TEMPLATE_CONFIRM_REPLY (older code) maps to the new confirm template.
    templateCodConfirm:
      process.env.WA_TEMPLATE_COD_CONFIRM ||
      process.env.WA_TEMPLATE_CONFIRM_REPLY ||
      "cod_confirm",
    templateCodConfirmed:
      process.env.WA_TEMPLATE_COD_CONFIRMED || "cod_confirmed",
    templateDeliveryFailedRedeliver:
      process.env.WA_TEMPLATE_DELIVERY_FAILED_REDELIVER ||
      "delivery_failed_redeliver",
    templateOrderCancel: process.env.WA_TEMPLATE_ORDER_CANCEL || "order_cancel",
    templateOrderDispatched:
      process.env.WA_TEMPLATE_ORDER_DISPATCHED || "cod_order_dispatched",
    templateTrackingUpdated:
      process.env.WA_TEMPLATE_TRACKING_UPDATED || "cod_tracking_updated",
    templateOrderCancelledUpdate:
      process.env.WA_TEMPLATE_ORDER_CANCELLED_UPDATE || "cod_order_cancelled",
    templateOrderUpdateGeneric:
      process.env.WA_TEMPLATE_ORDER_UPDATE_GENERIC ||
      "cod_order_update_generic",
    templateTestCodConfirmRequest:
      process.env.WA_TEMPLATE_TEST_COD_CONFIRM_REQUEST || "cod_confirm_request",
    enableButtonPayloadOverrides:
      process.env.WA_ENABLE_BUTTON_PAYLOAD_OVERRIDES === "true",
  };
}

function getGraphVersion() {
  return String(process.env.META_GRAPH_VERSION || "v25.0").trim() || "v25.0";
}

function normalizeSenderMode(mode, fallback = SENDER_MODES.ORDERX_NUMBER) {
  const raw = String(mode || "").trim();
  if (raw === SENDER_MODES.OWN_NUMBER) return SENDER_MODES.OWN_NUMBER;
  if (raw === SENDER_MODES.ORDERX_NUMBER) return SENDER_MODES.ORDERX_NUMBER;
  return fallback;
}

function normalizeTemplateEntries(templates) {
  const out = new Map();
  for (const t of Array.isArray(templates) ? templates : []) {
    const key = String(t?.key || "").trim();
    if (!key) continue;
    out.set(key, {
      templateName: String(t?.templateName || "").trim(),
      language: String(t?.language || "").trim(),
      status: String(t?.status || "")
        .trim()
        .toLowerCase(),
    });
  }
  return out;
}

export async function resolveRuntimeConfig(shopDomain) {
  const shared = getConfig();
  const shop = String(shopDomain || "").trim();
  if (!shop) {
    return {
      ...shared,
      senderMode: SENDER_MODES.ORDERX_NUMBER,
      templateOverrides: new Map(),
      managedTemplates: [],
      automationFlows: [],
    };
  }

  let record = null;
  try {
    record = await Shop.findOne({ shop }).lean();
  } catch {
    record = null;
  }

  const billing = await getBillingStatus(shop).catch(() => null);
  const billingSenderMode = normalizeSenderMode(
    billing?.plan?.senderMode,
    SENDER_MODES.ORDERX_NUMBER,
  );
  const preferenceMode = normalizeSenderMode(
    record?.whatsappSender?.preferenceMode,
    billingSenderMode,
  );
  // Enforce sender ownership strictly:
  // - Active billing/trial => billing plan mode is source of truth
  // - Billing inactive => merchant-selected preference drives onboarding/test
  const enforcedSenderMode = billing?.active
    ? billingSenderMode
    : preferenceMode;
  const ownRequired = enforcedSenderMode === SENDER_MODES.OWN_NUMBER;
  const own = record?.whatsappSender?.ownNumber || {};
  const ownStatus = String(own?.status || "").trim();
  const ownWabaId = String(own?.wabaId || "").trim();
  const ownPhoneId = String(own?.phoneNumberId || "").trim();
  let ownToken = String(own?.accessToken || "").trim();
  let ownTokenExpiresAt = own?.accessTokenExpiresAt || null;

  if (ownRequired && ownToken) {
    try {
      const refreshed = await maybeRefreshByonAccessToken({
        shop,
        ownNumber: own,
        force: false,
      });
      ownToken = String(refreshed?.token || ownToken).trim();
      ownTokenExpiresAt = refreshed?.expiresAt || ownTokenExpiresAt || null;
    } catch {
      // Keep using the stored token as fallback.
    }
  }

  const ownTokenExpired = isMetaAccessTokenExpired(ownTokenExpiresAt);
  const ownRegistrationStatus = resolveOwnNumberRegistrationStatus(own);
  const ownTemplatesApproved =
    Array.isArray(own?.templates) &&
    own.templates.length > 0 &&
    own.templates.every(
      (tpl) =>
        String(tpl?.status || "")
          .trim()
          .toLowerCase() === "approved",
    );
  const canInferOwnReady =
    !OWN_NUMBER_READY_INFERENCE_BLOCKED_STATUSES.has(ownStatus);
  const effectiveOwnStatus =
    ownStatus === "ready" ||
    (canInferOwnReady &&
      ownPhoneId &&
      ownToken &&
      !ownTokenExpired &&
      ownRegistrationStatus === "registered" &&
      ownTemplatesApproved)
      ? "ready"
      : ownStatus;
  const ownReady =
    ownRequired &&
    effectiveOwnStatus === "ready" &&
    ownPhoneId &&
    ownToken &&
    !ownTokenExpired &&
    ownRegistrationStatus === "registered";

  const activeMode = ownReady
    ? SENDER_MODES.OWN_NUMBER
    : ownRequired
      ? null
      : SENDER_MODES.ORDERX_NUMBER;
  const managedTemplates = ensureManagedTemplateCatalog(own?.managedTemplates);
  const automationFlows = ensureAutomationFlowConfigs(
    record?.settings?.automationFlows,
  );
  const storedActiveMode =
    String(record?.whatsappSender?.activeMode || "").trim() || null;
  if (record && storedActiveMode !== activeMode) {
    void Shop.updateOne(
      { shop },
      { $set: { "whatsappSender.activeMode": activeMode } },
    ).catch(() => {});
  }

  if (ownRequired && !ownReady) {
    return {
      ...shared,
      // Fail closed for BYON mode; never fall back to OrderX shared credentials.
      phoneId: "",
      token: "",
      senderMode: SENDER_MODES.OWN_NUMBER,
      senderUnavailableReason:
        effectiveOwnStatus !== "ready"
          ? "own_number_not_ready"
          : ownRegistrationStatus !== "registered"
            ? "own_number_registration_pending"
            : ownTokenExpired
              ? "own_number_auth_expired"
              : "own_number_auth_missing",
      templateOverrides: normalizeTemplateEntries(own?.templates),
      managedTemplates,
      automationFlows,
      templateLanguageDefault:
        String(own?.templateLanguage || "en").trim() || "en",
      wabaId: ownWabaId,
      registrationStatus: ownRegistrationStatus,
      registrationPin: String(own?.registrationPin || "").trim(),
    };
  }

  if (enforcedSenderMode === SENDER_MODES.ORDERX_NUMBER) {
    return {
      ...shared,
      senderMode: SENDER_MODES.ORDERX_NUMBER,
      templateOverrides: new Map(),
      managedTemplates,
      automationFlows,
    };
  }

  return {
    ...shared,
    phoneId: ownPhoneId,
    token: ownToken,
    senderMode: SENDER_MODES.OWN_NUMBER,
    wabaId: ownWabaId,
    templateOverrides: normalizeTemplateEntries(own?.templates),
    managedTemplates,
    automationFlows,
    templateLanguageDefault:
      String(own?.templateLanguage || "en").trim() || "en",
    registrationStatus: ownRegistrationStatus,
    registrationPin: String(own?.registrationPin || "").trim(),
  };
}

function resolveTemplateRuntime(runtime, key, fallbackName, fallbackLang) {
  const tpl = runtime?.templateOverrides?.get?.(String(key || "").trim());
  const overrideName = String(tpl?.templateName || "").trim();
  const overrideLang = String(tpl?.language || "").trim();
  const status = String(tpl?.status || "")
    .trim()
    .toLowerCase();

  return {
    templateName: overrideName || String(fallbackName || "").trim(),
    languageCode:
      overrideLang ||
      String(
        fallbackLang ||
          runtime?.templateLanguageDefault ||
          runtime?.langDefault ||
          "en",
      ).trim(),
    templateStatus: status || null,
  };
}

function resolveManagedFlowTemplateRuntime(
  runtime,
  flowKey,
  legacyTemplateKey,
  fallbackName,
  fallbackLang,
) {
  const managedTemplate = resolveAssignedTemplateForFlow({
    catalog: runtime?.managedTemplates,
    flows: runtime?.automationFlows,
    flowKey,
  });

  if (
    managedTemplate &&
    isTemplateApproved(managedTemplate) &&
    String(managedTemplate?.metaTemplateName || "").trim()
  ) {
    return {
      templateName: String(managedTemplate.metaTemplateName).trim(),
      languageCode:
        String(
          managedTemplate?.language ||
            runtime?.templateLanguageDefault ||
            fallbackLang ||
            runtime?.langDefault ||
            "en",
        ).trim() || "en",
      templateStatus: String(managedTemplate?.status || "approved")
        .trim()
        .toLowerCase(),
      managedTemplate,
      source: "managed",
    };
  }

  const legacy = resolveTemplateRuntime(
    runtime,
    legacyTemplateKey,
    fallbackName,
    fallbackLang,
  );
  return {
    ...legacy,
    managedTemplate: null,
    source: "legacy",
  };
}

const OWN_NUMBER_ONLY_TEMPLATE_FLOWS = new Set([
  "review_request",
  "abandoned_cart_recovery",
]);

export function buildManagedTemplatePayload({
  to,
  template,
  context = {},
  code,
  buttonPayloads = [],
  resolvedVariableValues = null,
  headerMediaId = "",
  skipVariableParameters = false,
}) {
  const variableValues =
    resolvedVariableValues || resolveTemplateVariableValues(template, context);
  const components = [];

  if (
    !skipVariableParameters &&
    Array.isArray(variableValues?.header) &&
    variableValues.header.length
  ) {
    components.push({
      type: "header",
      parameters: variableValues.header.map((text) => ({
        type: "text",
        text: clipText(text || "", 60),
      })),
    });
  } else if (
    String(template?.headerType || "")
      .trim()
      .toUpperCase() === "IMAGE" &&
    String(variableValues?.headerMediaUrl || "").trim()
  ) {
    components.push({
      type: "header",
      parameters: [
        {
          type: "image",
          image: headerMediaId
            ? { id: String(headerMediaId || "").trim() }
            : {
                link: String(variableValues.headerMediaUrl || "").trim(),
              },
        },
      ],
    });
  }

  if (
    !skipVariableParameters &&
    Array.isArray(variableValues?.body) &&
    variableValues.body.length
  ) {
    components.push({
      type: "body",
      parameters: variableValues.body.map((text) => ({
        type: "text",
        text: clipText(text || "", 1000),
      })),
    });
  }

  if (!skipVariableParameters) {
    const dynamicUrlButtons = Array.isArray(variableValues?.urlButtons)
      ? variableValues.urlButtons
      : [];
    for (const row of dynamicUrlButtons) {
      const index = Number(row?.index);
      const parameters = Array.isArray(row?.parameters)
        ? row.parameters
            .map((text) => clipText(text || "", 2000))
            .filter(Boolean)
        : [];
      if (!Number.isFinite(index) || index < 0 || !parameters.length) continue;
      components.push({
        type: "button",
        sub_type: "url",
        index: String(index),
        parameters: parameters.map((text) => ({ type: "text", text })),
      });
    }
  }

  const cleanButtonPayloads = Array.isArray(buttonPayloads)
    ? buttonPayloads
    : [];
  for (const row of cleanButtonPayloads) {
    const payload = String(row?.payload || "").trim();
    const index = Number(row?.index);
    if (!payload || !Number.isFinite(index) || index < 0) continue;
    components.push({
      type: "button",
      sub_type: "quick_reply",
      index: String(index),
      parameters: [{ type: "payload", payload }],
    });
  }

  return {
    messaging_product: "whatsapp",
    to: normalizeTo(to),
    type: "template",
    template: {
      name: String(template?.metaTemplateName || "").trim(),
      language: { code },
      ...(components.length ? { components } : {}),
    },
  };
}

function inferMediaFileNameFromUrl(url) {
  try {
    const parsed = new URL(String(url || "").trim());
    const base =
      parsed.pathname.split("/").filter(Boolean).pop() || "template-image.jpg";
    return base.includes(".") ? base : `${base}.jpg`;
  } catch {
    return "template-image.jpg";
  }
}

async function downloadMediaForUpload(mediaUrl) {
  let res;
  try {
    res = await fetch(String(mediaUrl || "").trim(), { method: "GET" });
  } catch (error) {
    error.safeToRetry = true;
    error.campaignStage = "media_download";
    throw error;
  }
  if (!res.ok) {
    const error = new Error(`Failed to download header image (${res.status})`);
    error.httpStatus = res.status;
    error.safeToRetry =
      res.status === 408 || res.status === 429 || res.status >= 500;
    error.campaignStage = "media_download";
    throw error;
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) {
    throw new Error("Header image download returned an empty file");
  }
  return {
    buffer,
    fileName: inferMediaFileNameFromUrl(mediaUrl),
    contentType:
      String(res.headers.get("content-type") || "")
        .split(";")[0]
        .trim() || "image/jpeg",
  };
}

async function uploadMediaBufferToMeta({
  runtime,
  buffer,
  fileName,
  contentType,
}) {
  const phoneId = String(runtime?.phoneId || "").trim();
  const token = String(runtime?.token || "").trim();
  if (!phoneId || !token) {
    throw new Error("WhatsApp runtime is missing Meta phone credentials");
  }

  const fileBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!fileBuffer.length) {
    throw new Error("Cannot upload an empty media file");
  }
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set(
    "file",
    new Blob([fileBuffer], { type: String(contentType || "application/octet-stream") }),
    String(fileName || "media.bin"),
  );

  let res;
  try {
    res = await fetch(
      `https://graph.facebook.com/${getGraphVersion()}/${phoneId}/media`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: form,
      },
    );
  } catch (error) {
    error.safeToRetry = true;
    error.campaignStage = "media_upload";
    throw error;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.id) {
    const err = new Error(
      data?.error?.message || "Failed to upload header image to Meta",
    );
    err.meta = data;
    err.httpStatus = res.status;
    err.safeToRetry =
      res.status === 408 || res.status === 429 || res.status >= 500;
    err.campaignStage = "media_upload";
    throw err;
  }
  return String(data.id || "").trim();
}

const HEADER_MEDIA_CACHE_TTL_MS = 10 * 60 * 1000;
const HEADER_MEDIA_CACHE_MAX = 500;
const headerMediaUploadCache = new Map();

function pruneHeaderMediaUploadCache(now = Date.now()) {
  for (const [key, entry] of headerMediaUploadCache) {
    if (Number(entry?.expiresAt || 0) <= now) {
      headerMediaUploadCache.delete(key);
    }
  }
  while (headerMediaUploadCache.size >= HEADER_MEDIA_CACHE_MAX) {
    const oldestKey = headerMediaUploadCache.keys().next().value;
    if (!oldestKey) break;
    headerMediaUploadCache.delete(oldestKey);
  }
}

async function uploadMediaToMetaForMessage({ runtime, mediaUrl }) {
  const phoneId = String(runtime?.phoneId || "").trim();
  const url = String(mediaUrl || "").trim();
  const cacheKey = phoneId && url ? `${phoneId}:${url}` : "";
  const now = Date.now();
  if (cacheKey) {
    const cached = headerMediaUploadCache.get(cacheKey);
    if (cached && Number(cached.expiresAt || 0) > now) {
      return cached.promise;
    }
    pruneHeaderMediaUploadCache(now);
  }

  const uploadPromise = (async () => {
    const media = await downloadMediaForUpload(url);
    return uploadMediaBufferToMeta({
      runtime,
      buffer: media.buffer,
      fileName: media.fileName,
      contentType: media.contentType,
    });
  })();
  if (cacheKey) {
    headerMediaUploadCache.set(cacheKey, {
      expiresAt: now + HEADER_MEDIA_CACHE_TTL_MS,
      promise: uploadPromise,
    });
  }
  try {
    return await uploadPromise;
  } catch (error) {
    if (cacheKey) headerMediaUploadCache.delete(cacheKey);
    throw error;
  }
}

function extractFirstOrderImageUrl(order) {
  const edges = Array.isArray(order?.lineItems?.edges)
    ? order.lineItems.edges
    : [];
  for (const edge of edges) {
    const li = edge?.node || {};
    const productImageEdge =
      li?.product?.images?.edges?.[0]?.node?.url ||
      li?.product?.images?.nodes?.[0]?.url ||
      "";
    const variantProductImageEdge =
      li?.variant?.product?.images?.edges?.[0]?.node?.url ||
      li?.variant?.product?.images?.nodes?.[0]?.url ||
      "";
    const candidates = [
      li?.image?.url,
      li?.variant?.image?.url,
      li?.variant?.product?.featuredImage?.url,
      li?.variant?.product?.featuredMedia?.preview?.image?.url,
      variantProductImageEdge,
      li?.product?.featuredImage?.url,
      li?.product?.featuredMedia?.preview?.image?.url,
      productImageEdge,
    ];
    const hit = candidates
      .map((value) => String(value || "").trim())
      .find((value) => /^https:\/\//i.test(value));
    if (hit) return hit;
  }
  return "";
}

async function resolveFallbackOrderProductImageUrl({ shop, orderGid }) {
  const shopName = String(shop || "").trim();
  const gid = String(orderGid || "").trim();
  if (!shopName || !gid) return "";

  const record = await Shop.findOne({ shop: shopName })
    .select({ accessToken: 1 })
    .lean()
    .catch(() => null);
  if (!record) return "";

  try {
    const admin = await getAdminClient(shopName, {
      accessToken: record.accessToken || "",
      record,
    });
    const fetched = await fetchOrderForCodConfirmTemplate(admin, gid);
    const order = fetched?.order || null;
    return extractFirstOrderImageUrl(order);
  } catch {
    return "";
  }
}

async function prepareManagedHeaderMedia({
  template,
  context = {},
  runtime,
  shop = "",
  orderGid = "",
  preferUploadForSampleFallback = false,
  suppressDebugLogging = false,
}) {
  const headerType = String(template?.headerType || "TEXT")
    .trim()
    .toUpperCase();
  const runtimeProductImageUrl = firstValidHttpsUrl([
    context?.product_image_url,
    context?.productImageUrl,
  ]);
  const sampleMediaUrl = String(template?.sampleMediaUrl || "").trim();
  let resolvedProductImageUrl = runtimeProductImageUrl;
  if (headerType === "IMAGE" && !resolvedProductImageUrl && shop && orderGid) {
    resolvedProductImageUrl = await resolveFallbackOrderProductImageUrl({
      shop,
      orderGid,
    });
  }

  const variableValues = resolveTemplateVariableValues(template, {
    ...context,
    product_image_url:
      resolvedProductImageUrl || context?.product_image_url || "",
    productImageUrl: resolvedProductImageUrl || context?.productImageUrl || "",
  });

  const headerMediaUrl = firstValidHttpsUrl([
    resolvedProductImageUrl,
    variableValues?.headerMediaUrl,
    sampleMediaUrl,
  ]);

  if (headerType !== "IMAGE" || !headerMediaUrl) {
    return {
      variableValues,
      headerMediaId: "",
      headerMediaMode: "none",
    };
  }

  const shouldUploadImage =
    !!resolvedProductImageUrl || preferUploadForSampleFallback;

  if (shouldUploadImage) {
    let mediaUrlUsed = headerMediaUrl;
    let usedSampleFallback = false;
    let headerMediaId;
    try {
      headerMediaId = await uploadMediaToMetaForMessage({
        runtime,
        mediaUrl: mediaUrlUsed,
      });
    } catch (error) {
      const fallbackSampleUrl = firstValidHttpsUrl([sampleMediaUrl]);
      if (
        !resolvedProductImageUrl ||
        !fallbackSampleUrl ||
        fallbackSampleUrl === mediaUrlUsed
      ) {
        throw error;
      }
      headerMediaId = await uploadMediaToMetaForMessage({
        runtime,
        mediaUrl: fallbackSampleUrl,
      });
      mediaUrlUsed = fallbackSampleUrl;
      usedSampleFallback = true;
    }
    const resolvedValues = {
      ...variableValues,
      headerMediaUrl: mediaUrlUsed,
    };
    if (!suppressDebugLogging) {
      console.log("[WA_TEMPLATE_HEADER_IMAGE]", {
        shop,
        orderGid,
        templateId: template?.id || null,
        metaTemplateName: template?.metaTemplateName || null,
        source: usedSampleFallback
          ? "sample_fallback"
          : resolvedProductImageUrl
            ? "product"
            : "sample",
        mode:
          resolvedProductImageUrl && !usedSampleFallback
            ? "uploaded_product_id"
            : "uploaded_sample_id",
        hasProductImage: !!resolvedProductImageUrl,
        imageUrl: mediaUrlUsed,
      });
    }
    return {
      variableValues: resolvedValues,
      headerMediaId,
      headerMediaMode: resolvedProductImageUrl && !usedSampleFallback
        ? "uploaded_product_id"
        : usedSampleFallback
          ? "uploaded_sample_fallback_id"
          : "uploaded_sample_id",
    };
  }

  if (!suppressDebugLogging) {
    console.log("[WA_TEMPLATE_HEADER_IMAGE]", {
      shop,
      orderGid,
      templateId: template?.id || null,
      metaTemplateName: template?.metaTemplateName || null,
      source: resolvedProductImageUrl
        ? "product"
        : headerMediaUrl === sampleMediaUrl
          ? "sample"
          : "context",
      mode: "link",
      hasProductImage: !!resolvedProductImageUrl,
      imageUrl: headerMediaUrl,
    });
  }

  return {
    variableValues,
    headerMediaId: "",
    headerMediaMode: "link",
  };
}

async function sendConfiguredFlowTemplate({
  flowKey,
  legacyTemplateKey = null,
  fallbackName,
  fallbackLang,
  to,
  context = {},
  buttonPayloads = [],
  shop,
  kind = "template_message",
  attemptId = null,
  orderGid = null,
  meta = null,
  skipBillingCheck = false,
}) {
  const runtime = await resolveRuntimeConfig(shop);
  const resolved = resolveManagedFlowTemplateRuntime(
    runtime,
    flowKey,
    legacyTemplateKey,
    fallbackName,
    fallbackLang,
  );

  if (
    !resolved.managedTemplate &&
    !String(resolved.templateName || "").trim()
  ) {
    throw new Error(
      `No approved WhatsApp template is assigned for the ${String(flowKey || "").replace(/_/g, " ")} flow`,
    );
  }

  const legacyResolved = resolveTemplateRuntime(
    runtime,
    legacyTemplateKey,
    fallbackName,
    fallbackLang,
  );

  let sent = null;
  let langUsed = null;
  let templateNameUsed = String(resolved.templateName || "").trim() || null;
  let templateSourceUsed =
    String(resolved.source || "legacy").trim() || "legacy";
  let managedTemplateUsed = resolved.managedTemplate || null;
  let managedVariableValues = null;
  let managedHeaderMediaMode = null;

  if (
    OWN_NUMBER_ONLY_TEMPLATE_FLOWS.has(String(flowKey || "").trim()) &&
    String(runtime?.senderMode || "").trim() !== SENDER_MODES.OWN_NUMBER
  ) {
    throw new Error(
      "This automation is available only on Your Own Number plans",
    );
  }

  if (resolved.managedTemplate) {
    try {
      const preparedMedia = await prepareManagedHeaderMedia({
        template: resolved.managedTemplate,
        context,
        runtime,
        shop,
        orderGid,
        preferUploadForSampleFallback: true,
      });
      managedVariableValues = preparedMedia.variableValues;
      managedHeaderMediaMode = preparedMedia.headerMediaMode || null;
      const response = await sendTemplateWithLangFallback(
        (code) =>
          buildManagedTemplatePayload({
            to,
            template: resolved.managedTemplate,
            context,
            code,
            buttonPayloads,
            resolvedVariableValues: preparedMedia.variableValues,
            headerMediaId: preparedMedia.headerMediaId,
          }),
        resolved.languageCode,
        {
          runtime,
          shop,
          skipBillingCheck,
          kind,
          attemptId,
          orderGid,
          suppressOwnNumberFailureHandling: !!String(
            legacyResolved.templateName || "",
          ).trim(),
        },
      );
      sent = response.data;
      langUsed = response.langUsed;
      templateNameUsed =
        String(resolved.managedTemplate?.metaTemplateName || "").trim() || null;
      templateSourceUsed = "managed";
      managedTemplateUsed = resolved.managedTemplate;
    } catch (managedErr) {
      console.warn("[wa_managed_template_fallback_legacy]", {
        shop,
        flowKey,
        templateId: resolved.managedTemplate?.id || null,
        metaTemplateName: resolved.managedTemplate?.metaTemplateName || null,
        error: managedErr?.message || managedErr,
      });

      if (!String(legacyResolved.templateName || "").trim()) {
        throw managedErr;
      }

      const bodyParams = Array.isArray(context?.bodyParams)
        ? context.bodyParams
        : [];
      const bodyParamsOwnNumber = Array.isArray(context?.bodyParamsOwnNumber)
        ? context.bodyParamsOwnNumber
        : null;
      const useOwnNumberParams =
        String(runtime?.senderMode || "").trim() === SENDER_MODES.OWN_NUMBER &&
        Array.isArray(bodyParamsOwnNumber) &&
        bodyParamsOwnNumber.length > 0;
      const paramsSource = useOwnNumberParams
        ? bodyParamsOwnNumber
        : bodyParams;
      const params = (Array.isArray(paramsSource) ? paramsSource : []).map(
        (value) => ({
          type: "text",
          text: clipText(value || "", 1000),
        }),
      );
      const buildLegacyPayload = (code) => ({
        messaging_product: "whatsapp",
        to: normalizeTo(to),
        type: "template",
        template: {
          name: legacyResolved.templateName,
          language: { code },
          ...(params.length
            ? { components: [{ type: "body", parameters: params }] }
            : {}),
        },
      });
      const fallbackResponse = await sendTemplateWithLangFallback(
        buildLegacyPayload,
        legacyResolved.languageCode,
        {
          runtime,
          shop,
          skipBillingCheck,
          kind,
          attemptId,
          orderGid,
          suppressOwnNumberFailureHandling: true,
        },
      );
      sent = fallbackResponse.data;
      langUsed = fallbackResponse.langUsed;
      templateNameUsed =
        String(legacyResolved.templateName || "").trim() || null;
      templateSourceUsed = "legacy";
      managedTemplateUsed = null;
      managedVariableValues = null;
      managedHeaderMediaMode = null;
    }
  } else {
    const bodyParams = Array.isArray(context?.bodyParams)
      ? context.bodyParams
      : [];
    const bodyParamsOwnNumber = Array.isArray(context?.bodyParamsOwnNumber)
      ? context.bodyParamsOwnNumber
      : null;
    const useOwnNumberParams =
      String(runtime?.senderMode || "").trim() === SENDER_MODES.OWN_NUMBER &&
      Array.isArray(bodyParamsOwnNumber) &&
      bodyParamsOwnNumber.length > 0;
    const paramsSource = useOwnNumberParams ? bodyParamsOwnNumber : bodyParams;
    const params = (Array.isArray(paramsSource) ? paramsSource : []).map(
      (value) => ({
        type: "text",
        text: clipText(value || "", 1000),
      }),
    );
    const buildLegacyPayload = (code) => ({
      messaging_product: "whatsapp",
      to: normalizeTo(to),
      type: "template",
      template: {
        name: resolved.templateName,
        language: { code },
        ...(params.length
          ? { components: [{ type: "body", parameters: params }] }
          : {}),
      },
    });
    const response = await sendTemplateWithLangFallback(
      buildLegacyPayload,
      resolved.languageCode,
      {
        runtime,
        shop,
        skipBillingCheck,
        kind,
        attemptId,
        orderGid,
      },
    );
    sent = response.data;
    langUsed = response.langUsed;
    templateNameUsed = String(resolved.templateName || "").trim() || null;
    templateSourceUsed = "legacy";
    managedTemplateUsed = null;
  }

  await safeLogOutbound({
    shop,
    toE164: to,
    kind,
    text: "",
    templateName: templateNameUsed,
    senderMode: runtime?.senderMode || "unknown",
    senderPhoneNumberId: runtime?.phoneId || null,
    waMessageId: sent?.messages?.[0]?.id || null,
    attemptId,
    orderGid,
    meta: {
      ...(meta && typeof meta === "object" ? meta : {}),
      type: "template",
      flowKey,
      langUsed: langUsed || null,
      initialMessageStatus:
        String(sent?.messages?.[0]?.message_status || "").trim() || null,
      templateSource: templateSourceUsed,
      managedTemplateId: managedTemplateUsed?.id || null,
      managedTemplateMetaName: managedTemplateUsed?.metaTemplateName || null,
      managedTemplateDisplayName: managedTemplateUsed?.displayName || null,
      managedTemplateLanguage: managedTemplateUsed?.language || null,
      managedTemplateHeaderType: managedTemplateUsed?.headerType || null,
      managedTemplateHeaderText: managedTemplateUsed?.headerText || null,
      managedTemplateBodyText: managedTemplateUsed?.bodyText || null,
      managedTemplateFooterText: managedTemplateUsed?.footerText || null,
      managedTemplateButtons: Array.isArray(managedTemplateUsed?.buttons)
        ? managedTemplateUsed.buttons.map((button) => ({
            text: String(button?.text || "").trim(),
            type: String(button?.type || "").trim() || null,
            action: String(button?.action || "").trim() || null,
            responseText: String(button?.responseText || "").trim() || null,
            tag: String(button?.tag || "").trim() || null,
          }))
        : [],
      headerMediaUrlUsed:
        String(managedVariableValues?.headerMediaUrl || "").trim() || null,
      headerMediaMode: managedTemplateUsed ? managedHeaderMediaMode : null,
    },
  });

  return { data: sent, templateUsed: templateNameUsed };
}

export async function sendManagedTemplateDirect({
  to,
  managedTemplate,
  context = {},
  shop,
  kind = "managed_template_test",
  attemptId = null,
  orderGid = null,
  meta = null,
  skipBillingCheck = false,
  skipVariableParameters = false,
  suppressDebugLogging = false,
}) {
  const template =
    managedTemplate && typeof managedTemplate === "object"
      ? managedTemplate
      : null;
  const templateName = String(template?.metaTemplateName || "").trim();
  if (!templateName) {
    throw new Error("Managed template is missing its Meta template name");
  }
  if (!isTemplateApproved(template)) {
    throw new Error("Only approved managed templates can be sent");
  }

  const runtime = await resolveRuntimeConfig(shop);
  if (String(runtime?.senderMode || "").trim() !== SENDER_MODES.OWN_NUMBER) {
    throw new Error("Managed template test send requires Your Own Number mode");
  }

  const preparedMedia = await prepareManagedHeaderMedia({
    template,
    context,
    runtime,
    shop,
    orderGid,
    preferUploadForSampleFallback: true,
    suppressDebugLogging,
  });
  const variableValues = preparedMedia.variableValues;
  if (!suppressDebugLogging) {
    console.log(
      "[MANAGED_TEMPLATE_TEST_SEND] resolved_values",
      JSON.stringify(
        {
          shop: String(shop || "").trim(),
          to: normalizeE164(to),
          templateId: template?.id || null,
          metaTemplateName: templateName,
          language:
            String(
              template?.language ||
                runtime?.templateLanguageDefault ||
                runtime?.langDefault ||
                "en",
            ).trim() || "en",
          headerType: String(template?.headerType || "")
            .trim()
            .toUpperCase(),
          headerVariableCount: Array.isArray(variableValues?.header)
            ? variableValues.header.length
            : 0,
          bodyVariableCount: Array.isArray(variableValues?.body)
            ? variableValues.body.length
            : 0,
          headerMediaUrlUsed:
            String(variableValues?.headerMediaUrl || "").trim() || null,
          headerMediaMode: preparedMedia.headerMediaMode,
          headerMediaId: preparedMedia.headerMediaId || null,
          skipVariableParameters: !!skipVariableParameters,
        },
        null,
        2,
      ),
    );
  }
  const response = await sendTemplateWithLangFallback(
    (code) => {
      const payload = buildManagedTemplatePayload({
        to,
        template,
        context,
        code,
        buttonPayloads: [],
        resolvedVariableValues: variableValues,
        headerMediaId: preparedMedia.headerMediaId,
        skipVariableParameters,
      });
      if (!suppressDebugLogging) {
        console.log(
          "[MANAGED_TEMPLATE_TEST_SEND] payload",
          JSON.stringify(
            {
              shop: String(shop || "").trim(),
              to: normalizeE164(to),
              templateId: template?.id || null,
              metaTemplateName: templateName,
              langCode: code,
              payload,
              headerMediaMode: preparedMedia.headerMediaMode,
              headerMediaId: preparedMedia.headerMediaId || null,
            },
            null,
            2,
          ),
        );
      }
      return payload;
    },
    String(
      template?.language ||
        runtime?.templateLanguageDefault ||
        runtime?.langDefault ||
        "en",
    ).trim() || "en",
    {
      runtime,
      shop,
      skipBillingCheck,
      kind,
      attemptId,
      orderGid,
    },
  );

  await safeLogOutbound({
    shop,
    toE164: to,
    kind,
    text: "",
    templateName,
    senderMode: runtime?.senderMode || "unknown",
    senderPhoneNumberId: runtime?.phoneId || null,
    waMessageId: response?.data?.messages?.[0]?.id || null,
    attemptId,
    orderGid,
    meta: {
      ...(meta && typeof meta === "object" ? meta : {}),
      type: "template",
      langUsed: response?.langUsed || null,
      initialMessageStatus:
        String(response?.data?.messages?.[0]?.message_status || "").trim() ||
        null,
      templateSource: "managed_direct",
      managedTemplateId: template?.id || null,
      managedTemplateMetaName: template?.metaTemplateName || null,
      managedTemplateDisplayName: template?.displayName || null,
      managedTemplateLanguage: template?.language || null,
      managedTemplateHeaderType: template?.headerType || null,
      managedTemplateHeaderText: template?.headerText || null,
      managedTemplateBodyText: template?.bodyText || null,
      managedTemplateFooterText: template?.footerText || null,
      managedTemplateButtons: Array.isArray(template?.buttons)
        ? template.buttons.map((button) => ({
            text: String(button?.text || "").trim(),
            type: String(button?.type || "").trim() || null,
            action: String(button?.action || "").trim() || null,
            responseText: String(button?.responseText || "").trim() || null,
            tag: String(button?.tag || "").trim() || null,
          }))
        : [],
      headerMediaUrlUsed:
        String(variableValues?.headerMediaUrl || "").trim() || null,
      headerMediaMode: preparedMedia.headerMediaMode,
      headerMediaId: preparedMedia.headerMediaId || null,
      skipVariableParameters: !!skipVariableParameters,
    },
  });

  return {
    data: response?.data || null,
    templateUsed: templateName,
    langUsed: response?.langUsed || null,
    headerMediaUrlUsed:
      String(variableValues?.headerMediaUrl || "").trim() || null,
    headerVariableCount: Array.isArray(variableValues?.header)
      ? variableValues.header.length
      : 0,
    bodyVariableCount: Array.isArray(variableValues?.body)
      ? variableValues.body.length
      : 0,
  };
}

function englishAltLang(code) {
  const c = String(code || "").trim();
  if (c === "en") return "en_US";
  if (c === "en_US") return "en";
  return "";
}

function isTemplateTranslationMissingError(error) {
  const message = String(error?.message || "").trim();
  const metaMessage = String(error?.meta?.error?.message || "").trim();
  const details = String(error?.meta?.error?.error_data?.details || "").trim();
  const code = Number(
    error?.meta?.error?.code || error?.code || error?.statusCode || 0,
  );
  return (
    code === 132001 ||
    /template name does not exist in the translation/i.test(message) ||
    /template name does not exist in the translation/i.test(metaMessage) ||
    /does not exist in [a-z_]+/i.test(details)
  );
}

function langList(primary) {
  const p = String(primary || "").trim() || "en_US";
  const alt = englishAltLang(p);
  return alt ? [p, alt] : [p];
}

async function sendTemplateWithLangFallback(
  buildPayload,
  primaryLang,
  options = {},
) {
  const codes = langList(primaryLang);
  let lastErr = null;
  let lastPayload = null;
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    try {
      const payload = buildPayload(code);
      lastPayload = payload;
      const data = await sendMessage(payload, {
        ...options,
        deferOwnNumberFailureHandling: true,
      });
      return { data, langUsed: code };
    } catch (e) {
      lastErr = e;
      const hasAltLanguage = index < codes.length - 1;
      if (!hasAltLanguage || !isTemplateTranslationMissingError(e)) {
        break;
      }
    }
  }
  if (lastErr && options?.suppressOwnNumberFailureHandling !== true) {
    const runtime =
      options?.runtime || (await resolveRuntimeConfig(options?.shop));
    await handleOwnNumberSendErrorState({
      err: lastErr,
      runtime,
      payload: lastPayload,
      options,
    });
  }
  throw lastErr;
}

function normalizeTo(to) {
  const t = String(to || "").trim();
  if (!t) return "";
  return t.startsWith("+") ? t.slice(1) : t;
}

function normalizeE164(to) {
  const t = String(to || "").trim();
  if (!t) return "";
  return t.startsWith("+") ? t : `+${t}`;
}

async function safeLogOutbound({
  shop,
  toE164,
  kind,
  text,
  templateName,
  senderMode = "unknown",
  senderPhoneNumberId = null,
  waMessageId,
  attemptId,
  orderGid,
  meta,
  skipUsageBilling = false,
}) {
  const shopDomain = String(shop || "").trim();
  const to = normalizeE164(toE164);
  if (!shopDomain || !to) return;
  const normalizedSenderMode = String(senderMode || "").trim() || "unknown";
  const sourceMeta =
    meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {};
  const initialMessageStatus = String(
    sourceMeta?.initialMessageStatus || "",
  )
    .trim()
    .toLowerCase();
  const acceptedAt = new Date();
  const normalizedMeta = {
    ...sourceMeta,
    ...(String(waMessageId || "").trim() && !sourceMeta?.deliveryStatus
      ? {
          deliveryStatus: initialMessageStatus || "accepted",
          deliveryStatusAt: acceptedAt,
        }
      : {}),
  };

  let growthPricing = null;
  let byonPricing = null;
  if (!skipUsageBilling) {
    try {
      if (normalizedSenderMode === SENDER_MODES.ORDERX_NUMBER) {
        growthPricing = await resolveGrowthMessagePricing({
          shop: shopDomain,
          toE164: to,
        });
      } else if (
        normalizedSenderMode === SENDER_MODES.OWN_NUMBER &&
        templateName &&
        String(kind || "").trim() !== "byon_live_test_template"
      ) {
        byonPricing = await resolveByonTemplatePricing({
          shop: shopDomain,
          toE164: to,
        });
      }
    } catch {
      growthPricing = null;
      byonPricing = null;
    }
  }

  const logPayload = {
    shop: shopDomain,
    toE164: to,
    direction: "outbound",
    kind: String(kind || "").trim(),
    text: String(text || ""),
    templateName: templateName ? String(templateName) : null,
    waMessageId: waMessageId ? String(waMessageId) : null,
    senderMode: normalizedSenderMode,
    senderPhoneNumberId: senderPhoneNumberId
      ? String(senderPhoneNumberId).trim()
      : null,
    recipientCountryCode:
      growthPricing?.recipientCountryCode ||
      byonPricing?.recipientCountryCode ||
      null,
    storeCountryCode:
      growthPricing?.storeCountryCode || byonPricing?.storeCountryCode || null,
    crossBorderRateApplied:
      growthPricing?.crossBorderRateApplied === true ||
      byonPricing?.crossBorderRateApplied === true,
    estimatedMetaCostUsd: byonPricing?.recipientRateUsd ?? null,
    usageChargeUsd: growthPricing?.recipientRateUsd ?? null,
    capUnitsConsumed: growthPricing?.capUnitsConsumed ?? null,
    attemptId: attemptId || null,
    orderGid: orderGid ? String(orderGid) : null,
    meta: Object.keys(normalizedMeta).length ? normalizedMeta : null,
  };

  try {
    if (logPayload.waMessageId) {
      await WaMessageLog.findOneAndUpdate(
        {
          shop: shopDomain,
          direction: "outbound",
          waMessageId: logPayload.waMessageId,
        },
        {
          $setOnInsert: logPayload,
        },
        { upsert: true, new: false },
      );
    } else {
      await WaMessageLog.create(logPayload);
    }
  } catch {
    // ignore
  }

  await touchConversationThreadFromLog(logPayload).catch(() => {});

  if (
    !skipUsageBilling &&
    shopDomain &&
    normalizedSenderMode === SENDER_MODES.ORDERX_NUMBER &&
    String(waMessageId || "").trim()
  ) {
    try {
      await recordGrowthUsageMessage({
        shop: shopDomain,
        waMessageId: String(waMessageId).trim(),
        attemptId: attemptId || null,
        orderGid: orderGid ? String(orderGid) : null,
        kind: String(kind || "").trim(),
        toE164: to,
        recipientCountryCode: growthPricing?.recipientCountryCode || "",
        senderMode: SENDER_MODES.ORDERX_NUMBER,
      });
    } catch {
      // ignore; send already succeeded and audit is recorded in billing helper
    }
  }

  if (
    !skipUsageBilling &&
    shopDomain &&
    normalizedSenderMode === SENDER_MODES.OWN_NUMBER &&
    String(waMessageId || "").trim()
  ) {
    try {
      await recordOwnNumberOverageMessage({
        shop: shopDomain,
        waMessageId: String(waMessageId).trim(),
        attemptId: attemptId || null,
        orderGid: orderGid ? String(orderGid) : null,
        kind: String(kind || "").trim(),
        senderMode: SENDER_MODES.OWN_NUMBER,
      });
    } catch {
      // ignore; send already succeeded and audit is recorded in billing helper
    }
  }
}

async function markOwnNumberReauthRequired({ shop, errorMessage, meta }) {
  const shopDomain = String(shop || "").trim();
  if (!shopDomain) return;

  const msg =
    String(errorMessage || "").trim() ||
    "Meta authorization failed. Reconnect your WhatsApp number in OrderX.";
  const now = new Date();

  try {
    await Shop.updateOne(
      { shop: shopDomain },
      {
        $set: {
          "whatsappSender.activeMode": null,
          "whatsappSender.ownNumber.status": "reauth_required",
          "whatsappSender.ownNumber.lastError": msg,
          "whatsappSender.ownNumber.lastErrorAt": now,
          "whatsappSender.ownNumber.lastErrorMeta": meta || null,
          "whatsappSender.ownNumber.lastSendError": msg,
          "whatsappSender.ownNumber.lastSendErrorAt": now,
          "whatsappSender.ownNumber.lastSendErrorMeta": meta || null,
          "whatsappSender.ownNumber.pauseSending": true,
          "whatsappSender.ownNumber.pauseReason": msg,
          "whatsappSender.ownNumber.pauseSetAt": now,
        },
      },
    );
  } catch {
    // ignore
  }
}

function normalizeOwnNumberFailureEvents(events = [], now = new Date()) {
  const cutoffMs = now.getTime() - OWN_NUMBER_FAILURE_WINDOW_MS;
  const seen = new Set();
  const out = [];

  for (const row of [...(Array.isArray(events) ? events : [])].reverse()) {
    const key = String(row?.key || "").trim();
    const at = new Date(row?.at || 0);
    if (!key || !Number.isFinite(at.getTime()) || at.getTime() < cutoffMs) {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      at,
      kind: String(row?.kind || "").trim() || null,
      reason:
        String(row?.reason || "")
          .trim()
          .slice(0, 200) || null,
      code: Number(row?.code || 0) || null,
    });
    if (out.length >= OWN_NUMBER_FAILURE_EVENT_LIMIT) break;
  }

  return out.sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
  );
}

function buildOwnNumberFailureKey({
  attemptId = null,
  orderGid = null,
  kind = "",
  to = "",
}) {
  const normalizedAttemptId = String(attemptId || "").trim();
  if (normalizedAttemptId) return `attempt:${normalizedAttemptId}`;

  const normalizedOrderGid = String(orderGid || "").trim();
  const normalizedKind = String(kind || "").trim() || "message";
  if (normalizedOrderGid) {
    return `order:${normalizedOrderGid}:${normalizedKind}`;
  }

  const normalizedTo = normalizeE164(to);
  if (normalizedTo) return `recipient:${normalizedTo}:${normalizedKind}`;

  return `kind:${normalizedKind}`;
}

function shouldCountTowardOwnNumberPause({
  error,
  httpStatus = 0,
  isRegistrationError = false,
  ownAccessLost = false,
}) {
  if (ownAccessLost || isRegistrationError) return false;
  if (isRecipientNoWhatsappError(error)) return false;
  if (httpStatus === 401 || httpStatus === 403) return false;
  if (httpStatus === 429 || httpStatus >= 500) return false;
  return true;
}

async function markOwnNumberSendSuccess(shop) {
  const shopDomain = String(shop || "").trim();
  if (!shopDomain) return;
  const now = new Date();
  const row = await Shop.findOne(
    { shop: shopDomain },
    {
      "whatsappSender.ownNumber.sendFailureEvents": 1,
    },
  )
    .lean()
    .catch(() => null);
  const nextFailureEvents = normalizeOwnNumberFailureEvents(
    row?.whatsappSender?.ownNumber?.sendFailureEvents,
    now,
  );
  await Shop.updateOne(
    { shop: shopDomain },
    {
      $set: {
        "whatsappSender.ownNumber.sendErrorStreak": nextFailureEvents.length,
        "whatsappSender.ownNumber.sendFailureEvents": nextFailureEvents,
        "whatsappSender.ownNumber.pauseSending": false,
        "whatsappSender.ownNumber.pauseReason": null,
        "whatsappSender.ownNumber.pauseSetAt": null,
        "whatsappSender.ownNumber.lastSendError": null,
        "whatsappSender.ownNumber.lastSendErrorMeta": null,
        "whatsappSender.ownNumber.lastSendErrorAt": null,
        "whatsappSender.ownNumber.registrationStatus": "registered",
        "whatsappSender.ownNumber.registrationError": null,
        "whatsappSender.ownNumber.registrationErrorAt": null,
        "whatsappSender.ownNumber.lastErrorMeta": null,
      },
    },
  ).catch(() => {});
}

async function markOwnNumberSendFailure({
  shop,
  errorMessage,
  meta = null,
  failureKey = "",
  failureKind = "message",
  countTowardPause = true,
}) {
  const shopDomain = String(shop || "").trim();
  if (!shopDomain) return;

  const now = new Date();
  const row = await Shop.findOne(
    { shop: shopDomain },
    {
      projection: {
        "whatsappSender.ownNumber.sendFailureEvents": 1,
        "whatsappSender.ownNumber.sendErrorStreak": 1,
        "whatsappSender.ownNumber.pauseSending": 1,
      },
    },
  )
    .lean()
    .catch(() => null);

  let nextFailureEvents = normalizeOwnNumberFailureEvents(
    row?.whatsappSender?.ownNumber?.sendFailureEvents,
    now,
  );
  if (countTowardPause) {
    const key = String(failureKey || "").trim();
    if (key) {
      nextFailureEvents = nextFailureEvents.filter(
        (event) => event.key !== key,
      );
      nextFailureEvents.push({
        key,
        at: now,
        kind: String(failureKind || "").trim() || "message",
        reason: String(errorMessage || "WhatsApp send failed").slice(0, 200),
        code: Number(meta?.code || 0) || null,
      });
      nextFailureEvents = normalizeOwnNumberFailureEvents(
        nextFailureEvents,
        now,
      );
    }
  }

  const streak = nextFailureEvents.length;
  const alreadyPaused = !!row?.whatsappSender?.ownNumber?.pauseSending;
  await Shop.updateOne(
    { shop: shopDomain },
    {
      $set: {
        "whatsappSender.ownNumber.sendErrorStreak": streak,
        "whatsappSender.ownNumber.sendFailureEvents": nextFailureEvents,
        "whatsappSender.ownNumber.lastSendError": String(
          errorMessage || "WhatsApp send failed",
        ).slice(0, 400),
        "whatsappSender.ownNumber.lastSendErrorMeta": meta || null,
        "whatsappSender.ownNumber.lastSendErrorAt": now,
      },
    },
  ).catch(() => {});

  const threshold = getByonPauseErrorThreshold();
  if (!countTowardPause || alreadyPaused || streak < threshold) return;

  await Shop.updateOne(
    { shop: shopDomain },
    {
      $set: {
        "whatsappSender.ownNumber.pauseSending": true,
        "whatsappSender.ownNumber.pauseReason": `Sending paused after ${streak} distinct failed WhatsApp attempts in the last 24 hours. Fix and press Retry now.`,
        "whatsappSender.ownNumber.pauseSetAt": now,
        ...(meta
          ? {
              "whatsappSender.ownNumber.lastError": String(
                errorMessage || "WhatsApp send failed",
              ),
            }
          : {}),
        ...(meta ? { "whatsappSender.ownNumber.lastErrorAt": now } : {}),
        ...(meta ? { "whatsappSender.ownNumber.lastErrorMeta": meta } : {}),
      },
    },
  ).catch(() => {});
}

async function handleOwnNumberSendErrorState({
  err,
  runtime,
  payload,
  options = {},
}) {
  const senderMode = String(runtime?.senderMode || "").trim();
  const isOwnSender = senderMode === SENDER_MODES.OWN_NUMBER;
  if (!isOwnSender || !options?.shop) return;

  const errorData = err?.meta || {};
  const httpStatus = Number(err?.httpStatus || 0);
  const isRegistrationError = isOwnNumberRegistrationNeededError(
    errorData,
    httpStatus,
  );
  const ownAccessLost = isOwnSender && isOwnNumberAccessLostGraphError(err);
  const graphSummary = graphErrorSummary(err, httpStatus);
  const errorMessage =
    errorData?.error?.message || err?.message || "WhatsApp send failed";

  console.error(
    "[WA_SEND_ERROR]",
    JSON.stringify({
      shop: options?.shop || null,
      senderMode: senderMode || null,
      phoneNumberId: String(runtime?.phoneId || "").trim() || null,
      wabaId: runtime?.wabaId || null,
      to: payload?.to || null,
      graphError: graphSummary,
      registrationError: isRegistrationError,
      ownAccessLost,
    }),
  );

  if (ownAccessLost) {
    await handleOwnNumberAccessLost({
      shop: options.shop,
      runtime,
      error: err,
    });
  } else if (!isRegistrationError) {
    await markOwnNumberSendFailure({
      shop: options.shop,
      errorMessage,
      meta: {
        httpStatus: httpStatus || null,
        code: errorData?.error?.code || null,
        type: errorData?.error?.type || null,
        error_subcode: errorData?.error?.error_subcode || null,
        fbtrace_id: errorData?.error?.fbtrace_id || null,
      },
      failureKey: buildOwnNumberFailureKey({
        attemptId: options?.attemptId,
        orderGid: options?.orderGid,
        kind: options?.kind,
        to: payload?.to || options?.toE164 || "",
      }),
      failureKind: String(options?.kind || "").trim() || "message",
      countTowardPause: shouldCountTowardOwnNumberPause({
        error: err,
        httpStatus,
        isRegistrationError,
        ownAccessLost,
      }),
    });
  } else {
    await Shop.updateOne(
      { shop: String(options.shop || "").trim() },
      {
        $set: {
          "whatsappSender.ownNumber.status": "registration_pending",
          "whatsappSender.ownNumber.sendErrorStreak": 0,
          "whatsappSender.ownNumber.sendFailureEvents": [],
          "whatsappSender.ownNumber.pauseSending": false,
          "whatsappSender.ownNumber.pauseReason": null,
          "whatsappSender.ownNumber.pauseSetAt": null,
          "whatsappSender.ownNumber.lastSendError": String(
            errorMessage || "Account not registered",
          ).slice(0, 400),
          "whatsappSender.ownNumber.lastSendErrorMeta": graphSummary,
          "whatsappSender.ownNumber.lastSendErrorAt": new Date(),
          "whatsappSender.ownNumber.lastError": String(
            errorMessage || "Account not registered",
          ).slice(0, 400),
          "whatsappSender.ownNumber.lastErrorMeta": graphSummary,
          "whatsappSender.ownNumber.lastErrorAt": new Date(),
        },
      },
    ).catch(() => {});
  }
  if (
    !ownAccessLost &&
    (httpStatus === 401 || httpStatus === 403) &&
    options?.shop
  ) {
    void markOwnNumberReauthRequired({
      shop: options.shop,
      errorMessage:
        errorData?.error?.message ||
        "Meta authorization failed while sending. Reconnect your number.",
      meta: {
        httpStatus: httpStatus || null,
        code: errorData?.error?.code || null,
        type: errorData?.error?.type || null,
      },
    });
  }
}

function createSendError(data, httpStatus, retryAfter = null) {
  const err = new Error(data?.error?.message || "WhatsApp send failed");
  err.meta = data;
  err.httpStatus = httpStatus;
  if (retryAfter) err.retryAfter = retryAfter;
  return err;
}

export function getWhatsAppMessageAcceptance(data = {}) {
  const message = Array.isArray(data?.messages) ? data.messages[0] || {} : {};
  return {
    waMessageId: String(message?.id || "").trim() || null,
    messageStatus:
      String(message?.message_status || "").trim().toLowerCase() ||
      "accepted",
  };
}

function createMissingAcceptanceError() {
  const error = new Error(
    "WhatsApp did not return a message ID, so OrderX cannot confirm that the message was accepted.",
  );
  error.code = "whatsapp_acceptance_missing";
  error.httpStatus = 502;
  error.meta = {
    error: {
      message: error.message,
      code: "whatsapp_acceptance_missing",
    },
  };
  return error;
}

function graphErrorObject(input) {
  if (!input) return null;
  if (input?.error && typeof input.error === "object") return input.error;
  if (input?.meta?.error && typeof input.meta.error === "object") {
    return input.meta.error;
  }
  if (input?.data?.error && typeof input.data.error === "object") {
    return input.data.error;
  }
  return null;
}

function graphErrorSummary(input, fallbackHttpStatus = null) {
  const err = graphErrorObject(input) || {};
  const httpStatus =
    Number(
      input?.httpStatus ||
        input?.status ||
        input?.statusCode ||
        fallbackHttpStatus ||
        0,
    ) || null;
  const errorData = err?.error_data || {};

  return {
    message: String(err?.message || input?.message || "").slice(0, 1000),
    type: err?.type ? String(err.type) : null,
    code: Number(err?.code || 0) || null,
    error_subcode: Number(err?.error_subcode || err?.subcode || 0) || null,
    error_data_details: errorData?.details
      ? String(errorData.details).slice(0, 1000)
      : null,
    fbtrace_id: err?.fbtrace_id ? String(err.fbtrace_id) : null,
    httpStatus,
  };
}

function graphObjectIdFromMessage(message) {
  const raw = String(message || "");
  const match = raw.match(/Object with ID ['"]?([0-9]{5,})['"]?/i);
  return match?.[1] || "";
}

export function isOwnNumberAccessLostGraphError(input) {
  const summary = graphErrorSummary(input);
  const status = Number(summary?.httpStatus || 0);
  const code = Number(summary?.code || 0);
  const msg = String(summary?.message || "").toLowerCase();

  if (status === 401 || status === 403) return true;
  if (code === 190) return true;
  if (code === 10 && msg.includes("permission")) return true;
  if (
    (code === 100 || msg.includes("unsupported post request")) &&
    msg.includes("object with id") &&
    (msg.includes("missing permissions") ||
      msg.includes("does not exist") ||
      msg.includes("does not support this operation"))
  ) {
    return true;
  }
  return (
    msg.includes("cannot be loaded due to missing permissions") &&
    msg.includes("does not support this operation")
  );
}

async function handleOwnNumberAccessLost({ shop, runtime, error }) {
  const shopDomain = String(shop || "").trim();
  if (!shopDomain) return;

  const phoneNumberId = String(runtime?.phoneId || "").trim();
  const wabaId = String(runtime?.wabaId || "").trim();
  const token = String(runtime?.token || "").trim();
  const graphError = graphErrorSummary(error);
  const objectIdFromError = graphObjectIdFromMessage(graphError.message);

  let diagnostics = null;
  let diagnosticsError = null;
  if (phoneNumberId && token) {
    try {
      const rawDiagnostics = await fetchOwnNumberPhoneDiagnostics({
        phoneId: phoneNumberId,
        token,
      });
      diagnostics = rawDiagnostics
        ? {
            id: rawDiagnostics.id || null,
            displayPhoneNumber: rawDiagnostics.displayPhoneNumber || null,
            verifiedName: rawDiagnostics.verifiedName || null,
            platformType: rawDiagnostics.platformType || null,
            status: rawDiagnostics.status || null,
            codeVerificationStatus:
              rawDiagnostics.codeVerificationStatus || null,
          }
        : null;
    } catch (diagErr) {
      diagnosticsError = graphErrorSummary(diagErr);
    }
  }

  const meta = {
    reason: "meta_phone_number_access_lost",
    phoneNumberId: phoneNumberId || null,
    wabaId: wabaId || null,
    objectIdFromError: objectIdFromError || null,
    graphError,
    diagnostics,
    diagnosticsError,
  };

  console.error(
    "[BYON_SEND_ACCESS_LOST]",
    JSON.stringify({
      shop: shopDomain,
      phoneNumberId: phoneNumberId || null,
      wabaId: wabaId || null,
      objectIdFromError: objectIdFromError || null,
      graphError,
      diagnostics,
      diagnosticsError,
    }),
  );

  const mismatch =
    objectIdFromError && phoneNumberId && objectIdFromError !== phoneNumberId;
  const msg = mismatch
    ? `Meta rejected sending because OrderX used phone_number_id ${phoneNumberId}, but Meta reported object ${objectIdFromError}. Reconnect the WhatsApp number and select the correct phone number.`
    : `Meta can no longer access the connected WhatsApp phone number${phoneNumberId ? ` (${phoneNumberId})` : ""}. Reconnect the number in OrderX so we receive a fresh token and phone_number_id.`;

  await markOwnNumberReauthRequired({
    shop: shopDomain,
    errorMessage: msg,
    meta,
  });
}

function isOwnNumberRegistrationNeededError(data, httpStatus) {
  if (Number(httpStatus || 0) !== 400) return false;
  const code = Number(data?.error?.code || 0);
  const msg = String(data?.error?.message || "")
    .trim()
    .toLowerCase();
  if (code === 133010) return true;
  return msg.includes("account not registered");
}

function isAlreadyRegisteredResponse(data) {
  const msg = String(data?.error?.message || "")
    .trim()
    .toLowerCase();
  const code = Number(data?.error?.code || 0);
  if (code === 133009) return true;
  return msg.includes("already registered");
}

function isPinRequiredRegistrationError(data) {
  const msg = String(data?.error?.message || "")
    .trim()
    .toLowerCase();
  if (!msg) return false;
  return msg.includes("pin") && msg.includes("required");
}

function isRegistrationRateLimited(data) {
  const code = Number(data?.error?.code || 0);
  const msg = String(data?.error?.message || "")
    .trim()
    .toLowerCase();
  const details = String(data?.error?.error_data?.details || "")
    .trim()
    .toLowerCase();
  return (
    code === 133016 ||
    msg.includes("too many attempts") ||
    details.includes("too many attempts")
  );
}

function buildRegistrationRateLimitError(baseErr) {
  const err = new Error(
    "WhatsApp number registration is rate-limited by Meta due to too many attempts. Wait 10 minutes, then retry once.",
  );
  err.httpStatus = 429;
  err.meta = baseErr?.meta || null;
  return err;
}

function buildRegistrationPinRequiredError(baseErr) {
  const err = new Error(
    "Meta requires the WhatsApp two-step verification PIN before OrderX can finish Cloud registration.",
  );
  err.httpStatus = 400;
  err.meta = baseErr?.meta || null;
  return err;
}

function isTransientRegistrationUnavailable(data, httpStatus) {
  const status = Number(httpStatus || 0);
  const code = Number(data?.error?.code || 0);
  const transient = data?.error?.is_transient === true;
  const details = String(data?.error?.error_data?.details || "")
    .trim()
    .toLowerCase();
  const msg = String(data?.error?.message || "")
    .trim()
    .toLowerCase();
  if (code === 2 && transient) return true;
  if (status >= 500 && transient) return true;
  return (
    msg.includes("temporarily unavailable") ||
    details.includes("temporarily unavailable")
  );
}

function buildTransientRegistrationError(baseErr) {
  const err = new Error(
    "Meta registration is temporarily unavailable. Please retry in about 1 minute.",
  );
  err.httpStatus = 503;
  err.meta = baseErr?.meta || null;
  return err;
}

function maskRegistrationPayload(payload = {}) {
  const masked = { ...payload };
  if (masked.pin) masked.pin = "******";
  return masked;
}

function summarizeGraphError(errorLike = {}) {
  const meta = errorLike?.meta?.error || errorLike?.error || {};
  return {
    message: String(meta?.message || errorLike?.message || "").trim() || null,
    type: String(meta?.type || "").trim() || null,
    code: Number(meta?.code || 0) || null,
    errorSubcode: Number(meta?.error_subcode || 0) || null,
    fbtraceId: String(meta?.fbtrace_id || "").trim() || null,
    details: String(meta?.error_data?.details || "").trim() || null,
    httpStatus: Number(errorLike?.httpStatus || 0) || null,
  };
}

function logOwnNumberRegistration(label, payload = {}) {
  try {
    console.log(
      `[BYON_REGISTRATION] ${label}`,
      JSON.stringify(payload, null, 2),
    );
  } catch {
    console.log(`[BYON_REGISTRATION] ${label}`, payload);
  }
}

function normalizeMetaFieldValue(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function firstValidHttpsUrl(values = []) {
  for (const value of Array.isArray(values) ? values : []) {
    const url = String(value || "").trim();
    if (/^https:\/\/\S+/i.test(url)) return url;
  }
  return "";
}

function deriveOwnNumberFlowType(flowValue = "") {
  const normalized = String(flowValue || "")
    .trim()
    .toLowerCase();
  if (normalized === "whatsapp_business_app_onboarding") {
    return "business_app_coexistence";
  }
  if (normalized.includes("migration")) {
    return "migration_related";
  }
  if (normalized) {
    return normalized;
  }
  return "cloud_only";
}

function isPhoneMetadataCloudReady(meta = {}) {
  return isPhoneMetadataCloudConnected(meta);
}

function extractPhoneMetadataPatch(meta = {}, now = new Date()) {
  return {
    "whatsappSender.ownNumber.registrationDisplayPhoneNumber":
      normalizeMetaFieldValue(meta?.displayPhoneNumber),
    "whatsappSender.ownNumber.registrationVerifiedName":
      normalizeMetaFieldValue(meta?.verifiedName),
    "whatsappSender.ownNumber.registrationCodeVerificationStatus":
      normalizeMetaFieldValue(meta?.codeVerificationStatus),
    "whatsappSender.ownNumber.registrationPlatformType":
      normalizeMetaFieldValue(meta?.platformType),
    "whatsappSender.ownNumber.registrationPhoneStatus": normalizeMetaFieldValue(
      meta?.status,
    ),
    "whatsappSender.ownNumber.registrationAccountMode": normalizeMetaFieldValue(
      meta?.accountMode,
    ),
    "whatsappSender.ownNumber.registrationLastMetadataAt": now,
  };
}

function buildRegistrationOutcome({
  diagnostics = null,
  error = null,
  flowType = "",
} = {}) {
  const derivedFlowType = deriveOwnNumberFlowType(flowType);
  const isPinEnabled = diagnostics?.isPinEnabled === true;
  const platformType = String(diagnostics?.platformType || "")
    .trim()
    .toUpperCase();
  const hasPhoneMetadata = !!normalizeMetaFieldValue(diagnostics?.id);

  if (diagnostics && isPhoneMetadataCloudReady(diagnostics)) {
    return {
      outcome: "READY",
      status: "registered",
      message: null,
    };
  }

  const summary = summarizeGraphError(error || {});
  const lowerMessage = String(summary?.message || "")
    .trim()
    .toLowerCase();
  const lowerDetails = String(summary?.details || "")
    .trim()
    .toLowerCase();
  const code = Number(summary?.code || 0);
  const hasGraphRegisterError = !!(
    summary?.message ||
    summary?.type ||
    summary?.code ||
    summary?.errorSubcode ||
    summary?.fbtraceId
  );
  const hasPinSignal =
    isPinEnabled ||
    lowerMessage.includes("pin") ||
    lowerDetails.includes("pin");

  if (
    hasGraphRegisterError &&
    (lowerMessage.includes("embedded signup") ||
      lowerDetails.includes("embedded signup") ||
      lowerMessage.includes("onboarding session") ||
      lowerDetails.includes("onboarding session") ||
      lowerMessage.includes("go through embedded signup again") ||
      lowerDetails.includes("go through embedded signup again") ||
      lowerMessage.includes("reconnect your number") ||
      lowerDetails.includes("reconnect your number"))
  ) {
    return {
      outcome: "NEED_RECONNECT",
      status: "failed",
      message:
        derivedFlowType === "business_app_coexistence"
          ? "This onboarding session expired. Please reconnect your number through Meta Embedded Signup."
          : "Meta requires this number to be reconnected through Embedded Signup before Cloud registration can continue.",
    };
  }

  if (hasPinSignal) {
    return {
      outcome: "NEED_PIN",
      status:
        hasGraphRegisterError &&
        (lowerMessage.includes("incorrect") ||
          lowerDetails.includes("incorrect") ||
          lowerMessage.includes("invalid") ||
          lowerDetails.includes("invalid"))
          ? "failed"
          : "unknown",
      message:
        lowerMessage.includes("incorrect") || lowerDetails.includes("incorrect")
          ? "Meta rejected the current two-step verification PIN. Enter the existing 6-digit PIN for this WhatsApp Business number."
          : "The current 6-digit two-step verification PIN is required for this WhatsApp Business number.",
    };
  }

  if (!hasPhoneMetadata || platformType !== "CLOUD_API") {
    return {
      outcome: "NEED_CORRECT_NUMBER",
      status: hasGraphRegisterError ? "failed" : "unknown",
      message:
        "OrderX could not confirm that this phone_number_id is Cloud API-ready. Reconnect and make sure the correct WhatsApp Business number is selected.",
    };
  }

  if (
    hasGraphRegisterError &&
    (code === 133016 ||
      code === 2 ||
      error?.httpStatus === 429 ||
      error?.httpStatus >= 500 ||
      lowerMessage.includes("temporarily unavailable") ||
      lowerDetails.includes("temporarily unavailable") ||
      lowerMessage.includes("too many attempts") ||
      lowerDetails.includes("too many attempts"))
  ) {
    return {
      outcome: "META_TEMP_ERROR",
      status: "unknown",
      message:
        code === 133016
          ? "Meta temporarily blocked Cloud registration due to too many attempts. Wait 10 minutes, then use OrderX's retry registration action once."
          : "Meta registration is temporarily unavailable. Retry later.",
    };
  }

  if (!hasGraphRegisterError) {
    return {
      outcome: "META_TEMP_ERROR",
      status: "unknown",
      message:
        platformType === "CLOUD_API"
          ? "Meta has not confirmed Cloud readiness for this number yet. Retry later if sending is still blocked."
          : "Meta has not confirmed Cloud readiness for this number yet.",
    };
  }

  return {
    outcome: "META_HARD_ERROR",
    status: "failed",
    message:
      summary?.message ||
      "Meta rejected Cloud registration for this business state. Do not blind retry.",
  };
}

async function fetchOwnNumberPhoneDiagnostics({ phoneId, token }) {
  const pid = String(phoneId || "").trim();
  const tk = String(token || "").trim();
  if (!pid || !tk) return null;

  const fieldSets = [
    [
      "id",
      "display_phone_number",
      "verified_name",
      "code_verification_status",
      "name_status",
      "quality_rating",
      "platform_type",
      "status",
      "account_mode",
      "throughput",
      "is_pin_enabled",
    ],
    [
      "id",
      "display_phone_number",
      "verified_name",
      "code_verification_status",
      "platform_type",
      "status",
      "is_pin_enabled",
    ],
    ["id", "display_phone_number", "verified_name"],
  ];

  let lastErr = null;
  for (const fields of fieldSets) {
    const url = new URL(
      `https://graph.facebook.com/${getGraphVersion()}/${pid}`,
    );
    url.searchParams.set("fields", fields.join(","));
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${tk}`,
        "Content-Type": "application/json",
      },
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      return {
        id: normalizeMetaFieldValue(data?.id),
        displayPhoneNumber: normalizeMetaFieldValue(data?.display_phone_number),
        verifiedName: normalizeMetaFieldValue(data?.verified_name),
        codeVerificationStatus: normalizeMetaFieldValue(
          data?.code_verification_status,
        ),
        nameStatus: normalizeMetaFieldValue(data?.name_status),
        qualityRating: normalizeMetaFieldValue(data?.quality_rating),
        platformType: normalizeMetaFieldValue(data?.platform_type),
        status: normalizeMetaFieldValue(data?.status),
        accountMode: normalizeMetaFieldValue(data?.account_mode),
        throughput: data?.throughput || null,
        isPinEnabled:
          typeof data?.is_pin_enabled === "boolean"
            ? data.is_pin_enabled
            : null,
        raw: data,
      };
    }
    lastErr = createSendError(
      data,
      res.status,
      res.headers?.get?.("retry-after"),
    );
    if (Number(data?.error?.code || 0) !== 100) {
      break;
    }
  }

  if (lastErr) throw lastErr;
  return null;
}

function dedupePins(candidates = []) {
  const out = [];
  const seen = new Set();
  for (const raw of candidates) {
    const pin = String(raw || "")
      .trim()
      .replace(/[^\d]/g, "");
    if (!/^\d{6}$/.test(pin)) continue;
    if (seen.has(pin)) continue;
    seen.add(pin);
    out.push(pin);
  }
  return out;
}

function generateRegistrationPin() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

async function persistOwnNumberRegistrationState(shop, patch = {}) {
  const shopDomain = String(shop || "").trim();
  if (!shopDomain) return;
  await Shop.updateOne(
    { shop: shopDomain },
    {
      $set: {
        ...patch,
      },
    },
  ).catch(() => {});
}

async function registerOwnNumberWithPin({ phoneId, token, pin = null }) {
  const url = `https://graph.facebook.com/${getGraphVersion()}/${phoneId}/register`;
  const payload = {
    messaging_product: "whatsapp",
    ...(pin ? { pin } : {}),
  };

  logOwnNumberRegistration("register_request", {
    phoneNumberId: String(phoneId || "").trim(),
    payload: maskRegistrationPayload(payload),
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));

  if (res.ok || isAlreadyRegisteredResponse(data)) {
    logOwnNumberRegistration("register_response", {
      phoneNumberId: String(phoneId || "").trim(),
      ok: true,
      alreadyRegistered: !res.ok,
      response: data,
    });
    return { ok: true, alreadyRegistered: !res.ok, data };
  }

  logOwnNumberRegistration("register_error", {
    phoneNumberId: String(phoneId || "").trim(),
    payload: maskRegistrationPayload(payload),
    response: data,
    error: summarizeGraphError({
      meta: data,
      httpStatus: res.status,
    }),
  });

  return {
    ok: false,
    data,
    error: createSendError(data, res.status, res.headers?.get?.("retry-after")),
  };
}

export async function ensureOwnNumberCloudRegistration({
  shop,
  phoneId,
  token,
  preferredPin = "",
  flowType = "",
} = {}) {
  const shopDomain = String(shop || "").trim();
  const pid = String(phoneId || "").trim();
  const tk = String(token || "").trim();
  if (!pid || !tk) {
    const err = new Error(
      "Cannot register own number without phone ID and access token",
    );
    err.httpStatus = 400;
    return { ok: false, error: err };
  }

  const now = new Date();
  const fromDb = shopDomain
    ? await Shop.findOne({ shop: shopDomain })
        .select({
          "whatsappSender.ownNumber.registrationStatus": 1,
          "whatsappSender.ownNumber.metaFeatureType": 1,
          "whatsappSender.ownNumber.registrationPin": 1,
          "whatsappSender.ownNumber.registrationLastAttemptAt": 1,
          "whatsappSender.ownNumber.registrationError": 1,
          "whatsappSender.ownNumber.wabaId": 1,
        })
        .lean()
        .catch(() => null)
    : null;
  const registrationStatus = resolveOwnNumberRegistrationStatus(
    fromDb?.whatsappSender?.ownNumber || {},
  );
  if (registrationStatus === "registered") {
    return { ok: true, alreadyRegistered: true, skipped: true };
  }
  const storedFlowType = String(
    fromDb?.whatsappSender?.ownNumber?.metaFeatureType || flowType || "",
  ).trim();
  const registrationLastAttemptAt =
    fromDb?.whatsappSender?.ownNumber?.registrationLastAttemptAt || null;
  const registrationError = String(
    fromDb?.whatsappSender?.ownNumber?.registrationError || "",
  )
    .trim()
    .toLowerCase();
  const registrationCooldownSec = Math.max(
    60,
    Number(process.env.BYON_REGISTRATION_RETRY_COOLDOWN_SEC || 600),
  );
  const withinCooldown =
    registrationLastAttemptAt &&
    Date.now() - new Date(registrationLastAttemptAt).getTime() <
      registrationCooldownSec * 1000;
  if (withinCooldown && registrationError.includes("too many attempts")) {
    return { ok: false, error: buildRegistrationRateLimitError(null) };
  }
  const storedPin = String(
    fromDb?.whatsappSender?.ownNumber?.registrationPin || "",
  ).trim();
  const envPin = String(process.env.BYON_REGISTRATION_PIN || "").trim();
  const trustedPins = dedupePins([preferredPin, storedPin, envPin]);
  const trustedPin = trustedPins[0] || "";
  let phoneDiagnostics = null;
  try {
    phoneDiagnostics = await fetchOwnNumberPhoneDiagnostics({
      phoneId: pid,
      token: tk,
    });
  } catch (error) {
    logOwnNumberRegistration("phone_metadata_error", {
      shop: shopDomain,
      phoneNumberId: pid,
      flowType: deriveOwnNumberFlowType(storedFlowType),
      error: summarizeGraphError(error),
      meta: error?.meta || null,
    });
  }

  logOwnNumberRegistration("phone_metadata", {
    shop: shopDomain,
    wabaId:
      String(fromDb?.whatsappSender?.ownNumber?.wabaId || "").trim() || null,
    phoneNumberId: pid,
    flowType: deriveOwnNumberFlowType(storedFlowType),
    displayPhoneNumber: phoneDiagnostics?.displayPhoneNumber || null,
    verifiedName: phoneDiagnostics?.verifiedName || null,
    codeVerificationStatus: phoneDiagnostics?.codeVerificationStatus || null,
    platformType: phoneDiagnostics?.platformType || null,
    status: phoneDiagnostics?.status || null,
    accountMode: phoneDiagnostics?.accountMode || null,
    isPinEnabled: phoneDiagnostics?.isPinEnabled,
    throughput: phoneDiagnostics?.throughput || null,
    raw: phoneDiagnostics?.raw || null,
  });

  const metadataPatch = extractPhoneMetadataPatch(phoneDiagnostics, now);

  if (isPhoneMetadataCloudReady(phoneDiagnostics)) {
    await persistOwnNumberRegistrationState(shopDomain, {
      ...metadataPatch,
      "whatsappSender.ownNumber.registrationStatus": "registered",
      "whatsappSender.ownNumber.registrationOutcome": "READY",
      "whatsappSender.ownNumber.registrationLastAttemptAt": now,
      "whatsappSender.ownNumber.registrationError": null,
      "whatsappSender.ownNumber.registrationErrorAt": null,
      "whatsappSender.ownNumber.registrationRegisteredAt":
        fromDb?.whatsappSender?.ownNumber?.registrationRegisteredAt || now,
    });
    return {
      ok: true,
      alreadyRegistered: true,
      skipped: true,
      diagnostics: phoneDiagnostics,
    };
  }

  const metadataPhoneId = normalizeMetaFieldValue(phoneDiagnostics?.id);
  if (!metadataPhoneId || metadataPhoneId !== pid) {
    const preflightOutcome = buildRegistrationOutcome({
      diagnostics: phoneDiagnostics,
      error: null,
      flowType: storedFlowType,
    });
    const verificationError = new Error(
      preflightOutcome.message ||
        "OrderX could not confirm this WhatsApp phone number. Please reconnect Meta Embedded Signup.",
    );
    verificationError.httpStatus = 409;
    await persistOwnNumberRegistrationState(shopDomain, {
      ...metadataPatch,
      "whatsappSender.ownNumber.registrationStatus":
        preflightOutcome.status || "unknown",
      "whatsappSender.ownNumber.registrationOutcome":
        preflightOutcome.outcome || "NEED_CORRECT_NUMBER",
      "whatsappSender.ownNumber.registrationLastAttemptAt": now,
      "whatsappSender.ownNumber.registrationError": String(
        verificationError.message,
      ).slice(0, 400),
      "whatsappSender.ownNumber.registrationErrorAt": now,
    });
    return {
      ok: false,
      error: verificationError,
      diagnostics: phoneDiagnostics,
    };
  }

  const requiresExistingPin = phoneDiagnostics?.isPinEnabled === true;
  if (requiresExistingPin && !trustedPin) {
    const pinRequiredOutcome = buildRegistrationOutcome({
      diagnostics: phoneDiagnostics,
      error: { message: "pin required" },
      flowType: storedFlowType,
    });
    const pinRequiredError = buildRegistrationPinRequiredError({
      message: pinRequiredOutcome.message,
    });
    await persistOwnNumberRegistrationState(shopDomain, {
      ...metadataPatch,
      "whatsappSender.ownNumber.registrationStatus": pinRequiredOutcome.status,
      "whatsappSender.ownNumber.registrationOutcome":
        pinRequiredOutcome.outcome,
      "whatsappSender.ownNumber.registrationLastAttemptAt": now,
      "whatsappSender.ownNumber.registrationError": String(
        pinRequiredError.message,
      ).slice(0, 400),
      "whatsappSender.ownNumber.registrationErrorAt": now,
    });
    return {
      ok: false,
      error: pinRequiredError,
      diagnostics: phoneDiagnostics,
    };
  }

  // Meta requires a six-digit two-step verification PIN on /register. Reuse
  // an existing trusted PIN when supplied; otherwise create one for a number
  // that does not already have two-step verification enabled.
  const registrationPin = trustedPin || generateRegistrationPin();
  const firstAttempt = await registerOwnNumberWithPin({
    phoneId: pid,
    token: tk,
    pin: registrationPin,
  });
  if (firstAttempt?.ok) {
    const confirmedDiagnostics = await fetchOwnNumberPhoneDiagnostics({
      phoneId: pid,
      token: tk,
    }).catch(() => phoneDiagnostics);
    // A successful /register response (including Meta's already-registered
    // response) is authoritative. Phone metadata can lag briefly afterward.
    await persistOwnNumberRegistrationState(shopDomain, {
      ...extractPhoneMetadataPatch(confirmedDiagnostics, now),
      "whatsappSender.ownNumber.registrationStatus": "registered",
      "whatsappSender.ownNumber.registrationOutcome": "READY",
      ...(!firstAttempt?.alreadyRegistered || trustedPin
        ? { "whatsappSender.ownNumber.registrationPin": registrationPin }
        : {}),
      "whatsappSender.ownNumber.registrationLastAttemptAt": now,
      "whatsappSender.ownNumber.registrationError": null,
      "whatsappSender.ownNumber.registrationErrorAt": null,
      "whatsappSender.ownNumber.registrationRegisteredAt": now,
    });
    return { ok: true, alreadyRegistered: !!firstAttempt?.alreadyRegistered };
  }

  if (isRegistrationRateLimited(firstAttempt?.data)) {
    await persistOwnNumberRegistrationState(shopDomain, {
      ...metadataPatch,
      "whatsappSender.ownNumber.registrationStatus": "unknown",
      "whatsappSender.ownNumber.registrationOutcome": "META_TEMP_ERROR",
      "whatsappSender.ownNumber.registrationLastAttemptAt": now,
      "whatsappSender.ownNumber.registrationError":
        "Meta temporarily blocked registration due to too many attempts. Retry after 10 minutes.",
      "whatsappSender.ownNumber.registrationErrorAt": now,
    });
    return {
      ok: false,
      error: buildRegistrationRateLimitError(firstAttempt.error),
    };
  }

  if (requiresExistingPin) {
    const pinRejectedOutcome = buildRegistrationOutcome({
      diagnostics: phoneDiagnostics,
      error: firstAttempt.error,
      flowType: storedFlowType,
    });
    await persistOwnNumberRegistrationState(shopDomain, {
      ...metadataPatch,
      "whatsappSender.ownNumber.registrationStatus": pinRejectedOutcome.status,
      "whatsappSender.ownNumber.registrationOutcome":
        pinRejectedOutcome.outcome,
      "whatsappSender.ownNumber.registrationLastAttemptAt": now,
      "whatsappSender.ownNumber.registrationError": String(
        pinRejectedOutcome.message ||
          firstAttempt?.error?.message ||
          "Cloud API registration failed",
      ).slice(0, 400),
      "whatsappSender.ownNumber.registrationErrorAt": now,
    });
    return {
      ok: false,
      error: firstAttempt.error,
      diagnostics: phoneDiagnostics,
    };
  }

  if (!isPinRequiredRegistrationError(firstAttempt?.data)) {
    if (
      isTransientRegistrationUnavailable(
        firstAttempt?.data,
        firstAttempt?.error?.httpStatus,
      )
    ) {
      await persistOwnNumberRegistrationState(shopDomain, {
        ...metadataPatch,
        "whatsappSender.ownNumber.registrationStatus": "unknown",
        "whatsappSender.ownNumber.registrationOutcome": "META_TEMP_ERROR",
        "whatsappSender.ownNumber.registrationLastAttemptAt": now,
        "whatsappSender.ownNumber.registrationError":
          "Meta registration service is temporarily unavailable. Retry after 1 minute.",
        "whatsappSender.ownNumber.registrationErrorAt": now,
      });
      return {
        ok: false,
        error: buildTransientRegistrationError(firstAttempt.error),
      };
    }
    await persistOwnNumberRegistrationState(shopDomain, {
      ...metadataPatch,
      "whatsappSender.ownNumber.registrationStatus": "failed",
      "whatsappSender.ownNumber.registrationOutcome": "META_HARD_ERROR",
      "whatsappSender.ownNumber.registrationLastAttemptAt": now,
      "whatsappSender.ownNumber.registrationError": String(
        firstAttempt?.error?.message || "Cloud API registration failed",
      ).slice(0, 400),
      "whatsappSender.ownNumber.registrationErrorAt": now,
    });
    return {
      ok: false,
      error: firstAttempt.error,
      diagnostics: phoneDiagnostics,
    };
  }

  if (!trustedPin) {
    const pinRequiredError = buildRegistrationPinRequiredError(
      firstAttempt.error,
    );
    await persistOwnNumberRegistrationState(shopDomain, {
      ...metadataPatch,
      "whatsappSender.ownNumber.registrationStatus": "failed",
      "whatsappSender.ownNumber.registrationOutcome": "NEED_PIN",
      "whatsappSender.ownNumber.registrationLastAttemptAt": now,
      "whatsappSender.ownNumber.registrationError": String(
        pinRequiredError.message ||
          "WhatsApp two-step verification PIN is required",
      ).slice(0, 400),
      "whatsappSender.ownNumber.registrationErrorAt": now,
    });
    return {
      ok: false,
      error: pinRequiredError,
      diagnostics: phoneDiagnostics,
    };
  }

  const pinAttempt = await registerOwnNumberWithPin({
    phoneId: pid,
    token: tk,
    pin: trustedPin,
  });
  if (pinAttempt?.ok) {
    const confirmedDiagnostics = await fetchOwnNumberPhoneDiagnostics({
      phoneId: pid,
      token: tk,
    }).catch(() => phoneDiagnostics);
    const successOutcome = buildRegistrationOutcome({
      diagnostics: confirmedDiagnostics,
      error: null,
      flowType: storedFlowType,
    });
    if (successOutcome.outcome !== "READY") {
      const err = new Error(
        successOutcome.message ||
          "Meta did not confirm Cloud readiness after registration.",
      );
      await persistOwnNumberRegistrationState(shopDomain, {
        ...extractPhoneMetadataPatch(confirmedDiagnostics, now),
        "whatsappSender.ownNumber.registrationStatus": successOutcome.status,
        "whatsappSender.ownNumber.registrationOutcome": successOutcome.outcome,
        "whatsappSender.ownNumber.registrationLastAttemptAt": now,
        "whatsappSender.ownNumber.registrationError": String(err.message).slice(
          0,
          400,
        ),
        "whatsappSender.ownNumber.registrationErrorAt": now,
      });
      return { ok: false, error: err, diagnostics: confirmedDiagnostics };
    }
    await persistOwnNumberRegistrationState(shopDomain, {
      ...extractPhoneMetadataPatch(confirmedDiagnostics, now),
      "whatsappSender.ownNumber.registrationStatus": "registered",
      "whatsappSender.ownNumber.registrationOutcome": "READY",
      "whatsappSender.ownNumber.registrationPin": trustedPin,
      "whatsappSender.ownNumber.registrationLastAttemptAt": now,
      "whatsappSender.ownNumber.registrationError": null,
      "whatsappSender.ownNumber.registrationErrorAt": null,
      "whatsappSender.ownNumber.registrationRegisteredAt": now,
    });
    return {
      ok: true,
      alreadyRegistered: !!pinAttempt?.alreadyRegistered,
      diagnostics: phoneDiagnostics,
    };
  }

  const lastErr = pinAttempt?.error || firstAttempt.error;

  await persistOwnNumberRegistrationState(shopDomain, {
    ...metadataPatch,
    ...(() => {
      const outcome = buildRegistrationOutcome({
        diagnostics: phoneDiagnostics,
        error: lastErr,
        flowType: storedFlowType,
      });
      return {
        "whatsappSender.ownNumber.registrationStatus": outcome.status,
        "whatsappSender.ownNumber.registrationOutcome": outcome.outcome,
        "whatsappSender.ownNumber.registrationLastAttemptAt": now,
        "whatsappSender.ownNumber.registrationError": String(
          outcome.message ||
            lastErr?.message ||
            "Cloud API registration failed",
        ).slice(0, 400),
        "whatsappSender.ownNumber.registrationErrorAt": now,
      };
    })(),
  });
  return {
    ok: false,
    error: isRegistrationRateLimited(lastErr?.meta)
      ? buildRegistrationRateLimitError(lastErr)
      : isTransientRegistrationUnavailable(lastErr?.meta, lastErr?.httpStatus)
        ? buildTransientRegistrationError(lastErr)
        : lastErr,
    diagnostics: phoneDiagnostics,
  };
}

async function sendMessage(payload, options = {}) {
  const runtime =
    options?.runtime || (await resolveRuntimeConfig(options?.shop));
  const senderMode = String(runtime?.senderMode || "").trim();
  const isOwnSender = senderMode === SENDER_MODES.OWN_NUMBER;
  const phoneId = String(runtime?.phoneId || "").trim();
  const token = String(runtime?.token || "").trim();
  if (!phoneId || !token) {
    const unavailableReason = String(
      runtime?.senderUnavailableReason || "own_number_unavailable",
    ).trim();
    if (
      isOwnSender &&
      options?.shop &&
      (unavailableReason === "own_number_auth_missing" ||
        unavailableReason === "own_number_auth_expired")
    ) {
      void markOwnNumberReauthRequired({
        shop: options.shop,
        errorMessage:
          "Meta access token is missing or expired. Reconnect your number.",
        meta: { reason: unavailableReason },
      });
    }
    const err = new Error(
      isOwnSender
        ? "Your own WhatsApp number is not ready or needs reconnect"
        : "WhatsApp sender is not configured for this shop",
    );
    if (isOwnSender) {
      err.meta = {
        reason: unavailableReason,
      };
    }
    throw err;
  }

  if (options?.shop && options?.skipBillingCheck !== true) {
    const allowance = await checkOutboundBillingAllowance(options.shop, {
      isTemplateMessage: String(payload?.type || "").trim() === "template",
      senderMode,
      toE164: payload?.to || "",
    });
    if (!allowance?.ok) {
      const err = new Error(
        allowance?.reason ||
          "OrderX cannot send more messages on the current plan right now.",
      );
      err.httpStatus = 402;
      err.meta = allowance;
      throw err;
    }
  }

  if (typeof options?.beforeDispatch === "function") {
    await options.beforeDispatch();
  }

  const url = `https://graph.facebook.com/${getGraphVersion()}/${phoneId}/messages`;

  const sendOnce = async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const acceptance = getWhatsAppMessageAcceptance(data);
      if (!acceptance.waMessageId) {
        return {
          ok: false,
          error: createMissingAcceptanceError(),
          data,
        };
      }
      return { ok: true, data };
    }
    return {
      ok: false,
      error: createSendError(
        data,
        res.status,
        res.headers?.get?.("retry-after"),
      ),
      data,
    };
  };

  const sendResult = await sendOnce();

  if (!sendResult.ok) {
    const err = sendResult.error;
    if (options?.deferOwnNumberFailureHandling !== true) {
      await handleOwnNumberSendErrorState({
        err,
        runtime,
        payload,
        options,
      });
    }
    throw err;
  }

  if (isOwnSender && options?.shop) {
    await markOwnNumberSendSuccess(options.shop);
  }
  return sendResult.data;
}

function clipText(v, maxLen) {
  const s = String(v ?? "");
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 3))}...`;
}

const DEFAULT_CONFIRM_REPLY_TEXT =
  "*Order Confirmed*\n{{order_number_label}} from {{store_name}} has been confirmed.";
const DEFAULT_CANCEL_REPLY_TEXT =
  "*Order Cancelled*\nThank you for your response,\n{{order_number_label}} has been cancelled.";

function renderOrderActionReplyText(templateText, context = {}) {
  const source = String(templateText || "").trim();
  const replacements = {
    customer_name: clipText(context.customerName || "Customer", 200),
    store_name: clipText(context.storeName || "our store", 200),
    order_number: clipText(context.orderNumber || "", 200),
    order_number_label: clipText(
      context.orderNumber ? `Order ${context.orderNumber}` : "Your order",
      220,
    ),
    support_whatsapp_number: clipText(context.supportWhatsAppNumber || "", 64),
  };
  return clipText(
    (source || DEFAULT_CONFIRM_REPLY_TEXT).replace(
      /\{\{\s*([a-z_]+)\s*\}\}/gi,
      (match, key) => {
        const value = replacements[String(key || "").toLowerCase()];
        return value != null ? String(value) : match;
      },
    ),
    4096,
  );
}

function clipHard(v, maxLen) {
  const s = String(v ?? "");
  if (s.length <= maxLen) return s;
  return s.slice(0, Math.max(0, maxLen));
}

function formatTemplateProductsParam(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  const lines = raw
    .split(/\r?\n+/)
    .map((line) =>
      String(line || "")
        .replace(/^\s*products\s*:\s*/i, "")
        .trim(),
    )
    .filter(Boolean);

  // WhatsApp template variable should remain a single parameter string.
  const combined = lines.length ? lines.join(" || ") : raw;
  return clipText(combined, 1000);
}

export async function sendCodConfirmReplyTemplate({
  to,
  customerName,
  storeName,
  orderNumber,
  productsText,
  productImageUrl,
  amountText,
  deliveryAddressText,
  confirmPayload, // optional; if supported, makes webhook routing deterministic
  cancelPayload, // optional; if supported, makes webhook routing deterministic
  shop, // optional; for DB logging
  kind = "cod_confirm_template",
  attemptId = null,
  orderGid = null,
  meta = null,
  skipBillingCheck = false,
}) {
  const { templateCodConfirm, langCodConfirm, enableButtonPayloadOverrides } =
    getConfig();
  const runtime = await resolveRuntimeConfig(shop);
  const managedResolved = resolveManagedFlowTemplateRuntime(
    runtime,
    "order_confirmation",
    "cod_confirm_new",
    templateCodConfirm,
    langCodConfirm,
  );
  if (managedResolved.managedTemplate) {
    const buttonPayloads = enableButtonPayloadOverrides
      ? [
          { index: 0, payload: confirmPayload },
          { index: 1, payload: cancelPayload },
        ].filter((row) => String(row?.payload || "").trim())
      : [];
    return sendConfiguredFlowTemplate({
      flowKey: "order_confirmation",
      legacyTemplateKey: "cod_confirm_new",
      fallbackName: templateCodConfirm,
      fallbackLang: langCodConfirm,
      to,
      context: {
        customer_name: customerName || "Customer",
        store_name: storeName || "our store",
        order_number: orderNumber || "",
        product_list: formatTemplateProductsParam(productsText || ""),
        product_image_url: productImageUrl || "",
        total_price: amountText || "",
        delivery_address: deliveryAddressText || "",
      },
      buttonPayloads,
      shop,
      kind,
      attemptId,
      orderGid,
      meta,
      skipBillingCheck,
    });
  }
  const templateCodConfirmResolved = managedResolved.templateName;
  const langCodConfirmResolved = managedResolved.languageCode;
  const bodyComponent = {
    type: "body",
    parameters: [
      { type: "text", text: clipText(customerName || "Customer", 200) }, // {{1}}
      { type: "text", text: clipText(storeName || "our store", 200) }, // {{2}}
      { type: "text", text: clipText(orderNumber || "", 200) }, // {{3}}
      { type: "text", text: formatTemplateProductsParam(productsText || "") }, // {{4}}
      { type: "text", text: clipText(amountText || "", 200) }, // {{5}}
      { type: "text", text: clipText(deliveryAddressText || "", 400) }, // {{6}}
    ],
  };

  const buildBase = (code) => ({
    messaging_product: "whatsapp",
    to: normalizeTo(to),
    type: "template",
    template: {
      name: templateCodConfirmResolved,
      language: { code },
      components: [bodyComponent],
    },
  });

  // If Meta accepts per-send quick reply payload parameters, include them.
  // If not, we retry without these button components and route using context.id -> waMessageId.
  const buildWithPayloads = (code) =>
    enableButtonPayloadOverrides && confirmPayload && cancelPayload
      ? {
          ...buildBase(code),
          template: {
            ...buildBase(code).template,
            components: [
              bodyComponent,
              {
                type: "button",
                sub_type: "quick_reply",
                index: "0",
                parameters: [
                  { type: "payload", payload: String(confirmPayload) },
                ],
              },
              {
                type: "button",
                sub_type: "quick_reply",
                index: "1",
                parameters: [
                  { type: "payload", payload: String(cancelPayload) },
                ],
              },
            ],
          },
        }
      : null;

  const withPayloads0 = buildWithPayloads(langCodConfirm);
  let sent = null;
  let langUsed = null;

  if (withPayloads0) {
    try {
      const res = await sendTemplateWithLangFallback(
        (code) => buildWithPayloads(code) || buildBase(code),
        langCodConfirmResolved,
        {
          runtime,
          shop,
          skipBillingCheck,
          kind,
          attemptId,
          orderGid,
          suppressOwnNumberFailureHandling: true,
        },
      );
      sent = res.data;
      langUsed = res.langUsed;
    } catch {
      // retry without payload overrides
      const res = await sendTemplateWithLangFallback(
        buildBase,
        langCodConfirmResolved,
        {
          runtime,
          shop,
          skipBillingCheck,
          kind,
          attemptId,
          orderGid,
        },
      );
      sent = res.data;
      langUsed = res.langUsed;
    }
  } else {
    const res = await sendTemplateWithLangFallback(
      buildBase,
      langCodConfirmResolved,
      {
        runtime,
        shop,
        skipBillingCheck,
        kind,
        attemptId,
        orderGid,
      },
    );
    sent = res.data;
    langUsed = res.langUsed;
  }

  await safeLogOutbound({
    shop,
    toE164: to,
    kind,
    text: "",
    templateName: templateCodConfirmResolved,
    senderMode: runtime?.senderMode || "unknown",
    senderPhoneNumberId: runtime?.phoneId || null,
    waMessageId: sent?.messages?.[0]?.id || null,
    attemptId,
    orderGid,
    meta: {
      ...(meta && typeof meta === "object" ? meta : {}),
      type: "template",
      langUsed: langUsed || null,
    },
  });

  return { data: sent, templateUsed: templateCodConfirmResolved };
}

// New name (preferred). Keep the old export for compatibility.
export async function sendCodConfirmTemplate(args) {
  return sendCodConfirmReplyTemplate(args);
}

export async function sendDeliveryFailedRedeliverTemplate({
  to,
  customerName,
  orderNumber,
  storeName,
  redeliverPayload,
  cancelPayload,
  shop, // optional; for DB logging
  kind = "delivery_failed_redeliver_template",
  attemptId = null,
  orderGid = null,
  meta = null,
}) {
  const {
    templateDeliveryFailedRedeliver,
    langDeliveryFailedRedeliver,
    enableButtonPayloadOverrides,
  } = getConfig();
  const runtime = await resolveRuntimeConfig(shop);
  const {
    templateName: templateDeliveryFailedRedeliverResolved,
    languageCode: langDeliveryFailedRedeliverResolved,
  } = resolveTemplateRuntime(
    runtime,
    "delivery_failed_redeliver",
    templateDeliveryFailedRedeliver,
    langDeliveryFailedRedeliver,
  );

  const bodyComponent = {
    type: "body",
    parameters: [
      { type: "text", text: clipText(customerName || "Customer", 200) }, // {{1}}
      { type: "text", text: clipText(orderNumber || "", 200) }, // {{2}}
      { type: "text", text: clipText(storeName || "our store", 200) }, // {{3}}
    ],
  };

  const buildBase = (code) => ({
    messaging_product: "whatsapp",
    to: normalizeTo(to),
    type: "template",
    template: {
      name: templateDeliveryFailedRedeliverResolved,
      language: { code },
      components: [bodyComponent],
    },
  });

  const buildWithPayloads = (code) =>
    enableButtonPayloadOverrides && redeliverPayload && cancelPayload
      ? {
          ...buildBase(code),
          template: {
            ...buildBase(code).template,
            components: [
              bodyComponent,
              {
                type: "button",
                sub_type: "quick_reply",
                index: "0",
                parameters: [
                  { type: "payload", payload: String(redeliverPayload) },
                ],
              },
              {
                type: "button",
                sub_type: "quick_reply",
                index: "1",
                parameters: [
                  { type: "payload", payload: String(cancelPayload) },
                ],
              },
            ],
          },
        }
      : null;

  const withPayloads0 = buildWithPayloads(langDeliveryFailedRedeliver);
  let sent = null;
  let langUsed = null;

  if (withPayloads0) {
    try {
      const res = await sendTemplateWithLangFallback(
        (code) => buildWithPayloads(code) || buildBase(code),
        langDeliveryFailedRedeliverResolved,
        {
          runtime,
          shop,
          kind,
          attemptId,
          orderGid,
          suppressOwnNumberFailureHandling: true,
        },
      );
      sent = res.data;
      langUsed = res.langUsed;
    } catch {
      const res = await sendTemplateWithLangFallback(
        buildBase,
        langDeliveryFailedRedeliverResolved,
        { runtime, shop, kind, attemptId, orderGid },
      );
      sent = res.data;
      langUsed = res.langUsed;
    }
  } else {
    const res = await sendTemplateWithLangFallback(
      buildBase,
      langDeliveryFailedRedeliverResolved,
      { runtime, shop, kind, attemptId, orderGid },
    );
    sent = res.data;
    langUsed = res.langUsed;
  }

  await safeLogOutbound({
    shop,
    toE164: to,
    kind,
    text: "",
    templateName: templateDeliveryFailedRedeliverResolved,
    senderMode: runtime?.senderMode || "unknown",
    senderPhoneNumberId: runtime?.phoneId || null,
    waMessageId: sent?.messages?.[0]?.id || null,
    attemptId,
    orderGid,
    meta: {
      ...(meta && typeof meta === "object" ? meta : {}),
      type: "template",
      langUsed: langUsed || null,
    },
  });

  return { data: sent, templateUsed: templateDeliveryFailedRedeliverResolved };
}

export async function sendCodConfirmedTemplate({
  to,
  orderNumber,
  storeName,
  customerName = "",
  shop,
  kind = "cod_confirmed_text",
  attemptId = null,
  orderGid = null,
  meta = null,
}) {
  const shopRecord = shop
    ? await Shop.findOne({ shop })
        .select({ settings: 1 })
        .lean()
        .catch(() => null)
    : null;
  const text = renderOrderActionReplyText(
    shopRecord?.settings?.confirmReplyText || DEFAULT_CONFIRM_REPLY_TEXT,
    {
      customerName,
      storeName,
      orderNumber,
      supportWhatsAppNumber: shopRecord?.settings?.supportWhatsAppNumber || "",
    },
  );
  const res = await sendWhatsAppText({
    to,
    text,
    shop,
    kind,
    attemptId,
    orderGid,
    meta,
  });
  return { data: res.data, templateUsed: "freeform_text" };
}

export async function sendOrderCancelTemplate({
  to,
  orderNumber = "",
  storeName = "",
  customerName = "",
  shop,
  kind = "order_cancel_text",
  attemptId = null,
  orderGid = null,
  meta = null,
}) {
  const shopRecord = shop
    ? await Shop.findOne({ shop })
        .select({ settings: 1 })
        .lean()
        .catch(() => null)
    : null;
  const text = renderOrderActionReplyText(
    shopRecord?.settings?.cancelReplyText || DEFAULT_CANCEL_REPLY_TEXT,
    {
      customerName,
      storeName,
      orderNumber,
      supportWhatsAppNumber: shopRecord?.settings?.supportWhatsAppNumber || "",
    },
  );
  const res = await sendWhatsAppText({
    to,
    text,
    shop,
    kind,
    attemptId,
    orderGid,
    meta,
  });
  return { data: res.data, templateUsed: "freeform_text" };
}

async function sendBodyOnlyTemplate({
  to,
  flowKey = null,
  templateKey = null,
  templateName,
  languageCode,
  bodyParams = [],
  bodyParamsOwnNumber = null,
  shop,
  kind = "template_message",
  attemptId = null,
  orderGid = null,
  meta = null,
}) {
  if (flowKey) {
    const flowContext = meta?.flowContext || {};
    return sendConfiguredFlowTemplate({
      flowKey,
      legacyTemplateKey: templateKey,
      fallbackName: templateName,
      fallbackLang: languageCode,
      to,
      context: {
        ...flowContext,
        bodyParams,
        bodyParamsOwnNumber,
      },
      shop,
      kind,
      attemptId,
      orderGid,
      meta,
    });
  }

  const runtime = await resolveRuntimeConfig(shop);
  const templateCfg = resolveTemplateRuntime(
    runtime,
    templateKey || templateName,
    templateName,
    languageCode,
  );
  const templateNameResolved = templateCfg.templateName;
  const languageCodeResolved = templateCfg.languageCode;
  const useOwnNumberParams =
    String(runtime?.senderMode || "").trim() === SENDER_MODES.OWN_NUMBER &&
    Array.isArray(bodyParamsOwnNumber) &&
    bodyParamsOwnNumber.length > 0;
  const paramsSource = useOwnNumberParams ? bodyParamsOwnNumber : bodyParams;
  const params = (Array.isArray(paramsSource) ? paramsSource : []).map(
    (value) => ({
      type: "text",
      text: clipText(value || "", 1000),
    }),
  );

  const buildBase = (code) => ({
    messaging_product: "whatsapp",
    to: normalizeTo(to),
    type: "template",
    template: {
      name: templateNameResolved,
      language: { code },
      components: [{ type: "body", parameters: params }],
    },
  });

  const sent = await sendTemplateWithLangFallback(
    buildBase,
    languageCodeResolved,
    {
      runtime,
      shop,
      kind,
      attemptId,
      orderGid,
    },
  );

  await safeLogOutbound({
    shop,
    toE164: to,
    kind,
    text: "",
    templateName: templateNameResolved,
    senderMode: runtime?.senderMode || "unknown",
    senderPhoneNumberId: runtime?.phoneId || null,
    waMessageId: sent?.data?.messages?.[0]?.id || null,
    attemptId,
    orderGid,
    meta: {
      ...(meta && typeof meta === "object" ? meta : {}),
      type: "template",
      langUsed: sent?.langUsed || null,
    },
  });

  return { data: sent.data, templateUsed: templateNameResolved };
}

export async function sendOrderDispatchedTemplate({
  to,
  customerName,
  storeName,
  orderNumber,
  productsText,
  productImageUrl,
  courierName,
  trackingNumber,
  trackingLink,
  shop,
  kind = "order_dispatched_template",
  attemptId = null,
  orderGid = null,
  meta = null,
}) {
  const { templateOrderDispatched, langOrderDispatched } = getConfig();
  return sendBodyOnlyTemplate({
    to,
    flowKey: "order_dispatched",
    templateKey: "cod_order_dispatched",
    templateName: templateOrderDispatched,
    languageCode: langOrderDispatched,
    bodyParams: [
      customerName || "Customer",
      storeName || "our store",
      orderNumber || "",
      formatTemplateProductsParam(productsText || ""),
      courierName || "Not available",
      trackingNumber || "Not available",
      trackingLink || "Not available",
    ],
    bodyParamsOwnNumber: [
      customerName || "Customer",
      orderNumber || "",
      storeName || "our store",
      formatTemplateProductsParam(productsText || ""),
      courierName || "Not available",
      trackingNumber || "Not available",
      trackingLink || "Not available",
    ],
    shop,
    kind,
    attemptId,
    orderGid,
    meta: {
      ...(meta && typeof meta === "object" ? meta : {}),
      flowContext: {
        customer_name: customerName || "Customer",
        order_number: orderNumber || "",
        store_name: storeName || "our store",
        product_list: formatTemplateProductsParam(productsText || ""),
        product_image_url: productImageUrl || "",
        courier_name: courierName || "Not available",
        tracking_number: trackingNumber || "Not available",
        tracking_url: trackingLink || "Not available",
      },
    },
  });
}

export async function sendTrackingUpdatedTemplate({
  to,
  customerName,
  storeName,
  orderNumber,
  courierName,
  trackingNumber,
  trackingLink,
  shop,
  kind = "tracking_updated_template",
  attemptId = null,
  orderGid = null,
  meta = null,
}) {
  const { templateTrackingUpdated, langTrackingUpdated } = getConfig();
  return sendBodyOnlyTemplate({
    to,
    flowKey: "tracking_updated",
    templateKey: "cod_tracking_updated",
    templateName: templateTrackingUpdated,
    languageCode: langTrackingUpdated,
    bodyParams: [
      customerName || "Customer",
      storeName || "our store",
      orderNumber || "",
      courierName || "Not available",
      trackingNumber || "Not available",
      trackingLink || "Not available",
    ],
    bodyParamsOwnNumber: [
      customerName || "Customer",
      orderNumber || "",
      storeName || "our store",
      courierName || "Not available",
      trackingNumber || "Not available",
      trackingLink || "Not available",
    ],
    shop,
    kind,
    attemptId,
    orderGid,
    meta: {
      ...(meta && typeof meta === "object" ? meta : {}),
      flowContext: {
        customer_name: customerName || "Customer",
        order_number: orderNumber || "",
        store_name: storeName || "our store",
        courier_name: courierName || "Not available",
        tracking_number: trackingNumber || "Not available",
        tracking_url: trackingLink || "Not available",
      },
    },
  });
}

export async function sendOrderCancelledUpdateTemplate({
  to,
  customerName,
  storeName,
  orderNumber,
  reasonText,
  supportWhatsAppNumber,
  shop,
  kind = "order_cancelled_update_template",
  attemptId = null,
  orderGid = null,
  meta = null,
}) {
  const { templateOrderCancelledUpdate, langOrderCancelledUpdate } =
    getConfig();
  return sendBodyOnlyTemplate({
    to,
    flowKey: "order_cancelled",
    templateKey: "cod_order_cancelled",
    templateName: templateOrderCancelledUpdate,
    languageCode: langOrderCancelledUpdate,
    bodyParams: [
      customerName || "Customer",
      storeName || "our store",
      orderNumber || "",
      reasonText || "No reason provided",
    ],
    bodyParamsOwnNumber: [
      customerName || "Customer",
      orderNumber || "",
      storeName || "our store",
      reasonText || "No reason provided",
    ],
    shop,
    kind,
    attemptId,
    orderGid,
    meta: {
      ...(meta && typeof meta === "object" ? meta : {}),
      flowContext: {
        customer_name: customerName || "Customer",
        order_number: orderNumber || "",
        store_name: storeName || "our store",
        cancel_reason: reasonText || "No reason provided",
        support_whatsapp_number: supportWhatsAppNumber || "",
      },
    },
  });
}

export async function sendOrderUpdateGenericTemplate({
  to,
  customerName,
  storeName,
  orderNumber,
  updateTitle,
  updateDetails,
  shop,
  kind = "order_update_generic_template",
  attemptId = null,
  orderGid = null,
  meta = null,
}) {
  const { templateOrderUpdateGeneric, langOrderUpdateGeneric } = getConfig();
  return sendBodyOnlyTemplate({
    to,
    flowKey: "order_update_generic",
    templateKey: "cod_order_update_generic",
    templateName: templateOrderUpdateGeneric,
    languageCode: langOrderUpdateGeneric,
    bodyParams: [
      customerName || "Customer",
      storeName || "our store",
      orderNumber || "",
      updateTitle || "Order update",
      updateDetails || "Status updated",
    ],
    bodyParamsOwnNumber: [
      customerName || "Customer",
      orderNumber || "",
      storeName || "our store",
      updateTitle || "Order update",
      updateDetails || "Status updated",
    ],
    shop,
    kind,
    attemptId,
    orderGid,
    meta: {
      ...(meta && typeof meta === "object" ? meta : {}),
      flowContext: {
        customer_name: customerName || "Customer",
        order_number: orderNumber || "",
        store_name: storeName || "our store",
        update_title: updateTitle || "Order update",
        update_details: updateDetails || "Status updated",
      },
    },
  });
}

export async function sendReviewRequestTemplate({
  to,
  customerName,
  storeName,
  orderNumber,
  productsText,
  productImageUrl,
  reviewUrl,
  shop,
  kind = "review_request_template",
  attemptId = null,
  orderGid = null,
  meta = null,
}) {
  return sendConfiguredFlowTemplate({
    flowKey: "review_request",
    to,
    context: {
      customer_name: customerName || "Customer",
      store_name: storeName || "our store",
      order_number: orderNumber || "",
      product_list: formatTemplateProductsParam(productsText || ""),
      product_image_url: productImageUrl || "",
      review_url: reviewUrl || "",
    },
    shop,
    kind,
    attemptId,
    orderGid,
    meta,
  });
}

export async function sendAbandonedCartRecoveryTemplate({
  to,
  customerName,
  storeName,
  productName,
  productsText,
  productImageUrl,
  totalPrice,
  checkoutUrl,
  abandonedMinutes,
  shop,
  kind = "abandoned_cart_recovery_template",
  attemptId = null,
  orderGid = null,
  meta = null,
}) {
  return sendConfiguredFlowTemplate({
    flowKey: "abandoned_cart_recovery",
    to,
    context: {
      customer_name: customerName || "Customer",
      store_name: storeName || "our store",
      product_name: productName || "",
      product_list: formatTemplateProductsParam(productsText || ""),
      product_image_url: productImageUrl || "",
      total_price: totalPrice || "",
      checkout_url: checkoutUrl || "",
      abandoned_minutes: String(abandonedMinutes || ""),
    },
    shop,
    kind,
    attemptId,
    orderGid,
    meta,
  });
}

export async function sendCodConfirmRequestTestTemplate({
  to,
  customerName,
  orderNumber,
  storeName,
  confirmToken,
  cancelToken,
}) {
  const { templateTestCodConfirmRequest, langTestCodConfirmRequest } =
    getConfig();

  if (!confirmToken || !cancelToken) {
    throw new Error("Missing confirmToken/cancelToken for URL buttons");
  }

  const templateName = templateTestCodConfirmRequest || "cod_confirm_request";

  const buildPayload = (code, bodyParamCount = 3, includeButtons = true) => {
    const bodyParams = [
      { type: "text", text: clipText(customerName || "Customer", 200) }, // {{1}}
      { type: "text", text: clipText(orderNumber || "#TEST-ORDER", 200) }, // {{2}}
      { type: "text", text: clipText(storeName || "our store", 200) }, // {{3}}
    ].slice(0, bodyParamCount);

    const components = [
      {
        type: "body",
        parameters: bodyParams,
      },
    ];

    if (includeButtons) {
      components.push(
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: String(confirmToken) }],
        },
        {
          type: "button",
          sub_type: "url",
          index: "1",
          parameters: [{ type: "text", text: String(cancelToken) }],
        },
      );
    }

    return {
      messaging_product: "whatsapp",
      to: normalizeTo(to),
      type: "template",
      template: {
        name: templateName,
        language: { code },
        components,
      },
    };
  };

  const tries = [
    { bodyParamCount: 3, includeButtons: true },
    { bodyParamCount: 3, includeButtons: false },
    { bodyParamCount: 2, includeButtons: true },
    { bodyParamCount: 2, includeButtons: false },
  ];

  let lastErr = null;
  for (let i = 0; i < tries.length; i += 1) {
    const t = tries[i];
    try {
      const res = await sendTemplateWithLangFallback(
        (code) => buildPayload(code, t.bodyParamCount, t.includeButtons),
        langTestCodConfirmRequest,
        {
          suppressOwnNumberFailureHandling: i < tries.length - 1,
        },
      );
      return { data: res.data, templateUsed: templateName };
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr;
}

export async function sendWhatsAppText({
  to,
  text,
  previewUrl = false,
  shop,
  runtime = null,
  kind = "freeform_text",
  attemptId = null,
  orderGid = null,
  meta = null,
  replyToWaMessageId = null,
  beforeSend = null,
  skipBillingCheck = false,
}) {
  const payload = {
    messaging_product: "whatsapp",
    to: normalizeTo(to),
    type: "text",
    ...(String(replyToWaMessageId || "").trim()
      ? { context: { message_id: String(replyToWaMessageId).trim() } }
      : {}),
    text: {
      body: clipText(text || "", 4096),
      preview_url: !!previewUrl,
    },
  };

  const resolvedRuntime = runtime || (await resolveRuntimeConfig(shop));
  const data = await sendMessage(payload, {
    shop,
    runtime: resolvedRuntime,
    kind,
    attemptId,
    orderGid,
    beforeDispatch: beforeSend,
    skipBillingCheck,
  });
  await safeLogOutbound({
    shop,
    toE164: to,
    kind,
    text: clipText(text || "", 4096),
    templateName: null,
    senderMode: resolvedRuntime?.senderMode || "unknown",
    senderPhoneNumberId: resolvedRuntime?.phoneId || null,
    waMessageId: data?.messages?.[0]?.id || null,
    attemptId,
    orderGid,
    meta: {
      ...(meta && typeof meta === "object" ? meta : {}),
      type: "text",
      previewUrl: !!previewUrl,
      replyToWaMessageId: String(replyToWaMessageId || "").trim() || null,
    },
    skipUsageBilling: skipBillingCheck,
  });
  return { data };
}

export async function sendWhatsAppMedia({
  to,
  shop,
  buffer,
  fileName = "media.bin",
  contentType,
  mediaType,
  caption = "",
  voice = false,
  runtime = null,
  kind = "agent_reply_media",
  meta = null,
  replyToWaMessageId = null,
  beforeSend = null,
  skipBillingCheck = false,
}) {
  const normalizedMediaType = String(mediaType || "")
    .trim()
    .toLowerCase();
  if (
    !new Set(["image", "audio", "video", "document"]).has(
      normalizedMediaType,
    )
  ) {
    const error = new Error(
      "Only image, audio, video, and document agent replies are supported.",
    );
    error.httpStatus = 400;
    throw error;
  }

  const resolvedRuntime = runtime || (await resolveRuntimeConfig(shop));
  const mediaId = await uploadMediaBufferToMeta({
    runtime: resolvedRuntime,
    buffer,
    fileName,
    contentType,
  });

  const cleanCaption = clipText(caption || "", 1024);
  const mediaPayload = {
    id: mediaId,
    ...(["image", "video", "document"].includes(normalizedMediaType) &&
    cleanCaption
      ? { caption: cleanCaption }
      : {}),
    ...(normalizedMediaType === "document"
      ? { filename: String(fileName || "document").slice(0, 240) }
      : {}),
  };
  const payload = {
    messaging_product: "whatsapp",
    to: normalizeTo(to),
    type: normalizedMediaType,
    ...(String(replyToWaMessageId || "").trim()
      ? { context: { message_id: String(replyToWaMessageId).trim() } }
      : {}),
    [normalizedMediaType]: mediaPayload,
  };

  const data = await sendMessage(payload, {
    shop,
    runtime: resolvedRuntime,
    kind,
    beforeDispatch: beforeSend,
    skipBillingCheck,
  });
  const waMessageId = data?.messages?.[0]?.id || null;
  await safeLogOutbound({
    shop,
    toE164: to,
    kind,
    text:
      cleanCaption ||
      (normalizedMediaType === "image"
        ? "[Image]"
        : normalizedMediaType === "video"
          ? "[Video]"
          : normalizedMediaType === "document"
            ? `[Document: ${String(fileName || "document").slice(0, 160)}]`
            : voice
              ? "[Voice message]"
              : "[Audio]"),
    templateName: null,
    senderMode: resolvedRuntime?.senderMode || "unknown",
    senderPhoneNumberId: resolvedRuntime?.phoneId || null,
    waMessageId,
    meta: {
      ...(meta && typeof meta === "object" ? meta : {}),
      type: normalizedMediaType,
      replyToWaMessageId: String(replyToWaMessageId || "").trim() || null,
      media: {
        id: mediaId,
        mimeType: String(contentType || "application/octet-stream"),
        filename: String(fileName || "media.bin"),
        caption: cleanCaption || "",
        voice: normalizedMediaType === "audio" && voice === true,
      },
    },
    skipUsageBilling: skipBillingCheck,
  });
  return { data, mediaId, waMessageId };
}

function safeMediaFilename(value, fallback = "whatsapp-media") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return cleaned || fallback;
}

export async function fetchWhatsAppMediaForLog({ shop, messageLog }) {
  const shopDomain = String(shop || "").trim();
  const log = messageLog && typeof messageLog === "object" ? messageLog : {};
  const media =
    log?.meta?.media && typeof log.meta.media === "object"
      ? log.meta.media
      : null;
  const mediaId = String(media?.id || "").trim();
  if (!shopDomain || !mediaId) {
    const error = new Error("Media is not available for this message.");
    error.httpStatus = 404;
    throw error;
  }

  let token = "";
  if (String(log?.senderMode || "").trim() === SENDER_MODES.OWN_NUMBER) {
    const record = await Shop.findOne({ shop: shopDomain })
      .select({ "whatsappSender.ownNumber": 1 })
      .lean();
    const own = record?.whatsappSender?.ownNumber || {};
    token = String(own?.accessToken || "").trim();
    if (token) {
      try {
        const refreshed = await maybeRefreshByonAccessToken({
          shop: shopDomain,
          ownNumber: own,
          force: false,
        });
        token = String(refreshed?.token || token).trim();
      } catch {
        // The metadata request below will return a safe error if reconnect is needed.
      }
    }
  } else {
    token = String(getConfig().token || "").trim();
  }

  if (!token) {
    const error = new Error("WhatsApp media access requires sender reconnect.");
    error.httpStatus = 409;
    throw error;
  }

  const metadataResponse = await fetch(
    `https://graph.facebook.com/${getGraphVersion()}/${encodeURIComponent(mediaId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const metadata = await metadataResponse.json().catch(() => ({}));
  if (!metadataResponse.ok || !metadata?.url) {
    const error = new Error(
      metadata?.error?.message || "Could not retrieve WhatsApp media metadata.",
    );
    error.httpStatus = metadataResponse.status || 502;
    error.meta = metadata;
    throw error;
  }

  const mediaResponse = await fetch(String(metadata.url), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!mediaResponse.ok || !mediaResponse.body) {
    const error = new Error("Could not download WhatsApp media.");
    error.httpStatus = mediaResponse.status || 502;
    throw error;
  }

  return {
    body: mediaResponse.body,
    contentType:
      String(metadata?.mime_type || mediaResponse.headers.get("content-type") || "")
        .split(";")[0]
        .trim() || "application/octet-stream",
    contentLength:
      Number(metadata?.file_size || mediaResponse.headers.get("content-length") || 0) ||
      null,
    fileName: safeMediaFilename(media?.filename, `whatsapp-${mediaId.slice(-10)}`),
  };
}

export async function sendWhatsAppButtons({
  to,
  text,
  buttons = [],
  shop,
  kind = "freeform_buttons",
  attemptId = null,
  orderGid = null,
  meta = null,
}) {
  const list = Array.isArray(buttons) ? buttons : [];
  const cleanButtons = list
    .map((b) => ({
      id: clipHard(String(b?.id || "").trim(), 256),
      title: clipHard(String(b?.title || "").trim(), 20),
    }))
    .filter((b) => b.id && b.title)
    .slice(0, 3);

  if (!cleanButtons.length) {
    throw new Error("sendWhatsAppButtons requires at least 1 button");
  }

  const payload = {
    messaging_product: "whatsapp",
    to: normalizeTo(to),
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: clipText(text || "", 1024) },
      action: {
        buttons: cleanButtons.map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  };

  const runtime = await resolveRuntimeConfig(shop);
  const data = await sendMessage(payload, {
    shop,
    runtime,
    kind,
    attemptId,
    orderGid,
  });
  await safeLogOutbound({
    shop,
    toE164: to,
    kind,
    text: clipText(text || "", 1024),
    templateName: null,
    senderMode: runtime?.senderMode || "unknown",
    senderPhoneNumberId: runtime?.phoneId || null,
    waMessageId: data?.messages?.[0]?.id || null,
    attemptId,
    orderGid,
    meta: {
      ...(meta && typeof meta === "object" ? meta : {}),
      type: "interactive",
      buttons: cleanButtons,
    },
  });

  return { data };
}

export async function sendWhatsAppList({
  to,
  text,
  buttonText = "Select",
  rows = [],
  sectionTitle = "Options",
  shop,
  kind = "freeform_list",
  attemptId = null,
  orderGid = null,
  meta = null,
}) {
  const list = Array.isArray(rows) ? rows : [];
  const cleanRows = list
    .map((r) => ({
      id: clipHard(String(r?.id || "").trim(), 256),
      title: clipHard(String(r?.title || "").trim(), 24),
      description: clipHard(String(r?.description || "").trim(), 72),
    }))
    .filter((r) => r.id && r.title)
    .slice(0, 10);

  if (!cleanRows.length) {
    throw new Error("sendWhatsAppList requires at least 1 row");
  }

  const actionButton =
    clipHard(String(buttonText || "").trim(), 20) || "Select";
  const section = {
    title: clipHard(String(sectionTitle || "").trim(), 24) || "Options",
    rows: cleanRows.map((r) => ({
      id: r.id,
      title: r.title,
      ...(r.description ? { description: r.description } : {}),
    })),
  };

  const payload = {
    messaging_product: "whatsapp",
    to: normalizeTo(to),
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: clipText(text || "", 1024) },
      action: {
        button: actionButton,
        sections: [section],
      },
    },
  };

  const runtime = await resolveRuntimeConfig(shop);
  const data = await sendMessage(payload, {
    shop,
    runtime,
    kind,
    attemptId,
    orderGid,
  });
  await safeLogOutbound({
    shop,
    toE164: to,
    kind,
    text: clipText(text || "", 1024),
    templateName: null,
    senderMode: runtime?.senderMode || "unknown",
    senderPhoneNumberId: runtime?.phoneId || null,
    waMessageId: data?.messages?.[0]?.id || null,
    attemptId,
    orderGid,
    meta: {
      ...(meta && typeof meta === "object" ? meta : {}),
      type: "interactive_list",
      button: actionButton,
      sectionTitle: section.title,
      rows: cleanRows,
    },
  });

  return { data };
}
