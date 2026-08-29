import {
  shopifyWebhookAck,
  shopifyWebhookError,
  verifyShopifyWebhook,
} from "../server/shopifyWebhook.server";

export const action = async ({ request }) => {
  let webhook;
  try {
    webhook = await verifyShopifyWebhook(request);
  } catch (error) {
    return shopifyWebhookError(error);
  }

  const { payload, topic, shop } = webhook;
  console.log(`Received ${topic} webhook for ${shop}`);

  const current = Array.isArray(payload?.current)
    ? payload.current.join(",")
    : String(payload?.current || "").trim();
  if (current) {
    console.log(`[shopify_scopes_update] ${shop} scopes=${current}`);
  }

  return shopifyWebhookAck();
};
