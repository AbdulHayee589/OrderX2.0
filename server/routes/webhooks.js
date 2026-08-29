import express from "express";
import { shopify } from "../shopify.js";
import {
  scheduleFromOrderCreate,
  scheduleFromOrderUpdated,
} from "../services/codFlow.js";

const router = express.Router();

router.post("/orders/create", async (req, res) => {
  try {
    const topic = req.headers["x-shopify-topic"];
    const shop = req.headers["x-shopify-shop-domain"];
    const body = req.body;

    // your logic
    await scheduleFromOrderCreate(shop, body);

    res.status(200).send("ok");
  } catch (e) {
    res.status(500).send("error");
  }
});

router.post("/orders/updated", async (req, res) => {
  try {
    const shop = req.headers["x-shopify-shop-domain"];
    const body = req.body;

    await scheduleFromOrderUpdated(shop, body);

    res.status(200).send("ok");
  } catch {
    res.status(500).send("error");
  }
});

export default router;
