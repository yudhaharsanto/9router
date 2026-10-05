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
  const origin = await getPublicOrigin(request);
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
    await setCustomerAuthCookie(cookieStore, request, sessionToken);

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
