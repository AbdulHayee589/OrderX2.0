import CodAttempt from "../models/CodAttempt.js";
import Shop from "../models/Shop.js";
import Metric from "../models/Metric.js";
import {
  getAdminClient,
  appendOrderTags,
  applyRequestedChangesToOrder,
  removeOrderTags,
} from "../services/shopifyAdmin.js";

const CONFIRMATION_SENT_TAG = "CONFIRMATION_SENT📩";
const ORDER_CONFIRMED_TAG = "ORDER_CONFIRMED✅";
const ORDER_CANCELLED_TAG = "ORDER_CANCELLED❌";

async function loadShopRecord(shop) {
  const record = await Shop.findOne({ shop }).lean();
  if (!record) throw new Error("Shop not installed");
  return record;
}

function dayKey(d = new Date()) {
  return new Date(d).toISOString().slice(0, 10);
}

async function recordSavedOrder(shop, amount) {
  const today = dayKey();
  const inc = {
    savedOrders: 1,
  };

  const a = Number(amount);
  if (Number.isFinite(a) && a > 0) {
    inc.savedRevenue = a;
  }

  await Metric.updateOne({ shop, day: today }, { $inc: inc }, { upsert: true });
}

function outcomeTagsForAttempt(attempt) {
  if (String(attempt?.status || "").trim() === "confirmed") {
    return attempt?.stage === "post_failed_delivery"
      ? [ORDER_CONFIRMED_TAG, "cod_redeliver"]
      : [ORDER_CONFIRMED_TAG];
  }
  if (String(attempt?.status || "").trim() === "cancelled") {
    return [ORDER_CANCELLED_TAG];
  }
  return [];
}

export async function syncAttemptOutcomeTags(
  attemptOrId,
  { shopRecord = null, admin = null, throwOnError = false } = {},
) {
  const attempt =
    attemptOrId && typeof attemptOrId === "object"
      ? attemptOrId
      : await CodAttempt.findById(attemptOrId).lean();
  if (!attempt?._id) return { ok: false, skipped: "attempt_not_found" };

  const tags = outcomeTagsForAttempt(attempt);
  if (!tags.length || !attempt.orderGid) {
    return { ok: false, skipped: "outcome_not_tag_eligible" };
  }

  const attemptedAt = new Date();
  try {
    const resolvedShopRecord = shopRecord || (await loadShopRecord(attempt.shop));
    const resolvedAdmin =
      admin ||
      (await getAdminClient(attempt.shop, {
        accessToken: resolvedShopRecord.accessToken || "",
        record: resolvedShopRecord,
      }));

    // Shopify's tagsAdd/tagsRemove mutations are idempotent and do not replace
    // unrelated merchant tags. This also makes retries safe after a transient
    // Admin API/token failure.
    await appendOrderTags(resolvedAdmin, attempt.orderGid, tags);
    await removeOrderTags(resolvedAdmin, attempt.orderGid, [
      CONFIRMATION_SENT_TAG,
    ]);
    await CodAttempt.updateOne(
      { _id: attempt._id },
      {
        $set: {
          outcomeTagSyncedAt: new Date(),
          outcomeTagLastAttemptAt: attemptedAt,
          outcomeTagLastError: null,
        },
      },
    );
    return { ok: true, tags };
  } catch (error) {
    const message = String(error?.message || error || "Tag sync failed").slice(
      0,
      500,
    );
    await CodAttempt.updateOne(
      { _id: attempt._id },
      {
        $set: {
          outcomeTagLastAttemptAt: attemptedAt,
          outcomeTagLastError: message,
        },
      },
    ).catch(() => null);
    console.error("[attempt_outcome_tag_sync]", {
      shop: attempt.shop,
      orderGid: attempt.orderGid,
      attemptId: attempt._id?.toString?.() || String(attempt._id),
      status: attempt.status,
      message,
    });
    if (throwOnError) throw error;
    return { ok: false, error: message };
  }
}

export async function confirmAttempt(attemptId, source = "unknown") {
  // ✅ Atomic: only move to confirmed if not already terminal
  const attempt = await CodAttempt.findOneAndUpdate(
    {
      _id: attemptId,
      status: { $nin: ["confirmed", "cancelled", "expired"] },
    },
    {
      $set: {
        status: "confirmed",
        confirmedAt: new Date(),
        confirmSource: source,
        processedAt: new Date(),
      },
    },
    { new: true },
  );

  // If null, it was already processed or doesn't exist
  if (!attempt) {
    const existing = await CodAttempt.findById(attemptId).lean();
    if (!existing) throw new Error("Attempt not found");
    const tagSync = await syncAttemptOutcomeTags(existing);
    return {
      ok: true,
      alreadyDone: true,
      status: existing.status,
      tagSync,
    };
  }

  const shopRecord = await loadShopRecord(attempt.shop).catch((error) => {
    console.error(
      "[confirm_load_shop]",
      attempt.shop,
      error?.message || error,
    );
    return null;
  });
  const admin = shopRecord
    ? await getAdminClient(attempt.shop, {
        accessToken: shopRecord.accessToken || "",
        record: shopRecord,
      }).catch((error) => {
        console.error(
          "[confirm_admin_client]",
          attempt.shop,
          error?.message || error,
        );
        return null;
      })
    : null;

  // Optional merchant setting: apply confirmed Request Changes directly on Shopify order.
  if (
    admin &&
    shopRecord?.settings?.applyRequestedChangesToOrder === true &&
    (attempt.changeProposedName ||
      attempt.changeProposedAddress ||
      Number(attempt.changeProposedQuantity) > 0 ||
      (Array.isArray(attempt.changeProposedQuantityOverrides) &&
        attempt.changeProposedQuantityOverrides.length > 0))
  ) {
    try {
      const applyResult = await applyRequestedChangesToOrder(
        admin,
        attempt.orderGid,
        {
          name: attempt.changeProposedName,
          address: attempt.changeProposedAddress,
          quantity: attempt.changeProposedQuantity,
          quantityLineIndex: attempt.changeProposedQuantityLineIndex,
          quantityOverrides: attempt.changeProposedQuantityOverrides,
        },
      );
      if (applyResult?.appliedFields?.length) {
        console.log("[apply_requested_changes]", attempt.shop, {
          orderGid: attempt.orderGid,
          attemptId: attempt._id?.toString?.() || String(attempt._id || ""),
          appliedFields: applyResult.appliedFields,
          warnings: applyResult.warnings || [],
        });
      }
    } catch (e) {
      // Do not block confirmation if Shopify rejects the edit (e.g. fulfilled/locked order).
      console.error(
        "[apply_requested_changes_failed]",
        attempt.shop,
        attempt.orderGid,
        e?.message || e,
      );
    }
  }

  const tagSync = await syncAttemptOutcomeTags(attempt, {
    shopRecord,
    admin,
  });

  // ✅ Analytics: track saved orders & revenue (no extra cost)
  try {
    // Avoid double-counting "saved orders" for failed-delivery re-confirmations.
    if (attempt.stage !== "post_failed_delivery") {
      await recordSavedOrder(attempt.shop, attempt.orderAmount);
    }
  } catch (e) {
    // don't block confirmation if metrics update fails
    console.error("[recordSavedOrder]", attempt.shop, e?.message || e);
  }

  return { ok: true, tagSync };
}

export async function cancelAttempt(attemptId, source = "unknown") {
  // ✅ Atomic: only move to cancelled if not already terminal
  const attempt = await CodAttempt.findOneAndUpdate(
    {
      _id: attemptId,
      status: { $nin: ["confirmed", "cancelled", "expired"] },
    },
    {
      $set: {
        status: "cancelled",
        cancelledAt: new Date(),
        cancelSource: source,
        processedAt: new Date(),
      },
    },
    { new: true },
  );

  if (!attempt) {
    const existing = await CodAttempt.findById(attemptId).lean();
    if (!existing) throw new Error("Attempt not found");
    const tagSync = await syncAttemptOutcomeTags(existing);
    return {
      ok: true,
      alreadyDone: true,
      status: existing.status,
      tagSync,
    };
  }

  const shopRecord = await loadShopRecord(attempt.shop).catch((error) => {
    console.error(
      "[cancel_load_shop]",
      attempt.shop,
      error?.message || error,
    );
    return null;
  });
  const admin = shopRecord
    ? await getAdminClient(attempt.shop, {
        accessToken: shopRecord.accessToken || "",
        record: shopRecord,
      }).catch((error) => {
        console.error(
          "[cancel_admin_client]",
          attempt.shop,
          error?.message || error,
        );
        return null;
      })
    : null;

  const tagSync = await syncAttemptOutcomeTags(attempt, {
    shopRecord,
    admin,
  });

  return { ok: true, tagSync };
}
