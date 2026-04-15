import { Router } from "express";
import { Order } from "../models/Order";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { sendOrderConfirmation, sendAdminOrderNotification, sendOrderStatusUpdate } from "../services/email";

const router = Router();

// POST /api/orders — place order (public, guest or logged-in)
router.post("/", async (req, res) => {
  try {
    const {
      items, subtotal, deliveryCharge, total,
      deliveryAddress, city, deliverySlot, notes,
      guestName, guestEmail, guestPhone, userId,
    } = req.body;

    if (!items?.length || !deliveryAddress || !deliverySlot)
      return res.status(400).json({ message: "Missing required fields" });

    const order = await Order.create({
      user:           userId || undefined,
      guestName:      userId ? undefined : guestName,
      guestEmail:     userId ? undefined : guestEmail,
      guestPhone:     userId ? undefined : guestPhone,
      items, subtotal, deliveryCharge, total,
      deliveryAddress, city: city || "Pune", deliverySlot, notes,
    });

    // Send emails (non-blocking)
    const customerEmail = guestEmail || "";
    const customerName  = guestName  || "Customer";
    const customerPhone = guestPhone || "";

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
router.get("/", authMiddleware, async (req: AuthRequest, res) => {
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

// GET /api/orders/my — get logged-in user orders
router.get("/my", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const orders = await Order.find({ user: req.user!.id }).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch orders" });
  }
});

// PUT /api/orders/:id/status — admin: update status
router.put("/:id/status", authMiddleware, async (req, res) => {
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

// GET /api/orders/analytics — admin: dashboard stats
router.get("/analytics", authMiddleware, async (req: AuthRequest, res) => {
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
