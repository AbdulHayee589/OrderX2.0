function toBooleanEnv(name, fallback = false) {
  const raw = String(process.env[name] ?? "")
    .trim()
    .toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

function safeUrlOrigin(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function csvSet(raw) {
  const value = String(raw || "").trim();
  if (!value) return new Set();
  return new Set(
    value
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );
}

export function buildCorsOptions() {
  const allowAll = toBooleanEnv("CORS_ALLOW_ALL", false);
  const allowSet = csvSet(process.env.CORS_ALLOWED_ORIGINS);

  const configuredOrigins = [
    process.env.APP_URL,
    process.env.SHOPIFY_APP_URL,
    process.env.MARKETING_SITE_URL,
    process.env.MESSENGER_APP_URL,
    process.env.PUBLIC_SITE_URL,
  ];
  for (const configuredOrigin of configuredOrigins) {
    const origin = safeUrlOrigin(configuredOrigin);
    if (origin) allowSet.add(origin);
  }

  // The public messenger is hosted on the OrderX marketing domain. Keep the
  // allowlist explicit so credentialed agent sessions are never exposed to an
  // arbitrary origin, even when an environment variable is omitted.
  allowSet.add("https://orderx.com");
  allowSet.add("https://www.orderx.com");

  return {
    origin(origin, callback) {
      if (allowAll) return callback(null, true);
      if (!origin) return callback(null, true);
      if (allowSet.has(origin)) return callback(null, true);
      return callback(null, false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-CSRF-Token",
      "X-Internal-Token",
      "X-Internal-Sync-Secret",
    ],
    credentials: true,
    optionsSuccessStatus: 204,
    maxAge: 600,
  };
}

function isHttpsRequest(req) {
  const forwarded = String(
    req.headers["x-forwarded-proto"] || "",
  ).toLowerCase();
  return req.secure || forwarded.includes("https");
}

export function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");

  if (isHttpsRequest(req)) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload",
    );
  }

  return next();
}

function hasForbiddenKeys(value, depth = 0, options = {}) {
  const allowDottedKeys = options.allowDottedKeys || null;
  if (depth > 20) return true;
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => hasForbiddenKeys(item, depth + 1, options));
  }

  for (const [key, child] of Object.entries(value)) {
    const isAllowedDotted =
      key.includes(".") && allowDottedKeys && allowDottedKeys.has(String(key));
    if (
      key === "__proto__" ||
      key === "prototype" ||
      key === "constructor" ||
      key.startsWith("$") ||
      (key.includes(".") && !isAllowedDotted)
    ) {
      return true;
    }
    if (hasForbiddenKeys(child, depth + 1, options)) return true;
  }

  return false;
}

const META_ALLOWED_DOTTED_QUERY_KEYS = new Set([
  "hub.mode",
  "hub.verify_token",
  "hub.challenge",
]);

function isMetaWebhookVerificationRequest(req) {
  const path = String(req.path || "");
  const baseUrl = String(req.baseUrl || "");
  const original = String(req.originalUrl || "");
  const isMountedWebhookPath = baseUrl === "/whatsapp" && path === "/webhook";
  const isDirectWebhookPath =
    path === "/whatsapp/webhook" || original.startsWith("/whatsapp/webhook");
  const isWebhookPath = isMountedWebhookPath || isDirectWebhookPath;

  return String(req.method || "").toUpperCase() === "GET" && isWebhookPath;
}

export function rejectSuspiciousPayload(req, res, next) {
  const keyScanOptions = isMetaWebhookVerificationRequest(req)
    ? { allowDottedKeys: META_ALLOWED_DOTTED_QUERY_KEYS }
    : undefined;

  if (
    hasForbiddenKeys(req.query, 0, keyScanOptions) ||
    hasForbiddenKeys(req.body, 0, keyScanOptions)
  ) {
    return res.status(400).json({ error: "Invalid request payload" });
  }
  return next();
}

export function validateSecurityConfig() {
  const warnings = [];
  const errors = [];
  const isProd =
    String(process.env.NODE_ENV || "").toLowerCase() === "production";

  if (isProd && !process.env.INTERNAL_SYNC_SECRET) {
    errors.push(
      "INTERNAL_SYNC_SECRET is required for frontend-to-backend requests.",
    );
  }

  if (
    isProd &&
    !process.env.WA_APP_SECRET &&
    !process.env.WA_SECRET
  ) {
    errors.push(
      "WA_APP_SECRET or WA_SECRET is required for WhatsApp webhook verification.",
    );
  }

  if (
    isProd &&
    !process.env.WA_TOKEN_SECRET &&
    !process.env.INTERNAL_SYNC_SECRET
  ) {
    errors.push(
      "WA_TOKEN_SECRET or INTERNAL_SYNC_SECRET is missing; WhatsApp action links cannot be signed.",
    );
  }

  if (isProd) {
    const required = [
      "SHOPIFY_API_KEY",
      "SHOPIFY_API_SECRET",
      "APP_URL",
      "WA_PHONE_NUMBER_ID",
      "WA_ACCESS_TOKEN",
      "WA_VERIFY_TOKEN",
      "META_APP_ID",
      "META_APP_SECRET",
      "META_EMBEDDED_SIGNUP_CONFIG_ID",
    ];
    for (const name of required) {
      if (!String(process.env[name] || "").trim()) {
        errors.push(`${name} is required in production.`);
      }
    }

    if (process.env.ALLOW_UNAUTH_INTERNAL === "true") {
      errors.push("ALLOW_UNAUTH_INTERNAL must not be enabled in production.");
    }
    if (process.env.ALLOW_UNSIGNED_WA_WEBHOOK === "true") {
      errors.push("ALLOW_UNSIGNED_WA_WEBHOOK must not be enabled in production.");
    }

    if (process.env.ADMIN_PASSWORD || process.env.ADMIN_SECOND_FACTOR) {
      warnings.push(
        "Use salted ADMIN_PASSWORD_HASH and ADMIN_SECOND_FACTOR_HASH values instead of plaintext admin credentials.",
      );
    }

    for (const name of ["APP_URL", "SHOPIFY_APP_URL"]) {
      const value = String(process.env[name] || "").trim();
      if (!value) continue;
      try {
        if (new URL(value).protocol !== "https:") {
          errors.push(`${name} must use HTTPS in production.`);
        }
      } catch {
        errors.push(`${name} must be a valid absolute URL.`);
      }
    }
  }

  const mongoUri = String(process.env.MONGO_URI || "");
  if (isProd && mongoUri.startsWith("mongodb://") && !mongoUri.includes("@")) {
    warnings.push(
      "MONGO_URI appears to have no DB auth segment (@); use authenticated DB credentials.",
    );
  }

  return { warnings, errors };
}

export function jsonBodyLimit() {
  const raw = String(process.env.JSON_BODY_LIMIT || "").trim();
  return raw || "1mb";
}
