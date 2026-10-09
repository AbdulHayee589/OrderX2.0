// server/jobs/definitions.js
import crypto from "crypto";
import { agenda } from "./agenda.js";
import CodAttempt from "../models/CodAttempt.js";
import Shop from "../models/Shop.js";
import BlockedContact from "../models/BlockedContact.js";
import "./pollCodOrders.js";

import {
  isWithinWorkingHours,
  nextAllowedTimeUTC,
  resolveTimezoneFromCountry,
} from "../services/timezone.js";

import { canSendWhatsApp, incrementWhatsAppUsage } from "../services/usage.js";
import {
  sendCodConfirmTemplate,
  sendDeliveryFailedRedeliverTemplate,
  isOwnNumberAccessLostGraphError,
  resolveRuntimeConfig,
  sendWhatsAppText,
} from "../services/whatsapp.js";
import {
  isMetaAccessTokenExpired,
  maybeRefreshByonAccessToken,
} from "../services/metaByonAuth.js";
import {
  reconcilePendingShopifyUsageCharges,
  reconcileShopifyUsageBalances,
} from "../services/shopifyUsageBilling.js";
import { syncBillingFromShopify } from "../services/shopifyBillingSync.js";
import { migrateLegacyOfflineTokensBatch } from "../services/shopifyOfflineTokens.js";
import { releaseQueuesAfterAttemptResolved } from "../services/attemptQueueRelease.js";
import { hasRecentInboundForSender } from "../services/waSessionWindow.js";
import { SENDER_MODES } from "../services/plans.js";
import { pollAbandonedCartRecoveries } from "../services/abandonedCartRecovery.js";
import { pollReviewRequestRecoveries } from "../services/reviewRequestRecovery.js";
import {
  appendOrderTag,
  fetchOrderForCodConfirmTemplate,
  fetchOrderTags,
  getAdminClient,
  removeOrderTags,
} from "../services/shopifyAdmin.js";
import {
  clearMetaErrorOrderTags,
  isRecipientNoWhatsappError,
  tagOrderForMetaSendError,
} from "../services/noWhatsappTag.js";
import {
  failCampaignRun,
  processCampaignRun,
} from "../services/campaignRuns.js";
import {
  sanitizeStoredMeta,
  sanitizeAttemptErrorEvents,
  summarizeSendGateForStorage,
} from "../services/storageSanitizer.js";
import { cleanupOldAgendaJobs } from "../services/agendaMaintenance.js";
import { buildShopifyCredentialCandidateQuery } from "../services/shopifyTokenState.js";
import { syncAttemptOutcomeTags } from "../services/attemptActions.js";

const BILLING_SYNC_TTL_MIN = Number(process.env.BILLING_SYNC_TTL_MIN || 15);
const SEND_LOCK_MIN = Number(process.env.SEND_LOCK_MIN || 5);
const WA_MAX_RETRIES = Number(process.env.WA_MAX_RETRIES || 5);
const AUTO_CANCEL_UNCONFIRMED_HOURS = 48;
const BYON_TOKEN_REFRESH_LEAD_DAYS = Number(
  process.env.BYON_TOKEN_REFRESH_LEAD_DAYS || 10,
);
const BYON_TOKEN_REFRESH_BATCH = Number(
  process.env.BYON_TOKEN_REFRESH_BATCH || 100,
);
const BYON_TOKEN_REFRESH_COOLDOWN_HOURS = Number(
  process.env.BYON_TOKEN_REFRESH_COOLDOWN_HOURS || 6,
);
const BYON_TOKEN_UNKNOWN_EXPIRY_RETRY_DAYS = Number(
  process.env.BYON_TOKEN_UNKNOWN_EXPIRY_RETRY_DAYS || 7,
);
const BYON_TOKEN_REFRESH_INTERVAL =
  String(process.env.BYON_TOKEN_REFRESH_INTERVAL || "6 hours").trim() ||
  "6 hours";
const BYON_TOKEN_REFRESH_STARTUP_RUN =
  String(process.env.BYON_TOKEN_REFRESH_STARTUP_RUN || "true")
    .trim()
    .toLowerCase() !== "false";
const COD_ORDER_POLL_INTERVAL =
  String(process.env.COD_ORDER_POLL_INTERVAL || "1 minute").trim() ||
  "1 minute";
const PENDING_ATTEMPT_RECOVERY_INTERVAL =
  String(process.env.PENDING_ATTEMPT_RECOVERY_INTERVAL || "2 minutes").trim() ||
  "2 minutes";
const CONFIRMATION_TAG_REPAIR_INTERVAL =
  String(process.env.CONFIRMATION_TAG_REPAIR_INTERVAL || "5 minutes").trim() ||
  "5 minutes";
const STALE_PENDING_GRACE_MIN = Math.max(
  SEND_LOCK_MIN + 1,
  Number(process.env.STALE_PENDING_GRACE_MIN || SEND_LOCK_MIN + 1),
);
const CONFIRMATION_TAG_REPAIR_BATCH = Math.max(
  1,
  Number(process.env.CONFIRMATION_TAG_REPAIR_BATCH || 100),
);
const CONFIRMATION_TAG_REPAIR_LOOKBACK_HOURS = Math.max(
  24,
  Number(process.env.CONFIRMATION_TAG_REPAIR_LOOKBACK_HOURS || 168),
);
const OUTCOME_TAG_REPAIR_INTERVAL =
  String(process.env.OUTCOME_TAG_REPAIR_INTERVAL || "5 minutes").trim() ||
  "5 minutes";
const OUTCOME_TAG_REPAIR_BATCH = Math.max(
  1,
  Number(process.env.OUTCOME_TAG_REPAIR_BATCH || 100),
);
const OUTCOME_TAG_REPAIR_LOOKBACK_HOURS = Math.max(
  24,
  Number(process.env.OUTCOME_TAG_REPAIR_LOOKBACK_HOURS || 720),
);
// Shopify order tag to apply when an attempt expires due to no response.
// Set `COD_EXPIRED_TAG=` (empty) to disable legacy tagging.
const COD_EXPIRED_TAG = String(process.env.COD_EXPIRED_TAG ?? "").trim();
const CONFIRMATION_EXPIRED_TAG = "NO_RESPONSE_EXPIRED⏳";
const ORDER_CONFIRMED_TAG = "ORDER_CONFIRMED✅";
const ORDER_CANCELLED_TAG = "ORDER_CANCELLED❌";
const CONFIRMATION_SENT_TAG = "CONFIRMATION_SENT📩";
const DEBUG_JOBS =
  process.env.DEBUG_ORDERX === "true" ||
  process.env.DEBUG_ORDERX_JOBS === "true";
const TERMINAL_ATTEMPT_STATUSES = new Set([
  "confirmed",
  "cancelled",
  "expired",
  "failed",
  "skipped",
]);

function dbg(...args) {
  if (DEBUG_JOBS) console.log(...args);
}

function retryDelayMin(retryCount) {
  // 1 -> 5m, 2 -> 15m, 3 -> 45m, 4 -> 2h, 5 -> 6h, 6+ -> 12h
  const schedule = [5, 15, 45, 120, 360, 720];
  const i = Math.max(0, Number(retryCount || 1) - 1);
  return schedule[Math.min(i, schedule.length - 1)];
}

function parseRetryAfterSeconds(v) {
  const raw = String(v || "").trim();
  if (!raw) return null;

  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);

  const d = Date.parse(raw);
  if (Number.isFinite(d)) {
    const sec = Math.round((d - Date.now()) / 1000);
    return sec > 0 ? sec : null;
  }

  return null;
}

function classifyWhatsAppSendError(e) {
  const status = Number(e?.httpStatus || e?.status || e?.statusCode || 0);
  const waCode = Number(e?.meta?.error?.code || 0) || null;
  const waType = e?.meta?.error?.type ? String(e.meta.error.type) : null;

  if (isRecipientNoWhatsappError(e)) {
    return {
      retryable: false,
      reason: "recipient_no_whatsapp",
      waCode,
      waType,
    };
  }

  if (isOwnNumberAccessLostGraphError(e)) {
    return {
      retryable: false,
      reason: "wa_sender_access_lost",
      waCode,
      waType,
    };
  }

  // Auth errors are not retryable; they need operator intervention.
  if (status === 401 || status === 403) {
    return { retryable: false, reason: "wa_auth", waCode, waType };
  }

  // Client errors: generally not retryable.
  if (status > 0 && status < 500 && status !== 429) {
    return { retryable: false, reason: "wa_client_error", waCode, waType };
  }

  // Rate limiting: retry, honoring Retry-After if present.
  if (status === 429) {
    return {
      retryable: true,
      reason: "wa_rate_limited",
      waCode,
      waType,
      retryAfterSec: parseRetryAfterSeconds(e?.retryAfter) || null,
    };
  }

  // Server errors: retry with backoff.
  if (status >= 500) {
    return { retryable: true, reason: "wa_server_error", waCode, waType };
  }

  // Unknown: fallback to retry.
  return { retryable: true, reason: "wa_unknown", waCode, waType };
}

function jitterSecondsFromSeed(seed, maxSeconds = 25) {
  const max = Number.isFinite(Number(maxSeconds))
    ? Math.max(0, Math.floor(Number(maxSeconds)))
    : 0;
  if (!max) return 0;
  const raw = String(seed || "");
  if (!raw) return Math.floor(Math.random() * (max + 1));
  const digest = crypto.createHash("sha1").update(raw).digest("hex");
  const n = parseInt(digest.slice(0, 8), 16);
  return n % (max + 1);
}

function addSeconds(d, sec) {
  const dt = new Date(d);
  const s = Number(sec || 0);
  if (!Number.isFinite(dt.getTime()) || !Number.isFinite(s) || !s) return d;
  return new Date(dt.getTime() + s * 1000);
}

function normalizePhoneDigits(v) {
  return String(v || "").replace(/[^\d]/g, "");
}

function normalizeSenderModeForQueue(v) {
  const mode = String(v || "").trim();
  if (mode === SENDER_MODES.OWN_NUMBER) return SENDER_MODES.OWN_NUMBER;
  return SENDER_MODES.ORDERX_NUMBER;
}

function buildSenderQueueKey({ shop, senderMode, senderPhoneNumberId }) {
  const mode = normalizeSenderModeForQueue(senderMode);
  const senderId = String(senderPhoneNumberId || "").trim();
  if (senderId) return `${mode}:${senderId}`;
  if (mode === SENDER_MODES.OWN_NUMBER) {
    return `${mode}:shop:${String(shop || "").trim()}`;
  }
  return `${mode}:shared`;
}

function resolveQueueSenderIdentity({
  shop,
  senderRuntime = null,
  attempt = null,
}) {
  const mode = normalizeSenderModeForQueue(
    senderRuntime?.senderMode ||
      attempt?.senderMode ||
      SENDER_MODES.ORDERX_NUMBER,
  );
  const runtimePhoneId = String(senderRuntime?.phoneId || "").trim();
  const attemptPhoneId = String(attempt?.senderPhoneNumberId || "").trim();
  const orderxPhoneId = String(process.env.WA_PHONE_NUMBER_ID || "").trim();
  const senderPhoneNumberId =
    runtimePhoneId ||
    attemptPhoneId ||
    (mode === SENDER_MODES.ORDERX_NUMBER ? orderxPhoneId : "");
  return {
    senderMode: mode,
    senderPhoneNumberId,
    senderQueueKey: buildSenderQueueKey({
      shop,
      senderMode: mode,
      senderPhoneNumberId,
    }),
  };
}

function buildPhoneQueueGroupId(shop, phoneDigits, senderQueueKey = "") {
  const raw = `${shop}|phone|${phoneDigits || ""}|sender|${String(senderQueueKey || "").trim()}`;
  const digest = crypto
    .createHash("sha1")
    .update(raw)
    .digest("hex")
    .slice(0, 18);
  return `phoneq_${digest}`;
}

function durationMsBetween(startAt, endAt) {
  const s = startAt ? new Date(startAt).getTime() : NaN;
  const e = endAt ? new Date(endAt).getTime() : NaN;
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 0;
  return e - s;
}

// Attempt age for gating should not penalize time spent waiting in queue.
function getEffectiveAttemptAgeMs(attempt, nowMs = Date.now()) {
  const createdAtMs = attempt?.createdAt
    ? new Date(attempt.createdAt).getTime()
    : NaN;
  const manualRescheduledAtMs = attempt?.manualRescheduledAt
    ? new Date(attempt.manualRescheduledAt).getTime()
    : NaN;
  const baselineCandidates = [];
  if (Number.isFinite(createdAtMs)) baselineCandidates.push(createdAtMs);
  if (Number.isFinite(manualRescheduledAtMs))
    baselineCandidates.push(manualRescheduledAtMs);
  const baselineMs = baselineCandidates.length
    ? Math.max(...baselineCandidates)
    : NaN;
  if (!Number.isFinite(baselineMs)) return null;

  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const phoneQueuePauseMs =
    durationMsBetween(
      attempt?.phoneQueuedAt,
      attempt?.phoneReleasedAt || safeNow,
    ) || 0;
  const duplicateQueuePauseMs =
    durationMsBetween(
      attempt?.duplicateQueuedAt,
      attempt?.duplicateReleasedAt || safeNow,
    ) || 0;
  const pausedMs = phoneQueuePauseMs + duplicateQueuePauseMs;
  const rawAgeMs = safeNow - baselineMs;
  if (!Number.isFinite(rawAgeMs)) return null;
  return Math.max(0, rawAgeMs - Math.max(0, pausedMs));
}

function pushErrorEvent(attempt, step, message, meta = null) {
  const events = Array.isArray(attempt.errorEvents) ? attempt.errorEvents : [];
  const nextEvent = {
    at: new Date(),
    step: String(step || ""),
    message: String(message || ""),
    meta: sanitizeStoredMeta(meta),
    count: 1,
  };
  const last = events[events.length - 1];
  const sameAsLast =
    last &&
    String(last.step || "") === nextEvent.step &&
    String(last.message || "") === nextEvent.message &&
    JSON.stringify(last.meta ?? null) ===
      JSON.stringify(nextEvent.meta ?? null);
  if (sameAsLast) {
    last.at = nextEvent.at;
    last.count = Math.max(1, Number(last.count || 1) + 1);
  } else {
    events.push(nextEvent);
  }
  attempt.errorEvents = sanitizeAttemptErrorEvents(events, { keep: 10 });
}

function setAttemptLastErrorMeta(attempt, value) {
  attempt.lastErrorMeta = sanitizeStoredMeta(value);
}

async function requeueAttemptAfterProcessingGap({
  attempt,
  settings = {},
  reason = "unexpected_processing_error",
  meta = null,
  delayMin = 1,
  source = "attempt_cod_confirmation",
}) {
  if (!attempt?._id) return false;

  const tz =
    attempt.timezone ||
    resolveTimezoneFromCountry(attempt.countryCode) ||
    "UTC";
  const startHour = Number(settings?.workStartHour ?? 9);
  const endHour = Number(settings?.workEndHour ?? 21);
  const baseSchedule = nextAllowedTimeUTC(
    tz,
    Math.max(1, Number(delayMin || 1)),
    startHour,
    endHour,
  );
  const scheduledAt = addSeconds(
    baseSchedule,
    jitterSecondsFromSeed(`${attempt._id}|${reason}`, 15),
  );

  attempt.status = "scheduled";
  attempt.scheduledAt = scheduledAt;
  attempt.lastError = reason;
  attempt.lastErrorAt = new Date();
  setAttemptLastErrorMeta(attempt, meta);
  pushErrorEvent(attempt, "runtime", reason, {
    ...(meta && typeof meta === "object" ? meta : {}),
    source,
  });
  await attempt.save();
  await agenda.schedule(scheduledAt, "attempt_cod_confirmation", {
    attemptId: attempt._id.toString(),
  });
  return true;
}

function hasNormalizedTag(tags = [], tag = "") {
  const needle = String(tag || "")
    .trim()
    .toLowerCase();
  if (!needle) return false;
  return tags.includes(needle);
}

function normalizeOrderTagsForCompare(tags = []) {
  return (Array.isArray(tags) ? tags : [])
    .map((tag) =>
      String(tag || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
}

function formatProductsText(order) {
  const edges = order?.lineItems?.edges || [];
  const items = edges
    .map((e) => e?.node)
    .filter(Boolean)
    .map((li) => ({
      title: String(li.title || "").trim(),
      qty: Number(li.quantity || 0),
      variant: String(li.variantTitle || "").trim(),
    }))
    .filter((x) => x.title && Number.isFinite(x.qty) && x.qty > 0);

  if (!items.length) return "";

  const maxItems = 15;
  const shown = items.slice(0, maxItems).map((x) => {
    const v =
      x.variant && x.variant.toLowerCase() !== "default title"
        ? ` (${x.variant})`
        : "";
    return `${x.title}${v} Qty ${x.qty}`;
  });

  const suffix =
    items.length > maxItems ? `\n+${items.length - maxItems} more` : "";

  // WhatsApp renders \n in template params fine; keeps the summary readable.
  return `${shown.join("\n")}${suffix}`;
}

function firstProductImageUrl(order) {
  const edges = Array.isArray(order?.lineItems?.edges)
    ? order.lineItems.edges
    : [];
  for (const edge of edges) {
    const line = edge?.node || {};
    const productImageEdge =
      line?.product?.images?.edges?.[0]?.node?.url ||
      line?.product?.images?.nodes?.[0]?.url ||
      "";
    const variantProductImageEdge =
      line?.variant?.product?.images?.edges?.[0]?.node?.url ||
      line?.variant?.product?.images?.nodes?.[0]?.url ||
      "";
    const candidates = [
      line?.image?.url,
      line?.variant?.image?.url,
      line?.variant?.product?.featuredImage?.url,
      line?.variant?.product?.featuredMedia?.preview?.image?.url,
      variantProductImageEdge,
      line?.product?.featuredImage?.url,
      line?.product?.featuredMedia?.preview?.image?.url,
      productImageEdge,
    ];
    const hit = candidates
      .map((value) => String(value || "").trim())
      .find((value) => /^https:\/\//i.test(value));
    if (hit) return hit;
  }
  return "";
}

function formatDeliveryAddressText(addr) {
  if (!addr) return "";
  const parts = [
    addr?.address1,
    addr?.address2,
    addr?.city,
    addr?.province,
    addr?.zip,
    addr?.country,
  ]
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  return parts.join(", ");
}

function formatAmountText(amount, currency) {
  const a = Number(amount);
  const c = String(currency || "").trim();
  if (!Number.isFinite(a) || !c) return "";
  return `${a.toFixed(2)} ${c}`;
}

function toValidDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function isPreDispatchFulfillmentBlocked(order) {
  const status = String(order?.displayFulfillmentStatus || "")
    .trim()
    .toUpperCase();
  if (!status) return false;
  return (
    status === "FULFILLED" ||
    status === "PARTIALLY_FULFILLED" ||
    status === "IN_PROGRESS"
  );
}

function getOwnNumberConfirmationStartAt(shopRecord) {
  const own = shopRecord?.whatsappSender?.ownNumber || {};
  return (
    toValidDate(own?.templatesReadyAt) || toValidDate(own?.readyAt) || null
  );
}

function normalizeOrderName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function buildSameOrderAttemptLookup(attempt) {
  const shop = String(attempt?.shop || "").trim();
  const stage = String(attempt?.stage || "").trim();
  const orderGid = String(attempt?.orderGid || "").trim();
  const orderName = normalizeOrderName(attempt?.orderName);
  const or = [];

  if (orderGid) or.push({ orderGid });
  if (orderName) {
    or.push({
      orderName: {
        $regex: `^${String(attempt?.orderName || "")
          .trim()
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        $options: "i",
      },
    });
  }

  if (!shop || !stage || !or.length) return null;
  return { shop, stage, $or: or };
}

function isOlderAttempt(left, right) {
  if (!left || !right) return false;
  const leftTime = left?.createdAt ? new Date(left.createdAt).getTime() : NaN;
  const rightTime = right?.createdAt
    ? new Date(right.createdAt).getTime()
    : NaN;

  if (
    Number.isFinite(leftTime) &&
    Number.isFinite(rightTime) &&
    leftTime !== rightTime
  ) {
    return leftTime < rightTime;
  }

  return String(left?._id || "") < String(right?._id || "");
}

function isTerminalAttemptStatus(status) {
  return TERMINAL_ATTEMPT_STATUSES.has(String(status || "").trim());
}

async function maybeReleaseQueuesForResolvedAttempt(sourceAttempt, context) {
  if (!sourceAttempt?._id) return null;

  const duplicateRole = String(sourceAttempt?.duplicateRole || "none").trim();
  const phoneQueueRole = String(sourceAttempt?.phoneQueueRole || "none").trim();
  const controlsDuplicateQueue =
    duplicateRole === "primary" ||
    (duplicateRole === "queued" && !!sourceAttempt?.duplicateReleasedAt);
  const controlsPhoneQueue =
    phoneQueueRole === "primary" ||
    (phoneQueueRole === "queued" && !!sourceAttempt?.phoneReleasedAt);

  if (!controlsDuplicateQueue && !controlsPhoneQueue) {
    return null;
  }

  return releaseQueuesAfterAttemptResolved({
    sourceAttempt,
    fromE164: sourceAttempt.phoneE164,
    context,
  });
}

async function ensureConfirmationSentOrderTag({
  attempt,
  shopRecord = null,
  admin = null,
  label = "confirmation_sent_tag_repair",
  verifyLiveState = false,
}) {
  if (
    !attempt?.orderGid ||
    String(attempt?.stage || "").trim() !== "pre_dispatch"
  ) {
    return { ok: false, skipped: "not_pre_dispatch_or_missing_order" };
  }

  if (verifyLiveState && attempt?._id) {
    const liveAttempt = await CodAttempt.findOne({
      _id: attempt._id,
      status: "wa_sent",
      stage: "pre_dispatch",
    })
      .select({ _id: 1 })
      .lean()
      .catch(() => null);
    if (!liveAttempt) {
      return { ok: false, skipped: "attempt_no_longer_eligible" };
    }
  }

  const resolvedShopRecord =
    shopRecord ||
    (await Shop.findOne({ shop: attempt.shop })
      .select({ accessToken: 1, settings: 1 })
      .lean()
      .catch(() => null));

  const autoTagOrders = resolvedShopRecord?.settings?.autoTagOrders !== false;
  if (!autoTagOrders) {
    return { ok: false, skipped: "auto_tag_orders_disabled" };
  }

  if (!resolvedShopRecord) {
    return { ok: false, skipped: "shop_not_installed" };
  }

  const resolvedAdmin =
    admin ||
    (await getAdminClient(attempt.shop, {
      accessToken: resolvedShopRecord.accessToken || "",
      record: resolvedShopRecord,
    }).catch(() => null));
  if (!resolvedAdmin) {
    return { ok: false, skipped: "missing_admin_client" };
  }

  const tags = await fetchOrderTags(resolvedAdmin, attempt.orderGid);
  const normalized = normalizeOrderTagsForCompare(tags);
  if (hasNormalizedTag(normalized, CONFIRMATION_SENT_TAG)) {
    return { ok: true, alreadyPresent: true };
  }

  const orderResolved =
    hasNormalizedTag(normalized, ORDER_CONFIRMED_TAG) ||
    hasNormalizedTag(normalized, ORDER_CANCELLED_TAG) ||
    hasNormalizedTag(normalized, "cod_cancelled");
  if (orderResolved) {
    return { ok: false, skipped: "order_already_resolved", tags };
  }

  await clearMetaErrorOrderTags({
    shop: attempt.shop,
    accessToken: resolvedShopRecord.accessToken,
    orderGid: attempt.orderGid,
    label,
  }).catch(() => {});
  await appendOrderTag(resolvedAdmin, attempt.orderGid, CONFIRMATION_SENT_TAG);

  if (attempt?._id) {
    const stillEligible = await CodAttempt.exists({
      _id: attempt._id,
      shop: attempt.shop,
      orderGid: attempt.orderGid,
      stage: "pre_dispatch",
      status: "wa_sent",
    }).catch(() => null);
    if (!stillEligible) {
      await removeOrderTags(resolvedAdmin, attempt.orderGid, [
        CONFIRMATION_SENT_TAG,
      ]).catch(() => null);
      return { ok: false, skipped: "order_resolved_during_tag_write" };
    }
  }

  return { ok: true, applied: true };
}

agenda.define("sync_billing", async () => {
  const shops = await Shop.find(buildShopifyCredentialCandidateQuery()).lean();

  for (const s of shops) {
    const last = s?.billing?.lastCheckedAt
      ? new Date(s.billing.lastCheckedAt).getTime()
      : null;
    const ageMs = last ? Date.now() - last : Infinity;

    // Avoid hammering the Admin API if another process already synced recently.
    if (
      Number.isFinite(BILLING_SYNC_TTL_MIN) &&
      ageMs < BILLING_SYNC_TTL_MIN * 60e3
    ) {
      continue;
    }

    try {
      await syncBillingFromShopify(s.shop, s.accessToken || "");
    } catch (e) {
      console.error("[sync_billing]", s.shop, e?.message || e);
    }
  }
});

agenda.define("refresh_byon_tokens", async () => {
  const leadMs =
    Math.max(1, Number(BYON_TOKEN_REFRESH_LEAD_DAYS || 10)) *
    24 *
    60 *
    60 *
    1000;
  const cooldownMs =
    Math.max(1, Number(BYON_TOKEN_REFRESH_COOLDOWN_HOURS || 6)) *
    60 *
    60 *
    1000;
  const unknownExpiryRetryMs =
    Math.max(1, Number(BYON_TOKEN_UNKNOWN_EXPIRY_RETRY_DAYS || 7)) *
    24 *
    60 *
    60 *
    1000;
  const cutoff = new Date(Date.now() + leadMs);
  const cooldownCutoff = new Date(Date.now() - cooldownMs);
  const batchSize = Math.max(1, Number(BYON_TOKEN_REFRESH_BATCH || 100));

  const shops = await Shop.find({
    $and: [
      { "whatsappSender.ownNumber.accessToken": { $exists: true, $ne: "" } },
      {
        $or: [
          {
            "whatsappSender.ownNumber.accessTokenExpiresAt": { $exists: false },
          },
          { "whatsappSender.ownNumber.accessTokenExpiresAt": null },
          { "whatsappSender.ownNumber.accessTokenExpiresAt": { $lte: cutoff } },
        ],
      },
      {
        $or: [
          {
            "whatsappSender.ownNumber.accessTokenRefreshAttemptedAt": {
              $exists: false,
            },
          },
          { "whatsappSender.ownNumber.accessTokenRefreshAttemptedAt": null },
          {
            "whatsappSender.ownNumber.accessTokenRefreshAttemptedAt": {
              $lte: cooldownCutoff,
            },
          },
        ],
      },
    ],
  })
    .sort({
      "whatsappSender.ownNumber.accessTokenExpiresAt": 1,
      "whatsappSender.ownNumber.accessTokenRefreshAttemptedAt": 1,
    })
    .limit(batchSize)
    .lean();

  for (const record of shops) {
    const shop = String(record?.shop || "").trim();
    if (!shop) continue;

    const own = record?.whatsappSender?.ownNumber || {};
    const force = isMetaAccessTokenExpired(own?.accessTokenExpiresAt);

    try {
      const refreshed = await maybeRefreshByonAccessToken({
        shop,
        ownNumber: own,
        force,
        minRemainingMs: leadMs,
        cooldownMs,
        unknownExpiryRetryMs,
      });

      if (!refreshed?.ok && force) {
        const now = new Date();
        await Shop.updateOne(
          { shop },
          {
            $set: {
              "whatsappSender.ownNumber.status": "reauth_required",
              "whatsappSender.ownNumber.lastError":
                "Meta access token expired and auto-refresh failed. Reconnect Meta.",
              "whatsappSender.ownNumber.lastErrorMeta": {
                reason: "meta_token_auto_refresh_failed",
                message: refreshed?.error?.message || null,
              },
              "whatsappSender.ownNumber.lastErrorAt": now,
            },
          },
        ).catch(() => {});
      }
    } catch (e) {
      console.error("[refresh_byon_tokens]", shop, e?.message || e);
    }
  }
});

agenda.define("poll_abandoned_cart_recoveries", async () => {
  try {
    const result = await pollAbandonedCartRecoveries({ now: new Date() });
    if (DEBUG_JOBS) {
      console.log("[poll_abandoned_cart_recoveries]", JSON.stringify(result));
    }
  } catch (e) {
    console.error("[poll_abandoned_cart_recoveries]", e?.message || e);
  }
});

agenda.define("poll_review_request_recoveries", async () => {
  try {
    const result = await pollReviewRequestRecoveries({ now: new Date() });
    if (DEBUG_JOBS) {
      console.log("[poll_review_request_recoveries]", JSON.stringify(result));
    }
  } catch (e) {
    console.error("[poll_review_request_recoveries]", e?.message || e);
  }
});

agenda.define("reconcile_shopify_usage_charges", async () => {
  try {
    const result = await reconcilePendingShopifyUsageCharges({
      now: new Date(),
      limit: Number(process.env.USAGE_CHARGE_RECONCILE_LIMIT || 100),
    });
    if (DEBUG_JOBS) {
      console.log("[reconcile_shopify_usage_charges]", JSON.stringify(result));
    }
  } catch (e) {
    console.error("[reconcile_shopify_usage_charges]", e?.message || e);
  }
});

agenda.define("reconcile_shopify_usage_balances", async () => {
  try {
    const result = await reconcileShopifyUsageBalances({
      now: new Date(),
      limit: Number(process.env.USAGE_BALANCE_RECONCILE_LIMIT || 200),
    });
    if (DEBUG_JOBS) {
      console.log("[reconcile_shopify_usage_balances]", JSON.stringify(result));
    }
  } catch (e) {
    console.error("[reconcile_shopify_usage_balances]", e?.message || e);
  }
});

agenda.define("cleanup_agenda_jobs", async () => {
  try {
    const result = await cleanupOldAgendaJobs({
      completedAfterDays: Number(
        process.env.AGENDA_COMPLETED_CLEANUP_DAYS || 7,
      ),
      failedAfterDays: Number(process.env.AGENDA_FAILED_CLEANUP_DAYS || 30),
    });
    if (DEBUG_JOBS) {
      console.log("[cleanup_agenda_jobs]", JSON.stringify(result));
    }
  } catch (e) {
    console.error("[cleanup_agenda_jobs]", e?.message || e);
  }
});

agenda.define("migrate_legacy_shopify_offline_tokens", async () => {
  try {
    const migrationEnabled =
      String(process.env.SHOPIFY_OFFLINE_TOKEN_AUTO_MIGRATION_ENABLED || "")
        .trim()
        .toLowerCase() === "true";
    const canaryShops = String(
      process.env.SHOPIFY_OFFLINE_TOKEN_MIGRATION_CANARY_SHOPS || "",
    )
      .split(",")
      .map((shop) => shop.trim().toLowerCase())
      .filter(Boolean);
    const result = await migrateLegacyOfflineTokensBatch({
      limit: Number(
        process.env.SHOPIFY_OFFLINE_TOKEN_MIGRATION_BATCH_SIZE || 10,
      ),
      shops: migrationEnabled ? [] : canaryShops,
      dryRun: !migrationEnabled && canaryShops.length === 0,
    });
    if (DEBUG_JOBS) {
      console.log(
        "[migrate_legacy_shopify_offline_tokens]",
        JSON.stringify(result),
      );
    }
  } catch (e) {
    console.error("[migrate_legacy_shopify_offline_tokens]", e?.message || e);
  }
});

agenda.define("send_campaign_run", async (job) => {
  const runId = String(job?.attrs?.data?.runId || "").trim();
  if (!runId) return;
  try {
    await processCampaignRun({ runId });
  } catch (e) {
    console.error("[send_campaign_run]", runId, e?.message || e);
    await failCampaignRun(runId, e).catch((summaryError) => {
      console.error(
        "[send_campaign_run_summary]",
        runId,
        summaryError?.message || summaryError,
      );
    });
  }
});

agenda.define("attempt_cod_confirmation", async (job) => {
  const { attemptId } = job.attrs.data || {};
  dbg("attempt_cod_confirmation StARt", attemptId);
  if (!attemptId) return;
  dbg("attempt_cod_confirmation", attemptId);
  let attempt = null;
  let shopRecord = null;
  let settings = {};
  let tz = "UTC";
  let startHour = 9;
  let endHour = 21;

  try {
    // Prevent duplicate sends if the same attempt accidentally gets multiple jobs.
    // We "claim" the attempt by moving it to pending (unless it's already pending recently).
    const lockCutoff = new Date(Date.now() - SEND_LOCK_MIN * 60e3);

    attempt = await CodAttempt.findOneAndUpdate(
      {
        _id: attemptId,
        status: { $nin: ["confirmed", "cancelled", "expired", "wa_sent"] },
        $or: [
          { status: { $ne: "pending" } },
          { lastTriedAt: { $exists: false } },
          { lastTriedAt: null },
          { lastTriedAt: { $lt: lockCutoff } },
        ],
      },
      {
        $set: {
          status: "pending",
          lastTriedAt: new Date(),
        },
      },
      { new: true },
    );
    dbg("Attempt check");
    if (!attempt) return;
    dbg("Attempt check continue");
    const sameOrderLookup = buildSameOrderAttemptLookup(attempt);
    if (sameOrderLookup) {
      const sibling = await CodAttempt.findOne({
        ...sameOrderLookup,
        _id: { $ne: attempt._id },
        status: { $nin: Array.from(TERMINAL_ATTEMPT_STATUSES) },
      })
        .sort({ createdAt: 1, _id: 1 })
        .lean();

      if (sibling && isOlderAttempt(sibling, attempt)) {
        attempt.status = "skipped";
        attempt.lastError = "same_order_duplicate_attempt";
        attempt.lastErrorAt = new Date();
        setAttemptLastErrorMeta(attempt, {
          canonicalAttemptId:
            sibling?._id?.toString?.() || String(sibling?._id || ""),
          canonicalStatus: String(sibling?.status || ""),
        });
        pushErrorEvent(attempt, "gate", "same_order_duplicate_attempt", {
          canonicalAttemptId:
            sibling?._id?.toString?.() || String(sibling?._id || ""),
          canonicalStatus: String(sibling?.status || ""),
        });
        await attempt.save();
        await maybeReleaseQueuesForResolvedAttempt(
          attempt,
          "same_order_duplicate_attempt",
        );
        return;
      }
    }

    shopRecord = await Shop.findOne({ shop: attempt.shop }).lean();
    settings = shopRecord?.settings || {};

    tz =
      attempt.timezone ||
      resolveTimezoneFromCountry(attempt.countryCode) ||
      "UTC";

    // Respect working hours (defaults)
    startHour = Number(settings?.workStartHour ?? 9);
    endHour = Number(settings?.workEndHour ?? 21);

    // Free feature: pause confirmations (prevents accidental spamming).

    dbg(settings?.enableWhatsApp === false);
    if (settings?.enableWhatsApp === false) {
      const reschedule = nextAllowedTimeUTC(tz, 180, 0, 23);
      attempt.status = "scheduled";
      attempt.scheduledAt = reschedule;
      attempt.lastError = "paused";
      attempt.lastErrorAt = new Date();
      attempt.lastErrorMeta = null;
      pushErrorEvent(attempt, "gate", "paused");
      await attempt.save();

      await agenda.schedule(reschedule, "attempt_cod_confirmation", {
        attemptId,
      });
      return;
    }

    // Required: support number (so we can route customer questions to the merchant).
    // We reschedule instead of failing, so the attempt can send once the merchant saves settings.
    const supportNum = String(settings?.supportWhatsAppNumber || "").trim();
    const e164Ok = /^\+[1-9]\d{7,14}$/.test(supportNum);
    // if (!e164Ok) {
    //   const reschedule = nextAllowedTimeUTC(tz, 180, startHour, endHour);
    //   attempt.status = "scheduled";
    //   attempt.scheduledAt = reschedule;
    //   attempt.lastError = "missing_support_whatsapp_number";
    //   attempt.lastErrorAt = new Date();
    //   attempt.lastErrorMeta = null;
    //   pushErrorEvent(attempt, "gate", "missing_support_whatsapp_number");
    //   await attempt.save();

    //   await agenda.schedule(reschedule, "attempt_cod_confirmation", {
    //     attemptId,
    //   });
    //   return;
    // }

    if (!isWithinWorkingHours(tz, startHour, endHour)) {
      const reschedule = nextAllowedTimeUTC(tz, 30, startHour, endHour);

      attempt.status = "scheduled";
      attempt.scheduledAt = reschedule;
      attempt.lastError = null;
      await attempt.save();

      await agenda.schedule(reschedule, "attempt_cod_confirmation", {
        attemptId,
      });
      return;
    }

    // Must have phone
    dbg(" PHONE CHECK");
    if (!attempt.phoneE164) {
      attempt.status = "failed";
      attempt.lastError = "Missing phone number";
      attempt.lastErrorAt = new Date();
      attempt.lastErrorMeta = null;
      pushErrorEvent(attempt, "gate", "Missing phone number");
      await attempt.save();
      await maybeReleaseQueuesForResolvedAttempt(
        attempt,
        "missing_phone_number",
      );
      return;
    }
    dbg(" PHONE CHECK Continue");
    // Free feature: don't keep retrying very old attempts.
    const maxAgeHours = Number(settings?.maxAttemptAgeHours ?? 72);
    if (Number.isFinite(maxAgeHours) && maxAgeHours > 0 && attempt.createdAt) {
      const ageMs = getEffectiveAttemptAgeMs(attempt, Date.now());
      if (ageMs > maxAgeHours * 60 * 60 * 1000) {
        attempt.status = "skipped";
        attempt.lastError = "max_age";
        attempt.lastErrorAt = new Date();
        setAttemptLastErrorMeta(attempt, {
          maxAttemptAgeHours: maxAgeHours,
          effectiveAgeHours: Number((ageMs / 36e5).toFixed(2)),
        });
        pushErrorEvent(attempt, "gate", "max_age", {
          maxAttemptAgeHours: maxAgeHours,
          effectiveAgeHours: Number((ageMs / 36e5).toFixed(2)),
        });
        await attempt.save();
        await maybeReleaseQueuesForResolvedAttempt(attempt, "max_age");
        return;
      }
    }
    dbg("BLOCK CHECK");
    // Free feature: shop-managed blocklist
    try {
      const blocked = await BlockedContact.exists({
        shop: attempt.shop,
        phoneE164: attempt.phoneE164,
      });
      if (blocked) {
        attempt.status = "skipped";
        attempt.lastError = "blocked_phone";
        attempt.lastErrorAt = new Date();
        attempt.lastErrorMeta = null;
        pushErrorEvent(attempt, "gate", "blocked_phone");
        await attempt.save();
        await maybeReleaseQueuesForResolvedAttempt(attempt, "blocked_phone");
        return;
      }
    } catch (e) {
      console.error("[blocklist]", attempt.shop, e?.message || e);
    }

    // ✅ Gate check: billing/trial + limits (does NOT increment counters)
    const senderRuntime = await resolveRuntimeConfig(attempt.shop).catch(
      () => null,
    );
    const queueSenderIdentity = resolveQueueSenderIdentity({
      shop: attempt.shop,
      senderRuntime,
      attempt,
    });
    attempt.senderMode = queueSenderIdentity.senderMode;
    attempt.senderPhoneNumberId =
      queueSenderIdentity.senderPhoneNumberId || null;
    attempt.senderQueueKey = queueSenderIdentity.senderQueueKey;
    const hasOpenSessionWindow = await hasRecentInboundForSender({
      shop: attempt.shop,
      phoneE164: attempt.phoneE164,
      senderPhoneNumberId: queueSenderIdentity.senderPhoneNumberId || "",
      senderMode: queueSenderIdentity.senderMode || "",
      withinHours: 23,
    }).catch(() => false);
    const gate = await canSendWhatsApp(attempt.shop, {
      toE164: attempt.phoneE164,
      alreadyInConversationWindow: hasOpenSessionWindow,
      senderPhoneNumberId: queueSenderIdentity.senderPhoneNumberId || "",
      isTemplate: true,
      billableConfirmation: true,
    });
    dbg("GATE CHECKS", !gate.ok);
    if (!gate.ok) {
      attempt.status = "scheduled";
      attempt.lastError = gate.reason;
      attempt.lastErrorAt = new Date();
      const gateSummary = summarizeSendGateForStorage(gate);
      setAttemptLastErrorMeta(attempt, gateSummary);
      pushErrorEvent(attempt, "gate", gate.reason, gateSummary);
      attempt.scheduledAt = nextAllowedTimeUTC(tz, 30, startHour, endHour);
      await attempt.save();

      await agenda.schedule(attempt.scheduledAt, "attempt_cod_confirmation", {
        attemptId,
      });
      return;
    }
    dbg("gate check pass");

    // Optional guard: if the order was already resolved or tagged to skip, don't send.
    // (We only call Shopify when we're otherwise allowed to send to keep API usage small.)
    let storeName = "";
    let orderNumber = attempt.orderName || "";
    let productsText = "";
    let productImageUrl = "";
    let deliveryAddressText = "";
    let amountText = formatAmountText(
      attempt.orderAmount,
      attempt.orderCurrency,
    );

    try {
      if (shopRecord && attempt.orderGid) {
        const admin = await getAdminClient(attempt.shop, {
          accessToken: shopRecord.accessToken || "",
          record: shopRecord,
        });
        const fetched = await fetchOrderForCodConfirmTemplate(
          admin,
          attempt.orderGid,
        );

        storeName = String(fetched?.shopName || "").trim();

        const order = fetched?.order || null;
        const tags = order?.tags || [];
        const normalized = (tags || []).map((t) =>
          String(t || "").toLowerCase(),
        );

        const isPreDispatch = attempt.stage !== "post_failed_delivery";
        if (isPreDispatch && isPreDispatchFulfillmentBlocked(order)) {
          attempt.status = "skipped";
          attempt.lastError = "order_fulfillment_blocked";
          attempt.lastErrorAt = new Date();
          setAttemptLastErrorMeta(attempt, {
            displayFulfillmentStatus: String(
              order?.displayFulfillmentStatus || "",
            ),
          });
          pushErrorEvent(attempt, "gate", "order_fulfillment_blocked", {
            displayFulfillmentStatus: String(
              order?.displayFulfillmentStatus || "",
            ),
          });
          await attempt.save();
          await maybeReleaseQueuesForResolvedAttempt(
            attempt,
            "order_fulfillment_blocked",
          );
          return;
        }

        const confirmationStartAt =
          String(attempt.senderMode || "").trim() === SENDER_MODES.OWN_NUMBER
            ? getOwnNumberConfirmationStartAt(shopRecord)
            : null;
        const orderCreatedAt = toValidDate(order?.createdAt);
        if (
          isPreDispatch &&
          confirmationStartAt &&
          (!orderCreatedAt ||
            orderCreatedAt.getTime() < confirmationStartAt.getTime())
        ) {
          attempt.status = "skipped";
          attempt.lastError = "order_created_before_sender_ready";
          attempt.lastErrorAt = new Date();
          setAttemptLastErrorMeta(attempt, {
            orderCreatedAt: orderCreatedAt?.toISOString?.() || null,
            confirmationStartAt: confirmationStartAt.toISOString(),
          });
          pushErrorEvent(attempt, "gate", "order_created_before_sender_ready", {
            orderCreatedAt: orderCreatedAt?.toISOString?.() || null,
            confirmationStartAt: confirmationStartAt.toISOString(),
          });
          await attempt.save();
          await maybeReleaseQueuesForResolvedAttempt(
            attempt,
            "order_created_before_sender_ready",
          );
          return;
        }

        const alreadyDone =
          hasNormalizedTag(normalized, ORDER_CANCELLED_TAG) ||
          hasNormalizedTag(normalized, "cod_cancelled") ||
          (isPreDispatch &&
            (hasNormalizedTag(normalized, ORDER_CONFIRMED_TAG) ||
              hasNormalizedTag(normalized, "order_confirmed✅"))) ||
          (!isPreDispatch && normalized.includes("cod_redeliver"));
        dbg("alreadyDone", alreadyDone, tags);
        if (alreadyDone) {
          attempt.status = "skipped";
          attempt.lastError = "order_already_tagged";
          attempt.lastErrorAt = new Date();
          setAttemptLastErrorMeta(attempt, { tags });
          pushErrorEvent(attempt, "gate", "order_already_tagged", { tags });
          await attempt.save();
          await maybeReleaseQueuesForResolvedAttempt(
            attempt,
            "order_already_tagged",
          );
          return;
        }

        orderNumber = String(order?.name || orderNumber || "").trim();
        productsText = formatProductsText(order);
        productImageUrl = firstProductImageUrl(order);
        deliveryAddressText = formatDeliveryAddressText(order?.shippingAddress);

        const totalAmount = order?.currentTotalPriceSet?.shopMoney?.amount;
        const totalCurrency =
          order?.currentTotalPriceSet?.shopMoney?.currencyCode;
        const amtFromOrder = formatAmountText(totalAmount, totalCurrency);
        if (amtFromOrder) amountText = amtFromOrder;

        const skip = (settings?.skipOrderTags || [])
          .map((t) =>
            String(t || "")
              .trim()
              .toLowerCase(),
          )
          .filter(Boolean);
        const hit = skip.find((t) => normalized.includes(t));
        dbg("hit", hit, skip);
        if (hit) {
          attempt.status = "skipped";
          attempt.lastError = `skip_tag:${hit}`;
          attempt.lastErrorAt = new Date();
          setAttemptLastErrorMeta(attempt, { tag: hit, tags });
          pushErrorEvent(attempt, "gate", `skip_tag:${hit}`, {
            tag: hit,
            tags,
          });
          await attempt.save();
          await maybeReleaseQueuesForResolvedAttempt(
            attempt,
            `skip_tag:${hit}`,
          );
          return;
        }
      }
    } catch (e) {
      // If Shopify tag check fails, proceed with sending (don't block core flow).
      console.error("[order_tags_check]", attempt.shop, e?.message || e);
    }

    // Sequential sending for same phone: if an older active attempt exists, queue this one.
    if (attempt.phoneE164) {
      const olderActive = await CodAttempt.findOne({
        shop: attempt.shop,
        phoneE164: attempt.phoneE164,
        _id: { $ne: attempt._id },
        status: {
          $nin: ["confirmed", "cancelled", "expired", "failed", "skipped"],
        },
        $and: [
          {
            $or: [
              { senderQueueKey: queueSenderIdentity.senderQueueKey },
              {
                senderQueueKey: { $in: [null, ""] },
                senderMode: {
                  $in: [null, "", queueSenderIdentity.senderMode],
                },
              },
            ],
          },
          {
            $or: [
              { waSentAt: { $ne: null } },
              { scheduledAt: { $ne: null } },
              { status: "pending" },
            ],
          },
        ],
      })
        .sort({ createdAt: 1 })
        .lean();

      if (olderActive && olderActive.createdAt && attempt.createdAt) {
        const olderTime = new Date(olderActive.createdAt).getTime();
        const currentTime = new Date(attempt.createdAt).getTime();
        const isOlder =
          olderTime < currentTime ||
          (olderTime === currentTime &&
            String(olderActive._id) < String(attempt._id));
        if (isOlder) {
          if (sameOrderLookup && isOlderAttempt(olderActive, attempt)) {
            attempt.status = "skipped";
            attempt.lastError = "same_order_duplicate_attempt";
            attempt.lastErrorAt = new Date();
            setAttemptLastErrorMeta(attempt, {
              canonicalAttemptId:
                olderActive?._id?.toString?.() ||
                String(olderActive?._id || ""),
              canonicalStatus: String(olderActive?.status || ""),
            });
            pushErrorEvent(attempt, "gate", "same_order_duplicate_attempt", {
              canonicalAttemptId:
                olderActive?._id?.toString?.() ||
                String(olderActive?._id || ""),
              canonicalStatus: String(olderActive?.status || ""),
            });
            await attempt.save();
            return;
          }

          const phoneDigits = normalizePhoneDigits(attempt.phoneE164);
          const groupId =
            olderActive.phoneQueueGroupId ||
            buildPhoneQueueGroupId(
              attempt.shop,
              phoneDigits,
              queueSenderIdentity.senderQueueKey,
            );

          if (
            olderActive.phoneQueueGroupId !== groupId ||
            olderActive.phoneQueueRole !== "primary" ||
            String(olderActive.senderQueueKey || "").trim() !==
              queueSenderIdentity.senderQueueKey
          ) {
            await CodAttempt.updateOne(
              { _id: olderActive._id },
              {
                $set: {
                  phoneQueueGroupId: groupId,
                  phoneQueueRole: "primary",
                  senderMode: queueSenderIdentity.senderMode,
                  senderPhoneNumberId:
                    queueSenderIdentity.senderPhoneNumberId || null,
                  senderQueueKey: queueSenderIdentity.senderQueueKey,
                },
              },
            ).catch(() => null);
          }

          attempt.phoneQueueGroupId = groupId;
          attempt.phoneQueueRole = "queued";
          attempt.phoneQueuedAt = new Date();
          attempt.status = "scheduled";
          attempt.scheduledAt = null;
          attempt.lastError = "phone_queued";
          attempt.lastErrorAt = new Date();
          setAttemptLastErrorMeta(attempt, {
            blockedBy: olderActive._id?.toString?.() || String(olderActive._id),
          });
          await attempt.save();
          return;
        }
      }
    }

    // Already claimed (pending) above; keep metadata consistent.
    attempt.waMessageId = null;
    attempt.waTemplateUsed = null;
    attempt.waSentAt = null;
    attempt.waDeliveryStatus = null;
    attempt.waDeliveryStatusAt = null;
    attempt.waDeliveryError = null;
    attempt.lastError = null;
    attempt.lastErrorAt = null;
    attempt.lastErrorMeta = null;
    await attempt.save();
    dbg("ATTEMPT SAVED");
    // Template vars
    const customerName = attempt.customerName || "Customer";
    const storeNameSafe =
      storeName ||
      String(attempt.shop || "").replace(".myshopify.com", "") ||
      "Store";

    const productsTextSafe =
      productsText ||
      (attempt.orderName ? `Order: ${attempt.orderName}` : "") ||
      "—";

    const amountTextSafe = amountText || "—";
    const deliveryAddressTextSafe = deliveryAddressText || "—";

    try {
      const isPostFailedDelivery = attempt.stage === "post_failed_delivery";
      dbg("isPostFailedDelivery,isPostFailedDelivery");
      if (
        attempt.duplicateNotifyOnSend &&
        hasOpenSessionWindow &&
        !attempt.duplicatePromptSentAt
      ) {
        const dupText =
          "We noticed a duplicate order. Please confirm or cancel this order below.";
        try {
          await sendWhatsAppText({
            to: attempt.phoneE164,
            text: dupText,
            shop: attempt.shop,
            kind: "duplicate_prompt_initial",
            attemptId: attempt._id,
            orderGid: attempt.orderGid,
            meta: { source: "attempt_cod_confirmation" },
          });
          await incrementWhatsAppUsage(attempt.shop, 1);
          attempt.duplicatePromptSentAt = new Date();
          await attempt.save();
        } catch (e) {
          console.error(
            "[wa_duplicate_prompt_initial]",
            attempt.shop,
            e?.message || e,
          );
        }
      }
      let result;
      let sentAsTemplate = true;

      if (isPostFailedDelivery) {
        result = await sendDeliveryFailedRedeliverTemplate({
          to: attempt.phoneE164,
          customerName,
          orderNumber: orderNumber || attempt.orderName || "",
          storeName: storeNameSafe,
          redeliverPayload: `redeliver:${attempt._id.toString()}`,
          cancelPayload: `cancel:${attempt._id.toString()}`,
          shop: attempt.shop,
          attemptId: attempt._id,
          orderGid: attempt.orderGid,
          meta: { source: "attempt_cod_confirmation" },
        });
        sentAsTemplate = true;
      } else {
        result = await sendCodConfirmTemplate({
          to: attempt.phoneE164,
          customerName,
          storeName: storeNameSafe,
          orderNumber: orderNumber || attempt.orderName || "",
          productsText: productsTextSafe,
          productImageUrl,
          amountText: amountTextSafe,
          deliveryAddressText: deliveryAddressTextSafe,
          confirmPayload: `confirm:${attempt._id.toString()}`,
          cancelPayload: `cancel:${attempt._id.toString()}`,
          shop: attempt.shop,
          attemptId: attempt._id,
          orderGid: attempt.orderGid,
          meta: {
            source: "attempt_cod_confirmation",
            sessionWindowHours: hasOpenSessionWindow ? 23 : null,
            sessionWindowTemplatePreferred: true,
          },
        });
        sentAsTemplate = true;
      }

      // ✅ Only after send success: increment usage (all outbound count; template count only for template sends)
      if (sentAsTemplate) {
        await incrementWhatsAppUsage(attempt.shop, 1, {
          isTemplate: true,
          billableConfirmation: true,
          toE164: attempt.phoneE164,
          countInitiatedConversation: true,
          senderPhoneNumberId: queueSenderIdentity.senderPhoneNumberId || "",
        });
      } else {
        await incrementWhatsAppUsage(attempt.shop, 1);
      }

      attempt.status = "wa_sent";
      attempt.storeName = storeNameSafe;
      attempt.waTemplateUsed = sentAsTemplate
        ? result?.templateUsed || null
        : null;
      attempt.waMessageId = result?.data?.messages?.[0]?.id || null;
      attempt.waSentAt = new Date();
      attempt.waDeliveryStatus = String(
        result?.data?.messages?.[0]?.message_status || "accepted",
      )
        .trim()
        .toLowerCase();
      attempt.waDeliveryStatusAt = new Date();
      attempt.waDeliveryError = null;
      attempt.lastError = null;
      attempt.lastErrorAt = null;
      attempt.lastErrorMeta = null;
      attempt.retryCount = 0;
      await attempt.save();

      const autoTagOrders = settings?.autoTagOrders !== false;
      if (
        !isPostFailedDelivery &&
        autoTagOrders &&
        shopRecord &&
        attempt.orderGid
      ) {
        try {
          const admin = await getAdminClient(attempt.shop, {
            accessToken: shopRecord.accessToken || "",
            record: shopRecord,
          });
          await ensureConfirmationSentOrderTag({
            attempt,
            shopRecord,
            admin,
            label: "attempt_send_clear_error_tags",
          });
        } catch (tagError) {
          console.error(
            "[wa_confirmation_sent_tag]",
            attempt.shop,
            tagError?.message || tagError,
          );
        }
      }
    } catch (e) {
      const message = e?.message || "WhatsApp send failed";
      const meta = e?.meta || e?.fallback || e?.data || null;
      const classified = classifyWhatsAppSendError(e);

      attempt.lastError = message;
      attempt.lastErrorAt = new Date();
      const storedMeta = sanitizeStoredMeta({
        ...(meta ? { meta } : {}),
        ...(classified ? { classified } : {}),
      });
      setAttemptLastErrorMeta(attempt, storedMeta);
      pushErrorEvent(attempt, "send", message, storedMeta);

      attempt.retryCount = Number(attempt.retryCount || 0) + 1;

      await tagOrderForMetaSendError({
        shop: attempt.shop,
        accessToken: shopRecord?.accessToken,
        orderGid: attempt.orderGid,
        error: e,
        label: "attempt_send_error_tag",
      });

      // Retry with backoff + within working hours.
      if (
        Number.isFinite(WA_MAX_RETRIES) &&
        attempt.retryCount < WA_MAX_RETRIES &&
        classified?.retryable !== false
      ) {
        const retryAfterSec = Number(classified?.retryAfterSec || 0);
        const retryAfterMin =
          retryAfterSec > 0 ? Math.ceil(retryAfterSec / 60) : 0;
        const delayMin =
          retryAfterMin > 0 ? retryAfterMin : retryDelayMin(attempt.retryCount);
        const baseReschedule = nextAllowedTimeUTC(
          tz,
          delayMin,
          startHour,
          endHour,
        );
        const jitterSec = jitterSecondsFromSeed(String(attempt._id), 25);
        const reschedule = addSeconds(baseReschedule, jitterSec);
        attempt.status = "scheduled";
        attempt.scheduledAt = reschedule;
        await attempt.save();

        await agenda.schedule(reschedule, "attempt_cod_confirmation", {
          attemptId,
        });
        return;
      }

      attempt.status = "failed";
      await attempt.save();
      await maybeReleaseQueuesForResolvedAttempt(attempt, "send_failed");

      const autoTagOrders = settings?.autoTagOrders !== false;
      if (autoTagOrders && shopRecord && attempt.orderGid) {
        try {
          const admin = await getAdminClient(attempt.shop, {
            accessToken: shopRecord.accessToken || "",
            record: shopRecord,
          });
          await appendOrderTag(admin, attempt.orderGid, "cod_wa_failed");
        } catch (e2) {
          console.error("[wa_failed_tag]", attempt.shop, e2?.message || e2);
        }
      }
      return;
    }
  } catch (e) {
    console.error("[attempt_cod_confirmation_unhandled]", {
      attemptId: String(attemptId || ""),
      shop: String(attempt?.shop || ""),
      orderName: String(attempt?.orderName || ""),
      senderMode: String(attempt?.senderMode || ""),
      status: String(attempt?.status || ""),
      message: e?.message || String(e || ""),
    });
    if (!attempt?._id) return;
    try {
      await requeueAttemptAfterProcessingGap({
        attempt,
        settings,
        reason: "unexpected_processing_error",
        meta: {
          message: String(e?.message || "Unexpected attempt processing error"),
          name: String(e?.name || "Error"),
        },
        delayMin: SEND_LOCK_MIN,
        source: "attempt_cod_confirmation_unhandled",
      });
    } catch (requeueError) {
      console.error("[attempt_cod_confirmation_requeue_failed]", {
        attemptId: String(attemptId || ""),
        shop: String(attempt?.shop || ""),
        message: requeueError?.message || String(requeueError || ""),
      });
    }
  }
});

agenda.define("recover_stale_pending_attempts", async () => {
  const cutoff = new Date(Date.now() - STALE_PENDING_GRACE_MIN * 60 * 1000);
  const staleAttempts = await CodAttempt.find({
    status: "pending",
    waSentAt: null,
    lastTriedAt: { $lte: cutoff },
  })
    .sort({ lastTriedAt: 1, updatedAt: 1 })
    .limit(200);

  for (const attempt of staleAttempts) {
    try {
      const shopRecord = await Shop.findOne({ shop: attempt.shop })
        .select({ settings: 1 })
        .lean();
      const settings = shopRecord?.settings || {};
      await requeueAttemptAfterProcessingGap({
        attempt,
        settings,
        reason: "stale_pending_recovered",
        meta: {
          staleMinutes: STALE_PENDING_GRACE_MIN,
          lastTriedAt: attempt.lastTriedAt || null,
        },
        delayMin: 1,
        source: "recover_stale_pending_attempts",
      });
    } catch (e) {
      console.error("[recover_stale_pending_attempts]", {
        attemptId: attempt?._id?.toString?.() || "",
        shop: String(attempt?.shop || ""),
        orderName: String(attempt?.orderName || ""),
        message: e?.message || String(e || ""),
      });
    }
  }
});

agenda.define("repair_stuck_attempt_queues", async () => {
  const sources = await CodAttempt.find({
    status: { $in: Array.from(TERMINAL_ATTEMPT_STATUSES) },
    $or: [
      {
        phoneQueueGroupId: { $exists: true, $ne: null },
        phoneQueueRole: "primary",
      },
      {
        duplicateGroupId: { $exists: true, $ne: null },
        duplicateRole: "primary",
      },
      {
        duplicateGroupId: { $exists: true, $ne: null },
        duplicateRole: "queued",
        duplicateReleasedAt: { $ne: null },
      },
    ],
  })
    .sort({ updatedAt: -1 })
    .limit(200)
    .lean();

  for (const source of sources) {
    try {
      const phoneGroupId = String(source?.phoneQueueGroupId || "").trim();
      if (phoneGroupId) {
        const phoneControllerExists = await CodAttempt.exists({
          shop: source.shop,
          phoneQueueGroupId: phoneGroupId,
          _id: { $ne: source._id },
          phoneQueueRole: "primary",
          status: { $nin: Array.from(TERMINAL_ATTEMPT_STATUSES) },
        });
        if (phoneControllerExists) {
          continue;
        }
      }

      const duplicateGroupId = String(source?.duplicateGroupId || "").trim();
      if (duplicateGroupId) {
        const duplicateControllerExists = await CodAttempt.exists({
          shop: source.shop,
          duplicateGroupId,
          _id: { $ne: source._id },
          status: { $nin: Array.from(TERMINAL_ATTEMPT_STATUSES) },
          $or: [
            { duplicateRole: "primary" },
            {
              duplicateRole: "queued",
              duplicateReleasedAt: { $ne: null },
            },
          ],
        });
        if (duplicateControllerExists) {
          continue;
        }
      }

      await releaseQueuesAfterAttemptResolved({
        sourceAttempt: source,
        fromE164: source.phoneE164,
        context: "repair_stuck_attempt_queues",
      });
    } catch (e) {
      console.error("[repair_stuck_attempt_queues]", {
        attemptId: source?._id?.toString?.() || "",
        shop: String(source?.shop || ""),
        orderName: String(source?.orderName || ""),
        message: e?.message || String(e || ""),
      });
    }
  }
});

agenda.define("repair_missing_confirmation_sent_tags", async () => {
  const cutoff = new Date(
    Date.now() - CONFIRMATION_TAG_REPAIR_LOOKBACK_HOURS * 60 * 60 * 1000,
  );
  const candidates = await CodAttempt.find({
    stage: "pre_dispatch",
    status: "wa_sent",
    orderGid: { $exists: true, $ne: null },
    $or: [
      { waSentAt: { $gte: cutoff } },
      {
        waSentAt: null,
        updatedAt: { $gte: cutoff },
      },
    ],
  })
    .sort({ waSentAt: 1, updatedAt: 1, _id: 1 })
    .limit(CONFIRMATION_TAG_REPAIR_BATCH)
    .lean();

  if (!candidates.length) return;

  const shopCache = new Map();
  const adminCache = new Map();

  for (const attempt of candidates) {
    try {
      const shop = String(attempt?.shop || "").trim();
      if (!shop || !attempt?.orderGid) continue;

      let shopRecord = shopCache.get(shop);
      if (shopRecord === undefined) {
        shopRecord = await Shop.findOne({ shop })
          .select({ accessToken: 1, settings: 1 })
          .lean()
          .catch(() => null);
        shopCache.set(shop, shopRecord || null);
      }
      if (!shopRecord) continue;

      let admin = adminCache.get(shop);
      if (admin === undefined) {
        admin = await getAdminClient(shop, {
          accessToken: shopRecord.accessToken || "",
          record: shopRecord,
        }).catch(() => null);
        adminCache.set(shop, admin || null);
      }
      if (!admin) continue;

      await ensureConfirmationSentOrderTag({
        attempt,
        shopRecord,
        admin,
        label: "repair_missing_confirmation_sent_tags",
        verifyLiveState: true,
      });
    } catch (e) {
      console.error("[repair_missing_confirmation_sent_tags]", {
        attemptId: attempt?._id?.toString?.() || "",
        shop: String(attempt?.shop || ""),
        orderName: String(attempt?.orderName || ""),
        message: e?.message || String(e || ""),
      });
    }
  }
});

agenda.define("repair_missing_outcome_tags", async () => {
  const cutoff = new Date(
    Date.now() - OUTCOME_TAG_REPAIR_LOOKBACK_HOURS * 60 * 60 * 1000,
  );
  const candidates = await CodAttempt.find({
    status: { $in: ["confirmed", "cancelled"] },
    orderGid: { $exists: true, $ne: null },
    outcomeTagSyncedAt: null,
    updatedAt: { $gte: cutoff },
  })
    .sort({ updatedAt: 1, _id: 1 })
    .limit(OUTCOME_TAG_REPAIR_BATCH)
    .lean();

  if (!candidates.length) return;

  const shopCache = new Map();
  const adminCache = new Map();
  for (const attempt of candidates) {
    const shop = String(attempt?.shop || "").trim();
    if (!shop || !attempt?.orderGid) continue;

    let shopRecord = shopCache.get(shop);
    if (shopRecord === undefined) {
      shopRecord = await Shop.findOne({ shop })
        .select({ accessToken: 1 })
        .lean()
        .catch(() => null);
      shopCache.set(shop, shopRecord || null);
    }
    if (!shopRecord) continue;

    let admin = adminCache.get(shop);
    if (admin === undefined) {
      admin = await getAdminClient(shop, {
        accessToken: shopRecord.accessToken || "",
        record: shopRecord,
      }).catch(() => null);
      adminCache.set(shop, admin || null);
    }
    if (!admin) continue;

    await syncAttemptOutcomeTags(attempt, { shopRecord, admin });
  }
});

// Mark attempts as expired when customers never reply.
// Pre-dispatch confirmation attempts expire after a mandatory 48h.
// Other stages still use each shop's `maxAttemptAgeHours` setting.
agenda.define("expire_unresponsive_attempts", async () => {
  const shops = await Shop.find(buildShopifyCredentialCandidateQuery()).lean();

  for (const s of shops) {
    const shop = s.shop;
    const maxAttemptAgeHours = Number(s?.settings?.maxAttemptAgeHours ?? 72);
    const fallbackStageHours =
      Number.isFinite(maxAttemptAgeHours) && maxAttemptAgeHours > 0
        ? maxAttemptAgeHours
        : 72;
    const preDispatchCutoff = new Date(
      Date.now() - AUTO_CANCEL_UNCONFIRMED_HOURS * 60 * 60 * 1000,
    );
    const otherStagesCutoff = new Date(
      Date.now() - fallbackStageHours * 60 * 60 * 1000,
    );

    // Pre-dispatch confirmations: hard cutoff 48h.
    // Other stages (e.g. post_failed_delivery): use merchant-configured age.
    const candidates = await CodAttempt.find({
      shop,
      status: "wa_sent",
      $or: [
        {
          stage: "pre_dispatch",
          $or: [
            { waSentAt: { $lte: preDispatchCutoff } },
            { waSentAt: null, lastTriedAt: { $lte: preDispatchCutoff } },
            {
              waSentAt: null,
              lastTriedAt: null,
              updatedAt: { $lte: preDispatchCutoff },
            },
          ],
        },
        {
          stage: { $ne: "pre_dispatch" },
          $or: [
            { waSentAt: { $lte: otherStagesCutoff } },
            { waSentAt: null, lastTriedAt: { $lte: otherStagesCutoff } },
            {
              waSentAt: null,
              lastTriedAt: null,
              updatedAt: { $lte: otherStagesCutoff },
            },
          ],
        },
      ],
    })
      .sort({ waSentAt: 1, lastTriedAt: 1, updatedAt: 1 })
      .limit(500);

    if (!candidates.length) continue;

    let admin = null;
    try {
      admin = await getAdminClient(shop, {
        accessToken: s.accessToken || "",
        record: s,
      });
    } catch (e) {
      admin = null;
    }

    for (const attempt of candidates) {
      try {
        // Re-check "sent at" to avoid expiring fresh attempts that were matched by a null-field fallback.
        const sentAt =
          attempt.waSentAt ||
          attempt.lastTriedAt ||
          attempt.updatedAt ||
          attempt.createdAt;
        const effectiveHours =
          attempt.stage === "pre_dispatch"
            ? AUTO_CANCEL_UNCONFIRMED_HOURS
            : fallbackStageHours;
        const cutoff = new Date(Date.now() - effectiveHours * 60 * 60 * 1000);
        if (!sentAt || new Date(sentAt).getTime() > cutoff.getTime()) continue;

        // Safety: if the order was resolved manually on Shopify, reflect that instead of expiring.
        if (admin && attempt.orderGid) {
          try {
            const tags = await fetchOrderTags(admin, attempt.orderGid);
            const normalized = (tags || [])
              .map((t) =>
                String(t || "")
                  .trim()
                  .toLowerCase(),
              )
              .filter(Boolean);

            if (
              hasNormalizedTag(normalized, ORDER_CANCELLED_TAG) ||
              hasNormalizedTag(normalized, "cod_cancelled")
            ) {
              const t = new Date();
              const cancelled = await CodAttempt.findOneAndUpdate(
                {
                  _id: attempt._id,
                  status: "wa_sent",
                },
                {
                  $set: {
                    status: "cancelled",
                    cancelledAt: attempt.cancelledAt || t,
                    cancelSource: attempt.cancelSource || "shopify_tag_sync",
                    processedAt: attempt.processedAt || t,
                    lastError: null,
                    lastErrorAt: null,
                    lastErrorMeta: { tags },
                  },
                },
                { new: true },
              );
              if (!cancelled) continue;
              await releaseQueuesAfterAttemptResolved({
                sourceAttempt: cancelled,
                fromE164: cancelled.phoneE164,
                context: "expire_tag_sync_cancelled",
              });
              continue;
            }

            if (
              hasNormalizedTag(normalized, ORDER_CONFIRMED_TAG) ||
              hasNormalizedTag(normalized, "order_confirmed✅") ||
              normalized.includes("cod_redeliver")
            ) {
              const t = new Date();
              const confirmed = await CodAttempt.findOneAndUpdate(
                {
                  _id: attempt._id,
                  status: "wa_sent",
                },
                {
                  $set: {
                    status: "confirmed",
                    confirmedAt: attempt.confirmedAt || t,
                    confirmSource: attempt.confirmSource || "shopify_tag_sync",
                    processedAt: attempt.processedAt || t,
                    lastError: null,
                    lastErrorAt: null,
                    lastErrorMeta: { tags },
                  },
                },
                { new: true },
              );
              if (!confirmed) continue;
              await releaseQueuesAfterAttemptResolved({
                sourceAttempt: confirmed,
                fromE164: confirmed.phoneE164,
                context: "expire_tag_sync_confirmed",
              });
              continue;
            }
          } catch {
            // If tag sync fails, still expire the attempt (we're past the response window).
          }
        }

        const now = new Date();
        const expired = await CodAttempt.findOneAndUpdate(
          {
            _id: attempt._id,
            status: "wa_sent",
          },
          {
            $set: {
              status: "expired",
              expiredAt: attempt.expiredAt || now,
              expireSource: attempt.expireSource || "no_response",
              processedAt: attempt.processedAt || now,
              lastError: "no_response",
              lastErrorAt: now,
              lastErrorMeta: {
                maxAttemptAgeHours: effectiveHours,
                confirmationExpired: attempt.stage === "pre_dispatch",
              },
            },
          },
          { new: true },
        );
        if (!expired) continue;
        await releaseQueuesAfterAttemptResolved({
          sourceAttempt: expired,
          fromE164: expired.phoneE164,
          context: "expire_no_response",
        });

        // Tag Shopify order so merchants can filter no-response expiries.
        if (admin && attempt.orderGid) {
          const expireTags = [CONFIRMATION_EXPIRED_TAG];
          if (COD_EXPIRED_TAG) expireTags.push(COD_EXPIRED_TAG);
          try {
            await appendOrderTag(admin, attempt.orderGid, expireTags[0]);
            if (expireTags.length > 1) {
              for (const extraTag of expireTags.slice(1)) {
                await appendOrderTag(admin, attempt.orderGid, extraTag);
              }
            }
          } catch (e) {
            console.error(
              "[expire_tag]",
              shop,
              attempt.orderGid,
              e?.message || e,
            );
          }
        }
      } catch (e) {
        console.error(
          "[expire_unresponsive_attempts]",
          shop,
          attempt?._id?.toString?.() || "",
          e?.message || e,
        );
      }
    }
  }
});

export async function startAgenda() {
  await agenda.start();

  // Poll fallback; orders/create webhooks also trigger this job immediately.
  await agenda.every(COD_ORDER_POLL_INTERVAL, "poll_cod_orders");

  // Keep billing status fresh (so message gating stays accurate even if the merchant doesn't open the app)
  await agenda.every("30 minutes", "sync_billing");
  await agenda.every("1 hour", "migrate_legacy_shopify_offline_tokens");

  // Poll Shopify abandoned checkouts for stores that enabled recovery.
  await agenda.every("30 minutes", "poll_abandoned_cart_recoveries");

  // Backfill delivered/fulfilled orders that still need a review request.
  await agenda.every("30 minutes", "poll_review_request_recoveries");

  // Retry transient billing submissions and repair any pending usage rows.
  await agenda.every("5 minutes", "reconcile_shopify_usage_charges");
  await agenda.every("30 minutes", "reconcile_shopify_usage_balances");
  await agenda.every("12 hours", "cleanup_agenda_jobs");
  await agenda.every(
    PENDING_ATTEMPT_RECOVERY_INTERVAL,
    "recover_stale_pending_attempts",
  );
  await agenda.every("5 minutes", "repair_stuck_attempt_queues");
  await agenda.every(
    CONFIRMATION_TAG_REPAIR_INTERVAL,
    "repair_missing_confirmation_sent_tags",
  );
  await agenda.every(OUTCOME_TAG_REPAIR_INTERVAL, "repair_missing_outcome_tags");

  // Keep BYON Meta tokens fresh before expiry (configuration tokens expire).
  await agenda.every(BYON_TOKEN_REFRESH_INTERVAL, "refresh_byon_tokens");
  if (BYON_TOKEN_REFRESH_STARTUP_RUN) {
    await agenda.now("refresh_byon_tokens");
  }

  await agenda.now("reconcile_shopify_usage_charges");
  await agenda.now("reconcile_shopify_usage_balances");
  await agenda.now("cleanup_agenda_jobs");
  await agenda.now("recover_stale_pending_attempts");
  await agenda.now("repair_stuck_attempt_queues");
  await agenda.now("repair_missing_confirmation_sent_tags");
  await agenda.now("repair_missing_outcome_tags");
  await agenda.now("migrate_legacy_shopify_offline_tokens");

  // Expire requests that received no customer response within the configured window.
  await agenda.every("1 hour", "expire_unresponsive_attempts");
}
