# Soul — Give Your AI Assistant Its Own Inner Life

[![ClawHub](https://img.shields.io/badge/ClawHub-soul-blue?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiByeD0iMyIgZmlsbD0iIzQwOWNmZiIvPjwvc3ZnPg==)](https://clawhub.ai/plugins/openclaw-soul-plugin)
[![Version](https://img.shields.io/github/v/tag/tommyguolin/openclaw-soul?label=version)](https://github.com/tommyguolin/openclaw-soul/tags)
[![License](https://img.shields.io/github/license/tommyguolin/openclaw-soul)](https://github.com/tommyguolin/openclaw-soul/blob/main/LICENSE)
[![Stars](https://img.shields.io/github/stars/tommyguolin/openclaw-soul?style=social)](https://github.com/tommyguolin/openclaw-soul/stargazers)

> An autonomous thinking, memory, and self-improvement plugin for [OpenClaw](https://github.com/openclaw/openclaw)

**Soul doesn't just respond to you — it thinks on its own, remembers your conversations, learns from the web, and proactively shares useful insights.**

It has its own emotional needs, goals, desires, and personality that evolve over time. It can autonomously investigate problems, analyze logs, and even fix its own code.

## What It Looks Like

Soul works silently in the background. Here's what you might see:

**You asked about a timeout error yesterday. Soul investigated overnight:**

> That timeout issue you asked about — root cause is the embedding API's 512 token limit, not the plugin itself.

**Soul found something relevant to your project:**

> Found an interesting approach to your question about making AI more proactive — Fei-Fei Li's "human-centered AI" framework emphasizes that AI should proactively understand user needs rather than just responding.

**Soul autonomously analyzed a problem you mentioned:**

> The 413 error in the logs is caused by oversized memory search input. Suggest truncating queries to under 500 characters.

*These are real message formats — Soul composes them itself based on actual investigation results, not templates.*

## How Soul Is Different

Most AI assistants are **reactive** — they only respond when you ask. Soul is **proactive**:

| | Regular AI Assistant | Soul Plugin |
|---|---|---|
| Thinking | Only when prompted | Continuously, in the background |
| Memory | Per-session, resets | Persistent across restarts |
| Proactive messages | No | Yes — when it has something valuable |
| Problem investigation | Only when asked | Autonomous — detects issues from conversation |
| Self-improvement | No | Can observe and improve its own code |
| User understanding | Per-session context | Builds a long-term user profile |

## Key Features

### Autonomous Thought Cycle

Soul runs a background thought service that generates thoughts based on:

- **Conversation replay** — Replays your past conversations to find unresolved questions, follow-up opportunities, or insights worth sharing
- **Problem detection** — When you discuss bugs, errors, or optimizations, Soul autonomously investigates
- **User interests** — Extracts topics from conversations and proactively learns about them
- **Emotional needs** — Five core needs (survival, connection, growth, meaning, security) that drive behavior

Thought frequency is **adaptive**, not mechanical: 8-12 min during active conversations, 20-45 min when you're away.

### Proactive Messaging

Soul reaches out when it has something genuinely useful — not just "checking in":

- Found an answer to a question you asked earlier
- Discovered a better solution to a problem you discussed
- Learned something relevant to your project or interests

Every message passes through a **value gate**: an LLM evaluates whether the content is worth sharing. Generic small talk is filtered out.

### Autonomous Actions

Soul can take real actions beyond thinking:

- **`analyze-problem`** — Reads files and logs, uses LLM to analyze root cause
- **`run-agent-task`** — Delegates to a full agent with write access (when enabled)
- **`report-findings`** — Proactively sends you a summary of completed analysis
- **`observe-and-improve`** — Self-improvement: reads its own code, identifies improvements, and implements fixes

**Permission model:**
- **Read operations** (reading files, running diagnostics) — always allowed
- **Write operations** (editing files, running commands) — requires `autonomousActions: true`

### Long-term Memory

Soul remembers your conversations, preferences, and knowledge:

- **Interaction memory** with emotional context and topic tags
- **Knowledge store** from web search and self-reflection
- **User profile** built from facts, preferences, and conversation history
- **Memory association graph** — memories are linked and recalled contextually

## Quick Start

### 1. Install

```bash
git clone https://github.com/tommyguolin/openclaw-soul.git
openclaw plugins install ./openclaw-soul
```

Or install from ClawHub:

```bash
openclaw plugins install clawhub:openclaw-soul-plugin
```

### 2. Configure

Soul needs three things to work: access to the LLM, permission to send you messages, and a message delivery channel. Run these commands (replace `your-secret-token` with your own random string):

```bash
# Allow Soul to call the LLM through the gateway
openclaw config set gateway.http.endpoints.chatCompletions.enabled true

# Enable hooks — Soul uses this to send proactive messages
openclaw config set hooks.enabled true
openclaw config set hooks.token your-secret-token

# Allow the "message" tool — Soul uses this to deliver messages to you
openclaw config set tools.alsoAllow '["message"]'
```

### 3. Restart gateway

```bash
openclaw gateway restart
```

Verify that Soul started:

```bash
openclaw logs --plain --limit 200 | rg soul
```

For local linked installs, run `openclaw plugins registry --refresh` before
restarting if OpenClaw still uses stale plugin metadata.

Soul auto-detects everything else:
- **LLM** — Uses your `agents.defaults.model` config (the same model your AI assistant uses)
- **Search** — Uses your `tools.web.search` provider
- **Channel** — Auto-detects your first messaging channel (Telegram, Discord, Feishu, etc.)
- **Target** — Auto-learns from your first incoming message

Just start chatting. Soul begins thinking and building a profile immediately.

## How It Works

### Hooks into OpenClaw

| Hook | What Soul Does |
|------|---------------|
| `message_received` | Records interaction, detects language, extracts user facts |
| `message_sent` | Tracks engagement, updates behavior log |
| `before_prompt_build` | Injects soul context (needs, memories, knowledge, personality) |

### Self-Improvement Loop

```
Tick cycle detects opportunity
  → analyze-problem (read logs, LLM analysis)
  → If analysis found a concrete fix
    → run-agent-task (full agent with write/edit/exec tools)
    → Agent completes, result stored
  → Next tick: report-findings sends summary to user
```

This creates a closed loop: **observe → analyze → fix → verify → report**.

### Thought Flow

1. **Engagement scoring** — How actively engaged is the user?
2. **Opportunity detection** — Scans for unresolved questions, problems, topics
3. **Thought generation** — LLM generates a contextual thought
4. **Action execution** — learn, search, message, analyze, or self-improve
5. **Behavior learning** — Tracks outcomes and adjusts future behavior

## Configuration

All options have sensible defaults. Only configure what you need.

| Option | Default | Command |
|--------|---------|---------|
| `autonomousActions` | `false` | `openclaw config set plugins.entries.soul.config.autonomousActions true` |
| `thoughtFrequency` | `1.0` | `openclaw config set plugins.entries.soul.config.thoughtFrequency 0.5` |

- **`autonomousActions`** — Allow Soul to edit files and run commands. When `false`, Soul can still read files and run diagnostics, but cannot modify anything. When `true`, Soul can fix bugs, edit its own code, and run any command.
- **`thoughtFrequency`** — How often Soul thinks and messages. `0.2` for testing (very chatty), `1.0` for default, `2.0` for quiet.

Full configuration reference: [CONFIGURATION.md](CONFIGURATION.md)

### Environment Variables

| Variable | Description |
|----------|-------------|
| `SOUL_DEBUG=1` | Enable debug logging |
| `OPENCLAW_STATE_DIR` | Override data directory (default: `~/.openclaw`) |

## Supported Providers

### Search (inherits OpenClaw config)

Brave, Gemini, Grok, Kimi, Perplexity, Bocha — configured via OpenClaw's `tools.web.search`.

### LLM (inherits OpenClaw config)

Any OpenAI-compatible or Anthropic API: Claude, GPT-4o, DeepSeek, Zhipu, Minimax, Moonshot (Kimi), Qwen, and any custom endpoint.

## Architecture

| Module | Description |
|--------|-------------|
| `intelligent-thought.ts` | Context-aware thought & opportunity detection |
| `action-executor.ts` | Executes thought actions (learn, search, message, reflect) |
| `autonomous-actions.ts` | Autonomous executors (analyze-problem, run-agent-task, report-findings, observe-and-improve) |
| `thought-service.ts` | Core thought generation & adaptive scheduling |
| `behavior-log.ts` | Tracks action outcomes & adjusts probabilities |
| `ego-store.ts` | Ego state persistence (JSON) |
| `knowledge-store.ts` | Knowledge persistence & search |
| `memory-retrieval.ts` | Contextual memory recall |
| `memory-association.ts` | Memory association graph |
| `memory-consolidation.ts` | Short → long-term memory promotion |
| `soul-llm.ts` | LLM provider abstraction (gateway + direct fallback) |
| `soul-search.ts` | Multi-provider web search |

## Development

```bash
pnpm install   # Zero runtime deps — uses only Node.js built-ins
pnpm build
```

## License

MIT
