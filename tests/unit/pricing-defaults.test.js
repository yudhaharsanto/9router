// GET /api/pricing/defaults — full canonical price catalog (spec §3.5 basis):
// canonical MODEL_PRICING (~118 models) + provider-specific overrides
// (gh, tokenrouter, …) + glob pattern rules. Read-only.
import { describe, expect, it } from "vitest";

describe("GET /api/pricing/defaults", () => {
  it("returns canonical catalog + provider overrides + patterns", async () => {
    const mod = await import("@/app/api/pricing/defaults/route.js");
    const res = await mod.GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    // Canonical catalog: large, provider-agnostic, each entry price-shaped
    expect(Object.keys(body.canonical).length).toBeGreaterThan(50);
    const first = Object.values(body.canonical)[0];
    expect(typeof first.input).toBe("number");
    expect(typeof first.output).toBe("number");

    // Provider-specific overrides include the two known ones
    expect(body.provider.gh).toBeTruthy();
    expect(body.provider.tokenrouter).toBeTruthy();

    // Pattern rules: glob + pricing
    expect(Array.isArray(body.patterns)).toBe(true);
    expect(body.patterns.length).toBeGreaterThan(0);
    expect(typeof body.patterns[0].pattern).toBe("string");
    expect(typeof body.patterns[0].pricing.input).toBe("number");
  });
});
