import "dotenv/config";
import { getAllowedActionOrigins } from "./action-origins.js";

// Shopify CLI tunnels and reverse proxies can expose a public browser origin
// while React Router receives an internal request URL. Keep CSRF validation on
// and allow only the app origins explicitly configured for this deployment.
export default {
  allowedActionOrigins: getAllowedActionOrigins(),
};
