import AppRuntimeConfig from "../models/AppRuntimeConfig.js";

const CONFIG_KEY = "global";
const CACHE_TTL_MS = Number(process.env.RUNTIME_CONFIG_CACHE_MS || 60_000);

let runtimeConfigCache = {
  expiresAt: 0,
  value: null,
};

function nowMs() {
  return Date.now();
}

function normalizeLimit(value, fallback = 2000) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) return fallback;
  return Math.floor(numeric);
}

function primeRuntimeConfigCache(value) {
  runtimeConfigCache = {
    value,
    expiresAt: nowMs() + CACHE_TTL_MS,
  };
}

export async function getRuntimeConfig(options = {}) {
  const force = options?.force === true;
  if (
    !force &&
    runtimeConfigCache.value &&
    runtimeConfigCache.expiresAt > nowMs()
  ) {
    return runtimeConfigCache.value;
  }

  const record = await AppRuntimeConfig.findOneAndUpdate(
    { singletonKey: CONFIG_KEY },
    {
      $setOnInsert: {
        orderxMaxInitiatedConversations24h: 2000,
      },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
      lean: true,
    },
  );

  const value = {
    orderxMaxInitiatedConversations24h: normalizeLimit(
      record?.orderxMaxInitiatedConversations24h,
      2000,
    ),
  };

  primeRuntimeConfigCache(value);
  return value;
}

export async function updateRuntimeConfig(input = {}) {
  const nextValue = {
    orderxMaxInitiatedConversations24h: normalizeLimit(
      input?.orderxMaxInitiatedConversations24h,
      2000,
    ),
  };

  const record = await AppRuntimeConfig.findOneAndUpdate(
    { singletonKey: CONFIG_KEY },
    {
      $set: nextValue,
      $setOnInsert: { singletonKey: CONFIG_KEY },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
      lean: true,
    },
  );

  const value = {
    orderxMaxInitiatedConversations24h: normalizeLimit(
      record?.orderxMaxInitiatedConversations24h,
      nextValue.orderxMaxInitiatedConversations24h,
    ),
  };
  primeRuntimeConfigCache(value);
  return value;
}

export function clearRuntimeConfigCache() {
  runtimeConfigCache = {
    value: null,
    expiresAt: 0,
  };
}
