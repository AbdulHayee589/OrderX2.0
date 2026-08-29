import "dotenv/config";
import path from "node:path";
import { pathToFileURL } from "node:url";
import compression from "compression";
import express from "express";
import { createRequestHandler } from "@react-router/express";

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const port = positiveNumber(process.env.PORT, 3000);
const host = String(process.env.BIND_HOST || "0.0.0.0").trim();
const keepAliveTimeout = positiveNumber(
  process.env.APP_KEEP_ALIVE_TIMEOUT_MS,
  95_000,
);
const headersTimeout = Math.max(
  keepAliveTimeout + 1_000,
  positiveNumber(process.env.APP_HEADERS_TIMEOUT_MS, 96_000),
);
const requestTimeout = positiveNumber(
  process.env.APP_REQUEST_TIMEOUT_MS,
  120_000,
);
const shutdownTimeout = positiveNumber(
  process.env.APP_SHUTDOWN_TIMEOUT_MS,
  15_000,
);

const buildPath = path.resolve("build/server/index.js");
const build = await import(pathToFileURL(buildPath).href);
const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use((req, res, next) => {
  const acceptsHtml = String(req.headers.accept || "").includes("text/html");
  if (req.method === "GET" && acceptsHtml) {
    res.vary("Accept");
    res.set(
      "Link",
      [
        "<https://cdn.shopify.com>; rel=preconnect; crossorigin",
        "<https://cdn.shopify.com/shopifycloud/app-bridge.js>; rel=preload; as=script",
      ].join(", "),
    );
  }
  next();
});

// Keep liveness independent of Shopify authentication and backend services.
app.get("/healthz", (_req, res) => {
  res
    .status(200)
    .set({
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Robots-Tag": "noindex, nofollow",
    })
    .send("ok");
});

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    if (res.statusCode >= 500 || durationMs >= 2_000) {
      console.warn("[app_request]", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs,
      });
    }
  });
  next();
});

app.use(compression());
app.use(
  path.posix.join(build.publicPath, "assets"),
  express.static(path.join(build.assetsBuildDirectory, "assets"), {
    immutable: true,
    maxAge: "1y",
  }),
);
app.use(build.publicPath, express.static(build.assetsBuildDirectory));
app.use(express.static("public", { maxAge: "1h" }));
app.all(
  "*",
  createRequestHandler({
    build,
    mode: process.env.NODE_ENV || "production",
  }),
);

const server = app.listen(port, host, () => {
  console.log(`[orderx-app] listening on ${host}:${port}`);
});

// Cloudflare and reverse proxies reuse origin sockets. Node's five-second
// default can close a socket just as the proxy sends its next request.
server.keepAliveTimeout = keepAliveTimeout;
server.headersTimeout = headersTimeout;
server.requestTimeout = requestTimeout;

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[orderx-app] ${signal} received; draining connections`);

  server.close((error) => {
    if (error) {
      console.error("[orderx-app] graceful shutdown failed", error.message);
      process.exit(1);
    }
    process.exit(0);
  });

  const forceClose = setTimeout(() => {
    console.warn("[orderx-app] forcing remaining connections closed");
    server.closeAllConnections?.();
    process.exit(1);
  }, shutdownTimeout);
  forceClose.unref?.();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
