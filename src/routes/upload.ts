import { Router, Request, Response } from "express";
import multer from "multer";
import path from "path";
import { v2 as cloudinary } from "cloudinary";
import { authMiddleware } from "../middleware/auth";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const ALLOWED_EXT = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXT.includes(ext)) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

function streamUpload(
  buffer: Buffer,
  options: object
): Promise<{ secure_url: string; public_id: string }> {
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

// POST /api/upload — admin only
router.post("/", authMiddleware, upload.single("image"), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ message: "No file uploaded" });

  try {
    const ext      = path.extname(req.file.originalname).toLowerCase();
    const slug     = req.body.slug as string | undefined;
    const baseName = slug
      ? slug.replace(/[^a-z0-9-]/gi, "-").toLowerCase()
      : path.basename(req.file.originalname, ext).replace(/\s+/g, "-").toLowerCase();
    const folder   = (req.body.folder as string) || "qualifresh-products";

    // Product images get a deterministic public_id keyed by slug so re-uploading
    // (edit) overwrites the same Cloudinary asset in place instead of creating a
    // new one and orphaning the old one. Requires an actual slug (not the
    // filename fallback) — two products could otherwise share a filename like
    // "photo.jpg" and silently overwrite each other's image.
    const isProductUpload = folder === "qualifresh-products" && !!slug;
    const uploadOptions: Record<string, unknown> = isProductUpload
      ? {
          folder,
          public_id:     baseName,
          overwrite:     true,
          invalidate:    true,
          resource_type: "image",
          transformation: [{ width: 1600, crop: "limit", quality: "auto", fetch_format: "auto" }],
        }
      : {
          folder,
          public_id:     `${baseName}-${Date.now()}`,
          resource_type: "image",
        };

    const result = await streamUpload(req.file.buffer, uploadOptions);

    return res.json({ url: result.secure_url, filename: result.public_id });
  } catch (err) {
    console.error("Cloudinary upload error:", err);
    return res.status(500).json({ message: "Upload failed" });
  }
});

export default router;
