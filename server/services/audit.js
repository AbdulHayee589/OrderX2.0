import AuditLog from "../models/AuditLog.js";

export async function logAudit(event) {
  try {
    const shop = String(event?.shop || "").trim();
    const action = String(event?.action || "").trim();
    if (!shop || !action) return null;

    const actor = String(event?.actor || "system").trim() || "system";
    const levelRaw = String(event?.level || "info").trim().toLowerCase();
    const level =
      levelRaw === "warn" || levelRaw === "error" ? levelRaw : "info";
    const message = String(event?.message || "").trim();
    const meta = event?.meta ?? null;

    return await AuditLog.create({
      shop,
      actor,
      action,
      level,
      message,
      meta,
    });
  } catch {
    // Never block product flows due to audit logging failures.
    return null;
  }
}

