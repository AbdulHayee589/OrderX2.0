function toPositiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getClientIp(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").trim();
  if (xff) return xff.split(",")[0].trim();
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}

export function createIpRateLimiter(options = {}) {
  const windowMs = toPositiveNumber(options.windowMs, 60_000);
  const max = toPositiveNumber(options.max, 120);
  const blockMs = toPositiveNumber(options.blockMs, windowMs);
  const keyPrefix = String(options.keyPrefix || "global");

  const buckets = new Map();

  const cleanup = () => {
    const now = Date.now();
    for (const [key, entry] of buckets.entries()) {
      if (entry.resetAt <= now && entry.blockedUntil <= now) {
        buckets.delete(key);
      }
    }
  };

  const cleanupTimer = setInterval(cleanup, Math.max(windowMs, 60_000));
  if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();

  return function ipRateLimit(req, res, next) {
    const now = Date.now();
    const ip = getClientIp(req);
    const key = `${keyPrefix}:${ip}`;

    let entry = buckets.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = {
        count: 0,
        resetAt: now + windowMs,
        blockedUntil: 0,
      };
      buckets.set(key, entry);
    }

    if (entry.blockedUntil > now) {
      const retryAfterSec = Math.ceil((entry.blockedUntil - now) / 1000);
      res.setHeader("Retry-After", String(retryAfterSec));
      return res.status(429).json({ error: "Too many requests" });
    }

    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);
    const resetSec = Math.ceil((entry.resetAt - now) / 1000);
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(resetSec));

    if (entry.count > max) {
      entry.blockedUntil = now + blockMs;
      const retryAfterSec = Math.ceil(blockMs / 1000);
      res.setHeader("Retry-After", String(retryAfterSec));
      return res.status(429).json({ error: "Too many requests" });
    }

    return next();
  };
}
