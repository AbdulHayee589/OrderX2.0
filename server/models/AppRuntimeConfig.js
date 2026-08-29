import mongoose from "mongoose";

const AppRuntimeConfigSchema = new mongoose.Schema(
  {
    singletonKey: {
      type: String,
      required: true,
      default: "global",
      unique: true,
      index: true,
    },
    orderxMaxInitiatedConversations24h: {
      type: Number,
      default: 2000,
      min: 1,
    },
  },
  { timestamps: true },
);

export default mongoose.model("AppRuntimeConfig", AppRuntimeConfigSchema);

