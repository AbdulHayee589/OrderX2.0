import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { MongoClient } from "mongodb";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, "fixtures", "shopifyTokenWorker.js");
const DB_NAME = "orderx_token_test";
const originalFetch = globalThis.fetch;

let mongod = null;
let dbPath = "";
let mongoUri = "";
let Shop;
let CodAttempt;
let PlanPurchase;
let Session;
let shopify;
let tokenService;
let setAbstractFetchFunc;
let syncBillingFromShopify;
let originalRefreshToken;
let originalMigrateToken;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForMongo(uri, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 400,
      directConnection: true,
    });
    try {
      await client.connect();
      return client;
    } catch {
      await client.close().catch(() => null);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Local MongoDB test replica did not start.");
}

async function startReplicaSet() {
  const lookup = spawnSync("sh", ["-c", "command -v mongod"], {
    encoding: "utf8",
  });
  const mongodPath = String(lookup.stdout || "").trim();
  if (!mongodPath) return null;

  const port = await getFreePort();
  dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "orderx-token-test-"));
  mongod = spawn(
    mongodPath,
    [
      "--dbpath",
      dbPath,
      "--port",
      String(port),
      "--bind_ip",
      "127.0.0.1",
      "--replSet",
      "rs0",
      "--quiet",
    ],
    { stdio: "ignore" },
  );

  const directUri = `mongodb://127.0.0.1:${port}/admin`;
  const client = await waitForMongo(directUri);
  try {
    await client.db("admin").command({
      replSetInitiate: {
        _id: "rs0",
        members: [{ _id: 0, host: `127.0.0.1:${port}` }],
      },
    });
  } catch (error) {
    if (!/already initialized/i.test(String(error?.message || error))) {
      throw error;
    }
  } finally {
    await client.close();
  }

  const replicaUri = `mongodb://127.0.0.1:${port}/${DB_NAME}?replicaSet=rs0`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const replicaClient = new MongoClient(replicaUri, {
      serverSelectionTimeoutMS: 500,
    });
    try {
      await replicaClient.connect();
      await replicaClient.db("admin").command({ ping: 1 });
      await replicaClient.close();
      return replicaUri;
    } catch {
      await replicaClient.close().catch(() => null);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Local MongoDB replica did not elect a primary.");
}

function makeSession(shop, values = {}) {
  return new Session({
    id: shopify.session.getOfflineId(shop),
    shop,
    state: "",
    isOnline: false,
    scope: "read_orders,write_orders",
    accessToken: values.accessToken || "test-access",
    ...(values.legacy
      ? {}
      : {
          expires: values.expires || new Date(Date.now() + 3_600_000),
          refreshToken: values.refreshToken || "test-refresh",
          refreshTokenExpires:
            values.refreshTokenExpires ||
            new Date(Date.now() + 30 * 86_400_000),
        }),
  });
}

async function persistSession(shop, values = {}) {
  return tokenService.persistOfflineSessionToShop({
    shop,
    session: makeSession(shop, values),
    installedAt: new Date(),
  });
}

async function loadCanonicalSession(shop) {
  const doc = await mongoose.connection.db
    .collection(process.env.SHOPIFY_SESSION_COLLECTION)
    .findOne({ id: shopify.session.getOfflineId(shop) });
  return doc ? Session.fromPropertyArray(doc.payload, true) : null;
}

function runWorker(mode, shop) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, mode, shop], {
      cwd: path.join(HERE, ".."),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Token worker failed (${code}): ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        const marker = "__TOKEN_TEST_RESULT__";
        const markerIndex = stdout.lastIndexOf(marker);
        if (markerIndex < 0) throw new Error("result marker missing");
        resolve(JSON.parse(stdout.slice(markerIndex + marker.length)));
      } catch {
        reject(new Error(`Token worker returned invalid JSON: ${stdout.slice(0, 500)}`));
      }
    });
  });
}

before(
  async (context) => {
    mongoUri = await startReplicaSet();
    if (!mongoUri) {
      context.skip("mongod is unavailable; integration tests require local MongoDB");
      return;
    }
    if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/orderx_token_test/.test(mongoUri)) {
      throw new Error("Refusing to run token integration tests outside local test MongoDB.");
    }

    Object.assign(process.env, {
      NODE_ENV: "test",
      MONGO_URI: mongoUri,
      SHOPIFY_SESSION_MONGO_URI: mongoUri,
      SHOPIFY_SESSION_MONGO_DB: DB_NAME,
      SHOPIFY_SESSION_COLLECTION: "shopifyTokenIntegrationSessions",
      SHOPIFY_TOKEN_LOCK_COLLECTION: "shopifyTokenIntegrationLocks",
      SHOPIFY_API_KEY: "test_api_key",
      SHOPIFY_API_SECRET: "test_api_secret",
      APP_URL: "https://token-tests.invalid",
      SHOPIFY_APP_URL: "https://token-tests.invalid",
      SCOPES: "read_orders,write_orders",
      SHOPIFY_OFFLINE_TOKEN_AUTO_MIGRATION_ENABLED: "false",
      SHOPIFY_OFFLINE_TOKEN_MIGRATION_CANARY_SHOPS: "",
    });

    await mongoose.connect(mongoUri, { autoIndex: false });
    ({ default: Shop } = await import("../models/Shop.js"));
    ({ default: CodAttempt } = await import("../models/CodAttempt.js"));
    ({ default: PlanPurchase } = await import("../models/PlanPurchase.js"));
    ({ Session } = await import("@shopify/shopify-api"));
    ({ shopify } = await import("../shopify.js"));
    tokenService = await import("../services/shopifyTokenService.js");
    ({ setAbstractFetchFunc } = await import("@shopify/shopify-api/runtime"));
    ({ syncBillingFromShopify } = await import(
      "../services/shopifyBillingSync.js"
    ));
    originalRefreshToken = shopify.auth.refreshToken;
    originalMigrateToken = shopify.auth.migrateToExpiringToken;
  },
  { timeout: 40_000 },
);

beforeEach(async () => {
  if (!mongoUri || mongoose.connection.readyState !== 1) return;
  shopify.auth.refreshToken = originalRefreshToken;
  shopify.auth.migrateToExpiringToken = originalMigrateToken;
  setAbstractFetchFunc(originalFetch);
  await mongoose.connection.db.dropDatabase();
});

after(async () => {
  if (shopify) {
    shopify.auth.refreshToken = originalRefreshToken;
    shopify.auth.migrateToExpiringToken = originalMigrateToken;
  }
  if (setAbstractFetchFunc) setAbstractFetchFunc(originalFetch);
  await mongoose.disconnect().catch(() => null);
  if (mongod) {
    mongod.kill("SIGTERM");
    await new Promise((resolve) => mongod.once("exit", resolve));
  }
  if (dbPath) fs.rmSync(dbPath, { recursive: true, force: true });
});

test("new installation atomically stores the complete pair in both stores", async () => {
  const shop = "new-install.myshopify.com";
  await persistSession(shop, {
    accessToken: "install-access",
    refreshToken: "install-refresh",
  });

  const [record, session] = await Promise.all([
    Shop.findOne({ shop }).lean(),
    loadCanonicalSession(shop),
  ]);
  assert.equal(record.accessToken, "install-access");
  assert.equal(record.accessTokenRefreshToken, "install-refresh");
  assert.ok(record.accessTokenExpiresAt);
  assert.ok(record.accessTokenRefreshTokenExpiresAt);
  assert.equal(session.accessToken, "install-access");
  assert.equal(session.refreshToken, "install-refresh");
});

test("detects MongoDB deployments that support token transactions", () => {
  assert.equal(
    tokenService.mongoHelloSupportsTransactions({ setName: "rs0" }),
    true,
  );
  assert.equal(
    tokenService.mongoHelloSupportsTransactions({ msg: "isdbgrid" }),
    true,
  );
  assert.equal(
    tokenService.mongoHelloSupportsTransactions({ isWritablePrimary: true }),
    false,
  );
});

test("legacy-token migration stores the rotated access and refresh pair", async () => {
  const shop = "legacy-migration.myshopify.com";
  await Shop.create({
    shop,
    accessToken: "legacy-access",
    accessTokenType: "offline",
    accessTokenUpdatedAt: new Date(),
  });
  shopify.auth.migrateToExpiringToken = async () => ({
    session: makeSession(shop, {
      accessToken: "migrated-access",
      refreshToken: "migrated-refresh",
    }),
  });

  const state = await tokenService.ensureValidShopOfflineAccessToken(shop, {
    forceMigration: true,
  });
  const [record, session] = await Promise.all([
    Shop.findOne({ shop }).lean(),
    loadCanonicalSession(shop),
  ]);
  assert.equal(state.migrated, true);
  assert.equal(record.accessToken, "migrated-access");
  assert.equal(record.accessTokenRefreshToken, "migrated-refresh");
  assert.equal(session.accessToken, "migrated-access");
  assert.equal(session.refreshToken, "migrated-refresh");
});

test("expired access token refreshes and rotates both credentials", async () => {
  const shop = "refresh-rotation.myshopify.com";
  await persistSession(shop, {
    accessToken: "expired-access",
    expires: new Date(Date.now() - 60_000),
    refreshToken: "old-refresh",
  });
  shopify.auth.refreshToken = async ({ refreshToken }) => {
    assert.equal(refreshToken, "old-refresh");
    return {
      session: makeSession(shop, {
        accessToken: "fresh-access",
        refreshToken: "fresh-refresh",
      }),
    };
  };

  const state = await tokenService.ensureValidShopOfflineAccessToken(shop);
  const [record, session] = await Promise.all([
    Shop.findOne({ shop }).lean(),
    loadCanonicalSession(shop),
  ]);
  assert.equal(state.refreshed, true);
  assert.equal(record.accessToken, "fresh-access");
  assert.equal(record.accessTokenRefreshToken, "fresh-refresh");
  assert.equal(session.accessToken, "fresh-access");
  assert.equal(session.refreshToken, "fresh-refresh");
});

test("concurrent refresh attempts in one process rotate only once", async () => {
  const shop = "single-process-lock.myshopify.com";
  await persistSession(shop, {
    accessToken: "expired-access",
    expires: new Date(Date.now() - 60_000),
    refreshToken: "old-refresh",
  });
  let refreshes = 0;
  shopify.auth.refreshToken = async () => {
    refreshes += 1;
    await new Promise((resolve) => setTimeout(resolve, 80));
    return {
      session: makeSession(shop, {
        accessToken: "one-fresh-access",
        refreshToken: "one-fresh-refresh",
      }),
    };
  };

  const states = await Promise.all(
    Array.from({ length: 8 }, () =>
      tokenService.ensureValidShopOfflineAccessToken(shop),
    ),
  );
  assert.equal(refreshes, 1);
  assert.equal(states.every((state) => state.accessToken === "one-fresh-access"), true);
});

test("distributed per-shop lock prevents two processes from refreshing together", async () => {
  const shop = "distributed-lock.myshopify.com";
  await persistSession(shop, {
    accessToken: "expired-access",
    expires: new Date(Date.now() - 60_000),
    refreshToken: "old-refresh",
  });

  const results = await Promise.all([
    runWorker("refresh", shop),
    runWorker("refresh", shop),
  ]);
  const counter = await mongoose.connection.db
    .collection("tokenTestCounters")
    .findOne({ _id: shop });
  assert.equal(results.every((result) => result.ok), true);
  assert.equal(counter.refreshes, 1);
});

test("transaction abort never saves only one half of a rotated pair", async () => {
  const shop = "atomic-failure.myshopify.com";
  await persistSession(shop, {
    accessToken: "old-access",
    expires: new Date(Date.now() - 60_000),
    refreshToken: "old-refresh",
  });
  shopify.auth.refreshToken = async () => ({
    session: makeSession(shop, {
      accessToken: "new-access",
      refreshToken: "new-refresh",
    }),
  });

  const originalUpdateOne = Shop.collection.updateOne;
  Shop.collection.updateOne = async () => {
    throw new Error("simulated Shop mirror write failure");
  };
  try {
    await assert.rejects(
      tokenService.ensureValidShopOfflineAccessToken(shop),
      /simulated Shop mirror write failure/,
    );
  } finally {
    Shop.collection.updateOne = originalUpdateOne;
  }

  const [record, session] = await Promise.all([
    Shop.findOne({ shop }).lean(),
    loadCanonicalSession(shop),
  ]);
  assert.equal(record.accessToken, "old-access");
  assert.equal(record.accessTokenRefreshToken, "old-refresh");
  assert.equal(session.accessToken, "old-access");
  assert.equal(session.refreshToken, "old-refresh");
});

test("invalid refresh token is classified for merchant reauthorization", async () => {
  const shop = "invalid-refresh.myshopify.com";
  await persistSession(shop, {
    accessToken: "expired-access",
    expires: new Date(Date.now() - 60_000),
    refreshToken: "invalid-refresh",
  });
  shopify.auth.refreshToken = async () => {
    const error = Object.assign(
      new Error("This request requires an active refresh_token"),
      {
        statusCode: 401,
        body: {
          error: "invalid_request",
          error_description:
            "This request requires an active refresh_token",
        },
      },
    );
    throw error;
  };

  await assert.rejects(
    tokenService.ensureValidShopOfflineAccessToken(shop),
    (error) => error?.code === "SHOPIFY_REAUTHORIZATION_REQUIRED",
  );
  const [record, canonical] = await Promise.all([
    Shop.findOne({ shop }).lean(),
    loadCanonicalSession(shop),
  ]);
  assert.equal(record.accessTokenStatus, "reauthorization_required");
  assert.equal(canonical, null);

  const audit = await tokenService.auditShopifyTokens({ shops: [shop] });
  assert.equal(audit.stores[0].category, "reauthorization_required");
  assert.equal(audit.stores[0].reason, "stored_token_rejected");
});

test("stale token rejection cannot invalidate a newer rotated pair", async () => {
  const shop = "stale-rejection.myshopify.com";
  await persistSession(shop, {
    accessToken: "current-access",
    refreshToken: "current-refresh",
  });

  const outcome = await tokenService.flagShopifyReauthorizationRequired(
    shop,
    Object.assign(new Error("Unauthorized"), { statusCode: 401 }),
    "fresh_token_rejected",
    { expectedAccessToken: "stale-access" },
  );
  const [record, canonical] = await Promise.all([
    Shop.findOne({ shop }).lean(),
    loadCanonicalSession(shop),
  ]);
  assert.equal(outcome.conflict, true);
  assert.equal(record.accessTokenStatus, "active");
  assert.equal(record.accessToken, "current-access");
  assert.equal(canonical.accessToken, "current-access");
});

test("a partially migrated record with a valid refresh token repairs itself", async () => {
  const shop = "partial-repair.myshopify.com";
  await Shop.collection.insertOne({
    shop,
    accessToken: "partial-expired-access",
    accessTokenExpiresAt: new Date(Date.now() - 60_000),
    accessTokenRefreshToken: "partial-valid-refresh",
    accessTokenRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
    accessTokenType: "offline",
    accessTokenStatus: "partial",
    accessTokenUpdatedAt: new Date(),
  });
  shopify.auth.refreshToken = async ({ refreshToken }) => {
    assert.equal(refreshToken, "partial-valid-refresh");
    return {
      session: makeSession(shop, {
        accessToken: "repaired-access",
        refreshToken: "repaired-refresh",
      }),
    };
  };

  const state = await tokenService.ensureValidShopOfflineAccessToken(shop);
  assert.equal(state.refreshed, true);
  const record = await Shop.findOne({ shop }).lean();
  assert.equal(record.accessToken, "repaired-access");
  assert.equal(record.accessTokenRefreshToken, "repaired-refresh");
});

test("a usable canonical partial token bridges an expired pre-rotation mirror", async () => {
  const shop = "partial-canonical-bridge.myshopify.com";
  const now = new Date();
  await Shop.collection.insertOne({
    shop,
    accessToken: "expired-mirror-access",
    accessTokenExpiresAt: new Date(now.getTime() - 60_000),
    accessTokenRefreshToken: "pre-rotation-refresh",
    accessTokenRefreshTokenExpiresAt: new Date(
      now.getTime() + 30 * 86_400_000,
    ),
    accessTokenType: "offline",
    accessTokenStatus: "active",
    accessTokenUpdatedAt: new Date(now.getTime() - 2 * 3_600_000),
  });
  const partialSession = new Session({
    id: shopify.session.getOfflineId(shop),
    shop,
    state: "",
    isOnline: false,
    scope: "read_orders,write_orders",
    accessToken: "usable-canonical-access",
    expires: new Date(now.getTime() + 45 * 60_000),
  });
  await mongoose.connection.db
    .collection(process.env.SHOPIFY_SESSION_COLLECTION)
    .insertOne({
      id: partialSession.id,
      shop,
      isOnline: false,
      expiresAt: partialSession.expires,
      payload: partialSession.toPropertyArray(true),
      tokenStatus: "partial",
      tokenVersion: 2,
      createdAt: now,
      updatedAt: now,
    });

  const state = await tokenService.ensureValidShopOfflineAccessToken(shop);

  assert.equal(state.accessToken, "usable-canonical-access");
  assert.equal(state.partial, true);
  const record = await Shop.findOne({ shop }).lean();
  assert.equal(record.accessToken, "expired-mirror-access");
});

test("a complete Shop-only token pair recreates the missing canonical session", async () => {
  const shop = "shop-only-pair.myshopify.com";
  await Shop.collection.insertOne({
    shop,
    accessToken: "shop-only-access",
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    accessTokenRefreshToken: "shop-only-refresh",
    accessTokenRefreshTokenExpiresAt: new Date(
      Date.now() + 30 * 86_400_000,
    ),
    accessTokenType: "offline",
    accessTokenStatus: "active",
    accessTokenUpdatedAt: new Date(),
  });

  const state = await tokenService.ensureValidShopOfflineAccessToken(shop);
  const canonical = await loadCanonicalSession(shop);
  assert.equal(state.accessToken, "shop-only-access");
  assert.equal(canonical.accessToken, "shop-only-access");
  assert.equal(canonical.refreshToken, "shop-only-refresh");
});

test("valid credentials remain usable when optional mirror repair fails", async () => {
  const shop = "mirror-maintenance-failure.myshopify.com";
  await Shop.collection.insertOne({
    shop,
    accessToken: "usable-access",
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    accessTokenRefreshToken: "usable-refresh",
    accessTokenRefreshTokenExpiresAt: new Date(
      Date.now() + 30 * 86_400_000,
    ),
    accessTokenType: "offline",
    accessTokenStatus: "active",
    accessTokenUpdatedAt: new Date(),
  });

  const originalUpdateOne = Shop.collection.updateOne;
  Shop.collection.updateOne = async () => {
    throw new Error("simulated mirror maintenance failure");
  };
  try {
    const state = await tokenService.ensureValidShopOfflineAccessToken(shop);
    assert.equal(state.accessToken, "usable-access");
  } finally {
    Shop.collection.updateOne = originalUpdateOne;
  }

  assert.equal(await loadCanonicalSession(shop), null);
});

test("Admin request refreshes after one 401 and retries with the new token", async () => {
  const shop = "admin-retry.myshopify.com";
  await persistSession(shop, {
    accessToken: "initial-access",
    refreshToken: "initial-refresh",
  });
  let requests = 0;
  const seenTokens = [];
  setAbstractFetchFunc(async (_url, options = {}) => {
    requests += 1;
    const headers = new Headers(options.headers || {});
    seenTokens.push(headers.get("X-Shopify-Access-Token"));
    if (requests === 1) {
      return new Response(JSON.stringify({ errors: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: { shop: { name: "Token Test" } } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  shopify.auth.refreshToken = async () => ({
    session: makeSession(shop, {
      accessToken: "retry-fresh-access",
      refreshToken: "retry-fresh-refresh",
    }),
  });

  const { getAdminClient } = await import("../utils/shopifyAdmin.js");
  const admin = await getAdminClient(shop);
  const result = await admin.query({ data: "query { shop { name } }" });
  assert.equal(result.body.data.shop.name, "Token Test");
  assert.equal(requests, 2);
  assert.deepEqual(seenTokens, ["initial-access", "retry-fresh-access"]);
});

test("a second Admin 401 invalidates only the rejected canonical pair", async () => {
  const shop = "admin-second-401.myshopify.com";
  await persistSession(shop, {
    accessToken: "initial-rejected-access",
    refreshToken: "initial-rejected-refresh",
  });
  let requests = 0;
  setAbstractFetchFunc(async () => {
    requests += 1;
    return new Response(JSON.stringify({ errors: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  });
  shopify.auth.refreshToken = async () => ({
    session: makeSession(shop, {
      accessToken: "fresh-rejected-access",
      refreshToken: "fresh-rejected-refresh",
    }),
  });

  const { getAdminClient } = await import("../utils/shopifyAdmin.js");
  const admin = await getAdminClient(shop);
  await assert.rejects(
    admin.query({ data: "query { shop { name } }" }),
    /401/,
  );
  const [record, canonical] = await Promise.all([
    Shop.findOne({ shop }).lean(),
    loadCanonicalSession(shop),
  ]);
  assert.equal(requests, 2);
  assert.equal(record.accessToken, "fresh-rejected-access");
  assert.equal(record.accessTokenStatus, "reauthorization_required");
  assert.equal(canonical, null);
});

test("plan sync succeeds after refresh and uses the rotated token", async () => {
  const shop = "plan-sync.myshopify.com";
  await persistSession(shop, {
    accessToken: "expired-plan-access",
    expires: new Date(Date.now() - 60_000),
    refreshToken: "plan-refresh",
  });
  await Shop.updateOne(
    { shop },
    { $set: { "billing.planKey": "own_number_starter_5" } },
  );
  shopify.auth.refreshToken = async () => ({
    session: makeSession(shop, {
      accessToken: "plan-fresh-access",
      refreshToken: "plan-fresh-refresh",
    }),
  });
  let requestToken = null;
  setAbstractFetchFunc(async (_url, options = {}) => {
    requestToken = new Headers(options.headers || {}).get(
      "X-Shopify-Access-Token",
    );
    return new Response(
      JSON.stringify({
        data: {
          currentAppInstallation: {
            activeSubscriptions: [
              {
                id: "gid://shopify/AppSubscription/1",
                name: "own_number_starter_5",
                test: false,
                status: "ACTIVE",
                trialDays: 0,
                createdAt: new Date().toISOString(),
                currentPeriodEnd: new Date(
                  Date.now() + 30 * 86_400_000,
                ).toISOString(),
                lineItems: [],
              },
            ],
          },
          shop: {
            plan: {
              partnerDevelopment: false,
              publicDisplayName: "Basic",
              shopifyPlus: false,
            },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  const result = await syncBillingFromShopify(shop, "");
  const record = await Shop.findOne({ shop }).lean();
  assert.equal(result.picked.name, "own_number_starter_5");
  assert.equal(requestToken, "plan-fresh-access");
  assert.equal(record.billing.status, "ACTIVE");
  assert.equal(record.accessToken, "plan-fresh-access");
});

test("uninstall revokes canonical and mirror tokens; reinstall stores a new pair", async () => {
  const shop = "reinstall.myshopify.com";
  await persistSession(shop, {
    accessToken: "before-uninstall-access",
    refreshToken: "before-uninstall-refresh",
  });
  await Shop.updateOne(
    { shop },
    { $set: { "billing.planKey": "own_number_starter_5" } },
  );

  await tokenService.revokeShopifyTokenState(shop);
  let record = await Shop.findOne({ shop }).lean();
  assert.equal(record.accessToken, null);
  assert.equal(record.accessTokenRefreshToken, null);
  assert.equal(record.accessTokenStatus, "revoked");
  assert.equal(await loadCanonicalSession(shop), null);
  assert.equal(record.billing.planKey, "own_number_starter_5");

  await persistSession(shop, {
    accessToken: "reinstall-access",
    refreshToken: "reinstall-refresh",
  });
  record = await Shop.findOne({ shop }).lean();
  assert.equal(record.accessToken, "reinstall-access");
  assert.equal(record.accessTokenRefreshToken, "reinstall-refresh");
  assert.equal(record.accessTokenStatus, "active");
});

test("persisted token remains usable from a clean worker process restart", async () => {
  const shop = "restart.myshopify.com";
  await persistSession(shop, {
    accessToken: "restart-access",
    refreshToken: "restart-refresh",
  });
  const result = await runWorker("snapshot", shop);
  assert.deepEqual(result, {
    ok: true,
    source: "shopify_session",
    hasAccessToken: true,
    hasRefreshToken: true,
  });
});

test("database unique key prevents duplicate order processing", async () => {
  await CodAttempt.syncIndexes();
  const base = {
    shop: "dedupe.myshopify.com",
    orderGid: "gid://shopify/Order/100",
    orderName: "#100",
    stage: "pre_dispatch",
    status: "scheduled",
    phoneE164: "+15551234567",
  };
  const results = await Promise.allSettled([
    CodAttempt.create(base),
    CodAttempt.create(base),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(
    await CodAttempt.countDocuments({
      shop: base.shop,
      orderGid: base.orderGid,
      stage: base.stage,
    }),
    1,
  );
});

test("dry-run audit reports session-only installs without changing records", async () => {
  const shop = "session-only.myshopify.com";
  const session = makeSession(shop, {
    accessToken: "session-only-access",
    refreshToken: "session-only-refresh",
  });
  await mongoose.connection.db
    .collection(process.env.SHOPIFY_SESSION_COLLECTION)
    .insertOne({
      id: session.id,
      shop,
      isOnline: false,
      payload: session.toPropertyArray(true),
      expiresAt: session.expires,
      updatedAt: new Date(),
    });

  const beforeShops = await Shop.countDocuments({ shop });
  const report = await tokenService.auditShopifyTokens({ shops: [shop] });
  const afterShops = await Shop.countDocuments({ shop });
  assert.equal(report.dryRun, true);
  assert.equal(report.summary.total, 1);
  assert.equal(report.stores[0].source, "shopify_session");
  assert.equal(beforeShops, 0);
  assert.equal(afterShops, 0);
});

test("migration batches advance past healthy shops", async () => {
  await persistSession("a-healthy.myshopify.com", {
    accessToken: "healthy-access",
    refreshToken: "healthy-refresh",
  });
  await persistSession("z-refresh-needed.myshopify.com", {
    accessToken: "expired-access",
    expires: new Date(Date.now() - 60_000),
    refreshToken: "refresh-needed",
  });
  let refreshes = 0;
  shopify.auth.refreshToken = async ({ shop, refreshToken }) => {
    refreshes += 1;
    assert.equal(shop, "z-refresh-needed.myshopify.com");
    assert.equal(refreshToken, "refresh-needed");
    return {
      session: makeSession(shop, {
        accessToken: "batch-fresh-access",
        refreshToken: "batch-fresh-refresh",
      }),
    };
  };

  const result = await tokenService.migrateLegacyOfflineTokensBatch({
    limit: 1,
    dryRun: false,
  });
  const repaired = await Shop.findOne({
    shop: "z-refresh-needed.myshopify.com",
  }).lean();

  assert.equal(result.scanned, 1);
  assert.equal(result.repaired, 1);
  assert.equal(refreshes, 1);
  assert.equal(repaired.accessToken, "batch-fresh-access");
  assert.equal(repaired.accessTokenRefreshToken, "batch-fresh-refresh");
});
