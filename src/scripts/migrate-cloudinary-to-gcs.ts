/**
 * ONE-TIME MIGRATION: Cloudinary → Google Cloud Storage (as WebP).
 *
 * Moves every Cloudinary image referenced in MongoDB:
 *   products      imageUrl, images[]
 *   categories    imageUrl
 *   farmphotos    imageUrl
 *   testimonials  avatarUrl, images[].url
 *
 * For each image: download from Cloudinary → convert to WebP (400px + 1200px, or a
 * 300px square for testimonial avatars) → upload to GCS → update the MongoDB field.
 * The before/after value of every changed field is saved in the "image_migrations"
 * collection, so the whole run can be undone with --rollback.
 *
 * Safe to run more than once: only fields that still point at res.cloudinary.com are touched.
 *
 * Needs in .env:  MONGO_URI, GCS_BUCKET, GCP_SA_KEY_B64
 *
 * Usage:
 *   npm run migrate:gcs -- --dry-run     # list what would move, change nothing
 *   npm run migrate:gcs                  # migrate
 *   npm run migrate:gcs -- --rollback    # put every field back to its Cloudinary URL
 */
import "dotenv/config";
import mongoose from "mongoose";
import { storeImageInGcs } from "../services/imageStorage";

const DRY_RUN  = process.argv.includes("--dry-run");
const ROLLBACK = process.argv.includes("--rollback");

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error("✗ MONGO_URI not set in .env"); process.exit(1); }
if (!ROLLBACK && !DRY_RUN && (!process.env.GCS_BUCKET || !process.env.GCP_SA_KEY_B64)) {
  console.error("✗ GCS_BUCKET and GCP_SA_KEY_B64 must be set in .env"); process.exit(1);
}

type FieldKind = "string" | "stringArray" | "objectArrayUrl";
const TARGETS: { coll: string; field: string; kind: FieldKind }[] = [
  { coll: "products",     field: "imageUrl",  kind: "string" },
  { coll: "products",     field: "images",    kind: "stringArray" },
  { coll: "categories",   field: "imageUrl",  kind: "string" },
  { coll: "farmphotos",   field: "imageUrl",  kind: "string" },
  { coll: "testimonials", field: "avatarUrl", kind: "string" },
  { coll: "testimonials", field: "images",    kind: "objectArrayUrl" },
];

const CLD = /^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/(.+)$/;
const isCld = (u: unknown): u is string => typeof u === "string" && CLD.test(u);

/** ".../upload/v1776465534/qualifresh-products/bok-choy-500gm.png" → { folder, name } */
export function parseCloudinary(url: string): { folder: string; name: string } {
  const segs = url.match(CLD)![1].split("?")[0].split("/");
  while (segs.length > 1 && /^[a-z]{1,3}_/.test(segs[0])) segs.shift();   // transformation segments
  if (segs.length > 1 && /^v\d+$/.test(segs[0])) segs.shift();            // version segment
  const file   = safeDecode(segs.pop() || "");
  const folder = segs.join("/") || "qualifresh-products";
  const name   = file.replace(/\.[a-z0-9]+$/i, "").toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || `img-${Date.now()}`;
  return { folder, name };
}
function safeDecode(s: string): string { try { return decodeURIComponent(s); } catch { return s; } }

const done = new Map<string, string>();   // old URL → new URL (an image used twice is moved once)
let moved = 0, failed = 0;

async function migrateUrl(oldUrl: string): Promise<string> {
  const cached = done.get(oldUrl);
  if (cached) return cached;
  const { folder, name } = parseCloudinary(oldUrl);
  if (DRY_RUN) { console.log(`    would move ${folder}/${name}`); done.set(oldUrl, oldUrl); return oldUrl; }
  const res = await fetch(oldUrl.split("?")[0]);
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const { url } = await storeImageInGcs(buf, folder, name);
  done.set(oldUrl, url);
  moved++;
  console.log(`    ✓ ${folder}/${name}  (${Math.round(buf.length / 1024)} KB original)`);
  return url;
}

async function convert(value: unknown, kind: FieldKind): Promise<unknown> {
  if (kind === "string") return isCld(value) ? migrateUrl(value) : value;
  if (!Array.isArray(value)) return value;
  const out = [];
  for (const item of value) {
    if (kind === "stringArray") out.push(isCld(item) ? await migrateUrl(item) : item);
    else out.push(item && isCld(item.url) ? { ...item, url: await migrateUrl(item.url) } : item);
  }
  return out;
}

function hasCloudinary(value: unknown, kind: FieldKind): boolean {
  if (kind === "string") return isCld(value);
  if (!Array.isArray(value)) return false;
  return value.some(i => (kind === "stringArray" ? isCld(i) : i && isCld(i.url)));
}

async function migrate(db: mongoose.mongo.Db) {
  const log = db.collection("image_migrations");
  for (const t of TARGETS) {
    const docs = await db.collection(t.coll).find({}, { projection: { [t.field]: 1, name: 1, title: 1, label: 1 } }).toArray();
    const todo = docs.filter(d => hasCloudinary(d[t.field], t.kind));
    console.log(`\n${t.coll}.${t.field}: ${todo.length} document(s)`);
    for (const d of todo) {
      try {
        const before = d[t.field];
        const after  = await convert(before, t.kind);
        if (DRY_RUN) continue;
        await log.insertOne({ coll: t.coll, docId: d._id, field: t.field, before, after, at: new Date() });
        await db.collection(t.coll).updateOne({ _id: d._id }, { $set: { [t.field]: after } });
      } catch (e) {
        failed++;
        console.error(`    ✗ ${t.coll} ${d._id} (${d.name || d.title || d.label || ""}): ${(e as Error).message}`);
      }
    }
  }
  console.log(`\nDone. ${DRY_RUN ? `${done.size} image(s) would be moved` : `${moved} image(s) moved, ${failed} failed`}.`);
  if (failed) console.log("Re-run the script to retry the failed ones.");
}

async function rollback(db: mongoose.mongo.Db) {
  const log = db.collection("image_migrations");
  // newest first, so if a field was migrated twice it ends at its very first value
  const entries = await log.find({ rolledBackAt: { $exists: false } }).sort({ at: -1 }).toArray();
  console.log(`Rolling back ${entries.length} field change(s)…`);
  for (const e of entries) {
    if (DRY_RUN) { console.log(`  would restore ${e.coll} ${e.docId} ${e.field}`); continue; }
    await db.collection(e.coll).updateOne({ _id: e.docId }, { $set: { [e.field]: e.before } });
    await log.updateOne({ _id: e._id }, { $set: { rolledBackAt: new Date() } });
  }
  console.log("Rollback complete. Set STORAGE_PROVIDER back to cloudinary on Render if you changed it.");
}

(async () => {
  console.log(`─── QualiFresh: Cloudinary → GCS ${ROLLBACK ? "ROLLBACK" : "migration"}${DRY_RUN ? " (dry run)" : ""} ───`);
  await mongoose.connect(MONGO_URI!);
  const db = mongoose.connection.db!;
  try {
    if (ROLLBACK) await rollback(db); else await migrate(db);
  } finally {
    await mongoose.disconnect();
  }
})().catch(e => { console.error(e); process.exit(1); });
