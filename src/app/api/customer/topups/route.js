import { NextResponse } from "next/server";
import { requireCustomerSession } from "@/lib/auth/customerSession.js";
import { listTopups } from "@/lib/db/repos/topupsRepo.js";
import { syncPendingTopups } from "@/lib/billing/shoppepayReconcile.js";

export const dynamic = "force-dynamic";

// GET /api/customer/topups — this customer's top-up history.
// ?sync=1 also polls the ShopeePay gateway for their pending topups first; the
// checkout card uses it while a payment is open (the gateway has no webhook).
export async function GET(request) {
  const session = await requireCustomerSession(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);

  if (url.searchParams.get("sync") === "1") {
    // Fail-open: a provider outage must not break the history listing.
    await syncPendingTopups({ customerId: session.customerId, limit: 10 }).catch(() => {});
  }

  const items = await listTopups(session.customerId, { limit });
  // paymentUrl of past topups is noise; keep the row summary only.
  return NextResponse.json(
    {
      items: items.map((t) => ({
        id: t.id,
        amountIdr: t.amountIdr,
        rateMilli: t.rateMilli,
        creditedMicros: t.creditedMicros,
        status: t.status,
        paidAt: t.paidAt,
        createdAt: t.createdAt,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
