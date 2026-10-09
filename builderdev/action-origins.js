function urlHost(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.host.toLowerCase();
  } catch {
    return "";
  }
}

function configuredPattern(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw.includes("://") || raw.includes("/") || /\s/.test(raw)) {
    return "";
  }
  return raw;
}

export function getAllowedActionOrigins(env = process.env) {
  const origins = new Set();

  for (const value of [
    env.SHOPIFY_APP_URL,
    env.APP_URL,
    env.FRONTEND_URL,
    env.HOST,
  ]) {
    const host = urlHost(value);
    if (host) origins.add(host);
  }

  for (const value of String(
    env.REACT_ROUTER_ALLOWED_ACTION_ORIGINS || "",
  ).split(",")) {
    const host = urlHost(value);
    const pattern = host || configuredPattern(value);
    if (pattern) origins.add(pattern);
  }

  return [...origins];
}
