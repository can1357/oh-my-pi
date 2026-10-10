# CLI reference

`omp` is invoked as:

```sh
omp [command] [flags] [messages...]
```

When the first positional argument is **not** a registered subcommand, `omp`
normally routes to the default [`launch`](#launch-the-default-command) command.
So `omp "fix the build"` launches a session with that message, while `omp models`
runs the `models` subcommand. Bare plugin-management words such as `marketplace`,
`uninstall`, or `extensions` instead produce a hint to use `omp plugin …`;
use `omp launch <word>` when such a word is the intended prompt.

A recognized subcommand can follow leading launch flags. Those flags are
forwarded to `launch` and `acp`, but recognized launch-only flags before other
subcommands are stripped, not applied (for example, `omp --cwd dir update`).

`--profile` is applied before subcommand routing, so it also scopes commands
such as `config`, `models`, and `update`.

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
- Outside protocol modes, non-TTY stdin is read to EOF automatically as prompt
  text; do not add a `-` marker. Piped input or a non-TTY stdin selects print mode
  when `--mode` is omitted. Without stdin text, an argv prompt or attachment is
  required.
- Stdin text, text attachments, and the first positional message are combined
  into the initial prompt; remaining positional messages are sent as later turns.
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
| `--alias <name>` | Create a shell shortcut for a named profile and exit; requires `--profile` or `OMP_PROFILE`. |
| `--config <file>` | Load an extra `config.yml`-style overlay for this run (repeatable). |
| `--session-dir <dir>` | Directory for session storage and lookup. |
| `--no-session` | Don't save the session (ephemeral). |

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

`--continue`, `--resume`, `--fork`, and foreign-session imports require
persistence and cannot use `--no-session`. `--from-claude` and `--from-codex`
are mutually exclusive and cannot be combined with `--continue`, `--resume`,
or `--fork`.

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
| `--service-tier <tier>` | OpenAI service tier: `none`, `auto`, `default`, `flex`, `scale`, `priority`, or `ultrafast` (`none` omits `service_tier`). |

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
| `--prewalk` | Arm a one-shot handoff at the first eligible edit/write turn, gated on a successful todo call when `todo` is active (default off). See [prewalk](./prewalk.md). |
| `--no-prewalk` | Disable prewalk even if `prewalk.enabled` is set; incompatible with `--prewalk`/`--prewalk-into`. |
| `--prewalk-into <id-or-role>` | Arm prewalk with this target instead of the `smol` role. |
| `--plan-yolo` | Start in read-only plan mode, auto-approve the model's plan proposal, then switch to the execution target to implement it. |
| `--plan-yolo-into <id-or-role>` | Target model for plan-yolo execution (default the `smol` role); requires `--plan-yolo`. |
| `--goal <objective>` | Start a fresh interactive session in goal mode and begin working on the objective, without typing `/goal`. Requires `goal.enabled`; interactive only. Bypasses `autoResume`, and is rejected with a positional prompt, `@file` or stdin input, `--resume`/`--continue`/`--fork`/imports, `--plan-yolo`, `--no-tools`, or startup plan mode (`plan.defaultOnStartup`). |

#### Tools, approvals, and runtime

| Flag | Description |
| --- | --- |
| `--tools <a,b,c>` | Comma-separated list of tools to enable (default: all). |
| `--no-tools` | Disable all built-in tools. |
| `--no-lsp` | Disable LSP tools, formatting, and diagnostics. |
| `--no-pty` | Disable PTY-based interactive bash execution. |
| `--approval-mode <mode>` | Override `tools.approvalMode` for this session (`always-ask`, `write`, or `yolo`). See [approval mode](./approval-mode.md). |
| `--auto-approve`, `--yolo` | Force yolo tier approval; explicit tool/user policies and provider safety checks still apply. |
| `--advisor` | Enable the advisor runtime (passively reviews each turn and injects notes). See [advisor / watchdog](./advisor-watchdog.md). |
| `--max-time <duration>` | Stop the session after this duration (e.g. `600`, `10m`, `1h`). |

#### Extensions, hooks, skills, and rules

| Flag | Description |
| --- | --- |
| `--extension <path>`, `-e <path>` | Load an extension (repeatable). See [extensions](./extensions.md). |
| `--hook <path>` | Load a hook/extension file (repeatable). See [hooks](./hooks.md). |
| `--trusted-extension <abs-path>` | Exact allowlist of existing absolute module files (repeatable); disables ambient extension discovery and package-root sub-discovery. Cannot be combined with `--extension`/`-e`/`--hook`. |
| `--plugin-dir <dir>` | Add a local plugin directory to discovery (repeatable). |
| `--no-extensions` | Disable extension discovery (explicit `-e` paths still work). |
| `--skills <globs>` | Comma-separated glob patterns to filter [skills](./skills.md) (e.g. `git-*,docker`). |
| `--no-skills` | Disable skills discovery and loading. |
| `--no-rules` | Disable rules discovery and loading. See [context files](./context-files.md). |

#### System prompt

| Flag | Description |
| --- | --- |
| `--system-prompt <text\|file>` | Plain-text system prompt override (default: coding assistant prompt). See [system prompt customization](./system-prompt-customization.md). |
| `--system-prompt-template <path>` | Strictly read `<path>` as a Handlebars system-prompt template; mutually exclusive with `--system-prompt`. See [system prompt customization](./system-prompt-customization.md). |
| `--append-system-prompt <text\|file>` | Append plain text or file contents to the system prompt. |

#### Output mode

| Flag | Description |
| --- | --- |
| `--mode <mode>` | Output/transport mode: `text` (default), `json`, `rpc`, `acp`, `rpc-ui`, or `host`. See [output modes](#output-modes---mode). |
| `--host-id <16 hex>` | Session host id for `--mode host`: 16 lowercase hex digits. Internal; passed by the tools that spawn hosts. |
| `--print`, `-p` | Process prompts non-interactively and exit. |
| `--no-ui` | With `rpc`/`rpc-ui`, make extensions headless without disabling rpc-ui tool UI. |

#### Information

| Flag | Description |
| --- | --- |
| `--help`, `-h` | Show help for `omp` or a subcommand and exit. |
| `--version`, `-v` | Print the installed version and exit. |

### Headless / print mode

`--print` / `-p` runs `omp` non-interactively: it processes the prompts, writes
the last assistant response to stdout, and exits without entering the TUI. Text
output is emitted after the turn completes, not token-by-token; a `Working...`
indicator goes to stderr. This is the entry point for scripting and automation.

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

`--mode json` emits a session header followed by events as JSON lines.
Incremental `message_update` events omit full partial-message snapshots; completed
messages arrive in `message_end`, and opaque provider replay payloads are omitted.
Terminal turn failures produce a nonzero exit status in both text and JSON modes.

`plan.defaultOnStartup` is ignored in print mode because there is no plan-review
UI. Use `--plan-yolo` for unattended planning and implementation.

The [advisor / watchdog](./advisor-watchdog.md#headless-runs) doc describes
print-mode disposal semantics when the advisor runtime is enabled.

### Output modes (`--mode`)

| Mode | Description |
| --- | --- |
| `text` | Rendered text. Omitting `--mode` allows the TUI; explicit `--mode text` selects non-interactive text output. |
| `json` | Newline-delimited JSON event stream for headless/machine consumption; `-p` is optional. |
| `rpc` | Line-delimited JSON command/response/event transport over stdio (not JSON-RPC 2.0). See [RPC](./rpc.md). |
| `rpc-ui` | RPC transport with UI extension events enabled. |
| `acp` | Agent Client Protocol server over stdio. Equivalent to the [`acp`](#subcommands) subcommand; see [approval mode → ACP sessions](./approval-mode.md#acp-sessions). |
| `host` | Long-lived session host serving local clients over a Unix socket (a named pipe on Windows); requires `--host-id`. See [RPC → session hosts](./rpc.md#session-hosts). |

`--no-ui` (with `--mode rpc` or `--mode rpc-ui`) runs extensions headless: `ctx.hasUI` is `false`, extension dialogs resolve to defaults, and extension presentation updates are dropped. In `rpc-ui`, tool UI such as `ask` still sends `extension_ui_request` frames for the host to answer. Host-issued `login` UI is unaffected. See [RPC startup](./rpc.md#startup).

### Hosted sessions (experimental)

Normally an interactive session runs inside the terminal's own process. With hosted sessions, the session runs in a detached [session host](./rpc.md#session-hosts) (`omp --mode host`) and the terminal is a client that renders it. Closing the terminal does not stop the session: attach again from the same or another terminal, and attach several terminals to one session at once. The feature is opt-in and off by default. Print mode, JSON mode, RPC, ACP, host mode, and `omp join` never use it, and neither does an interactive launch whose stdin or stdout is not a terminal.

| Setting | Environment variable | Default |
| --- | --- | --- |
| `tui.hosted` | `OMP_TUI_HOSTED` | `false` |

```sh
# One launch
OMP_TUI_HOSTED=1 omp

# Every interactive launch
omp config set tui.hosted true
```

#### Starting and attaching

- **Plain `omp` with the setting on.** The session is chosen exactly as without it (`--resume`, `--continue`, the bare `--resume` picker, `autoResume`, `--session-dir`, or a new session). The terminal then attaches to the host that owns that session, or starts one. A new session starts a host without `--resume`. With `--no-session`, the host runs an in-memory session and no saved session is leased. The initial prompt and `@file` attachments are read by the terminal and sent to the host as the first prompt.
- **Host options.** Launch flags that configure a session (model, provider, tools, extensions, configuration) go to a newly started host and are never applied to the terminal. Session-source flags, positional prompts, `@file` arguments, and `--cwd` are not passed on: the terminal resolves the session and the directory first. A host that already runs the chosen session cannot change its options, so a launch with host options is refused instead of silently dropping them; attach by host ID without them. A host that `/attach` starts receives the same options as this terminal's own launch.
- **Unsupported flags.** `--fork`, `--from-claude`, `--from-codex`, `--goal`, and flags registered only by extensions fail with a usage error. Extensions load in the host, not in the terminal; goal mode runs only in an unhosted terminal (`/goal` is unavailable when attached).
- **`omp attach`** with no target lists running hosts; `--json` prints them for scripts without their tokens.
- **`omp attach <target>`** opens the hosted terminal. The target is a host ID (16 lowercase hex digits), a session ID, or a session path (a value containing a path separator or ending in `.jsonl`; relative paths resolve against the current directory, and the file must be a session file). A 16-digit hex value that matches no running host is looked up as a session ID. A session ID matches by case-insensitive prefix: the start of the session ID, of the session file name, or of the ID after the last `_` in the file name. A prefix that matches several sessions selects the first one found, so give a longer prefix when in doubt. The lookup searches the current project's session directory first and then every saved session; inside a terminal launched with `--session-dir`, `/attach` searches only that directory. When no host runs the session, one is started; when another process that is not a host has the session open, attach fails and names that cause. A target that matches nothing fails with `No session host or session matches "<target>"`. Attach requires an interactive terminal (otherwise it exits with status 1) and takes no launch flags, so a host it starts has no launch options. `--json` and a target cannot be combined.

#### Working directory

The terminal keeps the directory it was launched in and uses it only locally: it resolves `@file` arguments and appears in the footer with its git state. Tools, shell commands, and edits run in the host's directory, which `omp attach` lists. A host started by the launch runs in the resolved launch directory, and stays there unless `/move` or `/wt` moves the host's session to another directory. Attaching never moves the host to the terminal's directory or the terminal to the host's.

Editor completion is local as well. `@` file suggestions list the terminal's directory, but an `@path` in a sent prompt is resolved by the host, in the host's directory, so the two differ when you attach from another directory. The slash-command menu offers the terminal's built-in commands only: it does not suggest the host's skills, prompt templates, or extension commands, which still work when typed.

Links in the host's replies follow the host, not the terminal. A Markdown link to a relative path opens that file in the host's directory, and a `local://` link opens the file in the host session's own `local://` directory (under its artifact directory, or in the host's temp directory when its session is in memory), so a report the host wrote can be opened from the terminal; none of it is copied here. The links follow the host's session when it is replaced (the transcript is redrawn) or moved (the replies on screen are re-linked in place, without a redraw; rows already in your terminal's scrollback keep the link they had), and the terminal's own temp directory is never consulted. The footer, completion, and `@file` above stay local. A host that does not report where its session lives (one started by an older build) is refused with an error telling you to stop it and attach again, instead of showing links that would open the wrong files. While no host is attached, its links are left as written.

#### Leaving and moving

| Command | Effect |
| --- | --- |
| `/detach` | Disconnect this terminal and exit; the host and its session keep running. Ctrl+C or Ctrl+D quitting, `SIGHUP`, and closing the terminal do the same. The terminal prints `omp attach <hostId>` (with `--profile` when one is active) for returning. |
| `/exit`, `/quit` | Ask the host to exit. The host stops, ending the session's process, only when this is its last attached client; otherwise this acts as `/detach` and the others keep working. |
| `/attach [host\|session]` | Move this terminal to another host, using the target forms above and starting a host for a session that has none. Without an argument, it opens a selector over the other running hosts. The target is resolved before the current connection is touched. If connecting fails, the terminal returns once to the previous host with a fresh snapshot, and exits with status 1 if that also fails. |

Outside a hosted terminal, `/detach` and `/attach` only report that they need a hosted session.

Unsent editor text is not saved when a hosted terminal detaches or exits, and attaching never restores a saved draft. In-process sessions still keep their Ctrl+D draft.

Each terminal keeps its own copy of the host's transcript for rendering, in `<config root>/run/hosted-replicas/` (directory mode `0700`, files `0600`). Copies are not sessions: `/resume` never lists them, and the terminal deletes its own when it leaves. A terminal that dies without running its exit path (`SIGKILL`, an out-of-memory kill, power loss) leaves its copy behind, and nothing removes it: the copies include the transcript and any images, so delete leftover files in that directory by hand.

#### Connection loss

The terminal does not reconnect automatically. When the connection ends unexpectedly (the host exits or is killed, the socket breaks, or a host update cannot be applied), the terminal prints what happened, including whether the host process is still running, and exits with status 1. Rejoin with `omp attach <hostId>`. A command whose outcome is unknown after a loss is never sent again on its own. `/detach` and `/exit` never reconnect. Automatic reconnect is a required follow-up before hosted sessions can become the default.

#### What works when attached

- Prompting, steering, follow-ups, and Esc to abort the host's run, including images. A prompt the host rejects, or that was written for a session that has since changed, returns to the editor and is not retried.
- The queue display of the host. The dequeue shortcut takes the newest queued message back into the editor only when it is text and nothing else: it restores the newest message with that text, and leaves the queue untouched when the message carries an attachment, when the host does not report attachments, or when the message was already delivered.
- Model and thinking changes: the model picker lists the host's models, and selecting one, cycling forward, and cycling thinking levels are changes to the host's session only. All attached terminals show the new setting.
- Extension dialogs (`select`, `confirm`, `input`, `editor`) and the `ask` dialog with its notes, images, and "discuss instead" choice. The first terminal to answer wins, and the others' dialogs close.
- Slash commands that have a headless handler run on the host, and their output appears as a status line. Extension commands, skill commands, and prompt templates are sent to the host as the text you typed. `/hotkeys`, `/copy`, `/open`, `/detach`, `/attach`, `/exit`, and `/quit` run in the terminal.
- Images pasted from the clipboard travel to the host as image data. A large text paste offers only the wrapped-block and inline choices, because a local file would sit on the terminal's side.
- Idle recap and idle compaction run once in the host, including while no terminal is attached. A nonempty editor draft in any attached terminal suppresses them; only its composing boolean travels to the host. All terminals receive the same recap.

#### Unavailable when attached

Commands and shortcuts below report that they are unavailable when attached, and typed input stays in the editor. Nothing runs locally or is silently forwarded in its place. The remaining terminal-owned automation and automatic titles are off.

| Area | Unavailable | Notes |
| --- | --- | --- |
| Modes | `/plan`, `/plan-review`, `/goal`, `/guided-goal`, `/loop`, `/vibe`, the plan-mode and live-mode shortcuts, the `.` and `c` continue shortcuts | Their state machines still live in the terminal and have not moved to the host. |
| Queue editing | `/queue` and the queue shorthand; taking back a queued message that carries an attachment | Follow-ups still queue with their shortcut. |
| Session changes | `/new`, `/clear`, `/delete`, `/fork`, `/branch`, `/tree`, `/resume`, `/restart`, and their shortcuts and selectors (session tree, rewind, session switching) | A session replacement that happens on the host, for example from a forwarded command, is followed by every attached terminal. |
| Local execution | `!` and `$` input, and PTY overlays | Commands would run on the terminal's machine, not the session's. |
| Retry | The retry shortcut and its hint row | The `/retry` command runs on the host. |
| Model controls | Cycling to the previous model, per-role model editing, a separate temporary-model picker | One picker applies a session-only change to the host. |
| Titles | Automatic title generation in the terminal | Titles set by the host, such as with `/rename`, appear in all terminals. |
| Settings and login | `/settings`, `/setup`, `/login`, `/logout`, and the setup wizard and splash at startup | The host uses its own configuration and credentials. |
| Panels | `/extensions`, `/agents`, `/hub`, `/git`, `/debug`, `/skills`, focusing a subagent, and the `/btw` side question | `/btw` waits for host ownership of its lifecycle. |
| Collaboration and capture | `/collab`, `/join`, `/leave`, `/live`, `/record`, `/pause`, `/tan`, `/omfg`, `/cleanse`, and collab auto-hosting | |
| Extension UI | Custom components (`custom()`), `setFooter`, `setHeader`, `setEditorComponent`, raw terminal input, component-factory widgets, and extension keyboard shortcuts | Extensions run in the host with the same UI limits as [RPC](./rpc.md#extension-ui-sub-protocol). Status, notifications, string-array widgets, titles, and editor text from the host are shown. A terminal that attaches later still gets the statuses and widgets showing at that moment; earlier notifications, titles, and editor text are not replayed. |
| Automation | Goal continuation, loop auto-submit, plan-mode model reconciliation, and automatic todo clearing | These terminal-owned paths have not moved to the host yet. Idle compaction and idle recap are host-owned. |

## Subcommands

Run `omp <command> --help` for each command's own flags and examples.

| Command | Purpose | See also |
| --- | --- | --- |
| `launch` | Start a coding session (the default command). | [Launch flags](#launch-flags) |
| `acp` | Run omp as an ACP (Agent Client Protocol) server over stdio. | [approval mode](./approval-mode.md#acp-sessions) |
| `attach` | List running session hosts (`--json` for scripts), or attach this terminal to one by host ID, session ID, or session path. | [Hosted sessions](#hosted-sessions-experimental), [RPC → session hosts](./rpc.md#session-hosts) |
| `auth-broker` | Manage the omp auth-broker (credential vault). | [auth broker / gateway](./auth-broker-gateway.md) |
| `auth-gateway` | Run an auth-gateway: an HTTP forward proxy backed by the configured broker (`serve`), or JSON lines on stdin/stdout for a parent process with your own credentials (`stdio`). | [auth broker / gateway](./auth-broker-gateway.md) |
| `agents` | Manage bundled task agents. | [task agent discovery](./task-agent-discovery.md) |
| `bench` | Benchmark models: TTFT/prefill vs decode throughput with p50/p95 across chat, prefill, generation, and prompt-cache workloads, rendered in a live dashboard (`--prefill-bytes` sizes the synthetic prefill input). `--detailed` runs single-user, `--par`-way parallel (aggregate tok/s and scaling), and prefill phases per model. | |
| `browser-relay` | Run the local CDP relay used by Eval's browser API to drive your own Chrome tabs. | [computer use](./computer-use.md) |
| `cleanse` | Detect and fix project diagnostics with weighted parallel subagents. | |
| `collab` | List active local Collab hosts without exposing URLs; `collab link <instanceId\|pid>` retrieves a control link (`--view` for view-only). | [collab](./collab.md) |
| `clip` | Upload a `/record` recording to live.omp.sh as a public clip and print its URL. | |
| `commit` | Generate a commit message and update changelogs. | |
| `completions` | Print a shell completion script (bash, zsh, or fish). | |
| `compress` | Rewrite a text file into the dense prompt register, reporting what it drops. | |
| `config` | Manage configuration settings. | [config usage](./config-usage.md), [settings](./settings.md) |
| `dry-balance` | Dry-run OAuth account balancing across random session ids. | |
| `find` | Semantic search for implementing files and line ranges. | |
| `gc` | Run storage garbage collection. | |
| `grep` | Test the grep tool from the CLI. (The [`grep` tool](./tools/grep.md) is a separate agent tool.) | |
| `gallery` | Preview tool, composer, and status-line renderers in a deterministic gallery. | |
| `git` | Interactive fullscreen git UI: split diff viewer, staging sidebar, and commit composer. | |
| `grievances` | View, clean, or push reported tool issues (auto-QA grievances). | |
| `if-bench` | Benchmark instruction following and working memory: one cached thread of glyph array actions with a cat-sound directive that moves through the prompt. | |
| `images`, `img` | Inspect, diagnose, probe, and purge image publication backends. | |
| `install` | Install or link an extension package (alias of `plugin install` / `plugin link`). | [extensions](./extensions.md) |
| `join` | Join a shared collab session (same as `/join`). | [collab](./collab.md) |
| `login` | Log in to a model provider from the terminal (counterpart of `/login`). | |
| `models` | List, search, and refresh available models. | [models](./models.md) |
| `plugin`, `plugins` | Manage plugins (install, uninstall, list, etc.). | [extensions](./extensions.md), [marketplace](./marketplace.md) |
| `play` | Replay a `/record` recording in the terminal; Space pauses and `q` quits. | |
| `predict` | Compare word-completion engines' live ghost text for a prompt. | |
| `ps` | List and control daemon-supervised background processes (logs, stop, kill, restart). | |
| `say` | Synthesize text with the local TTS engine and play it through the speakers. | [tts tool](./tools/tts.md) |
| `share` | Share a saved session via an encrypted link (same as the `/share` slash command). | [session operations](./session-operations-export-share-fork-resume.md) |
| `setup` | Run onboarding setup or install dependencies for optional features. | |
| `shell` | Interactive shell console. | |
| `read` | Show what the read tool will return for a path, URL, or internal URI. (The [`read` tool](./tools/read.md) is a separate agent tool.) | |
| `render` | Draw a session's entire thread through the production transcript pipeline (with repaint timing). | |
| `skill`, `skills` | Install, search, publish, and manage skills on skills.omp.sh. | [skills](./skills.md) |
| `ssh` | Manage SSH host configurations. | |
| `stats` | View usage statistics. | |
| `stream` | Broadcast local OMP session screens and chat to a public live channel. | |
| `update` | Check for and install updates; `--canary`/`--stable` switch release channels. | |
| `usage` | Show provider usage limits for every authenticated account; `usage clients` breaks token burn down per client (with `--days`), `usage invalidate` drops cached reports, and `usage accounts` lists each OAuth account's provider and identity key (the key `task.agentAccountPools` and broker account pools take; no tokens, `--json` supported). | [Task agent discovery](./task-agent-discovery.md#model-and-structured-output-precedence) |
| `tiny-models` | Download tiny local models for session titles, memory, and word completion. | [local models](./local-models.md) |
| `token` | Get the API key or OAuth token for a provider. | [secrets](./secrets.md) |
| `toks` | Count file or text tokens with the embedded offline tokenizers. | |
| `ttsr` | Inspect and test Time-Traveling Stream Rules (TTSR). (Covers the CLI command; the [TTSR feature](./ttsr-injection-lifecycle.md) is documented separately.) | |
| `worktree`, `wt` | Add, list, or clear git worktrees; uses clone-first behavior when enabled. | |
| `search`, `q`, `web-search` | Test web search providers from the CLI. | [web_search tool](./tools/web_search.md) |

> `install`, `join`, `browser-relay`, `auth-gateway`, and `tiny-models` are also
> reachable through related mechanisms (the `plugin` command, the `/join` slash
> command, and so on). The table lists each as it is registered in
> `packages/coding-agent/src/cli-commands.ts`.

`__complete` is an internal, hidden subcommand used by shell completion scripts.
