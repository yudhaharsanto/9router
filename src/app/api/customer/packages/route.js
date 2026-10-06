import { NextResponse } from "next/server";
import { requireCustomerSession } from "@/lib/auth/customerSession.js";
import { listPackages, listCustomerPackages } from "@/lib/db/repos/packagesRepo.js";

export const dynamic = "force-dynamic";

// GET /api/customer/packages — buyable catalog (active, priced) + own instances.
export async function GET(request) {
  const session = await requireCustomerSession(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [catalog, mine] = await Promise.all([
    listPackages({ activeOnly: true }),
    listCustomerPackages(session.customerId),
  ]);
  return NextResponse.json(
    {
      catalog: catalog.map((p) => ({
        id: p.id, name: p.name, tokens: p.tokens, priceIdr: p.priceIdr,
        models: safeParse(p.models), durationDays: p.durationDays,
      })),
      instances: mine.map((i) => ({
        id: i.id, packageId: i.packageId, status: i.status,
        tokensGranted: i.tokensGranted, tokensUsed: i.tokensUsed,
        tokensRemaining: Math.max(0, i.tokensGranted - i.tokensUsed),
        activatedAt: i.activatedAt, expiresAt: i.expiresAt,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

function safeParse(json) {
  try { return JSON.parse(json) || []; } catch { return []; }
}
