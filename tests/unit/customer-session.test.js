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
