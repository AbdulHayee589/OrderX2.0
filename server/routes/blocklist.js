import express from "express";
import BlockedContact from "../models/BlockedContact.js";
import { normalizePhoneE164 } from "../services/phone.js";
import { logAudit } from "../services/audit.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const items = await BlockedContact.find({ shop })
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

router.post("/", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const rawPhone = String(req.body?.phone || "").trim();
    const countryCode = String(req.body?.countryCode || "").trim() || null;
    const note = String(req.body?.note || "").trim();

    if (!rawPhone) return res.status(400).json({ error: "Missing phone" });

    const phoneE164 = normalizePhoneE164(rawPhone, countryCode);
    if (!phoneE164) {
      return res.status(400).json({
        error:
          "Invalid phone number. Use E.164 format like +15551234567 (recommended).",
      });
    }

    const created = await BlockedContact.findOneAndUpdate(
      { shop, phoneE164 },
      { $set: { note } },
      { upsert: true, new: true }
    ).lean();

    void logAudit({
      shop,
      actor: "merchant",
      action: "blocklist_add",
      meta: { phoneE164, note: note || null },
    });

    return res.json({ ok: true, item: created });
  } catch (e) {
    const msg = e?.message || "Failed";
    // Duplicate key could happen in race conditions; treat as ok-ish.
    const code = String(msg).toLowerCase().includes("duplicate") ? 409 : 500;
    return res.status(code).json({ error: msg });
  }
});

router.post("/remove", async (req, res) => {
  try {
    const shop = String(req.query.shop || "").trim();
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const id = String(req.body?.id || "").trim();
    if (!id) return res.status(400).json({ error: "Missing id" });

    const result = await BlockedContact.deleteOne({ _id: id, shop });
    void logAudit({
      shop,
      actor: "merchant",
      action: "blocklist_remove",
      meta: { id, deleted: Number(result.deletedCount || 0) },
    });
    return res.json({ ok: true, deleted: result.deletedCount || 0 });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed" });
  }
});

export default router;
