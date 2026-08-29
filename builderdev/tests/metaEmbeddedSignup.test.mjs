import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMetaEmbeddedSignupOptions,
  META_COEXISTENCE_FEATURE_TYPE,
} from "../app/utils/metaEmbeddedSignup.js";

test("builds Meta's coexistence Embedded Signup v3 launch options", () => {
  const options = buildMetaEmbeddedSignupOptions({
    configId: "123456789",
    featureType: META_COEXISTENCE_FEATURE_TYPE,
  });

  assert.deepEqual(options, {
    config_id: "123456789",
    response_type: "code",
    override_default_response_type: true,
    extras: {
      setup: {},
      featureType: "whatsapp_business_app_onboarding",
      sessionInfoVersion: "3",
    },
  });
});

test("adds a solution ID without replacing coexistence options", () => {
  const options = buildMetaEmbeddedSignupOptions({
    configId: "123456789",
    featureType: " WHATSAPP_BUSINESS_APP_ONBOARDING ",
    solutionId: "987654321",
  });

  assert.deepEqual(options.extras, {
    setup: { solutionID: "987654321" },
    featureType: "whatsapp_business_app_onboarding",
    sessionInfoVersion: "3",
  });
});

test("does not pass unsupported feature types to Meta", () => {
  const options = buildMetaEmbeddedSignupOptions({
    configId: "123456789",
    featureType: "coexistence",
  });

  assert.deepEqual(options.extras, { setup: {} });
});

test("requires an Embedded Signup configuration ID", () => {
  assert.throws(
    () => buildMetaEmbeddedSignupOptions({}),
    /config ID is missing/,
  );
});
