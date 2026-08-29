import { useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { backendGet } from "../server/backend.server";

const toObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const response = toObject(
    await backendGet("/api/templates?refresh=1", session.shop).catch(() => ({
      templateSystem: {},
      statusRefresh: { refreshed: false, reason: "refresh_failed" },
    })),
  );
  return {
    ok: true,
    templateSystem: toObject(response.templateSystem),
    statusRefresh: toObject(response.statusRefresh),
  };
};

export const headers = (headersArgs) => boundary.headers(headersArgs);
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
