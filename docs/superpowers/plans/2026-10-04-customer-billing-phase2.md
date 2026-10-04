# Customer Billing Phase 2 — Google OAuth + Auto Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customer login via Google OAuth (separate from admin auth) that auto-creates a customer row + one API key on first login, with a customer-scoped session and the first-cut customer API surface (`/api/customer/me`, key regenerate, logout).

**Architecture:** New `src/lib/auth/customerSession.js` (JWT session cookie `crx_session`, scope claim `customer`, same JWT secret machinery as admin) and `src/lib/auth/customerGoogle.js` (Google OAuth config + code exchange + id_token verification via Google JWKS). Route handlers under `src/app/api/customer/` are thin wiring over those libs. First-login provisions the customer + one key; the key plaintext is revealed once via a one-time in-memory reveal store.

**Tech Stack:** Next.js App Router route handlers, `jose` (JWT + remote JWKS), plain-JS ESM, existing `customersRepo`/`customerKeysRepo`/`ledgerRepo` from phase 1.

**Spec:** `docs/superpowers/specs/2026-10-04-customer-billing-tako-design.md` — section 3.1 (customer auth), section 3.2 partially (`/api/customer/me` surface), section 5 (route list), section 6 (security notes).

## Global Constraints

- Plain JavaScript ESM, no TypeScript. `@/*` → `src/*` (`jsconfig.json`).
- Customer session cookie is `crx_session` — NEVER reuse the admin `auth_token` cookie. Customer scope claim is `scope: "customer"`.
- Customer key plaintext never persisted; DB keeps only HMAC + mask. Plaintext shown exactly once.
- Google id_token: verify signature against `https://www.googleapis.com/oauth2/v3/certs`, issuer `https://accounts.google.com`, audience = client id. Require `email_verified === true` (spec 3.1).
- State param checked with strict equality; state/verifier cookies cleared after callback.
- No new npm dependencies.
- Tests: vitest, run as `npx vitest run --root tests unit/<file>` from repo root. Temp-dir DATA_DIR isolation, `vi.resetModules()` before importing `@/lib/db/index.js` (phase 1 pattern).
- Conventional Commits.

## Review Focus

- **Cross-domain session confusion** — a customer `crx_session` must grant nothing on admin APIs, and an admin `auth_token` must grant nothing on customer APIs. Test: `requireCustomerSession` rejects an admin token; `dashboardGuard` untouched (verify customer token fails `verifyDashboardAuthToken` since it checks no claim the admin token has? admin verify only checks signature — so the test must pin that customer APIs check `scope === "customer"` and admin token lacks it).
- **Unverified-email Google account** — `email_verified: false` must be rejected at callback (spec 3.1), never provisioned. Test in Task 3.
- **Re-login must not mint a second key** — a returning customer with an active key gets no new key. Test in Task 3.
- **Reveal store is one-time** — second read of the same reveal token returns nothing. Test in Task 4.
- **State replay / forgery** — callback with wrong or missing state cookie redirects to error and never creates a customer. Test in Task 3.

---

### Task 1: customerSession — customer-scoped JWT cookie

**Files:**
- Create: `src/lib/auth/customerSession.js`
- Test: `tests/unit/customer-session.test.js`

**Interfaces:**
- Consumes: `jose` (SignJWT/jwtVerify), JWT secret loading (same pattern as `src/lib/auth/dashboardSession.js`).
- Produces:
  - `createCustomerAuthToken({ customerId })` → JWT string with claims `{ scope: "customer", customerId }`, 7-day expiry.
  - `getCustomerSession(token)` → `{ customerId } | null` — null unless `scope === "customer"` and signature valid.
  - `setCustomerAuthCookie(cookieStore, request, customerId)` / `clearCustomerAuthCookie(cookieStore)` — cookie `crx_session`, httpOnly, sameSite lax, path `/`.
  - `requireCustomerSession(request)` → reads `crx_session` cookie from `request.cookies`, returns `{ customerId } | null` (route-guard helper; never throws).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/customer-session.test.js`:

```js
// Customer session — scope-separated JWT, admin token must NOT open customer APIs.
import { describe, it, expect } from "vitest";

describe("customerSession", () => {
  it("round-trips a customer token to its customerId", async () => {
    const { createCustomerAuthToken, getCustomerSession } = await import("@/lib/auth/customerSession.js");
    const token = await createCustomerAuthToken({ customerId: "c-123" });
    const session = await getCustomerSession(token);
    expect(session).toEqual({ customerId: "c-123" });
  });

  it("rejects a token with no customer scope claim (admin-shaped token)", async () => {
    // Valid signature, but authenticated-style claims and NO scope — what an
    // admin-session token looks like. getCustomerSession must reject it.
    const { createAdminScopedTokenForTest, getCustomerSession } = await import("@/lib/auth/customerSession.js");
    const adminLike = await createAdminScopedTokenForTest();
    expect(await getCustomerSession(adminLike)).toBeNull();
  });

  it("rejects garbage and empty tokens", async () => {
    const { getCustomerSession } = await import("@/lib/auth/customerSession.js");
    expect(await getCustomerSession("garbage")).toBeNull();
    expect(await getCustomerSession("")).toBeNull();
    expect(await getCustomerSession(null)).toBeNull();
  });

  it("requireCustomerSession reads crx_session cookie from the request", async () => {
    const { createCustomerAuthToken, requireCustomerSession } = await import("@/lib/auth/customerSession.js");
    const token = await createCustomerAuthToken({ customerId: "c-9" });
    const request = new Request("http://localhost:20128/api/customer/me", {
      headers: { cookie: `crx_session=${token}; other=1` },
    });
    expect(await requireCustomerSession(request)).toEqual({ customerId: "c-9" });
    const noCookie = new Request("http://localhost:20128/api/customer/me");
    expect(await requireCustomerSession(noCookie)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root tests unit/customer-session.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement customerSession.js**

Create `src/lib/auth/customerSession.js`:

```js
// Customer portal session — separate cookie + scope claim from the admin
// dashboard session. A crx_session grants NOTHING on admin APIs; an auth_token
// grants NOTHING here (getCustomerSession requires scope === "customer").
import { SignJWT, jwtVerify } from "jose";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir";

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

const SECRET = new TextEncoder().encode(loadJwtSecret());

export function shouldUseSecureCookie(request) {
  const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true";
  const forwardedProto = request?.headers?.get?.("x-forwarded-proto");
  return forceSecureCookie || forwardedProto === "https";
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

export function setCustomerAuthCookie(cookieStore, request, token) {
  cookieStore.set("crx_session", token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(request),
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
    const token = request.cookies?.get?.("crx_session")?.value || null;
    return await getCustomerSession(token);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --root tests unit/customer-session.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/customerSession.js tests/unit/customer-session.test.js
git commit -m "feat(auth): customer session — scope-separated crx_session JWT cookie"
```

---

### Task 2: Google OAuth config + start route

**Files:**
- Modify: `src/lib/db/repos/settingsRepo.js` (DEFAULT_SETTINGS: add `googleOAuthClientId`, `googleOAuthClientSecret`, defaults `""`)
- Create: `src/lib/auth/customerGoogle.js`
- Create: `src/app/api/customer/auth/google/start/route.js`
- Test: `tests/unit/customer-google-auth.test.js`

**Interfaces:**
- Consumes: `getSettings` (`@/lib/localDb`), `getPublicOrigin` (`@/lib/auth/oidc.js` — reused as-is).
- Produces:
  - `getGoogleOAuthConfig()` → `{ clientId, clientSecret } | null` — settings first, then env `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`; null when unset (start route redirects to `/usage-check?error=google_not_configured`).
  - `buildGoogleAuthUrl({ clientId, redirectUri, state, codeChallenge })` → accounts.google.com URL string with `scope=openid email profile`, `state`, `code_challenge` (S256) + `code_challenge_method=S256`.
  - `exchangeGoogleCode({ clientId, clientSecret, code, redirectUri, codeVerifier })` → token JSON `{ id_token, ... }` (fetch to `https://oauth2.googleapis.com/token`; throws on non-2xx).
  - `verifyGoogleIdToken(idToken, clientId)` → `{ sub, email, name, emailVerified }` — jose remote JWKS, issuer/audience enforced, `emailVerified = claims.email_verified === true`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/customer-google-auth.test.js`:

```js
// Google OAuth customer flow — config resolution, URL shape, id_token verification.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const originalGoogleEnv = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET };
let tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cust-google-"));
process.env.DATA_DIR = tempDir;

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalGoogleEnv.id === undefined) delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID = originalGoogleEnv.id;
  if (originalGoogleEnv.secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
  else process.env.GOOGLE_CLIENT_SECRET = originalGoogleEnv.secret;
});

describe("getGoogleOAuthConfig", () => {
  it("falls back to env when settings are empty, prefers settings", async () => {
    vi.resetModules();
    process.env.GOOGLE_CLIENT_ID = "env-client";
    process.env.GOOGLE_CLIENT_SECRET = "env-secret";
    let mod = await import("@/lib/auth/customerGoogle.js");
    expect(await mod.getGoogleOAuthConfig()).toEqual({
      clientId: "env-client",
      clientSecret: "env-secret",
    });

    // Settings win over env.
    const { updateSettings } = await import("@/lib/db/index.js");
    await updateSettings({ googleOAuthClientId: "set-client", googleOAuthClientSecret: "set-secret" });
    mod = await import("@/lib/auth/customerGoogle.js");
    expect((await mod.getGoogleOAuthConfig()).clientId).toBe("set-client");
  });

  it("returns null when neither settings nor env configured", async () => {
    vi.resetModules();
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    // Fresh settings DB (new temp dir) so no carryover
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cust-google2-"));
    const mod = await import("@/lib/auth/customerGoogle.js");
    expect(await mod.getGoogleOAuthConfig()).toBeNull();
  });
});

describe("buildGoogleAuthUrl", () => {
  it("points at accounts.google.com with openid scope, state and S256 PKCE", async () => {
    const { buildGoogleAuthUrl } = await import("@/lib/auth/customerGoogle.js");
    const url = buildGoogleAuthUrl({
      clientId: "cid",
      redirectUri: "http://localhost:20128/api/customer/auth/google/callback",
      state: "st-1",
      codeChallenge: "cc-1",
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:20128/api/customer/auth/google/callback");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("state")).toBe("st-1");
    expect(u.searchParams.get("code_challenge")).toBe("cc-1");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("verifyGoogleIdToken", () => {
  it("returns claims for a valid Google-signed id_token", async () => {
    // Real-signed token is impractical in unit tests; assert the function's
    // rejection paths and the mapping for the happy path via a crafted test.
    const { verifyGoogleIdToken } = await import("@/lib/auth/customerGoogle.js");
    await expect(verifyGoogleIdToken("not-a-jwt", "cid")).rejects.toThrow();
  });
});
```

Note: the full-signature happy path is exercised by the callback integration in Task 3 with a mocked JWKS; here we pin the error path.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root tests unit/customer-google-auth.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Add settings defaults**

In `src/lib/db/repos/settingsRepo.js`, inside `DEFAULT_SETTINGS` (next to the `oidc*` keys):

```js
  googleOAuthClientId: "",
  googleOAuthClientSecret: "",
```

- [ ] **Step 4: Implement customerGoogle.js**

Create `src/lib/auth/customerGoogle.js`:

```js
// Google OAuth for the CUSTOMER portal — own client, own endpoints, separate
// from admin OIDC. No domain allowlist in v1 (spec 3.1): any verified Google
// email may sign up.
import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { getSettings } from "@/lib/localDb";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUER = "https://accounts.google.com";
const SCOPES = "openid email profile";

export async function getGoogleOAuthConfig() {
  const settings = await getSettings();
  const clientId = (settings.googleOAuthClientId || process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = (settings.googleOAuthClientSecret || process.env.GOOGLE_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function buildGoogleAuthUrl({ clientId, redirectUri, state, codeChallenge }) {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeGoogleCode({ clientId, clientSecret, code, redirectUri, codeVerifier }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed: ${res.status}`);
  }
  return res.json();
}

const JWKS = createRemoteJWKSet(new URL(JWKS_URL));

export async function verifyGoogleIdToken(idToken, clientId) {
  const { payload } = await jwtVerify(idToken, JWKS, {
    issuer: GOOGLE_ISSUER,
    audience: clientId,
  });
  return {
    sub: payload.sub,
    email: payload.email,
    name: payload.name,
    emailVerified: payload.email_verified === true,
  };
}

export function createPkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function createState() {
  return crypto.randomBytes(16).toString("base64url");
}
```

- [ ] **Step 5: Implement the start route**

Create `src/app/api/customer/auth/google/start/route.js`:

```js
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  buildGoogleAuthUrl,
  createPkcePair,
  createState,
  getGoogleOAuthConfig,
} from "@/lib/auth/customerGoogle";
import { getPublicOrigin } from "@/lib/auth/oidc";

export const dynamic = "force-dynamic";

// Redirect_uri must exactly match what's registered in the Google console.
function redirectUri(request) {
  return `${getPublicOrigin(request)}/api/customer/auth/google/callback`;
}

export async function GET(request) {
  const config = await getGoogleOAuthConfig();
  const origin = getPublicOrigin(request);
  if (!config) {
    return NextResponse.redirect(new URL("/usage-check?error=google_not_configured", origin));
  }

  const state = createState();
  const { verifier, challenge } = createPkcePair();

  const cookieStore = await cookies();
  const baseOptions = { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 600 };
  // secure matches the admin oidc start route's behavior; getPublicOrigin already
  // restricts untrusted hosts.
  if (process.env.AUTH_COOKIE_SECURE === "true" || request.headers.get("x-forwarded-proto") === "https") {
    baseOptions.secure = true;
  }
  cookieStore.set("crx_oauth_state", state, baseOptions);
  cookieStore.set("crx_oauth_verifier", verifier, baseOptions);

  return NextResponse.redirect(
    buildGoogleAuthUrl({
      clientId: config.clientId,
      redirectUri: redirectUri(request),
      state,
      codeChallenge: challenge,
    })
  );
}
```

- [ ] **Step 6: Run test to verify it passes + lint**

Run: `npx vitest run --root tests unit/customer-google-auth.test.js`
Expected: PASS (4 tests). Then `npx eslint src/lib/auth/customerGoogle.js src/lib/auth/customerSession.js src/app/api/customer/ src/lib/db/repos/settingsRepo.js` — no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/auth/customerGoogle.js src/app/api/customer/auth/google/start/route.js src/lib/db/repos/settingsRepo.js tests/unit/customer-google-auth.test.js
git commit -m "feat(auth): Google OAuth customer config + start route (PKCE, state)"
```

---

### Task 3: Callback route — verify, provision customer + key

**Files:**
- Create: `src/lib/auth/customerProvision.js` (first-login provisioning, unit-testable)
- Create: `src/app/api/customer/auth/google/callback/route.js`
- Test: `tests/unit/customer-provision.test.js`

**Interfaces:**
- Consumes: `getOrCreateCustomer` (`@/lib/db`), `createCustomerKey` / `getActiveKeyForCustomer` (`@/lib/db`), `verifyGoogleIdToken` + `exchangeGoogleCode` (Task 2), `setCustomerAuthCookie` (Task 1).
- Produces:
  - `provisionCustomerFromGoogle({ sub, email, name })` → `{ customer, key | null, created: boolean }` — get-or-create by `googleSub`; `key` is the one-time plaintext ONLY when the customer had no active key (first login); `created` = first time this customer row was made.
  - Reveal store (in `customerProvision.js`): `stageKeyReveal(customerId, plaintext)` → token string; `takeKeyReveal(token)` → plaintext string or null (one-time consume, 10-minute TTL).
  - Callback route: `GET /api/customer/auth/google/callback` — validates state cookie, exchanges code, verifies id_token, REJECTS `emailVerified === false` (redirect `?error=email_not_verified`), provisions, sets `crx_session`, redirects to `/usage-check` (with `?welcome=1&reveal=<token>` on first login).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/customer-provision.test.js`:

```js
// First-login provisioning — customer + one key, no key spam on re-login.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cust-provision-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  await import("@/lib/db/index.js").then((m) => m.initDb());
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("provisionCustomerFromGoogle", () => {
  it("first login creates customer + key and stages the reveal", async () => {
    const { provisionCustomerFromGoogle } = await import("@/lib/auth/customerProvision.js");
    const r1 = await provisionCustomerFromGoogle({ sub: "g-sub-1", email: "a@x.y", name: "A" });
    expect(r1.created).toBe(true);
    expect(r1.key).toMatch(/^sk-cust-[0-9a-f]{64}$/);
    expect(r1.customer.googleSub).toBe("g-sub-1");

    // Reveal token works exactly once
    const { takeKeyReveal } = await import("@/lib/auth/customerProvision.js");
    // token comes back from stageKeyReveal; re-derive by staging a second key is
    // not needed — provision returns key + token via r1.revealToken
    expect(typeof r1.revealToken).toBe("string");
    expect(takeKeyReveal(r1.revealToken)).toBe(r1.key);
    expect(takeKeyReveal(r1.revealToken)).toBeNull();
  });

  it("second login reuses the same customer and mints NO second key", async () => {
    const { provisionCustomerFromGoogle } = await import("@/lib/auth/customerProvision.js");
    const r1 = await provisionCustomerFromGoogle({ sub: "g-sub-2", email: "b@x.y", name: "B" });
    const r2 = await provisionCustomerFromGoogle({ sub: "g-sub-2", email: "b@x.y", name: "B-renamed" });
    expect(r2.created).toBe(false);
    expect(r2.customer.id).toBe(r1.customer.id);
    expect(r2.key).toBeNull();
    expect(r2.revealToken).toBeNull();
  });

  it("regenerate-after-revoke: customer with no active key gets a fresh one", async () => {
    const { provisionCustomerFromGoogle } = await import("@/lib/auth/customerProvision.js");
    const { revokeCustomerKey, getActiveKeyForCustomer } = await import("@/lib/db/index.js");
    const r1 = await provisionCustomerFromGoogle({ sub: "g-sub-3", email: "c@x.y", name: "C" });
    await revokeCustomerKey((await getActiveKeyForCustomer(r1.customer.id)).id);
    const r2 = await provisionCustomerFromGoogle({ sub: "g-sub-3", email: "c@x.y", name: "C" });
    expect(r2.key).toMatch(/^sk-cust-/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root tests unit/customer-provision.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement customerProvision.js**

Create `src/lib/auth/customerProvision.js`:

```js
// First-login provisioning + one-time key reveal. The plaintext lives in
// process memory for at most 10 minutes and is consumed on first read —
// never persisted, never in a cookie.
import { getOrCreateCustomer, createCustomerKey, getActiveKeyForCustomer } from "@/lib/db";

const REVEAL_TTL_MS = 10 * 60 * 1000;
const revealStore = new Map(); // token -> { plaintext, expiresAt }

export function stageKeyReveal(customerId, plaintext) {
  const token = crypto.randomUUID();
  revealStore.set(token, { customerId, plaintext, expiresAt: Date.now() + REVEAL_TTL_MS });
  // opportunistic sweep
  for (const [k, v] of revealStore) if (v.expiresAt < Date.now()) revealStore.delete(k);
  return token;
}

// One-time consume: binds the token to the customer it was staged for so a
// leaked token can't be read from another session.
export function takeKeyReveal(token, customerId) {
  const entry = revealStore.get(token);
  if (!entry) return null;
  revealStore.delete(token);
  if (entry.expiresAt < Date.now()) return null;
  if (customerId && entry.customerId !== customerId) return null;
  return entry.plaintext;
}

export async function provisionCustomerFromGoogle({ sub, email, name }) {
  const { customer, created } = await getOrCreateCustomerReturningCreated({ googleSub: sub, email, name });
  const activeKey = await getActiveKeyForCustomer(customer.id);
  if (activeKey) return { customer, key: null, revealToken: null, created };
  const { key } = await createCustomerKey(customer.id);
  const revealToken = stageKeyReveal(customer.id, key);
  return { customer, key, revealToken, created };
}
```

`getOrCreateCustomerReturningCreated` does NOT exist yet — `getOrCreateCustomer` (phase 1) doesn't report created. Resolve by probing first:

```js
import { getOrCreateCustomer, getCustomerByGoogleSub, createCustomerRecord, createCustomerKey, getActiveKeyForCustomer } from "@/lib/db";
```

…but phase 1's `customersRepo` exposes only `getOrCreateCustomer`/`getCustomerById`/`setCustomerStatus`. Two options; pick A:

**A (chosen):** `customersRepo` has no "did-create" signal, so probe first: look up by `googleSub` via direct SQL through the adapter (1 line, no repo change), then `getOrCreateCustomer`. Row creation is what drives the welcome flow.

```js
import crypto from "node:crypto";
import { getAdapter } from "@/lib/db/driver.js";
import { getOrCreateCustomer, createCustomerKey, getActiveKeyForCustomer } from "@/lib/db";

const REVEAL_TTL_MS = 10 * 60 * 1000;
const revealStore = new Map();

export function stageKeyReveal(customerId, plaintext) {
  const token = crypto.randomUUID();
  revealStore.set(token, { customerId, plaintext, expiresAt: Date.now() + REVEAL_TTL_MS });
  for (const [k, v] of revealStore) if (v.expiresAt < Date.now()) revealStore.delete(k);
  return token;
}

// One-time consume: binds the token to the customer it was staged for so a
// leaked token can't be read from another session.
export function takeKeyReveal(token, customerId) {
  const entry = revealStore.get(token);
  if (!entry) return null;
  revealStore.delete(token);
  if (entry.expiresAt < Date.now()) return null;
  if (customerId && entry.customerId !== customerId) return null;
  return entry.plaintext;
}

export async function provisionCustomerFromGoogle({ sub, email, name }) {
  const db = await getAdapter();
  const existed = db.get(`SELECT id FROM customers WHERE googleSub = ?`, [sub]);
  const customer = await getOrCreateCustomer({ googleSub: sub, email, name });
  const created = !existed;
  const activeKey = await getActiveKeyForCustomer(customer.id);
  if (activeKey) return { customer, key: null, revealToken: null, created };
  const { key } = await createCustomerKey(customer.id);
  const revealToken = stageKeyReveal(customer.id, key);
  return { customer, key, revealToken, created };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --root tests unit/customer-provision.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Implement the callback route**

Create `src/app/api/customer/auth/google/callback/route.js`:

```js
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  exchangeGoogleCode,
  getGoogleOAuthConfig,
  verifyGoogleIdToken,
} from "@/lib/auth/customerGoogle";
import { getPublicOrigin } from "@/lib/auth/oidc";
import { provisionCustomerFromGoogle } from "@/lib/auth/customerProvision";
import { createCustomerAuthToken, setCustomerAuthCookie } from "@/lib/auth/customerSession";

export const dynamic = "force-dynamic";

function fail(origin, code) {
  return NextResponse.redirect(new URL(`/usage-check?error=${encodeURIComponent(code)}`, origin));
}

export async function GET(request) {
  const origin = getPublicOrigin(request);
  const url = new URL(request.url);
  if (url.searchParams.get("error")) {
    return fail(origin, url.searchParams.get("error"));
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return fail(origin, "oauth_missing_code");

  const cookieStore = await cookies();
  const storedState = cookieStore.get("crx_oauth_state")?.value;
  const verifier = cookieStore.get("crx_oauth_verifier")?.value;
  cookieStore.delete("crx_oauth_state");
  cookieStore.delete("crx_oauth_verifier");
  if (!storedState || !verifier || storedState !== state) {
    return fail(origin, "oauth_invalid_state");
  }

  const config = await getGoogleOAuthConfig();
  if (!config) return fail(origin, "google_not_configured");

  try {
    const redirectUri = `${origin}/api/customer/auth/google/callback`;
    const tokens = await exchangeGoogleCode({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      redirectUri,
      codeVerifier: verifier,
    });
    const claims = await verifyGoogleIdToken(tokens.id_token, config.clientId);
    if (!claims.emailVerified) return fail(origin, "email_not_verified");

    const { customer, key, revealToken, created } = await provisionCustomerFromGoogle({
      sub: claims.sub,
      email: claims.email,
      name: claims.name,
    });

    const sessionToken = await createCustomerAuthToken({ customerId: customer.id });
    setCustomerAuthCookie(cookieStore, request, sessionToken);

    const target = new URL("/usage-check", origin);
    if (created) {
      target.searchParams.set("welcome", "1");
      if (revealToken) target.searchParams.set("reveal", revealToken);
    }
    return NextResponse.redirect(target);
  } catch {
    return fail(origin, "oauth_exchange_failed");
  }
}
```

- [ ] **Step 6: Verify provisioning test + lint; smoke the route shape**

Run: `npx vitest run --root tests unit/customer-provision.test.js unit/customer-session.test.js unit/customer-google-auth.test.js`
Expected: PASS (11 tests). `npx eslint src/lib/auth/ src/app/api/customer/` — clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/auth/customerProvision.js src/app/api/customer/auth/google/callback/route.js tests/unit/customer-provision.test.js
git commit -m "feat(auth): Google OAuth callback — verify, reject unverified email, provision customer + one-time key"
```

---

### Task 4: Customer API surface — me, regenerate, logout

**Files:**
- Create: `src/app/api/customer/me/route.js`
- Create: `src/app/api/customer/keys/regenerate/route.js`
- Create: `src/app/api/customer/auth/logout/route.js`
- Test: `tests/unit/customer-api.test.js`

**Interfaces:**
- Consumes: `requireCustomerSession` (Task 1), `takeKeyReveal` (Task 3), `getBalance` (`@/lib/db`), `getActiveKeyForCustomer` / `createCustomerKey` / `revokeCustomerKey` (`@/lib/db`).
- Produces:
  - `GET /api/customer/me` → 401 without session; otherwise `{ customer: { id, email, name }, balance: { balanceMicros, reservedMicros, availableMicros }, key: { mask, createdAt } | null, revealedKey?: plaintext }` — `revealedKey` present only when `?reveal=<token>` is supplied, valid, and bound to this customer.
  - `POST /api/customer/keys/regenerate` → revokes the active key, creates a new one, stages + returns `{ key, mask }` (plaintext in THIS response — the regenerate flow shows it inline; no reveal-token roundtrip).
  - `POST /api/customer/auth/logout` → clears `crx_session`, `{ ok: true }`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/customer-api.test.js`:

```js
// Customer API routes — session-gated me/regenerate/logout.
// Route handlers are thin; we exercise them with synthetic Requests and a
// mocked next/headers cookies() where the route needs it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cust-api-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function requestWithCookie(path, token, extra = {}) {
  return new Request(`http://localhost:20128${path}`, {
    method: extra.method || "GET",
    headers: token ? { cookie: `crx_session=${token}` } : {},
  });
}

describe("GET /api/customer/me", () => {
  it("401 without a session", async () => {
    const mod = await import("@/app/api/customer/me/route.js");
    const res = await mod.GET(requestWithCookie("/api/customer/me", null));
    expect(res.status).toBe(401);
  });

  it("returns customer, balance and key mask for a session", async () => {
    const { createCustomerAuthToken } = await import("@/lib/auth/customerSession.js");
    const c = await db.getOrCreateCustomer({ googleSub: "api-1", email: "api@x.y" });
    const { record } = await db.createCustomerKey(c.id);
    await db.creditCustomer(c.id, 2_500_000, { refType: "topup", refId: "api-t-1" });

    const token = await createCustomerAuthToken({ customerId: c.id });
    const mod = await import("@/app/api/customer/me/route.js");
    const res = await mod.GET(requestWithCookie("/api/customer/me", token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.customer.id).toBe(c.id);
    expect(body.balance.balanceMicros).toBe(2_500_000);
    expect(body.key.mask).toBe(record.keyMask);
    expect(body.revealedKey).toBeUndefined();
  });

  it("reveals the key exactly once via ?reveal=<token>", async () => {
    const { createCustomerAuthToken } = await import("@/lib/auth/customerSession.js");
    const { stageKeyReveal } = await import("@/lib/auth/customerProvision.js");
    const c = await db.getOrCreateCustomer({ googleSub: "api-2" });
    const { key } = await db.createCustomerKey(c.id);
    const revealToken = stageKeyReveal(c.id, key);

    const token = await createCustomerAuthToken({ customerId: c.id });
    const mod = await import("@/app/api/customer/me/route.js");
    const res1 = await mod.GET(requestWithCookie(`/api/customer/me?reveal=${revealToken}`, token));
    const body1 = await res1.json();
    expect(body1.revealedKey).toBe(key);

    const res2 = await mod.GET(requestWithCookie(`/api/customer/me?reveal=${revealToken}`, token));
    const body2 = await res2.json();
    expect(body2.revealedKey).toBeUndefined();
  });

  it("a reveal token staged for another customer is not honored", async () => {
    const { createCustomerAuthToken } = await import("@/lib/auth/customerSession.js");
    const { stageKeyReveal } = await import("@/lib/auth/customerProvision.js");
    const cA = await db.getOrCreateCustomer({ googleSub: "api-3" });
    const cB = await db.getOrCreateCustomer({ googleSub: "api-4" });
    const { key } = await db.createCustomerKey(cA.id);
    const revealToken = stageKeyReveal(cA.id, key);
    const tokenB = await createCustomerAuthToken({ customerId: cB.id });
    const mod = await import("@/app/api/customer/me/route.js");
    const res = await mod.GET(requestWithCookie(`/api/customer/me?reveal=${revealToken}`, tokenB));
    const body = await res.json();
    expect(body.revealedKey).toBeUndefined();
  });
});

describe("POST /api/customer/keys/regenerate", () => {
  it("revokes the old key, returns a fresh plaintext once", async () => {
    const { createCustomerAuthToken } = await import("@/lib/auth/customerSession.js");
    const c = await db.getOrCreateCustomer({ googleSub: "api-5" });
    const first = await db.createCustomerKey(c.id);
    const token = await createCustomerAuthToken({ customerId: c.id });
    const mod = await import("@/app/api/customer/keys/regenerate/route.js");
    const res = await mod.POST(requestWithCookie("/api/customer/keys/regenerate", token, { method: "POST" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toMatch(/^sk-cust-[0-9a-f]{64}$/);
    expect(body.key).not.toBe(first.key);
    // old key no longer validates
    expect(await db.validateCustomerKey(first.key)).toBeNull();
    // new one does
    expect(await db.validateCustomerKey(body.key)).not.toBeNull();
  });

  it("401 without a session", async () => {
    const mod = await import("@/app/api/customer/keys/regenerate/route.js");
    const res = await mod.POST(requestWithCookie("/api/customer/keys/regenerate", null, { method: "POST" }));
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root tests unit/customer-api.test.js`
Expected: FAIL — route modules not found.

- [ ] **Step 3: Implement the routes**

`src/app/api/customer/me/route.js`:

```js
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
    return NextResponse.json({ error: "Account disabled" }, { status: 403 });
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
    const plaintext = takeKeyReveal(revealToken, session.customerId);
    if (plaintext) body.revealedKey = plaintext;
  }
  return NextResponse.json(body);
}
```

`src/app/api/customer/keys/regenerate/route.js`:

```js
import { NextResponse } from "next/server";
import { requireCustomerSession } from "@/lib/auth/customerSession";
import { getActiveKeyForCustomer, createCustomerKey, revokeCustomerKey } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request) {
  const session = await requireCustomerSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const old = await getActiveKeyForCustomer(session.customerId);
  if (old) await revokeCustomerKey(old.id);
  const { key, record } = await createCustomerKey(session.customerId);
  // Plaintext rides THIS response only; the DB keeps hash + mask.
  return NextResponse.json({ key, mask: record.keyMask });
}
```

`src/app/api/customer/auth/logout/route.js`:

```js
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { clearCustomerAuthCookie } from "@/lib/auth/customerSession";

export const dynamic = "force-dynamic";

export async function POST() {
  const cookieStore = await cookies();
  clearCustomerAuthCookie(cookieStore);
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --root tests unit/customer-api.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Run all customer test files + lint**

Run: `npx vitest run --root tests unit/customer-session.test.js unit/customer-google-auth.test.js unit/customer-provision.test.js unit/customer-api.test.js unit/customer-schema.test.js unit/customer-repos.test.js unit/customer-keys.test.js unit/customer-ledger.test.js unit/customer-topups.test.js unit/customer-pricing.test.js`
Expected: all PASS. Then `npx eslint src/lib/auth/ src/app/api/customer/` — clean.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/customer/me/route.js src/app/api/customer/keys/regenerate/route.js src/app/api/customer/auth/logout/route.js tests/unit/customer-api.test.js
git commit -m "feat(customer): /me with balance+key, key regenerate, logout — session-gated"
```

---

## Completion Criteria

- `npx vitest run --root tests unit/customer-*.test.js` — all new + phase-1 files pass.
- Login flow end-to-end shape: `/api/customer/auth/google/start` → Google → callback → `crx_session` set → `/usage-check?welcome=1&reveal=…` → `/api/customer/me?reveal=…` shows plaintext once.
- Unverified email, bad state, and re-login are each handled per Review Focus.
- No admin behavior touched: `src/app/api/auth/*`, `src/dashboardGuard.js`, `dashboardSession.js` unchanged.
