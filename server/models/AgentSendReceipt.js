import mongoose from "mongoose";

const AgentSendReceiptSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, index: true },
    threadKey: { type: String, required: true },
    agentAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AgentAccount",
      required: true,
    },
    clientMessageId: { type: String, required: true },
    status: {
      type: String,
      enum: ["sending", "sent", "failed"],
      default: "sending",
    },
    waMessageId: { type: String, default: null },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  },
  { timestamps: true },
);

AgentSendReceiptSchema.index(
  { shop: 1, agentAccountId: 1, clientMessageId: 1 },
  { unique: true, name: "agent_send_idempotency_unique" },
);
AgentSendReceiptSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: "agent_send_receipt_ttl" },
);

export default mongoose.model("AgentSendReceipt", AgentSendReceiptSchema);
