// Customer-data fixes: My Orders by account only, orders linked only via the login token,
// server-side prices/totals, and no password hashes in responses.
// Pricing unit tests always run; API tests need a LOCAL test MongoDB:
//   TEST_MONGO_URL=mongodb://127.0.0.1:27027 npm test
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const H = require("./helpers/apiHarness");
const pricing = require("../dist/config/pricing");

describe("pricing constants and totals", () => {
  it("delivery rule is pinned: ₹50 below ₹600, free at ₹600 or more", () => {
    assert.equal(pricing.FREE_DELIVERY_ABOVE, 600);
    assert.equal(pricing.DELIVERY_CHARGE, 50);
    assert.deepEqual(pricing.computeTotals([{ price: 599, quantity: 1 }]), { subtotal: 599, deliveryCharge: 50, total: 649 });
    assert.deepEqual(pricing.computeTotals([{ price: 600, quantity: 1 }]), { subtotal: 600, deliveryCharge: 0, total: 600 });
    assert.deepEqual(pricing.computeTotals([{ price: 601, quantity: 1 }]), { subtotal: 601, deliveryCharge: 0, total: 601 });
    assert.deepEqual(pricing.computeTotals([]), { subtotal: 0, deliveryCharge: 0, total: 0 });
  });
  it("totals are exact in paise (no floating-point drift)", () => {
    assert.deepEqual(pricing.computeTotals([{ price: 0.1, quantity: 3 }, { price: 19.99, quantity: 7 }]), { subtotal: 140.23, deliveryCharge: 50, total: 190.23 });
  });
  it("matches the website's config when the frontend repo is next to this one", { skip: !fs.existsSync(path.join(__dirname, "../../qualifresh-frontend/src/config/site.ts")) }, () => {
    const site = fs.readFileSync(path.join(__dirname, "../../qualifresh-frontend/src/config/site.ts"), "utf8");
    assert.equal(Number(/freeDeliveryAbove:\s*(\d+)/.exec(site)[1]), pricing.FREE_DELIVERY_ABOVE);
    assert.equal(Number(/deliveryCharge:\s*(\d+)/.exec(site)[1]), pricing.DELIVERY_CHARGE);
  });
});

const MONGO = process.env.TEST_MONGO_URL;
describe("customer data API (needs TEST_MONGO_URL)", { skip: !MONGO && "set TEST_MONGO_URL to a local test MongoDB" }, () => {
  let api, conn, db, base;
  const dbName = `qf_test_customer_data_${process.pid}`;
  const tok = id => jwt.sign({ id: String(id), email: "x@qf.test", role: "user" }, H.SECRET, { expiresIn: "1h" });
  let A, B, ADMIN;
  const all = []; // every response body, scanned for secrets at the end
  const call = async (...args) => { const r = await H.call(base, ...args); all.push(r.body); return r; };
  const P = k => String(H.IDS.product(k));
  const line = (k, quantity = 1, price) => ({ productId: P(k), name: `Test Product ${k}`, slug: `test-product-${k}`, quantity, price: price ?? 100 + k });
  const site = (items, extra = {}) => {
    const t = pricing.computeTotals(items);
    return { items, subtotal: t.subtotal, deliveryCharge: t.deliveryCharge, total: t.total, deliveryAddress: "1 Test Street", city: "Pune", deliverySlot: "Wednesday", guestName: "Guest X", guestEmail: "guestx@qf.test", guestPhone: "9876500001", ...extra };
  };
  const wa = (items, extra = {}) => {
    const t = pricing.computeTotals(items);
    return { items, subtotal: t.subtotal, deliveryCharge: t.deliveryCharge, total: t.total, address: "6 WA Road", city: "Pune", deliverySlot: "Saturday", name: "WA Guest", phone: "9876522222", email: "wa@qf.test", ...extra };
  };
  const orderById = id => db.collection("orders").findOne({ _id: new mongoose.Types.ObjectId(String(id)) });
  const count = () => db.collection("orders").countDocuments();
  const myOrders = async token => (await call("GET", "/api/orders/my", { token })).body;

  before(async () => {
    conn = await H.seed(MONGO, dbName); db = conn.db;
    // a guest order that uses customer A's email but is NOT linked to A
    await db.collection("orders").insertOne({ _id: new mongoose.Types.ObjectId("0000000000000000000049a1"), orderNumber: "QF-900", guestName: "Someone", guestEmail: "cust1@qf.test", guestPhone: "9876500009",
      items: [{ productId: H.IDS.product(0), name: "Test Product 0", slug: "test-product-0", quantity: 1, price: 100 }], subtotal: 100, deliveryCharge: 50, total: 150,
      deliveryAddress: "9 Private Road", city: "Pune", deliverySlot: "Wednesday", status: "pending", source: "website", createdAt: new Date(), updatedAt: new Date() });
    await db.collection("products").insertMany([599, 600, 601, 300].map((price, i) => ({ _id: H.IDS.product(50 + i), name: `Priced ${price}`, slug: `priced-${price}-${i}`, category: "vegetables", quantityLabel: "1", unit: "pc", price, isActive: true, stock: 5, imageUrl: "", ...{} })));
    await db.collection("products").insertOne({ _id: H.IDS.product(60), name: "Hidden Veg", slug: "hidden-veg", category: "vegetables", quantityLabel: "1", unit: "pc", price: 80, isActive: false, stock: 5, imageUrl: "" });
    api = await H.startApi({ distDir: path.join(__dirname, "..", "dist"), mongoUrl: MONGO, dbName, port: 4500 + (process.pid % 200) });
    base = api.base;
    A = (await call("POST", "/api/users/login", { body: { email: "cust1@qf.test", password: "Test-Pass-1" } })).body.token;
    B = (await call("POST", "/api/users/login", { body: { email: "cust2@qf.test", password: "Test-Pass-1" } })).body.token;
    ADMIN = (await call("POST", "/api/auth/login", { body: { email: "admin@qf.test", password: "Test-Pass-1" } })).body.token;
    assert.ok(A && B && ADMIN);
  });
  after(async () => { if (api) await api.stop(); if (conn) { await db.dropDatabase(); await conn.close(); } });

  // ── Issue 1 ──
  it("1: My Orders returns only the account's own orders (no email matching)", async () => {
    const mine = await myOrders(A);
    assert.ok(mine.length > 0);
    assert.ok(mine.every(o => o.user === String(H.IDS.cust1)));
    assert.ok(!mine.some(o => o.orderNumber === "QF-900"), "guest order with A's email must not show");
    assert.ok((await myOrders(B)).every(o => o.user === String(H.IDS.cust2)));
  });
  it("1: registering with someone else's email shows none of their orders", async () => {
    const r = await call("POST", "/api/users/register", { body: { name: "Impostor", email: "guest2@qf.test", phone: "9876543211", password: "Test-Pass-1" } });
    assert.equal(r.status, 201);
    assert.deepEqual(await myOrders(r.body.token), []);
  });
  it("1: admin still sees all orders", async () => {
    const r = await call("GET", "/api/orders", { token: ADMIN });
    assert.ok(r.body.some(o => o.orderNumber === "QF-900") && r.body.length >= 13);
  });

  // ── Issue 2 ──
  it("2: no token + someone's userId in the body → guest order, not on their My Orders", async () => {
    const r = await call("POST", "/api/orders", { body: site([line(2)], { userId: String(H.IDS.cust1) }) });
    assert.equal(r.status, 201);
    const o = await orderById(r.body.orderId);
    assert.equal(o.user, undefined);
    assert.equal(o.guestEmail, "guestx@qf.test"); // the confirmation email goes to the guest's address, never to A
    assert.ok(!(await myOrders(A)).some(x => x.orderNumber === r.body.orderNumber));
  });
  it("2: logged-in B sending A's userId → order linked to B", async () => {
    const r = await call("POST", "/api/orders", { token: B, body: site([line(2)], { userId: String(H.IDS.cust1) }) });
    assert.equal((await orderById(r.body.orderId)).user.toString(), String(H.IDS.cust2));
    assert.ok((await myOrders(B)).some(x => x.orderNumber === r.body.orderNumber));
    assert.ok(!(await myOrders(A)).some(x => x.orderNumber === r.body.orderNumber));
  });
  it("2: logged-in website and WhatsApp orders appear in My Orders", async () => {
    const w = await call("POST", "/api/orders", { token: A, body: site([line(3)]) });
    const g = await call("POST", "/api/whatsapp-order", { token: A, body: wa([line(4)]) });
    assert.equal(w.status, 201); assert.equal(g.status, 201);
    const mine = (await myOrders(A)).map(o => o.orderNumber);
    assert.ok(mine.includes(w.body.orderNumber) && mine.includes(g.body.orderNumber));
    const o = await orderById(w.body.orderId);
    assert.equal(o.guestEmail, undefined); // linked orders keep no guest fields, as before
  });
  it("2: invalid, expired, admin and deactivated-customer tokens → guest order (never rejected)", async () => {
    await db.collection("users").updateOne({ _id: H.IDS.adminUserVictim(5) }, { $set: { isActive: false } });
    const tokens = {
      invalid: "not.a.jwt",
      expired: jwt.sign({ id: String(H.IDS.cust1), role: "user", exp: Math.floor(Date.now() / 1000) - 10 }, H.SECRET),
      wrongSecret: jwt.sign({ id: String(H.IDS.cust1), role: "user" }, "other-secret"),
      admin: ADMIN,
      deactivated: tok(H.IDS.adminUserVictim(5)),
      deleted: tok(new mongoose.Types.ObjectId()),
    };
    for (const [kind, token] of Object.entries(tokens)) {
      for (const [url, body] of [["/api/orders", site([line(2)])], ["/api/whatsapp-order", wa([line(2)])]]) {
        const r = await call("POST", url, { token, body });
        assert.equal(r.status, 201, `${kind} ${url} → ${r.status}`);
        assert.equal((await orderById(r.body.orderId)).user, undefined, `${kind} ${url} must be a guest order`);
      }
    }
  });
  it("2: WhatsApp order without login works end to end; message matches the stored order", async () => {
    const r = await call("POST", "/api/whatsapp-order", { body: wa([line(5, 2), line(6, 3)]) });
    assert.equal(r.status, 201);
    const o = await orderById(r.body.orderId);
    assert.equal(o.source, "whatsapp"); assert.equal(o.user, undefined); assert.equal(o.guestName, "WA Guest");
    const text = decodeURIComponent(new URL(r.body.whatsappMessageUrl).searchParams.get("text"));
    for (const i of o.items) assert.ok(text.includes(`• ${i.name} ×${i.quantity} — ₹${i.price * i.quantity}`));
    assert.ok(text.includes(`Total: ₹${o.total}`) && text.includes(`Order: ${o.orderNumber}`));
  });

  // ── Issue 3 ──
  it("3: tampered item prices are ignored — stored order uses database prices", async () => {
    const items = [line(7, 2, 1)]; // claims ₹1 each
    const body = site(items); body.subtotal = 214; body.deliveryCharge = 50; body.total = 264; // correct totals for DB price 107
    const r = await call("POST", "/api/orders", { body });
    assert.equal(r.status, 201);
    const o = await orderById(r.body.orderId);
    assert.equal(o.items[0].price, 107); assert.equal(o.items[0].name, "Test Product 7");
    assert.deepEqual([o.subtotal, o.deliveryCharge, o.total], [214, 50, 264]);
  });
  it("3: subtotal/total off by more than ₹1 → 409 PRICES_CHANGED with current prices, nothing stored", async () => {
    for (const url of ["/api/orders", "/api/whatsapp-order"]) {
      for (const tamper of [{ subtotal: 10 }, { total: 10 }, { total: 216.5 }]) {
        const before = await count();
        const base_ = url === "/api/orders" ? site([line(8, 2)]) : wa([line(8, 2)]);
        const r = await call("POST", url, { body: { ...base_, ...tamper } });
        assert.equal(r.status, 409, `${url} ${JSON.stringify(tamper)}`);
        assert.equal(r.body.code, "PRICES_CHANGED");
        assert.deepEqual(r.body.items, [{ productId: P(8), name: "Test Product 8", price: 108 }]);
        assert.equal(await count(), before);
      }
    }
  });
  it("3: a difference of ₹1 or less is accepted and the server's totals are stored", async () => {
    const body = site([line(8, 2)]); body.total = body.total + 1; // 267 vs server 266
    const r = await call("POST", "/api/orders", { body });
    assert.equal(r.status, 201);
    assert.equal((await orderById(r.body.orderId)).total, 266);
  });
  it("3: the price changed in the database while in the cart → 409, then resend with new prices succeeds", async () => {
    await db.collection("products").updateOne({ _id: H.IDS.product(9) }, { $set: { price: 150 } });
    const stale = site([line(9, 1)]); // browser still thinks ₹109
    const r = await call("POST", "/api/orders", { body: stale });
    assert.equal(r.status, 409); assert.equal(r.body.items[0].price, 150);
    const fresh = site([line(9, 1, 150)]);
    const ok = await call("POST", "/api/orders", { body: fresh });
    assert.equal(ok.status, 201);
    assert.deepEqual([(await orderById(ok.body.orderId)).total], [200]);
  });
  it("3: delivery ₹599 → ₹50; ₹600 → free; ₹601 → free (website and WhatsApp)", async () => {
    for (const [k, price, delivery] of [[50, 599, 50], [51, 600, 0], [52, 601, 0]]) {
      const item = { productId: P(k), name: `Priced ${price}`, slug: "x", quantity: 1, price };
      for (const [url, body] of [["/api/orders", site([item])], ["/api/whatsapp-order", wa([item])]]) {
        const r = await call("POST", url, { body });
        assert.equal(r.status, 201, `${url} ${price}`);
        const o = await orderById(r.body.orderId);
        assert.deepEqual([o.subtotal, o.deliveryCharge, o.total], [price, delivery, price + delivery]);
      }
    }
  });
  it("3: unknown, deleted, inactive or missing product → 400 naming the item; nothing stored", async () => {
    await db.collection("products").deleteOne({ _id: H.IDS.product(53) }); // "Priced 300" deleted after being added to a cart
    const cases = [
      [{ productId: String(new mongoose.Types.ObjectId()), name: "Ghost Veg", quantity: 1, price: 10 }, /"Ghost Veg" is no longer available/],
      [{ productId: P(53), name: "Priced 300", quantity: 1, price: 300 }, /"Priced 300" is no longer available/],
      [{ productId: P(60), name: "Hidden Veg", quantity: 1, price: 80 }, /"Hidden Veg" is no longer available/],
      [{ name: "No Id Veg", quantity: 1, price: 10 }, /"No Id Veg" is no longer available/],
      [{ productId: "not-an-id", name: "Bad Id", quantity: 1, price: 10 }, /"Bad Id" is no longer available/],
    ];
    for (const [item, msg] of cases) for (const url of ["/api/orders", "/api/whatsapp-order"]) {
      const before = await count();
      const r = await call("POST", url, { body: url === "/api/orders" ? site([line(2), item]) : wa([line(2), item]) });
      assert.equal(r.status, 400, `${url} ${item.name}`); assert.match(r.body.message, msg);
      assert.equal(await count(), before);
    }
  });
  it("3: quantity 0, -1, 1.5, 1000, \"abc\", \"2\" → 400; nothing stored", async () => {
    for (const q of [0, -1, 1.5, 1000, "abc", "2", null]) for (const url of ["/api/orders", "/api/whatsapp-order"]) {
      const before = await count();
      const item = { ...line(2), quantity: q };
      const r = await call("POST", url, { body: url === "/api/orders" ? site([item]) : wa([item]) });
      assert.equal(r.status, 400, `${url} qty ${JSON.stringify(q)}`);
      assert.match(r.body.message, /Invalid quantity for "Test Product 2"/);
      assert.equal(await count(), before);
    }
  });
  it("3: out-of-stock behaviour unchanged (400 'Out of stock: … Remove to proceed.')", async () => {
    const r = await call("POST", "/api/orders", { body: site([line(H.VICTIMS + 1)]) });
    assert.equal(r.status, 400);
    assert.equal(r.body.message, `Out of stock: Test Product ${H.VICTIMS + 1}. Remove to proceed.`);
  });
  it("3: order numbers keep counting up as before", async () => {
    const r1 = await call("POST", "/api/orders", { body: site([line(2)]) });
    const r2 = await call("POST", "/api/whatsapp-order", { body: wa([line(2)]) });
    const n = s => Number(/^QF-(\d+)$/.exec(s)[1]);
    assert.equal(n(r2.body.orderNumber), n(r1.body.orderNumber) + 1);
  });

  // ── Issue 4 ──
  it("4: admin 'create customer' no longer returns the password hash; other fields unchanged", async () => {
    const r = await call("POST", "/api/admin/users", { token: ADMIN, body: { name: "Made", email: "made2@qf.test", phone: "9876533333", password: "x-Pass-1" } });
    assert.equal(r.status, 201);
    assert.ok(!("password" in r.body));
    for (const k of ["_id", "name", "email", "phone", "role", "isActive", "wishlist", "cart", "createdAt", "updatedAt"]) assert.ok(k in r.body, k);
    assert.deepEqual(r.body.cart, {});
  });
  it("4: logins still work; wrong password still 401", async () => {
    assert.equal((await call("POST", "/api/users/login", { body: { email: "cust2@qf.test", password: "Test-Pass-1" } })).status, 200);
    assert.equal((await call("POST", "/api/users/login", { body: { email: "cust2@qf.test", password: "nope" } })).status, 401);
    assert.equal((await call("POST", "/api/auth/login", { body: { email: "admin@qf.test", password: "Test-Pass-1" } })).status, 200);
    assert.equal((await call("POST", "/api/auth/login", { body: { email: "admin@qf.test", password: "nope" } })).status, 401);
  });
  it("4: no response anywhere contains a password field, a bcrypt hash or a reset token", async () => {
    const flows = await H.flows(base);
    for (const f of flows) all.push(f.body);
    for (const u of ["/api/admin/users", "/api/orders", "/api/orders/analytics", "/api/admin/users/stats"]) await call("GET", u, { token: ADMIN });
    for (const u of ["/api/users/profile", "/api/orders/my", "/api/users/wishlist", "/api/users/cart", "/api/users/addresses"]) await call("GET", u, { token: A });
    const text = JSON.stringify(all);
    assert.ok(all.length > 80);
    assert.doesNotMatch(text, /"password"\s*:/i);
    assert.doesNotMatch(text, /\$2[aby]\$\d\d\$/);
    assert.doesNotMatch(text, /reset(Token|Password)/i);
  });
});
