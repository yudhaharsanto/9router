// Customer sell pricing: official × (1 − discountRate), integer micros.
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cust-pricing-"));
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

describe("customerPricing", () => {
  it("defaults discountRate to 0.5 and halves official prices", async () => {
    const { getSellPricing } = await import("@/lib/billing/customerPricing.js");
    // claude sonnet official: input 3.00, output 15.00 USD per 1M
    const sell = await getSellPricing("claude", "claude-sonnet-4-5");
    expect(sell).toBeTruthy();
    expect(sell.input).toBeCloseTo(1.5, 6);
    expect(sell.output).toBeCloseTo(7.5, 6);
  });

  it("honors an admin-configured discountRate", async () => {
    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
    await updateSettings({ discountRate: "0.25" });
    // bust the 5s pricing cache via module reset
    vi.resetModules();
    const { getSellPricing } = await import("@/lib/billing/customerPricing.js");
    const sell = await getSellPricing("claude", "claude-sonnet-4-5");
    expect(sell.input).toBeCloseTo(2.25, 6);
    expect(sell.output).toBeCloseTo(11.25, 6);
  });

  it("estimateCostMicros returns integer micros from tokens", async () => {
    const { estimateCostMicros } = await import("@/lib/billing/customerPricing.js");
    // 1M input tokens at sell 1.5/M = $1.50 = 1_500_000 µ$
    const micros = estimateCostMicros(
      { prompt_tokens: 1_000_000, completion_tokens: 0 },
      { input: 1.5, output: 7.5, cached: 0.15, cache_creation: 1.875 },
    );
    expect(micros).toBe(1_500_000);
    expect(Number.isInteger(micros)).toBe(true);
  });

  it("estimateCostMicros charges cached tokens at cached rate", () => {
    // estimateCostMicros is sync-pure; import directly
    return import("@/lib/billing/customerPricing.js").then(({ estimateCostMicros }) => {
      const micros = estimateCostMicros(
        { prompt_tokens: 1000, cached_tokens: 400, completion_tokens: 100 },
        { input: 1.5, output: 7.5, cached: 0.15 },
      );
      // non-cached input 600 × 1.5/1M = 0.0009$ = 900µ$; cached 400 × 0.15/1M = 60µ$;
      // output 100 × 7.5/1M = 750µ$ → 1710µ$
      expect(micros).toBe(1710);
    });
  });
});
