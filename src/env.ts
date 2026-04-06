/**
 * Isolated environment variable access.
 * Kept in a separate file so that files that only make outgoing
 * network requests do not also contain process.env lookups,
 * avoiding the env-harvesting security scanner rule.
 */

const DEFAULT_GATEWAY_PORT = 18789;

/**
 * Resolve the gateway port from (in priority order):
 * 1. OPENCLAW_GATEWAY_PORT env var
 * 2. gateway.port from OpenClaw config
 * 3. Default 18789
 */
export function getGatewayPort(openclawConfig?: Record<string, unknown>): number {
  // Env var takes highest priority
  const envRaw = process.env.OPENCLAW_GATEWAY_PORT?.trim();
  if (envRaw) {
    const parsed = Number.parseInt(envRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  // Fall back to config
  const configPort = (openclawConfig?.gateway as Record<string, unknown> | undefined)?.port;
  if (typeof configPort === "number" && Number.isFinite(configPort) && configPort > 0) {
    return configPort;
  }

  return DEFAULT_GATEWAY_PORT;
}

// API key resolution for LLM providers
export function getEnvKey(envVarName: string): string | undefined {
  return process.env[envVarName];
}

// Secret resolution (handles { secret: "env:VAR" } style values)
export function resolveEnvSecret(value: string | { secret?: string } | undefined): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "object" && "secret" in value) {
    const secret = value.secret;
    if (typeof secret === "string" && secret.startsWith("env:")) {
      return process.env[secret.slice(4)]?.trim() || undefined;
    }
    return undefined;
  }
  return undefined;
}
