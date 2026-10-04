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

  it("skips usage rows with NULL apiKey instead of crashing (500)", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "usg-null" });
    const key = (await db.createCustomerKey(c.id)).key;
    const token = await sessionFor(c);
    await db.saveRequestUsage({ provider: "p", model: "m", tokens: { prompt_tokens: 1, completion_tokens: 1 }, apiKey: key });
    await db.saveRequestUsage({ provider: "p", model: "m", tokens: { prompt_tokens: 1, completion_tokens: 1 }, apiKey: null });

    const mod = await import("@/app/api/customer/usage/route.js");
    const res = await mod.GET(req("/api/customer/usage", token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBe(1);
  });

  it("totals expose official vs charged (ledger usage_debit) with saved = max(0, official − charged)", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "usg-totals" });
    const key = (await db.createCustomerKey(c.id)).key;
    const token = await sessionFor(c);
    // Price the model so the usage row gets a nonzero official cost.
    const { updatePricing } = await import("@/lib/db/repos/pricingRepo.js");
    await updatePricing({ p: { m: { input: 1, output: 2 } } }); // $1/$2 per 1M
    await db.saveRequestUsage({ provider: "p", model: "m", tokens: { prompt_tokens: 10, completion_tokens: 10 }, apiKey: key }); // official cost > 0

    // Charge less than official → saved = official − charged.
    const ledger = await import("@/lib/db/repos/ledgerRepo.js");
    await ledger.creditCustomer(c.id, 1_000_000, { refType: "test", refId: "seed-t1" });
    const hold = await ledger.holdReserve(c.id, 1_000_000, "req-t1");
    expect(hold.ok).toBe(true);
    // 10 in + 10 out at $1/$2 per 1M → official 30 µ$; charge 10 µ$ < official.
    await ledger.settleUsage(c.id, "req-t1", 10, {});

    const mod = await import("@/app/api/customer/usage/route.js");
    const body = await (await mod.GET(req("/api/customer/usage", token))).json();
    expect(body.totals.chargedMicros).toBe(10);
    expect(body.totals.officialMicros).toBe(30);
    expect(body.totals.savedMicros).toBe(20);
  });

  it("maps upstream model names to public names and drops unpublished rows", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "usg-pub" });
    const key = (await db.createCustomerKey(c.id)).key;
    const token = await sessionFor(c);
    const { upsertPublicModel } = await import("@/lib/db/repos/publicModelsRepo.js");
    const { createCombo } = await import("@/lib/db/repos/combosRepo.js");
    const combo = await createCombo({ name: "glm-combo", kind: "fallback", models: ["ih/combo/glm-flash"] });
    await upsertPublicModel({ publicName: "glm-5.3-flash", comboId: combo.id, enabled: true });

    // Published member → rewritten to the public name.
    await db.saveRequestUsage({ provider: "inferhub", model: "combo/glm-flash", tokens: { prompt_tokens: 5, completion_tokens: 5 }, apiKey: key });
    // Not a member of any published combo → must not appear.
    await db.saveRequestUsage({ provider: "antigravity", model: "gemini-3.6-flash-low", tokens: { prompt_tokens: 9, completion_tokens: 9 }, apiKey: key });

    const mod = await import("@/app/api/customer/usage/route.js");
    const body = await (await mod.GET(req("/api/customer/usage", token))).json();
    expect(body.items.length).toBe(1);
    expect(body.items[0].model).toBe("glm-5.3-flash");
    expect(JSON.stringify(body.items)).not.toContain("combo/glm-flash");
    expect(JSON.stringify(body.items)).not.toContain("gemini-3.6-flash-low");
  });

  it("saved floors at 0 when charged exceeds official estimate", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "usg-over" });
    await db.createCustomerKey(c.id);
    const token = await sessionFor(c);
    const ledger = await import("@/lib/db/repos/ledgerRepo.js");
    await ledger.creditCustomer(c.id, 1_000_000, { refType: "test", refId: "seed-t2" });
    const hold = await ledger.holdReserve(c.id, 1_000_000, "req-t2");
    expect(hold.ok).toBe(true);
    await ledger.settleUsage(c.id, "req-t2", 700, {});

    const mod = await import("@/app/api/customer/usage/route.js");
    const body = await (await mod.GET(req("/api/customer/usage", token))).json();
    expect(body.totals.officialMicros).toBe(0);
    expect(body.totals.savedMicros).toBe(0);
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
