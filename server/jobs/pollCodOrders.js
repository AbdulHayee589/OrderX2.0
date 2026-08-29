import crypto from "crypto";
import Shop from "../models/Shop.js";
import CodAttempt from "../models/CodAttempt.js";
import BlockedContact from "../models/BlockedContact.js";
import { getAdminClient, appendOrderTags } from "../services/shopifyAdmin.js";
import { agenda } from "./agenda.js";
import {
  resolveTimezoneFromCountry,
  nextAllowedTimeUTC,
} from "../services/timezone.js";
import { normalizePhoneE164 } from "../services/phone.js";
import { getBillingStatus } from "../services/billing.js";
import { SENDER_MODES } from "../services/plans.js";
import { buildShopifyCredentialCandidateQuery } from "../services/shopifyTokenState.js";

const LOOKBACK_HOURS = 48;
const DUPLICATE_WINDOW_HOURS = Number(process.env.DUPLICATE_WINDOW_HOURS || 24);
const ORDER_ACCESS_BLOCK_TTL_HOURS = Number(
  process.env.ORDER_ACCESS_BLOCK_TTL_HOURS || 1,
);
const DEBUG_POLL =
  process.env.DEBUG_POLL_COD_POLL === "true" ||
  process.env.DEBUG_ORDERX === "true";
const ORDER_CONFIRMED_TAG = "ORDER_CONFIRMED✅";
const ORDER_CANCELLED_TAG = "ORDER_CANCELLED❌";
const DUPLICATE_DETECTED_TAG = "DUPLICATE_DETECTED ⚠️";
const PRIMARY_ORDER_TAG = "PRIMARY_ORDER 🥇";
const DUPLICATE_QUEUED_TAG = "DUPLICATE_QUEUED ⏳";

function dbg(...args) {
  if (DEBUG_POLL) console.log(...args);
}

function isProtectedCustomerDataBlock(err) {
  const msg = String(err?.message || "").toLowerCase();
  return (
    msg.includes("not approved to access the order object") ||
    msg.includes("protected-customer-data") ||
    msg.includes("protected customer data")
  );
}

function buildOrderSearchQuery() {
  const sinceDate = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);
  const yyyy = sinceDate.getUTCFullYear();
  const mm = String(sinceDate.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(sinceDate.getUTCDate()).padStart(2, "0");
  return `created_at:>=${yyyy}-${mm}-${dd}`;
}

function normalizeOrderPollingScope(v) {
  return String(v || "").trim().toLowerCase() === "cod_only"
    ? "cod_only"
    : "all_orders";
}

function isCODFromGateways(gateways) {
  return (gateways || []).some((g) => {
    const x = String(g || "").toLowerCase();
    return x.includes("cash") || x.includes("cod");
  });
}

function localDateKey(date, timeZone) {
  const value = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(value.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: String(timeZone || "UTC"),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(value);
  } catch {
    return value.toISOString().slice(0, 10);
  }
}

function isSameLocalDay(left, right, timeZone) {
  const leftKey = localDateKey(left, timeZone);
  const rightKey = localDateKey(right, timeZone);
  return !!leftKey && leftKey === rightKey;
}

function toValidDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function getOrderConfirmationStartAt({ shopRecord, billing }) {
  const senderMode = normalizeSenderModeForQueue(
    billing?.plan?.senderMode ||
      shopRecord?.whatsappSender?.activeMode ||
      shopRecord?.whatsappSender?.preferenceMode,
  );
  if (senderMode !== SENDER_MODES.OWN_NUMBER) return null;

  const own = shopRecord?.whatsappSender?.ownNumber || {};
  return (
    toValidDate(own?.templatesReadyAt) ||
    toValidDate(own?.readyAt) ||
    null
  );
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

function extractPhoneAndCountry(order) {
  const rawPhone =
    order.shippingAddress?.phone ||
    order.billingAddress?.phone ||
    order.customer?.phone ||
    null;

  const countryCode =
    order.shippingAddress?.countryCode ||
    order.billingAddress?.countryCode ||
    null;

  return { rawPhone, countryCode };
}

function normalizeText(v) {
  return String(v || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeOrderName(v) {
  return String(v || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function hasExactTag(tags = [], tag = "") {
  const needle = String(tag || "").trim();
  if (!needle) return false;
  return tags.includes(needle);
}

function normalizeEmail(v) {
  return String(v || "")
    .trim()
    .toLowerCase();
}

function normalizePhoneDigits(v) {
  return String(v || "").replace(/[^\d]/g, "");
}

function buildSameOrderKey({ orderGid, orderName }) {
  const gid = String(orderGid || "").trim();
  if (gid) return `gid:${gid}`;

  const name = normalizeOrderName(orderName);
  if (name) return `name:${name}`;

  return "";
}

function isSameOrderIdentity(left, right) {
  if (!left || !right) return false;

  const leftGid = String(left?.orderGid || left?.id || "").trim();
  const rightGid = String(right?.orderGid || right?.id || "").trim();
  if (leftGid && rightGid) return leftGid === rightGid;

  const leftName = normalizeOrderName(left?.orderName || left?.name);
  const rightName = normalizeOrderName(right?.orderName || right?.name);
  return !!leftName && !!rightName && leftName === rightName;
}

function buildSameOrderLookupQuery({ shop, stage, orderGid, orderName }) {
  const gid = String(orderGid || "").trim();
  const normalizedName = normalizeOrderName(orderName);
  const or = [];

  if (gid) or.push({ orderGid: gid });
  if (normalizedName) {
    or.push({
      orderName: {
        $regex: `^${escapeRegex(String(orderName || "").trim())}$`,
        $options: "i",
      },
    });
  }

  if (!or.length) return null;

  return {
    shop,
    stage,
    $or: or,
  };
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDuplicateAttemptCreateError(error) {
  const code = Number(error?.code || 0);
  const message = String(error?.message || "");
  return code === 11000 || /duplicate key/i.test(message);
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

function resolveQueueSenderIdentity({ shop, shopRecord, billing }) {
  const billedMode = normalizeSenderModeForQueue(billing?.plan?.senderMode);
  const preferenceMode = normalizeSenderModeForQueue(
    shopRecord?.whatsappSender?.preferenceMode || billedMode,
  );
  const storedActiveMode = normalizeSenderModeForQueue(
    shopRecord?.whatsappSender?.activeMode || preferenceMode,
  );
  const resolvedMode = billing?.active ? billedMode : storedActiveMode;
  const ownPhoneId = String(
    shopRecord?.whatsappSender?.ownNumber?.phoneNumberId || "",
  ).trim();
  const orderxPhoneId = String(process.env.WA_PHONE_NUMBER_ID || "").trim();
  const senderPhoneNumberId =
    resolvedMode === SENDER_MODES.OWN_NUMBER ? ownPhoneId : orderxPhoneId;
  return {
    senderMode: resolvedMode,
    senderPhoneNumberId,
    senderQueueKey: buildSenderQueueKey({
      shop,
      senderMode: resolvedMode,
      senderPhoneNumberId,
    }),
  };
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

function pickCustomerName(order) {
  return (
    order?.shippingAddress?.name ||
    [order?.shippingAddress?.firstName, order?.shippingAddress?.lastName]
      .filter(Boolean)
      .join(" ")
      .trim() ||
    order?.customer?.displayName ||
    [order?.customer?.firstName, order?.customer?.lastName]
      .filter(Boolean)
      .join(" ")
      .trim() ||
    ""
  );
}

function normalizeAddress(order) {
  const a = order?.shippingAddress || order?.billingAddress || {};
  const parts = [a.address1, a.address2, a.city, a.province, a.zip, a.country]
    .map((x) => normalizeText(x))
    .filter(Boolean);
  return parts.join("|");
}

function normalizeProducts(order) {
  const edges = order?.lineItems?.edges || [];
  const normalized = edges
    .map((edge) => {
      const node = edge?.node || {};
      const title = normalizeText(
        [node.title, node.variantTitle].filter(Boolean).join(" "),
      );
      const qty = Number(node.quantity || 0);
      if (!title || !Number.isFinite(qty) || qty <= 0) return null;
      return `${title}::${qty}`;
    })
    .filter(Boolean)
    .sort();
  return normalized.join("|");
}

function buildDuplicateFingerprint(order, customerName, phoneE164, email) {
  const name = normalizeText(customerName);
  const phone = normalizePhoneDigits(phoneE164);
  const emailNorm = normalizeEmail(email);
  const amountNum = Number(order?.currentTotalPriceSet?.shopMoney?.amount || 0);
  const amount =
    Number.isFinite(amountNum) && amountNum > 0 ? amountNum.toFixed(2) : "";
  const currency = String(
    order?.currentTotalPriceSet?.shopMoney?.currencyCode || "",
  )
    .trim()
    .toUpperCase();
  const address = normalizeAddress(order);
  const products = normalizeProducts(order);

  // Strict duplicate requirement from product spec:
  // name + phone + email + currency + product(s)+qty + amount + address must all match.
  if (!name || !phone || !currency || !products || !amount || !address)
    return null;

  return [
    name,
    phone,
    emailNorm || "no_email",
    currency,
    products,
    amount,
    address,
  ].join("||");
}

function buildDuplicateGroupId(shop, seed) {
  const raw = `${shop}|${seed || ""}`;
  const digest = crypto
    .createHash("sha1")
    .update(raw)
    .digest("hex")
    .slice(0, 18);
  return `dup_${digest}`;
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

async function safeTagOrder(admin, shop, orderGid, tags) {
  if (!admin || !orderGid || !Array.isArray(tags) || !tags.length) return;
  try {
    await appendOrderTags(admin, orderGid, tags);
  } catch (e) {
    console.error("[duplicate_tag]", shop, orderGid, e?.message || e);
  }
}

agenda.define("poll_cod_orders", async (job) => {
  const targetShop = String(job?.attrs?.data?.shop || "").trim();
  const shops = await Shop.find({
    ...(targetShop ? { shop: targetShop } : {}),
    ...buildShopifyCredentialCandidateQuery(),
  }).lean();
  dbg("[poll_cod_orders] shops found", shops.length);
  for (const shopRecord of shops) {
    const shop = shopRecord.shop;

    const blockedAt = shopRecord?.diagnostics?.orderAccessBlockedAt
      ? new Date(shopRecord.diagnostics.orderAccessBlockedAt).getTime()
      : null;
    const blocked = Boolean(shopRecord?.diagnostics?.orderAccessBlocked);
    const withinBlockTtl =
      blocked &&
      blockedAt &&
      Number.isFinite(ORDER_ACCESS_BLOCK_TTL_HOURS) &&
      ORDER_ACCESS_BLOCK_TTL_HOURS > 0 &&
      Date.now() - blockedAt < ORDER_ACCESS_BLOCK_TTL_HOURS * 60 * 60 * 1000;
    if (withinBlockTtl) {
      continue;
    }
    dbg("Continue1");

    try {
      // Free feature: allow merchants to pause confirmations.
      if (shopRecord?.settings?.enableWhatsApp === false) {
        continue;
      }
      dbg("Continue2");
      // Don't schedule anything for inactive shops (trial ended / not paid).
      // This reduces background load and avoids building up a retry backlog.
      const billing = await getBillingStatus(shop);
      if (!billing.active) {
        continue;
      }
      const orderConfirmationStartAt = getOrderConfirmationStartAt({
        shopRecord,
        billing,
      });
      const queueSenderIdentity = resolveQueueSenderIdentity({
        shop,
        shopRecord,
        billing,
      });
      dbg("Continue3");
      const settings = shopRecord?.settings || {};
      const normalizeTag = (t) =>
        String(t || "")
          .trim()
          .toLowerCase();
      const skipTags = new Set(
        (settings.skipOrderTags || []).map(normalizeTag).filter(Boolean),
      );

      const includeCountries = new Set(
        (settings.includeCountries || [])
          .map((c) =>
            String(c || "")
              .trim()
              .toUpperCase(),
          )
          .filter(Boolean),
      );
      const excludeCountries = new Set(
        (settings.excludeCountries || [])
          .map((c) =>
            String(c || "")
              .trim()
              .toUpperCase(),
          )
          .filter(Boolean),
      );

      const blocked = await BlockedContact.find({ shop })
        .select({ phoneE164: 1 })
        .lean();

      const blockedSet = new Set(blocked.map((x) => String(x.phoneE164)));
      const orderPollingScope = normalizeOrderPollingScope(
        shopRecord?.settings?.orderPollingScope,
      );
      const hasExistingPreDispatchAttempt = !!(await CodAttempt.exists({
        shop,
        stage: "pre_dispatch",
      }).catch(() => null));

      const admin = await getAdminClient(shop, {
        accessToken: shopRecord.accessToken || "",
        record: shopRecord,
      });

      const res = await admin.query({
        data: `#graphql
          query GetRecentOrders($q: String!) {
            orders(first: 50, sortKey: CREATED_AT, reverse: true, query: $q) {
              edges {
                node {
                  id
                  name
                  email
                  tags
                  paymentGatewayNames
                  displayFulfillmentStatus
                  createdAt
                  currentTotalPriceSet { shopMoney { amount currencyCode } }
                  customer { phone email displayName firstName lastName }
                  shippingAddress {
                    phone
                    countryCode
                    name
                    firstName
                    lastName
                    address1
                    address2
                    city
                    province
                    zip
                    country
                  }
                  billingAddress {
                    phone
                    countryCode
                    name
                    firstName
                    lastName
                    address1
                    address2
                    city
                    province
                    zip
                    country
                  }
                  lineItems(first: 50) {
                    edges {
                      node {
                        title
                        variantTitle
                        quantity
                      }
                    }
                  }
                }
              }
            }
          }
        `,
        variables: { q: buildOrderSearchQuery() },
      });

      const orders = res?.body?.data?.orders?.edges?.map((e) => e.node) || [];
      dbg("[poll_cod_orders] orders found", shop, orders.length);

      // If order polling works again, clear the "blocked" diagnostic flag.
      if (shopRecord?.diagnostics?.orderAccessBlocked) {
        await Shop.updateOne(
          { shop },
          {
            $set: {
              "diagnostics.orderAccessBlocked": false,
              "diagnostics.orderAccessBlockedAt": null,
              "diagnostics.orderAccessError": null,
              "diagnostics.orderAccessErrorAt": null,
            },
          },
        ).catch(() => null);
      }

      const candidateRows = [];
      const candidateOrderKeys = new Set();

      for (const order of orders) {
        const tags = order.tags || [];
        const gateways = order.paymentGatewayNames || [];
        if (orderPollingScope === "cod_only" && !isCODFromGateways(gateways)) {
          continue;
        }

        const isDeliveryFailed = tags.includes("delivery_failed");
        const stage = isDeliveryFailed
          ? "post_failed_delivery"
          : "pre_dispatch";
        const timezone =
          shopRecord.settings?.timezone ||
          resolveTimezoneFromCountry(
            order.shippingAddress?.countryCode ||
              order.billingAddress?.countryCode ||
              null,
          ) ||
          "UTC";

        if (stage === "pre_dispatch" && isPreDispatchFulfillmentBlocked(order)) {
          continue;
        }

        const orderCreatedAt = toValidDate(order?.createdAt);
        if (
          stage === "pre_dispatch" &&
          orderConfirmationStartAt &&
          (!orderCreatedAt ||
            orderCreatedAt.getTime() < orderConfirmationStartAt.getTime())
        ) {
          continue;
        }

        if (
          stage === "pre_dispatch" &&
          !hasExistingPreDispatchAttempt &&
          order?.createdAt &&
          !isSameLocalDay(order.createdAt, new Date(), timezone)
        ) {
          continue;
        }

        // Skip resolved (stage-aware)
        if (
          hasExactTag(tags, ORDER_CANCELLED_TAG) ||
          hasExactTag(tags, "cod_cancelled")
        )
          continue;
        if (
          stage === "pre_dispatch" &&
          (hasExactTag(tags, ORDER_CONFIRMED_TAG) ||
            hasExactTag(tags, "order_confirmed✅"))
        )
          continue;
        if (
          stage === "post_failed_delivery" &&
          tags.includes("cod_redeliver")
        ) {
          continue;
        }

        const { rawPhone, countryCode } = extractPhoneAndCountry(order);
        dbg("PHONERaw", rawPhone);
        if (!rawPhone) continue;
        const phoneE164 = normalizePhoneE164(rawPhone, countryCode);
        dbg("PHONE", phoneE164);
        if (!phoneE164) continue;
        if (blockedSet.has(phoneE164)) continue;
        dbg("isBlocked?", blockedSet.has(phoneE164));
        // Country allow/deny list (free feature)
        const cc = countryCode ? String(countryCode).toUpperCase() : "";
        dbg("cc block");
        if (cc && excludeCountries.has(cc)) continue;
        dbg("cc block continue", cc);
        if (includeCountries.size > 0 && (!cc || !includeCountries.has(cc))) {
          continue;
        }
        dbg(includeCountries.size > 0 && (!cc || !includeCountries.has(cc)));
        // Skip orders with merchant-defined tags (free feature)
        if (skipTags.size > 0) {
          const normalizedTags = (tags || []).map(normalizeTag);
          const hit = normalizedTags.find((t) => skipTags.has(t));
          if (hit) continue;
        }
        dbg("COntinue4");

        const delayMin =
          stage === "post_failed_delivery"
            ? 15
            : Number(shopRecord.settings?.confirmationDelayMin ?? 60);

        const startHour = Number(shopRecord.settings?.workStartHour ?? 9);
        const endHour = Number(shopRecord.settings?.workEndHour ?? 21);
        const baseSchedule = nextAllowedTimeUTC(
          timezone,
          delayMin,
          startHour,
          endHour,
        );
        const scheduledAt = addSeconds(
          baseSchedule,
          jitterSecondsFromSeed(
            `${shop}|${order.id}`,
            delayMin <= 0 ? 3 : 25,
          ),
        );
        dbg("[poll_cod_orders] schedule", {
          shop,
          orderName: order?.name,
          stage,
          timezone,
          delayMin,
          window: `${startHour}-${endHour}`,
          scheduledAt: scheduledAt?.toISOString?.() || String(scheduledAt),
        });

        // ✅ Extra guard even if unique index isn't applied yet
        const orderLookupQuery = buildSameOrderLookupQuery({
          shop,
          stage,
          orderGid: order.id,
          orderName: order.name,
        });
        const exists = orderLookupQuery
          ? await CodAttempt.findOne(orderLookupQuery).lean()
          : null;
        dbg("EXISTS", exists);
        if (exists) continue;

        const sameOrderKey = buildSameOrderKey({
          orderGid: order.id,
          orderName: order.name,
        });
        if (sameOrderKey && candidateOrderKeys.has(sameOrderKey)) {
          dbg("[poll_cod_orders] skipped_duplicate_candidate_order", {
            shop,
            orderName: order?.name,
            orderGid: order?.id,
            sameOrderKey,
          });
          continue;
        }
        if (sameOrderKey) candidateOrderKeys.add(sameOrderKey);

        const customerName = pickCustomerName(order) || null;
        const customerEmail =
          String(order?.email || order?.customer?.email || "").trim() || null;

        const orderAmount = Number(
          order?.currentTotalPriceSet?.shopMoney?.amount || 0,
        );
        const orderCurrency =
          String(
            order?.currentTotalPriceSet?.shopMoney?.currencyCode || "",
          ).trim() || null;

        candidateRows.push({
          order,
          orderGid: order.id,
          orderName: order.name,
          sameOrderKey,
          orderCreatedAt: order?.createdAt
            ? new Date(order.createdAt)
            : new Date(),
          orderAmount:
            Number.isFinite(orderAmount) && orderAmount > 0
              ? orderAmount
              : null,
          orderCurrency,
          customerName,
          phoneE164,
          countryCode,
          timezone,
          stage,
          scheduledAt,
          duplicateFingerprint:
            stage === "pre_dispatch"
              ? buildDuplicateFingerprint(
                  order,
                  customerName,
                  phoneE164,
                  customerEmail,
                )
              : null,
          duplicateGroupId: null,
          duplicateRole: "none",
          phoneQueueGroupId: null,
          phoneQueueRole: "none",
        });
      }

      const duplicateFingerprints = Array.from(
        new Set(
          candidateRows.map((row) => row.duplicateFingerprint).filter(Boolean),
        ),
      );

      const recentDuplicateCutoff =
        Number.isFinite(DUPLICATE_WINDOW_HOURS) && DUPLICATE_WINDOW_HOURS > 0
          ? new Date(Date.now() - DUPLICATE_WINDOW_HOURS * 60 * 60 * 1000)
          : null;

      const existingOpenDuplicates = duplicateFingerprints.length
        ? await CodAttempt.find({
            shop,
            stage: "pre_dispatch",
            duplicateFingerprint: { $in: duplicateFingerprints },
            status: {
              $nin: ["confirmed", "cancelled", "expired", "failed", "skipped"],
            },
          })
            .sort({ createdAt: 1 })
            .lean()
        : [];

      const existingResolvedDuplicates =
        duplicateFingerprints.length && recentDuplicateCutoff
          ? await CodAttempt.find({
              shop,
              stage: "pre_dispatch",
              duplicateFingerprint: { $in: duplicateFingerprints },
              status: { $in: ["confirmed", "cancelled", "expired"] },
              createdAt: { $gte: recentDuplicateCutoff },
            })
              .sort({ createdAt: -1 })
              .lean()
          : [];

      const newByFingerprint = new Map();
      for (const row of candidateRows) {
        if (!row.duplicateFingerprint) continue;
        if (!newByFingerprint.has(row.duplicateFingerprint)) {
          newByFingerprint.set(row.duplicateFingerprint, []);
        }
        newByFingerprint.get(row.duplicateFingerprint).push(row);
      }

      const existingByFingerprint = new Map();
      for (const existing of existingOpenDuplicates) {
        const fp = String(existing.duplicateFingerprint || "").trim();
        if (!fp || existingByFingerprint.has(fp)) continue;
        const currentRows = newByFingerprint.get(fp) || [];
        if (currentRows.some((row) => isSameOrderIdentity(existing, row))) {
          continue;
        }
        existingByFingerprint.set(fp, existing);
      }

      const resolvedByFingerprint = new Map();
      for (const existing of existingResolvedDuplicates) {
        const fp = String(existing.duplicateFingerprint || "").trim();
        if (!fp || resolvedByFingerprint.has(fp)) continue;
        const currentRows = newByFingerprint.get(fp) || [];
        if (currentRows.some((row) => isSameOrderIdentity(existing, row))) {
          continue;
        }
        resolvedByFingerprint.set(fp, existing);
      }

      for (const [fingerprint, rows] of newByFingerprint.entries()) {
        rows.sort(
          (a, b) => a.orderCreatedAt.getTime() - b.orderCreatedAt.getTime(),
        );

        const existingPrimary = existingByFingerprint.get(fingerprint);
        if (existingPrimary) {
          const groupId =
            existingPrimary.duplicateGroupId ||
            buildDuplicateGroupId(
              shop,
              existingPrimary.orderGid || existingPrimary._id?.toString(),
            );
          dbg("[duplicates_existing_primary]", {
            shop,
            groupId,
            count: rows.length,
            primaryOrder: existingPrimary.orderName || existingPrimary.orderGid,
          });

          if (
            existingPrimary.duplicateGroupId !== groupId ||
            existingPrimary.duplicateRole !== "primary"
          ) {
            await CodAttempt.updateOne(
              { _id: existingPrimary._id },
              {
                $set: {
                  duplicateGroupId: groupId,
                  duplicateRole: "primary",
                  duplicateFingerprint: fingerprint,
                },
              },
            ).catch(() => null);
          }

          // Safety: if the primary exists but was never scheduled (older data),
          // ensure it can still be sent.
          if (
            existingPrimary.status === "scheduled" &&
            !existingPrimary.scheduledAt &&
            !existingPrimary.waSentAt
          ) {
            const releaseAt = new Date();
            await CodAttempt.updateOne(
              { _id: existingPrimary._id },
              {
                $set: {
                  status: "scheduled",
                  scheduledAt: releaseAt,
                  lastError: null,
                  lastErrorAt: null,
                  lastErrorMeta: null,
                },
              },
            ).catch(() => null);

            await agenda
              .schedule(releaseAt, "attempt_cod_confirmation", {
                attemptId: existingPrimary._id.toString(),
              })
              .catch(() => null);
          }

          await safeTagOrder(admin, shop, existingPrimary.orderGid, [
            DUPLICATE_DETECTED_TAG,
            PRIMARY_ORDER_TAG,
          ]);

          for (const row of rows) {
            row.duplicateGroupId = groupId;
            row.duplicateRole = "queued";
          }
          continue;
        }

        const existingResolved = resolvedByFingerprint.get(fingerprint);
        if (existingResolved) {
          const groupId =
            existingResolved.duplicateGroupId ||
            buildDuplicateGroupId(
              shop,
              existingResolved.orderGid || existingResolved._id?.toString(),
            );
          dbg("[duplicates_recent_resolved]", {
            shop,
            groupId,
            count: rows.length,
            primaryOrder:
              existingResolved.orderName || existingResolved.orderGid,
          });

          if (
            existingResolved.duplicateGroupId !== groupId ||
            existingResolved.duplicateRole !== "primary"
          ) {
            await CodAttempt.updateOne(
              { _id: existingResolved._id },
              {
                $set: {
                  duplicateGroupId: groupId,
                  duplicateRole: "primary",
                  duplicateFingerprint: fingerprint,
                },
              },
            ).catch(() => null);
          }

          for (let i = 0; i < rows.length; i += 1) {
            rows[i].duplicateGroupId = groupId;
            rows[i].duplicateRole = i === 0 ? "primary" : "queued";
            rows[i].duplicateNotifyOnSend = true;
            rows[i].duplicateReferenceAttemptId = existingResolved._id;
          }
          continue;
        }

        if (rows.length <= 1) continue;

        const groupId = buildDuplicateGroupId(shop, rows[0].orderGid);
        dbg("[duplicates_new_group]", {
          shop,
          groupId,
          count: rows.length,
          primaryOrder: rows[0]?.orderName || rows[0]?.orderGid,
        });
        for (let i = 0; i < rows.length; i += 1) {
          rows[i].duplicateGroupId = groupId;
          rows[i].duplicateRole = i === 0 ? "primary" : "queued";
        }
      }

      // Enforce sequential sending per phone (different orders).
      const phoneList = Array.from(
        new Set(candidateRows.map((row) => row.phoneE164).filter(Boolean)),
      );
      const activeAttempts = phoneList.length
        ? await CodAttempt.find({
            shop,
            phoneE164: { $in: phoneList },
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
            .lean()
        : [];

      const activeByPhone = new Map();
      for (const attempt of activeAttempts) {
        const phone = String(attempt?.phoneE164 || "").trim();
        if (!phone) continue;
        const key = `${phone}|${queueSenderIdentity.senderQueueKey}`;
        if (activeByPhone.has(key)) continue;
        activeByPhone.set(key, attempt);
      }

      const phoneQueueState = new Map();
      for (const [key, attempt] of activeByPhone.entries()) {
        const phone = String(attempt?.phoneE164 || "").trim();
        if (!phone) continue;
        const groupId =
          attempt.phoneQueueGroupId ||
          buildPhoneQueueGroupId(
            shop,
            normalizePhoneDigits(phone),
            queueSenderIdentity.senderQueueKey,
          );
        phoneQueueState.set(key, { groupId, hasPrimary: true });
        if (
          attempt.phoneQueueGroupId !== groupId ||
          attempt.phoneQueueRole !== "primary" ||
          String(attempt.senderQueueKey || "").trim() !==
            queueSenderIdentity.senderQueueKey
        ) {
          await CodAttempt.updateOne(
            { _id: attempt._id },
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
      }

      candidateRows.sort(
        (a, b) => a.orderCreatedAt.getTime() - b.orderCreatedAt.getTime(),
      );

      for (const row of candidateRows) {
        if (row.phoneE164) {
          const queueKey = `${row.phoneE164}|${queueSenderIdentity.senderQueueKey}`;
          const existingActiveAttempt = activeByPhone.get(queueKey);
          if (existingActiveAttempt && isSameOrderIdentity(existingActiveAttempt, row)) {
            dbg("[poll_cod_orders] skipped_same_order_active_attempt", {
              shop,
              orderName: row.orderName,
              orderGid: row.orderGid,
              activeAttemptId:
                existingActiveAttempt?._id?.toString?.() ||
                String(existingActiveAttempt?._id || ""),
            });
            continue;
          }

          let state = phoneQueueState.get(queueKey);
          if (!state) {
            state = {
              groupId: buildPhoneQueueGroupId(
                shop,
                normalizePhoneDigits(row.phoneE164),
                queueSenderIdentity.senderQueueKey,
              ),
              hasPrimary: false,
            };
            phoneQueueState.set(queueKey, state);
          }
          if (state.hasPrimary) {
            row.phoneQueueGroupId = state.groupId;
            row.phoneQueueRole = "queued";
          } else {
            row.phoneQueueGroupId = state.groupId;
            row.phoneQueueRole = "primary";
            state.hasPrimary = true;
          }
        }

        const isDuplicate = row.duplicateRole !== "none";
        const isQueuedDuplicate = row.duplicateRole === "queued";
        const isQueuedPhone = row.phoneQueueRole === "queued";
        const isQueued = isQueuedDuplicate || isQueuedPhone;

        let attempt;
        try {
          attempt = await CodAttempt.create({
            shop,
            orderGid: row.orderGid,
            orderName: row.orderName,
            orderAmount: row.orderAmount,
            orderCurrency: row.orderCurrency,
            customerName: row.customerName,
            phoneE164: row.phoneE164,
            countryCode: row.countryCode,
            timezone: row.timezone,
            stage: row.stage,
            duplicateGroupId: row.duplicateGroupId,
            duplicateRole: row.duplicateRole,
            duplicateFingerprint: row.duplicateFingerprint,
            duplicateQueuedAt: isQueuedDuplicate ? new Date() : null,
            duplicateNotifyOnSend: row.duplicateNotifyOnSend || false,
            duplicateReferenceAttemptId:
              row.duplicateReferenceAttemptId || null,
            phoneQueueGroupId: row.phoneQueueGroupId,
            phoneQueueRole: row.phoneQueueRole,
            phoneQueuedAt: isQueuedPhone ? new Date() : null,
            senderMode: queueSenderIdentity.senderMode,
            senderPhoneNumberId:
              queueSenderIdentity.senderPhoneNumberId || null,
            senderQueueKey: queueSenderIdentity.senderQueueKey,
            status: "scheduled",
            scheduledAt: isQueued ? null : row.scheduledAt,
            lastError: isQueuedDuplicate
              ? "duplicate_queued"
              : isQueuedPhone
                ? "phone_queued"
                : null,
            lastErrorAt: isQueued ? new Date() : null,
          });
        } catch (createError) {
          if (isDuplicateAttemptCreateError(createError)) {
            dbg("[poll_cod_orders] duplicate_attempt_create_skipped", {
              shop,
              orderName: row.orderName,
              orderGid: row.orderGid,
              stage: row.stage,
            });
            continue;
          }
          throw createError;
        }
        await attempt.save();

        if (isDuplicate) {
          const roleTag =
            row.duplicateRole === "primary"
              ? PRIMARY_ORDER_TAG
              : DUPLICATE_QUEUED_TAG;
          await safeTagOrder(admin, shop, row.orderGid, [
            DUPLICATE_DETECTED_TAG,
            roleTag,
          ]);
        }

        dbg("[poll_cod_orders] attempt created", shop, attempt.orderName);
        dbg("[poll_cod_orders] attempt_meta", {
          shop,
          orderName: attempt.orderName,
          stage: attempt.stage,
          duplicateRole: attempt.duplicateRole,
          duplicateGroupId: attempt.duplicateGroupId,
          scheduledAt: attempt.scheduledAt
            ? new Date(attempt.scheduledAt).toISOString()
            : null,
        });

        if (!isQueued) {
          await agenda.schedule(row.scheduledAt, "attempt_cod_confirmation", {
            attemptId: attempt._id.toString(),
          });
        } else {
          dbg("[poll_cod_orders] queued_duplicate", {
            shop,
            orderName: attempt.orderName,
            duplicateGroupId: attempt.duplicateGroupId,
          });
        }
      }
    } catch (err) {
      const msg = String(err?.message || err);
      if (isProtectedCustomerDataBlock(err)) {
        const now = new Date();
        await Shop.updateOne(
          { shop },
          {
            $set: {
              "diagnostics.orderAccessBlocked": true,
              "diagnostics.orderAccessBlockedAt": now,
              "diagnostics.orderAccessError": msg,
              "diagnostics.orderAccessErrorAt": now,
            },
          },
        ).catch(() => null);

        console.error(
          "[poll_cod_orders]",
          shop,
          "Shopify blocked Orders access (Protected Customer Data approval required).",
        );
        continue;
      }

      console.error("[poll_cod_orders]", shop, msg);
    }
  }
});
