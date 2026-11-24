import { Router } from "express";
import { FarmPhoto } from "../models/FarmPhoto";
import { adminOnly } from "../middleware/auth";
import { singleImage } from "../middleware/imageUpload";
import { storeImage, InvalidImageError } from "../services/imageStorage";
import { cleanupImagesLater, imageUrlsOf } from "../services/imageCleanup";


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

// Admin: POST /api/farms/upload — image upload + MongoDB save in one step
router.post("/upload", adminOnly, singleImage(), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "No image file provided" });
  try {
    const { title = "", description = "", id } = req.body;
    const result = await storeImage(req.file.buffer, "qualifresh-farms", "farm");
    const imageUrl = result.url;
    let photo;
    let before = null;
    if (id) {
      // This route also saves the farm photo, so it is where the old image is released.
      before = await FarmPhoto.findById(id).lean();
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
    cleanupImagesLater(imageUrlsOf(before), `farm photo ${photo._id} image upload`);
  } catch (err) {
    if (err instanceof InvalidImageError) return res.status(400).json({ message: err.message });
    console.error("Farm upload error:", err);
    res.status(500).json({ message: "Upload failed" });
  }
});

// Admin: POST /api/farms
router.post("/", adminOnly, async (req, res) => {
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
router.put("/:id", adminOnly, async (req, res) => {
  try {
    const { title, description, imageUrl, order } = req.body;
    const before = await FarmPhoto.findById(req.params.id).lean();
    const photo = await FarmPhoto.findByIdAndUpdate(
      req.params.id,
      { title, description, imageUrl, order },
      { new: true }
    );
    if (!photo) return res.status(404).json({ message: "Not found" });
    res.json(photo);
    cleanupImagesLater(imageUrlsOf(before), `farm photo ${photo._id} update`);
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: "Failed to update farm photo" });
  }
});

// Admin: DELETE /api/farms/:id
router.delete("/:id", adminOnly, async (req, res) => {
  try {
    const photo = await FarmPhoto.findByIdAndDelete(req.params.id);
    if (!photo) return res.status(404).json({ message: "Not found" });
    res.json({ message: "Deleted" });
    cleanupImagesLater(imageUrlsOf(photo), `farm photo ${photo._id} delete`);
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: "Failed to delete farm photo" });
  }
});

export default router;
