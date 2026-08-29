const TOKEN_LIKE_VALUE_RE = /\b(?:shp(?:at|rt|ca|ua|pat)?|shpat|shprt)_[A-Za-z0-9_-]+\b/gi;

export const SHOPIFY_TOKEN_STATUS = Object.freeze({
  ACTIVE: "active",
  LEGACY: "legacy",
  PARTIAL: "partial",
  REFRESHING: "refreshing",
  REAUTHORIZATION_REQUIRED: "reauthorization_required",
  REVOKED: "revoked",
  UNKNOWN: "unknown",
});

export function asText(value) {
  return String(value || "").trim();
}

export function toValidDate(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function isDateExpired(value, now = new Date(), bufferMs = 0) {
  const date = toValidDate(value);
  const reference = toValidDate(now);
  if (!date || !reference) return false;
  return date.getTime() - Math.max(0, Number(bufferMs || 0)) <= reference.getTime();
}

export function normalizeTokenBundle(bundle = {}) {
  return {
    shop: asText(bundle.shop).toLowerCase(),
    accessToken: asText(bundle.accessToken),
    accessTokenExpiresAt: toValidDate(bundle.accessTokenExpiresAt),
    refreshToken: asText(bundle.refreshToken),
    refreshTokenExpiresAt: toValidDate(bundle.refreshTokenExpiresAt),
    scope: asText(bundle.scope),
    tokenType: asText(bundle.tokenType || "offline").toLowerCase(),
    source: asText(bundle.source || "unknown"),
    updatedAt: toValidDate(bundle.updatedAt),
    version: Math.max(0, Number(bundle.version || 0)),
  };
}

export function tokenBundleFromShopRecord(record = {}) {
  return normalizeTokenBundle({
    shop: record.shop,
    accessToken: record.accessToken,
    accessTokenExpiresAt: record.accessTokenExpiresAt,
    refreshToken: record.accessTokenRefreshToken,
    refreshTokenExpiresAt: record.accessTokenRefreshTokenExpiresAt,
    scope: record.scopes,
    tokenType: record.accessTokenType || "offline",
    source: "shop_record",
    updatedAt: record.accessTokenUpdatedAt || record.updatedAt,
    version: record.accessTokenVersion,
  });
}

export function tokenBundleFromSession(session = {}, metadata = {}) {
  return normalizeTokenBundle({
    shop: session.shop,
    accessToken: session.accessToken,
    accessTokenExpiresAt: session.expires,
    refreshToken: session.refreshToken,
    refreshTokenExpiresAt: session.refreshTokenExpires,
    scope: session.scope,
    tokenType: session.isOnline ? "online" : "offline",
    source: metadata.source || "shopify_session",
    updatedAt: metadata.updatedAt,
    version: metadata.version,
  });
}

export function classifyTokenBundle(value, options = {}) {
  const bundle = normalizeTokenBundle(value);
  const now = toValidDate(options.now) || new Date();
  const bufferMs = Math.max(0, Number(options.bufferMs || 0));
  const hasAccess = !!bundle.accessToken;
  const hasAccessExpiry = !!bundle.accessTokenExpiresAt;
  const hasRefresh = !!bundle.refreshToken;
  const hasRefreshExpiry = !!bundle.refreshTokenExpiresAt;
  const accessExpired = hasAccessExpiry
    ? isDateExpired(bundle.accessTokenExpiresAt, now, bufferMs)
    : false;
  const refreshExpired = hasRefreshExpiry
    ? isDateExpired(bundle.refreshTokenExpiresAt, now, 0)
    : false;
  const completeExpiring =
    hasAccess && hasAccessExpiry && hasRefresh && hasRefreshExpiry;
  const legacy =
    hasAccess && !hasAccessExpiry && !hasRefresh && !hasRefreshExpiry;

  if (bundle.tokenType === "online") {
    return {
      bundle,
      kind: "online",
      status: SHOPIFY_TOKEN_STATUS.REAUTHORIZATION_REQUIRED,
      usableNow: false,
      automaticallyRepairable: false,
      requiresReauthorization: true,
      reason: "online_token_not_valid_for_background",
    };
  }

  if (!hasAccess && !hasRefresh) {
    return {
      bundle,
      kind: "missing",
      status: SHOPIFY_TOKEN_STATUS.REAUTHORIZATION_REQUIRED,
      usableNow: false,
      automaticallyRepairable: false,
      requiresReauthorization: true,
      reason: "missing_credentials",
    };
  }

  if (completeExpiring) {
    if (refreshExpired) {
      return {
        bundle,
        kind: "expiring",
        status: SHOPIFY_TOKEN_STATUS.REAUTHORIZATION_REQUIRED,
        usableNow: !accessExpired,
        automaticallyRepairable: false,
        requiresReauthorization: true,
        reason: accessExpired
          ? "access_and_refresh_expired"
          : "refresh_expired",
      };
    }
    return {
      bundle,
      kind: "expiring",
      status: SHOPIFY_TOKEN_STATUS.ACTIVE,
      usableNow: !accessExpired,
      automaticallyRepairable: accessExpired,
      requiresReauthorization: false,
      reason: accessExpired ? "refresh_required" : "healthy_expiring",
    };
  }

  if (legacy) {
    return {
      bundle,
      kind: "legacy",
      status: SHOPIFY_TOKEN_STATUS.LEGACY,
      usableNow: true,
      automaticallyRepairable: true,
      requiresReauthorization: false,
      reason: "legacy_migration_available",
    };
  }

  if (hasRefresh && !refreshExpired) {
    return {
      bundle,
      kind: "partial",
      status: SHOPIFY_TOKEN_STATUS.PARTIAL,
      usableNow: hasAccess && !accessExpired,
      automaticallyRepairable: true,
      requiresReauthorization: false,
      reason: "refresh_can_repair_partial",
    };
  }

  return {
    bundle,
    kind: "partial",
    status: SHOPIFY_TOKEN_STATUS.PARTIAL,
    usableNow: hasAccess && !accessExpired,
    automaticallyRepairable: false,
    requiresReauthorization: accessExpired || !hasAccess,
    reason:
      hasAccess && !accessExpired
        ? "active_access_missing_refresh_metadata"
        : "broken_partial_credentials",
  };
}

function bundleQuality(value, options = {}) {
  const state = classifyTokenBundle(value, options);
  if (
    state.kind === "expiring" &&
    state.usableNow &&
    !state.requiresReauthorization
  ) {
    return 7;
  }
  // A newer canonical access token can remain usable even when a previous
  // faulty migration lost its refresh metadata. Prefer it over a stale legacy
  // or expired rotating mirror, which Shopify may already have revoked when
  // the canonical access token was issued.
  if (state.kind === "partial" && state.usableNow) return 6;
  if (state.kind === "expiring" && !state.requiresReauthorization) return 5;
  if (state.kind === "partial" && state.automaticallyRepairable) return 5;
  if (state.kind === "legacy") return 4;
  if (state.automaticallyRepairable) return 3;
  if (state.usableNow) return 2;
  if (state.kind === "partial") return 1;
  return 0;
}

export function compareTokenBundles(leftValue, rightValue, options = {}) {
  const left = normalizeTokenBundle(leftValue);
  const right = normalizeTokenBundle(rightValue);
  const qualityDelta =
    bundleQuality(left, options) - bundleQuality(right, options);
  if (qualityDelta) return qualityDelta;

  const leftAccessExpiry = left.accessTokenExpiresAt?.getTime?.() || 0;
  const rightAccessExpiry = right.accessTokenExpiresAt?.getTime?.() || 0;
  if (leftAccessExpiry !== rightAccessExpiry) {
    return leftAccessExpiry - rightAccessExpiry;
  }

  if (left.version !== right.version) return left.version - right.version;

  const leftUpdatedAt = left.updatedAt?.getTime?.() || 0;
  const rightUpdatedAt = right.updatedAt?.getTime?.() || 0;
  if (leftUpdatedAt !== rightUpdatedAt) return leftUpdatedAt - rightUpdatedAt;

  // The official app session is canonical when all other freshness signals tie.
  if (left.source === "shopify_session" && right.source !== "shopify_session") {
    return 1;
  }
  if (right.source === "shopify_session" && left.source !== "shopify_session") {
    return -1;
  }
  return 0;
}

export function selectPreferredTokenBundle(values = [], options = {}) {
  const candidates = values
    .map(normalizeTokenBundle)
    .filter((bundle) => bundle.shop && (bundle.accessToken || bundle.refreshToken));
  if (!candidates.length) return null;
  return candidates.reduce((best, candidate) =>
    compareTokenBundles(candidate, best, options) > 0 ? candidate : best,
  );
}

export function shouldRefreshTokenBundle(value, options = {}) {
  const bundle = normalizeTokenBundle(value);
  const now = toValidDate(options.now) || new Date();
  const bufferMs = Math.max(0, Number(options.bufferMs || 0));
  if (!bundle.refreshToken) return false;
  if (
    bundle.refreshTokenExpiresAt &&
    isDateExpired(bundle.refreshTokenExpiresAt, now, 0)
  ) {
    return false;
  }
  if (!bundle.accessToken || !bundle.accessTokenExpiresAt) return true;
  return isDateExpired(bundle.accessTokenExpiresAt, now, bufferMs);
}

export function getShopifyErrorStatus(error) {
  const candidates = [
    error?.statusCode,
    error?.status,
    error?.response?.statusCode,
    error?.response?.status,
    error?.response?.code,
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const match = asText(error?.message || error).match(
    /\b(400|401|403|404|408|409|422|423|429|5\d\d)\b/,
  );
  return match ? Number(match[1]) : null;
}

export function isShopifyUnauthorizedError(error) {
  return (
    getShopifyErrorStatus(error) === 401 ||
    /\bunauthorized\b/i.test(asText(error?.message || error))
  );
}

export function isTransientShopifyTokenError(error) {
  const status = getShopifyErrorStatus(error);
  if (!status) return true;
  return status === 408 || status === 423 || status === 429 || status >= 500;
}

export function isDefinitiveInvalidRefreshTokenError(error) {
  if (getShopifyErrorStatus(error) !== 401) return false;
  const body = error?.response?.body || error?.body || {};
  const errorCode = asText(body?.error || error?.code).toLowerCase();
  const description = asText(
    body?.error_description || body?.description || error?.message,
  ).toLowerCase();
  return (
    errorCode === "invalid_request" &&
    description.includes("active refresh_token")
  );
}

export function sanitizeShopifyTokenError(error) {
  const status = getShopifyErrorStatus(error);
  const body = error?.response?.body || error?.body || {};
  const code = asText(body?.error || error?.code);
  const description = asText(
    body?.error_description || body?.description || error?.message || error,
  )
    .replace(TOKEN_LIKE_VALUE_RE, "<redacted-token>")
    .slice(0, 500);
  return [
    status ? `Shopify authentication error ${status}` : "Shopify token error",
    code ? `(${code})` : "",
    description ? `- ${description}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildShopTokenUpdate(value, options = {}) {
  const bundle = normalizeTokenBundle(value);
  const classification = classifyTokenBundle(bundle, {
    now: options.now,
  });
  return {
    shop: bundle.shop,
    accessToken: bundle.accessToken || null,
    accessTokenType: bundle.tokenType || "offline",
    accessTokenUpdatedAt: toValidDate(options.updatedAt) || new Date(),
    accessTokenExpiresAt: bundle.accessTokenExpiresAt || null,
    accessTokenRefreshToken: bundle.refreshToken || null,
    accessTokenRefreshTokenExpiresAt: bundle.refreshTokenExpiresAt || null,
    accessTokenStatus: options.status || classification.status,
    accessTokenVersion: Math.max(1, Number(options.version || bundle.version || 1)),
    accessTokenMigratedAt:
      classification.kind === "expiring"
        ? toValidDate(options.migratedAt) || new Date()
        : null,
    accessTokenLastError: null,
    accessTokenLastErrorAt: null,
    ...(bundle.scope ? { scopes: bundle.scope } : {}),
  };
}

export async function executeWithOneUnauthorizedRetry({
  request,
  recover,
  isUnauthorized = isShopifyUnauthorizedError,
  onRetryUnauthorized = null,
}) {
  try {
    return await request({ retry: false, recovery: null });
  } catch (error) {
    if (!isUnauthorized(error)) throw error;
    const recovery = await recover(error);
    try {
      return await request({ retry: true, recovery });
    } catch (retryError) {
      if (isUnauthorized(retryError) && onRetryUnauthorized) {
        await onRetryUnauthorized(retryError, recovery);
      }
      throw retryError;
    }
  }
}

/**
 * A keyed async mutex. Unlike a single-flight cache, every caller runs its own
 * operation after the previous operation for that key finishes. This matters
 * because token refresh, OAuth persistence, and uninstall return different
 * result shapes and must never receive another operation's result.
 */
export function createKeyedMutex() {
  const tails = new Map();

  return {
    async run(keyValue, work) {
      const key = asText(keyValue).toLowerCase();
      if (!key) return work();

      const previous = tails.get(key) || Promise.resolve();
      let release = () => {};
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const tail = previous.catch(() => null).then(() => gate);
      tails.set(key, tail);

      await previous.catch(() => null);
      try {
        return await work();
      } finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      }
    },
    pendingCount() {
      return tails.size;
    },
  };
}

export function buildShopifyCredentialCandidateQuery() {
  return {
    $or: [
      { accessToken: { $exists: true, $nin: [null, ""] } },
      {
        accessTokenRefreshToken: {
          $exists: true,
          $nin: [null, ""],
        },
      },
      {
        accessTokenStatus: {
          $in: [
            SHOPIFY_TOKEN_STATUS.ACTIVE,
            SHOPIFY_TOKEN_STATUS.LEGACY,
            SHOPIFY_TOKEN_STATUS.PARTIAL,
            SHOPIFY_TOKEN_STATUS.REFRESHING,
          ],
        },
      },
    ],
  };
}
