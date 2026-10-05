import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { NextResponse } from "next/server";
import { requireCustomerSession } from "@/lib/auth/customerSession";
import { getPublicOrigin } from "@/lib/auth/oidc";
import { getCustomerById } from "@/lib/db";
import { encryptKeyForStorage } from "@/lib/db/repos/customerKeysRepo.js";
import { getAdapter } from "@/lib/db/driver.js";

export const dynamic = "force-dynamic";

export async function POST(request) {
  const session = await requireCustomerSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // CSRF gate for the state-changing call: browsers always send Origin on
  // cross-site POSTs and SameSite=Lax already blocks those cookies, so this
  // defends same-site subdomain cases; non-browser clients send no Origin.
  const origin = request.headers.get("origin");
  if (origin) {
    // Empty getPublicOrigin (unset/misconfigured BASE_URL) → compare against
    // the request's own origin so the check stays fail-closed on host mismatch.
    const expected = await getPublicOrigin(request) || new URL(request.url).origin;
    if (origin !== expected) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }
  const customer = await getCustomerById(session.customerId);
  if (!customer || customer.status !== "active") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const db = await getAdapter();
  // One synchronous transaction: a failure between revoke and create must
  // never leave the customer with zero active keys. (Sync — an async callback
  // would escape the SAVEPOINT window.)
  const { plaintext, fresh } = db.transaction(() => {
    const row = db.get(
      `SELECT id FROM customerKeys WHERE customerId = ? AND revokedAt IS NULL ORDER BY createdAt DESC LIMIT 1`,
      [session.customerId]
    );
    if (row) {
      db.run(`UPDATE customerKeys SET revokedAt = ? WHERE id = ? AND revokedAt IS NULL`, [
        new Date().toISOString(),
        row.id,
      ]);
    }
    const plaintext = `sk-cust-${crypto.randomBytes(32).toString("hex")}`;
    const fresh = {
      id: uuidv4(),
      customerId: session.customerId,
      keyHash: crypto
        .createHmac("sha256", process.env.API_KEY_SECRET || "endpoint-proxy-api-key-secret")
        .update(plaintext)
        .digest("hex"),
      keyMask: `sk-cust-…${plaintext.slice(-4)}`,
      keyEnc: encryptKeyForStorage(plaintext),
      revokedAt: null,
      createdAt: new Date().toISOString(),
    };
    db.run(
      `INSERT INTO customerKeys(id, customerId, keyHash, keyMask, keyEnc, revokedAt, createdAt) VALUES(?, ?, ?, ?, ?, NULL, ?)`,
      [fresh.id, fresh.customerId, fresh.keyHash, fresh.keyMask, fresh.keyEnc, fresh.createdAt]
    );
    return { plaintext, fresh };
  });
  // Plaintext rides THIS response only; DB keeps hash + mask.
  return NextResponse.json({ key: plaintext, mask: fresh.keyMask });
}
