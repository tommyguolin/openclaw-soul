import type { Thought, SoulActionResult, EgoState } from "./types.js";

export type MessageSender = (params: {
  to: string;
  content: string;
  channel: string;
}) => Promise<void>;

/**
 * Create a thought handler that applies thought metrics only.
 * Proactive messaging is handled exclusively by action-executor.ts.
 */
export function createSoulActionHandler(
  _channel?: string,
  _target?: string,
  _sendMessage?: MessageSender,
): (thought: Thought, ego: EgoState) => Promise<SoulActionResult> {
  return async (thought: Thought, _ego: EgoState): Promise<SoulActionResult> => {
    return { thought, metricsChanged: [], success: true };
  };
}
