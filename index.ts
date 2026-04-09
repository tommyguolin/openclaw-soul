// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PluginEvent = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PluginContext = any;
type OpenClawPluginApi = {
  pluginConfig: Record<string, unknown>;
  config: Record<string, unknown>;
  on(event: string, handler: (event: PluginEvent, ctx?: PluginContext) => Promise<unknown>): void;
  registerService(service: { id: string; start: () => Promise<void>; stop: () => Promise<void> }): void;
};
import { ThoughtService } from "./src/thought-service.js";
import { createSoulActionHandler, type MessageSender } from "./src/soul-actions.js";
import { createSoulLogger } from "./src/logger.js";
import { resolveLLMConfigFromOpenClaw, type SoulLLMConfig } from "./src/soul-llm.js";
import { getGatewayPort } from "./src/env.js";

const log = createSoulLogger("plugin");

/**
 * Build a sendMessage function that delivers a proactive message through
 * the gateway hooks agent endpoint (POST /hooks/agent with deliver: true).
 *
 * This avoids using child_process.execSync which triggers OpenClaw's
 * security scanner. The gateway handles all channel routing transparently.
 * Requires hooks.enabled: true and hooks.token in openclaw.yaml.
 */
function buildSendMessage(opts: {
  openclawConfig: Record<string, unknown>;
  getChannel: () => string | undefined;
  getTarget: () => string | undefined;
}): MessageSender {
  // Pre-resolve hooks config at build time (not per-call)
  const hooks = (opts.openclawConfig.hooks ?? {}) as Record<string, unknown>;
  const hooksEnabled = hooks.enabled === true;
  const hooksToken = typeof hooks.token === "string" ? hooks.token.trim() : "";
  const gatewayPort = getGatewayPort(opts.openclawConfig);

  if (!hooksEnabled || !hooksToken) {
    log.warn(
      "Proactive messaging requires hooks config. Add to openclaw.yaml:\n" +
        '  hooks:\n    enabled: true\n    token: "<your-secret-token>"',
    );
  }

  return async (params) => {
    if (!hooksEnabled || !hooksToken) {
      throw new Error(
        "sendMessage: hooks not configured. Set hooks.enabled=true and hooks.token in openclaw.yaml",
      );
    }

    const channel = params.channel || opts.getChannel();
    const target = params.to || opts.getTarget();
    if (!channel || !target) {
      throw new Error("sendMessage: no channel/target resolved yet");
    }

    const url = `http://127.0.0.1:${gatewayPort}/hooks/agent`;
    const body = {
      message: params.content,
      deliver: true,
      channel,
      to: target,
      name: "Soul",
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${hooksToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`sendMessage via hooks failed: ${res.status} - ${text.slice(0, 200)}`);
    }
    log.info(`Proactive message delivered via ${channel} to ${target} (hooks)`);
  };
}

let thoughtService: ThoughtService | null = null;
let serviceCreated = false;

/**
 * Extract a typed config value from pluginConfig.
 */
function cfg<T = Record<string, unknown>>(pluginConfig: Record<string, unknown> | undefined): T {
  return (pluginConfig ?? {}) as T;
}

type PluginConfig = {
  enabled?: boolean;
  checkIntervalMs?: number;
  proactiveMessaging?: boolean;
  proactiveChannel?: string;
  proactiveTarget?: string;
  llm?: SoulLLMConfig;
};
// Note: `enabled` in PluginConfig is the inner service toggle (default: true).
// The outer `plugins.entries.soul.enabled` (in openclaw.json) controls plugin loading.

/**
 * Auto-detect the first active channel from OpenClaw's channels config.
 * Returns { channel, target } or undefined.
 */
function autoDetectChannel(
  openclawConfig: Record<string, unknown>,
): { channel: string; target?: string } | undefined {
  const channels = openclawConfig.channels as Record<string, unknown> | undefined;
  if (!channels) return undefined;

  // Check known channel types in a reasonable priority order
  const channelTypes = [
    "telegram",
    "discord",
    "slack",
    "whatsapp",
    "signal",
    "imessage",
    "feishu",
    "msteams",
    "matrix",
    "web",
  ];

  // First pass: find a channel with a resolvable target
  for (const ch of channelTypes) {
    const chConfig = channels[ch];
    if (chConfig && typeof chConfig === "object") {
      const cfg = chConfig as Record<string, unknown>;
      const target =
        cfg.ownerId ??
        cfg.owner ??
        cfg.chatId ??
        cfg.defaultChatId ??
        (Array.isArray(cfg.allowedUsers) && cfg.allowedUsers.length > 0
          ? cfg.allowedUsers[0]
          : undefined) ??
        (Array.isArray(cfg.allowedChatIds) && cfg.allowedChatIds.length > 0
          ? cfg.allowedChatIds[0]
          : undefined);

      if (target) {
        return { channel: ch, target: String(target) };
      }
    }
  }

  // Second pass: return first configured channel even without target
  // (some channels like feishu don't store a recipient in their config)
  for (const ch of channelTypes) {
    const chConfig = channels[ch];
    if (chConfig && typeof chConfig === "object") {
      return { channel: ch };
    }
  }

  return undefined;
}

const plugin = {
  id: "soul",
  name: "Soul",
  description: "Autonomous thinking, emotional awareness, and memory system",
  version: "1.0.0",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean", description: "Enable/disable soul service. Default: true" },
      checkIntervalMs: { type: "number", description: "Thought check interval in ms. Default: 60000" },
      proactiveMessaging: { type: "boolean", description: "Allow soul to send proactive messages. Default: true" },
      proactiveChannel: { type: "string", description: "Override: channel for proactive messages (auto-detected if omitted)" },
      proactiveTarget: { type: "string", description: "Override: target for proactive messages (auto-detected if omitted)" },
      llm: {
        type: "object",
        description: "Override: LLM config (auto-detected from OpenClaw if omitted)",
        properties: {
          provider: { type: "string" },
          model: { type: "string" },
          apiKeyEnv: { type: "string" },
          baseUrl: { type: "string" },
        },
      },
    },
  },

  register(api: OpenClawPluginApi) {
    const config = cfg<PluginConfig>(api.pluginConfig);

    // Inner `enabled` defaults to true; only skip if explicitly set to false
    if (config.enabled === false) {
      log.info("Soul service disabled by config.enabled=false");
      return;
    }

    const openclawConfig = api.config as Record<string, unknown>;

    // Mutable state shared between service creation and hooks — must be at
    // register() scope so the message_received hook can auto-learn the target.
    let proactiveChannel = config.proactiveChannel;
    let proactiveTarget = config.proactiveTarget;

    // --- Service singleton: only create ThoughtService ONCE ---
    // The gateway may call register() multiple times (e.g. for different agent
    // session registries). We must always register hooks (api.on) for each
    // registry, but the ThoughtService instance is shared.
    if (!serviceCreated) {
      // --- 1. Auto-resolve LLM config from OpenClaw's primary model ---
      const llmConfig = resolveLLMConfigFromOpenClaw(
        openclawConfig as Parameters<typeof resolveLLMConfigFromOpenClaw>[0],
        config.llm,
      );

      if (llmConfig.provider && llmConfig.model) {
        log.info(`LLM: ${llmConfig.provider}/${llmConfig.model} (auto-detected from OpenClaw config)`);
      } else {
        log.warn("No LLM configured — soul will use rule-based thought generation only");
        log.warn("Configure agents.defaults.model in openclaw.yaml, or set plugins.soul.llm");
      }

      // --- 2. Auto-resolve proactive messaging channel from OpenClaw's channels config ---
      const proactiveMessaging = config.proactiveMessaging !== false; // default: true

      if (proactiveMessaging && (!proactiveChannel || !proactiveTarget)) {
        const detected = autoDetectChannel(openclawConfig);
        if (detected) {
          proactiveChannel ??= detected.channel;
          proactiveTarget ??= detected.target;
          if (proactiveChannel && proactiveTarget) {
            log.info(`Proactive messaging: auto-detected ${proactiveChannel}/${proactiveTarget}`);
          } else if (proactiveChannel) {
            log.info(`Proactive messaging: auto-detected channel ${proactiveChannel}`);
            log.warn(`proactiveTarget not set — soul will think but won't send messages. Set plugins.soul.config.proactiveTarget.`);
          }
        }
      }

      // --- 3. Message sender (uses openclaw CLI for universal channel support) ---
      // Throws on failure so action-executor can catch and handle the error.
      const sendMessage: MessageSender | undefined =
        proactiveMessaging
          ? buildSendMessage({
              openclawConfig,
              getChannel: () => proactiveChannel,
              getTarget: () => proactiveTarget,
            })
          : undefined;

      // --- 4. Create and register the thought service ---
      serviceCreated = true;
      thoughtService = new ThoughtService({
        checkIntervalMs: config.checkIntervalMs ?? 60_000,
        llmConfig,
        proactiveChannel,
        proactiveTarget,
        sendMessage,
        openclawConfig,
        onThought: createSoulActionHandler(),
      });

      api.registerService({
        id: "soul-thought-service",
        start: async () => {
          await thoughtService!.start();
          log.info("Soul thought service started");
        },
        stop: async () => {
          thoughtService?.stop();
          log.info("Soul thought service stopped");
        },
      });
    } else {
      log.debug("Soul ThoughtService already running — re-registering hooks only");
    }

    // --- 5. Inject soul system prompt via before_prompt_build hook ---
    api.on("before_prompt_build", async (_event, _ctx) => {
      if (!thoughtService?.isRunning()) return;

      try {
        const prompt = await thoughtService.getSystemPrompt(
          typeof _event === "object" && _event !== null && "prompt" in _event
            ? String((_event as { prompt?: string }).prompt ?? "")
            : "",
        );
        if (prompt) {
          return { appendSystemContext: prompt };
        }
      } catch (err) {
        log.warn(`before_prompt_build hook failed: ${String(err)}`);
      }
      return undefined;
    });

    // --- 6. Track message interactions for soul memory ---
    api.on("message_received", async (_event, _ctx) => {
      const text =
        typeof _event === "object" && _event !== null && "content" in _event
          ? String((_event as { content?: string }).content ?? "")
          : "";
      const from =
        typeof _event === "object" && _event !== null && "from" in _event
          ? String((_event as { from?: string }).from ?? "")
          : "";
      const channelId =
        typeof _ctx === "object" && _ctx !== null && "channelId" in _ctx
          ? String((_ctx as { channelId?: string }).channelId ?? "")
          : "";

      // Unconditional diagnostic — fires regardless of service state
      log.info(`message_received hook fired: text=${text.length} chars, from=${from || "(none)"}, channel=${channelId || "(none)"}, running=${thoughtService?.isRunning() ?? "no service"}`);

      if (!thoughtService?.isRunning()) return;

      try {
        // Auto-learn proactive target from first inbound message
        if (from && channelId && !proactiveTarget) {
          proactiveTarget = from;
          log.info(`Proactive target auto-learned from first message: ${channelId}/${from}`);
        }

        // Abort any in-progress thought — user interaction takes priority
        thoughtService.abortCurrentThought();

        // Run all processing in the background so we don't block the agent
        // turn. The hook must return quickly (<1s) to avoid feishu streaming
        // card timeouts (30s). LLM calls for facts/preferences can take
        // 30-60s total, so they MUST be fire-and-forget.
        //
        // Token cost: extractUserFacts ~300 tokens, extractUserPreferences
        // ~300 tokens. Only run these for substantive messages (>=15 chars)
        // to avoid wasting tokens on short replies like "ok", "收到", "好的".
        if (text.length >= 15) {
          thoughtService.recordInteractionWithText({ type: "inbound", text })
            .then(() => thoughtService.extractUserFacts(text))
            .then(() => thoughtService.extractUserPreferences(text))
            .catch((err) => log.warn(`Background message processing failed: ${String(err)}`));
        } else if (text.length >= 5) {
          thoughtService.recordInteractionWithText({ type: "inbound", text })
            .catch((err) => log.warn(`Record interaction failed: ${String(err)}`));
        } else {
          thoughtService.recordInteraction({ type: "inbound" }).catch((err) =>
            log.warn(`Record interaction failed: ${String(err)}`),
          );
        }
      } catch (err) {
        log.warn(`message_received hook failed: ${String(err)}`);
      }
    });

    api.on("message_sent", async (_event) => {
      if (!thoughtService?.isRunning()) return;
      try {
        await thoughtService.recordInteraction({ type: "outbound" });
      } catch (err) {
        log.warn(`message_sent hook failed: ${String(err)}`);
      }
    });

    log.debug("Soul plugin registered (hooks: before_prompt_build, message_received, message_sent)");
  },
};

export { plugin as default };
