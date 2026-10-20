import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);

vi.mock("@/lib/network/connectionProxy", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    pickProxyPoolId: actual.pickProxyPoolId,
    resolveConnectionProxyConfig: vi.fn(async ({ proxyPoolId } = {}) => ({
      connectionProxyEnabled: Boolean(proxyPoolId),
      connectionProxyUrl: proxyPoolId ? `http://proxy-${proxyPoolId}` : "",
      connectionNoProxy: "",
      proxyPoolId: proxyPoolId || null,
      proxyPool: { name: `Pool ${proxyPoolId}` },
      vercelRelayUrl: "",
    })),
  };
});

vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {
    "free-a": { noAuth: true },
    "free-b": { noAuth: true },
    "free-c": { noAuth: true },
    "free-d": { noAuth: true },
  },
  resolveProviderId: (provider) => provider,
}));

vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

const { getProviderCredentials, markAccountUnavailable } = await import(
  "../../src/sse/services/auth.js"
);

const POOLS = [
  { id: "p1", proxyUrl: "http://p1", isActive: true },
  { id: "p2", proxyUrl: "http://p2", isActive: true },
];

function strategyFor(map) {
  dbMocks.getSettings.mockResolvedValue({ providerStrategies: map });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getProxyPools.mockResolvedValue(POOLS);
  dbMocks.getProviderConnections.mockResolvedValue([]);
});

describe("no-auth free provider + proxy pool fallback", () => {
  it("tags the virtual connection with the picked pool so the account loop can exclude it", async () => {
    strategyFor({ "free-a": { rotateStrategy: "round-robin" } });

    const first = await getProviderCredentials("free-a", new Set(), "m", {});
    expect(first.id).toBe("proxy:p1");

    const second = await getProviderCredentials("free-a", new Set([first.id]), "m", {});
    expect(second.id).toBe("proxy:p2");
  });

  it("honors a bare pool id in the exclusion set", async () => {
    strategyFor({ "free-b": { rotateStrategy: "round-robin" } });
    dbMocks.getProxyPools.mockResolvedValue([POOLS[1], POOLS[0]]);

    const second = await getProviderCredentials("free-b", new Set(["p2"]), "m", {});
    expect(second.id).toBe("proxy:p1");
  });

  it("returns null once every pool is excluded instead of leaking direct egress", async () => {
    strategyFor({ "free-c": { rotateStrategy: "round-robin" } });

    const creds = await getProviderCredentials(
      "free-c",
      new Set(["proxy:p1", "proxy:p2"]),
      "m",
      {},
    );
    expect(creds).toBeNull();
  });

  it("keeps the plain noauth connection when no pool is configured", async () => {
    strategyFor({ "free-d": {} });

    const creds = await getProviderCredentials("free-d", new Set(), "m", {});
    expect(creds.id).toBe("noauth");
    expect(creds.connectionName).toBe("Public");
  });
});

describe("markAccountUnavailable for virtual proxy connections", () => {
  it("falls back on 403 without needing a DB row for the virtual connection", async () => {
    dbMocks.getProviderConnections.mockRejectedValue(
      new Error("no row for virtual proxy connection"),
    );

    const res = await markAccountUnavailable("proxy:p1", 403, "FreeTierError", "free-a", "m");
    expect(res.shouldFallback).toBe(true);
  });

  it("still refuses to fall back on the direct noauth connection", async () => {
    const res = await markAccountUnavailable("noauth", 403, "FreeTierError", "free-a", "m");
    expect(res.shouldFallback).toBe(false);
  });
});
