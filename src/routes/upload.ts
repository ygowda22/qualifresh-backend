import { Router, Request, Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { authMiddleware } from "../middleware/auth";

const uploadsDir = path.join(__dirname, "../../uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename:    (_req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext).replace(/\s+/g, "-").toLowerCase();
    cb(null, `${name}-${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
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
router.post("/", authMiddleware, upload.single("image"), (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ message: "No file uploaded" });
  const url = `/uploads/${req.file.filename}`;
  res.json({ url, filename: req.file.filename });
});

export default router;
