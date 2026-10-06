import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";
import { getCustomerById } from "@/lib/db/repos/customersRepo.js";
import { getActiveKeyForCustomer } from "@/lib/db/repos/customerKeysRepo.js";
import { getBalance } from "@/lib/db/repos/ledgerRepo.js";
import { getAdapter } from "@/lib/db/driver.js";

export const dynamic = "force-dynamic";

const API_KEY_SECRET = process.env.API_KEY_SECRET || "endpoint-proxy-api-key-secret";

function hashKey(plaintext) {
  return crypto.createHmac("sha256", API_KEY_SECRET).update(plaintext).digest("hex");
}

// GET /api/admin/customers/[id]/usage — admin view of one customer's request
// history. Same data the portal sees: usageHistory rows matched to the
// customer's active key by HMAC hash, joined to their ledger usage_debit
// entries for the actually-charged micros (usageHistory.cost is the official
// catalog estimate, not what the customer paid).
export async function GET(request, { params }) {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)auth_token=([^;]+)/);
  const session = await getDashboardAuthSession(match ? decodeURIComponent(match[1]) : null);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const customer = await getCustomerById(id);
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const active = await getActiveKeyForCustomer(customer.id);
  if (!active) {
    return NextResponse.json({ customer: { id: customer.id, email: customer.email, name: customer.name }, items: [], totals: { officialMicros: 0, chargedMicros: 0 } }, { headers: { "Cache-Control": "no-store" } });
  }

  const url = new URL(request.url);
  const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit")) || 100), 500);

  // ponytail: same in-memory scan cap as the portal route (1000 latest rows);
  // if volume makes that wrong, add a keyHash column + index to usageHistory
  // and move the filter into SQL.
  const db = await getAdapter();
  const rows = db.all(
    `SELECT timestamp, provider, model, promptTokens, completionTokens, cost, status, apiKey, meta
     FROM usageHistory ORDER BY id DESC LIMIT 1000`
  );
  const keyHash = active.keyHash;
  const parseMeta = (raw) => {
    try { return JSON.parse(raw || "{}") || {}; } catch { return {}; }
  };
  const items = rows
    .filter((r) => r.apiKey && hashKey(r.apiKey) === keyHash)
    .slice(0, limit)
    .map((r) => ({
      timestamp: r.timestamp,
      provider: r.provider,
      model: r.model,
      promptTokens: r.promptTokens ?? 0,
      completionTokens: r.completionTokens ?? 0,
      cost: r.cost,
      status: r.status,
      keyMask: active.keyMask,
      meta: parseMeta(r.meta),
    }));

  // Per-request charges from this customer's ledger in the same window as the
  // listed rows (or recent window if fewer than the cap exist).
  const debitRows = db.all(
    `SELECT refId, amountMicros, createdAt FROM ledger
      WHERE customerId = ? AND type = 'usage_debit'
      ORDER BY createdAt DESC LIMIT 1000`,
    [customer.id]
  );
  const chargedByHoldRef = new Map(debitRows.map((d) => [d.refId, -Number(d.amountMicros)]));
  for (const item of items) {
    item.chargedMicros = chargedByHoldRef.get(item.meta.holdRefId) ?? null;
  }
  const chargedMicros = -debitRows.reduce((s, d) => s + Number(d.amountMicros), 0);
  const officialMicros = Math.round(items.reduce((s, r) => s + (Number(r.cost) || 0) * 1_000_000, 0));
  const balance = await getBalance(customer.id);

  return NextResponse.json(
    {
      customer: { id: customer.id, email: customer.email, name: customer.name, status: customer.status },
      keyMask: active.keyMask,
      balanceMicros: balance.balanceMicros,
      items,
      totals: { officialMicros, chargedMicros },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
