import { Router, Request, Response } from "express";
import multer from "multer";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { authMiddleware } from "../middleware/auth";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const BUCKET = "product-images";

// Keep file in memory — no disk writes needed
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const allowed = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

const router = Router();

// POST /api/upload — admin only
router.post("/", authMiddleware, upload.single("image"), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ message: "No file uploaded" });

  try {
    const ext      = path.extname(req.file.originalname).toLowerCase();
    const baseName = path.basename(req.file.originalname, ext).replace(/\s+/g, "-").toLowerCase();
    const fileName = `${baseName}-${Date.now()}${ext}`;

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    if (error) {
      console.error("Supabase upload error:", error);
      return res.status(500).json({ message: "Storage upload failed", detail: error.message });
    }

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(fileName);
    return res.json({ url: data.publicUrl, filename: fileName });
  } catch (err) {
    console.error("Upload error:", err);
    return res.status(500).json({ message: "Upload failed" });
  }
});

export default router;
