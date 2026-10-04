// POST /api/customer/webhooks/tako — HMAC over raw body, timing-safe compare,
// idempotent via webhookEvents unique (source, externalId), credits via the
// single applyTopupCredit path.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const originalSecret = process.env.TAKO_CALLBACK_SECRET;
let tempDir;
let db;

beforeAll(async () => {
  delete process.env.BASE_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-tako-webhook-"));
  process.env.DATA_DIR = tempDir;
  process.env.TAKO_CALLBACK_SECRET = "test-callback-secret";
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalSecret === undefined) delete process.env.TAKO_CALLBACK_SECRET;
  else process.env.TAKO_CALLBACK_SECRET = originalSecret;
});

function sign(body) {
  return crypto.createHmac("sha256", "test-callback-secret").update(body).digest("hex");
}

function hookRequest(body, signature, extra = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const headers = { "content-type": "application/json" };
  if (signature !== undefined) headers["x-tako-signature"] = signature;
  Object.assign(headers, extra.headers || {});
  return new Request("http://localhost:20128/api/customer/webhooks/tako", {
    method: "POST",
    headers,
    body: raw,
  });
}

async function makePaidTopup(takoTxnId, amountIdr = 100_000) {
  const c = await db.getOrCreateCustomer({ googleSub: `tako-${takoTxnId}` });
  const topup = await db.createTopup({ customerId: c.id, amountIdr, rateMilli: 16_000_000 });
  await db.setTopupPayment(topup.id, { takoTxnId, paymentUrl: "https://tako.id/pay/x" });
  return topup;
}

describe("POST /api/customer/webhooks/tako", () => {
  it("401 without a signature header", async () => {
    const mod = await import("@/app/api/customer/webhooks/tako/route.js");
    const res = await mod.POST(hookRequest({ transactionId: "tx-1" }, undefined));
    expect(res.status).toBe(401);
  });

  it("401 on a wrong signature (timing-safe reject)", async () => {
    const mod = await import("@/app/api/customer/webhooks/tako/route.js");
    const res = await mod.POST(
      hookRequest({ transactionId: "tx-2" }, "deadbeef".repeat(8)),
    );
    expect(res.status).toBe(401);
  });

  it("401 on a signature computed with the wrong key", async () => {
    const mod = await import("@/app/api/customer/webhooks/tako/route.js");
    const body = JSON.stringify({ transactionId: "tx-3" });
    const badSig = crypto.createHmac("sha256", "wrong-key").update(body).digest("hex");
    const res = await mod.POST(hookRequest(body, badSig));
    expect(res.status).toBe(401);
  });

  it("credits a valid signed callback and returns 200 after persist", async () => {
    const topup = await makePaidTopup("tx-ok");
    const before = await db.getBalance(topup.customerId);
    const payload = { transactionId: "tx-ok", status: "paid", amount: topup.amountIdr };
    const mod = await import("@/app/api/customer/webhooks/tako/route.js");
    const res = await mod.POST(hookRequest(payload, sign(JSON.stringify(payload))));
    expect(res.status).toBe(200);
    const after = await db.getBalance(topup.customerId);
    expect(after.balanceMicros).toBe(before.balanceMicros + topup.creditedMicros);
    const updated = await db.getTopupByTakoTxnId("tx-ok");
    expect(updated.status).toBe("paid");
  });

  it("replays are idempotent — same txn twice credits once, still 200", async () => {
    await makePaidTopup("tx-replay");
    const payload = { transactionId: "tx-replay", status: "paid" };
    const raw = JSON.stringify(payload);
    const mod = await import("@/app/api/customer/webhooks/tako/route.js");
    const res1 = await mod.POST(hookRequest(payload, sign(raw)));
    expect(res1.status).toBe(200);
    const res2 = await mod.POST(hookRequest(payload, sign(raw)));
    expect(res2.status).toBe(200);
    const topup = await db.getTopupByTakoTxnId("tx-replay");
    expect(topup.status).toBe("paid");
    // exactly one topup_credit ledger entry for this refId
    const ledger = await db.getLedger(topup.customerId, { limit: 100 });
    const credits = ledger.filter((e) => e.refType === "topup" && e.refId === topup.id);
    expect(credits.length).toBe(1);
  });

  it("unknown transactionId still persists the event (unprocessed) and returns 500", async () => {
    const payload = { transactionId: "tx-ghost", status: "paid" };
    const mod = await import("@/app/api/customer/webhooks/tako/route.js");
    const res = await mod.POST(hookRequest(payload, sign(JSON.stringify(payload))));
    expect(res.status).toBe(500);
    const events = await db.getUnprocessedWebhookEvents("tako");
    const ghost = events.find((e) => e.externalId === "tx-ghost");
    expect(ghost).toBeTruthy();
  });
});
