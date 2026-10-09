import "@shopify/shopify-api/adapters/node";
import { shopifyApi, ApiVersion } from "@shopify/shopify-api";
import dotenv from "dotenv";

dotenv.config();

const apiKey = process.env.SHOPIFY_API_KEY;
const apiSecretKey = process.env.SHOPIFY_API_SECRET;

// This should be the Shopify embedded app URL (the Cloudflare URL from `shopify app dev`)
const appUrl = process.env.APP_URL;

// Scopes must be comma-separated
const scopesRaw = process.env.SCOPES || "";
const scopes = scopesRaw
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!apiKey) throw new Error("Missing SHOPIFY_API_KEY");
if (!apiSecretKey) throw new Error("Missing SHOPIFY_API_SECRET");
if (!appUrl) throw new Error("Missing APP_URL (or HOST2) for Shopify hostName");
if (!scopes.length) throw new Error("Missing SCOPES (comma-separated)");

export const shopify = shopifyApi({
  apiKey,
  apiSecretKey,
  scopes,
  hostName: appUrl.replace("https://", "").replace(/\/$/, ""),
  apiVersion: ApiVersion.July26,
  isEmbeddedApp: true,
});
