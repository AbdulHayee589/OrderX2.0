import CodAttempt from "../models/CodAttempt.js";
import Shop from "../models/Shop.js";
import { agenda } from "../jobs/agenda.js";
import { appendOrderTag, getAdminClient } from "./shopifyAdmin.js";
import { releaseNextPhoneQueuedAttempt } from "./phoneQueue.js";
import { sendWhatsAppText } from "./whatsapp.js";
import { incrementWhatsAppUsage } from "./usage.js";
import { hasRecentInboundForSender } from "./waSessionWindow.js";

const DEBUG = process.env.DEBUG_ORDERX === "true";
const dbg = (...args) => {
  if (DEBUG) console.log(...args);
};

export async function releaseNextDuplicateAttempt({ sourceAttempt, fromE164 }) {
  const groupId = String(sourceAttempt?.duplicateGroupId || "").trim();
  if (!groupId) return null;

  const releasedAt = new Date();
  const nextAttempt = await CodAttempt.findOneAndUpdate(
    {
      shop: sourceAttempt.shop,
      duplicateGroupId: groupId,
      duplicateRole: "queued",
      stage: "pre_dispatch",
      _id: { $ne: sourceAttempt._id },
      duplicateReleasedAt: null,
      duplicateQueuedAt: { $ne: null },
      status: "scheduled",
      scheduledAt: null,
    },
    {
      $set: {
        duplicateReleasedAt: releasedAt,
        status: "scheduled",
        scheduledAt: releasedAt,
        lastError: null,
        lastErrorAt: null,
        lastErrorMeta: null,
      },
    },
    { new: true, sort: { createdAt: 1 } },
  );

  if (!nextAttempt) {
    dbg("[wa_duplicate_release] none", {
      shop: sourceAttempt.shop,
      duplicateGroupId: groupId,
    });
    return null;
  }

  dbg("[wa_duplicate_release] released", {
    shop: nextAttempt.shop,
    duplicateGroupId: groupId,
    attemptId: nextAttempt._id?.toString?.() || String(nextAttempt._id),
    orderName: nextAttempt.orderName || "",
  });

  const to = String(fromE164 || nextAttempt.phoneE164 || "").trim();
  if (to) {
    const text =
      "We noticed a duplicate order. Please confirm or cancel this second order below.";
    const hasOpenSessionWindow = await hasRecentInboundForSender({
      shop: nextAttempt.shop,
      phoneE164: to,
      senderPhoneNumberId:
        String(nextAttempt.senderPhoneNumberId || "").trim() ||
        String(sourceAttempt?.senderPhoneNumberId || "").trim(),
      senderMode:
        String(nextAttempt.senderMode || "").trim() ||
        String(sourceAttempt?.senderMode || "").trim(),
      withinHours: 23,
    }).catch(() => false);
    if (hasOpenSessionWindow) {
      try {
        await sendWhatsAppText({
          to,
          text,
          shop: nextAttempt.shop,
          kind: "duplicate_prompt_followup",
          attemptId: nextAttempt._id,
          orderGid: nextAttempt.orderGid,
          meta: { source: "queue_release" },
        });
        await incrementWhatsAppUsage(nextAttempt.shop, 1);
        nextAttempt.duplicatePromptSentAt = new Date();
        await nextAttempt.save();
      } catch (e) {
        console.error(
          "[wa_duplicate_prompt]",
          nextAttempt.shop,
          e?.message || e,
        );
      }
    } else {
      dbg("[wa_duplicate_release] skipped freeform duplicate prompt", {
        shop: nextAttempt.shop,
        attemptId: nextAttempt._id?.toString?.() || String(nextAttempt._id),
        reason: "no_open_session_window",
      });
    }
  }

  try {
    const shopRecord = await Shop.findOne({ shop: nextAttempt.shop }).lean();
    if (shopRecord && nextAttempt.orderGid) {
      const admin = await getAdminClient(
        nextAttempt.shop,
        {
          accessToken: shopRecord.accessToken || "",
          record: shopRecord,
        },
      );
      await appendOrderTag(
        admin,
        nextAttempt.orderGid,
        "DUPLICATE_FOLLOWUP_SENT 🔁",
      );
    }
  } catch (e) {
    console.error("[wa_duplicate_tag]", nextAttempt.shop, e?.message || e);
  }

  await agenda.schedule(new Date(), "attempt_cod_confirmation", {
    attemptId: nextAttempt._id.toString(),
  });

  dbg("[wa_duplicate_release] scheduled", {
    shop: nextAttempt.shop,
    attemptId: nextAttempt._id.toString(),
  });

  return nextAttempt;
}

export async function releaseQueuesAfterAttemptResolved({
  sourceAttempt,
  fromE164,
  context = "unknown",
}) {
  if (!sourceAttempt?._id) return { duplicateAttempt: null, phoneAttempt: null };

  let duplicateAttempt = null;
  let phoneAttempt = null;

  try {
    duplicateAttempt = await releaseNextDuplicateAttempt({
      sourceAttempt,
      fromE164,
    });
  } catch (e) {
    console.error(
      "[queue_release_duplicate]",
      context,
      sourceAttempt?.shop || "",
      sourceAttempt?._id?.toString?.() || "",
      e?.message || e,
    );
  }

  try {
    phoneAttempt = await releaseNextPhoneQueuedAttempt({ sourceAttempt });
  } catch (e) {
    console.error(
      "[queue_release_phone]",
      context,
      sourceAttempt?.shop || "",
      sourceAttempt?._id?.toString?.() || "",
      e?.message || e,
    );
  }

  return { duplicateAttempt, phoneAttempt };
}
