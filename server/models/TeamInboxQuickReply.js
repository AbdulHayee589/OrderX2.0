import mongoose from "mongoose";

const TeamInboxQuickReplySchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, index: true },
    title: { type: String, required: true },
    shortcut: { type: String, required: true },
    normalizedShortcut: { type: String, required: true },
    body: { type: String, required: true },
  },
  { timestamps: true },
);

TeamInboxQuickReplySchema.index(
  { shop: 1, normalizedShortcut: 1 },
  { unique: true, name: "team_inbox_quick_reply_unique" },
);

export default mongoose.model("TeamInboxQuickReply", TeamInboxQuickReplySchema);
