import { Router } from "express";
import { User } from "../models/User";
import { Product } from "../models/Product";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import jwt from "jsonwebtoken";

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[6-9]\d{9}$/; // Indian mobile: starts with 6-9, 10 digits

// POST /api/users/register
router.post("/register", async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !phone || !password)
      return res.status(400).json({ message: "All fields are required" });

    if (!EMAIL_RE.test(email))
      return res.status(400).json({ message: "Please enter a valid email address" });

    const cleanPhone = String(phone).replace(/\s+/g, "").replace(/^(\+91|91)/, "");
    if (!PHONE_RE.test(cleanPhone))
      return res.status(400).json({ message: "Please enter a valid 10-digit Indian mobile number" });

    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ message: "Email already registered" });

    const user = await User.create({ name, email, phone: cleanPhone, password });
    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET as string,
      { expiresIn: "30d" }
    );
    res.status(201).json({ token, user: { id: user._id, name: user.name, email: user.email, phone: user.phone } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Registration failed" });
  }
});

// POST /api/users/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email, role: "user", isActive: true });
    if (!user) return res.status(401).json({ message: "Invalid credentials" });

    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET as string,
      { expiresIn: "30d" }
    );
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, phone: user.phone } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Login failed" });
  }
});

// PUT /api/users/profile  (authenticated)
router.put("/profile", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { name, phone } = req.body;
    const user = await User.findByIdAndUpdate(
      req.user!.id,
      { ...(name ? { name } : {}), ...(phone ? { phone } : {}) },
      { new: true, select: "-password" }
    );
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ user: { id: user._id, name: user.name, email: user.email, phone: user.phone } });
  } catch (err) {
    res.status(500).json({ message: "Failed to update profile" });
  }
});

// GET /api/users/cart  — return saved cart as plain object { productId: qty }
router.get("/cart", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const user = await User.findById(req.user!.id).select("cart");
    if (!user) return res.status(404).json({ message: "User not found" });
    const cart: Record<string, number> = {};
    user.cart.forEach((qty: number, id: string) => { if (qty > 0) cart[id] = qty; });
    res.json({ cart });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch cart" });
  }
});

// PUT /api/users/cart  — save cart (full replace)
router.put("/cart", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const incoming: Record<string, number> = req.body.cart || {};
    // Sanitise: only positive integer quantities
    const cleaned: Record<string, number> = {};
    Object.entries(incoming).forEach(([k, v]) => {
      const q = Math.floor(Number(v));
      if (q > 0) cleaned[k] = q;
    });
    await User.findByIdAndUpdate(req.user!.id, { $set: { cart: cleaned } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to save cart" });
  }
});

// GET /api/users/wishlist  — returns array of full product objects
router.get("/wishlist", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const user = await User.findById(req.user!.id).populate({
      path: "wishlist",
      model: Product,
      match: { isActive: true },
      select: "_id name slug price imageUrl category quantityLabel stock priceUnit",
    });
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ wishlist: user.wishlist });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch wishlist" });
  }
});

// POST /api/users/wishlist/:productId  — add to wishlist (idempotent)
router.post("/wishlist/:productId", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { productId } = req.params;
    await User.findByIdAndUpdate(
      req.user!.id,
      { $addToSet: { wishlist: productId } }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to add to wishlist" });
  }
});

// DELETE /api/users/wishlist/:productId  — remove from wishlist
router.delete("/wishlist/:productId", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { productId } = req.params;
    await User.findByIdAndUpdate(
      req.user!.id,
      { $pull: { wishlist: productId } }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to remove from wishlist" });
  }
});

export default router;
