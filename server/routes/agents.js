import express from "express";
import mongoose from "mongoose";
import { Readable } from "node:stream";
import WaMessageLog from "../models/WaMessageLog.js";
import {
  authenticateAgentCredentials,
  clearAgentSessionCookie,
  createAgentSession,
  isValidAgentCsrf,
  resolveAgentSession,
  revokeAgentSession,
  serializeAgentSession,
  setAgentSessionCookie,
} from "../services/agentAuth.js";
import {
  listAgentMessages,
  listAgentThreads,
  sendAgentMedia,
  sendAgentTemplate,
  sendAgentText,
} from "../services/agentMessenger.js";
import { fetchWhatsAppMediaForLog } from "../services/whatsapp.js";
import { requireAgentFeatureAccess } from "../services/agentAccess.js";
import {
  addTeamInboxNote,
  createTeamInboxLabel,
  createTeamInboxQuickReply,
  getTeamInboxConfig,
  getTeamInboxContext,
  getTeamInboxDraft,
  markTeamInboxRead,
  performTeamInboxOrderAction,
  requireTeamInboxThread,
  saveTeamInboxDraft,
  teamInboxThreadReference,
  updateTeamInboxThread,
} from "../services/teamInbox.js";
import {
  clearTeamInboxPresence,
  getTeamInboxPresence,
  subscribeTeamInbox,
  updateTeamInboxPresence,
} from "../services/teamInboxRealtime.js";
import { isValidAgentMediaSignature } from "../services/agentMediaTokens.js";

const router = express.Router();
const rawMediaBody = express.raw({ type: () => true, limit: "21mb" });
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);
const AUDIO_MIME_TYPES = new Set([
  "audio/aac",
  "audio/mp4",
  "audio/mpeg",
  "audio/amr",
  "audio/ogg",
]);
const VIDEO_MIME_TYPES = new Set(["video/mp4"]);
const DOCUMENT_MIME_TYPES = new Set(["application/pdf", "text/plain"]);

function safeOrigin(value) {
  try {
    return new URL(String(value || "").trim()).origin;
  } catch {
    return "";
  }
}

function trustedMessengerOrigins() {
  const origins = new Set(["https://orderx.com", "https://www.orderx.com"]);
  const configured = [
    process.env.MARKETING_SITE_URL,
    process.env.MESSENGER_APP_URL,
    process.env.PUBLIC_SITE_URL,
    ...String(process.env.CORS_ALLOWED_ORIGINS || "").split(","),
  ];
  for (const value of configured) {
    const origin = safeOrigin(value);
    if (origin) origins.add(origin);
  }
  return origins;
}

const AGENT_ALLOWED_ORIGINS = trustedMessengerOrigins();

function asText(value) {
  return String(value || "").trim();
}

function positiveInt(value, fallback, max) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function sendError(res, error) {
  const status = Number(error?.status || error?.httpStatus || 500);
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  return res.status(safeStatus).json({
    ok: false,
    error: error?.message || "Messenger request failed.",
    code: error?.code || "messenger_request_failed",
    ...(error?.replyState ? { replyState: error.replyState } : {}),
    ...(error?.feature ? { feature: error.feature } : {}),
  });
}

function bufferStartsWith(buffer, bytes) {
  if (!Buffer.isBuffer(buffer) || buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

export function mediaSignatureMatches(buffer, contentType) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return false;
  if (contentType === "image/jpeg") {
    return bufferStartsWith(buffer, [0xff, 0xd8, 0xff]);
  }
  if (contentType === "image/png") {
    return bufferStartsWith(
      buffer,
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
  }
  if (contentType === "audio/ogg") {
    return (
      buffer.subarray(0, 4).toString("ascii") === "OggS" &&
      buffer.subarray(0, 256).includes(Buffer.from("OpusHead"))
    );
  }
  if (contentType === "audio/amr") {
    return buffer.subarray(0, 6).toString("ascii") === "#!AMR\n";
  }
  if (contentType === "audio/mp4") {
    return (
      buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp"
    );
  }
  if (contentType === "audio/mpeg") {
    return (
      buffer.subarray(0, 3).toString("ascii") === "ID3" ||
      (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
    );
  }
  if (contentType === "audio/aac") {
    return (
      buffer.subarray(0, 4).toString("ascii") === "ADIF" ||
      (buffer[0] === 0xff && (buffer[1] & 0xf0) === 0xf0)
    );
  }
  if (contentType === "video/mp4") {
    return buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp";
  }
  if (contentType === "application/pdf") {
    return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  }
  if (contentType === "text/plain") {
    return !buffer.includes(Buffer.from([0]));
  }
  return false;
}

router.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");

  const origin = safeOrigin(req.headers.origin);
  if (!origin || AGENT_ALLOWED_ORIGINS.has(origin)) return next();
  return res.status(403).json({
    ok: false,
    error: "Messenger is not available from this website.",
    code: "origin_not_allowed",
  });
});

async function requireAgent(req, res, next) {
  try {
    const resolved = await resolveAgentSession(req);
    if (!resolved) {
      clearAgentSessionCookie(res);
      return res.status(401).json({
        ok: false,
        error: "Your agent session has expired. Please sign in again.",
        code: "session_expired",
      });
    }
    try {
      await requireAgentFeatureAccess(resolved.shop);
    } catch (error) {
      await revokeAgentSession(resolved).catch(() => null);
      clearAgentSessionCookie(res);
      return sendError(res, error);
    }
    req.agentSession = resolved;
    return next();
  } catch (error) {
    return sendError(res, error);
  }
}

function requireCsrf(req, res, next) {
  if (!isValidAgentCsrf(req, req.agentSession)) {
    return res.status(403).json({
      ok: false,
      error: "The secure session check failed. Refresh and try again.",
      code: "csrf_failed",
    });
  }
  return next();
}

router.post("/auth/login", async (req, res) => {
  try {
    const account = await authenticateAgentCredentials({
      username: req.body?.username,
      password: req.body?.password,
    });
    if (!account) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return res.status(401).json({
        ok: false,
        error: "Invalid username or password.",
        code: "invalid_credentials",
      });
    }
    await requireAgentFeatureAccess(account.shop);
    const created = await createAgentSession(account);
    setAgentSessionCookie(res, created.token);
    return res.json({
      ok: true,
      ...serializeAgentSession(
        {
          account: created.account,
          shop: account.shop,
          session: created.session.toObject(),
        },
        created.csrfToken,
      ),
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/auth/session", async (req, res) => {
  try {
    const resolved = await resolveAgentSession(req, { rotateCsrf: true });
    if (!resolved) {
      clearAgentSessionCookie(res);
      return res.status(401).json({
        ok: false,
        error: "Your agent session has expired. Please sign in again.",
        code: "session_expired",
      });
    }
    try {
      await requireAgentFeatureAccess(resolved.shop);
    } catch (error) {
      await revokeAgentSession(resolved).catch(() => null);
      clearAgentSessionCookie(res);
      return sendError(res, error);
    }
    return res.json({ ok: true, ...serializeAgentSession(resolved) });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/auth/logout", async (req, res) => {
  try {
    const resolved = await resolveAgentSession(req);
    if (resolved && !isValidAgentCsrf(req, resolved)) {
      return res.status(403).json({
        ok: false,
        error: "The secure session check failed.",
        code: "csrf_failed",
      });
    }
    if (resolved) await revokeAgentSession(resolved);
    clearAgentSessionCookie(res);
    return res.json({ ok: true });
  } catch (error) {
    clearAgentSessionCookie(res);
    return sendError(res, error);
  }
});

router.get("/threads", requireAgent, async (req, res) => {
  try {
    const result = await listAgentThreads({
      shop: req.agentSession.shop,
      q: asText(req.query.q),
      page: positiveInt(req.query.page, 1, 100000),
      pageSize: positiveInt(req.query.pageSize, 50, 100),
      view: asText(req.query.view) || "all",
      account: req.agentSession.account,
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/messages", requireAgent, async (req, res) => {
  try {
    const result = await listAgentMessages({
      shop: req.agentSession.shop,
      threadKey: req.query.thread,
      before: req.query.before,
      pageSize: positiveInt(req.query.pageSize, 60, 100),
      account: req.agentSession.account,
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/messages/text", requireAgent, requireCsrf, async (req, res) => {
  try {
    const result = await sendAgentText({
      shop: req.agentSession.shop,
      threadKey: req.body?.thread,
      text: req.body?.text,
      actor: req.agentSession.account,
      clientMessageId: req.body?.clientMessageId,
      replyToWaMessageId: req.body?.replyToWaMessageId,
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post(
  "/messages/media",
  requireAgent,
  requireCsrf,
  rawMediaBody,
  async (req, res) => {
    try {
      const mediaType = asText(req.query.mediaType).toLowerCase();
      const contentType = asText(req.headers["content-type"])
        .split(";")[0]
        .trim()
        .toLowerCase();
      const allowedMimeTypes =
        mediaType === "image"
          ? IMAGE_MIME_TYPES
          : mediaType === "audio"
            ? AUDIO_MIME_TYPES
            : mediaType === "video"
              ? VIDEO_MIME_TYPES
              : mediaType === "document"
                ? DOCUMENT_MIME_TYPES
                : null;
      if (!allowedMimeTypes?.has(contentType)) {
        return res.status(415).json({
          ok: false,
          error:
            mediaType === "image"
              ? "Use a JPG or PNG image."
              : mediaType === "audio"
                ? "Use AAC, MP4 audio, MP3, AMR, or OGG audio."
                : mediaType === "video"
                  ? "Use an MP4 video."
                  : "Use a PDF or plain-text document.",
          code: "unsupported_media_type",
        });
      }
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const maxBytes =
        mediaType === "image"
          ? 5 * 1024 * 1024
          : mediaType === "video"
            ? 16 * 1024 * 1024
            : mediaType === "document"
              ? 20 * 1024 * 1024
              : 16 * 1024 * 1024;
      if (!buffer.length || buffer.length > maxBytes) {
        return res.status(413).json({
          ok: false,
          error:
            mediaType === "image"
              ? "Image must be no larger than 5 MB."
              : mediaType === "document"
                ? "Document must be no larger than 20 MB."
                : "Audio or video must be no larger than 16 MB.",
          code: "media_too_large",
        });
      }
      if (!mediaSignatureMatches(buffer, contentType)) {
        return res.status(415).json({
          ok: false,
          error:
            "The uploaded file contents do not match a supported WhatsApp media format.",
          code: "invalid_media_content",
        });
      }
      const result = await sendAgentMedia({
        shop: req.agentSession.shop,
        threadKey: req.query.thread,
        buffer,
        fileName: asText(req.query.fileName).slice(0, 120) || "media",
        contentType,
        mediaType,
        caption: asText(req.query.caption).slice(0, 1024),
        voice: asText(req.query.voice).toLowerCase() === "true",
        actor: req.agentSession.account,
        clientMessageId: asText(req.query.clientMessageId),
        replyToWaMessageId: asText(req.query.replyToWaMessageId),
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return sendError(res, error);
    }
  },
);

router.get("/media/:messageId", requireAgent, async (req, res) => {
  try {
    if (
      !isValidAgentMediaSignature(
        req.params.messageId,
        req.query.e,
        req.query.s,
      )
    ) {
      return res.status(403).json({ error: "This media link has expired." });
    }
    if (!mongoose.isValidObjectId(req.params.messageId)) {
      return res.status(404).json({ error: "Media not found" });
    }
    const messageLog = await WaMessageLog.findOne({
      _id: req.params.messageId,
      shop: req.agentSession.shop,
    }).lean();
    if (!messageLog?.meta?.media?.id) {
      return res.status(404).json({ error: "Media not found" });
    }
    const media = await fetchWhatsAppMediaForLog({
      shop: req.agentSession.shop,
      messageLog,
    });
    res.setHeader("Content-Type", media.contentType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${media.fileName}"`,
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Cross-Origin-Resource-Policy", "same-site");
    if (media.contentLength) {
      res.setHeader("Content-Length", String(media.contentLength));
    }
    const mediaBody =
      typeof media.body?.pipe === "function"
        ? media.body
        : Readable.fromWeb(media.body);
    mediaBody.on("error", (error) => {
      console.error("[agent_media_stream]", error?.message || error);
      if (!res.headersSent) res.status(502).end();
      else res.destroy(error);
    });
    return mediaBody.pipe(res);
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/team/config", requireAgent, async (req, res) => {
  try {
    const result = await getTeamInboxConfig({
      shop: req.agentSession.shop,
      account: req.agentSession.account,
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/thread/context", requireAgent, async (req, res) => {
  try {
    const result = await getTeamInboxContext({
      shop: req.agentSession.shop,
      threadKey: req.query.thread,
      account: req.agentSession.account,
      force: asText(req.query.force) === "true",
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return sendError(res, error);
  }
});

router.patch("/thread", requireAgent, requireCsrf, async (req, res) => {
  try {
    const result = await updateTeamInboxThread({
      shop: req.agentSession.shop,
      threadKey: req.body?.thread,
      patch: req.body || {},
      account: req.agentSession.account,
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/thread/read", requireAgent, requireCsrf, async (req, res) => {
  try {
    const result = await markTeamInboxRead({
      shop: req.agentSession.shop,
      threadKey: req.body?.thread,
      account: req.agentSession.account,
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/draft", requireAgent, async (req, res) => {
  try {
    return res.json({
      ok: true,
      ...(await getTeamInboxDraft({
        shop: req.agentSession.shop,
        threadKey: req.query.thread,
        account: req.agentSession.account,
      })),
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.put("/draft", requireAgent, requireCsrf, async (req, res) => {
  try {
    return res.json({
      ok: true,
      ...(await saveTeamInboxDraft({
        shop: req.agentSession.shop,
        threadKey: req.body?.thread,
        draft: req.body?.draft,
        account: req.agentSession.account,
      })),
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/notes", requireAgent, requireCsrf, async (req, res) => {
  try {
    const note = await addTeamInboxNote({
      shop: req.agentSession.shop,
      threadKey: req.body?.thread,
      note: req.body?.note,
      account: req.agentSession.account,
    });
    return res.status(201).json({ ok: true, note });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/labels", requireAgent, requireCsrf, async (req, res) => {
  try {
    const label = await createTeamInboxLabel({
      shop: req.agentSession.shop,
      name: req.body?.name,
      color: req.body?.color,
      account: req.agentSession.account,
    });
    return res.status(201).json({ ok: true, label });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/quick-replies", requireAgent, requireCsrf, async (req, res) => {
  try {
    const quickReply = await createTeamInboxQuickReply({
      shop: req.agentSession.shop,
      title: req.body?.title,
      shortcut: req.body?.shortcut,
      body: req.body?.body,
      account: req.agentSession.account,
    });
    return res.status(201).json({ ok: true, quickReply });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/messages/template", requireAgent, requireCsrf, async (req, res) => {
  try {
    const result = await sendAgentTemplate({
      shop: req.agentSession.shop,
      threadKey: req.body?.thread,
      templateId: req.body?.templateId,
      clientMessageId: req.body?.clientMessageId,
      variables: req.body?.variables,
      actor: req.agentSession.account,
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/order/action", requireAgent, requireCsrf, async (req, res) => {
  try {
    const result = await performTeamInboxOrderAction({
      shop: req.agentSession.shop,
      threadKey: req.body?.thread,
      action: req.body?.action,
      value: req.body?.value,
      account: req.agentSession.account,
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/presence", requireAgent, requireCsrf, async (req, res) => {
  try {
    const thread = await requireTeamInboxThread(
      req.agentSession.shop,
      req.body?.thread,
    );
    const presence = updateTeamInboxPresence({
      shop: req.agentSession.shop,
      threadKey: thread.threadKey,
      agentId: req.agentSession.account.id,
      username: req.agentSession.account.username,
      typing: req.body?.typing === true,
    });
    return res.json({ ok: true, presence });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/presence", requireAgent, async (req, res) => {
  try {
    const thread = await requireTeamInboxThread(
      req.agentSession.shop,
      req.query.thread,
    );
    return res.json({
      ok: true,
      presence: getTeamInboxPresence({
        shop: req.agentSession.shop,
        threadKey: thread.threadKey,
      }),
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/events", requireAgent, (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  let writeQueue = Promise.resolve();
  const send = (event) => {
    writeQueue = writeQueue
      .then(async () => {
        let publicEvent = event;
        if (event?.threadKey) {
          const thread = await requireTeamInboxThread(
            req.agentSession.shop,
            event.threadKey,
          ).catch(() => null);
          publicEvent = {
            ...event,
            threadKey: thread ? teamInboxThreadReference(thread) : null,
          };
        }
        if (!res.writableEnded && !res.destroyed) {
          res.write(`data: ${JSON.stringify(publicEvent)}\n\n`);
        }
      })
      .catch(() => null);
  };
  send({ type: "connected", at: new Date().toISOString() });
  const unsubscribe = subscribeTeamInbox(req.agentSession.shop, send);
  const keepAlive = setInterval(() => res.write(": keepalive\n\n"), 25_000);
  const maxLifetime = setTimeout(() => res.end(), 5 * 60_000);
  req.on("close", () => {
    clearInterval(keepAlive);
    clearTimeout(maxLifetime);
    unsubscribe();
    clearTeamInboxPresence({
      shop: req.agentSession.shop,
      threadKey: req.query.thread,
      agentId: req.agentSession.account.id,
    });
  });
});

export default router;
