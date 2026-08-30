import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMetaEmbeddedSignupOptions,
  META_COEXISTENCE_FEATURE_TYPE,
  reserveMetaEmbeddedSignupPopup,
  runMetaLoginInReservedPopup,
} from "../app/utils/metaEmbeddedSignup.js";

test("builds Meta's coexistence Embedded Signup v3 launch options", () => {
  const options = buildMetaEmbeddedSignupOptions({
    configId: "123456789",
    featureType: META_COEXISTENCE_FEATURE_TYPE,
  });

  assert.deepEqual(options, {
    config_id: "123456789",
    auth_type: "rerequest",
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

test("reserves a popup synchronously from the button click", () => {
  const calls = [];
  const popup = {
    closed: false,
    document: { title: "", body: { style: {}, textContent: "" } },
    focus() {},
  };
  const browserWindow = {
    open(...args) {
      calls.push(args);
      return popup;
    },
  };

  assert.equal(reserveMetaEmbeddedSignupPopup(browserWindow), popup);
  assert.equal(calls[0][0], "about:blank");
  assert.equal(popup.document.title, "Opening Meta");
  assert.match(popup.document.body.textContent, /Opening Meta/);
});

test("hands the already-authorized popup to the Meta SDK", () => {
  const navigations = [];
  let nativeOpenCalls = 0;
  const originalOpen = () => {
    nativeOpenCalls += 1;
    return null;
  };
  const browserWindow = { open: originalOpen };
  const popup = {
    closed: false,
    name: "orderx_meta_embedded_signup",
    location: {
      replace(url) {
        navigations.push(url);
      },
    },
    focus() {},
  };

  runMetaLoginInReservedPopup({
    browserWindow,
    popupWindow: popup,
    openLogin() {
      browserWindow.open(
        "https://www.facebook.com/v25.0/dialog/oauth?config_id=123",
        "fb-login-call-id",
        "width=600,height=679",
      );
    },
  });

  assert.equal(nativeOpenCalls, 0);
  assert.equal(popup.name, "fb-login-call-id");
  assert.deepEqual(navigations, [
    "https://www.facebook.com/v25.0/dialog/oauth?config_id=123",
  ]);
  assert.equal(browserWindow.open, originalOpen);
});

test("reports when Meta does not try to open its signup dialog", () => {
  const browserWindow = { open() {} };
  const popup = { closed: false };

  assert.throws(
    () =>
      runMetaLoginInReservedPopup({
        browserWindow,
        popupWindow: popup,
        openLogin() {},
      }),
    /did not create the Embedded Signup popup/,
  );
});
