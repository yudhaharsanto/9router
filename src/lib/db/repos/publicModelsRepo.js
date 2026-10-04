import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function rowToModel(row) {
  if (!row) return null;
  return {
    id: row.id,
    publicName: row.publicName,
    comboId: row.comboId,
    enabled: row.enabled === 1 || row.enabled === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function upsertPublicModel({ publicName, comboId, enabled = true }) {
  if (!publicName || !comboId) throw new Error("publicName and comboId are required");
  const db = await getAdapter();
  const now = new Date().toISOString();
  const existing = db.get(`SELECT id FROM publicModels WHERE publicName = ?`, [publicName]);
  if (existing) {
    db.run(
      `UPDATE publicModels SET comboId = ?, enabled = ?, updatedAt = ? WHERE id = ?`,
      [comboId, enabled ? 1 : 0, now, existing.id]
    );
    return rowToModel(db.get(`SELECT * FROM publicModels WHERE id = ?`, [existing.id]));
  }
  db.run(
    `INSERT INTO publicModels(id, publicName, comboId, enabled, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
    [uuidv4(), publicName, comboId, enabled ? 1 : 0, now, now]
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
