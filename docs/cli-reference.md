# CLI reference

`omp` is invoked as:

```sh
omp [command] [flags] [messages...]
```

When the first non-flag argument is **not** a registered subcommand, `omp`
routes to the default [`launch`](#launch-the-default-command) command and treats
the arguments as the initial prompt. So `omp "fix the build"` launches a session
with that message, while `omp models` runs the `models` subcommand.

Runtime help is also available:

- `omp --help` lists user-facing subcommands and common launch flags.
- `omp <command> --help` prints that command's public flags and examples.

This page is the consolidated reference for the shared **launch surface** (the
flags accepted by `omp` / `omp launch`) and every top-level **subcommand**.
Per-subcommand flags (for example `omp auth-broker --json`) are documented by
each command's `--help`.

## Launch (the default command)

`omp` and `omp launch` start a coding session. Positional arguments become the
initial message(s):

```sh
# Interactive session
omp

# Interactive session with an initial prompt
omp "List all .ts files in src/"

# Attach files/images to the initial message (prefix with @)
omp @prompt.md @image.png "What color is the sky?"

# Non-interactive: process the prompt and exit (headless / print mode)
omp -p "List all .ts files in src/"

# Continue the previous session
omp --continue "What did we discuss?"
```

Argument handling:

- `@<path>` attaches a file or image to the initial message.
- Non-TTY stdin is read automatically as the initial prompt; do not add a `-`
  marker.
- `--` ends flag parsing; everything after it is literal message text, even if it
  looks like a flag.

### Launch flags

#### Session and workspace

| Flag | Description |
| --- | --- |
| `--cwd <dir>` | Directory to start in (overrides the launch cwd). |
| `--add-dir <dir>` | Add a workspace directory beyond the working directory (repeatable). |
| `--allow-home` | Allow starting in `~` without auto-switching to a temp dir. |
| `--profile <name>` | Use an isolated profile for auth, sessions, settings, and caches. |
| `--alias <name>` | Create a shell shortcut for the selected profile and exit. |
| `--config <file>` | Load an extra `config.yml`-style overlay for this run (repeatable). |
| `--reapply-config` | On resume, adopt the config-resolved default model, thinking level, and service tier instead of the session's own; applied per knob. Default off. |
| `--session-dir <dir>` | Directory for session storage and lookup. |
| `--no-session` | Don't save the session (ephemeral). |

`--reapply-config` re-applies a `--config`/`--profile` overlay to a resumed
session, which otherwise restores the model, thinking level, and service tier
baked in at its original launch. Adoption is per knob — a value the config does
not specify keeps the session's own. The model and thinking level are only
adopted when no explicit `--model` is given (`--model` pins those two); the
service tier re-applies per family regardless of `--model` (a family the config
omits keeps the session's), and `--service-tier` still overrides it. A bare
resume (flag off) always restores the session's own values.

#### Session history

| Flag | Description |
| --- | --- |
| `--continue`, `-c` | Continue the previous session. |
| `--resume [id]`, `-r`, `--session [id]` | Resume a session by ID prefix or path, or open the picker when no value is given. |
| `--fork <session>` | Fork a saved session (by ID prefix or path) into a new session. See [session operations](./session-operations-export-share-fork-resume.md). |
| `--from-claude` | Import a Claude Code session into OMP. |
| `--from-codex` | Import a Codex session into OMP. |
| `--export <session>` | Export a session file to HTML and exit. |
| `--no-title` | Disable title auto-generation (equivalent to the `PI_NO_TITLE` [environment variable](./environment-variables.md)). |

#### Model selection

| Flag | Description |
| --- | --- |
| `--model <id-or-role>` | Model or configured role to use (role: `slow` or `@slow`; fuzzy model match: `opus`, `gpt-5.2`, or `openai/gpt-5.2`). |
| `--smol <id>` | Smol/fast model for lightweight tasks (or `PI_SMOL_MODEL`). |
| `--slow <id>` | Slow/reasoning model for thorough analysis (or `PI_SLOW_MODEL`). |
| `--plan <id>` | Plan model for architectural planning (or `PI_PLAN_MODEL`). |
| `--models <a,b,c>` | Comma-separated model patterns for `Ctrl+P` cycling. |
| `--provider <name>` | Provider to use (legacy; prefer `--model`). |
| `--api-key <key>` | API key (defaults to env vars). |
| `--provider-session-id <id>` | Reuse a specific provider-side session id for continuity and cache scoping. |
| `--prompt-cache-key <key>` | Override the provider prompt-cache key for this session. |
| `--service-tier <tier>` | OpenAI service tier for this session (`none` omits `service_tier`). |

See [providers](./providers.md) and [models](./models.md) for model resolution.

#### Thinking and reasoning

| Flag | Description |
| --- | --- |
| `--thinking <level>` | Set the thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `auto`. |
| `--hide-thinking` | Hide thinking blocks in TUI output (display only; does not disable model thinking). |
| `--print-thoughts` | Include thinking blocks in print-mode text output. |
| `--external-thinking` | Use a private scratchpad while disabling supported GPT/Claude/Gemini reasoning. Use at your own risk: providers have flagged this request shape as abuse. |

#### Prewalk and plan modes

| Flag | Description |
| --- | --- |
| `--prewalk` | Switch to a fast/cheap model at the first edit/write after the plan's todo list exists (default off; see `prewalk.enabled`). |
| `--no-prewalk` | Disable prewalk even if `prewalk.enabled` is set. |
| `--prewalk-into <id>` | Target model for prewalk (default the `smol` role). |
| `--plan-yolo` | Force read-only plan mode at start, auto-approve the plan on the model's first resolve call, then switch to `--plan-yolo-into` to implement it. |
| `--plan-yolo-into <id>` | Target model for plan-yolo execution (default the `smol` role). |

#### Tools, approvals, and runtime

| Flag | Description |
| --- | --- |
| `--tools <a,b,c>` | Comma-separated list of tools to enable (default: all). |
| `--no-tools` | Disable all built-in tools. |
| `--no-lsp` | Disable LSP tools, formatting, and diagnostics. |
| `--no-pty` | Disable PTY-based interactive bash execution. |
| `--approval-mode <mode>` | Override `tools.approvalMode` for this session (`always-ask`, `write`, or `yolo`). See [approval mode](./approval-mode.md). |
| `--auto-approve`, `--yolo` | Auto-approve all tool calls (skip approval prompts). |
| `--advisor` | Enable the advisor runtime (passively reviews each turn and injects notes). See [advisor / watchdog](./advisor-watchdog.md). |
| `--max-time <duration>` | Stop the session after this duration (e.g. `600`, `10m`, `1h`). |

#### Extensions, hooks, skills, and rules

| Flag | Description |
| --- | --- |
| `--extension <path>`, `-e <path>` | Load an extension (repeatable). See [extensions](./extensions.md). |
| `--hook <path>` | Load a hook/extension file (repeatable). See [hooks](./hooks.md). |
| `--trusted-extension <abs-path>` | Load a trusted extension from an absolute path (repeatable; cannot be combined with `--extension`/`-e`/`--hook`). |
| `--plugin-dir <dir>` | Add a local plugin directory to discovery (repeatable). |
| `--no-extensions` | Disable extension discovery (explicit `-e` paths still work). |
| `--skills <globs>` | Comma-separated glob patterns to filter [skills](./skills.md) (e.g. `git-*,docker`). |
| `--no-skills` | Disable skills discovery and loading. |
| `--no-rules` | Disable rules discovery and loading. See [context files](./context-files.md). |

#### System prompt

| Flag | Description |
| --- | --- |
| `--system-prompt <text\|file>` | System prompt (default: coding assistant prompt). See [system prompt customization](./system-prompt-customization.md). |
| `--append-system-prompt <text\|file>` | Append text or file contents to the system prompt. |

#### Output mode

| Flag | Description |
| --- | --- |
| `--mode <mode>` | Output/transport mode: `text` (default), `json`, `rpc`, `acp`, or `rpc-ui`. See [output modes](#output-modes---mode). |

#### Information

| Flag | Description |
| --- | --- |
| `--help`, `-h` | Show help for `omp` or a subcommand and exit. |
| `--version`, `-v` | Print the installed version and exit. |

### Headless / print mode

`--print` / `-p` runs `omp` non-interactively: it processes the prompt, streams
the result to stdout, and exits without entering the TUI. This is the entry point
for scripting and automation.

```sh
# Print the answer and exit
omp -p "Summarize the changes in the last commit"

# Include the model's thinking blocks in the printed text
omp -p --print-thoughts "Explain your reasoning for this refactor"

# Machine-readable output for pipelines
omp -p --mode json "List every TODO in src/" > todos.json

# Pipe a prompt via stdin
echo "review this diff" | omp -p
```

Related flags for headless runs:

- `--print-thoughts` — include thinking blocks in the printed text output.
- `--mode json` — emit structured events instead of rendered text.
- `--no-title` — skip title auto-generation (also `PI_NO_TITLE`).
- `--max-time <duration>` — bound the run.

The [advisor / watchdog](./advisor-watchdog.md#headless-runs) doc describes
print-mode disposal semantics when the advisor runtime is enabled.

### Output modes (`--mode`)

| Mode | Description |
| --- | --- |
| `text` | Default. Rendered text output (TUI when interactive, plain text under `--print`). |
| `json` | Structured JSON event stream, for headless/machine consumption. |
| `rpc` | JSON-RPC server over stdio. See [RPC](./rpc.md). |
| `rpc-ui` | RPC transport with UI extension events enabled. |
| `acp` | Agent Client Protocol server over stdio. Equivalent to the [`acp`](#subcommands) subcommand; see [approval mode → ACP sessions](./approval-mode.md#acp-sessions). |

## Subcommands

Run `omp <command> --help` for each command's own flags and examples.

| Command | Purpose | See also |
| --- | --- | --- |
| `launch` | Start a coding session (the default command). | [Launch flags](#launch-flags) |
| `acp` | Run Oh My Pi as an ACP (Agent Client Protocol) server over stdio. | [approval mode](./approval-mode.md#acp-sessions) |
| `auth-broker` | Manage the omp auth-broker (credential vault). | [auth broker / gateway](./auth-broker-gateway.md) |
| `auth-gateway` | Run an auth-gateway forward proxy backed by the configured broker. | [auth broker / gateway](./auth-broker-gateway.md) |
| `agents` | Manage bundled task agents. | [task agent discovery](./task-agent-discovery.md) |
| `bench` | Benchmark models: TTFT/prefill vs decode throughput with p50/p95 across chat, prefill, generation, and prompt-cache workloads, rendered in a live dashboard (`--prefill-bytes` sizes the synthetic prefill input). | |
| `browser-relay` | Run the local CDP relay used by Eval's browser API to drive your own Chrome tabs. | [computer use](./computer-use.md) |
| `cleanse` | Detect and fix project diagnostics with weighted parallel subagents. | |
| `commit` | Generate a commit message and update changelogs. | |
| `completions` | Print a shell completion script (bash, zsh, or fish). | |
| `compress` | Rewrite a text file into the dense prompt register, reporting what it drops. | |
| `config` | Manage configuration settings. | [config usage](./config-usage.md), [settings](./settings.md) |
| `dry-balance` | Dry-run OAuth account balancing across random session ids. | |
| `gc` | Run storage garbage collection. | |
| `grep` | Test the grep tool from the CLI. (The [`grep` tool](./tools/grep.md) is a separate agent tool.) | |
| `gallery` | Preview tool renderers across streaming, in-progress, success, and failure states. | |
| `git` | Interactive fullscreen git UI: split diff viewer, staging sidebar, and commit composer. | |
| `grievances` | View, clean, or push reported tool issues (auto-QA grievances). | |
| `if-bench` | Benchmark instruction following and working memory: one cached thread of glyph array actions with a cat-sound directive that moves through the prompt. | |
| `images`, `img` | Inspect, diagnose, probe, and purge image publication backends. | |
| `install` | Install or link an extension package (alias of `plugin install` / `plugin link`). | [extensions](./extensions.md) |
| `join` | Join a shared collab session (same as `/join`). | [collab](./collab.md) |
| `models` | List, search, and refresh available models. | [models](./models.md) |
| `plugin` | Manage plugins (install, uninstall, list, etc.). | [extensions](./extensions.md), [marketplace](./marketplace.md) |
| `ps` | List and control daemon-supervised background processes (logs, stop, kill, restart). | |
| `say` | Synthesize text with the local TTS engine and play it through the speakers. | [tts tool](./tools/tts.md) |
| `share` | Share a saved session via an encrypted link (same as the `/share` slash command). | [session operations](./session-operations-export-share-fork-resume.md) |
| `setup` | Run onboarding setup or install dependencies for optional features. | |
| `shell` | Interactive shell console. | |
| `read` | Show what the read tool will return for a path, URL, or internal URI. (The [`read` tool](./tools/read.md) is a separate agent tool.) | |
| `render` | Draw a session's entire thread through the production transcript pipeline (with repaint timing). | |
| `ssh` | Manage SSH host configurations. | |
| `stats` | View usage statistics. | |
| `update` | Check for and install updates; `--canary`/`--stable` switch release channels. | |
| `usage` | Show provider usage limits for every authenticated account; `usage clients` breaks token burn down per client (with `--days`), `usage invalidate` drops cached reports. | |
| `tiny-models` | Download tiny local models (session titles + memory). | [local models](./local-models.md) |
| `token` | Get the API key or OAuth token for a provider. | [secrets](./secrets.md) |
| `ttsr` | Inspect and test Time-Traveling Stream Rules (TTSR). (Covers the CLI command; the [TTSR feature](./ttsr-injection-lifecycle.md) is documented separately.) | |
| `worktree`, `wt` | List or clear agent-managed git worktrees (`~/.omp/wt`). | |
| `search`, `q` | Test web search providers from the CLI. | [web_search tool](./tools/web_search.md) |

> `install`, `join`, `browser-relay`, `auth-gateway`, and `tiny-models` are also
> reachable through related mechanisms (the `plugin` command, the `/join` slash
> command, and so on). The table lists each as it is registered in
> `packages/coding-agent/src/cli-commands.ts`.
