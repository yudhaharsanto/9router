// ShopeePay Partner gateway client (github.com/yudhaharsanto/shoppepay-api-gateway).
//
// Stateless pull API: POST /create-qris mints a dynamic QRIS for an amount,
// POST /check-payment scans the merchant's mutations for a matching amount
// after `startTime`. There is NO callback, so a topup only becomes paid when we
// poll — see shoppepayReconcile.js and the ?sync=1 branch of
// GET /api/customer/topups.
//
// Every sensitive endpoint requires `X-API-Key`. The key is server-only: the
// dashboard writes it to settings, GET /api/settings never returns it.
import { getSettings } from "@/lib/db/repos/settingsRepo.js";

const DEFAULT_BASE_URL = "https://shoppepay.pecuttai.my.id";
const TIMEOUT_MS = 15_000;

// Settings win over env (the admin dashboard is the normal path); env is the
// legacy/override route, mirroring how the Tako merchant key used to resolve.
// Returns null when no key is configured → callers fall back to manual mode.
export async function shoppepayConfig() {
  const settings = await getSettings();
  const baseUrl = String(settings.shoppepayBaseUrl || process.env.SHOPPEPAY_BASE_URL || DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  const apiKey = String(settings.shoppepayApiKey || process.env.SHOPPEPAY_API_KEY || "").trim();
  return apiKey ? { baseUrl, apiKey } : null;
}

async function call(config, path, payload) {
  const res = await fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": config.apiKey,
      "User-Agent": "9router/1.0",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.success === false) {
    throw new Error(body?.error || `shoppepay responded ${res.status}`);
  }
  return body;
}

// Mint a dynamic QRIS. The returned URL serves the QR image itself
// (/qr/:id, public), so the portal can render it inline.
export async function createQris(config, amountIdr) {
  const body = await call(config, "/create-qris", { amount: amountIdr });
  const qrisUrl = body?.data?.qris_url;
  if (!qrisUrl) throw new Error("shoppepay returned no qris_url");
  return { qrisUrl: String(qrisUrl), expiresAt: body?.data?.expires_at || null };
}

// Poll for a matching incoming payment. `startTime` is unix seconds and is the
// lower bound of the scanned window — pass the topup's createdAt so we never
// match a payment that predates the QR.
export async function checkPayment(config, { amountIdr, startTime }) {
  const body = await call(config, "/check-payment", { amount: amountIdr, startTime });
  const tx = body?.transaction;
  return {
    paid: body?.paid === true && !!tx?.transactionId,
    transactionId: tx?.transactionId ? String(tx.transactionId) : null,
    issuer: tx?.issuer || null,
  };
}
