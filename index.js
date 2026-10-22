// OpenClaw provider plugin: Ollama Cloud models through an AxonHub gateway (OpenAI format).
//
// Provider x-ollama-cloud/, OpenAI format, every model the key can see
// (use an AxonHub key restricted to the Ollama Cloud channel).
// API address and key, first match wins:
//   address: plugin settings in the UI (baseUrl), then env X_OLLAMA_CLOUD_BASE_URL
//   key:     plugin settings in the UI (apiKey), then a saved auth profile, then env X_OLLAMA_CLOUD_API_KEY
// Optional: contextWindow (X_OLLAMA_CLOUD_CONTEXT_WINDOW) overrides the discovered context window.
// modelsDev (X_OLLAMA_CLOUD_MODELS_DEV, default on) fills context and output limits from models.dev
// for models AxonHub reports without them; contextWindow still wins when set.
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
    modelsDev: flag(cfg.modelsDev ?? process.env.X_OLLAMA_CLOUD_MODELS_DEV, true),
  };
}

// models.dev limits, keyed by a normalized model id. Fetched at most once a day.
const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_TTL_MS = 24 * 60 * 60 * 1000;
const PREFERRED_SOURCES = ["ollama-cloud"];
// Effort and mode variants share the limits of their base model.
const VARIANT_SUFFIX = /-(high|medium|low|extra-low|minimal|xhigh|tiered|thinking|agent)$/;
const REPORTED_CONTEXT_FIELDS = ["context_length", "context_window", "contextWindow", "max_context_length"];
let modelsDevCache = { at: 0, limits: null };

// "ollama/gpt-oss:120b" -> "gpt-oss-120b", "glm-5.1" -> "glm-5-1"
const normalizeId = (id) => id.toLowerCase().split("/").pop().replace(/[._:]/g, "-");

async function loadModelsDevLimits(signal) {
  if (modelsDevCache.limits && Date.now() - modelsDevCache.at < MODELS_DEV_TTL_MS) return modelsDevCache.limits;
  try {
    const timeout = AbortSignal.timeout(15000);
    const res = await fetch(MODELS_DEV_URL, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const catalog = await res.json();
    const sources = [...PREFERRED_SOURCES.filter((p) => catalog[p]), ...Object.keys(catalog).filter((p) => !PREFERRED_SOURCES.includes(p))];
    const limits = new Map();
    for (const source of sources) {
      for (const [id, model] of Object.entries(catalog[source]?.models ?? {})) {
        const key = normalizeId(id);
        const context = Number(model?.limit?.context);
        if (!limits.has(key) && context > 0) limits.set(key, { context, output: Number(model?.limit?.output) || undefined });
      }
    }
    modelsDevCache = { at: Date.now(), limits };
  } catch {
    // Keep the last good copy; without one, models fall back to the defaults.
  }
  return modelsDevCache.limits;
}

function lookupLimits(limits, id) {
  const key = normalizeId(id);
  return limits?.get(key) ?? limits?.get(key.replace(VARIANT_SUFFIX, ""));
}

// Limits from models.dev, only for models AxonHub reported without a context window.
function applyModelsDevLimits(model, row, limits) {
  if (!limits || REPORTED_CONTEXT_FIELDS.some((field) => Number(row?.[field]) > 0)) return model;
  const found = lookupLimits(limits, model.id);
  if (!found) return model;
  return {
    ...model,
    contextWindow: found.context,
    ...(found.output ? { maxTokens: Math.min(found.output, found.context) } : {}),
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
          const limits = s.modelsDev && !s.contextWindow ? await loadModelsDevLimits(ctx.signal) : null;
          return await buildOpenAICompatibleLiveProviderCatalog({
            providerId: PROVIDER_ID,
            providerConfig: buildProvider(s),
            apiKey: auth.apiKey,
            discoveryApiKey: auth.discoveryApiKey,
            profileId: auth.profileId,
            signal: ctx.signal,
            modelDiscovery: {
              projectRows: (rows, fallback) => {
                const byId = new Map(rows.map((row) => [row?.id, row]));
                return buildOpenAICompatibleLiveModels(rows, fallback).map((model) =>
                  applySettings(applyModelsDevLimits(model, byId.get(model.id), limits), s),
                );
              },
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
