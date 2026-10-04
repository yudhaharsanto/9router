// GET /api/admin/customers — admin-only customer list with balances, key
// masks, and topup totals (phase 5c).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let adminToken;

beforeAll(async () => {
  delete process.env.BASE_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-admin-cust-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  adminToken = await createDashboardAuthToken();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function req() {
  return new Request("http://localhost:20128/api/admin/customers", {
    headers: adminToken ? { cookie: `auth_token=${adminToken}` } : {},
  });
}

async function seedCustomer(email, { topupMicros = 0 } = {}) {
  const customers = await import("@/lib/db/repos/customersRepo.js");
  const keys = await import("@/lib/db/repos/customerKeysRepo.js");
  const ledger = await import("@/lib/db/repos/ledgerRepo.js");
  const c = await customers.getOrCreateCustomer({ googleSub: `admin-${email}`, email, name: `N ${email}` });
  const { key, record } = await keys.createCustomerKey(c.id);
  let balance = 0;
  if (topupMicros > 0) {
    await ledger.creditCustomer(c.id, topupMicros, { refType: "topup", refId: `tu-${c.id}`, meta: { amountIdr: 100_000, rateMilli: 16_000_000 } });
    balance = topupMicros;
  }
  return { customer: c, key, record, balance };
}

describe("GET /api/admin/customers", () => {
  it("401 without an admin session", async () => {
    const mod = await import("@/app/api/admin/customers/route.js");
    const res = await mod.GET(new Request("http://localhost:20128/api/admin/customers"));
    expect([401, 403]).toContain(res.status);
  });

  it("returns customers with balance, key mask, topup total; no secrets", async () => {
    const { customer, record, balance } = await seedCustomer("one@x.test", { topupMicros: 2_500_000 });
    await seedCustomer("two@x.test");

    const mod = await import("@/app/api/admin/customers/route.js");
    const res = await mod.GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.customers)).toBe(true);

    const one = body.customers.find((c) => c.email === "one@x.test");
    expect(one).toBeTruthy();
    expect(one.id).toBe(customer.id);
    expect(one.balanceMicros).toBe(balance);
    expect(one.totalTopupMicros).toBe(2_500_000);
    expect(one.keyMask).toBe(record.keyMask);
    expect(one.status).toBe("active");
    expect(one.createdAt).toBeTruthy();

    const two = body.customers.find((c) => c.email === "two@x.test");
    expect(two.balanceMicros).toBe(0);
    expect(two.totalTopupMicros).toBe(0);
    // Never leak key hashes or key material
    expect(JSON.stringify(body)).not.toContain("keyHash");
  });

  it("disabled customer still listed with status", async () => {
    const { customer } = await seedCustomer("off@x.test");
    const customers = await import("@/lib/db/repos/customersRepo.js");
    await customers.setCustomerStatus(customer.id, "disabled");
    const mod = await import("@/app/api/admin/customers/route.js");
    const body = await (await mod.GET(req())).json();
    const off = body.customers.find((c) => c.email === "off@x.test");
    expect(off.status).toBe("disabled");
  });
});
