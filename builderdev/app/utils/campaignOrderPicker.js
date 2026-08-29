const toArray = (value) => (Array.isArray(value) ? value : []);
const toObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

export function normalizeCampaignOrderQuery(value) {
  return String(value || "").trim();
}

export function buildCampaignOrdersRequestKey({
  sessionKey = 0,
  query = "",
  after = "",
} = {}) {
  return JSON.stringify([
    Math.max(0, Number(sessionKey || 0)),
    normalizeCampaignOrderQuery(query),
    String(after || "").trim(),
  ]);
}

export function resolveCampaignOrdersView({
  data,
  expectedRequestKey,
  fetcherState = "idle",
  searchPending = false,
} = {}) {
  const response = toObject(data);
  const responseMatches =
    String(response.requestKey || "") === String(expectedRequestKey || "");
  const loading =
    searchPending || fetcherState !== "idle" || !responseMatches;

  if (loading) {
    return {
      loading: true,
      error: "",
      orders: [],
      pageInfo: {},
    };
  }

  return {
    loading: false,
    error: response.ok === false ? String(response.error || "Failed to load orders") : "",
    orders: toArray(response.orders).filter(
      (order) => order && String(order.orderGid || "").trim(),
    ),
    pageInfo: toObject(response.pageInfo),
  };
}
