/**
 * ONE-TIME: Ensure Supabase buckets have public read access.
 *
 * Run from the backend directory:
 *   npx ts-node src/scripts/set-bucket-public.ts
 *
 * This sets both `product-images` and `farm-images` to public:true
 * so that anyone can read images without authentication.
 */

import "dotenv/config";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env");
  process.exit(1);
}

const BUCKETS = ["product-images", "farm-images"];

async function setBucketPublic(bucket: string) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/bucket/${bucket}`, {
    method:  "PUT",
    headers: {
      Authorization:  `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ public: true }),
  });

  const body = await r.json().catch(() => ({}));
  if (r.ok) {
    console.log(`✓ ${bucket} → public: true`);
  } else {
    console.error(`✗ ${bucket}: ${r.status}`, body);
  }
}

async function run() {
  console.log("Setting Supabase buckets to public…\n");
  for (const b of BUCKETS) {
    await setBucketPublic(b);
  }
  console.log("\nDone. Images should now be publicly accessible without auth.\n");
  console.log("Verify by opening this URL in a browser:");
  console.log(`  ${SUPABASE_URL}/storage/v1/object/public/product-images/<any-filename>`);
}

run().catch(err => {
  console.error("Failed:", err.message);
  process.exit(1);
});
