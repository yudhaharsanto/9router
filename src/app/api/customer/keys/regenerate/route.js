import { NextResponse } from "next/server";
import { requireCustomerSession } from "@/lib/auth/customerSession";
import { createCustomerKey, getActiveKeyForCustomer, revokeCustomerKey } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request) {
  const session = await requireCustomerSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const old = await getActiveKeyForCustomer(session.customerId);
  if (old) await revokeCustomerKey(old.id);
  const { key, record } = await createCustomerKey(session.customerId);
  // Plaintext rides THIS response only; DB keeps hash + mask.
  return NextResponse.json({ key, mask: record.keyMask });
}
