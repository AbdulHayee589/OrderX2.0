import mongoose from "mongoose";

const WaMessageLogSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },
    toE164: { type: String, index: true },
    direction: {
      type: String,
      enum: ["outbound", "inbound"],
      default: "outbound",
    },
    kind: { type: String, default: "" }, // e.g. support_info
    text: { type: String, default: "" },
    templateName: { type: String, default: null },
    waMessageId: { type: String, default: null },
    senderMode: { type: String, default: "unknown", index: true }, // orderx_number | own_number | unknown
    senderPhoneNumberId: { type: String, default: null, index: true },
    recipientCountryCode: { type: String, default: null, index: true },
    storeCountryCode: { type: String, default: null, index: true },
    crossBorderRateApplied: { type: Boolean, default: false },
    estimatedMetaCostUsd: { type: Number, default: null },
    usagePricingBasisUsd: { type: Number, default: null },
    usageChargeUsd: { type: Number, default: null },
    usageChargeState: { type: String, default: null },
    usageBillingStrategy: { type: String, default: null },
    usageBatchGroupKey: { type: String, default: null },
    capUnitsConsumed: { type: Number, default: null },
    attemptId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CodAttempt",
      default: null,
    },
    orderGid: { type: String, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

WaMessageLogSchema.index({ shop: 1, createdAt: -1 });
WaMessageLogSchema.index({
  shop: 1,
  direction: 1,
  toE164: 1,
  senderPhoneNumberId: 1,
  createdAt: -1,
});
WaMessageLogSchema.index({
  shop: 1,
  toE164: 1,
  createdAt: -1,
});
WaMessageLogSchema.index({
  shop: 1,
  direction: 1,
  senderMode: 1,
  recipientCountryCode: 1,
  createdAt: -1,
});
WaMessageLogSchema.index({
  shop: 1,
  senderMode: 1,
  templateName: 1,
  createdAt: -1,
});
WaMessageLogSchema.index(
  { shop: 1, direction: 1, waMessageId: 1 },
  {
    unique: true,
    name: "shop_1_direction_1_waMessageId_1",
    partialFilterExpression: {
      waMessageId: { $type: "string" },
    },
  },
);

export default mongoose.model("WaMessageLog", WaMessageLogSchema);
