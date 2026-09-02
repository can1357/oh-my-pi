---
title: CLI Reference
description: Every omp command-line flag and subcommand.
coverage: A
---

`omp` is the command-line entry point. With no subcommand it launches the interactive coding agent (TUI); with a subcommand it runs that command and exits. This page lists the global launch flags and every registered subcommand with its flags exactly as declared.

```bash
omp                                    # interactive session
omp "List all .ts files in src/"       # interactive, seeded with a prompt
omp -p "Summarize this diff"           # non-interactive: answer and exit
omp models find sonnet                 # subcommand
```

Anything after the flags that is not a registered subcommand is sent to the agent as a prompt. Prefix a path with `@` to attach a file to the initial message (`omp @prompt.md "continue"`), and use `--` to stop flag parsing so flag-shaped text is treated as the prompt.

Run `omp --help` for the global help text and `omp <command> --help` for command-specific help.

## Global launch flags

These flags apply to the default launch command (`omp`, `omp -p`, `omp acp`). Value-taking flags also accept `--flag=value` form. Extensions can register additional flags; a flag an extension owns is parsed with the extension's semantics.

### Model and prompt

| Flag | Description |
| --- | --- |
| `--model <model>` | Model to use (fuzzy match: "opus", "gpt-5.2", or "openai/gpt-5.2") |
| `--smol <model>` | Smol/fast model for lightweight tasks (or `PI_SMOL_MODEL` env) |
| `--slow <model>` | Slow/reasoning model for thorough analysis (or `PI_SLOW_MODEL` env) |
| `--plan <model>` | Plan model for architectural planning (or `PI_PLAN_MODEL` env) |
| `--provider <provider>` | Provider to use (legacy; prefer `--model`) |
| `--api-key <key>` | API key (defaults to env vars) |
| `--service-tier <tier>` | Service-tier override for OpenAI-family models: `none`, `auto`, `default`, `flex`, `scale`, or `priority` (default: `tier.openai` setting; not persisted; `none` omits it) |
| `--provider-session-id <id>` | Force the provider session id (provider session/routing headers and sticky credential selection) |
| `--prompt-cache-key <key>` | Override the provider prompt-cache key (sent as `prompt_cache_key` where supported; independent of the session id) |
| `--models <list>` | Comma-separated model patterns for Ctrl+P cycling |
| `--thinking <level>` | Set thinking level (see `--help` for valid levels) |
| `--hide-thinking` | Hide thinking blocks in TUI output (display only, does not disable model thinking) |
| `--system-prompt <text>` | System prompt (default: coding assistant prompt) |
| `--append-system-prompt <text>` | Append text or file contents to the system prompt |
| `--prewalk` | Switch from the active model to a fast/cheap model at the first edit/write after the plan's todo list exists (default off; see `prewalk.enabled`) |
| `--no-prewalk` | Disable prewalk even if `prewalk.enabled` is set |
| `--prewalk-into <model>` | Target model for prewalk (default the "smol" role) |
| `--plan-yolo` | Force read-only plan mode at start, auto-approve the plan on the model's first resolve call, then switch to `--plan-yolo-into` to implement it |
| `--plan-yolo-into <model>` | Target model for plan-yolo execution (default the "smol" role) |
| `--advisor` | Enable the advisor runtime (passively reviews each turn and injects notes) |
| `--max-time <duration>` | Stop the session after this duration (e.g., 600, 10m, 1h) |

### Session and startup

| Flag | Description |
| --- | --- |
| `-c, --continue` | Continue previous session |
| `-r, --resume [session]` | Resume a session (by ID prefix, path, or picker if omitted) |
| `--session [session]` | Alternate spelling of `--resume` |
| `--fork <id\|path>` | Start a new session forked from an existing session (id prefix or path); the fork is created in the current cwd/session dir |
| `--from-claude` | Import a Claude Code session into OMP |
| `--from-codex` | Import a Codex session into OMP |
| `--session-dir <dir>` | Directory for session storage and lookup |
| `--no-session` | Don't save session (ephemeral) |
| `--export <file>` | Export session file to HTML and exit |
| `--cwd <dir>` | Directory to start in (overrides the launch cwd) |
| `--add-dir <dir>` | Add a workspace directory beyond the working directory (repeatable) |
| `--allow-home` | Allow starting in ~ without auto-switching to a temp dir |
| `--profile <name>` | Use an isolated profile for auth, sessions, settings, and caches |
| `--alias <command>` | Create a shell shortcut for the selected profile and exit |

### Output and approval

| Flag | Description |
| --- | --- |
| `-p, --print` | Non-interactive mode: process prompt and exit |
| `--print-thoughts` | Include thinking blocks in print mode text output |
| `--mode <mode>` | Output mode: text (default), json, rpc, or rpc-ui |
| `--no-title` | Disable title auto-generation |
| `--auto-approve`, `--yolo` | Auto-approve all tool calls (skip approval prompts) |
| `--approval-mode <mode>` | Override `tools.approvalMode` for this session (`always-ask`, `write`, or `yolo`) |

### Tools, extensions, and configuration

| Flag | Description |
| --- | --- |
| `--tools <list>` | Comma-separated list of tools to enable (default: all). Unknown names are a hard error |
| `--no-tools` | Disable all built-in tools |
| `--no-lsp` | Disable LSP tools, formatting, and diagnostics |
| `--no-pty` | Disable PTY-based interactive bash execution |
| `-e, --extension <file>` | Load an extension file (can be used multiple times) |
| `--hook <file>` | Load a hook/extension file (can be used multiple times) |
| `--no-extensions` | Disable extension discovery (explicit `-e` paths still work) |
| `--skills <patterns>` | Comma-separated glob patterns to filter skills (e.g., `git-*,docker`) |
| `--no-skills` | Disable skills discovery and loading |
| `--no-rules` | Disable rules discovery and loading |
| `--plugin-dir <path>` | Load plugin from directory (repeatable) |
| `--config <file>` | Load an extra config.yml-style overlay for this run (repeatable) |

### Utility

| Flag | Description |
| --- | --- |
| `-h, --help` | Print help |
| `-v, --version` | Print version |
| `--` | End option parsing; everything after is literal prompt text |

## Subcommands

Aliases are listed where registered. Commands marked "interactive" require a terminal.

### acp

Run Oh My Pi as an ACP (Agent Client Protocol) server over stdio. Equivalent to launching with `--mode acp`; accepts the global launch flags.

```bash
omp acp
```

### agents

Manage bundled task agents.

```bash
omp agents unpack                # export bundled agents into user config (default)
omp agents unpack --project      # export into project config (./.omp/agents)
omp agents unpack --dir ./tmp/agents --json
```

Positional: `action` — currently only `unpack`.

| Flag | Description |
| --- | --- |
| `-f, --force` | Overwrite existing agent files |
| `--json` | Output JSON |
| `--dir <dir>` | Output directory (overrides `--user`/`--project`) |
| `--user` | Write to ~/.omp/agent/agents (default) |
| `--project` | Write to ./.omp/agents |

### auth-broker

Manage the omp auth-broker (credential vault).

```bash
omp auth-broker serve                          # boot the broker against the local SQLite store
omp auth-broker token --regenerate             # rotate the bearer token
omp auth-broker login anthropic                # local login (run on the broker host)
omp auth-broker login anthropic --via=user@broker   # remote login over SSH tunnel
omp auth-broker migrate --from-local --include-env --dry-run
```

Positionals: `action` — one of `serve`, `token`, `login`, `logout`, `import`, `migrate`, `status`, `list`; `source` — OAuth provider id (login/logout) or path (import).

| Flag | Description |
| --- | --- |
| `--json` | Output JSON |
| `-b, --bind <host:port>` | Bind address for `serve` (host:port) |
| `--regenerate` | Regenerate the bearer token |
| `--via <user@host>` | SSH user@host for remote login (login --via=user@host) |
| `--provider <id>` | Override provider id for `import` (e.g. when JSON `type` is unrecognized) |
| `--include-disabled` | Import credentials whose JSON has `disabled: true` (import) |
| `--from-local` | migrate source: local SQLite + env vars (required for `migrate`) |
| `--include-env` | Capture env-var API keys for providers not yet on broker (migrate) |
| `--include-oauth` | Also upload OAuth from local SQLite during migrate (default skips them) |
| `--dry-run` | Print actions without executing (import / login --via / migrate) |

### auth-gateway

Run an auth-gateway forward proxy backed by the configured broker.

```bash
omp auth-gateway serve                    # boot the gateway against the configured broker
omp auth-gateway token                    # print the gateway bearer token (creates one on first run)
omp auth-gateway check --strict           # also ping each credential's provider
```

Positional: `action` — one of `serve`, `token`, `status`, `check`.

| Flag | Description |
| --- | --- |
| `--json` | Output JSON (token/status/check) |
| `-b, --bind <host:port>` | Bind address for `serve` (host:port) |
| `--regenerate` | Regenerate the gateway bearer token (token) |
| `--no-auth` | Disable inbound bearer-token auth (serve). Useful when bound to loopback — any caller is allowed |
| `--strict` | For `check`: additionally probe each credential against its provider's chat-completion endpoint. Slower; consumes a tiny amount of quota per credential |

### bench

Benchmark models with the same prompt: time-to-first-token and generation throughput (tokens/s).

```bash
omp bench opus sonnet        # fuzzy selectors work
omp bench opus gpt-5.2 --runs 3
omp bench openai/gpt-5.6 --cache --json
```

Positional: `models` (required, repeatable) — model selectors (provider/model or fuzzy id, e.g. opus).

| Flag | Description |
| --- | --- |
| `--runs <n>` | Requests per model (results are averaged; default: 10) |
| `--max-tokens <n>` | Max output tokens per request (default: 512; cache mode: 64) |
| `--prompt <text>` | Custom prompt text (default: bundled bench prompt) |
| `--service-tier <tier>` | Service tier applied per model family (default: configured `tier.*` settings; `none` omits it) |
| `--json` | Output JSON |
| `--par <n>` | Execute runs with N parallel queries/requests (default: 4) |
| `--cache` | Run independent cold/warm prompt-cache pairs (not supported for openai-codex-responses) |
| `--cache-prefix-file <file>` | Stable prompt prefix file for --cache |
| `--cache-prefix-bytes <n>` | Stable prefix byte budget for --cache (default: 8192) |
| `--cache-pairs <n>` | Cold/warm pairs per model for --cache (default: 1) |
| `--cache-concurrency <n>` | Concurrent cache pairs for --cache; each pair remains sequential (default: 1) |

### browser-relay

Run the local CDP relay that lets the browser tool drive your own Chrome tabs, or install its companion Chrome extension.

```bash
omp browser-relay install              # write the Chrome extension to ~/.omp/browser-relay/extension
omp browser-relay                      # serve the relay on the default port
omp browser-relay -p 9333 --token s3cret
```

`install` writes the MV3 extension files (manifest, background worker, options page) to `~/.omp/browser-relay/extension` (or `--dir`) and prints the Chrome setup steps: enable Developer mode in `chrome://extensions`, load the folder as an unpacked extension, and run `omp config set browser.relay true`. `serve` (the default action) starts the relay on `http://127.0.0.1:<port>` with the extension endpoint `ws://127.0.0.1:<port>/ext` and waits for the extension to connect. omp starts the relay automatically when the browser tool needs it, so running `serve` manually is only needed for `--token` or `--no-group`. See [Browser & App Automation](/oh-my-pi/features/browser/).

Positional: `action` — `serve` or `install` (default `serve`).

| Flag | Description |
| --- | --- |
| `-p, --port <port>` | Port to listen on (default: 9224) |
| `--token <token>` | Require the extension to present this token |
| `--dir <dir>` | Extension install directory (install; default `~/.omp/browser-relay/extension`) |
| `--no-group` | Don't gather controllable tabs into an 'omp' tab group |
| `-v, --verbose` | Log relay traffic summaries to stderr |

### cleanse

Detect and fix project diagnostics with weighted parallel subagents.

```bash
omp cleanse
omp cleanse -n 4 -m opus
omp cleanse -t
```

| Flag | Description |
| --- | --- |
| `-n, --agents <n>` | Maximum number of file-disjoint subagents (default: 8) |
| `-m, --model <model>` | Subagent model selector (default: `@smol`) |
| `-t, --tests` | Also run configured project test suites |

### commit

Generate a commit message and update changelogs.

```bash
omp commit
omp commit --dry-run
omp commit --push
```

| Flag | Description |
| --- | --- |
| `--push` | Push after committing |
| `--dry-run` | Preview without committing |
| `--no-changelog` | Skip changelog updates |
| `--legacy` | Use legacy deterministic pipeline |
| `-c, --context <text>` | Additional context for the model |
| `-m, --model <model>` | Override model selection |

### completions

Print a shell completion script (bash, zsh, or fish). The script is generated from the live command/flag metadata, so it never drifts from the actual CLI surface.

```bash
eval "$(omp completions zsh)"     # zsh
eval "$(omp completions bash)"    # bash
omp completions fish > ~/.config/fish/completions/omp.fish
```

Positional: `shell` (required) — one of `bash`, `zsh`, `fish`.

### config

Manage configuration settings.

```bash
omp config                 # list settings (default action)
omp config get <key>
omp config set <key> <value>
```

Positionals: `action` — one of `list`, `get`, `set`, `reset`, `path`, `init-xdg` (default `list`); `key` — setting key; `value` — value (for set/reset).

| Flag | Description |
| --- | --- |
| `--json` | Output JSON |

### dry-balance

Dry-run OAuth account balancing across random session ids.

```bash
omp dry-balance            # dry-run the configured default model with 100 random session ids
omp dry-balance --model openai-codex/gpt-5-codex --count 1000
omp dry-balance --bench    # send one live benchmark request per OAuth account
```

Positional: `model` — model selector (provider/model or fuzzy id). Defaults to the configured default model.

| Flag | Description |
| --- | --- |
| `--model <model>` | Model selector (same syntax as --model on omp) |
| `--count <n>` | Number of random session ids to try (default: 100) |
| `--concurrency <n>` | Maximum concurrent credential resolutions (default: 32) |
| `--json` | Output JSON |
| `--bench` | Send one live benchmark request per OAuth account |

### gallery

Preview tool renderers across streaming, in-progress, success, and failure states.

```bash
omp gallery
omp gallery --tool edit --state success
omp gallery --screenshot --out render.png
```

| Flag | Description |
| --- | --- |
| `-t, --tool <name>` | Render a single tool by name |
| `-s, --state <state>` | Render only the given lifecycle state(s) (repeatable) |
| `-w, --width <cols>` | Render width in columns |
| `-e, --expanded` | Render the expanded variant of each renderer |
| `--plain` | Strip ANSI styling from the output |
| `--screenshot` | Capture the rendered output as PNG screenshot(s) via VHS instead of printing ANSI (requires vhs) |
| `-o, --out <path>` | Screenshot output path (with --screenshot); suffixed per image when split across multiple |
| `--font <family>` | Screenshot font family (default: JetBrainsMono Nerd Font) |
| `--font-size <pt>` | Screenshot font size in points (default: 18) |

### gc

Run storage garbage collection. Dry-runs by default; pass `--apply` to change anything.

```bash
omp gc                     # dry-run
omp gc --apply --archive --blobs
```

| Flag | Description |
| --- | --- |
| `--apply` | Apply changes (default is dry-run) |
| `--json` | Output JSON |
| `--agent-dir <dir>` | Agent directory to maintain |
| `--blobs` | Sweep unreferenced blobs |
| `--archive` | Archive cold sessions |
| `--wal` | Checkpoint history/model database WAL files |
| `--cold-archive-after-days <n>` | Minimum session age before archiving |
| `--retain-newest-global <n>` | Always keep this many newest sessions active |
| `--retain-newest-per-cwd <n>` | Always keep this many newest sessions per cwd active |

### grep

Test grep tool.

```bash
omp grep "TODO" src/
omp grep "foo" --glob "*.ts" --count
```

Positionals: `pattern` — regex pattern to search for; `path` — directory or file to search (defaults to `.`).

| Flag | Description |
| --- | --- |
| `-g, --glob <pattern>` | Filter files by glob pattern |
| `-l, --limit <n>` | Max matches (default: 20) |
| `-C, --context <n>` | Context lines (default: 2) |
| `-f, --files` | Output file names only |
| `-c, --count` | Output match counts per file |
| `--no-gitignore` | Include files excluded by .gitignore |

### grievances

View, clean, or push reported tool issues (auto-QA grievances).

```bash
omp grievances                   # list recent issues
omp grievances list --tool find
omp grievances clean --id 209
omp grievances push
```

Positional: `action` — `list` (default), `clean`, or `push`.

| Flag | Description |
| --- | --- |
| `-n, --limit <n>` | Number of recent issues to show (list) (default: 20) |
| `-t, --tool <name>` | Filter by tool name (list, clean) |
| `-j, --json` | Output as JSON |
| `--id <n>` | Delete a single grievance by id (clean) |
| `--all` | Delete every grievance (clean) |

### install

Install or link an extension package (alias of `plugin install`/`plugin link`). Local paths are linked; npm specs and marketplace refs are installed.

```bash
omp install ./my-ext
omp install my-pkg@1.2.3 name@marketplace
```

Positional: `targets` (repeatable) — local path, npm spec, or marketplace ref (e.g. ./my-ext, my-pkg@1.2.3, name@marketplace).

| Flag | Description |
| --- | --- |
| `--json` | Output JSON |
| `--force` | Force install |
| `--dry-run` | Show actions without applying changes |
| `--scope <scope>` | Install scope: "user" (default) or "project" (marketplace installs only) |

### join

Join a shared collab session (same as `/join`). Launches the interactive TUI and immediately joins; requires an interactive terminal.

```bash
omp join "relay.example.sh/abc123#key"
```

Positional: `link` (required) — collab link shared by the host (`/collab`).

### models

List, search, and refresh available models.

```bash
omp models                       # list every available model, grouped by provider
omp models openai-codex          # list one provider's models
omp models find minimax          # find models by substring
omp models refresh               # force a fresh catalog fetch
```

Positionals: `action` — `ls` (default), `find`, `refresh`, or a provider name; `pattern` — filter/search substring, or provider name (required for find).

| Flag | Description |
| --- | --- |
| `--json` | Output JSON |
| `-e, --extension <file>` | Load an extension file before listing (repeatable) |
| `--no-extensions` | Disable extension discovery (explicit -e paths still work) |
| `--config <file>` | Load an extra config.yml-style overlay for this run (repeatable) |

### plugin

Manage plugins (install, uninstall, list, etc.).

```bash
omp plugin list
omp plugin install name@marketplace
omp plugin marketplace add <source>
omp plugin doctor --fix
```

Positionals: `action` — one of `install`, `uninstall`, `list`, `link`, `doctor`, `features`, `config`, `enable`, `disable`, `marketplace`, `discover`, `upgrade` (default `list`); `targets` — packages, paths, or plugin names.

| Flag | Description |
| --- | --- |
| `--json` | Output JSON |
| `--fix` | Attempt to fix issues (doctor) |
| `--force` | Force install |
| `--dry-run` | Show actions without applying changes |
| `-l, --local` | Operate on local plugin directory |
| `--enable <feature>` | Enable a feature |
| `--disable <feature>` | Disable a feature |
| `--set <key=value>` | Set plugin config (key=value) |
| `--scope <scope>` | Install scope: "user" (default) or "project" |

### read

Show what the read tool will return for a path, URL, or internal URI.

```bash
omp read src/foo.ts:50-100
omp read https://example.com
omp read issue://123
```

Positional: `path` (required) — path, URL, or internal URI to read (append `:sel` for line ranges or raw mode, e.g. `src/foo.ts:50-100`).

### say

Synthesize text with the local TTS engine and play it through the speakers.

```bash
omp say "hello world"
omp say --file notes.md --voice bm_fable
omp say "hello world" --out /tmp/hello.wav
```

Positional: `text` — text to speak (or use `--file`). Pass either text or `--file`, not both.

| Flag | Description |
| --- | --- |
| `--voice <id>` | Voice id |
| `--model <key>` | Local TTS model key |
| `-f, --file <path>` | Read the text to speak from this file |
| `-o, --out <path>` | Write WAV to this path instead of playing |

### setup

Run onboarding setup or install dependencies for optional features. With no component, runs the interactive onboarding wizard (requires a TTY).

```bash
omp setup                # onboarding wizard
omp setup python         # install the python tool's dependencies
omp setup speech --check
```

Positional: `component` — one of `python`, `speech`.

| Flag | Description |
| --- | --- |
| `-c, --check` | Check if dependencies are installed |
| `--json` | Output status as JSON |

### shell

Interactive shell console.

```bash
omp shell
omp shell -C /tmp --timeout 5000
```

| Flag | Description |
| --- | --- |
| `-C, --cwd <dir>` | Set working directory for commands |
| `-t, --timeout <ms>` | Timeout per command in milliseconds |
| `--no-snapshot` | Skip sourcing snapshot from user shell |

### ssh

Manage SSH host configurations.

```bash
omp ssh list
omp ssh add myhost --host 192.0.2.10 --user ubuntu
omp ssh remove myhost
```

Positionals: `action` — one of `add`, `remove`, `list` (default `list`); `targets` — host name or arguments.

| Flag | Description |
| --- | --- |
| `--json` | Output JSON |
| `--host <host>` | Host address |
| `--user <user>` | Username |
| `--port <port>` | Port number |
| `--key <path>` | Identity key path |
| `--desc <text>` | Host description |
| `--compat` | Enable compatibility mode |
| `--scope <scope>` | Config scope (`project` or `user`) |

### stats

View usage statistics.

```bash
omp stats              # launch the dashboard
omp stats --summary    # print summary to console
omp stats --json
```

| Flag | Description |
| --- | --- |
| `-p, --port <port>` | Port for the dashboard server (default: 3847) |
| `-j, --json` | Output stats as JSON |
| `-s, --summary` | Print summary to console |

### tiny-models

Download tiny local models (session titles + memory).

```bash
omp tiny-models download
omp tiny-models list
```

Positionals: `action` — one of `download`, `list` (default `download`); `model` — model key, or `all`.

| Flag | Description |
| --- | --- |
| `--json` | Output JSON |

### token

Get the API key or OAuth token for a provider.

```bash
omp token anthropic
omp token anthropic --list       # list the provider's OAuth accounts
omp token anthropic --account 2
omp token google-gemini-cli --force-refresh
```

Positional: `provider` (required) — provider ID (e.g. anthropic, openai).

| Flag | Description |
| --- | --- |
| `--raw` | Output the raw credential value without parsing nested JSON structures |
| `--force-refresh` | Force refresh the OAuth token even if it has not expired |
| `-a, --account <n>` | Select the Nth OAuth account (1-based) in stored order instead of the round-robin default |
| `-l, --list` | List the provider's OAuth accounts (index + identity) and exit |

### ttsr

Inspect and test Time-Traveling Stream Rules (TTSR).

```bash
omp ttsr list
omp ttsr test 'const x: any = 1'
omp ttsr test --file src/foo.ts --source text
echo 'Box::leak(&mut v)' | omp ttsr test --file - --path src/lib.rs
omp ttsr scan src/
```

Positionals: `action` — one of `test`, `list`, `scan` (default `list`); `snippet` — inline snippet text to test (ttsr test) or directory to scan (ttsr scan). A positional that resolves to an existing file is treated as a snippet file, so `omp ttsr test src/foo.ts` works without `--file`.

| Flag | Description |
| --- | --- |
| `--file <path>` | Snippet file path, or - for stdin (ttsr test) |
| `-r, --rule <file>` | Rule markdown file to test in isolation (skips project rule loading) |
| `--source <source>` | Match source: `text`, `thinking`, or `tool` (inferred from --file when omitted) |
| `--tool <name>` | Tool name when source is tool (e.g. edit, write); defaults to edit |
| `-p, --path <path>` | Candidate file path for scope/glob matching and AST language inference |
| `-v, --verbose` | Show every evaluated rule, not just triggered ones |
| `--json` | Output JSON |
| `--no-gitignore` | Include files excluded by .gitignore (ttsr scan) |
| `--max-bytes <n>` | Maximum file size to scan in bytes; 0 disables the limit (ttsr scan) |

### update

Check for and install updates.

```bash
omp update
omp update --check
omp update --plugins     # update installed plugins
```

| Flag | Description |
| --- | --- |
| `-f, --force` | Force update |
| `-c, --check` | Check for updates without installing |
| `-l, --plugins` | Update installed plugins |

If GitHub rate-limits release metadata, set `GITHUB_TOKEN` or `GH_TOKEN`.

### usage

Show provider usage limits for every authenticated account.

```bash
omp usage                          # per-account breakdown across all providers
omp usage --provider anthropic
omp usage --history --days 30
omp usage invalidate               # drop cached usage reports
```

Positional: `action` — `invalidate` clears cached usage reports.

| Flag | Description |
| --- | --- |
| `-j, --json` | Output usage reports as JSON |
| `-p, --provider <id>` | Only show usage for this provider id (e.g. anthropic) |
| `-r, --redact` | Redact account emails/ids (shortest unique prefix) for sharing screenshots |
| `--history` | Show recorded usage-limit history (hourly snapshots) instead of a live snapshot |
| `-d, --days <n>` | History window in days (with --history) (default: 7) |

### search

Aliases: `q`

Test web search providers.

```bash
omp search "oh my pi"
omp q "release notes" --recency week --limit 5
```

Positional: `query` (repeatable) — search query text.

| Flag | Description |
| --- | --- |
| `--provider <id>` | Search provider: `auto` or a built-in provider id |
| `--recency <window>` | Recency filter: `day`, `week`, `month`, or `year` |
| `-l, --limit <n>` | Max results to return |
| `--compact` | Render condensed output |

### worktree

Aliases: `wt`

List or clear agent-managed git worktrees (~/.omp/wt).

```bash
omp worktree                 # list
omp wt clear --dry-run
omp worktree clear --all
```

Positional: `action` — `list` (default) or `clear`.

| Flag | Description |
| --- | --- |
| `--all` | Clear every entry, including live PR-checkout worktrees (clear) |
| `-n, --dry-run` | Print what would be removed without touching the filesystem (clear) |
| `-j, --json` | Emit machine-readable JSON |

## Sharp edges

:::caution
Plugin and marketplace verbs are not top-level commands. `omp list`, `omp uninstall <name>`, `omp marketplace add <src>`, `omp discover`, `omp enable`, and similar read like management commands, but without the `plugin` prefix the argv is forwarded to the agent as a prompt. omp prints a hint for the obvious cases (`omp marketplace` alone, `omp uninstall foo@bar`), yet a phrase like `omp list all my files` is treated as a prompt by design. Use `omp plugin <action>` and `omp plugin marketplace <add|remove|update|list>` for management.
:::

:::note
Unknown flags are a hard error, not a silent prompt. After extensions load, any `--flag` that matched neither a built-in nor an extension-registered flag aborts with `Error: unknown flag: …` instead of starting a session with the typo as a prompt.
:::
