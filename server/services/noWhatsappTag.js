import {
  appendOrderTag,
  getAdminClient,
  removeOrderTags,
} from "./shopifyAdmin.js";

export const NO_WHATSAPP_TAG = String(
  process.env.NO_WHATSAPP_TAG || "⚠️ No Whatsapp",
).trim();
export const COD_MSG_FAILED_TAG = String(
  process.env.COD_MSG_FAILED_TAG || "COD_MSG_Failed",
).trim();
export const META_PAYMENT_ISSUE_TAG = String(
  process.env.META_PAYMENT_ISSUE_TAG || "META_PAYMENT_ISSUE",
).trim();
export const META_ERROR_ORDER_TAGS = [
  NO_WHATSAPP_TAG,
  COD_MSG_FAILED_TAG,
  META_PAYMENT_ISSUE_TAG,
].filter(Boolean);

function readGraphError(input) {
  if (!input || typeof input !== "object") return null;
  if (Array.isArray(input?.errors) && input.errors.length) {
    return input.errors[0];
  }
  return (
    input?.meta?.error ||
    input?.data?.error ||
    input?.fallback?.error ||
    input?.error ||
    null
  );
}

function readGraphErrorCode(input) {
  const error = readGraphError(input);
  return Number(error?.code || input?.waCode || input?.code || 0) || null;
}

export function isRecipientNoWhatsappError(input) {
  return readGraphErrorCode(input) === 131026;
}

export function isMetaPaymentIssueError(input) {
  const code = readGraphErrorCode(input);
  if (code === 131042) return true;

  const error = readGraphError(input);
  const message = String(
    error?.message ||
      error?.title ||
      error?.error_data?.details ||
      input?.message ||
      "",
  )
    .trim()
    .toLowerCase();

  return message.includes("business eligibility payment issue");
}

export function resolveMetaErrorOrderTag(input) {
  if (isRecipientNoWhatsappError(input)) return NO_WHATSAPP_TAG;
  if (isMetaPaymentIssueError(input)) return META_PAYMENT_ISSUE_TAG;
  return COD_MSG_FAILED_TAG;
}

export async function clearMetaErrorOrderTags({
  shop,
  accessToken,
  orderGid,
  label = "meta_error_clear",
}) {
  const shopDomain = String(shop || "").trim();
  const token = String(accessToken || "").trim();
  const gid = String(orderGid || "").trim();
  if (!META_ERROR_ORDER_TAGS.length || !shopDomain || !gid) {
    return false;
  }

  try {
    const admin = await getAdminClient(shopDomain, { accessToken: token });
    await removeOrderTags(admin, gid, META_ERROR_ORDER_TAGS);
    return true;
  } catch (error) {
    console.error(
      `[${label}_failed]`,
      shopDomain,
      gid,
      error?.message || error,
    );
    return false;
  }
}

export async function tagOrderNoWhatsapp({
  shop,
  accessToken,
  orderGid,
  label = "no_whatsapp",
}) {
  const shopDomain = String(shop || "").trim();
  const token = String(accessToken || "").trim();
  const gid = String(orderGid || "").trim();
  if (!NO_WHATSAPP_TAG || !shopDomain || !gid) return false;

  try {
    const admin = await getAdminClient(shopDomain, { accessToken: token });
    if (META_ERROR_ORDER_TAGS.length) {
      await removeOrderTags(admin, gid, META_ERROR_ORDER_TAGS).catch(() => {});
    }
    await appendOrderTag(admin, gid, NO_WHATSAPP_TAG);
    return true;
  } catch (error) {
    console.error(
      `[${label}_tag_failed]`,
      shopDomain,
      gid,
      error?.message || error,
    );
    return false;
  }
}

export async function tagOrderForMetaSendError({
  shop,
  accessToken,
  orderGid,
  error,
  label = "meta_error_tag",
}) {
  const shopDomain = String(shop || "").trim();
  const token = String(accessToken || "").trim();
  const gid = String(orderGid || "").trim();
  const tag = resolveMetaErrorOrderTag(error);
  if (!tag || !shopDomain || !gid) return false;

  try {
    const admin = await getAdminClient(shopDomain, { accessToken: token });
    if (META_ERROR_ORDER_TAGS.length) {
      await removeOrderTags(admin, gid, META_ERROR_ORDER_TAGS).catch(() => {});
    }
    await appendOrderTag(admin, gid, tag);
    return true;
  } catch (applyError) {
    console.error(
      `[${label}_failed]`,
      shopDomain,
      gid,
      applyError?.message || applyError,
    );
    return false;
  }
}
