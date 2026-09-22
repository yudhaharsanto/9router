import { DefaultExecutor } from "./default.js";

/**
 * InferHubExecutor - InferHub only sends `usage` on the final streaming
 * chunk when the request asks for it
 * (https://inferhub.dev/docs/api/reference — POST /v1/chat/completions:
 * usage sits inside the final `chat.completion.chunk` before `data: [DONE]`).
 * Without `stream_options.include_usage` the stream carries no token counts,
 * so usage tracking records 0 tokens.
 */
export class InferHubExecutor extends DefaultExecutor {
  constructor() {
    super("inferhub");
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    // Only the OpenAI endpoint (/v1/chat/completions) honors stream_options;
    // the Claude endpoint (/v1/messages) reports usage natively per SSE event.
    const format = credentials?.runtimeTransport?.format;
    if (
      stream &&
      format !== "claude" &&
      format !== "openai-responses" &&
      transformed?.messages &&
      !transformed.stream_options
    ) {
      transformed.stream_options = { include_usage: true };
    }
    return transformed;
  }
}

export default InferHubExecutor;
