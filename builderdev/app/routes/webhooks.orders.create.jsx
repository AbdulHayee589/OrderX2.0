import { backendPost } from "../server/backend.server";
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

  const { shop, topic, payload, webhookId } = webhook;

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    await backendPost("/internal/shopify-order-created", shop, {
      topic,
      orderId: payload?.id || null,
      webhookId,
    });
  } catch (error) {
    console.error(
      "[shopify_webhook_forward_failed]",
      shop,
      topic,
      error?.message || error,
    );
    return new Response("Backend webhook forward failed", { status: 500 });
  }

  return shopifyWebhookAck();
};
