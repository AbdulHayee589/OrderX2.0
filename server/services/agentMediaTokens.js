import crypto from "node:crypto";

const MEDIA_URL_TTL_SECONDS = 10 * 60;

function secret() {
  return String(
    process.env.AGENT_MEDIA_SIGNING_SECRET ||
      process.env.INTERNAL_API_SECRET ||
      process.env.SHOPIFY_API_SECRET ||
      "",
  ).trim();
}

function signature(messageId, expiresAt) {
  const key = secret();
  if (!key) return "";
  return crypto
    .createHmac("sha256", key)
    .update(`${String(messageId || "")}:${Number(expiresAt || 0)}`)
    .digest("base64url");
}

export function createAgentMediaPath(messageId, now = Date.now()) {
  const expiresAt = Math.floor(now / 1000) + MEDIA_URL_TTL_SECONDS;
  const sig = signature(messageId, expiresAt);
  return `/agent/media/${encodeURIComponent(messageId)}?e=${expiresAt}&s=${encodeURIComponent(sig)}`;
}

export function isValidAgentMediaSignature(messageId, expiresAt, value) {
  const expires = Number(expiresAt || 0);
  const provided = String(value || "");
  if (!provided || !Number.isFinite(expires) || expires <= Date.now() / 1000) {
    return false;
  }
  const expected = signature(messageId, expires);
  if (!expected) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
