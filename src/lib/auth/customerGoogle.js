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
