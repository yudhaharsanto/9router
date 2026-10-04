import { NextResponse } from "next/server";
import { requireCustomerSession } from "@/lib/auth/customerSession.js";
import { getBalance, getLedger } from "@/lib/db/repos/ledgerRepo.js";

export const dynamic = "force-dynamic";

// GET /api/customer/ledger — this customer's balance + recent ledger entries.
export async function GET(request) {
  const session = await requireCustomerSession(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);

  const [balance, items] = await Promise.all([
    getBalance(session.customerId),
    getLedger(session.customerId, { limit }),
  ]);
  return NextResponse.json(
    { balance: { balanceMicros: balance.balanceMicros }, items },
    { headers: { "Cache-Control": "no-store" } },
  );
}
