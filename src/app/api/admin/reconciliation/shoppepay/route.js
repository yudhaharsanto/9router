import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";
import { syncPendingTopups } from "@/lib/billing/shoppepayReconcile.js";

export const dynamic = "force-dynamic";

// GET /api/admin/reconciliation/shoppepay — admin-only, run-on-demand sweep of
// pending ShopeePay topups. The gateway has no callbacks, so this is the only
// recovery path for a payment whose checkout page was closed before the poll
// saw it (within the poll window; older rows are settled manually).
export async function GET(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)auth_token=([^;]+)/);
  const session = await getDashboardAuthSession(match ? decodeURIComponent(match[1]) : null);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const result = await syncPendingTopups({ limit: 100 });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
