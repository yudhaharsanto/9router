import { NextResponse } from "next/server";
import { requireCustomerSession } from "@/lib/auth/customerSession";
import { takeKeyReveal } from "@/lib/auth/customerProvision";
import { getBalance, getActiveKeyForCustomer, getCustomerById } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const session = await requireCustomerSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const customer = await getCustomerById(session.customerId);
  if (!customer || customer.status !== "active") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [balance, key] = await Promise.all([
    getBalance(session.customerId),
    getActiveKeyForCustomer(session.customerId),
  ]);

  const body = {
    customer: { id: customer.id, email: customer.email, name: customer.name },
    balance,
    key: key ? { mask: key.keyMask, createdAt: key.createdAt } : null,
  };

  const revealToken = new URL(request.url).searchParams.get("reveal");
  if (revealToken) {
    const plaintext = await takeKeyReveal(revealToken, session.customerId);
    if (plaintext) body.revealedKey = plaintext;
  }

  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}
