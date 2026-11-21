// Unit tests for image URL parsing / ownership / reference matching.
// Run: npm test   (builds with tsc, then runs node --test on ./test)
// Pure functions only — no network, no database, nothing is deleted.
process.env.CLOUDINARY_CLOUD_NAME = "qf";
process.env.GCS_BUCKET = "qualifresh-images";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseImageUrl, imageRefPattern, deletionBlockedReason, deleteImage, uniqueImageName, cloudinaryPublicId,
} = require("../dist/services/imageStorage");
const { imageUrlsOf, cleanupImages } = require("../dist/services/imageCleanup");

const CLD = "https://res.cloudinary.com/qf/image/upload";
const GCS = "https://storage.googleapis.com/qualifresh-images";

test("old Cloudinary .png URL → public_id without extension", () => {
  const p = parseImageUrl(`${CLD}/v1712345678/qualifresh-products/hass-avocado.png`);
  assert.deepEqual(p, { provider: "cloudinary", cloud: "qf", publicId: "qualifresh-products/hass-avocado", folder: "qualifresh-products" });
  assert.equal(cloudinaryPublicId(`${CLD}/v1/qualifresh-products/hass-avocado.jpg`), "qualifresh-products/hass-avocado");
});

test("new Cloudinary .webp URL (unique name)", () => {
  const p = parseImageUrl(`${CLD}/v1763700000/qualifresh-products/hass-avocado-1763700000123.webp`);
  assert.equal(p.publicId, "qualifresh-products/hass-avocado-1763700000123");
});

test("Cloudinary URL with transformation segment f_auto,q_auto,w_480", () => {
  assert.equal(parseImageUrl(`${CLD}/f_auto,q_auto,w_480/v1763/qualifresh-products/hass-avocado.webp`).publicId, "qualifresh-products/hass-avocado");
  assert.equal(parseImageUrl(`${CLD}/c_fill,g_auto,w_240,h_240,f_auto,q_auto/qualifresh-categories/cat-leafy-1.webp`).publicId, "qualifresh-categories/cat-leafy-1");
});

test("Cloudinary URL with ?query", () => {
  assert.equal(parseImageUrl(`${CLD}/v1763/qualifresh-farms/farm-1763.webp?t=1763700000000`).publicId, "qualifresh-farms/farm-1763");
});

test("GCS -1200.webp URL → both 400 and 1200 keys", () => {
  const p = parseImageUrl(`${GCS}/qualifresh-products/hass-avocado-1763-1200.webp`);
  assert.equal(p.provider, "gcs");
  assert.equal(p.bucket, "qualifresh-images");
  assert.equal(p.folder, "qualifresh-products");
  assert.deepEqual(p.keys, ["qualifresh-products/hass-avocado-1763-400.webp", "qualifresh-products/hass-avocado-1763-1200.webp"]);
  // the -400 URL (cldImg small variant) resolves to the same pair
  assert.deepEqual(parseImageUrl(`${GCS}/qualifresh-products/hass-avocado-1763-400.webp?x=1`).keys, p.keys);
});

test("GCS -300.webp testimonial avatar → single key", () => {
  assert.deepEqual(parseImageUrl(`${GCS}/qualifresh-testimonials/priya-1763-300.webp`).keys, ["qualifresh-testimonials/priya-1763-300.webp"]);
});

test("/public paths and other hosts are ignored (never deleted)", async () => {
  for (const u of ["/products/hass-avocado.png", "/logo.webp", "https://images.unsplash.com/photo-1?w=200", "data:image/png;base64,AAA", "", null, undefined]) {
    assert.equal(parseImageUrl(u), null, String(u));
    assert.equal(await deleteImage(u), false, String(u));
  }
});

test("only our folders / cloud / bucket may be deleted", async () => {
  assert.equal(deletionBlockedReason(parseImageUrl(`${CLD}/v1/qualifresh-products/a.webp`)), null);
  assert.equal(deletionBlockedReason(parseImageUrl(`${CLD}/v1/qualifresh-testimonial-photos/a.webp`)), null);
  assert.match(deletionBlockedReason(parseImageUrl(`${CLD}/v1/samples/food/dessert.jpg`)), /not one of ours/);
  assert.match(deletionBlockedReason(parseImageUrl("https://res.cloudinary.com/demo/image/upload/v1/qualifresh-products/a.webp")), /other Cloudinary cloud/);
  assert.match(deletionBlockedReason(parseImageUrl("https://storage.googleapis.com/someone-else/qualifresh-products/a-1200.webp")), /other GCS bucket/);
  assert.equal(await deleteImage(`${CLD}/v1/samples/food/dessert.jpg`), false); // refused before any network call
});

test("reference pattern matches every URL form of the same image, nothing else", () => {
  const re = imageRefPattern(parseImageUrl(`${CLD}/v1763/qualifresh-products/hass-avocado.webp`));
  for (const u of [
    `${CLD}/v1712/qualifresh-products/hass-avocado.png`,
    `${CLD}/qualifresh-products/hass-avocado.webp?t=1`,
    `${CLD}/f_auto,q_auto,w_480/v1763/qualifresh-products/hass-avocado.webp`,
  ]) assert.ok(re.test(u), u);
  for (const u of [
    `${CLD}/v1763/qualifresh-products/hass-avocado-1763700000123.webp`,
    `${CLD}/v1763/qualifresh-products/hass-avocado2.webp`,
    `https://res.cloudinary.com/other/image/upload/v1/qualifresh-products/hass-avocado.webp`,
  ]) assert.ok(!re.test(u), u);

  const g = imageRefPattern(parseImageUrl(`${GCS}/qualifresh-products/hass-avocado-1763-1200.webp`));
  assert.ok(g.test(`${GCS}/qualifresh-products/hass-avocado-1763-400.webp`));
  assert.ok(g.test(`${GCS}/qualifresh-products/hass-avocado-1763-1200.webp?v=2`));
  assert.ok(!g.test(`${GCS}/qualifresh-products/hass-avocado-1764-1200.webp`));
});

test("uniqueImageName always appends a timestamp", () => {
  assert.equal(uniqueImageName("Hass Avocado (Imported)", 1763700000123), "hass-avocado-imported-1763700000123");
  assert.equal(uniqueImageName("", 5), "img-5");
  assert.notEqual(uniqueImageName("x"), uniqueImageName("x", Date.now() + 1));
});

test("imageUrlsOf collects every image field of any model", () => {
  assert.deepEqual(imageUrlsOf({ imageUrl: "a", images: ["b", ""] }), ["a", "b"]);
  assert.deepEqual(imageUrlsOf({ avatarUrl: "c", images: [{ url: "d", alt: "" }] }), ["c", "d"]);
  assert.deepEqual(imageUrlsOf(null), []);
});

test("cleanupImages never throws and skips non-owned URLs without touching the DB", async () => {
  await cleanupImages(["/products/x.png", `${CLD}/v1/samples/food/dessert.jpg`, null, ""], "test");
});
