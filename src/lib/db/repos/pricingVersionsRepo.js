import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

const DEFAULT_DISCOUNT_BPS = 5000;

function deriveSell(officialMicros, discountBps) {
  return Math.round((officialMicros * (10_000 - discountBps)) / 10_000);
}

function rowToVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    modelId: row.modelId,
    officialInputMicros: Number(row.officialInputMicros),
    officialOutputMicros: Number(row.officialOutputMicros),
    discountBps: Number(row.discountBps),
    sellInputMicros: Number(row.sellInputMicros),
    sellOutputMicros: Number(row.sellOutputMicros),
    effectiveFrom: row.effectiveFrom,
    source: row.source || null,
    createdAt: row.createdAt,
  };
}

// Upsert keyed on (modelId, effectiveFrom) — re-pricing the same effective
// date updates in place; a new effective date starts a new version.
export async function upsertPricingVersion({
  modelId, officialInputMicros, officialOutputMicros,
  discountBps = DEFAULT_DISCOUNT_BPS, effectiveFrom, source,
}) {
  if (!modelId) throw new Error("modelId is required");
  if (!effectiveFrom) throw new Error("effectiveFrom is required");
  const officialIn = Math.round(Number(officialInputMicros));
  const officialOut = Math.round(Number(officialOutputMicros));
  if (!Number.isFinite(officialIn) || officialIn < 0 || !Number.isFinite(officialOut) || officialOut < 0) {
    throw new Error("official prices must be non-negative integers (micro-USD)");
  }
  const bps = Math.min(Math.max(0, Math.round(Number(discountBps))), 10000);
  const db = await getAdapter();
  const existing = db.get(
    `SELECT id FROM pricingVersions WHERE modelId = ? AND effectiveFrom = ?`,
    [modelId, effectiveFrom]
  );
  const sellIn = deriveSell(officialIn, bps);
  const sellOut = deriveSell(officialOut, bps);
  if (existing) {
    db.run(
      `UPDATE pricingVersions SET officialInputMicros = ?, officialOutputMicros = ?, discountBps = ?, sellInputMicros = ?, sellOutputMicros = ?, source = ? WHERE id = ?`,
      [officialIn, officialOut, bps, sellIn, sellOut, source || null, existing.id]
    );
    return rowToVersion(db.get(`SELECT * FROM pricingVersions WHERE id = ?`, [existing.id]));
  }
  db.run(
    `INSERT INTO pricingVersions(id, modelId, officialInputMicros, officialOutputMicros, discountBps, sellInputMicros, sellOutputMicros, effectiveFrom, source, createdAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), modelId, officialIn, officialOut, bps, sellIn, sellOut, effectiveFrom, source || null, new Date().toISOString()]
  );
  return rowToVersion(db.get(
    `SELECT * FROM pricingVersions WHERE modelId = ? AND effectiveFrom = ?`,
    [modelId, effectiveFrom]
  ));
}

export async function getActivePricing(modelId, { at } = {}) {
  const db = await getAdapter();
  const atIso = at || new Date().toISOString();
  return rowToVersion(db.get(
    `SELECT * FROM pricingVersions WHERE modelId = ? AND effectiveFrom <= ? ORDER BY effectiveFrom DESC LIMIT 1`,
    [modelId, atIso]
  ));
}

export async function listPricingVersions(modelId) {
  const db = await getAdapter();
  return db.all(
    `SELECT * FROM pricingVersions WHERE modelId = ? ORDER BY effectiveFrom DESC`,
    [modelId]
  ).map(rowToVersion);
}

// charge µ$ = inputTokens/1M × sellIn + outputTokens/1M × sellOut, integer math.
export function computeChargeMicros({ pricing, inputTokens, outputTokens }) {
  const inTok = Math.max(0, Math.round(Number(inputTokens) || 0));
  const outTok = Math.max(0, Math.round(Number(outputTokens) || 0));
  return Math.round((inTok / 1_000_000) * pricing.sellInputMicros + (outTok / 1_000_000) * pricing.sellOutputMicros);
}
