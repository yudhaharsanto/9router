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
async function redirectUri(request) {
  return `${await getPublicOrigin(request)}/api/customer/auth/google/callback`;
}

export async function GET(request) {
  const config = await getGoogleOAuthConfig();
  const origin = await getPublicOrigin(request);
  if (!config) {
    return NextResponse.redirect(new URL("/usage-check?error=google_not_configured", origin));
  }

  const state = createState();
  const { verifier, challenge } = createPkcePair();

  const cookieStore = await cookies();
  const baseOptions = { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 600 };
  // secure matches the admin oidc start route's behavior; getPublicOrigin already
  // restricts untrusted hosts.
  const { shouldUseSecureCookie } = await import("@/lib/auth/customerSession");
  if (await shouldUseSecureCookie(request)) {
    baseOptions.secure = true;
  }
  cookieStore.set("crx_oauth_state", state, baseOptions);
  cookieStore.set("crx_oauth_verifier", verifier, baseOptions);

  return NextResponse.redirect(
    buildGoogleAuthUrl({
      clientId: config.clientId,
      redirectUri: await redirectUri(request),
      state,
      codeChallenge: challenge,
    })
  );
}
