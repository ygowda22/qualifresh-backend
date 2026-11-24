import { Router } from "express";
import { Order } from "../models/Order";
import { customerIdFromToken } from "../middleware/auth";
import { priceOrderItems } from "../config/pricing";

const router = Router();

const WHATSAPP_NUMBER = "917276369948";

// POST /api/whatsapp-order — logs a WhatsApp order (guest or logged-in), then returns the
// WhatsApp message URL to redirect to. The frontend must not open WhatsApp until this responds.
router.post("/", async (req, res) => {
  try {
    const {
      items, subtotal, deliveryCharge, total,
      address, city, deliverySlot, notes,
      name, phone, email,
    } = req.body; // any userId in the body is ignored — the account comes only from the login token

    if (!items?.length || !deliverySlot || !name || !phone || !city)
      return res.status(400).json({ message: "Missing required fields" });

    // Items, prices and totals come from the database; a stale cart gets 409 PRICES_CHANGED.
    const priced = await priceOrderItems(items, { subtotal, total });
    if (!priced.ok) return res.status(priced.status).json(priced.body);
    const { subtotal: srvSubtotal, deliveryCharge: srvDelivery, total: srvTotal } = priced.totals;
    const userId = await customerIdFromToken(req);

    const order = await Order.create({
      user:        userId || undefined,
      guestName:   userId ? undefined : name,
      guestEmail:  userId ? undefined : email,
      guestPhone:  userId ? undefined : phone,
      items: priced.items, subtotal: srvSubtotal, deliveryCharge: srvDelivery, total: srvTotal,
      // deliveryAddress is required at the schema level (shared with email orders) —
      // WhatsApp orders may omit it, so fall back to a placeholder rather than failing.
      deliveryAddress: address && String(address).trim() ? address : "Not provided",
      city, deliverySlot, notes,
      source: "whatsapp",
    });

    const waMessage = "Hi QualiFresh! I'd like to order:\n" +
      priced.items.map(i => `• ${i.name} ×${i.quantity} — ₹${i.price * i.quantity}`).join("\n") +
      `\n\nTotal: ₹${srvTotal}` +
      `\n\nOrder: ${order.orderNumber}\nName: ${name}\nPhone: ${phone}` +
      (address && String(address).trim() ? `\nAddress: ${address}, ${city}` : `\nCity: ${city}`) +
      `\nDelivery Slot: ${deliverySlot}`;
    const whatsappMessageUrl = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(waMessage)}`;

    res.status(201).json({ orderId: order._id, orderNumber: order.orderNumber, whatsappMessageUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to place WhatsApp order" });
  }
});

export default router;
