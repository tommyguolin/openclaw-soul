# Changelog

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
