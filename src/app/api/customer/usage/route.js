import { NextResponse } from "next/server";
import { requireCustomerSession } from "@/lib/auth/customerSession.js";
import { getAdapter } from "@/lib/db/driver.js";
import { getActiveKeyForCustomer } from "@/lib/db/repos/customerKeysRepo.js";
import { resolvePublicModelName } from "@/lib/billing/publicModelMap.js";
import { listPublicModels } from "@/lib/db/repos/publicModelsRepo.js";

export const dynamic = "force-dynamic";

// GET /api/customer/usage?period=today|7d|30d|all&billing=all|balance|package
// Session-gated usage history scoped to the caller's active customer key via
// usageHistory.keyHash (written at save time; same HMAC as customerKeysRepo).
const PERIODS = {
  today: () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  },
  "7d": () => new Date(Date.now() - 7 * 864e5),
  "30d": () => new Date(Date.now() - 30 * 864e5),
  all: () => null,
};

export async function GET(request) {
  const session = await requireCustomerSession(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const active = await getActiveKeyForCustomer(session.customerId);
  if (!active) return NextResponse.json({ items: [] });

  const url = new URL(request.url);
  const periodParam = url.searchParams.get("period");
  // hasOwnProperty guard: a bare lookup matches Object.prototype keys
  // ("constructor" etc. are functions too) → startDate = {} → 500 on toISOString.
  const period = Object.hasOwn(PERIODS, periodParam) ? periodParam : "all";
  const startDate = PERIODS[period]?.();
  // billing=balance rows carry meta.holdRefId (ledger-joined); anything else
  // only passes billing=all.
  const billingParam = url.searchParams.get("billing");
  const billing = billingParam === "balance" ? billingParam : "all";

  // usageHistory carries keyHash (written at save time, backfilled by
  // migration 004) — the per-customer filter is an indexed lookup in SQL, no
  // plaintext key or row cap involved.
  const db = await getAdapter();
  const rows = db.all(
    `SELECT timestamp, provider, model, promptTokens, completionTokens, cost, status, tokens, meta
     FROM usageHistory WHERE keyHash = ? AND timestamp >= COALESCE(?, '1970-01-01')
     ORDER BY id DESC LIMIT 1000`,
    [active.keyHash, startDate ? startDate.toISOString() : null]
  );
  const keyHash = active.keyHash;
  // The actual amount billed per request lives in the customer's ledger
  // (usage_debit, refId = holdRefId). usageHistory.meta records that holdRefId
  // for customer traffic (set by saveUsageStats), so join per-request charges
  // on it — the "cost" column is the official catalog estimate, not what the
  // customer was charged.
  const debitRows = db.all(
    `SELECT refId, amountMicros, meta FROM ledger
      WHERE customerId = ? AND type = 'usage_debit' AND createdAt >= COALESCE(?, '1970-01-01')`,
    [session.customerId, startDate ? startDate.toISOString() : null]
  ).map((d) => ({
    refId: d.refId,
    amountMicros: Number(d.amountMicros),
    officialCostMicros: (() => { try { return JSON.parse(d.meta || "{}").officialCostMicros; } catch { return null; } })(),
  }));
  const chargedByHoldRef = new Map(debitRows.map((d) => [d.refId, -Number(d.amountMicros)]));
  // Official (pre-discount) price per request: the ledger debit's
  // meta.officialCostMicros is what settleCustomerUsage computed from the
  // public model's admin-entered official rates — the right "before discount"
  // side. Falls back to the usageHistory catalog estimate when absent.
  const officialByHoldRef = new Map(
    debitRows.map((d) => [d.refId, Number(d.officialCostMicros) || null])
  );
  const parseMeta = (raw) => {
    try { return JSON.parse(raw || "{}") || {}; } catch { return {}; }
  };
  const parseTokens = parseMeta;
  // Published-model view: usageHistory records the upstream model name (combo
  // members etc.), but the customer only knows public names. Map each distinct
  // model to its published public name; rows whose model belongs to no enabled
  // public combo are dropped so internal model names never surface. When the
  // admin has published nothing, rows pass through unmapped rather than
  // blanking the whole history.
  const modelMap = new Map();
  const publishedAnything = (await listPublicModels({ enabledOnly: true })).length > 0;
  if (publishedAnything) {
    for (const model of new Set(rows.map((r) => r.model).filter(Boolean))) {
      const pub = await resolvePublicModelName(model);
      modelMap.set(model, pub || null);
    }
  }
  const items = rows
    .filter((r) => !publishedAnything || modelMap.get(r.model))
    .filter((r) => (billing === "balance" ? !!parseMeta(r.meta).holdRefId : true))
    .slice(0, 500)
    .map((r) => ({
      timestamp: r.timestamp,
      provider: r.provider,
      model: modelMap.get(r.model) || r.model,
      promptTokens: r.promptTokens ?? 0,
      completionTokens: r.completionTokens ?? 0,
      cachedTokens: (parseTokens(r.tokens).cached_tokens ?? parseTokens(r.tokens).cache_read_input_tokens ?? 0) || 0,
      cacheCreationTokens: parseTokens(r.tokens).cache_creation_input_tokens || 0,
      cost: r.cost,
      chargedMicros: chargedByHoldRef.get(parseMeta(r.meta).holdRefId) ?? null,
      officialMicros: officialByHoldRef.get(parseMeta(r.meta).holdRefId) || Math.round((Number(r.cost) || 0) * 1_000_000) || null,
      status: r.status,
      mask: active.keyMask,
    }));

  // Totals over the whole period window, not just the rows shown in the list —
  // the list caps at 500 rows but requests/tokens/charged must reflect the
  // entire period (SQLite sums, no row iteration cost).
  const agg = db.get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(promptTokens),0) AS inT, COALESCE(SUM(completionTokens),0) AS outT
     FROM usageHistory WHERE keyHash = ? AND timestamp >= COALESCE(?, '1970-01-01')`,
    [active.keyHash, startDate ? startDate.toISOString() : null]
  );
  // Per-request charged/official still come from the debit join below, but over
  // ALL debit rows in the window (not just displayed rows).
  const officialMicros = debitRows.reduce((s, d) => s + (Number(d.officialCostMicros) || 0), 0);
  const chargedMicros = debitRows.reduce((s, d) => s + -Number(d.amountMicros), 0);
  const totalRequests = agg.n;
  const totalPromptTokens = agg.inT;
  const totalCompletionTokens = agg.outT;
  const totalCachedTokens = items.reduce((s, r) => s + (Number(r.cachedTokens) || 0), 0);
  const totalCacheCreationTokens = items.reduce((s, r) => s + (Number(r.cacheCreationTokens) || 0), 0);
  return NextResponse.json(
    {
      items,
      totals: {
        officialMicros, chargedMicros, savedMicros: Math.max(0, officialMicros - chargedMicros),
        totalRequests, totalPromptTokens, totalCompletionTokens, totalCachedTokens, totalCacheCreationTokens,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
