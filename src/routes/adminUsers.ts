import { Router } from "express";
import { User } from "../models/User";
import { authMiddleware } from "../middleware/auth";
import bcrypt from "bcryptjs";

const router = Router();

// POST /api/admin/users — Create a new user
router.post("/", authMiddleware, async (req, res) => {
  try {
    const { name, email, phone, password, isActive } = req.body;
    if (!name || !email || !phone || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }
    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ message: "Email already exists" });
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, phone, password: hashedPassword, isActive: isActive !== false });
    res.status(201).json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to create user" });
  }
});

// PUT /api/admin/users/:id — Update a user
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const { name, email, phone, password, isActive } = req.body;
    const updates: any = { isActive: isActive !== false };
    if (name) updates.name = name;
    if (email) updates.email = email;
    if (phone) updates.phone = phone;
    if (password) {
      updates.password = await bcrypt.hash(password, 10);
    }
    const user = await User.findByIdAndUpdate(req.params.id, updates, { new: true }).select("-password");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update user" });
  }
});

// GET /api/admin/users
router.get("/", authMiddleware, async (req, res) => {
  try {
    const users = await User.find({ role: "user" }).select("-password").sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch users" });
  }
});

// DELETE /api/admin/users/:id
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete user" });
  }
});

// GET /api/admin/stats
router.get("/stats", authMiddleware, async (req, res) => {
  try {
    const { Order } = await import("../models/Order");
    const [totalUsers, newUsersThisMonth, totalOrders, totalRevenue, topProducts] = await Promise.all([
      User.countDocuments({ role: "user" }),
      User.countDocuments({ role: "user", createdAt: { $gte: new Date(new Date().setDate(1)) } }),
      Order.countDocuments(),
      Order.aggregate([{ $group: { _id: null, total: { $sum: "$total" } } }]),
      Order.aggregate([
        { $unwind: "$items" },
        { $group: { _id: "$items.name", count: { $sum: "$items.quantity" }, revenue: { $sum: { $multiply: ["$items.price", "$items.quantity"] } } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]),
    ]);

    // Repeat customers (users with >1 order)
    const repeatCustomers = await Order.aggregate([
      { $group: { _id: "$user", count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 }, _id: { $ne: null } } },
      { $count: "total" },
    ]);

    res.json({
      totalUsers,
      newUsersThisMonth,
      totalOrders,
      totalRevenue: totalRevenue[0]?.total || 0,
      repeatCustomers: repeatCustomers[0]?.total || 0,
      topProducts,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch stats" });
  }
});

export default router;
