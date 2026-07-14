import type { Intention } from "./types.js";

const EXPLICIT_DIRECTIVE = /(?:^|[，,。.!！？?]\s*)(?:请|帮我|麻烦|立即|现在)?\s*(?:检查|查看|读取|分析|定位|修复|实现|修改|优化|运行|执行|测试|部署|生成|创建|整理|调查|验证|继续做|开始做)|\b(?:please\s+)?(?:check|inspect|read|analyze|diagnose|fix|implement|modify|optimi[sz]e|run|execute|test|deploy|create|investigate|verify|continue|start)\b/i;
const EXPLANATION_ONLY = /(?:怎么|如何|为什么|是什么|解释|介绍|how (?:do|does|can|would)|why\b|what is|explain|describe)/i;

export function isExplicitUserDirective(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length < 4 || EXPLANATION_ONLY.test(normalized)) return false;
  return EXPLICIT_DIRECTIVE.test(normalized);
}

export function buildUserDirectiveIntention(
  text: string,
  originId: string,
  conversationId?: string,
): Omit<Intention, "id" | "createdAt" | "updatedAt"> {
  const evidenceNeeded: string[] = [];
  if (/(?:修复|实现|修改|优化|部署|fix|implement|modify|optimi[sz]e|deploy)/i.test(text)) {
    evidenceNeeded.push("concrete changed files", "relevant verification command passes");
  } else if (/(?:测试|验证|test|verify)/i.test(text)) {
    evidenceNeeded.push("verification command and concrete result");
  } else if (/(?:检查|查看|分析|定位|调查|inspect|check|analyze|diagnose|investigate)/i.test(text)) {
    evidenceNeeded.push("root cause or finding supported by code, logs, or tool evidence");
  }
  evidenceNeeded.push("clear user-facing outcome report");
  return {
    desiredState: text.replace(/\s+/g, " ").trim().slice(0, 500),
    origin: "user-directive",
    originId,
    conversationId,
    commitment: 1,
    urgency: /立即|马上|现在|urgent|immediately|now\b/i.test(text) ? 0.9 : 0.7,
    confidence: 0.95,
    evidenceNeeded,
    constraints: ["preserve user scope", "respect configured permissions"],
    status: "active",
  };
}
