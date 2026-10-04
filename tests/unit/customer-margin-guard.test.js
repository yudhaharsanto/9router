// Phase 7: margin guard (spec §3.10) + settle margin meta + admin settings.
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-margin-"));
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

async function seedPricing(model, { input = 3, output = 15 } = {}) {
  const { updatePricing } = await import("@/lib/db/repos/pricingRepo.js");
  await updatePricing({ claude: { [model]: { input, output, cached: input / 10, cache_creation: input * 1.25, reasoning: output } } });
}

async function makeCustomer(micros) {
  const customers = await import("@/lib/db/repos/customersRepo.js");
  const keys = await import("@/lib/db/repos/customerKeysRepo.js");
  const ledger = await import("@/lib/db/repos/ledgerRepo.js");
  const c = await customers.getOrCreateCustomer({
    googleSub: `mg-${Math.random().toString(36).slice(2)}`,
    email: `mg-${Math.random().toString(36).slice(2)}@x.test`,
    name: "Margin Test",
  });
  const { key } = await keys.createCustomerKey(c.id);
  if (micros > 0) await ledger.creditCustomer(c.id, micros, { refType: "test", refId: `t-${c.id}` });
  return { customer: c, key };
}

describe("margin guard", () => {
  it("marginUnsafe: true when official cost >= sell estimate × (1 − minMarginPct)", async () => {
    await seedPricing("margin-model", { input: 3, output: 15 });
    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
    await updateSettings({ minMarginPct: 0.5 }); // sell = 50% of official
    const { marginUnsafe, checkMarginForRequest } = await import("@/lib/billing/marginGuard.js");

    // sell output 7.5/M; official 15/M. max_tokens 1M → official 15$, sell 7.5$
    // unsafe if official >= sell × (1 − 0.5) = 3.75$ → true
    const tokens = { max_tokens: 1_000_000 };
    const verdict = await checkMarginForRequest("claude", "margin-model", tokens);
    expect(verdict.unsafe).toBe(true);
    expect(verdict.expectedChargeMicros).toBe(7_500_000);
    expect(verdict.estimatedUpstreamMicros).toBe(15_000_000);
    expect(marginUnsafe(verdict, 0.5)).toBe(true);
  });

  it("checkMarginForRequest: official pricing is unsafe; $0 cost override is safe", async () => {
    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
    // sell 75% of official, minMargin 0.5: official 15$ > 11.25$ × 0.5 → unsafe (kill-switch semantics)
    await updateSettings({ minMarginPct: 0.5, discountRate: 0.25 });
    vi.resetModules();
    let { checkMarginForRequest } = await import("@/lib/billing/marginGuard.js");
    let verdict = await checkMarginForRequest("claude", "margin-model", { max_tokens: 1_000_000 });
    expect(verdict.unsafe).toBe(true);

    // The router's own account costs ~$0 → safe.
    await updateSettings({ modelCostOverrides: { "claude/margin-model": { input: 0, output: 0 } } });
    vi.resetModules();
    ({ checkMarginForRequest } = await import("@/lib/billing/marginGuard.js"));
    verdict = await checkMarginForRequest("claude", "margin-model", { max_tokens: 1_000_000 });
    expect(verdict.unsafe).toBe(false);
  });

  it("marginBehavior=block → 503 at chat entry; skip → warn and proceed", async () => {
    // skip (default): no exception thrown, proceed
    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
    await updateSettings({ minMarginPct: 0.99, discountRate: 0.5, marginBehavior: "skip", modelCostOverrides: {} });
    vi.resetModules();
    const { evaluateMarginPolicy } = await import("@/lib/billing/marginGuard.js");
    const v = await evaluateMarginPolicy("claude", "margin-model", { max_tokens: 1_000_000 });
    expect(v.blocked).toBe(false);

    await updateSettings({ marginBehavior: "block" });
    vi.resetModules();
    const { evaluateMarginPolicy: evaluateAgain } = await import("@/lib/billing/marginGuard.js");
    const blocked = await evaluateAgain("claude", "margin-model", { max_tokens: 1_000_000 });
    expect(blocked.blocked).toBe(true);
  });

  it("settleCustomerUsage records margin meta: charge, officialCost, margin", async () => {
    await seedPricing("settle-model", { input: 3, output: 15 });
    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
    await updateSettings({ discountRate: 0.5 });
    vi.resetModules();
    const gate = await import("@/lib/billing/customerGate.js");
    const ledger = await import("@/lib/db/repos/ledgerRepo.js");
    const { customer, key } = await makeCustomer(20_000_000);
    const keys = await import("@/lib/db/repos/customerKeysRepo.js");
    const auth = await gate.authorizeCustomerRequest(key);
    const hold = await gate.holdForRequest(auth.customerId, { model: "settle-model", max_tokens: 10_000 });

    const result = await gate.settleCustomerUsage(
      auth.customerId, hold.holdRefId, "claude", "settle-model",
      { prompt_tokens: 1000, completion_tokens: 100 },
    );
    // charge = 1000×1.5/1M + 100×7.5/1M = 1500 + 750 = 2250 µ$
    expect(result.chargeMicros).toBe(2250);
    // official = 1000×3/1M + 100×15/1M = 3000 + 1500 = 4500 µ$
    expect(result.officialCostMicros).toBe(4500);
    expect(result.marginMicros).toBe(2250 - 4500);

    const rows = await ledger.getLedger(customer.id, { limit: 10 });
    const debit = rows.find((r) => r.type === "usage_debit");
    expect(debit).toBeTruthy();
    const meta = typeof debit.meta === "string" ? JSON.parse(debit.meta) : debit.meta;
    expect(meta.chargeMicros).toBe(2250);
    expect(meta.officialCostMicros).toBe(4500);
    expect(meta.marginMicros).toBe(-2250);
  });

  it("minimumChargeMicros: charge floored to minimum", async () => {
    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
    await updateSettings({ minimumChargeMicros: 10_000 }); // $0.01
    vi.resetModules();
    const gate = await import("@/lib/billing/customerGate.js");
    const { customer, key } = await makeCustomer(5_000_000);
    const auth = await gate.authorizeCustomerRequest(key);
    const hold = await gate.holdForRequest(auth.customerId, { model: "settle-model", max_tokens: 100 });
    const result = await gate.settleCustomerUsage(
      auth.customerId, hold.holdRefId, "claude", "settle-model",
      { prompt_tokens: 10, completion_tokens: 1 },
    );
    expect(result.chargeMicros).toBe(10_000);
  });
});
