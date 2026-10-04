import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

// Same secret convention as src/shared/utils/apiKey.js — one env, one fallback.
const API_KEY_SECRET = process.env.API_KEY_SECRET || "endpoint-proxy-api-key-secret";

function hashKey(plaintext) {
  return crypto.createHmac("sha256", API_KEY_SECRET).update(plaintext).digest("hex");
}

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customerId,
    keyHash: row.keyHash,
    keyMask: row.keyMask,
    revokedAt: row.revokedAt || null,
    createdAt: row.createdAt,
  };
}

// Generates `sk-cust-<64 hex>`. Plaintext is returned once and never persisted —
// the DB keeps only its HMAC and a display mask.
export async function createCustomerKey(customerId) {
  if (!customerId) throw new Error("customerId is required");
  const db = await getAdapter();
  const plaintext = `sk-cust-${crypto.randomBytes(32).toString("hex")}`;
  const record = {
    id: uuidv4(),
    customerId,
    keyHash: hashKey(plaintext),
    keyMask: `sk-cust-…${plaintext.slice(-4)}`,
    revokedAt: null,
    createdAt: new Date().toISOString(),
  };
  db.run(
    `INSERT INTO customerKeys(id, customerId, keyHash, keyMask, revokedAt, createdAt) VALUES(?, ?, ?, ?, NULL, ?)`,
    [record.id, record.customerId, record.keyHash, record.keyMask, record.createdAt]
  );
  return { key: plaintext, record };
}

// Constant-ish lookup: hash the presented key, then index-hit on keyHash.
// Returns null unless the key is unrevoked and its customer is active.
export async function validateCustomerKey(plaintext) {
  if (!plaintext || typeof plaintext !== "string") return null;
  const db = await getAdapter();
  const row = db.get(
    `SELECT k.*, c.status AS customerStatus
       FROM customerKeys k JOIN customers c ON c.id = k.customerId
      WHERE k.keyHash = ?`,
    [hashKey(plaintext)]
  );
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.customerStatus !== "active") return null;
  const { customerStatus, ...keyRow } = row;
  return { key: rowToKey(keyRow), customer: { id: row.customerId, status: row.customerStatus } };
}

export async function revokeCustomerKey(keyId) {
  const db = await getAdapter();
  db.run(`UPDATE customerKeys SET revokedAt = ? WHERE id = ? AND revokedAt IS NULL`, [
    new Date().toISOString(),
    keyId,
  ]);
}

export async function getActiveKeyForCustomer(customerId) {
  const db = await getAdapter();
  const row = db.get(
    `SELECT * FROM customerKeys WHERE customerId = ? AND revokedAt IS NULL ORDER BY createdAt DESC LIMIT 1`,
    [customerId]
  );
  return rowToKey(row);
}
