import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCampaignOrdersRequestKey,
  normalizeCampaignOrderQuery,
  resolveCampaignOrdersView,
} from "../app/utils/campaignOrderPicker.js";

test("campaign order request keys isolate modal sessions, searches, and pages", () => {
  const first = buildCampaignOrdersRequestKey({
    sessionKey: 1,
    query: "  #1001  ",
    after: "cursor-1",
  });

  assert.equal(
    first,
    buildCampaignOrdersRequestKey({
      sessionKey: 1,
      query: "#1001",
      after: "cursor-1",
    }),
  );
  assert.notEqual(
    first,
    buildCampaignOrdersRequestKey({
      sessionKey: 2,
      query: "#1001",
      after: "cursor-1",
    }),
  );
  assert.notEqual(
    first,
    buildCampaignOrdersRequestKey({
      sessionKey: 1,
      query: "customer@example.com",
      after: "cursor-1",
    }),
  );
});

test("campaign order picker never renders stale rows while a request is loading", () => {
  const view = resolveCampaignOrdersView({
    data: {
      requestKey: "old-request",
      orders: [{ orderGid: "gid://shopify/Order/1" }],
      pageInfo: { hasNextPage: true, endCursor: "old-cursor" },
    },
    expectedRequestKey: "new-request",
    fetcherState: "loading",
  });

  assert.equal(view.loading, true);
  assert.deepEqual(view.orders, []);
  assert.deepEqual(view.pageInfo, {});
  assert.equal(view.error, "");
});

test("pending debounced search hides the previous result set", () => {
  const requestKey = buildCampaignOrdersRequestKey({
    sessionKey: 4,
    query: "old search",
  });
  const view = resolveCampaignOrdersView({
    data: {
      requestKey,
      orders: [{ orderGid: "gid://shopify/Order/2" }],
    },
    expectedRequestKey: requestKey,
    fetcherState: "idle",
    searchPending: true,
  });

  assert.equal(view.loading, true);
  assert.deepEqual(view.orders, []);
});

test("matching completed responses expose only valid orders and pagination", () => {
  const requestKey = buildCampaignOrdersRequestKey({ sessionKey: 7 });
  const view = resolveCampaignOrdersView({
    data: {
      ok: true,
      requestKey,
      orders: [
        { orderGid: "gid://shopify/Order/3", orderName: "#1003" },
        { orderName: "missing id" },
        null,
      ],
      pageInfo: { hasNextPage: true, endCursor: "cursor-3" },
    },
    expectedRequestKey: requestKey,
    fetcherState: "idle",
  });

  assert.equal(view.loading, false);
  assert.equal(view.orders.length, 1);
  assert.equal(view.orders[0].orderName, "#1003");
  assert.equal(view.pageInfo.endCursor, "cursor-3");
});

test("matching failed responses show an error instead of an empty result", () => {
  const requestKey = buildCampaignOrdersRequestKey({ sessionKey: 8 });
  const view = resolveCampaignOrdersView({
    data: {
      ok: false,
      requestKey,
      error: "Shopify orders are temporarily unavailable",
      orders: [],
    },
    expectedRequestKey: requestKey,
    fetcherState: "idle",
  });

  assert.equal(view.loading, false);
  assert.equal(view.error, "Shopify orders are temporarily unavailable");
  assert.deepEqual(view.orders, []);
});

test("campaign order searches are trimmed before requests are compared", () => {
  assert.equal(normalizeCampaignOrderQuery("  +923001234567  "), "+923001234567");
});
