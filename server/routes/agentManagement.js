import express from "express";
import {
  AGENT_LIMIT,
  createAgentAccount,
  deleteAgentAccount,
  listAgentAccounts,
  updateAgentAccess,
  updateAgentPassword,
} from "../services/agentAuth.js";
import { logAudit } from "../services/audit.js";
import { getAgentFeatureAccess } from "../services/agentAccess.js";

const router = express.Router();

function shopFromRequest(req) {
  return String(req.query.shop || "").trim();
}

function sendError(res, error) {
  const status = Number(error?.status || error?.statusCode || 500);
  return res.status(status >= 400 && status < 600 ? status : 500).json({
    ok: false,
    error: error?.message || "Agent account request failed.",
    code: error?.code || "agent_request_failed",
  });
}

router.get("/", async (req, res) => {
  try {
    const shop = shopFromRequest(req);
    if (!shop) return res.status(400).json({ error: "Missing shop" });
    const [agents, feature] = await Promise.all([
      listAgentAccounts(shop),
      getAgentFeatureAccess(shop),
    ]);
    return res.json({ ok: true, agents, limit: AGENT_LIMIT, feature });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/", async (req, res) => {
  try {
    const shop = shopFromRequest(req);
    if (!shop) return res.status(400).json({ error: "Missing shop" });
    const agent = await createAgentAccount({
      shop,
      username: req.body?.username,
      password: req.body?.password,
      accessLevel: req.body?.accessLevel,
      permissions: req.body?.permissions,
    });
    void logAudit({
      shop,
      actor: "merchant",
      action: "agent_account_created",
      message: `Agent account ${agent.username} was created.`,
      meta: { agentId: agent.id },
    });
    return res.status(201).json({ ok: true, agent });
  } catch (error) {
    return sendError(res, error);
  }
});

router.put("/:agentId/access", async (req, res) => {
  try {
    const shop = shopFromRequest(req);
    if (!shop) return res.status(400).json({ error: "Missing shop" });
    const agent = await updateAgentAccess({
      shop,
      agentId: req.params.agentId,
      accessLevel: req.body?.accessLevel,
      permissions: req.body?.permissions,
    });
    void logAudit({
      shop,
      actor: "merchant",
      action: "agent_access_updated",
      message: `Access updated for agent ${agent.username}.`,
      meta: {
        agentId: agent.id,
        accessLevel: agent.accessLevel,
        permissions: agent.permissions,
      },
    });
    return res.json({ ok: true, agent });
  } catch (error) {
    return sendError(res, error);
  }
});

router.put("/:agentId/password", async (req, res) => {
  try {
    const shop = shopFromRequest(req);
    if (!shop) return res.status(400).json({ error: "Missing shop" });
    const agent = await updateAgentPassword({
      shop,
      agentId: req.params.agentId,
      password: req.body?.password,
    });
    void logAudit({
      shop,
      actor: "merchant",
      action: "agent_password_updated",
      message: `Password updated for agent ${agent.username}.`,
      meta: { agentId: agent.id },
    });
    return res.json({ ok: true, agent });
  } catch (error) {
    return sendError(res, error);
  }
});

router.delete("/:agentId", async (req, res) => {
  try {
    const shop = shopFromRequest(req);
    if (!shop) return res.status(400).json({ error: "Missing shop" });
    const agent = await deleteAgentAccount({
      shop,
      agentId: req.params.agentId,
    });
    void logAudit({
      shop,
      actor: "merchant",
      action: "agent_account_deleted",
      level: "warn",
      message: `Agent account ${agent.username} was deleted.`,
      meta: { agentId: agent.id },
    });
    return res.json({ ok: true, agent });
  } catch (error) {
    return sendError(res, error);
  }
});

export default router;
