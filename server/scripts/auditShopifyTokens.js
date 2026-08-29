import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config({ path: new URL("../.env", import.meta.url) });

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const [key, ...rest] = raw.slice(2).split("=");
    if (rest.length) values.set(key, rest.join("="));
    else flags.add(key);
  }
  return { values, flags };
}

const { values, flags } = parseArgs(process.argv.slice(2));
const shops = String(values.get("shop") || "")
  .split(",")
  .map((shop) => shop.trim().toLowerCase())
  .filter(Boolean);
const limit = Math.max(1, Number(values.get("limit") || 500));
const apply = flags.has("apply");
const confirmation = String(values.get("confirm") || "");

if (apply && confirmation !== "I_UNDERSTAND_THIS_ROTATES_SHOPIFY_TOKENS") {
  console.error(
    "Refusing --apply. Add --confirm=I_UNDERSTAND_THIS_ROTATES_SHOPIFY_TOKENS and an explicit --shop list.",
  );
  process.exit(2);
}
if (apply && shops.length === 0) {
  console.error("Refusing --apply without at least one explicit --shop value.");
  process.exit(2);
}

if (!process.env.MONGO_URI) {
  console.error("Missing MONGO_URI.");
  process.exit(2);
}

try {
  // Dry-run must not create indexes or mutate application records.
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
  const {
    auditShopifyTokens,
    migrateLegacyOfflineTokensBatch,
  } = await import("../services/shopifyTokenService.js");

  const report = apply
    ? await migrateLegacyOfflineTokensBatch({
        shops,
        limit,
        dryRun: false,
      })
    : await auditShopifyTokens({ shops, limit });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        dryRun: !apply,
        error: String(error?.message || error).slice(0, 500),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => null);
}
