import mongoose from "mongoose";

const BillingUsageChargeSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true, required: true },
    planKey: { type: String, required: true },
    subscriptionId: { type: String, default: null },
    subscriptionLineItemId: { type: String, required: true },
    billingCycleId: { type: String, required: true, index: true },
    billingCycleStartedAt: { type: Date, default: null },
    billingCycleEndsAt: { type: Date, default: null },
    waMessageId: { type: String, required: true },
    attemptId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CodAttempt",
      default: null,
    },
    orderGid: { type: String, default: null },
    quantity: { type: Number, default: 1 },
    amount: { type: Number, required: true },
    pricingBasisUsd: { type: Number, default: null },
    currencyCode: { type: String, required: true },
    recipientCountryCode: { type: String, default: null, index: true },
    storeCountryCode: { type: String, default: null, index: true },
    crossBorderRateApplied: { type: Boolean, default: false },
    capUnitsConsumed: { type: Number, default: 1 },
    billingStrategy: {
      type: String,
      enum: ["per_message", "threshold_batch", "pakistan_threshold_batch"],
      default: "per_message",
      index: true,
    },
    batchGroupKey: { type: String, default: null, index: true },
    carryBeforeUsd: { type: Number, default: null },
    carryAfterUsd: { type: Number, default: null },
    settledByWaMessageId: { type: String, default: null },
    settledAt: { type: Date, default: null },
    description: { type: String, default: "" },
    idempotencyKey: { type: String, required: true },
    usageRecordId: { type: String, default: null },
    retryCount: { type: Number, default: 0 },
    lastAttemptAt: { type: Date, default: null },
    nextRetryAt: { type: Date, default: null },
    balanceAppliedAt: { type: Date, default: null },
    balanceAppliedError: { type: String, default: null },
    status: {
      type: String,
      enum: [
        "buffered",
        "pending",
        "submitted",
        "settled",
        "failed",
        "skipped",
      ],
      default: "pending",
      index: true,
    },
    error: { type: String, default: null },
    errorAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

BillingUsageChargeSchema.index({ shop: 1, waMessageId: 1 }, { unique: true });
BillingUsageChargeSchema.index({ shop: 1, createdAt: -1 });
BillingUsageChargeSchema.index({ shop: 1, billingCycleId: 1, status: 1 });
BillingUsageChargeSchema.index({
  shop: 1,
  billingCycleId: 1,
  billingStrategy: 1,
  status: 1,
  createdAt: 1,
});
BillingUsageChargeSchema.index({
  shop: 1,
  billingCycleId: 1,
  recipientCountryCode: 1,
  status: 1,
});
BillingUsageChargeSchema.index({
  shop: 1,
  status: 1,
  nextRetryAt: 1,
});

export default mongoose.model("BillingUsageCharge", BillingUsageChargeSchema);
