import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";

let server;
let loadDashboardAnalytics;
let loadDashboardCore;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const shop = url.searchParams.get("shop");
    const coreUnavailable = shop === "unavailable.myshopify.com";
    const usageUnavailable = shop === "usage-down.myshopify.com";
    if (
      (coreUnavailable &&
        ["/api/billing/status", "/api/usage"].includes(url.pathname)) ||
      (usageUnavailable && url.pathname === "/api/usage")
    ) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "temporary test outage" }));
      return;
    }
    const responses = {
      "/api/billing/status": {
        active: true,
        planKey: "own_number_starter_5",
        storeCountryCode: "PK",
      },
      "/api/usage": {
        billing: {
          active: true,
          planKey: "own_number_starter_5",
          storeCountryCode: "PK",
        },
        usage: { month: 3 },
      },
      "/api/sender": { sender: { status: "ready" } },
      "/api/sender/byon/meta-config": { config: { appId: "configured" } },
      "/api/metrics": [{ day: "2026-07-23", sent: 2 }],
      "/api/attempts": {
        items: [
          {
            _id: "attempt-1",
            status: "confirmed",
            timezone: "Asia/Karachi",
          },
        ],
        summary: { total: 20, confirmed: 14, cancelled: 3, pending: 3 },
      },
    };
    const body = responses[url.pathname];
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  process.env.BACKEND_BASE_URL = `http://127.0.0.1:${address.port}`;
  ({ loadDashboardAnalytics, loadDashboardCore } =
    await import("../app/server/dashboardData.server.js"));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("loads dashboard core reads in one bounded parallel group", async () => {
  const result = await loadDashboardCore("test.myshopify.com");

  assert.equal(result.coreLoaded, true);
  assert.equal(result.billing.active, true);
  assert.equal(result.sender.status, "ready");
  assert.equal(result.merchantTimezone, "Asia/Karachi");
  assert.deepEqual(result.warnings, []);
});

test("uses the exact attempts summary instead of counting only the first page", async () => {
  const result = await loadDashboardAnalytics("test.myshopify.com");

  assert.equal(result.attemptsLoaded, true);
  assert.equal(result.attemptTotal, 20);
  assert.equal(result.confirmed, 14);
  assert.equal(result.cancelled, 3);
  assert.equal(result.pending, 3);
  assert.equal(result.recentAttempts.length, 1);
  assert.equal(result.merchantTimezone, "Asia/Karachi");
});

test("does not turn an unavailable billing service into an inactive plan", async () => {
  const result = await loadDashboardCore("unavailable.myshopify.com");

  assert.equal(result.coreLoaded, false);
  assert.equal(result.ok, false);
  assert.equal(result.billing, null);
  assert.match(result.error, /could not load/i);
});

test("keeps valid billing visible when only usage totals are delayed", async () => {
  const result = await loadDashboardCore("usage-down.myshopify.com");

  assert.equal(result.coreLoaded, true);
  assert.equal(result.billing.active, true);
  assert.equal(result.usage, null);
  assert.ok(result.warnings.some((warning) => /usage totals/i.test(warning)));
});
