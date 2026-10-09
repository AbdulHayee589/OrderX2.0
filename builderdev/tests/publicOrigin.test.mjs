import assert from "node:assert/strict";
import test from "node:test";

import { resolveRequestAppOrigin } from "../app/utils/publicOrigin.js";

function request(url, headers = {}) {
  return new Request(url, { headers });
}

test("uses the active Shopify tunnel instead of a static env app URL", () => {
  const origin = resolveRequestAppOrigin(
    request("http://localhost:3000/app/plans", {
      "x-forwarded-host": "current-tunnel.trycloudflare.com",
      "x-forwarded-proto": "https",
    }),
    "https://app.orderxapp.com",
  );

  assert.equal(origin, "https://current-tunnel.trycloudflare.com");
});

test("falls back to the configured app URL for a local direct request", () => {
  const origin = resolveRequestAppOrigin(
    request("http://localhost:3000/app/plans"),
    "https://app.orderxapp.com",
  );

  assert.equal(origin, "https://app.orderxapp.com");
});

test("never treats Shopify Admin as the app callback origin", () => {
  const origin = resolveRequestAppOrigin(
    request("http://localhost:3000/app/plans", {
      origin: "https://admin.shopify.com",
    }),
    "https://app.orderxapp.com",
  );

  assert.equal(origin, "https://app.orderxapp.com");
});
