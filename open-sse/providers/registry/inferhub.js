export default {
  id: "inferhub",
  priority: 220,
  alias: "inferhub",
  aliases: ["ih"],
  uiAlias: "ih",
  display: {
    name: "InferHub",
    icon: "hub",
    color: "#8B5CF6",
    textIcon: "IH",
    website: "https://inferhub.dev",
    notice: {
      text: 'Pay-as-you-go model marketplace. One sk-airo- key works on OpenAI, Responses and Anthropic-compatible endpoints. Models use "prefix/model" ids (e.g. ocg/glm-5.2) or aliases.',
      apiKeyUrl: "https://inferhub.dev",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://api.inferhub.dev/v1/chat/completions",
    headers: {},
  },
  // Same key works on all three endpoints; pick the transport matching the
  // client sourceFormat to skip translation.
  transports: [
    {
      format: "openai",
      baseUrl: "https://api.inferhub.dev/v1/chat/completions",
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
    },
    {
      format: "claude",
      baseUrl: "https://api.inferhub.dev/v1/messages",
      auth: {
        combined: true,
        header: "x-api-key",
        scheme: "raw",
        anthropicVersion: true,
      },
    },
    {
      format: "openai-responses",
      baseUrl: "https://api.inferhub.dev/v1/responses",
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
    },
  ],
  // Catalog is dynamic (prefix/model ids, aliases, combo/..., free/...) — fetch
  // suggested models and accept any model id.
  modelsFetcher: { url: "https://api.inferhub.dev/v1/models", type: "openai" },
  // Passthrough catalog — media ids below are the documented examples; any
  // model with image/video output_modality works via "inferhub/<prefix>/<id>".
  models: [
    { id: "leo/phoenix-v1.0", name: "Leonardo Phoenix 1.0", kind: "image" },
    { id: "gpt-image-2", name: "GPT Image 2", kind: "image" },
    {
      id: "leo/veo-3.1-fast-generate-001",
      name: "Veo 3.1 Fast (Leonardo)",
      kind: "video",
    },
  ],
  serviceKinds: ["llm", "image", "video"],
  // [OI]-compatible images; images come back inline as b64_json (no hosted URL).
  // Docs: https://inferhub.dev/docs/api/reference#tag/inference
  imageConfig: {
    baseUrl: "https://api.inferhub.dev/v1/images/generations",
    bodyFields: ["model", "prompt", "n", "size", "quality", "response_format"],
  },
  // Async video jobs: POST /v1/videos → { id, status }, GET /v1/videos/{id} polls,
  // bytes at GET /v1/videos/{id}/content.
  videoConfig: { baseUrl: "https://api.inferhub.dev/v1/videos" },
  passthroughModels: true,
};
