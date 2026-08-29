// server/routes/debug.js
import express from "express";
import {
  sendCodConfirmRequestTestTemplate,
  sendCodConfirmTemplate,
  sendDeliveryFailedRedeliverTemplate,
  sendCodConfirmedTemplate,
  sendOrderCancelTemplate,
} from "../services/whatsapp.js";

const router = express.Router();

router.post("/send-cod-template", async (req, res) => {
  try {
    const {
      to,
      mode, // approved_test | quick_reply | delivery_failed | confirmed_msg | cancel_msg
      customerName,
      storeName,
      orderNumber,
      productsText,
      amountText,
      deliveryAddressText,
      confirmToken,
      cancelToken,
    } = req.body || {};
    if (!to) return res.status(400).json({ ok: false, error: "Missing to" });

    const m = String(mode || "approved_test").toLowerCase();

    let result = null;

    if (m === "quick_reply" || m === "cod_confirm") {
      result = await sendCodConfirmTemplate({
        to,
        customerName: customerName || "Abdul",
        storeName: storeName || "OrderX Test Store",
        orderNumber: orderNumber || "#TEST-ORDER",
        productsText: productsText || "Test Product Qty 1",
        amountText: amountText || "0.00 PKR",
        deliveryAddressText: deliveryAddressText || "Test Address",
        confirmPayload: "confirm:test",
        cancelPayload: "cancel:test",
      });
    } else if (m === "delivery_failed") {
      result = await sendDeliveryFailedRedeliverTemplate({
        to,
        customerName: customerName || "Abdul",
        orderNumber: orderNumber || "#TEST-ORDER",
        storeName: storeName || "OrderX Test Store",
        redeliverPayload: "redeliver:test",
        cancelPayload: "cancel:test",
      });
    } else if (m === "confirmed_msg") {
      result = await sendCodConfirmedTemplate({
        to,
        orderNumber: orderNumber || "#TEST-ORDER",
        storeName: storeName || "OrderX Test Store",
      });
    } else if (m === "cancel_msg") {
      result = await sendOrderCancelTemplate({ to });
    } else {
      // approved_test (default): approved URL-button template (send-only test)
      result = await sendCodConfirmRequestTestTemplate({
        to,
        customerName: customerName || "Customer",
        orderNumber: orderNumber || "#TEST-ORDER",
        storeName: storeName || "OrderX Test Store",
        confirmToken: confirmToken || "abc123",
        cancelToken: cancelToken || "xyz789",
      });
    }

    return res.json({ ok: true, ...result });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "Failed",
      meta: e?.meta || null,
    });
  }
});

export default router;
