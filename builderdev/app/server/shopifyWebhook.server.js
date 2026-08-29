import crypto from "crypto";

function asText(value) {
  return String(value || "").trim();
}

function timingSafeEqualText(a, b) {
  const left = Buffer.from(asText(a), "utf8");
  const right = Buffer.from(asText(b), "utf8");
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function readHeader(request, name) {
  return asText(request.headers.get(name));
}

export async function verifyShopifyWebhook(request) {
  const rawBody = await request.text();
  const secret = asText(process.env.SHOPIFY_API_SECRET);
  if (!secret) {
    const error = new Error("Missing SHOPIFY_API_SECRET");
    error.status = 500;
    throw error;
  }

  const expectedHmac = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");
  const receivedHmac = readHeader(request, "x-shopify-hmac-sha256");
  if (!timingSafeEqualText(expectedHmac, receivedHmac)) {
    const error = new Error("Invalid Shopify webhook HMAC");
    error.status = 401;
    throw error;
  }

  let payload = {};
  if (rawBody) {
    try {
      payload = JSON.parse(rawBody);
    } catch {
      const error = new Error("Invalid Shopify webhook JSON payload");
      error.status = 400;
      throw error;
    }
  }

  const shop = readHeader(request, "x-shopify-shop-domain");
  const topic = readHeader(request, "x-shopify-topic");
  const webhookId =
    readHeader(request, "x-shopify-event-id") ||
    readHeader(request, "x-shopify-webhook-id") ||
    null;

  if (!shop || !topic) {
    const error = new Error("Missing Shopify webhook shop or topic headers");
    error.status = 400;
    throw error;
  }

  return { shop, topic, payload, webhookId, rawBody };
}

export function shopifyWebhookAck() {
  return new Response(null, { status: 200 });
}

export function shopifyWebhookError(error) {
  const status = Number(error?.status || 500);
  const safeStatus = Number.isFinite(status) ? status : 500;
  return new Response(error?.message || "Shopify webhook failed", {
    status: safeStatus,
  });
}
