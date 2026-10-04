// First-login provisioning + one-time key reveal. The plaintext lives in
// process memory for at most 10 minutes and is consumed on first read —
// never persisted, never in a cookie.
import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "@/lib/db/driver.js";
import { getOrCreateCustomer, getActiveKeyForCustomer } from "@/lib/db";

const REVEAL_TTL_MS = 10 * 60 * 1000;
const revealStore = new Map(); // token -> { customerId, plaintext, expiresAt }

export function stageKeyReveal(customerId, plaintext) {
  const token = crypto.randomUUID();
  revealStore.set(token, { customerId, plaintext, expiresAt: Date.now() + REVEAL_TTL_MS });
  // opportunistic sweep
  for (const [k, v] of revealStore) if (v.expiresAt < Date.now()) revealStore.delete(k);
  return token;
}

// One-time consume: binds the token to the customer it was staged for so a
// leaked token can't be read from another session. A failed probe (wrong
// customer, unknown token) does NOT burn the owner's token; an expired entry
// is deleted on sight.
export function takeKeyReveal(token, customerId) {
  const entry = revealStore.get(token);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    revealStore.delete(token);
    return null;
  }
  if (customerId && entry.customerId !== customerId) return null;
  revealStore.delete(token);
  return entry.plaintext;
}

// Inline key creation (mirrors customerKeysRepo.createCustomerKey) — needed so
// the check + insert run synchronously inside one db.transaction; an async
// callback would escape the SAVEPOINT/begin-commit window. One env, one
// fallback, same as the repo.
const API_KEY_SECRET = process.env.API_KEY_SECRET || "endpoint-proxy-api-key-secret";

function insertCustomerKey(db, customerId) {
  const plaintext = `sk-cust-${crypto.randomBytes(32).toString("hex")}`;
  const record = {
    id: uuidv4(),
    customerId,
    keyHash: crypto.createHmac("sha256", API_KEY_SECRET).update(plaintext).digest("hex"),
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

export async function provisionCustomerFromGoogle({ sub, email, name }) {
  const db = await getAdapter();
  const existed = db.get(`SELECT id FROM customers WHERE googleSub = ?`, [sub]);
  const customer = await getOrCreateCustomer({ googleSub: sub, email, name });
  const created = !existed;
  const activeKey = await getActiveKeyForCustomer(customer.id);
  if (activeKey) return { customer, key: null, revealToken: null, created };
  // Concurrent first logins race here — recheck + insert inside ONE
  // synchronous transaction so only one active key can be created.
  const result = db.transaction(() => {
    const fresh = db.get(
      `SELECT id FROM customerKeys WHERE customerId = ? AND revokedAt IS NULL LIMIT 1`,
      [customer.id]
    );
    if (fresh) return { key: null, record: null };
    return insertCustomerKey(db, customer.id);
  });
  if (!result.key) return { customer, key: null, revealToken: null, created };
  const revealToken = stageKeyReveal(customer.id, result.key);
  return { customer, key: result.key, revealToken, created };
}
