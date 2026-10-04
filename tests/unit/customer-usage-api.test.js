// GET /api/customer/usage + GET /api/customer/ledger — session-gated,
// customer-scoped. Usage rows are matched to the caller by HMAC-hashing the
// plaintext apiKey stored in usageHistory against this customer's keyHash.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  delete process.env.BASE_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cust-usage-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function req(path, token, extra = {}) {
  return new Request(`http://localhost:20128${path}`, {
    method: extra.method || "GET",
    headers: token ? { cookie: `crx_session=${token}` } : {},
  });
}

async function sessionFor(customer) {
  const { createCustomerAuthToken } = await import("@/lib/auth/customerSession.js");
  return createCustomerAuthToken({ customerId: customer.id });
}

describe("GET /api/customer/usage", () => {
  it("401 without a session", async () => {
    const mod = await import("@/app/api/customer/usage/route.js");
    const res = await mod.GET(req("/api/customer/usage", null));
    expect(res.status).toBe(401);
  });

  it("returns only rows whose stored apiKey hashes to this customer's active key", async () => {
    const cA = await db.getOrCreateCustomer({ googleSub: "usg-1" });
    const cB = await db.getOrCreateCustomer({ googleSub: "usg-2" });
    const keyA = (await db.createCustomerKey(cA.id)).key;
    const keyB = (await db.createCustomerKey(cB.id)).key;
    const tokenA = await sessionFor(cA);

    await db.saveRequestUsage({ provider: "openai", model: "gpt-4o", tokens: { prompt_tokens: 10, completion_tokens: 5 }, apiKey: keyA });
    await db.saveRequestUsage({ provider: "openai", model: "gpt-4o", tokens: { prompt_tokens: 20, completion_tokens: 8 }, apiKey: keyB });
    await db.saveRequestUsage({ provider: "openai", model: "o3", tokens: { prompt_tokens: 1, completion_tokens: 1 }, apiKey: "local-no-key" });

    const mod = await import("@/app/api/customer/usage/route.js");
    const res = await mod.GET(req("/api/customer/usage", tokenA));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBe(1);
    // no plaintext key material in responses
    expect(JSON.stringify(body.items)).not.toContain(keyA.slice(8));
    expect(body.items[0].model).toBe("gpt-4o");
    expect(body.items[0].mask).toBe(`sk-cust-…${keyA.slice(-4)}`);
  });

  it("no rows when the customer has no usage", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "usg-3" });
    await db.createCustomerKey(c.id);
    const token = await sessionFor(c);
    const mod = await import("@/app/api/customer/usage/route.js");
    const res = await mod.GET(req("/api/customer/usage", token));
    const body = await res.json();
    expect(body.items).toEqual([]);
  });

  it("period filter 7d returns recent rows", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "usg-4" });
    const key = (await db.createCustomerKey(c.id)).key;
    const token = await sessionFor(c);
    await db.saveRequestUsage({ provider: "p", model: "m", tokens: { prompt_tokens: 1, completion_tokens: 1 }, apiKey: key });
    const mod = await import("@/app/api/customer/usage/route.js");
    const res = await mod.GET(req("/api/customer/usage?period=7d", token));
    const body = await res.json();
    expect(body.items.length).toBe(1);
  });
});

describe("GET /api/customer/ledger", () => {
  it("401 without a session", async () => {
    const mod = await import("@/app/api/customer/ledger/route.js");
    const res = await mod.GET(req("/api/customer/ledger", null));
    expect(res.status).toBe(401);
  });

  it("returns only this customer's ledger entries", async () => {
    const cA = await db.getOrCreateCustomer({ googleSub: "ldg-1" });
    const cB = await db.getOrCreateCustomer({ googleSub: "ldg-2" });
    await db.creditCustomer(cA.id, 1_000_000, { refType: "topup", refId: "t1" });
    await db.adjustBalance(cA.id, -250_000, { reason: "usage" });
    await db.creditCustomer(cB.id, 5_000_000, { refType: "topup", refId: "t2" });
    const tokenA = await sessionFor(cA);

    const mod = await import("@/app/api/customer/ledger/route.js");
    const res = await mod.GET(req("/api/customer/ledger", tokenA));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBe(2);
    expect(body.items.every((e) => e.customerId === cA.id)).toBe(true);
    expect(body.balance.balanceMicros).toBe(750_000);
  });
});
