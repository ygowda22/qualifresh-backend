// Admin-only routes must refuse customer tokens and anything that is not a real admin.
// Runs the compiled server against a LOCAL test MongoDB only:
//   TEST_MONGO_URL=mongodb://127.0.0.1:27027 npm test
// Without TEST_MONGO_URL these tests are skipped (the unit tests still run).
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const jwt = require("jsonwebtoken");
const H = require("./helpers/apiHarness");

const MONGO = process.env.TEST_MONGO_URL;
const DIST = path.join(__dirname, "..", "dist");

describe("admin-only routes (needs TEST_MONGO_URL)", { skip: !MONGO && "set TEST_MONGO_URL to a local test MongoDB" }, () => {
  let api, conn, T;
  const db = `qf_test_admin_auth_${process.pid}`;

  before(async () => {
    conn = await H.seed(MONGO, db);
    api = await H.startApi({ distDir: DIST, mongoUrl: MONGO, dbName: db, port: 4700 + (process.pid % 200) });
    T = await H.tokens(api.base);
  });
  after(async () => {
    if (api) await api.stop();
    if (conn) { await conn.db.dropDatabase(); await conn.close(); }
  });

  it("admin login token now carries role \"admin\"; login response shape unchanged", async () => {
    const r = await H.call(api.base, "POST", "/api/auth/login", { body: { email: "admin@qf.test", password: "Test-Pass-1" } });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ["email", "token"]);
    assert.equal(jwt.decode(r.body.token).role, "admin");
  });

  const EXPECT = {
    "no token": 401, "garbage token": 401, "wrong secret": 401, "expired admin token": 401,
    "customer token": 403, "User with role admin": 403, "deleted admin (legacy)": 403, "deleted admin (new)": 403,
    "admin, role but unknown id": 403,
  };
  const ADMIN_KINDS = ["admin (login token)", "admin (legacy no-role token)"];

  for (const route of H.ADMIN_ROUTES) {
    it(`${route[0]} ${route[1]}: refused for non-admins, works for admins`, async () => {
      const kinds = Object.keys(T);
      for (const [k, kind] of kinds.entries()) {
        const r = await H.callAdminRoute(api.base, route, k, T[kind]);
        if (kind in EXPECT) {
          assert.equal(r.status, EXPECT[kind], `${kind} → ${r.status} ${JSON.stringify(r.body)}`);
        } else {
          assert.ok(ADMIN_KINDS.includes(kind));
          const isUpload = route[1].endsWith("upload") || route[1] === "/api/upload";
          if (isUpload) assert.equal(r.status, 400, `${kind}: upload should reach the image check (got ${r.status})`);
          else assert.ok(r.status >= 200 && r.status < 300, `${kind} → ${r.status} ${JSON.stringify(r.body)}`);
        }
      }
    });
  }

  it("refused requests change nothing (customer cannot delete an order or a product)", async () => {
    const cust = T["customer token"];
    await H.call(api.base, "DELETE", `/api/orders/${H.IDS.order(H.VICTIMS - 1)}`, { token: cust });
    await H.call(api.base, "DELETE", `/api/products/${H.IDS.product(H.VICTIMS - 1)}`, { token: cust });
    assert.ok(await conn.db.collection("orders").findOne({ _id: H.IDS.order(H.VICTIMS - 1) }));
    assert.ok(await conn.db.collection("products").findOne({ _id: H.IDS.product(H.VICTIMS - 1) }));
  });

  it("customer endpoints still work and only return the caller's own data", async () => {
    const out = await H.flows(api.base);
    const by = n => out.find(o => o.name === n);
    for (const o of out.filter(o => o.name.startsWith("customer:") || o.name.startsWith("public:")))
      assert.ok(o.status < 500, `${o.name} → ${o.status}`);
    const mine1 = by("customer: my orders (cust1)").body, mine2 = by("customer: my orders (cust2)").body;
    assert.ok(mine1.length > 0 && mine2.length > 0);
    assert.ok(mine1.every(o => o.user === String(H.IDS.cust1)), "cust1 sees only own orders");
    assert.ok(mine2.every(o => o.user === String(H.IDS.cust2)), "cust2 sees only own orders");
    assert.equal(by("customer: address update someone else's").status, 404);
    assert.equal(by("customer: other customer's addresses intact").body.addresses[0].line1, "2 Other Street");
    assert.equal(by("admin: orders list").status, 200);
  });
});
