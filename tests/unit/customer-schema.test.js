// Customer billing tables exist on fresh DB and on existing DB (additive sync).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cust-schema-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const CUSTOMER_TABLES = [
  "customers", "customerKeys", "customerBalances", "ledger",
  "topups", "webhookEvents", "pricingVersions", "publicModels",
];

async function freshDb() {
  const { getAdapter } = await import("@/lib/db/driver.js");
  return getAdapter();
}

describe("Customer billing schema", () => {
  it("fresh DB creates all customer billing tables", async () => {
    const db = await freshDb();
    const tables = db.all(`SELECT name FROM sqlite_master WHERE type='table'`).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(CUSTOMER_TABLES));
  });

  it("unique constraints exist: customers.googleSub, customerKeys.keyHash, topups.takoTxnId, webhookEvents source+externalId, ledger refType+refId+type", async () => {
    const db = await freshDb();
    const sql = (name) =>
      db.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`, [name])?.sql || "";
    expect(sql("customers")).toMatch(/googleSub TEXT UNIQUE NOT NULL/);
    expect(sql("customerKeys")).toMatch(/keyHash TEXT UNIQUE NOT NULL/);
    expect(sql("topups")).toMatch(/takoTxnId TEXT UNIQUE/);
    // SQLite stores named unique indexes separately from CREATE TABLE.
    const indexSql = db
      .all(`SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL`)
      .map((r) => r.sql)
      .join("\n");
    expect(indexSql).toMatch(/UNIQUE INDEX idx_we_source_ext ON webhookEvents\(source, externalId\)/);
    expect(indexSql).toMatch(/UNIQUE INDEX idx_ledger_ref ON ledger\(refType, refId, type\)/);
  });

  it("SCHEMA_VERSION bumped past 2 and stamped in _meta", async () => {
    const { SCHEMA_VERSION } = await import("@/lib/db/schema.js");
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
    const db = await freshDb();
    const row = db.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(parseInt(row.value, 10)).toBeGreaterThanOrEqual(2);
  });

  it("existing DB (simulated old version) gains tables via additive sync", async () => {
    // Boot once, drop a table, force re-sync by lowering stored version, reboot.
    const db = await freshDb();
    db.exec(`DROP TABLE topups`);
    db.exec(`UPDATE _meta SET value='1' WHERE key='schemaVersion'`);
    db.close?.();
    delete global._dbAdapter;
    vi.resetModules();
    const db2 = await freshDb();
    const tables = db2.all(`SELECT name FROM sqlite_master WHERE type='table'`).map((t) => t.name);
    expect(tables).toContain("topups");
  });

  it("exportDb includes customer billing tables and importDb restores them", async () => {
    const dbi = await import("@/lib/db/index.js");
    const c = await dbi.getOrCreateCustomer({ googleSub: "exp-1", email: "e@x.y", name: "E" });
    await dbi.creditCustomer(c.id, 5_000_000, { refType: "topup", refId: "exp-t-1" });
    await dbi.upsertPricingVersion({
      modelId: "glm-5.3-flash", officialInputMicros: 300_000, officialOutputMicros: 1_500_000,
      effectiveFrom: "2026-10-01T00:00:00Z",
    });
    await dbi.upsertPublicModel({ publicName: "glm-5.3-flash", comboId: "combo-x" });

    const dump = await dbi.exportDb();
    expect(dump.customers.length).toBeGreaterThanOrEqual(1);
    expect(dump.ledger.length).toBeGreaterThanOrEqual(1);
    expect(dump.customerBalances.length).toBeGreaterThanOrEqual(1);
    expect(dump.pricingVersions.length).toBeGreaterThanOrEqual(1);
    expect(dump.publicModels.length).toBeGreaterThanOrEqual(1);

    const { getAdapter } = await import("@/lib/db/driver.js");
    const dba = await getAdapter();
    dba.transaction(() => {
      dba.run(`DELETE FROM customers`);
      dba.run(`DELETE FROM customerBalances`);
      dba.run(`DELETE FROM ledger`);
      dba.run(`DELETE FROM pricingVersions`);
      dba.run(`DELETE FROM publicModels`);
    });

    await dbi.importDb(dump);
    const restored = await dbi.getCustomerById(c.id);
    expect(restored.googleSub).toBe("exp-1");
    const bal = await dbi.getBalance(c.id);
    expect(bal.balanceMicros).toBe(5_000_000);
    const ledger = await dbi.getLedger(c.id);
    expect(ledger.length).toBe(1);
    expect((await dbi.getActivePricing("glm-5.3-flash")).officialInputMicros).toBe(300_000);
    expect(await dbi.getPublicModelByName("glm-5.3-flash")).not.toBeNull();
  });
});
