import { createSoulLogger } from "./logger.js";
import { getEnvKey, resolveEnvSecret, getGatewayPort } from "./env.js";

const log = createSoulLogger("llm");

export type SoulLLMConfig = {
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  /** Optional provider token ceiling. Omitted by default so the model uses its normal completion limit. */
  maxTokens?: number;
};

export type LLMGenerator = (prompt: string) => Promise<string>;

function serializeGenerator(generator: LLMGenerator): LLMGenerator {
  let tail: Promise<void> = Promise.resolve();
  return (prompt: string) => {
    const run = tail.then(() => generator(prompt));
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

function isProviderBackoffError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /rate limit|cooldown|No available auth profile|too many requests|429|suspending lanes/i.test(msg);
}

// ---------------------------------------------------------------------------
// Gateway local API — call through openclaw gateway's /v1/chat/completions endpoint
// Gateway handles all auth/provider routing, API formats, OAuth, etc.
// No API key management, env vars, daemon mode
// ---------------------------------------------------------------------------

async function callViaGateway(
  gatewayUrl: string,
  authToken: string,
  model: string,
  prompt: string,
  maxTokens?: number,
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: prompt }],
  };
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  const res = await fetch(gatewayUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gateway LLM call failed: ${res.status} - ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

// ---------------------------------------------------------------------------
// Direct provider API — fallback
// ---------------------------------------------------------------------------

async function callAnthropic(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  maxTokens?: number,
): Promise<string> {
  // Anthropic requires max_tokens on every request. Use a generous protocol
  // fallback when Soul has not been explicitly configured with a ceiling.
  const anthropicMaxTokens = maxTokens ?? 16_384;
  const res = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: anthropicMaxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic API error: ${res.status} - ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { content?: Array<{ text?: string }> };
  return data.content?.[0]?.text ?? "";
}

async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  maxTokens?: number,
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: prompt }],
  };
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI-compatible API error: ${res.status} - ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

// ---------------------------------------------------------------------------

function resolveApiKey(provider: string, apiKeyEnv?: string): string | undefined {
  if (apiKeyEnv) return getEnvKey(apiKeyEnv);

  const normalized = provider.toLowerCase();
  const envMapping: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    minimax: "MINIMAX_API_KEY",
    "minimax-portal": "MINIMAX_API_KEY",
    zai: "ZAI_API_KEY",
    zhipu: "ZHIPU_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    moonshot: "MOONSHOT_API_KEY",
    qwen: "DASHSCOPE_API_KEY",
    "qwen-portal": "DASHSCOPE_API_KEY",
  };
  const envKey = envMapping[normalized] ?? `${normalized.toUpperCase()}_API_KEY`;
  return getEnvKey(envKey);
}

function resolveBaseUrl(provider: string, customUrl?: string): string | undefined {
  if (customUrl) {
    let baseUrl = customUrl;
    if (baseUrl.endsWith("/anthropic")) {
      baseUrl = baseUrl.slice(0, -"/anthropic".length);
    }
    if (!baseUrl.endsWith("/v1") && !baseUrl.endsWith("/v4")) {
      baseUrl = `${baseUrl}/v1`;
    }
    return baseUrl;
  }
  const normalized = provider.toLowerCase();
  const defaultUrls: Record<string, string> = {
    anthropic: "https://api.anthropic.com/v1",
    openai: "https://api.openai.com/v1",
    minimax: "https://api.minimax.chat/v1",
    "minimax-portal": "https://api.minimax.chat/v1",
    zai: "https://open.bigmodel.cn/api/paas/v4",
    deepseek: "https://api.deepseek.com/v1",
    moonshot: "https://api.moonshot.cn/v1",
  };
  return defaultUrls[normalized];
}

function isAnthropicStyleApi(provider: string, baseUrl: string): boolean {
  const normalized = provider.toLowerCase();
  if (normalized === "anthropic") return true;
  return baseUrl.includes("/anthropic") && !baseUrl.includes("minimax");
}

/**
 * Parse a model ref like "openai/gpt-4o" or "minimax/MiniMax-M2.5"
 * into { provider, model }.  Falls back to a default provider if no slash.
 */
function parseModelRef(raw: string, defaultProvider = "anthropic"): { provider: string; model: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  if (slash < 0) return { provider: defaultProvider, model: trimmed };
  return { provider: trimmed.slice(0, slash).trim(), model: trimmed.slice(slash + 1).trim() };
}

/**
 * Extract the primary model string from an openclaw agents.defaults.model value.
 * Handles both string ("openai/gpt-4o") and object ({ primary: "openai/gpt-4o" }) forms.
 */
function extractPrimaryModel(modelConfig: unknown): string | undefined {
  if (typeof modelConfig === "string") return modelConfig.trim() || undefined;
  if (modelConfig && typeof modelConfig === "object" && "primary" in modelConfig) {
    const val = (modelConfig as { primary?: unknown }).primary;
    return typeof val === "string" ? val.trim() || undefined : undefined;
  }
  return undefined;
}

/**
 * Resolve an API key for a provider by reading OpenClaw's provider config.
 * OpenClaw stores secrets as { secret: "env:ENV_VAR_NAME" } or plain strings.
 */
function resolveApiKeyFromProviderConfig(
  providerName: string,
  providers?: Record<string, unknown>,
): string | undefined {
  if (!providers) return undefined;

  const candidates = [
    providerName,
    providerName.toLowerCase(),
    `${providerName}-portal`,
    `${providerName.toLowerCase()}-portal`,
  ];
  for (const candidate of candidates) {
    const providerCfg = providers[candidate];
    if (!providerCfg || typeof providerCfg !== "object") continue;

    const apiKey = (providerCfg as Record<string, unknown>).apiKey;
    if (!apiKey) continue;
    // Handle { secret: "env:API_KEY" } format using the shared env helper
    if (typeof apiKey === "object" && apiKey !== null) {
      const resolved = resolveEnvSecret(apiKey as { secret?: string });
      if (resolved) return resolved;
    }
    // Handle plain string — skip OAuth placeholders and short identifier-like strings
    if (typeof apiKey === "string") {
      if (apiKey.length < 20 || /^[a-z]+-oauth$/i.test(apiKey)) {
        continue;
      }
      return apiKey;
    }
  }
  return undefined;
}

export type OpenClawCompatConfig = {
  agents?: {
    defaults?: {
      model?: unknown;
    };
  };
  models?: {
    providers?: Record<string, unknown>;
  };
  gateway?: {
    port?: number;
    auth?: {
      mode?: string;
      token?: string;
    };
  };
};

/**
 * Auto-resolve LLM config from OpenClaw's own configuration.
 */
export function resolveLLMConfigFromOpenClaw(
  openclawConfig: OpenClawCompatConfig | undefined,
  pluginOverride?: SoulLLMConfig,
): SoulLLMConfig {
  const resolved: SoulLLMConfig = { ...pluginOverride };

  if (openclawConfig) {
    const primaryModel = extractPrimaryModel(openclawConfig.agents?.defaults?.model);
    if (primaryModel) {
      const parsed = parseModelRef(primaryModel);
      if (parsed) {
        resolved.provider ??= parsed.provider;
        resolved.model ??= parsed.model;
      }
    }

    // Auto-detect base URL from provider config
    if (resolved.provider && !resolved.baseUrl && openclawConfig.models?.providers) {
      const providerCfg =
        openclawConfig.models.providers[resolved.provider] ??
        openclawConfig.models.providers[resolved.provider.toLowerCase()];
      if (providerCfg && typeof providerCfg === "object") {
        const baseUrl = (providerCfg as Record<string, unknown>).baseUrl;
        if (typeof baseUrl === "string") {
          resolved.baseUrl = baseUrl;
        }
      }
    }
  }

  if (resolved.provider && resolved.model) {
    log.info(
      `Auto-resolved LLM config from OpenClaw: ${resolved.provider}/${resolved.model} (auto-detected from OpenClaw config)`,
    );
  }
  return resolved;
}

/**
 * Create a soul LLM generator.
 * Strategy: gateway local API first, direct provider API fallback.
 */
export async function createSoulLLMGenerator(
  config?: SoulLLMConfig,
  openclawConfig?: OpenClawCompatConfig,
): Promise<LLMGenerator | null> {
  const provider = config?.provider;
  const model = config?.model;
  const maxTokens = config?.maxTokens === undefined
    ? undefined
    : Math.max(1, Math.floor(config.maxTokens));

  if (!provider || !model) {
    log.debug("No model configured for soul LLM");
    return null;
  }

  // --- Strategy 1: Gateway local API (preferred) ---
  const gatewayPort = getGatewayPort(openclawConfig as Record<string, unknown> | undefined);
  const gatewayAuthToken = openclawConfig?.gateway?.auth?.token ?? undefined;
  if (gatewayPort && gatewayAuthToken) {
    const gatewayUrl = `http://127.0.0.1:${gatewayPort}/v1/chat/completions`;
    log.info(`Soul LLM via gateway local API: ${provider}/${model} (port ${gatewayPort})`);

    // Build fallback for when gateway fails
    const fallback = await buildDirectFallback(provider, model, config, openclawConfig);

    // Gateway expects model="openclaw" — it routes to the configured provider automatically
    return serializeGenerator(async (prompt: string): Promise<string> => {
      try {
        return await callViaGateway(gatewayUrl, gatewayAuthToken, "openclaw", prompt, maxTokens);
      } catch (err) {
        // Respect the gateway's shared provider cooldown. Falling back directly
        // on rate-limit/cooldown errors would bypass OpenClaw's budget control
        // and keep pressuring the same provider from Soul's background loop.
        if (isProviderBackoffError(err)) {
          throw err;
        }
        if (fallback) {
          log.warn(`Gateway local API failed: ${String(err)} — falling back to direct provider API`);
          return fallback(prompt);
        }
        throw err;
      }
    });
  }

  // --- Strategy 2: Direct provider API (no gateway available) ---
  const direct = await buildDirectFallback(provider, model, config, openclawConfig);
  if (direct) {
    log.info(`Soul LLM via direct provider API: ${provider}/${model}`);
    return serializeGenerator(direct);
  }

  log.info(`No LLM configured for soul — will use rule-based thought generation only`);
  return null;
}

/**
 * Build a direct provider API fallback function.
 * Returns null if no API key can be resolved.
 */
async function buildDirectFallback(
  provider: string,
  model: string,
  config?: SoulLLMConfig,
  openclawConfig?: OpenClawCompatConfig,
): Promise<LLMGenerator | null> {
  const apiKey =
    resolveApiKeyFromProviderConfig(provider, openclawConfig?.models?.providers) ??
    resolveApiKey(provider, config?.apiKeyEnv);
  if (!apiKey) return null;

  const baseUrl = resolveBaseUrl(provider, config?.baseUrl);
  if (!baseUrl) return null;

  const isAnthropic = isAnthropicStyleApi(provider, baseUrl);
  log.info(`Direct fallback available: ${provider}/${model} (${isAnthropic ? "anthropic" : "openai-compatible"})`);

  if (isAnthropic) {
    const maxTokens = config?.maxTokens === undefined
      ? undefined
      : Math.max(1, Math.floor(config.maxTokens));
    return async (prompt: string) => callAnthropic(baseUrl, apiKey, model, prompt, maxTokens);
  }
  const maxTokens = config?.maxTokens === undefined
    ? undefined
    : Math.max(1, Math.floor(config.maxTokens));
  return async (prompt: string) => callOpenAICompatible(baseUrl, apiKey, model, prompt, maxTokens);
}
