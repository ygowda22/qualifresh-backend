/**
 * ONE-TIME MIGRATION: Clear invalid imageUrl values from all products.
 *
 * Invalid = anything that is NOT a Supabase public URL.
 * Examples of invalid values that get cleared:
 *   - "" (empty)
 *   - "D:\Projects\qualifresh-frontend\public\products\broccoli.png"
 *   - "/uploads/broccoli-500gm-1234567890.png"
 *   - "https://images.unsplash.com/..." (old fallback URLs)
 *
 * Valid = starts with the Supabase storage public URL prefix.
 *
 * Safe to run multiple times — products with valid Supabase URLs are untouched.
 */

import "dotenv/config";
import mongoose from "mongoose";

const SUPABASE_PREFIX = "https://jilqbyulleszkoiowhyf.supabase.co/storage/v1/object/public/product-images/";

const MONGO_URI = process.env.MONGO_URI!;
if (!MONGO_URI) { console.error("MONGO_URI not set in .env"); process.exit(1); }

// Minimal schema — only fields we touch
const ProductSchema = new mongoose.Schema(
  { imageUrl: { type: String, default: "" } },
  { strict: false, collection: "products" }
);
const Product = mongoose.model("Product", ProductSchema);

function isValidSupabaseUrl(url: string | undefined | null): boolean {
  return typeof url === "string" && url.startsWith(SUPABASE_PREFIX);
}

async function run() {
  console.log("Connecting to MongoDB…");
  await mongoose.connect(MONGO_URI);
  console.log("Connected.\n");

  const all = await Product.find({}, { _id: 1, name: 1, imageUrl: 1 }).lean();
  console.log(`Total products: ${all.length}`);

  const toFix = all.filter(p => !isValidSupabaseUrl((p as any).imageUrl));
  console.log(`Products with invalid/missing imageUrl: ${toFix.length}`);

  if (toFix.length === 0) {
    console.log("\nNothing to migrate — all products already have valid Supabase URLs.");
    await mongoose.disconnect();
    return;
  }

  console.log("\nProducts that will be updated (imageUrl → \"\"):");
  toFix.forEach(p => {
    const url = (p as any).imageUrl;
    const display = url ? `"${url.slice(0, 80)}${url.length > 80 ? "…" : ""}"` : "(empty)";
    console.log(`  [${(p as any)._id}] ${(p as any).name || "unnamed"} — was: ${display}`);
  });

  const ids = toFix.map(p => (p as any)._id);
  const result = await Product.updateMany(
    { _id: { $in: ids } },
    { $set: { imageUrl: "" } }
  );

  console.log(`\n✓ Updated ${result.modifiedCount} product(s). imageUrl cleared.`);
  console.log("  These products will show a placeholder emoji on the frontend.");
  console.log("  Re-upload images for them via the admin panel.");

  const skipped = all.length - toFix.length;
  if (skipped > 0) {
    console.log(`\n✓ ${skipped} product(s) already had valid Supabase URLs — untouched.`);
  }

  await mongoose.disconnect();
  console.log("\nDone. Disconnected from MongoDB.");
}

run().catch(err => {
  console.error("Migration failed:", err);
  mongoose.disconnect();
  process.exit(1);
});
