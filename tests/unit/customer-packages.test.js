// Token packages — katalog, instance lifecycle, FIFO consume, scope match,
// lazy expiry, topup-paid activation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let packages;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cust-packages-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  packages = await import("@/lib/db/repos/packagesRepo.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const PKG = {
  name: "Paket Mini 50M",
  tokens: 50_000_000,
  priceIdr: 20_000,
  models: JSON.stringify(["gpt-4o-mini"]),
  durationDays: 30,
};

describe("packagesRepo — katalog", () => {
  it("createPackage + getPackageById round-trips", async () => {
    const p = await packages.createPackage(PKG);
    expect(p.id).toBeTruthy();
    const got = await packages.getPackageById(p.id);
    expect(got.name).toBe(PKG.name);
    expect(got.tokens).toBe(50_000_000);
    expect(got.priceIdr).toBe(20_000);
    expect(got.durationDays).toBe(30);
    expect(got.active).toBe(true);
    expect(JSON.parse(got.models)).toEqual(["gpt-4o-mini"]);
  });

  it("listPackages returns created packages", async () => {
    const list = await packages.listPackages();
    expect(list.length).toBeGreaterThanOrEqual(1);
  });

  it("updatePackage can deactivate a catalog entry", async () => {
    const p = await packages.createPackage({ ...PKG, name: "deprecate-me" });
    await packages.updatePackage(p.id, { active: false });
    const got = await packages.getPackageById(p.id);
    expect(got.active).toBe(false);
  });
});

describe("packagesRepo — assign & activation", () => {
  it("assignPackage creates an active instance with expiresAt", async () => {
    const p = await packages.createPackage(PKG);
    const c = await db.getOrCreateCustomer({ googleSub: "pkg-assign-1" });
    const inst = await packages.assignPackage(c.id, p.id);
    expect(inst.status).toBe("active");
    expect(inst.tokensGranted).toBe(50_000_000);
    expect(inst.tokensUsed).toBe(0);
    expect(inst.activatedAt).toBeTruthy();
    expect(inst.expiresAt).toBeTruthy();
    const days = (new Date(inst.expiresAt) - new Date(inst.activatedAt)) / 86_400_000;
    expect(Math.round(days)).toBe(30);
  });

  it("durationDays 0 → expiresAt null (no expiry)", async () => {
    const p = await packages.createPackage({ ...PKG, name: "forever", durationDays: 0 });
    const c = await db.getOrCreateCustomer({ googleSub: "pkg-assign-2" });
    const inst = await packages.assignPackage(c.id, p.id);
    expect(inst.expiresAt).toBeNull();
  });

  it("pendingFromTopup + activateFromTopup — grants snapshot on activation", async () => {
    const p = await packages.createPackage({ ...PKG, name: "buyable", tokens: 10_000_000 });
    const c = await db.getOrCreateCustomer({ googleSub: "pkg-buy-1" });
    const inst = await packages.createPendingFromTopup({ customerId: c.id, packageId: p.id, topupId: "topup-1" });
    expect(inst.status).toBe("pending");
    expect(inst.tokensGranted).toBe(0);

    const activated = await packages.activateFromTopup("topup-1");
    expect(activated.ok).toBe(true);
    expect(activated.instance.status).toBe("active");
    expect(activated.instance.tokensGranted).toBe(10_000_000);
    expect(activated.instance.activatedAt).toBeTruthy();
    expect(activated.instance.expiresAt).toBeTruthy();

    // replay is a no-op
    const again = await packages.activateFromTopup("topup-1");
    expect(again.ok).toBe(false);
  });

  it("activateFromTopup with unknown topupId fails cleanly", async () => {
    const r = await packages.activateFromTopup("nope-topup-id");
    expect(r.ok).toBe(false);
  });
});

describe("packagesRepo — FIFO consume", () => {
  it("consumes from oldest active instance first, splits across instances", async () => {
    const p = await packages.createPackage({ ...PKG, name: "fifo", tokens: 100 });
    const c = await db.getOrCreateCustomer({ googleSub: "pkg-fifo-1" });
    const i1 = await packages.assignPackage(c.id, p.id);
    const i2 = await packages.assignPackage(c.id, p.id);

    const r1 = await packages.consumeTokens(c.id, p.id, 60, "gpt-4o-mini");
    expect(r1.charged).toBe(60);
    expect(r1.balanceDebitMicros).toBe(0);
    const s1 = await packages.getCustomerPackages(c.id);
    const [a, b] = s1.filter((x) => x.status === "active").sort((x, y) => x.activatedAt < y.activatedAt ? -1 : 1);
    expect(a.tokensUsed).toBe(60);
    expect(b.tokensUsed).toBe(0);

    // 40 left on i1, need 70 → i1 exhausts, 30 from i2
    const r2 = await packages.consumeTokens(c.id, p.id, 70, "gpt-4o-mini");
    expect(r2.charged).toBe(70);
    expect(r2.balanceDebitMicros).toBe(0);
    const s2 = await packages.getCustomerPackages(c.id);
    const after = s2.find((x) => x.id === i1.id);
    expect(after.tokensUsed).toBe(100);
  });

  it("model outside scope → balanceDebit for full usage, quota untouched", async () => {
    const p = await packages.createPackage({ ...PKG, name: "scoped", tokens: 100 });
    const c = await db.getOrCreateCustomer({ googleSub: "pkg-fifo-2" });
    await packages.assignPackage(c.id, p.id);
    const r = await packages.consumeTokens(c.id, p.id, 50, "claude-sonnet-4");
    expect(r.charged).toBe(0);
    expect(r.balanceDebitMicros).toBe(50);
  });

  it('models ["*"] matches any model', async () => {
    const p = await packages.createPackage({ ...PKG, name: "wildcard", tokens: 100, models: JSON.stringify(["*"]) });
    const c = await db.getOrCreateCustomer({ googleSub: "pkg-fifo-3" });
    await packages.assignPackage(c.id, p.id);
    const r = await packages.consumeTokens(c.id, p.id, 10, "anything-at-all");
    expect(r.charged).toBe(10);
    expect(r.balanceDebitMicros).toBe(0);
  });

  it("exhausted quota → remainder debits balance", async () => {
    const p = await packages.createPackage({ ...PKG, name: "small", tokens: 20 });
    const c = await db.getOrCreateCustomer({ googleSub: "pkg-fifo-4" });
    await packages.assignPackage(c.id, p.id);
    const r = await packages.consumeTokens(c.id, p.id, 50, "gpt-4o-mini");
    expect(r.charged).toBe(20);
    expect(r.balanceDebitMicros).toBe(30);
    const inst = (await packages.getCustomerPackages(c.id))[0];
    expect(inst.tokensUsed).toBe(20);
  });

  it("no instances at all → everything debits balance", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "pkg-fifo-5" });
    const r = await packages.consumeTokens(c.id, "some-pkg", 10, "gpt-4o-mini");
    expect(r.charged).toBe(0);
    expect(r.balanceDebitMicros).toBe(10);
  });
});

describe("packagesRepo — lazy expiry", () => {
  it("expired instance is skipped and flipped on access", async () => {
    const p = await packages.createPackage({ ...PKG, name: "dying", tokens: 100 });
    const c = await db.getOrCreateCustomer({ googleSub: "pkg-exp-1" });
    const inst = await packages.assignPackage(c.id, p.id);
    // force expiry into the past
    const { getAdapter } = await import("@/lib/db/driver.js");
    const dba = await getAdapter();
    dba.run(`UPDATE customerPackages SET expiresAt = ? WHERE id = ?`, ["2000-01-01T00:00:00Z", inst.id]);

    const active = await packages.getActivePackages(c.id, "gpt-4o-mini");
    expect(active.length).toBe(0);
    const row = (await packages.getCustomerPackages(c.id)).find((x) => x.id === inst.id);
    expect(row.status).toBe("expired");

    const r = await packages.consumeTokens(c.id, p.id, 10, "gpt-4o-mini");
    expect(r.charged).toBe(0);
    expect(r.balanceDebitMicros).toBe(10);
  });
});

describe("packagesRepo — package model routing", () => {
  it("resolvePackageModel: package model name → its combo members; comboId missing → null", async () => {
    const routing = await import("@/lib/billing/publicModelMap.js");
    const combosRepo = await import("@/lib/db/repos/combosRepo.js");
    const combo = await combosRepo.createCombo({
      name: "pkg-combo",
      models: ["ih/combo/glm-flash"],
    });
    const pkg = await packages.createPackage({
      name: "Paket Opus", tokens: 1000, models: ["opus"], comboId: combo.id,
    });
    const resolved = await routing.resolvePackageModel("opus");
    expect(resolved).not.toBeNull();
    expect(resolved.models).toEqual(["ih/combo/glm-flash"]);
    expect(resolved.publicName).toBe("opus");

    // No combo configured → falls back to publicModels only, returns null here
    const pkg2 = await packages.createPackage({
      name: "Paket Noname", tokens: 1000, models: ["mystery-model"], comboId: null,
    });
    expect(await routing.resolvePackageModel("mystery-model")).toBeNull();

    // Public model with same name still wins over packages (existing behavior)
    const pub = await import("@/lib/db/repos/publicModelsRepo.js");
    await pub.upsertPublicModel({ publicName: "both-name", comboId: combo.id });
    expect((await routing.resolvePublicModelRequest("both-name")).publicName).toBe("both-name");
  });
});

describe("packagesRepo — reverse map shows package model names", () => {
  it("resolvePublicModelName maps combo members to a package's model name", async () => {
    const routing = await import("@/lib/billing/publicModelMap.js");
    const combosRepo = await import("@/lib/db/repos/combosRepo.js");
    const combo = await combosRepo.createCombo({ name: "pkg-combo-2", models: ["ih/combo/other"] });
    await packages.createPackage({
      name: "Paket RevMap", tokens: 1000, models: ["my-pkg-model"], comboId: combo.id,
    });
    // Upstream form and bare form both map to the package's model name.
    expect(await routing.resolvePublicModelName("ih/combo/other")).toBe("my-pkg-model");
    expect(await routing.resolvePublicModelName("combo/other")).toBe("my-pkg-model");
  });
});

describe("packagesRepo — package covers its combo's public model name", () => {
  it("getActivePackages matches the public model bound to the package's combo", async () => {
    const routing = await import("@/lib/billing/publicModelMap.js");
    const combosRepo = await import("@/lib/db/repos/combosRepo.js");
    const pub = await import("@/lib/db/repos/publicModelsRepo.js");
    const combo = await combosRepo.createCombo({ name: "pkg-combo-3", models: ["oc/muse-free"] });
    await pub.upsertPublicModel({ publicName: "muse-public", comboId: combo.id });
    await packages.createPackage({
      name: "Paket ComboCover", tokens: 5000, models: ["my-alias"], comboId: combo.id,
    });
    const cust = await db.getOrCreateCustomer({ googleSub: `cover-${Date.now()}` });
    await packages.assignPackage(cust.id, (await packages.listPackages()).find(p => p.name === "Paket ComboCover").id);
    const actives = await packages.getActivePackages(cust.id, "muse-public");
    expect(actives.length).toBe(1);
  });
});

describe("packagesRepo — deletePackage", () => {
  it("refuses delete while an active instance exists; deletes after instances end", async () => {
    const p = await packages.createPackage({ ...PKG, name: "deletable" });
    const c = await db.getOrCreateCustomer({ googleSub: "pkg-del-1" });
    await packages.assignPackage(c.id, p.id);
    await expect(packages.deletePackage(p.id)).rejects.toThrow(/active or pending/i);

    // instance ends (revoked) → delete now succeeds
    const { getAdapter } = await import("@/lib/db/driver.js");
    (await getAdapter()).run(`UPDATE customerPackages SET status = 'revoked' WHERE packageId = ?`, [p.id]);
    await packages.deletePackage(p.id);
    expect(await packages.getPackageById(p.id)).toBeNull();
  });

  it("refuses delete while a pending (paid-awaiting) instance exists", async () => {
    const p = await packages.createPackage({ ...PKG, name: "deletable-pending" });
    const c = await db.getOrCreateCustomer({ googleSub: "pkg-del-2" });
    await packages.createPendingFromTopup({ customerId: c.id, packageId: p.id, topupId: `topup-del-${Date.now()}` });
    await expect(packages.deletePackage(p.id)).rejects.toThrow(/active or pending/i);
  });
});

describe("packagesRepo — group (variants)", () => {
  it("round-trips group and lists it on catalog rows", async () => {
    const a = await packages.createPackage({ ...PKG, name: "50M", group: "pkg/glm-5.3-flash" });
    const b = await packages.createPackage({ ...PKG, name: "100M", group: "pkg/glm-5.3-flash", tokens: 100_000_000 });
    const listed = await packages.listPackages();
    const rows = listed.filter((p) => p.group === "pkg/glm-5.3-flash");
    expect(rows.map((p) => p.name).sort()).toEqual(["100M", "50M"]);
    expect(a.group).toBe("pkg/glm-5.3-flash");
    // no group → null
    expect(await packages.createPackage({ ...PKG, name: "solo" })).toMatchObject({ group: null });
  });
});
