import mongoose from "mongoose";
import dotenv from "dotenv";
import { BSON } from "mongodb";

dotenv.config();

function toKb(bytes) {
  const value = Number(bytes || 0);
  return Math.round((value / 1024) * 100) / 100;
}

function fieldSize(value) {
  try {
    return BSON.calculateObjectSize({ value }) - BSON.calculateObjectSize({});
  } catch {
    return 0;
  }
}

function topFieldSizes(doc, limit = 12) {
  if (!doc || typeof doc !== "object") return [];
  return Object.entries(doc)
    .map(([key, value]) => ({
      key,
      bytes: fieldSize(value),
    }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit);
}

async function collectionReport(db, name) {
  const coll = db.collection(name);
  const stats = await db.command({ collStats: name, scale: 1 });
  const sizeAgg = await coll
    .aggregate([
      { $project: { size: { $bsonSize: "$$ROOT" } } },
      {
        $group: {
          _id: null,
          avgDocBytes: { $avg: "$size" },
          maxDocBytes: { $max: "$size" },
          minDocBytes: { $min: "$size" },
          count: { $sum: 1 },
        },
      },
    ])
    .toArray();
  const sampleDoc = await coll.findOne({});
  const indexes = await coll.indexes();

  return {
    name,
    count: stats.count || 0,
    dataBytes: stats.size || 0,
    storageBytes: stats.storageSize || 0,
    avgDocBytes:
      sizeAgg[0]?.avgDocBytes || stats.avgObjSize || 0,
    maxDocBytes: sizeAgg[0]?.maxDocBytes || 0,
    totalIndexBytes: stats.totalIndexSize || 0,
    indexCount: stats.nindexes || indexes.length || 0,
    indexes: indexes.map((index) => ({
      name: index.name,
      key: index.key,
      unique: !!index.unique,
      partialFilterExpression: index.partialFilterExpression || null,
      expireAfterSeconds: index.expireAfterSeconds ?? null,
    })),
    topSampleFields: topFieldSizes(sampleDoc),
  };
}

async function main() {
  if (!process.env.MONGO_URI) {
    throw new Error("Missing MONGO_URI");
  }

  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const collectionNames = (await db.listCollections().toArray())
    .map((row) => row.name)
    .sort();

  const collections = [];
  for (const name of collectionNames) {
    collections.push(await collectionReport(db, name));
  }

  collections.sort((a, b) => b.storageBytes - a.storageBytes);

  const agendaCompletedOlderThan7d = await db.collection("agendaJobs").countDocuments({
    nextRunAt: null,
    lastFinishedAt: {
      $lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    },
  });

  const shopDoc = await db.collection("shops").findOne({});
  const shopTopFields = topFieldSizes(shopDoc, 20);
  const ownSenderTopFields = topFieldSizes(
    shopDoc?.whatsappSender?.ownNumber || {},
    20,
  );

  const report = {
    generatedAt: new Date().toISOString(),
    databaseName: db.databaseName,
    collections: collections.map((row) => ({
      ...row,
      dataKb: toKb(row.dataBytes),
      storageKb: toKb(row.storageBytes),
      avgDocKb: toKb(row.avgDocBytes),
      maxDocKb: toKb(row.maxDocBytes),
      totalIndexKb: toKb(row.totalIndexBytes),
    })),
    agenda: {
      completedOneOffJobsOlderThan7d: agendaCompletedOlderThan7d,
    },
    shops: {
      topFields: shopTopFields.map((row) => ({
        ...row,
        kb: toKb(row.bytes),
      })),
      ownNumberTopFields: ownSenderTopFields.map((row) => ({
        ...row,
        kb: toKb(row.bytes),
      })),
    },
  };

  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("[mongo_storage_report]", error?.message || error);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
