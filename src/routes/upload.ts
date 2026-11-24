import { Router, Request, Response } from "express";
import path from "path";
import { adminOnly } from "../middleware/auth";
import { singleImage } from "../middleware/imageUpload";
import { storeImage, InvalidImageError, OWN_FOLDERS } from "../services/imageStorage";


const router = Router();

// POST /api/upload — admin only
router.post("/", adminOnly, singleImage(), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ message: "No file uploaded" });

  try {
    const ext      = path.extname(req.file.originalname).toLowerCase();
    const slug     = req.body.slug as string | undefined;
    const baseName = slug
      ? slug.replace(/[^a-z0-9-]/gi, "-").toLowerCase()
      : path.basename(req.file.originalname, ext).replace(/\s+/g, "-").toLowerCase();
    const folder   = (req.body.folder as string) || "qualifresh-products";
    if (!OWN_FOLDERS.has(folder)) return res.status(400).json({ message: `Unknown upload folder "${folder}"` });

    // Always a NEW unique name (<slug or filename>-<timestamp>); nothing is overwritten.
    // The previous image is NOT deleted here — the upload may still be cancelled.
    // It is removed by the product/category/farm/testimonial save route after the DB update.
    const result = await storeImage(req.file.buffer, folder, baseName);

    return res.json({ url: result.url, filename: result.id });
  } catch (err) {
    if (err instanceof InvalidImageError) return res.status(400).json({ message: err.message });
    console.error("Image upload error:", err);
    return res.status(500).json({ message: "Upload failed" });
  }
});

export default router;
