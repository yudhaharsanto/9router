import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

// Token packages: admin-managed catalog (tokenPackages) + per-customer
// instances (customerPackages). A package covers a set of public model names
// (["*"] = all); usage against a covered model consumes quota FIFO (oldest
// active instance first) instead of debiting the customer's µ$ balance.

function nowIso() {
  return new Date().toISOString();
}

function rowToPackage(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    tokens: Number(row.tokens),
    priceIdr: Number(row.priceIdr),
    models: row.models,
    comboId: row.comboId || null,
    durationDays: Number(row.durationDays),
    active: !!Number(row.active),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToInstance(row) {
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customerId,
    packageId: row.packageId,
    topupId: row.topupId || null,
    tokensGranted: Number(row.tokensGranted),
    tokensUsed: Number(row.tokensUsed),
    status: row.status,
    activatedAt: row.activatedAt || null,
    expiresAt: row.expiresAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function computeExpiresAt(activatedAt, durationDays) {
  const days = Number(durationDays) || 0;
  if (days <= 0) return null;
  return new Date(new Date(activatedAt).getTime() + days * 86_400_000).toISOString();
}

// ─── Catalog ────────────────────────────────────────────────────────────────

export function normalizeModels(models) {
  if (typeof models === "string") {
    try { models = JSON.parse(models) || []; } catch { models = []; }
  }
  return JSON.stringify(Array.isArray(models) && models.length ? models : ["*"]);
}

export async function createPackage({ name, tokens, priceIdr = 0, models = ["*"], comboId = null, durationDays = 0 }) {
  if (!name || !Number.isInteger(tokens) || tokens <= 0) {
    throw new Error("package requires a name and a positive integer token amount");
  }
  const db = await getAdapter();
  const now = nowIso();
  const pkg = {
    id: uuidv4(), name, tokens,
    priceIdr: Number(priceIdr) || 0,
    models: normalizeModels(models),
    comboId: comboId || null,
    durationDays: Number(durationDays) || 0,
    active: 1, createdAt: now, updatedAt: now,
  };
  db.run(
    `INSERT INTO tokenPackages(id, name, tokens, priceIdr, models, comboId, durationDays, active, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [pkg.id, pkg.name, pkg.tokens, pkg.priceIdr, pkg.models, pkg.comboId, pkg.durationDays, pkg.active, pkg.createdAt, pkg.updatedAt]
  );
  return rowToPackage(pkg);
}

export async function updatePackage(id, patch = {}) {
  const db = await getAdapter();
  const fields = [];
  const params = [];
  for (const key of ["name", "tokens", "priceIdr", "models", "comboId", "durationDays", "active"]) {
    if (key in patch) {
      fields.push(`${key} = ?`);
      let v = patch[key];
      if (key === "models") v = normalizeModels(v);
      if (key === "active") v = v ? 1 : 0;
      params.push(v);
    }
  }
  if (!fields.length) return getPackageById(id);
  fields.push(`updatedAt = ?`);
  params.push(nowIso(), id);
  db.run(`UPDATE tokenPackages SET ${fields.join(", ")} WHERE id = ?`, params);
  return getPackageById(id);
}

export async function listPackages({ activeOnly = false } = {}) {
  const db = await getAdapter();
  const rows = activeOnly
    ? db.all(`SELECT * FROM tokenPackages WHERE active = 1 ORDER BY createdAt ASC`)
    : db.all(`SELECT * FROM tokenPackages ORDER BY createdAt ASC`);
  return rows.map(rowToPackage);
}

export async function getPackageById(id) {
  const db = await getAdapter();
  return rowToPackage(db.get(`SELECT * FROM tokenPackages WHERE id = ?`, [id]));
}

// ─── Instances ──────────────────────────────────────────────────────────────

export async function assignPackage(customerId, packageId) {
  const pkg = await getPackageById(packageId);
  if (!pkg || !pkg.active) throw new Error(`package ${packageId} not found or inactive`);
  return activateInstance({ customerId, packageId });
}

// Direct activation (admin assign). Grants snapshot from the catalog now.
async function activateInstance({ customerId, packageId, topupId = null }) {
  const pkg = await getPackageById(packageId);
  if (!pkg) throw new Error(`package ${packageId} not found`);
  const db = await getAdapter();
  const now = nowIso();
  const inst = {
    id: uuidv4(), customerId, packageId, topupId,
    tokensGranted: pkg.tokens, tokensUsed: 0, status: "active",
    activatedAt: now, expiresAt: computeExpiresAt(now, pkg.durationDays),
    createdAt: now, updatedAt: now,
  };
  db.run(
    `INSERT INTO customerPackages(id, customerId, packageId, topupId, tokensGranted, tokensUsed, status, activatedAt, expiresAt, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [inst.id, inst.customerId, inst.packageId, inst.topupId, inst.tokensGranted, inst.tokensUsed, inst.status, inst.activatedAt, inst.expiresAt, inst.createdAt, inst.updatedAt]
  );
  return inst;
}

// Purchase path: create a pending instance tied to a topup row; activation
// (grant snapshot + expiry) happens when the topup goes paid.
export async function createPendingFromTopup({ customerId, packageId, topupId }) {
  const pkg = await getPackageById(packageId);
  if (!pkg || !pkg.active) throw new Error(`package ${packageId} not found or inactive`);
  const db = await getAdapter();
  const now = nowIso();
  const inst = {
    id: uuidv4(), customerId, packageId, topupId,
    tokensGranted: 0, tokensUsed: 0, status: "pending",
    activatedAt: null, expiresAt: null, createdAt: now, updatedAt: now,
  };
  db.run(
    `INSERT INTO customerPackages(id, customerId, packageId, topupId, tokensGranted, tokensUsed, status, activatedAt, expiresAt, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
    [inst.id, inst.customerId, inst.packageId, inst.topupId, inst.tokensGranted, inst.tokensUsed, inst.createdAt, inst.updatedAt]
  );
  return inst;
}

// Called from the topup-paid path (webhook / reconcile). Idempotent: only a
// pending instance flips; replays return { ok:false, reason } without mutation.
export async function activateFromTopup(topupId) {
  if (!topupId) return { ok: false, reason: "not-found" };
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM customerPackages WHERE topupId = ? AND status = 'pending' LIMIT 1`, [topupId]);
  if (!row) return { ok: false, reason: "not-found" };
  const pkg = await getPackageById(row.packageId);
  if (!pkg) return { ok: false, reason: "package-gone" };
  const now = nowIso();
  db.run(
    `UPDATE customerPackages SET tokensGranted = ?, status = 'active', activatedAt = ?, expiresAt = ?, updatedAt = ? WHERE id = ?`,
    [pkg.tokens, now, computeExpiresAt(now, pkg.durationDays), now, row.id]
  );
  return { ok: true, instance: rowToInstance({ ...row, tokensGranted: pkg.tokens, status: "active", activatedAt: now, expiresAt: computeExpiresAt(now, pkg.durationDays), updatedAt: now }) };
}

// Lazy expiry: flip active instances whose expiresAt passed. Called before any
// read that depends on liveness — no cron needed.
function expireOverdue(db) {
  db.run(`UPDATE customerPackages SET status = 'expired', updatedAt = ? WHERE status = 'active' AND expiresAt IS NOT NULL AND expiresAt < ?`, [nowIso(), nowIso()]);
}

export async function listCustomerPackages(customerId) {
  const db = await getAdapter();
  expireOverdue(db);
  return db.all(`SELECT * FROM customerPackages WHERE customerId = ? ORDER BY createdAt ASC`, [customerId]).map(rowToInstance);
}

export async function getCustomerPackages(customerId) {
  return listCustomerPackages(customerId);
}

// Active instances covering the model, FIFO order (oldest activation first).
// A package covers either an explicit name in its models[] OR any public
// model bound to the package's combo (the admin picks a combo; every public
// name published from it is in scope, e.g. package "opus" → muse combo →
// "muse-spark-1.3-contributor" requests consume the package).
export async function getActivePackages(customerId, model) {
  const db = await getAdapter();
  expireOverdue(db);
  const rows = db.all(
    `SELECT * FROM customerPackages WHERE customerId = ? AND status = 'active' ORDER BY activatedAt ASC, rowid ASC`,
    [customerId]
  ).map(rowToInstance);
  if (!rows.length) return [];
  const covered = await Promise.all(rows.map(async (inst) => {
    const pkg = await getPackageById(inst.packageId);
    if (!pkg || !pkg.active) return null;
    let models = [];
    try { models = JSON.parse(pkg.models) || []; } catch { models = []; }
    if (!models.includes("*") && !models.includes(model)) {
      // Combo-scoped coverage: does the model resolve to a public model whose
      // comboId is the package's combo?
      let matchesViaCombo = false;
      if (pkg.comboId) {
        try {
          const { getPublicModelByName } = await import("./publicModelsRepo.js");
          const pub = await getPublicModelByName(model);
          matchesViaCombo = !!pub && pub.comboId === pkg.comboId;
        } catch { /* fall through as not covered */ }
      }
      if (!matchesViaCombo) return null;
    }
    return { ...inst, remaining: inst.tokensGranted - inst.tokensUsed };
  }));
  return covered.filter((x) => x && x.remaining > 0);
}

// Consume n tokens FIFO across active instances covering the model. Returns
// how many tokens the packages absorbed and how many µ$ should be debited
// from balance for the remainder (0 when fully covered).
export async function consumeTokens(customerId, packageId, tokens, model) {
  const n = Math.max(0, Math.round(Number(tokens) || 0));
  if (n === 0) return { charged: 0, balanceDebitMicros: n };
  const actives = await getActivePackages(customerId, model);
  const covered = actives.filter((a) => (packageId ? a.packageId === packageId : true));
  const use = covered.length ? covered : actives;
  if (!use.length) return { charged: 0, balanceDebitMicros: n };
  const db = await getAdapter();
  let remaining = n;
  let charged = 0;
  for (const inst of use) {
    if (remaining <= 0) break;
    const take = Math.min(inst.remaining, remaining);
    if (take <= 0) continue;
    db.run(
      `UPDATE customerPackages SET tokensUsed = tokensUsed + ?, updatedAt = ? WHERE id = ?`,
      [take, nowIso(), inst.id]
    );
    charged += take;
    remaining -= take;
  }
  return { charged, balanceDebitMicros: remaining };
}
