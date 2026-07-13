import { contentTokens, jaccard } from "../thought-emergence.js";

export type FeedbackObservation =
  | "explicit-positive"
  | "explicit-negative"
  | "explicit-correction"
  | "reply-related"
  | "reply-unrelated"
  | "no-reply-window";

export type ProactiveFeedback =
  | "engaged" | "useful" | "adopted" | "already-known" | "ignored"
  | "corrected" | "annoying" | "bad-timing" | "unclear";

export interface FeedbackInference {
  label: ProactiveFeedback;
  confidence: number;
  observations: FeedbackObservation[];
}

export interface ExpressionFeedbackEvent {
  id: string;
  proposalId: string;
  replySourceId?: string;
  replyText?: string;
  observedAt: number;
  observations: FeedbackObservation[];
  inference: FeedbackInference;
}

export interface AdaptiveExpressionPolicyState {
  minimumAgeMultiplier: number;
  valueThresholdDelta: number;
  interruptionCost: number;
  samples: number;
}

export function inferExpressionFeedback(reply: string, proposalContent: string): FeedbackInference {
  const related = jaccard(contentTokens(reply), contentTokens(proposalContent)) >= 0.08;
  const observations: FeedbackObservation[] = [related ? "reply-related" : "reply-unrelated"];
  const negative = /(?:别再|不要再|烦|打扰|时机不对|稍后再说|没用|stop sending|don'?t send|annoying|bad timing|not useful)/i.test(reply);
  const correction = !/(?:时机不对|bad timing)/i.test(reply)
    && /(?:不对|错了|并不是|不是.*而是|纠正|已经知道|早就知道|incorrect|wrong|actually|already knew|already know)/i.test(reply);
  const positive = /(?:谢谢|有用|帮到了|正是|很好|采纳|明白了|thanks|helpful|useful|great|adopted|that helps)/i.test(reply);
  if (correction) observations.unshift("explicit-correction");
  else if (negative) observations.unshift("explicit-negative");
  else if (positive) observations.unshift("explicit-positive");

  let label: ProactiveFeedback = related ? "engaged" : "unclear";
  let confidence = related ? 0.65 : 0.35;
  if (correction) {
    label = /已经知道|早就知道|already knew|already know/i.test(reply) ? "already-known" : "corrected";
    confidence = 0.9;
  } else if (negative) {
    label = /烦|打扰|stop sending|don'?t send|annoying/i.test(reply) ? "annoying"
      : /时机不对|稍后再说|bad timing/i.test(reply) ? "bad-timing" : "unclear";
    confidence = label === "unclear" ? 0.55 : 0.88;
  } else if (positive) {
    label = /采纳|adopted/i.test(reply) ? "adopted" : "useful";
    confidence = 0.88;
  }
  return { label, confidence, observations };
}

export function inferNoReplyFeedback(): FeedbackInference {
  return { label: "unclear", confidence: 0.15, observations: ["no-reply-window"] };
}
