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
 * Compute the start ISO cutoff for a window or period range.
 * Supports limit windows ("total"|"daily"|"monthly") and lookup periods
 * ("today"|"7d"|"30d"|"all"). Returns null for unbounded ranges.
 */
function cutoffIsoFor(range) {
  const now = new Date();
  switch (range) {
    case "daily":
    case "today":
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    case "monthly":
      return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    case "7d":
      return new Date(now.getTime() - 7 * 86400000).toISOString();
    case "30d":
      return new Date(now.getTime() - 30 * 86400000).toISOString();
    case "total":
    case "all":
    default:
      return null;
  }
}

/**
 * Read the list of providers excluded from token counting (global setting).
 * @returns {Promise<string[]>}
 */
async function getExcludedProviders() {
  try {
    const { getSettings } = await import("./settingsRepo.js");
    const s = await getSettings();
    const list = s?.tokenLimitExcludedProviders;
    return Array.isArray(list) ? list.filter((p) => typeof p === "string" && p.trim()).map((p) => p.trim()) : [];
  } catch {
    return [];
  }
}

/**
 * Sum prompt + completion tokens consumed by an API key within the given window,
 * counting only usage at/after the manual reset marker (if any), and excluding
 * any providers configured to not count toward limits.
 * @param {string} key - the raw API key string (as stored in usageHistory.apiKey)
 * @param {"total"|"daily"|"monthly"} window
 * @param {string|null} resetAt - ISO timestamp of last manual reset (optional)
 * @param {string[]|null} excludeProviders - provider ids to exclude (loaded from settings if null)
 * @returns {Promise<number>}
 */
export async function getApiKeyUsedTokens(key, window = "monthly", resetAt = null, excludeProviders = null) {
  if (!key) return 0;
  const db = await getAdapter();
  const windowCutoff = cutoffIsoFor(window);

  // Effective cutoff = the later of window-start and manual-reset marker.
  let cutoff = windowCutoff;
  if (resetAt && (!cutoff || resetAt > cutoff)) cutoff = resetAt;

  const excluded = excludeProviders ?? (await getExcludedProviders());

  let sql = `SELECT COALESCE(SUM(promptTokens), 0) AS p, COALESCE(SUM(completionTokens), 0) AS c FROM usageHistory WHERE apiKey = ?`;
  const params = [key];
  if (cutoff) {
    sql += ` AND timestamp >= ?`;
    params.push(cutoff);
  }
  if (excluded.length) {
    sql += ` AND (provider IS NULL OR provider NOT IN (${excluded.map(() => "?").join(",")}))`;
    params.push(...excluded);
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
  const excluded = await getExcludedProviders();
  const used = await getApiKeyUsedTokens(key, window, resetAt, excluded);
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

/**
 * Public usage lookup by API key NAME (case-insensitive).
 * Returns usage info for every key matching the name WITHOUT exposing the
 * secret key string. Safe to surface on an unauthenticated page.
 * @param {string} name
 * @param {object} [opts]
 * @param {string|null} [opts.period] - detail period override: "today"|"7d"|"30d"|"all". Defaults to each key's limit window.
 * @returns {Promise<Array<object>>}
 */
export async function getUsageByKeyName(name, opts = {}) {
  if (!name || !name.trim()) return [];
  const period = opts.period || null;
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys WHERE name = ? COLLATE NOCASE ORDER BY createdAt ASC`, [name.trim()]);
  const keys = rows.map(rowToKey);

  const excluded = await getExcludedProviders();
  const out = [];
  for (const k of keys) {
    // Range used for the detailed breakdown + period total. Falls back to key window.
    const detailRange = period || k.limitWindow;

    const usedWindow = await getApiKeyUsedTokens(k.key, k.limitWindow, k.limitResetAt, excluded);
    const usedTotal = await getApiKeyUsedTokens(k.key, "total", k.limitResetAt, excluded);
    const usedPeriod = period
      ? await getApiKeyUsedTokens(k.key, detailRange, k.limitResetAt, excluded)
      : usedWindow;
    const models = await getApiKeyModelBreakdown(k.key, detailRange, k.limitResetAt, excluded);
    out.push({
      name: k.name,
      isActive: k.isActive,
      tokenLimit: k.tokenLimit,
      limitWindow: k.limitWindow,
      limitResetAt: k.limitResetAt,
      usedWindow,
      usedTotal,
      usedPeriod,
      period: period || null,
      detailRange,
      remaining: k.tokenLimit > 0 ? Math.max(0, k.tokenLimit - usedWindow) : null,
      exceeded: k.tokenLimit > 0 ? usedWindow >= k.tokenLimit : false,
      models,
      createdAt: k.createdAt,
    });
  }
  return out;
}

/**
 * Per-model token breakdown for an API key within a window (respecting reset + exclusions).
 * @returns {Promise<Array<{model:string, provider:string, requests:number, promptTokens:number, completionTokens:number, totalTokens:number}>>}
 */
export async function getApiKeyModelBreakdown(key, window = "monthly", resetAt = null, excludeProviders = null) {
  if (!key) return [];
  const db = await getAdapter();
  const windowCutoff = cutoffIsoFor(window);
  let cutoff = windowCutoff;
  if (resetAt && (!cutoff || resetAt > cutoff)) cutoff = resetAt;

  const excluded = excludeProviders ?? (await getExcludedProviders());

  let sql = `SELECT model, provider,
      COUNT(*) AS reqs,
      COALESCE(SUM(promptTokens), 0) AS p,
      COALESCE(SUM(completionTokens), 0) AS c
    FROM usageHistory WHERE apiKey = ?`;
  const params = [key];
  if (cutoff) {
    sql += ` AND timestamp >= ?`;
    params.push(cutoff);
  }
  if (excluded.length) {
    sql += ` AND (provider IS NULL OR provider NOT IN (${excluded.map(() => "?").join(",")}))`;
    params.push(...excluded);
  }
  sql += ` GROUP BY model, provider ORDER BY (p + c) DESC`;

  const rows = db.all(sql, params);
  return rows.map((r) => ({
    model: r.model || "unknown",
    provider: r.provider || "",
    requests: Number(r.reqs) || 0,
    promptTokens: Number(r.p) || 0,
    completionTokens: Number(r.c) || 0,
    totalTokens: (Number(r.p) || 0) + (Number(r.c) || 0),
  }));
}
