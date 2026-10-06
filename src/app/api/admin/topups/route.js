import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";
import { getAdapter } from "@/lib/db/driver.js";

export const dynamic = "force-dynamic";

async function requireAdmin(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)auth_token=([^;]+)/);
  return getDashboardAuthSession(match ? decodeURIComponent(match[1]) : null);
}

// GET /api/admin/topups — paid topups across all customers (balance credits +
// package purchases). Pending/failed excluded: admin history is revenue, not
// abandoned checkouts.
export async function GET(request) {
  if (!(await requireAdmin(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit")) || 100), 500);
  const db = await getAdapter();
  const rows = db.all(
    `SELECT t.id AS topupId, t.customerId, t.amountIdr, t.rateMilli, t.creditedMicros,
            t.status, t.paidAt, t.createdAt, COALESCE(NULLIF(c.name, ''), NULLIF(c.email, '')) AS customerLabel, c.email AS customerEmail, c.name AS customerName
     FROM topups t LEFT JOIN customers c ON c.id = t.customerId
     WHERE t.status = 'paid'
     ORDER BY t.paidAt DESC, t.rowid DESC LIMIT ?`,
    [limit]
  );
  return NextResponse.json(
    { items: rows.map((r) => ({ ...r, amountIdr: Number(r.amountIdr), creditedMicros: r.creditedMicros == null ? null : Number(r.creditedMicros) })) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
