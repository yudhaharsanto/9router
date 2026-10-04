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

  it("customer token must NOT verify as a dashboard token (separate signing key)", async () => {
    const { createCustomerAuthToken } = await import("@/lib/auth/customerSession.js");
    const { verifyDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
    const token = await createCustomerAuthToken({ customerId: "c-123" });
    expect(await verifyDashboardAuthToken(token)).toBe(false);
  });

  it("admin token must NOT be accepted by getCustomerSession even with derived key", async () => {
    const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
    const { getCustomerSession } = await import("@/lib/auth/customerSession.js");
    const adminToken = await createDashboardAuthToken();
    expect(await getCustomerSession(adminToken)).toBeNull();
  });

  it("cookie is secure when getPublicOrigin(request) is https", async () => {
    const { shouldUseSecureCookie } = await import("@/lib/auth/customerSession.js");
    // BASE_URL drives getPublicOrigin without trusting request headers.
    const prev = process.env.BASE_URL;
    process.env.BASE_URL = "https://router.example.com";
    try {
      const req = new Request("http://localhost:20128/x"); // plain http request
      expect(shouldUseSecureCookie(req)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = prev;
    }
    // And still secure on a direct https request to a trusted host (no BASE_URL).
    delete process.env.BASE_URL;
    const httpsReq = new Request("https://localhost:3000/x");
    expect(shouldUseSecureCookie(httpsReq)).toBe(true);
    const httpReq = new Request("http://localhost:20128/x");
    expect(shouldUseSecureCookie(httpReq)).toBe(false);
  });
});
