import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";

describe("InferHub provider", () => {
  const inferhub = REGISTRY.find((e) => e.id === "inferhub");

  it("is registered as an OpenAI-compatible apikey provider", () => {
    expect(inferhub).toBeDefined();
    expect(inferhub.category).toBe("apikey");
    expect(inferhub.transport.baseUrl).toBe("https://api.inferhub.dev/v1/chat/completions");
    expect(inferhub.alias).toBe("inferhub");
    expect(inferhub.aliases).toContain("ih");
  });

  it("exposes all three endpoints (openai, claude, responses)", () => {
    const formats = (inferhub.transports || []).map((t) => t.format).sort();
    expect(formats).toEqual(["claude", "openai", "openai-responses"]);
    const claude = inferhub.transports.find((t) => t.format === "claude");
    expect(claude.baseUrl).toBe("https://api.inferhub.dev/v1/messages");
    expect(claude.auth.header).toBe("x-api-key");
    expect(claude.auth.anthropicVersion).toBe(true);
  });

  it("enables dynamic model discovery and passthrough", () => {
    expect(inferhub.passthroughModels).toBe(true);
    expect(inferhub.modelsFetcher).toMatchObject({
      url: "https://api.inferhub.dev/v1/models",
      type: "openai",
    });
  });

  it("builds into the runtime PROVIDERS map with the openai format default", () => {
    expect(PROVIDERS.inferhub).toBeDefined();
    expect(PROVIDERS.inferhub.format).toBe("openai");
    expect(PROVIDERS.inferhub.baseUrl).toBe("https://api.inferhub.dev/v1/chat/completions");
  });

  it("keeps every registry id unique after adding inferhub", () => {
    const ids = REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
