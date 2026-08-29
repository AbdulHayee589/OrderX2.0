import express from "express";
import fetch from "node-fetch";

import Shop from "../models/Shop.js";
import { logAudit } from "../services/audit.js";
import {
  buildMetaTemplateDefinitionFromManagedTemplate,
  buildTemplateContext,
  defaultTemplateShapeForFlow,
  ensureAutomationFlowConfigs,
  ensureManagedTemplateCatalog,
  FLOW_DEFINITIONS,
  FLOW_KEYS,
  generateMetaTemplateNameForFlow,
  generateTemplateId,
  getFlowDefinition,
  getFlowTemplateCategory,
  isTemplateApproved,
  listFlowDefinitions,
  listTemplateLanguageOptions,
  listTemplateVariableDefinitions,
  mergeManagedTemplateStatusesWithMeta,
  normalizeTemplateStatus,
  resolveAssignedTemplateForFlow,
  serializeTemplateForClient,
  upsertCorePackTemplatesIntoCatalog,
  validateManagedTemplateInput,
} from "../services/templateCatalog.js";
import {
  isMetaAccessTokenExpired,
  maybeRefreshByonAccessToken,
} from "../services/metaByonAuth.js";
import { normalizePhoneE164 } from "../services/phone.js";
import { getPlan, PLAN_KEYS, SENDER_MODES } from "../services/plans.js";
import { sendManagedTemplateDirect } from "../services/whatsapp.js";

const router = express.Router();
const configuredTemplateStatusRefreshTtlMs = Number(
  process.env.TEMPLATE_STATUS_REFRESH_TTL_MS,
);
const TEMPLATE_STATUS_REFRESH_TTL_MS = Number.isFinite(
  configuredTemplateStatusRefreshTtlMs,
)
  ? Math.max(60_000, configuredTemplateStatusRefreshTtlMs)
  : 60 * 60 * 1000;

function truthyFlag(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function getMetaGraphVersion() {
  return String(process.env.META_GRAPH_VERSION || "v25.0").trim() || "v25.0";
}

function summarizeMetaError(errorLike) {
  const meta = errorLike?.meta || {};
  return {
    message:
      meta?.error?.message || errorLike?.message || "Meta template request failed",
    type: meta?.error?.type || null,
    code: meta?.error?.code || null,
    subcode: meta?.error?.error_subcode || null,
    fbtraceId: meta?.error?.fbtrace_id || null,
    details: meta?.error?.error_data?.details || null,
    httpStatus: errorLike?.httpStatus || null,
  };
}

function normalizeTestDestinationPhone(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return "";
  const direct = normalizePhoneE164(raw);
  if (direct) return direct;
  const digits = raw.replace(/[^\d+]/g, "");
  if (!digits) return "";
  if (digits.startsWith("+")) return normalizePhoneE164(digits) || "";
  return normalizePhoneE164(`+${digits}`) || "";
}

const OWN_NUMBER_ONLY_FLOWS = new Set([
  FLOW_KEYS.REVIEW_REQUEST,
  FLOW_KEYS.ABANDONED_CART,
  FLOW_KEYS.CAMPAIGN,
]);

function getBillingSenderMode(record) {
  const planKey = String(record?.billing?.planKey || PLAN_KEYS.ORDERX_FREE_5).trim();
  const plan = getPlan(planKey);
  return String(plan?.senderMode || SENDER_MODES.ORDERX_NUMBER).trim();
}

function isFlowAllowedForRecord(flowKey, record) {
  if (!OWN_NUMBER_ONLY_FLOWS.has(String(flowKey || "").trim())) return true;
  return getBillingSenderMode(record) === SENDER_MODES.OWN_NUMBER;
}

function isTemplateManagementAllowed(record) {
  return getBillingSenderMode(record) === SENDER_MODES.OWN_NUMBER;
}

function assertTemplateManagementAllowed(record) {
  if (isTemplateManagementAllowed(record)) return;
  throw new Error(
    "Custom templates are available only on Your Own Number plans",
  );
}

function assertFlowAllowedForRecord(flowKey, record) {
  if (isFlowAllowedForRecord(flowKey, record)) return;
  throw new Error(
    "This automation is available only on Your Own Number plans",
  );
}

function buildManagedTemplateTestContext({ shop, own }) {
  return buildTemplateContext({
    customer_name: "Abdul",
    store_name:
      String(own?.businessName || "").trim() ||
      String(shop || "").replace(/\.myshopify\.com$/i, "") ||
      "OrderX Store",
    order_number: `#TEST-${String(Date.now()).slice(-6)}`,
    product_name: "Classic T-Shirt",
    product_list: "2x T-shirt, 1x Shoes",
    total_price: "PKR 3,250",
    delivery_address: "123 Main Street, Lahore",
    courier_name: "Leopards",
    tracking_number: "LP123456789",
    tracking_url: "https://track.example/LP123456789",
    cancel_reason: "Customer requested cancellation",
    update_title: "Delivery delayed",
    update_details: "This is a managed template test message from OrderX.",
    support_whatsapp_number: String(own?.displayPhoneNumber || "").trim(),
    review_url: "https://example.com/review/test",
    checkout_url: "https://example.com/checkout/test",
    abandoned_minutes: "90",
    product_image_url: "",
  });
}

function inferMediaFileName(url) {
  const parsed = new URL(url);
  const name = parsed.pathname.split("/").filter(Boolean).pop() || "sample.jpg";
  return name.includes(".") ? name : `${name}.jpg`;
}

async function downloadSampleMedia(mediaUrl) {
  const res = await fetch(mediaUrl, { method: "GET" });
  if (!res.ok) {
    throw new Error(`Failed to download sample image (${res.status})`);
  }
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (!buffer.length) throw new Error("Sample image download returned an empty file");
  return {
    buffer,
    contentType:
      String(res.headers.get("content-type") || "").split(";")[0].trim() ||
      "image/jpeg",
    fileName: inferMediaFileName(mediaUrl),
  };
}

async function uploadTemplateSampleMedia({ accessToken, mediaUrl }) {
  const appId = String(process.env.META_APP_ID || "").trim();
  if (!appId) {
    throw new Error("META_APP_ID is required to upload image-header samples to Meta");
  }
  const media = await downloadSampleMedia(mediaUrl);
  const startUrl = new URL(
    `https://graph.facebook.com/${getMetaGraphVersion()}/${appId}/uploads`,
  );
  startUrl.searchParams.set("file_name", media.fileName);
  startUrl.searchParams.set("file_length", String(media.buffer.length));
  startUrl.searchParams.set("file_type", media.contentType);

  const startRes = await fetch(startUrl.toString(), {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const startData = await startRes.json().catch(() => ({}));
  if (!startRes.ok || !startData?.id) {
    const error = new Error(
      startData?.error?.message || "Failed to start Meta sample media upload",
    );
    error.meta = startData;
    error.httpStatus = startRes.status;
    throw error;
  }

  const uploadRes = await fetch(
    `https://graph.facebook.com/${getMetaGraphVersion()}/${startData.id}`,
    {
      method: "POST",
      headers: {
        Authorization: `OAuth ${accessToken}`,
        file_offset: "0",
        "Content-Type": media.contentType,
      },
      body: media.buffer,
    },
  );
  const uploadData = await uploadRes.json().catch(() => ({}));
  if (!uploadRes.ok || !uploadData?.h) {
    const error = new Error(
      uploadData?.error?.message || "Failed to upload Meta sample media",
    );
    error.meta = uploadData;
    error.httpStatus = uploadRes.status;
    throw error;
  }
  return uploadData.h;
}

async function resolveTemplateSampleMediaHandles({ components, accessToken }) {
  const nextComponents = [];
  for (const component of Array.isArray(components) ? components : []) {
    if (
      String(component?.type || "").toUpperCase() !== "HEADER" ||
      String(component?.format || "").toUpperCase() !== "IMAGE"
    ) {
      nextComponents.push(component);
      continue;
    }

    const handleOrUrl = String(component?.example?.header_handle?.[0] || "").trim();
    if (/^https:\/\//i.test(handleOrUrl)) {
      const handle = await uploadTemplateSampleMedia({
        accessToken,
        mediaUrl: handleOrUrl,
      });
      nextComponents.push({
        ...component,
        example: { header_handle: [handle] },
      });
      continue;
    }
    nextComponents.push(component);
  }
  return nextComponents;
}

async function resolveOwnTokenState({ shop, own }) {
  let accessToken = String(own?.accessToken || "").trim();
  let accessTokenExpiresAt = own?.accessTokenExpiresAt || null;

  if (accessToken) {
    try {
      const refreshed = await maybeRefreshByonAccessToken({
        shop,
        ownNumber: own,
        force: false,
      });
      accessToken = String(refreshed?.token || accessToken).trim();
      accessTokenExpiresAt = refreshed?.expiresAt || accessTokenExpiresAt || null;
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

async function fetchMetaTemplateStatuses({ wabaId, accessToken }) {
  const url = new URL(
    `https://graph.facebook.com/${getMetaGraphVersion()}/${wabaId}/message_templates`,
  );
  url.searchParams.set(
    "fields",
    [
      "id",
      "name",
      "status",
      "language",
      "category",
      "rejected_reason",
      "rejection_reason",
      "quality_score",
      "last_updated_time",
    ].join(","),
  );
  url.searchParams.set("limit", "200");

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data?.error?.message || "Failed to fetch Meta templates");
    error.meta = data;
    error.httpStatus = res.status;
    throw error;
  }
  return Array.isArray(data?.data) ? data.data : [];
}

async function createMetaTemplate({ wabaId, accessToken, definition }) {
  const components = await resolveTemplateSampleMediaHandles({
    components: definition?.components,
    accessToken,
  });
  const payload = {
    name: String(definition?.templateName || "").trim(),
    language: String(definition?.language || "en").trim() || "en",
    category: String(
      definition?.category ||
        getFlowTemplateCategory(definition?.key || definition?.flowKey),
    )
      .trim()
      .toUpperCase(),
    components,
  };

  const res = await fetch(
    `https://graph.facebook.com/${getMetaGraphVersion()}/${wabaId}/message_templates`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data?.error?.message || "Failed to create template");
    error.meta = data;
    error.httpStatus = res.status;
    throw error;
  }
  return data;
}

function buildTemplateSystem(record) {
  const own = record?.whatsappSender?.ownNumber || {};
  const settings = record?.settings || {};
  const billingSenderMode = getBillingSenderMode(record);
  const templates = upsertCorePackTemplatesIntoCatalog(
    own?.managedTemplates,
    own?.templates,
  );
  const flows = ensureAutomationFlowConfigs(record?.settings?.automationFlows);

  const serializedTemplates = templates.map((template) => {
    const flowKey = String(template?.flowKey || "").trim();
    const requiresOwnNumberPlan = OWN_NUMBER_ONLY_FLOWS.has(flowKey);
    const availableForCurrentPlan = isFlowAllowedForRecord(flowKey, record);
    return {
      ...serializeTemplateForClient(template),
      requiresOwnNumberPlan,
      availableForCurrentPlan,
    };
  });
  const serializedFlows = flows.map((flow) => {
    const definition = getFlowDefinition(flow.flowKey);
    const requiresOwnNumberPlan = OWN_NUMBER_ONLY_FLOWS.has(flow.flowKey);
    const availableForCurrentPlan = isFlowAllowedForRecord(flow.flowKey, record);
    const assigned = resolveAssignedTemplateForFlow({
      catalog: templates,
      flows,
      flowKey: flow.flowKey,
    });
    const available = serializedTemplates.filter(
      (row) => row.flowKey === flow.flowKey,
    );
    const ready = availableForCurrentPlan && (!definition?.supportsTemplates
      ? !!flow.enabled
      : !!flow.enabled && !!assigned && isTemplateApproved(assigned));

    const mergedConfig = {
      ...(flow?.config && typeof flow.config === "object" ? flow.config : {}),
    };
    if (flow.flowKey === FLOW_KEYS.REVIEW_REQUEST) {
      if (!mergedConfig.reviewUrl && settings?.reviewRequestUrl) {
        mergedConfig.reviewUrl = settings.reviewRequestUrl;
      }
      if (!mergedConfig.linkMode && settings?.reviewRequestLinkMode) {
        mergedConfig.linkMode = settings.reviewRequestLinkMode;
      }
      if (
        !Number.isFinite(Number(mergedConfig.delayHours)) &&
        Number.isFinite(Number(settings?.reviewRequestDelayHours))
      ) {
        mergedConfig.delayHours = Number(settings.reviewRequestDelayHours);
      }
    }
    if (flow.flowKey === FLOW_KEYS.ABANDONED_CART) {
      if (
        !Number.isFinite(Number(mergedConfig.delayMinutes)) &&
        Number.isFinite(Number(settings?.abandonedCartDelayMinutes))
      ) {
        mergedConfig.delayMinutes = Number(settings.abandonedCartDelayMinutes);
      }
    }

    return {
      flowKey: flow.flowKey,
      label: definition?.label || flow.flowKey,
      description: definition?.description || "",
      supportsTemplates: !!definition?.supportsTemplates,
      enabled: !!flow.enabled,
      availableForCurrentPlan,
      requiresOwnNumberPlan,
      unavailableReason: availableForCurrentPlan
        ? null
        : "Available only on Your Own Number plans.",
      templateId: flow.templateId || null,
      templateKey: flow.templateKey || null,
      config: mergedConfig,
      ready,
      assignedTemplate: assigned ? serializeTemplateForClient(assigned) : null,
      availableTemplates: available,
      fixedButtons: definition?.fixedButtons || [],
      supportedVariables: definition?.supportedVariables || [],
    };
  });

  const ownTemplatesApproved =
    Array.isArray(own?.templates) &&
    own.templates.length > 0 &&
    own.templates.every(
      (row) => String(row?.status || "").trim().toLowerCase() === "approved",
    );

  return {
    sender: {
      status: String(own?.status || "not_started"),
      wabaId: String(own?.wabaId || ""),
      phoneNumberId: String(own?.phoneNumberId || ""),
      displayPhoneNumber: String(own?.displayPhoneNumber || ""),
      testMessageTargetPhoneE164: String(own?.testMessageTargetPhoneE164 || ""),
      templatePackProvisioned: Array.isArray(own?.templates) && own.templates.length > 0,
      templatesApproved: ownTemplatesApproved,
      templatesLastSyncedAt: own?.templatesLastSyncedAt || null,
      managedTemplatesUpdatedAt: own?.managedTemplatesUpdatedAt || null,
      managedTemplatesStatusRefreshedAt:
        own?.managedTemplatesStatusRefreshedAt || null,
    },
    templateManagementAllowed: isTemplateManagementAllowed(record),
    flows: serializedFlows,
    templates: serializedTemplates,
    variables: listTemplateVariableDefinitions(),
    flowDefinitions: listFlowDefinitions().map((flow) => ({
      key: flow.key,
      label: flow.label,
      description: flow.description,
      supportsTemplates: !!flow.supportsTemplates,
      supportsImageHeader: !!flow.supportsImageHeader,
      requiresOwnNumberPlan: OWN_NUMBER_ONLY_FLOWS.has(flow.key),
      availableForCurrentPlan: isFlowAllowedForRecord(flow.key, record),
      templateCategory: getFlowTemplateCategory(flow.key),
      templateNameBase: flow.templateNameBase || flow.defaultMetaTemplateName || "",
      fixedButtons: flow.fixedButtons || [],
      supportedVariables: flow.supportedVariables || [],
      defaultTemplate: flow.defaultTemplate || null,
    })),
    languageOptions: listTemplateLanguageOptions(),
    billingSenderMode,
  };
}

async function persistTemplateSystem({
  shop,
  record,
  templates,
  flows,
  tokenState,
  statusRefreshedAt = null,
}) {
  const now = new Date();
  const nextSettings = {
    ...(record?.settings || {}),
    automationFlows: ensureAutomationFlowConfigs(flows).map((flow) => ({
      ...flow,
      updatedAt: flow?.updatedAt || now,
    })),
  };
  await Shop.updateOne(
    { shop },
    {
      $set: {
        settings: nextSettings,
        "whatsappSender.ownNumber.managedTemplates": ensureManagedTemplateCatalog(
          templates,
        ),
        "whatsappSender.ownNumber.managedTemplatesUpdatedAt": now,
        ...(statusRefreshedAt
          ? {
              "whatsappSender.ownNumber.managedTemplatesStatusRefreshedAt":
                statusRefreshedAt,
            }
          : {}),
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

router.get("/templates", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const refresh = truthyFlag(req.query.refresh);
    const force = truthyFlag(req.query.force);
    const refreshRequested = refresh || force;
    let record = await Shop.findOne({ shop }).lean();
    if (!record) {
      record = { shop, settings: {}, whatsappSender: { ownNumber: {} } };
    }

    const own = record?.whatsappSender?.ownNumber || {};
    let templates = upsertCorePackTemplatesIntoCatalog(
      own?.managedTemplates,
      own?.templates,
    );
    const templateManagementAllowed = isTemplateManagementAllowed(record);
    const lastStatusRefreshAt = own?.managedTemplatesStatusRefreshedAt
      ? new Date(own.managedTemplatesStatusRefreshedAt)
      : null;
    const lastStatusRefreshMs = Number.isFinite(lastStatusRefreshAt?.getTime?.())
      ? lastStatusRefreshAt.getTime()
      : 0;
    const cacheFresh =
      lastStatusRefreshMs > 0 &&
      Date.now() - lastStatusRefreshMs < TEMPLATE_STATUS_REFRESH_TTL_MS;
    const shouldRefreshFromMeta = refreshRequested && (force || !cacheFresh);
    let statusRefresh = {
      requested: refreshRequested,
      refreshed: false,
      cached: refreshRequested && cacheFresh && !force,
      lastRefreshedAt: lastStatusRefreshAt || null,
      nextRefreshAt: lastStatusRefreshMs
        ? new Date(lastStatusRefreshMs + TEMPLATE_STATUS_REFRESH_TTL_MS)
        : null,
      reason: refreshRequested && cacheFresh && !force ? "cache_fresh" : null,
    };

    if (
      shouldRefreshFromMeta &&
      templateManagementAllowed &&
      String(own?.wabaId || "").trim() &&
      String(own?.accessToken || "").trim()
    ) {
      const tokenState = await resolveOwnTokenState({ shop, own });
      if (!tokenState.accessToken || tokenState.expired) {
        if (force) {
          return res.status(409).json({
            error: "Reconnect Meta before refreshing templates.",
            code: "meta_token_missing",
            templateSystem: buildTemplateSystem(record),
          });
        }
        statusRefresh = {
          ...statusRefresh,
          reason: "meta_token_missing",
          error: "Reconnect Meta before refreshing templates.",
        };
      } else {
        try {
          const remote = await fetchMetaTemplateStatuses({
            wabaId: String(own?.wabaId || "").trim(),
            accessToken: tokenState.accessToken,
          });
          templates = mergeManagedTemplateStatusesWithMeta(templates, remote);
          const flows = ensureAutomationFlowConfigs(
            record?.settings?.automationFlows,
          );
          const refreshedAt = new Date();
          await persistTemplateSystem({
            shop,
            record,
            templates,
            flows,
            tokenState,
            statusRefreshedAt: refreshedAt,
          });
          record = await Shop.findOne({ shop }).lean();
          statusRefresh = {
            requested: true,
            refreshed: true,
            cached: false,
            lastRefreshedAt: refreshedAt,
            nextRefreshAt: new Date(
              refreshedAt.getTime() + TEMPLATE_STATUS_REFRESH_TTL_MS,
            ),
            reason: force ? "forced" : "cache_stale",
          };
        } catch (error) {
          if (force) {
            return res.status(502).json({
              error:
                error?.message || "Failed to sync template statuses from Meta",
              metaError: summarizeMetaError(error),
              templateSystem: buildTemplateSystem(record),
              force,
            });
          }
          statusRefresh = {
            ...statusRefresh,
            reason: "meta_refresh_failed_using_cache",
            error:
              error?.message || "Failed to sync template statuses from Meta",
          };
        }
      }
    }

    if (shouldRefreshFromMeta && !templateManagementAllowed) {
      if (force) {
        return res.status(409).json({
          error:
            "Custom template status refresh is available only on Your Own Number plans",
          code: "template_management_not_allowed",
          templateSystem: buildTemplateSystem(record),
        });
      }
      statusRefresh = {
        ...statusRefresh,
        reason: "template_management_not_allowed",
      };
    } else if (
      shouldRefreshFromMeta &&
      templateManagementAllowed &&
      (!String(own?.wabaId || "").trim() ||
        !String(own?.accessToken || "").trim())
    ) {
      if (force) {
        return res.status(409).json({
          error: "Connect Meta before refreshing templates.",
          code: "meta_connection_missing",
          templateSystem: buildTemplateSystem(record),
        });
      }
      statusRefresh = {
        ...statusRefresh,
        reason: "meta_connection_missing",
      };
    }

    return res.json({
      ok: true,
      templateSystem: buildTemplateSystem(record),
      statusRefresh,
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed" });
  }
});

router.post("/templates/save", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const record = await Shop.findOne({ shop }).lean();
    assertTemplateManagementAllowed(record);
    const own = record?.whatsappSender?.ownNumber || {};
    assertFlowAllowedForRecord(req.body?.flowKey, record);
    const templates = upsertCorePackTemplatesIntoCatalog(
      own?.managedTemplates,
      own?.templates,
    );
    const existingId = String(req.body?.templateId || "").trim();
    const existing = templates.find((row) => String(row?.id || "") === existingId) || null;
    const sanitized = validateManagedTemplateInput(req.body, { existing });

    const shouldClone =
      existing && ["approved", "pending", "in_review"].includes(existing.status);
    const baseTemplate = shouldClone
      ? {
          ...existing,
          id: generateTemplateId(),
          source: "cloned_revision",
          originTemplateId: existing.id,
          templateKey:
            existing?.templateKey && existing?.source === "default_pack"
              ? `${existing.templateKey}_custom_${Date.now()}`
              : existing?.templateKey || null,
          metaTemplateName: generateMetaTemplateNameForFlow(
            sanitized.flowKey,
            templates,
          ),
          status: "draft",
          rawStatus: "DRAFT",
          rejectionReason: null,
          lastError: null,
          lastSyncedAt: null,
          lastUpdatedTime: null,
          approvedAt: null,
          submittedAt: null,
          testMessageTargetPhoneE164: "",
          testMessageOutboundMessageId: null,
          testMessageSentAt: null,
          testMessageStatus: null,
          testMessageStatusAt: null,
          testMessageLastError: null,
          testMessageLastErrorAt: null,
          createdAt: new Date(),
        }
      : existing ||
        defaultTemplateShapeForFlow(sanitized.flowKey, {
          id: generateTemplateId(),
          source: existing?.source || "merchant_custom",
          templateKey: `${sanitized.flowKey}_${Date.now()}`,
          metaTemplateName: generateMetaTemplateNameForFlow(
            sanitized.flowKey,
            templates,
          ),
        });

    const nextTemplate = {
      ...baseTemplate,
      ...sanitized,
      source:
        shouldClone || baseTemplate?.source === "merchant_custom"
          ? baseTemplate.source
          : baseTemplate?.source || "merchant_custom",
      updatedAt: new Date(),
    };

    const nextTemplates = ensureManagedTemplateCatalog(
      (shouldClone
        ? templates
        : templates.filter(
            (row) => String(row?.id || "") !== String(existing?.id || ""),
          )
      ).concat(nextTemplate),
    );
    const flows = ensureAutomationFlowConfigs(record?.settings?.automationFlows);
    await persistTemplateSystem({ shop, record, templates: nextTemplates, flows });

    void logAudit({
      shop,
      actor: "merchant",
      action: shouldClone ? "template_revision_created" : "template_saved",
      meta: {
        templateId: nextTemplate.id,
        flowKey: nextTemplate.flowKey,
        metaTemplateName: nextTemplate.metaTemplateName,
        clonedFromTemplateId: shouldClone ? existing?.id || null : null,
      },
    });

    const updated = await Shop.findOne({ shop }).lean();
    return res.json({
      ok: true,
      templateSystem: buildTemplateSystem(updated),
      templateId: nextTemplate.id,
      clonedFromTemplateId: shouldClone ? existing?.id || null : null,
    });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "Failed to save template" });
  }
});

router.post("/templates/delete", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });
    const templateId = String(req.body?.templateId || "").trim();
    if (!templateId) {
      return res.status(400).json({ error: "Missing templateId" });
    }

    const record = await Shop.findOne({ shop }).lean();
    assertTemplateManagementAllowed(record);
    const own = record?.whatsappSender?.ownNumber || {};
    const templates = upsertCorePackTemplatesIntoCatalog(
      own?.managedTemplates,
      own?.templates,
    );
    const target = templates.find((row) => String(row?.id || "") === templateId);
    if (!target) {
      return res.status(404).json({ error: "Template not found" });
    }
    if (target.source === "default_pack") {
      return res.status(409).json({
        error:
          "Default pack templates stay available as the fixed starter set. Create a revision instead of deleting them.",
      });
    }
    if (["approved", "pending", "in_review"].includes(target.status)) {
      return res.status(409).json({
        error:
          "Approved or pending templates cannot be deleted. Create a new revision instead.",
      });
    }

    const nextTemplates = templates.filter((row) => String(row?.id || "") !== templateId);
    const flows = ensureAutomationFlowConfigs(record?.settings?.automationFlows).map((flow) =>
      String(flow?.templateId || "") === templateId
        ? { ...flow, templateId: null, templateKey: null, updatedAt: new Date() }
        : flow,
    );
    await persistTemplateSystem({ shop, record, templates: nextTemplates, flows });

    void logAudit({
      shop,
      actor: "merchant",
      action: "template_deleted",
      meta: {
        templateId,
        flowKey: target.flowKey,
      },
    });

    const updated = await Shop.findOne({ shop }).lean();
    return res.json({ ok: true, templateSystem: buildTemplateSystem(updated) });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to delete template" });
  }
});

router.post("/templates/submit", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });
    const templateId = String(req.body?.templateId || "").trim();
    if (!templateId) {
      return res.status(400).json({ error: "Missing templateId" });
    }

    const record = await Shop.findOne({ shop }).lean();
    assertTemplateManagementAllowed(record);
    const own = record?.whatsappSender?.ownNumber || {};
    if (!String(own?.wabaId || "").trim()) {
      return res.status(409).json({ error: "Connect Meta first before submitting templates." });
    }

    const tokenState = await resolveOwnTokenState({ shop, own });
    if (!tokenState.accessToken || tokenState.expired) {
      return res.status(409).json({ error: "Reconnect Meta before submitting templates." });
    }

    const templates = upsertCorePackTemplatesIntoCatalog(
      own?.managedTemplates,
      own?.templates,
    );
    const target = templates.find((row) => String(row?.id || "") === templateId);
    if (!target) {
      return res.status(404).json({ error: "Template not found" });
    }
    assertFlowAllowedForRecord(target.flowKey, record);
    const currentStatus = normalizeTemplateStatus(
      target?.status || target?.rawStatus || "draft",
    );
    if (["approved", "pending", "in_review"].includes(currentStatus)) {
      return res.status(409).json({
        error:
          "This template is already submitted or approved. Create a revision if you need another Meta review.",
      });
    }

    const definition = buildMetaTemplateDefinitionFromManagedTemplate(target);
    try {
      const createResult = await createMetaTemplate({
        wabaId: String(own?.wabaId || "").trim(),
        accessToken: tokenState.accessToken,
        definition,
      });
      target.metaTemplateId = String(
        createResult?.id ||
          createResult?.message_template_id ||
          createResult?.template_id ||
          "",
      ).trim();
    } catch (error) {
      const nextTemplates = templates.map((row) =>
        String(row?.id || "") === templateId
          ? {
              ...row,
              status: "rejected",
              rawStatus: "ERROR",
              lastError: error?.message || "Failed to submit template",
              rejectionReason: error?.message || null,
              updatedAt: new Date(),
            }
          : row,
      );
      const flows = ensureAutomationFlowConfigs(record?.settings?.automationFlows);
      await persistTemplateSystem({
        shop,
        record,
        templates: nextTemplates,
        flows,
        tokenState,
      });
      return res.status(502).json({
        error: error?.message || "Failed to submit template to Meta",
        metaError: summarizeMetaError(error),
        templateSystem: buildTemplateSystem(await Shop.findOne({ shop }).lean()),
      });
    }

    const nextTemplates = templates.map((row) =>
      String(row?.id || "") === templateId
        ? {
            ...row,
            metaTemplateId: target.metaTemplateId || row?.metaTemplateId || null,
            status: "pending",
            rawStatus: "PENDING",
            lastError: null,
            rejectionReason: null,
            testMessageTargetPhoneE164: "",
            testMessageOutboundMessageId: null,
            testMessageSentAt: null,
            testMessageStatus: null,
            testMessageStatusAt: null,
            testMessageLastError: null,
            testMessageLastErrorAt: null,
            submittedAt: new Date(),
            updatedAt: new Date(),
          }
        : row,
    );
    const flows = ensureAutomationFlowConfigs(record?.settings?.automationFlows);
    await persistTemplateSystem({
      shop,
      record,
      templates: nextTemplates,
      flows,
      tokenState,
    });

    void logAudit({
      shop,
      actor: "merchant",
      action: "template_submitted_to_meta",
      meta: {
        templateId,
        flowKey: target.flowKey,
        metaTemplateName: target.metaTemplateName,
      },
    });

    const updated = await Shop.findOne({ shop }).lean();
    return res.json({ ok: true, templateSystem: buildTemplateSystem(updated) });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to submit template" });
  }
});

router.post("/templates/assign-flow", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });
    const flowKey = String(req.body?.flowKey || "").trim();
    const templateId = String(req.body?.templateId || "").trim();
    const flow = getFlowDefinition(flowKey);
    if (!flow) return res.status(400).json({ error: "Unsupported automation flow" });
    if (!flow.supportsTemplates) {
      return res.status(409).json({
        error: "This flow does not use a standalone template assignment.",
      });
    }

    const record = await Shop.findOne({ shop }).lean();
    assertTemplateManagementAllowed(record);
    assertFlowAllowedForRecord(flow.key, record);
    const own = record?.whatsappSender?.ownNumber || {};
    const templates = upsertCorePackTemplatesIntoCatalog(
      own?.managedTemplates,
      own?.templates,
    );
    const target = templates.find((row) => String(row?.id || "") === templateId);
    if (!target) return res.status(404).json({ error: "Template not found" });
    if (String(target?.flowKey || "") !== flow.key) {
      return res.status(409).json({ error: "Template does not belong to this flow" });
    }
    if (!isTemplateApproved(target)) {
      return res.status(409).json({
        error: "Only approved templates can be assigned to an active automation flow.",
      });
    }
    const testStatus = String(target?.testMessageStatus || "")
      .trim()
      .toLowerCase();
    const testPassed =
      !!target?.testMessageSentAt &&
      !target?.testMessageLastError &&
      ["accepted", "sent", "delivered", "read"].includes(
        testStatus || "accepted",
      );
    if (!testPassed) {
      return res.status(409).json({
        error: "Kindly test send the template first",
        code: "template_test_send_required",
      });
    }

    const flows = ensureAutomationFlowConfigs(record?.settings?.automationFlows).map((row) =>
      row.flowKey === flow.key
        ? {
            ...row,
            templateId: target.id,
            templateKey: target.templateKey || null,
            updatedAt: new Date(),
          }
        : row,
    );

    await persistTemplateSystem({ shop, record, templates, flows });
    const updated = await Shop.findOne({ shop }).lean();
    return res.json({ ok: true, templateSystem: buildTemplateSystem(updated) });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to assign flow" });
  }
});

router.post("/templates/update-flow", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });
    const flowKey = String(req.body?.flowKey || "").trim();
    const flow = getFlowDefinition(flowKey);
    if (!flow) return res.status(400).json({ error: "Unsupported automation flow" });

    const record = await Shop.findOne({ shop }).lean();
    assertTemplateManagementAllowed(record);
    if (
      !isFlowAllowedForRecord(flow.key, record) &&
      (typeof req.body?.enabled === "boolean"
        ? req.body.enabled
        : truthyFlag(req.body?.enabled))
    ) {
      return res.status(409).json({
        error: "This automation is available only on Your Own Number plans",
      });
    }
    const own = record?.whatsappSender?.ownNumber || {};
    const templates = upsertCorePackTemplatesIntoCatalog(
      own?.managedTemplates,
      own?.templates,
    );
    const nextEnabled =
      typeof req.body?.enabled === "boolean"
        ? req.body.enabled
        : truthyFlag(req.body?.enabled);
    const currentFlow = ensureAutomationFlowConfigs(
      record?.settings?.automationFlows,
    ).find((row) => row.flowKey === flow.key);
    if (nextEnabled && flow.supportsTemplates) {
      const assigned = templates.find(
        (row) => String(row?.id || "") === String(currentFlow?.templateId || ""),
      );
      if (!assigned || !isTemplateApproved(assigned)) {
        return res.status(409).json({
          error: "Only approved templates can be used for an active automation flow.",
        });
      }
      const testStatus = String(assigned?.testMessageStatus || "")
        .trim()
        .toLowerCase();
      const testPassed =
        !!assigned?.testMessageSentAt &&
        !assigned?.testMessageLastError &&
        ["accepted", "sent", "delivered", "read"].includes(
          testStatus || "accepted",
        );
      if (!testPassed) {
        return res.status(409).json({
          error: "Kindly test send the template first",
          code: "template_test_send_required",
        });
      }
    }

    const flows = ensureAutomationFlowConfigs(record?.settings?.automationFlows).map((row) =>
      row.flowKey === flow.key
        ? {
            ...row,
            enabled: nextEnabled,
            config:
              req.body?.config && typeof req.body.config === "object"
                ? req.body.config
                : row.config || {},
            updatedAt: new Date(),
          }
        : row,
    );

    const nextSettings = {
      ...(record?.settings || {}),
      automationFlows: flows,
    };

    const dispatched = flows.find((row) => row.flowKey === FLOW_KEYS.ORDER_DISPATCHED);
    const tracking = flows.find((row) => row.flowKey === FLOW_KEYS.TRACKING_UPDATED);
    const cancelled = flows.find((row) => row.flowKey === FLOW_KEYS.ORDER_CANCELLED);
    const review = flows.find((row) => row.flowKey === FLOW_KEYS.REVIEW_REQUEST);
    const abandonedCart = flows.find(
      (row) => row.flowKey === FLOW_KEYS.ABANDONED_CART,
    );
    const orderUpdatesEnabled = [dispatched, tracking, cancelled, review].some(
      (row) => !!row?.enabled,
    );
    nextSettings.enableWhatsApp =
      flows.find((row) => row.flowKey === FLOW_KEYS.ORDER_CONFIRMATION)?.enabled ??
      nextSettings.enableWhatsApp;
    nextSettings.enableOrderUpdates = orderUpdatesEnabled;
    nextSettings.orderUpdatesDispatched = dispatched?.enabled ?? nextSettings.orderUpdatesDispatched;
    nextSettings.orderUpdatesTrackingUpdated =
      tracking?.enabled ?? nextSettings.orderUpdatesTrackingUpdated;
    nextSettings.orderUpdatesCancelled =
      cancelled?.enabled ?? nextSettings.orderUpdatesCancelled;
    if (review?.config && typeof review.config === "object") {
      if (typeof review.config.reviewUrl === "string") {
        nextSettings.reviewRequestUrl = review.config.reviewUrl.trim();
      }
      if (typeof review.config.linkMode === "string") {
        nextSettings.reviewRequestLinkMode =
          review.config.linkMode.trim().toLowerCase() === "product"
            ? "product"
            : "store";
      }
      if (Number.isFinite(Number(review.config.delayHours))) {
        nextSettings.reviewRequestDelayHours = Math.max(
          0,
          Math.min(24 * 30, Number(review.config.delayHours)),
        );
      }
    }
    if (abandonedCart?.config && typeof abandonedCart.config === "object") {
      if (Number.isFinite(Number(abandonedCart.config.delayMinutes))) {
        nextSettings.abandonedCartDelayMinutes = Math.max(
          15,
          Math.min(7 * 24 * 60, Number(abandonedCart.config.delayMinutes)),
        );
      }
    }

    await Shop.updateOne(
      { shop },
      {
        $set: {
          settings: nextSettings,
          "whatsappSender.ownNumber.managedTemplates": ensureManagedTemplateCatalog(
            templates,
          ),
          "whatsappSender.ownNumber.managedTemplatesUpdatedAt": new Date(),
        },
      },
    );

    const updated = await Shop.findOne({ shop }).lean();
    return res.json({ ok: true, templateSystem: buildTemplateSystem(updated) });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to update flow" });
  }
});

router.post("/templates/send-test", async (req, res) => {
  const shop = String(req.query.shop || "").trim();
  const templateId = String(req.body?.templateId || "").trim();
  const to = normalizeTestDestinationPhone(
    req.body?.to || req.body?.toE164 || req.body?.phone,
  );
  const now = new Date();

  try {
    console.log(
      "[MANAGED_TEMPLATE_TEST] request_received",
      JSON.stringify({ shop, templateId, to }, null, 2),
    );
    if (!shop) return res.status(400).json({ error: "Missing shop" });
    if (!templateId) {
      return res.status(400).json({ error: "Missing templateId" });
    }
    if (!to) {
      return res.status(400).json({
        error: "Enter a valid recipient WhatsApp number in E.164 format.",
      });
    }

    const record = await Shop.findOne({ shop }).lean();
    assertTemplateManagementAllowed(record);
    const own = record?.whatsappSender?.ownNumber || {};
    console.log(
      "[MANAGED_TEMPLATE_TEST] shop_loaded",
      JSON.stringify(
        {
          shop,
          senderStatus: String(own?.status || ""),
          wabaId: String(own?.wabaId || ""),
          phoneNumberId: String(own?.phoneNumberId || ""),
          displayPhoneNumber: String(own?.displayPhoneNumber || ""),
        },
        null,
        2,
      ),
    );
    const templates = upsertCorePackTemplatesIntoCatalog(
      own?.managedTemplates,
      own?.templates,
    );
    const target = templates.find((row) => String(row?.id || "") === templateId);
    if (!target) {
      return res.status(404).json({ error: "Template not found" });
    }
    if (!isTemplateApproved(target)) {
      return res.status(409).json({
        error: "Only approved templates can be sent as live tests.",
      });
    }
    if (!String(own?.wabaId || "").trim() || !String(own?.phoneNumberId || "").trim()) {
      return res.status(409).json({
        error: "Connect Your Own Number before sending a managed template test.",
      });
    }

    console.log(
      "[MANAGED_TEMPLATE_TEST] template_loaded",
      JSON.stringify(
        {
          templateId: target.id,
          flowKey: target.flowKey,
          metaTemplateName: target.metaTemplateName,
          language: target.language,
          status: target.status,
          headerType: target.headerType,
          sampleMediaUrl: target.sampleMediaUrl || null,
          useProductImageHeader: target.useProductImageHeader !== false,
          buttonCount: Array.isArray(target?.buttons) ? target.buttons.length : 0,
        },
        null,
        2,
      ),
    );

    const testContext = buildManagedTemplateTestContext({ shop, own });
    console.log(
      "[MANAGED_TEMPLATE_TEST] context_built",
      JSON.stringify(
        {
          keys: Object.keys(testContext || {}),
          preview: {
            customer_name: testContext.customer_name,
            store_name: testContext.store_name,
            order_number: testContext.order_number,
            product_list: testContext.product_list,
            total_price: testContext.total_price,
            delivery_address: testContext.delivery_address,
            product_image_url: testContext.product_image_url || null,
          },
        },
        null,
        2,
      ),
    );
    console.log(
      "[MANAGED_TEMPLATE_TEST] send_begin",
      JSON.stringify(
        {
          mode: "template",
          shop,
          templateId: target.id,
          metaTemplateName: target.metaTemplateName,
          to,
        },
        null,
        2,
      ),
    );

    const result = await sendManagedTemplateDirect({
      to,
      managedTemplate: target,
      context: testContext,
      shop,
      kind: "managed_template_test_send",
      skipBillingCheck: false,
      meta: {
        source: "managed_template_test_send",
        flowKey: target.flowKey,
        templateId: target.id,
      },
    });

    const waMessageId = String(result?.data?.messages?.[0]?.id || "").trim() || null;
    const status =
      String(result?.data?.messages?.[0]?.message_status || "").trim() || "sent";
    const nextTemplates = templates.map((row) =>
      String(row?.id || "") === String(target.id || "")
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
    console.log(
      "[MANAGED_TEMPLATE_TEST] send_success",
      JSON.stringify(
        {
          mode: "template",
          shop,
          templateId: target.id,
          metaTemplateName: target.metaTemplateName,
          to,
          waMessageId,
          status,
          templateUsed: result?.templateUsed || null,
          langUsed: result?.langUsed || null,
          headerMediaUrlUsed: result?.headerMediaUrlUsed || null,
          headerVariableCount: Number(result?.headerVariableCount || 0),
          bodyVariableCount: Number(result?.bodyVariableCount || 0),
        },
        null,
        2,
      ),
    );

    await Shop.updateOne(
      { shop },
      {
        $set: {
          "whatsappSender.ownNumber.managedTemplates": ensureManagedTemplateCatalog(
            nextTemplates,
          ),
          "whatsappSender.ownNumber.managedTemplatesUpdatedAt": now,
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

    void logAudit({
      shop,
      actor: "merchant",
      action: "managed_template_test_send",
      meta: {
        templateId: target.id,
        flowKey: target.flowKey,
        to,
        waMessageId,
        langUsed: result?.langUsed || null,
      },
    });

    const updated = await Shop.findOne({ shop }).lean();
    return res.json({
      ok: true,
      templateSystem: buildTemplateSystem(updated),
      testSend: {
        to,
        flowKey: target.flowKey,
        templateId: target.id,
        templateUsed: result?.templateUsed || target.metaTemplateName || null,
        langUsed: result?.langUsed || target.language || null,
        waMessageId,
        headerMediaUrlUsed: result?.headerMediaUrlUsed || null,
        headerVariableCount: Number(result?.headerVariableCount || 0),
        bodyVariableCount: Number(result?.bodyVariableCount || 0),
        sentAt: now,
      },
    });
  } catch (error) {
    console.log(
      "[MANAGED_TEMPLATE_TEST] send_error",
      JSON.stringify(
        {
          mode: "template",
          shop,
          templateId,
          to,
          message: error?.message || "Failed to send test template",
          metaError: summarizeMetaError(error),
        },
        null,
        2,
      ),
    );
    const shortError = String(error?.message || "Failed to send test template").slice(0, 400);
    const record = shop ? await Shop.findOne({ shop }).lean().catch(() => null) : null;
    const templates = upsertCorePackTemplatesIntoCatalog(
      record?.whatsappSender?.ownNumber?.managedTemplates,
      record?.whatsappSender?.ownNumber?.templates,
    );
    const nextTemplates = templates.map((row) =>
      String(row?.id || "") === String(templateId || "")
        ? {
            ...row,
            testMessageTargetPhoneE164: to,
            testMessageStatus: "failed",
            testMessageStatusAt: now,
            testMessageLastError: shortError,
            testMessageLastErrorAt: now,
            updatedAt: now,
          }
        : row,
    );
    await Shop.updateOne(
      { shop },
      {
        $set: {
          "whatsappSender.ownNumber.managedTemplates": ensureManagedTemplateCatalog(
            nextTemplates,
          ),
          "whatsappSender.ownNumber.managedTemplatesUpdatedAt": now,
          "whatsappSender.ownNumber.testMessageTargetPhoneE164": to,
          "whatsappSender.ownNumber.testMessageStatus": "failed",
          "whatsappSender.ownNumber.testMessageStatusAt": now,
          "whatsappSender.ownNumber.testMessageLastError": shortError,
          "whatsappSender.ownNumber.testMessageLastErrorMeta": summarizeMetaError(error),
          "whatsappSender.ownNumber.testMessageLastErrorAt": now,
        },
      },
    ).catch(() => {});

    return res.status(Number(error?.httpStatus || 502) || 502).json({
      error: error?.message || "Failed to send test template",
      metaError: summarizeMetaError(error),
    });
  }
});

router.post("/templates/send-test-bare", async (req, res) => {
  const shop = String(req.query.shop || "").trim();
  const templateId = String(req.body?.templateId || "").trim();
  const to = normalizeTestDestinationPhone(
    req.body?.to || req.body?.toE164 || req.body?.phone,
  );
  const now = new Date();

  try {
    console.log(
      "[MANAGED_TEMPLATE_TEST] request_received",
      JSON.stringify({ mode: "bare_template", shop, templateId, to }, null, 2),
    );
    if (!shop) return res.status(400).json({ error: "Missing shop" });
    if (!templateId) {
      return res.status(400).json({ error: "Missing templateId" });
    }
    if (!to) {
      return res.status(400).json({
        error: "Enter a valid recipient WhatsApp number in E.164 format.",
      });
    }

    const record = await Shop.findOne({ shop }).lean();
    assertTemplateManagementAllowed(record);
    const own = record?.whatsappSender?.ownNumber || {};
    const templates = upsertCorePackTemplatesIntoCatalog(
      own?.managedTemplates,
      own?.templates,
    );
    const target = templates.find((row) => String(row?.id || "") === templateId);
    if (!target) {
      return res.status(404).json({ error: "Template not found" });
    }
    if (!String(own?.wabaId || "").trim() || !String(own?.phoneNumberId || "").trim()) {
      return res.status(409).json({
        error: "Connect Your Own Number before sending a bare template test.",
      });
    }

    const testContext = buildManagedTemplateTestContext({ shop, own });
    console.log(
      "[MANAGED_TEMPLATE_TEST] bare_template_begin",
      JSON.stringify(
        {
          shop,
          templateId: target.id,
          to,
          headerType: target.headerType,
          sampleMediaUrl: target.sampleMediaUrl || null,
        },
        null,
        2,
      ),
    );

    const result = await sendManagedTemplateDirect({
      to,
      managedTemplate: target,
      context: testContext,
      shop,
      kind: "managed_template_bare_test_send",
      skipVariableParameters: true,
      meta: {
        source: "managed_template_bare_test_send",
        flowKey: target.flowKey,
        templateId: target.id,
      },
    });

    const waMessageId = String(result?.data?.messages?.[0]?.id || "").trim() || null;
    const status =
      String(result?.data?.messages?.[0]?.message_status || "").trim() || "sent";
    console.log(
      "[MANAGED_TEMPLATE_TEST] send_success",
      JSON.stringify(
        {
          mode: "bare_template",
          shop,
          templateId: target.id,
          to,
          waMessageId,
          status,
          templateUsed: result?.templateUsed || target.metaTemplateName || null,
          langUsed: result?.langUsed || target.language || null,
          headerMediaUrlUsed: result?.headerMediaUrlUsed || null,
          headerVariableCount: Number(result?.headerVariableCount || 0),
          bodyVariableCount: Number(result?.bodyVariableCount || 0),
        },
        null,
        2,
      ),
    );

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
      templateSystem: buildTemplateSystem(await Shop.findOne({ shop }).lean()),
      testSend: {
        mode: "bare_template",
        to,
        flowKey: target.flowKey,
        templateId: target.id,
        templateUsed: result?.templateUsed || target.metaTemplateName || null,
        langUsed: result?.langUsed || target.language || null,
        waMessageId,
        sentAt: now,
      },
    });
  } catch (error) {
    console.log(
      "[MANAGED_TEMPLATE_TEST] send_error",
      JSON.stringify(
        {
          mode: "bare_template",
          shop,
          templateId,
          to,
          message: error?.message || "Failed to send bare template test",
          metaError: summarizeMetaError(error),
        },
        null,
        2,
      ),
    );
    const shortError = String(
      error?.message || "Failed to send bare template test",
    ).slice(0, 400);
    await Shop.updateOne(
      { shop },
      {
        $set: {
          "whatsappSender.ownNumber.testMessageTargetPhoneE164": to,
          "whatsappSender.ownNumber.testMessageStatus": "failed",
          "whatsappSender.ownNumber.testMessageStatusAt": now,
          "whatsappSender.ownNumber.testMessageLastError": shortError,
          "whatsappSender.ownNumber.testMessageLastErrorMeta": summarizeMetaError(error),
          "whatsappSender.ownNumber.testMessageLastErrorAt": now,
        },
      },
    ).catch(() => {});

    return res.status(Number(error?.httpStatus || 502) || 502).json({
      error: error?.message || "Failed to send bare template test",
      metaError: summarizeMetaError(error),
    });
  }
});

export default router;
