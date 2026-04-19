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
import { loadWorkspaceContext } from "./src/paths.js";

const log = createSoulLogger("plugin");

/**
 * Normalize the target format for a given channel.
 * Discord requires "user:<id>" for DMs — auto-prefix bare numeric IDs.
 */
function normalizeTarget(channel: string, target: string): string {
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
  version: "2.3.3",
  enabledByDefault: true,
  configSchema: {
    type: "object",
    additionalProperties: true,
    properties: {
      enabled: { type: "boolean", description: "Enable/disable soul service. Default: true" },
      autonomousActions: { type: "boolean", description: "Enable autonomous write operations (editing files, running commands). Read operations always allowed. Default: false" },
      thoughtFrequency: { type: "number", description: "Thought frequency multiplier. Default: 1.0. Lower = more frequent (e.g. 0.2 for testing), higher = less frequent" },
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
        // Auto-learn proactive channel/target from first inbound message
        if (from && channelId && !proactiveTarget) {
          if (!proactiveChannel) proactiveChannel = channelId;
          proactiveTarget = from;
          thoughtService.updateProactiveTarget(channelId, from);
          log.info(`Proactive target auto-learned from first message: ${channelId}/${from}`);
        }

        // Abort any in-progress thought — user interaction takes priority
        thoughtService.abortCurrentThought();
        thoughtService.resume();

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
          thoughtService.recordInteractionWithText({ type: "inbound", text })
            .catch((err) => log.warn(`Record interaction failed: ${String(err)}`));
          setTimeout(() => {
            thoughtService.extractUserFacts(text)
              .then(() => thoughtService.extractUserPreferences(text))
              .catch((err) => log.warn(`Background message processing failed: ${String(err)}`));
          }, delayMs);
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
