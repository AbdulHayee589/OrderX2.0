function normalizeBaseUrl(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  // Allow setting BACKEND_BASE_URL like "127.0.0.1:8081"
  return `http://${v}`;
}

function getBackendBaseUrl() {
  return normalizeBaseUrl(
    process.env.BACKEND_BASE_URL || "https://api.orderxapp.com",
  );
}

function getInternalHeaders() {
  const secret = process.env.INTERNAL_SYNC_SECRET;
  if (!secret) return {};

  // Send both to avoid any backend version mismatch
  return {
    "X-Internal-Token": secret,
    "X-Internal-Sync-Secret": secret,
  };
}

const inFlightBackendGets = new Map();

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const DEFAULT_BACKEND_GET_TIMEOUT_MS = positiveNumber(
  process.env.BACKEND_GET_TIMEOUT_MS,
  60_000,
);
const SLOW_BACKEND_GET_MS = positiveNumber(
  process.env.BACKEND_SLOW_GET_MS,
  2_000,
);

async function safeReadJson(res) {
  const text = await res.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    // Non-JSON error (HTML, plain text)
    return { raw: text };
  }
}

async function readJsonWithTimeout(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function toError(res, data) {
  const message =
    data?.error ||
    data?.message ||
    (typeof data?.raw === "string" ? data.raw.slice(0, 300) : "") ||
    `Request failed (${res.status})`;

  const err = new Error(message);
  err.status = res.status;
  err.data = data;
  return err;
}

function backendTimeoutError(path, timeoutMs, cause) {
  const err = new Error(
    `OrderX data service did not respond within ${Math.ceil(timeoutMs / 1000)} seconds.`,
  );
  err.name = "BackendTimeoutError";
  err.code = "BACKEND_TIMEOUT";
  err.status = 504;
  err.path = String(path || "").split("?")[0];
  err.cause = cause;
  return err;
}

async function performBackendGet(path, shop, options = {}) {
  const base = getBackendBaseUrl();
  const url = new URL(path, base);
  url.searchParams.set("shop", shop || "");
  const timeoutMs = positiveNumber(
    options?.timeoutMs,
    DEFAULT_BACKEND_GET_TIMEOUT_MS,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  const startedAt = Date.now();

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...getInternalHeaders(),
      },
      signal: controller.signal,
      // In case you later add cookies/session between services
      credentials: "include",
    });

    const data = await readJsonWithTimeout(res);
    if (!res.ok) throw toError(res, data);
    return data;
  } catch (e) {
    if (e?.status) throw e;
    if (controller.signal.aborted || e?.name === "AbortError") {
      throw backendTimeoutError(path, timeoutMs, e);
    }
    const err = new Error(
      `Backend fetch failed. Check BACKEND_BASE_URL (${base}).`,
    );
    err.code = "BACKEND_UNAVAILABLE";
    err.status = 503;
    err.cause = e;
    throw err;
  } finally {
    clearTimeout(timeout);
    const durationMs = Date.now() - startedAt;
    if (durationMs >= SLOW_BACKEND_GET_MS) {
      console.warn("[backend_get_slow]", {
        path: url.pathname,
        durationMs,
      });
    }
  }
}

export function backendGet(path, shop, options = {}) {
  const timeoutMs = positiveNumber(
    options?.timeoutMs,
    DEFAULT_BACKEND_GET_TIMEOUT_MS,
  );
  const key = `${String(shop || "")
    .trim()
    .toLowerCase()}|${String(path || "")}|${timeoutMs}`;
  if (inFlightBackendGets.has(key)) return inFlightBackendGets.get(key);

  const pending = performBackendGet(path, shop, { timeoutMs }).finally(() => {
    if (inFlightBackendGets.get(key) === pending) {
      inFlightBackendGets.delete(key);
    }
  });
  inFlightBackendGets.set(key, pending);
  return pending;
}

export async function backendPost(path, shop, body) {
  const base = getBackendBaseUrl();
  const url = new URL(path, base);
  url.searchParams.set("shop", shop || "");

  let res;
  try {
    res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getInternalHeaders(),
      },
      body: JSON.stringify(body || {}),
      credentials: "include",
    });
  } catch (e) {
    const err = new Error(
      `Backend fetch failed. Check BACKEND_BASE_URL (${base}).`,
    );
    err.cause = e;
    throw err;
  }

  const data = await safeReadJson(res);

  if (!res.ok) {
    throw toError(res, data);
  }

  return data;
}

async function backendMutation(method, path, shop, body = null) {
  const base = getBackendBaseUrl();
  const url = new URL(path, base);
  url.searchParams.set("shop", shop || "");

  let res;
  try {
    res = await fetch(url.toString(), {
      method,
      headers: {
        "Content-Type": "application/json",
        ...getInternalHeaders(),
      },
      ...(body == null ? {} : { body: JSON.stringify(body) }),
      credentials: "include",
    });
  } catch (e) {
    const err = new Error(
      `Backend fetch failed. Check BACKEND_BASE_URL (${base}).`,
    );
    err.cause = e;
    throw err;
  }

  const data = await safeReadJson(res);
  if (!res.ok) throw toError(res, data);
  return data;
}

export async function backendPut(path, shop, body) {
  return backendMutation("PUT", path, shop, body || {});
}

export async function backendDelete(path, shop) {
  return backendMutation("DELETE", path, shop);
}
