import CampaignRun from "../models/CampaignRun.js";

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

export async function claimCampaignPhone({
  campaignRunId,
  recipientId,
  phoneKey,
}) {
  const claimedRun = await CampaignRun.findOneAndUpdate(
    {
      _id: campaignRunId,
      recipientPhoneClaims: {
        $not: { $elemMatch: { phoneKey } },
      },
    },
    {
      $push: {
        recipientPhoneClaims: {
          phoneKey,
          recipientId,
          claimedAt: new Date(),
        },
      },
    },
    { returnDocument: "after" },
  )
    .select({ _id: 1 })
    .lean();
  if (claimedRun) {
    return { owned: true, ownerRecipientId: String(recipientId || "") };
  }

  const existingRun = await CampaignRun.findById(campaignRunId)
    .select({ recipientPhoneClaims: 1 })
    .lean();
  const existingClaim = toArray(existingRun?.recipientPhoneClaims).find(
    (row) => String(row?.phoneKey || "") === phoneKey,
  );
  const ownerRecipientId = String(existingClaim?.recipientId || "");
  return {
    owned: ownerRecipientId === String(recipientId || ""),
    ownerRecipientId,
  };
}
