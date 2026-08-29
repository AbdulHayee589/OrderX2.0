/* global globalThis */
import { Session } from "@shopify/shopify-api";
import { MongoClient } from "mongodb";
import "./env.server.js";

const SESSION_COLLECTION_NAME =
  process.env.SHOPIFY_SESSION_COLLECTION || "shopifySessions";
const SHOPIFY_SESSION_MONGO_URI =
  process.env.SHOPIFY_SESSION_MONGO_URI || process.env.MONGO_URI || "";
const SHOPIFY_SESSION_MONGO_DB =
  process.env.SHOPIFY_SESSION_MONGO_DB || deriveDatabaseName(SHOPIFY_SESSION_MONGO_URI);

function deriveDatabaseName(uri) {
  if (!uri) return "OrderX";
  try {
    const parsed = new URL(uri);
    const pathname = String(parsed.pathname || "/").replace(/^\/+/, "");
    return pathname ? decodeURIComponent(pathname) : "OrderX";
  } catch {
    return "OrderX";
  }
}

function getMongoClientPromise() {
  if (!SHOPIFY_SESSION_MONGO_URI) {
    throw new Error(
      "Missing SHOPIFY_SESSION_MONGO_URI or MONGO_URI for Shopify session storage.",
    );
  }

  if (!globalThis.__orderxSessionMongoClientPromise) {
    const client = new MongoClient(SHOPIFY_SESSION_MONGO_URI, {
      appName: "OrderX Builder Sessions",
      maxPoolSize: 10,
      minPoolSize: 0,
      retryWrites: true,
    });
    globalThis.__orderxSessionMongoClientPromise = client.connect();
  }

  return globalThis.__orderxSessionMongoClientPromise;
}

let indexesReadyPromise;
let legacyPrismaStoragePromise;
let legacyPrismaAvailable = true;

async function getLegacyPrismaStorage() {
  if (!legacyPrismaAvailable) return null;
  if (!legacyPrismaStoragePromise) {
    legacyPrismaStoragePromise = (async () => {
      try {
        const [{ PrismaSessionStorage }, { PrismaClient }] = await Promise.all([
          import("@shopify/shopify-app-session-storage-prisma"),
          import("@prisma/client"),
        ]);
        const prisma = new PrismaClient();
        return new PrismaSessionStorage(prisma);
      } catch (error) {
        const message = String(error?.message || "");
        if (
          message.includes("did not initialize yet") ||
          message.includes("Cannot find module") ||
          message.includes("no such file")
        ) {
          legacyPrismaAvailable = false;
          return null;
        }
        throw error;
      }
    })();
  }
  return legacyPrismaStoragePromise;
}

async function getSessionCollection() {
  const client = await getMongoClientPromise();
  const db = client.db(SHOPIFY_SESSION_MONGO_DB || undefined);
  const collection = db.collection(SESSION_COLLECTION_NAME);
  if (!indexesReadyPromise) {
    indexesReadyPromise = Promise.all([
      collection.createIndex({ id: 1 }, { unique: true, name: "id_unique" }),
      collection.createIndex({ shop: 1, updatedAt: -1 }, { name: "shop_updatedAt" }),
      collection.createIndex({ expiresAt: -1 }, { name: "expiresAt_desc" }),
    ]).catch((error) => {
      indexesReadyPromise = null;
      throw error;
    });
  }
  await indexesReadyPromise;
  return collection;
}

function sessionToDocument(session) {
  return {
    id: session.id,
    shop: session.shop,
    isOnline: session.isOnline === true,
    expiresAt: session.expires || null,
    payload: session.toPropertyArray(true),
    updatedAt: new Date(),
  };
}

function documentToSession(doc) {
  if (!doc?.payload || !Array.isArray(doc.payload)) return undefined;
  try {
    return Session.fromPropertyArray(doc.payload, true);
  } catch {
    return undefined;
  }
}

export function isOfflineAccessTokenInvalidation(session) {
  return !!session && session.isOnline !== true && !session.accessToken;
}

export function isIncompleteExpiringOfflineSession(session) {
  if (!session || session.isOnline === true) return false;
  const hasAccessExpiry = !!session.expires;
  const hasRefreshToken = !!String(session.refreshToken || "").trim();
  const hasRefreshExpiry = !!session.refreshTokenExpires;
  const hasAnyExpiringMetadata =
    hasAccessExpiry || hasRefreshToken || hasRefreshExpiry;

  return (
    hasAnyExpiringMetadata &&
    !(hasAccessExpiry && hasRefreshToken && hasRefreshExpiry)
  );
}

function sameDate(left, right) {
  return (left?.getTime?.() || 0) === (right?.getTime?.() || 0);
}

export function matchesStoredOfflineSessionForInvalidation(
  storedSession,
  incomingSession,
) {
  if (
    !storedSession?.accessToken ||
    !isOfflineAccessTokenInvalidation(incomingSession) ||
    storedSession.id !== incomingSession.id ||
    storedSession.shop !== incomingSession.shop
  ) {
    return false;
  }

  const storedHasExpiringMetadata = Boolean(
    storedSession.expires ||
      storedSession.refreshToken ||
      storedSession.refreshTokenExpires,
  );
  const incomingHasExpiringMetadata = Boolean(
    incomingSession.expires ||
      incomingSession.refreshToken ||
      incomingSession.refreshTokenExpires,
  );

  // Shopify's 401 handler mutates the loaded Session by removing only its
  // accessToken. Match every remaining credential field before accepting that
  // invalidation, so a stale process cannot erase a newly rotated token pair.
  if (storedHasExpiringMetadata || incomingHasExpiringMetadata) {
    return (
      sameDate(storedSession.expires, incomingSession.expires) &&
      String(storedSession.refreshToken || "") ===
        String(incomingSession.refreshToken || "") &&
      sameDate(
        storedSession.refreshTokenExpires,
        incomingSession.refreshTokenExpires,
      )
    );
  }

  return true;
}

export function shouldKeepStoredOfflineSession(storedSession, incomingSession) {
  if (isOfflineAccessTokenInvalidation(incomingSession)) {
    return !matchesStoredOfflineSessionForInvalidation(
      storedSession,
      incomingSession,
    );
  }
  if (!storedSession?.accessToken || incomingSession?.isOnline === true) {
    return false;
  }

  // A partial pair cannot refresh safely. Always let a complete pair obtained
  // by a fresh token exchange replace it, even when their one-hour access
  // expiries are close enough for the partial record to look newer.
  if (
    isIncompleteExpiringOfflineSession(storedSession) &&
    !isIncompleteExpiringOfflineSession(incomingSession)
  ) {
    return false;
  }
  const storedExpiry = storedSession.expires?.getTime?.() || 0;
  const incomingExpiry = incomingSession?.expires?.getTime?.() || 0;

  // A stale legacy process must never replace a token that has already been
  // migrated to Shopify's expiring access/refresh pair.
  if (storedExpiry > 0 && incomingExpiry === 0) return true;
  if (storedExpiry > incomingExpiry) return true;
  if (
    storedExpiry === incomingExpiry &&
    storedSession.accessToken !== incomingSession?.accessToken
  ) {
    return true;
  }
  return false;
}

export function assertCompleteOfflineSession(session) {
  if (!session || session.isOnline === true) return session;
  if (isIncompleteExpiringOfflineSession(session)) {
    const error = new Error(
      "Refusing to store a partial Shopify expiring offline token pair.",
    );
    error.code = "SHOPIFY_INCOMPLETE_TOKEN_BUNDLE";
    throw error;
  }
  // A tokenless legacy session, or a complete expiring session with only the
  // access token removed, is Shopify's deliberate 401 invalidation shape.
  // storeSession verifies it against the currently stored credential before
  // allowing it to replace anything.
  return session;
}

export function shouldTreatOfflineSessionAsMissing(
  session,
  referenceTime = Date.now(),
) {
  if (!session || session.isOnline === true) return false;
  // Returning undefined makes authenticate.admin() perform token exchange on
  // the current embedded request. Keeping an active-but-partial access token
  // would postpone recovery until it expires and leave workers without a
  // usable rotating refresh-token pair.
  if (isIncompleteExpiringOfflineSession(session)) return true;
  const nowMs = Number(referenceTime);
  const refreshExpiryMs = session.refreshTokenExpires?.getTime?.() || 0;
  if (refreshExpiryMs && refreshExpiryMs <= nowMs) return true;

  const hasUsableRefresh = Boolean(
    session.refreshToken && refreshExpiryMs > nowMs,
  );
  if (!session.accessToken && !hasUsableRefresh) return true;

  const accessExpiryMs = session.expires?.getTime?.() || 0;
  return Boolean(
    session.accessToken &&
      accessExpiryMs &&
      accessExpiryMs <= nowMs &&
      !hasUsableRefresh,
  );
}

function tokenStatusForSession(session) {
  if (!session?.accessToken) return "invalidated";
  return session.refreshToken ? "active" : "legacy";
}

async function loadLegacyPrismaSession(id) {
  const storage = await getLegacyPrismaStorage();
  if (!storage) return undefined;
  try {
    return await storage.loadSession(id);
  } catch (error) {
    const message = String(error?.message || "");
    if (
      message.includes("does not exist") ||
      message.includes("no such table") ||
      message.includes("Can't reach database server") ||
      message.includes("Error querying the database")
    ) {
      legacyPrismaAvailable = false;
      return undefined;
    }
    throw error;
  }
}

async function loadLegacyPrismaSessionsByShop(shop) {
  const storage = await getLegacyPrismaStorage();
  if (!storage?.findSessionsByShop) return [];
  try {
    return (await storage.findSessionsByShop(shop)) || [];
  } catch (error) {
    const message = String(error?.message || "");
    if (
      message.includes("does not exist") ||
      message.includes("no such table") ||
      message.includes("Can't reach database server") ||
      message.includes("Error querying the database")
    ) {
      legacyPrismaAvailable = false;
      return [];
    }
    throw error;
  }
}

class MongoSessionStorage {
  async storeSession(session) {
    assertCompleteOfflineSession(session);
    const collection = await getSessionCollection();
    const doc = sessionToDocument(session);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const existing = await collection.findOne(
        { id: session.id },
        { projection: { _id: 1, payload: 1, updatedAt: 1, tokenVersion: 1 } },
      );
      if (!existing) {
        // An invalidation is meaningful only for the exact session that
        // produced the 401. If another process already removed it, there is
        // nothing left to invalidate and the next embedded request will token
        // exchange normally.
        if (isOfflineAccessTokenInvalidation(session)) return true;
        try {
          await collection.insertOne({
            ...doc,
            tokenStatus: tokenStatusForSession(session),
            tokenVersion: 1,
            createdAt: new Date(),
          });
          return true;
        } catch (error) {
          if (Number(error?.code) === 11000) continue;
          throw error;
        }
      }

      const storedSession = documentToSession(existing);
      if (
        session.isOnline !== true &&
        shouldKeepStoredOfflineSession(storedSession, session)
      ) {
        return true;
      }

      const result = await collection.updateOne(
        {
          _id: existing._id,
          ...(existing.updatedAt ? { updatedAt: existing.updatedAt } : {}),
        },
        {
          $set: {
            ...doc,
            tokenStatus: tokenStatusForSession(session),
            tokenVersion: Number(existing.tokenVersion || 0) + 1,
          },
        },
      );
      if (result.matchedCount === 1) return true;
    }
    throw new Error("Shopify session changed repeatedly while being stored.");
  }

  async loadSession(id) {
    const collection = await getSessionCollection();
    const doc = await collection.findOne({ id });
    const mongoSession = documentToSession(doc);
    if (doc) {
      return mongoSession &&
        !shouldTreatOfflineSessionAsMissing(mongoSession)
        ? mongoSession
        : undefined;
    }
    const legacySession = await loadLegacyPrismaSession(id);
    if (
      legacySession &&
      !shouldTreatOfflineSessionAsMissing(legacySession)
    ) {
      await this.storeSession(legacySession);
      return legacySession;
    }
    return undefined;
  }

  async deleteSession(id) {
    const collection = await getSessionCollection();
    await collection.deleteOne({ id });
    const storage = await getLegacyPrismaStorage();
    if (storage) {
      try {
        await storage.deleteSession(id);
      } catch (error) {
        void error;
      }
    }
    return true;
  }

  async deleteSessions(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return true;
    const collection = await getSessionCollection();
    await collection.deleteMany({ id: { $in: ids } });
    const storage = await getLegacyPrismaStorage();
    if (storage?.deleteSessions) {
      try {
        await storage.deleteSessions(ids);
      } catch (error) {
        void error;
      }
    }
    return true;
  }

  async findSessionsByShop(shop) {
    const collection = await getSessionCollection();
    const docs = await collection
      .find({ shop })
      .sort({ expiresAt: -1, updatedAt: -1 })
      .limit(25)
      .toArray();
    const mongoSessions = docs
      .map(documentToSession)
      .filter(
        (session) =>
          session && !shouldTreatOfflineSessionAsMissing(session),
      );
    if (mongoSessions.length > 0) return mongoSessions;
    if (docs.length > 0) return [];
    const legacySessions = await loadLegacyPrismaSessionsByShop(shop);
    if (legacySessions.length > 0) {
      await Promise.allSettled(legacySessions.map((session) => this.storeSession(session)));
    }
    return legacySessions;
  }
}

const sessionStorage = new MongoSessionStorage();

export default sessionStorage;
