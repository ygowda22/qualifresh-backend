import { Router, Request, Response } from "express";
import path from "path";
import { authMiddleware } from "../middleware/auth";
import { singleImage } from "../middleware/imageUpload";
import { storeImage, InvalidImageError } from "../services/imageStorage";


const router = Router();

// POST /api/upload — admin only
router.post("/", authMiddleware, singleImage(), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ message: "No file uploaded" });

  try {
    const ext      = path.extname(req.file.originalname).toLowerCase();
    const slug     = req.body.slug as string | undefined;
    const baseName = slug
      ? slug.replace(/[^a-z0-9-]/gi, "-").toLowerCase()
      : path.basename(req.file.originalname, ext).replace(/\s+/g, "-").toLowerCase();
    const folder   = (req.body.folder as string) || "qualifresh-products";

    // Product images get a deterministic id keyed by slug so re-uploading
    // (edit) replaces the product's image instead of orphaning the old one
    // (see StoreOptions.replaceInPlace for how each provider does this).
    // Requires an actual slug (not the filename fallback) — two products could
    // otherwise share a filename like "photo.jpg" and overwrite each other's image.
    const isProductUpload = folder === "qualifresh-products" && !!slug;
    const result = isProductUpload
      ? await storeImage(req.file.buffer, folder, baseName, { replaceInPlace: true })
      : await storeImage(req.file.buffer, folder, `${baseName}-${Date.now()}`);

    return res.json({ url: result.url, filename: result.id });
  } catch (err) {
    if (err instanceof InvalidImageError) return res.status(400).json({ message: err.message });
    console.error("Image upload error:", err);
    return res.status(500).json({ message: "Upload failed" });
  }
});

export default router;
