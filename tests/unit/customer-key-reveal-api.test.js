// POST /api/customer/keys/reveal — session-gated re-reveal of the customer's
// active API key. 409 when the row predates encryption (or the server secret
// changed) → portal falls back to regeneration.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let token;

beforeAll(async () => {
  delete process.env.BASE_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-reveal-api-"));
  process.env.DATA_DIR = tempDir;
  process.env.JWT_SECRET = "test-jwt-secret";
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  const { createCustomerAuthToken } = await import("@/lib/auth/customerSession.js");
  const c = await db.getOrCreateCustomer({ googleSub: "reveal-api-1" });
  token = await createCustomerAuthToken({ customerId: c.id });
  await db.createCustomerKey(c.id);
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function req(overrides = {}) {
  return new Request("http://localhost:20128/api/customer/keys/reveal", {
    method: "POST",
    headers: {
      ...(token && !overrides.noSession ? { cookie: `crx_session=${token}` } : {}),
      ...overrides.headers,
    },
  });
}

describe("POST /api/customer/keys/reveal", () => {
  it("401 without a session", async () => {
    const mod = await import("@/app/api/customer/keys/reveal/route.js");
    const res = await mod.POST(req({ noSession: true }));
    expect(res.status).toBe(401);
  });

  it("returns the full plaintext key for the session's own key", async () => {
    const mod = await import("@/app/api/customer/keys/reveal/route.js");
    const res = await mod.POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toMatch(/^sk-cust-[0-9a-f]{64}$/);
  });

  it("403 on cross-site Origin mismatch", async () => {
    const mod = await import("@/app/api/customer/keys/reveal/route.js");
    const res = await mod.POST(req({ headers: { origin: "https://evil.example" } }));
    expect(res.status).toBe(403);
  });
});
