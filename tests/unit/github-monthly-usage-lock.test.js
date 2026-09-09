import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getProviderConnections.mockResolvedValue([{
    id: "github-a",
    provider: "github",
    name: "github-a",
    backoffLevel: 4,
  }]);
});

describe("GitHub monthly usage exhaustion", () => {
  it("locks the whole account until the next UTC month", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T19:30:00.000Z"));

    try {
      await markAccountUnavailable(
        "github-a",
        402,
        "You've reached your additional usage limit for your plan. Go to GitHub settings for details.",
        "github",
        "claude-fable-5",
      );

      expect(dbMocks.updateProviderConnection).toHaveBeenCalledWith(
        "github-a",
        expect.objectContaining({
          modelLock___all: "2026-09-01T00:00:00.000Z",
          testStatus: "unavailable",
          errorCode: 402,
          backoffLevel: 0,
        }),
      );
      expect(dbMocks.updateProviderConnection.mock.calls[0][1])
        .not.toHaveProperty("modelLock_claude-fable-5");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps unrelated GitHub 402 errors model-scoped", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T19:30:00.000Z"));

    try {
      await markAccountUnavailable(
        "github-a",
        402,
        "Payment required",
        "github",
        "claude-fable-5",
      );

      expect(dbMocks.updateProviderConnection).toHaveBeenCalledWith(
        "github-a",
        expect.objectContaining({
          "modelLock_claude-fable-5": "2026-08-04T19:32:00.000Z",
        }),
      );
      expect(dbMocks.updateProviderConnection.mock.calls[0][1])
        .not.toHaveProperty("modelLock___all");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Grok CLI free usage exhaustion", () => {
  beforeEach(() => {
    dbMocks.getProviderConnections.mockResolvedValue([{
      id: "Tuw2pmw3vg",
      provider: "grok-cli",
      name: "Xyz",
      backoffLevel: 0,
    }]);
  });

  it("disables the connection instead of a 2s model lock", async () => {
    const result = await markAccountUnavailable(
      "Tuw2pmw3vg",
      429,
      '{"code":"subscription:free-usage-exhausted","error":"You\'ve used all the included free usage"}',
      "grok-cli",
      "grok-4.6-high",
    );

    expect(result).toEqual({ shouldFallback: true, cooldownMs: 0 });
    expect(dbMocks.updateProviderConnection).toHaveBeenCalledWith(
      "Tuw2pmw3vg",
      expect.objectContaining({
        isActive: false,
        testStatus: "unavailable",
        errorCode: 429,
        backoffLevel: 0,
      }),
    );
    const update = dbMocks.updateProviderConnection.mock.calls[0][1];
    expect(update).not.toHaveProperty("modelLock_grok-4.6-high");
    expect(update).not.toHaveProperty("modelLock___all");
  });

  it("keeps unrelated grok-cli 429 errors as a model lock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T19:30:00.000Z"));

    try {
      await markAccountUnavailable(
        "Tuw2pmw3vg",
        429,
        "Rate limit exceeded",
        "grok-cli",
        "grok-4.6-high",
      );

      expect(dbMocks.updateProviderConnection).toHaveBeenCalledWith(
        "Tuw2pmw3vg",
        expect.objectContaining({
          "modelLock_grok-4.6-high": "2026-08-04T19:30:02.000Z",
        }),
      );
      expect(dbMocks.updateProviderConnection.mock.calls[0][1].isActive)
        .not.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
