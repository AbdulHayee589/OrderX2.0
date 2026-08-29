import express from "express";
import CodAttempt from "../models/CodAttempt.js";
import { buildTwiMLGather } from "../services/twilioVoice.js";
import { confirmAttempt, cancelAttempt } from "../services/attemptActions.js";
import { releaseQueuesAfterAttemptResolved } from "../services/attemptQueueRelease.js";
import { verifyTwilioRequest } from "../middleware/verifyTwilio.js";
import { agenda } from "../jobs/agenda.js";

const router = express.Router();

// Twilio sends application/x-www-form-urlencoded
const urlencoded = express.urlencoded({ extended: false });

// Twilio hits this to fetch TwiML instructions.
router.get("/voice", async (req, res) => {
  try {
    const { attemptId } = req.query;
    if (!attemptId)
      return res.status(400).type("text/plain").send("Missing attemptId");

    const attempt = await CodAttempt.findById(attemptId).lean();
    if (!attempt)
      return res.status(404).type("text/plain").send("Attempt not found");

    const twiml = buildTwiMLGather(attemptId);
    return res.status(200).type("text/xml").send(twiml);
  } catch (e) {
    return res
      .status(200)
      .type("text/xml")
      .send("<Response><Say>Error.</Say></Response>");
  }
});

// Twilio posts digit result here
router.post("/handle", urlencoded, verifyTwilioRequest, async (req, res) => {
  try {
    const { attemptId } = req.query;
    const digit = String(req.body?.Digits || "");

    if (!attemptId) {
      return res
        .status(200)
        .type("text/xml")
        .send("<Response><Say>Missing.</Say></Response>");
    }

    if (digit === "1") {
      const sourceAttempt = await CodAttempt.findById(attemptId).lean();
      const actionResult = await confirmAttempt(attemptId, "twilio");
      if (!actionResult?.alreadyDone && sourceAttempt?._id) {
        await releaseQueuesAfterAttemptResolved({
          sourceAttempt,
          fromE164: sourceAttempt.phoneE164,
          context: "twilio_confirm",
        });
      }
      return res
        .status(200)
        .type("text/xml")
        .send(
          "<Response><Say>Your order is confirmed. Goodbye.</Say><Hangup/></Response>"
        );
    }

    if (digit === "2") {
      const sourceAttempt = await CodAttempt.findById(attemptId).lean();
      const actionResult = await cancelAttempt(attemptId, "twilio");
      if (!actionResult?.alreadyDone && sourceAttempt?._id) {
        await releaseQueuesAfterAttemptResolved({
          sourceAttempt,
          fromE164: sourceAttempt.phoneE164,
          context: "twilio_cancel",
        });
      }
      return res
        .status(200)
        .type("text/xml")
        .send(
          "<Response><Say>Your order is cancelled. Goodbye.</Say><Hangup/></Response>"
        );
    }

    return res
      .status(200)
      .type("text/xml")
      .send("<Response><Say>Invalid input. Goodbye.</Say><Hangup/></Response>");
  } catch (e) {
    return res
      .status(200)
      .type("text/xml")
      .send("<Response><Say>Error. Goodbye.</Say><Hangup/></Response>");
  }
});

// Twilio status callback
router.post("/status", urlencoded, verifyTwilioRequest, async (req, res) => {
  try {
    const { attemptId } = req.query;
    const callStatus = String(req.body?.CallStatus || "").toLowerCase();

    if (!attemptId) return res.status(200).json({ ok: true });

    // Only fallback on "no-answer/busy/failed"
    if (!["no-answer", "busy", "failed"].includes(callStatus)) {
      return res.status(200).json({ ok: true });
    }

    const attempt = await CodAttempt.findById(attemptId);
    if (!attempt) return res.status(200).json({ ok: true });

    // If already resolved, do nothing
    if (["confirmed", "cancelled", "expired"].includes(attempt.status)) {
      return res.status(200).json({ ok: true });
    }

    // Don't re-send WhatsApp if it was already sent
    if (attempt.status === "wa_sent") {
      return res.status(200).json({ ok: true });
    }

    attempt.status = "scheduled";
    attempt.scheduledAt = new Date();
    attempt.lastTriedAt = new Date();
    attempt.lastError = `call_${callStatus}`;
    await attempt.save();

    // WhatsApp fallback: reuse the standard WhatsApp job (handles billing + quotas + working hours).
    if (attempt.phoneE164) {
      await agenda.schedule(new Date(), "attempt_cod_confirmation", {
        attemptId: attempt._id.toString(),
      });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(200).json({ ok: true });
  }
});

export default router;
