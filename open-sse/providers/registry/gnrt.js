export default {
  id: "gnrt",
  priority: 221,
  alias: "gnrt",
  aliases: [],
  uiAlias: "gnrt",
  display: {
    name: "GnRT",
    icon: "bolt",
    color: "#10B981",
    textIcon: "GN",
    website: "https://gnrt.dev",
    notice: {
      text: "OpenAI-compatible gateway. API key starts with sk-gnrt-. Models use prefix/model ids (e.g. cb/claude-opus-4.6).",
      apiKeyUrl: "https://gnrt.dev",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://api.gnrt.dev/v1/chat/completions",
    headers: {},
  },
  transports: [
    {
      format: "openai",
      baseUrl: "https://api.gnrt.dev/v1/chat/completions",
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
    },
  ],
  modelsFetcher: { url: "https://api.gnrt.dev/v1/models", type: "openai" },
  passthroughModels: true,
};
