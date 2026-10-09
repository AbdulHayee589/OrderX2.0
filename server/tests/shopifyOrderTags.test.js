import assert from "node:assert/strict";
import test from "node:test";
import {
  appendOrderTags,
  removeOrderTags,
} from "../services/shopifyAdmin.js";

function mockAdmin(responseFactory) {
  const calls = [];
  return {
    calls,
    async query(input) {
      calls.push(input);
      return responseFactory(input);
    },
  };
}

test("order tag writes use idempotent Shopify tag mutations", async () => {
  const admin = mockAdmin(({ data }) => ({
    body: {
      data: data.includes("tagsRemove")
        ? { tagsRemove: { userErrors: [] } }
        : { tagsAdd: { userErrors: [] } },
    },
  }));

  await appendOrderTags(admin, "gid://shopify/Order/123", [
    "ORDER_CONFIRMED✅",
    "ORDER_CONFIRMED✅",
    "cod_redeliver",
  ]);
  await removeOrderTags(admin, "gid://shopify/Order/123", [
    "CONFIRMATION_SENT📩",
  ]);

  assert.equal(admin.calls.length, 2);
  assert.match(admin.calls[0].data, /tagsAdd\(id: \$id, tags: \$tags\)/);
  assert.deepEqual(admin.calls[0].variables, {
    id: "gid://shopify/Order/123",
    tags: ["ORDER_CONFIRMED✅", "cod_redeliver"],
  });
  assert.match(admin.calls[1].data, /tagsRemove\(id: \$id, tags: \$tags\)/);
  assert.deepEqual(admin.calls[1].variables, {
    id: "gid://shopify/Order/123",
    tags: ["CONFIRMATION_SENT📩"],
  });
});

test("order tag mutations surface Shopify user errors", async () => {
  const admin = mockAdmin(() => ({
    body: {
      data: {
        tagsAdd: { userErrors: [{ message: "Order cannot be tagged" }] },
      },
    },
  }));

  await assert.rejects(
    appendOrderTags(admin, "gid://shopify/Order/123", ["tag"]),
    /Order cannot be tagged/,
  );
});
