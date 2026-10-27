import { describe, it, expect } from "vitest";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const body = { messages: [{ role: "user", content: "hi" }] };

describe("CodeBuddyIntl conversation headers", () => {
  const executor = new CodeBuddyIntlExecutor();
  const headersFor = (credentials, requestBody = body) =>
    executor.buildHeaders(
      credentials,
      true,
      "https://www.codebuddy.ai/v2/chat/completions",
      "deepseek-v4.1-flash",
      requestBody,
    );

  it("sends all three X-Conversation-* headers as UUIDs", () => {
    const headers = headersFor({ accessToken: "t", _clientSessionId: "sess-a" });
    for (const name of ["X-Conversation-ID", "X-Conversation-Request-ID", "X-Conversation-Message-ID"]) {
      expect(headers[name], name).toMatch(UUID_RE);
    }
  });

  it("keeps X-Conversation-ID stable per session and distinct across sessions", () => {
    const a = headersFor({ accessToken: "t", _clientSessionId: "sess-a" })["X-Conversation-ID"];
    const b = headersFor({ accessToken: "t", _clientSessionId: "sess-a" })["X-Conversation-ID"];
    const c = headersFor({ accessToken: "t", _clientSessionId: "sess-b" })["X-Conversation-ID"];
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("mints a fresh X-Conversation-Request-ID per call", () => {
    const a = headersFor({ accessToken: "t", _clientSessionId: "sess-a" })["X-Conversation-Request-ID"];
    const b = headersFor({ accessToken: "t", _clientSessionId: "sess-a" })["X-Conversation-Request-ID"];
    expect(a).not.toBe(b);
  });

  it("changes the message id when the user prompt changes", () => {
    const one = headersFor({ _clientSessionId: "s" })["X-Conversation-Message-ID"];
    const two = headersFor({ _clientSessionId: "s" }, { messages: [{ role: "user", content: "bye" }] })[
      "X-Conversation-Message-ID"
    ];
    expect(one).not.toBe(two);
  });
});
