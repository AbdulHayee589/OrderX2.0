import Twilio from "twilio";

const client = Twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

export async function placeTwilioCall(attemptId, to) {
  const base = process.env.HOST;
  const call = await client.calls.create({
    to,
    from: process.env.TWILIO_FROM_NUMBER,
    url: `${base}/twilio/voice?attemptId=${attemptId}`,
    method: "GET",
    statusCallback: `${base}/twilio/status?attemptId=${attemptId}`,
    statusCallbackEvent: ["completed", "no-answer", "busy", "failed"],
    statusCallbackMethod: "POST",
  });

  return call.sid;
}

export function buildTwiMLGather(attemptId) {
  const twiml = new Twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    numDigits: 1,
    action: `/twilio/handle?attemptId=${attemptId}`,
    method: "POST",
    timeout: 8,
  });

  gather.say("This is an automated order confirmation call.");
  gather.say("Press 1 to confirm your order. Press 2 to cancel your order.");
  twiml.say("No input received. Goodbye.");
  twiml.hangup();

  return twiml.toString();
}
