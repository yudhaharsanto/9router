import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

const VALID_STATUS = ["active", "disabled"];

function rowToCustomer(row) {
  if (!row) return null;
  return {
    id: row.id,
    googleSub: row.googleSub,
    email: row.email || null,
    name: row.name || null,
    status: row.status || "active",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Find-or-create by Google subject. On unique-race (two parallel first logins),
// the losing INSERT re-reads the winner's row.
export async function getOrCreateCustomer({ googleSub, email, name }) {
  if (!googleSub) throw new Error("googleSub is required");
  const db = await getAdapter();
  const existing = db.get(`SELECT * FROM customers WHERE googleSub = ?`, [googleSub]);
  if (existing) {
    if (
      (email && email !== existing.email) ||
      (name && name !== existing.name)
    ) {
      db.run(
        `UPDATE customers SET email = COALESCE(?, email), name = COALESCE(?, name), updatedAt = ? WHERE id = ?`,
        [email || null, name || null, new Date().toISOString(), existing.id]
      );
      return rowToCustomer(db.get(`SELECT * FROM customers WHERE id = ?`, [existing.id]));
    }
    return rowToCustomer(existing);
  }
  const now = new Date().toISOString();
  try {
    db.run(
      `INSERT INTO customers(id, googleSub, email, name, status, createdAt, updatedAt) VALUES(?, ?, ?, ?, 'active', ?, ?)`,
      [uuidv4(), googleSub, email || null, name || null, now, now]
    );
  } catch {
    // Lost a race — the winner's row is authoritative.
    return rowToCustomer(db.get(`SELECT * FROM customers WHERE googleSub = ?`, [googleSub]));
  }
  return rowToCustomer(db.get(`SELECT * FROM customers WHERE googleSub = ?`, [googleSub]));
}

export async function getCustomerById(id) {
  const db = await getAdapter();
  return rowToCustomer(db.get(`SELECT * FROM customers WHERE id = ?`, [id]));
}

export async function setCustomerStatus(id, status) {
  if (!VALID_STATUS.includes(status)) throw new Error(`Invalid customer status: ${status}`);
  const db = await getAdapter();
  db.run(`UPDATE customers SET status = ?, updatedAt = ? WHERE id = ?`, [status, new Date().toISOString(), id]);
}

// Admin list (phase 5c): every customer joined with balance, active key mask,
// and total topup credits. Aggregates computed in SQL; no key hashes leave here.
export async function listCustomersWithDetails() {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT c.id, c.email, c.name, c.status, c.createdAt, c.updatedAt,
            COALESCE(b.balanceMicros, 0) AS balanceMicros,
            COALESCE(b.reservedMicros, 0) AS reservedMicros,
            COALESCE(SUM(CASE WHEN l.type = 'topup_credit' THEN l.amountMicros END), 0) AS totalTopupMicros,
            k.keyMask AS keyMask
       FROM customers c
       LEFT JOIN customerBalances b ON b.customerId = c.id
       LEFT JOIN ledger l ON l.customerId = c.id
       LEFT JOIN customerKeys k ON k.customerId = c.id AND k.revokedAt IS NULL
      GROUP BY c.id
      ORDER BY c.createdAt DESC`
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email || null,
    name: r.name || null,
    status: r.status || "active",
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    balanceMicros: Number(r.balanceMicros),
    reservedMicros: Number(r.reservedMicros),
    totalTopupMicros: Number(r.totalTopupMicros),
    keyMask: r.keyMask || null,
  }));
}
