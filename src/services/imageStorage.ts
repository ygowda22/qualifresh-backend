/**
 * Single place where uploaded images are stored.
 *
 * STORAGE_PROVIDER=cloudinary (default) → same behaviour as before: original file to Cloudinary.
 * STORAGE_PROVIDER=gcs                  → converted to WebP with sharp and stored in Google Cloud Storage.
 *
 * GCS layout (one upload → two files, the returned URL is the large one):
 *   <folder>/<name>-<timestamp>-400.webp    grid / thumbnail
 *   <folder>/<name>-<timestamp>-1200.webp   detail / lightbox   ← URL saved in MongoDB
 * Testimonial avatars (folder "qualifresh-testimonials") get a single 300x300 smart-cropped square:
 *   <folder>/<name>-<timestamp>-300.webp
 *
 * The frontend helper cldImg() swaps "-1200.webp" for "-400.webp" when it needs a small image.
 *
 * GCS env vars (Render → Environment):
 *   STORAGE_PROVIDER=gcs
 *   GCS_BUCKET=qualifresh-images
 *   GCP_SA_KEY_B64=<base64 of the service-account JSON key>
 */
import { v2 as cloudinary } from "cloudinary";
import { Storage, type Bucket } from "@google-cloud/storage";
import sharp, { type ResizeOptions } from "sharp";

export type StoredImage = { url: string; id: string };

export type StoreOptions = {
  /**
   * One image per owner (e.g. per product slug): on Cloudinary the upload
   * overwrites the same public_id (with CDN invalidation and a 1600px cap)
   * instead of leaving the previous image behind as an orphan.
   * On GCS files are cached as immutable, so overwriting a key would keep
   * showing the old image — a unique timestamped key is used instead and the
   * caller deletes the old one with deleteImage().
   */
  replaceInPlace?: boolean;
};

const AVATAR_FOLDERS = new Set(["qualifresh-testimonials"]);
export const SMALL_WIDTH = 400;
export const LARGE_WIDTH = 1200;
export const AVATAR_SIZE = 300;

export function storageProvider(): "gcs" | "cloudinary" {
  return (process.env.STORAGE_PROVIDER || "cloudinary").toLowerCase() === "gcs" ? "gcs" : "cloudinary";
}

// ── Cloudinary (current) ──────────────────────────────────────────────────────
let cloudinaryReady = false;
function ensureCloudinary() {
  if (cloudinaryReady) return;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  cloudinaryReady = true;
}

function cloudinaryUpload(buffer: Buffer, folder: string, publicId: string, replaceInPlace: boolean): Promise<StoredImage> {
  ensureCloudinary();
  const options: Record<string, unknown> = replaceInPlace
    ? {
        folder,
        public_id:     publicId,
        overwrite:     true,
        invalidate:    true,
        resource_type: "image",
        transformation: [{ width: 1600, crop: "limit", quality: "auto", fetch_format: "auto" }],
      }
    : { folder, public_id: publicId, resource_type: "image" };
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(options, (error, result) => {
        if (error || !result) reject(error ?? new Error("No result from Cloudinary"));
        else resolve({ url: result.secure_url, id: result.public_id });
      })
      .end(buffer);
  });
}

// ── Google Cloud Storage (new) ────────────────────────────────────────────────
let gcsBucket: Bucket | null = null;
function bucket(): Bucket {
  if (gcsBucket) return gcsBucket;
  const keyB64 = process.env.GCP_SA_KEY_B64;
  const name   = process.env.GCS_BUCKET;
  if (!keyB64 || !name) throw new Error("GCS_BUCKET and GCP_SA_KEY_B64 must be set when STORAGE_PROVIDER=gcs");
  const credentials = JSON.parse(Buffer.from(keyB64, "base64").toString("utf8"));
  gcsBucket = new Storage({ credentials, projectId: credentials.project_id }).bucket(name);
  return gcsBucket;
}

export function gcsPublicUrl(key: string): string {
  return `https://storage.googleapis.com/${process.env.GCS_BUCKET}/${key}`;
}

async function putWebp(buffer: Buffer, key: string, resize: ResizeOptions): Promise<string> {
  const out = await sharp(buffer).rotate().resize(resize).webp({ quality: 80 }).toBuffer();
  await bucket().file(key).save(out, {
    resumable: false,
    contentType: "image/webp",
    metadata: { cacheControl: "public, max-age=31536000, immutable" },
  });
  return gcsPublicUrl(key);
}

async function gcsUpload(buffer: Buffer, folder: string, publicId: string): Promise<StoredImage> {
  const base = `${folder}/${publicId}`;
  if (AVATAR_FOLDERS.has(folder)) {
    const url = await putWebp(buffer, `${base}-${AVATAR_SIZE}.webp`, {
      width: AVATAR_SIZE, height: AVATAR_SIZE, fit: "cover", position: sharp.strategy.attention,
    });
    return { url, id: `${base}-${AVATAR_SIZE}.webp` };
  }
  await putWebp(buffer, `${base}-${SMALL_WIDTH}.webp`, { width: SMALL_WIDTH, withoutEnlargement: true });
  const url = await putWebp(buffer, `${base}-${LARGE_WIDTH}.webp`, { width: LARGE_WIDTH, withoutEnlargement: true });
  return { url, id: `${base}-${LARGE_WIDTH}.webp` };
}

/** Always uploads to GCS regardless of STORAGE_PROVIDER — used by the migration script. */
export function storeImageInGcs(buffer: Buffer, folder: string, publicId: string): Promise<StoredImage> {
  return gcsUpload(buffer, folder, publicId);
}

// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Store an uploaded image and return its public URL.
 * @param folder   e.g. "qualifresh-products", "qualifresh-categories", "qualifresh-farms"
 * @param publicId file name without extension, e.g. "bok-choy-500gm-1776465534000"
 */
export function storeImage(buffer: Buffer, folder: string, publicId: string, opts: StoreOptions = {}): Promise<StoredImage> {
  const safeId = publicId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || `img-${Date.now()}`;
  if (storageProvider() === "gcs") {
    return gcsUpload(buffer, folder, opts.replaceInPlace ? `${safeId}-${Date.now()}` : safeId);
  }
  return cloudinaryUpload(buffer, folder, safeId, !!opts.replaceInPlace);
}

// ── Deletion ──────────────────────────────────────────────────────────────────
const CLD_URL = /^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/(?:[a-z]{1,3}_[^/]+\/)*(?:v\d+\/)?(.+?)(?:\.[a-zA-Z0-9]+)?(?:\?.*)?$/;
const GCS_URL = /^https:\/\/storage\.googleapis\.com\/([^/]+)\/([^?]+)(?:\?.*)?$/;

export function isGcsUrl(url: string | undefined | null): boolean {
  return !!url && GCS_URL.test(url);
}

/** Cloudinary public_id ("folder/name", no extension) for a delivery URL, or null. */
export function cloudinaryPublicId(url: string): string | null {
  const m = url.match(CLD_URL);
  return m ? m[1] : null;
}

/**
 * Delete a stored image by its public URL. Handles both providers regardless of
 * STORAGE_PROVIDER, so images uploaded before a switch can still be cleaned up:
 *   Cloudinary → destroy(public_id) with CDN invalidation
 *   GCS        → deletes the <name>-400.webp and <name>-1200.webp pair
 *                (or the single <name>-300.webp avatar)
 * Unknown URLs (local /public files, other hosts) are ignored. Missing files
 * are not an error. Returns true if something was deleted.
 */
export async function deleteImage(url: string | undefined | null): Promise<boolean> {
  if (!url) return false;

  const g = url.match(GCS_URL);
  if (g) {
    const [, bucketName, key] = g;
    if (bucketName !== process.env.GCS_BUCKET) {
      console.warn(`deleteImage: skipping GCS URL outside bucket ${process.env.GCS_BUCKET}: ${url}`);
      return false;
    }
    const keys = /-(400|1200)\.webp$/.test(key)
      ? [key.replace(/-(400|1200)\.webp$/, `-${SMALL_WIDTH}.webp`), key.replace(/-(400|1200)\.webp$/, `-${LARGE_WIDTH}.webp`)]
      : [key];
    await Promise.all(keys.map(k => bucket().file(k).delete({ ignoreNotFound: true })));
    return true;
  }

  const publicId = cloudinaryPublicId(url);
  if (publicId) {
    ensureCloudinary();
    const res = await cloudinary.uploader.destroy(publicId, { invalidate: true, resource_type: "image" });
    return res?.result === "ok";
  }
  return false;
}
