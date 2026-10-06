import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function rowToModel(row) {
  if (!row) return null;
  return {
    id: row.id,
    publicName: row.publicName,
    comboId: row.comboId,
    enabled: row.enabled === 1 || row.enabled === true,
    // Per-model discount override (0–1); null = use the global discountRate.
    discountRate: row.discountRate === null || row.discountRate === undefined ? null : Number(row.discountRate),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function validDiscount(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n < 1 ? n : undefined;
}

export async function upsertPublicModel({ publicName, comboId, enabled = true, discountRate }) {
  if (!publicName || !comboId) throw new Error("publicName and comboId are required");
  const db = await getAdapter();
  const now = new Date().toISOString();
  const existing = db.get(`SELECT id FROM publicModels WHERE publicName = ?`, [publicName]);
  // undefined = not provided → keep the stored override (enable/disable toggles
  // must not wipe it); null/"" = explicit clear; number = set.
  const rate = discountRate === undefined
    ? (existing?.discountRate ?? null)
    : validDiscount(discountRate);
  if (rate === undefined) throw new Error("discountRate must be a number between 0 and 1 (exclusive)");
  if (existing) {
    db.run(
      `UPDATE publicModels SET comboId = ?, enabled = ?, discountRate = ?, updatedAt = ? WHERE id = ?`,
      [comboId, enabled ? 1 : 0, rate, now, existing.id]
    );
    return rowToModel(db.get(`SELECT * FROM publicModels WHERE id = ?`, [existing.id]));
  }
  db.run(
    `INSERT INTO publicModels(id, publicName, comboId, enabled, discountRate, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), publicName, comboId, enabled ? 1 : 0, rate, now, now]
  );
  return rowToModel(db.get(`SELECT * FROM publicModels WHERE publicName = ?`, [publicName]));
}

export async function getPublicModelByName(name) {
  const db = await getAdapter();
  return rowToModel(db.get(`SELECT * FROM publicModels WHERE publicName = ?`, [name]));
}

export async function listPublicModels({ enabledOnly = true } = {}) {
  const db = await getAdapter();
  const rows = enabledOnly
    ? db.all(`SELECT * FROM publicModels WHERE enabled = 1 ORDER BY publicName ASC`)
    : db.all(`SELECT * FROM publicModels ORDER BY publicName ASC`);
  return rows.map(rowToModel);
}

export async function deletePublicModel(id) {
  const db = await getAdapter();
  db.run(`DELETE FROM publicModels WHERE id = ?`, [id]);
}
