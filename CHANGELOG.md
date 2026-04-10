# Changelog

## 1.8.1 (2026-04-10)

### Changes

- **Topic-level thought deduplication**: Soul now tracks the topics of recent thoughts (not just types) and skips thoughts that overlap >40% with a recent one. Prevents infinite loops where Soul keeps ruminating on the same subject (e.g. Win11 exploration)
- **Search query quality filter**: Generic single-word queries like "code", "ai", "app" are now rejected before wasting API calls. Only multi-word or specific single-word queries (>3 chars) trigger web search
- **LLM rate limiting**: Soul enforces a minimum 10-second gap between LLM calls to avoid overloading the provider (fixes MiniMax 529 overloaded errors)

## 1.8.0 (2026-04-10)

### Changes

- **Non-blocking message processing**: The `message_received` hook now runs LLM calls (fact/preference extraction) in the background instead of blocking the agent turn. This prevents feishu streaming card timeouts caused by serial LLM calls taking 60+ seconds
- **Token cost optimization**: Short messages (<15 chars, e.g. "收到", "好的") skip LLM extraction entirely — only rule-based sentiment analysis runs. Saves ~600 tokens per short message

### Fixes

- **Strengthened proactive message value gate**: Added explicit rejection rules for meta-messages about the bot itself (offering to help, debug, read logs, "I'm ready to..."). These are assistant behaviors, not proactive insights
- **Disabled bond-deepen → send-message routing**: `bond-deepen` thoughts no longer trigger proactive messages. This type fires after 10 min of silence and almost never produces genuinely valuable content to share

## 1.7.0 (2026-04-09)

### Changes

- **Adaptive thought frequency**: Thoughts are no longer generated at a fixed 5-minute interval. Soul now computes an engagement score based on interaction recency, frequency, and content substance, then adjusts thought intervals accordingly: 8-12 min for active substantive conversations, 25-40 min for casual/test messages, 20-45 min when user is away. Includes natural jitter to avoid mechanical patterns
- **Smart content filtering**: Soul now distinguishes genuine questions from test messages, exclamations, meta-remarks about the bot, and other non-searchable content. Messages like "测试成功" or "为啥你一直在说收到" are no longer treated as questions worth searching
- **Search query deduplication**: Soul tracks recent search queries in memory and skips duplicate or near-duplicate searches within a 6-hour window
- **Skip awakening ceremony**: New installations now start directly in the `awakened` state instead of going through the unborn → stirring → self-aware → awakened sequence. Existing installations stuck in awakening for over 30 minutes are auto-promoted to awakened
- **Reduced search-web priority**: Lowered search-web thought weight from 60/35 to 30/15, making it less dominant compared to more user-valuable actions like send-message and learn-topic
- **Tightened follow-up timing**: Simple conversation follow-up now waits 15 minutes (was 5) to avoid annoying responses to test messages

## 1.6.0 (2026-04-07)

### Changes

- **Replace child_process with fetch for proactive messaging**: Removed `execSync`/`child_process` dependency that triggered OpenClaw's security scanner ("dangerous code patterns detected"). Proactive messages are now sent via gateway's `/hooks/agent` HTTP endpoint, which requires `hooks.enabled: true` and `hooks.token` in `openclaw.yaml`
- **Rename package to `openclaw-soul-plugin`**: Package name now matches ClawHub plugin entry for consistent identification
- **Remove SKILL.md**: Removed incorrectly created SKILL.md file (soul is a plugin, not a skill)

## 1.5.0 (2026-04-07)

### Changes

- **Universal LLM access via gateway local API**: Soul now calls the gateway's `/v1/chat/completions` endpoint by default, which handles all provider auth/routing/OAuth transparently. Works in all environments (daemon mode, foreground, any deployment) without requiring API keys or env vars. Falls back to direct provider API if gateway is unavailable
- **Language detection and awareness**: Soul detects the user's language from messages (Chinese, English, Japanese, Korean) and stores it in ego state. All LLM prompts include language instructions so proactive messages match the user's language
- **Improved proactive message quality**: Enhanced LLM value gate with explicit criteria for what counts as valuable (specific insights, useful tips, answers to previous questions) vs. not valuable (just saying hi, generic encouragement, "I was thinking about..."). Both primary and fallback LLM attempts must agree before sending
- **Sentence-boundary truncation**: Proactive messages are now truncated at sentence boundaries instead of mid-sentence, supporting both English and Chinese punctuation
- **Meta-analysis stripping**: LLM output is cleaned of common meta-analysis prefixes ("Let me analyze...", "Based on my analysis...") that sometimes appear despite instructions
- **Time-of-day context in prompts**: Proactive message prompts now include time context (morning/afternoon/evening) so message tone matches the time
- **Stale pending behavior cleanup**: Behavior log entries stuck in "pending" state for over 10 minutes are automatically resolved to prevent deadlock (e.g. when gateway restarts or message_received hook doesn't fire)

### Fixes

- Fixed gateway returning `400 - Invalid model` error: gateway local API expects `model: "openclaw"` (not actual model name like "MiniMax-M2.5")
- Fixed proactive message deadlock where pending behavior entries blocked all future sends until manually resolved
- Fixed gateway port resolution: now checks env var, OpenClaw config, and default (18789) in priority order
- Fixed LLM `max_tokens` too low (300 → 1024) causing truncated thought generation

## 1.4.0 (2026-04-06)

### Changes

- **Conversation replay overhaul**: Soul now analyzes ALL conversations, a broader scope — not just questions/queriess): Soul replays past conversations, thinking about whether it resolved questions, if there's better approach (share), that) or if no relevant knowledge, learn more). Users's interests and projects, skills, challenges are and proactively search for solutions to share findings)
  - User profile built from facts + preferences + conversation history — user's interests/projects/skills/challenges drive `learn-topic` or `search-web` to find solutions and then share
  - Extended conversation replay analysis to 7 days (was just 24 hours) for smarter matching with conversation substance
  - Faster first proactive message: lowered thought trigger to 15 min, conversation-replay threshold to 15 min, lowered `shouldGenerateThought` threshold to 15 min for active conversation history
  - Improved interaction memory with extracted topic tags and 300 char content (up from 200)
  - Better LLM prompt with richer context:user profile, conversation history, knowledge gained, language detection, extended value assessment criteria (better solutions, relevant discoveries, user challenges, skills)
  - Increased message length limit to 300 chars

- Smart timing gate with quiet hours (23-08:00) and pending message queue for later
- Reduced generic template fallback threshold ( more generic phrases blocked)- **Conversation-driven thought system**: Soul now replays past conversations instead of generating generic thoughts. It recalls what the user said, checks if it has learned anything relevant since, and decides whether to follow up, search for more information, or share insights
- New `conversation-replay` thought type with highest priority when recent conversations exist. Detects unresolved questions, matches conversation topics with newly acquired knowledge, and generates follow-up opportunities
- **Smart timing for proactive messages**: Quiet hours (23:00-08:00) — messages are queued instead of sent. Pending messages are automatically flushed at the next good hour
- **Better interaction memory**: conversations now store up to 300 chars (was 200) with extracted topic tags (tech keywords in English and Chinese). Tags enable conversation-replay to match conversations with Soul's learned knowledge
- Improved LLM thought prompt: includes actual conversation content and recent learnings, so thoughts reference specific topics instead of abstract need states
- Deprioritizes generic need-gap and bond-deepen thoughts when conversation-replay has high-priority opportunities

## 1.3.2 (2026-04-05)

### Fixes

- Fixed proactive messaging never triggering: restored `bond-deepen` → `send-message` routing (was over-removed in v1.3.1). The LLM value gate still filters out generic "I miss you" messages, but now allows messages when Soul has learned something relevant to share

## 1.3.0 (2026-04-04)

### Changes

- **Proactive messaging redesign**: Soul now only sends messages when it has something valuable to share (learned something relevant, found answer to user's question). No more generic "I miss you" / "好久没聊" messages
- LLM-driven message generation: proactive messages are crafted by LLM using user facts, recent conversations, and acquired knowledge — no generic templates
- Value gate: if LLM determines there's nothing worth saying, the message is not sent (responds `NO_MESSAGE`)
- Removed dual send-path: proactive messaging now handled exclusively by `action-executor.ts` (removed competing path in `soul-actions.ts`)
- `bond-deepen` thoughts no longer trigger send-message — only value-carrying types (`help-offer`) should proactively message
- Per-type action cooldowns: learn-topic (15 min), search-web (10 min), self-reflect (5 min) instead of a single block
- Re-enabled `recall-memory` action for `memory-resurface` thoughts (was commented out)
- Added action routing for `help-offer` (→ send-message) and `threat-warning` (→ self-reflect)
- Boosted weights for user-valuable thought types: `learn-topic`, `search-web`, `help-offer`
- Relaxed action probability gates: learn-topic 30→40%, search-web 20→30%, self-reflect 10→15%
- 3-type rolling window dedup to prevent A-B-A thought cycling (was 1-type)
- Lowered send-message cooldown from 30 min to 15 min

### Fixes

- Fixed behavior entries created during cooldown (phantom entries) — cooldown now checked before entry creation
- Fixed all action types can now be marked "success" on user reply (was only send-message and learn-topic)
- Fixed neutral probability factor: insufficient data now returns base probability unchanged instead of halving it
- Fixed totalThoughts reporting: system prompt now clarifies it's a lifetime count (not "today")

## 1.2.0 (2026-04-04)

### Changes

- Goal persistence: `create-goal` action now saves goals to ego store instead of discarding them
- Chinese sentiment analysis: added Chinese word patterns for positive/negative/negators/intensifiers
- User preference extraction: wired up `extractUserPreferences` in message hooks (was dead code)

### Fixes

- Fixed intensifier proximity bug — "very helpful" now correctly detected (was missing space)
- Increased LLM `max_tokens` from 150 to 300 to prevent truncated thought generation
- Removed unused functions `generateEmotionalResponse` and `shouldTriggerThought`

## 1.1.0 (2026-04-01)

### Changes

- Behavior feedback loop: Soul now tracks action outcomes and adjusts future action probabilities based on success rates
- Time-of-day aware behavior: success rates are calculated per time band (morning/afternoon/evening/night) for more nuanced adaptation
- Goal progress tracking: goals like "了解用户" and "建立信任" now update based on user facts extracted and interaction history

### Fixes

- Fixed critical need decay bug where needs were permanently stuck at 100 — `decayMetrics` now returns correct delta values instead of absolute targets
- Fixed behavior log persistence: behavior entries are now properly saved and loaded from ego state

## 1.0.0 (2026-03-31)

Initial release.

### Changes

- Autonomous thought generation based on emotional state, conversation context, and time of day
- Five core emotional needs (survival, connection, growth, meaning, security) with decay and restoration
- Awakening sequence: unborn → stirring → self-aware → awakened
- Long-term memory with association graph, consolidation, and contextual recall
- Web learning via 6 search providers (Brave, Gemini, Grok, Kimi, Perplexity, Bocha)
- Knowledge store with search and injection into OpenClaw system prompt
- Proactive messaging with auto-detected channel and auto-learned target
- Conversation-driven thought prioritization (follow-ups, unresolved questions, user interests)
- Memory/knowledge/facts expiry and cleanup (30-minute cycle)
- Thought interruption via AbortController when user sends a message
- Chinese sentiment analysis for conversation text
- User fact and preference extraction via LLM
- Zero external dependencies — uses only Node.js built-in modules
