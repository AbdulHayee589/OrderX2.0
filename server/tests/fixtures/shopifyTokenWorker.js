import mongoose from "mongoose";

const mode = String(process.argv[2] || "refresh");
const shop = String(process.argv[3] || "");

if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/orderx_token_test/.test(process.env.MONGO_URI || "")) {
  throw new Error("Token worker refuses to use a non-test MongoDB URI.");
}

await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
try {
  const { shopify } = await import("../../shopify.js");
  const {
    ensureValidShopOfflineAccessToken,
    getShopifyTokenSnapshot,
  } = await import("../../services/shopifyTokenService.js");

  if (mode === "snapshot") {
    const snapshot = await getShopifyTokenSnapshot(shop);
    process.stdout.write(
      `__TOKEN_TEST_RESULT__${JSON.stringify({
        ok: true,
        source: snapshot?.preferred?.source || null,
        hasAccessToken: !!snapshot?.preferred?.accessToken,
        hasRefreshToken: !!snapshot?.preferred?.refreshToken,
      })}`,
    );
  } else {
    shopify.auth.refreshToken = async () => {
      await mongoose.connection.db.collection("tokenTestCounters").updateOne(
        { _id: shop },
        { $inc: { refreshes: 1 } },
        { upsert: true },
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      const { Session } = await import("@shopify/shopify-api");
      return {
        session: new Session({
          id: shopify.session.getOfflineId(shop),
          shop,
          state: "",
          isOnline: false,
          scope: "read_orders",
          accessToken: "distributed-new-access",
          expires: new Date(Date.now() + 3_600_000),
          refreshToken: "distributed-new-refresh",
          refreshTokenExpires: new Date(Date.now() + 30 * 86_400_000),
        }),
      };
    };
    const state = await ensureValidShopOfflineAccessToken(shop);
    process.stdout.write(
      `__TOKEN_TEST_RESULT__${JSON.stringify({
        ok: true,
        refreshed: state?.refreshed === true,
      })}`,
    );
  }
} finally {
  await mongoose.disconnect();
}
