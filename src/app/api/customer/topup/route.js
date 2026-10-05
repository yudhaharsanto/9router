import { NextResponse } from "next/server";
import { requireCustomerSession } from "@/lib/auth/customerSession.js";
import { createTopup, setTopupPayment, computeCreditedMicros } from "@/lib/db/repos/topupsRepo.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { getCustomerById } from "@/lib/db/repos/customersRepo.js";

export const dynamic = "force-dynamic";

// POST /api/customer/topup { amountIdr } — session-gated Tako top-up creation
// (spec §3.3). Rate snapshot comes from settings (idrPerUsd); without a valid
// rate creation is blocked — never guess. The merchant key is server-only.
//
// Tako gift API (docs: tako.id/api-docs#mengirim-hadiah): a "gift" is a payment
// request to the merchant account — the customer pays the merchant's QRIS, and
// the payment.success callback (or reconciliation) credits the topup row.
// QRIS is the only method the API offers here; balance payment is not
// available to API keys.
const TAKO_GIFT_URL = (username) => `https://tako.id/api/v1/gift/${encodeURIComponent(username)}`;

export async function POST(request) {
  const session = await requireCustomerSession(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const amountIdr = Number(body?.amountIdr);
  if (!Number.isInteger(amountIdr) || amountIdr < 1_000 || amountIdr > 100_000_000) {
    return NextResponse.json(
      { error: "amountIdr must be an integer between 1000 and 100000000" },
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

  const customer = await getCustomerById(session.customerId);

  // Rate snapshot is locked at creation; the credit amount is precomputed and
  // later rate changes never re-write it (spec §3.4).
  const topup = await createTopup({ customerId: session.customerId, amountIdr, rateMilli });

  const username = (settings.takoUsername || "").trim();
  // Merchant key lives in settings (set from the admin dashboard); the env var
  // is the legacy/override path. Settings value wins when both exist.
  const merchantKey = (settings.takoMerchantKey || process.env.TAKO_MERCHANT_KEY || "").trim();
  if (!username || !merchantKey) {
    // Manual mode: the row stays pending so the request is auditable; an
    // admin credits it via balance adjustment (or the Tako webhook if a key
    // is configured later). Nothing payment-secret is exposed here.
    return NextResponse.json({
      topup,
      manual: true,
      message: "Online payment is not available yet. Your top-up has been recorded — contact the admin to complete it.",
    });
  }

  try {
    const res = await fetch(TAKO_GIFT_URL(username), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${merchantKey}`,
        "Content-Type": "application/json",
        "User-Agent": "9router/1.0",
      },
      body: JSON.stringify({
        // Gift fields (docs): sender identity + amount + method.
        name: customer?.name || customer?.email?.split("@")[0] || "9Router customer",
        email: customer?.email || undefined,
        amount: amountIdr,
        paymentMethod: "qris",
        // echo our row id so callbacks/reconciliation can be correlated
        message: `9router topup ${topup.id}`,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({}));
    const result = data?.result || data;
    if (!res.ok || !result?.transactionId) {
      throw new Error(`tako responded ${res.status}`);
    }
    await setTopupPayment(topup.id, {
      takoTxnId: String(result.transactionId),
      paymentUrl: result.paymentUrl ? String(result.paymentUrl) : null,
    });
    return NextResponse.json({
      topup: { ...topup, takoTxnId: String(result.transactionId), paymentUrl: result.paymentUrl || null },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Payment provider unavailable, please try again", detail: String(err?.message || err) },
      { status: 502 },
    );
  }
}
