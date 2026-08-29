import mongoose from "mongoose";

const ConversationInitiationSchema = new mongoose.Schema(
  {
    scopeType: {
      type: String,
      enum: ["own_number", "orderx_number"],
      required: true,
      index: true,
    },
    scopeKey: { type: String, required: true, index: true }, // shop for BYON, "global" for OrderX sender
    shop: { type: String, default: null, index: true }, // informative for admin/debug
    toE164: { type: String, required: true, index: true },
    lastInitiatedAt: { type: Date, required: true, index: true },
  },
  { timestamps: true },
);

ConversationInitiationSchema.index(
  { scopeType: 1, scopeKey: 1, toE164: 1 },
  { unique: true },
);
ConversationInitiationSchema.index({ scopeType: 1, scopeKey: 1, lastInitiatedAt: -1 });

export default mongoose.model("ConversationInitiation", ConversationInitiationSchema);
