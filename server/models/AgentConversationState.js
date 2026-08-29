import mongoose from "mongoose";

const AgentConversationStateSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, index: true },
    threadKey: { type: String, required: true, index: true },
    agentAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AgentAccount",
      required: true,
      index: true,
    },
    lastReadAt: { type: Date, default: null },
    draft: { type: String, default: "" },
    draftUpdatedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

AgentConversationStateSchema.index(
  { shop: 1, threadKey: 1, agentAccountId: 1 },
  { unique: true, name: "agent_thread_state_unique" },
);
AgentConversationStateSchema.index({ shop: 1, agentAccountId: 1, updatedAt: -1 });

export default mongoose.model(
  "AgentConversationState",
  AgentConversationStateSchema,
);
