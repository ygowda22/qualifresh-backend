import { Router } from "express";
import { Order } from "../models/Order";
import { Product } from "../models/Product";

const router = Router();

const WHATSAPP_NUMBER = "917276369948";

// POST /api/whatsapp-order — logs a WhatsApp order (guest or logged-in), then returns the
// WhatsApp message URL to redirect to. The frontend must not open WhatsApp until this responds.
router.post("/", async (req, res) => {
  try {
    const {
      items, subtotal, deliveryCharge, total,
      address, city, deliverySlot, notes,
      name, phone, email, userId,
    } = req.body;

    if (!items?.length || !deliverySlot || !name || !phone || !city)
      return res.status(400).json({ message: "Missing required fields" });

    const productIds = items.map((i: { productId: string }) => i.productId).filter(Boolean);
    const outOfStock = await Product.find({ _id: { $in: productIds }, stock: 0 }).select("name");
    if (outOfStock.length) {
      return res.status(400).json({
        message: `Out of stock: ${outOfStock.map(p => p.name).join(", ")}. Remove to proceed.`,
      });
    }

    const order = await Order.create({
      user:        userId || undefined,
      guestName:   userId ? undefined : name,
      guestEmail:  userId ? undefined : email,
      guestPhone:  userId ? undefined : phone,
      items, subtotal, deliveryCharge, total,
      // deliveryAddress is required at the schema level (shared with email orders) —
      // WhatsApp orders may omit it, so fall back to a placeholder rather than failing.
      deliveryAddress: address && String(address).trim() ? address : "Not provided",
      city, deliverySlot, notes,
      source: "whatsapp",
    });

    const waMessage = "Hi QualiFresh! I'd like to order:\n" +
      items.map((i: { name: string; quantity: number; price: number }) => `• ${i.name} ×${i.quantity} — ₹${i.price * i.quantity}`).join("\n") +
      `\n\nTotal: ₹${total}` +
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
