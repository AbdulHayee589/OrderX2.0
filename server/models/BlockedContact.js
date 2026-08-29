import mongoose from "mongoose";

const BlockedContactSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true, required: true },
    phoneE164: { type: String, index: true, required: true },
    note: { type: String, default: "" },
  },
  { timestamps: true }
);

BlockedContactSchema.index({ shop: 1, phoneE164: 1 }, { unique: true });

export default mongoose.model("BlockedContact", BlockedContactSchema);

