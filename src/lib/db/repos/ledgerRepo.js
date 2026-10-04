import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

export const MICROS_PER_USD = 1_000_000;

function nowIso() {
  return new Date().toISOString();
}

// Sync on purpose: every caller invokes it inside a synchronous transaction
// callback, where a returned Promise would silently read as `{}`.
function ensureBalanceRow(db, customerId) {
  db.run(
    `INSERT INTO customerBalances(customerId, balanceMicros, reservedMicros, updatedAt) VALUES(?, 0, 0, ?)
      ON CONFLICT(customerId) DO NOTHING`,
    [customerId, nowIso()]
  );
  return db.get(`SELECT * FROM customerBalances WHERE customerId = ?`, [customerId]);
}

function toBalance(row) {
  return {
    balanceMicros: Number(row.balanceMicros),
    reservedMicros: Number(row.reservedMicros),
    availableMicros: Number(row.balanceMicros) - Number(row.reservedMicros),
  };
}

export async function getBalance(customerId) {
  const db = await getAdapter();
  const row = await ensureBalanceRow(db, customerId);
  return toBalance(row);
}

function appendLedger(db, { customerId, type, amountMicros, balanceAfterMicros, refType, refId, meta }) {
  db.run(
    `INSERT INTO ledger(id, customerId, type, amountMicros, balanceAfterMicros, refType, refId, meta, createdAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), customerId, type, amountMicros, balanceAfterMicros, refType || null, refId || null, meta ? JSON.stringify(meta) : null, nowIso()]
  );
}

// Idempotent credit: unique (refType, refId, type) — a duplicate insert throws,
// we treat that as "already applied" and return current state.
export async function creditCustomer(customerId, amountMicros, { refType, refId, meta } = {}) {
  const amount = Math.round(Number(amountMicros));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("credit amountMicros must be > 0");
  const db = await getAdapter();
  return db.transaction(() => {
    const row = ensureBalanceRow(db, customerId);
    const current = toBalance(row);
    if (refType && refId) {
      const dupe = db.get(
        `SELECT id FROM ledger WHERE refType = ? AND refId = ? AND type = 'topup_credit' LIMIT 1`,
        [refType, refId]
      );
      if (dupe) return { ...current, idempotent: true };
    }
    const newBalance = current.balanceMicros + amount;
    db.run(
      `UPDATE customerBalances SET balanceMicros = ?, updatedAt = ? WHERE customerId = ?`,
      [newBalance, nowIso(), customerId]
    );
    appendLedger(db, {
      customerId, type: "topup_credit", amountMicros: amount,
      balanceAfterMicros: newBalance, refType, refId, meta,
    });
    return { balanceMicros: newBalance, reservedMicros: current.reservedMicros, availableMicros: newBalance - current.reservedMicros, idempotent: false };
  });
}

// Atomic hold. SQLite serializes writers, so read-check-write inside one
// transaction cannot race. Returns { ok:false } without mutation on shortfall.
export async function holdReserve(customerId, amountMicros, refId) {
  const amount = Math.round(Number(amountMicros));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("reserve amountMicros must be > 0");
  if (!refId) throw new Error("refId is required for a hold");
  const db = await getAdapter();
  return db.transaction(() => {
    const row = ensureBalanceRow(db, customerId);
    const current = toBalance(row);
    if (current.availableMicros < amount) return { ok: false };
    db.run(
      `UPDATE customerBalances SET reservedMicros = reservedMicros + ?, updatedAt = ? WHERE customerId = ?`,
      [amount, nowIso(), customerId]
    );
    appendLedger(db, {
      customerId, type: "reserve_hold", amountMicros: 0,
      balanceAfterMicros: current.balanceMicros, refType: "request", refId, meta: { heldMicros: amount },
    });
    return { ok: true };
  });
}

// Settle one held request: debit actual usage (may exceed the hold → negative
// balance, the only overdraft path) and release the hold.
export async function settleUsage(customerId, holdRefId, usageMicros, meta = {}) {
  const usage = Math.round(Number(usageMicros));
  if (!Number.isFinite(usage) || usage < 0) throw new Error("usageMicros must be >= 0");
  if (!holdRefId) throw new Error("holdRefId is required");
  const db = await getAdapter();
  return db.transaction(() => {
    const row = ensureBalanceRow(db, customerId);
    const current = toBalance(row);
    const hold = db.get(
      `SELECT meta FROM ledger WHERE refType = 'request' AND refId = ? AND type = 'reserve_hold' LIMIT 1`,
      [holdRefId]
    );
    if (!hold) throw new Error(`No reserve_hold found for refId ${holdRefId}`);
    const heldMicros = Number((JSON.parse(hold.meta || "{}")).heldMicros || 0);
    const newBalance = current.balanceMicros - usage;
    const newReserved = Math.max(0, current.reservedMicros - heldMicros);
    db.run(
      `UPDATE customerBalances SET balanceMicros = ?, reservedMicros = ?, updatedAt = ? WHERE customerId = ?`,
      [newBalance, newReserved, nowIso(), customerId]
    );
    if (usage > 0) {
      appendLedger(db, {
        customerId, type: "usage_debit", amountMicros: -usage,
        balanceAfterMicros: newBalance, refType: "request", refId: holdRefId, meta,
      });
    }
    appendLedger(db, {
      customerId, type: "reserve_release", amountMicros: 0,
      balanceAfterMicros: newBalance, refType: "request", refId: holdRefId,
      meta: { releasedMicros: heldMicros, chargedMicros: usage },
    });
    return { balanceMicros: newBalance, reservedMicros: newReserved, availableMicros: newBalance - newReserved };
  });
}

// Admin correction — signed amount, ledger type "adjustment".
export async function adjustBalance(customerId, amountMicros, { reason } = {}) {
  const amount = Math.round(Number(amountMicros));
  if (!Number.isFinite(amount) || amount === 0) throw new Error("adjustment amountMicros must be non-zero");
  const db = await getAdapter();
  return db.transaction(() => {
    const row = ensureBalanceRow(db, customerId);
    const current = toBalance(row);
    const newBalance = current.balanceMicros + amount;
    db.run(
      `UPDATE customerBalances SET balanceMicros = ?, updatedAt = ? WHERE customerId = ?`,
      [newBalance, nowIso(), customerId]
    );
    appendLedger(db, {
      customerId, type: "adjustment", amountMicros: amount,
      balanceAfterMicros: newBalance, refType: "admin", refId: null, meta: { reason },
    });
    return { balanceMicros: newBalance, reservedMicros: current.reservedMicros, availableMicros: newBalance - current.reservedMicros };
  });
}

export async function getLedger(customerId, { limit = 50, offset = 0, type } = {}) {
  const db = await getAdapter();
  const params = [customerId];
  let where = `customerId = ?`;
  if (type) {
    where += ` AND type = ?`;
    params.push(type);
  }
  const lim = Math.min(Math.max(1, Number(limit) || 50), 500);
  const off = Math.max(0, Number(offset) || 0);
  return db.all(
    `SELECT * FROM ledger WHERE ${where} ORDER BY createdAt DESC, rowid DESC LIMIT ${lim} OFFSET ${off}`,
    params
  ).map((r) => ({
    ...r,
    amountMicros: Number(r.amountMicros),
    balanceAfterMicros: Number(r.balanceAfterMicros),
    meta: r.meta ? JSON.parse(r.meta) : null,
  }));
}
