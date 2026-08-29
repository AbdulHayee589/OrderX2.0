import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../../builderdev/node_modules/@shopify/shopify-api/dist/esm/lib/index.mjs";
import {
  assertCompleteOfflineSession,
  isIncompleteExpiringOfflineSession,
  matchesStoredOfflineSessionForInvalidation,
  shouldKeepStoredOfflineSession,
  shouldTreatOfflineSessionAsMissing,
} from "../../builderdev/app/sessionStorage.server.js";

function session(values = {}) {
  const hasAccessToken = Object.prototype.hasOwnProperty.call(
    values,
    "accessToken",
  );
  return new Session({
    id: "offline_storage-test.myshopify.com",
    shop: "storage-test.myshopify.com",
    state: "",
    isOnline: false,
    scope: "read_orders",
    accessToken: hasAccessToken ? values.accessToken : "access",
    ...(values.expires ? { expires: values.expires } : {}),
    ...(values.refreshToken ? { refreshToken: values.refreshToken } : {}),
    ...(values.refreshTokenExpires
      ? { refreshTokenExpires: values.refreshTokenExpires }
      : {}),
  });
}

test("accepts a legacy token and a complete rotated pair", () => {
  assert.doesNotThrow(() => assertCompleteOfflineSession(session()));
  assert.doesNotThrow(() =>
    assertCompleteOfflineSession(
      session({
        accessToken: "rotated-access",
        expires: new Date(Date.now() + 3_600_000),
        refreshToken: "rotated-refresh",
        refreshTokenExpires: new Date(Date.now() + 30 * 86_400_000),
      }),
    ),
  );
});

test("rejects every partial expiring-token combination", () => {
  assert.throws(
    () =>
      assertCompleteOfflineSession(
        session({ expires: new Date(Date.now() + 3_600_000) }),
      ),
    /partial Shopify expiring offline token pair/,
  );
  assert.throws(
    () =>
      assertCompleteOfflineSession(
        session({
          refreshToken: "refresh-only",
          refreshTokenExpires: new Date(Date.now() + 86_400_000),
        }),
      ),
    /partial Shopify expiring offline token pair/,
  );
});

test("forces an active partial expiring session through token exchange", () => {
  const now = Date.now();
  const partial = session({
    accessToken: "new-access-without-refresh-pair",
    expires: new Date(now + 3_600_000),
  });
  const complete = session({
    accessToken: "complete-access",
    expires: new Date(now + 3_500_000),
    refreshToken: "complete-refresh",
    refreshTokenExpires: new Date(now + 90 * 86_400_000),
  });

  assert.equal(isIncompleteExpiringOfflineSession(partial), true);
  assert.equal(shouldTreatOfflineSessionAsMissing(partial, now), true);
  assert.equal(shouldKeepStoredOfflineSession(partial, complete), false);
});

test("accepts Shopify's exact 401 invalidation shape but rejects stale invalidation", () => {
  const expires = new Date(Date.now() + 3_600_000);
  const refreshTokenExpires = new Date(Date.now() + 30 * 86_400_000);
  const stored = session({
    accessToken: "current-access",
    expires,
    refreshToken: "current-refresh",
    refreshTokenExpires,
  });
  const invalidated = session({
    accessToken: undefined,
    expires,
    refreshToken: "current-refresh",
    refreshTokenExpires,
  });
  const staleInvalidation = session({
    accessToken: undefined,
    expires,
    refreshToken: "older-refresh",
    refreshTokenExpires,
  });

  assert.doesNotThrow(() => assertCompleteOfflineSession(invalidated));
  assert.equal(
    matchesStoredOfflineSessionForInvalidation(stored, invalidated),
    true,
  );
  assert.equal(shouldKeepStoredOfflineSession(stored, invalidated), false);
  assert.equal(
    matchesStoredOfflineSessionForInvalidation(stored, staleInvalidation),
    false,
  );
  assert.equal(shouldKeepStoredOfflineSession(stored, staleInvalidation), true);
});

test("treats unrecoverable offline sessions as missing for token exchange", () => {
  const now = Date.now();
  const expiredRefresh = session({
    accessToken: "expired-access",
    expires: new Date(now - 60_000),
    refreshToken: "expired-refresh",
    refreshTokenExpires: new Date(now - 1_000),
  });
  const invalidatedWithValidRefresh = session({
    accessToken: undefined,
    expires: new Date(now - 60_000),
    refreshToken: "valid-refresh",
    refreshTokenExpires: new Date(now + 86_400_000),
  });
  const invalidatedLegacy = session({ accessToken: undefined });

  assert.equal(shouldTreatOfflineSessionAsMissing(expiredRefresh, now), true);
  assert.equal(
    shouldTreatOfflineSessionAsMissing(invalidatedWithValidRefresh, now),
    false,
  );
  assert.equal(shouldTreatOfflineSessionAsMissing(invalidatedLegacy, now), true);
});

test("prevents a stale process from overwriting a newer canonical session", () => {
  const newer = session({
    accessToken: "new-access",
    expires: new Date(Date.now() + 3_600_000),
    refreshToken: "new-refresh",
    refreshTokenExpires: new Date(Date.now() + 30 * 86_400_000),
  });
  const legacy = session({ accessToken: "old-legacy" });
  const older = session({
    accessToken: "older-access",
    expires: new Date(Date.now() + 60_000),
    refreshToken: "older-refresh",
    refreshTokenExpires: new Date(Date.now() + 20 * 86_400_000),
  });

  assert.equal(shouldKeepStoredOfflineSession(newer, legacy), true);
  assert.equal(shouldKeepStoredOfflineSession(newer, older), true);
  assert.equal(shouldKeepStoredOfflineSession(older, newer), false);
});
