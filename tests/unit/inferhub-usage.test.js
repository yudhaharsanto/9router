import { describe, expect, it } from "vitest";

import { getExecutor, InferHubExecutor } from "../../open-sse/executors/index.js";
import { hasValuableContent } from "../../open-sse/utils/streamHelpers.js";
import { extractUsage, hasValidUsage } from "../../open-sse/utils/usageTracking.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

function openaiBody() {
  return {
    model: "cb/gpt-6-astra",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  };
}

describe("InferHubExecutor", () => {
  it("is used for the inferhub provider", () => {
    expect(getExecutor("inferhub")).toBeInstanceOf(InferHubExecutor);
  });

  it("injects stream_options.include_usage on streaming OpenAI requests", () => {
    const out = new InferHubExecutor().transformRequest(
      "cb/gpt-6-astra",
      openaiBody(),
      true,
      { runtimeTransport: { format: "openai" } },
    );
    expect(out.stream_options).toEqual({ include_usage: true });
  });

  it("keeps a caller-provided stream_options", () => {
    const body = { ...openaiBody(), stream_options: { include_usage: false } };
    const out = new InferHubExecutor().transformRequest(
      "cb/gpt-6-astra",
      body,
      true,
      { runtimeTransport: { format: "openai" } },
    );
    expect(out.stream_options).toEqual({ include_usage: false });
  });

  it("skips stream_options for non-streaming requests", () => {
    const out = new InferHubExecutor().transformRequest(
      "cb/gpt-6-astra",
      openaiBody(),
      false,
      { runtimeTransport: { format: "openai" } },
    );
    expect(out.stream_options).toBeUndefined();
  });

  it("skips stream_options for the Claude endpoint (usage is native there)", () => {
    const out = new InferHubExecutor().transformRequest(
      "cb/gpt-6-astra",
      openaiBody(),
      true,
      { runtimeTransport: { format: "claude" } },
    );
    expect(out.stream_options).toBeUndefined();
  });
});

describe("InferHub final usage chunk", () => {
  // Shape per InferHub docs: final chat.completion.chunk with empty choices
  // carrying usage, emitted just before data: [DONE].
  const finalChunk = {
    id: "chatcmpl-abc",
    object: "chat.completion.chunk",
    created: 123,
    model: "cb/gpt-6-astra",
    choices: [],
    usage: { prompt_tokens: 565, completion_tokens: 272, total_tokens: 837 },
  };

  it("is kept by hasValuableContent (not dropped before extraction)", () => {
    expect(hasValuableContent(finalChunk, FORMATS.OPENAI)).toBe(true);
  });

  it("extracts valid token counts from the final chunk", () => {
    const usage = extractUsage(finalChunk);
    expect(hasValidUsage(usage)).toBe(true);
    expect(usage.prompt_tokens).toBe(565);
    expect(usage.completion_tokens).toBe(272);
  });
});
