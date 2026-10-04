import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";
import { listPublicModels, upsertPublicModel, deletePublicModel } from "@/lib/db/repos/publicModelsRepo.js";
import { getCombos } from "@/lib/db/repos/combosRepo.js";

export const dynamic = "force-dynamic";

// Admin session gate — same convention as /api/admin/customers.
async function requireSession(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)auth_token=([^;]+)/);
  return getDashboardAuthSession(match ? decodeURIComponent(match[1]) : null);
}

// GET /api/admin/public-models — mappings with combo names resolved
// (admin UI only; combo IDs stay server-side for customer-facing surfaces).
export async function GET(request) {
  if (!(await requireSession(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const [mappings, combos] = await Promise.all([
      listPublicModels({ enabledOnly: false }),
      getCombos(),
    ]);
    const nameById = new Map(combos.map((c) => [c.id, c.name]));
    const publicModels = mappings.map((m) => ({
      id: m.id,
      publicName: m.publicName,
      comboId: m.comboId,
      comboName: nameById.get(m.comboId) || "(deleted combo)",
      enabled: m.enabled,
    }));
    return NextResponse.json(
      { publicModels, combos: combos.map((c) => ({ id: c.id, name: c.name })) },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Error listing public models:", error);
    return NextResponse.json({ error: "Failed to list public models" }, { status: 500 });
  }
}

// POST /api/admin/public-models — upsert { publicName, comboId, enabled }.
export async function POST(request) {
  if (!(await requireSession(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = await request.json();
    const publicName = String(body?.publicName || "").trim();
    const comboId = String(body?.comboId || "");
    const enabled = body?.enabled !== false;
    if (!publicName || !comboId) {
      return NextResponse.json({ error: "publicName and comboId are required" }, { status: 400 });
    }
    if (publicName.includes("/")) {
      return NextResponse.json({ error: "publicName cannot contain '/' (provider/model is reserved)" }, { status: 400 });
    }
    const combos = await getCombos();
    if (!combos.some((c) => c.id === comboId)) {
      return NextResponse.json({ error: "Unknown combo" }, { status: 400 });
    }
    const row = await upsertPublicModel({ publicName, comboId, enabled });
    return NextResponse.json(row, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Error upserting public model:", error);
    return NextResponse.json({ error: "Failed to save public model" }, { status: 500 });
  }
}

// DELETE /api/admin/public-models?id=<mapping id>
export async function DELETE(request) {
  if (!(await requireSession(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    await deletePublicModel(id);
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Error deleting public model:", error);
    return NextResponse.json({ error: "Failed to delete public model" }, { status: 500 });
  }
}
