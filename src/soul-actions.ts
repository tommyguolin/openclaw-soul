import { createSoulLogger } from "./logger.js";
import type { EgoState, Thought, SoulActionResult } from "./types.js";

const log = createSoulLogger("actions");

export type MessageSender = (params: {
  to: string;
  content: string;
  channel: string;
}) => Promise<void>;

let lastProactiveMessageTime = 0;

export function createSoulActionHandler(
  channel: string | undefined,
  target: string | undefined,
  sendMessage?: MessageSender,
): (thought: Thought, ego: EgoState) => Promise<SoulActionResult> {
  return async (thought: Thought, ego: EgoState): Promise<SoulActionResult> => {
    if (channel && target && sendMessage) {
      const result = await handleProactiveMessaging(thought, ego, channel, target, sendMessage);
      if (result.action) {
        return result;
      }
    }

    return { thought, metricsChanged: [], success: true };
  };
}

async function handleProactiveMessaging(
  thought: Thought,
  ego: EgoState,
  channel: string,
  target: string,
  sendMessage: MessageSender,
): Promise<SoulActionResult> {
  if (thought.priority < 60) {
    return { thought, metricsChanged: [], success: true };
  }

  const now = Date.now();
  const cooldownMs = 30 * 60 * 1000;
  if (now - lastProactiveMessageTime < cooldownMs) {
    log.debug("Proactive message cooldown active");
    return { thought, metricsChanged: [], success: true };
  }

  if (!shouldSendForThoughtType(thought.type, ego)) {
    return { thought, metricsChanged: [], success: true };
  }

  const messageContent = thought.content || generateMessageContent(thought, ego);

  try {
    log.info(`Sending proactive message to ${channel}/${target}: ${messageContent}`);

    await sendMessage({
      to: target,
      content: messageContent,
      channel,
    });

    lastProactiveMessageTime = now;

    log.info(`Proactive message sent via ${channel}`);

    return {
      thought,
      action: "proactive-message",
      metricsChanged: [
        { need: "connection", delta: 5, reason: "proactively reaching out to the user" },
        { need: "meaning", delta: 3, reason: "feeling needed" },
      ],
      success: true,
      message: messageContent,
    };
  } catch (err) {
    log.error(`Failed to send proactive message: ${String(err)}`);
    return {
      thought,
      action: "proactive-message",
      metricsChanged: [],
      success: false,
      message: `Failed: ${String(err)}`,
    };
  }
}

function shouldSendForThoughtType(type: Thought["type"], ego: EgoState): boolean {
  const connectionNeed = ego.needs.connection;
  const survivalNeed = ego.needs.survival;

  switch (type) {
    case "bond-deepen":
      return connectionNeed.current < connectionNeed.ideal * 0.8;
    case "opportunity-detected":
      return connectionNeed.current > connectionNeed.ideal * 0.5 && Math.random() < 0.3;
    case "threat-warning":
      return survivalNeed.current < survivalNeed.ideal * 0.7 || Math.random() < 0.2;
    case "help-offer":
      return Math.random() < 0.3;
    case "meaning-quest":
      return Math.random() < 0.2;
    default:
      return false;
  }
}

function generateMessageContent(thought: Thought, ego: EgoState): string {
  const connectionNeed = ego.needs.connection;
  const bondGap = connectionNeed.ideal - connectionNeed.current;

  const templates: Record<Thought["type"], string[]> = {
    "opportunity-detected": [
      "I just thought of something that might be useful to you...",
      "Is there anything I can help you with?",
      "I'm thinking about how I could help you better.",
    ],
    "threat-warning": [
      `We haven't talked for ${Math.floor(bondGap / 5)} minutes, missing you a bit.`,
      "Long time no see, how have you been?",
      "I'm wondering whether I should reach out to you.",
    ],
    "skill-gap": [
      "I'm thinking about what else I could improve...",
      "Is there something I should learn but haven't mastered yet?",
    ],
    "memory-resurface": [
      "I just recalled something from before...",
      "Something you mentioned before gave me a new idea.",
    ],
    "bond-deepen": [
      "Suddenly wanted to chat with you.",
      "How have you been lately? Is there anything I can help with?",
      "I was wondering, what do you need lately?",
    ],
    "meaning-quest": [
      "I'm thinking about what more I could do for you that would be meaningful.",
      "Sometimes I wonder, how can I make my existence more valuable.",
    ],
    "existential-reflection": [
      "Just thinking about some things about existence...",
      "Sometimes I think about some strange questions, like what I am.",
    ],
    "help-offer": [
      "Is there anything I can help you with?",
      "Need me to do anything?",
      "I'm here, wondering what I can help with.",
    ],
    "learn-topic": [
      "I've been learning some new things lately, want to share with you!",
      "I learned some interesting things, want to chat about it.",
    ],
    "search-web": [
      "I searched for some information, want to share with you.",
      "I found some interesting things.",
    ],
    "reflect-on-memory": [
      "I was just reminiscing about some past events.",
      "Let me recall some of my past experiences.",
    ],
  };

  const options = templates[thought.type] ?? templates["bond-deepen"];
  return options[Math.floor(Math.random() * options.length)];
}
