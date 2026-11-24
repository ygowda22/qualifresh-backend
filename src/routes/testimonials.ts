import { Router } from "express";
import { Testimonial } from "../models/Testimonial";
import { adminOnly } from "../middleware/auth";
import { sanitizeText } from "../utils/sanitize";
import { cleanupImagesLater, imageUrlsOf } from "../services/imageCleanup";

const router = Router();

function buildImages(input: any) {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, 4)
    .map((im: any) => ({
      url: typeof im?.url === "string" ? im.url : "",
      alt: sanitizeText(im?.alt, 100),
    }))
    .filter((im: { url: string }) => im.url);
}

function buildBody(req: any) {
  return {
    name:      sanitizeText(req.body.name, 80),
    role:      sanitizeText(req.body.role, 80),
    message:   sanitizeText(req.body.message, 220),
    location:  sanitizeText(req.body.location, 80),
    rating:    Math.min(5, Math.max(1, Number(req.body.rating) || 5)),
    avatarUrl: typeof req.body.avatarUrl === "string" ? req.body.avatarUrl : "",
    images:    buildImages(req.body.images),
    isActive:  req.body.isActive !== false,
    sortOrder: Number(req.body.sortOrder) || 0,
  };
}

// Public: GET /api/testimonials — only active, sorted for display
router.get("/", async (_req, res) => {
  try {
    const items = await Testimonial.find({ isActive: true }).sort({ sortOrder: 1, createdAt: -1 });
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch testimonials" });
  }
});

// Admin: GET /api/testimonials/all — everything including inactive
router.get("/all", adminOnly, async (_req, res) => {
  try {
    const items = await Testimonial.find({}).sort({ sortOrder: 1, createdAt: -1 });
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch testimonials" });
  }
});

// Admin: POST /api/testimonials
router.post("/", adminOnly, async (req, res) => {
  try {
    const body = buildBody(req);
    if (!body.name || !body.message) {
      return res.status(400).json({ message: "name and message are required" });
    }
    const item = await Testimonial.create(body);
    res.status(201).json(item);
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: "Failed to create testimonial" });
  }
});

// Admin: PUT /api/testimonials/:id
router.put("/:id", adminOnly, async (req, res) => {
  try {
    const body = buildBody(req);
    if (!body.name || !body.message) {
      return res.status(400).json({ message: "name and message are required" });
    }
    const before = await Testimonial.findById(req.params.id).lean();
    const item = await Testimonial.findByIdAndUpdate(req.params.id, body, { new: true });
    if (!item) return res.status(404).json({ message: "Not found" });
    res.json(item);
    cleanupImagesLater(imageUrlsOf(before), `testimonial ${item._id} update`);
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: "Failed to update testimonial" });
  }
});

// Admin: DELETE /api/testimonials/:id
router.delete("/:id", adminOnly, async (req, res) => {
  try {
    const item = await Testimonial.findByIdAndDelete(req.params.id);
    if (!item) return res.status(404).json({ message: "Not found" });
    res.json({ message: "Deleted" });
    cleanupImagesLater(imageUrlsOf(item), `testimonial ${item._id} delete`);
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: "Failed to delete testimonial" });
  }
});

export default router;
