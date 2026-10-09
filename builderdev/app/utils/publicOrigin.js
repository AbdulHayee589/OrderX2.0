const LOCAL_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i;

function safeOrigin(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function toHttpsOrigin(raw) {
  const origin = safeOrigin(raw);
  if (!origin) return "";
  if (LOCAL_ORIGIN_RE.test(origin)) return origin;
  try {
    const url = new URL(origin);
    return `https://${url.host}`;
  } catch {
    return "";
  }
}

function isShopifyAdminOrigin(origin) {
  try {
    return new URL(origin).hostname.toLowerCase() === "admin.shopify.com";
  } catch {
    return false;
  }
}

export function resolvePublicAppOrigin(requestUrlOrOrigin, envUrl = "") {
  const requestOrigin = safeOrigin(requestUrlOrOrigin);
  const normalizedRequestOrigin = toHttpsOrigin(requestOrigin);
  if (
    normalizedRequestOrigin &&
    !LOCAL_ORIGIN_RE.test(normalizedRequestOrigin)
  ) {
    return normalizedRequestOrigin;
  }

  const normalizedEnvOrigin = toHttpsOrigin(envUrl);
  if (normalizedEnvOrigin) return normalizedEnvOrigin;

  return normalizedRequestOrigin || requestOrigin || safeOrigin(envUrl) || "";
}

export function resolveRequestAppOrigin(request, envUrl = "") {
  const requestUrl = (() => {
    try {
      return new URL(request?.url || "");
    } catch {
      return null;
    }
  })();
  const headers = request?.headers;
  const browserOrigin = String(headers?.get?.("origin") || "").trim();
  const forwardedHost = String(headers?.get?.("x-forwarded-host") || "")
    .split(",")[0]
    .trim();
  const forwardedProto =
    String(headers?.get?.("x-forwarded-proto") || "")
      .split(",")[0]
      .trim() || "https";
  const forwardedOrigin = forwardedHost
    ? `${forwardedProto}://${forwardedHost}`
    : "";

  for (const candidate of [
    forwardedOrigin,
    requestUrl?.origin || "",
    browserOrigin,
  ]) {
    const resolved = resolvePublicAppOrigin(candidate);
    if (
      resolved &&
      !LOCAL_ORIGIN_RE.test(resolved) &&
      !isShopifyAdminOrigin(resolved)
    ) {
      return resolved;
    }
  }

  return resolvePublicAppOrigin(requestUrl?.origin || "", envUrl);
}
