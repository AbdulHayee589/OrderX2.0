export function isShopifyBillingTestMode(env = process.env) {
  const configured = String(env.SHOPIFY_BILLING_TEST_MODE || "")
    .trim()
    .toLowerCase();
  if (["1", "true", "yes", "on"].includes(configured)) return true;
  if (["0", "false", "no", "off"].includes(configured)) return false;
  return String(env.NODE_ENV || "").trim().toLowerCase() !== "production";
}
