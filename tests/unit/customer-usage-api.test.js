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
    await db.saveRequestUsage({ provider: "p", model: "m", tokens: { prompt_tokens: 10, completion_tokens: 10 }, apiKey: key, meta: { holdRefId: "req-t1" } }); // official cost > 0

    // Charge less than official → saved = official − charged.
    const ledger = await import("@/lib/db/repos/ledgerRepo.js");
    await ledger.creditCustomer(c.id, 1_000_000, { refType: "test", refId: "seed-t1" });
    const hold = await ledger.holdReserve(c.id, 1_000_000, "req-t1");
    expect(hold.ok).toBe(true);
    // 10 in + 10 out at $1/$2 per 1M → official 30 µ$; charge 10 µ$ < official.
    // officialCostMicros mirrors customerGate.settleCustomerUsage (totals read it from the debit's meta).
    await ledger.settleUsage(c.id, "req-t1", 10, { officialCostMicros: 30 });

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
    expect(body.items[0].chargedMicros).toBe(null); // no linked ledger debit
    expect(JSON.stringify(body.items)).not.toContain("combo/glm-flash");
    expect(JSON.stringify(body.items)).not.toContain("gemini-3.6-flash-low");
  });

  it("links per-request chargedMicros from the ledger debit via holdRefId", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "usg-link" });
    const key = (await db.createCustomerKey(c.id)).key;
    const token = await sessionFor(c);
    const { upsertPublicModel } = await import("@/lib/db/repos/publicModelsRepo.js");
    const { createCombo } = await import("@/lib/db/repos/combosRepo.js");
    const combo = await createCombo({ name: "glm-combo2", kind: "fallback", models: ["ih/combo/glm-flash"] });
    await upsertPublicModel({ publicName: "glm-5.3-flash", comboId: combo.id, enabled: true });
    const { updatePricing } = await import("@/lib/db/repos/pricingRepo.js");
    await updatePricing({ p: { m: { input: 1, output: 2 } } });

    // saveRequestUsage with holdRefId in meta (what saveUsageStats now records
    // for customer traffic), then settle creating the usage_debit for it.
    await db.saveRequestUsage({ provider: "inferhub", model: "combo/glm-flash", tokens: { prompt_tokens: 10, completion_tokens: 10 }, apiKey: key, meta: { holdRefId: "req-link1" } });
    const ledger = await import("@/lib/db/repos/ledgerRepo.js");
    await ledger.creditCustomer(c.id, 1_000_000, { refType: "test", refId: "seed-l1" });
    await ledger.holdReserve(c.id, 100_000, "req-link1");
    await ledger.settleUsage(c.id, "req-link1", 10, {});

    const mod = await import("@/app/api/customer/usage/route.js");
    const body = await (await mod.GET(req("/api/customer/usage", token))).json();
    expect(body.items.length).toBe(1);
    expect(body.items[0].chargedMicros).toBe(10);
  });

  it("billing filter splits balance rows (holdRefId) from the rest", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "usg-billing" });
    const key = (await db.createCustomerKey(c.id)).key;
    const token = await sessionFor(c);
    // Earlier tests in this file publish public models, so this one must too
    // (publishedAnything is file-global). Balance row: holdRefId meta.
    const { upsertPublicModel } = await import("@/lib/db/repos/publicModelsRepo.js");
    const { createCombo } = await import("@/lib/db/repos/combosRepo.js");
    const combo = await createCombo({ name: `bal-combo-${Date.now()}`, kind: "fallback", models: ["m-bal"] });
    await upsertPublicModel({ publicName: "m-bal", comboId: combo.id, enabled: true });
    await db.saveRequestUsage({ provider: "p", model: "m-bal", tokens: { prompt_tokens: 1, completion_tokens: 1 }, apiKey: key, meta: { holdRefId: "req-bal" } });
    await db.saveRequestUsage({ provider: "p", model: "m-plain", tokens: { prompt_tokens: 1, completion_tokens: 1 }, apiKey: key });

    const mod = await import("@/app/api/customer/usage/route.js");
    const bal = await (await mod.GET(req("/api/customer/usage?billing=balance", token))).json();
    expect(bal.items.map((i) => i.model)).toEqual(["m-bal"]);
    // all: only the published row passes the publish filter (m-plain dropped)
    const all = await (await mod.GET(req("/api/customer/usage?billing=all", token))).json();
    expect(all.items.length).toBe(1);
  });

  it("totals use the ledger's officialCostMicros (admin official price) when present", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "usg-official" });
    const key = (await db.createCustomerKey(c.id)).key;
    const token = await sessionFor(c);
    const { updatePricing } = await import("@/lib/db/repos/pricingRepo.js");
    await updatePricing({ p: { m: { input: 1, output: 2 } } }); // catalog cost 30 µ$
    // Earlier tests enabled public models, so this row must be published to
    // pass the portal's publish filter.
    const { upsertPublicModel } = await import("@/lib/db/repos/publicModelsRepo.js");
    const { createCombo } = await import("@/lib/db/repos/combosRepo.js");
    const combo = await createCombo({ name: `off-combo-${Date.now()}`, kind: "fallback", models: ["m"] });
    await upsertPublicModel({ publicName: "m-pub", comboId: combo.id, enabled: true });
    await db.saveRequestUsage({ provider: "p", model: "m", tokens: { prompt_tokens: 10, completion_tokens: 10 }, apiKey: key, meta: { holdRefId: "req-off" } });
    const ledger = await import("@/lib/db/repos/ledgerRepo.js");
    await ledger.creditCustomer(c.id, 1_000_000, { refType: "test", refId: "seed-t3" });
    await ledger.holdReserve(c.id, 100_000, "req-off");
    // Charged 10 µ$; ledger records the admin official price 50 µ$ (≠ catalog).
    await ledger.settleUsage(c.id, "req-off", 10, { officialCostMicros: 50 });

    const mod = await import("@/app/api/customer/usage/route.js");
    const body = await (await mod.GET(req("/api/customer/usage", token))).json();
    expect(body.totals.officialMicros).toBe(50);
    expect(body.totals.chargedMicros).toBe(10);
    expect(body.totals.savedMicros).toBe(40);
    expect(body.items[0].officialMicros).toBe(50);
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

  it("returns only the previous calendar day for the yesterday period", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "usg-yesterday" });
    const key = (await db.createCustomerKey(c.id)).key;
    const token = await sessionFor(c);
    const { upsertPublicModel } = await import("@/lib/db/repos/publicModelsRepo.js");
    const { createCombo } = await import("@/lib/db/repos/combosRepo.js");
    const combo = await createCombo({ name: `yesterday-combo-${Date.now()}`, kind: "fallback", models: ["yesterday-member"] });
    await upsertPublicModel({ publicName: "yesterday-public", comboId: combo.id, enabled: true });

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const yesterday = new Date(todayStart);
    yesterday.setDate(yesterday.getDate() - 1);
    await db.saveRequestUsage({
      provider: "p",
      model: "yesterday-member",
      timestamp: new Date(yesterday.getTime() + 12 * 3600000).toISOString(),
      tokens: { prompt_tokens: 1, completion_tokens: 1 },
      apiKey: key,
    });
    await db.saveRequestUsage({
      provider: "p",
      model: "yesterday-member",
      timestamp: new Date(todayStart.getTime() + 12 * 3600000).toISOString(),
      tokens: { prompt_tokens: 2, completion_tokens: 2 },
      apiKey: key,
    });

    const mod = await import("@/app/api/customer/usage/route.js");
    const body = await (await mod.GET(req("/api/customer/usage?period=yesterday", token))).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].promptTokens).toBe(1);
    expect(body.totals.totalRequests).toBe(1);
  });

  it("includes a debit settled after midnight for the previous-day request", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "usg-yesterday-settle" });
    const key = (await db.createCustomerKey(c.id)).key;
    const token = await sessionFor(c);
    const holdRefId = "yesterday-cross-midnight";
    const { upsertPublicModel } = await import("@/lib/db/repos/publicModelsRepo.js");
    const { createCombo } = await import("@/lib/db/repos/combosRepo.js");
    const combo = await createCombo({ name: `yesterday-settle-combo-${Date.now()}`, kind: "fallback", models: ["yesterday-settle-member"] });
    await upsertPublicModel({ publicName: "yesterday-settle-public", comboId: combo.id, enabled: true });

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const yesterdayNoon = new Date(todayStart);
    yesterdayNoon.setDate(yesterdayNoon.getDate() - 1);
    yesterdayNoon.setHours(12, 0, 0, 0);
    await db.saveRequestUsage({
      provider: "p",
      model: "yesterday-settle-member",
      timestamp: yesterdayNoon.toISOString(),
      tokens: { prompt_tokens: 1, completion_tokens: 1 },
      apiKey: key,
      meta: { holdRefId },
    });
    const ledger = await import("@/lib/db/repos/ledgerRepo.js");
    await ledger.creditCustomer(c.id, 1_000_000, { refType: "test", refId: "seed-cross-midnight" });
    await ledger.holdReserve(c.id, 100_000, holdRefId);
    await ledger.settleUsage(c.id, holdRefId, 10, { officialCostMicros: 20 });
    const { getAdapter } = await import("@/lib/db/driver.js");
    (await getAdapter()).run(
      "UPDATE ledger SET createdAt = ? WHERE customerId = ? AND refId = ? AND type = 'usage_debit'",
      [new Date(todayStart.getTime() + 3600000).toISOString(), c.id, holdRefId],
    );

    const mod = await import("@/app/api/customer/usage/route.js");
    const body = await (await mod.GET(req("/api/customer/usage?period=yesterday", token))).json();
    expect(body.items[0].chargedMicros).toBe(10);
    expect(body.totals.chargedMicros).toBe(10);

    const today = await (await mod.GET(req("/api/customer/usage?period=today", token))).json();
    expect(today.totals.chargedMicros).toBe(0);
  });

  it("limits rows to the latest 10 while totals cover the full period", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "usg-cap" });
    const key = (await db.createCustomerKey(c.id)).key;
    const token = await sessionFor(c);
    const { upsertPublicModel } = await import("@/lib/db/repos/publicModelsRepo.js");
    const { createCombo } = await import("@/lib/db/repos/combosRepo.js");
    const combo = await createCombo({ name: `cap-combo-${Date.now()}`, kind: "fallback", models: ["usage-cap-member"] });
    await upsertPublicModel({ publicName: "usage-cap-public", comboId: combo.id, enabled: true });

    for (let i = 0; i < 12; i++) {
      await db.saveRequestUsage({
        provider: "p",
        model: "usage-cap-member",
        timestamp: new Date(Date.now() - i * 1000).toISOString(),
        tokens: { prompt_tokens: i + 1, completion_tokens: i + 2, cached_tokens: i + 3 },
        apiKey: key,
      });
    }

    const mod = await import("@/app/api/customer/usage/route.js");
    const body = await (await mod.GET(req("/api/customer/usage?period=all", token))).json();
    expect(body.items).toHaveLength(10);
    expect(body.items[0].model).toBe("usage-cap-public");
    expect(body.totals.totalRequests).toBe(12);
    expect(body.totals.totalPromptTokens).toBe(78);
    expect(body.totals.totalCompletionTokens).toBe(90);
    expect(body.totals.totalCachedTokens).toBe(102);
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
