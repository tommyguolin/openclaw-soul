// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PluginEvent = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PluginContext = any;
type OpenClawPluginApi = {
  pluginConfig: Record<string, unknown>;
  config: Record<string, unknown>;
  on(event: string, handler: (event: PluginEvent, ctx?: PluginContext) => unknown | Promise<unknown>): void;
  registerService(service: { id: string; start: () => Promise<void>; stop: () => Promise<void> }): void;
};
import { readFileSync } from "node:fs";
import { ThoughtService } from "./src/thought-service.js";
import { createSoulActionHandler, type MessageSender } from "./src/soul-actions.js";
import { createSoulLogger } from "./src/logger.js";
import { resolveLLMConfigFromOpenClaw, type SoulLLMConfig } from "./src/soul-llm.js";
import { getGatewayPort } from "./src/env.js";
import { loadWorkspaceContext } from "./src/paths.js";
import { resolveEgoStorePath, updateEgoStore } from "./src/ego-store.js";

const log = createSoulLogger("plugin");

/**
 * Normalize the target format for a given channel.
 * Discord requires "user:<id>" for DMs — auto-prefix bare numeric IDs.
 */
function normalizeTarget(channel: string, target: string): string {
  if (channel === "feishu" && target.startsWith("feishu:")) {
    return target.slice("feishu:".length);
  }
  if (channel === "discord" && /^\d{10,}$/.test(target)) {
    return `user:${target}`;
  }
  return target;
}

/**
 * Build a sendMessage function that delivers a proactive message directly
 * to a channel via the gateway's /tools/invoke HTTP endpoint.
 *
 * Uses the "message" tool with action="send", which delivers text verbatim
 * without agent reprocessing. Requires the "message" tool to be available
 * (add tools.alsoAllow: ["message"] to openclaw.yaml if using a restrictive
 * tool profile like "coding").
 *
 * Falls back to /hooks/agent with deliver:true if /tools/invoke returns 404.
 */
function buildSendMessage(opts: {
  openclawConfig: Record<string, unknown>;
  getChannel: () => string | undefined;
  getTarget: () => string | undefined;
}): MessageSender {
  const authToken = resolveGatewayAuthToken(opts.openclawConfig);
  const hooks = (opts.openclawConfig.hooks ?? {}) as Record<string, unknown>;
  const hooksToken = typeof hooks.token === "string" ? hooks.token.trim() : "";
  const gatewayPort = getGatewayPort(opts.openclawConfig);

  const token = authToken || hooksToken;

  if (!token) {
    log.warn(
      "Proactive messaging requires auth token. Add to openclaw.yaml:\n" +
        '  gateway:\n    auth:\n      token: "<your-secret-token>"\n' +
        "  or set hooks.token",
    );
  }

  return async (params) => {
    if (!token) {
      throw new Error(
        "sendMessage: no auth token. Set gateway.auth.token or hooks.token in openclaw.yaml",
      );
    }

    const channel = params.channel || opts.getChannel();
    const rawTarget = params.to || opts.getTarget();
    if (!channel || !rawTarget) {
      throw new Error("sendMessage: no channel/target resolved yet");
    }

    // Normalize target format per channel:
    // Discord requires "user:<id>" for DMs — auto-prefix bare numeric IDs
    const target = normalizeTarget(channel, rawTarget);

    log.debug(`Sending proactive message to ${channel}/${target}: ${params.content.slice(0, 300)}`);

    // Primary: use /tools/invoke with message tool for direct delivery
    try {
      const toolUrl = `http://127.0.0.1:${gatewayPort}/tools/invoke`;
      const toolBody = {
        tool: "message",
        args: {
          action: "send",
          message: params.content,
          channel,
          target,
        },
      };

      const toolRes = await fetch(toolUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(toolBody),
        signal: AbortSignal.timeout(30_000),
      });

      if (toolRes.ok) {
        log.info(`Proactive message delivered via ${channel} to ${target} (tools/invoke)`);
        return;
      }

      // If 404 (tool not available), fall back to hooks
      const toolData = await toolRes.json().catch(() => ({})) as { error?: { type?: string } };
      if (toolRes.status !== 404 && toolData.error?.type !== "not_found") {
        const text = await toolRes.text().catch(() => "");
        throw new Error(`sendMessage via tools/invoke failed: ${toolRes.status} - ${text.slice(0, 200)}`);
      }
      log.info("message tool not available, falling back to /hooks/agent");
    } catch (err) {
      if (err instanceof Error && err.message.includes("tools/invoke failed")) {
        throw err;
      }
      log.info(`tools/invoke error, falling back to /hooks/agent: ${String(err)}`);
    }

    // Fallback: use /hooks/agent with deliver:true
    const hooksUrl = `http://127.0.0.1:${gatewayPort}/hooks/agent`;
    const hooksBody = {
      message: params.content,
      deliver: true,
      channel,
      to: target,
      name: "Soul",
    };

    const hooksRes = await fetch(hooksUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${hooksToken}`,
      },
      body: JSON.stringify(hooksBody),
      signal: AbortSignal.timeout(30_000),
    });

    if (!hooksRes.ok) {
      const text = await hooksRes.text().catch(() => "");
      throw new Error(`sendMessage via hooks failed: ${hooksRes.status} - ${text.slice(0, 200)}`);
    }
    log.info(`Proactive message delivered via ${channel} to ${target} (hooks fallback)`);
  };
}

/**
 * Resolve the gateway auth token for tool invocation.
 * Uses gateway.auth.token first, falls back to hooks.token.
 */
function resolveGatewayAuthToken(openclawConfig: Record<string, unknown>): string | undefined {
  const gateway = openclawConfig.gateway as Record<string, unknown> | undefined;
  const auth = gateway?.auth as Record<string, unknown> | undefined;
  if (auth?.token && typeof auth.token === "string") return auth.token;

  // Fallback: hooks.token also works for gateway auth
  const hooks = openclawConfig.hooks as Record<string, unknown> | undefined;
  if (hooks?.token && typeof hooks.token === "string") return hooks.token;

  return undefined;
}

function resolveHooksToken(openclawConfig: Record<string, unknown>): string | undefined {
  const hooks = openclawConfig.hooks as Record<string, unknown> | undefined;
  if (hooks?.token && typeof hooks.token === "string") return hooks.token;
  return undefined;
}

let thoughtService: ThoughtService | null = null;
let serviceCreated = false;
let lastPluginConfig = "";

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
  autonomousActions?: boolean;
  workspaceFiles?: string[];
  /** Thought frequency multiplier. Default: 1.0. Set lower (e.g. 0.2) for faster testing. */
  thoughtFrequency?: number;
  /** Private shadow emergence probability per eligible interval. Default: 0.1. */
  shadowThoughtRate?: number;
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

function loadPersistedProactiveEndpoint(): { channel?: string; target?: string } {
  try {
    const raw = readFileSync(resolveEgoStorePath(), "utf-8");
    const parsed = JSON.parse(raw) as {
      ego?: { proactiveChannel?: unknown; proactiveTarget?: unknown };
    };
    const channel = typeof parsed.ego?.proactiveChannel === "string"
      ? parsed.ego.proactiveChannel
      : undefined;
    const target = typeof parsed.ego?.proactiveTarget === "string"
      ? parsed.ego.proactiveTarget
      : undefined;
    return {
      channel,
      target: channel && target ? normalizeTarget(channel, target) : target,
    };
  } catch {
    return {};
  }
}

const plugin = {
  id: "soul",
  name: "Soul",
  description: "Autonomous thinking, emotional awareness, and memory system",
  version: "2.5.0",
  enabledByDefault: true,
  configSchema: {
    type: "object",
    additionalProperties: true,
    properties: {
      enabled: { type: "boolean", description: "Enable/disable soul service. Default: true" },
      autonomousActions: { type: "boolean", description: "Enable autonomous write operations (editing files, running commands). Read operations always allowed. Default: false" },
      thoughtFrequency: { type: "number", description: "Thought frequency multiplier. Default: 1.0. Lower = more frequent (e.g. 0.2 for testing), higher = less frequent" },
      shadowThoughtRate: { type: "number", minimum: 0, maximum: 1, description: "Private actionless shadow thought probability. Default: 0.1" },
      llm: {
        type: "object",
        additionalProperties: true,
        properties: {
          provider: { type: "string" },
          model: { type: "string" },
          apiKeyEnv: { type: "string" },
          baseUrl: { type: "string" },
          maxTokens: { type: "number", minimum: 32, maximum: 4096 },
        },
      },
    },
  },

  register(api: OpenClawPluginApi) {
    const configStr = JSON.stringify(api.pluginConfig ?? {});
    if (configStr !== lastPluginConfig) {
      lastPluginConfig = configStr;
      log.info(`pluginConfig received: ${configStr}`);
    }

    const config = cfg<PluginConfig>(api.pluginConfig);

    // Inner `enabled` defaults to true; only skip if explicitly set to false
    if (config.enabled === false) {
      log.info("Soul service disabled by config.enabled=false");
      return;
    }

    const openclawConfig = api.config as Record<string, unknown>;

    // Mutable state shared between service creation and hooks — must be at
    // register() scope so the message_received hook can auto-learn the target.
    const persistedEndpoint = loadPersistedProactiveEndpoint();
    let proactiveChannel = config.proactiveChannel ?? persistedEndpoint.channel;
    let proactiveTarget = config.proactiveTarget ?? persistedEndpoint.target;
    const observedInboundChannels = new Set<string>();
    if (proactiveChannel) observedInboundChannels.add(proactiveChannel);

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
            proactiveTarget = normalizeTarget(proactiveChannel, proactiveTarget);
          }
          if (proactiveChannel && proactiveTarget) {
            log.info(`Proactive messaging: auto-detected ${proactiveChannel}/${proactiveTarget}`);
            void updateEgoStore(resolveEgoStorePath(), (ego) => {
              ego.proactiveChannel = proactiveChannel ?? null;
              ego.proactiveTarget = proactiveTarget ?? null;
              return ego;
            }).catch((err) => log.warn(`Failed to persist proactive endpoint: ${String(err)}`));
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
      const workspaceFiles = config.workspaceFiles ?? ["SOUL.md", "AGENTS.md", "MEMORY.md", "USER.md"];
      serviceCreated = true;
      thoughtService = new ThoughtService({
        checkIntervalMs: config.checkIntervalMs ?? 60_000,
        llmConfig,
        proactiveChannel,
        proactiveTarget,
        sendMessage,
        openclawConfig,
        autonomousActions: config.autonomousActions ?? false,
        gatewayPort: getGatewayPort(openclawConfig),
        authToken: resolveGatewayAuthToken(openclawConfig),
        hooksToken: resolveHooksToken(openclawConfig),
        onThought: createSoulActionHandler(),
        workspaceFiles,
        thoughtFrequency: config.thoughtFrequency ?? 1.0,
        shadowThoughtRate: config.shadowThoughtRate ?? 0.1,
      });

      api.registerService({
        id: "soul-thought-service",
        start: async () => {
          await thoughtService!.refreshWorkspaceContext();
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
      const service = thoughtService;
      if (!service?.isRunning()) return;

      try {
        const prompt = await service.getSystemPrompt(
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
      const messageId =
        typeof _event === "object" && _event !== null && "messageId" in _event
          ? String((_event as { messageId?: string }).messageId ?? "")
          : "";
      const conversationId =
        typeof _ctx === "object" && _ctx !== null && "conversationId" in _ctx
          ? String((_ctx as { conversationId?: string }).conversationId ?? "")
          : "";

      // Unconditional diagnostic — fires regardless of service state
      log.info(`message_received hook fired: text=${text.length} chars, from=${from || "(none)"}, channel=${channelId || "(none)"}, running=${thoughtService?.isRunning() ?? "no service"}`);

      const service = thoughtService;
      if (!service) return;

      if (channelId) observedInboundChannels.add(channelId);

      try {
        // Auto-learn proactive channel/target from first inbound message
        if (from && channelId && !proactiveTarget) {
          if (!proactiveChannel) proactiveChannel = channelId;
          proactiveTarget = normalizeTarget(channelId, from);
          service.updateProactiveTarget(channelId, proactiveTarget);
          await updateEgoStore(resolveEgoStorePath(), (ego) => {
            ego.proactiveChannel = proactiveChannel ?? channelId;
            ego.proactiveTarget = proactiveTarget ?? null;
            return ego;
          });
          log.info(`Proactive target auto-learned from first message: ${channelId}/${proactiveTarget}`);
        } else if (from && channelId) {
          const endpoint = service.getProactiveEndpoint();
          const normalizedEndpointTarget = endpoint.channel && endpoint.target
            ? normalizeTarget(endpoint.channel, endpoint.target)
            : endpoint.target;
          if (endpoint.channel !== channelId || endpoint.target !== from) {
            await updateEgoStore(resolveEgoStorePath(), (ego) => {
              ego.proactiveChannel = endpoint.channel ?? proactiveChannel ?? channelId;
              ego.proactiveTarget = normalizedEndpointTarget ?? proactiveTarget ?? normalizeTarget(channelId, from);
              return ego;
            });
          }
        }

        // Abort any in-progress thought — user interaction takes priority
        if (service.isRunning()) {
          service.abortCurrentThought();
          service.resume();
        }

        // Run all processing in the background so we don't block the agent
        // turn. The hook must return quickly (<1s) to avoid feishu streaming
        // card timeouts (30s). LLM calls for facts/preferences can take
        // 30-60s total, so they MUST be fire-and-forget.
        //
        // Token cost: extractUserFacts ~300 tokens, extractUserPreferences
        // ~300 tokens. Only run these for substantive messages (>=15 chars)
        // to avoid wasting tokens on short replies like "ok", "收到", "好的".
        // Delay LLM calls by 2 minutes to avoid competing with the agent's
        // response LLM call for gateway/provider resources.
        if (text.length >= 15) {
          const delayMs = 2 * 60 * 1000; // 2 minutes
          service.recordInteractionWithText({
            type: "inbound",
            text,
            messageId: messageId || undefined,
            channel: channelId || undefined,
            conversationId: conversationId || undefined,
          })
            .catch((err) => log.warn(`Record interaction failed: ${String(err)}`));
          setTimeout(() => {
            service.extractUserFacts(text, messageId || undefined)
              .then(() => service.extractUserPreferences(text))
              .catch((err) => log.warn(`Background message processing failed: ${String(err)}`));
          }, delayMs);
        } else if (text.length >= 5) {
          service.recordInteractionWithText({
            type: "inbound",
            text,
            messageId: messageId || undefined,
            channel: channelId || undefined,
            conversationId: conversationId || undefined,
          })
            .catch((err) => log.warn(`Record interaction failed: ${String(err)}`));
        } else {
          service.recordInteraction({ type: "inbound" }).catch((err) =>
            log.warn(`Record interaction failed: ${String(err)}`),
          );
        }
      } catch (err) {
        log.warn(`message_received hook failed: ${String(err)}`);
      }
    });

    const recordOutboundInteraction = async (_event: PluginEvent, _ctx?: PluginContext): Promise<void> => {
      if (!thoughtService) return;
      try {
        const text = typeof _event?.content === "string" ? _event.content : "";
        const messageId = typeof _event?.messageId === "string" ? _event.messageId : undefined;
        const channel = typeof _ctx?.channelId === "string" ? _ctx.channelId : undefined;
        const conversationId = typeof _ctx?.conversationId === "string" ? _ctx.conversationId : undefined;
        if (!channel || !observedInboundChannels.has(channel)) return;
        if (text.length >= 5) {
          await thoughtService.recordInteractionWithText({
            type: "outbound",
            text,
            messageId,
            channel,
            conversationId,
          });
        } else {
          await thoughtService.recordInteraction({ type: "outbound" });
        }
      } catch (err) {
        log.warn(`outbound message hook failed: ${String(err)}`);
      }
    };

    // Some channel adapters (including Feishu streaming replies) emit
    // message_sending but not message_sent. Register both and rely on
    // message provenance/content idempotency to avoid duplicate memories.
    api.on("message_sending", recordOutboundInteraction);
    api.on("message_sent", recordOutboundInteraction);

    // Some streaming adapters bypass the generic outbound lifecycle. The
    // synchronous transcript-write hook is not a raw-conversation typed hook,
    // so non-bundled plugins do not need allowConversationAccess. Restrict it
    // to channel-backed assistant sessions: internal Soul/shadow model runs
    // have no channel segment and remain private.
    api.on("before_message_write", (_event, _ctx) => {
      const message = _event?.message;
      if (!thoughtService || !message || message.role !== "assistant") return;
      const sessionKey = typeof _event?.sessionKey === "string"
        ? _event.sessionKey
        : typeof _ctx?.sessionKey === "string" ? _ctx.sessionKey : "";
      const parts = sessionKey.split(":");
      const channel = parts[0] === "agent" && parts.length >= 4 ? parts[2] : undefined;
      if (!channel || !observedInboundChannels.has(channel)) return;
      const content = message.content;
      const text = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.filter((part: unknown): part is { type: string; text: string } =>
            !!part && typeof part === "object"
            && (part as { type?: unknown }).type === "text"
            && typeof (part as { text?: unknown }).text === "string",
          ).map((part: { text: string }) => part.text).join("\n")
          : "";
      if (text.trim().length < 5) return;
      void thoughtService.recordInteractionWithText({
        type: "outbound",
        text,
        channel,
        conversationId: sessionKey,
      }).catch((err) => log.warn(`before_message_write outbound capture failed: ${String(err)}`));
    });

    log.debug("Soul plugin registered (hooks: before_prompt_build, message_received, before_message_write, message_sending, message_sent)");
  },
};

export { plugin as default };
