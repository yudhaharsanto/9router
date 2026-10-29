// ShopeePay top-up flow (replaces the Tako webhook + reconcile pair).
// - syncPendingTopups(): polls POST /check-payment for pending topups and
//   credits via claimTopupTransaction + applyTopupCredit.
// - POST /api/customer/topup: session-gated, blocks without a valid rate,
//   mints a dynamic QRIS and stores its URL.
// - GET /api/customer/topups: own history only; ?sync=1 polls first.
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-shoppepay-"));
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

async function configureGateway({ apiKey = "test-gateway-key" } = {}) {
  const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
  await updateSettings({ shoppepayBaseUrl: "https://gw.test", shoppepayApiKey: apiKey });
}

async function clearGateway() {
  const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
  await updateSettings({ shoppepayApiKey: "" });
}

describe("syncPendingTopups", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("no-ops when no gateway key is configured", async () => {
    await clearGateway();
    const { syncPendingTopups } = await import("@/lib/billing/shoppepayReconcile.js");
    const result = await syncPendingTopups();
    expect(result.checked).toBe(0);
    expect(result.reason).toBe("not-configured");
  });

  it("polls the gateway and credits a paid topup", async () => {
    await configureGateway();
    const c = await db.getOrCreateCustomer({ googleSub: "sp-recon-1" });
    const topup = await db.createTopup({ customerId: c.id, amountIdr: 200_000, rateMilli: 16_000_000 });
    await db.setTopupPaymentUrl(topup.id, "https://gw.test/qr/abc");

    const fetchMock = vi.fn(async (url, opts) => {
      expect(String(url)).toBe("https://gw.test/check-payment");
      expect(opts.headers["X-API-Key"]).toBe("test-gateway-key");
      const sent = JSON.parse(opts.body);
      expect(sent.amount).toBe(200_000);
      expect(sent.startTime).toBe(Math.floor(Date.parse(topup.createdAt) / 1000));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          paid: true,
          transaction: { transactionId: "sp-tx-1", amount: 200_000, status: "success" },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { syncPendingTopups } = await import("@/lib/billing/shoppepayReconcile.js");
    const result = await syncPendingTopups({ customerId: c.id });
    expect(result.checked).toBe(1);
    expect(result.credited).toBe(1);

    const updated = await db.getTopupByProviderTxnId("sp-tx-1");
    expect(updated.status).toBe("paid");
    expect((await db.getBalance(c.id)).balanceMicros).toBe(topup.creditedMicros);
  });

  it("leaves the topup pending while the gateway reports no payment", async () => {
    await configureGateway();
    const c = await db.getOrCreateCustomer({ googleSub: "sp-recon-2" });
    const topup = await db.createTopup({ customerId: c.id, amountIdr: 50_000, rateMilli: 16_000_000 });
    await db.setTopupPaymentUrl(topup.id, "https://gw.test/qr/unpaid");

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, paid: false }),
    })));

    const { syncPendingTopups } = await import("@/lib/billing/shoppepayReconcile.js");
    const result = await syncPendingTopups({ customerId: c.id });
    expect(result.checked).toBe(1);
    expect(result.credited).toBe(0);
    expect((await db.getTopupById(topup.id)).status).toBe("pending");
  });

  it("credits exactly once when the poll runs twice", async () => {
    await configureGateway();
    const c = await db.getOrCreateCustomer({ googleSub: "sp-recon-3" });
    const topup = await db.createTopup({ customerId: c.id, amountIdr: 75_000, rateMilli: 16_000_000 });
    await db.setTopupPaymentUrl(topup.id, "https://gw.test/qr/once");

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, paid: true, transaction: { transactionId: "sp-tx-3" } }),
    })));

    const { syncPendingTopups } = await import("@/lib/billing/shoppepayReconcile.js");
    await syncPendingTopups({ customerId: c.id });
    await syncPendingTopups({ customerId: c.id });

    const ledger = await db.getLedger(c.id, { limit: 100 });
    expect(ledger.filter((e) => e.refType === "topup" && e.refId === topup.id).length).toBe(1);
  });

  it("never credits two topups from one payment (same amount, one transaction)", async () => {
    await configureGateway();
    const cA = await db.getOrCreateCustomer({ googleSub: "sp-dup-a" });
    const cB = await db.getOrCreateCustomer({ googleSub: "sp-dup-b" });
    const tA = await db.createTopup({ customerId: cA.id, amountIdr: 60_000, rateMilli: 16_000_000 });
    const tB = await db.createTopup({ customerId: cB.id, amountIdr: 60_000, rateMilli: 16_000_000 });
    await db.setTopupPaymentUrl(tA.id, "https://gw.test/qr/dup-a");
    await db.setTopupPaymentUrl(tB.id, "https://gw.test/qr/dup-b");

    // Only the Rp60,000 check is paid — other pending rows from earlier tests
    // must not claim this transaction.
    vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
      const { amount } = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => (amount === 60_000
          ? { success: true, paid: true, transaction: { transactionId: "sp-tx-dup" } }
          : { success: true, paid: false }),
      };
    }));

    const { syncPendingTopups } = await import("@/lib/billing/shoppepayReconcile.js");
    const result = await syncPendingTopups();
    expect(result.credited).toBe(1);
    const statuses = [
      (await db.getTopupById(tA.id)).status,
      (await db.getTopupById(tB.id)).status,
    ].sort();
    expect(statuses).toEqual(["paid", "pending"]);
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
    const c = await db.getOrCreateCustomer({ googleSub: "sp-norate" });
    const token = await sessionFor(c);
    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
    await updateSettings({ idrPerUsd: "" });
    const mod = await import("@/app/api/customer/topup/route.js");
    const res = await mod.POST(req("/api/customer/topup", token, {
      method: "POST",
      body: JSON.stringify({ amountIdr: 100_000 }),
    }));
    expect(res.status).toBe(403);
  });

  it("manual mode: without a gateway key the topup is still created (pending), with a message", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "sp-manual" });
    const token = await sessionFor(c);
    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
    await updateSettings({ idrPerUsd: "16000", shoppepayApiKey: "" });

    const mod = await import("@/app/api/customer/topup/route.js");
    const res = await mod.POST(req("/api/customer/topup", token, {
      method: "POST",
      body: JSON.stringify({ amountIdr: 150_000 }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.manual).toBe(true);
    expect(body.topup.status).toBe("pending");
    expect(body.topup.amountIdr).toBe(150_000);
    expect(body.topup.rateMilli).toBe(16_000_000);
    expect(body.topup.providerTxnId).toBeNull();
  });

  it("400 when amountIdr is below the minimum", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "sp-low" });
    const token = await sessionFor(c);
    const mod = await import("@/app/api/customer/topup/route.js");
    const res = await mod.POST(req("/api/customer/topup", token, {
      method: "POST",
      body: JSON.stringify({ amountIdr: 500 }),
    }));
    expect(res.status).toBe(400);
  });

  it("creates a pending topup and returns the QRIS url", async () => {
    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
    await updateSettings({ idrPerUsd: "16000", shoppepayBaseUrl: "https://gw.test", shoppepayApiKey: "k" });

    const c = await db.getOrCreateCustomer({ googleSub: "sp-ok" });
    const token = await sessionFor(c);

    vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
      expect(String(url)).toBe("https://gw.test/create-qris");
      expect(JSON.parse(opts.body)).toEqual({ amount: 100_000 });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { qris_url: "https://gw.test/qr/new", amount: 100_000, expires_at: "2026-07-15 09:29:25" },
        }),
      };
    }));

    const mod = await import("@/app/api/customer/topup/route.js");
    const res = await mod.POST(req("/api/customer/topup", token, {
      method: "POST",
      body: JSON.stringify({ amountIdr: 100_000 }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.topup.paymentUrl).toBe("https://gw.test/qr/new");
    expect(body.topup.status).toBe("pending");
    expect(body.topup.rateMilli).toBe(16_000_000);
    const stored = await db.getTopupById(body.topup.id);
    expect(stored.paymentUrl).toBe("https://gw.test/qr/new");
  });

  it("propagates a gateway failure as 502", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "sp-fail" });
    const token = await sessionFor(c);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: false, error: "Invalid or missing API key" }),
    })));
    const mod = await import("@/app/api/customer/topup/route.js");
    const res = await mod.POST(req("/api/customer/topup", token, {
      method: "POST",
      body: JSON.stringify({ amountIdr: 100_000 }),
    }));
    expect(res.status).toBe(502);
  });
});

describe("GET /api/customer/topups", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("401 without a session", async () => {
    const mod = await import("@/app/api/customer/topups/route.js");
    const res = await mod.GET(req("/api/customer/topups", null));
    expect(res.status).toBe(401);
  });

  it("lists only this customer's topups", async () => {
    const cA = await db.getOrCreateCustomer({ googleSub: "sp-list-a" });
    const cB = await db.getOrCreateCustomer({ googleSub: "sp-list-b" });
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

  it("?sync=1 settles a pending topup before answering", async () => {
    await configureGateway();
    const c = await db.getOrCreateCustomer({ googleSub: "sp-list-sync" });
    const topup = await db.createTopup({ customerId: c.id, amountIdr: 30_000, rateMilli: 16_000_000 });
    await db.setTopupPaymentUrl(topup.id, "https://gw.test/qr/sync");

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, paid: true, transaction: { transactionId: "sp-tx-sync" } }),
    })));

    const token = await sessionFor(c);
    const mod = await import("@/app/api/customer/topups/route.js");
    const res = await mod.GET(req("/api/customer/topups?sync=1", token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.find((t) => t.id === topup.id).status).toBe("paid");
  });
});
