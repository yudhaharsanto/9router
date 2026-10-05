// Customer portal session — separate cookie + scope claim from the admin
// dashboard session. A crx_session grants NOTHING on admin APIs; an auth_token
// grants NOTHING here (getCustomerSession requires scope === "customer").
import { SignJWT, jwtVerify } from "jose";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir";
import { getPublicOrigin } from "@/lib/auth/oidc";

const SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60;

function loadJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(DATA_DIR, "jwt-secret");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {}
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

// Derive a customer-specific signing key from the shared JWT secret so a
// customer token can never verify as a dashboard token (or vice versa).
const SECRET = new TextEncoder().encode(
  crypto.createHmac("sha256", loadJwtSecret()).update("crx-customer-session-v1").digest("hex")
);

export async function shouldUseSecureCookie(request) {
  const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true";
  if (forceSecureCookie) return true;
  if (request?.headers?.get?.("x-forwarded-proto") === "https") return true;
  // BASE_URL=https://... or a direct https request — getPublicOrigin already
  // enforces trusted-host rules, so this adds no header-trust risk.
  try {
    return (await getPublicOrigin(request)).startsWith("https://");
  } catch {
    return false;
  }
}

export async function createCustomerAuthToken({ customerId }) {
  return new SignJWT({ scope: "customer", customerId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(SECRET);
}

// Test-only escape hatch: a valid-signature token WITHOUT the customer scope,
// to prove scope enforcement (an admin-shaped token must be rejected here).
export async function createAdminScopedTokenForTest() {
  return new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(SECRET);
}

export async function getCustomerSession(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, SECRET);
    if (payload.scope !== "customer" || !payload.customerId) return null;
    return { customerId: payload.customerId };
  } catch {
    return null;
  }
}

export async function setCustomerAuthCookie(cookieStore, request, token) {
  cookieStore.set("crx_session", token, {
    httpOnly: true,
    secure: await shouldUseSecureCookie(request),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
  });
}

export function clearCustomerAuthCookie(cookieStore) {
  cookieStore.delete("crx_session");
}

// Route guard: read + verify the cookie off the incoming request. Returns the
// session or null — callers respond 401 on null. Never throws.
export async function requireCustomerSession(request) {
  try {
    // Next.js requests expose .cookies; fall back to the raw cookie header
    // so plain Request objects (and non-Next callers) work too.
    let token = request.cookies?.get?.("crx_session")?.value || null;
    if (!token) {
      const header = request?.headers?.get?.("cookie") || "";
      token = Object.fromEntries(
        header.split(";").map((c) => c.trim().split("=")).filter((p) => p[0])
      )["crx_session"] || null;
    }
    return await getCustomerSession(token);
  } catch {
    return null;
  }
}
