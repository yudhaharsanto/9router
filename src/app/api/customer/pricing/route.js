import { NextResponse } from "next/server";
import { requireCustomerSession } from "@/lib/auth/customerSession.js";
import { listPublicModels } from "@/lib/db/repos/publicModelsRepo.js";
import { getPublicPricing, getPricingForModel } from "@/lib/db/repos/pricingRepo.js";
import { getComboById } from "@/lib/db/repos/combosRepo.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";

export const dynamic = "force-dynamic";

const DEFAULT_DISCOUNT_RATE = 0.5;

// Cache price expressed as a % of the input rate (rounded for display).
function cachedPctOf(pricing) {
  if (!pricing || !pricing.input) return null;
  const base = pricing.cached ?? pricing.input;
  return Math.round((base / pricing.input) * 10000) / 100; // 2 decimals
}

// GET /api/customer/pricing — what this customer pays per public model.
// Direct-priced rows: admin-entered price is OFFICIAL (pre-discount);
// customer pays official × (1 − discountRate) like any other model.
// Auto rows: official member price × (1 − discountRate), per combo member.
// Combo IDs and provider names never appear in the response.
export async function GET(request) {
  const session = await requireCustomerSession(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [mappings, directPricing, settings] = await Promise.all([
    listPublicModels({ enabledOnly: true }),
    getPublicPricing(),
    getSettings(),
  ]);
  const discount = Number(settings.discountRate);
  const effDiscount = Number.isFinite(discount) && discount >= 0 && discount < 1 ? discount : DEFAULT_DISCOUNT_RATE;
  const factor = 1 - effDiscount;

  const items = await Promise.all(mappings.map(async (m) => {
    const direct = directPricing[m.publicName];
    if (direct && typeof direct === "object") {
      const input = direct.input ?? 0;
      const output = direct.output ?? 0;
      return {
        name: m.publicName,
        official: { input, output, cachedPct: direct.cachedPct ?? null },
        sell: {
          input: input * factor,
          output: output * factor,
          cachedPct: direct.cachedPct ?? null,
        },
      };
    }
    // Auto price: per combo member, official × (1 − discount). Members with no
    // catalog price are skipped; if none are priced the row shows no rates.
    const combo = await getComboById(m.comboId);
    const members = Array.isArray(combo?.models) ? combo.models : [];
    let input = 0;
    let output = 0;
    let cachedBase = null;
    let officialInput = 0;
    let officialOutput = 0;
    let officialCached = null;
    let any = false;
    for (const ref of members) {
      const [provider, ...rest] = String(ref).split("/");
      const model = rest.join("/");
      const official = await getPricingForModel(provider, model);
      if (!official) continue;
      any = true;
      officialInput = Math.max(officialInput, official.input ?? 0);
      officialOutput = Math.max(officialOutput, official.output ?? 0);
      officialCached = official.cached ?? officialCached;
      // Max across members: the customer is billed at the priciest member that
      // could serve the request, so this is the worst-case effective rate.
      input = Math.max(input, (official.input ?? 0) * factor);
      output = Math.max(output, (official.output ?? 0) * factor);
      cachedBase = Math.max(cachedBase ?? 0, official.cached ?? official.input ?? 0);
    }
    return {
      name: m.publicName,
      official: any ? { input: officialInput, output: officialOutput, cachedPct: cachedPctOf({ input: officialInput, cached: officialCached }) } : null,
      sell: {
        input,
        output,
        cachedPct: officialInput > 0 && cachedBase !== null ? Math.round((cachedBase / officialInput) * 10000) / 100 : null,
      },
    };
  }));

  items.sort((a, b) => a.name.localeCompare(b.name));
  // FX snapshot for IDR display. Empty rate = top-up is blocked anyway, so the
  // portal simply omits the IDR column instead of guessing an exchange rate.
  const ratePerUsd = Number(settings.idrPerUsd);
  const idrPerUsd = Number.isFinite(ratePerUsd) && ratePerUsd > 0 ? ratePerUsd : null;
  return NextResponse.json(
    { items, idrPerUsd },
    { headers: { "Cache-Control": "no-store" } },
  );
}
