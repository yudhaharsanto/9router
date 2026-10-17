// glm-5.3-flash-free (OpenCode free lane) rides the same Go backend as
// opencode-go's glm-5.3-flash: it rejects the z.ai `thinking` object with
// 400 [unknown_parameter] unknown field "thinking" and takes reasoning_effort
// instead. The global *glm-5.3* pattern (thinkingFormat "zai") must not win here.
import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const MODEL = "glm-5.3-flash-free";
const PROVIDER = "opencode";

describe("opencode free glm-5.3-flash-free thinking format", () => {
  it("resolves the openai thinking format instead of zai", () => {
    for (const provider of ["opencode", "oc"]) {
      expect(getCapabilitiesForModel(provider, MODEL).thinkingFormat).toBe("openai");
    }
  });

  it("never puts a thinking object on the wire", () => {
    for (const ask of [
      { mode: "level", level: "high" },
      { mode: "none" },
      { mode: "auto" },
    ]) {
      const body = { model: MODEL, messages: [] };
      applyThinking(FORMATS.OPENAI, MODEL, body, PROVIDER, ask);
      expect(body.thinking).toBeUndefined();
      expect(body.enable_thinking).toBeUndefined();
    }
  });

  it("sends reasoning_effort when the client asks for a level", () => {
    const body = { model: MODEL, messages: [] };
    applyThinking(FORMATS.OPENAI, MODEL, body, PROVIDER, { mode: "level", level: "high" });
    expect(body.reasoning_effort).toBe("high");
  });
});
