import express from "express";
import { requireAdminAuth } from "../middleware/adminAuth.js";
import CodAttempt from "../models/CodAttempt.js";
import Shop from "../models/Shop.js";
import { agenda } from "../jobs/agenda.js";
import { logAudit } from "../services/audit.js";
import {
  getAdminIdentity,
  issueAdminAccessToken,
  issueAdminChallengeToken,
  validateAdminSecondFactor,
  validateAdminCredentials,
  verifyAdminChallengeToken,
} from "../services/adminAuth.js";
import {
  getAdminBillingOverview,
  getAdminByonMonitoring,
  getAdminOrderXOperations,
  getAdminDashboardAdditions,
  getAdminRuntimeConfigWithHistory,
  listAdminAttempts,
  listAdminAuditLogs,
  listAdminBillingUsageCharges,
  listAdminBlockedContacts,
  listAdminConversationInitiations,
  listAdminCountryRates,
  listAdminMessages,
  listAdminOrderUpdateDispatches,
  listAdminPlanPurchases,
  listAdminStores,
  saveAdminCountryRate,
  saveAdminRuntimeConfig,
  serializeExport,
} from "../services/adminExplorers.js";
import {
  getAdminDashboardData,
  getAdminStoreDetail,
} from "../services/adminAnalytics.js";

const router = express.Router();
const ADMIN_RETRY_LIMIT = Math.max(
  1,
  Math.min(500, Number(process.env.ADMIN_ATTEMPT_RETRY_LIMIT || 200)),
);

function trimString(value) {
  return String(value || "").trim();
}

function parsePositiveInt(value, fallback) {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric) || numeric < 1) return fallback;
  return numeric;
}

function adminActor(req) {
  return String(req.admin?.loginId || req.admin?.displayName || "admin");
}

function normalizeObjectId(value) {
  const raw = trimString(value);
  return /^[a-f\d]{24}$/i.test(raw) ? raw : "";
}

function isTerminalResolvedAttempt(attempt) {
  const status = trimString(attempt?.status).toLowerCase();
  return ["confirmed", "cancelled", "wa_sent"].includes(status);
}

function buildAttemptRetryUpdate(now) {
  return {
    status: "scheduled",
    scheduledAt: now,
    manualRescheduledAt: now,
    lastTriedAt: null,
    lastError: null,
    lastErrorAt: null,
    lastErrorMeta: null,
    retryCount: 0,
    waMessageId: null,
    waTemplateUsed: null,
    waSentAt: null,
    waDeliveryStatus: null,
    waDeliveryStatusAt: null,
    waDeliveryError: null,
    tokenUsedAt: null,
    processedAt: null,
    expiredAt: null,
    expireSource: null,
    phoneQueueGroupId: null,
    phoneQueueRole: "none",
    phoneQueuedAt: null,
    phoneReleasedAt: null,
  };
}

async function queueAttemptNow(attemptId) {
  return agenda.now("attempt_cod_confirmation", { attemptId: String(attemptId) });
}

async function retryAttemptById(attemptId, actor, meta = {}) {
  const id = normalizeObjectId(attemptId);
  if (!id) {
    const error = new Error("Missing or invalid attemptId");
    error.statusCode = 400;
    throw error;
  }

  const existing = await CodAttempt.findById(id).lean();
  if (!existing?._id) {
    const error = new Error("Attempt not found");
    error.statusCode = 404;
    throw error;
  }

  if (isTerminalResolvedAttempt(existing)) {
    const error = new Error(
      `Attempt is already ${trimString(existing.status) || "resolved"} and cannot be retried`,
    );
    error.statusCode = 409;
    throw error;
  }

  const now = new Date();
  const updated = await CodAttempt.findOneAndUpdate(
    {
      _id: id,
      status: { $nin: ["confirmed", "cancelled", "wa_sent"] },
    },
    {
      $set: buildAttemptRetryUpdate(now),
      $push: {
        errorEvents: {
          $each: [
            {
              at: now,
              step: "admin_retry",
              message: "Queued manually from admin panel",
              meta: {
                actor,
                previousStatus: existing.status || null,
                previousError: existing.lastError || null,
                ...meta,
              },
            },
          ],
          $slice: -20,
        },
      },
    },
    { new: true },
  ).lean();

  if (!updated?._id) {
    const error = new Error("Attempt could not be retried");
    error.statusCode = 409;
    throw error;
  }

  await queueAttemptNow(updated._id);
  void logAudit({
    shop: updated.shop || null,
    actor,
    action: "admin_attempt_retry",
    meta: {
      attemptId: String(updated._id),
      orderGid: updated.orderGid || null,
      orderName: updated.orderName || null,
      previousStatus: existing.status || null,
      previousError: existing.lastError || null,
      ...meta,
    },
  });

  return updated;
}

function wantsExport(req) {
  const format = trimString(req.query?.format).toLowerCase();
  return format === "csv" || format === "json" || trimString(req.query?.export) === "1";
}

function sendExport(res, req, basename, items) {
  const format = trimString(req.query?.format || "json").toLowerCase() === "csv"
    ? "csv"
    : "json";
  const payload = serializeExport(items, format);
  const extension = format === "csv" ? "csv" : "json";
  res.setHeader("Content-Type", payload.contentType);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${basename}.${extension}"`,
  );
  return res.send(payload.body);
}

async function respondWithList(req, res, basename, loader) {
  const data = await loader(req.query || {});
  if (wantsExport(req)) {
    return sendExport(res, req, basename, data?.items || []);
  }
  return res.json({ ok: true, ...data });
}

router.post("/auth/login", async (req, res) => {
  try {
    const loginId = trimString(req.body?.loginId);
    const password = String(req.body?.password || "");

    if (!loginId || !password) {
      return res.status(400).json({ error: "Missing loginId or password" });
    }

    const valid = validateAdminCredentials(loginId, password);
    if (!valid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const challengeToken = issueAdminChallengeToken(loginId);
    return res.json({
      ok: true,
      challengeToken,
      challengeExpiresInSeconds: 300,
      requiresTwoFactor: true,
    });
  } catch (error) {
    return res.status(503).json({ error: error?.message || "Admin auth unavailable" });
  }
});

router.post("/auth/verify", async (req, res) => {
  try {
    const challengeToken = String(req.body?.challengeToken || "");
    const secondPassword = String(
      req.body?.secondPassword || req.body?.code || "",
    );
    if (!challengeToken || !secondPassword) {
      return res
        .status(400)
        .json({ error: "Missing challengeToken or secondPassword" });
    }

    const challenge = verifyAdminChallengeToken(challengeToken);
    if (!validateAdminSecondFactor(secondPassword)) {
      return res.status(401).json({ error: "Invalid second password" });
    }

    const access = issueAdminAccessToken(challenge.sub);
    const identity = getAdminIdentity();
    return res.json({
      ok: true,
      token: access.token,
      expiresAt: access.expiresAt,
      expiresInSeconds: access.expiresInSeconds,
      admin: {
        loginId: String(challenge.sub || identity.loginId || ""),
        displayName: identity.displayName,
      },
    });
  } catch (error) {
    return res.status(401).json({ error: error?.message || "Verification failed" });
  }
});

router.post("/auth/logout", (_req, res) => {
  return res.json({ ok: true });
});

router.get("/auth/session", requireAdminAuth, async (req, res) => {
  return res.json({
    ok: true,
    admin: req.admin,
  });
});

router.get("/dashboard", requireAdminAuth, async (req, res) => {
  try {
    const months = parsePositiveInt(req.query?.months, 6);
    const storeLimit = parsePositiveInt(req.query?.storeLimit, 24);
    const [data, additions, billingOverview, orderxOperations, byonMonitoring] =
      await Promise.all([
        getAdminDashboardData({ months, storeLimit }),
        getAdminDashboardAdditions(),
        getAdminBillingOverview(),
        getAdminOrderXOperations(),
        getAdminByonMonitoring(),
      ]);
    return res.json({
      ok: true,
      ...data,
      dashboardAdditions: additions,
      billingOverview,
      orderxOperations,
      byonSummary: byonMonitoring?.summary || null,
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to load dashboard" });
  }
});

router.get("/stores", requireAdminAuth, async (req, res) => {
  try {
    return await respondWithList(req, res, "admin-stores", listAdminStores);
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to load stores" });
  }
});

router.get("/store", requireAdminAuth, async (req, res) => {
  try {
    const shop = trimString(req.query?.shop);
    if (!shop) {
      return res.status(400).json({ error: "Missing shop" });
    }

    const detail = await getAdminStoreDetail(shop, {
      messageLimit: parsePositiveInt(req.query?.messageLimit, 120),
      attemptLimit: parsePositiveInt(req.query?.attemptLimit, 100),
      auditLimit: parsePositiveInt(req.query?.auditLimit, 100),
      dayMetricLimit: parsePositiveInt(req.query?.dayMetricLimit, 90),
    });

    return res.json({
      ok: true,
      ...detail,
    });
  } catch (error) {
    const status =
      String(error?.message || "").toLowerCase() === "store not found"
        ? 404
        : 500;
    return res
      .status(status)
      .json({ error: error?.message || "Failed to load store detail" });
  }
});

router.get("/messages", requireAdminAuth, async (req, res) => {
  try {
    return await respondWithList(req, res, "admin-messages", listAdminMessages);
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to load messages" });
  }
});

router.get("/attempts", requireAdminAuth, async (req, res) => {
  try {
    return await respondWithList(req, res, "admin-attempts", listAdminAttempts);
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to load attempts" });
  }
});

router.post("/attempts/retry", requireAdminAuth, async (req, res) => {
  try {
    const attemptId = trimString(
      req.body?.attemptId || req.body?.id || req.body?._id,
    );
    const actor = adminActor(req);
    const attempt = await retryAttemptById(attemptId, actor, {
      source: "admin_attempts_retry",
    });

    return res.json({
      ok: true,
      attemptId: String(attempt._id),
      shop: attempt.shop || null,
      status: attempt.status,
      scheduledAt: attempt.scheduledAt || null,
      queuedAt: new Date().toISOString(),
    });
  } catch (error) {
    return res
      .status(error?.statusCode || 500)
      .json({ error: error?.message || "Failed to retry attempt" });
  }
});

router.post("/stores/:shop/byon-resume", requireAdminAuth, async (req, res) => {
  try {
    const shop = trimString(req.params?.shop || req.body?.shop);
    if (!shop) {
      return res.status(400).json({ error: "Missing shop" });
    }

    const now = new Date();
    const actor = adminActor(req);
    const shopRecord = await Shop.findOneAndUpdate(
      { shop },
      {
        $set: {
          "whatsappSender.preferenceMode": "own_number",
          "whatsappSender.ownNumber.pauseSending": false,
          "whatsappSender.ownNumber.pauseReason": null,
          "whatsappSender.ownNumber.pauseSetAt": null,
          "whatsappSender.ownNumber.sendErrorStreak": 0,
          "whatsappSender.ownNumber.sendFailureEvents": [],
          "whatsappSender.ownNumber.lastSendError": null,
          "whatsappSender.ownNumber.lastSendErrorAt": null,
        },
      },
      {
        new: true,
        projection: { shop: 1, "whatsappSender.ownNumber.phoneNumberId": 1 },
      },
    ).lean();

    if (!shopRecord?._id) {
      return res.status(404).json({ error: "Store not found" });
    }

    const rows = await CodAttempt.find({
      shop,
      waSentAt: { $in: [null] },
      status: { $in: ["scheduled", "failed", "skipped", "expired", "pending"] },
      confirmedAt: { $in: [null] },
      cancelledAt: { $in: [null] },
    })
      .select({
        _id: 1,
        shop: 1,
        orderGid: 1,
        orderName: 1,
        status: 1,
        lastError: 1,
      })
      .sort({ scheduledAt: 1, lastErrorAt: -1, createdAt: 1 })
      .limit(ADMIN_RETRY_LIMIT)
      .lean();

    const ids = rows.map((row) => String(row?._id || "")).filter(Boolean);
    if (ids.length) {
      await CodAttempt.updateMany(
        { _id: { $in: ids } },
        {
          $set: buildAttemptRetryUpdate(now),
          $push: {
            errorEvents: {
              $each: [
                {
                  at: now,
                  step: "admin_resume_byon",
                  message: "BYON sending resumed from admin panel",
                  meta: { actor },
                },
              ],
              $slice: -20,
            },
          },
        },
      );

      for (const attemptId of ids) {
        await queueAttemptNow(attemptId).catch((error) => {
          console.warn(
            "[admin_byon_resume_queue_failed]",
            shop,
            attemptId,
            error?.message || error,
          );
        });
      }
    }

    void logAudit({
      shop,
      actor,
      action: "admin_byon_resume",
      meta: {
        resumedAt: now.toISOString(),
        attemptsQueued: ids.length,
        limit: ADMIN_RETRY_LIMIT,
      },
    });

    return res.json({
      ok: true,
      shop,
      resumedAt: now.toISOString(),
      attemptsQueued: ids.length,
      queuedAttemptIds: ids,
    });
  } catch (error) {
    return res
      .status(error?.statusCode || 500)
      .json({ error: error?.message || "Failed to resume BYON sending" });
  }
});

router.get("/billing/charges", requireAdminAuth, async (req, res) => {
  try {
    return await respondWithList(
      req,
      res,
      "admin-billing-charges",
      listAdminBillingUsageCharges,
    );
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to load billing charges" });
  }
});

router.get("/billing/purchases", requireAdminAuth, async (req, res) => {
  try {
    return await respondWithList(
      req,
      res,
      "admin-plan-purchases",
      listAdminPlanPurchases,
    );
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to load plan purchases" });
  }
});

router.get("/billing/overview", requireAdminAuth, async (_req, res) => {
  try {
    const overview = await getAdminBillingOverview();
    return res.json({ ok: true, ...overview });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to load billing overview" });
  }
});

router.get("/orderx-ops", requireAdminAuth, async (_req, res) => {
  try {
    const payload = await getAdminOrderXOperations();
    return res.json({ ok: true, ...payload });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to load OrderX operations" });
  }
});

router.get("/byon", requireAdminAuth, async (_req, res) => {
  try {
    const payload = await getAdminByonMonitoring();
    return res.json({ ok: true, ...payload });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to load BYON monitoring" });
  }
});

router.get("/order-updates", requireAdminAuth, async (req, res) => {
  try {
    return await respondWithList(
      req,
      res,
      "admin-order-updates",
      listAdminOrderUpdateDispatches,
    );
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to load order updates" });
  }
});

router.get("/audit-logs", requireAdminAuth, async (req, res) => {
  try {
    return await respondWithList(req, res, "admin-audit-logs", listAdminAuditLogs);
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to load audit logs" });
  }
});

router.get("/blocked-contacts", requireAdminAuth, async (req, res) => {
  try {
    return await respondWithList(
      req,
      res,
      "admin-blocked-contacts",
      listAdminBlockedContacts,
    );
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to load blocked contacts" });
  }
});

router.get("/conversation-initiations", requireAdminAuth, async (req, res) => {
  try {
    return await respondWithList(
      req,
      res,
      "admin-conversation-initiations",
      listAdminConversationInitiations,
    );
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to load conversation initiations" });
  }
});

router.get("/country-pricing", requireAdminAuth, async (req, res) => {
  try {
    const payload = await listAdminCountryRates(req.query || {});
    return res.json({ ok: true, ...payload });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to load country pricing" });
  }
});

router.put("/country-pricing", requireAdminAuth, async (req, res) => {
  try {
    const record = await saveAdminCountryRate(req.body || {}, adminActor(req));
    return res.json({ ok: true, record });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "Failed to save country pricing" });
  }
});

router.get("/config", requireAdminAuth, async (req, res) => {
  try {
    const payload = await getAdminRuntimeConfigWithHistory(
      parsePositiveInt(req.query?.historyLimit, 50),
    );
    return res.json({ ok: true, ...payload });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to load config" });
  }
});

router.put("/config", requireAdminAuth, async (req, res) => {
  try {
    const nextConfig = await saveAdminRuntimeConfig(req.body || {}, adminActor(req));
    return res.json({ ok: true, config: nextConfig });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "Failed to update config" });
  }
});

export default router;
