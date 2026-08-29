import Shop from "../models/Shop.js";
import { getAdminClient } from "../utils/shopifyAdmin.js";
import { getDefaultStoreCountryCode } from "./countryPricing.js";

const STORE_CONTEXT_MAX_AGE_MS = Number(
  process.env.STORE_CONTEXT_MAX_AGE_MS || 7 * 24 * 60 * 60 * 1000,
);

function toValidDate(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export async function maybeSyncStoreContext({
  shop,
  accessToken,
  force = false,
}) {
  const shopDomain = String(shop || "").trim();
  const token = String(accessToken || "").trim();
  if (!shopDomain) return null;

  const existing = await Shop.findOne({ shop: shopDomain })
    .select({
      storeCountryCode: 1,
      storeCountryName: 1,
      storeCurrencyCode: 1,
      storeContextSyncedAt: 1,
    })
    .lean();

  const lastSyncedAt = toValidDate(existing?.storeContextSyncedAt);
  const isFresh =
    !force &&
    existing?.storeCountryCode &&
    lastSyncedAt &&
    Date.now() - lastSyncedAt.getTime() < STORE_CONTEXT_MAX_AGE_MS;
  if (isFresh) return existing;

  const admin = await getAdminClient(shopDomain, { accessToken: token });
  const response = await admin.query({
    data: `#graphql
      query StoreContext {
        shop {
          currencyCode
          billingAddress {
            country
            countryCodeV2
          }
        }
      }
    `,
  });

  const shopNode = response?.body?.data?.shop || {};
  const billingAddress = shopNode?.billingAddress || {};
  const storeCountryCode = String(
    billingAddress?.countryCodeV2 || existing?.storeCountryCode || "",
  )
    .trim()
    .toUpperCase();
  const storeCountryName = String(
    billingAddress?.country || existing?.storeCountryName || "",
  ).trim();
  const storeCurrencyCode = String(
    shopNode?.currencyCode || existing?.storeCurrencyCode || "",
  )
    .trim()
    .toUpperCase();
  const update = {
    storeCountryCode: storeCountryCode || getDefaultStoreCountryCode(),
    storeCountryName:
      storeCountryName || existing?.storeCountryName || storeCountryCode || null,
    storeCurrencyCode: storeCurrencyCode || existing?.storeCurrencyCode || null,
    storeContextSyncedAt: new Date(),
  };

  await Shop.updateOne({ shop: shopDomain }, { $set: update });
  return update;
}
