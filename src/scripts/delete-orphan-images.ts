/**
 * ONE-TIME, STANDALONE SCRIPT: find and delete duplicate/orphaned Cloudinary
 * assets under the "qualifresh-products/" folder — assets no product in
 * MongoDB references any more (left behind by the old upload flow, which
 * minted a new Cloudinary asset with a timestamped public_id on every image
 * upload/replace instead of overwriting one asset per product).
 *
 * Touches Cloudinary + reads MongoDB only. Changes no application code, no
 * UI, no product data. Only ever deletes Cloudinary assets confirmed
 * unreferenced, and only when --confirm is passed.
 *
 * Usage:
 *   npx ts-node src/scripts/delete-orphan-images.ts             (dry run — writes orphans.json, deletes nothing)
 *   npx ts-node src/scripts/delete-orphan-images.ts --confirm   (deletes the orphans listed in the dry run, in batches, with an audit log)
 *
 * Output:
 *   orphans.json         — full orphan list + counts + reclaimable bytes (written every run)
 *   deletion-log.json    — one entry per deletion attempt, appended on --confirm runs only
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { v2 as cloudinary } from "cloudinary";

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error("✗ MONGO_URI not set in .env"); process.exit(1); }
if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
  console.error("✗ CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET not set in .env");
  process.exit(1);
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const PREFIX       = "qualifresh-products/"; // actual Cloudinary folder used by the product-upload route; adjust if it changes
const CONFIRM       = process.argv.includes("--confirm");
const BATCH_SIZE     = 100;
const BATCH_PAUSE_MS = 500;

const OUT_DIR          = __dirname;
const ORPHANS_FILE     = path.join(OUT_DIR, "orphans.json");
const DELETION_LOG_FILE = path.join(OUT_DIR, "deletion-log.json");

// Minimal read-only Mongoose model — matches the real "products" collection
// without needing the full app schema.
const ProductSchema = new mongoose.Schema(
  { name: String, slug: String, imageUrl: String, imagePublicId: String, images: [String] },
  { strict: false, collection: "products" }
);
const Product = mongoose.model("Product", ProductSchema);

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Derive a Cloudinary public_id (folder/name, no extension) from a delivery
// URL — for records that only stored imageUrl, not imagePublicId, and for
// entries in the images[] gallery array (which never had a public_id field).
function publicIdFromUrl(url: string): string | null {
  if (typeof url !== "string" || !url.includes("/upload/")) return null;
  const m = url.match(/\/upload\/(?:[a-z]{1,3}_[^/]+\/)*(?:v\d+\/)?(.+?)(?:\.[a-zA-Z0-9]+)?(?:\?.*)?$/);
  return m ? m[1] : null;
}

async function getReferencedPublicIds(): Promise<Set<string>> {
  const referenced = new Set<string>();
  const products = await Product.find(
    {},
    { _id: 1, name: 1, slug: 1, imageUrl: 1, imagePublicId: 1, images: 1 }
  ).lean();

  for (const raw of products) {
    const p = raw as any;
    if (p.imagePublicId) referenced.add(p.imagePublicId);
    if (p.imageUrl) {
      const pid = publicIdFromUrl(p.imageUrl);
      if (pid) referenced.add(pid);
    }
    if (Array.isArray(p.images)) {
      for (const url of p.images) {
        const pid = publicIdFromUrl(url);
        if (pid) referenced.add(pid);
      }
    }
  }
  return referenced;
}

async function listAllAssetsUnderPrefix(): Promise<{ public_id: string; bytes: number }[]> {
  const assets: { public_id: string; bytes: number }[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await cloudinary.api.resources({
      type: "upload",
      prefix: PREFIX,
      max_results: 500,
      next_cursor: cursor,
    });
    for (const r of res.resources) assets.push({ public_id: r.public_id, bytes: r.bytes });
    cursor = res.next_cursor;
  } while (cursor);
  return assets;
}

async function run() {
  console.log("─── QualiFresh: delete-orphan-images ───────────────────────────");
  console.log(`Mode: ${CONFIRM ? "DELETE (--confirm passed)" : "DRY RUN"}`);
  console.log(`Scope: Cloudinary prefix "${PREFIX}"\n`);

  console.log("Connecting to MongoDB…");
  await mongoose.connect(MONGO_URI!);
  console.log("Connected.\n");

  console.log("Gathering referenced image public_ids from MongoDB…");
  const referenced = await getReferencedPublicIds();
  console.log(`Referenced public_ids: ${referenced.size}\n`);

  // Safety: an empty referenced set almost certainly means the DB query
  // failed or returned nothing — never treat that as "everything is an
  // orphan." Abort without touching Cloudinary.
  if (referenced.size === 0) {
    console.error("✗ Refused: 0 referenced images found in MongoDB — aborting without deleting anything.");
    console.error("  (This usually means the DB connection or query is wrong, not that products have no images.)");
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`Listing Cloudinary assets under "${PREFIX}"…`);
  const assets = await listAllAssetsUnderPrefix();
  console.log(`Cloudinary assets found: ${assets.length}\n`);

  const orphans = assets.filter(a => !referenced.has(a.public_id));
  const orphanBytes = orphans.reduce((sum, a) => sum + a.bytes, 0);

  const report = {
    generatedAt: new Date().toISOString(),
    prefix: PREFIX,
    totalAssets: assets.length,
    totalReferenced: referenced.size,
    orphanCount: orphans.length,
    orphanBytesReclaimable: orphanBytes,
    orphanMBReclaimable: +(orphanBytes / (1024 * 1024)).toFixed(2),
    orphans: orphans.map(a => a.public_id),
  };
  fs.writeFileSync(ORPHANS_FILE, JSON.stringify(report, null, 2));

  console.log("─── Summary ─────────────────────────────────────────────────────");
  console.log(`  Total Cloudinary assets     : ${report.totalAssets}`);
  console.log(`  Referenced by a product     : ${report.totalReferenced}`);
  console.log(`  Orphaned (unreferenced)     : ${report.orphanCount}`);
  console.log(`  Reclaimable storage         : ${report.orphanMBReclaimable} MB`);
  console.log(`  Full orphan list written to : ${ORPHANS_FILE}`);
  console.log("─────────────────────────────────────────────────────────────────\n");

  if (orphans.length === 0) {
    console.log("✓ Nothing to clean up.");
    await mongoose.disconnect();
    return;
  }

  if (!CONFIRM) {
    console.log(`DRY RUN — pass --confirm to delete these ${orphans.length} asset(s).`);
    await mongoose.disconnect();
    return;
  }

  console.log(`Deleting ${orphans.length} orphaned asset(s) in batches of ${BATCH_SIZE}…\n`);
  const deletionLog: { public_id: string; result: string; timestamp: string }[] = [];
  const orphanIds = orphans.map(a => a.public_id);

  for (let i = 0; i < orphanIds.length; i += BATCH_SIZE) {
    const batch = orphanIds.slice(i, i + BATCH_SIZE);
    console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: deleting ${batch.length} asset(s)…`);
    try {
      const res: any = await cloudinary.api.delete_resources(batch, { invalidate: true });
      const timestamp = new Date().toISOString();
      for (const publicId of batch) {
        const result = res.deleted?.[publicId] ?? "unknown";
        deletionLog.push({ public_id: publicId, result, timestamp });
        console.log(`    ${result === "deleted" ? "✓" : "✗"} ${publicId} — ${result}`);
      }
    } catch (err: any) {
      const timestamp = new Date().toISOString();
      const reason = err?.message ?? String(err);
      for (const publicId of batch) deletionLog.push({ public_id: publicId, result: `error: ${reason}`, timestamp });
      console.log(`    ✗ Batch failed — ${reason}`);
    }
    if (i + BATCH_SIZE < orphanIds.length) await sleep(BATCH_PAUSE_MS);
  }

  const existingLog = fs.existsSync(DELETION_LOG_FILE)
    ? JSON.parse(fs.readFileSync(DELETION_LOG_FILE, "utf-8"))
    : [];
  fs.writeFileSync(DELETION_LOG_FILE, JSON.stringify([...existingLog, ...deletionLog], null, 2));

  const deletedCount = deletionLog.filter(d => d.result === "deleted").length;
  console.log(`\nDone. Deleted ${deletedCount}/${orphans.length}. Audit log written to ${DELETION_LOG_FILE}`);

  await mongoose.disconnect();
}

run().catch(err => {
  console.error("\n✗ Fatal error:", err);
  mongoose.disconnect();
  process.exit(1);
});
