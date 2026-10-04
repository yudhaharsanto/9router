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
