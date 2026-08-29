import mongoose from "mongoose";

const CountryMessageRateSchema = new mongoose.Schema(
  {
    countryCode: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },
    countryName: { type: String, required: true, trim: true },
    growthPriceUsd: { type: Number, required: true, min: 0 },
    byonUtilityTemplateUsd: { type: Number, required: true, min: 0 },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

CountryMessageRateSchema.index(
  { countryCode: 1 },
  { unique: true, name: "uniq_country_message_rate_country_code" },
);
CountryMessageRateSchema.index(
  { active: 1, countryCode: 1 },
  { name: "country_message_rate_active_country" },
);

export default mongoose.model("CountryMessageRate", CountryMessageRateSchema);
