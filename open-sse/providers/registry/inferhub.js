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
  passthroughModels: true,
};
