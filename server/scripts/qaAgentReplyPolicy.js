import assert from "node:assert/strict";
import {
  AGENT_REPLY_WINDOW_HOURS,
  buildAgentReplyState,
} from "../services/agentReplyPolicy.js";
import {
  evaluateAgentFeatureAccess,
  isAgentBillingTestShop,
} from "../services/agentAccess.js";
import { PLAN_BILLING_TYPES, SENDER_MODES } from "../services/plans.js";
import {
  AGENT_REPLY_KIND_RE,
  shouldCountWhatsAppUsageTowardsCap,
} from "../services/usage.js";
import { mediaSignatureMatches } from "../routes/agents.js";

const now = new Date("2026-07-17T12:00:00.000Z");
const hoursAgo = (hours) => new Date(now.getTime() - hours * 60 * 60 * 1000);

assert.equal(AGENT_REPLY_WINDOW_HOURS, 24);
assert.equal(
  isAgentBillingTestShop("testingstore-1234567932.myshopify.com"),
  true,
);
assert.equal(isAgentBillingTestShop("another-store.myshopify.com"), false);
assert.equal(AGENT_REPLY_KIND_RE.test("agent_reply_text"), true);
assert.equal(AGENT_REPLY_KIND_RE.test("cod_confirm_template"), false);
assert.equal(
  shouldCountWhatsAppUsageTowardsCap({ excludeFromCap: true }),
  false,
);
assert.equal(shouldCountWhatsAppUsageTowardsCap({}), true);
assert.equal(
  mediaSignatureMatches(Buffer.from([0xff, 0xd8, 0xff, 0x00]), "image/jpeg"),
  true,
);
assert.equal(
  mediaSignatureMatches(Buffer.from("not-an-image"), "image/jpeg"),
  false,
);
assert.equal(
  mediaSignatureMatches(
    Buffer.concat([
      Buffer.from("OggS"),
      Buffer.alloc(24),
      Buffer.from("OpusHead"),
    ]),
    "audio/ogg",
  ),
  true,
);

const byonPlan = {
  key: "own_number_starter_5",
  senderMode: SENDER_MODES.OWN_NUMBER,
  billingType: PLAN_BILLING_TYPES.SHOPIFY_FLAT,
};
const orderxPlan = {
  key: "orderx_metered_4",
  senderMode: SENDER_MODES.ORDERX_NUMBER,
  billingType: PLAN_BILLING_TYPES.SHOPIFY_METERED,
};
const activeBilling = {
  status: "ACTIVE",
  subscriptionId: "gid://shopify/AppSubscription/1",
  planKey: byonPlan.key,
};
const connectedOwnNumber = {
  status: "ready",
  wabaId: "waba-1",
  phoneNumberId: "phone-1",
  accessToken: "encrypted-or-plain-token",
  accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
  registrationStatus: "registered",
};

assert.equal(
  evaluateAgentFeatureAccess({
    shop: "merchant.myshopify.com",
    billing: activeBilling,
    plan: byonPlan,
    ownNumber: connectedOwnNumber,
    now,
  }).allowed,
  true,
);
assert.equal(
  evaluateAgentFeatureAccess({
    shop: "merchant.myshopify.com",
    billing: { ...activeBilling, planKey: orderxPlan.key },
    plan: orderxPlan,
    ownNumber: connectedOwnNumber,
    now,
  }).code,
  "agent_byon_required",
);
assert.equal(
  evaluateAgentFeatureAccess({
    shop: "merchant.myshopify.com",
    billing: activeBilling,
    plan: byonPlan,
    ownNumber: {},
    now,
  }).code,
  "agent_sender_not_connected",
);
assert.equal(
  evaluateAgentFeatureAccess({
    shop: "merchant.myshopify.com",
    billing: { status: "NONE", planKey: byonPlan.key },
    plan: byonPlan,
    ownNumber: connectedOwnNumber,
    now,
  }).code,
  "agent_billing_inactive",
);
assert.equal(
  evaluateAgentFeatureAccess({
    shop: "testingstore-1234567932.myshopify.com",
    billing: { status: "NONE", planKey: byonPlan.key },
    plan: byonPlan,
    ownNumber: connectedOwnNumber,
    now,
  }).allowed,
  true,
);

assert.deepEqual(buildAgentReplyState({ now }).code, "no_customer_message");

assert.deepEqual(
  buildAgentReplyState({
    now,
    lastInboundAt: hoursAgo(1),
    senderReady: false,
  }).code,
  "sender_not_ready",
);

assert.deepEqual(
  buildAgentReplyState({
    now,
    lastInboundAt: hoursAgo(1),
    blocked: true,
  }).code,
  "contact_blocked",
);

const optOutThenNewCustomerMessage = buildAgentReplyState({
  now,
  blocked: true,
  blockedAt: hoursAgo(2),
  lastInboundAt: hoursAgo(1),
  allowNewInboundAfterBlock: true,
});
assert.equal(optOutThenNewCustomerMessage.canReply, true);
assert.equal(optOutThenNewCustomerMessage.code, "reply_window_open");

const optOutIsStillLatestEvent = buildAgentReplyState({
  now,
  blocked: true,
  blockedAt: hoursAgo(1),
  lastInboundAt: hoursAgo(2),
  allowNewInboundAfterBlock: true,
});
assert.equal(optOutIsStillLatestEvent.canReply, false);
assert.equal(optOutIsStillLatestEvent.code, "contact_blocked");

const manualBlockSurvivesNewInbound = buildAgentReplyState({
  now,
  blocked: true,
  blockedAt: hoursAgo(2),
  lastInboundAt: hoursAgo(1),
});
assert.equal(manualBlockSurvivesNewInbound.canReply, false);
assert.equal(manualBlockSurvivesNewInbound.code, "contact_blocked");

const justInside = buildAgentReplyState({
  now,
  lastInboundAt: new Date(now.getTime() - (24 * 60 * 60 * 1000 - 1_000)),
});
assert.equal(justInside.canReply, true);
assert.equal(justInside.code, "reply_window_open");
assert.equal(justInside.secondsRemaining, 1);

const exactBoundary = buildAgentReplyState({
  now,
  lastInboundAt: hoursAgo(24),
});
assert.equal(exactBoundary.canReply, false);
assert.equal(exactBoundary.code, "reply_window_closed");

const invalidDate = buildAgentReplyState({
  now,
  lastInboundAt: "not-a-date",
});
assert.equal(invalidDate.canReply, false);
assert.equal(invalidDate.code, "no_customer_message");

console.log("Agent reply policy QA passed (24-hour boundary enforced).");
