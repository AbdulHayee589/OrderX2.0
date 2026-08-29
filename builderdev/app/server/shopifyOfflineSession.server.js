import { sessionStorage } from "../shopify.server";
import { assertCompleteOfflineSession } from "../sessionStorage.server";
import { backendPost } from "./backend.server";

const inFlightOfflineSessions = new Map();
const inFlightShopPreparation = new Map();

export function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function isDeprecatedOfflineSession(session) {
  return (
    !!session?.accessToken &&
    session?.isOnline !== true &&
    !session?.refreshToken &&
    !toIso(session?.expires)
  );
}

export function offlineSessionIdForShop(shop) {
  const shopDomain = String(shop || "").trim().toLowerCase();
  return shopDomain ? `offline_${shopDomain}` : "";
}

async function loadAndMigrateOfflineSessionUnlocked(shop, fallbackSession) {
  const offlineSessionId = offlineSessionIdForShop(shop);
  const offlineSession =
    (await sessionStorage.loadSession(offlineSessionId).catch(() => null)) ||
    fallbackSession ||
    null;

  if (!offlineSession?.accessToken) return null;
  assertCompleteOfflineSession(offlineSession);
  // authenticate.admin() owns interactive token exchange/refresh. This helper
  // only reads and forwards the resulting complete offline session; it never
  // rotates a second refresh token in parallel with backend workers.
  return offlineSession;
}

export function loadAndMigrateOfflineSession(shop, fallbackSession) {
  const key = String(shop || "").trim().toLowerCase();
  if (!key) return Promise.resolve(null);
  if (inFlightOfflineSessions.has(key)) {
    return inFlightOfflineSessions.get(key);
  }
  const pending = loadAndMigrateOfflineSessionUnlocked(shop, fallbackSession)
    .finally(() => inFlightOfflineSessions.delete(key));
  inFlightOfflineSessions.set(key, pending);
  return pending;
}

export function prepareShopifyOfflineSession({
  shop,
  fallbackSession = null,
  host = "",
} = {}) {
  const key = String(shop || "").trim().toLowerCase();
  if (!key) return Promise.resolve(null);
  if (inFlightShopPreparation.has(key)) {
    return inFlightShopPreparation.get(key);
  }

  const pending = (async () => {
    const offlineSession = await loadAndMigrateOfflineSession(
      key,
      fallbackSession,
    );

    if (offlineSession?.accessToken) {
      await backendPost("/internal/sync", key, {
        accessToken: offlineSession.accessToken,
        tokenType: "offline",
        host: String(host || offlineSession.host || "").trim(),
        scopes: offlineSession.scope || fallbackSession?.scope || "",
        ...(toIso(offlineSession.expires)
          ? { accessTokenExpiresAt: toIso(offlineSession.expires) }
          : {}),
        ...(offlineSession.refreshToken
          ? { refreshToken: offlineSession.refreshToken }
          : {}),
        ...(toIso(offlineSession.refreshTokenExpires)
          ? {
              refreshTokenExpiresAt: toIso(
                offlineSession.refreshTokenExpires,
              ),
            }
          : {}),
      });
    }

    // Keep billing synchronization ordered after token migration/sync. The
    // shell and dashboard resource routes share this in-flight promise, so a
    // dashboard cannot race ahead with stale billing immediately after plan
    // approval or reinstall.
    await backendPost("/api/billing/sync", key, {}).catch(() => null);
    return offlineSession;
  })().finally(() => inFlightShopPreparation.delete(key));

  inFlightShopPreparation.set(key, pending);
  return pending;
}
