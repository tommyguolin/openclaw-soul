# Configuration Reference

All options are optional. Soul auto-detects most settings from your OpenClaw configuration.

## Plugin Options

These are the most commonly used options.

### `autonomousActions`

| | |
|---|---|
| **Type** | `boolean` |
| **Default** | `false` |
| **Command** | `openclaw config set plugins.entries.soul.config.autonomousActions true` |

Whether Soul can edit files and run shell commands on its own.

- When `false` (default): Soul can read files, run diagnostic commands (cat, grep, tail, ls), and analyze problems. It cannot modify anything.
- When `true`: Soul can additionally fix bugs, edit its own source code, and run any shell command.

### `thoughtFrequency`

| | |
|---|---|
| **Type** | `number` |
| **Default** | `1.0` |
| **Command** | `openclaw config set plugins.entries.soul.config.thoughtFrequency 0.5` |

Multiplier for how often Soul generates thoughts and sends messages. Values below `0.5` enter observation-test mode: thought budgets are higher, proactive outreach cooldowns are minutes rather than hours, and startup greetings can repeat after about 30 minutes.

| Value | Behavior |
|-------|----------|
| `0.2` | Testing — thoughts every ~1 min, proactive messages can recur after short cooldowns |
| `0.5` | Chatty — 2x more active than default |
| `1.0` | Default — balanced (8-12 min active, 20-45 min away) |
| `2.0` | Quiet — 2x less frequent |

### `enabled`

| | |
|---|---|
| **Type** | `boolean` |
| **Default** | `true` |
| **Command** | `openclaw config set plugins.entries.soul.config.enabled false` |

Disable Soul without uninstalling it. When `false`, the thought service stops and no hooks are registered.

---

## Advanced Options

These options have good defaults and rarely need changing. Set them only if you have specific requirements.

### `checkIntervalMs`

| | |
|---|---|
| **Type** | `number` |
| **Default** | `60000` (60 seconds) |
| **Command** | `openclaw config set plugins.entries.soul.config.checkIntervalMs 30000` |

How often (in milliseconds) Soul checks whether to generate a new thought. This is the base interval — Soul adjusts it dynamically based on your engagement level (more frequent during active conversations, less when you're away). The `thoughtFrequency` multiplier also scales this value.

### `shadowThoughtRate`

| | |
|---|---|
| **Type** | `number` between `0` and `1` |
| **Default** | `0.1` |
| **Command** | `openclaw config set plugins.entries.soul.config.shadowThoughtRate 0.1` |

Probability of attempting a private, spontaneous association when its five-minute eligibility window opens. Most attempts follow recent mental context; roughly 30% of accepted shadow attempts sample a distant memory pair. These candidates are stored in `~/.openclaw/soul/thought-pool.json` and can never directly execute actions. Maturity requires semantically relevant independent user/tool/web evidence; model repetition does not count. Set to `0` to disable this path (ordinary non-operational thoughts can still enter the pool).

### `cognitionMode`

| | |
|---|---|
| **Type** | `"legacy" \| "observe" \| "shadow" \| "primary"` |
| **Default** | `"legacy"` |
| **Command** | `openclaw config set plugins.entries.soul.config.cognitionMode observe` |

Controls the gradual Activation Layer rollout.

- `legacy` keeps current production behavior and creates no Activation Observer files.
- `observe` additionally records which memories become active and which enter a cognitive workspace. It makes no LLM calls, writes no Thought Pool candidates, sends no messages, executes no actions, and does not change Ego thought metrics.
- `shadow` lets eligible workspaces call the private shadow LLM lane. Generated thoughts are written to the cognitive journal and the isolated `thought-pool-v31-shadow.json` experiment store; they do not enter the real Thought Pool, normal Attention/Expression, messages, actions, or Ego thought metrics. Workspaces that fail the pre-generation activation test make no model call.
- `primary` makes Activation/Workspace the source of ordinary private thoughts. The Opportunity Detector remains responsible for explicit tasks and actionable intentions. Activation candidates use the real Thought Pool v3.1 path; Attention remains private, expression still passes all existing value/factuality/deduplication/timing/channel gates, and Activation-origin proactive expression is additionally limited to at most one sent item per 24 hours.

Observer state is stored in `~/.openclaw/soul/activation-state.json`; compact cycle traces are appended to `~/.openclaw/soul/cognitive-cycles.jsonl`. Return the option to `legacy` to disable the new path immediately.

### `cognitiveTemperament`

| | |
|---|---|
| **Type** | `"focused" \| "balanced" \| "expansive"` |
| **Default** | `"balanced"` |
| **Command** | `openclaw config set plugins.entries.soul.config.cognitiveTemperament expansive` |

Controls associative breadth only within the private Activation/Workspace path.

- `focused` favors recently related, convergent material.
- `balanced` is the default: it allows a small number of structurally bridged associations when the active context is stable.
- `expansive` permits a wider but still lineage-tracked set of associations.

The setting never bypasses evidence, Attention, Expression, permission, or
delivery gates. Active troubleshooting and explicit task pressure narrow the
workspace automatically in every mode.

### `expressionPolicy`

| | |
|---|---|
| **Type** | `"legacy" \| "observe" \| "adaptive"` |
| **Default** | `"legacy"` |
| **Command** | `openclaw config set plugins.entries.soul.config.expressionPolicy observe` |

Controls feedback for proactive Expression Proposals and requires `cognitionMode=primary`.

- `legacy` creates no feedback state and preserves the existing expression policy.
- `observe` records objective observations separately from inferred feedback, but does not alter expression decisions.
- `adaptive` applies only high-confidence explicit feedback to the minimum expression age, interruption cost, and value threshold. It cannot alter memory activation, private thought emergence, factual evidence requirements, or action permissions.

A missing reply window is stored as `no-reply-window` with an `unclear` inference and does not count as negative feedback. Feedback state is stored in `~/.openclaw/soul/expression-feedback.json`. Set the option back to `legacy` for an immediate policy rollback.

### `proactiveMessaging`

| | |
|---|---|
| **Type** | `boolean` |
| **Default** | `true` |
| **Command** | `openclaw config set plugins.entries.soul.config.proactiveMessaging false` |

Whether Soul can send you messages proactively. When `false`, Soul still thinks, learns, and remembers — it just doesn't send messages. Useful if you want Soul's memory and context injection without the proactive outreach.

After every inbound message, Soul enforces a five-minute active-conversation
quiet period. During this window its background cycle, private LLM calls, and
proactive messages are deferred; normal assistant replies are unaffected.

### Codex conversation and project-continuity permission

Codex may send channel replies from inside its app-server harness, bypassing
the ordinary outbound hooks. To let Soul remember only successful
`message.send` calls from those completed turns, enable the conversation hook:

```bash
openclaw config set plugins.entries.soul.hooks.allowConversationAccess true --strict-json
```

The handler remains restricted to channel-backed sessions already observed by
`message_received`. Failed sends, internal Soul model sessions, message edits,
and historical tool calls before the latest user message are ignored.

The same permission lets Soul retain bounded project metadata from successful
host-agent tool calls after the latest user message: project root, observed and
modified relative file paths, and verification command names. It does not copy
source contents into Ego state and does not grant additional write authority.
This context prevents a later Improvement from losing the project that the main
agent just inspected or edited. Ambiguous paths now stop the task instead of
falling back to a different project.

An explicit full path is always preferred. As a narrow convenience for a linked
installation, an explicit reference to `openclaw-soul` can resolve to the
running plugin's own checkout when no path or host-agent project context is
available. No other project name receives this fallback. Path extraction is
structural: short prose fragments such as `/src` and `/memory` are not treated
as Git-Bash drive paths.

With `cognitionMode=primary`, an explicit user directive is additionally linked
to the successful host-agent project activity in
`~/.openclaw/soul/work-handoffs.json`. The handoff persists the objective,
project root, work phase, evidence, and acceptance criteria across gateway
restarts. It is metadata only and does not expand `autonomousActions` or any
tool permission. Conversation provenance is used when available so an active
directive from another chat is not selected merely because it is recent.

### `proactiveChannel`

| | |
|---|---|
| **Type** | `string` |
| **Default** | auto-detected |
| **Command** | `openclaw config set plugins.entries.soul.config.proactiveChannel telegram` |

Override the channel Soul uses for proactive messages. By default, Soul auto-detects your first configured messaging channel (Telegram, Discord, Feishu, Slack, etc.). Only set this if you have multiple channels and want Soul to use a specific one.

### `proactiveTarget`

| | |
|---|---|
| **Type** | `string` |
| **Default** | auto-learned from first message |
| **Command** | `openclaw config set plugins.entries.soul.config.proactiveTarget 123456789` |

Override the target (user/chat ID) for proactive messages. By default, Soul learns your user ID from the first message you send. Only set this if auto-learning doesn't work or you want Soul to message a different user/group.

### `workspaceFiles`

| | |
|---|---|
| **Type** | `string[]` |
| **Default** | `["SOUL.md", "AGENTS.md", "MEMORY.md", "USER.md"]` |
| **Command** | `openclaw config set plugins.entries.soul.config.workspaceFiles '["SOUL.md","AGENTS.md","MEMORY.md","USER.md","CUSTOM.md"]'` |

File names Soul loads from its state directory (`~/.openclaw/agents/soul/`) as workspace context. You can create these files to give Soul custom instructions, personality notes, or project context. For example, create `USER.md` with your preferences and interests.

### `llm`

| | |
|---|---|
| **Type** | `object` |
| **Default** | auto-detected from OpenClaw |
| **Command** | See below |

Override the LLM Soul uses for thinking. By default, Soul uses the same model configured in `agents.defaults.model`. Only set this if you want Soul to use a different model (e.g., a cheaper model for background thinking).

```bash
openclaw config set plugins.entries.soul.config.llm.provider openai
openclaw config set plugins.entries.soul.config.llm.model gpt-4o
openclaw config set plugins.entries.soul.config.llm.apiKeyEnv OPENAI_API_KEY
openclaw config set plugins.entries.soul.config.llm.baseUrl https://api.openai.com/v1
openclaw config set plugins.entries.soul.config.llm.maxTokens 1024
```

| Field | Description |
|-------|-------------|
| `provider` | LLM provider name (anthropic, openai, deepseek, etc.) |
| `model` | Model ID (e.g., gpt-4o, claude-sonnet-4-6) |
| `apiKeyEnv` | Environment variable name containing the API key |
| `baseUrl` | Custom API base URL (optional) |
| `maxTokens` | Maximum generated tokens per call, 32-4096 (default: 1024) |

`maxTokens` applies to all Soul model calls, including analysis actions. Keep the production default unless every Soul task is intentionally short. Thought Laboratory uses a separate default of 192 tokens.
