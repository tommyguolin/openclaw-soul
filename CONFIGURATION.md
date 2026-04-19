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

Multiplier for how often Soul generates thoughts and sends messages. Affects all intervals and cooldowns proportionally.

| Value | Behavior |
|-------|----------|
| `0.2` | Testing — thoughts every ~1 min, messages frequently |
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

### `proactiveMessaging`

| | |
|---|---|
| **Type** | `boolean` |
| **Default** | `true` |
| **Command** | `openclaw config set plugins.entries.soul.config.proactiveMessaging false` |

Whether Soul can send you messages proactively. When `false`, Soul still thinks, learns, and remembers — it just doesn't send messages. Useful if you want Soul's memory and context injection without the proactive outreach.

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
```

| Field | Description |
|-------|-------------|
| `provider` | LLM provider name (anthropic, openai, deepseek, etc.) |
| `model` | Model ID (e.g., gpt-4o, claude-sonnet-4-6) |
| `apiKeyEnv` | Environment variable name containing the API key |
| `baseUrl` | Custom API base URL (optional) |
