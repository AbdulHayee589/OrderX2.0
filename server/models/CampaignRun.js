import mongoose from "mongoose";

const CampaignRunSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: [
        "scheduled",
        "processing",
        "completed",
        "completed_with_failures",
        "failed",
      ],
      default: "scheduled",
      index: true,
    },
    scheduleMode: {
      type: String,
      enum: ["immediate", "scheduled"],
      default: "immediate",
    },
    scheduledFor: { type: Date, default: null, index: true },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    templateId: { type: String, default: "", index: true },
    templateDisplayName: { type: String, default: "" },
    templateMetaTemplateName: { type: String, default: "" },
    templateLanguage: { type: String, default: "en" },
    templateCategory: { type: String, default: "UTILITY" },
    templateSource: { type: String, default: "merchant_custom" },
    templateSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    recipientPhoneClaims: {
      type: [
        {
          _id: false,
          phoneKey: { type: String, required: true },
          recipientId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "CampaignRecipient",
            required: true,
          },
          claimedAt: { type: Date, required: true },
        },
      ],
      default: [],
      select: false,
    },
    totalRecipients: { type: Number, default: 0 },
    orderRecipientCount: { type: Number, default: 0 },
    customRecipientCount: { type: Number, default: 0 },
    sentCount: { type: Number, default: 0 },
    deliveredCount: { type: Number, default: 0 },
    readCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    skippedCount: { type: Number, default: 0 },
    pendingCount: { type: Number, default: 0 },
    successRate: { type: Number, default: 0 },
    deliveryRate: { type: Number, default: 0 },
    failureRate: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    lastErrorAt: { type: Date, default: null },
  },
  { timestamps: true },
);

CampaignRunSchema.index({ shop: 1, createdAt: -1 });
CampaignRunSchema.index({ shop: 1, status: 1, scheduledFor: 1 });

export default mongoose.model("CampaignRun", CampaignRunSchema);
