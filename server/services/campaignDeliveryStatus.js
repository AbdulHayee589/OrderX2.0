import CampaignRecipient from "../models/CampaignRecipient.js";
import CampaignRun from "../models/CampaignRun.js";
import WaMessageLog from "../models/WaMessageLog.js";
import {
  buildCampaignRunSummary,
  classifyCampaignSendFailure,
} from "./campaignSendPolicy.js";

function asText(value) {
  return String(value || "").trim();
}

function cleanDeliveryErrors(errors = []) {
  return (Array.isArray(errors) ? errors : [])
    .slice(0, 3)
    .map((row) => ({
      code: Number(row?.code || 0) || null,
      title: asText(row?.title || row?.message).slice(0, 300) || null,
      details:
        asText(row?.error_data?.details).slice(0, 500) || null,
    }));
}

async function refreshDeliveryRunSummary(runId, lastError = "") {
  const run = await CampaignRun.findById(runId).lean();
  if (!run) return null;
  const recipients = await CampaignRecipient.find({ campaignRunId: runId })
    .select({ status: 1, deliveryStatus: 1 })
    .lean();
  const summary = buildCampaignRunSummary(run, recipients);
  await CampaignRun.updateOne(
    { _id: runId },
    {
      $set: {
        ...summary,
        ...(lastError
          ? { lastError: asText(lastError).slice(0, 500), lastErrorAt: new Date() }
          : {}),
      },
    },
  );
  return summary;
}

export async function reconcileCampaignDeliveryStatus({
  shop,
  waMessageId,
  status,
  statusAt = new Date(),
  errorText = "",
  errors = [],
} = {}) {
  const shopDomain = asText(shop);
  const messageId = asText(waMessageId);
  const incomingStatus = asText(status).toLowerCase();
  if (
    !shopDomain ||
    !messageId ||
    !["sent", "delivered", "read", "failed"].includes(incomingStatus)
  ) {
    return { matched: false, updated: false };
  }

  const recipient = await CampaignRecipient.findOne({
    shop: shopDomain,
    waMessageId: messageId,
  })
    .select({
      _id: 1,
      campaignRunId: 1,
      deliveryStatus: 1,
      deliveredAt: 1,
      status: 1,
    })
    .lean();
  if (!recipient) return { matched: false, updated: false };

  const statusDate =
    statusAt instanceof Date && Number.isFinite(statusAt.getTime())
      ? statusAt
      : new Date();
  const blockedPreviousStatuses =
    incomingStatus === "read"
      ? ["read", "failed"]
      : incomingStatus === "delivered"
        ? ["delivered", "read", "failed"]
        : incomingStatus === "failed"
          ? ["delivered", "read", "failed"]
          : ["sent", "delivered", "read", "failed"];
  const query = {
    _id: recipient._id,
    deliveryStatus: { $nin: blockedPreviousStatuses },
  };
  const setFields = {
    deliveryStatus: incomingStatus,
    deliveryStatusAt: statusDate,
  };

  if (incomingStatus === "delivered") {
    setFields.deliveredAt = statusDate;
    setFields.deliveryError = null;
    setFields.deliveryErrorMeta = null;
  } else if (incomingStatus === "read") {
    setFields.deliveredAt = recipient?.deliveredAt || statusDate;
    setFields.readAt = statusDate;
    setFields.deliveryError = null;
    setFields.deliveryErrorMeta = null;
  } else if (incomingStatus === "failed") {
    const safeErrors = cleanDeliveryErrors(errors);
    const firstError = Array.isArray(errors) ? errors[0] || null : null;
    const failure = classifyCampaignSendFailure({
      message:
        asText(errorText) ||
        asText(firstError?.title || firstError?.error_data?.details) ||
        "WhatsApp delivery failed after Meta accepted the message",
      httpStatus: 400,
      meta: firstError ? { error: firstError } : null,
    });
    setFields.status = "failed";
    setFields.deliveryError = failure.message;
    setFields.deliveryErrorMeta = safeErrors.length
      ? { errors: safeErrors }
      : null;
    setFields.failureCode =
      failure.code === "meta_client_error"
        ? "meta_delivery_failed"
        : failure.code;
    setFields.failureReason =
      failure.label === "Meta rejected the message"
        ? "Delivery failed"
        : failure.label;
    setFields.failureRetryable = failure.retryable;
    setFields.errorMessage = failure.message;
    setFields.errorMeta = failure.meta;
  }

  const updated = await CampaignRecipient.findOneAndUpdate(
    query,
    { $set: setFields },
    { returnDocument: "after" },
  ).lean();
  if (!updated) return { matched: true, updated: false };

  await refreshDeliveryRunSummary(
    recipient.campaignRunId,
    incomingStatus === "failed" ? updated.deliveryError : "",
  );
  return {
    matched: true,
    updated: true,
    campaignRunId: String(recipient.campaignRunId || ""),
    campaignRecipientId: String(recipient._id || ""),
    status: updated.status,
    deliveryStatus: updated.deliveryStatus,
  };
}

export async function reconcileCampaignDeliveryFromLog({
  shop,
  waMessageId,
} = {}) {
  const shopDomain = asText(shop);
  const messageId = asText(waMessageId);
  if (!shopDomain || !messageId) return { matched: false, updated: false };
  const log = await WaMessageLog.findOne({
    shop: shopDomain,
    waMessageId: messageId,
  })
    .select({
      "meta.deliveryStatus": 1,
      "meta.deliveryStatusAt": 1,
      "meta.deliveryError": 1,
    })
    .lean();
  const deliveryStatus = asText(log?.meta?.deliveryStatus).toLowerCase();
  if (!deliveryStatus) return { matched: false, updated: false };
  return reconcileCampaignDeliveryStatus({
    shop: shopDomain,
    waMessageId: messageId,
    status: deliveryStatus,
    statusAt: log?.meta?.deliveryStatusAt || new Date(),
    errorText: log?.meta?.deliveryError || "",
  });
}
