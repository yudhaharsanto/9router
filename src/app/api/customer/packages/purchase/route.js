import { NextResponse } from "next/server";
import { requireCustomerSession } from "@/lib/auth/customerSession.js";
import { getPackageById, createPendingFromTopup } from "@/lib/db/repos/packagesRepo.js";
import { createTopup, setTopupPayment } from "@/lib/db/repos/topupsRepo.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { getCustomerById } from "@/lib/db/repos/customersRepo.js";

export const dynamic = "force-dynamic";

// POST /api/customer/packages/purchase { packageId } — buy a token package via
// the same Tako QRIS flow as balance top-ups. Creates a pending topup row AND
// a pending package instance linked to it; activation happens on the
// topup-paid path (webhook / reconcile). Manual mode (no Tako key configured)
// leaves both rows pending — admin credits the topup, which activates the
// package through the same applyTopupCredit path.
const TAKO_GIFT_URL = (username) => `https://tako.id/api/v1/gift/${encodeURIComponent(username)}`;

export async function POST(request) {
  const session = await requireCustomerSession(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const pkg = body?.packageId ? await getPackageById(body.packageId) : null;
  if (!pkg || !pkg.active) return NextResponse.json({ error: "Package not found or inactive" }, { status: 404 });
  if (!Number.isInteger(pkg.priceIdr) || pkg.priceIdr < 1) {
    return NextResponse.json({ error: "This package is not purchasable" }, { status: 400 });
  }

  const settings = await getSettings();
  const ratePerUsd = Number(settings.idrPerUsd);
  if (!Number.isFinite(ratePerUsd) || ratePerUsd <= 0) {
    return NextResponse.json(
      { error: "Purchase is temporarily unavailable (no exchange rate configured)" },
      { status: 403 },
    );
  }
  const rateMilli = Math.round(ratePerUsd * 1000);

  const customer = await getCustomerById(session.customerId);
  const topup = await createTopup({ customerId: session.customerId, amountIdr: pkg.priceIdr, rateMilli });
  const instance = await createPendingFromTopup({
    customerId: session.customerId,
    packageId: pkg.id,
    topupId: topup.id,
  });

  const username = (settings.takoUsername || "").trim();
  const merchantKey = (settings.takoMerchantKey || process.env.TAKO_MERCHANT_KEY || "").trim();
  if (!username || !merchantKey) {
    return NextResponse.json({
      topup, instance, manual: true,
      message: "Online payment is not available yet. Your purchase has been recorded — contact the admin to complete it.",
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
        name: customer?.name || customer?.email?.split("@")[0] || "9Router customer",
        email: customer?.email || undefined,
        amount: pkg.priceIdr,
        paymentMethod: "qris",
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
      instance,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Payment provider unavailable, please try again", detail: String(err?.message || err) },
      { status: 502 },
    );
  }
}
