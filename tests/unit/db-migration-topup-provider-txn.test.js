// Migration 005: topups.takoTxnId → topups.providerTxnId on an existing DB.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let adapter;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mig-005-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  const { getAdapter } = await import("@/lib/db/driver.js");
  adapter = await getAdapter();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("migration 005 topup-provider-txn", () => {
  // getAdapter() already ran the schema sync, so start each case from a clean table.
  beforeEach(() => {
    adapter.exec(`DROP TABLE IF EXISTS topups`);
  });

  it("renames the legacy column and keeps the rows", async () => {
    adapter.exec(
      `CREATE TABLE topups(id TEXT PRIMARY KEY, customerId TEXT NOT NULL, takoTxnId TEXT UNIQUE,
       amountIdr INTEGER NOT NULL, rateMilli INTEGER NOT NULL, creditedMicros INTEGER,
       status TEXT NOT NULL DEFAULT 'pending', paymentUrl TEXT, paidAt TEXT,
       createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
    );
    adapter.run(
      `INSERT INTO topups(id, customerId, takoTxnId, amountIdr, rateMilli, createdAt, updatedAt)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
      ["t1", "c1", "legacy-tx", 50_000, 16_000_000, "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"],
    );

    const { default: migration } = await import("@/lib/db/migrations/005-topup-provider-txn.js");
    await migration.up();

    const columns = adapter.all(`PRAGMA table_info(topups)`).map((c) => c.name);
    expect(columns).toContain("providerTxnId");
    expect(columns).not.toContain("takoTxnId");
    expect(adapter.get(`SELECT providerTxnId FROM topups WHERE id = ?`, ["t1"]).providerTxnId).toBe("legacy-tx");
  });

  it("is a no-op when the table does not exist yet (fresh DB)", async () => {
    const { default: migration } = await import("@/lib/db/migrations/005-topup-provider-txn.js");
    await expect(migration.up()).resolves.toBeUndefined();
  });
});
