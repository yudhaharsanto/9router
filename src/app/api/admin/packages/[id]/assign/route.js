import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";
import { assignPackage } from "@/lib/db/repos/packagesRepo.js";
import { getCustomerById } from "@/lib/db/repos/customersRepo.js";

export const dynamic = "force-dynamic";

async function requireAdmin(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)auth_token=([^;]+)/);
  return getDashboardAuthSession(match ? decodeURIComponent(match[1]) : null);
}

// POST /api/admin/packages/[id]/assign { customerId } — grant a package
// instance directly (free / paid outside the system).
export async function POST(request, { params }) {
  if (!(await requireAdmin(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const customerId = body?.customerId;
  if (!customerId) return NextResponse.json({ error: "customerId is required" }, { status: 400 });
  const customer = await getCustomerById(customerId);
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  try {
    const instance = await assignPackage(customerId, id);
    return NextResponse.json({ instance });
  } catch (err) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 400 });
  }
}
