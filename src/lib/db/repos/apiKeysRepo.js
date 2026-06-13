import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

const VALID_WINDOWS = ["total", "daily", "monthly"];

function normalizeWindow(w) {
  return VALID_WINDOWS.includes(w) ? w : "monthly";
}

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    tokenLimit: Number(row.tokenLimit) || 0,
    limitWindow: normalizeWindow(row.limitWindow),
    limitResetAt: row.limitResetAt || null,
    createdAt: row.createdAt,
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId, options = {}) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const tokenLimit = Math.max(0, Number(options.tokenLimit) || 0);
  const limitWindow = normalizeWindow(options.limitWindow);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    tokenLimit,
    limitWindow,
    createdAt: new Date().toISOString(),
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, tokenLimit, limitWindow, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, tokenLimit, limitWindow, apiKey.createdAt]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    merged.tokenLimit = Math.max(0, Number(merged.tokenLimit) || 0);
    merged.limitWindow = normalizeWindow(merged.limitWindow);
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, tokenLimit = ?, limitWindow = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, merged.tokenLimit, merged.limitWindow, id]
    );
    result = merged;
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}

/**
 * Compute the start-of-window ISO cutoff for a limit window.
 * Returns null for "total" (no time bound).
 */
function windowCutoffIso(window) {
  const now = new Date();
  if (window === "daily") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  }
  if (window === "monthly") {
    return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  }
  return null; // total
}

/**
 * Sum prompt + completion tokens consumed by an API key within the given window,
 * counting only usage at/after the manual reset marker (if any).
 * @param {string} key - the raw API key string (as stored in usageHistory.apiKey)
 * @param {"total"|"daily"|"monthly"} window
 * @param {string|null} resetAt - ISO timestamp of last manual reset (optional)
 * @returns {Promise<number>}
 */
export async function getApiKeyUsedTokens(key, window = "monthly", resetAt = null) {
  if (!key) return 0;
  const db = await getAdapter();
  const windowCutoff = windowCutoffIso(normalizeWindow(window));

  // Effective cutoff = the later of window-start and manual-reset marker.
  let cutoff = windowCutoff;
  if (resetAt && (!cutoff || resetAt > cutoff)) cutoff = resetAt;

  let sql = `SELECT COALESCE(SUM(promptTokens), 0) AS p, COALESCE(SUM(completionTokens), 0) AS c FROM usageHistory WHERE apiKey = ?`;
  const params = [key];
  if (cutoff) {
    sql += ` AND timestamp >= ?`;
    params.push(cutoff);
  }
  const row = db.get(sql, params);
  return (Number(row?.p) || 0) + (Number(row?.c) || 0);
}

/**
 * Resolve the current limit status for an API key.
 * @param {string} key - raw API key string
 * @returns {Promise<{exists:boolean, hasLimit:boolean, exceeded:boolean, limit:number, used:number, remaining:number, window:string, resetAt:string|null}>}
 */
export async function getApiKeyLimitStatus(key) {
  const base = { exists: false, hasLimit: false, exceeded: false, limit: 0, used: 0, remaining: 0, window: "monthly", resetAt: null };
  if (!key) return base;
  const db = await getAdapter();
  const row = db.get(`SELECT tokenLimit, limitWindow, limitResetAt FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return base;

  const limit = Number(row.tokenLimit) || 0;
  const window = normalizeWindow(row.limitWindow);
  const resetAt = row.limitResetAt || null;
  if (limit <= 0) {
    return { ...base, exists: true, window, resetAt };
  }
  const used = await getApiKeyUsedTokens(key, window, resetAt);
  return {
    exists: true,
    hasLimit: true,
    exceeded: used >= limit,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    window,
    resetAt,
  };
}

/**
 * Manually reset an API key's token usage counter.
 * Non-destructive: sets a reset marker so prior usage is no longer counted,
 * leaving usageHistory intact for analytics.
 * @param {string} id - apiKeys.id
 * @returns {Promise<{id:string, limitResetAt:string} | null>}
 */
export async function resetApiKeyLimit(id) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const res = db.run(`UPDATE apiKeys SET limitResetAt = ? WHERE id = ?`, [now, id]);
  if ((res?.changes ?? 0) === 0) return null;
  return { id, limitResetAt: now };
}
