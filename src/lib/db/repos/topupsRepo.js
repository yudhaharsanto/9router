import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

// creditedMicros = round(amountIdr × 1e9 / rateMilli) — pure integer math.
export function computeCreditedMicros(amountIdr, rateMilli) {
  if (!Number.isInteger(amountIdr) || amountIdr <= 0) throw new Error("amountIdr must be a positive integer");
  if (!Number.isInteger(rateMilli) || rateMilli <= 0) throw new Error("rateMilli must be a positive integer");
  return Math.round((amountIdr * 1_000_000_000) / rateMilli);
}

function rowToTopup(row) {
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customerId,
    providerTxnId: row.providerTxnId || null,
    amountIdr: Number(row.amountIdr),
    rateMilli: Number(row.rateMilli),
    creditedMicros: row.creditedMicros == null ? null : Number(row.creditedMicros),
    status: row.status,
    paymentUrl: row.paymentUrl || null,
    paidAt: row.paidAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createTopup({ customerId, amountIdr, rateMilli }) {
  if (!customerId) throw new Error("customerId is required");
  const creditedMicros = computeCreditedMicros(amountIdr, rateMilli);
  const db = await getAdapter();
  const now = new Date().toISOString();
  const topup = {
    id: uuidv4(), customerId, providerTxnId: null,
    amountIdr, rateMilli, creditedMicros,
    status: "pending", paymentUrl: null, paidAt: null,
    createdAt: now, updatedAt: now,
  };
  db.run(
    `INSERT INTO topups(id, customerId, providerTxnId, amountIdr, rateMilli, creditedMicros, status, paymentUrl, paidAt, createdAt, updatedAt)
     VALUES(?, ?, NULL, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
    [topup.id, topup.customerId, topup.amountIdr, topup.rateMilli, topup.creditedMicros, topup.createdAt, topup.updatedAt]
  );
  return topup;
}

// The QRIS URL is known at creation; the provider transaction id is not (the
// gateway has no callback — it is discovered later by polling).
export async function setTopupPaymentUrl(id, paymentUrl) {
  const db = await getAdapter();
  db.run(
    `UPDATE topups SET paymentUrl = ?, updatedAt = ? WHERE id = ?`,
    [paymentUrl || null, new Date().toISOString(), id]
  );
}

// Claim a provider transaction for a topup. The UNIQUE index on providerTxnId
// is the collision guard: two pending topups with the same amount can both see
// the same incoming payment, but only the first claim wins — the second stays
// pending instead of double-crediting.
export async function claimTopupTransaction(id, providerTxnId) {
  if (!providerTxnId) return false;
  const db = await getAdapter();
  try {
    db.run(
      `UPDATE topups SET providerTxnId = ?, updatedAt = ? WHERE id = ? AND providerTxnId IS NULL`,
      [providerTxnId, new Date().toISOString(), id]
    );
  } catch {
    return false; // UNIQUE violation: another topup already owns this payment
  }
  const row = db.get(`SELECT providerTxnId FROM topups WHERE id = ?`, [id]);
  return row?.providerTxnId === providerTxnId;
}

export async function getTopupById(id) {
  const db = await getAdapter();
  return rowToTopup(db.get(`SELECT * FROM topups WHERE id = ?`, [id]));
}

export async function getTopupByProviderTxnId(providerTxnId) {
  const db = await getAdapter();
  return rowToTopup(db.get(`SELECT * FROM topups WHERE providerTxnId = ?`, [providerTxnId]));
}

// Pending topups that still have a live QR and were created inside the poll
// window. Older rows are never auto-credited: /check-payment matches by amount
// only, so a wide window could claim an unrelated payment of the same amount.
export async function listPendingTopups({ customerId = null, sinceIso, limit = 20 }) {
  const db = await getAdapter();
  const lim = Math.min(Math.max(1, Number(limit) || 20), 100);
  const where = `status = 'pending' AND paymentUrl IS NOT NULL AND createdAt >= ?`;
  const rows = customerId
    ? db.all(`SELECT * FROM topups WHERE ${where} AND customerId = ? ORDER BY createdAt ASC LIMIT ${lim}`, [sinceIso, customerId])
    : db.all(`SELECT * FROM topups WHERE ${where} ORDER BY createdAt ASC LIMIT ${lim}`, [sinceIso]);
  return rows.map(rowToTopup);
}

export async function listTopups(customerId, { limit = 50 } = {}) {
  const db = await getAdapter();
  const lim = Math.min(Math.max(1, Number(limit) || 50), 500);
  return db.all(`SELECT * FROM topups WHERE customerId = ? ORDER BY createdAt DESC LIMIT ${lim}`, [customerId])
    .map(rowToTopup);
}

export async function markTopupPaid(providerTxnId) {
  const db = await getAdapter();
  db.run(
    `UPDATE topups SET status = 'paid', paidAt = COALESCE(paidAt, ?), updatedAt = ? WHERE providerTxnId = ?`,
    [new Date().toISOString(), new Date().toISOString(), providerTxnId]
  );
  return getTopupByProviderTxnId(providerTxnId);
}

// The single credit path for the ShopeePay poller (and the admin sweep). Guard
// on status keeps replays out; the ledger's unique (refType, refId, type)
// guards even a concurrent double-apply (second creditCustomer is a no-op).
export async function applyTopupCredit(providerTxnId) {
  const { creditCustomer } = await import("./ledgerRepo.js");
  const topup = await getTopupByProviderTxnId(providerTxnId);
  if (!topup) return { credited: false, reason: "not-found" };
  if (topup.status !== "pending") return { credited: false, reason: "already-processed" };
  if (topup.creditedMicros == null) return { credited: false, reason: "no-credited-amount" };
  await creditCustomer(topup.customerId, topup.creditedMicros, {
    refType: "topup",
    refId: topup.id,
    meta: { providerTxnId, amountIdr: topup.amountIdr, rateMilli: topup.rateMilli },
  });
  await markTopupPaid(providerTxnId);
  return { credited: true, topup: await getTopupByProviderTxnId(providerTxnId) };
}
