import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import "@shopify/shopify-api/adapters/node";
import {
  ApiVersion,
  RequestedTokenType,
  shopifyApi,
} from "@shopify/shopify-api";
import { setAbstractFetchFunc } from "@shopify/shopify-api/runtime";

function base64Url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sessionToken({ apiKey, secret, shop }) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64Url({ alg: "HS256", typ: "JWT" })}.${base64Url({
    aud: apiKey,
    dest: `https://${shop}`,
    exp: now + 60,
    iat: now,
    iss: `https://${shop}/admin`,
    nbf: now - 5,
    sub: "1",
  })}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(unsigned)
    .digest("base64url");
  return `${unsigned}.${signature}`;
}

test("official token exchange parses one complete rotating offline pair", async () => {
  const apiKey = "official-exchange-key";
  const secret = "official-exchange-secret";
  const shop = "official-exchange.myshopify.com";
  let requestBody = null;
  setAbstractFetchFunc(async (_url, init) => {
    requestBody = JSON.parse(String(init?.body || "{}"));
    return new Response(
      JSON.stringify({
        access_token: "rotated-access",
        scope: "read_orders",
        expires_in: 3600,
        refresh_token: "rotated-refresh",
        refresh_token_expires_in: 7_776_000,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  });

  try {
    const api = shopifyApi({
      apiKey,
      apiSecretKey: secret,
      scopes: ["read_orders"],
      hostName: "official-exchange.invalid",
      apiVersion: ApiVersion.October25,
      isEmbeddedApp: true,
    });
    const { session } = await api.auth.tokenExchange({
      shop,
      sessionToken: sessionToken({ apiKey, secret, shop }),
      requestedTokenType: RequestedTokenType.OfflineAccessToken,
      expiring: true,
    });

    assert.equal(requestBody.expiring, "1");
    assert.equal(session.isOnline, false);
    assert.equal(session.accessToken, "rotated-access");
    assert.ok(session.expires instanceof Date);
    assert.equal(session.refreshToken, "rotated-refresh");
    assert.ok(session.refreshTokenExpires instanceof Date);
  } finally {
    setAbstractFetchFunc(globalThis.fetch);
  }
});
