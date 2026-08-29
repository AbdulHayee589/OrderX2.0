import mongoose from "mongoose";

function oneOffJobFilter(extra = {}) {
  return {
    $and: [
      {
        $or: [
          { repeatInterval: { $exists: false } },
          { repeatInterval: null },
          { repeatInterval: "" },
        ],
      },
      {
        $or: [
          { repeatTimezone: { $exists: false } },
          { repeatTimezone: null },
          { repeatTimezone: "" },
        ],
      },
      extra,
    ],
  };
}

export async function cleanupOldAgendaJobs(options = {}) {
  const db = mongoose.connection?.db;
  if (!db) {
    throw new Error("Mongo connection is not ready for agenda cleanup");
  }

  const collection = db.collection("agendaJobs");
  const now = Date.now();
  const completedAfterDays = Math.max(
    1,
    Number(options.completedAfterDays || 7) || 7,
  );
  const failedAfterDays = Math.max(
    3,
    Number(options.failedAfterDays || 30) || 30,
  );
  const completedCutoff = new Date(now - completedAfterDays * 24 * 60 * 60 * 1000);
  const failedCutoff = new Date(now - failedAfterDays * 24 * 60 * 60 * 1000);

  const completedFilter = oneOffJobFilter({
    nextRunAt: null,
    lockedAt: null,
    lastFinishedAt: { $lt: completedCutoff },
  });
  const failedFilter = oneOffJobFilter({
    nextRunAt: null,
    lockedAt: null,
    failedAt: { $lt: failedCutoff },
  });

  const [completedCount, failedCount] = await Promise.all([
    collection.countDocuments(completedFilter),
    collection.countDocuments(failedFilter),
  ]);

  if (options.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      completedCount,
      failedCount,
      completedAfterDays,
      failedAfterDays,
    };
  }

  const [completedResult, failedResult] = await Promise.all([
    collection.deleteMany(completedFilter),
    collection.deleteMany(failedFilter),
  ]);

  return {
    ok: true,
    dryRun: false,
    completedCount,
    failedCount,
    deletedCompleted: Number(completedResult.deletedCount || 0),
    deletedFailed: Number(failedResult.deletedCount || 0),
    completedAfterDays,
    failedAfterDays,
  };
}
