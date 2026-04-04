import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { ThoughtService } from "./src/thought-service.js";
import { createSoulActionHandler, type MessageSender } from "./src/soul-actions.js";
import { createSoulLogger } from "./src/logger.js";
import { resolveLLMConfigFromOpenClaw, type SoulLLMConfig } from "./src/soul-llm.js";
import { getGatewayPort } from "./src/env.js";

const log = createSoulLogger("plugin");

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
    // Guard: prevent re-registration from overwriting a running service instance.
    // The gateway may call register() multiple times (e.g. on config reload or channel connect).
    // If thoughtService already exists and is running, bail out to keep the original instance.
    if (thoughtService?.isRunning()) {
      log.debug("Soul plugin already registered and running, skipping re-registration");
      return;
    }

    const config = cfg<PluginConfig>(api.pluginConfig);

    // Inner `enabled` defaults to true; only skip if explicitly set to false
    if (config.enabled === false) {
      log.info("Soul service disabled by config.enabled=false");
      return;
    }

    const openclawConfig = api.config as Record<string, unknown>;

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
    let proactiveChannel = config.proactiveChannel;
    let proactiveTarget = config.proactiveTarget;

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

    // --- 3. Message sender (uses gateway HTTP API) ---
    // Captured by reference — reads latest proactiveChannel/proactiveTarget at call time
    const sendMessage: MessageSender | undefined =
      proactiveMessaging
        ? async (params) => {
            const ch = params.channel || proactiveChannel;
            const target = params.to || proactiveTarget;
            if (!ch || !target) {
              log.debug(`sendMessage skipped: no channel/target resolved yet`);
              return;
            }
            try {
              const port = getGatewayPort();
              const response = await fetch(`http://127.0.0.1:${port}/api/message/send`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  to: target,
                  content: params.content,
                  channel: ch,
                }),
              });
              if (!response.ok) {
                log.warn(`Message send failed: ${response.status}`);
              }
            } catch (err) {
              log.warn(`Message send error: ${String(err)}`);
            }
          }
        : undefined;

    // --- 4. Create and register the thought service ---
    thoughtService = new ThoughtService({
      checkIntervalMs: config.checkIntervalMs ?? 60_000,
      llmConfig,
      proactiveChannel,
      proactiveTarget,
      sendMessage,
      openclawConfig,
      onThought: createSoulActionHandler(
        proactiveMessaging ? proactiveChannel : undefined,
        proactiveMessaging ? proactiveTarget : undefined,
        sendMessage,
      ),
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
      if (!thoughtService?.isRunning()) return;

      try {
        const text =
          typeof _event === "object" && _event !== null && "text" in _event
            ? String((_event as { text?: string }).text ?? "")
            : "";
        const from =
          typeof _event === "object" && _event !== null && "from" in _event
            ? String((_event as { from?: string }).from ?? "")
            : "";
        const channelId =
          typeof _ctx === "object" && _ctx !== null && "channelId" in _ctx
            ? String((_ctx as { channelId?: string }).channelId ?? "")
            : "";

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

    log.info("Soul plugin registered");
  },
};

export { plugin as default };
