import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";

import { internalAuth } from "./middleware/internalAuth.js";
import { createIpRateLimiter } from "./middleware/rateLimit.js";
import {
  buildCorsOptions,
  jsonBodyLimit,
  rejectSuspiciousPayload,
  securityHeaders,
  validateSecurityConfig,
} from "./middleware/security.js";
import debugRoutes from "./routes/debug.js";

import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import apiRoutes from "./routes/api.js";
import waRoutes from "./routes/whatsappWebhook.js";
import billingRoutes from "./routes/billing.js";
import internalRoutes from "./routes/internal.js";
import waLinksRoutes from "./routes/waLinks.js";
import agentRoutes from "./routes/agents.js";

import { startAgenda } from "./jobs/definitions.js";
import { ensureAgentIndexes } from "./services/agentAuth.js";
import "./jobs/definitions.js";

const app = express();
const isProd =
  String(process.env.NODE_ENV || "").toLowerCase() === "production";

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envBoolean(name, fallback = false) {
  const raw = String(process.env[name] ?? "")
    .trim()
    .toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

app.disable("x-powered-by");

// Helpful when deployed behind Render/NGINX/Cloudflare etc.
app.set("trust proxy", 1);

const { warnings } = validateSecurityConfig();
for (const warning of warnings) {
  console.warn(`[security] ${warning}`);
}

// Optional: enforce HTTPS for WhatsApp button links
if (process.env.FORCE_HTTPS === "true") {
  app.use((req, res, next) => {
    const isLocal =
      req.hostname === "localhost" || req.hostname === "127.0.0.1";
    const proto = (
      req.headers["x-forwarded-proto"] ||
      req.protocol ||
      ""
    ).toString();

    if (!isLocal && proto !== "https") {
      return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
    }
    next();
  });
}

app.use(securityHeaders);

const corsOptions = buildCorsOptions();
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

app.use(
  express.json({
    limit: jsonBodyLimit(),
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: jsonBodyLimit() }));
app.use(rejectSuspiciousPayload);

const globalLimiter = createIpRateLimiter({
  keyPrefix: "global",
  windowMs: envNumber("RATE_LIMIT_GLOBAL_WINDOW_MS", 60_000),
  max: envNumber("RATE_LIMIT_GLOBAL_MAX", 2_000),
  blockMs: envNumber("RATE_LIMIT_GLOBAL_BLOCK_MS", 60_000),
});
app.use((req, res, next) => {
  if (String(req.path || "").startsWith("/whatsapp/webhook")) return next();
  return globalLimiter(req, res, next);
});

const authLimiter = createIpRateLimiter({
  keyPrefix: "auth",
  windowMs: envNumber("RATE_LIMIT_AUTH_WINDOW_MS", 60_000),
  max: envNumber("RATE_LIMIT_AUTH_MAX", 180),
  blockMs: envNumber("RATE_LIMIT_AUTH_BLOCK_MS", 120_000),
});

const internalLimiter = createIpRateLimiter({
  keyPrefix: "internal",
  windowMs: envNumber("RATE_LIMIT_INTERNAL_WINDOW_MS", 60_000),
  max: envNumber("RATE_LIMIT_INTERNAL_MAX", 3_000),
  blockMs: envNumber("RATE_LIMIT_INTERNAL_BLOCK_MS", 60_000),
});

const publicWebhookLimiter = createIpRateLimiter({
  keyPrefix: "webhook",
  windowMs: envNumber("RATE_LIMIT_WEBHOOK_WINDOW_MS", 60_000),
  max: envNumber("RATE_LIMIT_WEBHOOK_MAX", 5_000),
  blockMs: envNumber("RATE_LIMIT_WEBHOOK_BLOCK_MS", 60_000),
});

const waLinksLimiter = createIpRateLimiter({
  keyPrefix: "wa_links",
  windowMs: envNumber("RATE_LIMIT_WA_LINKS_WINDOW_MS", 60_000),
  max: envNumber("RATE_LIMIT_WA_LINKS_MAX", 240),
  blockMs: envNumber("RATE_LIMIT_WA_LINKS_BLOCK_MS", 120_000),
});

const agentLoginLimiter = createIpRateLimiter({
  keyPrefix: "agent_login",
  windowMs: envNumber("RATE_LIMIT_AGENT_LOGIN_WINDOW_MS", 15 * 60_000),
  max: envNumber("RATE_LIMIT_AGENT_LOGIN_MAX", 20),
  blockMs: envNumber("RATE_LIMIT_AGENT_LOGIN_BLOCK_MS", 15 * 60_000),
});

const agentLimiter = createIpRateLimiter({
  keyPrefix: "agent",
  windowMs: envNumber("RATE_LIMIT_AGENT_WINDOW_MS", 60_000),
  max: envNumber("RATE_LIMIT_AGENT_MAX", 600),
  blockMs: envNumber("RATE_LIMIT_AGENT_BLOCK_MS", 60_000),
});

const agentSendLimiter = createIpRateLimiter({
  keyPrefix: "agent_send",
  windowMs: envNumber("RATE_LIMIT_AGENT_SEND_WINDOW_MS", 60_000),
  max: envNumber("RATE_LIMIT_AGENT_SEND_MAX", 60),
  blockMs: envNumber("RATE_LIMIT_AGENT_SEND_BLOCK_MS", 5 * 60_000),
});

if (!process.env.MONGO_URI) {
  throw new Error("Missing MONGO_URI");
}

mongoose.set("strictQuery", true);
await mongoose.connect(process.env.MONGO_URI, {
  autoIndex: envBoolean("MONGO_AUTO_INDEX", !isProd),
  maxPoolSize: envNumber("MONGO_MAX_POOL_SIZE", 50),
  minPoolSize: envNumber("MONGO_MIN_POOL_SIZE", 5),
  maxIdleTimeMS: envNumber("MONGO_MAX_IDLE_TIME_MS", 30_000),
  serverSelectionTimeoutMS: envNumber(
    "MONGO_SERVER_SELECTION_TIMEOUT_MS",
    10_000,
  ),
  socketTimeoutMS: envNumber("MONGO_SOCKET_TIMEOUT_MS", 45_000),
});
mongoose.connection.on("error", (err) => {
  console.error("[MONGO ERROR]", err);
});

mongoose.connection.on("disconnected", () => {
  console.warn("[MONGO DISCONNECTED]");
});
console.log("Mongo connected");
await ensureAgentIndexes().catch((error) => {
  // Keep the existing live app available if the optional agent subsystem
  // cannot initialize. Agent account requests will remain safely unavailable
  // until the indexes can be created.
  console.error("[agent_indexes_failed]", error?.message || error);
});

app.use("/auth", authLimiter, authRoutes);
app.use("/admin", authLimiter, adminRoutes);

// Server-to-server calls from embedded app server:
app.use("/internal", internalLimiter, internalAuth, internalRoutes);

// Back-compat (you can remove later; /api/billing also exists via routes/api.js)
app.use("/api/billing", internalLimiter, internalAuth, billingRoutes);

app.use("/api", internalLimiter, internalAuth, apiRoutes);

app.use("/wa", waLinksLimiter, waLinksRoutes);

app.use("/agent/auth/login", agentLoginLimiter);
app.use("/agent/messages/text", agentSendLimiter);
app.use("/agent/messages/media", agentSendLimiter);
app.use("/agent/messages/template", agentSendLimiter);
app.use("/agent/order/action", agentSendLimiter);
app.use("/agent", agentLimiter, agentRoutes);

// Debug routes can trigger WhatsApp sends - keep them internal-only.
app.use("/debug", internalLimiter, internalAuth, debugRoutes);

// NOTE: We do NOT subscribe to order webhooks (protected customer data).
// Order detection is polling-based (Agenda job: poll_cod_orders).

app.use("/whatsapp", publicWebhookLimiter, waRoutes);
app.get("/", (_req, res) => res.send("OrderX backend online"));

app.use((req, res) => {
  return res.status(404).json({ error: "Not found" });
});

app.use((err, _req, res, _next) => {
  console.error("[server_error]", err?.message || err);
  if (res.headersSent) return;
  const status = Number(err?.status || err?.statusCode || 500);
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  return res.status(safeStatus).json({ error: "Server error" });
});

await startAgenda();

app.listen(process.env.PORT || 8081, () => {
  console.log(`Server running on :${process.env.PORT || 8081}`);
});
