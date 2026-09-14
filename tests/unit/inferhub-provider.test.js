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

  it("routes image generation to the [OI]-compatible endpoint", () => {
    expect(inferhub.serviceKinds).toEqual(["llm", "image", "video"]);
    expect(inferhub.imageConfig).toEqual({
      baseUrl: "https://api.inferhub.dev/v1/images/generations",
      bodyFields: ["model", "prompt", "n", "size", "quality", "response_format"],
    });
  });

  it("routes video generation to the async jobs endpoint", () => {
    expect(inferhub.videoConfig).toEqual({ baseUrl: "https://api.inferhub.dev/v1/videos" });
  });

  it("registers image- and video-kind models for the media selectors", () => {
    const kinds = Object.fromEntries(inferhub.models.map((m) => [m.id, m.kind]));
    expect(kinds["leo/phoenix-v1.0"]).toBe("image");
    expect(kinds["gpt-image-2"]).toBe("image");
    expect(kinds["leo/veo-3.1-fast-generate-001"]).toBe("video");
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
