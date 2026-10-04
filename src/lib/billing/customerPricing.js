// Customer sell pricing (spec §3.5): sell = official × (1 − discountRate).
// discountRate is an admin setting (default 0.5 = customers pay half price).
// Everything downstream is integer micro-USD — the same money unit as the
// ledger — so there is exactly one rounding point, at token→micros.
import { getPricingForModel } from "@/lib/db/repos/pricingRepo.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";

// Fallback constants if the admin setting is missing/invalid.
const DEFAULT_DISCOUNT_RATE = 0.5;

export async function getDiscountRate() {
  const settings = await getSettings();
  const v = Number(settings.discountRate);
  if (!Number.isFinite(v) || v < 0 || v >= 1) return DEFAULT_DISCOUNT_RATE;
  return v;
}

// Sell pricing for a provider/model: official (from the pricing catalog,
// admin-editable) scaled by (1 − discountRate). Units: USD per 1M tokens.
export async function getSellPricing(provider, model) {
  const official = await getPricingForModel(provider, model);
  if (!official) return null;
  const discount = await getDiscountRate();
  const factor = 1 - discount;
  return {
    input: (official.input ?? 0) * factor,
    output: (official.output ?? 0) * factor,
    cached: (official.cached ?? official.input ?? 0) * factor,
    cache_creation: (official.cache_creation ?? 0) * factor,
    reasoning: (official.reasoning ?? official.output ?? 0) * factor,
    discountRate: discount,
  };
}

// Mirror of open-sse/providers/pricing.js calculateCostFromTokens (same
// cache-inclusive prompt_tokens convention) but returns INTEGER micro-USD.
export function estimateCostMicros(tokens, sellPricing) {
  if (!tokens || !sellPricing) return 0;
  const inputTokens = tokens.prompt_tokens || tokens.input_tokens || 0;
  const cachedTokens = tokens.cached_tokens || tokens.cache_read_input_tokens || 0;
  const cacheCreationTokens = tokens.cache_creation_input_tokens || 0;
  const nonCachedInput = Math.max(0, inputTokens - cachedTokens - cacheCreationTokens);
  const reasoningTokens = tokens.reasoning_tokens || 0;

  // Denominator: rate is per 1M tokens; ×1e6 for dollars → micros = ×1 per token.
  const micros =
    nonCachedInput * (sellPricing.input ?? 0) +
    cachedTokens * (sellPricing.cached ?? sellPricing.input ?? 0) +
    cacheCreationTokens * (sellPricing.cache_creation ?? 0) +
    (tokens.completion_tokens || tokens.output_tokens || 0) * (sellPricing.output ?? 0) +
    reasoningTokens * (sellPricing.reasoning ?? 0);
  return Math.round(micros);
}

// Direct sell price for a public model name. The admin-entered price is the
// OFFICIAL (pre-discount) price — the customer is billed official ×
// (1 − discountRate), same as member models. Null when the public model has
// no custom pricing — callers fall back to member-model pricing.
export async function getPublicSellPricing(publicName) {
  if (!publicName) return null;
  const { getPublicPricing } = await import("@/lib/db/repos/pricingRepo.js");
  const table = await getPublicPricing();
  const entry = table[publicName];
  if (!entry || typeof entry !== "object") return null;
  const discount = await getDiscountRate();
  const factor = 1 - discount;
  // cachedPct is % of the (official) input rate; carried through unscaled so
  // the customer's cached rate is that % of their discounted input. Legacy
  // absolute cached ($/1M) discounts like every other rate.
  const cachedPct = entry.cachedPct !== undefined && entry.cachedPct !== null
    ? Number(entry.cachedPct)
    : null;
  const officialCached = cachedPct !== null && Number.isFinite(cachedPct)
    ? null
    : (entry.cached ?? entry.input ?? 0);
  return {
    input: (entry.input ?? 0) * factor,
    output: (entry.output ?? 0) * factor,
    cached: cachedPct !== null && Number.isFinite(cachedPct)
      ? ((entry.input ?? 0) * factor) * (cachedPct / 100)
      : officialCached * factor,
    cache_creation: (entry.cache_creation ?? 0) * factor,
    reasoning: (entry.reasoning ?? entry.output ?? 0) * factor,
    discountRate: discount,
    official: { input: entry.input ?? 0, output: entry.output ?? 0, cachedPct },
  };
}
