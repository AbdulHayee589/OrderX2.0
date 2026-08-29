import express from "express";
import fetch from "node-fetch";

import Shop from "../models/Shop.js";
import { requireBilling } from "../middleware/requireBilling.js";
import { getAdminClient, fetchOrderForCodConfirmTemplate } from "../services/shopifyAdmin.js";
import { normalizePhoneE164 } from "../services/phone.js";
import { canSendWhatsApp, incrementWhatsAppUsage } from "../services/usage.js";
import { getPlan, SENDER_MODES } from "../services/plans.js";
import {
  buildTemplateContext,
  ensureManagedTemplateCatalog,
  isTemplateApproved,
  listTemplateVariableDefinitions,
  mergeManagedTemplateStatusesWithMeta,
  serializeTemplateForClient,
  syncCampaignLibraryTemplatesWithMeta,
  upsertCorePackTemplatesIntoCatalog,
} from "../services/templateCatalog.js";
import {
  isMetaAccessTokenExpired,
  maybeRefreshByonAccessToken,
} from "../services/metaByonAuth.js";
import { sendManagedTemplateDirect } from "../services/whatsapp.js";
import {
  createCampaignRun,
  failCampaignRun,
  getOrderDependentTemplateVariables,
  listCampaignRuns,
  queueImmediateCampaignRun,
  queueScheduledCampaignRun,
  resolveCampaignSendTemplateFromShopRecord,
  retryCampaignRecipient,
  syncCampaignTemplateCatalogForSend,
  testSendPassed,
} from "../services/campaignRuns.js";

const router = express.Router();
const configuredCampaignRecipientLimit = Number(
  process.env.MAX_CAMPAIGN_RECIPIENTS_PER_RUN || 250,
);
const MAX_CAMPAIGN_RECIPIENTS_PER_RUN = Number.isFinite(
  configuredCampaignRecipientLimit,
)
  ? Math.max(1, Math.floor(configuredCampaignRecipientLimit))
  : 250;
const configuredMetaTemplateTimeoutMs = Number(
  process.env.META_TEMPLATE_SYNC_TIMEOUT_MS || 12_000,
);
const META_TEMPLATE_SYNC_TIMEOUT_MS = Number.isFinite(
  configuredMetaTemplateTimeoutMs,
)
  ? Math.max(3_000, Math.floor(configuredMetaTemplateTimeoutMs))
  : 12_000;
const CUSTOM_RECIPIENT_SAFE_VARIABLES = new Set([
  "store_name",
  "support_whatsapp_number",
]);

function getMetaGraphVersion() {
  return String(process.env.META_GRAPH_VERSION || "v25.0").trim() || "v25.0";
}

function isCampaignManagementAllowed(record, billing = null) {
  const senderMode = String(
    billing?.plan?.senderMode ||
      getPlan(record?.billing?.planKey)?.senderMode ||
      "",
  ).trim();
  return senderMode === SENDER_MODES.OWN_NUMBER;
}

async function resolveOwnTokenState({ shop, own = {} }) {
  let accessToken = String(own?.accessToken || "").trim();
  let accessTokenExpiresAt = own?.accessTokenExpiresAt || null;

  if (accessToken) {
    try {
      const refreshed = await maybeRefreshByonAccessToken({
        shop,
        ownNumber: own,
        force: false,
      });
      if (refreshed?.ok && refreshed.accessToken) {
        accessToken = String(refreshed.accessToken || "").trim() || accessToken;
        accessTokenExpiresAt =
          refreshed.accessTokenExpiresAt || accessTokenExpiresAt;
      }
    } catch {
      // Keep the stored token as fallback.
    }
  }

  return {
    accessToken,
    accessTokenExpiresAt,
    expired: isMetaAccessTokenExpired(accessTokenExpiresAt),
  };
}

async function fetchAllMetaTemplates({ wabaId, accessToken }) {
  const firstUrl = new URL(
    `https://graph.facebook.com/${getMetaGraphVersion()}/${wabaId}/message_templates`,
  );
  firstUrl.searchParams.set(
    "fields",
    [
      "id",
      "name",
      "status",
      "language",
      "category",
      "components",
      "rejected_reason",
      "rejection_reason",
      "quality_score",
      "last_updated_time",
    ].join(","),
  );
  firstUrl.searchParams.set("limit", "200");

  const rows = [];
  let nextUrl = firstUrl.toString();
  let pageCount = 0;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    META_TEMPLATE_SYNC_TIMEOUT_MS,
  );

  try {
    while (nextUrl && pageCount < 20) {
      pageCount += 1;
      const res = await fetch(nextUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const error = new Error(
          data?.error?.message || "Failed to fetch Meta templates",
        );
        error.meta = data;
        error.httpStatus = res.status;
        throw error;
      }
      rows.push(...(Array.isArray(data?.data) ? data.data : []));
      nextUrl = String(data?.paging?.next || "").trim();
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Meta template refresh timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  return rows;
}

function buildCampaignTemplateCatalog(own = {}) {
  const managedTemplates = upsertCorePackTemplatesIntoCatalog(
    own?.managedTemplates,
    own?.templates,
  );
  const campaignLibraryTemplates = ensureManagedTemplateCatalog(
    own?.campaignLibraryTemplates,
  ).filter((row) => String(row?.source || "").trim() === "meta_library");

  return { managedTemplates, campaignLibraryTemplates };
}

function findCampaignTemplateById(own = {}, templateId = "") {
  const { managedTemplates, campaignLibraryTemplates } =
    buildCampaignTemplateCatalog(own);
  const normalizedId = String(templateId || "").trim();
  const managed = managedTemplates.find(
    (row) => String(row?.id || "") === normalizedId,
  );
  if (managed) {
    return {
      sourceKey: "managedTemplates",
      template: managed,
      templates: managedTemplates,
    };
  }
  const imported = campaignLibraryTemplates.find(
    (row) => String(row?.id || "") === normalizedId,
  );
  if (imported) {
    return {
      sourceKey: "campaignLibraryTemplates",
      template: imported,
      templates: campaignLibraryTemplates,
    };
  }
  return {
    sourceKey: "",
    template: null,
    templates: [],
  };
}

async function persistTemplateArrayForSource({
  shop,
  sourceKey,
  templates,
  tokenState = null,
}) {
  const now = new Date();
  const sourcePath =
    sourceKey === "campaignLibraryTemplates"
      ? "whatsappSender.ownNumber.campaignLibraryTemplates"
      : "whatsappSender.ownNumber.managedTemplates";
  const updatedAtPath =
    sourceKey === "campaignLibraryTemplates"
      ? "whatsappSender.ownNumber.campaignLibraryTemplatesUpdatedAt"
      : "whatsappSender.ownNumber.managedTemplatesUpdatedAt";

  await Shop.updateOne(
    { shop },
    {
      $set: {
        [sourcePath]: ensureManagedTemplateCatalog(templates),
        [updatedAtPath]: now,
        ...(tokenState?.accessTokenExpiresAt
          ? {
              "whatsappSender.ownNumber.accessTokenExpiresAt":
                tokenState.accessTokenExpiresAt,
            }
          : {}),
      },
    },
  );
}

function cleanOrderGids(value) {
  const rows = Array.isArray(value) ? value : [];
  return Array.from(
    new Set(rows.map((row) => String(row || "").trim()).filter(Boolean)),
  );
}

function cleanCustomRecipients(value) {
  const rows = Array.isArray(value) ? value : [];
  return Array.from(
    new Set(
      rows
        .map((row) => normalizePhoneE164(row))
        .filter(Boolean),
    ),
  );
}

function parseScheduledFor(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed;
}

function formatAmount(amount, currency) {
  const n = Number(amount);
  const c = String(currency || "").trim();
  if (!Number.isFinite(n) || !c) return "";
  return `${c} ${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function formatProducts(order) {
  const edges = Array.isArray(order?.lineItems?.edges)
    ? order.lineItems.edges
    : [];
  const items = edges
    .map((edge) => edge?.node)
    .filter(Boolean)
    .map((line) => {
      const title = String(line?.title || "").trim();
      const variant = String(line?.variantTitle || "").trim();
      const qty = Number(line?.quantity || 0);
      if (!title || !Number.isFinite(qty) || qty <= 0) return "";
      const variantLabel =
        variant && variant.toLowerCase() !== "default title"
          ? ` (${variant})`
          : "";
      return `${Math.trunc(qty)}x ${title}${variantLabel}`;
    })
    .filter(Boolean);
  return items.slice(0, 12).join(", ");
}

function firstProductName(order) {
  const line = order?.lineItems?.edges?.[0]?.node || null;
  return String(line?.title || "").trim();
}

function firstProductImageUrl(order) {
  const edges = Array.isArray(order?.lineItems?.edges)
    ? order.lineItems.edges
    : [];
  for (const edge of edges) {
    const line = edge?.node || {};
    const candidates = [
      line?.image?.url,
      line?.variant?.image?.url,
      line?.variant?.product?.featuredImage?.url,
      line?.variant?.product?.featuredMedia?.preview?.image?.url,
      line?.variant?.product?.images?.edges?.[0]?.node?.url,
      line?.product?.featuredImage?.url,
      line?.product?.featuredMedia?.preview?.image?.url,
      line?.product?.images?.edges?.[0]?.node?.url,
    ];
    const hit = candidates
      .map((candidate) => String(candidate || "").trim())
      .find((candidate) => /^https:\/\//i.test(candidate));
    if (hit) return hit;
  }
  return "";
}

function firstProductUrl(order, shopUrl = "") {
  const edges = Array.isArray(order?.lineItems?.edges)
    ? order.lineItems.edges
    : [];
  const normalizedShopUrl = String(shopUrl || "").replace(/\/+$/, "");
  for (const edge of edges) {
    const line = edge?.node || {};
    const direct = [
      line?.product?.onlineStoreUrl,
      line?.variant?.product?.onlineStoreUrl,
    ]
      .map((candidate) => String(candidate || "").trim())
      .find((candidate) => /^https?:\/\//i.test(candidate));
    if (direct) return direct;
    const handle = String(
      line?.product?.handle || line?.variant?.product?.handle || "",
    ).trim();
    if (handle && /^https?:\/\//i.test(normalizedShopUrl)) {
      return `${normalizedShopUrl}/products/${encodeURIComponent(handle)}`;
    }
  }
  return "";
}

function formatDeliveryAddress(address) {
  if (!address) return "";
  return [
    address.address1,
    address.address2,
    address.city,
    address.province,
    address.zip,
    address.country,
  ]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(", ");
}

function resolveCustomerName(order) {
  const customer = order?.customer || {};
  const shipping = order?.shippingAddress || {};
  const billing = order?.billingAddress || {};
  return (
    String(customer?.displayName || "").trim() ||
    [customer?.firstName, customer?.lastName].filter(Boolean).join(" ").trim() ||
    [shipping?.firstName, shipping?.lastName].filter(Boolean).join(" ").trim() ||
    String(shipping?.name || billing?.name || "Customer").trim() ||
    "Customer"
  );
}

function resolveOrderPhone(order) {
  const shipping = order?.shippingAddress || {};
  const billing = order?.billingAddress || {};
  const customer = order?.customer || {};
  const rawPhone =
    String(shipping?.phone || "").trim() ||
    String(billing?.phone || "").trim() ||
    String(customer?.phone || "").trim();
  const countryCode =
    String(shipping?.countryCode || "").trim() ||
    String(billing?.countryCode || "").trim() ||
    null;
  return normalizePhoneE164(rawPhone, countryCode) || "";
}

function buildOrderTemplateContext({ shop, own, fetched }) {
  const order = fetched?.order || {};
  const money = order?.currentTotalPriceSet?.shopMoney || {};
  const storeName =
    String(fetched?.shopName || "").trim() ||
    String(own?.businessName || "").trim() ||
    String(shop || "").replace(/\.myshopify\.com$/i, "") ||
    "Store";
  const productList = formatProducts(order);
  const productName = firstProductName(order) || productList || "Product";
  const emptyContext = Object.fromEntries(
    listTemplateVariableDefinitions().map((row) => [row.key, ""]),
  );
  return {
    ...emptyContext,
    customer_name: resolveCustomerName(order),
    store_name: storeName,
    order_number: String(order?.name || "").trim(),
    product_name: productName,
    product_list: productList || productName,
    total_price: formatAmount(money?.amount, money?.currencyCode),
    delivery_address: formatDeliveryAddress(order?.shippingAddress),
    product_image_url: firstProductImageUrl(order),
    product_url: firstProductUrl(order, fetched?.shopUrl || ""),
    support_whatsapp_number: String(own?.displayPhoneNumber || "").trim(),
  };
}

router.get("/campaigns/templates", requireBilling, async (req, res) => {
  const shop = String(req.query.shop || "").trim();
  try {
    if (!shop) return res.status(400).json({ error: "Missing shop" });
    const record = await Shop.findOne({ shop }).lean();
    if (!record) return res.status(404).json({ error: "Shop not installed" });

    const own = record?.whatsappSender?.ownNumber || {};
    const { campaignLibraryTemplates } = buildCampaignTemplateCatalog(own);

    return res.json({
      ok: true,
      templateManagementAllowed: isCampaignManagementAllowed(record, req.billing),
      templates: campaignLibraryTemplates.map(serializeTemplateForClient),
      updatedAt: own?.campaignLibraryTemplatesUpdatedAt || null,
      sender: {
        status: String(own?.status || "not_started"),
        wabaId: String(own?.wabaId || ""),
        phoneNumberId: String(own?.phoneNumberId || ""),
        displayPhoneNumber: String(own?.displayPhoneNumber || ""),
      },
    });
  } catch (error) {
    return res.status(500).json({
      error: error?.message || "Failed to load campaign templates",
    });
  }
});

router.get("/campaigns/runs", requireBilling, async (req, res) => {
  const shop = String(req.query.shop || "").trim();
  try {
    if (!shop) return res.status(400).json({ error: "Missing shop" });
    const data = await listCampaignRuns(shop);
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({
      error: error?.message || "Failed to load campaign runs",
    });
  }
});

router.post("/campaigns/templates/refresh", requireBilling, async (req, res) => {
  const shop = String(req.query.shop || "").trim();
  try {
    if (!shop) return res.status(400).json({ error: "Missing shop" });
    const record = await Shop.findOne({ shop }).lean();
    if (!record) return res.status(404).json({ error: "Shop not installed" });
    if (!isCampaignManagementAllowed(record, req.billing)) {
      return res.status(409).json({
        error: "Campaign template refresh is available only on Your Own Number plans",
      });
    }

    const own = record?.whatsappSender?.ownNumber || {};
    if (!String(own?.wabaId || "").trim()) {
      return res.status(409).json({
        error: "Connect Meta first before refreshing campaign templates.",
      });
    }

    const tokenState = await resolveOwnTokenState({ shop, own });
    if (!tokenState.accessToken || tokenState.expired) {
      return res.status(409).json({
        error: "Reconnect Meta before refreshing campaign templates.",
      });
    }

    const remoteTemplates = await fetchAllMetaTemplates({
      wabaId: String(own?.wabaId || "").trim(),
      accessToken: tokenState.accessToken,
    });
    const reusableRemoteTemplates = remoteTemplates.filter((row) =>
      ["UTILITY", "MARKETING"].includes(
        String(row?.category || "")
          .trim()
          .toUpperCase(),
      ),
    );
    const managedTemplates = mergeManagedTemplateStatusesWithMeta(
      upsertCorePackTemplatesIntoCatalog(own?.managedTemplates, own?.templates),
      remoteTemplates,
    );
    const campaignLibraryTemplates = syncCampaignLibraryTemplatesWithMeta(
      own?.campaignLibraryTemplates,
      reusableRemoteTemplates,
    );

    const now = new Date();
    await Shop.updateOne(
      { shop },
      {
        $set: {
          "whatsappSender.ownNumber.managedTemplates":
            ensureManagedTemplateCatalog(managedTemplates),
          "whatsappSender.ownNumber.managedTemplatesUpdatedAt": now,
          "whatsappSender.ownNumber.campaignLibraryTemplates":
            ensureManagedTemplateCatalog(campaignLibraryTemplates),
          "whatsappSender.ownNumber.campaignLibraryTemplatesUpdatedAt": now,
          ...(tokenState?.accessTokenExpiresAt
            ? {
                "whatsappSender.ownNumber.accessTokenExpiresAt":
                  tokenState.accessTokenExpiresAt,
              }
            : {}),
        },
      },
    );

    return res.json({
      ok: true,
      importedCount: campaignLibraryTemplates.length,
      remoteCount: remoteTemplates.length,
      reusableRemoteCount: reusableRemoteTemplates.length,
      updatedAt: now,
      templates: campaignLibraryTemplates.map(serializeTemplateForClient),
    });
  } catch (error) {
    return res.status(502).json({
      error: error?.message || "Failed to refresh campaign templates from Meta",
    });
  }
});

router.post("/campaigns/templates/send-test", requireBilling, async (req, res) => {
  const shop = String(req.query.shop || "").trim();
  const templateId = String(req.body?.templateId || "").trim();
  const to = normalizePhoneE164(
    req.body?.to || req.body?.toE164 || req.body?.phone,
  );
  const now = new Date();

  try {
    if (!shop) return res.status(400).json({ error: "Missing shop" });
    if (!templateId) return res.status(400).json({ error: "Missing templateId" });
    if (!to) {
      return res.status(400).json({
        error: "Enter a valid recipient WhatsApp number in E.164 format.",
      });
    }

    const record = await Shop.findOne({ shop }).lean();
    if (!record) return res.status(404).json({ error: "Shop not installed" });
    if (!isCampaignManagementAllowed(record, req.billing)) {
      return res.status(409).json({
        error: "Campaign template tests require a Your Own Number plan",
      });
    }

    const activeRecord = await syncCampaignTemplateCatalogForSend(record).catch(
      () => record,
    );
    const own = activeRecord?.whatsappSender?.ownNumber || {};
    const lookup = findCampaignTemplateById(own, templateId);
    const target = resolveCampaignSendTemplateFromShopRecord(
      activeRecord,
      lookup.template,
    );
    if (!target) return res.status(404).json({ error: "Template not found" });
    if (String(target?.status || "").trim() === "missing") {
      return res.status(409).json({
        error:
          "This template no longer exists in the connected Meta account. Refresh from Meta and choose a live approved template.",
      });
    }
    if (!isTemplateApproved(target)) {
      return res.status(409).json({
        error: "Only approved templates can be sent as live tests.",
      });
    }
    if (
      !String(own?.wabaId || "").trim() ||
      !String(own?.phoneNumberId || "").trim()
    ) {
      return res.status(409).json({
        error: "Connect Your Own Number before sending a campaign template test.",
      });
    }

    const testContext = buildTemplateContext({
      customer_name: "Abdul",
      store_name: String(own?.businessName || "").trim() || "OrderX Store",
      order_number: "#TEST-10321",
      product_name: "Classic T-Shirt",
      product_list: "2x T-shirt, 1x Shoes",
      total_price: "PKR 3,250",
      delivery_address: "123 Main Street, Lahore",
      product_url: "https://example.com/products/classic-t-shirt",
      support_whatsapp_number: String(own?.displayPhoneNumber || "").trim(),
    });
    const result = await sendManagedTemplateDirect({
      to,
      managedTemplate: target,
      context: testContext,
      shop,
      kind: "campaign_template_test_send",
      meta: {
        source: "campaign_template_test_send",
        flowKey: target.flowKey,
        templateId: target.id,
        campaignTemplate: true,
      },
    });

    const waMessageId =
      String(result?.data?.messages?.[0]?.id || "").trim() || null;
    const status =
      String(result?.data?.messages?.[0]?.message_status || "").trim() || "sent";
    const rowIdsToUpdate = new Set(
      [templateId, String(target?.id || "").trim()].filter(Boolean),
    );
    const nextTemplates = lookup.templates.map((row) =>
      rowIdsToUpdate.has(String(row?.id || "").trim())
        ? {
            ...row,
            testMessageTargetPhoneE164: to,
            testMessageOutboundMessageId: waMessageId,
            testMessageSentAt: now,
            testMessageStatus: status,
            testMessageStatusAt: now,
            testMessageLastError: null,
            testMessageLastErrorAt: null,
            updatedAt: now,
          }
        : row,
    );
    await persistTemplateArrayForSource({
      shop,
      sourceKey: lookup.sourceKey,
      templates: nextTemplates,
    });
    await Shop.updateOne(
      { shop },
      {
        $set: {
          "whatsappSender.ownNumber.testMessageTargetPhoneE164": to,
          "whatsappSender.ownNumber.testMessageOutboundMessageId": waMessageId,
          "whatsappSender.ownNumber.testMessageSentAt": now,
          "whatsappSender.ownNumber.testMessageStatus": status,
          "whatsappSender.ownNumber.testMessageStatusAt": now,
          "whatsappSender.ownNumber.testMessageLastError": null,
          "whatsappSender.ownNumber.testMessageLastErrorMeta": null,
          "whatsappSender.ownNumber.testMessageLastErrorAt": null,
        },
      },
    ).catch(() => {});

    return res.json({
      ok: true,
      templateId: target.id,
      sourceKey: lookup.sourceKey,
      waMessageId,
      status,
      sentAt: now,
      template: serializeTemplateForClient({
        ...target,
        testMessageTargetPhoneE164: to,
        testMessageOutboundMessageId: waMessageId,
        testMessageSentAt: now,
        testMessageStatus: status,
        testMessageStatusAt: now,
        testMessageLastError: null,
        testMessageLastErrorAt: null,
        updatedAt: now,
      }),
    });
  } catch (error) {
    return res.status(500).json({
      error: error?.message || "Failed to send campaign template test",
    });
  }
});

router.post("/campaigns/send", requireBilling, async (req, res) => {
  const shop = String(req.query.shop || "").trim();
  try {
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const templateId = String(req.body?.templateId || "").trim();
    const orderGids = cleanOrderGids(req.body?.orderGids);
    const customRecipients = cleanCustomRecipients(req.body?.customRecipients);
    const scheduleMode =
      String(req.body?.scheduleMode || "immediate").trim() === "scheduled"
        ? "scheduled"
        : "immediate";
    const scheduledFor = parseScheduledFor(req.body?.scheduledFor);
    if (!templateId) return res.status(400).json({ error: "Missing templateId" });
    if (!orderGids.length && !customRecipients.length) {
      return res.status(400).json({
        error: "Select at least one order or add one custom number",
      });
    }
    if (
      orderGids.length + customRecipients.length >
      MAX_CAMPAIGN_RECIPIENTS_PER_RUN
    ) {
      return res.status(400).json({
        error: `A campaign can include up to ${MAX_CAMPAIGN_RECIPIENTS_PER_RUN} unique recipients.`,
      });
    }

    const record = await Shop.findOne({ shop }).lean();
    if (!record) {
      return res.status(404).json({ error: "Shop not installed" });
    }
    const activeRecord = await syncCampaignTemplateCatalogForSend(record).catch(
      () => record,
    );
    const plan = getPlan(activeRecord?.billing?.planKey);
    if (String(plan?.senderMode || "").trim() !== SENDER_MODES.OWN_NUMBER) {
      return res.status(409).json({
        error: "Campaign sending requires a Your Own Number plan",
      });
    }

    const own = activeRecord?.whatsappSender?.ownNumber || {};
    const lookup = findCampaignTemplateById(own, templateId);
    const template = resolveCampaignSendTemplateFromShopRecord(
      activeRecord,
      lookup.template,
    );
    if (!template) return res.status(404).json({ error: "Template not found" });
    if (String(template?.status || "").trim() === "missing") {
      return res.status(409).json({
        error:
          "This template no longer exists in the connected Meta account. Refresh from Meta and choose a live approved template.",
      });
    }
    if (!isTemplateApproved(template)) {
      return res.status(409).json({ error: "Only approved templates can be used in campaigns" });
    }
    if (!testSendPassed(template)) {
      return res.status(409).json({ error: "Kindly test send the template first" });
    }
    if (scheduleMode === "scheduled") {
      if (!scheduledFor) {
        return res.status(400).json({ error: "Choose a valid future schedule time" });
      }
      if (scheduledFor.getTime() <= Date.now() + 30_000) {
        return res.status(400).json({
          error: "Choose a schedule time at least 1 minute in the future",
        });
      }
    }

    const orderDependentVariables = getOrderDependentTemplateVariables(template);
    if (customRecipients.length && orderDependentVariables.length) {
      return res.status(409).json({
        error:
          "Custom numbers without orders can only be used when the template does not require order-linked variables.",
        details: {
          orderDependentVariables,
          customRecipients,
        },
      });
    }
    const created = await createCampaignRun({
      shop,
      template,
      orderGids,
      customRecipients,
      scheduleMode,
      scheduledFor,
    });
    const campaignRunId = created.run?._id || created.run?.id;
    try {
      if (scheduleMode === "scheduled" && scheduledFor) {
        await queueScheduledCampaignRun(campaignRunId, scheduledFor);
      } else {
        await queueImmediateCampaignRun(campaignRunId);
      }
    } catch (queueError) {
      await failCampaignRun(campaignRunId, queueError).catch(() => null);
      throw queueError;
    }
    const finalRun = {
      ...created.run,
      recipients: [],
    };

    return res.json({
      ok: true,
      template: serializeTemplateForClient(template),
      summary: {
        selected: Number(finalRun.totalRecipients || 0),
        sent: Number(finalRun.sentCount || 0),
        failed: Number(finalRun.failedCount || 0),
        skipped: Number(finalRun.skippedCount || 0),
        pending: Number(finalRun.pendingCount || 0),
      },
      scheduled: scheduleMode === "scheduled",
      queued: scheduleMode === "immediate",
      run: finalRun,
    });
  } catch (error) {
    return res.status(500).json({
      error: error?.message || "Failed to send campaign",
    });
  }
});

router.post("/campaigns/runs/retry-recipient", requireBilling, async (req, res) => {
  const shop = String(req.query.shop || "").trim();
  try {
    if (!shop) return res.status(400).json({ error: "Missing shop" });
    const runId = String(req.body?.runId || "").trim();
    const recipientId = String(req.body?.recipientId || "").trim();
    if (!runId || !recipientId) {
      return res.status(400).json({ error: "Missing runId or recipientId" });
    }
    const result = await retryCampaignRecipient({ shop, runId, recipientId });
    return res.json({ ok: true, run: result.run });
  } catch (error) {
    return res.status(500).json({
      error: error?.message || "Failed to retry campaign recipient",
    });
  }
});

export default router;
