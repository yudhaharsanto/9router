import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";
import { runTakoReconciliation } from "@/lib/billing/takoReconcile.js";

export const dynamic = "force-dynamic";

// GET /api/admin/reconciliation/tako — admin-only, run-on-demand sweep of
// stuck pending Tako topups (spec §3.3 reconciliation worker). Wired to a
// dashboard button in phase 7; callable manually until then.
export async function GET(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)auth_token=([^;]+)/);
  const session = await getDashboardAuthSession(match ? decodeURIComponent(match[1]) : null);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const result = await runTakoReconciliation({ olderThanMinutes: 5 });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
