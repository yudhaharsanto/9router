// GET /api/admin/reconciliation/tako — admin-only, runs runTakoReconciliation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let adminToken;

beforeAll(async () => {
  delete process.env.BASE_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-recon-admin-"));
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
  return new Request("http://localhost:20128/api/admin/reconciliation/tako", {
    headers: adminToken ? { cookie: `auth_token=${adminToken}` } : {},
  });
}

describe("GET /api/admin/reconciliation/tako", () => {
  it("401 without an admin session", async () => {
    process.env.ADMIN_AUTH_BYPASS = "";
    const mod = await import("@/app/api/admin/reconciliation/tako/route.js");
    const anon = new Request("http://localhost:20128/api/admin/reconciliation/tako");
    const res = await mod.GET(anon);
    expect([401, 403]).toContain(res.status);
  });

  it("returns reconciliation summary for an admin", async () => {
    const mod = await import("@/app/api/admin/reconciliation/tako/route.js");
    const res = await mod.GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("checked");
    expect(body).toHaveProperty("credited");
  });
});
