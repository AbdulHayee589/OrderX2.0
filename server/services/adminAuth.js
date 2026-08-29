import crypto from "crypto";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const CHALLENGE_TOKEN_TTL_SECONDS = 5 * 60;

function getEnvString(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded =
    normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  return Buffer.from(padded, "base64");
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function signHmac(input, secret) {
  return crypto.createHmac("sha256", secret).update(input).digest();
}

function issueJwt(payload, expiresInSeconds) {
  const secret = getEnvString("ADMIN_JWT_SECRET");
  if (!secret) {
    throw new Error("Missing ADMIN_JWT_SECRET");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const body = {
    ...payload,
    iat: nowSeconds,
    exp: nowSeconds + expiresInSeconds,
    iss: "orderx-admin",
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedBody = base64UrlEncode(JSON.stringify(body));
  const signature = base64UrlEncode(
    signHmac(`${encodedHeader}.${encodedBody}`, secret),
  );
  return `${encodedHeader}.${encodedBody}.${signature}`;
}

export function verifyJwt(token) {
  const secret = getEnvString("ADMIN_JWT_SECRET");
  if (!secret) {
    throw new Error("Missing ADMIN_JWT_SECRET");
  }

  const parts = String(token || "").split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid token format");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const expectedSignature = base64UrlEncode(
    signHmac(`${encodedHeader}.${encodedPayload}`, secret),
  );
  if (!safeEqual(encodedSignature, expectedSignature)) {
    throw new Error("Invalid token signature");
  }

  const payload = safeJsonParse(base64UrlDecode(encodedPayload).toString("utf8"));
  if (!payload) {
    throw new Error("Invalid token payload");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Number(payload.exp || 0) <= nowSeconds) {
    throw new Error("Token expired");
  }

  return payload;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password || ""), String(salt || ""), 64);
}

function resolveAdminPasswordConfig() {
  const salt = getEnvString("ADMIN_PASSWORD_SALT");
  const hash = getEnvString("ADMIN_PASSWORD_HASH");
  const plainPassword = getEnvString("ADMIN_PASSWORD");

  if (salt && hash) {
    return { salt, hash, plainPassword: "" };
  }

  return { salt: "", hash: "", plainPassword };
}

function resolveAdminSecondFactorConfig() {
  const salt = getEnvString("ADMIN_SECOND_FACTOR_SALT");
  const hash = getEnvString("ADMIN_SECOND_FACTOR_HASH");
  const plainSecondFactor =
    getEnvString("ADMIN_SECOND_FACTOR") ||
    getEnvString("ADMIN_SECOND_PASSWORD");

  if (salt && hash) {
    return { salt, hash, plainSecondFactor: "" };
  }

  return { salt: "", hash: "", plainSecondFactor };
}

export function getAdminIdentity() {
  return {
    loginId: getEnvString("ADMIN_LOGIN_ID"),
    displayName: getEnvString("ADMIN_DISPLAY_NAME", "OrderX Admin"),
  };
}

export function validateAdminCredentials(loginId, password) {
  const identity = getAdminIdentity();
  const configuredLoginId = String(identity.loginId || "");
  if (!configuredLoginId) {
    throw new Error("Missing ADMIN_LOGIN_ID");
  }

  if (!safeEqual(loginId, configuredLoginId)) {
    return false;
  }

  const { salt, hash, plainPassword } = resolveAdminPasswordConfig();
  if (salt && hash) {
    const candidateHash = hashPassword(password, salt).toString("hex");
    return safeEqual(candidateHash, hash);
  }

  if (!plainPassword) {
    throw new Error(
      "Missing admin password configuration. Set ADMIN_PASSWORD or ADMIN_PASSWORD_HASH with ADMIN_PASSWORD_SALT.",
    );
  }

  return safeEqual(password, plainPassword);
}

export function issueAdminChallengeToken(loginId) {
  return issueJwt(
    {
      sub: String(loginId || ""),
      stage: "challenge",
      scope: "admin",
    },
    CHALLENGE_TOKEN_TTL_SECONDS,
  );
}

export function verifyAdminChallengeToken(token) {
  const payload = verifyJwt(token);
  if (payload.scope !== "admin" || payload.stage !== "challenge") {
    throw new Error("Invalid challenge token");
  }
  return payload;
}

export function validateAdminSecondFactor(value) {
  const { salt, hash, plainSecondFactor } = resolveAdminSecondFactorConfig();

  if (salt && hash) {
    const candidateHash = hashPassword(value, salt).toString("hex");
    return safeEqual(candidateHash, hash);
  }

  if (!plainSecondFactor) {
    throw new Error(
      "Missing second-factor configuration. Set ADMIN_SECOND_FACTOR or ADMIN_SECOND_FACTOR_HASH with ADMIN_SECOND_FACTOR_SALT.",
    );
  }

  return safeEqual(value, plainSecondFactor);
}

export function issueAdminAccessToken(loginId) {
  const identity = getAdminIdentity();
  const token = issueJwt(
    {
      sub: String(loginId || identity.loginId || ""),
      stage: "access",
      scope: "admin",
      displayName: identity.displayName,
    },
    ACCESS_TOKEN_TTL_SECONDS,
  );

  return {
    token,
    expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
    expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
  };
}

export function readBearerToken(req) {
  const header = String(req.get("Authorization") || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}
