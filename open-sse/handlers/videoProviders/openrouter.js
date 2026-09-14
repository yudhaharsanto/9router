// Collection-root video jobs — OpenRouter and InferHub.
// Docs: https://openrouter.ai/docs/api/api-reference/videos
//       https://inferhub.dev/docs/api/reference#tag/inference
//
// Same async shape as xAI (POST → { id, status }, GET → status/unsigned_urls),
// two differences only: creation POSTs to the collection root (no `/generations`
// suffix) and the account headers come from the registry entry.
// Response bodies are passed through verbatim.

// ponytail: generations only — neither upstream has edits/extensions today.
const SUPPORTED_ACTIONS = new Set(["generations"]);

function headers(config, token) {
  return {
    Accept: "application/json",
    ...(config.headers || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export default {
  buildRequest({ config, action, requestId, suffix, rawBody, contentType, token }) {
    const base = config.baseUrl.replace(/\/$/, "");

    if (requestId) {
      const job = `${base}/${encodeURIComponent(requestId)}`;
      return { method: "GET", url: suffix ? `${job}/${encodeURIComponent(suffix)}` : job, headers: headers(config, token) };
    }
    if (!SUPPORTED_ACTIONS.has(action)) {
      return { error: `Video supports 'generations' only (got '${action}')` };
    }
    if (contentType && !contentType.includes("application/json")) {
      return { error: "Video requires an application/json body" };
    }
    return {
      method: "POST",
      url: base,
      headers: { ...headers(config, token), "Content-Type": "application/json" },
      body: rawBody,
    };
  },
};
