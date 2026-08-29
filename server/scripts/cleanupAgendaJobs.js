import dotenv from "dotenv";
import mongoose from "mongoose";

import { cleanupOldAgendaJobs } from "../services/agendaMaintenance.js";

dotenv.config();

async function main() {
  const mongoUri = String(process.env.MONGO_URI || "").trim();
  if (!mongoUri) {
    throw new Error("Missing MONGO_URI");
  }

  await mongoose.connect(mongoUri);

  const dryRun =
    String(process.env.DRY_RUN || "false")
      .trim()
      .toLowerCase() === "true";
  const result = await cleanupOldAgendaJobs({
    dryRun,
    completedAfterDays: Number(process.env.AGENDA_COMPLETED_CLEANUP_DAYS || 7),
    failedAfterDays: Number(process.env.AGENDA_FAILED_CLEANUP_DAYS || 30),
  });

  console.log(JSON.stringify(result, null, 2));
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("[cleanupAgendaJobs]", error?.message || error);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
