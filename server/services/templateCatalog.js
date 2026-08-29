import crypto from "crypto";
import {
  fitTemplateParameterValues,
  sanitizeTemplateParameterValue,
} from "./campaignSendPolicy.js";

export const TEMPLATE_CATEGORY_UTILITY = "UTILITY";
export const TEMPLATE_CATEGORY_MARKETING = "MARKETING";
export const TEMPLATE_LANGUAGE_EN = "en";

export const TEMPLATE_LANGUAGE_OPTIONS = [
  { code: "af", label: "Afrikaans" },
  { code: "sq", label: "Albanian" },
  { code: "ar", label: "Arabic" },
  { code: "az", label: "Azerbaijani" },
  { code: "bn", label: "Bengali" },
  { code: "bg", label: "Bulgarian" },
  { code: "ca", label: "Catalan" },
  { code: "zh_CN", label: "Chinese (China)" },
  { code: "zh_HK", label: "Chinese (Hong Kong)" },
  { code: "zh_TW", label: "Chinese (Taiwan)" },
  { code: "hr", label: "Croatian" },
  { code: "cs", label: "Czech" },
  { code: "da", label: "Danish" },
  { code: "nl", label: "Dutch" },
  { code: "en", label: "English" },
  { code: "en_GB", label: "English (UK)" },
  { code: "en_US", label: "English (US)" },
  { code: "et", label: "Estonian" },
  { code: "fil", label: "Filipino" },
  { code: "fi", label: "Finnish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "el", label: "Greek" },
  { code: "gu", label: "Gujarati" },
  { code: "he", label: "Hebrew" },
  { code: "hi", label: "Hindi" },
  { code: "hu", label: "Hungarian" },
  { code: "id", label: "Indonesian" },
  { code: "ga", label: "Irish" },
  { code: "it", label: "Italian" },
  { code: "ja", label: "Japanese" },
  { code: "kn", label: "Kannada" },
  { code: "kk", label: "Kazakh" },
  { code: "ko", label: "Korean" },
  { code: "lo", label: "Lao" },
  { code: "lv", label: "Latvian" },
  { code: "lt", label: "Lithuanian" },
  { code: "mk", label: "Macedonian" },
  { code: "ms", label: "Malay" },
  { code: "ml", label: "Malayalam" },
  { code: "mr", label: "Marathi" },
  { code: "nb", label: "Norwegian Bokmal" },
  { code: "fa", label: "Persian" },
  { code: "pl", label: "Polish" },
  { code: "pt_BR", label: "Portuguese (Brazil)" },
  { code: "pt_PT", label: "Portuguese (Portugal)" },
  { code: "pa", label: "Punjabi" },
  { code: "ro", label: "Romanian" },
  { code: "ru", label: "Russian" },
  { code: "sr", label: "Serbian" },
  { code: "sk", label: "Slovak" },
  { code: "sl", label: "Slovenian" },
  { code: "es", label: "Spanish" },
  { code: "es_AR", label: "Spanish (Argentina)" },
  { code: "es_ES", label: "Spanish (Spain)" },
  { code: "es_MX", label: "Spanish (Mexico)" },
  { code: "sw", label: "Swahili" },
  { code: "sv", label: "Swedish" },
  { code: "ta", label: "Tamil" },
  { code: "te", label: "Telugu" },
  { code: "th", label: "Thai" },
  { code: "tr", label: "Turkish" },
  { code: "uk", label: "Ukrainian" },
  { code: "ur", label: "Urdu" },
  { code: "uz", label: "Uzbek" },
  { code: "vi", label: "Vietnamese" },
  { code: "zu", label: "Zulu" },
];

const TEMPLATE_LANGUAGE_CODE_SET = new Set(
  TEMPLATE_LANGUAGE_OPTIONS.map((row) => row.code),
);

const HEADER_TYPES = new Set(["NONE", "TEXT", "IMAGE"]);
const TEMPLATE_CATEGORIES = new Set([
  TEMPLATE_CATEGORY_UTILITY,
  TEMPLATE_CATEGORY_MARKETING,
]);

export const FLOW_KEYS = {
  ORDER_CONFIRMATION: "order_confirmation",
  ORDER_CHANGE_REQUEST: "order_change_request",
  ORDER_DISPATCHED: "order_dispatched",
  TRACKING_UPDATED: "tracking_updated",
  ORDER_CANCELLED: "order_cancelled",
  ORDER_UPDATE_GENERIC: "order_update_generic",
  REVIEW_REQUEST: "review_request",
  ABANDONED_CART: "abandoned_cart_recovery",
  CAMPAIGN: "campaign",
};

export const LEGACY_TEMPLATE_KEY_BY_FLOW = {
  [FLOW_KEYS.ORDER_CONFIRMATION]: "cod_confirm_new",
  [FLOW_KEYS.ORDER_DISPATCHED]: "cod_order_dispatched",
  [FLOW_KEYS.TRACKING_UPDATED]: "cod_tracking_updated",
  [FLOW_KEYS.ORDER_CANCELLED]: "cod_order_cancelled",
  [FLOW_KEYS.ORDER_UPDATE_GENERIC]: "cod_order_update_generic",
};

export const FLOW_KEY_BY_LEGACY_TEMPLATE = Object.fromEntries(
  Object.entries(LEGACY_TEMPLATE_KEY_BY_FLOW).map(([flowKey, legacyKey]) => [
    legacyKey,
    flowKey,
  ]),
);

export const TEMPLATE_VARIABLE_DEFINITIONS = {
  customer_name: {
    key: "customer_name",
    label: "Customer name",
    sample: "Abdul",
    description: "The customer or recipient full name.",
  },
  store_name: {
    key: "store_name",
    label: "Store name",
    sample: "OrderX Store",
    description: "The connected Shopify store name.",
  },
  order_number: {
    key: "order_number",
    label: "Order number",
    sample: "#10321",
    description: "The Shopify order number.",
  },
  product_name: {
    key: "product_name",
    label: "Product name",
    sample: "Classic T-Shirt",
    description: "A primary product title for the order/cart.",
  },
  product_url: {
    key: "product_url",
    label: "Product URL",
    sample: "https://example.com/products/classic-t-shirt",
    description: "The first product page URL for campaign messages.",
  },
  product_list: {
    key: "product_list",
    label: "Product list",
    sample: "2x T-shirt, 1x Shoes",
    description: "A compact list of line items.",
  },
  // product_image_url: {
  //   key: "product_image_url",
  //   label: "Product image",
  //   sample: "https://cdn.shopify.com/s/files/1/0000/products/sample.jpg",
  //   description: "First product image URL, used for image headers when enabled.",
  // },
  total_price: {
    key: "total_price",
    label: "Total price",
    sample: "PKR 3,250",
    description: "The order/cart total.",
  },
  delivery_address: {
    key: "delivery_address",
    label: "Delivery address",
    sample: "123 Main Street, Lahore",
    description: "The shipping address text.",
  },
  courier_name: {
    key: "courier_name",
    label: "Courier name",
    sample: "Leopards",
    description: "Courier/service provider name.",
  },
  tracking_number: {
    key: "tracking_number",
    label: "Tracking number",
    sample: "LP123456789",
    description: "The shipment tracking number.",
  },
  tracking_url: {
    key: "tracking_url",
    label: "Tracking URL",
    sample: "https://track.example/LP123456789",
    description: "A direct parcel tracking link.",
  },
  cancel_reason: {
    key: "cancel_reason",
    label: "Cancel reason",
    sample: "Customer requested cancellation",
    description: "The cancellation reason text.",
  },
  update_title: {
    key: "update_title",
    label: "Update title",
    sample: "Delivery delayed",
    description: "Short order-update headline.",
  },
  update_details: {
    key: "update_details",
    label: "Update details",
    sample: "Your parcel is delayed due to weather conditions.",
    description: "Detailed update message.",
  },
  support_whatsapp_number: {
    key: "support_whatsapp_number",
    label: "Support WhatsApp",
    sample: "+923001234567",
    description: "Merchant support WhatsApp number.",
  },
  review_url: {
    key: "review_url",
    label: "Review URL",
    sample: "https://example.com/review/123",
    description: "The merchant review destination URL.",
  },
  checkout_url: {
    key: "checkout_url",
    label: "Checkout URL",
    sample: "https://store.myshopify.com/checkouts/abc123",
    description: "The abandoned-cart recovery checkout URL.",
  },
  abandoned_minutes: {
    key: "abandoned_minutes",
    label: "Minutes abandoned",
    sample: "90",
    description: "How long the cart has been abandoned.",
  },
};

function flowButtons(buttons = []) {
  return (Array.isArray(buttons) ? buttons : []).map((button, index) => ({
    id: `${String(button?.text || "button")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")}_${index}`,
    type: String(button?.type || "QUICK_REPLY")
      .trim()
      .toUpperCase(),
    text: String(button?.text || "").trim(),
    index,
    action: button?.action || null,
    allowedTypes: Array.isArray(button?.allowedTypes)
      ? button.allowedTypes
      : ["QUICK_REPLY"],
  }));
}

export const FLOW_DEFINITIONS = {
  [FLOW_KEYS.ORDER_CONFIRMATION]: {
    key: FLOW_KEYS.ORDER_CONFIRMATION,
    label: "Order Confirmation",
    description:
      "Confirmation request sent for COD orders. Quick-reply buttons can be kept or removed per template.",
    supportsTemplates: true,
    legacyTemplateKey: "cod_confirm_new",
    defaultMetaTemplateName: "orderx_cod_confirm_new",
    templateNameBase: "orderx_order_confirmation",
    defaultStatusTone: "primary",
    supportsImageHeader: true,
    supportedVariables: [
      "customer_name",
      "store_name",
      "order_number",
      "product_list",
      "total_price",
      "delivery_address",
      "product_image_url",
    ],
    fixedButtons: flowButtons([
      { type: "QUICK_REPLY", text: "Yes, Confirmed.", action: "confirm" },
      { type: "QUICK_REPLY", text: "No, Cancel it.", action: "cancel" },
      {
        type: "QUICK_REPLY",
        text: "Request Changes",
        action: "request_changes",
      },
    ]),
    defaultTemplate: {
      displayName: "Order Confirmation",
      headerType: "TEXT",
      headerText: "Order Confirmation",
      bodyText:
        "Hi {{customer_name}},\n" +
        "We received your order at {{store_name}}.\n\n" +
        "Order Summary\n" +
        "Order Number: {{order_number}}\n" +
        "Products: {{product_list}}\n" +
        "Amount: {{total_price}}\n" +
        "Delivery Address: {{delivery_address}}\n\n" +
        "Select an option below to proceed.",
      footerText: "",
    },
  },
  [FLOW_KEYS.ORDER_CHANGE_REQUEST]: {
    key: FLOW_KEYS.ORDER_CHANGE_REQUEST,
    label: "Order Change Request",
    description:
      "Live session-based change-request flow after the customer taps Request Changes. No standalone template is assigned here yet.",
    supportsTemplates: false,
    defaultStatusTone: "subdued",
    supportedVariables: [],
    fixedButtons: [],
    defaultTemplate: null,
  },
  [FLOW_KEYS.ORDER_DISPATCHED]: {
    key: FLOW_KEYS.ORDER_DISPATCHED,
    label: "Delivery Update: Dispatched",
    description:
      "Sent when Shopify creates a fulfillment for a confirmed order.",
    supportsTemplates: true,
    legacyTemplateKey: "cod_order_dispatched",
    defaultMetaTemplateName: "orderx_cod_order_dispatched",
    templateNameBase: "orderx_order_dispatched",
    defaultStatusTone: "success",
    supportsImageHeader: true,
    supportedVariables: [
      "customer_name",
      "order_number",
      "store_name",
      "product_list",
      "courier_name",
      "tracking_number",
      "tracking_url",
      "product_image_url",
    ],
    fixedButtons: [],
    defaultTemplate: {
      displayName: "Order Dispatched",
      headerType: "TEXT",
      headerText: "Order dispatched",
      bodyText:
        "Hi {{customer_name}},\n\n" +
        "Your order {{order_number}} from {{store_name}} has been dispatched.\n\n" +
        "Order Summary\n" +
        "Products: {{product_list}}\n" +
        "Courier: {{courier_name}}\n" +
        "Tracking Number: {{tracking_number}}\n" +
        "Tracking Link: {{tracking_url}}\n\n" +
        "This is an order update regarding your recent purchase.",
      footerText: "",
    },
  },
  [FLOW_KEYS.TRACKING_UPDATED]: {
    key: FLOW_KEYS.TRACKING_UPDATED,
    label: "Delivery Update: Tracking Changed",
    description: "Sent when tracking details change on a fulfillment.",
    supportsTemplates: true,
    legacyTemplateKey: "cod_tracking_updated",
    defaultMetaTemplateName: "orderx_cod_tracking_updated",
    templateNameBase: "orderx_tracking_updated",
    defaultStatusTone: "success",
    supportedVariables: [
      "customer_name",
      "order_number",
      "store_name",
      "courier_name",
      "tracking_number",
      "tracking_url",
    ],
    fixedButtons: [],
    defaultTemplate: {
      displayName: "Tracking Updated",
      headerType: "TEXT",
      headerText: "Tracking updated",
      bodyText:
        "Hi {{customer_name}},\n\n" +
        "Tracking details for your order {{order_number}} from {{store_name}} have been updated.\n\n" +
        "Courier: {{courier_name}}\n" +
        "Tracking Number: {{tracking_number}}\n" +
        "Tracking Link: {{tracking_url}}\n\n" +
        "This is an order update from your recent purchase.",
      footerText: "",
    },
  },
  [FLOW_KEYS.ORDER_CANCELLED]: {
    key: FLOW_KEYS.ORDER_CANCELLED,
    label: "Delivery Update: Cancelled",
    description: "Sent when Shopify marks the order as cancelled.",
    supportsTemplates: true,
    legacyTemplateKey: "cod_order_cancelled",
    defaultMetaTemplateName: "orderx_cod_order_cancelled",
    templateNameBase: "orderx_order_cancelled",
    defaultStatusTone: "critical",
    supportedVariables: [
      "customer_name",
      "order_number",
      "store_name",
      "cancel_reason",
      "support_whatsapp_number",
    ],
    fixedButtons: [],
    defaultTemplate: {
      displayName: "Order Cancelled",
      headerType: "TEXT",
      headerText: "Order cancelled",
      bodyText:
        "Hi {{customer_name}},\n\n" +
        "Your order {{order_number}} from {{store_name}} has been cancelled.\n\n" +
        "Reason: {{cancel_reason}}\n\n" +
        "If you need help, contact support on WhatsApp: {{support_whatsapp_number}}.",
      footerText: "",
    },
  },
  [FLOW_KEYS.ORDER_UPDATE_GENERIC]: {
    key: FLOW_KEYS.ORDER_UPDATE_GENERIC,
    label: "Delivery Update: Generic",
    description:
      "Reusable update template for manual or future logistics updates.",
    supportsTemplates: true,
    legacyTemplateKey: "cod_order_update_generic",
    defaultMetaTemplateName: "orderx_cod_order_update_generic",
    templateNameBase: "orderx_order_update_generic",
    defaultStatusTone: "info",
    supportedVariables: [
      "customer_name",
      "order_number",
      "store_name",
      "update_title",
      "update_details",
    ],
    fixedButtons: [],
    defaultTemplate: {
      displayName: "Order Update Generic",
      headerType: "TEXT",
      headerText: "Order update",
      bodyText:
        "Hi {{customer_name}},\n\n" +
        "There is an update for your order {{order_number}} from {{store_name}}.\n\n" +
        "Update: {{update_title}}\n" +
        "Details: {{update_details}}\n\n" +
        "This is an order update from your recent purchase.",
      footerText: "",
    },
  },
  [FLOW_KEYS.REVIEW_REQUEST]: {
    key: FLOW_KEYS.REVIEW_REQUEST,
    label: "Leave Review Message",
    description:
      "Optional post-delivery review request. This flow uses a Marketing template.",
    supportsTemplates: true,
    templateCategory: TEMPLATE_CATEGORY_MARKETING,
    defaultMetaTemplateName: "orderx_review_request",
    templateNameBase: "orderx_review_request",
    defaultStatusTone: "success",
    supportsImageHeader: true,
    supportedVariables: [
      "customer_name",
      "store_name",
      "order_number",
      "product_list",
      "review_url",
      "product_image_url",
    ],
    fixedButtons: [],
    defaultTemplate: {
      displayName: "Leave Review Request",
      headerType: "TEXT",
      headerText: "How was your order?",
      bodyText:
        "Hi {{customer_name}},\n\n" +
        "We hope you are enjoying your purchase from {{store_name}}.\n\n" +
        "Order: {{order_number}}\n" +
        "Products: {{product_list}}\n\n" +
        "We'd really appreciate it if you could take a moment to leave a review. Your feedback means a lot to us.\n\n" +
        "Leave your review here: {{review_url}}",
      footerText: "Thank you for shopping with us.",
    },
  },
  [FLOW_KEYS.ABANDONED_CART]: {
    key: FLOW_KEYS.ABANDONED_CART,
    label: "Abandoned Cart Recovery",
    description:
      "Optional reminder for carts left behind without checkout completion. This flow uses a Marketing template.",
    supportsTemplates: true,
    templateCategory: TEMPLATE_CATEGORY_MARKETING,
    defaultMetaTemplateName: "orderx_abandoned_cart_recovery",
    templateNameBase: "orderx_abandoned_cart_recovery",
    defaultStatusTone: "warning",
    supportsImageHeader: true,
    supportedVariables: [
      "customer_name",
      "store_name",
      "product_name",
      "product_list",
      "total_price",
      "checkout_url",
      "abandoned_minutes",
      "product_image_url",
    ],
    fixedButtons: [],
    defaultTemplate: {
      displayName: "Abandoned Cart Recovery",
      headerType: "TEXT",
      headerText: "You left something behind",
      bodyText:
        "Hi {{customer_name}},\n\n" +
        "You left items from {{store_name}} in your cart about {{abandoned_minutes}} minutes ago.\n\n" +
        "Products: {{product_list}}\n" +
        "Estimated total: {{total_price}}\n\n" +
        "Complete your checkout here: {{checkout_url}}",
      footerText: "Your cart may expire if inventory runs low.",
    },
  },
};

const CAMPAIGN_TEMPLATE_DEFINITION = {
  key: FLOW_KEYS.CAMPAIGN,
  label: "Campaign",
  description:
    "Reusable merchant campaign template. OrderX submits this as Utility first; Meta may recategorize it after review.",
  supportsTemplates: true,
  templateCategory: TEMPLATE_CATEGORY_UTILITY,
  defaultMetaTemplateName: "orderx_campaign",
  templateNameBase: "orderx_campaign",
  defaultStatusTone: "info",
  supportsImageHeader: true,
  supportedVariables: [
    "customer_name",
    "store_name",
    "order_number",
    "product_name",
    "product_list",
    "total_price",
    "delivery_address",
    "courier_name",
    "tracking_number",
    "tracking_url",
    "cancel_reason",
    "update_title",
    "update_details",
    "product_url",
    "support_whatsapp_number",
    "review_url",
    "checkout_url",
    "abandoned_minutes",
    "product_image_url",
  ],
  fixedButtons: [],
  defaultTemplate: {
    displayName: "Campaign Message",
    headerType: "TEXT",
    headerText: "Special update",
    bodyText:
      "Hi {{customer_name}},\n\n" +
      "We have an update from {{store_name}} for your order {{order_number}}.\n\n" +
      "Products: {{product_list}}\n" +
      "Total: {{total_price}}\n\n" +
      "Reply using the buttons below if you need help.",
    footerText: "",
  },
};

export function normalizeFlowKey(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  return FLOW_DEFINITIONS[raw] || raw === FLOW_KEYS.CAMPAIGN ? raw : "";
}

export function getFlowDefinition(flowKey) {
  const normalized = normalizeFlowKey(flowKey);
  if (normalized === FLOW_KEYS.CAMPAIGN) return CAMPAIGN_TEMPLATE_DEFINITION;
  return FLOW_DEFINITIONS[normalized] || null;
}

export function normalizeTemplateCategory(
  value,
  fallback = TEMPLATE_CATEGORY_UTILITY,
) {
  const normalized = String(value || fallback)
    .trim()
    .toUpperCase();
  return TEMPLATE_CATEGORIES.has(normalized)
    ? normalized
    : String(fallback || TEMPLATE_CATEGORY_UTILITY)
        .trim()
        .toUpperCase();
}

export function getFlowTemplateCategory(flowKey) {
  const flow = getFlowDefinition(flowKey);
  return normalizeTemplateCategory(
    flow?.templateCategory || TEMPLATE_CATEGORY_UTILITY,
    TEMPLATE_CATEGORY_UTILITY,
  );
}

export function listFlowDefinitions() {
  return Object.values(FLOW_DEFINITIONS);
}

export function listTemplateVariableDefinitions() {
  return Object.values(TEMPLATE_VARIABLE_DEFINITIONS);
}

export function listTemplateLanguageOptions() {
  return TEMPLATE_LANGUAGE_OPTIONS;
}

export function normalizeTemplateLanguage(value) {
  const raw = String(value || TEMPLATE_LANGUAGE_EN).trim();
  if (!raw) return TEMPLATE_LANGUAGE_EN;
  if (TEMPLATE_LANGUAGE_CODE_SET.has(raw)) return raw;
  const lower = raw.toLowerCase();
  const match = TEMPLATE_LANGUAGE_OPTIONS.find(
    (row) => row.code.toLowerCase() === lower,
  );
  return match?.code || "";
}

export function normalizeTemplateStatus(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) return "draft";
  if (["approved", "active", "connected"].includes(raw)) return "approved";
  if (["pending", "submitted", "in_review", "pending_deletion"].includes(raw)) {
    return raw === "in_review" ? "in_review" : "pending";
  }
  if (["rejected", "disabled", "paused"].includes(raw)) return "rejected";
  if (["missing", "not_found"].includes(raw)) return "missing";
  return raw;
}

export function generateTemplateId(prefix = "tpl") {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

export function normalizeMetaTemplateName(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.slice(0, 512);
}

function normalizeMetaTemplateId(value) {
  const raw = String(value || "").trim();
  return raw || null;
}

function remoteMetaTemplateId(row = {}) {
  return normalizeMetaTemplateId(
    row?.id ||
      row?.message_template_id ||
      row?.messageTemplateId ||
      row?.template_id ||
      row?.templateId,
  );
}

function metaTemplateIdentityKey(row = {}) {
  const name = String(row?.metaTemplateName || row?.templateName || row?.name || "")
    .trim()
    .toLowerCase();
  const language = String(row?.language || "")
    .trim()
    .toLowerCase();
  const category = String(row?.category || "")
    .trim()
    .toUpperCase();
  return [name, language, category].join("|");
}

function metaTemplateLooseIdentityKey(row = {}) {
  const name = String(row?.metaTemplateName || row?.templateName || row?.name || "")
    .trim()
    .toLowerCase();
  const language = String(row?.language || "")
    .trim()
    .toLowerCase();
  return [name, language].join("|");
}

function metaTemplateUpdatedAt(row = {}) {
  const raw = row?.last_updated_time || row?.lastUpdatedTime || row?.updatedAt || 0;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function prettifyMetaTemplateName(value = "") {
  const normalized = String(value || "")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "Meta Template";
  return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeExampleValue(value = "") {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

const SAMPLE_KEY_BY_NORMALIZED_VALUE = new Map(
  Object.values(TEMPLATE_VARIABLE_DEFINITIONS)
    .map((row) => [
      normalizeExampleValue(row?.sample || ""),
      String(row?.key || "")
        .trim()
        .toLowerCase(),
    ])
    .filter(([sample, key]) => sample && key),
);

function firstArray(values) {
  if (!Array.isArray(values)) return [];
  if (Array.isArray(values[0])) return values[0];
  return values;
}

function extractMetaComponentExampleValues(component = {}) {
  const type = String(component?.type || "")
    .trim()
    .toUpperCase();
  const format = String(component?.format || "")
    .trim()
    .toUpperCase();
  const example = component?.example || {};

  if (type === "BODY") {
    return firstArray(example?.body_text).map((value) => String(value || "").trim());
  }
  if (type === "HEADER" && format === "TEXT") {
    return firstArray(example?.header_text).map((value) =>
      String(value || "").trim(),
    );
  }
  return [];
}

function extractMetaHeaderSampleUrl(component = {}) {
  const example = component?.example || {};
  const values = [
    ...(Array.isArray(example?.header_handle) ? example.header_handle : []),
    ...(Array.isArray(example?.header_url) ? example.header_url : []),
  ];
  return firstValidHttpsUrl(values);
}

function normalizeMetaTemplateComponents(remote = {}) {
  const source = Array.isArray(remote?.components)
    ? remote.components
    : Array.isArray(remote?.structure?.components)
      ? remote.structure.components
      : [];
  return source.filter(Boolean);
}

function inferKeyFromExampleAndContext({
  exampleValue = "",
  before = "",
  after = "",
  allowedVariables = [],
  fallbackIndex = 0,
}) {
  const allowed = new Set(
    (Array.isArray(allowedVariables) ? allowedVariables : [])
      .map((value) =>
        String(value || "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  );
  const example = String(exampleValue || "").trim();
  const normalizedExample = normalizeExampleValue(example);
  const context = `${String(before || "")} ${String(after || "")}`
    .toLowerCase()
    .replace(/\s+/g, " ");
  const directMatch = SAMPLE_KEY_BY_NORMALIZED_VALUE.get(normalizedExample);
  if (directMatch && (!allowed.size || allowed.has(directMatch))) {
    return directMatch;
  }

  const allow = (key) => !allowed.size || allowed.has(key);
  const isUrl = /^https?:\/\//i.test(example);
  if (isUrl) {
    if (context.includes("review") && allow("review_url")) return "review_url";
    if (
      (context.includes("checkout") || context.includes("cart")) &&
      allow("checkout_url")
    ) {
      return "checkout_url";
    }
    if (context.includes("track") && allow("tracking_url")) {
      return "tracking_url";
    }
    if (
      (context.includes("product") || context.includes("item")) &&
      allow("product_url")
    ) {
      return "product_url";
    }
  }

  if (
    (context.includes("price") ||
      context.includes("amount") ||
      /\b(pkr|usd|aed|sar|eur|inr|rs)\b/i.test(example) ||
      /\d+\.\d{2}/.test(example)) &&
    allow("total_price")
  ) {
    return "total_price";
  }
  if (
    (context.includes("address") ||
      context.includes("delivery") ||
      context.includes("shipping")) &&
    allow("delivery_address")
  ) {
    return "delivery_address";
  }
  if (
    (context.includes("products") ||
      context.includes("items") ||
      /\bx\b/.test(example)) &&
    allow("product_list")
  ) {
    return "product_list";
  }
  if (context.includes("product") && allow("product_name")) {
    return "product_name";
  }
  if (
    (context.includes("order") || /^#?[a-z0-9-]{4,}$/i.test(example)) &&
    allow("order_number")
  ) {
    return "order_number";
  }
  if (
    (context.includes("customer") ||
      context.includes("hello") ||
      context.includes("hi ") ||
      context.includes("dear") ||
      context.includes("name")) &&
    allow("customer_name")
  ) {
    return "customer_name";
  }
  if (
    (context.includes("store") || context.includes("shop") || context.includes("from")) &&
    allow("store_name")
  ) {
    return "store_name";
  }
  if (
    (context.includes("support") || context.includes("whatsapp")) &&
    allow("support_whatsapp_number")
  ) {
    return "support_whatsapp_number";
  }
  if (context.includes("courier") && allow("courier_name")) {
    return "courier_name";
  }
  if (context.includes("track") && allow("tracking_number")) {
    return "tracking_number";
  }
  if (context.includes("cancel") && allow("cancel_reason")) {
    return "cancel_reason";
  }
  if (
    (context.includes("minutes") || context.includes("ago")) &&
    allow("abandoned_minutes")
  ) {
    return "abandoned_minutes";
  }
  if (context.includes("details") && allow("update_details")) {
    return "update_details";
  }
  if (context.includes("update") && allow("update_title")) {
    return "update_title";
  }

  const fallbackPriority = [
    "customer_name",
    "store_name",
    "order_number",
    "product_name",
    "product_list",
    "total_price",
    "delivery_address",
    "product_url",
    "support_whatsapp_number",
  ].filter((key) => allow(key));

  if (!fallbackPriority.length) return "";
  return fallbackPriority[Math.min(fallbackIndex, fallbackPriority.length - 1)];
}

function restoreFriendlyTextFromMetaText(
  text = "",
  exampleValues = [],
  allowedVariables = [],
) {
  const source = String(text || "");
  const matches = Array.from(source.matchAll(/{{\s*(\d+)\s*}}/g));
  if (!matches.length) {
    return { text: source, inferredVariables: [] };
  }

  const inferredByIndex = new Map();
  const inferredVariables = [];
  matches.forEach((match, orderIndex) => {
    const placeholderIndex = Number(match?.[1] || 0);
    if (!Number.isFinite(placeholderIndex) || placeholderIndex <= 0) return;
    if (inferredByIndex.has(placeholderIndex)) return;

    const start = Number(match.index || 0);
    const end = start + String(match[0] || "").length;
    const before = source.slice(Math.max(0, start - 42), start);
    const after = source.slice(end, Math.min(source.length, end + 42));
    const exampleValue = exampleValues[placeholderIndex - 1] || "";
    const key = inferKeyFromExampleAndContext({
      exampleValue,
      before,
      after,
      allowedVariables,
      fallbackIndex: orderIndex,
    });
    if (key) {
      inferredByIndex.set(placeholderIndex, key);
      inferredVariables.push(key);
    }
  });

  const nextText = source.replace(/{{\s*(\d+)\s*}}/g, (_, rawIndex) => {
    const key = inferredByIndex.get(Number(rawIndex || 0));
    return key ? `{{${key}}}` : `{{customer_name}}`;
  });

  return { text: nextText, inferredVariables };
}

function parseMetaButtons(buttons = []) {
  return (Array.isArray(buttons) ? buttons : [])
    .map((button, index) => {
      const type = String(button?.type || "")
        .trim()
        .toUpperCase();
      if (!["QUICK_REPLY", "URL"].includes(type)) return null;
      return {
        type,
        text: String(button?.text || "").trim().slice(0, 25),
        url:
          type === "URL"
            ? assertHttpsUrl("Button URL", button?.url || "")
            : "",
        responseText: "",
        tag: "",
        index,
        action: type === "URL" ? `campaign_link_${index}` : `campaign_button_${index}`,
        allowedTypes: [type],
      };
    })
    .filter(Boolean);
}

function preserveCampaignLibraryButtons(
  nextButtons = [],
  existingButtons = [],
) {
  const existingByIdentity = new Map(
    (Array.isArray(existingButtons) ? existingButtons : []).map((button, index) => {
      const identity = [
        String(button?.type || "").trim().toUpperCase(),
        String(button?.text || "").trim(),
        String(button?.url || "").trim(),
        Number.isFinite(Number(button?.index)) ? Number(button.index) : index,
      ].join("|");
      return [identity, button];
    }),
  );

  return (Array.isArray(nextButtons) ? nextButtons : []).map((button, index) => {
    const identity = [
      String(button?.type || "").trim().toUpperCase(),
      String(button?.text || "").trim(),
      String(button?.url || "").trim(),
      Number.isFinite(Number(button?.index)) ? Number(button.index) : index,
    ].join("|");
    const existing = existingByIdentity.get(identity) || {};
    return {
      ...button,
      responseText: String(
        existing?.responseText || button?.responseText || "",
      ).trim(),
      tag: String(existing?.tag || button?.tag || "").trim(),
      action:
        String(existing?.action || "").trim() ||
        String(button?.action || "").trim() ||
        (String(button?.type || "").trim().toUpperCase() === "URL"
          ? `campaign_link_${index}`
          : `campaign_button_${index}`),
    };
  });
}

export function buildCampaignLibraryTemplateFromMeta(remote = {}, existing = null) {
  const flow = getFlowDefinition(FLOW_KEYS.CAMPAIGN);
  const components = normalizeMetaTemplateComponents(remote);
  const headerComponent =
    components.find(
      (component) =>
        String(component?.type || "")
          .trim()
          .toUpperCase() === "HEADER",
    ) || null;
  const bodyComponent =
    components.find(
      (component) =>
        String(component?.type || "")
          .trim()
          .toUpperCase() === "BODY",
    ) || null;
  const footerComponent =
    components.find(
      (component) =>
        String(component?.type || "")
          .trim()
          .toUpperCase() === "FOOTER",
    ) || null;
  const buttonsComponent =
    components.find(
      (component) =>
        String(component?.type || "")
          .trim()
          .toUpperCase() === "BUTTONS",
    ) || null;

  const rawHeaderFormat = String(headerComponent?.format || "")
    .trim()
    .toUpperCase();
  if (rawHeaderFormat && !["TEXT", "IMAGE"].includes(rawHeaderFormat)) {
    return null;
  }

  const allowedVariables = flow?.supportedVariables || [];
  const headerRestore =
    rawHeaderFormat === "TEXT"
      ? restoreFriendlyTextFromMetaText(
          String(headerComponent?.text || "").trim(),
          extractMetaComponentExampleValues(headerComponent),
          allowedVariables,
        )
      : { text: "", inferredVariables: [] };
  const bodyRestore = restoreFriendlyTextFromMetaText(
    String(bodyComponent?.text || "").trim(),
    extractMetaComponentExampleValues(bodyComponent),
    allowedVariables,
  );
  let parsedButtons = [];
  try {
    parsedButtons = preserveCampaignLibraryButtons(
      parseMetaButtons(buttonsComponent?.buttons),
      existing?.buttons,
    );
  } catch {
    return null;
  }
  const status = normalizeTemplateStatus(remote?.status || existing?.status);
  const now = new Date();
  const remoteRejectionReason =
    remote?.rejected_reason || remote?.rejection_reason || null;
  const headerType =
    rawHeaderFormat === "IMAGE"
      ? "IMAGE"
      : rawHeaderFormat === "TEXT" && headerRestore.text
        ? "TEXT"
        : "NONE";
  const metaTemplateId = remoteMetaTemplateId(remote);
  const metaTemplateName = normalizeMetaTemplateName(
    remote?.name || existing?.metaTemplateName || "",
  );
  const bodyText = String(bodyRestore.text || bodyComponent?.text || "").trim();
  if (!bodyText) return null;

  return {
    ...defaultTemplateShapeForFlow(FLOW_KEYS.CAMPAIGN),
    ...(existing && typeof existing === "object" ? existing : {}),
    id: String(existing?.id || "").trim() || generateTemplateId("camp"),
    flowKey: FLOW_KEYS.CAMPAIGN,
    source: "meta_library",
    originTemplateId: existing?.originTemplateId || null,
    displayName: prettifyMetaTemplateName(
      remote?.name || existing?.metaTemplateName || "",
    ),
    metaTemplateName,
    metaTemplateId,
    templateKey:
      String(existing?.templateKey || "").trim() ||
      String(metaTemplateId || metaTemplateName || generateTemplateId("meta"))
        .trim()
        .toLowerCase(),
    language:
      normalizeTemplateLanguage(remote?.language || existing?.language) ||
      TEMPLATE_LANGUAGE_EN,
    category: normalizeTemplateCategory(
      remote?.category || existing?.category || getFlowTemplateCategory(FLOW_KEYS.CAMPAIGN),
      getFlowTemplateCategory(FLOW_KEYS.CAMPAIGN),
    ),
    headerType,
    headerText: headerType === "TEXT" ? String(headerRestore.text || "").trim() : "",
    sampleMediaUrl:
      headerType === "IMAGE"
        ? extractMetaHeaderSampleUrl(headerComponent) || String(existing?.sampleMediaUrl || "").trim()
        : "",
    useProductImageHeader: headerType === "IMAGE"
      ? existing?.useProductImageHeader !== false
      : false,
    bodyText,
    footerText: String(footerComponent?.text || "").trim(),
    buttons: parsedButtons,
    buttonPolicy: parsedButtons.length ? "custom" : "none",
    status,
    rawStatus: String(remote?.status || existing?.rawStatus || status || "DRAFT").trim(),
    rejectionReason:
      status === "rejected"
        ? remoteRejectionReason || existing?.rejectionReason || null
        : null,
    qualityScore: remote?.quality_score || existing?.qualityScore || null,
    lastSyncedAt: now,
    lastUpdatedTime:
      remote?.last_updated_time || existing?.lastUpdatedTime || null,
    lastError:
      status === "rejected"
        ? remoteRejectionReason || existing?.lastError || null
        : null,
    approvedAt:
      status === "approved"
        ? existing?.approvedAt || now
        : null,
    submittedAt: existing?.submittedAt || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

export function syncCampaignLibraryTemplatesWithMeta(
  existing = [],
  remoteTemplates = [],
) {
  const existingRows = ensureManagedTemplateCatalog(existing).filter(
    (row) => String(row?.source || "").trim() === "meta_library",
  );
  const existingByMetaId = new Map(
    existingRows
      .map((row) => [normalizeMetaTemplateId(row?.metaTemplateId), row])
      .filter(([metaTemplateId]) => !!metaTemplateId),
  );

  const nextRows = (Array.isArray(remoteTemplates) ? remoteTemplates : [])
    .map((remote) =>
      buildCampaignLibraryTemplateFromMeta(
        remote,
        existingByMetaId.get(remoteMetaTemplateId(remote)),
      ),
    )
    .filter(Boolean);

  return ensureManagedTemplateCatalog(nextRows).sort((a, b) => {
    const approvedDiff =
      Number(normalizeTemplateStatus(b?.status || b?.rawStatus) === "approved") -
      Number(normalizeTemplateStatus(a?.status || a?.rawStatus) === "approved");
    if (approvedDiff) return approvedDiff;
    return metaTemplateUpdatedAt(b) - metaTemplateUpdatedAt(a);
  });
}

export function generateMetaTemplateNameForFlow(flowKey, catalog = []) {
  const flow = getFlowDefinition(flowKey);
  const base = normalizeMetaTemplateName(
    flow?.templateNameBase || flow?.defaultMetaTemplateName || flowKey,
  );
  const existing = new Set(
    ensureManagedTemplateCatalog(catalog).map((row) =>
      String(row?.metaTemplateName || "")
        .trim()
        .toLowerCase(),
    ),
  );
  if (!existing.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}_${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}_${Date.now()}`;
}

export function extractFriendlyVariables(text) {
  const source = String(text || "");
  const found = [];
  const regex = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
  let match;
  while ((match = regex.exec(source))) {
    const key = String(match[1] || "")
      .trim()
      .toLowerCase();
    if (key) found.push(key);
  }
  return found;
}

export function renderFriendlyPreview(text, context = {}) {
  const sampleContext = {
    ...Object.fromEntries(
      Object.values(TEMPLATE_VARIABLE_DEFINITIONS).map((row) => [
        row.key,
        row.sample,
      ]),
    ),
    ...(context && typeof context === "object" ? context : {}),
  };
  return String(text || "").replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => {
    const normalizedKey = String(key || "")
      .trim()
      .toLowerCase();
    return String(sampleContext?.[normalizedKey] || `{{${normalizedKey}}}`);
  });
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferFriendlyVariablesFromSamples(text, allowedVariableKeys = []) {
  const source = String(text || "");
  if (!source.trim()) return source;

  const allowed = new Set(
    (Array.isArray(allowedVariableKeys) ? allowedVariableKeys : [])
      .map((item) =>
        String(item || "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  );
  const initialFriendlyVariables = extractFriendlyVariables(source);
  const candidates = Object.values(TEMPLATE_VARIABLE_DEFINITIONS)
    .filter((row) => {
      const key = String(row?.key || "")
        .trim()
        .toLowerCase();
      if (!key) return false;
      if (allowed.size && !allowed.has(key)) return false;
      return String(row?.sample || "").trim().length > 0;
    })
    .sort(
      (a, b) => String(b?.sample || "").length - String(a?.sample || "").length,
    );

  let replaced = source;
  let replacements = 0;
  for (const row of candidates) {
    const sample = String(row?.sample || "").trim();
    const key = String(row?.key || "")
      .trim()
      .toLowerCase();
    if (!sample || !key) continue;
    const regex = new RegExp(escapeRegExp(sample), "g");
    replaced = replaced.replace(regex, () => {
      replacements += 1;
      return `{{${key}}}`;
    });
  }

  if (!replacements) return source;
  if (initialFriendlyVariables.length > 0) return replaced;
  return replacements >= 2 ? replaced : source;
}

export function compileFriendlyTextToMeta(text, allowedVariableKeys = []) {
  const source = String(text || "");
  const allowed = new Set(
    (Array.isArray(allowedVariableKeys) ? allowedVariableKeys : [])
      .map((item) =>
        String(item || "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  );
  const variables = [];
  let placeholderIndex = 0;
  const compiledText = source.replace(
    /{{\s*([a-zA-Z0-9_]+)\s*}}/g,
    (_, rawKey) => {
      const key = String(rawKey || "")
        .trim()
        .toLowerCase();
      if (!TEMPLATE_VARIABLE_DEFINITIONS[key]) {
        throw new Error(`Unsupported variable: ${key}`);
      }
      if (allowed.size && !allowed.has(key)) {
        throw new Error(`Variable ${key} is not allowed for this automation`);
      }
      placeholderIndex += 1;
      variables.push(key);
      return `{{${placeholderIndex}}}`;
    },
  );
  return {
    compiledText,
    variables,
  };
}

function assertTemplateTextLength(label, text, maxLen) {
  const value = String(text || "");
  if (value.length > maxLen) {
    throw new Error(`${label} cannot be longer than ${maxLen} characters`);
  }
}

function assertVariablePlacement(label, text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return;
  if (/^{{\s*[a-zA-Z0-9_]+\s*}}/.test(trimmed)) {
    throw new Error(`${label} cannot start with a variable`);
  }
  if (/{{\s*[a-zA-Z0-9_]+\s*}}$/.test(trimmed)) {
    throw new Error(`${label} cannot end with a variable`);
  }
}

function assertHttpsUrl(label, value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS`);
  }
  return raw;
}

function firstValidHttpsUrl(values = []) {
  for (const value of Array.isArray(values) ? values : [values]) {
    const raw = String(value || "").trim();
    if (!raw) continue;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === "https:") return raw;
    } catch {
      // Ignore invalid runtime media URLs and let the caller fall back.
    }
  }
  return "";
}

function parseButtonsInput(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sanitizeCampaignButtons(inputButtons = []) {
  const incoming = parseButtonsInput(inputButtons);
  const buttons = [];
  let urlButtonCount = 0;

  for (const row of incoming) {
    if (buttons.length >= 10) break;
    const type = String(row?.type || "QUICK_REPLY")
      .trim()
      .toUpperCase();
    if (!["QUICK_REPLY", "URL"].includes(type)) {
      throw new Error("Campaign buttons can be quick reply or URL buttons only");
    }

    const text = String(row?.text || "").trim().slice(0, 25);
    if (!text) {
      throw new Error(`Button ${buttons.length + 1} text is required`);
    }

    const next = {
      type,
      text,
      index: buttons.length,
      action: String(row?.action || `campaign_button_${buttons.length}`).trim(),
      allowedTypes: ["QUICK_REPLY", "URL"],
      responseText: String(row?.responseText || "").trim().slice(0, 1024),
      tag: String(row?.tag || "").trim().slice(0, 40),
      url: "",
    };

    if (type === "URL") {
      urlButtonCount += 1;
      if (urlButtonCount > 2) {
        throw new Error("Campaign templates can include up to 2 URL buttons");
      }
      const url = assertHttpsUrl("Button URL", row?.url || "");
      if (!url) throw new Error(`Button ${buttons.length + 1} URL is required`);
      next.url = url.slice(0, 2000);
    }

    buttons.push(next);
  }

  return buttons;
}

function sanitizeButtonsForFlow(flow, inputButtons = []) {
  if (flow?.key === FLOW_KEYS.CAMPAIGN) {
    return sanitizeCampaignButtons(inputButtons);
  }

  const fixedButtons = Array.isArray(flow?.fixedButtons)
    ? flow.fixedButtons
    : [];
  if (!fixedButtons.length) return [];

  const incoming = parseButtonsInput(inputButtons);
  const matchesFixedButton = (item, button, index) => {
    const itemAction = String(item?.action || "").trim();
    const buttonAction = String(button?.action || button?.id || "").trim();
    if (itemAction && buttonAction) return itemAction === buttonAction;
    if (itemAction && !buttonAction) return false;
    return Number(item?.index) === index;
  };
  const allowsOptionalButtons = flow?.key === FLOW_KEYS.ORDER_CONFIRMATION;
  const sourceButtons = allowsOptionalButtons
    ? fixedButtons.filter((button, index) =>
        incoming.some((item) => matchesFixedButton(item, button, index)),
      )
    : fixedButtons;

  return sourceButtons.map((button) => {
    const originalIndex = Number.isFinite(Number(button?.index))
      ? Number(button.index)
      : fixedButtons.indexOf(button);
    const row =
      incoming.find((item) => matchesFixedButton(item, button, originalIndex)) ||
      {};
    const allowedTypes = Array.isArray(button?.allowedTypes)
      ? button.allowedTypes
      : ["QUICK_REPLY"];
    const requestedType = String(row?.type || button?.type || "QUICK_REPLY")
      .trim()
      .toUpperCase();
    const type = allowedTypes.includes(requestedType)
      ? requestedType
      : button?.type || "QUICK_REPLY";
    const text = String(row?.text || button?.text || "")
      .trim()
      .slice(0, 25);
    if (!text) {
      throw new Error(`Button ${originalIndex + 1} text is required`);
    }
    return {
      type,
      text,
      url: String(row?.url || button?.url || "").trim(),
      responseText: String(row?.responseText || button?.responseText || "")
        .trim()
        .slice(0, 1024),
      tag: String(row?.tag || button?.tag || "").trim().slice(0, 40),
      index: originalIndex,
      action: button?.action || button?.id || null,
      allowedTypes,
    };
  });
}

export function buildMetaTemplateDefinitionFromManagedTemplate(template) {
  const flow = getFlowDefinition(template?.flowKey);
  if (!flow || !flow.supportsTemplates) {
    throw new Error("This automation flow does not use a WhatsApp template");
  }

  const headerType = String(template?.headerType || "TEXT")
    .trim()
    .toUpperCase();
  const bodyText = inferFriendlyVariablesFromSamples(
    String(template?.bodyText || "").trim(),
    flow.supportedVariables || [],
  );
  const footerText = String(template?.footerText || "").trim();
  const buttons = Array.isArray(template?.buttons) ? template.buttons : [];
  const allowedVariables = flow.supportedVariables || [];
  const language =
    normalizeTemplateLanguage(template?.language) || TEMPLATE_LANGUAGE_EN;

  if (!bodyText) throw new Error("Template body is required");
  if (!HEADER_TYPES.has(headerType)) {
    throw new Error(
      "Only no header, text header, or image header are supported",
    );
  }
  if (headerType === "IMAGE" && !flow.supportsImageHeader) {
    throw new Error("Image headers are not enabled for this automation type");
  }
  assertTemplateTextLength("Body", bodyText, 1024);
  assertTemplateTextLength("Footer", footerText, 60);
  assertVariablePlacement("Body", bodyText);

  const components = [];
  if (headerType === "TEXT" && String(template?.headerText || "").trim()) {
    const headerText = inferFriendlyVariablesFromSamples(
      String(template?.headerText || "").trim(),
      allowedVariables,
    );
    assertTemplateTextLength("Header", headerText, 60);
    assertVariablePlacement("Header", headerText);
    const compiledHeader = compileFriendlyTextToMeta(
      headerText,
      allowedVariables,
    );
    components.push({
      type: "HEADER",
      format: "TEXT",
      text: compiledHeader.compiledText,
      ...(compiledHeader.variables.length
        ? {
            example: {
              header_text: compiledHeader.variables.map(
                (key) => TEMPLATE_VARIABLE_DEFINITIONS?.[key]?.sample || key,
              ),
            },
          }
        : {}),
    });
  }
  if (headerType === "IMAGE") {
    const sampleMediaUrl = assertHttpsUrl(
      "Sample image URL",
      template?.sampleMediaUrl,
    );
    if (!sampleMediaUrl) {
      throw new Error(
        "Sample image URL is required for image header templates",
      );
    }
    components.push({
      type: "HEADER",
      format: "IMAGE",
      example: {
        header_handle: [sampleMediaUrl],
      },
    });
  }

  const compiledBody = compileFriendlyTextToMeta(bodyText, allowedVariables);
  components.push({
    type: "BODY",
    text: compiledBody.compiledText,
    ...(compiledBody.variables.length
      ? {
          example: {
            body_text: [
              compiledBody.variables.map(
                (key) => TEMPLATE_VARIABLE_DEFINITIONS?.[key]?.sample || key,
              ),
            ],
          },
        }
      : {}),
  });

  if (footerText) {
    if (extractFriendlyVariables(footerText).length) {
      throw new Error("Footer text cannot contain variables");
    }
    components.push({
      type: "FOOTER",
      text: footerText,
    });
  }

  if (buttons.length) {
    components.push({
      type: "BUTTONS",
      buttons: buttons.map((button) => {
        const type = String(button?.type || "QUICK_REPLY")
          .trim()
          .toUpperCase();
        const row = {
          type,
          text: String(button?.text || "").trim(),
        };
        if (type === "URL") {
          row.url = assertHttpsUrl("Button URL", button?.url || "");
        }
        return row;
      }),
    });
  }

  return {
    key: String(template?.templateKey || "").trim(),
    templateName: normalizeMetaTemplateName(template?.metaTemplateName),
    displayName: String(template?.displayName || flow.label).trim(),
    language,
    category: getFlowTemplateCategory(flow?.key),
    components,
  };
}

export function defaultTemplateShapeForFlow(flowKey, overrides = {}) {
  const flow = getFlowDefinition(flowKey);
  if (!flow || !flow.supportsTemplates || !flow.defaultTemplate) {
    return null;
  }
  const legacyKey = flow.legacyTemplateKey || null;
  return {
    id: generateTemplateId(),
    flowKey,
    templateKey: legacyKey || normalizeMetaTemplateName(flowKey),
    source: legacyKey ? "default_pack" : "merchant_custom",
    originTemplateId: null,
    displayName: flow.defaultTemplate.displayName,
    metaTemplateName: normalizeMetaTemplateName(
      flow.defaultMetaTemplateName || `${flowKey}_${Date.now()}`,
    ),
    metaTemplateId: null,
    language: TEMPLATE_LANGUAGE_EN,
    category: getFlowTemplateCategory(flowKey),
    headerType: flow.defaultTemplate.headerType || "TEXT",
    headerText: flow.defaultTemplate.headerText || "",
    sampleMediaUrl: "",
    useProductImageHeader: !!flow.supportsImageHeader,
    bodyText: flow.defaultTemplate.bodyText || "",
    footerText: flow.defaultTemplate.footerText || "",
    buttons: (flow.fixedButtons || []).map((button) => ({
      type: button.type,
      text: button.text,
      index: button.index,
      action: button.action || button.id || null,
      allowedTypes: button.allowedTypes || ["QUICK_REPLY"],
    })),
    buttonPolicy: flow.fixedButtons?.length ? "fixed" : "none",
    status: "draft",
    rawStatus: "DRAFT",
    rejectionReason: null,
    qualityScore: null,
    lastSyncedAt: null,
    lastUpdatedTime: null,
    lastError: null,
    testMessageTargetPhoneE164: "",
    testMessageOutboundMessageId: null,
    testMessageSentAt: null,
    testMessageStatus: null,
    testMessageStatusAt: null,
    testMessageLastError: null,
    testMessageLastErrorAt: null,
    approvedAt: null,
    submittedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function defaultAutomationFlowConfig(flowKey, overrides = {}) {
  const flow = getFlowDefinition(flowKey);
  if (!flow) return null;
  const enabledByDefault = [
    FLOW_KEYS.ORDER_CONFIRMATION,
    FLOW_KEYS.ORDER_CHANGE_REQUEST,
    FLOW_KEYS.ORDER_DISPATCHED,
    FLOW_KEYS.TRACKING_UPDATED,
    FLOW_KEYS.ORDER_CANCELLED,
    FLOW_KEYS.ORDER_UPDATE_GENERIC,
  ].includes(flowKey);
  const defaultConfig =
    flowKey === FLOW_KEYS.REVIEW_REQUEST
      ? { delayHours: 96, reviewUrl: "", linkMode: "store" }
      : {};
  return {
    flowKey,
    enabled: enabledByDefault,
    templateId: null,
    templateKey: flow.legacyTemplateKey || null,
    config: defaultConfig,
    updatedAt: new Date(),
    ...overrides,
  };
}

export function ensureAutomationFlowConfigs(existing = []) {
  const byKey = new Map(
    (Array.isArray(existing) ? existing : [])
      .map((row) => ({
        ...row,
        flowKey: normalizeFlowKey(row?.flowKey),
      }))
      .filter((row) => row.flowKey)
      .map((row) => [row.flowKey, row]),
  );

  return listFlowDefinitions().map((flow) => {
    const current = byKey.get(flow.key);
    return {
      ...defaultAutomationFlowConfig(flow.key),
      ...(current || {}),
      flowKey: flow.key,
      config:
        current?.config && typeof current.config === "object"
          ? {
              ...(defaultAutomationFlowConfig(flow.key)?.config || {}),
              ...current.config,
            }
          : defaultAutomationFlowConfig(flow.key)?.config || {},
    };
  });
}

export function ensureManagedTemplateCatalog(existing = []) {
  const rows = Array.isArray(existing) ? existing : [];
  const normalized = rows
    .map((row) => {
      const flowKey = normalizeFlowKey(row?.flowKey);
      if (!flowKey) return null;
      const flow = getFlowDefinition(flowKey);
      const hasStoredButtons = Array.isArray(row?.buttons);
      const shouldFallbackToFixedButtons =
        !hasStoredButtons &&
        String(row?.source || "").trim() === "default_pack" &&
        Array.isArray(flow?.fixedButtons) &&
        flow.fixedButtons.length > 0;
      const rawButtons = hasStoredButtons
        ? row.buttons
        : shouldFallbackToFixedButtons
          ? flow.fixedButtons
          : [];
      return {
        ...defaultTemplateShapeForFlow(flowKey, {
          source:
            String(row?.source || "merchant_custom").trim() ||
            "merchant_custom",
          id: String(row?.id || "").trim() || generateTemplateId(),
          originTemplateId: row?.originTemplateId || null,
          displayName: String(
            row?.displayName || flow?.label || "Template",
          ).trim(),
          metaTemplateName: normalizeMetaTemplateName(
            row?.metaTemplateName ||
              flow?.defaultMetaTemplateName ||
              `${flowKey}_${Date.now()}`,
          ),
          metaTemplateId: normalizeMetaTemplateId(row?.metaTemplateId),
          templateKey:
            String(row?.templateKey || flow?.legacyTemplateKey || "")
              .trim()
              .toLowerCase() || null,
          language:
            normalizeTemplateLanguage(row?.language) || TEMPLATE_LANGUAGE_EN,
          category: normalizeTemplateCategory(
            row?.category,
            getFlowTemplateCategory(flowKey),
          ),
          headerType: String(row?.headerType || "TEXT")
            .trim()
            .toUpperCase(),
          headerText: String(row?.headerText || "").trim(),
          sampleMediaUrl: String(row?.sampleMediaUrl || "").trim(),
          useProductImageHeader: row?.useProductImageHeader !== false,
          bodyText: String(row?.bodyText || "").trim(),
          footerText: String(row?.footerText || "").trim(),
          buttons: rawButtons.map((button, index) => ({
            type: String(button?.type || "QUICK_REPLY")
              .trim()
              .toUpperCase(),
            text: String(button?.text || "").trim(),
            url: String(button?.url || "").trim(),
            responseText: String(button?.responseText || "").trim(),
            tag: String(button?.tag || "").trim(),
            index: Number.isFinite(Number(button?.index))
              ? Number(button.index)
              : index,
            action:
              button?.action ||
              flow?.fixedButtons?.[index]?.action ||
              flow?.fixedButtons?.[index]?.id ||
              button?.id ||
              null,
            allowedTypes: Array.isArray(button?.allowedTypes)
              ? button.allowedTypes
              : flow?.fixedButtons?.[index]?.allowedTypes || ["QUICK_REPLY"],
          })),
          buttonPolicy:
            String(row?.buttonPolicy || "").trim() ||
            (flow?.fixedButtons?.length ? "fixed" : "none"),
          status: normalizeTemplateStatus(row?.status || "draft"),
          rawStatus:
            String(row?.rawStatus || row?.status || "DRAFT").trim() || "DRAFT",
          rejectionReason: row?.rejectionReason || row?.lastError || null,
          qualityScore: row?.qualityScore || null,
          lastSyncedAt: row?.lastSyncedAt || row?.lastCheckedAt || null,
          lastUpdatedTime: row?.lastUpdatedTime || null,
          lastError: row?.lastError || null,
          testMessageTargetPhoneE164: String(
            row?.testMessageTargetPhoneE164 || "",
          ).trim(),
          testMessageOutboundMessageId:
            row?.testMessageOutboundMessageId || null,
          testMessageSentAt: row?.testMessageSentAt || null,
          testMessageStatus: row?.testMessageStatus || null,
          testMessageStatusAt: row?.testMessageStatusAt || null,
          testMessageLastError: row?.testMessageLastError || null,
          testMessageLastErrorAt: row?.testMessageLastErrorAt || null,
          approvedAt: row?.approvedAt || null,
          submittedAt: row?.submittedAt || null,
          createdAt: row?.createdAt || new Date(),
          updatedAt: row?.updatedAt || new Date(),
        }),
      };
    })
    .filter(Boolean);

  const byId = new Map();
  for (const row of normalized) {
    const key = String(row?.id || "").trim();
    if (!key) continue;
    if (!byId.has(key)) byId.set(key, row);
  }

  return Array.from(byId.values()).sort((a, b) => {
    const aTime = new Date(a?.updatedAt || a?.createdAt || 0).getTime();
    const bTime = new Date(b?.updatedAt || b?.createdAt || 0).getTime();
    return bTime - aTime;
  });
}

export function upsertCorePackTemplatesIntoCatalog(
  catalog = [],
  legacyTemplates = [],
) {
  const rows = ensureManagedTemplateCatalog(catalog);
  const nextRows = [...rows];

  for (const flowKey of Object.keys(LEGACY_TEMPLATE_KEY_BY_FLOW)) {
    const flow = getFlowDefinition(flowKey);
    if (!flow) continue;

    const legacyKey = LEGACY_TEMPLATE_KEY_BY_FLOW[flowKey];
    const legacyMatch = (
      Array.isArray(legacyTemplates) ? legacyTemplates : []
    ).find((row) => String(row?.key || "").trim() === legacyKey);
    const existingIndex = nextRows.findIndex(
      (row) =>
        row.flowKey === flowKey &&
        (row.source === "default_pack" ||
          String(row?.templateKey || "").trim() === legacyKey),
    );
    const existing = existingIndex >= 0 ? nextRows[existingIndex] : null;
    const merged = ensureManagedTemplateCatalog([
      {
        ...defaultTemplateShapeForFlow(flowKey),
        ...(existing || {}),
        source: "default_pack",
        templateKey: legacyKey,
        metaTemplateName: normalizeMetaTemplateName(
          legacyMatch?.templateName ||
            existing?.metaTemplateName ||
            flow.defaultMetaTemplateName,
        ),
        metaTemplateId: existing?.metaTemplateId || null,
        language:
          normalizeTemplateLanguage(
            legacyMatch?.language || existing?.language || TEMPLATE_LANGUAGE_EN,
          ) || TEMPLATE_LANGUAGE_EN,
        status: normalizeTemplateStatus(
          legacyMatch?.status || existing?.status || "missing",
        ),
        rawStatus: String(
          legacyMatch?.status || existing?.rawStatus || "missing",
        ).trim(),
        lastSyncedAt:
          legacyMatch?.lastCheckedAt || existing?.lastSyncedAt || null,
        lastUpdatedTime:
          existing?.lastUpdatedTime || legacyMatch?.lastUpdatedTime || null,
        lastError: legacyMatch?.lastError || existing?.lastError || null,
        rejectionReason:
          existing?.rejectionReason || legacyMatch?.lastError || null,
      },
    ])[0];

    if (existingIndex >= 0) nextRows.splice(existingIndex, 1, merged);
    else nextRows.push(merged);
  }

  return ensureManagedTemplateCatalog(nextRows).sort((a, b) => {
    const aFlowLabel = String(
      getFlowDefinition(a?.flowKey)?.label || a?.displayName || "",
    );
    const bFlowLabel = String(
      getFlowDefinition(b?.flowKey)?.label || b?.displayName || "",
    );
    if (aFlowLabel !== bFlowLabel) return aFlowLabel.localeCompare(bFlowLabel);

    if (a?.source === "default_pack" && b?.source !== "default_pack") return -1;
    if (b?.source === "default_pack" && a?.source !== "default_pack") return 1;

    const aTime = new Date(a?.updatedAt || a?.createdAt || 0).getTime();
    const bTime = new Date(b?.updatedAt || b?.createdAt || 0).getTime();
    return bTime - aTime;
  });
}

export function mergeManagedTemplateStatusesWithMeta(
  catalog = [],
  remoteTemplates = [],
) {
  const rows = ensureManagedTemplateCatalog(catalog);
  const remoteRows = Array.isArray(remoteTemplates) ? remoteTemplates : [];
  const remoteById = new Map();
  const remoteByIdentity = new Map();
  const remoteByLooseIdentity = new Map();

  for (const remote of remoteRows) {
    const remoteId = remoteMetaTemplateId(remote);
    if (remoteId) remoteById.set(remoteId, remote);

    const key = metaTemplateIdentityKey(remote);
    if (key.replace(/\|/g, "")) {
      const bucket = remoteByIdentity.get(key) || [];
      bucket.push(remote);
      remoteByIdentity.set(key, bucket);
    }

    const looseKey = metaTemplateLooseIdentityKey(remote);
    if (looseKey.replace(/\|/g, "")) {
      const bucket = remoteByLooseIdentity.get(looseKey) || [];
      bucket.push(remote);
      remoteByLooseIdentity.set(looseKey, bucket);
    }
  }

  for (const bucket of remoteByIdentity.values()) {
    bucket.sort((a, b) => metaTemplateUpdatedAt(b) - metaTemplateUpdatedAt(a));
  }
  for (const bucket of remoteByLooseIdentity.values()) {
    bucket.sort((a, b) => metaTemplateUpdatedAt(b) - metaTemplateUpdatedAt(a));
  }

  return rows.map((row) => {
    const storedMetaTemplateId = normalizeMetaTemplateId(row?.metaTemplateId);
    let remote = storedMetaTemplateId
      ? remoteById.get(storedMetaTemplateId)
      : null;
    let ambiguousStatusMatch = false;

    if (!remote && !storedMetaTemplateId) {
      const candidates =
        remoteByIdentity.get(metaTemplateIdentityKey(row)) ||
        remoteByIdentity.get(
          metaTemplateIdentityKey({
            ...row,
            category: getFlowTemplateCategory(row?.flowKey),
          }),
        ) ||
        remoteByLooseIdentity.get(metaTemplateLooseIdentityKey(row)) ||
        [];
      if (candidates.length === 1) {
        remote = candidates[0];
      } else if (candidates.length > 1) {
        ambiguousStatusMatch = true;
      }
    }

    if (!remote) {
      if (ambiguousStatusMatch) {
        return {
          ...row,
          status: "pending",
          rawStatus: "AMBIGUOUS_META_MATCH",
          lastError:
            "Meta returned multiple templates with this name/language. OrderX needs the exact Meta template ID before it can safely mark this approved.",
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        };
      }
      const currentStatus = normalizeTemplateStatus(row?.status || row?.rawStatus);
      if (["draft", "missing"].includes(currentStatus)) return row;
      return {
        ...row,
        status: "missing",
        rawStatus: "MISSING",
        lastError: null,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      };
    }

    const status = normalizeTemplateStatus(remote?.status || row?.status);
    const rejectionReason =
      remote?.rejected_reason || remote?.rejection_reason || null;
    return {
      ...row,
      metaTemplateId: remoteMetaTemplateId(remote) || row?.metaTemplateId || null,
      category: normalizeTemplateCategory(
        remote?.category || row?.category,
        getFlowTemplateCategory(row?.flowKey),
      ),
      status,
      rawStatus: String(remote?.status || row?.rawStatus || status).trim(),
      rejectionReason:
        status === "rejected" ? rejectionReason || row?.rejectionReason || null : null,
      qualityScore: remote?.quality_score || row?.qualityScore || null,
      lastUpdatedTime:
        remote?.last_updated_time || row?.lastUpdatedTime || null,
      lastSyncedAt: new Date(),
      lastError:
        status === "rejected" ? rejectionReason || row?.lastError || null : null,
      approvedAt:
        status === "approved"
          ? row?.approvedAt || new Date()
          : row?.approvedAt || null,
      updatedAt: new Date(),
    };
  });
}

export function serializeTemplateForClient(row) {
  const flow = getFlowDefinition(row?.flowKey);
  return {
    id: String(row?.id || ""),
    flowKey: String(row?.flowKey || ""),
    flowLabel: flow?.label || "Template",
    displayName: String(row?.displayName || ""),
    metaTemplateName: String(row?.metaTemplateName || ""),
    metaTemplateId: String(row?.metaTemplateId || ""),
    templateKey: String(row?.templateKey || ""),
    source: String(row?.source || "merchant_custom"),
    language: String(row?.language || TEMPLATE_LANGUAGE_EN),
    languageLabel:
      TEMPLATE_LANGUAGE_OPTIONS.find((option) => option.code === row?.language)
        ?.label || String(row?.language || TEMPLATE_LANGUAGE_EN),
    category: normalizeTemplateCategory(
      row?.category,
      getFlowTemplateCategory(row?.flowKey),
    ),
    headerType: String(row?.headerType || "TEXT"),
    headerText: String(row?.headerText || ""),
    sampleMediaUrl: String(row?.sampleMediaUrl || ""),
    useProductImageHeader: row?.useProductImageHeader !== false,
    supportsImageHeader: !!flow?.supportsImageHeader,
    bodyText: String(row?.bodyText || ""),
    footerText: String(row?.footerText || ""),
    buttons: (Array.isArray(row?.buttons) ? row.buttons : []).map((button) => ({
      type: String(button?.type || "QUICK_REPLY"),
      text: String(button?.text || ""),
      url: String(button?.url || ""),
      responseText: String(button?.responseText || ""),
      tag: String(button?.tag || ""),
      index: Number(button?.index || 0),
      action: button?.action || null,
      allowedTypes: Array.isArray(button?.allowedTypes)
        ? button.allowedTypes
        : ["QUICK_REPLY"],
    })),
    buttonPolicy: String(row?.buttonPolicy || "none"),
    status: normalizeTemplateStatus(row?.status || row?.rawStatus || "draft"),
    rawStatus: String(row?.rawStatus || row?.status || "DRAFT"),
    rejectionReason: row?.rejectionReason || null,
    qualityScore: row?.qualityScore || null,
    lastSyncedAt: row?.lastSyncedAt || null,
    lastUpdatedTime: row?.lastUpdatedTime || null,
    lastError: row?.lastError || null,
    testMessageTargetPhoneE164: String(row?.testMessageTargetPhoneE164 || ""),
    testMessageOutboundMessageId: row?.testMessageOutboundMessageId || null,
    testMessageSentAt: row?.testMessageSentAt || null,
    testMessageStatus: row?.testMessageStatus || null,
    testMessageStatusAt: row?.testMessageStatusAt || null,
    testMessageLastError: row?.testMessageLastError || null,
    testMessageLastErrorAt: row?.testMessageLastErrorAt || null,
    testSendRequired: normalizeTemplateStatus(row?.status || row?.rawStatus) === "approved",
    testSendPassed:
      normalizeTemplateStatus(row?.status || row?.rawStatus) === "approved" &&
      !!row?.testMessageSentAt &&
      !row?.testMessageLastError &&
      ["accepted", "sent", "delivered", "read"].includes(
        String(row?.testMessageStatus || "accepted").trim().toLowerCase(),
      ),
    approvedAt: row?.approvedAt || null,
    submittedAt: row?.submittedAt || null,
    createdAt: row?.createdAt || null,
    updatedAt: row?.updatedAt || null,
    preview: {
      header:
        String(row?.headerType || "TEXT")
          .trim()
          .toUpperCase() === "TEXT"
          ? renderFriendlyPreview(row?.headerText || "")
          : String(row?.headerType || "")
                .trim()
                .toUpperCase() === "IMAGE"
            ? "[Product image]"
            : "",
      body: renderFriendlyPreview(row?.bodyText || ""),
      footer: renderFriendlyPreview(row?.footerText || ""),
    },
  };
}

export function buildTemplateContext(overrides = {}) {
  return {
    ...Object.fromEntries(
      Object.values(TEMPLATE_VARIABLE_DEFINITIONS).map((row) => [
        row.key,
        row.sample,
      ]),
    ),
    ...(overrides && typeof overrides === "object" ? overrides : {}),
  };
}

export function resolveTemplateVariableValues(template, context = {}) {
  const flow = getFlowDefinition(template?.flowKey);
  const supported = new Set(flow?.supportedVariables || []);
  const source = buildTemplateContext(context);
  const headerType = String(template?.headerType || "TEXT")
    .trim()
    .toUpperCase();
  const headerVars =
    headerType === "TEXT"
      ? compileFriendlyTextToMeta(
          template?.headerText || "",
          Array.from(supported),
        ).variables
      : [];
  const bodyVars = compileFriendlyTextToMeta(
    template?.bodyText || "",
    Array.from(supported),
  ).variables;
  const headerValues = headerVars.map((key) =>
    sanitizeTemplateParameterValue(source?.[key], { key }),
  );
  const bodyValues = bodyVars.map((key) =>
    sanitizeTemplateParameterValue(source?.[key], { key }),
  );
  const urlButtons = (Array.isArray(template?.buttons) ? template.buttons : [])
    .map((button, index) => {
      if (
        String(button?.type || "").trim().toUpperCase() !== "URL"
      ) {
        return null;
      }
      const variables = compileFriendlyTextToMeta(
        button?.url || "",
        Array.from(supported),
      ).variables;
      const parameters = variables.map((key) =>
        sanitizeTemplateParameterValue(source?.[key], { key }),
      );
      return parameters.length ? { index, parameters } : null;
    })
    .filter(Boolean);
  return {
    header: fitTemplateParameterValues(
      template?.headerText || "",
      headerValues,
      60,
    ),
    body: fitTemplateParameterValues(
      template?.bodyText || "",
      bodyValues,
      1024,
    ),
    urlButtons,
    headerMediaUrl:
      headerType === "IMAGE"
        ? firstValidHttpsUrl([
            template?.useProductImageHeader === false
              ? ""
              : source?.product_image_url,
            template?.useProductImageHeader === false
              ? ""
              : source?.productImageUrl,
            template?.sampleMediaUrl,
          ])
        : "",
  };
}

export function isTemplateApproved(row) {
  return normalizeTemplateStatus(row?.status || row?.rawStatus) === "approved";
}

export function resolveAssignedTemplateForFlow({
  catalog = [],
  flows = [],
  flowKey,
}) {
  const normalizedFlowKey = normalizeFlowKey(flowKey);
  if (!normalizedFlowKey) return null;
  const templateRows = ensureManagedTemplateCatalog(catalog);
  const flowRows = ensureAutomationFlowConfigs(flows);
  const flowRow = flowRows.find((row) => row.flowKey === normalizedFlowKey);
  if (!flowRow) return null;

  const flowTemplates = templateRows.filter(
    (row) => row.flowKey === normalizedFlowKey,
  );

  if (flowRow.templateId) {
    const assignedById = templateRows.find(
      (row) => String(row?.id || "") === String(flowRow.templateId),
    );
    if (assignedById && isTemplateApproved(assignedById)) {
      return assignedById;
    }
  }
  if (flowRow.templateKey) {
    const assignedByKey = templateRows.find(
      (row) =>
        String(row?.templateKey || "").trim() ===
        String(flowRow.templateKey || "").trim(),
    );
    if (assignedByKey && isTemplateApproved(assignedByKey)) {
      return assignedByKey;
    }
  }

  const approvedDefaultPack = flowTemplates
    .filter((row) => isTemplateApproved(row) && row.source === "default_pack")
    .sort((a, b) => {
      const aTime = new Date(a?.updatedAt || a?.createdAt || 0).getTime();
      const bTime = new Date(b?.updatedAt || b?.createdAt || 0).getTime();
      return bTime - aTime;
    });
  if (approvedDefaultPack.length) return approvedDefaultPack[0];
  return null;
}

export function validateManagedTemplateInput(
  input = {},
  { existing = null } = {},
) {
  const flowKey = normalizeFlowKey(input?.flowKey || existing?.flowKey);
  const flow = getFlowDefinition(flowKey);
  if (!flow) {
    throw new Error("Unsupported automation flow");
  }
  if (!flow.supportsTemplates) {
    throw new Error("This automation flow does not support template editing");
  }

  const displayName = String(
    input?.displayName || existing?.displayName || flow.label,
  ).trim();
  if (!displayName) throw new Error("Template display name is required");
  assertTemplateTextLength("Template display name", displayName, 80);

  const language = normalizeTemplateLanguage(
    input?.language || existing?.language || TEMPLATE_LANGUAGE_EN,
  );
  if (!language) {
    throw new Error("Unsupported template language");
  }

  const allowedCategory = getFlowTemplateCategory(flow?.key);
  const requestedCategory =
    flowKey === FLOW_KEYS.CAMPAIGN
      ? input?.category || allowedCategory
      : input?.category || existing?.category || allowedCategory;
  const category = normalizeTemplateCategory(requestedCategory, allowedCategory);
  if (category !== allowedCategory) {
    throw new Error(
      `${flow?.label || "This flow"} must use a ${allowedCategory} template`,
    );
  }

  const headerType = String(input?.headerType || existing?.headerType || "TEXT")
    .trim()
    .toUpperCase();
  if (!HEADER_TYPES.has(headerType)) {
    throw new Error(
      "Only no header, text header, or image header are supported",
    );
  }
  if (headerType === "IMAGE" && !flow.supportsImageHeader) {
    throw new Error("Image headers are not enabled for this automation type");
  }

  const sampleMediaUrl =
    headerType === "IMAGE"
      ? assertHttpsUrl(
          "Sample image URL",
          input?.sampleMediaUrl || existing?.sampleMediaUrl || "",
        )
      : "";
  const useProductImageRaw =
    input?.useProductImageHeader ?? existing?.useProductImageHeader ?? true;
  const useProductImageHeader =
    headerType === "IMAGE"
      ? !["false", "0", "no", "off"].includes(
          String(useProductImageRaw || "")
            .trim()
            .toLowerCase(),
        )
      : false;

  const headerText =
    headerType === "TEXT"
      ? inferFriendlyVariablesFromSamples(
          String(input?.headerText || existing?.headerText || "").trim(),
          flow.supportedVariables || [],
        )
      : "";
  const bodyText = inferFriendlyVariablesFromSamples(
    String(input?.bodyText || existing?.bodyText || "").trim(),
    flow.supportedVariables || [],
  );
  const footerText = String(
    input?.footerText || existing?.footerText || "",
  ).trim();

  if (!bodyText) throw new Error("Template body text is required");
  if (headerType === "TEXT" && !headerText) {
    throw new Error("Text header selected but header text is empty");
  }
  if (headerType === "IMAGE" && !sampleMediaUrl) {
    throw new Error("Sample image URL is required for image header templates");
  }
  assertTemplateTextLength("Header", headerText, 60);
  assertTemplateTextLength("Body", bodyText, 1024);
  assertTemplateTextLength("Footer", footerText, 60);
  assertVariablePlacement("Header", headerText);
  assertVariablePlacement("Body", bodyText);
  if (footerText && extractFriendlyVariables(footerText).length) {
    throw new Error("Footer text cannot contain variables");
  }

  const buttons = sanitizeButtonsForFlow(
    flow,
    input?.buttons ?? existing?.buttons ?? [],
  );

  compileFriendlyTextToMeta(headerText, flow.supportedVariables || []);
  compileFriendlyTextToMeta(bodyText, flow.supportedVariables || []);

  return {
    flowKey,
    displayName,
    language,
    category,
    headerType,
    headerText,
    sampleMediaUrl,
    useProductImageHeader,
    bodyText,
    footerText,
    buttons,
    buttonPolicy: buttons.length ? "fixed" : "none",
  };
}
