import { execSync } from "node:child_process";
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

const log = createSoulLogger("plugin");

/**
 * Build a sendMessage function that uses `openclaw message send` CLI.
 *
 * This works for ALL channels (telegram, discord, slack, feishu, etc.)
 * without needing channel-specific SDK imports.
 * Throws on failure so action-executor can catch and handle the error.
 */
function buildSendMessage(opts: {
  getChannel: () => string | undefined;
  getTarget: () => string | undefined;
}): MessageSender {
  return async (params) => {
    const channel = params.channel || opts.getChannel();
    const target = params.to || opts.getTarget();
    if (!channel || !target) {
      throw new Error("sendMessage: no channel/target resolved yet");
    }

    const escapedContent = params.content.replace(/'/g, "'\\''");
    const cmd = `openclaw message send --channel ${channel} --target ${target} --message '${escapedContent}'`;

    try {
      execSync(cmd, {
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      log.info(`Proactive message delivered via ${channel} to ${target}`);
    } catch (err) {
      const stderr = (err as { stderr?: Buffer })?.stderr?.toString().trim() ?? "";
      throw new Error(`sendMessage failed (channel=${channel}): ${stderr || String(err)}`);
    }
  };
}

let thoughtService: ThoughtService | null = null;

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
    if (!thoughtService?.isRunning()) {
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
              getChannel: () => proactiveChannel,
              getTarget: () => proactiveTarget,
            })
          : undefined;

      // --- 4. Create and register the thought service ---
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
      log.info("Soul ThoughtService already running — re-registering hooks only");
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

        if (text.length >= 5) {
          await thoughtService.recordInteractionWithText({ type: "inbound", text });
          await thoughtService.extractUserFacts(text);
          await thoughtService.extractUserPreferences(text).catch((err) =>
            log.warn(`User preference extraction failed: ${String(err)}`),
          );
        } else {
          await thoughtService.recordInteraction({ type: "inbound" });
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

    log.info("Soul plugin registered (hooks: before_prompt_build, message_received, message_sent)");
  },
};

export { plugin as default };
