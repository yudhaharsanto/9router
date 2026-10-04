// Customer API routes — session-gated me/regenerate/logout.
// Route handlers are thin; we exercise them with synthetic Requests and a
// mocked next/headers cookies() where the route needs it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const originalBaseUrl = process.env.BASE_URL;
const originalNextPublicBaseUrl = process.env.NEXT_PUBLIC_BASE_URL;
let tempDir;
let db;

beforeAll(async () => {
  // getPublicOrigin must resolve from the request URL, not a stray env value.
  delete process.env.BASE_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cust-api-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalBaseUrl === undefined) delete process.env.BASE_URL;
  else process.env.BASE_URL = originalBaseUrl;
  if (originalNextPublicBaseUrl === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
  else process.env.NEXT_PUBLIC_BASE_URL = originalNextPublicBaseUrl;
});

function requestWithCookie(path, token, extra = {}) {
  return new Request(`http://localhost:20128${path}`, {
    method: extra.method || "GET",
    headers: token ? { cookie: `crx_session=${token}` } : {},
  });
}

describe("GET /api/customer/me", () => {
  it("401 without a session", async () => {
    const mod = await import("@/app/api/customer/me/route.js");
    const res = await mod.GET(requestWithCookie("/api/customer/me", null));
    expect(res.status).toBe(401);
  });

  it("returns customer, balance and key mask for a session", async () => {
    const { createCustomerAuthToken } = await import("@/lib/auth/customerSession.js");
    const c = await db.getOrCreateCustomer({ googleSub: "api-1", email: "api@x.y" });
    const { record } = await db.createCustomerKey(c.id);
    await db.creditCustomer(c.id, 2_500_000, { refType: "topup", refId: "api-t-1" });

    const token = await createCustomerAuthToken({ customerId: c.id });
    const mod = await import("@/app/api/customer/me/route.js");
    const res = await mod.GET(requestWithCookie("/api/customer/me", token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.customer.id).toBe(c.id);
    expect(body.balance.balanceMicros).toBe(2_500_000);
    expect(body.key.mask).toBe(record.keyMask);
    expect(body.revealedKey).toBeUndefined();
  });

  it("reveals the key exactly once via ?reveal=<token>", async () => {
    const { createCustomerAuthToken } = await import("@/lib/auth/customerSession.js");
    const { stageKeyReveal } = await import("@/lib/auth/customerProvision.js");
    const c = await db.getOrCreateCustomer({ googleSub: "api-2" });
    const { key } = await db.createCustomerKey(c.id);
    const revealToken = stageKeyReveal(c.id, key);

    const token = await createCustomerAuthToken({ customerId: c.id });
    const mod = await import("@/app/api/customer/me/route.js");
    const res1 = await mod.GET(requestWithCookie(`/api/customer/me?reveal=${revealToken}`, token));
    const body1 = await res1.json();
    expect(body1.revealedKey).toBe(key);

    const res2 = await mod.GET(requestWithCookie(`/api/customer/me?reveal=${revealToken}`, token));
    const body2 = await res2.json();
    expect(body2.revealedKey).toBeUndefined();
  });

  it("a reveal token staged for another customer is not honored", async () => {
    const { createCustomerAuthToken } = await import("@/lib/auth/customerSession.js");
    const { stageKeyReveal } = await import("@/lib/auth/customerProvision.js");
    const cA = await db.getOrCreateCustomer({ googleSub: "api-3" });
    const cB = await db.getOrCreateCustomer({ googleSub: "api-4" });
    const { key } = await db.createCustomerKey(cA.id);
    const revealToken = stageKeyReveal(cA.id, key);
    const tokenB = await createCustomerAuthToken({ customerId: cB.id });
    const mod = await import("@/app/api/customer/me/route.js");
    const res = await mod.GET(requestWithCookie(`/api/customer/me?reveal=${revealToken}`, tokenB));
    const body = await res.json();
    expect(body.revealedKey).toBeUndefined();
  });
});

describe("POST /api/customer/keys/regenerate", () => {
  it("revokes the old key, returns a fresh plaintext once", async () => {
    const { createCustomerAuthToken } = await import("@/lib/auth/customerSession.js");
    const c = await db.getOrCreateCustomer({ googleSub: "api-5" });
    const first = await db.createCustomerKey(c.id);
    const token = await createCustomerAuthToken({ customerId: c.id });
    const mod = await import("@/app/api/customer/keys/regenerate/route.js");
    const res = await mod.POST(requestWithCookie("/api/customer/keys/regenerate", token, { method: "POST" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toMatch(/^sk-cust-[0-9a-f]{64}$/);
    expect(body.key).not.toBe(first.key);
    // old key no longer validates
    expect(await db.validateCustomerKey(first.key)).toBeNull();
    // new one does
    expect(await db.validateCustomerKey(body.key)).not.toBeNull();
  });

  it("401 without a session", async () => {
    const mod = await import("@/app/api/customer/keys/regenerate/route.js");
    const res = await mod.POST(requestWithCookie("/api/customer/keys/regenerate", null, { method: "POST" }));
    expect(res.status).toBe(401);
  });

  it("403 for a disabled customer", async () => {
    const { createCustomerAuthToken } = await import("@/lib/auth/customerSession.js");
    const c = await db.getOrCreateCustomer({ googleSub: "api-6" });
    const token = await createCustomerAuthToken({ customerId: c.id });
    await db.setCustomerStatus(c.id, "disabled");
    const mod = await import("@/app/api/customer/keys/regenerate/route.js");
    const res = await mod.POST(requestWithCookie("/api/customer/keys/regenerate", token, { method: "POST" }));
    expect(res.status).toBe(403);
    await db.setCustomerStatus(c.id, "active");
  });

  it("rejects a cross-origin POST (403) but allows same-origin and absent Origin", async () => {
    const { createCustomerAuthToken } = await import("@/lib/auth/customerSession.js");
    const c = await db.getOrCreateCustomer({ googleSub: "api-7" });
    const token = await createCustomerAuthToken({ customerId: c.id });
    const mod = await import("@/app/api/customer/keys/regenerate/route.js");

    const evil = new Request("http://localhost:20128/api/customer/keys/regenerate", {
      method: "POST",
      headers: { cookie: `crx_session=${token}`, origin: "https://evil.example.com" },
    });
    expect((await mod.POST(evil)).status).toBe(403);

    const same = new Request("http://localhost:20128/api/customer/keys/regenerate", {
      method: "POST",
      headers: { cookie: `crx_session=${token}`, origin: "http://localhost:20128" },
    });
    expect((await mod.POST(same)).status).toBe(200);
  });
});

describe("GET /api/customer/me — cache control", () => {
  it("sends Cache-Control: no-store", async () => {
    const { createCustomerAuthToken } = await import("@/lib/auth/customerSession.js");
    const c = await db.getOrCreateCustomer({ googleSub: "api-8" });
    const token = await createCustomerAuthToken({ customerId: c.id });
    const mod = await import("@/app/api/customer/me/route.js");
    const res = await mod.GET(requestWithCookie("/api/customer/me", token));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
