// Black-box API harness for auth tests: starts the compiled server (dist/server.js) as a child
// process against a LOCAL test MongoDB, seeds fixed test data, and builds every kind of token.
//
// Safety: the server runs with its working directory in a fresh temp folder, so `dotenv` finds
// no .env file and loads nothing; every setting (database, JWT secret, email and image keys) is
// passed explicitly with test-only values. Only 127.0.0.1/localhost databases are accepted.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const SECRET = "qf-test-only-secret";
const oid = n => new mongoose.Types.ObjectId(n.toString(16).padStart(24, "0"));

// Fixed ids so two runs (e.g. main vs hotfix) produce comparable responses.
const IDS = {
  admin: oid(0xa1), deletedAdmin: oid(0xa2),
  cust1: oid(0xc1), cust2: oid(0xc2), userRoleAdmin: oid(0xc3),
  product: k => oid(0x1000 + k), category: k => `test-cat-${k}`, farm: k => oid(0x2000 + k),
  testimonial: k => oid(0x3000 + k), order: k => oid(0x4000 + k), adminUserVictim: k => oid(0x5000 + k),
  address: k => oid(0x6000 + k),
};
const VICTIMS = 12; // one target document per token kind for routes that change/delete data

function assertLocal(url) {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") throw new Error(`Refusing non-local test database: ${host}`);
}

async function seed(mongoUrl, dbName) {
  assertLocal(mongoUrl);
  const conn = await mongoose.createConnection(`${mongoUrl}/${dbName}`).asPromise();
  const db = conn.db;
  await db.dropDatabase();
  const now = new Date("2026-11-20T10:00:00Z");
  const ts = { createdAt: now, updatedAt: now };
  const hash = await bcrypt.hash("Test-Pass-1", 4);
  await db.collection("adminusers").insertMany([
    { _id: IDS.admin, email: "admin@qf.test", password: hash, ...ts },
    { _id: IDS.deletedAdmin, email: "old-admin@qf.test", password: hash, ...ts },
  ]);
  await db.collection("adminusers").deleteOne({ _id: IDS.deletedAdmin }); // an admin account that was removed
  const user = (id, n, role) => ({ _id: id, name: `Customer ${n}`, email: `${n}@qf.test`, phone: "9876543210", password: hash, role, isActive: true, cart: {}, wishlist: [], ...ts });
  await db.collection("users").insertMany([
    user(IDS.cust1, "cust1", "user"), user(IDS.cust2, "cust2", "user"), user(IDS.userRoleAdmin, "roleadmin", "admin"),
    ...Array.from({ length: VICTIMS }, (_, k) => user(IDS.adminUserVictim(k), `victim${k}`, "user")),
  ]);
  await db.collection("products").insertMany(Array.from({ length: VICTIMS + 2 }, (_, k) => ({
    _id: IDS.product(k), name: `Test Product ${k}`, slug: `test-product-${k}`, category: "vegetables", description: "",
    quantityLabel: "250g", unit: "pack", price: 100 + k, priceUnit: "per_unit", isImported: false, isActive: true,
    stock: k === VICTIMS + 1 ? 0 : 10, tags: [], images: [], imageUrl: `https://img.example.test/p${k}.webp`, imagePublicId: "", ...ts,
  })));
  await db.collection("categories").insertMany(Array.from({ length: VICTIMS }, (_, k) => ({
    key: IDS.category(k), label: `Test Category ${k}`, imageUrl: "", color: "#2d8a4e", icon: "🥦", isCustom: true, order: k, ...ts,
  })));
  await db.collection("farmphotos").insertMany(Array.from({ length: VICTIMS }, (_, k) => ({
    _id: IDS.farm(k), title: `Farm ${k}`, description: "", imageUrl: `https://img.example.test/f${k}.webp`, order: k, ...ts,
  })));
  await db.collection("testimonials").insertMany(Array.from({ length: VICTIMS }, (_, k) => ({
    _id: IDS.testimonial(k), name: `Reviewer ${k}`, role: "", message: "Great veggies", location: "Pune", rating: 5,
    avatarUrl: "", images: [], isActive: true, sortOrder: k, ...ts,
  })));
  await db.collection("orders").insertMany(Array.from({ length: VICTIMS }, (_, k) => ({
    _id: IDS.order(k), orderNumber: `QF-${k + 1}`,
    ...(k % 3 === 0 ? { user: IDS.cust1 } : k % 3 === 1 ? { user: IDS.cust2 } : { guestName: `Guest ${k}`, guestEmail: `guest${k}@qf.test`, guestPhone: "9876500000" }),
    items: [{ _id: oid(0x7000 + k), productId: IDS.product(0), name: "Test Product 0", slug: "test-product-0", quantity: 2, price: 100 }],
    subtotal: 200, deliveryCharge: 50, total: 250, deliveryAddress: "1 Test Street", city: "Pune", deliverySlot: "Wednesday",
    status: "pending", source: k % 2 ? "whatsapp" : "website", ...ts,
  })));
  await db.collection("counters").insertOne({ _id: "orderNumber", seq: VICTIMS });
  await db.collection("addresses").insertMany([
    { _id: IDS.address(1), userId: IDS.cust1, label: "Home", line1: "1 Test Street", city: "Pune", pincode: "411001", ...ts },
    { _id: IDS.address(2), userId: IDS.cust2, label: "Home", line1: "2 Other Street", city: "Pune", pincode: "411002", ...ts },
  ]);
  return conn;
}

async function startApi({ distDir, mongoUrl, dbName, port }) {
  assertLocal(mongoUrl);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "qf-api-")); // no .env here → dotenv loads nothing
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: String(port), MONGO_URI: `${mongoUrl}/${dbName}`, JWT_SECRET: SECRET,
    BREVO_API_KEY: "", EMAIL_HOST: "", EMAIL_PORT: "", EMAIL_USER: "", EMAIL_PASS: "",
    CLOUDINARY_CLOUD_NAME: "invalid-test-cloud", CLOUDINARY_API_KEY: "invalid", CLOUDINARY_API_SECRET: "invalid",
    STORAGE_PROVIDER: "cloudinary", ALLOWED_ORIGINS: "",
  };
  const child = spawn(process.execPath, [path.join(distDir, "server.js")], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", d => { log += d; }); child.stderr.on("data", d => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/")).ok) break; } catch {}
    if (child.exitCode !== null) throw new Error("API exited:\n" + log);
    await new Promise(r => setTimeout(r, 150));
  }
  return {
    base, log: () => log,
    stop: () => new Promise(r => { child.once("exit", r); child.kill(); setTimeout(r, 3000); }),
  };
}

async function call(base, method, url, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const r = await fetch(base + url, { method, headers, body: payload });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}

// A "PNG" that is not a real image: passes the upload MIME filter (and therefore reaches the
// route's own code only after auth), then is rejected by the sharp check with a 400 — so admin
// upload calls never contact Cloudinary.
function fakeImageForm(fields = {}) {
  const fd = new FormData();
  fd.append("image", new Blob([Buffer.from("not really an image")], { type: "image/png" }), "x.png");
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

// Every admin-only route. `k` picks a dedicated target document so destructive calls made with
// one token kind never affect another.
const ADMIN_ROUTES = [
  ["GET", "/api/orders", () => ({})],
  ["PUT", "/api/orders/:id/status", k => ({ url: `/api/orders/${IDS.order(k)}/status`, body: { status: "confirmed" } })],
  ["DELETE", "/api/orders/:id", k => ({ url: `/api/orders/${IDS.order(k)}` })],
  ["GET", "/api/orders/analytics", () => ({})],
  ["POST", "/api/admin/users", k => ({ body: { name: "New", email: `new${k}-${Date.now()}@qf.test`, phone: "9876543210", password: "x-Pass-1" } })],
  ["PUT", "/api/admin/users/:id", k => ({ url: `/api/admin/users/${IDS.adminUserVictim(k)}`, body: { name: `Renamed ${k}` } })],
  ["GET", "/api/admin/users", () => ({})],
  ["DELETE", "/api/admin/users/:id", k => ({ url: `/api/admin/users/${IDS.adminUserVictim(k)}` })],
  ["GET", "/api/admin/users/stats", () => ({})],
  ["GET", "/api/products/admin/all", () => ({})],
  ["POST", "/api/products", k => ({ body: { name: `Created ${k}`, slug: `created-${k}-${Date.now()}`, category: "vegetables", quantityLabel: "1kg", unit: "kg", price: 50, imageUrl: "https://img.example.test/new.webp" } })],
  ["PUT", "/api/products/:id", k => ({ url: `/api/products/${IDS.product(k)}`, body: { price: 999 } })],
  ["DELETE", "/api/products/:id", k => ({ url: `/api/products/${IDS.product(k)}` })],
  ["POST", "/api/categories/upload", k => ({ form: () => fakeImageForm({ key: `up-${k}`, label: "Up" }) })],
  ["POST", "/api/categories", k => ({ body: { key: `made-${k}`, label: "Made" } })],
  ["DELETE", "/api/categories/key/:key", k => ({ url: `/api/categories/key/${IDS.category(k)}` })],
  ["POST", "/api/farms/upload", () => ({ form: () => fakeImageForm({ title: "Farm" }) })],
  ["POST", "/api/farms", k => ({ body: { title: `New farm ${k}`, imageUrl: "https://img.example.test/nf.webp" } })],
  ["PUT", "/api/farms/:id", k => ({ url: `/api/farms/${IDS.farm(k)}`, body: { title: `Edited ${k}` } })],
  ["DELETE", "/api/farms/:id", k => ({ url: `/api/farms/${IDS.farm(k)}` })],
  ["GET", "/api/testimonials/all", () => ({})],
  ["POST", "/api/testimonials", k => ({ body: { name: `New reviewer ${k}`, message: "Lovely" } })],
  ["PUT", "/api/testimonials/:id", k => ({ url: `/api/testimonials/${IDS.testimonial(k)}`, body: { name: `Edited ${k}`, message: "Edited" } })],
  ["DELETE", "/api/testimonials/:id", k => ({ url: `/api/testimonials/${IDS.testimonial(k)}` })],
  ["POST", "/api/upload", () => ({ form: () => fakeImageForm({ folder: "qualifresh-products" }) })],
];

async function callAdminRoute(base, route, k, token) {
  const [method, path_, build] = route;
  const b = build(k);
  return call(base, method, b.url || path_, { token, body: b.body, form: b.form && b.form() });
}

// Token kinds. Customer tokens come from the real customer login; "admin (login)" from the real admin login.
async function tokens(base) {
  const adminLogin = await call(base, "POST", "/api/auth/login", { body: { email: "admin@qf.test", password: "Test-Pass-1" } });
  const custLogin = await call(base, "POST", "/api/users/login", { body: { email: "cust1@qf.test", password: "Test-Pass-1" } });
  // Customer login only issues tokens to role "user" accounts, so a signed token for the
  // role-"admin" User document is built directly (same payload shape as a customer token).
  return {
    "no token": null,
    "garbage token": "not.a.jwt",
    "wrong secret": jwt.sign({ id: String(IDS.admin), email: "admin@qf.test", role: "admin" }, "some-other-secret"),
    "expired admin token": jwt.sign({ id: String(IDS.admin), email: "admin@qf.test", role: "admin", exp: Math.floor(Date.now() / 1000) - 60 }, SECRET),
    "customer token": custLogin.body.token,
    "User with role admin": jwt.sign({ id: String(IDS.userRoleAdmin), email: "roleadmin@qf.test", role: "admin" }, SECRET, { expiresIn: "30d" }),
    "deleted admin (legacy)": jwt.sign({ id: String(IDS.deletedAdmin), email: "old-admin@qf.test" }, SECRET, { expiresIn: "7d" }),
    "deleted admin (new)": jwt.sign({ id: String(IDS.deletedAdmin), email: "old-admin@qf.test", role: "admin" }, SECRET, { expiresIn: "7d" }),
    "admin, role but unknown id": jwt.sign({ id: String(oid(0xdead)), email: "admin@qf.test", role: "admin" }, SECRET),
    "admin (login token)": adminLogin.body.token,
    "admin (legacy no-role token)": jwt.sign({ id: String(IDS.admin), email: "admin@qf.test" }, SECRET, { expiresIn: "7d" }),
  };
}

// Replace values that legitimately differ between runs (generated ids, timestamps, tokens).
function normalize(v) {
  const walk = x => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
    if (typeof x !== "string") return x;
    if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(x)) return "<jwt>";
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(x) && !x.startsWith("2026-11-20T10:00:00")) return "<date>";
    if (/^\d{4}-\d\d-\d\d$/.test(x)) return "<day>";
    if (/^[0-9a-f]{24}$/.test(x) && !/^0{12}/.test(x)) return "<new-id>";
    return x;
  };
  return walk(v);
}

// Scripted public, customer and admin calls (in a fixed order) — used to prove responses are
// unchanged by the fix (run once per build on a freshly seeded database, then compare).
async function flows(base) {
  const out = [];
  const rec = async (name, method, url, opts) => { const r = await call(base, method, url, opts); out.push({ name, status: r.status, body: normalize(r.body) }); return r; };
  const P = k => String(IDS.product(k));
  const item = k => ({ productId: P(k), name: `Test Product ${k}`, slug: `test-product-${k}`, quantity: 2, price: 100 + k });
  // public
  await rec("public: product list", "GET", "/api/products");
  await rec("public: product by slug", "GET", "/api/products/test-product-1");
  await rec("public: categories", "GET", "/api/categories");
  await rec("public: farms", "GET", "/api/farms");
  await rec("public: testimonials", "GET", "/api/testimonials");
  // customer
  await rec("customer: sign up", "POST", "/api/users/register", { body: { name: "New Customer", email: "newcust@qf.test", phone: "9876543210", password: "Test-Pass-1" } });
  const c1 = (await rec("customer: log in (cust1)", "POST", "/api/users/login", { body: { email: "cust1@qf.test", password: "Test-Pass-1" } })).body.token;
  const c2 = (await rec("customer: log in (cust2)", "POST", "/api/users/login", { body: { email: "cust2@qf.test", password: "Test-Pass-1" } })).body.token;
  await rec("customer: get profile", "GET", "/api/users/profile", { token: c1 });
  await rec("customer: update profile", "PUT", "/api/users/profile", { token: c1, body: { name: "Customer One" } });
  await rec("customer: save cart (incl. out-of-stock)", "PUT", "/api/users/cart", { token: c1, body: { cart: { [P(2)]: 2, [P(VICTIMS + 1)]: 1 } } });
  await rec("customer: get cart", "GET", "/api/users/cart", { token: c1 });
  await rec("customer: wishlist add", "POST", `/api/users/wishlist/${P(3)}`, { token: c1 });
  await rec("customer: wishlist get", "GET", "/api/users/wishlist", { token: c1 });
  await rec("customer: wishlist remove", "DELETE", `/api/users/wishlist/${P(3)}`, { token: c1 });
  await rec("customer: addresses list", "GET", "/api/users/addresses", { token: c1 });
  await rec("customer: address add", "POST", "/api/users/addresses", { token: c1, body: { label: "Work", line1: "9 Work Road", city: "Pune", pincode: "411005" } });
  await rec("customer: address update own", "PUT", `/api/users/addresses/${IDS.address(1)}`, { token: c1, body: { line1: "1A Test Street" } });
  await rec("customer: address update someone else's", "PUT", `/api/users/addresses/${IDS.address(2)}`, { token: c1, body: { line1: "hijack" } });
  await rec("customer: address delete someone else's", "DELETE", `/api/users/addresses/${IDS.address(2)}`, { token: c1 });
  await rec("customer: other customer's addresses intact", "GET", "/api/users/addresses", { token: c2 });
  await rec("customer: place website order (logged in)", "POST", "/api/orders", { body: { items: [item(2)], subtotal: 204, deliveryCharge: 50, total: 254, deliveryAddress: "1 Test Street", city: "Pune", deliverySlot: "Wednesday", userId: String(IDS.cust1) } });
  await rec("customer: place website order (guest)", "POST", "/api/orders", { body: { items: [item(3)], subtotal: 206, deliveryCharge: 50, total: 256, deliveryAddress: "5 Guest Lane", city: "Pune", deliverySlot: "Saturday", guestName: "Guest New", guestEmail: "guestnew@qf.test", guestPhone: "9876511111" } });
  await rec("customer: place WhatsApp order", "POST", "/api/whatsapp-order", { body: { items: [item(4)], subtotal: 208, deliveryCharge: 50, total: 258, address: "6 WA Road", city: "Pune", deliverySlot: "Wednesday", name: "WA Guest", phone: "9876522222", email: "wa@qf.test" } });
  await rec("customer: order with out-of-stock item rejected", "POST", "/api/orders", { body: { items: [item(VICTIMS + 1)], subtotal: 1, deliveryCharge: 0, total: 1, deliveryAddress: "x", city: "Pune", deliverySlot: "Wednesday" } });
  await rec("customer: my orders (cust1)", "GET", "/api/orders/my", { token: c1 });
  await rec("customer: my orders (cust2)", "GET", "/api/orders/my", { token: c2 });
  // admin
  const a = (await rec("admin: log in", "POST", "/api/auth/login", { body: { email: "admin@qf.test", password: "Test-Pass-1" } })).body.token;
  await rec("admin: log in wrong password", "POST", "/api/auth/login", { body: { email: "admin@qf.test", password: "wrong" } });
  await rec("admin: orders list", "GET", "/api/orders", { token: a });
  await rec("admin: order status change", "PUT", `/api/orders/${IDS.order(0)}/status`, { token: a, body: { status: "confirmed" } });
  await rec("admin: order delete", "DELETE", `/api/orders/${IDS.order(1)}`, { token: a });
  await rec("admin: analytics", "GET", "/api/orders/analytics", { token: a });
  await rec("admin: products (all)", "GET", "/api/products/admin/all", { token: a });
  await rec("admin: product create", "POST", "/api/products", { token: a, body: { name: "Flow Product", slug: "flow-product", category: "vegetables", quantityLabel: "1kg", unit: "kg", price: 75, imageUrl: "https://img.example.test/flow.webp" } });
  await rec("admin: product update", "PUT", `/api/products/${P(0)}`, { token: a, body: { price: 111 } });
  await rec("admin: product delete", "DELETE", `/api/products/${P(1)}`, { token: a });
  await rec("admin: category save", "POST", "/api/categories", { token: a, body: { key: "flow-cat", label: "Flow Cat" } });
  await rec("admin: category delete", "DELETE", `/api/categories/key/${IDS.category(0)}`, { token: a });
  await rec("admin: farm create", "POST", "/api/farms", { token: a, body: { title: "Flow farm", imageUrl: "https://img.example.test/ff.webp" } });
  await rec("admin: farm update", "PUT", `/api/farms/${IDS.farm(0)}`, { token: a, body: { title: "Flow farm edited" } });
  await rec("admin: farm delete", "DELETE", `/api/farms/${IDS.farm(1)}`, { token: a });
  await rec("admin: testimonials (all)", "GET", "/api/testimonials/all", { token: a });
  await rec("admin: testimonial create", "POST", "/api/testimonials", { token: a, body: { name: "Flow reviewer", message: "Nice" } });
  await rec("admin: testimonial update", "PUT", `/api/testimonials/${IDS.testimonial(0)}`, { token: a, body: { name: "Edited", message: "Edited msg" } });
  await rec("admin: testimonial delete", "DELETE", `/api/testimonials/${IDS.testimonial(1)}`, { token: a });
  await rec("admin: users create", "POST", "/api/admin/users", { token: a, body: { name: "Made By Admin", email: "made@qf.test", phone: "9876533333", password: "x-Pass-1" } });
  await rec("admin: users update", "PUT", `/api/admin/users/${IDS.adminUserVictim(0)}`, { token: a, body: { name: "Victim Renamed" } });
  await rec("admin: users list", "GET", "/api/admin/users", { token: a });
  await rec("admin: users delete", "DELETE", `/api/admin/users/${IDS.adminUserVictim(1)}`, { token: a });
  await rec("admin: users stats", "GET", "/api/admin/users/stats", { token: a });
  await rec("admin: image upload (products)", "POST", "/api/upload", { token: a, form: fakeImageForm({ folder: "qualifresh-products" }) });
  await rec("admin: image upload (farms)", "POST", "/api/farms/upload", { token: a, form: fakeImageForm({ title: "x" }) });
  await rec("admin: image upload (category)", "POST", "/api/categories/upload", { token: a, form: fakeImageForm({ key: "k", label: "L" }) });
  await rec("customer: my orders after admin changes", "GET", "/api/orders/my", { token: c1 });
  return out;
}

module.exports = { flows, SECRET, IDS, VICTIMS, seed, startApi, call, tokens, ADMIN_ROUTES, callAdminRoute, normalize, fakeImageForm };
