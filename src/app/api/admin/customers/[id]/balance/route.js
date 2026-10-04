import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";
import { getCustomerById } from "@/lib/db/repos/customersRepo.js";
import { adjustBalance, getBalance } from "@/lib/db/repos/ledgerRepo.js";

export const dynamic = "force-dynamic";

const MICROS_PER_USD = 1_000_000;

// POST /api/admin/customers/[id]/balance — admin balance adjustment.
// { amountUsd: signed number, reason? } — positive credits, negative debits.
// A debit that would push the balance below zero is rejected (400); top-ups
// and usage are the audited flows, adjustment is for corrections.
export async function POST(request, ctx) {
  const { id } = await (ctx?.params ?? Promise.reject(new Error("params required")));
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)auth_token=([^;]+)/);
  const session = await getDashboardAuthSession(match ? decodeURIComponent(match[1]) : null);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const customer = await getCustomerById(id);
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const amountUsd = Number(body?.amountUsd);
  if (!Number.isFinite(amountUsd) || amountUsd === 0) {
    return NextResponse.json({ error: "amountUsd must be a non-zero number" }, { status: 400 });
  }
  const amountMicros = Math.round(amountUsd * MICROS_PER_USD);

  const balance = await getBalance(id);
  const next = balance.balanceMicros + amountMicros;
  if (next < 0) {
    return NextResponse.json(
      { error: `Adjustment would overdraw: balance ${balance.balanceMicros} µ$ + ${amountMicros} µ$ < 0` },
      { status: 400 },
    );
  }

  const reason = typeof body?.reason === "string" ? body.reason.slice(0, 500) : undefined;
  const result = await adjustBalance(id, amountMicros, { reason });
  return NextResponse.json({ ok: true, balance: result }, { headers: { "Cache-Control": "no-store" } });
}
