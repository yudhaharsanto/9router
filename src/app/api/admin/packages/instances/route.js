import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";
import { getAdapter } from "@/lib/db/driver.js";

export const dynamic = "force-dynamic";

async function requireAdmin(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)auth_token=([^;]+)/);
  return getDashboardAuthSession(match ? decodeURIComponent(match[1]) : null);
}

// GET /api/admin/packages/instances — every customer holding a package
// instance (active, pending, expired), with package name + quota state.
export async function GET(request) {
  if (!(await requireAdmin(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit")) || 200), 1000);
  const db = await getAdapter();
  const rows = db.all(
    `SELECT i.id, i.customerId, i.packageId, i.status, i.tokensGranted, i.tokensUsed,
            i.activatedAt, i.expiresAt, i.createdAt,
            p.name AS packageName, COALESCE(NULLIF(c.name, ''), NULLIF(c.email, '')) AS customerLabel, c.email AS customerEmail, c.name AS customerName
     FROM customerPackages i
     LEFT JOIN tokenPackages p ON p.id = i.packageId
     LEFT JOIN customers c ON c.id = i.customerId
     ORDER BY i.createdAt DESC LIMIT ?`,
    [limit]
  );
  return NextResponse.json(
    {
      items: rows.map((r) => ({
        ...r,
        tokensGranted: Number(r.tokensGranted),
        tokensUsed: Number(r.tokensUsed),
        tokensRemaining: Math.max(0, Number(r.tokensGranted) - Number(r.tokensUsed)),
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
