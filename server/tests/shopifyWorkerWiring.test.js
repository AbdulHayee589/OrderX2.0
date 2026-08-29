import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("COD polling and billing workers use the central refresh-aware Admin client", () => {
  const poll = read("jobs/pollCodOrders.js");
  const definitions = read("jobs/definitions.js");
  const billing = read("services/shopifyBillingSync.js");

  assert.match(poll, /buildShopifyCredentialCandidateQuery/);
  assert.match(poll, /getAdminClient\(shop,/);
  assert.match(poll, /for \(const shopRecord of shops\)/);
  assert.match(poll, /catch \(err\)/);
  assert.match(definitions, /syncBillingFromShopify/);
  assert.match(definitions, /buildShopifyCredentialCandidateQuery/);
  assert.match(billing, /getAdminClient\(shop,/);
});

test("uninstall revokes canonical session state and order processing has a unique key", () => {
  const internal = read("routes/internal.js");
  const attemptModel = read("models/CodAttempt.js");

  assert.match(internal, /await revokeShopifyTokenState\(shop\)/);
  assert.match(
    attemptModel,
    /index\(\{ shop: 1, orderGid: 1, stage: 1 \}, \{ unique: true \}\)/,
  );
});
