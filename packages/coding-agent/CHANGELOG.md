# Changelog

## [Unreleased]

### Changed

- Models configuration accepts `supportsPromptCacheBreakpoints` for custom OpenAI-compatible gateways ([#12880](https://github.com/can1357/oh-my-pi/pull/12880) by [@ZenAlexa](https://github.com/ZenAlexa)).
### Fixed

- Fixed the Windows bash tool exporting `TEMP`, `TMP`, and `TMPDIR` with 8.3 short names such as `ADMINI~1`, so they now match the long-form `pwd`/`$PWD` after `cd "$TEMP"` ([#13265](https://github.com/can1357/oh-my-pi/pull/13265) by [@CoderTCY](https://github.com/CoderTCY))
- `edit` and `write` no longer refuse handwritten files named `generated.go`, `generated.ts`, `generated.js`, or `generated.py`; these are treated as auto-generated only when their header carries a generated-code marker ([#13138](https://github.com/can1357/oh-my-pi/issues/13138), [#13139](https://github.com/can1357/oh-my-pi/pull/13139) by [@radkawar](https://github.com/radkawar))
- Fixed the `edit` tool warning that valid Go 1.26 `new(expr)` calls (e.g. `new(f(x))`) introduced a syntax error, and `ast_grep`/`ast_edit` reporting parse errors on them ([#13148](https://github.com/can1357/oh-my-pi/issues/13148), [#13149](https://github.com/can1357/oh-my-pi/pull/13149) by [@radkawar](https://github.com/radkawar))
- Fixed hashline `PUT N*` / `CUT N*` on the first statement of a block (for example a Go or Python function that opens with an `if`) also replacing or deleting every statement after it ([#13153](https://github.com/can1357/oh-my-pi/issues/13153), [#13154](https://github.com/can1357/oh-my-pi/pull/13154) by [@radkawar](https://github.com/radkawar))
- Fixed the `Full output: artifact://` link on large background bash and eval results pointing at a truncated copy with `[…elided…]` gaps instead of the complete output ([#13142](https://github.com/can1357/oh-my-pi/issues/13142), [#13143](https://github.com/can1357/oh-my-pi/pull/13143) by [@radkawar](https://github.com/radkawar))
- Fixed `grep` paths like `dir/*.go` also matching files in subdirectories of `dir` ([#13146](https://github.com/can1357/oh-my-pi/issues/13146), [#13150](https://github.com/can1357/oh-my-pi/pull/13150) by [@radkawar](https://github.com/radkawar))

## [18.3.1] - 2026-09-25

### Added

- Added native filesystem support for `local://` and `omp://` URLs across file-search, content-search, AST, shell, and related tools, including support for virtual working directories.
- Added a native `cp` builtin for filesystem copy operations.
- Added IDA Pro integration for opening executables and IDA databases, browsing pseudocode, assembly, imports, exports, strings, and cross-references, and performing database-aware actions such as renaming, commenting, type editing, function creation, saving, and persistent Python execution.
- Added shared, project-scoped IDA database access with broker-managed host processes, configurable concurrency and idle cleanup via `ida.maxOpen` and `ida.idleCloseSec`, automatic autosaving, and universal Mach-O architecture selection with `:@<arch>` syntax and host-architecture detection. IDA features can be configured with `ida.enabled`, `ida.python`, and `ida.installDir`.
- Added the `/slow [on|off|status]` command for opting into lower-priority service tiers on OpenAI, Google, and Anthropic subscription sessions, including automatic continuation when Anthropic session limits are reached.
- Added the `providers.openaiLiveSteering` setting to control whether input can be delivered while a response is in progress.
- Added session-wide approval for configuration changes through an `Always for this session` option in `cfg://` prompts, with clear timeout handling for unanswered prompts.
- Added the `cfg://` protocol and a configuration registry for reading, modifying, unsetting, and reactively managing layered agent settings with approval and precedence feedback.
- Added paged reading for large files, with metadata that allows clients to recover and continue displaying results.
- Added per-agent compaction thresholds for task and evaluation subagents, configurable as percentages or fixed token limits without changing the main session threshold.
- Added trusted additional context for extension and hook tool results, including `ctx.addAdditionalContext()`, allowing instructions to reach the model without altering displayed tool results.
- Added dictation support to `/btw` follow-up input.
- Added support for multiple simultaneous browser instances, including concurrent Chrome and Edge connections.
- Added detailed benchmark phases for measuring single-user throughput, parallel scaling, and prefill performance, with automatic prefill sizing based on model context limits.
- Added opt-in CUDA support to the Nix package for tiny-model inference through ONNX Runtime.
- Added reliable RPC prompt lifecycle reporting with `prompt_result`, structured provider errors, session-settled state, prompt identifiers, event filtering, and `--no-ui` support for non-interactive hosts.
- Added RPC session management through `open_session`, plus corresponding TypeScript and Python client APIs including `openSession`, `setEventFilter`, `onPromptResult`, `onSessionSettled`, and `waitForSettled`.
- Added `attachment://` and `conflict://` resource URL handlers.
- Added a per-server MCP `instructions: false` option to keep a server's guidance out of the system prompt while retaining its tools.

### Changed

- Improved recovery from output-length and context-window limits so truncated but actionable turns can be retained and retries are handled more accurately.
- Shortened the default system prompt by approximately 150 tokens while preserving its guidance.
- Improved Anthropic fallback handling so credit tokens and signed thinking context are preserved across same-provider fallbacks.
- Improved filesystem safety and path consistency across virtual URL protocols, including symlink and containment validation and correct Windows long-path reporting.
- Improved IDA database resource management with project sharing, bounded concurrency, idle cleanup, autosave, and clearer database status in listings.
- Improved runtime configuration behavior with type-safe layered settings, live updates, and safe sequential saves.
- Improved authentication and credential management to support live broker and credential-store changes.

### Fixed

- Fixed concurrent project access by enforcing file locking across processes.
- Fixed Windows file reads with line selectors such as `:1-40`.
- Fixed `omp update` and startup update checks to honor configured npm registries, including scoped registries and authentication tokens.
- Fixed invalid auto-QA grievance reports blocking the rest of the upload queue; rejected reports are now surfaced with the server error while other reports continue.
- Fixed advisor reviews making unnecessary follow-up requests, losing context after pruning, using the wrong thinking effort, or sending excessively large edit diffs.
- Fixed `/login` crashes in source-link and development installs after extension loading.
- Fixed retry fallback loops that could continue indefinitely when the fallback resolved to the same effective request.
- Fixed setup wizard detection for Gemini web search when Antigravity OAuth is active.
- Fixed headless print mode failing to complete an advisor review when a configured fallback reviewer was available.
- Fixed embedded shell startup when the inherited working directory had been deleted.
- Fixed Codex usage displays showing stale subscription plans and corrected usage views that combined separate quota limits.
- Fixed explicit model and provider selections bypassing `disabledProviders`; disabled providers are now refused and skipped during fallback.
- Fixed memory storage errors so failed items and underlying storage failures are identified.
- Fixed malformed user-level `mcp.json` files preventing valid MCP sources from loading.
- Fixed Anthropic server-side fallback requests using invalid model names.
- Fixed large-output model requests failing near the context limit by adjusting the output allowance to the remaining context.
- Fixed tool references in system prompts for tools exposed only through `xd://` devices.
- Fixed dictation remaining active after a recording restart during transcription.
- Fixed automatic account sign-outs going unannounced; sessions now report the affected account and login action through interactive, print, JSON, and RPC output.
- Fixed duplicate MCP tool listings in the system prompt.
- Fixed supervised service exits being missed or repeatedly replayed instead of being delivered to the session that started the service.
- Fixed memory backend failures to identify the affected item and underlying storage error.
- Fixed `write xd://<tool>` validation behavior so devices can return precise schema-mismatch responses.

## [18.3.0] - 2026-09-24

### Breaking Changes

- The `hub` tool is deprecated; use `wait`, `write`, and the `proc://` protocols instead.
- The `irc.timeoutMs` configuration setting has been removed.
- The edit mode syntax now uses `*** Edit File:`, `*** Find`, and `*** Replace` headers instead of `SM:` headers.
- Cancelling a process through `write` now requires an explicit `proc://<id>/kill` target; other write targets validate content normally.

### Added

- Added `omp://` documentation scopes for `find` and `omp find`. Search all embedded harness documentation with `omp://` or a specific document with `omp://<file>.md`; results are returned as canonical URLs that `read` can open, including range selectors.
- Added extension support for ephemeral, `/btw`-style side turns through `ctx.runEphemeralTurn()`, with optional tool suppression and output/context limits without adding the turn to session history.
- Added background job and service management through the `wait` tool and `proc://` URLs, including supervised services in `bash` and direct agent messaging through `agent://` write targets.
- Added `*** Insert Before` and `*** Insert After` edit operations for adding lines without replacing existing code.
- Added the `toks` command for offline token counting, including support for Jev (TypeSafe Jev 1.13) encodings.
- Added automatic discovery of Apple Foundation Models on supported Apple silicon devices.
- Added `/changelog last [N]` for viewing the latest release or a selected number of recent releases.
- Added terminal-based OAuth authentication with `omp login`, including browser-assisted login, account and organization details, and automatic model discovery refresh. Added provider support for `org-scoped-identity`, `oauth-token-env`, and per-account OAuth priority/reserve policies through `auth.accountPolicies`, with policy state shown by `omp usage`.
- Added the `daybreak` badge to `omp usage` for enabled accounts.
- Added `/export` and `/usage` to focused subagent views for exporting a focused transcript and viewing account usage without returning to the main session.
- Pasted clipboard images are now saved in the session artifact directory, allowing agents to read, copy, or upload them by file path.
- Added `/annotate` for attaching notes to diffs, replies, session messages, files, or quoted text and inserting or sending those notes in prompts and reviews.
- Added configurable MCP startup behavior through `MCP_STARTUP_TIMEOUT_MS`/`mcp.startupTimeoutMs` and `OMP_MCP_REQUIRE_READY=1`, allowing headless runs to require MCP servers to become ready before the first turn.
- Added native judgment usage reporting, including error stop reasons and messages, and added `openrouter/~typesafe/jev-latest` as a native judge candidate.

### Changed

- Session compaction now supports native Anthropic snapshot branches and rewinds.
- The default `bash.autoBackground.strategy` is now `catalog`.
- The `Launch` configuration group has been renamed to `Services`.
- Terminal OAuth behavior is now consistent between `omp login` and `omp auth-broker login`.
- Judgment fallback now uses only native candidates, preventing prompted models from replacing failed native judges.
- Browser screenshot comparisons now tolerate minor rasterizer differences.

### Fixed

- Fixed credential-aware API key resolution during authentication rotation.
- Fixed comma-separated line selectors in `read`, `grep` paths, and `fetch`; selectors now read the requested range, while a bare number selects only that line.
- Fixed `write` reporting JavaScript character counts instead of UTF-8 byte counts.
- Fixed background job and service status reporting, including incorrect durations, reused job IDs, stale logs after named-service restarts, and foreground calls incorrectly appearing as background jobs.
- Fixed `wait` and agent messaging so completed subagent results and peer messages are delivered reliably, including when a wait is interrupted by an incoming message.
- Fixed headless print mode dropping or silently ignoring MCP servers that start slowly; it now waits within the configured timeout and warns when a server is not ready.
- Fixed reader-mode `fetch` sending inline SVG icons and base64 images as unreadable model input; alt text is retained instead.
- Fixed long non-Latin judged TTSR output exceeding token limits by applying token-aware truncation.

## [18.2.11] - 2026-09-23

### Fixed

- Fixed nested `eval` Todo updates not being reflected by the Todo tracker, including cases where a cell fails after committing an update.
- Fixed strict-mode structured-output validation for JSON Schemas without a root `type`, preserving their `items` and `required` keywords.
- Improved streamed TTSR whole-buffer matching to avoid repeated scans from the beginning of the buffer.
- Fixed plural browser queries when compiled binaries provide shallow stack traces.
- Fixed browser `tab.fill` timing out on pages whose animation frames stall.
- Fixed the first LSP diagnostics request returning no results while a newly started language server is still analyzing.
- `/shake thinking` now reports the number of tokens freed.

## [18.2.10] - 2026-09-22

### Added

- Added live benchmark results table with real-time model ranking and per-kind performance metrics
- Added dedicated prefill throughput reporting for prefill-focused benchmarks
- Added `/record` slash command to capture terminal sessions as replayable `.ompcast` files
- Added `omp play` CLI for terminal-based playback of session recordings
- Added intent descriptions to judgment batching
- Added live progress tracking for judgment batches in the TUI

### Changed

- Refined AI-assisted git staging verification to reduce false positives
- Updated `omp bench` default profile to `chat` and improved CLI flag documentation
- Coalesced judgment batch drain operations for better performance under high load

## [18.2.9] - 2026-09-22

### Added

- Added Claude saved resets to usage views and `/usage reset`, with automatic blocked-limit recovery and expiring-reset redemption controlled by `claudeResets`.
- Added support for searching embedded harness documentation with `find` and `omp find` using `omp://` scopes, including file-specific searches and `:start-end` selectors; results open directly through canonical `omp://` URLs.

### Changed

- Updated server-side fallback documentation and logic to target claude-opus-5-5
- Added support for claude-opus-5-5 to model priority registry
- Updated the read tool guidance to decode images inline by default and require an explicit `:img` selector for SVG rendering.
- Improved model discovery and fallback behavior: authentication failures are surfaced in the `/models` hub, and models without a matching role-specific fallback now use the default fallback chain.
- Improved resilience for subagents by retrying provider stream failures that occur after partial output and preserving configured ordered model fallbacks at startup.
- MCP OAuth with Google issuers now requests offline access so refresh tokens can be issued; repeated auth-broker token rotations also preserve the required refresh and client metadata.
- MCP servers from omp-plugins now expand `${CLAUDE_PLUGIN_ROOT}` and `${OMP_PLUGIN_ROOT}` in commands, arguments, and working directories.
- `/review` now uses the session's current working directory after `/move` or `/wt`.
- Pasted and dragged image files now retain their original filesystem paths so the agent can act on the source files directly.
- Custom sessions can now be moved across filesystems without losing transcripts or artifacts.
- `hub jobs` now returns a compact, non-consuming status summary instead of replaying completed output or consuming pending auto-delivery.
- The display-reset shortcut now works while the ask dialog has keyboard focus, and `tab.press()` provides a clear error for the legacy argument order.
- Wayland keyboard input now follows the compositor's active XKB layout instead of assuming a US layout.
- LSP diagnostics now refresh when watched files are created or deleted and after a server reload.
- Compiled bytecode binaries now start correctly when bundled dependencies use `import.meta.resolve`.

### Fixed

- Fixed JavaScript `eval` assignments in cells containing top-level `await` so they persist into subsequent cells.
- Fixed skill hints becoming out of sync with the active prompt after discarded rebuilds and in advisor sessions.
- Restored `pi.pi.askToolRenderer` for extensions that replace the built-in ask tool, preserving native rendering.
- Fixed npm plugin upgrades and reinstalls leaving stale or duplicate manifest entries that could break `bun install`.
- Fixed `eval` waits longer than approximately 24.8 days returning immediately because of native timer overflow.
- Fixed deleted sessions being resurrected from stale rewrite backups.
- Fixed `/collab` relay connections honoring `HTTPS_PROXY` and `NO_PROXY`.
- Fixed sessions remaining blocked by queued turns or Hindsight auto-recall after disposal or cancellation.
- Fixed edits to auto-generated files aborting the entire turn; they now return a tool-scoped error.
- Fixed Edit handling of invalid overlapping selections in multibyte text so the worker reports a match error instead of panicking.
- Fixed local memory consolidation on case-insensitive filesystems when project path casing changes between launches.
- Fixed first-time Xcode MCP connections on macOS by allowing the signed `omp` binary to request Apple Events permission.
- Fixed stale or duplicated TTSR trigger events during streaming.
- Fixed MCP OAuth credentials retaining their refresh endpoint and client metadata across repeated token rotations.
- Fixed local model and provider retry behavior for streamed and partially buffered failures.
- Fixed memory and session cleanup issues that could leave stale artifacts or inconsistent state.
- `lsp.formatOnWrite` now prefers a dedicated `isLinter` formatter server when a type-checker also claims the file ([#12847](https://github.com/can1357/oh-my-pi/pull/12847) by [@roboomp](https://github.com/roboomp)).
- `/extensions` no longer shows OMP-installed marketplace capabilities as disabled behind the foreign-plugin opt-in gate ([#12849](https://github.com/can1357/oh-my-pi/pull/12849) by [@roboomp](https://github.com/roboomp)).

### Removed

- Removed support for image query parameters (`?q=`) and bare image paths in the read tool.
- Custom models now honor provider-level `transport: pi-native` and send requests to the native gateway ([#12845](https://github.com/can1357/oh-my-pi/pull/12845) by [@joshrzemien](https://github.com/joshrzemien)).
- Fixed live models that match no `retry.fallbackChains` role primary (e.g. Fable after `/model`) resolving no chain, so a wait longer than `retry.maxDelayMs` aborted the session instead of walking `default` ([#12421](https://github.com/can1357/oh-my-pi/issues/12421)).
- Fixed skill hints drifting from the active prompt after discarded rebuilds or in advisor sessions ([#12148](https://github.com/can1357/oh-my-pi/pull/12148) by [@jerome-benoit](https://github.com/jerome-benoit)).
- Restored `askToolRenderer` on the extension namespace (`pi.pi.askToolRenderer`) after the pi-tui renderer migration dropped it, so extensions that shadow the built-in ask tool can keep the native rendering again. ([#12694](https://github.com/can1357/oh-my-pi/pull/12694) by [@xiechimon](https://github.com/xiechimon))
- Model discovery rejected with 401/403 now surfaces an authentication error in the /models hub instead of a silently empty model list. ([#12436](https://github.com/can1357/oh-my-pi/pull/12436) by [@xiechimon](https://github.com/xiechimon))
- Pasted or dragged image files now reach the agent with their original filesystem path, so it can read and act on the source file directly; clipboard screenshots keep working unchanged. ([#12404](https://github.com/can1357/oh-my-pi/pull/12404) by [@xiechimon](https://github.com/xiechimon))
- `/review` now runs VCS operations against the live session cwd after `/move` or `/wt` instead of the session-start checkout ([#12712](https://github.com/can1357/oh-my-pi/pull/12712) by [@F0Rextasy](https://github.com/F0Rextasy)).
- Reinstalling or upgrading an npm plugin no longer leaves stale or duplicate manifest edges that broke `bun install` ([#12727](https://github.com/can1357/oh-my-pi/pull/12727) by [@F0Rextasy](https://github.com/F0Rextasy)).
- TTSR now emits one `ttsr_triggered` event per streamed violation instead of one per evaluation pass ([#12729](https://github.com/can1357/oh-my-pi/pull/12729) by [@F0Rextasy](https://github.com/F0Rextasy)).
- Eval `wait()` timeouts above ~24.8 days no longer overflow the native timer and return immediately ([#12731](https://github.com/can1357/oh-my-pi/pull/12731) by [@F0Rextasy](https://github.com/F0Rextasy)).
- MCP OAuth against Google issuers now requests `access_type=offline` so refresh tokens are issued ([#12737](https://github.com/can1357/oh-my-pi/pull/12737) by [@F0Rextasy](https://github.com/F0Rextasy)).
- Deleting a session now also removes its stale `.bak` rewrite backups so the picker cannot resurrect it ([#12746](https://github.com/can1357/oh-my-pi/pull/12746) by [@F0Rextasy](https://github.com/F0Rextasy)).
- `/collab` relay WebSockets now honor `HTTPS_PROXY`/`NO_PROXY` like other transports ([#12762](https://github.com/can1357/oh-my-pi/pull/12762) by [@jacobcolyvan](https://github.com/jacobcolyvan)).
- `tab.press()` now rejects the inverted `press(selector, key)` call with a hint naming the corrected `(key, { selector })` form, instead of the key parser's opaque `Unknown key: <selector>` ([#12136](https://github.com/can1357/oh-my-pi/issues/12136)) ([#12266](https://github.com/can1357/oh-my-pi/pull/12266) by [@danilouchoa](https://github.com/danilouchoa)).
- The display-reset shortcut (`app.display.reset`, `alt+l` by default) now fires while the ask dialog holds keyboard focus, instead of being dropped silently; the #11215 global-listener promotion covered the other four editor display actions but missed this one ([#12217](https://github.com/can1357/oh-my-pi/issues/12217)) ([#12262](https://github.com/can1357/oh-my-pi/pull/12262) by [@danilouchoa](https://github.com/danilouchoa)).
- Custom sessions can move across filesystems without losing their transcript or artifacts ([#12360](https://github.com/can1357/oh-my-pi/issues/12360), [#12378](https://github.com/can1357/oh-my-pi/pull/12378) by [@Dante-dan](https://github.com/Dante-dan)).
- Fixed `hub jobs` replaying full output for every settled job and consuming pending auto-delivery; it now returns a compact non-consuming status summary ([#12547](https://github.com/can1357/oh-my-pi/pull/12547) by [@pedropaulovc](https://github.com/pedropaulovc)).
- Compiled bytecode binaries now start correctly when bundled dependencies use `import.meta.resolve` ([#12133](https://github.com/can1357/oh-my-pi/pull/12133) by [@andrebrait](https://github.com/andrebrait)).
- Subagents now retry provider stream errors that arrive after buffered partial output, and such failures are reported as transport errors instead of schema-invalid results ([#12752](https://github.com/can1357/oh-my-pi/pull/12752) by [@bse-ai](https://github.com/bse-ai)).
- Edits targeting auto-generated files now return a tool-scoped rejection instead of aborting the whole turn ([#12499](https://github.com/can1357/oh-my-pi/pull/12499) by [@Dante-dan](https://github.com/Dante-dan)).
- Subagents with an ordered model fallback keep it reachable on startup when the parent default role shares the same primary model ([#12377](https://github.com/can1357/oh-my-pi/pull/12377) by [@Dante-dan](https://github.com/Dante-dan)).
- omp-plugins MCP servers now substitute `${CLAUDE_PLUGIN_ROOT}`/`${OMP_PLUGIN_ROOT}` in `command`, `args`, and `cwd` ([#12801](https://github.com/can1357/oh-my-pi/pull/12801) by [@holny](https://github.com/holny)).

## [18.2.8] - 2026-09-21

### Added

- Added comprehensive browser automation tools for accessibility auditing, React inspection, console and network monitoring, performance tracing, semantic DOM queries, tab management, screen recording with cursor overlays, downloads, custom initialization scripts, persistent storage, and WebMCP cross-frame tool discovery.
- Added support for buffered cloud transcription with OpenAI-compatible models.
- Added visual change detection for video processing, including FFMPEG analysis and SVG overlays.
- Added support for declaring native judges through custom providers using the `typesafe` and `openrouter-decisions` API values, with configurable base URLs, API keys, and headers.

### Changed

- Expanded browser security and resilience controls with configurable HTTPS error handling, domain allow-listing, and automatic tab recycling when security-sensitive state changes.
- Updated background job notifications to deliver output as follow-up messages and discourage unnecessary polling.
- Expanded the bash tool's documented auxiliary utilities and removed its truncation footer notice.

### Fixed

- Improved responsiveness in long sessions by significantly reducing the time required to scan provider context for credential patterns.
- Fixed native judges failing to honor configured request headers, enabling authenticated and header-routed judge providers to work as configured.
- Fixed LSP requests hanging when aborted while waiting for an earlier write to complete.

## [18.2.7] - 2026-09-21

### Breaking Changes

- Image-generation overrides now use model selectors, and web-search CLI overrides use --model instead of --provider.
- Removed the bash tool's env parameter.
- Eval judge(state, questions) is now awaited and returns answers directly; JudgmentHandle and judgment support in wait() have been removed.

### Added

- Added `find` tool for semantic workspace searching, allowing agents to locate behaviors and symbols using natural language
- Added `find` CLI command for performing semantic workspace searches
- Added batch evaluation with judge_batch(states, questions) / judgeBatch(...), including bounded background execution, incremental result and status access, per-item failure reporting, and the ability to wait for or reattach to jobs across turns or after a reset.
- Added the jevify magic keyword to have the agent establish an evaluation rubric before classifying bulk items and inspect only items flagged by the judge.
- Added omp web-search as an alias for omp search.
- Added tui.titleSpinner configuration to select the terminal-title working-state spinner (braille, dots, or line).
- Added Handlebars-based system prompt templates through SYSTEM_TEMPLATE.md, --system-prompt-template, and the SDK, with access to live settings and tool data.
- Added configurable image, web, speech, dictation, judge, and memory model roles with ordered fallbacks, legacy backend-setting migration, and omp models --kind filtering.
- Added native OpenRouter image generation, model-selected web-plugin search, and live discovery of TypeSafe judge models.

### Changed

- Updated agent system prompts to prioritize the `find` tool over `grep` and `glob` for behavioral lookups
- Refined system prompt instructions for XML tag handling and agent persona
- Updated sloppy edit tool syntax to use plain text headers instead of XML tags
- Improved startup performance by validating provider-qualified model selectors against only the relevant provider catalog.
- Reduced launch time for npm and compiled builds by embedding the model catalog more efficiently.

### Fixed

- Fixed system prompt configuration validation so systemPromptTemplate and customSystemPrompt cannot conflict with a full systemPrompt replacement, including when values are empty.
- Added browser-relay support for listing eligible pages without attaching to or claiming them.
- Fixed Codex compatibility with the sloppy edit tool.
- Capped concurrent eval judge and completion requests to prevent large fan-outs from overwhelming judge and fallback models.
- Temporarily avoids retrying judgment requests with credentials that recently failed due to authorization or billing errors.
- Fixed image and speech fallback models disappearing after discovery and eliminated incorrect incompatibility warnings for providers without credentials.
- Fixed resume and continue flows to hide empty sessions.
- Fixed edit operations that could loop after empty insertions or fail on Unicode no-op and overlapping duplicate matches.
- Fixed live subagent messages being delayed by agent discovery and roster discovery looping on dot-named transcripts.
- Fixed llama.cpp discovery and routing for PrismML Bonsai 2 27B GGUF models, including support for cached models and the Qwen 3.8 thinking-level ladder.

## [18.2.6] - 2026-09-18

### Fixed

- Fixed clipboard paste stalling on an empty clipboard; image and text clipboard reads now run concurrently so the empty-clipboard status surfaces after the slower read instead of the sum of both.
- Fixed memory recall blocks carrying a minute-resolution `Current time` stamp that dirtied the cached system prompt on every refresh; recall rows already carry dates, so the stamp is removed.
- Fixed `omp auth-broker token` and `omp auth-gateway token` exiting silently without creating a token on Windows when no token file exists yet; token and config reads now use `node:fs` instead of `Bun.file`.

## [18.2.5] - 2026-09-17

### Breaking Changes

- Moved terminal UI modules—including themes, tool renderers, chat, overlay, status-line, composer, setup wizard, and Git/PS/debug apps—to `@oh-my-pi/pi-tui`. The corresponding `@oh-my-pi/pi-coding-agent` subpaths no longer exist; names re-exported from the package root remain unchanged.

### Added

- Added `omp stream` for livestreaming terminal sessions at `live.omp.sh/<your Stencil username>`, with viewer chat, pane-per-session display for sessions in the same directory, screen redaction, and configurable `stream.serverUrl` and `stream.redactPatterns` settings. Use `--server` to override the stream server, `--title` to set a title, and `--no-tui` to retain the line-based log interface.
- Added Stencil account support to `/login`. `omp stream` uses a signed-in Stencil account or `STENCIL_API_KEY` for channel ownership and authentication. Sensitive environment, dotenv, `secrets.yml`, credential-shaped, and configured pattern-matching values are redacted before screen data is transmitted.
- Added faster keyless web search fallback by prioritizing the default keyless Parallel provider ahead of Perplexity.

### Changed

- Improved parent IRC message prompts to make interruption handling more reliable.
- Improved subagent task labels and plan filenames to use concise, action-oriented descriptions.
- Updated CLI byte sizes to use decimal KB units and made duration displays coarser and easier to read.

### Fixed

- Fixed `edit` auto-repair waiting up to 60 seconds when the `smol` model does not respond; it now times out after 20 seconds and reports repair start and timeout details.
- Fixed subagents leaving queued parent messages behind after tool interruptions.
- Fixed a subagent burning its whole run on `yield` calls that never finish it: an incremental-only `yield` turn no longer bypasses the request budget, and the forced final `yield` ends the run ([#12351](https://github.com/can1357/oh-my-pi/pull/12351) by [@pedropaulovc](https://github.com/pedropaulovc)).
- Fixed `browser.open({ app: { relay: true } })` waiting for the full tool timeout when no relay extension is installed or reachable; it now fails promptly with an actionable error while preserving the wait for a connected extension to recover.
- Fixed `edit` handling of ellipsis markers, inline closing tags, copy-ready corrections, and retries, including cases that could insert literal markers, misreport matches, omit the file target, or panic.
- Enabled `edit.enforceSeenLines` by default to reject hashline edits anchored to content that was not displayed, and prevented stale-tag recovery from applying edits to a structurally different duplicate construct ([#12369](https://github.com/can1357/oh-my-pi/pull/12369) by [@pedropaulovc](https://github.com/pedropaulovc)).
- Fixed startup failures when the plugins directory or its manifest cannot be read; inaccessible plugin roots are now skipped with a warning.
- Fixed generation token-rate displays for subagents and restored the main session's reading after switching focus.
- Fixed subagent HUD labels and plan filenames being populated with example prompt text on smaller models.
- Improved shell, file, session, and persistence operations to avoid unnecessary repeated work, improving responsiveness and resource usage.

## [18.2.4] - 2026-09-17

### Added

- Added an optional live generation speed readout via `composer.tokenRate`, showing smoothed tokens-per-second output in the working row and keeping the rate visible between turns.
- Added TypeSafe provider support through `/login typesafe` or `TYPESAFE_API_KEY`. TypeSafe can power thinking-level detection, unexpected-stop detection, and AI-assisted git staging with calibrated judgment probabilities; configure `providers.judgmentProvider` as `auto`, `typesafe`, or `llm` to select the judgment backend.
- Added the `judge(state, questions)` evaluation helper for Python and JavaScript cell code, supporting typed choice, boolean, and score judgments. It returns a handle whose `.wait()` method provides answers and probabilities, using TypeSafe when configured and available or a fallback chat model otherwise.

### Changed

- Unified thinking-level detection, unexpected-stop detection, and AI-assisted staging around a shared judgment system with automatic fallback across configured models when TypeSafe is unavailable or cannot complete a request. AI-assisted staging now evaluates files as a single batched judgment while preserving one yes/no decision per file.

## [18.2.3] - 2026-09-17

### Breaking Changes

- Config-backed headers now resolve asynchronously through `ModelRegistry.getProviderHeaders()` or `resolveModelHeaders()`; removed the synchronous `config/model-config-values` module.
- Removed the unused `ConfigFile.getMtimeMsAsync()`, `tryLoadAsync()`, `loadAsync()`, and `loadOrDefaultAsync()` methods.
- Custom SQL session clients must support transactions for atomic renames.

### Added

- Type `^` to tag a model for delegation, with atomic display-name chips and session-persisted `m1`, `m2`, … agents available to task and eval.
- Provider login and setup support masked secret prompts; RPC rejects secret prompts rather than requesting ordinary input.

### Changed

- Shell-backed API keys and headers resolve asynchronously without freezing terminal input or running during catalog construction.

### Fixed

- macOS process discovery now retains the complete PID list when locating executables and descendants. ([#12290](https://github.com/can1357/oh-my-pi/pull/12290) by [@iliaal](https://github.com/iliaal))
- Reduced snapshot-recording stalls when a session retains large file histories. ([#12279](https://github.com/can1357/oh-my-pi/pull/12279) by [@iliaal](https://github.com/iliaal))
- Cancelled background jobs remain tracked until execution finishes, so cleanup cannot report completion prematurely after retention expires. ([#12278](https://github.com/can1357/oh-my-pi/pull/12278) by [@iliaal](https://github.com/iliaal))
- Fixed localized edits rewriting unrelated bytes in files with invalid UTF-8; these edits now fail without modifying the file. ([#12277](https://github.com/can1357/oh-my-pi/pull/12277) by [@iliaal](https://github.com/iliaal))
- Fixed sloppy edits crashing with a char-boundary panic instead of reporting a match error when the file contains multibyte (e.g. CJK) text.
- Fixed retry timing reliability in agent sessions by ensuring sleep durations are monotonic
- Fixed data stability issues when processing streamed lines
- Resolved same-path move failures in indexed session storage
- Restricted and revived subagents retain parent-loaded extension hooks without enabling extension-contributed tools.
- Revived subagents honor the owning session's extension-discovery restrictions.
- Secret login answers stay hidden in later prompts and cannot be recovered through undo or yank.
- SQL session renames preserve data on same-path moves, missing sources, and failed overwrites.
- MySQL session writes no longer use deprecated upsert value references.
- MCP SSE requests honor one response deadline and report timeouts correctly without replaying accepted tool calls.
- Legacy extension package-import patterns follow native prefix precedence.
- Bundled extensions observe theme initialization and changes through the existing live `theme` export.
- Configured discovery models retain request-time credentials after offline cache reloads and failed refreshes.
- Runtime API-key overrides retain precedence over configured credentials.
- Element handles returned by `tab.waitForSelector`, `tab.$`, and related selector helpers can now be passed as arguments to `tab.evaluate` inside `tab.run` instead of failing with "JSHandles can be evaluated only in the context they were created".

## [18.2.2] - 2026-09-16

### Added

- Expanded built-in secret obfuscation to detect credentials in connection URLs regardless of environment-variable name, including PostgreSQL, MongoDB, MySQL, Redis, AMQP, and other supported schemes.
- Expanded built-in secret obfuscation to cover AWS access keys, Google API keys, Slack, npm, Stripe secret/restricted keys and webhook secrets, Hugging Face and SendGrid tokens, JWTs, Bearer tokens, and PEM private keys.
- Added the `tui.titleSpinner` setting to choose the terminal-title working-state animation (`braille`, `dots`, `line`, or `pulse`), alongside the existing `tui.titleState` toggle.

### Changed

- Session-stop hooks that block with a reason now keep the session running until they allow it or the user interrupts; explicit aborts are no longer restarted by a stop hook.
- Corrupt agent and prompt-history databases are now backed up before fresh stores are created, allowing startup to continue; credentials may need to be entered again.
- Agent and history database startup errors now identify the affected database file.
- Terminal-title spinner animations now work on native Windows; WSL retains the static separator to avoid unnecessary CPU usage.
- Explicit model refreshes now re-evaluate command-backed API keys and headers, allowing rotated credentials to take effect without restarting.
- Background job entries are removed shortly after their results are consumed or recovered, while unconsumed jobs remain available for inspection.

### Fixed

- Fixed the transcript collapsing into a compact no-spacing layout whenever the prompt, todo HUD, or other below-transcript chrome grew a few rows; the live tail now scrolls off the top instead.
- Fixed transcript layout and rebuilding issues that could collapse blank rows, leave tool calls displayed on one line, or show stale fragments after navigation, display changes, or compaction ([#12177](https://github.com/can1357/oh-my-pi/pull/12177) by [@shivamklr](https://github.com/shivamklr)).
- Fixed the `security-reviewer` agent so valid findings with anchors and remediation details are accepted.
- Stopping a subagent from Agent Hub now settles and reports its parent background job instead of leaving `hub wait` blocked indefinitely.
- Fixed prewalk handoff detection after edits or writes dispatched through Code Mode eval cells.
- Reduced main-thread stalls while streaming large edits by deferring AST-based matching until the edit is complete.
- Corrected the `/handoff` description so it accurately reflects that the command creates a handoff document and compacts the current session.
- Deferred misleading cold-cache `retry.fallbackChains` warnings until provider discovery completes.
- Fixed `--prewalk-into @default` so an explicitly selected startup model does not replace the configured default role, including ordered fallbacks and discovery-backed candidates.
- A corrupted or externally modified session file no longer leaves the session impossible to close; a subsequent Ctrl+C exits without rewriting the session log.
- Fixed silent MCP requests being terminated by an undeclared idle timeout; closing a legacy SSE connection now also cancels pending requests and notifications.
- Fixed browser reuse for Chromium installed behind Linux wrapper scripts and prevented duplicate launches when a profile is locked ([#12236](https://github.com/can1357/oh-my-pi/pull/12236) by [@shivamklr](https://github.com/shivamklr)).

## [18.2.1] - 2026-09-15

### Breaking Changes

- Renamed the `/drop` slash command to `/delete` so that "drop" is no longer overloaded between deleting the session and dropping a goal (`/goal drop`).
- Read tool results no longer duplicate the body in `details.truncation.content`; use result `content` or `details.displayContent` instead. ([#11255](https://github.com/can1357/oh-my-pi/pull/11255) by [@jiwangyihao](https://github.com/jiwangyihao))
- Removed the `DEL`, `DEL.BLK`, `COPY`, and `COPY.BLK` hashline edit operations. Use `CUT` / `CUT.BLK` for deletion; removed content remains available to `PASTE`.
- Changed tab.screenshot() to no longer accept a per-call save path; it now saves screenshots under browser.screenshotDir (or the OS temp directory if unset) and returns the saved path.

### Added

- Added keyless Parallel web search when the provider is explicitly selected ([#9770](https://github.com/can1357/oh-my-pi/pull/9770) by [@georgeatparallel](https://github.com/georgeatparallel)).
- Sloppy edits support `<SM:AFTER>` to insert new lines after an anchor without repeating or replacing it.
- Fixed eligible full OpenAI Responses request-body timeouts by retrying once after conservative local tool-result elision, while preserving assistant/user history, unsafe partial output, and existing stateful retries ([#11878](https://github.com/can1357/oh-my-pi/pull/11878) by [@hellofrommorgan](https://github.com/hellofrommorgan)).
- User append instructions (`APPEND_SYSTEM.md`, `--append-system-prompt`) now render under their own `## User Instructions` heading whenever generated blocks precede them, instead of trailing the `## MCP Server Instructions` section and reading as server-supplied, unverified content ([#11832](https://github.com/can1357/oh-my-pi/pull/11832) by [@iacore](https://github.com/iacore)).
- Prewalk now arms for a hand-off target served by a `models.yml` `discovery:` provider (e.g. `openai-models-list`): `buildSessionOptions` runs a cache-aware refresh for the provider named by the selector and retries, instead of disabling prewalk with a `Model "…" not found` warning for ids `omp models` lists ([#11820](https://github.com/can1357/oh-my-pi/issues/11820)).
- Non-throwing tool failures now retain their error status through extension result rewrites and eval-defined subagent tools ([#11585](https://github.com/can1357/oh-my-pi/issues/11585)).
- Session rewrites now refuse to replace a file changed by another process, preserving durable turns from concurrent terminals ([#11496](https://github.com/can1357/oh-my-pi/issues/11496)).
- Goal mode now idles after repeated continuations return identical tool evidence instead of re-waking indefinitely ([#11819](https://github.com/can1357/oh-my-pi/issues/11819)).
- Cycling models with Ctrl+P no longer injects a spurious tool-roster notice that made the model believe still-callable tools had been removed; a prompt rebuild now discards the queued delta it already reflects ([#11824](https://github.com/can1357/oh-my-pi/issues/11824)).
- Subagent `yield` no longer fails a run with `SYSTEM WARNING: Subagent called yield with null data.` when a data-less `useLastTurn` finalize (e.g. `{type:"result"}`) lands on a thinking-only turn with no text; the tool now rejects it at the boundary so the child is reminded to resubmit with `data` ([#11150](https://github.com/can1357/oh-my-pi/issues/11150)).
- `--continue` no longer treats a merely-missing breadcrumb cwd as a project move. Re-root now requires the continue directory to be the same device+inode the breadcrumb recorded (`git worktree move` / same-filesystem `mv`). A cross-filesystem `mv` (copy+unlink, new inode) is intentionally not re-rooted: the session stays in the original bucket, `header.cwd` is not rewritten, and a warn is logged ([#11565](https://github.com/can1357/oh-my-pi/issues/11565)).
- Cold-revived persisted subagents now anchor wake-turn artifacts to their own transcript directory rather than the live root session's, so nested-depth and post-`/new` revivals no longer write `<id>.md` outside the revived agent's tree ([#11563](https://github.com/can1357/oh-my-pi/issues/11563)).
- Legacy `settings.json` → `config.yml` migration now writes the YAML first and only then archives the JSON, surfaces failures instead of swallowing them, and recovers from an orphaned `settings.json.bak` when `config.yml` is missing ([#11569](https://github.com/can1357/oh-my-pi/issues/11569)).
- Legacy `settings.json` → `config.yml` migration now writes the YAML first and only then archives the JSON, and surfaces failures instead of swallowing them ([#11569](https://github.com/can1357/oh-my-pi/issues/11569)).
- MCP server names may now contain spaces, so human-friendly display labels like `MaaS Slack` survive `/mcp reauth` write-back instead of being rejected by the config writer ([#11731](https://github.com/can1357/oh-my-pi/issues/11731)).
- File paths in the compact grouped `Read (N)` tree are now clickable OSC 8 hyperlinks, matching standalone Read rows; delimited reads carry a resolved link target per row so both live output and rebuilt transcripts link correctly ([#11732](https://github.com/can1357/oh-my-pi/issues/11732)).
- Added server-name autocomplete for `/mcp` commands (`enable`, `disable`, `test`, `remove`, `reconnect`, `reauth`, `unauth`) using configured and runtime-discovered MCP servers.
- Added `CUT` and `PASTE` ops to the hashline edit tool for moving code without retyping it: `CUT N.=M` (and `.BLK` block forms) capture lines into a clipboard register, and `PASTE` operations insert them. The register flows across sections within a patch (cross-file moves) and persists across edit calls per session.
- Added `--from-claude` and `--from-codex` session imports (including compaction state for Codex), also available from `/resume @claude` and `/resume @codex`.
- Added interactive Exa API-key onboarding through `/login exa`, opening the official key dashboard and saving pasted keys for authenticated web search while preserving `EXA_API_KEY` and explicit-selection public MCP fallback behavior ([#1798](https://github.com/can1357/oh-my-pi/issues/1798)).
- Added `ExtensionContext.getAsyncJobSnapshot()` so extensions can read the owning session's async-job state without relying on process-global job-manager identity
- Added opt-in `tui.codexResetFireworks` celebrations for unscheduled Codex weekly usage resets and newly banked saved resets, shown in a theme-aware top-third modal until Escape ([#6858](https://github.com/can1357/oh-my-pi/pull/6858) by [@joshrzemien](https://github.com/joshrzemien)).
- The Cursor exec bridge serves the seven modern Pi tool frames, mapping each to its local equivalent: `pi_read`/`pi_ls` → `read`, `pi_bash` → `bash`, `pi_edit` → `edit`, `pi_write` → `write`, `pi_grep` → `grep`, and `pi_find` → `glob`. The frames are a separate wire family from the legacy args, not aliases, so each mapping is a real translation — `pi_grep`'s `ignore_case` is the inverse of the local tool's case-sensitivity flag, `pi_find` searches filenames rather than contents, and `pi_edit`'s replacements are renamed to the local snake_case pairs.
- `providers.autoThinkingMaxEffort` (`xhigh` | `max`, default `xhigh`) raises the ceiling of the `auto` thinking classifier. `max` became a first-class effort tier after the classifier prompt was written, so `auto` could never reach it on models that expose the tier — only the `ultrathink` keyword could. Opting in adds `max` to the classifier's vocabulary, gated on the target model actually supporting it; the default keeps today's prompt byte-for-byte. The ceiling is enforced inside the effort clamp rather than on the classifier's answer, so a sparse ladder cannot snap an excluded request back up, and the Low floor is still resolved against the model's own ladder. The on-device 3-bucket classifier stays capped at `xhigh` regardless of the setting. The ceiling governs what `auto` resolves: a ladder with nothing underneath it yields no auto level, and a `thinking.requiresEffort` model still gets its lowest supported effort from the transport.
- Added omp cleanse, a new command that automatically detects language-ecosystem checkers, parses diagnostics (such as Cargo Clippy JSON), distributes repair workloads across concurrent subagents, and runs verification checks with a live progress bar.
- Added the bundled `ts-no-local-is-record` TTSR rule, which catches local `isRecord` function and lambda definitions and directs agents to shared guards plus explicit shape validation.
- A `tool_call` handler (extension or hook) can now return `input` to revise the arguments a tool executes with, not just `block` it. The returned object is the raw execution input passed to the tool (ignored when `block` is set, and not applied to `computer` tool calls), enabling wrappers that normalize or rewrite a built-in's arguments without reimplementing the tool. For model-issued calls the event fires at arg-prep time in the agent loop, so a revision is revalidated against the tool schema and is what concurrency scheduling, `tool_execution_start`/transcripts, the persisted assistant message, and the approval gate all observe — the user approves exactly what runs, and a revision that changes a tool's functional concurrency (e.g. bash `pty`) schedules correctly. A revised nested `write xd://` device dispatch forfeits the outer write gate's approval and faces the full prompt again ([#6681](https://github.com/can1357/oh-my-pi/pull/6681) by [@psyrendust](https://github.com/psyrendust)).
- Added a parser for macOS `sample`(1) call-tree reports to the read tool: `*.sample.txt` reads now return a compact bottleneck summary — per-thread hot paths with on-CPU sample counts (blocked syscall time excluded), demangled Rust v0/legacy symbols, flattened direct recursion, merged call-site siblings, idle-thread classification, and a process-wide top-functions-by-self-samples table. `:raw` still reads the original report, and files that merely carry the extension fall back to plain text.
- Added V8 `.cpuprofile` support to the read tool (Node/Bun `--cpu-prof`, Chrome DevTools, CDP `Profiler.stop` output): reads now return a compact bottleneck summary — hot-path call tree with on-CPU milliseconds (`(idle)` time excluded), collapsed pass-through chains, flattened direct recursion, shortened file URLs, and a top-functions-by-self-time table. `:raw` still reads the original JSON, and files that merely carry the extension fall back to plain text.
- Added separate Advisor cost visibility to the status line, rendering primary and Advisor spend as `$2.67 (sub) + $0.41 (adv)` while keeping already-incurred Advisor cost across runtime disablement and same-session history rewrites.
- Added a configurable per-request timeout for the `inspect_image` tool (`inspect_image.timeoutMs`, default 5 minutes; set to 0 to disable) so a stalled vision-model provider fails fast with a clear error instead of blocking until manual abort ([#4165](https://github.com/can1357/oh-my-pi/issues/4165)).

### Changed

- Eval status rows for `browser`/`computer` calls now say what happened (`open main https://…`, `main.id(5).click()`, `close all`) with a globe/computer icon instead of a bare `browser` label; preludes with nothing to show record no row, while failures still surface.
- Codex Spark, all MiniMax models, and GLM-5.3-Flash now default to replace edits instead of hashline; explicit edit-mode overrides remain honored.
- Storage maintenance streams large session journals and gzip archives instead of loading complete files into memory.
- Long sessions spend less time checking retired transcript blocks on each frame.
- An extension-originated message that starts no agent turn (e.g. an idle steer superseded by a concurrent turn) no longer crashes a headless `--mode rpc` session with an unhandled rejection ([#11654](https://github.com/can1357/oh-my-pi/pull/11654) by [@sjawhar](https://github.com/sjawhar)).
- Fixed reconnecting to a collab session while a tool was still running sometimes leaving its spinner animation active for the rest of the process ([#9377](https://github.com/can1357/oh-my-pi/pull/9377) by [@sjawhar](https://github.com/sjawhar)).
- Reduced startup memory and latency when initializing memory with large session histories by reading only session header metadata instead of loading entire transcripts into memory.
- A revived subagent whose wake turn fails, is cancelled, or produces no output now relays a distinct notice (with the attributed `[provider/model]` error and a `history://<id>` pointer) to whoever woke it, so a `hub send await:true` waiter learns why there is no answer instead of a generic "stopped without replying" ([#11290](https://github.com/can1357/oh-my-pi/issues/11290)).
- Orchestrators now verify with project-appropriate checks instead of Bun-specific commands, so non-Bun projects are no longer told to run a checker they do not have ([#10985](https://github.com/can1357/oh-my-pi/issues/10985)).
- Fixed long streamed replies being clipped to the live viewport until the turn ended; finished lines now retire into terminal scrollback while the response is still streaming. Models whose wire can revise text it has already streamed (`stream-revision`) keep the old behaviour ([#11276](https://github.com/can1357/oh-my-pi/issues/11276)).
- Prevent undeclared process-executing `hub` tool injection into read-only subagents ([#11044](https://github.com/can1357/oh-my-pi/pull/11044), closes [#10257](https://github.com/can1357/oh-my-pi/issues/10257)).
- Reduced resume memory use by resolving persisted snapcompact frames only when they are included in the rebuilt context ([#10227](https://github.com/can1357/oh-my-pi/pull/10227) by [@lemonleks](https://github.com/lemonleks)).
- Improved grouped read-call layout by nesting each request's usage metrics beneath its final path.
- Improved turn recovery to prevent duplicate output streaming during credential rotation or model fallback when visible text has already been streamed.
- Optimized tool guidance for bash, grep, and glob to be more concise while clarifying shell boundaries and search timeouts.
- Optimized models configuration resource probing to run in a single child process, reducing startup contention.
- Startup release notes now default to a compact change-count summary. Use `startup.changelogMode` (`summary` | `expanded` | `hidden`) to control them; legacy `collapseChangelog` choices migrate automatically ([#6771](https://github.com/can1357/oh-my-pi/issues/6771)).
- Reworked the /guided-goal command from a modal-based popup flow into a natural, conversational chat interface where the agent asks follow-up questions directly in the session.
- Reduced startup memory usage by lazy-loading HTML session export assets only on their first use.
- Direct and `xd://` dispatch now share one canonical tool map: `write xd://<tool>` executes any enabled top-level or mounted tool, and `read xd://<tool>` returns its docs, instead of failing when the name was exposed through the other layer. Mounted names are presentation metadata only, so tool replacement and disconnection cannot leave stale device instances; disabled tools remain unreachable, and both `xd://` and Cursor/top-level fallback execution retain the tool's approval and ACP permission gates.
- Session listing now caches parsed headers keyed on file stat identity (mtime + size), so repeated resume-picker opens and startup scans re-read only changed session files
- Reduced per-keystroke editor dispatch overhead: keybinding resolution happens once per input chunk and the per-action interception chain is gated behind a single canonical-key set probe
- `xd://` device docs now render the parameter schema as a comment-annotated TypeScript type (via `jsonSchemaToTypeScript`, the same renderer the in-band tool inventory uses) instead of a raw JSON Schema dump, shrinking system-prompt device sections while keeping descriptions inline.
- Added a `/vision [on|off|auto|status]` slash command for session-scoped control of the `inspect_image` vision-delegation tool, modeled on `/computer`: `on`/`off` force the tool for the current session only, `auto` returns to the persisted setting, and `status` reports the effective mode, session override, tool state, and active-model image capability.
- Replaced the `inspect_image.enabled` boolean with the tri-state `inspect_image.mode` (`auto`|`on`|`off`, default `auto`). In `auto` the tool is registered only when the active model lacks native image input, so vision-capable models (e.g. `kimi-code/k3`) read images inline with their own capabilities instead of delegating to a separate vision model; the tool set is re-evaluated on every model switch with a status notice when it flips. The `read` tool now follows the effective state dynamically rather than the raw setting, so it returns decoded image blocks again whenever `inspect_image` is hidden. Existing `inspect_image.enabled: true/false` configs migrate to `inspect_image.mode: on/off`.
- Made the task tool's per-spawn `effort` parameter opt-in through `task.enableEffort`, which defaults to false and omits the field from flat and batch schemas and tool guidance until enabled.
- Reduced terminal-title update overhead by deduplicating unchanged titles on every platform and using `SetConsoleTitleW` through `bun:ffi` instead of OSC writes on Windows. Windows working titles now keep a static `:` separator instead of scheduling spinner updates; other platforms retain the animated separator.
- Added `task.maxEffort` to cap the task tool's optional per-spawn effort hint after model-specific resolution, so operators can enable effort hints without allowing them to exceed a configured ceiling; the ceiling now also rides into the spawned session so retry-fallback model swaps re-clamp to it instead of escalating past the cap ([#6580](https://github.com/can1357/oh-my-pi/issues/6580), [#6794](https://github.com/can1357/oh-my-pi/pull/6794) by [@wolfiesch](https://github.com/wolfiesch)).
- Restructured the steering/interjection envelope sent to the model: the injected `<user_interjection>...<message>...</message>...` wrapper around user text is now a `<system-notice>` explaining the interjection followed by the user's raw message unwrapped, matching the existing `<system-notice>`/`<system-directive>` convention instead of nesting the literal message inside its own tag pair, which some models found confusing.
- Reduced default startup resident memory by constructing the default-off ComputerTool ArkType schema only on first parameter access, then reusing it across tool instances without changing validation or tool behavior ([#6742](https://github.com/can1357/oh-my-pi/pull/6742) by [@usr-bin-roygbiv](https://github.com/usr-bin-roygbiv)).
- Reduced startup CPU and memory by loading the bundled changelog only when needed, while preserving source, npm bundle, standalone binary, and native absolute-path fallback resolution.
- Moved PTY log replay into the shared project launch broker, so normal CLI and Hub startup no longer load the xterm runtime while launch logs return validated rendered terminal rows.

### Fixed

- Late non-blocking advisor notes arriving while a terminal primary turn unwinds now stay visible as advisor cards instead of starting an extra primary request ([#12154](https://github.com/can1357/oh-my-pi/pull/12154) by [@korri123](https://github.com/korri123)).
- Fixed Perplexity sign-in for SSO-only accounts in `/login` and the setup wizard with isolated browser sign-in and automatic session capture, supporting both secure-prefixed and unprefixed session cookies without manual cookie copying. ([#12064](https://github.com/can1357/oh-my-pi/pull/12064) by [@lance0](https://github.com/lance0))
- Mid-run compaction no longer sends the pre-compaction history to the next provider call when the live message array is rewritten in place.
- Collab guests now receive the host's goodbye even when the relay closes the room right behind it, and a fully sent snapshot no longer holds later frames behind transport backpressure.
- Fixed standalone `omp read skill://<name>` failing with `Unknown skill` by discovering configured skills before resolving the URI ([#10961](https://github.com/can1357/oh-my-pi/issues/10961)).
- Subagents no longer remain `running` after their final result is accepted; a finished run reaches a terminal state without the parent having to send a status message ([#11079](https://github.com/can1357/oh-my-pi/issues/11079)).
- Fixed `/loop` never resubmitting after a `/skill:<name>` prompt: the loop prompt is now captured for skill invocations, and resubmitted skill prompts are dispatched the same way the composer sends them instead of as literal text.
- `/force:<tool>` now reports that the current model cannot force a tool on hosts that only accept automatic tool selection (Meta Model API, Muse Code), instead of announcing a forced turn that the request silently drops ([#11635](https://github.com/can1357/oh-my-pi/pull/11635) by [@quantmind-br](https://github.com/quantmind-br)).
- Fixed isolated subagent spawns exhausting host memory when the checkout's staged or unstaged diff is huge (for example a jj conflict commit exported to git); the spawn now fails with the isolation-budget error instead ([#11454](https://github.com/can1357/oh-my-pi/pull/11454) by [@sjawhar](https://github.com/sjawhar)).
- Moving a session (`/move`, or re-rooting on resume when its directory is gone) into a project it lived in before no longer fails with `ENOTEMPTY`; the two artifact directories are merged instead ([#12035](https://github.com/can1357/oh-my-pi/pull/12035) by [@sjawhar](https://github.com/sjawhar)).
- Inbound user messages delivered by an extension (e.g. HCOM `sendUserMessage`) no longer clear the composer draft; in-progress text and pasted images are preserved.
- zsh completions for `--resume`, `--model` and the other dynamic value flags work again. ([#12113](https://github.com/can1357/oh-my-pi/pull/12113) by [@Huang-404-Q](https://github.com/Huang-404-Q))
- Leftover child `.git` directories and broken gitfiles no longer appear as the active project in the status line or agent instructions ([#12105](https://github.com/can1357/oh-my-pi/pull/12105) by [@bobbyhuang-dev](https://github.com/bobbyhuang-dev)).
- Clicking a file path in the VS Code terminal opens the file at the requested line instead of a blank tab, and no longer breaks JVM language servers. ([#12123](https://github.com/can1357/oh-my-pi/pull/12123) by [@Huang-404-Q](https://github.com/Huang-404-Q))
- An `http`/`sse` MCP server that drops while the session is idle (a restart, a redeploy, a laptop waking) now reconnects on its own with a backoff instead of staying disconnected until the next tool call or `/mcp reconnect`, so its resource subscriptions and notifications come back with it ([#11803](https://github.com/can1357/oh-my-pi/pull/11803) by [@sjawhar](https://github.com/sjawhar)).
- Fixed pending-task reminders restarting the model after empty-response retries were exhausted ([#11879](https://github.com/can1357/oh-my-pi/pull/11879) by [@moodiness](https://github.com/moodiness)).
- `/tan` now waits for descendant results before returning its final answer and remains cancellable while waiting ([#12090](https://github.com/can1357/oh-my-pi/pull/12090) by [@ryxli](https://github.com/ryxli)).
- Ollama web search results now collapse tabs and embedded newlines in titles and snippets so they render on single lines.
- Pre-execution extensions that rewrite a streamed edit now execute the rewritten edit instead of the original input.
- Fixed sessions with skills disabled still advertising unavailable `skill://` resources ([#10215](https://github.com/can1357/oh-my-pi/issues/10215)).
- Singular and plural now work on both plugin surfaces: `/plugin` in the TUI and `omp plugins` on the CLI ([#12092](https://github.com/can1357/oh-my-pi/pull/12092) by [@XL-Lewis](https://github.com/XL-Lewis)).
- ACP no longer advertises a custom or file slash command whose name collides with a builtin alias (e.g. `models`, `status`, `rewind`), which previously offered a command that ran the builtin instead of the configured handler ([#12092](https://github.com/can1357/oh-my-pi/pull/12092) by [@XL-Lewis](https://github.com/XL-Lewis)).
- A manual `/compact` (slash command, RPC `compact`, extension `ctx.compact()`) issued while a turn is in flight now resumes that turn once the summary is committed, or immediately when there was nothing to compact — a queued steer/follow-up drives the resume, otherwise the same auto-continue nudge context-full compaction uses — instead of leaving the agent idle on a half-finished tool loop until the user types "continue". A prompt or extension-triggered turn that lands first takes the session instead. `compaction.autoContinue: false` still disables the resume; plan-mode "Approve and compact context" keeps dispatching its own execution turn ([#11873](https://github.com/can1357/oh-my-pi/pull/11873) by [@brndnmtthws](https://github.com/brndnmtthws)).
- Model-browser prices now preserve integer trailing zeros and positive sub-cent rates, and identify invalid individual rates ([#11624](https://github.com/can1357/oh-my-pi/pull/11624) by [@cyriusweng](https://github.com/cyriusweng)).
- Fixed the composer stranding blank rows below the input after a confirmation dialog or tall multi-line editor collapses; the editor now stays pinned to the bottom instead of drifting up until a resize ([#11007](https://github.com/can1357/oh-my-pi/issues/11007)).
- Subagent transcripts now identify their parent session and attribute host or parent-agent steering to the agent instead of the user ([#12077](https://github.com/can1357/oh-my-pi/issues/12077)).
- User-shell `!` commands now keep their transcript block mutable until queued PTY replay finishes, preventing successful and nonzero stdout/stderr from disappearing into immutable terminal history ([#12062](https://github.com/can1357/oh-my-pi/issues/12062); [#12080](https://github.com/can1357/oh-my-pi/pull/12080) by [@Dante-dan](https://github.com/Dante-dan)).
- Headless print mode now stays alive while first-turn mnemopi recall waits for its embedding worker ([#12067](https://github.com/can1357/oh-my-pi/issues/12067)).
- Deferred TTSR reminders no longer repeat before the configured `repeatGap` has elapsed ([#12065](https://github.com/can1357/oh-my-pi/pull/12065) by [@Dante-dan](https://github.com/Dante-dan)).
- Queued user steering and follow-up messages now refresh extension policy at delivery, including the first steering turn in a new session; returned overrides stay current when hooks change tools, and repeated policy changes pause automatic draining until an explicit retry ([#11835](https://github.com/can1357/oh-my-pi/pull/11835) by [@andrebrait](https://github.com/andrebrait)).
- Fixed the TODO HUD auto-dismiss lifecycle: completed plans now persist their hidden state, survive session reopen, and can be explicitly revealed without stale timers hiding replacement plans.
- Agents shipped by omp-installed marketplace plugins now honor their `model:` frontmatter instead of always inheriting `@default`; only Claude Code-format plugins (declaring `.claude-plugin/plugin.json`) keep dropping their provider-specific aliases ([#12028](https://github.com/can1357/oh-my-pi/issues/12028)).
- `--resume`/`--continue` combined with `--no-session` now fail with `--resume requires session persistence` instead of silently starting a fresh empty session and discarding the resumed history ([#12008](https://github.com/can1357/oh-my-pi/issues/12008)).
- Session search now keeps exact and partial title matches above prompt-history matches, so a session found by name stays at the top after typing pauses ([#11990](https://github.com/can1357/oh-my-pi/pull/11990) by [@lemonleks](https://github.com/lemonleks)).
- Collab replication now enforces its 1 MiB frame ceiling: an entry too large to shrink ships as a "too large to replicate" entry instead of an oversized frame, a deeply nested entry no longer aborts a guest's join, and the ceiling is measured in bytes rather than UTF-16 code units ([#11433](https://github.com/can1357/oh-my-pi/issues/11433); [#11999](https://github.com/can1357/oh-my-pi/pull/11999) by [@MertSoylu](https://github.com/MertSoylu)).
- Model Hub now waits for default-role assignment to finish before accepting more input, preventing stale UI state and duplicate model changes that made a selection appear to require a second attempt ([#10982](https://github.com/can1357/oh-my-pi/pull/10982) by [@lemonleks](https://github.com/lemonleks)).
- Fixed macOS copies showing pasteboard warnings, mangling non-ASCII text, reinterpreting PDF/EPS/RTF text, or leaving stale text after rapid copies ([#9015](https://github.com/can1357/oh-my-pi/pull/9015) by [@lemonleks](https://github.com/lemonleks)).
- Fixed the coding-agent binary bundle failing with `Could not resolve: "chalk"` in hermetic installs (e.g. `nix run`) by importing chalk from the in-repo `@oh-my-pi/pi-utils/chalk` reimplementation instead of the undeclared npm `chalk` package ([#12001](https://github.com/can1357/oh-my-pi/issues/12001)).
- Fixed `edit.modelVariants` and other model-dependent system-prompt policy going stale after an automatic retry or usage-aware fallback swapped the model, so a session that fell back to a variant-pinned model now rebuilds its prompt for the model actually serving the turn ([#11983](https://github.com/can1357/oh-my-pi/issues/11983)).
- `omp auth-gateway serve` now picks up credential logins and logouts made by another process within ~10s instead of serving its boot-time credential set until restart: broker-backed clients implement `pollExternalChanges()`, and the gateway polls it to reload credentials and rebuild its served catalog so a newly-logged-in provider becomes routable and a logged-out one stops being advertised and used ([#11781](https://github.com/can1357/oh-my-pi/issues/11781)).
- Fixed `omp bench` and `omp if-bench` rejecting models that `omp models` lists (e.g. llama.cpp, Ollama, LM Studio, `models.yml` servers) by retrying model resolution through a live discovery pass when the local cache can't restore their credentials ([#11598](https://github.com/can1357/oh-my-pi/pull/11598) by [@yomgui1](https://github.com/yomgui1)).
- `omp --fork` with a missing session path now fails with `Session "<path>" not found.` instead of silently opening an empty parentless session ([#11944](https://github.com/can1357/oh-my-pi/pull/11944) by [@onlyysaurabh](https://github.com/onlyysaurabh)).
- `omp read <mcp-resource>` now waits for a still-handshaking MCP server to finish connecting instead of reporting `No MCP server has resource` when the connect outlasts the startup race ([#11950](https://github.com/can1357/oh-my-pi/issues/11950)).
- `memory://root` is now advertised in URL completion only on `memory.backend=local`, and reading it on `hindsight`/`mnemopi` reports the file-backed root as local-only (pointing at `recall`/`reflect`) instead of telling you to enable memories that are already enabled; the memory glob validator now names the expected form (`memory://root/**`) instead of echoing the rejected input ([#11909](https://github.com/can1357/oh-my-pi/issues/11909)).
- Advisors no longer brick themselves permanently on a transient rate limit: a usage-limit error whose credential is only temporarily blocked is now waited out and retried (bounded by `retry.maxDelayMs` / `retry.maxRetries`), latching the quota-exhausted state only when the block is a genuine long quota window ([#11947](https://github.com/can1357/oh-my-pi/issues/11947)).
- Large eval `display()` values now stay bounded in session history while remaining available through output artifacts, preventing slow `--resume` startup ([#11920](https://github.com/can1357/oh-my-pi/issues/11920)).
- Hindsight mental-model refresh no longer rewrites the active session's cached system-prompt prefix: the rendered `<mental_models>` block is frozen for the session lifetime (a background reflect applies to the next session; `/memory mm reload` remains the explicit in-session refresh), and volatile `last_refreshed_at` metadata no longer enters the model-facing prompt ([#11961](https://github.com/can1357/oh-my-pi/issues/11961)).
- Fixed Ctrl+D quitting the prompt even with draft text; it now deletes the character at the cursor like Delete, and only exits on an empty draft.
- Task subagents now honor the parent session's pinned OAuth account, including parallel and nested tasks ([#11939](https://github.com/can1357/oh-my-pi/issues/11939)).
- Advisor acknowledgments distinguish acceptance, deferral, and suppression; higher-priority findings replace only pending notes from the same review ([#11881](https://github.com/can1357/oh-my-pi/pull/11881) by [@olegpulatov](https://github.com/olegpulatov)).
- `/extensions` now shows an enabled context file as active when its higher-priority competitor is disabled ([#11870](https://github.com/can1357/oh-my-pi/issues/11870)).
- Anthropic prompt caching now keeps rolling breakpoints on persisted history when multiple `context` extension handlers append per-call messages ([#11897](https://github.com/can1357/oh-my-pi/issues/11897)).
- Collab guests now automatically rejoin when a transient host network drop recreates the relay room ([#11858](https://github.com/can1357/oh-my-pi/issues/11858)).
- Yield now resets the schema-validation retry budget after each valid section and recovers double-encoded JSON values instead of spending retries ([#11890](https://github.com/can1357/oh-my-pi/pull/11890) by [@lucamaia9](https://github.com/lucamaia9)).
- Bash commands whose `cwd` is a secondary Git worktree no longer inherit the agent's own `GIT_DIR`/`GIT_WORK_TREE` and related repo-location overrides, so a failed cherry-pick stays in the worktree where it ran instead of contaminating the primary one ([#11082](https://github.com/can1357/oh-my-pi/issues/11082)).
- Fixed `hub start` failing with a raw `connect ENOENT …/broker.sock` when the project daemon broker's lease was stale: the lease is now a process-owned lock the OS releases however the broker dies, a stale lease no longer blocks startup, and a broker that still cannot start reports its scope path plus recovery commands ([#11080](https://github.com/can1357/oh-my-pi/issues/11080)).
- Fixed concurrent `/pin` toggles from multiple omp instances silently dropping each other's pins, and crashes mid-write corrupting the pins file.
- LSP and debugger connections reject oversized or invalid frames instead of accumulating stdout indefinitely; fragmented headers decode without rescanning previous bytes.
- Read-only transcripts skip image blobs from hidden history, and session blob loading limits concurrent reads.
- Ctrl+C during an in-flight extension/hook load now exits cleanly instead of raising an `ExtensionExitError` unhandled-rejection storm ([#11789](https://github.com/can1357/oh-my-pi/issues/11789)).
- The legacy `@earendil-works/pi-coding-agent` shim now exports `findCutPoint` (adapted to upstream Pi's tokenizer-less 4-arg signature) and `sessionEntryToContextMessages`, so extensions targeting upstream Pi 0.84.2's compaction/session APIs (e.g. NVlabs/SoL-Pi) install instead of failing validation ([#11796](https://github.com/can1357/oh-my-pi/issues/11796)).
- `write` now rejects exact incomplete read projections before they can replace and truncate an existing file ([#11792](https://github.com/can1357/oh-my-pi/issues/11792)).
- Long reasoning streams retain less memory while preserving scrollback and terminal-width replay.
- `omp read <image>?q=<question>` no longer fails with "Model registry is unavailable for image questions."; the read CLI now wires a model registry so image questions resolve `modelRoles.vision`/`@default` like the agent ([#11338](https://github.com/can1357/oh-my-pi/issues/11338)).
- Shared sessions stay connected when a guest sends a corrupted frame or uses the wrong room key.
- Fixed turns dying with `undefined is not an object (evaluating 'e.identity.class')` as soon as the model started thinking when an extension provider projects its own catalog through `oauth.modifyModels` (`pi-provider-kiro` and friends); projected models are now materialized like every other catalog source.
- Legacy `agent.db` settings rows are deleted after a successful `config.yml` migration write, so deleting `config.yml` no longer silently resurrects stale values ([#11568](https://github.com/can1357/oh-my-pi/issues/11568)).
- Subagents (including `/vibe` workers) that write their report in one turn and then finalize with a data-less `yield` in the next no longer come back as `SYSTEM WARNING: Subagent called yield with null data` stapled to accumulated narration. The finalize now harvests the last turn that actually reported — prose with no further work started — so mid-run narration can never surface as a final result either ([#11746](https://github.com/can1357/oh-my-pi/pull/11746) by [@oldschoola](https://github.com/oldschoola)).
- Fixed `/force` and other forced tool choices refusing every OpenRouter model: `buildNamedToolChoice` did not recognise the `openrouter` api. Models whose compat disables tool choice or forced tool choice now report forcing as unsupported instead of queueing a choice the transport discards ([#11658](https://github.com/can1357/oh-my-pi/pull/11658) by [@datrixlab](https://github.com/datrixlab)).
- Provider `baseUrl` overrides now scope by API: custom models inheriting the provider URL define which APIs it covers (a provider-level `api` covers override-only providers), `transport: pi-native` keeps its gateway `baseUrl` provider-wide, and a bundled model no longer routes to another API's endpoint ([#11608](https://github.com/can1357/oh-my-pi/pull/11608) by [@danilouchoa](https://github.com/danilouchoa)).
- Invalidated stale background speculative compaction results when post-snapshot branch growth prevents recovery headroom or causes net context expansion, preventing dead-end progress pauses and provider context overflows ([#11637](https://github.com/can1357/oh-my-pi/pull/11637) by [@alvins82](https://github.com/alvins82)).
- Fixed `AgentSession.waitForIdle()` returning before successful retry recovery events and persistence had settled.
- Reviving a parked subagent whose session file vanished, or whose transcript lost its message history, now fails loudly instead of resurrecting a zero-history agent that runs, answers peers, and writes attributed work ([#11500](https://github.com/can1357/oh-my-pi/issues/11500)).
- Native compaction preserves prior local summaries and messages arriving while a speculative compaction is in flight. ([#11525](https://github.com/can1357/oh-my-pi/pull/11525) by [@rpie9](https://github.com/rpie9))
- Advisor maintenance preserves compaction summaries and native replay payloads in later requests without duplicating native-covered retained messages. ([#11525](https://github.com/can1357/oh-my-pi/pull/11525) by [@rpie9](https://github.com/rpie9))
- Advisor maintenance uses portable summaries for incompatible native targets and prevents automatic model switches or recovery re-primes from stranding native history. ([#11525](https://github.com/can1357/oh-my-pi/pull/11525) by [@rpie9](https://github.com/rpie9))
- Advisor fallback, cooldown restoration, and context promotion can replay compatible native history when new native compaction is disabled; creating native results still requires the remote method to be enabled. ([#11525](https://github.com/can1357/oh-my-pi/pull/11525) by [@rpie9](https://github.com/rpie9))
- Secret obfuscation covers native message, tool/search text, and dynamic discovery descriptions and schema annotations in replay and preserved compaction history, including search/discovery-only collisions and snapshots committed after a later secret is discovered, while preserving tool schema constraints. ([#11525](https://github.com/can1357/oh-my-pi/pull/11525) by [@rpie9](https://github.com/rpie9))
- A session store that stops accepting writes (full disk, locked file, removed drive) now reports the failure on stderr in print mode and as an error notice in RPC mode, and a run whose transcript never became durable exits nonzero instead of reporting success ([#11493](https://github.com/can1357/oh-my-pi/issues/11493)).
- Online auto-thinking classification and session titles now walk `retry.fallbackChains` when the tiny/smol primary returns a provider error, instead of failing the background task while the main turn still has a fallback chain.
- Online tiny tasks now use canonical model-keyed, wildcard, and role fallback resolution, and stop at the first resolvable model when `retry.modelFallback` is disabled.
- Session title generation now expands the appended active session model's own `retry.fallbackChains` after that model fails, without merging tiny/commit/smol role defaults onto it ([#10938](https://github.com/can1357/oh-my-pi/pull/10938)).
- `/export` HTML now renders bold inline code inside ordered-list items followed by fenced code blocks instead of displaying literal `<strong>` and `<code>` tags ([#11690](https://github.com/can1357/oh-my-pi/issues/11690)).
- Disabled providers are no longer selected as pinned subagent models; ordered agent model lists now skip them ([#11709](https://github.com/can1357/oh-my-pi/issues/11709)).
- Entering goal or vibe mode while a plan session is paused now warns `Plan mode is paused — run /plan again to fully exit.` instead of the stale `Exit plan mode first.` ([#11692](https://github.com/can1357/oh-my-pi/issues/11692)).
- `omp plugin install <name>` for npm packages now bypasses bun's manifest cache, so a reinstall picks up a newly published version instead of a stale one, and installing an explicit `<name>@<version>` no longer fails to resolve a version that exists on the registry ([#11634](https://github.com/can1357/oh-my-pi/issues/11634)).
- File slash commands now surface their `argument-hint` frontmatter as inline autocomplete ghost text and ACP `input.hint`, not only in the `/extensions` inspector ([#11647](https://github.com/can1357/oh-my-pi/issues/11647)).
- Extensions authored against upstream Pi (e.g. pi-fabric) no longer crash every session at startup: registered tools now carry the upstream-shaped `sourceInfo` provenance that `getAllRegisteredTools()` consumers read ([#11661](https://github.com/can1357/oh-my-pi/issues/11661)).
- Custom `openai-responses` / `openai-codex-responses` providers can now set `compat.supportsConfigurationUpdate: false` in `models.yml` so auto-thinking effort changes on `gpt-6-astra` are sent as the top-level `reasoning.effort` instead of a `configuration_update` input item the endpoint rejects with HTTP 400; the key is validated as a boolean and documented ([#11121](https://github.com/can1357/oh-my-pi/issues/11121)).
- Missing execute-time tool context now fails closed to `always-ask` with an empty policy map (no user grant) instead of silently resolving as `yolo` with empty policies. The former copies (`ExtensionToolWrapper.execute`, Cursor `refuseByWritePolicy`, `mcpApprovalPreflight`, and eval prelude host calls) share one helper so they cannot drift. A session-bound wrapper that is invoked without context still inherits that session's settings ([#10362](https://github.com/can1357/oh-my-pi/issues/10362)).
- Advisors that repeatedly emit unsafe tool calls now pause their optional review until reset or their model/tool capability basis changes.
- Stop eval from advertising `agent()` after the session reaches its subagent recursion-depth limit.
- Background job snapshots preserve complete sibling results when a capture fails and show each capture warning only once.
- Failed raw-output captures now show a warning without failing the command or advertising an incomplete artifact as full output.
- Unknown custom status-line segment ids now produce a config warning and are rejected by `omp config set` instead of silently disappearing ([#11579](https://github.com/can1357/oh-my-pi/issues/11579)).
- `ast_edit`, `search`, and `ast_grep` no longer fan out into overlapping scans when `paths` mixes a directory with a file inside it and the directory is spelled as an absolute path; `ast_edit` previously applied each rewrite twice to the nested file (corrupting it, e.g. `wrap(wrap(log(1)))`) or reported a spurious stale-preview error ([#11584](https://github.com/can1357/oh-my-pi/issues/11584)).
- Selecting the Custom status line preset now starts from its built-in segment layout when no segment lists are configured, while explicit empty lists still hide either side ([#11577](https://github.com/can1357/oh-my-pi/issues/11577)).
- Snapcompact frame-overflow rescue now replaces its superseded divider instead of rendering two contradictory before→after badges ([#11607](https://github.com/can1357/oh-my-pi/issues/11607)).
- Windows home launches and in-process shell paths (builtins, `ls`, and redirections) now resolve `/tmp` to the system temporary directory instead of a drive-root `tmp` directory ([#11603](https://github.com/can1357/oh-my-pi/issues/11603)).
- Shared-session guests can no longer fetch private advisor transcripts by agent ID.
- Fixed `/restart` and worker spawning failing with ENOENT after package managers prune the unlinked previous version directory during an upgrade ([#10873](https://github.com/can1357/oh-my-pi/pull/10873)).
- xAI web search omits relay narration even when responses include aggregate text or blank citation URLs, while preserving substantive answers.
- xAI web search no longer rejects valid aggregate answers because of non-message relay metadata.
- Advisor calls to tools it was not granted are answered in-band with the loop's `Tool <name> not found` result instead of discarding the whole turn; only hazardous output is still quarantined, and the repeated-quarantine latch is gone.
- macOS self-updates preserve executable backups still used by running sessions, preventing lost privacy-permission attribution.
- Startup and daemon commands no longer crash when project-directory canonicalization encounters EPERM or EACCES.
- `omp plugin install --dry-run` now previews marketplace installs without mutating plugin state.
- In colocated jj-git workspaces, the status line and footer now show the JJ label (bookmark or short change ID) instead of a detached git HEAD. Git-backed automation still resolves these directories to Git ([#11071](https://github.com/can1357/oh-my-pi/issues/11071), [#11325](https://github.com/can1357/oh-my-pi/pull/11325) by [@boazy](https://github.com/boazy)).
- Command output from native Windows tools on Chinese (and other non-UTF-8) locales is decoded using the system ANSI code page instead of turning into replacement characters.
- `omp share` now reports missing session paths instead of creating and publishing empty sessions ([#11483](https://github.com/can1357/oh-my-pi/issues/11483)).
- `omp gc --blobs` no longer deletes image blobs still referenced by a session stored via `--session-dir`/`--session`, including exact paths without a `.jsonl` suffix; relocated transcript files are now recorded in a persistent registry the blob reachability scan reads (issue [#11551](https://github.com/can1357/oh-my-pi/issues/11551)).
- `--export` now reports missing input files instead of creating empty sessions and successful transcript-less exports ([#11481](https://github.com/can1357/oh-my-pi/issues/11481)).
- `AgentLifecycleManager.global()` now rebinds to the current global registry after a lone `AgentRegistry` reset, so a test that resets only the registry can no longer strand the lifecycle manager on a dead instance and hang the collab kill path ([#11432](https://github.com/can1357/oh-my-pi/issues/11432)).
- Unset `advisor` model roles now honor the configured `@slow` fallback without inheriting an unconfigured primary model ([#11428](https://github.com/can1357/oh-my-pi/issues/11428)).
- Unknown-context-window providers (e.g. a custom/self-hosted OpenAI-compatible profile the model registry has no metadata for) no longer permanently dead-end on a non-media payload-rejection 413 when a usable compaction method is configured; the session now gets the same promotion/compaction attempt a known-window overflow would ([#11479](https://github.com/can1357/oh-my-pi/issues/11479)).
- The `set_auto_compaction` and `set_auto_retry` RPC commands are now session-scoped like `set_thinking_level`, so a short-lived RPC client no longer silently writes `compaction.enabled`/`retry.enabled` to the machine-global `config.yml` ([#11431](https://github.com/can1357/oh-my-pi/issues/11431)).
- Closing an idle terminal whose draft was resumed and materialized into a real conversation by another terminal no longer deletes that conversation; the close-time draft GC now re-reads the session file before dropping it ([#11497](https://github.com/can1357/oh-my-pi/issues/11497)).
- RPC output spills to temporary disk storage for slow readers instead of retaining an unbounded memory queue, and drains final responses before shutdown.
- Large session records load faster without repeatedly copying unfinished JSONL rows.
- `omp update` now bypasses mise's `minimum_release_age` gate when updating via mise, so a fresh release published within the freshness window (24h by default) installs instead of being silently skipped ([#11316](https://github.com/can1357/oh-my-pi/issues/11316)).
- Bounded reads of large files no longer report a partial scan count as the exact file line total ([#11417](https://github.com/can1357/oh-my-pi/issues/11417)).
- Alt+Up (dequeue) now pops only the last queued message back into the composer instead of draining the entire queue, so pressing it no longer destroys composer work ([#11402](https://github.com/can1357/oh-my-pi/issues/11402)).
- Large collab snapshots now stream in order through slow connections; an overloaded live queue ends sharing explicitly instead of silently losing updates or commands.
- A collab guest that disconnects mid-snapshot, or a host that reconnects into a recreated room, no longer leaves stale snapshot frames at the head of the shared send queue delaying every other guest's welcome.
- Fixed a collab authorization bypass: after a host reconnect the relay reissues guest ids from 1, and the host kept the previous ids' write permissions, so a client holding only the read-only view link could take a reissued id and run prompts, interrupts, agent commands or answer host prompts without ever joining.
- A host prompt awaiting a collab guest's answer no longer hangs when the host reconnects: the relay closes everyone who could answer, so the request now resolves as unavailable instead of waiting forever or being re-posed to whoever joins next.
- LSP semantic queries (references, definition, rename, hover) now reconcile an already-open document with disk before running, so an external edit that shifts lines no longer resolves the query against the server's stale document and returns a different symbol ([#11416](https://github.com/can1357/oh-my-pi/issues/11416)).
- Antigravity usage views now show the shared Claude/GPT five-hour and weekly quotas once per account instead of duplicating Anthropic and OpenAI rows ([#11268](https://github.com/can1357/oh-my-pi/issues/11268)).
- Fixed spelling typo underlines painting solid black bars over composer text in Apple Terminal, which does not implement colon-subparameter styled underlines. Terminals without that capability now use a flat underline. kitty, Ghostty, WezTerm, and iTerm2 version 3.5 or later keep the red curly underline.
- Fixed a `/move` or cross-project resume completing before memory was rebound, so the next prompt could recall and retain against the previous project's Hindsight bank, the destination project's `memory.backend` and Hindsight server were ignored, and a failed rebind was reported as a successful move. Cwd rebinding drains Mnemopi extractions without auto-retaining the transcript during move or rollback, and rejects moves when destination Mnemopi startup fails.
- Hide unavailable Hindsight memory tools after moving to a project without an effective Hindsight URL.
- Keep memory disabled in restricted SDK sessions after `/move` and `/wt`.
- Clear source-bank recall and mental-model context before Hindsight cwd rebinding completes.
- Fixed effort-specific retry fallback chains selecting the wrong chain by object/YAML order: a `model:low` selector no longer matches a configured `model:max` key (or vice versa), so a 429 retry stays on the same effort instead of escalating to an unrelated chain ([#11192](https://github.com/can1357/oh-my-pi/issues/11192)).
- Fixed `computer.capabilities()` returning `undefined` when called before any `computer.run`; the direct helper now fetches fresh backend and permission state from the desktop worker instead of a run-populated cache ([#11169](https://github.com/can1357/oh-my-pi/issues/11169)).
- Editor shortcuts for thinking visibility, history search, external editing, and tool activity now work while the Ask dialog has focus ([#11213](https://github.com/can1357/oh-my-pi/issues/11213)).
- Uninstalling a locally linked plugin now removes its `node_modules` symlink, so a later registry install cannot continue running the linked checkout ([#11172](https://github.com/can1357/oh-my-pi/issues/11172)).
- Fixed a user-invoked `/skill:` submission rendering two identical skill cards when the optimistic row retired into scrollback before the canonical message arrived during a slow preflight ([#11217](https://github.com/can1357/oh-my-pi/issues/11217)).
- Fixed `.astro` files rendering without syntax highlighting in write/edit previews and diffs: a vendored Astro grammar now highlights the `---` frontmatter and `{…}` template expressions as TypeScript and the template as HTML, instead of treating the whole file as HTML text ([#11164](https://github.com/can1357/oh-my-pi/pull/11164) by [@byigitt](https://github.com/byigitt)).
- Credential-shaped tokens are now redacted before the `mnemopi` backend persists a memory, covering the `retain`/`learn` tools, the automatic transcript retention path, and `memory_edit update`. Previously only the `local` and `sharpshooter` backends redacted, so a token pasted into a session could be stored verbatim and handed to any provider by a later `recall`.
- Fixed `/tan` forking a mid-turn parent leaving the clone showing the parent's in-flight tool call as its own unresolved work: the fork now pairs the parent's unresolved tool call with a synthetic aborted result so the clone inherits a terminal, well-formed transcript ([#11118](https://github.com/can1357/oh-my-pi/issues/11118)).
- Antigravity image generation now uses the image model advertised for the connected account instead of silently falling back after a stale-model 404 ([#11106](https://github.com/can1357/oh-my-pi/issues/11106)).
- `/tan` keeps its assigned request after automatic compaction instead of returning an empty-request question ([#11119](https://github.com/can1357/oh-my-pi/issues/11119)).
- `plugin doctor` now flags a plugin whose `omp-plugins.lock.json` version differs from the version installed in `node_modules`, instead of reporting the stale copy healthy; `--fix` reconciles it by reinstalling ([#11090](https://github.com/can1357/oh-my-pi/issues/11090)).
- `plugin upgrade` on an npm-installed plugin (e.g. a scoped `@scope/pkg`) now points to `omp plugin install <pkg> --force` instead of the opaque "Expected name@marketplace" parse error ([#11090](https://github.com/can1357/oh-my-pi/issues/11090)).
- `plugin install --force` now forwards the force request to Bun so stale cached package contents are actually replaced ([#11090](https://github.com/can1357/oh-my-pi/issues/11090)).
- Fixed `retry.waitForUsageReset` scheduling Z.AI and Zhipu resets eight hours late when provider responses omit the reset timestamp timezone ([#11014](https://github.com/can1357/oh-my-pi/issues/11014)).
- Claude Code sessions without history metadata use the working directory recorded by their transcript before falling back to the encoded project folder name.
- Reassigning a reserved JS Eval global (e.g. `var fs = await import("node:fs/promises")`) now persists across cells instead of silently reverting to the injected value on the next cell ([#10988](https://github.com/can1357/oh-my-pi/issues/10988)).
- Extension provider reloads no longer remove cached models from unrelated credential-scoped providers ([#10973](https://github.com/can1357/oh-my-pi/issues/10973)).
- Fixed the transcript pane rendering blank under the wmux terminal multiplexer on Windows; wmux panes are now detected as a multiplexer and repaint in place instead of emitting history the pane discards ([#11012](https://github.com/can1357/oh-my-pi/issues/11012)).
- Cursor sessions now preserve interrupted headless turns when SIGINT or SIGTERM stops print mode ([#10965](https://github.com/can1357/oh-my-pi/issues/10965)).
- Codex saved resets now auto-redeem when the exhausted weekly chat window is reported in the primary limit slot ([#10929](https://github.com/can1357/oh-my-pi/issues/10929)).
- Fixed ACP `always-ask`/`write` approval modes leaving a granted tool call stuck `pending`: an approved permission now runs the tool instead of re-prompting through the interactive gate that ACP clients cannot answer ([#10850](https://github.com/can1357/oh-my-pi/issues/10850)).
- Allowed marketplace and plugin names to contain uppercase letters while rejecting case-equivalent names that would collide in caches, so Claude-compatible marketplaces like `HexRaysSA/claude-marketplace` install and update instead of failing with `Missing or invalid field "name"` ([#10827](https://github.com/can1357/oh-my-pi/issues/10827)).
- Eval `agent()` wait no longer re-emits the same settled progress snapshot as duplicate status events.
- Configured LiteLLM discovery no longer exposes known task-specific models, including embedding, media, moderation, reranking, and search models, in model selectors.
- Fixed MCP tool names dropping digits, which renamed servers such as `context7` (`mcp__context_query_docs` → `mcp__context7_query_docs`) and collapsed servers differing only by a digit onto the same tool names, costing one of them a tool ([#10179](https://github.com/can1357/oh-my-pi/pull/10179) by [@bitboxx](https://github.com/bitboxx)). User `tools.approval` `deny`/`prompt` policies written against the old digit-stripped names keep applying to the renamed tools; `allow` entries and exact (non-glob) `tools.xdevInlineDevices` patterns need updating to the new names.
- Fixed one-shot CLI runs (`omp --help | head`, `omp --version | true`, `omp <command> | grep -m1`) crashing with a fatal `EPIPE: broken pipe, write` when the stdout consumer closed early; a vanished stdout peer now exits cleanly like any other Unix tool ([#10930](https://github.com/can1357/oh-my-pi/issues/10930)).
- Sticky `RULES.md` and other discovered rules are now re-read from disk on `/clear` and `/new`, so rules created or edited while omp is running take effect on the next session reset instead of only after a restart ([#10940](https://github.com/can1357/oh-my-pi/issues/10940)).
- The per-line column-cap truncation notice now points to the full-output artifact (`Read artifact://<id> for full output`) when the raw stream was mirrored, matching the tail-truncation notice ([#10877](https://github.com/can1357/oh-my-pi/issues/10877)).
- The per-line column-truncation notice now names the unit it enforces — `bytes` for streamed bash/eval output, `chars` for `read`/`grep` — instead of always claiming `chars`, which overstated visible content for multibyte text ([#10888](https://github.com/can1357/oh-my-pi/issues/10888)).
- The per-line column-truncation notice now names the unit it enforces — `bytes` for streamed bash/eval and grep output, `chars` for `read` — instead of always claiming `chars`, which overstated visible content for multibyte text ([#10888](https://github.com/can1357/oh-my-pi/issues/10888)).
- A custom `modelRoles` entry that references another role (e.g. `fast_worker: "@task"`) now resolves to the referenced role's model even when `retry.modelFallback` is disabled ([#10853](https://github.com/can1357/oh-my-pi/issues/10853)).
- Isolated task worktrees now survive agent yields and retain committed checkpoints until the agent is released ([#10913](https://github.com/can1357/oh-my-pi/issues/10913)).
- Fixed Ctrl+O (`app.tools.expand`) in the `ask` dialog only expanding a truncated question header: it now also expands truncated option descriptions in place.
- GitHub failures now retain structured API diagnostics, identify failed file reads, and clarify Boolean search syntax.
- Fixed `--continue` resuming a session stored outside an explicit `--session-dir`, and a breadcrumb recorded for a different session directory suppressing session lookup inside the requested one.
- Clarifying questions entered through Ask's `Other` option are answered before the original choice is shown again ([#10672](https://github.com/can1357/oh-my-pi/pull/10672) by [@Giardi77](https://github.com/Giardi77)).
- Fixed `/collab` hiding the join URL when the QR code is clipped: the one-line fallback now includes the browser link, and the status heading keeps that URL on its first row so transcript pressure cannot drop it.
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
- `pi_ls`'s `limit` is still not mapped, now deliberately: it caps directory _entries_, while the local `read` tool renders a depth-2 tree with per-directory caps and elision rows and applies a selector as a _rendered line_ slice. Mapping it to `:1+K` would cap a different unit while appearing honored.
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
- Fixed every native `pi_edit` failing after a session switched onto Cursor. The replace-mode `edit` instance the frame needs was built only for sessions _created_ on Cursor, and the tool roster is not rebuilt on a model switch — so a session that started elsewhere kept its configured-mode `edit` in the registry, which the bridge resolves before its fallback, and the frame's `old_text`/`new_text` pairs failed validation against a `hashline` schema. The instance is now built from the `edit` grant regardless of the session's initial provider (lazily, so a session that never reaches Cursor never constructs one) and `pi_edit` asks for it explicitly through a dedicated accessor. A session that was never granted `edit` is still refused.
- Fixed the Cursor bridge's tool resolver being able to execute an unadvertised `edit`. That resolver doubles as the agent loop's fallback for any call outside the advertised set, so serving `edit` from it meant a hallucinated call — or one naming a tool the session deselected after startup — could run a replace-mode edit the model was never offered. It is device-only again; `pi_edit` uses its own accessor.
- Fixed the legacy Cursor `read` frame ignoring the `offset`/`limit` modern builds paginate with. Only the Pi variant composed a range, so every page of a legacy read returned the whole file (or its own truncation) and a model walking a large file never advanced past the first window. Both frames now translate a range through the same helper, and the answer sets `range_applied` to describe whether a window was actually composed.
- Fixed the legacy Cursor `grep` frame ignoring its pagination `offset`. The local `grep` paginates by file through `skip` and advertises exactly that in its own "use skip=N" advice, so an unforwarded offset re-ran the identical search and answered page one for every page. The answer now reports the offset it applied in `offset_applied`.
- Fixed a paginated Cursor `read` or `grep` frame being recorded as an unpaginated one. The executed call and the transcript block are built separately, so forwarding the frame's range and page fixed only the execution: the block still showed a bare path and an unskipped search, which is what a reloaded session replays and what the next turn reasons from — a slice of a file presented as the whole thing, and results from a later window presented as page one. Both are now synthesized from the same translation that runs them, including a `limit: 0` read, which is recorded as the zero lines it returns rather than a whole-file read.
- Fixed Cursor advisors answering every MCP resource frame as though the client hosted no servers. Only the primary bridge received the `MCPManager`-backed resource adapter, so an advisor's `list_mcp_resources` reported an empty catalog and its `read_mcp_resource` a `not_found` even though the advisor shares the session's live connections. Advisors now receive the same adapter; it is not gated on a tool grant, since reading what a server advertises is a different permission from calling one of its tools.
- Fixed advisor tools bypassing the approval gate. They are built straight from the builtin table, outside the loop that wraps every registry tool, and both the advisor's own agent loop and its Cursor exec bridge (`pi_write`, `pi_bash`) run those instances directly — so an advisor granted `write` or `bash` executed them regardless of a configured `ask` or `deny`. They now carry the same `ExtensionToolWrapper` as every other tool.
- Added `mcp_notification` extension event and multi-listener `MCPManager.addNotificationListener` API. The runtime already received MCP server-initiated JSON-RPC notifications at the transport layer but had no path to forward them to extensions; every notification (including server-custom methods) is now delivered as `{ server, method, params }` after the manager's own list/update handling. For known list-change methods (`notifications/tools/list_changed`, `notifications/resources/list_changed`, `notifications/prompts/list_changed`) the internal refresh promise is awaited before fanout, so a listener acting on `tools/list_changed` sees fresh `getTools()`. Notifications received before any listener attaches are buffered (bounded FIFO, cap 100, drop-oldest — matches `IrcBus`'s `MAILBOX_CAP`) and drained into the first subscriber, so startup-time frames aren't lost even if the extension binds after MCP discovery. Extensions can use this to bridge push-capable MCP servers (e.g. peer messaging) into session behavior by injecting a mid-turn steer via `pi.sendMessage` / `pi.sendUserMessage`.
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
- Restoring a prompt with image attachments via esc-esc branch or `/tree` now re-attaches the images to the composer draft: previously only the text (with its `[Image #N]` markers) was restored, so resubmitting sent the literal marker with no image.
- Fixed large bash/eval/ssh output citing two different artifact ids in one result — the truncation notice said `Read artifact://N for full output` while the footer said `Artifact: N+1`. The streaming sink's head and tail windows each had a full budget, so a middle-elided inline body could reach `headBytes + spillThreshold` and always re-tripped the final-defense inline byte cap, which truncated a second time (two elision markers), saved a duplicate already-truncated artifact, and left the notice's line ranges stale. The head and tail windows now share the spill-threshold budget (head clamped to half), the cap budget derives from the configured threshold plus notice slack, and when the cap does fire on a sink-spilled result it references the existing raw artifact instead of saving a copy.
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
- Fixed pre-initialization and cross-module render crashes in magic-keyword highlights, user and assistant messages, tool execution cards, and the usage dashboard ([#10864](https://github.com/can1357/oh-my-pi/issues/10864)).
- Retired local title models pinned before the LFM2.5 refresh (`lfm2-350m`, `lfm2-700m`, `qwen3-0.6b`, `qwen2.5-0.5b`, `gemma-270m`) now migrate to their closest current models instead of silently skipping session titles.

### Removed

- Removed the dangling `MCPManager.setOnNotification` single-slot setter, which had no callers in the runtime. Replaced by `MCPManager.addNotificationListener` — multi-listener, per-listener error isolation, returns an unsubscribe function.

## [18.2.0] - 2026-09-15

### Breaking Changes

- `Settings.getGroup()` now returns shallow-frozen snapshots, reused until effective settings change.
- Removed `parseSSE`, `MCPToolsResponse`, and `MCPCallResponse`; `callMCP()` now returns the shared `JsonRpcResponse` with an `unknown` result instead of an unchecked generic payload.

### Added

- Added `ollama` web search provider using Ollama's hosted web search API (`POST https://ollama.com/api/web_search`), authenticated via `OLLAMA_CLOUD_API_KEY` ([#3791](https://github.com/can1357/oh-my-pi/issues/3791)).
- Added `readUrl` support for Ollama model pages (`ollama.com/<model>` and `ollama.com/library/<model>`), extracting descriptions, tags, and architecture metadata.
- `@upstream` routing selectors accept tiered OpenRouter slugs (`openrouter/google/gemini-3.8-flash@google-ai-studio/priority`), and `omp bench` labels each routed model with its upstream.
- `/skill:<name>` in the composer becomes an atomic skill chip (icon + name, linked to its SKILL.md) once you finish typing it or accept it from autocomplete — it deletes as one unit and survives draft restores, like image chips.
- The transcript now flags a gateway serving a different Claude model than requested: a `⚠ served claude-haiku-4-5-20251001 · requested claude-opus-5 · via openrouter/Amazon Bedrock` divider under the first affected turn, shown once per substitution per session.

### Changed

- Compiled binaries ship precompiled bytecode: `omp` boots in ~30 ms instead of ~250 ms and the interactive prompt accepts input ~300 ms sooner, at the cost of a larger binary.
- Welcome recents refresh after first paint, and attachment bands reuse cached chip state until the draft changes.
- Interactive startup paints its speculative frame before loading the session runtime; model/auth dialogs and browser/computer preludes load on first use.
- Status-line redraws reuse unchanged segment output, settings groups, and tool token estimates while preserving live invalidation.
- Skill invocations render as a normal user turn: a mid-prompt skill shows as an inline chip in the user bubble; a leading skill shows as a railed callout with the chip and prompt size, with the rest of your message rendered as full multi-line Markdown instead of a single collapsed header.

### Fixed

- `hub wait` on a process now reports what it was actually blocked on when it times out (process exit, the `pattern`, or readiness) instead of always citing the start readiness log pattern.
- Isolated settings no longer share mutable array and record defaults.
- Ask timeouts above 1,000 seconds now retain their configured duration.
- Configured extension directories no longer load fallback index files when declared entries are missing.
- Telemetry no longer sends OTLP when only a non-OTLP exporter is selected.
- Browser response-body failures now preserve their original protocol errors.
- Auto-retry waits past the signed 32-bit timer ceiling (e.g. a month-scale OpenCode Go reset with `retry.waitForUsageReset`) now elapse in full instead of overflowing the timer and retrying immediately.
- JavaScript eval now reports startup failure if both isolated runtimes fail, instead of executing uncancellable code on the host thread.
- CommonJS extensions now expose computed and non-enumerable named exports while preserving `require`/import identity and reloads.
- Exa MCP calls now select matching responses after notifications, accept valid SSE framing, and preserve cancellation.
- Esc-Esc rewind, `/copy`, and `/tree`'s user-only filter now treat user-invoked skill and collab prompts as user turns: they are selectable, `←`/`→` jumps land on them, and rewinding past one restores the text you typed (with its chips) into the editor.
- `/skill:<name>` followed by a newline now invokes the skill instead of sending the draft as plain text.
- `openrouter/<vendor>/<model>@upstream` now resolves when the first-party provider bundles the same id (e.g. `google/gemini-*`), instead of failing with "model not found".
- Kept the subagent `yield` tool as a direct function call instead of mounting it through `xd://`.
- Git TUI staging now honors `.gitattributes` `text`/`eol` and clean filters, so "Stage All" no longer leaves `eol=crlf` files (e.g. `*.cmd`) dirty with no visible diff.
- Browsers spawned via `app.path` into an omp-owned profile no longer trigger the macOS "wants to use your confidential information in Safe Storage" keychain dialog.
- Reading Hugging Face file URLs (`/raw/...`, `/resolve/...`, `/blob/...`, `/tree/...`) now returns the file instead of the repo's model/dataset card.
- Directory reads no longer append a bogus `[1 results limit reached. Use limit=2 for more]` notice (`read` has no `limit`); capped child directories show only their inline `… N more` marker, and the prompt documents paging with `:N-M`/`:-N`.

## [18.1.22] - 2026-09-14

### Breaking Changes

- Hub message/job waits now always use the adaptive window (5s, lengthening to 5m across back-to-back waits); removed the `timeoutMs` argument and `async.pollWaitDuration` setting.

### Added

- Added a privacy warning to memory reports reminding users to review data for secrets before sharing
- `omp git` / `/git`: `delete` discards the selected file's changes (press twice to confirm) — in the sidebar on a file or whole directory, in the diff pane on the shown file; untracked files are removed, staged files reset to HEAD

### Changed

- Pressing `c` on a `/btw` answer now shows a green "✓ Copied to clipboard" confirmation in the panel and history detail, and BTW history accepts `Ctrl+/` to switch panes ([#12052](https://github.com/can1357/oh-my-pi/pull/12052) by [@H4vC](https://github.com/H4vC)).

### Fixed

- Automatic session titles no longer draw from canned prompt examples.
- Sessions titled by a local Ollama model (e.g. LFM2.5) no longer stay unnamed when the model's chat template spends the whole output budget on reasoning.
- `/debug` memory reports now include numeric memory statistics instead of raw heap snapshots that could expose provider and MCP credentials.
- Multi-step logins (e.g. Perplexity email → code) now move the input field under the latest prompt instead of leaving it stuck beneath the first one.
- Todo updates made through Eval's `tool.todo(...)` now persist to the session, so they survive resume/rewind/fork and no longer trigger false incomplete-todo reminders.
- Native background security scans now accept provider-owned AWS authentication for Amazon Bedrock and Bedrock Mantle without requiring a stored OAuth account ([#12013](https://github.com/can1357/oh-my-pi/issues/12013)).

## [18.1.21] - 2026-09-14

### Fixed

- Fixed Flatpak Chromium launcher executables (including `com.google.Chrome`, `org.chromium.Chromium`, and `io.github.ungoogled_software.ungoogled_chromium`) so `app.path` is treated as a browser and gets managed Chromium profile handling
- Fixed Chromium `--user-data-dir` handling by normalizing `--user-data-dir <dir>` and relative profile paths to absolute `--user-data-dir=...` values before launch
- Browser automation now works alongside an already-running Chrome using an isolated profile, keeps requested profiles separate, and never kills reused browser processes.
- First-use Chromium installation and browser operations no longer consume Eval's runtime timeout or reset its kernel while waiting.
- Browser startup reuses a successful system-Chrome fallback instead of retrying an unavailable download during the same open.
- Browser clicks and other interactions no longer stall when OMP-owned tabs are in the background, including after worker timeout recovery.

## [18.1.20] - 2026-09-13

### Added

- Added `collab.autoStart` (`off` | `view` | `control`): every local interactive session hosts itself as it starts and rotates its room on `/new`, `/resume`, fork, or branch, so a phone or dashboard can reach any running session without running `/collab` first ([#11908](https://github.com/can1357/oh-my-pi/pull/11908) by [@alphastorm](https://github.com/alphastorm) and [@sorphwer](https://github.com/sorphwer)).
- Added `omp collab list [--json]` and `/collab list` to enumerate every live local Collab host (instance, generation, session, cwd, model, participants, relay/attention state, access) without exposing links, plus `omp collab link <instanceId|pid> [--view]` to fetch one generation-bound browser URL from a private per-room Unix socket/named pipe registry; room keys, write tokens, and URLs never touch disk ([#6099](https://github.com/can1357/oh-my-pi/issues/6099); [#11908](https://github.com/can1357/oh-my-pi/pull/11908) by [@alphastorm](https://github.com/alphastorm) and [@sorphwer](https://github.com/sorphwer)).

### Changed

- Documented that native JS/TS hook factories must live in `.omp/hooks/pre/` or `.omp/hooks/post/` (not directly in `.omp/hooks/`), and cross-linked the hooks and extension-loading docs ([#11942](https://github.com/can1357/oh-my-pi/issues/11942)).

### Fixed

- The hidden notice announcing a mid-session tool-availability change now states that it lists only what changed, so an additions-only notice no longer reads as the complete tool set and the model keeps using tools that are still callable ([#11824](https://github.com/can1357/oh-my-pi/issues/11824) by [@camjac251](https://github.com/camjac251)).
- TTSR stream buffers now reset at every assistant message boundary, not only at turn start, so a `scope: text` or tool-argument rule can no longer fire on a later message because of text streamed by an earlier response in the same turn ([#11957](https://github.com/can1357/oh-my-pi/pull/11957) by [@srobroek](https://github.com/srobroek)).
- Eval `completion()` calls now use configured retry fallback chains when their role model fails ([#11989](https://github.com/can1357/oh-my-pi/issues/11989)).
- Eval `completion()` fallback chains now also apply to unqualified role models, walk into a failed fallback's own model chain, stop at `retry.maxRetries`, and resolve session-sticky credentials with the session id ([#11989](https://github.com/can1357/oh-my-pi/issues/11989)).
- Eval `completion()` fallbacks now keep depth-first chain order, inherit the failed candidate's effort for bare nested entries, and skip keyless candidates without spending `retry.maxRetries` budget ([#11989](https://github.com/can1357/oh-my-pi/issues/11989)).
- Eval `completion()` fallbacks reached at different efforts now each walk their shared descendants instead of truncating the later effort's path ([#11989](https://github.com/can1357/oh-my-pi/issues/11989)).
- Fixed ranged grep rejecting existing files with glob characters in their names ([#11977](https://github.com/can1357/oh-my-pi/issues/11977)).
- Notified Collab guests when admitted prompts are discarded, including room retirement during a session change ([#11908](https://github.com/can1357/oh-my-pi/pull/11908) by [@alphastorm](https://github.com/alphastorm)).
- Preserved pending Collab dialog answers across session-switch rollback without accepting them after commit, stop, or writer departure ([#11908](https://github.com/can1357/oh-my-pi/pull/11908) by [@alphastorm](https://github.com/alphastorm)).
- Fixed prompts awaiting setup crossing a fork, branch, or tree-navigation commit, multi-question extension dialogs moving later questions to a replacement Collab room, and stale rooms blocking `/collab` or `/join` after a failed session change ([#11908](https://github.com/can1357/oh-my-pi/pull/11908) by [@alphastorm](https://github.com/alphastorm)).
- Fixed background task cards missing their final completion or failure after an early result or live-session focus replay.
- Ranged reads on Windows no longer intermittently open the selector-suffixed path when filesystem probes return transient errors ([#11284](https://github.com/can1357/oh-my-pi/issues/11284)).

## [18.1.19] - 2026-09-12

- Fixed `--mode json` returning exit 0 on a turn-fatal provider/auth/network error ([#11498](https://github.com/can1357/oh-my-pi/issues/11498)).

### Added

- Added default-off speculative execution for validated local reads, including reads projected from nested JavaScript and Python eval cells.
- `/usage` now shows prepaid credit balances (e.g. Charm Hyper's `100 credits left`) on the provider cards and account summaries instead of `no data` ([#11656](https://github.com/can1357/oh-my-pi/pull/11656) by [@oldschoola](https://github.com/oldschoola)).
- Retry fallback chains now support per-model reasoning efforts: a fallback entry may carry an explicit thinking suffix (`"default": ["openai/gpt-5-mini:low"]`), and pressing `t` on a fallback row in `/models` sets or clears it. Bare entries keep inheriting the failing turn's effort. ([#11842](https://github.com/can1357/oh-my-pi/pull/11842) by [@H4vC](https://github.com/H4vC)).
- Added `task.agentServiceTierOverrides` for sparse exact-name service-tier overrides on task/eval agents, so selected agents can use priority/Fast mode without accelerating every subagent ([#9668](https://github.com/can1357/oh-my-pi/pull/9668) by [@alphastorm](https://github.com/alphastorm)).
- Added session-local `/btw` history with persistent answers and follow-ups; bare `/btw` reopens history, Escape cancels running answers before closing, and new questions no longer replace an in-progress answer.
- Added `f follow up` in BTW history to continue a selected side conversation with an English input prompt, persistent multi-turn history, and no changes to the main conversation.
- Completed inline BTW answers now support `f follow up` directly; history uses `Tab` for pane navigation and `Enter` or `f` to start a follow-up.
- Codex web search now accepts valid email-only OAuth credentials without requiring or fabricating a `ChatGPT-Account-Id` header ([#11847](https://github.com/can1357/oh-my-pi/pull/11847) by [@nguyennguyenit](https://github.com/nguyennguyenit)).
- Sessions now stay alive when their working directory is removed instead of crashing while preparing shell tools ([#11828](https://github.com/can1357/oh-my-pi/issues/11828)).
- MCP tool calls spelled with the Claude Code doubled separator (`mcp__server__tool`) now reach their registered tool ([#11516](https://github.com/can1357/oh-my-pi/issues/11516) by [@oldschoola](https://github.com/oldschoola)).
- MCP HTTP reconnects now release obsolete tool generations instead of growing session memory on every reconnect ([#11784](https://github.com/can1357/oh-my-pi/issues/11784)).
- `/debug` memory reports now keep large heap snapshots out of JavaScript strings and reject empty snapshots instead of saving zero-byte files ([#11785](https://github.com/can1357/oh-my-pi/issues/11785)).
- Sloppy-mode edits now drop a copied `[N more lines in ...]` read notice the same way they already drop the other read-metadata rows, so a pasted projection can no longer leak into the matched pattern or the written text ([#11797](https://github.com/can1357/oh-my-pi/pull/11797) by [@vasyza](https://github.com/vasyza)).
- `/usage` now honors a provider's configured `baseUrl` when checking credentials before any model has been discovered, so a proxy-scoped API key is no longer sent to the provider's canonical host ([#11656](https://github.com/can1357/oh-my-pi/pull/11656) by [@oldschoola](https://github.com/oldschoola)).

### Fixed

- Fixed automatic custom-tool loading trying to execute package metadata and declarative files, including metadata shadowing an executable tool with the same name ([#11864](https://github.com/can1357/oh-my-pi/pull/11864) by [@moodiness](https://github.com/moodiness)).
- Fixed successful Python kernel shutdowns being reported as unconfirmed and leaving spawned child processes running ([#11865](https://github.com/can1357/oh-my-pi/pull/11865) by [@moodiness](https://github.com/moodiness)).
- Fixed completed tool cards reverting to pending after refocusing live sessions, and tool output collapsing behind finished reasoning segments ([#11868](https://github.com/can1357/oh-my-pi/pull/11868) by [@serverinspector](https://github.com/serverinspector)).
- Invalid `WATCHDOG.yml` entries now produce startup/editor warnings while healthy advisors remain available ([#11882](https://github.com/can1357/oh-my-pi/pull/11882) by [@olegpulatov](https://github.com/olegpulatov)).
- Claude Code session imports now preserve typed user text stored alongside tool results ([#11854](https://github.com/can1357/oh-my-pi/issues/11854)).
- Extension commands now settle BTW writes before creating, switching, or branching sessions, preventing side requests from outliving their source session ([#11335](https://github.com/can1357/oh-my-pi/pull/11335) by [@Ant39140](https://github.com/Ant39140)).
- Session selection and active-session deletion now settle BTW writes before switching or removing history, preventing stale saves from blocking the next session ([#11335](https://github.com/can1357/oh-my-pi/pull/11335) by [@Ant39140](https://github.com/Ant39140)).
- Escape now cancels BTW follow-ups that are still waiting for startup writes, without launching a model request ([#11335](https://github.com/can1357/oh-my-pi/pull/11335) by [@Ant39140](https://github.com/Ant39140)).
- BTW history now rejects out-of-range timestamps instead of failing during display ([#11335](https://github.com/can1357/oh-my-pi/pull/11335) by [@Ant39140](https://github.com/Ant39140)).
- BTW follow-ups now preserve separate user/assistant messages and reuse an isolated topic-specific provider session for prompt caching; cancellation or failure starts a fresh transport generation.
- Restored Escape cancellation for running BTW answers and removed the separate `x` shortcut; cancelled output stays visible, and closing another history entry returns to any still-running BTW panel instead of hiding it.
- BTW history now rejects stale cross-process writes and protects running topics with an OS-backed lease, preventing one instance from erasing another instance's follow-ups.
- Copying a BTW topic now falls back to its most recent nonempty answer after an empty failed or cancelled follow-up.
- Invalid or cancelled `/move` operations no longer cancel BTW requests; busy side conversations block relocation, and stalled history writes stop session operations with a bounded error instead of hanging indefinitely.
- Session shutdown now shows closing progress before waiting for live commands or BTW history writes, and stops progress updates when cleanup completes or fails.
- Failed BTW terminal saves now block session operations while retaining the answer for copying and safe retry, instead of being treated as a successful flush.
- Standalone `!cd` now shares the BTW relocation guard with `/move` and `/wt`, refusing before shell execution when a side conversation is active or unsaved.
- `/wt` now checks BTW migration availability before creating a branch or checkout, preventing unused worktrees when a side conversation is busy.
- `/move` now checks BTW migration availability before confirming or creating a missing target directory, preventing leftover directories after a refused move.
- BTW errors now shorten embedded home paths and sanitize control characters and oversized text before display, while retaining original diagnostic errors.
- Speculative reads now open the authorized resolved target while rendering the requested path, so enabling speculation no longer changes read output for symlinks; video targets are declined at authorization ([#11892](https://github.com/can1357/oh-my-pi/pull/11892) by [@h4vc](https://github.com/h4vc)).
- JavaScript speculation now verifies the retained tool-bridge dispatcher and string-coercion intrinsic identities before projecting reads ([#11892](https://github.com/can1357/oh-my-pi/pull/11892) by [@h4vc](https://github.com/h4vc)).
- Speculative eval sessions are now discarded at reconciliation when a hook or transform appends source the stream never verified, instead of releasing reads planned from the original code ([#11892](https://github.com/can1357/oh-my-pi/pull/11892) by [@h4vc](https://github.com/h4vc)).
- Speculative reads now classify format and rendering by the requested path while opening the resolved target, so symlinks with a different extension read exactly like ordinary reads ([#11892](https://github.com/can1357/oh-my-pi/pull/11892) by [@h4vc](https://github.com/h4vc)).
- JavaScript speculation now validates coercion intrinsics used by `String()` and `.join()` inputs, not just template and `+` operands ([#11892](https://github.com/can1357/oh-my-pi/pull/11892) by [@h4vc](https://github.com/h4vc)).
- Speculative reads now infer the summary language from the requested path while reading the resolved target, so cross-language symlinks summarize exactly like ordinary reads (by [@h4vc](https://github.com/h4vc)).
- The structural summary cache now keys on the parser language path, so one file read through different extensions no longer reuses a stale summary (by [@h4vc](https://github.com/h4vc)).
- Fixed the Windows installer failing on Windows PowerShell 5.1: OS architecture detection no longer depends on the .NET `RuntimeInformation` type that only resolves reliably on PowerShell 7, and the script now requires PowerShell 5.1+ with a clear upgrade message instead of failing cryptically ([#11905](https://github.com/can1357/oh-my-pi/pull/11905) by [@h4vc](https://github.com/h4vc)).
- Speculative reads now infer the summary language from the requested path while reading the resolved target, so cross-language symlinks summarize exactly like ordinary reads ([#11892](https://github.com/can1357/oh-my-pi/pull/11892) by [@h4vc](https://github.com/h4vc)).
- The structural summary cache now keys on the parser language path, so one file read through different extensions no longer reuses a stale summary ([#11892](https://github.com/can1357/oh-my-pi/pull/11892) by [@h4vc](https://github.com/h4vc)).

## [18.1.18] - 2026-09-11

### Added

- Enable `tui.mouse` to focus live subagent cards and jump-list rows by clicking them, with a hover highlight on the target; native selection becomes Shift+drag while on ([#11737](https://github.com/can1357/oh-my-pi/pull/11737) by [@H4vC](https://github.com/H4vC)).
- The pinned `Subagents` block now lists every live agent, collapsed to a few rows with a click expander by default; `display.pinnedAgents` switches it to `full` or `off` ([#11737](https://github.com/can1357/oh-my-pi/pull/11737) by [@H4vC](https://github.com/H4vC)).
- The `remote` compaction method now covers Claude: Anthropic server-side compaction (`compact-2026-01-12` beta) runs behind the existing `compaction.methodOrder` / `compaction.remoteEnabled` gates for first-party Anthropic models, persists its plain-text summary with a native replay payload that later Anthropic turns send back as a `compaction` block, and falls through to the next configured method on failure like OpenAI server compaction.

### Changed

- The `providers.cacheRetention` `auto` setting now keeps Anthropic OAuth subscriber sessions on 1h prompt-cache retention and API keys on 5m, instead of 5m for both ([#11667](https://github.com/can1357/oh-my-pi/pull/11667) by [@camjac251](https://github.com/camjac251)).

### Fixed

- Provider-native compaction (OpenAI Responses compact, Anthropic server-side compaction) re-issues the system prompt the live turn actually sent — a per-turn `before_agent_start` override included — instead of the rebuilt base prompt, and advisor compaction sends the advisor's own prompt instead of the generic summarizer prompt, so the request reads the live request's cached prefix.
- The `set_steering_mode`, `set_follow_up_mode`, and `set_interrupt_mode` RPC commands are now session-scoped, so a short-lived RPC client no longer silently writes queue-mode fields to the machine-global `config.yml`. The setters still persist by default, so the settings panel and existing callers are unaffected ([#11555](https://github.com/can1357/oh-my-pi/issues/11555)).
- Hand-authored `*.openapi.json` files can now be edited without disabling generated-file protection globally ([#11674](https://github.com/can1357/oh-my-pi/issues/11674)).
- `models.yml` now validates the per-model `compat.stripImageInput` opt-out, so a wrong-typed value is rejected like every other declared compat key instead of being silently accepted ([#11697](https://github.com/can1357/oh-my-pi/issues/11697)).
- `/mcp reload` now distinguishes servers still connecting after the bounded reload window instead of reporting a healthy asynchronous reload as zero active servers ([#11639](https://github.com/can1357/oh-my-pi/issues/11639)).
- Fixed isolated tasks dropping nested-repo work: nested diffs persist as `<agent>.nested-*.patch` before cleanup, `apply=false` lists each file, isolated agents report as non-resumable, and runs needing manual recovery report failed ([#11343](https://github.com/can1357/oh-my-pi/pull/11343) by [@grapexy](https://github.com/grapexy)).
- Fixed the Windows PowerShell installer (`install.ps1`) aborting on Windows PowerShell 5.1 when bun or git wrote normal progress to stderr: native commands now run with `$ErrorActionPreference` scoped to `Continue` and success is gated on the process exit code, so `$ErrorActionPreference = "Stop"`'s stderr-as-terminating-error behavior no longer kills the install ([#11675](https://github.com/can1357/oh-my-pi/issues/11675)).
- Eval cell timeouts no longer fatally terminate the session when a browser tab worker is being recycled ([#11707](https://github.com/can1357/oh-my-pi/issues/11707)).
- Models whose images are stripped on the wire (`compat.stripImageInput`) now trigger the `describeForTextModels` vision fallback and are skipped when resolving the vision model, instead of silently dropping images ([#9697](https://github.com/can1357/oh-my-pi/issues/9697)).
- Hiding tool activity (its shortcut or `display.hideToolActivity` in `/settings`) now replays native history, so blocks already retired to the terminal hide on the same keypress instead of waiting for another display toggle ([#11734](https://github.com/can1357/oh-my-pi/pull/11734) by [@notnotype](https://github.com/notnotype)).
- `#readProjectSettings` now logs capability warnings when a project `.claude/settings.json` fails to parse, instead of silently dropping them ([#11570](https://github.com/can1357/oh-my-pi/issues/11570)).
- A malformed project `.claude/settings.json` now produces a warning instead of being silently ignored ([#11570](https://github.com/can1357/oh-my-pi/issues/11570)).
- Reduced memory usage during long responses while thinking is hidden ([#11632](https://github.com/can1357/oh-my-pi/pull/11632) by [@redsolver](https://github.com/redsolver)).

## [18.1.17] - 2026-09-10

### Added

- Unsent prompts cleared with Ctrl+C can now be recalled with Up, including pastes and images; disable Recall Cleared Drafts in settings to discard future clears instead ([#11524](https://github.com/can1357/oh-my-pi/pull/11524) by [@camjac251](https://github.com/camjac251)).
- Added `tui.vimMode`, an opt-in modal editing layer for the prompt, off by default ([#3299](https://github.com/can1357/oh-my-pi/issues/3299)). Escape leaves Insert; Normal mode has `hjkl`, `0`, `^`, `$`, `w`, `b`, `e`, `gg`, `G`, count prefixes, `x`/`D`/`C`, `dd`/`yy`, `p`/`P` and `u`; `v`/`V` start a Visual selection that `y` copies and `d` deletes.
- Added a `vim` status-line segment showing the current Vim mode (`NORMAL`/`INSERT`/`VISUAL`/`V-LINE`), the half-typed command beside it (Vim's `showcmd`, e.g. `2d`), and the Visual selection height (`V-LINE 4L`). Included in every built-in preset and hidden entirely unless `tui.vimMode` is on; `custom` preset users can add `"vim"` to `statusLine.leftSegments`.
- The cursor now changes shape with the Vim mode: block in Normal/Visual, thin/underline in Insert. Applies to the software cursor, and to the real terminal cursor (DECSCUSR) when `PI_HARDWARE_CURSOR` is set.
- Added the `tui.vimModeDisplay` setting (`text` / `icon` / `none`) controlling how the Vim mode appears in the status line: the full mode name, a single glyph per mode, or nothing. Shown in `/settings` only while Vim mode is on.
- Added `icon.vimNormal`, `icon.vimInsert`, `icon.vimVisual`, and `icon.vimVisualLine` symbols, so the Vim mode icons follow the active symbol preset like every other status-line icon — Nerd Font (fa-square / fa-pencil / fa-eye / fa-bars), Unicode (`■` `▎` `◉` `≡`), or ascii (`N`/`I`/`V`/`L`) — and can be overridden per theme via the `symbols` map.
- Added peak `↑` / off-peak `↓` indicators to the cost display for models with scheduled pricing (DeepSeek), refreshed automatically when the tariff changes.
- Added plan autosave: enable `plan.autosave` to automatically save approved plans to `<project>/.omp/plans/` when plan mode completes (customize with `plan.autosaveDir`, which accepts `~`, absolute, and cwd-relative paths) ([#11599](https://github.com/can1357/oh-my-pi/pull/11599) by [@H4vC](https://github.com/H4vC)).

### Changed

- Toggling `tui.vimMode` or `tui.vimModeDisplay` in `/settings` now takes effect immediately instead of requiring a restart; the editor, prompt border, status-line segment, and cursor shape all switch in place.
- The prompt border now colors Insert mode too (green), instead of falling through to the session accent. Normal and Visual were already colored, so Insert was the one mode the border could not distinguish — on themes whose accent matches the session accent it was indistinguishable from Normal. Borders outside Vim mode are unchanged.

### Fixed

- Marketplace plugins that share a repository root now load only their declared skills instead of every skill in the repository ([#11513](https://github.com/can1357/oh-my-pi/issues/11513)).
- Fixed collab host UI requests raised before a writable guest joins being lost; up to 64 pending asks now replay only to writable guests, and already-aborted asks no longer consume request IDs ([#9031](https://github.com/can1357/oh-my-pi/pull/9031) by [@alphastorm](https://github.com/alphastorm)).
- Collab hosts now acknowledge a writable guest's `ui-response` for an already-settled request with a targeted `ui-request-end`, so a guest that reconnected after the broadcast and resent its answer no longer waits forever ([#11561](https://github.com/can1357/oh-my-pi/pull/11561) by [@alphastorm](https://github.com/alphastorm)).
- Streaming edit guard (`edit.streamingAbort`) no longer aborts on no-op preview results when replacement content produces no file changes, and carries the native patch diagnostic through the abort reason on genuine preview failures.
- Repeated soft compaction now includes messages retained by the previous pass instead of silently dropping them from model context.
- Fixed the ask dialog splattering option descriptions and previews one word per row when a model injects `\r` runs into tool-call string values (observed with GLM via OpenRouter); stray carriage returns are now sanitized in ask params, the live dialog, and ask transcript rendering ([#11167](https://github.com/can1357/oh-my-pi/pull/11167) by [@Giardi77](https://github.com/Giardi77)).
- `omp models` now reports whether a model's images actually reach the provider, so an id stripped by a text-only catalog rule no longer shows `images: yes` ([#9697](https://github.com/can1357/oh-my-pi/issues/9697)).
- Custom `Other` answers are now applied before the Ask dialog becomes interactive again, so the next Enter is no longer discarded ([#11558](https://github.com/can1357/oh-my-pi/pull/11558) by [@schickling-assistant](https://github.com/schickling-assistant)).
- Explicit per-model price overrides retain their configured flat rates instead of inheriting time-based pricing.
- Fixed wrong-typed `compat.stripImageInput` in `models.yml` being silently accepted, so the documented vision opt-out is now validated like its neighbours ([#11697](https://github.com/can1357/oh-my-pi/issues/11697)).

## [18.1.16] - 2026-09-09

### Added

- `/rename` without a title now generates a session name from recent conversation using the configured tiny model.
- Added opt-in experimental notes-backed context windows with persistent branch-local notes, searchable original session history, retained latest user requests, and a model-callable rollover tool, including in Code Mode.
- The `/resume` picker (Ctrl+L when bound to `app.session.resume`) marks the live session with a `current` label on its metadata line and focuses that row on open. ([#11381](https://github.com/can1357/oh-my-pi/pull/11381) by [@tkossak](https://github.com/tkossak))
- `/loop` accepts `--until '<cmd>'` / `--while '<cmd>'` to gate each iteration on a shell command's exit status, so a loop can stop on real project state instead of only a count or duration. ([#10858](https://github.com/can1357/oh-my-pi/pull/10858) by [@andyhite](https://github.com/andyhite))

### Fixed

- Fixed automatic recovery from proxied Python HTTP/2 stream resets and HTTP/1.1 chunked response interruptions, including continuation after completed tool calls ([#11160](https://github.com/can1357/oh-my-pi/pull/11160) by [@cyriusweng](https://github.com/cyriusweng)).
- Read error and preview rendering now sanitizes tabs and Windows-style CRLF (e.g. ssh host-key failures, tab-indented fetched content) so raw output can no longer tear the result frame.
- Unset `tiny` model roles now honor the configured `@smol` fallback in direct execution and the `/models` Roles view ([#11311](https://github.com/can1357/oh-my-pi/issues/11311)).
- Extension Control Center (`/extensions`) search now accepts `j` and `k`, so extensions like `jira`/`json` are searchable; bare `j`/`k` no longer move the list selection (use arrow keys or the configured `tui.select.up`/`down`) ([#11350](https://github.com/can1357/oh-my-pi/issues/11350)).
- Codex turns interrupted before terminal completion now auto-continue after resolved tool calls instead of stopping ([#11349](https://github.com/can1357/oh-my-pi/issues/11349)).
- Fixed the status line's `pi` brand/working segment double-padding the first separator, so every gap around a separator is a single space ([#11103](https://github.com/can1357/oh-my-pi/issues/11103)).
- `/handoff` no longer leaves the TUI in a running state when completion races with delayed session events ([#11263](https://github.com/can1357/oh-my-pi/issues/11263)).
- Fixed legacy Pi extensions failing to load when calling `ctx.isProjectTrusted()` in an event handler; the extension context now exposes it (always `true`, since OMP applies no project-trust gating) ([#7955](https://github.com/can1357/oh-my-pi/issues/7955)).
- Fixed Ctrl+Z jobs exiting successfully after `fg` instead of restarting the TUI because terminal teardown left Bun without a referenced event-loop handle while waiting for `SIGCONT` ([#8585](https://github.com/can1357/oh-my-pi/issues/8585)).
- Extensions loaded by the npm CLI now apply settings overrides to the active session, so generated agents and model choices remain isolated between sessions ([#11047](https://github.com/can1357/oh-my-pi/pull/11047) by [@mgpai22](https://github.com/mgpai22)).
- Live task dispatch now reloads added, changed, removed, and deleted project task and retry settings before resolving subagents ([#11191](https://github.com/can1357/oh-my-pi/issues/11191)).
- Reset `/loop` iterations combined with `--while` / `--until` no longer keep submitting without resetting when vibe mode is enabled while the condition command is still running; the loop now disables itself instead ([#10858](https://github.com/can1357/oh-my-pi/pull/10858)).
- Returning from a focused agent (Agent Hub) now re-renders the main session's queued steering/follow-up block instead of leaving it blank until the next repaint ([#11379](https://github.com/can1357/oh-my-pi/issues/11379)).

## [18.1.15] - 2026-09-08

### Added

- Added the `retry.waitForUsageReset` setting: when a provider reports usage-limit exhaustion with a reset time (5-hour or weekly quota windows on any provider), the session sleeps until the reset instead of failing fast past `retry.maxDelayMs`.
- Added `advisor.maxNotesPerUpdate` setting and `WATCHDOG.yml` configuration (default `4`): allows reasoning verifiers to batch findings in a single review update without being rate-limited.
- Headless browser tabs now freeze when a turn settles so idle animated/WebGL pages stop burning CPU/GPU, resuming automatically on next use; tabs idle past `browser.idleCloseSec` (default 30 minutes) are closed. `persist: true` on `browser.open` opts a tab out of both ([#8246](https://github.com/can1357/oh-my-pi/issues/8246) by [@H4vC](https://github.com/H4vC)).

### Changed

- When enabled (`task.showResolvedModelBadge`), subagent model badges show the thinking-level icon, model name, and attached-advisor eye before the agent name in task, eval, job, and HUD rows.

### Fixed

- Task descriptions containing tabs no longer misalign or overflow task rows; tabs are expanded before measuring and rendering.
- GitHub Copilot model-policy 403s (plan, model policy, org restriction) no longer delete stored credentials, so the provider stays listed in `/model` after a per-model access denial instead of disappearing until the next `/login` ([#11280](https://github.com/can1357/oh-my-pi/pull/11280) by [@H4vC](https://github.com/H4vC)).
- Bash results no longer replace a failing command's output with the shell minimizer's lossy summary when the original capture cannot be persisted as an artifact; the raw diagnostics are kept so a failure stays actionable ([#11081](https://github.com/can1357/oh-my-pi/issues/11081)).
- Fixed worker subprocesses failing to declare themselves as worker hosts before dispatching selectors, which prevented nested thread worker spawns during `/usage` stats sync on multi-core systems.
- Fixed `/usage` displaying a misleading generic database read failure when activity loading fails; the error detail is now sanitized, collapsed to a single line with shortened paths, and surfaced in the dashboard.
- Advisor notes now report rate limiting accurately, blockers always interrupt even after a lower-severity note in the same update, and deferred notes flush when the primary run completes, including after advisor quota exhaustion ([#11062](https://github.com/can1357/oh-my-pi/issues/11062)).
- Fixed the built-in clangd registration omitting CUDA source and header files (`.cu` and `.cuh`) ([#10782](https://github.com/can1357/oh-my-pi/pull/10782) by [@alphastorm](https://github.com/alphastorm)).
- Fixed `ast_grep` skipping CUDA headers and ignoring an explicit `lang` override for ambiguous file extensions ([#10782](https://github.com/can1357/oh-my-pi/pull/10782) by [@alphastorm](https://github.com/alphastorm)).
- Python cells are no longer replayed automatically after a kernel crash, preventing duplicate side effects; the next call starts a fresh kernel.
- Session rewrites preserve open-reader snapshots and replacement identity when a rename needs an EPERM fallback.
- Fixed WorkPool children retaining a stale Gemini-formatted `yield` declaration when pooled items were installed or cleared.
- Preserve effective context and output limits when model overrides change unrelated settings, such as thinking effort levels.

## [18.1.14] - 2026-09-07

### Fixed

- `omp update` now refuses to overwrite shebang scripts or non-OMP executables behind foreign symlinks and reports the physical binary path it verified ([#11152](https://github.com/can1357/oh-my-pi/issues/11152)).
- The startup update notice counts every change in a release: bullets written above a `###` heading now count under `Other`, and `+`/`*` markers and lightly indented bullets count like `-`.
- Fixed Codex Astra retaining its larger window after disabling Extended Context, including cached models; explicit model overrides still take precedence.
- Fixed explicit Codex context-window overrides widening past the server-honored maximum; they now clamp to the documented ceiling like upstream Codex ([#11157](https://github.com/can1357/oh-my-pi/pull/11157) by [@H4vC](https://github.com/H4vC)).
- Fixed Astra's extended window over-advertising input by 128K; it now uses the documented 922K input cap inside the 1.05M total context ([#11157](https://github.com/can1357/oh-my-pi/pull/11157) by [@H4vC](https://github.com/H4vC)).
- Bills Astra API requests above 272K input at the documented 2x input / 1.5x output long-context tier; the Codex subscription route stays exempt with free cache writes ([#11157](https://github.com/can1357/oh-my-pi/pull/11157) by [@H4vC](https://github.com/H4vC)).
- Fixed Extended Context silently enabling without a settings source (SDK embedding, early boot); it now matches the off default until opted in ([#11157](https://github.com/can1357/oh-my-pi/pull/11157) by [@H4vC](https://github.com/H4vC)).
- Fixed `/copy` link captions showing Markdown delimiters for formatted labels and splitting across two rows for multiline labels ([#11086](https://github.com/can1357/oh-my-pi/pull/11086) by [@mustafaabidali](https://github.com/mustafaabidali)).
- Fixed Ask custom answers requiring another submission after paste or remaining on the same multi-select question; pending clipboard text is preserved before submission, and single-question multi-select answers still go through review ([#11099](https://github.com/can1357/oh-my-pi/pull/11099) by [@camjac251](https://github.com/camjac251)).
- The startup update notice no longer counts standalone `* * *` and `- - -` separator lines as changes.
- Fixed `/loop` replacing the repeating prompt with a mid-turn interjection; steering while the agent runs is now one-off, and only an idle submission becomes the new loop body ([#11159](https://github.com/can1357/oh-my-pi/pull/11159) by [@H4vC](https://github.com/H4vC)).
- Fixed `--plugin-dir` and omp-installed plugin agents no longer being discovered when the foreign `claude-plugins` source is disabled; user-scope plugin agent roots are now gated by origin like their skills ([#11151](https://github.com/can1357/oh-my-pi/issues/11151)).

## [18.1.13] - 2026-09-07

### Fixed

- Fixed GPT-6 Astra requiring `/extended-context` for its full context window: it now keeps the documented 1.05M-token window with the setting on or off, and explicit per-model `contextWindow` overrides still win.

## [18.1.12] - 2026-09-06

- Fixed edit and write results to report the formatted bytes actually committed by LSP writethrough.

### Added

- Added `/prewalk restart` to return an active session to its `@default` model and re-arm the one-shot handoff to `@smol`.

### Changed

- Ranged reads of text without bracket characters skip unnecessary lexical context scanning.
- Muse Code sessions send a compact hashline edit description (~3 KB less per request); all other models keep the full prompt.
- Transcript usage row now shows the prompt-to-yield time as a bare delta, keeping the clock icon for time to first token only.

### Fixed

	- Fixed GPT-6 Astra extended-context support and preserved maximum context windows reported by OpenAI Codex discovery ([#10980](https://github.com/can1357/oh-my-pi/pull/10980) by [@H4vC](https://github.com/H4vC)).
- Subagent `yield` no longer rejects a valid `data` payload because a non-strict OpenAI-compatible backend filled the optional `error` field with `""`; previously the worker retried the identical call until the invalid-yield cap and the parent received nothing.
- Fixed fullscreen `/copy` outlining only a lazily created grouped Read card, so Enter copies the assistant yield instead of tool output.
- `memory://` now resolves against the session that issued it: a caller's own memory backend answers `memory://<id>`, so co-located sessions no longer read each other's memory rows, and a caller whose session is no longer live fails closed instead of being answered by a peer. Prompt completion binds to the same caller, so `memory://<memory-id>` stays on offer while a subagent shares the working directory. Advisors retain their owning session's memory access even without a session file.
- Fullscreen `/copy` now opens on the recent tail of the branch instead of replaying the whole session, so it appears immediately and steps without lag on long sessions (`a` loads the earlier turns). Both it and the esc-esc rewind selector also cache each transcript row set instead of re-stripping it every frame.
- Fixed the fullscreen `/copy` and esc-esc rewind selectors repainting the whole frame for a wheel notch that cannot move the viewport; because both open scrolled to the newest turn, wheeling down there made the frame twitch.
- The default `omp commit` agent now uses its displayed COMMIT model and honors `--model` instead of silently running on SMOL ([#10991](https://github.com/can1357/oh-my-pi/issues/10991)).
- Fixed JavaScript `eval` `completion()`/`agent()` handles so the documented immediate-handle pattern works: `h.wait()`, `h.status()`, and the other handle methods now work on the un-awaited factory result ([#10986](https://github.com/can1357/oh-my-pi/issues/10986)).
- Fixed frame skips while streaming long markdown Write previews ([#10955](https://github.com/can1357/oh-my-pi/issues/10955)).
- LiteLLM discovery no longer caches an empty catalog after a timed-out run: a rich-metadata timeout now falls back to `/v1/models`, and a discovery failure with no prior catalog leaves the cache untouched so the next launch retries immediately instead of hiding discovery-only models ([#10964](https://github.com/can1357/oh-my-pi/issues/10964)).
- Searching `free` in the model picker now finds every zero-cost model, not just the ones with `free` in their id.

## [18.1.11] - 2026-09-05

### Added

- Added the `retry.waitForUsageReset` setting: when a provider reports usage-limit exhaustion with a reset time (5-hour or weekly quota windows on any provider), the session sleeps until the reset instead of failing fast past `retry.maxDelayMs`.
- Added opt-in `bash.allowCompoundCommands` approval for conservative literal `&&` chains, with ordered per-segment rules and normal bash policy fallback for unmatched segments. The opt-in requires a positively classified POSIX-quoting shell; incompatible and unknown shells retain legacy approval. Whole-chain denies take precedence over earlier prompts.

### Fixed

- Idle compaction now starts or reschedules when its enabled state, threshold, or delay changes while a session is already idle ([#10242](https://github.com/can1357/oh-my-pi/issues/10242)).
- Fixed `todo` and other tools called through eval rejecting optional `None`/`null` arguments that direct tool calls accept.
- Report oversized selected lines that cannot fit after read context, with a working raw recovery selector instead of a looping continuation hint ([#10775](https://github.com/can1357/oh-my-pi/issues/10775)).
- Approved plan content is now inlined into approve-and-execute prompts instead of forcing the executor to re-read the durable plan file ([#10923](https://github.com/can1357/oh-my-pi/issues/10923)).
- Fixed WorkPool child sessions crashing during startup while constructing their incremental `yield` tool schema.
- Commit summaries written in Vietnamese, Korean, and other accented scripts are no longer rejected for exceeding the length limit, and keep their accents as typed.
- Tool-scoped TTSR rules now match finalized arguments reliably when providers stream short or throttled tool calls ([#10910](https://github.com/can1357/oh-my-pi/issues/10910)).
- Restored `getSupportedThinkingLevels` in the legacy `pi-ai` shim so extensions importing it from `@earendil-works/pi-ai` (e.g. `@companion-ai/feynman`) pass Bun's named-export check and load ([#10800](https://github.com/can1357/oh-my-pi/issues/10800)).

## [18.1.10] - 2026-09-04

### Changed

- Subagent `yield` now takes `data`/`error` directly instead of nesting them under a `result` wrapper.

### Fixed

- Fixed Codex V2 remote compaction rebuilding the request prefix differently from normal turns, restoring prompt-cache reuse ([#10786](https://github.com/can1357/oh-my-pi/issues/10786)).
- Restored mouse clicks, hover, and wheel scrolling in Plan Review.

## [18.1.9] - 2026-09-04

### Breaking Changes

- Browser and computer automation now use JavaScript/Python evaluation preludes with reusable tab and element handles, replacing the previous standalone tool schemas and object-shaped run APIs.
- Replaced the `inspect_image` tool and `/vision` controls with `read <image>?q=<question>` for image questions; text-only models now receive image metadata and guidance for using this selector.
- Renamed `inspect_image.timeoutMs` to `images.questionTimeoutMs`; existing settings are migrated automatically.

### Added

- Bash now extracts Kitty and Sixel terminal graphics as image results for foreground, failed, manual, and background executions.
- Markdown links to existing local files and resources are now clickable while preserving their displayed URLs.
- Added `/switch <model>` for session-only model changes, with the same model selectors and completions supported by `--model`; ACP `/model <model>` accepts these selectors as well.
- Added the `worktree.cleanSource` setting to reset and clean the original checkout when creating a worktree with `/wt`.
- Expanded the computer JavaScript/Python evaluation prelude with direct desktop, window, screenshot, accessibility, and element interaction helpers, while keeping `computer.run` available for multi-step scripts.

### Changed

- Agent delegation is now model-aware, allowing some models to favor focused inline work instead of spawning subagents.

### Fixed

- Fixed fallback authorization-code prompts remaining active after native OAuth callback completion.
- Fixed reciprocal idle subagents repeatedly waking one another indefinitely.
- Fixed `/wt` and `git worktree add` failing when the new worktree targeted the same commit as the clean source checkout.
- Fixed omp-installed marketplace plugins and `--plugin-dir` plugins losing their skills when the Claude plugin source was not separately enabled ([#10743](https://github.com/can1357/oh-my-pi/issues/10743)).
- Fixed session accent colors rendering as bright white in terminals without truecolor support, including Terminal.app ([#10759](https://github.com/can1357/oh-my-pi/issues/10759)).
- Rules with `enabled: false` frontmatter are now omitted during discovery, matching disabled skills ([#10769](https://github.com/can1357/oh-my-pi/issues/10769)).
- Fixed large MCP tool-result previews losing the relevant tail content when an oversized output line preceded it ([#10761](https://github.com/can1357/oh-my-pi/issues/10761)).
- Fixed `Ctrl+V` replacing CJK characters with `?` when pasting from XWayland clipboard owners on Wayland ([#10762](https://github.com/can1357/oh-my-pi/issues/10762)).
- Fixed byte-limited artifact reads reporting the displayed byte count instead of the actual read limit ([#10764](https://github.com/can1357/oh-my-pi/issues/10764)).
- Fixed read-tool truncation notices incorrectly reporting zero delivered lines or bytes when previewing a partial oversized line ([#10768](https://github.com/can1357/oh-my-pi/issues/10768)).
- Fixed Mnemopi removing explicitly retained or learned long-term memory after sessions longer than 24 hours by consolidating eligible working memory at session start ([#10770](https://github.com/can1357/oh-my-pi/issues/10770)).

### Removed

- Removed the librarian agent.

## [18.1.8] - 2026-09-03

### Fixed

- Improved background task results with structured output schemas: parsed results are now available through the `agent://<id>` resource, while large or invalid inline JSON is replaced with a reliable pointer to the complete result.
- Background task artifacts are retained long enough for follow-up turns to read them, including failed tasks that lack valid structured output, and are cleaned up without blocking shutdown or leaking resources.
- Fixed context compaction incorrectly accepting archived history that was larger because of opaque reasoning data, allowing the next compaction strategy to run instead.
- Fixed the Model Hub sidebar jumping to the top when provider refreshes rebuild the list; the focused model, or its nearest remaining entry, is now preserved.
- Fixed the `inspect_image` status hint showing the wrong model after switching between image-capable model roles.
- Fixed multi-minute TUI freezes during subagent activity and batch execution.

## [18.1.7] - 2026-09-03

### Breaking Changes

- Removed the Ruby and Julia eval backends and related interpreter configuration; eval now supports Python and JavaScript only.
- Removed the eval parallel() and pipeline() helpers. agent() and completion() now return handles immediately, and wait(handles) provides synchronization.
- Python eval tool calls are now asynchronous coroutines, matching JavaScript; use await tool.read({...}) and similar calls.

### Added

- Added asynchronous eval agent and completion handles with status, cancellation, messaging, waiting, and automatic result delivery for unwaited background work.
- Added eval workpools for queueing items onto the least context-loaded keep-alive subagent with configurable concurrency; the pool name is its async-job ID for `hub wait`, `.peek()` gives a non-consuming snapshot, per-item `{key, data|error}` yields finish batches incrementally, and `eval.workpool.freshAgents` opts into a new agent per item.
- Added support for defining eval tools in Python with @tool or JavaScript with tool(fn, schema), and exposing them to subagents through task, agent, and workpool calls. Configure availability with eval.tools.enabled.
- Added native Windows ARM64 binaries with architecture-aware installation and updates.
- Added an MLX backend for running local tiny models on Apple silicon. Configure providers.tinyModelDevice=mlx, or use PI_TINY_DEVICE=mlx or metal, to run title generation, memory tasks, and automatic thinking classification with MLX models, with an ONNX CPU fallback when Python is unavailable.
- Added Qwen3 1.7B as a local memory and thinking-classification model for the MLX backend.

### Changed

- Local tiny models for titles, memory, and automatic thinking classification now share on-demand workers across omp processes, reducing redundant resource usage; workers stop automatically after inactivity.
- PI_TINY_DEVICE=metal now selects the MLX backend on macOS.
- Updated agent reactions to trigger on the opening emoji instead of requiring a newline, consuming any following whitespace.

### Fixed

- Fixed transient provider retries incorrectly failing with an “Agent is already processing” error.
- Fixed user-scope marketplace plugins installed through omp losing their skills when the Claude plugin source was not separately enabled.
- Fixed hashline edits failing when targets included apply_patch markers, while rejecting ambiguous bracketed targets instead of editing the wrong path.
- Fixed bracketed hashline edit targets being reported as undefined to extension path allowlists.
- Fixed MCP tools discovered during startup disappearing after plan-mode approval or when leaving default-on plan mode.
- Fixed ACP clients receiving invalid file locations or updates for released terminals, preventing invalid worktree scans and terminal errors on Windows.

## [18.1.6] - 2026-09-03

### Breaking Changes

- Replaced the local session-title model choices with LFM2.5 230M, LFM2.5 350M, and Falcon H1 Tiny 90M.
- Reserved main and sub as built-in subagent definition names; custom agents can no longer use these names.

### Added

- Added agent reactions: a reply that opens with a lone emoji line shows the emoji as a badge on your message bubble instead of in the text; toggle the prompt invitation with the tui.reactions setting.
- Added video attachment and reading support through ffmpeg, including preview grids with metadata and timestamp/frame selectors such as :412 and :1h5m42s.
- Enhanced the model picker with intelligence indicators, catalog TPS estimates, provider-aware ranking, and provider-supplied badges and descriptions.
- Added detailed, non-summarized findings for scout agents through the report definition field, and subagent result relay so read-only agents can return data to their originating agent.
- Added agent-scoped rules using an agents frontmatter field with glob matching, including support for inspecting applicable rules with omp ttsr list and omp ttsr test --agent.
- Added non-interrupting extension messages through deliverAs: "aside" for pi.sendMessage and pi.sendUserMessage.
- Added copy and open controls for rendered blocks and links, including /copy link and the /open command.
- Added option-click cursor positioning in the prompt entry box.
- Added the configurable opencode display layout, with a corresponding first-run and upgrade setup option.
- Added the skillful prompt setting and /skillful command to control whether available skills are listed in the system prompt.
- Added Firecrawl as an optional providers.fetch backend for URL reading, configurable with FIRECRAWL_API_KEY and FIRECRAWL_BASE_URL.
- Added provider request metadata configuration for usage and cost attribution, including Amazon Bedrock request headers and User-Agent customization.
- Added the :-N read selector for reading the last N lines from files, directories, archives, artifacts, internal URLs, and web URLs, including combinations such as :raw:-60.
- Added an opt-in extension status-line segment for displaying custom statuses inline.
- Added injectV1: false to openai-models-list discovery for OpenAI-compatible gateways whose model endpoint is rooted at a versioned URL.
- Added provider-reported credits and routed-model counts to /session statistics.
- Added CLINE_API_KEY to the CLI environment help for native ClinePass subscription inference.
- Expanded Devin model selectors to support native CLI aliases, dotted upstream names, and dynamic effort-route identifiers.
- Standalone CLAUDE.md files in the project root and ancestor directories are now loaded as project context alongside AGENTS.md files.

### Changed

- Session history is now sorted by modification time, then creation time, then file path.
- Increased the maximum file snapshot size to 4 MB.
- Edit tools now provide streamed diff previews while applying changes.
- Approved plan content is included directly in agent history, reducing redundant reads.
- power.sleepPrevention now works on Linux and Windows. Its idle default keeps long-running sessions awake on those platforms; set it to off to restore the previous behavior.
- Unsupported-model errors no longer include incorrect retry instructions.

### Fixed

- Fixed local title models receiving unsupported online examples and failing with certain tokenizer templates.
- Fixed model picker search selection so it moves to the best matching result after results change.
- Fixed /new sometimes reviving the previous conversation in the current process or after a restart.
- Fixed raw text escaping in agent responses.
- Fixed structured subagent result previews being truncated incorrectly.
- Fixed /usage taking several seconds to become responsive on large statistics databases.
- Fixed the status line not appearing correctly in the first startup frame.
- Fixed shell builtins reporting broken-pipe errors when downstream commands exit early.
- Fixed provider-qualified model roles with dotted revisions resolving to the wrong provider or model.
- Fixed agent-scoped rules being lost when subagents are restored, and fixed rule:// URLs and rule inspection to consistently use the calling agent's applicable rules.
- Fixed extension and user asides being stranded, delivered to the wrong session, or incorrectly interrupting or restarting turns during session changes and image processing.
- Fixed parent steering messages arriving during a subagent's final result from preventing that result from being committed.
- Fixed messages typed while an edit or write tool was streaming from discarding the completed tool call and triggering unnecessary regeneration.
- Fixed self-hosted Firecrawl URLs with origin-only base URLs from gaining an extra slash.
- Fixed omp commit auto-staging from including macOS Unicode-normalization duplicates or files ignored by nested .gitignore rules.

## [18.1.5] - 2026-09-03

### Added

- Added Abliteration provider support to `/login`, including `ABLITERATION_API_KEY` configuration and help text.
- Added clone-first Git worktree support that carries over ignored build artifacts when creating worktrees, with a configurable `worktree.clone` setting and fallback to a standard checkout. This is supported by `github pr_checkout`, `omp worktree add`, and `git worktree add` commands entered through the Bash tool.
- Added the `omp worktree add` command with Git-compatible branch, detach, path, and commit options.
- Added `/wt` (alias `/worktree`) to create a linked worktree with uncommitted changes and move the current session into it while leaving the original checkout untouched.

### Changed

- Foreign user-level configuration sources (`~/.cursor`, `~/.codex`, `~/.claude`, `~/.gemini`, `~/.config/opencode`, `~/.codeium/windsurf`) are now opt-in via `enabledProviders`, while project-level configurations in CWD and `.agents` continue to load by default.
- Split subagent isolation configuration into `task.isolation.enabled` and `isolation.backend`; existing `task.isolation.mode` settings are migrated automatically.
- Updated the built-in `smol` and `slow` model priority chains to favor newer recommended models and remove older model generations.
- Improved unsupported-model error messages by removing retry guidance that does not apply.

### Fixed

- Fixed automatic title generation so `--no-title` also prevents todo-initialization title refreshes, while automatic titles retain the selected OAuth account without sharing foreground request identity.
- Fixed provider errors so they wrap to the terminal width and remain readable in the transcript and pinned error banner, with long messages available through the expansion hint.
- Fixed Gemini malformed function-call turns so textual tool-call output is rejected conversationally and the session can continue instead of stopping with a pinned error.
- Fixed auto-compaction recovery getting stuck in repeated retries when models return empty length-limited responses; it now stops with an actionable error.
- Fixed MCP servers failing to reconnect after transient startup handshake timeouts.
- Fixed programs supervised by `hub start` hanging when querying terminal capabilities.
- Fixed large pastes followed immediately by Enter so the input is submitted with the pasted content instead of being left in the large-paste menu.

### Removed

- Removed the bundled `designer` subagent and `designer` model role; `modelRoles.designer` and `@designer` are no longer built in.

## [18.1.3] - 2026-09-02

### Changed

- The `doubleEscapeAction` setting now accepts `tree`, so double-Escape can open the session tree instead of the rewind selector.
- Updated the visual representation for the IRC tool from "irc" to "#"
- Rewinding to a user message (double-Escape, `/branch`) now branches within the current session — the old path stays reachable in `/tree` — instead of forking a child session; `/rewind` is an alias for `/branch` ([#10565](https://github.com/can1357/oh-my-pi/pull/10565) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).

### Fixed

- Active sessions now keep memory proportional to truncated raw SSE and tool outputs instead of retaining complete oversized backing strings ([#10547](https://github.com/can1357/oh-my-pi/issues/10547)).
- Anthropic sessions now keep tool-roster changes and warm-prefix pruning from invalidating preserved thinking or the prompt cache.
- TypeScript code intelligence now works on TypeScript 7 projects: the built-in `typescript-native` server runs `tsc --lsp --stdio` when the resolved TypeScript install no longer ships `tsserver.js`, replacing `typescript-language-server` for that project.
- Claude marketplace MCP servers now resolve environment placeholders in stdio environment values instead of passing strings such as `${NAME:-}` literally ([#10481](https://github.com/can1357/oh-my-pi/pull/10481) by [@mrexodia](https://github.com/mrexodia)).
- Fixed prewalk conflicting with `todo.eager=always`: the forced eager-todo prelude ("call todo first this turn") was injected alongside the prewalk plan nudge ("write a complete plan first, then todo"), giving the model contradictory instructions; the eager-todo prelude is now suppressed only when prewalk will perform a handoff ([#10510](https://github.com/can1357/oh-my-pi/issues/10510)).
- Fixed `authHeader: true` + command-backed `apiKey` discovery providers (no explicit `headers:` block) resending a stale bearer after a 401 force-refresh; discovered models now re-derive `Authorization` from the live `apiKey` each request ([#10551](https://github.com/can1357/oh-my-pi/issues/10551)).
- Fixed the embedded shell's `command -v`/`-V` honoring only the first operand: it now iterates every name like bash/zsh, printing one line per resolved name and skipping misses ([#10544](https://github.com/can1357/oh-my-pi/issues/10544)).
- Fixed hard-killed subagents vanishing from the agent registry under concurrent fan-out: `AgentLifecycleManager.release` now applies the terminal `aborted` transition before awaiting the tombstone sidecar write, closing a race where the dying session's own dispose-path unregister deleted the ref instead of leaving it as a tombstone ([#10531](https://github.com/can1357/oh-my-pi/issues/10531)).
- `omp commit` now keeps extension-provided model credentials available in its nested commit-agent session ([#10528](https://github.com/can1357/oh-my-pi/issues/10528)).
- MCP tool results now surface `structuredContent`: servers that return their payload in the structured channel while keeping `content` a terse ack (e.g. rhizome-mcp) are no longer data-less to the model ([#10522](https://github.com/can1357/oh-my-pi/issues/10522)).
- Fixed the Agent Hub roster shuffling erratically while open: rows no longer re-sort on every agent heartbeat, so the list stays stable and navigable with many active agents ([#10524](https://github.com/can1357/oh-my-pi/issues/10524)).
- Exiting Vibe mode now removes its restrictions from subsequent model turns, including restored sessions ([#10500](https://github.com/can1357/oh-my-pi/issues/10500)).
- Fixed all-sessions listing (`Tab` in session picker) and cross-project resume failing when sessions are stored under `XDG_DATA_HOME`; `listAllSessions` now scans the active `getSessionsDir()` root instead of hardcoding `~/.omp/agent/sessions`.
- Fixed the Nerd Font context icon showing a Windows logo instead of a generic window ([#10476](https://github.com/can1357/oh-my-pi/pull/10476) by [@erickmazer](https://github.com/erickmazer)).
- The debug terminal snapshot now reports Herdr (and CMUX) as the multiplexer wrapping the session, matching the TUI's pane-identity detection instead of only tmux/screen/zellij.
- Fixed vibe mode becoming un-exitable after branching a session (including via `/btw`), which previously failed with "Vibe parent session changed before mode exit could be persisted." ([#10468](https://github.com/can1357/oh-my-pi/issues/10468)).
- Fixed HTML session exports reordering interleaved assistant text, thinking, images, and tool calls in the transcript, and split matching text/tool sidebar rows with block-accurate navigation. ([#10253](https://github.com/can1357/oh-my-pi/pull/10253) by [@realcoderandom](https://github.com/realcoderandom))
- Fixed the built-in `grep` and `sed` treating a basic regular expression as an extended one: a bare `+` is now the literal and `\+` the operator, patterns like `^+` or `s/^\+/` no longer match every line, `^` anchors inside `\(…\)` and after `\|`, and a repetition operator with nothing to repeat is reported instead of silently selecting the whole file ([#10298](https://github.com/can1357/oh-my-pi/pull/10298) by [@mruangutai](https://github.com/mruangutai)).
- Fixed RPC `prompt` responses for `/skill:*` commands arriving only after the entire prompt-dispatch pipeline finished (usage preflight, compaction, provider calls): under provider stress that outlasts any client prompt timeout, so hosts reported the prompt as rejected while the turn was in fact running. The skill branch now builds the skill prompt eagerly (preserving the immediate error for an unreadable skill file) and dispatches the expensive pipeline asynchronously after answering, matching plain prompts; when the dispatch is cancelled before a turn starts (e.g. an abort overtakes usage preflight), the session now reports it through the non-invoked  completion frame instead of leaving hosts waiting for an  that never comes ([#10249](https://github.com/can1357/oh-my-pi/pull/10249) by [@cwr250](https://github.com/cwr250)).
- Fixed stale `omp-plugins.lock.json` entries loading leftover `node_modules` trees for plugins no longer declared in an existing `package.json` — the orphaned copy double-loaded its extensions. Lockfile-only plugins remain supported for manifest-less roots and symlinked packages (`omp plugin link`, marketplace runtime packages); stale entries are skipped with a warning.

## [18.1.2] - 2026-09-01

### Added

- Recover stray <SM:EDIT> payloads emitted as plain text into real edit tool calls, with support for disabling this behavior through the edit.recoverInlineEdits setting.
- Advisors now receive context from the active memory backend, including project decisions and recalled instructions; advisors also gain the recall tool when supported by the backend.

### Changed

- Replaced the sloppy edit format's symbolic markers with a clearer XML-based format using <SM:EDIT>, <SM:FIND>, and <SM:PUT> tags. Edit errors now include copy-ready XML payloads.
- Increased the default input delay for the trace CLI to 3 seconds.

### Fixed

- Improved chat history stability in long-running sessions by avoiding unnecessary updates when date or directory context changes.
- Fixed the trace CLI hanging during proxy connections and added support for forward HTTP proxies.
- Fixed newly started sessions using stale model context-window limits after background model discovery completes; the active model now refreshes automatically so context usage and compaction thresholds match the model catalog.

## [18.1.1] - 2026-09-01

### Fixed

- Fixed a native crash (and multi-gigabyte committed-memory growth held until exit) when git status ran over worktrees with tens of thousands of untracked files: whole-worktree porcelain status now runs through the git CLI with bounded output capture, falling back to the in-process gitoxide walk only when git is not installed, and any panic escaping a native VCS operation now surfaces as a structured `VcsError` instead of a process-level failure.

## [18.1.0] - 2026-09-01

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
- Reworked `/usage` into a fullscreen dashboard overlay (no transcript output): a compact per-provider subscriptions grid with untouched providers collapsed into one line, a GitHub-style daily activity heatmap fed by local stats, and the classic full report one keypress away.
- Reworked transcript navigation with a fullscreen rewind selector opened by double-Escape, supporting rendered-item navigation, user-turn jumps, branching rewinds, and alternate session-tree branch selection.
- Updated `/copy` to use the fullscreen transcript selector, allowing users to copy a turn or navigate into nested content such as code, quotes, commands, and tool output.

### Fixed

- Improved edit-tool error guidance for operations missing the `»` separator, identifying redundant context-only operations
- Fixed OAuth provider `modifyModels` projections being silently dropped after a discovery refresh introduced live-config headers.
- Edit-tool `＋`/`－` line operations now match their anchors leniently across whitespace drift (indentation, blank-line miscounts) instead of failing with a byte-for-byte error; a note reports the lenient match.
- Fixed an edit-tool REWRITE consisting only of `＋` add lines silently replacing (deleting) the matched text; it now inserts after the kept MATCH.
- Edit-tool no-match errors now name MATCH lines that exist nowhere in the file and suggest marking them with `＋`, and errors without a located region no longer append a misleading file-head "closest match" preview.
- Fixed ordinary CLI startup eagerly loading the computer worker graph (native desktop addon and early environment), restoring lazy startup and profile `.env` ordering.
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
- Fixed idle compaction discarding context while the session was still waiting on a backgrounded async job ([#10223](https://github.com/can1357/oh-my-pi/pull/10223) by [@mattwilkinsonn](https://github.com/mattwilkinsonn)).
- Fixed LSP idle timeout clobbering in multi-workspace sessions and unmanaged timer spawning on pure config reads ([#10237](https://github.com/can1357/oh-my-pi/pull/10237) by [@harshaygadekar](https://github.com/harshaygadekar)).

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
- Added nonblocking shared model-catalog refresh with cached startup hydration and source freshness diagnostics, allowing newly published models for known providers to appear without a binary release.
- Added `omp usage clients` to report per-client token usage recorded by the auth broker, including the machine and application responsible for usage by provider. Supports `--days` and `--json` output.

### Changed

- Enforce a 5-minute timeout and 8 MiB output limit for GitHub CLI operations
- Apply a 30-minute timeout for marketplace plugin repository cloning
- Improve large file handling with blob streaming and explicit truncation support
- Improved `omp git` responsiveness by streaming file contents, rendering complete lines promptly, progressively applying syntax highlighting, and deferring large commit statistics until after the first interactive frame.
- Expanded `omp git` navigation and editing shortcuts: refresh with `r`, stage or unstage files and directories with `s`, `u`, or `space`, navigate hunks and files with keyboard shortcuts, use Vim-style motions in both panes, select diff views with `1`–`4`, and open the commit form with `c`.
- Standardized completed edit results across edit modes with hashline-style paths and numbered previews.
- Documented browser relay behavior more clearly, including that `browser.relay` can enable relay access independently of `app.relay` and that a relayed session operates in the user's logged-in browser.
- Clarified the computer tool documentation: `desktop.window()` must be awaited, and `win.ax()` returns a textual accessibility-tree snapshot rather than a structured node list.

### Fixed

- Fixed the VCS status line counting every file inside an untracked directory instead of collapsing it to one entry like `git status`.
- Fixed git TUI sidebar wheel scrolling snapping back to the selected row after staging or collapsing entries; the list now follows the selection only when it actually changes.
- Fixed `inspect_image` selecting a text-only vision/default role when an image-capable model was available on the active provider.
- Improved unexpected-stop recovery for reasoning-only stalls by requiring the next concrete tool action instead of repeated analysis.
- The edit tool now repairs a stray closing marker typed in place of the divider in a selection (`old⟫new` inside one selection instead of `old│new`) and applies the intended replacement with a note, instead of failing with an unmatched-marker error.
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

Older entries are archived in [packages/coding-agent/CHANGELOG.md@d95ba9ea5e83](https://github.com/can1357/oh-my-pi/blob/d95ba9ea5e8370e1cc0e7fc83cef7c7db862b543/packages/coding-agent/CHANGELOG.md).
