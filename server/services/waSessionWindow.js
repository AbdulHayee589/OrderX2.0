import WaMessageLog from "../models/WaMessageLog.js";

function asString(v) {
  return String(v || "").trim();
}

function normalizePhoneE164(v) {
  const digits = asString(v).replace(/[^\d]/g, "");
  return digits ? `+${digits}` : "";
}

export async function hasRecentInboundForSender({
  shop,
  phoneE164,
  senderPhoneNumberId = "",
  senderMode = "",
  withinHours = 23,
}) {
  const shopDomain = asString(shop);
  const phone = normalizePhoneE164(phoneE164);
  const senderId = asString(senderPhoneNumberId);
  const mode = asString(senderMode).toLowerCase();
  const hours = Number(withinHours);
  if (!shopDomain || !phone || !Number.isFinite(hours) || hours <= 0) {
    return false;
  }

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
  const base = {
    shop: shopDomain,
    direction: "inbound",
    toE164: phone,
    createdAt: { $gte: cutoff },
  };

  if (!senderId) {
    const modeScoped =
      mode === "own_number" || mode === "orderx_number"
        ? {
            ...base,
            senderMode: { $in: [mode, "unknown", "", null] },
          }
        : base;
    const hit = await WaMessageLog.exists(modeScoped);
    return !!hit;
  }

  const hit = await WaMessageLog.exists({
    ...base,
    $or: [
      { senderPhoneNumberId: senderId },
      { "meta.receiverPhoneNumberId": senderId }, // backward compatibility
    ],
  });
  return !!hit;
}
