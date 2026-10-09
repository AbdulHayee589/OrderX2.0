import crypto from "crypto";

function safeEq(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) return false;
  try {
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function isLoopbackIp(ip) {
  const value = String(ip || "")
    .trim()
    .toLowerCase();
  return (
    value === "127.0.0.1" ||
    value === "::1" ||
    value === "::ffff:127.0.0.1" ||
    value.startsWith("127.")
  );
}

function getClientIp(req) {
  // req.ip already applies Express' trust-proxy policy. Trusting the raw
  // forwarded header here would make REQUIRE_LOOPBACK_INTERNAL spoofable.
  return String(req.ip || req.socket?.remoteAddress || "");
}

export function internalAuth(req, res, next) {
  const expected = String(process.env.INTERNAL_SYNC_SECRET || "").trim();
  const allowUnauthInternal =
    String(process.env.ALLOW_UNAUTH_INTERNAL || "").toLowerCase() === "true";

  if (!expected) {
    if (allowUnauthInternal) return next();
    return res
      .status(503)
      .json({ error: "Server misconfigured: missing INTERNAL_SYNC_SECRET" });
  }

  const token =
    req.get("X-Internal-Token") || req.get("X-Internal-Sync-Secret") || "";
  if (!safeEq(token, expected)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const requireLoopback =
    String(process.env.REQUIRE_LOOPBACK_INTERNAL || "").toLowerCase() ===
    "true";
  if (requireLoopback && !isLoopbackIp(getClientIp(req))) {
    return res.status(403).json({ error: "Forbidden" });
  }

  return next();
}
