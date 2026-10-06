// GET /api/admin/topups — admin history of PAID topups (balance + package
// purchases); GET /api/admin/packages/instances — customers holding packages.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let adminToken;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-admin-topups-"));
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

function req(path) {
  return new Request(`http://localhost:20128${path}`, {
    headers: adminToken ? { cookie: `auth_token=${adminToken}` } : {},
  });
}

async function seedTopup(email, { status = "paid", amountIdr = 100_000 } = {}) {
  const customers = await import("@/lib/db/repos/customersRepo.js");
  const topups = await import("@/lib/db/repos/topupsRepo.js");
  const c = await customers.getOrCreateCustomer({ googleSub: `top-${email}`, email });
  const t = await topups.createTopup({ customerId: c.id, amountIdr, rateMilli: 16_000_000 });
  await topups.setTopupPayment(t.id, { takoTxnId: `txn-${t.id}`, paymentUrl: "https://pay.test/x" });
  if (status === "paid") {
    const ledger = await import("@/lib/db/repos/ledgerRepo.js");
    await ledger.creditCustomer(c.id, 1_000_000, { refType: "topup", refId: t.id });
    await topups.markTopupPaid(`txn-${t.id}`);
  }
  return { customer: c, topup: await topups.getTopupById(t.id) };
}

describe("GET /api/admin/topups", () => {
  it("401 without an admin session", async () => {
    const mod = await import("@/app/api/admin/topups/route.js");
    const res = await mod.GET(new Request("http://localhost:20128/api/admin/topups"));
    expect([401, 403]).toContain(res.status);
  });

  it("lists paid topups only, with customer identity", async () => {
    const paid = await seedTopup("paid@x.test", { status: "paid" });
    await seedTopup("pending@x.test", { status: "pending" });

    const mod = await import("@/app/api/admin/topups/route.js");
    const body = await (await mod.GET(req("/api/admin/topups"))).json();
    expect(Array.isArray(body.items)).toBe(true);
    const emails = body.items.map((t) => t.customerEmail);
    expect(emails).toContain("paid@x.test");
    expect(emails).not.toContain("pending@x.test");
    const row = body.items.find((t) => t.topupId === paid.topup.id);
    expect(row.amountIdr).toBe(100_000);
    expect(row.customerEmail).toBe("paid@x.test");
    expect(row.creditedMicros).toBeTruthy();
  });
});

describe("GET /api/admin/packages/instances", () => {
  it("401 without an admin session", async () => {
    const mod = await import("@/app/api/admin/packages/instances/route.js");
    const res = await mod.GET(new Request("http://localhost:20128/api/admin/packages/instances"));
    expect([401, 403]).toContain(res.status);
  });

  it("lists customers holding package instances, labeled by name", async () => {
    const customers = await import("@/lib/db/repos/customersRepo.js");
    const packages = await import("@/lib/db/repos/packagesRepo.js");
    const c = await customers.getOrCreateCustomer({ googleSub: "pkg-holder", email: "holder@x.test", name: "Hera Customer" });
    const pkg = await packages.createPackage({ name: "admin-hist", tokens: 50_000 });
    await packages.assignPackage(c.id, pkg.id);

    const mod = await import("@/app/api/admin/packages/instances/route.js");
    const body = await (await mod.GET(req("/api/admin/packages/instances"))).json();
    expect(Array.isArray(body.items)).toBe(true);
    const row = body.items.find((i) => i.customerId === c.id);
    expect(row).toBeTruthy();
    expect(row.customerLabel).toBe("Hera Customer");
    expect(row.packageName).toBe("admin-hist");
    expect(row.tokensGranted).toBe(50_000);
    expect(row.status).toBe("active");
  });
});
