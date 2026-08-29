import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { backendGet, backendPost } from "../server/backend.server";
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
  const isTest = false;
  const appReturn = (path) => withShopParams(path, url.search);

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
    await backendPost("/api/billing/sync?force=1", session.shop, {
      planKey,
    }).catch(() => null);
    return redirect(
      appReturn(`/app/plans?billing=success&senderMode=${senderMode}`),
    );
  }

  return redirect(
    appReturn(`/app/plans?billing=failed&senderMode=${senderMode}`),
  );
};

export const headers = (headersArgs) => boundary.headers(headersArgs);
