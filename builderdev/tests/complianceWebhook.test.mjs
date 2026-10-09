import assert from "node:assert/strict";
import test from "node:test";

import { normalizeComplianceTopic } from "../app/utils/complianceWebhook.js";

test("normalizes Shopify compliance topic headers and SDK enum names", () => {
  assert.equal(
    normalizeComplianceTopic("customers/data_request"),
    "CUSTOMERS_DATA_REQUEST",
  );
  assert.equal(normalizeComplianceTopic("customers/redact"), "CUSTOMERS_REDACT");
  assert.equal(normalizeComplianceTopic("SHOP_REDACT"), "SHOP_REDACT");
});
