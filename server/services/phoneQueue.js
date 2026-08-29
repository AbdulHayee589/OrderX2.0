import Shop from "../models/Shop.js";
import CodAttempt from "../models/CodAttempt.js";
import { agenda } from "../jobs/agenda.js";
import { nextAllowedTimeUTC } from "./timezone.js";

const DEBUG = process.env.DEBUG_ORDERX === "true";
const dbg = (...args) => {
  if (DEBUG) console.log(...args);
};

export async function releaseNextPhoneQueuedAttempt({ sourceAttempt }) {
  const groupId = String(sourceAttempt?.phoneQueueGroupId || "").trim();
  if (!groupId) return null;

  const shop = sourceAttempt.shop;
  if (!shop) return null;

  const shopRecord = await Shop.findOne({ shop }).lean();
  if (!shopRecord) return null;

  const startHour = Number(shopRecord.settings?.workStartHour ?? 9);
  const endHour = Number(shopRecord.settings?.workEndHour ?? 21);
  const tz = String(sourceAttempt.timezone || "UTC");
  const scheduledAt = nextAllowedTimeUTC(tz, 0, startHour, endHour);

  const releasedAt = new Date();
  const nextAttempt = await CodAttempt.findOneAndUpdate(
    {
      shop,
      phoneQueueGroupId: groupId,
      phoneQueueRole: "queued",
      duplicateRole: { $ne: "queued" },
      _id: { $ne: sourceAttempt._id },
      status: "scheduled",
      scheduledAt: null,
    },
    {
      $set: {
        phoneReleasedAt: releasedAt,
        phoneQueueRole: "primary",
        status: "scheduled",
        scheduledAt,
        lastError: null,
        lastErrorAt: null,
        lastErrorMeta: null,
      },
    },
    { new: true, sort: { createdAt: 1 } },
  );

  if (!nextAttempt) {
    dbg("[phone_queue_release] none", { shop, groupId });
    return null;
  }

  await agenda.schedule(scheduledAt, "attempt_cod_confirmation", {
    attemptId: nextAttempt._id.toString(),
  });

  dbg("[phone_queue_release] scheduled", {
    shop,
    groupId,
    attemptId: nextAttempt._id.toString(),
    scheduledAt: scheduledAt?.toISOString?.() || String(scheduledAt),
  });

  return nextAttempt;
}
