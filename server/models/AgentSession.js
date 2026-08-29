import mongoose from "mongoose";

const AgentSessionSchema = new mongoose.Schema(
  {
    agentAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AgentAccount",
      required: true,
      index: true,
    },
    shop: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true },
    csrfTokenHash: { type: String, required: true },
    previousCsrfTokenHashes: { type: [String], default: [] },
    credentialVersion: { type: Number, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null, index: true },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

AgentSessionSchema.index(
  { tokenHash: 1 },
  { unique: true, name: "agent_session_token_unique" },
);
AgentSessionSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: "agent_session_expiry_ttl" },
);
AgentSessionSchema.index(
  { shop: 1, agentAccountId: 1, createdAt: -1 },
  { name: "agent_session_shop_account_created" },
);

export default mongoose.model("AgentSession", AgentSessionSchema);
