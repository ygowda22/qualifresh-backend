import { Router } from "express";
import { Product } from "../models/Product";
import { authMiddleware } from "../middleware/auth";
import { deleteImage, isGcsUrl } from "../services/imageStorage";

// Delete an image unless another product still points at it. Never throws:
// a failed cleanup must not fail the request (it only leaves an orphan).
async function deleteImageIfUnused(url: string | undefined, exceptProductId: unknown) {
  if (!url) return;
  try {
    const clean = url.split("?")[0];
    const stillUsed = await Product.exists({ _id: { $ne: exceptProductId }, imageUrl: clean });
    if (!stillUsed) await deleteImage(clean);
  } catch (err) {
    console.error("Image delete error (non-fatal):", err);
  }
}

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
      new: false // return the previous version so a replaced image can be cleaned up
    });
    if (!product) return res.status(404).json({ message: "Not found" });
    const oldUrl = product.imageUrl;
    const updated = await Product.findById(req.params.id);
    // GCS images get a new unique key on every upload, so delete the replaced
    // one. Cloudinary product images are overwritten in place on upload, and
    // older Cloudinary originals are kept (the GCS migration's --rollback needs them).
    if (oldUrl && updated && isGcsUrl(oldUrl) && oldUrl.split("?")[0] !== (updated.imageUrl || "").split("?")[0]) {
      await deleteImageIfUnused(oldUrl, product._id);
    }
    res.json(updated);
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
    // Same rule as before for Cloudinary (only images uploaded with a recorded
    // imagePublicId are destroyed); GCS images are always ours, so delete them too.
    if (product.imagePublicId || isGcsUrl(product.imageUrl)) {
      await deleteImageIfUnused(product.imageUrl, product._id);
    }
    res.json({ message: "Deleted" });
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: "Failed to delete product" });
  }
});

export default router;