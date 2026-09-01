# Changelog

## [Unreleased]

### Added

- Added the `/trace` slash command to display session trace URLs in the stats dashboard.
- Added support for OpenAI-compatible gateways whose model-list endpoint is rooted at a versioned URL, with an `injectV1: false` discovery option to request `{baseUrl}/models` directly.
- Added provider-reported credits and concrete routed-model counts to `/session` statistics.
- Added `CLINE_API_KEY` to CLI environment help for native ClinePass subscription inference.
- Expanded Devin model selection to support native CLI aliases, dotted upstream model names, and raw effort-route identifiers.
- Added provider-supplied model metadata to `/models`, including new, beta, and recommended badges plus model descriptions.
- Standalone `CLAUDE.md` files in project and ancestor directories are now loaded as context alongside `AGENTS.md`, while preserving config-directory precedence.
- Added an Activity view to Agent Hub with searchable and filterable timelines spanning live progress and persisted transcripts; `/hub` is now the live-operations entry point while `/agents` retains Control Center behavior.
- Added an `icon.advisorClosed` symbol-theme token: the advisor eye in the status line now closes once the advisor has finished reviewing and will not add further comments.

### Changed

- Disabled hashline editing for Kimi, Mimo, DeepSeek Flash, and Stepfun models for improved stability.
- Reworked transcript navigation with a fullscreen rewind selector opened by double-Escape, supporting rendered-item navigation, user-turn jumps, branching rewinds, and alternate session-tree branch selection.
- Updated `/copy` to use the fullscreen transcript selector, allowing users to copy a turn or navigate into nested content such as code, quotes, commands, and tool output.

### Fixed

- Fixed online auto-thinking classifier usage being omitted from session token and cost totals.
- Fixed image generation with custom provider endpoints when using `openai-codex` credentials and a non-OpenAI chat model.
- Fixed custom hook UI factories not receiving the documented `keybindings` argument.
- Fixed MCP OAuth token exchange for authorization endpoints that use a different resource indicator.
- Fixed custom extension `web_search` tools being shadowed by the built-in search tool.
- Fixed Agent Hub task boards collapsing to summary rows after returning from a focused session.
- Improved Linux ARM64 browser startup messaging when managed Chrome for Testing builds are unavailable, with guidance for using system Chromium or `PUPPETEER_EXECUTABLE_PATH`.
- Fixed resuming image-heavy sessions that previously terminated while replaying transcripts.
- Fixed custom agents declaring `hub` being incorrectly treated as read-only.
- Restored compatibility for legacy Pi extensions that import `calculateContextTokens` or use the synchronous `SettingsManager.create()` API.
- Fixed custom model overrides being lost during configuration updates.
- Clarified that the default task-delegation setting follows the selected model's policy.
- Fixed `/rename` without a title interrupting active session activity.
- Fixed the Nerd Font notification persisting incorrectly after theme configuration.
- Fixed sampling parameter errors with newer Anthropic models.
- Long OpenCode Go usage-limit waits now switch replay-safe turns to a configured alternate provider when the delay exceeds `retry.maxDelayMs`.
- Fixed OpenAI Codex Responses tool results being lost when composite and plain tool-call identifiers did not match.
- Fixed `/tan` background agents failing to resolve credentials for providers supplied by extensions.
- Fixed Mnemopi saving session transcripts on exit when automatic retention is disabled.
- Fixed configuration writes through chained symlinks so the final target and intermediate links are preserved.
- Fixed direct tool calls using full `xd://` device URLs.
- Fixed command-backed headers in custom discovery providers being resolved for discovered models.
- Fixed Windows drive paths pasted under WSL being resolved through their `/mnt/<drive>` mounts for images and file reads.
- Improved sloppy/SPARSE edit no-match guidance so low-confidence matches are clearly presented without unsafe copy-ready operations.
- Fixed agents in Hub wait loops failing to respond to user steering messages.
- Fixed `/tan` sessions inheriting parent costs and overstating subagent totals.
- Fixed prompt action labels being truncated.
- Fixed assistant text being truncated when a tool call begins during streaming.
- Fixed the advisor dropping concerns when catching up on multiple turns and improved review context with bounded tool-result excerpts plus complete `ask` exchanges.
- Fixed bash command timeouts being delayed by child processes holding output pipes open, while improving timeout reporting and cleanup.
- Fixed retry countdowns and capped-wait errors displaying floating-point noise in millisecond durations.
- Prevented browser `app.path` from terminating existing same-executable applications when no reusable CDP endpoint is available.
- Fixed top-level errors overwriting the active composer before terminal restoration.
- Fixed Enter being ignored during the first turn when omp starts with an initial prompt.

## [18.0.11] - 2026-08-29

### Added

- Added gallery previews for composer and status-line components, with CLI filters for browsing by surface, composer, or segment.

### Changed

- The status line now displays the thinking level as a compact icon alongside the model name by default; set `statusLine.compactThinkingLevel` to `false` to restore the previous display.

### Fixed

- Fixed MCP OAuth discovery for shared API gateways and authorization servers with nested paths, including Keycloak realms, so authentication targets the correct resource issuer and supports endpoint and dynamic client-registration discovery.
- Fixed credential rotation for HTTP 402 payment-required responses so sibling credentials are tried before model fallback without misclassifying informative non-quota errors.
- Transport errors after a complete, non-executed tool call can now retry through configured retry budgets and fallback chains when it is safe to do so, instead of ending the turn prematurely.
- Improved handling of truncated or otherwise undecodable images so they produce an actionable error and no longer permanently block subsequent requests or resumed sessions.
- Fixed Sharpshooter consolidation preserving memory files and queued changes when an empty replacement is returned.
- Fixed `omp plugin features` so it discovers marketplace-installed plugins.
- Fixed Escape handling when closing the `/session` information panel; the panel now retains focus until dismissed.
- Fixed the thinking-block visibility toggle so streamed reasoning is correctly hidden when thinking blocks are set to hidden.
- Reduced high idle CPU usage while the agent is working.
- Fixed resumed advisor subscription usage being displayed as a dollar amount instead of as a subscription.
- Fixed relative API addresses whose names end in image extensions being pasted as text instead of incorrectly treated as missing local image files.
- Fixed chat Markdown links and bare URLs so they become clickable OSC 8 hyperlinks when `tui.hyperlinks=always` is enabled.
- Fixed unreadable composer text on light terminal backgrounds when using transparent composer styles.
- Fixed `retry.fallbackChains` warnings for valid selectors from providers whose model discovery is still pending; validation now updates after discovery completes.
- Fixed visible browser windows launched by OMP so page content resizes with the operating-system window.
- Fixed Python evaluation hanging on Windows when importing native-extension modules such as NumPy.
- Fixed subagent extension context helpers so `ctx.getContextUsage()` and `ctx.compact()` operate on the child session.
- Fixed `lsp diagnostics` incorrectly reporting success for project-aware pull-diagnostic servers when diagnostics time out or fail.
- Corrected labels under `Settings > Context > Compaction Token Limit`.
- Fixed orphaned pages, iframes, and workers accumulating in the shared headless browser after abnormal OMP session termination.

## [18.0.10] - 2026-08-28

### Added

- Added the Sharpshooter memory backend for tracking friction-earned project decisions, with `/memory queue` and `/memory sync` controls.
- Added `/restart` to relaunch omp with its original launch flags and resume the current session in place.
- Added the `band` composer shape, a flush powerline status band above the prompt; it is now the default while existing `composer.shape` settings remain unchanged.
- Added in-place retry for interrupted or failed tool calls: use F5, Alt+R (`app.retry`), or `/retry` to replay an intact failed batch without an additional model round trip.
- Improved the working status display with a timed braille spinner, streamed intent, session accent colors across relevant status elements, and theme-aware session accent generation.
- Updated the `unicode` and `ascii` symbol presets to use `π`/`pi` for the brand icon, avoiding tofu on fonts without the nerd-font glyph.

### Changed

- The `/review` command's PR-style comparison now uses the merge base against the current branch, excluding commits that exist only on the base branch; selecting the current branch reports no changes.
- Prompt history is now persisted immediately when submitted, and session database state is checkpointed on exit to improve durability and prevent unbounded WAL growth.

### Fixed

- Fixed edit-tool parsing of `－`-prefixed MATCH lines so they correctly represent whole-line deletions and can be replaced by a following `＋` run.
- Fixed interrupted and failed Python evaluation cells being reported as successful results instead of errors, improving model handling, telemetry, retries, and background-job failure reporting.
- Fixed native-extension imports such as `numpy` hanging indefinitely in the Python evaluation tool on Windows.
- Fixed a macOS composer display issue where undercurl could remain attached to stale text after rapid typing.
- Improved `xd://` MCP failure messages with actionable transport stages, failure categories, server and tool context, retryability, trace IDs, and redacted JSON-RPC details.
- Fixed ACP `read` tool-call locations so clients such as Zed Follow receive the resolved filesystem path rather than the OMP line-range selector.

## [18.0.9] - 2026-08-28

### Breaking Changes

- Removed the `git` and `jj` wrapper modules from the SDK surface. VCS operations are now available through `@oh-my-pi/pi-natives/vcs`, including native handles and typed `VcsError` support; the package continues to re-export the `github` (gh CLI) helpers.

### Changed

- `extendedContext` now defaults to off: models with premium long-context pricing tiers (e.g. GPT-5.6 1M) stay capped at their standard-pricing window unless the setting or `/extended-context on` enables the extended window.

### Fixed

- Improved terminal readability on light backgrounds by ensuring TUI surfaces use contrasting foreground colors.
- Coalesced simultaneous autonomous continuation requests to prevent repeated calls while the agent is busy, with clearer continuation diagnostics.
- Fixed Snapcompact so it skips or falls back when compaction would not reduce context size, and now compacts text in mixed tool results while preserving all source images.
- Added Google Antigravity daily quota usage to the status line.
- Fixed status-line background-work counts so queued tasks and evaluation jobs remain visible without double-counting running subagents.
- Fixed nested subagent visibility in RPC subscriptions, the subagent HUD, `get_subagents`, `subagent_*` events, and `get_subagent_messages`.
- Fixed `omp token` refreshing local MCP OAuth credentials without blocking or losing rotating refresh tokens, and preserved OpenCode MCP OAuth configuration during discovery.
- Prevented process crashes caused by socket-closed errors and unhandled promise rejections during concurrent subagent shutdowns, timeouts, and MCP transport disconnects.
- Fixed automatic startup model selection so ambient AWS credentials do not incorrectly select an unavailable Amazon Bedrock model over a provider the user has authenticated with.
- Kept embedded context usage visible in the status line when long session names or paths consume available space.
- Added a status message when `CTRL-O` toggles tool-output expansion.
- Fixed `omp usage` to report Codex Chat and Spark capacity meters separately when they share a usage window.

## [18.0.8] - 2026-08-27

### Added

- Transcript usage rows now show the total prompt-to-yield time (Δ + clock, including tool calls) after the turn timestamp, opt-in via `display.showTurnTime` (off by default).
- `omp usage` now shows Z.AI GLM Coding Plan credit quotas (5h + weekly) with the subscribed plan tier.
- The usage status line now labels untiered quota windows with the report's plan tier, surfacing Z.AI Coding Plan (`pro`) and Codex plan names next to the 5h/7d percentages.

### Fixed

- Fixed corrupt session headers silently overwriting recoverable transcripts during resume ([#9915](https://github.com/can1357/oh-my-pi/issues/9915)).
- Fixed a startup race that left a new session with almost no tools and an empty skill inventory. An early reconcile could commit a small live tool set as the permanent enabled set. The enabled set is now seeded from the construction-time tool slate, and `reconcileCodeMode` samples it inside the registry mutation lock.
- Fixed `snapcompact` compaction frames larger than the persistence limit being truncated into invalid image base64 on session resume, which made the provider reject every subsequent request with HTTP 400; already-corrupted archives now resume from their retained source text instead ([#9901](https://github.com/can1357/oh-my-pi/issues/9901)).
- Fixed prompts hanging when a successful automatic retry ended through an early terminal path such as `yield`.
- Fixed `hub` `send await:true` blocking for the full IRC timeout when the awaited agent finished without replying; the send now settles as soon as the peer stops ([#9913](https://github.com/can1357/oh-my-pi/issues/9913)).
- Fixed workspace symbol searches reporting success when every configured language server failed; partial failures now remain visible alongside successful results ([#8387](https://github.com/can1357/oh-my-pi/issues/8387)).
- Handle denied working-directory changes without crashing resume, move, or startup flows.
- Fixed Cursor-only sessions becoming permanently unusable after replaying orphaned async tool results.
- Fixed `!command` config values (`auth.broker.url`, `auth.broker.token`, custom headers) passing inherited file descriptors to the resolution command; on POSIX these commands now run under `/bin/sh` (Windows keeps the built-in shell and is unchanged)
- Fixed `providers.amazon-bedrock` guardrail, transport, and header settings being dropped for models referenced by an inference-profile ARN.
- Fixed the welcome screen staying at its original width after a terminal resize; a settled rebuild now recomposes it at the new width like the rest of the transcript.
- Fixed `omp if-bench` ending an Anthropic model's run on a transient `Refusal (cyber)` classification; the cyber classifier is stochastic near the threshold, so a refused turn is now retried with a fresh session (up to 3 attempts) before it is scored as a run-ending provider failure.
- Fixed streamed assistant responses crashing when a later provider delta revised earlier Markdown; assistant output now stays mutable until finalization.
- Fixed an orphaned foreground tool card surviving a later agent turn and pinning the entire transcript outside native scrollback; new turns now seal abandoned cards while preserving background-task updates.
- Fixed resize and display replays to include naturally emitted active-head rows in one atomic bottom-first transaction without rewinding lifecycle state, while graceful shutdown still drains every eligible final suffix.
- Fixed terminal resizes lagging on large transcripts: the transient resize repaint now renders only the visible tail instead of the entire committed transcript per resize event.
- Fixed cache-miss dividers crashing completed streamed assistant messages after stable rows had entered native history; cache-miss status now trails the assistant output.
- Fixed quitting re-streaming the entire committed transcript when a resize-triggered scrollback replay was still pending; shutdown now flushes only genuinely un-retired rows.
- Fixed fast tool completions leaving a permanent running summary that blocked transcript retirement and squeezed later tool output.
- Fixed `omp git` hunk navigation (`alt+↓`/`alt+↑`) appearing to do nothing while the file sidebar had focus: the diff cursor band now stays visible (dimmed) when the pane is unfocused.
- Fixed the git TUI sidebar jumping back to the top of the file list after staging or unstaging a file; selection now stays on the nearest remaining row
- Fixed the `aarch64-linux` `nix build` output segfaulting in the dynamic loader before startup by repointing the stale `DT_VERDEF` that `patchelf` leaves behind when it grows `.dynamic`, and surfaced smoke-test signal deaths in the build log instead of masking them ([#9881](https://github.com/can1357/oh-my-pi/issues/9881)).
- Added custom RPC launcher builders so embedded clients can transport omp RPC through SSH and remote process managers.

## [18.0.7] - 2026-08-26

### Added

- Git and Jujutsu operations now run in-process (gitoxide/jj-lib) instead of spawning `git`/`jj` subprocesses — faster status lines, diffs, staging, and worktree operations. The git binary is only used for credential-bound network transfers (push/fetch/clone) and reftable repositories.
- Status lines, footers, reviews, project identity, cleanse, and autoresearch reads now work in pure Jujutsu workspaces as well as Git checkouts.
- Include token usage statistics in inspect_image tool output
- Pressing the session model shortcut (alt+p) again inside the picker toggles a red Task mode that switches the Task subagent's model for this session instead.
- Git TUI: an AI staging wand next to "Stage All" asks "What should we stage?" and stages only the matching changes — the tiny/smol model picks the matching files from the whole change list, then filters their hunks in parallel; file-scoped requests ("git stuff") stage the picked files whole, content-scoped ones ("all comment changes") stage only the matching hunks.

### Changed

- Enforce a 5-minute timeout and 8 MiB output limit for GitHub CLI operations
- Apply a 30-minute timeout for marketplace plugin repository cloning
- Improve large file handling with blob streaming and explicit truncation support

### Fixed

- Fixed the VCS status line counting every file inside an untracked directory instead of collapsing it to one entry like `git status`.
- Fixed git TUI sidebar wheel scrolling snapping back to the selected row after staging or collapsing entries; the list now follows the selection only when it actually changes.
- Fixed `inspect_image` selecting a text-only vision/default role when an image-capable model was available on the active provider.
- Improved unexpected-stop recovery for reasoning-only stalls by requiring the next concrete tool action instead of repeated analysis.
- The edit tool now repairs a stray closing marker typed in place of the divider in a selection (`old⟫new` inside one selection instead of `old│new`) and applies the intended replacement with a note, instead of failing with an unmatched-marker error.

## [18.0.7] - 2026-08-26

### Added

- Added nonblocking shared model-catalog refresh with cached startup hydration and source freshness diagnostics, allowing newly published models for known providers to appear without a binary release.
- Added `omp usage clients` to report per-client token usage recorded by the auth broker, including the machine and application responsible for usage by provider. Supports `--days` and `--json` output.

### Changed

- Improved `omp git` responsiveness by streaming file contents, rendering complete lines promptly, progressively applying syntax highlighting, and deferring large commit statistics until after the first interactive frame.
- Expanded `omp git` navigation and editing shortcuts: refresh with `r`, stage or unstage files and directories with `s`, `u`, or `space`, navigate hunks and files with keyboard shortcuts, use Vim-style motions in both panes, select diff views with `1`–`4`, and open the commit form with `c`.
- Standardized completed edit results across edit modes with hashline-style paths and numbered previews.
- Documented browser relay behavior more clearly, including that `browser.relay` can enable relay access independently of `app.relay` and that a relayed session operates in the user's logged-in browser.
- Clarified the computer tool documentation: `desktop.window()` must be awaited, and `win.ax()` returns a textual accessibility-tree snapshot rather than a structured node list.

### Fixed

- Fixed hub process waits being incorrectly prolonged or satisfied by a replacement process after an automatic restart.
- Preserved an explicitly empty `tools: []` configuration for agent definitions instead of adding default work tools.
- Corrected MCP per-tool approval configuration documentation and behavior to use registered tool names for deny policies.
- Made `/branch` consistently open the branch-from-message selector regardless of the `doubleEscapeAction` setting.
- Improved ACP behavior when prompting during an active turn by returning a typed `session_busy` JSON-RPC error instead of an opaque internal error.
- Fixed `--model <id>:<effort>` losing its effort setting when cycling back to the `default` role; an explicit `--thinking` setting continues to take precedence.
- Fixed extension-registered Codex models configured with `preferWebsockets: false` from attempting a WebSocket connection.
- Fixed stale command-generated provider and model-override credentials after HTTP 401 responses by refreshing credentials before retrying.
- Fixed extensions configured in `.omp/config.yml` not exposing their bundled skills, hooks, tools, commands, rules, prompts, and MCP configuration for discovery.
- Fixed compiled extensions that could not import public coding-agent registry modules.
- Fixed extension-provided environment variables being lost in user shell commands and prevented environment changes from one hook from affecting later commands.
- Fixed imported and legacy sessions with missing usage metadata from dropping RPC lifecycle events.
- Fixed GitHub and GitHub Enterprise issue, pull-request, and tool lookups to preserve and use the repository's actual host.
- Fixed binary installation when GitHub returns minified release metadata.
- Fixed `omp bench` and `omp if-bench` resolving credential-scoped dynamic models already listed by `omp models`.
- Fixed checkpoint and rewind recovery in Codex Code Mode.
- Fixed truncated `ask` questions being displayed incorrectly when expanded with Ctrl+O.
- Fixed the welcome screen and transcript layout not adapting correctly after terminal resizes.
- Made `omp if-bench` retry transient Anthropic cyber-safety refusals before treating them as run-ending failures.
- Fixed streamed assistant responses when later provider updates revise earlier Markdown.
- Fixed abandoned foreground tool cards and fast tool completions from blocking transcript scrolling or later output.
- Improved transcript replay and shutdown behavior so terminal resizes and exits do not duplicate, lose, or unnecessarily re-render committed output.
- Fixed cache-miss status messages from disrupting completed streamed assistant responses.
- Fixed YAML rewrites for settings, migrated configuration, and keybindings from adding trailing spaces to nested mapping headers.
- Fixed `/model` role-cycle icons overlapping their ordinal on terminals with full-width icon rendering.
- Improved `/collab` QR-code fallbacks so the browser join URL remains visible when the code is clipped or cannot fit.
- Fixed hub and child peer listings from exposing parked agents as active model context, while restoring accurate running, idle, parked, shown, and truncated counts.
- Fixed browser relay clients hanging when enabling the Runtime domain on a tab shared with another client.
- Fixed browser relay sessions leaving Chrome's debugging infobar attached after the last client releases a tab.
- Fixed interactive TTSR interruptions being displayed as errors when the rule injection succeeded.
- Fixed cold interactive launches duplicating the welcome header in Windows console scrollback.
- Fixed Git TUI hunk navigation and sidebar selection after staging or unstaging files, including correct handling of CRLF files on Windows.
- Fixed long sessions becoming unrecoverable when a provider rejects histories that exceed its message-count limit.
- Improved `/dump` output with readable titles for system notices and fenced XML payloads.
- Fixed kernel session recovery when a dead kernel reports cancellation.
- Applied advisor tool-call loop limits to advisor runs as well as regular model runs.
- Fixed `lsp rename_file` error handling for unreadable source paths and destination checks.
- Fixed LSP clients with different process arguments, initialization options, or settings from incorrectly sharing one process; `lsp reload *` now replaces superseded clients.
- Fixed auto-retry countdowns appearing frozen during long provider-specified waits.
- Fixed the Todo HUD after viewing a subagent and returning to the main session.
- Fixed child task results from linking unreadable artifacts and from replaying result bodies that had already been delivered.
- Fixed `omp update` showing a Unix reinstall command on Windows after a package-rename migration verification failure.
- Preserved `thinking.requiresEffort: false` in custom model configuration so supported local models can explicitly disable thinking.
- Prevented incompatible non-object values in shared project settings from silently replacing an entire settings group; such values are dropped with a warning.
- Jina Reader now uses configured credentials for authenticated rate limits while remaining available anonymously.
- Improved advisor session recovery and listing performance for large advisor transcripts.
- Fixed failed `browser.open` calls from leaving OMP-spawned application processes running when no tab could be acquired.
- Browser handles now fail fast with a specific per-operation timeout error instead of hanging an entire browser cell.
- Fixed autonomous runs becoming idle when a thinking-only length stop overlaps speculative handoff and compaction recovery.
- Kept completed assistant replies visible when viewport pressure prevents older active content from being retired.
- Accelerated SHA-2 and SHA-3 checksum builtins on supported ARM64 hardware.
- Fixed joined collaboration guests becoming inconsistent with the host after host-side compaction.
- Fixed `hub list` and child peer rosters counting parked agents from stale root sessions; the persisted roster now scopes to the current root, retries transient filesystem faults, and renders live rows through the production subagent prompt template with a truthful omitted count.

## [18.0.6] - 2026-08-26

### Added

- Added fast, cached conventional commit message generation to the git TUI and `omp commit --legacy`, including automatic handling of whitespace-only changes, clearer commit scopes, and improved grammar and tense in generated summaries.
- The git TUI sidebar now supports collapsing and expanding the Unstaged and Staged sections, with keyboard shortcuts to stage or unstage an entire section.
- Long streaming thinking and reasoning output now continues into terminal scrollback during a turn instead of remaining clipped to the viewport.

### Changed

- `omp commit --legacy` now uses the same conventional commit message generation as the git TUI.
- The git TUI sidebar now groups new files separately from tracked changes in the Unstaged section, while Staged and commit file lists use a unified status-based view.
- Improved resilience when streaming output changes during rendering, preventing incomplete blocks from causing further display updates to fail.

### Fixed

- Commit-message generation errors in the git TUI now remain visible in the status bar instead of disappearing and returning to an idle state.
- Fixed `omp update` leaving standalone Windows binaries on the old version when stale Bun launcher metadata was present, and preserved launchers installed by a newer concurrent update during binary repair ([#9806](https://github.com/can1357/oh-my-pi/issues/9806)).
- Quitting `omp git` during commit-message generation now exits cleanly without leaving the process running.

## [18.0.5] - 2026-08-25

### Added

- Added append-only transcript declarations and stable-row APIs for components with immutable history prefixes.
- Added the `:img` read selector to rasterize local SVG and SVGZ files for vision input.
- Added side-by-side image and SVG previews to `omp git`, including Git LFS object resolution and clear placeholders for unavailable or unsupported binary content.
- Added the `omp if-bench` command for zero-tool instruction-following and working-memory benchmarking across models, with live progress and ranked results.
- Added `q` to quit the git TUI.
- Added advanced whitespace filtering to the git TUI, including formatting-only changes and import-only changes in TypeScript, JavaScript, Rust, and Go.
- Improved the git TUI sidebar by compressing single-child directory chains and separating new or untracked files from tracked changes.
- Added Yolo-Auto to `/login` and documented the `YOLO_AUTO_API_KEY` environment variable.
- Updated the OpenRouter `/login` flow to support browser-based sign-in and automatic API-key provisioning, while retaining support for pasted `sk-or-…` keys.
- Added DeepInfra support for the `image_gen` and `tts` tools, including provider selection and MP3 or WAV output for text-to-speech.

### Changed

- Standardized completed edit results with hashline-style paths and numbered previews across edit modes.
- Improved `omp git` responsiveness with immediate file rendering, progressive syntax highlighting, and deferred large-commit statistics.
- Documented that `retry.maxDelayMs: 0` permits provider-requested quota waits to continue until automatic retry, rather than enforcing a wait ceiling.
- Expanded git TUI navigation and file-management shortcuts, including refresh, stage/unstage, directory operations, hunk and file navigation, pane movement, diff-view selection, commit-form access, and paging.

### Fixed

- Fixed race condition where tunnel startup was incorrectly reported as failure on quick process exit
- Fixed Obsidian theme task instructions and usage-limit text becoming unreadable against dark backgrounds.
- Fixed marketplace-installed plugins failing to discover their `rules/` directories.
- Fixed advisor notes in `/tree` displaying internal XML wrappers instead of readable text.
- Fixed successful agent and subagent results being discarded when cleanup exceeded its deadline.
- Fixed exiting plan mode mid-turn so the active turn now stops immediately.
- Fixed Windows workstation context reporting a virtual display adapter instead of the physical GPU.
- Fixed numbered selector menus such as `/review` ignoring digit-key selection.
- Fixed the welcome screen failing to reflow after terminal resizing.
- Fixed transcript layout issues that could clip assistant text, leave stale tool cards, disrupt scrolling, or make large-session rendering and shutdown unreliable.
- Fixed streamed assistant responses failing when later provider updates revised earlier Markdown.
- Fixed cache-miss status placement after streamed assistant output.
- Fixed `/model` role-cycle icons overlapping their ordinal on full-width terminals.
- Fixed constrained `/collab` QR codes rendering as empty rows; the browser URL hint is now shown instead.
- Fixed `hub list` and child peer rosters incorrectly including parked agents in model context and restored accurate status counts.
- Fixed browser relay clients hanging when enabling the Runtime domain on a shared tab.
- Fixed interactive TTSR interruptions being displayed as errors after successful rule injection.
- Fixed fast tool completions leaving a persistent running summary that obstructed later output.
- Fixed the Windows console welcome header being duplicated after cold launch.
- Fixed git TUI hunk navigation feedback when the sidebar has focus and preserved file selection after staging or unstaging.
- Fixed long sessions becoming unrecoverable when providers reject histories exceeding message-count limits.
- Improved `/dump` output with readable system-notice titles and XML-fenced raw payloads.
- Fixed kernel sessions failing to recover when cancellation was reported by a dead kernel.
- Applied advisor tool-call loop limits to prevent repeated failing calls from continuing without bound.
- Fixed `lsp rename_file` incorrectly reporting inaccessible paths as nonexistent and mishandling uncertain destination checks.
- Fixed LSP clients with different launch or initialization configurations incorrectly sharing one process; reloading now replaces superseded clients.
- Fixed the browser relay leaving Chrome's debugging infobar attached after the last client released a tab.
- Fixed auto-retry countdowns appearing frozen during long provider-requested waits.
- Fixed the Todo HUD becoming stale after viewing a subagent and returning to the main session.
- Fixed child-task artifact links and duplicate `hub jobs` result bodies.
- Fixed `omp update` showing a POSIX reinstall command on Windows after a package-rename migration failure.
- Preserved `thinking.requiresEffort: false` in custom model configuration so supported local Qwen templates can disable thinking explicitly.
- Fixed project settings from shared capability files being able to replace an entire settings group when a conflicting non-object value is present; the conflicting value is now ignored with a warning.
- Jina Reader requests now use configured credentials for higher authenticated rate limits while remaining available anonymously.
- Fixed advisor session persistence and loading performance for repeated retries and unusually large advisor transcripts.
- Fixed failed `browser.open` calls leaving OMP-spawned application processes running when no tab could be acquired.
- Improved browser-handle failures with prompt, operation-specific timeout errors instead of waiting for the entire browser cell.
- Fixed autonomous runs becoming idle after thinking-only length stops during speculative handoff.
- Fixed completed assistant replies disappearing from the live transcript under viewport pressure.
- Accelerated SHA-2 and SHA-3 checksums on supported ARM64 hardware.
- Fixed large MCP tool payloads being stored redundantly on disk.

## [18.0.4] - 2026-08-24

### Added

- Added the `omp git` command (and `/git` slash command): an interactive, fullscreen repository TUI featuring a split/inline/hunk diff viewer with minimap scrollbar, syntax highlighting, a staging sidebar with line-level staging, commit composer with amend support, and author avatars. Supports keyboard navigation, full mouse interaction, and pinning views to specific commits via `omp git <revision>`.
- Overhauled the `/extensions` Extension Control Center into a fullscreen alternate-screen dashboard with mouse support, tab navigation, unified inspector views across extension types, live MCP connection management, and expandable details (`Ctrl+O`).
- Added support for live syntax highlighting in streaming markdown code blocks.
- Added an immediately editable startup composer for interactive launches, preserving drafts typed while session initialization is in progress.

### Changed

- Improved streaming markdown and thinking block rendering performance on long sessions by batching token updates and eliminating redundant re-processing.
- Optimized streaming edit verification and session restoration for large files and history-heavy sessions.

### Fixed

- Fixed invalid streamed edit patches occasionally reaching the edit tool instead of being stopped early.
- Fixed `!` shell commands on zsh/fish by running them inside a real PTY, resolving terminal option errors and preserving ANSI color formatting.
- Fixed transcript layout corruption and viewport compression caused by interrupted streams, empty blocks, or collapsed wrapped diff lines.
- Fixed transcript scrollback loss where output below sticky cards (such as hub-wait or todo) failed to commit to terminal history.
- Improved HTTP 413 error handling: accurately distinguish between true token-context overflows and provider byte/media budget limits, persist terminal errors across sessions, and enable proper fallback-chain model switching.
- Fixed discovery-backed session models failing to restore when resuming sessions with `omp --resume` or `--continue`.
- Fixed browser tool initial launch timeouts on slow or cold host environments.
- Fixed eval runtime probes hanging on Windows due to inherited stdin handles.
- Fixed Claude models replaying partial thinking blocks as conversation text when interrupted mid-turn.
- Fixed image request failures with Kimi Code and Moonshot models by ensuring inline base64 image delivery.
- Fixed SQLite WAL-mode databases without sidecars failing to open in the Read tool.
- Fixed pasted image thumbnail rendering in the composer attachment preview.
- Fixed Linux startup event loop delays caused by legacy extension cache fsync churn.
- Fixed subagent advisors abandoning reviews on the final yield turn during session teardown.
- Fixed `/todo` expand/collapse commands and corrected `/shake thinking` reporting.

## [18.0.3] - 2026-08-23

### Added

- Added opt-in edit auto-repair (`edit.autoRepair.enabled`): when an edit breaks a file's AST parse, the smol model repairs the broken region in place — validated by re-parse, revert-rejected, and surfaced as a diff in the tool result — instead of only warning.

### Fixed

- Resolved cursor drift and text duplication caused by overlapping or out-of-bounds spelling ranges
- Squeezed transcript tool rows no longer render as a bare unstyled `╭─ Hub` frame: a squeezed block keeps its real render whenever it fits the allocated rows, and blocks that genuinely overflow fold to a themed frame that names the tool's activity (e.g. `Hub · send → Main`).
- Python/Ruby/Julia eval cells that hit their wall-clock timeout during a `parallel()`/`agent()`/`tool.*` fan-out no longer get their kernel force-killed (losing all session state): the timeout now aborts in-flight bridge calls so the runner unwinds as a clean KeyboardInterrupt and the kernel survives.
- Multi-select ask options whose labels end in `(Recommended)` now show their checked state and avoid duplicate recommendation suffixes ([#9452](https://github.com/can1357/oh-my-pi/issues/9452)).

## [18.0.2] - 2026-08-23

### Added

- Added update channels: `omp update --canary` installs canary prereleases from the npm `canary` dist-tag and `omp update --stable` switches back; the chosen channel persists and drives the startup update check.

### Changed

- Unexpected Stops now offers None, Mechanical (default), and Smart modes; Smart adds small-model classification to recover text-only stops.

### Fixed

- Fixed crash during update output when theme configuration is missing
- Fixed flickering typo undercurls while typing by projecting state during revalidation
- Fixed self-update on Windows leaving the `omp` command missing or stuck on the previous version when package-manager reinstalls fail on running files
- Ctrl+T now toggles every thinking block in the transcript, including blocks already retired to terminal history ([#9440](https://github.com/can1357/oh-my-pi/issues/9440)).
- Copilot Grok 4.6 Responses streams that repeatedly close after thinking now stop after one same-model retry instead of consuming the full retry budget ([#9427](https://github.com/can1357/oh-my-pi/issues/9427)).
- `/mcp test` now reports cancellation immediately when Esc is pressed during a slow config lookup, instead of staying suspended until the read settles ([#9419](https://github.com/can1357/oh-my-pi/issues/9419)).
- Fixed remote browser relay endpoints advertising a client-local CDP WebSocket URL: `/json/version` now reflects a valid request `Host` and falls back to the relay's loopback address when it is absent or unusable.
- Restored red/green and syntax highlighting in edit-tool result bodies ([#9439](https://github.com/can1357/oh-my-pi/issues/9439)).
- Fixed goal mode failing to start (`No such tool: xd://goal`) when `goal.enabled` was turned on after the session had already started; the `goal` tool is now registered lazily on goal-mode entry ([#9444](https://github.com/can1357/oh-my-pi/issues/9444)).

## [18.0.1] - 2026-08-23

### Added

- Plan review can save a plan to a chosen path and start a new session.
- Edit results now warn when an edit leaves a previously parsing file unparseable, independent of the `edit.blackbox.enabled` recorder.
- Added provider-wide Amazon Bedrock guardrail settings to models configuration, including custom models.
- Added the `/pin` slash command to pin and unpin sessions so they stay at the top of the `--resume` picker UI.
- Optional edit parse-regression capture appends the before/after content, model, variant, and arguments to `~/.omp/agent/edit-blackbox.jsonl` when `edit.blackbox.enabled` is enabled.

### Changed

- Bash commands now automatically transition to the background by default when exceeding the threshold
- Transcript blocks now retire to terminal history as explicit ordered batches, active tools collapse to compact indicators under viewport pressure, and the `tui.scrollbackRebuild` and `tui.resizeScrollback` settings were removed.
- Transcript retirement is now capacity-driven: finalized blocks (and the welcome header) stay live in the viewport — reflowing to the current width on resize and visible the instant a message is submitted — and only commit to immutable terminal history when the screen runs out of room.
- Resizing no longer duplicates the editor and status rows: the settled repaint recovers its anchor from the terminal's own cursor-position report after reflow.
- The Advisor agent's guidance now prioritizes concrete technical risks and transcript-evident execution failures, while strictly prohibiting meta-advice on user intent, ceremony, or workflow narration.
- Edit-tool inline selections whose text contains the divider character itself (box-drawing code) are now resolved instead of failing the batch: a trailing divider reads as a deletion, an odd count splits at the middle divider, an even count reads as a deletion of the selected text, each with an advisory note.
- The welcome screen's recent-sessions list no longer content-scans every session file in the project directory: session titles are indexed in history.db as they are created/renamed, and startup resolves the newest files by mtime with a per-file scan fallback that backfills the index (cuts the pre-input startup transition by ~250ms per 10k sessions).
- Interactive startup no longer re-runs slash-command discovery: the composer's autocomplete reuses the discovery pass that session construction already performed.
- Interactive startup now reuses the prepaint composer's in-flight recent-session load, starts custom-command discovery with the other independent filesystem scans, and overlaps auth-cache/config reads with settings initialization instead of repeating or serializing them.
- Interactive startup now commits the complete composer frame synchronously before `session_start` hooks, lazily materializes only cached model providers needed by the configured default role, and starts cache-aware online runtime-provider discovery after the first UI paint.
- Advisor criteria for `concern` and `blocker` levels are expanded to better identify serializing independent tasks, bypassing specialized tools, ignoring verified sources, and premature yielding before convergence.
- The Advisor is now explicitly instructed to promote clean code cutovers (deleting obsolete paths and tests) unless backwards compatibility is required by the user or project rules.
- The advisor now flags transcript-evident execution failures—missed parallelism, overplanning, ungrounded assumptions, unnecessary abstraction, incomplete scope, stubs, and thin verification—before they force user steering.
- Slash-command autocomplete now collapses skills into a single `/skill:` row; the individual skills list once the prefix reaches `/skill:` (accepting the row with Tab/Enter expands it in place).
- `omp cleanse` and `/cleanse` now dispatch repair subagents while checkers are still running: diagnostics stream in (parsed from partial checker output every 5s), new files spawn workers up to the agent cap with least-loaded batching, and late diagnostics for a file being repaired are steered into the owning worker's chat instead of waiting for the full diagnostic pass.
- Suggested plan save filenames now come from a dedicated 1-3 word topic prompt instead of the sentence-length session title (e.g. `PYO3_METHODS_PLAN.md` instead of `SPLIT_PYENVIRONMENTBACKEND_REQUEST_INTO_PYO3_METHODS_PLAN.md`), with verbose fallbacks trimmed at a word boundary.
- Subagents in a shared working tree no longer run formatters, linters, or project-wide builds/test suites unless their assignment asks for it; validation runs once by the main agent.
- Context file deduplication now checks paragraph containment instead of byte-exact matching: a less-authoritative file whose normalized paragraphs appear contiguously within a more authoritative file is omitted, reducing redundant prompt context.
- Context file containment dedup now sorts by depth descending internally, treating files without a depth as least authoritative, so concatenated multi-root or user-level context cannot drop a closer-to-cwd file.
- Paragraph splitting for containment comparison is now fenced-code-block-aware: text inside a fenced example in a more authoritative file no longer counts as a contained instruction, preventing active context rules from being discarded.

### Fixed

- Fixed UI jitter in the edit tool gutter by reserving space for line counts
- Edit-tool add lines written directly above a `` gap now insert under their anchor line instead of splicing at the post-gap anchor, often mid-line without a newline.
- Edit-tool add lines may contain literal selection-marker glyphs; such payloads previously failed with an unusable corrected payload.
- A bare edit selection whose REWRITE restates the whole line now replaces the full line instead of duplicating the line's prefix and suffix around the span.
- A mid-line `…` in an edit REWRITE no longer re-emits a multi-line capture, so literal ellipses inside strings survive.
- Fixed double-Esc (session tree / branch selector) appearing dead on long sessions: opening it no longer replays the entire transcript through the terminal (which blocked for tens of seconds on PTY backpressure and cleared native scrollback), only the viewport repaints.
- Fixed prompt history whitespace duplicates: prompts are normalized on save (CRLF folded, per-line trailing padding stripped) so terminal-copy resubmissions upsert instead of adding a near-identical row, and a one-time pass collapses existing padded duplicates keeping the latest submission's metadata.
- Fixed prompt history duplicates: each prompt is now stored once with its latest project path, session ID, and submission time, and session resume or transcript rebuilds no longer repopulate persistent history.
- `/models` no longer shows dead sidebar tabs for unconfigured Ollama, llama.cpp, and LM Studio endpoints; explicitly configured endpoints remain visible for diagnosis ([#2761](https://github.com/can1357/oh-my-pi/issues/2761)).
- Fixed prompt input lag under CPU load while file and macOS spelling completions are active.
- Fixed blank `mnemopi.dbPath` settings silently creating volatile memory banks instead of using persistent agent storage ([#9360](https://github.com/can1357/oh-my-pi/issues/9360)).
- Fixed legacy Pi extensions being reparsed on every startup because their persistent parse cache could not be created ([#9339](https://github.com/can1357/oh-my-pi/pull/9339) by [@walodayeet](https://github.com/walodayeet)).
- Fixed Kitty text-sized Markdown headings activating before `tui.textSizing` is enabled.
- Fixed terminal-title updates racing the TUI's off-thread output pump, which could tear an escape sequence mid-frame and print the title (e.g. `0;π ∴ <session title>`) into the editor line as if typed.
- Fixed the edit tool corrupting files on unified-diff-shaped payloads: missing-separator recovery no longer hijacks `-`/`+` bodies (which deleted matched anchors and duplicated the surrounding block); they now flow to the unified-diff reinterpretation.
- Fixed the edit tool writing literal `…` lines: a whole-line rewrite gap with no captured MATCH gap now fails closed with guidance instead of splicing an ellipsis into the file.
- Fixed status text retaining hidden DCS, PM, and APC payloads after escape-sequence sanitization.
- Fixed extension load errors truncating explicitly excluded package import specifiers.
- Fixed subagents crashing before their first turn when an extension contributed a tool or skill without a `description`; the context-breakdown token estimate now coalesces missing descriptions and system-prompt sections instead of passing `undefined` to the tokenizer ([#9331](https://github.com/can1357/oh-my-pi/issues/9331)).
- Clarified that Mnemopi `/memory enqueue` only promotes working memories older than the configured consolidation gate (12 hours by default) and that normal shutdown does not run bank sleep ([#9356](https://github.com/can1357/oh-my-pi/issues/9356)).
- Fixed asynchronous V2 remote compaction dropping user and tool messages added after its speculative snapshot ([#9351](https://github.com/can1357/oh-my-pi/issues/9351)).
- Fixed startup crashes when temporary Git worktrees point to repository metadata that the current user cannot access.
- Hidden custom tools (`hidden: true`) stay out of the parent session's active set and `/tools` unless `--tools` or an agent `tools:` list names them. They used to be always-included.
- Hidden custom tools (`hidden: true`) stay out of the parent session's active set and the TUI's `/tools` list unless `--tools` or an agent `tools:` list names them. They used to be always-included.
- Fixed edit retries suggesting the same invalid payload and permission prompts showing unknown paths for sloppy edits ([#9350](https://github.com/can1357/oh-my-pi/issues/9350)).
- Fixed Agent Hub aborted rows failing to open their read-only transcript when selected with Enter.
- Fixed `/mcp test` leaving a stale "(esc to cancel)" hint after the test finished and swallowing Esc presses during the grace window; the hint now stops advertising Esc once the test settles, a late Esc shows an "already finished" status instead of silently doing nothing, and one Esc press consumes the cancellation ownership so the next Esc reaches the running turn ([#9173](https://github.com/can1357/oh-my-pi/issues/9173)).
- Fixed MCP request timeouts surfacing as `Unexpected end of JSON input` instead of `Request timeout after Nms` when the abort lands mid-JSON-body read, including when the caller's signal aborts after the timer fires ([#9048](https://github.com/can1357/oh-my-pi/issues/9048)).
- Fixed streamed `xd://` device writes (including MCP tools) looking like a hung in-flight call while the model is still thinking; they now show as queued until the tool actually starts.
- Fixed `/clear` and `/new` keeping a stale `AGENTS.md` (and other context files) in the system prompt; a new session now re-reads them from disk ([#9273](https://github.com/can1357/oh-my-pi/issues/9273)).
- Auto-continue turns that die mid-tool-call with `OpenAI completions stream closed before a finish_reason was received` (and the Responses/Azure "closed before a terminal response event" variants): premature gateway stream closes now classify like idle stalls and HTTP/2 resets, so a resolved tool turn is continued after its preserved partial output instead of surfacing the error.
- Todo tool schemas now identify `items` as valid for single-phase `init` and `append`.
- Fixed Todo tool guidance to clarify that blocked tasks never auto-promote after state-changing operations (#8121).
- Fixed timed-out or interrupted glob searches keeping native filesystem workers alive and blocking subsequent agent turns.
- Fixed legacy Pi extensions being re-parsed on every launch instead of using the persistent cache ([#9170](https://github.com/can1357/oh-my-pi/pull/9170) by [@fmguerreiro](https://github.com/fmguerreiro)).
- `/mcp reload` now picks up external edits to `mcp.json`.
- Fixed `lsp reload` clearing active language-server settings instead of reapplying them.
- Fixed workspace diagnostics skipping lower-priority languages in polyglot project roots ([#8385](https://github.com/can1357/oh-my-pi/issues/8385)).
- Fixed isolated task cleanup deleting the only branch that retained an agent's commits after apply-back failed ([#9216](https://github.com/can1357/oh-my-pi/pull/9216), thanks [@Mustaqeem66](https://github.com/Mustaqeem66)).
- Fixed bare `hub wait` calls reporting nothing to wait for while an already-queued bus message remained unread.
- Fixed Code Mode activating for sessions whose caller never enabled `eval`, which handed restricted subagents an unrestricted JS runtime; the eval transport must now be part of the caller's own tool set.
- Fixed Code Mode dropping `write` from the direct surface when plan mode starts, and dropping `task` delegation guidance from the plan prompt once `task` is reachable only through the eval bridge.
- Fixed the eval tool advertising bridged declarations for tools the model can still call directly, such as a plan-mode transport `write`, by reading the partition the session actually applied.
- Fixed Code Mode turn metadata resolving a wire-name collision by tool registry order, and mishandling tools named after `Object.prototype` members or after the eval bridge's own internal operations (`__agent__`, `__budget__`, `__completion__`, `__concurrency__`).
- Fixed generated Code Mode declarations rendering an array of a union as `"a" | "b"[]`, which models read as a scalar-or-array type and submitted invalid arguments against.
- Fixed SDK sessions with a custom agent directory inheriting process-global model overrides instead of loading that directory's own `models.yml`.
- Fixed Eval guidance that implied `agent()` children share parent kernel state and advertised them when spawning was disabled.
- Fixed Bash guidance that implied raising `timeout` extends foreground execution beyond the auto-background threshold.
- Fixed Bash and Eval guidance that implied raising `timeout` extends foreground execution beyond the auto-background threshold ([#9155](https://github.com/can1357/oh-my-pi/pull/9155) by [@MikeeI](https://github.com/MikeeI)).
- Status-line usage no longer combines quota windows scoped to different models or tiers ([#9138](https://github.com/can1357/oh-my-pi/issues/9138)).
- Fixed `PI_PROXY` being ignored outside provider streams: the CLI now installs it on the process-wide `fetch` at startup, so OAuth token refresh/login, usage probes, and model discovery are proxied too. Combined with the Anthropic transport fix in `pi-ai`, a region-blocked machine reaching Anthropic through a proxy no longer fails with `403 Request not allowed`.
- Subagent failures now name the resolved provider and model that produced the error ([#9137](https://github.com/can1357/oh-my-pi/pull/9137) by [@Mustaqeem66](https://github.com/Mustaqeem66))
- Fixed read-only subagents (`scout`, restricted-tool custom agents) crashing before their first prompt when extensions register callable tool schemas.
- Fixed smart paste dropping text from X11 clipboard owners whose image read fails instead of reporting no image.
- Fixed `formatContent` silently swallowing formatter errors: the empty `catch {}` was replaced with per-server error tracking, and failed formatter requests now surface as `FileFormatResult.FAILED` instead of being misclassified as unchanged ([#8388](https://github.com/can1357/oh-my-pi/issues/8388)).
- Fixed `formatContent` reporting no-formatter as unchanged: when no configured server supports formatting, the result is now correctly classified as `FileFormatResult.UNSUPPORTED` ([#8388](https://github.com/can1357/oh-my-pi/issues/8388)).
- Fixed MCP request timeouts surfacing as `Unexpected end of JSON input` instead of `Request timeout after Nms` when the abort lands mid-JSON-body read.
- Fixed CJS modules being misclassified as ESM when imported from an ESM parent module. The extension loader now identifies unshadowed CommonJS syntax from Babel's parsed AST before deferring to the importer's module kind. This resolves `SyntaxError: Missing 'default' export` for packages with conditional exports (e.g. playwright-core) where an ESM wrapper re-exports from a CJS entry, while ambiguous files continue to inherit their importer's classification.

## [18.0.0] - 2026-08-22

### Added

- Added the `omp render` command to replay session threads and benchmark transcript pipeline performance.
- Added configurable typo detection (`Ctrl+.` suggestions), Tab word completion, and opt-in autocorrect to the macOS prompt editor.
- Added a live benchmark dashboard to `omp bench` with real-time performance estimates, p50/p95 statistics, distinct input/output throughput metrics, cost tracking, mixed challenge suites by default, and a `--prefill-bytes` option for synthetic prefill benchmarks.
- Added the `/shake thinking` command to strip model reasoning blocks from session history.
- Added icon support and usage-frequency ranking to slash-command autocomplete suggestions.
- Enhanced the edit tool to support `＋`-prefixed line insertions, unified diff formats, bare selection replacements, and robust recovery for common syntax variations and ambiguous match spans.
- Startup composer now renders immediately using cached session and theme data, allowing typing before session initialization finishes without dropping keystrokes.

### Changed

- Session history rewinds (via `Esc-Esc` or `/tree`) now truncate transcript tails in place instead of clearing and replaying the entire terminal scrollback.
- Switched the fallback edit mode to `sloppy` for models lacking hashline support.
- macOS spelling checks now run in the background to avoid blocking editor rendering and keystroke responsiveness.
- Word completions accepted via Tab now insert a trailing space when not immediately followed by whitespace or punctuation.
- Increased default visible autocomplete dropdown rows to 10 and added the `autocompleteMaxVisible` configuration setting.
- Slash-command descriptions in the autocomplete popup now truncate to two lines instead of wrapping indefinitely.

### Fixed

- Fixed streaming code blocks not rendering syntax highlighting live until completion.
- Fixed an issue where interrupting Claude during reasoning would replay partial thinking blocks on subsequent turns and cause API rejection errors.
- Fixed session resume performance by avoiding redundant edit-matching execution across historical transcripts.
- Fixed image requests to Kimi Code / Moonshot failing with 400 errors by sending inline base64 images directly.
- Fixed reading WAL-mode SQLite databases that do not have active `-wal` or `-shm` files.
- Fixed terminal transcript layout corruption on Windows caused by collapsed edit results with long wrapped diff lines ([#9302](https://github.com/can1357/oh-my-pi/issues/9302)).
- Fixed disappearing terminal scrollback history below updating cards such as background jobs or hub status cards.
- Fixed pasted image attachment thumbnails rendering as blank boxes in Kitty terminal graphics mode.
- Fixed context gauge display issues in the status line for unnamed sessions.
- Fixed accurate benchmark input token counts on providers with automatic prompt caching.
- Fixed C# files incorrectly displaying D3.js icons in edit results ([#9323](https://github.com/can1357/oh-my-pi/issues/9323)).
- Fixed incorrect token delta reporting in expanded context compaction summaries when pre-compaction usage was omitted by the provider ([#9293](https://github.com/can1357/oh-my-pi/issues/9293)).

## [17.4.4] - 2026-08-22

### Added

- Added the `tui.resizeScrollback` setting (default `append`) controlling how a settled width resize refreshes pane scrollback when the terminal repaints in place (tmux/screen/Zellij panes, in-place direct terminals). Multiplexers rewrap old output naively on width changes, leaving history hard-broken at the old width; `append` re-emits the transcript at the new width below it (one fresh copy per settled resize), `rebuild` clears pane history first so it holds exactly one current-width copy (needs a host that honors ED3, like tmux; erases pre-session scrollback), and `preserve` keeps the old-width history untouched with zero growth ([#8193](https://github.com/can1357/oh-my-pi/issues/8193)).

### Fixed

- Fixed the composer image chip painting its right border inside the card and mangling the thumbnail's first row: the Kitty placement prefix was counted as visible width, breaking the thumbnail centering.
- Fixed edit-tool whole-line inserts (an insert selection alone on its own line) splicing into the anchor line instead of landing on a new line when the anchor was the last matched line, preceded a blank line, or sat at EOF.
- Edit tool prompt now documents whole-line insert selections and that a REWRITE `…` with no captured MATCH gap is written to the file literally.
- Fixed multiplexer width resizes (tmux/screen/Zellij/cmux/Herdr panes) replaying the entire transcript into pane history — one duplicated transcript copy and seconds of visible scrolling per width change. The width-epoch boundary now resolves for real transcripts: finalized blocks without `getTranscriptBlockVersion` are treated as immutable per the documented contract, Container-derived blocks without a nested epoch source fall back to whole-segment stability instead of failing, and bash/eval/tool/read-group blocks report a block version for their genuine post-finalize mutations. The interactive resize listener no longer marks every SIGWINCH as "render pending", which forced the conservative replay-from-row-zero fallback on every settled resize ([#8193](https://github.com/can1357/oh-my-pi/issues/8193), [#7026](https://github.com/can1357/oh-my-pi/issues/7026)).

## [17.4.3] - 2026-08-21

### Fixed

- Fixed the edit tool rejecting payloads containing a glued `«»` line: after MATCH it now reads as the mistyped `»` separator, elsewhere as a stray terminator to drop.

## [17.4.2] - 2026-08-21

### Added

- Added an opt-in image URL broker (`images.urls.enabled`) that publishes outgoing images through an ordered chain of backends instead of sending inline base64 to URL-fetching providers
- Composer attachment chips (ported from omp2): pasted images and large text pastes stage as rounded preview cards above the prompt — image cards show a live thumbnail (Kitty Unicode placeholders) with pixel dimensions, text cards a snippet with `+N lines`/`N chars` — while the editor buffer holds a compact `<icon> #N` token in the card's identity color.

### Changed

- Pasted images now insert only the `[Image #N, WxH]` marker; the redundant trailing `attachment://N` URI is no longer added to the composer.
- Added a consolidated CLI reference (`docs/cli-reference.md`) documenting every top-level subcommand and launch flag, including headless print mode (`--print`/`-p`, `--print-thoughts`) ([#9252](https://github.com/can1357/oh-my-pi/issues/9252))

### Fixed

- Fixed unreadable colors in macOS Terminal.app by using its supported 256-color mode ([#9162](https://github.com/can1357/oh-my-pi/issues/9162)).
- Fixed Esc after a fast `/mcp test` result aborting the active agent turn instead of consuming the advertised cancellation input ([#9173](https://github.com/can1357/oh-my-pi/issues/9173)).
- Fixed task spawns crashing when legacy boolean per-agent prewalk or advisor overrides are present in `config.yml`.
- Fixed ACP `session/prompt` requests hanging forever when a builtin slash command's residual prompt (e.g. `/force:<tool> /some-command`) resolved locally, which also wedged all subsequent prompts on the session ([#9206](https://github.com/can1357/oh-my-pi/issues/9206)).
- Fixed eval-spawned subagent output being omitted from per-turn output-token budgets, including failed and isolated runs ([#9187](https://github.com/can1357/oh-my-pi/issues/9187)).
- Fixed `/compact` over RPC blocking the serialized command queue for the full summarization round-trip, so a follow-up `abort` could not interrupt it ([#9200](https://github.com/can1357/oh-my-pi/issues/9200)).
- Fixed RPC UI select requests dropping option descriptions, allowing hosts to render described choices ([#9175](https://github.com/can1357/oh-my-pi/issues/9175)).
- Fixed `/todo edit` failing with "Could not parse Markdown" when checklist items had backslash-escaped brackets (`- \[x\]`), which editors and markdown renderers commonly emit ([#9188](https://github.com/can1357/oh-my-pi/issues/9188)).
- Fixed `omp setup --check`/`--json` with no component printing usage text to stdout and exiting 0; it now errors on stderr and exits non-zero so scripted JSON health checks fail loudly ([#9221](https://github.com/can1357/oh-my-pi/issues/9221)).
- Fixed an aggressive `task.maxRuntimeMs` mislabeling committed subagent outcomes: a budget-killed run is no longer reported as a runtime-limit timeout, and a subagent that yielded a complete result before the deadline is no longer reported as aborted when teardown crosses the deadline ([#9191](https://github.com/can1357/oh-my-pi/issues/9191)).
- Fixed startup fallback-chain warnings for discovered OpenCode Zen, OpenCode Go, and GitHub Copilot models cached under credential-scoped IDs ([#9205](https://github.com/can1357/oh-my-pi/issues/9205)).
- Fixed interactive `/models` and Ctrl+P cycling omitting an `enabledModels`/`--models` model discovered by a background provider refresh (e.g. `opencode-go/ox-alpha-free`) after startup, by rebuilding the scoped list once discovery completes ([#9220](https://github.com/can1357/oh-my-pi/issues/9220)).
- Documented how to enable, trigger, target, and manually re-arm prewalk ([#9179](https://github.com/can1357/oh-my-pi/issues/9179)).
- Pasted images and large text pastes appear in the composer as compact icon tokens instead of bracketed markers; the bracketed form remains the outgoing/stored format, and the transcript renders it back as the compact chip.
- Deleting an attachment's inline token now removes the attachment from the submission (surviving image markers are renumbered).
- Restored prompts (esc-esc, `/tree`, branch, queued-message dequeue, failed-submit recovery) collapse image markers back into clickable atomic chip tokens and re-materialize their file links instead of degrading to dead text.

## [17.4.1] - 2026-08-21

### Added

- Added `PERSONALITY.md` support: `~/.omp/agent/PERSONALITY.md` (profile/XDG-aware agent dir) replaces the system prompt's personality block text; `personality: none` still omits the block ([#8528](https://github.com/can1357/oh-my-pi/issues/8528))
- Sloppy edits now support inline replacements with `⟪old│new⟫` syntax (`⟪old│⟫` for deletions and `⟪│new⟫` for insertions), alongside automatic recovery for common formatting mistakes without needing a retry.
- Sloppy edits now recover operations that mix `⟪old│new⟫` inline replacements with a `»` REWRITE instead of failing the payload: a redundant REWRITE is dropped, a diverging one is applied as the final text, and a note explains the interpretation.
- Expanded archive support in `read` and `write` tools: `read` can now inspect and extract members from `.rar`, `.7z`, `.iso`, `.cab`, `.deb`, `.rpm`, `.cpio`, `.ar`/`.a`, `.lzh`, `.arj`, compressed tar files (`.tar.bz2`, `.tar.xz`, `.tar.zst`), package formats (`.whl`, `.ipa`, `.xpi`, `.vsix`, `.nupkg`, `.cbz`, `.cbr`), `.asar` archives, and single-file compressed streams; `write` can create `.tar.zst` and update `.asar` archives.
- Added Code Mode for Codex `code_mode_only` models via `providers.openai-codex.codeMode` (`off`/`on`/`auto`), demoting non-essential tools into an eval bridge with generated TypeScript definitions.
- MCP tool names longer than 64 characters are now automatically truncated with a deterministic hash suffix to comply with strict provider validators.
- Marketplace-installed plugins with manifest settings can now be configured through `omp plugin config` and Settings → Plugins.
- Configured discovery providers with `authHeader` now preserve cached models across application restarts.
- Added repeat read warning hints when identical file content is read multiple times.
- Explicit DAP adapters can now attach without a PID or port when `attachDefaults` provide the target arguments.
- Added `isProjectTrusted()` compatibility shim to `ExtensionContext` for extensions targeting upstream per-directory trust gates.

### Changed

- Added `compaction.asyncEnabled` (default: on) to speculatively summarize context in the background before hitting threshold limits, avoiding blocking summarization pauses.
- Replaced `compaction.strategy` and `compaction.remoteEnabled` with an ordered `compaction.methodOrder` preference list.
- Handoff maintenance (`/handoff` and automatic handoff compaction) now commits generated summaries directly to the active session instead of starting a new session.
- Added `extendedContext` setting (`/settings` → Context → General, default: on) to optionally clamp models with premium long-context pricing tiers (such as OpenAI GPT-5.6 Sol/Terra/Luna) to standard-pricing token limits before compaction triggers.
- Token counting and token estimations are now dynamically scoped to each specific model tokenizer rather than using a single process-global tokenizer.
- `omp cleanse` and `/cleanse` now feature a live interactive status board displaying active checkers, repair subagents, tool metrics, and token/cost totals in real time.
- Eval-bridge nested `tool.<name>()` calls now enforce ACP permission gates and tool allowlists identically to direct tool calls.
- Added `tokenizer` option to custom models and `modelOverrides` to allow overriding the local tokenizer family for proxied model endpoints.
- Added `qwenTemplateReasoningEffort` to the `models.yml` `compat` schema to configure or disable reasoning effort flags for strict local inference servers.
- Settings menus now support click-to-toggle and drag-to-reorder for list items, as well as warning indicators and risk notes on sensitive options such as External Thinking.
- Supervised process completion notices now render as compact single-line entries.
- The todo HUD header now displays a consolidated progress bar showing task completion across all stages.
- `/settings` rows can now carry a risk note: a warning glyph on the row plus a warning-colored line above the description. `External Thinking` (`externalThinking`, `--external-thinking`) is the first user — providers have flagged the request shape it produces as abuse, up to account-level enforcement, so both the settings entry and `--help` now say so.

### Fixed

- Fixed regional HTTP 401 data-residency errors during Codex chat, web search, and image generation requests by passing token residency metadata on requests.
- Fixed macOS SSH ControlMaster socket creation failures caused by `sun_path` length limits when using named profiles.
- Fixed an issue where Nix-packaged builds failed to load on-demand native addons (`onnxruntime-node`/`sherpa-onnx`) due to missing shared C++ runtime library paths.
- Fixed external editor spawning (Ctrl+G, plan review, `/todo edit`) failing to attach to visible terminals for editors like `emacsclient`.
- Fixed `omp --resume` spinning at 100% CPU when new session entries arrived during initial transcript rendering.
- Fixed session resume hints and fatal exit messages omitting the active `--profile` argument.
- Fixed MCP OAuth authorization requests failing on pre-registered clients with restricted scopes by using RFC 9728 `scopes_supported`.
- Fixed isolated task subagents causing out-of-memory crashes on repositories with large uncommitted binary files by pre-sizing diffs and enforcing snapshot limits.
- Fixed LM Studio and lazy-loaded local models retaining uninitialized context lengths by re-probing loaded context lengths after initial inference.
- Fixed project-scoped Claude Code marketplace plugins incorrectly loading into sessions in other projects.
- Fixed configured advisors backed by discoverable providers remaining inactive on initial session startup until manually toggled.
- Fixed resolving `--model @<role>` failing for roles backed by discovery providers like oMLX, Ollama, and llama-swap.
- Fixed retry fallback chains stopping prematurely when encountering nested fallback configurations, and fixed session role priority during fallback chain selection.
- Fixed cancelled prompts disappearing upon abort during turn setup, properly restoring user text and attachments to the input editor.
- Fixed built-in shell utilities (`grep`, `rg`, `diff`, `find`, `timeout`, `top`, `date`, `head`, `tail`, `stat`, `truncate`, `kill`) across numerous POSIX/GNU/BSD compatibility edge cases and early-pipeline SIGPIPE handling.
- Fixed Cursor sessions missing standard string-replacement edit tooling after server tool injection.
- Fixed `hub wait` duplicating frozen rows into native scrollback during viewport overflow.
- Fixed dark-theme contrast issues on markdown code-fence headers.
- Fixed prompt guidance and descriptions for Task tools and SSH usage.
- ACP editor clients that support elicitation forms (Zed) can now use `ask`, so the agent can pose single-choice, multi-select, and free-text questions inline instead of guessing.
- `/retry` and `/handoff` now work over ACP, so editor clients (Zed) list them and can run them instead of sending the text to the model.
- Added `qwenTemplateReasoningEffort` to the `models.yml` `compat` schema, so the auto-enabled Qwen 3.8+ template effort dialect (`chat_template_kwargs.reasoning_effort`) can be switched off per provider/model for strict local servers that reject unknown `chat_template_kwargs`.
- Extensions can provide a normalized `usage` provider through `pi.registerProvider()`. Its reports now flow through AuthStorage caching, history, and usage displays, and the override is removed when the extension provider is unregistered.

## [17.4.0] - 2026-08-20

### Added

- `/cleanse` (and `omp cleanse`) — run the checker/repair loop in-session, with a live status board of running checkers, repair subagents, and token/cost totals.
- `omp ps` — interactive monitor for daemon-supervised background processes.
- Composer layouts — `composer.shape` picks the editor frame (rounded box, Claude Code rules, upstream-pi rules, borderless), with live previews in `/settings` and the setup wizard.
- Context line — `statusLine.contextLine` gauge (`percentage`, `annotated`, `embedded`) showing context usage and compaction boundaries.
- Backgroundable Python — `eval` cells can run async and auto-background like `bash`, with configurable thresholds.
- Local Claude token counting — Anthropic-family tokens now count via a native local tokenizer, and every counter (session maintenance, advisor, stats, context tools) uses the active model's own tokenizer.
- `extendedContext` setting — pick whether models with premium long-context pricing (272K/1M tiers on Codex-class models) use the extended window or compact early and stay on standard pricing.
- `/extended-context` — toggle premium long-context windows without leaving the session.
- Speculative compaction — with `compaction.asyncEnabled`, all compaction modes compact in parallel while the session continues, then splice the result in instantly.
- `tokenizer` property on custom models and `modelOverrides` to pin the tokenizer family for proxy models.
- `qwenTemplateReasoningEffort` in `models.yml` `compat` to disable the Qwen 3.8+ reasoning-effort template parameter for strict local servers.
- Click-to-toggle and drag-to-reorder for list-valued editors in `/settings`.
- `icon.subscription` and `icon.advisor` symbol-theme tokens (Nerd Font, Unicode, ASCII).

### Changed

- Typing anywhere in the /models UI now immediately focuses the model list for instant search and arrow navigation.
- Revamped the todo HUD — overall progress renders along the tree-spine connector with smooth completion transitions.
- Compaction divider now names the maintenance method that fired (`remote-compacted`, `soft-compacted`, `handed-off`, `snap-compacted`) and shows the before → after context size (e.g. `256K→20K`).
- `/handoff` (and automatic handoff compaction) now compacts in place, replacing the session context instead of forking a new session.
- Compaction method priorities — `compaction.methodOrder` takes an ordered preference list (e.g. `[remote, snap]` uses remote compaction where the provider supports it, such as OpenAI, and snap everywhere else), replacing `compaction.strategy`/`compaction.remoteEnabled`.
- Unified inline overlays and selectors (model picker, settings, `/cleanse`) into one titled rounded-box panel style.
- Risk badges and warnings on `/settings` rows, starting with External Thinking.
- Faster CLI Startup

### Fixed

- `/models` keeps `auto` thinking on non-default roles such as `task` instead of changing the active model and displaying the role as `max`.
- Subagent `yield` structured results no longer get corrupted by lossy argument repairs; prompt guidance improved for weak callers.
- GitHub `file_read` returns proper image blocks and direct view URLs for image/binary files.
- Cancelled prompts during pre-stream turn setup restore the text and image attachments to the editor.
- `top` builtin accepts single-dash macOS flags such as `-pid` and `-stats`.
- GNU/BSD compat sweep across built-in shell utilities (`timeout`, `diff`, `find`, `date`, `tail`, `head`, `rg`, `stat`, `truncate`, `cksum`, `sleep`, `which`, `nohup`, `kill`).

## [17.3.8] - 2026-08-19

- Fixed unquoted internal URLs in `bash` commands consuming adjacent shell operators into the resolved filesystem path.

### Added

- Added `providers.cacheRetention` setting (`/settings` → Providers → Protocol) to control prompt-cache retention per request: `auto` keeps the provider default (Anthropic: 5m entries with idle keep-alive refreshes), `short` forces 5m, `long` restores 1h TTLs where supported and disables the keep-alive refresh loop, `none` disables prompt caching.

### Changed

- The `read` tool now materializes a local text file once per invocation instead of once per consumer. A ranged read of a file within the snapshot cap previously cost four opens and three UTF-8 decodes — an 8KiB binary sniff, a streaming scan for the rendered window, a whole-file read for bracket context, and another whole-file read to hash the snapshot — with two of those readers separately normalizing line endings; whole-file reads under the structural summarizer paid a fifth read. Byte counts and truncation boundaries are now measured on the buffered bytes, so they stay exact for content that is not valid UTF-8. Files above the snapshot cap keep streaming, since nothing on that path wants the whole file. Raw reads, which skip the tree-sitter parse that documented the old cost, no longer pay for it.
- Documented that `bash.patterns` gates the `bash` tool only and does not cover a shell that `eval` can spawn via subprocess, and that closing that path needs a `tools.approval.eval` policy — noted in `docs/bash-tool-runtime.md`, `docs/approval-mode.md`, and `docs/settings.md` ([#8838](https://github.com/can1357/oh-my-pi/issues/8838)).

### Fixed

- Fixed the `/btw` panel re-committing its frame to native scrollback on every update while the primary turn is still streaming: a live region that pins itself (an anchored HUD/panel such as `/btw`) no longer leaks its scrolled-off rows just because an unpinned transcript seam sits above it in the same frame ([#8793](https://github.com/can1357/oh-my-pi/issues/8793)).
- Fixed a submitted `/skill:<name>` command staying invisible in the transcript until its awaited preflight (memory recall, `before_agent_start` hooks, auto-thinking classification, pre-prompt compaction) finished, so a slow step such as a Hindsight auto-recall timeout made the command look unaccepted. Idle skill submissions now paint an optimistic row immediately — like a normal prompt — and reconcile it in place when the canonical `message_start` lands ([#8895](https://github.com/can1357/oh-my-pi/issues/8895)).
- Fixed broker-backed MCP OAuth credentials never refreshing, so remote OAuth MCP servers dropped out of `/mcp` once their access token expired under `omp auth-broker serve`. The client threw on the broker-redacted refresh sentinel instead of asking the broker to refresh, and the broker had no `mcp_oauth:*` refresh path (`POST /v1/credential/:id/refresh` answered `Unknown OAuth provider`). The client now routes redacted MCP refreshes through the broker, and the broker refreshes MCP credentials with a generic `refresh_token` grant from the credential's embedded token endpoint and client id — so the background refresher also keeps MCP tokens live ([#8933](https://github.com/can1357/oh-my-pi/issues/8933)).
- Fixed `omp commit` split-commit failing with `corrupt binary patch` when a split commit contains a binary file. `parseFileDiffs` split the captured diff on `"\ndiff --git "`, consuming the `\n` that terminates each block, and `patch.join` stripped trailing newlines — both dropped the blank line that terminates a `GIT binary patch` block, so the rebuilt patch was rejected by `git apply --binary`. Both trailing and mid-diff binary blocks now survive the parse/rebuild round-trip byte-exact ([#8899](https://github.com/can1357/oh-my-pi/issues/8899)).
- Fixed `omp update` (and other non-launch subcommands) crashing with `error: Unknown option '--cwd'` when a leading global launch flag preceded the subcommand — e.g. a shell alias/wrapper that runs `omp --cwd <dir> update`. `resolveCliArgv` hoisted the subcommand to the front but forwarded the launch-only flag into `update`'s strict `node:util.parseArgs` parser, which rejected it. Launch-global flags before a launch-shaped command (`acp`/`launch`) are still forwarded; before any other subcommand they are now stripped as inapplicable ([#8891](https://github.com/can1357/oh-my-pi/issues/8891)).
- Fixed Claude Code marketplace plugins ignoring the `enabledPlugins` switch in `~/.claude/settings.json` and `.claude/settings(.local).json`: a plugin turned off for a project no longer loads there, and a local-scope install enabled for a project loads even when its recorded `projectPath` is a different directory
- Fixed revived subagents (warm lifecycle reviver and cold persisted reviver) rebuilding the session without initializing the extension runtime, leaving every runtime action throwing `ExtensionRuntimeNotInitializedError`. An extension with a `tool_call` handler that touched a runtime action (e.g. `appendEntry`) then tripped the fail-closed gate in `emitToolCall` and blocked every tool — including the hidden `yield` — so the revived agent could neither finish nor exit and looped until killed. Both revivers now call the shared `initializeExtensions` helper, restoring runtime actions, `onError`, and the `session_start` event ([#8824](https://github.com/can1357/oh-my-pi/issues/8824)).
- Fixed `omp commit` split-commit crashing with a misleading `No diff found for <path>` when a staged binary (or any payload) pushed `git diff --cached --binary` past the 8 MiB subprocess output cap. The capture is truncated silently, so files sorting after the binary vanished from the parsed diff; the split flow now requests a complete diff and fails fast naming the real cause instead ([#8897](https://github.com/can1357/oh-my-pi/issues/8897)).
- Fixed a mid-run compaction being misread as a phantom overflow: after a compaction rebased the in-flight context snapshot, `getContextBreakdown` used message position (`anchorIndex >= cutoffCount`) as a freshness proxy, so an in-flight provider response whose request predated the compaction out-ranked the rebased estimate and reported the pre-compaction token count (~2.6x the real one). This tripped the "Compaction freed too little context to make progress" guard and drove the frame-rescue path on a byte-identical `tokensBefore`. Assistant context snapshots now carry a monotonic compaction epoch, and a post-cutoff anchor whose epoch predates the last compaction is no longer trusted over the rebased estimate ([#8887](https://github.com/can1357/oh-my-pi/issues/8887)).
- Fixed `after_provider_response` extension handlers receiving the primary session model in `ctx.model` and `ctx.models.current()` for cross-provider side requests. `ExtensionRunner.emitAfterProviderResponse` accepted the response model but discarded it, so a handler revoking a credential on an HTTP 402 could target the wrong provider. It now threads the response model into the context, matching `emitBeforeProviderRequest` ([#8955](https://github.com/can1357/oh-my-pi/issues/8955)).
- Fixed the TinyFish web search provider ignoring the `lang:`/`language:` query directive, so every request fell back to the API's US/English geolocation. `parsed.lang` now maps onto TinyFish's `location`/`language` parameters (e.g. `lang:it-it` → `location=IT&language=it`), matching the DuckDuckGo, Perplexity, and SearXNG providers ([#8913](https://github.com/can1357/oh-my-pi/issues/8913)).
- Fixed the `/model` Roles panel silently dropping roles and model-keyed fallback chains that fell past the visible panel height: the list had no scroll window, so entries below the cutoff were unreachable with no indication anything was missing. The panel now windows around the cursor like the provider list and shows an `↑/↓ N more` hint when rows are clipped ([#8817](https://github.com/can1357/oh-my-pi/issues/8817)).
- Fixed task and eval subagents discovering newly added agent definitions while resolving their role aliases from stale startup settings. Subagent preflight now atomically reloads persisted settings before agent discovery while preserving live runtime overrides.
- Fixed images returned by tools mounted under `xd://` rendering only as file links instead of inline terminal graphics.
- Resume Cursor idle-stall turns after completed MCP/todo tool results. The watchdog already closes the Connect stream, so unmarked blocks no longer need the `exec-resolved` marker to continue.
- Fixed the Web Search Provider Order settings summary showing providers excluded from web search ([#8884](https://github.com/can1357/oh-my-pi/issues/8884)).
- Fixed subagents aborting when external thinking exposes `think` as the required prelude before their remaining tools become callable ([#8909](https://github.com/can1357/oh-my-pi/pull/8909) by [@olegpulatov](https://github.com/olegpulatov)).
- Fixed session-title generation ignoring user `/skill:<name>` invocations, so titles now see the skill name and args instead of only later assistant text.
- Fixed destructive `rm` escaping the critical-pattern approval check when anything separates the flags from the target, so `rm -rf -- /`, `rm --recursive --force /` and `rm -rf --no-preserve-root /` are now classified critical like `rm -rf /`. `--no-preserve-root` is treated as critical wherever it appears, since it is what defeats coreutils' own refusal to recurse on `/`.
- Fixed thinking-loop aborts (`AIError.Flag.ThinkingLoop`) walking `retry.fallbackChains` and switching to another model family on attempt 1, so a healthy planning turn on Grok 4.6 (SuperGrok / Cursor OAuth) no longer gets replaced by whatever the chain lists next. The loop guard now re-samples the same model with its `thinking-loop-redirect` notice, and no longer parks the model selector on a fallback cooldown. ([#8760](https://github.com/can1357/oh-my-pi/issues/8760))
- Fixed the clipboard image-paste keybind attaching Finder's generated file icon instead of the copied image on macOS. Current Finder `Cmd+C` pasteboards advertise both a `public.file-url` and a generated 1024x1024 icon bitmap, so `arboard::get_image()` succeeded with the icon and `InputController.handleImagePaste` attached it before the file-URL branch was ever reached. The handler now probes `readMacFileUrlsFromClipboard()` before the bitmap representation, so an image file URL wins over the co-advertised icon; pure bitmap pasteboards (screenshots, browser copies) and non-image file URLs still fall through to the image/text paths ([#8769](https://github.com/can1357/oh-my-pi/issues/8769)).
- Fixed the Home Manager module (`programs.omp.settings`) breaking every launch on macOS with `Failed to acquire native file lock … Permission denied (os error 13)`. The declared config is now copied into `~/.omp/agent/config.yml` as a writable file via `home.activation` instead of a read-only `/nix/store` symlink, so OMP can acquire its config lock and persist runtime changes; `home-manager switch` still reapplies the declared settings ([#8775](https://github.com/can1357/oh-my-pi/issues/8775)).
- Fixed OpenCode MCP servers 401ing when config used OpenCode's `{env:VAR}`/`{file:path}` substitution (e.g. `Bearer {env:MCP_KEY}` headers); the OpenCode loader now expands those tokens the way OpenCode does instead of only `${VAR}` ([#8778](https://github.com/can1357/oh-my-pi/issues/8778)).
- Fixed `omp update` leaking Bun's raw `fetch()` error ("pass `verbose: true` in the second argument to fetch()") when a proxy environment variable (`HTTPS_PROXY`, `ALL_PROXY`, …) uses an unsupported scheme such as SOCKS; the update check now reports an actionable message naming the offending variable and the http/https proxy requirement ([#8784](https://github.com/can1357/oh-my-pi/issues/8784)).
- Fixed worker subprocesses (memory embeddings, tiny-model titles, TTS/STT, JS eval, browser relay, LSP mux, daemon broker) running with their cwd pinned to the CLI install directory. They share the agent's foreground process group, and terminal cwd heuristics such as kitty's `new_tab_with_cwd` pick the newest process in that group, so new terminal tabs opened in `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist` while any worker was alive. Workers now spawn with the absolute host entry and inherit the agent's cwd.
- Preserved MCP `ImageContent` tool-result blocks so vision-capable models and the TUI can inspect returned images instead of receiving only a text placeholder ([#8687](https://github.com/can1357/oh-my-pi/issues/8687)).
- Fixed a whole-file `read` of a file with a UTF-8 BOM minting a hashline tag hashed from BOM-bearing text. Because the patcher's live read strips the BOM, the next edit to that file only applied through stale-hash recovery and reported that the file had changed externally when it had not.
- Extension bare imports of workspace members now resolve inside installed git-dependency monorepo plugins (the walk recognizes `workspaces` roots; installed node_modules copies still shadow members)
- Fixed `omp completions <shell>` hanging after writing shell completion scripts to stdout by invoking `postmortem.quit(0)` upon completion. Prevents lingering event loop handles (such as background timers or sockets loaded when inspecting command metadata) from pinning the process and blocking tools like `chezmoi`.
- Fixed `omp --smoke-test` recursively deleting unrelated directories in `os.tmpdir()` (tmux/ssh sockets, editor state, build trees). The smoke broker now keeps its runtime dir under a private parent, and the dead-scope reclaim refuses any root that is not the `daemons` container and only prunes entries named like a 16-hex daemon scope key ([#8721](https://github.com/can1357/oh-my-pi/issues/8721)).
- Fixed high CPU during multi-subagent / workflowz / orchestrate sessions: each live tool block (streaming args, a running partial tool, or a `task` subagent) armed its own 80ms spinner `setInterval` driving `requestComponentRender`, so N concurrent live blocks created N unsynchronized repaint timers that kept the render scheduler awake near-continuously. The per-block timers are now consolidated into a single shared spinner ticker that repaints every live block in one coalesced frame per glyph step, independent of block count ([#8731](https://github.com/can1357/oh-my-pi/issues/8731)).
- Fixed `omp update` writing to the PATH launcher instead of the running binary on binary-only releases (major bumps or `omp.dist: "binary"`): a foreign symlink — e.g. an admin symlink into a shared install — now resolves to its real binary in every distribution channel, avoiding an `EACCES` on a root-owned link directory or a split-brain copy that shadows the shared install. Package-manager launchers keep their deliberate in-place takeover. ([#8732](https://github.com/can1357/oh-my-pi/issues/8732))
- Added `.css` to the built-in Biome server `fileTypes` so CSS files route through Biome's linter/asserter by default instead of requiring a full per-project `fileTypes` override. ([#8741](https://github.com/can1357/oh-my-pi/pull/8741))
- Fixed memory extraction sending its instructions, few-shot examples, and the user's message as a single user turn, which caused small local models to echo the examples instead of extracting facts; instructions now travel as a system turn and the raw text as the user turn
- Fixed local title generation stopping on a stop string that appeared in the prompt instead of the generated tokens
- Fixed the Subagents HUD role display and restored generated task labels by keeping spawn handles separate from UI descriptions.
- Fixed `models.yml` custom-model providers declaring `auth: oauth` being rejected by validation with "apiKey is required", which forced a dummy `apiKey` that then shadowed the broker's OAuth tokens ([#8937](https://github.com/can1357/oh-my-pi/pull/8937) by [@usr-bin-roygbiv](https://github.com/usr-bin-roygbiv)).
- Provider-qualified model selectors (e.g. `anthropic/claude-opus-5`) now fail closed when the named provider is unavailable instead of silently re-binding to OpenRouter's same-named flat id and billing the aggregator ([#8832](https://github.com/can1357/oh-my-pi/issues/8832)).
- Fixed PlanYolo plan approval dropping all MCP tools: the post-handoff tool restore now accounts for MCP discovery that completed while planning instead of restoring a pre-discovery snapshot.
- Fixed parallel `web_search` calls hanging forever past the 60s timeout when the shared headless-browser daemon or page died mid-setup; browser fallback setup and teardown are now abort-protected ([#8865](https://github.com/can1357/oh-my-pi/issues/8865)).
- Fixed extension-package `.mcp.json` `${VAR}` env placeholders (stdio env/command/args/cwd, HTTP url/headers/oauth) reaching MCP servers unexpanded.
- Advisor blocker advisories raised inside the post-interrupt immune window now wake a new turn instead of parking as asides until the next user prompt.
- The exit banner only advertises `omp --resume <id>` when the session was actually written to disk, so the printed command no longer fails for sessions that ended before persistence ([#8860](https://github.com/can1357/oh-my-pi/issues/8860)).
- Fixed terminals that deliver Shift+Enter as a bare LF (or the legacy CSI `13;2~` form) getting a plain switch instead of summarize-and-switch in the `/tree` selector ([#8821](https://github.com/can1357/oh-my-pi/issues/8821)).
- Fixed OMP panicking at startup when the host environment contains a non-UTF-8 variable value; such entries are now skipped when copying the host environment into the shell ([#8925](https://github.com/can1357/oh-my-pi/issues/8925)).
- Fixed `/mcp reauth` refusing to run the OAuth flow for HTTP MCP servers that allow unauthenticated `initialize` but require auth for `tools/call`; endpoint discovery now runs against the server URL before giving up ([#8922](https://github.com/can1357/oh-my-pi/issues/8922)).

## [17.3.7] - 2026-08-17

### Changed

- Send the `omp/<version>` User-Agent on xAI chat (`xai` and `xai-oauth`) unless the request already set its own ([#8840](https://github.com/can1357/oh-my-pi/pull/8840) by [@Jaaneek](https://github.com/Jaaneek)).

## [17.3.6] - 2026-08-17

### Added

- Added `ExtensionAPI.registerFileWriteFallback(handler)` and `ExtensionAPI.registerFileDeleteFallback(handler)`, letting an extension supply a fallback writer or deleter that is consulted when a native `write`, `edit`, or `apply_patch` byte-write or unlink is denied with a permission error (`EPERM`/`EACCES`/`EROFS`) — for hosts that embed the agent inside a sandbox that denies direct filesystem access but exposes a privileged channel. The brokered path is symlink-resolved so a handler's allowlist sees the real destination, a destination that cannot be resolved is not brokered at all, and `req.sessionId` names the session that issued the mutation so a handler sharing the process-wide registry can enforce policy per session. See [`docs/extensions.md`](../../docs/extensions.md).

### Changed

- Updated the default model for XAI_API_KEY (xai) and SuperGrok OAuth (xai-oauth) to grok-4.6. Automatic model selection continues to prefer paid xai/grok-4.6 when only XAI_API_KEY is set, with xai-oauth/grok-4.6 still available explicitly.

### Fixed

- Fixed `omp stats` and `/stats` dashboards being unreachable from container hosts by accepting an explicit `--host` bind address while preserving the `127.0.0.1` default.

## [17.3.5] - 2026-08-16

### Added

- Added Extensions tab group to settings schema

### Changed

- Routed paid xAI models (XAI_API_KEY / xai/…) through the Responses API used by SuperGrok OAuth instead of Chat Completions, including reliable replay of encrypted reasoning content on follow-up turns.
- Updated the default model for XAI_API_KEY (xai) to grok-4.5, and the default SuperGrok OAuth (xai-oauth) model to grok-4.5. Automatic model selection continues to prefer paid xai/grok-4.5 when only XAI_API_KEY is set, with xai-oauth/grok-4.5 still available explicitly.
- Stopped sending presence/frequency penalties and stop sequences to xAI reasoning models such as grok-4.5, which reject them.

### Fixed

- Fixed `hub` job and wait lists hiding stale running subagent registrations that have no turn in flight, ensuring they remain visible so operators can cancel them
- Fixed external thinking scratchpads running alongside native reasoning on xAI Grok 4 and other reasoning-only Responses models that reject `reasoning.effort`
- Fixed llama.cpp model discovery producing a baseUrl without the /v1 prefix for non-Qwen models, causing 404 errors on OpenAI-compatible endpoints.
- Fixed prompt caching on open-weight providers (DeepSeek, Qwen, GLM, …) so tool schemas stay cached across directory changes and midnight rollovers.
- Fixed omp --fork omitting the source session's artifact directory, so CLI-created forks now preserve artifact:// references like interactive /fork.
- Fixed long ask option labels being hard-truncated at the terminal width; labels now wrap onto indented continuation lines.
- Fixed toggling display.showTokenUsage from /settings leaving existing token-usage rows stale until the transcript was rebuilt.
- Fixed mid-run auto-compaction blocking the live loop while waiting on extension handlers, which could hang after a snapcompact or context-full pass.
- Reduced peak memory for persisted subagent revival probes by streaming large file-backed session journals instead of loading them fully.
- Improved responsiveness of streaming edit previews for large diffs by rendering only the visible tail.
- Fixed repeated /btw panels committing transient frames to native scrollback and replaying conversation history after dismissal.
- Clarified that closing browser tool sessions releases managed handles without closing pages in spawned, CDP-connected, or relay browsers.
- Fixed interrupted vibe_wait calls being reported as elapsed timeout windows.
- Improved checkpoint/rewind prompt rendering to stay accurate after a rewind and be more concise.
- Fixed Cursor turns dying with HTTP/2 stream errors (NGHTTP2_INTERNAL_ERROR / NGHTTP2_REFUSED_STREAM) after tool calls already had results, instead of leaving the agent idle until the user typed "continue".
- Fixed mixed-case plugin tool names being lowercased during tool-set refresh, which unmounted them from xd:// whenever MCP tools connected.
- Fixed Exa MCP servers being unmounted when their config explicitly requests tools the native Exa integration does not provide, breaking /mcp reconnect exa.
- Fixed Claude Code custom tool discovery attempting to import non-module files from .claude/tools.
- Fixed Agent Hub parking a mid-spawn child session so subsequent task calls failed with an ownership error and the row could never be revived.
- Fixed the welcome banner displaying a stale model name when the session's active model changes after startup (e.g. after a delayed config load or an explicit /model switch).
- Fixed Nix standalone binaries retaining Bun's build-time package in their runtime closure.
- Fixed birch user/custom message card contrast on dark terminals, where chat bubbles could render light-on-light.
- Fixed hidden tool snapshots preventing long streamed assistant responses from entering terminal scrollback.
- Prevented omp models from loading ambient hook factories while preserving extension-contributed providers.
- Fixed the ask dialog's multi-select mode dead-ending on Enter; Space now toggles options and Enter submits the current selection.
- Fixed workspace diagnostics reporting a clean workspace when its checker crashed without producing output.
- Fixed manual /compact failing outright when a summarization request hit a transient provider overload.
- Fixed transient Anthropic failures (overloaded_error, rate_limit_error, 429/500/502/503/529) aborting or silently degrading side-effect-free background LLM calls such as session title generation, TTS speech enhancement, commit-message generation, thinking/stop classifiers, memory extraction/consolidation, and commit analysis/summary/changelog passes; these now retry with backoff honoring retry-after instead of failing or returning an indistinguishable empty result.
- Fixed the shared headless browser daemon launching from the macOS system Google Chrome bundle, which could cause macOS to route the user's link clicks to the automation daemon and silently swallow them; the daemon now prefers an isolated Chrome for Testing binary on macOS.
- Reclaimed abandoned daemon runtime directories under ~/.omp/run/daemons/, preventing unbounded growth of leftover Chromium profiles and broker state.
- Kept the welcome screen's Tips, LSP Servers, and Recent sessions visible when a long model name still leaves enough terminal width for both columns.
- Fixed focused shimmer animation frames (ultrathink, orchestrate, workflowz) repainting the full TUI too frequently, causing high CPU usage while composing prompts on WSL2.
- Fixed the /debug report bundle including unrelated historic sessions, leaking other sessions' files and bloating archives.
- Fixed adopted keep-alive agents remaining stuck in a running state in the registry after deferred turn settlement, and prevented stale refs from sustaining bare hub wait calls indefinitely.
- Fixed home-relative marketplace catalog paths not being expanded before cache access, preventing updates from writing into a literal ~ directory.
- Fixed broker-owned headless Chromium opening and retaining an unowned blank foreground window on Windows.
- Fixed the auto thinking classifier failing every turn on Anthropic models served through LiteLLM/Vertex due to a thinking-budget mismatch.
- Fixed always-ask approval prompts bypassing edit preview readiness when a built-in tool executes under its wire-level alias, such as edit running as apply_patch.
- Fixed lsp reload crashing non-rust-analyzer language servers by sending them a rust-analyzer-specific request; that request is now gated to rust-analyzer only.
- Fixed browser open failing with "Shared browser daemon unavailable" when HTTP_PROXY/HTTPS_PROXY is set, because liveness probes were incorrectly routed through the proxy.
- Fixed defaultThinkingLevel: auto skipping classification for user-invoked /skill:<name> turns, leaving the effort stuck on pending auto.
- Fixed custom-tool directory discovery recursing into subtrees despite a non-recursive default, which could crash startup when scanning large dependency directories such as Python venvs.
- Repaired torn session JSONL appends after disk-write failures, rewrote malformed resumed files before their next append, retried transient persistence failures, and surfaced failures in the TUI.
- Prevented Anthropic model fallback from replaying model-bound thinking blocks across models, and surfaced immutable-thinking errors without retrying the unchanged invalid turn.
- Fixed empty-stop failure messages always suggesting a context problem even when the provider billed output tokens; the message now reports the billed token count and points at a provider-side filter/translation issue when appropriate.
- Fixed a parked, session-less agent-registry entry with no reviver permanently poisoning its agent id, preventing fresh subagent spawns from reusing that id.
- Made extension tool-call timeouts configurable and paused them during user dialogs.
- Fixed /vibe cancellation leaving an in-flight model turn unaware that Vibe mode and its tools were removed.
- Fixed empty local-model stops lingering on the persisted active branch after retries, preventing them from resurfacing after reload or a mid-retry process kill.
- Fixed the Biome linter client silently dropping every diagnostic due to an outdated JSON output schema; it now supports Biome 2.x's diagnostic format.
- Fixed `hub jobs` and empty `hub wait` snapshots hiding running subagents that have no live turn, which removed the only way to discover and `hub cancel` a stale registration; such agents are listed again and flagged as having no turn in flight.
- Fixed external thinking being offered on xAI reasoning-only Responses models (grok-4 family) that reject `reasoning.effort`, where the private scratchpad ran alongside native reasoning instead of replacing it.
- Fixed the extension tool-call handler timeout rendering outside a titled section in `/settings` by registering its Extensions group on the Tools tab.

## [17.3.4] - 2026-08-14

### Changed

- Replaced the MuPDF-WASM PDF document backend with `pdf-inspector` through `@oh-my-pi/pi-natives`, preserving cached text conversion and PDF line selectors while reporting pages that need OCR.
- Restored `read <pdf>:` and `read <pdf>:<image>.png` page rendering by automatically capturing PDF pages through the headless Chromium browser tool.

### Fixed

- Fixed Streamable HTTP MCP sessions being invalidated by opening the optional GET SSE stream before sending `notifications/initialized`, which prevented Figma Dev Mode MCP from connecting ([#8514](https://github.com/can1357/oh-my-pi/issues/8514)).
- Fixed the `/hotkeys` table describing Ctrl+D (`app.exit`) as "Exit (when editor is empty)" when it actually exits unconditionally and saves the current prompt as a resumable draft ([#8530](https://github.com/can1357/oh-my-pi/issues/8530)).
- Fixed Ctrl+G external editors failing to launch on Windows because Bun re-quoted the embedded `cmd.exe /c` command line ([#8544](https://github.com/can1357/oh-my-pi/issues/8544)).

## [17.3.3] - 2026-08-14

### Fixed

- Automatically continued Gemini turns that stopped after thinking without final output, using a bounded final-answer reminder instead of exhausting generic retries.
- Retried Gemini `MALFORMED_FUNCTION_CALL` failures when every emitted tool call was proven unexecuted, while preserving real tool-result and visible-output replay guards.
- Kept current terminal retry errors in one pinned banner with attempt context while surfacing local continuation failures instead of stale provider errors.

## [17.3.2] - 2026-08-13

### Fixed

- Fixed the parent TUI stalling after a subagent submits its result until terminal focus or resize wakes the event loop ([#8462](https://github.com/can1357/oh-my-pi/issues/8462)).
- Fixed `omp update` misclassifying foreign npm/bun bin aliases while preserving package-manager ownership for globally linked checkouts ([#8468](https://github.com/can1357/oh-my-pi/issues/8468)).
- Fixed `read` hashline headers collapsing nested in-workspace paths to the bare basename, which let a same-basename file at the session cwd capture a verbatim follow-up `edit` and deterministically reject it with `hash is not from this session`. Headers now retain the workspace-relative path (e.g. `[src/settings.json#0063]`) ([#8482](https://github.com/can1357/oh-my-pi/issues/8482)).

## [17.3.1] - 2026-08-13

### Fixed

- Fixed Claude Code user discovery ignoring CLAUDE_CONFIG_DIR for configuration, plugins, MCP servers, and imported sessions.
- Fixed the status-line git branch display freezing after switching branches.
- Fixed Pi extension contexts omitting the runtime mode, which caused TUI guards to silently disable extension UI.
- Fixed extension-registered tool names being rejected by the --tools flag before extension discovery, which prevented least-privilege sessions from allowlisting plugin tools.
- Fixed omp plugin install failing with cloning errors for legacy Pi extensions whose tool schemas use legacy-typebox builders.
- Fixed omp update aborting with chmod ENOENT when concurrent update runs overlapped by using unique download temporary paths.
- Fixed the browser tool executable probe launching the user's installed GUI Chromium on Windows: the `--version` version probe from ecb22957 was Linux-scoped but ran for every platform candidate, so on Windows it could hand off to a running `chrome.exe`, open a normal browser window, then reject the candidate and fall back to cached Chrome for Testing. The probe is now confined to Linux ([#8445](https://github.com/can1357/oh-my-pi/issues/8445)).

## [17.3.0] - 2026-08-13

### Breaking Changes

- Removed the global `advisor.subagents` setting. Subagent advisors are now configured per agent via frontmatter or `task.agentAdvisor`. Existing configurations of `advisor.subagents: true` will automatically migrate to `task.agentAdvisor: { task: "on" }`.

### Added

- Added Astral `ty` as a built-in fallback Python LSP server (`ty server`), ordered behind `pyright`, `basedpyright`, and `pylsp`.
- Added first-party Nix support, including reproducible source builds for Linux and macOS, a pinned development shell, NixOS and Home Manager modules, and offline Bun dependency support.
- Added support for per-agent advisors configured via the `advisor` frontmatter field or the `task.agentAdvisor` settings, allowing different agents to be advised by different models.
- Redesigned the `/agents` interface as a fullscreen hub featuring a scope sidebar, type-to-filter search, a pinned detail pane, mouse support, and interactive property chips for configuring agent settings.
- Prepared for the upcoming npm package rename by updating `omp update` and startup version checks to follow the `omp.rename` pointer in the published manifest.

### Changed

- Updated `/usage`, `omp usage`, and the status line to display authoritative OpenCode Go quota usage directly from the official endpoint, replacing estimated costs with actual usage across three time windows (5h, 7d, and monthly).
- Documented the source-available local protocol relay and clarified that production collaboration relay binaries are not currently published.
- Enabled bounded Anthropic prompt-cache refreshes for the main agent loop while isolating advisor and side-channel requests from the shared refresh timer.

### Fixed

- Fixed multiple Language Server Protocol (LSP) issues, including concurrent sessions sharing backend overlays, stale document overlays after workspace edits, incorrect transactional edit advertisements, unhandled snippet placeholders in rust-analyzer, and failing to restore overwritten targets during failed file renames.
- Fixed LSP `diagnostics` incorrectly reporting success when all language servers failed.
- Fixed Hindsight memory scoping splitting repositories across multiple scopes on case-sensitive filesystems by lowercasing the project label.
- Fixed the CLI crashing at startup with a raw `AuthBrokerError` when the configured auth broker is unreachable, replacing it with an actionable error message.
- Fixed various resource and process leaks, including idle launch brokers staying alive indefinitely, stale MCP connections leaving child processes open, and undrained stdout in DAP `runInTerminal` requests.
- Fixed custom STB-backed vision providers failing to decode WebP images by automatically detecting image formats from bytes and normalizing WebP blocks.
- Fixed command-backed provider API keys (`!command`) staying pinned to cached values after receiving an HTTP 401 error.
- Fixed the `/agents` Control Center failing to open when model overrides are configured as YAML arrays.
- Fixed session-title generation regressions by restoring plain-sentence phrasing and name-fidelity instructions.
- Fixed agent-facing prompts and system instructions mentioning tools that are absent from the current session catalog.
- Fixed manual `/shake` discarding all tool results; it now retains a small recent tail of results to preserve active working context.
- Fixed `omp install` failing validation for extensions importing legacy `is<Tool>ToolResult` event guards.
- Fixed profile aliases generated by standalone binaries invoking Bun's embedded virtual script instead of the installed `omp` command.
- Fixed `/skill:<name>` tokens in `/plan` or `/vibe` inline prompts being treated as literal text instead of executing the skill.
- Fixed long streaming `write` previews stalling the TUI by optimizing file scanning and splitting.
- Fixed the Windows console disappearing when running commands like `/stats`.
- Fixed retry-fallback selection switching to a fallback model with a context window too small to hold the current session context.
- Fixed OpenCode discovery ignoring `opencode.jsonc` files and rejecting comments in `opencode.json`.
- Fixed WSL2 startup hanging forever when the Windows interop pipe is wedged: the WSL host-home discovery probes (`cmd.exe`, `wslpath`) now run under a 500ms hard timeout and fall back to the Linux `$HOME`/`~/.omp` candidates ([#8402](https://github.com/can1357/oh-my-pi/issues/8402)).

## [17.2.15] - 2026-08-12

### Added

- Added `--external-thinking` CLI flag to force external thinking tool activation.
- Added `omp compress` command, which uses an isolated, two-tool agent loop to rewrite single or multiple text files (supporting glob patterns and concurrent processing) into dense prompt registers.
- Expanded tool discovery in `omp cleanse` to support `staticcheck` and `golangci-lint` (Go); `mypy`, `pylint`, `flake8`, `ty`, and `basedpyright` (Python); `oxlint`, `deno lint`, `stylelint`, and `vue-tsc` (JS/TS); and `actionlint` (GitHub Workflows).
- Added support for natural language requests in `omp cleanse "<request>"`, which launches a discovery subagent to automatically inspect the project, determine the correct commands, and map outputs.
- Added an interactive picker to `omp cleanse` when run without arguments on a TTY, allowing users to run all checkers, select a specific checker, or describe what to fix.

### Changed

- Restricted the `think` tool to GPT, Claude, and Gemini transports that support native reasoning replacement.
- Increased the default subagent cap for `omp cleanse` from 8 to 32.

### Fixed

- Fixed a hang in headless `omp -p` runs when `plan.defaultOnStartup: true` is enabled by disabling the startup default in print mode.
- Fixed `display.hideToolActivity` failing to hide certain activity blocks, such as reminders, diagnostics, and completions.
- Fixed several issues in the MCP Streamable HTTP transport, including updating the negotiated protocol version to `2025-11-25`, resolving connection drops and SSE resumption gaps, and preventing double-execution of tools during auth refreshes.
- Fixed `/handoff` losing local artifacts (plans, scratch files, research notes) by copying them across the handoff session boundary.
- Replaced libarchive-based tar parsing with a hardened, in-process tar reader to prevent crashes and safely handle complex archive structures, symlinks, and sparse metadata.
- Fixed `Ctrl+O` tool-output expansion failing to reach launch-completion messages wrapped in the hidden tool activity container.

## [17.2.14] - 2026-08-11

### Added

- Added `externalThinking` setting for private scratchpad reasoning via the new `think` tool

## [17.2.13] - 2026-08-11

### Added

- Added `searxng.safesearch` setting option for SearXNG searches
- `omp update` now honors an `omp.dist` distribution field published in the release's npm manifest and treats major-version bumps without one as binary-only: bun/npm-managed installs are migrated to the standalone GitHub release binary in place instead of running a package-manager install that a non-npm release (e.g. a runtime change) would break. Windows script-shim installs (npm's `omp.cmd`/`omp.ps1`) are taken over seamlessly by installing `omp.exe` beside the shims and retiring them.
- Added support for Cloudflare AI Gateway routing for Gemini search
- Added support for Exa MCP search provider
- Added domain inclusion/exclusion filtering and URL deduplication for TinyFish search
- Fixed `/vibe` mode losing the pre-vibe toolset when a session already in vibe mode switches into another session that is also in vibe mode, which left `bash`, `edit`, `write`, `grep`, `glob`, `task`, and `hub` silently unavailable after exiting the mode; the pre-vibe toolset is now recorded on the `mode_change` entry and restored from there.
- Preserved extension-filtered pasted image payloads and source links when `/goal`, `/plan`, or `/vibe` submits the composer draft.
- Fixed Agent Hub lineage registration timestamps displaying in UTC instead of the user's local timezone.
- Fixed Python/Julia/Ruby eval kernels failing to start after their staged runner script was cleared mid-session (e.g. a macOS tmpdir sweep): the memoized runner path is now re-validated so a long-lived process self-heals instead of only recovering on restart ([#8140](https://github.com/can1357/oh-my-pi/issues/8140)).
- Fixed session resume fully reading and parsing the journal twice by reusing the entries already loaded by `SessionManager.open()` ([#8117](https://github.com/can1357/oh-my-pi/issues/8117)).
- Fixed RPC `message_end` frames being serialized more than once before output while preserving v1 and v2 wire bytes ([#8118](https://github.com/can1357/oh-my-pi/issues/8118)).
- Fixed message conversion caching strongly retaining the last session transcript and converted output after session disposal ([#8119](https://github.com/can1357/oh-my-pi/issues/8119)).
- Fixed timed-out LSP requests continuing to consume server CPU and block queued requests by sending `$/cancelRequest` ([#8116](https://github.com/can1357/oh-my-pi/issues/8116)).
- Fixed `shutdownAll()` leaving the configured LSP idle checker alive and preventing short-lived SDK hosts from exiting ([#8115](https://github.com/can1357/oh-my-pi/issues/8115)).
- Fixed terminal Mermaid borders and junctions using low-contrast UI chrome colors instead of the active theme's readable content color.
- Fixed Cursor provider sessions flooding bash/grep validation errors (`cwd`/`case`/`skip` "was undefined") when Cursor omitted optional exec-frame fields; the exec bridge now omits unset optional kwargs before tool execution and transcript synthesis.
- Added structured reset-reason logging to advisor context re-primes (issue #7226): every history-rewrite trigger (compact, auto-compaction, compaction-rescue, shake, drop-images, prune-tool-outputs, prune-stale-tool-results, conversation-boundary, context-maintenance) now emits an `advisor context reset` debug event with its reason, so full-transcript replays can be attributed to a concrete path.
- Added `quarantine-recovery` and `quarantine-retry-exhausted` reset reasons to advisor context-reset debug logs, so advisor full re-primes after quarantined output remain attributable without changing quarantine retry semantics (issue #7226).

### Changed

- Standardized first-party outbound User-Agent headers on `omp/<version>` via the shared `USER_AGENT` utility.

### Fixed

- Fixed `/usage`, `/advisor status`, and every other panel command answering only after the agent stopped working. Since `17.0.1` their output was queued until the turn settled (to stop mid-turn transcript mounts duplicating rows in native scrollback, issues #4806/#6767), and the deferral was silent, so on a long turn the command was indistinguishable from a dead one. The panel now renders immediately above the editor in an anchored container that is cleared and rebuilt in place, never entering the transcript, and the full output still lands in the transcript at the next settle. The preview is capped to 40% of the viewport (minimum 6 rows) so a tall report cannot push the prompt off screen.
- Fixed the todo panel showing no progress while the agent worked through a plan: every sub-todo read as unchecked no matter how far along the run was. Three causes, all in the collapsed (default) view — the walking viewport dropped *every* closed row, so a completion only ever removed a line and the card's strike-reveal animation ran against a row nobody rendered; the phase the agent was actually in was the one phase header rendered without a `done/total` count; and the 60s todo auto-clear deleted closed tasks from an unfinished plan, resetting the phase counter to `0/n` and renumbering the stages until the next `todo` call restored the real snapshot. The viewport now keeps the newest closed task as a checked lead row (additive to the open-task cap), every phase header carries its progress, counts include abandoned tasks, and auto-clear only fires once the whole list is settled.
- Status-line `usage` now renders monthly Cursor quotas (`mo N%`) in addition to the existing `5h` / `7d` windows ([#7998](https://github.com/can1357/oh-my-pi/pull/7998) by [@dnth](https://github.com/dnth)).
- Restored the `ctx.ui.custom()` overlay API that regressed after v0.45.6: `overlayOptions` (anchor/width/maxHeight/margin positioning and sizing) is now forwarded to `showOverlay` instead of a hardcoded full-cover geometry, `onHandle` receives the resulting `OverlayHandle`, and `OverlayHandle`/`OverlayOptions` are exported from the extension API types again.
- Fixed a content refusal that arrives after the model already emitted a tool call ending the turn outright instead of consulting the model fallback chain. When the refused turn produced nothing visible and every emitted tool call provably never executed (each paired with a synthetic `executed: false` result), the turn is now retryable and the configured `retry.fallbackChains` entry gets its chance, matching how a refusal with no tool calls already behaves.
- Fixed proxy discovery preferring the bundled catalog name over the proxy-reported name, so `omp models refresh` now updates stale display names (e.g. a proxy serving `longcat-2.0` as `"LongCat"` no longer shows the raw id).
- Fixed the compiled binary build on Windows: `Bun.Glob.scan` yields backslash-separated paths, which the legacy Pi virtual module used verbatim for export keys and generated identifiers, producing invalid JavaScript.
- Fixed Ctrl+O (`app.tools.expand`) not expanding truncated tool output while a tool-approval prompt or other selection dialog held keyboard focus, by promoting the shortcut to a global input listener that fires regardless of focus (it still defers to fullscreen overlays and the tree selector's own Ctrl+O filter cycle) ([#7837](https://github.com/can1357/oh-my-pi/issues/7837)).
- Fixed `omp commit` printing a wall of bundled source when a `pre-commit`/`commit-msg` hook refuses a commit: hook failures are now reported with the hook's own message, split plans report how far they got, and the command exits non-zero cleanly ([#7834](https://github.com/can1357/oh-my-pi/issues/7834)).
- Fixed `omp commit --push` exiting 0 without pushing when the working tree is already clean; it now pushes the existing commits (or fails non-zero if the push is refused) ([#7834](https://github.com/can1357/oh-my-pi/issues/7834)).
- Subagents spawned through a model-role alias now inherit that role's `retry.fallbackChains` entry instead of the `default` chain. Both spawn paths (`task` and vibe workers) expand the alias — the bundled `task` agent's `@task`, `sonic`/`scout`'s `@smol` — before it reaches the executor, so the role identity was lost and every child was pinned to the `default` chain, routing retries onto models the operator had deliberately kept out of the role's chain. Completes [#7694](https://github.com/can1357/oh-my-pi/pull/7694), which only covered agents whose unexpanded alias reached the executor ([#7910](https://github.com/can1357/oh-my-pi/pull/7910) by [@enieuwy](https://github.com/enieuwy)).
- Fixed standalone `AGENTS.md` discovery stopping at nested Git repository roots, so enclosing workspace instructions are loaded while home-level instructions remain scoped correctly.
- Split the advisor Session update delivery into per-source-message user messages (single `Agent.prompt(AgentMessage[])` call) so provider prompt caches grow with the session instead of staying pinned at the instructions/tools boundary; rendering stays byte-identical to the old single-block update.
- Restore the advisor primary-context dedup map when a failed advisor turn is rolled back, so retried batches re-deliver first-time plan/goal context in full instead of collapsing it to "(unchanged — still in effect)".
- Include all renderer-read fields (excludeFromContext, bashExecution command, pythonExecution code, branch/compaction summary + fromId, fileMention files) in advisor prefix fingerprints so clones changing only those fields correctly trigger a re-render.
- Fixed Gemini advisors treating a valid silent review as an empty-response failure, repeatedly retrying the turn and eventually dropping the advisor backlog. ([#8223](https://github.com/can1357/oh-my-pi/issues/8223))
- Fixed bash-tool commands receiving an unguarded `CI=1`, which broke clap-based CLIs (e.g. `tauri android build`) that parse `CI` as a strict boolean, and ignored the documented `PI_BASH_NO_CI` opt-out. The per-command env now injects clap-compatible `CI=true` and honors `PI_BASH_NO_CI`/`CLAUDE_BASH_NO_CI` ([#8229](https://github.com/can1357/oh-my-pi/issues/8229)).
- Fixed macOS key hints rendering the Linux/Windows modifier names `Alt` and `Super` across every hint surface (`/hotkeys`, status bar, autocomplete, pending-message bar, copy selector, ask dialog): `alt` now renders as `Option` and `super` as `Cmd` on darwin, and the static `/hotkeys` navigation rows are platform-aware instead of hardcoding macOS `Option`/`Cmd` names on every platform ([#8235](https://github.com/can1357/oh-my-pi/issues/8235)).
- Fixed `omp plugin uninstall <plugin> --dry-run` actually removing the plugin on both the npm and marketplace routes; dry-run now reports what would be removed and leaves installed plugin state unchanged ([#8178](https://github.com/can1357/oh-my-pi/issues/8178)).
- Fixed handled OMP shutdown persisting running subagents as terminally aborted instead of restoring their transcripts as parked and revivable. ([#8216](https://github.com/can1357/oh-my-pi/issues/8216))
- Fixed `always-ask` approval prompts opening before large edit previews finish rendering, preventing blind approvals ([#7957](https://github.com/can1357/oh-my-pi/issues/7957)).
- Fixed Pi-compatible extensions registering tools during asynchronous session startup being omitted from the live model tool registry.

### Removed

- Removed the `resolveAgentModelSource` model-resolver export, whose only use was being fed to `resolveExplicitModelRole`. Replaced by `resolveAgentModelSelection`, which returns the expanded `patterns` and the pre-expansion `role` together so a spawn path cannot derive one without the other ([#7910](https://github.com/can1357/oh-my-pi/pull/7910) by [@enieuwy](https://github.com/enieuwy)).
- A run is now attributed to the model that actually produced its output, not whichever model the session was last pointed at. A retry fallback that errored on its first request — an exhausted quota, a hard provider error — was credited with the whole run in the Agent Hub row and the settled task result, even when the previous model did every turn. Sessions expose the serving model directly, holding the last model that produced output while a candidate is armed but unproven, and transcript-derived history stops at the newest turn that produced output.

## [17.2.12] - 2026-08-08

### Fixed

- Fixed shell minimization replacing meaningful `rustc --print` output with `OK`.
- Fixed shell minimization altering outputs shorter than 1,000 characters; these now pass through unchanged.
- Fixed primary and advisor Codex sessions falling back to another provider before trying sibling accounts when an account lacks Trusted Access for Cyber approval.
- Fixed task subagent assistant turns being omitted from the per-model TPS/TTFT aggregates shown by `/models`. ([#8022](https://github.com/can1357/oh-my-pi/issues/8022))
- Fixed terminal-title spinner writes consuming CPU during WSL/ConPTY agent waits by using the same static working separator as native Windows ([#8012](https://github.com/can1357/oh-my-pi/issues/8012)).
- Fixed long-running sessions leaking memory for every completed keep-alive `task`/scout subagent: a disposed (parked) subagent's `AgentSession` stayed pinned through the lifecycle adoption record's reviver closure, and `dispose()` never released the message array, append-only provider transcript, session-manager entries, or the raw-SSE debug buffer, so heavy transcripts and captured provider wire frames accumulated for the process lifetime ([#8003](https://github.com/can1357/oh-my-pi/issues/8003)).
- Fixed Z.AI web search dropping sources and exposing raw JSON when MCP responses double-encode content text ([#8000](https://github.com/can1357/oh-my-pi/issues/8000)).
- Fixed `/handoff` masking empty/whitespace-only generation and harness-initiated aborts as "Handoff cancelled"; manual empty generation now surfaces a logged failure, harness aborts preserve their reason (or report "Handoff aborted by session"), and auto-handoff still falls back to context-full compaction ([#7993](https://github.com/can1357/oh-my-pi/issues/7993)).

## [17.2.11] - 2026-08-07

### Added

- Added support for the Agent Plugins 1.0.0 standard, enabling automatic discovery, validation, and secure execution of compliant plugin packages.
- Added the `omp share <session>` command to share saved sessions by ID prefix or file path without launching the agent.
- Added the `AGENT=1` environment variable to child processes spawned by `coding-agent` to allow downstream tools to detect agent-driven execution.

### Changed

- Consolidated Exa web-search configuration under `exa.enabled`, automatically migrating legacy `exa.enableSearch` values and removing obsolete Researcher and Websets settings.
- Removed stale `computer.backend` values during configuration migration.
- Updated documentation and error messages for the JavaScript/TypeScript debug adapter (`js-debug-adapter`) to clarify supported installation paths (Mason, standalone tarball, or `JS_DEBUG_DAP_SERVER`).

### Fixed

- Fixed an issue where `/reload-plugins` and the Agent Control Center failed to propagate updated agent definitions to existing tools without a restart.
- Fixed legacy Pi extensions failing to load when calling `pi.unregisterProvider()`, ensuring provider replacements take effect immediately.
- Fixed zero-width daemon readiness and wait regex matches being rejected by the hub wire decoder.
- Fixed proxy model discovery preferring bundled catalog names over proxy-reported names, allowing `omp models refresh` to correctly update display names.
- Fixed Windows compiled binary builds failing due to backslash-separated paths in `Bun.Glob.scan` producing invalid JavaScript in virtual modules.
- Fixed the Ctrl+O (`app.tools.expand`) shortcut not expanding truncated tool output when a tool-approval prompt or selection dialog had keyboard focus.
- Improved `omp commit` error reporting when pre-commit or commit-msg hooks fail, displaying the hook's own message and exiting non-zero cleanly instead of printing bundled source code.
- Fixed `omp commit --push` exiting with code 0 without pushing when the working tree is already clean; it now correctly pushes existing commits.
- Fixed `omp commit` exiting with code 0 when the commit agent failed and fell back to a mechanical commit; it now exits non-zero to indicate the fallback was used.
- Fixed strict output schemas being rejected when native JSON Schema definition maps contain `ref` or applicator branches use `properties` without `type`.
- Fixed shell syntax extraction in `cd <path> && ...` commands to prevent redirects, extra arguments, or shell expansions from being incorrectly absorbed into the structured working directory path.
- Applied reason-specific backoff to transient rate-limit retries and consolidated exhausted retry errors.
- Fixed session-tree rows rendering as empty bullets for bookkeeping entries (such as title changes, credential pins, and mode changes); these are now hidden by default and properly labeled in `all` mode.
- Fixed extension and custom tools inheriting same-named built-in TUI renderers, which could overwrite successful results with incorrect status text.
- Fixed prewalk lifecycle handling to prevent plan injection on rejected same-model/same-effort arms, ensure consumed plan nudges do not return after context rebuilds, and prevent settings-enabled prewalk from implicitly re-arming restored sessions.
- Fixed the todo completion reminder interrupting pauses when waiting for non-English questions (such as Chinese, Japanese, Korean, or Spanish prompts ending in `？` or `?`).
- Normalized resolved file paths in read summaries, PDF image handles, and notebook errors to prevent agents from learning malformed paths.
- Fixed a bug where a per-turn `before_agent_start` system prompt override was silently dropped during base-prompt rebuilds.
- Fixed ACP `session/load` and `session/resume` failing with `ACP session not found` for sessions created under the legacy hashed project-directory scheme by falling back to a global ID scan.
- Fixed `vault://<name>?op=...` commands targeting the active vault instead of the named vault in Obsidian CLI queries.
- Fixed the status-line `session_name` segment to honor the `statusLine.sessionAccent` setting, falling back to the theme's accent color when disabled.
- Fixed automatic `agent.continue()` paths failing to run context-fit maintenance when reverting to a smaller-context model after a cooldown expiry.
- Fixed `/handoff` reporting "Handoff cancelled" for actual generation or stream timeout errors, ensuring the real error is surfaced.

## [17.2.10] - 2026-08-06

### Breaking Changes

- Replaced the re-exported `zod` API with an `omptype`-backed compatibility facade (`@oh-my-pi/omptype/zod`). Plugins retain the standard Zod-style builder interface, but real Zod-specific APIs are no longer available.

### Added

- Added a `--trusted-extension <absolute-path>` CLI flag to load an exact extension-module allowlist, bypassing ambient extension discovery.
- Added resumable session details to fatal crash outputs, including a suggested `omp --resume <session-id>` command to quickly resume persisted live agent sessions.

### Changed

- Reworked the Ctrl+S Agent Hub into a responsive fullscreen roster and selected-agent inspector, featuring aggregate status/usage metrics, detailed per-agent views (task, model, activity, usage, lineage), roster and spawn-tree views, stable ordering, asynchronous persisted-session discovery, restored historical metadata, and improved keyboard and mouse navigation.
- Replaced `arktype` with `@oh-my-pi/omptype` for all tool parameter and configuration schemas, resulting in significantly faster startup times. Configuration schema errors are now reported via `OmpErrors` entries using the standard `path`/`problem` format.

### Fixed

- Fixed panel commands (such as `/usage` and `/advisor status`) appearing unresponsive during active turns by flushing the deferred-panel queue at every settle, terminal or not. The deferral itself stays silent: mounting a status line into the transcript mid-turn re-renders rows below the live block and duplicates them in native scrollback (issues #4806/#6767).
- Fixed the bundled `ts-no-tiny-functions` rule failing to match one-line arrow functions in files with trailing newlines.
- Fixed advisor refusals skipping the model fallback chain, and bounded refusal recovery to a single attempt per model to prevent infinite fallback loops.
- Fixed repeated `/mcp reauth` commands getting stuck by ensuring new reauthorization requests cancel and clean up any pending MCP OAuth login flows.
- Fixed WSL host-home resolution to build `/mnt/<drive>/...` fallback paths using POSIX semantics regardless of the host platform.
- Fixed Python evaluation shell helpers (`!cmd`, `%%bash`, `%pip`) letting child processes inherit the runner's stdin, which previously caused deadlocks on Windows. Additionally, `%%bash` now correctly resolves Git Bash on Windows.
- Fixed subagents spawned via model-role aliases incorrectly falling back to the `default` role's retry chain instead of their own configured role chain.
- Fixed Linux/X11 clipboard reads failing when `xclip` is missing but `xsel` is available.
- Hardened Linux Chromium executable detection to filter out non-executable files, invalid wrappers, and candidates that hang during version probes.
- Fixed Bash command preview crashes caused by malformed tool arguments containing non-string environment values.
- Fixed UI rendering in the model browser and model hub where `nerd`-preset role chips would overlap and obscure the first character of labels.
- Fixed Codex web search sending incompatible request shapes to certain models, which caused the hosted `web_search` tool to ignore them.
- Fixed resumed or rebuilt sessions incorrectly applying stale rewind reports from previous checkpoint cycles to new checkpoints.
- Fixed the `read` tool incorrectly parsing semicolon-delimited internal URLs (such as batched `skill://` resources) as a single invalid resource.
- Fixed `pi.getAllTools()` returning bare strings instead of `ToolInfo[]` objects, restoring compatibility with extensions built against the upstream contract.
- Fixed legacy extensions failing to load in compiled binaries when resolving bundled dependencies via dynamic `createRequire` factories.
- Fixed Wayland window activation and native input handling by correctly reporting them as unavailable rather than attempting unsupported foreground-delivery paths.
- Fixed live execution progress being hidden in the conversation view after approving a plan in the fullscreen Plan Review.
- Fixed `omp -r` failing to discover sessions created under the temporary hashed project-directory scheme by adding a one-way migration back to legacy path-based names.
- Prevented the `read` tool from advertising or resolving `memory://` URIs when the memory backend is disabled.
- Fixed the Shift-Tab thinking mode UI rendering the `off` state as a blank label, which made it appear that reasoning could not be disabled.
- Fixed parsing of POSIX `$EDITOR` commands that contain quoted arguments or executable paths with spaces.
- Fixed persisted Agent Hub rows losing the explicit caller model role when a subagent used a model override, preserving role provenance across restarts.
- Fixed unobserved promise rejections in browser helpers (such as `tab.waitForResponse()`) causing tab workers to hang or crash.

## [17.2.9] - 2026-08-05

### Breaking Changes

- Renamed `compareVersions` to `compareChangelogEntries` in `@oh-my-pi/pi-coding-agent/utils/changelog`. The function signature and behavior are unchanged; update imports to use the new name.

### Added

- Added automatic detection of common Ungoogled Chromium Linux installations for the browser tool.

### Changed

- Restored the legacy project-scoped session directory naming scheme and removed its automatic migration ([#7646](https://github.com/can1357/oh-my-pi/issues/7646)).
- Routed Bun install-cache pruning in `update-cli` through the shared `compareVersions` utility (`@oh-my-pi/pi-utils`), removing a duplicate local comparator that rounded large numeric version identifiers via `Number`.

### Fixed

- Retried concurrent-request caps with a short backoff without deleting valid Copilot credentials or rotating through sibling accounts.
- Fixed the default `textVerbosity` setting being forwarded to OpenAI Codex requests unless the user explicitly configures it, preserving Codex's native response-control defaults. ([#4949](https://github.com/can1357/oh-my-pi/issues/4949))
- Reduced streaming CPU usage by coalescing the cumulative `message_update` deltas of a turn at the event-controller dispatch boundary: at most one streaming-state rebuild runs per ~33ms window instead of one per token, cutting the per-token handler work that dominated the CPU profile of streaming sessions (especially at high token rates) while preserving per-delta speech output. Subscriber dispatch is serialized so a rapid stream tail (`message_update` → `message_end` → `agent_end`) cannot overtake the coalesced flush. ([#7443](https://github.com/can1357/oh-my-pi/issues/7443))
- Fixed translated MCP importers (Claude Code, Cursor, Gemini CLI, Windsurf, VS Code) silently dropping a server's `enabled: false` flag, so a server disabled at the source config stayed mounted; the flag is now propagated and honored like Codex, OpenCode, and native `mcp.json`. These importers now also load project entries before same-named user entries (matching native/Codex) so a project `enabled: false` suppresses a same-named user server ([#7652](https://github.com/can1357/oh-my-pi/issues/7652)).
- Removed the per-call `model` override from the eval `agent()` helper (all runtimes), completing the earlier task-tool removal (`9f8aa87dbf`). Subagents always use their selected agent's frontmatter model and settings; a legacy `model` argument is silently ignored, so an explicit `model: "default"` can no longer route children onto the parent session model ([#6438](https://github.com/can1357/oh-my-pi/issues/6438)).
- Fixed legacy Pi extension validation rejecting plugins such as `remote-pi` that import the package-root `convertToPng` image helper. ([#7610](https://github.com/can1357/oh-my-pi/issues/7610))
- Fixed the legacy session-directory migration silently deleting a live session's transcript when its filename collided with an existing entry in the destination: colliding entries are now preserved in place, the legacy directory is only removed when empty, and collisions/migration failures are logged ([#7593](https://github.com/can1357/oh-my-pi/issues/7593)).
- Fixed `PUPPETEER_EXECUTABLE_PATH` being ignored when a system Chrome installation was detected, preventing Windows users from selecting a compatible headless browser for the shared browser daemon ([#7601](https://github.com/can1357/oh-my-pi/issues/7601)).
- Fixed `openai-models-list` discovery ignoring server-advertised input modalities, so custom virtual tier IDs absent from the bundled catalog showed `images: no` even when the `/v1/models` response reported `input: ["text","image"]` ([#7583](https://github.com/can1357/oh-my-pi/issues/7583)).
- Exposed exact source line counts in read results when selector-based reads reach EOF, allowing protocol bridges to distinguish a returned slice from the complete file ([#7590](https://github.com/can1357/oh-my-pi/issues/7590)).
- Fixed `grep`/`glob` silently collapsing a semicolon-delimited `path` list to one literal path when the joined string was too long for the OS to name (`ENAMETOOLONG`) — a list of bare filenames past `NAME_MAX` or absolute paths past `PATH_MAX` failed with `Path not found: <whole list>` even though every entry existed. The multipath probe now treats `ENAMETOOLONG` as a definitively non-existent single path so the split proceeds, and `glob` surfaces a clean `Path not found` instead of leaking the raw errno ([#7597](https://github.com/can1357/oh-my-pi/issues/7597)).
- Fixed `--mode json` (and text) print mode truncating a large final record (e.g. a multi-MB `agent_end`) when the process exited before stdout drained, while still exiting 0. Per-event writes are now serialized on their own completion callbacks and shutdown blocks on the last one, so the terminal record is delivered in full ([#7635](https://github.com/can1357/oh-my-pi/issues/7635)).
- Fixed text print mode treating buffered partial responses as replay-unsafe, allowing transient mid-stream connection failures to retry without exposing duplicated output ([#7625](https://github.com/can1357/oh-my-pi/issues/7625)).
- Fixed Hindsight `autoRecall` intermittently not reaching the model: two recall paths shared the `hasRecalledForFirstTurn` flag, and the `agent_start` event path could consume it first and inject only via an unawaited background prompt rebuild that a fast turn outran. `beforeAgentStartPrompt` (awaited before the turn builds) is now the sole injection path ([#7568](https://github.com/can1357/oh-my-pi/issues/7568)).
- Fixed `read memory://<id>` returning a confusing "Unknown memory namespace" error under `memory.backend=hindsight` (Hindsight stores memories server-side and has no `memory://` addressing); the handler now returns a corrective pointer to `recall`/`reflect` so a stray read — steered by the shared `recall` tool description — self-corrects in one turn ([#7587](https://github.com/can1357/oh-my-pi/issues/7587)).
- Fixed extension/custom/hook tool wrappers stripping schema methods off `parameters`: `applyToolProxy` bound every callable property, and binding a schema (a plain function carrying `toJsonSchema`/`assert`) dropped those properties, breaking wire-schema detection and crashing the status-line token estimator with `JSON.stringify(schema) === undefined`. Prototype methods are still bound; own data properties and schema callables now pass through untouched.
- Fixed bug where `agent()` calls in eval cells ignored turn cancellation and continued running indefinitely
- Fixed the built-in `tail` printing `tail: Broken pipe` and failing when a downstream pipeline reader exited early (e.g. `tail -c N file.jsonl | jq …` with jq aborting on a parse error); it now exits silently with 141 (128+SIGPIPE) like a real tail, in every output path including `--follow`.
- Fixed the in-process ps shell builtin rejecting common procps/BSD format specifiers (`ps -o tpgid,...` failed with `unknown output format specifier`); added `tpgid`, `pri`, `flags`, real/effective user and group columns, `wchan`, fault counters, `sz`, and the STAT `+` foreground flag.
- Fixed Herdr rejecting the macOS development launcher because its foreground process was reported as `bun` instead of `omp`.
- Completed usage-aware model fallback across startup, queued turns, same-turn tool continuations, ACP/TUI confirmation cancellation, eligible account reselection, cooldown restoration, and isolated subagent settings so low-usage handoffs remain lossless and cannot consume cancelled queued work.
- Fixed Agent Hub opening and selection becoming O(all rows) on large rosters: row rendering is now lazy around the selected viewport, and observer lookup is O(1) by id instead of copy-sorting every session per row.
- Fixed the bash interceptor blocking `grep`/`cat`/`find` used as a downstream pipeline stage (e.g. `printf 'x\n' | grep x`); a stage consuming piped stdin cannot be replaced by a path-based dedicated tool, so it is no longer matched, while standalone and first-stage searches stay intercepted ([#7496](https://github.com/can1357/oh-my-pi/issues/7496)).
- Fixed floating rejections from cmux browser guest JavaScript terminating the main process and every active session; attributable rejections now fail the browser run as tool errors while unrelated process rejections retain the fatal path ([#7365](https://github.com/can1357/oh-my-pi/issues/7365)).
- Fixed the Windows bash tool silently taking down the whole omp process when a command blocked until its timeout: cancelling a timed-out run walked the spawned child's descendant tree from raw `th32ParentProcessID` links, and a recycled pid matching the harness's stale recorded parent pid could enumerate omp as a false descendant and `TerminateProcess` it, killing the session with no `session_exit` record. Run-cancellation sweeps now refuse to signal the harness or any process collected beneath it, while still reaping the timed-out target when it owns a recycled ancestor pid ([#7452](https://github.com/can1357/oh-my-pi/issues/7452)).
- Fixed the unexpected-stop guard (`features.unexpectedStopDetection`) never firing for thinking-only stops: `isUnexpectedStopCandidate` only counted non-whitespace `text` blocks, so a `stopReason: "stop"` turn whose sole content was a signed `thinking` block (a trapped response or a truncated reasoning fragment from reasoning models) bypassed classification and silently ended the turn mid-task. Such stops are now candidates and are classified on their thinking text ([#7499](https://github.com/can1357/oh-my-pi/issues/7499)).
- Fixed Task cancellation hanging forever when a child ignored abort or stalled during cleanup ([#7483](https://github.com/can1357/oh-my-pi/issues/7483)).
- Fixed LSP diagnostics being dropped when servers normalize file URI percent-encoding or Windows path casing.
- Fixed WSL sessions missing Agent Skills stored in the Windows host profile's `.agents/skills` directory. ([#3779](https://github.com/can1357/oh-my-pi/issues/3779))
- Fixed `omp setup python` to validate the same configured or discovered interpreter used by the Python eval runtime.
- Fixed self-update misclassifying glibc Linux hosts with an installed musl loader as musl hosts, which could download an unusable musl binary instead of the glibc release.
- Fixed a crash where opening the Agent Hub after a resume and moving the selection triggered an unbounded `ExtensionExitError` unhandled-rejection storm and exit 129. The postmortem module bound the native hard-exit at first evaluation; when the bundler deferred that evaluation into a `withHostGuard` window it froze the guard's throwing replacement, poisoning every later signal/fatal exit. The native exit is now resolved per call, and the guard stamps its replacement with the native primitive it shadows so mid-guard signals still exit ([#7393](https://github.com/can1357/oh-my-pi/issues/7393)).

## [17.2.8] - 2026-08-04

### Changed

- Upgraded the bundled omptype schema engine: intersection and pipe operators, bigint and RegExp literals in the string DSL, Standard Schema V1 interop, JSON Schema import via fromJsonSchema(), and richer union/collection error reporting.

## [17.2.7] - 2026-08-03

### Changed

- Replaced arktype with @oh-my-pi/omptype for tool parameter and config schemas, significantly improving startup performance with ~100x faster schema construction. Config schema errors are now reported via OmpErrors using the same path/problem structure.

### Fixed

- Fixed an issue where custom, extension, or hook tool wrappers stripped schema methods off parameters, causing wire-schema detection failures and status-line token estimator crashes.
- Fixed a bug where agent() calls in evaluation cells ignored turn cancellation and continued running indefinitely.
- Fixed the built-in tail command to exit silently with code 141 (SIGPIPE) instead of failing with a "Broken pipe" error when a downstream pipeline reader exits early.
- Fixed the in-process ps shell builtin to support common procps/BSD format specifiers, including tpgid, pri, flags, real/effective user/group columns, wchan, fault counters, sz, and the STAT + foreground flag.
- Fixed install.sh falsely reporting success on musl-based systems (such as Alpine Linux) when the binary fails to start; the installer now smoke-tests the binary, exits non-zero on failure, and provides remediation steps.
- Fixed Codex config.toml discovery incorrectly importing MCP servers that are configured with enabled = false.
- Fixed bash.patterns allow rules rejecting valid commands when quoted arguments contained shell metacharacters (such as Cargo benchmark regex filters).

## [17.2.6] - 2026-08-03

### Added

- Added the `/reset` slash command to reset the conversation context in place: it drops the live messages, queued turns, and pending tool calls (and cancels the turn's async jobs, post-prompt continuations, and checkpoint/plan runtime state) while keeping the session id, title, cwd, model, and on-disk transcript. It records a durable reset boundary so the live transcript stays cleared across rebuilds (theme change, focus attach, `/shake`, resume) instead of resurrecting the pre-reset messages, while the full pre-reset history stays on disk ([#3580](https://github.com/can1357/oh-my-pi/issues/3580)).

### Fixed

- Fixed extension slash commands appearing as user prompts after being handled locally.
- Preserved explicit session titles when branching from an earlier conversation turn.
- Fixed an issue where unhandled JavaScript rejections in the browser guest could crash the main process and active sessions, converting them into tool errors instead.
- Fixed a critical issue on Windows where cancelling a timed-out bash tool command could mistakenly terminate the main process due to PID recycling.
- Fixed an issue where supervised processes reaching a terminal state failed to notify their launching session, requiring polling; the broker now actively notifies the session upon process completion.
- Fixed crashes on macOS when using PCRE2-only grep patterns with Bun by defaulting to the interpreted PCRE2 engine instead of JIT, and introduced the `OMP_PCRE2_JIT` environment variable to manually control JIT compilation.
- Fixed issues with `/btw` branch promotion where branches could park behind active turns, cut from outdated session leaves, or leave rejected branch keys indistinguishable from composer input.
- Fixed database bloat by ensuring archived main and nested session rows are properly cleaned up from `stats.db` during garbage collection.
- Fixed startup hanging during local model discovery when a timed-out transport left its request pending, which blocked the CLI before OAuth login could finish ([#7482](https://github.com/can1357/oh-my-pi/issues/7482)).

## [17.2.5] - 2026-08-03

### Breaking Changes

- Replaced the computer tool's coordinate-batch schema with persistent JavaScript runs, and removed computer.backend and model-specific controller switching.
- Changed the edit tool's replace mode from a multi-edit batch schema to a single-edit schema ({ path, old_string, new_string, replace_all? }).

### Added

- Added a relay browser mode to drive local Chrome tabs via the OMP Browser Relay extension, supporting automatic daemon startup and tab grouping.
- Added a scriptable desktop session featuring window-targeted capture and input, native accessibility trees, clipboard access, and streamed screenshots.
- Added broker-shared language servers (controlled by the lsp.shared setting) to multiplex LSP servers across multiple instances in a project, reducing cold-start times and resource usage.
- Added optional timeoutMs to discovery configuration in provider options to configure custom HTTP probe timeouts for llama.cpp, Ollama, and OpenAI-compatible endpoints.
- Added a cross-platform, in-process ps shell builtin with custom columns, sorting, and process metrics.
- Added the --service-tier flag to override the OpenAI service tier for a session.
- Added a configurable per-request web search timeout via providers.webSearchTimeoutSeconds.
- Added turn-aware /tree navigation shortcuts (Alt+Up/Alt+Down, Home/End, PageUp/PageDown) to traverse user and assistant turns.
- Added display.hideToolActivity and a Ctrl+Shift+O shortcut to toggle the visibility of model-initiated tool calls and results.

### Changed

- Exposed the script-driven computer schema to all models, including those with provider-native Computer Use support.
- Reduced omp --help cold-start latency and memory usage by rendering lightweight command metadata.

### Fixed

- Fixed durability of session transcripts to prevent data loss on process crashes.
- Fixed a bug on Windows where a timed-out bash command could terminate the main omp process.
- Fixed headless runs hanging or leaving background workers alive after completion.
- Fixed a crash when opening the Agent Hub after resuming a session.
- Fixed /mcp reauth environment variable expansion and token validation.
- Fixed fuzzy replace-all edits re-matching replacement text indefinitely, which could freeze the TUI.
- Fixed inspect_image ignoring configured thinking effort for vision models.
- Fixed compiled binaries dropping certain extensions with complex CommonJS/ESM dependency graphs.
- Fixed template argument substitution executing recursive placeholder expansion when positional arguments contain literal $@ or $ARGUMENTS tokens.
- Fixed project-scoped session directories using leading-hyphen names and collapsing distinct paths.
- Fixed manual /shake leaving the context budget anchored to stale pre-shake token counts.
- Fixed Mnemopi scoped recall reporting "No relevant memories found" when individual targets fail internally.
- Fixed skill:// resolution ignoring custom directories when a same-named skill exists in a default path.
- Fixed image paste failing on Wayland-only Linux sessions.
- Fixed prewalk switching to the fast model during read-only investigations.
- Fixed self-update misclassifying glibc Linux hosts with an installed musl loader as musl hosts.
- Fixed omp setup python to validate the correct interpreter used by the Python eval runtime.
- Fixed the terminal-tab title dropping to idle while an unsuppressed async job was still running.
- Fixed redirected stdin being ignored when Bun reports a pipe with an undefined isTTY.
- Fixed a literal API key configured via /login being hijacked on Windows by case-differing system environment variables.
- Fixed Esc during a streaming /loop iteration pausing the loop instead of aborting the current turn.
- Fixed heavily branched conversation trees shifting linear continuations into disconnected columns.
- Fixed plugin installation validation failures for legacy compatibility shims.
- Removed hard-coded references to disabled or absent agents in system and tool prompts.

## [17.2.4] - 2026-08-01

### Added

- Added `requestIdFormat` (`"string"` | `"number"`, default `"number"`) to MCP server config, honored by the stdio, HTTP, and SSE transports. JSON-RPC 2.0 permits both id shapes, but Apple's `xcrun mcpbridge` decodes `id` as an integer only and silently drops string ids (`mcpbridge.DecodeError Code=1`), hanging every request until it times out. The option is OMP-specific, so set it in an OMP-owned config (`.omp/mcp.json`, `~/.omp/agent/mcp.json`, a project `mcp.json`/`.mcp.json`, or an OMP plugin); servers imported from another tool's config ignore it ([#7053](https://github.com/can1357/oh-my-pi/issues/7053)).
- Fixed Anthropic web search sending unsupported temperature parameters to sampling-restricted Claude models ([#7195](https://github.com/can1357/oh-my-pi/pull/7195) by [@will-bogusz](https://github.com/will-bogusz)).
- Fixed mid-turn steering/peer-interrupt tool skips rendering as errors (red ✘, red border/text) in the TUI; pending and in-flight interrupt placeholders now render as neutral info cards while preserving whether `tool.execute` started ([#7199](https://github.com/can1357/oh-my-pi/issues/7199)).
- Added `Shift+Up` as a second default for the message dequeue, so the shortcut is reachable in macOS Terminal.app where Option is consumed for character composition.
- Added in-process `pgrep`, `pkill`, `pidwait`, and `top` shell builtins with cross-platform process discovery, BSD/procps-style filters, pidfile handling, signal selection, waiting, and snapshots.

### Changed

- Headless hosts (print/RPC/ACP/eval/SDK) now use a 1s SQLite `busy_timeout` for the session-critical databases (agent.db, history.db, stats.db), so lock contention no longer freezes the protocol loop for the full interactive 5s timeout; interactive hosts keep the 5s timeout. The interactive-host flag is now declared before settings load so the first database opens see the correct timeout.
- The model picker (`/switch`, alt+p) no longer blocks models whose context window is smaller than the live session: over-context rows stay grayed but selectable, and picking one compacts with the current model first, then switches. A cancelled or failed compaction keeps the current model.
- MCP JSON-RPC request ids now default to per-connection sequential integers instead of snowflake strings, matching the wider MCP ecosystem and making integer-only decoders like Apple's `xcrun mcpbridge` work without configuration; set `requestIdFormat: "string"` per server to restore collision-resistant string ids ([#7053](https://github.com/can1357/oh-my-pi/issues/7053)).
- `secret-placeholder.key` now resolves under XDG state (`$XDG_STATE_HOME/omp/secret-placeholder.key`) instead of the agent config directory, so it follows the same XDG layout as other state files.
- Daemon runtime directories (`run/daemons/<hash>`) and provider in-flight tracking (`run/provider-inflight`) now resolve under XDG state (`$XDG_STATE_HOME/omp/run/`) instead of the config root, keeping ephemeral runtime state out of `~/.config`.
- `marketplaces.json` now resolves under XDG data (`$XDG_DATA_HOME/omp/marketplaces.json`) instead of the config root, aligning with the XDG data category for user-scoped registry files.
- Existing XDG installs keep their placeholder key and marketplace registry: the legacy `~/.omp/agent/secret-placeholder.key` and `~/.omp/marketplaces.json` are copied to their XDG locations on first resolution.

### Fixed

- Fixed sessions without a granted `write` tool hiding discoverable and MCP tools behind the unusable `xd://` transport; those sessions now disable device mounting and expose the tools directly without gaining write access.
- Fixed collab guest prompts being sent to models as unframed developer context, so guest messages now retain their transcript attribution while reaching the model as prioritized user interjections ([#7288](https://github.com/can1357/oh-my-pi/issues/7288)).
- Fixed `/memory stats` and `/memory diagnose` showing "Memory stats is not available for the off backend" when memory is off, in both the TUI and ACP/RPC slash-command handlers; the off backend now says memory is off directly instead of naming itself as an unsupported backend ([#7251](https://github.com/can1357/oh-my-pi/pull/7251) by [@KennethHoff](https://github.com/KennethHoff)).
- Fixed `/reload-plugins` retaining stale context-file contents and activation state in the current system prompt ([#7258](https://github.com/can1357/oh-my-pi/issues/7258)).
- Fixed compiled binaries failing to import nested wildcard export subpaths such as `@oh-my-pi/pi-coding-agent/slash-commands/helpers/active-oauth-account`. Node matches `*` in an `exports` pattern across `/`, but the bundled registry enumerated only the top level and skipped any key containing a slash, so such an import resolved from source and died under bunfs — reproducible on the published 17.2.1 binary.
- Fixed concurrent session appends during `/move` recreating an orphaned `.jsonl` fragment in the old session directory ([#7270](https://github.com/can1357/oh-my-pi/issues/7270)).
- Fixed interactive launches hanging silently when a host project or its `.env` sets `NODE_ENV=test` or `BUN_ENV=test` ([#7261](https://github.com/can1357/oh-my-pi/issues/7261)).
- Fixed a subagent killed from the Agent Hub (`x`) reappearing as a `parked` row after closing and reopening the hub in a local session; the kill now leaves the ref registered as terminal `aborted` instead of unregistering it, so the persisted-subagent rescan no longer re-adopts the surviving transcript ([#7250](https://github.com/can1357/oh-my-pi/issues/7250)).
- Fixed manual and automatic Codex compaction dropping the configured OpenAI WebSocket preference ([#7198](https://github.com/can1357/oh-my-pi/issues/7198)).
- Fixed two remaining tool-card double renders: a superseded assistant turn no longer leaves its never-run cards above the re-run's fresh cards (a TTSR rewind retracts them immediately; an auto-retry removes the synthetic-settled failure cards when it supersedes the turn — while a genuinely terminal failure keeps its card visible), and a successful read whose persisted result wins a transcript-rebuild race no longer creates a fallback read group when its delayed live completion arrives ([#6879](https://github.com/can1357/oh-my-pi/issues/6879)).
- Fixed a tool card rendering twice when the provider rewrites a streamed tool call's id mid-stream — GitHub Copilot's `call_id|id` transport, or any stream that delivers the tool name/arguments before the id — so the block appears first with an empty or partial id and is populated in a later delta. The transcript keyed the live card by that mutable id, so the changed id spawned a second card: the old-id card orphaned as a blue pending preview while the new-id card took the result. Streamed tool cards are now re-keyed in place when their id changes, using the block's position in the streaming message as a stable identity ([#6879](https://github.com/can1357/oh-my-pi/issues/6879)).
- Withheld advisor nits and concerns while the primary turn is explicitly marked in progress, while still allowing blockers for unrecoverable active side effects.
- Preserved explicit `-e`/`--extension` and `--hook` packages under
  `--no-extensions` while excluding ambient extension factories and sibling
  capabilities from settings or installed OMP packages.
- Fixed explicit `thinking` metadata in `models.yml` custom definitions and `modelOverrides` being replaced by canonical catalog policy during model rebuilding. ([#7307](https://github.com/can1357/oh-my-pi/issues/7307))
- Fixed the auto-titler installing a model's whole answer as the session title when the tiny title model ignored the titling task and answered the first user message instead. `normalizeGeneratedTitle` now rejects overlong output (>80 chars or >12 words) so the caller defers titling to the next user turn rather than accepting a full sentence ([#7303](https://github.com/can1357/oh-my-pi/issues/7303)).
- Fixed the in-process `kill` builtin to validate signals, preserve negative PID operands, signal every process in pipeline jobs, continue after bad targets, and refuse non-probe signals aimed at the host process or process group.

## [17.2.3] - 2026-08-01

### Changed

- Tightened the system prompt notation: the legend now defines `⟺`, `≠`, `∉`/`∌`, and operator binding order; replaced undefined symbols (`⊭`, `≢`) in prompt bodies; removed delegation guidance duplicated between the eager-tasks preamble and the delegation gates.

### Fixed

- Fixed headless browser launch storms and orphaned Chromium process trees: omp processes now attach to one project-shared Chromium owned by the daemon broker (tabs per session; Chrome dies with the last omp client in the project), concurrent browser opens in one process share a single launch, and concurrent daemon `start` requests for one name can no longer spawn duplicate untracked processes.
- Fixed Bash auto-background leaving a live `Bun.sleep` threshold timer scheduled after a command completes (or abort/steering wins) first, which could keep the event loop alive and delay SDK/headless shutdown until the threshold expired ([#7235](https://github.com/can1357/oh-my-pi/issues/7235)).
- Fixed ephemeral side turns and native compaction bypassing an explicit or fork-inherited prompt cache key ([#7218](https://github.com/can1357/oh-my-pi/issues/7218)).
- Fixed the live Ask dialog crashing the whole session with a `replaceTabs` TypeError when a question reached `AskDialogComponent` without a string `question` field; questions are now normalized at dialog entry, mirroring the transcript renderer ([#7211](https://github.com/can1357/oh-my-pi/issues/7211)).
- Fixed Codex web search collapsing backend errors to `Codex error (): Unknown error`; the SSE error parser now preserves the backend code and message from top-level, nested `error`, and `response.error` envelopes ([#7200](https://github.com/can1357/oh-my-pi/issues/7200)).

## [17.2.2] - 2026-07-31

### Added

- Added an app.live.toggle keybinding (default Ctrl+L) to start or stop live voice mode.
- Added ctx.invokeTool(params, options?) to extension contexts, allowing wrappers to run native tools while inheriting context, abort signals, and progress updates.

### Changed

- Moved the display-reset default keybinding (app.display.reset) from Ctrl+L to Alt+L to accommodate the new live-mode toggle.
- Updated the hashline edit tool, streaming preview, and plan-mode guidance to support the unified PUT/CUT grammar, .= ranges, and named registers.
- Improved startup performance by moving subagent model-registry refresh and session-file opening off the launch critical path.
- Optimized session file writing performance by batching same-turn file-session appends.
- Rewrote the Codex saved-reset auto-redeem algorithm to be pool-wide, window-exact, and expiry-aware, ensuring banked resets are automatically and reliably redeemed across multi-account setups before they expire.

### Fixed

- Fixed a crash in Kitty terminals when rendering non-PNG tool-result images if PNG conversion fails.
- Fixed subagent evaluation resets (reset: true) wiping the shared kernel inherited from the parent session; resets from non-exclusive owners now fork into a private per-owner kernel.
- Fixed the copy selector and ask dialog rendering raw key IDs instead of human-readable keybinding labels.
- Fixed CLI positional initial messages bypassing automatic session-title generation.
- Fixed the environment-variable reference omitting Kitty Unicode placeholder controls and tmux placement caveats.
- Fixed extension validation failures during omp plugin install for extensions importing compact from @earendil-works/pi-coding-agent by adding the missing re-export.
- Fixed Bash interceptor rules to inspect unquoted/unescaped compound command fragments (e.g., &&, ||, ;, |, &, and newlines) instead of only matching the complete command input.
- Fixed ExtensionContext.cwd staying pinned to the initial session directory; it now dynamically tracks the active session's current working directory.
- Fixed the web-search provider picker description for xAI/Grok to clarify that it supports SuperGrok/X Premium+ OAuth sign-ins.
- Fixed /reload-plugins failing to reconnect MCP servers or refresh MCP tool and prompt-command registries.
- Enforced the centralized artifact spill threshold on oversized read results, persisting them as recoverable session artifacts.
- Fixed DuckDuckGo web search under-returning results above the first-page limit by automatically submitting continuation forms.
- Fixed DuckDuckGo web search ignoring after: and before: date bounds by correctly parsing and filtering result timestamps.
- Fixed env-driven OTLP trace export ignoring OTEL_RESOURCE_ATTRIBUTES.
- Fixed a fresh session with deferred MCP discovery injecting the newly mounted xd:// tool catalog twice into the first model request.
- Fixed the bash tool failing with EACCES permission errors on multi-user machines by scoping the snapshot directory per user ID.
- Fixed LSP write batching replaying stale whole-file snapshots over newer external changes made before the batch flushed.
- Fixed ctx.ui.editor() in ACP mode always resolving to undefined by routing it through the elicitation bridge.
- Fixed omp commit failing to resolve extension-provided models in both agentic and legacy pipelines.
- Fixed RPC hosts receiving no subagent lifecycle or progress frames when an IRC message revives an idle or parked keep-alive subagent.
- Fixed copied fenced-code body rows in assistant messages retaining component and container margins.
- Fixed mid-turn auto-compaction repeating dead-end rescue work and warnings at every tool boundary within a single oversized turn.
- Fixed automatic terminal appearance changes clearing native scrollback and snapping readers away from their current scroll position.
- Fixed exact-match edits failing on files containing credential-shaped tokens when secrets.enabled is active by using reversible placeholders instead of irreversible redactions.
- Fixed context usage collapsing to the latest response size for Cursor models that omit prompt-token usage.
- Fixed the browser tool crashing with EBUSY errors on Windows when a headless Chromium profile is locked during cleanup.
- Fixed the Python RPC client dropping context, compaction, OAuth URL, and terminal-settlement fields.
- Fixed the browser tool ignoring the url parameter when opening a new tab on an attached browser.
- Fixed browser automation disrupting attached browsers by adopting the active foreground tab and avoiding raising new tabs during screenshots.

## [17.2.1] - 2026-07-30

### Added

- Added `--from-claude` and `--from-codex` session imports, also available from `/resume @claude` and `/resume @codex`.
- Added an opt-in OMP-native software-security workflow (`security.enabled`, default off) with immutable scan plans, exact-account Codex subscription affinity, native task-worker review, canonical findings/coverage/SARIF publication, project-scoped history, explicit dispositions, producer-differential comparison, and the read-only `security://` resource namespace. Generic SARIF and official Codex Security bundles normalize into the same OMP-owned store.
- Added explicit Codex Security cloud operations to the opt-in security workflow: list and start account-pinned cloud scans, inspect their progress, and import current findings into OMP's canonical store and `security://` namespace without changing the native scan engine or spoofing official runtime attribution.

### Changed

- Reserved `security://` from RPC host URI shadowing so vendor adapters cannot replace OMP's canonical security-analysis namespace.

### Fixed

- Fixed remote or LAN local-engine endpoints being ignored during model discovery: the llama.cpp and Ollama probes used timeouts tuned for loopback, so a host reached over the network could exceed them and return no models, while changing `OLLAMA_BASE_URL`/`OLLAMA_HOST` could keep reusing a fresh cache from the previous endpoint. Non-loopback hosts now get a generous discovery timeout, and Ollama cache rows are scoped to the normalized endpoint ([#7087](https://github.com/can1357/oh-my-pi/issues/7087)).
- Fixed `omp install` failing extension validation for pi extensions that import `createEditTool` or `createWriteTool` (e.g. gentle-pi) — the legacy `@oh-my-pi/pi-coding-agent` shim exported the read/bash/grep/find/ls tool factories but omitted the edit and write ones, so a named import threw Bun's static "Export named X not found" error. Added `createEditTool`/`createEditToolDefinition` and `createWriteTool`/`createWriteToolDefinition` to match the upstream pi surface ([#7094](https://github.com/can1357/oh-my-pi/issues/7094)).
- Fixed Python eval's loopback tool bridge being routed through macOS system HTTP proxies, which caused `parallel()` tool reads to fail with `ConnectionRefusedError` after a local proxy stopped.

## [17.2.0] - 2026-07-30

### Breaking Changes

- Removed the `DEL`, `DEL.BLK`, `COPY`, and `COPY.BLK` hashline edit operations. Use `CUT` / `CUT.BLK` for deletion; removed content remains available to `PASTE`.

### Added

- Added server-name autocomplete for `/mcp` commands (`enable`, `disable`, `test`, `remove`, `reconnect`, `reauth`, `unauth`) using configured and runtime-discovered MCP servers.
- Added `CUT` and `PASTE` ops to the hashline edit tool for moving code without retyping it: `CUT N.=M` (and `.BLK` block forms) capture lines into a clipboard register, and `PASTE` operations insert them. The register flows across sections within a patch (cross-file moves) and persists across edit calls per session.
- Added `--from-claude` and `--from-codex` session imports (including compaction state for Codex), also available from `/resume @claude` and `/resume @codex`.
- Added interactive Exa API-key onboarding through `/login exa`, opening the official key dashboard and saving pasted keys for authenticated web search while preserving `EXA_API_KEY` and explicit-selection public MCP fallback behavior ([#1798](https://github.com/can1357/oh-my-pi/issues/1798)).
- Added `ExtensionContext.getAsyncJobSnapshot()` so extensions can read the owning session's async-job state without relying on process-global job-manager identity
- Added opt-in `tui.codexResetFireworks` celebrations for unscheduled Codex weekly usage resets and newly banked saved resets, shown in a theme-aware top-third modal until Escape ([#6858](https://github.com/can1357/oh-my-pi/pull/6858) by [@joshrzemien](https://github.com/joshrzemien)).
- The Cursor exec bridge serves the seven modern Pi tool frames, mapping each to its local equivalent: `pi_read`/`pi_ls` → `read`, `pi_bash` → `bash`, `pi_edit` → `edit`, `pi_write` → `write`, `pi_grep` → `grep`, and `pi_find` → `glob`. The frames are a separate wire family from the legacy args, not aliases, so each mapping is a real translation — `pi_grep`'s `ignore_case` is the inverse of the local tool's case-sensitivity flag, `pi_find` searches filenames rather than contents, and `pi_edit`'s replacements are renamed to the local snake_case pairs.
- `providers.autoThinkingMaxEffort` (`xhigh` | `max`, default `xhigh`) raises the ceiling of the `auto` thinking classifier. `max` became a first-class effort tier after the classifier prompt was written, so `auto` could never reach it on models that expose the tier — only the `ultrathink` keyword could. Opting in adds `max` to the classifier's vocabulary, gated on the target model actually supporting it; the default keeps today's prompt byte-for-byte. The ceiling is enforced inside the effort clamp rather than on the classifier's answer, so a sparse ladder cannot snap an excluded request back up, and the Low floor is still resolved against the model's own ladder. The on-device 3-bucket classifier stays capped at `xhigh` regardless of the setting. The ceiling governs what `auto` resolves: a ladder with nothing underneath it yields no auto level, and a `thinking.requiresEffort` model still gets its lowest supported effort from the transport.

### Changed

- Improved grouped read-call layout by nesting each request's usage metrics beneath its final path.
- Improved turn recovery to prevent duplicate output streaming during credential rotation or model fallback when visible text has already been streamed.
- Optimized tool guidance for bash, grep, and glob to be more concise while clarifying shell boundaries and search timeouts.
- Optimized models configuration resource probing to run in a single child process, reducing startup contention.
- Startup release notes now default to a compact change-count summary. Use `startup.changelogMode` (`summary` | `expanded` | `hidden`) to control them; legacy `collapseChangelog` choices migrate automatically ([#6771](https://github.com/can1357/oh-my-pi/issues/6771)).

### Fixed

- Fixed Anthropic prompt-cache cold misses on session resume with multiple OAuth accounts: the account that served a session is now recorded in the session file (as a `credential_pin` sha-256 of the account + org/project scope, so exports carry no plaintext identity) and re-pinned on resume with the session's effective last-use time, so a fresh process no longer re-ranks accounts by usage headroom — which systematically routed away from the just-used account and cold-missed the entire account-scoped cache prefix. Sticky routing was previously stored only in the auth store's KV cache, which is in-memory when a remote auth broker is configured.
- Fixed Anthropic prompt-cache cold misses on session resume with multiple OAuth accounts: the account that served a session is now recorded in the session file (as a PII-free `credential_pin` hash) and re-pinned on resume, so a fresh process no longer re-ranks accounts by usage headroom — which systematically routed away from the just-used account and cold-missed the entire account-scoped cache prefix. Sticky routing was previously stored only in the auth store's KV cache, which is in-memory when a remote auth broker is configured.
- Fixed concurrent `createAgentSession` calls with the default agent id failing initialization with `Agent "Main" was replaced during session initialization` — each in-process embedder (e.g. the edit benchmark runner) can now pass a private registry via the newly exported `AgentRegistry`, keeping every top-level session's "Main" out of the process-global roster race.
- Fixed task tool blocks duplicating their per-agent progress rows into terminal scrollback on every update: live task frames now pin the transcript live region so mid-run rows are never recorded as frozen snapshots, and a detached background task freezes its progress the moment any of its rows commit to scrollback instead of mutating committed history.
- Fixed Codex reset fireworks comparing different quota tiers or plans, preventing false celebrations when usage reports switch between Spark and base weekly limits.
- Fixed Cursor ranged-read results losing the full file byte size after applying the requested window.
- Fixed empty Codex final-stop recovery discarding an earlier commentary message when both messages shared response metadata.
- Fixed Advisor availability with providers that refuse echoed reasoning by retrying once with primary thinking stripped and surfacing persistent refusals immediately.
- Fixed `/tan` agents being unable to read parent-session `local://` attachments by correctly resolving local protocol options against the parent session's artifacts.
- Fixed Codex web search silently returning plain completions when the hosted web search tool was skipped.
- Fixed TUI collaboration guest loader not starting when joining or reconnecting mid-turn.
- Fixed multi-second TUI freezes in reftable-format repositories by moving branch resolution off the render path and adding a timeout to synchronous git spawns.
- Fixed `xd://` device summaries containing control characters and exceeding size budgets by stripping control characters and bounding summaries by UTF-8 bytes.
- Fixed `task.softRequestBudget` configuration having no effect on bundled scout and sonic subagents.
- Fixed quick LSP server exits being misreported as reader failures and resolved an issue where explicit reloads were blocked by initialization backoff.
- Forced Git subprocesses to use the stable `C` locale to ensure predictable, non-interactive command output.
- Fixed compatibility replay issues for pre-upgrade launch brokers evaluating xterm inside the client process.
- Fixed Advisor cost tracking in the status line across conversation boundaries, ensuring session transitions, forks, and resumes correctly restore or isolate conversation spend.
- Fixed validation failures for legacy extensions importing from the package root, which previously blocked installations.
- Fixed ACP clients (such as Zed), TUI status lines, and collaboration guests not updating when model changes occur dynamically within the agent loop.
- Fixed assistant-facing resource summaries omitting parameterized MCP resource templates, ensuring failed reads list templates alongside concrete resources.
- Fixed redundant `xd://` mount notices and prompt-cache invalidation when resuming sessions or reconnecting devices.
- Fixed the model picker displaying placeholder model lists instead of the actual credential-aware catalog resolved at registration.
- Fixed file corruption and snapshot mismatches when writing files through the ACP client bridge by verifying the final on-disk content after client-side post-save formatting.
- Fixed `omp ttsr test` silently evaluating source files as prose when their extensions were missing from the allowlist, and expanded the allowlist to support .NET, Shell, SQL, Zig, Dart, Scala, Elixir, and Protobuf files.
- Fixed automatic light/dark theme switching in direct WezTerm sessions on macOS when DEC Mode 2031 is unsupported, and improved theme-change color responsiveness.
- Fixed configured `retry.maxDelayMs` not being forwarded into Anthropic retry handling, so over-budget server retry delays fail fast.
- Added tokens-per-second throughput to RPC `get_state` responses for non-TUI clients.
- Added the RPC `set_fast_mode` command and typed TypeScript/Python client methods for live fast-mode control.
- Added `fastModeEnabled` and `fastModeActive` to RPC `get_state` responses.
- Fixed RPC fast-mode state reporting after direct Anthropic rejects `speed: "fast"`, while allowing explicit re-enable requests to retry priority service.
- Added opt-in subagent access to `checkpoint`, `rewind`, `learn`, and `manage_skill` when explicitly listed in an agent definition's `tools:` frontmatter. Listing one of `checkpoint`/`rewind` auto-includes the other. Settings (`checkpoint.enabled`, `autolearn.enabled`) remain master toggles.
- Added a `browser.cdpUrl` setting that points browser automation at an already-running CDP endpoint by default, so `app.cdp_url` no longer has to be repeated on every call. Explicit `app` options still take precedence.
- Native compaction preserves provider-native success and non-authentication failure semantics while retaining authenticated cross-provider fallback when the native provider rejects credentials.
- Fixed the Cursor Pi exec bridge silently dropping frame arguments. `pi_read`'s `offset`/`limit` were ignored, so a ranged read returned the whole file; `pi_grep`'s `literal` was ignored, so a fixed-string search ran as a regex and matched the wrong lines; and the path/glob join produced a `./`-prefixed spec. Ranges are now composed onto `read`'s `:N+K` inline selector, literal patterns are escaped, and the join uses `node:path`. These are `optional int32` fields, so a present `0` is honored rather than folded into a default: `pi_read` with `limit: 0` answers with empty output instead of the entire file, and `pi_find` with `limit: 0` clamps to 1 the way the reference client does.
- `pi_grep`'s `context` and `limit` are honored. Neither is expressible in the model-facing `grep` schema — context width comes from `grep.contextBefore`/`grep.contextAfter` fixed at tool construction — so the bridge builds a per-call `grep` for frames that supply them. `GrepTool` accepts these as constructor options; the model-facing schema is unchanged, and a frame that supplies neither keeps the shared instance and the session's defaults.
- `pi_ls`'s `limit` is still not mapped, now deliberately: it caps directory *entries*, while the local `read` tool renders a depth-2 tree with per-directory caps and elision rows and applies a selector as a *rendered line* slice. Mapping it to `:1+K` would cap a different unit while appearing honored.
- The legacy pi shim's regex-literal escaper and path/glob join were verbatim copies of the modern bridge's. Both paths now call the shared helpers, so the two Pi translations cannot drift.
- Fixed every Cursor `pi_edit` frame failing instead of editing. Two independent causes: the session drops `edit` from the tool registry for Cursor so the model uses full-file `write`, but that registry is also the exec bridge's tool source, so the native frame — which the server sends regardless of the advertised catalog — found no tool; and the retained instance followed the session's configured edit mode, while `PiEditExecArgs` carries `old_text`/`new_text` pairs that only `replace` accepts (the default `hashline` takes a single `input` string). The bridge now resolves a `replace`-mode instance through its fallback resolver, still wrapped for approval.
- Fixed a `pi_grep` frame carrying `context` or `limit` escaping the approval gate. Honoring those fields needs a per-call `grep`, and the per-call instance was built raw while every registry tool is wrapped, so such calls bypassed `tools.approval.grep` and the exec-tier check for SSH-targeted paths. Both bridge callsites now build it through one shared factory that applies the same wrapper.
- Fixed Cursor advisors ignoring `pi_grep`'s `context` and `limit`. Only the primary session supplied the per-call `grep` factory, so advisor frames silently fell back to session defaults. Advisors now receive the same factory, gated on the advisor actually having been granted `grep`.
- Fixed Cursor advisors failing every `pi_edit`. The advisor roster handed the bridge the `edit` instance built for the advisor's own loop, which follows the configured `edit.mode` (`hashline` by default) and rejects the frame's `old_text`/`new_text` pairs — the same mode mismatch the primary bridge already fixed, on the path it missed. The exec map now substitutes a `replace`-mode instance, gated on the advisor actually having been granted `edit`, while the advisor's own loop keeps the tool it was given.
- Fixed `pi_bash` killing commands that explicitly asked for no deadline. `timeout` is `optional int32` and `bash` documents `0` as "disables the command deadline", but a truthiness check folded a supplied `0` into unset, applying the 300s default instead. A present `0` now passes through; negatives, which have no local meaning and would otherwise clamp to the 1s floor, still fall back to the default.
- Fixed the Cursor exec bridge granting `edit` and `grep` to sessions that withheld them. Both bridge-only tools are constructed rather than looked up, and `executeTool` prefers a constructed override over the registry, so a restricted tool set (`toolNames` without them, or `restrictToolNames`) still got a working `pi_edit`/`pi_grep` — native frames arrive regardless of the advertised catalog. Both are now gated on the session having actually granted the tool, matching the `delete` frame's existing check (issue #5680).
- Fixed Cursor advisor bridge tools bypassing approval settings. The advisor's `pi_edit`/`pi_grep` instances are approval-wrapped, but the wrapper reads `tools.approvalMode`, per-tool `tools.approval.<tool>` policies and `autoApprove` only from the execute-time tool context — which the advisor bridge never supplied, so every native advisor frame resolved as `yolo` with empty policies and ran past a configured `ask` or `deny`. Advisors now receive the same context store as the primary bridge.
- Fixed Cursor's `list_mcp_resources`/`read_mcp_resource` frames answering as though the client hosted no MCP servers. The bridge hardcoded an empty catalog and `not_found`, so resources from servers the session held live connections to were invisible to the model even while the same session read them through `mcp://`. Both frames now answer from the session's `MCPManager` — awaiting a server's background resource discovery rather than reading the not-yet-populated cache and reporting "advertises nothing" — and a lookup failure surfaces as an error rather than an empty catalog, which would read as "asked, none exist". A read carrying `download_path` writes the resource to that path and answers with the path alone, per the wire contract, instead of putting the payload back in the model's context. That path arrives from the server while the general-purpose resolver deliberately honors absolute paths and `..`, so downloads are confined to the workspace: the resolved target and its deepest existing ancestor must stay inside it, and a target that is itself a symlink is refused. The write then opens `O_NOFOLLOW` and refuses a non-regular or hard-linked file before truncating, so the final component cannot be swapped for a link or an inode shared outside after the check. A parent directory replaced by a symlink mid-write is still followed; closing that needs `openat`/dirfd walking, which this does not attempt.
- Fixed the Cursor native `delete` frame bypassing approval settings. Unlike every other frame it removes the file directly instead of running a registry tool, so no approval wrapper sat in front of it — the bridge's `allowDirectFileMutation` grant answers whether a mutating tool was granted, which is a different question from whether the user's policy allows the call. A configured `tools.approval.delete: deny`, or an `always-ask` session that this channel cannot prompt in, now refuses the frame and keeps the file.
- Fixed Cursor download-mode resource reads bypassing the session's mutation restrictions. A `read_mcp_resource` frame carrying `download_path` creates and overwrites workspace files without running a registry tool — the same hole the native `delete` frame had — so a session that withheld `write`/`edit`, or one whose `write` tier is `deny`/`always-ask`, still had files written. Both frames now share one grant (`allowDirectFileMutation`, renamed from `allowNativeDelete` now that it gates more than deletion) and one `write`-tier policy check, and the download refuses before the read so a blocked call does not fetch the resource either. The primary session derives that grant before it rewrites its registry: Cursor moves `edit` out of the tool map and `write` may be auto-registered later, so reading the map at bridge-construction time would have misjudged both.
- Fixed `pi_ls` never reporting that a listing was clipped. The bridge read the entry cap from a flat `details.resultLimitReached`, which `glob` sets but `read` — the tool serving `pi_ls` — does not: it records the cap through `OutputMeta` at `details.meta.limits.resultLimit.reached`. Every capped listing therefore reached Cursor with `entry_limit_reached` unset, reading as complete. Both shapes are now checked, the same way the truncation translation already handles its two producers.
- Fixed a mixed-content MCP resource read reaching Cursor mislabelled. The mime type was taken from the first content item while the payload came from whichever item supplied it, so an image blob followed by a text note sent the text as `image/png`. Each branch now reports the type of the part it actually sends.
- Fixed `pi_read`'s `offset`/`limit` returning more lines than the frame asked for. The range is composed onto the local `read` tool's inline selector, and a plain `:N+K` deliberately pads with one leading and three trailing context lines — helpful when a human reads a snippet, wrong for a caller that named an exact range: offset 5/limit 20 handed Cursor lines 4-27. Ranged Pi reads now compose `:raw:N+K`, which slices exactly the requested lines.
- Fixed `pi_grep` returning fewer matches than it asked for when they spread across many files. The local `grep` windows results to the first 20 files and tells the caller to paginate with `skip`, but `PiGrepExecArgs` has no `skip` field — so a frame asking for 100 matches over 25 one-match files got 20, `match_limit_reached` unset, and advice it could not act on: output silently short and labelled complete. A search carrying a total match cap now reads enough files to satisfy it (cap+1, so a result landing exactly on the cap is distinguishable from a clipped one) and reports the cap when it actually bites.
- Fixed every native `pi_edit` failing after a session switched onto Cursor. The replace-mode `edit` instance the frame needs was built only for sessions *created* on Cursor, and the tool roster is not rebuilt on a model switch — so a session that started elsewhere kept its configured-mode `edit` in the registry, which the bridge resolves before its fallback, and the frame's `old_text`/`new_text` pairs failed validation against a `hashline` schema. The instance is now built from the `edit` grant regardless of the session's initial provider (lazily, so a session that never reaches Cursor never constructs one) and `pi_edit` asks for it explicitly through a dedicated accessor. A session that was never granted `edit` is still refused.
- Fixed the Cursor bridge's tool resolver being able to execute an unadvertised `edit`. That resolver doubles as the agent loop's fallback for any call outside the advertised set, so serving `edit` from it meant a hallucinated call — or one naming a tool the session deselected after startup — could run a replace-mode edit the model was never offered. It is device-only again; `pi_edit` uses its own accessor.
- Fixed the legacy Cursor `read` frame ignoring the `offset`/`limit` modern builds paginate with. Only the Pi variant composed a range, so every page of a legacy read returned the whole file (or its own truncation) and a model walking a large file never advanced past the first window. Both frames now translate a range through the same helper, and the answer sets `range_applied` to describe whether a window was actually composed.
- Fixed the legacy Cursor `grep` frame ignoring its pagination `offset`. The local `grep` paginates by file through `skip` and advertises exactly that in its own "use skip=N" advice, so an unforwarded offset re-ran the identical search and answered page one for every page. The answer now reports the offset it applied in `offset_applied`.
- Fixed a paginated Cursor `read` or `grep` frame being recorded as an unpaginated one. The executed call and the transcript block are built separately, so forwarding the frame's range and page fixed only the execution: the block still showed a bare path and an unskipped search, which is what a reloaded session replays and what the next turn reasons from — a slice of a file presented as the whole thing, and results from a later window presented as page one. Both are now synthesized from the same translation that runs them, including a `limit: 0` read, which is recorded as the zero lines it returns rather than a whole-file read.
- Fixed Cursor advisors answering every MCP resource frame as though the client hosted no servers. Only the primary bridge received the `MCPManager`-backed resource adapter, so an advisor's `list_mcp_resources` reported an empty catalog and its `read_mcp_resource` a `not_found` even though the advisor shares the session's live connections. Advisors now receive the same adapter; it is not gated on a tool grant, since reading what a server advertises is a different permission from calling one of its tools.
- Fixed advisor tools bypassing the approval gate. They are built straight from the builtin table, outside the loop that wraps every registry tool, and both the advisor's own agent loop and its Cursor exec bridge (`pi_write`, `pi_bash`) run those instances directly — so an advisor granted `write` or `bash` executed them regardless of a configured `ask` or `deny`. They now carry the same `ExtensionToolWrapper` as every other tool.
- Added `mcp_notification` extension event and multi-listener `MCPManager.addNotificationListener` API. The runtime already received MCP server-initiated JSON-RPC notifications at the transport layer but had no path to forward them to extensions; every notification (including server-custom methods) is now delivered as `{ server, method, params }` after the manager's own list/update handling. For known list-change methods (`notifications/tools/list_changed`, `notifications/resources/list_changed`, `notifications/prompts/list_changed`) the internal refresh promise is awaited before fanout, so a listener acting on `tools/list_changed` sees fresh `getTools()`. Notifications received before any listener attaches are buffered (bounded FIFO, cap 100, drop-oldest — matches `IrcBus`'s `MAILBOX_CAP`) and drained into the first subscriber, so startup-time frames aren't lost even if the extension binds after MCP discovery. Extensions can use this to bridge push-capable MCP servers (e.g. peer messaging) into session behavior by injecting a mid-turn steer via `pi.sendMessage` / `pi.sendUserMessage`.

### Removed

- Removed the dangling `MCPManager.setOnNotification` single-slot setter, which had no callers in the runtime. Replaced by `MCPManager.addNotificationListener` — multi-listener, per-listener error isolation, returns an unsubscribe function.

## [17.1.8] - 2026-07-28

### Breaking Changes

- Changed tab.screenshot() to no longer accept a per-call save path; it now saves screenshots under browser.screenshotDir (or the OS temp directory if unset) and returns the saved path.

### Added

- Added omp cleanse, a new command that automatically detects language-ecosystem checkers, parses diagnostics (such as Cargo Clippy JSON), distributes repair workloads across concurrent subagents, and runs verification checks with a live progress bar.

### Changed

- Reworked the /guided-goal command from a modal-based popup flow into a natural, conversational chat interface where the agent asks follow-up questions directly in the session.
- Reduced startup memory usage by lazy-loading HTML session export assets only on their first use.

### Fixed

- Fixed Advisor notes appending stale-review-window warnings when newer primary turns are queued during a review.
- Fixed layout padding alignment issues in bordered output blocks and web-search result panels.
- Fixed excluded web search providers remaining visible in the Web Search Provider Order settings list.
- Fixed internal Hub peer messages being exposed as ordinary tool-call updates in clients like Paseo.
- Fixed compatibility issues when installing legacy pi extensions by updating the legacy shim to correctly bridge missing runtime symbols and exports (such as isContextOverflow, isRetryableAssistantError, and JSON parsing utilities).
- Fixed an issue where routine daemon operations (like list, logs, stop, or describe) could inadvertently trigger a restart loop for detached daemons in a backoff window.
- Fixed marketplace plugin MCP discovery to correctly honor the mcpServers manifest field in plugin configuration files.
- Fixed user-initiated shell executions (! and $) being misattributed as agent actions in advisor transcripts.
- Fixed unnecessary prompt-cache invalidations by preserving the active auto-thinking effort level when per-turn classification fails.
- Fixed the omp process name showing up as bun in Linux process managers (like ps and top).
- Fixed agent shell commands inheriting environment variables from the launch directory's .env file, ensuring they only receive the parent environment and explicit tool overrides.
- Fixed the /new command retaining completed or failed async jobs from the previous session.
- Improved error handling in omp update to display a friendly timeout message if the download times out while streaming the binary.
- Fixed the write tool incorrectly treating semicolon-joined read selectors as filesystem paths and creating unintended directory structures.
- Fixed omp worktree clear prematurely deleting active task-isolation sandboxes owned by running subagents.
- Fixed /vibe mode preventing the director from completing parent tasks after verifying worker results by keeping the built-in todo tool active.
- Fixed numeric GitHub issue and pull request autocomplete being suppressed inside skill slash-command arguments.

## [17.1.7] - 2026-07-27

### Fixed

- Restoring a prompt with image attachments via esc-esc branch or `/tree` now re-attaches the images to the composer draft: previously only the text (with its `[Image #N]` markers) was restored, so resubmitting sent the literal marker with no image.
- Fixed large bash/eval/ssh output citing two different artifact ids in one result — the truncation notice said `Read artifact://N for full output` while the footer said `Artifact: N+1`. The streaming sink's head and tail windows each had a full budget, so a middle-elided inline body could reach `headBytes + spillThreshold` and always re-tripped the final-defense inline byte cap, which truncated a second time (two elision markers), saved a duplicate already-truncated artifact, and left the notice's line ranges stale. The head and tail windows now share the spill-threshold budget (head clamped to half), the cap budget derives from the configured threshold plus notice slack, and when the cap does fire on a sink-spilled result it references the existing raw artifact instead of saving a copy.

### Added

- Added the bundled `ts-no-local-is-record` TTSR rule, which catches local `isRecord` function and lambda definitions and directs agents to shared guards plus explicit shape validation.
- A `tool_call` handler (extension or hook) can now return `input` to revise the arguments a tool executes with, not just `block` it. The returned object is the raw execution input passed to the tool (ignored when `block` is set, and not applied to `computer` tool calls), enabling wrappers that normalize or rewrite a built-in's arguments without reimplementing the tool. For model-issued calls the event fires at arg-prep time in the agent loop, so a revision is revalidated against the tool schema and is what concurrency scheduling, `tool_execution_start`/transcripts, the persisted assistant message, and the approval gate all observe — the user approves exactly what runs, and a revision that changes a tool's functional concurrency (e.g. bash `pty`) schedules correctly. A revised nested `write xd://` device dispatch forfeits the outer write gate's approval and faces the full prompt again ([#6681](https://github.com/can1357/oh-my-pi/pull/6681) by [@psyrendust](https://github.com/psyrendust)).
- Added a parser for macOS `sample`(1) call-tree reports to the read tool: `*.sample.txt` reads now return a compact bottleneck summary — per-thread hot paths with on-CPU sample counts (blocked syscall time excluded), demangled Rust v0/legacy symbols, flattened direct recursion, merged call-site siblings, idle-thread classification, and a process-wide top-functions-by-self-samples table. `:raw` still reads the original report, and files that merely carry the extension fall back to plain text.
- Added V8 `.cpuprofile` support to the read tool (Node/Bun `--cpu-prof`, Chrome DevTools, CDP `Profiler.stop` output): reads now return a compact bottleneck summary — hot-path call tree with on-CPU milliseconds (`(idle)` time excluded), collapsed pass-through chains, flattened direct recursion, shortened file URLs, and a top-functions-by-self-time table. `:raw` still reads the original JSON, and files that merely carry the extension fall back to plain text.

### Changed

- Direct and `xd://` dispatch now share one canonical tool map: `write xd://<tool>` executes any enabled top-level or mounted tool, and `read xd://<tool>` returns its docs, instead of failing when the name was exposed through the other layer. Mounted names are presentation metadata only, so tool replacement and disconnection cannot leave stale device instances; disabled tools remain unreachable, and both `xd://` and Cursor/top-level fallback execution retain the tool's approval and ACP permission gates.
- Session listing now caches parsed headers keyed on file stat identity (mtime + size), so repeated resume-picker opens and startup scans re-read only changed session files
- Reduced per-keystroke editor dispatch overhead: keybinding resolution happens once per input chunk and the per-action interception chain is gated behind a single canonical-key set probe
- `xd://` device docs now render the parameter schema as a comment-annotated TypeScript type (via `jsonSchemaToTypeScript`, the same renderer the in-band tool inventory uses) instead of a raw JSON Schema dump, shrinking system-prompt device sections while keeping descriptions inline.
- Added a `/vision [on|off|auto|status]` slash command for session-scoped control of the `inspect_image` vision-delegation tool, modeled on `/computer`: `on`/`off` force the tool for the current session only, `auto` returns to the persisted setting, and `status` reports the effective mode, session override, tool state, and active-model image capability.
- Replaced the `inspect_image.enabled` boolean with the tri-state `inspect_image.mode` (`auto`|`on`|`off`, default `auto`). In `auto` the tool is registered only when the active model lacks native image input, so vision-capable models (e.g. `kimi-code/k3`) read images inline with their own capabilities instead of delegating to a separate vision model; the tool set is re-evaluated on every model switch with a status notice when it flips. The `read` tool now follows the effective state dynamically rather than the raw setting, so it returns decoded image blocks again whenever `inspect_image` is hidden. Existing `inspect_image.enabled: true/false` configs migrate to `inspect_image.mode: on/off`.

## [17.1.6] - 2026-07-27

### Added

- Added separate Advisor cost visibility to the status line, rendering primary and Advisor spend as `$2.67 (sub) + $0.41 (adv)` while keeping already-incurred Advisor cost across runtime disablement and same-session history rewrites.

### Changed

- Made the task tool's per-spawn `effort` parameter opt-in through `task.enableEffort`, which defaults to false and omits the field from flat and batch schemas and tool guidance until enabled.
- Reduced terminal-title update overhead by deduplicating unchanged titles on every platform and using `SetConsoleTitleW` through `bun:ffi` instead of OSC writes on Windows. Windows working titles now keep a static `:` separator instead of scheduling spinner updates; other platforms retain the animated separator.
- Added `task.maxEffort` to cap the task tool's optional per-spawn effort hint after model-specific resolution, so operators can enable effort hints without allowing them to exceed a configured ceiling; the ceiling now also rides into the spawned session so retry-fallback model swaps re-clamp to it instead of escalating past the cap ([#6580](https://github.com/can1357/oh-my-pi/issues/6580), [#6794](https://github.com/can1357/oh-my-pi/pull/6794) by [@wolfiesch](https://github.com/wolfiesch)).
- Restructured the steering/interjection envelope sent to the model: the injected `<user_interjection>...<message>...</message>...` wrapper around user text is now a `<system-notice>` explaining the interjection followed by the user's raw message unwrapped, matching the existing `<system-notice>`/`<system-directive>` convention instead of nesting the literal message inside its own tag pair, which some models found confusing.

### Fixed

- Fixed a disabled higher-priority MCP server no longer disabling a same-named lower-priority one: disabled servers are now suppressed after key-level dedupe instead of dropped before it, so a project `foo` with `enabled: false` keeps the user-level `foo` off while still not starving a differently-named equivalent connection.
- Fixed the MCP tool-name collision winner flipping when the current owner reconnects: the winner is now chosen by a stable server+tool key instead of tool-array insertion order, which reconnects reorder.
- Fixed MCP resources with custom URI schemes being treated as missing filesystem paths. `read` and `omp read` now resolve server-advertised native resource URIs such as `ags://capabilities/current-host`, while preserving the existing `mcp://<resource-uri>` form.
- Fixed three gaps in native MCP resource URI resolution: server-advertised URIs whose path is exactly `/` (e.g. `catalog://root/`) are now preserved byte-for-byte instead of losing the trailing slash to reconstruction; opaque resource URIs (`urn:example:document`, `custom:item`) are recognized by the `read` and `omp read` resolver gates instead of falling through to filesystem handling; and a failing `resources/templates/list` no longer discards a successful `resources/list`, which previously produced a false missing-resource error.
- Fixed custom LSP servers sending `languageId: "plaintext"` for extensions outside the built-in language map by honoring an optional per-server `languageId` in `lsp.json` for disk and in-memory document opens ([#6800](https://github.com/can1357/oh-my-pi/issues/6800)).
- Fixed interactive extension confirmations ignoring `dialogOptions`, and cancelled handler-owned dialogs when the extension watchdog times out so stale approval UI cannot outlive a blocked tool call ([#6805](https://github.com/can1357/oh-my-pi/issues/6805)).
- Fixed the per-handler extension context snapshotting the live `ctx.model` getter, so a handler calling `pi.setModel()` and then reading `ctx.model` saw the stale model; the scoped context now delegates to the base context instead of spreading it.
- Fixed Python cell errors (`$` commands and the eval tool) leaking runner-internal traceback frames. Cell syntax errors now render as the bare caret display with a `<cell>` filename instead of a `_handle_request_async`/`ast.parse` stack dump, and runtime tracebacks start at user code, matching the Ruby runner's user-frame filtering.
- Dropped unavailable forced tool choices through the queue rejection lifecycle and discarded their remaining sequence yields so a skipped force cannot disable tools on the next request ([#6543](https://github.com/can1357/oh-my-pi/pull/6543) by [@paralin](https://github.com/paralin)).
- Fixed identical MCP server connections discovered under direct and marketplace-plugin names spawning twice and duplicating mounted tool routes; distinct tools whose server names sanitize to the same route now keep the first registration and log both origins ([#6786](https://github.com/can1357/oh-my-pi/issues/6786)).
- Fixed `/usage` and the other large transcript command panels (`/session`, `/advisor status`, `/jobs`, `/changelog`, `/context`, `/memory view`) duplicating in native scrollback when invoked while an agent turn is streaming. These callsites mounted their finalized panel immediately via `present()` instead of deferring it until the turn ends via `presentCommandOutput()` (the path added in #5427 for `/tools`/`/mcp`), so the panel landed above a still-growing live block and was recommitted lower down ([#6767](https://github.com/can1357/oh-my-pi/issues/6767)).
- Fixed plan-mode task subagents unregistering extension-provided models, credentials, managers, and custom APIs from the shared parent `ModelRegistry` when restricted sessions intentionally skip extension loading ([#6783](https://github.com/can1357/oh-my-pi/issues/6783)).
- Fixed `/live` sideband WebSockets ignoring standard proxy environment variables and `NO_PROXY`, which left proxied sessions stuck while the rest of the Codex connection succeeded ([#6770](https://github.com/can1357/oh-my-pi/issues/6770)).
- Fixed the bash tool's `kill` builtin rejecting numeric signals and multiple process operands, stopping after the first failed target, and defaulting to `SIGKILL` instead of the standard `SIGTERM`. Negative PID operands (process groups per `kill(2)`) and the `--` end-of-options marker are now handled instead of being misparsed as signals ([#6779](https://github.com/can1357/oh-my-pi/issues/6779)).
- Fixed `learned.md` saves growing a blank line on every write (trailing-newline split artifact) and hoisting all headings/prose above all bullets, which re-scoped lessons under the wrong heading in hand-organized files. Saves are now byte-idempotent and preserve mixed Markdown ordering: non-list lines keep their positions, new lessons insert newest-first at the head of the first bullet run, and dedupe/cap operate on bullet lines in place.

## [17.1.5] - 2026-07-27

### Added

- Added a configurable per-request timeout for the `inspect_image` tool (`inspect_image.timeoutMs`, default 5 minutes; set to 0 to disable) so a stalled vision-model provider fails fast with a clear error instead of blocking until manual abort ([#4165](https://github.com/can1357/oh-my-pi/issues/4165)).

### Changed

- Reduced default startup resident memory by constructing the default-off ComputerTool ArkType schema only on first parameter access, then reusing it across tool instances without changing validation or tool behavior ([#6742](https://github.com/can1357/oh-my-pi/pull/6742) by [@usr-bin-roygbiv](https://github.com/usr-bin-roygbiv)).
- Reduced startup CPU and memory by loading the bundled changelog only when needed, while preserving source, npm bundle, standalone binary, and native absolute-path fallback resolution.
- Moved PTY log replay into the shared project launch broker, so normal CLI and Hub startup no longer load the xterm runtime while launch logs return validated rendered terminal rows.

### Fixed

- Fixed DeepSeek V4 Flash and Step 3.7 Flash models using hashline edit mode by default despite repeatedly misreading its range grammar; both now use the simpler replace-mode fallback unless explicitly overridden ([#6671](https://github.com/can1357/oh-my-pi/issues/6671)).
- Fixed an Ask form appearing while the main prompt contains a draft hiding that text and consuming the next in-flight keystroke. The draft now remains visible and keeps receiving input until it is submitted or cleared; only then do form controls activate ([#6737](https://github.com/can1357/oh-my-pi/issues/6737)).
- Fixed `glob` rejecting safe `memory://root/<directory>/**` patterns. Memory globs now resolve their directory prefix inside the project memory root while rejecting traversal and percent-encoded path separators across the complete glob path.
- Fixed `omp --resume <id>` prompting to fork sessions from another existing directory instead of switching the process and cwd-scoped settings into the resumed session's recorded directory ([#6752](https://github.com/can1357/oh-my-pi/issues/6752)).
- Fixed deferred CLI model roles resolving ambiguous bare model IDs to a preferred but unauthenticated provider instead of the authenticated provider selected by the eager path ([#6727](https://github.com/can1357/oh-my-pi/issues/6727)).
- Fixed Windows sessions crashing with an unhandled `EPIPE: broken pipe, write` when an LSP server closed its stdin between filesystem mutations; LSP writes now observe asynchronous `FileSink.write()` failures and route them through the existing request/notification failure path.
- Fixed the bash tool's `stat` builtin failing on native Windows with `stat: unsupported on this platform` (exit 1) for every invocation. The vendored `uu-stat` now ships a Windows-native backend that maps the GNU format directives onto `std::fs::Metadata`, the `windows_by_handle` metadata extensions (inode, hard-link count, and device via `GetFileInformationByHandle`), and the Win32 volume APIs for `--file-system` mode; Unix behavior is unchanged ([#6723](https://github.com/can1357/oh-my-pi/issues/6723)).
- Fixed auto-retry wedging the session after an assistant-tail removal miss: when a context rebuild recreated the failed turn's message object, the identity-keyed cleanup logged `assistant removal missed` but the retry still scheduled `continue()`, which rejected the terminal assistant error message locally (`Cannot continue from message role: assistant`) before any provider request — `auto_retry_end` never fired, the TUI kept showing retry progress, and the in-flight `prompt()` hung until a manual follow-up. The retry path now strips a still-failed assistant tail positionally after the backoff, and a continuation that still fails locally closes the retry saga with a failed `auto_retry_end` ([#5382](https://github.com/can1357/oh-my-pi/issues/5382)).
- Fixed native Anthropic web-search history being recursively truncated during session persistence or retained under a different user turn, preserving opaque replay bytes across reload and stripping them on reparent ([#6703](https://github.com/can1357/oh-my-pi/issues/6703)).
- Fixed malformed or temporarily unreadable `config.yml` files being treated as empty settings and then overwritten by the next setting change, which could permanently erase broker tokens, model roles, and provider configuration. Invalid YAML is now moved to a timestamped `.broken-*` backup, read failures abort without touching the source, pending changes remain retryable with the last successfully loaded settings, atomic writes preserve symlink targets and handle Windows `EPERM` replacement, concurrent startup failures are fully observed and quarantine races fail closed, and `omp config set/reset` waits for persistence before reporting success.
- Fixed mounted MCP tools being hard to invoke when server or plugin guidance names their original calls: sessions now include one bounded, exact original-name-to-`xd://` route map for every live mounted MCP tool—including servers without initialize instructions—and refresh it as catalogs change without disabling schema virtualization.
- Fixed `inspect_image` blocking indefinitely when the vision-model API stalls by combining the caller's abort signal with an `AbortSignal.timeout()` and surfacing a distinct timeout `ToolError` (separate from user-triggered abort) ([#4165](https://github.com/can1357/oh-my-pi/issues/4165)).
- Fixed MiMo models using hashline edit mode by default despite needing the same replace-mode fallback as Kimi. ([#3772](https://github.com/can1357/oh-my-pi/issues/3772))
- Fixed `omp` refusing to start on Windows when no `bash.exe` is discoverable — most visibly with scoop-installed Git, whose manifest shims `sh.exe`/`git.exe` but never `bash.exe`, so PATH lookup missed it. Startup threw `No bash shell found` while merely building the bash tool description, even though bash tool commands always execute in the embedded brush-core shell and need no host bash. Shell discovery now also checks `GIT_INSTALL_ROOT`, scoop and per-user Git for Windows install roots, and `sh.exe` on PATH, then falls back to `cmd.exe` for the spawn-only paths (interactive PTY, ACP client terminals) instead of failing; the cmd fallback is never used to wrap user-shell commands — brush runs the POSIX line directly.
- Added a selectable voice setting for `/live` realtime sessions ([#6566](https://github.com/can1357/oh-my-pi/issues/6566)).

## [17.1.4] - 2026-07-26

### Added

- `omp usage` now surfaces auto-disabled credentials as red `✗` tombstone rows (identity, how long ago, the shortened upstream cause — e.g. `Refresh token expired` — and a re-login hint), including a provider section when no active credential remains. User-driven tombstones (`replaced by newer credential`, `deleted by user`) and API-key rows stay hidden. Requires a broker with `GET /v1/credentials/disabled`; older brokers degrade to no tombstone rows.
- `omp usage` warns about Anthropic's ~30-day OAuth grant lifetime: accounts whose interactive login (`authorizedAt`) is within a week of the deadline get a yellow `⚠ re-login within <time>` line, and past-deadline accounts a red one. Grants die server-side exactly ~30 days after login regardless of refresh rotation, so this is the only warning before the broker auto-disables the row.

### Changed

- Enabled Computer Use sessions now state the desktop-routing contract in the compact system prompt, retain their controller across model switches, expose effective native/function routing through `/computer status`, and emit structured lifecycle diagnostics without logging captured content.

### Fixed

- Fixed dragging an image whose path contains unescaped spaces (e.g. macOS screenshot names like `Screenshot 2026-07-24 at 1.55.12 PM.png`) into the terminal — the bracketed-paste image extraction route now has the same whole-text-as-path fallback as the clipboard keybind route, so both routes share identical detection and attach the image instead of inserting the raw path as literal text ([#6578](https://github.com/can1357/oh-my-pi/issues/6578)). The shared fallback only claims payloads that hold a single path: one carrying a second absolute-path anchor after unescaped whitespace (`/tmp/a.png /tmp/b shot.png` — dragging two files at once when either name has spaces) now pastes as text on both routes instead of being fused into one unresolvable path, which on the clipboard route previously attached nothing and swallowed the text behind an "Image not found" status.
- Fixed transient reasonless request aborts that arrived after a tool call finished streaming ending the turn instead of entering recovery, which left edit calls and task subagents dead until the user manually resumed. The session now continues from the synthetic unexecuted tool result under the normal retry policy without replaying completed side effects ([#6668](https://github.com/can1357/oh-my-pi/issues/6668)).
- Fixed prewalk silently dropping a same-model hand-off that only lowers the thinking level: the arm/switch guard compared model identity alone and discarded the resolved `thinkingLevel`, so a legal effort-downgrade target (e.g. `prewalk: "@task"` resolving to the same model at a cheaper effort) never applied and the session paid the plan/continue nudges for nothing. Prewalk now compares `(provider, id, effective thinking level)`, applies effort-only hand-offs, and emits a notice on a genuine no-op instead of returning silently ([#6659](https://github.com/can1357/oh-my-pi/issues/6659)).
- Fixed `@czottmann/pi-automode` failing legacy extension validation because the pi-ai compatibility shim omitted `clampThinkingLevel`, then failing every classified tool call because `ctx.modelRegistry` omitted `getApiKeyAndHeaders`. ([#6648](https://github.com/can1357/oh-my-pi/issues/6648))
- Fixed hide-secrets placeholders conflicting with hashline edit headers by replacing hash-delimited tokens with the unambiguous `$$HASH$$` format ([#6631](https://github.com/can1357/oh-my-pi/issues/6631)).
- Fixed the advisor silently swallowing its own quarantined turns: when an advisor called an ungranted tool (e.g. `bash`) its whole turn was discarded before dispatch, so its advice never reached the primary agent and the failure surfaced only in advisor diagnostics — every other non-recovering failure branch notifies the host UI, but quarantine re-primed silently with no bound. A persistently-quarantining advisor now surfaces a `notifyFailure` warning in the main UI (deduped, cleared on the next successful turn) and stops the unbounded silent re-prime loop ([#6661](https://github.com/can1357/oh-my-pi/issues/6661)).
- Fixed the Docker `natives-builder` stage failing to build releases ≥ 17.1.1: the native audio stack added bindgen (miniaudio needs libclang) and a bundled-opus CMake build (needs cmake + make), none of which were installed in the slim builder image.
- Fixed a configured `modelRoles.default` naming an extension-registered model (listed in `enabledModels`) silently running on a different in-scope provider's model. The startup model scope is resolved before extensions call `registerProvider()`, so the default role dropped out of scope and `buildSessionOptions` pinned `options.model` to the first scoped model — which marked the model "explicit" and suppressed the post-extension default-role re-resolution. A configured default that can't be found in the startup scope is now deferred so it re-resolves against the fully registered, still `enabledModels`-scoped catalog once extensions load ([#6694](https://github.com/can1357/oh-my-pi/issues/6694)).
- Fixed Parakeet speech-to-text failing to load `sherpa-onnx-node` from Windows source workspaces when Bun installed the wrapper under `packages/coding-agent/node_modules` but hoisted its native platform package to the repository root ([#6690](https://github.com/can1357/oh-my-pi/issues/6690)).
- Fixed `omp usage` duplicating org-less legacy accounts as "no usage data" rows whenever any sibling report carried an organization (mixed pools of pre-org-capture rows and fresh org-scoped logins): an org-less account is now covered by its own org-less report, while org-attributed sibling reports still never count as its coverage.
- `omp usage` revalidates the broker credential snapshot before rendering: live usage reports were previously paired with a disk-cached account list up to an hour old, so a just-completed re-login (org-less row upserted to org-scoped) rendered as a phantom duplicate until the cache expired.
- Fixed Advisor requests reaching Anthropic-compatible endpoints without a provider-facing session identity: the separately constructed advisor `Agent` never had a metadata resolver installed, so its outbound requests omitted the `metadata.user_id` session id that the main and subagent agents carry. Each advisor now emits its own `advisorProviderSessionId` via `metadata.user_id`, resolved live so a token refresh surfaces the current `account_uuid`, giving Main, subagent, and Advisor traffic distinct, stable session ids for proxy routing and attribution ([#6625](https://github.com/can1357/oh-my-pi/issues/6625)).
- Todo progress now stays in sync when using Cursor models: the Cursor exec bridge mirrors the provider's server-owned todo list into session state, refreshes the interactive todo panel, and persists each snapshot to the session branch so the list survives reloads, rewinds, compaction, and session switches. Existing phase grouping is preserved for tasks the session already knows. Previously the list was in-memory only and the panel stayed stale, because Cursor resolves the todo tool remotely and never emits the local `todo` tool result that both paths key off.
- Cursor todo calls the server refuses or rejects no longer leave the todo card spinning: the bridge settles every completed native todo call, not just the ones carrying a list. Local phases and the session branch are left untouched in that case, and the settling result deliberately carries no `details.phases` — echoing the current list back would let a call that changed nothing overwrite live panel state.
- Fixed the todo renderer emitting mirrored label text verbatim. A Cursor snapshot carries provider-authored task content, phase names, and summary text, and the renderer interpolated all of it straight into terminal output, so a label holding ANSI/C0 sequences rewrote the terminal every time the list rendered or replayed. Every display path now goes through one sanitize-and-flatten-tabs helper — task labels, blocker notes, phase headers, the zero-task fallback, and the streaming call preview — while the raw values stay untouched as the lookup keys they are.
- Fixed a server-resolved Cursor todo card animating for the rest of the session when the server packed the call's start and completion into one HTTP/2 chunk. The bridge's `tool_execution_end` is a synchronous callback fired mid-parse, while the streamed `toolcall_start` that creates the visible card is queued on the event stream and delivered a microtask later — the interactive controller handled the completion first, found no pending card, and dropped it, leaving the card that appeared moments later with nothing to settle it. An early completion is now held and attached the moment the streamed block creates its card, settling it without repeating the panel refresh or failure warning that already fired on first arrival. Card creation from cumulative `message_update` frames is also guarded by the turn's timeline map, so a call settled mid-stream can no longer be recreated as a second, permanently pending card by the next update re-listing the same block.
- Cursor todo failures no longer render unsanitized provider text into the status line. The bridge forwards the server's error string verbatim, so an ANSI escape or other C0/C1 control reached the terminal intact and could repaint outside the row, tabs punched holes in the single-line warning, and a long message overflowed it. The detail is now stripped of control sequences, collapsed, and truncated at the render boundary; the persisted result keeps the full-fidelity error for the transcript.
- Fixed disabling the Advisor from `/settings` updating the persisted setting without stopping the live Advisor runtime until the session restarted: `SelectorController.handleSettingChange` had no case for `advisor.enabled`, unlike other session-managed toggles (`autoCompact`, `steeringMode`, ...), so the change never reached `session.setAdvisorEnabled`.
- Fixed `bash.patterns` `deny`/`prompt` rules matching only against the whole command string, so a dangerous command in any non-leading position of a compound line (e.g. `cd /tmp && rm -rf /tmp/x`, `sleep 1 & rm -rf /tmp/x`) silently bypassed a `deny` rule and, under `approvalMode: yolo`, executed with no prompt. `deny`/`prompt` rules now also match each command segment, split with a shell-aware tokenizer that honors every command boundary (`&&`, `||`, `;`, `|`, single `&`, subshells, newlines) and quoting; `allow` rules still require the whole command to match and never apply to compound lines ([#6695](https://github.com/can1357/oh-my-pi/issues/6695)).
- Fixed `omp config list` printing credential settings in plain text. `auth.broker.token`, `searxng.token`, `searxng.basicPassword` and `dev.autoqaPush.token` were disclosed in both the human and `--json` output of a command that dumps every value without anyone asking for a specific credential. Credentials are now marked in the schema with a top-level `credential` flag, which also covers settings that have no settings-panel entry and so cannot use `ui.secret`. Human output shows dots; JSON omits `value` and marks the entry `redacted` rather than substituting a placeholder a consumer could write back. `omp config get <path>` is unchanged, since that is an explicit request for one value. The settings panel now derives masking from the same flag, so a credential cannot render as plain text on one surface and dots on the other. Only a credential that is actually set is redacted, so a fresh configuration still reports unset credentials as unset rather than implying every one of them is configured.
- Fixed `/new`, `/drop`, `/fork`, and `/move` crashing or doing unnecessary work when invoked during vibe mode; interactive session transitions now show the existing exit-vibe warning and leave the session unchanged, and reset loops disable themselves instead of resubmitting into that unchanged session ([#6607](https://github.com/can1357/oh-my-pi/issues/6607)).
- Fixed legacy pi extensions failing extension validation when importing `estimateTokens` from `@earendil-works/pi-coding-agent` (aliased to the legacy shim). Legacy pi re-exported `estimateTokens` from its coding-agent package root; in omp it lives in `@oh-my-pi/pi-agent-core/compaction` and the coding-agent barrel does not forward it, so the shim's `export * from "../index"` left it off the surface and a named import threw Bun's static "Export named 'estimateTokens' not found" error (e.g. `omp plugin install pi-blackhole`). The shim now re-exports it ([#6583](https://github.com/can1357/oh-my-pi/issues/6583)).
- Fixed plan approval presenting a completed plan instead of the newest draft when the submitted title did not match the draft filename ([#6569](https://github.com/can1357/oh-my-pi/issues/6569)).
- Fixed `omp auth-gateway serve` advertising only the compiled-in bundled catalog, so every model omp reaches through provider discovery (e.g. ids released after the build date) was invisible on `/v1/models` and returned `Unknown model` through `/v1/chat/completions` even though the same broker credential answered it in the TUI. The gateway now sources its catalog from `ModelRegistry` — the same component the TUI/CLI use (bundled + cached + discovered) — keeping the credential scoping and qualified/bare-id registration, and rebuilds it periodically so a long-lived `serve` tracks newly discovered models without a restart ([#6615](https://github.com/can1357/oh-my-pi/issues/6615)).
- Fixed screenshot-relative pointer actions missing their visible targets when image transports that cannot preserve original detail silently downscaled a large computer screenshot; affected transports now establish the native coordinate frame below the verified image-resize threshold without changing the public capture defaults for other models ([#6596](https://github.com/can1357/oh-my-pi/pull/6596) by [@wolfiesch](https://github.com/wolfiesch)).
- Corrected Windows shell resolution errors to identify the active global, project, overlay, or runtime source for `shellPath`, including profile and custom configuration directories, instead of directing every user to the retired `settings.json` file ([#6579](https://github.com/can1357/oh-my-pi/issues/6579)).
- Fixed `debug` (js-debug/`pwa-node`) stateful commands misrouting after launch: a lazily-attached `[worker N]` child session (or the threadless root launcher) would steal the active-session focus from the stopped script child, so `threads` listed only the worker thread, post-launch breakpoints read back as pending/unbound, and there was no way to step/continue/evaluate the script's thread. Focus now follows stops rather than registrations, and `threads` aggregates every live thread across the session tree ([#6663](https://github.com/can1357/oh-my-pi/issues/6663)).
- Fixed a turn-ending provider error being truncated to 8 lines in the transcript with no way to reveal the rest: `AssistantMessageComponent` now implements `setExpanded`, so Ctrl+O (tool-output expansion) reveals the full error body and the collapsed view shows a `… +N more lines (Ctrl+O to expand)` hint ([#6555](https://github.com/can1357/oh-my-pi/issues/6555)).
- Fixed direct binary updates trusting an executable that only reported the expected version. The updater now selects one exact asset from the tagged GitHub release, requires its published SHA-256 digest and size, and verifies both while streaming the download before installation. GitHub release metadata requests use `GITHUB_TOKEN` or `GH_TOKEN` when available, allowing users behind an exhausted anonymous rate limit to authenticate.
- Documented that the non-PTY shell's bundled `jq` command is backed by jaq, including its null-indexing divergence and portable filter syntax ([#6614](https://github.com/can1357/oh-my-pi/issues/6614)).
- Fixed `omp://tools/task.md` and `omp://tools/eval.md` drifting from the 17.1.3 runtime: `task.md` claimed subagents force-disable `async.enabled`/`bash.autoBackground.enabled` (both are inherited from the parent since 17.1.0) and omitted the `task` tool's `effort` parameter, and `eval.md` omitted the still-working eval `agent(model=…)` per-call model selector ([#6594](https://github.com/can1357/oh-my-pi/issues/6594)).
- Fixed advisor retry amplification after transient Codex SSE socket closures by limiting each advisor-level try to one provider transport attempt.
- Fixed `omp update` aborting with `npm error EEXIST` on standalone binary installs whose directory coincides with the global npm/bun bin dir (for example `npm prefix -g` set to `~/.local`, which the installer also targets). The install-target resolver classified the binary as npm/bun-managed from directory containment alone, so `npm install -g` tried to replace a regular file its symlink step would clobber; it now treats a plain executable (not a symlink) in a package-manager bin dir as the standalone binary and self-updates it in place ([#6527](https://github.com/can1357/oh-my-pi/pull/6527) by [@am423](https://github.com/am423)).
- Fixed Codex subscription and proxy models being sent the unsupported native `{ type: "computer" }` declaration based only on model ID. They now receive the callable function-tool fallback, including after switching from native OpenAI Responses history, while explicit endpoint metadata can still opt into the GA contract. Explicit native Codex replays preserve `computer_call`/`computer_call_output` pairing, normal CLI startup keeps the native desktop worker graph lazy, and packaged workers re-enter the single CLI host without the computer module claiming non-computer selectors.
- Fixed isolated JavaScript eval subprocesses letting the global fatal-rejection handler race the cell rejection interceptor. A floated promise rejection is now folded into the owning cell result without killing its reusable worker process.
- Fixed `/context` counting hidden, explicit-only skills (`hide: true` / `disable-model-invocation`) in the Skills category and subtracting that inflated estimate from the first system-prompt block, which reported `System prompt: 0 tokens` and inflated Skills usage. Accounting now counts only the skills actually rendered into the system prompt — mirroring `buildSystemPrompt`'s filter, so hidden skills and all skills when the `read` tool is unavailable contribute zero ([#6498](https://github.com/can1357/oh-my-pi/issues/6498)).
- Fixed `pi-sprite` failing plugin validation because the legacy Pi compatibility shims omitted `createExtensionRuntime` and terminal capability/image-deletion helpers used by the extension ([#6506](https://github.com/can1357/oh-my-pi/issues/6506)).
- Fixed Escape waiting for an in-flight `session_stop` extension handler to exhaust its timeout; abort now cancels the active stop pass without reporting a false timeout or applying stale continuation context ([#6489](https://github.com/can1357/oh-my-pi/issues/6489)).
- Fixed the agent not resuming after re-answering a past `ask` from the session tree. Committing a new answer via `/tree` branched a fresh sibling `toolResult` and rebuilt context, but nothing ever continued the agent — unlike a live `ask`, whose continuation is intrinsic to the streaming run loop — so the model never consumed the new answer and the session sat idle until a manual prompt. `navigateTree` now reports the commit (`askReanswerCommitted`) and the interactive `/tree` handler resumes the agent via `resumeAfterAskReanswer()` *after* its transcript rebuild, so the resumed turn never renders against the stale pre-rebuild UI. Plain leaf moves and the read-only `reopenAsk` probe stay idle ([#6483](https://github.com/can1357/oh-my-pi/issues/6483)).
- Fixed Ctrl+C and fatal shutdown entering an `ExtensionExitError` rejection loop while an extension or hook was still loading ([#6488](https://github.com/can1357/oh-my-pi/issues/6488)).

## [17.1.3] - 2026-07-24

### Fixed

- Fixed the in-process `find` builtin's `-exec`/`-execdir` children inheriting the omp process's real stdout/stderr, so commands like `find … -exec ls -ld {} \;` spammed their output straight into the terminal (corrupting the TUI) instead of the tool's captured output, and bypassed shell redirects. Exec children now stream stdout/stderr back through the shell's scope streams (matching `xargs`/`ifne`) and run with the shell's exported environment (`env_clear` + scope snapshot) instead of the host process environment.
- Fixed `ast_edit` erroring with "`lang` is required" — an argument that no longer exists in the tool schema — when `paths` resolved to files of multiple languages (e.g. a crate directory with `.rs` + `.toml`). Mixed-language paths now rewrite per file: each file is parsed in its own inferred language, patterns are compiled per language, and a pattern that doesn't parse in some matched language simply skips those files.
- Fixed the `retain` tool's TUI renderer crashing when streaming arguments temporarily expose a non-array `items` value ([#6528](https://github.com/can1357/oh-my-pi/issues/6528)).
- Fixed Edit and Write tools failing with `Settings not initialized` in isolated sessions by using each tool session's settings for generated-file guards, with safe schema defaults for standalone guards and inline-image rendering ([#6549](https://github.com/can1357/oh-my-pi/issues/6549)).

## [17.1.2] - 2026-07-24

### Added

- Added in-process moreutils-style shell builtins to the bash tool's embedded shell: `ts` (timestamp lines; `-i`/`-s` elapsed modes, `-m` monotonic clock, `-r` relative rewriting of RFC3339/syslog timestamps, `%.S`/`%.s`/`%.T` subsecond extensions), `sponge` (soak stdin fully before atomically writing the target, so `foo file | ... | sponge file` works; `-a` appends), `ifne` (run a command only when stdin is non-empty; `-n` inverts and passes non-empty stdin through), `isutf8` (streaming UTF-8 validation with line/char/byte diagnostics; `-q`, `-l`, `-i`), `combine` (boolean `and`/`not`/`or`/`xor` on the lines of two files, `-` for stdin), and `errno` (errno name/number/description lookup with `-l` list and `-s` search; unix only). Like the uutils-backed builtins, they run in-process against the command's own stdio, resolve paths against the shell working directory, honor cancellation, and are disabled by `PI_DISABLE_UUTILS_BUILTINS`.
- The bash tool prompt now lists the available shell builtins (`mkdir` through `jq`, `rm`/`mv`/`ln`, and the moreutils set) so the model relies on them without existence checks; the line is dropped when `PI_DISABLE_UUTILS_BUILTINS` disables the builtins and omits unix-only `errno` on Windows.
- Sessions using a broker-backed auth store now report each completed request's token usage and cost to the auth broker (batched, 10s cadence) so the broker can track actual token burn per client install
- Added a per-spawn `effort` parameter to the `task` tool (`"lo"` | `"med"` | `"hi"`): each selector maps onto the resolved model's supported thinking range (lowest, middle, and highest level — whatever the model tops out at, e.g. `high`, `xhigh`, or `max`) and overrides the agent's default selector, including `auto`. Omitting `effort` keeps the existing automatic per-prompt thinking classification.
- Added `searxng.engines` setting for the SearXNG web search provider: a comma-separated list of engine names or bang shortcuts (e.g. `ddg, br, startpage`) sent as the API's `engines=` parameter. Shortcuts are resolved to canonical engine names via the instance's `/config` endpoint (cached per endpoint; entries pass through verbatim if `/config` is unreachable). Bang syntax in queries (`!ddg foo`) continues to pass through to the instance, and external bangs (`!!g`) are now stripped client-side since SearXNG answers them with an HTTP redirect even for JSON requests.
- Web search queries now understand Google-style directives on every provider: `site:`/`-site:` (plus `domain:`/`host:` aliases), `after:`/`before:`/`since:`/`until:` date bounds, `inurl:`/`intitle:`/`intext:`/`allin*:`, `filetype:`/`ext:`, `lang:`, quoted phrases (including smart quotes), `+term`, `-`/`NOT` exclusions, and `OR`/`|` groups. A shared parser (`web/search/query.ts`) structures the query once per request; each provider maps constraints onto native API filters where the upstream supports them (Perplexity domain/date/language filters on both the API-key and ask paths, Tavily `include_domains`/`exclude_domains` + `start_date`/`end_date`, Exa domain lists + published-date bounds on API and MCP paths, Anthropic `allowed_domains`/`blocked_domains`, xAI `filters.allowed_domains`/`excluded_domains`, Parallel `source_policy`, Brave absolute `freshness` ranges, Firecrawl `tbs=cdr` date ranges, Jina `X-Site`, SearXNG `language`) and otherwise re-emits only the operator syntax its engine parses (full Google syntax for Gemini grounding, OpenAI, Kagi, and the credential-free scrapers — with scraper-hostile path-`site:`/`inurl:` operators demoted to plain keywords; conservative subsets for DuckDuckGo, Mojeek, Kimi, Z.AI, TinyFish, and Synthetic). The pipeline then applies a lenient post-filter to every response: constraints the engine ignored are enforced on the returned sources, and any constraint dimension that would eliminate every result is relaxed and reported to the model (`Note: no results matched \`site:...\`; the constraint was relaxed`) instead of returning nothing. Directive-free queries are passed through byte-identical everywhere.
- Eval and browser `run` code previews are now prettified for display: minified/compact agent-written cells are expanded by conservative streaming formatters (Python, JavaScript, Ruby, Julia) that indent block structure, split statements, normalize operator spacing (JS), and expand object literals wider than 100 columns onto one property per line — purely for rendering, the executed source is untouched. The formatters handle in-flight prefixes (unterminated strings/comments/blocks) without inventing closers, and layout decisions are prefix-stable so already-rendered lines never reflow while a call streams.

### Changed

- Large pastes saved via the large-paste menu now insert `local://paste-N.md` references (previously `local://attachment-N`), so the saved paste carries a markdown extension and a clearer name.
- Raw SSE debug capture now trims over-budget events smartly instead of chopping off the tail: tool definitions inside `data:` payloads are compacted first (name kept, schema/description elided — often enough to keep the whole payload as valid JSON), and anything still over the 64k cap keeps its head and tail with a `: omp-debug-elided chars=N` comment marking the removed middle, so trailing fields like `usage` stay visible.
- The `web_search` tool prompt now tells the model to never search for content that is programmatically accessible or has a known URL (GitHub, known arXiv papers, Wikipedia pages, official docs) and to `read` the URL directly instead.

### Fixed

- Fixed `todo` calls that omit `op` hard-failing validation ("op must be operation to apply (was missing)"): the tool now validates leniently and infers the op for unambiguous payloads (`list` → `init`, `phase`+`items` → `append`, bare `items` on an empty list → `init`); `op` stays required in the schema, and ambiguous op-less calls surface the schema error as a retryable tool error.
- Fixed credential-free web search engines (SearXNG, DuckDuckGo, Google, Startpage, Ecosia, Mojeek, and the Public Web fan-out) returning zero results for queries with `site:` paths (e.g. `site:github.com/owner/repo`) or `inurl:` operators: scraper engines only match `site:` against a bare domain and DuckDuckGo ignores `inurl:` entirely, so such queries silently emptied the result set and fell through to the next provider in the chain. A shared `formatScraperQuery` formatter now structurally demotes path-carrying `site:` and all `inurl:` values to plain search terms (covering OR-grouped and quoted directives) while preserving bare-domain `site:` filters, negated operators, and each engine's supported syntax; the pipeline post-filter still enforces the demoted constraints on returned sources.
- Fixed `ast_edit` previews reading like applied edits to the model: the `⟨proposed⟩` badge was TUI-only, so the model-visible result (hashline header + `-`/`+` rows, identical to applied edit output) carried no staged-proposal signal. The preview result now leads with a "Staged as a proposal — files NOT modified yet" notice naming `xd://resolve`/`xd://reject`, the injected resolve reminder names the source tool, and the `ast_edit` tool prompt documents the two-phase flow.
- Fixed the `hub` launch `ps`/`list` response burying the active process behind every exited one and growing without bound in long-lived projects: the broker now lists non-terminal daemons first (oldest to newest) and caps exited/failed history at the 10 most recently exited, so the active launch is immediately visible and the response stays bounded. Broker recovery also preserves each already-terminal daemon's real exit time instead of overwriting it with the restart timestamp, so the history cap keeps the genuinely most-recently-exited processes after an idle-broker restart ([#6517](https://github.com/can1357/oh-my-pi/issues/6517)).
- Fixed a tool call rendering twice in the transcript. A mid-stream `rebuildChatFromMessages` (from `/shake`, auto-compaction, or a settings toggle) preserves the live `pendingTools` components across the clear+replay, but that preservation assumed every pending-tool component was still dangling. When a tool's result had already landed in the session entries while its component still lingered in `pendingTools`, the replay reconstructed the completed block *and* the preserved live component was re-appended, so the same block appeared twice; resolved components are now dropped from preservation and owned by the replay ([#6516](https://github.com/can1357/oh-my-pi/issues/6516)).
- Fixed `--model default` (and other bare role names) resolving to the bundled `cursor/default` catalog model instead of the configured `modelRoles.default` role. `resolveCliModel`'s exact-match phase ran its unauthenticated catalog fallback before role resolution, so a bundled id colliding with a reserved role name shadowed a configured, runnable role — failing with `No API key found for cursor` on machines without Cursor credentials. The catalog fallback is now deferred so an authenticated exact model still wins, a configured role beats an unauthenticated catalog-only id, and the catalog id is still recovered when no role matches ([#6508](https://github.com/can1357/oh-my-pi/issues/6508)).

### Removed

- Removed the `model` parameter from `task` and `agent()`: explicit per-spawn model selectors and fallback chains are no longer supported; spawns always use the agent's configured model

Older entries are archived in [packages/coding-agent/CHANGELOG.md@0045e59216f5](https://github.com/can1357/oh-my-pi/blob/0045e59216f5911ea4ebeb960c3bc0b96f254f8c/packages/coding-agent/CHANGELOG.md).
