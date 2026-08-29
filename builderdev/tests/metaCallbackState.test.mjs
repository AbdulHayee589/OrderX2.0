import assert from "node:assert/strict";
import test from "node:test";

import { isMetaCallbackForActiveState } from "../app/utils/metaCallbackState.js";

test("rejects a stored Meta callback when no connect attempt is active", () => {
  assert.equal(isMetaCallbackForActiveState("", "old-state"), false);
});

test("rejects a Meta callback from a superseded connect attempt", () => {
  assert.equal(
    isMetaCallbackForActiveState("current-state", "previous-state"),
    false,
  );
});

test("accepts the current state", () => {
  assert.equal(
    isMetaCallbackForActiveState("current-state", "current-state"),
    true,
  );
});

test("rejects missing state except for the direct FB SDK response", () => {
  assert.equal(isMetaCallbackForActiveState("current-state", ""), false);
  assert.equal(
    isMetaCallbackForActiveState("current-state", "", {
      allowMissingCallbackState: true,
    }),
    true,
  );
});
