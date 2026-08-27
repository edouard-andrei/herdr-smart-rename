# herdr-smart-rename

AI names for [herdr](https://herdr.dev) tabs and panes, on one keypress. No background watching: the rename runs only when you trigger it.

## What it does

| Action | Key | What it does |
| --- | --- | --- |
| **Smart rename tab** | `prefix+a` | Names the current tab after the work in it. |
| **Smart rename pane** | `prefix+shift+a` | Names the invoking pane after its own work. |

Both keys are free in herdr's defaults. Bind them yourself, see [Install](#install).

Renaming a tab with two or more agent panes treats the agents as peers: one summary line each, and the model names their common theme with an umbrella label. With a single agent, the dominant pane (focused agent, else any working or blocked agent, else the focused pane) gets full context and the other panes add one line as supporting evidence. Support panes (servers, logs) never define the name.

## Signals, in order of quality

1. Pane metadata: agent kind, agent status, cwd, terminal title (free, always used).
2. Agent transcripts, via the `agent_session` id herdr reports. First user prompt (the mission, 800 chars) plus as many later prompts as fit a 2,500 char budget (250 chars each). The first gets the larger budget because it carries the subject. The later window fills from the end instead of taking a fixed count, so a mid-session pivot ("actually, let's do X instead") survives. Anything cut is marked, so the model knows content is missing. A Claude skill invocation (`/pr-address 684 ...`) counts as the first prompt and the expanded skill body is dropped, so the PR or ticket number reaches the model instead of the skill's generic mission. When that first prompt names a PR, one `gh pr view` call (~0.5s) adds the PR title and branch, so the label can name the feature (`pr-687-wallet-states`) rather than just the number. Failures (no `gh`, no auth, not GitHub) are skipped. Claude: `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`. Codex: `~/.codex/sessions/<y>/<m>/<d>/rollout-*-<session-id>.jsonl`, injected noise (AGENTS.md, env context) filtered by prefix.
3. Fallback for other agents and plain panes: last 40 lines of pane output.

Known plain processes skip the model entirely: test runners → `run-tests`, dev servers → `dev-server`, `tail -f`/`journalctl -f` → `view-logs`, ssh/mosh → `remote-shell`.

The current tab or pane label, when there is one, is passed as a weak prior so a re-press keeps accurate scope words instead of wobbling; the model is told to drop it when it is generic or contradicted. Context is sanitized (ANSI stripped, home path shortened, long token-shaped strings redacted) and capped at 4,500 chars. Labels are 2-4 lowercase words joined by dashes, under 30 chars. A label that comes back slightly too long loses trailing words until it fits, rather than failing the keypress and renaming nothing.

The model is asked to split the session into subject, outcome, and incidental instructions, then label only the subject and outcome. So "make it a single-file HTML report" or "use subagents" never reaches the label. It is also told to name the work rather than the artifact used to produce it (a plan, mock, report, branch or PR), and never to imply the work is finished.

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
| `SMART_RENAME_MODEL` | `gpt-5.6-luna` | A small, fast model is the right pick here. |
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

# Local Ollama, no key needed, but the field must be non-empty
SMART_RENAME_BASE_URL=http://127.0.0.1:11434/v1
SMART_RENAME_API_KEY=ollama
SMART_RENAME_MODEL=qwen3:8b
SMART_RENAME_REASONING_EFFORT=
```

One call is roughly 350 tokens of system prompt plus 75 to 400 of context, so 450 to 750 tokens in, a handful out, so a small model at low reasoning effort is both the cheapest and the fastest choice (~1.5s round trip). Low effort is deliberate: benchmarked against high, max, and `gpt-5.6-sol`: identical label quality, lowest latency.

Run with `DEBUG=1` to print the context sent to the model on stderr.

## Undo a rename

`herdr pane rename <pane_id> --clear`, or herdr's builtin manual renames (`prefix+shift+t` / `prefix+shift+p`) to overwrite.

## License

MIT
