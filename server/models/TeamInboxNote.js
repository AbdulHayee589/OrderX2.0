import mongoose from "mongoose";

const TeamInboxNoteSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, index: true },
    threadKey: { type: String, required: true, index: true },
    agentAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AgentAccount",
      required: true,
    },
    agentUsername: { type: String, required: true },
    text: { type: String, required: true },
    mentions: { type: [String], default: [] },
  },
  { timestamps: true },
);

TeamInboxNoteSchema.index({ shop: 1, threadKey: 1, createdAt: -1 });

export default mongoose.model("TeamInboxNote", TeamInboxNoteSchema);
