import Shop from "../models/Shop.js";
import { isMetaAccessTokenExpired } from "./metaByonAuth.js";
import { resolveOwnNumberRegistrationStatus } from "./ownNumberRegistration.js";
import { getPlan, PLAN_BILLING_TYPES, SENDER_MODES } from "./plans.js";

export const AGENT_BILLING_TEST_SHOP = "testingstore-1234567932.myshopify.com";

const DISCONNECTED_OWN_NUMBER_STATUSES = new Set([
  "not_started",
  "collecting_details",
  "meta_connect_pending",
  "registration_pending",
  "templates_pending",
  "reauth_required",
  "error",
]);

function asText(value) {
  return String(value || "").trim();
}

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function isAgentBillingTestShop(shop) {
  return asText(shop).toLowerCase() === AGENT_BILLING_TEST_SHOP;
}

export function isStoredAgentBillingActive({
  billing = {},
  plan = {},
  now = new Date(),
} = {}) {
  if (billing?.hardStoppedAt) return false;

  const current = toDate(now) || new Date();
  const status = asText(billing?.status).toUpperCase();
  if (status === "TRIAL") {
    const trialEndsAt = toDate(billing?.trialEndsAt);
    return !!trialEndsAt && trialEndsAt.getTime() > current.getTime();
  }
  if (status !== "ACTIVE") return false;

  // Shopify-backed subscriptions remain active while Shopify reports their
  // subscription ID. Renewal sync advances the period end independently.
  if (asText(billing?.subscriptionId)) return true;
  if (asText(plan?.billingType) === PLAN_BILLING_TYPES.FREE_CAP) return true;

  const periodEndsAt = toDate(billing?.currentPeriodEnd);
  return !periodEndsAt || periodEndsAt.getTime() > current.getTime();
}

export function evaluateAgentFeatureAccess({
  shop,
  billing = {},
  plan = {},
  ownNumber = {},
  now = new Date(),
} = {}) {
  const shopDomain = asText(shop).toLowerCase();
  const testBillingBypass = isAgentBillingTestShop(shopDomain);
  const byonPlan = asText(plan?.senderMode) === SENDER_MODES.OWN_NUMBER;
  const billingActive = isStoredAgentBillingActive({ billing, plan, now });

  const ownStatus = asText(ownNumber?.status).toLowerCase();
  const registrationStatus = resolveOwnNumberRegistrationStatus(ownNumber);
  const templatesApproved =
    Array.isArray(ownNumber?.templates) &&
    ownNumber.templates.length > 0 &&
    ownNumber.templates.every(
      (template) => asText(template?.status).toLowerCase() === "approved",
    );
  const senderStatusReady =
    ownStatus === "ready" ||
    (!DISCONNECTED_OWN_NUMBER_STATUSES.has(ownStatus) && templatesApproved);
  const senderConnected = Boolean(
    asText(ownNumber?.phoneNumberId) &&
    asText(ownNumber?.accessToken) &&
    !isMetaAccessTokenExpired(ownNumber?.accessTokenExpiresAt) &&
    registrationStatus === "registered" &&
    senderStatusReady,
  );

  const base = {
    allowed: false,
    code: "agent_feature_unavailable",
    reason: "Agent Accounts are unavailable for this store.",
    planKey: asText(plan?.key || billing?.planKey) || null,
    byonPlan,
    billingActive,
    senderConnected,
    testBillingBypass,
  };

  if (!byonPlan) {
    return {
      ...base,
      code: "agent_byon_required",
      reason:
        "Agent Accounts are available only on Your Own Number plans. Switch to BYON and connect the merchant's WhatsApp number first.",
    };
  }
  if (!billingActive && !testBillingBypass) {
    return {
      ...base,
      code: "agent_billing_inactive",
      reason:
        "The merchant's Your Own Number plan is not active. Activate the BYON plan before agents can access Messenger.",
    };
  }
  if (!senderConnected) {
    return {
      ...base,
      code: "agent_sender_not_connected",
      reason:
        "The merchant's own WhatsApp number is not connected and ready. Finish or reconnect the BYON setup first.",
    };
  }

  return {
    ...base,
    allowed: true,
    code: "agent_feature_ready",
    reason: "Agent Accounts are ready on this connected BYON sender.",
  };
}

export async function getAgentFeatureAccess(shop, { now = new Date() } = {}) {
  const shopDomain = asText(shop).toLowerCase();
  if (!shopDomain) {
    return evaluateAgentFeatureAccess({ shop: "", now });
  }

  const record = await Shop.findOne({ shop: shopDomain })
    .select({ billing: 1, "whatsappSender.ownNumber": 1 })
    .lean();
  const billing = record?.billing || {};
  const plan = getPlan(billing?.planKey);
  return evaluateAgentFeatureAccess({
    shop: shopDomain,
    billing,
    plan,
    ownNumber: record?.whatsappSender?.ownNumber || {},
    now,
  });
}

export async function requireAgentFeatureAccess(shop, options = {}) {
  const access = await getAgentFeatureAccess(shop, options);
  if (access.allowed) return access;

  const error = new Error(access.reason);
  error.status = 403;
  error.code = access.code;
  error.feature = access;
  throw error;
}
