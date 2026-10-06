// POST /api/admin/customers/[id]/impersonate + GET /api/admin/customers/[id]/usage —
// admin "login as customer" issues a real crx_session; usage view joins
// usageHistory (matched by key HMAC) to the customer's ledger debits.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let adminToken;

beforeAll(async () => {
  delete process.env.BASE_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-admin-impersonate-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  adminToken = await createDashboardAuthToken();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function req(path, { method = "GET", admin = true, body } = {}) {
  return new Request(`http://localhost:20128${path}`, {
    method,
    headers: admin ? { cookie: `auth_token=${adminToken}` } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function seedCustomer(email, usageRows) {
  const customers = await import("@/lib/db/repos/customersRepo.js");
  const keys = await import("@/lib/db/repos/customerKeysRepo.js");
  const ledger = await import("@/lib/db/repos/ledgerRepo.js");
  const db = (await import("@/lib/db/driver.js")).getAdapter ? await (await import("@/lib/db/driver.js")).getAdapter() : null;
  const c = await customers.getOrCreateCustomer({ googleSub: `seed-${email}`, email, name: `N ${email}` });
  const { key } = await keys.createCustomerKey(c.id);
  // Fund + simulate one settled request: topup credit then hold + settle debit.
  await ledger.creditCustomer(c.id, 10_000_000, { refType: "topup", refId: `tu-${email}` });
  await ledger.holdReserve(c.id, 1_000_000, `hold-${email}`);
  await ledger.settleUsage(c.id, `hold-${email}`, 250_000, { holdRefId: `hold-${email}` });
  // Raw usageHistory rows: one with this customer's presented key, one without.
  for (const row of usageRows) {
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, apiKey, promptTokens, completionTokens, cost, status, meta)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.timestamp || new Date().toISOString(), row.provider || "openai",
        row.model, row.key === undefined ? key : row.key,
        row.in ?? 100, row.out ?? 50, row.cost ?? 0.75,
        row.status || "ok", row.meta || null,
      ]
    );
  }
  return { customer: c, key };
}

describe("admin customer impersonate + usage", () => {
  it("rejects without an admin session", async () => {
    const { POST } = await import("@/app/api/admin/customers/[id]/impersonate/route.js");
    const res = await POST(req("/x", { admin: false }), { params: Promise.resolve({ id: "any" }) });
    expect(res.status).toBe(401);
    const { GET } = await import("@/app/api/admin/customers/[id]/usage/route.js");
    const res2 = await GET(req("/x", { admin: false }), { params: Promise.resolve({ id: "any" }) });
    expect(res2.status).toBe(401);
  });

  it("404s for an unknown customer", async () => {
    const { POST } = await import("@/app/api/admin/customers/[id]/impersonate/route.js");
    const res = await POST(req("/x"), { params: Promise.resolve({ id: "nope" }) });
    expect(res.status).toBe(404);
  });

  it("impersonation sets a customer-scoped crx_session cookie", async () => {
    const { customer } = await seedCustomer("imp@example.com", []);
    const { POST } = await import("@/app/api/admin/customers/[id]/impersonate/route.js");
    const res = await POST(req("/x"), { params: Promise.resolve({ id: customer.id }) });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).toContain("crx_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Max-Age=3600");
    // The cookie must verify as a customer session with this customer's id.
    const sessionMod = await import("@/lib/auth/customerSession.js");
    const token = /crx_session=([^;]+)/.exec(setCookie)[1];
    const session = await sessionMod.getCustomerSession(token);
    expect(session.customerId).toBe(customer.id);
    // And it must NOT pass as a dashboard session (scope separation).
    const dash = await import("@/lib/auth/dashboardSession.js");
    expect(await dash.getDashboardAuthSession(token)).toBeFalsy();
  });

  it("usage view lists only this customer's key rows with ledger charges", async () => {
    const { customer, key } = await seedCustomer("usage@example.com", [
      { model: "gpt-x", in: 120, out: 60, cost: 0.5, meta: JSON.stringify({ holdRefId: "hold-usage@example.com" }) },
      { model: "internal-only", key: "sk-admin-someone-else", meta: null },
      { model: "no-meta-row", meta: null },
    ]);
    const { GET } = await import("@/app/api/admin/customers/[id]/usage/route.js");
    const res = await GET(req("/x"), { params: Promise.resolve({ id: customer.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.customer.id).toBe(customer.id);
    expect(body.balanceMicros).toBe(10_000_000 - 250_000);
    expect(body.items).toHaveLength(2); // customer's own rows, no other key's
    const charged = body.items.find((r) => r.model === "gpt-x");
    expect(charged.chargedMicros).toBe(250_000);
    const nometa = body.items.find((r) => r.model === "no-meta-row");
    expect(nometa.chargedMicros).toBeNull();
    // Totals: ledger debits sum to the charged total.
    expect(body.totals.chargedMicros).toBe(250_000);
    expect(body.totals.officialMicros).toBe(1_250_000); // (0.5 + 0.75) µ$
  });
});
