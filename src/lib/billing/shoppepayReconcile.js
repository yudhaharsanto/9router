// ShopeePay top-up settlement. The gateway has no callbacks, so every pending
// topup is settled by polling POST /check-payment. Two callers share this:
//   - GET /api/customer/topups?sync=1 — while a checkout page is open
//   - GET /api/admin/reconciliation/shoppepay — manual sweep for missed ones
// Both go through claimTopupTransaction + applyTopupCredit, so a replay can
// never double-credit.
//
// ponytail: 30-minute poll window. The QR expires in 15 minutes, so any real
// payment lands inside it; a wider window would let /check-payment (which
// matches on amount only) claim an unrelated payment of the same amount.
// Older rows stay pending for the admin to settle manually.
import { shoppepayConfig, checkPayment } from "./shoppepay.js";
import { listPendingTopups, claimTopupTransaction, applyTopupCredit } from "@/lib/db/repos/topupsRepo.js";

export const POLL_WINDOW_MINUTES = 30;

export async function syncPendingTopups({ customerId = null, limit = 20, maxAgeMinutes = POLL_WINDOW_MINUTES } = {}) {
  const config = await shoppepayConfig();
  if (!config) return { checked: 0, credited: 0, results: [], reason: "not-configured" };

  const sinceIso = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString();
  const pending = await listPendingTopups({ customerId, sinceIso, limit });

  let credited = 0;
  const results = [];
  for (const row of pending) {
    try {
      const check = await checkPayment(config, {
        amountIdr: row.amountIdr,
        startTime: Math.floor(Date.parse(row.createdAt) / 1000),
      });
      if (!check.paid) {
        results.push({ id: row.id, paid: false });
        continue;
      }
      if (!(await claimTopupTransaction(row.id, check.transactionId))) {
        // Same payment already claimed by another topup of equal amount.
        results.push({ id: row.id, paid: true, claimed: false });
        continue;
      }
      const outcome = await applyTopupCredit(check.transactionId);
      if (outcome.credited) credited += 1;
      results.push({ id: row.id, paid: true, claimed: true, credited: outcome.credited, reason: outcome.reason });
    } catch (err) {
      results.push({ id: row.id, error: String(err?.message || err) });
    }
  }
  return { checked: pending.length, credited, results };
}
