export const AGENT_PERMISSION_KEYS = Object.freeze([
  "viewCustomerPhone",
  "viewCustomerEmail",
  "viewShopifyData",
  "editContacts",
  "manageAssignments",
  "manageStatuses",
  "writeInternalNotes",
  "sendMessages",
  "sendMedia",
  "sendTemplates",
  "manageLabels",
  "manageQuickReplies",
  "performOrderActions",
]);

export const AGENT_ACCESS_LEVELS = Object.freeze({
  SUPPORT: "support",
  LIMITED: "limited",
  MANAGER: "manager",
});

const PRESETS = Object.freeze({
  [AGENT_ACCESS_LEVELS.SUPPORT]: {
    viewCustomerPhone: true,
    viewCustomerEmail: true,
    viewShopifyData: true,
    editContacts: false,
    manageAssignments: true,
    manageStatuses: true,
    writeInternalNotes: true,
    sendMessages: true,
    sendMedia: true,
    sendTemplates: true,
    manageLabels: false,
    manageQuickReplies: false,
    performOrderActions: false,
  },
  [AGENT_ACCESS_LEVELS.LIMITED]: {
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
  [AGENT_ACCESS_LEVELS.MANAGER]: Object.fromEntries(
    AGENT_PERMISSION_KEYS.map((key) => [key, true]),
  ),
});

function asText(value) {
  return String(value || "").trim();
}

export function normalizeAgentAccessLevel(value) {
  const level = asText(value).toLowerCase();
  return Object.prototype.hasOwnProperty.call(PRESETS, level)
    ? level
    : AGENT_ACCESS_LEVELS.SUPPORT;
}

export function normalizeAgentPermissions(value, accessLevel = "support") {
  const level = normalizeAgentAccessLevel(accessLevel);
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(
    AGENT_PERMISSION_KEYS.map((key) => [
      key,
      Object.prototype.hasOwnProperty.call(source, key)
        ? source[key] === true
        : PRESETS[level][key] === true,
    ]),
  );
}

export function hasAgentPermission(account, permission) {
  if (!AGENT_PERMISSION_KEYS.includes(permission)) return false;
  return normalizeAgentPermissions(
    account?.permissions,
    account?.accessLevel,
  )[permission] === true;
}

export function requireAgentPermission(account, permission) {
  if (hasAgentPermission(account, permission)) return;
  const error = new Error("Your agent access level does not allow this action.");
  error.status = 403;
  error.code = "agent_permission_denied";
  throw error;
}

export function publicAgentPermissions(account = {}) {
  const accessLevel = normalizeAgentAccessLevel(account?.accessLevel);
  return {
    accessLevel,
    permissions: normalizeAgentPermissions(account?.permissions, accessLevel),
  };
}

export function agentPermissionOptions() {
  return AGENT_PERMISSION_KEYS.map((key) => ({ key }));
}
