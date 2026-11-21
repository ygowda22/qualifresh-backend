/**
 * Safe removal of images that a save or delete has made unused.
 *
 * Call AFTER the database write has succeeded, with every image URL the document
 * had BEFORE the write. For each URL:
 *   1. ignore it unless it is a Cloudinary/GCS image in one of our folders
 *      (never touches /public files, other hosts, other folders, other clouds/buckets);
 *   2. keep it if ANY document still references the same image — products
 *      (imageUrl, images[]), categories, farm photos, testimonials (avatarUrl,
 *      images[].url), including the document that was just saved, and the
 *      GCS-migration rollback log (image_migrations.before);
 *   3. otherwise delete it with imageStorage.deleteImage().
 *
 * Never throws: a failed check or delete is logged and leaves an orphan, which
 * scripts/delete-orphan-images.ts can find later. A save must never fail because
 * of image cleanup.
 */
import mongoose from "mongoose";
import { Product } from "../models/Product";
import { Category } from "../models/Category";
import { FarmPhoto } from "../models/FarmPhoto";
import { Testimonial } from "../models/Testimonial";
import { deleteImage, deletionBlockedReason, imageRefPattern, parseImageUrl, type ParsedImageUrl } from "./imageStorage";

/** True if any document still points at this image (any version/size/query of it). */
export async function isImageReferenced(parsed: ParsedImageUrl): Promise<boolean> {
  const re = imageRefPattern(parsed);
  const checks: Promise<unknown>[] = [
    Product.exists({ $or: [{ imageUrl: re }, { images: re }] }),
    Category.exists({ imageUrl: re }),
    FarmPhoto.exists({ imageUrl: re }),
    Testimonial.exists({ $or: [{ avatarUrl: re }, { "images.url": re }] }),
  ];
  const db = mongoose.connection.db;
  if (db) checks.push(db.collection("image_migrations").findOne({ before: re }, { projection: { _id: 1 } }));
  const results = await Promise.all(checks);
  return results.some(Boolean);
}

/** Every image URL stored on a document of any of our models. */
export function imageUrlsOf(doc: any): string[] {
  if (!doc) return [];
  const urls: unknown[] = [doc.imageUrl, doc.avatarUrl];
  if (Array.isArray(doc.images)) for (const im of doc.images) urls.push(typeof im === "string" ? im : im?.url);
  return urls.filter((u): u is string => typeof u === "string" && u.trim() !== "");
}

/**
 * Delete the given images unless still referenced. Never throws.
 * @param context short label for the logs, e.g. "product 65f… update"
 */
export async function cleanupImages(urls: (string | null | undefined)[], context: string): Promise<void> {
  const seen = new Set<string>();
  for (const raw of urls) {
    if (!raw || typeof raw !== "string") continue;
    const url = raw.trim().split("?")[0];
    if (!url || seen.has(url)) continue;
    seen.add(url);
    try {
      const parsed = parseImageUrl(url);
      if (!parsed) continue; // /public file, Unsplash, … — not ours to delete, nothing to log
      const blocked = deletionBlockedReason(parsed);
      if (blocked) { console.log(`[image-cleanup] ${context}: keep ${url} (${blocked})`); continue; }
      if (await isImageReferenced(parsed)) { console.log(`[image-cleanup] ${context}: keep ${url} (still referenced)`); continue; }
      const deleted = await deleteImage(url);
      console.log(`[image-cleanup] ${context}: ${deleted ? "deleted" : "not found / not deleted"} ${url}`);
    } catch (err) {
      console.error(`[image-cleanup] ${context}: failed for ${url} (left as orphan):`, err);
    }
  }
}

/** Fire-and-forget variant for request handlers: runs after the response is sent. */
export function cleanupImagesLater(urls: (string | null | undefined)[], context: string): void {
  setImmediate(() => { void cleanupImages(urls, context); });
}
