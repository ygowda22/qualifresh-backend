import { Router } from "express";
import mongoose from "mongoose";
import { Order } from "../models/Order";
import { Product } from "../models/Product";
import { User } from "../models/User";
import { authMiddleware, adminOnly, AuthRequest } from "../middleware/auth";
import { sendOrderConfirmation, sendAdminOrderNotification, sendOrderStatusUpdate } from "../services/email";

const router = Router();

// POST /api/orders — place order (public, guest or logged-in)
router.post("/", async (req, res) => {
  try {
    const {
      items, subtotal, deliveryCharge, total,
      deliveryAddress, city, deliverySlot, notes,
      guestName, guestEmail, guestPhone, userId, source,
    } = req.body;

    if (!items?.length || !deliveryAddress || !deliverySlot)
      return res.status(400).json({ message: "Missing required fields" });

    const productIds = items.map((i: { productId: string }) => i.productId).filter(Boolean);
    const outOfStock = await Product.find({ _id: { $in: productIds }, stock: 0 }).select("name");
    if (outOfStock.length) {
      return res.status(400).json({
        message: `Out of stock: ${outOfStock.map(p => p.name).join(", ")}. Remove to proceed.`,
      });
    }

    const order = await Order.create({
      user:           userId || undefined,
      guestName:      userId ? undefined : guestName,
      guestEmail:     userId ? undefined : guestEmail,
      guestPhone:     userId ? undefined : guestPhone,
      items, subtotal, deliveryCharge, total,
      deliveryAddress, city: city || "Pune", deliverySlot, notes,
      source: source === "whatsapp" ? "whatsapp" : "website",
    });

    // Send emails (non-blocking). For a logged-in order, always use the account's own
    // identity — never the (possibly stale or blank) guest form fields — so the confirmation
    // email is never skipped or sent to the wrong address for logged-in customers.
    let customerEmail = guestEmail || "";
    let customerName  = guestName  || "Customer";
    let customerPhone = guestPhone || "";

    if (userId) {
      const account = await User.findById(userId).select("name email phone");
      if (account) {
        customerEmail = account.email;
        customerName  = account.name;
        customerPhone = account.phone;
      }
    }

    if (customerEmail) {
      sendOrderConfirmation(customerEmail, customerName, {
        orderNumber: order.orderNumber,
        items, subtotal, deliveryCharge, total, deliverySlot, deliveryAddress,
      }).catch(console.error);
    }

    sendAdminOrderNotification({
      orderNumber: order.orderNumber,
      customerName, customerEmail, customerPhone,
      items, total, deliveryAddress, deliverySlot, notes,
    }).catch(console.error);

    res.status(201).json({ success: true, orderNumber: order.orderNumber, orderId: order._id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to place order" });
  }
});

// GET /api/orders — admin: all orders
router.get("/", adminOnly, async (req: AuthRequest, res) => {
  try {
    const orders = await Order.find()
      .populate("user", "name email phone")
      .sort({ createdAt: -1 })
      .limit(500);
    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch orders" });
  }
});

// GET /api/orders/my — get logged-in user orders (by userId ref OR by email for legacy orders)
router.get("/my", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const orders = await Order.find({
      $or: [
        { user: req.user!.id },
        { guestEmail: req.user!.email },
      ],
    }).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch orders" });
  }
});

// PUT /api/orders/:id/status — admin: update status
router.put("/:id/status", adminOnly, async (req, res) => {
  try {
    const { status } = req.body;
    const order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true }).populate("user", "name email");
    if (!order) return res.status(404).json({ message: "Not found" });

    // Send status update email to customer (non-blocking)
    const customerEmail = (order as any).guestEmail || (order as any).user?.email || "";
    const customerName  = (order as any).guestName  || (order as any).user?.name  || "Customer";
    if (customerEmail) {
      sendOrderStatusUpdate(customerEmail, customerName, {
        orderNumber:  (order as any).orderNumber,
        status,
        deliverySlot: (order as any).deliverySlot,
        total:        (order as any).total,
      }).catch(console.error);
    }

    res.json(order);
  } catch (err) {
    res.status(500).json({ message: "Failed to update order" });
  }
});

// DELETE /api/orders/:id — admin: delete order
router.delete("/:id", adminOnly, async (req, res) => {
  try {
    const order = await Order.findByIdAndDelete(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Recalculate the order-number counter from what's left after this deletion, so the
    // next order continues from the highest remaining number instead of leaving a gap.
    // Only runs here — normal order placement (email/WhatsApp) still uses the atomic
    // counter increment in Order.ts untouched.
    const remaining = await Order.find({}).select("orderNumber").lean();
    let highest = 0;
    for (const o of remaining) {
      const m = /^QF-(\d+)$/.exec((o as { orderNumber?: string }).orderNumber || "");
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > highest) highest = n;
      }
    }
    const db = mongoose.connection.db!;
    await db.collection<{ _id: string; seq: number }>("counters").updateOne(
      { _id: "orderNumber" },
      { $set: { seq: highest } },
      { upsert: true }
    );

    res.json({ message: "Order deleted" });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete order" });
  }
});

// GET /api/orders/analytics — admin: dashboard stats
router.get("/analytics", adminOnly, async (req: AuthRequest, res) => {
  try {
    const [totalOrders, totalRevenue, statusBreakdown, recentOrders, dailyOrders] = await Promise.all([
      Order.countDocuments(),
      Order.aggregate([{ $group: { _id: null, total: { $sum: "$total" } } }]),
      Order.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      Order.find().sort({ createdAt: -1 }).limit(10).populate("user", "name email"),
      Order.aggregate([
        { $match: { createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 }, revenue: { $sum: "$total" } } },
        { $sort: { _id: 1 } },
      ]),
    ]);
    res.json({
      totalOrders,
      totalRevenue: totalRevenue[0]?.total || 0,
      statusBreakdown,
      recentOrders,
      dailyOrders,
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch analytics" });
  }
});

export default router;
