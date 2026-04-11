import { createSoulLogger } from "./logger.js";

const log = createSoulLogger("gateway-client");

export interface ToolInvokeResult {
  ok: boolean;
  result?: string;
  error?: string;
}

/** Write-capable gateway tools that require autonomousActions config. */
const WRITE_TOOLS = new Set(["write", "edit", "apply_patch"]);

/**
 * Shell commands that are safe read-only operations.
 * Any exec command NOT matching these patterns is treated as a write operation.
 */
const READ_ONLY_COMMANDS = /^(?:cat|head|tail|grep|ls|find|wc|diff|which|whoami|pwd|echo|stat|file|du|df|free|uptime|uname|date|ps|top|ss|netstat|ip|ifconfig|env|printenv|node\s+-e\s+"console\.log)/;

/**
 * Check if a gateway tool invocation requires write permission.
 * - write/edit/apply_patch → always write
 * - exec → depends on the command (read-only commands are safe)
 * - everything else → read
 */
export function isWriteTool(tool: string, args?: Record<string, unknown>): boolean {
  if (WRITE_TOOLS.has(tool)) return true;
  if (tool === "exec") {
    const command = typeof args?.command === "string" ? args.command.trim() : "";
    // If the command doesn't start with a known read-only prefix, treat as write
    return !READ_ONLY_COMMANDS.test(command);
  }
  return false;
}

/**
 * Invoke a single gateway tool via POST /tools/invoke.
 * Returns structured result with ok/error.
 */
export async function invokeGatewayTool(params: {
  tool: string;
  args: Record<string, unknown>;
  gatewayPort: number;
  authToken?: string;
  timeoutMs?: number;
}): Promise<ToolInvokeResult> {
  const { tool, args, gatewayPort, authToken, timeoutMs = 30_000 } = params;

  const url = `http://127.0.0.1:${gatewayPort}/tools/invoke`;
  const body = { tool, args };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const data = await res.json() as { ok?: boolean; result?: string; error?: { message?: string; type?: string } };

    if (!res.ok || data.ok === false) {
      const errMsg = typeof data.error === "object" ? data.error?.message : String(data.error);
      log.warn(`Tool invoke failed: ${tool} → ${errMsg ?? res.status}`);
      return { ok: false, error: errMsg ?? `HTTP ${res.status}` };
    }

    // Result may be string or object; stringify if not already
    const resultStr = typeof data.result === "string"
      ? data.result
      : JSON.stringify(data.result, null, 2);

    // Truncate very large results to avoid blowing up memory/LLM context
    const maxLen = 10_000;
    const truncated = resultStr && resultStr.length > maxLen
      ? resultStr.slice(0, maxLen) + `\n... [truncated, ${resultStr.length} chars total]`
      : resultStr;

    return { ok: true, result: truncated };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Tool invoke error: ${tool} → ${msg}`);
    return { ok: false, error: msg };
  }
}

/**
 * Fire-and-forget agent run via POST /hooks/agent.
 * The agent runs asynchronously with full tool access.
 * Returns the runId for tracking.
 */
export async function fireAgentTask(params: {
  message: string;
  gatewayPort: number;
  hooksToken: string;
  deliver?: boolean;
  channel?: string;
  to?: string;
  timeoutSeconds?: number;
}): Promise<{ ok: boolean; runId?: string; error?: string }> {
  const { message, gatewayPort, hooksToken, deliver, channel, to, timeoutSeconds } = params;

  const url = `http://127.0.0.1:${gatewayPort}/hooks/agent`;
  const body: Record<string, unknown> = {
    message,
    name: "Soul-Autonomous",
    deliver: deliver ?? false,
  };
  if (channel) body.channel = channel;
  if (to) body.to = to;
  if (timeoutSeconds) body.timeoutSeconds = timeoutSeconds;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${hooksToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    const data = await res.json() as { ok?: boolean; runId?: string };
    return { ok: true, runId: data.runId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
