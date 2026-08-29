import fetch from "node-fetch";
import Shop from "../models/Shop.js";

function toGraphId(value) {
  const raw = String(value || "").trim();
  return /^[0-9]{5,}$/.test(raw) ? raw : "";
}

function toDateOrNull(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function getMetaApiVersion() {
  return String(process.env.META_GRAPH_VERSION || "v25.0").trim() || "v25.0";
}

function getMetaAppCredentials() {
  const appId = String(process.env.META_APP_ID || "").trim();
  const appSecret = String(process.env.META_APP_SECRET || "").trim();
  if (!appId || !appSecret) {
    throw new Error(
      "Meta app credentials are missing on server (META_APP_ID / META_APP_SECRET)",
    );
  }
  return {
    appId,
    appSecret,
    apiVersion: getMetaApiVersion(),
  };
}

function buildMetaOAuthError(data, fallback, status = 500) {
  const err = new Error(
    String(data?.error?.message || data?.message || fallback || "Meta API request failed"),
  );
  err.meta = data || null;
  err.httpStatus = status;
  return err;
}

export function getMetaTokenExpiryDate({ expiresInSec, unixExpiresAtSec } = {}) {
  const fromExpiresIn = toPositiveInt(expiresInSec);
  if (fromExpiresIn) {
    return new Date(Date.now() + fromExpiresIn * 1000);
  }
  const fromUnix = toPositiveInt(unixExpiresAtSec);
  if (fromUnix) {
    const date = new Date(fromUnix * 1000);
    if (Number.isFinite(date.getTime())) return date;
  }
  return null;
}

export function isMetaAccessTokenExpired(value, skewSec = 120) {
  const expiresAt = toDateOrNull(value);
  if (!expiresAt) return false;
  const skewMs = Math.max(0, Number(skewSec || 0)) * 1000;
  return expiresAt.getTime() <= Date.now() + skewMs;
}

export async function exchangeMetaOAuthCode({ code, redirectUri }) {
  const { appId, appSecret, apiVersion } = getMetaAppCredentials();
  const normalizedCode = String(code || "").trim();
  const normalizedRedirect = String(redirectUri || "").trim();
  if (!normalizedCode) throw new Error("Missing Meta OAuth code");

  const url = new URL(
    `https://graph.facebook.com/${apiVersion}/oauth/access_token`,
  );
  const body = new URLSearchParams();
  body.set("client_id", appId);
  body.set("client_secret", appSecret);
  body.set("code", normalizedCode);
  body.set("grant_type", "authorization_code");
  if (normalizedRedirect) {
    body.set("redirect_uri", normalizedRedirect);
  }

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw buildMetaOAuthError(data, "Meta OAuth exchange failed", res.status);
  }
  return data;
}

export async function exchangeMetaLongLivedToken({ accessToken }) {
  const { appId, appSecret, apiVersion } = getMetaAppCredentials();
  const token = String(accessToken || "").trim();
  if (!token) throw new Error("Missing access token for refresh");

  const url = new URL(`https://graph.facebook.com/${apiVersion}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("fb_exchange_token", token);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw buildMetaOAuthError(data, "Meta token refresh failed", res.status);
  }
  return data;
}

export async function debugMetaAccessToken({ accessToken }) {
  const token = String(accessToken || "").trim();
  if (!token) throw new Error("Missing access token for debug");
  const { appId, appSecret, apiVersion } = getMetaAppCredentials();

  const url = new URL(`https://graph.facebook.com/${apiVersion}/debug_token`);
  url.searchParams.set("input_token", token);
  url.searchParams.set("access_token", `${appId}|${appSecret}`);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw buildMetaOAuthError(data, "Meta token debug failed", res.status);
  }
  return data;
}

export function getMetaTokenDebugHints(debugPayload) {
  const data = debugPayload?.data || {};
  const hints = new Set();
  const profileId = toGraphId(data?.profile_id);
  if (profileId) hints.add(profileId);

  const granularScopes = Array.isArray(data?.granular_scopes)
    ? data.granular_scopes
    : [];
  for (const scopeEntry of granularScopes) {
    const targetIds = Array.isArray(scopeEntry?.target_ids)
      ? scopeEntry.target_ids
      : [];
    for (const targetId of targetIds) {
      const id = toGraphId(targetId);
      if (id) hints.add(id);
    }
  }

  const debugExpiresAt = getMetaTokenExpiryDate({
    unixExpiresAtSec: data?.expires_at,
  });

  return {
    tokenIsValid: data?.is_valid === true,
    profileId: profileId || "",
    hintIds: [...hints],
    debugExpiresAt,
    granularScopes,
  };
}

function refreshErrorMessage(err) {
  return String(err?.message || "Meta token refresh failed").slice(0, 500);
}

export async function maybeRefreshByonAccessToken({
  shop,
  ownNumber,
  force = false,
  minRemainingMs = 7 * 24 * 60 * 60 * 1000,
  cooldownMs = 6 * 60 * 60 * 1000,
  unknownExpiryRetryMs = 7 * 24 * 60 * 60 * 1000,
} = {}) {
  const shopDomain = String(shop || "").trim();
  const own = ownNumber && typeof ownNumber === "object" ? ownNumber : {};
  const token = String(own?.accessToken || "").trim();
  const currentExpiresAt = toDateOrNull(own?.accessTokenExpiresAt);
  const lastAttemptAt = toDateOrNull(own?.accessTokenRefreshAttemptedAt);
  const nowMs = Date.now();
  const now = new Date(nowMs);

  if (!token) {
    return {
      ok: false,
      refreshed: false,
      token: "",
      expiresAt: currentExpiresAt,
      skippedReason: "missing_token",
    };
  }

  const hasRecentAttempt =
    !!lastAttemptAt && nowMs - lastAttemptAt.getTime() < Math.max(0, Number(cooldownMs || 0));
  let due = !!force;
  if (!due && currentExpiresAt) {
    due = currentExpiresAt.getTime() <= nowMs + Math.max(0, Number(minRemainingMs || 0));
  }
  if (!due && !currentExpiresAt) {
    due =
      !lastAttemptAt ||
      nowMs - lastAttemptAt.getTime() >=
        Math.max(0, Number(unknownExpiryRetryMs || 0));
  }
  if (!due || (!force && hasRecentAttempt)) {
    return {
      ok: true,
      refreshed: false,
      token,
      expiresAt: currentExpiresAt,
      skippedReason: !due ? "not_due" : "cooldown",
    };
  }

  let nextToken = token;
  let nextExpiresAt = currentExpiresAt;
  let refreshErr = null;
  let refreshAttempted = false;
  let debugPayload = null;
  let refreshed = false;

  try {
    refreshAttempted = true;
    const refreshData = await exchangeMetaLongLivedToken({ accessToken: token });
    const candidateToken = String(refreshData?.access_token || "").trim();
    if (candidateToken) {
      nextToken = candidateToken;
      refreshed = candidateToken !== token;
    }
    const refreshedExpiry = getMetaTokenExpiryDate({
      expiresInSec: refreshData?.expires_in,
    });
    if (refreshedExpiry) nextExpiresAt = refreshedExpiry;
  } catch (err) {
    refreshErr = err;
  }

  try {
    debugPayload = await debugMetaAccessToken({ accessToken: nextToken });
    const hints = getMetaTokenDebugHints(debugPayload);
    if (hints?.debugExpiresAt) {
      nextExpiresAt = hints.debugExpiresAt;
    }
    if (!hints?.tokenIsValid) {
      const invalidErr = new Error("Meta access token is invalid");
      invalidErr.httpStatus = 401;
      throw invalidErr;
    }
  } catch (err) {
    if (!refreshErr) refreshErr = err;
  }

  if (shopDomain) {
    const baseSet = {
      "whatsappSender.ownNumber.accessTokenRefreshAttemptedAt": now,
      ...(nextToken
        ? {
            "whatsappSender.ownNumber.accessToken": nextToken,
            "whatsappSender.ownNumber.accessTokenUpdatedAt": now,
          }
        : {}),
      ...(nextExpiresAt
        ? { "whatsappSender.ownNumber.accessTokenExpiresAt": nextExpiresAt }
        : {}),
    };

    if (refreshErr && !debugPayload) {
      await Shop.updateOne(
        { shop: shopDomain },
        {
          $set: {
            ...baseSet,
            "whatsappSender.ownNumber.accessTokenRefreshError":
              refreshErrorMessage(refreshErr),
            "whatsappSender.ownNumber.accessTokenRefreshErrorAt": now,
          },
        },
      ).catch(() => {});
    } else {
      await Shop.updateOne(
        { shop: shopDomain },
        {
          $set: {
            ...baseSet,
            "whatsappSender.ownNumber.accessTokenRefreshError": null,
            "whatsappSender.ownNumber.accessTokenRefreshErrorAt": null,
          },
        },
      ).catch(() => {});
    }
  }

  return {
    ok: !refreshErr || !!debugPayload,
    refreshed,
    refreshAttempted,
    token: nextToken,
    expiresAt: nextExpiresAt,
    debugPayload,
    error: refreshErr,
  };
}
