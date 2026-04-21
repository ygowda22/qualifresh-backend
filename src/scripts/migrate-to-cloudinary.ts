/**
 * ONE-TIME MIGRATION: Re-upload all product images from Supabase → Cloudinary.
 *
 * For every product whose imageUrl contains "supabase.co":
 *   1. Download the image (uses Supabase service-role key if available in .env)
 *   2. Upload to Cloudinary folder "qualifresh-products"
 *   3. Update MongoDB imageUrl with the new Cloudinary CDN URL
 *
 * Products already on Cloudinary (res.cloudinary.com) are skipped.
 * Safe to run multiple times.
 *
 * Usage:
 *   npx ts-node-dev --transpile-only src/scripts/migrate-to-cloudinary.ts
 * or via npm:
 *   npm run migrate:cloudinary
 */

import "dotenv/config";
import mongoose from "mongoose";
import { v2 as cloudinary } from "cloudinary";

// ── Validate env ───────────────────────────────────────────────────────────
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

// ── Minimal Mongoose model ─────────────────────────────────────────────────
const ProductSchema = new mongoose.Schema(
  { name: String, slug: String, imageUrl: String },
  { strict: false, collection: "products" }
);
const Product = mongoose.model("Product", ProductSchema);

// ── Helpers ────────────────────────────────────────────────────────────────
async function downloadBuffer(url: string): Promise<Buffer> {
  const headers: Record<string, string> = {};
  // Use Supabase service-role key for authenticated download if available
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (sbKey && url.includes("supabase.co")) {
    headers["Authorization"] = `Bearer ${sbKey}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

function cloudinaryUpload(
  buffer: Buffer,
  options: Record<string, unknown>
): Promise<{ secure_url: string; public_id: string }> {
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(options, (err, result) => {
        if (err || !result) reject(err ?? new Error("No result from Cloudinary"));
        else resolve(result as { secure_url: string; public_id: string });
      })
      .end(buffer);
  });
}

// ── Main ───────────────────────────────────────────────────────────────────
async function run() {
  console.log("─── QualiFresh: Supabase → Cloudinary migration ────────────────");
  console.log("Connecting to MongoDB…");
  await mongoose.connect(MONGO_URI!);
  console.log("Connected.\n");

  const all = await Product.find({}, { _id: 1, name: 1, slug: 1, imageUrl: 1 }).lean();
  console.log(`Total products in DB: ${all.length}`);

  const toMigrate       = all.filter(p => typeof (p as any).imageUrl === "string" && (p as any).imageUrl.includes("supabase.co"));
  const alreadyCloud    = all.filter(p => typeof (p as any).imageUrl === "string" && (p as any).imageUrl.includes("res.cloudinary.com"));
  const noImage         = all.filter(p => !((p as any).imageUrl));

  console.log(`  Already on Cloudinary : ${alreadyCloud.length}`);
  console.log(`  Need migration        : ${toMigrate.length}`);
  console.log(`  No image (skip)       : ${noImage.length}\n`);

  if (toMigrate.length === 0) {
    console.log("✓ Nothing to migrate — all products are already on Cloudinary.");
    await mongoose.disconnect();
    return;
  }

  let ok      = 0;
  let failed  = 0;
  const errors: { name: string; reason: string }[] = [];

  for (const raw of toMigrate) {
    const p = raw as any;
    const label = `${p.name} [${p.slug}]`;
    process.stdout.write(`  Migrating ${label}… `);

    try {
      const buffer = await downloadBuffer(p.imageUrl);

      const cleanSlug = (p.slug as string).replace(/[^a-z0-9-]/g, "-").toLowerCase();
      const result = await cloudinaryUpload(buffer, {
        folder:        "qualifresh-products",
        public_id:     cleanSlug,
        resource_type: "image",
        overwrite:     true,
      });

      await Product.updateOne({ _id: p._id }, { $set: { imageUrl: result.secure_url } });
      console.log(`✓  →  ${result.secure_url}`);
      ok++;
    } catch (err: any) {
      const reason = err?.message ?? String(err);
      console.log(`✗  FAILED — ${reason}`);
      errors.push({ name: label, reason });
      failed++;
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n─── Summary ─────────────────────────────────────────────────────");
  console.log(`  Migrated successfully  : ${ok}`);
  console.log(`  Failed                 : ${failed}`);
  console.log(`  Already on Cloudinary  : ${alreadyCloud.length} (untouched)`);
  console.log(`  No image               : ${noImage.length} (untouched)`);

  if (errors.length > 0) {
    console.log("\n  Failed products:");
    errors.forEach(e => console.log(`    • ${e.name} — ${e.reason}`));
    console.log("\n  Tip: if errors are '401 Unauthorized', uncomment SUPABASE_SERVICE_ROLE_KEY");
    console.log("  in .env and re-run. The script skips already-migrated products.");
  }

  console.log("─────────────────────────────────────────────────────────────────");
  await mongoose.disconnect();
  console.log("Done. Disconnected from MongoDB.");
}

run().catch(err => {
  console.error("\n✗ Fatal error:", err);
  mongoose.disconnect();
  process.exit(1);
});
