import { Router } from "express";
import { User } from "../models/User";
import { authMiddleware } from "../middleware/auth";

const router = Router();

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
