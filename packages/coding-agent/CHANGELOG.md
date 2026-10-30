# Changelog

## [Unreleased]

### Added

- Added queueable compaction: `/compact` sent with the follow-up key (Ctrl+Q) while the agent works now runs when it yields instead of interrupting it ([#17397](https://github.com/can1357/oh-my-pi/pull/17397) by [@H4vC](https://github.com/H4vC))

### Fixed

- Startup prewalk now arms a later fallback candidate of the role named by prewalk.into when its first candidate is unavailable, matching /prewalk and /new ([#17373](https://github.com/can1357/oh-my-pi/pull/17373)).

## [18.14.0] - 2026-10-29

### Breaking Changes

- Custom tool loaders now resolve the injected host SDK themselves; constructors take cwd as their first argument instead of a pi namespace.
- WebMCP now uses Chrome's native WebMCP support through WebMcpController, which accepts a Puppeteer Page. The former page-hook installation helpers, bridge constant, and page-hook types have been removed; Tern tabs no longer support WebMCP.
- Provider-qualified model selectors in --model, settings, roles, and task agents must identify an exact model ID or alias. Near matches now fail with a helpful error and suggestions instead of silently selecting a sibling model. Bare selectors such as opus retain fuzzy matching, and the Google Vertex Claude alias remains supported. Older migrated web fallback chains replace the retired Codex entry with openai-codex/gpt-5.6-sol.

### Added

- Agents can send an interim response without ending the current task by writing Markdown to out:// (or using > out:// in bash), with streaming output up to 64 KiB. This is enabled by default in the interactive TUI and can be configured with out.enabled; it is disabled by default in print, RPC, and ACP sessions.
- Added computer-tool approval modes: tools.approval["computer.control"] can allow unattended foreground control on dedicated machines or deny the request without prompting. The approval mode does not itself grant access.
- Added optional task-file input (task.file=true), allowing subagent instructions to be loaded from an absolute UTF-8 file path or local:// URL with the submitted path and SHA-256 recorded ([#17133](https://github.com/can1357/oh-my-pi/pull/17133) by [@iliaal](https://github.com/iliaal)).
- Sessions can be pinned or unpinned from the resume picker with Alt+K and Alt+Shift+K, or the remappable app.session.pin and app.session.unpin actions. Pinned sessions move to the top and take priority in search results ([#9837](https://github.com/can1357/oh-my-pi/pull/9837) by [@zhang17-24](https://github.com/zhang17-24)).
- Added PI_LINK_SCHEME and optional PI_LINK_HOST, allowing file links from SSH or tmux sessions to open through a desktop protocol handler ([#15855](https://github.com/can1357/oh-my-pi/pull/15855) by [@KunoLu](https://github.com/KunoLu)).
- Extensions and RPC clients can start live voice sessions using their own WebRTC peer, including phone-browser clients, through ctx.startLive({ sdpOffer }) or live_connect ([#17013](https://github.com/can1357/oh-my-pi/pull/17013) by [@materemias](https://github.com/materemias)).
- Extensions can customize assistant-text rendering and rerender individual replies through the opt-in extensionRenderers.assistantText setting ([#16238](https://github.com/can1357/oh-my-pi/pull/16238) by [@materemias](https://github.com/materemias)), and can register interactive link schemes with extension callbacks and renderer fallbacks ([#16239](https://github.com/can1357/oh-my-pi/pull/16239) by [@materemias](https://github.com/materemias)).
- /debug reports now include session-logs.txt containing all log records written by the reporting session and its subagents for the current day.
- Added prewalk.from and prewalk.into settings to choose the planning model and handoff target (default @default → @smol); /prewalk [into] and /prewalk restart [from] [into] override them for one command ([#17373](https://github.com/can1357/oh-my-pi/pull/17373) by [@H4vC](https://github.com/H4vC)).

### Changed

- Improved startup responsiveness by deferring nonessential UI, accessibility, browser, provider, slash-command, and interactive-composer loading until needed, and by overlapping independent session preparation work.
- OpenAI live steering is now disabled by default for GPT models. Typed messages wait for the next tool boundary unless providers.openaiLiveSteering is enabled, avoiding unsupported in-flight message errors.
- HTML exports now match the /stats visual design with a higher-contrast light theme, timeline and full-trace views, and navigation for nested subagents and advisors. Packaged viewers use integrity-pinned shared assets and require network access; source checkouts continue to embed the viewer.
- tui.autoGraph now defaults to auto: charts are refined by the judge for supported native TypeSafe judge models and otherwise use the built-in estimate.
- Filesystem changes are detected automatically, so manual scan-cache invalidation after edits is no longer needed.
- Model refreshes use substantially less CPU by reusing unchanged models and avoiding repeated model-cache database opens.
- Overlapping sloppy-edit operations are now applied sequentially, with each operation matched against the result of the preceding operation.
- PI_INTENT_PROMPT and PI_INTENT_DESC can now customize the system guidance and tool-schema description for the i intent field.
- Printed JSON values in eval, including large Python dictionaries and lists, are displayed as collapsible JSON trees.
- Codex and Claude rate-limit reset warnings now appear once per reset across conversations and windows, only during the final six hours; the status line continues to show the countdown.
- The . and c continue shortcuts now simply answer an unanswered last message instead of adding a hidden continue directive.
- With bash.gitGuard enabled, checkout, switch, restore, reset, and stash operations run safely in linked worktrees, while discarded uncommitted changes are preserved for recovery.
- Sessions with computer use enabled receive the desktop guide before the first computer call.
- The Tern interface now presents warnings, errors, update notices, file reads, and completed background work consistently with chat messages.
- Muted live voice sessions remain visibly muted while the voice model starts work.

### Fixed

- Fixed live configuration reloads missing edits immediately after a symlink switches to another file in the same directory.
- Fixed auth-gateway model routing after catalog refreshes so bare model IDs select the highest-priority credentialed provider, with wire-format compatibility used as a tie-breaker.
- Fixed chart recommendations that incorrectly inferred whether higher or lower values were better from row or column names; smart charting now uses the judge and avoids charting unsuitable numeric text such as page or step numbers.
- Fixed binary data flowing through background Bash pipelines being displayed as corrupted text or counted as huge line output.
- Fixed browser-tab closing delays when reattaching after a worker exits.
- Fixed startup warnings being obscured by the Tern interface; they now appear as normal in-app warnings.
- Fixed todo init clearing existing flat items when list was empty.
- Fixed legacy extensions using detached event handlers failing to load.
- Fixed MCP tools connected during vibe mode being activated prematurely and exceeding provider tool limits.
- Fixed Bash services rejecting port 0 when a log readiness condition was also provided.
- Fixed context usage and automatic compaction overstating token usage for inline tool descriptors.
- Fixed terminal titles not being restored after exit on terminals without title-stack support, including Windows consoles.
- Fixed cached approval directory grants that did not cover every target in a request.
- Fixed text typed during startup being delayed until startup completed, including resumed drafts.
- Fixed pull-request metadata and diffs remaining stale after a successful git push.
- Fixed live voice playback clicks when audio stalls mid-word.
- Fixed read rejecting artifact URLs from truncation hints under cached approvals or restricted folders.
- Fixed peer task acknowledgements being mistaken for final answers, so wait continues until the peer replies.
- Failed Hindsight memory recalls and retention operations now produce visible warnings instead of silently continuing without memory.
- Fixed long conflict-path handling, conflict-content selectors, and stale conflict IDs after aborted merges or external file changes.
- Fixed cancelled MCP OAuth flows and authentication lookups from crashing the session.
- Fixed progress HUD entries for idle local-model workers that were no longer used.
- Improved LSP diagnostics reliability across cold starts, push-diagnostics servers, save-only servers, retries, multi-server and multi-file edits, and reopened files; incomplete results are no longer reported as clean, and repeated clangd checks are faster.
- Fixed live job widgets showing incidental text from files, web pages, or search results instead of the actual job status.
- Fixed repeatedly failing advisor batches being retried indefinitely; they are now dropped after three failures.
- Fixed thinking overrides on prefix-bound Claude models from losing their provider prefix behavior during compaction and retries.
- Fixed failed large-value JSON queries from displaying the rejected value instead of a useful error.
- Fixed F5 retry reporting no retry when a background result arrived after cancellation or interruption.
- Fixed WebMCP invocation errors being empty and timed-out page invocations continuing to run.
- Fixed HTTP 413 errors for Factory Droid GPT and Grok after computer-use sessions by removing obsolete screenshots from requests.
- Fixed unavailable configured default or dictation models being silently replaced; omp now warns and identifies the fallback model.
- Fixed LSP references for files in sibling Git worktrees by adding those checkouts to the active workspace.
- Improved macOS computer-use behavior for applications without windows by opening the app and inspecting its returned window in one operation.

## [18.13.3] - 2026-10-28

### Added

- Manual compactions (RPC `compact`, `/compact`, extension `ctx.compact()`) emit `manual_compaction_start` and `manual_compaction_end` session events, so RPC hosts can show compaction progress; `docs/rpc.md` documents these with the other progress events (`retry_fallback_applied`, `ttsr_triggered`, `goal_updated`) ([#17247](https://github.com/can1357/oh-my-pi/pull/17247) by [@Quelaan1](https://github.com/Quelaan1))
- Added `retry.rateLimitWalksChain` (default `false`): with it on, a 429 rate limit after a turn with signed Claude thinking moves to the next model in `retry.fallbackChains` at once instead of retrying the throttled model until `retry.maxRetries` is spent ([#17232](https://github.com/can1357/oh-my-pi/pull/17232) by [@sjawhar](https://github.com/sjawhar))
- Sessions can be renamed from the resume picker: the new title persists as a user title without loading the session, and renames of live sessions are refused instead of forking the transcript ([#17262](https://github.com/can1357/oh-my-pi/pull/17262) by [@Twilight0](https://github.com/Twilight0))
- Added `display.advisorCollapsedLines` (Settings → Appearance → Display) to cap how many note lines a collapsed advisor card shows; the default keeps the full preview ([#17228](https://github.com/can1357/oh-my-pi/pull/17228) by [@bluecapone](https://github.com/bluecapone))
- `omp config list --scope global|project` lists only the keys that layer sets, with the values as written: path-scoped `enabledModels`, `enabledProviders` and `disabledProviders` entries (`{ path, … }`) stay unresolved, so a host can edit the global value without dropping them ([#17246](https://github.com/can1357/oh-my-pi/pull/17246) by [@Quelaan1](https://github.com/Quelaan1))
- `tools.xdevNotices: false` hides the `xd://: mounted …` notices shown as MCP servers connect, without turning on `startup.quiet` ([#17263](https://github.com/can1357/oh-my-pi/pull/17263) by [@MaisonnatM](https://github.com/MaisonnatM))

### Changed

- Updated Bun engine requirement to ≥1.4.4

### Fixed

- A running job's glance keeps the whole a meter counts instead of the bare numerator: a widget whose headline restated `140` beside a `140/190` bar now draws `140/190` in the job card, the HUD pill and the status line ([#17226](https://github.com/can1357/oh-my-pi/pull/17226) by [@iacore](https://github.com/iacore))
- Fixed the managed-skills root guard rejecting a symlinked store outright; a root that resolves to a directory now accepts writes inside its target, while a broken link or a link to a non-directory is still refused ([#17201](https://github.com/can1357/oh-my-pi/pull/17201) by [@iacore](https://github.com/iacore))
- Fixed experimental context rollover repeatedly running during tool calls when the fixed prompt and tool schemas already exceed the recovery band ([#17205](https://github.com/can1357/oh-my-pi/issues/17205))
- Fixed Ctrl+D during deferred extension startup falsely reporting an extension exit error and exiting 1 instead of closing cleanly ([#17259](https://github.com/can1357/oh-my-pi/issues/17259)).
- Resuming a session, or reviving a parked or restored subagent, after a prewalk or plan-yolo handoff continues on the model and effort the handoff switched to instead of falling back to the planning model ([#17229](https://github.com/can1357/oh-my-pi/pull/17229) by [@shgew](https://github.com/shgew))
- Fixed one interrupt silently stopping a session from ever waking on its own background job results again: an interrupt (Esc, the RPC `abort` command, an ACP cancel, a collab guest stop, an extension's `ctx.abort()`) that stops no run and no queued work no longer suppresses those wakes, and after an interrupt that did stop a run they come back once a later turn has run and ended. Esc on the "waiting on background jobs" row still ends that wait: its results land in context for your next prompt, as before ([#17243](https://github.com/can1357/oh-my-pi/pull/17243) by [@sjawhar](https://github.com/sjawhar))
- Fixed `!` commands on zsh/fish waiting forever at interactive prompts (e.g. the Oh My Zsh update question on `!code .`); keystrokes now go to the running command while it runs, and Esc still cancels ([#17210](https://github.com/can1357/oh-my-pi/issues/17210))
- Fixed auto-compaction firing early on OpenAI-compatible chat-completions models that don't replay past reasoning ([#15797](https://github.com/can1357/oh-my-pi/issues/15797), [#17231](https://github.com/can1357/oh-my-pi/pull/17231) by [@ghisguth](https://github.com/ghisguth))
- Eval's `tool.<name>(…)` now accepts `xd://<name>` and the Claude Code `mcp__<server>__<tool>` spelling like direct tool calls, and reports registered but unavailable tools instead of "Unknown tool" ([#17250](https://github.com/can1357/oh-my-pi/issues/17250))
- Updated the `ask` prompt to encourage assistants to show missing decision context before the dialog opens ([#17242](https://github.com/can1357/oh-my-pi/pull/17242) by [@jasonharrison](https://github.com/jasonharrison))
- Custom LiteLLM providers now refresh cached model rosters after paginated `/v2/model/info` discovery was fixed; cached first-page-only lists no longer hide later-page models ([#17237](https://github.com/can1357/oh-my-pi/pull/17237) by [@maykonmichel](https://github.com/maykonmichel)).
- Fixed hosted search repeating the same request when the active model is also its search target but uses a cloned or refitted model object ([#17202](https://github.com/can1357/oh-my-pi/pull/17202) by [@mateo-bolanos](https://github.com/mateo-bolanos)).
- Fixed a killed or failed inline browser tab worker keeping its connection to the browser relay, which left Chrome's "started debugging this browser" bar on every tab until the omp session exited ([#17212](https://github.com/can1357/oh-my-pi/pull/17212) by [@nickzitzer](https://github.com/nickzitzer))
- Fixed a live tool card dropping the model's `i` intent, which the harness strips from the args `tool_execution_start` carries; the card now keeps it, so a bash call in Tern shows its description instead of a bare "Bash" as it already did in a resumed session ([#17197](https://github.com/can1357/oh-my-pi/pull/17197) by [@iacore](https://github.com/iacore))
- RPC sessions now report settled (`isSettled: true`, `session_settled`) after a turn whose failed `todo` call queued a reminder for the next prompt, instead of appearing busy until another prompt arrives ([#17238](https://github.com/can1357/oh-my-pi/pull/17238) by [@kmccleary3301](https://github.com/kmccleary3301))
- `/annotate` keeps notes and an unfinished note when the overlay is closed without sending them: reopening the same source restores them, **Saved draft** resumes any of the session's drafts, and **Discard notes and close** drops one ([#17271](https://github.com/can1357/oh-my-pi/pull/17271) by [@H4vC](https://github.com/H4vC), based on [#17230](https://github.com/can1357/oh-my-pi/pull/17230) by [@Shadorain](https://github.com/Shadorain)).
- Annotation feedback names each note's source line, so notes on blank or repeated lines stay distinguishable ([#17271](https://github.com/can1357/oh-my-pi/pull/17271) by [@H4vC](https://github.com/H4vC), based on [#17230](https://github.com/can1357/oh-my-pi/pull/17230) by [@Shadorain](https://github.com/Shadorain)).
- Fixed `/tan` clones ending without a final answer when they call `ask`; the clone now keeps running and the parent receives its final answer instead of an empty result ([#17223](https://github.com/can1357/oh-my-pi/pull/17223) by [@trukhinyuri](https://github.com/trukhinyuri))
- Pasting in a terminal with enhanced paste (Tern, kitty) now lands in the open dialog's field — the agents hub's New agent description, an /annotate note — instead of the hidden prompt
- Pasting or dropping an image file into the prompt in a terminal with enhanced paste (Tern, kitty) now attaches the image instead of typing its path
- The plan review's edit button in Tern names your editor ("Edit in Notepad", "Edit in nvim") instead of "Edit in $EDITOR"
- Fixed `/tan` clones ending without a final answer when they call `ask`; the clone now keeps running and the parent receives its final answer instead of an empty result ([#17223](https://github.com/can1357/oh-my-pi/pull/17223) by [@trukhinyuri](https://github.com/trukhinyuri))
- Fixed GitHub `/review` diff links keeping the snapshot that built the request after the cached diff refreshes in the background, instead of opening whatever file now sits at the same index ([#16310](https://github.com/can1357/oh-my-pi/pull/16310) by [@tkossak](https://github.com/tkossak))

## [18.13.2] - 2026-10-27

### Added

- Extensions in the interactive TUI can read and directly switch plan, vibe, goal, and loop modes with `ctx.sessionModes` and observe changes with the `mode_changed` event, without submitting slash commands; `extensionHandlers.modeControl: false` turns off extension-driven mode changes ([#15753](https://github.com/can1357/oh-my-pi/pull/15753) by [@Shadorain](https://github.com/Shadorain))
- RPC hosts can capture draft-only speech-to-text with live previews when speech input is enabled, without submitting an agent turn; slow flushes have adjustable deadlines, and failed transcription does not block a session change after capture closes ([#17158](https://github.com/can1357/oh-my-pi/pull/17158) by [@felipe-santos-aya](https://github.com/felipe-santos-aya)).
- Added `discovery.advertisedReasoning` to let a custom provider opt out of the reasoning ladder its `/v1/models` rows advertise (default `true`); `discovery: proxy` now reads that ladder, its `none` off-switch, and an explicit `reasoning: false` instead of building every model's thinking surface from the bundled catalog reference alone ([#15255](https://github.com/can1357/oh-my-pi/issues/15255), [#17077](https://github.com/can1357/oh-my-pi/pull/17077) by [@Youwenqwq](https://github.com/Youwenqwq))
- `WATCHDOG.yml` advisor entries now accept `scope` (`main`, `subagent`, or `all`, default `all`) to attach an advisor only to the top-level session or only to advised subagents, and `includeReasoning: false` to omit primary assistant `_thinking:_` blocks from advisor review deltas ([#17058](https://github.com/can1357/oh-my-pi/pull/17058) by [@trukhinyuri](https://github.com/trukhinyuri))
- Added `session.worktreeScope` to keep the resume picker scoped to one directory ([#17061](https://github.com/can1357/oh-my-pi/pull/17061) by [@Dante-dan](https://github.com/Dante-dan)).
- LM Studio decision models can now serve the `judge` role (`modelRoles.judge: lm-studio/<model>`); they answer over LM Studio's `/v1/decisions` endpoint instead of being offered as chat models ([#17169](https://github.com/can1357/oh-my-pi/pull/17169) by [@richiestanaway](https://github.com/richiestanaway))
- Extensions' `getAllTools()` now reports `mcpServerName`, `mcpToolName` and `mcpReadOnlyHint` for MCP-backed tools, so an extension can tell read-only connector tools from ones that change things ([#17120](https://github.com/can1357/oh-my-pi/pull/17120) by [@cfpperche](https://github.com/cfpperche))
- RPC: `navigate_tree` (move the leaf in the same session file, optionally summarizing the abandoned branch), `abort_branch_summary` and `set_label`, with matching `RpcClient` methods ([#17138](https://github.com/can1357/oh-my-pi/pull/17138) by [@andrebrait](https://github.com/andrebrait))
- RPC: delta `message_update` frames (`messageUpdates: "delta"`) now carry the block on start/end events and the message on a restart, so a client can rebuild the streaming message from deltas alone ([#17137](https://github.com/can1357/oh-my-pi/pull/17137) by [@andrebrait](https://github.com/andrebrait))
- `ctx.ui.input` now accepts `{ secret: true }` to mask typed characters as bullets in the TUI, forward an optional `secret` host hint on RPC `extension_ui_request` frames, and refuse plaintext form elicitation in ACP mode ([#17080](https://github.com/can1357/oh-my-pi/pull/17080) by [@GTanger](https://github.com/GTanger))
- Added opt-in `gc.autoCompress` (default off): interactive launches start a detached, low-priority `omp gc --compress --apply` at most once a day, so idle sessions are stored compressed without running the command; volumes where compression does not shrink a probe file (e.g. macOS 27) are skipped, and the latest run's output or skip reason is in `gc-auto-compress.log` in the agent dir ([#17189](https://github.com/can1357/oh-my-pi/pull/17189) by [@wolfiesch](https://github.com/wolfiesch))
- Added `withFatLto` to the Nix package: `omp.override { withFatLto = false; }` links `pi-natives` with thin LTO for faster builds ([#13752](https://github.com/can1357/oh-my-pi/pull/13752) by [@n3oney](https://github.com/n3oney))

### Changed

- Bundled `scout` subagents now include `ast_grep` in their default tool list, matching the agent prompt's AST-search directive; `scout` stays read-only, so `lsp` (which can rename and apply code actions) is not added ([#17151](https://github.com/can1357/oh-my-pi/pull/17151) by [@sinhduc01](https://github.com/sinhduc01))
- Clearing a draft now brings back the idle recap and idle compaction it held off, a subagent view you return to gets the recap it still owed, and prompts, turn-starting messages and IRC wakes that arrive during idle compaction wait for it to finish; SDK owners can opt a session in with `AgentSession.enableIdleMaintenance({ isBlocked, scheduledTurn, onRecap })` and `refreshIdleMaintenance()` ([#17136](https://github.com/can1357/oh-my-pi/pull/17136) by [@andrebrait](https://github.com/andrebrait))
- TTSR interrupts include a bounded excerpt of the text that matched the rule, quoted as untrusted data with harness tags escaped; excerpts are retained once per stream, preserved alongside AST matches, and omitted for zero-width matches ([#17099](https://github.com/can1357/oh-my-pi/pull/17099) by [@shgew](https://github.com/shgew))
- Sessions that load several provider-registering extensions into a shared model registry (subagents, `/tan`, SDK hosts) start faster: the model catalog is rebuilt once instead of once per extension ([#17088](https://github.com/can1357/oh-my-pi/pull/17088) by [@Delije4](https://github.com/Delije4))
- Qwen 3.8 models (for example `Qwen3.8-Flash-Next` served locally) now get the `replace` edit tool instead of hashline, like Kimi, DeepSeek and GLM 5.3 Flash; an explicit `edit.mode`, `edit.modelVariants`, `PI_EDIT_VARIANT` or `PI_STRICT_EDIT_MODE` still wins ([#17096](https://github.com/can1357/oh-my-pi/pull/17096) by [@ianderse](https://github.com/ianderse))
- ACP clients now receive each tool's name on `tool_call`, so tools without a specific ACP kind (`task`, `wait`, `ask`, …) show their own name instead of a generic "tool" label ([#17162](https://github.com/can1357/oh-my-pi/pull/17162) by [@epk](https://github.com/epk))
- `/context` now opens an interactive, read-only viewer of the active prompt, tools, messages, and thinking with estimated token usage and per-tool output, instead of the static usage report ([#16160](https://github.com/can1357/oh-my-pi/pull/16160) by [@C-W-Z](https://github.com/C-W-Z)).
- Nix builds cache Rust dependencies and the native addon in separate derivations, so Rust edits no longer recompile every dependency and TypeScript edits reuse the addon ([#13752](https://github.com/can1357/oh-my-pi/pull/13752) by [@n3oney](https://github.com/n3oney))

### Fixed

- Fixed `ask` questions being unanswerable while the prompt held a draft: Up/Down now hand the keyboard to the question (typing still goes to the draft until then), and the untouched draft is back in the prompt once the question is answered or cancelled ([#17215](https://github.com/can1357/oh-my-pi/pull/17215) by [@H4vC](https://github.com/H4vC))
- Fixed the Agent Hub becoming unreachable after the last subagent finished: the people icon now stays (muted) while the session has subagents to inspect, and `/subagents` opens the hub as an alias of `/hub` ([#17215](https://github.com/can1357/oh-my-pi/pull/17215) by [@H4vC](https://github.com/H4vC))
- Fixed `/goal pause` leaving the `goal` tool active; pausing now restores the toolset from before the goal started ([#15753](https://github.com/can1357/oh-my-pi/pull/15753) by [@Shadorain](https://github.com/Shadorain))
- Fixed `/live` flipping between `listening` and `speaking` at every pause in the assistant's speech; `speaking` now holds through short pauses ([#17114](https://github.com/can1357/oh-my-pi/issues/17114))
- Fixed the `workflowz` notice showing Python call forms in JS-only sessions and describing keep-alive workers when `eval.workpool.freshAgents` is on ([#17152](https://github.com/can1357/oh-my-pi/pull/17152) by [@bigHippoZz](https://github.com/bigHippoZz))
- Fixed the first request after midnight or a working-directory change rewriting the conversation's first message, which broke OpenAI response chaining and the provider prompt cache, when an extension `context` handler or secret obfuscation was active, when an extension inserted its own message afresh on every request (superpowers' bootstrap), or when requests from one or more advisors ran in between; the new date or directory is now appended after the earlier turns, and is repeated when a side question (`/btw`) or a branch left out the turn that carried it ([#17117](https://github.com/can1357/oh-my-pi/pull/17117) by [@sjawhar](https://github.com/sjawhar))
- Fixed `:auto` on a retry fallback entry being ignored: a fixed-effort session now switches to auto thinking on that fallback instead of inheriting the failing turn's effort, and advisor fallbacks keep following the primary's effort without enabling unverified thinking ([#17100](https://github.com/can1357/oh-my-pi/pull/17100) by [@shgew](https://github.com/shgew))
- Fixed `ssh://` home-relative paths resolving against literal `/~` instead of the remote account's home ([#17182](https://github.com/can1357/oh-my-pi/pull/17182) by [@alphastorm](https://github.com/alphastorm))
- Fixed searches of `ssh://` directories failing with unsupported directory scans ([#17182](https://github.com/can1357/oh-my-pi/pull/17182) by [@alphastorm](https://github.com/alphastorm))
- Fixed clone-first worktrees carrying source-bound Python environments and CMake build trees, including self-ignored and nested directories ([#17181](https://github.com/can1357/oh-my-pi/pull/17181) by [@alphastorm](https://github.com/alphastorm))
- Fixed clean cloned worktrees carrying files ignored only by the source checkout, while retaining caches ignored by the target ([#17181](https://github.com/can1357/oh-my-pi/pull/17181) by [@alphastorm](https://github.com/alphastorm))
- Fixed glob patterns ending in `/` returning no directories or including matching files; directory-only constraints now work across local, URL, and multi-root searches ([#17180](https://github.com/can1357/oh-my-pi/pull/17180) by [@alphastorm](https://github.com/alphastorm))
- Fixed recursive `skill://` glob and find discovery skipping contained linked directories; linked resources keep their skill URLs and directory cycles terminate ([#17180](https://github.com/can1357/oh-my-pi/pull/17180) by [@alphastorm](https://github.com/alphastorm))
- Fixed find treating nonempty linked files as empty and dropping them before judgment ([#17180](https://github.com/can1357/oh-my-pi/pull/17180) by [@alphastorm](https://github.com/alphastorm))
- Fixed JSON selectors failing on BOM-prefixed input, backup and extensionless files, and modifier-only queries ([#17179](https://github.com/can1357/oh-my-pi/pull/17179) by [@alphastorm](https://github.com/alphastorm))
- Fixed JSON selectors on `ssh://` text files while preserving pagination and the remote read limit ([#17179](https://github.com/can1357/oh-my-pi/pull/17179) by [@alphastorm](https://github.com/alphastorm))
- Fixed `tool.apply_patch(...)` being rejected as an unknown tool in JavaScript eval when apply-patch editing is enabled ([#17178](https://github.com/can1357/oh-my-pi/pull/17178) by [@alphastorm](https://github.com/alphastorm))
- Fixed eval silently changing supplied cell deadlines without showing the requested and effective timeouts ([#17178](https://github.com/can1357/oh-my-pi/pull/17178) by [@alphastorm](https://github.com/alphastorm))
- Fixed unavailable Python remaining in eval's advertised languages and corrected its interpreter setup guidance ([#17178](https://github.com/can1357/oh-my-pi/pull/17178) by [@alphastorm](https://github.com/alphastorm))
- Fixed PDF archive members returning a binary-entry banner instead of converted text, with PDF selectors and page-image reads now supported ([#17175](https://github.com/can1357/oh-my-pi/pull/17175) by [@alphastorm](https://github.com/alphastorm))
- Fixed `github` `run_watch` labeling unavailable or partial failed-job logs as full logs, and included bounded fetch-failure reasons ([#17173](https://github.com/can1357/oh-my-pi/pull/17173) by [@alphastorm](https://github.com/alphastorm))
- Fixed `github` `pr_create` echoing large PR bodies in creation summaries and `xd://github` result details ([#17173](https://github.com/can1357/oh-my-pi/pull/17173) by [@alphastorm](https://github.com/alphastorm))
- Fixed raw URL reads prepending transport headers and normalizing response whitespace; raw URL bodies, ranges, and artifacts now share source-body coordinates ([#17171](https://github.com/can1357/oh-my-pi/pull/17171) by [@alphastorm](https://github.com/alphastorm))
- Fixed raw ranged reads adding elision rows, continuation notices for satisfied ranges, and conflict instructions to selected source text ([#17171](https://github.com/can1357/oh-my-pi/pull/17171) by [@alphastorm](https://github.com/alphastorm))
- Fixed `read` replacing a valid HTML page with a stale or missing guessed `.md` page; alternate representations now report their actual source URL ([#16834](https://github.com/can1357/oh-my-pi/issues/16834))
- Fixed implicit interactive `autoResume` failing every launch when a saved model cannot be restored and model fallback is disabled: startup now warns and opens a fresh session without carrying over the old history or cache identity, while preserving the original `--max-time` deadline. Saved-model diagnostics in the warning are sanitized and length-limited before display. Explicit resume and headless model-restoration restrictions remain unchanged ([#17163](https://github.com/can1357/oh-my-pi/pull/17163) by [@SAKANA-MOONLIGHT](https://github.com/SAKANA-MOONLIGHT)).
- Fixed `proc://<id>/mode` reporting a known in-process job or agent as a missing service, and clarified that stdin and lifetime modes are services-only ([#17170](https://github.com/can1357/oh-my-pi/pull/17170) by [@alphastorm](https://github.com/alphastorm))
- Fixed Rex and other OSC 7501 terminals losing the `working` or `blocked` indicator when omp redraws a user message during a run ([#17145](https://github.com/can1357/oh-my-pi/issues/17145))
- Fixed hintless Google HTTP 429 model-capacity responses using the 45–75s model-capacity backoff instead of the short generic retry delay ([#17127](https://github.com/can1357/oh-my-pi/pull/17127) by [@GTanger](https://github.com/GTanger))
- Fixed `skill://` reads, `/skill:` commands (terminal, ACP and RPC) and subagent autoload skills serving a plugin's old version, or failing with `File not found`, in a running session after `omp plugin upgrade` installed a new version; the session now rediscovers its skills and uses the upgraded files, whether or not the old version's directory was deleted ([#17027](https://github.com/can1357/oh-my-pi/pull/17027) by [@sjawhar](https://github.com/sjawhar))
- Fixed Esc on a busy session (and RPC `abort_and_restore_queue`) silently discarding queued messages from extensions and agents, such as `pi.sendMessage` steer/follow-up cards and agent-attributed prompts; they now appear in the transcript without restarting the run and reach the model with your next prompt ([#17161](https://github.com/can1357/oh-my-pi/pull/17161) by [@sjawhar](https://github.com/sjawhar))
- Fixed a failed delivery of messages typed during compaction discarding other queued messages, such as an extension's prompt; only the messages that delivery queued are taken back, and messages anything else queued before, during or after it stay queued ([#17161](https://github.com/can1357/oh-my-pi/pull/17161) by [@sjawhar](https://github.com/sjawhar))
- Fixed a failed delivery of messages typed during compaction sending the first of them twice: once now and again with the retried batch ([#17161](https://github.com/can1357/oh-my-pi/pull/17161) by [@sjawhar](https://github.com/sjawhar))
- Fixed `--resume <file|id>`, `--continue`, `SessionManager.continueRecent()`, the resume pickers and RPC `open_session` reviving an old copy of a conversation that had continued in a new file because omp could not keep writing the original (another omp process held it, or the file changed under it); resume now opens the copy with the newest turn, unless the original has turns of its own that copy lacks (for `--resume`, the pickers, and `--continue` or auto-resume of the terminal's last session), and says which file it picked; `--continue` and auto-resume without a record of the terminal's last session, and RPC `open_session`, take the copy with the newest turn among all linked copies, whichever one was written last. Copies saved before this fix are not linked and still resume as before ([#17159](https://github.com/can1357/oh-my-pi/pull/17159) by [@sjawhar](https://github.com/sjawhar))
- Fixed a `retry.fallbackChains` entry naming another Claude model being skipped while the latest Claude turn carries signed thinking: the chain now moves to that entry when the failure is on another model, is not retried (an account-policy denial, a non-retryable error, or a wait past `retry.maxDelayMs`), or has spent its retries ([#17115](https://github.com/can1357/oh-my-pi/pull/17115) by [@sjawhar](https://github.com/sjawhar))
- Anthropic composer predictions now cache the persisted conversation prefix; `/btw` follow-ups reuse stable topic history without caching regenerated image descriptions ([#17186](https://github.com/can1357/oh-my-pi/issues/17186))
- Fixed `wait` returning a skipped-tool error for background completions, peer messages, or parent steering queued before execution ([#17174](https://github.com/can1357/oh-my-pi/pull/17174) by [@alphastorm](https://github.com/alphastorm))
- Session-stop extensions now pass all continuation messages to the agent instead of silently discarding every message after the first; blocking decisions still take priority ([#17129](https://github.com/can1357/oh-my-pi/pull/17129) by [@aktanazat](https://github.com/aktanazat))
- Fixed the crash and SIGTERM recovery hint offering `omp --resume <id>` for a session that was never saved to disk, which `--resume` cannot load; such a session now prints no resume command ([#17119](https://github.com/can1357/oh-my-pi/pull/17119) by [@sjawhar](https://github.com/sjawhar))
- Fixed Ctrl+V over SSH pasting the server's clipboard when the client terminal forwards the key instead of pasting (e.g. Tern on Windows into a macOS host); omp now leaves the remote clipboard alone and points you to your terminal's paste shortcut ([#17149](https://github.com/can1357/oh-my-pi/pull/17149) by [@H4vC](https://github.com/H4vC))
- Fixed `apply_patch` committing unmatched old/context text or dropping numeric prefixes; matching now uses complete lines without changing other edit modes' fuzzy behavior ([#17184](https://github.com/can1357/oh-my-pi/pull/17184) by [@alphastorm](https://github.com/alphastorm))
- Fixed context-free `apply_patch` line deletions leaving blank rows, including first, last and only lines ([#17184](https://github.com/can1357/oh-my-pi/pull/17184) by [@alphastorm](https://github.com/alphastorm))
- Fixed `apply_patch` rejecting move-only updates and move-then-add envelopes; moves preserve source bytes and permissions and later sections see the ordered file state ([#17184](https://github.com/can1357/oh-my-pi/pull/17184) by [@alphastorm](https://github.com/alphastorm))
- Fixed `omp plugin` commands applying changes under `--dry-run`: `upgrade` and `omp update --plugins --check` now preview, and actions without a preview reject the flag ([#17104](https://github.com/can1357/oh-my-pi/pull/17104) by [@sjawhar](https://github.com/sjawhar))
- Turning off `async.widgets` mid-session now stops spec requests for already-shown job widgets and aborts any request in flight ([#17090](https://github.com/can1357/oh-my-pi/pull/17090) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Fixed `learn` not hot-registering a newly minted or updated managed skill in the active session (`session.skills`, `skill://`, and the system prompt), and fixed `composeRecallQuery` dropping prior user turns when an earlier turn repeated the latest prompt ([#17113](https://github.com/can1357/oh-my-pi/pull/17113) by [@GTanger](https://github.com/GTanger))
- Fixed `@path` file mentions skipping `.pdf`, `.docx`, `.xlsx`, `.pptx`, and `.epub` files as binary instead of converting them to Markdown with `markit` like CLI `@file` arguments and `read` ([#17193](https://github.com/can1357/oh-my-pi/pull/17193) by [@GTanger](https://github.com/GTanger))
- Fixed an automatic retry fallback (a hop down `retry.fallbackChains` or the Fireworks Fast degrade) re-rendering the system prompt for the new model, which made Anthropic write the whole cached conversation again on each hop; a hop now keeps the Model line and Delegation wording, and rebuilds only when the new model needs a different edit mode, tool-description handling, or tool set ([#17014](https://github.com/can1357/oh-my-pi/pull/17014) by [@sjawhar](https://github.com/sjawhar))
- Fixed a live subagent's system prompt re-rendering its peer list, with each peer's current activity, on every rebuild, which made Anthropic write the whole cached conversation again; the list now updates only when a rebuild changes the rest of the prompt, and `history://` lists the current peers ([#17014](https://github.com/can1357/oh-my-pi/pull/17014) by [@sjawhar](https://github.com/sjawhar))
- SQLite row selectors now avoid shadowed ROWID aliases so reads, updates, and deletes target the intended single row. ([#16998](https://github.com/can1357/oh-my-pi/issues/16998), [#17001](https://github.com/can1357/oh-my-pi/pull/17001) by [@ai-yang](https://github.com/ai-yang))
- Fixed composer predictions offering notes relayed in from other agents or sessions (for example an orchestrator's pasted status note) as the user's next message; predictions now cover only what the person at the keyboard would type ([#17185](https://github.com/can1357/oh-my-pi/pull/17185) by [@wolfiesch](https://github.com/wolfiesch))
- Fixed image descriptions using the first vision model in catalog order (such as `claude-fable-5`) when no vision model is configured; they now use the least expensive priced vision-capable model ([#17148](https://github.com/can1357/oh-my-pi/issues/17148), [#17196](https://github.com/can1357/oh-my-pi/pull/17196) by [@gcp](https://github.com/gcp))
- Fixed `wait` results and background job deliveries naming a finished subagent only by a job id that differs from its agent id (e.g. `Foo-2` for a messaged agent's new turn), where `agent://Foo-2` and `history://Foo-2` are not found; they now name `history://Foo`, plus `agent://Foo` when that turn published its output ([#17112](https://github.com/can1357/oh-my-pi/pull/17112) by [@sjawhar](https://github.com/sjawhar))
- Fixed `RpcClient.promptAndWait()` hanging until its timeout when the agent process exits or the client stops after the prompt was acknowledged; it now rejects right away ([#17135](https://github.com/can1357/oh-my-pi/pull/17135) by [@andrebrait](https://github.com/andrebrait))
- Fixed reading versioned Read the Docs pages serving the development branch's source file instead of the requested version's content when the page's Edit link targets another branch ([#17091](https://github.com/can1357/oh-my-pi/pull/17091) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Fixed RPC startup hanging when an extension opens a dialog during `session_start`: the client can now answer it, and other commands still wait for startup to finish, in order ([#17139](https://github.com/can1357/oh-my-pi/pull/17139) by [@andrebrait](https://github.com/andrebrait))
- Fixed extension tools disappearing once the startup plan mode (`plan.defaultOnStartup`) was paused or its plan approved: tools of extensions that load after startup now stay, while built-ins that plan mode registered, such as its `write` transport, still go ([#17085](https://github.com/can1357/oh-my-pi/pull/17085) by [@appboypov](https://github.com/appboypov))
- Fixed a batch `task` call silently ignoring a `model` (or `sourceSession`) on a non-`seance` item while the `seance` agent is hidden, so the child ran on its own model; the call is now refused with the same error as a single-agent call ([#17107](https://github.com/can1357/oh-my-pi/pull/17107) by [@sjawhar](https://github.com/sjawhar))
- Fixed an edit under an older `[path#TAG]` header, after another edit had changed the file, applying to lines that read never displayed, including a line it had cut at the column cap; such an edit now shows the anchored lines first, as it does under the file's current tag ([#16208](https://github.com/can1357/oh-my-pi/issues/16208), [#17033](https://github.com/can1357/oh-my-pi/pull/17033) by [@sjawhar](https://github.com/sjawhar))
- Fixed `omp gc --compress` (and the `gc.autoCompress` background run) taking minutes on large session histories ([#17195](https://github.com/can1357/oh-my-pi/pull/17195) by [@H4vC](https://github.com/H4vC))
- Fixed `omp gc --compress --apply` spending time on every idle session where the filesystem does not actually compress files (e.g. macOS 27); it now reports `compress skipped: <reason>`, and `gc.autoCompress` no longer slows interactive startup with that check ([#17195](https://github.com/can1357/oh-my-pi/pull/17195) by [@H4vC](https://github.com/H4vC))

## [18.13.1] - 2026-10-27

### Added

- Added `tools.restrictedFolders`: every action on a listed folder (the folder and everything below it) asks for an explicit Approve/Deny in every approval mode, `yolo` included, and no remembered grant, session approval, or ACP "Always allow" covers it; recursive searches rooted above a restricted folder ask too, commands are matched by the directory they run in, and a `deny` policy still denies ([#16049](https://github.com/can1357/oh-my-pi/pull/16049) by [@Peribunt](https://github.com/Peribunt))
- `/pause` shows draining turns and running jobs across the main agent's subagent tree, without waiting on finished turns, safely parked agents, or suspended advisor reviews ([#17073](https://github.com/can1357/oh-my-pi/pull/17073) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).

### Changed

- Reduced redraws during background subagent progress while keeping elapsed previews and native checklists current ([#17131](https://github.com/can1357/oh-my-pi/pull/17131) by [@iliaal](https://github.com/iliaal), based on [#16647](https://github.com/can1357/oh-my-pi/pull/16647) by [@Komzpa](https://github.com/Komzpa)).
- Restoring a session with many subagents refreshes the running-subagent badge and lists once per burst instead of once per agent ([#16642](https://github.com/can1357/oh-my-pi/pull/16642) by [@Komzpa](https://github.com/Komzpa))
- `ask` answers now name the option a note is on (`m: [X, Y] (note on Y: …)`, `User added note on Y: …`) ([#17126](https://github.com/can1357/oh-my-pi/pull/17126) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed advisors dropping their review and showing a rate-limit error when the provider returns a timed 429 such as Codex's `turn_rate_limit_exceeded`; the advisor now waits out the Retry-After (within `retry.maxDelayMs`) and retries like the main agent ([#17087](https://github.com/can1357/oh-my-pi/pull/17087) by [@H4vC](https://github.com/H4vC))
- Fixed a hashline `PUT` being refused with "would hold one more copy of line N … than the range did" when its body restates the line next to the range, fills the range, and adds a new line equal to that neighbour (a second `@property` or `#[test]`, or a `break;` above a new `case`); it applies again, dropping only the restated line ([#17028](https://github.com/can1357/oh-my-pi/pull/17028))
- Fixed task subagents receiving `AGENTS.md` files, including the user-level `~/.omp/agent/AGENTS.md`, when the session has additional workspace roots (`--add-dir`, `/add-dir`, `workspace.additionalDirectories`)
- Fixed an `ask` note added right after picking an answer landing on the next question's answer, in Tern and the TUI; Note now goes to the answer just picked until the next question gets other input ([#17126](https://github.com/can1357/oh-my-pi/pull/17126) by [@H4vC](https://github.com/H4vC))

## [18.13.0] - 2026-10-26

### Breaking Changes

- `snapshotJobs` no longer accepts `includeResults`, and `buildJobResult` accepts only the `"wait"` and `"cancel"` ops; the `"jobs"` op has had no caller since `wait` and `proc://` replaced the `hub` tool ([#16763](https://github.com/can1357/oh-my-pi/pull/16763) by [@will-bogusz](https://github.com/will-bogusz))
- `snapshotJobs` no longer accepts `includeResults`, and `buildJobResult` accepts only the `"wait"` and `"cancel"` ops; the `"jobs"` op has had no caller since `wait` and `proc://` replaced the `hub` tool ([#16763](https://github.com/can1357/oh-my-pi/pull/16763) by [@will-bogusz](https://github.com/will-bogusz))

### Added

- Added `omp -p --wait-async` (setting `async.printWake`): print mode waits for the background jobs it started and wakes the same session with each result before exiting, instead of cancelling them ([#10363](https://github.com/can1357/oh-my-pi/issues/10363), [#16690](https://github.com/can1357/oh-my-pi/pull/16690) by [@trukhinyuri](https://github.com/trukhinyuri))
- File slash commands with `side: true` frontmatter (including Codex and OpenCode command directories) run as `/btw` side questions in the TUI, with or without arguments: they answer off the transcript and never steer a running turn. The panel and `/btw` history title them by the typed command (`/sitrep`); the title is kept in an `entry-<id>.title` sidecar so older builds can still read the history. Other modes expand them as ordinary prompts ([#16815](https://github.com/can1357/oh-my-pi/pull/16815) by [@wolfiesch](https://github.com/wolfiesch))
- Added `compat.requiresThinkingPresence` to `models.yml` overrides, so a gateway model group whose strict member validates thinking replay can pad a turn a lax member answered without reasoning ([#16739](https://github.com/can1357/oh-my-pi/pull/16739) by [@lz37](https://github.com/lz37))
- Anthropic web search and Files API uploads follow `PI_ANTHROPIC_API_VERSION=2026-10-21`; web search omits `temperature` under that version ([#16706](https://github.com/can1357/oh-my-pi/pull/16706) by [@H4vC](https://github.com/H4vC))
- llama.cpp auto-discovery now also finds local servers on llama-server's new default port 9931 when nothing answers on 8080 ([#16675](https://github.com/can1357/oh-my-pi/pull/16675) by [@bartbroere](https://github.com/bartbroere))
- `/local` (or `Alt+G`, remappable as `app.local.open`) opens a picker of the session's `local://` files and edits the chosen one in place in `$VISUAL`/`$EDITOR`; `/local <name>` opens a file directly with name completion ([#16873](https://github.com/can1357/oh-my-pi/pull/16873) by [@Shadorain](https://github.com/Shadorain))
- Added `--no-context-files` to start a session without `AGENTS.md`, `CLAUDE.md` or other context files, including those of `--add-dir` roots and in subagents ([#16768](https://github.com/can1357/oh-my-pi/pull/16768) by [@will-bogusz](https://github.com/will-bogusz))

### Changed

- Clarified how RPC and RPC-UI clients discover and invoke mounted MCP tools through `xd://` devices rather than relying on `dumpTools` ([#16864](https://github.com/can1357/oh-my-pi/pull/16864) by [@michaeltrefry](https://github.com/michaeltrefry))
- The note `read` adds to a PDF whose pages have no extractable text (a scan) now points at the `:page<N>.png` selector, which returns the page as an image, instead of the browser prelude ([#16585](https://github.com/can1357/oh-my-pi/pull/16585) by [@will-bogusz](https://github.com/will-bogusz))
- `read doc.pdf:page<N>.png` renders the page in a square 874x874 tab instead of the default landscape one, so a letter page comes back at 668x865 instead of 441x568 and a landscape page at 864x669 instead of 736x567 ([#16585](https://github.com/can1357/oh-my-pi/pull/16585) by [@will-bogusz](https://github.com/will-bogusz))
- Added `--warn-cost` and `--max-cost` (`session.warnCost` / `session.maxCost`): omp warns once at the first spend and stops sending model requests at the second, subagents included; capped print runs exit 3 ([#7802](https://github.com/can1357/oh-my-pi/issues/7802); first written by [@zhang17-24](https://github.com/zhang17-24)) ([#16803](https://github.com/can1357/oh-my-pi/pull/16803) by [@will-bogusz](https://github.com/will-bogusz))
- `/session` (and RPC `get_session_stats`, as `editRejections`) lists your failed edits by why they were refused (unseen lines, stale tag, parse error, …), and each failed edit records that reason as `details.errorKind` in the session file ([#16608](https://github.com/can1357/oh-my-pi/pull/16608) by [@will-bogusz](https://github.com/will-bogusz))
- Added exclusions to `grep`: a `path` entry starting with `!` leaves matching files and folders out of the search (`src;!*.test.ts`, `!vendor;!gen`), where before it was taken as a path and found nothing ([#16920](https://github.com/can1357/oh-my-pi/pull/16920) by [@will-bogusz](https://github.com/will-bogusz))
- `wait` and `read proc://` now show a running subagent's run time, request count, cost, context fill and stage, so a subagent that is looping is visible without opening its transcript ([#16863](https://github.com/can1357/oh-my-pi/pull/16863) by [@KimToehler](https://github.com/KimToehler))
- Google Antigravity web search sends the same transport headers as the official client (`Accept-Encoding: gzip`, no explicit `Accept`) ([#17012](https://github.com/can1357/oh-my-pi/pull/17012) by [@apoc](https://github.com/apoc))
- A subagent's result up to 11,500 characters now reaches its parent whole, instead of as a 5,000-character preview the parent had to re-read through `agent://<id>` or act on without its ending ([#16599](https://github.com/can1357/oh-my-pi/pull/16599) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a subagent's final report or `yield` reaching its parent and `agent://` as its short reply to a peer message or `agent://all` broadcast (the parent's included) that arrived as it finished; such messages now get a turn of their own after the result, and a peer that wrote directly still receives the reply ([#16583](https://github.com/can1357/oh-my-pi/pull/16583) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the built-in `ts-set-map` rule stalling tool-call streaming on a long single-line `Set` value (5 s at 20,000 characters) and firing when the literal array only feeds a computed argument such as `new Set(["a", "b"].map(normalize))`; `ts-import-type` no longer fires on `import("x").then` written with a non-breaking space or line separator before the call ([#16556](https://github.com/can1357/oh-my-pi/pull/16556) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a subagent woken after it was parked losing the tools an extension registers at its first prompt (such as HexRays `ida-mcp`'s `ida_*` tools), which also made its first request after waking miss the prompt cache; extensions see the revive as a `before_agent_start` with the new `reason: "revive"` ([#16597](https://github.com/can1357/oh-my-pi/pull/16597) by [@will-bogusz](https://github.com/will-bogusz))
- `read` shows HEIC, HEIF and AVIF photos (such as iPhone pictures) as images instead of refusing them as binary, decoding them with ffmpeg 8.1 or newer; text-only models get their metadata, and without such an ffmpeg the error says how to convert the file ([#16612](https://github.com/can1357/oh-my-pi/pull/16612) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `read` of web pages with tables, code or pricing lists (API references, specs, pricing pages) returning a shorter trafilatura or Jina rendering that leaves out much of the page, and noting the page "appears to require JavaScript or is mostly navigation" ([#16596](https://github.com/can1357/oh-my-pi/pull/16596) by [@will-bogusz](https://github.com/will-bogusz))
- `omp usage --json` now includes each policy-routed account's priority, reserve and routing state (`eligible`, `inside-reserve`, `exhausted` or `unknown`) as a `policy` object, matching the policy line in the text view ([#16581](https://github.com/can1357/oh-my-pi/pull/16581) by [@will-bogusz](https://github.com/will-bogusz))
- Added prompt-cache warming for Factory Droid's Claude models: replays follow the 5m entry, or the 1h entry once a response reports writing one ([#16296](https://github.com/can1357/oh-my-pi/pull/16296) by [@will-bogusz](https://github.com/will-bogusz))
- `generate_image` can now run Factory Droid's image models (GPT Image 2.5, GPT Image 2.5 Flare, Gemini 3 Pro Image) when one is chosen for the `image` role ([#16316](https://github.com/can1357/oh-my-pi/pull/16316) by [@will-bogusz](https://github.com/will-bogusz))
- On macOS, asking the agent to open a file, folder or URL, or to show a file in Finder, now takes one `computer.apps.open(path, { app?, reveal? })` call instead of a dozen steps driving Finder by hand ([#16403](https://github.com/can1357/oh-my-pi/pull/16403) by [@will-bogusz](https://github.com/will-bogusz))
- Added in-place updates of the browser relay's Chrome extension after an omp upgrade: an older extension loaded from `~/.omp/browser-relay/extension` is rewritten and reloads itself once no omp session is using the relay ([#15105](https://github.com/can1357/oh-my-pi/pull/15105) by [@will-bogusz](https://github.com/will-bogusz))
- Added a note to relay `browser.open` results when the Chrome extension was installed by an older omp, naming `omp browser-relay install` and a reload ([#15105](https://github.com/can1357/oh-my-pi/pull/15105) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed images attached with an `@path` file mention reaching a text-only model as `[image omitted: …]` with `images.describeForTextModels` enabled; they now get the `vision` role description like pasted images ([#16853](https://github.com/can1357/oh-my-pi/issues/16853))
- Fixed `browser.open({ ignore_https_errors: true })` still failing with certificate errors such as `net::ERR_CERT_AUTHORITY_INVALID` on the shared Chromium and on `app.cdp_url` browsers; the override now lasts until the tab is closed ([#16930](https://github.com/can1357/oh-my-pi/issues/16930))
- `ignore_https_errors` through the Chrome relay now fails up front, explaining that Chrome's extension debugger API cannot ignore certificate errors and pointing to `app.relay: false`, instead of failing with `Security.setIgnoreCertificateErrors wasn't found` ([#16930](https://github.com/can1357/oh-my-pi/issues/16930))
- Fixed a parent follow-up consumed while a kept-alive subagent resumes from queued steering or an async completion leaving `agent://` on the previous result instead of delivering the fresh answer ([#16746](https://github.com/can1357/oh-my-pi/issues/16746))
- Fixed a long streamed answer ending the collab room for every guest with "collab send backlog exceeded its limit"; the host now sends guests only the latest state of a streaming message, and guests still speak the full answer when speech is on ([#16956](https://github.com/can1357/oh-my-pi/issues/16956))
- Fixed `read proc://<agent>` and `write proc://<agent>/kill` answering "not found" for a subagent that a message woke while its new turn runs as job `<agent>-2`; they now reach that job, and reading the agent's finished first job names the job it is running as ([#17020](https://github.com/can1357/oh-my-pi/pull/17020) by [@sjawhar](https://github.com/sjawhar))
- Fixed the agent reading a fallback engine's `web_search` results as the preferred provider's: the tool result now notes which provider answered and why the earlier ones failed ([#16948](https://github.com/can1357/oh-my-pi/pull/16948) by [@BAKocska](https://github.com/BAKocska))
- Fixed a turn that ended with background jobs still running looking stuck: the working row now says it is waiting for those jobs and names them instead of repeating the last tool call, and Esc ends the wait, so the jobs keep running and their results land in context for your next prompt instead of starting a new turn ([#17032](https://github.com/can1357/oh-my-pi/pull/17032) by [@sjawhar](https://github.com/sjawhar))
- The `power.sleepPrevention` setting now says it keeps the machine awake only while the agent is running a turn, not for as long as a session is open ([#16762](https://github.com/can1357/oh-my-pi/pull/16762) by [@will-bogusz](https://github.com/will-bogusz))
- The advisor docs now say a quota-paused advisor resumes only when its runtime is reset or rebuilt (compaction, a session switch, `/advisor`, a config reload or a restart), not after a cooldown ([#16766](https://github.com/can1357/oh-my-pi/pull/16766) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `read proc://<agent>` and `write proc://<agent>/kill` answering "not found" for a subagent that a message woke while its new turn runs as job `<agent>-2`; they now reach that job, and reading the agent's finished first job names the job it is running as ([#17020](https://github.com/can1357/oh-my-pi/pull/17020) by [@sjawhar](https://github.com/sjawhar))
- Fixed the agent reading a fallback engine's `web_search` results as the preferred provider's: the tool result now notes which provider answered and why the earlier ones failed ([#16948](https://github.com/can1357/oh-my-pi/pull/16948) by [@BAKocska](https://github.com/BAKocska))
- Fixed the `computer` tool's `computer.window({ app })` failing for an app with no open window without saying what to do; the error now names the `computer.apps.open(…)` call that launches it (on macOS it also shows a window of a running app that has none), and `computer.window()` with no argument asks for a window id or filter instead of listing windows that "match undefined" ([#16912](https://github.com/can1357/oh-my-pi/pull/16912) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the `computer` tool prompt leaving `el.selectText` out of the element helpers; it now says a following `el.type` on that element replaces the selection ([#16769](https://github.com/can1357/oh-my-pi/pull/16769) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a turn that ended with background jobs still running looking stuck: the working row now says it is waiting for those jobs and names them instead of repeating the last tool call, and Esc ends the wait, so the jobs keep running and their results land in context for your next prompt instead of starting a new turn ([#17032](https://github.com/can1357/oh-my-pi/pull/17032) by [@sjawhar](https://github.com/sjawhar))

### Fixed

- Honored `display_name`, `context_window`, and `input_modalities` when a model list nests them under `metadata`, so codex-lb-style gateways surface the advertised name, window, and image input instead of the raw id and defaults. ([#17010](https://github.com/can1357/oh-my-pi/pull/17010) by [@adi-IL](https://github.com/adi-IL))
- Recovered spilled tool output in sessions without an artifacts directory: the `artifact://` link the truncation footer advertises now reads the in-memory copy instead of failing with "No session - artifacts unavailable". ([#17009](https://github.com/can1357/oh-my-pi/pull/17009) by [@adi-IL](https://github.com/adi-IL))
- Fixed the compiled `omp` binaries trusting certificates from the compromised eMudhra intermediate CAs (CVE-2026-91403) and carrying the Brotli decoder out-of-bounds write (CVE-2026-111497); release binaries now build on Bun 1.4.4 ([#16822](https://github.com/can1357/oh-my-pi/issues/16822), [#16865](https://github.com/can1357/oh-my-pi/pull/16865) by [@bse-ai](https://github.com/bse-ai))
- Fixed `computer` runs in subagents and `omp -p` stopping at their first `control.acquire`: they now keep working through background window input and report only a step that needs foreground control ([#16909](https://github.com/can1357/oh-my-pi/pull/16909) by [@will-bogusz](https://github.com/will-bogusz))
- With `bash.gitGuard` on, a repository that once finished a conflicted rebase no longer counts as mid-conflict forever, which had let `git checkout`, `switch` and `restore` through; branch switches such as `git checkout -B <branch> <commit>` stay refused during a real merge or rebase too, abbreviated options such as `git reset --ha` are refused like the full ones, and `git stash create` is allowed ([#16919](https://github.com/can1357/oh-my-pi/pull/16919) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser calls right after a click that navigates (headless, connected and relay Chrome) reaching the page being left: reads and screenshots returned the old page or failed with `Execution context was destroyed` or `Cannot find context with specified id`, and a `fill` could land on the old form; they now wait for the new page ([#16907](https://github.com/can1357/oh-my-pi/pull/16907) by [@will-bogusz](https://github.com/will-bogusz))
- LSP diagnostics now reflect external edits to already-open dependencies when checking an importer, including after Write/Edit ([#16836](https://github.com/can1357/oh-my-pi/issues/16836)).
- Fixed URL `read` line selectors using different coordinates from URL `grep` when the response includes transport headers ([#16877](https://github.com/can1357/oh-my-pi/issues/16877)).
- Fixed `write` to a SQLite row ignoring the database's declared foreign keys: orphan inserts and updates now fail, `ON DELETE RESTRICT` blocks the delete, and `ON DELETE CASCADE` removes dependent rows ([#16999](https://github.com/can1357/oh-my-pi/issues/16999))
- Fixed pasting a server URL into the `/mcp add` wizard putting it in the hidden chat draft instead of the URL field ([#16975](https://github.com/can1357/oh-my-pi/issues/16975)).
- `omp --from-claude` keeps the last real model when Claude records a synthetic API error, and does not try to restore a synthetic-only placeholder ([#16785](https://github.com/can1357/oh-my-pi/issues/16785)).
- Fixed skill-list previews of long CJK descriptions collapsing to the few characters before an early ASCII space (e.g. `用户点名…`); they now keep the full preview budget ([#17070](https://github.com/can1357/oh-my-pi/issues/17070))
- Browser clicks on a shadow-root button no longer fail with `blocked: covered by` naming the button's own slotted content; real overlays are still refused ([#16958](https://github.com/can1357/oh-my-pi/issues/16958))
- Fixed reading `.xlsx` files rewriting numeric-looking text cells: long IDs like `12345678901234567890` no longer round (and collide), and text such as `00123` keeps its leading zeros ([#16831](https://github.com/can1357/oh-my-pi/issues/16831))
- Fixed rc-file aliases for core tools (e.g. `alias ls='eza --icons'`) leaking into the bash tool; `ls`, `cat`, `grep` and the other core tools now run the real binaries ([#17067](https://github.com/can1357/oh-my-pi/issues/17067))
- Fixed a collab room staying half alive after its session moved to a new file because it was open in another omp process (or replaced/contested on disk): guests now get room-closed, the registry entry is withdrawn, and `collab.autoStart` shares the moved session ([#16935](https://github.com/can1357/oh-my-pi/issues/16935))
- Fixed skill-description compression ignoring the configured `default` model when `modelRoles.smol` is unset and sending background requests to the built-in smol chain (e.g. `claude-haiku-5-5`) instead of the model `/models` shows for SMOL ([#16970](https://github.com/can1357/oh-my-pi/issues/16970))
- Fixed `models.yml` discovery providers with an `apiKey` (and no `authHeader: true`) showing 0 models in `/models` and ctrl+p right after startup despite a cached catalog; cached models now load immediately ([#16965](https://github.com/can1357/oh-my-pi/issues/16965))
- Anthropic web search no longer sends unsupported `temperature` to Claude Haiku 5.5, avoiding HTTP 400 failures ([#16986](https://github.com/can1357/oh-my-pi/issues/16986))
- Fixed pages in the managed headless browser hitting "Maximum call stack size exceeded" in canvas `fillText` after calling `canvas.getContext("2d")` repeatedly ([#16879](https://github.com/can1357/oh-my-pi/issues/16879))
- Fixed LSP references and rename previews still listing a file that was open and then deleted (via `edit`, or outside OMP before a rename) until the language server restarted ([#16880](https://github.com/can1357/oh-my-pi/issues/16880))
- Fixed `omp plugin upgrade` failing on Windows with `EPERM: operation not permitted, symlink` when the installed plugin was replaced by `omp plugin link`; a failed upgrade now restores the link as a junction ([#16844](https://github.com/can1357/oh-my-pi/issues/16844))
- `omp plugin upgrade a@m b@m c@m` now upgrades every specified plugin instead of silently skipping targets after the first ([#16826](https://github.com/can1357/oh-my-pi/issues/16826))
- Browser `tab.fill()`/`tab.type()` (and `frame.fill()`/`frame.type()`) that time out on long text now stop typing instead of finishing it behind the rejected call, and the timeout reports how many characters were typed instead of claiming the element was hidden or covered ([#16833](https://github.com/can1357/oh-my-pi/issues/16833))
- Concurrent archive member writes now preserve both updates across sessions and directory symlinks; canceled writes waiting for the archive no longer publish later ([#17000](https://github.com/can1357/oh-my-pi/issues/17000)).
- Fixed a `tools.approval.<tool>: prompt` policy on a tool mounted as an `xd://` device asking the same approval question twice for one `write xd://<tool>` call ([#17039](https://github.com/can1357/oh-my-pi/issues/17039))
- ACP cancellation now waits through Python kernel interrupt escalation before closing a session; prompts sent after a closed session return `ResourceNotFound` so clients can offer `session/load` recovery ([#16889](https://github.com/can1357/oh-my-pi/issues/16889)).
- Google Antigravity, Google, and Google Vertex now keep append-only context by default, preserving cached prompts across long-running agent turns ([#16979](https://github.com/can1357/oh-my-pi/issues/16979)).
- Fixed LiteLLM `mode: decisions` model groups being offered as chat models instead of judge models, including for custom `discovery.type: litellm` providers ([#16939](https://github.com/can1357/oh-my-pi/issues/16939))
- ACP: `instructions` returned by MCP servers declared in `session/new` now reach the model under "## MCP Server Instructions", as they do for `.mcp.json` servers ([#16882](https://github.com/can1357/oh-my-pi/issues/16882))
- Fixed the Windows tab title (e.g. in Tern) sticking at `omp` instead of the session title after a JS eval worker or `omp browser-relay` ran in the same console; omp no longer retitles the console from child processes and reclaims the title when another process replaces it ([#16842](https://github.com/can1357/oh-my-pi/issues/16842))
- Fixed Python `eval` reporting the backend unavailable when the first `python` on PATH is broken (e.g. a mise shim with no version set) even though a working `python`/`python3` sits further down PATH; every PATH match is now probed, and the error reports bounded probe failures with home paths shortened ([#16824](https://github.com/can1357/oh-my-pi/issues/16824))
- Fixed a turn whose stream was cut after text had already rendered — a gateway substituting an in-band `error` frame for the missing terminal event — ending instead of continuing from the partial answer ([#16990](https://github.com/can1357/oh-my-pi/pull/16990) by [@Maziar123](https://github.com/Maziar123))
- Model tags in `/skill:` arguments now register `m<N>` agents and appear with the skill prompt instead of reaching the model as literal `^` selectors ([#16818](https://github.com/can1357/oh-my-pi/issues/16818))
- Fixed a user-scope `omp plugin upgrade`, `install --force`, or `uninstall` run outside a project deleting the cached plugin a project-scope install in that project still links to ([#16827](https://github.com/can1357/oh-my-pi/issues/16827))
- Fixed resuming anonymized sessions with text tool results crashing before the next model request ([#16859](https://github.com/can1357/oh-my-pi/issues/16859), [#16896](https://github.com/can1357/oh-my-pi/pull/16896) by [@tneemo](https://github.com/tneemo))
- Fixed the mid-run todo nudge going silent for the rest of a long turn after two nudges: a `todo` call now re-arms the per-turn budget instead of waiting for the next user prompt ([#16962](https://github.com/can1357/oh-my-pi/pull/16962) by [@omertahaoztop](https://github.com/omertahaoztop))
- xAI web and X searches now run Grok's hosted search instead of failing with `returned no sources` or falling back to engines that cannot read X posts ([#16947](https://github.com/can1357/oh-my-pi/pull/16947) by [@BAKocska](https://github.com/BAKocska))
- Fixed `/delete` leaving an empty zero-turn session on disk when you quit before sending a message ([#11303](https://github.com/can1357/oh-my-pi/issues/11303), [#16798](https://github.com/can1357/oh-my-pi/pull/16798) by [@NewtonChutney](https://github.com/NewtonChutney))
- Idle recap no longer runs when the prior message was not generated (a user message, or an assistant turn that produced no output). A generated assistant reply still recaps after the idle delay ([#16978](https://github.com/can1357/oh-my-pi/pull/16978) by [@atacolak](https://github.com/atacolak))
- Fixed an extension loading twice, so every handler ran twice, when the same file was reachable both through a symlink and its target, such as a link in the agent `extensions/` directory plus `--extension` with the real path; discovery now dedupes extension paths by real file ([#16788](https://github.com/can1357/oh-my-pi/pull/16788) by [@wolfiesch](https://github.com/wolfiesch))
- Fixed the `write` refusal in read-only subagents saying filesystem writes are unavailable; it now gives the on-disk path of `local://` files, so the agent can tell its caller where its report is ([#17023](https://github.com/can1357/oh-my-pi/pull/17023) by [@sjawhar](https://github.com/sjawhar))
- Fixed `wait` saying a subagent "finished its turn without replying" (and to ask again) after that subagent's result had already arrived as a background-job result, for a follow-up that woke it or that it got while running ([#16929](https://github.com/can1357/oh-my-pi/pull/16929) by [@sjawhar](https://github.com/sjawhar))
- Fixed a Markdown link to a local path that cannot be encoded pointing at a broken target instead of staying plain text ([#16806](https://github.com/can1357/oh-my-pi/pull/16806) by [@laviRZ](https://github.com/laviRZ))
- Fixed the Agent Hub reordering its rows on every heartbeat while it loaded the session's saved subagents, so no row could be selected until the load ended: a row's place is now fixed when the hub first shows it, agents found on disk take their place in the status/recency ranking, and a scan reads a transcript again only after it changed, so reopening the hub on a session with many saved agents no longer rereads them all ([#10524](https://github.com/can1357/oh-my-pi/issues/10524), [#16952](https://github.com/can1357/oh-my-pi/pull/16952) by [@lemonleks](https://github.com/lemonleks))
- `omp usage` now shows the Codex credit spend cap for credit-billed ChatGPT Business/Enterprise seats (previously `no limits reported`), and rounds fractional credit amounts to two decimals ([#16973](https://github.com/can1357/oh-my-pi/pull/16973) by [@DusKing1](https://github.com/DusKing1))
- Fixed TTSR rule matching slowing down quadratically on long tool calls such as `bash`, `eval` or `task` arguments: their streamed JSON escapes newlines, so every delta rescanned the whole argument (a 64 KB call with 10 rules took 120 ms of matching, now 4.5 ms). A long unterminated line is now rescanned as it grows by a quarter, and the final check still scans all of it ([#14248](https://github.com/can1357/oh-my-pi/issues/14248), [#16974](https://github.com/can1357/oh-my-pi/pull/16974) by [@lavinhoque33](https://github.com/lavinhoque33))
- Fixed the `eval` tool description so JS sessions see which helpers need `await` ([#16808](https://github.com/can1357/oh-my-pi/pull/16808) by [@bigHippoZz](https://github.com/bigHippoZz))
- Fixed the `eval` agent and judge docs so JS sessions see which handle, pool and batch calls need `await`, and Python sessions with JS enabled see `agent()`'s `schema_mode` keyword instead of JS's `schemaMode` ([#16810](https://github.com/can1357/oh-my-pi/pull/16810) by [@bigHippoZz](https://github.com/bigHippoZz))
- Fixed a classifier refusal on an Anthropic model ending the turn with the rest of an Anthropic `retry.fallbackChains` entry untried once the conversation carried signed thinking; the refusal now moves to the next model in the chain ([#17024](https://github.com/can1357/oh-my-pi/pull/17024) by [@sjawhar](https://github.com/sjawhar))
- Fixed the bash tool blocking commands such as `echo hi; make 2>build.err`, and sending `cat > file <<'EOF'` to `read` ([#17022](https://github.com/can1357/oh-my-pi/pull/17022) by [@sjawhar](https://github.com/sjawhar))
- Empty-stop retry exhaustion now reports provider usage without claiming that output was filtered or dropped, and same-model retries of content-less `MALFORMED_RESPONSE`/`UNEXPECTED_TOOL_CALL` errors inject a corrective tool-call reminder instead of replaying the identical cached prefix ([#17063](https://github.com/can1357/oh-my-pi/pull/17063) by [@martijnberger](https://github.com/martijnberger))
- Fixed automatic compaction committing summaries that increase context and repeatedly retrying the same retained-history cut point; token counts now include trailing tool results and post-compaction rescue ([#16904](https://github.com/can1357/oh-my-pi/pull/16904) by [@eggpeat](https://github.com/eggpeat))
- Fixed `/tan` dropping the images attached to its draft: the background agent now gets them with its request and keeps them, as admitted, when compaction restores the request; they leave the composer once `/tan` starts, so the next message cannot send them again, and come back with the draft when it cannot start ([#16805](https://github.com/can1357/oh-my-pi/pull/16805) by [@lemonleks](https://github.com/lemonleks))
- Fixed `/btw` dropping the images attached to its question: the side request now sends them, and like `/tan` they leave the composer once it starts and come back with the draft when it cannot; BTW history keeps each question's images (`images` on the RPC BTW records), so every follow-up sends them again, and a follow-up in the BTW history also takes pasted images ([#13890](https://github.com/can1357/oh-my-pi/issues/13890), [#16805](https://github.com/can1357/oh-my-pi/pull/16805) by [@lemonleks](https://github.com/lemonleks))
- `/omfg`, `/handoff` and `/cleanse` no longer run without the images attached to their draft: they keep the draft and say they take text only ([#16805](https://github.com/can1357/oh-my-pi/pull/16805) by [@lemonleks](https://github.com/lemonleks))
- Fixed an image pasted while an extension input hook held a submission being dropped from the next message: once the submitted images leave the composer, the images that stay are renumbered from `#1` ([#16805](https://github.com/can1357/oh-my-pi/pull/16805) by [@lemonleks](https://github.com/lemonleks))
- Fixed a collab guest losing the draft of a host-only command that takes its draft out of the composer on Enter (`/plan`, `/goal`, `/tan`, `/btw` and others): the draft now comes back with its images ([#16805](https://github.com/can1357/oh-my-pi/pull/16805) by [@lemonleks](https://github.com/lemonleks))
- Fixed a hashline `PUT` whose body repeats the line just above or below its range (or both), and is shorter than the range, silently deleting the range's other lines or writing a neighbouring line twice in Python, TypeScript and other parsed files; it is now refused, and the "too short" refusal names the lines the body leaves out ([#17028](https://github.com/can1357/oh-my-pi/pull/17028) by [@sjawhar](https://github.com/sjawhar))
- Fixed `computer` runs in subagents and `omp -p` stopping at their first `control.acquire`: they now keep working through background window input and report only a step that needs foreground control ([#16909](https://github.com/can1357/oh-my-pi/pull/16909) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed resuming anonymized sessions with text tool results crashing before the next model request ([#16859](https://github.com/can1357/oh-my-pi/issues/16859), [#16896](https://github.com/can1357/oh-my-pi/pull/16896) by [@tneemo](https://github.com/tneemo))
- Fixed the mid-run todo nudge going silent for the rest of a long turn after two nudges: a `todo` call now re-arms the per-turn budget instead of waiting for the next user prompt ([#16962](https://github.com/can1357/oh-my-pi/pull/16962) by [@omertahaoztop](https://github.com/omertahaoztop))
- xAI web and X searches now run Grok's hosted search instead of failing with `returned no sources` or falling back to engines that cannot read X posts ([#16947](https://github.com/can1357/oh-my-pi/pull/16947) by [@BAKocska](https://github.com/BAKocska))
- Fixed `/delete` leaving an empty zero-turn session on disk when you quit before sending a message ([#11303](https://github.com/can1357/oh-my-pi/issues/11303), [#16798](https://github.com/can1357/oh-my-pi/pull/16798) by [@NewtonChutney](https://github.com/NewtonChutney))
- Idle recap no longer runs when the prior message was not generated (a user message, or an assistant turn that produced no output). A generated assistant reply still recaps after the idle delay ([#16978](https://github.com/can1357/oh-my-pi/pull/16978) by [@atacolak](https://github.com/atacolak))
- Fixed an extension loading twice, so every handler ran twice, when the same file was reachable both through a symlink and its target, such as a link in the agent `extensions/` directory plus `--extension` with the real path; discovery now dedupes extension paths by real file ([#16788](https://github.com/can1357/oh-my-pi/pull/16788) by [@wolfiesch](https://github.com/wolfiesch))
- Fixed the `write` refusal in read-only subagents saying filesystem writes are unavailable; it now gives the on-disk path of `local://` files, so the agent can tell its caller where its report is ([#17023](https://github.com/can1357/oh-my-pi/pull/17023) by [@sjawhar](https://github.com/sjawhar))
- Fixed `wait` saying a subagent "finished its turn without replying" (and to ask again) after that subagent's result had already arrived as a background-job result, for a follow-up that woke it or that it got while running ([#16929](https://github.com/can1357/oh-my-pi/pull/16929) by [@sjawhar](https://github.com/sjawhar))
- Fixed a Markdown link to a local path that cannot be encoded pointing at a broken target instead of staying plain text ([#16806](https://github.com/can1357/oh-my-pi/pull/16806) by [@laviRZ](https://github.com/laviRZ))
- Fixed the Agent Hub reordering its rows on every heartbeat while it loaded the session's saved subagents, so no row could be selected until the load ended: a row's place is now fixed when the hub first shows it, agents found on disk take their place in the status/recency ranking, and a scan reads a transcript again only after it changed, so reopening the hub on a session with many saved agents no longer rereads them all ([#10524](https://github.com/can1357/oh-my-pi/issues/10524), [#16952](https://github.com/can1357/oh-my-pi/pull/16952) by [@lemonleks](https://github.com/lemonleks))
- `omp usage` now shows the Codex credit spend cap for credit-billed ChatGPT Business/Enterprise seats (previously `no limits reported`), and rounds fractional credit amounts to two decimals ([#16973](https://github.com/can1357/oh-my-pi/pull/16973) by [@DusKing1](https://github.com/DusKing1))
- Fixed browser calls right after a click that navigates (headless, connected and relay Chrome) reaching the page being left: reads and screenshots returned the old page or failed with `Execution context was destroyed` or `Cannot find context with specified id`, and a `fill` could land on the old form; they now wait for the new page ([#16907](https://github.com/can1357/oh-my-pi/pull/16907) by [@will-bogusz](https://github.com/will-bogusz))
- With `bash.gitGuard` on, a repository that once finished a conflicted rebase no longer counts as mid-conflict forever, which had let `git checkout`, `switch` and `restore` through; branch switches such as `git checkout -B <branch> <commit>` stay refused during a real merge or rebase too, abbreviated options such as `git reset --ha` are refused like the full ones, and `git stash create` is allowed ([#16919](https://github.com/can1357/oh-my-pi/pull/16919) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the compiled `omp` binaries trusting certificates from the compromised eMudhra intermediate CAs (CVE-2026-91403) and carrying the Brotli decoder out-of-bounds write (CVE-2026-111497); release binaries now build on Bun 1.4.4 ([#16822](https://github.com/can1357/oh-my-pi/issues/16822), [#16865](https://github.com/can1357/oh-my-pi/pull/16865) by [@bse-ai](https://github.com/bse-ai))
- Fixed TTSR rule matching slowing down quadratically on long tool calls such as `bash`, `eval` or `task` arguments: their streamed JSON escapes newlines, so every delta rescanned the whole argument (a 64 KB call with 10 rules took 120 ms of matching, now 4.5 ms). A long unterminated line is now rescanned as it grows by a quarter, and the final check still scans all of it ([#14248](https://github.com/can1357/oh-my-pi/issues/14248), [#16974](https://github.com/can1357/oh-my-pi/pull/16974) by [@lavinhoque33](https://github.com/lavinhoque33))
- Fixed the `eval` tool description so JS sessions see which helpers need `await` ([#16808](https://github.com/can1357/oh-my-pi/pull/16808) by [@bigHippoZz](https://github.com/bigHippoZz))
- Fixed the `eval` agent and judge docs so JS sessions see which handle, pool and batch calls need `await`, and Python sessions with JS enabled see `agent()`'s `schema_mode` keyword instead of JS's `schemaMode` ([#16810](https://github.com/can1357/oh-my-pi/pull/16810) by [@bigHippoZz](https://github.com/bigHippoZz))
- Fixed a classifier refusal on an Anthropic model ending the turn with the rest of an Anthropic `retry.fallbackChains` entry untried once the conversation carried signed thinking; the refusal now moves to the next model in the chain ([#17024](https://github.com/can1357/oh-my-pi/pull/17024) by [@sjawhar](https://github.com/sjawhar))
- Fixed the bash tool blocking commands such as `echo hi; make 2>build.err`, and sending `cat > file <<'EOF'` to `read` ([#17022](https://github.com/can1357/oh-my-pi/pull/17022) by [@sjawhar](https://github.com/sjawhar))
- Empty-stop retry exhaustion now reports provider usage without claiming that output was filtered or dropped, and same-model retries of content-less `MALFORMED_RESPONSE`/`UNEXPECTED_TOOL_CALL` errors inject a corrective tool-call reminder instead of replaying the identical cached prefix ([#17063](https://github.com/can1357/oh-my-pi/pull/17063) by [@martijnberger](https://github.com/martijnberger))
- Fixed automatic compaction committing summaries that increase context and repeatedly retrying the same retained-history cut point; token counts now include trailing tool results and post-compaction rescue ([#16904](https://github.com/can1357/oh-my-pi/pull/16904) by [@eggpeat](https://github.com/eggpeat))
- Fixed `/tan` dropping the images attached to its draft: the background agent now gets them with its request and keeps them, as admitted, when compaction restores the request; they leave the composer once `/tan` starts, so the next message cannot send them again, and come back with the draft when it cannot start ([#16805](https://github.com/can1357/oh-my-pi/pull/16805) by [@lemonleks](https://github.com/lemonleks))
- Fixed `/btw` dropping the images attached to its question: the side request now sends them, and like `/tan` they leave the composer once it starts and come back with the draft when it cannot; BTW history keeps each question's images (`images` on the RPC BTW records), so every follow-up sends them again, and a follow-up in the BTW history also takes pasted images ([#13890](https://github.com/can1357/oh-my-pi/issues/13890), [#16805](https://github.com/can1357/oh-my-pi/pull/16805) by [@lemonleks](https://github.com/lemonleks))
- `/omfg`, `/handoff` and `/cleanse` no longer run without the images attached to their draft: they keep the draft and say they take text only ([#16805](https://github.com/can1357/oh-my-pi/pull/16805) by [@lemonleks](https://github.com/lemonleks))
- Fixed an image pasted while an extension input hook held a submission being dropped from the next message: once the submitted images leave the composer, the images that stay are renumbered from `#1` ([#16805](https://github.com/can1357/oh-my-pi/pull/16805) by [@lemonleks](https://github.com/lemonleks))
- Fixed a collab guest losing the draft of a host-only command that takes its draft out of the composer on Enter (`/plan`, `/goal`, `/tan`, `/btw` and others): the draft now comes back with its images ([#16805](https://github.com/can1357/oh-my-pi/pull/16805) by [@lemonleks](https://github.com/lemonleks))
- Fixed a hashline `PUT` whose body repeats the line just above or below its range (or both), and is shorter than the range, silently deleting the range's other lines or writing a neighbouring line twice in Python, TypeScript and other parsed files; it is now refused, and the "too short" refusal names the lines the body leaves out ([#17028](https://github.com/can1357/oh-my-pi/pull/17028) by [@sjawhar](https://github.com/sjawhar))
- Fixed `omp gc --compress` exiting with "the event loop drained while it was still pending" on Bun 1.3.14 when a session artifact is pretty-printed JSON larger than 1 MiB, and session header probes (gc, session move and transfer) reading whole artifacts on Windows ([#15745](https://github.com/can1357/oh-my-pi/issues/15745), [#16754](https://github.com/can1357/oh-my-pi/pull/16754) by [@wolfiesch](https://github.com/wolfiesch))
- `/resume` into another session now cancels the previous session's background jobs, as `/new` does, instead of delivering their results into the resumed session and starting a turn there ([#16760](https://github.com/can1357/oh-my-pi/pull/16760) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the models config migration writing `models.yml` readable by other users on the machine, and dropping every custom provider when the write was interrupted; the migrated file is now published atomically with owner-only permissions ([#16654](https://github.com/can1357/oh-my-pi/pull/16654) by [@adi-IL](https://github.com/adi-IL))
- Fixed `/memory clear` in one project deleting the memory state of every other project that shares the same agent directory ([#16657](https://github.com/can1357/oh-my-pi/pull/16657) by [@adi-IL](https://github.com/adi-IL))
- Fixed the classic `/usage` report averaging distinct quota buckets that share a label and window (Google Antigravity's Gemini and Gemini 4 Argon weeklies) into one "50% free" row that hid the drained bucket; groups now split by quota identity while shared buckets still merge ([#16790](https://github.com/can1357/oh-my-pi/issues/16790))
- Fixed `read` of a web page failing with HTTP 403 or 429 when the site serves the page to another user agent, as SEC EDGAR filings, Ars Technica, AP News and Yahoo Finance do: a refused request now retries with the next user agent whatever its error page says ([#16593](https://github.com/can1357/oh-my-pi/pull/16593) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `grep` trimming a file to its first 20 matches in a multi-file search (200 in a single file) without telling the agent; the result now names the trimmed files and how to see the rest, and no longer reports the file total as `N+` when every file was searched ([#16594](https://github.com/can1357/oh-my-pi/pull/16594) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed isolated task capture failing with `patch does not apply: <path> does not exist` when the worker's commits leave untracked baseline files of the parent checkout untouched: the baseline work-in-progress is replayed before the worker's delta and rewound afterwards ([#16648](https://github.com/can1357/oh-my-pi/pull/16648) by [@Komzpa](https://github.com/Komzpa))
- Fixed a project-wide LSP rename corrupting files that were edited outside OMP while open: the rename now syncs every open document (not just the requested file) before the workspace edit is computed, so the server's ranges match the current disk text instead of writing the identifier into blank lines ([#15772](https://github.com/can1357/oh-my-pi/issues/15772), [#16649](https://github.com/can1357/oh-my-pi/pull/16649) by [@holny](https://github.com/holny))
- Fixed local memory stage-1 extraction sending prior assistant reasoning to Claude, causing `reasoning_extraction` refusals and lost memories ([#16679](https://github.com/can1357/oh-my-pi/issues/16679)).
- Fixed each `rewind` report being sent to the model twice (as a `Branch-return summary` and as the `Checkpoint called and rewound` report); it now appears once per checkpoint/rewind cycle, while the transcript still shows the branch summary ([#16702](https://github.com/can1357/oh-my-pi/issues/16702))
- Browser relay opens fail immediately with Chrome's reason (e.g. `Host access is restricted by policy.` on Chromium 155+ with an extension debugger policy) instead of timing out, and close the tab Chrome refused ([#16748](https://github.com/can1357/oh-my-pi/issues/16748))
- Collab guests can answer a pending question after the host reconnects to the relay without duplicated answer controls ([#16682](https://github.com/can1357/oh-my-pi/pull/16682) by [@DAnaeto](https://github.com/DAnaeto))
- Fixed `dd … of=/dev/null` (and other write-only sinks such as `/dev/stdout` and `/dev/fd/1`) triggering the unoverridable critical-command approval prompt; `dd` to real devices like `/dev/sda` still prompts ([#16714](https://github.com/can1357/oh-my-pi/issues/16714))
- Fixed Word and EPUB `read`s, site-specific web scrapers (Stack Overflow, MDN, GitLab, …) and the browser's readable page extraction writing identifiers as `snake\_case` or `DOCX\_NEEDLE\_1` (filtered plain text dropped the underscores): underscores inside words now stay literal ([#16607](https://github.com/can1357/oh-my-pi/pull/16607) by [@will-bogusz](https://github.com/will-bogusz))
- Tagging a model with `^` in a message sent while the agent is working no longer splits it in two: the model learns the new `m<N>` agent and reads your message in the same turn, instead of replying to the announcement alone first ([#16614](https://github.com/can1357/oh-my-pi/pull/16614) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed subagent model resolution skipping an authenticated later entry of the configured model list: when the first resolved model has no credentials, the remaining entries are tried in order before the parent session's model. ([#16640](https://github.com/can1357/oh-my-pi/pull/16640) by [@Komzpa](https://github.com/Komzpa))
- Fixed background job widgets rejecting percentage progress with `meter.total: 100 appears nowhere in the job or its output`; a meter may now use a total of 100 when every value feeding it was printed as a percentage ([#16885](https://github.com/can1357/oh-my-pi/pull/16885) by [@alphastorm](https://github.com/alphastorm))
- Fixed `openai-models-list` discovery leaving models that advertise their own reasoning levels (`supported_reasoning_levels` and `default_reasoning_level`, top-level or under `metadata` as codex-lb sends them) non-reasoning when the id is absent from the bundled catalog, so requests never carried `reasoning_effort` ([#16650](https://github.com/can1357/oh-my-pi/pull/16650) by [@Komzpa](https://github.com/Komzpa))
- Fixed marketplace auto-update leaving cloned checkouts behind after startup errors; abandoned clones are removed on a later refresh ([#16693](https://github.com/can1357/oh-my-pi/issues/16693))
- Fixed an extension's idle `pi.sendMessage({ display: true }, { deliverAs: "nextTurn", triggerTurn: false })` clearing and replaying the whole transcript, which froze input for longer as the session grew; the message is now appended to the existing transcript ([#16744](https://github.com/can1357/oh-my-pi/pull/16744) by [@OriginalByteMe](https://github.com/OriginalByteMe))
- Fixed `app.target` rejecting CDP page ids, including fresh `about:blank` pages, and added ids to unmatched-target listings ([#16619](https://github.com/can1357/oh-my-pi/issues/16619))
- Fixed reading `proc://<id>/kill` or `proc://<id>/mode` answering only "writable only", so agents often moved on with the job still running; the error now names the `write` call that cancels the job or sets the mode, with the real id ([#16580](https://github.com/can1357/oh-my-pi/pull/16580) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `history://<id>` failing with "has no transcript: session is gone" for a worker that is still running but has not created its session or transcript file yet; it now answers "No transcript has been written yet". ([#16645](https://github.com/can1357/oh-my-pi/pull/16645) by [@Komzpa](https://github.com/Komzpa))
- Fixed the `eval` tool telling sessions with only the Python runtime to call `tool.<name>(args)` without `await`, which returns a coroutine and never runs the tool ([#16578](https://github.com/can1357/oh-my-pi/pull/16578) by [@will-bogusz](https://github.com/will-bogusz))
- Task subagents on models that opt into shared prompt caching now share one cache key with their same-type siblings, even when the parent runs another model or the child switches models later; `/compact` and auto-compaction use that key against the model the compaction request actually sends, and keep the session's own id when no key applies ([#16988](https://github.com/can1357/oh-my-pi/pull/16988) by [@rafalopilowski1](https://github.com/rafalopilowski1))
- Fixed `omp auth-broker serve` token refreshes that hang continuing past the refresh deadline and keeping other refreshes of that credential waiting: the deadline now cancels the token request ([#16291](https://github.com/can1357/oh-my-pi/pull/16291) by [@will-bogusz](https://github.com/will-bogusz))
- The advisor docs now say a quota-paused advisor resumes only when its runtime is reset or rebuilt (compaction, a session switch, `/advisor`, a config reload or a restart), not after a cooldown ([#16766](https://github.com/can1357/oh-my-pi/pull/16766) by [@will-bogusz](https://github.com/will-bogusz))
- The `power.sleepPrevention` setting now says it keeps the machine awake only while the agent is running a turn, not for as long as a session is open ([#16762](https://github.com/can1357/oh-my-pi/pull/16762) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the `computer` tool's `computer.window({ app })` failing for an app with no open window without saying what to do; the error now names the `computer.apps.open(…)` call that launches it (on macOS it also shows a window of a running app that has none), and `computer.window()` with no argument asks for a window id or filter instead of listing windows that "match undefined" ([#16912](https://github.com/can1357/oh-my-pi/pull/16912) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `read doc.pdf:page<N>.png` returning the PDF viewer's empty grey frame instead of the page on about half of reads ([#16585](https://github.com/can1357/oh-my-pi/pull/16585) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the `computer` tool prompt leaving `el.selectText` out of the element helpers; it now says a following `el.type` on that element replaces the selection ([#16769](https://github.com/can1357/oh-my-pi/pull/16769) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed language servers keeping every file omp ever opened loaded for the whole session; files unused for 5 minutes are now closed when omp opens another, so the server can free that memory ([#15418](https://github.com/can1357/oh-my-pi/pull/15418) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `write` turning a CRLF file into LF and dropping its UTF-8 BOM when it replaces the file; it now keeps both, as `edit` does ([#16575](https://github.com/can1357/oh-my-pi/pull/16575) by [@will-bogusz](https://github.com/will-bogusz))

## [18.12.6] - 2026-10-21

### Added

- Added the `_session/steering` ACP extension (advertised as `_meta.steering.supported`), so clients such as agent-shell can steer a running turn; a steer sent while a permission dialog is open cancels that dialog, and `_meta.steering.queue: "followUp"` queues a follow-up instead ([#15885](https://github.com/can1357/oh-my-pi/pull/15885) by [@marcintustin](https://github.com/marcintustin))
- `/mcp reauth <name>` now works over ACP, RPC, and print mode (`omp -p '/mcp reauth <name>'`): it opens the browser, prints the authorization URL, reconnects the server in the running session, and print mode exits 1 when reauthorization fails ([#16046](https://github.com/can1357/oh-my-pi/pull/16046) by [@marcintustin](https://github.com/marcintustin))

### Changed

- ACP `session/cancel` now also cancels prompts that are queued or still dispatching, and stops autonomous runs, instead of being ignored when no client turn is streaming ([#15885](https://github.com/can1357/oh-my-pi/pull/15885) by [@marcintustin](https://github.com/marcintustin))
- Idle compaction no longer runs on logged-in OpenAI Codex accounts, whose prompt cache never expires; compacting while idle only threw away a warm cache
- ACP sessions no longer fail to start when a client-declared MCP server cannot connect; the failure is reported in the session, and an HTTP/SSE server can be repaired with `/mcp reauth` ([#16046](https://github.com/can1357/oh-my-pi/pull/16046) by [@marcintustin](https://github.com/marcintustin))
- `/mcp reauth`, `/mcp test`, and `/mcp unauth` now pick the project entry when a server is defined in both project and user config, and skip project config when `mcp.enableProjectConfig` is off ([#16046](https://github.com/can1357/oh-my-pi/pull/16046) by [@marcintustin](https://github.com/marcintustin))
- `/mcp reauth` removes the server's stale `Authorization` header from its config when it writes the new OAuth binding ([#16046](https://github.com/can1357/oh-my-pi/pull/16046) by [@marcintustin](https://github.com/marcintustin))
- `omp -p '/compact'`, `/handoff`, and `/retry` given as CLI arguments now run the command instead of sending the text to the model, and exit 1 when the command fails; slash text arriving on stdin or from `@file` is still sent to the model ([#16387](https://github.com/can1357/oh-my-pi/pull/16387) by [@marcintustin](https://github.com/marcintustin))
- Interactive startup no longer waits for extensions that register only tools, commands, flags, renderers, or event hooks (for example MCP bridge plugins): they load once the composer accepts input, and your first message waits for them instead. An extension is deferred only after one launch has confirmed it registers no providers, shortcuts, composer shapes, or file fallbacks. Launches that resume a session, pass `--tools`, or pass flags omp does not recognize still load every extension first ([#16684](https://github.com/can1357/oh-my-pi/pull/16684) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed subagents whose role has an explicitly empty fallback chain falling back through the `default` chain when the default role uses the same model, including after a retry fallback, prewalk or context promotion briefly switched models or the subagent was revived ([#16548](https://github.com/can1357/oh-my-pi/pull/16548) by [@eggpeat](https://github.com/eggpeat))
- Fixed `/usage` and `omp usage --json` listing identity-less OAuth accounts such as Devin as missing usage beside their working reports ([#16549](https://github.com/can1357/oh-my-pi/pull/16549) by [@eggpeat](https://github.com/eggpeat))
- Fixed releasing or reaping a browser tab returning while Chromium still listed the page; the close now waits until Chromium reports the tab destroyed ([#16680](https://github.com/can1357/oh-my-pi/pull/16680) by [@H4vC](https://github.com/H4vC))
- Fixed the advisor prompt forbidding all repeated advice, including real escalations: advisors may now re-raise a prior nit or concern as a blocker once new evidence makes it one ([#13887](https://github.com/can1357/oh-my-pi/issues/13887), [#16484](https://github.com/can1357/oh-my-pi/pull/16484) by [@pjh890321](https://github.com/pjh890321))
- Fixed Esc no longer interrupting in the TUI after a second MCP OAuth login replaced an unfinished first one ([#16046](https://github.com/can1357/oh-my-pi/pull/16046) by [@marcintustin](https://github.com/marcintustin))

## [18.12.5] - 2026-10-21

### Added

- `providers.cacheRetention: long` now keeps OpenAI GPT-5.6+ prompt caches for 12 hours (Responses API; cache writes cost 2.5× input instead of 1.25×)

### Fixed

- Fixed subagents spawning at a caller-supplied `effort` (e.g. `hi` → `max`) while `task.enableEffort` is off; the field is now ignored and the agent's configured thinking level (including `:auto`) applies ([#16402](https://github.com/can1357/oh-my-pi/issues/16402))
- Fixed `omp update --check` failing against JFrog Artifactory registries that add empty `dist-tags` to a tagged manifest; the update check now uses the registry's curated latest version ([#16375](https://github.com/can1357/oh-my-pi/issues/16375))
- Fixed `<path>:conflicts` on a file past the 10 MiB scan cap reporting no conflicts with no hint: it now names the line the scan stopped at and the ranged `read` that registers the blocks after it ([#16269](https://github.com/can1357/oh-my-pi/pull/16269))
- Fixed the `ts-set-map` rule stalling tool-call streaming for seconds on a long single-line `Map` literal, and missing `Map` entries written `["key", value] as const` ([#16242](https://github.com/can1357/oh-my-pi/pull/16242))
- Fixed the `ts-import-type` rule missing inline type imports whose member name is non-ASCII, such as `import("./units").温度` ([#16242](https://github.com/can1357/oh-my-pi/pull/16242))

## [18.12.4] - 2026-10-20

### Added

- `bash` tool commands now see `PI_SESSION_ID` and `PI_SESSION_FILE`, so a script can find the running session's ID and transcript path ([#16442](https://github.com/can1357/oh-my-pi/pull/16442) by [@johnrichardrinehart](https://github.com/johnrichardrinehart) and [@will-bogusz](https://github.com/will-bogusz))
- Added GitLab merge request support to `/review` and `/annotate code-review`: pass an MR URL, pick one mentioned in the conversation, or choose "Review a specific PR/MR" in a GitLab checkout to list open MRs (requires `glab`); large MRs link per-file diffs through the new `mr://<host>/<group>/<project>/<iid>/diff` URLs ([#16361](https://github.com/can1357/oh-my-pi/pull/16361) by [@Shadorain](https://github.com/Shadorain))
- Added MCP tool progress: `tools/call` requests ask the server for `notifications/progress` when the progress can be shown, and updates appear in the running tool card and as an in-place `mcp_progress` status line in Eval cells, including after auto-backgrounding; request deadlines and Eval timeouts are unchanged ([#16431](https://github.com/can1357/oh-my-pi/pull/16431) by [@alphastorm](https://github.com/alphastorm))
- Added image attachments to single and batch eval `judge()`/`judge_batch()` calls (local paths or embedded images); image judgments skip candidates without image support and fail explicitly instead of dropping images ([#15471](https://github.com/can1357/oh-my-pi/pull/15471) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy))
- Added a job tree to `/jobs`, `/jobs full` and the jobs pill's sheet, in the terminal UI and over ACP: subagents' background jobs now appear nested under the task that runs them, with the busiest branches listed first; only your own jobs offer Cancel ([#15854](https://github.com/can1357/oh-my-pi/pull/15854) by [@H4vC](https://github.com/H4vC))
- Added `ctx.ui.getEditorComponent()` so extensions can wrap the active custom editor factory instead of replacing it ([#8655](https://github.com/can1357/oh-my-pi/pull/8655) by [@jovi-tsx](https://github.com/jovi-tsx))
- `omp auth-gateway serve` and `check` can be limited to the providers and API keys the account-pool file allows, using `"*": false` and `"apiKeys": false` ([#14235](https://github.com/can1357/oh-my-pi/pull/14235) by [@will-bogusz](https://github.com/will-bogusz))
- `omp usage` shows an account's `reclaimAbovePct` next to its priority and reserve ([#14237](https://github.com/can1357/oh-my-pi/pull/14237) by [@will-bogusz](https://github.com/will-bogusz))

### Changed

- An agent that messages another agent can now `wait` for the reply instead of erroring; the wait ends early, without an error, once the agent asked finishes its turn without replying or is itself waiting on the caller's result ([#16445](https://github.com/can1357/oh-my-pi/pull/16445) by [@will-bogusz](https://github.com/will-bogusz))
- Built-in style rule reminders no longer tell the model a user-defined rule matched and it MUST comply; they ask it to check its code against the rule and its exceptions, so models rewrite code a built-in rule allows less often ([#16420](https://github.com/can1357/oh-my-pi/pull/16420) by [@will-bogusz](https://github.com/will-bogusz))
- `read` of a SQLite `?q=SELECT …` query now accepts `&limit=` and `&offset=` and pages the query's rows, as table reads and JSON `?q=` reads already do, instead of rejecting the read ([#16444](https://github.com/can1357/oh-my-pi/pull/16444) by [@will-bogusz](https://github.com/will-bogusz))
- Agents using the `browser` tool are steered to wait for the text, URL or element they need after a click or navigation instead of sleeping a fixed time, which can finish steps sooner on pages that load content after a variable delay ([#16404](https://github.com/can1357/oh-my-pi/pull/16404) by [@will-bogusz](https://github.com/will-bogusz))
- The pinned Subagents list shows how many agents are running and the agent hub key, and previews an agent's assignment at full width instead of the first 40 characters of its prompt template ([#16486](https://github.com/can1357/oh-my-pi/pull/16486) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed auto-QA reports whose tool is a URI (`xd://tui: …`) being filed under the wrong tool name; a one-line report without `: ` after its tool name is now refused with the format hint ([#16278](https://github.com/can1357/oh-my-pi/pull/16278) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed agents guessing `conflict://<N>` ids for merge conflicts a ranged `read` didn't show: the warning and the not-found error now point to `<path>:conflicts` to register them ([#16269](https://github.com/can1357/oh-my-pi/pull/16269) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed agents opening your own Chrome through the relay (with `browser.relay` on) when they asked the `browser` tool for Chromium with `app.tern: false`; the tool now points them to `app.relay: false` ([#16294](https://github.com/can1357/oh-my-pi/pull/16294) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `%pip install` in Python eval failing with "No module named pip" when the kernel's interpreter is a venv without pip, such as one made by `uv venv`: it now installs pip into that venv first, with `ensurepip` or, where that is unavailable, `uv` ([#16300](https://github.com/can1357/oh-my-pi/pull/16300) by [@will-bogusz](https://github.com/will-bogusz))
- Reduced HTTP 413 failures on Factory Droid once a session's screenshots and pasted images pass Factory's 4.5 MB request limit: older inline images are now dropped to keep them under 3.5 MB, while the newest message's and newest tool result's images stay when they alone fit the limit; a custom gateway `baseUrl` is left alone ([#16288](https://github.com/can1357/oh-my-pi/pull/16288) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed hashline edits under an older tag overwriting the wrong line when their line numbers came from `grep -n`, `sed -n` or a `:raw` read: a shifted edit whose body matches the current line at those numbers, or that breaks the file's syntax, is now rejected with the current tag and lines ([#16383](https://github.com/can1357/oh-my-pi/pull/16383) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `PI_SESSION_FILE` in `eval` cells being a relative path when omp was started with a relative `--session-dir` (or `PI_CODING_AGENT_SESSION_DIR`), so it no longer worked once code changed directory ([#16442](https://github.com/can1357/oh-my-pi/pull/16442) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed waking a parked subagent re-sending its whole conversation without the prompt cache whenever other agents had started, finished or parked meanwhile ([#15523](https://github.com/can1357/oh-my-pi/issues/15523)) ([#16369](https://github.com/can1357/oh-my-pi/pull/16369) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `edit` accepting changes to lines nothing showed after a stale or unknown tag: a resend under the current tag from the rejection now passes the seen-line check only on the rows that rejection printed (or a retained `read` showed), so a line seen only through `bash` is no longer overwritten blind ([#16422](https://github.com/can1357/oh-my-pi/pull/16422) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed plugin settings marked `secret` being readable by other local users in `omp-plugins.lock.json`; the lockfile is now written owner-only (0600) ([#12999](https://github.com/can1357/oh-my-pi/issues/12999), [#16368](https://github.com/can1357/oh-my-pi/pull/16368) by [@jonasboos](https://github.com/jonasboos))
- Fixed agents misreading `computer.windows()` results on their first call ([#16299](https://github.com/can1357/oh-my-pi/pull/16299) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed GitLab merge request reads rendering `[object Promise]` instead of the description ([#16477](https://github.com/can1357/oh-my-pi/pull/16477) by [@adi-IL](https://github.com/adi-IL))
- Fixed `/restart` losing the active named profile and failing to resume its session ([#15742](https://github.com/can1357/oh-my-pi/pull/15742) by [@sapran](https://github.com/sapran))
- Fixed aborted and timed-out stdio MCP requests continuing to run on the server: OMP now sends `notifications/cancelled` with the original request id, once and never for `initialize`, after settling the call and without waiting on the pipe ([#16430](https://github.com/can1357/oh-my-pi/pull/16430) by [@alphastorm](https://github.com/alphastorm))
- Fixed the agent restarting on its own after you stopped it with Esc whenever a background subagent or job finished; the result is recorded in the transcript and the agent waits for your next message
- Fixed Mnemopi memory completions ignoring the memory role's thinking suffix, including one inherited from `tiny` or `smol` when `modelRoles.memory` is unset; each `retry.fallbackChains.memory` entry sends its own level, and `:off` disables reasoning ([#16378](https://github.com/can1357/oh-my-pi/pull/16378) by [@alphastorm](https://github.com/alphastorm))
- Fixed MCP tools running a call twice when the server connection dropped mid-request: a stdio request already written to the server, or an HTTP or legacy SSE request whose connection reset or closed after it was sent, now fails as non-retryable with a diagnostic saying it may have run, instead of being replayed after a reconnect; requests that never left OMP, including refused connections, still reconnect and retry once ([#16429](https://github.com/can1357/oh-my-pi/pull/16429) by [@alphastorm](https://github.com/alphastorm))
- Fixed `/move` path completion jumping into a subfolder on Tab: `..`, `.`, and `~` now complete to `../`, `./`, and `~/` before listing their children, a trailing `\` lists a folder on Windows, absolute Windows paths (`C:/…`) are no longer rewritten as relative paths, and the project directory is offered as `./` instead of `/`
- Fixed `edit` blaming boundary indentation when a one-row replacement only fails because its body ends with a trailing comma (e.g. the last element of a JSON array); the error now names the comma ([#16423](https://github.com/can1357/oh-my-pi/pull/16423) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a timed-out browser selector action dropping its match count without a word when omp could not count the matches; the error now says why ([#16389](https://github.com/can1357/oh-my-pi/pull/16389) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed every session in a project without `.vscode/mcp.json` logging a "[VS Code] Failed to read …/.vscode/mcp.json" warning; a missing file is now skipped silently, while an unreadable or unparsable one still warns ([#16434](https://github.com/can1357/oh-my-pi/pull/16434) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed agents opening pages in your own signed-in Chrome when `browser.relay` is on and you asked for a throwaway browser ([#16390](https://github.com/can1357/oh-my-pi/pull/16390) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the built-in `ts-no-tiny-functions` and `ts-promise-with-resolvers` rules reminding you about code they allow: exported functions, public class and object members, type guards, `if`/`try`/`catch` blocks, and never-settling `new Promise(() => {})` ([#16419](https://github.com/can1357/oh-my-pi/pull/16419) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `read` losing the last lines of a comma list that pairs ranges with a tail (`file:1-30,-30`, `file:1-30,:-30`), and erroring on the same list for `artifact://` and other internal URLs; both parts are now read ([#16435](https://github.com/can1357/oh-my-pi/pull/16435) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `edit` rejecting a placeholder tag (`#AUTO`, `#????`), a missing tag, or a header with no ops without naming the file's current tag; these now get the same reply as an unknown tag, so the retry can use that tag instead of a `read` ([#16425](https://github.com/can1357/oh-my-pi/pull/16425) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `read` line ranges and tails (`:9-11`, `:-50`) of macOS `.sample.txt` reports and `.cpuprofile` files returning lines of the generated profile summary instead of the file, so edits from them were rejected as stale; the summary now appears only on a whole-file read, without line numbers ([#16397](https://github.com/can1357/oh-my-pi/pull/16397) by [@will-bogusz](https://github.com/will-bogusz))
- Models whose provider strips images from requests, such as DeepSeek V4 Flash on Venice or NanoGPT, now get text compaction and text-only image handling like text-only models; snapcompact archived onto frames that reached them as `[image omitted]` placeholders, and history images were still processed and uploaded before being dropped ([#16436](https://github.com/can1357/oh-my-pi/pull/16436) by [@will-bogusz](https://github.com/will-bogusz))
- Line range reads of `ssh://`, URLs and other in-memory resources no longer return only the line above the range when that line fills the 50KB budget; the page now starts at the requested line, and byte-limit notices state the 50KB limit instead of the bytes shown ([#16391](https://github.com/can1357/oh-my-pi/pull/16391) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed Auto-QA grievances sharing your home directory and login name with the qa.omp.sh collector; paths under your home are sent as `~/…`, and the login name inside labels and paths as `<user>`, including reports recorded before this fix ([#16409](https://github.com/can1357/oh-my-pi/pull/16409) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the `computer` tool's `control.acquire` prompt, left unanswered, failing the whole call with "Computer code execution timed out"; the prompt now expires shortly before the timeout and the call returns `reason: "unanswered"` ([#16388](https://github.com/can1357/oh-my-pi/pull/16388) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed reads whose optional leading context line exceeded the byte budget returning only the oversized-line notice or a preview of that context line and hiding the requested lines; the read now retries from the requested start without leading context ([#16485](https://github.com/can1357/oh-my-pi/pull/16485) by [@adi-IL](https://github.com/adi-IL)).
- Fixed `read path:N:raw` (and `:raw:N`, URLs included) returning a page from line `N` instead of the one line `N`; `grep` on internal and web URLs now filters `:N:raw` to that line too, and `:N-:raw` still runs on from `N` ([#16438](https://github.com/can1357/oh-my-pi/pull/16438) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed Anthropic web search answers breaking into separate paragraphs at every citation, with sentences split mid-way and lines starting with `.` ([#16396](https://github.com/can1357/oh-my-pi/pull/16396) by [@a-glapinski](https://github.com/a-glapinski))
- Fixed custom tools that import an `@oh-my-pi/*` package (such as `@oh-my-pi/pi-natives` or `@oh-my-pi/pi-utils`) failing to load with "Cannot find package" in the installed `omp` binary; they now get the host's copy, as extensions already did ([#16421](https://github.com/can1357/oh-my-pi/pull/16421) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed resuming a session selecting an abandoned branch after a late off-branch entry such as a background bash result; off-branch entries now record the active leaf they interrupted and replay restores it ([#16483](https://github.com/can1357/oh-my-pi/pull/16483) by [@adi-IL](https://github.com/adi-IL)).
- Fixed hashline `REM` deleting and `MV` moving a file under an invented or stale tag; a bare file op now needs the file's current tag, like a line edit ([#16381](https://github.com/can1357/oh-my-pi/pull/16381) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `write` deleting the leading numbers of every line in content such as hex dumps, disassembly and timestamped logs; it now removes copied `read` line numbers only when they count up by one, as `read` and `grep` print them ([#16441](https://github.com/can1357/oh-my-pi/pull/16441) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `auto` thinking chosen for the DEFAULT role in the `/model` hub reverting to the model's default effort (e.g. `max` on Z.AI `glm-5.3`) on the next launch ([#16370](https://github.com/can1357/oh-my-pi/issues/16370), [#16398](https://github.com/can1357/oh-my-pi/pull/16398) by [@alvadorn](https://github.com/alvadorn))
- Fixed Google Antigravity web search failing with false 429 quota-exhausted errors ([#11849](https://github.com/can1357/oh-my-pi/pull/11849) by [@jotafurtado](https://github.com/jotafurtado))
- Fixed omp exiting to the shell when the model picker (Alt+P) or model hub opened after compatibility extensions loaded ([#12293](https://github.com/can1357/oh-my-pi/issues/12293), [#12653](https://github.com/can1357/oh-my-pi/pull/12653) by [@wolfiesch](https://github.com/wolfiesch))
- Fixed todo lists set over RPC `set_todos` disappearing when the session is reloaded, resumed, or compacted; `RpcClient.setTodos()` sends the command ([#12590](https://github.com/can1357/oh-my-pi/pull/12590) by [@anthonyrisinger](https://github.com/anthonyrisinger))
- Fixed batch `task` calls silently running the default agent when a specialist such as `reviewer`, `scout`, or a custom agent was set at the top level instead of in `tasks[].agent`; the call is now rejected with that guidance ([#12610](https://github.com/can1357/oh-my-pi/pull/12610) by [@dbc-hbin](https://github.com/dbc-hbin))
- Fixed sessions started before an omp upgrade losing word completion and restarting the shared word-completion daemon every 30 seconds, which reloaded its model for every session on the new version; they now use the newer daemon ([#15610](https://github.com/can1357/oh-my-pi/issues/15610)) ([#16380](https://github.com/can1357/oh-my-pi/pull/16380) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed supported Bedrock Claude models falling back to soft instead of remote compaction ([#16343](https://github.com/can1357/oh-my-pi/pull/16343) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy))
- Fixed browser `tab.run(fn, [url])` and `browser.open("https://…")` failing with a bare "expects an options object"; the errors now say to pass `{ args: [...] }` and `browser.open({ url, name })` ([#16236](https://github.com/can1357/oh-my-pi/pull/16236) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the built-in `ts-set-map`, `ts-import-type` and `ts-no-any` rules reminding you about code they allow: an empty or computed `Set`/`Map`, a runtime `await import()`, or the word "any" in a comment ([#16242](https://github.com/can1357/oh-my-pi/pull/16242) by [@will-bogusz](https://github.com/will-bogusz))

## [18.12.3] - 2026-10-19

### Added

- Added the **Ask and remember** approval mode (`tools.approvalMode: always-ask-cached`, `--approval-mode always-ask-cached`): it also asks before file reads, and file prompts can remember the folder or the file, for this session or across sessions, through `approval-cache.db` ([#16049](https://github.com/can1357/oh-my-pi/pull/16049) by [@Peribunt](https://github.com/Peribunt))
- Added `/forget-approvals` to forget every file and folder approval Ask and remember has recorded ([#16049](https://github.com/can1357/oh-my-pi/pull/16049) by [@Peribunt](https://github.com/Peribunt))
- Extension `ui.approve()` hosts can render the new `prompt.grants` choices and answer `{ grant, always }`; hosts that ignore them keep answering `once`/`session`/`deny` ([#16049](https://github.com/can1357/oh-my-pi/pull/16049) by [@Peribunt](https://github.com/Peribunt))
- Extension and custom tools can declare `approvalCacheTargets` to take part in Ask and remember grants ([#16049](https://github.com/can1357/oh-my-pi/pull/16049) by [@Peribunt](https://github.com/Peribunt))
- Added `proc://<id>/streams` for bash jobs: it lists the command's pipes, and `proc://<id>/streams/<n>` shows what has crossed pipe `n` so far, so `cmd | tail -5` can be followed live without rerunning `cmd`
- Background job widgets are designed per job by the new `widget` model role (resolves like `smol` until you assign it): one request writes rules that read the job's output and its pipes (`cmd | tail` included), and every later update is computed locally with no further model calls or messages to the agent; a subagent gets a widget only once it says which output shows its progress, and a job with nothing worth charting gets none; turn them off with `async.widgets: false`
- Running subagents now show their current step, in their own words, on the task card; the periodic completion check also asks the subagent which output shows its progress, so the job widget knows what to chart
- The `wait` card shows the watched jobs as a row of tiles, each with its status, name (a subagent's in full), what it is doing, and its headline figure and live widget when it has one (a throughput chart with its target line, per-model bars, CI job status, trial progress), and a subagent's own completion estimate as a ring that turns from blue to green as it fills (hover the tile for the percentage); the HUD jobs pill shows the freshest job's headline and a mini chart, and hovering it opens a card with the running jobs as tiles; the jobs sheet shows the selected job's widget above its output, and the terminal status line appends the headline to the jobs count

### Changed

- While a subagent is focused, `/model`, `/switch`, `/effort`, `Alt+P`, `Ctrl+P`, and `Shift+Tab` change that subagent's model and thinking level (session-only) instead of telling you to return to the main session; `/model` and `Alt+M` open the session-only picker there, since role assignments configure the main session

### Fixed

- Fixed `omp skill list` omitting skills from a `skills.customDirectories` entry that starts with `~`; such an entry now resolves against your home directory, matching the skill loader ([#16347](https://github.com/can1357/oh-my-pi/pull/16347) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Fixed `grep` treating a `;`-separated list of internal URLs (e.g. `artifact://44;artifact://43`) as one URI and refusing to search it; every listed resource is now searched ([#14091](https://github.com/can1357/oh-my-pi/issues/14091))
- Fixed `grep` refusing a web URL that carries a `:raw` (or `:conflicts`) selector before the page was fetched; the selector now reaches the fetch, so `:raw` searches the verbatim response body ([#14092](https://github.com/can1357/oh-my-pi/issues/14092))
- Fixed browser `role/<role>[name="…" exact]` selectors in Chromium and Tern tabs matching nothing for many names copied from `observe()`; a button or link with visible text is no longer matched by its `title` ([#16252](https://github.com/can1357/oh-my-pi/pull/16252) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/tan` clones with Mnemopi auto-recall re-sending the parent's recalled memories as an extra system-prompt block, which duplicated them and missed the parent's prompt cache ([#16337](https://github.com/can1357/oh-my-pi/issues/16337))
- Fixed legacy pi extensions that import `contentText` from pi-ai or `formatSkillsForPrompt` from pi-coding-agent, such as `pi-claude-bridge`, failing to load ([#16313](https://github.com/can1357/oh-my-pi/pull/16313) by [@Jerryx333](https://github.com/Jerryx333))
- Fixed legacy Pi plugins such as `pi-ssh-remote` crashing at session start when reading shell settings through `SettingsManager` ([#16256](https://github.com/can1357/oh-my-pi/issues/16256))
- Fixed newly authenticated models missing from the current session's scoped `/model` picker and model cycle after login, including setup-wizard sign-in, without changing the active model or widening the configured scope ([#16234](https://github.com/can1357/oh-my-pi/pull/16234) by [@lazy1523](https://github.com/lazy1523))
- Fixed the `computer` tool's `control.acquire` returning the same `{ active: false }` when nobody could be asked (a subagent or headless run) as when you declined; it now reports `reason: "no-ui"` or `reason: "denied"` ([#16295](https://github.com/can1357/oh-my-pi/pull/16295) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a browser screenshot waiting past its deadline when Chrome was slow to open a DevTools session; it now stops at the deadline ([#16230](https://github.com/can1357/oh-my-pi/pull/16230) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a parked subagent waking up with the `todo` tool and its instructions when messaged, though subagents are spawned without them ([#16281](https://github.com/can1357/oh-my-pi/pull/16281) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `wait` failing with "Skipped due to a queued background completion" when the job it was waiting for had just finished; it now returns that job's result, and a steer, peer message or aside arriving at the same moment no longer turns a settled job or waiting peer message into that skip ([#16301](https://github.com/can1357/oh-my-pi/pull/16301) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the second of two extension asides (`pi.sendMessage(…, { deliverAs: "aside" })`) sent together to an idle session being lost; it now reaches the agent after the first ([#16292](https://github.com/can1357/oh-my-pi/pull/16292) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed every idle agent woken by an `agent://all` broadcast answering the sender automatically, mostly to say the message was not for it; a direct message still gets the woken agent's turn back ([#16312](https://github.com/can1357/oh-my-pi/pull/16312) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a subagent woken by an IRC message sending its waker and parent every line of text it wrote that turn run together (`Checking.Answer.`) instead of just its final answer ([#16302](https://github.com/can1357/oh-my-pi/pull/16302) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a parent follow-up sent while a peer-woken subagent was running leaving the accepted `agent://` result unchanged and skipping the parent's completion ([#16305](https://github.com/can1357/oh-my-pi/issues/16305))
- Fixed `yield` reporting success while silently omitting unsupported root fields; such calls are now rejected with an error naming the fields ([#16317](https://github.com/can1357/oh-my-pi/issues/16317))
- Fixed `brew install` and `brew upgrade` of omp failing with a 403 behind corporate proxies ([#16264](https://github.com/can1357/oh-my-pi/pull/16264) by [@debanjanbasu](https://github.com/debanjanbasu))
- Fixed browser timeouts in the release binary surfacing as raw errors such as `Og: Navigation timeout of 7000 ms exceeded`; a timed-out `tab.goto` or `browser.open` now stops the pending load and keeps the tab, as running from source did ([#16266](https://github.com/can1357/oh-my-pi/pull/16266) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `find`, `glob` and `ast_grep` always refusing `ssh://` paths with "ssh:// access needs exec approval; this command was approved at read": they now ask for `exec` approval like `read` and `grep` do ([#16285](https://github.com/can1357/oh-my-pi/pull/16285) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a `conflict://*` write of per-id lines with literal values (`1: foo`, `2: bar`) writing all of them into every conflict block and reporting success; it now fails without touching the file and points to per-block `conflict://<N>` writes ([#16267](https://github.com/can1357/oh-my-pi/pull/16267) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed hashline block edits (`PUT N*:`, `CUT N*`) applying over block lines a `read` never fully showed, such as a line cut at the column cap, which silently dropped that line's tail; they are now rejected like the equivalent explicit range ([#16209](https://github.com/can1357/oh-my-pi/issues/16209))
- Fixed a resumed session's next snapcompact compaction losing the newest archived history once the archive passed 500k characters, and drawing `[Session persistence truncated large content]` into its frames; the archive's source text is now saved whole ([#16282](https://github.com/can1357/oh-my-pi/pull/16282) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/compact`, `/new` or a session switch during a running tool dropping that tool's result from the session file, so the model and a resumed session saw "No result provided" instead of what the tool returned ([#16241](https://github.com/can1357/oh-my-pi/pull/16241) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `read` middle-eliding large file pages into an artifact; a page past the output spill threshold now stops at a line boundary with an exact `:N` continuation ([#16277](https://github.com/can1357/oh-my-pi/issues/16277))
- Fixed an edit after a restart replacing a line that `read` or `grep` had shown cut at the column cap and silently dropping the rest of that line; such edits now ask for a full `:raw` read of the line first, while edits to lines within the cap still apply ([#16171](https://github.com/can1357/oh-my-pi/issues/16171))
- Fixed Enter on an unknown slash command such as `/not-a-command` running a command whose description happened to match it (e.g. `/loop`, which then resent every later prompt after each turn); Enter now sends what you typed, including as the deny-and-steer message for a pending tool approval, unless you select a suggestion first ([#16265](https://github.com/can1357/oh-my-pi/issues/16265))
- Fixed `read` of web pages dropping collapsed sections such as accordion and expander panels (e.g. a product page's "Item details" table); content in `<template>`, `<noscript>` and scripts stays out ([#16246](https://github.com/can1357/oh-my-pi/issues/16246))
- Fixed `/mcp reauth` and `/mcp add` opening an unrelated origin-root authorization server's login page when the authorization server an MCP server advertises in its protected-resource metadata has invalid metadata; discovery now uses only the advertised servers and reports the issuer mismatch naming the server ([#16339](https://github.com/can1357/oh-my-pi/issues/16339))
- Fixed auto thinking offering the judge effort levels the current model does not support, which could leave a sparse-ladder model on the wrong level; with at most one usable level under the ceiling it now skips the judge call ([#16327](https://github.com/can1357/oh-my-pi/pull/16327) by [@savanne-kham](https://github.com/savanne-kham))
- Fixed subagents that were cancelled, interrupted, timed out, or killed refusing messages as "hard-aborted and cannot be messaged or revived": a message (or Agent Hub revive/focus) now resumes them from their transcript with full context
- Fixed interrupting a focused subagent to send it a queued message (empty Enter) sometimes ending its run as cancelled before it read the message; the subagent now answers the message and keeps working
- Fixed sessions whose first reply starts with a todo plan getting a title without its icon and code: the plan's title refresh no longer replaces the card title that is still being generated
- Fixed generated titles that come out without an icon and code (a subagent's title, a title-model fallback, a malformed card reply) staying plain: they now get a card like `/rename` titles do
- Fixed running the test suite adding fixture titles (`PLAN`, `renamed session`, …) to your real `~/.omp/agent/history.db`

## [18.12.2] - 2026-10-18

### Added

- Added `computer.backgroundFallback` (`takeover` by default, or `refuse`): when a `computer` window input call has no background route, the tool reruns that one call in takeover, hands focus back to your app and says so in its result; `refuse` fails the call instead and also refuses the agent's own foreground requests (`takeover: true`, `raise()`, an activating `apps.open`, desktop input, and on macOS menus and `AXOpen`) ([#15191](https://github.com/can1357/oh-my-pi/pull/15191) by [@will-bogusz](https://github.com/will-bogusz))
- Added DeepSeek as a web search engine (`web/deepseek`), using DeepSeek's new Search API with your existing `DEEPSEEK_API_KEY` or stored `deepseek` credential
- Added `el.selectText(text, { prefix?, suffix?, select? })` to the macOS `computer` tool: it selects text (or places a caret) in a background app's text field without taking focus, moving the pointer or sending keys, so typing into that field replaces it ([#15175](https://github.com/can1357/oh-my-pi/pull/15175) by [@will-bogusz](https://github.com/will-bogusz))
- Added `{ takeover: true }` to computer-use `win.move`, so a hover that a window refuses in the background can be retried in the foreground ([#15173](https://github.com/can1357/oh-my-pi/pull/15173) by [@will-bogusz](https://github.com/will-bogusz))
- Added a `menu` option to the `computer` tool's `win.click`, `el.click`, `el.press` and `el.perform`, so on macOS the call that opens a menu also chooses its item, e.g. `menu: ["Add to", "Fonts"]` ([#15185](https://github.com/can1357/oh-my-pi/pull/15185) by [@will-bogusz](https://github.com/will-bogusz))
- Added `el.type(text)` and `el.press(chord)` to the `computer` tool, which send text and keys to that element instead of wherever its window's focus is; on macOS and Windows nothing is sent when the element cannot be addressed without taking your focus ([#15563](https://github.com/can1357/oh-my-pi/pull/15563) by [@will-bogusz](https://github.com/will-bogusz))
- Added: pressing Escape during takeover input now stops computer use for the rest of the turn, and that session's later `computer` calls are refused, unsent, until your next message ([#15564](https://github.com/can1357/oh-my-pi/pull/15564) by [@will-bogusz](https://github.com/will-bogusz))
- Added the `computer` tool's `UserIntervened` error on macOS: input into an app you have used since the agent last read its window fails without sending, and the agent is told to read the window again and keep your edits ([#15562](https://github.com/can1357/oh-my-pi/pull/15562) by [@will-bogusz](https://github.com/will-bogusz))
- Added `tui.completeScrollback`: rows a growing HUD or dialog pushes off screen go straight to scrollback instead of missing from it until it shrinks ([#15692](https://github.com/can1357/oh-my-pi/pull/15692) by [@Ilm-Alan](https://github.com/Ilm-Alan))

### Changed

- The `computer` tool and its errors no longer tell the model to retry with `takeover: true`, and its instructions tell it never to call `raise()` or `apps.open(…, { activate: true })` to make input work ([#15191](https://github.com/can1357/oh-my-pi/pull/15191) by [@will-bogusz](https://github.com/will-bogusz))
- Computer-use window input with `takeover` omitted now stays in the background after `computer.control.acquire`, so an acquired grant no longer activates the target app or moves the user's pointer; pass `takeover: true` for foreground input ([#15173](https://github.com/can1357/oh-my-pi/pull/15173) by [@will-bogusz](https://github.com/will-bogusz))
- Pressing Escape in your own app no longer stops the `computer` tool's background window input unless task control is held; Escape in omp still interrupts it, and physical Escape still stops takeover input ([#15176](https://github.com/can1357/oh-my-pi/pull/15176) by [@will-bogusz](https://github.com/will-bogusz))
- Added Box questions to `ChainJudge`: they go only to Jev judges that answer them, and the box edges measure the image you passed even when it was padded to fit Jev's size bounds
- A relay `browser.open` without `app.target` now opens its own background tab instead of adopting the visible one (after reinstalling the relay extension; older ones select it), and `browser.close` closes it; `app.target` still borrows an existing tab ([#16119](https://github.com/can1357/oh-my-pi/pull/16119) by [@nnnnoel](https://github.com/nnnnoel) and [@will-bogusz](https://github.com/will-bogusz))
- Computer-use `win.menu.items` now needs `exec` approval and is rejected in `read_only` runs, since on macOS it makes the window key in its own application before reading its menus ([#15184](https://github.com/can1357/oh-my-pi/pull/15184) by [@will-bogusz](https://github.com/will-bogusz))
- The `computer` tool no longer takes over your screen for macOS drags and holds on sliders, scroll bars, splitters and steppers, modified clicks, right-clicks and scrolls; they run in the background ([#15185](https://github.com/can1357/oh-my-pi/pull/15185) by [@will-bogusz](https://github.com/will-bogusz))
- The default `judge` role now uses TypeSafe Jev 1.14 (`typesafe/jev-1.14.0`, then `openrouter/typesafe/jev-1.14`): `jev-latest` is TypeSafe's stable alias and answered as `jev-1.13.0`
- Idle compaction on a 1-hour prompt cache (Anthropic long retention) now runs just before the cache entry expires, about 54 minutes after the last request, so the summary still reads the cached context; `compaction.idleTimeoutSeconds` still applies with a 5-minute cache or an unknown lifetime ([#16198](https://github.com/can1357/oh-my-pi/pull/16198), [#16204](https://github.com/can1357/oh-my-pi/pull/16204) by [@H4vC](https://github.com/H4vC))
- Tool-call intents now say what the agent wants from the call's output and what it already knows (e.g. "Find where the retry delay is computed and whether it honours Retry-After; the client is in http.py") instead of a short label like "Reading config file"

### Fixed

- Fixed repeated status commands such as `/goal show` showing nothing after the first few times in a native terminal when the text had not changed
- Fixed browser relay tabs that a browser already had open when its extension connected staying invisible to omp until they changed; opening such a tab by `app.target` could fail with "Selected tab did not become available before omp could attach"
- Fixed Ollama Cloud sessions compacting too early on stripped thinking or too late after switching from another model ([#16164](https://github.com/can1357/oh-my-pi/issues/16164))
- Fixed Google sign-in rejecting the `/login perplexity` SSO browser window with "This browser or app may not be secure"; the sign-in browser no longer runs in automation mode ([#16141](https://github.com/can1357/oh-my-pi/issues/16141))
- Fixed `task.softRequestBudget` never stopping Cursor subagents ([#16182](https://github.com/can1357/oh-my-pi/pull/16182) by [@joseotaviorf](https://github.com/joseotaviorf))
- Fixed image judgments (`judge()`/`judge_batch()` with images) leaving TypeSafe Jev for the local `tiny` model whenever an image fell outside Jev's 280–1568 px bounds, which most screenshots do: images are now resized into the bounds, and strips padded, before Jev sees them
- Fixed a Codex turn stopping on "Request failed … unsupported_native_inflight_message" when you sent a message while the response was writing text; the session now keeps the partial reply and continues with your message
- Fixed the `bash` tool dropping variables, functions, and shell options between calls whenever auto-background was on (the default): a call that starts in the foreground now runs in the session's persistent shell, a failing command under `set -e` or an `exit` no longer resets that shell, and a call that overlaps a still-running one says it ran in a temporary shell ([#16153](https://github.com/can1357/oh-my-pi/pull/16153) by [@alphastorm](https://github.com/alphastorm))
- Fixed the macOS `computer` tool's `StaleRef` for an element the app rebuilt in place, such as an Automator rule popup after its neighbour changed, leaving the agent to re-read the window: it now names the one element of the window with the fields the ref was read with, for the agent to check before acting on it ([#15574](https://github.com/can1357/oh-my-pi/pull/15574) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed an eval cell's `timeout` aborting an awaited `tool.task(...)` or `tool.wait(...)` and losing its subagents' results: time spent waiting on them no longer counts against the cell, as with `agent()` handles, while a turn cancel still stops them ([#16154](https://github.com/can1357/oh-my-pi/pull/16154) by [@alphastorm](https://github.com/alphastorm))
- Fixed the Up arrow crashing omp with `text.replace is not a function` when `history.db` was damaged; recall skips unreadable rows, and a damaged store is moved aside to `history.db.corrupt-*` with every readable prompt, session title, and recap copied into its replacement ([#15751](https://github.com/can1357/oh-my-pi/pull/15751) by [@Shadorain](https://github.com/Shadorain))
- Fixed browser `tab.screenshot()` raising Chrome over the app you were typing in and switching its visible tab; background tabs and windows behind other apps are now captured in place, including ones idle long enough that Chrome stopped drawing them, as is a relay or `app.cdp_url` tab the user switched away from ([#15174](https://github.com/can1357/oh-my-pi/pull/15174) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed tabs omp opens through a relay shared by two browsers landing in whichever browser reconnected last; they open in the browser of the tab omp used last, else the one showing the first selected tab ([#16119](https://github.com/can1357/oh-my-pi/pull/16119) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a relay `browser.close` after a browser restart closing a tab the user had opened since, when Chrome reused the old tab's id; a tab omp opens while its browser's relay extension reconnects now waits for it instead of opening in another browser, and one Chrome finishes creating after the extension's connection dropped is closed ([#16119](https://github.com/can1357/oh-my-pi/pull/16119))
- Fixed `computer.run` and browser `tab.run` silently dropping `args` that were not an array (such as `{ args: { path } }`) or were given with a code string, so the function ran without them after its first steps had already acted; both now throw before the run starts, while omitted or `null` `args` still pass none ([#16149](https://github.com/can1357/oh-my-pi/pull/16149) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `computer` helpers or browser tab calls started together (such as `Promise.all` over `computer.window`) failing with a bare "Computer worker is busy" or "Tab … is busy"; the error now says to await each call before starting the next, or group the steps in one `computer.run` or `tab.run` ([#16149](https://github.com/can1357/oh-my-pi/pull/16149) by [@will-bogusz](https://github.com/will-bogusz))
- Commands in `bash` can hand `skill://`, `local://`, and other file-backed URLs to external programs again (`python skill://example-skill/tool.py "query"`), and can run them from a `cd`'d writable URL directory such as `local://`; a URL the provider rejects, such as an unknown skill, now fails the command with the provider's error ([#14838](https://github.com/can1357/oh-my-pi/pull/14838) by [@koyzdev](https://github.com/koyzdev))
- Fixed `computer.apps.open` returning before the app had a window, or never giving a hidden running app one; it now returns the app's frontmost window as `window`, waiting up to 3 s on macOS ([#15184](https://github.com/can1357/oh-my-pi/pull/15184) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a key you were typing on macOS arriving twice or more when omp exited after computer use ([#15562](https://github.com/can1357/oh-my-pi/pull/15562) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp --restore` and `/retry` reporting nothing to retry for a turn cut off by a process exit in a session that had used `eval`; the interrupted turn now continues ([#16195](https://github.com/can1357/oh-my-pi/issues/16195))
- Fixed session loading on Windows treating a session path with a regular-file component as a missing session (an empty session) instead of rejecting it with `ENOTDIR` like POSIX does ([#16145](https://github.com/can1357/oh-my-pi/pull/16145) by [@jchanghong023](https://github.com/jchanghong023))
- Fixed models from extension providers listed in `enabledModels` or `--models` missing from `/model`, the Ctrl+P cycle and the startup model scope notice until the background catalog refresh finished ([#16096](https://github.com/can1357/oh-my-pi/pull/16096) by [@skipper019](https://github.com/skipper019))

## [18.12.1] - 2026-10-17

### Breaking Changes

- Removed `display()` from eval in both Python and JavaScript; `print` (and `console.log` in JavaScript) covers it

### Added

- Added `advisor.continueSeverity` (`nit`, `concern`, `blocker`) to choose the minimum advisor note severity that wakes the agent after it finished with a final answer; lower-severity notes stay as a card at the end of the transcript
- Printed DataFrames/Series render as tables, large dicts/lists and objects as JSON trees, and Markdown objects as Markdown for the user, while the model sees the printed text
- Printing a figure or image in eval attaches the image to the result

### Changed

- An advisor `concern` raised after the agent's final answer now continues the run by default instead of waiting at the end of the transcript; set `advisor.continueSeverity` to `blocker` for the previous behavior

### Fixed

- Fixed context-file `@` imports failing to load paths containing backslash-escaped spaces ([#16090](https://github.com/can1357/oh-my-pi/issues/16090))

## [18.12.0] - 2026-10-17

### Added

- Added `statusLine.segmentOptions.pi.showProfile`: set it to `false` to hide the profile name next to the `π` brand, for example when each profile already has its own theme ([#16063](https://github.com/can1357/oh-my-pi/pull/16063) by [@shgew](https://github.com/shgew))
- Added `sharpshooter.minPromptLength` (default 16, minimum 2) to control the shortest prompt Sharpshooter extracts decisions from ([#16043](https://github.com/can1357/oh-my-pi/pull/16043) by [@bigHippoZz](https://github.com/bigHippoZz))

### Changed

- With a first-party Anthropic model on the official API selected, the interactive UI opens the API connection at startup, on model switch, and when you start typing, so the next turn skips connection setup; third-party gateways and custom endpoints are never probed ([#16044](https://github.com/can1357/oh-my-pi/pull/16044) by [@H4vC](https://github.com/H4vC))
- The API connection warm-up now covers every built-in provider (Copilot, OpenAI, Gemini, OpenRouter, …), not only Anthropic: between turns it keeps the connection your last request used open, through the configured proxy and CA settings, so the next turn skips connection setup; custom `models.yml` providers, built-in providers pointed at a gateway, and local servers are never probed ([#16086](https://github.com/can1357/oh-my-pi/pull/16086) by [@H4vC](https://github.com/H4vC))
- Snapcompact now shows an imaged `read` result's indentation as count brackets (`[»2]` two tabs, `[·4]` four spaces) and keeps its `[path#TAG]` header as text, so edits from imaged reads keep the right indentation and tag ([#15899](https://github.com/can1357/oh-my-pi/pull/15899) by [@apoc](https://github.com/apoc))
- A custom model's explicit `contextWindow` or `maxTokens` in `models.yml` now wins over the catalog's limit rules for that model id, which previously overwrote it ([#16094](https://github.com/can1357/oh-my-pi/pull/16094) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed Claude Opus 5.5 replies sent between tool calls (for example an answer to a question asked mid-task) being folded into the "Thought" block; they now show as normal reply text in the transcript, print mode, ACP clients, and HTML exports
- Fixed the shell's `du --time=ctime` (also `status`) printing `???` on Windows; it now shows the last write time, as `stat` already does for the status-change time
- Fixed the shell's `rmdir dir/.` on Windows removing `dir` (and `rmdir x/..` the parent); like POSIX it now fails with `Invalid argument` / `Directory not empty`
- Fixed the shell's `dd if=DIR` on Windows failing with `failed to open ...: Permission denied`; like POSIX it now opens the directory and reports `error reading ...: Is a directory` with the transfer statistics
- Fixed the LSP mux returning from shutdown before its language-server children exited, and spawning a duplicate language server when a session reconnected while the previous one was still closing its documents
- Fixed the startup connection warm-up silently doing nothing on Windows, where Bun's `fetch.preconnect` throws ([#16086](https://github.com/can1357/oh-my-pi/pull/16086) by [@H4vC](https://github.com/H4vC))
- Fixed the RPC frame codec (`modes/rpc/rpc-frame`) failing to bundle for Node because it pulled in Bun-only modules and the native addon ([#16072](https://github.com/can1357/oh-my-pi/pull/16072) by [@oyty](https://github.com/oyty))
- Fixed `auth-gateway` strict probes sending a raw token instead of the structured credential blob for Alibaba Coding Plan and Snowflake logins ([#16092](https://github.com/can1357/oh-my-pi/pull/16092) by [@H4vC](https://github.com/H4vC))
- Fixed a prompt sent while Esc was still interrupting the previous turn never settling, so a message steered in as it ended stayed queued instead of running ([#16038](https://github.com/can1357/oh-my-pi/pull/16038) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed isolated tasks freezing the host when the checkout holds linked worktrees of the same repository (e.g. gitignored `.claude/worktrees/`); those worktrees are no longer snapshotted as nested repos ([#16068](https://github.com/can1357/oh-my-pi/issues/16068))
- Fixed `edit` moves dropping executable permissions in hashline, patch, and apply_patch modes ([#16042](https://github.com/can1357/oh-my-pi/pull/16042) by [@mottopanikeiku](https://github.com/mottopanikeiku))
- Fixed leaving a subagent view before its transcript finished replaying leaving rows of both sessions on screen, dropping the start of one, and clearing native scrollback twice; transcript rebuilds now run one at a time and a superseded rebuild is discarded without painting ([#16066](https://github.com/can1357/oh-my-pi/pull/16066) by [@cagedbird043](https://github.com/cagedbird043))
- Fixed Cursor task subagents losing their final report when it follows tool calls in the same turn ([#16059](https://github.com/can1357/oh-my-pi/issues/16059)).
- Fixed SQLite read continuation hints dropping filters and sort order or truncating the next-page selector ([#16040](https://github.com/can1357/oh-my-pi/pull/16040) by [@mottopanikeiku](https://github.com/mottopanikeiku))
- Fixed SQLite table reads omitting generated columns from sample rows and query results, and rejecting sort orders on those columns ([#16041](https://github.com/can1357/oh-my-pi/pull/16041) by [@mottopanikeiku](https://github.com/mottopanikeiku))
- Fixed video timestamp selectors (`clip.mp4:2s`, `clip.mp4:0:05`) failing for files outside the session cwd, which also reported a colon-mangled path when the video was missing. ([#16056](https://github.com/can1357/oh-my-pi/pull/16056) by [@adi-IL](https://github.com/adi-IL))
- Fixed recovery of hashed session directories for projects under a temporary directory inside home, including the default Windows temp directory ([#15929](https://github.com/can1357/oh-my-pi/pull/15929) by [@jchanghong023](https://github.com/jchanghong023)).
- Fixed approval prompts for `xd://` device dispatches and direct MCP tools to show readable, indented arguments with multiline content expanded into blocks ([#15589](https://github.com/can1357/oh-my-pi/issues/15589), [#16048](https://github.com/can1357/oh-my-pi/pull/16048) by [@KunoLu](https://github.com/KunoLu)).
- Fixed `retry.fallbackChains` warning "references unknown model" at startup for models a discovery provider loads once its background refresh finishes (e.g. Copilot and Cursor `-1m` variants); a model still missing after discovery is warned about once ([#16061](https://github.com/can1357/oh-my-pi/pull/16061) by [@gchai](https://github.com/gchai))
- Fixed GitHub Copilot models that only discovery lists (e.g. `-1m` variants) going missing at startup when two Copilot accounts are signed in ([#16061](https://github.com/can1357/oh-my-pi/pull/16061) by [@gchai](https://github.com/gchai))
- Fixed Cursor models that only discovery lists (e.g. `-1m` variants) staying unavailable at startup until a background refresh whenever the stored Cursor access token had expired; the startup cache read now uses the same account key as the discovery write ([#16061](https://github.com/can1357/oh-my-pi/pull/16061) by [@gchai](https://github.com/gchai))
- Fixed `var` declared inside a top-level control block disappearing after an awaited JavaScript Eval cell ([#15859](https://github.com/can1357/oh-my-pi/issues/15859)).
- Fixed the eval runtime-state reminder omitting live Python kernels, so retained Python state no longer reads as dead or absent; Python kernels are listed with their generation, alive/dead status, and `%load` scripts like JavaScript kernels ([#16032](https://github.com/can1357/oh-my-pi/issues/16032)).
- Fixed a browser call hanging for about 21 s, and its tab staying listed but dead, when the tab's worker crashed (such as on an error inside Puppeteer): the call fails at once with the cause and the next call continues on the same page ([#16037](https://github.com/can1357/oh-my-pi/pull/16037) by [@alnaggar-dev](https://github.com/alnaggar-dev) and [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/restart` losing explicitly opened session files outside the default session directories by resuming the persisted file directly ([#16030](https://github.com/can1357/oh-my-pi/pull/16030) by [@appboypov](https://github.com/appboypov))
- Fixed a failed `todo` call's hidden reminder resurfacing on the next prompt with an outdated list after the agent had already retried successfully ([#16001](https://github.com/can1357/oh-my-pi/issues/16001))
- Fixed TypeSafe image-cache reuse when only ignored image detail changes ([#16002](https://github.com/can1357/oh-my-pi/pull/16002) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy))
- Fixed `ssh://` ignoring a `ControlPath` from `~/.ssh/config`, so it now reuses an already-authenticated master (e.g. on MFA/keyboard-interactive hosts) instead of failing with `Permission denied` ([#15974](https://github.com/can1357/oh-my-pi/issues/15974))
- Fixed `--session-dir <dir> --resume <id>` not finding a transcript that is a symlink in that directory, the session lists and id-prefix lookups skipping symlinked transcripts the same way, and a resume that must rewrite such a transcript replacing the link instead of updating the file it points at; a project bucket that is itself a symlink is no longer traversed, so a scan cannot leave the sessions root and no session is listed twice ([#15878](https://github.com/can1357/oh-my-pi/issues/15878), [#15882](https://github.com/can1357/oh-my-pi/pull/15882) by [@AnxForever](https://github.com/AnxForever))
- Fixed restarting an interactive session with SIGTERM disabling a rotating Anthropic OAuth login and requiring `/login` again ([#15845](https://github.com/can1357/oh-my-pi/issues/15845)).
- Fixed URL `read` dropping everything past 500,000 characters: tail selectors, URL `grep`, and the linked full-output artifact now reach the whole response body ([#15768](https://github.com/can1357/oh-my-pi/issues/15768)).
- Fixed `find` (tool and `omp find`) reporting "no hits" when every judge request failed; it now reports `find unavailable` with a hint to use grep, flags partial runs with how many judge requests failed, and exposes the status as `coverage` in its details and `--json` output ([#15744](https://github.com/can1357/oh-my-pi/issues/15744))
- Fixed resumed sessions with `eval` history (`--continue`, `--resume`) missing the prompt cache after the previous process's first request ([#15736](https://github.com/can1357/oh-my-pi/issues/15736))
- Fixed a failed streamed edit preview ending the whole run without retry: the harness now re-drives the turn with the preview diagnostic so the model can read the file again and correct the patch, and gives up with a notice only after two recoveries
- Fixed MCP OAuth login requesting every scope in an authorization server's catalogue when the protected resource advertises no scopes; `/mcp reauth` now falls back to configured scopes or authorization-server defaults ([#15996](https://github.com/can1357/oh-my-pi/pull/15996) by [@unclesamwk](https://github.com/unclesamwk)).
- Fixed the incomplete-todo stop reminder firing (and resuming work) when the agent's final message asks for permission or a decision before a closing status line, through "If you confirm, I'll…"/"Separately, tell me…"-style requests, or with a non-English question followed by another sentence ([#15986](https://github.com/can1357/oh-my-pi/issues/15986))

## [18.11.3] - 2026-10-16

### Breaking Changes

- Extension `ui.approve()` hosts receive an optional `session` choice label and answer `"once"`, `"session"`, or `"deny"` instead of a boolean

### Added

- Added `imageCountBudget` to custom models and `modelOverrides` in models.yml, so a custom gateway can state its host's image limit instead of the default of 5; past that limit the oldest images were dropped on every new image, which rewrote the provider's prompt cache ([#15002](https://github.com/can1357/oh-my-pi/issues/15002), [#15969](https://github.com/can1357/oh-my-pi/pull/15969) by [@aramalipoor](https://github.com/aramalipoor))
- The status line names the active profile next to the `π` brand (`π-work`), so sessions from different profiles are distinguishable at a glance; the default profile is unchanged ([#15622](https://github.com/can1357/oh-my-pi/pull/15622) by [@matthewrball](https://github.com/matthewrball))
- Added opt-in `prewalk.auto` (`off`, `suggest`, or `on`): the native judge decides per task whether to arm a prewalk handoff to `prewalk.autoTarget`, and the next task starts back on the planning model ([#16026](https://github.com/can1357/oh-my-pi/pull/16026) by [@taibenvenuti](https://github.com/taibenvenuti))
- Added `/seance` and the task `seance` agent: consult a saved session read-only, in place, without resuming it or copying its artifacts; pick the source and an optional model from pickers, and send follow-ups to the consultant ([#15036](https://github.com/can1357/oh-my-pi/pull/15036) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy))

### Changed

- Tool approval prompts list Approve, Approve `<tool>` for this session, and Deny again: with an empty composer, pick with the arrow keys and Enter; typing in the composer denies and steers instead, and the Deny row reads "Deny and send message" while you do

### Fixed

- Fixed the Isolate Subagents setting description implying that all tasks run isolated; each task must opt in with `isolated: true` ([#15987](https://github.com/can1357/oh-my-pi/issues/15987)).
- Fixed `read` labeling re-encoded images with the display format instead of the source file's format; it now identifies both when they differ ([#15890](https://github.com/can1357/oh-my-pi/issues/15890)).
- Fixed `omp -p` and `task` subagents reporting a clean finish with an earlier answer when a context overflow could not be compacted enough to retry; the overflow error is now the run's outcome ([#15897](https://github.com/can1357/oh-my-pi/pull/15897) by [@nhthung](https://github.com/nhthung))
- Fixed Cursor's Shell tool killing commands once its `block_until_ms` wait elapsed; the wait no longer sets the kill deadline, which comes from Cursor's `hard_timeout` or the bash default ([#15898](https://github.com/can1357/oh-my-pi/pull/15898) by [@nhthung](https://github.com/nhthung))
- Fixed an interrupted prompt's late setup cleanup marking the next prompt idle early, allowing overlapping submissions and releasing sleep prevention mid-turn ([#15946](https://github.com/can1357/oh-my-pi/issues/15946))
- Fixed hashline `REM` hiding the path-recovery warning when a nonexistent path matched an earlier-read file ([#15957](https://github.com/can1357/oh-my-pi/issues/15957)).
- Fixed tool downloads (`sd`, `sg`, `yt-dlp`, `trafilatura`) failing with `GitHub API error: 403` on a machine whose egress IP has spent GitHub's anonymous 60/hour budget; the release lookup now sends `GITHUB_TOKEN`/`GH_TOKEN` like omp's other GitHub API call sites ([#15981](https://github.com/can1357/oh-my-pi/pull/15981) by [@iacore](https://github.com/iacore))
- Background local memory extraction now stops after one bounded retry budget on repeated OpenAI-compatible 429 responses instead of multiplying transport, provider, and completion retries ([#15826](https://github.com/can1357/oh-my-pi/issues/15826)).
- Fixed a message-result subagent resumed by typing into its focused session leaving `agent://<id>` empty and never reporting its final reply to the parent ([#15948](https://github.com/can1357/oh-my-pi/issues/15948))
- Fixed `read` of an RSS or Atom feed showing `Untitled` for every item and dropping feed titles, descriptions, dates, and RSS item links ([#15954](https://github.com/can1357/oh-my-pi/issues/15954))
- Fixed `read` showing a binary notice instead of an HTML page when a server sends unlabeled gzip to the first request but decodable HTML to the second ([#15956](https://github.com/can1357/oh-my-pi/issues/15956))
- Fixed `read` returning a homepage's site-wide feed or a page's site-wide `llms.txt` alternate instead of the requested page ([#15955](https://github.com/can1357/oh-my-pi/issues/15955)).
- Fixed `ast_grep` reporting a clean "No matches found" for a pattern that does not parse in the target language (e.g. a bare C# identifier); it now lists the pattern's ERROR node as a parse issue ([#15950](https://github.com/can1357/oh-my-pi/issues/15950))
- Fixed `--resume <id>` and session listings skipping transcripts placed in the session directory as symlinks ([#15878](https://github.com/can1357/oh-my-pi/issues/15878), [#15884](https://github.com/can1357/oh-my-pi/pull/15884) by [@peda-cos](https://github.com/peda-cos))
- Fixed sessions with a deferred-connecting MCP server listing every routed MCP tool twice, once as a mount notice and once in route guidance ([#15982](https://github.com/can1357/oh-my-pi/pull/15982) by [@zcyoung2000](https://github.com/zcyoung2000))

### Removed

- Removed the built-in `rs-parking-lot` rule; Rust edits using `std::sync::{Mutex, RwLock}` with `.lock().unwrap()` are no longer steered to `parking_lot`

## [18.11.2] - 2026-10-16

### Added

- Added `lsp.requestTimeout` setting to configure wait durations for language server diagnostics and requests
- Added `omp auth-gateway serve --clients=<file>`: per-client bearer tokens, each limited to listed models and broker OAuth accounts with no fallback to other accounts or API keys, re-read while serving ([#5098](https://github.com/can1357/oh-my-pi/issues/5098), [#15900](https://github.com/can1357/oh-my-pi/pull/15900) by [@alphastorm](https://github.com/alphastorm))

### Changed

- The `lsp` tool now uses `lsp.requestTimeout` to dynamically adjust both call deadlines and project-aware diagnostic wait times, with support for per-call overrides
- Reduced CPU overhead during syntax checks and automatic edit repairs ([#15904](https://github.com/can1357/oh-my-pi/pull/15904) by [@iliaal](https://github.com/iliaal)).
- Reduced status-line refresh overhead while subagents have long conversations ([#15874](https://github.com/can1357/oh-my-pi/pull/15874) by [@iliaal](https://github.com/iliaal)).
- Agents now send `todo` updates alongside their next tool call instead of spending a separate model turn on them ([#15402](https://github.com/can1357/oh-my-pi/pull/15402) by [@will-bogusz](https://github.com/will-bogusz))
- The Shared Language Servers setting now says what it does: each connection gets its own server, and a released one is reused while another omp instance keeps the project's mux running ([#14633](https://github.com/can1357/oh-my-pi/pull/14633) by [@jorgoose](https://github.com/jorgoose))
- Memories saved explicitly through the extension `memory.save` API are now stored as `stated` rather than `unknown`, so they rank as deliberate memories in Mnemopi recall ([#13824](https://github.com/can1357/oh-my-pi/pull/13824) by [@sjawhar](https://github.com/sjawhar))

### Fixed

- Fixed prewalk switching models during read-only MCP lookups through `write xd://` when the server marks the tool read-only ([#15994](https://github.com/can1357/oh-my-pi/issues/15994))
- Fixed Ctrl+C printing `9;5u` in the shell after force-quitting omp with a third Ctrl+C while it was still closing the session
- Fixed Smart unexpected-stop recovery continuing finished answers, which added extra "nothing more to add" turns
- Fixed `grep` searching only the first 4 MB of a file named directly, so later matches were reported as absent; the whole file is now searched, and a multiline pattern, which still reads only the first 4 MB, says so in its no-match headline ([#15942](https://github.com/can1357/oh-my-pi/issues/15942))
- Fixed browser `uploadFile` failing with "Not allowed" through the relay or into a Chrome on another machine, stalling behind macOS folder-privacy prompts, and breaking the tab on large drop-zone files ([#15489](https://github.com/can1357/oh-my-pi/pull/15489) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `uploadFile` sending a stale copy of a file rewritten without changing its size or timestamp, failing on folders that contain a symlink loop, and deleting copies a still-open attached page could read after a repeat upload
- Fixed plan mode (including plan-yolo) looping on `write xd://propose` forever when an extension provides a tool named `write`; the extension tool is left out of plan mode with a warning, since only the built-in `write` can submit plans ([#14030](https://github.com/can1357/oh-my-pi/issues/14030), [#14438](https://github.com/can1357/oh-my-pi/pull/14438) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed legacy Mnemopi bank databases staying open after the recall bank probe, which could block deleting them on Windows ([#14584](https://github.com/can1357/oh-my-pi/pull/14584) by [@yshihao636](https://github.com/yshihao636))
- Fixed startup skipping a configured default fallback whose provider authenticates only through another provider's key (e.g. `xai-oauth` via `XAI_API_KEY`) and picking an unrelated model instead ([#15781](https://github.com/can1357/oh-my-pi/pull/15781))
- Fixed slower startup when the configured default model is unavailable and no fallback chain is configured ([#15781](https://github.com/can1357/oh-my-pi/pull/15781))
- Fixed `read` directory listings printing a directory's raw listing error, whose tabs, newlines, or control characters could break the transcript; `[unreadable: …]` is now a single bounded line ([#15789](https://github.com/can1357/oh-my-pi/pull/15789))
- Fixed a `^` model mention sent while the agent is working (steer, follow-up, or queued skill prompt) never announcing its new `m<N>` alias to the model ([#14093](https://github.com/can1357/oh-my-pi/issues/14093), [#14322](https://github.com/can1357/oh-my-pi/pull/14322) by [@holny](https://github.com/holny))
- Fixed large session files ending in a truncated record not being repaired on load, unlike small ones ([#14582](https://github.com/can1357/oh-my-pi/pull/14582) by [@yshihao636](https://github.com/yshihao636))
- Fixed a read-only subagent's rejected `write` reading as a dead end: when `yield` is available, the rejection now names it as the way to return the content ([#14308](https://github.com/can1357/oh-my-pi/issues/14308), [#14470](https://github.com/can1357/oh-my-pi/pull/14470) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed `/retry` after an interrupt leaving later advisor notes and extension asides unable to wake the agent until the next typed prompt ([#14831](https://github.com/can1357/oh-my-pi/pull/14831) by [@daandden](https://github.com/daandden))
- Fixed session titles and idle recaps disappearing after a corrupt `history.db` was quarantined and recreated, and a briefly busy store disabling the session index for the rest of the session ([#13929](https://github.com/can1357/oh-my-pi/issues/13929), [#14361](https://github.com/can1357/oh-my-pi/pull/14361) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed pasting a screenshot with ⌘V into omp running over SSH from Tern or kitty failing with `Clipboard is empty` or `Image not found` ([#15369](https://github.com/can1357/oh-my-pi/pull/15369) by [@LoneExile](https://github.com/LoneExile))
- Fixed native hook discovery silently ignoring hooks symlinked into `hooks/pre` or `hooks/post` ([#14189](https://github.com/can1357/oh-my-pi/issues/14189), [#14536](https://github.com/can1357/oh-my-pi/pull/14536) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed headless Linux containers without a system D-Bus logging a `Failed to acquire power assertion` warning on every turn; the missing backend is now noted once at debug level ([#14591](https://github.com/can1357/oh-my-pi/pull/14591) by [@tahakotil](https://github.com/tahakotil))
- Fixed a project's daemon broker staying unreachable after its runtime directory was deleted while it ran (`proc://`, `wait`, shared LSP and the shared browser failed with `connect ENOENT …/broker.sock`); the broker now releases the project within seconds of losing its socket and the next request starts a fresh one ([#14466](https://github.com/can1357/oh-my-pi/pull/14466) by [@nick-maderight](https://github.com/nick-maderight))
- Fixed SQL and Redis sessions stalling after a rewrite raced an append; later turns now republish after the backend recovers ([#15612](https://github.com/can1357/oh-my-pi/pull/15612) by [@sjawhar](https://github.com/sjawhar))
- Fixed OpenAI Codex web search failing with "No Codex OAuth credentials found" when only `OPENAI_CODEX_OAUTH_TOKEN` is set ([#12537](https://github.com/can1357/oh-my-pi/issues/12537), [#14337](https://github.com/can1357/oh-my-pi/pull/14337) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed `yield` rejecting a valid `data` result when a non-strict provider also filled `error` with a placeholder such as `unused` or `n/a`; a real error alongside `data` is still rejected, now with exact resend instructions ([#15633](https://github.com/can1357/oh-my-pi/pull/15633) by [@Komzpa](https://github.com/Komzpa))
- Fixed secret redaction replaying Gemini tool calls with their original `thoughtSignature` after rewriting the call arguments; a rewritten call now drops the signature, as rewritten thinking already did ([#14392](https://github.com/can1357/oh-my-pi/pull/14392) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed Claude marketplace plugin MCP servers declaring a sub-second `timeout` (e.g. SAP's `"timeout": 600`) never loading; values below Claude Code's 1000 ms minimum are now ignored with a warning so the default timeout applies ([#12485](https://github.com/can1357/oh-my-pi/issues/12485), [#14574](https://github.com/can1357/oh-my-pi/pull/14574) by [@oleg494](https://github.com/oleg494))
- Fixed automatic retries looping without end when the primary model's cooldown expired mid-retry: the session no longer switches back to the primary while a retry is still in flight, and returns to it on the next prompt ([#14611](https://github.com/can1357/oh-my-pi/pull/14611) by [@MiloMMIN](https://github.com/MiloMMIN))
- Fixed web search providers garbling non-UTF-8 responses; they now decode with the charset declared in `Content-Type` (or a `<meta charset>` tag), the same way fetched pages are ([#15304](https://github.com/can1357/oh-my-pi/pull/15304) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Fixed `openai-models-list` discovery ignoring a flat `max_tokens` output limit on `/v1/models` rows, which pinned such models to the 32K default ([#13062](https://github.com/can1357/oh-my-pi/issues/13062), [#14403](https://github.com/can1357/oh-my-pi/pull/14403) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed long replies dropping lines from scrollback or replaying them duplicated and out of order when status widgets stay taller after a turn or transient HUDs close ([#15820](https://github.com/can1357/oh-my-pi/pull/15820) by [@emmahyde](https://github.com/emmahyde))
- Fixed a stale "Working…" row staying under a focused subagent after it finished while the main session kept running ([#15820](https://github.com/can1357/oh-my-pi/pull/15820))
- Fixed `omp update` failing when a bunfig `minimumReleaseAge` or npmrc `min-release-age` supply-chain cooldown rejects the just-published release; self-update now overrides the cooldown for the pinned version it installs ([#14581](https://github.com/can1357/oh-my-pi/pull/14581) by [@morri-son](https://github.com/morri-son))
- Fixed `agent://<id>` returning a message-result subagent's first result after it completed a parent-requested follow-up; reads now return its latest completed result ([#15707](https://github.com/can1357/oh-my-pi/pull/15707) by [@mg-mg-mg](https://github.com/mg-mg-mg))
- Fixed sloppy edits silently dropping an operator when one `*** Find` was followed by two (e.g. `*** Insert Before` and `*** Replace`); the payload is now rejected with an error naming both and nothing is applied ([#14357](https://github.com/can1357/oh-my-pi/pull/14357) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed a cancelled Python tool install (e.g. `uv tool install`) falling through to `pip` with the aborted signal and leaving the install progress running ([#15750](https://github.com/can1357/oh-my-pi/pull/15750) by [@harshaygadekar](https://github.com/harshaygadekar))
- Fixed auto-learn captures rewriting earlier OpenAI Responses history after a learning tool call, which broke prompt-cache reuse ([#14099](https://github.com/can1357/oh-my-pi/pull/14099) by [@nanbloom001](https://github.com/nanbloom001))
- Fixed `/shake images` leaving the context percentage unchanged; the tokens freed by the removed images are now reported and subtracted from the context meter right away ([#5029](https://github.com/can1357/oh-my-pi/issues/5029), [#14367](https://github.com/can1357/oh-my-pi/pull/14367) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed `/fork pane|tab` and Herdr `ctx.ui.openTerminal()` launches failing in panes whose shell is not POSIX (such as Nushell); Herdr launches now type only the path of a self-deleting `/bin/sh` script and no longer ask for POSIX-shell confirmation ([#15262](https://github.com/can1357/oh-my-pi/pull/15262) by [@shgew](https://github.com/shgew))
- Fixed Eval `read("artifact://N")` returning an "Unbounded raw read blocked" notice instead of the text for artifacts over 50 KB that belong to another session, or when the session has no artifacts directory, in JavaScript and Python cells ([#15410](https://github.com/can1357/oh-my-pi/pull/15410) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed cancelling a bash job hard-killing it before its TERM cleanup handlers could run; it now gets up to one second to clean up before termination is forced ([#15709](https://github.com/can1357/oh-my-pi/pull/15709) by [@mg-mg-mg](https://github.com/mg-mg-mg))
- Fixed the transcript collapsing to one line per entry after switching between a subagent and the main session mid-turn when an earlier turn left a tool call without a result ([#12247](https://github.com/can1357/oh-my-pi/issues/12247), [#15466](https://github.com/can1357/oh-my-pi/pull/15466) by [@shgew](https://github.com/shgew))
- Fixed a retried tool losing its transcript card when the view was rebuilt (subagent focus switch, overlay close) while the tool was still running
- Fixed Chrome element handles' `uploadFile()` failing "Node is not a file input element" on labels, chooser triggers and drop zones; it now uploads like `tab.uploadFile()` ([#15918](https://github.com/can1357/oh-my-pi/pull/15918) by [@will-bogusz](https://github.com/will-bogusz))
- Browser `tab.fill` in Chrome sets colour, date, time and range inputs to the given value (it typed `2026-10-12` as `61012-02-02` and left a colour at `#000000`), and refuses a value the input rejects ([#15914](https://github.com/can1357/oh-my-pi/pull/15914) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `uploadFile` on a control that opens `showOpenFilePicker()` hanging the cell until the tab was killed; it now fails at once with a named error ([#15915](https://github.com/can1357/oh-my-pi/pull/15915) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed every later file chooser on a page doing nothing, the user's own clicks in a relay tab included, after browser `uploadFile` clicked a chooser trigger or drop zone ([#15915](https://github.com/can1357/oh-my-pi/pull/15915) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `uploadFile` in Chrome reporting success with no file attached when the element opens no file chooser and nothing on the page reads the dropped files; it now fails and says what to target ([#15919](https://github.com/can1357/oh-my-pi/pull/15919) by [@will-bogusz](https://github.com/will-bogusz))
- Relay mode: when Chrome detaches omp from a tab it drives (a password manager's inline menu loading in the page), the call fails at once saying why and omp reattaches to the same tab, instead of every later call timing out and reopening failing with `No page targets available` ([#15920](https://github.com/can1357/oh-my-pi/pull/15920) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the macOS `computer` tool letting the display sleep and lock in a turn that went 5 minutes without a desktop action; it now keeps the display awake until the turn ends or asks for your answer, then lets it sleep ([#15762](https://github.com/can1357/oh-my-pi/pull/15762) by [@will-bogusz](https://github.com/will-bogusz))

## [18.11.1] - 2026-10-15

### Added

- Added image attachments to single and batch eval `judge()`/`judge_batch()` calls (local paths or embedded images); image judgments skip candidates without image support and fail explicitly instead of dropping images ([#15471](https://github.com/can1357/oh-my-pi/pull/15471) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy))
- Added a job tree to `/jobs`, `/jobs full` and the jobs pill's sheet, in the terminal UI and over ACP: subagents' background jobs now appear nested under the task that runs them, with the busiest branches listed first; only your own jobs offer Cancel ([#15854](https://github.com/can1357/oh-my-pi/pull/15854) by [@H4vC](https://github.com/H4vC))
- Added `ctx.ui.getEditorComponent()` so extensions can wrap the active custom editor factory instead of replacing it ([#8655](https://github.com/can1357/oh-my-pi/pull/8655) by [@jovi-tsx](https://github.com/jovi-tsx))

### Changed

- Reduced memory used by bundled model catalog data in standalone and npm installs ([#15876](https://github.com/can1357/oh-my-pi/pull/15876) by [@iliaal](https://github.com/iliaal)).

### Fixed

- Fixed `/shake` and automatic shake leaving old transcript rows in native scrollback or obscuring the start of a response beside the Todo HUD ([#15877](https://github.com/can1357/oh-my-pi/issues/15877)).
- Fixed `write` making Rust source files beginning with `#![...]` executable instead of preserving their permissions ([#15858](https://github.com/can1357/oh-my-pi/issues/15858)).
- Fixed the startup status bar preview showing a previous session's model instead of the default model ([#15865](https://github.com/can1357/oh-my-pi/issues/15865)).
- Fixed `length`-stop recovery with a lowered `compaction.thresholdTokens` counting the discarded output against the threshold, so a reasoning-only cut compacted without the retry hint and a truncated answer was discarded instead of kept ([#15870](https://github.com/can1357/oh-my-pi/issues/15870))
- Fixed `read` on a directory showing `(empty directory)` when the directory itself is unreadable, and silently omitting subdirectories it cannot list; it now errors for an unreadable root and marks unreadable subdirectories `[unreadable: …]` ([#15769](https://github.com/can1357/oh-my-pi/issues/15769)).
- Fixed isolated tasks losing the commits of a submodule added inside the isolation, leaving the merged checkout pinned to an unreachable commit ([#15459](https://github.com/can1357/oh-my-pi/pull/15459))
- Fixed isolated task startup hanging or detaching an unrelated checkout when `.gitmodules` lists a submodule path that is absolute or contains `.`/`..` ([#15459](https://github.com/can1357/oh-my-pi/pull/15459))
- Fixed `/live` and Ctrl+L starting live mode while the composer microphone was still loading its recognizer, which opened a second recorder and dictated into the hidden editor ([#15759](https://github.com/can1357/oh-my-pi/pull/15759))
- Fixed images in the transcript not opening their file; their placeholders and image chips now link to it ([#15872](https://github.com/can1357/oh-my-pi/pull/15872) by [@H4vC](https://github.com/H4vC))
- Fixed print mode returning success after length-stop recovery gave up; it now waits for the session to settle before choosing its exit code ([#15732](https://github.com/can1357/oh-my-pi/pull/15732) by [@nick-maderight](https://github.com/nick-maderight))
- Fixed browser `tab.click("text/…")` passing over a match a scroll container shows only a narrow strip of and clicking a later duplicate instead ([#15792](https://github.com/can1357/oh-my-pi/pull/15792) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/advisor` status waiting on usage checks; it now renders immediately with cached quota data and refreshes usage in the background ([#15780](https://github.com/can1357/oh-my-pi/pull/15780) by [@mvid](https://github.com/mvid))
- Fixed task agents silently skipping `autoload-skills` entries for skills added after the session started ([#15723](https://github.com/can1357/oh-my-pi/pull/15723) by [@shyamsivakumar](https://github.com/shyamsivakumar))
- Fixed changed `initOptions` in `lsp.json` not applying when a new session reused an idle shared language server ([#15645](https://github.com/can1357/oh-my-pi/pull/15645) by [@mottopanikeiku](https://github.com/mottopanikeiku); [#15535](https://github.com/can1357/oh-my-pi/issues/15535))
- Fixed wake completions falsely reporting no output when the agent already messaged its owner over IRC ([#15834](https://github.com/can1357/oh-my-pi/pull/15834) by [@mg-mg-mg](https://github.com/mg-mg-mg)).
- Fixed a steered service readiness wait leaving the daemon broker polling until `ready.timeout`; the abandoned wait is now cancelled ([#15656](https://github.com/can1357/oh-my-pi/pull/15656))
- Fixed Cursor `;`-separated reads returning an image part's bytes as text ([#15635](https://github.com/can1357/oh-my-pi/pull/15635))
- Fixed auto-compaction ignoring `retry.waitForUsageReset` and abandoning the last compaction method on a provider-stated usage-limit reset past `retry.maxDelayMs` ([#15313](https://github.com/can1357/oh-my-pi/pull/15313))
- Fixed advisor compaction dropping the kept latest turn when the native compaction had to stop before it ([#15712](https://github.com/can1357/oh-my-pi/pull/15712))
- Fixed tool-approval steering: a message typed while viewing a subagent now steers the main session awaiting the approval, the message that denied a call is delivered ahead of older queued steers, and an equal-looking later steer no longer answers a new approval ([#15642](https://github.com/can1357/oh-my-pi/pull/15642))
- Fixed workpool item errors cancelling the entire batch; workers now continue with remaining items and report each result separately ([#15860](https://github.com/can1357/oh-my-pi/issues/15860)).
- Fixed image attachments with uppercase MIME types being dropped; supported image MIME types are now matched case-insensitively ([#15765](https://github.com/can1357/oh-my-pi/pull/15765) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy))
- Fixed ordinary Bash commands emitting an ignored-readiness warning for placeholder-only `ready` fields, while preserving warnings for log/port conditions and service validation ([#15629](https://github.com/can1357/oh-my-pi/pull/15629) by [@nqrwhal](https://github.com/nqrwhal)).
- `openai-models-list` discovery reads the output limit from `top_provider.max_completion_tokens` (OpenRouter-shaped catalogs such as ModelRelay), so a bundled reference with a larger limit no longer makes requests the provider rejects ([#15652](https://github.com/can1357/oh-my-pi/pull/15652) by [@shanev](https://github.com/shanev))
- Fixed saved session history being replaced by incomplete rewrites after asynchronous disk write failures ([#15588](https://github.com/can1357/oh-my-pi/pull/15588) by [@jiwangyihao](https://github.com/jiwangyihao)).
- Fixed the `read` tool description inviting `:img` on PNG paths: it now says `:img` only rasterizes SVG/SVGZ files and raster images need no selector, and the `:img` error on a raster file says to read it without the selector ([#15671](https://github.com/can1357/oh-my-pi/pull/15671) by [@nick-maderight](https://github.com/nick-maderight))
- Corrected the `ast_grep` truncated-result advice to suggest `skip` pagination or narrowing instead of `increase limit`, which the tool schema does not accept ([#15532](https://github.com/can1357/oh-my-pi/issues/15532), [#15543](https://github.com/can1357/oh-my-pi/pull/15543) by [@peda-cos](https://github.com/peda-cos)).
- Fixed Cursor sessions with many MCP tools compacting unnecessarily or pausing automatic maintenance despite ample free context ([#15815](https://github.com/can1357/oh-my-pi/issues/15815)).
- Fixed switching a session or advisor to Cursor still counting the previous model's tool schemas toward context usage and compaction ([#15815](https://github.com/can1357/oh-my-pi/issues/15815)).
- Fixed todo reminders continuing the agent when the `todo` tool is disabled ([#12589](https://github.com/can1357/oh-my-pi/pull/12589) by [@anthonyrisinger](https://github.com/anthonyrisinger)).
- Fixed JS eval `completion()` handles created in one cell never resolving in a later cell, which left `wait(handles, { timeout })` hanging past its timeout ([#15756](https://github.com/can1357/oh-my-pi/issues/15756)).
- Closed `read :raw` line ranges now return only the requested content, and newline-terminated files report their actual line count ([#15810](https://github.com/can1357/oh-my-pi/issues/15810)).
- Fixed `/review` PR file assignments by including exact per-file diff URLs and preserving 1-based indexes across excluded files ([#15463](https://github.com/can1357/oh-my-pi/pull/15463) by [@tkossak](https://github.com/tkossak))
- Fixed image attachments with uppercase MIME types being dropped; supported image MIME types are now matched case-insensitively ([#15765](https://github.com/can1357/oh-my-pi/pull/15765) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy))
- Fixed `grep` and `ast_grep` returning no matches for a `path` glob that names directories, such as `src/{api,web}` or `src/we?`; matched directories are now searched recursively like a plain directory path, so `src/*` also searches files in `src`'s subdirectories ([#15760](https://github.com/can1357/oh-my-pi/issues/15760))
- Fixed a structured `display()` value in an Eval cell appearing twice in the TUI and collab view, as text in the cell box and again as the JSON tree; it now shows once, as the tree, while the model still sees the text ([#10778](https://github.com/can1357/oh-my-pi/issues/10778), [#12730](https://github.com/can1357/oh-my-pi/pull/12730) by [@F0Rextasy](https://github.com/F0Rextasy))
- `omp auth-gateway serve` now bounds its broker-backed session cache instead of growing with every distinct client session ([#15841](https://github.com/can1357/oh-my-pi/issues/15841)).
- Fixed the run ending when a reasoning model stops with only a signed thinking block and no reasoning text (seen with Gemini 4 via OpenRouter); the agent now continues it like any other thinking-only stop ([#15837](https://github.com/can1357/oh-my-pi/issues/15837))
- Fixed `openai-models-list` discovery ignoring a model's top-level `max_output_tokens` / `max_completion_tokens`, which let gateway models inherit an output cap as large as the whole context window and send oversized `max_completion_tokens` ([#15811](https://github.com/can1357/oh-my-pi/issues/15811))
- Fixed the standalone binary crashing with `Settings not initialized` when resuming or starting a TUI session with an extension whose dependencies clear `require.cache` (e.g. `request-promise` via `pi-messenger-bridge`) ([#15799](https://github.com/can1357/oh-my-pi/issues/15799))
- Python Eval displays preserve integers outside JavaScript's safe range as decimal strings in structured JSON instead of silently rounding them ([#15847](https://github.com/can1357/oh-my-pi/issues/15847)).
- Loop-watchdog stalls while Mnemopi truncates the recall query for compaction or background first-turn recall are now logged under `mnemopi.recall` instead of `unknown` ([#15413](https://github.com/can1357/oh-my-pi/pull/15413) by [@jaredlyon](https://github.com/jaredlyon)).
- Clarified the `/session pin` description: it pins a stored OAuth account to the current provider for this session only ([#15479](https://github.com/can1357/oh-my-pi/pull/15479) by [@iacore](https://github.com/iacore))
- Fixed `/jobs` doing nothing in a focused subagent view: it now lists that subagent's own background jobs, as does the jobs pill's sheet, without a way to cancel them; `/jobs kill` still requires returning to the main session ([#15161](https://github.com/can1357/oh-my-pi/pull/15161) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Fixed a suspended JavaScript Eval cell resolving `artifact://` and `local://` paths against the session directories of another cell that started while it was awaiting ([#15409](https://github.com/can1357/oh-my-pi/pull/15409) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `read` ignoring JSON and JSONL `?q=` filters and pagination for `local://` and `artifact://` files ([#15767](https://github.com/can1357/oh-my-pi/issues/15767)).
- Agents can now read saved context notes without accidentally clearing them ([#15748](https://github.com/can1357/oh-my-pi/pull/15748) by [@Komzpa](https://github.com/Komzpa))
- Fixed startup without an explicit model picking an unrelated authenticated provider instead of the first available model in the configured default fallback chain ([#15781](https://github.com/can1357/oh-my-pi/pull/15781) by [@mvid](https://github.com/mvid))

## [18.11.0] - 2026-10-14

### Added

- Added a microphone button beside Send in Tern: click to record, click Stop to finish, then review and submit the transcription yourself. Clicking while it says **Starting…** cancels a slow first model load ([#15759](https://github.com/can1357/oh-my-pi/pull/15759) by [@daaximus](https://github.com/daaximus)).
- Added local Nemotron streaming dictation: words appear while you speak, and the microphone waits for the recognizer to be ready before recording ([#15759](https://github.com/can1357/oh-my-pi/pull/15759) by [@daaximus](https://github.com/daaximus)).
- Added agent frontmatter `structured: true`: that agent's task spawns keep the `yield` tool and its `output` schema validation while `task.structured` is off ([#15717](https://github.com/can1357/oh-my-pi/pull/15717) by [@alphastorm](https://github.com/alphastorm))
- The composer stays usable while a tool approval is pending: sending a message denies the call and steers the turn with it, so the agent knows why it was denied ([#15642](https://github.com/can1357/oh-my-pi/pull/15642) by [@H4vC](https://github.com/H4vC))
- Session entries record which omp build wrote them, so a transcript shows whether a fix was live even in a session left open across an upgrade: the version, plus commit, branch, and uncommitted-diff hash when run from a source checkout, and `OMP_BUILD_LABEL` when set. `/session` lists the builds that wrote the session ([#15680](https://github.com/can1357/oh-my-pi/pull/15680) by [@will-bogusz](https://github.com/will-bogusz))

### Changed

- The in-composer tool approval prompt summarizes the command, path, or content to one row so the composer keeps its room; `Ctrl+O` shows them in full ([#15642](https://github.com/can1357/oh-my-pi/pull/15642) by [@H4vC](https://github.com/H4vC))
- Background task guidance now lives in the Task tool description (and in same-name extension replacements that delegate to Task) instead of being repeated in every spawn acknowledgment ([#15477](https://github.com/can1357/oh-my-pi/pull/15477) by [@iliaal](https://github.com/iliaal))
- The Auto-Promote Context and Retry Model Fallback settings now state that they are independent; turn off Retry Model Fallback (`retry.modelFallback`) to stop `retry.fallbackChains` model switches ([#15636](https://github.com/can1357/oh-my-pi/issues/15636))

### Fixed

- Fixed browser `tab.click("text/…")` timing out when the match was below the fold or the tab was in the background ([#14864](https://github.com/can1357/oh-my-pi/pull/14864) by [@alnaggar-dev](https://github.com/alnaggar-dev), [#15496](https://github.com/can1357/oh-my-pi/pull/15496) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser clicks the page never received, such as on a disabled control or inside an `inert` subtree, reporting success; the call now fails saying the browser did not deliver the click ([#15496](https://github.com/can1357/oh-my-pi/pull/15496) by [@will-bogusz](https://github.com/will-bogusz))
- `tab.ariaSnapshot()` no longer prints the value of a password field; it shows one bullet per character, as `tab.observe()` and the screen do, so a typed or browser-autofilled password stays out of the model's context ([#15502](https://github.com/can1357/oh-my-pi/pull/15502) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed project discovery loading plugins, `SYSTEM.md`, rules, context files, and skills from a `.omp` at a shared temporary root (`/tmp`, `/var/tmp`, the temp dir) above an unanchored working directory, or, when `HOME` is overridden, from another account's `~/.omp` outside the working directory's git repository ([#15719](https://github.com/can1357/oh-my-pi/pull/15719) by [@alphastorm](https://github.com/alphastorm))
- Fixed browser `tab.text()` and `tab.html()` (and the same calls on a frame) throwing when called without a selector; they now read the page body on Chrome, Tern and cmux ([#15599](https://github.com/can1357/oh-my-pi/pull/15599) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed skill-description compression re-sending the same smol-model requests every session for a skill whose compressed answer was rejected (over 12 words or 160 characters) or cut off at the token limit; that model is no longer asked again for that skill (a newly selected smol model is), and compressions still running at exit get up to 4 seconds to save ([#13291](https://github.com/can1357/oh-my-pi/issues/13291), [#15720](https://github.com/can1357/oh-my-pi/pull/15720) by [@alphastorm](https://github.com/alphastorm))
- Fixed the macOS `computer` tool keeping the display awake for the rest of the session after a native call hung; the call's timeout or closing the session now lets it sleep ([#15414](https://github.com/can1357/oh-my-pi/pull/15414) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed an agent definition whose `tools` value names no tool (`tools: ""`, a number, a list without strings) getting every default built-in tool; it now gets none, like `tools: []` ([#15718](https://github.com/can1357/oh-my-pi/pull/15718) by [@alphastorm](https://github.com/alphastorm))
- Fixed `page.waitForNetworkIdle` in a browser `run` timing out on a request an earlier `run` started ([#15495](https://github.com/can1357/oh-my-pi/pull/15495) by [@alnaggar-dev](https://github.com/alnaggar-dev) and [@will-bogusz](https://github.com/will-bogusz))
- Fixed a tab that a relay page opens over its own CDP session (`Target.createTarget`) landing in a separate Chrome window with `newWindow`, under an id omp could not attach to, activate or close; it now opens as a relay tab in that page's browser ([#15494](https://github.com/can1357/oh-my-pi/pull/15494) by [@alnaggar-dev](https://github.com/alnaggar-dev) and [@will-bogusz](https://github.com/will-bogusz))
- Fixed an Anthropic refusal fallback redeeming its fallback credit with an outdated system prompt and tools after switching models; it now sends a fresh request ([#15702](https://github.com/can1357/oh-my-pi/pull/15702) by [@H4vC](https://github.com/H4vC))
- Fixed OpenAI/Codex auto-compaction failing with "Remote compaction input exceeds the context window" after a turn's final response pushed history past the window; native compaction now compacts the history before the kept recent turns, which stay in context as-is ([#15712](https://github.com/can1357/oh-my-pi/pull/15712) by [@H4vC](https://github.com/H4vC))
- Fixed `omp commit`, `/git`, and other agent commits skipping the signature when Git's `commit.gpgsign` is enabled; they now sign with the configured key, and a signing failure leaves HEAD unchanged ([#14810](https://github.com/can1357/oh-my-pi/issues/14810))
- Fixed rejected `task` calls appearing successful to SDK hosts instead of reporting a tool error ([#15573](https://github.com/can1357/oh-my-pi/issues/15573))
- Fixed `read` claiming regenerated images were identical when their pixels changed at the same path ([#15668](https://github.com/can1357/oh-my-pi/issues/15668))
- Fixed SDK embedders leaking every disposed `AgentSession` that owned its MCP manager, so long-lived processes that create and dispose many sessions grew memory without bound ([#15386](https://github.com/can1357/oh-my-pi/issues/15386))
- Fixed retry model fallback stopping at a fallback model whose provider is outside a subagent's `task.agentAccountPools` pool; that model is now skipped and the next fallback model is tried ([#15423](https://github.com/can1357/oh-my-pi/issues/15423))
- Fixed the system prompt's `## MCP Server Instructions` section following MCP connection order, so a server connecting late or reconnecting no longer reorders it and rewrites the prompt cache; servers are now listed by name ([#15705](https://github.com/can1357/oh-my-pi/issues/15705))
- Fixed `read` reporting an HTTP 204 No Content response as a failed fetch; it now returns an empty successful read ([#15667](https://github.com/can1357/oh-my-pi/issues/15667))
- Fixed `/mcp reauth` failing with `Could not discover OAuth endpoints` when a server's 401 challenge is a bare `Bearer resource_metadata="…"`; the advertised protected-resource metadata URL is now used ([#15690](https://github.com/can1357/oh-my-pi/issues/15690))
- Fixed extension `agent_end` events reporting a background-job wait as a scheduled continuation; they now carry `awaitingAsyncWork: true` alongside `willContinue` ([#15348](https://github.com/can1357/oh-my-pi/issues/15348))
- Fixed auto-compaction waiting out provider retry delays longer than `retry.maxDelayMs` (e.g. a 16-hour `retry-after`); it now tries the next configured method or reports the failure ([#15311](https://github.com/can1357/oh-my-pi/issues/15311))
- Fixed `read skill://<name>` for a name no loaded skill owns hanging for the rest of the turn while an MCP server was still connecting or reconnecting; it now reports `Unknown skill` after at most 5 seconds ([#15648](https://github.com/can1357/oh-my-pi/issues/15648))
- Fixed `/new` ignoring "Start in Plan Mode" (`plan.defaultOnStartup`): the new session now starts in plan mode like the first one ([#15627](https://github.com/can1357/oh-my-pi/issues/15627))
- Fixed Cursor models' Read on an image file returning the file's raw bytes as text; Read now loads the image, and Cursor's text-only Read frame gets a short image note instead of the bytes ([#15630](https://github.com/can1357/oh-my-pi/issues/15630))
- Fixed Mermaid diagrams showing `&lt;`, `&gt;`, `&amp;`, and `#quot;` literally inside labels instead of `<`, `>`, `&`, and `"` ([#15619](https://github.com/can1357/oh-my-pi/issues/15619))
- Fixed background job results already consumed by an eval `agent()` handle's `wait()` being re-injected as one `async-result` follow-up when the cell ran past the 5-minute job retention window ([#15625](https://github.com/can1357/oh-my-pi/issues/15625))
- Fixed `/tan` missing the parent's prompt cache: it advertised the parent's `xd://` tools as top-level tools and dropped `ask`, so its tool list no longer matched ([#15578](https://github.com/can1357/oh-my-pi/issues/15578))
- Fixed forks and reloaded sessions missing the prompt cache after a compaction in a session with `eval` history ([#15695](https://github.com/can1357/oh-my-pi/issues/15695))
- Fixed compiled-binary extensions importing `@oh-my-pi/pi-tui` subpaths such as `terminal-capabilities`, `chat/svg-figure` or `theme/index` loading a second copy from their own `node_modules` instead of sharing the host's terminal, theme and figure state ([#15659](https://github.com/can1357/oh-my-pi/issues/15659))
- Fixed marketplace plugins that keep their version in `.claude-plugin/plugin.json` never being reported by `omp plugin upgrade` or auto-updated; for plugins shipped inside the marketplace, `plugin.json`'s version now also takes precedence over the catalog entry's, as in Claude Code ([#15585](https://github.com/can1357/oh-my-pi/issues/15585))
- Fixed a steer (queued user or peer message) waiting behind a `bash` service's readiness wait (`name` + `ready`) for up to `ready.timeout`; the call now returns early with the service still starting, inspectable via `proc://<name>` ([#15653](https://github.com/can1357/oh-my-pi/issues/15653))
- Fixed `omp install`/`omp plugin install`, `upgrade`, `uninstall` and `doctor --fix` failing with `Executable not found in $PATH: "bun"` for npm and Git plugins on machines without Bun installed, such as standalone-binary installs ([#15480](https://github.com/can1357/oh-my-pi/issues/15480))
- Fixed `/plugins enable` and `/plugins disable` in the TUI not refreshing skills, commands, task agents and MCP servers until a reload, and rejecting npm plugins ([#15383](https://github.com/can1357/oh-my-pi/issues/15383))
- Fixed local memory injection and `learn` using the `Settings` directory instead of the session's project directory, so SDK hosts sharing one `Settings` across projects injected another project's lessons and never the project's consolidated summary; sharpshooter memory follows the session directory too ([#15375](https://github.com/can1357/oh-my-pi/issues/15375))
- Fixed ACP bash approvals ignoring `bash.patterns`, and an earlier "Always allow" letting critical commands such as `rm -rf /` run without a prompt ([#15473](https://github.com/can1357/oh-my-pi/issues/15473))
- Fixed hashline edits silently dropping the tail of a line that `read` or `grep` had cut at the column limit; such an edit is now refused until a `:raw` read shows the full line ([#15649](https://github.com/can1357/oh-my-pi/issues/15649))
- Fixed isolated tasks failing on linked worktrees with initialized recursive submodules and leaving updated submodule pins unreachable after cleanup ([#15457](https://github.com/can1357/oh-my-pi/issues/15457))
- Fixed `/tan` missing the parent's prompt cache by advertising `xd://` tools top-level and omitting `ask` ([#15578](https://github.com/can1357/oh-my-pi/issues/15578)).

## [18.10.4] - 2026-10-13

### Added

- Extensions can observe and answer the interactive plan review, including refinement feedback and save-and-quit ([#14250](https://github.com/can1357/oh-my-pi/pull/14250) by [@rlfleming93](https://github.com/rlfleming93))
- Added opt-in `omp gc --compress` (or `gc.compress`), which stores sessions idle for `gc.compressAfterDays` (default 7) with filesystem transparent compression (APFS, NTFS); they stay resumable and searchable ([#15600](https://github.com/can1357/oh-my-pi/pull/15600) by [@wolfiesch](https://github.com/wolfiesch))
- Extensions can reopen a dismissed plan review while the session is idle (`ctx.openPlanReview()`) and pick the execution tier on `ctx.resolvePlanReview` (`input.role`); `plan_review_requested` now reports the slider's tiers ([#15552](https://github.com/can1357/oh-my-pi/pull/15552) by [@Shadorain](https://github.com/Shadorain))

### Changed

- Tool approval prompts now replace the composer like `ask`, show one row per detail, and approve with `Ctrl+Enter` (or `Ctrl+Q`) instead of `Enter` ([#15548](https://github.com/can1357/oh-my-pi/pull/15548) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed late completion probes rewinding resumed conversations and stale history scans lowering parked subagent costs ([#15594](https://github.com/can1357/oh-my-pi/pull/15594) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Fixed `read.renderMarkdown` having no effect on plain-file reads: inline read previews now render Markdown files as formatted Markdown instead of numbered source ([#15007](https://github.com/can1357/oh-my-pi/issues/15007)).
- Fixed Claude refusing every turn (`reasoning_extraction`) in a session snapcompacted under Codex, Grok or another reasoning model, after a switch or resume; Claude turns, `/btw`, `/handoff` and compaction now read a reasoning-free copy of the archive ([#15436](https://github.com/can1357/oh-my-pi/pull/15436) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the project-shared browser (headless or headed) reopening every page its previous run left open whenever it relaunched (after a crash, an out-of-memory kill, a normal stop, or a restart from `omp ps`); no session owned those pages, so they were never closed and piled up across restarts. Detaching it through `proc://<name>/mode`, which relaunched it the same way, is now refused ([#15561](https://github.com/can1357/oh-my-pi/pull/15561) by [@eggpeat](https://github.com/eggpeat))
- Fixed `omp models --json` reporting a scheduled model's superseded price in `cost`; it reports the price in force, such as DeepSeek V4 Pro's $0.30 / $1.20 card since 2026-09-14 ([#15620](https://github.com/can1357/oh-my-pi/pull/15620) by [@eggpeat](https://github.com/eggpeat))

### Removed

- Removed Codex Code Mode and its `providers.openai-codex.codeMode` / `providers.openai-codex.codeModeDirectTools` settings; Codex models always use the full direct tool surface.

## [18.10.3] - 2026-10-12

### Added

- Added `task.agentSoftRequestBudget` to give named subagents their own soft request budget, so a long-running agent can get more requests (or `0` for no guard) while scout, sonic and other agents keep theirs ([#15419](https://github.com/can1357/oh-my-pi/pull/15419) by [@will-bogusz](https://github.com/will-bogusz))
- Added `o200k` as a `tokenizer` value for custom models and overrides in `models.yml` ([#15447](https://github.com/can1357/oh-my-pi/pull/15447) by [@will-bogusz](https://github.com/will-bogusz))

### Changed

- Sized snapcompact archives for Claude 4.7+ and GPT-5.5 to 6.1 (gpt-6-astra included) at each frame's measured price instead of at least 5,024 tokens, so Codex archives can hold up to 1.7× as many frames when the room under the compaction trigger is the limit ([#15442](https://github.com/can1357/oh-my-pi/pull/15442) by [@will-bogusz](https://github.com/will-bogusz))
- Enabled sibling subagent prompt-cache sharing for Muse Code's Spark 1.3, Wonder 1.0, and Wonder Full 1.0 variants while keeping their conversations separate ([#15467](https://github.com/can1357/oh-my-pi/pull/15467) by [@iliaal](https://github.com/iliaal), based on [#15285](https://github.com/can1357/oh-my-pi/pull/15285) by [@YueyuHoshizora](https://github.com/YueyuHoshizora))
- Reduced tool-result tokens by omitting subsecond bash timing and redundant task size metadata ([#15468](https://github.com/can1357/oh-my-pi/pull/15468) by [@iliaal](https://github.com/iliaal); [#15265](https://github.com/can1357/oh-my-pi/issues/15265); based on [#15284](https://github.com/can1357/oh-my-pi/pull/15284) by [@YueyuHoshizora](https://github.com/YueyuHoshizora))
- On the official Anthropic and Codex endpoints, snapcompact archives may carry up to 12 MB of frames instead of 3 MB, Anthropic requests keep up to 600 images (100 on 200k-window models) instead of 90, and Codex requests up to 2,000 instead of 200; custom base URLs, including Anthropic requests rerouted by `ANTHROPIC_BASE_URL` or Foundry's `FOUNDRY_BASE_URL`, keep the previous limits and no longer get Anthropic's 24 MB inline image byte limit ([#15434](https://github.com/can1357/oh-my-pi/pull/15434) by [@will-bogusz](https://github.com/will-bogusz))

### Fixed

- Fixed `snapcompact.toolResults` re-sending each large tool result as images a turn after it went out as text, which broke the prompt cache and Anthropic signed thinking every turn; results are now imaged from their first send, and `read` results stay text unless the model is known to edit exactly from images (Opus 5.5+) ([#14249](https://github.com/can1357/oh-my-pi/pull/14249) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed compaction on Claude sessions with thinking sometimes keeping about half the recent history `compaction.keepRecentTokens` asks for, because each kept turn was counted at its signature's size ([#15446](https://github.com/can1357/oh-my-pi/pull/15446) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed retry fallback rejecting a model with a smaller window by charging it the reasoning the active model's provider usage replayed, and the output cap charging reasoning a cold Responses session leaves out of its first request ([#15447](https://github.com/can1357/oh-my-pi/pull/15447) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed anonymized session exports losing whether bash timing was shown ([#15468](https://github.com/can1357/oh-my-pi/pull/15468) by [@iliaal](https://github.com/iliaal))
- Added `omp --restore <session>`: resumes a session like `--resume`, then goes on with what its last process left unfinished when it crashed or was killed, both the interrupted turn and the subagents it was running (their results reach the parent as usual); Tern's session daemon now restarts omp with it after a crash
- Kept private prompt-cache routing keys out of shared sessions and HTML exports ([#15467](https://github.com/can1357/oh-my-pi/pull/15467) by [@iliaal](https://github.com/iliaal))

## [18.10.2] - 2026-10-12

### Added

- Added `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` support: set it to stop Anthropic requests sending experimental beta fields that a company `ANTHROPIC_BASE_URL` gateway rejects, such as the Sonnet 5.5 `thinking.adaptive.block_binding` 400 ([#15458](https://github.com/can1357/oh-my-pi/pull/15458) by [@H4vC](https://github.com/H4vC))
- Added the `task.structured` setting (default off) for structured task results: when on, the task tool accepts `outputSchema`/`schemaMode` and subagents return results through `yield` as before

### Changed

- Subagents spawned by the task tool now return their final message as plain text, with no `yield` tool, output schemas, or "Submit Result" fields; eval `agent()`/workpool spawns still return structured results
- In Tern, a backgrounded `bash` command or `eval` cell keeps filling its own card with live output (In background, with a running clock) and settles it with the job's outcome, Cancelled when the job is killed; `wait` lists each job on one line (type, id, label, duration) instead of repeating its output
- ACP clients now see a backgrounded call's job output stream into its tool call, which settles completed or failed with the job

### Fixed

- Fails unstructured task runs that conclude without a final message
- Background task cards no longer stop updating once the agent ends its turn while the task is still running
- Transparent images the model receives (small icons, oversized screenshots) keep their transparency instead of turning into a black square, and resized edges no longer pick up a dark fringe

## [18.10.1] - 2026-10-12

### Added

- Added a Copy button that leads the turn footer under an answer in Tern (`⧉ · 2m13s · 71K tok · $0.85 this turn`, in place of the clock), which copies that answer

### Changed

- Running agents and background jobs in Tern now share one compact counter over the composer (an icon and a count each, the words on hover) instead of two "N running" pills; each count still opens its own sheet
- In Tern, `/session pin` and `/usage reset` open the same picker sheet as the other small selectors (the active account checked, a confirm strip before a reset is spent, unusable accounts dimmed with the reason); the thinking level picker shows each level's depth as a meter, the plugin and queue mode pickers use badges (version, installed, scope, recommended) and plain-language names instead of bracketed text, and the theme picker no longer repeats "(current)" beside its check
- In Tern, the text editor an extension opens (and the ask tool's custom answer and note) is now a sheet in the composer's place: the title over its details, the text written straight on the sheet, and Open in editor, Cancel and Submit buttons whose keys show in their tooltips instead of a keycap hint row

### Fixed

- Fixed `grep` on a single file showing in Tern as separate boxed snippets with no file row or syntax colors; it now looks the same as a `grep` over a directory

## [18.10.0] - 2026-10-12

### Added

- Added `/fork` support for creating a new Tern pane while a turn is streaming, preserving the original session
- Added `omp session pack`, `omp session unpack` and `omp session moved` to move a session with its artifacts to another machine and continue it there; resuming the copy left behind forks it instead of continuing it
- Added `omp auth export` and `omp auth import` to carry model sign-ins to another machine
- Added hiding a pending `ask` question without answering it: `Alt+H` (`app.ask.hide`) or the Hide button in Tern collapses the dialog to one line; the same key, `Enter`, or Show brings it back ([#15400](https://github.com/can1357/oh-my-pi/pull/15400) by [@H4vC](https://github.com/H4vC))

### Changed

- Local IPC endpoints (daemon broker, LSP mux, IDA hosts, text prediction, `omp stream`, Collab discovery, local model workers) now run on a native transport: owner-only on every platform, including Windows named pipes; on Windows, daemons started by an older omp are not reused, so close older sessions after upgrading.
- Output hidden behind an open `ask` dialog, command report or todo list now reaches terminal scrollback once it closes, rather than while it is still open ([#15405](https://github.com/can1357/oh-my-pi/pull/15405) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed every session loading its own copy of the local mnemopi embedding model and keeping it in memory until exit; one server per model is shared across sessions and exits after 15 idle minutes ([#9908](https://github.com/can1357/oh-my-pi/issues/9908))
- Fixed the first-use mnemopi embedding-model download never completing for sessions shorter than the download; it now finishes in the shared embedding server after the session exits ([#10240](https://github.com/can1357/oh-my-pi/issues/10240))
- Fixed `RpcClient.stop()` occasionally waiting forever because the agent process was never signaled.
- Fixed blank rows opening under the input after an `ask` dialog, command report or todo list closed in a session that had filled the screen; the transcript now refills the screen ([#15405](https://github.com/can1357/oh-my-pi/pull/15405) by [@H4vC](https://github.com/H4vC))
- Fixed blank rows appearing between the last paragraphs of a streamed answer when the turn ended ([#15405](https://github.com/can1357/oh-my-pi/pull/15405) by [@H4vC](https://github.com/H4vC))

## [18.9.2] - 2026-10-11

### Fixed

- Improved responsiveness when adding assistant text after tool calls in long transcripts.
- Fixed `apply_patch` handling of context-free hunks when the target text appears multiple times.
- Fixed `find` filename ranking and sketch scoring with judge endpoints that limit the number of questions per request.
- Fixed `omp gc --apply` leaving temporary session files after an interrupted save.
- Fixed `omp auth-gateway serve` handling of OpenRouter routing variants such as `:floor` and `:nitro`.
- Improved validation errors for `computer` helpers with missing or non-string text arguments by identifying the helper and argument involved.
- Fixed `/tan` forks incorrectly inheriting the parent task's subagent spending while preserving token counts.
- Fixed `omp://` documentation links so they open the corresponding files in source checkouts.
- Fixed bare model IDs in `models.yml` incorrectly resolving to auto-discovered Ollama, llama.cpp, or LM Studio providers.
- Added warnings when configured Ollama, llama.cpp, or LM Studio endpoints cannot be reached, identifying the relevant environment variable.

## [18.9.1] - 2026-10-11

### Added

- Added `supportsThinkingBindingControls` to Bedrock `compat` in `models.yml`, so a Bedrock gateway or region that rejects Claude thinking-binding controls can turn them off ([#15316](https://github.com/can1357/oh-my-pi/pull/15316) by [@harshaygadekar](https://github.com/harshaygadekar))

## [18.9.0] - 2026-10-11

### Added

- Added browser target discovery and control, allowing agents to list the user's available pages and operate an already-open Tern browser block instead of opening a new view.
- Added the `ctx.annotations` extension API for submitting and collecting `/annotate` feedback on text and diffs.
- Added configurable Extra Context Files under `/settings` → Context, allowing custom instruction filenames without editing YAML.
- Added optional composer predictions via `composer.predictions`, which suggest the user's next message as ghost text after each turn and support Tab or Right to accept the suggestion. Predictions use an additional model request and are included in session usage and `/stats`.
- Added structured async job metadata exposing native job status and child-agent identity alongside the job ID.
- Enhanced `tui.autoGraph: smart` with data-aware chart recommendations, including labels, grouping, ordering, shading, reference rows, measure direction, and suitable chart types.
- Added `retry.fallbackOn` to restrict model fallback to quota errors (`usage-limit`) or to non-quota errors (`except-usage-limit`), while retaining `any` as the default.
- Added `omp usage reset` commands to list saved Codex and Claude rate-limit resets and redeem a selected reset from the CLI, scripts, or auth-broker clients.
- Added warnings for saved Codex and Claude resets that are nearing expiry, including affected accounts and redemption targets; interactive sessions also show a one-time conversation warning.
- On macOS, the `computer` tool now keeps the display awake while operating and reports when the screen is locked or asleep.
- Tern browser open results now indicate when a page is not currently visible, helping agents direct users to hidden picture-in-picture or omp-tab views.

### Changed

- Improved `computer.window()` failure messages by listing open windows grouped by application, with the requested application shown first.
- Standalone binary updates and installers now use Stencil's build service with SHA-256 verification; recent updates use substantially smaller verified patches, and `--binary --ref` accepts release tags.
- After an omp upgrade, an unused older browser relay started by omp is automatically replaced on the next browser call so relay fixes take effect without manual shutdown.
- Saved Codex and Claude resets in non-interactive sessions are now automatically redeemed when they are about to expire, unless `autoRedeem: no` is configured.
- Background Claude reset salvage now checks only accounts with eligible usage, reducing unnecessary usage-limit traffic.
- Reasoning provenance is preserved when `/btw` answers are promoted or turns are moved, preventing provider summaries from being sent as model-generated reasoning.

### Fixed

- Fixed unconfigured judge roles incorrectly falling back to a Google Vertex Claude model instead of the configured `tiny`, `smol`, or `default` models.
- Fixed `omp --resume -p` continuing stale todos instead of printing the answer and exiting.
- Fixed `/btw`, IRC, and composer-prediction requests losing the conversation prompt cache on Codex and after thinking-level changes on GPT-6 models.
- Fixed Tern browser operations on `about:blank` and no-op navigations hanging until timeout.
- Fixed SDK and RPC sessions using stale MCP tool lists when servers changed during extension loading.
- Fixed installing plugins from non-GitHub Git URLs and prevented inline credentials from being persisted in plugin metadata or lockfiles.
- Improved recovery from repeated OpenAI Responses request timeouts during productive long-running sessions.
- Fixed JavaScript eval syntax errors lacking source location and a useful code frame.
- Fixed Collab sessions failing to reconnect after network interruptions or device sleep.
- Fixed ACP and browser diagnostics and SSH listings using default paths instead of configured paths.
- Fixed advisors repeatedly returning to models that refused reviewed content; they now remain on the fallback until the conversation changes state.
- Plugin registry discovery warnings are now reported instead of silently ignored.
- Fixed OpenRouter Decisions judge requests through custom provider base URLs returning 404 errors.
- Fixed Codex configuration files being rejected and prevented supported settings from being ignored.
- Fixed secrets appearing in advisor previews when a preview was truncated.
- Restored public compatibility exports required by tools, legacy Pi extensions, and plugins.
- Fixed slow completions ignoring explicitly configured thinking levels, including `:max` and `:off`.
- Fixed session writes failing on Windows FSLogix profile disks.
- Limited persisted eval status history so long-running eval cells do not excessively enlarge session files or slow resume.
- Fixed Codex session prewarming from using a different model or service tier than the resolved session.
- Fixed subagent completion-probe usage disappearing after parking or restarting.
- Fixed Python eval processes hanging while waiting on the kernel control channel.
- Corrected the custom-tool quickstart to use the supported discovery flow and shipped example.
- Fixed browser screenshots providing incorrect coordinate-scaling guidance on high-device-scale displays.
- Fixed browser calls hanging when a tab renderer crashed; they now fail promptly and reload or close the affected tab as appropriate.
- Fixed sessions becoming permanently busy when retry-related session writes failed.
- Fixed collapsed todo lists wasting a row on the hidden-item indicator.
- Fixed concurrent SDK sessions interfering with one another's async jobs and subagent follow-up results.
- Fixed duplicate accessibility-tree output from computer-use eval cells.
- Fixed chained element actions such as `win.ref("e5").click()` throwing errors; element interaction options are now supported and documented.
- Fixed JavaScript and Python `read("artifact://N")` calls returning a capped preview instead of the artifact's selected text.
- Improved guidance for retrieving complete lines when `read`, `eval`, or `bash` output is truncated by the column limit.
- Fixed resumed, switched, and forked sessions losing the prompt cache when Mnemopi or Hindsight auto-recall was enabled.
- Fixed the first prompt losing provider prompt-cache coverage while MCP servers were still starting.
- Fixed coordinate clicks being dropped after password-form submission in omp-launched Chromium.
- Fixed classifier refusals ending fallback chains prematurely when the retry budget was exhausted.
- Fixed reading MCP-advertised `skill://` resources and other MCP resources, including discovery order, loading state, and clean shutdown of stalled servers.
- Fixed smart unexpected-stop detection missing slow judge results, allowing premature stops to recover correctly.
- The `cfg://` settings approval prompt now honors `ask.timeout` rather than always expiring after ten seconds.
- Fixed custom LiteLLM providers not receiving the built-in provider behavior and model/session handling.
- Fixed resumed Cursor sessions losing earlier reasoning after transcript truncation.
- Fixed `computer.window()` failing to find windows by ID or application when many windows were open.
- Fixed `grep` hiding matches that appeared beyond the first 512 bytes of a long line.
- Fixed snapcompaction leaving too little context room after compaction.
- Fixed usage-limited account pools redeeming saved resets for accounts outside the configured pool.

## [18.8.9] - 2026-10-10

### Added

- Added capability-driven extension terminal launches for tmux, Zellij, Herdr, and CMUX, with consolidated multiplexer detection, provider/shell capability feedback, and required POSIX-shell confirmation for shell-input launches; CMUX shell input preserves non-ASCII arguments and pane working directories ([#13620](https://github.com/can1357/oh-my-pi/pull/13620) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Added `/fork pane|window|tab` to open a fork of the session in a new multiplexer pane or window while this session keeps running; bare `/fork` still forks in place ([#13620](https://github.com/can1357/oh-my-pi/pull/13620) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Added Orca CLI-based launches for `/fork pane|window|tab` and `ctx.ui.openTerminal()`, with POSIX-shell confirmation; when Orca can only start a tab as a background terminal, the launch reports a warning instead of a visible tab ([#13620](https://github.com/can1357/oh-my-pi/pull/13620) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).

### Changed

- CLI `--fork` now pairs tool calls the source session left unresolved with an unknown-outcome result, and `/tan` clones report such calls as unknown-outcome instead of aborted; forking a source whose process already exited keeps the process-exit recovery and pending-tool warning ([#13620](https://github.com/can1357/oh-my-pi/pull/13620) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Table charts (`tui.autoGraph`) now cover before/after tables whose rows are different metrics (time, memory, counts): each row's change is drawn as a factor of its "before" value (`48× less`, `+27%`), and rows written in prose are skipped and named under the chart. A single column of scores like `12/12` is drawn as bars filling toward 100%
- In terminals that speak the Tern Surface Protocol (Tern), the composer's bottom bar shows the git branch and its status beside the model chip when the status line has the `git` segment; it outlasts the other facts as the bar narrows, and clicking it opens `/git` ([#15220](https://github.com/can1357/oh-my-pi/pull/15220) by [@H4vC](https://github.com/H4vC))
- Table charts plot scores like `154/160` as the share of their total instead of the first number, and tables comparing two or three columns across four or more metrics now get a chart: a grid of one small panel per metric

### Fixed

- Fixed table charts failing on a table cell such as `3 constructor` or `2 valueOf calls`

## [18.8.8] - 2026-10-10

### Added

- Added `/jobs kill <id>|all` to cancel a running background job (or every one this session owns) from the command line, even while the agent is busy ([#14160](https://github.com/can1357/oh-my-pi/pull/14160) by [@KanwarGill](https://github.com/KanwarGill))
- Added `omp anonymize [session] [-o dir]` to write a shareable copy of a session and its subagent transcripts: only an explicit allowlist of omp metadata (ids, timestamps, models, usage, built-in tool names and options) is kept; message, thinking, and tool-output text become size-annotated `[redacted …]` markers; tool-call paths become mock paths (`/home/seg3/seg4/src/seg9.ts:10-20`), shell commands keep known programs and flags, other literals such as a grep pattern become `PLACEHOLDER_N`, and extension or MCP payloads are redacted whole, with the same original always mapping to the same token across files ([#15077](https://github.com/can1357/oh-my-pi/pull/15077) by [@H4vC](https://github.com/H4vC))
- Added `/dump anon`, which writes the same anonymized session and subagent JSONL to a zip in the temp directory and copies its path ([#15077](https://github.com/can1357/oh-my-pi/pull/15077) by [@H4vC](https://github.com/H4vC))
- Added message times to `/dump` transcripts (assistant turns also show request duration and time to first token), and live status, last activity, pending tool calls, and the partially streamed turn to `/dump all` files for subagents still running, so a stuck subagent can be diagnosed from the archive ([#15121](https://github.com/can1357/oh-my-pi/pull/15121) by [@H4vC](https://github.com/H4vC))
- Added `contextFiles.extra` to load extra instruction files, such as `AGENTS.local.md`, beside the usual context file ([#15147](https://github.com/can1357/oh-my-pi/pull/15147) by [@Shadorain](https://github.com/Shadorain)).
- `/annotate` opens the note you are writing, a file or typed-prompt source, or (for local diff reviews) the current working-tree file in `$VISUAL` or `$EDITOR` with the external-editor key (Ctrl+G by default); a file source is saved back and its notes follow the edited text ([#15151](https://github.com/can1357/oh-my-pi/pull/15151) by [@Shadorain](https://github.com/Shadorain))

### Changed

- A `/models` compaction limit set past a model's standard context window now runs that model on its extended window instead of being silently clamped; the hub warns (noting long-context pricing) and saves on a second Enter, in the terminal and in Tern, and rejects limits past the model's largest window ([#15048](https://github.com/can1357/oh-my-pi/pull/15048) by [@H4vC](https://github.com/H4vC))
- A token compaction limit set in `/models` (or `compaction.modelThresholds`) is now the base omp scales with its usual policy, as if it were the model's window (85% of it by default for bases above ~109k, or `compaction.thresholdPercent` of it), instead of the exact point. Plain numbers saved since 18.8.5 therefore compact earlier; rewrite one as `"f<tokens>"` (or type `f400k` in the hub) to keep it an exact trigger. The `/models` limit field shows where the model would compact as you type (`compacts at 340K · 85% of 400K base`), the preview's **Compacts at** row says why, and the saved message repeats it ([#15065](https://github.com/can1357/oh-my-pi/pull/15065) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed `/usage` (or clicking the status-line cost) while the usage dashboard was already open stacking a second dashboard on top; it now focuses the open one ([#15145](https://github.com/can1357/oh-my-pi/pull/15145) by [@H4vC](https://github.com/H4vC))
- Fixed the browser tool prompt not documenting `observe()`'s `viewportOnly` and `includeAll` options, or that `open`/`close`/`run` timeouts are seconds clamped to 1–300 while `waitFor*` timeouts are milliseconds ([#15104](https://github.com/can1357/oh-my-pi/pull/15104) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser relay pages opened in the background (`browser.newPage({ background: true })` in `tab.run`) taking over the user's selected tab; they now open unselected once the relay extension is reinstalled ([#15109](https://github.com/can1357/oh-my-pi/pull/15109) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `open` with `app.relay` and a `target` failing with `No page target matched` or `Selected tab is no longer available` when the matching tab was opened a moment earlier outside omp; it now waits briefly for the relay to list the tab ([#15112](https://github.com/can1357/oh-my-pi/pull/15112) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a timed-out `browser.open` holding up the next open of the same browser (apps launched with `app.path` excepted) until its abandoned launch or connect returned; the timeout error now names the step that stalled ([#15117](https://github.com/can1357/oh-my-pi/pull/15117) by [@jinpyo-jeon](https://github.com/jinpyo-jeon) and [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser tabs crashing mid-load on some pages with a same-site iframe, Google Travel among them, after which every open, screenshot and evaluate on the tab timed out ([#15118](https://github.com/can1357/oh-my-pi/pull/15118) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the custom-tool examples' full-documentation link opening a missing page ([#15076](https://github.com/can1357/oh-my-pi/pull/15076) by [@qingshungLI](https://github.com/qingshungLI))
- Fixed the `/models` compaction limit preview and **Compacts at** row rounding fractional percentages (`12.5%` showed as `13%`) ([#15074](https://github.com/can1357/oh-my-pi/pull/15074) by [@H4vC](https://github.com/H4vC))
- Fixed `/omfg` save, overwrite, and validation prompts in Tern opening as a sheet over the candidate rule; they now sit in the composer slot like `ask`, so the rule stays readable while you choose ([#15058](https://github.com/can1357/oh-my-pi/pull/15058) by [@H4vC](https://github.com/H4vC))
- Fixed hotkeys pressed in Tern while omp is still starting (such as Alt+P for the model selector) being ignored; like in other terminals, they now take effect once startup finishes ([#15120](https://github.com/can1357/oh-my-pi/pull/15120) by [@H4vC](https://github.com/H4vC))
- Fixed a startup extension dialog (select, confirm, input) in Tern not receiving keys until it timed out ([#15122](https://github.com/can1357/oh-my-pi/pull/15122) by [@H4vC](https://github.com/H4vC))
- Fixed auto-compaction overflowing the context window every cycle when `compaction.thresholdTokens` or an `f<tokens>` model limit is at or past a window the provider caps lower (such as Factory's 196K Kimi K3); it now compacts at the window less the reserve, and `/models` shows the trigger as capped ([#15146](https://github.com/can1357/oh-my-pi/pull/15146) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed resumed xAI, Factory Droid and OpenAI sessions forgetting earlier reasoning on their first request, while a retry after a stale Responses item error still rebuilds history ([#15148](https://github.com/can1357/oh-my-pi/pull/15148) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the startup default ignoring the model a provider's discovery names as the account's default: with no model chosen, Devin Pro now starts on SWE-2 at High instead of SWE-1.6 ([#15115](https://github.com/can1357/oh-my-pi/pull/15115) by [@will-bogusz](https://github.com/will-bogusz))

## [18.8.7] - 2026-10-09

### Added

- Added automated release binary publication to build.stencil.so
- Added OSC 7501 program status reporting: terminals and agent inboxes that support it now show whether omp is working, waiting on your answer or approval (with the question), done, or failed (with the error), without parsing the window title. Turn it off with `terminal.programStatus`.
- Added title cards (icon and short code) to `/rename`: the title model picks one for a title you type, or for a generated title when the session has no card yet; `title.icons: boring` keeps renamed titles plain.
- Grammars for less common languages (Kotlin, Swift, Ruby, PHP, Haskell, Verilog, and others) are now downloaded on first use for code summaries, block context, `ast_grep`, `ast_edit`, and TTSR rules; offline, files in those languages are skipped with a note instead of failing. `PI_GRAMMARS_URL` overrides the download location.
- Added `bash.gitGuard` (default off) for checkouts shared by concurrent agents: the bash tool refuses `git stash`, `git reset --hard` or to another commit, and `git checkout`/`switch`/`restore` that would overwrite working-tree files unless a merge or rebase conflict is being resolved; unstaging stays allowed, and commands are judged as they actually run, including inside substitutions, functions, and after `cd`.

### Changed

- Updated `write` tool error message to mention local:// scratch support
- Web search now tells the agent about its X post operators (`site:x.com`, `from:<handle>`) when you are logged in to xAI, so questions about reactions on X reach X search.
- Reduced memory retained after merging unchanged discovered and cached models ([#14252](https://github.com/can1357/oh-my-pi/pull/14252) by [@iliaal](https://github.com/iliaal)).
- The default `smol` model now prefers Claude Haiku 5.5 when it is available.
- Automatic session titles now start when the agent's reply begins rather than when you submit, so a slow-thinking first reply gets a card title (icon and code) instead of a plain fallback title.
- `read file.jsonl?q=…` keeps the other lines' results when a line before the last fails and shows jq's error ahead of them, instead of failing the read; anything else the query wrote to stderr, such as `debug` output, now leads the result too ([#14659](https://github.com/can1357/oh-my-pi/pull/14659) by [@will-bogusz](https://github.com/will-bogusz))
- Title card icons now picture each session's specific subject instead of a generic bug, flask, speedometer, gear, or terminal, or the project's language logo, so sessions in the same project are easier to tell apart.
- Agents whose tool list omits `write` but still get it to run `xd://` tools can now also write `local://` files (reports, notes) outside plan mode; working-tree writes stay blocked.
- Added `worktree.onStart` and `worktree.onExit` settings to start each session in its own worktree and clean it up on exit ([#14908](https://github.com/can1357/oh-my-pi/pull/14908) by [@gitpushoriginmaster](https://github.com/gitpushoriginmaster))
- Added `speech.speed` and `tts.localSpeed` settings (0.5–2.5, default 1) to speed up or slow down local Kokoro speech for live vocalization and the `tts` tool / `omp say`, plus an `omp say --speed` flag; ACP voice clients find both settings and their presets in `speech.models.list` ([#5868](https://github.com/can1357/oh-my-pi/issues/5868))
- `omp update` and the startup update notice leave an omp installed by another app (Tern) to that app instead of replacing its files.
- The startup update notice no longer appears when omp runs from a source checkout.

### Fixed

- Reduced memory growth after one-shot side requests without interrupting ongoing conversations ([#14334](https://github.com/can1357/oh-my-pi/pull/14334) by [@iliaal](https://github.com/iliaal)).
- Fixed sessions staying untitled when you interrupted the first reply to send a queued steer message.
- Fixed browser downloads saving into another tab's `downloads` folder, and `tab.waitForDownload()` saving into the system Downloads folder once another tab closed; each tab in a Chromium omp launched or spawned now saves into its own, iframe downloads included. In those browsers a download no tab tracks (started by a page omp did not open, or finishing after its tab closed) now keeps Chromium's GUID file name instead of its suggested name; connected and relay browsers keep real file names ([#14544](https://github.com/can1357/oh-my-pi/pull/14544) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser calls in relay mode failing with "The browser relay … is out of date" after an omp upgrade until the old relay was killed by hand; omp now restarts a relay it started itself under an older version ([#14416](https://github.com/can1357/oh-my-pi/pull/14416) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/rename` without a title dropping the session's title card (icon and short code) ([#14980](https://github.com/can1357/oh-my-pi/issues/14980))
- Fixed title cards showing the emoji instead of the Nerd Font icon when the model misremembered the icon's name: dashes for underscores (`nf-md-text-box`), the wrong icon set (`nf-md-spinner` for `nf-fa-spinner`), or reordered, missing, or extra words (`nf-md-test` for `nf-md-test_tube`).
- Fixed `omp update` ignoring the `update.channel` setting: canary users were checked against stable releases, and `--canary`/`--stable` were never remembered.
- Fixed interrupting a reply to send a queued steer message briefly showing omp as idle (title, progress, working indicator) before the steer ran; RPC and SDK clients also no longer see a final `agent_end` for that interrupt.
- Fixed browser tab recordings and video frame/contact-sheet extraction creating `omp-browser-recording-*` and `omp-video-*` scratch directories in your working directory instead of the system temp directory.
- Fixed edit snapshots retaining excess history when metadata or displayed-line provenance grows; the 64 MiB snapshot budget now counts UTF-8 bytes, so CJK- and emoji-heavy files keep fewer versions ([#14975](https://github.com/can1357/oh-my-pi/pull/14975) by [@iliaal](https://github.com/iliaal)).

## [18.8.6] - 2026-10-08

### Added

- Added per-session Git worktree support with `worktree.onStart` and `worktree.onExit` settings to create an isolated worktree for each session and clean it up when the session ends.
- Expanded xAI web search with X post search, including X-only and author-specific queries, author exclusions, date and recency filters, and automatic xAI routing when credentials are available.
- Added xAI-powered reading of X posts, threads and replies, profiles, searches, and hashtags when logged in, replacing the unavailable Nitter mirrors.

### Changed

- Web search now prefers an authenticated `xai-oauth` login over an `xai` API key when both are available, unless `modelProviderOrder` specifies a different order.

### Fixed

- Fixed judge-gated features continuing to use a stale model chain after switching judge roles.
- Improved Anthropic prompt-cache reuse when pruning tool results from long conversations.
- Fixed resumed Claude sessions losing earlier thinking context and prompt-cache reuse when extensions or MCP tools were registered before the first message.
- Fixed subagent advisors configured with `@advisor` using the built-in `slow` model instead of the configured advisor role.
- Fixed the `/switch` command and alternate model picker crashing when stored model speed statistics contained an unnamed model.
- Fixed `lsp` and `generate_image` attempting to read FIFO, terminal, or unbounded device paths, which could hang or exhaust memory.
- Fixed aside messages from extensions being blocked behind a running wait operation.
- Fixed extensions importing `@oh-my-pi/pi-tui/native/*` failing to load in compiled `omp` binaries.
- Fixed raw token markers appearing instead of Nerd Font icons in Anthropic idle recaps, `/btw` and `/omfg` replies, and streaming previews.
- Fixed sessions moved with `/wt` disappearing from resume lists; sessions in Git worktrees now remain discoverable and can be resumed or relocated if their worktree was removed.
- Fixed live config reload ignoring edits made during startup or right after a config symlink was retargeted, until the next unrelated edit.

Older entries are archived in [packages/coding-agent/CHANGELOG.md@6693ddbfd58c](https://github.com/can1357/oh-my-pi/blob/6693ddbfd58ce9edcdc0dc3fe98a8882c9bae834/packages/coding-agent/CHANGELOG.md).
