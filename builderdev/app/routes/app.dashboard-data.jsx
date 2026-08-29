import { authenticate } from "../shopify.server";
import {
  loadDashboardAnalytics,
  loadDashboardCore,
} from "../server/dashboardData.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const scope = String(new URL(request.url).searchParams.get("scope") || "all")
    .trim()
    .toLowerCase();

  if (scope === "analytics") {
    return {
      ok: true,
      scope,
      ...(await loadDashboardAnalytics(session.shop)),
    };
  }

  const [core, analytics] = await Promise.all([
    loadDashboardCore(session.shop),
    loadDashboardAnalytics(session.shop),
  ]);

  return {
    ...core,
    ...analytics,
    scope: "all",
    ok: core.coreLoaded,
    warnings: [...(core.warnings || []), ...(analytics.warnings || [])],
    error: core.error || "",
  };
};
