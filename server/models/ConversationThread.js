import mongoose from "mongoose";

const ConversationThreadSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },
    threadKey: { type: String, index: true },
    partnerE164: { type: String, index: true },
    waId: { type: String, default: null, index: true },
    whatsappProfileName: { type: String, default: null },
    shopifyCustomerName: { type: String, default: null },
    shippingName: { type: String, default: null },
    manualName: { type: String, default: null },
    displayName: { type: String, default: null, index: true },
    customerEmail: { type: String, default: null },
    customerLocation: { type: String, default: null },
    shopifyCustomerId: { type: String, default: null },
    customerSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    orderSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    identitySyncedAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ["new", "open", "waiting", "snoozed", "resolved"],
      default: "new",
      index: true,
    },
    snoozedUntil: { type: Date, default: null, index: true },
    assignedAgentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AgentAccount",
      default: null,
      index: true,
    },
    assignedUsername: { type: String, default: null },
    labels: { type: [String], default: [] },
    unreadCount: { type: Number, default: 0 },
    lastInboundAt: { type: Date, default: null, index: true },
    lastOutboundAt: { type: Date, default: null },
    lastMessageAt: { type: Date, default: null, index: true },
    lastMessageId: { type: String, default: null },
    lastMessageText: { type: String, default: "" },
    lastMessagePreview: { type: String, default: "" },
    lastDirection: { type: String, default: "outbound", index: true },
    lastKind: { type: String, default: "" },
    lastTemplateName: { type: String, default: null, index: true },
    lastSenderMode: { type: String, default: "unknown", index: true },
    lastSenderPhoneNumberId: { type: String, default: null, index: true },
    lastAttemptId: { type: String, default: null },
    lastOrderGid: { type: String, default: null },
    recipientCountryCode: { type: String, default: null },
    storeCountryCode: { type: String, default: null },
    messageCount: { type: Number, default: 0 },
    inboundCount: { type: Number, default: 0 },
    outboundCount: { type: Number, default: 0 },
    templateCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

ConversationThreadSchema.index({ shop: 1, lastMessageAt: -1 });
ConversationThreadSchema.index({ shop: 1, threadKey: 1 }, { unique: true });
ConversationThreadSchema.index({ shop: 1, partnerE164: 1, lastMessageAt: -1 });
ConversationThreadSchema.index({ shop: 1, status: 1, lastMessageAt: -1 });
ConversationThreadSchema.index({ shop: 1, assignedAgentId: 1, lastMessageAt: -1 });
ConversationThreadSchema.index({ shop: 1, unreadCount: 1, lastMessageAt: -1 });
ConversationThreadSchema.index({ shop: 1, displayName: 1, lastMessageAt: -1 });

export default mongoose.model("ConversationThread", ConversationThreadSchema);
