import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";
import { getCustomerById } from "@/lib/db/repos/customersRepo.js";
import { createCustomerAuthToken } from "@/lib/auth/customerSession.js";

export const dynamic = "force-dynamic";

// POST /api/admin/customers/[id]/impersonate — admin-only "login as customer".
// Issues a real customer-scope session cookie (crx_session) for this customer;
// the admin then opens /usage-check and sees exactly what the customer sees.
// The cookie is customer-scoped only: it grants nothing on admin APIs, and the
// admin's own auth_token cookie stays untouched in the same browser.
const IMPERSONATION_MAX_AGE_SEC = 60 * 60; // 1 hour — deliberate short window

export async function POST(request, { params }) {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)auth_token=([^;]+)/);
  const session = await getDashboardAuthSession(match ? decodeURIComponent(match[1]) : null);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const customer = await getCustomerById(id);
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const token = await createCustomerAuthToken({ customerId: customer.id });
  const secure = request.headers.get("x-forwarded-proto") === "https";
  const res = NextResponse.json(
    { ok: true, customerId: customer.id, email: customer.email || null },
    { headers: { "Cache-Control": "no-store" } }
  );
  res.cookies.set("crx_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: IMPERSONATION_MAX_AGE_SEC,
    path: "/",
  });
  return res;
}
