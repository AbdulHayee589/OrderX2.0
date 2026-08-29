// server/routes/whatsappWebhook.js
import express from "express";
import crypto from "crypto";
import { confirmAttempt, cancelAttempt } from "../services/attemptActions.js";
import CodAttempt from "../models/CodAttempt.js";
import WaMessageLog from "../models/WaMessageLog.js";
import BlockedContact from "../models/BlockedContact.js";
import Shop from "../models/Shop.js";
import { agenda } from "../jobs/agenda.js";
import {
  getAdminClient,
  appendOrderTag,
  appendOrderTags,
  removeOrderTags,
  fetchOrderTags,
  fetchOrderForCodConfirmTemplate,
} from "../services/shopifyAdmin.js";
import { releaseQueuesAfterAttemptResolved } from "../services/attemptQueueRelease.js";
import {
  sendCodConfirmedTemplate,
  sendCodConfirmTemplate,
  sendOrderCancelTemplate,
  sendWhatsAppButtons,
  sendWhatsAppList,
  sendWhatsAppText,
} from "../services/whatsapp.js";
import { SENDER_MODES } from "../services/plans.js";
import { incrementWhatsAppUsage } from "../services/usage.js";
import { logAudit } from "../services/audit.js";
import { touchConversationThreadFromLog } from "../services/messageInbox.js";
import { publishTeamInboxEvent } from "../services/teamInboxRealtime.js";
import { reconcileCampaignDeliveryStatus } from "../services/campaignDeliveryStatus.js";
import {
  clearMetaErrorOrderTags,
  tagOrderForMetaSendError,
} from "../services/noWhatsappTag.js";
import {
  sanitizeStoredMeta,
  sanitizeAttemptErrorEvents,
} from "../services/storageSanitizer.js";

const router = express.Router();
const DEBUG = process.env.DEBUG_ORDERX === "true";
const CONFIRMATION_SENT_TAG = "CONFIRMATION_SENT📩";
const ORDER_CONFIRMED_TAG = "ORDER_CONFIRMED✅";
const ORDER_CANCELLED_TAG = "ORDER_CANCELLED❌";
const TERMINAL_ATTEMPT_STATUSES = [
  "confirmed",
  "cancelled",
  "expired",
  "failed",
  "skipped",
];
const dbg = (...args) => {
  if (DEBUG) console.log(...args);
};

/**
 * Optional but strongly recommended:
 * Verify webhook signature from Meta to prevent spoofing.
 *
 * Requires env:
 * WA_APP_SECRET=your_meta_app_secret
 *
 * Meta sends: X-Hub-Signature-256: sha256=<hash>
 */
function verifyMetaSignature(req) {
  const appSecret = String(
    process.env.WA_SECRET || process.env.WA_APP_SECRET || "",
  ).trim();
  const allowUnsigned =
    String(process.env.ALLOW_UNSIGNED_WA_WEBHOOK || "").toLowerCase() ===
      "true" ||
    String(process.env.NODE_ENV || "").toLowerCase() !== "production";
  const signatureHeader = req.get("X-Hub-Signature-256") || "";
  if (!appSecret) return allowUnsigned;
  if (!signatureHeader) return allowUnsigned;

  const [algo, theirSig] = signatureHeader.split("=");
  if (algo !== "sha256" || !theirSig) return allowUnsigned;
  const raw = req.rawBody;
  if (!raw) return allowUnsigned;

  const expected = crypto
    .createHmac("sha256", appSecret)
    .update(raw)
    .digest("hex");
  try {
    const verified = crypto.timingSafeEqual(
      Buffer.from(theirSig, "hex"),
      Buffer.from(expected, "hex"),
    );
    return verified || allowUnsigned;
  } catch {
    return allowUnsigned;
  }
}

function shouldLogWebhookSignatureFailure() {
  const raw = String(process.env.DEBUG_ORDERX || "")
    .trim()
    .toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  return String(process.env.NODE_ENV || "").toLowerCase() !== "production";
}

// Verification (Meta will call this when you set the webhook)
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];

  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WA_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

function normalizeText(v) {
  return String(v || "")
    .normalize("NFKC")
    .replace(/[\u200C\u200D\u200E\u200F\u061C]/g, "")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDigits(v) {
  return String(v || "").replace(/[^\d]/g, "");
}

function phonesMatch(a, b) {
  const left = normalizeDigits(a);
  const right = normalizeDigits(b);
  if (!left || !right) return false;
  return left === right;
}

function toPlainChangeRequest(row) {
  if (!row || typeof row !== "object") return {};
  if (typeof row.toObject === "function") {
    return row.toObject();
  }
  return { ...row };
}

function updateLastChangeRequest(requests, patch = {}) {
  const rows = Array.isArray(requests) ? requests : [];
  if (!rows.length) return rows;
  const last = toPlainChangeRequest(rows[rows.length - 1]);
  rows[rows.length - 1] = {
    ...last,
    ...(patch && typeof patch === "object" ? patch : {}),
  };
  return rows;
}

async function upsertInboundMessageLog({
  shop,
  toE164,
  text,
  waMessageId,
  senderMode,
  senderPhoneNumberId,
  attemptId,
  orderGid,
  meta,
}) {
  const shopDomain = String(shop || "").trim();
  const messageId = String(waMessageId || "").trim();
  if (!shopDomain) return { inserted: false, duplicate: false };

  const payload = {
    shop: shopDomain,
    toE164: toE164 || "",
    direction: "inbound",
    kind: "customer_reply",
    text: text || "",
    waMessageId: messageId || null,
    senderMode: senderMode || SENDER_MODES.ORDERX_NUMBER,
    senderPhoneNumberId: senderPhoneNumberId || null,
    attemptId: attemptId || null,
    orderGid: orderGid || null,
    meta: meta ?? null,
  };

  if (!messageId) {
    await WaMessageLog.create(payload);
    await touchConversationThreadFromLog(payload).catch(() => {});
    publishTeamInboxEvent(shopDomain, "message.created", {
      threadKey: toE164,
      direction: "inbound",
    });
    return { inserted: true, duplicate: false };
  }

  const existing = await WaMessageLog.findOne({
    shop: shopDomain,
    direction: "inbound",
    waMessageId: messageId,
  })
    .select({ _id: 1 })
    .lean();
  if (existing?._id) {
    return { inserted: false, duplicate: true };
  }

  let insertResult;
  try {
    insertResult = await WaMessageLog.updateOne(
      {
        shop: shopDomain,
        direction: "inbound",
        waMessageId: messageId,
      },
      {
        $setOnInsert: payload,
      },
      { upsert: true },
    );
  } catch (error) {
    // Concurrent webhook deliveries can race between the lookup and upsert.
    // The unique message index is the final idempotency guard.
    if (Number(error?.code) === 11000) {
      return { inserted: false, duplicate: true };
    }
    throw error;
  }
  if (!insertResult?.upsertedCount) {
    return { inserted: false, duplicate: true };
  }
  await touchConversationThreadFromLog(payload).catch(() => {});
  publishTeamInboxEvent(shopDomain, "message.created", {
    threadKey: toE164,
    direction: "inbound",
  });
  return { inserted: true, duplicate: false };
}

function isOptOutKeyword(norm) {
  // Keep this strict to avoid colliding with "cancel order" flows.
  return (
    norm === "stop" ||
    norm === "unsubscribe" ||
    norm === "optout" ||
    norm === "opt out" ||
    norm === "stopall" ||
    norm === "stop all"
  );
}

function isOptInKeyword(norm) {
  return norm === "start" || norm === "subscribe" || norm === "opt in";
}

function normalizeToE164FromWebhook(from) {
  const s = String(from || "").trim();
  if (!s) return "";
  // WhatsApp Cloud API webhook `from` is usually digits without leading "+".
  return s.startsWith("+") ? s : `+${s}`;
}

function normalizeWebhookReplyCode(v) {
  return String(v || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function replyContainsWebhookCode(replyText, expectedCode) {
  const reply = normalizeWebhookReplyCode(replyText);
  const expected = normalizeWebhookReplyCode(expectedCode);
  if (!reply || !expected) return false;
  return reply.includes(expected);
}

function extractContextId(msg) {
  return (
    msg?.context?.id ||
    msg?.context?.message_id ||
    msg?.context?.messageId ||
    null
  );
}

function extractReplyId(msg) {
  // Interactive reply IDs (non-template interactive messages)
  const interactiveId =
    msg?.interactive?.button_reply?.id || msg?.interactive?.list_reply?.id;
  if (interactiveId) return String(interactiveId);

  // Template quick reply payloads (some versions send as `button.payload`)
  const buttonPayload = msg?.button?.payload;
  if (buttonPayload) return String(buttonPayload);

  return null;
}

function extractReplyText(msg) {
  const interactiveTitle =
    msg?.interactive?.button_reply?.title ||
    msg?.interactive?.list_reply?.title;
  if (interactiveTitle) return String(interactiveTitle);

  const buttonText = msg?.button?.text;
  if (buttonText) return String(buttonText);

  const textBody = msg?.text?.body;
  if (textBody) return String(textBody);

  return "";
}

function extractInboundMediaMeta(msg) {
  const type = String(msg?.type || "")
    .trim()
    .toLowerCase();
  if (!new Set(["image", "audio", "video", "document", "sticker"]).has(type)) {
    return null;
  }
  const source = msg?.[type];
  const id = String(source?.id || "").trim();
  if (!id) return null;
  return {
    id,
    type,
    mimeType: String(source?.mime_type || "").trim() || null,
    sha256: String(source?.sha256 || "").trim() || null,
    caption: String(source?.caption || "").trim().slice(0, 1024),
    filename: String(source?.filename || "").trim().slice(0, 160),
    voice: type === "audio" && source?.voice === true,
  };
}

function extractInboundContactMeta(msg) {
  const contacts = Array.isArray(msg?.contacts) ? msg.contacts : [];
  if (!contacts.length) return null;
  return contacts.slice(0, 10).map((contact) => ({
    name:
      String(contact?.name?.formatted_name || "").trim().slice(0, 160) ||
      null,
    phones: (Array.isArray(contact?.phones) ? contact.phones : [])
      .slice(0, 5)
      .map((phone) => ({
        phone: String(phone?.phone || "").trim().slice(0, 40) || null,
        waId: String(phone?.wa_id || "").trim().slice(0, 40) || null,
        type: String(phone?.type || "").trim().slice(0, 40) || null,
      })),
  }));
}

function buildInboundLogText(msg, replyText = "") {
  const direct = String(replyText || "").trim();
  if (direct) return direct;
  const type = String(msg?.type || "")
    .trim()
    .toLowerCase();
  const media = extractInboundMediaMeta(msg);
  if (media?.caption) return media.caption;
  if (type === "image") return "[Image]";
  if (type === "audio") return media?.voice ? "[Voice message]" : "[Audio]";
  if (type === "video") return "[Video]";
  if (type === "document") {
    return media?.filename ? `[Document: ${media.filename}]` : "[Document]";
  }
  if (type === "sticker") return "[Sticker]";
  if (type === "location") {
    const latitude = Number(msg?.location?.latitude);
    const longitude = Number(msg?.location?.longitude);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      return `[Location: ${latitude}, ${longitude}]`;
    }
    return "[Location]";
  }
  if (type === "contacts") return "[Contact]";
  return "[Customer message]";
}

function finiteNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const TEMPLATE_BUTTON_ACTION_FALLBACKS = {
  order_confirmation: ["confirm", "cancel", "request_changes"],
};

const TEXT_ACTION_ALIASES = [
  {
    action: "confirm",
    aliases: ["Yes, Confirmed.", "yes confirmed", "confirm", "confirmed"],
  },
  {
    action: "cancel",
    aliases: [
      "No, Cancel it!",
      "No, Cancel it.",
      "no cancel it",
      "cancel",
      "cancel it",
      "no cancel",
    ],
  },
  {
    action: "request_changes",
    aliases: [
      "Request Changes",
      "request changes",
      "request change",
      "change request",
      "make changes",
      "edit order",
    ],
  },
  {
    action: "change_address",
    aliases: [
      "Change address",
      "change address",
      "change adress",
      "chnage address",
      "address change",
      "address",
      "new address",
      "update address",
      "delivery address",
    ],
  },
  {
    action: "change_name",
    aliases: [
      "Change name",
      "change name",
      "name change",
      "name",
      "new name",
      "update name",
      "customer name",
    ],
  },
  {
    action: "change_qty",
    aliases: [
      "Change quantity",
      "change quantity",
      "quantity change",
      "quantity",
      "qty",
      "change qty",
      "update quantity",
    ],
  },
  {
    action: "change_items",
    aliases: [
      "Change items",
      "change item",
      "change items",
      "items",
      "item change",
      "product change",
      "change product",
    ],
  },
  {
    action: "back",
    aliases: ["Back", "go back", "return", "main menu", "order confirmation"],
  },
  {
    action: "redeliver",
    aliases: ["Redeliver", "re deliver", "redelivery", "deliver again"],
  },
];

function parseActionFromText(replyText) {
  const t = normalizeText(replyText);
  if (!t) return null;

  for (const row of TEXT_ACTION_ALIASES) {
    if (row.aliases.some((alias) => normalizeText(alias) === t)) {
      return row.action;
    }
  }

  return null;
}

function parseQtyItemSelectionText(replyText) {
  const qtyItemMatch = String(replyText || "")
    .trim()
    .match(/^#\s*(\d+)\b/);
  if (qtyItemMatch) {
    const index = Number(qtyItemMatch[1]) - 1;
    if (Number.isFinite(index) && index >= 0) {
      return { action: "change_qty_item", arg: String(Math.trunc(index)) };
    }
  }

  return null;
}

function fallbackActionForManagedButton(template, button, index) {
  const storedAction = String(button?.action || "").trim();
  if (storedAction) return storedAction;

  const flowKey = String(template?.flowKey || "").trim();
  const byFlow = TEMPLATE_BUTTON_ACTION_FALLBACKS[flowKey];
  if (Array.isArray(byFlow) && byFlow[index]) return byFlow[index];

  return null;
}

async function resolveAttemptTemplateButtonAction({ attempt, replyText }) {
  const replyNorm = normalizeText(replyText);
  const shop = String(attempt?.shop || "").trim();
  if (!shop || !replyNorm) return null;

  const row = await Shop.findOne({ shop })
    .select({ "whatsappSender.ownNumber.managedTemplates": 1 })
    .lean()
    .catch(() => null);
  const templates = Array.isArray(
    row?.whatsappSender?.ownNumber?.managedTemplates,
  )
    ? row.whatsappSender.ownNumber.managedTemplates
    : [];
  if (!templates.length) return null;

  const usedTemplateName = String(attempt?.waTemplateUsed || "")
    .trim()
    .toLowerCase();
  const preferred = usedTemplateName
    ? templates.filter(
        (template) =>
          String(template?.metaTemplateName || "")
            .trim()
            .toLowerCase() === usedTemplateName,
      )
    : [];
  const candidates = [
    ...preferred,
    ...templates.filter((template) => !preferred.includes(template)),
  ];

  for (const template of candidates) {
    const buttons = Array.isArray(template?.buttons) ? template.buttons : [];
    for (let index = 0; index < buttons.length; index += 1) {
      const button = buttons[index];
      if (normalizeText(button?.text) !== replyNorm) continue;
      const action = fallbackActionForManagedButton(template, button, index);
      if (action) return { action, attemptId: null, arg: null };
    }
  }

  return null;
}

async function maybeHandleCampaignButtonReply({
  shop,
  fromE164,
  contextId,
  replyText,
  receiverPhoneNumberId,
}) {
  const shopDomain = String(shop || "").trim();
  const outboundMessageId = String(contextId || "").trim();
  const phone = String(fromE164 || "").trim();
  const replyNorm = normalizeText(replyText);
  if (!shopDomain || !phone || !replyNorm) {
    return { handled: false };
  }

  const isCampaignOutbound = (row) => {
    const meta =
      row?.meta && typeof row.meta === "object" ? row.meta : {};
    return (
      String(row?.kind || "").trim() === "campaign_template_send" ||
      String(row?.kind || "").trim() === "campaign_template_test_send" ||
      meta?.campaignTemplate === true ||
      String(meta?.source || "").trim() === "campaign_send" ||
      String(meta?.source || "").trim() === "campaign_template_test_send"
    );
  };

  const normalizeCampaignButton = (row) => ({
    text: String(row?.text || "").trim(),
    type: String(row?.type || "").trim() || null,
    action: String(row?.action || "").trim() || null,
    responseText: String(row?.responseText || "").trim() || null,
    tag: String(row?.tag || "").trim() || null,
  });

  const findOutboundByPhoneFallback = async () => {
    const candidates = await WaMessageLog.find({
      shop: shopDomain,
      direction: "outbound",
      toE164: phone,
      ...(receiverPhoneNumberId
        ? { senderPhoneNumberId: String(receiverPhoneNumberId).trim() }
        : {}),
    })
      .sort({ createdAt: -1 })
      .limit(25)
      .lean()
      .catch(() => []);
    return candidates.find((row) => isCampaignOutbound(row)) || null;
  };

  const resolveButtons = async (outbound) => {
    const meta =
      outbound?.meta && typeof outbound.meta === "object" ? outbound.meta : {};
    const directButtons = Array.isArray(meta?.managedTemplateButtons)
      ? meta.managedTemplateButtons.map(normalizeCampaignButton).filter((row) => row.text)
      : [];
    const directHasCampaignConfig = directButtons.some(
      (row) => row.responseText || row.tag,
    );
    if (directHasCampaignConfig) return directButtons;

    const own = await Shop.findOne({ shop: shopDomain })
      .select({
        "whatsappSender.ownNumber.managedTemplates": 1,
        "whatsappSender.ownNumber.campaignLibraryTemplates": 1,
      })
      .lean()
      .catch(() => null);
    const templates = [
      ...(Array.isArray(own?.whatsappSender?.ownNumber?.managedTemplates)
        ? own.whatsappSender.ownNumber.managedTemplates
        : []),
      ...(Array.isArray(own?.whatsappSender?.ownNumber?.campaignLibraryTemplates)
        ? own.whatsappSender.ownNumber.campaignLibraryTemplates
        : []),
    ];
    const targetId = String(meta?.managedTemplateId || "").trim();
    const targetName = String(meta?.managedTemplateMetaName || "")
      .trim()
      .toLowerCase();
    const targetLanguage = String(meta?.managedTemplateLanguage || "")
      .trim()
      .toLowerCase();

    const candidateTemplates = [
      ...templates.filter(
        (template) => String(template?.id || "").trim() === targetId,
      ),
      ...templates.filter(
        (template) =>
          String(template?.metaTemplateName || "")
            .trim()
            .toLowerCase() === targetName &&
          (!targetLanguage ||
            String(template?.language || "")
              .trim()
              .toLowerCase() === targetLanguage),
      ),
      ...templates.filter(
        (template) =>
          String(template?.metaTemplateName || "")
            .trim()
            .toLowerCase() === targetName,
      ),
    ];
    const dedupedCandidates = candidateTemplates.filter(
      (template, index, rows) =>
        rows.findIndex(
          (row) => String(row?.id || "").trim() === String(template?.id || "").trim(),
        ) === index,
    );
    for (const candidate of dedupedCandidates) {
      const templateButtons = Array.isArray(candidate?.buttons)
        ? candidate.buttons
            .map(normalizeCampaignButton)
            .filter((row) => row.text)
        : [];
      if (templateButtons.some((row) => row.responseText || row.tag)) {
        return templateButtons;
      }
      if (templateButtons.length && !directButtons.length) {
        return templateButtons;
      }
    }
    return directButtons;
  };

  const outbound = outboundMessageId
    ? await WaMessageLog.findOne({
        shop: shopDomain,
        direction: "outbound",
        waMessageId: outboundMessageId,
      })
        .sort({ createdAt: -1 })
        .lean()
        .catch(() => null)
    : await findOutboundByPhoneFallback();
  if (!outbound) return { handled: false };

  const meta =
    outbound?.meta && typeof outbound.meta === "object" ? outbound.meta : {};
  if (!isCampaignOutbound(outbound)) return { handled: false };

  const buttons = await resolveButtons(outbound);
  const button = buttons.find(
    (row) => normalizeText(row?.text || "") === replyNorm,
  );
  if (!button) {
    return { handled: Boolean(outboundMessageId), matched: false };
  }

  const responseText = String(button?.responseText || "").trim();
  const tag = String(button?.tag || "").trim();
  let responseSent = false;
  let tagApplied = false;

  if (tag && outbound?.orderGid) {
    const shopRecord = await Shop.findOne({ shop: shopDomain })
      .select({ accessToken: 1 })
      .lean()
      .catch(() => null);
    if (shopRecord) {
      try {
        const admin = await getAdminClient(shopDomain, {
          accessToken: shopRecord.accessToken || "",
          record: shopRecord,
        });
        await appendOrderTag(admin, outbound.orderGid, tag);
        tagApplied = true;
      } catch (e) {
        console.error("[campaign_button_tag]", shopDomain, e?.message || e);
      }
    }
  }

  if (responseText) {
    try {
      await sendWhatsAppText({
        to: phone,
        text: responseText,
        shop: shopDomain,
        kind: "campaign_button_response",
        orderGid: outbound?.orderGid || null,
        meta: {
          source: "campaign_button_reply",
          contextId: outboundMessageId,
          buttonText: String(button?.text || "").trim(),
          tagApplied,
        },
      });
      await incrementWhatsAppUsage(shopDomain, 1, {
        toE164: phone,
        senderPhoneNumberId: receiverPhoneNumberId || null,
      });
      responseSent = true;
    } catch (e) {
      console.error("[campaign_button_response]", shopDomain, e?.message || e);
    }
  }

  return {
    handled: true,
    matched: true,
      responseSent,
      tagApplied,
  };
}

function parseAction({ replyId, replyText }) {
  const id = String(replyId || "").trim();
  if (id) {
    const [action, attemptId, arg] = id.split(":");
    if (action === "confirm") return { action, attemptId: attemptId || null };
    if (action === "cancel") return { action, attemptId: attemptId || null };
    if (action === "redeliver") return { action, attemptId: attemptId || null };
    if (action === "request_changes")
      return { action, attemptId: attemptId || null };
    if (action === "change_address")
      return { action, attemptId: attemptId || null };
    if (action === "change_name")
      return { action, attemptId: attemptId || null };
    if (action === "change_qty")
      return { action, attemptId: attemptId || null };
    if (action === "change_qty_item") {
      return { action, attemptId: attemptId || null, arg: arg || null };
    }
    if (action === "back") return { action, attemptId: attemptId || null };
    if (action === "change_items")
      return { action, attemptId: attemptId || null };

    const idNorm = normalizeText(id);
    if (idNorm.includes("confirm"))
      return { action: "confirm", attemptId: null };
    if (idNorm.includes("cancel")) return { action: "cancel", attemptId: null };
    if (idNorm.includes("redeliver") || idNorm.includes("re deliver"))
      return { action: "redeliver", attemptId: null };
  }

  const textAction = parseActionFromText(replyText);
  if (typeof textAction === "string") {
    return { action: textAction, attemptId: null };
  }
  if (textAction?.action) {
    return {
      action: textAction.action,
      attemptId: null,
      arg: textAction.arg || null,
    };
  }

  return { action: null, attemptId: null, arg: null };
}

function formatProductsText(order) {
  const edges = order?.lineItems?.edges || [];
  const items = edges
    .map((e) => e?.node)
    .filter(Boolean)
    .map((li) => ({
      title: String(li.title || "").trim(),
      qty: Number(li.quantity || 0),
      variant: String(li.variantTitle || "").trim(),
    }))
    .filter((x) => x.title && Number.isFinite(x.qty) && x.qty > 0);

  if (!items.length) return "";

  const maxItems = 10;
  const shown = items.slice(0, maxItems).map((x) => {
    const v =
      x.variant && x.variant.toLowerCase() !== "default title"
        ? ` (${x.variant})`
        : "";
    return `${x.title}${v} Qty ${x.qty}`;
  });

  const suffix =
    items.length > maxItems ? `\n+${items.length - maxItems} more` : "";

  return `${shown.join("\n")}${suffix}`;
}

function formatSingleLineItemLabel(order) {
  const edges = order?.lineItems?.edges || [];
  const nodes = edges.map((e) => e?.node).filter(Boolean);
  if (nodes.length !== 1) return "";
  const li = nodes[0] || {};
  const title = String(li.title || "").trim();
  const variantTitle = String(li.variantTitle || "").trim();
  if (!title) return "";
  const variant =
    variantTitle && variantTitle.toLowerCase() !== "default title"
      ? ` (${variantTitle})`
      : "";
  return `${title}${variant}`.trim();
}

function formatLineItemLabel(li) {
  const title = String(li?.title || "").trim();
  const variantTitle = String(li?.variantTitle || "").trim();
  if (!title) return "";
  const variant =
    variantTitle && variantTitle.toLowerCase() !== "default title"
      ? ` (${variantTitle})`
      : "";
  return `${title}${variant}`.trim();
}

function getOrderLineItems(order) {
  const edges = order?.lineItems?.edges || [];
  return edges.map((e) => e?.node).filter(Boolean);
}

function normalizeQtyOverrides(raw) {
  const rows = Array.isArray(raw) ? raw : [];
  const map = new Map();
  for (const row of rows) {
    const lineIndex = Number(row?.lineIndex);
    const quantity = Number(row?.quantity);
    if (
      !Number.isFinite(lineIndex) ||
      lineIndex < 0 ||
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      continue;
    }
    map.set(Math.trunc(lineIndex), {
      lineIndex: Math.trunc(lineIndex),
      quantity: Math.trunc(quantity),
      productLabel: String(row?.productLabel || "").trim() || null,
      updatedAt: row?.updatedAt ? new Date(row.updatedAt) : null,
    });
  }
  return Array.from(map.values()).sort((a, b) => a.lineIndex - b.lineIndex);
}

function upsertQtyOverride(overrides, nextOverride) {
  const base = normalizeQtyOverrides(overrides);
  const lineIndex = Number(nextOverride?.lineIndex);
  const quantity = Number(nextOverride?.quantity);
  if (
    !Number.isFinite(lineIndex) ||
    lineIndex < 0 ||
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    return base;
  }
  const key = Math.trunc(lineIndex);
  const next = base.filter((x) => Number(x?.lineIndex) !== key);
  next.push({
    lineIndex: key,
    quantity: Math.trunc(quantity),
    productLabel: String(nextOverride?.productLabel || "").trim() || null,
    updatedAt: new Date(),
  });
  return next.sort((a, b) => a.lineIndex - b.lineIndex);
}

function makeQtyOverrideMap(overrides) {
  const map = new Map();
  for (const row of normalizeQtyOverrides(overrides)) {
    map.set(row.lineIndex, row);
  }
  return map;
}

function buildQtySelectionRows(order, attemptId, qtyOverrides = []) {
  const items = getOrderLineItems(order);
  const overrideMap = makeQtyOverrideMap(qtyOverrides);
  const rows = [];

  for (let i = 0; i < items.length && rows.length < 9; i += 1) {
    const li = items[i];
    const label = formatLineItemLabel(li) || `Item ${i + 1}`;
    const overrideQty = Number(overrideMap.get(i)?.quantity);
    const qty = Number.isFinite(overrideQty)
      ? overrideQty
      : Number(li?.quantity || 0);
    rows.push({
      id: `change_qty_item:${attemptId}:${i}`,
      title: `#${i + 1} ${label}`,
      description:
        Number.isFinite(qty) && qty > 0
          ? `Current qty: ${Math.trunc(qty)}`
          : "",
    });
  }

  rows.push({
    id: `back:${attemptId}`,
    title: "Back",
    description: "Return to order confirmation",
  });

  return rows;
}

function buildProductsTextWithQtyOverride(
  order,
  targetLineIndex,
  newQty,
  qtyOverrides = [],
) {
  const items = getOrderLineItems(order);
  if (!items.length) return "";
  const overrideMap = makeQtyOverrideMap(qtyOverrides);
  const targetIdx = Number(targetLineIndex);
  if (
    Number.isFinite(targetIdx) &&
    targetIdx >= 0 &&
    Number.isFinite(Number(newQty)) &&
    Number(newQty) > 0
  ) {
    overrideMap.set(Math.trunc(targetIdx), {
      lineIndex: Math.trunc(targetIdx),
      quantity: Math.trunc(Number(newQty)),
    });
  }

  const maxItems = 10;
  const shown = items
    .slice(0, maxItems)
    .map((li, idx) => {
      const label = formatLineItemLabel(li);
      const overrideQty = Number(overrideMap.get(idx)?.quantity);
      const rawQty = Number.isFinite(overrideQty)
        ? overrideQty
        : Number(li?.quantity || 0);
      const qty = Number.isFinite(Number(rawQty))
        ? Math.trunc(Number(rawQty))
        : 0;
      if (!label) return "";
      return `${label} Qty ${qty > 0 ? qty : 0}`;
    })
    .filter(Boolean);

  const suffix =
    items.length > maxItems ? `\n+${items.length - maxItems} more` : "";
  return shown.length ? `${shown.join("\n")}${suffix}` : "";
}

function computeQtyChangeTotal(
  order,
  targetLineIndex,
  newQty,
  fallbackCurrency = "",
  qtyOverrides = [],
) {
  const items = getOrderLineItems(order);
  if (!items.length) return { ok: false, reason: "no_items" };
  if (
    !Number.isFinite(Number(targetLineIndex)) ||
    targetLineIndex < 0 ||
    targetLineIndex >= items.length
  ) {
    return { ok: false, reason: "invalid_target" };
  }
  const targetQty = Number(newQty);
  if (!Number.isFinite(targetQty) || targetQty <= 0) {
    return { ok: false, reason: "invalid_qty" };
  }
  const overrideMap = makeQtyOverrideMap(qtyOverrides);
  overrideMap.set(Math.trunc(Number(targetLineIndex)), {
    lineIndex: Math.trunc(Number(targetLineIndex)),
    quantity: Math.trunc(targetQty),
  });

  const shippingRaw = order?.totalShippingPriceSet?.shopMoney?.amount ?? 0;
  const shipping = Number(shippingRaw);
  const shippingAmt = Number.isFinite(shipping) ? shipping : 0;

  const itemRows = items.map((li, idx) => {
    const qtyCurrent = Number(li?.quantity || 0);
    const overrideQty = Number(overrideMap.get(idx)?.quantity);
    const qty =
      Number.isFinite(overrideQty) && overrideQty > 0
        ? overrideQty
        : qtyCurrent;
    const unitRaw = li?.originalUnitPriceSet?.shopMoney?.amount;
    let unitPrice = Number(unitRaw);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      const lineTotalRaw = li?.originalTotalSet?.shopMoney?.amount;
      const lineTotal = Number(lineTotalRaw);
      if (Number.isFinite(lineTotal) && qtyCurrent > 0) {
        unitPrice = lineTotal / qtyCurrent;
      }
    }
    const currency =
      String(li?.originalUnitPriceSet?.shopMoney?.currencyCode || "").trim() ||
      String(li?.originalTotalSet?.shopMoney?.currencyCode || "").trim();
    return {
      idx,
      qtyCurrent,
      qty,
      unitPrice: Number.isFinite(unitPrice) ? unitPrice : null,
      currency,
      label: formatLineItemLabel(li),
    };
  });

  // Try to solve one missing unit price from subtotal if possible.
  const missing = itemRows.filter(
    (r) => !Number.isFinite(Number(r.unitPrice)) || Number(r.unitPrice) <= 0,
  );
  if (missing.length) {
    const subtotalRaw = order?.currentSubtotalPriceSet?.shopMoney?.amount;
    const subtotal = Number(subtotalRaw);
    if (Number.isFinite(subtotal) && missing.length === 1) {
      const knownSum = itemRows
        .filter(
          (r) =>
            Number.isFinite(Number(r.unitPrice)) && Number(r.unitPrice) > 0,
        )
        .reduce(
          (acc, r) => acc + Number(r.unitPrice) * (Number(r.qtyCurrent) || 0),
          0,
        );
      const m = missing[0];
      const missingQtyCurrent = Number(m.qtyCurrent || 0);
      if (missingQtyCurrent > 0) {
        const derived = (subtotal - knownSum) / missingQtyCurrent;
        if (Number.isFinite(derived) && derived > 0) {
          m.unitPrice = derived;
        }
      }
    }
  }

  if (
    itemRows.some(
      (r) => !Number.isFinite(Number(r.unitPrice)) || Number(r.unitPrice) <= 0,
    )
  ) {
    return { ok: false, reason: "missing_unit_price" };
  }

  const itemsTotal = itemRows.reduce(
    (acc, r) => acc + Number(r.unitPrice) * Math.trunc(Number(r.qty) || 0),
    0,
  );
  const total = itemsTotal + shippingAmt;
  const currency =
    String(order?.currentTotalPriceSet?.shopMoney?.currencyCode || "").trim() ||
    String(
      order?.currentSubtotalPriceSet?.shopMoney?.currencyCode || "",
    ).trim() ||
    itemRows.find((r) => r.currency)?.currency ||
    String(fallbackCurrency || "").trim();

  if (!Number.isFinite(total) || !currency) {
    return { ok: false, reason: "calc_failed" };
  }

  const targetItem = itemRows[targetLineIndex] || null;
  return {
    ok: true,
    total,
    currency,
    amountText: formatAmountText(total, currency),
    shippingAmt,
    targetLabel: targetItem?.label || "",
  };
}

function formatDeliveryAddressText(addr) {
  if (!addr) return "";
  const parts = [
    addr?.address1,
    addr?.address2,
    addr?.city,
    addr?.province,
    addr?.zip,
    addr?.country,
  ]
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  return parts.join(", ");
}

function formatAmountText(amount, currency) {
  const a = Number(amount);
  const c = String(currency || "").trim();
  if (!Number.isFinite(a) || !c) return "";
  return `${a.toFixed(2)} ${c}`;
}

function firstProductImageUrl(order) {
  const edges = Array.isArray(order?.lineItems?.edges)
    ? order.lineItems.edges
    : [];
  for (const edge of edges) {
    const li = edge?.node || {};
    const productImageEdge =
      li?.product?.images?.edges?.[0]?.node?.url ||
      li?.product?.images?.nodes?.[0]?.url ||
      "";
    const variantProductImageEdge =
      li?.variant?.product?.images?.edges?.[0]?.node?.url ||
      li?.variant?.product?.images?.nodes?.[0]?.url ||
      "";
    const candidates = [
      li?.image?.url,
      li?.variant?.image?.url,
      li?.variant?.product?.featuredImage?.url,
      li?.variant?.product?.featuredMedia?.preview?.image?.url,
      variantProductImageEdge,
      li?.product?.featuredImage?.url,
      li?.product?.featuredMedia?.preview?.image?.url,
      productImageEdge,
    ];
    const hit = candidates
      .map((value) => String(value || "").trim())
      .find((value) => /^https:\/\//i.test(value));
    if (hit) return hit;
  }
  return "";
}

function normalizeOneLine(v) {
  return String(v || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildAddressTag(addrText) {
  const clean = normalizeOneLine(addrText).replace(/,/g, " ").trim();
  if (!clean) return null;
  const clipped = clean.length > 160 ? `${clean.slice(0, 157)}...` : clean;
  return `ADDRESS_UPDATED: ${clipped} 📍`;
}

function buildNameTag(nameText) {
  const clean = normalizeOneLine(nameText).replace(/,/g, " ").trim();
  if (!clean) return null;
  const clipped = clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
  return `cod_new_name:${clipped}`;
}

function buildQtyTag(qty) {
  const q = Number(qty);
  if (!Number.isFinite(q) || q <= 0) return null;
  return `cod_new_qty:${Math.trunc(q)}`;
}

function buildAmountTag(amountText) {
  const clean = normalizeOneLine(amountText).replace(/,/g, " ").trim();
  if (!clean) return null;
  const clipped = clean.length > 40 ? `${clean.slice(0, 37)}...` : clean;
  return `cod_new_amount:${clipped}`;
}

function buildReadableAddressTag(addrText) {
  const clean = normalizeOneLine(addrText).replace(/,/g, " ").trim();
  if (!clean) return null;
  const clipped = clean.length > 160 ? `${clean.slice(0, 157)}...` : clean;
  return `ADDRESS_UPDATED: ${clipped} 📍`;
}

function buildReadableNameTag(nameText) {
  const clean = normalizeOneLine(nameText).replace(/,/g, " ").trim();
  if (!clean) return null;
  const clipped = clean.length > 100 ? `${clean.slice(0, 97)}...` : clean;
  return `New Name: ${clipped}`;
}

function buildReadableQtyTag(qty, productLabel) {
  const q = Number(qty);
  if (!Number.isFinite(q) || q <= 0) return null;
  const label = normalizeOneLine(productLabel).replace(/,/g, " ").trim();
  const safeLabel = label.length > 70 ? `${label.slice(0, 67)}...` : label;
  return safeLabel
    ? `New Quantity ${safeLabel}: ${Math.trunc(q)}`
    : `New Quantity: ${Math.trunc(q)}`;
}

function buildReadableAmountTag(amountText) {
  const clean = normalizeOneLine(amountText).replace(/,/g, " ").trim();
  if (!clean) return null;
  const clipped = clean.length > 60 ? `${clean.slice(0, 57)}...` : clean;
  return `New Amount: ${clipped}`;
}

async function safeAppendOrderTags(shopDomain, orderGid, tags, label) {
  const shop = String(shopDomain || "").trim();
  const gid = String(orderGid || "").trim();
  const incoming = Array.isArray(tags) ? tags : [tags];
  const clean = incoming.map((t) => String(t || "").trim()).filter(Boolean);
  if (!shop || !gid || !clean.length) return;

  try {
    const shopRecord = await Shop.findOne({ shop }).lean();
    if (!shopRecord) return;
    const admin = await getAdminClient(shop, {
      accessToken: shopRecord.accessToken || "",
      record: shopRecord,
    });
    await appendOrderTags(admin, gid, clean);
  } catch (e) {
    console.error(label || "[wa_tag]", shop, e?.message || e);
  }
}

async function safeUpsertCodChangeSummaryTags(shopDomain, orderGid, summary) {
  const shop = String(shopDomain || "").trim();
  const gid = String(orderGid || "").trim();
  if (!shop || !gid) return;

  const s = summary && typeof summary === "object" ? summary : {};
  const tagsToAdd = ["CHANGE_REQUESTED✏️"];

  const nameTag = s.name ? buildNameTag(s.name) : null;
  const addressTag = s.address ? buildAddressTag(s.address) : null;
  const qtyTag =
    Number.isFinite(Number(s.quantity)) && Number(s.quantity) > 0
      ? buildQtyTag(s.quantity)
      : null;
  const qtyOverrides = normalizeQtyOverrides(s.quantityOverrides);
  const amountTag = s.amountText ? buildAmountTag(s.amountText) : null;
  const readableNameTag = s.name ? buildReadableNameTag(s.name) : null;
  const readableAddressTag = s.address
    ? buildReadableAddressTag(s.address)
    : null;
  const readableQtyTag =
    Number.isFinite(Number(s.quantity)) && Number(s.quantity) > 0
      ? buildReadableQtyTag(s.quantity, s.quantityProductLabel)
      : null;
  const readableQtyOverrideTags = qtyOverrides
    .map((row) => buildReadableQtyTag(row.quantity, row.productLabel))
    .filter(Boolean);
  const readableAmountTag = s.amountText
    ? buildReadableAmountTag(s.amountText)
    : null;

  if (nameTag) tagsToAdd.push(nameTag);
  if (addressTag) tagsToAdd.push(addressTag);
  if (qtyTag) tagsToAdd.push(qtyTag);
  if (amountTag) tagsToAdd.push(amountTag);
  if (readableNameTag) tagsToAdd.push(readableNameTag);
  if (readableAddressTag) tagsToAdd.push(readableAddressTag);
  if (readableQtyTag) tagsToAdd.push(readableQtyTag);
  if (readableQtyOverrideTags.length)
    tagsToAdd.push(...readableQtyOverrideTags);
  if (readableAmountTag) tagsToAdd.push(readableAmountTag);

  try {
    const shopRecord = await Shop.findOne({ shop }).lean();
    if (!shopRecord) return;
    const admin = await getAdminClient(shop, {
      accessToken: shopRecord.accessToken || "",
      record: shopRecord,
    });
    const existing = await fetchOrderTags(admin, gid);
    const keep = (existing || [])
      .map((t) => String(t || "").trim())
      .filter(Boolean)
      .filter(
        (t) =>
          !t.startsWith("cod_change_") &&
          !t.startsWith("cod_new_") &&
          t !== "CHANGE_REQUESTED✏️" &&
          t !== "QUANTITY_CHANGE_REQUESTED🔢" &&
          !/^address_updated\s*:/i.test(t) &&
          !/^address_updated📍$/i.test(t) &&
          !/^new address\s*:/i.test(t) &&
          !/^new name\s*:/i.test(t) &&
          !/^new quantity\b/i.test(t) &&
          !/^new amount\s*:/i.test(t),
      );

    const next = Array.from(new Set([...keep, ...tagsToAdd]));

    const mutation = `#graphql
      mutation($input: OrderInput!) {
        orderUpdate(input: $input) {
          order { id tags }
          userErrors { message }
        }
      }
    `;

    const res = await admin.query({
      data: mutation,
      variables: { input: { id: gid, tags: next } },
    });

    const errs = res.body?.data?.orderUpdate?.userErrors;
    if (errs?.length) {
      throw new Error(errs.map((e) => e.message).join(", "));
    }
  } catch (e) {
    console.error("[wa_change_tag_upsert]", shop, e?.message || e);
  }
}

async function sendQtyInvalidPromptWithBack({
  attempt,
  to,
  kind = "change_qty_invalid",
  meta = null,
}) {
  if (!attempt?._id) return;
  await sendWhatsAppButtons({
    to,
    text: "Invalid quantity. Please reply with digits only. Example: 2",
    buttons: [{ id: `back:${attempt._id.toString()}`, title: "Back" }],
    shop: attempt.shop,
    kind,
    attemptId: attempt._id,
    orderGid: attempt.orderGid,
    meta: {
      source: "whatsapp_webhook",
      ...(meta && typeof meta === "object" ? meta : {}),
    },
  });
  await incrementWhatsAppUsage(attempt.shop, 1);
}

async function resolveAttempt({
  attemptId,
  contextId,
  fromE164,
  shopHint,
  receiverPhoneNumberId,
  preferOpenAttempt = false,
}) {
  const shop = String(shopHint || "").trim();
  const senderPhoneNumberId = String(receiverPhoneNumberId || "").trim();
  const phone = fromE164 ? String(fromE164).trim() : "";
  const openStatusFilter = { $nin: TERMINAL_ATTEMPT_STATUSES };

  const findAttemptByPhone = async ({
    phoneE164,
    senderId = "",
    activeOnly = false,
  }) => {
    if (!phoneE164) return null;
    const query = {
      phoneE164: String(phoneE164),
      $or: [{ waSentAt: { $ne: null } }, { waMessageId: { $ne: null } }],
      ...(shop ? { shop } : {}),
      ...(activeOnly ? { status: openStatusFilter } : {}),
    };
    if (senderId) {
      query.senderPhoneNumberId = senderId;
    }
    return CodAttempt.findOne(query).sort({
      waSentAt: -1,
      createdAt: -1,
    });
  };

  const findAttemptFromOutboundLog = async ({
    phoneE164,
    senderId = "",
    activeOnly = false,
  }) => {
    if (!phoneE164) return null;
    const logRows = await WaMessageLog.find({
      direction: "outbound",
      toE164: String(phoneE164),
      attemptId: { $ne: null },
      ...(senderId ? { senderPhoneNumberId: senderId } : {}),
      ...(shop ? { shop } : {}),
    })
      .sort({ createdAt: -1 })
      .limit(activeOnly ? 10 : 1)
      .select({ attemptId: 1 })
      .lean();

    for (const row of logRows) {
      if (!row?.attemptId) continue;
      const found = await CodAttempt.findOne({
        _id: row.attemptId,
        ...(activeOnly ? { status: openStatusFilter } : {}),
      }).catch(() => null);
      if (found) return found;
    }
    return null;
  };

  if (attemptId) {
    const found = await CodAttempt.findById(attemptId);
    if (found) return found;
  }

  if (contextId) {
    const found = await CodAttempt.findOne({
      $or: [
        { waMessageId: String(contextId) },
        { changeReconfirmWaMessageId: String(contextId) },
      ],
    }).sort({ createdAt: -1 });
    if (found) return found;
  }

  if (phone && senderPhoneNumberId && preferOpenAttempt) {
    const byOpenAttemptSender = await findAttemptByPhone({
      phoneE164: phone,
      senderId: senderPhoneNumberId,
      activeOnly: true,
    });
    if (byOpenAttemptSender) return byOpenAttemptSender;
  }

  if (phone && senderPhoneNumberId) {
    const byAttemptSender = await findAttemptByPhone({
      phoneE164: phone,
      senderId: senderPhoneNumberId,
      activeOnly: false,
    });
    if (byAttemptSender) return byAttemptSender;
  }

  if (phone && senderPhoneNumberId && preferOpenAttempt) {
    const openAttemptFromSenderLog = await findAttemptFromOutboundLog({
      phoneE164: phone,
      senderId: senderPhoneNumberId,
      activeOnly: true,
    });
    if (openAttemptFromSenderLog) return openAttemptFromSenderLog;
  }

  if (phone && senderPhoneNumberId) {
    const attemptFromSenderLog = await findAttemptFromOutboundLog({
      phoneE164: phone,
      senderId: senderPhoneNumberId,
      activeOnly: false,
    });
    if (attemptFromSenderLog) return attemptFromSenderLog;
  }

  if (phone && !senderPhoneNumberId && preferOpenAttempt) {
    const openByPhone = await findAttemptByPhone({
      phoneE164: phone,
      activeOnly: true,
    });
    if (openByPhone) return openByPhone;

    const openByPhoneLog = await findAttemptFromOutboundLog({
      phoneE164: phone,
      activeOnly: true,
    });
    if (openByPhoneLog) return openByPhoneLog;
  }

  if (phone && !senderPhoneNumberId) {
    // Last resort: pick the latest attempt we have previously messaged this number for.
    // Do not keep a strict age cutoff here; late customer replies can arrive after a week.
    const found = await findAttemptByPhone({
      phoneE164: phone,
      activeOnly: false,
    });
    if (found) return found;
  }

  return null;
}

async function attemptMatchesInboundSender({
  attempt,
  receiverPhoneNumberId,
  fromE164,
}) {
  if (!attempt?._id) return true;
  const receiverId = String(receiverPhoneNumberId || "").trim();
  if (!receiverId) return true;

  const attemptSenderId = String(attempt?.senderPhoneNumberId || "").trim();
  if (attemptSenderId) {
    return attemptSenderId === receiverId;
  }

  const phone = String(fromE164 || "").trim();
  if (!phone) return true;

  const outbound = await WaMessageLog.findOne({
    attemptId: attempt._id,
    direction: "outbound",
    toE164: phone,
    senderPhoneNumberId: { $nin: [null, ""] },
  })
    .sort({ createdAt: -1 })
    .select({ senderPhoneNumberId: 1 })
    .lean()
    .catch(() => null);

  const outboundSenderId = String(outbound?.senderPhoneNumberId || "").trim();
  if (!outboundSenderId) return true;
  return outboundSenderId === receiverId;
}

async function hasAmbiguousOpenAttemptForInbound({
  fromE164,
  receiverPhoneNumberId,
  shopHint,
}) {
  const phone = String(fromE164 || "").trim();
  if (!phone) return false;

  const shop = String(shopHint || "").trim();
  const receiverId = String(receiverPhoneNumberId || "").trim();
  const query = {
    phoneE164: phone,
    status: {
      $nin: ["confirmed", "cancelled", "expired", "failed", "skipped"],
    },
    $or: [
      { waSentAt: { $ne: null } },
      { waMessageId: { $ne: null } },
      { scheduledAt: { $ne: null } },
      { status: "pending" },
    ],
    ...(shop ? { shop } : {}),
  };

  if (receiverId) {
    query.$and = [
      {
        $or: [
          { senderPhoneNumberId: receiverId },
          { senderPhoneNumberId: { $in: [null, ""] } },
        ],
      },
    ];
  }

  const rows = await CodAttempt.find(query)
    .sort({ waSentAt: -1, createdAt: -1 })
    .limit(2)
    .select({ _id: 1 })
    .lean()
    .catch(() => []);

  return Array.isArray(rows) && rows.length > 1;
}

async function resolveShopByReceiverPhoneNumberId(phoneNumberId) {
  const id = String(phoneNumberId || "").trim();
  if (!id) return "";
  const row = await Shop.findOne({
    "whatsappSender.ownNumber.phoneNumberId": id,
  })
    .select({ shop: 1 })
    .lean();
  return String(row?.shop || "").trim();
}

async function resolveSingleSupportShop() {
  const rows = await Shop.find({
    accessToken: { $nin: [null, ""] },
    "settings.supportWhatsAppNumber": { $exists: true, $ne: "" },
  })
    .select({ shop: 1 })
    .limit(2)
    .lean();

  return rows.length === 1 ? String(rows[0]?.shop || "") : "";
}

function normalizeOutboundStatus(status) {
  return String(status || "")
    .trim()
    .toLowerCase();
}

function isSuccessfulOutboundStatus(status) {
  const s = normalizeOutboundStatus(status);
  return s === "sent" || s === "delivered" || s === "read";
}

function normalizeOrderTagsForCompare(tags = []) {
  return (Array.isArray(tags) ? tags : [])
    .map((tag) =>
      String(tag || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
}

function hasNormalizedOrderTag(normalizedTags = [], tag = "") {
  const needle = String(tag || "")
    .trim()
    .toLowerCase();
  return Boolean(needle && normalizedTags.includes(needle));
}

function hasResolvedOrderTag(normalizedTags = []) {
  return (
    hasNormalizedOrderTag(normalizedTags, ORDER_CONFIRMED_TAG) ||
    hasNormalizedOrderTag(normalizedTags, "order_confirmed✅") ||
    hasNormalizedOrderTag(normalizedTags, ORDER_CANCELLED_TAG) ||
    hasNormalizedOrderTag(normalizedTags, "cod_cancelled")
  );
}

async function appendConfirmationSentTagIfSafe({
  admin,
  shop,
  orderGid,
  attemptId = null,
}) {
  const shopDomain = String(shop || "").trim();
  const gid = String(orderGid || "").trim();
  if (!admin || !shopDomain || !gid) {
    return { ok: false, skipped: "missing_admin_shop_or_order" };
  }

  const normalizedAttemptId = String(attemptId || "").trim();
  if (normalizedAttemptId) {
    const liveAttempt = await CodAttempt.findOne({
      _id: normalizedAttemptId,
      shop: shopDomain,
      orderGid: gid,
    })
      .select({ status: 1, stage: 1 })
      .lean()
      .catch(() => null);
    if (
      !liveAttempt ||
      String(liveAttempt?.stage || "").trim() !== "pre_dispatch" ||
      String(liveAttempt?.status || "").trim() !== "wa_sent"
    ) {
      return { ok: false, skipped: "attempt_no_longer_needs_sent_tag" };
    }
  } else {
    const resolvedAttempt = await CodAttempt.findOne({
      shop: shopDomain,
      orderGid: gid,
      stage: "pre_dispatch",
      status: { $in: ["confirmed", "cancelled"] },
    })
      .select({ _id: 1, status: 1 })
      .lean()
      .catch(() => null);
    if (resolvedAttempt?._id) {
      return { ok: false, skipped: "order_attempt_already_resolved" };
    }
  }

  const tags = await fetchOrderTags(admin, gid);
  const normalizedTags = normalizeOrderTagsForCompare(tags);
  if (hasResolvedOrderTag(normalizedTags)) {
    return { ok: false, skipped: "order_already_resolved" };
  }
  if (hasNormalizedOrderTag(normalizedTags, CONFIRMATION_SENT_TAG)) {
    return { ok: true, alreadyPresent: true };
  }

  await appendOrderTag(admin, gid, CONFIRMATION_SENT_TAG);
  const stillEligible = normalizedAttemptId
    ? await CodAttempt.exists({
        _id: normalizedAttemptId,
        shop: shopDomain,
        orderGid: gid,
        stage: "pre_dispatch",
        status: "wa_sent",
      }).catch(() => null)
    : !(await CodAttempt.exists({
        shop: shopDomain,
        orderGid: gid,
        stage: "pre_dispatch",
        status: { $in: ["confirmed", "cancelled"] },
      }).catch(() => null));
  if (!stillEligible) {
    await removeOrderTags(admin, gid, [CONFIRMATION_SENT_TAG]).catch(() => null);
    return { ok: false, skipped: "order_resolved_during_tag_write" };
  }
  return { ok: true, applied: true };
}

function extractStatusErrorText(status) {
  const errors = Array.isArray(status?.errors) ? status.errors : [];
  if (!errors.length) return "";
  return errors
    .map((row) => {
      const title = String(
        row?.title || row?.message || row?.error_data?.details || "",
      ).trim();
      const code = Number(row?.code || 0);
      return title
        ? code > 0
          ? `${title} (code ${code})`
          : title
        : code > 0
          ? `Meta error code ${code}`
          : "";
    })
    .filter(Boolean)
    .join(" | ")
    .slice(0, 500);
}

async function handleByonOutboundDeliveryStatus({
  shopDomain,
  receiverPhoneNumberId,
  status,
}) {
  const shop = String(shopDomain || "").trim();
  const waMessageId = String(status?.id || "").trim();
  if (!shop || !waMessageId) return;

  const statusValue = normalizeOutboundStatus(status?.status || "");
  if (!statusValue) return;

  const recipientE164 = normalizeToE164FromWebhook(status?.recipient_id);
  const now = new Date();
  const statusError = extractStatusErrorText(status);
  const deliveryFailed = statusValue === "failed";

  try {
    const metaUpdates = {
      "meta.deliveryStatus": statusValue,
      "meta.deliveryStatusAt": now,
      ...(statusError ? { "meta.deliveryError": statusError } : {}),
    };
    await WaMessageLog.updateOne(
      { shop, direction: "outbound", waMessageId },
      {
        $set: {
          ...metaUpdates,
          ...(recipientE164 ? { toE164: recipientE164 } : {}),
          ...(receiverPhoneNumberId
            ? { senderPhoneNumberId: String(receiverPhoneNumberId).trim() }
            : {}),
        },
        $setOnInsert: {
          kind: "delivery_status_placeholder",
          text: "",
        },
      },
      { upsert: true },
    );
    let threadKey = recipientE164;
    if (!threadKey) {
      threadKey = String(
        (
          await WaMessageLog.findOne({ shop, waMessageId })
            .select({ toE164: 1 })
            .lean()
        )?.toE164 || "",
      ).trim();
    }
    publishTeamInboxEvent(shop, "message.status", {
      threadKey,
      waMessageId,
      deliveryStatus: statusValue,
      deliveryError: statusError || null,
    });
  } catch {
    // ignore status log update failures
  }

  await reconcileCampaignDeliveryStatus({
    shop,
    waMessageId,
    status: statusValue,
    statusAt: now,
    errorText: statusError,
    errors: status?.errors,
  }).catch((error) => {
    console.error(
      "[campaign_delivery_status]",
      shop,
      waMessageId,
      error?.message || error,
    );
  });

  const attempt = await CodAttempt.findOne({ shop, waMessageId })
    .sort({ createdAt: -1 })
    .catch(() => null);
  let deliveryShopRecord = null;

  if (attempt?._id) {
    const previousAttemptStatus = String(attempt.status || "").trim();
    attempt.waDeliveryStatus = statusValue;
    attempt.waDeliveryStatusAt = now;
    attempt.waDeliveryError = statusError || null;

    const previousMeta =
      attempt?.lastErrorMeta && typeof attempt.lastErrorMeta === "object"
        ? attempt.lastErrorMeta
        : {};
    const previousNestedMeta =
      previousMeta?.meta && typeof previousMeta.meta === "object"
        ? previousMeta.meta
        : {};

    attempt.lastErrorMeta = sanitizeStoredMeta({
      ...previousMeta,
      meta: {
        ...previousNestedMeta,
        deliveryStatus: statusValue,
        deliveryStatusAt: now,
        ...(statusError ? { deliveryError: statusError } : {}),
        ...(recipientE164 ? { recipientE164 } : {}),
        ...(receiverPhoneNumberId
          ? { receiverPhoneNumberId: String(receiverPhoneNumberId).trim() }
          : {}),
      },
    });

    if (statusValue === "failed") {
      const deliveryMessage =
        statusError || "WhatsApp delivery failed after send acceptance";
      attempt.status = "failed";
      attempt.lastError = deliveryMessage;
      attempt.lastErrorAt = now;
      const errorEvents = Array.isArray(attempt.errorEvents)
        ? [...attempt.errorEvents]
        : [];
      errorEvents.push({
        at: now,
        step: "delivery",
        message: deliveryMessage,
        meta: sanitizeStoredMeta({
          deliveryStatus: statusValue,
          ...(statusError ? { deliveryError: statusError } : {}),
          ...(recipientE164 ? { recipientE164 } : {}),
          ...(receiverPhoneNumberId
            ? { receiverPhoneNumberId: String(receiverPhoneNumberId).trim() }
            : {}),
        }),
      });
      attempt.errorEvents = sanitizeAttemptErrorEvents(errorEvents, {
        keep: 10,
      });
      await attempt.save().catch(() => {});
      if (attempt.orderGid) {
        deliveryShopRecord = await Shop.findOne({ shop })
          .select({ accessToken: 1, settings: 1 })
          .lean()
          .catch(() => null);
        if (deliveryShopRecord && attempt.orderGid) {
          const admin = await getAdminClient(shop, {
            accessToken: deliveryShopRecord.accessToken || "",
            record: deliveryShopRecord,
          }).catch(() => null);
          if (admin) {
            await removeOrderTags(admin, attempt.orderGid, [
              CONFIRMATION_SENT_TAG,
            ]).catch((error) => {
              console.error(
                "[delivery_no_whatsapp_remove_sent_tag]",
                shop,
                error?.message || error,
              );
            });
          }
        }
        await tagOrderForMetaSendError({
          shop,
          accessToken: deliveryShopRecord?.accessToken,
          orderGid: attempt.orderGid,
          error: status,
          label: "delivery_error_tag",
        });
      }
      await releaseQueuesAfterAttemptResolved({
        sourceAttempt: attempt,
        fromE164: attempt.phoneE164,
        context: "delivery_failed",
      }).catch(() => {});
    } else {
      await attempt.save().catch(() => {});
      if (
        previousAttemptStatus === "wa_sent" &&
        isSuccessfulOutboundStatus(statusValue)
      ) {
        deliveryShopRecord = await Shop.findOne({ shop })
          .select({ accessToken: 1, settings: 1 })
          .lean()
          .catch(() => null);
        const autoTagOrders =
          deliveryShopRecord?.settings?.autoTagOrders !== false;
        if (
          autoTagOrders &&
          deliveryShopRecord &&
          attempt.orderGid
        ) {
          const admin = await getAdminClient(shop, {
            accessToken: deliveryShopRecord.accessToken || "",
            record: deliveryShopRecord,
          }).catch(() => null);
          if (admin) {
            await clearMetaErrorOrderTags({
              shop,
              accessToken: deliveryShopRecord.accessToken,
              orderGid: attempt.orderGid,
              label: "delivery_clear_error_tags",
            }).catch(() => {});
            await appendConfirmationSentTagIfSafe({
              admin,
              shop,
              orderGid: attempt.orderGid,
              attemptId: attempt._id,
            }).catch((error) => {
              console.error(
                "[wa_delivery_sent_tag]",
                shop,
                error?.message || error,
              );
            });
          }
        }
      }
    }
  }

  if (!attempt?._id) {
    const log = await WaMessageLog.findOne({ shop, waMessageId })
      .select({ orderGid: 1, attemptId: 1 })
      .lean()
      .catch(() => null);
    if (log?.orderGid) {
      deliveryShopRecord =
        deliveryShopRecord ||
        (await Shop.findOne({ shop })
          .select({ accessToken: 1, settings: 1 })
          .lean()
          .catch(() => null));
      if (deliveryFailed) {
        await tagOrderForMetaSendError({
          shop,
          accessToken: deliveryShopRecord?.accessToken,
          orderGid: log.orderGid,
          error: status,
          label: "delivery_log_error_tag",
        });
      } else if (isSuccessfulOutboundStatus(statusValue)) {
        const autoTagOrders =
          deliveryShopRecord?.settings?.autoTagOrders !== false;
        await clearMetaErrorOrderTags({
          shop,
          accessToken: deliveryShopRecord?.accessToken,
          orderGid: log.orderGid,
          label: "delivery_log_clear_error_tags",
        }).catch(() => {});
        if (
          autoTagOrders &&
          deliveryShopRecord &&
          log.orderGid
        ) {
          const admin = await getAdminClient(shop, {
            accessToken: deliveryShopRecord.accessToken || "",
            record: deliveryShopRecord,
          }).catch(() => null);
          if (admin) {
            await appendConfirmationSentTagIfSafe({
              admin,
              shop,
              orderGid: log.orderGid,
              attemptId: log.attemptId || null,
            }).catch((error) => {
              console.error(
                "[wa_delivery_log_sent_tag]",
                shop,
                error?.message || error,
              );
            });
          }
        }
      }
    }
  }

  const own = (
    await Shop.findOne({ shop })
      .select({
        "whatsappSender.ownNumber.testMessageOutboundMessageId": 1,
        "whatsappSender.ownNumber.testMessageStatus": 1,
        "whatsappSender.ownNumber.onboardingCompletedAt": 1,
        "whatsappSender.ownNumber.webhookTestOutboundMessageId": 1,
        "whatsappSender.ownNumber.webhookTestStatus": 1,
      })
      .lean()
  )?.whatsappSender?.ownNumber;

  if (!own) return;

  const isLiveTestMessage =
    String(own?.testMessageOutboundMessageId || "").trim() === waMessageId;
  const isWebhookReplyTestMessage =
    String(own?.webhookTestOutboundMessageId || "").trim() === waMessageId;

  if (!isLiveTestMessage && !isWebhookReplyTestMessage) return;

  if (isLiveTestMessage) {
    if (isSuccessfulOutboundStatus(statusValue)) {
      const webhookVerified =
        String(own?.webhookTestStatus || "").trim() === "received";
      const setFields = {
        "whatsappSender.ownNumber.testMessageStatus": statusValue,
        "whatsappSender.ownNumber.testMessageStatusAt": now,
        "whatsappSender.ownNumber.testMessageLastError": null,
        "whatsappSender.ownNumber.testMessageLastErrorAt": null,
        "whatsappSender.ownNumber.lastError": null,
        "whatsappSender.ownNumber.lastErrorAt": null,
        ...(webhookVerified
          ? { "whatsappSender.ownNumber.onboardingCompletedAt": now }
          : { "whatsappSender.ownNumber.onboardingCompletedAt": null }),
      };
      await Shop.updateOne({ shop }, { $set: setFields }).catch(() => {});
      return;
    }

    if (statusValue === "failed") {
      const msg =
        statusError ||
        "Live test message was not delivered. Verify recipient number and WhatsApp account status, then retry.";
      await Shop.updateOne(
        { shop },
        {
          $set: {
            "whatsappSender.ownNumber.testMessageStatus": "failed",
            "whatsappSender.ownNumber.testMessageStatusAt": now,
            "whatsappSender.ownNumber.testMessageLastError": msg,
            "whatsappSender.ownNumber.testMessageLastErrorAt": now,
            "whatsappSender.ownNumber.lastError": msg,
            "whatsappSender.ownNumber.lastErrorAt": now,
            "whatsappSender.ownNumber.onboardingCompletedAt": null,
            "whatsappSender.ownNumber.webhookTestStatus": "failed",
            "whatsappSender.ownNumber.webhookTestLastError": msg,
            "whatsappSender.ownNumber.webhookTestLastErrorAt": now,
          },
        },
      ).catch(() => {});
      return;
    }
  }

  if (isWebhookReplyTestMessage && statusValue === "failed") {
    const msg =
      statusError ||
      "Webhook test message failed to deliver. Retry webhook test with another reachable WhatsApp number.";
    await Shop.updateOne(
      { shop },
      {
        $set: {
          "whatsappSender.ownNumber.webhookTestStatus": "failed",
          "whatsappSender.ownNumber.webhookTestLastError": msg,
          "whatsappSender.ownNumber.webhookTestLastErrorAt": now,
        },
      },
    ).catch(() => {});
  }
}

async function maybeHandleByonWebhookReplyTest({
  shopDomain,
  fromE164,
  replyText,
  waMessageId,
  contextId,
}) {
  const shop = String(shopDomain || "").trim();
  if (!shop) return { handled: false, matched: false };

  const row = await Shop.findOne({
    shop,
    "whatsappSender.ownNumber.webhookTestStatus": "waiting_reply",
  })
    .select({
      shop: 1,
      "whatsappSender.ownNumber.webhookTestStatus": 1,
      "whatsappSender.ownNumber.webhookTestTargetPhoneE164": 1,
      "whatsappSender.ownNumber.webhookTestExpectedReplyCode": 1,
      "whatsappSender.ownNumber.webhookTestOutboundMessageId": 1,
      "whatsappSender.ownNumber.testMessageStatus": 1,
      "whatsappSender.ownNumber.onboardingCompletedAt": 1,
    })
    .lean();

  const own = row?.whatsappSender?.ownNumber || {};
  if (!row || String(own?.webhookTestStatus || "") !== "waiting_reply") {
    return { handled: false, matched: false };
  }

  const targetPhone = String(own?.webhookTestTargetPhoneE164 || "").trim();
  const now = new Date();
  if (!targetPhone) {
    await Shop.updateOne(
      { shop },
      {
        $set: {
          "whatsappSender.ownNumber.webhookTestStatus": "failed",
          "whatsappSender.ownNumber.webhookTestLastError":
            "Webhook test target phone is missing. Start a new webhook test.",
          "whatsappSender.ownNumber.webhookTestLastErrorAt": now,
        },
      },
    ).catch(() => {});
    return { handled: false, matched: false };
  }
  if (targetPhone && !fromE164) {
    return { handled: true, matched: false };
  }
  if (targetPhone && !phonesMatch(targetPhone, fromE164)) {
    return { handled: false, matched: false };
  }

  const expectedCode = String(own?.webhookTestExpectedReplyCode || "").trim();
  const expectedContextId = String(
    own?.webhookTestOutboundMessageId || "",
  ).trim();
  const reply = String(replyText || "").trim();
  const messageId = String(waMessageId || "").trim() || null;
  const inboundContextId = String(contextId || "").trim();

  if (!expectedCode && !expectedContextId) {
    await Shop.updateOne(
      { shop },
      {
        $set: {
          "whatsappSender.ownNumber.webhookTestStatus": "failed",
          "whatsappSender.ownNumber.webhookTestLastError":
            "Webhook test reference is missing. Send the live test again.",
          "whatsappSender.ownNumber.webhookTestLastErrorAt": now,
        },
      },
    ).catch(() => {});
    return { handled: true, matched: false };
  }

  const matchesCode =
    !!expectedCode && replyContainsWebhookCode(reply, expectedCode);
  const matchesContext =
    !!expectedContextId &&
    !!inboundContextId &&
    inboundContextId === expectedContextId;
  const strictContextForWebhookTest =
    String(process.env.BYON_WEBHOOK_TEST_REQUIRE_CONTEXT || "")
      .trim()
      .toLowerCase() === "true";
  const matchesFallbackPhoneOnly =
    !strictContextForWebhookTest &&
    !!fromE164 &&
    phonesMatch(targetPhone, fromE164) &&
    !!messageId;

  if (matchesCode || matchesContext || matchesFallbackPhoneOnly) {
    const testDelivered = isSuccessfulOutboundStatus(own?.testMessageStatus);
    const shouldComplete = testDelivered || !!own?.onboardingCompletedAt;
    const matchedBy = matchesCode
      ? "code"
      : matchesContext
        ? "context"
        : "phone_only";
    await Shop.updateOne(
      { shop },
      {
        $set: {
          "whatsappSender.ownNumber.webhookTestStatus": "received",
          "whatsappSender.ownNumber.webhookTestReplyReceivedAt": now,
          "whatsappSender.ownNumber.webhookTestReplyMessageId": messageId,
          "whatsappSender.ownNumber.webhookTestReplyText": reply.slice(0, 500),
          "whatsappSender.ownNumber.webhookTestLastError": null,
          "whatsappSender.ownNumber.webhookTestLastErrorAt": null,
          ...(shouldComplete
            ? { "whatsappSender.ownNumber.onboardingCompletedAt": now }
            : {}),
        },
      },
    ).catch(() => {});

    void logAudit({
      shop,
      actor: "merchant",
      action: "byon_webhook_test_received",
      meta: {
        fromE164: fromE164 || null,
        expectedReplyCode: expectedCode,
        waMessageId: messageId,
        contextId: inboundContextId || null,
        matchedBy,
      },
    });

    return { handled: true, matched: true };
  }

  await Shop.updateOne(
    { shop },
    {
      $set: {
        "whatsappSender.ownNumber.webhookTestLastError":
          "Reply was received but did not match the live test message. Reply directly on the live test WhatsApp message.",
        "whatsappSender.ownNumber.webhookTestLastErrorAt": now,
        "whatsappSender.ownNumber.webhookTestReplyMessageId": messageId,
        "whatsappSender.ownNumber.webhookTestReplyText": reply.slice(0, 500),
      },
    },
  ).catch(() => {});

  return { handled: true, matched: false };
}

async function setOptOut({ shopDomain, phoneE164, keyword, waMessageId }) {
  if (!shopDomain || !phoneE164) return;

  await BlockedContact.findOneAndUpdate(
    { shop: shopDomain, phoneE164 },
    { $set: { note: `opt_out:${String(keyword || "stop")}` } },
    { upsert: true, new: true },
  ).catch(() => null);

  void logAudit({
    shop: shopDomain,
    actor: "webhook",
    action: "wa_opt_out",
    meta: { phoneE164, keyword: String(keyword || "stop"), waMessageId },
  });
}

async function clearOptOut({ shopDomain, phoneE164, keyword, waMessageId }) {
  if (!shopDomain || !phoneE164) return;

  await BlockedContact.deleteOne({ shop: shopDomain, phoneE164 }).catch(
    () => null,
  );

  void logAudit({
    shop: shopDomain,
    actor: "webhook",
    action: "wa_opt_in",
    meta: { phoneE164, keyword: String(keyword || "start"), waMessageId },
  });
}

function shouldSendSupportInfoForOrderX({ attempt, receiverPhoneNumberId }) {
  const attemptSenderMode = String(attempt?.senderMode || "").trim();
  if (attemptSenderMode === SENDER_MODES.ORDERX_NUMBER) return true;
  if (attemptSenderMode === SENDER_MODES.OWN_NUMBER) return false;

  const inboundReceiverId = String(receiverPhoneNumberId || "").trim();
  const orderxPhoneId = String(process.env.WA_PHONE_NUMBER_ID || "").trim();
  if (!inboundReceiverId || !orderxPhoneId) return false;
  return inboundReceiverId === orderxPhoneId;
}

async function sendSupportInfo({
  toE164,
  shopDomain,
  attempt,
  receiverPhoneNumberId,
}) {
  if (!toE164 || !shopDomain) return;
  if (
    !shouldSendSupportInfoForOrderX({
      attempt,
      receiverPhoneNumberId,
    })
  ) {
    dbg("[wa_support_reply] skipped for own-number sender", {
      shopDomain,
      attemptId: attempt?._id?.toString?.() || null,
      receiverPhoneNumberId: String(receiverPhoneNumberId || ""),
      senderMode: String(attempt?.senderMode || ""),
    });
    return;
  }

  if (attempt?.supportInfoSentAt) {
    dbg("[wa_support_reply] already sent for order", {
      shop: attempt.shop,
      attemptId: attempt._id?.toString?.() || String(attempt._id),
      orderName: attempt.orderName || "",
    });
    return;
  }

  const shop = await Shop.findOne({ shop: shopDomain }).lean();
  const num = String(shop?.settings?.supportWhatsAppNumber || "").trim();
  if (!num) {
    console.warn("[wa_support_reply] missing support number", { shopDomain });
    return;
  }

  const storeLabel = String(shopDomain || "").replace(".myshopify.com", "");
  const text =
    `Thanks for your message. For any questions, please contact ` +
    `${storeLabel} support on WhatsApp: ${num}\n\n`;
  try {
    await sendWhatsAppText({
      to: toE164,
      text,
      shop: shopDomain,
      kind: "support_info",
      attemptId: attempt?._id || null,
      orderGid: attempt?.orderGid || null,
      meta: { source: "whatsapp_webhook" },
    });
    await incrementWhatsAppUsage(shopDomain, 1);
    if (attempt?._id) {
      await CodAttempt.updateOne(
        { _id: attempt._id },
        {
          $set: { supportInfoSentAt: new Date() },
          $inc: { supportInfoCount: 1 },
        },
      );
    }
  } catch (e) {
    console.error("[wa_support_reply]", shopDomain, e?.message || e);
  }
}

// Incoming messages / button replies (quick replies, lists)
router.post("/webhook", async (req, res) => {
  try {
    const signatureOk = verifyMetaSignature(req);
    if (!signatureOk) {
      if (shouldLogWebhookSignatureFailure()) {
        dbg("[wa_webhook] signature verification failed", {
          hasRawBody: !!req.rawBody,
          contentType: req.get("content-type") || "",
          hasSignatureHeader: !!req.get("X-Hub-Signature-256"),
        });
      }
      return res.status(401).json({ ok: false });
    }

    const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];
    const changeEvents = [];
    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const change of changes) {
        const value = change?.value || {};
        const receiverPhoneNumberId = String(
          value?.metadata?.phone_number_id || "",
        ).trim();
        changeEvents.push({ value, receiverPhoneNumberId });
      }
    }

    if (!changeEvents.length) return res.status(200).json({ ok: true });

    const receiverShopCache = new Map();
    const resolveReceiverMappedShopCached = async (phoneNumberId) => {
      const pid = String(phoneNumberId || "").trim();
      if (!pid) return "";
      if (receiverShopCache.has(pid)) return receiverShopCache.get(pid);
      const mapped = await resolveShopByReceiverPhoneNumberId(pid).catch(
        () => "",
      );
      receiverShopCache.set(pid, mapped);
      return mapped;
    };

    const statusEvents = [];
    const messageEvents = [];

    for (const { value, receiverPhoneNumberId } of changeEvents) {
      const messages = Array.isArray(value?.messages) ? value.messages : [];
      const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
      const contactProfiles = new Map(
        (Array.isArray(value?.contacts) ? value.contacts : []).map((contact) => [
          String(contact?.wa_id || "").trim(),
          String(contact?.profile?.name || "").trim().slice(0, 160),
        ]),
      );
      const receiverMappedShop = receiverPhoneNumberId
        ? await resolveReceiverMappedShopCached(receiverPhoneNumberId)
        : "";

      if (statuses.length) {
        for (const status of statuses) {
          statusEvents.push({
            status,
            receiverPhoneNumberId,
            receiverMappedShop,
          });
        }
      }

      if (messages.length) {
        for (const msg of messages) {
          messageEvents.push({
            msg,
            receiverPhoneNumberId,
            receiverMappedShop,
            whatsappProfileName:
              contactProfiles.get(String(msg?.from || "").trim()) || "",
          });
        }
      }
    }

    if (statusEvents.length) {
      for (const {
        status,
        receiverPhoneNumberId,
        receiverMappedShop,
      } of statusEvents) {
        const statusMessageId = String(status?.id || "").trim();
        const statusShop =
          receiverMappedShop ||
          (statusMessageId
            ? String(
                (
                  await WaMessageLog.findOne({
                    waMessageId: statusMessageId,
                  })
                    .select({ shop: 1 })
                    .lean()
                )?.shop || "",
              ).trim()
            : "");
        const attemptShop =
          !statusShop && statusMessageId
            ? String(
                (
                  await CodAttempt.findOne({
                    waMessageId: statusMessageId,
                  })
                    .sort({ createdAt: -1 })
                    .select({ shop: 1 })
                    .lean()
                )?.shop || "",
              ).trim()
            : "";
        const resolvedStatusShop = statusShop || attemptShop;
        if (!resolvedStatusShop) continue;
        await handleByonOutboundDeliveryStatus({
          shopDomain: resolvedStatusShop,
          receiverPhoneNumberId,
          status,
        }).catch(() => {});
      }
    }

    if (!messageEvents.length) return res.status(200).json({ ok: true });

    const singleSupportShop = await resolveSingleSupportShop().catch(() => "");
    for (const {
      msg,
      receiverPhoneNumberId,
      receiverMappedShop,
      whatsappProfileName,
    } of messageEvents) {
      const fromE164 = normalizeToE164FromWebhook(msg?.from);
      const contextId = extractContextId(msg);

      const replyId = extractReplyId(msg);
      const replyText = extractReplyText(msg);
      const replyNorm = normalizeText(replyText);
      let {
        action,
        attemptId,
        arg: actionArg,
      } = parseAction({ replyId, replyText });
      const attempt = await resolveAttempt({
        attemptId,
        contextId,
        fromE164,
        shopHint: receiverMappedShop,
        receiverPhoneNumberId,
        preferOpenAttempt: Boolean(action),
      });
      const senderMatch = await attemptMatchesInboundSender({
        attempt,
        receiverPhoneNumberId,
        fromE164,
      });
      if (attempt?._id && !senderMatch) {
        console.warn("[wa_reply_sender_mismatch]", {
          attemptId: String(attempt._id),
          shop: String(attempt.shop || ""),
          fromE164: String(fromE164 || ""),
          receiverPhoneNumberId: String(receiverPhoneNumberId || ""),
          attemptSenderPhoneNumberId: String(attempt.senderPhoneNumberId || ""),
        });
      }
      const phoneMatch =
        senderMatch && phonesMatch(attempt?.phoneE164, fromE164);
      if (!action && attempt?._id && phoneMatch) {
        const matchedButtonAction = await resolveAttemptTemplateButtonAction({
          attempt,
          replyText,
        });
        if (matchedButtonAction?.action) {
          action = matchedButtonAction.action;
          attemptId = matchedButtonAction.attemptId || attemptId;
          actionArg = matchedButtonAction.arg || actionArg;
        }
      }
      if (
        !action &&
        attempt?._id &&
        phoneMatch &&
        String(attempt.changeState || "") === "awaiting_details" &&
        String(attempt.changeKindPending || "") === "qty_item_select"
      ) {
        const qtyItemAction = parseQtyItemSelectionText(replyText);
        if (qtyItemAction?.action) {
          action = qtyItemAction.action;
          actionArg = qtyItemAction.arg || actionArg;
        }
      }
      const resolvedShop = phoneMatch ? String(attempt?.shop || "").trim() : "";
      const fallbackShop = String(singleSupportShop || "").trim();
      const shopForReply =
        String(receiverMappedShop || "").trim() ||
        resolvedShop ||
        fallbackShop ||
        "";
      const freeTextActionWithoutContext =
        Boolean(action) && !attemptId && !contextId;
      if (freeTextActionWithoutContext && fromE164) {
        const ambiguousReply = await hasAmbiguousOpenAttemptForInbound({
          fromE164,
          receiverPhoneNumberId,
          shopHint: receiverMappedShop,
        });
        if (ambiguousReply) {
          if (shopForReply) {
            try {
              await sendWhatsAppText({
                to: fromE164,
                text: "We found multiple active COD confirmations. Please tap a button on the exact order message you want to confirm or cancel.",
                shop: shopForReply,
                kind: "ambiguous_reply_prompt",
                meta: { source: "whatsapp_webhook" },
              });
              await incrementWhatsAppUsage(shopForReply, 1);
            } catch {
              // ignore
            }
          }
          continue;
        }
      }

      // Log inbound messages when we can resolve the shop safely.
      if (shopForReply) {
        const inboundSenderMode =
          receiverPhoneNumberId &&
          receiverMappedShop &&
          receiverMappedShop === shopForReply
            ? SENDER_MODES.OWN_NUMBER
            : SENDER_MODES.ORDERX_NUMBER;
        try {
          await upsertInboundMessageLog({
            shop: shopForReply,
            toE164: fromE164,
            text: buildInboundLogText(msg, replyText),
            waMessageId: msg?.id || null,
            senderMode: inboundSenderMode,
            senderPhoneNumberId: receiverPhoneNumberId || null,
            attemptId: senderMatch ? attempt?._id || null : null,
            orderGid: senderMatch ? attempt?.orderGid || null : null,
            meta: {
              contextId: contextId || null,
              replyId: replyId || null,
              type: msg?.type || null,
              receiverPhoneNumberId: receiverPhoneNumberId || null,
              waId: String(msg?.from || "").trim() || null,
              whatsappProfileName: whatsappProfileName || null,
              media: extractInboundMediaMeta(msg),
              contacts: extractInboundContactMeta(msg),
              ...(String(msg?.type || "").trim().toLowerCase() === "location"
                ? {
                    location: {
                      latitude: finiteNumberOrNull(msg?.location?.latitude),
                      longitude: finiteNumberOrNull(msg?.location?.longitude),
                      name: String(msg?.location?.name || "").trim() || null,
                      address:
                        String(msg?.location?.address || "").trim() || null,
                    },
                  }
                : {}),
            },
          });
        } catch {
          // ignore
        }
      }

      const webhookTest = shopForReply
        ? await maybeHandleByonWebhookReplyTest({
            shopDomain: shopForReply,
            fromE164,
            replyText,
            waMessageId: msg?.id || null,
            contextId,
          }).catch(() => ({ handled: false, matched: false }))
        : { handled: false, matched: false };
      if (webhookTest?.handled) {
        continue;
      }

      // STOP/START opt-out keywords (WhatsApp compliance).
      // Handle these before any confirm/cancel logic.
      if (
        fromE164 &&
        (isOptOutKeyword(replyNorm) || isOptInKeyword(replyNorm))
      ) {
        const keyword = replyNorm;
        if (!shopForReply) {
          console.warn("[wa_opt_out] unresolved shop for keyword", {
            fromE164,
            keyword,
            contextId: contextId || null,
          });
          continue;
        }

        if (isOptOutKeyword(replyNorm)) {
          await setOptOut({
            shopDomain: shopForReply,
            phoneE164: fromE164,
            keyword,
            waMessageId: msg?.id || null,
          });
          try {
            await sendWhatsAppText({
              to: fromE164,
              text: "You have been opted out from receiving WhatsApp updates. Reply START to opt back in.",
              shop: shopForReply,
              kind: "opt_out_ack",
              attemptId: attempt?._id || null,
              orderGid: attempt?.orderGid || null,
              meta: { source: "whatsapp_webhook" },
            });
            await incrementWhatsAppUsage(shopForReply, 1);
          } catch (e) {
            console.error("[wa_opt_out_ack]", shopForReply, e?.message || e);
          }
        } else {
          await clearOptOut({
            shopDomain: shopForReply,
            phoneE164: fromE164,
            keyword,
            waMessageId: msg?.id || null,
          });
          try {
            await sendWhatsAppText({
              to: fromE164,
              text: "You are opted back in. You can now receive WhatsApp updates again.",
              shop: shopForReply,
              kind: "opt_in_ack",
              attemptId: attempt?._id || null,
              orderGid: attempt?.orderGid || null,
              meta: { source: "whatsapp_webhook" },
            });
            await incrementWhatsAppUsage(shopForReply, 1);
          } catch (e) {
            console.error("[wa_opt_in_ack]", shopForReply, e?.message || e);
          }
        }

        continue;
      }

      const campaignButtonReply = await maybeHandleCampaignButtonReply({
        shop: shopForReply,
        fromE164,
        contextId,
        replyText,
        receiverPhoneNumberId,
      }).catch(() => ({ handled: false }));
      if (campaignButtonReply?.handled) {
        continue;
      }

      if (DEBUG) {
        dbg("[wa_reply]", {
          fromE164,
          replyId,
          replyText,
          action,
          actionArg: actionArg || null,
          attemptId: attemptId || null,
          contextId: contextId || null,
          attemptFound: Boolean(attempt?._id),
          senderMatch,
          phoneMatch,
        });
      }
      if (action === "confirm" && attempt?._id && phoneMatch) {
        const r = await confirmAttempt(
          attempt._id.toString(),
          "whatsapp_webhook",
        );
        if (!r?.alreadyDone) {
          // If the customer reached a change re-confirm stage, mark it as resolved.
          if (attempt.changeState === "reconfirm_sent") {
            try {
              const requests = Array.isArray(attempt.changeRequests)
                ? attempt.changeRequests
                : [];
              if (requests.length) {
                updateLastChangeRequest(requests, {
                  resolvedAt: new Date(),
                  resolution: "confirmed",
                });
                attempt.changeRequests = requests.slice(-20);
              }
              attempt.changeState = "none";
              await attempt.save();
            } catch {
              // ignore
            }
          }
          const storeLabel = String(attempt.shop || "").replace(
            ".myshopify.com",
            "",
          );
          const storeName =
            String(attempt.storeName || "").trim() || storeLabel;
          const orderNumber = attempt.orderName || "";
          try {
            await sendCodConfirmedTemplate({
              to: fromE164 || attempt.phoneE164,
              orderNumber,
              storeName,
              customerName: attempt.customerName || "",
              shop: attempt.shop,
              attemptId: attempt._id,
              orderGid: attempt.orderGid,
              meta: { source: "whatsapp_webhook" },
            });
            await incrementWhatsAppUsage(attempt.shop, 1);
          } catch (e) {
            console.error(
              "[wa_confirmed_template]",
              attempt.shop,
              e?.message || e,
            );
          }
          await releaseQueuesAfterAttemptResolved({
            sourceAttempt: attempt,
            fromE164: fromE164 || attempt.phoneE164,
            context: "whatsapp_webhook_confirm",
          });
        }
        continue;
      }
      if (action === "redeliver" && attempt?._id && phoneMatch) {
        const r = await confirmAttempt(
          attempt._id.toString(),
          "whatsapp_webhook_redeliver",
        );
        if (!r?.alreadyDone) {
          // If the customer reached a change re-confirm stage, mark it as resolved.
          if (attempt.changeState === "reconfirm_sent") {
            try {
              const requests = Array.isArray(attempt.changeRequests)
                ? attempt.changeRequests
                : [];
              if (requests.length) {
                updateLastChangeRequest(requests, {
                  resolvedAt: new Date(),
                  resolution: "confirmed",
                });
                attempt.changeRequests = requests.slice(-20);
              }
              attempt.changeState = "none";
              await attempt.save();
            } catch {
              // ignore
            }
          }
          const storeLabel = String(attempt.shop || "").replace(
            ".myshopify.com",
            "",
          );
          const storeName =
            String(attempt.storeName || "").trim() || storeLabel;
          const orderNumber = attempt.orderName || "";
          try {
            await sendCodConfirmedTemplate({
              to: fromE164 || attempt.phoneE164,
              orderNumber,
              storeName,
              customerName: attempt.customerName || "",
              shop: attempt.shop,
              attemptId: attempt._id,
              orderGid: attempt.orderGid,
              meta: { source: "whatsapp_webhook" },
            });
            await incrementWhatsAppUsage(attempt.shop, 1);
          } catch (e) {
            console.error(
              "[wa_redeliver_template]",
              attempt.shop,
              e?.message || e,
            );
          }
          await releaseQueuesAfterAttemptResolved({
            sourceAttempt: attempt,
            fromE164: fromE164 || attempt.phoneE164,
            context: "whatsapp_webhook_redeliver",
          });
        }
        continue;
      }

      if (action === "cancel" && attempt?._id && phoneMatch) {
        const r = await cancelAttempt(
          attempt._id.toString(),
          "whatsapp_webhook",
        );
        if (!r?.alreadyDone) {
          // If the customer reached a change re-confirm stage, mark it as resolved.
          if (attempt.changeState === "reconfirm_sent") {
            try {
              const requests = Array.isArray(attempt.changeRequests)
                ? attempt.changeRequests
                : [];
              if (requests.length) {
                updateLastChangeRequest(requests, {
                  resolvedAt: new Date(),
                  resolution: "cancelled",
                });
                attempt.changeRequests = requests.slice(-20);
              }
              attempt.changeState = "none";
              await attempt.save();
            } catch {
              // ignore
            }
          }
          try {
            await sendOrderCancelTemplate({
              to: fromE164 || attempt.phoneE164,
              orderNumber: attempt.orderName || "",
              storeName:
                String(attempt.storeName || "").trim() ||
                String(attempt.shop || "").replace(".myshopify.com", ""),
              customerName: attempt.customerName || "",
              shop: attempt.shop,
              attemptId: attempt._id,
              orderGid: attempt.orderGid,
              meta: { source: "whatsapp_webhook" },
            });
            await incrementWhatsAppUsage(attempt.shop, 1);
          } catch (e) {
            console.error(
              "[wa_cancel_template]",
              attempt.shop,
              e?.message || e,
            );
          }
          await releaseQueuesAfterAttemptResolved({
            sourceAttempt: attempt,
            fromE164: fromE164 || attempt.phoneE164,
            context: "whatsapp_webhook_cancel",
          });
        }
        continue;
      }

      const hasFreeText = Boolean(normalizeText(replyText));

      // Request Changes flow (cod_confirm_new third button, and the freeform loop).
      if (action === "request_changes" && attempt?._id && phoneMatch) {
        const status = String(attempt.status || "");
        if (["confirmed", "cancelled", "expired"].includes(status)) {
          continue;
        }

        const now = new Date();
        try {
          attempt.changeState = "choose_type";
          attempt.changeKindPending = null;
          attempt.changeQtyTargetLineIndex = null;
          attempt.changeQtyTargetProductLabel = null;
          attempt.changeRequestedAt = now;
          attempt.changeRequestCount =
            Number(attempt.changeRequestCount || 0) + 1;
          await attempt.save();
        } catch {
          // ignore
        }

        await safeAppendOrderTags(
          attempt.shop,
          attempt.orderGid,
          ["CHANGE_REQUESTED✏️"],
          "[wa_change_tag]",
        );

        try {
          await sendWhatsAppList({
            to: fromE164 || attempt.phoneE164,
            text: "Request changes: choose what you want to update below.",
            buttonText: "Options",
            rows: [
              {
                id: `change_address:${attempt._id.toString()}`,
                title: "Change address",
              },
              {
                id: `change_name:${attempt._id.toString()}`,
                title: "Change name",
              },
              {
                id: `change_qty:${attempt._id.toString()}`,
                title: "Change quantity",
              },
              {
                id: `back:${attempt._id.toString()}`,
                title: "Back",
                description: "Return to order confirmation",
              },
            ],
            shop: attempt.shop,
            kind: "change_choose_type",
            attemptId: attempt._id,
            orderGid: attempt.orderGid,
            meta: { source: "whatsapp_webhook" },
          });
          await incrementWhatsAppUsage(attempt.shop, 1);

          try {
            attempt.changePromptSentAt = now;
            await attempt.save();
          } catch {
            // ignore
          }
        } catch (e) {
          console.error(
            "[wa_change_choose_type]",
            attempt.shop,
            e?.message || e,
          );
        }

        continue;
      }

      if (action === "back" && attempt?._id && phoneMatch) {
        const status = String(attempt.status || "");
        if (["confirmed", "cancelled", "expired"].includes(status)) {
          continue;
        }

        // Reset any pending change capture so free text won't be misinterpreted.
        try {
          attempt.changeState = "none";
          attempt.changeKindPending = null;
          attempt.changeQtyTargetLineIndex = null;
          attempt.changeQtyTargetProductLabel = null;
          await attempt.save();
        } catch {
          // ignore
        }

        let customerName =
          attempt.changeProposedName || attempt.customerName || "Customer";
        let storeName =
          String(attempt.storeName || "").trim() ||
          String(attempt.shop || "").replace(".myshopify.com", "") ||
          "Store";
        let orderNumber = attempt.orderName || "";

        let productsText = attempt.orderName
          ? `Order: ${attempt.orderName}`
          : "—";
        let deliveryAddressText = "—";
        let amountText = formatAmountText(
          attempt.orderAmount,
          attempt.orderCurrency,
        );

        let fetchedOrder = null;
        try {
          const shopRecord = await Shop.findOne({ shop: attempt.shop }).lean();
          if (shopRecord && attempt.orderGid) {
            const admin = await getAdminClient(attempt.shop, {
              accessToken: shopRecord.accessToken || "",
              record: shopRecord,
            });
            const fetched = await fetchOrderForCodConfirmTemplate(
              admin,
              attempt.orderGid,
            );
            const order = fetched?.order || null;
            fetchedOrder = order;

            const shopName = String(fetched?.shopName || "").trim();
            if (shopName) storeName = shopName;

            if (order?.name) orderNumber = String(order.name || "").trim();
            const p = formatProductsText(order);
            if (p) productsText = p;

            const addrObj = { ...(order?.shippingAddress || {}) };
            if (attempt.changeProposedName)
              addrObj.name = attempt.changeProposedName;
            const addr = formatDeliveryAddressText(addrObj);
            if (addr) deliveryAddressText = addr;

            const totalAmount = order?.currentTotalPriceSet?.shopMoney?.amount;
            const totalCurrency =
              order?.currentTotalPriceSet?.shopMoney?.currencyCode;
            const amtFromOrder = formatAmountText(totalAmount, totalCurrency);
            if (amtFromOrder) amountText = amtFromOrder;
          }
        } catch (e) {
          console.error("[wa_back_fetch_order]", attempt.shop, e?.message || e);
        }

        if (attempt.changeProposedAddress) {
          deliveryAddressText = attempt.changeProposedAddress;
        }

        if (attempt.changeProposedAmountText) {
          amountText = attempt.changeProposedAmountText;
        }

        // Reflect any proposed quantity edits (supports multiple item overrides).
        const qtyOverrides = normalizeQtyOverrides(
          attempt.changeProposedQuantityOverrides,
        );
        if (fetchedOrder && qtyOverrides.length) {
          const p = buildProductsTextWithQtyOverride(
            fetchedOrder,
            null,
            null,
            qtyOverrides,
          );
          if (p) productsText = p;
        } else if (
          Number.isFinite(Number(attempt.changeProposedQuantity)) &&
          fetchedOrder
        ) {
          const q = Math.trunc(Number(attempt.changeProposedQuantity));
          const proposedIdx = Number(attempt.changeProposedQuantityLineIndex);
          const items = getOrderLineItems(fetchedOrder);
          const hasValidIdx =
            Number.isFinite(proposedIdx) &&
            proposedIdx >= 0 &&
            proposedIdx < items.length;
          if (items.length === 1 || hasValidIdx) {
            const targetIdx = hasValidIdx ? proposedIdx : 0;
            const p = buildProductsTextWithQtyOverride(
              fetchedOrder,
              targetIdx,
              q,
            );
            if (p) productsText = p;
          }
        }

        try {
          const sent = await sendCodConfirmTemplate({
            to: fromE164 || attempt.phoneE164,
            customerName,
            storeName,
            orderNumber,
            productsText,
            productImageUrl: firstProductImageUrl(fetchedOrder),
            amountText,
            deliveryAddressText,
            confirmPayload: `confirm:${attempt._id.toString()}`,
            cancelPayload: `cancel:${attempt._id.toString()}`,
            shop: attempt.shop,
            kind: "back_to_confirm",
            attemptId: attempt._id,
            orderGid: attempt.orderGid,
            meta: { source: "whatsapp_webhook" },
          });
          await incrementWhatsAppUsage(attempt.shop, 1);
          try {
            attempt.waTemplateUsed =
              sent?.templateUsed || attempt.waTemplateUsed || null;
            await attempt.save();
          } catch {
            // ignore
          }
        } catch (e) {
          console.error("[wa_back_to_confirm]", attempt.shop, e?.message || e);
        }

        continue;
      }

      if (action === "change_address" && attempt?._id && phoneMatch) {
        const status = String(attempt.status || "");
        if (["confirmed", "cancelled", "expired"].includes(status)) {
          continue;
        }

        const now = new Date();
        try {
          attempt.changeState = "awaiting_details";
          attempt.changeKindPending = "address";
          attempt.changeQtyTargetLineIndex = null;
          attempt.changeQtyTargetProductLabel = null;
          attempt.changePromptSentAt = now;
          await attempt.save();
        } catch {
          // ignore
        }

        await safeAppendOrderTags(
          attempt.shop,
          attempt.orderGid,
          ["CHANGE_REQUESTED✏️"],
          "[wa_change_tag]",
        );

        try {
          await sendWhatsAppButtons({
            to: fromE164 || attempt.phoneE164,
            text: "Please reply with the full updated delivery address in one single message. Tap Back to return to the order.",
            buttons: [{ id: `back:${attempt._id.toString()}`, title: "Back" }],
            shop: attempt.shop,
            kind: "change_prompt_address",
            attemptId: attempt._id,
            orderGid: attempt.orderGid,
            meta: { source: "whatsapp_webhook" },
          });
          await incrementWhatsAppUsage(attempt.shop, 1);
        } catch (e) {
          console.error(
            "[wa_change_prompt_address]",
            attempt.shop,
            e?.message || e,
          );
        }

        continue;
      }

      if (action === "change_name" && attempt?._id && phoneMatch) {
        const status = String(attempt.status || "");
        if (["confirmed", "cancelled", "expired"].includes(status)) {
          continue;
        }

        const now = new Date();
        try {
          attempt.changeState = "awaiting_details";
          attempt.changeKindPending = "name";
          attempt.changeQtyTargetLineIndex = null;
          attempt.changeQtyTargetProductLabel = null;
          attempt.changePromptSentAt = now;
          await attempt.save();
        } catch {
          // ignore
        }

        await safeAppendOrderTags(
          attempt.shop,
          attempt.orderGid,
          ["CHANGE_REQUESTED✏️"],
          "[wa_change_tag]",
        );

        try {
          await sendWhatsAppButtons({
            to: fromE164 || attempt.phoneE164,
            text: "Please reply with the updated name in one single message. Tap Back to return to the order.",
            buttons: [{ id: `back:${attempt._id.toString()}`, title: "Back" }],
            shop: attempt.shop,
            kind: "change_prompt_name",
            attemptId: attempt._id,
            orderGid: attempt.orderGid,
            meta: { source: "whatsapp_webhook" },
          });
          await incrementWhatsAppUsage(attempt.shop, 1);
        } catch (e) {
          console.error(
            "[wa_change_prompt_name]",
            attempt.shop,
            e?.message || e,
          );
        }

        continue;
      }

      if (action === "change_qty" && attempt?._id && phoneMatch) {
        const status = String(attempt.status || "");
        if (["confirmed", "cancelled", "expired"].includes(status)) {
          continue;
        }

        const now = new Date();
        await safeAppendOrderTags(
          attempt.shop,
          attempt.orderGid,
          ["QUANTITY_CHANGE_REQUESTED🔢"],
          "[wa_change_tag]",
        );

        let fetchedOrder = null;
        try {
          const shopRecord = await Shop.findOne({ shop: attempt.shop }).lean();
          if (shopRecord && attempt.orderGid) {
            const admin = await getAdminClient(attempt.shop, {
              accessToken: shopRecord.accessToken || "",
              record: shopRecord,
            });
            const fetched = await fetchOrderForCodConfirmTemplate(
              admin,
              attempt.orderGid,
            );
            fetchedOrder = fetched?.order || null;
          }
        } catch (e) {
          console.error(
            "[wa_change_qty_fetch_order]",
            attempt.shop,
            e?.message || e,
          );
        }

        if (!fetchedOrder) {
          try {
            attempt.changeState = "choose_type";
            attempt.changeKindPending = null;
            attempt.changeQtyTargetLineIndex = null;
            attempt.changeQtyTargetProductLabel = null;
            attempt.changePromptSentAt = now;
            await attempt.save();
          } catch {
            // ignore
          }

          try {
            await sendWhatsAppList({
              to: fromE164 || attempt.phoneE164,
              text: "Sorry, we couldn't load your order details right now. Please try again or choose another change below.",
              buttonText: "Options",
              rows: [
                {
                  id: `change_address:${attempt._id.toString()}`,
                  title: "Change address",
                },
                {
                  id: `change_name:${attempt._id.toString()}`,
                  title: "Change name",
                },
                {
                  id: `change_qty:${attempt._id.toString()}`,
                  title: "Change quantity",
                },
                {
                  id: `back:${attempt._id.toString()}`,
                  title: "Back",
                  description: "Return to order confirmation",
                },
              ],
              shop: attempt.shop,
              kind: "change_qty_fetch_failed",
              attemptId: attempt._id,
              orderGid: attempt.orderGid,
              meta: { source: "whatsapp_webhook" },
            });
            await incrementWhatsAppUsage(attempt.shop, 1);
          } catch (e) {
            console.error(
              "[wa_change_qty_fetch_failed]",
              attempt.shop,
              e?.message || e,
            );
          }
          continue;
        }

        const lineItems = getOrderLineItems(fetchedOrder);
        if (!lineItems.length) {
          try {
            await sendWhatsAppText({
              to: fromE164 || attempt.phoneE164,
              text: "Sorry, we couldn't find items in this order. Please contact support.",
              shop: attempt.shop,
              kind: "change_qty_no_items",
              attemptId: attempt._id,
              orderGid: attempt.orderGid,
              meta: { source: "whatsapp_webhook" },
            });
            await incrementWhatsAppUsage(attempt.shop, 1);
          } catch {
            // ignore
          }
          continue;
        }

        if (lineItems.length === 1) {
          try {
            attempt.changeState = "awaiting_details";
            attempt.changeKindPending = "qty";
            attempt.changeQtyTargetLineIndex = 0;
            attempt.changeQtyTargetProductLabel =
              formatLineItemLabel(lineItems[0]) || null;
            attempt.changePromptSentAt = now;
            await attempt.save();
          } catch {
            // ignore
          }

          try {
            await sendWhatsAppButtons({
              to: fromE164 || attempt.phoneE164,
              text: "Please reply with the updated quantity (digits only). Example: 2. Tap Back to return to the order.",
              buttons: [
                { id: `back:${attempt._id.toString()}`, title: "Back" },
              ],
              shop: attempt.shop,
              kind: "change_prompt_qty",
              attemptId: attempt._id,
              orderGid: attempt.orderGid,
              meta: { source: "whatsapp_webhook" },
            });
            await incrementWhatsAppUsage(attempt.shop, 1);
          } catch (e) {
            console.error(
              "[wa_change_prompt_qty]",
              attempt.shop,
              e?.message || e,
            );
          }

          continue;
        }

        try {
          attempt.changeState = "awaiting_details";
          attempt.changeKindPending = "qty_item_select";
          attempt.changeQtyTargetLineIndex = null;
          attempt.changeQtyTargetProductLabel = null;
          attempt.changePromptSentAt = now;
          await attempt.save();
        } catch {
          // ignore
        }

        try {
          const rows = buildQtySelectionRows(
            fetchedOrder,
            attempt._id.toString(),
            attempt.changeProposedQuantityOverrides,
          );
          const truncated = lineItems.length > 9;
          await sendWhatsAppList({
            to: fromE164 || attempt.phoneE164,
            text: truncated
              ? "Choose the product whose quantity you want to change. (Showing first 9 items only.)"
              : "Choose the product whose quantity you want to change.",
            buttonText: "Select item",
            rows,
            shop: attempt.shop,
            kind: "change_qty_select_item",
            attemptId: attempt._id,
            orderGid: attempt.orderGid,
            meta: { source: "whatsapp_webhook" },
          });
          await incrementWhatsAppUsage(attempt.shop, 1);
        } catch (e) {
          console.error(
            "[wa_change_qty_select_item]",
            attempt.shop,
            e?.message || e,
          );
        }

        continue;
      }

      if (action === "change_qty_item" && attempt?._id && phoneMatch) {
        const status = String(attempt.status || "");
        if (["confirmed", "cancelled", "expired"].includes(status)) {
          continue;
        }

        const targetIndex = Number(actionArg);
        if (!Number.isFinite(targetIndex) || targetIndex < 0) {
          continue;
        }

        let fetchedOrder = null;
        try {
          const shopRecord = await Shop.findOne({ shop: attempt.shop }).lean();
          if (shopRecord && attempt.orderGid) {
            const admin = await getAdminClient(attempt.shop, {
              accessToken: shopRecord.accessToken || "",
              record: shopRecord,
            });
            const fetched = await fetchOrderForCodConfirmTemplate(
              admin,
              attempt.orderGid,
            );
            fetchedOrder = fetched?.order || null;
          }
        } catch (e) {
          console.error(
            "[wa_change_qty_item_fetch]",
            attempt.shop,
            e?.message || e,
          );
        }

        const items = getOrderLineItems(fetchedOrder);
        const li = items[targetIndex] || null;
        if (!li) {
          try {
            await sendWhatsAppText({
              to: fromE164 || attempt.phoneE164,
              text: "That item selection is no longer available. Please choose quantity change again.",
              shop: attempt.shop,
              kind: "change_qty_item_invalid",
              attemptId: attempt._id,
              orderGid: attempt.orderGid,
              meta: { source: "whatsapp_webhook" },
            });
            await incrementWhatsAppUsage(attempt.shop, 1);
          } catch {
            // ignore
          }
          continue;
        }

        const label = formatLineItemLabel(li) || `Item ${targetIndex + 1}`;
        const existingQtyOverrides = normalizeQtyOverrides(
          attempt.changeProposedQuantityOverrides,
        );
        const overrideCurrentQty = Number(
          makeQtyOverrideMap(existingQtyOverrides).get(Math.trunc(targetIndex))
            ?.quantity,
        );
        const currentQty = Number.isFinite(overrideCurrentQty)
          ? overrideCurrentQty
          : Number(li?.quantity || 0);

        try {
          attempt.changeState = "awaiting_details";
          attempt.changeKindPending = "qty";
          attempt.changeQtyTargetLineIndex = Math.trunc(targetIndex);
          attempt.changeQtyTargetProductLabel = label;
          attempt.changePromptSentAt = new Date();
          await attempt.save();
        } catch {
          // ignore
        }

        try {
          await sendWhatsAppButtons({
            to: fromE164 || attempt.phoneE164,
            text: `Selected: ${label} (current qty: ${Number.isFinite(currentQty) ? Math.trunc(currentQty) : "—"}).\n\nReply with the new quantity (digits only). Example: 2\nTap Back to return to the order.`,
            buttons: [{ id: `back:${attempt._id.toString()}`, title: "Back" }],
            shop: attempt.shop,
            kind: "change_prompt_qty_selected_item",
            attemptId: attempt._id,
            orderGid: attempt.orderGid,
            meta: {
              source: "whatsapp_webhook",
              lineIndex: Math.trunc(targetIndex),
              product: label,
            },
          });
          await incrementWhatsAppUsage(attempt.shop, 1);
        } catch (e) {
          console.error(
            "[wa_change_prompt_qty_item]",
            attempt.shop,
            e?.message || e,
          );
        }

        continue;
      }

      if (action === "change_items" && attempt?._id && phoneMatch) {
        const status = String(attempt.status || "");
        if (["confirmed", "cancelled", "expired"].includes(status)) {
          continue;
        }

        try {
          attempt.changeState = "choose_type";
          attempt.changeKindPending = null;
          await attempt.save();
        } catch {
          // ignore
        }

        try {
          await sendWhatsAppList({
            to: fromE164 || attempt.phoneE164,
            text: "Item changes are not supported yet. Choose what you want to update below.",
            buttonText: "Options",
            rows: [
              {
                id: `change_address:${attempt._id.toString()}`,
                title: "Change address",
              },
              {
                id: `change_name:${attempt._id.toString()}`,
                title: "Change name",
              },
              {
                id: `change_qty:${attempt._id.toString()}`,
                title: "Change quantity",
              },
              {
                id: `back:${attempt._id.toString()}`,
                title: "Back",
                description: "Return to order confirmation",
              },
            ],
            shop: attempt.shop,
            kind: "change_items_not_supported",
            attemptId: attempt._id,
            orderGid: attempt.orderGid,
            meta: { source: "whatsapp_webhook" },
          });
          await incrementWhatsAppUsage(attempt.shop, 1);
        } catch (e) {
          console.error(
            "[wa_change_items_not_supported]",
            attempt.shop,
            e?.message || e,
          );
        }

        continue;
      }

      // If the customer is replying with change details, capture the next free-text message
      // and send a freeform re-confirm message with buttons (within the 24h window).
      if (attempt?._id && phoneMatch && hasFreeText) {
        const state = String(attempt.changeState || "none");
        const pendingKind = String(attempt.changeKindPending || "");
        if (
          state === "awaiting_details" &&
          (pendingKind === "address" ||
            pendingKind === "name" ||
            pendingKind === "qty" ||
            pendingKind === "qty_item_select")
        ) {
          const now = new Date();
          const details = String(replyText || "").trim();

          const kind = pendingKind;
          if (kind === "qty_item_select") {
            try {
              await sendWhatsAppText({
                to: fromE164 || attempt.phoneE164,
                text: "Please select the product from the list first, then enter the new quantity.",
                shop: attempt.shop,
                kind: "change_qty_select_item_reminder",
                attemptId: attempt._id,
                orderGid: attempt.orderGid,
                meta: { source: "whatsapp_webhook" },
              });
              await incrementWhatsAppUsage(attempt.shop, 1);
            } catch {
              // ignore
            }
            continue;
          }
          if (!details) {
            try {
              await sendWhatsAppText({
                to: fromE164 || attempt.phoneE164,
                text: "Please reply with the updated details in one single message.",
                shop: attempt.shop,
                kind: "change_prompt_retry",
                attemptId: attempt._id,
                orderGid: attempt.orderGid,
                meta: { source: "whatsapp_webhook", changeKind: kind },
              });
              await incrementWhatsAppUsage(attempt.shop, 1);
            } catch {
              // ignore
            }
            continue;
          }

          let customerName = attempt.customerName || "Customer";
          let storeName =
            String(attempt.storeName || "").trim() ||
            String(attempt.shop || "").replace(".myshopify.com", "") ||
            "Store";
          let orderNumber = attempt.orderName || "";

          let productsText = attempt.orderName
            ? `Order: ${attempt.orderName}`
            : "—";
          let deliveryAddressText = "—";
          let amountText = formatAmountText(
            attempt.orderAmount,
            attempt.orderCurrency,
          );
          let qtyProductLabel = "";

          let fetchedOrder = null;
          try {
            const shopRecord = await Shop.findOne({
              shop: attempt.shop,
            }).lean();
            if (shopRecord && attempt.orderGid) {
              const admin = await getAdminClient(attempt.shop, {
                accessToken: shopRecord.accessToken || "",
                record: shopRecord,
              });
              const fetched = await fetchOrderForCodConfirmTemplate(
                admin,
                attempt.orderGid,
              );
              const order = fetched?.order || null;
              fetchedOrder = order;

              const shopName = String(fetched?.shopName || "").trim();
              if (shopName) storeName = shopName;

              if (order?.name) orderNumber = String(order.name || "").trim();
              const p = formatProductsText(order);
              if (p) productsText = p;
              const addr = formatDeliveryAddressText(order?.shippingAddress);
              if (addr) deliveryAddressText = addr;

              const totalAmount =
                order?.currentTotalPriceSet?.shopMoney?.amount;
              const totalCurrency =
                order?.currentTotalPriceSet?.shopMoney?.currencyCode;
              const amtFromOrder = formatAmountText(totalAmount, totalCurrency);
              if (amtFromOrder) amountText = amtFromOrder;
              qtyProductLabel = formatSingleLineItemLabel(order);
            }
          } catch (e) {
            console.error(
              "[wa_change_fetch_order]",
              attempt.shop,
              e?.message || e,
            );
          }

          // Persist proposed details on the attempt (and compute amount when qty changes).
          if (kind === "address") {
            attempt.changeProposedAddress = details;
          } else if (kind === "name") {
            attempt.changeProposedName = details;
          } else if (kind === "qty") {
            const digitsOnly = String(details).trim();
            if (!/^[0-9]+$/.test(digitsOnly)) {
              try {
                await sendQtyInvalidPromptWithBack({
                  attempt,
                  to: fromE164 || attempt.phoneE164,
                  kind: "change_qty_invalid",
                });
              } catch {
                // ignore
              }
              continue;
            }

            const newQty = Number(digitsOnly);
            if (!Number.isFinite(newQty) || newQty <= 0 || newQty > 999) {
              try {
                await sendQtyInvalidPromptWithBack({
                  attempt,
                  to: fromE164 || attempt.phoneE164,
                  kind: "change_qty_invalid",
                  meta: { reason: "out_of_range" },
                });
              } catch {
                // ignore
              }
              continue;
            }

            if (!fetchedOrder) {
              try {
                attempt.changeState = "choose_type";
                attempt.changeKindPending = null;
                await attempt.save();
              } catch {
                // ignore
              }

              try {
                await sendWhatsAppList({
                  to: fromE164 || attempt.phoneE164,
                  text: "Sorry, we couldn't load your order details right now. Please try again or choose another change below.",
                  buttonText: "Options",
                  rows: [
                    {
                      id: `change_address:${attempt._id.toString()}`,
                      title: "Change address",
                    },
                    {
                      id: `change_name:${attempt._id.toString()}`,
                      title: "Change name",
                    },
                    {
                      id: `change_qty:${attempt._id.toString()}`,
                      title: "Change quantity",
                    },
                    {
                      id: `back:${attempt._id.toString()}`,
                      title: "Back",
                      description: "Return to order confirmation",
                    },
                  ],
                  shop: attempt.shop,
                  kind: "change_qty_fetch_failed",
                  attemptId: attempt._id,
                  orderGid: attempt.orderGid,
                  meta: { source: "whatsapp_webhook" },
                });
                await incrementWhatsAppUsage(attempt.shop, 1);
              } catch (e) {
                console.error(
                  "[wa_change_qty_fetch_failed]",
                  attempt.shop,
                  e?.message || e,
                );
              }
              continue;
            }

            const items = getOrderLineItems(fetchedOrder);
            const existingQtyOverrides = normalizeQtyOverrides(
              attempt.changeProposedQuantityOverrides,
            );
            const pendingIdxRaw = Number(attempt.changeQtyTargetLineIndex);
            const hasPendingIdx =
              Number.isFinite(pendingIdxRaw) &&
              pendingIdxRaw >= 0 &&
              pendingIdxRaw < items.length;
            const targetLineIndex =
              items.length === 1
                ? 0
                : hasPendingIdx
                  ? Math.trunc(pendingIdxRaw)
                  : null;

            if (targetLineIndex === null) {
              try {
                attempt.changeState = "awaiting_details";
                attempt.changeKindPending = "qty_item_select";
                attempt.changePromptSentAt = now;
                await attempt.save();
              } catch {
                // ignore
              }

              try {
                const rows = buildQtySelectionRows(
                  fetchedOrder,
                  attempt._id.toString(),
                  existingQtyOverrides,
                );
                const truncated = items.length > 9;
                await sendWhatsAppList({
                  to: fromE164 || attempt.phoneE164,
                  text: truncated
                    ? "Choose the product whose quantity you want to change. (Showing first 9 items only.)"
                    : "Choose the product whose quantity you want to change.",
                  buttonText: "Select item",
                  rows,
                  shop: attempt.shop,
                  kind: "change_qty_select_item",
                  attemptId: attempt._id,
                  orderGid: attempt.orderGid,
                  meta: {
                    source: "whatsapp_webhook",
                    reason: "missing_target",
                  },
                });
                await incrementWhatsAppUsage(attempt.shop, 1);
              } catch (e) {
                console.error(
                  "[wa_change_qty_select_item_missing_target]",
                  attempt.shop,
                  e?.message || e,
                );
              }
              continue;
            }

            const targetLi = items[targetLineIndex] || null;
            qtyProductLabel =
              formatLineItemLabel(targetLi) ||
              String(attempt.changeQtyTargetProductLabel || "").trim() ||
              qtyProductLabel;

            const calc = computeQtyChangeTotal(
              fetchedOrder,
              targetLineIndex,
              newQty,
              attempt.orderCurrency,
              existingQtyOverrides,
            );

            if (!calc?.ok) {
              try {
                await sendQtyInvalidPromptWithBack({
                  attempt,
                  to: fromE164 || attempt.phoneE164,
                  kind: "change_qty_calc_failed",
                  meta: { reason: calc?.reason || "unknown" },
                });
              } catch {
                // ignore
              }
              continue;
            }

            const computedAmountText = calc.amountText || null;
            const nextQtyOverrides = upsertQtyOverride(existingQtyOverrides, {
              lineIndex: targetLineIndex,
              quantity: Math.trunc(newQty),
              productLabel: qtyProductLabel || null,
            });

            attempt.changeProposedQuantity = Math.trunc(newQty);
            attempt.changeProposedQuantityLineIndex = targetLineIndex;
            attempt.changeProposedQuantityProductLabel =
              qtyProductLabel || null;
            attempt.changeProposedQuantityOverrides = nextQtyOverrides;
            attempt.changeProposedAmountText = computedAmountText;

            const nextProductsText = buildProductsTextWithQtyOverride(
              fetchedOrder,
              targetLineIndex,
              Math.trunc(newQty),
              existingQtyOverrides,
            );
            if (nextProductsText) productsText = nextProductsText;
            if (computedAmountText) amountText = computedAmountText;
          }

          // Always prefer proposed values when building the reconfirm message.
          if (attempt.changeProposedName) {
            customerName = attempt.changeProposedName;
          }

          if (attempt.changeProposedAddress) {
            deliveryAddressText = attempt.changeProposedAddress;
          } else if (fetchedOrder?.shippingAddress) {
            const addrObj = { ...(fetchedOrder.shippingAddress || {}) };
            if (attempt.changeProposedName)
              addrObj.name = attempt.changeProposedName;
            const addr = formatDeliveryAddressText(addrObj);
            if (addr) deliveryAddressText = addr;
          }

          if (attempt.changeProposedAmountText) {
            amountText = attempt.changeProposedAmountText;
          }

          const proposedQtyOverrides = normalizeQtyOverrides(
            attempt.changeProposedQuantityOverrides,
          );
          if (fetchedOrder && proposedQtyOverrides.length) {
            const p = buildProductsTextWithQtyOverride(
              fetchedOrder,
              null,
              null,
              proposedQtyOverrides,
            );
            if (p) productsText = p;
          }

          // Replace noisy change tags with summary tags containing the latest requested edits.
          await safeUpsertCodChangeSummaryTags(attempt.shop, attempt.orderGid, {
            name: attempt.changeProposedName,
            address: attempt.changeProposedAddress,
            quantity: attempt.changeProposedQuantity,
            quantityProductLabel:
              attempt.changeProposedQuantityProductLabel || qtyProductLabel,
            quantityOverrides: attempt.changeProposedQuantityOverrides,
            amountText: attempt.changeProposedAmountText,
          });

          // Persist the change details even if the reconfirm send fails.
          try {
            const requests = Array.isArray(attempt.changeRequests)
              ? attempt.changeRequests
              : [];
            requests.push({
              at: now,
              kind,
              text: details,
            });
            attempt.changeRequests = requests.slice(-20);
            attempt.changeDetailsReceivedAt = now;
            await attempt.save();
          } catch {
            // ignore
          }

          try {
            const sent = await sendCodConfirmTemplate({
              to: fromE164 || attempt.phoneE164,
              customerName,
              storeName,
              orderNumber,
              productsText,
              productImageUrl: firstProductImageUrl(fetchedOrder),
              amountText,
              deliveryAddressText,
              confirmPayload: `confirm:${attempt._id.toString()}`,
              cancelPayload: `cancel:${attempt._id.toString()}`,
              shop: attempt.shop,
              kind: "change_reconfirm",
              attemptId: attempt._id,
              orderGid: attempt.orderGid,
              meta: { source: "whatsapp_webhook", changeKind: kind },
            });
            await incrementWhatsAppUsage(attempt.shop, 1);

            try {
              const msgId = sent?.data?.messages?.[0]?.id || null;
              const requests = Array.isArray(attempt.changeRequests)
                ? attempt.changeRequests
                : [];
              if (requests.length) {
                updateLastChangeRequest(requests, {
                  reconfirmSentAt: now,
                  reconfirmWaMessageId: msgId,
                });
                attempt.changeRequests = requests.slice(-20);
              }
              attempt.changeReconfirmSentAt = now;
              attempt.changeReconfirmWaMessageId = msgId;
              attempt.changeState = "reconfirm_sent";
              attempt.changeKindPending = null;
              attempt.changeQtyTargetLineIndex = null;
              attempt.changeQtyTargetProductLabel = null;
              attempt.waTemplateUsed =
                sent?.templateUsed || attempt.waTemplateUsed || null;
              await attempt.save();
            } catch {
              // ignore
            }
          } catch (e) {
            console.error(
              "[wa_change_reconfirm]",
              attempt.shop,
              e?.message || e,
            );
          }

          continue;
        }

        // Backward-compat: older messages may still contain "change_items" flows.
        // Guide the customer to the supported address-only change flow.
        if (state === "awaiting_details" && pendingKind === "items") {
          try {
            attempt.changeState = "choose_type";
            attempt.changeKindPending = null;
            await attempt.save();
          } catch {
            // ignore
          }

          try {
            await sendWhatsAppList({
              to: fromE164 || attempt.phoneE164,
              text: "Item changes are not supported yet. Choose what you want to update below.",
              buttonText: "Options",
              rows: [
                {
                  id: `change_address:${attempt._id.toString()}`,
                  title: "Change address",
                },
                {
                  id: `change_name:${attempt._id.toString()}`,
                  title: "Change name",
                },
                {
                  id: `change_qty:${attempt._id.toString()}`,
                  title: "Change quantity",
                },
                {
                  id: `back:${attempt._id.toString()}`,
                  title: "Back",
                  description: "Return to order confirmation",
                },
              ],
              shop: attempt.shop,
              kind: "change_items_not_supported",
              attemptId: attempt._id,
              orderGid: attempt.orderGid,
              meta: { source: "whatsapp_webhook" },
            });
            await incrementWhatsAppUsage(attempt.shop, 1);
          } catch (e) {
            console.error(
              "[wa_change_items_not_supported]",
              attempt.shop,
              e?.message || e,
            );
          }

          continue;
        }
      }

      // Anything else: share store support number.
      // If attempt lookup fails, fallback to single-shop mode only (safe default).
      if (hasFreeText) {
        const supportShop = String(
          senderMatch
            ? attempt?.shop || singleSupportShop || ""
            : singleSupportShop || "",
        );
        if (supportShop) {
          await sendSupportInfo({
            toE164: fromE164,
            shopDomain: supportShop,
            attempt,
            receiverPhoneNumberId,
          });
        } else {
          console.warn(
            "[wa_support_reply] unresolved shop for free-text reply",
            {
              fromE164,
              contextId: contextId || null,
            },
          );
        }
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    // Always 200 so Meta doesn't retry aggressively
    return res.status(200).json({ ok: true });
  }
});

export default router;
