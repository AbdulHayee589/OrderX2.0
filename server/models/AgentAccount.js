import mongoose from "mongoose";

const AgentAccountSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, index: true },
    username: { type: String, required: true },
    usernameNormalized: { type: String, required: true },
    passwordHash: { type: String, required: true, select: false },
    passwordSalt: { type: String, required: true, select: false },
    credentialVersion: { type: Number, default: 1 },
    slot: { type: Number, required: true, min: 1, max: 3 },
    accessLevel: {
      type: String,
      enum: ["support", "limited", "manager"],
      default: "support",
    },
    permissions: { type: mongoose.Schema.Types.Mixed, default: null },
    active: { type: Boolean, default: true, index: true },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true },
);

AgentAccountSchema.index(
  { usernameNormalized: 1 },
  { unique: true, name: "agent_username_global_unique" },
);
AgentAccountSchema.index(
  { shop: 1, slot: 1 },
  { unique: true, name: "agent_shop_slot_unique" },
);
AgentAccountSchema.index(
  { shop: 1, active: 1, createdAt: 1 },
  { name: "agent_shop_active_created" },
);

export default mongoose.model("AgentAccount", AgentAccountSchema);
