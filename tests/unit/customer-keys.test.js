// Customer API keys — hashed storage, one-time plaintext, validate, revoke.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cust-keys-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("customerKeysRepo", () => {
  it("createCustomerKey returns sk-cust- plaintext + masked record", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "key-sub-1" });
    const { key, record } = await db.createCustomerKey(c.id);
    expect(key).toMatch(/^sk-cust-[0-9a-f]{64}$/);
    expect(record.keyMask).toBe(`sk-cust-…${key.slice(-4)}`);
    expect(record.keyHash).not.toBe(key);
    expect(record.revokedAt).toBeNull();
  });

  it("plaintext is never stored — row has no column containing it", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "key-sub-2" });
    const { key } = await db.createCustomerKey(c.id);
    const { getAdapter } = await import("@/lib/db/driver.js");
    const dba = await getAdapter();
    const row = dba.get(`SELECT * FROM customerKeys WHERE customerId = ?`, [c.id]);
    for (const v of Object.values(row)) {
      if (typeof v === "string") expect(v).not.toContain(key);
    }
    // And the stored hash really is HMAC(key) — verifiable but not reversible.
    const secret = process.env.API_KEY_SECRET || "endpoint-proxy-api-key-secret";
    expect(row.keyHash).toBe(
      crypto.createHmac("sha256", secret).update(key).digest("hex")
    );
  });

  it("validateCustomerKey resolves active key + customer", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "key-sub-3" });
    const { key } = await db.createCustomerKey(c.id);
    const hit = await db.validateCustomerKey(key);
    expect(hit.customer.id).toBe(c.id);
    expect(hit.key.customerId).toBe(c.id);
  });

  it("validateCustomerKey returns null for garbage / wrong key", async () => {
    expect(await db.validateCustomerKey("sk-cust-deadbeef")).toBeNull();
    expect(await db.validateCustomerKey("")).toBeNull();
    expect(await db.validateCustomerKey(null)).toBeNull();
  });

  it("revoked key no longer validates", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "key-sub-4" });
    const { key, record } = await db.createCustomerKey(c.id);
    await db.revokeCustomerKey(record.id);
    expect(await db.validateCustomerKey(key)).toBeNull();
  });

  it("key of a disabled customer no longer validates", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "key-sub-5" });
    const { key } = await db.createCustomerKey(c.id);
    await db.setCustomerStatus(c.id, "disabled");
    expect(await db.validateCustomerKey(key)).toBeNull();
    await db.setCustomerStatus(c.id, "active");
    expect(await db.validateCustomerKey(key)).not.toBeNull();
  });

  it("getActiveKeyForCustomer returns the unrevoked key only", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "key-sub-6" });
    const first = await db.createCustomerKey(c.id);
    await db.revokeCustomerKey(first.record.id);
    const second = await db.createCustomerKey(c.id);
    const active = await db.getActiveKeyForCustomer(c.id);
    expect(active.id).toBe(second.record.id);
  });
});
