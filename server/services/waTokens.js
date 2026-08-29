// server/services/waTokens.js
import crypto from "crypto";

/**
 * Create a one-time token and store only its hash.
 * Hash is HMAC(secret, token) so DB leak doesn't reveal tokens.
 */

function getSecret() {
  const s = process.env.WA_TOKEN_SECRET || process.env.INTERNAL_SYNC_SECRET;
  if (!s) throw new Error("Missing WA_TOKEN_SECRET (or INTERNAL_SYNC_SECRET)");
  return s;
}

export function generateRawToken() {
  // 32 bytes -> 64 hex chars
  return crypto.randomBytes(32).toString("hex");
}

export function hashToken(rawToken) {
  const secret = getSecret();
  return crypto
    .createHmac("sha256", secret)
    .update(String(rawToken))
    .digest("hex");
}

export function makeTokensPair() {
  const confirmToken = generateRawToken();
  const cancelToken = generateRawToken();

  return {
    confirmToken,
    cancelToken,
    confirmTokenHash: hashToken(confirmToken),
    cancelTokenHash: hashToken(cancelToken),
  };
}

export function safeEq(a, b) {
  if (!a || !b) return false;
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function isExpired(expiresAt) {
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() < Date.now();
}
