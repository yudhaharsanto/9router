// Phase 6 + follow-ups: public model ↔ combo mapping, response masking, and
// direct pricing per public model. The admin-entered price is the OFFICIAL
// (pre-discount) price — the customer pays official × (1 − discountRate), same
// as member models. cachedPct is carried through unscaled; the derived cached
// rate is then that % of the discounted input.
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-pub-price-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  const settings = await import("@/lib/db/repos/settingsRepo.js");
  await settings.updateSettings({ discountRate: 0.5 });
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("public model pricing", () => {
  it("pricingRepo: updatePublicPricing / getPublicPricing round-trip", async () => {
    const repo = await import("@/lib/db/repos/pricingRepo.js");
    await repo.updatePublicPricing({
      "glm-5.3-flash": { input: 2, output: 8, cached: 0.2, cache_creation: 2, reasoning: 8 },
    });
    const all = await repo.getPublicPricing();
    expect(all["glm-5.3-flash"].output).toBe(8);
    // upsert merge: adding a second name keeps the first
    await repo.updatePublicPricing({
      "glm-pro": { input: 1, output: 4, cached: 0.1, cache_creation: 1, reasoning: 4 },
    });
    const all2 = await repo.getPublicPricing();
    expect(all2["glm-5.3-flash"].output).toBe(8);
    expect(all2["glm-pro"].output).toBe(4);
  });

  it("getPublicSellPricing discounts the official entry price by discountRate", async () => {
    const repo = await import("@/lib/db/repos/pricingRepo.js");
    const cp = await import("@/lib/billing/customerPricing.js");
    await repo.updatePublicPricing({ "glm-5.3-flash": { input: 2, output: 8, cached: 0.2 } });
    const sell = await cp.getPublicSellPricing("glm-5.3-flash");
    expect(sell).toBeTruthy();
    // official 2/8 entered by admin, discount 0.5 → customer pays 1/4
    expect(sell.input).toBeCloseTo(1, 9);
    expect(sell.output).toBeCloseTo(4, 9);
    expect(sell.official).toEqual({ input: 2, output: 8, cachedPct: null });
    expect(await cp.getPublicSellPricing("no-such-public")).toBeNull();
  });

  it("settleCustomerUsage bills public models at official × (1 − discount)", async () => {
    const repo = await import("@/lib/db/repos/pricingRepo.js");
    const customers = await import("@/lib/db/repos/customersRepo.js");
    const ledger = await import("@/lib/db/repos/ledgerRepo.js");
    const gate = await import("@/lib/billing/customerGate.js");

    // Admin enters official 2/8; discount 0.5 → customer billed 1/4.
    await repo.updatePublicPricing({ "glm-flash-x": { input: 2, output: 8 } });

    const c = await customers.getOrCreateCustomer({ googleSub: "pp-1", email: "pp@x.test", name: "PP" });
    await ledger.creditCustomer(c.id, 100_000_000, { refType: "test", refId: "pp-t1" });
    const hold = await gate.holdForRequest(c.id, { model: "glm-flash-x", max_tokens: 1000 });
    expect(hold.ok).toBe(true);

    // 10k output × $4/1M (discounted) = $40 = 40_000 micros
    const result = await gate.settleCustomerUsage(
      c.id, hold.holdRefId, "openai", "gpt-x",
      { completion_tokens: 10_000 },
      "glm-flash-x", // publicName
    );
    expect(result.chargeMicros).toBe(40_000);

    // Same tokens WITHOUT a public name fall back to member pricing.
    const hold2 = await gate.holdForRequest(c.id, { model: "gpt-x", max_tokens: 1000 });
    const result2 = await gate.settleCustomerUsage(
      c.id, hold2.holdRefId, "openai", "gpt-x", { completion_tokens: 10_000 },
    );
    // member "gpt-x" unpriced → charge 0
    expect(result2.chargeMicros).toBe(0);
  });

  it("cachedPct (% of official input) applies to the discounted input rate; legacy absolute cached is discounted too", async () => {
    const repo = await import("@/lib/db/repos/pricingRepo.js");
    const cp = await import("@/lib/billing/customerPricing.js");

    // official input 2, cachedPct 10 → sell input 1, cached = 10% of 1 = 0.1
    await repo.updatePublicPricing({ "pct-model": { input: 2, output: 8, cachedPct: 10 } });
    const sell = await cp.getPublicSellPricing("pct-model");
    expect(sell.input).toBeCloseTo(1, 9);
    expect(sell.cached).toBeCloseTo(0.1, 9);
    expect(sell.official.cachedPct).toBe(10);

    // legacy absolute cached (official 0.5) discounted like everything else
    await repo.updatePublicPricing({ "abs-model": { input: 2, output: 8, cached: 0.5 } });
    const sell2 = await cp.getPublicSellPricing("abs-model");
    expect(sell2.cached).toBeCloseTo(0.25, 9);
  });
});
