// Dashboard guard × customer portal — C1 regression tests.
// /api/customer/* must be reachable: google OAuth entry points + logout public,
// everything else requires a valid crx_session customer JWT. Admin auth_token
// must NOT open customer APIs; customer session must NOT open admin APIs.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  nextResponse: Symbol("next"),
  jsonResponse: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
  })),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
  getCustomerSession: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => mocks.nextResponse),
    json: mocks.jsonResponse,
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
}));

vi.mock("@/lib/auth/customerSession", () => ({
  getCustomerSession: mocks.getCustomerSession,
}));

const { proxy } = await import("../../src/dashboardGuard.js");

const PEER_TOKEN = "peer-token-fixture";

function request(pathname, headers = {}) {
  const normalizedHeaders = new Headers(headers);
  return {
    nextUrl: { pathname, searchParams: new URL(`http://localhost${pathname}`).searchParams },
    headers: normalizedHeaders,
    cookies: { get: vi.fn(() => undefined) },
    url: `http://localhost${pathname}`,
  };
}

describe("dashboard guard: /api/customer/* gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
    mocks.getCustomerSession.mockResolvedValue(null);
  });

  it("allows unauthenticated /api/customer/auth/google/start (self-protecting route)", async () => {
    const response = await proxy(request("/api/customer/auth/google/start"));
    expect(response).toBe(mocks.nextResponse);
  });

  it("allows unauthenticated /api/customer/auth/google/callback (validates state itself)", async () => {
    const response = await proxy(request("/api/customer/auth/google/callback"));
    expect(response).toBe(mocks.nextResponse);
  });

  it("allows /api/customer/auth/logout without a session (clears a cookie only)", async () => {
    const response = await proxy(request("/api/customer/auth/logout", { method: "POST" }));
    expect(response).toBe(mocks.nextResponse);
  });

  it("401 on unauthenticated /api/customer/me", async () => {
    const response = await proxy(request("/api/customer/me"));
    expect(response.status).toBe(401);
  });

  it("allows /api/customer/me with a valid crx_session cookie", async () => {
    mocks.getCustomerSession.mockResolvedValue({ customerId: "c-1" });
    const response = await proxy(
      request("/api/customer/me", { cookie: "crx_session=good-token" })
    );
    expect(response).toBe(mocks.nextResponse);
    expect(mocks.getCustomerSession).toHaveBeenCalledWith("good-token");
  });

  it("401 on /api/customer/me with only a valid admin auth_token (no customer session)", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
    const response = await proxy(
      request("/api/customer/me", { cookie: "auth_token=admin-jwt" })
    );
    expect(response.status).toBe(401);
  });

  it("401 on /api/customer/me with a garbage crx_session", async () => {
    const response = await proxy(
      request("/api/customer/me", { cookie: "crx_session=garbage" })
    );
    expect(response.status).toBe(401);
  });

  it("admin path /api/settings stays admin-gated even with a valid customer session", async () => {
    mocks.getCustomerSession.mockResolvedValue({ customerId: "c-1" });
    const response = await proxy(
      request("/api/settings", { cookie: "crx_session=good-token" })
    );
    expect(response.status).toBe(401);
  });
});
