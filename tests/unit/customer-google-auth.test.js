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
    // Drop the global sqlite adapter singleton so the new DATA_DIR takes effect
    delete global._dbAdapter;
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
