// First-login provisioning + one-time key reveal. The plaintext lives in
// process memory for at most 10 minutes and is consumed on first read —
// never persisted, never in a cookie.
import crypto from "node:crypto";
import { getAdapter } from "@/lib/db/driver.js";
import { getOrCreateCustomer, createCustomerKey, getActiveKeyForCustomer } from "@/lib/db";

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
// leaked token can't be read from another session.
export function takeKeyReveal(token, customerId) {
  const entry = revealStore.get(token);
  if (!entry) return null;
  revealStore.delete(token);
  if (entry.expiresAt < Date.now()) return null;
  if (customerId && entry.customerId !== customerId) return null;
  return entry.plaintext;
}

export async function provisionCustomerFromGoogle({ sub, email, name }) {
  const db = await getAdapter();
  const existed = db.get(`SELECT id FROM customers WHERE googleSub = ?`, [sub]);
  const customer = await getOrCreateCustomer({ googleSub: sub, email, name });
  const created = !existed;
  const activeKey = await getActiveKeyForCustomer(customer.id);
  if (activeKey) return { customer, key: null, revealToken: null, created };
  const { key } = await createCustomerKey(customer.id);
  const revealToken = stageKeyReveal(customer.id, key);
  return { customer, key, revealToken, created };
}
