import { Router } from "express";
import mongoose from "mongoose";
import { Order } from "../models/Order";
import { User } from "../models/User";
import { authMiddleware, adminOnly, AuthRequest, customerIdFromToken } from "../middleware/auth";
import { priceOrderItems, computeTotals, MAX_QUANTITY } from "../config/pricing";
import { Product } from "../models/Product";
import { sendOrderConfirmation, sendAdminOrderNotification, sendOrderStatusUpdate } from "../services/email";

const router = Router();

// POST /api/orders — place order (public, guest or logged-in)
router.post("/", async (req, res) => {
  try {
    const {
      items, subtotal, deliveryCharge, total,
      deliveryAddress, city, deliverySlot, notes,
      guestName, guestEmail, guestPhone, source,
    } = req.body; // any userId in the body is ignored — the account comes only from the login token

    if (!items?.length || !deliveryAddress || !deliverySlot)
      return res.status(400).json({ message: "Missing required fields" });

    // Items, prices and totals come from the database; a stale cart gets 409 PRICES_CHANGED.
    const priced = await priceOrderItems(items, { subtotal, total });
    if (!priced.ok) return res.status(priced.status).json(priced.body);
    const { subtotal: srvSubtotal, deliveryCharge: srvDelivery, total: srvTotal } = priced.totals;
    const userId = await customerIdFromToken(req);

    const order = await Order.create({
      user:           userId || undefined,
      guestName:      userId ? undefined : guestName,
      guestEmail:     userId ? undefined : guestEmail,
      guestPhone:     userId ? undefined : guestPhone,
      items: priced.items, subtotal: srvSubtotal, deliveryCharge: srvDelivery, total: srvTotal,
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
        items: priced.items, subtotal: srvSubtotal, deliveryCharge: srvDelivery, total: srvTotal, deliverySlot, deliveryAddress,
      }).catch(console.error);
    }

    sendAdminOrderNotification({
      orderNumber: order.orderNumber,
      customerName, customerEmail, customerPhone,
      items: priced.items, total: srvTotal, deliveryAddress, deliverySlot, notes,
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

// GET /api/orders/my — the logged-in customer's own orders: ONLY orders linked to the account.
// (No email matching: sign-up doesn't verify email, so matching guest orders by email could show
// someone else's orders.)
router.get("/my", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const orders = await Order.find({ user: req.user!.id }).sort({ createdAt: -1 });
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

// ── PATCH /api/orders/:id/items — admin: edit an order's items ──────────────
// Body: { items: [{ productId, name, slug, quantity, price }], expectedUpdatedAt }.
// The server recalculates subtotal, delivery and total (shared rule in config/pricing.ts) and
// ignores any totals sent. Lines already in the order keep their stored name/slug (and may stay
// even if the product was since deleted); new lines take name/slug from the database. Prices are
// the admin's (the UI pre-fills stored prices for existing lines and current DB prices for new
// ones). Only pending / confirmed / out_for_delivery orders can be edited. The write is atomic
// and only succeeds if the order is unchanged since expectedUpdatedAt.
const EDITABLE_STATUSES = ["pending", "confirmed", "out_for_delivery"];
const NOT_EDITABLE_LABEL: Record<string, string> = { delivered: "Delivered", cancelled: "Cancelled" };
const ITEM_FIELDS = new Set(["productId", "name", "slug", "quantity", "price", "weightKg"]);
const MIN_WEIGHT_KG = 0.05, MAX_WEIGHT_KG = 50;
const MAX_EDIT_LINES = 200;
const MAX_LINE_PRICE = 100000;
const CONFLICT = { code: "CONFLICT", message: "This order was changed by someone else. Reload and try again." };

router.patch("/:id/items", adminOnly, async (req: AuthRequest, res) => {
  const bad = (message: string, field?: string) => res.status(400).json({ message, ...(field ? { field } : {}) });
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "Order not found" });
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return bad("Invalid request body");
    for (const k of Object.keys(body)) if (k !== "items" && k !== "expectedUpdatedAt") return bad(`Unknown field "${k}"`);
    const { items, expectedUpdatedAt } = body;
    if (typeof expectedUpdatedAt !== "string" || isNaN(Date.parse(expectedUpdatedAt))) return bad("expectedUpdatedAt is required", "expectedUpdatedAt");
    if (!Array.isArray(items) || items.length === 0) return bad("An order needs at least one item.", "items");
    if (items.length > MAX_EDIT_LINES) return bad(`An order can have at most ${MAX_EDIT_LINES} items.`, "items");

    // Shape + value checks for every line
    for (const [n, it] of items.entries()) {
      const at = `items.${n}`;
      if (!it || typeof it !== "object" || Array.isArray(it)) return bad(`Item ${n + 1} is invalid`, at);
      for (const k of Object.keys(it)) if (!ITEM_FIELDS.has(k)) return bad(`Unknown field "${k}" in item ${n + 1}`, `${at}.${k}`);
      const q = it.quantity, p = it.price;
      if (typeof q !== "number" || !Number.isInteger(q) || q < 1 || q > MAX_QUANTITY)
        return bad(`Quantity must be a whole number from 1 to ${MAX_QUANTITY}`, `${at}.quantity`);
      if (typeof p !== "number" || !Number.isFinite(p) || p <= 0 || p > MAX_LINE_PRICE || Math.abs(p * 100 - Math.round(p * 100)) > 1e-6)
        return bad(`Price must be more than ₹0 and at most ₹${MAX_LINE_PRICE}, with up to 2 decimals`, `${at}.price`);
      if (it.productId !== undefined && it.productId !== null) {
        if (typeof it.productId !== "string" || !mongoose.isValidObjectId(it.productId)) return bad(`Item ${n + 1} has an invalid product`, `${at}.productId`);
      }
      if (it.name !== undefined && typeof it.name !== "string") return bad(`Item ${n + 1} has an invalid name`, `${at}.name`);
      if (it.slug !== undefined && typeof it.slug !== "string") return bad(`Item ${n + 1} has an invalid slug`, `${at}.slug`);
      const w = it.weightKg;
      if (w !== undefined && w !== null && (typeof w !== "number" || !Number.isFinite(w) || w < MIN_WEIGHT_KG || w > MAX_WEIGHT_KG || Math.abs(w * 100 - Math.round(w * 100)) > 1e-6))
        return bad(`Weight must be between ${MIN_WEIGHT_KG} and ${MAX_WEIGHT_KG} kg, with up to 2 decimals`, `${at}.weightKg`);
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (!EDITABLE_STATUSES.includes(order.status)) {
      const label = NOT_EDITABLE_LABEL[order.status] || "This";
      return res.status(409).json({ code: "NOT_EDITABLE", message: `${label} orders can't be edited.` });
    }
    // Version = updatedAt (older documents without it fall back to createdAt, which the UI then sends)
    const version: Date | undefined = (order as any).updatedAt || order.createdAt;
    if (!version || new Date(expectedUpdatedAt).getTime() !== new Date(version).getTime()) return res.status(409).json(CONFLICT);

    // Build the new lines. Stored lines are matched by product id (lines without one by name).
    // A product may appear on several lines only if the stored order already had it that many
    // times (old orders with the same product at different prices); new duplicates are refused.
    const storedById = new Map<string, any[]>(), storedLegacy = new Map<string, any[]>();
    for (const l of order.items as any[]) {
      const map = l.productId ? storedById : storedLegacy, key = l.productId ? String(l.productId) : l.name;
      map.set(key, [...(map.get(key) || []), l]);
    }
    // products to look up: newly added lines, and every line with a weight (to check it is sold per kg)
    const hasWeight = (i: any) => typeof i.weightKg === "number";
    const newIds = (items as any[]).filter(i => i.productId && (!storedById.has(i.productId) || hasWeight(i))).map(i => i.productId);
    const products = newIds.length ? await Product.find({ _id: { $in: newIds } }).select("name slug priceUnit").lean() : [];
    const productById = new Map(products.map((p: any) => [String(p._id), p]));
    const used = new Map<string, number>();
    const take = (key: string, stored: any[] | undefined) => { const i = used.get(key) || 0; used.set(key, i + 1); return { i, line: stored?.[i] }; };
    const lines: { productId?: mongoose.Types.ObjectId; name: string; slug: string; quantity: number; price: number; weightKg?: number }[] = [];
    for (const [n, it] of (items as any[]).entries()) {
      if (hasWeight(it) && (!it.productId || (productById.get(it.productId) as any)?.priceUnit !== "per_kg"))
        return bad(`Item ${n + 1}: weight can only be set on items sold per kg`, `items.${n}.weightKg`);
      const weight = hasWeight(it) ? { weightKg: it.weightKg } : {};
      if (it.productId) {
        const stored = storedById.get(it.productId);
        const { i, line: old } = take(`id:${it.productId}`, stored);
        if (i > 0 && !old) return bad(`A product appears twice in the order (item ${n + 1})`, `items.${n}.productId`);
        if (old) { lines.push({ productId: old.productId, name: old.name, slug: old.slug, quantity: it.quantity, price: it.price, ...weight }); continue; }
        const p: any = productById.get(it.productId);
        if (!p) return bad(`Item ${n + 1}: this product no longer exists. Remove it and try again.`, `items.${n}.productId`);
        lines.push({ productId: p._id, name: p.name, slug: p.slug, quantity: it.quantity, price: it.price, ...weight });
      } else {
        // A line without a product id can only be an existing (legacy) line, matched by its stored name
        const { line: old } = typeof it.name === "string" ? take(`name:${it.name}`, storedLegacy.get(it.name)) : { line: undefined };
        if (!old) return bad(`Item ${n + 1} is not a catalogue product`, `items.${n}.productId`);
        lines.push({ name: old.name, slug: old.slug, quantity: it.quantity, price: it.price });
      }
    }

    const totals = computeTotals(lines);
    const snapshot = (o: any) => ({
      items: o.items.map((l: any) => ({ ...(l.productId ? { productId: l.productId } : {}), name: l.name, slug: l.slug, quantity: l.quantity, price: l.price, ...(typeof l.weightKg === "number" ? { weightKg: l.weightKg } : {}) })),
      subtotal: o.subtotal, deliveryCharge: o.deliveryCharge, total: o.total,
    });
    const audit = { editedAt: new Date(), editedBy: req.user?.email || String(req.user?.id || "admin"), before: snapshot(order), after: snapshot({ items: lines, ...totals }) };

    // Atomic: only if nobody changed the order (or its status) since it was loaded.
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, updatedAt: (order as any).updatedAt ?? { $exists: false }, status: { $in: EDITABLE_STATUSES } },
      { $set: { items: lines, subtotal: totals.subtotal, deliveryCharge: totals.deliveryCharge, total: totals.total }, $push: { editHistory: audit } },
      { new: true, runValidators: true }
    ).populate("user", "name email phone");
    if (!updated) return res.status(409).json(CONFLICT);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update order" });
  }
});

export default router;
