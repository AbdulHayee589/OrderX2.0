import mongoose from "mongoose";

const PlanPurchaseSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true, required: true },
    planKey: { type: String, required: true },
    subscriptionId: { type: String, required: true },

    status: { type: String, default: "ACTIVE" }, // ACTIVE | ACCEPTED | CANCELLED | CANCELLED_PENDING_END | REPLACED
    test: { type: Boolean, default: false },

    startedAt: { type: Date, default: Date.now },
    currentPeriodEnd: { type: Date, default: null },
    endedAt: { type: Date, default: null },

    source: { type: String, default: "shopify_sync" },
  },
  { timestamps: true }
);

PlanPurchaseSchema.index({ shop: 1, subscriptionId: 1 }, { unique: true });
PlanPurchaseSchema.index({ shop: 1, startedAt: -1 });

export default mongoose.model("PlanPurchase", PlanPurchaseSchema);
