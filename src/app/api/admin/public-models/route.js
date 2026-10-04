import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";
import { listPublicModels, upsertPublicModel, deletePublicModel } from "@/lib/db/repos/publicModelsRepo.js";
import { getPublicPricing, updatePublicPricing, getPricingForModel } from "@/lib/db/repos/pricingRepo.js";
import { getCombos, getComboById } from "@/lib/db/repos/combosRepo.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";

const DEFAULT_DISCOUNT_RATE = 0.5;

// Effective sell price for a member model: official × (1 − discountRate) —
// what the customer is billed when the public model has no direct price.
function discounted(official, discount) {
  if (!official) return null;
  const f = 1 - discount;
  return {
    input: (official.input ?? 0) * f,
    output: (official.output ?? 0) * f,
    cached: (official.cached ?? official.input ?? 0) * f,
    cache_creation: (official.cache_creation ?? 0) * f,
    reasoning: (official.reasoning ?? official.output ?? 0) * f,
  };
}

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
    const [mappings, combos, pricing, settings] = await Promise.all([
      listPublicModels({ enabledOnly: false }),
      getCombos(),
      getPublicPricing(),
      getSettings(),
    ]);
    const nameById = new Map(combos.map((c) => [c.id, c.name]));
    const discount = Number(settings.discountRate);
    const effDiscount = Number.isFinite(discount) && discount >= 0 && discount < 1 ? discount : DEFAULT_DISCOUNT_RATE;
    const publicModels = await Promise.all(mappings.map(async (m) => {
      const base = {
        id: m.id,
        publicName: m.publicName,
        comboId: m.comboId,
        comboName: nameById.get(m.comboId) || "(deleted combo)",
        enabled: m.enabled,
        pricing: pricing[m.publicName] || null,
      };
      // Rows without a direct price bill members at official × (1 − discount);
      // surface that computed price so the admin sees the effective rate.
      if (!base.pricing) {
        const combo = await getComboById(m.comboId);
        const members = Array.isArray(combo?.models) ? combo.models : [];
        base.autoPricing = await Promise.all(members.map(async (ref) => {
          const [provider, ...rest] = String(ref).split("/");
          const model = rest.join("/");
          const official = await getPricingForModel(provider, model);
          const sell = discounted(official, effDiscount);
          return {
            model,
            provider,
            official: official ? { input: official.input ?? 0, output: official.output ?? 0 } : null,
            sellInput: sell ? sell.input : 0,
            sellOutput: sell ? sell.output : 0,
          };
        }));
      }
      return base;
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
    // Optional direct sell pricing { input, output, cached, ... } (USD/1M).
    // Only numeric fields are accepted — everything else is ignored.
    if (body?.pricing && typeof body.pricing === "object") {
      const validFields = ["input", "output", "cached", "cachedPct", "reasoning", "cache_creation"];
      const clean = {};
      for (const [k, v] of Object.entries(body.pricing)) {
        if (validFields.includes(k) && typeof v === "number" && Number.isFinite(v) && v >= 0) {
          clean[k] = v;
        }
      }
      if (Object.keys(clean).length > 0) {
        await updatePublicPricing({ [publicName]: clean });
      }
    }
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
