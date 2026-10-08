import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";
import { createPackage, listPackages } from "@/lib/db/repos/packagesRepo.js";

export const dynamic = "force-dynamic";

async function requireAdmin(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)auth_token=([^;]+)/);
  return getDashboardAuthSession(match ? decodeURIComponent(match[1]) : null);
}

// GET /api/admin/packages — token package catalog.
export async function GET(request) {
  if (!(await requireAdmin(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const packages = await listPackages();
  return NextResponse.json({ packages }, { headers: { "Cache-Control": "no-store" } });
}

// POST /api/admin/packages — create a catalog entry.
export async function POST(request) {
  if (!(await requireAdmin(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const { name, tokens, priceIdr, models, comboId, durationDays, group } = body || {};
  if (!name || !Number.isInteger(Number(tokens)) || Number(tokens) <= 0) {
    return NextResponse.json({ error: "name and a positive integer tokens are required" }, { status: 400 });
  }
  try {
    const pkg = await createPackage({
      name: String(name).slice(0, 200),
      tokens: Number(tokens),
      priceIdr: Number(priceIdr) || 0,
      models: Array.isArray(models) ? models.map(String) : ["*"],
      comboId: comboId ? String(comboId) : null,
      durationDays: Number(durationDays) || 0,
      group: group ? String(group).slice(0, 200) : null,
    });
    return NextResponse.json({ package: pkg });
  } catch (err) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 400 });
  }
}
