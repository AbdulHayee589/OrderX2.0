import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateThresholdBatchCharge,
  shouldUseThresholdBatch,
} from "../services/shopifyUsageBilling.js";

test("uses threshold batching only for positive rates below Shopify's one-cent minimum", () => {
  assert.equal(shouldUseThresholdBatch(0.005), true);
  assert.equal(shouldUseThresholdBatch(0.0099), true);
  assert.equal(shouldUseThresholdBatch(0.01), false);
  assert.equal(shouldUseThresholdBatch(0), false);
});

test("combines two $0.005 messages into one $0.01 usage charge", () => {
  assert.deepEqual(
    calculateThresholdBatchCharge({
      accruedUsd: 0.005,
      reservedOrChargedUsd: 0,
    }),
    {
      outstandingUsd: 0.005,
      chargeAmount: 0,
      carryAfterUsd: 0.005,
    },
  );

  assert.deepEqual(
    calculateThresholdBatchCharge({
      accruedUsd: 0.01,
      reservedOrChargedUsd: 0,
    }),
    {
      outstandingUsd: 0.01,
      chargeAmount: 0.01,
      carryAfterUsd: 0,
    },
  );
});

test("preserves sub-cent carry after charging complete cents", () => {
  assert.deepEqual(
    calculateThresholdBatchCharge({
      accruedUsd: 0.0275,
      reservedOrChargedUsd: 0.01,
    }),
    {
      outstandingUsd: 0.0175,
      chargeAmount: 0.01,
      carryAfterUsd: 0.0075,
    },
  );
});
