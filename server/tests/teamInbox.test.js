import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import mongoose from "mongoose";

let mongod;
let dbPath;
let mongoReady = false;
let AgentAccount;
let ConversationThread;
let AgentConversationState;
let AgentSendReceipt;
let CodAttempt;
let TeamInboxNote;
let WaMessageLog;
let teamInbox;
let messageInbox;
let agentMessenger;

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForMongo(uri) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 300 });
      return true;
    } catch {
      await mongoose.disconnect().catch(() => null);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return false;
}

before(async (context) => {
  const lookup = spawnSync("sh", ["-c", "command -v mongod"], { encoding: "utf8" });
  const binary = String(lookup.stdout || "").trim();
  if (!binary) {
    context.skip("mongod is unavailable; Team Inbox integration tests require local MongoDB");
    return;
  }
  const port = await freePort();
  dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "orderx-team-inbox-test-"));
  mongod = spawn(binary, ["--dbpath", dbPath, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  const uri = `mongodb://127.0.0.1:${port}/orderx_team_inbox_test`;
  if (!(await waitForMongo(uri))) throw new Error("Local Team Inbox test MongoDB did not start");
  mongoReady = true;
  ({ default: AgentAccount } = await import("../models/AgentAccount.js"));
  ({ default: ConversationThread } = await import("../models/ConversationThread.js"));
  ({ default: AgentConversationState } = await import("../models/AgentConversationState.js"));
  ({ default: AgentSendReceipt } = await import("../models/AgentSendReceipt.js"));
  ({ default: CodAttempt } = await import("../models/CodAttempt.js"));
  ({ default: TeamInboxNote } = await import("../models/TeamInboxNote.js"));
  ({ default: WaMessageLog } = await import("../models/WaMessageLog.js"));
  teamInbox = await import("../services/teamInbox.js");
  messageInbox = await import("../services/messageInbox.js");
  agentMessenger = await import("../services/agentMessenger.js");
}, { timeout: 20_000 });

beforeEach(async () => {
  if (mongoReady) await mongoose.connection.db.dropDatabase();
});

after(async () => {
  await mongoose.disconnect().catch(() => null);
  if (mongod) {
    mongod.kill("SIGTERM");
    await new Promise((resolve) => mongod.once("exit", resolve));
  }
  if (dbPath) fs.rmSync(dbPath, { recursive: true, force: true });
});

function manager(id, username = "manager") {
  return {
    id: String(id),
    username,
    accessLevel: "manager",
    permissions: {
      viewCustomerPhone: true,
      viewCustomerEmail: true,
      viewShopifyData: true,
      editContacts: true,
      manageAssignments: true,
      manageStatuses: true,
      writeInternalNotes: true,
      sendMedia: true,
      sendTemplates: true,
      manageLabels: true,
      performOrderActions: true,
    },
  };
}

function limited(id, username = "limited") {
  return {
    id: String(id),
    username,
    accessLevel: "limited",
    permissions: {
      viewCustomerPhone: false,
      viewCustomerEmail: false,
      viewShopifyData: false,
      editContacts: false,
      manageAssignments: false,
      manageStatuses: true,
      writeInternalNotes: true,
      sendMessages: true,
      sendMedia: false,
      sendTemplates: true,
      manageLabels: false,
      manageQuickReplies: false,
      performOrderActions: false,
    },
  };
}

test("conversation mutations are tenant-isolated and assignment stays inside merchant", async (context) => {
  if (!mongoReady) return context.skip();
  const [agentA, agentB] = await AgentAccount.create([
    { shop: "a.myshopify.com", username: "agent.a", usernameNormalized: "agent.a", passwordHash: "x", passwordSalt: "y", slot: 1 },
    { shop: "b.myshopify.com", username: "agent.b", usernameNormalized: "agent.b", passwordHash: "x", passwordSalt: "y", slot: 1 },
  ]);
  const threadA = await ConversationThread.create({ shop: "a.myshopify.com", threadKey: "+923001111111", partnerE164: "+923001111111", unreadCount: 2 });

  await assert.rejects(
    teamInbox.updateTeamInboxThread({ shop: "b.myshopify.com", threadKey: "+923001111111", patch: { status: "resolved" }, account: manager(agentB._id, "agent.b") }),
    (error) => error.status === 404,
  );
  await assert.rejects(
    teamInbox.updateTeamInboxThread({ shop: "b.myshopify.com", threadKey: String(threadA._id), patch: { status: "resolved" }, account: manager(agentB._id, "agent.b") }),
    (error) => error.status === 404,
  );
  await assert.rejects(
    teamInbox.updateTeamInboxThread({ shop: "a.myshopify.com", threadKey: "+923001111111", patch: { assignedAgentId: String(agentB._id) }, account: manager(agentA._id, "agent.a") }),
    (error) => error.status === 404,
  );
  await teamInbox.updateTeamInboxThread({ shop: "a.myshopify.com", threadKey: "+923001111111", patch: { assignedAgentId: String(agentA._id), status: "waiting" }, account: manager(agentA._id, "agent.a") });
  const row = await ConversationThread.findOne({ shop: "a.myshopify.com" }).lean();
  assert.equal(String(row.assignedAgentId), String(agentA._id));
  assert.equal(row.status, "waiting");
});

test("mark read clears unread and keeps a per-agent read state", async (context) => {
  if (!mongoReady) return context.skip();
  const agent = await AgentAccount.create({ shop: "a.myshopify.com", username: "reader", usernameNormalized: "reader", passwordHash: "x", passwordSalt: "y", slot: 1 });
  await ConversationThread.create({ shop: "a.myshopify.com", threadKey: "+923002222222", partnerE164: "+923002222222", unreadCount: 4 });
  await teamInbox.markTeamInboxRead({ shop: "a.myshopify.com", threadKey: "+923002222222", account: manager(agent._id, "reader") });
  assert.equal((await ConversationThread.findOne({ shop: "a.myshopify.com" }).lean()).unreadCount, 0);
  assert.ok((await AgentConversationState.findOne({ shop: "a.myshopify.com", agentAccountId: agent._id }).lean()).lastReadAt);
});

test("internal notes are merchant scoped and never become WhatsApp logs", async (context) => {
  if (!mongoReady) return context.skip();
  const agent = await AgentAccount.create({ shop: "a.myshopify.com", username: "notes.agent", usernameNormalized: "notes.agent", passwordHash: "x", passwordSalt: "y", slot: 1 });
  await ConversationThread.create({ shop: "a.myshopify.com", threadKey: "+923003333333", partnerE164: "+923003333333" });
  await teamInbox.addTeamInboxNote({ shop: "a.myshopify.com", threadKey: "+923003333333", note: "Check this @notes.agent", account: manager(agent._id, "notes.agent") });
  assert.equal(await TeamInboxNote.countDocuments({ shop: "a.myshopify.com" }), 1);
  assert.equal(await TeamInboxNote.countDocuments({ shop: "b.myshopify.com" }), 0);
  assert.equal(await WaMessageLog.countDocuments({ shop: "a.myshopify.com" }), 0);
});

test("local inbound-to-agent-open flow updates identity, unread, and status safely", async (context) => {
  if (!mongoReady) return context.skip();
  const agent = await AgentAccount.create({
    shop: "a.myshopify.com",
    username: "flow.agent",
    usernameNormalized: "flow.agent",
    passwordHash: "x",
    passwordSalt: "y",
    slot: 1,
  });
  const inboundAt = new Date("2026-07-22T12:00:00.000Z");
  await messageInbox.touchConversationThreadFromLog({
    shop: "a.myshopify.com",
    toE164: "+923004444444",
    direction: "inbound",
    createdAt: inboundAt,
    waMessageId: "wamid.local-inbound",
    kind: "customer_reply",
    text: "I need help with my order",
    meta: { whatsappProfileName: "Ayesha Khan", waId: "923004444444" },
  });

  let thread = await ConversationThread.findOne({
    shop: "a.myshopify.com",
    threadKey: "+923004444444",
  }).lean();
  assert.equal(thread.whatsappProfileName, "Ayesha Khan");
  assert.equal(thread.waId, "923004444444");
  assert.equal(thread.status, "new");
  assert.equal(thread.unreadCount, 1);
  assert.equal(thread.inboundCount, 1);

  await teamInbox.markTeamInboxRead({
    shop: "a.myshopify.com",
    threadKey: "+923004444444",
    account: manager(agent._id, "flow.agent"),
  });
  await messageInbox.touchConversationThreadFromLog({
    shop: "a.myshopify.com",
    toE164: "+923004444444",
    direction: "outbound",
    createdAt: new Date(inboundAt.getTime() + 60_000),
    waMessageId: "wamid.local-agent-reply",
    kind: "agent_reply_text",
    text: "I can help with that.",
    meta: { source: "agent_messenger", agentUsername: "flow.agent" },
  });

  thread = await ConversationThread.findOne({
    shop: "a.myshopify.com",
    threadKey: "+923004444444",
  }).lean();
  assert.equal(thread.unreadCount, 0);
  assert.equal(thread.outboundCount, 1);
  assert.equal(thread.lastDirection, "outbound");
  assert.equal(thread.lastMessagePreview, "I can help with that.");
});

test("client message IDs prevent duplicate agent replies before Meta dispatch", async (context) => {
  if (!mongoReady) return context.skip();
  await AgentSendReceipt.collection.createIndex(
    { shop: 1, agentAccountId: 1, clientMessageId: 1 },
    { unique: true, name: "agent_send_idempotency_unique" },
  );
  const agent = await AgentAccount.create({
    shop: "a.myshopify.com",
    username: "sender.agent",
    usernameNormalized: "sender.agent",
    passwordHash: "x",
    passwordSalt: "y",
    slot: 1,
  });
  const actor = manager(agent._id, "sender.agent");
  await agentMessenger.claimAgentSend({
    shop: "a.myshopify.com",
    threadKey: "+923005555555",
    actor,
    clientMessageId: "local-client-send-1",
  });
  await assert.rejects(
    agentMessenger.claimAgentSend({
      shop: "a.myshopify.com",
      threadKey: "+923005555555",
      actor,
      clientMessageId: "local-client-send-1",
    }),
    (error) =>
      error.status === 409 && error.code === "duplicate_agent_reply",
  );
});

test("repeat-customer order actions resolve the exact order linked to the thread", async (context) => {
  if (!mongoReady) return context.skip();
  const shop = "repeat.myshopify.com";
  const phoneE164 = "+923006666666";
  const linkedOrderGid = "gid://shopify/Order/1001";
  const newerOrderGid = "gid://shopify/Order/1002";
  const [linkedAttempt] = await CodAttempt.create([
    {
      shop,
      orderGid: linkedOrderGid,
      orderName: "#1001",
      phoneE164,
      createdAt: new Date("2026-07-20T10:00:00.000Z"),
    },
    {
      shop,
      orderGid: newerOrderGid,
      orderName: "#1002",
      phoneE164,
      createdAt: new Date("2026-07-21T10:00:00.000Z"),
    },
  ]);
  const thread = await ConversationThread.create({
    shop,
    threadKey: phoneE164,
    partnerE164: phoneE164,
    lastOrderGid: linkedOrderGid,
  });

  const resolved = await teamInbox.findTeamInboxLinkedAttempt({ shop, thread });
  assert.equal(String(resolved?._id), String(linkedAttempt._id));
  assert.equal(resolved?.orderGid, linkedOrderGid);

  thread.lastOrderGid = "gid://shopify/Order/missing";
  const missing = await teamInbox.findTeamInboxLinkedAttempt({ shop, thread });
  assert.equal(missing, null);
});

test("phone-hidden agents never receive a phone number as the customer display name", async (context) => {
  if (!mongoReady) return context.skip();
  const shop = "privacy.myshopify.com";
  const phoneE164 = "+923007777777";
  const agent = await AgentAccount.create({
    shop,
    username: "privacy.agent",
    usernameNormalized: "privacy.agent",
    passwordHash: "x",
    passwordSalt: "y",
    slot: 1,
  });
  await ConversationThread.create({
    shop,
    threadKey: phoneE164,
    partnerE164: phoneE164,
    displayName: phoneE164,
  });
  const account = limited(agent._id, "privacy.agent");

  const threads = await agentMessenger.listAgentThreads({ shop, account });
  assert.equal(threads.items[0]?.partnerE164, null);
  assert.equal(threads.items[0]?.displayName, "Customer");
  assert.notEqual(threads.items[0]?.threadKey, phoneE164);
  assert.equal(JSON.stringify(threads).includes(phoneE164), false);

  const messages = await agentMessenger.listAgentMessages({
    shop,
    threadKey: threads.items[0]?.threadKey,
    account,
  });
  assert.equal(messages.thread.partnerE164, null);
  assert.equal(messages.thread.displayName, "Customer");
  assert.equal(JSON.stringify(messages).includes(phoneE164), false);

  const contextResult = await teamInbox.getTeamInboxContext({
    shop,
    threadKey: threads.items[0]?.threadKey,
    account,
  });
  assert.equal(contextResult.thread.phone, null);
  assert.equal(contextResult.thread.displayName, "Customer");
  assert.equal(contextResult.thread.threadKey, threads.items[0]?.threadKey);
  assert.equal(JSON.stringify(contextResult).includes(phoneE164), false);
});
