import { EventEmitter } from "node:events";

const events = new EventEmitter();
events.setMaxListeners(1000);
const presence = new Map();
const PRESENCE_TTL_MS = 35_000;

function clean(value) {
  return String(value || "").trim();
}

function eventName(shop) {
  return `shop:${clean(shop).toLowerCase()}`;
}

function prune(now = Date.now()) {
  for (const [key, row] of presence.entries()) {
    if (Number(row?.expiresAt || 0) <= now) presence.delete(key);
  }
}

export function publishTeamInboxEvent(shop, type, payload = {}) {
  const shopDomain = clean(shop).toLowerCase();
  if (!shopDomain) return;
  events.emit(eventName(shopDomain), {
    type: clean(type) || "refresh",
    at: new Date().toISOString(),
    ...payload,
  });
}

export function subscribeTeamInbox(shop, listener) {
  const name = eventName(shop);
  events.on(name, listener);
  return () => events.off(name, listener);
}

export function updateTeamInboxPresence({
  shop,
  threadKey,
  agentId,
  username,
  typing = false,
}) {
  const shopDomain = clean(shop).toLowerCase();
  const thread = clean(threadKey);
  const id = clean(agentId);
  if (!shopDomain || !thread || !id) return [];
  prune();
  presence.set(`${shopDomain}:${thread}:${id}`, {
    shop: shopDomain,
    threadKey: thread,
    agentId: id,
    username: clean(username) || "Agent",
    typing: typing === true,
    expiresAt: Date.now() + PRESENCE_TTL_MS,
  });
  const rows = getTeamInboxPresence({ shop: shopDomain, threadKey: thread });
  publishTeamInboxEvent(shopDomain, "presence", { threadKey: thread, presence: rows });
  return rows;
}

export function clearTeamInboxPresence({ shop, threadKey, agentId }) {
  presence.delete(
    `${clean(shop).toLowerCase()}:${clean(threadKey)}:${clean(agentId)}`,
  );
}

export function getTeamInboxPresence({ shop, threadKey }) {
  prune();
  const shopDomain = clean(shop).toLowerCase();
  const thread = clean(threadKey);
  return Array.from(presence.values())
    .filter((row) => row.shop === shopDomain && row.threadKey === thread)
    .map(({ agentId, username, typing }) => ({ agentId, username, typing }));
}
