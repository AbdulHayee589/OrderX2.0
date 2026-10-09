import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { backendGet, backendPost } from "../server/backend.server";
import { prepareShopifyOfflineSession } from "../server/shopifyOfflineSession.server";
import { isShopifyBillingTestMode } from "../utils/billingMode.server";
import { withShopParams } from "../utils/embedded";

function inferSenderModeFromPlanKey(planKey) {
  return String(planKey || "").startsWith("own_number_")
    ? "own_number"
    : "orderx_number";
}

export const loader = async ({ request }) => {
  const { session, billing, redirect } = await authenticate.admin(request);

  const url = new URL(request.url);
  const planKey = String(url.searchParams.get("plan") || "").trim();
  const senderMode = inferSenderModeFromPlanKey(planKey);
  const isTest = isShopifyBillingTestMode();
  const appReturn = (path) => withShopParams(path, url.search);
  const host = url.searchParams.get("host") || session.host || "";

  // The billing service runs separately from the embedded app. Persist the
  // freshly authenticated offline token before asking it to read Shopify's
  // approved subscription; otherwise it can sync with a stale token and leave
  // the plans page inactive even though Shopify accepted the charge.
  const prepareError = await prepareShopifyOfflineSession({
    shop: session.shop,
    fallbackSession: session,
    host,
  })
    .then(() => null)
    .catch((error) => error);

  // If plan isn't provided, just bounce back to settings.
  if (!planKey) {
    // Ensure the backend has the latest subscription data anyway.
    await backendPost("/api/billing/sync?force=1", session.shop, {}).catch(
      () => null,
    );
    return redirect(appReturn(`/app/plans?senderMode=${senderMode}`));
  }

  const syncedBilling =
    (await backendPost("/api/billing/sync?force=1", session.shop, {
      planKey,
    }).catch(() => null)) ||
    (await backendGet("/api/billing/status", session.shop).catch(() => null));

  const syncedPlanKey = String(syncedBilling?.planKey || "").trim();
  const syncedActive = syncedBilling?.active === true;
  if (syncedActive && syncedPlanKey === planKey) {
    return redirect(
      appReturn(`/app/plans?billing=success&senderMode=${senderMode}`),
    );
  }

  const check = await billing
    .check({ plans: [planKey], isTest })
    .catch(() => null);
  if (check?.hasActivePayment) {
    const confirmedBilling = await backendPost(
      "/api/billing/sync?force=1",
      session.shop,
      { planKey },
    ).catch(() => null);
    if (
      confirmedBilling?.active === true &&
      String(confirmedBilling?.planKey || "").trim() === planKey
    ) {
      return redirect(
        appReturn(`/app/plans?billing=success&senderMode=${senderMode}`),
      );
    }

    // Shopify approved the charge, but the separate billing cache did not
    // persist it. Never report this as an unpaid/declined charge.
    return redirect(
      appReturn(
        `/app/plans?billing=sync_failed&senderMode=${senderMode}&plan=${encodeURIComponent(planKey)}`,
      ),
    );
  }

  if (prepareError) {
    return redirect(
      appReturn(
        `/app/plans?billing=sync_failed&senderMode=${senderMode}&plan=${encodeURIComponent(planKey)}`,
      ),
    );
  }

  return redirect(
    appReturn(`/app/plans?billing=failed&senderMode=${senderMode}`),
  );
};

export const headers = (headersArgs) => boundary.headers(headersArgs);
