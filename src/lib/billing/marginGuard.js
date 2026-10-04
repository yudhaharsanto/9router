// Margin guard (spec §3.10): a request is margin-unsafe when the estimated
// upstream (official) cost exceeds the sell-price estimate by more than
// minMarginPct. Behavior: "block" → 503 at chat entry, "skip" → warn and
// proceed (v1 has no per-member selection at entry; the verdict is logged for
// reconciliation drift analysis either way).
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { getSellPricing, estimateCostMicros } from "@/lib/billing/customerPricing.js";
import { getPricingForModel } from "@/lib/db/repos/pricingRepo.js";

// Same token-shape convention as estimateCostMicros: max_tokens drives the
// output estimate; input tokens are unknown pre-request and ignored here.
// Upstream cost basis: admin per-model override (USD per 1M, same shape as
// pricing — the router's own accounts often cost ~0), else the official
// catalog price. Against the official price, any discount > minMarginPct is
// margin-unsafe per the spec formula — that is the intended kill-switch
// semantics; set cost overrides (or keep behavior=skip) to serve.
function pickUpstreamPricing(provider, model, official, overrides) {
  const key1 = `${provider}/${model}`;
  const key2 = `*/${model}`;
  for (const k of [key1, key2]) {
    if (overrides && overrides[k]) return overrides[k];
  }
  return official;
}

export async function checkMarginForRequest(provider, model, body) {
  const settings = await getSettings();
  const sell = await getSellPricing(provider, model);
  const official = await getPricingForModel(provider, model);
  const upstream = pickUpstreamPricing(provider, model, official, settings.modelCostOverrides);
  const maxTokens = Math.max(0, Math.floor(Number(body?.max_tokens) || 8192));
  const tokens = { completion_tokens: maxTokens };
  const expectedChargeMicros = sell ? estimateCostMicros(tokens, sell) : 0;
  const estimatedUpstreamMicros = upstream ? estimateCostMicros(tokens, upstream) : 0;
  const verdict = { expectedChargeMicros, estimatedUpstreamMicros };
  return {
    ...verdict,
    unsafe: marginUnsafe(verdict, Number(settings.minMarginPct) || 0),
  };
}

export function marginUnsafe(verdict, minMarginPct) {
  if (!verdict || verdict.expectedChargeMicros <= 0) return verdict ? verdict.estimatedUpstreamMicros > 0 : false;
  // sell × (1 − minMarginPct) is the floor the upstream estimate must stay under.
  const floor = verdict.expectedChargeMicros * (1 - Math.max(0, Math.min(1, minMarginPct)));
  return verdict.estimatedUpstreamMicros > floor;
}

// Full policy evaluation at chat entry: settings-aware verdict.
export async function evaluateMarginPolicy(provider, model, body) {
  const settings = await getSettings();
  const minMarginPct = Number(settings.minMarginPct) || 0;
  const verdict = await checkMarginForRequest(provider, model, body);
  const unsafe = marginUnsafe(verdict, minMarginPct);
  return {
    ...verdict,
    unsafe,
    blocked: unsafe && settings.marginBehavior === "block",
  };
}
