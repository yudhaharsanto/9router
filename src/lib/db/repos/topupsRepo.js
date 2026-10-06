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
    takoTxnId: row.takoTxnId || null,
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
    id: uuidv4(), customerId, takoTxnId: null,
    amountIdr, rateMilli, creditedMicros,
    status: "pending", paymentUrl: null, paidAt: null,
    createdAt: now, updatedAt: now,
  };
  db.run(
    `INSERT INTO topups(id, customerId, takoTxnId, amountIdr, rateMilli, creditedMicros, status, paymentUrl, paidAt, createdAt, updatedAt)
     VALUES(?, ?, NULL, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
    [topup.id, topup.customerId, topup.amountIdr, topup.rateMilli, topup.creditedMicros, topup.createdAt, topup.updatedAt]
  );
  return topup;
}

export async function setTopupPayment(id, { takoTxnId, paymentUrl }) {
  if (!takoTxnId) throw new Error("takoTxnId is required");
  const db = await getAdapter();
  db.run(
    `UPDATE topups SET takoTxnId = ?, paymentUrl = COALESCE(?, paymentUrl), updatedAt = ? WHERE id = ?`,
    [takoTxnId, paymentUrl || null, new Date().toISOString(), id]
  );
}

export async function getTopupById(id) {
  const db = await getAdapter();
  return rowToTopup(db.get(`SELECT * FROM topups WHERE id = ?`, [id]));
}

export async function getTopupByTakoTxnId(takoTxnId) {
  const db = await getAdapter();
  return rowToTopup(db.get(`SELECT * FROM topups WHERE takoTxnId = ?`, [takoTxnId]));
}

export async function listTopups(customerId, { limit = 50 } = {}) {
  const db = await getAdapter();
  const lim = Math.min(Math.max(1, Number(limit) || 50), 500);
  return db.all(`SELECT * FROM topups WHERE customerId = ? ORDER BY createdAt DESC LIMIT ${lim}`, [customerId])
    .map(rowToTopup);
}

export async function markTopupPaid(takoTxnId) {
  const db = await getAdapter();
  db.run(
    `UPDATE topups SET status = 'paid', paidAt = COALESCE(paidAt, ?), updatedAt = ? WHERE takoTxnId = ?`,
    [new Date().toISOString(), new Date().toISOString(), takoTxnId]
  );
  return getTopupByTakoTxnId(takoTxnId);
}

// The single credit path for the Tako webhook handler. Guard on status keeps
// replays out; the ledger's unique (refType, refId, type) guards even a
// concurrent double-apply (second creditCustomer becomes a no-op).
export async function applyTopupCredit(takoTxnId) {
  const { creditCustomer } = await import("./ledgerRepo.js");
  const topup = await getTopupByTakoTxnId(takoTxnId);
  if (!topup) return { credited: false, reason: "not-found" };
  if (topup.status !== "pending") return { credited: false, reason: "already-processed" };
  if (topup.creditedMicros == null) return { credited: false, reason: "no-credited-amount" };
  await creditCustomer(topup.customerId, topup.creditedMicros, {
    refType: "topup",
    refId: topup.id,
    meta: { takoTxnId, amountIdr: topup.amountIdr, rateMilli: topup.rateMilli },
  });
  await markTopupPaid(takoTxnId);
  // Package purchase paid alongside: activate its pending instance. Best-effort
  // — the balance credit above must not fail because of it.
  try {
    const { activateFromTopup } = await import("./packagesRepo.js");
    await activateFromTopup(topup.id);
  } catch (err) {
    console.error(`[Topups] package activation failed for topup ${topup.id}:`, err?.message || err);
  }
  return { credited: true, topup: await getTopupByTakoTxnId(takoTxnId) };
}
