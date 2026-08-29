import express from "express";
import { shopify } from "../shopify.js";
import { logAudit } from "../services/audit.js";
import { persistOfflineSessionToShop } from "../services/shopifyTokenService.js";
import { sanitizeShopifyTokenError } from "../services/shopifyTokenState.js";

const router = express.Router();
const DEBUG = process.env.DEBUG_ORDERX === "true";
const dbg = (...args) => {
  if (DEBUG) console.log(...args);
};

/**
 * Start OAuth (offline token)
 * /auth/begin?shop=xxx.myshopify.com
 */

function isValidShop(shop) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(String(shop || "").trim());
}

router.get("/begin", async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!isValidShop(shop)) {
      return res.status(400).send("Invalid shop parameter");
    }

    const authUrl = await shopify.auth.begin({
      shop,
      callbackPath: "/auth/callback",
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });

    return res.redirect(authUrl);
  } catch (e) {
    console.error("[auth/begin]", sanitizeShopifyTokenError(e));
    return res.status(500).send("Auth begin failed");
  }
});

/**
 * OAuth callback
 * Shopify redirects here after approve
 */
router.get("/callback", async (req, res) => {
  try {
    const { session } = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
      expiring: true,
    });
    await persistOfflineSessionToShop({
      shop: session.shop,
      session,
      scopes: session.scope || "",
      installedAt: new Date(),
      host: req.query.host || session.host || null,
    });
    dbg("[auth_offline_token]", {
      shop: session.shop,
      scopes: session.scope || "",
    });

    void logAudit({
      shop: session.shop,
      actor: "system",
      action: "app_install",
      message: "Store completed OAuth install or re-install.",
      meta: {
        scopes: session.scope || "",
        host: req.query.host || session.host || null,
      },
    });

    // ✅ Register ONLY what your CLI config allows (app/uninstalled, app/scopes_update)
    // If you attempt protected customer data webhooks, Shopify will block and you’ll get noisy errors.
    try {
      await shopify.webhooks.register({ session });
    } catch (e) {
      console.warn("[auth/callback] webhook register warning:", e?.message);
    }

    // ✅ host may not always be present on callback; fallback to session.host if available
    const host = req.query.host || session.host;
    const appUrl = String(
      process.env.SHOPIFY_APP_URL ||
        process.env.APP_URL ||
        `${req.protocol}://${req.get("host") || ""}`,
    ).trim();

    // If host missing, still send them to /app (Shopify will embed correctly if shop param exists)
    const redirectUrl = host
      ? `${appUrl}/app?shop=${encodeURIComponent(
          session.shop,
        )}&host=${encodeURIComponent(host)}`
      : `${appUrl}/app?shop=${encodeURIComponent(session.shop)}`;

    return res.redirect(redirectUrl);
  } catch (e) {
    console.error("[auth/callback]", sanitizeShopifyTokenError(e));
    return res.status(500).send("Auth callback failed");
  }
});

export default router;
