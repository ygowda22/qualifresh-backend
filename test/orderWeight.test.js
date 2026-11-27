// Actual weight for per-kg items (PATCH /api/orders/:id/items with weightKg).
// Pricing tests always run; API tests need a LOCAL test MongoDB:
//   TEST_MONGO_URL=mongodb://127.0.0.1:27027 npm test
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const H = require("./helpers/apiHarness");
const { computeTotals, linePaise } = require("../dist/config/pricing");

describe("weighed lines in the pricing module", () => {
  it("price × weightKg, exact in paise", () => {
    assert.equal(linePaise({ price: 80, quantity: 1, weightKg: 1.7 }), 13600);
    assert.equal(linePaise({ price: 150, quantity: 1, weightKg: 0.35 }), 5250);
    assert.equal(linePaise({ price: 60, quantity: 2, weightKg: 2.05 }), 12300);
    assert.equal(linePaise({ price: 99.99, quantity: 1, weightKg: 1.33 }), 13299); // 132.9867 → nearest paisa
  });
  it("without a weight: price × quantity exactly as before", () => {
    assert.equal(linePaise({ price: 45, quantity: 3 }), 13500);
    assert.equal(linePaise({ price: 45, quantity: 3, weightKg: null }), 13500);
    assert.deepEqual(computeTotals([{ price: 45, quantity: 3 }]), { subtotal: 135, deliveryCharge: 50, total: 185 });
  });
  it("delivery rule uses the weighed amounts", () => {
    assert.deepEqual(computeTotals([{ price: 300, quantity: 1, weightKg: 1.99 }]), { subtotal: 597, deliveryCharge: 50, total: 647 });
    assert.deepEqual(computeTotals([{ price: 300, quantity: 1, weightKg: 2 }]), { subtotal: 600, deliveryCharge: 0, total: 600 });
  });
});

const MONGO = process.env.TEST_MONGO_URL;
describe("PATCH /api/orders/:id/items with weightKg (needs TEST_MONGO_URL)", { skip: !MONGO && "set TEST_MONGO_URL to a local test MongoDB" }, () => {
  let api, conn, db, base, ADMIN, CUST;
  const dbName = `qf_test_order_weight_${process.pid}`;
  const oid = n => new mongoose.Types.ObjectId(n.toString(16).padStart(24, "0"));
  const KG = { cabbage: oid(0xe01), squash: oid(0xe02), radish: oid(0xe03), goner: oid(0xe04) };
  let seq = 0xe100;
  async function makeOrder(items, over = {}) {
    const t = computeTotals(items);
    const doc = { _id: oid(++seq), orderNumber: `QF-${seq}`, guestName: "Weigh Tester", guestPhone: "9876500000", items,
      subtotal: t.subtotal, deliveryCharge: t.deliveryCharge, total: t.total, deliveryAddress: "1 Test St", city: "Pune", deliverySlot: "Wednesday",
      status: "pending", source: "website", createdAt: new Date("2026-11-20T10:00:00Z"), updatedAt: new Date("2026-11-21T10:00:00Z"), ...over };
    await db.collection("orders").insertOne(doc);
    return doc;
  }
  const get = id => db.collection("orders").findOne({ _id: id });
  const L = (id, name, quantity, price, extra = {}) => ({ productId: id, name, slug: name.toLowerCase().replace(/\W+/g, "-"), quantity, price, ...extra });
  const body = (o, items) => ({ items: items.map(i => ({ productId: i.productId ? String(i.productId) : i.productId, quantity: i.quantity, price: i.price, ...(i.weightKg !== undefined ? { weightKg: i.weightKg } : {}) })), expectedUpdatedAt: new Date(o.updatedAt).toISOString() });
  const edit = (o, items, token = ADMIN) => H.call(base, "PATCH", `/api/orders/${o._id}/items`, { token, body: body(o, items) });

  before(async () => {
    conn = await H.seed(MONGO, dbName); db = conn.db;
    await db.collection("products").insertMany([
      { _id: KG.cabbage, name: "Chinese Cabbage Fresh", slug: "chinese-cabbage", category: "veg", quantityLabel: "1 piece (approx 1.5–2 kg)", unit: "pc", price: 80, priceUnit: "per_kg", isActive: true, stock: 9 },
      { _id: KG.squash, name: "Butternut Squash", slug: "butternut", category: "veg", quantityLabel: "1pc 500-600gm", unit: "pc", price: 150, priceUnit: "per_kg", isActive: true, stock: 9 },
      { _id: KG.radish, name: "Korean Radish", slug: "korean-radish", category: "veg", quantityLabel: "1kg", unit: "kg", price: 60, priceUnit: "per_kg", isActive: true, stock: 9 },
    ]);
    api = await H.startApi({ distDir: path.join(__dirname, "..", "dist"), mongoUrl: MONGO, dbName, port: 4100 + (process.pid % 200) });
    base = api.base;
    ADMIN = (await H.call(base, "POST", "/api/auth/login", { body: { email: "admin@qf.test", password: "Test-Pass-1" } })).body.token;
    CUST = (await H.call(base, "POST", "/api/users/login", { body: { email: "cust1@qf.test", password: "Test-Pass-1" } })).body.token;
  });
  after(async () => { if (api) await api.stop(); if (conn) { await db.dropDatabase(); await conn.close(); } });

  it("1: weighed amounts are exact (1.70 × ₹80, 0.35 × ₹150, 2.05 × ₹60) and returned with weightKg", async () => {
    const o = await makeOrder([L(KG.cabbage, "Chinese Cabbage Fresh", 1, 80), L(KG.squash, "Butternut Squash", 1, 150), L(KG.radish, "Korean Radish", 2, 60)]);
    const r = await edit(o, [L(KG.cabbage, "", 1, 80, { weightKg: 1.7 }), L(KG.squash, "", 1, 150, { weightKg: 0.35 }), L(KG.radish, "", 2, 60, { weightKg: 2.05 })]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.items.map(i => [i.quantity, i.weightKg]), [[1, 1.7], [1, 0.35], [2, 2.05]]);
    assert.deepEqual([r.body.subtotal, r.body.deliveryCharge, r.body.total], [311.5, 50, 361.5]); // 136 + 52.50 + 123
    const s = await get(o._id);
    assert.deepEqual(s.items.map(i => i.weightKg), [1.7, 0.35, 2.05]);
    assert.equal(s.items[0].quantity, 1); // piece count kept for packing
  });

  it("2: weight on a per-unit line → 400; bad weights → 400; nothing saved", async () => {
    const o = await makeOrder([L(H.IDS.product(2), "Test Product 2", 1, 102), L(KG.cabbage, "Chinese Cabbage Fresh", 1, 80)]);
    const perUnit = await edit(o, [L(H.IDS.product(2), "", 1, 102, { weightKg: 1 }), L(KG.cabbage, "", 1, 80)]);
    assert.equal(perUnit.status, 400); assert.match(perUnit.body.message, /only be set on items sold per kg/); assert.equal(perUnit.body.field, "items.0.weightKg");
    for (const w of [0, -1, 0.03, 50.01, 1.234, "abc", true]) {
      const r = await edit(o, [L(H.IDS.product(2), "", 1, 102), L(KG.cabbage, "", 1, 80, { weightKg: w })]);
      assert.equal(r.status, 400, `weight ${JSON.stringify(w)}`); assert.equal(r.body.field, "items.1.weightKg");
    }
    const s = await get(o._id);
    assert.equal(s.total, o.total); assert.ok(s.items.every(i => i.weightKg === undefined)); assert.equal(s.editHistory, undefined);
  });

  it("2b: weight on a deleted product or an old line without a product → 400", async () => {
    const o = await makeOrder([L(KG.goner, "Gone Veg", 1, 70), { name: "Old Basket", slug: "old-basket", quantity: 1, price: 250 }]);
    assert.equal((await edit(o, [L(KG.goner, "", 1, 70, { weightKg: 1 }), { productId: null, name: "Old Basket", quantity: 1, price: 250 }])).status, 400);
    const r = await H.call(base, "PATCH", `/api/orders/${o._id}/items`, { token: ADMIN, body: { items: [{ productId: String(KG.goner), quantity: 1, price: 70 }, { productId: null, name: "Old Basket", quantity: 1, price: 250, weightKg: 1 }], expectedUpdatedAt: new Date(o.updatedAt).toISOString() } });
    assert.equal(r.status, 400); assert.equal(r.body.field, "items.1.weightKg");
  });

  it("3: clearing the weight (null or omitted) → back to quantity × price", async () => {
    const o = await makeOrder([L(KG.cabbage, "Chinese Cabbage Fresh", 2, 80)]);
    const w = await edit(o, [L(KG.cabbage, "", 2, 80, { weightKg: 1.7 })]);
    assert.equal(w.body.total, 186);
    for (const clear of [null, undefined]) {
      const cur = await get(o._id);
      await edit(cur, [L(KG.cabbage, "", 2, 80, { weightKg: 1.7 })]);
      const again = await get(o._id);
      const c = await edit(again, [L(KG.cabbage, "", 2, 80, clear === null ? { weightKg: null } : {})]);
      assert.equal(c.status, 200);
      assert.equal(c.body.items[0].weightKg, undefined);
      assert.deepEqual([c.body.subtotal, c.body.deliveryCharge, c.body.total], [160, 50, 210]);
    }
  });

  it("4: ₹600 threshold crossed up and down by a weight change", async () => {
    await db.collection("products").insertOne({ _id: oid(0xe05), name: "Big Melon", slug: "big-melon", category: "veg", quantityLabel: "1 pc", unit: "pc", price: 300, priceUnit: "per_kg", isActive: true, stock: 5 });
    const o = await makeOrder([L(oid(0xe05), "Big Melon", 1, 300)]);
    let cur = o;
    for (const [w, sub, del] of [[2.1, 630, 0], [1.9, 570, 50], [2, 600, 0]]) {
      const r = await edit(cur, [L(oid(0xe05), "", 1, 300, { weightKg: w })]);
      assert.equal(r.status, 200);
      assert.deepEqual([r.body.subtotal, r.body.deliveryCharge, r.body.total], [sub, del, sub + del]);
      cur = await get(o._id);
    }
  });

  it("5: same rules as editing — status, conflict, admin only, audit entry", async () => {
    const d = await makeOrder([L(KG.cabbage, "Chinese Cabbage Fresh", 1, 80)], { status: "delivered" });
    assert.equal((await edit(d, [L(KG.cabbage, "", 1, 80, { weightKg: 1.5 })])).status, 409);
    const o = await makeOrder([L(KG.cabbage, "Chinese Cabbage Fresh", 1, 80)]);
    assert.equal((await edit(o, [L(KG.cabbage, "", 1, 80, { weightKg: 1.5 })], CUST)).status, 403);
    assert.equal((await H.call(base, "PATCH", `/api/orders/${o._id}/items`, { body: body(o, [L(KG.cabbage, "", 1, 80, { weightKg: 1.5 })]) })).status, 401);
    assert.equal((await edit(o, [L(KG.cabbage, "", 1, 80, { weightKg: 1.5 })])).status, 200);
    const stale = await edit(o, [L(KG.cabbage, "", 1, 80, { weightKg: 1.8 })]);
    assert.equal(stale.status, 409); assert.equal(stale.body.code, "CONFLICT");
    const s = await get(o._id);
    assert.equal(s.items[0].weightKg, 1.5);
    assert.equal(s.editHistory.length, 1);
    assert.equal(s.editHistory[0].before.items[0].weightKg, undefined);
    assert.equal(s.editHistory[0].after.items[0].weightKg, 1.5);
    assert.equal(s.editHistory[0].after.total, 170); // 1.5 × 80 = 120 + 50
    const list = JSON.stringify((await H.call(base, "GET", "/api/orders", { token: ADMIN })).body);
    assert.doesNotMatch(list, /editHistory/);
  });

  it("6: orders without weights — totals and responses exactly as before", async () => {
    const o = await makeOrder([L(KG.cabbage, "Chinese Cabbage Fresh", 2, 80), L(H.IDS.product(3), "Test Product 3", 1, 103)]);
    const r = await edit(o, [L(KG.cabbage, "", 3, 80), L(H.IDS.product(3), "", 1, 103)]);
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.subtotal, r.body.deliveryCharge, r.body.total], [343, 50, 393]);
    assert.ok(r.body.items.every(i => !("weightKg" in i)));
    // customer order creation is untouched (no weightKg, same totals)
    const c = await H.call(base, "POST", "/api/orders", { body: { items: [{ productId: String(KG.cabbage), name: "x", slug: "x", quantity: 2, price: 80 }], subtotal: 160, deliveryCharge: 50, total: 210, deliveryAddress: "a", city: "Pune", deliverySlot: "Saturday", guestName: "G", guestPhone: "9876500000" } });
    assert.equal(c.status, 201);
    const created = await db.collection("orders").findOne({ orderNumber: c.body.orderNumber });
    assert.deepEqual([created.subtotal, created.total, created.items[0].weightKg], [160, 210, undefined]);
  });
});
