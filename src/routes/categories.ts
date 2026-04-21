import { Router } from "express";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { Category } from "../models/Category";
import { authMiddleware } from "../middleware/auth";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function streamUpload(buffer: Buffer, options: object): Promise<{ secure_url: string; public_id: string }> {
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(options, (error, result) => {
        if (error || !result) reject(error ?? new Error("No result from Cloudinary"));
        else resolve(result as { secure_url: string; public_id: string });
      })
      .end(buffer);
  });
}

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

// Admin: POST /api/categories/upload — Cloudinary upload + MongoDB upsert in one step
router.post("/upload", authMiddleware, upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "No image file provided" });
  try {
    const { key, label, color = "#2d8a4e", icon = "🥦", isCustom = "true", order = "0" } = req.body;
    if (!key || !label) return res.status(400).json({ message: "key and label are required" });
    const result = await streamUpload(req.file.buffer, {
      folder:        "qualifresh-categories",
      public_id:     `cat-${key}-${Date.now()}`,
      resource_type: "image",
    });
    const cat = await Category.findOneAndUpdate(
      { key },
      { key, label, imageUrl: result.secure_url, color, icon, isCustom: isCustom === "true" || isCustom === true, order: Number(order) },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.status(200).json(cat);
  } catch (err) {
    console.error("Category upload error:", err);
    res.status(500).json({ message: "Upload failed" });
  }
});

// Admin: POST /api/categories — upsert by key (handles create + update)
router.post("/", authMiddleware, async (req, res) => {
  try {
    const { key, label, imageUrl = "", color = "#2d8a4e", icon = "🥦", isCustom = true, order = 0 } = req.body;
    if (!key || !label) return res.status(400).json({ message: "key and label are required" });
    const cat = await Category.findOneAndUpdate(
      { key },
      { key, label, imageUrl, color, icon, isCustom, order },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.status(200).json(cat);
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: "Failed to save category" });
  }
});

// Admin: DELETE /api/categories/key/:key
router.delete("/key/:key", authMiddleware, async (req, res) => {
  try {
    await Category.findOneAndDelete({ key: req.params.key });
    res.json({ message: "Deleted" });
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: "Failed to delete category" });
  }
});

export default router;
