// PATCH /api/admin/customers/[id] — admin-only status toggle.
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-admin-custpatch-"));
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

function req(id, body) {
  return new Request(`http://localhost:20128/api/admin/customers/${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(adminToken ? { cookie: `auth_token=${adminToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/admin/customers/[id]", () => {
  it("401 without an admin session", async () => {
    const mod = await import("@/app/api/admin/customers/[id]/route.js");
    const anon = new Request("http://localhost:20128/api/admin/customers/x", { method: "PATCH" });
    const res = await mod.PATCH(anon, { params: Promise.resolve({ id: "x" }) });
    expect([401, 403]).toContain(res.status);
  });

  it("disables and re-enables a customer", async () => {
    const customers = await import("@/lib/db/repos/customersRepo.js");
    const c = await customers.getOrCreateCustomer({ googleSub: "patch-1", email: "p@x.test", name: "P" });
    const mod = await import("@/app/api/admin/customers/[id]/route.js");

    const res = await mod.PATCH(req(c.id, { status: "disabled" }), { params: Promise.resolve({ id: c.id }) });
    expect(res.status).toBe(200);
    expect((await customers.getCustomerById(c.id)).status).toBe("disabled");

    // Customer key validation now rejects
    const keys = await import("@/lib/db/repos/customerKeysRepo.js");
    const { key } = await keys.createCustomerKey(c.id);
    expect(await keys.validateCustomerKey(key)).toBeNull();

    await mod.PATCH(req(c.id, { status: "active" }), { params: Promise.resolve({ id: c.id }) });
    expect((await customers.getCustomerById(c.id)).status).toBe("active");
  });

  it("400 on invalid status, 404 on unknown id", async () => {
    const mod = await import("@/app/api/admin/customers/[id]/route.js");
    const bad = await mod.PATCH(req("whatever", { status: "hacked" }), { params: Promise.resolve({ id: "whatever" }) });
    expect(bad.status).toBe(400);
    const missing = await mod.PATCH(req("no-such-id", { status: "active" }), { params: Promise.resolve({ id: "no-such-id" }) });
    expect(missing.status).toBe(404);
  });
});
