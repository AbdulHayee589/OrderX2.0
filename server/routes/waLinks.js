// server/routes/waLinks.js
import express from "express";
import CodAttempt from "../models/CodAttempt.js";
import Shop from "../models/Shop.js";
import { hashToken, safeEq, isExpired } from "../services/waTokens.js";
import { confirmAttempt, cancelAttempt } from "../services/attemptActions.js";
import { releaseQueuesAfterAttemptResolved } from "../services/attemptQueueRelease.js";

const router = express.Router();

function htmlPage(title, body) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; padding:24px; background:#0b1220; color:#fff;}
    .card{max-width:520px; margin:0 auto; background:#101a33; padding:20px; border-radius:16px; box-shadow:0 10px 40px rgba(0,0,0,.35)}
    .muted{opacity:.8}
    a{color:#8ab4ff}
  </style>
</head>
<body>
  <div class="card">
    ${body}
    <p class="muted" style="margin-top:18px;">Powered by OrderX</p>
  </div>
</body>
</html>`;
}

function normalizeWhatsAppLinkNumber(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  return s.startsWith("+") ? s.slice(1) : s;
}

async function supportLineForShop(shop) {
  if (!shop) return "";
  const record = await Shop.findOne({ shop }).lean();
  const num = String(record?.settings?.supportWhatsAppNumber || "").trim();
  if (!num) return "";
  const wa = normalizeWhatsAppLinkNumber(num);
  return `<p class="muted">Need help? WhatsApp support: <a href="https://wa.me/${wa}">${num}</a></p>`;
}

async function findAttemptByToken(rawToken) {
  if (!rawToken) return null;

  const tokenHash = hashToken(rawToken);

  // We must search both hashes
  const attempt = await CodAttempt.findOne({
    $or: [{ confirmTokenHash: tokenHash }, { cancelTokenHash: tokenHash }],
  });

  if (!attempt) return null;

  // verify again with timing-safe compare
  const isConfirm = safeEq(attempt.confirmTokenHash, tokenHash);
  const isCancel = safeEq(attempt.cancelTokenHash, tokenHash);

  if (!isConfirm && !isCancel) return null;

  return { attempt, isConfirm, isCancel };
}

router.get("/confirm", async (req, res) => {
  try {
    const rawToken = String(req.query.token || "");
    const found = await findAttemptByToken(rawToken);

    if (!found) {
      return res
        .status(404)
        .type("text/html")
        .send(
          htmlPage(
            "Invalid link",
            `<h2>Invalid link</h2><p class="muted">This confirmation link is not valid.</p>`,
          ),
        );
    }

    const { attempt, isConfirm } = found;

    if (!isConfirm) {
      return res
        .status(400)
        .type("text/html")
        .send(
          htmlPage(
            "Wrong action",
            `<h2>Wrong action</h2><p class="muted">This link is not a confirm link.</p>`,
          ),
        );
    }

    if (attempt.tokenUsedAt) {
      return res
        .status(200)
        .type("text/html")
        .send(
          htmlPage(
            "Already used",
            `<h2>Already processed ✅</h2><p class="muted">This order has already been processed.</p>`,
          ),
        );
    }

    if (isExpired(attempt.tokenExpiresAt)) {
      return res
        .status(410)
        .type("text/html")
        .send(
          htmlPage(
            "Link expired",
            `<h2>Link expired</h2><p class="muted">This link has expired. Please contact the store.</p>`,
          ),
        );
    }

    const actionResult = await confirmAttempt(
      attempt._id.toString(),
      "whatsapp_link",
    );
    if (!actionResult?.alreadyDone) {
      await releaseQueuesAfterAttemptResolved({
        sourceAttempt: attempt,
        fromE164: attempt.phoneE164,
        context: "wa_link_confirm",
      });
    }

    // Mark token used after successful action (prevents lock on transient errors)
    attempt.tokenUsedAt = attempt.tokenUsedAt || new Date();
    await attempt.save();

    const support = await supportLineForShop(attempt.shop).catch(() => "");

    return res
      .status(200)
      .type("text/html")
      .send(
        htmlPage(
          "Confirmed",
          `<h2>Order confirmed ✅</h2>
           <p class="muted">Thank you! Your Cash on Delivery order <strong>${
             attempt.orderName || ""
           }</strong> has been confirmed.</p>
           ${support}`,
        ),
      );
  } catch (e) {
    return res
      .status(500)
      .type("text/html")
      .send(
        htmlPage(
          "Error",
          `<h2>Error</h2><p class="muted">Something went wrong. Please contact the store.</p>`,
        ),
      );
  }
});

router.get("/cancel", async (req, res) => {
  try {
    const rawToken = String(req.query.token || "");
    const found = await findAttemptByToken(rawToken);

    if (!found) {
      return res
        .status(404)
        .type("text/html")
        .send(
          htmlPage(
            "Invalid link",
            `<h2>Invalid link</h2><p class="muted">This cancellation link is not valid.</p>`,
          ),
        );
    }

    const { attempt, isCancel } = found;

    if (!isCancel) {
      return res
        .status(400)
        .type("text/html")
        .send(
          htmlPage(
            "Wrong action",
            `<h2>Wrong action</h2><p class="muted">This link is not a cancel link.</p>`,
          ),
        );
    }

    if (attempt.tokenUsedAt) {
      return res
        .status(200)
        .type("text/html")
        .send(
          htmlPage(
            "Already used",
            `<h2>Already processed ✅</h2><p class="muted">This order has already been processed.</p>`,
          ),
        );
    }

    if (isExpired(attempt.tokenExpiresAt)) {
      return res
        .status(410)
        .type("text/html")
        .send(
          htmlPage(
            "Link expired",
            `<h2>Link expired</h2><p class="muted">This link has expired. Please contact the store.</p>`,
          ),
        );
    }

    const actionResult = await cancelAttempt(
      attempt._id.toString(),
      "whatsapp_link",
    );
    if (!actionResult?.alreadyDone) {
      await releaseQueuesAfterAttemptResolved({
        sourceAttempt: attempt,
        fromE164: attempt.phoneE164,
        context: "wa_link_cancel",
      });
    }

    // Mark token used after successful action (prevents lock on transient errors)
    attempt.tokenUsedAt = attempt.tokenUsedAt || new Date();
    await attempt.save();

    const support = await supportLineForShop(attempt.shop).catch(() => "");

    return res
      .status(200)
      .type("text/html")
      .send(
        htmlPage(
          "Cancelled",
          `<h2>Order cancelled ❌</h2>
           <p class="muted">Your Cash on Delivery order <strong>${
             attempt.orderName || ""
           }</strong> has been cancelled.</p>
           ${support}`,
        ),
      );
  } catch (e) {
    return res
      .status(500)
      .type("text/html")
      .send(
        htmlPage(
          "Error",
          `<h2>Error</h2><p class="muted">Something went wrong. Please contact the store.</p>`,
        ),
      );
  }
});

export default router;
