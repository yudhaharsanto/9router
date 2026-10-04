import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";
import { listCustomersWithDetails } from "@/lib/db/repos/customersRepo.js";

export const dynamic = "force-dynamic";

// GET /api/admin/customers — admin-only customer list: identity, status,
// balance/reserve, active key mask, total topup. Never exposes key hashes or
// plaintext keys (masks only).
export async function GET(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)auth_token=([^;]+)/);
  const session = await getDashboardAuthSession(match ? decodeURIComponent(match[1]) : null);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const customers = await listCustomersWithDetails();
  return NextResponse.json(
    { customers },
    { headers: { "Cache-Control": "no-store" } }
  );
}
