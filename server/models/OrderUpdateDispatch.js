import mongoose from "mongoose";

const OrderUpdateDispatchSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true, required: true },
    topic: { type: String, default: "" },
    eventType: { type: String, default: "" }, // dispatched | tracking_updated | cancelled
    dedupeKey: { type: String, index: true, unique: true, required: true },
    webhookId: { type: String, default: null, index: true },

    orderId: { type: String, default: null, index: true },
    orderGid: { type: String, default: null, index: true },
    fulfillmentId: { type: String, default: null, index: true },
    trackingFingerprint: { type: String, default: null },

    phoneE164: { type: String, default: null },
    attemptId: { type: mongoose.Schema.Types.ObjectId, ref: "CodAttempt", default: null },

    status: {
      type: String,
      enum: ["processing", "sent", "skipped", "failed"],
      default: "processing",
      index: true,
    },
    skippedReason: { type: String, default: null },
    channel: { type: String, default: null }, // template | freeform
    templateUsed: { type: String, default: null },
    waMessageId: { type: String, default: null },
    sentAt: { type: Date, default: null },
    errorMessage: { type: String, default: null },
    errorMeta: { type: mongoose.Schema.Types.Mixed, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

export default mongoose.model("OrderUpdateDispatch", OrderUpdateDispatchSchema);
