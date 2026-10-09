import "@shopify/shopify-app-react-router/adapters/node";
import "./env.server.js";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  BillingReplacementBehavior,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import persistentSessionStorage from "./sessionStorage.server";

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const BILLING_CURRENCY = process.env.BILLING_CURRENCY || "USD";
const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/app-auth",
  sessionStorage: persistentSessionStorage,
  distribution: AppDistribution.AppStore,
  useOnlineTokens: false,
  // Shopify Billing API plans (used by authenticate.admin(...).billing.* helpers)
  billing: {
    own_number_scale_10: {
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          interval: BillingInterval.Every30Days,
          amount: envNumber("BILLING_OWN_NUMBER_SCALE_10_PRICE", 10),
          currencyCode: BILLING_CURRENCY,
        },
        {
          interval: BillingInterval.Usage,
          amount: envNumber("BILLING_OWN_NUMBER_SCALE_10_USAGE_CAP", 100),
          currencyCode: BILLING_CURRENCY,
          terms:
            "USD 0.01 per outbound OrderX message after 7500 included messages each 30-day billing cycle.",
        },
      ],
    },
    own_number_starter_5: {
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          interval: BillingInterval.Every30Days,
          amount: envNumber("BILLING_OWN_NUMBER_STARTER_5_PRICE", 5),
          currencyCode: BILLING_CURRENCY,
        },
        {
          interval: BillingInterval.Usage,
          amount: envNumber("BILLING_OWN_NUMBER_STARTER_5_USAGE_CAP", 100),
          currencyCode: BILLING_CURRENCY,
          terms:
            "USD 0.01 per outbound OrderX message after 2500 included messages each 30-day billing cycle.",
        },
      ],
    },
    own_number_flat_8: {
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          interval: BillingInterval.Every30Days,
          amount: envNumber("BILLING_OWN_NUMBER_FLAT_8_PRICE", 8),
          currencyCode: BILLING_CURRENCY,
        },
        {
          interval: BillingInterval.Usage,
          amount: envNumber("BILLING_OWN_NUMBER_FLAT_8_USAGE_CAP", 100),
          currencyCode: BILLING_CURRENCY,
          terms:
            "USD 0.01 per outbound OrderX message after 7500 included messages each 30-day billing cycle.",
        },
      ],
    },
    own_number_unlimited_15: {
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          interval: BillingInterval.Every30Days,
          amount: envNumber("BILLING_OWN_NUMBER_UNLIMITED_15_PRICE", 20),
          currencyCode: BILLING_CURRENCY,
        },
      ],
    },

    orderx_metered_4: {
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          interval: BillingInterval.Every30Days,
          amount: envNumber("BILLING_ORDERX_METERED_4_PRICE", 2.99),
          currencyCode: BILLING_CURRENCY,
        },
        {
          interval: BillingInterval.Usage,
          amount: envNumber("BILLING_ORDERX_METERED_USAGE_CAP", 30),
          currencyCode:
            process.env.BILLING_ORDERX_METERED_USAGE_CURRENCY || "USD",
          terms:
            "Country-based rate per WhatsApp message sent through OrderX. Recipient-country rates apply.",
        },
      ],
    },
    // Legacy OrderX managed-number plans remain defined so already-active
    // subscriptions continue syncing correctly, but they are no longer shown
    // in the pricing UI.
    lite_20: {
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          interval: BillingInterval.Every30Days,
          amount: envNumber("BILLING_LITE_20_PRICE", 5),
          currencyCode: BILLING_CURRENCY,
        },
      ],
    },
    basic_50: {
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          interval: BillingInterval.Every30Days,
          amount: envNumber("BILLING_BASIC_50_PRICE", 10),
          currencyCode: BILLING_CURRENCY,
        },
      ],
    },
    starter_100: {
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          interval: BillingInterval.Every30Days,
          amount: envNumber("BILLING_STARTER_100_PRICE", 15),
          currencyCode: BILLING_CURRENCY,
        },
      ],
    },
    medium_200: {
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          interval: BillingInterval.Every30Days,
          amount: envNumber("BILLING_MEDIUM_200_PRICE", 25),
          currencyCode: BILLING_CURRENCY,
        },
      ],
    },
    growth_300: {
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          interval: BillingInterval.Every30Days,
          amount: envNumber("BILLING_GROWTH_300_PRICE", 40),
          currencyCode: BILLING_CURRENCY,
        },
      ],
    },
    plus_400: {
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          interval: BillingInterval.Every30Days,
          amount: envNumber("BILLING_PLUS_400_PRICE", 50),
          currencyCode: BILLING_CURRENCY,
        },
      ],
    },
    pro_500: {
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          interval: BillingInterval.Every30Days,
          amount: envNumber("BILLING_PRO_500_PRICE", 60),
          currencyCode: BILLING_CURRENCY,
        },
      ],
    },
    scale_1000: {
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          interval: BillingInterval.Every30Days,
          amount: envNumber("BILLING_SCALE_1000_PRICE", 130),
          currencyCode: BILLING_CURRENCY,
        },
      ],
    },
    enterprise_2000: {
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          interval: BillingInterval.Every30Days,
          amount: envNumber("BILLING_ENTERPRISE_2000_PRICE", 200),
          currencyCode: BILLING_CURRENCY,
        },
      ],
    },
  },
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
