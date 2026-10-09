import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

async function main() {
  if (!process.env.MONGO_URI) {
    throw new Error("Missing MONGO_URI");
  }

  // Register every schema without starting the HTTP server or Agenda workers.
  const modelModules = [
    "../models/AbandonedCheckoutDispatch.js",
    "../models/AgentAccount.js",
    "../models/AgentConversationState.js",
    "../models/AgentSendReceipt.js",
    "../models/AgentSession.js",
    "../models/AppRuntimeConfig.js",
    "../models/AuditLog.js",
    "../models/BillingUsageCharge.js",
    "../models/BlockedContact.js",
    "../models/CampaignRecipient.js",
    "../models/CampaignRun.js",
    "../models/CodAttempt.js",
    "../models/ConversationInitiation.js",
    "../models/ConversationThread.js",
    "../models/CountryMessageRate.js",
    "../models/Metric.js",
    "../models/OrderUpdateDispatch.js",
    "../models/PlanPurchase.js",
    "../models/Shop.js",
    "../models/TeamInboxLabel.js",
    "../models/TeamInboxNote.js",
    "../models/TeamInboxQuickReply.js",
    "../models/WaMessageLog.js",
  ];
  await Promise.all(modelModules.map((path) => import(path)));

  await mongoose.connect(process.env.MONGO_URI, {
    autoIndex: false,
    serverSelectionTimeoutMS: 10_000,
  });
  try {
    const models = Object.values(mongoose.models);
    for (const model of models) {
      await model.createIndexes();
      console.log(`[mongo_indexes] ${model.modelName} ready`);
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (error) => {
  console.error(error?.stack || error?.message || error);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore shutdown failure
  }
  process.exit(1);
});
