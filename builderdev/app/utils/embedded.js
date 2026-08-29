// builderdev/app/utils/embedded.js
// Helper for embedded Shopify apps: keep `shop`, `host`, and `embedded=1`
// query params across in-app navigation so auth/billing redirects keep working.

// Preserve Shopify embedded frame query params across in-app navigation.
// Dropping these can trigger an auth bounce/redirect inside Shopify admin (blank flash).
const EMBEDDED_KEYS = [
  "shop",
  "host",
  "embedded",
  "hmac",
  "timestamp",
  "locale",
  "protocol",
  "session",
  "id_token",
  "appLoadId",
];

function isExternalUrl(href) {
  const h = String(href || "");
  return (
    h.startsWith("http://") ||
    h.startsWith("https://") ||
    h.startsWith("mailto:") ||
    h.startsWith("tel:")
  );
}

export function withShopParams(href, locationSearch) {
  const h = String(href || "");
  if (!h) return h;
  if (isExternalUrl(h)) return h;

  const url = new URL(h, "https://app.local");
  const from = new URLSearchParams(String(locationSearch || ""));

  for (const key of EMBEDDED_KEYS) {
    const v = from.get(key);
    if (v && !url.searchParams.has(key)) url.searchParams.set(key, v);
  }

  const qs = url.searchParams.toString();
  return `${url.pathname}${qs ? `?${qs}` : ""}${url.hash || ""}`;
}
