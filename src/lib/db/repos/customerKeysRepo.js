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
    keyEnc: encryptKey(plaintext),
    revokedAt: null,
    createdAt: new Date().toISOString(),
  };
  db.run(
    `INSERT INTO customerKeys(id, customerId, keyHash, keyMask, keyEnc, revokedAt, createdAt) VALUES(?, ?, ?, ?, ?, NULL, ?)`,
    [record.id, record.customerId, record.keyHash, record.keyMask, record.keyEnc, record.createdAt]
  );
  return { key: plaintext, record };
}

// ─── Re-reveal (phase 8): AES-256-GCM over the plaintext, key derived from
// JWT_SECRET. The ciphertext is useless without the server secret, and the
// secret is never stored beside the data it protects.
function masterKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null; // no secret → no encryption, reveal disabled
  return crypto.createHash("sha256").update(`9router:keyenc:${secret}`).digest();
}

// Exported for the raw-insert sites (google provision + regenerate) that build
// key rows outside this repo's createCustomerKey.
export function encryptKeyForStorage(plaintext) {
  return encryptKey(plaintext);
}

function encryptKey(plaintext) {
  const mk = masterKey();
  if (!mk) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", mk, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${enc.toString("hex")}`;
}

function decryptKey(keyEnc) {
  if (!keyEnc) return null;
  const mk = masterKey();
  if (!mk) return null;
  const [ivHex, tagHex, dataHex] = String(keyEnc).split(":");
  if (!ivHex || !tagHex || !dataHex) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", mk, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataHex, "hex")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null; // wrong secret / tampered ciphertext
  }
}

// Returns the active key's plaintext, or null when there is no active key or
// the stored ciphertext cannot be decrypted (legacy row / secret changed) —
// null callers fall back to regeneration.
export async function revealCustomerKey(customerId) {
  if (!customerId) return null;
  const db = await getAdapter();
  const row = db.get(
    `SELECT keyEnc FROM customerKeys WHERE customerId = ? AND revokedAt IS NULL ORDER BY createdAt DESC LIMIT 1`,
    [customerId]
  );
  return row ? decryptKey(row.keyEnc) : null;
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
