import assert from "node:assert/strict";
import test from "node:test";

import { getAllowedActionOrigins } from "../action-origins.js";

test("action origins include configured Shopify tunnel and frontend hosts", () => {
  assert.deepEqual(
    getAllowedActionOrigins({
      SHOPIFY_APP_URL: "https://shopify-app.example.com/path",
      FRONTEND_URL: "https://frontend.example.com",
    }),
    ["shopify-app.example.com", "frontend.example.com"],
  );
});

test("action origins support explicit hosts and safe wildcard patterns", () => {
  assert.deepEqual(
    getAllowedActionOrigins({
      REACT_ROUTER_ALLOWED_ACTION_ORIGINS:
        "preview.example.com, *.trycloudflare.com, https://app.example.com:8443",
    }),
    [
      "preview.example.com",
      "*.trycloudflare.com",
      "app.example.com:8443",
    ],
  );
});

test("action origins reject malformed URLs instead of weakening CSRF checks", () => {
  assert.deepEqual(
    getAllowedActionOrigins({
      APP_URL: "https:",
      HOST: "not a URL",
      REACT_ROUTER_ALLOWED_ACTION_ORIGINS: "https://, bad/path, ",
    }),
    [],
  );
});
