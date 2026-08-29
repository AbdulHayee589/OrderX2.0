import { authenticate } from "../shopify.server";
import { backendGet } from "../server/backend.server";

const toArray = (value) => (Array.isArray(value) ? value : []);
const toObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const response = await backendGet("/api/campaigns/runs", session.shop).catch(
    () => ({ runs: [], summary: {} }),
  );
  return {
    campaignRuns: {
      runs: toArray(toObject(response).runs),
      summary: toObject(response).summary,
    },
  };
};
