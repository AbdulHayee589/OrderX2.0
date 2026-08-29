/* global globalThis */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPaths = [
  path.resolve(__dirname, "../.env"),
  path.resolve(__dirname, ".env"),
  path.resolve(__dirname, "../../server/.env"),
];

const reloadLocalEnv = process.env.NODE_ENV !== "production";

if (!globalThis.__orderxBuilderEnvLoaded || reloadLocalEnv) {
  for (const [index, envPath] of envPaths.entries()) {
    dotenv.config({
      path: envPath,
      // During app dev, make edits to builderdev/.env effective after an HMR
      // reload. Never override platform-provided environment values in prod.
      override: reloadLocalEnv && index === 0,
    });
  }
  globalThis.__orderxBuilderEnvLoaded = true;
}

export { envPaths };
