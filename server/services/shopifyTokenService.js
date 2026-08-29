import crypto from "node:crypto";
import mongoose from "mongoose";
import { Session } from "@shopify/shopify-api";
import Shop from "../models/Shop.js";
import { shopify } from "../shopify.js";
import {
  SHOPIFY_TOKEN_STATUS,
  asText,
  buildShopTokenUpdate,
  classifyTokenBundle,
  compareTokenBundles,
  createKeyedMutex,
  getShopifyErrorStatus,
  isDateExpired,
  isDefinitiveInvalidRefreshTokenError,
  isTransientShopifyTokenError,
  normalizeTokenBundle,
  sanitizeShopifyTokenError,
  selectPreferredTokenBundle,
  shouldRefreshTokenBundle,
  tokenBundleFromSession,
  tokenBundleFromShopRecord,
  toValidDate,
} from "./shopifyTokenState.js";

const ACCESS_TOKEN_EXPIRY_BUFFER_MS = Math.max(
  60_000,
  Number(process.env.SHOPIFY_OFFLINE_ACCESS_TOKEN_EXPIRY_BUFFER_MS || 300_000),
);
const LOCK_LEASE_MS = Math.max(
  15_000,
  Number(process.env.SHOPIFY_TOKEN_LOCK_LEASE_MS || 60_000),
);
const LOCK_WAIT_MS = Math.max(
  1_000,
  Number(process.env.SHOPIFY_TOKEN_LOCK_WAIT_MS || 20_000),
);
const SESSION_COLLECTION =
  asText(process.env.SHOPIFY_SESSION_COLLECTION) || "shopifySessions";
const LOCK_COLLECTION =
  asText(process.env.SHOPIFY_TOKEN_LOCK_COLLECTION) || "shopifyTokenLocks";
const SESSION_MONGO_URI =
  asText(process.env.SHOPIFY_SESSION_MONGO_URI) || asText(process.env.MONGO_URI);
const SESSION_MONGO_DB =
  asText(process.env.SHOPIFY_SESSION_MONGO_DB) ||
  deriveDatabaseName(SESSION_MONGO_URI);
const AUTO_MIGRATION_ENABLED =
  asText(process.env.SHOPIFY_OFFLINE_TOKEN_AUTO_MIGRATION_ENABLED).toLowerCase() ===
  "true";
const MIGRATION_CANARY_SHOPS = new Set(
  asText(process.env.SHOPIFY_OFFLINE_TOKEN_MIGRATION_CANARY_SHOPS)
    .split(",")
    .map((shop) => normalizeShop(shop))
    .filter(Boolean),
);
const ALLOW_NON_TRANSACTIONAL_DEV_STORAGE = (() => {
  const configured = asText(
    process.env.SHOPIFY_TOKEN_ALLOW_NON_TRANSACTIONAL_DEV_STORAGE,
  ).toLowerCase();
  if (configured) {
    return ["1", "true", "yes"].includes(configured);
  }
  return asText(process.env.NODE_ENV).toLowerCase() !== "production";
})();

const localShopTokenMutex = createKeyedMutex();
let dedicatedSessionClientPromise = null;
let lockIndexesPromise = null;
const transactionSupportByClient = new WeakMap();
let warnedAboutStandaloneTokenStorage = false;

export class ShopifyReauthorizationRequiredError extends Error {
  constructor(shop, reason = "reauthorization_required") {
    super(
      "Shopify authorization must be renewed by opening the app and approving access again.",
    );
    this.name = "ShopifyReauthorizationRequiredError";
    this.code = "SHOPIFY_REAUTHORIZATION_REQUIRED";
    this.statusCode = 401;
    this.shop = normalizeShop(shop);
    this.reason = reason;
  }
}

export class ShopifyTokenLockTimeoutError extends Error {
  constructor(shop) {
    super("Timed out waiting for another Shopify token operation to finish.");
    this.name = "ShopifyTokenLockTimeoutError";
    this.code = "SHOPIFY_TOKEN_LOCK_TIMEOUT";
    this.statusCode = 503;
    this.shop = normalizeShop(shop);
  }
}

function normalizeShop(value) {
  return asText(value).toLowerCase();
}

function deriveDatabaseName(uri) {
  if (!uri) return "OrderX";
  try {
    const parsed = new URL(uri);
    return decodeURIComponent(String(parsed.pathname || "").replace(/^\/+/, "")) ||
      "OrderX";
  } catch {
    return "OrderX";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function mongoHelloSupportsTransactions(hello = {}) {
  return (
    Boolean(hello?.setName) ||
    asText(hello?.msg).toLowerCase() === "isdbgrid"
  );
}

async function tokenStorageSupportsTransactions(client) {
  let supportPromise = transactionSupportByClient.get(client);
  if (!supportPromise) {
    supportPromise = client
      .db("admin")
      .command({ hello: 1 })
      .then(mongoHelloSupportsTransactions)
      .catch((error) => {
        transactionSupportByClient.delete(client);
        throw error;
      });
    transactionSupportByClient.set(client, supportPromise);
  }
  return supportPromise;
}

async function runTokenStorageWrite(sessionStore, operationName, work) {
  const supportsTransactions = await tokenStorageSupportsTransactions(
    sessionStore.client,
  );
  if (!supportsTransactions) {
    if (!ALLOW_NON_TRANSACTIONAL_DEV_STORAGE) {
      const error = new Error(
        "MongoDB transactions require a replica set or mongos for Shopify token storage.",
      );
      error.code = "SHOPIFY_TOKEN_TRANSACTIONS_UNAVAILABLE";
      throw error;
    }
    if (!warnedAboutStandaloneTokenStorage) {
      warnedAboutStandaloneTokenStorage = true;
      console.warn(
        "[shopify_tokens] Standalone MongoDB detected; using the development-only token storage fallback. Use a replica set in production.",
      );
    }
    return work(null);
  }

  const mongoSession = sessionStore.client.startSession();
  try {
    return await mongoSession.withTransaction(() => work(mongoSession));
  } catch (error) {
    error.tokenStorageOperation = operationName;
    throw error;
  } finally {
    await mongoSession.endSession();
  }
}

function tokenFingerprint(value) {
  const token = asText(value);
  if (!token) return null;
  return crypto.createHash("sha256").update(token).digest("hex");
}

function sameToken(left, right) {
  const leftFingerprint = tokenFingerprint(left);
  const rightFingerprint = tokenFingerprint(right);
  return !!leftFingerprint && leftFingerprint === rightFingerprint;
}

function sameOptionalToken(left, right) {
  const leftValue = asText(left);
  const rightValue = asText(right);
  if (!leftValue && !rightValue) return true;
  return sameToken(leftValue, rightValue);
}

function sameOptionalDate(left, right) {
  const leftTime = toValidDate(left)?.getTime?.() || 0;
  const rightTime = toValidDate(right)?.getTime?.() || 0;
  return leftTime === rightTime;
}

function sameCredentialBundle(left, right) {
  if (!left || !right) return false;
  return (
    sameOptionalToken(left.accessToken, right.accessToken) &&
    sameOptionalToken(left.refreshToken, right.refreshToken) &&
    sameOptionalDate(left.accessTokenExpiresAt, right.accessTokenExpiresAt) &&
    sameOptionalDate(left.refreshTokenExpiresAt, right.refreshTokenExpiresAt)
  );
}

function isCompleteTokenBundle(value) {
  const state = classifyTokenBundle(value);
  return state.kind === "legacy" || state.kind === "expiring";
}

function assertPersistableTokenBundle(value) {
  const bundle = normalizeTokenBundle(value);
  const state = classifyTokenBundle(bundle);
  if (!bundle.shop || !bundle.accessToken || !isCompleteTokenBundle(bundle)) {
    const error = new Error(
      "Refusing to persist an incomplete Shopify token response.",
    );
    error.code = "SHOPIFY_INCOMPLETE_TOKEN_BUNDLE";
    throw error;
  }
  if (
    state.kind === "expiring" &&
    (!bundle.accessTokenExpiresAt ||
      !bundle.refreshToken ||
      !bundle.refreshTokenExpiresAt)
  ) {
    const error = new Error(
      "Refusing to persist a partial expiring Shopify token response.",
    );
    error.code = "SHOPIFY_INCOMPLETE_TOKEN_BUNDLE";
    throw error;
  }
  return bundle;
}

function sessionDocumentToSession(document) {
  if (!Array.isArray(document?.payload)) return null;
  try {
    return Session.fromPropertyArray(document.payload, true);
  } catch {
    return null;
  }
}

function tokenBundleFromSessionDocument(document) {
  const session = sessionDocumentToSession(document);
  if (!session || session.isOnline === true) return null;
  return tokenBundleFromSession(session, {
    source: "shopify_session",
    updatedAt: document?.updatedAt,
    version: document?.tokenVersion,
  });
}

function tokenBundleToSession(bundle) {
  return new Session({
    id: shopify.session.getOfflineId(bundle.shop),
    shop: bundle.shop,
    state: "",
    isOnline: false,
    scope: bundle.scope || asText(process.env.SCOPES),
    accessToken: bundle.accessToken,
    ...(bundle.accessTokenExpiresAt
      ? { expires: bundle.accessTokenExpiresAt }
      : {}),
    ...(bundle.refreshToken ? { refreshToken: bundle.refreshToken } : {}),
    ...(bundle.refreshTokenExpiresAt
      ? { refreshTokenExpires: bundle.refreshTokenExpiresAt }
      : {}),
  });
}

function sessionDocumentFromBundle(bundle, { version, now }) {
  const session = tokenBundleToSession(bundle);
  return {
    id: session.id,
    shop: bundle.shop,
    isOnline: false,
    expiresAt: bundle.accessTokenExpiresAt || null,
    payload: session.toPropertyArray(true),
    tokenStatus:
      classifyTokenBundle(bundle, { now }).status || SHOPIFY_TOKEN_STATUS.UNKNOWN,
    tokenVersion: version,
    updatedAt: now,
  };
}

function primaryMongoClient() {
  if (!mongoose.connection?.db) {
    throw new Error("MongoDB is not connected for Shopify token storage.");
  }
  return mongoose.connection.getClient();
}

function sharesPrimaryMongoClient() {
  const mainUri = asText(process.env.MONGO_URI);
  return !process.env.SHOPIFY_SESSION_MONGO_URI || SESSION_MONGO_URI === mainUri;
}

async function getSessionStore() {
  if (!SESSION_MONGO_URI) {
    throw new Error("Missing Shopify session MongoDB configuration.");
  }
  if (sharesPrimaryMongoClient()) {
    const client = primaryMongoClient();
    return {
      client,
      collection: client.db(SESSION_MONGO_DB).collection(SESSION_COLLECTION),
      sharesPrimaryClient: true,
    };
  }

  if (!dedicatedSessionClientPromise) {
    const client = new mongoose.mongo.MongoClient(SESSION_MONGO_URI, {
      appName: "OrderX Shopify Token Session Reader",
      maxPoolSize: 5,
      minPoolSize: 0,
      retryWrites: true,
    });
    dedicatedSessionClientPromise = client.connect().catch((error) => {
      dedicatedSessionClientPromise = null;
      throw error;
    });
  }
  const client = await dedicatedSessionClientPromise;
  return {
    client,
    collection: client.db(SESSION_MONGO_DB).collection(SESSION_COLLECTION),
    sharesPrimaryClient: false,
  };
}

async function getLockCollection() {
  const collection = mongoose.connection.db.collection(LOCK_COLLECTION);
  if (!lockIndexesPromise) {
    lockIndexesPromise = collection
      .createIndex(
        { leaseUntil: 1 },
        { expireAfterSeconds: 0, name: "shopify_token_lock_expiry" },
      )
      .catch((error) => {
        lockIndexesPromise = null;
        throw error;
      });
  }
  await lockIndexesPromise;
  return collection;
}

async function acquireDistributedLock(shop, options = {}) {
  const owner = `${process.pid}:${crypto.randomUUID()}`;
  const waitMs = Math.max(500, Number(options.waitMs || LOCK_WAIT_MS));
  const deadline = Date.now() + waitMs;
  const collection = await getLockCollection();

  while (Date.now() < deadline) {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + LOCK_LEASE_MS);
    try {
      const result = await collection.findOneAndUpdate(
        {
          _id: shop,
          $or: [
            { owner },
            { leaseUntil: { $lte: now } },
            { leaseUntil: { $exists: false } },
          ],
        },
        {
          $set: { owner, leaseUntil, updatedAt: now },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true, returnDocument: "after" },
      );
      const document = result?.value || result;
      if (document?.owner === owner) {
        return { owner, collection };
      }
    } catch (error) {
      if (Number(error?.code) !== 11000) throw error;
    }
    await sleep(75 + Math.floor(Math.random() * 100));
  }
  throw new ShopifyTokenLockTimeoutError(shop);
}

async function withDistributedShopTokenLock(shop, work, options = {}) {
  const key = normalizeShop(shop);
  return localShopTokenMutex.run(key, async () => {
    const lock = await acquireDistributedLock(key, options);
    const heartbeat = setInterval(() => {
      const now = new Date();
      void lock.collection
        .updateOne(
          { _id: key, owner: lock.owner },
          {
            $set: {
              leaseUntil: new Date(now.getTime() + LOCK_LEASE_MS),
              updatedAt: now,
            },
          },
        )
        .catch(() => null);
    }, Math.max(5_000, Math.floor(LOCK_LEASE_MS / 3)));
    heartbeat.unref?.();
    try {
      return await work();
    } finally {
      clearInterval(heartbeat);
      await lock.collection
        .deleteOne({ _id: key, owner: lock.owner })
        .catch(() => null);
    }
  });
}

async function readShopRecord(shop, providedRecord = null, mongoSession = null) {
  if (providedRecord?.shop === shop && providedRecord?.accessTokenUpdatedAt) {
    return providedRecord;
  }
  return Shop.findOne({ shop })
    .session(mongoSession || null)
    .select({
      shop: 1,
      host: 1,
      scopes: 1,
      accessToken: 1,
      accessTokenType: 1,
      accessTokenUpdatedAt: 1,
      accessTokenExpiresAt: 1,
      accessTokenRefreshToken: 1,
      accessTokenRefreshTokenExpiresAt: 1,
      accessTokenMigratedAt: 1,
      accessTokenStatus: 1,
      accessTokenVersion: 1,
      accessTokenLastError: 1,
      accessTokenLastErrorAt: 1,
    })
    .lean();
}

export async function getShopifyTokenSnapshot(
  shop,
  { record = null, fallbackAccessToken = "", mongoSession = null } = {},
) {
  const shopDomain = normalizeShop(shop);
  if (!shopDomain) throw new Error("Missing shop");
  const sessionStore = await getSessionStore();
  const [shopRecord, sessionDocument] = await Promise.all([
    readShopRecord(shopDomain, record, mongoSession),
    sessionStore.collection.findOne(
      { id: shopify.session.getOfflineId(shopDomain) },
      { session: mongoSession || undefined },
    ),
  ]);
  const shopBundle = shopRecord ? tokenBundleFromShopRecord(shopRecord) : null;
  const sessionBundle = tokenBundleFromSessionDocument(sessionDocument);
  const fallbackBundle = asText(fallbackAccessToken)
    ? normalizeTokenBundle({
        shop: shopDomain,
        accessToken: fallbackAccessToken,
        tokenType: "offline",
        source: "trusted_fallback",
      })
    : null;
  const storedCandidates = [shopBundle, sessionBundle].filter(Boolean);
  const preferred =
    selectPreferredTokenBundle(storedCandidates, {
      bufferMs: ACCESS_TOKEN_EXPIRY_BUFFER_MS,
    }) ||
    selectPreferredTokenBundle([fallbackBundle].filter(Boolean), {
      bufferMs: ACCESS_TOKEN_EXPIRY_BUFFER_MS,
    });
  let classification = classifyTokenBundle(
    preferred || { shop: shopDomain },
    {
      bufferMs: ACCESS_TOKEN_EXPIRY_BUFFER_MS,
    },
  );
  const rejectedAt = toValidDate(shopRecord?.accessTokenLastErrorAt);
  const preferredUpdatedAt = toValidDate(preferred?.updatedAt);
  const rejectedCurrentToken = Boolean(
    preferred?.accessToken &&
      shopRecord?.accessTokenStatus ===
        SHOPIFY_TOKEN_STATUS.REAUTHORIZATION_REQUIRED &&
      sameToken(preferred.accessToken, shopBundle?.accessToken) &&
      rejectedAt &&
      (!preferredUpdatedAt || preferredUpdatedAt <= rejectedAt),
  );
  if (rejectedCurrentToken) {
    classification = {
      ...classification,
      kind: "rejected",
      status: SHOPIFY_TOKEN_STATUS.REAUTHORIZATION_REQUIRED,
      usableNow: false,
      automaticallyRepairable: false,
      requiresReauthorization: true,
      reason: "stored_token_rejected",
    };
  }
  const mirrorOutOfSync = Boolean(
    preferred &&
      (!shopBundle ||
        !sessionBundle ||
        !sameCredentialBundle(preferred, shopBundle) ||
        !sameCredentialBundle(preferred, sessionBundle)),
  );
  return {
    shop: shopDomain,
    shopRecord,
    sessionDocument,
    shopBundle,
    sessionBundle,
    preferred,
    classification,
    mirrorOutOfSync,
  };
}

async function persistTokenBundleAtomic(
  value,
  { expectedAccessToken = "", host = null, installedAt = null } = {},
) {
  const bundle = assertPersistableTokenBundle(value);
  const sessionStore = await getSessionStore();
  if (!sessionStore.sharesPrimaryClient) {
    const error = new Error(
      "Shopify sessions and Shop records must share one MongoDB deployment for atomic token rotation.",
    );
    error.code = "SHOPIFY_TOKEN_STORAGE_NOT_ATOMIC";
    throw error;
  }

  let outcome = null;
  await runTokenStorageWrite(
    sessionStore,
    "persist_token_bundle",
    async (mongoSession) => {
      const now = new Date();
      // MongoDB does not support parallel operations on one transaction
      // session. Keep these reads sequential or concurrent rotations can fail
      // with ConflictingOperationInProgress before either token copy is saved.
      let currentShopQuery = Shop.findOne({ shop: bundle.shop });
      if (mongoSession) {
        currentShopQuery = currentShopQuery.session(mongoSession);
      }
      const currentShop = await currentShopQuery.lean();
      const currentSessionDocument = await sessionStore.collection.findOne(
        { id: shopify.session.getOfflineId(bundle.shop) },
        mongoSession ? { session: mongoSession } : {},
      );
      const currentSessionBundle = tokenBundleFromSessionDocument(
        currentSessionDocument,
      );
      const currentShopBundle = currentShop
        ? tokenBundleFromShopRecord(currentShop)
        : null;
      const currentPreferred = selectPreferredTokenBundle(
        [currentSessionBundle, currentShopBundle].filter(Boolean),
      );

      if (
        expectedAccessToken &&
        currentPreferred?.accessToken &&
        !sameToken(currentPreferred.accessToken, expectedAccessToken)
      ) {
        outcome = { saved: false, conflict: true, bundle: currentPreferred };
        return;
      }

      if (
        currentPreferred?.accessToken &&
        !sameToken(currentPreferred.accessToken, bundle.accessToken) &&
        compareTokenBundles(currentPreferred, bundle) > 0
      ) {
        outcome = { saved: false, conflict: true, bundle: currentPreferred };
        return;
      }

      const version =
        Math.max(
          Number(currentShop?.accessTokenVersion || 0),
          Number(currentSessionDocument?.tokenVersion || 0),
          Number(bundle.version || 0),
        ) + 1;
      const sessionDocument = sessionDocumentFromBundle(bundle, {
        version,
        now,
      });
      const shopUpdate = buildShopTokenUpdate(bundle, {
        version,
        now,
        updatedAt: now,
        migratedAt: currentShop?.accessTokenMigratedAt || now,
      });
      if (host != null && asText(host)) shopUpdate.host = asText(host);

      const writeSessionMirror = () =>
        sessionStore.collection.updateOne(
          { id: sessionDocument.id },
          {
            $set: sessionDocument,
            $setOnInsert: { createdAt: now },
          },
          mongoSession
            ? { upsert: true, session: mongoSession }
            : { upsert: true },
        );
      const writeShopRecord = () =>
        Shop.collection.updateOne(
          { shop: bundle.shop },
          {
            $set: shopUpdate,
            $setOnInsert: {
              installedAt: toValidDate(installedAt) || now,
              settings: {},
              billing: {},
            },
          },
          mongoSession
            ? { upsert: true, session: mongoSession }
            : { upsert: true },
        );

      if (mongoSession) {
        await writeSessionMirror();
        await writeShopRecord();
      } else {
        // A standalone development MongoDB cannot atomically update two
        // collections. Save the complete pair to the canonical Shop record
        // first, then mirror the same complete pair to the session store.
        await writeShopRecord();
        await writeSessionMirror();
      }
      outcome = {
        saved: true,
        conflict: false,
        version,
        bundle: { ...bundle, version, updatedAt: now },
      };
    },
  );
  return outcome;
}

async function recordTokenError(shop, error, status = null) {
  const message = sanitizeShopifyTokenError(error);
  const update = {
    accessTokenLastError: message,
    accessTokenLastErrorAt: new Date(),
    ...(status ? { accessTokenStatus: status } : {}),
  };
  await Shop.updateOne({ shop }, { $set: update }).catch(() => null);
}

async function markReauthorizationStateAtomic(
  shop,
  error,
  reason,
  { expectedAccessToken = "" } = {},
) {
  const shopDomain = normalizeShop(shop);
  const sessionStore = await getSessionStore();
  if (!sessionStore.sharesPrimaryClient) {
    const storageError = new Error(
      "Shopify sessions and Shop records must share one MongoDB deployment for atomic token invalidation.",
    );
    storageError.code = "SHOPIFY_TOKEN_STORAGE_NOT_ATOMIC";
    throw storageError;
  }

  const safeError = error || new Error(reason || "reauthorization_required");
  let outcome = null;
  await runTokenStorageWrite(
    sessionStore,
    "mark_reauthorization",
    async (mongoSession) => {
      let currentShopQuery = Shop.findOne({ shop: shopDomain });
      if (mongoSession) {
        currentShopQuery = currentShopQuery.session(mongoSession);
      }
      const currentShop = await currentShopQuery.lean();
      const currentSessionDocument = await sessionStore.collection.findOne(
        { id: shopify.session.getOfflineId(shopDomain) },
        mongoSession ? { session: mongoSession } : {},
      );
      const currentShopBundle = currentShop
        ? tokenBundleFromShopRecord(currentShop)
        : null;
      const currentSessionBundle = tokenBundleFromSessionDocument(
        currentSessionDocument,
      );
      const currentPreferred = selectPreferredTokenBundle(
        [currentSessionBundle, currentShopBundle].filter(Boolean),
      );

      // A concurrent OAuth exchange or refresh may already have replaced the
      // token that failed. Never invalidate or mark that newer credential.
      if (
        expectedAccessToken &&
        currentPreferred?.accessToken &&
        !sameToken(currentPreferred.accessToken, expectedAccessToken)
      ) {
        outcome = {
          marked: false,
          conflict: true,
          bundle: currentPreferred,
        };
        return;
      }

      const now = new Date();
      const markShopRecord = () =>
        Shop.collection.updateOne(
          { shop: shopDomain },
          {
            $set: {
              accessTokenStatus: SHOPIFY_TOKEN_STATUS.REAUTHORIZATION_REQUIRED,
              accessTokenLastError: sanitizeShopifyTokenError(safeError),
              accessTokenLastErrorAt: now,
            },
            $inc: { accessTokenVersion: 1 },
          },
          mongoSession ? { session: mongoSession } : {},
        );
      const deleteSessionMirror = () =>
        currentSessionDocument
          ? sessionStore.collection.deleteOne(
              { _id: currentSessionDocument._id },
              mongoSession ? { session: mongoSession } : {},
            )
          : null;
      if (mongoSession) {
        await deleteSessionMirror();
        await markShopRecord();
      } else {
        await markShopRecord();
        await deleteSessionMirror();
      }
      outcome = { marked: true, conflict: false, bundle: currentPreferred };
    },
  );
  return outcome;
}

async function markReauthorizationRequired(
  shop,
  error,
  reason,
  { expectedAccessToken = "" } = {},
) {
  const outcome = await markReauthorizationStateAtomic(shop, error, reason, {
    expectedAccessToken,
  });
  if (
    outcome?.conflict &&
    outcome?.bundle &&
    classifyTokenBundle(outcome.bundle).usableNow
  ) {
    return {
      ...outcome.bundle,
      refreshed: false,
      recoveredFromNewerToken: true,
    };
  }
  throw new ShopifyReauthorizationRequiredError(shop, reason);
}

export async function flagShopifyReauthorizationRequired(
  shop,
  error,
  reason = "reauthorization_required",
  { expectedAccessToken = "" } = {},
) {
  const shopDomain = normalizeShop(shop);
  if (!shopDomain) throw new Error("Missing shop");
  return withDistributedShopTokenLock(shopDomain, () =>
    markReauthorizationStateAtomic(shopDomain, error, reason, {
      expectedAccessToken,
    }),
  );
}

function migrationAllowed(shop, { migrateLegacy, forceMigration } = {}) {
  if (migrateLegacy === false) return false;
  if (forceMigration === true) return true;
  return AUTO_MIGRATION_ENABLED || MIGRATION_CANARY_SHOPS.has(shop);
}

async function refreshWithSafeRetries(shop, refreshToken) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const { session } = await shopify.auth.refreshToken({
        shop,
        refreshToken,
      });
      const bundle = tokenBundleFromSession(session, {
        source: "shopify_refresh",
        updatedAt: new Date(),
      });
      return assertPersistableTokenBundle(bundle);
    } catch (error) {
      lastError = error;
      if (
        isDefinitiveInvalidRefreshTokenError(error) ||
        !isTransientShopifyTokenError(error) ||
        attempt >= 2
      ) {
        throw error;
      }
      await sleep(200 * 2 ** attempt);
    }
  }
  throw lastError || new Error("Shopify token refresh failed.");
}

async function migrateLegacyToken(shop, accessToken) {
  const { session } = await shopify.auth.migrateToExpiringToken({
    shop,
    nonExpiringOfflineAccessToken: accessToken,
  });
  return assertPersistableTokenBundle(
    tokenBundleFromSession(session, {
      source: "legacy_migration",
      updatedAt: new Date(),
    }),
  );
}

async function mirrorPreferredBundle(snapshot) {
  if (!snapshot?.preferred || !isCompleteTokenBundle(snapshot.preferred)) {
    return snapshot?.preferred || null;
  }
  try {
    const result = await persistTokenBundleAtomic(snapshot.preferred, {
      expectedAccessToken: snapshot.preferred.accessToken,
      host: snapshot.shopRecord?.host || null,
    });
    return result?.bundle || snapshot.preferred;
  } catch (error) {
    // Repairing a duplicate token mirror is maintenance, not a prerequisite
    // for using an otherwise valid token. Never stop polling for this alone.
    await recordTokenError(snapshot.shop, error);
    console.warn(
      "[shopify_tokens] Deferred token mirror repair",
      snapshot.shop,
      sanitizeShopifyTokenError(error),
    );
    return snapshot.preferred;
  }
}

function resolveReadOnlyTokenFastPath(snapshot, shopDomain, options = {}) {
  const bundle = snapshot?.preferred;
  const state = snapshot?.classification;
  if (!bundle || !state || state.kind === "rejected") return null;

  const mirrorRequiresRepair =
    snapshot.mirrorOutOfSync && options.repairMirror !== false;

  // A different process may already have rotated the token that produced the
  // 401. The newer canonical access token can be used immediately; only take
  // the distributed lock when its Shop mirror still needs repair.
  if (
    options.forceRefresh === true &&
    options.failedAccessToken &&
    bundle.accessToken &&
    !sameToken(bundle.accessToken, options.failedAccessToken) &&
    state.usableNow &&
    !mirrorRequiresRepair
  ) {
    return { ...bundle, refreshed: false, recoveredFromNewerToken: true };
  }

  if (
    state.kind === "expiring" ||
    (state.kind === "partial" && bundle.refreshToken)
  ) {
    const refreshRequired =
      options.forceRefresh === true ||
      shouldRefreshTokenBundle(bundle, {
        bufferMs: ACCESS_TOKEN_EXPIRY_BUFFER_MS,
      });
    if (!refreshRequired && state.usableNow && !mirrorRequiresRepair) {
      return { ...bundle, refreshed: false, migrated: false };
    }
    return null;
  }

  if (
    state.kind === "legacy" &&
    !migrationAllowed(shopDomain, options) &&
    !mirrorRequiresRepair
  ) {
    return { ...bundle, refreshed: false, migrated: false, legacy: true };
  }

  // A still-valid access token with incomplete metadata remains usable until
  // Shopify rejects it. It cannot be repaired without a refresh token, so a
  // distributed refresh lock would add contention without changing state.
  if (
    state.usableNow &&
    options.forceRefresh !== true &&
    state.kind === "partial"
  ) {
    return { ...bundle, partial: true, refreshed: false, migrated: false };
  }

  return null;
}

export async function ensureValidShopOfflineAccessToken(
  shop,
  options = {},
) {
  const shopDomain = normalizeShop(shop);
  if (!shopDomain) throw new Error("Missing shop");

  const initialSnapshot = await getShopifyTokenSnapshot(shopDomain, {
    record: options.record || null,
    fallbackAccessToken: options.fallbackAccessToken || "",
  });
  if (!initialSnapshot.preferred) {
    throw new ShopifyReauthorizationRequiredError(
      shopDomain,
      "missing_credentials",
    );
  }
  const fastPath = resolveReadOnlyTokenFastPath(
    initialSnapshot,
    shopDomain,
    options,
  );
  if (fastPath) return fastPath;

  return withDistributedShopTokenLock(shopDomain, async () => {
    let snapshot = await getShopifyTokenSnapshot(shopDomain, {
      record: options.record || null,
      fallbackAccessToken: options.fallbackAccessToken || "",
    });
    let bundle = snapshot.preferred;
    let state = snapshot.classification;
    if (!bundle) {
      throw new ShopifyReauthorizationRequiredError(
        shopDomain,
        "missing_credentials",
      );
    }

    if (
      options.forceRefresh === true &&
      options.failedAccessToken &&
      bundle.accessToken &&
      !sameToken(bundle.accessToken, options.failedAccessToken) &&
      state.usableNow
    ) {
      if (snapshot.mirrorOutOfSync && options.repairMirror !== false) {
        bundle = (await mirrorPreferredBundle(snapshot)) || bundle;
      }
      return { ...bundle, refreshed: false, recoveredFromNewerToken: true };
    }

    if (
      state.kind === "expiring" ||
      (state.kind === "partial" && bundle.refreshToken)
    ) {
      const refreshRequired =
        options.forceRefresh === true ||
        shouldRefreshTokenBundle(bundle, {
          bufferMs: ACCESS_TOKEN_EXPIRY_BUFFER_MS,
        });
      if (!refreshRequired && state.usableNow) {
        if (snapshot.mirrorOutOfSync && options.repairMirror !== false) {
          bundle = (await mirrorPreferredBundle(snapshot)) || bundle;
        }
        return { ...bundle, refreshed: false, migrated: false };
      }

      if (
        !bundle.refreshToken ||
        (bundle.refreshTokenExpiresAt &&
          isDateExpired(bundle.refreshTokenExpiresAt, new Date(), 0))
      ) {
        return markReauthorizationRequired(
          shopDomain,
          null,
          "refresh_token_missing_or_expired",
          { expectedAccessToken: bundle.accessToken },
        );
      }

      try {
        const refreshedBundle = await refreshWithSafeRetries(
          shopDomain,
          bundle.refreshToken,
        );
        const persisted = await persistTokenBundleAtomic(refreshedBundle, {
          expectedAccessToken: bundle.accessToken,
          host: snapshot.shopRecord?.host || null,
        });
        if (persisted?.conflict) {
          snapshot = await getShopifyTokenSnapshot(shopDomain);
          const winner = snapshot.preferred;
          if (winner && classifyTokenBundle(winner).usableNow) {
            return {
              ...winner,
              refreshed: false,
              recoveredFromNewerToken: true,
            };
          }
        }
        return { ...persisted.bundle, refreshed: true, migrated: false };
      } catch (error) {
        snapshot = await getShopifyTokenSnapshot(shopDomain);
        const winner = snapshot.preferred;
        if (
          winner?.accessToken &&
          !sameToken(winner.accessToken, bundle.accessToken) &&
          classifyTokenBundle(winner).usableNow
        ) {
          return {
            ...winner,
            refreshed: false,
            recoveredFromNewerToken: true,
          };
        }
        if (isDefinitiveInvalidRefreshTokenError(error)) {
          return markReauthorizationRequired(
            shopDomain,
            error,
            "invalid_refresh_token",
            { expectedAccessToken: bundle.accessToken },
          );
        }
        await recordTokenError(shopDomain, error);
        if (state.usableNow && options.forceRefresh !== true) {
          return { ...bundle, refreshed: false, refreshDeferred: true };
        }
        throw error;
      }
    }

    if (state.kind === "legacy") {
      if (!migrationAllowed(shopDomain, options)) {
        if (snapshot.mirrorOutOfSync && options.repairMirror !== false) {
          bundle = (await mirrorPreferredBundle(snapshot)) || bundle;
        }
        return { ...bundle, refreshed: false, migrated: false, legacy: true };
      }
      try {
        const migratedBundle = await migrateLegacyToken(
          shopDomain,
          bundle.accessToken,
        );
        const persisted = await persistTokenBundleAtomic(migratedBundle, {
          expectedAccessToken: bundle.accessToken,
          host: snapshot.shopRecord?.host || null,
        });
        if (persisted?.conflict) {
          snapshot = await getShopifyTokenSnapshot(shopDomain);
          if (snapshot.preferred) {
            return {
              ...snapshot.preferred,
              migrated: classifyTokenBundle(snapshot.preferred).kind === "expiring",
              refreshed: false,
              recoveredFromNewerToken: true,
            };
          }
        }
        return { ...persisted.bundle, migrated: true, refreshed: false };
      } catch (error) {
        snapshot = await getShopifyTokenSnapshot(shopDomain);
        const winner = snapshot.preferred;
        if (
          winner &&
          classifyTokenBundle(winner).kind === "expiring" &&
          !sameToken(winner.accessToken, bundle.accessToken)
        ) {
          return {
            ...winner,
            migrated: true,
            refreshed: false,
            recoveredFromNewerToken: true,
          };
        }
        await recordTokenError(shopDomain, error);
        // Migration is irreversible, but a failed exchange doesn't prove that
        // Shopify revoked the legacy token. Let the Admin request decide; a 401
        // will take the guarded reauthorization path without retry loops.
        if (options.forceRefresh !== true) {
          return { ...bundle, migrated: false, refreshed: false, legacy: true };
        }
        if ([400, 401, 403].includes(Number(getShopifyErrorStatus(error)))) {
          return markReauthorizationRequired(
            shopDomain,
            error,
            "legacy_token_invalid",
            { expectedAccessToken: bundle.accessToken },
          );
        }
        throw error;
      }
    }

    if (state.usableNow && options.forceRefresh !== true) {
      await recordTokenError(
        shopDomain,
        new Error("Incomplete Shopify refresh-token metadata."),
        SHOPIFY_TOKEN_STATUS.PARTIAL,
      );
      return { ...bundle, partial: true, refreshed: false, migrated: false };
    }

    return markReauthorizationRequired(
      shopDomain,
      null,
      state.reason || "broken_partial_credentials",
      { expectedAccessToken: bundle.accessToken },
    );
  });
}

export async function getValidShopAdminAccessToken(shop, options = {}) {
  const state = await ensureValidShopOfflineAccessToken(shop, options);
  return state.accessToken;
}

export async function persistOfflineSessionToShop({
  shop,
  session,
  host = null,
  scopes = "",
  installedAt = null,
}) {
  const shopDomain = normalizeShop(shop || session?.shop);
  const incoming = tokenBundleFromSession(session, {
    source: "shopify_session_sync",
    updatedAt: new Date(),
  });
  incoming.shop = shopDomain;
  if (scopes) incoming.scope = asText(scopes);
  return withDistributedShopTokenLock(shopDomain, async () => {
    const snapshot = await getShopifyTokenSnapshot(shopDomain);
    const preferred = selectPreferredTokenBundle(
      [snapshot.preferred, incoming].filter(Boolean),
    );
    if (!preferred || !isCompleteTokenBundle(preferred)) {
      throw new Error("Cannot synchronize an incomplete Shopify offline token.");
    }
    return persistTokenBundleAtomic(preferred, {
      host,
      installedAt,
      expectedAccessToken: snapshot.preferred?.accessToken || "",
    });
  });
}

export async function persistOfflineTokenPayload({
  shop,
  payload = {},
  host = null,
  scopes = "",
  installedAt = null,
}) {
  const shopDomain = normalizeShop(shop || payload.shop);
  const incoming = normalizeTokenBundle({
    shop: shopDomain,
    accessToken: payload.accessToken,
    accessTokenExpiresAt: payload.accessTokenExpiresAt,
    refreshToken: payload.refreshToken,
    refreshTokenExpiresAt: payload.refreshTokenExpiresAt,
    tokenType: payload.tokenType || "offline",
    scope: payload.scopes || scopes,
    source: "embedded_app_sync",
    updatedAt: new Date(),
  });
  return withDistributedShopTokenLock(shopDomain, async () => {
    const snapshot = await getShopifyTokenSnapshot(shopDomain);
    const preferred = selectPreferredTokenBundle(
      [snapshot.preferred, incoming].filter(Boolean),
    );
    if (!preferred || !isCompleteTokenBundle(preferred)) {
      const error = new Error(
        "Cannot synchronize a partial Shopify offline token response.",
      );
      error.code = "SHOPIFY_INCOMPLETE_TOKEN_BUNDLE";
      throw error;
    }
    return persistTokenBundleAtomic(preferred, {
      host,
      installedAt,
      expectedAccessToken: snapshot.preferred?.accessToken || "",
    });
  });
}

export async function revokeShopifyTokenState(shop) {
  const shopDomain = normalizeShop(shop);
  if (!shopDomain) throw new Error("Missing shop");
  return withDistributedShopTokenLock(shopDomain, async () => {
    const sessionStore = await getSessionStore();
    if (!sessionStore.sharesPrimaryClient) {
      throw new Error(
        "Shopify session storage must share MongoDB for atomic revocation.",
      );
    }
    await runTokenStorageWrite(
      sessionStore,
      "revoke_token_state",
      async (mongoSession) => {
        const deleteSessionMirror = () =>
          sessionStore.collection.deleteOne(
            { id: shopify.session.getOfflineId(shopDomain) },
            mongoSession ? { session: mongoSession } : {},
          );
        const revokeShopRecord = () =>
          Shop.collection.updateOne(
            { shop: shopDomain },
            {
              $set: {
                accessToken: null,
                accessTokenType: "offline",
                accessTokenUpdatedAt: new Date(),
                accessTokenExpiresAt: null,
                accessTokenRefreshToken: null,
                accessTokenRefreshTokenExpiresAt: null,
                accessTokenMigratedAt: null,
                accessTokenStatus: SHOPIFY_TOKEN_STATUS.REVOKED,
                accessTokenLastError: null,
                accessTokenLastErrorAt: null,
              },
              $inc: { accessTokenVersion: 1 },
            },
            mongoSession ? { session: mongoSession } : {},
          );
        if (mongoSession) {
          await deleteSessionMirror();
          await revokeShopRecord();
        } else {
          await revokeShopRecord();
          await deleteSessionMirror();
        }
      },
    );
    return { ok: true, shop: shopDomain };
  });
}

export function classifyShopifyTokenAudit(snapshot, options = {}) {
  const preferred = snapshot?.preferred;
  // Preserve the guarded rejection state derived from the Shop mirror. A
  // rejected token can still look structurally complete, so reclassifying the
  // raw bundle here would incorrectly report it as healthy/repairable.
  const state =
    options.now == null && snapshot?.classification
      ? snapshot.classification
      : classifyTokenBundle(preferred || { shop: snapshot?.shop }, {
          now: options.now,
          bufferMs: ACCESS_TOKEN_EXPIRY_BUFFER_MS,
        });
  let category = "healthy";
  if (state.requiresReauthorization) category = "reauthorization_required";
  else if (state.kind === "partial" && !state.automaticallyRepairable) {
    category = "broken_partial_migration";
  }
  else if (
    state.automaticallyRepairable ||
    state.kind === "legacy" ||
    snapshot?.mirrorOutOfSync
  ) {
    category = "automatically_repairable";
  }
  return {
    shop: snapshot?.shop,
    category,
    reason: state.reason,
    tokenKind: state.kind,
    tokenStatus: state.status,
    source: preferred?.source || null,
    accessTokenExpiresAt: preferred?.accessTokenExpiresAt || null,
    refreshTokenExpiresAt: preferred?.refreshTokenExpiresAt || null,
    mirrorOutOfSync: snapshot?.mirrorOutOfSync === true,
    hasAccessToken: !!preferred?.accessToken,
    hasRefreshToken: !!preferred?.refreshToken,
  };
}

export async function auditShopifyTokens({ shops = [], limit = 500 } = {}) {
  const normalizedShops = shops.map(normalizeShop).filter(Boolean);
  const parsedLimit = Number(limit);
  const safeLimit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.floor(parsedLimit)
      : 500;
  const sessionStore = await getSessionStore();
  const query = normalizedShops.length ? { shop: { $in: normalizedShops } } : {};
  const [rows, sessionRows] = await Promise.all([
    Shop.find(query)
      .select({ shop: 1 })
      .sort({ shop: 1 })
      .limit(safeLimit)
      .lean(),
    sessionStore.collection
      .find(
        {
          isOnline: { $ne: true },
          ...(normalizedShops.length
            ? { shop: { $in: normalizedShops } }
            : {}),
        },
        { projection: { shop: 1, payload: 1 } },
      )
      .sort({ shop: 1 })
      .limit(safeLimit)
      .toArray(),
  ]);
  const shopDomains = Array.from(
    new Set(
      [
        ...normalizedShops,
        ...rows.map((row) => normalizeShop(row?.shop)),
        ...sessionRows.map((row) =>
          normalizeShop(
            row?.shop || tokenBundleFromSessionDocument(row)?.shop,
          ),
        ),
      ].filter(Boolean),
    ),
  )
    .sort()
    .slice(0, safeLimit);
  const reports = [];
  for (const shopDomain of shopDomains) {
    const snapshot = await getShopifyTokenSnapshot(shopDomain);
    reports.push(classifyShopifyTokenAudit(snapshot));
  }
  const summary = reports.reduce(
    (counts, report) => {
      counts.total += 1;
      counts[report.category] = Number(counts[report.category] || 0) + 1;
      return counts;
    },
    {
      total: 0,
      healthy: 0,
      automatically_repairable: 0,
      broken_partial_migration: 0,
      reauthorization_required: 0,
    },
  );
  return { dryRun: true, summary, stores: reports };
}

export async function migrateLegacyOfflineTokensBatch({
  limit = 10,
  shops = [],
  dryRun = true,
} = {}) {
  const parsedLimit = Number(limit);
  const safeLimit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.floor(parsedLimit)
      : 10;
  const explicitShops = Array.from(
    new Set(shops.map(normalizeShop).filter(Boolean)),
  );
  // A batch must advance past already-healthy shops. Auditing only `limit`
  // sorted shops would repeatedly revisit the same first page forever after
  // the first repair. Scan a bounded pool, then apply only the next repairable
  // slice. Explicit canaries remain strictly limited to their supplied shops.
  const configuredScanLimit = Number(
    process.env.SHOPIFY_OFFLINE_TOKEN_MIGRATION_SCAN_LIMIT || 5000,
  );
  const scanLimit = explicitShops.length
    ? explicitShops.length
    : Math.max(
        safeLimit,
        Number.isFinite(configuredScanLimit) && configuredScanLimit > 0
          ? configuredScanLimit
          : 5000,
      );
  const audit = await auditShopifyTokens({
    shops: explicitShops,
    limit: scanLimit,
  });
  const rows = explicitShops.length
    ? audit.stores.slice(0, safeLimit)
    : audit.stores
        .filter((report) => report.category === "automatically_repairable")
        .slice(0, safeLimit);
  const result = {
    dryRun: dryRun !== false,
    scanned: rows.length,
    migrated: 0,
    repaired: 0,
    repairable: 0,
    brokenPartial: 0,
    unchanged: 0,
    reauthorizationRequired: 0,
    failed: 0,
    stores: [],
  };
  for (const row of rows) {
    try {
      const report = row;
      if (dryRun !== false) {
        result.repairable += Number(
          report.category === "automatically_repairable",
        );
        result.reauthorizationRequired += Number(
          report.category === "reauthorization_required",
        );
        result.brokenPartial += Number(
          report.category === "broken_partial_migration",
        );
        result.unchanged += Number(report.category === "healthy");
        result.stores.push(report);
        continue;
      }
      if (report.category !== "automatically_repairable") {
        result.reauthorizationRequired += Number(
          report.category === "reauthorization_required",
        );
        result.brokenPartial += Number(
          report.category === "broken_partial_migration",
        );
        result.unchanged += Number(report.category === "healthy");
        result.stores.push(report);
        continue;
      }
      const state = await ensureValidShopOfflineAccessToken(row.shop, {
        forceMigration: true,
        migrateLegacy: true,
        repairMirror: true,
      });
      result.migrated += Number(state?.migrated === true);
      result.repaired += 1;
      result.stores.push({
        shop: row.shop,
        category: state?.migrated ? "migrated" : "repaired",
      });
    } catch (error) {
      if (error?.code === "SHOPIFY_REAUTHORIZATION_REQUIRED") {
        result.reauthorizationRequired += 1;
        result.stores.push({
          shop: row.shop,
          category: "reauthorization_required",
          reason: error.reason,
        });
      } else {
        result.failed += 1;
        result.stores.push({
          shop: row.shop,
          category: "failed",
          error: sanitizeShopifyTokenError(error),
        });
      }
    }
  }
  return result;
}

export const shopifyTokenServiceInternals = {
  assertPersistableTokenBundle,
  sessionDocumentFromBundle,
  tokenBundleFromSessionDocument,
  migrationAllowed,
  getShopifyErrorStatus,
};
