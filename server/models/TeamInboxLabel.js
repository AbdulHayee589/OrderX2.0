import mongoose from "mongoose";

const TeamInboxLabelSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, index: true },
    name: { type: String, required: true },
    normalizedName: { type: String, required: true },
    color: { type: String, default: "#0f766e" },
  },
  { timestamps: true },
);

TeamInboxLabelSchema.index(
  { shop: 1, normalizedName: 1 },
  { unique: true, name: "team_inbox_label_unique" },
);

export default mongoose.model("TeamInboxLabel", TeamInboxLabelSchema);
