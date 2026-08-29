import mongoose from "mongoose";

const CampaignRecipientSchema = new mongoose.Schema(
  {
    campaignRunId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CampaignRun",
      required: true,
      index: true,
    },
    shop: { type: String, required: true, index: true },
    recipientType: {
      type: String,
      enum: ["order", "custom"],
      default: "order",
      index: true,
    },
    orderGid: { type: String, default: null, index: true },
    orderName: { type: String, default: "" },
    customerName: { type: String, default: "" },
    toE164: { type: String, default: "", index: true },
    status: {
      type: String,
      enum: ["pending", "processing", "sent", "failed", "skipped"],
      default: "pending",
      index: true,
    },
    waMessageId: { type: String, default: null },
    sentAt: { type: Date, default: null },
    deliveryStatus: {
      type: String,
      enum: ["accepted", "sent", "delivered", "read", "failed"],
      default: null,
      index: true,
    },
    deliveryStatusAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    deliveryError: { type: String, default: null },
    deliveryErrorMeta: { type: mongoose.Schema.Types.Mixed, default: null },
    lastTriedAt: { type: Date, default: null },
    retryCount: { type: Number, default: 0 },
    failureCode: { type: String, default: null },
    failureReason: { type: String, default: null },
    failureRetryable: { type: Boolean, default: false },
    errorMessage: { type: String, default: null },
    errorMeta: { type: mongoose.Schema.Types.Mixed, default: null },
    duplicateOfRecipientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CampaignRecipient",
      default: null,
    },
  },
  { timestamps: true },
);

CampaignRecipientSchema.index({ campaignRunId: 1, createdAt: 1 });
CampaignRecipientSchema.index({ campaignRunId: 1, status: 1, createdAt: 1 });
CampaignRecipientSchema.index({ campaignRunId: 1, toE164: 1, createdAt: 1 });
CampaignRecipientSchema.index({ shop: 1, status: 1, createdAt: -1 });
CampaignRecipientSchema.index({ shop: 1, waMessageId: 1 }, { sparse: true });

export default mongoose.model("CampaignRecipient", CampaignRecipientSchema);
