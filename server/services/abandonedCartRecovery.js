import crypto from "crypto";

import AbandonedCheckoutDispatch from "../models/AbandonedCheckoutDispatch.js";
import BlockedContact from "../models/BlockedContact.js";
import Shop from "../models/Shop.js";
import { buildShopifyCredentialCandidateQuery } from "./shopifyTokenState.js";

import { canSendWhatsApp, incrementWhatsAppUsage } from "./usage.js";
import { normalizePhoneE164 } from "./phone.js";
import {
  getAdminClient,
  listAbandonedCheckouts,
} from "./shopifyAdmin.js";
import {
  ensureAutomationFlowConfigs,
  ensureManagedTemplateCatalog,
  FLOW_KEYS,
  isTemplateApproved,
  resolveAssignedTemplateForFlow,
} from "./templateCatalog.js";
import { getPlan, SENDER_MODES } from "./plans.js";
import {
  resolveRuntimeConfig,
  sendAbandonedCartRecoveryTemplate,
} from "./whatsapp.js";
import { summarizeSendGateForStorage } from "./storageSanitizer.js";

const POLL_BATCH_SIZE = Math.max(
  1,
  Math.min(50, Number(process.env.ABANDONED_CART_POLL_BATCH_SIZE || 25) || 25),
);
const MAX_PER_SHOP = Math.max(
  1,
  Math.min(
    200,
    Number(process.env.ABANDONED_CART_MAX_PER_SHOP || 75) || 75,
  ),
);
const RETRY_COOLDOWN_MINUTES = Math.max(
  5,
  Number(process.env.ABANDONED_CART_RETRY_COOLDOWN_MINUTES || 30) || 30,
);

function asString(value) {
  return String(value || "").trim();
}

function hashKey(prefix, raw) {
  const digest = crypto
    .createHash("sha1")
    .update(String(raw || ""))
    .digest("hex");
  return `${prefix}:${digest}`;
}

function getAbandonedCartFlow(shopRecord) {
  const flows = ensureAutomationFlowConfigs(shopRecord?.settings?.automationFlows);
  const row = flows.find((flow) => flow.flowKey === FLOW_KEYS.ABANDONED_CART);
  return {
    flows,
    row: row || null,
    enabled: !!row?.enabled,
    delayMinutes: Math.max(
      15,
      Number(
        row?.config?.delayMinutes ??
          shopRecord?.settings?.abandonedCartDelayMinutes ??
          90,
      ) || 90,
    ),
  };
}

function isRetryReady(existing, now = new Date()) {
  if (!existing) return true;
  const status = asString(existing.status).toLowerCase();
  if (status === "sent" || status === "recovered") return false;
  const updatedAt = existing.updatedAt ? new Date(existing.updatedAt) : null;
  if (!updatedAt || !Number.isFinite(updatedAt.getTime())) return true;
  return now.getTime() - updatedAt.getTime() >= RETRY_COOLDOWN_MINUTES * 60 * 1000;
}

function formatAmount(value, currency) {
  const amount = Number(value || 0);
  const code = asString(currency);
  if (!Number.isFinite(amount) || !code) return "";
  return `${code} ${amount.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

function firstLineItemName(lineSummary = []) {
  const first = Array.isArray(lineSummary) ? lineSummary[0] : "";
  const text = asString(first);
  return text.replace(/\s+x\d+$/i, "").trim();
}

function buildSearchQuery(cutoff) {
  const iso = new Date(cutoff).toISOString();
  return `status:open recovery_state:not_recovered updated_at:<='${iso}'`;
}

function normalizeCheckoutPhone(checkout) {
  const countryCode = asString(checkout?.countryCode || "").toUpperCase() || undefined;
  return (
    normalizePhoneE164(checkout?.customerPhone, countryCode) ||
    normalizePhoneE164(checkout?.shippingPhone, countryCode) ||
    normalizePhoneE164(checkout?.billingPhone, countryCode) ||
    ""
  );
}

function buildAddressText(checkout) {
  const parts = [
    checkout?.shippingAddress?.address1,
    checkout?.shippingAddress?.city,
    checkout?.shippingAddress?.zip,
  ]
    .map(asString)
    .filter(Boolean);
  return parts.join(", ");
}

function isOwnNumberPlanRecord(record) {
  const plan = getPlan(record?.billing?.planKey);
  return String(plan?.senderMode || "").trim() === SENDER_MODES.OWN_NUMBER;
}

async function updateDispatch(dedupeKey, patch = {}) {
  await AbandonedCheckoutDispatch.updateOne(
    { dedupeKey },
    {
      $set: patch,
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );
}

async function processCheckout({ shopRecord, checkout, flow, now }) {
  const shop = asString(shopRecord?.shop);
  const dedupeKey = hashKey(
    "abandoned_cart_recovery",
    `${shop}|${asString(checkout?.id)}`,
  );
  const existing = await AbandonedCheckoutDispatch.findOne({ dedupeKey }).lean();
  if (!isRetryReady(existing, now)) {
    return { ok: true, skipped: true, reason: "cooldown", dedupeKey };
  }

  const phoneE164 = normalizeCheckoutPhone(checkout);
  const abandonedAt = checkout?.updatedAt ? new Date(checkout.updatedAt) : null;
  const abandonedMinutes = abandonedAt
    ? Math.max(0, Math.floor((now.getTime() - abandonedAt.getTime()) / 60000))
    : flow.delayMinutes;

  const basePatch = {
    shop,
    checkoutId: asString(checkout?.id),
    checkoutName: asString(checkout?.name) || null,
    checkoutUrl: asString(checkout?.checkoutUrl) || null,
    customerName: asString(checkout?.customerName) || null,
    customerEmail: asString(checkout?.customerEmail) || null,
    phoneE164: phoneE164 || null,
    meta: {
      abandonedAt: abandonedAt || null,
      abandonedMinutes,
      delayMinutes: flow.delayMinutes,
      productImageUrl: asString(checkout?.productImageUrl) || null,
      lineSummary: Array.isArray(checkout?.lineSummary) ? checkout.lineSummary : [],
    },
  };

  if (!phoneE164) {
    await updateDispatch(dedupeKey, {
      ...basePatch,
      status: "skipped",
      skippedReason: "missing_phone",
    });
    return { ok: true, skipped: true, reason: "missing_phone", dedupeKey };
  }

  if (!asString(checkout?.checkoutUrl)) {
    await updateDispatch(dedupeKey, {
      ...basePatch,
      status: "skipped",
      skippedReason: "missing_checkout_url",
    });
    return {
      ok: true,
      skipped: true,
      reason: "missing_checkout_url",
      dedupeKey,
    };
  }

  const blocked = await BlockedContact.exists({ shop, phoneE164 });
  if (blocked) {
    await updateDispatch(dedupeKey, {
      ...basePatch,
      status: "skipped",
      skippedReason: "blocked_contact",
    });
    return { ok: true, skipped: true, reason: "blocked_contact", dedupeKey };
  }

  const runtime = await resolveRuntimeConfig(shop).catch(() => null);
  if (asString(runtime?.senderMode) !== "own_number" || runtime?.senderUnavailableReason) {
    await updateDispatch(dedupeKey, {
      ...basePatch,
      status: "skipped",
      skippedReason: "sender_not_ready",
      errorMeta: runtime?.senderUnavailableReason
        ? { senderUnavailableReason: runtime.senderUnavailableReason }
        : null,
    });
    return { ok: true, skipped: true, reason: "sender_not_ready", dedupeKey };
  }
  const gate = await canSendWhatsApp(shop, {
    toE164: phoneE164,
    alreadyInConversationWindow: false,
    senderPhoneNumberId: runtime?.phoneId || "",
    isTemplate: true,
  });
  if (!gate?.ok) {
    await updateDispatch(dedupeKey, {
      ...basePatch,
      status: "skipped",
      skippedReason: "billing_or_usage_blocked",
      errorMeta: summarizeSendGateForStorage(gate),
    });
    return {
      ok: true,
      skipped: true,
      reason: "billing_or_usage_blocked",
      dedupeKey,
    };
  }

  await updateDispatch(dedupeKey, {
    ...basePatch,
    status: "processing",
    skippedReason: null,
    errorMessage: null,
    errorMeta: null,
  });

  const productsText = Array.isArray(checkout?.lineSummary)
    ? checkout.lineSummary.join("\n")
    : "";
  const sendResult = await sendAbandonedCartRecoveryTemplate({
    to: phoneE164,
    customerName: asString(checkout?.customerName) || "Customer",
    storeName:
      asString(checkout?.shopName) || shop.replace(".myshopify.com", ""),
    productName: firstLineItemName(checkout?.lineSummary),
    productsText,
    productImageUrl: asString(checkout?.productImageUrl) || "",
    totalPrice: formatAmount(checkout?.amount, checkout?.currencyCode),
    checkoutUrl: asString(checkout?.checkoutUrl),
    abandonedMinutes,
    shop,
    meta: {
      checkoutId: asString(checkout?.id),
      checkoutName: asString(checkout?.name),
      customerEmail: asString(checkout?.customerEmail) || null,
      recoveryType: "abandoned_cart",
      deliveryAddress: buildAddressText(checkout),
    },
  });

  await incrementWhatsAppUsage(shop, 1, {
    isTemplate: true,
    toE164: phoneE164,
    countInitiatedConversation: true,
    senderPhoneNumberId: runtime?.phoneId || "",
  });

  await updateDispatch(dedupeKey, {
    ...basePatch,
    status: "sent",
    templateUsed: sendResult?.templateUsed || null,
    waMessageId: sendResult?.data?.messages?.[0]?.id || null,
    sentAt: new Date(),
    skippedReason: null,
    errorMessage: null,
    errorMeta: null,
  });

  return {
    ok: true,
    sent: true,
    dedupeKey,
    waMessageId: sendResult?.data?.messages?.[0]?.id || null,
  };
}

async function processShop(shopRecord, now) {
  const shop = asString(shopRecord?.shop);
  const flow = getAbandonedCartFlow(shopRecord);
  if (!shop || !flow.enabled) {
    return { shop, scanned: 0, sent: 0, skipped: 0, failed: 0 };
  }
  if (!isOwnNumberPlanRecord(shopRecord)) {
    return {
      shop,
      scanned: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      reason: "requires_own_number_plan",
    };
  }

  const catalog = ensureManagedTemplateCatalog(
    shopRecord?.whatsappSender?.ownNumber?.managedTemplates,
  );
  const assignedTemplate = resolveAssignedTemplateForFlow({
    catalog,
    flows: flow.flows,
    flowKey: FLOW_KEYS.ABANDONED_CART,
  });
  if (!assignedTemplate || !isTemplateApproved(assignedTemplate)) {
    return {
      shop,
      scanned: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      reason: "template_not_ready",
    };
  }

  const admin = await getAdminClient(shop, {
    accessToken: shopRecord.accessToken || "",
    record: shopRecord,
  });
  const cutoff = new Date(now.getTime() - flow.delayMinutes * 60 * 1000);
  const query = buildSearchQuery(cutoff);

  let after = null;
  let scanned = 0;
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  while (scanned < MAX_PER_SHOP) {
    const page = await listAbandonedCheckouts(admin, {
      first: Math.min(POLL_BATCH_SIZE, MAX_PER_SHOP - scanned),
      after,
      query,
    });
    const items = Array.isArray(page?.items) ? page.items : [];
    if (!items.length) break;

    for (const checkout of items) {
      scanned += 1;
      try {
        const result = await processCheckout({ shopRecord, checkout, flow, now });
        if (result?.sent) sent += 1;
        else skipped += 1;
      } catch (error) {
        failed += 1;
        const dedupeKey = hashKey(
          "abandoned_cart_recovery",
          `${shop}|${asString(checkout?.id)}`,
        );
        await updateDispatch(dedupeKey, {
          shop,
          checkoutId: asString(checkout?.id),
          checkoutName: asString(checkout?.name) || null,
          checkoutUrl: asString(checkout?.checkoutUrl) || null,
          customerName: asString(checkout?.customerName) || null,
          customerEmail: asString(checkout?.customerEmail) || null,
          phoneE164: normalizeCheckoutPhone(checkout) || null,
          status: "failed",
          errorMessage: error?.message || "abandoned cart send failed",
          errorMeta: error?.meta || error?.data || null,
        });
      }
      if (scanned >= MAX_PER_SHOP) break;
    }

    if (!page?.pageInfo?.hasNextPage || !page?.pageInfo?.endCursor) break;
    after = page.pageInfo.endCursor;
  }

  return { shop, scanned, sent, skipped, failed };
}

export async function pollAbandonedCartRecoveries({ now = new Date() } = {}) {
  const shops = await Shop.find(
    {
      ...buildShopifyCredentialCandidateQuery(),
      "settings.automationFlows": {
        $elemMatch: {
          flowKey: FLOW_KEYS.ABANDONED_CART,
          enabled: true,
        },
      },
    },
    {
      shop: 1,
      accessToken: 1,
      settings: 1,
      billing: 1,
      whatsappSender: 1,
    },
  ).lean();

  const results = [];
  for (const shopRecord of shops) {
    try {
      results.push(await processShop(shopRecord, now));
    } catch (error) {
      results.push({
        shop: asString(shopRecord?.shop),
        scanned: 0,
        sent: 0,
        skipped: 0,
        failed: 1,
        error: error?.message || "abandoned cart poll failed",
      });
    }
  }

  return {
    ok: true,
    shopCount: shops.length,
    results,
  };
}
