import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentReplyState, AGENT_REPLY_WINDOW_HOURS } from "../services/agentReplyPolicy.js";
import { normalizeAgentPermissions, hasAgentPermission } from "../services/agentPermissions.js";
import { resolveConversationDisplayName } from "../services/messageInbox.js";
import { createAgentMediaPath, isValidAgentMediaSignature } from "../services/agentMediaTokens.js";
import {
  getMissingAgentTemplateVariables,
  isAgentTemplateApproved,
} from "../services/agentMessenger.js";
import { getWhatsAppMessageAcceptance } from "../services/whatsapp.js";
import {
  resolveTeamInboxDisplayName,
  teamInboxPhonesMatch,
} from "../services/teamInbox.js";
import { buildCorsOptions } from "../middleware/security.js";
import {
  getTeamInboxTemplateVariableKeys,
  sanitizeTeamInboxTemplateVariables,
} from "../services/teamInboxTemplateVariables.js";

test("Team Inbox uses the exact 24-hour customer service window", () => {
  assert.equal(AGENT_REPLY_WINDOW_HOURS, 24);
  const now = new Date("2026-07-22T12:00:00.000Z");
  assert.equal(buildAgentReplyState({ now, lastInboundAt: new Date(now.getTime() - 24 * 60 * 60 * 1000 + 1000) }).canReply, true);
  assert.equal(buildAgentReplyState({ now, lastInboundAt: new Date(now.getTime() - 24 * 60 * 60 * 1000) }).canReply, false);
});

test("customer name priority is manual, Shopify, WhatsApp, shipping, then phone", () => {
  const base = { manualName: "Manual", shopifyCustomerName: "Shopify", whatsappProfileName: "WhatsApp", shippingName: "Shipping", partnerE164: "+923000000000" };
  assert.equal(resolveConversationDisplayName(base), "Manual");
  assert.equal(resolveConversationDisplayName({ ...base, manualName: null }), "Shopify");
  assert.equal(resolveConversationDisplayName({ ...base, manualName: null, shopifyCustomerName: null }), "WhatsApp");
  assert.equal(resolveConversationDisplayName({ ...base, manualName: null, shopifyCustomerName: null, whatsappProfileName: null }), "Shipping");
  assert.equal(resolveConversationDisplayName({ partnerE164: "+923000000000" }), "+923000000000");
});

test("Shopify identity matching requires the complete normalized phone number", () => {
  assert.equal(teamInboxPhonesMatch("+92 300 1234567", "+923001234567"), true);
  assert.equal(teamInboxPhonesMatch("0300 1234567", "+923001234567"), true);
  assert.equal(teamInboxPhonesMatch("1234567", "+923001234567"), false);
});

test("limited agents cannot view phone or perform order actions", () => {
  const permissions = normalizeAgentPermissions(null, "limited");
  const account = { accessLevel: "limited", permissions };
  assert.equal(hasAgentPermission(account, "viewCustomerPhone"), false);
  assert.equal(hasAgentPermission(account, "performOrderActions"), false);
  assert.equal(hasAgentPermission(account, "writeInternalNotes"), true);
});

test("customer display names do not fall back to phone when phone access is hidden", () => {
  const phoneOnly = {
    displayName: "+923000000000",
    partnerE164: "+923000000000",
    threadKey: "+923000000000",
  };
  assert.equal(
    resolveTeamInboxDisplayName(phoneOnly, { includePhone: false }),
    "Customer",
  );
  assert.equal(
    resolveTeamInboxDisplayName(phoneOnly, { includePhone: true }),
    "+923000000000",
  );
  assert.equal(
    resolveTeamInboxDisplayName(
      { ...phoneOnly, whatsappProfileName: "Ayesha" },
      { includePhone: false },
    ),
    "Ayesha",
  );
  assert.equal(
    resolveTeamInboxDisplayName(
      { ...phoneOnly, displayName: "Legacy friendly name" },
      { includePhone: false },
    ),
    "Legacy friendly name",
  );
});

test("media links are signed and expire", () => {
  const previous = process.env.AGENT_MEDIA_SIGNING_SECRET;
  process.env.AGENT_MEDIA_SIGNING_SECRET = "team-inbox-test-secret";
  const now = Date.now();
  const path = createAgentMediaPath("507f1f77bcf86cd799439011", now);
  const url = new URL(path, "https://example.test");
  assert.equal(isValidAgentMediaSignature("507f1f77bcf86cd799439011", url.searchParams.get("e"), url.searchParams.get("s")), true);
  assert.equal(isValidAgentMediaSignature("different", url.searchParams.get("e"), url.searchParams.get("s")), false);
  if (previous == null) delete process.env.AGENT_MEDIA_SIGNING_SECRET;
  else process.env.AGENT_MEDIA_SIGNING_SECRET = previous;
});

test("expired-window sending can only select Meta-approved templates", () => {
  assert.equal(isAgentTemplateApproved({ status: "approved" }), true);
  assert.equal(isAgentTemplateApproved({ status: "draft", rawStatus: "APPROVED" }), true);
  assert.equal(isAgentTemplateApproved({ status: "pending" }), false);
  assert.equal(isAgentTemplateApproved({ status: "rejected" }), false);
  assert.deepEqual(
    getMissingAgentTemplateVariables(
      {
        bodyText: "Hi {{customer_name}}, track at {{tracking_url}}.",
      },
      { customer_name: "Ayesha" },
    ),
    ["tracking_url"],
  );
});

test("Team Inbox CORS allows thread PATCH requests", () => {
  assert.equal(buildCorsOptions().methods.includes("PATCH"), true);
});

test("approved template variables are exposed and overrides are constrained", () => {
  const template = {
    headerText: "Update for {{customer_name}}",
    bodyText: "Order {{order_number}} is with {{courier_name}}.",
    buttons: [{ type: "URL", url: "https://track.test/{{tracking_number}}" }],
  };
  assert.deepEqual(getTeamInboxTemplateVariableKeys(template), [
    "customer_name",
    "order_number",
    "courier_name",
    "tracking_number",
  ]);
  assert.deepEqual(
    sanitizeTeamInboxTemplateVariables(
      {
        customer_name: " Ayesha ",
        order_number: "#1042",
        unsupported_secret: "must not pass through",
      },
      getTeamInboxTemplateVariableKeys(template),
    ),
    { customer_name: "Ayesha", order_number: "#1042" },
  );
});

test("WhatsApp sends require a Meta message identifier before success is shown", () => {
  assert.deepEqual(
    getWhatsAppMessageAcceptance({
      messages: [{ id: "wamid.accepted", message_status: "accepted" }],
    }),
    { waMessageId: "wamid.accepted", messageStatus: "accepted" },
  );
  assert.deepEqual(getWhatsAppMessageAcceptance({ messages: [{}] }), {
    waMessageId: null,
    messageStatus: "accepted",
  });
  assert.deepEqual(
    getWhatsAppMessageAcceptance({
      messages: [
        {
          id: "wamid.held",
          message_status: "held_for_quality_assessment",
        },
      ],
    }),
    {
      waMessageId: "wamid.held",
      messageStatus: "held_for_quality_assessment",
    },
  );
});
