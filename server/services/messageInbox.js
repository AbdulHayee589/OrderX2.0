import Shop from "../models/Shop.js";
import ConversationThread from "../models/ConversationThread.js";
import WaMessageLog from "../models/WaMessageLog.js";
import {
  buildTemplateContext,
  getFlowDefinition,
  renderFriendlyPreview,
} from "./templateCatalog.js";

function safeText(value, fallback = "") {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function toDate(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function clampPreview(value, maxLen = 180) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
}

function normalizeMeta(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string") return {};
  const text = String(value || "").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function normalizeThreadKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("+")) return raw;
  if (/^\d+$/.test(raw)) return `+${raw}`;
  return raw;
}

export function resolveConversationDisplayName(row = {}) {
  return (
    safeText(row?.manualName) ||
    safeText(row?.shopifyCustomerName) ||
    safeText(row?.whatsappProfileName) ||
    safeText(row?.shippingName) ||
    normalizeThreadKey(row?.partnerE164 || row?.threadKey) ||
    "Customer"
  );
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildMessageSearchMatch(shop, q) {
  const search = safeText(q);
  if (!search) return { shop };
  const regex = new RegExp(escapeRegex(search), "i");
  return {
    shop,
    $or: [
      { toE164: regex },
      { text: regex },
      { templateName: regex },
      { kind: regex },
      { orderGid: regex },
      { waMessageId: regex },
    ],
  };
}

function buildThreadPreview(log) {
  const rendered = buildRenderedMessagePreview(log, null);
  if (rendered) return clampPreview(rendered, 180);
  const text = clampPreview(log?.text || "");
  if (text) return text;
  const template = safeText(log?.templateName);
  if (template) {
    return `Template: ${template.replace(/_/g, " ")}`;
  }
  const kind = safeText(log?.kind);
  if (kind) {
    return kind.replace(/_/g, " ");
  }
  return "Message";
}

function buildPreviewButtons(row = {}, templateIndex = null) {
  const meta = normalizeMeta(row?.meta);
  const flowKey = safeText(meta?.flowKey || row?.flowKey || row?.kind).trim();
  const flow = getFlowDefinition(flowKey);
  const template =
    findTemplateFromIndex(templateIndex, meta, row) ||
    (flow?.defaultTemplate
      ? {
          buttons: Array.isArray(flow.fixedButtons) ? flow.fixedButtons : [],
        }
      : null);
  const source =
    (Array.isArray(meta?.buttons) && meta.buttons.length && meta.buttons) ||
    (Array.isArray(meta?.managedTemplateButtons) &&
      meta.managedTemplateButtons.length &&
      meta.managedTemplateButtons) ||
    (Array.isArray(template?.buttons) && template.buttons) ||
    [];
  return source
    .map((button) =>
      String(button?.text || button?.title || button?.label || "").trim(),
    )
    .filter(Boolean)
    .slice(0, 8);
}

function buildTemplateIndex(templates = []) {
  const map = new Map();
  for (const row of Array.isArray(templates) ? templates : []) {
    if (!row || typeof row !== "object") continue;
    const keys = [
      row?.id,
      row?.templateKey,
      row?.metaTemplateName,
      row?.name,
      row?.flowKey,
    ];
    for (const key of keys) {
      const normalized = safeText(key);
      if (normalized) map.set(normalized, row);
    }
  }
  return map;
}

function findTemplateFromIndex(index, meta = {}, row = {}) {
  if (!index || !(index instanceof Map) || !index.size) return null;
  const keys = [
    meta?.managedTemplateId,
    meta?.managedTemplateName,
    meta?.managedTemplateMetaName,
    row?.templateName,
    row?.flowKey,
    meta?.flowKey,
  ];
  for (const key of keys) {
    const normalized = safeText(key);
    if (!normalized) continue;
    const found = index.get(normalized);
    if (found) return found;
  }
  return null;
}

function buildRenderedMessagePreview(row = {}, templateIndex = null) {
  const meta = normalizeMeta(row?.meta);
  const flowKey = safeText(meta?.flowKey || row?.flowKey || row?.kind).trim();
  const flow = getFlowDefinition(flowKey);
  const context = {
    ...buildTemplateContext(),
    ...(meta?.flowContext && typeof meta.flowContext === "object"
      ? meta.flowContext
      : {}),
  };
  const template =
    findTemplateFromIndex(templateIndex, meta, row) ||
    (flow?.defaultTemplate
      ? {
          headerType: flow.defaultTemplate.headerType || "TEXT",
          headerText: flow.defaultTemplate.headerText || "",
          bodyText: flow.defaultTemplate.bodyText || "",
          footerText: flow.defaultTemplate.footerText || "",
          buttons: Array.isArray(flow.fixedButtons) ? flow.fixedButtons : [],
          displayName: flow.label || "",
        }
      : null);

  const templateBody = String(
    meta?.managedTemplateBodyText ||
      meta?.templateBodyText ||
      template?.bodyText ||
      "",
  ).trim();
  const templateHeader = String(
    meta?.managedTemplateHeaderText ||
      meta?.templateHeaderText ||
      template?.headerText ||
      "",
  ).trim();
  const templateFooter = String(
    meta?.managedTemplateFooterText ||
      meta?.templateFooterText ||
      template?.footerText ||
      "",
  ).trim();

  const renderedHeader = templateHeader
    ? renderFriendlyPreview(templateHeader, context)
    : "";
  const renderedBody = templateBody
    ? renderFriendlyPreview(templateBody, context)
    : "";
  const renderedFooter = templateFooter
    ? renderFriendlyPreview(templateFooter, context)
    : "";

  const parts = [];
  if (renderedHeader) parts.push(renderedHeader);
  if (renderedBody) parts.push(renderedBody);
  if (renderedFooter) parts.push(renderedFooter);

  const label = safeText(
    meta?.managedTemplateDisplayName ||
      meta?.templateDisplayName ||
      flow?.label ||
      row?.templateName ||
      row?.kind,
  );

  if (!parts.length) {
    const text = clampPreview(row?.text || "");
    if (text) return text;
    return label || "";
  }

  return parts.join("\n\n");
}

function mapThreadRow(row) {
  return {
    recordId: safeText(row?._id?.toString?.() || row?._id),
    id: safeText(row?.threadKey),
    threadKey: safeText(row?.threadKey),
    partnerE164: safeText(row?.partnerE164 || row?.threadKey),
    waId: row?.waId || null,
    displayName: resolveConversationDisplayName(row),
    manualName: row?.manualName || null,
    whatsappProfileName: row?.whatsappProfileName || null,
    shopifyCustomerName: row?.shopifyCustomerName || null,
    shippingName: row?.shippingName || null,
    customerEmail: row?.customerEmail || null,
    customerLocation: row?.customerLocation || null,
    shopifyCustomerId: row?.shopifyCustomerId || null,
    status: safeText(row?.status, "new"),
    snoozedUntil: toDate(row?.snoozedUntil)?.toISOString() || null,
    assignedAgentId: row?.assignedAgentId ? String(row.assignedAgentId) : null,
    assignedUsername: row?.assignedUsername || null,
    labels: Array.isArray(row?.labels) ? row.labels : [],
    unreadCount: Number(row?.unreadCount || 0),
    lastInboundAt: toDate(row?.lastInboundAt)?.toISOString() || null,
    lastOutboundAt: toDate(row?.lastOutboundAt)?.toISOString() || null,
    lastMessageAt: toDate(row?.lastMessageAt)?.toISOString() || null,
    lastMessageId: row?.lastMessageId || null,
    lastMessageText: row?.lastMessageText || "",
    lastMessagePreview: row?.lastMessagePreview || "",
    lastDirection: safeText(row?.lastDirection, "outbound"),
    lastKind: safeText(row?.lastKind),
    lastTemplateName: row?.lastTemplateName || null,
    lastSenderMode: safeText(row?.lastSenderMode, "unknown"),
    lastSenderPhoneNumberId: row?.lastSenderPhoneNumberId || null,
    lastAttemptId: row?.lastAttemptId || null,
    lastOrderGid: row?.lastOrderGid || null,
    recipientCountryCode: row?.recipientCountryCode || null,
    storeCountryCode: row?.storeCountryCode || null,
    messageCount: Number(row?.messageCount || 0),
    inboundCount: Number(row?.inboundCount || 0),
    outboundCount: Number(row?.outboundCount || 0),
    templateCount: Number(row?.templateCount || 0),
  };
}

function mapMessageRow(row, templateIndex = null) {
  const meta = normalizeMeta(row?.meta);
  return {
    id: safeText(row?._id?.toString?.() || row?._id || row?.waMessageId),
    createdAt: toDate(row?.createdAt)?.toISOString() || null,
    shop: safeText(row?.shop),
    toE164: safeText(row?.toE164),
    direction: safeText(row?.direction, "outbound"),
    kind: safeText(row?.kind),
    text: row?.text || "",
    templateName: row?.templateName || null,
    waMessageId: row?.waMessageId || null,
    senderMode: safeText(row?.senderMode, "unknown"),
    senderPhoneNumberId: row?.senderPhoneNumberId || null,
    recipientCountryCode: row?.recipientCountryCode || null,
    storeCountryCode: row?.storeCountryCode || null,
    attemptId: row?.attemptId ? String(row.attemptId) : null,
    orderGid: row?.orderGid || null,
    meta: row?.meta || null,
    metaPreview: row?.meta ? clampPreview(JSON.stringify(row.meta), 220) : "",
    displayText: buildRenderedMessagePreview({ ...row, meta }, templateIndex),
    previewButtons: buildPreviewButtons({ ...row, meta }, templateIndex),
  };
}

export async function touchConversationThreadFromLog(log = {}) {
  const shop = safeText(log?.shop);
  const threadKey = normalizeThreadKey(log?.toE164);
  if (!shop || !threadKey) return;

  const direction = safeText(log?.direction, "outbound").toLowerCase();
  const lastMessageAt = toDate(log?.createdAt) || new Date();
  const lastMessageText = String(log?.text || "");
  const meta = normalizeMeta(log?.meta);
  const whatsappProfileName = safeText(meta?.whatsappProfileName);
  const waId = safeText(meta?.waId);
  const existingThread = await ConversationThread.exists({ shop, threadKey });

  const update = {
    $set: {
      shop,
      threadKey,
      partnerE164: threadKey,
      lastMessageAt,
      lastMessageId: log?.waMessageId ? String(log.waMessageId) : null,
      lastMessageText,
      lastMessagePreview: buildThreadPreview(log),
      lastDirection: direction || "outbound",
      lastKind: safeText(log?.kind),
      lastTemplateName: log?.templateName || null,
      lastSenderMode: safeText(log?.senderMode, "unknown"),
      lastSenderPhoneNumberId: log?.senderPhoneNumberId || null,
      lastAttemptId: log?.attemptId ? String(log.attemptId) : null,
      lastOrderGid: log?.orderGid || null,
      recipientCountryCode: log?.recipientCountryCode || null,
      storeCountryCode: log?.storeCountryCode || null,
      ...(whatsappProfileName ? { whatsappProfileName } : {}),
      ...(waId ? { waId } : {}),
      ...(direction === "inbound"
        ? {
            lastInboundAt: lastMessageAt,
            status: existingThread ? "open" : "new",
            snoozedUntil: null,
          }
        : { lastOutboundAt: lastMessageAt }),
    },
    $inc: {
      messageCount: 1,
      ...(direction === "inbound" ? { inboundCount: 1 } : { outboundCount: 1 }),
      ...(safeText(log?.templateName) ? { templateCount: 1 } : {}),
      ...(direction === "inbound" ? { unreadCount: 1 } : {}),
    },
    ...(direction === "inbound" ? {} : { $setOnInsert: { status: "open" } }),
  };

  await ConversationThread.updateOne({ shop, threadKey }, update, {
    upsert: true,
  }).catch(() => {});
}

export async function ensureConversationThreadsBackfill(shop, { force = false } = {}) {
  const shopDomain = safeText(shop);
  if (!shopDomain) {
    return {
      ok: false,
      backfilled: 0,
      skipped: true,
      reason: "missing_shop",
    };
  }

  if (!force) {
    const existing = await ConversationThread.findOne({ shop: shopDomain })
      .select({ _id: 1 })
      .lean()
      .catch(() => null);
    if (existing?._id) {
      return {
        ok: true,
        backfilled: 0,
        skipped: true,
        reason: "already_populated",
      };
    }
  } else {
    await ConversationThread.deleteMany({ shop: shopDomain }).catch(() => {});
  }

  const rows = await WaMessageLog.aggregate([
    {
      $match: {
        shop: shopDomain,
        toE164: { $nin: [null, ""] },
      },
    },
    { $sort: { createdAt: -1, _id: -1 } },
    {
      $group: {
        _id: "$toE164",
        lastMessage: { $first: "$$ROOT" },
        messageCount: { $sum: 1 },
        inboundCount: {
          $sum: { $cond: [{ $eq: ["$direction", "inbound"] }, 1, 0] },
        },
        outboundCount: {
          $sum: { $cond: [{ $eq: ["$direction", "outbound"] }, 1, 0] },
        },
        templateCount: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $ne: ["$templateName", null] },
                  { $ne: ["$templateName", ""] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
  ]).allowDiskUse(true);

  if (!rows.length) {
    return {
      ok: true,
      backfilled: 0,
      skipped: false,
      reason: "no_messages",
    };
  }

  const ops = rows.map((row) => {
    const last = row?.lastMessage || {};
    const threadKey = normalizeThreadKey(row?._id);
    return {
      updateOne: {
        filter: { shop: shopDomain, threadKey },
        update: {
          $set: {
            shop: shopDomain,
            threadKey,
            partnerE164: threadKey,
            lastMessageAt: toDate(last?.createdAt) || new Date(),
            lastMessageId: last?.waMessageId || null,
            lastMessageText: String(last?.text || ""),
            lastMessagePreview: buildThreadPreview(last),
            lastDirection: safeText(last?.direction, "outbound"),
            lastKind: safeText(last?.kind),
            lastTemplateName: last?.templateName || null,
            lastSenderMode: safeText(last?.senderMode, "unknown"),
            lastSenderPhoneNumberId: last?.senderPhoneNumberId || null,
            lastAttemptId: last?.attemptId ? String(last.attemptId) : null,
            lastOrderGid: last?.orderGid || null,
            recipientCountryCode: last?.recipientCountryCode || null,
            storeCountryCode: last?.storeCountryCode || null,
            messageCount: Number(row?.messageCount || 0),
            inboundCount: Number(row?.inboundCount || 0),
            outboundCount: Number(row?.outboundCount || 0),
            templateCount: Number(row?.templateCount || 0),
          },
        },
        upsert: true,
      },
    };
  });

  if (ops.length) {
    await ConversationThread.bulkWrite(ops, { ordered: false }).catch(() => {});
  }

  return {
    ok: true,
    backfilled: ops.length,
    skipped: false,
    reason: "backfilled_from_logs",
  };
}

async function listThreadRows({
  shop,
  q = "",
  page = 1,
  pageSize = 20,
  selectedThreadKey = "",
  forceBackfill = false,
  view = "all",
  agentId = null,
} = {}) {
  const shopDomain = safeText(shop);
  if (!shopDomain) {
    throw new Error("Missing shop");
  }

  await ensureConversationThreadsBackfill(shopDomain, { force: forceBackfill });

  const query = safeText(q);
  const normalizedSelected = normalizeThreadKey(selectedThreadKey);
  const pageNumber = Math.max(1, Math.floor(Number(page) || 1));
  const pageLimit = Math.min(100, Math.max(5, Math.floor(Number(pageSize) || 20)));

  await ConversationThread.updateMany(
    {
      shop: shopDomain,
      status: "snoozed",
      snoozedUntil: { $lte: new Date() },
    },
    { $set: { status: "open", snoozedUntil: null } },
  ).catch(() => null);

  let baseMatch = { shop: shopDomain };
  const normalizedView = safeText(view, "all").toLowerCase();
  if (normalizedView === "mine" && agentId) {
    baseMatch.assignedAgentId = agentId;
  } else if (normalizedView === "unassigned") {
    baseMatch.assignedAgentId = null;
  } else if (normalizedView === "unread") {
    baseMatch.unreadCount = { $gt: 0 };
  } else if (["waiting", "snoozed", "resolved"].includes(normalizedView)) {
    baseMatch.status = normalizedView;
  }
  let matchingThreadKeys = null;
  let matchingThreadSet = null;

  if (query) {
    const searchMatch = buildMessageSearchMatch(shopDomain, query);
    const matchingRows = await WaMessageLog.aggregate([
      { $match: searchMatch },
      { $group: { _id: "$toE164" } },
      { $sort: { _id: 1 } },
    ]).allowDiskUse(true);
    const identityRows = await ConversationThread.find({
      shop: shopDomain,
      $or: [
        { displayName: new RegExp(escapeRegex(query), "i") },
        { manualName: new RegExp(escapeRegex(query), "i") },
        { shopifyCustomerName: new RegExp(escapeRegex(query), "i") },
        { whatsappProfileName: new RegExp(escapeRegex(query), "i") },
        { lastOrderGid: new RegExp(escapeRegex(query), "i") },
        { partnerE164: new RegExp(escapeRegex(query), "i") },
      ],
    })
      .select({ threadKey: 1 })
      .limit(500)
      .lean();
    matchingThreadKeys = [
      ...matchingRows.map((row) => normalizeThreadKey(row?._id)),
      ...identityRows.map((row) => normalizeThreadKey(row?.threadKey)),
    ]
      .filter(Boolean);
    matchingThreadKeys = Array.from(new Set(matchingThreadKeys));
    matchingThreadSet = new Set(matchingThreadKeys);
    if (!matchingThreadKeys.length) {
      return {
        items: [],
        pagination: {
          page: 1,
          pageSize: pageLimit,
          total: 0,
          totalPages: 1,
          hasPrevious: false,
          hasNext: false,
        },
        summary: {
          totalThreads: 0,
          messageCount: 0,
          inboundCount: 0,
          outboundCount: 0,
          templateCount: 0,
        },
        selectedThread: null,
        selectedThreadKey: null,
      };
    }
    baseMatch = {
      ...baseMatch,
      threadKey: { $in: matchingThreadKeys },
    };
  }

  const total = await ConversationThread.countDocuments(baseMatch);
  const totalPages = Math.max(1, Math.ceil(total / pageLimit));
  const safePage = Math.min(pageNumber, totalPages);
  const skip = (safePage - 1) * pageLimit;

  const itemsRaw = await ConversationThread.find(baseMatch)
    .sort({ lastMessageAt: -1, updatedAt: -1, _id: -1 })
    .skip(skip)
    .limit(pageLimit)
    .lean();

  const rows = itemsRaw.map(mapThreadRow);
  const selectedCandidate =
    (normalizedSelected &&
      rows.find((row) => row.threadKey === normalizedSelected)) ||
    null;

  let selectedThread = selectedCandidate;
  if (
    !selectedThread &&
    normalizedSelected &&
    (!query || matchingThreadSet?.has(normalizedSelected))
  ) {
    selectedThread = await ConversationThread.findOne({
      shop: shopDomain,
      threadKey: normalizedSelected,
    })
      .lean()
      .then((row) => (row ? mapThreadRow(row) : null))
      .catch(() => null);
  }

  if (
    selectedThread &&
    !rows.some((row) => row.threadKey === selectedThread.threadKey)
  ) {
    rows.unshift(selectedThread);
  }

  const summaryRows = await ConversationThread.aggregate([
    { $match: baseMatch },
    {
      $group: {
        _id: null,
        totalThreads: { $sum: 1 },
        messageCount: { $sum: { $ifNull: ["$messageCount", 0] } },
        inboundCount: { $sum: { $ifNull: ["$inboundCount", 0] } },
        outboundCount: { $sum: { $ifNull: ["$outboundCount", 0] } },
        templateCount: { $sum: { $ifNull: ["$templateCount", 0] } },
      },
    },
  ]).allowDiskUse(true);

  const summary = summaryRows?.[0] || {
    totalThreads: 0,
    messageCount: 0,
    inboundCount: 0,
    outboundCount: 0,
    templateCount: 0,
  };

  return {
    items: rows,
    pagination: {
      page: safePage,
      pageSize: pageLimit,
      total,
      totalPages,
      hasPrevious: safePage > 1,
      hasNext: safePage < totalPages,
    },
    summary: {
      totalThreads: Number(summary?.totalThreads || total),
      messageCount: Number(summary?.messageCount || 0),
      inboundCount: Number(summary?.inboundCount || 0),
      outboundCount: Number(summary?.outboundCount || 0),
      templateCount: Number(summary?.templateCount || 0),
    },
    selectedThread: selectedThread || rows[0] || null,
    selectedThreadKey:
      selectedThread?.threadKey || rows[0]?.threadKey || normalizedSelected || null,
  };
}

export async function listConversationThreads(options = {}) {
  return listThreadRows(options);
}

export async function listConversationMessages({
  shop,
  threadKey,
  before = "",
  pageSize = 30,
} = {}) {
  const shopDomain = safeText(shop);
  const normalizedThreadKey = normalizeThreadKey(threadKey);
  if (!shopDomain) {
    throw new Error("Missing shop");
  }
  if (!normalizedThreadKey) {
    throw new Error("Missing thread");
  }

  await ensureConversationThreadsBackfill(shopDomain);

  const pageLimit = Math.min(200, Math.max(10, Math.floor(Number(pageSize) || 30)));
  const beforeDate = toDate(before);
  const match = {
    shop: shopDomain,
    toE164: normalizedThreadKey,
  };
  if (beforeDate) {
    match.createdAt = { $lt: beforeDate };
  }

  const rowsDesc = await WaMessageLog.find(match)
    .sort({ createdAt: -1, _id: -1 })
    .limit(pageLimit + 1)
    .lean();

  const templateIds = new Set();
  const templateNames = new Set();
  for (const row of rowsDesc) {
    const meta = normalizeMeta(row?.meta);
    if (meta?.managedTemplateId) {
      templateIds.add(String(meta.managedTemplateId).trim());
    }
    if (meta?.managedTemplateName) {
      templateNames.add(String(meta.managedTemplateName).trim());
    }
    if (meta?.managedTemplateMetaName) {
      templateNames.add(String(meta.managedTemplateMetaName).trim());
    }
    if (row?.templateName) {
      templateNames.add(String(row.templateName).trim());
    }
  }

  let templateIndex = null;
  if (templateIds.size || templateNames.size) {
    const shopRecord = await Shop.findOne({ shop: shopDomain })
      .select({ "whatsappSender.ownNumber.managedTemplates": 1 })
      .lean()
      .catch(() => null);
    const managedTemplates =
      shopRecord?.whatsappSender?.ownNumber?.managedTemplates || [];
    const filtered = managedTemplates.filter((template) => {
      const ids = [
        template?.id,
        template?.templateKey,
        template?.metaTemplateName,
        template?.name,
        template?.flowKey,
      ]
        .map((item) => safeText(item))
        .filter(Boolean);
      return (
        ids.some((item) => templateIds.has(item)) ||
        ids.some((item) => templateNames.has(item))
      );
    });
    templateIndex = buildTemplateIndex(filtered.length ? filtered : managedTemplates);
  }

  const hasMoreBefore = rowsDesc.length > pageLimit;
  const trimmedDesc = hasMoreBefore ? rowsDesc.slice(0, pageLimit) : rowsDesc;
  const asc = trimmedDesc
    .reverse()
    .map((row) => mapMessageRow(row, templateIndex));
  const thread = await ConversationThread.findOne({
    shop: shopDomain,
    threadKey: normalizedThreadKey,
  })
    .lean()
    .then((row) => (row ? mapThreadRow(row) : null))
    .catch(() => null);

  return {
    thread,
    items: asc,
    pagination: {
      pageSize: pageLimit,
      hasMoreBefore,
      beforeCursor: asc.length ? asc[0].createdAt : beforeDate?.toISOString() || null,
      nextBefore: asc.length ? asc[0].createdAt : null,
      loadedCount: asc.length,
    },
  };
}
