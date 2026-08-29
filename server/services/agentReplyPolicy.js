export const AGENT_REPLY_WINDOW_HOURS = 24;

const AGENT_REPLY_WINDOW_MS = AGENT_REPLY_WINDOW_HOURS * 60 * 60 * 1000;

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function isAgentReplyBlocked({
  blocked = false,
  blockedAt = null,
  lastInboundAt = null,
  allowNewInboundAfterBlock = false,
} = {}) {
  if (!blocked) return false;
  if (!allowNewInboundAfterBlock) return true;

  const inboundAt = toDate(lastInboundAt);
  const optOutAt = toDate(blockedAt);
  if (!inboundAt || !optOutAt) return true;

  // Keep the automation opt-out in place, but permit human support after a
  // newer customer-initiated message opens a fresh service window.
  return inboundAt.getTime() <= optOutAt.getTime();
}

export function buildAgentReplyState({
  lastInboundAt,
  senderReady = true,
  blocked = false,
  blockedAt = null,
  allowNewInboundAfterBlock = false,
  now = new Date(),
} = {}) {
  const current = toDate(now) || new Date();
  const inboundAt = toDate(lastInboundAt);
  const expiresAt = inboundAt
    ? new Date(inboundAt.getTime() + AGENT_REPLY_WINDOW_MS)
    : null;
  const secondsRemaining = expiresAt
    ? Math.max(0, Math.floor((expiresAt.getTime() - current.getTime()) / 1000))
    : 0;

  if (!senderReady) {
    return {
      canReply: false,
      code: "sender_not_ready",
      notice:
        "Replies are unavailable until the merchant's WhatsApp sender is connected and ready.",
      lastInboundAt: inboundAt?.toISOString() || null,
      expiresAt: expiresAt?.toISOString() || null,
      secondsRemaining,
    };
  }
  if (
    isAgentReplyBlocked({
      blocked,
      blockedAt,
      lastInboundAt: inboundAt,
      allowNewInboundAfterBlock,
    })
  ) {
    return {
      canReply: false,
      code: "contact_blocked",
      notice: allowNewInboundAfterBlock
        ? "This customer opted out after their latest message. Ask them to message again or reply START before continuing."
        : "This customer is on the merchant blocklist. Remove the block before agents can reply.",
      lastInboundAt: inboundAt?.toISOString() || null,
      expiresAt: expiresAt?.toISOString() || null,
      secondsRemaining,
    };
  }
  if (!inboundAt) {
    return {
      canReply: false,
      code: "no_customer_message",
      notice:
        "Agents cannot start new conversations. This customer must message the business first.",
      lastInboundAt: null,
      expiresAt: null,
      secondsRemaining: 0,
    };
  }
  if (!expiresAt || expiresAt.getTime() <= current.getTime()) {
    return {
      canReply: false,
      code: "reply_window_closed",
      notice:
        "The 24-hour WhatsApp customer-service window has closed. Use an approved template or wait for the customer to message again.",
      lastInboundAt: inboundAt.toISOString(),
      expiresAt: expiresAt?.toISOString() || null,
      secondsRemaining: 0,
    };
  }
  return {
    canReply: true,
    code: "reply_window_open",
    notice: "You can reply while the customer service window is open.",
    lastInboundAt: inboundAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    secondsRemaining,
  };
}
