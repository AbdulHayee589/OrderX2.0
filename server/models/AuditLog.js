import mongoose from "mongoose";

const AuditLogSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true, required: true },
    actor: { type: String, default: "system" }, // merchant | system | webhook | job
    action: { type: String, index: true, required: true }, // settings_save, billing_sync, etc.
    level: {
      type: String,
      enum: ["info", "warn", "error"],
      default: "info",
    },
    message: { type: String, default: "" },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

AuditLogSchema.index({ shop: 1, createdAt: -1 });

export default mongoose.model("AuditLog", AuditLogSchema);

