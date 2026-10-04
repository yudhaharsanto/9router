// Ledger — credits (idempotent), atomic holds, settle with overdraft, adjustments.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cust-ledger-"));
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

const USD = (n) => Math.round(n * 1_000_000);

describe("ledgerRepo — credits", () => {
  it("creditCustomer adds to balance and appends a ledger row", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "led-1" });
    const r1 = await db.creditCustomer(c.id, USD(5), { refType: "topup", refId: "t-1" });
    expect(r1.balanceMicros).toBe(USD(5));
    expect(r1.idempotent).toBe(false);
    const rows = await db.getLedger(c.id);
    expect(rows[0].type).toBe("topup_credit");
    expect(rows[0].amountMicros).toBe(USD(5));
    expect(rows[0].balanceAfterMicros).toBe(USD(5));
  });

  it("same refType+refId+type credit is idempotent — no double credit", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "led-2" });
    await db.creditCustomer(c.id, USD(3), { refType: "topup", refId: "t-2" });
    const again = await db.creditCustomer(c.id, USD(3), { refType: "topup", refId: "t-2" });
    expect(again.idempotent).toBe(true);
    expect(again.balanceMicros).toBe(USD(3));
  });
});

describe("ledgerRepo — holds and settle", () => {
  it("hold succeeds when available ≥ amount and raises reserved", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "led-3" });
    await db.creditCustomer(c.id, USD(10), { refType: "topup", refId: "t-3" });
    const hold = await db.holdReserve(c.id, USD(2), "req-3a");
    expect(hold.ok).toBe(true);
    const bal = await db.getBalance(c.id);
    expect(bal.reservedMicros).toBe(USD(2));
    expect(bal.availableMicros).toBe(USD(8));
  });

  it("hold fails — and mutates nothing — when available < amount", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "led-4" });
    await db.creditCustomer(c.id, USD(1), { refType: "topup", refId: "t-4" });
    const hold = await db.holdReserve(c.id, USD(2), "req-4a");
    expect(hold.ok).toBe(false);
    const bal = await db.getBalance(c.id);
    expect(bal.reservedMicros).toBe(0);
    expect(bal.balanceMicros).toBe(USD(1));
  });

  it("settleUsage debits actual usage and releases the hold", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "led-5" });
    await db.creditCustomer(c.id, USD(10), { refType: "topup", refId: "t-5" });
    await db.holdReserve(c.id, USD(4), "req-5a");
    const r = await db.settleUsage(c.id, "req-5a", USD(1.5), { model: "glm-5.3-flash" });
    expect(r.balanceMicros).toBe(USD(8.5));
    const bal = await db.getBalance(c.id);
    expect(bal.reservedMicros).toBe(0);
    expect(bal.availableMicros).toBe(USD(8.5));
    const rows = await db.getLedger(c.id);
    const types = rows.map((x) => x.type);
    expect(types).toContain("usage_debit");
    expect(types).toContain("reserve_release");
  });

  it("settleUsage with zero usage (upstream failed) just releases", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "led-6" });
    await db.creditCustomer(c.id, USD(5), { refType: "topup", refId: "t-6" });
    await db.holdReserve(c.id, USD(3), "req-6a");
    const r = await db.settleUsage(c.id, "req-6a", 0);
    expect(r.balanceMicros).toBe(USD(5));
    expect((await db.getBalance(c.id)).reservedMicros).toBe(0);
  });

  it("settleUsage may overdraft past the hold — next hold then fails", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "led-7" });
    await db.creditCustomer(c.id, USD(1), { refType: "topup", refId: "t-7" });
    await db.holdReserve(c.id, USD(1), "req-7a");
    const r = await db.settleUsage(c.id, "req-7a", USD(1.4));
    expect(r.balanceMicros).toBe(USD(-0.4));
    const next = await db.holdReserve(c.id, USD(0.1), "req-7b");
    expect(next.ok).toBe(false);
  });

  it("settleUsage refuses a hold belonging to another customer", async () => {
    const a = await db.getOrCreateCustomer({ googleSub: "led-12" });
    const b = await db.getOrCreateCustomer({ googleSub: "led-13" });
    await db.creditCustomer(a.id, USD(10), { refType: "topup", refId: "t-12" });
    await db.creditCustomer(b.id, USD(10), { refType: "topup", refId: "t-13" });
    await db.holdReserve(b.id, USD(2), "req-12-b");
    await expect(db.settleUsage(a.id, "req-12-b", USD(1))).rejects.toThrow(/No reserve_hold/);
    // B untouched
    const balB = await db.getBalance(b.id);
    expect(balB.reservedMicros).toBe(USD(2));
    expect(balB.balanceMicros).toBe(USD(10));
  });

  it("100 parallel holds against a $1 balance hold exactly $1 total", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "led-8" });
    await db.creditCustomer(c.id, USD(1), { refType: "topup", refId: "t-8" });
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => db.holdReserve(c.id, USD(0.01), `req-8-${i}`))
    );
    const okCount = results.filter((r) => r.ok).length;
    expect(okCount).toBe(100); // 100 × $0.01 == $1 exactly
    const bal = await db.getBalance(c.id);
    expect(bal.reservedMicros).toBe(USD(1));
    expect(bal.availableMicros).toBe(0);
    const over = await db.holdReserve(c.id, 1, "req-8-over");
    expect(over.ok).toBe(false);
  });

  it("100 parallel holds of $0.02 against $1 → exactly 50 succeed", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "led-9" });
    await db.creditCustomer(c.id, USD(1), { refType: "topup", refId: "t-9" });
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => db.holdReserve(c.id, USD(0.02), `req-9-${i}`))
    );
    expect(results.filter((r) => r.ok).length).toBe(50);
    expect((await db.getBalance(c.id)).reservedMicros).toBe(USD(1));
  });
});

describe("ledgerRepo — adjustments and listing", () => {
  it("adjustBalance applies a signed correction with ledger row", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "led-10" });
    await db.creditCustomer(c.id, USD(2), { refType: "topup", refId: "t-10" });
    const r = await db.adjustBalance(c.id, USD(-0.5), { reason: "goodwill-debit" });
    expect(r.balanceMicros).toBe(USD(1.5));
    const rows = await db.getLedger(c.id, { type: "adjustment" });
    expect(rows.length).toBe(1);
    expect(rows[0].amountMicros).toBe(USD(-0.5));
  });

  it("getLedger paginates newest-first with limit/offset", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "led-11" });
    for (let i = 0; i < 5; i++) {
      await db.creditCustomer(c.id, USD(0.01), { refType: "topup", refId: `t-11-${i}` });
    }
    const page1 = await db.getLedger(c.id, { limit: 2 });
    expect(page1.length).toBe(2);
    expect(page1[0].refId).toBe("t-11-4");
    const page2 = await db.getLedger(c.id, { limit: 2, offset: 2 });
    expect(page2[0].refId).toBe("t-11-2");
  });
});
