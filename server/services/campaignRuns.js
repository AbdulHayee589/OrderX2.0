import fetch from "node-fetch";

import CampaignRun from "../models/CampaignRun.js";
import CampaignRecipient from "../models/CampaignRecipient.js";
import Shop from "../models/Shop.js";
import { agenda } from "../jobs/agenda.js";
import {
  getAdminClient,
  fetchOrderForCodConfirmTemplate,
} from "./shopifyAdmin.js";
import { normalizePhoneE164 } from "./phone.js";
import { canSendWhatsApp, incrementWhatsAppUsage } from "./usage.js";
import { getPlan, SENDER_MODES } from "./plans.js";
import {
  buildTemplateContext,
  ensureManagedTemplateCatalog,
  isTemplateApproved,
  mergeManagedTemplateStatusesWithMeta,
  normalizeMetaTemplateName,
  normalizeTemplateLanguage,
  serializeTemplateForClient,
  syncCampaignLibraryTemplatesWithMeta,
  TEMPLATE_VARIABLE_DEFINITIONS,
  upsertCorePackTemplatesIntoCatalog,
} from "./templateCatalog.js";
import {
  isMetaAccessTokenExpired,
  maybeRefreshByonAccessToken,
} from "./metaByonAuth.js";
import { sendManagedTemplateDirect } from "./whatsapp.js";
import {
  buildCampaignRunSummary,
  calculateCampaignPercent,
  classifyCampaignSendFailure,
  isCampaignTemplateCatalogFresh,
  runCampaignOperationWithRetry,
} from "./campaignSendPolicy.js";
import { claimCampaignPhone } from "./campaignRecipientClaims.js";
import { reconcileCampaignDeliveryFromLog } from "./campaignDeliveryStatus.js";

const MAX_CAMPAIGN_RUNS = Number(process.env.MAX_CAMPAIGN_RUNS || 25);
const configuredRecipientLimit = Number(
  process.env.MAX_CAMPAIGN_RECIPIENTS_PER_RUN || 250,
);
const MAX_RECIPIENTS_PER_RUN = Number.isFinite(configuredRecipientLimit)
  ? Math.max(1, Math.floor(configuredRecipientLimit))
  : 250;
const configuredCampaignAttempts = Number(
  process.env.CAMPAIGN_TRANSIENT_ATTEMPTS || 3,
);
const CAMPAIGN_TRANSIENT_ATTEMPTS = Number.isFinite(
  configuredCampaignAttempts,
)
  ? Math.max(1, Math.min(4, Math.floor(configuredCampaignAttempts)))
  : 3;
const configuredTemplateSyncCacheMs = Number(
  process.env.CAMPAIGN_TEMPLATE_SYNC_CACHE_MS || 5 * 60 * 1000,
);
const CAMPAIGN_TEMPLATE_SYNC_CACHE_MS = Number.isFinite(
  configuredTemplateSyncCacheMs,
)
  ? Math.max(30_000, Math.floor(configuredTemplateSyncCacheMs))
  : 5 * 60 * 1000;
const configuredMetaTemplateTimeoutMs = Number(
  process.env.META_TEMPLATE_SYNC_TIMEOUT_MS || 12_000,
);
const META_TEMPLATE_SYNC_TIMEOUT_MS = Number.isFinite(
  configuredMetaTemplateTimeoutMs,
)
  ? Math.max(3_000, Math.floor(configuredMetaTemplateTimeoutMs))
  : 12_000;
const CUSTOM_RECIPIENT_SAFE_VARIABLES = new Set([
  "store_name",
  "support_whatsapp_number",
]);
const CAMPAIGN_RUN_FATAL_FAILURE_CODES = new Set([
  "meta_payment_issue",
  "own_number_disconnected",
  "template_translation_missing",
  "template_parameter_count",
  "template_not_tested",
  "template_not_approved",
  "billing_or_limit_block",
  "whatsapp_account_locked",
]);

function getMetaGraphVersion() {
  return String(process.env.META_GRAPH_VERSION || "v25.0").trim() || "v25.0";
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function toObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function campaignPhoneKey(value) {
  const normalized = normalizePhoneE164(value) || String(value || "").trim();
  const digits = String(normalized || "").replace(/[^\d]/g, "");
  return digits ? `+${digits}` : "";
}

function normalizeTemplateName(value) {
  return normalizeMetaTemplateName(value || "");
}

function normalizeLanguageCode(value) {
  return normalizeTemplateLanguage(value) || String(value || "").trim() || "";
}

function copyTemplateTestState(target = {}, source = {}) {
  return {
    ...target,
    testMessageTargetPhoneE164:
      source?.testMessageTargetPhoneE164 ||
      target?.testMessageTargetPhoneE164 ||
      "",
    testMessageOutboundMessageId:
      source?.testMessageOutboundMessageId ||
      target?.testMessageOutboundMessageId ||
      null,
    testMessageSentAt:
      source?.testMessageSentAt || target?.testMessageSentAt || null,
    testMessageStatus:
      source?.testMessageStatus || target?.testMessageStatus || null,
    testMessageStatusAt:
      source?.testMessageStatusAt || target?.testMessageStatusAt || null,
    testMessageLastError:
      source?.testMessageLastError || target?.testMessageLastError || null,
    testMessageLastErrorAt:
      source?.testMessageLastErrorAt || target?.testMessageLastErrorAt || null,
  };
}

async function fetchAllMetaTemplates({ wabaId, accessToken }) {
  const firstUrl = new URL(
    `https://graph.facebook.com/${getMetaGraphVersion()}/${wabaId}/message_templates`,
  );
  firstUrl.searchParams.set(
    "fields",
    [
      "id",
      "name",
      "status",
      "language",
      "category",
      "components",
      "rejected_reason",
      "rejection_reason",
      "quality_score",
      "last_updated_time",
    ].join(","),
  );
  firstUrl.searchParams.set("limit", "200");

  const rows = [];
  let nextUrl = firstUrl.toString();
  let pageCount = 0;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    META_TEMPLATE_SYNC_TIMEOUT_MS,
  );

  try {
    while (nextUrl && pageCount < 20) {
      pageCount += 1;
      const res = await fetch(nextUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const error = new Error(
          data?.error?.message || "Failed to fetch Meta templates",
        );
        error.meta = data;
        error.httpStatus = res.status;
        throw error;
      }
      rows.push(...(Array.isArray(data?.data) ? data.data : []));
      nextUrl = String(data?.paging?.next || "").trim();
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("Meta template refresh timed out");
      timeoutError.code = "meta_template_sync_timeout";
      timeoutError.safeToRetry = true;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  return rows;
}

export async function syncCampaignTemplateCatalogForSend(
  record,
  { force = false } = {},
) {
  const sourceRecord = record && typeof record === "object" ? record : null;
  const shop = String(sourceRecord?.shop || "").trim();
  const own = sourceRecord?.whatsappSender?.ownNumber || {};
  const wabaId = String(own?.wabaId || "").trim();
  let accessToken = String(own?.accessToken || "").trim();
  let accessTokenExpiresAt = own?.accessTokenExpiresAt || null;

  if (!shop || !wabaId || !accessToken) {
    return sourceRecord;
  }
  if (
    !force &&
    isCampaignTemplateCatalogFresh(own, {
      maxAgeMs: CAMPAIGN_TEMPLATE_SYNC_CACHE_MS,
    })
  ) {
    return sourceRecord;
  }

  try {
    const refreshed = await maybeRefreshByonAccessToken({
      shop,
      ownNumber: own,
      force: false,
    });
    if (refreshed?.ok && refreshed.accessToken) {
      accessToken = String(refreshed.accessToken || "").trim() || accessToken;
      accessTokenExpiresAt =
        refreshed.accessTokenExpiresAt || accessTokenExpiresAt;
    }
  } catch {
    // Keep the stored token as the fallback path.
  }

  if (!accessToken || isMetaAccessTokenExpired(accessTokenExpiresAt)) {
    return sourceRecord;
  }

  const remoteTemplates = await fetchAllMetaTemplates({
    wabaId,
    accessToken,
  });
  const reusableRemoteTemplates = remoteTemplates.filter((row) =>
    ["UTILITY", "MARKETING"].includes(
      String(row?.category || "")
        .trim()
        .toUpperCase(),
    ),
  );
  const managedTemplates = mergeManagedTemplateStatusesWithMeta(
    upsertCorePackTemplatesIntoCatalog(own?.managedTemplates, own?.templates),
    remoteTemplates,
  );
  const campaignLibraryTemplates = syncCampaignLibraryTemplatesWithMeta(
    own?.campaignLibraryTemplates,
    reusableRemoteTemplates,
  );
  const now = new Date();

  await Shop.updateOne(
    { shop },
    {
      $set: {
        "whatsappSender.ownNumber.managedTemplates":
          ensureManagedTemplateCatalog(managedTemplates),
        "whatsappSender.ownNumber.managedTemplatesUpdatedAt": now,
        "whatsappSender.ownNumber.campaignLibraryTemplates":
          ensureManagedTemplateCatalog(campaignLibraryTemplates),
        "whatsappSender.ownNumber.campaignLibraryTemplatesUpdatedAt": now,
        ...(accessTokenExpiresAt
          ? {
              "whatsappSender.ownNumber.accessTokenExpiresAt":
                accessTokenExpiresAt,
            }
          : {}),
      },
    },
  );

  return {
    ...sourceRecord,
    whatsappSender: {
      ...(sourceRecord?.whatsappSender || {}),
      ownNumber: {
        ...own,
        accessToken,
        accessTokenExpiresAt,
        managedTemplates,
        managedTemplatesUpdatedAt: now,
        campaignLibraryTemplates,
        campaignLibraryTemplatesUpdatedAt: now,
      },
    },
  };
}

export function resolveCampaignSendTemplateFromShopRecord(
  record,
  templateInput,
) {
  const own = record?.whatsappSender?.ownNumber || {};
  const managedTemplates = upsertCorePackTemplatesIntoCatalog(
    own?.managedTemplates,
    own?.templates,
  );
  const campaignLibraryTemplates = ensureManagedTemplateCatalog(
    own?.campaignLibraryTemplates,
  ).filter((row) => String(row?.source || "").trim() === "meta_library");
  const allTemplates = [...managedTemplates, ...campaignLibraryTemplates];

  const templateId =
    typeof templateInput === "string"
      ? String(templateInput || "").trim()
      : String(templateInput?.id || "").trim();
  const templateMetaId =
    typeof templateInput === "object" && templateInput
      ? String(templateInput?.metaTemplateId || "").trim()
      : "";
  const templateName = normalizeTemplateName(
    typeof templateInput === "object" && templateInput
      ? templateInput?.metaTemplateName
      : "",
  );
  const templateLanguage = normalizeLanguageCode(
    typeof templateInput === "object" && templateInput
      ? templateInput?.language
      : "",
  );

  const baseTemplate =
    allTemplates.find((row) => String(row?.id || "").trim() === templateId) ||
    allTemplates.find(
      (row) =>
        templateMetaId &&
        String(row?.metaTemplateId || "").trim() === templateMetaId,
    ) ||
    allTemplates.find(
      (row) =>
        templateName &&
        normalizeTemplateName(row?.metaTemplateName) === templateName &&
        (!templateLanguage ||
          normalizeLanguageCode(row?.language) === templateLanguage),
    ) ||
    (templateInput && typeof templateInput === "object" ? templateInput : null);

  if (!baseTemplate) return null;

  return copyTemplateTestState(baseTemplate, templateInput);
}

function formatAmount(amount, currency) {
  const n = Number(amount);
  const c = String(currency || "").trim();
  if (!Number.isFinite(n) || !c) return "";
  return `${c} ${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function formatProducts(order) {
  const edges = Array.isArray(order?.lineItems?.edges)
    ? order.lineItems.edges
    : [];
  const items = edges
    .map((edge) => edge?.node)
    .filter(Boolean)
    .map((line) => {
      const title = String(line?.title || "").trim();
      const variant = String(line?.variantTitle || "").trim();
      const qty = Number(line?.quantity || 0);
      if (!title || !Number.isFinite(qty) || qty <= 0) return "";
      const variantLabel =
        variant && variant.toLowerCase() !== "default title"
          ? ` (${variant})`
          : "";
      return `${Math.trunc(qty)}x ${title}${variantLabel}`;
    })
    .filter(Boolean);
  return items.slice(0, 12).join(", ");
}

function firstProductName(order) {
  const line = order?.lineItems?.edges?.[0]?.node || null;
  return String(line?.title || "").trim();
}

function firstProductImageUrl(order) {
  const edges = Array.isArray(order?.lineItems?.edges)
    ? order.lineItems.edges
    : [];
  for (const edge of edges) {
    const line = edge?.node || {};
    const candidates = [
      line?.image?.url,
      line?.variant?.image?.url,
      line?.variant?.product?.featuredImage?.url,
      line?.variant?.product?.featuredMedia?.preview?.image?.url,
      line?.variant?.product?.images?.edges?.[0]?.node?.url,
      line?.product?.featuredImage?.url,
      line?.product?.featuredMedia?.preview?.image?.url,
      line?.product?.images?.edges?.[0]?.node?.url,
    ];
    const hit = candidates
      .map((candidate) => String(candidate || "").trim())
      .find((candidate) => /^https:\/\//i.test(candidate));
    if (hit) return hit;
  }
  return "";
}

function firstProductUrl(order, shopUrl = "") {
  const edges = Array.isArray(order?.lineItems?.edges)
    ? order.lineItems.edges
    : [];
  const normalizedShopUrl = String(shopUrl || "").replace(/\/+$/, "");
  for (const edge of edges) {
    const line = edge?.node || {};
    const direct = [
      line?.product?.onlineStoreUrl,
      line?.variant?.product?.onlineStoreUrl,
    ]
      .map((candidate) => String(candidate || "").trim())
      .find((candidate) => /^https?:\/\//i.test(candidate));
    if (direct) return direct;
    const handle = String(
      line?.product?.handle || line?.variant?.product?.handle || "",
    ).trim();
    if (handle && /^https?:\/\//i.test(normalizedShopUrl)) {
      return `${normalizedShopUrl}/products/${encodeURIComponent(handle)}`;
    }
  }
  return "";
}

function formatDeliveryAddress(address) {
  if (!address) return "";
  return [
    address.address1,
    address.address2,
    address.city,
    address.province,
    address.zip,
    address.country,
  ]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(", ");
}

function resolveCustomerName(order) {
  const customer = order?.customer || {};
  const shipping = order?.shippingAddress || {};
  const billing = order?.billingAddress || {};
  return (
    String(customer?.displayName || "").trim() ||
    [customer?.firstName, customer?.lastName]
      .filter(Boolean)
      .join(" ")
      .trim() ||
    [shipping?.firstName, shipping?.lastName]
      .filter(Boolean)
      .join(" ")
      .trim() ||
    String(shipping?.name || billing?.name || "Customer").trim() ||
    "Customer"
  );
}

function resolveOrderPhone(order) {
  const shipping = order?.shippingAddress || {};
  const billing = order?.billingAddress || {};
  const customer = order?.customer || {};
  const rawPhone =
    String(shipping?.phone || "").trim() ||
    String(billing?.phone || "").trim() ||
    String(customer?.phone || "").trim();
  const countryCode =
    String(shipping?.countryCode || "").trim() ||
    String(billing?.countryCode || "").trim() ||
    null;
  return normalizePhoneE164(rawPhone, countryCode) || "";
}

function firstFulfillmentTracking(order = {}) {
  const fulfillments = Array.isArray(order?.fulfillments?.edges)
    ? order.fulfillments.edges.map((edge) => edge?.node).filter(Boolean)
    : Array.isArray(order?.fulfillments)
      ? order.fulfillments
      : [];
  for (const fulfillment of fulfillments) {
    const infoRows = Array.isArray(fulfillment?.trackingInfo)
      ? fulfillment.trackingInfo
      : [];
    for (const row of infoRows) {
      const company = String(row?.company || "").trim();
      const number = String(row?.number || "").trim();
      const url = String(row?.url || "").trim();
      if (company || number || url) {
        return { company, number, url };
      }
    }
  }
  return { company: "", number: "", url: "" };
}

function templateSample(key, fallback = "") {
  return (
    String(TEMPLATE_VARIABLE_DEFINITIONS?.[key]?.sample || "").trim() ||
    String(fallback || "").trim()
  );
}

function buildOrderTemplateContext({ shop, own, fetched }) {
  const order = fetched?.order || {};
  const money = order?.currentTotalPriceSet?.shopMoney || {};
  const storeName =
    String(fetched?.shopName || "").trim() ||
    String(own?.businessName || "").trim() ||
    String(shop || "").replace(/\.myshopify\.com$/i, "") ||
    "Store";
  const productList = formatProducts(order);
  const productName = firstProductName(order) || productList || "Product";
  const productImageUrl = firstProductImageUrl(order);
  const productUrl =
    firstProductUrl(order, fetched?.shopUrl || "") ||
    String(fetched?.shopUrl || "").trim();
  const tracking = firstFulfillmentTracking(order);
  return buildTemplateContext({
    customer_name: resolveCustomerName(order),
    store_name: storeName,
    order_number:
      String(order?.name || "").trim() || templateSample("order_number", "Order"),
    product_name: productName,
    product_list:
      productList || productName || templateSample("product_list", "Product"),
    total_price:
      formatAmount(money?.amount, money?.currencyCode) ||
      templateSample("total_price", "Not available"),
    delivery_address:
      formatDeliveryAddress(order?.shippingAddress) ||
      templateSample("delivery_address", "Not available"),
    product_image_url: productImageUrl,
    product_url: productUrl || templateSample("product_url"),
    support_whatsapp_number:
      String(own?.displayPhoneNumber || "").trim() ||
      templateSample("support_whatsapp_number", "Not available"),
    courier_name:
      tracking.company || templateSample("courier_name", "Not available"),
    tracking_number:
      tracking.number || templateSample("tracking_number", "Not available"),
    tracking_url:
      tracking.url || templateSample("tracking_url", "Not available"),
    cancel_reason:
      templateSample("cancel_reason", "No reason provided"),
    update_title: templateSample("update_title", "Order update"),
    update_details: templateSample("update_details", "Status updated"),
    review_url:
      productUrl ||
      templateSample("review_url", "https://example.com/review/123"),
    checkout_url:
      String(fetched?.shopUrl || "").trim() ||
      templateSample("checkout_url", "https://example.com/checkouts/abc123"),
    abandoned_minutes: "0",
  });
}

function buildGenericTemplateContext({ shop, own }) {
  const storeName =
    String(own?.businessName || "").trim() ||
    String(shop || "").replace(/\.myshopify\.com$/i, "") ||
    "Store";
  return buildTemplateContext({
    store_name: storeName,
    support_whatsapp_number: String(own?.displayPhoneNumber || "").trim(),
  });
}

function extractTemplateVariableKeys(template = {}) {
  const values = [
    template?.headerText,
    template?.bodyText,
    ...toButtonUrls(template?.buttons),
  ]
    .map((value) => String(value || ""))
    .filter(Boolean);
  const keys = new Set();
  for (const value of values) {
    value.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, key) => {
      keys.add(
        String(key || "")
          .trim()
          .toLowerCase(),
      );
      return "";
    });
  }
  return Array.from(keys);
}

function toButtonUrls(buttons = []) {
  return Array.isArray(buttons)
    ? buttons
        .filter(
          (button) =>
            String(button?.type || "")
              .trim()
              .toUpperCase() === "URL",
        )
        .map((button) => button?.url)
    : [];
}

export function getOrderDependentTemplateVariables(template = {}) {
  return extractTemplateVariableKeys(template).filter(
    (key) => !CUSTOM_RECIPIENT_SAFE_VARIABLES.has(key),
  );
}

export function testSendPassed(template) {
  const status = String(template?.testMessageStatus || "")
    .trim()
    .toLowerCase();
  return (
    !!template?.testMessageSentAt &&
    !template?.testMessageLastError &&
    ["accepted", "sent", "delivered", "read"].includes(status || "accepted")
  );
}

export async function refreshCampaignRunSummary(runId) {
  const campaignRunId = String(runId || "").trim();
  if (!campaignRunId) return null;
  const rows = await CampaignRecipient.find({ campaignRunId }).lean();
  const existingRun = await CampaignRun.findById(campaignRunId).lean();
  if (!existingRun) return null;
  const update = buildCampaignRunSummary(existingRun, rows);
  await CampaignRun.updateOne({ _id: campaignRunId }, { $set: update });
  return CampaignRun.findById(campaignRunId).lean();
}

function serializeCampaignRecipient(row = {}) {
  const errorMeta = toObject(row?.errorMeta);
  const graphError = toObject(errorMeta?.error);
  return {
    id: String(row?._id || ""),
    campaignRunId: String(row?.campaignRunId || ""),
    recipientType: String(row?.recipientType || "order"),
    orderGid: row?.orderGid || null,
    orderName: String(row?.orderName || ""),
    customerName: String(row?.customerName || ""),
    phoneE164: String(row?.toE164 || ""),
    status: String(row?.status || "pending"),
    waMessageId: row?.waMessageId || null,
    sentAt: row?.sentAt || null,
    deliveryStatus:
      row?.deliveryStatus ||
      (String(row?.status || "") === "sent" ? "accepted" : null),
    deliveryStatusAt: row?.deliveryStatusAt || null,
    deliveredAt: row?.deliveredAt || null,
    readAt: row?.readAt || null,
    deliveryError: row?.deliveryError || null,
    lastTriedAt: row?.lastTriedAt || null,
    retryCount: Number(row?.retryCount || 0),
    failureCode: row?.failureCode || null,
    failureReason: row?.failureReason || null,
    failureRetryable: row?.failureRetryable === true,
    errorMessage: row?.errorMessage || null,
    errorMeta: row?.errorMeta || null,
    metaErrorCode: graphError?.code || null,
    metaErrorDetails: String(graphError?.error_data?.details || "").trim() || null,
    duplicateOfRecipientId: row?.duplicateOfRecipientId
      ? String(row.duplicateOfRecipientId)
      : null,
    canRetry: ["failed"].includes(String(row?.status || "")),
    createdAt: row?.createdAt || null,
    updatedAt: row?.updatedAt || null,
  };
}

function serializeCampaignRun(run = {}, recipients = []) {
  const summary = recipients.length
    ? buildCampaignRunSummary(run, recipients)
    : {
        sentCount: Number(run?.sentCount || 0),
        deliveredCount: Number(run?.deliveredCount || 0),
        readCount: Number(run?.readCount || 0),
        failedCount: Number(run?.failedCount || 0),
        skippedCount: Number(run?.skippedCount || 0),
        pendingCount: Number(run?.pendingCount || 0),
        successRate: Number(run?.successRate || 0),
        deliveryRate: Number(run?.deliveryRate || 0),
        failureRate: Number(run?.failureRate || 0),
      };
  return {
    id: String(run?._id || ""),
    status: String(run?.status || "scheduled"),
    scheduleMode: String(run?.scheduleMode || "immediate"),
    scheduledFor: run?.scheduledFor || null,
    startedAt: run?.startedAt || null,
    completedAt: run?.completedAt || null,
    templateId: String(run?.templateId || ""),
    templateDisplayName: String(run?.templateDisplayName || ""),
    templateMetaTemplateName: String(run?.templateMetaTemplateName || ""),
    templateLanguage: String(run?.templateLanguage || "en"),
    templateCategory: String(run?.templateCategory || "UTILITY"),
    templateSource: String(run?.templateSource || "merchant_custom"),
    templateSnapshot: run?.templateSnapshot || null,
    totalRecipients: Number(run?.totalRecipients || 0),
    orderRecipientCount: Number(run?.orderRecipientCount || 0),
    customRecipientCount: Number(run?.customRecipientCount || 0),
    sentCount: Number(summary.sentCount || 0),
    deliveredCount: Number(summary.deliveredCount || 0),
    readCount: Number(summary.readCount || 0),
    failedCount: Number(summary.failedCount || 0),
    skippedCount: Number(summary.skippedCount || 0),
    pendingCount: Number(summary.pendingCount || 0),
    successRate: Number(summary.successRate || 0),
    deliveryRate: Number(summary.deliveryRate || 0),
    failureRate: Number(summary.failureRate || 0),
    lastError: run?.lastError || null,
    lastErrorAt: run?.lastErrorAt || null,
    createdAt: run?.createdAt || null,
    updatedAt: run?.updatedAt || null,
    recipients: recipients.map(serializeCampaignRecipient),
  };
}

function findSentRecipientByPhone(rows, toE164, ignoreRecipientId = "") {
  const phoneKey = campaignPhoneKey(toE164);
  if (!phoneKey) return null;
  return rows.find(
    (row) =>
      String(row?.status || "") === "sent" &&
      campaignPhoneKey(row?.toE164) === phoneKey &&
      String(row?._id || "") !== String(ignoreRecipientId || ""),
  );
}

async function buildRunRecipients({
  shop,
  orderGids,
  customRecipients,
}) {
  const recipients = [];
  const seenPhones = new Map();

  for (const orderGid of orderGids.slice(0, MAX_RECIPIENTS_PER_RUN)) {
    const recipient = {
      shop,
      recipientType: "order",
      orderGid,
      orderName: "",
      customerName: "",
      toE164: "",
      status: "pending",
      duplicateOfRecipientId: null,
      failureCode: null,
      failureReason: null,
      errorMessage: null,
      errorMeta: null,
    };
    recipients.push(recipient);
  }

  for (const to of customRecipients.slice(
    0,
    MAX_RECIPIENTS_PER_RUN - recipients.length,
  )) {
    const toE164 = normalizePhoneE164(to) || String(to || "").trim();
    const phoneKey = campaignPhoneKey(toE164);
    const isDuplicate = Boolean(phoneKey && seenPhones.has(phoneKey));
    const recipient = {
      shop,
      recipientType: "custom",
      orderGid: null,
      orderName: "Custom recipient",
      customerName: "",
      toE164,
      status: isDuplicate ? "skipped" : "pending",
      duplicateOfRecipientId: null,
      failureCode: isDuplicate ? "duplicate_phone_in_campaign" : null,
      failureReason: isDuplicate
        ? "Same number was already selected earlier in this campaign."
        : null,
      errorMessage: null,
      errorMeta: isDuplicate ? { toE164, phoneKey } : null,
    };
    recipients.push(recipient);
    if (phoneKey && !isDuplicate) {
      seenPhones.set(phoneKey, true);
    }
  }

  return recipients;
}

async function patchDuplicateRecipientReferences(campaignRunId) {
  const rows = await CampaignRecipient.find({ campaignRunId })
    .sort({ createdAt: 1 })
    .lean();
  const primaryByPhoneKey = new Map();
  for (const row of rows) {
    const phoneKey = campaignPhoneKey(row?.toE164);
    if (!phoneKey || primaryByPhoneKey.has(phoneKey)) continue;
    if (
      String(row?.status || "") === "skipped" &&
      String(row?.failureCode || "") === "duplicate_phone_in_campaign"
    ) {
      continue;
    }
    primaryByPhoneKey.set(phoneKey, String(row?._id || ""));
  }
  for (const row of rows) {
    if (String(row?.status || "") !== "skipped") continue;
    if (String(row?.failureCode || "") !== "duplicate_phone_in_campaign")
      continue;
    const phoneKey = campaignPhoneKey(row?.toE164);
    const firstId = primaryByPhoneKey.get(phoneKey) || null;
    if (!firstId || firstId === String(row?._id || "")) continue;
    await CampaignRecipient.updateOne(
      { _id: row._id },
      { $set: { duplicateOfRecipientId: firstId } },
    );
  }
}

export async function createCampaignRun({
  shop,
  template,
  orderGids = [],
  customRecipients = [],
  scheduleMode = "immediate",
  scheduledFor = null,
}) {
  const cleanScheduleMode =
    String(scheduleMode || "immediate") === "scheduled"
      ? "scheduled"
      : "immediate";
  const safeScheduledFor = scheduledFor ? new Date(scheduledFor) : null;
  const recipientRows = await buildRunRecipients({
    shop,
    orderGids,
    customRecipients,
  });
  const run = await CampaignRun.create({
    shop,
    status: cleanScheduleMode === "scheduled" ? "scheduled" : "processing",
    scheduleMode: cleanScheduleMode,
    scheduledFor: cleanScheduleMode === "scheduled" ? safeScheduledFor : null,
    templateId: String(template?.id || ""),
    templateDisplayName: String(template?.displayName || ""),
    templateMetaTemplateName: String(template?.metaTemplateName || ""),
    templateLanguage: String(template?.language || "en"),
    templateCategory: String(template?.category || "UTILITY"),
    templateSource: String(template?.source || "merchant_custom"),
    templateSnapshot: serializeTemplateForClient(template),
    totalRecipients: recipientRows.length,
    orderRecipientCount: recipientRows.filter(
      (row) => row.recipientType === "order",
    ).length,
    customRecipientCount: recipientRows.filter(
      (row) => row.recipientType === "custom",
    ).length,
    skippedCount: recipientRows.filter((row) => row.status === "skipped")
      .length,
    pendingCount: recipientRows.filter((row) => row.status === "pending")
      .length,
  });
  const recipients = await CampaignRecipient.insertMany(
    recipientRows.map((row) => ({ ...row, campaignRunId: run._id })),
  );
  await patchDuplicateRecipientReferences(run._id);
  const refreshedRun = await refreshCampaignRunSummary(run._id);
  return {
    run: refreshedRun,
    recipients: recipients.map((row) => row.toObject()),
  };
}

export async function queueScheduledCampaignRun(runId, scheduledFor) {
  const when =
    scheduledFor instanceof Date ? scheduledFor : new Date(scheduledFor);
  await agenda.schedule(when, "send_campaign_run", {
    runId: String(runId || "").trim(),
  });
}

export async function queueImmediateCampaignRun(runId) {
  await agenda.now("send_campaign_run", {
    runId: String(runId || "").trim(),
  });
}

export async function failCampaignRun(runId, error) {
  const campaignRunId = String(runId || "").trim();
  if (!campaignRunId) return null;
  const failure = classifyCampaignSendFailure(error);
  const now = new Date();
  await CampaignRecipient.updateMany(
    {
      campaignRunId,
      status: { $in: ["pending", "processing"] },
    },
    {
      $set: {
        status: "failed",
        lastTriedAt: now,
        failureCode: failure.code,
        failureReason: failure.label,
        failureRetryable: failure.retryable,
        errorMessage: failure.message,
        errorMeta: failure.meta,
      },
      $inc: { retryCount: 1 },
    },
  );
  await CampaignRun.updateOne(
    { _id: campaignRunId },
    {
      $set: {
        lastError: failure.message,
        lastErrorAt: now,
      },
    },
  );
  return refreshCampaignRunSummary(campaignRunId);
}

async function fetchOrderContext({ shop, record, recipient, getOrderAdmin }) {
  if (!recipient?.orderGid) {
    return {
      toE164: String(recipient?.toE164 || "").trim(),
      context: buildGenericTemplateContext({
        shop,
        own: record?.whatsappSender?.ownNumber || {},
      }),
      orderName: String(recipient?.orderName || "Custom recipient").trim(),
      customerName: String(recipient?.customerName || "").trim(),
    };
  }
  const admin = await getOrderAdmin();
  const fetched = await fetchOrderForCodConfirmTemplate(
    admin,
    recipient.orderGid,
  );
  const order = fetched?.order || null;
  if (!order?.id) throw new Error("Order not found");
  const toE164 = resolveOrderPhone(order);
  return {
    toE164,
    context: buildOrderTemplateContext({
      shop,
      own: record?.whatsappSender?.ownNumber || {},
      fetched,
    }),
    orderName: String(order?.name || recipient?.orderName || "").trim(),
    customerName: resolveCustomerName(order),
  };
}

export async function processCampaignRun({ runId, recipientIds = null }) {
  const campaignRunId = String(runId || "").trim();
  if (!campaignRunId) throw new Error("Missing campaign run id");
  const run = await CampaignRun.findById(campaignRunId).lean();
  if (!run) throw new Error("Campaign run not found");
  const record = await Shop.findOne({ shop: run.shop }).lean();
  if (!record) throw new Error("Shop not installed");
  const syncedRecord = await syncCampaignTemplateCatalogForSend(record).catch(
    () => record,
  );
  const plan = getPlan(syncedRecord?.billing?.planKey);
  if (String(plan?.senderMode || "").trim() !== SENDER_MODES.OWN_NUMBER) {
    throw new Error("Campaign sending requires a Your Own Number plan");
  }

  const template = resolveCampaignSendTemplateFromShopRecord(
    syncedRecord,
    run?.templateSnapshot || null,
  );
  if (!template || !String(template?.metaTemplateName || "").trim()) {
    throw new Error("Campaign run is missing its template snapshot");
  }
  if (String(template?.status || "").trim() === "missing") {
    throw new Error(
      "This template no longer exists in the connected Meta account. Refresh from Meta and choose a live approved template.",
    );
  }
  if (!isTemplateApproved(template)) {
    throw new Error("Only approved templates can be used in campaigns");
  }
  if (!testSendPassed(template)) {
    throw new Error("Kindly test send the template first");
  }

  const own = syncedRecord?.whatsappSender?.ownNumber || {};
  const senderPhoneNumberId = String(own?.phoneNumberId || "").trim();
  if (!senderPhoneNumberId) {
    throw new Error("Connect Your Own Number before sending campaign messages");
  }

  let orderAdminPromise = null;
  const getOrderAdmin = () => {
    if (!orderAdminPromise) {
      orderAdminPromise = getAdminClient(run.shop, {
        accessToken: syncedRecord?.accessToken || "",
        record: syncedRecord,
      }).catch((error) => {
        orderAdminPromise = null;
        throw error;
      });
    }
    return orderAdminPromise;
  };

  const query = {
    campaignRunId,
    status: "pending",
  };
  if (Array.isArray(recipientIds) && recipientIds.length) {
    query._id = {
      $in: recipientIds.map((row) => String(row || "").trim()).filter(Boolean),
    };
  }

  const recipients = await CampaignRecipient.find(query).sort({ createdAt: 1 });
  if (!recipients.length) {
    const refreshedRun = await refreshCampaignRunSummary(campaignRunId);
    const refreshedRecipients = await CampaignRecipient.find({ campaignRunId })
      .sort({ createdAt: 1 })
      .lean();
    return {
      run: serializeCampaignRun(refreshedRun || run, refreshedRecipients),
    };
  }
  await CampaignRun.updateOne(
    { _id: campaignRunId },
    {
      $set: {
        status: "processing",
        startedAt: run.startedAt || new Date(),
        lastError: null,
      },
    },
  );

  const allRows = await CampaignRecipient.find({ campaignRunId }).sort({
    createdAt: 1,
  });
  for (const recipient of recipients) {
    const now = new Date();
    const claimedRecipient = await CampaignRecipient.findOneAndUpdate(
      {
        _id: recipient._id,
        campaignRunId,
        status: "pending",
      },
      { $set: { status: "processing", lastTriedAt: now } },
      { returnDocument: "after" },
    );
    if (!claimedRecipient) continue;
    let sentAccepted = false;
    let acceptedSentFields = null;
    try {
      const resolved = await runCampaignOperationWithRetry(
        () =>
          fetchOrderContext({
            shop: run.shop,
            record: syncedRecord,
            recipient: claimedRecipient,
            getOrderAdmin,
          }),
        {
          stage: "context",
          maxAttempts: CAMPAIGN_TRANSIENT_ATTEMPTS,
          onRetry: ({ attempt, nextAttempt, delayMs }) => {
            console.warn("[campaign_context_retry]", {
              shop: run.shop,
              campaignRunId: String(campaignRunId),
              campaignRecipientId: String(claimedRecipient._id),
              attempt,
              nextAttempt,
              delayMs,
            });
          },
        },
      );
      const toE164 = String(resolved?.toE164 || "").trim();
      const toPhoneKey = campaignPhoneKey(toE164);
      if (!toE164 || !toPhoneKey) {
        throw new Error("Order has no valid WhatsApp phone number");
      }

      const alreadySentRow = findSentRecipientByPhone(
        allRows,
        toE164,
        claimedRecipient._id,
      );
      if (alreadySentRow) {
        await CampaignRecipient.updateOne(
          { _id: claimedRecipient._id },
          {
            $set: {
              toE164,
              orderName: resolved.orderName || claimedRecipient.orderName,
              customerName:
                resolved.customerName || claimedRecipient.customerName,
              status: "skipped",
              duplicateOfRecipientId: alreadySentRow._id,
              failureCode: "duplicate_phone_in_campaign",
              failureReason:
                "Same number already received this campaign successfully.",
              errorMessage: null,
              errorMeta: { toE164, phoneKey: toPhoneKey },
            },
          },
        );
        const current = allRows.find(
          (row) => String(row._id) === String(claimedRecipient._id),
        );
        if (current) {
          current.status = "skipped";
          current.toE164 = toE164;
          current.duplicateOfRecipientId = alreadySentRow._id;
        }
        continue;
      }

      const phoneClaim = await claimCampaignPhone({
        campaignRunId,
        recipientId: claimedRecipient._id,
        phoneKey: toPhoneKey,
      });
      if (!phoneClaim.owned) {
        await CampaignRecipient.updateOne(
          { _id: claimedRecipient._id },
          {
            $set: {
              toE164,
              orderName: resolved.orderName || claimedRecipient.orderName,
              customerName:
                resolved.customerName || claimedRecipient.customerName,
              status: "skipped",
              duplicateOfRecipientId: phoneClaim.ownerRecipientId || null,
              failureCode: "duplicate_phone_in_campaign",
              failureReason:
                "Same number is already assigned to another recipient in this campaign.",
              failureRetryable: false,
              errorMessage: null,
              errorMeta: { toE164, phoneKey: toPhoneKey },
            },
          },
        );
        const current = allRows.find(
          (row) => String(row._id) === String(claimedRecipient._id),
        );
        if (current) {
          current.status = "skipped";
          current.toE164 = toE164;
          current.duplicateOfRecipientId =
            phoneClaim.ownerRecipientId || null;
        }
        continue;
      }

      const gate = await canSendWhatsApp(run.shop, {
        toE164,
        senderPhoneNumberId,
        isTemplate: true,
      });
      if (!gate?.ok) {
        throw new Error(
          gate?.reason || "Sending is not allowed on the current plan",
        );
      }

      const sent = await runCampaignOperationWithRetry(
        () =>
          sendManagedTemplateDirect({
            to: toE164,
            managedTemplate: template,
            context: resolved.context,
            shop: run.shop,
            orderGid: claimedRecipient.orderGid || null,
            kind:
              claimedRecipient.recipientType === "custom"
                ? "campaign_template_send_custom_recipient"
                : "campaign_template_send",
            meta: {
              source:
                claimedRecipient.recipientType === "custom"
                  ? "campaign_send_custom_recipient"
                  : "campaign_send",
              templateId: template.id,
              flowKey: template.flowKey,
              campaignTemplate: true,
              campaignRunId: String(campaignRunId),
              campaignRecipientId: String(claimedRecipient._id),
              customRecipient: claimedRecipient.recipientType === "custom",
            },
            suppressDebugLogging: true,
          }),
        {
          stage: "dispatch",
          maxAttempts: CAMPAIGN_TRANSIENT_ATTEMPTS,
          onRetry: ({ attempt, nextAttempt, delayMs }) => {
            console.warn("[campaign_send_retry]", {
              shop: run.shop,
              campaignRunId: String(campaignRunId),
              campaignRecipientId: String(claimedRecipient._id),
              attempt,
              nextAttempt,
              delayMs,
            });
          },
        },
      );

      const waMessageId =
        String(sent?.data?.messages?.[0]?.id || "").trim() || null;
      const sentFields = {
        toE164,
        orderName: resolved.orderName || claimedRecipient.orderName,
        customerName: resolved.customerName || claimedRecipient.customerName,
        status: "sent",
        waMessageId,
        sentAt: new Date(),
        deliveryStatus: "accepted",
        deliveryStatusAt: new Date(),
        deliveredAt: null,
        readAt: null,
        deliveryError: null,
        deliveryErrorMeta: null,
        failureCode: null,
        failureReason: null,
        failureRetryable: false,
        errorMessage: null,
        errorMeta: null,
      };
      sentAccepted = true;
      acceptedSentFields = sentFields;
      const current = allRows.find(
        (row) => String(row._id) === String(claimedRecipient._id),
      );
      if (current) {
        Object.assign(current, sentFields);
      }
      await CampaignRecipient.updateOne(
        { _id: claimedRecipient._id },
        { $set: sentFields },
      );
      if (waMessageId) {
        await reconcileCampaignDeliveryFromLog({
          shop: run.shop,
          waMessageId,
        }).catch((deliveryError) => {
          console.warn("[campaign_delivery_reconcile_after_send]", {
            shop: run.shop,
            campaignRunId: String(campaignRunId),
            campaignRecipientId: String(claimedRecipient._id),
            error: deliveryError?.message || String(deliveryError || ""),
          });
        });
      }
      await incrementWhatsAppUsage(run.shop, 1, {
        isTemplate: true,
        toE164,
        countInitiatedConversation: true,
        senderPhoneNumberId,
      }).catch((usageError) => {
        console.warn("[campaignRuns] usage increment failed after send", {
          shop: run.shop,
          campaignRunId: String(campaignRunId),
          campaignRecipientId: String(claimedRecipient._id),
          error: usageError?.message || String(usageError || ""),
        });
      });
    } catch (error) {
      if (sentAccepted) {
        if (acceptedSentFields) {
          const current = allRows.find(
            (row) => String(row._id) === String(claimedRecipient._id),
          );
          if (current) {
            Object.assign(current, acceptedSentFields);
          }
          await CampaignRecipient.updateOne(
            { _id: claimedRecipient._id },
            { $set: acceptedSentFields },
          ).catch((updateError) => {
            console.warn("[campaignRuns] sent recipient update failed", {
              shop: run.shop,
              campaignRunId: String(campaignRunId),
              campaignRecipientId: String(claimedRecipient._id),
              error: updateError?.message || String(updateError || ""),
            });
          });
        }
        continue;
      }
      const failure = classifyCampaignSendFailure(error);
      await CampaignRecipient.updateOne(
        { _id: claimedRecipient._id },
        {
          $set: {
            status: "failed",
            failureCode: failure.code,
            failureReason: failure.label,
            failureRetryable: failure.retryable,
            errorMessage: failure.message,
            errorMeta: failure.meta,
          },
          $inc: { retryCount: 1 },
        },
      );
      const current = allRows.find(
        (row) => String(row._id) === String(claimedRecipient._id),
      );
      if (current) {
        current.status = "failed";
        current.failureCode = failure.code;
        current.failureReason = failure.label;
        current.failureRetryable = failure.retryable;
        current.errorMessage = failure.message;
        current.errorMeta = failure.meta;
      }
      await CampaignRun.updateOne(
        { _id: campaignRunId },
        {
          $set: {
            lastError: failure.message,
            lastErrorAt: new Date(),
          },
        },
      );
      if (CAMPAIGN_RUN_FATAL_FAILURE_CODES.has(failure.code)) {
        await CampaignRecipient.updateMany(
          {
            campaignRunId,
            status: "pending",
          },
          {
            $set: {
              status: "failed",
              lastTriedAt: new Date(),
              failureCode: failure.code,
              failureReason: failure.label,
              failureRetryable: failure.retryable,
              errorMessage: failure.message,
              errorMeta: failure.meta,
            },
            $inc: { retryCount: 1 },
          },
        );
        break;
      }
    }
  }

  const refreshedRun = await refreshCampaignRunSummary(campaignRunId);
  const refreshedRecipients = await CampaignRecipient.find({ campaignRunId })
    .sort({ createdAt: 1 })
    .lean();
  return {
    run: serializeCampaignRun(refreshedRun, refreshedRecipients),
  };
}

export async function listCampaignRuns(shop, limit = MAX_CAMPAIGN_RUNS) {
  const shopDomain = String(shop || "").trim();
  const safeLimit = Math.max(
    1,
    Math.min(Number(limit || MAX_CAMPAIGN_RUNS), 50),
  );
  const runs = await CampaignRun.find({ shop: shopDomain })
    .sort({ createdAt: -1 })
    .limit(safeLimit)
    .lean();
  const runIds = runs.map((run) => run._id);
  const recipients = runIds.length
    ? await CampaignRecipient.find({ campaignRunId: { $in: runIds } })
        .sort({ createdAt: 1 })
        .lean()
    : [];
  const grouped = new Map();
  for (const recipient of recipients) {
    const key = String(recipient?.campaignRunId || "");
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(recipient);
  }
  const serializedRuns = runs.map((run) =>
    serializeCampaignRun(run, grouped.get(String(run._id)) || []),
  );
  const totals = serializedRuns.reduce(
    (acc, run) => {
      acc.campaignCount += 1;
      acc.sentCount += Number(run.sentCount || 0);
      acc.deliveredCount += Number(run.deliveredCount || 0);
      acc.readCount += Number(run.readCount || 0);
      acc.failedCount += Number(run.failedCount || 0);
      acc.scheduledCount += ["scheduled", "processing"].includes(run.status)
        ? 1
        : 0;
      acc.totalRecipients += Number(run.totalRecipients || 0);
      return acc;
    },
    {
      campaignCount: 0,
      sentCount: 0,
      deliveredCount: 0,
      readCount: 0,
      failedCount: 0,
      scheduledCount: 0,
      totalRecipients: 0,
    },
  );
  return {
    runs: serializedRuns,
    summary: {
      ...totals,
      successRate: calculateCampaignPercent(
        totals.sentCount,
        totals.totalRecipients,
      ),
      deliveryRate: calculateCampaignPercent(
        totals.deliveredCount,
        totals.sentCount,
      ),
      failureRate: calculateCampaignPercent(
        totals.failedCount,
        totals.totalRecipients,
      ),
    },
  };
}

export async function retryCampaignRecipient({ shop, runId, recipientId }) {
  const run = await CampaignRun.findOne({ _id: runId, shop }).lean();
  if (!run) throw new Error("Campaign run not found");
  const recipient = await CampaignRecipient.findOne({
    _id: recipientId,
    campaignRunId: runId,
    shop,
  }).lean();
  if (!recipient) throw new Error("Campaign recipient not found");
  if (String(recipient?.status || "") === "sent") {
    throw new Error(
      "This recipient already received the campaign successfully",
    );
  }
  await CampaignRecipient.updateOne(
    { _id: recipientId },
    {
      $set: {
        status: "pending",
        failureCode: null,
        failureReason: null,
        failureRetryable: false,
        errorMessage: null,
        errorMeta: null,
        deliveryStatus: null,
        deliveryStatusAt: null,
        deliveredAt: null,
        readAt: null,
        deliveryError: null,
        deliveryErrorMeta: null,
        waMessageId: null,
        sentAt: null,
      },
    },
  );
  return processCampaignRun({ runId, recipientIds: [recipientId] });
}
