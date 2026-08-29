import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { backendGet } from "../server/backend.server";

const toArray = (value) => (Array.isArray(value) ? value : []);
const toObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);

  const q = String(url.searchParams.get("q") || "").trim();
  const after = String(url.searchParams.get("after") || "").trim();
  const requestKey = String(url.searchParams.get("requestKey") || "").trim();
  const first = Math.min(
    Math.max(Number.parseInt(String(url.searchParams.get("first") || "10"), 10) || 10, 1),
    50,
  );

  const params = new URLSearchParams();
  params.set("first", String(first));
  if (q) params.set("q", q);
  if (after) params.set("after", after);

  const payload = await backendGet(`/api/shopify/orders?${params.toString()}`, shop).catch(
    (error) => ({
      ok: false,
      error: error?.message || "Failed to load orders",
      orders: [],
      pageInfo: {},
      query: q,
    }),
  );

  const data = toObject(payload);

  return {
    ok: data.ok !== false,
    error: data.error || null,
    orders: toArray(data.orders),
    pageInfo: toObject(data.pageInfo),
    query: String(data.query || q || ""),
    requestKey,
    first,
    after: after || null,
  };
};

export default function AttemptsOrdersResource() {
  return null;
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
