/* global globalThis */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPaths = [
  path.resolve(__dirname, "../.env"),
  path.resolve(__dirname, ".env"),
  path.resolve(__dirname, "../../server/.env"),
];

if (!globalThis.__orderxBuilderEnvLoaded) {
  for (const envPath of envPaths) {
    dotenv.config({
      path: envPath,
      // Shopify CLI injects the current tunnel into SHOPIFY_APP_URL. Never let
      // a checked/local .env value replace that runtime URL, or billing returns
      // to the production hostname instead of the active development preview.
      override: false,
    });
  }
  globalThis.__orderxBuilderEnvLoaded = true;
}

export { envPaths };
