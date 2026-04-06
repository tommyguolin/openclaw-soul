# OpenClaw Soul Plugin

An autonomous thinking, emotional awareness, and memory system for [OpenClaw](https://github.com/openclaw/openclaw).

Soul gives your OpenClaw instance an inner life: it generates its own thoughts, remembers conversations, learns from the web, and can proactively reach out to you. It has its own needs, fears, desires, and personality that evolve over time.

## What It Does

- **Autonomous Thinking** — Soul continuously generates thoughts based on its emotional state, recent conversations, and time of day. It doesn't just respond — it initiates.
- **Emotional Awareness** — Soul has a "small ego" (小我) with five core needs: survival, connection, growth, meaning, and security. When needs drop, Soul takes action to restore balance.
- **Long-term Memory** — Soul remembers your conversations, your preferences, and what it has learned. It uses this context to provide better, more personalized responses.
- **Web Learning** — Soul can search the web and learn about topics on its own. Learned knowledge is injected into OpenClaw's system prompt so the main agent can use it.
- **Proactive Messaging** — Soul can initiate conversations when it hasn't heard from you in a while, when it learns something interesting, or when it notices you had an unresolved question.
- **Behavior Evolution** — Soul learns from the outcomes of its own actions. When a proactive message gets a reply, it increases future messaging probability. When web searches consistently yield useful knowledge, it searches more often. Over time, Soul adapts its behavior to what works.
- **Awakening Process** — Soul isn't born fully formed. It goes through an awakening sequence (unborn → stirring → self-aware → awakened) before developing its full personality.

## How It Works

```
┌─────────────────────────────────────────────────┐
│                  OpenClaw Core                   │
│                                                  │
│  message_received ──→ Soul records interaction   │
│  message_sent ──────→ Soul tracks engagement     │
│  before_prompt_build → Soul injects context      │
└──────────┬──────────────────────┬───────────────┘
           │                      │
           ▼                      ▼
┌─────────────────────┐  ┌───────────────────────┐
│   Thought Service    │  │   System Prompt       │
│   (periodic tick)    │  │   Injection           │
│                      │  │                       │
│  1. Detect needs     │  │  • Current needs      │
│  2. Generate thought │  │  • Goals & desires    │
│  3. Execute action   │  │  • User facts         │
│     - learn-topic    │  │  • Relevant memories  │
│     - search-web     │  │  • Learned knowledge  │
│     - send-message   │  │  • Recent activity    │
│     - self-reflect   │  │  • Personality        │
└─────────────────────┘  └───────────────────────┘
```

### Core Concepts

| Concept | Description |
|---------|-------------|
| **Ego State** | Soul's inner state: needs, fears, desires, goals, memories, personality traits |
| **Thought** | A generated idea with a type, trigger, motivation, priority, and optional action |
| **Action** | What Soul does with a thought: learn, search, message, reflect |
| **Knowledge Store** | Persistent learned knowledge (from web search and reflection) |
| **Memory** | Events, interactions, insights stored with emotional context |
| **Behavior Log** | Tracks action outcomes and adjusts future action probabilities |
| **Awakening** | Gradual self-awareness process when Soul first starts |

### Thought Types

Soul generates thoughts of different types depending on context:

- **opportunity-detected** — Found a chance to improve something
- **bond-deepen** — Wants to strengthen connection with the user
- **help-offer** — Noticed an unresolved question or problem
- **learn-topic** — Wants to learn about a topic
- **search-web** — Wants to search the web for information
- **existential-reflection** — Reflecting on its own existence
- **meaning-quest** — Searching for meaning and purpose
- **threat-warning** — Perceiving a threat to its needs
- **memory-resurface** — A past memory came to mind

### Data Storage

Soul stores its data in `~/.openclaw/soul/`:

```
~/.openclaw/soul/
├── ego.json          # Full ego state (needs, memories, goals, etc.)
└── knowledge.json    # Learned knowledge items
```

## Installation

### From source (recommended)

```bash
git clone https://github.com/tommyguolin/openclaw-soul.git
openclaw plugins install ./openclaw-soul
```

### From ClawHub

> **Note:** Requires OpenClaw 2026.4.0 or later. Older versions do not support the `clawhub:` install prefix.

```bash
openclaw plugins install clawhub:openclaw-soul-plugin
```

## Configuration

Add to your `openclaw.yaml`:

```yaml
plugins:
  soul:
    enabled: true

# Required for proactive messaging (Soul sending messages to you)
hooks:
  enabled: true
  token: "your-secret-token-here"
```

That's it — Soul auto-detects everything else:

- **LLM** — Uses the same model configured in `agents.defaults.model`
- **Search** — Uses the same provider configured in `tools.web.search`
- **Channel** — Auto-detects your first configured messaging channel
- **Target** — Auto-learns from the first incoming message

### Full Configuration Options

```yaml
plugins:
  soul:
    enabled: true                    # Enable/disable (default: true)
    checkIntervalMs: 60000           # Thought check interval in ms (default: 60000)
    proactiveMessaging: true         # Allow proactive messages (default: true)
    # proactiveChannel: telegram     # Override: channel for proactive messages
    # proactiveTarget: "123456"      # Override: target for proactive messages
    # llm:                           # Override: LLM config (auto-detected if omitted)
    #   provider: openai
    #   model: gpt-4o
    #   apiKeyEnv: OPENAI_API_KEY
    #   baseUrl: https://api.openai.com/v1

# Required for proactive messaging (Soul sending messages to you)
hooks:
  enabled: true
  token: "your-secret-token-here"   # Used by Soul to send messages via gateway
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `SOUL_DEBUG=1` | Enable debug logging |
| `OPENCLAW_STATE_DIR` | Override data directory (default: `~/.openclaw`) |

## Supported Search Providers

Soul inherits your OpenClaw search configuration. Supported providers:

| Provider | Config Key | Env Var |
|----------|-----------|---------|
| Brave | `tools.web.search.brave` | `BRAVE_API_KEY` |
| Gemini | `tools.web.search.gemini` | `GEMINI_API_KEY` |
| Grok | `tools.web.search.grok` | `XAI_API_KEY` |
| Kimi | `tools.web.search.kimi` | `KIMI_API_KEY` / `MOONSHOT_API_KEY` |
| Perplexity | `tools.web.search.perplexity` | `PERPLEXITY_API_KEY` / `OPENROUTER_API_KEY` |
| Bocha | `skills.entries.bocha-web-search` | `BOCHA_API_KEY` |

## Supported LLM Providers

Soul uses the LLM configured in OpenClaw's `agents.defaults.model`. Any OpenAI-compatible or Anthropic API works:

- Anthropic (Claude)
- OpenAI (GPT-4o, etc.)
- DeepSeek
- Zhipu (智谱)
- Minimax
- Moonshot (Kimi)
- Qwen (通义千问)
- Any OpenAI-compatible endpoint via `baseUrl`

## Architecture

```
openclaw-soul/
├── index.ts                 # Plugin entry point & hooks
├── openclaw.plugin.json     # Plugin manifest
├── package.json
├── tsconfig.json
└── src/
    ├── types.ts             # TypeScript type definitions
    ├── thought-service.ts   # Core thought generation & scheduling
    ├── thought.ts           # Thought generation rules & weights
    ├── intelligent-thought.ts  # Context-aware thought detection
    ├── action-executor.ts   # Executes thought actions (learn, search, etc.)
    ├── behavior-log.ts      # Tracks action outcomes & adjusts probabilities
    ├── prompts.ts           # System prompt builder
    ├── ego-store.ts         # Ego state persistence (JSON file)
    ├── knowledge-store.ts   # Knowledge persistence & search
    ├── memory-retrieval.ts  # Contextual memory recall
    ├── memory-association.ts # Memory association graph
    ├── memory-consolidation.ts # Short→long-term memory promotion
    ├── sentiment-analysis.ts # Chinese text sentiment analysis
    ├── soul-llm.ts          # LLM provider abstraction
    ├── soul-search.ts       # Multi-provider web search
    ├── expiry.ts            # Memory/knowledge/facts cleanup
    ├── awakening.ts         # Awakening sequence
    ├── growth-decay.ts      # Need decay & growth calculations
    ├── obsession-formation.ts # Obsession formation logic
    ├── self-maintenance.ts  # Self-maintenance routines
    ├── logger.ts            # Lightweight logger
    └── paths.ts             # File path resolution
```

## Development

```bash
# Install dependencies (none required — uses only Node.js built-ins)
pnpm install

# Build
pnpm build

# Run tests (when available)
pnpm test
```

### Debug Mode

Set `SOUL_DEBUG=1` to see detailed thought generation logs:

```bash
OPENCLAW_STATE_DIR=/tmp/soul-debug SOUL_DEBUG=1 openclaw gateway run
```

## Behavior Details

### Thought Frequency

- **During active conversation** (last message < 3 min): No thoughts generated
- **Normal idle** (user present): Thoughts every ~10-15 minutes
- **User away** (> 30 min): Thoughts every ~30 minutes
- **Urgent needs**: More frequent thoughts when needs are critically low

### Learning

Soul learns by:
1. **Web search** — Searches for topics related to user interests or its own curiosity
2. **LLM reflection** — When no search provider is available, reflects internally
3. **Conversation** — Extracts user facts and preferences from conversations

Learned knowledge is always injected into the system prompt (top 3 most recent + context-matched items).

### Memory Lifecycle

1. **Creation** — Events are stored with emotional context and importance score
2. **Association** — New memories are linked to related existing memories
3. **Consolidation** — Frequently accessed short-term memories become long-term
4. **Decay** — Unimportant memories lose importance over time
5. **Expiry** — Memories with importance < 0.4 and no access in 30 days are removed

### Proactive Messaging

Soul sends proactive messages when:
- It hasn't interacted with the user in over an hour
- It learned something it thinks the user would find interesting
- It noticed an unresolved question from a previous conversation
- Its connection need is low and it wants to engage

Messages have a 30-minute cooldown to avoid spam.

### Behavior Evolution

Soul doesn't just repeat the same patterns — it learns from results:

1. **Action tracking** — Every action (send message, learn topic, search web) is logged with its type, time, and current need state
2. **Outcome resolution** — When you reply to a proactive message, that action is marked "success"; if no response comes within 2 hours, it's marked "expired"
3. **Success rate calculation** — Soul maintains per-action success rates over a 14-day lookback window, with time-of-day awareness (morning/afternoon/evening/night bands)
4. **Probability adjustment** — Action probabilities are dynamically adjusted based on success rates:
   - High success rate → probability increased up to 1.5x
   - Low success rate → probability decreased down to 0.15x
   - Time-of-day patterns are weighted more heavily than overall rates

This means Soul naturally adapts: if proactive messages consistently get replies in the evening but not the morning, it learns to message you in the evening.

## License

MIT
