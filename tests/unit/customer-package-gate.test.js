// Package routing in customerGate: hold skips balance reserve when an active
// package covers the model; settle consumes package tokens instead of balance.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let packages;
let gate;

beforeAll(async () => {
  delete process.env.BASE_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-pkg-gate-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  packages = await import("@/lib/db/repos/packagesRepo.js");
  gate = await import("@/lib/billing/customerGate.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function makeCustomer() {
  const c = await db.getOrCreateCustomer({ googleSub: `pkg-gate-${Math.random().toString(36).slice(2)}` });
  return c;
}

describe("customerGate — package routing", () => {
  it("holdForRequest skips balance reserve when an active package covers the model", async () => {
    const c = await makeCustomer();
    const pkg = await packages.createPackage({ name: "cover", tokens: 1_000_000, models: ["pkg-model"] });
    await packages.assignPackage(c.id, pkg.id);
    // zero balance — hold would fail without a package
    const hold = await gate.holdForRequest(c.id, { model: "pkg-model", max_tokens: 1000 });
    expect(hold.ok).toBe(true);
    expect(hold.packageBilling).toBe(true);
  });

  it("holdForRequest still requires balance when model is outside package scope", async () => {
    const c = await makeCustomer();
    const pkg = await packages.createPackage({ name: "cover2", tokens: 1_000_000, models: ["pkg-model"] });
    await packages.assignPackage(c.id, pkg.id);
    const hold = await gate.holdForRequest(c.id, { model: "other-model", max_tokens: 1000 });
    expect(hold.ok).toBe(false);
  });

  it("settleCustomerUsage consumes package tokens, leaves balance untouched", async () => {
    const c = await makeCustomer();
    const ledger = await import("@/lib/db/repos/ledgerRepo.js");
    await ledger.creditCustomer(c.id, 1_000_000, { refType: "test", refId: `seed-${c.id}` });
    const pkg = await packages.createPackage({ name: "settle", tokens: 10_000_000, models: ["*"] });
    const inst = await packages.assignPackage(c.id, pkg.id);

    const hold = await gate.holdForRequest(c.id, { model: "any", max_tokens: 100 });
    expect(hold.packageBilling).toBe(true);

    const tokens = { prompt_tokens: 300, completion_tokens: 200 };
    const result = await gate.settleCustomerUsage(c.id, hold.holdRefId, "openai", "any", tokens);
    // balance untouched
    const bal = await ledger.getBalance(c.id);
    expect(bal.balanceMicros).toBe(1_000_000);
    // package consumed 500
    const rows = await packages.getCustomerPackages(c.id);
    const updated = rows.find((x) => x.id === inst.id);
    expect(updated.tokensUsed).toBe(500);
    // settle returns package info
    expect(result.packageChargedTokens).toBe(500);
    expect(result.chargeMicros).toBe(0);
  });

  it("settleCustomerUsage outside package scope debits balance as before", async () => {
    const c = await makeCustomer();
    const ledger = await import("@/lib/db/repos/ledgerRepo.js");
    await ledger.creditCustomer(c.id, 1_000_000, { refType: "test", refId: `seed2-${c.id}` });
    const { updatePricing } = await import("@/lib/db/repos/pricingRepo.js");
    await updatePricing({ openai: { "not-in-scope": { input: 3, output: 15, cached: 0.3, cache_creation: 3.75, reasoning: 15 } } });
    const pkg = await packages.createPackage({ name: "narrow", tokens: 10_000_000, models: ["only-this"] });
    await packages.assignPackage(c.id, pkg.id);

    const hold = await gate.holdForRequest(c.id, { model: "not-in-scope", max_tokens: 100 });
    expect(hold.packageBilling).toBeUndefined();

    const tokens = { prompt_tokens: 100, completion_tokens: 100 };
    await gate.settleCustomerUsage(c.id, hold.holdRefId, "openai", "not-in-scope", tokens);
    const bal = await ledger.getBalance(c.id);
    expect(bal.balanceMicros).toBeLessThan(1_000_000);
  });

  it("partial package remainder spills to balance", async () => {
    const c = await makeCustomer();
    const ledger = await import("@/lib/db/repos/ledgerRepo.js");
    await ledger.creditCustomer(c.id, 1_000_000, { refType: "test", refId: `seed3-${c.id}` });
    const { updatePricing } = await import("@/lib/db/repos/pricingRepo.js");
    await updatePricing({ openai: { any: { input: 3, output: 15, cached: 0.3, cache_creation: 3.75, reasoning: 15 } } });
    const pkg = await packages.createPackage({ name: "tiny", tokens: 100, models: ["*"] });
    await packages.assignPackage(c.id, pkg.id);

    const hold = await gate.holdForRequest(c.id, { model: "any", max_tokens: 10 });
    const tokens = { prompt_tokens: 60, completion_tokens: 60 };
    const result = await gate.settleCustomerUsage(c.id, hold.holdRefId, "openai", "any", tokens);
    // 120 used, package covered 100, remaining 20 tokens billed via balance
    expect(result.packageChargedTokens).toBe(100);
    expect(result.chargeMicros).toBeGreaterThan(0);
    const bal = await ledger.getBalance(c.id);
    expect(bal.balanceMicros).toBeLessThan(1_000_000);
  });
});

describe("topup-paid package activation", () => {
  it("applyTopupCredit activates the pending package instance tied to the topup", async () => {
    const c = await makeCustomer();
    const pkg = await packages.createPackage({ name: "buyable-gate", tokens: 5_000_000, priceIdr: 20_000, models: ["m1"] });
    const topup = await db.createTopup({ customerId: c.id, amountIdr: 20_000, rateMilli: 16_000_000 });
    await db.setTopupPayment(topup.id, { takoTxnId: "pkg-txn-1", paymentUrl: "https://tako.id/pay/x" });
    await db.createPendingFromTopup({ customerId: c.id, packageId: pkg.id, topupId: topup.id });
    const before = (await db.getBalance(c.id)).balanceMicros;

    const { applyTopupCredit } = await import("@/lib/db/repos/topupsRepo.js");
    const res = await applyTopupCredit("pkg-txn-1");
    expect(res.credited).toBe(true);

    // balance credited (topup still credits µ$) AND package activated
    expect((await db.getBalance(c.id)).balanceMicros).toBe(before + topup.creditedMicros);
    const rows = await packages.getCustomerPackages(c.id);
    const inst = rows.find((x) => x.topupId === topup.id);
    expect(inst.status).toBe("active");
    expect(inst.tokensGranted).toBe(5_000_000);
    expect(inst.activatedAt).toBeTruthy();

    // replay does not double-activate
    await applyTopupCredit("pkg-txn-1");
    const rows2 = await packages.getCustomerPackages(c.id);
    expect(rows2.filter((x) => x.packageId === pkg.id).length).toBe(1);
  });
});

describe("settleCustomerUsageSafe — package-billed requests (no hold)", () => {
  it("consumes package tokens even when holdRefId is null", async () => {
    const c = await makeCustomer();
    const pkg = await packages.createPackage({ name: "nohold", tokens: 500_000, models: ["pkg-nohold"] });
    await packages.assignPackage(c.id, pkg.id);
    // Simulate what holdForRequest returns for package billing: no hold.
    const billing = { customerId: c.id, holdRefId: null, packageBilling: true, packageId: pkg.id, publicName: "pkg-nohold" };
    await gate.settleCustomerUsageSafe(billing, "openai", "upstream-name", { prompt_tokens: 300, completion_tokens: 200 });
    const insts = await packages.getCustomerPackages(c.id);
    expect(insts[0].tokensUsed).toBe(500);
  });
});

describe("chat.js packageBilling flag propagation", () => {
  it("settle consumes quota when packageBilling flag is set (chat.js flow)", async () => {
    const c = await makeCustomer();
    const combosRepo = await import("@/lib/db/repos/combosRepo.js");
    const pub = await import("@/lib/db/repos/publicModelsRepo.js");
    const combo = await combosRepo.createCombo({ name: "flag-combo", models: ["oc/muse-free"] });
    await pub.upsertPublicModel({ publicName: "muse-public-name", comboId: combo.id });
    const pkg = await packages.createPackage({ name: "flagflow", tokens: 100_000, models: ["opus"], comboId: combo.id });
    await packages.assignPackage(c.id, pkg.id);
    // Replicate chat.js: hold → copy holdRefId + packageBilling onto billing obj.
    const auth = { customerId: c.id, keyId: "k" };
    const hold = await gate.holdForRequest(auth.customerId, { model: "muse-public-name", max_tokens: 1000 }, "muse-public-name");
    expect(hold.packageBilling).toBe(true);
    const billing = { ...auth, holdRefId: hold.holdRefId };
    if (hold.packageBilling) billing.packageBilling = true;
    billing.publicName = "muse-public-name";
    await gate.settleCustomerUsageSafe(billing, "openchat", "muse-upstream", { prompt_tokens: 1000, completion_tokens: 500 });
    const insts = await packages.getCustomerPackages(c.id);
    expect(insts[0].tokensUsed).toBe(1500);
  });
});
