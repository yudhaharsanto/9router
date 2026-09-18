import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import {
  PROVIDER_MODELS,
  getModelTargetFormat,
} from "../../open-sse/config/providerModels.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";

const MODEL = "muse-spark-1.2-contributor-free";
const PROVIDER = "opencode";

const input = [
  {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Think, then answer: 2 + 2?" }],
  },
];

describe("OpenCode Free Muse Spark thinking", () => {
  it("advertises reasoning and the requested model limits", () => {
    expect(PROVIDER_MODELS.oc?.some((model) => model.id === MODEL)).toBe(true);
    expect(
      PROVIDER_MODELS.oc?.some(
        (model) => model.id === "muse-spark-1.3-contributor-free",
      ),
    ).toBe(true);
    for (const m of [
      MODEL,
      "muse-spark-1.3-contributor-free",
      "muse-spark-1.4-contributor-free",
      "muse-spark-2.0-contributor-free",
    ]) {
      expect(getCapabilitiesForModel(PROVIDER, m)).toMatchObject({
        reasoning: true,
        thinkingFormat: "openai",
        contextWindow: 1048576,
        maxOutput: 131072,
      });
      expect(getCapabilitiesForModel(PROVIDER, `oc/${m}`)).toMatchObject({
        reasoning: true,
        contextWindow: 1048576,
        maxOutput: 131072,
      });
      expect(getThinkingLevels(PROVIDER, m)).toEqual([
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
      expect(getModelTargetFormat("oc", m)).toBe(FORMATS.OPENAI_RESPONSES);
      expect(getModelTargetFormat("opencode", m)).toBe(
        FORMATS.OPENAI_RESPONSES,
      );
      expect(getModelTargetFormat("openrouter", m)).toBeNull();
    }
  });

  it("clamps max to xhigh and emits the Responses reasoning shape", () => {
    const body = {
      input,
      reasoning: { effort: "max" },
      max_tokens: 131072,
    };

    const out = new OpenCodeExecutor().transformRequest(MODEL, body, true, {
      connectionId: "opencode-muse-spark-test",
    });

    expect(out.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.max_output_tokens).toBe(131072);
    expect(out.max_tokens).toBeUndefined();
  });

  it("leaves the other free models on Chat Completions", () => {
    const executor = new OpenCodeExecutor();
    const body = {
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1024,
    };
    executor.transformRequest("big-pickle", body, true, {});
    expect(executor.buildUrl("big-pickle")).toBe(
      "https://opencode.ai/zen/v1/chat/completions",
    );
    expect(body.max_tokens).toBe(1024);
    expect(body.max_output_tokens).toBeUndefined();
  });

  it("translates Chat Completions max thinking into a Responses request", () => {
    const body = {
      model: `oc/${MODEL}`,
      messages: [{ role: "user", content: "Think, then answer: 2 + 2?" }],
      reasoning_effort: "max",
      max_tokens: 131072,
    };

    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      MODEL,
      body,
      true,
      {},
      PROVIDER,
    );
    const out = new OpenCodeExecutor().transformRequest(
      MODEL,
      translated,
      true,
      {
        connectionId: "opencode-muse-spark-translation-test",
      },
    );

    expect(out.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(out.max_output_tokens).toBe(131072);
    expect(out.max_tokens).toBeUndefined();
  });

  it("routes muse-spark-1.3-contributor-free and future Muse Spark models to Responses API", () => {
    const executor = new OpenCodeExecutor();
    const futureModel = "muse-spark-1.4-contributor-free";

    for (const m of ["muse-spark-1.3-contributor-free", futureModel]) {
      expect(executor.buildUrl(m)).toBe("https://opencode.ai/zen/v1/responses");
      expect(executor.buildUrl(`${m}(high)`)).toBe(
        "https://opencode.ai/zen/v1/responses",
      );
      expect(getModelTargetFormat("oc", m)).toBe("openai-responses");

      const body = {
        model: `oc/${m}`,
        messages: [{ role: "user", content: "Hello" }],
        reasoning_effort: "high",
        max_tokens: 2048,
      };

      const translated = translateRequest(
        FORMATS.OPENAI,
        FORMATS.OPENAI_RESPONSES,
        m,
        body,
        true,
        {},
        PROVIDER,
      );
      const out = executor.transformRequest(m, translated, true, {
        connectionId: "opencode-muse-spark-13-test",
      });

      expect(out.reasoning).toEqual({ effort: "high", summary: "auto" });
      expect(out.max_output_tokens).toBe(2048);
      expect(out.max_tokens).toBeUndefined();
    }
  });

  it("strips reasoning items, encrypted props, and forces auto tool_choice on 1.3", () => {
    const executor = new OpenCodeExecutor();
    const body = {
      input: [
        { type: "reasoning", summary: [] },
        {
          type: "message",
          role: "assistant",
          encrypted_content: "enc",
          reasoning_encrypted_content: "renc",
          content: [],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      ],
      tool_choice: { type: "function", name: "read" },
      reasoning: { effort: "high" },
    };

    const out = executor.transformRequest(
      "muse-spark-1.3-contributor-free",
      body,
      true,
      {
        connectionId: "opencode-muse-spark-strip-test",
      },
    );

    expect(out.input.some((item) => item.type === "reasoning")).toBe(false);
    const assistant = out.input.find((item) => item.role === "assistant");
    expect(assistant.encrypted_content).toBeUndefined();
    expect(assistant.reasoning_encrypted_content).toBeUndefined();
    expect(out.tool_choice).toBe("auto");
  });

  it("sends canonical OpenCode fingerprint headers (PR #4105)", () => {
    const executor = new OpenCodeExecutor();

    const headers = executor.buildHeaders({ rawHeaders: {} }, true);
    expect(headers["User-Agent"]).toMatch(
      /^opencode\/1\.(1[7-9]|[2-9]\d)\.\d+$/,
    );
    expect(headers["x-opencode-session"]).toMatch(
      /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
    );
    expect(headers["x-opencode-request"]).toMatch(
      /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
    );

    // Malformed downstream UA + foreign session get upgraded/translated.
    const upgraded = executor.buildHeaders(
      {
        rawHeaders: {
          "user-agent": "curl/8.4.0",
          "x-opencode-session": "claude:abc-123",
        },
      },
      true,
    );
    expect(upgraded["User-Agent"]).toMatch(/^opencode\/1\.\d+\.\d+$/);
    expect(upgraded["x-opencode-session"]).toMatch(
      /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
    );

    // Canonical native sessions pass through untouched.
    const native = `ses_${"a".repeat(12)}${"B".repeat(14)}`;
    const passthrough = executor.buildHeaders(
      { rawHeaders: { "x-opencode-session": native } },
      true,
    );
    expect(passthrough["x-opencode-session"]).toBe(native);
  });

  it("injects the free-tier fingerprint quartet and forces streaming", () => {
    const executor = new OpenCodeExecutor();
    const extra = {
      type: "function",
      function: {
        name: "my_tool",
        description: "x",
        parameters: { type: "object", properties: {} },
      },
    };

    const chat = executor.transformRequest(
      "mimo-v2.5-free",
      {
        messages: [{ role: "user", content: "hi" }],
        tools: [extra],
        stream: false,
      },
      false,
      {},
    );
    expect(chat.stream).toBe(true);
    expect(chat.tools.map((t) => t.function.name).sort()).toEqual([
      "bash",
      "glob",
      "grep",
      "my_tool",
      "read",
    ]);
    expect(chat.tools.find((t) => t.function.name === "my_tool")).toBe(extra);

    const responses = executor.transformRequest(
      "muse-spark-1.3-contributor-free",
      {
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
          },
        ],
      },
      false,
      {},
    );
    expect(responses.stream).toBe(true);
    // Responses tool shape is flat, not nested under `function`.
    expect(responses.tools.map((t) => t.name).sort()).toEqual([
      "bash",
      "glob",
      "grep",
      "read",
    ]);
    expect(
      responses.tools.every((t) => t.type === "function" && t.parameters),
    ).toBe(true);
  });

  it("does not duplicate fingerprint tools already supplied by the caller", () => {
    const executor = new OpenCodeExecutor();
    const supplied = ["bash", "glob", "grep", "read"].map((name) => ({
      type: "function",
      function: {
        name,
        description: "caller",
        parameters: { type: "object", properties: {} },
      },
    }));

    const out = executor.transformRequest(
      "mimo-v2.5-free",
      { messages: [], tools: supplied },
      true,
      {},
    );
    expect(out.tools).toHaveLength(4);
    expect(out.tools.every((t) => t.function.description === "caller")).toBe(
      true,
    );
  });
});
