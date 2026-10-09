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

  const { shop, topic } = webhook;
  console.log(`Received ${topic} webhook for ${shop}`);

  // Also revoke/cancel backend access so background jobs stop calling Shopify.
  try {
    await backendPost("/internal/uninstall", shop, {});
  } catch (error) {
    console.error(
      "[shopify_uninstall_forward_failed]",
      shop,
      error?.message || error,
    );
    // Retry until background access is revoked successfully.
    return new Response("Uninstall webhook processing failed", {
      status: 500,
    });
  }

  return shopifyWebhookAck();
};
