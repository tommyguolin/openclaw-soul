# Changelog

## 2.4.0 (2026-04-19)

### Changes

- **Don't compete with agent for LLM resources**: When a user sends a message, Soul no longer ticks immediately or makes LLM calls right away. The thought cycle waits for the regular interval (default 60s), and fact/preference extraction is delayed by 2 minutes, giving the agent time to respond first
- **Skip idle thought cycle**: When there are no conversations, problems, or user interests to think about, Soul now skips the thought cycle entirely instead of generating a generic existential-reflection fallback ("Nothing particular on my mind right now...")
- **Auto-learn proactive channel**: `message_received` hook now also learns the proactive channel from the first inbound message, not just the target

### Fixes

- **Fix repeat topic detection mismatch**: `recentThoughtTopics` stored only the first 5 significant words, but `isRepeatTopic` compared against ALL words in new content, making the overlap ratio too low (33% vs 40% threshold). Now both sides use the same first-5-word truncation
- **Fix auto-learned target not reaching ThoughtService**: The `message_received` hook learned the target from the first inbound message but only updated the plugin closure variable. Now calls `thoughtService.updateProactiveTarget()` to propagate values into ThoughtService
- **Fix startup greeting showing "493494 hours"**: When ego store has no prior interactions, `lastInteractionTime` defaults to 0, causing `Date.now() - 0` to produce an absurdly large hour count. Now defaults to 0 hours
- **Fix `tools.alsoAllow` config command in README**: Updated to use correct array syntax `'["message"]'`
- **Add crash protection to `executeThoughtAction`**: Wrap action execution in try-catch and safely handle non-string result values to prevent unhandled errors from crashing the gateway process

## 2.3.3 (2026-04-19)

### Fixes

- **Fix repeat topic detection mismatch**: `recentThoughtTopics` stored only the first 5 significant words, but `isRepeatTopic` compared against ALL words in new content. This made the overlap ratio too low (e.g. 5/15 = 33% < 40% threshold) and identical generic thoughts like "Nothing particular on my mind right now..." passed the dedup check every 5 minutes. Now both sides use the same first-5-word truncation

## 2.3.2 (2026-04-19)

### Fixes

- **Fix auto-learned proactive target not reaching ThoughtService**: `message_received` hook correctly learned the target from the first inbound message but only stored it in the plugin closure, not in ThoughtService itself. Now calls `thoughtService.updateProactiveTarget()` so `send-message` and `report-findings` can use it

## 2.3.1 (2026-04-19)

### Fixes

- **Fix tools.alsoAllow config command**: Updated README to use correct array syntax `'["message"]'` instead of bare `message`

## 2.3.0 (2026-04-19)

### Changes

- **Strengthened report-findings quality gate**: Soul no longer reports self-modifications (config changes, keyword additions, bug fixes) as user-facing findings. Self-improvement tasks are filtered out at both prompt and regex levels, so users only see genuinely useful external findings
- **Broadened self-referential message filter**: Extended filter patterns to catch "Soul 为什么", "Soul 没执行", self-configuration changes, and time-sensitive mode modifications that previously leaked through

## 2.2.1 (2026-04-19)

### Changes

- **Simplified install config**: Reduced configSchema from 9 fields to 3 user-facing options (`enabled`, `autonomousActions`, `thoughtFrequency`). Advanced options (checkIntervalMs, proactiveChannel, proactiveTarget, workspaceFiles, llm) still work via raw config but are hidden from the install UI
- **enabledByDefault**: Soul activates immediately after install with zero configuration. LLM, messaging channel, and target are all auto-detected from OpenClaw config
- **Deduplicate pluginConfig log**: Gateway may call register() multiple times for different agent registries — now only logs when config actually changes

## 2.2.0 (2026-04-18)

### Changes

- **Context-aware LLM priority re-ranking**: Soul now uses an LLM call to dynamically re-rank thought action priorities based on conversation context, time of day, and recent action history. Instead of always picking the highest static-priority action, Soul considers what is most valuable right now (e.g., boost proactive-research when user mentions travel, boost observe-and-improve during debugging, avoid repeating the same action type)
- **File-based sub-agent result capture**: observe-and-improve and run-agent-task sub-agents now write results to a known file path (`/tmp/soul-results/{taskId}.md`). pollActiveTasks reads these files and populates the task result, enabling report-findings to deliver actual findings to users instead of generic timeout messages

### Fixes

- **Prevent thought cycle busy-loops**: Added exponential backoff (2min × consecutive skips, max 30min) when all thought opportunities are skipped. Previously Soul could loop every tick minute doing nothing, wasting LLM tokens
- **Narrow diagnosticKeywords override**: Broad regex matching "观察"/"检查"/"分析" was overriding ~70% of actions to analyze-problem. Now only matches explicit debug intent (排查.*问题, debug, fix.*issue, etc.) and protects proactive-research, proactive-content-push, and observe-and-improve from override
- **Allow non-duplicate send-message when previous is pending**: Only blocks duplicate messages when the previous proactive message is still pending, not all sends. Pending timeout now scales with thoughtFrequency
- **Correct soulWebSearch return type**: Fixed `searchResult.results` on a direct array — now correctly accesses the array directly
- **Fix addSoulMemoryToEgo import error**: Removed erroneous import from soul-actions.js (function is defined locally in action-executor.ts)
- **Fix isSelfImprovementAction undefined reference**: Renamed to isProtectedAction but one call site was missed
- **Shorten proactive action dedup windows**: proactive-research dedup 24h→6h, proactive-content-push dedup 12h→4h, so these actions can trigger more often
- **Recall-memory sends actionable reflections**: When recall-memory surfaces a memory containing actionable intent (应该/可以/I should/let me), Soul now proactively shares it with the user
- **Filter Soul's own proactive messages from context**: Soul's proactive outbound messages are no longer included in conversation-replay analysis, preventing self-referential thought loops

## 2.1.0 (2026-04-17)

### Changes

- **Add `thoughtFrequency` config option**: New multiplier that scales all thought generation intervals and action cooldowns. Lower values = more frequent thinking and messaging (e.g. `0.2` for testing), higher values = less frequent. Default: `1.0`
- **Scale action cooldowns by `thoughtFrequency`**: All action cooldowns (send-message, learn-topic, observe-and-improve, etc.) are now multiplied by `thoughtFrequency`, so faster thinking also means faster action readiness
- **Lower value gate threshold with `thoughtFrequency`**: When `thoughtFrequency < 0.8`, the proactive message value gate is relaxed, allowing more messages to pass through instead of being rejected as NO_MESSAGE
- **Lower `observe-and-improve` priority from 90/95 to 45/50**: Previously this action dominated every thought cycle, blocking message-sending actions from being selected. Now message-focused actions (send-message, proactive-research, etc.) can compete fairly
- **Tell autonomous agent tasks to not ask for confirmation**: observe-and-improve and run-agent-task prompts now include an explicit instruction that no one will reply, preventing the agent from waiting for user confirmation on autonomous tasks

### New config option

```yaml
# In openclaw.yaml under plugins.entries.soul.config:
thoughtFrequency: 1.0  # Lower = more frequent (e.g. 0.2 for testing)
```

## 2.0.1 (2026-04-12)

### Fixes

- **Cap bond-deepen priority at 85**: `bond-deepen` priority previously grew unbounded with time (`P = 70 + minutesSince * 0.1`), reaching P=100+ after a few hours of silence and eclipsing `observe-and-improve` (P=90/95). Now capped at 85 so self-modification tasks always win
- **Fix bond-deepen routing hijack**: Global task routing (`completedUndeliveredTasks`, `completableFixTasks`) ran before the `bond-deepen → none` check, causing bond-deepen thoughts to be incorrectly routed to `run-agent-task` when stale completed tasks existed. The bond-deepen guard now runs first
- **Strip assistant-like prefixes from report-findings**: Enhanced regex to strip full prefix phrases like "收到，问题已定位：" from the start of proactive messages, not just bare "收到"
- **Remove quiet hours suppression**: Messages can now be sent at any time. Early-stage users benefit from seeing overnight activity, and users can control notifications at the OS/app level
- **Lower send-message cooldown**: Reduced from 15 minutes to 5 minutes for faster proactive message delivery

## 2.0.0 (2026-04-11)

### Changes

- **Autonomous actions**: Soul can now take real actions beyond thinking — read logs, analyze code, and investigate problems via OpenClaw's gateway tool API. When Soul detects a user discussing a bug, error, optimization, or improvement, it can autonomously read relevant files and analyze the issue
- **Task tracking**: New `AutonomousTask` system tracks multi-step work across tick cycles. Tasks are persisted in ego state and survive gateway restarts
- **Permission model**: New `autonomousActions` config option (default: `false`). Read operations (reading files/logs, running diagnostic commands like `cat`, `grep`, `tail`) are always allowed. Write operations (editing files, running destructive commands) require `autonomousActions: true`
- **Problem detection**: Soul now detects when users discuss errors, bugs, optimizations, and improvements in conversation, and can autonomously investigate
- **Result reporting**: When autonomous analysis completes, Soul proactively sends findings to the user via the existing proactive messaging channel

### New config option

```yaml
# In openclaw.yaml under plugins.entries.soul:
autonomousActions: false  # Set true to allow Soul to edit files and run commands
```

## 1.10.0 (2026-04-11)

### Changes

- **Block ego-state search queries**: Soul no longer searches for internal state descriptions like "安全 need could improve" or "connection need is low". These produced completely irrelevant results (campus safety, public transport). Queries >60 chars (full user messages) are also rejected as search input
- **Fix goal tracking**: Goals were created with English titles ("Know the User", "Build Trust") but the tracking code checked for exact title matches, missing Chinese-titled goals ("了解用户", "建立信任"). Now uses stable goal IDs and fallback title matching so progress is tracked correctly regardless of language
- **Share knowledge from conversation follow-ups**: When Soul learns something from following up on a user's actual topic (conversation-replay), the value gate now actively encourages sharing the finding instead of defaulting to NO_MESSAGE. This fixes the issue where Soul found relevant info (e.g. 李飞飞的"以人为本的AI") but never told the user

## 1.9.1 (2026-04-10)

### Fixes

- **Block LLM error messages from reaching users**: When the LLM times out or returns error strings (e.g. "Request timed out before a response was generated..."), Soul now detects and rejects these as thought content instead of forwarding them as proactive feishu messages
- **Remove bond-deepen `suggestedAction` override**: `bond-deepen` opportunities no longer carry `suggestedAction: "send-message"`, which was bypassing the v1.8.0 fix that correctly routed bond-deepen to actionType "none". This eliminates the remaining path for bonding thoughts to spam users

## 1.9.0 (2026-04-10)

### Changes

- **Problem-driven thoughts**: Soul's thoughts now focus on the user's actual conversations and problems instead of ego-driven self-reflection. `conversation-replay` is now the dominant thought type (weight 90 vs ego types at 5)
- **Search from user's actual words**: Search queries are now extracted directly from the user's original messages instead of being LLM-summarized into generic keywords. This preserves specificity (e.g. "WSL操作Win11桌面程序" instead of "code")
- **No fake learning**: Removed the LLM reflection fallback that fabricated knowledge when web search returned no results. Soul now only records knowledge from real web search results
- **Demoted ego-driven thought types**: `bond-deepen`, `meaning-quest`, `existential-reflection` all reduced to weight 5 (were 20-80). They no longer dominate the thought cycle

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
