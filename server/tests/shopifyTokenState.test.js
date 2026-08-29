import assert from "node:assert/strict";
import test from "node:test";
import {
  SHOPIFY_TOKEN_STATUS,
  buildShopTokenUpdate,
  buildShopifyCredentialCandidateQuery,
  classifyTokenBundle,
  createKeyedMutex,
  executeWithOneUnauthorizedRetry,
  sanitizeShopifyTokenError,
  selectPreferredTokenBundle,
} from "../services/shopifyTokenState.js";

const SHOP = "token-state.myshopify.com";

function minutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60_000);
}

test("classifies legacy, healthy expiring, and refreshable partial records", () => {
  const legacy = classifyTokenBundle({
    shop: SHOP,
    accessToken: "legacy-access",
  });
  assert.equal(legacy.kind, "legacy");
  assert.equal(legacy.usableNow, true);
  assert.equal(legacy.status, SHOPIFY_TOKEN_STATUS.LEGACY);

  const healthy = classifyTokenBundle({
    shop: SHOP,
    accessToken: "new-access",
    accessTokenExpiresAt: minutesFromNow(60),
    refreshToken: "new-refresh",
    refreshTokenExpiresAt: minutesFromNow(60 * 24 * 30),
  });
  assert.equal(healthy.kind, "expiring");
  assert.equal(healthy.usableNow, true);
  assert.equal(healthy.status, SHOPIFY_TOKEN_STATUS.ACTIVE);

  const partial = classifyTokenBundle({
    shop: SHOP,
    refreshToken: "recoverable-refresh",
    refreshTokenExpiresAt: minutesFromNow(60 * 24),
  });
  assert.equal(partial.kind, "partial");
  assert.equal(partial.automaticallyRepairable, true);
});

test("never treats an online access token as a background offline token", () => {
  const online = classifyTokenBundle({
    shop: SHOP,
    accessToken: "online-access",
    tokenType: "online",
  });

  assert.equal(online.kind, "online");
  assert.equal(online.usableNow, false);
  assert.equal(online.requiresReauthorization, true);
  assert.equal(online.reason, "online_token_not_valid_for_background");
});

test("prefers a newer canonical expiring pair over a stale shop mirror", () => {
  const preferred = selectPreferredTokenBundle([
    {
      shop: SHOP,
      source: "shop_record",
      accessToken: "stale-access",
      accessTokenExpiresAt: minutesFromNow(-60),
      refreshToken: "stale-refresh",
      refreshTokenExpiresAt: minutesFromNow(60 * 24),
      updatedAt: minutesFromNow(-120),
    },
    {
      shop: SHOP,
      source: "shopify_session",
      accessToken: "canonical-access",
      accessTokenExpiresAt: minutesFromNow(55),
      refreshToken: "canonical-refresh",
      refreshTokenExpiresAt: minutesFromNow(60 * 24 * 30),
      updatedAt: new Date(),
    },
  ]);

  assert.equal(preferred.source, "shopify_session");
  assert.equal(preferred.accessToken, "canonical-access");
  assert.equal(preferred.refreshToken, "canonical-refresh");
});

test("prefers a repairable rotated refresh token over an invalidated legacy token", () => {
  const preferred = selectPreferredTokenBundle([
    {
      shop: SHOP,
      source: "shop_record",
      accessToken: "old-legacy-access",
    },
    {
      shop: SHOP,
      source: "shopify_session",
      refreshToken: "rotated-refresh",
      refreshTokenExpiresAt: minutesFromNow(60 * 24),
      updatedAt: new Date(),
    },
  ]);

  assert.equal(preferred.source, "shopify_session");
  assert.equal(preferred.refreshToken, "rotated-refresh");
});

test("prefers a usable canonical partial access token over a revoked legacy mirror", () => {
  const preferred = selectPreferredTokenBundle([
    {
      shop: SHOP,
      source: "shop_record",
      accessToken: "pre-migration-legacy-access",
      updatedAt: minutesFromNow(-120),
    },
    {
      shop: SHOP,
      source: "shopify_session",
      accessToken: "newer-canonical-access",
      accessTokenExpiresAt: minutesFromNow(45),
      updatedAt: new Date(),
    },
  ]);

  assert.equal(preferred.source, "shopify_session");
  assert.equal(preferred.accessToken, "newer-canonical-access");
});

test("prefers a usable canonical partial access token over an expired rotating mirror", () => {
  const preferred = selectPreferredTokenBundle([
    {
      shop: SHOP,
      source: "shop_record",
      accessToken: "expired-pre-rotation-access",
      accessTokenExpiresAt: minutesFromNow(-60),
      refreshToken: "possibly-invalidated-refresh",
      refreshTokenExpiresAt: minutesFromNow(60 * 24 * 30),
      updatedAt: minutesFromNow(-120),
    },
    {
      shop: SHOP,
      source: "shopify_session",
      accessToken: "usable-canonical-access",
      accessTokenExpiresAt: minutesFromNow(45),
      updatedAt: new Date(),
    },
  ]);

  assert.equal(preferred.source, "shopify_session");
  assert.equal(preferred.accessToken, "usable-canonical-access");
});

test("builds one complete atomic Shop token update", () => {
  const update = buildShopTokenUpdate({
    shop: SHOP,
    accessToken: "rotated-access",
    accessTokenExpiresAt: minutesFromNow(60),
    refreshToken: "rotated-refresh",
    refreshTokenExpiresAt: minutesFromNow(60 * 24 * 30),
    scope: "read_orders",
  });

  assert.equal(update.accessToken, "rotated-access");
  assert.ok(update.accessTokenExpiresAt instanceof Date);
  assert.equal(update.accessTokenRefreshToken, "rotated-refresh");
  assert.ok(update.accessTokenRefreshTokenExpiresAt instanceof Date);
  assert.equal(update.accessTokenStatus, SHOPIFY_TOKEN_STATUS.ACTIVE);
  assert.equal(update.scopes, "read_orders");
});

test("retries a Shopify request once after 401 and never loops", async () => {
  let requests = 0;
  let recoveries = 0;
  const result = await executeWithOneUnauthorizedRetry({
    request: async ({ retry }) => {
      requests += 1;
      if (!retry) throw Object.assign(new Error("401 Unauthorized"), { status: 401 });
      return "ok-after-refresh";
    },
    recover: async () => {
      recoveries += 1;
      return { accessToken: "fresh-access" };
    },
  });

  assert.equal(result, "ok-after-refresh");
  assert.equal(requests, 2);
  assert.equal(recoveries, 1);

  let finalUnauthorized = 0;
  await assert.rejects(
    executeWithOneUnauthorizedRetry({
      request: async () => {
        throw Object.assign(new Error("401 Unauthorized"), { status: 401 });
      },
      recover: async () => ({ accessToken: "fresh-access" }),
      onRetryUnauthorized: async () => {
        finalUnauthorized += 1;
      },
    }),
    /401 Unauthorized/,
  );
  assert.equal(finalUnauthorized, 1);
});

test("keyed mutex serializes different operations without sharing return values", async () => {
  const mutex = createKeyedMutex();
  const events = [];
  const first = mutex.run(SHOP, async () => {
    events.push("first:start");
    await new Promise((resolve) => setTimeout(resolve, 30));
    events.push("first:end");
    return { kind: "refresh" };
  });
  const second = mutex.run(SHOP, async () => {
    events.push("second:start");
    events.push("second:end");
    return { kind: "uninstall" };
  });

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(events, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
  assert.deepEqual(firstResult, { kind: "refresh" });
  assert.deepEqual(secondResult, { kind: "uninstall" });
  assert.equal(mutex.pendingCount(), 0);
});

test("sanitizes token-like values and exposes a partial-record worker query", () => {
  const sanitized = sanitizeShopifyTokenError(
    Object.assign(new Error("401 token shpat_SECRET0123456789 rejected"), {
      status: 401,
    }),
  );
  assert.doesNotMatch(sanitized, /SECRET0123456789/);
  assert.match(sanitized, /<redacted-token>/);

  const query = buildShopifyCredentialCandidateQuery();
  assert.equal(Array.isArray(query.$or), true);
  assert.equal(query.$or.length, 3);
});
