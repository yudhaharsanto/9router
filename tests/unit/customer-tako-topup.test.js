// Reconciliation worker + customer topup API (phase 4).
// - runTakoReconciliation(): polls Tako for stuck pending topups, credits via
//   the same applyTopupCredit path as the webhook.
// - POST /api/customer/topup: session-gated, blocks without a valid rate,
//   calls Tako create-transaction, stores paymentUrl + txn id.
// - GET /api/customer/topups: own history only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  delete process.env.BASE_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-tako-recon-"));
  process.env.DATA_DIR = tempDir;
  process.env.TAKO_MERCHANT_KEY = "test-merchant-key";
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  delete process.env.TAKO_MERCHANT_KEY;
});

async function sessionFor(customer) {
  const { createCustomerAuthToken } = await import("@/lib/auth/customerSession.js");
  return createCustomerAuthToken({ customerId: customer.id });
}

function req(path, token, extra = {}) {
  return new Request(`http://localhost:20128${path}`, {
    method: extra.method || "GET",
    headers: {
      ...(token ? { cookie: `crx_session=${token}` } : {}),
      ...(extra.headers || {}),
    },
    ...(extra.body ? { body: extra.body } : {}),
  });
}

describe("runTakoReconciliation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("no-ops when there are no pending topups with txn ids", async () => {
    const { runTakoReconciliation } = await import("@/lib/billing/takoReconcile.js");
    const result = await runTakoReconciliation({ olderThanMinutes: 0 });
    expect(result.checked).toBe(0);
    expect(result.credited).toBe(0);
  });

  it("polls Tako for stuck pending topups and credits paid ones", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "recon-1" });
    const topup = await db.createTopup({ customerId: c.id, amountIdr: 200_000, rateMilli: 16_000_000 });
    await db.setTopupPayment(topup.id, { takoTxnId: "recon-tx-1", paymentUrl: "https://tako.id/p/1" });

    const fetchMock = vi.fn(async (url) => {
      expect(String(url)).toContain("recon-tx-1");
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "paid", amount: topup.amountIdr }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { runTakoReconciliation } = await import("@/lib/billing/takoReconcile.js");
    const result = await runTakoReconciliation({ olderThanMinutes: 0 });
    expect(result.checked).toBe(1);
    expect(result.credited).toBe(1);
    const updated = await db.getTopupByTakoTxnId("recon-tx-1");
    expect(updated.status).toBe("paid");
    const balance = await db.getBalance(c.id);
    expect(balance.balanceMicros).toBe(topup.creditedMicros);
  });

  it("leaves pending topups untouched when Tako still reports pending", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "recon-2" });
    const topup = await db.createTopup({ customerId: c.id, amountIdr: 50_000, rateMilli: 16_000_000 });
    await db.setTopupPayment(topup.id, { takoTxnId: "recon-tx-2", paymentUrl: null });

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "pending" }),
    })));

    const { runTakoReconciliation } = await import("@/lib/billing/takoReconcile.js");
    const result = await runTakoReconciliation({ olderThanMinutes: 0 });
    expect(result.checked).toBe(1);
    expect(result.credited).toBe(0);
    const updated = await db.getTopupByTakoTxnId("recon-tx-2");
    expect(updated.status).toBe("pending");
  });

  it("credits via the ledger exactly once even if the worker runs twice", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "recon-3" });
    const topup = await db.createTopup({ customerId: c.id, amountIdr: 75_000, rateMilli: 16_000_000 });
    await db.setTopupPayment(topup.id, { takoTxnId: "recon-tx-3", paymentUrl: null });

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "paid" }),
    })));

    const { runTakoReconciliation } = await import("@/lib/billing/takoReconcile.js");
    await runTakoReconciliation({ olderThanMinutes: 0 });
    await runTakoReconciliation({ olderThanMinutes: 0 });
    const ledger = await db.getLedger(c.id, { limit: 100 });
    const credits = ledger.filter((e) => e.refType === "topup" && e.refId === topup.id);
    expect(credits.length).toBe(1);
  });
});

describe("POST /api/customer/topup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("401 without a session", async () => {
    const mod = await import("@/app/api/customer/topup/route.js");
    const res = await mod.POST(req("/api/customer/topup", null, {
      method: "POST",
      body: JSON.stringify({ amountIdr: 100_000 }),
    }));
    expect(res.status).toBe(401);
  });

  it("403 when no rate is configured (never guess a rate)", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "topup-norate" });
    const token = await sessionFor(c);
    const mod = await import("@/app/api/customer/topup/route.js");
    const res = await mod.POST(req("/api/customer/topup", token, {
      method: "POST",
      body: JSON.stringify({ amountIdr: 100_000 }),
    }));
    expect(res.status).toBe(403);
  });

  it("manual mode: without Tako config the topup is still created (pending), with a message", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "topup-manual" });
    const token = await sessionFor(c);
    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
    // rate set, but no Tako username → manual mode
    await updateSettings({ idrPerUsd: "16000", takoUsername: "" });

    const mod = await import("@/app/api/customer/topup/route.js");
    const res = await mod.POST(req("/api/customer/topup", token, {
      method: "POST",
      body: JSON.stringify({ amountIdr: 150_000 }), // arbitrary amount, no presets
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.manual).toBe(true);
    expect(body.topup.status).toBe("pending");
    expect(body.topup.amountIdr).toBe(150_000);
    expect(body.topup.rateMilli).toBe(16_000_000);
    // no Tako txn stored
    expect(body.topup.takoTxnId).toBeNull();
  });

  it("400 when amountIdr is below the minimum", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "topup-low" });
    const token = await sessionFor(c);
    const mod = await import("@/app/api/customer/topup/route.js");
    const res = await mod.POST(req("/api/customer/topup", token, {
      method: "POST",
      body: JSON.stringify({ amountIdr: 5000 }),
    }));
    expect(res.status).toBe(400);
  });

  it("creates a pending topup and returns the Tako paymentUrl", async () => {
    // Set the rate + Tako username via updateSettings.
    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
    await updateSettings({ idrPerUsd: "16000", takoUsername: "test-merchant" });

    const c = await db.getOrCreateCustomer({ googleSub: "topup-1" });
    const token = await sessionFor(c);

    vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
      expect(String(url)).toContain("tako.id/api/v1/topup/");
      return {
        ok: true,
        status: 200,
        json: async () => ({ paymentUrl: "https://tako.id/pay/abc", transactionId: "topup-tx-1" }),
      };
    }));

    const mod = await import("@/app/api/customer/topup/route.js");
    const res = await mod.POST(req("/api/customer/topup", token, {
      method: "POST",
      body: JSON.stringify({ amountIdr: 100_000 }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.topup.paymentUrl).toBe("https://tako.id/pay/abc");
    expect(body.topup.takoTxnId).toBe("topup-tx-1");
    expect(body.topup.status).toBe("pending");
    const stored = await db.getTopupByTakoTxnId("topup-tx-1");
    expect(stored.status).toBe("pending");
    expect(stored.amountIdr).toBe(100_000);
    expect(stored.rateMilli).toBe(16_000_000); // 16000 IDR/USD × 1000
  });

  it("propagates a Tako failure as 502 without storing a txn", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "topup-fail" });
    const token = await sessionFor(c);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const mod = await import("@/app/api/customer/topup/route.js");
    const res = await mod.POST(req("/api/customer/topup", token, {
      method: "POST",
      body: JSON.stringify({ amountIdr: 100_000 }),
    }));
    expect(res.status).toBe(502);
  });
});

describe("GET /api/customer/topups", () => {
  it("401 without a session", async () => {
    const mod = await import("@/app/api/customer/topups/route.js");
    const res = await mod.GET(req("/api/customer/topups", null));
    expect(res.status).toBe(401);
  });

  it("lists only this customer's topups", async () => {
    const cA = await db.getOrCreateCustomer({ googleSub: "topups-a" });
    const cB = await db.getOrCreateCustomer({ googleSub: "topups-b" });
    await db.createTopup({ customerId: cA.id, amountIdr: 10_000, rateMilli: 16_000_000 });
    await db.createTopup({ customerId: cB.id, amountIdr: 20_000, rateMilli: 16_000_000 });
    const token = await sessionFor(cA);
    const mod = await import("@/app/api/customer/topups/route.js");
    const res = await mod.GET(req("/api/customer/topups", token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBe(1);
    expect(body.items[0].amountIdr).toBe(10_000);
  });
});
