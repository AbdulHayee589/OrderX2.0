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

  const { shop, topic, payload } = webhook;
  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    if (topic === "CUSTOMERS_DATA_REQUEST") {
      await backendPost("/internal/privacy/customers-data-request", shop, {
        topic,
        payload,
      });
    } else if (topic === "CUSTOMERS_REDACT") {
      await backendPost("/internal/privacy/customers-redact", shop, {
        topic,
        payload,
      });
    } else if (topic === "SHOP_REDACT") {
      await backendPost("/internal/privacy/shop-redact", shop, {
        topic,
        payload,
      });
    }
  } catch (error) {
    console.error(
      "[shopify_compliance_forward_failed]",
      shop,
      topic,
      error?.message || error,
    );
    // Keep webhook ack successful.
  }

  return shopifyWebhookAck();
};
