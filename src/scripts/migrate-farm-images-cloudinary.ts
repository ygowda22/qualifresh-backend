/**
 * ONE-TIME: Upload the 6 default farm images from Supabase → Cloudinary.
 * Prints the new Cloudinary URLs so the frontend constants can be updated.
 */
import "dotenv/config";
import { v2 as cloudinary } from "cloudinary";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME!,
  api_key:    process.env.CLOUDINARY_API_KEY!,
  api_secret: process.env.CLOUDINARY_API_SECRET!,
});

const SUPABASE_FARM = "https://jilqbyulleszkoiowhyf.supabase.co/storage/v1/object/public/farm-images";

const FARMS = [
  { id: "f1", filename: "farm-1776104049239.png" },
  { id: "f2", filename: "farm-1776104159959.png" },
  { id: "f3", filename: "farm-1776104172608.png" },
  { id: "f4", filename: "farm-1776104179499.png" },
  { id: "f5", filename: "farm-1776104186856.png" },
  { id: "f6", filename: "farm-1776104413238.png" },
];

function streamUpload(buffer: Buffer, options: object): Promise<{ secure_url: string }> {
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(options, (err, result) => {
        if (err || !result) reject(err ?? new Error("No result"));
        else resolve(result as { secure_url: string });
      })
      .end(buffer);
  });
}

async function run() {
  console.log("Migrating farm images: Supabase → Cloudinary\n");
  const results: Record<string, string> = {};

  for (const farm of FARMS) {
    const url = `${SUPABASE_FARM}/${farm.filename}`;
    process.stdout.write(`  ${farm.filename}… `);
    try {
      const headers: Record<string, string> = {};
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (sbKey) headers["Authorization"] = `Bearer ${sbKey}`;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const publicId = farm.filename.replace(/\.[^.]+$/, "");
      const result = await streamUpload(buffer, {
        folder:        "qualifresh-farms",
        public_id:     publicId,
        resource_type: "image",
        overwrite:     true,
      });
      results[farm.id] = result.secure_url;
      console.log(`✓  ${result.secure_url}`);
    } catch (err: any) {
      console.log(`✗ FAILED — ${err.message}`);
      results[farm.id] = "";
    }
  }

  console.log("\n── Copy these URLs into the frontend DEFAULT_FARM_PHOTOS ──");
  FARMS.forEach(f => {
    if (results[f.id]) console.log(`  ${f.id}: "${results[f.id]}"`);
  });
}

run().catch(err => { console.error(err); process.exit(1); });
