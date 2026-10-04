// Customer balance gate (spec §3.8): sk-cust- keys authorize, reserve on
// balance, settle actual usage. Gate module is tested directly; chat.js wiring
// is a thin pass-through of {customerBilling}.
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cust-gate-"));
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

async function makeCustomerWithBalance(micros) {
  const customers = await import("@/lib/db/repos/customersRepo.js");
  const keys = await import("@/lib/db/repos/customerKeysRepo.js");
  const ledger = await import("@/lib/db/repos/ledgerRepo.js");
  const c = await customers.getOrCreateCustomer({
    googleSub: `gate-${Math.random().toString(36).slice(2)}`,
    email: `gate-${Math.random().toString(36).slice(2)}@x.test`,
    name: "Gate Test",
  });
  const { key } = await keys.createCustomerKey(c.id);
  if (micros > 0) await ledger.creditCustomer(c.id, micros, { refType: "test", refId: `t-${c.id}` });
  return { customer: c, key };
}

describe("customerGate", () => {
  it("isCustomerKey: true only for sk-cust- prefix", async () => {
    const { isCustomerKey } = await import("@/lib/billing/customerGate.js");
    expect(isCustomerKey("sk-cust-abc")).toBe(true);
    expect(isCustomerKey("sk-other")).toBe(false);
    expect(isCustomerKey(null)).toBe(false);
  });

  it("authorizeCustomerRequest: valid key → customer; invalid → null", async () => {
    const { authorizeCustomerRequest } = await import("@/lib/billing/customerGate.js");
    const { key, customer } = await makeCustomerWithBalance(1_000_000);
    const auth = await authorizeCustomerRequest(key);
    expect(auth).toBeTruthy();
    expect(auth.customerId).toBe(customer.id);
    expect(auth.keyId).toBeTruthy();
    expect(await authorizeCustomerRequest("sk-cust-deadbeef")).toBeNull();
    expect(await authorizeCustomerKey(null)).toBeNull();
    async function authorizeCustomerKey(k) {
      return authorizeCustomerRequest(k);
    }
  });

  it("holdForRequest: reserves and 402s when balance too low", async () => {
    const { holdForRequest, authorizeCustomerRequest } = await import("@/lib/billing/customerGate.js");
    const { key, customer } = await makeCustomerWithBalance(50_000); // $0.05 — covers fallback-rate reserve for max_tokens:100
    const auth = await authorizeCustomerRequest(key);
    const { getBalance } = await import("@/lib/db/repos/ledgerRepo.js");

    // Estimate for a small max_tokens must hold a small reserve and succeed.
    const hold = await holdForRequest(auth.customerId, { max_tokens: 100 });
    expect(hold.ok).toBe(true);
    expect(hold.holdRefId).toBeTruthy();
    const bal = await getBalance(customer.id);
    expect(bal.reservedMicros).toBeGreaterThan(0);

    // A huge max_tokens against a tiny balance → refuse.
    const refused = await holdForRequest(auth.customerId, { max_tokens: 10_000_000 });
    expect(refused.ok).toBe(false);
  });

  it("settleCustomerUsage: debits actual sell-priced cost, releases hold", async () => {
    const { holdForRequest, settleCustomerUsage, authorizeCustomerRequest } = await import("@/lib/billing/customerGate.js");
    const { getBalance, getLedger } = await import("@/lib/db/repos/ledgerRepo.js");
    // Seed deterministic pricing (admin override kv): official 3/15 USD per 1M,
    // discount 0.5 → sell 1.5/7.5.
    const { updatePricing } = await import("@/lib/db/repos/pricingRepo.js");
    await updatePricing({ claude: { "gate-test-model": { input: 3, output: 15, cached: 0.3, cache_creation: 3.75, reasoning: 15 } } });
    const { key, customer } = await makeCustomerWithBalance(10_000_000); // $10
    const auth = await authorizeCustomerRequest(key);
    const hold = await holdForRequest(auth.customerId, { model: "gate-test-model", max_tokens: 1000 });

    // 1M input + 100 output tokens at sell pricing → 1.5$ + 0.00075$ = 1_500_750 µ$
    const result = await settleCustomerUsage(
      auth.customerId, hold.holdRefId, "claude", "gate-test-model",
      { prompt_tokens: 1_000_000, completion_tokens: 100 },
    );
    expect(result.balanceMicros).toBe(10_000_000 - 1_500_750);
    const bal = await getBalance(customer.id);
    expect(bal.reservedMicros).toBe(0);
    const ledger = await getLedger(customer.id, { limit: 20 });
    expect(ledger.some((r) => r.type === "usage_debit" && r.amountMicros === -1_500_750)).toBe(true);
  });

  it("settleCustomerUsage with unknown pricing charges 0 and still releases", async () => {
    const { holdForRequest, settleCustomerUsage, authorizeCustomerRequest } = await import("@/lib/billing/customerGate.js");
    const { getBalance } = await import("@/lib/db/repos/ledgerRepo.js");
    const { key, customer } = await makeCustomerWithBalance(5_000_000);
    const auth = await authorizeCustomerRequest(key);
    const hold = await holdForRequest(auth.customerId, { max_tokens: 100 });
    const result = await settleCustomerUsage(
      auth.customerId, hold.holdRefId, "no-such-provider", "no-such-model",
      { prompt_tokens: 500, completion_tokens: 50 },
    );
    expect(result.balanceMicros).toBe(5_000_000);
    expect((await getBalance(customer.id)).reservedMicros).toBe(0);
  });
});
