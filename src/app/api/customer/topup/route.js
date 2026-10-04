import { NextResponse } from "next/server";
import { requireCustomerSession } from "@/lib/auth/customerSession.js";
import { createTopup, setTopupPayment, computeCreditedMicros } from "@/lib/db/repos/topupsRepo.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";

export const dynamic = "force-dynamic";

// POST /api/customer/topup { amountIdr } — session-gated Tako top-up creation
// (spec §3.3). Rate snapshot comes from settings (idrPerUsd); without a valid
// rate creation is blocked — never guess. The merchant key is server-only.
const TAKO_TOPUP_URL = (username) => `https://tako.id/api/v1/topup/${encodeURIComponent(username)}`;
const ALLOWED_AMOUNTS_IDR = [10_000, 20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000];

export async function POST(request) {
  const session = await requireCustomerSession(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const amountIdr = Number(body?.amountIdr);
  if (!Number.isInteger(amountIdr) || !ALLOWED_AMOUNTS_IDR.includes(amountIdr)) {
    return NextResponse.json(
      { error: `amountIdr must be one of: ${ALLOWED_AMOUNTS_IDR.join(", ")}` },
      { status: 400 },
    );
  }

  const settings = await getSettings();
  const ratePerUsd = Number(settings.idrPerUsd);
  if (!Number.isFinite(ratePerUsd) || ratePerUsd <= 0) {
    return NextResponse.json(
      { error: "Top-up is temporarily unavailable (no exchange rate configured)" },
      { status: 403 },
    );
  }
  const rateMilli = Math.round(ratePerUsd * 1000);

  const username = (settings.takoUsername || "").trim();
  const merchantKey = (process.env.TAKO_MERCHANT_KEY || "").trim();
  if (!username || !merchantKey) {
    return NextResponse.json({ error: "Top-up is not configured" }, { status: 403 });
  }

  // Rate snapshot is locked at creation; the credit amount is precomputed and
  // later rate changes never re-write it (spec §3.4).
  const topup = await createTopup({ customerId: session.customerId, amountIdr, rateMilli });

  try {
    const res = await fetch(TAKO_TOPUP_URL(username), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${merchantKey}`,
        "Content-Type": "application/json",
        "User-Agent": "9router/1.0",
      },
      body: JSON.stringify({
        amount: amountIdr,
        // echo our row id so callbacks/reconciliation can be correlated
        refId: topup.id,
        expectedCreditMicros: computeCreditedMicros(amountIdr, rateMilli),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.transactionId) {
      throw new Error(`tako responded ${res.status}`);
    }
    await setTopupPayment(topup.id, {
      takoTxnId: String(data.transactionId),
      paymentUrl: data.paymentUrl ? String(data.paymentUrl) : null,
    });
    return NextResponse.json({
      topup: { ...topup, takoTxnId: String(data.transactionId), paymentUrl: data.paymentUrl || null },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Payment provider unavailable, please try again", detail: String(err?.message || err) },
      { status: 502 },
    );
  }
}
