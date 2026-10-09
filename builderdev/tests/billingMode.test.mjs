import assert from "node:assert/strict";
import test from "node:test";

import { isShopifyBillingTestMode } from "../app/utils/billingMode.server.js";

test("uses test billing in development and real billing in production", () => {
  assert.equal(isShopifyBillingTestMode({ NODE_ENV: "development" }), true);
  assert.equal(isShopifyBillingTestMode({ NODE_ENV: "production" }), false);
});

test("allows an explicit billing-mode override", () => {
  assert.equal(
    isShopifyBillingTestMode({
      NODE_ENV: "production",
      SHOPIFY_BILLING_TEST_MODE: "true",
    }),
    true,
  );
  assert.equal(
    isShopifyBillingTestMode({
      NODE_ENV: "development",
      SHOPIFY_BILLING_TEST_MODE: "false",
    }),
    false,
  );
});
