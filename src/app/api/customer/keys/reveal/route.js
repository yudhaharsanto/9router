import { NextResponse } from "next/server";
import { requireCustomerSession } from "@/lib/auth/customerSession.js";
import { getPublicOrigin } from "@/lib/auth/oidc";
import { revealCustomerKey } from "@/lib/db/repos/customerKeysRepo.js";

export const dynamic = "force-dynamic";

// POST /api/customer/keys/reveal — returns the active key's plaintext again
// (AES-256-GCM at rest, keyed off JWT_SECRET). Session-gated and same-origin
// gated like regenerate. Legacy rows without ciphertext reveal null → the
// portal falls back to regeneration.
export async function POST(request) {
  const session = await requireCustomerSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Same CSRF gate as regenerate: browsers always send Origin on cross-site
  // POSTs; non-browser clients send no Origin.
  const origin = request.headers.get("origin");
  if (origin) {
    const expected = getPublicOrigin(request) || new URL(request.url).origin;
    if (origin !== expected) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }
  const plaintext = await revealCustomerKey(session.customerId);
  if (!plaintext) {
    return NextResponse.json(
      { error: "Key cannot be revealed (created before re-reveal, or secret changed). Regenerate instead." },
      { status: 409 },
    );
  }
  return NextResponse.json({ key: plaintext }, { headers: { "Cache-Control": "no-store" } });
}
