import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function rowToEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    externalId: row.externalId,
    payload: row.payload ? JSON.parse(row.payload) : null,
    status: row.status,
    processError: row.processError || null,
    processedAt: row.processedAt || null,
    createdAt: row.createdAt,
  };
}

// Replay-safe insert: UNIQUE(source, externalId). A duplicate delivery leaves
// the original row untouched and reports created:false.
export async function recordWebhookEvent({ source, externalId, payload }) {
  if (!source || !externalId) throw new Error("source and externalId are required");
  const db = await getAdapter();
  const id = uuidv4();
  const createdAt = new Date().toISOString();
  const body = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
  db.run(
    `INSERT OR IGNORE INTO webhookEvents(id, source, externalId, payload, status, createdAt) VALUES(?, ?, ?, ?, 'unprocessed', ?)`,
    [id, source, externalId, body, createdAt]
  );
  const row = db.get(
    `SELECT * FROM webhookEvents WHERE source = ? AND externalId = ?`,
    [source, externalId]
  );
  // INSERT OR IGNORE keeps the original row's id on a duplicate — the id
  // comparison alone detects replay, no changes count needed.
  return { event: rowToEvent(row), created: row.id === id };
}

export async function markWebhookProcessed(id, { error } = {}) {
  const db = await getAdapter();
  const status = error ? "failed" : "processed";
  db.run(
    `UPDATE webhookEvents SET status = ?, processError = ?, processedAt = ? WHERE id = ?`,
    [status, error || null, new Date().toISOString(), id]
  );
}

export async function getUnprocessedWebhookEvents(source, { limit = 20 } = {}) {
  const db = await getAdapter();
  const lim = Math.min(Math.max(1, Number(limit) || 20), 200);
  return db.all(
    `SELECT * FROM webhookEvents WHERE source = ? AND status = 'unprocessed' ORDER BY createdAt ASC LIMIT ${lim}`,
    [source]
  ).map(rowToEvent);
}
