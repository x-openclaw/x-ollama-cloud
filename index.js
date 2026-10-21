// OpenClaw provider plugin: Ollama Cloud models through an AxonHub gateway (OpenAI format).
//
// Provider x-ollama-cloud/, OpenAI format, every model the key can see
// (use an AxonHub key restricted to the Ollama Cloud channel).
// API address and key, first match wins:
//   address: plugin settings in the UI (baseUrl), then env X_OLLAMA_CLOUD_BASE_URL
//   key:     plugin settings in the UI (apiKey), then a saved auth profile, then env X_OLLAMA_CLOUD_API_KEY
// Optional: contextWindow (X_OLLAMA_CLOUD_CONTEXT_WINDOW) overrides the discovered context window.
// Streaming is off by default: AxonHub's Ollama Cloud channel ends streamed responses
// without a terminal event and answers 502. Turn it on with `streaming` or X_OLLAMA_CLOUD_STREAMING=true.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildOpenAICompatibleLiveModels,
  buildOpenAICompatibleLiveProviderCatalog,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-entry";

const PROVIDER_ID = "x-ollama-cloud";

const text = (value) => (typeof value === "string" ? value.trim() : "");
const flag = (value, fallback) =>
  typeof value === "boolean" ? value : text(value) ? /^(1|true|yes|on)$/i.test(text(value)) : fallback;

function readSettings(api) {
  const cfg = api.pluginConfig ?? {};
  return {
    baseUrl: (text(cfg.baseUrl) || text(process.env.X_OLLAMA_CLOUD_BASE_URL)).replace(/\/+$/, ""),
    apiKey: text(cfg.apiKey),
    contextWindow: Number(cfg.contextWindow) || Number(process.env.X_OLLAMA_CLOUD_CONTEXT_WINDOW) || undefined,
    streaming: flag(cfg.streaming ?? process.env.X_OLLAMA_CLOUD_STREAMING, false),
  };
}

// Context window override and per-model streaming switch.
function applySettings(model, s) {
  return {
    ...model,
    ...(s.contextWindow ? { contextWindow: s.contextWindow } : {}),
    ...(s.streaming ? {} : { params: { ...model.params, streaming: false } }),
  };
}

function buildProvider(s) {
  return {
    baseUrl: s.baseUrl,
    api: "openai-completions",
    ...(s.apiKey ? { apiKey: s.apiKey } : {}),
    models: [],
  };
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "X Ollama Cloud",
  description: "Ollama Cloud models through an AxonHub gateway (OpenAI format)",
  register(api) {
    const s = readSettings(api);
    if (!s.baseUrl) {
      api.logger?.warn?.(`${PROVIDER_ID}: no API address; set baseUrl in the plugin settings or X_OLLAMA_CLOUD_BASE_URL`);
    }
    api.registerProvider({
      id: PROVIDER_ID,
      label: "X Ollama Cloud",
      docsPath: "/concepts/model-providers",
      envVars: ["X_OLLAMA_CLOUD_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Ollama Cloud API key",
          optionKey: "xOllamaCloudApiKey",
          flagName: "--x-ollama-cloud-api-key",
          envVar: "X_OLLAMA_CLOUD_API_KEY",
          promptMessage: "Enter Ollama Cloud API key",
          defaultModel: `${PROVIDER_ID}/gpt-oss:120b`,
          // Adding a key never replaces the primary model picked in the UI.
          preserveExistingPrimary: true,
        }),
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          if (!s.baseUrl) return null;
          const auth = s.apiKey ? { apiKey: s.apiKey } : ctx.resolveProviderApiKey(PROVIDER_ID);
          if (!auth.apiKey) return null;
          return await buildOpenAICompatibleLiveProviderCatalog({
            providerId: PROVIDER_ID,
            providerConfig: buildProvider(s),
            apiKey: auth.apiKey,
            discoveryApiKey: auth.discoveryApiKey,
            profileId: auth.profileId,
            signal: ctx.signal,
            modelDiscovery: {
              projectRows: (rows, fallback) =>
                buildOpenAICompatibleLiveModels(rows, fallback).map((model) => applySettings(model, s)),
            },
          });
        },
      },
      staticCatalog: {
        order: "simple",
        run: async () => (s.baseUrl ? { provider: buildProvider(s) } : null),
      },
    });
  },
});
