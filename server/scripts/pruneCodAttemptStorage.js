import dotenv from "dotenv";
import mongoose from "mongoose";

import { buildCodAttemptPruneUpdate } from "../services/storageSanitizer.js";

dotenv.config();

async function main() {
  const mongoUri = String(process.env.MONGO_URI || "").trim();
  if (!mongoUri) {
    throw new Error("Missing MONGO_URI");
  }

  await mongoose.connect(mongoUri);
  const db = mongoose.connection.db;
  const collection = db.collection("codattempts");

  const dryRun =
    String(process.env.DRY_RUN || "false")
      .trim()
      .toLowerCase() === "true";
  const minDocBytes = Math.max(
    2048,
    Number(process.env.COD_ATTEMPT_MIN_DOC_BYTES || 16 * 1024) || 16 * 1024,
  );
  const limit = Math.max(
    1,
    Number(process.env.COD_ATTEMPT_PRUNE_LIMIT || 5000) || 5000,
  );

  const targets = await collection
    .aggregate([
      { $project: { _id: 1, size: { $bsonSize: "$$ROOT" } } },
      { $match: { size: { $gte: minDocBytes } } },
      { $sort: { size: -1 } },
      { $limit: limit },
    ])
    .toArray();

  let candidates = 0;
  let changed = 0;
  let estimatedBytesBefore = 0;
  let estimatedBytesAfter = 0;
  const ops = [];

  const sizeById = new Map(
    targets.map((row) => [String(row._id), Number(row.size || 0)]),
  );
  const batchSize = 250;

  for (let index = 0; index < targets.length; index += batchSize) {
    const batchIds = targets.slice(index, index + batchSize).map((row) => row._id);
    const docs = await collection.find({ _id: { $in: batchIds } }).toArray();

    for (const doc of docs) {
      const beforeBytes = sizeById.get(String(doc._id)) || 0;
      candidates += 1;
      estimatedBytesBefore += beforeBytes;

      const { changed: isChanged, update } = buildCodAttemptPruneUpdate(doc);
      if (!isChanged || !update) {
        estimatedBytesAfter += beforeBytes;
        continue;
      }

      changed += 1;
      estimatedBytesAfter += Math.max(1024, beforeBytes * 0.1);
      if (!dryRun) {
        ops.push({
          updateOne: {
            filter: { _id: doc._id },
            update,
          },
        });
      }
    }
  }

  let modifiedCount = 0;
  if (!dryRun && ops.length) {
    const result = await collection.bulkWrite(ops, { ordered: false });
    modifiedCount = Number(result.modifiedCount || 0);
  }

  console.log(
    JSON.stringify(
      {
        dryRun,
        minDocBytes,
        limit,
        candidates,
        changed,
        modifiedCount,
        estimatedMbBefore: Number((estimatedBytesBefore / 1024 / 1024).toFixed(2)),
        estimatedMbAfter: Number((estimatedBytesAfter / 1024 / 1024).toFixed(2)),
        estimatedMbSaved: Number(
          Math.max(0, estimatedBytesBefore - estimatedBytesAfter) /
            1024 /
            1024,
        ).toFixed(2),
      },
      null,
      2,
    ),
  );

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("[pruneCodAttemptStorage]", error?.message || error);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
