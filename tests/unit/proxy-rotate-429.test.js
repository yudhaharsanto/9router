import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchCalls = [];

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: async (_url, _opts, proxyOptions) => {
    fetchCalls.push(proxyOptions);
    return mockResponses.shift();
  },
}));

import { BaseExecutor } from "open-sse/executors/base.js";

const okResponse = { ok: true, status: 200, headers: { get: () => "text/event-stream" } };
const rateLimited = { ok: false, status: 429, headers: { get: () => "application/json" } };
let mockResponses = [];

function makeExecutor() {
  return new BaseExecutor("opencode", { baseUrls: ["https://up.test/v1"] });
}

describe("BaseExecutor proxy rotation on 429", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    mockResponses = [];
  });

  it("rotates proxy once and retries transparently on 429", async () => {
    mockResponses = [rateLimited, okResponse];
    const executor = makeExecutor();
    const rotated = [{ connectionProxyUrl: "http://next:1" }];
    const rotateProxy = vi.fn().mockResolvedValue(rotated);

    const { response } = await executor.execute({
      model: "m",
      body: {},
      stream: true,
      credentials: {},
      proxyOptions: { connectionProxyUrl: "http://old:1" },
      rotateProxy,
    });

    expect(response.ok).toBe(true);
    expect(rotateProxy).toHaveBeenCalledTimes(1);
    expect(rotateProxy).toHaveBeenCalledWith({ connectionProxyUrl: "http://old:1" }, "https://up.test/v1");
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0].connectionProxyUrl).toBe("http://old:1");
    expect(fetchCalls[1]).toBe(rotated);
  });

  it("returns the 429 response when rotation yields nothing", async () => {
    mockResponses = [rateLimited];
    const executor = makeExecutor();
    const rotateProxy = vi.fn().mockResolvedValue(null);

    const { response } = await executor.execute({
      model: "m",
      body: {},
      stream: true,
      credentials: {},
      proxyOptions: null,
      rotateProxy,
    });

    expect(response.status).toBe(429);
    expect(fetchCalls).toHaveLength(1);
  });

  it("rotates at most once per request (second 429 surfaces)", async () => {
    mockResponses = [rateLimited, rateLimited, okResponse];
    const executor = makeExecutor();
    const rotateProxy = vi.fn().mockResolvedValue({ connectionProxyUrl: "http://next:1" });

    const { response } = await executor.execute({
      model: "m",
      body: {},
      stream: true,
      credentials: {},
      proxyOptions: { connectionProxyUrl: "http://old:1" },
      rotateProxy,
    });

    expect(rotateProxy).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(429);
    expect(fetchCalls).toHaveLength(2);
  });

  it("does not rotate for other statuses", async () => {
    mockResponses = [{ ok: false, status: 400, headers: { get: () => "" } }];
    const executor = makeExecutor();
    const rotateProxy = vi.fn();

    await executor.execute({
      model: "m",
      body: {},
      stream: true,
      credentials: {},
      proxyOptions: null,
      rotateProxy,
    });

    expect(rotateProxy).not.toHaveBeenCalled();
  });
});
