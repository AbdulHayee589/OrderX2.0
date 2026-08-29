import mongoose from "mongoose";

const AbandonedCheckoutDispatchSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true, required: true },
    checkoutId: { type: String, index: true, required: true },
    dedupeKey: { type: String, index: true, unique: true, required: true },
    checkoutName: { type: String, default: null },
    checkoutUrl: { type: String, default: null },
    customerName: { type: String, default: null },
    customerEmail: { type: String, default: null },
    phoneE164: { type: String, default: null, index: true },
    status: {
      type: String,
      enum: ["processing", "sent", "skipped", "failed", "recovered"],
      default: "processing",
      index: true,
    },
    skippedReason: { type: String, default: null },
    templateUsed: { type: String, default: null },
    waMessageId: { type: String, default: null },
    sentAt: { type: Date, default: null },
    recoveredAt: { type: Date, default: null },
    errorMessage: { type: String, default: null },
    errorMeta: { type: mongoose.Schema.Types.Mixed, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

export default mongoose.model(
  "AbandonedCheckoutDispatch",
  AbandonedCheckoutDispatchSchema,
);
