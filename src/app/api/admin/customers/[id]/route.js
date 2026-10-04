import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";
import { getCustomerById, setCustomerStatus } from "@/lib/db/repos/customersRepo.js";

export const dynamic = "force-dynamic";

const VALID_STATUS = ["active", "disabled"];

// PATCH /api/admin/customers/[id] — admin-only status toggle. Disabling a
// customer immediately invalidates their keys (validateCustomerKey checks the
// customer's status on every request).
export async function PATCH(request, { params }) {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)auth_token=([^;]+)/);
  const session = await getDashboardAuthSession(match ? decodeURIComponent(match[1]) : null);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!VALID_STATUS.includes(body?.status)) {
    return NextResponse.json({ error: `status must be one of: ${VALID_STATUS.join(", ")}` }, { status: 400 });
  }
  if (!(await getCustomerById(id))) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }
  await setCustomerStatus(id, body.status);
  return NextResponse.json({ ok: true, id, status: body.status }, { headers: { "Cache-Control": "no-store" } });
}
