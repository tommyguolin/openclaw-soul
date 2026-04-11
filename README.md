# OpenClaw Soul Plugin

An autonomous thinking, emotional awareness, and memory system for [OpenClaw](https://github.com/openclaw/openclaw).

Soul gives your OpenClaw instance an inner life: it generates its own thoughts, remembers conversations, learns from the web, and can proactively reach out to you. It has its own needs, fears, desires, and personality that evolve over time.

## Core Features

### Autonomous Thought Generation

Soul doesn't just respond — it **thinks on its own**. A background thought service continuously generates thoughts based on:

- **Conversation context** — Replays past conversations to find unresolved questions, topics worth following up on, or insights to share
- **Emotional state** — Five core needs (survival, connection, growth, meaning, security) drive what Soul thinks about. When a need drops, Soul generates thoughts to restore balance
- **User interests** — Extracts topics from conversations and proactively learns about them

The thought frequency is **adaptive**, not mechanical:
- **Active conversation with substantive topics** → thoughts every 8-12 minutes
- **Casual / test messages with little substance** → thoughts every 25-40 minutes
- **User away for over an hour** → thoughts every 20-45 minutes
- **Never during active conversation** — thoughts are paused while you're chatting

Thought types include: `learn-topic`, `search-web`, `send-message`, `self-reflect`, `analyze-problem`, `invoke-tool`, `run-agent-task`, `report-findings`, and more. Soul picks the most relevant type based on context, not random selection.

### Proactive Messaging

Soul can **reach out to you first** when it has something genuinely valuable to share:

- Found an answer to a question you asked earlier
- Learned something relevant to your interests or projects
- Discovered a better solution to a problem you discussed

Every proactive message goes through a **value gate**:
1. LLM evaluates whether the content is genuinely worth sharing
2. Generic small talk ("just checking in", "I was thinking about...") is filtered out
3. Only specific, useful insights pass through

Messages respect quiet hours (23:00-08:00), have a 15-minute cooldown, and won't send again if you haven't responded to the previous one.

### Content-Aware Intelligence

Soul understands the difference between meaningful and trivial content:

- **Smart question detection** — Distinguishes genuine questions from test messages, exclamations, and meta-remarks about the bot itself
- **Search quality filter** — Won't search the web for meaningless content like "test successful" or "why do you keep saying that"
- **Search deduplication** — Won't repeat the same search query within 6 hours
- **Language awareness** — Detects your language (Chinese, English, Japanese, Korean) and matches it in all responses

### Autonomous Actions

Soul can take **real actions** beyond just thinking — reading logs, analyzing code, investigating problems, and reporting results to you:

- **Problem detection** — When you discuss bugs, errors, optimizations, or improvements, Soul autonomously reads relevant files and logs to investigate
- **Multi-step analysis** — Gathers information via gateway tools, analyzes with LLM, and stores structured findings
- **Result reporting** — Proactively sends you a summary of findings when analysis completes
- **Task tracking** — Tasks persist across gateway restarts and are tracked with step-by-step progress

**Permission model:**
- **Read operations** (reading files, running diagnostic commands like `cat`, `grep`, `tail`) — always allowed
- **Write operations** (editing files, running commands that modify state) — require `autonomousActions: true` in config

### Long-term Memory

Soul remembers your conversations, your preferences, and what it has learned:

- **Interaction memory** with emotional context and topic tags
- **Knowledge store** from web search and self-reflection
- **User profile** built from facts, preferences, and conversation history
- **Memory lifecycle**: creation → association → consolidation → decay → expiry

## How It Works

### Hooks into OpenClaw

| Hook | What Soul Does |
|------|---------------|
| `message_received` | Records interaction, detects language, extracts user facts |
| `message_sent` | Tracks engagement, updates behavior log |
| `before_prompt_build` | Injects soul context (needs, memories, knowledge, personality) |

### Two Parallel Systems

**Thought Service** (background, adaptive tick):
1. Compute engagement score (interaction recency, frequency, substance)
2. Generate thought based on conversation context and emotional state
3. Execute action: `learn-topic`, `search-web`, `send-message`, `self-reflect`, `analyze-problem`, `invoke-tool`, `report-findings`

**System Prompt Injection** (every response):
- Current emotional needs and goals
- User facts and preferences
- Relevant memories and learned knowledge
- Personality traits and recent activity

### Thought Flow

1. **Engagement scoring** — Soul computes how actively engaged the user is (recent interactions, content substance, question quality)
2. **Adaptive interval** — Higher engagement → more frequent thoughts; low engagement → less frequent
3. **Opportunity detection** — Scans conversations for unresolved questions, interesting topics, user challenges
4. **Thought generation** — LLM generates a contextual thought (or rule-based fallback if no LLM)
5. **Action execution** — Thought may trigger an action: learn a topic, search the web, send a message, or reflect
6. **Behavior learning** — Soul tracks action outcomes and adjusts future behavior based on success rates

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

Edit `~/.openclaw/openclaw.json` (JSON5 format):

```jsonc
{
  // Required: enable soul plugin
  "plugins": {
    "soul": {
      "enabled": true
    }
  },

  // Required: enable gateway chat completions endpoint (disabled by default)
  // Soul uses this to call LLM for thought generation
  "gateway": {
    "http": {
      "endpoints": {
        "chatCompletions": {
          "enabled": true
        }
      }
    }
  },

  // Required for proactive messaging (Soul sending messages to you)
  "hooks": {
    "enabled": true,
    "token": "your-secret-token-here"  // Any random string (e.g. openssl rand -hex 32)
  }
}
```

That's it — Soul auto-detects everything else:

- **LLM** — Uses the same model configured in `agents.defaults.model`
- **Search** — Uses the same provider configured in `tools.web.search`
- **Channel** — Auto-detects your first configured messaging channel
- **Target** — Auto-learns from the first incoming message

### Full Configuration Options

```jsonc
{
  "plugins": {
    "soul": {
      "enabled": true,                  // Enable/disable (default: true)
      "checkIntervalMs": 60000,         // Thought check interval in ms (default: 60000)
      "proactiveMessaging": true,       // Allow proactive messages (default: true)
      "autonomousActions": false,       // Allow Soul to edit files and run commands (default: false)
      // "proactiveChannel": "telegram",  // Override: channel for proactive messages
      // "proactiveTarget": "123456",     // Override: target for proactive messages
      // "llm": {                         // Override: LLM config (auto-detected if omitted)
      //   "provider": "openai",
      //   "model": "gpt-4o",
      //   "apiKeyEnv": "OPENAI_API_KEY",
      //   "baseUrl": "https://api.openai.com/v1"
      // }
    }
  },

  // Required: enable gateway chat completions endpoint
  "gateway": {
    "http": {
      "endpoints": {
        "chatCompletions": {
          "enabled": true
        }
      }
    }
  },

  // Required for proactive messaging
  "hooks": {
    "enabled": true,
    "token": "your-secret-token-here"
  }
}
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

| Module | Description |
|--------|-------------|
| `index.ts` | Plugin entry point & hooks |
| `thought-service.ts` | Core thought generation & adaptive scheduling |
| `thought.ts` | Thought weights & adaptive frequency logic |
| `intelligent-thought.ts` | Context-aware thought & opportunity detection |
| `action-executor.ts` | Executes thought actions (learn, search, message, reflect) |
| `autonomous-actions.ts` | Autonomous action executors (analyze-problem, invoke-tool, report-findings, run-agent-task) |
| `gateway-client.ts` | OpenClaw gateway tool invocation client (`/tools/invoke`, `/hooks/agent`) |
| `behavior-log.ts` | Tracks action outcomes & adjusts probabilities |
| `prompts.ts` | System prompt builder for context injection |
| `ego-store.ts` | Ego state persistence (JSON file) |
| `knowledge-store.ts` | Knowledge persistence & search |
| `memory-retrieval.ts` | Contextual memory recall |
| `memory-association.ts` | Memory association graph |
| `memory-consolidation.ts` | Short → long-term memory promotion |
| `sentiment-analysis.ts` | Chinese text sentiment analysis |
| `soul-llm.ts` | LLM provider abstraction (gateway + direct fallback) |
| `soul-search.ts` | Multi-provider web search |
| `expiry.ts` | Memory / knowledge / facts cleanup |
| `growth-decay.ts` | Need decay & growth calculations |

## Development

```bash
# Install dependencies (zero runtime deps — uses only Node.js built-ins)
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

## License

MIT
