function asText(value) {
  return String(value || "").trim();
}

export function getTeamInboxTemplateVariableKeys(template = {}) {
  const expression = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  const values = [
    template?.headerText,
    template?.bodyText,
    ...(Array.isArray(template?.buttons)
      ? template.buttons.map((button) => button?.url)
      : []),
  ];
  const keys = new Set();
  for (const value of values) {
    for (const match of String(value || "").matchAll(expression)) {
      const key = asText(match[1]).toLowerCase();
      if (key) keys.add(key);
    }
  }
  return Array.from(keys);
}

export function sanitizeTeamInboxTemplateVariables(
  input = {},
  allowedKeys = [],
) {
  const source =
    input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const allowed = new Set(allowedKeys);
  return Object.fromEntries(
    Object.entries(source)
      .map(([key, value]) => [asText(key).toLowerCase(), asText(value)])
      .filter(([key]) => allowed.has(key))
      .map(([key, value]) => [key, value.slice(0, 2048)]),
  );
}
