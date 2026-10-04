// Pricing versions + public models — discount derivation, active lookup, charge math.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cust-pricing-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const USD_PER_M = (n) => Math.round(n * 1_000_000); // $/1M tokens → µ$

describe("pricingVersionsRepo", () => {
  it("upsert derives sell price = official × 0.5 at 5000 bps", async () => {
    const v = await db.upsertPricingVersion({
      modelId: "glm-5.3-flash",
      officialInputMicros: USD_PER_M(0.3),
      officialOutputMicros: USD_PER_M(1.5),
      effectiveFrom: "2026-10-01T00:00:00Z",
      source: "manual",
    });
    expect(v.discountBps).toBe(5000);
    expect(v.sellInputMicros).toBe(USD_PER_M(0.15));
    expect(v.sellOutputMicros).toBe(USD_PER_M(0.75));
  });

  it("same (modelId, effectiveFrom) upsert updates instead of duplicating", async () => {
    await db.upsertPricingVersion({
      modelId: "m-x", officialInputMicros: 1000, officialOutputMicros: 2000,
      effectiveFrom: "2026-10-01T00:00:00Z",
    });
    await db.upsertPricingVersion({
      modelId: "m-x", officialInputMicros: 1100, officialOutputMicros: 2200,
      effectiveFrom: "2026-10-01T00:00:00Z",
    });
    const versions = await db.listPricingVersions("m-x");
    expect(versions.length).toBe(1);
    expect(versions[0].officialInputMicros).toBe(1100);
  });

  it("getActivePricing returns latest effectiveFrom ≤ now", async () => {
    await db.upsertPricingVersion({
      modelId: "m-y", officialInputMicros: 100, officialOutputMicros: 200,
      effectiveFrom: "2026-09-01T00:00:00Z",
    });
    await db.upsertPricingVersion({
      modelId: "m-y", officialInputMicros: 300, officialOutputMicros: 600,
      effectiveFrom: "2026-10-01T00:00:00Z",
    });
    const active = await db.getActivePricing("m-y");
    expect(active.officialInputMicros).toBe(300);
    const past = await db.getActivePricing("m-y", { at: "2026-09-15T00:00:00Z" });
    expect(past.officialInputMicros).toBe(100);
    expect(await db.getActivePricing("m-z")).toBeNull();
  });
});

describe("computeChargeMicros", () => {
  it("charges input+output tokens off sell prices", async () => {
    const pricing = {
      sellInputMicros: USD_PER_M(0.15),   // $0.15 / 1M
      sellOutputMicros: USD_PER_M(0.75),  // $0.75 / 1M
    };
    // 100k in + 10k out → 0.1 × 0.15 + 0.01 × 0.75 = $0.0225
    expect(db.computeChargeMicros({ pricing, inputTokens: 100_000, outputTokens: 10_000 })).toBe(22_500);
  });

  it("zero tokens charge zero", () => {
    expect(db.computeChargeMicros({ pricing: { sellInputMicros: 100, sellOutputMicros: 100 }, inputTokens: 0, outputTokens: 0 })).toBe(0);
  });
});

describe("publicModelsRepo", () => {
  it("upsert + get by name + list enabled", async () => {
    const m = await db.upsertPublicModel({ publicName: "glm-5.3-flash", comboId: "combo-1" });
    expect(m.enabled).toBe(true);
    expect((await db.getPublicModelByName("glm-5.3-flash")).comboId).toBe("combo-1");
    await db.upsertPublicModel({ publicName: "secret-model", comboId: "combo-2", enabled: false });
    const all = await db.listPublicModels({ enabledOnly: true });
    expect(all.map((x) => x.publicName)).toEqual(["glm-5.3-flash"]);
    const everything = await db.listPublicModels({ enabledOnly: false });
    expect(everything.length).toBe(2);
  });

  it("upsert same publicName updates comboId instead of erroring", async () => {
    await db.upsertPublicModel({ publicName: "glm-5.3-flash", comboId: "combo-9" });
    expect((await db.getPublicModelByName("glm-5.3-flash")).comboId).toBe("combo-9");
  });

  it("getPublicModelByName unknown → null; delete removes", async () => {
    expect(await db.getPublicModelByName("ghost")).toBeNull();
    const m = await db.upsertPublicModel({ publicName: "to-delete", comboId: "c" });
    await db.deletePublicModel(m.id);
    expect(await db.getPublicModelByName("to-delete")).toBeNull();
  });
});
