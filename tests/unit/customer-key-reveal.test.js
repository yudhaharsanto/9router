// Re-revealable customer API key (phase 8): the plaintext is stored AES-256-GCM
// encrypted in customerKeys.keyEnc so the customer can view it again without
// regenerating. The encryption key is derived from JWT_SECRET (never stored
// next to the data); a key row without keyEnc (created before this feature)
// reveals null → UI falls back to "regenerate".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  delete process.env.BASE_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-reveal-"));
  process.env.DATA_DIR = tempDir;
  process.env.JWT_SECRET = "test-jwt-secret";
  delete process.env.API_KEY_SECRET;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("customer key re-reveal", () => {
  it("stores the plaintext encrypted on create and reveals it back", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "reveal-1" });
    const { key: plaintext } = await db.createCustomerKey(c.id);
    const revealed = await db.revealCustomerKey(c.id);
    expect(revealed).toBe(plaintext);
  });

  it("round-trips through a different process module state (decryption is deterministic)", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "reveal-2" });
    const { key: plaintext } = await db.createCustomerKey(c.id);
    // Simulate a fresh process: wipe any in-memory caches via resetModules.
    vi.resetModules();
    const db2 = await import("@/lib/db/index.js");
    await db2.initDb();
    const revealed = await db2.revealCustomerKey(c.id);
    expect(revealed).toBe(plaintext);
  });

  it("returns null for a legacy row without keyEnc (no fake data)", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "reveal-3" });
    const { record } = await db.createCustomerKey(c.id);
    const adapter = (await import("@/lib/db/driver.js")).getAdapterSync
      ? undefined
      : null;
    // Directly strip keyEnc to simulate a pre-feature row.
    const { getAdapter } = await import("@/lib/db/driver.js");
    const a = await getAdapter();
    a.run(`UPDATE customerKeys SET keyEnc = NULL WHERE id = ?`, [record.id]);
    const revealed = await db.revealCustomerKey(c.id);
    expect(revealed).toBeNull();
  });

  it("returns null for a customer with no active key", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "reveal-4" });
    expect(await db.revealCustomerKey(c.id)).toBeNull();
  });

  it("does not reveal a revoked key", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "reveal-5" });
    const { record } = await db.createCustomerKey(c.id);
    const { revokeCustomerKey } = await import("@/lib/db/repos/customerKeysRepo.js");
    await revokeCustomerKey(record.id);
    expect(await db.revealCustomerKey(c.id)).toBeNull();
  });
});
