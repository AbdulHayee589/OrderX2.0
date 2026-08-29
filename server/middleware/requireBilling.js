import { getBillingStatus } from "../services/billing.js";

/**
 * Enforces that the shop has an active plan (ACTIVE or TRIAL, not expired).
 *
 * NOTE:
 * In this codebase we use a Mongo-stored plan because Shopify Billing API is
 * unavailable for apps without public distribution. When you go public, you
 * can swap subscribe flow to Shopify Billing API and keep this middleware.
 */
export async function requireBilling(req, res, next) {
  try {
    const shop = req.query.shop;
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const billing = await getBillingStatus(shop);

    if (!billing.active) {
      // 402 Payment Required is a good semantic status for billing gating
      return res.status(402).json({ error: "Billing inactive", billing });
    }

    // Attach for downstream handlers
    req.billing = billing;
    return next();
  } catch (e) {
    return res.status(500).json({ error: e.message || "Billing check failed" });
  }
}

export default requireBilling;
