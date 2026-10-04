import { NextResponse } from "next/server";
import { MODEL_PRICING, PROVIDER_PRICING, PATTERN_PRICING } from "open-sse/providers/pricing.js";

/**
 * GET /api/pricing/defaults — read-only canonical price catalog (the full
 * billing basis). Three layers, mirroring the resolver's fallback chain:
 *   canonical: MODEL_PRICING (provider-agnostic, ~118 models)
 *   provider:  PROVIDER_PRICING (rates that differ per provider — gh, tokenrouter, …)
 *   patterns:  PATTERN_PRICING (glob rules, e.g. "*-codex-high")
 */
export async function GET() {
  try {
    return NextResponse.json({
      canonical: MODEL_PRICING,
      provider: PROVIDER_PRICING,
      patterns: PATTERN_PRICING,
    });
  } catch (error) {
    console.error("Error fetching default pricing:", error);
    return NextResponse.json(
      { error: "Failed to fetch default pricing" },
      { status: 500 }
    );
  }
}
