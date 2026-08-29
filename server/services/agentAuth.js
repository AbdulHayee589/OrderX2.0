import crypto from "crypto";
import mongoose from "mongoose";
import { promisify } from "util";
import AgentAccount from "../models/AgentAccount.js";
import AgentSession from "../models/AgentSession.js";
import AgentConversationState from "../models/AgentConversationState.js";
import AgentSendReceipt from "../models/AgentSendReceipt.js";
import ConversationThread from "../models/ConversationThread.js";
import TeamInboxLabel from "../models/TeamInboxLabel.js";
import TeamInboxNote from "../models/TeamInboxNote.js";
import TeamInboxQuickReply from "../models/TeamInboxQuickReply.js";
import { requireAgentFeatureAccess } from "./agentAccess.js";
import {
  normalizeAgentAccessLevel,
  normalizeAgentPermissions,
  publicAgentPermissions,
} from "./agentPermissions.js";

const scryptAsync = promisify(crypto.scrypt);
const AGENT_COOKIE_NAME = "orderx_agent_session";
const AGENT_ACCOUNT_LIMIT = 3;
const PASSWORD_KEY_BYTES = 64;
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,40}$/;
const parsedSessionHours = Number(process.env.AGENT_SESSION_HOURS || 12);
const SESSION_HOURS = Math.min(
  24,
  Math.max(1, Number.isFinite(parsedSessionHours) ? parsedSessionHours : 12),
);
const SESSION_TTL_MS = SESSION_HOURS * 60 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const DUMMY_PASSWORD_SALT = Buffer.from(
  "9212f3fc93ad59fb8a371ae2d6995663",
  "hex",
);

let indexesReadyPromise = null;

function asText(value) {
  return String(value || "").trim();
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex");
}

function deriveAgentCsrfToken(sessionToken) {
  return crypto
    .createHmac("sha256", String(sessionToken || ""))
    .update("orderx-agent-csrf-v1")
    .digest("base64url");
}

function normalizeUsername(value) {
  return asText(value).toLowerCase();
}

function parseCookies(header) {
  const result = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

function buildCookie(value, { clear = false } = {}) {
  const secure =
    String(process.env.NODE_ENV || "").toLowerCase() === "production";
  const parts = [
    `${AGENT_COOKIE_NAME}=${encodeURIComponent(value || "")}`,
    "Path=/agent",
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
    clear ? "Max-Age=0" : `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  return parts.join("; ");
}

function publicAccount(account) {
  return {
    id: String(account?._id || ""),
    username: asText(account?.username),
    slot: Number(account?.slot || 0),
    active: account?.active !== false,
    createdAt: account?.createdAt || null,
    updatedAt: account?.updatedAt || null,
    lastLoginAt: account?.lastLoginAt || null,
    ...publicAgentPermissions(account),
  };
}

function duplicateKeyField(error) {
  if (Number(error?.code) !== 11000) return "";
  const keyPattern = error?.keyPattern || {};
  if (keyPattern.usernameNormalized) return "username";
  if (keyPattern.shop && keyPattern.slot) return "slot";
  const message = asText(error?.message).toLowerCase();
  if (message.includes("username")) return "username";
  if (message.includes("slot")) return "slot";
  return "duplicate";
}

export async function ensureAgentIndexes() {
  if (!indexesReadyPromise) {
    indexesReadyPromise = Promise.all([
      AgentAccount.collection.createIndex(
        { usernameNormalized: 1 },
        { unique: true, name: "agent_username_global_unique" },
      ),
      AgentAccount.collection.createIndex(
        { shop: 1, slot: 1 },
        { unique: true, name: "agent_shop_slot_unique" },
      ),
      AgentAccount.collection.createIndex(
        { shop: 1, active: 1, createdAt: 1 },
        { name: "agent_shop_active_created" },
      ),
      AgentSession.collection.createIndex(
        { tokenHash: 1 },
        { unique: true, name: "agent_session_token_unique" },
      ),
      AgentSession.collection.createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0, name: "agent_session_expiry_ttl" },
      ),
      AgentSession.collection.createIndex(
        { shop: 1, agentAccountId: 1, createdAt: -1 },
        { name: "agent_session_shop_account_created" },
      ),
      ConversationThread.collection.createIndex(
        { shop: 1, status: 1, lastMessageAt: -1 },
        { name: "shop_1_status_1_lastMessageAt_-1" },
      ),
      ConversationThread.collection.createIndex(
        { shop: 1, assignedAgentId: 1, lastMessageAt: -1 },
        { name: "shop_1_assignedAgentId_1_lastMessageAt_-1" },
      ),
      ConversationThread.collection.createIndex(
        { shop: 1, unreadCount: 1, lastMessageAt: -1 },
        { name: "shop_1_unreadCount_1_lastMessageAt_-1" },
      ),
      AgentConversationState.collection.createIndex(
        { shop: 1, threadKey: 1, agentAccountId: 1 },
        { unique: true, name: "agent_thread_state_unique" },
      ),
      TeamInboxNote.collection.createIndex(
        { shop: 1, threadKey: 1, createdAt: -1 },
        { name: "shop_1_threadKey_1_createdAt_-1" },
      ),
      TeamInboxLabel.collection.createIndex(
        { shop: 1, normalizedName: 1 },
        { unique: true, name: "team_inbox_label_unique" },
      ),
      TeamInboxQuickReply.collection.createIndex(
        { shop: 1, normalizedShortcut: 1 },
        { unique: true, name: "team_inbox_quick_reply_unique" },
      ),
      AgentSendReceipt.collection.createIndex(
        { shop: 1, agentAccountId: 1, clientMessageId: 1 },
        { unique: true, name: "agent_send_idempotency_unique" },
      ),
      AgentSendReceipt.collection.createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0, name: "agent_send_receipt_ttl" },
      ),
    ]).catch((error) => {
      indexesReadyPromise = null;
      throw error;
    });
  }
  await indexesReadyPromise;
}

export function validateAgentUsername(value) {
  const username = asText(value);
  if (!USERNAME_RE.test(username)) {
    const error = new Error(
      "Username must be 3-40 characters using only letters, numbers, dots, dashes, or underscores.",
    );
    error.status = 400;
    error.code = "invalid_username";
    throw error;
  }
  return { username, usernameNormalized: normalizeUsername(username) };
}

export function validateAgentPassword(value) {
  const password = String(value || "");
  if (password.length < 10 || password.length > 128) {
    const error = new Error("Password must be between 10 and 128 characters.");
    error.status = 400;
    error.code = "invalid_password";
    throw error;
  }
  return password;
}

async function hashPassword(password, salt = crypto.randomBytes(16)) {
  const key = await scryptAsync(password, salt, PASSWORD_KEY_BYTES);
  return {
    passwordHash: Buffer.from(key).toString("base64"),
    passwordSalt: Buffer.from(salt).toString("base64"),
  };
}

async function verifyPassword(password, account) {
  const salt = Buffer.from(String(account?.passwordSalt || ""), "base64");
  const expected = Buffer.from(String(account?.passwordHash || ""), "base64");
  if (!salt.length || expected.length !== PASSWORD_KEY_BYTES) return false;
  const actual = Buffer.from(
    await scryptAsync(password, salt, PASSWORD_KEY_BYTES),
  );
  return crypto.timingSafeEqual(actual, expected);
}

export async function listAgentAccounts(shop) {
  const shopDomain = asText(shop);
  if (!shopDomain) throw new Error("Missing shop");
  await ensureAgentIndexes();
  const rows = await AgentAccount.find({ shop: shopDomain, active: true })
    .sort({ slot: 1, createdAt: 1 })
    .lean();
  return rows.map(publicAccount);
}

export async function createAgentAccount({
  shop,
  username,
  password,
  accessLevel = "support",
  permissions = null,
}) {
  const shopDomain = asText(shop);
  if (!shopDomain) throw new Error("Missing shop");
  await requireAgentFeatureAccess(shopDomain);
  const cleanUsername = validateAgentUsername(username);
  const cleanPassword = validateAgentPassword(password);
  const cleanAccessLevel = normalizeAgentAccessLevel(accessLevel);
  const cleanPermissions = normalizeAgentPermissions(
    permissions,
    cleanAccessLevel,
  );
  await ensureAgentIndexes();

  const existingUsername = await AgentAccount.exists({
    usernameNormalized: cleanUsername.usernameNormalized,
  });
  if (existingUsername) {
    const error = new Error("That username is already in use.");
    error.status = 409;
    error.code = "username_taken";
    throw error;
  }

  const passwordFields = await hashPassword(cleanPassword);
  for (let retry = 0; retry < AGENT_ACCOUNT_LIMIT; retry += 1) {
    const occupied = await AgentAccount.find({ shop: shopDomain, active: true })
      .select({ slot: 1 })
      .lean();
    const slots = new Set(occupied.map((row) => Number(row.slot)));
    const slot = [1, 2, 3].find((candidate) => !slots.has(candidate));
    if (!slot) {
      const error = new Error("A merchant can create up to 3 agent accounts.");
      error.status = 409;
      error.code = "agent_limit_reached";
      throw error;
    }

    try {
      const account = await AgentAccount.create({
        shop: shopDomain,
        ...cleanUsername,
        ...passwordFields,
        slot,
        accessLevel: cleanAccessLevel,
        permissions: cleanPermissions,
        active: true,
      });
      return publicAccount(account);
    } catch (error) {
      const duplicate = duplicateKeyField(error);
      if (duplicate === "username") {
        const conflict = new Error("That username is already in use.");
        conflict.status = 409;
        conflict.code = "username_taken";
        throw conflict;
      }
      if (duplicate === "slot") continue;
      throw error;
    }
  }

  const error = new Error("A merchant can create up to 3 agent accounts.");
  error.status = 409;
  error.code = "agent_limit_reached";
  throw error;
}

export async function updateAgentAccess({
  shop,
  agentId,
  accessLevel,
  permissions,
}) {
  const shopDomain = asText(shop);
  if (!shopDomain || !mongoose.isValidObjectId(asText(agentId))) {
    const error = new Error("Missing agent account.");
    error.status = 400;
    throw error;
  }
  await requireAgentFeatureAccess(shopDomain);
  const cleanAccessLevel = normalizeAgentAccessLevel(accessLevel);
  const cleanPermissions = normalizeAgentPermissions(
    permissions,
    cleanAccessLevel,
  );
  const account = await AgentAccount.findOneAndUpdate(
    { _id: agentId, shop: shopDomain, active: true },
    {
      $set: {
        accessLevel: cleanAccessLevel,
        permissions: cleanPermissions,
      },
    },
    { new: true },
  );
  if (!account) {
    const error = new Error("Agent account not found.");
    error.status = 404;
    throw error;
  }
  return publicAccount(account);
}

export async function updateAgentPassword({ shop, agentId, password }) {
  const shopDomain = asText(shop);
  const cleanPassword = validateAgentPassword(password);
  if (!shopDomain || !mongoose.isValidObjectId(asText(agentId))) {
    const error = new Error("Missing agent account.");
    error.status = 400;
    throw error;
  }
  await requireAgentFeatureAccess(shopDomain);
  const passwordFields = await hashPassword(cleanPassword);
  const account = await AgentAccount.findOneAndUpdate(
    { _id: agentId, shop: shopDomain, active: true },
    {
      $set: passwordFields,
      $inc: { credentialVersion: 1 },
    },
    { new: true },
  );
  if (!account) {
    const error = new Error("Agent account not found.");
    error.status = 404;
    throw error;
  }
  await AgentSession.updateMany(
    { agentAccountId: account._id, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
  return publicAccount(account);
}

export async function deleteAgentAccount({ shop, agentId }) {
  const shopDomain = asText(shop);
  if (!shopDomain || !mongoose.isValidObjectId(asText(agentId))) {
    const error = new Error("Missing agent account.");
    error.status = 400;
    throw error;
  }
  const account = await AgentAccount.findOneAndDelete({
    _id: agentId,
    shop: shopDomain,
  });
  if (!account) {
    const error = new Error("Agent account not found.");
    error.status = 404;
    throw error;
  }
  await AgentSession.deleteMany({ agentAccountId: account._id });
  return publicAccount(account);
}

export async function authenticateAgentCredentials({ username, password }) {
  const normalized = normalizeUsername(username);
  const rawPassword = String(password || "");
  if (!normalized || !rawPassword) return null;
  await ensureAgentIndexes();
  const account = await AgentAccount.findOne({
    usernameNormalized: normalized,
    active: true,
  })
    .select("+passwordHash +passwordSalt")
    .lean();
  if (!account) {
    // Keep unknown-user and wrong-password checks close in cost so the login
    // endpoint does not become a practical username-enumeration oracle.
    await scryptAsync(rawPassword, DUMMY_PASSWORD_SALT, PASSWORD_KEY_BYTES);
    return null;
  }
  if (!(await verifyPassword(rawPassword, account))) return null;
  return account;
}

export async function createAgentSession(account) {
  const token = crypto.randomBytes(32).toString("base64url");
  const csrfToken = deriveAgentCsrfToken(token);
  const now = new Date();
  const session = await AgentSession.create({
    agentAccountId: account._id,
    shop: account.shop,
    tokenHash: sha256(token),
    csrfTokenHash: sha256(csrfToken),
    credentialVersion: Number(account.credentialVersion || 1),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    lastSeenAt: now,
  });

  await AgentAccount.updateOne(
    { _id: account._id },
    { $set: { lastLoginAt: now } },
  );

  const oldSessions = await AgentSession.find({
    agentAccountId: account._id,
    revokedAt: null,
  })
    .sort({ createdAt: -1 })
    .skip(5)
    .select({ _id: 1 })
    .lean();
  if (oldSessions.length) {
    await AgentSession.deleteMany({
      _id: { $in: oldSessions.map((row) => row._id) },
    });
  }

  return {
    token,
    csrfToken,
    session,
    account: publicAccount(account),
  };
}

export function setAgentSessionCookie(res, token) {
  res.setHeader("Set-Cookie", buildCookie(token));
}

export function clearAgentSessionCookie(res) {
  res.setHeader("Set-Cookie", buildCookie("", { clear: true }));
}

export async function resolveAgentSession(req, { rotateCsrf = false } = {}) {
  const token = parseCookies(req.headers.cookie)?.[AGENT_COOKIE_NAME] || "";
  if (!token) return null;
  const now = new Date();
  const session = await AgentSession.findOne({
    tokenHash: sha256(token),
    revokedAt: null,
    expiresAt: { $gt: now },
  }).lean();
  if (!session) return null;

  const account = await AgentAccount.findOne({
    _id: session.agentAccountId,
    shop: session.shop,
    active: true,
    credentialVersion: Number(session.credentialVersion || 1),
  }).lean();
  if (!account) {
    await AgentSession.updateOne(
      { _id: session._id },
      { $set: { revokedAt: now } },
    ).catch(() => null);
    return null;
  }

  let csrfToken = null;
  const update = {};
  const lastSeenAt = new Date(session.lastSeenAt || 0);
  if (
    !Number.isFinite(lastSeenAt.getTime()) ||
    now.getTime() - lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS
  ) {
    update.lastSeenAt = now;
  }
  if (rotateCsrf) {
    // Re-derive the same CSRF value from the opaque HttpOnly session token.
    // This keeps reloads and multiple tabs valid without storing a readable
    // CSRF secret in MongoDB or rotating other active tabs out.
    csrfToken = deriveAgentCsrfToken(token);
  }
  if (Object.keys(update).length) {
    await AgentSession.updateOne({ _id: session._id }, { $set: update });
  }

  return {
    token,
    csrfToken,
    session: { ...session, ...update },
    account: publicAccount(account),
    accountDocument: account,
    shop: account.shop,
  };
}

export function isValidAgentCsrf(req, resolvedSession) {
  const token = asText(req.headers["x-csrf-token"]);
  const candidates = [
    asText(resolvedSession?.session?.csrfTokenHash),
    ...(Array.isArray(resolvedSession?.session?.previousCsrfTokenHashes)
      ? resolvedSession.session.previousCsrfTokenHashes.map(asText)
      : []),
  ].filter(Boolean);
  if (!token || !candidates.length) return false;
  const actualBuffer = Buffer.from(sha256(token), "hex");
  return candidates.some((expected) => {
    const expectedBuffer = Buffer.from(expected, "hex");
    return (
      actualBuffer.length === expectedBuffer.length &&
      crypto.timingSafeEqual(actualBuffer, expectedBuffer)
    );
  });
}

export async function revokeAgentSession(resolvedSession) {
  if (!resolvedSession?.session?._id) return;
  await AgentSession.updateOne(
    { _id: resolvedSession.session._id },
    { $set: { revokedAt: new Date() } },
  );
}

export function serializeAgentSession(resolvedSession, csrfToken = null) {
  return {
    authenticated: true,
    agent: resolvedSession.account,
    merchant: { shop: resolvedSession.shop },
    expiresAt: resolvedSession.session.expiresAt || null,
    csrfToken: csrfToken || resolvedSession.csrfToken || null,
  };
}

export const AGENT_LIMIT = AGENT_ACCOUNT_LIMIT;
