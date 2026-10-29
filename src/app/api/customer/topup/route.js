import { NextResponse } from "next/server";
import { requireCustomerSession } from "@/lib/auth/customerSession.js";
import { createTopup, setTopupPaymentUrl } from "@/lib/db/repos/topupsRepo.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { shoppepayConfig, createQris } from "@/lib/billing/shoppepay.js";

export const dynamic = "force-dynamic";

// POST /api/customer/topup { amountIdr } — session-gated top-up creation.
// Rate snapshot comes from settings (idrPerUsd); without a valid rate creation
// is blocked — never guess. The gateway API key is server-only.
//
// The ShopeePay gateway mints a dynamic QRIS for the amount; the payment is
// confirmed later by polling (no webhook exists), see shoppepayReconcile.js.
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

  // Rate snapshot is locked at creation; the credit amount is precomputed and
  // later rate changes never re-write it.
  const topup = await createTopup({ customerId: session.customerId, amountIdr, rateMilli });

  const config = await shoppepayConfig();
  if (!config) {
    // Manual mode: the row stays pending so the request is auditable; an admin
    // credits it via balance adjustment. Nothing payment-secret is exposed.
    return NextResponse.json({
      topup,
      manual: true,
      message: "Online payment is not available yet. Your top-up has been recorded — contact the admin to complete it.",
    });
  }

  try {
    const { qrisUrl } = await createQris(config, amountIdr);
    await setTopupPaymentUrl(topup.id, qrisUrl);
    return NextResponse.json({ topup: { ...topup, paymentUrl: qrisUrl } });
  } catch (err) {
    return NextResponse.json(
      { error: "Payment provider unavailable, please try again", detail: String(err?.message || err) },
      { status: 502 },
    );
  }
}
