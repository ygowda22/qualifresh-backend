import { Router } from "express";
import { Product } from "../models/Product";
import { authMiddleware } from "../middleware/auth";

const router = Router();

// Public: GET /api/products  (only active products — for users)
router.get("/", async (req, res) => {
  try {
    const products = await Product.find({ isActive: true }).sort({ name: 1 });
    res.json(products);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch products" });
  }
});

// Admin: GET /api/products/admin/all  (ALL products including inactive — for admin panel)
router.get("/admin/all", authMiddleware, async (req, res) => {
  try {
    const products = await Product.find({}).sort({ name: 1 });
    res.json(products);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch products" });
  }
});

// Public: GET /api/products/:slug  (only active — for users)
router.get("/:slug", async (req, res) => {
  try {
    const product = await Product.findOne({
      slug: req.params.slug,
      isActive: true
    });
    if (!product) return res.status(404).json({ message: "Not found" });
    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch product" });
  }
});

// Admin: POST /api/products
router.post("/", authMiddleware, async (req, res) => {
  try {
    if (!req.body.quantityLabel || req.body.quantityLabel.trim() === "") {
      return res.status(400).json({ error: "quantityLabel is required" });
    }
    const product = await Product.create(req.body);
    res.status(201).json(product);
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: "Failed to create product" });
  }
});

// Admin: PUT /api/products/:id
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(req.params.id, req.body, {
      new: true
    });
    if (!product) return res.status(404).json({ message: "Not found" });
    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: "Failed to update product" });
  }
});

// Admin: DELETE /api/products/:id
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ message: "Not found" });
    res.json({ message: "Deleted" });
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: "Failed to delete product" });
  }
});

export default router;