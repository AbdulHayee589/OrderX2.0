import BlockedContact from "../models/BlockedContact.js";
import WaMessageLog from "../models/WaMessageLog.js";
import AgentSendReceipt from "../models/AgentSendReceipt.js";
import Shop from "../models/Shop.js";
import {
  listConversationMessages,
  listConversationThreads,
} from "./messageInbox.js";
import { canSendWhatsApp, incrementWhatsAppUsage } from "./usage.js";
import {
  isAgentBillingTestShop,
  requireAgentFeatureAccess,
} from "./agentAccess.js";
import {
  getWhatsAppMessageAcceptance,
  resolveRuntimeConfig,
  sendManagedTemplateDirect,
  sendWhatsAppMedia,
  sendWhatsAppText,
} from "./whatsapp.js";
import { buildAgentReplyState } from "./agentReplyPolicy.js";
import { logAudit } from "./audit.js";
import { requireAgentPermission } from "./agentPermissions.js";
import {
  getTeamInboxContext,
  listTeamInboxNotes,
  requireTeamInboxThread,
  resolveTeamInboxDisplayName,
  teamInboxThreadReference,
} from "./teamInbox.js";
import { publishTeamInboxEvent } from "./teamInboxRealtime.js";
import { createAgentMediaPath } from "./agentMediaTokens.js";
import {
  getTeamInboxTemplateVariableKeys,
  sanitizeTeamInboxTemplateVariables,
} from "./teamInboxTemplateVariables.js";

function asText(value) {
  return String(value || "").trim();
}

function normalizeThreadKey(value) {
  const raw = asText(value);
  if (!raw) return "";
  if (raw.startsWith("+")) return raw;
  return /^\d+$/.test(raw) ? `+${raw}` : raw;
}

function normalizeMeta(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function normalizeAgentActor(actor = {}) {
  return {
    id: asText(actor?.id) || null,
    username: asText(actor?.username) || "agent",
  };
}

export function isAgentTemplateApproved(template = {}) {
  return [template?.status, template?.rawStatus].some(
    (value) => asText(value).toLowerCase() === "approved",
  );
}

export function getMissingAgentTemplateVariables(template = {}, context = {}) {
  return getTeamInboxTemplateVariableKeys(template).filter(
    (key) => !asText(context[key]),
  );
}

function buildAgentTemplateContext({ shop, contextData, shopRecord }) {
  const order = contextData?.order || null;
  const items = Array.isArray(order?.items) ? order.items : [];
  const address = order?.shippingAddress || {};
  const tracking = order?.tracking?.[0] || {};
  return {
    customer_name: contextData?.thread?.displayName || "",
    store_name: asText(shop).replace(/\.myshopify\.com$/i, ""),
    order_number: order?.name || "",
    product_name: items[0]?.title || "",
    product_list: items
      .map((item) => `${Number(item?.quantity || 0)}x ${asText(item?.title)}`)
      .filter(Boolean)
      .join(", "),
    product_url: items[0]?.productUrl || "",
    total_price: order
      ? `${order.currencyCode || ""} ${order.amount ?? ""}`.trim()
      : "",
    delivery_address: Object.values(address).filter(Boolean).join(", "),
    courier_name: tracking.company || "",
    tracking_number: tracking.number || "",
    tracking_url: tracking.url || "",
    support_whatsapp_number:
      shopRecord?.settings?.supportWhatsAppNumber || "",
    review_url: shopRecord?.settings?.reviewRequestUrl || "",
  };
}

function sanitizeMedia(meta, messageId) {
  const media = normalizeMeta(meta?.media);
  const id = asText(media?.id);
  if (!id) return null;
  const type = asText(media?.type || meta?.type).toLowerCase() || "document";
  return {
    type,
    mimeType: asText(media?.mimeType) || null,
    filename: asText(media?.filename) || null,
    caption: asText(media?.caption) || "",
    voice: media?.voice === true,
    url: createAgentMediaPath(messageId),
  };
}

function sanitizeMessage(row) {
  const meta = normalizeMeta(row?.meta);
  const id = asText(row?.id);
  const initialMessageStatus = asText(meta?.initialMessageStatus).toLowerCase();
  const deliveryStatus =
    asText(meta?.deliveryStatus).toLowerCase() ||
    (row?.waMessageId && meta?.source === "agent_messenger"
      ? initialMessageStatus || "accepted"
      : null);
  return {
    id,
    waMessageId: row?.waMessageId || null,
    createdAt: row?.createdAt || null,
    direction: asText(row?.direction) || "outbound",
    kind: asText(row?.kind),
    text: String(row?.displayText || row?.text || ""),
    templateName: row?.templateName || null,
    deliveryStatus,
    deliveryStatusAt: meta?.deliveryStatusAt || null,
    deliveryError: asText(meta?.deliveryError) || null,
    initialMessageStatus: initialMessageStatus || null,
    actor:
      asText(meta?.agentUsername) ||
      (meta?.source === "agent_messenger" ? "Agent" : null),
    source: asText(meta?.source) || null,
    replyToWaMessageId: asText(meta?.replyToWaMessageId || meta?.contextId) || null,
    location: normalizeMeta(meta?.location),
    contacts: Array.isArray(meta?.contacts) ? meta.contacts : [],
    media: sanitizeMedia(meta, id),
  };
}

async function resolveSenderRuntime(shop) {
  try {
    const runtime = await resolveRuntimeConfig(shop);
    const ready = !!asText(runtime?.phoneId) && !!asText(runtime?.token);
    return { runtime, ready };
  } catch {
    return { runtime: null, ready: false };
  }
}

async function buildThreadReplyStates({ shop, threadKeys, runtime, now }) {
  const keys = Array.from(
    new Set((threadKeys || []).map(normalizeThreadKey).filter(Boolean)),
  );
  if (!keys.length) return new Map();
  const phoneNumberId = asText(runtime?.phoneId);
  const senderReady = !!phoneNumberId && !!asText(runtime?.token);

  const inboundMatch = {
    shop,
    direction: "inbound",
    toE164: { $in: keys },
    ...(phoneNumberId ? { senderPhoneNumberId: phoneNumberId } : {}),
  };
  const [latestInboundRows, blockedRows] = await Promise.all([
    senderReady
      ? WaMessageLog.aggregate([
          { $match: inboundMatch },
          { $sort: { createdAt: -1, _id: -1 } },
          {
            $group: { _id: "$toE164", lastInboundAt: { $first: "$createdAt" } },
          },
        ])
      : [],
    BlockedContact.find({ shop, phoneE164: { $in: keys } })
      .select({ phoneE164: 1, note: 1, createdAt: 1, updatedAt: 1 })
      .lean(),
  ]);

  const inboundByThread = new Map(
    latestInboundRows.map((row) => [
      normalizeThreadKey(row?._id),
      row?.lastInboundAt,
    ]),
  );
  const blockedByThread = new Map(
    blockedRows.map((row) => [normalizeThreadKey(row?.phoneE164), row]),
  );
  const states = new Map();
  for (const key of keys) {
    const blockedRow = blockedByThread.get(key) || null;
    states.set(
      key,
      buildAgentReplyState({
        lastInboundAt: inboundByThread.get(key) || null,
        senderReady,
        blocked: !!blockedRow,
        blockedAt: blockedRow?.updatedAt || blockedRow?.createdAt || null,
        allowNewInboundAfterBlock: /^opt_out:/i.test(asText(blockedRow?.note)),
        now,
      }),
    );
  }
  return states;
}

export async function listAgentThreads({
  shop,
  q = "",
  page = 1,
  pageSize = 50,
  view = "all",
  account = null,
} = {}) {
  const shopDomain = asText(shop);
  if (!shopDomain) throw new Error("Missing shop");
  const [{ runtime }, result] = await Promise.all([
    resolveSenderRuntime(shopDomain),
    listConversationThreads({
      shop: shopDomain,
      q,
      page,
      pageSize,
      view,
      agentId: account?.id || null,
    }),
  ]);
  const items = Array.isArray(result?.items) ? result.items : [];
  const canViewCustomerPhone =
    account?.permissions?.viewCustomerPhone === true;
  const states = await buildThreadReplyStates({
    shop: shopDomain,
    threadKeys: items.map((row) => row.threadKey),
    runtime,
    now: new Date(),
  });
  return {
    items: items.map((row) => ({
      id: row.recordId || row.id,
      threadKey: row.recordId || row.id,
      partnerE164:
        canViewCustomerPhone ? row.partnerE164 : null,
      displayName: resolveTeamInboxDisplayName(row, {
        includePhone: canViewCustomerPhone,
      }),
      status: row.status || "new",
      snoozedUntil: row.snoozedUntil || null,
      assignedAgentId: row.assignedAgentId || null,
      assignedUsername: row.assignedUsername || null,
      labels: row.labels || [],
      unreadCount: Number(row.unreadCount || 0),
      lastOrderGid:
        account?.permissions?.viewShopifyData === true
          ? row.lastOrderGid || null
          : null,
      lastMessageAt: row.lastMessageAt,
      lastMessagePreview:
        row.lastMessagePreview || row.lastMessageText || "Message",
      lastDirection: row.lastDirection,
      messageCount: Number(row.messageCount || 0),
      inboundCount: Number(row.inboundCount || 0),
      outboundCount: Number(row.outboundCount || 0),
      replyState:
        states.get(normalizeThreadKey(row.threadKey)) ||
        buildAgentReplyState({ senderReady: false }),
    })),
    pagination: result?.pagination || {},
    summary: result?.summary || {},
  };
}

export async function listAgentMessages({
  shop,
  threadKey,
  before = "",
  pageSize = 60,
  account = null,
} = {}) {
  const shopDomain = asText(shop);
  const threadReference = asText(threadKey);
  if (!shopDomain || !threadReference) {
    const error = new Error("Missing conversation.");
    error.status = 400;
    throw error;
  }
  const conversation = await requireTeamInboxThread(
    shopDomain,
    threadReference,
  );
  const normalizedThread = conversation.threadKey;
  const [result, { runtime }, notes] = await Promise.all([
    listConversationMessages({
      shop: shopDomain,
      threadKey: normalizedThread,
      before,
      pageSize,
    }),
    resolveSenderRuntime(shopDomain),
    listTeamInboxNotes({
      shop: shopDomain,
      threadKey: normalizedThread,
      before,
      limit: pageSize,
    }),
  ]);
  if (!result?.thread) {
    const error = new Error("Conversation not found.");
    error.status = 404;
    throw error;
  }
  const states = await buildThreadReplyStates({
    shop: shopDomain,
    threadKeys: [normalizedThread],
    runtime,
    now: new Date(),
  });
  const messageItems = (result?.items || []).map(sanitizeMessage);
  const canViewCustomerPhone =
    account?.permissions?.viewCustomerPhone === true;
  const noteItems = (notes || []).map((note) => ({
    id: `note:${note._id}`,
    createdAt: note.createdAt || null,
    direction: "internal",
    kind: "internal_note",
    text: note.text,
    actor: note.agentUsername,
    mentions: note.mentions || [],
    deliveryStatus: null,
    media: null,
  }));
  return {
    thread: {
      id: teamInboxThreadReference(conversation),
      threadKey: teamInboxThreadReference(conversation),
      partnerE164:
        canViewCustomerPhone ? result.thread.partnerE164 : null,
      displayName: resolveTeamInboxDisplayName(result.thread, {
        includePhone: canViewCustomerPhone,
      }),
      status: result.thread.status || "new",
      assignedAgentId: result.thread.assignedAgentId || null,
      assignedUsername: result.thread.assignedUsername || null,
      lastMessageAt: result.thread.lastMessageAt,
      replyState:
        states.get(normalizedThread) ||
        buildAgentReplyState({ senderReady: false }),
    },
    items: [...messageItems, ...noteItems].sort(
      (left, right) =>
        new Date(left.createdAt || 0).getTime() -
        new Date(right.createdAt || 0).getTime(),
    ),
    pagination: result?.pagination || {},
  };
}

export async function authorizeAgentReply({ shop, threadKey, runtime = null }) {
  const shopDomain = asText(shop);
  const threadReference = asText(threadKey);
  if (!shopDomain || !threadReference) {
    const error = new Error("Choose an existing customer conversation first.");
    error.status = 400;
    error.code = "missing_thread";
    throw error;
  }
  await requireAgentFeatureAccess(shopDomain);

  const thread = await requireTeamInboxThread(shopDomain, threadReference);
  const normalizedThread = thread.threadKey;

  const resolvedRuntime = runtime || (await resolveRuntimeConfig(shopDomain));
  const states = await buildThreadReplyStates({
    shop: shopDomain,
    threadKeys: [normalizedThread],
    runtime: resolvedRuntime,
    now: new Date(),
  });
  const replyState =
    states.get(normalizedThread) ||
    buildAgentReplyState({ senderReady: false });
  if (!replyState.canReply) {
    const error = new Error(replyState.notice);
    error.status = 403;
    error.code = replyState.code;
    error.replyState = replyState;
    throw error;
  }

  const sendGate = await canSendWhatsApp(shopDomain, {
    toE164: normalizedThread,
    activeConversationWindow: true,
    senderPhoneNumberId: asText(resolvedRuntime?.phoneId),
    agentReply: true,
    agentBillingTestBypass: isAgentBillingTestShop(shopDomain),
  });
  if (!sendGate?.ok) {
    const error = new Error(
      asText(sendGate?.reason) ||
        "Agent replies are unavailable for this merchant right now.",
    );
    error.status = 403;
    error.code = "agent_send_not_allowed";
    error.replyState = replyState;
    throw error;
  }

  return {
    thread,
    threadKey: normalizedThread,
    runtime: resolvedRuntime,
    replyState,
  };
}

async function findSentAgentMessage({ shop, waMessageId }) {
  const row = await WaMessageLog.findOne({
    shop,
    direction: "outbound",
    waMessageId,
  }).lean();
  if (!row) return null;
  return sanitizeMessage({
    ...row,
    id: String(row._id),
    displayText: row.text || "",
  });
}

export async function claimAgentSend({
  shop,
  threadKey,
  actor,
  clientMessageId,
}) {
  const id = asText(clientMessageId).slice(0, 80);
  if (!id || !actor?.id) return null;
  try {
    return await AgentSendReceipt.create({
      shop,
      threadKey,
      agentAccountId: actor.id,
      clientMessageId: id,
      status: "sending",
    });
  } catch (error) {
    if (Number(error?.code) !== 11000) throw error;
    const existing = await AgentSendReceipt.findOne({
      shop,
      agentAccountId: actor.id,
      clientMessageId: id,
    }).lean();
    const duplicate = new Error(
      existing?.status === "sent"
        ? "This reply was already sent."
        : "This reply is already being sent.",
    );
    duplicate.status = 409;
    duplicate.code = "duplicate_agent_reply";
    duplicate.waMessageId = existing?.waMessageId || null;
    throw duplicate;
  }
}

async function finishAgentSend(receipt, waMessageId, error = null) {
  if (!receipt?._id) return;
  if (error) {
    await AgentSendReceipt.deleteOne({ _id: receipt._id }).catch(() => null);
    return;
  }
  await AgentSendReceipt.updateOne(
    { _id: receipt._id },
    { $set: { status: "sent", waMessageId: waMessageId || null } },
  ).catch(() => null);
}

export async function sendAgentText({
  shop,
  threadKey,
  text,
  actor = {},
  clientMessageId = "",
  replyToWaMessageId = "",
}) {
  requireAgentPermission(actor, "sendMessages");
  const body = String(text || "").trim();
  if (!body || body.length > 4096) {
    const error = new Error(
      "Reply text must be between 1 and 4096 characters.",
    );
    error.status = 400;
    error.code = "invalid_message";
    throw error;
  }
  const allowed = await authorizeAgentReply({ shop, threadKey });
  const billingTestBypass = isAgentBillingTestShop(shop);
  const agent = normalizeAgentActor(actor);
  const receipt = await claimAgentSend({
    shop,
    threadKey: allowed.threadKey,
    actor: agent,
    clientMessageId,
  });
  let sent;
  try {
    sent = await sendWhatsAppText({
    to: allowed.threadKey,
    text: body,
    shop,
    runtime: allowed.runtime,
    kind: "agent_reply_text",
    replyToWaMessageId: asText(replyToWaMessageId) || null,
    meta: {
      source: "agent_messenger",
      type: "text",
      capExempt: true,
      billingTestBypass,
      agentAccountId: agent.id,
      agentUsername: agent.username,
      clientMessageId: asText(clientMessageId) || null,
      replyToWaMessageId: asText(replyToWaMessageId) || null,
    },
    // authorizeAgentReply checks active BYON access, sender readiness, block
    // state and the service window immediately before Meta dispatch.
    skipBillingCheck: true,
    beforeSend: async () => {
      await authorizeAgentReply({
        shop,
        threadKey: allowed.threadKey,
        runtime: allowed.runtime,
      });
    },
    });
  } catch (error) {
    await finishAgentSend(receipt, null, error);
    throw error;
  }
  const acceptance = getWhatsAppMessageAcceptance(sent?.data);
  const waMessageId = acceptance.waMessageId;
  await finishAgentSend(receipt, waMessageId);
  await incrementWhatsAppUsage(shop, 1, { excludeFromCap: true }).catch(
    (error) => {
      console.error("[agent_usage_increment]", shop, error?.message || error);
    },
  );
  void logAudit({
    shop,
    actor: `agent:${agent.username}`,
    action: "agent_message_sent",
    message: "Agent sent a customer-service text reply.",
    meta: {
      agentAccountId: agent.id,
      threadKey: allowed.threadKey,
      waMessageId,
      messageType: "text",
      capExempt: true,
    },
  });
  publishTeamInboxEvent(shop, "message.created", {
    threadKey: allowed.threadKey,
    waMessageId,
  });
  return {
    waMessageId,
    messageStatus: acceptance.messageStatus,
    message: waMessageId
      ? await findSentAgentMessage({ shop, waMessageId })
      : null,
  };
}

export async function sendAgentMedia({
  shop,
  threadKey,
  buffer,
  fileName,
  contentType,
  mediaType,
  caption = "",
  voice = false,
  actor = {},
  clientMessageId = "",
  replyToWaMessageId = "",
}) {
  requireAgentPermission(actor, "sendMedia");
  const allowed = await authorizeAgentReply({ shop, threadKey });
  const billingTestBypass = isAgentBillingTestShop(shop);
  const agent = normalizeAgentActor(actor);
  const receipt = await claimAgentSend({
    shop,
    threadKey: allowed.threadKey,
    actor: agent,
    clientMessageId,
  });
  let sent;
  try {
    sent = await sendWhatsAppMedia({
    to: allowed.threadKey,
    shop,
    runtime: allowed.runtime,
    buffer,
    fileName,
    contentType,
    mediaType,
    caption,
    voice,
    replyToWaMessageId: asText(replyToWaMessageId) || null,
    kind:
      mediaType === "image"
        ? "agent_reply_image"
        : mediaType === "video"
          ? "agent_reply_video"
          : mediaType === "document"
            ? "agent_reply_document"
            : voice
              ? "agent_reply_voice"
              : "agent_reply_audio",
    meta: {
      source: "agent_messenger",
      capExempt: true,
      billingTestBypass,
      agentAccountId: agent.id,
      agentUsername: agent.username,
      clientMessageId: asText(clientMessageId) || null,
      replyToWaMessageId: asText(replyToWaMessageId) || null,
    },
    skipBillingCheck: true,
    beforeSend: async () => {
      await authorizeAgentReply({
        shop,
        threadKey: allowed.threadKey,
        runtime: allowed.runtime,
      });
    },
    });
  } catch (error) {
    await finishAgentSend(receipt, null, error);
    throw error;
  }
  const acceptance = getWhatsAppMessageAcceptance(sent?.data);
  const waMessageId = acceptance.waMessageId;
  await finishAgentSend(receipt, waMessageId);
  await incrementWhatsAppUsage(shop, 1, { excludeFromCap: true }).catch(
    (error) => {
      console.error("[agent_usage_increment]", shop, error?.message || error);
    },
  );
  void logAudit({
    shop,
    actor: `agent:${agent.username}`,
    action: "agent_message_sent",
    message: "Agent sent customer-service media.",
    meta: {
      agentAccountId: agent.id,
      threadKey: allowed.threadKey,
      waMessageId,
      messageType: mediaType,
      voice: voice === true,
      capExempt: true,
    },
  });
  publishTeamInboxEvent(shop, "message.created", {
    threadKey: allowed.threadKey,
    waMessageId,
  });
  return {
    waMessageId,
    messageStatus: acceptance.messageStatus,
    message: waMessageId
      ? await findSentAgentMessage({ shop, waMessageId })
      : null,
  };
}

export async function sendAgentTemplate({
  shop,
  threadKey,
  templateId,
  actor = {},
  clientMessageId = "",
  variables = {},
}) {
  requireAgentPermission(actor, "sendTemplates");
  const shopDomain = asText(shop);
  const threadReference = asText(threadKey);
  await requireAgentFeatureAccess(shopDomain);
  const thread = await requireTeamInboxThread(shopDomain, threadReference);
  const normalizedThread = thread.threadKey;
  const blocked = await BlockedContact.exists({ shop: shopDomain, phoneE164: normalizedThread });
  if (blocked) throw Object.assign(new Error("This customer is opted out or blocked."), { status: 403, code: "contact_blocked" });
  const hasCustomerMessage = await WaMessageLog.exists({
    shop: shopDomain,
    direction: "inbound",
    toE164: normalizedThread,
  });
  if (!hasCustomerMessage) {
    throw Object.assign(
      new Error(
        "Agents cannot start a new conversation. Wait for this customer to message the business first.",
      ),
      { status: 403, code: "no_customer_message" },
    );
  }
  const record = await Shop.findOne({ shop: shopDomain })
    .select({
      "whatsappSender.ownNumber.managedTemplates": 1,
      "settings.supportWhatsAppNumber": 1,
      "settings.reviewRequestUrl": 1,
    })
    .lean();
  const template = (record?.whatsappSender?.ownNumber?.managedTemplates || []).find(
    (row) => asText(row?.id) === asText(templateId),
  );
  if (!template || !isAgentTemplateApproved(template)) {
    throw Object.assign(new Error("Choose an approved WhatsApp template."), { status: 400, code: "template_not_approved" });
  }
  const agent = normalizeAgentActor(actor);
  const receipt = await claimAgentSend({ shop, threadKey: normalizedThread, actor: agent, clientMessageId });
  try {
    const contextData = await getTeamInboxContext({ shop, threadKey: normalizedThread, account: actor });
    const automaticContext = buildAgentTemplateContext({
      shop: shopDomain,
      contextData,
      shopRecord: record,
    });
    const variableKeys = getTeamInboxTemplateVariableKeys(template);
    const context = {
      ...automaticContext,
      ...sanitizeTeamInboxTemplateVariables(variables, variableKeys),
    };
    const missingVariables = getMissingAgentTemplateVariables(
      template,
      context,
    );
    if (missingVariables.length) {
      throw Object.assign(
        new Error(
          `This template needs customer or order data that is unavailable: ${missingVariables.join(", ")}.`,
        ),
        { status: 400, code: "template_context_missing" },
      );
    }
    await requireAgentFeatureAccess(shopDomain);
    const blockedBeforeSend = await BlockedContact.exists({
      shop: shopDomain,
      phoneE164: normalizedThread,
    });
    if (blockedBeforeSend) {
      throw Object.assign(new Error("This customer is opted out or blocked."), {
        status: 403,
        code: "contact_blocked",
      });
    }
    const sent = await sendManagedTemplateDirect({
      to: normalizedThread,
      managedTemplate: template,
      context,
      shop,
      kind: "agent_reply_template",
      orderGid: thread.lastOrderGid || null,
      meta: {
        source: "agent_messenger",
        capExempt: true,
        agentAccountId: agent.id,
        agentUsername: agent.username,
        clientMessageId: asText(clientMessageId) || null,
        flowContext: Object.fromEntries(
          variableKeys.map((key) => [key, asText(context[key])]),
        ),
      },
      skipBillingCheck: true,
      suppressDebugLogging: true,
    });
    const acceptance = getWhatsAppMessageAcceptance(sent?.data);
    const waMessageId = acceptance.waMessageId;
    await finishAgentSend(receipt, waMessageId);
    void logAudit({
      shop,
      actor: `agent:${agent.username}`,
      action: "agent_template_sent",
      message: "Agent sent an approved WhatsApp template.",
      meta: { threadKey: normalizedThread, templateId: template.id, waMessageId },
    });
    publishTeamInboxEvent(shop, "message.created", { threadKey: normalizedThread, waMessageId });
    return {
      waMessageId,
      messageStatus: acceptance.messageStatus,
      message: waMessageId
        ? await findSentAgentMessage({ shop, waMessageId })
        : null,
    };
  } catch (error) {
    await finishAgentSend(receipt, null, error);
    throw error;
  }
}
