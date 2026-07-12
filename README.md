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
- **Private associations** — Occasionally connects distant memories and incubates the result without immediately turning it into a task or message

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
- **Evidence-aware learning** — web, user, tool, and model provenance are distinguished; unverified or model-only claims cannot resurface as factual proactive thoughts

### Language Independence

Soul uses the configured model to classify interaction meaning and semantic topics regardless of the language used by the user. Fixed English/Chinese keyword rules remain only as a conservative no-model fallback. Unicode-aware association works across accented Latin, Cyrillic, Greek, CJK, and other writing systems, so supporting another language does not require adding a new keyword dictionary.

Thought context follows the current conversation window rather than flattening unrelated historical turns together. Explicit semantic redirects and closures form hard boundaries; a long conversational gap forms a new window automatically.

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
| `message_sending` / `message_sent` | Stores outbound conversation memory idempotently across OpenClaw hook versions |
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

Each eligible thought cycle is appended to `~/.openclaw/soul/thought-cycles.jsonl`, including its context, candidates, selection, result, and recent diversity state. On restart, Soul restores recent thought types, topics, and actions from this journal instead of forgetting its diversity history.

Need deficits, goal percentages, and self-improvement checks stay in background maintenance rather than masquerading as thoughts. Both ordinary non-operational reflections and spontaneous associations enter `~/.openclaw/soul/thought-pool.json` as private seeds instead of immediately learning, searching, or messaging. Most spontaneous associations continue the recent foreground or cognitive residue; only a small minority use a distant-memory bridge.

Thought Pool candidates mature only when a similar thought reappears through semantically related, independently grounded user/tool/web evidence. Model-generated guesses and changed memory IDs do not count as new evidence. Version 3 also persists resolution tombstones: a thought whose premise conflicts with a currently resolved state is rejected before incubation, and superseded facts are excluded from current-context prompts and opportunity detection. A candidate needs at least three distinct activations, sufficient coherence/maturity, no quality flags, and an attention score of at least 0.65 before the private Attention Gate can notice it. Attention remains private and actionless. After a separate pause, a mature, coherent, user-relevant candidate gets one independent expression review through the normal value, factuality, deduplication, cooldown, and delivery gates; it may still remain unspoken.

Quality flags describe the recent trajectory rather than permanently poisoning a candidate: two clean reactivations clear old task-pressure/truncation flags, while meta-framing needs three. In observation-test mode, the same stable stimulus waits five minutes before another model generation (fifteen minutes normally); this interval is restored from the pool after restart and is cleared early by a new inbound interaction.

Attention remains private: the candidate is marked `attended` and journaled as an actionless `reflect-on-memory` thought, but it bypasses the normal thought handler, message sender, and action executor. `thought-pool.json` includes aggregate metrics for activation rate, maturity, attention, cognitive moves, remote association, source-memory age, natural silence, resolved-topic recurrence, contradicted premises, useful-surprise proxy, and low-coherence/task/meta leakage. `NO_THOUGHT` is a valid observation outcome rather than a generation failure.

On startup, legacy candidates are revalidated against the current grounded memories. Historical maturity built from unrelated memory IDs or model-generated repetition is demoted before Attention or Expression review. During normal running, a third consecutive question/speculation becomes a measured silence, and proactive permission/menu questions are rejected unless the message contains an actual finding rather than a choice of future work.

Local project evidence is treated differently from general knowledge. Questions about backtests, OOS CAGR, MaxDD, logs, scripts, deployment, or local result versions are routed to local analysis rather than `search-web`; if Soul has no explicit local file or path to inspect, it records an internal `local-evidence-target-missing` result and does not send a fabricated answer.

Model usage is divided into critical-memory, action, normal-thought, and shadow lanes under a shared rolling budget. This reserves capacity for conversation understanding and useful actions even when background thought is active. Low `thoughtFrequency` values are treated as observation-test mode and use much looser budgets/cooldowns so proactive behavior can be tested without waiting hours.

## Configuration

All options have sensible defaults. Only configure what you need.

| Option | Default | Command |
|--------|---------|---------|
| `autonomousActions` | `false` | `openclaw config set plugins.entries.soul.config.autonomousActions true` |
| `thoughtFrequency` | `1.0` | `openclaw config set plugins.entries.soul.config.thoughtFrequency 0.5` |

- **`autonomousActions`** — Allow Soul to edit files and run commands. When `false`, Soul can still read files and run diagnostics, but cannot modify anything. When `true`, Soul can fix bugs, edit its own code, and run any command.
- **`thoughtFrequency`** — How often Soul thinks and messages. `0.2`-`0.4` for testing and faster proactive outreach, `1.0` for default, `2.0` for quiet.

Soul extracts project paths from user requests such as "optimize the project under `/path/to/project`". If a path cannot be read directly, Soul also tries common cross-platform mappings such as Git Bash `/c/work/project`, WSL `/mnt/c/work/project`, and Windows `C:\work\project`.

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
| `thought-journal.ts` | Durable thought-cycle trace and restart diversity recovery |
| `thought-lab.ts` | Read-only accelerated baseline and A/B experiments |
| `thought-emergence.ts` | Shared remote-memory selection, prompts, and quality classification |
| `thought-pool.ts` | Persistent private candidate incubation and attention scoring |
| `behavior-log.ts` | Tracks action outcomes & adjusts probabilities |
| `ego-store.ts` | Ego state persistence (JSON) |
| `knowledge-store.ts` | Knowledge persistence & search |
| `memory-retrieval.ts` | Contextual memory recall |
| `memory-association.ts` | Memory association graph |
| `memory-consolidation.ts` | Short → long-term memory promotion |
| `soul-llm.ts` | LLM provider abstraction (gateway + direct fallback) |
| `soul-search.ts` | Multi-provider web search |

## Thought Laboratory

Thought Laboratory simulates many thought cycles against one read-only Ego snapshot. It never updates the Ego store, sends messages, or executes actions. Each run is written to JSONL and aggregate baseline metrics are written to a sibling `summary.json` file.

Run the current detector pipeline without model calls:

```bash
npm run thought-lab -- --store /path/to/ego.json --runs 200 --mode baseline
```

Run the minimal 80/20 experiment (80% current pipeline, 20% remote-memory spontaneous path):

```bash
npm run thought-lab -- \
  --store /path/to/ego.json \
  --runs 200 \
  --mode experiment \
  --provider openai \
  --model your-model-name
```

The provider API key is resolved from its normal environment variable. Use `--api-key-env`, `--base-url`, `--spontaneous-rate`, `--seed`, `--output`, or `--max-tokens` to override defaults. Lab model calls default to 192 output tokens. Model-backed runs make one generation call per cycle, so start with a small run before a 200-cycle comparison.

Recalculate current metrics from an existing JSONL without making model calls:

```bash
npm run thought-lab -- --input /path/to/existing-run.jsonl
```

Reported metrics include opportunity, thought, action and cognitive-move distributions; no-op and repetition rates; lexical semantic diversity; source-memory age/diversity; cross-topic association rate; and explicit meta-framing, task-pressure, and truncation leakage rates. Remote pairs are chosen across coarse topic clusters before lexical distance, so two differently worded trading memories are no longer mislabeled as cross-topic. The spontaneous path records exact source memories; baseline records label source-memory matches as lexical inference because the production detector does not preserve provenance IDs. “Useful surprise” and “nonsense” remain explicit blind-review measures rather than pretending a heuristic can judge them.

## Development

```bash
npm install    # Zero runtime deps — uses only Node.js built-ins
npm run build
npm test
```

## License

MIT
