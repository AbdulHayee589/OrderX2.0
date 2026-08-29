import { shopify } from "../shopify.js";
import {
  ensureValidShopOfflineAccessToken,
  flagShopifyReauthorizationRequired,
} from "../services/shopifyTokenService.js";
import { executeWithOneUnauthorizedRetry } from "../services/shopifyTokenState.js";

function asText(value) {
  return String(value || "").trim();
}

function createGraphqlClient(shop, accessToken) {
  const session = {
    id: shopify.session.getOfflineId(shop),
    shop,
    isOnline: false,
    accessToken,
    scope: process.env.SCOPES || "",
    state: "",
  };
  return new shopify.clients.Graphql({ session });
}

async function executeGraphql(client, queryString, variables) {
  if (typeof client.request === "function") {
    const body = await client.request(queryString, { variables });
    return { body };
  }
  if (typeof client.query === "function") {
    return client.query({ data: queryString, variables });
  }
  throw new Error("Unsupported Shopify GraphQL client");
}

function normalizeQueryInput(data, variables) {
  if (!data) throw new Error("Missing GraphQL query data");
  let queryString = data;
  let normalizedVariables = variables;
  if (typeof data === "object" && data.query) {
    queryString = data.query;
    normalizedVariables = data.variables ?? variables;
  }
  if (typeof queryString !== "string") {
    throw new Error("GraphQL query must be a string");
  }
  return { queryString, variables: normalizedVariables };
}

/**
 * Returns one Shopify Admin GraphQL client facade for routes and workers.
 *
 * Credentials are resolved from the central token service, refreshed before
 * expiry, and refreshed/reloaded once after a 401. The GraphQL operation is
 * retried at most once; a second 401 is returned to the caller.
 */
export async function getAdminClient(shop, accessTokenOrOptions = null) {
  const shopDomain = asText(shop).toLowerCase();
  if (!shopDomain) throw new Error("Missing shop");

  const options =
    accessTokenOrOptions &&
    typeof accessTokenOrOptions === "object" &&
    !Array.isArray(accessTokenOrOptions)
      ? accessTokenOrOptions
      : { accessToken: accessTokenOrOptions };
  const fallbackAccessToken = asText(options.accessToken);
  let tokenState = await ensureValidShopOfflineAccessToken(shopDomain, {
    migrateLegacy: options.migrateLegacy !== false,
    record: options.record || null,
    fallbackAccessToken,
    repairMirror: options.repairMirror !== false,
  });

  if (!tokenState?.accessToken) {
    throw new Error("Missing shop/accessToken");
  }

  return {
    async query({ data, variables } = {}) {
      const normalized = normalizeQueryInput(data, variables);
      return executeWithOneUnauthorizedRetry({
        request: async ({ retry, recovery }) => {
          if (retry && recovery?.accessToken) tokenState = recovery;
          const client = createGraphqlClient(
            shopDomain,
            tokenState.accessToken,
          );
          return executeGraphql(
            client,
            normalized.queryString,
            normalized.variables,
          );
        },
        recover: async () => {
          tokenState = await ensureValidShopOfflineAccessToken(shopDomain, {
            forceRefresh: true,
            forceMigration: true,
            migrateLegacy: true,
            failedAccessToken: tokenState.accessToken,
            fallbackAccessToken,
            repairMirror: true,
          });
          return tokenState;
        },
        onRetryUnauthorized: async (error, recovery) => {
          await flagShopifyReauthorizationRequired(
            shopDomain,
            error,
            "fresh_token_rejected",
            {
              expectedAccessToken:
                recovery?.accessToken || tokenState.accessToken,
            },
          );
        },
      });
    },
  };
}

export const shopifyAdminInternals = {
  createGraphqlClient,
  executeGraphql,
  normalizeQueryInput,
};
