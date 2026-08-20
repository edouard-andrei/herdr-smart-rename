# herdr-smart-rename

AI names for [herdr](https://herdr.dev) tabs and panes, on one keypress. No background watching: the rename runs only when you trigger it.

## Actions

- `rename-tab` — names the current tab. With two or more agent panes, all agents are peers: one summary line each, and the model names their common theme with an umbrella label. Otherwise the dominant pane (focused agent, else any working or blocked agent, else the focused pane) gets full context and other panes add one line as supporting evidence. Support panes (servers, logs) never define the name.
- `rename-pane` — names the invoking pane after its own work.

## Signals, in order of quality

1. Pane metadata: agent kind, agent status, cwd, terminal title (free, always used).
2. Agent transcripts, via the `agent_session` id herdr reports. First user prompt (the mission) plus the last two (current focus). Claude: `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`. Codex: `~/.codex/sessions/<y>/<m>/<d>/rollout-*-<session-id>.jsonl`, injected noise (AGENTS.md, env context) filtered by prefix.
3. Fallback for other agents and plain panes: last 40 lines of pane output.

Known plain processes skip the model entirely: test runners → `run-tests`, dev servers → `dev-server`, `tail -f`/`journalctl -f` → `view-logs`, ssh/mosh → `remote-shell`.

Context is sanitized (ANSI stripped, home path shortened, long token-shaped strings redacted) and capped at 4,500 chars. Labels are 2-4 lowercase words joined by dashes, under 30 chars.

## Requirements

herdr 0.8.0+, Node 22+ (uses `fs.globSync` and `util.parseEnv`), and an API key for any OpenAI-compatible `/chat/completions` endpoint.

## Install

```bash
herdr plugin install edouard-andrei/herdr-smart-rename
```

Then put your key in the plugin config dir:

```bash
echo 'SMART_RENAME_API_KEY=sk-...' >> "$(herdr plugin config-dir edi.smart-rename)/.env"
```

Keybindings go in `~/.config/herdr/config.toml`, then `herdr server reload-config`:

```toml
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "edi.smart-rename.rename-tab"
description = "smart rename tab"

[[keys.command]]
key = "prefix+shift+a"
type = "plugin_action"
command = "edi.smart-rename.rename-pane"
description = "smart rename pane"
```

## Config

Settings are read from `.env` in `herdr plugin config-dir edi.smart-rename`. Real environment variables override the file.

| Key | Default | Notes |
| --- | --- | --- |
| `SMART_RENAME_API_KEY` | falls back to `OPENAI_API_KEY` | Required. |
| `SMART_RENAME_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint. |
| `SMART_RENAME_MODEL` | `gpt-5-mini` | A small, fast model is the right pick here. |
| `SMART_RENAME_REASONING_EFFORT` | `low` | Set empty to omit the field for providers that reject it. |

Some working combinations:

```ini
# OpenAI
SMART_RENAME_API_KEY=sk-...

# Anthropic, via the OpenAI-compatible endpoint
SMART_RENAME_BASE_URL=https://api.anthropic.com/v1
SMART_RENAME_API_KEY=sk-ant-...
SMART_RENAME_MODEL=claude-haiku-4-5-20251001
SMART_RENAME_REASONING_EFFORT=

# Local Ollama — no key needed, but the field must be non-empty
SMART_RENAME_BASE_URL=http://127.0.0.1:11434/v1
SMART_RENAME_API_KEY=ollama
SMART_RENAME_MODEL=qwen3:8b
SMART_RENAME_REASONING_EFFORT=
```

One call is roughly 500 tokens in, a handful out, so a small model at low reasoning effort is both the cheapest and the fastest choice (~1.5s round trip). Bigger models were benchmarked and produced the same labels.

Run with `DEBUG=1` to print the context sent to the model on stderr.

## Undo a rename

`herdr pane rename <pane_id> --clear`, or herdr's builtin manual renames (`prefix+shift+t` / `prefix+shift+p`) to overwrite.

## License

MIT
