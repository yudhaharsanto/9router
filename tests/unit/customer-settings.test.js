// Settings API — OAuth client secrets must never leave the server (C2).
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({ status: init?.status || 200, body, headers: init?.headers }),
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
}));

vi.mock("@/lib/network/outboundProxy", () => ({
  applyOutboundProxyEnv: vi.fn(),
}));

vi.mock("open-sse/services/combo.js", () => ({
  resetComboRotation: vi.fn(),
}));

vi.mock("bcryptjs", () => ({
  default: { genSalt: vi.fn(async () => "salt"), compare: vi.fn(async () => false) },
}));

const { GET, PATCH } = await import("../../src/app/api/settings/route.js");

const SECRET_SETTINGS = {
  password: "bcrypt-hash",
  oidcIssuerUrl: "https://idp.example.com",
  oidcClientId: "oidc-client",
  oidcClientSecret: "oidc-s3cret",
  googleOAuthClientId: "google-client",
  googleOAuthClientSecret: "google-s3cret",
};

describe("GET /api/settings — secret redaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ ...SECRET_SETTINGS });
  });

  it("never returns googleOAuthClientSecret or oidcClientSecret", async () => {
    const res = await GET();
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("google-s3cret");
    expect(json).not.toContain("oidc-s3cret");
    expect(res.body.googleOAuthClientSecret).toBeUndefined();
    expect(res.body.oidcClientSecret).toBeUndefined();
  });

  it("reports googleOAuthConfigured + oidcConfigured when fully configured", async () => {
    const res = await GET();
    expect(res.body.googleOAuthConfigured).toBe(true);
    expect(res.body.oidcConfigured).toBe(true);
  });

  it("reports googleOAuthConfigured=false when the secret is missing", async () => {
    mocks.getSettings.mockResolvedValue({
      ...SECRET_SETTINGS,
      googleOAuthClientSecret: "",
    });
    const res = await GET();
    expect(res.body.googleOAuthConfigured).toBe(false);
  });
});

describe("PATCH /api/settings — blank secret must not wipe a stored one", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateSettings.mockResolvedValue({ ...SECRET_SETTINGS });
    mocks.getSettings.mockResolvedValue({ ...SECRET_SETTINGS });
  });

  it("drops a blank googleOAuthClientSecret instead of persisting it", async () => {
    const res = await PATCH({
      json: async () => ({ googleOAuthClientSecret: "   " }),
    });
    expect(res.status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalledWith(
      expect.not.objectContaining({ googleOAuthClientSecret: expect.anything() })
    );
    const passed = mocks.updateSettings.mock.calls[0][0];
    expect(Object.prototype.hasOwnProperty.call(passed, "googleOAuthClientSecret")).toBe(false);
  });

  it("passes a non-blank googleOAuthClientSecret through", async () => {
    await PATCH({ json: async () => ({ googleOAuthClientSecret: "new-secret" }) });
    const passed = mocks.updateSettings.mock.calls[0][0];
    expect(passed.googleOAuthClientSecret).toBe("new-secret");
  });

  it("response also strips the secret", async () => {
    const res = await PATCH({
      json: async () => ({ googleOAuthClientId: "google-client-2" }),
    });
    expect(JSON.stringify(res.body)).not.toContain("google-s3cret");
    expect(res.body.googleOAuthConfigured).toBe(true);
  });
});
