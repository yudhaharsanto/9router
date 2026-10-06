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
    // Same-origin check against the host actually serving this request (and,
    // when configured, the admin-set public origin) — NOT the public-origin
    // fallback chain alone, which can end at http://localhost on a domain
    // deployment and 403 legitimate browser calls. Browsers always send a
    // truthful Origin, so comparing it to the request's own host is the
    // fail-closed CSRF check; non-browser clients send no Origin.
    const allowed = new Set(
      [await getPublicOrigin(request), new URL(request.url).origin]
        .filter(Boolean)
        .map((o) => o.replace(/\/+$/, ""))
    );
    if (!allowed.has(origin.replace(/\/+$/, ""))) {
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
