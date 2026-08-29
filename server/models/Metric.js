import mongoose from "mongoose";

const MetricSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },
    day: { type: String, index: true }, // YYYY-MM-DD
    waMessagesSent: { type: Number, default: 0 },
    waTemplateMessagesSent: { type: Number, default: 0 },
    waBillableConfirmationMessagesSent: { type: Number, default: 0 },
    savedOrders: { type: Number, default: 0 },
    savedRevenue: { type: Number, default: 0 },
  },
  { timestamps: true }
);

MetricSchema.index({ shop: 1, day: 1 }, { unique: true });

export default mongoose.model("Metric", MetricSchema);
