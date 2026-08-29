import twilio from "twilio";

export function verifyTwilioRequest(req, res, next) {
  try {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const allowUnsigned =
      String(process.env.ALLOW_UNSIGNED_TWILIO_WEBHOOK || "").toLowerCase() ===
        "true" ||
      String(process.env.NODE_ENV || "").toLowerCase() !== "production";
    if (!authToken) {
      if (allowUnsigned) return next();
      return res.status(503).send("Twilio signature verification is not configured");
    }

    const signature = req.header("X-Twilio-Signature");
    const url = `${process.env.HOST}${req.originalUrl}`;

    const params = req.body || {};

    const isValid = twilio.validateRequest(authToken, signature, url, params);
    if (!isValid) return res.status(401).send("Invalid Twilio signature");

    return next();
  } catch (e) {
    return res.status(401).send("Invalid Twilio request");
  }
}
