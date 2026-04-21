import { Router } from "express";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { FarmPhoto } from "../models/FarmPhoto";
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

// Public: GET /api/farms — returns all farm photos sorted by order then creation date
router.get("/", async (_req, res) => {
  try {
    const photos = await FarmPhoto.find({}).sort({ order: 1, createdAt: 1 });
    res.json(photos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch farm photos" });
  }
});

// Admin: POST /api/farms/upload — Cloudinary upload + MongoDB save in one step
router.post("/upload", authMiddleware, upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "No image file provided" });
  try {
    const { title = "", description = "", id } = req.body;
    const result = await streamUpload(req.file.buffer, {
      folder:        "qualifresh-farms",
      public_id:     `farm-${Date.now()}`,
      resource_type: "image",
    });
    const imageUrl = result.secure_url;
    let photo;
    if (id) {
      photo = await FarmPhoto.findByIdAndUpdate(
        id,
        { title, description, imageUrl },
        { new: true }
      );
      if (!photo) return res.status(404).json({ message: "Farm photo not found" });
    } else {
      photo = await FarmPhoto.create({ title, description, imageUrl });
    }
    res.status(201).json(photo);
  } catch (err) {
    console.error("Farm upload error:", err);
    res.status(500).json({ message: "Upload failed" });
  }
});

// Admin: POST /api/farms
router.post("/", authMiddleware, async (req, res) => {
  try {
    const { title = "", description = "", imageUrl, order = 0 } = req.body;
    if (!imageUrl) return res.status(400).json({ message: "imageUrl is required" });
    const photo = await FarmPhoto.create({ title, description, imageUrl, order });
    res.status(201).json(photo);
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: "Failed to create farm photo" });
  }
});

// Admin: PUT /api/farms/:id
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const { title, description, imageUrl, order } = req.body;
    const photo = await FarmPhoto.findByIdAndUpdate(
      req.params.id,
      { title, description, imageUrl, order },
      { new: true }
    );
    if (!photo) return res.status(404).json({ message: "Not found" });
    res.json(photo);
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: "Failed to update farm photo" });
  }
});

// Admin: DELETE /api/farms/:id
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const photo = await FarmPhoto.findByIdAndDelete(req.params.id);
    if (!photo) return res.status(404).json({ message: "Not found" });
    res.json({ message: "Deleted" });
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: "Failed to delete farm photo" });
  }
});

export default router;
