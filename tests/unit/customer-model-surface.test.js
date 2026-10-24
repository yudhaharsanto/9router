// Customer keys may only address public model names (spec §3.6). An internal
// provider/model string must be rejected before any balance hold or dispatch:
// it exposes the upstream catalog and, when unpriced, bills nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hold: vi.fn(),
  release: vi.fn(),
  chatCore: vi.fn(),
  credentials: vi.fn(),
  publicModels: {},
}));

vi.mock("@/lib/billing/customerGate.js", () => ({
  isCustomerKey: (k) => typeof k === "string" && k.startsWith("sk-cust-"),
  authorizeCustomerRequest: async () => ({ customerId: "c-1", keyId: "k-1" }),
  holdForRequest: mocks.hold,
  releaseHold: mocks.release,
}));
vi.mock("@/lib/billing/publicModelMap.js", () => ({
  resolvePublicModelRequest: async (m) => mocks.publicModels[m] || null,
}));
vi.mock("@/lib/billing/marginGuard.js", () => ({ evaluateMarginPolicy: vi.fn() }));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false, comboStrategy: "fallback" }),
  getModelAliases: async () => ({}),
  getComboByName: async () => null,
  getProviderNodes: async () => [],
  getCombos: async () => [],
  getProviderConnections: async () => [],
  getProviderConnectionById: async () => null,
  getCustomModels: async () => [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => [] }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async () => null }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.credentials,
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(),
  rotateNoAuthProviderProxy: vi.fn(),
  extractApiKey: (request) => {
    const a = request.headers.get("Authorization");
    return a?.startsWith("Bearer ") ? a.slice(7) : request.headers.get("x-api-key");
  },
  isValidApiKey: async () => true,
  checkApiKeyLimit: async () => ({ exceeded: false, used: 0, limit: 0 }),
  checkApiKeyModelAllowed: async () => ({ allowed: true }),
  checkApiKeyRpm: async () => ({ limited: false }),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.chatCore }));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: async () => ({ provider: "openai", model: "gpt-test" }),
  getComboModels: async () => null,
}));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

const post = (body) => new Request("http://localhost/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer sk-cust-abc" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hold.mockResolvedValue({ ok: true, holdRefId: "req-test" });
  mocks.credentials.mockResolvedValue({ connectionId: "conn-1", apiKey: "sk-test", provider: "openai", authType: "apikey" });
  mocks.publicModels = {};
  mocks.chatCore.mockResolvedValue({
    success: true,
    response: new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
  });
});

describe("customer key model surface", () => {
  it("rejects an internal provider/model string before holding or dispatching", async () => {
    const res = await handleChat(post({ model: "openai/gpt-test", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(403);
    expect(mocks.hold).not.toHaveBeenCalled();
    expect(mocks.chatCore).not.toHaveBeenCalled();
  });

  it("rejects an internal combo name that is not a public model", async () => {
    const res = await handleChat(post({ model: "coder", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(403);
    expect(mocks.hold).not.toHaveBeenCalled();
  });

  it("accepts a public name, holding the reserve under it", async () => {
    mocks.publicModels["fast-chat"] = { publicName: "fast-chat", comboId: "cb-1", models: ["openai/gpt-test"] };
    const res = await handleChat(post({ model: "fast-chat", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    expect(mocks.hold).toHaveBeenCalledWith("c-1", expect.any(Object), "fast-chat");
    expect(mocks.chatCore).toHaveBeenCalledTimes(1);
  });

  it("400s on a missing model without taking a hold", async () => {
    const res = await handleChat(post({ messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(400);
    expect(mocks.hold).not.toHaveBeenCalled();
  });
});
