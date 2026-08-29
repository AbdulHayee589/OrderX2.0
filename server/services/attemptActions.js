import CodAttempt from "../models/CodAttempt.js";
import Shop from "../models/Shop.js";
import Metric from "../models/Metric.js";
import {
  getAdminClient,
  appendOrderTag,
  applyRequestedChangesToOrder,
  removeOrderTags,
} from "../services/shopifyAdmin.js";

const CONFIRMATION_SENT_TAG = "CONFIRMATION_SENT📩";

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
    return { ok: true, alreadyDone: true, status: existing.status };
  }

  const shopRecord = await loadShopRecord(attempt.shop);
  const admin = await getAdminClient(attempt.shop, {
    accessToken: shopRecord.accessToken || "",
    record: shopRecord,
  });

  // Optional merchant setting: apply confirmed Request Changes directly on Shopify order.
  if (
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

  if (attempt.stage === "post_failed_delivery") {
    // Keep the original tag + add an explicit redelivery tag for this stage.
    await appendOrderTag(admin, attempt.orderGid, "ORDER_CONFIRMED✅");
    await appendOrderTag(admin, attempt.orderGid, "cod_redeliver");
  } else {
    await appendOrderTag(admin, attempt.orderGid, "ORDER_CONFIRMED✅");
  }
  await removeOrderTags(admin, attempt.orderGid, [CONFIRMATION_SENT_TAG]).catch(
    (error) => {
      console.error(
        "[confirm_remove_confirmation_sent_tag]",
        attempt.shop,
        attempt.orderGid,
        error?.message || error,
      );
    },
  );

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

  return { ok: true };
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
    return { ok: true, alreadyDone: true, status: existing.status };
  }

  const shopRecord = await loadShopRecord(attempt.shop);
  const admin = await getAdminClient(attempt.shop, {
    accessToken: shopRecord.accessToken || "",
    record: shopRecord,
  });

  await appendOrderTag(admin, attempt.orderGid, "ORDER_CANCELLED❌");
  await removeOrderTags(admin, attempt.orderGid, [CONFIRMATION_SENT_TAG]).catch(
    (error) => {
      console.error(
        "[cancel_remove_confirmation_sent_tag]",
        attempt.shop,
        attempt.orderGid,
        error?.message || error,
      );
    },
  );

  return { ok: true };
}
