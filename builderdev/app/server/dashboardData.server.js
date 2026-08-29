import { backendGet } from "./backend.server.js";

const toArray = (value) => (Array.isArray(value) ? value : []);
const toObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

const DASHBOARD_READ_TIMEOUT_MS = (() => {
  const parsed = Number(process.env.DASHBOARD_READ_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4_500;
})();

function hasBillingPayload(value) {
  const billing = toObject(value);
  return ["active", "status", "planKey", "plan", "plans"].some((key) =>
    Object.prototype.hasOwnProperty.call(billing, key),
  );
}

function fulfilledValue(result) {
  return result?.status === "fulfilled" ? result.value : null;
}

function dashboardGet(path, shop) {
  return backendGet(path, shop, { timeoutMs: DASHBOARD_READ_TIMEOUT_MS });
}

export function inferDashboardTimezone(billing = {}, attempts = []) {
  const attemptTimezone = toArray(attempts).find((row) =>
    String(row?.timezone || "").trim(),
  )?.timezone;
  if (attemptTimezone) return String(attemptTimezone).trim();

  return String(billing?.storeCountryCode || "")
    .trim()
    .toUpperCase() === "PK"
    ? "Asia/Karachi"
    : "UTC";
}

export async function loadDashboardCore(shop) {
  const [billingResult, usageResult, senderResult, metaConfigResult] =
    await Promise.allSettled([
      dashboardGet("/api/billing/status", shop),
      dashboardGet("/api/usage", shop),
      dashboardGet("/api/sender", shop),
      dashboardGet("/api/sender/byon/meta-config", shop),
    ]);

  const billingResponse = toObject(fulfilledValue(billingResult));
  const usage = toObject(fulfilledValue(usageResult));
  const usageBilling = toObject(usage?.billing);
  const billing = hasBillingPayload(usageBilling)
    ? usageBilling
    : billingResponse;
  const coreLoaded = hasBillingPayload(billing);
  const warnings = [];

  if (senderResult.status === "rejected") {
    warnings.push("WhatsApp sender status is temporarily unavailable.");
  }
  if (metaConfigResult.status === "rejected") {
    warnings.push("Meta setup details are temporarily unavailable.");
  }
  if (billing?.active && usageResult.status === "rejected") {
    warnings.push("Usage totals are temporarily unavailable.");
  }

  return {
    ok: coreLoaded,
    dashboardShell: true,
    coreLoaded,
    billing: coreLoaded ? billing : null,
    usage: usageResult.status === "fulfilled" ? usage : null,
    sender: toObject(toObject(fulfilledValue(senderResult)).sender),
    senderMetaConfig: toObject(
      toObject(fulfilledValue(metaConfigResult)).config,
    ),
    merchantTimezone: inferDashboardTimezone(billing),
    warnings,
    error: coreLoaded
      ? ""
      : "OrderX could not load your store status. Your automations are not affected; retry the dashboard connection.",
  };
}

export async function loadDashboardAnalytics(shop) {
  const [metricsResult, attemptsResult] = await Promise.allSettled([
    dashboardGet("/api/metrics", shop),
    dashboardGet("/api/attempts?range=this_cycle&page=1&pageSize=200", shop),
  ]);
  const metrics = toArray(fulfilledValue(metricsResult));
  const attemptsRaw = fulfilledValue(attemptsResult);
  const attemptsResponse = Array.isArray(attemptsRaw)
    ? { items: attemptsRaw }
    : toObject(attemptsRaw);
  const attempts = toArray(attemptsResponse.items || attemptsRaw);
  const summary = toObject(attemptsResponse.summary);
  const attemptTimezone = attempts.find((row) =>
    String(row?.timezone || "").trim(),
  )?.timezone;
  const warnings = [];

  if (metricsResult.status === "rejected") {
    warnings.push("Store analytics are temporarily unavailable.");
  }
  if (attemptsResult.status === "rejected") {
    warnings.push("Recent order confirmations are temporarily unavailable.");
  }

  const confirmed = Number.isFinite(Number(summary.confirmed))
    ? Number(summary.confirmed)
    : attempts.filter((row) => row?.status === "confirmed").length;
  const cancelled = Number.isFinite(Number(summary.cancelled))
    ? Number(summary.cancelled)
    : attempts.filter((row) => row?.status === "cancelled").length;
  const pending = Number.isFinite(Number(summary.pending))
    ? Number(summary.pending)
    : attempts.filter((row) =>
        ["scheduled", "pending", "wa_sent"].includes(row?.status),
      ).length;

  return {
    analyticsLoaded: true,
    metricsLoaded: metricsResult.status === "fulfilled",
    attemptsLoaded: attemptsResult.status === "fulfilled",
    analyticsAvailable:
      metricsResult.status === "fulfilled" ||
      attemptsResult.status === "fulfilled",
    metrics,
    attempts,
    recentAttempts: attempts.slice(0, 10),
    attemptTotal: Number.isFinite(Number(summary.total))
      ? Number(summary.total)
      : attempts.length,
    confirmed,
    cancelled,
    pending,
    ...(attemptTimezone
      ? { merchantTimezone: String(attemptTimezone).trim() }
      : {}),
    warnings,
  };
}
