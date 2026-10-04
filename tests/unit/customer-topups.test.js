// Topups + webhook events — rate lock at creation, replay-safe credit.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cust-topups-"));
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

// Rp100,000 at 17,000.00 IDR/USD → rateMilli 17000000 → $5.882353 (rounded µ$)
const RATE_MILLI = 17_000_000;

describe("topupsRepo", () => {
  it("createTopup locks the rate and pre-computes creditedMicros", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "top-1" });
    const t = await db.createTopup({ customerId: c.id, amountIdr: 100_000, rateMilli: RATE_MILLI });
    expect(t.status).toBe("pending");
    expect(t.creditedMicros).toBe(Math.round((100_000 * 1_000_000_000) / RATE_MILLI)); // 5_882_353 µ$ ≈ $5.882353
  });

  it("setTopupPayment links takoTxnId + paymentUrl", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "top-2" });
    const t = await db.createTopup({ customerId: c.id, amountIdr: 50_000, rateMilli: RATE_MILLI });
    await db.setTopupPayment(t.id, { takoTxnId: "tako-txn-2", paymentUrl: "https://tako.id/pay/x" });
    const got = await db.getTopupByTakoTxnId("tako-txn-2");
    expect(got.id).toBe(t.id);
    expect(got.paymentUrl).toBe("https://tako.id/pay/x");
  });

  it("listTopups returns newest first", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "top-3" });
    const a = await db.createTopup({ customerId: c.id, amountIdr: 10_000, rateMilli: RATE_MILLI });
    const b = await db.createTopup({ customerId: c.id, amountIdr: 20_000, rateMilli: RATE_MILLI });
    const list = await db.listTopups(c.id);
    expect(list[0].id).toBe(b.id);
    expect(list[1].id).toBe(a.id);
  });
});

describe("webhookEventsRepo", () => {
  it("recordWebhookEvent inserts once; duplicate returns created:false", async () => {
    const first = await db.recordWebhookEvent({
      source: "tako", externalId: "evt-1", payload: { event: "payment.success" },
    });
    expect(first.created).toBe(true);
    const replay = await db.recordWebhookEvent({
      source: "tako", externalId: "evt-1", payload: { event: "payment.success" },
    });
    expect(replay.created).toBe(false);
    expect(replay.event.id).toBe(first.event.id);
  });

  it("markWebhookProcessed records success / failure", async () => {
    const { event } = await db.recordWebhookEvent({ source: "tako", externalId: "evt-2", payload: {} });
    await db.markWebhookProcessed(event.id, { error: "boom" });
    const { getAdapter } = await import("@/lib/db/driver.js");
    const dba = await getAdapter();
    const row = dba.get(`SELECT * FROM webhookEvents WHERE id = ?`, [event.id]);
    expect(row.status).toBe("failed");
    expect(row.processError).toBe("boom");
    const { event: e3 } = await db.recordWebhookEvent({ source: "tako", externalId: "evt-3", payload: {} });
    await db.markWebhookProcessed(e3.id);
    const row3 = dba.get(`SELECT * FROM webhookEvents WHERE id = ?`, [e3.id]);
    expect(row3.status).toBe("processed");
  });

  it("getUnprocessedWebhookEvents returns oldest-first unprocessed only", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const dba = await getAdapter();
    dba.run(`DELETE FROM webhookEvents`);
    const a = await db.recordWebhookEvent({ source: "tako", externalId: "u-1", payload: {} });
    const b = await db.recordWebhookEvent({ source: "tako", externalId: "u-2", payload: {} });
    await db.recordWebhookEvent({ source: "tako", externalId: "u-3", payload: {} });
    await db.markWebhookProcessed((await db.recordWebhookEvent({ source: "tako", externalId: "u-4", payload: {} })).event.id);
    const rows = await db.getUnprocessedWebhookEvents("tako");
    expect(rows.map((r) => r.externalId)).toEqual(["u-1", "u-2", "u-3"]);
  });
});

describe("applyTopupCredit — the webhook handler's single entry", () => {
  it("credits balance, marks paid, writes ledger row — once", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "top-4" });
    const t = await db.createTopup({ customerId: c.id, amountIdr: 100_000, rateMilli: RATE_MILLI });
    await db.setTopupPayment(t.id, { takoTxnId: "tako-txn-4", paymentUrl: "u" });
    const r1 = await db.applyTopupCredit("tako-txn-4");
    expect(r1.credited).toBe(true);
    const bal = await db.getBalance(c.id);
    expect(bal.balanceMicros).toBe(t.creditedMicros);
    const again = await db.applyTopupCredit("tako-txn-4");
    expect(again.credited).toBe(false);
    expect(again.reason).toBe("already-processed");
    const bal2 = await db.getBalance(c.id);
    expect(bal2.balanceMicros).toBe(t.creditedMicros);
    const ledger = await db.getLedger(c.id, { type: "topup_credit" });
    expect(ledger.length).toBe(1);
  });

  it("unknown txn → credited:false, reason not-found", async () => {
    const r = await db.applyTopupCredit("no-such-txn");
    expect(r).toEqual({ credited: false, reason: "not-found" });
  });

  it("paid topup re-delivered → no double credit", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "top-5" });
    const t = await db.createTopup({ customerId: c.id, amountIdr: 10_000, rateMilli: RATE_MILLI });
    await db.setTopupPayment(t.id, { takoTxnId: "tako-txn-5", paymentUrl: "u" });
    await db.applyTopupCredit("tako-txn-5");
    // Simulate concurrent webhook replay racing the first apply:
    const r = await db.applyTopupCredit("tako-txn-5");
    expect(r.credited).toBe(false);
    expect((await db.getBalance(c.id)).balanceMicros).toBe(t.creditedMicros);
  });
});
