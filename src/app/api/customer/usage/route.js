import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { requireCustomerSession } from "@/lib/auth/customerSession.js";
import { getAdapter } from "@/lib/db/driver.js";
import { getActiveKeyForCustomer } from "@/lib/db/repos/customerKeysRepo.js";

export const dynamic = "force-dynamic";

// GET /api/customer/usage?period=today|7d|30d|all
// Session-gated usage history scoped to the caller's active customer key:
// usageHistory rows store the presented plaintext apiKey; we match it against
// this customer's keyHash (same HMAC scheme as customerKeysRepo).
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

function hashKey(plaintext) {
  const secret = process.env.API_KEY_SECRET || "endpoint-proxy-api-key-secret";
  return crypto.createHmac("sha256", secret).update(plaintext).digest("hex");
}

export async function GET(request) {
  const session = await requireCustomerSession(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const active = await getActiveKeyForCustomer(session.customerId);
  if (!active) return NextResponse.json({ items: [] });

  const url = new URL(request.url);
  const period = PERIODS[url.searchParams.get("period")] ? url.searchParams.get("period") : "all";
  const startDate = PERIODS[period]?.();

  // usageHistory stores the presented plaintext apiKey per request. Pull the
  // recent window raw, hash-match in memory against this customer's keyHash,
  // and drop the plaintext column before mapping — it never reaches the
  // response. ponytail: scan capped at 1000 latest rows per query; if volume
  // makes that wrong, add a keyHash column + index to usageHistory (phase 6)
  // and move the filter into SQL.
  const db = await getAdapter();
  const rows = db.all(
    `SELECT timestamp, provider, model, promptTokens, completionTokens, cost, status, apiKey
     FROM usageHistory WHERE timestamp >= COALESCE(?, '1970-01-01')
     ORDER BY id DESC LIMIT 1000`,
    [startDate ? startDate.toISOString() : null]
  );
  const keyHash = active.keyHash;
  const items = rows
    // Rows written without a presented key (admin/panel traffic) have NULL
    // apiKey and can never match a customer key — skip instead of crashing.
    .filter((r) => r.apiKey && hashKey(r.apiKey) === keyHash)
    .slice(0, 100)
    .map((r) => ({
      timestamp: r.timestamp,
      provider: r.provider,
      model: r.model,
      promptTokens: r.promptTokens ?? 0,
      completionTokens: r.completionTokens ?? 0,
      cost: r.cost,
      status: r.status,
      mask: active.keyMask,
    }));

  // Totals for the "official vs what you paid" view: official cost comes from
  // the usage stats above; the actual charged amount is the customer's
  // usage_debit ledger entries in the same window (integer micro-USD).
  const chargedRows = db.all(
    `SELECT amountMicros FROM ledger
      WHERE customerId = ? AND type = 'usage_debit' AND createdAt >= COALESCE(?, '1970-01-01')`,
    [session.customerId, startDate ? startDate.toISOString() : null]
  );
  const officialMicros = Math.round(items.reduce((s, r) => s + (Number(r.cost) || 0) * 1_000_000, 0));
  const chargedMicros = -chargedRows.reduce((s, r) => s + Number(r.amountMicros), 0); // debits are negative
  return NextResponse.json(
    { items, totals: { officialMicros, chargedMicros, savedMicros: Math.max(0, officialMicros - chargedMicros) } },
    { headers: { "Cache-Control": "no-store" } },
  );
}
