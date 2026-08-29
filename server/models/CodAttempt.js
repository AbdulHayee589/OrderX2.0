// server/models/CodAttempt.js
import mongoose from "mongoose";

const ErrorEventSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    step: { type: String, default: "" }, // gate | send | misc
    message: { type: String, default: "" },
    count: { type: Number, default: 1 },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const ChangeRequestSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    kind: { type: String, enum: ["address", "name", "qty", "items"], default: null },
    text: { type: String, default: "" },
    reconfirmSentAt: { type: Date, default: null },
    reconfirmWaMessageId: { type: String, default: null },
    resolvedAt: { type: Date, default: null },
    resolution: { type: String, default: null }, // confirmed | cancelled
  },
  { _id: false }
);

const QuantityOverrideSchema = new mongoose.Schema(
  {
    lineIndex: { type: Number, default: null },
    quantity: { type: Number, default: null },
    productLabel: { type: String, default: null },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const CodAttemptSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },

    orderGid: { type: String, index: true },
    orderName: String,
    orderAmount: { type: Number, default: null },
    orderCurrency: { type: String, default: null },

    customerName: String,
    storeName: { type: String, default: null },

    phoneE164: String,
    countryCode: String,
    timezone: String,

    confirmedAt: Date,
    cancelledAt: Date,
    confirmSource: String,
    cancelSource: String,

    stage: {
      type: String,
      enum: ["pre_dispatch", "post_failed_delivery"],
      default: "pre_dispatch",
    },

    // Duplicate-order flow (same customer/order payload placed separately).
    duplicateGroupId: { type: String, index: true, default: null },
    duplicateRole: {
      type: String,
      enum: ["none", "primary", "queued"],
      default: "none",
    },
    duplicateFingerprint: { type: String, default: null },
    duplicateQueuedAt: { type: Date, default: null },
    duplicateReleasedAt: { type: Date, default: null },
    duplicatePromptSentAt: { type: Date, default: null },
    duplicateNotifyOnSend: { type: Boolean, default: false },
    duplicateReferenceAttemptId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CodAttempt",
      default: null,
    },

    // Sequential sending for same phone (different orders)
    phoneQueueGroupId: { type: String, index: true, default: null },
    phoneQueueRole: {
      type: String,
      enum: ["none", "primary", "queued"],
      default: "none",
    },
    phoneQueuedAt: { type: Date, default: null },
    phoneReleasedAt: { type: Date, default: null },
    senderMode: { type: String, default: null, index: true },
    senderPhoneNumberId: { type: String, default: null, index: true },
    senderQueueKey: { type: String, default: null, index: true },

    status: {
      type: String,
      enum: [
        "pending",
        "scheduled",
        "skipped",
        "wa_sent",
        "confirmed",
        "cancelled",
        "expired",
        "failed",
      ],
      default: "pending",
    },

    scheduledAt: Date,
    manualRescheduledAt: { type: Date, default: null },
    lastTriedAt: Date,

    // WhatsApp send metadata
    waMessageId: { type: String, default: null },
    waTemplateUsed: { type: String, default: null },
    waSentAt: { type: Date, default: null },
    waDeliveryStatus: { type: String, default: null },
    waDeliveryStatusAt: { type: Date, default: null },
    waDeliveryError: { type: String, default: null },
    supportInfoSentAt: { type: Date, default: null },
    supportInfoCount: { type: Number, default: 0 },
    // Request Changes flow (customer-edited details; merchant applies changes on Shopify).
    changeState: {
      type: String,
      enum: ["none", "choose_type", "awaiting_details", "reconfirm_sent"],
      default: "none",
    },
    changeKindPending: {
      type: String,
      enum: ["address", "name", "qty", "qty_item_select", "items"],
      default: null,
    },
    changeRequestCount: { type: Number, default: 0 },
    changeRequestedAt: { type: Date, default: null },
    changePromptSentAt: { type: Date, default: null },
    changeDetailsReceivedAt: { type: Date, default: null },
    changeReconfirmSentAt: { type: Date, default: null },
    changeReconfirmWaMessageId: { type: String, default: null },
    changeProposedName: { type: String, default: null },
    changeProposedAddress: { type: String, default: null },
    changeProposedQuantity: { type: Number, default: null },
    changeProposedQuantityLineIndex: { type: Number, default: null },
    changeProposedQuantityProductLabel: { type: String, default: null },
    changeProposedQuantityOverrides: {
      type: [QuantityOverrideSchema],
      default: [],
    },
    changeProposedAmountText: { type: String, default: null },
    changeQtyTargetLineIndex: { type: Number, default: null },
    changeQtyTargetProductLabel: { type: String, default: null },
    changeRequests: { type: [ChangeRequestSchema], default: [] },
    lastError: { type: String, default: null },
    lastErrorAt: { type: Date, default: null },
    lastErrorMeta: { type: mongoose.Schema.Types.Mixed, default: null },
    retryCount: { type: Number, default: 0 },
    errorEvents: { type: [ErrorEventSchema], default: [] },

    // Secure link tokens (store hashes only)
    confirmTokenHash: { type: String, index: true, default: null },
    cancelTokenHash: { type: String, index: true, default: null },
    tokenExpiresAt: { type: Date, default: null },
    tokenUsedAt: { type: Date, default: null },

    // Terminal status metadata
    processedAt: { type: Date, default: null },
    expiredAt: { type: Date, default: null },
    expireSource: { type: String, default: null },
  },
  { timestamps: true }
);

CodAttemptSchema.index({ shop: 1, orderGid: 1, stage: 1 }, { unique: true });
CodAttemptSchema.index({ shop: 1, createdAt: -1 });
CodAttemptSchema.index({ shop: 1, status: 1, createdAt: -1 });
CodAttemptSchema.index({ shop: 1, orderName: 1, createdAt: -1 });
CodAttemptSchema.index({ shop: 1, phoneE164: 1, createdAt: -1 });
CodAttemptSchema.index({ shop: 1, customerName: 1, createdAt: -1 });
CodAttemptSchema.index({
  shop: 1,
  phoneE164: 1,
  senderQueueKey: 1,
  status: 1,
  createdAt: 1,
});

export default mongoose.model("CodAttempt", CodAttemptSchema);
