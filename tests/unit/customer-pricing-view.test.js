// GET /api/customer/pricing — session-gated view of what the signed-in
// customer pays per public model: direct admin price verbatim, or per-member
// official × (1 − discount) when the public model has no direct price.
// Cache price is expressed as a % of input.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let customerToken;
let customerKey;

beforeAll(async () => {
  delete process.env.BASE_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cust-price-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();

  const customers = await import("@/lib/db/repos/customersRepo.js");
  const combos = await import("@/lib/db/repos/combosRepo.js");
  const pub = await import("@/lib/db/repos/publicModelsRepo.js");
  const pricing = await import("@/lib/db/repos/pricingRepo.js");
  const settings = await import("@/lib/db/repos/settingsRepo.js");

  // official catalog: input 4, output 20, cached 10% of input
  await pricing.updatePricing({ openai: { "auto-price-model": { input: 4, output: 20, cached: 0.4, reasoning: 20 } } });
  await settings.updateSettings({ discountRate: 0.5 });

  const comboA = await combos.createCombo({ name: "combo-auto", models: ["openai/auto-price-model"] });
  await pub.upsertPublicModel({ publicName: "pub-auto", comboId: comboA.id, enabled: true });

  const comboB = await combos.createCombo({ name: "combo-direct", models: ["openai/auto-price-model"] });
  await pub.upsertPublicModel({ publicName: "pub-direct", comboId: comboB.id, enabled: true });
  await pricing.updatePublicPricing({ "pub-direct": { input: 1, output: 3, cachedPct: 15 } });

  const c = await customers.getOrCreateCustomer({ googleSub: "cp-1", email: "cp@x.test", name: "CP" });
  const { createCustomerAuthToken } = await import("@/lib/auth/customerSession.js");
  customerToken = await createCustomerAuthToken({ customerId: c.id });
  expect(customerToken).toBeTruthy();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function req() {
  return new Request("http://localhost:20128/api/customer/pricing", {
    headers: customerToken ? { cookie: `crx_session=${customerToken}` } : {},
  });
}

describe("GET /api/customer/pricing", () => {
  it("401 without a customer session", async () => {
    const mod = await import("@/app/api/customer/pricing/route.js");
    const res = await mod.GET(new Request("http://localhost:20128/api/customer/pricing"));
    expect([401, 403]).toContain(res.status);
  });

  it("per-model discountRate overrides the global rate; null rows keep global", async () => {
    const pub = await import("@/lib/db/repos/publicModelsRepo.js");
    await pub.upsertPublicModel({ publicName: "pub-direct", comboId: (await pub.getPublicModelByName("pub-direct")).comboId, enabled: true, discountRate: 0.2 });
    await pub.upsertPublicModel({ publicName: "pub-auto", comboId: (await pub.getPublicModelByName("pub-auto")).comboId, enabled: true, discountRate: null });
    const mod = await import("@/app/api/customer/pricing/route.js");
    const res = await mod.GET(req());
    const body = await res.json();
    // override 0.2 → sell = official × 0.8; pub-auto falls back to global 0.5
    const direct = body.items.find((m) => m.name === "pub-direct");
    expect(direct.discountRate).toBeCloseTo(0.2, 6);
    expect(direct.sell.input).toBeCloseTo(0.8, 6);
    expect(direct.sell.output).toBeCloseTo(2.4, 6);
    const auto = body.items.find((m) => m.name === "pub-auto");
    expect(auto.discountRate).toBeCloseTo(0.5, 6);
    expect(auto.sell.input).toBeCloseTo(2, 6);
    // Restore the global-rate state the other test expects.
    await pub.upsertPublicModel({ publicName: "pub-direct", comboId: (await pub.getPublicModelByName("pub-direct")).comboId, enabled: true, discountRate: null });
  });

  it("returns per-model customer prices: auto-discounted rows + direct rows with cache %", async () => {
    const mod = await import("@/app/api/customer/pricing/route.js");
    const res = await mod.GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);

    const auto = body.items.find((m) => m.name === "pub-auto");
    expect(auto).toBeTruthy();
    // official 4/20 → customer 2/10; cache % from official ratio 0.4/4 = 10%
    expect(auto.sell.input).toBeCloseTo(2, 6);
    expect(auto.sell.output).toBeCloseTo(10, 6);
    expect(auto.sell.cachedPct).toBeCloseTo(10, 6);
    expect(auto.official.input).toBeCloseTo(4, 6);
    expect(auto.official.output).toBeCloseTo(20, 6);
    // no internal leakage
    expect(JSON.stringify(auto)).not.toContain("combo-auto");

    const direct = body.items.find((m) => m.name === "pub-direct");
    expect(direct).toBeTruthy();
    // admin-entered price is OFFICIAL; customer pays official × (1 − 0.5)
    expect(direct.official.input).toBe(1);
    expect(direct.official.output).toBe(3);
    expect(direct.sell.input).toBeCloseTo(0.5, 6);
    expect(direct.sell.output).toBeCloseTo(1.5, 6);
    expect(direct.sell.cachedPct).toBeCloseTo(15, 6);
    expect(JSON.stringify(direct)).not.toContain("combo-direct");
  });
});
