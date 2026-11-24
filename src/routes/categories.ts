import { Router } from "express";
import { Category } from "../models/Category";
import { adminOnly } from "../middleware/auth";
import { singleImage } from "../middleware/imageUpload";
import { storeImage, InvalidImageError } from "../services/imageStorage";
import { cleanupImagesLater, imageUrlsOf } from "../services/imageCleanup";


const router = Router();

// Public: GET /api/categories
router.get("/", async (_req, res) => {
  try {
    const cats = await Category.find({}).sort({ isCustom: 1, order: 1, createdAt: 1 });
    res.json(cats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch categories" });
  }
});

// Admin: POST /api/categories/upload — image upload + MongoDB upsert in one step
router.post("/upload", adminOnly, singleImage(), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "No image file provided" });
  try {
    const { key, label, color = "#2d8a4e", icon = "🥦", isCustom = "true", order = "0" } = req.body;
    if (!key || !label) return res.status(400).json({ message: "key and label are required" });
    const result = await storeImage(req.file.buffer, "qualifresh-categories", `cat-${key}`);
    // This route also saves the category, so it is where the old image is released.
    const before = await Category.findOne({ key }).lean();
    const cat = await Category.findOneAndUpdate(
      { key },
      { key, label, imageUrl: result.url, color, icon, isCustom: isCustom === "true" || isCustom === true, order: Number(order) },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.status(200).json(cat);
    cleanupImagesLater(imageUrlsOf(before), `category ${key} image upload`);
  } catch (err) {
    if (err instanceof InvalidImageError) return res.status(400).json({ message: err.message });
    console.error("Category upload error:", err);
    res.status(500).json({ message: "Upload failed" });
  }
});

// Admin: POST /api/categories — upsert by key (handles create + update)
router.post("/", adminOnly, async (req, res) => {
  try {
    const { key, label, imageUrl = "", color = "#2d8a4e", icon = "🥦", isCustom = true, order = 0 } = req.body;
    if (!key || !label) return res.status(400).json({ message: "key and label are required" });
    const before = await Category.findOne({ key }).lean();
    const cat = await Category.findOneAndUpdate(
      { key },
      { key, label, imageUrl, color, icon, isCustom, order },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.status(200).json(cat);
    cleanupImagesLater(imageUrlsOf(before), `category ${key} save`);
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: "Failed to save category" });
  }
});

// Admin: DELETE /api/categories/key/:key
router.delete("/key/:key", adminOnly, async (req, res) => {
  try {
    const removed = await Category.findOneAndDelete({ key: req.params.key });
    res.json({ message: "Deleted" });
    cleanupImagesLater(imageUrlsOf(removed), `category ${req.params.key} delete`);
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: "Failed to delete category" });
  }
});

export default router;
