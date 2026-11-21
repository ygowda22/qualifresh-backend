/**
 * Single place where uploaded images are stored.
 *
 * Every upload is checked with sharp first: only JPEG, PNG and WebP are accepted
 * (HEIC, PDF, GIF, corrupt files → InvalidImageError → HTTP 400). Nothing is ever
 * stored in its original format.
 *
 * STORAGE_PROVIDER=cloudinary (default) → converted to WebP (max 1600px wide) with sharp, then uploaded to Cloudinary.
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
 * Every upload gets a UNIQUE name (<name>-<timestamp>) and nothing is ever
 * overwritten (Cloudinary overwrite:false, GCS ifGenerationMatch:0), so a
 * replaced image always has a new URL and no browser/CDN cache shows a stale one.
 * Old images are removed by services/imageCleanup.ts after the DB save.
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

/** The only folders this app ever writes to — and the only ones it may delete from. */
export const OWN_FOLDERS = new Set([
  "qualifresh-products",
  "qualifresh-categories",
  "qualifresh-farms",
  "qualifresh-testimonials",
  "qualifresh-testimonial-photos",
]);

const AVATAR_FOLDERS = new Set(["qualifresh-testimonials"]);
export const SMALL_WIDTH = 400;
export const LARGE_WIDTH = 1200;
export const AVATAR_SIZE = 300;

// ── Validation + WebP conversion ─────────────────────────────────────────────
export const UNSUPPORTED_IMAGE_MESSAGE = "Please upload a JPG, PNG or WebP image";
const ACCEPTED_FORMATS = new Set(["jpeg", "png", "webp"]);

/** Thrown when an upload is not a readable JPEG/PNG/WebP. Routes map it to HTTP 400. */
export class InvalidImageError extends Error {
  constructor(message = UNSUPPORTED_IMAGE_MESSAGE) {
    super(message);
    this.name = "InvalidImageError";
  }
}

/** Throws InvalidImageError unless sharp can read the buffer as JPEG, PNG or WebP. */
export async function assertSupportedImage(buffer: Buffer): Promise<void> {
  let format: string | undefined;
  try {
    format = (await sharp(buffer).metadata()).format;
  } catch {
    throw new InvalidImageError();
  }
  if (!format || !ACCEPTED_FORMATS.has(format)) throw new InvalidImageError();
}

/** Auto-rotate (EXIF), cap the width, encode as WebP. Keeps transparency. */
export async function toWebp(buffer: Buffer, maxWidth = 1600): Promise<Buffer> {
  try {
    return await sharp(buffer)
      .rotate()
      .resize({ width: maxWidth, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    throw new InvalidImageError();
  }
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

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

/** Uploads an already-converted WebP buffer under a new, unique public_id. */
function cloudinaryUpload(webp: Buffer, folder: string, publicId: string): Promise<StoredImage> {
  ensureCloudinary();
  // The 1600px cap and compression are done by toWebp(); no incoming transformation,
  // so Cloudinary stores exactly the WebP we send and secure_url ends in .webp.
  // overwrite:false — an existing public_id is never replaced.
  const options: Record<string, unknown> = {
    folder,
    public_id:       publicId,
    resource_type:   "image",
    format:          "webp",
    overwrite:       false,
    unique_filename: false,
  };
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(options, (error, result) => {
        if (error || !result) reject(error ?? new Error("No result from Cloudinary"));
        else resolve({ url: result.secure_url, id: result.public_id });
      })
      .end(webp);
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

async function putWebp(buffer: Buffer, key: string, resize: ResizeOptions): Promise<{ url: string; bytes: number }> {
  const out = await sharp(buffer).rotate().resize(resize).webp({ quality: 80 }).toBuffer();
  await bucket().file(key).save(out, {
    resumable: false,
    preconditionOpts: { ifGenerationMatch: 0 }, // fail instead of overwriting an existing object
    contentType: "image/webp",
    metadata: { cacheControl: "public, max-age=31536000, immutable" },
  });
  return { url: gcsPublicUrl(key), bytes: out.length };
}

async function gcsUpload(buffer: Buffer, folder: string, publicId: string): Promise<StoredImage> {
  const base = `${folder}/${publicId}`;
  if (AVATAR_FOLDERS.has(folder)) {
    const { url, bytes } = await putWebp(buffer, `${base}-${AVATAR_SIZE}.webp`, {
      width: AVATAR_SIZE, height: AVATAR_SIZE, fit: "cover", position: sharp.strategy.attention,
    });
    console.log(`[image] gcs ${base}: ${kb(buffer.length)} → ${kb(bytes)} WebP`);
    return { url, id: `${base}-${AVATAR_SIZE}.webp` };
  }
  await putWebp(buffer, `${base}-${SMALL_WIDTH}.webp`, { width: SMALL_WIDTH, withoutEnlargement: true });
  const { url, bytes } = await putWebp(buffer, `${base}-${LARGE_WIDTH}.webp`, { width: LARGE_WIDTH, withoutEnlargement: true });
  console.log(`[image] gcs ${base}: ${kb(buffer.length)} → ${kb(bytes)} WebP (${LARGE_WIDTH}px)`);
  return { url, id: `${base}-${LARGE_WIDTH}.webp` };
}

/** Always uploads to GCS regardless of STORAGE_PROVIDER — used by the migration script. */
export function storeImageInGcs(buffer: Buffer, folder: string, publicId: string): Promise<StoredImage> {
  return gcsUpload(buffer, folder, publicId);
}

// ── Public API ────────────────────────────────────────────────────────────────
/** "Bok Choy 500gm" → "bok-choy-500gm-1776465534000" (always unique per upload). */
export function uniqueImageName(base: string, now = Date.now()): string {
  const safe = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "img";
  return `${safe}-${now}`;
}

/**
 * Store an uploaded image as WebP under a unique name and return its public URL.
 * Rejects anything that is not a readable JPEG/PNG/WebP with InvalidImageError
 * (the original bytes are never stored). Never overwrites an existing image.
 * @param folder one of OWN_FOLDERS, e.g. "qualifresh-products"
 * @param base   readable base name, e.g. the product slug — a timestamp is appended
 */
export async function storeImage(buffer: Buffer, folder: string, base: string): Promise<StoredImage> {
  if (!OWN_FOLDERS.has(folder)) throw new Error(`storeImage: unknown folder "${folder}"`);
  await assertSupportedImage(buffer);
  const name = uniqueImageName(base);
  if (storageProvider() === "gcs") return gcsUpload(buffer, folder, name);
  const webp = await toWebp(buffer);
  console.log(`[image] cloudinary ${folder}/${name}: ${kb(buffer.length)} → ${kb(webp.length)} WebP`);
  return cloudinaryUpload(webp, folder, name);
}

// ── URL parsing + deletion ───────────────────────────────────────────────────
const CLD_URL = /^https:\/\/res\.cloudinary\.com\/([^/]+)\/image\/upload\/(?:[a-z]{1,3}_[^/]+\/)*(?:v\d+\/)?(.+?)(?:\.[a-zA-Z0-9]+)?(?:\?.*)?$/;
const GCS_URL = /^https:\/\/storage\.googleapis\.com\/([^/]+)\/([^?]+)(?:\?.*)?$/;
const GCS_SIZE_SUFFIX = new RegExp(`-(${SMALL_WIDTH}|${LARGE_WIDTH}|${AVATAR_SIZE})\\.webp$`);

export type ParsedImageUrl =
  | { provider: "cloudinary"; cloud: string; publicId: string; folder: string }
  | {
      provider: "gcs"; bucket: string; key: string; folder: string;
      /** every object that belongs to this upload (400 + 1200 pair, or the single 300 avatar) */
      keys: string[];
      /** key without the size suffix, e.g. "qualifresh-products/avocado-1776…"; null if it has none */
      base: string | null;
    };

/**
 * Identify a stored image from its public URL. Returns null for anything that is
 * not a Cloudinary image-upload URL or a GCS URL (e.g. "/products/x.png" in /public,
 * Unsplash, data: URLs). Handles extensions (.png/.jpg/.webp), version segments,
 * transformation segments (f_auto,q_auto,w_480/…) and ?query strings.
 */
export function parseImageUrl(url: string | undefined | null): ParsedImageUrl | null {
  if (!url || typeof url !== "string") return null;
  const u = url.trim();
  const c = u.match(CLD_URL);
  if (c) {
    const publicId = decodeURIComponent(c[2]);
    return { provider: "cloudinary", cloud: c[1], publicId, folder: publicId.split("/")[0] };
  }
  const g = u.match(GCS_URL);
  if (g) {
    const key = decodeURIComponent(g[2]);
    const m = key.match(GCS_SIZE_SUFFIX);
    if (!m) return { provider: "gcs", bucket: g[1], key, folder: key.split("/")[0], keys: [key], base: null };
    const base = key.slice(0, -m[0].length);
    const keys = m[1] === String(AVATAR_SIZE) ? [key] : [`${base}-${SMALL_WIDTH}.webp`, `${base}-${LARGE_WIDTH}.webp`];
    return { provider: "gcs", bucket: g[1], key, folder: key.split("/")[0], keys, base };
  }
  return null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Regex (for MongoDB queries) that matches ANY stored URL pointing at the same
 * image as `parsed` — regardless of version, extension, transformation segment
 * or ?query (Cloudinary), or which size variant (GCS).
 */
export function imageRefPattern(parsed: ParsedImageUrl): RegExp {
  if (parsed.provider === "cloudinary") {
    return new RegExp(
      `^https://res\\.cloudinary\\.com/${escapeRe(parsed.cloud)}/image/upload/(?:[^?]*/)?${escapeRe(parsed.publicId)}(?:\\.[A-Za-z0-9]+)?(?:\\?.*)?$`
    );
  }
  const tail = parsed.base === null
    ? escapeRe(parsed.key)
    : `${escapeRe(parsed.base)}-(?:${SMALL_WIDTH}|${LARGE_WIDTH}|${AVATAR_SIZE})\\.webp`;
  return new RegExp(`^https://storage\\.googleapis\\.com/${escapeRe(parsed.bucket)}/${tail}(?:\\?.*)?$`);
}

/**
 * Why this app must NOT delete the image, or null if it may.
 * Only our own folders, our own Cloudinary cloud and our own GCS bucket.
 */
export function deletionBlockedReason(parsed: ParsedImageUrl | null): string | null {
  if (!parsed) return "not a Cloudinary/GCS URL";
  if (!OWN_FOLDERS.has(parsed.folder)) return `folder "${parsed.folder}" is not one of ours`;
  if (parsed.provider === "cloudinary") {
    if (!process.env.CLOUDINARY_CLOUD_NAME) return "CLOUDINARY_CLOUD_NAME is not set";
    if (parsed.cloud !== process.env.CLOUDINARY_CLOUD_NAME) return `other Cloudinary cloud "${parsed.cloud}"`;
  } else if (!process.env.GCS_BUCKET || parsed.bucket !== process.env.GCS_BUCKET) {
    return `other GCS bucket "${parsed.bucket}"`;
  }
  return null;
}

export function isGcsUrl(url: string | undefined | null): boolean {
  return parseImageUrl(url)?.provider === "gcs";
}

/** Cloudinary public_id ("folder/name", no extension) for a delivery URL, or null. */
export function cloudinaryPublicId(url: string): string | null {
  const p = parseImageUrl(url);
  return p?.provider === "cloudinary" ? p.publicId : null;
}

/**
 * Delete a stored image by its public URL. Handles both providers regardless of
 * STORAGE_PROVIDER, so images uploaded before a switch can still be cleaned up:
 *   Cloudinary → destroy(public_id) with CDN invalidation. public_ids carry no
 *                extension, so old .png/.jpg and new .webp URLs are handled alike.
 *   GCS        → deletes the <name>-400.webp and <name>-1200.webp pair
 *                (or the single <name>-300.webp avatar)
 * Refuses (returns false) for anything outside OWN_FOLDERS / our cloud / our bucket
 * and for non-Cloudinary/GCS URLs (local /public files, other hosts).
 * Missing files are not an error. Throws only on provider/network errors —
 * request handlers should use services/imageCleanup.ts, which never throws.
 */
export async function deleteImage(url: string | undefined | null): Promise<boolean> {
  const parsed = parseImageUrl(url);
  const blocked = deletionBlockedReason(parsed);
  if (blocked || !parsed) {
    if (parsed) console.warn(`[image] not deleting ${url}: ${blocked}`);
    return false;
  }
  if (parsed.provider === "gcs") {
    await Promise.all(parsed.keys.map(k => bucket().file(k).delete({ ignoreNotFound: true })));
    return true;
  }
  ensureCloudinary();
  const res = await cloudinary.uploader.destroy(parsed.publicId, { invalidate: true, resource_type: "image" });
  return res?.result === "ok";
}
