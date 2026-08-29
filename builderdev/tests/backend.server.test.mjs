import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";

let server;
let origin;
let backendGet;
const requestCounts = new Map();
let timeoutRouteShouldHang = true;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requestCounts.set(
      url.pathname,
      Number(requestCounts.get(url.pathname) || 0) + 1,
    );

    const send = () => {
      if (res.destroyed) return;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, shop: url.searchParams.get("shop") }));
    };

    if (url.pathname === "/coalesced") {
      setTimeout(send, 40);
      return;
    }
    if (url.pathname === "/timeout" && timeoutRouteShouldHang) {
      setTimeout(send, 150);
      return;
    }
    send();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
  process.env.BACKEND_BASE_URL = origin;
  ({ backendGet } = await import("../app/server/backend.server.js"));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("coalesces identical in-flight reads for the same shop", async () => {
  const [first, second] = await Promise.all([
    backendGet("/coalesced", "one.myshopify.com", { timeoutMs: 500 }),
    backendGet("/coalesced", "one.myshopify.com", { timeoutMs: 500 }),
  ]);

  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  assert.equal(requestCounts.get("/coalesced"), 1);
});

test("keeps requests from different shops isolated", async () => {
  const [first, second] = await Promise.all([
    backendGet("/isolated", "one.myshopify.com", { timeoutMs: 500 }),
    backendGet("/isolated", "two.myshopify.com", { timeoutMs: 500 }),
  ]);

  assert.equal(first.shop, "one.myshopify.com");
  assert.equal(second.shop, "two.myshopify.com");
  assert.equal(requestCounts.get("/isolated"), 2);
});

test("times out a stuck read and clears it so the next read can recover", async () => {
  await assert.rejects(
    backendGet("/timeout", "one.myshopify.com", { timeoutMs: 25 }),
    (error) => error?.code === "BACKEND_TIMEOUT" && error?.status === 504,
  );

  timeoutRouteShouldHang = false;
  const recovered = await backendGet("/timeout", "one.myshopify.com", {
    timeoutMs: 25,
  });

  assert.equal(recovered.ok, true);
  assert.equal(requestCounts.get("/timeout"), 2);
});
