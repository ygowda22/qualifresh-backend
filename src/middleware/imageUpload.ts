import type { Request, Response, NextFunction } from "express";
import multer from "multer";
import { UNSUPPORTED_IMAGE_MESSAGE } from "../services/imageStorage";

/** Browser-reported MIME types accepted for admin image uploads. */
export const ALLOWED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_MIME.has(file.mimetype)) cb(null, true);
    else cb(new Error(UNSUPPORTED_IMAGE_MESSAGE));
  },
});

/**
 * multer.single("image") with JSON 400 responses instead of Express's default
 * HTML 500 page, so the admin UI can show the reason to the user.
 * (The actual bytes are checked again with sharp in storeImage().)
 */
export function singleImage(field = "image") {
  const handler = upload.single(field);
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ message: "Image is too large (max 10 MB)" });
      }
      const message = err instanceof Error ? err.message : "Upload failed";
      return res.status(400).json({ message });
    });
  };
}
