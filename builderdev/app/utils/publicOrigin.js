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

