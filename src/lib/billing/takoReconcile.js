// Tako reconciliation worker (spec §3.3): the callback fires once with no
// retry, so any topup that goes paid without a webhook (or whose credit
// failed) is recovered by polling Tako's transaction endpoint. Run on demand
// from the admin API; uses the exact same applyTopupCredit path as the
// webhook so a replay can never double-credit.
import { getAdapter } from "@/lib/db/driver.js";
import { applyTopupCredit } from "@/lib/db/repos/topupsRepo.js";

const TAKO_TXN_URL = (txnId) => `https://tako.id/api/v1/transactions/${encodeURIComponent(txnId)}`;

// Fetch one transaction's status from Tako. Returns "paid" | <other-string> | null.
async function fetchTakoStatus(txnId) {
  const merchantKey = (process.env.TAKO_MERCHANT_KEY || "").trim();
  if (!merchantKey) return null;
  try {
    const res = await fetch(TAKO_TXN_URL(txnId), {
      headers: {
        Authorization: `Bearer ${merchantKey}`,
        "User-Agent": "9router/1.0",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const status = body?.status ?? body?.data?.status;
    return typeof status === "string" ? status.toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function runTakoReconciliation({ olderThanMinutes = 5, limit = 50 } = {}) {
  const db = await getAdapter();
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  const stuck = db
    .all(
      `SELECT * FROM topups
       WHERE status = 'pending' AND takoTxnId IS NOT NULL AND createdAt <= ?
       ORDER BY createdAt ASC LIMIT ?`,
      [cutoff, Math.min(Math.max(1, limit), 200)]
    )
    .map((r) => ({ takoTxnId: r.takoTxnId, status: r.status }));

  let credited = 0;
  const results = [];
  for (const row of stuck) {
    const status = await fetchTakoStatus(row.takoTxnId);
    if (status === "paid") {
      const outcome = await applyTopupCredit(row.takoTxnId);
      if (outcome.credited) credited += 1;
      results.push({ takoTxnId: row.takoTxnId, takoStatus: status, credited: outcome.credited, reason: outcome.reason });
    } else {
      results.push({ takoTxnId: row.takoTxnId, takoStatus: status, credited: false });
    }
  }
  return { checked: stuck.length, credited, results };
}
