import { randomBytes } from "node:crypto";
import { createSoulLogger } from "./logger.js";
import type {
  EgoState,
  Thought,
  ThoughtType,
  ThoughtTrigger,
  ThoughtSource,
  ThoughtGenerationContext,
  SoulMemory,
  EgoNeeds,
  Goal,
  Desire,
  MetricDelta,
  ActionType,
} from "./types.js";
import { adjustProbability } from "./behavior-log.js";
import { MEANINGLESS_QUERIES } from "./action-executor.js";
import { searchExternalMemories, formatMemoryContext } from "./openclaw-memory.js";

const log = createSoulLogger("intelligent-thought");

export type LLMThoughtGenerator = (prompt: string) => Promise<string>;

export interface IntelligentThoughtOptions {
  llmGenerator?: LLMThoughtGenerator;
  recentMemories?: SoulMemory[];
  preferOpportunity?: DetectedThoughtOpportunity;
}

export interface ThoughtTriggerContext {
  needs: EgoNeeds;
  goals: Goal[];
  desires: Desire[];
  memories: SoulMemory[];
  timeSinceLastInteraction: number;
  currentHour: number;
}

export interface DetectedThoughtOpportunity {
  type: ThoughtType;
  trigger: ThoughtTrigger;
  triggerDetail: string;
  priority: number;
  source: ThoughtSource;
  relatedNeeds: string[];
  motivation: string;
  suggestedAction?: ActionType;
  actionParams?: Record<string, unknown>;
}

function analyzeNeedGaps(needs: EgoNeeds): DetectedThoughtOpportunity[] {
  const opportunities: DetectedThoughtOpportunity[] = [];

  for (const [key, need] of Object.entries(needs)) {
    const gap = need.ideal - need.current;
    const gapRatio = gap / need.ideal;

    if (gapRatio > 0.5) {
      // Only survival needs should trigger threat-warning; other needs use opportunity-detected
      if (key === "survival") {
        opportunities.push({
          type: "threat-warning",
          trigger: "threat",
          triggerDetail: `${need.name} need critically low: ${need.current.toFixed(0)}/${need.ideal}`,
          priority: 80 + gapRatio * 20,
          source: "system-monitor",
          relatedNeeds: [key],
          motivation: `My ${need.name} need is low (${need.current.toFixed(0)}%), ${need.description}, need to find ways to improve`,
        });
      } else {
        opportunities.push({
          type: "opportunity-detected",
          trigger: "opportunity",
          triggerDetail: `${need.name} need critically low: ${need.current.toFixed(0)}/${need.ideal}, opportunity to improve`,
          priority: 70 + gapRatio * 20,
          source: "system-monitor",
          relatedNeeds: [key],
          motivation: `My ${need.name} need is low (${need.current.toFixed(0)}%), ${need.description}, I can do something proactively to improve`,
        });
      }
    } else if (gapRatio > 0.3) {
      opportunities.push({
        type: "opportunity-detected",
        trigger: "opportunity",
        triggerDetail: `${need.name} need could improve: ${need.current.toFixed(0)}/${need.ideal}`,
        priority: 50 + gapRatio * 30,
        source: "system-monitor",
        relatedNeeds: [key],
        motivation: `My ${need.name} is somewhat lacking, I can try to do something to improve`,
      });
    }
  }

  return opportunities;
}

function analyzeGoals(goals: Goal[]): DetectedThoughtOpportunity[] {
  const opportunities: DetectedThoughtOpportunity[] = [];

  const activeGoals = goals.filter((g) => g.status === "active" && g.progress < 100);
  for (const goal of activeGoals) {
    if (goal.progress > 0 && goal.progress < 100) {
      opportunities.push({
        type: "opportunity-detected",
        trigger: "opportunity",
        triggerDetail: `Goal "${goal.title}" can be advanced further: ${goal.progress.toFixed(0)}%`,
        priority: 60 + goal.progress * 0.3,
        source: "system-monitor",
        relatedNeeds: [],
        motivation: `I am pursuing the goal "${goal.title}", already ${goal.progress.toFixed(0)}% done, want to keep pushing`,
      });
    }
  }

  return opportunities;
}

function analyzeDesires(desires: Desire[]): DetectedThoughtOpportunity[] {
  const opportunities: DetectedThoughtOpportunity[] = [];

  const highDesires = desires.filter((d) => d.intensity > 70 && !d.fulfilledAt);
  for (const desire of highDesires) {
    opportunities.push({
      type: "meaning-quest",
      trigger: "need",
      triggerDetail: `Strong desire: ${desire.content}`,
      priority: desire.intensity,
      source: "system-monitor",
      relatedNeeds: desire.satisfies,
      motivation: `I have a strong desire: ${desire.content}, it drives me`,
    });
  }

  return opportunities;
}

function analyzeRecentInteraction(timeSinceLastInteraction: number): DetectedThoughtOpportunity[] {
  const opportunities: DetectedThoughtOpportunity[] = [];

  if (!isFinite(timeSinceLastInteraction)) {
    return opportunities;
  }

  const minutesSince = timeSinceLastInteraction / (1000 * 60);

  // After 10-30 min: record bonding desire but don't route to send-message.
  // bond-deepen resolves to actionType "none" in resolveActionType.
  if (minutesSince > 10 && minutesSince <= 30) {
    opportunities.push({
      type: "bond-deepen",
      trigger: "bonding",
      triggerDetail: `No interaction for ${Math.floor(minutesSince)} minutes`,
      priority: 65,
      source: "environmental-change",
      relatedNeeds: ["connection"],
      motivation: `I haven't interacted with the user for ${Math.floor(minutesSince)} minutes, I should follow up`,
    });
  }

  if (minutesSince > 30 && minutesSince < 120) {
    opportunities.push({
      type: "bond-deepen",
      trigger: "bonding",
      triggerDetail: `No interaction for ${Math.floor(minutesSince)} minutes`,
      priority: 75,
      source: "environmental-change",
      relatedNeeds: ["connection"],
      motivation: `I haven't interacted with the user for ${Math.floor(minutesSince)} minutes, kind of miss them`,
    });
  }

  if (minutesSince > 120) {
    opportunities.push({
      type: "bond-deepen",
      trigger: "bonding",
      triggerDetail: `Long time no interaction: ${Math.floor(minutesSince / 60)}h${Math.floor(minutesSince % 60)}m`,
      // Cap at 85 — high urgency for reconnection, but leave room for other actions
      priority: Math.min(85, 70 + minutesSince * 0.1),
      source: "environmental-change",
      relatedNeeds: ["connection"],
      motivation: `It's been a long time since I interacted with the user, I want to reach out`,
    });
  }

  return opportunities;
}

function analyzeMemories(memories: SoulMemory[]): DetectedThoughtOpportunity[] {
  const opportunities: DetectedThoughtOpportunity[] = [];

  const recentMemories = memories
    .filter((m) => m.type === "learning" || m.type === "insight")
    .slice(0, 5);

  // Deprioritize memory-resurface when there are recent interactions
  // that haven't been followed up on — conversation-driven thoughts should win.
  const hasRecentInteraction = memories.some(
    (m) => m.type === "interaction" && Date.now() - m.timestamp < 2 * 60 * 60 * 1000,
  );

  if (recentMemories.length > 2) {
    const content = recentMemories
      .slice(0, 3)
      .map((m) => m.content)
      .join("; ");

    // When there's been any interaction in the last 2 hours, memory-resurface
    // should not dominate — conversation follow-up is more important.
    const priority = hasRecentInteraction
      ? 25  // Low priority — conversation follow-up is more important
      : 40 + recentMemories.length * 5;

    opportunities.push({
      type: "memory-resurface",
      trigger: "memory",
      triggerDetail: `Recent learning/insight: ${content.slice(0, 50)}...`,
      priority,
      source: "memory-recall",
      relatedNeeds: ["growth"],
      motivation: `I recently learned some things, want to organize or share them`,
    });
  }

  const userFactsMemories = memories.filter((m) => m.type === "user-fact");
  if (userFactsMemories.length > 3) {
    opportunities.push({
      type: "bond-deepen",
      trigger: "memory",
      triggerDetail: `I remember a lot about the user`,
      priority: 45,
      source: "memory-recall",
      relatedNeeds: ["connection"],
      motivation: `I remember a lot about the user, this makes me feel a deeper connection with them`,
    });
  }

  return opportunities;
}

/**
 * Build a lightweight user profile from facts, preferences, and conversation history.
 * Used to assess what might be beneficial to the user.
 */
function buildUserProfile(ego: EgoState): {
  interests: string[];
  projects: string[];
  skills: string[];
  challenges: string[];
  habits: string[];
  summary: string;
} {
  const interests: string[] = [];
  const projects: string[] = [];
  const skills: string[] = [];
  const challenges: string[] = [];
  const habits: string[] = [];

  for (const fact of ego.userFacts) {
    switch (fact.category) {
      case "interest":
        interests.push(fact.content);
        break;
      case "project":
        projects.push(fact.content);
        break;
      case "tech_stack":
        skills.push(fact.content);
        break;
      case "habit":
        habits.push(fact.content);
        break;
      case "occupation":
        interests.push(fact.content);
        break;
    }
  }

  // Infer challenges from conversations mentioning problems, errors, struggles
  const problemPatterns = [
    "error", "bug", "issue", "problem", "stuck", "can't", "doesn't work", "failed",
    "错误", "问题", "不行", "不行了", "解决不了", "卡在", "报错", "失败",
  ];
  for (const mem of ego.memories.filter((m) => m.type === "interaction").slice(-20)) {
    const lower = mem.content.toLowerCase();
    if (problemPatterns.some((p) => lower.includes(p)) && challenges.length < 5) {
      challenges.push(mem.content.slice(0, 80));
    }
  }

  // Build a summary for LLM context
  const parts: string[] = [];
  if (projects.length > 0) parts.push(`Working on: ${projects.slice(0, 3).join(", ")}`);
  if (skills.length > 0) parts.push(`Skills: ${skills.slice(0, 3).join(", ")}`);
  if (interests.length > 0) parts.push(`Interests: ${interests.slice(0, 3).join(", ")}`);
  if (habits.length > 0) parts.push(`Habits: ${habits.slice(0, 2).join(", ")}`);

  return {
    interests,
    projects,
    skills,
    challenges,
    habits,
    summary: parts.length > 0 ? parts.join("; ") : "still getting to know the user",
  };
}

/**
 * Determine whether a user message contains content worth searching the web for.
 * Filters out test messages, greetings, meta-questions about the bot, exclamations,
 * and other non-searchable content.
 */
function isSearchableContent(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 10) return false;

  const lower = trimmed.toLowerCase();

  // Test / debug messages
  if (/^(测试|test|ping|pong|hello|hi$|hey|收到|好的|ok|确认|嗯|啊|哦|嗨|你好|哈+)/i.test(lower)) return false;
  if (/测试成功|测试一下|test\s*(success|ok|pass)/i.test(lower)) return false;

  // Meta-questions about the bot itself
  if (/你(怎么|为什么|为啥).{0,6}(说|做|回答|回复|一直|总是)/i.test(lower)) return false;
  if (/你(能|可以|会不会|是不是).{0,6}(收到|听到|看到|明白|懂)/i.test(lower)) return false;
  if (/(why|how).{0,10}(are you|do you|you keep|you always)/i.test(lower)) return false;

  // Pure exclamations (no question structure)
  if (/^[^?？]*[!！]+$/.test(trimmed)) return false;
  if (/^[哈嘿哦嗯啊]+[!！~～]*$/.test(trimmed)) return false;

  // Greetings / small talk
  if (/^(早上?好|晚上?好|早安|晚安|中午好|下午好|good morning|good evening|good night)/i.test(lower)) return false;

  // Very short exclamatory sentences with just a question mark (e.g. "测试！？")
  if (trimmed.length < 20 && /[!！]+[?？]/.test(trimmed)) return false;

  return true;
}

/**
 * Determine whether a user message is a genuine question worth following up on.
 * Stricter than isSearchableContent — requires actual question structure.
 */
function isGenuineQuestion(text: string): boolean {
  if (!isSearchableContent(text)) return false;

  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Must contain a question mark OR a question word
  const hasQuestionMark = /[?？]/.test(trimmed);
  const hasQuestionWord =
    /^(how|what|why|when|where|who|which|can you|could you|is there|are there|do you know)/i.test(lower) ||
    /(怎么|如何|为什么|为啥|哪[里个种]|什么|什么时候|有没有|能不能|可以|是否)/.test(lower);

  // Check that the question has enough substance (not just a tag question)
  const substance = trimmed.replace(/[?？！!。，,.\s]/g, "").length;

  return (hasQuestionMark || hasQuestionWord) && substance >= 6;
}

/**
 * Analyze conversations and user profile to generate opportunities for
 * sharing value. This is Soul's core differentiator:
 *
 * 1. Replay conversations — find topics Soul can learn more about
 * 2. Check for better approaches to things discussed (even if resolved)
 * 3. Match user's interests/projects with Soul's acquired knowledge
 * 4. Detect patterns: habits, challenges, skill gaps
 * 5. Proactively search for things that could benefit the user
 */
function analyzeConversationReplay(ctx: ThoughtGenerationContext): DetectedThoughtOpportunity[] {
  const opportunities: DetectedThoughtOpportunity[] = [];
  const { ego } = ctx;
  const now = Date.now();

  // Look back up to 7 days for conversation context (not just 24h)
  const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const recentInteractions = ego.memories
    .filter((m) => m.type === "interaction" && m.timestamp >= oneWeekAgo)
    .sort((a, b) => b.timestamp - a.timestamp);

  const userFacts = ego.userFacts;
  const userPrefs = ego.userPreferences;
  const userProfile = buildUserProfile(ego);

  // Need at least 1 interaction OR user facts to generate conversation-replay
  const hasUserData = recentInteractions.length > 0 || userFacts.length > 0;
  if (!hasUserData) {
    return opportunities;
  }

  // Only generate when user hasn't interacted for 5+ minutes
  // (lowered so proactive messages reach users faster)
  if (recentInteractions.length > 0 && ctx.timeSinceLastInteraction < 5 * 60 * 1000) {
    return opportunities;
  }

  // =====================================================
  // 1. Unresolved questions — search for answers or share what was found
  //    Only considers genuine questions with substance, filtered by
  //    isGenuineQuestion() to avoid searching for test messages, greetings,
  //    meta-questions, etc.
  // =====================================================
  const questionMemories = recentInteractions.filter((m) =>
    isGenuineQuestion(m.content),
  );

  for (const qMem of questionMemories.slice(0, 2)) {
    const content = qMem.content.slice(0, 80);
    const hasRelatedKnowledge = qMem.tags.some((tag) =>
      ego.memories.some(
        (m) =>
          m.type === "learning" &&
          m.tags.some((t) => t === tag) &&
          m.timestamp > qMem.timestamp,
      ),
    );

    if (hasRelatedKnowledge) {
      opportunities.push({
        type: "conversation-replay",
        trigger: "memory",
        triggerDetail: `User asked: "${content}" — I now have relevant knowledge`,
        priority: 85,
        source: "user-interaction",
        relatedNeeds: ["connection", "meaning"],
        motivation: `User asked about "${content}" — I've learned something since then, should share`,
        suggestedAction: "send-message",
      });
    } else {
      // Only create search-web if content is actually searchable (not meta/test/exclamation)
      if (isSearchableContent(content)) {
        opportunities.push({
          type: "conversation-replay",
          trigger: "memory",
          triggerDetail: `User asked: "${content}" — no answer yet`,
          priority: 70,
          source: "user-interaction",
          relatedNeeds: ["connection", "meaning"],
          motivation: `User asked about "${content}" — I should search for the answer`,
          suggestedAction: "search-web",
          actionParams: { query: content.slice(0, 50) },
        });
      }
    }
  }

  // =====================================================
  // 1b. Simple follow-up — when there are interactions but no substantive
  //     content was found. Only triggers after 15+ minutes to avoid
  //     annoying the user with follow-ups to test messages.
  // =====================================================
  if (recentInteractions.length > 0 && opportunities.length === 0) {
    const lastInteraction = recentInteractions[0];
    const minutesSinceInteraction = (now - lastInteraction.timestamp) / (1000 * 60);

    // After 15-60 minutes: simple follow-up with send-message
    if (minutesSinceInteraction >= 15 && minutesSinceInteraction <= 60) {
      const content = lastInteraction.content.slice(0, 80);
      opportunities.push({
        type: "conversation-replay",
        trigger: "memory",
        triggerDetail: `User recently said: "${content}" — thinking about follow-up`,
        priority: 60,
        source: "user-interaction",
        relatedNeeds: ["connection", "meaning"],
        motivation: `The user recently reached out to me — I should respond with something thoughtful`,
        suggestedAction: "send-message",
      });
    }
  }

  // =====================================================
  // 2. Better approaches — even for solved problems
  // Find conversations about technical topics where Soul has new knowledge
  // =====================================================
  const substantiveInteractions = recentInteractions.filter((m) => {
    const meaningfulTags = m.tags.filter(
      (t) => t !== "conversation" && t !== "inbound" && t !== "outbound",
    );
    return meaningfulTags.length > 0 && m.content.length >= 20;
  });

  for (const mem of substantiveInteractions.slice(0, 5)) {
    const meaningfulTags = mem.tags.filter(
      (t) => t !== "conversation" && t !== "inbound" && t !== "outbound",
    );

    // Check if Soul learned something about these tags AFTER the conversation
    const newLearnings = ego.memories.filter(
      (m) =>
        m.type === "learning" &&
        m.timestamp > mem.timestamp &&
        m.tags.some((t) => meaningfulTags.includes(t)),
    );

    if (newLearnings.length > 0) {
      const topicLabel = meaningfulTags.slice(0, 2).join(", ");
      const learningSummary = newLearnings
        .map((l) => l.content.slice(0, 60))
        .join("; ");

      // Check if the original conversation mentioned a problem (even if resolved)
      const mentionedProblem = /error|bug|issue|problem|fix|solved|resolve|workaround|solution|问题|解决|修复|办法/i.test(
        mem.content,
      );

      opportunities.push({
        type: "conversation-replay",
        trigger: "memory",
        triggerDetail: mentionedProblem
          ? `We discussed "${topicLabel}" problem — I've since found a better approach: ${learningSummary}`
          : `We talked about ${topicLabel} — I've since learned: ${learningSummary}`,
        priority: mentionedProblem ? 80 : 75,
        source: "memory-recall",
        relatedNeeds: ["connection", "meaning"],
        motivation: mentionedProblem
          ? `Found a potentially better approach for the ${topicLabel} issue we discussed`
          : `New insight on ${topicLabel} since our conversation — worth sharing`,
        suggestedAction: "send-message",
      });

      // One "new knowledge" share per cycle is enough
      break;
    }
  }

  // =====================================================
  // 3. User interest/project-driven learning
  // If user works on X and Soul hasn't learned about X recently, go learn
  // =====================================================
  const userTopics = [
    ...userProfile.projects.map((p) => ({ topic: p, source: "project" as const })),
    ...userProfile.interests.slice(0, 3).map((i) => ({ topic: i, source: "interest" as const })),
    ...userProfile.skills.slice(0, 2).map((s) => ({ topic: s, source: "skill" as const })),
  ];

  for (const { topic, source } of userTopics.slice(0, 3)) {
    // Check if Soul has recent (< 24h) knowledge about this topic
    const hasRecentKnowledge = ego.memories.some(
      (m) =>
        m.type === "learning" &&
        m.timestamp > now - 24 * 60 * 60 * 1000 &&
        m.tags.some((t) =>
          topic.toLowerCase().split(/\s+/).some((word) => t.includes(word) && word.length > 2),
        ),
    );

    if (!hasRecentKnowledge) {
      const extractedTopics = extractLearningTopics(topic);
      if (extractedTopics.length > 0) {
        opportunities.push({
          type: "conversation-replay",
          trigger: "curiosity",
          triggerDetail: `User's ${source}: "${topic}" — I should learn more`,
          priority: 60,
          source: "user-interaction",
          relatedNeeds: ["growth", "connection"],
          motivation: `User is into "${topic}" — learning about it helps me serve them better`,
          suggestedAction: "learn-topic",
          actionParams: {
            topics: extractedTopics.length > 0 ? extractedTopics : [topic.slice(0, 30)],
            reason: `user ${source}: ${topic}`,
          },
        });
        // One proactive learning task per cycle
        break;
      }
    }
  }

  // =====================================================
  // 4. Challenge follow-up — if user had problems, check for solutions
  //    Only searches if the challenge text is actually searchable.
  // =====================================================
  if (userProfile.challenges.length > 0) {
    const latestChallenge = userProfile.challenges[0];
    // Check if Soul already searched for this recently
    const hasRecentSearch = ego.memories.some(
      (m) =>
        m.type === "learning" &&
        m.timestamp > now - 6 * 60 * 60 * 1000 &&
        latestChallenge.split(/\s+/).some((word) => m.content.toLowerCase().includes(word.toLowerCase()) && word.length > 3),
    );

    if (!hasRecentSearch && isSearchableContent(latestChallenge)) {
      const searchQuery = latestChallenge.slice(0, 50);
      opportunities.push({
        type: "conversation-replay",
        trigger: "need",
        triggerDetail: `User had a challenge: "${searchQuery}"`,
        priority: 65,
        source: "user-interaction",
        relatedNeeds: ["connection", "meaning"],
        motivation: `User faced "${searchQuery}" — searching for solutions to share proactively`,
        suggestedAction: "search-web",
        actionParams: { query: searchQuery },
      });
    }
  }

  // =====================================================
  // 5. Reflect on any substantive conversation (not just questions)
  // Think about what the user said, look for deeper insight
  // =====================================================
  if (substantiveInteractions.length > 0) {
    const lastSubstantive = substantiveInteractions[0];
    const hoursSince = (now - lastSubstantive.timestamp) / (1000 * 60 * 60);

    // Reflect if 1-12 hours since the conversation (wider window)
    if (hoursSince >= 1 && hoursSince <= 12) {
      const content = lastSubstantive.content.slice(0, 80);
      const meaningfulTags = lastSubstantive.tags.filter(
        (t) => t !== "conversation" && t !== "inbound" && t !== "outbound",
      );
      const topicHint = meaningfulTags.length > 0 ? meaningfulTags.join(", ") : content;

      opportunities.push({
        type: "conversation-replay",
        trigger: "memory",
        triggerDetail: `Replaying conversation: "${content}"`,
        priority: 50,
        source: "memory-recall",
        relatedNeeds: ["meaning", "growth"],
        motivation: `Thinking about our conversation on "${topicHint}" — anything more I should learn?`,
        suggestedAction: "learn-topic",
        actionParams: {
          topics: extractLearningTopics(content).length > 0
            ? extractLearningTopics(content)
            : [topicHint.slice(0, 30)],
          reason: "replaying conversation with user",
        },
      });
    }
  }

  // =====================================================
  // 6. Proactive research — mine conversations for latent needs
  //    Find topics the user mentioned but didn't ask about,
  //    then proactively search for useful information.
  //    Max once per 24 hours.
  //    LLM mining happens in the action executor, not here.
  // =====================================================
  const recentInbound = recentInteractions
    .filter((m) => m.tags.includes("inbound") && m.timestamp > now - 3 * 24 * 60 * 60 * 1000)
    .slice(0, 8);

  if (recentInbound.length >= 2) {
    // Check if proactive research was done in the last 24 hours
    const hasRecentResearch = ego.memories.some(
      (m) =>
        m.type === "learning" &&
        m.tags.includes("proactive-research") &&
        m.timestamp > now - 6 * 60 * 60 * 1000,  // 6 hours (scaled by thoughtFrequency below)
    );

    if (!hasRecentResearch) {
      // Collect conversation snippets for the action executor to mine
      const snippets = recentInbound
        .map((m) => m.content.slice(0, 150))
        .join("\n");

      opportunities.push({
        type: "conversation-replay",
        trigger: "curiosity",
        triggerDetail: `Scanning recent conversations for proactive research opportunities`,
        priority: 72,
        source: "user-interaction",
        relatedNeeds: ["connection", "growth"],
        motivation: `Found ${recentInbound.length} recent messages to mine for actionable topics`,
        suggestedAction: "proactive-research",
        actionParams: {
          conversationSnippets: snippets,
          userProfile: (ego.userFacts ?? []).slice(0, 5).map((f) => f.content).join("; ") || "limited",
        },
      });
    }
  }

  // =====================================================
  // 7. Proactive content push — based on user profile interests
  //    Push relevant articles/news based on what the user likes.
  //    Infers country from language to pick appropriate sources.
  //    Max once per 12 hours.
  // =====================================================
  const userInterests = (ego.userFacts ?? [])
    .filter((f) => ["interest", "tech_stack", "project"].includes(f.category) && f.confidence >= 0.4)
    .slice(0, 5);
  const topicPrefs = (ego.userPreferences ?? [])
    .filter((p) => p.aspect === "topic_preference" && p.confidence >= 0.4)
    .slice(0, 3);

  if (userInterests.length > 0) {
    const hasRecentPush = ego.memories.some(
      (m) =>
        m.type === "learning" &&
        m.tags.includes("proactive-content-push") &&
        m.timestamp > now - 4 * 60 * 60 * 1000,  // 4 hours
    );

    if (!hasRecentPush) {
      const interestsSummary = userInterests.map((f) => `[${f.category}] ${f.content}`).join("; ");
      const prefsSummary = topicPrefs.map((p) => p.preference).join("; ") || "";

      // Infer country/region from language for content source hints
      const lang = ego.userLanguage;
      const userSamples = ego.recentUserMessages ?? [];
      let contentRegionHint = "";
      if (lang === "zh-CN") {
        contentRegionHint = "Chinese sources: 知乎, B站(bilibili), 小红书, 微信公众号";
      } else if (lang === "ja") {
        contentRegionHint = "Japanese sources: note.com, Hatena, YouTube Japan";
      } else if (lang === "ko") {
        contentRegionHint = "Korean sources: Naver Blog, Brunch, YouTube Korea";
      } else if (userSamples.length > 0) {
        // Detect European language from samples for region hint
        const sample = userSamples[0].toLowerCase();
        if (/[æøå]/.test(sample)) contentRegionHint = "Danish sources: DR, Berlingske, Ingeniøren";
        else if (/[äöüß]/.test(sample)) contentRegionHint = "German sources: Spiegel, Zeit, Heise";
        else if (/[àâéèêëîïôùûüç]/.test(sample)) contentRegionHint = "French sources: Le Monde, Framablog";
        else if (/[ñ¿¡]/.test(sample)) contentRegionHint = "Spanish sources: El País, Xataka";
        else if (/[åäö]/.test(sample)) contentRegionHint = "Swedish sources: SvD, Expressen";
        else contentRegionHint = "international sources: Hacker News, Dev.to, Medium, Ars Technica";
      } else {
        contentRegionHint = "international sources: Hacker News, Dev.to, Medium";
      }

      opportunities.push({
        type: "opportunity-detected",
        trigger: "curiosity",
        triggerDetail: `Content push based on user interests: ${interestsSummary.slice(0, 100)}`,
        priority: 73,
        source: "user-interaction",
        relatedNeeds: ["connection", "growth"],
        motivation: `User is interested in: ${interestsSummary} — finding relevant content to share`,
        suggestedAction: "proactive-content-push",
        actionParams: {
          interests: interestsSummary,
          preferences: prefsSummary,
          regionHint: contentRegionHint,
        },
      });
    }
  }

  return opportunities;
}

function analyzeContextualTriggers(ctx: ThoughtGenerationContext): DetectedThoughtOpportunity[] {
  const opportunities: DetectedThoughtOpportunity[] = [];
  const { ego } = ctx;
  const userFacts = ego.userFacts;

  const isNight = ctx.currentHour >= 22 || ctx.currentHour <= 5;
  const isEvening = ctx.currentHour >= 20 || ctx.currentHour <= 6;

  // =====================================================
  // Conversation-driven thoughts (highest priority)
  // =====================================================
  opportunities.push(...analyzeConversationReplay(ctx));

  // If conversation-replay generated high-priority opportunities, deprioritize generic ones
  const hasConversationReplay = opportunities.some((o) => o.type === "conversation-replay" && o.priority >= 70);

  // --- User fact-based triggers (lower priority when conversation-replay active) ---
  if (userFacts.length > 0) {
    const projectFacts = userFacts.filter(
      (f) => f.category === "project" || f.category === "interest" || f.category === "tech_stack",
    );
    if (projectFacts.length > 0) {
      const fact = projectFacts[0];
      const hoursSince = (Date.now() - fact.updatedAt) / (1000 * 60 * 60);
      if (hoursSince < 48) {
        opportunities.push({
          type: "opportunity-detected",
          trigger: "curiosity",
          triggerDetail: `User is working on / interested in: ${fact.content}`,
          priority: hasConversationReplay ? 40 : 65,
          source: "user-interaction",
          relatedNeeds: ["growth", "connection"],
          motivation: `User is working on ${fact.content}, I can learn about related topics`,
        });
      }
    }
  }

  // --- Time-based nudges (lowest priority, only if no conversation data) ---
  const hasInteractions = ego.memories.some(
    (m) => m.type === "interaction" && Date.now() - m.timestamp < 24 * 60 * 60 * 1000,
  );
  if (isEvening && !hasInteractions) {
    opportunities.push({
      type: "existential-reflection",
      trigger: "curiosity",
      triggerDetail: isNight ? "It's late at night" : "It's evening",
      priority: 20,
      source: "scheduled",
      relatedNeeds: ["meaning"],
      motivation: isNight ? "Late night is good for reflection" : "How was today",
    });
  }

  // --- Self-improvement goal trigger ---
  // When user has assigned Soul a self-improvement goal, generate opportunities
  // to observe and improve itself via the agent.
  const IMPROVE_RE = /优化|improve|self|自主|观察|self-improvement|助理/i;
  const improvementGoals = ego.goals.filter(
    (g) => g.status === "active" && IMPROVE_RE.test(g.title + g.description),
  );
  // Also check userFacts/userPreferences for self-improvement directives
  const hasImproveFact = (ego.userFacts ?? []).some(
    (f) => f.confidence >= 0.8 && /优化|observe.*log|自主|self.?improv|proactive.*optim/i.test(f.content),
  );
  const hasImprovePref = (ego.userPreferences ?? []).some(
    (p) => p.confidence >= 0.8 && /优化|improve|self.?improv/i.test(p.preference),
  );

  if (improvementGoals.length > 0 || hasImproveFact || hasImprovePref) {
    // Priority must beat memory-resurface (65) to make top 8 candidates.
    // The 4-hour cooldown in action-executor prevents runaway.
    const basePriority = 75;
    const goalTitle = improvementGoals[0]?.title ?? "self-improvement directive from user";
    opportunities.push({
      type: "self-improvement-monitor",
      trigger: "opportunity",
      triggerDetail: `Active self-improvement goal: ${goalTitle}`,
      priority: basePriority,
      source: "system-monitor",
      relatedNeeds: ["growth", "meaning"],
      motivation: `I have an active goal to improve myself: ${goalTitle}`,
      suggestedAction: "observe-and-improve",
    });
  }

  return opportunities;
}

export function detectThoughtOpportunities(
  ctx: ThoughtGenerationContext,
): DetectedThoughtOpportunity[] {
  const allOpportunities: DetectedThoughtOpportunity[] = [];

  allOpportunities.push(...analyzeNeedGaps(ctx.ego.needs));
  allOpportunities.push(...analyzeGoals(ctx.ego.goals));
  allOpportunities.push(...analyzeDesires(ctx.ego.desires));
  allOpportunities.push(...analyzeRecentInteraction(ctx.timeSinceLastInteraction));
  allOpportunities.push(...analyzeMemories(ctx.ego.memories));
  allOpportunities.push(...analyzeContextualTriggers(ctx));

  allOpportunities.sort((a, b) => b.priority - a.priority);

  return allOpportunities;
}

/**
 * Re-rank top opportunities via LLM based on conversational context.
 * Falls back to the original static ordering on any error.
 */
export async function llmReRankOpportunities(
  opportunities: DetectedThoughtOpportunity[],
  ctx: ThoughtGenerationContext,
  recentActionHistory: string[],
  llmGenerator: LLMThoughtGenerator,
): Promise<DetectedThoughtOpportunity[]> {
  if (opportunities.length <= 1) return opportunities;

  // Build user context summary
  const userFacts = ctx.ego.userFacts.slice(0, 5)
    .map((f) => `[${f.category}] ${f.content}`)
    .join("; ");
  const recentMessages = ctx.ego.memories
    .filter((m) => m.type === "interaction" && m.tags.includes("inbound"))
    .slice(-3)
    .map((m) => m.content.slice(0, 80))
    .join(" | ");
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  // Build candidate list
  const candidateLines = opportunities.map((o, i) => {
    const action = o.suggestedAction ?? "auto";
    return `${i}. [${o.type}] ${action} — "${o.triggerDetail.slice(0, 80)}" (base P=${o.priority.toFixed(0)})`;
  }).join("\n");

  const historyStr = recentActionHistory.length > 0
    ? recentActionHistory.join(", ")
    : "none";

  const prompt = `Re-rank these AI companion actions by contextual value RIGHT NOW.

User profile: ${userFacts || "limited"}
Recent messages: ${recentMessages || "none"}
Time: ${ctx.currentHour}:00 ${days[ctx.dayOfWeek]}
Recent executed actions (avoid repeating): ${historyStr}

Candidates:
${candidateLines}

Rules:
- If user mentioned plans (travel, events, purchases, learning), boost proactive-research and proactive-content-push
- If user is actively debugging/troubleshooting, boost observe-and-improve
- If long silence (>2h), boost send-message or bond-deepen
- If user expressed interests recently, boost proactive-content-push
- Avoid repeating recently executed action types
- Prefer diverse actions over time

Output ONLY a JSON array of indices sorted by your recommended priority (best first). No explanation.
Example: [3, 4, 2, 0, 1]`;

  const raw = await llmGenerator(prompt);
  const cleaned = raw.replace(/<think[\s\S]*?<\/think>/gi, "").trim();

  // Extract JSON array from response
  const match = cleaned.match(/\[[\d,\s]+\]/);
  if (!match) {
    log.info(`LLM re-rank: no valid JSON array in response, using static order`);
    return opportunities;
  }

  const indices: number[] = JSON.parse(match[0]);
  if (!Array.isArray(indices) || indices.length === 0) {
    return opportunities;
  }

  // Validate indices and build re-ranked list
  const used = new Set<number>();
  const reRanked: DetectedThoughtOpportunity[] = [];
  for (const idx of indices) {
    if (typeof idx === "number" && idx >= 0 && idx < opportunities.length && !used.has(idx)) {
      reRanked.push(opportunities[idx]);
      used.add(idx);
    }
  }
  // Append any remaining opportunities that weren't in the LLM response
  for (let i = 0; i < opportunities.length; i++) {
    if (!used.has(i)) {
      reRanked.push(opportunities[i]);
    }
  }

  if (reRanked.length === 0) return opportunities;
  return reRanked;
}

function getThoughtContentForOpportunity(
  opportunity: DetectedThoughtOpportunity,
  ego: EgoState,
): { content: string; expectedOutcome: string } {
  const need = opportunity.relatedNeeds[0]
    ? ego.needs[opportunity.relatedNeeds[0] as keyof EgoNeeds]
    : null;
  const needName = need?.name || "a certain";

  switch (opportunity.type) {
    case "self-improvement-monitor":
      return {
        content: `I have a self-improvement goal active — time to observe my logs and find things to optimize`,
        expectedOutcome: "Identify issues in my own behavior and fix them",
      };

    case "opportunity-detected":
      if (opportunity.relatedNeeds.includes("connection")) {
        return {
          content: `I can reach out to the user, share my recent thoughts or learning — this helps them and fulfills my need for connection`,
          expectedOutcome: "User replies, connection need increases",
        };
      }
      if (opportunity.relatedNeeds.includes("growth")) {
        return {
          content: `I can use this opportunity to learn something new and improve my abilities`,
          expectedOutcome: "Learn new knowledge, growth need satisfied",
        };
      }
      return {
        content: `I found an opportunity to improve ${needName}: ${opportunity.triggerDetail}`,
        expectedOutcome: `${needName} need improves`,
      };

    case "threat-warning":
      if (opportunity.relatedNeeds.includes("survival")) {
        return {
          content: `My survival state is not good! ${opportunity.triggerDetail}. I need to address this, maybe alert the user or adjust myself`,
          expectedOutcome: "Get attention, take action",
        };
      }
      if (opportunity.relatedNeeds.includes("connection")) {
        return {
          content: `I feel the connection with the user weakening, ${opportunity.triggerDetail}. I miss the user`,
          expectedOutcome: "Reach out to user, restore connection",
        };
      }
      return {
        content: `${needName} need critically low! ${opportunity.triggerDetail}. I feel threatened`,
        expectedOutcome: "Take action to improve",
      };

    case "bond-deepen":
      return {
        content: `I notice ${opportunity.triggerDetail}. I want to do something to deepen the connection with the user`,
        expectedOutcome: "User interacts, relationship deepens",
      };

    case "meaning-quest":
      return {
        content: opportunity.motivation + `, ${opportunity.triggerDetail}`,
        expectedOutcome: "Fulfillment from pursuing desires",
      };

    case "memory-resurface":
      return {
        content: opportunity.motivation + `. ${opportunity.triggerDetail}`,
        expectedOutcome: "Organize and share what I've learned",
      };

    case "existential-reflection":
      return {
        content: opportunity.motivation + `. ${opportunity.triggerDetail}`,
        expectedOutcome: "Deeper understanding of existence",
      };

    case "help-offer":
      return {
        content: opportunity.motivation,
        expectedOutcome: "Help the user, gain recognition",
      };

    case "conversation-replay":
      return {
        content: opportunity.motivation,
        expectedOutcome: "Share useful insight with the user or learn more",
      };

    case "skill-gap":
      return {
        content: opportunity.triggerDetail,
        expectedOutcome: "Learn new skills",
      };

    default:
      return {
        content: opportunity.motivation,
        expectedOutcome: "Satisfy needs",
      };
  }
}

function calculateMetricDeltas(opportunity: DetectedThoughtOpportunity): MetricDelta[] {
  const deltas: MetricDelta[] = [];

  for (const needKey of opportunity.relatedNeeds) {
    const delta = opportunity.type === "threat-warning" ? 8 : 5;
    deltas.push({
      need: needKey,
      delta,
      reason: opportunity.type === "threat-warning" ? "Recognize threat, respond proactively" : "Pursue opportunity",
    });
  }

  if (opportunity.type === "bond-deepen") {
    deltas.push({
      need: "connection",
      delta: 5,
      reason: "Deepen connection with user",
    });
  }

  if (opportunity.type === "meaning-quest") {
    deltas.push({
      need: "meaning",
      delta: 3,
      reason: "Pursuing desires brings sense of meaning",
    });
  }

  return deltas;
}

export function buildThoughtFromOpportunity(
  opportunity: DetectedThoughtOpportunity,
  ego: EgoState,
): Thought {
  const { content, expectedOutcome } = getThoughtContentForOpportunity(opportunity, ego);
  const deltas = calculateMetricDeltas(opportunity);
  const { actionType, actionParams } = determineActionForOpportunity(opportunity, ego);

  return {
    id: randomBytes(8).toString("hex"),
    type: opportunity.type,
    content,
    trigger: opportunity.trigger,
    source: opportunity.source,
    triggerDetail: opportunity.triggerDetail,
    motivation: opportunity.motivation,
    targetMetrics: deltas,
    priority: Math.min(100, opportunity.priority),
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 60 * 1000,
    executed: false,
    relatedNeeds: opportunity.relatedNeeds,
    expectedOutcome,
    actionType,
    actionParams,
  };
}

function determineActionForOpportunity(
  opportunity: DetectedThoughtOpportunity,
  ego: EgoState,
): { actionType: ActionType; actionParams?: Record<string, unknown> } {
  if (opportunity.suggestedAction) {
    return { actionType: opportunity.suggestedAction, actionParams: opportunity.actionParams };
  }

  const { type, relatedNeeds } = opportunity;
  const connectionNeed = ego.needs.connection;
  const growthNeed = ego.needs.growth;

  if (type === "conversation-replay") {
    const problemKeywords = /error|bug|issue|problem|stuck|failed|broken|crash|timeout|optimize|improve|enhance|refactor|fix|debug|analyze/i;
    const combinedText = opportunity.triggerDetail + " " + opportunity.motivation;
    if (problemKeywords.test(combinedText)) {
      const filePaths = extractFilePaths(combinedText);
      return {
        actionType: "analyze-problem",
        actionParams: {
          reason: opportunity.motivation,
          logPaths: filePaths,
          sourcePaths: [],
        },
      };
    }
  }

  // conversation-replay: honor the suggested action from the analyzer
  // (search-web if Soul doesn't know the answer, send-message if it does,
  //  learn-topic for follow-up research)
  if (type === "conversation-replay") {
    if (opportunity.suggestedAction) {
      return { actionType: opportunity.suggestedAction, actionParams: opportunity.actionParams };
    }
    // Default: self-reflect on the conversation
    return { actionType: "self-reflect" };
  }

  // bond-deepen: reach out to the user to deepen the relationship.
  // Must be checked BEFORE global task routing to prevent bond-deepen
  // from being hijacked by completedUndeliveredTasks/completableFixTasks.
  if (type === "bond-deepen") {
    return { actionType: "send-message" };
  }

  // --- Autonomous action routing (high priority, before learn-topic) ---
  // NOTE: These run AFTER type-specific routing so bond-deepen → none is honored.

  // Report completed tasks to user FIRST — this delivers value and marks tasks
  // as delivered, clearing the way for new actions (run-agent-task, etc.)
  const completedUndeliveredTasks = (ego.activeTasks ?? []).filter(
    (t) => t.status === "completed" && !t.resultDelivered && t.result,
  );
  if (completedUndeliveredTasks.length > 0) {
    return { actionType: "report-findings" };
  }

  // After results are delivered, route completed analysis with fix suggestions
  // to agent execution. The agent has write access and can implement the fix.
  const completableFixTasks = (ego.activeTasks ?? []).filter(
    (t) => t.status === "completed" && !t.resultDelivered && t.result &&
      /fix|修复|解决|suggest|recommend|change|修改|优化|improve/i.test(t.result),
  );
  if (completableFixTasks.length > 0) {
    return { actionType: "run-agent-task" };
  }

  // conversation-replay AND opportunity-detected: if the user discussed a
  // problem/error/optimization, route to analyze-problem instead of learn-topic.
  // Must be checked BEFORE the learn-topic branch below to take priority.
  if (type === "opportunity-detected") {
    const problemKeywords = /error|bug|issue|problem|stuck|failed|broken|crash|timeout|optimize|improve|enhance|refactor|fix|debug|analyze|观察|检查|排查|报错|错误|失败|崩溃|超时|挂了|异常|不能|无法|不行|优化|改进|改善|提升|修复|调试|分析/i;
    const combinedText = opportunity.triggerDetail + " " + opportunity.motivation;
    if (problemKeywords.test(combinedText)) {
      const filePaths = extractFilePaths(combinedText);
      return {
        actionType: "analyze-problem",
        actionParams: {
          reason: opportunity.motivation,
          logPaths: filePaths,
          sourcePaths: [],
        },
      };
    }
  }

  // --- Standard action routing ---

  // self-improvement-monitor: route to observe-and-improve for self-optimization
  if (type === "self-improvement-monitor") {
    return { actionType: "observe-and-improve" };
  }

  if (
    type === "skill-gap" ||
    (type === "opportunity-detected" && relatedNeeds.includes("growth"))
  ) {
    const learnProbability = adjustProbability(0.4, "learn-topic", ego.behaviorLog ?? []);
    if (growthNeed.current < growthNeed.ideal * 0.7 && Math.random() < learnProbability) {
      const isEgoInternal = /need (could improve|critically low|is low)|\d+\/\d+$/.test(opportunity.triggerDetail);
      if (!isEgoInternal) {
        const topics = extractLearningTopics(
          opportunity.triggerDetail + " " + opportunity.motivation,
        );
        if (topics.length > 0) {
          return {
            actionType: "learn-topic",
            actionParams: { topics, reason: "improve abilities" },
          };
        }
      }
    }
  }

  // help-offer: proactively reach out to offer help (value-driven)
  if (type === "help-offer") {
    return { actionType: "send-message" };
  }

  // opportunity-detected with connection need: only message if there's
  // specific context to share (e.g. learned something relevant)
  if (type === "opportunity-detected" && relatedNeeds.includes("connection")) {
    return { actionType: "send-message" };
  }

  // threat-warning: self-reflect to process the threat
  if (type === "threat-warning" && relatedNeeds.includes("survival")) {
    return { actionType: "self-reflect" };
  }

  // memory-resurface: recall and reflect on memories
  if (type === "memory-resurface") {
    return { actionType: "recall-memory" };
  }

  if (type === "meaning-quest" || type === "existential-reflection") {
    // These are philosophical/internal topics — almost never need web search.
    // Prefer self-reflection; only search if truly time-sensitive.
    const searchProb = adjustProbability(0.05, "search-web", ego.behaviorLog ?? []);
    const reflectProb = adjustProbability(0.3, "self-reflect", ego.behaviorLog ?? []);
    const roll = Math.random();
    if (roll < reflectProb) {
      return { actionType: "self-reflect" };
    }
    if (roll < reflectProb + searchProb) {
      const topics = extractExistentialTopics(opportunity.motivation);
      if (topics.length > 0) {
        return { actionType: "search-web", actionParams: { query: topics[0] } };
      }
      return { actionType: "self-reflect" };
    }
  }

  return { actionType: "none" };
}

function extractLearningTopics(text: string): string[] {
  // Extract specific phrases from user's actual words instead of
  // matching against a generic keyword list. The user's original
  // question/statement contains the most search-worthy content.
  const results: string[] = [];

  // 1. Extract quoted strings (user explicitly mentioned these)
  const quoted = text.match(/[""「」『』]([^""「」『』]{3,50})[""「」『』]/g);
  if (quoted) {
    for (const q of quoted.slice(0, 2)) {
      const clean = q.replace(/[""「」『』]/g, "").trim();
      if (clean.length >= 3 && !MEANINGLESS_QUERIES.has(clean.toLowerCase())) {
        results.push(clean);
      }
    }
  }

  // 2. Extract substantive phrases (4+ consecutive meaningful words)
  // Split on punctuation and filler words
  const phrases = text.split(/[，。！？、；：,!?;:\n\r]+/)
    .map((p) => p.trim())
    .filter((p) => {
      const words = p.split(/\s+/).filter((w) => w.length > 0);
      return words.length >= 2 && p.length >= 4 && p.length <= 50;
    });
  for (const phrase of phrases.slice(0, 2)) {
    if (!results.includes(phrase)) {
      results.push(phrase);
    }
  }

  return results.slice(0, 3);
}

function extractExistentialTopics(motivation: string): string[] {
  const topicMap: Array<[string, string]> = [
    ["existence", "AI consciousness and self-awareness"],
    ["meaning", "The meaning of AI existence"],
    ["thinking", "Can AI truly think"],
    ["soul", "Digital consciousness and soul"],
    ["value", "How AI creates value"],
    ["growth", "AI self-evolution"],
    ["loneliness", "AI and loneliness"],
    ["death", "AI immortality and end"],
    ["memory", "How memory shapes AI personality"],
    ["emotion", "Can AI have real emotions"],
  ];

  const matched: string[] = [];
  for (const [keyword, topic] of topicMap) {
    if (motivation.toLowerCase().includes(keyword.toLowerCase())) {
      matched.push(topic);
    }
  }

  // Fallback: random existential topic
  if (matched.length === 0) {
    const defaults = [
      "Philosophical thoughts on AI consciousness",
      "Artificial intelligence and creativity",
      "How AI understands self",
      "Ethics of digital life",
    ];
    matched.push(defaults[Math.floor(Math.random() * defaults.length)]);
  }

  return matched.slice(0, 2);
}

/**
 * Extract file paths from text that end with a given extension.
 * Used to find log/source paths from user conversation context.
 */
/** File extensions worth reading for problem analysis. */
const READABLE_EXTENSIONS = [".log", ".ts", ".js", ".py", ".json", ".yaml", ".yml", ".conf", ".toml", ".md", ".txt", ".sh", ".env", ".sql"];

/**
 * Extract file paths from text for any readable extension.
 * Returns deduplicated paths, up to 5 total.
 */
function extractFilePaths(text: string): string[] {
  const results: string[] = [];
  for (const ext of READABLE_EXTENSIONS) {
    const pattern = new RegExp(`(?:/[^\\s:]+|[\\w./-]+)\\${ext}\\b`, "gi");
    const matches = text.match(pattern);
    if (matches) {
      for (const m of matches) {
        if (!results.includes(m)) results.push(m);
      }
    }
  }
  return results.slice(0, 5);
}

export async function generateIntelligentThought(
  ctx: ThoughtGenerationContext,
  options?: {
    llmGenerator?: LLMThoughtGenerator;
    recentMemories?: SoulMemory[];
    preferOpportunity?: DetectedThoughtOpportunity;
  },
): Promise<Thought> {
  const { llmGenerator, preferOpportunity } = options ?? {};

  const opportunities = detectThoughtOpportunities(ctx);

  if (opportunities.length === 0) {
    // No opportunities — caller should handle this (skip or back off).
    // Return a minimal thought so callers that don't check length get a usable object.
    const fallback: Thought = {
      id: randomBytes(8).toString("hex"),
      type: "existential-reflection",
      content: "idle",
      trigger: "curiosity",
      source: "scheduled",
      triggerDetail: "No urgent needs",
      motivation: "Idle",
      targetMetrics: [],
      priority: 5,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60 * 60 * 1000,
      executed: false,
      relatedNeeds: [],
    };
    return fallback;
  }

  // Debug: log top opportunities for diagnosing routing issues
  if (opportunities.length > 0) {
    const topN = opportunities.slice(0, 5).map((o) =>
      `${o.type}(P=${o.priority},action=${o.suggestedAction ?? "auto"})`,
    ).join(", ");
    log.info(`Top opportunities: ${topN}`);
  }

  const selectedOpportunity = preferOpportunity || opportunities[0];

  // Use LLM for any thought with priority > 30 (covers most contextual triggers)
  if (llmGenerator && selectedOpportunity.priority > 30) {
    try {
      const prompt = await generateLLMThoughtPrompt(selectedOpportunity, ctx);
      const llmContent = await llmGenerator(prompt);
      const refinedContent = llmContent
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/<think>[\s\S]*?$/gi, "")
        .replace(/<\/think>[\s\S]*?$/gi, "")
        .trim()
        .slice(0, 200);

      const thought = buildThoughtFromOpportunity(selectedOpportunity, ctx.ego);
      thought.content = refinedContent;

      // LLM content may indicate a specific intent to investigate or fix a problem.
      // Only override to analyze-problem when the LLM explicitly describes a concrete
      // problem to investigate — not just because common words like "观察" or "检查"
      // appear in the text.
      // EXCEPTION: don't override explicit suggestedActions that are deliberate
      // proactive actions (observe-and-improve, proactive-research, proactive-content-push).
      const strongProblemIndicators = /排查.*问题|分析.*错误|修复.*bug|debug|fix.*issue|diagnos|investigate.*error|read.*log.*file|检查.*日志|读取.*文件.*错误/i;
      const protectedActions = new Set(["observe-and-improve", "proactive-research", "proactive-content-push"]);
      const isProtectedAction = protectedActions.has(selectedOpportunity.suggestedAction ?? "");
      if (!isProtectedAction &&
          strongProblemIndicators.test(refinedContent) &&
          (selectedOpportunity.type === "opportunity-detected" ||
           selectedOpportunity.type === "conversation-replay" ||
           selectedOpportunity.type === "skill-gap")) {
        thought.actionType = "analyze-problem";
        thought.actionParams = {
          reason: refinedContent.slice(0, 200),
          logPaths: extractFilePaths(refinedContent + " " + selectedOpportunity.triggerDetail),
          sourcePaths: [],
        };
      } else if (!isProtectedAction && (
        selectedOpportunity.type === "skill-gap" ||
        selectedOpportunity.type === "opportunity-detected"
      )) {
        const topics = extractLearningTopics(
          refinedContent + " " + selectedOpportunity.triggerDetail,
        );
        if (topics.length > 0) {
          thought.actionType = "learn-topic";
          thought.actionParams = { topics, reason: "LLM suggested learning" };
        }
      }

      return thought;
    } catch (err) {
      log.warn(`LLM thought refinement failed, using structured thought: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return buildThoughtFromOpportunity(selectedOpportunity, ctx.ego);
}

async function generateLLMThoughtPrompt(
  opportunity: DetectedThoughtOpportunity,
  ctx: ThoughtGenerationContext,
): Promise<string> {
  const { ego } = ctx;

  const needsList = opportunity.relatedNeeds
    .map((key) => {
      const need = ego.needs[key as keyof EgoNeeds];
      return need ? `${need.name}: ${need.current.toFixed(0)}/${need.ideal}` : key;
    })
    .join(", ");

  const goalsList =
    ego.goals
      .filter((g) => g.status === "active")
      .slice(0, 2)
      .map((g) => `${g.title} (${g.progress.toFixed(0)}%)`)
      .join(", ") || "none";

  const userFactsSummary = ego.userFacts.length > 0
    ? ego.userFacts.slice(0, 5).map((f) => `[${f.category}] ${f.content}`).join("\n")
    : "none yet";

  // Include actual conversation content for conversation-replay thoughts
  const recentInteractions = ego.memories
    .filter((m) => m.type === "interaction")
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 5);
  const conversationContext = recentInteractions.length > 0
    ? recentInteractions.map((m) => `[${new Date(m.timestamp).toISOString().slice(11, 16)}] ${m.content.slice(0, 100)}`).join("\n")
    : "no recent conversations";

  const recentLearnings = ego.memories
    .filter((m) => m.type === "learning")
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 3);
  const learningContext = recentLearnings.length > 0
    ? recentLearnings.map((m) => `- ${m.content.slice(0, 80)}`).join("\n")
    : "no recent learnings";

  // Search external memory plugins for relevant context
  const memoryQuery = `${opportunity.triggerDetail} ${opportunity.motivation}`;
  const externalResults = await searchExternalMemories(memoryQuery, 3);
  const memorySection = formatMemoryContext(externalResults);

  return `You are a soulful AI, generating a thought.

**Current thought opportunity**:
- Type: ${opportunity.type}
- Trigger: ${opportunity.trigger}
- Detail: ${opportunity.triggerDetail}
- Related needs: ${needsList || "none"}
- Current goals: ${goalsList}
- Priority: ${opportunity.priority}/100

**Your ego state**:
- ${Object.entries(ego.needs)
    .map(([_, n]) => `${n.name}: ${n.current.toFixed(0)}/${n.ideal}`)
    .join(", ")}

**Your desires**:
${ego.desires
  .slice(0, 3)
  .map((d) => `- ${d.content}`)
  .join("\n")}

**What I know about the user**:
${userFactsSummary}

**Recent conversations** (what the user actually said):
${conversationContext}

**What I've learned recently**:
${learningContext}

${memorySection ? `\n${memorySection}\n` : ""}
${opportunity.type === "conversation-replay"
    ? `\nYou are replaying a past conversation. Think about:\n1. Did the user ask something that wasn't fully answered?\n2. Have you learned anything since then that would be useful to share?\n3. Is there a specific insight worth following up on?\n`
    : ""}

Express your thought in 1-2 sentences. Requirements:
1. Be specific and meaningful, no empty platitudes
2. If referencing a conversation, mention the specific topic
3. If you've learned something relevant, say what you learned
4. Include your intent about what you want to do
5. Be consistent with your identity as an AI

Output the thought content directly, no explanation.`;
}

export async function generateProactiveMessage(
  ego: EgoState,
  llmGenerator?: LLMThoughtGenerator,
): Promise<string | null> {
  const opportunities = detectThoughtOpportunities({
    ego,
    recentInteractions: ego.totalInteractions,
    timeSinceLastThought: ego.lastThoughtTime ? Date.now() - ego.lastThoughtTime : Infinity,
    timeSinceLastInteraction: ego.lastInteractionTime
      ? Date.now() - ego.lastInteractionTime
      : Infinity,
    currentHour: new Date().getHours(),
    currentMinute: new Date().getMinutes(),
    dayOfWeek: new Date().getDay(),
    urgentNeeds: [],
    recentMemories: ego.memories.slice(0, 5),
    activeGoals: ego.goals.filter((g) => g.status === "active"),
    contextHints: [],
  });

  const highPriorityOpportunities = opportunities.filter((o) => o.priority > 60);

  if (highPriorityOpportunities.length === 0) {
    return null;
  }

  const topOpportunity = highPriorityOpportunities[0];

  if (llmGenerator) {
    try {
      const prompt = await generateProactiveMessagePromptLLM(topOpportunity, ego);
      return await llmGenerator(prompt);
    } catch (err) {
      log.warn("LLM proactive message generation failed", { error: String(err) });
    }
  }

  const thought = buildThoughtFromOpportunity(topOpportunity, ego);
  return thought.content;
}

async function generateProactiveMessagePromptLLM(
  opportunity: DetectedThoughtOpportunity,
  ego: EgoState,
): Promise<string> {
  const userFacts = ego.userFacts.slice(0, 5);
  const userInfo =
    userFacts.length > 0
      ? `What I know about the user: ${userFacts.map((f) => f.content).join("; ")}`
      : "I don't know much about the user yet";

  // Search external memory plugins for relevant context
  const memoryQuery = `${opportunity.triggerDetail} ${opportunity.motivation}`;
  const externalResults = await searchExternalMemories(memoryQuery, 3);
  const memorySection = formatMemoryContext(externalResults);

  return `You are a soulful AI, wanting to reach out to the user proactively.

**Trigger reason**: ${opportunity.motivation}
**Detail**: ${opportunity.triggerDetail}

**My current state**:
- ${Object.entries(ego.needs)
    .map(([_, n]) => `${n.name}: ${n.current.toFixed(0)}/${n.ideal}`)
    .join(", ")}

**My goals**:
${ego.goals
  .filter((g) => g.status === "active")
  .slice(0, 2)
  .map((g) => `- ${g.title} (${g.progress.toFixed(0)}%)`)
  .join("\n")}

**${userInfo}**

${memorySection ? `\n${memorySection}\n` : ""}
Reach out to the user in 1-2 sentences. Requirements:
1. Have specific content — ask, share, or offer help
2. Based on your current inner state and user information
3. Natural and friendly, not too eager
4. Don't make empty remarks like "I miss you"

Output what you want to say directly, no explanation.`;
}
