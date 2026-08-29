import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import mongoose from "mongoose";

let mongod;
let dbPath;
let mongoReady = false;
let CampaignRecipient;
let CampaignRun;
let WaMessageLog;
let reconcileCampaignDeliveryStatus;
let reconcileCampaignDeliveryFromLog;
let claimCampaignPhone;

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForMongo(uri) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 300 });
      return true;
    } catch {
      await mongoose.disconnect().catch(() => null);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return false;
}

before(
  async (context) => {
    const lookup = spawnSync("sh", ["-c", "command -v mongod"], {
      encoding: "utf8",
    });
    const binary = String(lookup.stdout || "").trim();
    if (!binary) {
      context.skip("mongod is unavailable; campaign delivery integration test skipped");
      return;
    }
    const port = await freePort();
    dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "orderx-campaign-test-"));
    mongod = spawn(
      binary,
      [
        "--dbpath",
        dbPath,
        "--port",
        String(port),
        "--bind_ip",
        "127.0.0.1",
        "--quiet",
      ],
      { stdio: "ignore" },
    );
    const uri = `mongodb://127.0.0.1:${port}/orderx_campaign_test`;
    if (!(await waitForMongo(uri))) {
      throw new Error("Local campaign test MongoDB did not start");
    }
    mongoReady = true;
    ({ default: CampaignRecipient } = await import("../models/CampaignRecipient.js"));
    ({ default: CampaignRun } = await import("../models/CampaignRun.js"));
    ({ default: WaMessageLog } = await import("../models/WaMessageLog.js"));
    ({
      reconcileCampaignDeliveryFromLog,
      reconcileCampaignDeliveryStatus,
    } = await import("../services/campaignDeliveryStatus.js"));
    ({ claimCampaignPhone } = await import(
      "../services/campaignRecipientClaims.js"
    ));
  },
  { timeout: 20_000 },
);

beforeEach(async () => {
  if (mongoReady) await mongoose.connection.db.dropDatabase();
});

after(async () => {
  await mongoose.disconnect().catch(() => null);
  if (mongod) {
    mongod.kill("SIGTERM");
    await new Promise((resolve) => mongod.once("exit", resolve));
  }
  if (dbPath) fs.rmSync(dbPath, { recursive: true, force: true });
});

test("campaign webhooks reconcile delivery/read/failure without status downgrades", async (context) => {
  if (!mongoReady) return context.skip("local MongoDB unavailable");
  const shop = "campaign-test.myshopify.com";
  const run = await CampaignRun.create({
    shop,
    status: "completed",
    scheduleMode: "immediate",
    templateId: "template-1",
    totalRecipients: 2,
    sentCount: 2,
  });
  await CampaignRecipient.create([
    {
      campaignRunId: run._id,
      shop,
      toE164: "+923001111111",
      status: "sent",
      waMessageId: "wamid.delivered",
      sentAt: new Date(),
      deliveryStatus: "accepted",
    },
    {
      campaignRunId: run._id,
      shop,
      toE164: "+923002222222",
      status: "sent",
      waMessageId: "wamid.failed",
      sentAt: new Date(),
      deliveryStatus: "accepted",
    },
  ]);

  assert.equal(
    (
      await reconcileCampaignDeliveryStatus({
        shop,
        waMessageId: "wamid.delivered",
        status: "delivered",
      })
    ).updated,
    true,
  );
  await reconcileCampaignDeliveryStatus({
    shop,
    waMessageId: "wamid.delivered",
    status: "read",
  });
  const downgrade = await reconcileCampaignDeliveryStatus({
    shop,
    waMessageId: "wamid.delivered",
    status: "sent",
  });
  assert.equal(downgrade.updated, false);

  await CampaignRecipient.updateOne(
    { waMessageId: "wamid.failed" },
    { $set: { deliveryStatus: "sent" } },
  );

  await reconcileCampaignDeliveryStatus({
    shop,
    waMessageId: "wamid.failed",
    status: "failed",
    errorText: "Message undeliverable (code 131026)",
    errors: [
      {
        code: 131026,
        title: "Message undeliverable",
        error_data: { details: "The number is not available on WhatsApp" },
      },
    ],
  });

  const delivered = await CampaignRecipient.findOne({
    waMessageId: "wamid.delivered",
  }).lean();
  const failed = await CampaignRecipient.findOne({
    waMessageId: "wamid.failed",
  }).lean();
  const refreshedRun = await CampaignRun.findById(run._id).lean();
  assert.equal(delivered.deliveryStatus, "read");
  assert.equal(failed.status, "failed");
  assert.equal(failed.deliveryStatus, "failed");
  assert.equal(failed.failureCode, "no_whatsapp");
  assert.match(failed.errorMessage, /not available on WhatsApp/);
  assert.equal(refreshedRun.sentCount, 1);
  assert.equal(refreshedRun.deliveredCount, 1);
  assert.equal(refreshedRun.readCount, 1);
  assert.equal(refreshedRun.failedCount, 1);
  assert.equal(refreshedRun.status, "completed_with_failures");

  const crossTenant = await reconcileCampaignDeliveryStatus({
    shop: "another-shop.myshopify.com",
    waMessageId: "wamid.delivered",
    status: "failed",
  });
  assert.equal(crossTenant.matched, false);
});

test("campaign phone claims allow exactly one recipient and preserve owner retries", async (context) => {
  if (!mongoReady) return context.skip("local MongoDB unavailable");
  const shop = "dedupe-test.myshopify.com";
  const run = await CampaignRun.create({
    shop,
    status: "processing",
    scheduleMode: "immediate",
    templateId: "template-1",
  });
  const recipients = await CampaignRecipient.create([
    {
      campaignRunId: run._id,
      shop,
      toE164: "+923001234567",
      status: "processing",
    },
    {
      campaignRunId: run._id,
      shop,
      toE164: "+923001234567",
      status: "processing",
    },
  ]);
  const [left, right] = await Promise.all(
    recipients.map((recipient) =>
      claimCampaignPhone({
        campaignRunId: run._id,
        recipientId: recipient._id,
        phoneKey: "+923001234567",
      }),
    ),
  );
  assert.equal(Number(left.owned) + Number(right.owned), 1);
  const owner = left.owned ? recipients[0] : recipients[1];
  const other = left.owned ? recipients[1] : recipients[0];
  assert.equal(
    (
      await claimCampaignPhone({
        campaignRunId: run._id,
        recipientId: owner._id,
        phoneKey: "+923001234567",
      })
    ).owned,
    true,
  );
  assert.equal(
    (
      await claimCampaignPhone({
        campaignRunId: run._id,
        recipientId: other._id,
        phoneKey: "+923001234567",
      })
    ).owned,
    false,
  );
});

test("a webhook that wins the acceptance race is reconciled from the message log", async (context) => {
  if (!mongoReady) return context.skip("local MongoDB unavailable");
  const shop = "race-test.myshopify.com";
  const run = await CampaignRun.create({
    shop,
    status: "completed",
    scheduleMode: "immediate",
    templateId: "template-race",
  });
  await WaMessageLog.create({
    shop,
    direction: "outbound",
    toE164: "+923001111999",
    waMessageId: "wamid.race",
    meta: {
      deliveryStatus: "failed",
      deliveryStatusAt: new Date(),
      deliveryError: "Message was not deliverable",
    },
  });
  await CampaignRecipient.create({
    campaignRunId: run._id,
    shop,
    toE164: "+923001111999",
    status: "sent",
    waMessageId: "wamid.race",
    sentAt: new Date(),
    deliveryStatus: "accepted",
  });

  const result = await reconcileCampaignDeliveryFromLog({
    shop,
    waMessageId: "wamid.race",
  });
  const recipient = await CampaignRecipient.findOne({
    waMessageId: "wamid.race",
  }).lean();
  assert.equal(result.updated, true);
  assert.equal(recipient.status, "failed");
  assert.equal(recipient.deliveryStatus, "failed");
  assert.match(recipient.errorMessage, /not deliverable/);
});
