import { authenticate } from "../shopify.server";
import { loadDashboardCore } from "../server/dashboardData.server";
import { prepareShopifyOfflineSession } from "../server/shopifyOfflineSession.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const host = url.searchParams.get("host") || session.host || "";

  // The parent route already starts this synchronization. Awaiting it here
  // preserves fresh-install behavior, while a transient mirror failure must
  // not replace the merchant's current page with an error boundary.
  await prepareShopifyOfflineSession({
    shop: session.shop,
    fallbackSession: session,
    host,
  }).catch(() => null);

  const core = await loadDashboardCore(session.shop);

  return {
    ...core,
    ok: core.coreLoaded,
  };
};
