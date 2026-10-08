import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";
import { updatePackage, deletePackage } from "@/lib/db/repos/packagesRepo.js";

export const dynamic = "force-dynamic";

async function requireAdmin(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)auth_token=([^;]+)/);
  return getDashboardAuthSession(match ? decodeURIComponent(match[1]) : null);
}

// PATCH /api/admin/packages/[id] — edit catalog fields (incl. deactivate).
export async function PATCH(request, { params }) {
  if (!(await requireAdmin(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const patch = {};
  for (const key of ["name", "tokens", "priceIdr", "models", "comboId", "durationDays", "active"]) {
    if (key in body) patch[key] = body[key];
  }
  if ("name" in patch && !patch.name) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
  const pkg = await updatePackage(id, patch);
  if (!pkg) return NextResponse.json({ error: "Package not found" }, { status: 404 });
  return NextResponse.json({ package: pkg });
}

// DELETE /api/admin/packages/[id] — remove the catalog entry. Refused (409)
// while live customer instances reference it; deactivate instead.
export async function DELETE(request, { params }) {
  if (!(await requireAdmin(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    await deletePackage(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 409 });
  }
}
