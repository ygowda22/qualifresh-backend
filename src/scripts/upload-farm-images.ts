/**
 * ONE-TIME MIGRATION: Upload local farm photos to Supabase `farm-images` bucket.
 *
 * Run from the backend directory:
 *   npx ts-node src/scripts/upload-farm-images.ts
 *
 * What it does:
 *   1. Creates the `farm-images` bucket (public) if it doesn't exist.
 *   2. Uploads every public/products/farm-*.png from the frontend directory.
 *   3. Prints the resulting Supabase public URLs.
 *
 * After running: copy the URLs into DEFAULT_FARM_PHOTOS in:
 *   - qualifresh-frontend/app/admin/page.tsx
 *   - qualifresh-frontend/app/our-farms/page.tsx
 */

import "dotenv/config";
import fs from "fs";
import path from "path";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BUCKET       = "farm-images";

const FRONTEND_PUBLIC = path.resolve(__dirname, "../../../qualifresh-frontend/public/products");

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env");
  process.exit(1);
}

async function createBucket() {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    method:  "POST",
    headers: {
      Authorization:  `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
  });
  const body = await r.json().catch(() => ({}));
  if (r.status === 200 || r.status === 201) {
    console.log(`✓ Bucket "${BUCKET}" created.`);
  } else if (r.status === 409 || (body as any)?.error === "Duplicate") {
    console.log(`  Bucket "${BUCKET}" already exists.`);
  } else {
    console.error("Bucket create error:", r.status, body);
  }
}

async function uploadFile(filePath: string, filename: string): Promise<string> {
  const buf  = fs.readFileSync(filePath);
  const mime = filename.endsWith(".png") ? "image/png" : "image/jpeg";

  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${filename}`, {
    method:  "POST",
    headers: {
      Authorization:  `Bearer ${SERVICE_KEY}`,
      "Content-Type": mime,
      "x-upsert":     "true",
    },
    body: buf,
  });

  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(`Upload failed for ${filename}: ${r.status} ${JSON.stringify(err)}`);
  }

  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${filename}`;
}

async function run() {
  console.log("Supabase URL:", SUPABASE_URL);
  console.log("Looking for farm images in:", FRONTEND_PUBLIC, "\n");

  if (!fs.existsSync(FRONTEND_PUBLIC)) {
    console.error("Frontend public/products directory not found:", FRONTEND_PUBLIC);
    console.error("Adjust FRONTEND_PUBLIC path in this script.");
    process.exit(1);
  }

  await createBucket();

  const farmFiles = fs.readdirSync(FRONTEND_PUBLIC)
    .filter(f => f.startsWith("farm-") && /\.(png|jpg|jpeg|webp)$/i.test(f))
    .sort();

  if (farmFiles.length === 0) {
    console.log("No farm-*.png files found in", FRONTEND_PUBLIC);
    return;
  }

  console.log(`\nUploading ${farmFiles.length} farm image(s)…\n`);
  const results: { filename: string; url: string }[] = [];

  for (const filename of farmFiles) {
    const filePath = path.join(FRONTEND_PUBLIC, filename);
    try {
      const url = await uploadFile(filePath, filename);
      console.log(`✓ ${filename}\n  → ${url}`);
      results.push({ filename, url });
    } catch (err: any) {
      console.error(`✗ ${filename}: ${err.message}`);
    }
  }

  console.log("\n──────────────────────────────────────────────");
  console.log("Copy the following into DEFAULT_FARM_PHOTOS in:");
  console.log("  app/admin/page.tsx");
  console.log("  app/our-farms/page.tsx\n");
  console.log("const DEFAULT_FARM_PHOTOS: FarmPhoto[] = [");
  results.forEach(({ url }, i) => {
    const comma = i < results.length - 1 ? "," : "";
    console.log(`  { id: "f${i + 1}", title: "Our Farm ${i + 1}", description: "", imageUrl: "${url}" }${comma}`);
  });
  console.log("];\n");
}

run().catch(err => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
