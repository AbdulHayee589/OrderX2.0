export function normalizeComplianceTopic(topic) {
  return String(topic || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
}
