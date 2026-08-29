import mongoose from "mongoose";
import AgentAccount from "../models/AgentAccount.js";
import AgentConversationState from "../models/AgentConversationState.js";
import CodAttempt from "../models/CodAttempt.js";
import ConversationThread from "../models/ConversationThread.js";
import Shop from "../models/Shop.js";
import TeamInboxLabel from "../models/TeamInboxLabel.js";
import TeamInboxNote from "../models/TeamInboxNote.js";
import TeamInboxQuickReply from "../models/TeamInboxQuickReply.js";
import { confirmAttempt, cancelAttempt } from "./attemptActions.js";
import { logAudit } from "./audit.js";
import { requireAgentPermission } from "./agentPermissions.js";
import {
  appendOrderTag,
  fetchOrderForCodConfirmTemplate,
} from "./shopifyAdmin.js";
import { getAdminClient } from "../utils/shopifyAdmin.js";
import { getTeamInboxTemplateVariableKeys } from "./teamInboxTemplateVariables.js";
import { publishTeamInboxEvent } from "./teamInboxRealtime.js";
import {
  inferCountryCodeFromE164,
  normalizePhoneE164,
} from "./phone.js";

const THREAD_STATUSES = new Set([
  "new",
  "open",
  "waiting",
  "snoozed",
  "resolved",
]);
const IDENTITY_CACHE_MS = 15 * 60 * 1000;

function text(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function normalizeThreadKey(value) {
  const raw = text(value, 50);
  if (!raw) return "";
  if (raw.startsWith("+")) return raw;
  return /^\d+$/.test(raw) ? `+${raw}` : raw;
}

function phoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

export function teamInboxPhonesMatch(left, right) {
  const target = normalizePhoneE164(right) || text(right, 50);
  const inferredCountry = inferCountryCodeFromE164(target);
  const source =
    normalizePhoneE164(left, inferredCountry || undefined) || text(left, 50);
  const a = phoneDigits(source);
  const b = phoneDigits(target);
  return !!a && !!b && a === b;
}

export function resolveTeamInboxDisplayName(
  thread = {},
  { includePhone = true } = {},
) {
  const name =
    text(thread.manualName, 160) ||
    text(thread.shopifyCustomerName, 160) ||
    text(thread.whatsappProfileName, 160) ||
    text(thread.shippingName, 160);
  if (name) return name;
  const storedName = text(thread.displayName, 160);
  const phone = normalizeThreadKey(thread.partnerE164 || thread.threadKey);
  if (storedName && (!phone || !teamInboxPhonesMatch(storedName, phone))) {
    return storedName;
  }
  if (includePhone) {
    return phone || "Customer";
  }
  return "Customer";
}

export function teamInboxThreadReference(thread = {}) {
  return text(thread?._id, 80) || normalizeThreadKey(thread?.threadKey);
}

export async function findTeamInboxLinkedAttempt({ shop, thread } = {}) {
  const shopDomain = text(shop).toLowerCase();
  if (!shopDomain || !thread) return null;

  const orderGid = text(thread.lastOrderGid, 240);
  if (orderGid) {
    // An explicit order in the conversation context must never be replaced by
    // a newer order belonging to the same repeat customer.
    return CodAttempt.findOne({ shop: shopDomain, orderGid }).sort({
      createdAt: -1,
    });
  }

  const lastAttemptId = text(thread.lastAttemptId, 80);
  if (lastAttemptId && mongoose.isValidObjectId(lastAttemptId)) {
    const exactAttempt = await CodAttempt.findOne({
      _id: lastAttemptId,
      shop: shopDomain,
      phoneE164: thread.threadKey,
    });
    if (exactAttempt) return exactAttempt;
  }

  return CodAttempt.findOne({
    shop: shopDomain,
    phoneE164: thread.threadKey,
  }).sort({ createdAt: -1 });
}

function isApprovedTemplate(template = {}) {
  return [template?.status, template?.rawStatus].some(
    (value) => text(value, 40).toLowerCase() === "approved",
  );
}

function orderNumericId(gid) {
  return text(gid).split("/").pop() || "";
}

function shopHandle(shop) {
  return text(shop).replace(/\.myshopify\.com$/i, "");
}

export async function requireTeamInboxThread(shop, threadKey) {
  const shopDomain = text(shop).toLowerCase();
  const reference = text(threadKey, 80);
  const thread = normalizeThreadKey(reference);
  const match = mongoose.isValidObjectId(reference)
    ? { shop: shopDomain, _id: reference }
    : { shop: shopDomain, threadKey: thread };
  const row = await ConversationThread.findOne(match);
  if (!row) {
    const error = new Error("Conversation not found for this merchant.");
    error.status = 404;
    error.code = "thread_not_found";
    throw error;
  }
  return row;
}

const requireThread = requireTeamInboxThread;

function mapOrder(order, shop) {
  if (!order) return null;
  const money = order?.currentTotalPriceSet?.shopMoney || {};
  const address = order?.shippingAddress || {};
  const tracking = (Array.isArray(order?.fulfillments) ? order.fulfillments : [])
    .flatMap((fulfillment) =>
      Array.isArray(fulfillment?.trackingInfo) ? fulfillment.trackingInfo : [],
    )
    .filter(Boolean);
  const items = (Array.isArray(order?.lineItems?.edges) ? order.lineItems.edges : [])
    .map((edge) => edge?.node)
    .filter(Boolean)
    .map((item) => ({
      id: item.id || null,
      title: text(item.title, 180),
      variantTitle: text(item.variantTitle, 160) || null,
      quantity: Number(item.quantity || 0),
      imageUrl:
        text(item?.image?.url, 1000) ||
        text(item?.variant?.image?.url, 1000) ||
        text(item?.product?.featuredImage?.url, 1000) ||
        null,
      productUrl:
        text(item?.product?.onlineStoreUrl, 1000) ||
        text(item?.variant?.product?.onlineStoreUrl, 1000) ||
        null,
    }));
  return {
    id: order.id || null,
    name: text(order.name, 80) || null,
    createdAt: order.createdAt || null,
    amount: Number(money.amount || 0),
    currencyCode: text(money.currencyCode, 10) || null,
    paymentStatus: text(order.displayFinancialStatus, 60) || null,
    fulfillmentStatus: text(order.displayFulfillmentStatus, 60) || null,
    tags: Array.isArray(order.tags) ? order.tags.map((tag) => text(tag, 100)) : [],
    items,
    shippingAddress: {
      name: text(address.name, 160) || null,
      address1: text(address.address1, 240) || null,
      address2: text(address.address2, 240) || null,
      city: text(address.city, 120) || null,
      province: text(address.province, 120) || null,
      zip: text(address.zip, 40) || null,
      country: text(address.country, 120) || null,
    },
    tracking: tracking.map((row) => ({
      company: text(row.company, 100) || null,
      number: text(row.number, 120) || null,
      url: text(row.url, 1000) || null,
    })),
    adminUrl: order.id
      ? `https://admin.shopify.com/store/${encodeURIComponent(shopHandle(shop))}/orders/${encodeURIComponent(orderNumericId(order.id))}`
      : null,
  };
}

function mapCustomer(order, shop) {
  const customer = order?.customer || {};
  const shipping = order?.shippingAddress || {};
  const billing = order?.billingAddress || {};
  const location = [shipping.city, shipping.province, shipping.country]
    .map((part) => text(part, 120))
    .filter(Boolean)
    .join(", ");
  return {
    id: customer.id || null,
    name:
      text(customer.displayName, 160) ||
      text(shipping.name, 160) ||
      text(billing.name, 160) ||
      null,
    email: text(customer.email, 240) || null,
    phone:
      text(customer.phone, 50) ||
      text(shipping.phone, 50) ||
      text(billing.phone, 50) ||
      null,
    location: location || null,
    tags: Array.isArray(customer.tags)
      ? customer.tags.map((tag) => text(tag, 100))
      : [],
    totalOrders: Number(customer.numberOfOrders || 0) || null,
    totalSpent: Number(customer?.amountSpent?.amount || 0) || null,
    totalSpentCurrency: text(customer?.amountSpent?.currencyCode, 10) || null,
    customerSince: customer.createdAt || null,
    adminUrl: customer.id
      ? `https://admin.shopify.com/store/${encodeURIComponent(shopHandle(shop))}/customers/${encodeURIComponent(orderNumericId(customer.id))}`
      : null,
  };
}

async function findShopifyCustomerByPhone(admin, phoneE164) {
  const normalizedPhone = normalizePhoneE164(phoneE164);
  if (!normalizedPhone) return null;
  const response = await admin.query({
    data: `#graphql
      query TeamInboxCustomerByPhone($query: String!) {
        customers(first: 5, query: $query) {
          nodes {
            id
            displayName
            email
            phone
            tags
            createdAt
            numberOfOrders
            amountSpent { amount currencyCode }
            defaultAddress {
              name
              phone
              city
              province
              country
            }
            orders(first: 5, sortKey: CREATED_AT, reverse: true) {
              nodes { id }
            }
          }
        }
      }
    `,
    variables: { query: `phone:${normalizedPhone}` },
  });
  const errors = Array.isArray(response?.body?.errors)
    ? response.body.errors
    : [];
  if (errors.length) {
    throw new Error(
      errors.map((row) => text(row?.message || row, 200)).filter(Boolean).join(", "),
    );
  }
  return (
    (response?.body?.data?.customers?.nodes || []).find((customer) =>
      teamInboxPhonesMatch(
        customer?.phone || customer?.defaultAddress?.phone,
        normalizedPhone,
      ),
    ) || null
  );
}

export async function getTeamInboxConfig({ shop, account }) {
  const [agents, labels, quickReplies, record] = await Promise.all([
    AgentAccount.find({ shop, active: true })
      .select({ username: 1, slot: 1 })
      .sort({ slot: 1 })
      .lean(),
    TeamInboxLabel.find({ shop }).sort({ name: 1 }).lean(),
    TeamInboxQuickReply.find({ shop }).sort({ title: 1 }).lean(),
    Shop.findOne({ shop })
      .select({ "whatsappSender.ownNumber.managedTemplates": 1 })
      .lean(),
  ]);
  const templates = (
    record?.whatsappSender?.ownNumber?.managedTemplates || []
  )
    .filter(isApprovedTemplate)
    .map((template) => ({
      id: text(template.id, 160),
      displayName: text(template.displayName, 160) || text(template.metaTemplateName, 160),
      metaTemplateName: text(template.metaTemplateName, 160),
      language: text(template.language, 30) || "en",
      bodyText: text(template.bodyText, 4096),
      headerText: text(template.headerText, 1024),
      variables: getTeamInboxTemplateVariableKeys(template),
    }))
    .filter((template) => template.id && template.metaTemplateName);
  return {
    agents: agents.map((agent) => ({ id: String(agent._id), username: agent.username })),
    labels: labels.map((label) => ({ id: String(label._id), name: label.name, color: label.color })),
    quickReplies: quickReplies.map((row) => ({
      id: String(row._id),
      title: row.title,
      shortcut: row.shortcut,
      body: row.body,
    })),
    templates: account?.permissions?.sendTemplates === true ? templates : [],
    permissions: account?.permissions || {},
  };
}

export async function getTeamInboxContext({ shop, threadKey, account, force = false }) {
  const thread = await requireThread(shop, threadKey);
  const canSeeShopify = account?.permissions?.viewShopifyData === true;
  const fresh =
    thread.identitySyncedAt &&
    Date.now() - new Date(thread.identitySyncedAt).getTime() < IDENTITY_CACHE_MS;

  if (canSeeShopify && (!fresh || force)) {
    const attempt = await findTeamInboxLinkedAttempt({ shop, thread });
    const orderGid = thread.lastOrderGid || attempt?.orderGid || null;
    let customerSnapshot = null;
    let orderSnapshot = null;
    try {
      const shopRecord = await Shop.findOne({ shop }).lean();
      const admin = await getAdminClient(shop, {
        accessToken: shopRecord?.accessToken || "",
        record: shopRecord,
      });
      if (orderGid) {
        const fetched = await fetchOrderForCodConfirmTemplate(admin, orderGid);
        const order = fetched?.order || null;
        const orderPhones = [
          order?.customer?.phone,
          order?.shippingAddress?.phone,
          order?.billingAddress?.phone,
          attempt?.phoneE164,
        ];
        if (
          order &&
          orderPhones.some((phone) =>
            teamInboxPhonesMatch(phone, thread.threadKey),
          )
        ) {
          customerSnapshot = mapCustomer(order, shop);
          orderSnapshot = mapOrder(order, shop);
        }
      }
      if (!customerSnapshot) {
        const matchedCustomer = await findShopifyCustomerByPhone(
          admin,
          thread.threadKey,
        );
        if (matchedCustomer) {
          customerSnapshot = mapCustomer(
            {
              customer: matchedCustomer,
              shippingAddress: matchedCustomer.defaultAddress || null,
            },
            shop,
          );
          const latestOrderId = matchedCustomer?.orders?.nodes?.[0]?.id || null;
          if (latestOrderId) {
            const fetched = await fetchOrderForCodConfirmTemplate(
              admin,
              latestOrderId,
            );
            const latestOrder = fetched?.order || null;
            const latestOrderPhones = [
              latestOrder?.customer?.phone,
              latestOrder?.shippingAddress?.phone,
              latestOrder?.billingAddress?.phone,
            ];
            if (
              latestOrder &&
              latestOrderPhones.some((phone) =>
                teamInboxPhonesMatch(phone, thread.threadKey),
              )
            ) {
              orderSnapshot = mapOrder(latestOrder, shop);
            }
          }
        }
      }
    } catch (error) {
      void logAudit({
        shop,
        actor: `agent:${account?.username || "agent"}`,
        action: "team_inbox_shopify_sync_failed",
        level: "warn",
        message: text(error?.message || error, 300),
        meta: { threadKey: thread.threadKey, orderGid },
      });
    }
    const shopifyName = customerSnapshot?.id ? customerSnapshot.name : null;
    const shippingName = orderSnapshot?.shippingAddress?.name || attempt?.customerName || null;
    thread.shopifyCustomerName = shopifyName;
    thread.shippingName = shippingName;
    thread.customerEmail = customerSnapshot?.email || null;
    thread.customerLocation = customerSnapshot?.location || null;
    thread.shopifyCustomerId = customerSnapshot?.id || null;
    thread.customerSnapshot = customerSnapshot;
    thread.orderSnapshot = orderSnapshot;
    thread.lastOrderGid =
      orderSnapshot?.id || orderGid || thread.lastOrderGid;
    thread.identitySyncedAt = new Date();
    thread.displayName = resolveTeamInboxDisplayName(thread);
    await thread.save();
  }

  const hidePhone = account?.permissions?.viewCustomerPhone !== true;
  const hideEmail = account?.permissions?.viewCustomerEmail !== true;
  const customer = thread.customerSnapshot ? { ...thread.customerSnapshot } : null;
  const orderHistory =
    account?.permissions?.viewShopifyData === true
      ? await CodAttempt.find({ shop, phoneE164: thread.threadKey })
          .sort({ createdAt: -1 })
          .limit(10)
          .select({
            orderGid: 1,
            orderName: 1,
            orderAmount: 1,
            orderCurrency: 1,
            status: 1,
            createdAt: 1,
          })
          .lean()
      : [];
  if (customer) {
    if (hidePhone) customer.phone = null;
    if (hideEmail) customer.email = null;
  }
  return {
    thread: {
      threadKey: teamInboxThreadReference(thread),
      displayName: resolveTeamInboxDisplayName(thread, {
        includePhone: !hidePhone,
      }),
      phone: hidePhone ? null : thread.partnerE164,
      status: thread.status,
      snoozedUntil: thread.snoozedUntil,
      assignedAgentId: thread.assignedAgentId ? String(thread.assignedAgentId) : null,
      assignedUsername: thread.assignedUsername,
      labels: thread.labels || [],
    },
    customer: account?.permissions?.viewShopifyData === true ? customer : null,
    order:
      account?.permissions?.viewShopifyData === true
        ? thread.orderSnapshot || null
        : null,
    orderHistory: orderHistory.map((row) => ({
      id: row.orderGid || String(row._id),
      name: row.orderName || "Order",
      amount: Number(row.orderAmount || 0) || null,
      currencyCode: row.orderCurrency || null,
      status: row.status || null,
      createdAt: row.createdAt || null,
      adminUrl: row.orderGid
        ? `https://admin.shopify.com/store/${encodeURIComponent(shopHandle(shop))}/orders/${encodeURIComponent(orderNumericId(row.orderGid))}`
        : null,
    })),
  };
}

export async function updateTeamInboxThread({ shop, threadKey, patch, account }) {
  const thread = await requireThread(shop, threadKey);
  const update = {};
  if (Object.prototype.hasOwnProperty.call(patch, "manualName")) {
    requireAgentPermission(account, "editContacts");
    update.manualName = text(patch.manualName, 160) || null;
    update.displayName =
      update.manualName ||
      thread.shopifyCustomerName ||
      thread.whatsappProfileName ||
      thread.shippingName ||
      thread.partnerE164;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "assignedAgentId")) {
    requireAgentPermission(account, "manageAssignments");
    const requested = text(patch.assignedAgentId, 40);
    if (requested) {
      if (!mongoose.isValidObjectId(requested)) throw Object.assign(new Error("Invalid agent."), { status: 400 });
      const target = await AgentAccount.findOne({ _id: requested, shop, active: true }).lean();
      if (!target) throw Object.assign(new Error("Agent not found for this merchant."), { status: 404 });
      update.assignedAgentId = target._id;
      update.assignedUsername = target.username;
    } else {
      update.assignedAgentId = null;
      update.assignedUsername = null;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "status")) {
    requireAgentPermission(account, "manageStatuses");
    const status = text(patch.status, 30).toLowerCase();
    if (!THREAD_STATUSES.has(status)) throw Object.assign(new Error("Invalid conversation status."), { status: 400 });
    update.status = status;
    update.snoozedUntil = status === "snoozed" ? new Date(patch.snoozedUntil || Date.now() + 60 * 60 * 1000) : null;
    if (status === "snoozed" && !Number.isFinite(update.snoozedUntil.getTime())) {
      throw Object.assign(new Error("Choose a valid snooze time."), { status: 400 });
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "labels")) {
    requireAgentPermission(account, "manageLabels");
    const labels = Array.from(new Set((Array.isArray(patch.labels) ? patch.labels : []).map((row) => text(row, 60)).filter(Boolean))).slice(0, 12);
    const count = await TeamInboxLabel.countDocuments({ shop, name: { $in: labels } });
    if (count !== labels.length) throw Object.assign(new Error("One or more labels are invalid."), { status: 400 });
    update.labels = labels;
  }
  if (!Object.keys(update).length) throw Object.assign(new Error("No supported changes supplied."), { status: 400 });
  await ConversationThread.updateOne({ _id: thread._id, shop }, { $set: update });
  void logAudit({
    shop,
    actor: `agent:${account.username}`,
    action: "team_inbox_thread_updated",
    message: "Conversation details were updated.",
    meta: { threadKey: thread.threadKey, changes: Object.keys(update) },
  });
  publishTeamInboxEvent(shop, "thread.updated", { threadKey: thread.threadKey });
  return getTeamInboxContext({ shop, threadKey: thread.threadKey, account });
}

export async function markTeamInboxRead({ shop, threadKey, account }) {
  const thread = await requireThread(shop, threadKey);
  const now = new Date();
  await Promise.all([
    ConversationThread.updateOne({ _id: thread._id, shop }, { $set: { unreadCount: 0 } }),
    AgentConversationState.updateOne(
      { shop, threadKey: thread.threadKey, agentAccountId: account.id },
      { $set: { lastReadAt: now } },
      { upsert: true },
    ),
  ]);
  publishTeamInboxEvent(shop, "thread.read", { threadKey: thread.threadKey });
  return { readAt: now };
}

export async function saveTeamInboxDraft({ shop, threadKey, draft, account }) {
  const thread = await requireThread(shop, threadKey);
  const cleanDraft = String(draft || "").slice(0, 4096);
  await AgentConversationState.updateOne(
    { shop, threadKey: thread.threadKey, agentAccountId: account.id },
    { $set: { draft: cleanDraft, draftUpdatedAt: new Date() } },
    { upsert: true },
  );
  return { draft: cleanDraft };
}

export async function getTeamInboxDraft({ shop, threadKey, account }) {
  const thread = await requireThread(shop, threadKey);
  const row = await AgentConversationState.findOne({
    shop,
    threadKey: thread.threadKey,
    agentAccountId: account.id,
  }).lean();
  return { draft: row?.draft || "", draftUpdatedAt: row?.draftUpdatedAt || null };
}

export async function addTeamInboxNote({ shop, threadKey, note, account }) {
  requireAgentPermission(account, "writeInternalNotes");
  const thread = await requireThread(shop, threadKey);
  const cleanNote = text(note, 4000);
  if (!cleanNote) throw Object.assign(new Error("Internal note cannot be empty."), { status: 400 });
  const mentions = Array.from(cleanNote.matchAll(/@([a-zA-Z0-9._-]{3,40})/g)).map((match) => match[1].toLowerCase());
  const validMentions = mentions.length
    ? (await AgentAccount.find({ shop, usernameNormalized: { $in: mentions }, active: true }).select({ username: 1 }).lean()).map((row) => row.username)
    : [];
  const created = await TeamInboxNote.create({
    shop,
    threadKey: thread.threadKey,
    agentAccountId: account.id,
    agentUsername: account.username,
    text: cleanNote,
    mentions: validMentions,
  });
  void logAudit({
    shop,
    actor: `agent:${account.username}`,
    action: "team_inbox_note_added",
    message: "An internal note was added.",
    meta: { threadKey: thread.threadKey, noteId: String(created._id), mentions: validMentions },
  });
  publishTeamInboxEvent(shop, "note.created", { threadKey: thread.threadKey });
  return created;
}

export async function listTeamInboxNotes({ shop, threadKey, before = null, limit = 100 }) {
  const thread = await requireThread(shop, threadKey);
  const match = { shop, threadKey: thread.threadKey };
  const beforeDate = before ? new Date(before) : null;
  if (beforeDate && Number.isFinite(beforeDate.getTime())) match.createdAt = { $lt: beforeDate };
  return TeamInboxNote.find(match).sort({ createdAt: -1 }).limit(Math.min(100, limit)).lean();
}

export async function createTeamInboxLabel({ shop, name, color, account }) {
  requireAgentPermission(account, "manageLabels");
  const cleanName = text(name, 60);
  if (!cleanName) throw Object.assign(new Error("Label name is required."), { status: 400 });
  const cleanColor = /^#[0-9a-f]{6}$/i.test(text(color, 10)) ? text(color, 10) : "#0f766e";
  let row;
  try {
    row = await TeamInboxLabel.create({ shop, name: cleanName, normalizedName: cleanName.toLowerCase(), color: cleanColor });
  } catch (error) {
    if (Number(error?.code) === 11000) {
      throw Object.assign(new Error("That label already exists."), { status: 409, code: "label_exists" });
    }
    throw error;
  }
  return { id: String(row._id), name: row.name, color: row.color };
}

export async function createTeamInboxQuickReply({ shop, title, shortcut, body, account }) {
  requireAgentPermission(account, "manageQuickReplies");
  const cleanTitle = text(title, 80);
  const cleanShortcut = text(shortcut, 40).replace(/^\//, "");
  const cleanBody = text(body, 4096);
  if (!cleanTitle || !cleanShortcut || !cleanBody) throw Object.assign(new Error("Title, shortcut, and reply text are required."), { status: 400 });
  let row;
  try {
    row = await TeamInboxQuickReply.create({ shop, title: cleanTitle, shortcut: cleanShortcut, normalizedShortcut: cleanShortcut.toLowerCase(), body: cleanBody });
  } catch (error) {
    if (Number(error?.code) === 11000) {
      throw Object.assign(new Error("That quick-reply shortcut already exists."), { status: 409, code: "quick_reply_exists" });
    }
    throw error;
  }
  return { id: String(row._id), title: row.title, shortcut: row.shortcut, body: row.body };
}

async function updateOrderNote(admin, orderGid, note) {
  const result = await admin.query({
    data: `#graphql mutation TeamInboxOrderNote($input: OrderInput!) { orderUpdate(input: $input) { order { id } userErrors { field message } } }`,
    variables: { input: { id: orderGid, note } },
  });
  const errors = result?.body?.data?.orderUpdate?.userErrors || [];
  if (errors.length) throw new Error(errors.map((row) => row.message).filter(Boolean).join(", "));
}

export async function performTeamInboxOrderAction({ shop, threadKey, action, value, account }) {
  requireAgentPermission(account, "performOrderActions");
  const thread = await requireThread(shop, threadKey);
  const attempt = await findTeamInboxLinkedAttempt({ shop, thread });
  if (!attempt?.orderGid) throw Object.assign(new Error("No Shopify order is linked to this conversation."), { status: 404 });
  const cleanAction = text(action, 30).toLowerCase();
  if (cleanAction === "confirm") await confirmAttempt(attempt._id, `agent:${account.username}`);
  else if (cleanAction === "cancel") await cancelAttempt(attempt._id, `agent:${account.username}`);
  else {
    const shopRecord = await Shop.findOne({ shop }).lean();
    const admin = await getAdminClient(shop, { accessToken: shopRecord?.accessToken || "", record: shopRecord });
    if (cleanAction === "add_tag") {
      const tag = text(value, 100);
      if (!tag) throw Object.assign(new Error("Order tag is required."), { status: 400 });
      await appendOrderTag(admin, attempt.orderGid, tag);
    } else if (cleanAction === "add_note") {
      const note = text(value, 5000);
      if (!note) throw Object.assign(new Error("Order note is required."), { status: 400 });
      await updateOrderNote(admin, attempt.orderGid, note);
    } else {
      throw Object.assign(new Error("Unsupported order action."), { status: 400 });
    }
  }
  void logAudit({
    shop,
    actor: `agent:${account.username}`,
    action: `team_inbox_order_${cleanAction}`,
    message: `Shopify order action ${cleanAction} was completed.`,
    meta: { threadKey: thread.threadKey, orderGid: attempt.orderGid },
  });
  publishTeamInboxEvent(shop, "order.updated", { threadKey: thread.threadKey });
  return { ok: true, orderGid: attempt.orderGid };
}
