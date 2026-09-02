---
title: Settings — Tools
description: Tool approval modes, the native computer tool, browser, MCP, GitHub, async jobs, and the bash / eval / LSP and file editing surface.
coverage: A
sidebar:
  label: Settings — Tools
  order: 2
---

Settings that govern which tools are available, when they run, and how they are approved. For the workflow and the layered config model, see [Settings](/oh-my-pi/configuration/settings/). For the exhaustive schema, run `omp config list`.

## Tools and approvals

| Key | Type | Default | Description |
|---|---|---|---|
| `tools.approvalMode` | enum | `yolo` | One of `always-ask` (auto-approve read-only), `write` (auto-approve read + workspace-write), `yolo` (auto-approve all tiers). `--approval-mode` and `--auto-approve`/`--yolo` override per run. |
| `tools.approval` | record | `{}` | Per-tool policy keyed by tool name; each value is `allow`, `deny`, or `prompt`. |
| `tools.maxTimeout` | number | `0` | Max tool runtime in seconds; `0` = no cap. |
| `tools.intentTracing` | boolean | `true` | Record per-call intent strings. |
| `tools.outputMaxColumns` | number | `768` | Per-line byte cap for streaming output; `0` disables. |
| `tools.artifactSpillThreshold` | number | `50` | KB of tool output above which output spills to an artifact. |
| `tools.artifactHeadBytes` | number | `20` | KB of head kept inline on spill; `0` = tail-only. |
| `tools.artifactTailBytes` | number | `20` | KB of tail kept inline on spill. |
| `tools.artifactTailLines` | number | `500` | Max tail lines kept inline on spill. |
| `tools.abortOnFabricatedResult` | boolean | `true` | With in-band tool calls, stop the model immediately when it starts hallucinating a tool result mid-turn. Disable to let the model finish generating and discard the fabricated continuation instead. |
| `tools.xdev` | boolean | `true` | Mount rarely-used (discoverable) tools under `xd://` device URLs driven via `read`/`write` instead of shipping their schemas on every request. Sessions without a granted write tool skip mounting and expose every tool top-level. Disable to expose every enabled tool top-level. See [Internal URLs](/oh-my-pi/guides/internal-urls/). |
| `tools.xdevDocs` | enum | `builtins` | One of `inline`, `builtins`, `catalog`. Which mounted-device docs and schemas are inlined in the system prompt: `inline` inlines every device, `builtins` keeps core tools inline while MCP and extension tools stay on-demand, `catalog` lists every device and fetches all docs on demand. |
| `tools.xdevInlineDevices` | array | `[]` | With `tools.xdevDocs` set to `builtins`, inline dynamic devices whose names match these glob patterns (for example `mcp__context_mode_*`). Ignored with `catalog`. |

Individual built-in tools are toggled by their own `*.enabled` keys: `ask.enabled`, `async.enabled`, `bash.enabled`, `browser.enabled`, `checkpoint.enabled`, `computer.enabled`, `debug.enabled`, `eval.py`, `eval.js`, `eval.jl`, `eval.rb`, `fetch.enabled`, `generate_image.enabled`, `github.enabled`, `glob.enabled`, `grep.enabled`, `astEdit.enabled`, `astGrep.enabled`, `launch.enabled`, `security.enabled`, `speechgen.enabled`, `todo.enabled`, `vault.enabled`, and `web_search.enabled`. The `inspect_image` tool is controlled by the tri-state `inspect_image.mode` (`auto` | `on` | `off`, default `auto`): `auto` exposes it only when the active model lacks native image input, and the `/vision` slash command overrides the mode per session.

## Optional tools

| Key | Type | Default | Description |
|---|---|---|---|
| `ask.enabled` | boolean | `true` | Enable the ask tool for interactive user questions. |
| `checkpoint.enabled` | boolean | `false` | Enable the checkpoint and rewind tools for context checkpointing. |
| `debug.enabled` | boolean | `true` | Enable the debug tool for DAP-based debugging. See [Debugging](/oh-my-pi/features/debugging/). |
| `security.enabled` | boolean | `false` | Enable OMP-native security scan planning, execution, and the read-only `security://` resource namespace. See [Security](/oh-my-pi/features/security/). |
| `vault.enabled` | boolean | `false` | Enable the `vault://` internal URL for reading and editing Obsidian vault content via the Obsidian CLI. When disabled, `vault://` resolution is refused and the entry is omitted from the system prompt. See [Internal URLs](/oh-my-pi/guides/internal-urls/). |
| `generate_image.enabled` | boolean | `false` | Enable the generate_image tool (text-to-image generation and editing). Exposed as an `xd://` device when `tools.xdev` is on. |
| `speechgen.enabled` | boolean | `false` | Enable the tts tool for on-device (Kokoro) or xAI Grok Voice speech-file synthesis. |
| `inspect_image.enabled` | boolean | `false` | Legacy boolean kept only for back-compat migration to `inspect_image.mode`; hidden from the settings UI. |
| `inspect_image.timeoutMs` | number | `300000` | Per-request timeout for the inspect_image vision-model call, in milliseconds. A stalled provider fails fast with a timeout error instead of blocking until manual abort; `0` disables the timeout. |

## Todo

| Key | Type | Default | Description |
|---|---|---|---|
| `todo.enabled` | boolean | `true` | Enable the todo tool for task tracking. |
| `todo.reminders` | boolean | `true` | Remind the agent to complete todos before stopping. |
| `todo.remindersMax` | number | `3` | Maximum number of todo reminders before giving up. |
| `todo.eager` | enum | `default` | How strongly to push automatic todo-list creation after the first message: `default` (model decides, no automatic list), `preferred` (suggests a list, not forced), `always` (forces a comprehensive list). |

## Async execution and hub

Async execution runs `bash` and `task` jobs in the background and lets `hub` watch them. See [Subagents](/oh-my-pi/features/subagents/).

| Key | Type | Default | Description |
|---|---|---|---|
| `async.enabled` | boolean | `true` | Enable async bash commands and background task execution. |
| `async.maxJobs` | number | `100` | Maximum concurrent async jobs (clamped to 1-100). |
| `async.pollWaitDuration` | enum | `smart` | How long a `hub` wait watches background jobs before returning the current state. A fixed value (`5s`, `10s`, `30s`, `1m`, `5m`) waits that exact duration every time; `smart` starts at 5s and lengthens with each back-to-back wait (up to 5m), resetting to 5s after about a minute without waiting. |
| `irc.timeoutMs` | number | `120000` | Default timeout for `hub` message waits (and send `await: true`) in milliseconds; `0` disables the timeout. |

## Browser

The browser tool drives Chromium/CDP tabs with puppeteer. See [Browser](/oh-my-pi/features/browser/).

| Key | Type | Default | Description |
|---|---|---|---|
| `browser.enabled` | boolean | `true` | Enable the browser tool for scripted Chromium automation (puppeteer). |
| `browser.cdpUrl` | string | _(unset)_ | Default HTTP CDP discovery endpoint (for example `http://127.0.0.1:9222`) to attach to instead of launching a browser. Explicit `app.cdp_url` or `app.path` on the tool call take precedence. |
| `browser.relay` | boolean | `false` | Drive your own Chrome tabs through the omp browser relay. Install the extension once (`omp browser-relay install`); the relay server auto-starts when the browser tool needs it. Takes precedence over `browser.cdpUrl`; `PI_BROWSER_RELAY=0` or `PI_BROWSER_RELAY=1` override. |
| `browser.relayUrl` | string | _(unset)_ | omp browser relay endpoint (default `http://127.0.0.1:9224`). |
| `browser.headless` | boolean | `true` | Launch browser in headless mode; disable to show the browser UI. |
| `browser.cmux` | boolean | `true` | Use cmux WKWebView surfaces for browser automation when a cmux socket is available. `PI_BROWSER_CMUX=0` or `PI_BROWSER_CMUX=1` overrides. |
| `browser.screenshotDir` | string | _(unset)_ | Directory to save screenshots. If unset, screenshots go to a temp file. Supports `~` (for example `~/Downloads`, `/sdcard/Download` on Android). |

## MCP

MCP servers are managed through `omp mcp`. See [MCP](/oh-my-pi/extending/mcp/).

| Key | Type | Default | Description |
|---|---|---|---|
| `mcp.enableProjectConfig` | boolean | `true` | Load `.mcp.json`/`mcp.json` from the project root. |
| `mcp.renderMarkdownResults` | boolean | `true` | Render non-JSON MCP text results as Markdown in the transcript. |
| `mcp.notifications` | boolean | `false` | Inject MCP resource updates into the agent conversation. |
| `mcp.notificationDebounceMs` | number | `500` | Debounce window in milliseconds for MCP resource updates before injecting them into the conversation. |

## GitHub

The github tool dispatches repository, issue, pull request, diff, search, checkout, push, and Actions watch workflows. See [GitHub](/oh-my-pi/features/github/).

| Key | Type | Default | Description |
|---|---|---|---|
| `github.enabled` | boolean | `false` | Enable the github tool (op-based dispatch for repository, issue, pull request, diff, search, checkout, push, and Actions watch workflows). |
| `github.cache.enabled` | boolean | `true` | Cache rendered issue/PR view output in `~/.omp/cache/github-cache.db` so repeated reads are free. |
| `github.cache.softTtlSec` | number | `300` | Within this window, cached issue/PR view rows are returned directly (5 minutes). |
| `github.cache.hardTtlSec` | number | `604800` | Past the soft TTL the cached row is returned and refreshed in the background; past the hard TTL it is dropped (7 days). |

## Search tools

| Key | Type | Default | Description |
|---|---|---|---|
| `grep.contextBefore` | number | `1` | Lines of context before each grep match. |
| `grep.contextAfter` | number | `3` | Lines of context after each grep match. |

## Native computer use

The disabled-by-default `computer` essential tool captures and controls the real host desktop through native OS APIs. It is separate from `browser`: `computer` can drive IDEs, terminals, native applications, browser windows, and system dialogs, while `browser` manages Chromium/CDP tabs and structured page automation.

| Key | Type | Default | Description |
|---|---|---|---|
| `computer.enabled` | boolean | `false` | Enable the native computer tool. Natively capable OpenAI GA models use the `{ "type": "computer" }` wire form; every other function-calling model gets `computer` as a regular function tool. The `/computer` slash command toggles this for the current session only. |
| `computer.display` | string | `all` | Composite all active displays, or use a numeric display ID reported by a successful computer result. |
| `computer.maxWidth` | number | `3840` | Maximum composite screenshot width in pixels. Image transports that cannot preserve original detail, including GitHub Copilot Responses and xAI OAuth, cap the effective width at `1280`; Claude-family models use the same cap as a compatibility fallback. |
| `computer.maxHeight` | number | `2400` | Maximum composite screenshot height in pixels. Those coordinate-safe transports cap the effective height at `896`; other models retain the configured limit. |

Computer settings are captured when the desktop controller is created. A model switch that crosses the coordinate-safe sizing boundary recreates the controller and resnapshots those settings; changing config alone does not, so start a new session after a settings change. The recreated controller has no prior coordinate frame, so capture a fresh screenshot before the next pointer action. Before enabling input, configure `tools.approvalMode` or `tools.approval.computer` and grant platform permissions.

## Shell, eval, and LSP

| Key | Type | Default | Description |
|---|---|---|---|
| `bash.enabled` | boolean | `true` | Enable the bash tool. |
| `launch.enabled` | boolean | `true` | Enable the launch tool for shared long-running project processes. |
| `bash.autoBackground.enabled` | boolean | `false` | Auto-background long-running commands. |
| `bash.autoBackground.thresholdMs` | number | `60000` | Threshold before auto-backgrounding. |
| `bash.patterns` | array | `[]` | Ordered bash command approval rules. Each item has `match` and `approval` fields; only `*` wildcards are supported. |
| `bash.direnv` | enum | `auto` | One of `auto`, `off`. Auto-load a repo's direnv/devenv `.envrc` into the bash session so devenv tools and env vars are present without manual `direnv exec`. Honors direnv's allow list: an `.envrc` you haven't `direnv allow`ed is never executed. |
| `bash.direnvLoadTimeoutMs` | number | `30000` | Max wait for the first `direnv export` (a cold devenv shell can be slow); on timeout the session runs without the direnv env. |
| `bashInterceptor.enabled` | boolean | `false` | Route Bash commands that have dedicated tools to those tools instead of executing them. |
| `bashInterceptor.patterns` | array | _built-in rules_ | Regular-expression rules that redirect Bash commands to dedicated tools; each rule carries a tool name and a model-facing message. Built-in defaults route `cat`/`head`/`tail`/`less`/`more` to `read`, `grep`/`rg`/`ripgrep`/`ag`/`ack` to `grep`, name-filtered `find`/`fd`/`locate` to `glob`, in-place `sed`/`perl`/`awk` to `edit`, `echo`/`cat` file redirection to `write`, and `nohup`, dev servers, and watch mode to `hub`. |
| `shellMinimizer.enabled` | boolean | `true` | Compress verbose shell output (git, npm, cargo, etc.) before returning it to the agent. |
| `shellMinimizer.settingsPath` | string | _(unset)_ | Path to a shell-minimizer settings file (TOML) defining user filter pipelines; `~` is expanded and user filters are searched before built-ins. |
| `shellMinimizer.only` | array | `[]` | Program names to minimize; when non-empty, only these programs are minimized (all built-in filters are active when empty). |
| `shellMinimizer.except` | array | `[]` | Program names excluded from minimization. |
| `shellMinimizer.maxCaptureBytes` | number | `4194304` | Maximum captured bytes per command before the engine falls back to raw, un-minimized output (4 MiB). |
| `shellMinimizer.sourceOutlineLevel` | enum | `default` | Source-outline mode for `cat` of source files: `default` (outline only when input is large enough) or `aggressive` (strip function bodies). |
| `shellMinimizer.legacyFilters` | boolean | _(unset)_ | Kill-switch to the pre-PR filter behavior for grep/find/pytest; when unset, defers to the `OMP_MINIMIZER_LEGACY_FILTERS` env var (default `false`). |
| `eval.py` | boolean | `true` | Python eval backend. `PI_PY=0` disables for the process. |
| `eval.js` | boolean | `true` | JavaScript eval backend. `PI_JS=0` disables for the process. |
| `eval.rb` | boolean | `false` | Ruby eval backend. `PI_RB=0` disables for the process. |
| `eval.jl` | boolean | `false` | Julia eval backend. `PI_JL=0` disables for the process. |
| `python.kernelMode` | enum | `session` | One of `session` (persistent kernel), `per-call`. |
| `python.interpreter` | string | `""` | Path to a Python interpreter; empty = auto-detect. |
| `ruby.interpreter` | string | `""` | Path to a Ruby interpreter; empty = auto-detect. |
| `julia.interpreter` | string | `""` | Path to a Julia interpreter; empty = auto-detect. |
| `lsp.enabled` | boolean | `true` | Language-server integration. `--no-lsp` disables for the run. |
| `lsp.lazy` | boolean | `true` | Start servers on demand. |
| `lsp.shared` | boolean | `true` | Share one language server per project across omp instances via the daemon broker (falls back to private servers when unavailable). |
| `lsp.diagnosticsOnWrite` | boolean | `true` | Run diagnostics after a write. |
| `lsp.diagnosticsOnEdit` | boolean | `false` | Run diagnostics after an edit. |
| `lsp.formatOnWrite` | boolean | `false` | Format files on write. |
| `lsp.diagnosticsDeduplicate` | boolean | `true` | Collapse duplicate diagnostics. |
| `shellPath` | string | _(unset)_ | Override the shell binary used by bash. |

## Files: editing and reading

| Key | Type | Default | Description |
|---|---|---|---|
| `edit.mode` | enum | `hashline` | One of `apply_patch`, `hashline`, `patch`, `replace`. |
| `edit.fuzzyMatch` | boolean | `true` | Allow fuzzy anchor matching. |
| `edit.fuzzyThreshold` | number | `0.95` | Similarity threshold for fuzzy matching. |
| `edit.blockAutoGenerated` | boolean | `true` | Refuse to edit generated/lockfile-like files. |
| `edit.streamingAbort` | boolean | `false` | Abort on streaming edit mismatch. |
| `edit.enforceSeenLines` | boolean | `false` | Reject edits anchored on lines a prior read/search never displayed in full. |
| `read.defaultLimit` | number | `300` | Default line count for `read` without a selector. |
| `read.renderMarkdown` | boolean | `false` | Render Markdown read results as formatted terminal Markdown previews instead of raw source. |
| `read.summarize.enabled` | boolean | `true` | Structural summaries for code reads. |
| `read.summarize.prose` | boolean | `false` | Summarize prose files too. |
| `read.summarize.minBodyLines` | number | `4` | Minimum multiline body or literal length before read summaries collapse it. |
| `read.summarize.minCommentLines` | number | `6` | Minimum multiline block comment length before read summaries collapse it. |
| `read.summarize.minTotalLines` | number | `100` | Files with fewer total lines are read verbatim instead of structurally summarized. |
| `read.summarize.unfoldUntil` | number | `50` | BFS-unfold elidable spans until the summary is at least this many visible lines; `0` keeps only the outermost elisions. |
| `read.summarize.unfoldLimit` | number | `100` | Hard ceiling on summary size while BFS-unfolding; a span whose revealed lines would exceed this stays folded. |
| `read.toolResultPreview` | boolean | `false` | Render read tool results inline in the transcript instead of summary rows. |
| `readLineNumbers` | boolean | `false` | Show plain line numbers. |
