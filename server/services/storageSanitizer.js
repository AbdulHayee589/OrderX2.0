function trimString(value, max = 280) {
  const raw = String(value ?? "");
  if (raw.length <= max) return raw;
  return `${raw.slice(0, Math.max(0, max - 1))}…`;
}

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toBoolOrUndefined(value) {
  return value === true ? true : undefined;
}

function compactObject(input = {}) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (value == null) continue;
    if (value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function summarizePlanForStorage(plan) {
  if (!plan || typeof plan !== "object") return null;
  return compactObject({
    key: String(plan.key || "").trim() || null,
    name: trimString(plan.name || "", 80) || null,
    price: toNumberOrNull(plan.price),
    currencyCode: String(plan.currencyCode || "").trim() || null,
    senderMode: String(plan.senderMode || "").trim() || null,
    billingType: String(plan.billingType || "").trim() || null,
    outboundMessageCap: toNumberOrNull(plan.outboundMessageCap),
    templateMessageCap: toNumberOrNull(plan.templateMessageCap),
    upgradePlanKey: String(plan.upgradePlanKey || "").trim() || null,
    usagePrice:
      plan?.usagePrice && typeof plan.usagePrice === "object"
        ? compactObject({
            amount: toNumberOrNull(plan.usagePrice.amount),
            currencyCode:
              String(plan.usagePrice.currencyCode || "").trim() || null,
          })
        : null,
  });
}

function summarizeBillingForStorage(billing) {
  if (!billing || typeof billing !== "object") return null;
  return compactObject({
    active: billing.active === true,
    status: String(billing.status || "").trim() || null,
    planKey:
      String(billing.planKey || billing?.plan?.key || "").trim() || null,
    plan: summarizePlanForStorage(billing.plan),
    trialEndsAt: billing.trialEndsAt || null,
    currentPeriodStart: billing.currentPeriodStart || null,
    currentPeriodEnd: billing.currentPeriodEnd || null,
    byonTrialMessageCap: toNumberOrNull(billing.byonTrialMessageCap),
    byonTrialMessagesUsed: toNumberOrNull(billing.byonTrialMessagesUsed),
    freeConfirmationCap: toNumberOrNull(billing.freeConfirmationCap),
    freeConfirmationMessagesUsed: toNumberOrNull(
      billing.freeConfirmationMessagesUsed,
    ),
    usageCappedAmount: toNumberOrNull(billing.usageCappedAmount),
    usageCappedCurrencyCode:
      String(billing.usageCappedCurrencyCode || "").trim() || null,
  });
}

function summarizeUsageWindowForStorage(window) {
  if (!window || typeof window !== "object") return null;
  return compactObject({
    senderMode: String(window.senderMode || "").trim() || null,
    count: toNumberOrNull(window.count),
    limit: toNumberOrNull(window.limit),
    remaining: toNumberOrNull(window.remaining),
    consuming: toBoolOrUndefined(window.consuming),
  });
}

function summarizeRangeUsageForStorage(value) {
  if (!value || typeof value !== "object") return null;
  return compactObject({
    blocked: value.blocked === true,
    blockedReason: trimString(value.blockedReason || "", 160) || null,
    usedMessages: toNumberOrNull(
      value.usedMessages ?? value.messagesSent ?? value.used,
    ),
    remainingMessages: toNumberOrNull(value.remainingMessages ?? value.remaining),
    limitMessages: toNumberOrNull(value.limitMessages ?? value.limit),
    cycleCount: toNumberOrNull(value.cycleCount),
  });
}

export function summarizeSendGateForStorage(gate) {
  if (!gate || typeof gate !== "object") return gate ?? null;
  return compactObject({
    ok: gate.ok === true,
    reason: trimString(gate.reason || "", 180) || null,
    mode: String(gate.mode || "").trim() || null,
    remaining: toNumberOrNull(gate.remaining),
    senderStatus: String(gate.senderStatus || "").trim() || null,
    senderPaused: toBoolOrUndefined(gate.senderPaused),
    senderErrorStreak: toNumberOrNull(gate.senderErrorStreak),
    senderRegistrationStatus:
      String(gate.senderRegistrationStatus || "").trim() || null,
    senderNeedsReconnect: toBoolOrUndefined(gate.senderNeedsReconnect),
    upgradePlanKey: String(gate.upgradePlanKey || "").trim() || null,
    billing: summarizeBillingForStorage(gate.billing),
    initiatedConversations24h: summarizeUsageWindowForStorage(
      gate.initiatedConversations24h,
    ),
    byonUsage: summarizeRangeUsageForStorage(gate.byonUsage),
    growthUsage: summarizeRangeUsageForStorage(gate.growthUsage),
    freeConfirmationUsage: summarizeRangeUsageForStorage(
      gate.freeConfirmationUsage,
    ),
    meteredConfirmationUsage: summarizeRangeUsageForStorage(
      gate.meteredConfirmationUsage,
    ),
  });
}

function sanitizeGenericMeta(value, depth = 0) {
  if (value == null) return null;
  if (depth > 2) {
    if (typeof value === "string") return trimString(value, 160);
    if (typeof value === "number" || typeof value === "boolean") return value;
    return trimString(JSON.stringify(value), 160);
  }

  if (typeof value === "string") return trimString(value, 280);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value;

  if (Array.isArray(value)) {
    return value
      .slice(0, 8)
      .map((entry) => sanitizeGenericMeta(entry, depth + 1))
      .filter((entry) => entry != null);
  }

  if (typeof value === "object") {
    if (
      Object.prototype.hasOwnProperty.call(value, "ok") &&
      Object.prototype.hasOwnProperty.call(value, "reason")
    ) {
      return summarizeSendGateForStorage(value);
    }

    if (
      value?.billing &&
      typeof value.billing === "object" &&
      Object.prototype.hasOwnProperty.call(value, "senderStatus")
    ) {
      return summarizeSendGateForStorage(value);
    }

    const keys = Object.keys(value).slice(0, 20);
    const out = {};
    for (const key of keys) {
      const sanitized = sanitizeGenericMeta(value[key], depth + 1);
      if (sanitized != null && sanitized !== "") {
        out[key] = sanitized;
      }
    }
    return Object.keys(out).length ? out : null;
  }

  return trimString(String(value), 160);
}

export function sanitizeStoredMeta(value) {
  return sanitizeGenericMeta(value, 0);
}

export function sanitizeAttemptErrorEvents(events, options = {}) {
  const keep = Math.max(1, Math.min(12, Number(options.keep || 10)));
  const rows = Array.isArray(events) ? events.slice(-keep) : [];
  return rows.map((row) =>
    compactObject({
      at: row?.at || new Date(),
      step: trimString(row?.step || "", 40) || "",
      message: trimString(row?.message || "", 240) || "",
      count: Math.max(1, Number(row?.count || 1)),
      meta: sanitizeStoredMeta(row?.meta),
    }),
  );
}

export function sanitizeAttemptChangeRequests(rows, options = {}) {
  const keep = Math.max(1, Math.min(20, Number(options.keep || 20)));
  const requests = Array.isArray(rows) ? rows.slice(-keep) : [];
  return requests.map((row) =>
    compactObject({
      at: row?.at || new Date(),
      kind: trimString(row?.kind || "", 24) || null,
      text: trimString(row?.text || "", 600) || "",
      reconfirmSentAt: row?.reconfirmSentAt || null,
      reconfirmWaMessageId:
        trimString(row?.reconfirmWaMessageId || "", 96) || null,
      resolvedAt: row?.resolvedAt || null,
      resolution: trimString(row?.resolution || "", 24) || null,
    }),
  );
}

const KNOWN_COD_ATTEMPT_KEYS = new Set([
  "_id",
  "__v",
  "shop",
  "orderGid",
  "orderName",
  "orderAmount",
  "orderCurrency",
  "customerName",
  "storeName",
  "phoneE164",
  "countryCode",
  "timezone",
  "confirmedAt",
  "cancelledAt",
  "confirmSource",
  "cancelSource",
  "stage",
  "duplicateGroupId",
  "duplicateRole",
  "duplicateFingerprint",
  "duplicateQueuedAt",
  "duplicateReleasedAt",
  "duplicatePromptSentAt",
  "duplicateNotifyOnSend",
  "duplicateReferenceAttemptId",
  "phoneQueueGroupId",
  "phoneQueueRole",
  "phoneQueuedAt",
  "phoneReleasedAt",
  "senderMode",
  "senderPhoneNumberId",
  "senderQueueKey",
  "status",
  "scheduledAt",
  "manualRescheduledAt",
  "lastTriedAt",
  "waMessageId",
  "waTemplateUsed",
  "waSentAt",
  "waDeliveryStatus",
  "waDeliveryStatusAt",
  "waDeliveryError",
  "supportInfoSentAt",
  "supportInfoCount",
  "changeState",
  "changeKindPending",
  "changeRequestCount",
  "changeRequestedAt",
  "changePromptSentAt",
  "changeDetailsReceivedAt",
  "changeReconfirmSentAt",
  "changeReconfirmWaMessageId",
  "changeProposedName",
  "changeProposedAddress",
  "changeProposedQuantity",
  "changeProposedQuantityLineIndex",
  "changeProposedQuantityProductLabel",
  "changeProposedQuantityOverrides",
  "changeProposedAmountText",
  "changeQtyTargetLineIndex",
  "changeQtyTargetProductLabel",
  "changeRequests",
  "lastError",
  "lastErrorAt",
  "lastErrorMeta",
  "retryCount",
  "errorEvents",
  "confirmTokenHash",
  "cancelTokenHash",
  "tokenExpiresAt",
  "tokenUsedAt",
  "processedAt",
  "expiredAt",
  "expireSource",
  "createdAt",
  "updatedAt",
]);

function stringifyComparable(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

export function buildCodAttemptPruneUpdate(doc) {
  if (!doc || typeof doc !== "object") {
    return { changed: false, update: null };
  }

  const set = {};
  const unset = {};

  for (const key of Object.keys(doc)) {
    if (!KNOWN_COD_ATTEMPT_KEYS.has(key)) {
      unset[key] = "";
    }
  }

  const sanitizedLastErrorMeta =
    doc.lastError == null &&
    ["confirmed", "cancelled", "wa_sent"].includes(String(doc.status || ""))
      ? null
      : sanitizeStoredMeta(doc.lastErrorMeta);
  if (
    stringifyComparable(doc.lastErrorMeta) !==
    stringifyComparable(sanitizedLastErrorMeta)
  ) {
    set.lastErrorMeta = sanitizedLastErrorMeta;
  }

  const sanitizedEvents = sanitizeAttemptErrorEvents(doc.errorEvents, {
    keep: 10,
  });
  if (
    stringifyComparable(doc.errorEvents) !== stringifyComparable(sanitizedEvents)
  ) {
    set.errorEvents = sanitizedEvents;
  }

  const sanitizedRequests = sanitizeAttemptChangeRequests(doc.changeRequests, {
    keep: 20,
  });
  if (
    stringifyComparable(doc.changeRequests) !==
    stringifyComparable(sanitizedRequests)
  ) {
    set.changeRequests = sanitizedRequests;
  }

  const compactAddress = trimString(doc.changeProposedAddress || "", 600) || null;
  if (doc.changeProposedAddress !== compactAddress) {
    set.changeProposedAddress = compactAddress;
  }

  const compactAmount =
    trimString(doc.changeProposedAmountText || "", 160) || null;
  if (doc.changeProposedAmountText !== compactAmount) {
    set.changeProposedAmountText = compactAmount;
  }

  const compactName = trimString(doc.changeProposedName || "", 160) || null;
  if (doc.changeProposedName !== compactName) {
    set.changeProposedName = compactName;
  }

  const changed = Object.keys(set).length > 0 || Object.keys(unset).length > 0;
  if (!changed) return { changed: false, update: null };

  return {
    changed: true,
    update: compactObject({
      ...(Object.keys(set).length ? { $set: set } : {}),
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
    }),
  };
}
