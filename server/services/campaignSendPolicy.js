const TEMPLATE_PARAMETER_FALLBACKS = Object.freeze({
  customer_name: "Customer",
  store_name: "Store",
  order_number: "Order",
  product_name: "Product",
  product_list: "Product",
  total_price: "Not available",
  delivery_address: "Not available",
  product_url: "Not available",
  support_whatsapp_number: "Not available",
  courier_name: "Not available",
  tracking_number: "Not available",
  tracking_url: "Not available",
  cancel_reason: "No reason provided",
  update_title: "Order update",
  update_details: "Status updated",
  review_url: "Not available",
  checkout_url: "Not available",
  abandoned_minutes: "0",
});

const TRANSIENT_META_CODES = new Set([130429, 131000, 131016, 131056]);
const PARAMETER_COUNT_CODES = new Set([131008, 132000]);
const PARAMETER_FORMAT_CODES = new Set([131009, 132012, 132018]);
const PARAMETER_LENGTH_CODES = new Set([132005]);
const DELIVERY_STATUS_RANK = Object.freeze({
  accepted: 0,
  sent: 1,
  delivered: 2,
  read: 3,
});

function asText(value) {
  return String(value ?? "").trim();
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function clip(value, max = 500) {
  const text = asText(value);
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

function firstObject(values) {
  return values.map(asObject).find((value) => value && Object.keys(value).length) || null;
}

export function sanitizeTemplateParameterValue(value, { key = "", fallback } = {}) {
  const clean = String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, " ")
    .replace(/[\r\n\t\u2028\u2029]+/g, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  if (clean) return clean;

  const fallbackValue =
    fallback !== undefined
      ? fallback
      : TEMPLATE_PARAMETER_FALLBACKS[asText(key).toLowerCase()] ||
        "Not available";
  return String(fallbackValue ?? "")
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

function truncateParameter(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  if (maxLength <= 3) return text.slice(0, Math.max(0, maxLength));
  return `${text.slice(0, maxLength - 3)}...`;
}

export function fitTemplateParameterValues(
  templateText,
  values = [],
  maxRenderedLength,
) {
  const rows = (Array.isArray(values) ? values : []).map((value) =>
    String(value || ""),
  );
  if (!rows.length) return rows;
  const staticLength = String(templateText || "").replace(
    /{{\s*[a-zA-Z0-9_]+\s*}}/g,
    "",
  ).length;
  const dynamicBudget = Math.max(
    rows.length,
    Number(maxRenderedLength || 0) - staticLength,
  );
  const fitted = [...rows];

  while (fitted.reduce((sum, value) => sum + value.length, 0) > dynamicBudget) {
    let longestIndex = 0;
    for (let index = 1; index < fitted.length; index += 1) {
      if (fitted[index].length > fitted[longestIndex].length) {
        longestIndex = index;
      }
    }
    const totalLength = fitted.reduce((sum, value) => sum + value.length, 0);
    const excess = totalLength - dynamicBudget;
    const nextLength = Math.max(1, fitted[longestIndex].length - excess);
    const nextValue = truncateParameter(fitted[longestIndex], nextLength);
    if (nextValue === fitted[longestIndex]) break;
    fitted[longestIndex] = nextValue;
  }
  return fitted;
}

export function extractCampaignGraphError(error = {}) {
  return firstObject([
    error?.meta?.error,
    error?.data?.error,
    error?.fallback?.error,
    error?.response?.body?.error,
    error?.body?.error,
    error?.error,
  ]);
}

export function getCampaignErrorStatus(error = {}) {
  const values = [
    error?.httpStatus,
    error?.statusCode,
    error?.status,
    error?.response?.status,
    error?.response?.statusCode,
  ];
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

export function buildCampaignFailureMeta(error = {}) {
  const graphError = extractCampaignGraphError(error);
  const status = getCampaignErrorStatus(error);
  const errorData = asObject(graphError?.error_data);
  const retryAfter = asText(error?.retryAfter);
  const safeError = graphError
    ? {
        message: clip(graphError?.message),
        type: clip(graphError?.type, 100) || null,
        code: Number(graphError?.code || 0) || graphError?.code || null,
        error_subcode:
          Number(graphError?.error_subcode || 0) ||
          graphError?.error_subcode ||
          null,
        error_data: errorData
          ? {
              details: clip(errorData?.details),
              messaging_product: clip(errorData?.messaging_product, 50) || null,
            }
          : null,
      }
    : null;

  const result = {
    ...(status ? { httpStatus: status } : {}),
    ...(safeError ? { error: safeError } : {}),
    ...(retryAfter ? { retryAfter } : {}),
  };
  return Object.keys(result).length ? result : null;
}

function buildFailureMessage(error, graphError) {
  const values = [
    error?.message,
    graphError?.message,
    graphError?.error_data?.details,
  ]
    .map((value) => clip(value))
    .filter(Boolean);
  const unique = values.filter(
    (value, index) =>
      values.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) ===
      index,
  );
  return unique.join(" - ") || "Failed to send campaign message";
}

export function classifyCampaignSendFailure(error = {}) {
  const graphError = extractCampaignGraphError(error);
  const status = getCampaignErrorStatus(error);
  const waCode = Number(graphError?.code || error?.waCode || error?.code || 0) || 0;
  const message = buildFailureMessage(error, graphError);
  const meta = buildCampaignFailureMeta(error);
  const result = (code, label, retryable = false) => ({
    code,
    label,
    retryable,
    message,
    meta,
    httpStatus: status || null,
    metaCode: waCode || null,
  });

  if (waCode === 131026) return result("no_whatsapp", "No WhatsApp account");
  if (waCode === 131042) return result("meta_payment_issue", "Meta payment issue");
  if (waCode === 132001 || /template name does not exist in the translation/i.test(message)) {
    return result("template_translation_missing", "Template language missing");
  }
  if (PARAMETER_COUNT_CODES.has(waCode)) {
    return result("template_parameter_count", "Template parameter count mismatch");
  }
  if (PARAMETER_FORMAT_CODES.has(waCode)) {
    return result("invalid_template_parameter", "Invalid template value");
  }
  if (PARAMETER_LENGTH_CODES.has(waCode)) {
    return result("template_parameter_too_long", "Template value is too long");
  }
  if (waCode === 131031 || /account has been locked/i.test(message)) {
    return result("whatsapp_account_locked", "WhatsApp account restricted");
  }
  if ([131005, 131045].includes(waCode)) {
    return result("own_number_disconnected", "WhatsApp authorization issue");
  }
  if (waCode === 131047) {
    return result("conversation_window_closed", "Customer-service window closed");
  }
  if ([131048, 131049].includes(waCode)) {
    return result("meta_quality_limit", "Meta quality protection limit");
  }
  if (TRANSIENT_META_CODES.has(waCode)) {
    return result("meta_temporarily_unavailable", "Meta temporarily unavailable", true);
  }
  if (/no valid whatsapp phone number|invalid phone/i.test(message)) {
    return result("invalid_phone", "Invalid phone number");
  }
  if (/order not found/i.test(message)) {
    return result("order_not_found", "Order not found");
  }
  if (/kindly test send the template first/i.test(message)) {
    return result("template_not_tested", "Template test required");
  }
  if (/only approved templates/i.test(message)) {
    return result("template_not_approved", "Template not approved");
  }
  if (/not ready|needs reconnect|authorization|access token/i.test(message)) {
    return result("own_number_disconnected", "WhatsApp disconnected");
  }
  if (/sending is not allowed|billing|limit reached|conversation/i.test(message)) {
    return result("billing_or_limit_block", "Billing or sending limit block");
  }
  if (status === 429) return result("meta_rate_limited", "Meta rate limited", true);
  if (status >= 500) return result("meta_server_error", "Meta server error", true);
  if (status >= 400) return result("meta_client_error", "Meta rejected the message");

  return result("unknown_error", "Unexpected send error");
}

function hasNetworkErrorShape(error = {}) {
  const code = asText(error?.code).toUpperCase();
  const name = asText(error?.name).toLowerCase();
  return (
    ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH"].includes(code) ||
    name === "aborterror" ||
    /network|socket|timed? out|fetch failed/i.test(asText(error?.message))
  );
}

export function shouldRetryCampaignOperation(error = {}, stage = "dispatch") {
  if (error?.safeToRetry === true) return true;
  if (asText(error?.code) === "whatsapp_acceptance_missing") return false;

  const failure = classifyCampaignSendFailure(error);
  if (stage === "context" || stage === "media") {
    return (
      failure.retryable ||
      hasNetworkErrorShape(error) ||
      [408, 425, 429].includes(Number(failure.httpStatus || 0))
    );
  }

  // A raw network failure during message dispatch is ambiguous: Meta may have
  // accepted the message before the connection dropped. Retrying could send a
  // duplicate, so only retry explicit, structured Meta rejections.
  const graphError = extractCampaignGraphError(error);
  return !!graphError && failure.retryable;
}

function retryDelayMs(error, attempt, baseDelayMs) {
  const retryAfter = asText(error?.retryAfter);
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(30_000, Math.max(0, seconds * 1000));
    }
    const dateMs = new Date(retryAfter).getTime();
    if (Number.isFinite(dateMs)) {
      return Math.min(30_000, Math.max(0, dateMs - Date.now()));
    }
  }
  return Math.min(10_000, Math.max(0, baseDelayMs) * 2 ** Math.max(0, attempt - 1));
}

export async function runCampaignOperationWithRetry(
  work,
  {
    stage = "dispatch",
    maxAttempts = 3,
    baseDelayMs = 750,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onRetry = null,
  } = {},
) {
  const attempts = Math.max(1, Math.min(4, Number(maxAttempts || 1)));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await work({ attempt, maxAttempts: attempts });
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetryCampaignOperation(error, stage)) {
        throw error;
      }
      const delayMs = retryDelayMs(error, attempt, baseDelayMs);
      if (typeof onRetry === "function") {
        await onRetry({ error, attempt, nextAttempt: attempt + 1, delayMs, stage });
      }
      if (delayMs > 0) await sleep(delayMs);
    }
  }
  throw lastError;
}

export function calculateCampaignPercent(part, total) {
  if (!Number(total)) return 0;
  return Number(((Number(part || 0) / Number(total)) * 100).toFixed(1));
}

export function isCampaignTemplateCatalogFresh(
  own = {},
  { now = new Date(), maxAgeMs = 5 * 60 * 1000 } = {},
) {
  const reference = now instanceof Date ? now : new Date(now);
  const safeMaxAgeMs = Math.max(1, Number(maxAgeMs || 0));
  if (!Number.isFinite(reference.getTime()) || !Number.isFinite(safeMaxAgeMs)) {
    return false;
  }
  const timestamps = [
    own?.managedTemplatesUpdatedAt,
    own?.campaignLibraryTemplatesUpdatedAt,
  ].map((value) => new Date(value || 0).getTime());
  return timestamps.every(
    (timestamp) =>
      Number.isFinite(timestamp) &&
      timestamp > 0 &&
      reference.getTime() - timestamp < safeMaxAgeMs,
  );
}

export function buildCampaignRunSummary(run = {}, recipients = [], now = new Date()) {
  const rows = Array.isArray(recipients) ? recipients : [];
  const totalRecipients = rows.length;
  const sentCount = rows.filter((row) => row?.status === "sent").length;
  const failedCount = rows.filter((row) => row?.status === "failed").length;
  const skippedCount = rows.filter((row) => row?.status === "skipped").length;
  const pendingCount = rows.filter((row) =>
    ["pending", "processing"].includes(asText(row?.status)),
  ).length;
  const deliveredCount = rows.filter(
    (row) => row?.status === "sent" && ["delivered", "read"].includes(asText(row?.deliveryStatus)),
  ).length;
  const readCount = rows.filter(
    (row) => row?.status === "sent" && asText(row?.deliveryStatus) === "read",
  ).length;
  const scheduledFor = run?.scheduledFor ? new Date(run.scheduledFor) : null;
  const hasFutureSchedule =
    asText(run?.scheduleMode) === "scheduled" &&
    scheduledFor &&
    Number.isFinite(scheduledFor.getTime()) &&
    scheduledFor.getTime() > now.getTime() &&
    !run?.startedAt;

  let status = "completed";
  if (hasFutureSchedule && pendingCount > 0) status = "scheduled";
  else if (pendingCount > 0) status = "processing";
  else if (sentCount > 0 && failedCount > 0) status = "completed_with_failures";
  else if (sentCount > 0) status = "completed";
  else if (failedCount > 0) status = "failed";

  return {
    totalRecipients,
    sentCount,
    failedCount,
    skippedCount,
    pendingCount,
    deliveredCount,
    readCount,
    successRate: calculateCampaignPercent(sentCount, totalRecipients),
    deliveryRate: calculateCampaignPercent(deliveredCount, sentCount),
    failureRate: calculateCampaignPercent(failedCount, totalRecipients),
    status,
    completedAt: pendingCount > 0 ? null : run?.completedAt || now,
  };
}

export function resolveCampaignDeliveryTransition(previousValue, incomingValue) {
  const previous = asText(previousValue).toLowerCase();
  const incoming = asText(incomingValue).toLowerCase();
  if (incoming === "failed") {
    return ["delivered", "read"].includes(previous) ? previous : "failed";
  }
  if (!(incoming in DELIVERY_STATUS_RANK)) return previous || null;
  if (previous === "failed") return previous;
  if (!(previous in DELIVERY_STATUS_RANK)) return incoming;
  return DELIVERY_STATUS_RANK[incoming] > DELIVERY_STATUS_RANK[previous]
    ? incoming
    : previous;
}
