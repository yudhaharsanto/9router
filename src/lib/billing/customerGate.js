// Customer balance gate (spec §3.8): sk-cust- keys are authorized against the
// customerKeys ledger and gated on balance before any upstream call. Reserve
// at entry, settle actual sell-priced usage at request end; in-flight requests
// are never killed mid-stream.
import { validateCustomerKey } from "@/lib/db/repos/customerKeysRepo.js";
import { getBalance, holdReserve } from "@/lib/db/repos/ledgerRepo.js";
import { getSellPricing, getPublicSellPricing, estimateCostMicros } from "@/lib/billing/customerPricing.js";

export const CUSTOMER_KEY_PREFIX = "sk-cust-";

// Default output tokens assumed when the client does not declare max_tokens.
const DEFAULT_MAX_TOKENS = 8192;
// Fallback output sell rate (USD per 1M tokens) when the model has no pricing
// entry yet — matches the top tier so unknown models cannot ride for free.
const FALLBACK_OUTPUT_RATE = 15;

export function isCustomerKey(apiKey) {
  return typeof apiKey === "string" && apiKey.startsWith(CUSTOMER_KEY_PREFIX);
}

// Returns { customerId, keyId } for a valid, active customer key; null otherwise.
export async function authorizeCustomerRequest(apiKey) {
  if (!isCustomerKey(apiKey)) return null;
  const match = await validateCustomerKey(apiKey);
  if (!match) return null;
  return { customerId: match.customer.id, keyId: match.key.id };
}

// Hold a reserve for one request. refId is unique per request so the settle can
// release exactly this hold (never delete — the ledger is append-only).
// maxTokens is client-declared and only ever bounds the reserve, never the
// actual charge: settleUsage debits real usage (small overdraft allowed, spec
// §3.8) and the next request is blocked once available <= 0.
export async function holdForRequest(customerId, body, publicName = null) {
  const maxTokens = Math.max(0, Math.floor(Number(body?.max_tokens) || DEFAULT_MAX_TOKENS));
  const model = String(body?.model || "");
  const pricing = (publicName && await getPublicSellPricing(publicName)) || await getSellPricing("openai", model);
  const outRate = pricing ? pricing.output : FALLBACK_OUTPUT_RATE;
  // max_tokens × rate/1M → micro-USD (rate per 1M × 1e6 µ$ = ×1 per token).
  const reserveMicros = Math.round(maxTokens * (outRate || FALLBACK_OUTPUT_RATE));
  const holdRefId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const hold = await holdReserve(customerId, Math.max(1, reserveMicros), holdRefId);
  if (!hold.ok) return { ok: false, availableMicros: hold.availableMicros };
  return { ok: true, holdRefId };
}

// Settle actual usage against the request's hold. Unknown/unpriced models
// charge 0 but still release the hold — pricing gaps must not strand a
// customer's balance. Units: integer micro-USD. Ledger meta records the
// margin breakdown (charge vs official upstream cost) for reconciliation.
export async function settleCustomerUsage(customerId, holdRefId, provider, model, tokens, publicName = null) {
  const { settleUsage } = await import("@/lib/db/repos/ledgerRepo.js");
  const { getPricingForModel } = await import("@/lib/db/repos/pricingRepo.js");
  const { getSettings } = await import("@/lib/db/repos/settingsRepo.js");
  const settings = await getSettings();
  const pricing = (publicName && await getPublicSellPricing(publicName)) || await getSellPricing(provider, model);
  let chargeMicros = pricing ? estimateCostMicros(tokens, pricing) : 0;
  const minCharge = Math.max(0, Math.round(Number(settings.minimumChargeMicros) || 0));
  if (chargeMicros > 0 && chargeMicros < minCharge) chargeMicros = minCharge;
  const official = publicName && pricing?.official
    ? pricing.official // admin-entered official rates from getPublicSellPricing
    : await getPricingForModel(provider, model);
  const officialCostMicros = official ? estimateCostMicros(tokens, official) : 0;
  const result = await settleUsage(customerId, holdRefId, chargeMicros, {
    provider, model,
    chargeMicros,
    officialCostMicros,
    marginMicros: chargeMicros - officialCostMicros,
  });
  return { ...result, chargeMicros, officialCostMicros, marginMicros: chargeMicros - officialCostMicros };
}

// Release a request's hold without charging (margin-blocked requests, etc.).
export async function releaseHold(customerId, holdRefId) {
  const { settleUsage } = await import("@/lib/db/repos/ledgerRepo.js");
  return settleUsage(customerId, holdRefId, 0, { released: "no-charge" });
}

// Fail-open settle hook for the chatCore response handlers: billing must never
// break a response. A failed settle is logged loudly — it is not silently
// forgiven; the reserve row and usage row make it reconstructable.
export async function settleCustomerUsageSafe(customerBilling, provider, model, tokens) {
  if (!customerBilling?.customerId || !customerBilling?.holdRefId) return;
  try {
    await settleCustomerUsage(customerBilling.customerId, customerBilling.holdRefId, provider, model, tokens, customerBilling.publicName);
  } catch (err) {
    console.error(`[CustomerBilling] settle failed for ${customerBilling.customerId}/${customerBilling.holdRefId}:`, err?.message || err);
  }
}
