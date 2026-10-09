import { backendPost } from "../server/backend.server";
import {
  shopifyWebhookAck,
  shopifyWebhookError,
  verifyShopifyWebhook,
} from "../server/shopifyWebhook.server";
import { normalizeComplianceTopic } from "../utils/complianceWebhook";

export const action = async ({ request }) => {
  let webhook;
  try {
    webhook = await verifyShopifyWebhook(request);
  } catch (error) {
    return shopifyWebhookError(error);
  }

  const { shop, topic, payload } = webhook;
  const normalizedTopic = normalizeComplianceTopic(topic);
  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    if (normalizedTopic === "CUSTOMERS_DATA_REQUEST") {
      await backendPost("/internal/privacy/customers-data-request", shop, {
        topic,
        payload,
      });
    } else if (normalizedTopic === "CUSTOMERS_REDACT") {
      await backendPost("/internal/privacy/customers-redact", shop, {
        topic,
        payload,
      });
    } else if (normalizedTopic === "SHOP_REDACT") {
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
    // A failure response lets Shopify retry instead of silently losing a
    // legally required data-access or deletion request.
    return new Response("Compliance webhook processing failed", {
      status: 500,
    });
  }

  return shopifyWebhookAck();
};
