import { NextResponse } from "next/server";
import { requireCustomerSession } from "@/lib/auth/customerSession.js";
import { listTopups } from "@/lib/db/repos/topupsRepo.js";

export const dynamic = "force-dynamic";

// GET /api/customer/topups — this customer's top-up history.
export async function GET(request) {
  const session = await requireCustomerSession(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
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
