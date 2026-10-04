// Public-model masking (spec §3.6): the client never sees the upstream model name.
// Regression: the passthrough mask line referenced `parsed` outside the try block
// where it is declared → ReferenceError "Cannot access 'parsed' before
// initialization" killed every customer streaming request.
import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

async function pipe(streamFactory, input) {
  const encoder = new TextEncoder();
  const upstream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });
  const out = upstream.pipeThrough(streamFactory);
  const reader = out.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

const chunk = (model) => `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: "hi" } }] })}\n\n`;

describe("maskModel in SSE streams", () => {
  it("passthrough: masks model on a data: chunk without crashing", async () => {
    const out = await pipe(
      createPassthroughStreamWithLogger("openai", null, "upstream-model", "conn-1", {}, null, "key", "public-model"),
      chunk("upstream-model"),
    );
    expect(out).toContain("public-model");
    expect(out).not.toContain("upstream-model");
  });

  it("passthrough: non-JSON data line does not crash the stream", async () => {
    const out = await pipe(
      createPassthroughStreamWithLogger("openai", null, "m", "conn-1", {}, null, "key", "public-model"),
      "data: not-json\n\n",
    );
    // Non-JSON data lines are silently skipped (existing behavior) — the
    // regression was the mask line crashing on them, not the skip.
    expect(out).toContain("[DONE]");
  });

  it("translate: masks model on translated chunks", async () => {
    // targetFormat = provider format (openai), sourceFormat = client format (claude)
    const out = await pipe(
      createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.CLAUDE, "openai", null, null, "upstream-x", "conn-1", {}, null, "key", null, null, "public-model"),
      chunk("upstream-x"),
    );
    expect(out).toContain("public-model");
    expect(out).not.toContain("upstream-x");
  });
});
