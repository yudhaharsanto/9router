// Admin balance adjustment: POST /api/admin/customers/[id]/balance
// { amountUsd: signed number, reason? } → adjustBalance ledger entry.
// Positive credits, negative debits; debit that would overdraw is rejected
// (balance cannot go below 0 through admin adjustment).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let adminToken;
let customerId;

beforeAll(async () => {
  delete process.env.BASE_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-admin-bal-"));
  process.env.DATA_DIR = tempDir;
  process.env.JWT_SECRET = "test-secret";
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();

  const customers = await import("@/lib/db/repos/customersRepo.js");
  const ledger = await import("@/lib/db/repos/ledgerRepo.js");
  const c = await customers.getOrCreateCustomer({ googleSub: "bal-1", email: "bal@x.test", name: "BAL" });
  customerId = c.id;
  await ledger.creditCustomer(c.id, 5_000_000, { refType: "test", refId: "seed" }); // $5

  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  adminToken = await createDashboardAuthToken();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function req(body, method = "POST") {
  return new Request(`http://localhost:20128/api/admin/customers/${customerId}/balance`, {
    method,
    headers: { cookie: `auth_token=${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = (id = customerId) => ({ params: Promise.resolve({ id }) });

describe("POST /api/admin/customers/[id]/balance", () => {
  it("401 without admin session", async () => {
    const mod = await import("@/app/api/admin/customers/[id]/balance/route.js");
    const res = await mod.POST(new Request(
      `http://localhost:20128/api/admin/customers/${customerId}/balance`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amountUsd: 1 }) },
    ), ctx());
    expect([401, 403]).toContain(res.status);
  });

  it("credits USD, records an adjustment ledger entry", async () => {
    const mod = await import("@/app/api/admin/customers/[id]/balance/route.js");
    const res = await mod.POST(req({ amountUsd: 2.5, reason: "promo" }), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    // $5 + $2.5 = $7.5
    expect(body.balance.balanceMicros).toBe(7_500_000);

    const ledger = await import("@/lib/db/repos/ledgerRepo.js");
    const entries = await ledger.getLedger(customerId, { limit: 5, type: "adjustment" });
    const adj = entries[0];
    expect(adj.amountMicros).toBe(2_500_000);
    expect(adj.meta.reason).toBe("promo");
  });

  it("negative amount debits; overdraft rejected with 400", async () => {
    const mod = await import("@/app/api/admin/customers/[id]/balance/route.js");
    const ok = await mod.POST(req({ amountUsd: -1 }), ctx());
    expect(ok.status).toBe(200);
    const okBody = await ok.json();
    expect(okBody.balance.balanceMicros).toBe(6_500_000);

    const over = await mod.POST(req({ amountUsd: -999 }), ctx());
    expect(over.status).toBe(400);

    const zero = await mod.POST(req({ amountUsd: 0 }), ctx());
    expect(zero.status).toBe(400);
  });

  it("400 on invalid amount / missing customer", async () => {
    const mod = await import("@/app/api/admin/customers/[id]/balance/route.js");
    const bad = await mod.POST(req({ amountUsd: "abc" }), ctx());
    expect(bad.status).toBe(400);

    const missing = await mod.POST(new Request(
      "http://localhost:20128/api/admin/customers/no-such-cust/balance",
      { method: "POST", headers: { cookie: `auth_token=${adminToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ amountUsd: 1 }) },
    ), ctx("no-such-cust"));
    expect(missing.status).toBe(404);
  });
});
