// PATCH /api/orders/:id/items — admin order editing.
// Needs a LOCAL test MongoDB:  TEST_MONGO_URL=mongodb://127.0.0.1:27027 npm test
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const H = require("./helpers/apiHarness");
const { computeTotals } = require("../dist/config/pricing");

const MONGO = process.env.TEST_MONGO_URL;
const oid = n => new mongoose.Types.ObjectId(n.toString(16).padStart(24, "0"));

describe("admin order editing (needs TEST_MONGO_URL)", { skip: !MONGO && "set TEST_MONGO_URL to a local test MongoDB" }, () => {
  let api, conn, db, base, ADMIN, CUST;
  const dbName = `qf_test_order_edit_${process.pid}`;
  const P = k => String(H.IDS.product(k));
  let n = 0x8000;
  // Creates an order directly in the test DB and returns it (as stored)
  async function makeOrder(over = {}) {
    const _id = oid(++n);
    const items = over.items || [{ productId: H.IDS.product(2), name: "Test Product 2", slug: "test-product-2", quantity: 2, price: 102 }];
    const t = computeTotals(items);
    const doc = { _id, orderNumber: `QF-${n}`, guestName: "Guest", guestEmail: "g@qf.test", guestPhone: "9876500000", items,
      subtotal: t.subtotal, deliveryCharge: t.deliveryCharge, total: t.total, deliveryAddress: "1 Test Street", city: "Pune",
      deliverySlot: "Wednesday", notes: "ring bell", status: "pending", source: "website", createdAt: new Date("2026-11-20T10:00:00Z"), updatedAt: new Date("2026-11-21T10:00:00Z"), ...over };
    if (over.items && !over.subtotal) Object.assign(doc, { subtotal: t.subtotal, deliveryCharge: t.deliveryCharge, total: t.total });
    for (const k of Object.keys(doc)) if (doc[k] === undefined) delete doc[k];
    await db.collection("orders").insertOne(doc);
    return doc;
  }
  const get = id => db.collection("orders").findOne({ _id: new mongoose.Types.ObjectId(String(id)) });
  const line = (k, quantity, price) => ({ productId: P(k), name: `Test Product ${k}`, slug: `test-product-${k}`, quantity, price: price ?? 100 + k });
  const edit = (o, items, extra = {}, token = ADMIN) =>
    H.call(base, "PATCH", `/api/orders/${o._id}/items`, { token, body: { items, expectedUpdatedAt: new Date(o.updatedAt).toISOString(), ...extra } });

  before(async () => {
    conn = await H.seed(MONGO, dbName); db = conn.db;
    await db.collection("products").insertMany([
      { _id: H.IDS.product(70), name: "Price 300", slug: "price-300", category: "veg", quantityLabel: "1", unit: "pc", price: 300, isActive: true, stock: 5 },
      { _id: H.IDS.product(71), name: "Hidden Product", slug: "hidden-product", category: "veg", quantityLabel: "1", unit: "pc", price: 80, isActive: false, stock: 5 },
    ]);
    api = await H.startApi({ distDir: path.join(__dirname, "..", "dist"), mongoUrl: MONGO, dbName, port: 4300 + (process.pid % 200) });
    base = api.base;
    ADMIN = (await H.call(base, "POST", "/api/auth/login", { body: { email: "admin@qf.test", password: "Test-Pass-1" } })).body.token;
    CUST = (await H.call(base, "POST", "/api/users/login", { body: { email: "cust1@qf.test", password: "Test-Pass-1" } })).body.token;
  });
  after(async () => { if (api) await api.stop(); if (conn) { await db.dropDatabase(); await conn.close(); } });

  it("A1: totals recalculated on the server; client totals ignored/rejected as unknown fields", async () => {
    const o = await makeOrder();
    const r = await edit(o, [line(2, 3, 102)]);
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.subtotal, r.body.deliveryCharge, r.body.total], [306, 50, 356]);
    const t = await edit(await get(o._id), [line(2, 3, 102)], { total: 1 });
    assert.equal(t.status, 400); assert.match(t.body.message, /Unknown field "total"/);
  });

  it("A2: free-delivery threshold — below charges, exactly ₹600 free, above free, crossing both ways", async () => {
    const o = await makeOrder({ items: [{ productId: H.IDS.product(70), name: "Price 300", slug: "price-300", quantity: 1, price: 300 }] });
    const steps = [[1, 300, 50], [2, 600, 0], [3, 900, 0], [1, 300, 50]];
    let cur = o;
    for (const [q, sub, del] of steps) {
      const r = await edit(cur, [{ productId: P(70), name: "Price 300", slug: "price-300", quantity: q, price: 300 }]);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.subtotal, r.body.deliveryCharge, r.body.total], [sub, del, sub + del]);
      cur = await get(o._id);
    }
    const r = await edit(cur, [{ productId: P(70), name: "x", slug: "x", quantity: 1, price: 599.99 }]);
    assert.deepEqual([r.body.subtotal, r.body.deliveryCharge, r.body.total], [599.99, 50, 649.99]);
  });

  it("A3: existing prices kept, new items at the given (DB-default) price, admin-changed price saved", async () => {
    await db.collection("products").updateOne({ _id: H.IDS.product(2) }, { $set: { price: 500 } }); // catalogue price changed since the order
    const o = await makeOrder();
    const r = await edit(o, [line(2, 2, 102), line(3, 1, 103), line(4, 1, 99.5)]);
    assert.equal(r.status, 200);
    const s = await get(o._id);
    assert.deepEqual(s.items.map(i => [i.name, i.price]), [["Test Product 2", 102], ["Test Product 3", 103], ["Test Product 4", 99.5]]);
    await db.collection("products").updateOne({ _id: H.IDS.product(2) }, { $set: { price: 102 } });
  });

  it("A3b: names/slugs come from the database for new lines and stay as stored for existing lines", async () => {
    const o = await makeOrder({ items: [{ productId: H.IDS.product(5), name: "Old Name 5", slug: "old-5", quantity: 1, price: 105 }] });
    const r = await edit(o, [{ productId: P(5), name: "HACK", slug: "hack", quantity: 1, price: 105 }, { productId: P(6), name: "HACK", slug: "hack", quantity: 1, price: 106 }]);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items.map(i => [i.name, i.slug]), [["Old Name 5", "old-5"], ["Test Product 6", "test-product-6"]]);
  });

  it("A4: the same product twice is rejected (the panel increases quantity instead)", async () => {
    const o = await makeOrder();
    const r = await edit(o, [line(2, 1), line(2, 1)]);
    assert.equal(r.status, 400); assert.match(r.body.message, /appears twice/); assert.equal(r.body.field, "items.1.productId");
  });

  it("A4b: an old order that already has the same product twice (different prices) can still be saved", async () => {
    const pid = H.IDS.product(3);
    const o = await makeOrder({ items: [{ productId: pid, name: "Test Product 3", slug: "test-product-3", quantity: 1, price: 100 }, { productId: pid, name: "Test Product 3", slug: "test-product-3", quantity: 2, price: 90 }] });
    const ok = await edit(o, [line(3, 1, 100), line(3, 3, 90)]);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.items.map(i => [i.quantity, i.price]), [[1, 100], [3, 90]]);
    const three = await edit(await get(o._id), [line(3, 1, 100), line(3, 3, 90), line(3, 1, 80)]);
    assert.equal(three.status, 400); assert.match(three.body.message, /appears twice/);
  });

  it("A5: removing items works; removing all is rejected", async () => {
    const o = await makeOrder({ items: [line(2, 1), line(3, 1)].map(l => ({ ...l, productId: new mongoose.Types.ObjectId(l.productId) })) });
    const r = await edit(o, [line(3, 1)]);
    assert.equal(r.status, 200); assert.equal(r.body.items.length, 1);
    const e = await edit(await get(o._id), []);
    assert.equal(e.status, 400); assert.match(e.body.message, /at least one item/);
  });

  it("A6: invalid input → 400 with a field, nothing saved", async () => {
    const o = await makeOrder();
    const bad = [
      [[{ ...line(2, 0) }], "items.0.quantity"], [[{ ...line(2, -1) }], "items.0.quantity"], [[{ ...line(2, 1.5) }], "items.0.quantity"],
      [[{ ...line(2, 1000) }], "items.0.quantity"], [[{ ...line(2, "abc") }], "items.0.quantity"],
      [[line(2, 1, 0)], "items.0.price"], [[line(2, 1, -5)], "items.0.price"], [[line(2, 1, 10.999)], "items.0.price"],
      [[line(2, 1, "abc")], "items.0.price"], [[line(2, 1, 100001)], "items.0.price"], [[line(2, 1, 1e12)], "items.0.price"],
      [[{ ...line(2, 1), productId: String(new mongoose.Types.ObjectId()) }], "items.0.productId"],
      [[{ ...line(2, 1), productId: "nope" }], "items.0.productId"],
      [[{ ...line(2, 1), discount: 5 }], "items.0.discount"],
      [Array.from({ length: 201 }, (_, i) => ({ productId: String(new mongoose.Types.ObjectId()), quantity: 1, price: 1 })), "items"],
    ];
    for (const [items, field] of bad) {
      const r = await edit(o, items);
      assert.equal(r.status, 400, `${field} ${JSON.stringify(items).slice(0, 80)}`);
      assert.equal(r.body.field, field);
    }
    assert.equal((await edit(o, [line(2, 1)], { status: "delivered" })).status, 400); // extra top-level field
    assert.equal((await H.call(base, "PATCH", `/api/orders/${o._id}/items`, { token: ADMIN, body: { items: [line(2, 1)] } })).status, 400); // no expectedUpdatedAt
    const after_ = await get(o._id);
    assert.deepEqual(after_.items, o.items); assert.equal(after_.total, o.total); assert.equal(after_.editHistory, undefined);
  });

  it("A6b: a deleted product already in the order can stay; a deleted product cannot be added", async () => {
    const gone = new mongoose.Types.ObjectId();
    const o = await makeOrder({ items: [{ productId: gone, name: "Discontinued Veg", slug: "disc", quantity: 1, price: 90 }] });
    const keep = await edit(o, [{ productId: String(gone), quantity: 2, price: 90 }]);
    assert.equal(keep.status, 200); assert.equal(keep.body.items[0].name, "Discontinued Veg");
    const o2 = await makeOrder();
    const add = await edit(o2, [line(2, 1), { productId: String(gone), quantity: 1, price: 90 }]);
    assert.equal(add.status, 400); assert.match(add.body.message, /no longer exists/);
  });

  it("A6c: inactive and out-of-stock products can be added by the admin", async () => {
    const o = await makeOrder();
    const r = await edit(o, [line(2, 1), { productId: P(71), quantity: 1, price: 80 }, { productId: P(H.VICTIMS + 1), quantity: 1, price: 113 }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  it("A6d: legacy lines without a productId stay editable (matched by stored name)", async () => {
    const o = await makeOrder({ items: [{ name: "Old Basket", slug: "old-basket", quantity: 1, price: 250 }, { productId: H.IDS.product(2), name: "Test Product 2", slug: "test-product-2", quantity: 1, price: 102 }] });
    const r = await edit(o, [{ productId: null, name: "Old Basket", quantity: 2, price: 240 }, line(2, 1)]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.items.map(i => [i.name, i.quantity, i.price, i.productId ?? null]), [["Old Basket", 2, 240, null], ["Test Product 2", 1, 102, P(2)]]);
    const x = await edit(await get(o._id), [{ name: "Invented Item", quantity: 1, price: 10 }]);
    assert.equal(x.status, 400); assert.match(x.body.message, /not a catalogue product/);
  });

  it("A7: status rules — pending/confirmed/out_for_delivery editable; delivered/cancelled → 409", async () => {
    for (const status of ["pending", "confirmed", "out_for_delivery"]) {
      const o = await makeOrder({ status });
      assert.equal((await edit(o, [line(2, 3)])).status, 200, status);
    }
    for (const [status, msg] of [["delivered", "Delivered orders can't be edited."], ["cancelled", "Cancelled orders can't be edited."]]) {
      const o = await makeOrder({ status });
      const r = await edit(o, [line(2, 3)]);
      assert.equal(r.status, 409); assert.equal(r.body.message, msg); assert.equal(r.body.code, "NOT_EDITABLE");
      assert.equal((await get(o._id)).items[0].quantity, 2);
    }
  });

  it("A8: concurrency — stale expectedUpdatedAt → 409, order unchanged; status change in between → 409", async () => {
    const o = await makeOrder();
    const first = await edit(o, [line(2, 5)]);
    assert.equal(first.status, 200);
    const stale = await edit(o, [line(2, 9)]); // still the old updatedAt
    assert.equal(stale.status, 409); assert.equal(stale.body.message, "This order was changed by someone else. Reload and try again.");
    assert.equal((await get(o._id)).items[0].quantity, 5);
    const o2 = await makeOrder();
    await H.call(base, "PUT", `/api/orders/${o2._id}/status`, { token: ADMIN, body: { status: "confirmed" } });
    const r = await edit(o2, [line(2, 9)]);
    assert.equal(r.status, 409); assert.equal(r.body.code, "CONFLICT");
    assert.equal((await get(o2._id)).items[0].quantity, 2);
  });

  it("A8b: two admins saving at the same moment — exactly one wins", async () => {
    const o = await makeOrder();
    const [a, b] = await Promise.all([edit(o, [line(2, 7)]), edit(o, [line(2, 8)])]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const s = await get(o._id);
    assert.equal(s.editHistory.length, 1);
  });

  it("A9: auth — no token 401, customer 403, invalid 401, admin 200", async () => {
    const o = await makeOrder();
    const url = `/api/orders/${o._id}/items`, body = { items: [line(2, 3)], expectedUpdatedAt: new Date(o.updatedAt).toISOString() };
    assert.equal((await H.call(base, "PATCH", url, { body })).status, 401);
    assert.equal((await H.call(base, "PATCH", url, { token: CUST, body })).status, 403);
    assert.equal((await H.call(base, "PATCH", url, { token: "bad.token.x", body })).status, 401);
    assert.equal((await H.call(base, "PATCH", url, { token: jwt.sign({ id: String(H.IDS.cust1), role: "admin" }, H.SECRET), body })).status, 403);
    assert.equal((await H.call(base, "PATCH", url, { token: ADMIN, body })).status, 200);
  });

  it("A10: untouched fields identical after an edit", async () => {
    const o = await makeOrder({ user: H.IDS.cust1, guestName: undefined, guestEmail: undefined, guestPhone: undefined, source: "whatsapp", status: "confirmed" });
    await edit(o, [line(3, 4)]);
    const s = await get(o._id);
    for (const k of ["orderNumber", "user", "guestName", "guestEmail", "guestPhone", "deliveryAddress", "city", "deliverySlot", "notes", "status", "source", "createdAt"])
      assert.deepEqual(s[k], o[k], k);
  });

  it("A11: audit entry written; never present in admin or customer responses", async () => {
    const o = await makeOrder({ user: H.IDS.cust1, guestName: undefined, guestEmail: undefined, guestPhone: undefined });
    const r = await edit(o, [line(2, 2), line(4, 1)]);
    assert.equal(r.status, 200); assert.ok(!("editHistory" in r.body));
    const s = await get(o._id);
    assert.equal(s.editHistory.length, 1);
    const e = s.editHistory[0];
    assert.equal(e.editedBy, "admin@qf.test"); assert.ok(e.editedAt instanceof Date);
    assert.equal(e.before.total, o.total); assert.equal(e.before.items.length, 1);
    assert.equal(e.after.total, s.total); assert.equal(e.after.items.length, 2);
    const all = JSON.stringify([
      (await H.call(base, "GET", "/api/orders", { token: ADMIN })).body,
      (await H.call(base, "GET", "/api/orders/analytics", { token: ADMIN })).body,
      (await H.call(base, "GET", "/api/orders/my", { token: CUST })).body,
      (await H.call(base, "PUT", `/api/orders/${o._id}/status`, { token: ADMIN, body: { status: "confirmed" } })).body,
    ]);
    assert.doesNotMatch(all, /editHistory|editedBy/);
    assert.ok((await H.call(base, "GET", "/api/orders/my", { token: CUST })).body.some(x => x.orderNumber === o.orderNumber && x.total === s.total));
  });

  it("A12: website, WhatsApp, guest and logged-in orders all editable the same way", async () => {
    for (const over of [{ source: "website" }, { source: "whatsapp" }, { user: H.IDS.cust2, guestName: undefined, guestEmail: undefined, guestPhone: undefined }, {}]) {
      const o = await makeOrder(over);
      const r = await edit(o, [line(6, 3)]);
      assert.equal(r.status, 200, JSON.stringify(over));
      assert.deepEqual([r.body.subtotal, r.body.total], [318, 368]);
    }
  });

  it("A12b: long orders (45 lines) and 200 lines are accepted", async () => {
    const many = await db.collection("products").insertMany(Array.from({ length: 200 }, (_, i) => ({ name: `Bulk ${i}`, slug: `bulk-${i}`, category: "veg", quantityLabel: "1", unit: "pc", price: 10, isActive: true, stock: 5 })));
    const ids = Object.values(many.insertedIds).map(String);
    const o = await makeOrder();
    const r45 = await edit(o, ids.slice(0, 45).map(id => ({ productId: id, quantity: 1, price: 10 })));
    assert.equal(r45.status, 200); assert.equal(r45.body.items.length, 45);
    const r200 = await edit(await get(o._id), ids.map(id => ({ productId: id, quantity: 1, price: 10 })));
    assert.equal(r200.status, 200); assert.equal(r200.body.items.length, 200);
  });

  it("A12c: unknown order → 404", async () => {
    const r = await H.call(base, "PATCH", `/api/orders/${new mongoose.Types.ObjectId()}/items`, { token: ADMIN, body: { items: [line(2, 1)], expectedUpdatedAt: new Date().toISOString() } });
    assert.equal(r.status, 404);
  });
});
