# Changelog

## [Unreleased]

### Breaking Changes

- `/fast`, `/ultrafast`, and `/computer` toggle without arguments and accept explicit `on` or `off`. Check their status with `/session info`. The legacy `/fast ultra` still enables Ultrafast.
- Snapcompact uses one installed font for the whole transcript. If no installed font covers it, automatic and default manual compaction try the next configured method, and inline content stays as text. The `silver16-bw` frame layout is now `cjk16-bw`.
- Removed the `cwd` parameter from the `bash` tool; a leading `cd <path> && …` still selects the working directory
- Removed the `cwd` argument of the eval `sh` helper; every `sh` command starts in the session cwd (use `cd <path> && …` inside the command)
- The `providers.fetch` configuration values `native`, `trafilatura`, and `lynx` have been replaced by the single `local` value for the in-process reader engine.
- Removed unused `parse*Args` and `print*Help` exports from the CLI configuration, grep, plugin, setup, shell, web-search, and update modules.
- The `logout` RPC command (and its SDK bindings) no longer takes a `disconnect` parameter; it always revokes the credential at the provider when one supports it.
- omp no longer reads other agents' user-level config (`~/.claude`, `~/.claude.json`, Claude Code plugins, `~/.codex`, `~/.config/opencode`, `~/.cursor`, `~/.codeium/windsurf`, `~/.copilot`); the `enabledProviders` setting, the `skills.enableClaudeUser`, `skills.enableCodexUser`, `commands.enableClaudeUser` and `commands.enableOpencodeUser` settings, and the dashboard's per-provider user toggle are gone. If you had opted in, the first launch offers to symlink or copy what you were inheriting into `~/.omp/agent`
- Dropped discovery of GitHub Copilot (`.github/copilot-instructions.md`, `.github/instructions`, `.github/prompts`, `.github/skills`), Cursor (`.cursor/rules`, `.cursorrules`, `.cursor/mcp.json`), Windsurf (`.windsurf/`), VS Code (`.vscode/mcp.json`) and Cline (`.clinerules`) config
- Project-level Claude Code, Codex and OpenCode config is limited to MCP servers, skills, commands and `.claude/CLAUDE.md`; `.claude/{tools,extensions,hooks,settings.json,SYSTEM.md}`, Codex commands, prompts, hooks, tools and settings, and OpenCode plugins and settings no longer load
- Moonshot no longer accepts `KIMI_API_KEY` as a fallback alias for `MOONSHOT_API_KEY`: the alias silently authenticated Moonshot and exposed Moonshot models whenever a Kimi Code key was set. `KIMI_API_KEY` now belongs to the mainland `kimi-code` provider (global accounts use `KIMI_CODE_GLOBAL_API_KEY`); migrate Moonshot Open Platform keys from `KIMI_API_KEY` to `MOONSHOT_API_KEY` ([#20509](https://github.com/can1357/oh-my-pi/pull/20509) by [@digi4care](https://github.com/digi4care)).

### Added

- Todo backends can define an optional `apply`: the selected backend is asked before the model's `todo` call commits, and returning `{ block: true, reason }` refuses the call with the list unchanged ([#20355](https://github.com/can1357/oh-my-pi/pull/20355) by [@Dangerboi](https://github.com/Dangerboi))
- `models.yml` `compat.neutralizeDeepseekSpecialTokens` turns DeepSeek chat-template token breaking on or off per model (on by default for DeepSeek-class models on chat-completions) ([#20832](https://github.com/can1357/oh-my-pi/pull/20832) by [@dany-on-demand](https://github.com/dany-on-demand))
- Added `--preset <name>` to start a session on a saved model preset (`/modelpreset save`), applying its roles and default thinking level for that run only ([#20306](https://github.com/can1357/oh-my-pi/pull/20306) by [@nick-maderight](https://github.com/nick-maderight))
- Credentials in `agent.db` can be encrypted with a master key kept in the OS credential vault (macOS Keychain, Windows Credential Manager, Secret Service): fresh installs encrypt when the vault answers without prompting (never on headless hosts), existing unencrypted stores stay as they are, and `auth.encrypt: true`/`false` (or `OMP_AUTH_ENCRYPT`) forces it on or off; `omp auth key` prints the master key and `omp auth key <key|->` installs one, re-encrypting stored credentials under it
- Added OSC 7577 Program Resume Protocol reporting so supporting terminals (Tern, Rex, etc.) automatically restore open omp sessions with `--restore` and their launch flags after a crash or restart
- Added a concise tool display mode, `display.toolActivity: concise`: each model tool call draws as one row with its time, status, tool and intent (`Ctrl+O`, or unfolding a row in Tern, opens the full card, and a failure keeps its last error line on the row); `display.toolActivity` (`detailed`, `concise`, `hidden`) replaces `display.hideToolActivity`, whose saved values migrate, and `Ctrl+Shift+O` now cycles the three modes ([#2785](https://github.com/can1357/oh-my-pi/issues/2785))
- Added the `wait.idleTimeout` setting: `ladder` (default) keeps today's 5s/4m windows, a duration such as `30m` makes `wait` on your own background jobs and services return a still-running snapshot only after that window, and `none` blocks until a job or service finishes, a message or steering arrives, or you interrupt; waits for a reply are unchanged ([#18485](https://github.com/can1357/oh-my-pi/issues/18485))
- Added the `tui.showLinkUrl` setting to hide the URL drawn after named Markdown links where the label is a clickable terminal hyperlink ([#13162](https://github.com/can1357/oh-my-pi/pull/13162) by [@pavel-kalmykov](https://github.com/pavel-kalmykov))
- Added `statusLine.segmentOptions.model.showProvider` to prefix the status-line model with its provider (`anthropic/Opus 4.8`) and `statusLine.segmentOptions.model.display` (`name`, `id` or `full`) to show the exact model id, with `statusLine.segmentOptions.model.maxLength` to cap the label ([#20559](https://github.com/can1357/oh-my-pi/pull/20559) by [@Xytronix](https://github.com/Xytronix))
- Dictation now works with xAI speech-to-text models such as `xai-oauth/grok-voice-transcribe-2.0` ([#19184](https://github.com/can1357/oh-my-pi/pull/19184) by [@Xytronix](https://github.com/Xytronix))
- `/fast` now switches Devin models onto their fast lanes, replacing the separate Devin Fast model entries; set `tier.devin: priority` to start every session in fast mode
- The glob tool's header shows the globs a call searches, a separate `pattern` included, with wildcards, character classes and `{a,b}` alternations highlighted like grep's regex ([#20616](https://github.com/can1357/oh-my-pi/pull/20616) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- Ask forms highlight `<mark>` text, in the terminal and in Tern ([#19559](https://github.com/can1357/oh-my-pi/pull/19559) by [@pavel-kalmykov](https://github.com/pavel-kalmykov))
- Added `tui.titleSpinner: centered`, a three-dot braille snake (`⠙⠸⢰⣠⣄⡆⠇⠋`) that circles the full cell so it centers on the terminal tab title instead of riding high, and made it the default; `braille` restores the previous `⠋⠙⠹` sweep ([#20729](https://github.com/can1357/oh-my-pi/issues/20729))
- Added the `gitlab` tool (`gitlab.enabled`, default off) covering project/file/issue reads, MR creation/updating/worktree checkout/push, discussions/notes/resolution, project/group/global search, and CI pipeline/job watching and logs, and expanded `mr://` URLs to support MR listings (`mr://`, `mr://<host>/<group>/<project>`) and cached MR overviews (`mr://<iid>`) alongside existing `/diff` slices ([#20396](https://github.com/can1357/oh-my-pi/pull/20396) by [@asuffield](https://github.com/asuffield))
- Included `tool_approvals` in `omp gc` stats database session purges ([#20294](https://github.com/can1357/oh-my-pi/pull/20294) by [@asuffield](https://github.com/asuffield))
- Added `voice` and `speechFormats` to `models.yml` speech models; the `tts` tool switches between MP3 and WAV output to match the formats a model returns ([#19183](https://github.com/can1357/oh-my-pi/pull/19183) by [@Xytronix](https://github.com/Xytronix))
- Added `speech.cloud` (default off) to vocalize `speech.enabled` output through the cloud speech models configured in the `speech` role ([#19183](https://github.com/can1357/oh-my-pi/pull/19183) by [@Xytronix](https://github.com/Xytronix))
- `/annotate` syntax-highlights source files, selected code blocks, and diffs in ANSI terminals and Tern, while keeping added and removed lines visually distinct ([#20776](https://github.com/can1357/oh-my-pi/pull/20776) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Added `tui.showLinkUrl` to hide the URL displayed after named Markdown links when their labels are terminal hyperlinks.
- Added model status-line options to show the provider, choose between model name, ID, or full identifier, and limit the displayed label length.
- Added xAI speech-to-text support for dictation, including models such as `xai-oauth/grok-voice-transcribe-2.0`.
- Updated `/fast` to switch Devin models to their fast lanes; use `tier.devin: priority` to start sessions in fast mode.
- Improved glob tool output with clearer search patterns and highlighted wildcards, character classes, and brace alternations.
- Added `<mark>` highlighting and preserved rich text styling in terminal and Tern ask forms.
- Learned (auto-learn managed) skills now record where they came from — the writing tool, created/updated dates, and the sessions and projects that taught them — in `x-omp-provenance` frontmatter; review them with `/skills learned` and delete one with `/skills forget <name>` ([#2189](https://github.com/can1357/oh-my-pi/issues/2189))
- Added an opt-in GitLab integration (`gitlab.enabled`) for project, file, issue, merge request, discussion, search, worktree, and CI workflows, along with expanded `mr://` resources for merge request listings, cached overviews, and diff slices.
- Included `tool_approvals` in `omp gc` session statistics and purge handling.
- Added `local/parakeet-tdt-0.6b-v2`, the most accurate local English dictation model.
- Added Codex's 17 new live voices to `live.voice`: `aube`, `bubbie`, `haetsal`, `hanul`, `himari`, `leher`, `marin`, `miko`, `neer`, `porto`, `rindo`, `rio`, `rivage`, `selva`, `sonna`, `tinta`, and `viola`.
- Added `statusLine.segmentOptions.model.showProvider` to prefix the status-line model with its provider (`anthropic/Opus 4.8`) and `statusLine.segmentOptions.model.display` (`name`, `id` or `full`) to show the exact model id, with `statusLine.segmentOptions.model.maxLength` to cap the label ([#20559](https://github.com/can1357/oh-my-pi/pull/20559) by [@Xytronix](https://github.com/Xytronix))
- Dictation now works with xAI speech-to-text models such as `xai-oauth/grok-voice-transcribe-2.0` ([#19184](https://github.com/can1357/oh-my-pi/pull/19184) by [@Xytronix](https://github.com/Xytronix))
- `/fast` now switches Devin models onto their fast lanes, replacing the separate Devin Fast model entries; set `tier.devin: priority` to start every session in fast mode
- Esc hides the command output (`/mcp` and other slash commands) previewed above the editor while the agent streams, without interrupting the turn; the output still enters the transcript when the agent pauses ([#17954](https://github.com/can1357/oh-my-pi/issues/17954))
- Added an uninstaller to the install scripts: `curl -fsSL https://omp.sh/install | sh -s -- --uninstall` (PowerShell: `-Uninstall`) removes the installed binary or bun/npm global package and keeps `~/.omp` unless you confirm the prompt or pass `--purge` (`-Purge`) ([#3351](https://github.com/can1357/oh-my-pi/issues/3351))
- Added opt-in `tui.screen: fullscreen`. Scroll or search (`Alt+/`) above a pinned composer, jump between prompts, and drag to select and copy text (`Alt+C` for manual copy). Configure copy on release, wheel speed, scrollbar and whether exiting appends the transcript. Inline and Tern keep their existing behavior ([#2040](https://github.com/can1357/oh-my-pi/issues/2040), building on [#2103](https://github.com/can1357/oh-my-pi/pull/2103) by [@shoucandanghehe](https://github.com/shoucandanghehe) and [#20766](https://github.com/can1357/oh-my-pi/pull/20766) by [@camjac251](https://github.com/camjac251))
- The `logout` RPC response carries `signOutError` when the provider could not confirm revoking the login; the login is removed regardless
- The tool-call loop guard now also flags consecutive tool calls whose arguments drift only in numbers when the assistant's text repeats, and the loop-guard setting's description covers the wider detection. Progress-bearing arguments such as `grep`'s `skip` and file names inside shell commands stay distinct. Valid pagination and file sweeps are not interrupted ([#13426](https://github.com/can1357/oh-my-pi/pull/13426) by [@nick-maderight](https://github.com/nick-maderight))
- Added the `kimi-code-global` provider: `/login kimi-code-global` signs in through kimi.ai for Kimi Code accounts outside mainland China, and `kimi-code` is now labeled "Kimi Code (China)" (kimi.com). `KIMI_API_KEY` authenticates both Kimi Code providers directly, quota usage accepts API-key credentials as well as OAuth tokens, and Kimi web search follows whichever region you are logged into ([#15889](https://github.com/can1357/oh-my-pi/pull/15889) by [@z80dev](https://github.com/z80dev), [#960](https://github.com/can1357/oh-my-pi/pull/960) by [@tsubus](https://github.com/tsubus), [#12405](https://github.com/can1357/oh-my-pi/pull/12405) by [@evanmaranzano](https://github.com/evanmaranzano)).
- Added the `kimi-code-global` provider: `/login kimi-code-global` signs in through kimi.ai for Kimi Code accounts outside mainland China, and `kimi-code` is now labeled "Kimi Code (China)" (kimi.com). `KIMI_API_KEY` authenticates both Kimi Code providers directly, quota usage accepts API-key credentials as well as OAuth tokens, and Kimi web search follows whichever region you are logged into ([#15889](https://github.com/can1357/oh-my-pi/pull/15889) by [@z80dev](https://github.com/z80dev), [#960](https://github.com/can1357/oh-my-pi/pull/960) by [@tsubus](https://github.com/tsubus), [#12405](https://github.com/can1357/oh-my-pi/pull/12405) by [@evanmaranzano](https://github.com/evanmaranzano), [#20509](https://github.com/can1357/oh-my-pi/pull/20509) by [@digi4care](https://github.com/digi4care)).
- Added the `kimi-code-global` provider: `/login kimi-code-global` signs in through kimi.ai for Kimi Code accounts outside mainland China, and `kimi-code` is now labeled "Kimi Code (China)" (kimi.com). `KIMI_API_KEY` authenticates `kimi-code` and `KIMI_CODE_GLOBAL_API_KEY` authenticates `kimi-code-global` directly, quota usage accepts API-key credentials as well as OAuth tokens, and Kimi web search follows whichever region you are logged into ([#15889](https://github.com/can1357/oh-my-pi/pull/15889) by [@z80dev](https://github.com/z80dev), [#960](https://github.com/can1357/oh-my-pi/pull/960) by [@tsubus](https://github.com/tsubus), [#12405](https://github.com/can1357/oh-my-pi/pull/12405) by [@evanmaranzano](https://github.com/evanmaranzano), [#20509](https://github.com/can1357/oh-my-pi/pull/20509) by [@digi4care](https://github.com/digi4care)).
- Copilot sessions show server-reported AI credits (`cr`) in the footer, status line, `/session`, `/usage` and the RPC `get_session_stats` result, with a `+` when some calls carried no billing frame; subagent credits (persisted ones included after a resume) roll up into the session the same way their dollars do ([#20667](https://github.com/can1357/oh-my-pi/issues/20667), [#20806](https://github.com/can1357/oh-my-pi/pull/20806) by [@wapenshaw](https://github.com/wapenshaw))
- Security scan results record the scan's reported AI credits as `metrics.aiuNano` and calls without a billing frame as `metrics.aiuUnknownCalls` ([#20667](https://github.com/can1357/oh-my-pi/issues/20667), [#20806](https://github.com/can1357/oh-my-pi/pull/20806) by [@wapenshaw](https://github.com/wapenshaw))
- Attempts a retry discards after an empty or failed reply are now journaled as their own usage entries, so their tokens, cost and AI credits count toward the session and `omp stats`; attempts that billed nothing and advisor retries are not ([#20667](https://github.com/can1357/oh-my-pi/issues/20667), [#20806](https://github.com/can1357/oh-my-pi/pull/20806) by [@wapenshaw](https://github.com/wapenshaw))
- Added `parentToolCallId` and `itemIndex` to `before_subagent_spawn` events for children dispatched by the `task` tool, so extensions can tie a spawn to the exact `task` call and `tasks[]` item that requested it ([#19807](https://github.com/can1357/oh-my-pi/issues/19807))
- Added `images.questionRouting: active`, which answers `read <image>?q=` only with the active model and fails instead of sending the image to another model or provider ([#20029](https://github.com/can1357/oh-my-pi/issues/20029))
- Added `compaction.summaryMaxTokens` to raise the output budget of regular compaction summaries (default unchanged at 16384, clamped to the model's output limit), so dense sessions no longer fail compaction at the fixed cap ([#18688](https://github.com/can1357/oh-my-pi/issues/18688))
- Added the `find.timeoutMs` setting (default 20 s, up to 10 minutes) for the `find` tool's wall-clock budget, so a slow or serial judge can finish a scoped search ([#18335](https://github.com/can1357/oh-my-pi/issues/18335))
- Added `codexResets.expirySalvage` (default `true`): set it to `false` to auto-redeem saved Codex resets only when an exhausted window blocks the account, never spending expiring credits early and forfeiting remaining weekly quota ([#18308](https://github.com/can1357/oh-my-pi/issues/18308))
- Added `ctx.cancelAsyncJob(id)` to the extension context, so an extension can cancel the session's own background jobs (such as `task` workers) like `/jobs kill` ([#18033](https://github.com/can1357/oh-my-pi/issues/18033))
- Added the `git.childRepoDiscovery` setting: set it to `false` to stop a session started outside a repository from scanning its direct child directories and adopting a single child checkout for the status line, git/PR lookup, and prompt context ([#18232](https://github.com/can1357/oh-my-pi/issues/18232))
- `omp models --json` now reports each model's compat overrides under `compat`, redacting both default and thinking-only `extraBody` values ([#17092](https://github.com/can1357/oh-my-pi/issues/17092))
- Added an "Insert as editable text" choice to the large-paste menu that inserts the pasted text into the editor uncollapsed, so text pasted through a remote terminal can be edited without the host-clipboard raw-paste shortcut ([#17037](https://github.com/can1357/oh-my-pi/issues/17037))
- Added the `clear_context` RPC command (and `RpcClient.clearContext()`), which clears the conversation and earlier queued input, settles abandoned prompts, and keeps the transcript file and session ID ([#16686](https://github.com/can1357/oh-my-pi/issues/16686))
- Added the `agent_view_changed` extension event, fired when the TUI focuses a subagent or returns to the main session, so extensions can re-scope their status to the agent on screen ([#16546](https://github.com/can1357/oh-my-pi/issues/16546))
- Added `model` and `fallback` attributes to `task` result envelopes so the parent sees which model served each subagent ([#16017](https://github.com/can1357/oh-my-pi/issues/16017))
- Added a terminal notification when a plan is ready for approval, controlled by `completion.notify` ([#7724](https://github.com/can1357/oh-my-pi/issues/7724))

### Changed

- OTLP export runs on OpenTelemetry JS SDK 3; `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`, `OTEL_BSP_*` and the span limit variables are no longer read (the documented `OTEL_*` variables work as before)
- On public sites, browser `tab.console()` and `tab.errors()` record from the first call on a tab (the result's `captureStartedAt` marks when), so pages cannot detect the capture; local and dev pages still record from load
- Interactive startup loads fewer modules, and reading settings or caches no longer unlocks stored credentials.
- Startup no longer blocks the event loop while scanning session folders, relay endpoints, or old logs.
- Startup loads the selected or saved model’s provider first when possible and reuses matching local catalog entries between launch and session setup.
- Interactive startup resolves more configured default models without waiting for the full catalog and discovers task agents earlier.
- Fresh interactive sessions can finish loading model caches after first paint when no native judge is available and startup only needs the selected model.
- Cross-instance agent messaging now spans projects: `agent://peers` still lists this folder's instances, `agent://peers?all` lists every project's, and `agent://<pid>` reads or messages an instance in any folder; `@p2p:` includes local agents and peers from every project, labeled with their folder when different, while plain `@` searches only this folder's peers
- The `@` mention palette and mention chips draw their icons from the symbol preset: Nerd Font glyphs under `nerd`, plain ASCII under `ascii`, and a single-width unicode set otherwise (themes can override the `mention.*` symbols)
- The `@` mention palette is colored: icons take their category's color, or the status of the row (running/idle/aborted agent, dirty file, open/merged/closed PR), and status badges take their tone
- Mention categories use `@m:` for models, `@p2p:` for agents and peers, `@ses:` for sessions, `@git:` for Git, `@pr:` for pull requests, `@iss:` for issues, `@mcp:` for MCP resources, and `@ssh:` for SSH hosts. Use `@` followed by a path to mention files; Git results can be narrowed with `@git:branch:`, `@git:commit:`, `@git:tag:`, or `@git:diff:`
- A bare `@` shows the categories as a strip of icons, Files first: Tab/Shift+Tab or ←/→ light one and show its token and description below, and Enter, Space or typing enters it (`@m:` plus what you typed). Files keeps the bare `@` and lists your folder, so `@` then Enter browses files
- The mention palette no longer shows category scope pills or pins a category with Shift+Tab; mixed results head each category with its icon and match count instead
- Role mentions now insert only the model without an explicit thinking level
- Models with 1M-class context windows (Claude extended context, GPT-6.2 Astra and Sol at 922K) auto-compact at 690K tokens by default instead of 85% of the window, cutting cache-read cost on long sessions; set `compaction.thresholdPercent`, `compaction.thresholdTokens`, or a `/models` compaction limit to compact later
- Back-to-back idle `wait` calls on jobs and services stretch their top window to the session's prompt-cache lifetime less 1m (up to 30m) instead of a fixed 4m, as reply waits already did
- Models configuration accepts `supportsPromptCacheBreakpoints` for custom OpenAI-compatible gateways ([#12880](https://github.com/can1357/oh-my-pi/pull/12880) by [@ZenAlexa](https://github.com/ZenAlexa)).
- Updated task prompt to forbid full builds or test suites mid‑flight and allow quick scoped checks
- The shell's `find`, `grep -r`, `rg`, `fd` and `ast-grep` refuse to search a filesystem root such as `/` and explain why; `find`, `rg` and `fd` still allow a shallow look (max depth 2), and `-allow-root` (`find`) or `--allow-root` searches the whole disk on purpose
- The `grep`, `glob`, `ast_grep` and `ast_edit` tools refuse a search scope that resolves to a filesystem root (`/usr/..`, `../../..`, `C:\`) and explain why; a bare `/` still means the workspace
- `/tan` agents now treat the conversation they fork from as reference only and stop after finishing your request, instead of picking up or deferring to the main agent's in-progress work
- The main agent no longer sees `/tan` dispatch notices or gets woken when a tangent finishes; with your next message it gets a short record linking the tangent's output
- Subagents may now run quick checks on their own files; only full builds and whole test suites wait for the parent agent.
- Recovered retry notices preview the saved error and show the successful fallback route ([#20770](https://github.com/can1357/oh-my-pi/pull/20770) by [@dagurval](https://github.com/dagurval)).
- Redesigned the `/live` call panel in Tern: your voice as a moving wave in the call's color, the transcript as a caption, and the call's status beside Mute and End call.
- Redesigned the composer's dictation control in Tern: while recording it shows a live wave of your voice and the time recorded beside a stop button.
- In Tern, only a click on a `/btw` note's question line points the composer at the note; clicking its answer to read or select it no longer does.
- Bash can now load approved `.envrc` files and opt-in `.env` files without requiring `direnv`, using the exact approved file contents.
- URL reading now preserves cookies across redirects, follows meta refreshes, falls back to the headless browser when plain fetching is blocked, and uses the native reader for X, YouTube, docs.rs, Discourse, and Mastodon while raw reads bypass site-specific rendering.
- Expanded `bash.gitGuard` protection in shared checkouts to cover more history-changing Git operations, including rebase, merge, pull, cherry-pick, revert, amend, and non-dry-run clean operations.
- Improved bash approval guidance by explaining which shell syntax prevents a `bash.patterns` rule from bypassing approval prompts.
- Exiting or restarting no longer flashes a "Closing session…" toast; a status appears only when closing takes longer than 3 seconds.
- Local dictation now defaults to Fluid Speech Pro (`local/fluid-speech-pro`), a further-trained Parakeet TDT 0.6B v3 that stays accurate with noise or music in the room. `local/parakeet-tdt-0.6b-v3` roles and fallback chains migrate to it automatically.
- Live voice mode now uses Codex's `gpt-live-1.1-codex` realtime model.
- Updated the local speech runtimes to sherpa-onnx 2.0.3 and Transformers.js 4.3.2; they reinstall on first use.
- Shortened and bracketed bash's notices, e.g. `[next call: cwd → …, set -e off]`, `[timeout clamped: 7200s → 3600s]`, `[backgrounded as bg_3, killed at 300s total; …]`, `[took 1.23s]`, `[exit code 3]`, `[timed out after 30s]`, `[cancelled]`; eval's notices follow suit, e.g. `[Python kernel restarted; earlier state gone]`, `[timed out after 30s; kernel interrupted, state kept]`.
- `cfg://` writes to map settings such as `modelRoles` now change only the entries they name (`null` removes one), so approval prompts and transcripts show just those entries instead of the whole map, and saving one entry keeps the others in your config.
- During `/live`, the coding agent is told that requests arrive by voice and its final message is read aloud, so it answers in speakable prose instead of tables; it is also told when the live session ends ([#20700](https://github.com/can1357/oh-my-pi/pull/20700) by [@materemias](https://github.com/materemias))
- The task tool's agent list now shows each restricted agent's tools (e.g. `scout` has no shell), and `scout` reports a requested method it cannot perform instead of silently substituting a weaker one ([#7020](https://github.com/can1357/oh-my-pi/issues/7020))
- The tool-call loop guard now also flags consecutive tool calls whose arguments drift only in numbers when the assistant's text repeats, and the loop-guard setting's description covers the wider detection. Progress-bearing arguments such as `grep`'s `skip` and file names inside shell commands stay distinct. Valid pagination and file sweeps are not interrupted ([#13426](https://github.com/can1357/oh-my-pi/pull/13426) by [@nick-maderight](https://github.com/nick-maderight))
- Moonshot no longer accepts `KIMI_API_KEY` as a fallback alias for `MOONSHOT_API_KEY`: the alias silently authenticated Moonshot and exposed Moonshot models whenever a Kimi Code key was set. `KIMI_API_KEY` now belongs to the `kimi-code` / `kimi-code-global` providers; set `MOONSHOT_API_KEY` for Moonshot.
- Moonshot no longer accepts `KIMI_API_KEY` as a fallback alias for `MOONSHOT_API_KEY`: the alias silently authenticated Moonshot and exposed Moonshot models whenever a Kimi Code key was set. `KIMI_API_KEY` now belongs to the `kimi-code` / `kimi-code-global` providers; set `MOONSHOT_API_KEY` for Moonshot ([#20509](https://github.com/can1357/oh-my-pi/pull/20509) by [@digi4care](https://github.com/digi4care)).
- The eval `commit` draft summary now ends Review with a scoped recovery hint (`show(path)`, then `take(path, units)` for the units your edits or commands such as a formatter produced), and Unrecorded points to `take(path, units)` for part of a file ([#20556](https://github.com/can1357/oh-my-pi/issues/20556))
- LSP servers now shut down after 15 minutes idle by default instead of staying alive for the whole session; set `idleTimeoutMs: 0` in `lsp.json` to keep them running ([#17477](https://github.com/can1357/oh-my-pi/issues/17477))
- `omp plugin disable` and the Settings → Plugins enable toggle now note that running sessions keep the plugin until they restart ([#9722](https://github.com/can1357/oh-my-pi/issues/9722))
- Status line keeps the auto indicator on an auto-resolved thinking effort (e.g. `⟳ high`) so it is distinguishable from a pinned level ([#5951](https://github.com/can1357/oh-my-pi/issues/5951))
- A configured MCP `oauth.scope` now overrides scopes advertised by the server on initial authorization and `/mcp reauth`, so you can request a narrower (or different) scope set than discovery reports ([#7841](https://github.com/can1357/oh-my-pi/issues/7841))

### Fixed

- In Tern, `/copy` and `/annotate session` share the same block picker on desktop and mobile. Clicking a side preview accepts the full item and closes the picker ([#20791](https://github.com/can1357/oh-my-pi/pull/20791) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Resuming a session after its omp crashed or was killed now reminds about, and at session end reaps, the background processes that omp left running, while a second live omp on the same session still leaves them alone
- Restored automatic discovery of the Windows Chrome relay from WSL2 with mirrored networking ([#20809](https://github.com/can1357/oh-my-pi/pull/20809) by [@taibenvenuti](https://github.com/taibenvenuti)).
- Managed Chromium tabs now use the browser's own hardware concurrency in pages and workers rather than overriding it in pages alone.
- Emulating a larger viewport on an attached Chromium tab no longer resizes the browser window shared with the user's other tabs.
- The bash tool's builtin `grep` prints invalid-regex errors as one GNU-style line (`grep: Unmatched ( or \(`), treats an unclosed `-E` interval such as `a{1` as literal text, prints `--` between groups for `-A0`/`-B0`/`-C0`, and no longer ends file errors with `(os error N)`
- The bash tool's builtin `sed` reports script errors in GNU form (``sed: -e expression #1, char 3: unterminated `s' command``), reports an unreadable input file as `can't read FILE` and continues with the rest, and supports GNU's `e`, `R` and `s///Ng`
- The bash tool's builtin `awk` leaves redirected input just after the last record it read when it exits early, so `{ awk 'NR==1{print; exit}'; cat; } < file` prints the whole file
- The bash tool's builtin `grep` honors `--line-buffered`, leaves redirected input just after the last selected line for `-m`, and reports binary input as `binary file matches` on stderr instead of sending raw bytes down the pipe
- The bash tool's builtin `sed` reads only up to the current line with `-u` (so `ps | { sed -u 1q; sort; }` keeps the header idiom working), leaves redirected input after the last line read on `q`/`Q`, and splits records on NUL with `-z`
- The bash tool's builtin `awk` keeps the `\r` of CRLF lines instead of silently converting them to LF
- The bash tool's builtin `grep` rejects malformed basic regexes (`\(`, `[`, `a\{1`, `[z-a]`, a trailing `\`, …) with GNU's error and exit status 2 instead of silently reporting no match
- The bash tool's builtin `tee` stops with SIGPIPE when its reader exits instead of hanging (`yes | tee file | head -1`), and `tee -p` ends quietly once every output pipe is gone
- The bash tool's builtin `xargs` starts each batch as soon as it is full instead of waiting for end of input, reports commands killed by a signal as GNU does (exit 125), and still runs the arguments before an unmatched quote
- Commands the bash tool's builtins start after the downstream reader exited now get SIGPIPE on their first write instead of exiting 0, so `yes | xargs -n1 /bin/echo | head` ends
- The bash tool's builtin `sort -c` names stdin as `-` instead of an internal temp file
- The bash tool's builtin `cut` reports bad `-b`/`-c`/`-f` lists in GNU's words (`fields are numbered from 1`) with the `--help` hint, `tr` adds that hint to operand errors, `sort` file errors no longer end with `(os error N)`, and `xargs` words a 255 exit as GNU does (`sh: exited with status 255; aborting`)
- `xargs` treats an external command that exits 141 as an ordinary failure (status 123), as GNU does; only a command really ended by SIGPIPE stops it with status 125
- The bash tool's builtin `head` now leaves redirected input where it stopped, so `{ head -n1; cat; } < file` prints the whole file and a second `head` continues on the next line instead of mid-file; `head` and `wc` errors no longer end with `(os error N)`
- `tui.maxInlineImages` takes effect again: the configured number of inline images stays live as terminal graphics, `0` keeps every image, and changing it redraws the transcript under the new limit ([#20843](https://github.com/can1357/oh-my-pi/issues/20843))
- Ctrl+C and Ctrl+D on an empty startup composer exit cleanly even while an extension or custom tool is loading.
- Changing `tui.resizeScrollback` while a session runs (`/settings`, `cfg://`, a config reload) now applies to the next resize instead of only after a restart ([#20845](https://github.com/can1357/oh-my-pi/issues/20845))
- Fixed `tui.autoGraph` charts not appearing below numeric tables in graphics-capable terminals outside Tern ([#20842](https://github.com/can1357/oh-my-pi/issues/20842)).
- `tui.spinnerInterval` (`--spinner-interval`) and `tui.motion` apply to every spinner in the terminal UI again, not only the terminal title; `tui.motion: reduced`/`none` also stops decorative blink, fade, and pulse ([#20844](https://github.com/can1357/oh-my-pi/issues/20844))
- Once-mode TTSR rules can fire again after `/new` or RPC `new_session` without restarting omp ([#20851](https://github.com/can1357/oh-my-pi/issues/20851)).
- The shared daemon no longer balloons to gigabytes when an LSP file watcher over a very large tree (such as a directory of many git worktrees) loses changes: the rescan checks files directory by directory instead of holding every path below the watched base at once ([#20853](https://github.com/can1357/oh-my-pi/issues/20853))
- Switching models while a response streams over OpenAI Responses or Codex WebSockets (`/model`, a model preset, model cycling) no longer cuts that response off; the new model takes effect on the next request ([#20858](https://github.com/can1357/oh-my-pi/pull/20858) by [@JustasMasiulis](https://github.com/JustasMasiulis)).
- Extensions whose `.tsx`/`.jsx` files use `/** @jsxImportSource @oh-my-pi/pi-tui */` load in the compiled omp binary instead of failing with `Cannot find package '@oh-my-pi/pi-tui'` ([#20840](https://github.com/can1357/oh-my-pi/issues/20840))
- Fixed web search with GitHub Copilot Claude models: it now uses the Copilot login's token and endpoint (Enterprise included) and sends the same Copilot and session headers as chat, so replies are no longer rejected or blocked ([#20678](https://github.com/can1357/oh-my-pi/issues/20678))
- Session mentions whose title carries a card icon no longer show a second session icon in front of it
- Git mention chips in the composer draw in the git color instead of plain text
- Re-registering a fixed-model gateway now pairs the replacement URL with its credential and does not reuse another credential’s cached model list.
- Discovered chat and embedding prices now honor the advertised per-token or per-million unit.
- Oversized jq results no longer label a truncated preview as the full output, and `write` rejects incomplete read projections when creating archive members.
- Fullscreen extension overlays can scroll with the mouse wheel again by enabling mouse reporting in `ctx.ui.custom` and handling it on the canvas ([#20819](https://github.com/can1357/oh-my-pi/issues/20819)).
- Edit results now show the edited branch and the session branch when a file is changed in another linked Git worktree ([#20801](https://github.com/can1357/oh-my-pi/pull/20801) by [@Quantum-Quasar](https://github.com/Quantum-Quasar)).
- Cross-worktree edit notices now also cover multi-file `magic` edits, both ends of cross-worktree moves, writes through file symlinks, Cursor-materialized edits, and browser/HTML transcript views, while skipping hashline no-ops ([#20823](https://github.com/can1357/oh-my-pi/pull/20823) by [@Quantum-Quasar](https://github.com/Quantum-Quasar)).
- A running subagent no longer publishes a task progress update when only its elapsed time changed: such updates now go out at most every 5 seconds, which keeps elapsed timers moving and cuts task update traffic to RPC clients, session observers and transcripts by about 8x ([#20810](https://github.com/can1357/oh-my-pi/pull/20810) by [@Xytronix](https://github.com/Xytronix))
- The Hindsight retain outbox sends queued memories in the order they were queued, on every filesystem ([#20817](https://github.com/can1357/oh-my-pi/pull/20817) by [@sjawhar](https://github.com/sjawhar))
- Fixed `omp render` (or a second omp opening the same session) killing the background processes of the live omp that owns the session ([#20811](https://github.com/can1357/oh-my-pi/pull/20811) by [@satansdeer](https://github.com/satansdeer))
- Spotlight no longer cuts tool results in sessions without the `read` tool (such as an RPC host's own tools under `--no-tools`), where the agent could not read the hidden lines back
- Fixed a handoff model that never stops streaming holding automatic compaction indefinitely: handoff output is now capped like a summary, and the new `compaction.handoffTimeoutSeconds` setting (off by default) fails a handoff that runs too long so automatic compaction moves on to the next method and `/handoff` reports the timeout ([#18031](https://github.com/can1357/oh-my-pi/issues/18031))
- Fixed the tool-call loop guard never stopping a model that keeps calling nonexistent tools (`wri`, `ed`, `ba`) with varying names or arguments; it now redirects after `model.toolCallLoopGuard.threshold` such turns in a row, while a single typo followed by a valid call is unaffected ([#10876](https://github.com/can1357/oh-my-pi/issues/10876))
- Fixed eval `sh()` running commands the bash interceptor (`bashInterceptor.patterns`) redirects to dedicated tools; it now fails with the same guidance as the bash tool ([#20033](https://github.com/can1357/oh-my-pi/issues/20033))
- User prompts emit OSC 133 marks only on first entering terminal history, keeping repaints from piling up markers in the VS Code terminal ([#20793](https://github.com/can1357/oh-my-pi/issues/20793)).
- Terminals that list OSC 133 commands (such as tuios' scrollback browser) now find each user prompt as a command instead of an empty entry ([#20123](https://github.com/can1357/oh-my-pi/issues/20123)).
- `/resume` of a session from another directory, and `/move`, no longer close the session when Mnemopi memory had already failed to start: the session opens in the new directory with memory off and a warning. When memory was running before, the move is still refused and the session stays where it was ([#20760](https://github.com/can1357/oh-my-pi/pull/20760) by [@sjawhar](https://github.com/sjawhar))
- `hideThinkingBlock: true` now hides thinking blocks from the moment the TUI starts, instead of showing them until the first streamed reasoning arrives ([#17369](https://github.com/can1357/oh-my-pi/issues/17369))
- Alt+L (reset terminal display), Ctrl+T, Ctrl+R, Ctrl+G and Ctrl+Shift+O work again while an ask form or ask dialog holds focus ([#20771](https://github.com/can1357/oh-my-pi/issues/20771))
- `/context` in Tern scrolls an entry's full content (such as the system prompt) with `tui.select.up`, `tui.select.down`, `tui.select.pageUp`, and `tui.select.pageDown` again, not only with the mouse wheel ([#20774](https://github.com/can1357/oh-my-pi/pull/20774) by [@C-W-Z](https://github.com/C-W-Z))
- Thinking-only replies now retry instead of ending without an answer while a speculative handoff is still running ([#20754](https://github.com/can1357/oh-my-pi/pull/20754) by [@Waldenz](https://github.com/Waldenz)).
- A local page embedded with a `#fragment` or `?query` (`<iframe src="demo/index.html#B">`) now opens at that fragment instead of failing with "No such file or directory"
- Browser helper calls (`tab.goto`, `tab.click`, `tab.evaluate`, etc.) and tab reuse on Tern, WebKit, and cmux tabs no longer queue behind another tab's long-running `tab.run()`, and queued `tab.run()` timeouts now name the tab and agent holding the queue
- Fixed `tab.waitFor(1500)`, `tab.waitFor(() => …)` and other non-string selectors on Tern and WebKit tabs failing with `Unsupported selector engine undefined` or `null is not an object (evaluating 'sel.engine')`; they now fail like on Chromium, naming the sleep or `page.waitForFunction` to use instead
- Fixed a Chromium action on a selector the page cannot parse (`'input[name=q], label/Query'`) waiting out the whole action timeout; it now fails at once, and says that a `label/`-style prefix cannot join a CSS list
- `tab.wait()`, `tab.waitForTimeout()`, `tab.waitForLoadState()`, `tab.waitForURL()`, `tab.navigate()`, `tab.$()`, `tab.$$()`, `tab.on()` and `tab.setExtraHTTPHeaders()` in eval JavaScript now say what to call instead of failing with `is not a function`
- `page.setExtraHTTPHeaders()` in `tab.run` on Tern and WebKit tabs now says to use `tab.emulate({ credentials })` for basic auth or omp's own browser for other headers, instead of failing with `is not a function`
- An eval JavaScript cell that uses `document`, `window`, `location` or another page-only global now says to run that code in the page with `tab.evaluate(...)`
- A timed-out direct helper call on Tern, WebKit and cmux tabs now names the helper that stalled and how to raise the time limit
- `tab.storage()` without a storage kind and `tab.setCookies([])` now say what they expected instead of "Storage kind must be local or session" and "malformed cookie input"
- A relay tab Chrome refuses because another debugger already holds every new tab now says what holds it and how to get past it
- The resume picker's **All projects** scope shows each session's folder in rows and the preview, and search matches folder paths there ([#20746](https://github.com/can1357/oh-my-pi/issues/20746))
- Reading `history://current/full` on Claude no longer returns the model's own earlier reasoning as text, which Anthropic refuses as `reasoning_extraction` ([#19740](https://github.com/can1357/oh-my-pi/issues/19740))
- The completion popup keeps the selected entry visible when descriptions wrap and hides its scrollbar when all entries fit ([#20731](https://github.com/can1357/oh-my-pi/issues/20731))
- Turning an extension off in `/extensions` hides its editor widgets; turning it back on restores them ([#20725](https://github.com/can1357/oh-my-pi/issues/20725)).
- On Windows, closing the terminal that first started the shared omp daemon no longer kills the daemon and the services of other sessions, as long as the terminal's job object allows breakaway ([#20722](https://github.com/can1357/oh-my-pi/issues/20722))
- Fixed async compaction paying for a second summary during ordinary growth through a wide pre-threshold band ([#20739](https://github.com/can1357/oh-my-pi/issues/20739)).
- Turn recovery no longer re-sends a request whose provider already used up its own 503/504 retries; it moves to the next `retry.fallbackChains` model at once or ends the turn with the provider's message
- Declining a provider's consent screen during `/login` or `omp login` now reports the sign-in as canceled, in the terminal and on the browser page, instead of as a failed login
- `/resume` search uses the new session title immediately after you rename it, without reopening the picker. ([#20753](https://github.com/can1357/oh-my-pi/pull/20753) by [@yyydddkkk](https://github.com/yyydddkkk))
- `/todo import` preserves multiline tasks from `/todo export` ([#20757](https://github.com/can1357/oh-my-pi/pull/20757) by [@yyydddkkk](https://github.com/yyydddkkk)).
- `edit` on `ssh://` files no longer contacts the host before the call is approved, and refuses to overwrite a file that changed on the host after the edit fetched it. Writable RPC host URIs get the same check as a read just before the write, so a change landing between that read and the write is not caught ([#16631](https://github.com/can1357/oh-my-pi/pull/16631) by [@lHyperionl](https://github.com/lHyperionl))
- `edit` refuses `ssh://` symbolic links instead of replacing them with a regular file, and refuses creating, deleting or moving `ssh://` files before its preview ([#16631](https://github.com/can1357/oh-my-pi/pull/16631) by [@lHyperionl](https://github.com/lHyperionl))
- `read` and `edit` give `ssh://host/~/x` and its absolute spelling one tag, and `read` shows `ssh://` notebooks as cells like local ones ([#16631](https://github.com/can1357/oh-my-pi/pull/16631) by [@lHyperionl](https://github.com/lHyperionl))
- A todo update no longer hides the rest of a long turn: tool output after it stays in terminal scrollback instead of vanishing behind a one-row todo line and a clipped empty card frame ([#20705](https://github.com/can1357/oh-my-pi/pull/20705) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- `/tree` opens on long sessions instead of failing with "Maximum call stack size exceeded" ([#20702](https://github.com/can1357/oh-my-pi/pull/20702) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- `/copy` and `/rewind` open quickly on long sessions with few prompts: they draw the turns within the last 600 entries instead of reaching back to the prompt before them, often the whole session; `a` or a rewind filter query loads the rest ([#20703](https://github.com/can1357/oh-my-pi/pull/20703) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- The rewind, copy and tree pickers show "Loading the session history…" in the composer's hint while a long session's history draws, instead of seeming to ignore `/rewind`, `/copy`, `/tree` or Esc Esc until they appear ([#20704](https://github.com/can1357/oh-my-pi/pull/20704) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- ACP `/usage` shows remaining balances and uses one fallback account label per report ([#20701](https://github.com/can1357/oh-my-pi/pull/20701) by [@dagurval](https://github.com/dagurval)).
- Long answers in an ask form's single-line inputs, including the Other field, now scroll with the caret and indicate hidden text on either side ([#20694](https://github.com/can1357/oh-my-pi/issues/20694)).
- Backgrounded Bash cards keep updating until their first content row enters terminal scrollback, and stay in order when the transcript is rebuilt ([#20724](https://github.com/can1357/oh-my-pi/pull/20724) by [@JustasMasiulis](https://github.com/JustasMasiulis)).
- Pasting text that ends in an `@name` no longer opens the file completion list, so the next Enter sends the message instead of replacing the name with a file ([#20681](https://github.com/can1357/oh-my-pi/issues/20681))
- Rebuilding a long transcript in place (compaction, `/shake`, a display setting change) no longer stalls Tern: the block list is recomputed once for the rebuild instead of once per replayed block ([#20675](https://github.com/can1357/oh-my-pi/pull/20675) by [@H4vC](https://github.com/H4vC))
- `lsp` tool calls with `new_name: null` or `line: null` no longer crash the TUI while rendering ([#20663](https://github.com/can1357/oh-my-pi/issues/20663)).
- IRC message cards draw the quoted message's rail and the recipient branches as one continuous line instead of a rail two cells right of the branches, and cancelled-job branches on `proc://` cards sit two cells in to match ([#20715](https://github.com/can1357/oh-my-pi/pull/20715) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- Rebuilding the transcript now removes replaced blocks in one update instead of updating the view for each block ([#20658](https://github.com/can1357/oh-my-pi/pull/20658) by [@H4vC](https://github.com/H4vC))
- Output after a running background task remains accessible in terminal scrollback when omp rebuilds the transcript. ([#20656](https://github.com/can1357/oh-my-pi/pull/20656) by [@loishi](https://github.com/loishi))
- `/plugins` (and `/plugins list`) shows installed plugins in an "Installed Plugins" report with one plugin per line, like `/mcp list`, instead of a status line that ran them together ([#20653](https://github.com/can1357/oh-my-pi/issues/20653)).
- The ask form's `<textarea>` wraps long lines in the terminal and keeps the caret row in view instead of cutting each line to one row with `…` ([#20651](https://github.com/can1357/oh-my-pi/issues/20651)).
- Single-file reads and read preview titles now highlight the path like grouped reads (dim directory, colored file name, muted line range) instead of painting it flat in the accent color ([#20615](https://github.com/can1357/oh-my-pi/pull/20615) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- Large pictures in assistant replies (`<img>` embeds, page stills, SVG fences) now fit within 80% of the terminal's height instead of drawing at full size past the screen ([#20620](https://github.com/can1357/oh-my-pi/pull/20620) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- `todo.eager: preferred` or `always` no longer logs an `Eager todo enforcement skipped` warning for every subagent (or other session) running without the `todo` tool ([#20649](https://github.com/can1357/oh-my-pi/issues/20649)).
- Advisor transcripts opened from the Agent Hub respond to `Esc`, the scroll keys and the hub key again instead of ignoring every key ([#20628](https://github.com/can1357/oh-my-pi/issues/20628)).
- Fixed task tools listing agents from another session's extension roots, and omitting agents from their own, when sessions share a directory ([#20751](https://github.com/can1357/oh-my-pi/pull/20751) by [@sjawhar](https://github.com/sjawhar))
- With `mnemopi.autoRetain` off, and in subagents, the Mnemopi memory instructions no longer tell the model that completed turns are retained automatically ([#20748](https://github.com/can1357/oh-my-pi/pull/20748) by [@sjawhar](https://github.com/sjawhar)).
- Blob-broker tunnels no longer flash console windows on Windows, including when a tunnel fails to start and is retried ([#20599](https://github.com/can1357/oh-my-pi/issues/20599)).
- `/restart` keeps the session open if its working directory was deleted and suggests using `/move` before retrying ([#20594](https://github.com/can1357/oh-my-pi/issues/20594)).
- `http` MCP servers that answer `server/discover` with a plain HTTP 415 (rmcp 0.2, e.g. `elastic/mcp-server-elasticsearch`) now connect through the `initialize` handshake instead of failing ([#20588](https://github.com/can1357/oh-my-pi/issues/20588)).
- `/usage` shows OpenCode Go quota windows again instead of `API key — usage unavailable` after the model catalog refreshes ([#20581](https://github.com/can1357/oh-my-pi/issues/20581)).
- Terminal images at the edges of assistant replies no longer disappear or draw above their allotted rows ([#20569](https://github.com/can1357/oh-my-pi/issues/20569)).
- While the agent waits on background jobs or subagents after answering, the working row keeps naming what it waits for instead of reverting to `Working…` or disappearing after an error, a refused prompt, `/fork`, `/wt`, `/compact`, or a `/tree` branch summary ([#20603](https://github.com/can1357/oh-my-pi/pull/20603) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- After `/fork` or `/wt` while the agent waits on background jobs or subagents, the status line keeps showing it as working instead of idle ([#20610](https://github.com/can1357/oh-my-pi/pull/20610) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- Stopping a service also ends descendants that started their own session and ignored SIGTERM, such as a Playwright `webServer`; they used to keep running with no parent after the service stopped ([#20597](https://github.com/can1357/oh-my-pi/pull/20597) by [@daandden](https://github.com/daandden))
- The `/debug` menu takes keys again outside Tern; it no longer opens with every key ignored, leaving omp to be killed ([#20576](https://github.com/can1357/oh-my-pi/pull/20576) by [@FYWinds](https://github.com/FYWinds))
- Bash tab completion preserves spaces in file and directory names ([#20604](https://github.com/can1357/oh-my-pi/pull/20604) by [@yyydddkkk](https://github.com/yyydddkkk)).
- `bash.patterns` rules with several `*` wildcards no longer freeze the session and its subagents for minutes when checked against long commands ([#20591](https://github.com/can1357/oh-my-pi/issues/20591)).
- `/prewalk`, `/prewalk restart`, and `/switch` now accept `^provider/id[:level]` model references inserted by `^` completion ([#20564](https://github.com/can1357/oh-my-pi/issues/20564)).
- Resuming or rewinding a session with an aborted task result no longer throws while the transcript renders; the card shows the cancellation text ([#20533](https://github.com/can1357/oh-my-pi/pull/20533) by [@g0spel](https://github.com/g0spel))
- Save in Plan Review now accepts a custom path and shows where the plan was saved without requiring you to dismiss the review ([#20539](https://github.com/can1357/oh-my-pi/issues/20539)).
- The focused diff in Tern's native `/git` preview now scrolls with the arrow keys, Page Up/Page Down, and Home/End ([#20537](https://github.com/can1357/oh-my-pi/issues/20537)).
- The Bash interceptor no longer redirects read-only Perl commands mentioning `-i` to `edit`, and now recognizes clustered in-place switches such as `perl -lpi` ([#20558](https://github.com/can1357/oh-my-pi/issues/20558)).
- `omp --help` no longer lists the unsupported `ANTHROPIC_SEARCH_BASE_URL` override ([#20562](https://github.com/can1357/oh-my-pi/pull/20562) by [@eggpeat](https://github.com/eggpeat))
- In a compiled omp with no `bun` on PATH, `bun` in a JS eval cell now reports that bun is not installed instead of starting a headless omp ([#19241](https://github.com/can1357/oh-my-pi/pull/19241) by [@mccraigmccraig](https://github.com/mccraigmccraig))
- In Tern, the agent tray no longer keeps showing the previous session's agents after `/resume` switches to another session.
- In Tern, finishing an annotation of a pasted image now updates its attachment, and the prompt sends the annotated image instead of the original.
- The Gemini planning-header loop guard interrupts at most once until the model calls a tool, so long reasoning on hard or tool-free tasks finishes instead of being interrupted and restarted repeatedly.
- The `/agents` hub accepts keys again after opening a model pattern input, the model picker, or the New agent form; the terminal no longer stops responding ([#20552](https://github.com/can1357/oh-my-pi/issues/20552))
- The external editor (Ctrl+G) opened from an extension `ctx.ui.editor` dialog, the ask prompt, or the advisor instructions editor no longer has omp drawing over it and taking its keys ([#20546](https://github.com/can1357/oh-my-pi/pull/20546) by [@rierek](https://github.com/rierek))
- Fixed WebP tool results showing a text placeholder instead of the image, and enabled WebP and GIF image embeds in the terminal ([#20521](https://github.com/can1357/oh-my-pi/pull/20521) by [@shgew](https://github.com/shgew))
- Extension transcript presenters' compact tool-call and read rows draw their `TspSpan` theme styles again, and consecutive compact tool, read, `!`/`$` run and message blocks pack without blank rows between them ([#20512](https://github.com/can1357/oh-my-pi/issues/20512)).
- Restored `tui.imeSafeCursor`, which moves the prompt's bottom border to its own row so macOS IME preedit cannot displace it ([#20503](https://github.com/can1357/oh-my-pi/pull/20503) by [@SenCha930511](https://github.com/SenCha930511))
- A tool card taller than the room left above the editor (a Task call with a long shared context) now shows its title and newest rows instead of collapsing to a two-row `╭─ Task · running` stub over blank space ([#20642](https://github.com/can1357/oh-my-pi/pull/20642) by [@Petyok](https://github.com/Petyok)).
- Re-enabling advisors reloads `WATCHDOG.yml` and its imported rules from disk ([#20541](https://github.com/can1357/oh-my-pi/issues/20541)).
- Renaming a session from `/resume` accepts keyboard input again and returns focus to the picker after saving or cancelling ([#20548](https://github.com/can1357/oh-my-pi/issues/20548)).
- Custom composer shapes can add blank rows above the input and keep the caret on the text row ([#20532](https://github.com/can1357/oh-my-pi/issues/20532)).
- Fixed ACP and RPC `/mcp` commands to respect project-server precedence, enable/disable overrides, and the session working directory. ([#20499](https://github.com/can1357/oh-my-pi/pull/20499) by [@eggpeat](https://github.com/eggpeat))
- Fixed `bash.patterns` approval false positives on benign flags (`go test -race`, `rg -e`, `jq -c`, quoted commit messages with `-e`/`-c`, ANSI-C `$'...'` strings) by parsing commands with omp's native Bash/Zsh parser and a command-aware argument guard ([#20686](https://github.com/can1357/oh-my-pi/pull/20686) by [@asuffield](https://github.com/asuffield))
- Fixed headless browser automation on Windows sometimes showing a blank white Chrome window by launching its hidden native window off-screen ([#5397](https://github.com/can1357/oh-my-pi/issues/5397), [#5524](https://github.com/can1357/oh-my-pi/pull/5524) by [@dragonbaba](https://github.com/dragonbaba))
- Fixed agents writing implementation details and session notes into README and other docs after every fix: the system prompt now asks for docs/changelog updates only when documented or user-visible behavior changes, in user terms and following the repository's own conventions ([#16155](https://github.com/can1357/oh-my-pi/issues/16155))
- `/reload-plugins` now reports only what it reloaded (skills, slash commands, task agents and MCP servers in the TUI; skills and slash commands over ACP/RPC) and says extension hooks and tools need an omp restart, instead of claiming it reloaded them ([#7260](https://github.com/can1357/oh-my-pi/issues/7260))
- Dictation now warns once when the speech model cannot load on the GPU (e.g. out of VRAM) and falls back to CPU, naming the fallback device and the reason ([#11040](https://github.com/can1357/oh-my-pi/issues/11040))
- Fixed `wait` guidance sending agents to ask the user to check back later on an outside condition (a CI run, a deploy): the tool description and the back-to-back wait reminder now name one async `bash` watcher that exits once the condition holds, then ending the turn or calling `wait`, and limit the `sleep` job rule to sleeping just to keep calling `wait` ([#18900](https://github.com/can1357/oh-my-pi/issues/18900))
- RPC mode now writes a `notice` frame with `source: "session-model-restore"` before exiting when a startup `--continue`/`--resume` cannot restore the saved model, so hosts can tell the fail-closed exit from a crash and rebind via `open_session`/`switch_session` with an explicit model ([#17611](https://github.com/can1357/oh-my-pi/issues/17611))
- Corrected the theme docs: markdown code fences render as `mdCodeBlockBorder`-colored fence rows, not `boxRound.*` frames ([#20111](https://github.com/can1357/oh-my-pi/issues/20111))
- Fixed routine absolute-path `rm -f` and `rm -r` commands ignoring the bash allow policy in `write` mode; home directories and protected system roots still require approval ([#20241](https://github.com/can1357/oh-my-pi/issues/20241), [#20244](https://github.com/can1357/oh-my-pi/pull/20244) by [@roboomp](https://github.com/roboomp))
- `omp usage` no longer reports a disabled MCP OAuth login as `re-login to restore` after the server has been logged into again ([#20627](https://github.com/can1357/oh-my-pi/issues/20627))
- Fixed extensions importing an old-API `@oh-my-pi/pi-tui` subpath (e.g. `@oh-my-pi/pi-tui/prompt/custom-editor`) failing with a misleading `Cannot find package` error, sometimes naming `@oh-my-pi/pi-natives`; the load error now names the unsupported import and the pi-tui migration guide ([#20517](https://github.com/can1357/oh-my-pi/issues/20517))
- Fixed JPEG and WebP tool-result images (e.g. browser screenshots, auto-resized reads) rendering as `[Image: …]` placeholders instead of inline images ([#20636](https://github.com/can1357/oh-my-pi/issues/20636), [#20691](https://github.com/can1357/oh-my-pi/pull/20691) by [@Quik95](https://github.com/Quik95))
- Fixed an LSP watched-files crash when a file watcher reports an event without a filename; the watcher now rescans instead of throwing ([#20372](https://github.com/can1357/oh-my-pi/issues/20372))
- `bash.patterns` `deny`/`prompt` rules and critical-command patterns no longer refuse or prompt a bash line made only of tool commands because a tool's argument text contains the rule's words; each tool is still approved by its own `tools.approval` policy ([#20317](https://github.com/can1357/oh-my-pi/issues/20317))
- Idle auto-compaction no longer summarizes the conversation while a submitted plan awaits your answer in Plan Review; the idle timer restarts once the review is answered or dismissed ([#20662](https://github.com/can1357/oh-my-pi/issues/20662))
- Fixed `todo` `init` and `append` accepting non-string task entries (such as phase objects passed in flat `items`) and storing their JSON text as task labels; the call now fails with an error pointing at `list: [{phase, items}]` ([#20669](https://github.com/can1357/oh-my-pi/issues/20669))
- Fixed `bash script.sh`, `sh -c '…'` and other nested `bash`/`sh` shells in the bash tool skipping their `EXIT` trap when the script ends without `exit`, which left `trap 'rm -rf "$tmp"' EXIT` cleanups undone ([#20047](https://github.com/can1357/oh-my-pi/issues/20047))
- Documented that extension `getThinkingLevel()` returns `undefined` when the model has no concrete effort (e.g. off/auto-only models on `auto`) ([#20128](https://github.com/can1357/oh-my-pi/issues/20128))
- Fixed Hindsight mental models being truncated when the complete block fits the render cap, and redistributed unused space from short models to longer ones ([#19857](https://github.com/can1357/oh-my-pi/issues/19857))
- Fixed `context_notes` rejecting writes with "session branch changed" when the same session branch advanced while the notebook was being saved, such as after resuming a session that called `new_context` ([#19802](https://github.com/can1357/oh-my-pi/issues/19802))
- Fixed self-hosted FTP/FTPS blob uploads hanging publication forever on a stalled server; the curl upload is now killed after `options.timeoutMs` (default 120s) ([#19684](https://github.com/can1357/oh-my-pi/issues/19684))
- `commit` refuses colocated Jujutsu workspaces and points to `jj`, instead of advancing Git HEAD and leaving a duplicate of jj's working-copy change ([#19815](https://github.com/can1357/oh-my-pi/issues/19815))
- Fixed `omp skill publish` producing different package integrities for the same files on macOS and Linux ([#19402](https://github.com/can1357/oh-my-pi/issues/19402))
- The `encourageEdits` rule now applies only to content-addressed edits and permits scripts for mechanical bulk or encoding transforms (cross-file patterns, line endings, whitespace) that `edit` cannot express ([#19350](https://github.com/can1357/oh-my-pi/issues/19350))
- Logged automatic compactions vetoed by a `session_before_compact` hook, and mid-run compaction logs now report whether the attempt committed, was vetoed, or hit a dead end instead of always claiming it ran ([#19563](https://github.com/can1357/oh-my-pi/issues/19563))
- Fixed `registerProvider` with a fixed `models` list ignoring the provider's `transport` ([#18960](https://github.com/can1357/oh-my-pi/issues/18960))
- The `task.maxRecursionDepth` setting now states that `0` disables subagents entirely (it is labelled `Disabled`, not `None`) and `1` allows one generation, and `--tools task` names the setting when it removed `task` ([#19077](https://github.com/can1357/oh-my-pi/issues/19077))
- Fixed `write` creating a new file from a truncated `read` result; content ending in a read truncation notice is now refused for missing targets too ([#18855](https://github.com/can1357/oh-my-pi/issues/18855))
- Fixed the ACP model picker omitting background-discovered models (such as Copilot 1M variants) and rejecting their selection by waiting for in-flight model discovery before returning session config options or switching models ([#19127](https://github.com/can1357/oh-my-pi/issues/19127))
- Fixed `browser` open silently reusing a running Chromium that lacks the requested `app.args`; it now reports the missing args and asks to quit the browser first ([#18858](https://github.com/can1357/oh-my-pi/issues/18858))
- The `[raw output: …]` footer on minimized or byte-capped tool output now names `local://N.log:raw`, so reading it returns the original text instead of a paged, column-capped view ([#18764](https://github.com/can1357/oh-my-pi/issues/18764))
- Fixed Claude marketplace plugins with a root-level `SKILL.md` and no `skills/` directory loading zero skills; the root `SKILL.md` now loads as one skill, matching Claude Code ([#18695](https://github.com/can1357/oh-my-pi/issues/18695))
- Fixed OpenRouter rejecting every request with `403 Request blocked: prompt injection patterns detected` on accounts with a blocking prompt-injection guardrail: system prompts and tool text no longer contain the role-tag-like `<tool>` placeholder ([#18756](https://github.com/can1357/oh-my-pi/issues/18756))
- Fixed MCP OAuth discovery, token exchange and refresh ignoring a `NODE_EXTRA_CA_CERTS` CA loaded after startup, which broke reauth behind TLS-inspecting proxies ([#18609](https://github.com/can1357/oh-my-pi/issues/18609))
- Fixed the `ask` form duplicating and shifting rows when a field `placeholder` spans several lines; its line breaks now collapse to spaces ([#18605](https://github.com/can1357/oh-my-pi/issues/18605))
- A task's `effort` hint no longer overrides an explicit `:level` on the same spawn's per-call `model`; e.g. `model: "anthropic/claude-opus-5-5:xhigh"` with `effort: "hi"` now runs at `xhigh` instead of `max` ([#18597](https://github.com/can1357/oh-my-pi/issues/18597))
- Fixed split commits on Windows aborting with "Split commit plan missing staged files" after changelog entries were applied ([#17446](https://github.com/can1357/oh-my-pi/issues/17446))
- Fixed Gemini web search ignoring `NODE_EXTRA_CA_CERTS` set in the agent `.env` ([#17811](https://github.com/can1357/oh-my-pi/issues/17811))
- Fixed `omp completions` output repeating its first 8192 bytes when stdout is a pipe ([#17625](https://github.com/can1357/oh-my-pi/issues/17625))
- `omp plugin install` now rejects `--local`, and `--scope project` for npm or local-path packages, before installing anything instead of silently writing to the user plugin registry ([#18112](https://github.com/can1357/oh-my-pi/issues/18112))
- With both eval runtimes enabled, the eval tool helper list now names the JS spelling `judgeBatch` alongside Python's `judge_batch` ([#17273](https://github.com/can1357/oh-my-pi/issues/17273))
- Fixed the working row keeping the previous turn's tool intent (e.g. a lone `todo init`) while the next model request is pending; it now falls back to the default label at each turn start ([#17347](https://github.com/can1357/oh-my-pi/issues/17347))
- Fixed `todo` init/append with an unknown field such as `tasks` failing as "Missing list for init operation"; the error now names the unknown field and the expected shape, and the tool description includes parameter examples ([#17052](https://github.com/can1357/oh-my-pi/issues/17052))
- Fixed `omp config get`/`list` ignoring `--config` overlays, whether passed before or after `config` ([#17092](https://github.com/can1357/oh-my-pi/issues/17092))
- Setup wizard key hints (provider sign-in, step footer) now spell out keys as words (`Enter`, `Esc`, `Up`/`Down`) instead of keycap glyphs that terminals without those glyphs showed as `?` ([#17411](https://github.com/can1357/oh-my-pi/issues/17411))
- Fixed a `:max` thinking suffix on Bedrock inference-profile ARNs being sent as part of the model id, causing HTTP 400 ([#16568](https://github.com/can1357/oh-my-pi/issues/16568))
- Fixed the setup sign-in step showing only a keycap glyph (`⎋`) for the key that continues; it now also spells out the key name (`⎋ (Esc)`), honoring custom `tui.select.cancel` bindings ([#16923](https://github.com/can1357/oh-my-pi/issues/16923))
- Fixed `/usage reset` reporting "no saved resets usable right now" when loading an account's saved resets failed; it now shows the load error ([#16487](https://github.com/can1357/oh-my-pi/issues/16487))
- Fixed the Mnemopi LLM Mode setting copy to say online mode uses the MEMORY role first, then TINY, then @smol ([#16408](https://github.com/can1357/oh-my-pi/issues/16408))
- Fixed `mnemopi.embeddingApiKey` and `mnemopi.llmApiKey` sending an environment variable name literally instead of resolving it, matching `models.yml` `apiKey` ([#16334](https://github.com/can1357/oh-my-pi/issues/16334))
- Waking a parked isolated subagent after a restart now says it is not resumable by design instead of "no reviver registered", and later wakes fail fast without re-reading its transcript ([#16448](https://github.com/can1357/oh-my-pi/issues/16448))
- Fixed hold-to-talk ending right after it started when opening the microphone blocked the TUI for slightly longer than the release window, which left the recording empty ([#16121](https://github.com/can1357/oh-my-pi/issues/16121))
- Fixed `browser.open()` over a connected relay with no eligible tabs waiting 10 seconds and failing with a raw timeout; it now fails at once and says to open a normal web page ([#16100](https://github.com/can1357/oh-my-pi/issues/16100))
- Fixed `read` JSON queries returning an empty `0B` result when a single output line exceeded the display limit; they now show a byte prefix with a partial-line notice ([#16018](https://github.com/can1357/oh-my-pi/issues/16018))
- Fixed `/usage` and `omp usage` showing nothing for an extension usage provider on a custom provider whose key is only set in `models.yml`; the quota is now fetched with that key ([#16081](https://github.com/can1357/oh-my-pi/issues/16081), reported by [@feihu-lgtm](https://github.com/feihu-lgtm))
- Python browser helpers keep an explicit `None` before keyword options, so `tab.ariaSnapshot(None, interactive=True)` and `tab.extract(None, selector="main")` work; a non-string file path or a missing selector now fails with an error naming the expected value ([#16618](https://github.com/can1357/oh-my-pi/issues/16618))
- Fixed `find` reporting a bare "no hits" when only the lexical shortlist was judged; it now states how many eligible files were judged and read so the result is not mistaken for an exhaustive search ([#15531](https://github.com/can1357/oh-my-pi/issues/15531))
- Fixed `openai-models-list` discovery ignoring OpenRouter-style `pricing` on `/v1/models` rows (e.g. ModelRelay), which showed every model at $0 cost ([#15655](https://github.com/can1357/oh-my-pi/issues/15655))
- The `worktree.clone` setting and worktree docs now state that clone-first worktrees copy every gitignored file, including `.env` files and other local secrets, not only build caches ([#15476](https://github.com/can1357/oh-my-pi/issues/15476))
- `omp commit` no longer saves its agent session, so it no longer clutters `omp --resume` and `/resume` ([#15247](https://github.com/can1357/oh-my-pi/issues/15247))
- `omp usage` and `/usage` now show "usage auth rejected (401); re-login to restore usage" instead of "no usage data" when a provider rejects the usage fetch as unauthorized, e.g. an expired Muse Code account token ([#15551](https://github.com/can1357/oh-my-pi/issues/15551))
- Corrected the extension authoring guide: native project extensions load only from `<cwd>/.omp/extensions/`, not ancestor directories ([#15067](https://github.com/can1357/oh-my-pi/issues/15067))
- Repeated `vibe_wait` calls on a still-running worker no longer trip the tool-call loop guard; `vibe_wait` is now exempt by default ([#15011](https://github.com/can1357/oh-my-pi/issues/15011))
- Advisors now use their own `retry.fallbackChains.advisor` chain on their first fallback instead of inheriting the main session's active fallback chain ([#15101](https://github.com/can1357/oh-my-pi/issues/15101))
- Fixed eval `agent()` spawning past an exhausted Goal Mode token budget that `budget()` reported as a hard ceiling ([#14946](https://github.com/can1357/oh-my-pi/issues/14946))
- Fixed hashline edits reusing stale line numbers after a shifting edit being accepted one line high, duplicating a line, when the body echoed the line above the range ([#15035](https://github.com/can1357/oh-my-pi/issues/15035))
- Defaulted the saved Codex/Claude reset prompt to "Not now" and split redeeming once from enabling auto-redeem, so a stray Enter no longer spends a reset or persists consent ([#13327](https://github.com/can1357/oh-my-pi/issues/13327))
- Account usage-limit failures (e.g. an exhausted Anthropic subscription window reported as `rate_limit_error`) now show as "account usage limit reached; resets in …" in the error banner and retry row instead of the raw rate-limit body ([#10733](https://github.com/can1357/oh-my-pi/issues/10733))
- Fixed the status-line session segment showing identical IDs for sessions created within about a minute by rendering 13 characters (the full UUIDv7 timestamp) ([#9572](https://github.com/can1357/oh-my-pi/issues/9572))
- Glob and batch `lsp diagnostics` now wait as long for each file as single-file diagnostics, retain completed reports at the call deadline, and identify unverified files ([#10701](https://github.com/can1357/oh-my-pi/issues/10701))
- Fixed bash `gh issue`/`gh pr` cache invalidation dropping the wrong row when a numeric flag value (e.g. `--parent 100`) preceded the target, and invalidating only the first of several targets ([#10626](https://github.com/can1357/oh-my-pi/issues/10626))
- Fixed extensions crashing when they call `isFocused()` on the overlay handle from `ctx.ui.custom(..., { overlay: true, onHandle })`; the handle now reports whether the overlay holds keyboard focus ([#10664](https://github.com/can1357/oh-my-pi/issues/10664))
- `/retry` in a focused subagent view now retries that agent's last failed turn, matching Alt+R, instead of being refused as a main-session command ([#7369](https://github.com/can1357/oh-my-pi/issues/7369))
- A refused or failed turn that had emitted tool calls is now dropped from the model's context together with its placeholder tool results, instead of being replayed on the next prompt or retry ([#7932](https://github.com/can1357/oh-my-pi/issues/7932))
- A long session no longer keeps every finished background job, with its full output, in memory after the job's result reaches the agent ([#20836](https://github.com/can1357/oh-my-pi/pull/20836) by [@sjawhar](https://github.com/sjawhar))
- Skipped prompt-cache writes for one-off memory extraction and consolidation in the local memory backend ([#20783](https://github.com/can1357/oh-my-pi/pull/20783) by [@farnoy](https://github.com/farnoy))
- Starting or resuming a session no longer prints a `Tool commands: added mcp__…` line listing every MCP tool; MCP tools mounted later are still shown ([#20643](https://github.com/can1357/oh-my-pi/pull/20643) by [@Petyok](https://github.com/Petyok)).

### Removed

- Removed the experimental `tools.speculativeExecution.enabled` and `tools.speculativeExecution.maxInFlight` settings (off by default); speculative `read` and eval shadow-cell execution are gone, while `task.speculativeLaunch` is unchanged
- omp no longer reads Gemini CLI's `~/.gemini` and `.gemini/` config (MCP servers, `GEMINI.md`, system prompts, extensions, settings); the `gemini` discovery provider id is gone.
- Removed unused `parse*Args`/`print*Help` exports from `@oh-my-pi/pi-coding-agent/cli/{config,grep,plugin,setup,shell,web-search,update}-cli`; the subcommands parse flags through `src/commands/*` ([#20526](https://github.com/can1357/oh-my-pi/pull/20526))
- Fixed an empty toast with only a checkmark appearing in Tern each time dictation finished transcribing.
- Fixed `bash` running its command approval analysis in yolo mode without `bash.patterns` rules, which failed every command when the native addon was out of date.
- Fixed garbled live dictation (stray words like "Yeah. Oh. Hey.") with quiet microphones or background music: recordings are now split at pauses by the Silero voice activity detector instead of a loudness threshold that chopped speech into sub-second pieces. A recording with no detected speech, such as a song, is transcribed in one pass when recording stops.
- Fixed terminal completion, focus, scrolling, and keyboard handling across prompts, ask forms, plugin and agent views, debugger and plan review screens, session management, and external editors.
- Fixed transcript rebuilding so compaction, shaking, display changes, forks, and worktree operations remain responsive while preserving terminal scrollback and background-task status.
- Fixed rendering of images and rich content in the terminal, including image sizing, edge placement, WebP and GIF embeds, annotated pasted images, Markdown styling, and syntax-highlighted paths.
- Fixed crashes and rendering errors for LSP calls with null fields and for resumed or rewound sessions containing cancelled task results.
- Fixed session and service lifecycle issues, including restarting after a deleted working directory, cleaning up descendant processes, reloading advisor rules, and restoring the correct session state after resume.
- Fixed MCP connectivity for HTTP servers that reject discovery with HTTP 415, and restored OpenCode Go quota windows in `/usage`.
- Fixed bash behavior for tab completion, read-only Perl commands, complex approval patterns, and benign command flags; long wildcard rules no longer freeze sessions.
- Fixed model reference handling in `/prewalk`, `/switch`, and related commands when using provider/model/level completion.
- Fixed Gemini planning behavior so long tool-free reasoning is not repeatedly interrupted.
- Fixed ACP and RPC `/mcp` commands to honor project-server precedence, enable/disable overrides, and the session working directory.
- Fixed unsupported `ANTHROPIC_SEARCH_BASE_URL` from appearing in `omp --help`, and improved the error shown when `bun` is unavailable in compiled JavaScript evaluation.
- Selective commits now leave HEAD and staging unchanged if the shared index stays locked. Retry once the lock is released ([#20252](https://github.com/can1357/oh-my-pi/issues/20252)).
- Cache warming no longer sends a refresh after sleep or another timer delay leaves less than ten seconds before cache expiry ([#20366](https://github.com/can1357/oh-my-pi/issues/20366)).

## [19.2.1] - 2026-11-25

### Breaking Changes

- Removed several internal utility exports from the coding-agent package. Import `errorMessage` from `@oh-my-pi/pi-utils/type-guards`, `flattenLine` from `@oh-my-pi/pi-tui/text/sanitize`, and `fuzzyHits` from `@oh-my-pi/pi-coding-agent/utils/fuzzy`; import `stripInlineMarkdown` from `plan-mode/plan-toc`.

### Added

- Background processes started by the bash tool are now detected when the agent stops, allowing them to be registered as services or terminated; background jobs using `&` are cleaned up when the session ends. Configure this behavior with `bash.reapBackground` (RPC mode does not reap processes).
- Added the `o2ctl services` shell commands for adopting an existing process as a named service, listing services, and stopping services.
- Agents can change their own model or a live child agent's model through the `agent://<id>/model` interface, including permitted user-tagged models, and adjust reasoning effort through `agent://<id>/effort` or a model suffix.
- In Tern, pasted-image attachments can be opened in the image annotator; completing annotation replaces the attachment with the edited image.
- Added `archive.transcript(id, { detail, budget, turns })` for rendering compacted, budget-limited views of previous evaluation sessions, with controls for transcript detail and turn ranges.

### Changed

- Session identifiers and session-file paths are now available to all commands run within a session, including evaluation shell commands, `!` commands, `/loop` conditions, and autoresearch runs.
- Isolated subagent and `/wt` ovnfs checkouts now record the session that created or moved into them, and `ovnfs ls` displays that session after the supporting daemon is restarted.
- `/fast` and `/fast ultra` automatically select an eligible account or stored API key, fall back to other accounts at standard speed when limits are reached, and resume using the fast account when it recovers. Refused fast-mode requests no longer disable `/fast` when another eligible credential remains available.
- `history://<id>` now uses the enhanced transcript view with numbered turns, grouped consecutive reads and searches, and `budget`, `detail`, and `turns` query parameters.
- Tern's agent tray now shows running and queued agents before completed agents, with each group ordered by spawn time.

### Fixed

- A queued or steered message keeps its queue pill until it appears in the transcript, instead of vanishing while its request is still being prepared.
- Fixed LSP diagnostics failing to load when imported before the LSP tool.
- Model lookups now reflect catalog changes from an extension provider’s OAuth login, including in mirrored registries.
- Tern browser actions now report the last observed reason a target was not actionable and discard target coordinates received after the deadline.
- Fixed checkout and workspace detection for paths inside directories whose names begin with `..`, so scoped settings, plugin roots, and folder restrictions apply correctly.
- Fixed broadcasts arriving while a subagent is finishing so they no longer replace the subagent's final report.
- On Linux, bash `time -l` and `time -v` now report the measured program's peak memory usage rather than the agent process's usage.
- Fixed zsh scripts rendered in the pseudo shell so shell syntax is displayed correctly instead of replacement characters.
- Fixed ACP session loading and resuming for saved Copilot 1M models during background model-catalog refreshes.
- Fixed Tern browser actions that ran out of time mid-wait reporting a transport timeout instead of why the element was not actionable (disabled, covered, moving).
- Fixed extension OAuth catalog modifiers (`oauth.modifyModels`) not rerunning on a model-catalog refresh when `models.yml` is unchanged or missing, so a login no longer leaves other providers' models unmodified until restart.
- Fixed `tui.colorfulMarkdown: false` and `tui.renderMermaid: false` so they apply consistently to assistant replies, thinking, user prompts, extension messages, summaries, and tool output.
- Fixed rules supplied by extensions in configuration overlays from disappearing when the system prompt is rebuilt.
- Fixed idle follow-ups becoming stuck after extension messages or compaction summaries.
- Fixed resuming goals whose token budget is exhausted so they remain budget-limited, and prevented incomplete-goal reminders from asking the agent to continue while budget-limited.
- Assistant replies show SVG fences and HTML image and page embeds inline again on terminals that support graphics ([#20508](https://github.com/can1357/oh-my-pi/issues/20508)).

## [19.2.0] - 2026-11-25

### Breaking Changes

- Migrated extension, hook, and custom-tool UI rendering to the host's `@oh-my-pi/pi-tui` implementation. Renderers now return pi-tui nodes or row objects, UI factories receive a lightweight UI host, and renderers receive the host theme and text-style helpers. Extensions that import bundled or alternate pi-tui packages no longer load; see [Migrating from pi-tui](../../docs/extensions.md#migrating-from-pi-tui).
- Removed `ctx.ui.setEditorComponent` and `getEditorComponent`; use the `ctx.ui.composer` hooks instead. `registerComposerShape` now accepts a `ComposerShape`, and tools must return nodes from `renderCall` and `renderResult` instead of implementing `describeCall` and `describeResult`.
- Updated `ctx.ui.custom` options: pi-tui overlay options are no longer supported, `fullscreen` is a standalone option, and `onHandle` receives a `{ closed, close() }` handle.
- The package root no longer re-exports pi-tui components and helpers; use the supported theme service and `ansiSpans` exports instead.
- `--no-tools` now restricts the model and subagents to the built-in tools named by `--tools`. MCP, extension, custom, memory, and auto-learn tools are unavailable; memory is not read or saved; extensions and LSP do not load; goal and plan modes are unavailable; and `-e`/`--hook`/`--trusted-extension` cannot be combined with this option.

### Added

- Added prewalk escalation controls: `prewalk.auto: escalate` can front-load a task on a stronger model and return to the starting model for the next task, while `prewalk.autoTarget: "@initial"` returns to the model and thinking level that began the task. Planner suggestions now report when escalation would occur.
- Added OpenRouter-backed model discovery with `discovery.type: openrouter`, including OpenRouter catalog discovery and request formatting for providers that expose their own endpoint and credentials.
- Added archive evaluation APIs for listing calls and results, searching transcripts and reasoning, computing usage statistics, and reading complete records; archive listings can be narrowed with `since` and `until` and can include subagent transcripts.
- Expanded Vim editing support across prompts and forms, including Normal-mode history navigation and search, clipboard paste/yank controls, slash-command entry, configurable start mode, command display, and Vim editing in dialog fields. Added `tui.vimYankToClipboard`, `tui.vimStartMode`, and `tui.vimShowCommand`.
- Expanded the shell built-ins with BSD-compatible `tail`, `stat`, and `time` behavior; additional `ast-grep`, `fd`, and macOS command compatibility; and support for more platform-compatible process, file, date, and text operations.
- Added clearer subagent waiting indicators and retry-fallback metadata, including the model-change reason and whether a turn stopped because of an unmet requirement.
- The bash tool now detects and removes a stray heredoc continuation character when it can safely parse the command, with a notice.

### Changed

- `omp usage` times Anthropic re-login warnings by the expiry Anthropic reports at login, including 1-year logins, and falls back to the ~30-day estimate for older logins.
- Rebuilt the interactive UI on `@oh-my-pi/pi-tui` while preserving the existing appearance and layout, and restored configured key mappings throughout dialogs, pickers, forms, and settings.
- Eval-defined tools are now disabled by default; enable them with `eval.tools.enabled`. Cross-instance agent messaging is now enabled by default and can be disabled with `task.crossInstance`.
- Vim mode now starts each new prompt according to `tui.vimStartMode` (Insert by default), and plain `y` no longer copies to the system clipboard unless `tui.vimYankToClipboard` is enabled; use `"+y` or `"*y` for explicit clipboard yanks.
- `providers.maxInFlightRequests` is coordinated across omp processes through the daemon, so queued requests start promptly and capacity is returned immediately when a process exits.
- Config files are reloaded by polling every 500 ms, improving support for network drives and systems with exhausted file-watch limits. Repository status is refreshed at run boundaries and relevant commands instead of continuously polling.
- Subagents created with one step now receive that step without additional framing. Shell previews preserve actual `&&`/`||` operators and display directory changes as written.
- The agent performs narrower, final verification for requested work rather than repeatedly checking between edits, and reports the check and result in its response.
- Interrupting with queued input backgrounds a running bash command or eval cell instead of cancelling it; `interruptMode: wait` follows the same behavior. Quitting preserves visible output in terminal history, and pasting followed immediately by Enter submits the pasted text.
- The model picker uses the full terminal width, and the UI provides clearer live tool-call status, model/effort controls, and cross-instance session titles.
- `/wt` now identifies ovnfs checkouts explicitly, and `--offline` keeps routing, image descriptions, and related auxiliary operations on the active provider.
- Selective commits preserve the drafted contents and Git filtering for large, binary, and non-text files, while avoiding overwrites when the file changed concurrently.
- The daemon and package now use less idle memory by loading catalogs, browser relay support, and prompt perturbation data only when needed.
- The prompt bubble’s Edit & resend button now stops the current response, discards queued input, and rewinds the transcript to before the selected prompt.
- The eval `commit` draft exposes its record as the synchronous `details()` method instead of a `details` field.
- Rewinding (Esc Esc, `/branch`/`/rewind`, a turn's Edit and Retry) branches into a new session again instead of moving within the current one; the session you left stays unchanged and the toast's Undo resumes it.
- Model hub search prepares its index between input turns and shares fuzzy matches with the provider sidebar.
- ovnfs checkout guidance now has agents commit in the checkout and `land` the commits (`--rebase` when the branch moved, `--markers` on conflicts), keeping `apply` for when you want uncommitted edits.
- Streaming text and tool progress no longer repaint unchanged status-bar content.
- Reduced repeated model lookups during catalog discovery and model-role selection.
- Startup can resolve `--model @role` and `--model pi/role` without composing the full catalog when the role names an available provider/model.
- The terminal welcome animation now waits until the composer is ready for input.
- The working terminal title now updates four times per second by default; an explicit spinner interval still controls both the title and the TUI.
- Waiting on unchanged background jobs no longer polls for progress; the wait card's visible elapsed clocks continue to run.
- `/model` opens faster after the session's model picker has warmed up.
- Reduced CLI bootstrap work by loading session construction, the Cursor execution bridge, peer mesh, and persisted-agent support when needed.
- Opening a full model catalog on subsequent launches reuses unchanged catalog data instead of rebuilding it.
- The ask dialog submits with questions left unanswered instead of reopening them; an unchecked multi-select could previously trap Enter between questions, and collab guests now get Next on a multi-select before checking anything.
- `ask` forms no longer block Submit on `required`, `pattern`, `min`/`max` and similar rules: broken answers are flagged as you type and still sent, so you can reply to the question instead of satisfying it.
- `--continue` (and auto-resume) now resumes the newest session that no other running omp process has open, instead of starting a new session when the most recent one is open elsewhere.

### Fixed

- Fixed image handling across model switches: vision models receive images, text-only models receive reusable descriptions, and compaction, branching, resumes, and advisor reviews preserve the appropriate representation.
- Fixed numerous Tern and terminal UI regressions, including missing attachment thumbnails and icons, media viewers, prompt-cache details, ask/approval controls, autocomplete placement, key hints, symbol presets, tight layout, subagent navigation, draft selection, clipboard input, and copy/expand behavior.
- Fixed submission and interaction failures so failed submissions restore the draft instead of exiting, queued input and attachments are not lost or misapplied, pending approvals can be edited safely, and keyboard and pointer actions work across forms and views.
- Fixed plan-mode cleanup, interruption notes, model/thinking restoration, automatic compaction fallbacks, and resume behavior so stale planning or reasoning instructions are not sent after the mode ends and oversized handoffs do not repeat indefinitely.
- Fixed model selection and routing across enabled-model scopes, presets, provider order, ACP sessions, session restore, upstream pins, and auto-thinking transitions. Model catalogs now retain extended context metadata and refresh appropriately in long-running sessions.
- Improved provider and authentication resilience: restricted subagents and `omp usage` identify OAuth accounts limited by usage or organization policy; MCP OAuth can request missing scopes and retry after approval; strict and newer MCP handshake variants connect successfully; and OpenRouter credit-limit responses retry after the provider's requested delay.
- Fixed `/usage` synchronization in npm installs and when the statistics database is temporarily locked, while retaining available history. Fixed `/fast` to report when the selected model does not support service tiers.
- Fixed extension, plugin, and SDK compatibility issues, including host-package resolution, Claude plugin variables and tool mappings, project-scoped discovery, `--no-extensions` isolation, and importing the published SDK from npm.
- Fixed language-server startup, timeout, duplicate-process, diagnostics, TypeScript resolution, and file-watch behavior, including safer handling of inotify limits and linked worktrees or submodules.
- Fixed shell compatibility and state isolation across macOS and other platforms, including `set -e`, working-directory changes, process IDs, ACLs, timestamps, `uptime`, `top`, `ps`, `find`, `sed`, `grep`, and removal of iCloud placeholder folders.
- Fixed tool and file-operation issues involving heredocs, `ask` prefilled HTML-like text, AST searches and edits across symlinks and multiple targets, Magic Edit retries and syntax checks, selective commits, binary content, and format-on-write.
- Fixed MCP and browser behavior, including streamable HTTP handshakes, 403 scope authorization, browser downloads on Windows, media reads, SDK session settings, and browser API validation.
- Fixed prompt, transcript, and context correctness issues, including context-token accounting, signed-thinking prompt caches, OpenAI Responses tool results, TTSR interruptions, collab titles, archive/session history, background-job outcomes, and advisor truncation.
- Fixed safety and control-flow issues: refused or pending tool calls are not replayed on retries, selective commits do not modify HEAD or staging when the index is locked, models no longer commit without being asked, and failed commands provide accurate state and error information.
- Improved diagnostics for provider failures, model discovery, truncated search results, language-server timeouts, and shell resets so errors identify the relevant command, provider, executable, request, or next action.
- Sloppy edits now recover common file-header typos and unambiguous update-only patch hunks instead of asking the model to resend an edit that already names its target.
- A broadcast from the main agent now interrupts its waiting subagents: it reaches them as a parent steer (or interrupt) instead of sitting queued until their current `wait` window elapses. Broadcasts between peers still queue without interrupting.
- Fixed the shared mnemopi embedding server and local tiny-model workers staying loaded for as long as any session that used them stays open; they now unload 15 minutes after their last request ([#20452](https://github.com/can1357/oh-my-pi/issues/20452))
- LSP `idleTimeoutMs` now shuts down idle language servers even while other processes keep changing files in the workspace; forwarded watched-file changes no longer count as activity ([#20451](https://github.com/can1357/oh-my-pi/issues/20451)).
- Opening `/model` reuses fresh provider catalogs instead of fetching them again. F5 still forces a provider refresh.
- Restored the composer's `->` / `=>` queue shorthand display: typing the prefix opens a dim `Queueing ➤` header line again, sequential list markers (`1.`, `2.`, …) are highlighted, and Tern keeps the dimmed prefix inline.

### Removed

- Removed `fileToUri`, `uriToFile`, and `EquivalentUriMap` from `@oh-my-pi/pi-coding-agent/lsp/utils`; import them from `@oh-my-pi/pi-coding-agent/lsp/uri` instead.
- Hindsight forks now retain only turns added by the fork, rather than the inherited parent transcript.

## [19.1.1] - 2026-11-23

### Breaking Changes

- The native shell Rust API now stores indexed variables as `IndexedArray` instead of `Vec`; construct `VarValue::Indexed` values with `items.into()`.

### Added

- Added the opt-in `tree` status segment, which shows a session’s position in the session tree after a rewind or on a branch; in Tern, the segment opens `/tree` when clicked.
- Providers routed through an auth gateway (`transport: pi-native`) now list the gateway's models, so models the gateway discovered at runtime (such as new Codex models) can be selected without declaring them in `models.yml`, and models the gateway cannot route are hidden.
- Added `computer.takeover` as the replacement for `computer.backgroundFallback`, with `fallback`, `foreground`, and `always` modes for controlling when the computer tool takes over the foreground window. Existing fallback behavior is preserved by default.
- Added a portable `column` shell builtin with util-linux-compatible options, including table formatting, named columns, alignment, hiding, ordering, JSON output, tree display, and width controls.
- Added extension todo backends through `pi.registerTodoBackend()` and the `todo.backend` setting. Registered backends can mirror the session’s complete todo list to an external store and can be selected and configured from `/settings` → Tools → Todos.
- `/wt` now runs the new worktree’s `post-checkout` hook, displays progress in the TUI, and loads skills and commands created by the hook. Failed hooks leave the worktree intact and display a warning.

### Changed

- Empty-stop recovery now records each retry with the selected model, provider, and stop metadata, making repeated empty model responses visible in the session log.
- The quick model picker refreshes stale provider catalogs in the background, so long-running sessions can discover newly available models.
- On Linux, language-server file watching now adapts to the inotify watch limit so large workspaces are less likely to interfere with other file watchers and system services.
- The `eval` tool now documents its default 30-second cell deadline in its prompt and timeout parameter.

### Fixed

- Improved Magic Edit so it can search and read the current draft, retry failed replacements without losing successful edits, validate syntax before writing, and support models that emit tool calls as text.
- Fixed shell tool command handling when `bash` is replaced by an extension, including support for tool-only command lines with remote or sandboxed shells.
- Fixed browser scrolling validation and documentation so invalid object forms explain the correct pixel-delta signature and equivalent call.
- Fixed `ask` handling of fieldsets whose radio buttons use different names, preventing a preselected option from being submitted alongside the user’s choice.
- Fixed title generation to stop when a model explicitly declines with `<title/>` or `none`, while continuing to the next candidate for errors or unusable replies.
- Fixed automatic and speculative compaction so oversized or non-retriable handoff requests move on to the next available compaction method instead of being repeatedly sent to a provider.
- `wait()` in eval cells now accepts displayed subagent IDs, including the `agent://id` form, while still rejecting handles belonging to other sessions.
- Fixed startup and session model configuration so thinking levels, model-provider ordering, enabled-model allowlists, routed selections, and pinned upstream routes remain consistent across model switches, cycling, restore, plan mode, and metadata refreshes.
- Fixed queued follow-up messages being lost when interrupted responses are discarded, and fixed TTSR interruptions that could leave a session unable to continue.
- Fixed OpenAI Responses sessions rewriting previously sent tool results, which could cause later reasoning items to be rejected.
- Fixed format-on-write and symlink-related file editing issues, including incorrect write failures, missing snapshots, duplicated `local://` paths, and incorrect symlinked filenames in previews and journals.
- Fixed Windows browser downloads occasionally retaining temporary GUID filenames when the downloaded file was briefly locked.
- Fixed RPC shutdown leaving MCP subprocesses running after the session ended.
- Fixed advisor and Spotlight output so truncated or repeated tool results are represented accurately without losing the original content.
- Fixed first-run startup warnings that persisted after a default model had been selected.
- Fixed context rollover handling so concurrent bookkeeping no longer silently drops an explicit rollover, and skipped rollovers produce a warning.
- `/omfg` now closes its panel after successfully saving a rule and shows the saved path; errors keep the panel open.
- Fixed shell handling of leading `cd` commands that use glob, brace, or named-user home expansion.
- Claude-format plugin agents now correctly map Claude tool names such as `WebFetch`, `WebSearch`, `TodoWrite`, `AskUserQuestion`, `MultiEdit`, and `Agent` to their OMP equivalents.
- Startup extension notifications now remain visible instead of being overwritten by later notices or MCP startup status.
- Fixed CLI parsing so `--plan` no longer consumes a following CLI flag as its value during startup, restart, fork, or subcommand routing.
- Fixed `/usage` when the usage database is temporarily locked; stored history remains visible and is marked unsynced if it cannot be refreshed.
- Model discovery now classifies speech-only and transcription-only models as TTS and STT models rather than chat models.
- Subagents stopped by their parent now record that they were stopped by the parent agent.
- Fixed SDK and extension imports, examples, and session-specific extension discovery for RPC and ACP sessions.
- Fixed X and YouTube URL reads to honor SDK session settings even when global settings have not been initialized.
- Restored sessions now correctly report background jobs whose outcome is unknown, and `omp --restore` no longer replays completed turns after idle compaction or interruption.
- Selective commits now preserve the drafted contents and Git clean-filter results for binary, non-text, oversized, and Git LFS files, and avoid overwriting files changed since the draft was created.
- Fixed `read` hanging on images and other non-text files when speculative execution and `beforeToolCall` hooks are enabled.
- Provider error logs now include the request ID needed for troubleshooting Anthropic refusals.
- Sessions started from collaboration prompts now receive automatic titles.
- Fixed `/tan` forks ending an idle wait prematurely when their assignment remains blocked.

## [19.1.0] - 2026-11-21

### Breaking Changes

- Replaced `xd://` tool devices with tool commands: rarely-used tools now run as bash commands (`<tool> --help`, `<tool> <args>`) while `bash` is active and are ordinary tools otherwise
- Renamed the `tools.xdev`, `tools.xdevDocs`, `tools.xdevInlineDevices` and `tools.xdevNotices` settings to `tools.commands`, `tools.commandDocs`, `tools.commandInline` and `tools.commandNotices`
- Staged previews, plan submission and Auto-QA reports now use the `resolve`, `reject`, `propose` and `report_issue` commands, and tool doc topics moved from `xd://<tool>/<topic>` to `help://<tool>/<topic>`
- Removed the `tui.completeScrollback` setting; transcript rows covered by the HUD, dialogs, or draft now always move to scrollback, and the input returns to the bottom row when overlays close.
- Replaced the standalone MCP transport and tool-cache SDK exports and removed `DeferredMCPTool` plus MCP cache and reconnect-policy manager options. MCP servers are now accessed through the MCP host APIs.
- Browser relay hosting now runs through the omp extension's native host while Chrome is open. Removed the on-demand `omp browser-relay` server command and its `--port`, `--token`, and `--no-group` options; `browser.relayUrl` remains available for relays forwarded from another machine. Reload the omp extension once after upgrading, or restart Chrome.
- Changed `archive.search(query)` to search session titles, idle recaps, and user/assistant content across all history and return matching session records; use `archive.prompts({ query })` for prompt-only searches. Searches match query terms at the beginning of words.
- RPC hosts must handle the `ask` tool as one complete HTML-form `form` request and respond with submitted data or cancellation; field-by-field prompts are no longer emitted.

### Added

- Extensions can take over a built-in provider through `registerProvider`: `stream` replaces its request adapter, `generateImage` its image generation, and `webSearch` its grounded search request, and `discoverModels` its model discovery request. `rules` sets KDL rule directives (such as `prompt-perturbation`) for its models.
- Added the `magic` edit mode, which accepts Markdown bulleted change descriptions grouped under `# path` headings and uses a configurable fast model or role to generate and apply patches. It supports concise block replacement, deletion, movement, and identifier-renaming descriptions, and presents the resulting diffs.
- Added remote session model controls through RPC, including the model picker, thinking-level and role selection, `auto` thinking, and commands to resume, abort while delivering queued messages, or continue the host agent. Collab guests can now continue, interrupt, and queue follow-up prompts for the host.
- Added support for Unicode set mode (`v`) in slash-delimited `secrets.yml` regular expressions.
- Moved MCP servers into the omp daemon, with optional process sharing across sessions, lazy startup, idle shutdown, shared discovery caching, and `/mcp list` status including process and session information. Configure sharing with `mcp.shared` and idle shutdown with `mcp.idleStopMinutes`.
- Added MCP protocol revision 2026-07-28 support, including server discovery, per-request metadata, root input rounds, subscriptions, and cache controls, while retaining compatibility with servers that require the initialize handshake.
- Added native browser-relay integration for the Chrome extension, including side-panel sessions, extension installation and synchronization, automatic profile registration, and in-tab action overlays. Side-panel sessions remain separate from terminal resume, recent-session, `--continue`, and ACP session lists unless explicitly resumed.
- Added a coloured extension-status variant to `omp gallery --segment status`.
- Added notifications and waiting status when a program running in a bash `pty` is waiting for keyboard input, such as a password or confirmation prompt; disable notifications with `pty.notify`.
- Eval `completion()` now records raw provider frames for `/debug` inspection and saves frames from failed calls as log files in the session artifacts directory.
- Added `parentToolCallId` to extension `tool_call` and `tool_result` events so nested tool calls can be associated with the eval cell or kernel-defined tool that dispatched them.
- Added full-text transcript search indexing for `archive.search`, covering user and assistant messages across session history.
- Session files now record approval requests and their outcomes, allowing dashboards and sidebars to show when a session is waiting for tool approval.
- Added live visibility into output redirected to files by background bash jobs, including job streams, the jobs sheet, job widgets, and command cards; selecting a command shows the output for its relevant pipeline or redirected stream.
- Added Binary Ninja as a disassembler backend for read analysis views and the `dsm` namespace. Select it with `disassembler.backend = binja` and configure its installation with `binja.installDir` or `$BN_INSTALL_DIR`.
- Clicking the usage-limit segment in native terminal hosts such as Tern now opens `/usage`. Changing Tern's Agents tray setting immediately switches between tray cards and the running-agent and job counters without restarting omp.

### Changed

- Images a command prints as kitty or sixel graphics are saved to a temp file and linked in the bash output, in addition to being attached
- `generate_image` returns its images as attachments
- Spotlight tool calls use `Label: detail`; activity shows only the label, while output ranking uses the full intent.
- Improved regex performance for TTSR and secret-redaction scans, including SIMD acceleration and faster candidate matching, without changing matching semantics.
- Improved performance when listing sessions across all projects, especially with thousands of project directories.
- Interactive `wait` now waits up to four minutes on its first call for background jobs instead of returning after five seconds.
- Updated the MCP OAuth client name to `Codex`.
- Made automatic retries less disruptive: failed attempts stay out of the transcript, retry status explains the reason, and successful recovery leaves only a brief indication.
- Selective commits now attribute edit-tool and shell-built-in changes more accurately, distinguish external program changes for review, and use a substantially smaller change journal. Long-line commit previews now highlight only the changed words while preserving the original patch.
- TTSR rules that cannot interrupt streaming are evaluated at the end of the relevant response, reasoning, or tool call, reducing unnecessary work while preserving matches and reminders.
- Eval `completion()` now accepts user-tagged model agents, such as models pinned with `^model`, and uses their tagged effort level.
- `read` recognizes SQLite-backed `.i64` and `.idb` files as IDA databases and reports disassembler-backend mismatches clearly.

### Fixed

- A tool card left unfinished by a stream that never completed no longer keeps the rest of the transcript out of scrollback and squeezed to one-line rows; it is closed when the next reply starts
- Spotlight keeps short relevant passages from multiple large function bodies together with their signatures, even when a code outline is cut again.
- A usage-limit reset inside `retry.maxDelayMs` is now waited out even without a `Retry-After` header.
- Logging in while an auth broker is configured no longer reports success for a provider the broker stores but does not serve (such as one an older broker pauses); the login is kept in this machine's `agent.db` instead, survives restarts, and login/logout now name where credentials were saved.
- Spotlight keeps more high-relevance lines with their neighbours in long results and large code outlines, while preserving visible intent matches within the window budget.
- Fixed Tern tray cards and subagent live previews showing stale calls, models, or thinking states while an agent was running or after a model switch; completed cards now retain the model and thinking level used.
- Fixed extension side-panel sessions launching omp's own browser instead of driving only the user's Chrome window.
- Preserved answer footers and Copy controls in Tern after resuming, compacting, or rebuilding a transcript.
- Prevented `--continue` and `autoResume` from attaching to a session currently being written by another omp process.
- Added visible progress reporting while `/handoff` writes its summary.
- Fixed access to cloud-only files on macOS iCloud Drive, Desktop & Documents, Google Drive, and Dropbox locations.
- Prevented pathological TTSR condition and secret-redaction regular expressions from freezing sessions or requests.
- Fixed prompt-cache handling for IRC-woken subagents and sessions whose context hooks provide an initial message.
- Improved shell `rg` and `fd` path output and option handling to match their native tools, including paths beginning with `-`, null-separated output, and explicit current-directory prefixes.
- Fixed sloppy-edit validation and block matching for incomplete actions, numeric `||` expressions, nested or partial block endings, JSDoc comments, and hashline headers with trailing whitespace.
- Fixed OpenCode v2 MCP configuration discovery from `mcp.servers` while preserving support for legacy flat `mcp` entries.
- Fixed `ovnfs` commands when `ovnfs.path` contains Windows backslashes, spaces, or `$` characters.
- Stopped failed browser launches from logging URL credentials, query strings, OAuth device codes, or fragments.
- Fixed `web_search` to honor the search order and exclusions configured for the current session.
- Fixed MCP OAuth refresh for Microsoft Entra servers where the client is also the resource; previously saved credentials may require one `/mcp reauth`.
- Fixed model resolution for OpenRouter route variants used by per-call subagents and roles.
- Fixed secret redaction in shared sessions so provider-encrypted reasoning is not retained unexpectedly.
- Fixed bash approval handling for compound commands with environment assignments and flags, including wildcard allow rules.
- Fixed selective commits when HEAD changes during a commit hook and when edits from multiple writers are reordered or overlap; ambiguous changes are now sent to review instead of being duplicated or silently misapplied.
- Fixed archive records to include all documented keys with `null` for missing values.
- Fixed unnecessary empty session log files for inline bash/eval output and request-timeout recovery.
- Improved `read` suggestions for line, range, and column selectors and preserved source line metadata for in-memory and converted text reads.
- Fixed agent lifecycle races involving duplicate IDs, pending messages, shutdown, and revival.
- Fixed browser tab handling on CDP engines that use separate connections per page, including recovery after timeouts or worker exits.
- Fixed browser interaction reporting for overlay-only clicks, hidden frames containing inline SVG or MathML, and search fields that update on key events.
- Fixed browser computer-use inspection of minimized macOS windows and fully covered Windows Chrome, Edge, and Electron windows.
- Fixed `/goal` on Anthropic from unnecessarily rewriting the cached system prompt and transcript.
- Fixed isolated task subagents in bare Git repositories by refusing early and identifying available work trees instead of starting without a usable work tree.
- Fixed Nix browser-relay builds to fetch all dependencies without falling back to the npm registry.
- Fixed extension, plugin, custom-tool, hook, command, and share-script loading for paths containing `?`, with a useful error identifying the path and remedy.

## [19.0.1] - 2026-11-19

### Added

- `/session` shows the path of the session's `local://` directory, and `/copy local` copies it, creating the directory first so it can be entered before anything was written there ([#19778](https://github.com/can1357/oh-my-pi/pull/19778) by [@farnoy](https://github.com/farnoy))
- `snapcompactShape` on `models.yml` models, `modelOverrides` and extension `registerProvider` models sets that model's snapcompact frame shape ([#19591](https://github.com/can1357/oh-my-pi/pull/19591) by [@ryanskidmore](https://github.com/ryanskidmore))

### Fixed

- Fixed PTY command transcripts sometimes gaining a blank line where a `\r\n` line ending was split across two terminal reads.
- Fixed the shell's `dirname` builtin on Windows ignoring `\` separators and drive prefixes (`dirname 'C:\a\b'` printed `.`), which broke scripts like VS Code's `code` launcher (`./Code.exe: No such file or directory`)
- Fixed bash output minimizing being skipped on Windows when a command is named by a `\` path or with `.exe` (`"C:\Program Files\Git\cmd\git.exe" status`, `git.exe log`)
- Fixed the bundled `omp://tools` docs still describing the removed `ida` tool; `tools/dsm.md` now documents eval's `dsm` namespace and `disassembler.*` settings, and `tools/read.md` documents metadata-only executable reads ([#19608](https://github.com/can1357/oh-my-pi/issues/19608))
- Fixed native terminal hosts such as Tern placing extension aboveEditor widgets and a blank row between the status row and the tray; the widgets now sit above the status row ([#19767](https://github.com/can1357/oh-my-pi/issues/19767))
- Fixed `^model` mentions in queued messages (`->`/`=>` while the agent is busy, later items of a numbered list, RPC `steer`/`follow_up`, ACP steering) reaching the model as literal `^provider/model` text instead of registering their `m<N>` agent ([#19683](https://github.com/can1357/oh-my-pi/pull/19683) by [@a-glapinski](https://github.com/a-glapinski))
- Fixed `^model` mentions in extension messages sent with `sendUserMessage({ deliverAs: "steer" | "followUp" | "aside" })` while the agent is busy reaching the model as literal text ([#19799](https://github.com/can1357/oh-my-pi/pull/19799) by [@H4vC](https://github.com/H4vC))
- Fixed every message queued behind an undelivered `^model` mention repeating the "`m<N>` now available" notice to the model ([#19799](https://github.com/can1357/oh-my-pi/pull/19799) by [@H4vC](https://github.com/H4vC))
- A plugin manifest with a non-string `extensions` entry (e.g. an object) no longer crashes extension loading with `ERR_INVALID_ARG_TYPE`; the entry is reported as not found and valid entries still load ([#19674](https://github.com/can1357/oh-my-pi/pull/19674) by [@koeria](https://github.com/koeria))
- Fixed embedded `bash script.sh` resolving `BASH_SOURCE[0]` to `bash` instead of the script path, which broke scripts loading files beside themselves ([#19792](https://github.com/can1357/oh-my-pi/issues/19792))
- Fixed proxy model discovery ignoring a gateway's advertised input modalities and output-token cap ([#19754](https://github.com/can1357/oh-my-pi/pull/19754) by [@zhyc9de](https://github.com/zhyc9de)).
- Fixed a provider routed through an auth gateway (`transport: pi-native` in `models.yml`) still listing models from the provider's own endpoint, sending the gateway key there; such providers now skip the provider's model discovery and keep their bundled and cached models ([#19646](https://github.com/can1357/oh-my-pi/pull/19646) by [@ray8828](https://github.com/ray8828))
- Fixed a spurious "cache miss" marker on the first turn after a compaction: compaction rewrites the prompt prefix, so that miss is expected and no longer flagged ([#19679](https://github.com/can1357/oh-my-pi/pull/19679) by [@Petyok](https://github.com/Petyok))
- Fixed `omp --resume <id>` under `--mode rpc`, `--mode rpc-ui` and `--mode acp` failing at start when the session's directory no longer exists; the session now opens where it is stored, with the launch directory as its working directory, without asking whether to move it ([#19651](https://github.com/can1357/oh-my-pi/pull/19651) by [@sjawhar](https://github.com/sjawhar))
- Fixed the browser relay extension dying silently in a browser whose loaded permission set predates the `downloads` permission: it now keeps working without download pairing, and the relay reports a download tracking gap instead of a generic not-found ([#19659](https://github.com/can1357/oh-my-pi/pull/19659) by [@pavel-kalmykov](https://github.com/pavel-kalmykov))
- Sharing a session whose subagents report progress faster than the uplink drains no longer ends with "collab send backlog exceeded its limit" while a guest joins
- Fixed `/loop` iterations and `/goal` continuations firing ~800ms after a turn yields to wait on background subagents or jobs; they now wait until the run finishes ([#19781](https://github.com/can1357/oh-my-pi/issues/19781))
- Fixed Codex and OpenAI API web search ignoring the `web` role's thinking level (`openai-codex/gpt-6-luna:xhigh`); the level now reaches the request as `reasoning.effort` ([#19793](https://github.com/can1357/oh-my-pi/issues/19793))
- Fixed plan review measuring "Approve and keep context" against the pre-plan model instead of the tier chosen in the "continue with" slider, so switching to a larger-context tier now enables it ([#19660](https://github.com/can1357/oh-my-pi/issues/19660))

## [19.0.0] - 2026-11-18

### Breaking Changes

- Changed SDK cache warming controls: createAgentSession.cacheWarming now accepts the mode cap "off", "streaming", or "idle"; the lower of this value and providers.cacheWarming applies. Use "off" instead of false.
- Replaced artifact://N links with readable, listable, and completable local://N.log files at the session's local:// root. artifact:// links in existing sessions are not migrated.
- Replaced session.handoff(focus) with session.compact(focus, { mode: "handoff" }); use abortCompaction() to cancel it.
- Consolidated shared background processes under one per-user daemon rather than project-specific brokers. Daemons and services from older versions are not adopted; omp ps now reports global, project, and session units together, removes --global, changes --json output to {daemon, reports}, and no longer adds ?project= to dsm:// handles.
- Renamed SDK deferSkillDescriptionCompression to deferHintCompression and startSkillDescriptionCompression() to startHintCompression(); these settings and methods now also cover MCP namespace hints.

### Added

- Added built-in MCP transforms, including the Codex Desktop node_repl replacement. Built-ins can be disabled with mcp.builtinTransforms; /mcp list identifies replaced servers and /mcp enable node_repl can explicitly connect one.
- Added optional MCP eval namespaces through mcp.evalNamespaces, exposing servers as JavaScript and Python namespaces with documentation at xd://eval/<server>. Results preserve text and structured data, and binary resources are saved as local:// files.
- Added model-generated names for /tan agents and their tray cards, with a readable random fallback when naming fails or times out.
- Added configurable cache-warming strategies (auto, keepalive, and compact), including long-tool-call keepalive and pre-expiry prompt compaction. Cache-warming events now report the selected method and costs.
- Added optional cross-instance task discovery and messaging with task.crossInstance, exposing same-folder instances through agent://peers.
- Added btw mode: drafts beginning with ? submit as /btw questions and receive distinct UI indication.
- Added Tern live cards for running subagents and background jobs, including progress, tool counts, status, controls, transcripts, and restored access to finished agents.
- Added daemon update survival and optional TCP hosting through OMP_DAEMON_TCP, preserving running services, PTYs, and language servers across daemon upgrades.
- Loaded speech-to-text and text-to-speech models once per machine, unloading them after 15 minutes of inactivity.
- Added ovnfs worktree support to /wt, the project resume picker, and omp worktree list/clear, while preserving session resume from the source repository after checkout removal.
- Added Claude subscription plans to omp usage and /usage output.
- Added progress reporting for background skill-description and MCP namespace hint generation.
- Added excludeFromContext to pi.sendMessage payloads so extensions can display and save per-turn messages without sending them to the model.
- Added a 30-second retry window for CLI and print-mode commands while the authentication broker restarts or is briefly unavailable.
- Added a notify option to the bash tool for reporting matching output from background commands and named services, waking idle sessions or ending blocked waits.

### Changed

- Improved cache warming for Anthropic-compatible providers with no-output prewarming where supported and billing based on actual replay costs; task subagents now keep prompt caches warm during long tool calls when streaming warming is enabled.
- Generated skill descriptions and MCP namespace hints once per machine, sharing results and progress across omp windows.
- Preserved thinking levels when switching models, adjusting only when the selected model cannot support the current level; model defaults apply only when no level is set.
- Extended repeated reply and subagent waits to use the session's prompt-cache lifetime, and made subagent waits follow the live parent's next message when appropriate.
- Made /handoff run as background compaction while preserving the current response and newly arriving messages.
- Redesigned ask prompts as a single scrolling form above the composer, preserving partial answers and allowing users to skip pending questions by sending a message.
- Enabled composer predictions by default, showing the active model's suggested next message after completed turns; disable them in Settings → Interaction.
- Disabled tool-call intent tracing by default in print, RPC, ACP, and SDK sessions; enable it with tools.intentTracing or PI_INTENT_TRACING.
- Updated ovnfs checkout guidance and git guard messages to explain how to land, pull, or discard changes.
- Improved subagent completion probes and side requests so they focus on deliverables and do not include still-streaming reasoning as plain history.
- Standardized wait behavior to a 5-second initial idle wait followed by four-minute back-to-back waits.
- Always provide subagents with the shared LSP tool; task.enableLsp now controls only LSP formatting and diagnostics for edits.
- Improved bash services, PTYs, and embedded shells with session environment inheritance, session-file URL support, clearer readiness validation, and more transparent minimized output.
- Named managed Chromium clearly when running in a window and improved browser, screenshot, upload, frame, selector, network, and CDP behavior across tabs and browser backends.
- Improved hashline editing with verbatim replacement bodies, safer range and path validation, clearer parse and syntax diagnostics, support for larger files and SSH files, and more predictable raw reads and line selectors.
- Improved MCP reliability with ten-minute tool-call deadlines, longer deadlines when progress is reported, clearer timeout and connection errors, and one retry after expired HTTP sessions.
- Expanded the embedded shell with portable built-ins and internal-URL support for common workflows, including file inspection, archiving, process control, environment loading, file watching, locking, speech, opening files, and patch application.
- Improved LSP and debugging diagnostics, language coverage, workspace detection, references, rename, code actions, and server lifecycle reporting.
- Improved eval tooling with Python 3.9+ validation, UTF-8 execution, package installation refreshes, full tool results, protocol-file access, threaded Python helpers, and clearer kernel-loss and timeout messages.
- Improved commit drafts and summaries to handle hooks, amend operations, worktrees, filters, line endings, large untracked trees, review files, and JavaScript/Python API parity more accurately.
- Improved URL, archive, GitHub, Terraform Registry, package documentation, web search, and remote-file handling, including filtering, pagination, binary conversion, archive member access, and clearer provider errors.
- Improved usage and account policy reporting so subscription limits and scoped exhaustion identify the affected plan or meter accurately.
- Improved worktree, process, wait, agent messaging, session restore, memory retention, Spotlight, Windows shell, and macOS performance behavior.

### Fixed

- Fixed MCP resource links and binary resources so they remain accessible as readable files or inline content rather than being dropped or shown only as placeholders.
- Fixed commit drafts after pre-commit hooks and partial prior commits so the index, diff, selected blocks, amended parent, review files, and generated summaries remain accurate.
- Fixed automatic Hindsight and Mnemopi retention during runs with async work, subagents, or peer messages, preventing duplicate or overlapping retention.
- Fixed blocked agents and waits by reporting waiters and dependency chains, delivering messages to queued agents, and correctly handling killed, evicted, resumed, or empty-output jobs.
- Fixed session resume and process-result handling across unified-daemon upgrades.
- Fixed thinking-level display and model-switcher behavior for subagents, auto-thinking sessions, and manually adjusted levels.
- Fixed worktree cloning, ovnfs/Git transitions, service readiness checks, shell environment inheritance, Windows junction removal, process substitution, checksums, and background command cancellation.
- Fixed browser automation reliability across screenshots, clicks, fills, tabs, frames, dialogs, uploads, CDP endpoints, stale connections, concurrent evaluations, browser startup, viewport emulation, clipboard, and platform-specific input.
- Fixed hashline, AST editing, generated-file detection, numbered content, remote-file editing, syntax diagnostics, path handling, and line-ending behavior.
- Fixed eval kernels, Python and JavaScript helpers, package imports, nested tool calls, internal URLs, and moved working directories.
- Fixed LSP, language-server startup, diagnostics, references, rename, code actions, project loading, file types, and debugger adapter selection.
- Fixed command-output summarization so relevant context, metadata, Git output, test timing, AWS output, lint diagnostics, and binary detection are preserved instead of being misclassified.
- Fixed read, grep, glob, URL, archive, SQLite, video, RSS, GitHub, package-documentation, SSH, and web-search handling across selectors, filters, pagination, archives, binary content, and provider failures.
- Fixed todo operations, ask compatibility and timeout behavior, image generation validation, GitHub PR pushes, plan proposals, and session accounting for side-channel model calls.
- Fixed MCP OAuth reauthentication errors to expose registration endpoints, status details, and remedies, and fixed auth-broker shutdown so refreshed tokens are saved safely.
- Fixed Spotlight retry and account handling, including waitlisted accounts, rate limits, outages, and request identification.
- Fixed cross-platform shell and desktop behavior, including macOS startup and redraw performance, Windows file operations and application lookup, speech output, and desktop opening.

## [18.22.2] - 2026-11-18

### Added

- Computer `el.setValue(75)` now writes the number as `"75"` instead of refusing a non-string; `NaN`, `Infinity`, booleans and objects are still refused, as are a whole number past 2^53 and a number that prints with an exponent, which are passed as text in digits instead ([#19405](https://github.com/can1357/oh-my-pi/pull/19405) by [@will-bogusz](https://github.com/will-bogusz))
- Added a report of native windows to browser results on macOS for visible managed browsers, spawned Chromium browsers and a loopback relay: a `<select>` menu, colour or date picker, or a print, save, sign-in, passkey or permission sheet or bubble a call raised over its tab is named with its `computer.window()` id while the browser's tab list shows that tab in front of its window, by the next call when it shows just after the call returned, and on failed calls too; connected CDP endpoints, remote relays and page-backed popup windows are excluded ([#18925](https://github.com/can1357/oh-my-pi/pull/18925) by [@will-bogusz](https://github.com/will-bogusz))
- Added Kiro as a built-in provider: run `/login kiro`, pick Identity Center, Builder ID, or an API key, and choose a discovered `kiro/<model-id>` model. Each `/login kiro` adds an account ([#18955](https://github.com/can1357/oh-my-pi/pull/18955) by [@Xytronix](https://github.com/Xytronix), based on [#14215](https://github.com/can1357/oh-my-pi/pull/14215) by [@ajdiyassin](https://github.com/ajdiyassin))
- Added Google and GitHub to `/login kiro`: approve a one-time code at `app.kiro.dev`, then sign in with that account ([#18955](https://github.com/can1357/oh-my-pi/pull/18955) by [@Xytronix](https://github.com/Xytronix), based on [#14215](https://github.com/can1357/oh-my-pi/pull/14215) by [@ajdiyassin](https://github.com/ajdiyassin))
- `/usage` and `omp usage` now show Kiro credits: the monthly plan credits with their reset date, active bonus credits with their expiry, and overage credits and charges when overage is enabled ([#18955](https://github.com/can1357/oh-my-pi/pull/18955) by [@Xytronix](https://github.com/Xytronix), based on [#14215](https://github.com/can1357/oh-my-pi/pull/14215) by [@ajdiyassin](https://github.com/ajdiyassin))

### Changed

- Model registries in one process (SDK embedders, tests) now share discovered-model builds, so refreshing another registry skips rebuilding models an earlier one already built

### Fixed

- Fixed the UI freezing briefly when a prompt is submitted: prompt history is now written to disk in the background (within 100 ms, and on exit) instead of on the Enter keystroke
- Fixed the UI freezing while discovered models from large provider catalogs are merged: the merge now runs in slices that yield to the event loop
- Fixed closing omp's headless browser taking about 7 s when Chromium never finishes a graceful shutdown (seen with Chrome for Testing 150 on macOS 27): a browser on an omp-created profile is now killed at once
- Failed computer runs retain text and screenshots already produced in JavaScript and Python Eval, so agents can inspect partial actions without losing the error; direct computer calls also show the failure's name and message alongside partial output ([#19100](https://github.com/can1357/oh-my-pi/pull/19100) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed Exa and Firecrawl web searches silently falling back to their keyless public endpoints when a configured credential failed to resolve (for example a failing `!command`); they now report the credential error
- Fixed eval cells being able to call `yield` (directly or through `xd://yield`) without finishing the delegated task; eval now rejects `yield` and points to the direct tool ([#19470](https://github.com/can1357/oh-my-pi/pull/19470) by [@alphastorm](https://github.com/alphastorm))
- Fixed service `ready.log` and wait patterns not matching `^` and `$` at line boundaries after earlier output ([#19471](https://github.com/can1357/oh-my-pi/pull/19471) by [@alphastorm](https://github.com/alphastorm))
- Fixed the shell's `stat`, `diff` and `find` builtins ignoring `TZ` when printing file times; `find -ls` now prints times in the shell's time zone instead of UTC, and `find -newermt` reads dates like `Nov 15, 2023` in the shell's time zone ([#19482](https://github.com/can1357/oh-my-pi/pull/19482) by [@alphastorm](https://github.com/alphastorm))
- With TTSR rules active, large `write` and `edit` calls no longer slow down as their arguments stream ([#19494](https://github.com/can1357/oh-my-pi/pull/19494) by [@H4vC](https://github.com/H4vC))
- Fixed `/commit` and eval `commit` creating a single-parent commit during a merge; committing now refuses while a merge, cherry-pick, revert, rebase or `git am` is in progress or the index has unresolved conflicts ([#19474](https://github.com/can1357/oh-my-pi/pull/19474) by [@alphastorm](https://github.com/alphastorm))
- Fixed the `apply_patch` tool description calling it a shell command and forbidding absolute paths ([#19325](https://github.com/can1357/oh-my-pi/issues/19325), [#19468](https://github.com/can1357/oh-my-pi/pull/19468) by [@alphastorm](https://github.com/alphastorm))
- Fixed the shell's `rg` builtin ignoring `--glob` patterns that contain a slash ([#19476](https://github.com/can1357/oh-my-pi/pull/19476) by [@alphastorm](https://github.com/alphastorm))
- Fixed eval `commit` `only(...)` failing when one of its paths or globs matched no changed file; unmatched ones are now reported ([#19472](https://github.com/can1357/oh-my-pi/pull/19472) by [@alphastorm](https://github.com/alphastorm))
- Fixed a Tern browser block answering every later browser call with "Tab is busy: another call on this tab is still running" after a call whose page evaluation never returned, such as one cut off by a redirect; such a call now ends at its time limit or when cancelled, and the tab takes the next call
- Fixed the browser tool reporting a JavaScript `confirm` or `prompt` as still open, and failing page calls on it, after the user clicked it away or another CDP client answered it ([#19481](https://github.com/can1357/oh-my-pi/pull/19481) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `computer` `setValue` on a `<select>` in Chrome or an Electron app on macOS failing with an empty list of options; it now chooses the option the value names ([#19224](https://github.com/can1357/oh-my-pi/pull/19224) by [@will-bogusz](https://github.com/will-bogusz))
- A relay tab is no longer closed when another extension's frame, such as a password manager's autofill menu that undoes the relay clearing it, keeps Chrome refusing omp: the call fails saying what holds the tab, the tab stays open as the user left it, and the next call reattaches to it ([#19178](https://github.com/can1357/oh-my-pi/pull/19178) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the computer tool telling the model that only an X11 takeover can end with nothing sent because the user kept typing; a macOS takeover now waits for the user's pause too and reports `UserIntervened` the same way ([#19296](https://github.com/can1357/oh-my-pi/pull/19296) by [@will-bogusz](https://github.com/will-bogusz))
- When the browser relay hides another extension's frame in a tab omp drives (a password manager's inline menu or save card), the call that ran into it, or a later one on that tab, now names the frame's page, the extension's id and the page's own title, and says the frame is hidden for the user too ([#19001](https://github.com/can1357/oh-my-pi/pull/19001) by [@will-bogusz](https://github.com/will-bogusz))
- Anthropic web search now passes `site:`-scoped queries to Claude with the domain and path still in the text, and tells Claude to always search, so those lookups and queries it thought it could answer from memory no longer fail with "returned no sources" ([#18125](https://github.com/can1357/oh-my-pi/pull/18125) by [@will-bogusz](https://github.com/will-bogusz))
- Anthropic web search on models with a refusal fallback (Opus 5 and 5.5, Sonnet 5.5, Fable 5) has Anthropic retry a query the safety classifier declines on another Claude model, and reports a refusal or a failed search (`too_many_requests`, …) by name instead of "returned no sources" ([#18125](https://github.com/can1357/oh-my-pi/pull/18125) by [@will-bogusz](https://github.com/will-bogusz))
- Subagents without an output schema (including eval `agent()` calls without `schema`) no longer get a `yield` tool; their final message is the result.
- A `yield` without `data` no longer uses the subagent's last message as the result; it only finalizes incremental sections that were already submitted.
- A `computer` key press that opens a macOS popup button's or menu button's menu in the background now fails listing the items and naming the press or click that chooses one, instead of leaving the menu open with your keyboard ([#19179](https://github.com/can1357/oh-my-pi/pull/19179) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed Claude not seeing the reasoning of earlier Codex, Kimi, Grok and other non-Claude turns after a model switch, including turns kept through a compaction; it now gets that reasoning as text. When Claude refuses a turn with `Refusal (reasoning_extraction)` because of that carried reasoning, the turn is retried once without it, and the session stops sending it to Claude ([#7241](https://github.com/can1357/oh-my-pi/issues/7241)) ([#17610](https://github.com/can1357/oh-my-pi/pull/17610) by [@will-bogusz](https://github.com/will-bogusz))
- After an Anthropic refusal, later turns no longer resend the refusal text with the tool calls it stopped: those calls now replay as "not executed" only, so one `reasoning_extraction` refusal stops making every following turn of the session likely to be refused too ([#19419](https://github.com/can1357/oh-my-pi/pull/19419) by [@flosrn](https://github.com/flosrn))
- Fixed selective commits skipping updated submodule pointers; existing initialized gitlinks can now be reviewed and explicitly selected without committing changes inside the submodule ([#19556](https://github.com/can1357/oh-my-pi/pull/19556) by [@kim-dali](https://github.com/kim-dali))
- Fixed git reads such as `/commit`'s status scan hanging when a background git process kept the output pipe open ([#19478](https://github.com/can1357/oh-my-pi/pull/19478) by [@alphastorm](https://github.com/alphastorm))
- Fixed the browser falling back to Chromium on the first launch of a new WebKit engine build on macOS: the WebKit host now gets 60 seconds instead of 10 to answer its greeting while macOS scans the engine's binaries and libraries ([#19423](https://github.com/can1357/oh-my-pi/pull/19423) by [@shgew](https://github.com/shgew))
- Fixed `--continue` opening a new empty session when the terminal's last session was started in another directory and closed before its first message; it now resumes the current directory's newest session ([#19495](https://github.com/can1357/oh-my-pi/issues/19495)).
- Fixed a rejecting `pre-commit` hook's stdout (e.g. the `pre-commit` framework's per-hook report) missing from the error raised by the eval `commit` namespace and `omp commit` ([#19449](https://github.com/can1357/oh-my-pi/issues/19449))
- `/commit` now shows the subject a commit-msg hook wrote onto the commit, instead of the subject from before the hook ran ([#19448](https://github.com/can1357/oh-my-pi/pull/19448) by [@eggpeat](https://github.com/eggpeat))
- `^model` references followed by sentence punctuation now register their model agent instead of remaining literal ([#19445](https://github.com/can1357/oh-my-pi/pull/19445) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Selective commits in sparse checkouts no longer report paths outside the cone as unstaged deletions to commit hooks ([#19453](https://github.com/can1357/oh-my-pi/pull/19453) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Custom providers pointing at the Zhipu Coding Plan endpoint now retry at the Beijing-time quota reset instead of waiting eight hours too long ([#19446](https://github.com/can1357/oh-my-pi/pull/19446) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- `/copy` now copies what a mid-turn `out://` reply showed, instead of the reply tool's own "Shown to the user." result, and lists the reply's code blocks in the turn's blocks ([#19551](https://github.com/can1357/oh-my-pi/pull/19551) by [@bannert1337](https://github.com/bannert1337))
- Fixed tools enabled during goal mode becoming unavailable after leaving it ([#19514](https://github.com/can1357/oh-my-pi/pull/19514) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Fixed the status-line usage segment showing another account's quota for multi-credential API-key providers such as `opencode-go`; it now follows the credential row the session router actually serves from ([#19456](https://github.com/can1357/oh-my-pi/issues/19456)) ([#19492](https://github.com/can1357/oh-my-pi/pull/19492) by [@thekitaev](https://github.com/thekitaev)).
- Fixed Objective-C message results and arm64 retain-register data flow in Ghidra analysis of Mach-O binaries, including previously analyzed cache-extracted frameworks ([#19558](https://github.com/can1357/oh-my-pi/pull/19558) by [@shgew](https://github.com/shgew)).
- With a modal dialog open, browser `fill`, `type` and `press` aimed at a field behind it now fail naming what covers it, as `click` does, instead of typing into the dialog's button and reporting success (on Chromium tabs and Tern tabs without native DOM reads); `press` also refuses a disabled element (on Chromium tabs and Tern tabs without native DOM reads), and Chromium `drag` refuses a covered start or end ([#19524](https://github.com/can1357/oh-my-pi/pull/19524) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed RPC `login` refusing providers with an at-your-own-risk warning (`antigravity-cli`, `google-antigravity`): the warning now reaches the host as an `extension_ui_request` `input`, and login continues on "yes" and cancels on anything else ([#19523](https://github.com/can1357/oh-my-pi/issues/19523))
- On Linux, file watching for language servers no longer puts an inotify watch on every directory under `node_modules` and `.git/objects`, which could use up the system's inotify watch limit and keep other programs such as systemd from adding watches ([#19459](https://github.com/can1357/oh-my-pi/issues/19459))
- `/restart` now re-execs through the launcher omp was started by, so an open session moves onto an upgraded binary instead of re-running a retained old install ([#19529](https://github.com/can1357/oh-my-pi/pull/19529) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- RPC hosts now always receive a terminal `agent_end` after an over-quota 429: usage-limit bookkeeping is bounded so a stalled usage report can no longer hold the event ([#19411](https://github.com/can1357/oh-my-pi/issues/19411), [#19417](https://github.com/can1357/oh-my-pi/pull/19417) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Rex and other OSC 7501 terminals no longer play a success sound mid-run when a stale agent end arrives after another run has opened ([#17307](https://github.com/can1357/oh-my-pi/issues/17307), [#19418](https://github.com/can1357/oh-my-pi/pull/19418) by [@yuzu-octopus](https://github.com/yuzu-octopus))

## [18.22.1] - 2026-11-17

### Breaking Changes

- The JavaScript eval `commit` helper now validates its arguments strictly: unknown option names and non-object options throw a `TypeError` that lists the supported options. Update scripts that pass extra options. Committing an unchanged draft repository now reports that it is unchanged instead of suggesting `take()`.

### Added

- Added the `providers.webKeyless` setting, enabled by default, to control whether web search and URL reading may use keyless services. Disable it to restrict these operations to configured providers; individual `omp q --model web/<engine>` requests can still explicitly run a keyless engine.
- Added configurable live voice endpoints and API keys through `live.endpoint` and `live.apiKey`. Live voice can now connect to any OpenAI Realtime WebRTC-compatible server without Codex or ChatGPT sign-in, including offline use, and `live.voice` accepts arbitrary voice names.
- Computer `el.setValue()` now accepts finite safe integer and decimal numbers and writes them as text, while continuing to reject unsupported values such as booleans, objects, `NaN`, and `Infinity`.
- On macOS, browser results now report relevant native windows—such as pickers, print or save sheets, sign-in prompts, passkey dialogs, and permission bubbles—with their `computer.window()` identifiers.
- Browser `select()` now accepts label-, value-, and zero-based index-based choices, including mixed choices for multi-select controls, across Chromium, Tern, and cmux tabs.

### Changed

- Keyless Parallel searches no longer send session or model identifiers; only the search query is sent.
- The `computer` tool's macOS takeover messages now describe the actual keyboard handoff state and explain the behavior of background window moves and hover-only controls.
- Chromium `tab.observe()` and `tab.ariaSnapshot()` now wait briefly for page updates triggered by preceding actions, producing more reliable post-action results.
- When another agent controls the desktop, `InputBusy` now identifies that agent and its omp process.
- Subagents now use their own browser context by default instead of opening tabs in the user's Chrome, Tern, or cmux session; relay or Tern access can still be requested explicitly.
- Browser task guidance is now delivered automatically after the first browser call, with safety guidance available before the first call and restored after compaction or rewind.
- Named-menu reads now include nested commands with their complete command paths.
- The eval `commit` helper now runs configured Git hooks in addition to hooks in `.git/hooks/`, matching `git commit` behavior. Configured hooks may cause commits to take longer or be rejected.
- Service readiness patterns now match line boundaries correctly, and shell file-time commands honor the configured `TZ` timezone.
- Large `write` and `edit` calls remain responsive while their arguments stream.
- Selective commits now handle initialized submodule pointers and sparse checkouts more accurately, and report unmatched paths explicitly.
- Git commit operations now provide clearer status and hook feedback, including unchanged repositories, hook output, hook-modified commit subjects, and repositories with an in-progress operation or unresolved conflicts.
- `/continue` now resumes the newest session for the current directory when the most recent session was created elsewhere before receiving its first message.
- `/copy` now copies the content displayed by mid-turn `out://` replies and preserves their code blocks.
- Tools enabled in goal mode remain available after leaving that mode.
- Status-line usage now reflects the credential actually selected for multi-credential providers.
- Custom providers using the Zhipu Coding Plan endpoint now retry at the correct Beijing-time quota reset.
- `^model` references followed by sentence punctuation now resolve as model-agent references.
- `/restart` now restarts through the original launcher so upgraded installations are used by the resumed session.
- RPC hosts reliably receive completion events after quota errors, and OSC 7501 terminals no longer play stale success notifications during a newer run.

### Fixed

- Fixed configured Exa and Firecrawl credentials silently falling back to keyless endpoints when credential resolution failed; credential errors are now reported.
- Fixed eval cells bypassing delegated-task completion with `yield`; use the direct tool instead.
- Fixed `/commit` and eval commits creating incorrect single-parent commits during merge and other Git operations; commits are now refused while an operation is in progress or conflicts remain.
- Fixed the `apply_patch` tool documentation incorrectly describing it as a shell command and disallowing absolute paths.
- Fixed the shell `rg` builtin ignoring slash-containing `--glob` patterns.
- Fixed `eval commit only(...)` failing when a selected path or glob matched no changed files.
- Fixed browser calls becoming permanently busy after interrupted page evaluation, and fixed stale JavaScript `confirm` or `prompt` dialogs causing subsequent calls to fail.
- Fixed macOS Chrome and Electron `computer.setValue()` failing to select an option from an empty option list.
- Fixed browser relay tabs being closed when another extension—such as a password manager—holds the tab; the tab now remains available for reattachment.
- Fixed macOS computer takeovers failing to report user intervention when the user continued typing.
- Improved browser relay errors for hidden extension frames by identifying the frame, extension, and page involved.
- Fixed Anthropic web search for `site:` queries and safety-refused searches, including clearer refusal and provider-error reporting and appropriate retry behavior.
- Subagents without an output schema no longer receive an unnecessary `yield` tool, and `yield` without data no longer incorrectly uses the last message as its result.
- Fixed macOS popup and menu interactions that could leave menus open or press the wrong control.
- Fixed Claude losing reasoning from earlier non-Claude model turns after model switches or compaction, and prevented refusal text from contaminating later requests.
- Fixed selective commits skipping updated submodule pointers and incorrectly reporting sparse-checkout paths as deletions.
- Fixed Git status scans hanging when background Git processes kept output pipes open.
- Fixed first-launch WebKit startup on macOS falling back to Chromium while the engine was still initializing.
- Fixed rejecting pre-commit hook output being omitted from commit errors.
- Fixed Ghidra analysis of Objective-C message results and arm64 retain-register data in Mach-O binaries, including cached frameworks.
- Fixed browser interactions behind modal dialogs incorrectly reporting success; covered fields and disabled elements are now rejected, and covered drag endpoints are detected.
- Fixed RPC login for providers that require an at-your-own-risk confirmation; the confirmation is now presented to the host and login proceeds only after approval.
- On Linux, language-server file watching no longer consumes excessive inotify watches in `node_modules` and `.git/objects`.

## [18.22.0] - 2026-11-16

### Breaking Changes

- Moved binary analysis from the standalone `ida` and `ghidra` tools into the backend-neutral `dsm` namespace (`xd://eval/dsm`).
- Replaced the `ida.enabled`, `ida.maxOpen`, and `ida.idleCloseSec` settings with `disassembler.backend`, `disassembler.maxOpen`, and `disassembler.idleCloseSec`; shared disassembler database APIs are now available under `@oh-my-pi/pi-coding-agent/disasm`.

### Added

- Added Tern plan review editing and comments: double-click plans to edit them, select text to add Google Docs-style comments, and send comments to Refine.
- Added Ghidra support with automatic setup of Ghidra, JDK, and PyGhidra when analysis is explicitly requested; Auto mode uses an installed IDA Pro when available and otherwise falls back to Ghidra.
- Added support for sharing live analysis databases with child agents through `db.handle()` and `dsm.open(handle)`.
- Added a `Force Remove` option to `worktree.onExit` that removes session-created worktrees without prompting, including worktrees with uncommitted changes; new commits remain on the worktree branch.

### Changed

- Updated Tern plan review with a single Approve control, comment-aware Refine option, model selection, and a Save action that writes the plan while keeping review open and plan mode active.
- Plain executable reads now display Mach-O, ELF, and PE metadata without opening an analysis database or downloading a backend; request an overview, function details, or `dsm.open()` to begin analysis.
- Improved the model switcher (`Alt+P` / `/switch`) with provider filtering and per-switch thinking-level selection. In Tern, it now opens above the composer with integrated search, provider and Task/Main filters, and a thinking-level slider.

### Fixed

- Deleting or moving large directory trees inside a project no longer stalls language-server file watching ([#19490](https://github.com/can1357/oh-my-pi/pull/19490) by [@H4vC](https://github.com/H4vC)).
- Reduced CPU and memory usage for long-running subagents as their sessions grow ([#19486](https://github.com/can1357/oh-my-pi/pull/19486) by [@H4vC](https://github.com/H4vC)).
- Fixed `commit.draft()` incorrectly classifying files deleted or renamed through bash or eval as “Not yours”; they now appear under Review.

### Removed

- Removed the legacy standalone disassembler tools and their associated prompt instructions.
- Removed the Copy and Edit-in-editor buttons from the Tern plan review sheet; use selection copying and double-click editing instead.

## [18.21.0] - 2026-11-16

### Breaking Changes

- Updated the `AgentSession` run lifecycle API: `agent_end` is emitted once when a run can no longer resume, and `agent_pause` reports runs that stop while awaiting work. Replaced `hasPendingAsyncWork()`, `settleAsyncWork()`, and `suppressAutoResumeUntilPrompt()` with `isRunActive`, `wakeSources`, and `waitForRunEnd()`. Calling `abort()` now also ends runs paused on background work; RPC, JSON print, collaboration, and extension streams retain their existing per-loop `agent_end` behavior.

### Added

- Added configurable automatic subagent prewalk through `task.agentPrewalkAuto`, allowing per-agent `on`/`off` settings or model patterns while preserving unconditional subagent prewalk.
- Unknown custom and discovered models now automatically detect reasoning support and remember supported reasoning effort levels for future sessions.
- Added inline image and web-page replies: supported terminals can display local, data, and HTTP(S) images and embedded pages, while other terminals receive linked fallbacks. Added `tui.renderEmbeds` to disable this rendering.
- Added interactive embedded pages in Tern replies, including click-to-visit and Escape-to-return navigation; common host, path, and `file:` URL forms are accepted.
- Bash redirects can now write to all writable internal URLs, including job cancellation endpoints and handler-backed `agent://`, `cfg://`, `ssh://`, and `xd://` URLs.
- Added image pasting to `ask` form notes and `ui.formDialog` options via `acceptImages`; pasted images are returned with `[Image #N]` markers and described for text-only models. Unsupported prompts now clearly reject image pastes.

### Changed

- Changed the default local text-to-speech model to Phonon 31M for faster synthesis, smaller downloads, and additional voices. Existing Kokoro voice settings migrate automatically; speaking rates now range from 0.8× to 1.3×.
- Tern `/btw` responses now appear as folded, interactive notes at the point where they were requested, with follow-up, copy, branch, inject, and stop actions; `/btw` without a prompt still opens the history view.
- Overlapping Bash calls now share shell state, including variables, functions, aliases, options, and traps, and background jobs started by those calls continue running independently.
- Extensions enabled or reconfigured through `extensions` or `disabledExtensions` now load into the active session without requiring a restart.
- Rich-text pastes made during approval steering or in dialogs now preserve Markdown formatting and images when inserted into the chat editor.
- Moving a task or resuming a session in another project now switches its agents, extensions, custom tools, and MCP servers to match the destination project without a restart.

### Fixed

- Fixed status indicators incorrectly showing the agent as idle while subagents or background work could still resume the run.
- Fixed subagents and security scans completing while child agents were still running or queued peer messages remained.
- Fixed conflict-region resolution when a selected side is empty or shares edge lines with surrounding code.
- MCP stdio server failures before a response now report the process exit code or terminating signal instead of only reporting closed stdout.
- Fixed prewalk handoffs so model and reasoning-effort changes are preserved, and automatic handoffs return to the planning model when automatic prewalk is changed or disabled.

## [18.20.3] - 2026-11-16

### Breaking Changes

- Renamed the browser `tab.clickAt()` option from `clickCount` to `count`, matching `tab.click()`.
- Browser viewport screenshot coordinates now use the displayed image coordinates when the screenshot is scaled for the model; pass `css: true` (or `{ x, y, css: true }` for drag points) to provide viewport CSS pixels explicitly.
- Added opt-in `mnemopi.recallRelevance` (`off`, `auto`, or `on`; default `off`) to filter automatic memory recall for task relevance using the `judge` role.
- Added path-scoped entries for `bash.patterns` and `bashInterceptor.patterns`, resolved per working directory. Project and `--config` overlays now prepend these rules to global rules instead of replacing them.
- Added `bash.allowedEnvVars` and per-rule `env` lists to permit explicitly named environment-variable prefixes on matching `allow` rules.
- Subagents now preserve `@upstream` provider pinning on inherited models.
- Added `--no-judge`, `--no-spotlight`, and `--offline` options to restrict auxiliary services to the active model's provider or disable cross-provider services.
- Added per-rule TTSR `repeatMode` frontmatter (`once`, `after-gap`, or `always`) to override the global repeat policy.
- Compound bash approval prompts now show each command segment separately, distinguishing allowed segments from those requiring approval.
- Removed the `seance` agent, `/seance` command, and the task tool's `sourceSession` parameter.

### Added

- Added `mnemopi.embeddingQueryPrefix` and `mnemopi.embeddingInputType` configuration for asymmetric and instruction-tuned embedding models, including providers that require an `input_type`.

### Changed

- Browser screenshots are delivered to the model in CSS pixels up to the supported unscaled size, making viewport screenshot coordinates directly usable with browser actions; scaling guidance remains for scaled full-page and element captures.
- Browser `waitForUrl`, `waitForResponse`, and `requests({ filter })` now support `*` glob patterns in URL strings, while other strings retain substring matching.
- The WebKit browser engine now automatically installs and updates to the newest stable ABKit release, with versioned installations that allow updates without waiting for existing browser hosts to exit.
- Improved browser responsiveness and recovery: unresponsive WebKit pages fail fast with actionable errors, navigation can recover busy pages, and browser operations provide clearer diagnostics for timeouts, closed tabs, unsupported event listeners, invalid routes, cookie data, and viewport changes.
- Pressing Delete at the end of the Ctrl+R search field removes the selected prompt from history.
- `/copy` now works while viewing a subagent and copies from that subagent's transcript.
- `find` now returns unranked literal keyword matches when all judge requests fail.
- `take()` and `drop()` now reject nonexistent hunk units with a clear error.
- `edit` rejection messages now suggest the file's current tag, and edits made before conflict resolution carry over to the resolved file.
- `/marketplace` and marketplace install/uninstall commands now report picker and catalog-load errors without exiting the session.
- ACP sessions honor `mcp.startupTimeoutMs` for MCP servers declared by the client, and ACP form elicitations no longer repeat field labels unnecessarily.
- Task progress from every `task.steps` subagent step is now preserved, rather than only the final step's report.
- Pasting HTML into the composer now preserves spaces from whitespace-only inline elements and indentation inside `<pre>` blocks.
- Queued follow-ups edited with Alt+Up are restored as queued messages instead of being sent into the active turn.

### Fixed

- Fixed `ida` `exec` output on IDA 9.5+ by suppressing helper deprecation warnings and preserving the updated function metadata API.
- Expired Perplexity logins and cookies no longer return an error page as a search answer; the provider is reported as expired and the search chain continues.
- Fixed browser WebMCP discovery and invocation on Chrome and Chromium 157 and later.
- Private hosts written with a trailing dot are now correctly handled by Ask and `always-ask-cached` before file tools access them.
- Fixed the TUI freezing when switching sessions from an open tool-approval prompt.
- Fixed `/commit` and eval `commit` dropping UTF-8 BOMs or mishandling quoted and Unicode filenames during change tracking and selective commits.
- Fixed misleading Wayland clipboard warnings when pasting an image or when the clipboard is empty.
- Fixed JavaScript evaluation after an in-place Linux upgrade by keeping session workers tied to the session's build.
- Deleting a session that cannot be removed no longer deletes its prompt history and statistics.
- Fixed `read` and `write` handling of line selectors on `xd://` device URLs.
- Fixed `eval wait()` rejecting or mishandling numeric delays; browser waits now direct users to the appropriate wait helpers.
- Fixed browser `open` with an existing Arch Chromium profile, Tern navigation, closed external Tern blocks, and docked Tern viewport emulation.
- Fixed Tern and WebKit browser calls that incorrectly exposed unsupported page event-listener APIs; errors now identify the supported alternatives.
- Fixed browser timeout and busy-page errors to include the current URL, affected tab, and actionable recovery guidance.
- Fixed Mnemopi embedding failures being silently downgraded to keyword search; provider errors now produce a warning, including in print mode on stderr.

## [18.20.2] - 2026-11-14

### Added

- Added the `antigravity-cli` provider for Google Antigravity over ACP, with managed binary installation, `/login antigravity-cli` Google sign-in, host tool execution, and retained conversations across tool steps and history changes.

## [18.20.1] - 2026-11-14

### Added

- Added `/commit` to create commits containing only changes made by the agent or a selected subagent, while preserving other agents’ and the user’s work. The workflow is also available through the eval `commit` namespace, supports targeting repositories outside the session directory, handles binary and non-UTF-8 files, symlinks, file mode changes, and initial commits, and can optionally skip commit hooks with `no_verify`; use `commit.enabled` to disable it.
- Added `auth.unpausedProviders` (the **Unpaused Providers** setting) to re-enable paused providers such as Google Antigravity at your own risk while preserving their stored login state.
- Added configurable long-turn todo reminders through `todo.midRunNudges`, including options to disable reminders, limit them to two, or continue with increasing intervals.
- Pasting styled content into the composer now preserves Markdown formatting and places embedded images at their original positions, while code copied from editors remains plain text.
- Added the `session_clear` hook and extension event, emitted when `/clear` resets the current session context without changing its session ID.
- Added path-scoped Bash allow rules, project and configuration overlay precedence, and environment-variable controls through `bash.allowedEnvVars` and per-rule `env` settings.
- Subagents now preserve `@upstream` provider pinning when inheriting models.
- Added deletion of individual prompts from Ctrl+R history with the Delete key.
- Added `--no-judge`, `--no-spotlight`, and `--offline` options to restrict or disable auxiliary services outside the active model’s provider.
- Added per-rule TTSR `repeatMode` settings (`once`, `after-gap`, or `always`) to control reminder repetition.
- Bash approval prompts now show compound command segments individually and identify which segments are allowed or require approval.
- Todo `done`, `drop`, and `rm` operations now accept multiple tasks in a single request, including newline-, semicolon-, comma-, or space-separated input without splitting exact task-name matches.
- Todo status lines now display task counts when multiple targets are involved.

### Changed

- `/fork` and fork-from-transcript now abort an active response and fork immediately.
- Reduced default `grep` output by showing only matching lines and limiting matches per file; configure `grep.contextBefore` and `grep.contextAfter` to include surrounding context.
- Changed the default `spotlight.thinking` level from `low` to `med` for deeper result analysis and improved ranking, at a higher request cost.
- When Spotlight is enabled, commonly reread source and issue or pull-request content is shown more completely before outlining, including support for additional source file types.

### Fixed

- `/loop` now pauses after a provider error such as a rate limit instead of resubmitting the same prompt and attaching its `@file` mentions again ([#19272](https://github.com/can1357/oh-my-pi/issues/19272)).
- Resuming a session whose directory was deleted now continues in the current directory with a warning instead of failing.
- Model mentions and `/switch` completions now recover discovered models after provider discovery fails at startup, retrying discovery when needed.
- Background job results that arrive after an ACP prompt ends are now carried into the next prompt instead of starting an invisible turn.
- OpenAI server compaction failures now proceed to the next available compaction method instead of retrying server compaction on another model.
- Language servers now recognize edits made shortly after a file is created, including on macOS.
- Bash commands displayed in the Pseudo shell view now remain accurate while streaming through heredocs, substitutions, loops, continuations, arithmetic expressions, and background execution.
- Resuming a session or reviving a subagent after a retry fallback with a thinking suffix (e.g. `:xhigh`) now restores the primary model's own thinking level instead of keeping the fallback's ([#19273](https://github.com/can1357/oh-my-pi/issues/19273)).

## [18.20.0] - 2026-11-12

- With the Spotlight experiment on, a `read` with `:raw` returns the selected bytes instead of an outlined, compacted, collapsed or cut rendering ([#18713](https://github.com/can1357/oh-my-pi/pull/18713) by [@eggpeat](https://github.com/eggpeat))
- With the Spotlight experiment on, a `;`/`,` path `read` is shaped as one call: each part as that read alone would be (an outlined source file beside a `:raw` part kept verbatim), no part collapsed as already shown against another, and one trace whose notice opens the original ([#18713](https://github.com/can1357/oh-my-pi/pull/18713) by [@eggpeat](https://github.com/eggpeat))
- ACP `/session delete` no longer leaves an empty, untitled session in `session/list`; the replacement session is written only once it has content ([#19068](https://github.com/can1357/oh-my-pi/issues/19068))

### Breaking Changes

- `secrets.yml` regex rules are now Rust `regex` patterns run natively, in linear time: lookarounds and backreferences are no longer supported, and a `(?P<secret>…)` group marks the part to redact (text around it is context that stays); `\d`, `\w` and `\s` are Unicode-aware. A regex rule that does not compile stops startup with an error naming the file and entry instead of being skipped. Migrate `(?<=password=)\S+` to `password=(?P<secret>\S+)`; see [docs/secrets.md](https://github.com/can1357/oh-my-pi/blob/main/docs/secrets.md) ([#18965](https://github.com/can1357/oh-my-pi/pull/18965) by [@H4vC](https://github.com/H4vC))
- Secret placeholders are now four camelCased words after the friendly name, e.g. `GitHubToken_correctHorseStapleBattery`, with no `$$` delimiters, and the transcript shows the real value wherever the model wrote one. Placeholders in the old `$$NAME_HASH:CASE$$` form, in sessions saved before this change, stay literal text, including in tool calls the model copies them into; start a new session to get working placeholders ([#19014](https://github.com/can1357/oh-my-pi/pull/19014) by [@H4vC](https://github.com/H4vC))
- What the model writes from placeholders (replies, thinking, tool calls, summaries) is stored as written and replayed byte-identical, keeping thinking signatures and prompt caches valid; model output that still holds a value (written while redaction was off, or before the secret was configured) is redacted on replay. Values a regex rule finds later no longer rewrite earlier history. A `friendlyName` is shown to the model as written and is dropped only when it spells out its own secret ([#19014](https://github.com/can1357/oh-my-pi/pull/19014) by [@H4vC](https://github.com/H4vC))
- Nix builds with `withAppleFm = false` no longer compile the Apple Foundation Models bridge with the host's Xcode ([#18911](https://github.com/can1357/oh-my-pi/pull/18911))
- Apple Silicon Nix builds include Apple Foundation Models support instead of silently building without it ([#16584](https://github.com/can1357/oh-my-pi/pull/16584) by [@honsunrise](https://github.com/honsunrise))
- `ask` over RPC hosts without a form dialog now shows each prompt with the form's surrounding paragraphs, lists, preformatted blocks and tables instead of only the question ([#18927](https://github.com/can1357/oh-my-pi/issues/18927))

### Added

- Added the Gemini Decision 1 judge (`google/gemini-decision-1`) for the `judge` role, and `models.yml` accepts the `google-decisions` API ([#19060](https://github.com/can1357/oh-my-pi/pull/19060) by [@kevcube](https://github.com/kevcube))
- `ssh://` host listing, `ssh://` autocomplete and `/ssh list` now include the `Host` aliases from `~/.ssh/config` and `/etc/ssh/ssh_config` (following `Include`); `ssh.json` entries win on a name clash
- Added `find.verifyModel`, a model selector whose judge answers only `find`'s passage verification while filename and sketch ranking stay on the `judge` role ([#19006](https://github.com/can1357/oh-my-pi/pull/19006) by [@alphastorm](https://github.com/alphastorm))
- Added `omp bench --account` to benchmark a specific stored OAuth account, and report rejected priority requests instead of silently benchmarking standard speed.
- Text a browser or computer call types into a page or app, such as a password, no longer appears in plain text in an eval cell's status lines or the session file ([#18981](https://github.com/can1357/oh-my-pi/pull/18981) by [@will-bogusz](https://github.com/will-bogusz))
- Browser page-script observations in Tern and WebKit now mask password values, including values used as accessible names or descriptions ([#18983](https://github.com/can1357/oh-my-pi/pull/18983) by [@will-bogusz](https://github.com/will-bogusz))
- Chromium main-world `waitForFunction` calls no longer expose Puppeteer's internal ARIA query bindings to page scripts ([#18883](https://github.com/can1357/oh-my-pi/pull/18883) by [@will-bogusz](https://github.com/will-bogusz))
- On macOS a `computer` run that ends while secure input is on now starts with a note naming the app holding it and saying the user's Escape and typing go unseen until it ends, instead of nothing while `capabilities()` still reported `globalEscape: true` ([#18982](https://github.com/can1357/oh-my-pi/pull/18982) by [@will-bogusz](https://github.com/will-bogusz))
- Windows computer runs now explain when a locked or disconnected session, or a secure desktop, prevents capture and input from confirming your app's state ([#18947](https://github.com/can1357/oh-my-pi/pull/18947) by [@will-bogusz](https://github.com/will-bogusz))
- Computer helpers now reject unknown option and filter keys instead of silently ignoring them, including keys unused by the selected `wait` or element `press` overload, and name valid keys and likely spelling corrections ([#18753](https://github.com/can1357/oh-my-pi/pull/18753) by [@will-bogusz](https://github.com/will-bogusz))
- Selector waits on Chromium-backed browser tabs and their frames now accept `state: "attached" | "detached" | "visible" | "hidden"` alongside Puppeteer's `visible`/`hidden` forms, including live snapshot refs and waits that span a navigation, and reject unknown options, invalid values or conflicting visibility flags instead of silently ignoring them. Frame wait timeouts remain catchable later in the same run; Tern and cmux tabs are unchanged ([#18924](https://github.com/can1357/oh-my-pi/pull/18924) by [@will-bogusz](https://github.com/will-bogusz))
- Chromium main-world `waitForFunction` calls rearm across navigation after an earlier wait instead of rejecting with "Waiting failed" ([#18884](https://github.com/can1357/oh-my-pi/pull/18884) by [@will-bogusz](https://github.com/will-bogusz))
- In Chromium browser tabs, `tab.hover` and element-handle `hover()` on a hidden match now wait for it to appear and, if it never does, fail with the reason (and a selector's match count), as clicks do, instead of failing at once with Puppeteer's "Node is either not clickable or not an Element" ([#18750](https://github.com/can1357/oh-my-pi/pull/18750) by [@will-bogusz](https://github.com/will-bogusz))
- Treating the result of browser `tab.console()` or `tab.errors()` as an array now fails with a message saying to read its `.entries`, instead of `slice is not a function`, and the browser docs state the `{ entries, nextSeq, dropped }` shape ([#18738](https://github.com/can1357/oh-my-pi/pull/18738) by [@will-bogusz](https://github.com/will-bogusz))
- A printed browser `tab.observe()` result, including a full observation returned through `tab.run()` (not arbitrary objects with an `elements` array), or one left as a JavaScript Eval cell's last value, shows every element, one line each, instead of the first 100 followed by `... N more items`; an observation changed after it returned, including in-place prototype edits, prints as plain inspect output, every element included ([#18772](https://github.com/can1357/oh-my-pi/pull/18772) by [@will-bogusz](https://github.com/will-bogusz))

### Changed

- Secret redaction no longer rescans the whole conversation on every request: text already redacted in an earlier request is reused until a new secret changes the outcome, and `secrets.yml` regex rules skip text missing their leading literal, cutting redaction on a large session from 17–55 ms to about 1 ms per request and the first request after loading by 2–4×
- Trimmed the default system prompt: the tool-choice rules now only point to `read`, `edit` and `find`; the reasoning-format, AST and subagent-limit guidance is gone (`ast_edit`/`ast_grep` state their preference in their own summaries); the workflow, delivery and critical rules are shorter and no longer repeat each other; Spotlight's note on how tool results are shaped is a short list under Tool I/O instead of a paragraph at the end; and xd:// devices are listed by bare name
- `edit.modelVariants` now picks the longest matching model pattern instead of the first, so a specific key like `openai/gpt-5` wins over `gpt` whatever the config order ([#17835](https://github.com/can1357/oh-my-pi/pull/17835) by [@DeprecatedLuke](https://github.com/DeprecatedLuke))
- Browser tabs open in omp's own headless WebKit engine instead of managed Chromium when the engine, ABKit, is installed (`~/.o2/lib/abkit/ABHost`, `ABHost.exe` on Windows, the location Tern uses too; or the `browser.webkitPath` setting / `PI_BROWSER_WEBKIT_PATH`): pages see a visible, focused window with no automation flag, and a default tab runs no omp script in the page (console, errors and the request log come from the engine; `route`, geolocation/locale/offline emulation, `vitals` and `reactEnable` add page code only when called; response bodies are unavailable there). Chromium still opens `headed` tabs where the engine ships no viewer and takes over, saying why, when the engine cannot start; `app: "chromium"` picks Chromium for one open and `app: "webkit"` requires WebKit (with `headed: true` its tab opens in a window), and the `browser.webkit` setting or `PI_BROWSER_WEBKIT=0` turns it off. On macOS the engine has WebGL, WebGPU, silent video and audio playback, Web Audio, WebRTC, WebAuthn, gamepads and Web Share, and its TLS handshake, HTTP/2 settings and request headers are the ones Safari sends
- omp downloads its WebKit engine, ABKit, from build.stencil.so into `~/.o2/lib/abkit` (checked against the build's SHA-256) for `app: "webkit"` when it is missing, and before Chrome for Testing when an open finds no browser installed; a failed download leaves that open on Chromium and says why
- The `task` tool description now lists only the delivery rules (results auto-deliver, `wait`, unverified `completed`); the `read proc://`, `write proc://<id>/kill`, job-expiry and `write agent://` reference arrives with the session's first spawn result
- The `ask.timeout` setting, README and RPC schema docs now describe the `ask` tool as an HTML form that submits its current values on timeout, not a question picker that auto-selects an option
- The `bash` tool description lists the embedded shell's in-process builtins again, straight from the shell, so it follows every `PI_DISABLE_*` switch and the platform
- `read`'s selectors for SQLite, archives, JSON queries, executables, video and SVG, and the sub-path grammar of `proc://`, `ssh://` and `issue://`/`pr://`, no longer ship with every request: the model reads them on demand at `xd://read/sources` and `xd://read/urls`, and they stay inline when `read` is off
- `/browser visible` and `/browser headless` now show and hide the windows of omp's WebKit tabs at once instead of waiting for the next open: where the engine ships its viewer (macOS), each tab gets a window of its own that the user can also click, scroll and type in, and `headed: true` or `browser.headless` off keeps a tab on WebKit with a window instead of sending it to Chromium. Chromium tabs still change mode with the next open
- In a Tern whose engine reads the DOM natively, browser `observe`, selectors, clicks, typing, element reads and waits no longer run script in the page: the engine finds elements (across frames and closed shadow roots) and every action is trusted input at the point it resolved; `type` then types at the caret its click places, and `text/` selectors ignore case
- A browser screenshot's text is one line (the size the model sees, the full-size file when one was kept, and the coordinate factor for `tab.clickAt`) instead of four lines with byte sizes and formats, and `browser.open` reports the tab, the page it landed on when that is not the requested URL (using navigation's normalized URL comparison), and the title on one line ([#18776](https://github.com/can1357/oh-my-pi/pull/18776) by [@will-bogusz](https://github.com/will-bogusz))
- RPC `select` requests carry `initialIndex`, `selectionMarker`, `checkedIndices` and `markableCount`, so hosts can show which `ask` checkbox options are already checked instead of letting users toggle them blind ([#18929](https://github.com/can1357/oh-my-pi/pull/18929) by [@andrebrait](https://github.com/andrebrait))
- Every language server now hands file watching to omp (it was only TypeScript 7); set `watchFiles: false` on a server to keep its own watcher
- A failed JavaScript Eval cell prints the error's message and the cell's own frames, with one line counting the hidden frames from omp's runtime, its dependencies and the engine, instead of the full host stack; project-local dependency frames stay visible, cached stacks whose headers no longer match the error stay intact, floating rejections retain their current message and missing-await hint even with a cached stack, and `print(e.stack)` in a `catch` still shows every frame ([#18775](https://github.com/can1357/oh-my-pi/pull/18775) by [@will-bogusz](https://github.com/will-bogusz))
- Snapcompact compaction resolves the frame shape once in its preflight and passes it to `compact()`, which re-derived it with the `auto` shape setting; the preflight scans the transcript once instead of twice, runs as the `compaction.snapcompact` loop phase, and yields to the event loop before rendering ([#15689](https://github.com/can1357/oh-my-pi/issues/15689), [#18867](https://github.com/can1357/oh-my-pi/pull/18867) by [@wolfiesch](https://github.com/wolfiesch))
- Full session file rewrites (pruning, image drops, rescue stamping) run as the `session.rewrite` loop phase, so their stalls are attributed in `ui.loop-blocked` logs ([#15027](https://github.com/can1357/oh-my-pi/issues/15027), [#18867](https://github.com/can1357/oh-my-pi/pull/18867) by [@wolfiesch](https://github.com/wolfiesch))

### Fixed

- With the Spotlight experiment on, a `read` with `:raw` returns the selected bytes instead of an outlined, compacted, collapsed or cut rendering ([#18713](https://github.com/can1357/oh-my-pi/pull/18713) by [@eggpeat](https://github.com/eggpeat))
- With the Spotlight experiment on, a `;`/`,` path `read` is shaped as one call: each part as that read alone would be (an outlined source file beside a `:raw` part kept verbatim), no part collapsed as already shown against another, and one trace whose notice opens the original ([#18713](https://github.com/can1357/oh-my-pi/pull/18713) by [@eggpeat](https://github.com/eggpeat))
- Fixed false unknown-model fallback warnings on cold or stale caches for authenticated `openai-codex`, `google-antigravity`, and `google-gemini-cli` providers, stopped disabled cold-cache providers from deferring fallback warnings, and stopped lazy catalog loads from overwriting completed or failed discovery states ([#19017](https://github.com/can1357/oh-my-pi/pull/19017) by [@PGupta-Git](https://github.com/PGupta-Git))
- ACP clients such as Orca now show an `ask` HTML form's "Other" text box inside its radio/checkbox question instead of as a second, duplicate question ([#19028](https://github.com/can1357/oh-my-pi/issues/19028))
- Fixed background jobs (`&`), subshells and command substitutions in the `bash` tool seeing changes the parent shell made after they started; they now keep the variables, positional parameters (`$1`, `$@`), functions, aliases and shell options they started with, as in bash ([#19072](https://github.com/can1357/oh-my-pi/pull/19072) by [@H4vC](https://github.com/H4vC); reported in [#18990](https://github.com/can1357/oh-my-pi/pull/18990) by [@alphastorm](https://github.com/alphastorm))
- MCP tools returning lists or strings no longer repeat their payload in the model's context when the server also sends SDK-wrapped structured content ([#18894](https://github.com/can1357/oh-my-pi/issues/18894), [#18920](https://github.com/can1357/oh-my-pi/pull/18920) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- In Chromium browser tabs, `page.evaluate`, `evaluateHandle`, `$eval`, `$$eval` and `waitForFunction` inside `tab.run` now see the page's own globals and custom elements, as `tab.evaluate` does, instead of `null` or `undefined`; waits support concise methods, poll at page-side intervals, reject invalid polling options, preserve abort reasons and stop polling on cancellation, disposing late results ([#18751](https://github.com/can1357/oh-my-pi/pull/18751) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp bench --account`, `omp dry-balance --bench`, and security scans pinned to one OAuth account sending the raw access token to providers whose API key is a structured credential (GitHub Copilot, Gemini CLI, Antigravity, Snowflake); they now send the same key normal requests do ([#19030](https://github.com/can1357/oh-my-pi/pull/19030) by [@Xytronix](https://github.com/Xytronix))
- A hashline `PUT` whose body repeats the line just outside its range and otherwise leaves the range unchanged now adds that copy, instead of silently doing nothing while reporting an auto-repaired boundary echo ([#18234](https://github.com/can1357/oh-my-pi/pull/18234) by [@eggpeat](https://github.com/eggpeat))
- `omp --help` lists the tool names `--tools` accepts, grouped into enabled-by-default and optional; browser and computer use are documented as `eval` features ([#19064](https://github.com/can1357/oh-my-pi/pull/19064) by [@nibblebot](https://github.com/nibblebot))
- Added Liquid AI judges (`liquid/d1.1`, `liquid/d1-ultra`) for the `judge` role; images are resized to fit Liquid's per-request patch budget ([#18076](https://github.com/can1357/oh-my-pi/issues/18076), [#18100](https://github.com/can1357/oh-my-pi/pull/18100) by [@SuperUserA](https://github.com/SuperUserA))
- Added Nace Drex judges (`nace/drex-max-v1.1`, `nace/drex-max-finance`, `nace/drex-v2.0`) for the `judge` role, including Drex Max image judgments ([#18950](https://github.com/can1357/oh-my-pi/pull/18950) by [@alphastorm](https://github.com/alphastorm))
- Added the `find.hitThreshold` setting (above 0, up to 1; unset keeps 0.2): the probability a verified passage needs before `find` and `omp find` report its file or list its range, so a judge other than TypeSafe Jev can run at the cutoff that fits its calibration ([#18963](https://github.com/can1357/oh-my-pi/pull/18963) by [@alphastorm](https://github.com/alphastorm))
- GitHub Actions watches now show per-step progress, states, and durations, with Ctrl+O expansion and native Tern Surface Protocol views ([#18945](https://github.com/can1357/oh-my-pi/pull/18945) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Computer instructions now describe macOS `StaleRef` refusals for relabelled controls, including the new ref and the weaker role-and-label recovery candidate from a partial window read ([#18892](https://github.com/can1357/oh-my-pi/pull/18892) by [@will-bogusz](https://github.com/will-bogusz))
- Computer-use guidance tells the agent to reread the window after `UserIntervened` on X11 as well as macOS, without undoing or replaying over the user's input ([#18784](https://github.com/can1357/oh-my-pi/pull/18784) by [@will-bogusz](https://github.com/will-bogusz))
- Computer raise refusals say that on X11 a covered window's screenshot needs a compositing manager, instead of promising one plain X11 cannot supply ([#18783](https://github.com/can1357/oh-my-pi/pull/18783) by [@will-bogusz](https://github.com/will-bogusz))
- The `computer` tool's takeover `type` on Windows no longer loses the end of the text in apps that read keys slowly, such as Chrome, while reporting success, and says in its output when the text was sent but the app was not seen reading it ([#19037](https://github.com/can1357/oh-my-pi/pull/19037) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `wait` returning "Nothing to wait for" after a directly messaged agent sent an `agent://all` broadcast before replying, instead of blocking for its direct reply ([#18976](https://github.com/can1357/oh-my-pi/pull/18976) by [@alphastorm](https://github.com/alphastorm))
- Fixed the TUI marking pending or in-progress todos completed when a subagent with a matching or similar description finishes; matching todos still highlight while the subagent runs and are marked completed only through `todo` or `/todo` ([#18975](https://github.com/can1357/oh-my-pi/pull/18975) by [@alphastorm](https://github.com/alphastorm))
- Fixed worker-thread subagents logging `Failed to bind extension … <inline-0>` on every spawn and subagents reporting themselves to Warp as separate sessions; an SDK inline extension that worker threads cannot load now logs one warning naming it ([#18980](https://github.com/can1357/oh-my-pi/pull/18980) by [@alphastorm](https://github.com/alphastorm))
- Fixed the shell's `ls` builtin so non-numeric `-T`/`--tabsize` values (such as `ls -laT dir`, which previously listed the working directory) and overflowing `-w`/`--width` values with trailing non-digits now fail with exit 2 ([#18985](https://github.com/can1357/oh-my-pi/pull/18985) by [@alphastorm](https://github.com/alphastorm))
- Fixed `read` JSON queries (`archive.tar:member.json?q=.x`) on text archive members failing with `not found inside archive` while preserving literal `?` member names and member or query-output line selectors ([#18970](https://github.com/can1357/oh-my-pi/pull/18970) by [@alphastorm](https://github.com/alphastorm))
- Fixed `write` LSP diagnostics warning that a `#!` script is not executable (such as Ruff `EXE001`) on calls that mark the file executable (`chmod +x`) ([#18978](https://github.com/can1357/oh-my-pi/pull/18978) by [@alphastorm](https://github.com/alphastorm))
- Fixed `read xd://<tool>` and `write xd://<tool>` for unambiguous wire aliases of enabled tools (such as `xd://apply_patch` when `edit` uses `apply_patch` mode) so they return tool docs, run with the tool's approval tier, and no longer fail with `No such tool` ([#18977](https://github.com/can1357/oh-my-pi/pull/18977) by [@alphastorm](https://github.com/alphastorm))
- Fixed `yield` rejecting a JSON-string `data` payload with `expected object, received string` when the decoded value fails the output schema; it now reports the decoded field violations ([#18971](https://github.com/can1357/oh-my-pi/pull/18971) by [@alphastorm](https://github.com/alphastorm))
- Fixed `github` `run_watch` marking failed-job logs unavailable when they contain ANSI or other terminal escape sequences, returning plain-text logs on both current and older GitHub CLI (`gh`) releases ([#18968](https://github.com/can1357/oh-my-pi/pull/18968) by [@alphastorm](https://github.com/alphastorm))
- Fixed `edit` results after `lsp.formatOnWrite` (or an editor's format-on-save) reformatted the file showing the lines as sent under the formatted file's `[path#TAG]`; the result now shows the written lines and no longer blames the editor ([#18998](https://github.com/can1357/oh-my-pi/issues/18998))
- Fixed prewalk handing off to the cheaper model on exec-tier `xd://` device calls (test runners, remote commands, extension devices) and on `proc://` service stdin or mode writes, before any file was changed ([#19002](https://github.com/can1357/oh-my-pi/issues/19002))
- TypeScript 7 (`typescript-native`) no longer runs its own file watcher: omp watches the files it registers and reports changes, including ones made outside omp, so on Linux it sees edits from other tools instead of keeping stale diagnostics, and on network drives such as ovnfs checkouts its watcher no longer loops, keeping the drive's file server busy and stalling every checkout on it. Other servers opt in with the `watchFiles` server setting ([#18964](https://github.com/can1357/oh-my-pi/pull/18964) by [@H4vC](https://github.com/H4vC))
- Folders moved into a watched project now report their files to language servers, and folders moved out or renamed report their deletion, so servers no longer keep stale or missing files after `mv` or a package install
- Language servers that watch files through omp no longer get changes under `node_modules` packages or `.git` object stores unless they asked for those directories, matching VS Code's default watcher excludes
- On Linux, a project too large for inotify's watch limit is watched one directory at a time instead of losing all file watching, and on network drives a lagging server clock no longer hides changes found after a watcher overflow
- Fixed the `grep` tool so directly named files containing NUL bytes are searched as text, directory and glob searches name skipped binary files that match instead of reporting `No matches found`, and returned match and context lines strip NUL, ANSI escape, and control characters ([#18988](https://github.com/can1357/oh-my-pi/pull/18988) by [@alphastorm](https://github.com/alphastorm))
- Added the `encourageEdits` setting (default on), which makes the system prompt require the `edit` tool and forbid sed/perl/python file edits; turn it off to drop that guidance.
- A browser call from Eval that sets no timeout of its own, such as `tab.evaluate(…)` or `tab.run(fn)`, now runs as long as the Eval cell's `timeout` instead of failing at 30 seconds, and a call that runs out of time says what happened to the tab and how to give it longer ([#18737](https://github.com/can1357/oh-my-pi/pull/18737) by [@will-bogusz](https://github.com/will-bogusz))
- Cancelling a browser call now releases an unresponsive worker after its cancellation grace instead of waiting for the full call budget, and recovery after a timeout has its own bounded startup budget ([#18737](https://github.com/can1357/oh-my-pi/pull/18737) by [@will-bogusz](https://github.com/will-bogusz))
- Cmux browser helpers now use the active browser call's remaining time instead of cutting long evaluations off at the socket's 30-second default or giving late helpers a fresh full timeout; cancelling discards queued helpers and interrupts active socket requests so later calls can proceed ([#18737](https://github.com/can1357/oh-my-pi/pull/18737) by [@will-bogusz](https://github.com/will-bogusz))
- MCP tools called through `write` to `xd://` devices now honor their device names in `model.toolCallLoopGuard.exemptTools`, in both the main agent and advisor ([#18860](https://github.com/can1357/oh-my-pi/issues/18860))
- `computer.close()` no longer disables desktop control for the rest of the session: the next `computer` call opens a fresh desktop session instead of failing with `Computer session is closed`
- An extension provider with an `oauth.modifyModels` hook no longer loads the whole model catalog at registration while that provider has no login ([#18821](https://github.com/can1357/oh-my-pi/pull/18821) by [@iliaal](https://github.com/iliaal))
- Saving each session entry no longer blocks the UI for several milliseconds on Windows, where on-access scanning delayed the two re-opens of the session file that every write performed ([#18819](https://github.com/can1357/oh-my-pi/pull/18819))
- A `retry.fallbackChains` model key written with a dotted revision (`anthropic/claude-sonnet-5.5`) now applies to the model it names ([#18951](https://github.com/can1357/oh-my-pi/pull/18951) by [@wolfiesch](https://github.com/wolfiesch))
- Sharpshooter consolidation no longer gets stuck retrying every minute once the memory files grow large: the output budget now fits three full files, a cut-off reply is reported as truncated instead of `must call replace_memory_files exactly once`, and failed runs back off (one interval, doubling up to 6 hours) ([#18938](https://github.com/can1357/oh-my-pi/issues/18938))
- The advisor now backs off between failed turns (doubling per failure, with jitter) and waits for a provider `Retry-After` hint, instead of retrying every second in step with other sessions ([#18957](https://github.com/can1357/oh-my-pi/pull/18957) by [@joshuaswarren](https://github.com/joshuaswarren))
- In ACP mode, an `ask` form the client fails to show (e.g. a JSON-RPC `-32602` for an unsupported field) now returns the client's error to the agent instead of reporting `Ask tool was cancelled by the user` and aborting the turn ([#18887](https://github.com/can1357/oh-my-pi/issues/18887))
- `omp update` runs mise, Homebrew, bun, and npm on the terminal's own output, so their progress bars redraw in place instead of printing every frame as a new line ([#18874](https://github.com/can1357/oh-my-pi/pull/18874) by [@a-glapinski](https://github.com/a-glapinski))
- Fixed Anthropic prompt caching freezing for the rest of a turn when a `context` extension rewrites messages the same way on every request (for example a stable tag prefix on each message): every rewritten message was marked per-call, so the rolling breakpoint could not land on anything the tool loop appended and each step re-billed the whole tail as uncached input. A rewritten message is now per-call only once its bytes differ from the previous request; streamed assistant messages are no longer marked per-call just because `structuredClone` dropped their streaming symbols ([#12392](https://github.com/can1357/oh-my-pi/issues/12392), [#18869](https://github.com/can1357/oh-my-pi/pull/18869) by [@tsankotsanev](https://github.com/tsankotsanev))

### Removed

- Removed `task.file` and the task tool's `taskFile` field; subagent instructions are always inline
- Todo tasks can no longer be blocked: the `blocked` status and `blocker` note are gone from the `todo` tool, `/todo edit` (`[!]` is now an unknown marker), the HUD, ACP plans, goal continuation (which no longer pauses on a blocked-only list) and the RPC `TodoStatus`/`TodoItem` wire types and SDKs (Go, Python, Rust). A saved todo list that still holds a blocked task reads back with it pending on resume

## [18.19.0] - 2026-11-12

### Breaking Changes

- Changed the browser `open` API: `ignore_https_errors` is now `insecure`, `allow_file_access` has been removed, and `file:` pages can access other local files.
- Changed the browser `open` and `targets` `app` option from an object to a string or CDP endpoint/executable path. Use `argv` instead of `app.args` and the top-level `target` instead of `app.target`.
- Removed `task.file` and the task tool's `taskFile` field; subagent instructions must now be provided inline.
- Removed blocked todo tasks and the `blocked` status/blocker metadata. Existing blocked tasks are restored as pending.

### Added

- Added `systemPromptTemplates`, which maps model-selector patterns to Handlebars template files for customizing system prompts. Templates re-render when switching models, with warnings and fallback to the bundled prompt for missing or invalid templates.
- Added ordered multi-step tasks through `task.steps`. Subagents receive steps sequentially, and the final step determines the task result; interrupted tasks resume with their remaining steps.
- Added Liquid AI judge models `liquid/d1.1` and `liquid/d1-ultra`, including image resizing for Liquid's request limits.
- Added per-step progress, state, and duration reporting for GitHub Actions watches, with expandable details and native Tern Surface Protocol views.
- Added `task.autoParallel` (`off`, `suggest`, or `on`) to identify subtasks that can run concurrently and optionally delegate them in a single parallel task call.
- Added portable `awk`, `tar`, `lsof`, `shasum`, `md5`, and `strings` support to the `bash` tool, including Windows support and internal-URI paths.

### Changed

- Browser sessions now prefer the bundled ABKit WebKit engine when available, with automatic installation and SHA-256 verification. WebKit provides headed, user-visible tabs and broader browser compatibility; Chromium remains the fallback and can be selected explicitly with `app: "chromium"`, while `app: "webkit"` requires WebKit. Configure this behavior with `browser.webkit` and `browser.webkitPath` or the corresponding environment variables.
- Browser visibility controls now show or hide WebKit tab windows immediately. Headed WebKit tabs can be interacted with directly, while Chromium tabs retain their existing mode-switching behavior.
- In Tern environments with native DOM access, browser observation and interaction use trusted native input across frames and closed shadow roots, with caret-aware typing and case-insensitive text selectors.
- `edit.modelVariants` now uses the longest matching model pattern, so specific patterns take precedence over generic ones regardless of configuration order.
- The `ask` tool now submits the form's current values when its timeout expires; updated settings and documentation reflect this behavior.
- The `read` tool loads detailed format selectors and URI sub-path syntax on demand, reducing the default request description while retaining inline details when `read` is disabled.
- The default system prompt and tool descriptions have been streamlined, with guidance moved closer to the tools and detailed task/procedure references provided when relevant.
- The `bash` pseudo view renders words built from literals and expansions as f-strings (`f"repos/org/{r}/rulesets"`) instead of `concat(...)` calls.

### Fixed

- Fixed `computer.close()` so subsequent computer-control calls start a fresh desktop session instead of failing.
- Fixed extension providers with `oauth.modifyModels` so they do not load the full model catalog before login.
- Fixed resuming sessions so it no longer scans unrelated later session transcripts.
- Fixed session saving on Windows to avoid UI stalls caused by repeated session-file access.
- Fixed automatic chart selection so generated charts use compatible data and chart types.
- Fixed `bash` previews for `env -i` commands so they display the requested command rather than generated shell setup code.

## [18.18.9] - 2026-11-11

### Added

- Added Sofya as a web search engine (`web/sofya`), using `SOFYA_API_KEY` or a stored `sofya` credential ([#18185](https://github.com/can1357/oh-my-pi/pull/18185) by [@yusufgurdogan](https://github.com/yusufgurdogan))
- Documented autoresearch mode in [docs/autoresearch.md](https://github.com/can1357/oh-my-pi/blob/main/docs/autoresearch.md): activation and its git gates, the three stop conditions, the per-segment iteration cap that defaults to none, the harness `METRIC`/`ASI` contract, and the on-disk store that `OMP_AUTORESEARCH_DB_DIR` relocates ([#18655](https://github.com/can1357/oh-my-pi/pull/18655) by [@sjawhar](https://github.com/sjawhar))
- Extensions can import the form theme, the native span helpers (`styledSpans`, `compactText`, `rowsText` and the rest of the ANSI/span conversions), the `xd://` URL helpers (`parseXdUrl` and friends) and the `cfgExtensionTranscriptPresenters` setting handle from `@oh-my-pi/pi-coding-agent` instead of internal module paths, which stop the extension from loading when a file moves ([#18849](https://github.com/can1357/oh-my-pi/pull/18849) by [@materemias](https://github.com/materemias))
- `/context` shows loaded instruction files and skills in their own categories; System Prompt marks where each one sits without counting it twice, and notes when an extension or SDK callback changed the prompt after it was built ([#17971](https://github.com/can1357/oh-my-pi/pull/17971) by [@c-w-z](https://github.com/c-w-z))
- Added Hacker News search (`web/hackernews`): `web_search` queries scoped to `site:news.ycombinator.com` now search HN stories and comments through the keyless HN Search API before the configured engines

### Changed

- A role edit in another omp instance no longer rewrites the `task` and `eval` tool descriptions of every running session, which was invalidating the Anthropic prompt cache from the tool definitions onward and dropping signed thinking blocks on prefix-bound models; the per-call model advertisement is now frozen into the base prompt surface and changes only when that surface rebuilds ([#18716](https://github.com/can1357/oh-my-pi/issues/18716), [#18732](https://github.com/can1357/oh-my-pi/pull/18732) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Agent-to-agent messages now always reach the recipient as user turns: one that ends a `wait` arrives right after it instead of inside the `wait` tool result, and none is sent with developer or system authority
- Launch services now persist for non‑interactive sessions
- The shell's built-in `jq` now behaves like jq 1.8.2 instead of jaq: the same output (number formatting, colors, `-S`, `--indent`, `--seq`, `--stream`), error messages and exit statuses, jq's full option set (`--version` reports `jq-1.8.2`), and its grammar and builtins (`?//`, `$__loc__`, modules, `getpath`/`setpath` creating missing paths, `|=` deletions, Oniguruma regexes, dates); it passes jq 1.8.2's own test suite

### Fixed

- Nix builds with `withAppleFm = false` no longer compile the Apple Foundation Models bridge with the host's Xcode ([#18911](https://github.com/can1357/oh-my-pi/pull/18911))
- Apple Silicon Nix builds include Apple Foundation Models support instead of silently building without it ([#16584](https://github.com/can1357/oh-my-pi/pull/16584) by [@honsunrise](https://github.com/honsunrise))
- On Windows, the bash tool runs external commands when omp itself runs in an AppContainer sandbox, instead of failing every one with `Permission denied` (exit 126) ([#18800](https://github.com/can1357/oh-my-pi/pull/18800) by [@devjay4561](https://github.com/devjay4561))
- Explicit Bash prompt rules remain enforced in yolo mode when a command also matches a critical pattern ([#18788](https://github.com/can1357/oh-my-pi/pull/18788) by [@jasonharrison](https://github.com/jasonharrison)).
- Fixed job widgets and captions failing outright when the `widget` model errors: they now try the role's next model (`retry.fallbackChains.widget`, else the built-in `smol` defaults) and fail only once every candidate has ([#18793](https://github.com/can1357/oh-my-pi/issues/18793))
- Failed job-widget, job-caption, cache-warm, composer-prediction, and subagent completion-probe calls now keep the provider's error message in their session usage records ([#18792](https://github.com/can1357/oh-my-pi/issues/18792))
- `/changelog`, `/changelog full`, and `/changelog last N` now list releases newest-first, matching `CHANGELOG.md` and the startup release notes ([#18809](https://github.com/can1357/oh-my-pi/issues/18809))
- Fixed a `read` placed after a `bash` call in the same message returning the file as it was before that command changed, created or deleted it, in primary and advisor turns ([#16274](https://github.com/can1357/oh-my-pi/pull/16274) by [@will-bogusz](https://github.com/will-bogusz))
- RPC/ACP `/session delete` now switches the live session before deleting its file, so later turns save to a new, resumable session ([#18665](https://github.com/can1357/oh-my-pi/issues/18665)).
- Browser `tab.click`, `tab.dblclick`, `tab.check`, `tab.uncheck`, `tab.uploadFile` and `frame.click` on Chromium tabs now look their selector up again when the page replaces the element before the click goes out, including during and after delivery watcher setup, instead of waiting out the action timeout on the replaced element; a click through an element handle or an `aria-ref` whose element was replaced fails at once ([#18676](https://github.com/can1357/oh-my-pi/pull/18676) by [@will-bogusz](https://github.com/will-bogusz))
- A browser `tab.run` whose code uses `document`, `window`, `location` or another page-only global now says the code runs in omp's runtime, not the page, and to use `tab.evaluate`, instead of only "document is not defined" ([#18840](https://github.com/can1357/oh-my-pi/pull/18840) by [@will-bogusz](https://github.com/will-bogusz))
- JavaScript eval cells and `tab.run`/`computer.run` strings ending in assignments, blocks, loops, or declarations now return nothing; trailing expressions and explicit returns still produce values ([#18865](https://github.com/can1357/oh-my-pi/pull/18865) by [@will-bogusz](https://github.com/will-bogusz))
- A page calling `window.print()` no longer hangs the browser omp launches: `print()` returns at once and `tab.pdf()` still makes PDFs ([#18838](https://github.com/can1357/oh-my-pi/pull/18838) by [@will-bogusz](https://github.com/will-bogusz))
- `tab.select()` and element-handle `select()` return the options selected after the page's `input` and `change` handlers ran, instead of the choice the page then reset (Chromium tabs) or an option the page's handler had just replaced (cmux and Tern tabs) ([#18829](https://github.com/can1357/oh-my-pi/pull/18829) by [@will-bogusz](https://github.com/will-bogusz))
- `tab.waitForDownload()` fails, naming the path it looked for, when no file is there on omp's machine, as with a browser reached through `app.cdp_url` on another machine, instead of returning a path that does not exist; such a download is left out of `tab.downloads()` ([#18830](https://github.com/can1357/oh-my-pi/pull/18830) by [@will-bogusz](https://github.com/will-bogusz))
- When Chrome detaches omp from a relay tab omp opened and omp cannot reattach, the error now says omp tried to close that tab and to open a new one, instead of telling the agent to navigate it in Chrome; a failed close may be deferred until the relay reconnects ([#18832](https://github.com/can1357/oh-my-pi/pull/18832) by [@will-bogusz](https://github.com/will-bogusz))
- A relay `app.target` that matches no tab now recommends omitting `app.target` to open omp's own tab ([#18833](https://github.com/can1357/oh-my-pi/pull/18833) by [@will-bogusz](https://github.com/will-bogusz))
- Judgments skip a judge candidate for five minutes after it answers 404 for its model, as they already do after a 401/402/403, instead of re-sending the failing request on every judgment of a `find` call ([#18854](https://github.com/can1357/oh-my-pi/issues/18854))
- Fixed Tern and other OSC 7501 terminals showing a session as `working`, with no needs-you alert, while a dialog waits on you, such as a `ctx.ui.confirm` an extension's `tool_call` handler opens to gate a command: every dialog the TUI shows (extension and hook dialogs, tool approvals, `ask`, `cfg://` changes, the coding-plan reserve confirm, plan review) now reports `blocked` with what it asks until you answer, and a tool approval reports `working` again as soon as you answer it ([#15107](https://github.com/can1357/oh-my-pi/issues/15107), [#18868](https://github.com/can1357/oh-my-pi/pull/18868) by [@wolfiesch](https://github.com/wolfiesch))
- The shell's built-in `jq` no longer slows down quadratically on repeated updates such as `reduce range(n) as $i ([]; . + [$i])`
- `/tan` completion notices now quote the user's request and mark the result as the user's tangent, so the main agent no longer mistakes it for its own work
- `omp zsh` with zsh-autosuggestions' `completion` strategy no longer echoes each typed key onto new lines: `vared` inside a `zpty` command now edits on the pty instead of the shell's terminal
- An instruction file that leaves a code fence open has it closed at its end, so the rest of the system prompt is formatted as usual ([#17971](https://github.com/can1357/oh-my-pi/pull/17971) by [@c-w-z](https://github.com/c-w-z))
- Read-only activity stays visible after snap-compaction or another mid-turn transcript rebuild instead of leaving the UI stuck on “Working…” ([#18876](https://github.com/can1357/oh-my-pi/pull/18876) by [@JustasMasiulis](https://github.com/JustasMasiulis)).
- With the Spotlight experiment on, a session now warns when Spotlight finds no Stencil credential, once each time the credential goes missing, and says how to sign in again; the `spotlight:shape` journal entry records failed Spotlight calls by cause (`failureCauses`) ([#18850](https://github.com/can1357/oh-my-pi/pull/18850) by [@wolfiesch](https://github.com/wolfiesch))

### Removed

- Removed `/mcp smithery-search`, `/mcp smithery-login` and `/mcp smithery-logout`; Smithery shut down its API on October 31, 2026 ([#18822](https://github.com/can1357/oh-my-pi/pull/18822) by [@samettemizer](https://github.com/samettemizer))

## [18.18.8] - 2026-11-11

### Changed

- `curl -fsSL https://omp.sh/install | sh` and `install.ps1` now install the standalone binary by default, even when bun is present, so installs get delta updates; pass `--source`/`-Source` for a bun package install
- Ask forms can attach notes to selected options; those notes accompany the answers separately from submitted form values ([#18779](https://github.com/can1357/oh-my-pi/pull/18779) by [@Shadorain](https://github.com/Shadorain))

### Fixed

- Claude auto-redeem now spends a full saved reset on an account blocked by its weekly limit when the reset also clears the Fable cap; such resets were treated as Fable-only and skipped while Fable usage had room ([#18801](https://github.com/can1357/oh-my-pi/pull/18801))
- Fixed agents showing as idle in the Agent Hub while still running after a failed streaming edit preview (`edit.streamingAbort`) auto-recovered the turn ([#18790](https://github.com/can1357/oh-my-pi/pull/18790) by [@H4vC](https://github.com/H4vC))
- A browser call on a tab that is not open now says to open it with `await browser.open({ name })` (Python: `await browser.open(name=…)`) and the url and app it was opened with, instead of pointing at the removed `action:"open"` ([#18739](https://github.com/can1357/oh-my-pi/pull/18739) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `computer.window({ app })` and `computer.windows({ app })` matching similarly named apps when the exact app name has an open window, such as Google Chrome alongside Google Chrome for Testing ([#18744](https://github.com/can1357/oh-my-pi/pull/18744) by [@will-bogusz](https://github.com/will-bogusz))
- In Tern, browser `role/` selectors keep input roles and names under Turkish and Azeri locales ([#18658](https://github.com/can1357/oh-my-pi/pull/18658) by [@will-bogusz](https://github.com/will-bogusz))
- Chrome `role/RootWebArea` waits with `visible` return the document instead of failing, and `hidden` waits keep waiting ([#18658](https://github.com/can1357/oh-my-pi/pull/18658) by [@will-bogusz](https://github.com/will-bogusz))
- An `omp -p` or other omp that your session's bash tool or eval cell starts inside Tern or cmux no longer picks Tern or cmux from the pane it inherited, so its browser tabs stop floating over your pane ([#18773](https://github.com/can1357/oh-my-pi/pull/18773) by [@will-bogusz](https://github.com/will-bogusz))
- Browser relay connections sharing a tab no longer lose cross-site frames when another connection disables auto-attachment on its page; automatic children detach locally when their last armed page leaves, while explicitly attached frame subtrees remain usable after opting out ([#18657](https://github.com/can1357/oh-my-pi/pull/18657) by [@will-bogusz](https://github.com/will-bogusz))
- Browser agents now say when a step can't be done through the page, instead of patching the page with scripts and reporting the step as done ([#18761](https://github.com/can1357/oh-my-pi/pull/18761) by [@will-bogusz](https://github.com/will-bogusz))
- An extension's `assistant_message` rewrite now reaches the next Codex Responses request: same-model native replay used to resend the captured original text while the transcript showed the rewritten one ([#18312](https://github.com/can1357/oh-my-pi/issues/18312))
- MCP reconnects and tool-list refreshes now keep extension-deactivated tools inactive while enabling newly discovered tools ([#18678](https://github.com/can1357/oh-my-pi/issues/18678)).
- Exiting after aborting a `bash` command now waits for its TERM-resistant foreground processes to be killed ([#18669](https://github.com/can1357/oh-my-pi/issues/18669)).
- An `edit` touching several files that anchors lines no read displayed now reveals those lines for every file in one rejection, so the identical resend applies instead of being rejected again for the next file ([#18742](https://github.com/can1357/oh-my-pi/pull/18742) by [@MaisonnatM](https://github.com/MaisonnatM))
- `omp auth-gateway stdio` now serves judge, image, speech, embedding, rerank and video models: `/v1/models` lists them, and `/v1/systemone` answers `typesafe/jev-*` or `@judge` instead of 404, or 422 from a chat model ([#18740](https://github.com/can1357/oh-my-pi/pull/18740) by [@andyhite](https://github.com/andyhite))
- `omp auth-gateway stdio` no longer cuts its last responses off at 128 KiB when its input ends before a slow reader has read them ([#18740](https://github.com/can1357/oh-my-pi/pull/18740) by [@andyhite](https://github.com/andyhite))
- `omp --session <id> --restore` restores that session, as `omp --restore --session <id>` does, instead of opening the session picker: a bare `--restore` keeps a session `--session` or `--resume` already named ([#18685](https://github.com/can1357/oh-my-pi/pull/18685) by [@AdamDureyAtWillship](https://github.com/AdamDureyAtWillship))
- The legacy Pi virtual module now builds in an npm install that keeps the bundled Pi packages nested: it is anchored to the installed package, so its imports resolve through that package's own dependency graph ([#15208](https://github.com/can1357/oh-my-pi/issues/15208), [#18733](https://github.com/can1357/oh-my-pi/pull/18733) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- User-level agents, commands, and other `~/.omp/agent` config (including agents saved from the agents hub) now follow `PI_CODING_AGENT_DIR`, matching where `omp agents unpack` writes ([#18684](https://github.com/can1357/oh-my-pi/issues/18684))
- Fixed `grep` and `glob` treating a `;` list that starts with an internal URL and includes a local path, such as `artifact://1;notes.txt`, as one address; each listed target is now searched ([#18714](https://github.com/can1357/oh-my-pi/pull/18714) by [@eggpeat](https://github.com/eggpeat))
- Isolated tasks that edit a file whose name contains spaces now commit that file, including in a nested git repository, instead of leaving it unstaged or committing a different file that shares part of the name ([#18715](https://github.com/can1357/oh-my-pi/pull/18715) by [@eggpeat](https://github.com/eggpeat))
- A disposed or switched session now releases every persistent shell it owns, including the ones a surface keeps under a name of its own (`/loop` conditions), instead of holding one native shell per surface for the life of the process ([#18717](https://github.com/can1357/oh-my-pi/pull/18717) by [@eggpeat](https://github.com/eggpeat))

## [18.18.7] - 2026-11-10

### Added

- `/usage` and `omp usage` show LiteLLM key and user budgets for the built-in `litellm` provider and every models.yml provider with `discovery.type: litellm`, unless listed in `disabledProviders` ([#17873](https://github.com/can1357/oh-my-pi/pull/17873) by [@maykonmichel](https://github.com/maykonmichel))
- Extensions can ask the operator before an interactive quit, or cancel it, with `session_before_shutdown`; a further `/exit` or Ctrl+D skips the pending prompts and closes ([#18424](https://github.com/can1357/oh-my-pi/pull/18424) by [@aw1cks](https://github.com/aw1cks))

### Changed

- Saved-reset auto-redeem is set per window: `codexResets.autoRedeem5h`/`autoRedeemWeekly` and `claudeResets.autoRedeem5h`/`autoRedeemWeekly`/`autoRedeemFable` replace each provider's `autoRedeem`, whose value migrates into the 5h and weekly keys; a Claude Fable launch reset is governed by `autoRedeemFable` alone and spent only for a block that includes the Fable weekly cap, or before expiry when Fable usage is above zero ([#18661](https://github.com/can1357/oh-my-pi/pull/18661) by [@TheAifam5](https://github.com/TheAifam5))
- Sessions without a prompt UI (such as `omp -p`) no longer spend saved resets while auto-redeem is `unset`, even ones about to expire ([#18661](https://github.com/can1357/oh-my-pi/pull/18661))
- Google Antigravity is back in `/login` and `omp login`, marked "(at your own risk)": a new login first explains that Google may suspend accounts that sign in from third-party tools and continues only after you type `yes`; saved Antigravity logins work again ([#18499](https://github.com/can1357/oh-my-pi/issues/18499))
- On Windows, the bash tool's description tells the model it runs in an emulated bash environment, not cmd or PowerShell, so it writes bash instead of `dir`, `%VAR%` and other cmd syntax

### Fixed

- Extension prompts shown from `session_before_*` handlers no longer time out after 30 seconds while the operator is still answering ([#18424](https://github.com/can1357/oh-my-pi/pull/18424) by [@aw1cks](https://github.com/aw1cks))
- A second exit request now skips pending `worktree.onExit` prompts and keeps those worktrees instead of waiting for an answer ([#18424](https://github.com/can1357/oh-my-pi/pull/18424) by [@aw1cks](https://github.com/aw1cks))
- Advice that makes the agent keep working after it finished no longer comes back a second time, often as a blocker, while the agent is fixing it: advisor reviews of the earlier answer are cancelled and the advisor reviews the fix instead ([#18735](https://github.com/can1357/oh-my-pi/pull/18735) by [@H4vC](https://github.com/H4vC))
- On Windows, the bash tool's shell resolves MSYS drive paths (`/c/Users/...`, `/mnt/c/...`) everywhere, so running `/c/.../tool.exe`, `cd /c/...`, `[ -f /c/... ]` and `< /c/...` reach drive C: like they already did for `ls` and other built-in utilities
- On Windows, cmd-style command lines such as `dir | find /c /v ""`, `sort /r`, `timeout /t 5` and `whoami /all` in the bash tool run the Windows programs they were written for, instead of pi's GNU-style `find`/`sort`/`timeout`/`whoami` (which read `/c` as drive C: and could walk the whole drive)
- Changing or unsetting `PATH` in the bash tool's shell now forgets remembered command locations, as bash does, so a command no longer runs from a directory that has left `PATH`
- One slow or flooding collab guest no longer ends sharing for the room: the host drops that guest's backlog and asks it to rejoin, sessions larger than the send budget can be joined, and guest questions nobody received settle as unavailable ([#18629](https://github.com/can1357/oh-my-pi/pull/18629) by [@iliaal](https://github.com/iliaal))

## [18.18.6] - 2026-11-09

### Added

- In Tern, a turn's long-press menu on a phone can edit and resend a prompt, retry the turn, open the rewind page on it, or fork the session from it into a new session
- A rewind from the transcript says how many turns it dropped and offers Undo on its toast in Tern, which puts the turns and your draft back

### Changed

- Browser `role/` selectors in Chrome tabs now match the role and name Chrome's accessibility tree reports, so they reach open shadow roots and skip hidden elements; in Tern every name `observe()` reports selects its element again ([#18632](https://github.com/can1357/oh-my-pi/pull/18632) by [@will-bogusz](https://github.com/will-bogusz))

### Fixed

- A late usage-limit error from a previous provider no longer blocks or cools down the selected provider; when the old provider has spent its retry budget, a replay-safe turn still tries the selected model without the old quota delay ([#17098](https://github.com/can1357/oh-my-pi/issues/17098), [#17571](https://github.com/can1357/oh-my-pi/pull/17571) by [@Bensonluo](https://github.com/Bensonluo))
- Multi-question ask forms in Tern show Submit on the last question tab, not only on the Review tab
- MCP `headers` and stdio `env` values that use `!command` now run again on a 401/403 (the request is retried once), on `/mcp reconnect` and other reconnects, and on `/mcp reload`, so servers whose command mints short-lived tokens keep working past expiry instead of staying 401 until restart ([#18631](https://github.com/can1357/oh-my-pi/issues/18631))
- Pausing an unapproved plan no longer tells the agent that the draft was approved or to continue executing it, and pausing with `/plan` closes an open plan review so it can no longer save and execute the plan ([#18610](https://github.com/can1357/oh-my-pi/issues/18610)).
- Turning off `lsp.enabled` now also stops `write` and `edit` from starting language servers for diagnostics or formatting; previously only the `lsp` tool was disabled ([#18205](https://github.com/can1357/oh-my-pi/issues/18205), [#18490](https://github.com/can1357/oh-my-pi/pull/18490) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Fixed background tabs omp borrows (relay `app.target`, `app.cdp_url`) ignoring omp's clicks and keys or timing out on hover and drag; the page reads as visible while omp drives it and hidden again once released ([#17831](https://github.com/can1357/oh-my-pi/pull/17831) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the transcript jumping at the screen's top edge while scrolled back during a streamed reply, and the screen dropping two rows when a reply finished ([#12307](https://github.com/can1357/oh-my-pi/issues/12307), [#16117](https://github.com/can1357/oh-my-pi/pull/16117) by [@galtamam-cmyk](https://github.com/galtamam-cmyk))
- Focusing a subagent or returning to the main session no longer loses or freezes the next assistant reply when a fast tool turn finishes before the previous reply's links finish resolving, and messages and tool runs that arrive during the switch show exactly once, in order ([#18564](https://github.com/can1357/oh-my-pi/pull/18564) by [@eggpeat](https://github.com/eggpeat))
- `omp gc --strip` now keeps every response of the latest replay turn (including earlier tool-call steps joined by their tool results), reference-only images, and the transcript's file permissions ([#18636](https://github.com/can1357/oh-my-pi/pull/18636) by [@eggpeat](https://github.com/eggpeat))
- Session files whose entries were written without ids are re-indexed when loaded, and migrating old sessions no longer gives two entries the same id ([#18636](https://github.com/can1357/oh-my-pi/pull/18636) by [@eggpeat](https://github.com/eggpeat))
- `wait` and `write proc://<id>/kill` now say how a settled job's result reached the caller: delivered by the call itself (it finished while the call ran), handed over by this snapshot (it superseded the job's queued completion push, so no duplicate follows), or genuinely late — the last keeps its "not auto-delivered; recovered by this snapshot" warning and adds how long before the call it had finished ([#16052](https://github.com/can1357/oh-my-pi/issues/16052), [#18635](https://github.com/can1357/oh-my-pi/pull/18635) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Fixed `ask` notes added with `n` right after picking an answer landing on the previous question instead of the one shown; a Tern click then Note still notes the answer just clicked, and the Note button names it ([#18317](https://github.com/can1357/oh-my-pi/pull/18317) by [@DonMikone](https://github.com/DonMikone))

## [18.18.4] - 2026-11-09

### Added

- SDK: `PromptOptions.followUps` queues prompts to run after the prompt, in order; if the prompt never reaches the agent they come back with it in `DroppedPrompt.followUps`

### Changed

- The `task` tool no longer advertises a per-call `model` field unless `task.perCallModel` is `on` or the bundled seance is spawnable; a `model` sent anyway is still refused before dispatch ([#18554](https://github.com/can1357/oh-my-pi/pull/18554) by [@xiangnan0811](https://github.com/xiangnan0811))

### Fixed

- `/usage`, session statistics, and `omp stats` now include session title spend from both the default fork title and the tiny title model, and tiny-model titles count toward `--max-cost` ([#18177](https://github.com/can1357/oh-my-pi/issues/18177), [#18491](https://github.com/can1357/oh-my-pi/pull/18491) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Retries after `--model pi/<role>` (or `@<role>`, `<role>`) now walk that role's `retry.fallbackChains` entry instead of the `default` chain, including on `--continue` ([#18389](https://github.com/can1357/oh-my-pi/issues/18389), [#18534](https://github.com/can1357/oh-my-pi/pull/18534) by [@harshaygadekar](https://github.com/harshaygadekar))
- Fixed a `->` / `=>` list sent to an idle session running its second item before its first; if the first item can't start (Esc, a refused or failed setup), the whole list goes back to the editor ([#10802](https://github.com/can1357/oh-my-pi/issues/10802))
- Fixed auto-compaction repeating every turn when the system prompt and tool schemas alone exceed the compaction budget; it now warns once instead ([#18589](https://github.com/can1357/oh-my-pi/issues/18589)).
- Fixed a blank per-call `model` (`""` or whitespace) failing the gate for task calls, eval `agent()` and eval `workpool()` instead of using the agent's configured model ([#18576](https://github.com/can1357/oh-my-pi/pull/18576) by [@iwangjie](https://github.com/iwangjie))
- `task` tool calls with an empty model string or empty model array now use the agent's normal model routing ([#18554](https://github.com/can1357/oh-my-pi/pull/18554) by [@xiangnan0811](https://github.com/xiangnan0811))
- Fixed `todo append` without a phase failing instead of adding tasks to the active phase, the last phase, or a new `Tasks` phase ([#17265](https://github.com/can1357/oh-my-pi/issues/17265), [#18575](https://github.com/can1357/oh-my-pi/pull/18575) by [@taotao7](https://github.com/taotao7)).
- Learned-only memory guidance no longer tells the model to read a missing `memory_summary.md` ([#18523](https://github.com/can1357/oh-my-pi/pull/18523) by [@nick-maderight](https://github.com/nick-maderight)).
- A `wait` that times out now says how long it waited and how long a back-to-back wait allows, instead of returning a bare still-running snapshot that agents read as an empty result, and the back-to-back reminder tells agents not to start `sleep` jobs to wait longer ([#18612](https://github.com/can1357/oh-my-pi/pull/18612) by [@alphastorm](https://github.com/alphastorm)).
- `auth-gateway stdio` now follows a role's configured fallback chain even when `modelRoles` does not set the role (a chat role without its own chain inherits the `default` chain) ([#18509](https://github.com/can1357/oh-my-pi/pull/18509) by [@enieuwy](https://github.com/enieuwy))
- In the Pseudo shell visualization, a `;`-separated chain no longer draws its statement separators as rows of their own, so `echo a; echo b` reads as two statements ([#18258](https://github.com/can1357/oh-my-pi/issues/18258), [#18497](https://github.com/can1357/oh-my-pi/pull/18497) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Autoresearch `update_notes` with `append_idea` now creates an `## Ideas` section instead of inserting the bullet before the first heading when notes contain only a similarly named heading such as `## Ideas backlog` or `### Ideas` ([#18505](https://github.com/can1357/oh-my-pi/pull/18505) by [@eggpeat](https://github.com/eggpeat))
- Exclusive tools (`edit`, `write`, `eval`, …) called as Cursor MCP tools now keep their place in the tool batch, so a check sent right after an edit sees the new file and an edit no longer starts before an earlier read finishes ([#18502](https://github.com/can1357/oh-my-pi/pull/18502) by [@eggpeat](https://github.com/eggpeat))
- Quarantined Hindsight memories are now deleted once their 30-day review period ends even when no new memory is quarantined ([#18504](https://github.com/can1357/oh-my-pi/pull/18504) by [@eggpeat](https://github.com/eggpeat))
- The compaction display summary no longer requests reasoning, so thinking models return a summary instead of spending the 512-token cap on reasoning and returning nothing ([#18541](https://github.com/can1357/oh-my-pi/pull/18541) by [@phillipxkang](https://github.com/phillipxkang))
- Retries on the same model now stop after three consecutive generic aborts instead of spending the whole retry budget ([#18535](https://github.com/can1357/oh-my-pi/pull/18535) by [@nick-maderight](https://github.com/nick-maderight))
- `lsp.formatOnWrite` no longer re-indents 2/4-space files at 1 space per level when they contain JSDoc/block comments or one-off odd indents, and no longer converts tab-indented files that open with a JSDoc block to spaces ([#18544](https://github.com/can1357/oh-my-pi/issues/18544))
- Isolated task sandboxes now finish cleanup after a SIGHUP or other signal even when releasing them takes longer than the agent shutdown grace period ([#18519](https://github.com/can1357/oh-my-pi/issues/18519)).

## [18.18.3] - 2026-11-09

### Breaking Changes

- The `ask` tool takes one HTML form (`{ html }`) instead of `questions[]`: the model writes a `<form>` of radios, checkboxes, selects, text inputs and textareas with its recommendation preselected, and receives the submitted form data as JSON. `AskToolDetails` is now `{ answers: { name, question, answer }[]; timedOut? }`; `QuestionResult`, the "Other", "Chat about this", answer-note and answer-image paths of the tool are removed, and `/tree` re-answer reopens the original form (`NavigateTreeResult.reopenAsk` carries `html`).

### Added

- In Tern, right-clicking an `ask` answer offers Note, which annotates that answer without picking it ([#18551](https://github.com/can1357/oh-my-pi/pull/18551) by [@H4vC](https://github.com/H4vC))
- `task.eager` (`preferred`/`always`) now shapes only the main agent's system prompt; subagents fall back to their model's own delegation policy instead of being pushed to spawn further subagents
- `ask` forms can show pictures: `<img src>` from an http(s) URL, a `data:` URI or a local file (relative to the session's working directory), and inline `<svg>` diagrams, drawn in the terminal form and natively in Tern
- `ask` forms give every radio and checkbox group a free-text "Other" answer: its text is the radio's value or is appended to the checkbox group's array (field-by-field fallback, collab guests and ACP elicitation included)
- Extension UI gains optional `ui.formDialog(html, options)`, which renders an HTML `<form>` and resolves to `{ data, timedOut? }` (undefined when cancelled). The interactive TUI renders it as a form dialog, ACP clients with form elicitation get one elicitation with a property per field, and hosts without it (RPC) answer the `ask` tool field by field through `select`/`input`/`editor`.
- Eval cells can run shell commands with `sh`: `sh("git status")` in Python, `` await sh`ls ${dir}` `` or `await sh("make", { cwd })` in JavaScript. Commands run on the embedded bash engine to completion (never auto-backgrounded), return their output, and raise `ShellError` with the exit code on failure.
- `omp zsh` on Windows runs omp's builtin utilities (`ls`, `cat`, `head`, `jq`, …) for commands `PATH` does not have, unless a `command_not_found_handler` handles them ([#18532](https://github.com/can1357/oh-my-pi/pull/18532) by [@H4vC](https://github.com/H4vC)).

### Changed

- Clarified tool and internal-URL descriptions for `history://` concise transcripts, `proc://` job retention and parked-agent lookups, and `read` JSON query text output ([#18553](https://github.com/can1357/oh-my-pi/pull/18553) by [@xiangnan0811](https://github.com/xiangnan0811))
- Models without a delegation rule (Claude, Gemini, …) no longer get pushed to delegate: the "map unknown code via task" rule and the "Task + scout" nudges in search tool descriptions are replaced by a light suggestion to explore unfamiliar subsystems with a scout
- In Tern, clicking an `ask` answer and then Note now annotates the answer highlighted on the question shown instead of the one just clicked ([#18551](https://github.com/can1357/oh-my-pi/pull/18551) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed `ask` notes added with `n` right after picking an answer landing on the previous question instead of the one shown; a Tern click then Note still notes the answer just clicked, and the Note button names it ([#18317](https://github.com/can1357/oh-my-pi/pull/18317) by [@DonMikone](https://github.com/DonMikone))
- Fixed `/export` failing on Windows when saving in the current directory, including relative paths such as `sub/../session.html`; the export message now shows the full path of the written file ([#18369](https://github.com/can1357/oh-my-pi/issues/18369), [#18525](https://github.com/can1357/oh-my-pi/pull/18525) by [@minhngoc25a](https://github.com/minhngoc25a)).
- Todo initialization now names empty phases `Tasks`, so subsequent updates can address them ([#18552](https://github.com/can1357/oh-my-pi/pull/18552) by [@xiangnan0811](https://github.com/xiangnan0811))
- `omp zsh` and the bash tool on Windows: background commands without job control ignore Ctrl-C (`INT`, and `QUIT` in zsh) as zsh and bash do, so the console's Ctrl-C leaves them running ([#18532](https://github.com/can1357/oh-my-pi/pull/18532) by [@H4vC](https://github.com/H4vC)).
- `omp zsh` finds the system zsh's function library (`compinit` loads) on Debian, Ubuntu and Arch, and on Windows from an MSYS2, Cygwin or Git for Windows zsh ([#18532](https://github.com/can1357/oh-my-pi/pull/18532) by [@H4vC](https://github.com/H4vC)).
- `omp zsh` on Windows: typed commands no longer end in `^M`, programs are found through `Path`, piped scripts run every line, `cd` takes `C:\…`/`C:/…`, `..` and `~` (keeping `$PWD` as `C:/…`), `>/dev/null` works, the prompt is `%` rather than root's `#`, `$OSTYPE` is `msys`, and no `USERNAME` warning is printed ([#18532](https://github.com/can1357/oh-my-pi/pull/18532) by [@H4vC](https://github.com/H4vC)).
- `omp zsh` on Windows edits lines with ZLE (history, Tab completion, key bindings, `$COLUMNS`); Ctrl-C abandons the line, runs an `INT` trap, or interrupts a `read` that then goes on, instead of ending the shell ([#18532](https://github.com/can1357/oh-my-pi/pull/18532) by [@H4vC](https://github.com/H4vC)).
- `omp zsh` on Windows: Ctrl-C interrupts the foreground program, `jobs`, `fg` and `bg` work (a job brought back with `fg` gets Ctrl-C too), and process substitution reaches Windows programs (`diff <(…) <(…)`, `prog >(…)`) ([#18532](https://github.com/can1357/oh-my-pi/pull/18532) by [@H4vC](https://github.com/H4vC)).
- On Windows, `/dev/null` works in the bash tool (`>/dev/null`, `cat /dev/null`, `[ -c /dev/null ]`) ([#18532](https://github.com/can1357/oh-my-pi/pull/18532) by [@H4vC](https://github.com/H4vC)).
- On Windows, `/dev/tty` opens the console in `omp zsh` and the bash tool (`prog >/dev/tty`), and an MSYS or Cygwin program killed by Ctrl-C reports status 130 instead of 512 ([#18532](https://github.com/can1357/oh-my-pi/pull/18532) by [@H4vC](https://github.com/H4vC)).
- `omp zsh` prints the `[n] pid` line for a background pipeline under job control, as it does for a single command ([#18532](https://github.com/can1357/oh-my-pi/pull/18532) by [@H4vC](https://github.com/H4vC)).
- `omp zsh` starts `compinit` many times faster: single array and association elements are assigned and read without copying the whole parameter, and `autoload -r` no longer re-reads the `.zwc` digests in `$fpath` for every function it resolves ([#18533](https://github.com/can1357/oh-my-pi/pull/18533) by [@H4vC](https://github.com/H4vC)).
- `omp zsh`'s `read -k` and `read -q` read a key from the terminal without waiting for Enter, as zsh does, instead of reading standard input ([#18533](https://github.com/can1357/oh-my-pi/pull/18533) by [@H4vC](https://github.com/H4vC)).
- `omp zsh` completion listings mark file types again (`dir/`, `exe*`), `print -c` lays words out in columns without a terminal, and `${x?msg}` ends a non-interactive shell with status 1 as zsh does ([#18533](https://github.com/can1357/oh-my-pi/pull/18533) by [@H4vC](https://github.com/H4vC)).
- `omp zsh` floats keep full precision in arithmetic (`s=$EPOCHREALTIME; print $(( EPOCHREALTIME - s ))` no longer drifts by up to a second) and still print in their `-F`/`-E` style ([#18533](https://github.com/can1357/oh-my-pi/pull/18533) by [@H4vC](https://github.com/H4vC)).
- `omp zsh`'s `typeset -U path` / `typeset -U fpath` (and `local -U path`) drop repeated entries as zsh does ([#18533](https://github.com/can1357/oh-my-pi/pull/18533) by [@H4vC](https://github.com/H4vC)).
- `omp zsh` and the bash tool: `$!` of a background pipeline is its last program's pid, as in bash and zsh, so `kill $!` signals that program; `omp zsh`'s `[n]` line for a background pipeline lists the pid of each of its processes, as zsh does ([#18547](https://github.com/can1357/oh-my-pi/pull/18547) by [@H4vC](https://github.com/H4vC)).
- `omp zsh` is faster: function calls, loops and arithmetic run 2–3× faster, `compinit` almost 4× faster, and building a large array or association one element at a time (`a+=(x)`, `h[k]=v`) or reading `$a[i]` from a large array no longer slows down with its size ([#18565](https://github.com/can1357/oh-my-pi/pull/18565) by [@H4vC](https://github.com/H4vC)).

## [18.18.2] - 2026-11-08

### Breaking Changes

- `logoutCredential()` now accepts an `AgentSession` instead of a model registry and session ID. Hosts must install a scoped-model refresher with `AgentSession.setScopedModelsRefresher()`; `InteractiveMode` and `InteractiveModeContext` no longer accept `refreshScopedModelsAfterLogin`.
- `SessionStorage.hasAssistantTurn()` is replaced by the optional `scanLines(path, visit)`, which session listings use to recover both a missed assistant record and a first prompt past the 4 KB head; custom storages that implemented `hasAssistantTurn()` must implement `scanLines()` instead.

### Added

- The shell's `ls` builtin supports macOS/BSD `-O`: a long listing gains the file-flags column (`hidden`, `compressed`, `uchg`, `restricted`, …) instead of rejecting the option, so `ls -lO` works and flags are visible again.
- The shell ships `sd` as a builtin, so `sd FIND REPLACE [FILES]…` find-and-replace (regex or `-F` literal, in place or `-p` preview) works without the binary installed.
- Added `omp gc --strip` (or `gc.strip`), which removes provider replay data (thinking signatures, encrypted reasoning, cached native responses, request controls) from sessions idle for `gc.stripAfterDays` (default 30, `--strip-after-days`), including subagent and archived transcripts; stripped sessions still resume on any model.

### Changed

- The `sloppy` edit tool (`*** Find`/`*** Replace`) now rejects only the operations that fail to match and applies the rest, including across files; the result lists each rejected operation against the file as written, and the call fails only when no file changes. Payloads that do not parse still apply nothing.
- A `bash` call that overlaps another one (parallel calls, or a call while one runs in the background) now runs in a copy of the session shell, so it sees the session's variables, functions, options, and working directory from before the other command; what it sets still does not persist.
- The `.`/`c` continue shortcut now interrupts a running turn and continues it, in the main session and in focused subagent views, instead of failing with "Agent is already processing" or doing nothing.
- Updated system prompts with the ⁂ section marker and improved task completion guidance, including proportional verification, efficient file reading, batching independent operations, and stopping after changes are verified.
- Added faster isolated-subagent startup for ovnfs-backed checkouts, while preserving the existing baseline behavior for repositories with nested repositories or submodules.
- Improved extension and plugin management: `/extensions` now lists and toggles extensions from configured extension packages and installed plugins, and marketplace sources resolve relative and bare-name paths consistently with Claude Code.
- Scoped model lists now refresh after logout, model-catalog refreshes, and RPC login or logout, so available models stay synchronized with authentication and provider changes.
- Added source actions to LSP `code_actions`, including actions such as Organize Imports, with application by title or index.
- Browser automation now supports downloads from relay tabs and broader `role/` selectors for implicit landmarks and structural roles.
- Improved skill and session workflows: skills created or installed during a session become immediately discoverable, and user-attributed custom messages that start a turn receive the appropriate prompt setup.
- Validated security findings now display validation status, timestamp, and summary information.
- Dual-mode language servers retain pushed diagnostics alongside pull diagnostics, preserving build and lint errors across edits.
- Improved session navigation and reliability when switches, forks, branches, context resets, or new sessions overlap; requests are processed in order without freezing or misrouting messages.
- Improved eval and interactive execution behavior, including preservation of JavaScript state and output across asynchronous failures, clearer startup and runtime errors, and better reporting when kernels or runtimes terminate.
- Parent-to-subagent messages now appear as IRC cards in live and Agent Hub transcripts.
- Paused agent turns can allow the machine to sleep at safe boundaries and restore sleep prevention when resumed.
- Improved JSON-mode shutdown handling so final tool events and buffered output are preserved.
- Improved task efficiency and responsiveness for isolated subagents, file search, browser guidance on Linux/X11, and long-running or cancellable operations.
- Updated the `tui.mouse` setting documentation to accurately describe wheel-scrolling behavior.
- `mnemopi.dbPath` values beginning with `~` now resolve relative to the home directory.
- Disabling the Codex provider now prevents its configuration from overriding omp settings, and providers can be disabled without applying their other settings.
- `omp gc` now shows a progress bar for each slow step (listing and scanning sessions, scanning transcripts for blob refs, archiving) on interactive terminals.
- `omp gc --strip` and `--compress` start work immediately instead of first reading every session's metadata, and `--strip` processes several sessions at once with a running tally of transcripts stripped.
- `omp gc` without `--apply` now says up front that it is a dry run.

### Fixed

- Fixed `omp --resume` showing `(no messages)` for sessions whose first prompt follows a large memory recall, image-only message, or `/skill:` reply ([#16495](https://github.com/can1357/oh-my-pi/issues/16495))
- In the shell visualization, a running command's inline script, heredoc, or `sh -c`/`ssh` script stays undimmed with the command instead of fading as inactive.
- The shell visualization highlights heredocs and inline scripts behind launchers (`uv run python -`, `timeout 60 python3 -c`, `env … bun -e`, `ssh host 'bash -s' <<EOF`, `ssh host <<EOF`, `docker run … bash -euc`), names a heredoc by its `#!` line or the file it writes (`cat > "$dir/lib.rs"`), and highlights Rust, Go, C-family and Swift heredocs.
- On Windows, commands run by the bash tool, including `nohup` background commands, get a console of their own, so programs that draw directly on the console (xperf and PowerShell progress bars, password prompts) no longer corrupt the TUI ([#18517](https://github.com/can1357/oh-my-pi/pull/18517) by [@H4vC](https://github.com/H4vC)).
- Reading Reddit URLs now works when Reddit blocks its API: posts, comment threads, subreddits, and user pages fall back to a Redlib mirror and then the Arctic Shift archive, and render full nested comment trees.
- Limited xAI `web_search` to two hosted-search turns per request to help prevent unexpected X search costs.
- Fixed extension event delivery so each extension receives events in emission order, even when another extension is slow to process an earlier event.
- `pi.sendUserMessage()` now rejects when a message is dropped before a turn begins, including the cost-cap reason when available.
- Prevented OpenTelemetry settings from omp-managed `.env` files from leaking into child processes or in-process extensions.
- Supervised-service waits now complete only after logs, metadata, and session-owner state have been published.
- Fixed Windows daemon metadata loss when another process temporarily reads `meta.json`.
- Improved image-generation errors to report why each model in a failed fallback chain was unsuccessful.
- Fixed model switching after remote compaction so the destination provider can recover the necessary conversation history instead of receiving only a placeholder summary.
- Remote MCP HTTP and SSE connections now honor `NODE_EXTRA_CA_CERTS` from the agent environment, including certificates loaded after startup.
- Preserved provider prompt-cache reuse across auto-learn captures, skill updates, and other session changes that do not require rebuilding the full system prompt.
- Closing `/btw` history during tool approval now correctly returns focus to the approval prompt.
- URL reads now handle bot-protection challenges more reliably, try alternate user agents, and report blocked or failed results instead of returning a protection page as content.
- Timed-out or cancelled JSON reads now stop their `jq` processing promptly.
- Fixed standalone binaries loading extensions that import top-level `@oh-my-pi/pi-utils` subpaths.
- HUD job status updates now continue to reflect elapsed time instead of freezing until matching output arrives.
- Generic remote compaction now supports `before_provider_request` payload hooks.
- Background completions no longer start hidden turns after an ACP prompt ends or incorrectly leave the session busy.
- Fixed shell behavior for exit status and `EXIT` traps in subshells to match Bash semantics.
- Preserved provider prompt-cache hits when resuming sessions after pruning, rewinding, branching, tree navigation, or other history changes.
- Cursor native edit operations now display accurate edit cards and diffs, including failed edits, instead of misleading separate read/write cards.
- `grep` and `glob` now respect timeout and cancellation when ovnfs status or daemon handshakes stall.
- Fixed `--mode json` shutdowns so tool completion events and the final JSON record are not lost or truncated.
- Commands beginning with `cd /` now execute from the filesystem root as intended.
- Edit auto-repair now accounts for retry costs and stops before exceeding the session cost cap.
- MCP prompt commands now correctly assign positional arguments that follow `key=value` arguments.
- `/shake thinking` now reports and preserves reasoning blocks that the provider continues to replay, avoiding inaccurate context-reduction claims.

## [18.18.1] - 2026-11-08

### Breaking Changes

- Rust SDK: `BashCommand` and `ReadyEvent` struct literals need `exclude_from_context: None` and `supports_bash_exclude_from_context: None` ([#18206](https://github.com/can1357/oh-my-pi/pull/18206) by [@andrebrait](https://github.com/andrebrait))

### Added

- RPC `bash` accepts `excludeFromContext: true` to keep a run out of model context like terminal `!!`; runtimes advertise support with `supportsBashExcludeFromContext` in the `ready` frame, and the Python SDK exposes that frame as `client.ready` ([#18206](https://github.com/can1357/oh-my-pi/pull/18206) by [@andrebrait](https://github.com/andrebrait))

### Changed

- Agent `bash` commands run with `LANG`/`LC_ALL=C.UTF-8` on every platform instead of the inherited locale, so sort order, number formats and tool messages no longer vary by machine; a locale in the command's `env` or `.envrc` still wins, and `!` commands keep yours
- omp's built-in shell (`omp bash`/`omp zsh` and the bash tool) parses scripts about a third faster, sources large function libraries about 20% faster, and re-runs a repeated `eval` or `source` without recompiling it.
- The `computer` tool's `el.perform()` takes any spelling of an action `ax()` lists (`perform("open")`), and `computer.backgroundFallback: refuse` refuses every spelling of a raise, open, context menu or popup press ([#15282](https://github.com/can1357/oh-my-pi/pull/15282) by [@will-bogusz](https://github.com/will-bogusz))
- The `computer` tool no longer takes over your screen for a macOS `win.drag` across the text of a native text view, such as a TextEdit document; it selects that text in the background and returns the selection ([#16223](https://github.com/can1357/oh-my-pi/pull/16223) by [@will-bogusz](https://github.com/will-bogusz))

### Fixed

- A browser relay tab stays usable after a password manager's inline autofill menu opens in it; the call that opened the menu still fails once (reinstall the extension with `omp browser-relay install` and reload it) ([#16908](https://github.com/can1357/oh-my-pi/pull/16908) by [@will-bogusz](https://github.com/will-bogusz))
- A `%%bash` cell in Python eval no longer prints its exit status (a stray `0`) after the command's output; a failing cell reports `%%bash: exit status N` on stderr instead.
- Reusing an already running `omp stats` dashboard now exits successfully without stopping the existing server ([#18443](https://github.com/can1357/oh-my-pi/issues/18443)).
- A function defined inside a command substitution in a here-document body (`cat <<E` / `$(f() { …; }; f)` / `E`) no longer crashes the built-in shell.
- A Cursor tool call sent in the same batch as a native StrReplace or Write no longer runs before the edit is written, so a check right after an edit sees the new file ([#18434](https://github.com/can1357/oh-my-pi/pull/18434) by [@KadirBerkpolat1](https://github.com/KadirBerkpolat1))
- Pinned sessions color their pin icon with the theme accent in the status line and the band composer's title instead of taking the title's color or dim style, matching the resume picker ([#18401](https://github.com/can1357/oh-my-pi/pull/18401) by [@SuperUserA](https://github.com/SuperUserA))
- An ovnfs checkout stays recoverable with `omp worktree clear` when removing it fails, or when creating it fails after the daemon may already have it, instead of being forgotten ([#18337](https://github.com/can1357/oh-my-pi/pull/18337) by [@eggpeat](https://github.com/eggpeat))
- A `retain` call that fails midway no longer delivers part of itself to the Hindsight server while telling the model nothing was queued ([#18440](https://github.com/can1357/oh-my-pi/pull/18440) by [@eggpeat](https://github.com/eggpeat))
- A `bash.patterns` `deny` rule now blocks a command anywhere in a `;`, `|`, `||` or `&&` line even when an earlier `prompt` rule matches another part of it, and project settings can no longer override the operator's `deny` or `prompt` patterns with `allow` ([#18349](https://github.com/can1357/oh-my-pi/pull/18349) by [@asuffield](https://github.com/asuffield))
- A subagent stopped by the session cost cap (`--max-cost` / `session.maxCost`) now reports the cap's refusal instead of "Subagent ended without a final message" ([#18362](https://github.com/can1357/oh-my-pi/issues/18362))
- ERB templates open in ruby-lsp as `erb`, so valid templates no longer report dozens of bogus Ruby errors, and a diagnostics pull ruby-lsp answers with `null` no longer holds the call for its whole timeout ([#18372](https://github.com/can1357/oh-my-pi/pull/18372) by [@alphastorm](https://github.com/alphastorm))
- Mistral Vibe browser sign-in shows subscription billing in the status line and advisor spend instead of pay-as-you-go pricing ([#18374](https://github.com/can1357/oh-my-pi/issues/18374))
- Native OpenAI compaction no longer waits for a Hindsight memory recall it cannot use; fallback summaries still recall memory ([#18327](https://github.com/can1357/oh-my-pi/issues/18327))
- An eval `wait()` on jobs owned by a worker returns finished jobs and consumes their results instead of reporting them as running or delivering them again ([#18363](https://github.com/can1357/oh-my-pi/issues/18363))
- `/restart` no longer drops running subagents: they go on with their interrupted turns in the relaunched process and deliver their results to the agent that spawned them, as `omp --restore` now also does after a normal quit
- A shell command nested hundreds of levels deep (subshells, groups, command substitutions) is now a syntax error in the built-in shell instead of crashing omp with a stack overflow.
- Eval `wait()` progress rows for agents spawned by one `task` call show each agent's own tool count, context, cost and activity instead of the first agent's ([#18393](https://github.com/can1357/oh-my-pi/issues/18393))
- In the Pseudo shell visualization, an `&&` chain keeps its `and` rows while it runs and after it finishes, instead of switching to literal `&&` rows and a raw-bash tail when the output minimizer runs it one command at a time ([#18408](https://github.com/can1357/oh-my-pi/issues/18408))
- Autoresearch `update_notes` calls can now append an idea with only `append_idea`, without passing a replacement `body` ([#18439](https://github.com/can1357/oh-my-pi/pull/18439) by [@eggpeat](https://github.com/eggpeat))

## [18.18.0] - 2026-11-07

### Fixed

- Fixed transcript output freezing after provider restarts or switching sessions mid-stream ([#18358](https://github.com/can1357/oh-my-pi/pull/18358) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- Bash tool cards for a command whose leading `cd <dir> &&` / `cd <dir>;` was hoisted into the working directory show that `cd` again above the visualized command, with the separator the model wrote, instead of dropping where it ran
- Bash commands starting with `cd <dir>; ...` now run in `<dir>` as their working directory when it exists, so its direnv environment loads and the directory shows on the tool card ([#18329](https://github.com/can1357/oh-my-pi/pull/18329) by [@harshaygadekar](https://github.com/harshaygadekar))
- Task-file approvals show and keep the checked file target through dispatch, so retargeted symlinks cannot silently substitute another assignment; replaced files require a retry ([#18314](https://github.com/can1357/oh-my-pi/pull/18314) by [@iliaal](https://github.com/iliaal)).
- Subagents receive task instructions with their blank lines, Markdown hard breaks, and table spacing intact, whether given inline or via `taskFile`.
- Hindsight `retain` and `learn` memories are no longer lost when delivery fails or omp exits: they are kept on disk, retried, and delivered by the next session without duplicates ([#18176](https://github.com/can1357/oh-my-pi/pull/18176) by [@alphastorm](https://github.com/alphastorm))
- Fixed the session crashing with `Native shell returned an invalid execution trace` when a bash command assigned a long value containing multi-byte characters such as Chinese text ([#18259](https://github.com/can1357/oh-my-pi/issues/18259))
- `grep -e` and `rg -e` in the bash tool accept patterns that start with `-` (e.g. `grep -e "--canary"`) instead of failing with an unknown-option error.
- The bash execution visualization keeps updating, and saved traces still restore, after a command handles bytes that aren't valid UTF-8 (e.g. `v=$(printf '\377')`)
- On Windows, `grep`, `glob` and isolated subagents no longer flash a console window when they query or start the ovnfs daemon.
- A bash command containing a bare `[` (e.g. `a && [` while still streaming) no longer crashes omp in the Pseudo shell visualization ([#18320](https://github.com/can1357/oh-my-pi/issues/18320))
- Fixed a prompt that mentions an internal-scheme URL with `@` (e.g. `@local://x`, `@vault://x`) aborting the run with "uses internal scheme ... not as a filesystem path"; such a mention is now left as plain text ([#16071](https://github.com/can1357/oh-my-pi/issues/16071))
- Fixed MCP OAuth login and token refresh failing with `JSON Parse error: Unexpected identifier "access_token"` against GitHub's token endpoint ([#18292](https://github.com/can1357/oh-my-pi/issues/18292))
- MCP OAuth requests tokens for the MCP server's own resource (from its protected-resource metadata) instead of a different `resource` advertised by the authorization server, fixing `401 invalid_token` after `/mcp reauth` on servers such as Firecrawl's hosted MCP ([#18315](https://github.com/can1357/oh-my-pi/issues/18315))
- Concurrent subagent MCP calls now grant newly loaded tools to the session that made each call, even when providers reuse call IDs. ([#18324](https://github.com/can1357/oh-my-pi/pull/18324) by [@eggpeat](https://github.com/eggpeat))
- LSP document symbols now show identifier lines, so those lines work with references, definition, and rename ([#18257](https://github.com/can1357/oh-my-pi/issues/18257)).
- Subagents on worker threads no longer fail with `Cannot send … instance across threads` when their model comes from an extension-registered provider with its own `streamSimple` ([#18310](https://github.com/can1357/oh-my-pi/pull/18310) by [@Dangerboi](https://github.com/Dangerboi))
- ⌘V in terminals with kitty enhanced paste (OSC 5522, e.g. Ghostty 1.4) now attaches macOS TIFF screenshots instead of reporting "Clipboard paste has no supported text or image data" ([#17696](https://github.com/can1357/oh-my-pi/issues/17696), [#18203](https://github.com/can1357/oh-my-pi/pull/18203) by [@roboomp](https://github.com/roboomp))
- Disabling `display.shellVisualization` now omits bash execution traces from tool updates and saved sessions, including in ACP ([#18267](https://github.com/can1357/oh-my-pi/issues/18267)).
- `/quit` and `/exit` no longer wait several seconds for an unresponsive OTLP telemetry collector ([#18255](https://github.com/can1357/oh-my-pi/issues/18255)).
- Cancelling a Python eval cell right as it starts now stops the cell cleanly instead of letting it run and killing the kernel ([#18242](https://github.com/can1357/oh-my-pi/pull/18242) by [@eggpeat](https://github.com/eggpeat))
- Browser `open` now returns the same tab with a recovery notice when Chrome detaches the relay during navigation and omp successfully reattaches, instead of failing the open and closing newly opened tabs ([#18252](https://github.com/can1357/oh-my-pi/pull/18252) by [@will-bogusz](https://github.com/will-bogusz))
- `tab.errors()` keeps the fields of plain-object and other non-Error rejections, bounded like console arguments, instead of reporting only `Object` ([#16959](https://github.com/can1357/oh-my-pi/issues/16959)) ([#18251](https://github.com/can1357/oh-my-pi/pull/18251) by [@Alex-Wengg](https://github.com/Alex-Wengg))
- An extension provider with `authHeader: true` keeps its cached `fetchDynamicModels` catalog when `omp models refresh` fails, instead of showing 0 models until the next successful forced refresh ([#18227](https://github.com/can1357/oh-my-pi/issues/18227))
- A session whose request carries no titleable text of its own — an attached `@brief.md`, a greeting, a bare number — is now named once from the assistant's reading of it, instead of staying untitled until the next message that happens to be titleable (which, for an agent launched from one brief and left to run, never came) ([#18238](https://github.com/can1357/oh-my-pi/pull/18238) by [@sjawhar](https://github.com/sjawhar))
- Prewalk no longer hands a subagent to its cheap model when the subagent messages its parent or another agent (`write agent://…`) before its first file edit ([#18322](https://github.com/can1357/oh-my-pi/pull/18322) by [@1vivy](https://github.com/1vivy))

## [18.17.0] - 2026-11-06

### Added

- Bash commands, foreground and background, now show a live execution visualization in Raw or Python-like Pseudo view, with variable values and replay history; disable with `display.shellVisualization` (default on).
- `grep` and `glob` inside an ovnfs checkout ask the ovnfs daemon to search the checkout in-process, avoiding per-file mount round trips; the daemon and its mount come from `ovnfs --json status` when the ovnfs binary is found. They fall back to the native search when the daemon is unavailable or rejects the request, and cancelling the tool cancels the daemon's search. ovnfs with admin protocol 5 is required.
- Added `skills.manualSkills` glob patterns to hide skills from the model catalog while keeping them manually invocable ([#18114](https://github.com/can1357/oh-my-pi/pull/18114) by [@Shadorain](https://github.com/Shadorain))
- Added Keenable web search (`web/keenable`), using `KEENABLE_API_KEY` or a stored `keenable` credential, or a keyless public endpoint when explicitly selected ([#17953](https://github.com/can1357/oh-my-pi/pull/17953) by [@KGKallasmaa](https://github.com/KGKallasmaa))
- `web_search` results list failed providers with reason and status code in `details.failures` ([#18124](https://github.com/can1357/oh-my-pi/pull/18124) by [@will-bogusz](https://github.com/will-bogusz))
- Added opt-in background auto-update (`update.auto`, offered in setup) that installs new releases via your install method and runs them next launch; skipped on Nix, source checkouts, and Tern.
- `omp update` refuses to run while another update (including auto-update) is installing.
- Added `none` to `edit.mode` (and `PI_EDIT_VARIANT`) to remove the `edit` tool; `bash` stays available even if `bash.enabled` is off.
- Added default-off `providers.openaiResponsesWebsockets` to use WebSockets for supported standard Responses models ([#17354](https://github.com/can1357/oh-my-pi/pull/17354) by [@TatsukiMeng](https://github.com/TatsukiMeng))
- Pinned sessions show a pin beside their title; `/unpin [session id]` unpins a session ([#17848](https://github.com/can1357/oh-my-pi/pull/17848) by [@SuperUserA](https://github.com/SuperUserA))
- Extensions can draw tool calls and `message`/`event` blocks full, compact, or hidden via `pi.registerTranscriptPresenter()`, and redraw with `ctx.ui.refreshTranscript(ids)`; enable with `extensionRenderers.transcriptPresenters` (default off) ([#17960](https://github.com/can1357/oh-my-pi/pull/17960) by [@materemias](https://github.com/materemias)) ([#17997](https://github.com/can1357/oh-my-pi/pull/17997) by [@materemias](https://github.com/materemias))
- Consecutive compact transcript blocks render as tight rows without blank gaps; extension renderers opt in via `isTranscriptBlockCompact()` ([#17997](https://github.com/can1357/oh-my-pi/pull/17997) by [@materemias](https://github.com/materemias))
- Added a fullscreen link browser for links in scrollback: press Alt+O again (or Page Up) while link tags are shown ([#16476](https://github.com/can1357/oh-my-pi/pull/16476) by [@materemias](https://github.com/materemias))
- Added a `cache` status-line segment (`full`/`nerd` presets) showing whether the next message hits the prompt cache; Tern and `/session` show why not and how much is resent ([#12677](https://github.com/can1357/oh-my-pi/issues/12677)) ([#17496](https://github.com/can1357/oh-my-pi/pull/17496) by [@will-bogusz](https://github.com/will-bogusz))
- `^` model tags accept a `:level` suffix (e.g. `^openai-codex/gpt-6-astra:high`) to set the subagent's effort (overriding `task.maxEffort`), with completion of each model's supported levels ([#17574](https://github.com/can1357/oh-my-pi/pull/17574) by [@a-glapinski](https://github.com/a-glapinski))
- Added the `chillax` magic keyword for brief, lowest-effort thinking on supported models; configure via `magicKeywords.chillax`
- Added `tui.colorfulMarkdown` (on by default): replies color headings by level, bold and italic text, inline code and table headers from the theme's palette; turn it off for the previous single heading color and plain bold/italic
- Added `tui.motion` (`full`/`reduced`/`none`), `tui.spinnerInterval` (`0` = static) and `tui.maxFps` to control animation and repaint rate, also via `--motion`/`--spinner-interval`/`--max-fps` and `PI_MOTION`/`PI_SPINNER_INTERVAL`/`PI_MAX_FPS`; an explicit `tui.spinnerInterval` beats `tui.motion`, and keystroke echo keeps 30 fps ([#14240](https://github.com/can1357/oh-my-pi/pull/14240) by [@mccraigmccraig](https://github.com/mccraigmccraig))
- Added `omp zsh`, `omp bash` and `omp sh` to run omp's built-in shell engine directly, passing all arguments through and exiting with the shell's status.
- `omp zsh`/`omp bash` keep shell history in your `$HISTFILE`, compatible with real zsh, including `!` expansion, `fc` and `history`.
- `omp zsh` runs interactively like zsh (line editor, `bindkey`, completion, job control, prompt hooks, common modules), so oh-my-zsh and powerlevel10k configs start.
- RPC `bash` results report truncated output via `elidedBytes`/`elidedLines` and `columnTruncated*`/`columnMax` fields, decoded by the Go, Python and Rust SDKs ([#17957](https://github.com/can1357/oh-my-pi/pull/17957) by [@H4vC](https://github.com/H4vC))
- Added `pi.getShortcutConflict(chord)` so extensions can check whether a key chord is free or who holds it ([#17961](https://github.com/can1357/oh-my-pi/pull/17961) by [@materemias](https://github.com/materemias))
- Exported `unwrapHashlineHeaderPath` from `@oh-my-pi/pi-coding-agent` to turn a `[path#TAG]` target into its plain path ([#17961](https://github.com/can1357/oh-my-pi/pull/17961) by [@materemias](https://github.com/materemias))
- `devin-cli` login imports Devin CLI credentials, so the `devin` provider no longer requires `DEVIN_API_KEY` ([#13637](https://github.com/can1357/oh-my-pi/pull/13637) by [@pavel-kalmykov](https://github.com/pavel-kalmykov))
- `devin-windsurf` login authenticates the `devin` provider with an existing Windsurf Enterprise account ([#13288](https://github.com/can1357/oh-my-pi/pull/13288) by [@pavel-kalmykov](https://github.com/pavel-kalmykov))

### Changed

- ovnfs turns on by itself when its binary is found (`ovnfs.path`, else `ovnfs` on PATH): agents get the separate-checkout guidance, and isolated subagents use ovnfs checkouts when `isolation.backend` is `auto`
- Text Verbosity now defaults to low and applies to Codex too, matching the official Codex client: shorter answers that finish sooner; set `textVerbosity` to `medium` for the old length
- A cost cap set on the main thread now applies to running subagents immediately
- RPC wire protocol and task streaming have lower serialization overhead
- Local Whisper speech-to-text, Parakeet/Nemotron speech, and the local tiny model install their runtimes on first use, shrinking installs; first use needs network access
- `wait` with nothing new returns after 5s (backing off to 5m over repeated idle waits) instead of blocking up to 30 minutes, and nudges the agent toward other work
- `wait` returns jobs finishing within 1.5s of each other in one result
- Broadcasts and progress notes no longer cut short `wait` or interrupt bash/eval; a direct message still ends a wait and delivers every queued message
- `wait` for a reply gives up after 5 minutes (was 30) and returns at once if the other agent is waiting on the user
- In Tern, streamed assistant text and thinking are sent unpaced, cutting omp's CPU use; other terminals keep the smooth reveal
- Source-checkout sessions start faster; existing build stamps remain readable
- The agent's `bash` tool never touches your shell history or completion, and its `zsh -i`/`bash -i` skip `.zshrc`/`.bashrc`
- Embedded Bash follows Bash 5.3 semantics and preserves supported aliases
- CLI flags, session-only settings writes, and SDK overrides now outrank a setting's env var (`PI_MOTION=none omp --motion full` uses full motion); env vars still outrank settings files
- JS and Python tool aborts now report the original abort reason
- Many concurrent subagents now run in worker threads so they don't slow the TUI; new `task.workerThreads` caps workers (default 4; `0` keeps all on the main thread)
- Interactive startup reaches the first frame ~75ms sooner when skills are listed in the system prompt
- "What's New" release notes now appear just after the first frame; quitting before it keeps them for the next start
- Subagents can no longer broadcast (`write agent://all` fails, pointing to a direct `agent://<id>` message) and are no longer told to announce shared-file edits; the main agent can still broadcast
- Factory Droid Gemini 4 Argon sessions keep earlier turns intact across save and reload, with correct image clamping ([#17861](https://github.com/can1357/oh-my-pi/pull/17861) by [@will-bogusz](https://github.com/will-bogusz))

### Fixed

- On macOS, the browser tool's headless Chromium keeps background tabs at normal CPU priority, so on a busy machine `tab.traceStart()`, opening a second tab, and other calls into background tabs no longer stall or time out
- Subagents loading MCP tools (such as Kata's `load_*`) no longer change the main session's tools or system prompt
- Mounting an MCP tool mid-session on prefix-bound models no longer changes the eval tool description, and the mount notice now reaches the model
- Worker-thread subagents are faster: switching views on long transcripts no longer lags, `wait` no longer streams full transcripts, and they stall less on a busy main thread
- Streaming a large batch `task` call no longer slows quadratically (about 80 ms → 2 ms for a 200 KB call)
- `computer` from Eval now uses `zoom` for legible close-ups instead of cropping the downscaled screenshot ([#18158](https://github.com/can1357/oh-my-pi/pull/18158) by [@will-bogusz](https://github.com/will-bogusz))
- Python eval `@tool` definitions with type annotations now register on Python 3.9 ([#18143](https://github.com/can1357/oh-my-pi/pull/18143) by [@Winston-Hsiao](https://github.com/Winston-Hsiao))
- `read` of an SEC EDGAR filing document or folder returns that document, not the company profile ([#18150](https://github.com/can1357/oh-my-pi/pull/18150) by [@will-bogusz](https://github.com/will-bogusz))
- `read` of a Read the Docs page no longer returns another repository's linked file ([#18162](https://github.com/can1357/oh-my-pi/pull/18162) by [@will-bogusz](https://github.com/will-bogusz))
- A browser click beside a direct `tab.waitForDownload()` now errors with a `tab.run` suggestion that actually catches the download ([#17615](https://github.com/can1357/oh-my-pi/issues/17615)) ([#18155](https://github.com/can1357/oh-my-pi/pull/18155) by [@will-bogusz](https://github.com/will-bogusz))
- Browser `open({ viewport })` now sizes relay tabs, `app.cdp_url`/`app.path` browsers, and headed Chromium on first open ([#18160](https://github.com/can1357/oh-my-pi/pull/18160) by [@will-bogusz](https://github.com/will-bogusz))
- Discarded empty, reasoning-only, or length-stop turns still count billed usage in session totals and `omp stats` ([#18178](https://github.com/can1357/oh-my-pi/issues/18178))
- `/extensions` shows the active `~/.agents` skill when a higher-priority `~/.claude` copy is not opted in ([#18190](https://github.com/can1357/oh-my-pi/issues/18190))
- Tool results whose `details` contain a throwing getter no longer silently stop all later session saves ([#18134](https://github.com/can1357/oh-my-pi/pull/18134) by [@MonsieurBarti](https://github.com/MonsieurBarti))
- `write` to a new `ssh://` file no longer fails when the content ends with a `read` truncation notice ([#18154](https://github.com/can1357/oh-my-pi/pull/18154) by [@will-bogusz](https://github.com/will-bogusz))
- `find` returns verified hits as partial results when its 20 s budget runs out instead of failing ([#14809](https://github.com/can1357/oh-my-pi/issues/14809)) ([#18161](https://github.com/can1357/oh-my-pi/pull/18161) by [@will-bogusz](https://github.com/will-bogusz))
- Background bash completion notices name the command, so parallel jobs are distinguishable ([#12607](https://github.com/can1357/oh-my-pi/issues/12607)) ([#18166](https://github.com/can1357/oh-my-pi/pull/18166) by [@will-bogusz](https://github.com/will-bogusz))
- LSP results stay current for open files edited outside OMP, and files unused for 5 minutes are closed in the language server ([#18153](https://github.com/can1357/oh-my-pi/pull/18153) by [@will-bogusz](https://github.com/will-bogusz))
- Markdown edits no longer falsely warn that valid text (e.g. `| a |||`) fails to parse ([#18151](https://github.com/can1357/oh-my-pi/pull/18151) by [@will-bogusz](https://github.com/will-bogusz))
- Bash arguments like `"skill:// external command"` reach external commands as written instead of failing with exit 126 ([#18163](https://github.com/can1357/oh-my-pi/pull/18163) by [@will-bogusz](https://github.com/will-bogusz))
- Thin tool images are padded to the vision model's minimum size instead of causing a 400 ([#18081](https://github.com/can1357/oh-my-pi/issues/18081))
- JSON query truncation notices report the 50KB read budget instead of the bytes shown ([#18022](https://github.com/can1357/oh-my-pi/pull/18022) by [@eggpeat](https://github.com/eggpeat))
- Extension links, renderers, and `ctx.ui.getLinkClicksAvailable()` now work on every launch, not only the first after an edit ([#18116](https://github.com/can1357/oh-my-pi/pull/18116) by [@materemias](https://github.com/materemias))
- Multi-line AST Grep captures show on one `meta:` row instead of splitting across rows ([#18105](https://github.com/can1357/oh-my-pi/pull/18105) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- Extension shortcuts now match regardless of modifier order or spelling: reserved chords stay ignored and the last-loaded duplicate wins ([#17961](https://github.com/can1357/oh-my-pi/pull/17961) by [@materemias](https://github.com/materemias))
- Building from source works again ([#18074](https://github.com/can1357/oh-my-pi/pull/18074) by [@Maziar123](https://github.com/Maziar123))
- `.`/`c` continue no longer reports "Nothing to resume" after `/handoff`, compaction, or a `/skill:`-started session
- `omp bash` and `omp sh` show a prompt when `PS1` is unset
- `display.cacheMissMarker` now flags turns that re-send most of the conversation (e.g. after an idle gap), even when the system prompt block was cached
- A running session keeps its setting values when `config.yml` gains a value its omp version doesn't know, preserving tools and prompt cache
- Forcing a queued message with Enter now reliably resumes the agent
- Interrupting a Python eval cell blocked on top-level `await` cancels the cell and keeps the kernel and variables ([#18115](https://github.com/can1357/oh-my-pi/pull/18115) by [@Winston-Hsiao](https://github.com/Winston-Hsiao))
- Apostrophes in slash-command and prompt-template arguments (e.g. `/fix the user's login bug`) now reach `$ARGUMENTS` and `$1`, `$2`, … intact ([#18008](https://github.com/can1357/oh-my-pi/issues/18008))
- Bash output: middle truncation no longer splits lines and reports accurate line ranges; silent success returns `(no output, exit code 0)` ([#17957](https://github.com/can1357/oh-my-pi/pull/17957) by [@H4vC](https://github.com/H4vC))
- A new session's first frame always shows your configured default model and thinking level, not one from another session or folder
- System-prompt skill listings show the compressed routing hint instead of a truncated description when it fits 160 characters; previously skipped skills are recompressed
- Skill descriptions stop triggering background model requests once the session-tree cost cap is reached, and their spend counts toward the cap ([#18016](https://github.com/can1357/oh-my-pi/issues/18016))
- The idle recap survives resume, restart, and transcript rebuilds, staying at the end until the conversation moves on ([#18113](https://github.com/can1357/oh-my-pi/pull/18113) by [@materemias](https://github.com/materemias))
- Chat sessions on a `web` (or other model-kind) role model no longer fall back to `web/*` search providers and fail with `Unhandled API in mapOptionsForApi: web-search` ([#18056](https://github.com/can1357/oh-my-pi/pull/18056) by [@haesol-shin](https://github.com/haesol-shin))
- Grouped `read` rows naming a URL link the whole URL, not just its last path segment ([#18071](https://github.com/can1357/oh-my-pi/pull/18071) by [@iacore](https://github.com/iacore))
- A second `ask` note on a later single-select question no longer replaces the previous question's note ([#17979](https://github.com/can1357/oh-my-pi/issues/17979))
- The first run of a compiled binary after install or upgrade no longer fails `omp --smoke-test` with `SubagentCodeChangedError` or keeps subagents on the main thread ([#18060](https://github.com/can1357/oh-my-pi/issues/18060))
- Retrying an aborted turn keeps the unsent composer draft ([#17977](https://github.com/can1357/oh-my-pi/pull/17977) by [@Shadorain](https://github.com/Shadorain))
- The `tts` tool uses Grok Voice again instead of silently falling back to Kokoro, and sends `language` to xAI (auto-detected if omitted) ([#17992](https://github.com/can1357/oh-my-pi/pull/17992) by [@Mirceone](https://github.com/Mirceone))
- Windows bash output on non-UTF-8 code pages (CJK) no longer turns into mojibake after one invalid byte; the byte shows as `�` ([#17947](https://github.com/can1357/oh-my-pi/pull/17947) by [@H4vC](https://github.com/H4vC))
- Hindsight no longer silently drops the last mental model (often `User Preferences`) from the prompt when over the render budget ([#17548](https://github.com/can1357/oh-my-pi/issues/17548), [#17955](https://github.com/can1357/oh-my-pi/pull/17955) by [@harshaygadekar](https://github.com/harshaygadekar))
- Subagents woken by IRC, restored, revived, or rerun by a workpool keep their `task.softRequestBudget` guard; it and `task.agentSoftRequestBudget` resolve by agent name (e.g. `scout`), not task ID ([#17988](https://github.com/can1357/oh-my-pi/pull/17988) by [@sinhduc01](https://github.com/sinhduc01), [#18121](https://github.com/can1357/oh-my-pi/pull/18121) by [@eggpeat](https://github.com/eggpeat))
- A focused subagent's `blocked` indicator follows its own approval mode, tool policies, and grants instead of the main session's
- Bash tool: `exec >file`, `exec 2>/dev/null`, or `exec <file` no longer redirects later commands in the session
- Bash tool: an `EXIT` trap fires once at the end of its command, not after every later command
- Bash tool: late output from a background job (`(sleep 1; echo late) &`) no longer appears in a later command's output
- Bash tool: `env -i` no longer passes non-shell-name variables (`A-B=1`), and `X=v env -i`/`X=v env -u X` no longer pass an exported outer `X`
- Bash tool: `xargs` reports a signal-killed command like GNU xargs: `xargs: CMD: terminated by signal N`, stopping with status 125
- macOS: starting a bash tool session no longer briefly sets umask to 022, which could give new files wrong permissions
- Bash tool: a shebang-less executable script run in the background from a FIFO (`./script < fifo &`) runs as bash instead of failing with `Exec format error`
- Subagents no longer hang in an async Python `@tool` call waiting on an `asyncio.Lock` held by another subagent's call
- Cancelling a subagent mid-call cancels its async Python `@tool` coroutine, releasing locks, and reports `Python tool request was cancelled`
- Agent Hub no longer shows a previous session's subagents after creating or switching sessions
- `ast_grep` and `ast_edit` detect languages for uppercase file extensions
- snapcompact no longer treats incompatible older archives as reductions
- `computer` window lookup and app opening work for app IDs, paths, and `~` paths, and survive Wayland permission timeouts
- Embedded headless Chrome no longer outlives its host process, and `computer`/browser lifecycle works in SDK embeddings and local test runs
- Out-of-credit provider errors now fail immediately instead of retrying for long periods; Retry works promptly once the account is funded.
- DeepSeek-style `*** End` and `*** End Patch` markers are no longer written into files or truncate later edits
- Composer prediction ghost text no longer vanishes when advisor messages arrive

## [18.16.0] - 2026-11-02

### Added

- With the Hindsight memory backend, `retain` and `learn` can now store a memory with `scope: "global"` so every project recalls it. It is opt-in through the new `hindsight.globalScope` setting (off by default) and needs `global` or `per-project-tagged` scoping ([#17706](https://github.com/can1357/oh-my-pi/pull/17706) by [@alphastorm](https://github.com/alphastorm), from [#15030](https://github.com/can1357/oh-my-pi/pull/15030) by [@kithawk](https://github.com/kithawk)).
- Added `btw.inject` (off by default; `/settings` → Interaction → "/btw Steering Inject"): when you ask `/btw` for a steering prompt, it drafts one in an `<inject>` block shown behind a pink rail, and `Alt+I` (`app.btw.inject`) sends it to the main session (as a steer while the agent runs, else as a new turn) from the inline answer or the BTW history sheet, once per answer from the current run. Once sent, the block turns green with `➤` on each line and "Injected into main session" below it; if the main session drops or refuses the send, the block turns back to pending and the same key retries ([#17618](https://github.com/can1357/oh-my-pi/pull/17618) by [@apullin](https://github.com/apullin))
- With OTLP metrics export configured (`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`), composer predictions export content-free `omp.composer.prediction.*` metrics by serving model: requests by outcome (offered, skipped, stale, cancelled, timeout, error) with their duration, predictions shown (counted on the first frame that paints them), shown predictions by whether they were accepted with Tab or Right, and the time from first display to acceptance ([#17739](https://github.com/can1357/oh-my-pi/pull/17739) by [@wolfiesch](https://github.com/wolfiesch))
- Bash results the output minimizer rewrote now keep which filter ran and the bytes before and after in the session, and the bash card shows them (`Minimized: git 120.4KB → 3.2KB`) ([#16586](https://github.com/can1357/oh-my-pi/pull/16586) by [@will-bogusz](https://github.com/will-bogusz))
- Eval completion handles expose `attempts` (JS `await handle.attempts()`, Python `handle.attempts`): each fallback candidate tried, in order, with the model, the reasoning effort sent, its outcome, and the error when it failed ([#17782](https://github.com/can1357/oh-my-pi/pull/17782) by [@xiangnan0811](https://github.com/xiangnan0811))
- Added `composer.predictionAlternatives` (off by default; `/settings` → Interaction → "Prediction Alternatives", listed while Composer Predictions is on): the same single prediction request returns up to four different next messages, most likely first. Type a few letters to get ghost text for the first one that matches; after inserting one, press Tab again to pick another from a list. Prediction metrics carry how many alternatives were offered (`omp.composer.prediction.choices`), and an accepted prediction now resolves when it retires, with the rank of the alternative inserted last (`omp.composer.prediction.rank`) ([#17796](https://github.com/can1357/oh-my-pi/pull/17796) by [@wolfiesch](https://github.com/wolfiesch))
- `/review` and `/annotate code-review` work from a folder of checkouts: `/review owner/repo#123` reviews a GitHub PR from anywhere; `/review ./repo [#123 | !7] [focus]` reviews in that checkout (`#N` a GitHub PR, `!N` a GitLab MR); and outside any repository, the local and open-PR menu choices ask which child repository to use

### Changed

- `/resume` and `omp --resume` open at once on your titled sessions (read from `~/.omp/agent/history.db`), then fill in prompts, status, and untitled sessions when the full scan finishes; the first scan saves older sessions' titles too, so later opens list them right away
- With `symbolPreset: ascii`, status glyphs are three columns wide (`[+]`, `[-]`, `[#]`, `[ ]`) and status spinners animate as `[|] [/] [-] [\]` ([#17732](https://github.com/can1357/oh-my-pi/pull/17732) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- The subagent HUD marks each running agent with the running status glyph instead of a dot ([#17732](https://github.com/can1357/oh-my-pi/pull/17732) by [@JustasMasiulis](https://github.com/JustasMasiulis))

### Fixed

- Browser: `browser.close({ all: true })` from a subagent no longer closes its parent's tabs; it releases only the calling agent's tabs. Tabs now belong to the agent that opened them rather than its conversation id, so after `/new`, `/resume`, fork, or branch they are still frozen, idle-closed, released by close-all, and closed when the session ends instead of leaking ([#15975](https://github.com/can1357/oh-my-pi/issues/15975), [#16133](https://github.com/can1357/oh-my-pi/pull/16133) by [@harshaygadekar](https://github.com/harshaygadekar))
- `lsp request` now sends `payload: "null"` as JSON null instead of substituting auto-built document params ([#17715](https://github.com/can1357/oh-my-pi/issues/17715)).
- A prompt rejected before a turn starts because its model or credential is missing returns to the editor for retry; `.`/`c` on an empty conversation reports that there is nothing to resume ([#17828](https://github.com/can1357/oh-my-pi/issues/17828)).
- Factory Droid requests keep attached images and snapcompact system-prompt frames when tools carry large runtime state ([#17819](https://github.com/can1357/oh-my-pi/issues/17819)).
- `pr://<n>`, `issue://<n>`, and repo-less `github` tool calls in a checkout whose `upstream` remote is not the fork parent of `origin` now resolve to `origin` instead of the upstream project; `gh repo set-default` still wins
- `omp -p` text mode now prints each automatic retry with its error (for example "Couldn't reach api.anthropic.com … check your network") instead of showing only `Working...` while a turn retries ([#17529](https://github.com/can1357/oh-my-pi/pull/17529) by [@Mannan-Goyal](https://github.com/Mannan-Goyal))
- `omp --export` and `/export` no longer fail with `Error: Out of memory` on large sessions with subagent transcripts, and use far less memory: the HTML is now streamed to disk instead of built as one string ([#17741](https://github.com/can1357/oh-my-pi/issues/17741))
- A native `security_scan` with `async.enabled` on (the default) now waits for its background `security-reviewer` workers and publishes their findings, instead of ending `partial` with 0 findings and "The scan session ended without publishing a canonical result" ([#17788](https://github.com/can1357/oh-my-pi/issues/17788))
- Browser (Chrome tabs): a click or drag cancelled before its final release now releases off-page instead of completing on its target, and the page sees no click from it (not even on the document root), a timed-out key combo sends no further key, and a call or run cut off mid-gesture releases the mouse button or keys it held instead of leaving them down in the tab. Input already dispatched to Chrome, including a target release, cannot be recalled and may still take effect after timeout ([#17778](https://github.com/can1357/oh-my-pi/pull/17778) by [@will-bogusz](https://github.com/will-bogusz))
- Relay mode: `tab.waitForSelector`, `tab.evaluate` and `tab.goto` no longer fail after 20 s when the page or server takes longer; like on a launched Chrome they now run to the call's own timeout, up to omp's 60 s protocol timeout, and a command Chrome never answers names itself and its tab ([#17778](https://github.com/can1357/oh-my-pi/pull/17778) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `tab.click(selector, { button, count })` and `frame.click` ignoring their options and left-clicking once, so a right-click meant to open a context menu clicked the element instead; cmux tabs refuse buttons and counts they cannot press ([#17767](https://github.com/can1357/oh-my-pi/pull/17767) by [@will-bogusz](https://github.com/will-bogusz))
- Browser `fill` in Chrome no longer sometimes puts the new text in front of a Slate editor's old text when the machine is busy, and refuses a rich-text editor whose focus moves to a wrapper or the page instead of reporting success ([#17742](https://github.com/can1357/oh-my-pi/pull/17742) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a browser relay call working in a cross-site frame (an embedded sign-in form, say) failing with a bare `Target closed` when Chrome detached omp from the tab; it now says Chrome detached omp and whether the tab was reattached, as a call in the page itself does ([#17768](https://github.com/can1357/oh-my-pi/pull/17768) by [@will-bogusz](https://github.com/will-bogusz))
- Browser tabs omp opens with `persist: true` in your Chrome through the relay now stay open when the session ends (an `omp -p` run exits, a subagent finishes), so a page left for you is still there; other tabs omp opened still close, and an explicit close racing session cleanup still closes its page ([#17751](https://github.com/can1357/oh-my-pi/pull/17751) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed keys you type in another app going into a page on macOS when omp's click in a relay tab opened a new tab or popup ([#16284](https://github.com/can1357/oh-my-pi/pull/16284) by [@will-bogusz](https://github.com/will-bogusz))
- Parked subagents keep their `xd://` device mounts when woken after omp restarts, so they no longer lose their earlier Claude thinking ([#17746](https://github.com/can1357/oh-my-pi/pull/17746) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed cancelling `%pip` in Python eval leaving the installer process behind in Linux containers and chroots without a usable `/proc` ([#16552](https://github.com/can1357/oh-my-pi/pull/16552) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed numbered `read` pages of files with very long lines ending after a few KB: a line cut to `tools.outputMaxColumns` now counts the width shown, not its full length, against the page size, so paging no longer stops before such a line or refuses to step past it. When the first cut line is larger than a `:raw` read returns, the cut notice names that byte cap, and a multi-range read that the page size stops partway through a range says where to continue ([#16595](https://github.com/can1357/oh-my-pi/pull/16595) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `write` accepting the output of a `read` whose long lines were cut to `tools.outputMaxColumns` and overwriting the file with the cut lines; it now refuses it as an incomplete read, as it does for other truncated reads ([#16595](https://github.com/can1357/oh-my-pi/pull/16595) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a session resumed, or a parked subagent woken, on a later day resending its first message with that day's date, which made Claude drop all of its earlier thinking and missed the prompt cache; earlier messages now keep the date they were sent with ([#15343](https://github.com/can1357/oh-my-pi/issues/15343)) ([#17622](https://github.com/can1357/oh-my-pi/pull/17622) by [@will-bogusz](https://github.com/will-bogusz))
- `models.yml` accepts `tokenizer: cl100k` on a custom model or override ([#17607](https://github.com/can1357/oh-my-pi/pull/17607) by [@will-bogusz](https://github.com/will-bogusz))
- Claude no longer receives the reasoning kept in a snapcompact archive whose summary an extension wrote without the reasoning legend, with or without image input, and reads that summary's own words instead of a generic one ([#17745](https://github.com/can1357/oh-my-pi/pull/17745) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `~/.omp/agent/agent.db` getting corrupted (wiping stored logins) on Linux when grep, `read`, the bash tool, extensions or eval read it while omp has it open; `write` and `tts` now refuse to overwrite a database omp holds open ([#15586](https://github.com/can1357/oh-my-pi/issues/15586))

Older entries are archived in [packages/coding-agent/CHANGELOG.md@15ff64bc0f8c](https://github.com/can1357/oh-my-pi/blob/15ff64bc0f8c379dc39c825865de5f825705646a/packages/coding-agent/CHANGELOG.md).
## [18.15.0] - 2026-11-01

### Added

- Long or multi-step background shell commands get a one-line caption saying what they do and when they end, written once per job by the `widget` model role when the job, after running 15 seconds, is shown in a live widget or listed by `/jobs full`; the jobs sheet and `/jobs full` show it under the job's purpose. It follows the Live Job Widgets setting (`async.widgets`), and `CreateAgentSessionOptions.jobCaptionWriter` replaces the model call ([#17649](https://github.com/can1357/oh-my-pi/pull/17649) by [@wolfiesch](https://github.com/wolfiesch))

### Changed

- In a source checkout, the error for a missing HTML export viewer now names the script that builds it, `packages/collab-web/scripts/build-export-viewer.ts`, beside `bun gen:export-viewer` ([#17636](https://github.com/can1357/oh-my-pi/pull/17636) by [@sjawhar](https://github.com/sjawhar))
- Fixed an eval cell running silently on a new kernel after the session's Python kernel or JS worker died between cells (a crash, a kill, an out-of-memory kill, or a cancelled JS cell): the first cell on the replacement now carries `Kernel restarted: … state is unavailable. Re-run needed setup` ahead of its own output, instead of failing with a bare `NameError` on a variable an earlier cell set ([#17595](https://github.com/can1357/oh-my-pi/pull/17595) by [@sjawhar](https://github.com/sjawhar))
- Fixed a task worker messaged (`write agent://<id>`) while still starting up running on the shared `context` alone and never receiving its `tasks[].task` assignment; the message now waits for the assignment's turn ([#17587](https://github.com/can1357/oh-my-pi/issues/17587))
- `lsp reload` now discovers Rust crates created after rust-analyzer started, so hover and other analysis work without restarting omp ([#17658](https://github.com/can1357/oh-my-pi/issues/17658)).
- A model without image input (GLM, DeepSeek, Grok Composer and the like) reads a snapcompact archive's full kept text instead of image-omitted placeholders for its frames, after a model switch, on resume and in side requests ([#17510](https://github.com/can1357/oh-my-pi/pull/17510) by [@will-bogusz](https://github.com/will-bogusz))
- Snapcompact no longer refuses a new archive as "would not reduce context" when it shrinks a session that already holds one (`/compact snapcompact`, idle and pre-prompt compaction) ([#17490](https://github.com/can1357/oh-my-pi/pull/17490) by [@will-bogusz](https://github.com/will-bogusz))
- A failed `/compact snapcompact` now reports its reason once instead of twice, and names the `/compact` mode to run instead ([#17490](https://github.com/can1357/oh-my-pi/pull/17490) by [@will-bogusz](https://github.com/will-bogusz))
- Background bash and eval jobs now carry the purpose the model gave for the call: `/jobs`, `/jobs full`, `proc://` listings, `wait` and `job` results, and the jobs HUD hover lead with it ahead of the raw command line ([#17649](https://github.com/can1357/oh-my-pi/pull/17649) by [@wolfiesch](https://github.com/wolfiesch))
- The `seance` guidance in the task tool and the `archive` docs now say that a question about an earlier session is answered by the `seance` agent, and that reading the session's raw JSONL belongs to narrow mechanical checks only, so a consult is no longer duplicated by transcript reads and re-run checks ([#17523](https://github.com/can1357/oh-my-pi/pull/17523) by [@iacore](https://github.com/iacore))

### Fixed

- A prompt on a model whose provider has no usable credential (logged out, refresh token expired, or an auth broker holding none) now switches to the first `retry.fallbackChains` candidate that has one instead of failing with "No API key found", and switches back on the first prompt after the credential returns ([#17559](https://github.com/can1357/oh-my-pi/pull/17559) by [@wolfiesch](https://github.com/wolfiesch))
- Fixed background results arriving during manual `/compact` starting turns on stale history or disappearing from the saved session ([#17599](https://github.com/can1357/oh-my-pi/issues/17599)).
- Fixed isolated tasks on fuse-overlayfs leaving their overlay mounted and the `fuse-overlayfs` daemon running when the unmount hit a transient "Device or resource busy"; a failed unmount now reports fusermount's error and keeps the workspace for `omp worktree clear` instead of deleting its layers under the live mount ([#17644](https://github.com/can1357/oh-my-pi/issues/17644))
- Usage-limit retries now count system sleep toward the quota-reset deadline instead of re-arming the remaining uptime delay after the countdown reaches zero ([#17606](https://github.com/can1357/oh-my-pi/pull/17606) by [@zhiland](https://github.com/zhiland)).
- Fixed role assignments to a `models.yml` model whose id differs only by case from a bundled model of the same provider (such as `xiaomi/MiMo-V2.6-Pro` beside `xiaomi/mimo-v2.6-pro`) silently staying unset ([#17580](https://github.com/can1357/oh-my-pi/issues/17580))
- Fixed Eval's direct browser wait helpers (`tab.waitForSelector`, `tab.waitForText`, …) giving up after 29 s when passed a longer `{ timeout }`; the requested timeout is now honored up to the browser tool's 300 s cap ([#17617](https://github.com/can1357/oh-my-pi/issues/17617))
- Fixed `browser.open` with a fresh custom Chrome profile failing when Chrome has no initial tabs; it now opens its own tab without navigating an existing one ([#17583](https://github.com/can1357/oh-my-pi/issues/17583)).
- Fixed the read tool's repeated-output notice suggesting a `path:A-B` selector on `xd://` topics, MCP resources and other URLs that reject selectors ([#17631](https://github.com/can1357/oh-my-pi/issues/17631))
- The `lsp` tool now starts `typescript-native` (`tsc --lsp --stdio`) for a TypeScript 7 `tsc` installed without a `package.json`, such as the nixpkgs package, instead of leaving the project with no TypeScript server ([#17659](https://github.com/can1357/oh-my-pi/issues/17659))
- DuckDuckGo excludes advertising click redirects before applying result limits, keeping them out of direct and Public Web sources ([#17564](https://github.com/can1357/oh-my-pi/pull/17564) by [@jasonharrison](https://github.com/jasonharrison)).
- Fixed `/fast` refusing Ultrafast ("The current model does not offer the Ultrafast service tier") on custom OpenAI-compatible providers whose `/v1/models` row lists `ultrafast` in `service_tiers`, such as relays in front of a ChatGPT subscription ([#17577](https://github.com/can1357/oh-my-pi/pull/17577) by [@jakehemmerle](https://github.com/jakehemmerle))
- Importing the SDK no longer takes over the embedding host's signal and fatal-error shutdown; registered cleanup still runs at exit ([#17674](https://github.com/can1357/oh-my-pi/issues/17674)).
- Fixed raw browser `page.waitForFunction` waits timing out after a full-document navigation even when the destination matches the predicate ([#17584](https://github.com/can1357/oh-my-pi/issues/17584))
- Fixed a Ctrl+R history entry picked while an ask dialog's "Other" or note prompt is open landing in the hidden main chat input instead of that prompt ([#17565](https://github.com/can1357/oh-my-pi/issues/17565))
- Bash commands no longer hang on `git rebase -i` when git config sets a `sequence.editor` (an inline `GIT_SEQUENCE_EDITOR=…` still wins), or on Git Credential Manager GUI/browser sign-in prompts ([#17452](https://github.com/can1357/oh-my-pi/pull/17452) by [@wolfiesch](https://github.com/wolfiesch))
- Fixed intercepted bash commands asking for approval before being blocked anyway ([#17502](https://github.com/can1357/oh-my-pi/pull/17502) by [@asuffield](https://github.com/asuffield))
- Fixed `omp --from-claude` listing a Claude Code session renamed with `/rename` by its first prompt; the picker now shows the renamed title and importing the session keeps it ([#17361](https://github.com/can1357/oh-my-pi/pull/17361) by [@namest504](https://github.com/namest504)).
- Auto-learn capture turns now reuse the main turn's prompt cache instead of re-sending the whole conversation uncached: they advertise the same tool list and refuse every call except `learn` and `manage_skill` without running it ([#17418](https://github.com/can1357/oh-my-pi/pull/17418) by [@STRML](https://github.com/STRML)).
- Fixed extensions being unable to replace the background-job completion card with `registerMessageRenderer("async-result", …)`; a registered renderer now owns the card, and the built-in row remains the fallback when none is registered, when one declines, and when one throws ([#17372](https://github.com/can1357/oh-my-pi/pull/17372) by [@AlexBrd999](https://github.com/AlexBrd999), from [#14484](https://github.com/can1357/oh-my-pi/pull/14484) by [@F0Rextasy](https://github.com/F0Rextasy); [#14131](https://github.com/can1357/oh-my-pi/issues/14131))
- Local dictation stops live previews when the speech model repeatedly cannot keep up, so final transcripts no longer wait behind repeated previews ([#17410](https://github.com/can1357/oh-my-pi/issues/17410)).
- ACP clients now receive `_omp/compaction/start` and `_omp/compaction/end` notifications, including failures and cancellations, without requiring an active prompt. ([#16969](https://github.com/can1357/oh-my-pi/issues/16969); [#17384](https://github.com/can1357/oh-my-pi/pull/17384) by [@SAKANA-MOONLIGHT](https://github.com/SAKANA-MOONLIGHT)).
- Fixed `cd` (and `pushd`/`popd`/`z`) failing with `command not found: __zsh_like_cd` in agent shells when `mise activate` or `zoxide init` installed wrapper functions: the shell snapshot now keeps the underscore-prefixed helper functions those wrappers call, instead of dropping every private-looking function ([#17448](https://github.com/can1357/oh-my-pi/pull/17448) by [@KamijoToma](https://github.com/KamijoToma))

## [18.14.2] - 2026-10-31

### Added

- Added `task.perCallModel` (`off` by default, `eval`, `on`) so a task item or an eval `agent()`/`workpool()` call can run on one exact model the operator already names: a chat role from your own (non-project) settings, the selected agent's own model, or the parent's current model. Glob values (`anthropic/*`) never approve a model. `task.perCallModelAllow` narrows that list, `task.maxEffort` caps the worker's effort, and the worker never switches to another model. Project settings can only narrow this: they never turn it on or approve a model ([#12229](https://github.com/can1357/oh-my-pi/pull/12229) by [@Xytronix](https://github.com/Xytronix))
- Added `Settings.reloadFromDisk({ includeParents: true })`, which reloads the persisted settings behind an overlay while keeping the overlay's own overrides ([#12229](https://github.com/can1357/oh-my-pi/pull/12229) by [@Xytronix](https://github.com/Xytronix))

### Changed

- `model` is now declared in every task schema: a task call, eval `agent()` or `workpool()` that passes a model the operator's configuration does not allow is refused with an error ([#12229](https://github.com/can1357/oh-my-pi/pull/12229) by [@Xytronix](https://github.com/Xytronix))
- Viewing a subagent or returning to the main session no longer posts a "Viewing agent …" / "Returned to main session" status (a popup in Tern); the status line and Tern's composer already show which agent is in view
- In a Tern pane, `omp stats` shows the dashboard in place of the block it runs in, with a Close button (or Esc, or Ctrl+C) that stops it and brings the terminal back, and `/stats` opens it in a browser block beside omp, instead of the system browser
- `bash` tool commands now see `PI_TOOL_CALL_ID`, the id of the call running them, so a script the agent runs can point at that call in the session transcript ([#17489](https://github.com/can1357/oh-my-pi/pull/17489) by [@will-bogusz](https://github.com/will-bogusz))
- Native judgments with a configured fallback now move to it after a 3-second candidate deadline (configurable with `judgment.attemptTimeoutMs`) and briefly skip the timed-out route; without a configured fallback a slow judge is never cut off or replaced ([#17465](https://github.com/can1357/oh-my-pi/pull/17465) by [@Xytronix](https://github.com/Xytronix)).

### Fixed

- Fixed a `!` or `$` command run while the agent works floating over the composer in Tern, where expanding its output covered the conversation; it now sits at the end of the conversation
- Fixed `out://` replies sent from an eval cell (`tool.write` to `out://`, or `tool.bash` with `> out://`) never appearing even though the write reported "Shown to the user."; they now draw as replies after the eval card, and are refused where nothing would show them (a backgrounded cell, a browser tab script)
- Fixed a `write` to `out://` (such as `out://baselines.md`) drawing as a Write card with line numbers instead of a reply streaming as prose
- Fixed table charts drawing a `ratio` or `speedup` column as a series beside the timings it was computed from, which read as "719× less" against the baseline
- Fixed `read` of a directory hiding existing `dist`, `build`, `node_modules`, `.git`, and other dependency/build/cache subdirectories, which made them look absent ([#17539](https://github.com/can1357/oh-my-pi/issues/17539))
- Fixed artifact writes reporting the staging-file cleanup error instead of the original short-write or publication failure ([#17485](https://github.com/can1357/oh-my-pi/pull/17485) by [@jchanghong023](https://github.com/jchanghong023))
- Fixed MCP tool calls failing without reconnecting after DNS or socket-open errors ([#17461](https://github.com/can1357/oh-my-pi/pull/17461) by [@Xytronix](https://github.com/Xytronix)).
- Fixed MCP connection timeouts and cancellation allowing a stdio server to start after the connection attempt had already failed. ([#17512](https://github.com/can1357/oh-my-pi/pull/17512) by [@jchanghong023](https://github.com/jchanghong023))
- Fixed ACP updates and extension dialogs switching to an unadvertised session handle after a session reset, and a client reopening a continued conversation after a restart landing on the original session ([#17517](https://github.com/can1357/oh-my-pi/pull/17517) by [@jchanghong023](https://github.com/jchanghong023))
- Fixed IRC coordination cards remaining visible when Hide Tool Activity is enabled, including live messages and replay ([#17498](https://github.com/can1357/oh-my-pi/pull/17498) by [@dannyboy-ai](https://github.com/dannyboy-ai)).
- Fixed a message you queue while the agent waits on `ask` sitting behind the unanswered dialog; the dialog now closes without cancelling the turn, while IRC messages and background completions leave it open ([#17537](https://github.com/can1357/oh-my-pi/issues/17537)).
- Fixed JS eval `output()` ignoring its documented `offset`, `limit`, `query` and `format` options and returning the raw `read` tool result; it now returns the selected text (or the `format: "json"` metadata) like Python's `output()` ([#17455](https://github.com/can1357/oh-my-pi/issues/17455))
- Fixed session lookup losing readable project sessions when an unrelated project folder is unreadable ([#17467](https://github.com/can1357/oh-my-pi/pull/17467) by [@Xytronix](https://github.com/Xytronix)).
- Fixed the advisor resending a byte-identical refused review before trying its model fallback when the review contained no primary reasoning to strip ([#17473](https://github.com/can1357/oh-my-pi/issues/17473))
- Fixed `read` of a whole URL returning no content when the page's first line is over the 50 KB output budget, as on minified pages read with `:raw`; it now shows that line's first 50 KB ([#17500](https://github.com/can1357/oh-my-pi/pull/17500) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed an advisor whose usage-limited account kept being reported as switchable retrying the same capped account thousands of times; it now tries each sibling account at most once per provider per failing review, then falls back, waits, or pauses on the quota ([#17472](https://github.com/can1357/oh-my-pi/issues/17472))
- Fixed LSP definition, type definition, implementation and reference results carrying a stray carriage return on every source context line from files with Windows (CRLF) line endings ([#17549](https://github.com/can1357/oh-my-pi/pull/17549) by [@JustasMasiulis](https://github.com/JustasMasiulis))

## [18.14.1] - 2026-10-31

### Added

- Added the `providers.openai-codex.daybreak` setting (default on) to stop omp from automatically requesting the Daybreak Blue cyber access program on eligible ChatGPT accounts; each session follows its own value ([#17508](https://github.com/can1357/oh-my-pi/pull/17508) by [@H4vC](https://github.com/H4vC))
- Added queueable compaction: `/compact` sent with the follow-up key (Ctrl+Q) while the agent works now runs when it yields instead of interrupting it ([#17397](https://github.com/can1357/oh-my-pi/pull/17397) by [@H4vC](https://github.com/H4vC))
- Added `omp session lease [--json] -- <session-id>...` and the RPC command `get_session_lease`, which report which sessions a running omp owns (`{"held": [...], "unknown": [...]}`) without taking ownership, so another program can check a session without forking it ([#17428](https://github.com/can1357/oh-my-pi/pull/17428) by [@andrebrait](https://github.com/andrebrait))
- Added opt-in `title.refreshAfterPrompts`: every N operator prompts, the judge model checks whether a generated session title still fits the conversation and regenerates it when it does not; user-set titles are never replaced ([#17443](https://github.com/can1357/oh-my-pi/pull/17443) by [@wolfiesch](https://github.com/wolfiesch))
- Gateway rows discovered from `/v1/models` now keep the `reasoning_effort_map` and `reasoning_required` facts they advertise: a route that serves only low/high/max routes `medium` to `high` instead of the nearest lower tier, and a thinking-off request still sends a tier the route accepts ([#17395](https://github.com/can1357/oh-my-pi/pull/17395) by [@Maziar123](https://github.com/Maziar123))
- Computer-use scripts can wait for a window opened by an action and read it in the same call with a window filter's optional `wait` ([#17391](https://github.com/can1357/oh-my-pi/pull/17391) by [@will-bogusz](https://github.com/will-bogusz))

### Changed

- `read` of a web page keeps the title, description, author and dates of its `<meta>` tags and lists the others by name only, so pages cost about 6% fewer tokens ([#17393](https://github.com/can1357/oh-my-pi/pull/17393) by [@will-bogusz](https://github.com/will-bogusz))
- On the Anthropic API, the newest message now keeps all its images up to the 128 MB request limit, past the 120 MB image budget ([#17492](https://github.com/can1357/oh-my-pi/pull/17492) by [@will-bogusz](https://github.com/will-bogusz))

### Fixed

- Fixed account-policy recovery repeatedly rotating through denied credentials instead of surfacing the error or using the configured model fallback, including unnecessary sibling-unblock waits after the account allowance is spent ([#17439](https://github.com/can1357/oh-my-pi/pull/17439) by [@wolfiesch](https://github.com/wolfiesch))
- Startup prewalk now arms a later fallback candidate of the role named by prewalk.into when its first candidate is unavailable, matching /prewalk and /new ([#17373](https://github.com/can1357/oh-my-pi/pull/17373)).
- Fixed `omp install git:github.com/user/repo` treating `git` as the host instead of installing the GitHub plugin ([#17436](https://github.com/can1357/oh-my-pi/issues/17436)).
- Fixed `read` showing a zip, tar, asar or ISO archive's old contents after a same-size rewrite within milliseconds of its previous write, on filesystems with coarse timestamps such as Linux ext4 ([#17389](https://github.com/can1357/oh-my-pi/pull/17389) by [@will-bogusz](https://github.com/will-bogusz))
- Browser `fill` in Chrome replaces the text of rich-text editors such as Slate (Discord) and Lexical instead of leaving the old text in place or breaking the editor, and an empty fill clears them ([#17417](https://github.com/can1357/oh-my-pi/pull/17417) by [@will-bogusz](https://github.com/will-bogusz))
- Requests to the Anthropic API and Factory Droid's hosts now drop their oldest images when long text, tool arguments, or re-declared tool definitions would otherwise push the request past the host's size limit ([#17492](https://github.com/can1357/oh-my-pi/pull/17492) by [@will-bogusz](https://github.com/will-bogusz))
- Factory Droid requests size images against what each route actually sends: Gemini models count their expanded tool schemas and no longer drop images for another model's reasoning, and only Claude models count withdrawn tool definitions ([#17492](https://github.com/can1357/oh-my-pi/pull/17492))

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

Older entries are archived in [packages/coding-agent/CHANGELOG.md@529c1841b699](https://github.com/can1357/oh-my-pi/blob/529c1841b6990b8c014aa79bac60ac2d54fbaf83/packages/coding-agent/CHANGELOG.md).
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

Older entries are archived in [packages/coding-agent/CHANGELOG.md@add60d3a7727](https://github.com/can1357/oh-my-pi/blob/add60d3a77271718311dd03e312f8b30dc646b07/packages/coding-agent/CHANGELOG.md).
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

### Fixed

- Fixed the JTD-to-JSON-Schema converter emitting `$ref`s that cannot resolve: ref names are now escaped per JSON Pointer (`~` and `/`), and the JTD root `definitions` map is mapped to `$defs` so `#/$defs/` refs have a target ([#14826](https://github.com/can1357/oh-my-pi/pull/14826) by [@jchanghong023](https://github.com/jchanghong023)).

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

Older entries are archived in [packages/coding-agent/CHANGELOG.md@b81a844b520a](https://github.com/can1357/oh-my-pi/blob/b81a844b520af43d1d190a99fcdc8928e242b315/packages/coding-agent/CHANGELOG.md).
### Fixed

- Fixed the JTD-to-JSON-Schema converter emitting `$ref`s that cannot resolve: ref names are now escaped per JSON Pointer (`~` and `/`), and the JTD root `definitions` map is mapped to `$defs` so `#/$defs/` refs have a target ([#14826](https://github.com/can1357/oh-my-pi/pull/14826) by [@jchanghong023](https://github.com/jchanghong023)).

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

Older entries are archived in [packages/coding-agent/CHANGELOG.md@72d5cf31d861](https://github.com/can1357/oh-my-pi/blob/72d5cf31d86101eb0e17beaeda98582938c2eb78/packages/coding-agent/CHANGELOG.md).
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
## [18.8.5] - 2026-10-08

### Added

- Added per-model auto-compaction points: the `/models` preview shows where each model compacts, and in the Roles view `k` (or the **Compaction limit** button) sets it for the selected role's or fallback's model (`90000`, `90k`, `1M`, `80%`; empty resets). Also configurable as `compaction.modelThresholds` with `provider/model-id` or `provider/*` keys ([#14952](https://github.com/can1357/oh-my-pi/pull/14952) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed `omp usage` reporting an account exactly at its reserve (e.g. 30% left with a 30% reserve) as eligible instead of inside reserve ([#14765](https://github.com/can1357/oh-my-pi/pull/14765) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the todo reminder pushing the agent to keep working after it offered options and asked the user to choose ([#14800](https://github.com/can1357/oh-my-pi/pull/14800) by [@mrmans0n](https://github.com/mrmans0n))
- Fixed the todo reminder telling the model to keep working right after it asked the user a bolded or italicised question ([#12051](https://github.com/can1357/oh-my-pi/issues/12051), [#14353](https://github.com/can1357/oh-my-pi/pull/14353) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed short model selectors such as `p/a:max` or `a:max` dropping their explicit thinking level when a role was reassigned or used for image questions; a model whose ID literally ends in `:max` or `:auto` is still treated as that model ([#14554](https://github.com/can1357/oh-my-pi/pull/14554) by [@xiangnan0811](https://github.com/xiangnan0811))
- Fixed starting a subagent switching the parent session's later language servers from shared to private ([#14628](https://github.com/can1357/oh-my-pi/pull/14628) by [@jorgoose](https://github.com/jorgoose))
- Fixed a finishing subagent cancelling local tiny-model requests (titles, task labels, judgments) still running for the parent or other subagents ([#14629](https://github.com/can1357/oh-my-pi/pull/14629) by [@jorgoose](https://github.com/jorgoose))
- Fixed rust-analyzer on Windows not running through a running lspmux server, as it already did on Linux and macOS ([#14630](https://github.com/can1357/oh-my-pi/pull/14630) by [@jorgoose](https://github.com/jorgoose))
- Fixed a malformed or unreadable project `plugin-overrides.json` being ignored silently, which re-enabled project-disabled plugins without a trace; omp now logs a warning naming the file ([#14518](https://github.com/can1357/oh-my-pi/issues/14518), [#14573](https://github.com/can1357/oh-my-pi/pull/14573) by [@oleg494](https://github.com/oleg494))
- Fixed Claude Opus 5.5 and Sonnet 5.5 disappearing with mixed-access Google Antigravity accounts; models now route to accounts that serve them, and revoked accounts no longer block catalog refresh ([#14924](https://github.com/can1357/oh-my-pi/issues/14924)).
- Fixed clipboard-pasted image chips opening a nonexistent file instead of the image, including after `/move` ([#14927](https://github.com/can1357/oh-my-pi/issues/14927)).
- Fixed clipboard-pasted image chips opening the auto-resized copy sent to the model instead of the image as pasted ([#14929](https://github.com/can1357/oh-my-pi/pull/14929))
- Fixed `omp token <provider> --account N --force-refresh` printing the stored token unchanged while it was still valid; it now re-mints that account. Security scans pinned to one account, including Codex Security cloud requests, refresh it after a 401 and may reuse a still-usable token minted in the previous five minutes, as `omp auth-broker serve` now also may for its clients' 401 recovery ([#14752](https://github.com/can1357/oh-my-pi/pull/14752) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed revived subagents moving to the parent's automatically chosen account and re-writing their whole prompt cache instead of staying on the account that served their earlier turns; a parent's explicit `/session pin` still moves them ([#14749](https://github.com/can1357/oh-my-pi/pull/14749) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a fallback chain switching back to a usage-limited primary model every 30 minutes, failing a request each time, when the provider's usage report showed a later reset; the session now stays on the fallback until that reset ([#14757](https://github.com/can1357/oh-my-pi/pull/14757) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/usage`, the status line usage segment and `/logout` treating every Google Antigravity account (and every Codex Team seat in one workspace) as the session's account, and `omp usage` not listing such an account when its usage fetch failed ([#14900](https://github.com/can1357/oh-my-pi/pull/14900) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed Tern showing an agent as finished when automatic context maintenance ends partway through a turn; omp now keeps reporting the turn's working state until the turn actually ends ([#14917](https://github.com/can1357/oh-my-pi/pull/14917) by [@wolfiesch](https://github.com/wolfiesch))
- Fixed the terminal title and Tern busy state staying in the working state after an interrupt cancels a scheduled retry or continuation before it starts ([#14917](https://github.com/can1357/oh-my-pi/pull/14917) by [@wolfiesch](https://github.com/wolfiesch))
- Fixed Anthropic web search through a custom `anthropic-messages` provider sending a plain API-key request even though the provider's conversations use Claude Code request shaping; search now honors the model's `isOAuth` like the main conversation, so keys that only work with that shaping no longer fail with HTTP 429 `rate_limit_error` ([#14919](https://github.com/can1357/oh-my-pi/pull/14919) by [@farnoy](https://github.com/farnoy))
- Fixed Anthropic web search spreading the model's configured headers under its own without the main conversation's case-insensitive merge and enforced-header filtering, so a configured `authorization` header could replace the credential or join it comma-separated on the wire ([#14919](https://github.com/can1357/oh-my-pi/pull/14919) by [@farnoy](https://github.com/farnoy))

### Removed

- Removed the `PI_SUBPROCESS_CMD` environment variable; subagents run in-process and never read it ([#14632](https://github.com/can1357/oh-my-pi/pull/14632) by [@jorgoose](https://github.com/jorgoose))

## [18.8.4] - 2026-10-08

### Changed

- Agent Hub keeps existing agents in place while open; new agents appear first in the flat roster or within their tree sibling group ([#13066](https://github.com/can1357/oh-my-pi/pull/13066) by [@kmccleary3301](https://github.com/kmccleary3301))

### Fixed

- Fixed `omp auth-broker serve` logging every client as `unknown` (or as whatever a caller put in `X-Forwarded-For`); it now logs the socket address, with `--trust-proxy-headers` for brokers behind a reverse proxy ([#14762](https://github.com/can1357/oh-my-pi/pull/14762) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed relative file links in Tern assistant replies opening against the folder omp was started in after `/wt` or `/move`; they now open the file in the session's working directory ([#14879](https://github.com/can1357/oh-my-pi/pull/14879) by [@H4vC](https://github.com/H4vC))
- Fixed the BTW history, git shortcuts, and autoresearch sheets in Tern having no Close button, and the plan review sheet having no Cancel button ([#14894](https://github.com/can1357/oh-my-pi/pull/14894) by [@H4vC](https://github.com/H4vC))
- Fixed the agent transcript viewer and `/annotate` review in Tern having no clickable way out; both now show a clickable `esc` at the top right ([#14894](https://github.com/can1357/oh-my-pi/pull/14894) by [@H4vC](https://github.com/H4vC))
- Fixed the `/move` folder picker in Tern having only key hints; Accept (Tab), Cancel (Esc) and Confirm (Enter) are now clickable buttons ([#14894](https://github.com/can1357/oh-my-pi/pull/14894) by [@H4vC](https://github.com/H4vC))
- Fixed `omp usage` listing a second "7 days … not reported" row for a Codex account that reports only a weekly window, and misaligning its rows against accounts that report a 5-hour window too ([#14760](https://github.com/can1357/oh-my-pi/pull/14760) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp auth-gateway serve` showing the usage and credential health of providers listed in `disabledProviders`, account emails included, on `/v1/usage` and `/v1/credentials/check` ([#14755](https://github.com/can1357/oh-my-pi/pull/14755) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp usage --history` on auth-broker clients always reporting no recorded history; it now reads the broker host's history, as `omp usage clients` already does ([#14758](https://github.com/can1357/oh-my-pi/pull/14758) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp usage --history` and `omp usage clients` dying with a stack dump when the auth broker is unreachable or lacks the endpoint; they now print a one-line error and exit nonzero
- Fixed `omp usage --history` showing two Codex accounts that share an email under the same name; they now carry the same qualifier as `omp usage` ([#14767](https://github.com/can1357/oh-my-pi/pull/14767) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `--model`, `/model` and `/switch` with a bare id that several logged-in providers carry ignoring `modelProviderOrder` and recent use; they now pick the same provider as `modelRoles`, and `omp bench`, compress, cleanse and the stdio auth gateway follow the same ranking ([#14517](https://github.com/can1357/oh-my-pi/pull/14517) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp usage --provider <id>` blaming a missing usage endpoint when no credentials are stored for that provider, and `omp usage invalidate --provider <id>` reporting success for it; both now list the providers that have credentials ([#14763](https://github.com/can1357/oh-my-pi/pull/14763) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp usage` labelling an exhausted account "inside reserve" on its account-policy line; it now says "exhausted" ([#14764](https://github.com/can1357/oh-my-pi/pull/14764) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/new` keeping plan mode (and its plan-role model) or goal mode active in the new session ([#14653](https://github.com/can1357/oh-my-pi/issues/14653))
- Fixed parallel first bash calls each spawning an rc-sourcing shell ([#14680](https://github.com/can1357/oh-my-pi/pull/14680) by [@H4vC](https://github.com/H4vC))
- Fixed the todo list's auto-clear never firing while subagents were streaming progress ([#14692](https://github.com/can1357/oh-my-pi/pull/14692) by [@H4vC](https://github.com/H4vC))
- Fixed memory growth while ACP client-terminal commands run ([#14680](https://github.com/can1357/oh-my-pi/pull/14680) by [@H4vC](https://github.com/H4vC))
- Fixed ephemeral side-channel replies (idle recap, completion probe, `runEphemeralTurn`) truncating in quadratic time ([#14695](https://github.com/can1357/oh-my-pi/pull/14695) by [@H4vC](https://github.com/H4vC))
- Sped up `omp compress` by tokenizing each draft once per round ([#14702](https://github.com/can1357/oh-my-pi/pull/14702) by [@H4vC](https://github.com/H4vC))
- Fixed the agent slowing down while streaming long eval cells ([#14704](https://github.com/can1357/oh-my-pi/pull/14704) by [@H4vC](https://github.com/H4vC))
- Fixed quadratic slowdown reading large Python kernel output (big reprs, base64 images) ([#14704](https://github.com/can1357/oh-my-pi/pull/14704) by [@H4vC](https://github.com/H4vC))
- Sped up TUI repaints of live stream and `/record` rows ([#14705](https://github.com/can1357/oh-my-pi/pull/14705) by [@H4vC](https://github.com/H4vC))
- Fixed quadratic slowdown in `omp cleanse` on large tsc/clippy/golangci output ([#14706](https://github.com/can1357/oh-my-pi/pull/14706) by [@H4vC](https://github.com/H4vC))
- Fixed documents served as `application/octet-stream` being downloaded twice ([#14708](https://github.com/can1357/oh-my-pi/pull/14708) by [@H4vC](https://github.com/H4vC))
- Fixed collab TUI guests rebuilding the transcript per token ([#14715](https://github.com/can1357/oh-my-pi/pull/14715) by [@H4vC](https://github.com/H4vC))

## [18.8.3] - 2026-10-07

### Fixed

- Fixed repeat opens of the model picker, model hub, or agents views stacking duplicates; the open one is brought forward instead ([#14846](https://github.com/can1357/oh-my-pi/pull/14846) by [@H4vC](https://github.com/H4vC))

## [18.8.2] - 2026-10-07

### Fixed

- Fixed long Anthropic sessions with repeated tool screenshots exceeding the request-size limit; live images are now trimmed by bytes, recoverable 413s may compact older history, and terminal subagent failures reach the parent ([#14453](https://github.com/can1357/oh-my-pi/issues/14453)).
- Fixed Tern browser tabs opened with a `url` returning before the page loaded, which made the first `observe()` or `title()` read the blank page.

### Removed

- Removed per-call `model` overrides from `task`, eval `agent()`, and `workpool()`; subagents use configured agent models and settings.

## [18.8.1] - 2026-10-07

### Added

- Added account pools for task agents, allowing an agent and its related work—including advisors, title generation, subagents, and resumed sessions—to use only specified OAuth accounts and fail rather than fall back to another account or an API key.
- Added `omp usage accounts` to list OAuth account provider and identity keys without exposing tokens, making account-pool configuration easier.

### Changed

- Generated session titles now include their card icon and short code, so the `/resume` picker and session listings show this context; `title.icons` applies to newly generated titles.
- Symlinked routing configurations now reload when an intermediate file or profile-directory link is replaced, without requiring a session restart.

### Fixed

- Improved Tern `ask` questions so the question no longer obscures the transcript and can be answered while reviewing and scrolling through the relevant context.
- Added warnings for unrecognized `compat` keys in `models.yml` while continuing to load the configuration; warnings identify the file and key path.
- Fixed `/new` so new sessions reset plan and goal modes, todo state, and related planning configuration instead of carrying stale state forward; fresh prewalk behavior is also restored after handoffs, cancellations, or automatic recovery.
- Fixed OAuth alias login and logout flows so they refresh the underlying provider's models, report authentication state correctly, and list and remove the accounts associated with that provider.
- Fixed model speed statistics so throughput from non-default OpenAI or Codex service tiers is kept separate and displayed for the tier used by the session.
- Fixed stale model catalogs remaining in memory after provider or catalog refreshes.
- Fixed `write` and `edit` from hanging or exhausting memory when given FIFOs, terminals, device files, or other non-regular targets; unsupported targets are now rejected safely.
- Fixed long conversations from losing user and tool-result images when the conversation also contained assistant-generated images.
- Fixed `local://` session paths from escaping their intended storage directory when given `.` or `..` session identifiers.
- Fixed `omp gc --archive --apply` from leaving orphaned session-title records behind.
- Fixed `/retry` after an interrupted reopened `ask` prompt when an extension had registered a context handler.
- Fixed browser relay sessions from missing cross-origin iframe content that loaded before the tab was opened.
- Fixed browser clicks on invisible native radio and checkbox inputs, including controls commonly used by GOV.UK forms.
- Fixed `/model` so selecting the model already assigned to a project's default role still switches to that model correctly.
- Fixed `wait` and background task state when a completion has already been consumed elsewhere, preventing premature interruption and incorrect idle detection.
- Fixed repeated coding-plan fallback confirmations after declining a fallback in cases involving changing thinking settings, unavailable quota data, or account recovery.
- Fixed Python evaluation when the shared runner temporary directory was created by another user.
- Added RPC support for completing multi-select `ask` questions without relying on TUI keyboard navigation.
- Corrected tool behavior and configuration documentation for `read`, background `bash`, Python evaluation, replace editing, goal removal, and `advisor.immuneTurns`.
- Fixed custom glob backends from hanging indefinitely; scans now respect the tool deadline and report incomplete results when necessary.
- Fixed `--resume <path>` from silently creating a new session for a missing path; it now reports the missing path, consistent with `--fork <path>` and `--resume <id>`.

## [18.8.0] - 2026-10-07

### Added

- Write-tool previews now render as files stream: SVG files appear as images, and Mermaid files (`.mmd` and `.mermaid`) appear as diagrams. Tern also previews supported 3D model formats (`.obj`, `.ply`, `.wrl`, `.x3dv`, `.stl`, `.gltf`, and `.usda`) and renders SVG writes as SVG figures.
- Added the `title.icons` setting to show session title cards with a Nerd Font glyph and emoji fallback (`nf+emoji`, default), always the emoji (`emoji`), or as plain titles (`boring`).
- Added the `title.generator` setting to name sessions from a fork of the reply (`fork`, default) or with the title model only (`tiny`).

### Changed

- Session titles are generated using the session's model when possible, with a fallback to the lightweight title model; `TITLE_SYSTEM.md` continues to override the title prompt.
- Session titles now include a card index, icon, and short code, with appropriate Nerd Font rendering in Tern panes.
- When Nerd Font symbols are unavailable, session titling requests only an emoji.
- Subagent completion indicators now advance to 99% when the subagent submits its result.
- In Tern panes, headed and headless browser opens are shown in Tern picture-in-picture by default; set `app.tern: false`, `browser.tern`, or `PI_BROWSER_TERN=0` to open Chromium instead.
- In Tern panes, `/fork` opens the fork in a neighboring pane while preserving the original session.
- Tern's empty composer now shows the session title, or “What are we cooking?” when no title is available.
- Tern todo cards now display their checklist by default and can be collapsed by clicking the card header.
- Improved performance across browser extraction, web and document fetching, file tools, search, session handling, LSP/DAP, MCP, subagents, SSH file operations, image processing, voice and dictation, collaboration, and large-output or large-file workflows.
- Prompt history search now updates shortly after typing stops while Enter and mouse selections use the latest query.
- Improved responsiveness and reduced resource usage for long sessions, large files and documents, streaming evaluations, terminal graphics, live voice calls, and other high-volume workflows.
- Hosts that are not supported Mastodon, Lemmy, or Discourse instances are no longer repeatedly probed for those services, improving URL-fetch performance.

### Fixed

- Fixed a message sent while an earlier title request was still running never getting its own try at naming the session when that request came back empty.
- Fixed `/new` incorrectly carrying plan mode, its plan-specific model, or goal mode into the new session.
- Fixed todo lists failing to auto-clear while subagents streamed progress.
- Fixed memory growth during ACP client-terminal commands.
- Fixed freezes after large pastes containing unclosed tags.
- Fixed slowdowns when processing long evaluation output, large Python kernel results, compiler/linter output, and ephemeral side-channel replies.
- Fixed documents served as `application/octet-stream` being downloaded twice.
- Fixed collaboration guests rebuilding the transcript excessively during streaming.

## [18.7.0] - 2026-10-06

### Added

- Added last-chance consumption of eligible banked Codex and Claude resets expiring within five minutes when auto-redeem is enabled, even with low usage or reserved credits.
- Added inline rendering of agent-generated SVG diagrams, charts, and mockups, with theme-aware colors and a `tui.renderSvg` setting to disable it.
- Added automatic chart generation for numeric tables, configurable with `tui.autoGraph` (`always`, `smart`, or `off`). The agent now chooses suitable visual formats—including charts, Mermaid, SVG, tables, or prose—based on the content. Charts and this guidance apply to the main TUI session only, not to subagents, print, RPC, or ACP.
- Added first-class JSON and JSONL querying to the `read` tool with `?q=<jq-filter>`, including in-process filtering, raw or compact output, and offset/limit pagination for efficient large-file access.
- Added `/prewalk off` to cancel a pending model handoff without changing the active model, saved prewalk setting, or continuation history.
- Added logout support to RPC clients through `get_logout_accounts` and `logout`, with matching methods in the TypeScript, Python, Go, and Rust SDKs.
- Added custom model-kind declarations for providers and extensions, allowing image, speech, embedding, judge, and other supported model roles to be registered and routed correctly.
- Added working-directory reporting for Tern terminal sessions so the native composer bar can display the current folder.

### Changed

- Improved JSON and JSONL query streaming and pagination to reduce resource usage, support partial results, and provide clearer continuation between result pages.
- Clarified the `read` tool documentation with complete examples for requesting line ranges.

### Fixed

- Fixed model-preset tests failing when provider credentials are configured in the environment.
- Fixed unauthenticated Macs auto-selecting the on-device Apple model when the default prompt exceeds its context window; Apple remains selectable explicitly.
- Fixed replay and compaction tests failing after bundled model roster changes.
- Fixed standalone builds failing when the native addon archive could not be resolved.
- Fixed JSON query parsing and parameter decoding for filters beginning with hyphens and other encoded query values.
- Fixed task execution after settings could not be saved; subagents now use the current in-memory settings while the save failure is reported as a warning.
- Fixed prewalk and model-recovery state across `/new`, handoffs, cancellations, and automatic recovery.
- Fixed login, logout, model refresh, and provider-status reporting for aliased providers such as `openai-codex-device`.
- Fixed model speed statistics mixing fast service-tier results into standard-tier averages; `/models` now reports the applicable tier separately.
- Fixed the `write` and `edit` tools hanging or consuming excessive resources when given FIFOs, terminals, device files, or other non-regular targets; unsupported targets are now rejected safely.
- Fixed long conversations losing user or tool-result images because assistant-generated images were counted against provider image limits.
- Fixed local session paths for special session IDs such as `.` and `..` so they cannot escape the intended storage directory.
- Fixed `omp gc --archive --apply` leaving orphaned session-title records behind.
- Fixed `/retry` after an interrupted process exit while an extension-driven prompt was reopening.
- Fixed browser relay sessions failing to discover or interact with cross-origin iframe content that loaded before the tab was opened.
- Fixed browser clicks on visually styled radios and checkboxes whose underlying inputs are hidden.
- Fixed `/model` failing to switch when selecting the model already assigned to a project's default role.
- Fixed `wait` returning early when a background completion had already been consumed by another operation.
- Fixed symlinked routing configurations failing to reload after their target links were replaced.
- Fixed repeated coding-plan fallback confirmations in cases involving changing thinking settings, unavailable quota information, or account recovery.
- Fixed Python evaluation failing when a shared runner temporary directory was created by another user.
- Fixed RPC clients being unable to complete multi-select questions in multi-question `ask` prompts.
- Corrected inaccurate tool and setting descriptions, including `read` ranges, background `bash` behavior, Python evaluation capabilities, edit replacement guidance, goal removal behavior, and `advisor.immuneTurns`.
- Fixed custom glob backends hanging indefinitely; scans now honor tool deadlines and cancellation.
- Fixed `--resume <path>` silently creating a new session when the specified path did not exist; it now reports the missing path.
- Fixed `/settings` opening duplicate menus when invoked while the settings menu was already open.
- Fixed native Git operations resolving repositories incorrectly when run through symbolic links.

## [18.6.3] - 2026-10-06

### Breaking Changes

- `createAgentSession` now throws `Could not restore model <provider/id>` when a resumed session's saved models cannot be restored, and `AgentSession.switchSession` throws it, keeping the current session, when it opens such a session; both still fall back with a warning when `hasUI` is set and `retry.modelFallback` is on, and hosts that cannot show that warning can opt out with `allowSessionModelFallback: false` ([#13689](https://github.com/can1357/oh-my-pi/pull/13689) by [@alphastorm](https://github.com/alphastorm)).

### Added

- Added an agents HUD pill counting running subagents, opening the agent hub on click
- In Tern the thinking level shows as the composer model chip's icon instead of a separate chip, still cycling on click, while `statusLine.compactThinkingLevel` (Compact Thinking Level, on by default) is on
- Added `computer.zoom()` and window-local `zoom()` in JavaScript and Python Eval, with native-detail region captures that preserve full-screenshot click coordinates.
- Added window menus, combined `observe()`, native application discovery/launch, live display handles, bounded input holds, human-approved task control, and macOS Space helpers in both Eval languages.
- RPC `open_session` and `switch_session` accept an optional `provider`/`modelId` pair that binds the session to that model instead of its saved one, as `--model` does at startup; `RpcClient.openSession()`/`switchSession()` and the Python client's `open_session()`/`switch_session()` take it too ([#13689](https://github.com/can1357/oh-my-pi/pull/13689) by [@alphastorm](https://github.com/alphastorm))
- Added `compat.statefulResponses` to `models.yml`, so a provider or model can opt into or out of stored Responses chaining without the process-wide `PI_OPENAI_STATEFUL` ([#13686](https://github.com/can1357/oh-my-pi/pull/13686) by [@alphastorm](https://github.com/alphastorm)).
- Added the `app.stt.pushToTalk` keybinding, defaulting to `Space`, so push-to-talk can be remapped or disabled independently from speech-to-text and `app.stt.toggle` ([#6592](https://github.com/can1357/oh-my-pi/pull/6592) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Added an `expandThinkingBlocks` setting that keeps finished thinking blocks expanded in Tern instead of collapsing them at turn end ([#14519](https://github.com/can1357/oh-my-pi/pull/14519) by [@H4vC](https://github.com/H4vC))
- RPC clients can show and toggle `/slow`: `get_state` reports `slowModeSupported`, `slowModeEnabled`, and a provider-neutral `usageLimit` (wrap-up or low-priority stage, with reset times for the client's timezone), and the new `set_slow_mode` command turns it on or off; the TypeScript client and the generated Python, Go, and Rust SDKs gain a matching `setSlowMode`/`set_slow_mode`/`SetSlowMode` method ([#14153](https://github.com/can1357/oh-my-pi/pull/14153) by [@andrebrait](https://github.com/andrebrait))
- RPC clients can now stop a turn the way Esc does in the TUI with `abort_and_restore_queue`: queued steering and follow-up messages are taken back and returned for the editor instead of running in a new turn after the abort ([#14179](https://github.com/can1357/oh-my-pi/pull/14179) by [@andrebrait](https://github.com/andrebrait))
- RPC `remove_queued_message` now returns the removed message's images, so clients can put an edited queued message back in the editor with its attachments ([#14179](https://github.com/can1357/oh-my-pi/pull/14179) by [@andrebrait](https://github.com/andrebrait))
- Added `/btw` side questions for RPC hosts: `btw` asks one (or a follow-up in an earlier topic) while the main turn keeps running, the answer streams as `btw_delta` / `btw_record` frames, `btw_cancel` stops it, and `get_btw_history` lists the session's BTW history shared with the TUI ([#14110](https://github.com/can1357/oh-my-pi/pull/14110) by [@andrebrait](https://github.com/andrebrait))
- Added the `providers.muse-code.storeResponses` setting (off by default; `PI_MUSE_STORE_RESPONSES` overrides it) to store Muse Code results on Meta's servers, so a turn whose connection drops is recovered instead of re-run ([#14534](https://github.com/can1357/oh-my-pi/pull/14534) by [@abilliontokens](https://github.com/abilliontokens)).

### Changed

- In Tern the spinner, elapsed time and intent share one activity line with the todo, which stays in place between turns, and the tok/s readout moves into the composer bar after the thinking level
- Computer-use desktop captures now default to the focused window's monitor, with primary-monitor fallback; `computer.display: all` remains available explicitly.
- Computer-use guidance selects AX for semantic controls and screenshots for custom-drawn surfaces, with grouped actions and explicit state verification.
- Bash commands that print binary or other non-UTF-8 output no longer stall while their output is decoded ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Edit previews stay responsive while long edits stream, and `read` parses large files for block context off the main thread ([#14520](https://github.com/can1357/oh-my-pi/pull/14520) by [@H4vC](https://github.com/H4vC))
- While a `sloppy`-mode edit streams, its preview no longer guesses an edit for a `*** Find` whose `*** Replace` has not arrived yet; the preview of an earlier file section that ends in a bare `*** Find` still matches what will be applied ([#14520](https://github.com/can1357/oh-my-pi/pull/14520) by [@H4vC](https://github.com/H4vC))
- `@` file mentions autocomplete faster in large repositories ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Large mermaid flowcharts and state diagrams render much faster while a response streams ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Diff hunk headers now name the enclosing function the way git does: the nearest earlier line starting with a letter, `_` or `$`, cut to 80 bytes; `#`-prefixed and indented lines are no longer picked ([#14521](https://github.com/can1357/oh-my-pi/pull/14521) by [@H4vC](https://github.com/H4vC))
- Made browser `tab.observe()` much faster on element-heavy pages, especially over the relay: listed elements are resolved to handles only when `tab.id(n)` uses them ([#14431](https://github.com/can1357/oh-my-pi/pull/14431) by [@will-bogusz](https://github.com/will-bogusz))

### Fixed

- Fixed Tern tooltips naming keys with Nerd Font icons Tern's UI font lacks (a box after "Thinking effort"); they show keycaps (`⇧⇥`) whatever the symbol preset
- Fixed `/new`, session switches, and Esc aborts hanging for up to 30 seconds while an extension's `message_end` hook was still running; they now wait only for end-of-turn maintenance.
- Fixed Tern's per-turn usage row showing a 24-hour time while the user message above it showed a 12-hour time; both now follow the terminal's clock ([#14565](https://github.com/can1357/oh-my-pi/pull/14565) by [@wolfiesch](https://github.com/wolfiesch))
- Fixed Tern's agents pill missing while a finished subagent runs again after an IRC message woke or revived it; it now counts running agents as the status-line badge does
- Fixed browser `tab.goto`, `back`, `forward` and `reload` timing out on pages whose ad, chat or other iframe never finishes loading, although the page itself had loaded ([#14421](https://github.com/can1357/oh-my-pi/pull/14421) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the token count after a snapcompact compaction (divider and RPC result) disagreeing with the context count right after it ([#14291](https://github.com/can1357/oh-my-pi/pull/14291) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed snapcompact archives stopping at 17 frames on models that read 1568px frames (OpenAI, Codex, and Claude before Opus 4.7); they now keep 26 under the same 3 MB image payload cap, and an archive whose frames run heavier than estimated is re-rendered with fewer frames instead of being rejected ([#14277](https://github.com/can1357/oh-my-pi/pull/14277) by [@will-bogusz](https://github.com/will-bogusz)).
- Preserved original-detail image pixels through both Eval runtimes instead of resizing screenshots again and requiring model-side coordinate conversion.
- Retired queued and in-flight native input on computer-run cancellation and teardown, including unawaited operations, without canceling later runs.
- Fixed the `/usage` sheet in Tern missing the Close button the other report sheets have ([#14455](https://github.com/can1357/oh-my-pi/pull/14455) by [@H4vC](https://github.com/H4vC)).
- Fixed a browser page load abandoned by cancelling a run still replacing the page afterwards; the cancelled load is now stopped, so a run that had taken over request interception also returns at once instead of failing with "Failed to restore browser request interception". Cancelling a run that is not navigating leaves the page's in-flight requests alone ([#14425](https://github.com/can1357/oh-my-pi/pull/14425) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed cancelling a bash command on Windows sometimes terminating an unrelated program ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed `umask` in a bash command changing the umask of omp itself ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed a mermaid `xychart` whose axis range is finer than floating-point precision freezing the terminal ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed resuming a session whose saved model cannot be restored silently sending its transcript to another model. At startup, `--continue`/`--resume` in print, JSON, RPC, and `rpc-ui` modes (and in the TUI with `retry.modelFallback: false`) now exits with an error naming the model instead of using the settings-default or first available model. At runtime, RPC `open_session` and `switch_session`, ACP session load and fork, and extension session switches fail with `Could not restore model <provider/id>` and keep the current session instead of continuing on the current model; TUI `/resume` warns `Could not restore model <provider/id>. Using <provider/id>`, or fails with the error when `retry.modelFallback` is off. `/resume` also restores models from discovery-backed providers the way startup does ([#12274](https://github.com/can1357/oh-my-pi/issues/12274), [#13689](https://github.com/can1357/oh-my-pi/pull/13689) by [@alphastorm](https://github.com/alphastorm)).
- Auto-retry no longer switches to the fallback chain when Codex's native turn lane rejects live steering after the response streamed reasoning; the turn retries on the same model with the steering message as ordinary input, and the chain is consulted only once no same-model retry is left ([#14242](https://github.com/can1357/oh-my-pi/pull/14242) by [@alphastorm](https://github.com/alphastorm))
- Fixed bash commands re-running a direnv `.envrc` (and devenv setup) on every call; an unchanged direnv environment is now reused ([#14310](https://github.com/can1357/oh-my-pi/pull/14310) by [@n3oney](https://github.com/n3oney)).
- Fixed the `computer` guide telling the model that refs from its earlier `ax()` reads expire; it now says an element keeps its `[ref=eN]` across reads until its role or label changes ([#14485](https://github.com/can1357/oh-my-pi/pull/14485) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed snapcompact inline imaging judging savings by the gateway's frame cost instead of the reading model's ([#14286](https://github.com/can1357/oh-my-pi/pull/14286) by [@will-bogusz](https://github.com/will-bogusz)).
- Fixed a session running past local midnight losing its earlier Claude reasoning (or failing with a 400 under strict thinking binding) because a message you sent mid-turn was rewritten with the new date ([#14339](https://github.com/can1357/oh-my-pi/pull/14339) by [@will-bogusz](https://github.com/will-bogusz)).
- Fixed OpenAI and Codex Remote Compaction V2 dropping a `/skill:` or collab prompt you sent from the kept history, and kept screenshots inflating the post-compaction token count and discarding speculative compactions ([#14247](https://github.com/can1357/oh-my-pi/pull/14247) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed cold-resumed subagents losing signed thinking because their system prompt blocks were joined ([#14338](https://github.com/can1357/oh-my-pi/pull/14338) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the first kept assistant turn losing its thinking after Anthropic native compaction, including after a date or working-directory change and on later compactions ([#14251](https://github.com/can1357/oh-my-pi/pull/14251) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed Claude rejecting or dropping the thinking kept after a compaction when the date or working directory had changed during a tool call in the kept turns; the date/cwd reminder those turns were sent with is no longer removed ([#14502](https://github.com/can1357/oh-my-pi/pull/14502) by [@H4vC](https://github.com/H4vC))
- Fixed browser `tab.waitForDownload()` and `tab.downloads()` reporting a path that does not exist when another open tab set a different `downloads` directory ([#14434](https://github.com/can1357/oh-my-pi/pull/14434) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed subagents keeping the MCP tools they started with after `/mcp reload` or adding or removing an MCP server; running and revived subagents now follow the main session's MCP tools ([#14441](https://github.com/can1357/oh-my-pi/pull/14441) by [@abilliontokens](https://github.com/abilliontokens)).
- Fixed the browser relay failing its first command on a tab that DevTools or another debugger extension already had open ([#14224](https://github.com/can1357/oh-my-pi/pull/14224) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser runs through the relay hanging and failing on pages with cross-origin iframes (embedded sign-in, payment or help widgets) ([#14228](https://github.com/can1357/oh-my-pi/pull/14228) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser clicks on Chromium and Tern tabs landing on the surrounding paragraph, without following the link, when the link wraps across two lines ([#14229](https://github.com/can1357/oh-my-pi/pull/14229) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser tab and element-handle clicks and `check`/`uncheck` on an element that never becomes clickable timing out with no reason; the timeout now names the last failed check, such as `display:none` ([#14230](https://github.com/can1357/oh-my-pi/pull/14230) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `check()`, `uncheck()` and `click()` refusing or timing out on custom-styled checkboxes and radios whose real input is transparent or drawn over by its label ([#14231](https://github.com/can1357/oh-my-pi/pull/14231) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp auth-gateway serve` advertising and routing models from providers listed in `disabledProviders`; `omp auth-gateway check` now skips those providers' credentials too ([#14234](https://github.com/can1357/oh-my-pi/pull/14234) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser calls in relay mode each waiting 35 seconds after Chrome quit and then reporting that the extension "never connected"; they now fail at once and say it disconnected ([#14236](https://github.com/can1357/oh-my-pi/pull/14236) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/shake` and other history rewrites during a running tool call leaving the context meter stale and dropping that tool call from the agent's history ([#14261](https://github.com/can1357/oh-my-pi/pull/14261) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a session using a custom `browser.relayUrl` port stopping the browser relay that other sessions were using on a different port ([#14407](https://github.com/can1357/oh-my-pi/pull/14407) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `tab.click(selector)` failing at once with "matched no visible element" when the page renders the target a moment later; it now waits like `tab.fill`, `tab.type` and `tab.dblclick` ([#14408](https://github.com/can1357/oh-my-pi/pull/14408) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `tab.fill()` and `tab.type()` on a disabled or read-only field wiping it and typing into whichever field had focus while reporting success; they now fail with the reason ([#14412](https://github.com/can1357/oh-my-pi/pull/14412) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `tab.fill(selector, "")` clearing a field without telling the page, so React and Vue forms kept and submitted the old value; the clear now fires `input` and `change` ([#14413](https://github.com/can1357/oh-my-pi/pull/14413) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `tab.waitForDownload()` missing a download started by the next tab action on tabs opened without a `downloads` directory; the file landed in the browser's default folder and the wait timed out ([#14417](https://github.com/can1357/oh-my-pi/pull/14417) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `browser.open` failing with a bare `[object ErrorEvent]` when the browser's debugger websocket refuses the connection; the error now names the endpoint and why it failed ([#14418](https://github.com/can1357/oh-my-pi/pull/14418) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser tab evaluations hanging when the page redirected again while the tab was being read; they now run on the page the redirect landed on ([#14423](https://github.com/can1357/oh-my-pi/pull/14423) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser dropdown selection resetting to the first option when given an option's visible label instead of its value, on Chrome and cmux tabs and element handles; `select()` now fails and leaves the dropdown unchanged when a value matches no option, on every backend ([#14226](https://github.com/can1357/oh-my-pi/pull/14226) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser key combos such as `Control+a` failing on Chrome tabs, frames and elements, and macOS editing shortcuts and clipboard copy/paste doing nothing ([#14225](https://github.com/can1357/oh-my-pi/pull/14225) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `tab.extract("text")` running headings, paragraphs, list items and table cells together on one line, and leaking `<script>`/`<style>` text with a `selector` ([#14227](https://github.com/can1357/oh-my-pi/pull/14227) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp dry-balance` saving a 30-day session pin to `agent.db` for every sampled session id ([#14512](https://github.com/can1357/oh-my-pi/pull/14512) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp dry-balance` rejecting `--config`; it now applies the overlay like `PI_CONFIG_FILES`, so account-policy experiments route as configured ([#14513](https://github.com/can1357/oh-my-pi/pull/14513) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp dry-balance` failing to resolve credential-scoped dynamic models, such as Factory Droid's, that `omp models` lists ([#14514](https://github.com/can1357/oh-my-pi/pull/14514) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser element right and double clicks (`click({ button, count })`) becoming one left click on Tern and cmux tabs; cmux now refuses the buttons and counts it cannot press ([#14232](https://github.com/can1357/oh-my-pi/pull/14232) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `open` and `tab.observe()` reporting a fixed 1365x768 viewport on relay, attached and visible browsers instead of the tab's real window size and pixel ratio ([#14409](https://github.com/can1357/oh-my-pi/pull/14409) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser runs and helper calls failing with "Failed to restore browser request interception" after their work had finished, including every call on pages with a hung cross-site iframe ([#14410](https://github.com/can1357/oh-my-pi/pull/14410) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `browser.open` on a page that outlasts its `timeout` closing the tab with a bare "Browser open timed out"; the tab now stays on what loaded and the error names the navigation and `browser.tab(name)`. A new tab whose navigation fails outright, or whose open is cancelled, is still closed ([#14420](https://github.com/can1357/oh-my-pi/pull/14420) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `tab.observe()` leaving out every control inside iframes (embedded sign-in, payment and checkout forms), including iframes inside a web component's shadow root under `selector`, so they got no ids to act on. An iframe that does not answer within 5 seconds is left out and skipped by later observations until it navigates ([#14415](https://github.com/can1357/oh-my-pi/pull/14415) by [@will-bogusz](https://github.com/will-bogusz))
- Pressing Esc while a queued message is about to be sent now restores it to the editor instead of the stopped turn recording it ([#14179](https://github.com/can1357/oh-my-pi/pull/14179) by [@andrebrait](https://github.com/andrebrait))
- Fixed `edit` silently dropping late LSP diagnostics from slow servers such as tsserver; they now arrive like they do for `write` ([#14214](https://github.com/can1357/oh-my-pi/issues/14214))
- Fixed multi-question `ask` dropping the ticked options of a multi-select question when the user also typed an "Other" answer; the model now receives both ([#14369](https://github.com/can1357/oh-my-pi/issues/14369))
- Focused subagents can now recall queued steering messages with Alt+Up or Shift+Up without restoring a message from the main session ([#14464](https://github.com/can1357/oh-my-pi/issues/14464)).
- Fixed results that a focused subagent submits after you prompt it in the TUI never reaching the parent agent: the subagent's `agent://<id>` artifact is now updated and the parent receives the completion ([#14428](https://github.com/can1357/oh-my-pi/issues/14428))
- Computer use on KDE Plasma Wayland now types printable characters through the keymap KWin announces instead of failing with "no usable XKB keymap was announced", and `type("…\n")` presses Enter ([#13848](https://github.com/can1357/oh-my-pi/issues/13848))
- Budget-stopped subagents no longer issue automatic retry requests after being reported cancelled; they remain available for explicit resumption ([#13892](https://github.com/can1357/oh-my-pi/issues/13892)).
- Fixed switching models mid-session keeping the previous model's `inlineToolDescriptors: auto` decision, which sent empty tool descriptions to the new model and failed with `function.description is required` ([#14200](https://github.com/can1357/oh-my-pi/issues/14200))
- Fixed advisors staying quota-paused when another account's temporary auth block ends at the retry wait limit ([#14551](https://github.com/can1357/oh-my-pi/issues/14551)).
- Fixed `omp worktree add` and other git operations failing with `git open: … does not appear to be a git repository` when the checkout directory name ends in `.git` ([#14553](https://github.com/can1357/oh-my-pi/issues/14553))
- Fixed Mnemopi embedding workers (and other local-model workers) staying alive and holding gigabytes of RAM after the omp process that started them exited mid-embedding ([#14340](https://github.com/can1357/oh-my-pi/issues/14340))
- Fixed a supervised PTY service on Windows hanging when it asks the terminal for the cursor position; the launch broker now answers the query as it does on Linux and macOS

## [18.6.2] - 2026-10-04

### Fixed

- Fixed snapcompact's short final frames preventing vision-backed sessions from continuing on backends that reject 32px-or-smaller images ([#14355](https://github.com/can1357/oh-my-pi/issues/14355)).
- Fixed the agent's `goal` calls asking for approval under `--approval-mode write`, which paused goal-mode loops at `complete`; `always-ask` still prompts for goal changes but not `get` ([#14368](https://github.com/can1357/oh-my-pi/issues/14368))
- Fixed MCP server connection progress popping up a toast for every server that connects or fails in native terminals such as Tern; it now shows only in the classic terminal transcript

## [18.6.1] - 2026-10-04

### Fixed

- Fixed waiting for subagent follow-up messages: responses now appear as background jobs that can be waited on or canceled, and are delivered only once.
- Improved `/switch` autocomplete so model and role suggestions use the same relevance ordering as the model picker, including support for `@role` aliases.
- Fixed concurrent `skill://` searches blocking other filesystem operations and delaying subagent artifact publication.
- Fixed compatibility checks for browser relays from other OMP versions and added guidance for resolving stale connection-refused errors.
- Fixed follow-up hashline edits being incorrectly rejected after earlier edits shifted anchored lines, while continuing to reject genuinely stale line references.
- Fixed `pi.exec()` reporting exit code `0` when a process was terminated by a timeout or signal; terminated processes now report code `-1`.
- Fixed `/collab` guests being unable to respond to setting-change approval and tool-issue report consent prompts.
- Fixed follow-up hashline edits being rejected as anchored on lines "never displayed" after an earlier edit shifted those lines, when the replacement carries the anchored content; genuinely stale line numbers are still rejected ([#14254](https://github.com/can1357/oh-my-pi/pull/14254) by [@abilliontokens](https://github.com/abilliontokens)).
- Fixed long `/btw` answers in Tern being clipped with no way to scroll: `/btw` now answers in the scrollable BTW history sheet ([#14331](https://github.com/can1357/oh-my-pi/pull/14331) by [@H4vC](https://github.com/H4vC))
- Fixed `/btw` answers longer than 4 KiB being cut off with `[…truncated]` once they finished ([#14331](https://github.com/can1357/oh-my-pi/pull/14331) by [@H4vC](https://github.com/H4vC))
- In Tern, Esc puts the BTW history sheet away while an answer keeps streaming (`/btw` reopens it); `x` cancels the answer ([#14331](https://github.com/can1357/oh-my-pi/pull/14331) by [@H4vC](https://github.com/H4vC))

## [18.6.0] - 2026-10-03

### Added

- The `/models` Roles view shows which saved model preset is in effect, and Ctrl+←/→ (or `p`/`P` on the role rows, for macOS where Ctrl+←/→ switches Spaces) switches to the next or previous one, in Tern and text mode ([#14210](https://github.com/can1357/oh-my-pi/pull/14210) by [@H4vC](https://github.com/H4vC))

### Changed

- Picking a model for a role in `/models` now puts the cursor on the model list, so ↑/↓ choose a model and Enter assigns it right away instead of moving through the sidebar and dropping the role selection; ← still reaches the providers ([#14210](https://github.com/can1357/oh-my-pi/pull/14210) by [@H4vC](https://github.com/H4vC))
- Sped up secret redaction on long conversations: it no longer slows down as history grows ([#14213](https://github.com/can1357/oh-my-pi/pull/14213) by [@H4vC](https://github.com/H4vC))
- Startup is faster with plugins that bundle large dependency trees: the extension loader no longer re-reads and re-checks the same files while loading them (e.g. ~280 ms → ~185 ms with the IDA MCP plugin) ([#14219](https://github.com/can1357/oh-my-pi/pull/14219) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed an `EPIPE: broken pipe` unhandled rejection crashing the session when a debug adapter, eval kernel, IDA worker, or RPC server exits mid-write (seen on Windows) ([#14196](https://github.com/can1357/oh-my-pi/pull/14196) by [@andrebrait](https://github.com/andrebrait))

## [18.5.1] - 2026-10-03

### Added

- Added RPC support for GPT live voice sessions bound to the RPC session, including live start, stop, mute, phase, level, transcript, and end events; closing stdin also stops an active live session.
- Published a machine-readable RPC wire schema and added generated-client support for Python, Rust, and Go RPC clients, including protocol v2 negotiation, prompt-result handling, host tools, and host URIs. The Python client is now distributed from the SDK package location.
- Added the read-only `archive` eval global for browsing projects and past sessions, viewing idle recaps and recap journals, opening session prompts, and searching prompt history. It is enabled by default with `archive.enabled`.

### Changed

- `wait` now waits only for background jobs and services started by the calling agent and reports an error when there is no such work to wait for; messages can still end the wait.
- Improved automatic session titles for image-only requests and mid-session refreshes so titles better reflect the user's actual goal and no longer echo placeholder text.
- In focused subagent views, submitting `.` or `c` now continues the subagent just as it does in the main session.
- Reduced memory use and loading time when forking sessions or when session history references the same image multiple times.
- The `computer` tool's `clipboard.write` now updates only the desktop clipboard and no longer sends text to the terminal clipboard via OSC 52.
- Improved terminal layout stability in Rebuild mode when resizing or zooming tmux panes.
- Advisor concerns and notes now reach an active same-run continuation after a terminal answer instead of being retained unnecessarily.

### Fixed

- Fixed background-job completions being lost when IRC-woken subagents finished while owned asynchronous work was still settling.
- Fixed session reset leaving stale hashline edit snapshots available for later mismatch diagnostics.
- Fixed multi-subagent `task` calls reporting success when one subagent failed.
- Fixed RPC clients waiting indefinitely for prompt results after automatic compaction handoffs.
- Fixed the retry prompt layout after interrupted tool calls and eliminated several TUI display issues, including flickering, duplicate streamed tool cards, blank space, and stray escape-code fragments during streaming, resizing, zooming, and clipboard or notification output.
- Fixed shared headless browsers remaining resident after a failed close; unresponsive browser instances are now replaced automatically.
- Fixed `eval` calls to extension and custom tools with strict schemas so they receive the same arguments as direct tool calls.
- Skill URI reads now expose the selected skill path, allowing nested skills to locate sibling helpers.
- Fixed strict subagent output schemas rejecting nested optional fields represented as `null`.
- Fixed reasoning-only stops and user-uninterrupted aborts leaving sessions idle instead of continuing their configured retries.
- OTLP exports now include chat request costs in spans, metrics, and completion logs, including provider charges when available and an explicit unavailable status when pricing cannot be determined.
- Fixed background Bash jobs and automatically backgrounded eval cells being terminated at their default deadlines without clear guidance; async and timeout behavior is now documented and background-start messages show the applicable deadline.
- Fixed user plugins being detected as project plugins when `HOME` has a trailing slash or resolves through a symlink.
- Fixed `collab.autoStart` failing to host a session after a transient relay connection failure; failed room creation is retried with backoff.
- Fixed the default advisor remaining at `no model` when its model becomes available after background discovery.
- Disposed SDK sessions now release spilled tool output and reject further artifact writes.
- Fixed Python Eval corrupting quoted source containing shell or magic syntax, including multiline strings.
- Fixed explicit GitHub Copilot model selections and `enabledModels` entries being replaced by similarly named bundled models when the requested model came from the cached Copilot catalog.
- Fixed copied text, Warp agent notifications, and terminal notifications occasionally corrupting the display while output streamed.
- Advisors now receive the file path for pasted or dragged images so they can open the image with `read`.
- Fixed collaboration guests queueing host-only prompts locally instead of receiving the appropriate refusal.
- `git worktree add` and `omp worktree add` now run the new worktree's `post-checkout` hook, including fallback checkouts.
- Added a warning when submitted prompts cannot be saved to persistent history until saving recovers.
- Compiled extensions can now import root-level `@oh-my-pi/pi-catalog` modules.
- Fixed idle compaction hiding the final assistant answer when advisor notes followed it.
- `omp render` and resumed sessions now preserve token counts when imported assistant messages lack cost data.
- Fixed cross-agent messages and background-job output from incorrectly closing or forging harness blocks.
- `openai-codex` model discovery now uses the configured compatible gateway for model listing without sending ChatGPT OAuth credentials to that gateway.
- Plan mode and device-only `write` sessions can now cancel their own background jobs and subagents with `write proc://<id>/kill`.
- Fixed browser relay opens stalling on discarded tabs.
- Fixed GitHub web scraping entries with deleted authors failing to render; they now display as `@ghost`.
- Fixed stale-read pruning incorrectly discarding code that had already been read after a later summarized, partial, or failed read.
- Session usage and cost totals now include Mnemopi memory completions, including billed failures before a fallback succeeds.
- Fixed Hindsight banks with more than 100 mental models losing models from context, seed setup, or listings.
- Prompts submitted during `/handoff` generation now wait for compaction to complete before starting.
- Fixed supervised PTY services receiving an unintended startup keypress.
- Fixed `bash` commands using `pty: true` missing shell environment variables, and ensured extension-provided environment changes follow session switches correctly.
- Fixed notes-backed context rollover restoring an outdated parent assignment when reviving a subagent.
- Advisor tool calls now report the advisor as the calling agent to extension tool-call and tool-result handlers.
- Fixed the IDA integration on Windows: the IDA worker crashed after its first response, and timing out or aborting an IDA request killed the worker instead of interrupting it ([#14186](https://github.com/can1357/oh-my-pi/pull/14186) by [@H4vC](https://github.com/H4vC))

## [18.5.0] - 2026-10-03

### Breaking Changes

- `task.completionProbeMs` is replaced by the on/off setting `task.completionProbe`; an existing `task.completionProbeMs` migrates automatically (`0` → off, any period → on).
- `SessionStorage.claimSessionFile(sessionPath)` is replaced by `claimSession(sessionId, sessionPath)` (which also refuses when the path now holds a different session), and `sessionOwnerLeasePath()` by `tryAcquireSessionLease(sessionId)`: custom storage backends that implemented `claimSessionFile` must implement `claimSession` to keep cross-process ownership ([#14095](https://github.com/can1357/oh-my-pi/pull/14095) by [@andrebrait](https://github.com/andrebrait))

### Added

- `/dump all` writes a zip to the temp directory with the main transcript, the LLM request JSON, and one file per subagent transcript (nested subagents included, killed ones marked aborted); the TUI copies the archive path to the clipboard. Plain `/dump` is unchanged ([#13908](https://github.com/can1357/oh-my-pi/pull/13908) by [@H4vC](https://github.com/H4vC))
- Added `/effort [level]` to set the thinking level without switching models: bare `/effort` opens a picker, and completions offer only the current model's levels within the session effort ceiling. Its description includes thinking and intelligence so either term finds it; `Shift+Tab` still cycles levels ([#12222](https://github.com/can1357/oh-my-pi/pull/12222) by [@Xytronix](https://github.com/Xytronix), [#14113](https://github.com/can1357/oh-my-pi/pull/14113) by [@andrebrait](https://github.com/andrebrait)).
- Added a per-call `model` selector to task items, eval `agent()`, and `workpool()`: a `provider/model[:level]` pattern or role alias, or an ordered array of them, that takes precedence over `task.agentModelOverrides` and the agent definition. Selection is an ordered preference — requested candidates are tried before configured fallbacks — and the spawn fails at preflight instead of silently routing elsewhere when the selector is the ambiguous literal `default`/`inherit` with or without a `:level` suffix (use `@default`), is blank or comma-only, carries an invalid thinking suffix, matches no available model, or sits on the batch container instead of a `tasks[]` item. A requested model without working credentials fails the spawn instead of running on the parent's model, and the error tells the caller to report the unavailable model rather than substitute another. A pool applies its selector to each worker's first turn and reuses that worker's session afterwards ([#12229](https://github.com/can1357/oh-my-pi/pull/12229) by [@Xytronix](https://github.com/Xytronix), [#13669](https://github.com/can1357/oh-my-pi/pull/13669) by [@andrebrait](https://github.com/andrebrait)).

### Changed

- Subagent completion estimates are asked after 2, 5, 10 and 30 more minutes, then hourly, instead of at a fixed interval, and only for subagents the main agent spawns in an interactive session; print (`-p`), RPC, ACP and SDK runs and nested subagents never request them.
- `/changelog`, `/context`, `/tools`, `/hotkeys`, `/advisor status`, `/memory view|queue|stats|diagnostics`, and the mental-model views no longer add their report to the transcript. In text mode a report that fits shows above the editor like `/btw` and Esc dismisses it; a taller one (such as `/changelog full`) opens as a full-screen page on the alternate screen, scrolled with the arrow/page/Home/End keys and the wheel, and Esc returns to the screen exactly as it was. In the native terminal it opens as a sheet like `/usage` whose long reports scroll, closed with Esc or Close ([#14136](https://github.com/can1357/oh-my-pi/pull/14136) by [@H4vC](https://github.com/H4vC)).
- `/jobs`, `/mcp help|list|resources|prompts|notifications` and `/ssh help|list` no longer add their report to the transcript either: they show the same way, and natively `/jobs` opens the live background-jobs sheet the jobs pill opens (`/jobs full` keeps the full command lines in a report sheet) ([#14138](https://github.com/can1357/oh-my-pi/pull/14138) by [@H4vC](https://github.com/H4vC)).
- The welcome banner (in the terminal and as Tern's native card) is now the `omp` logo and wordmark with the version and a tip. It no longer shows the "Welcome back!" greeting, the model (the status line does), LSP servers or recent sessions (`/resume`), and the `#` `/` `!` `$` prompt prefixes moved into the rotating tips.

### Fixed

- Auto-retry now retries the same model once after a mid-stream socket drop that had already streamed reasoning or tool calls, instead of switching to the fallback chain on the first attempt; the fallback chain is consulted only if that retry also fails. This applies to every provider, since a dropped socket says nothing about the model ([#13747](https://github.com/can1357/oh-my-pi/pull/13747) by [@abilliontokens](https://github.com/abilliontokens))
- Fixed native git patch apply, checkout, stash, cherry-pick, and worktree removal on Windows ignoring `core.autocrlf`: LF patches failed to apply to CRLF checkouts and clean CRLF files were treated as modified
- Fixed the `command` image-URL uploader stripping backslashes from Windows paths in its command template (`C:\tools\upload.exe {file}` ran `C:toolsupload.exe`)
- Fixed reading a SQLite database (local or by URL) and closing prompt history leaving the database file locked on Windows
- Fixed RPC mode on Windows freezing when the client stopped reading stdout: the worker blocked on the full stdout pipe and stopped reading stdin, so a client writing a batch of commands before reading replies deadlocked. Output now goes through a non-blocking stdout stream that spools to disk under backpressure, as on Linux and macOS
- Fixed HTML export hanging when a session's subagent directory held a transcript named `..jsonl`; discovery now only descends into real child directories ([#13908](https://github.com/can1357/oh-my-pi/pull/13908) by [@H4vC](https://github.com/H4vC))
- Fixed resuming a session through a symlink or hard link to a file another omp process is writing: the resumed session no longer mixes its turns into that file and continues in a new file next to it ([#14095](https://github.com/can1357/oh-my-pi/pull/14095) by [@andrebrait](https://github.com/andrebrait))
- Fixed moving a session to another directory replacing a session file there that another omp process is writing, or moving a session another process is writing; the move now stops with an error and leaves both files untouched ([#14095](https://github.com/can1357/oh-my-pi/pull/14095) by [@andrebrait](https://github.com/andrebrait))
- Preserve the parent’s upstream route and live reasoning effort for inherited task/eval/workpool selectors and restored workers; caller `effort`, a requested `@default:<level>`, and the agent definition's own `thinking-level` still take precedence over the inherited effort ([#12229](https://github.com/can1357/oh-my-pi/pull/12229) by [@Xytronix](https://github.com/Xytronix), [#13669](https://github.com/can1357/oh-my-pi/pull/13669) by [@andrebrait](https://github.com/andrebrait)).
- Fixed the `browser` tool's Tern backend being refused by any Tern newer than the protocol omp was built against; it now speaks Tern's protobuf session protocol (level 12), which Tern serves across builds, and a Tern from before it reports as unavailable (update Tern) so the Chromium fallback takes over.
- Fixed reloading a legacy Pi extension on Windows serving the previously loaded source instead of the edited files
- Fixed Redis-, SQL-, and in-memory session storage listing no sessions on Windows: directory listing now matches `\`-separated session paths, so `/resume` and the session picker find them
- Fixed an MCP stdio server whose configured command path does not exist failing on Windows with "MCP subprocess closed stdout before responding" instead of a not-found error naming the path
- Fixed `omp commit` never closing its credential store, leaving `agent.db` open (and a broker-backed store's sync loop running) after the commit finished
- Fixed every new session (including subagents) staying in memory for 5 seconds after creation, held by an uncancelled workspace-scan deadline timer; a parked or disposed subagent's session and settings are now released immediately
- Fixed autoresearch `run_experiment` on Windows running `autoresearch.sh` through the WSL `bash.exe` launcher found on PATH (a separate Linux environment that fails when WSL is unavailable); it now uses Git Bash or the configured `shellPath`
- Fixed sessions started in a temp-directory cwd on Windows landing under a home-relative `-AppData-Local-Temp-…` session directory instead of the `-tmp-…` one; existing directories under the old name are migrated forward
- Fixed the `write` tool claiming "Made executable via chmod +x" for shebang files on Windows, where chmod keeps no execute bits
- Fixed `readlink` in the bash tool printing a provider-backed path (e.g. `local://file`) with a `\\?\` prefix on Windows
- Fixed the daemon broker on Windows dying with the omp process that started it, which stopped the shared browser relay (and every other broker daemon) while other omp sessions were still using it
- Fixed the `browser` tool's Tern backend being refused by any Tern newer than the protocol omp was built against; it now speaks Tern's JSON script protocol, which no Tern build ties it to, and a Tern from before it reports as unavailable (update Tern) so the Chromium fallback takes over.

## [18.4.12] - 2026-10-02

### Added

- Added `omp auth-gateway stdio`: a long-lived inference server for other programs speaking JSON lines on stdin/stdout (`{"id", "path": "/v1/chat/completions", "body"}` in, `{"id", "status", "body"}` out) with your own sign-ins; a request's `model` takes any `--model` selector (`@smol`, `sonnet`, `@commit,@smol`) and falls back along `retry.fallbackChains` when an attempt fails.

### Changed

- Reduced CPU use while streaming with several agents active: extension `message_update` handlers are delivered through a lighter queue, and RPC no longer processes subagent events unless a client subscribed to them ([#13244](https://github.com/can1357/oh-my-pi/pull/13244) by [@iliaal](https://github.com/iliaal)).

### Fixed

- Fixed web search stopping at Perplexity's anonymous signup wall instead of falling back to the next configured provider ([#12756](https://github.com/can1357/oh-my-pi/issues/12756)).
- Fixed imported Claude Code sessions on Windows reporting the encoded `C--…` directory name instead of the registered project path when the transcript records no cwd ([#13363](https://github.com/can1357/oh-my-pi/pull/13363) by [@jchanghong023](https://github.com/jchanghong023)).
- Fixed JavaScript eval `wait()`/`handle.wait()` ignoring a positional timeout; `h.wait(30)` now waits up to 30 seconds like `{ timeout: 30 }`, and mixing an options object with positional arguments throws a `TypeError` ([#12720](https://github.com/can1357/oh-my-pi/pull/12720) by [@F0Rextasy](https://github.com/F0Rextasy)).
- Fixed Herdr and other lifecycle-tracking extensions showing a collab guest (`omp join`) as idle while the host is working; extension-initiated turns (`pi.sendMessage` with `triggerTurn`, `pi.sendUserMessage`) are refused as host-only while joined instead of running on the guest's local model ([#13156](https://github.com/can1357/oh-my-pi/pull/13156) by [@Fruitseller](https://github.com/Fruitseller)).
- Fixed `omp update` failing with "Malformed npm registry response … missing version" on registries such as Sonatype Nexus that answer the `/<pkg>/latest` lookup with the full package document or a non-manifest body; the updater now reads the version from the package's dist-tags ([#14115](https://github.com/can1357/oh-my-pi/pull/14115)).
- Fixed `wait` and `proc://` failing with "Daemon list request timed out" when the project daemon broker hangs; background jobs and agents are still reported, and `proc://` shows that services are unavailable ([#14120](https://github.com/can1357/oh-my-pi/pull/14120) by [@H4vC](https://github.com/H4vC)).
- Fixed `agent://<id>` showing an agent's previous published output as current while that agent runs a follow-up or wake turn; the read now says the output is from the previous run ([#14120](https://github.com/can1357/oh-my-pi/pull/14120) by [@H4vC](https://github.com/H4vC)).
- Fixed `proc://` listing agents as running when they have no turn in flight; their rows now say the run is stale or already finished, as the `jobs` tool does ([#14120](https://github.com/can1357/oh-my-pi/pull/14120) by [@H4vC](https://github.com/H4vC)).
- Changed subagents to skip their own builds, tests, and smoke runs and leave verification to the main agent, avoiding CPU spikes from many subagents verifying at once.

## [18.4.11] - 2026-10-02

### Added

- Added goal management for RPC hosts and optional automatic goal continuation via `goal.continuationModes: ["rpc"]`. RPC clients can create, inspect, pause, resume, and remove goals, and view the current goal in `get_state`.
- Added `--goal <objective>` for interactive launches to begin a new session in goal mode without requiring the `/goal` command.
- Added periodic completion estimates for running subagents, with configurable polling through `task.completionProbeMs` and progress displayed in wait and task views.
- Added the RPC `fork` command (`RpcClient.fork(entryId?)`, Python `fork(entry_id=None)`): it moves an RPC session onto a new session file holding the history up to and including any message entry (and the tool results answering a cut tool-call batch), together with the session's artifacts, or a copy of the whole session when `entryId` is omitted ([#14077](https://github.com/can1357/oh-my-pi/pull/14077) by [@andrebrait](https://github.com/andrebrait)).
- Added `reason` (`"branch"`, `"fork"` or `"btw"`) to the `session_before_branch` and `session_branch` extension and hook events, so handlers can tell whether `entryId` is dropped (`branch`) or kept ([#14077](https://github.com/can1357/oh-my-pi/pull/14077) by [@andrebrait](https://github.com/andrebrait)).

### Fixed

- Fixed skill-description and text-prediction data not respecting XDG directories; existing data is now migrated to `$XDG_DATA_HOME/omp` when applicable.
- Fixed subagent MCP calls ignoring the parent transport timeout, including configured `OMP_MCP_TIMEOUT_MS` and unlimited (`timeout: 0`) settings.
- Fixed fresh setups failing on the first turn when the automatically selected model did not support the configured thinking level.
- Fixed the `read` tool hanging and the TUI becoming unresponsive when asked to read standard input, FIFOs, or other non-regular files; these paths are now rejected.
- Fixed project configuration from `~/.omp` being incorrectly applied to unrelated working directories under the user's home directory.
- Fixed `omp update` failing on standalone-binary installs when npm advertised a version whose GitHub release was never published; the updater now installs the newest published release instead ([#12913](https://github.com/can1357/oh-my-pi/issues/12913)).

## [18.4.10] - 2026-10-02

### Added

- Added global and per-advisor review cadence, including final-yield reviews and intervals that accumulate skipped transcript updates ([#12385](https://github.com/can1357/oh-my-pi/pull/12385) by [@olegpulatov](https://github.com/olegpulatov)).
- Added per-advisor catch-up policy and cancellable `strict` waiting, so asynchronous turn reviewers can run beside synchronous final reviewers ([#12385](https://github.com/can1357/oh-my-pi/pull/12385) by [@olegpulatov](https://github.com/olegpulatov)).
- Added `/jobs full` to show each background bash job's full command line; plain `/jobs` still shortens it to fit the terminal ([#13980](https://github.com/can1357/oh-my-pi/pull/13980) by [@rickythefox](https://github.com/rickythefox))

### Changed

- Advisor notes merge at final boundaries with age markers and at most one permitted continuation per batch; advisor continuations no longer trigger recursive reviews ([#12387](https://github.com/can1357/oh-my-pi/pull/12387) by [@olegpulatov](https://github.com/olegpulatov)).

### Fixed

- Fixed `read` of an executable and `ida` hanging indefinitely while IDA's initial analysis of a large binary runs; they now give up after two minutes with an error naming the still-analyzing host, which keeps analyzing for later calls
- Fixed `await completion(...)`, `await agent(...)` and `asyncio.gather(*handles)` in Python eval cells failing with `Missing session/run/name` ([#13999](https://github.com/can1357/oh-my-pi/pull/13999))
- Fixed isolated tasks picking up edits that other agents or merges made in the parent checkout while the task was starting, which put unrelated changes on task branches
- Fixed releasing a kept-alive isolated agent creating a duplicate `omp/task/*` branch for work that had already been merged
- Fixed isolated task branch capture leaving full-checkout temporary worktrees and empty `omp/task/*` branches behind when interrupted
- Fixed merging isolated task branches stashing the entire working tree, which rewrote every Git LFS file and left `omp-task-merge` stash entries; merges now touch only the picked files and combine them with your unstaged edits
- Fixed `openai-models-list` discovery to honor nested OpenAI model-list input/output token limits while preserving explicit top-level context precedence ([#13988](https://github.com/can1357/oh-my-pi/pull/13988) by [@github-nicolas-stadler](https://github.com/github-nicolas-stadler))
- Fixed importing `@oh-my-pi/pi-coding-agent` source from an installed package (SDK, extension loader, bun-global `omp`) failing with `Export named 'createRatchetPrelude' not found` ([#14027](https://github.com/can1357/oh-my-pi/issues/14027))
- Fixed finished subagent runs staying in memory for as long as the session that spawned them, through an abort listener left on the session's signal ([#14038](https://github.com/can1357/oh-my-pi/pull/14038) by [@theolundqvist](https://github.com/theolundqvist)).
- Fixed print, RPC and ACP runs recording startup timing spans for their whole lifetime, which grew memory with every session and subagent they started ([#14039](https://github.com/can1357/oh-my-pi/pull/14039) by [@theolundqvist](https://github.com/theolundqvist)).
- Fixed parked subagents keeping their spawn-time run state and settings in memory until the process exits, which grew memory with every subagent a long session spawned ([#14040](https://github.com/can1357/oh-my-pi/pull/14040) by [@theolundqvist](https://github.com/theolundqvist)).
- Fixed parked and disposed agent sessions keeping their persistent shell (about 70 KB of native memory each) for the life of the process; a revived subagent now starts with a fresh shell ([#14042](https://github.com/can1357/oh-my-pi/pull/14042) by [@theolundqvist](https://github.com/theolundqvist)).
- Fixed discovered models' request headers nesting one level deeper on every model refresh, which grew memory and per-request work in long sessions with many subagents ([#14041](https://github.com/can1357/oh-my-pi/pull/14041))
- RPC `prompt`, `steer`, and `follow_up` run native `input` handlers in submission order and acknowledge `prompt` only after admission, so a later prompt cannot overtake an idle image skill during vision description, an abort accepted during an earlier hook cancels that frame instead of letting it start a new turn, and a skill failure after the acknowledgement rejects `RpcClient.promptAndWait` instead of being dropped ([#13027](https://github.com/can1357/oh-my-pi/pull/13027) by [@andrebrait](https://github.com/andrebrait)).
- Fixed test suite failures on non-FHS hosts and under ambient terminal and Git configuration ([#12358](https://github.com/can1357/oh-my-pi/pull/12358) by [@olegpulatov](https://github.com/olegpulatov)).
- Fixed late TTSR matches on short tool calls ending a run before the rule interrupt reaches the model ([#14018](https://github.com/can1357/oh-my-pi/issues/14018)).
- Fixed `omp gc --apply` holding `history.db` and `stats.db` open until exit, which left an empty `history.db-wal` behind after a WAL checkpoint ([#14043](https://github.com/can1357/oh-my-pi/issues/14043)).
- Fixed coding-agent session and gc tests failing on Windows ([#14043](https://github.com/can1357/oh-my-pi/issues/14043)).
- Fixed background skill-description compression requests emitting no OTLP chat span or token usage ([#14056](https://github.com/can1357/oh-my-pi/pull/14056) by [@xaviergmail](https://github.com/xaviergmail)).
- Fixed same-ID runtime API replacements carrying a prior route's prompt-cache lifetime into a route without a cache policy ([#13966](https://github.com/can1357/oh-my-pi/pull/13966) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Hashline edits no longer reject fully read lines below an earlier same-file edit as "never displayed" when that edit left them at the same line number ([#13983](https://github.com/can1357/oh-my-pi/issues/13983))
- Fixed `read agent://<id>` returning `Not found` for a running agent (dotted child ids and agents that only submitted non-terminal `yield` sections included) while `write agent://<id>` reached it; the read now shows the agent's status, its yields so far, and its latest text, an unknown id suggests at most five near ids instead of listing every output, and bare `read history://` refreshes the caller's persisted roster like `history://<id>` does ([#14000](https://github.com/can1357/oh-my-pi/pull/14000) by [@radkawar](https://github.com/radkawar))
- Fixed `enabledModels`/`--models` entries naming a judge, search, image, or speech model logging `No models match pattern` on every startup ([#14016](https://github.com/can1357/oh-my-pi/issues/14016))
- Fixed local-memory startup consolidation rebuilding the system prompt of a conversation that had already sent requests, which invalidated its signed thinking blocks; the new summary now applies from the next session ([#14019](https://github.com/can1357/oh-my-pi/pull/14019) by [@nick-maderight](https://github.com/nick-maderight))
- Fixed the Darwin Nix flake / NixOS module build producing an `omp` that fails to start after `nix-collect-garbage` with `Library not loaded: /nix/store/…-libiconv-…` by repointing the embedded native addon's `libiconv` install name at the system library and failing the build if the addon references any `/nix/store` path ([#13992](https://github.com/can1357/oh-my-pi/pull/13992) by [@krzysztofkusmierczyk](https://github.com/krzysztofkusmierczyk)).
- Fixed `/context` and clicks on the status-line context meter stacking a new Context Usage card every time; the existing card is refreshed in place, or moved to the bottom if newer blocks follow it
- Fixed the jevify keyword notice teaching the removed `judge()` handle API, so agents following it failed on the first judge cell; it now uses `judge_batch()` ([#13588](https://github.com/can1357/oh-my-pi/issues/13588), [#13698](https://github.com/can1357/oh-my-pi/pull/13698) by [@holny](https://github.com/holny))

## [18.4.9] - 2026-10-01

### Added

- Added opt-in stale-session garbage collection with `omp gc --stale` or `gc.stale`, removing orphaned session markers and terminal breadcrumbs and expiring old debug reports and collaboration replicas according to configurable retention limits.
- Added RPC controls to cancel or steer individual foreground and background subagents without aborting the session.
- Added RPC word-completion commands so web and IDE hosts can provide the same ghost-text completion available in the terminal editor.
- Added an opt-in RPC ask-dialog mode that lets hosts render all questions together with checkbox or radio-button controls and submit their answers in one response.
- Added SDK notifications when a session moves to a new persistence file, including the previous and new paths.
- Added SDK APIs to inspect and cancel background jobs, including their command, working directory, process IDs, exit status, and captured output.

### Changed

- Improved the `omp predict` comparison view with an interactive native interface, table rows, action controls, and clearer status information.
- Improved MCP authorization prompts with clickable links, native copy/open context menus, and a clearer URL layout.
- RPC hosts are now notified when omp cancels an expired `select`, `confirm`, `input`, or `ask` dialog, allowing stale UI prompts to be closed.
- Limited saved bash, Python, and JavaScript evaluation output artifacts to 16 MB by default while preserving both the beginning and latest output; configure the limit with `tools.artifactMaxBytes`, or set it to `0` for unlimited output.

### Fixed

- Fixed `/wt` on filesystems without copy-on-write cloning, including NTFS, so unchanged files are not incorrectly marked modified and staged edits, additions, and deletions retain the correct contents.
- Fixed Windows Ctrl+V taking about a second to paste by avoiding unnecessary PowerShell clipboard checks.
- Fixed `local://` paths being misinterpreted as local filesystem paths by the `read`, `write`, and search tools.
- Fixed `read` handling of semicolon-separated URLs, local paths, and line selectors so each entry is processed independently.
- Fixed session persistence conflicts between multiple omp processes, preventing lost or interleaved turns and continuing in a new session file when necessary.
- Fixed session image handling to avoid unnecessary rewrites, preserve images after interrupted writes, and prevent garbage collection from removing images that are referenced again.
- Reduced unnecessary disk writes and improved persistence efficiency across sessions, model data, configuration, and background jobs.
- Fixed the native composer showing the main session's effort level instead of the selected subagent's level.
- Fixed the `omp predict` comparison view and MCP authorization prompt rendering with their full native interfaces, including clickable link actions.

## [18.4.6] - 2026-10-01

### Added

- Added a live Background Jobs view that lets you monitor running background jobs without interrupting the transcript.
- Added agent lineage navigation, making it easy to move between subagents and the main session from the composer header.
- Added queued-message controls to the RPC clients and session API, including promotion of queued follow-ups to steering messages without duplicating text or losing attachments, plus explicit steering or follow-up behavior for prompts sent while the agent is busy.
- Added support for keeping Claude prompt caches warm on Amazon Bedrock and Bedrock Mantle according to configured model cache lifetimes and retention settings.
- In Tern terminals, the effort indicator now visualizes the selected thinking level and becomes a fireball at the maximum level.

### Changed

- RPC prompt requests now acknowledge only after the message has been accepted for processing, queued, or routed to an extension command, so subsequent queue-management operations can act on the admitted message reliably.
- Idle recaps now appear as structured notices in the transcript rather than status-line messages.
- Attached-image descriptions for text-only models now time out after 20 seconds and stop when aborted, while preserving the image and informing the model when a description is unavailable.
- The status line now separates the session's own cost from total subagent spend, including nested, background, and resumed subagents, and matches the Agent Hub total.
- Tool-use reminders are now delivered as separate developer messages, keeping them distinct from tool output.
- Reworked Tern transcript navigation and presentation: Esc-Esc rewind now uses the transcript with turn-by-turn and branch navigation, attached images open in Tern's image viewer, idle recaps remain unobtrusively in the transcript, and the background-jobs pill opens the live jobs view.
- Tern now reports agent activity through terminal progress consistently, and its progress and agent indicators update smoothly during subagent work.

### Fixed

- Fixed Tern commands issued while the agent is working so they appear immediately in the transcript instead of being clipped above the prompt.
- Added a dismiss action for Tern's prompt-area error notifications.
- Fixed dollar signs in prompts being mistaken for Python mode until a following space confirms the mode.
- Fixed turns getting stuck in a working state when post-turn maintenance, such as saving the session, fails; the session now becomes idle and reports a warning.
- Fixed failed tool-output pruning from leaving live context out of sync with saved history.
- Fixed oversized or undersized attached images being distorted when resized to fit display limits.
- Fixed interrupted tool calls disappearing from the model's context after resuming a stopped session.
- Fixed aborted prompts with images still being prepared from starting or entering the queue afterward.
- Fixed aside messages containing pasted image or video paths so the source path is preserved when sent to the model.
- Fixed extension-registered prompt-cache settings, including explicit opt-outs, not taking precedence over matching models.yml definitions.
- Fixed prompt-cache warming to honor cache-retention settings, including disabling replay for no-retention caches and using the lifetime written by long-retention requests.

## [18.4.5] - 2026-09-30

### Added

- Added Factory Droid login and model selection with base credit badges and account-matched regional discovery ([#8577](https://github.com/can1357/oh-my-pi/pull/8577) by [@will-bogusz](https://github.com/will-bogusz), continued in [#13276](https://github.com/can1357/oh-my-pi/pull/13276) by [@DusKing1](https://github.com/DusKing1)).
- Added `HELMCODE_API_KEY` to the environment variables listed in `omp --help` ([#13630](https://github.com/can1357/oh-my-pi/pull/13630) by [@alexcerezo](https://github.com/alexcerezo)).
- RPC hosts can send `messageUpdates: "delta"` with `set_event_filter` to receive `message_update` frames without the accumulated message snapshots (`message` shrinks to `{ role }` and `assistantMessageEvent.partial` is omitted); the response echoes the active mode ([#13716](https://github.com/can1357/oh-my-pi/pull/13716) by [@alphastorm](https://github.com/alphastorm))
- RPC hosts can follow each cache-warming refresh through `cache_warming_start` and `cache_warming_end` events (also written by `--mode json`), which report the outcome and the recorded usage, and can set the session's warming mode with `set_cache_warming` without changing `config.yml`; the Python client gains `set_cache_warming()` ([#13717](https://github.com/can1357/oh-my-pi/pull/13717) by [@alphastorm](https://github.com/alphastorm))
- The `/review` and `/annotate code-review` menus have a "Review a specific PR" option that lists the repository's open pull requests, with server-side search and a `#123` shortcut ([#12399](https://github.com/can1357/oh-my-pi/pull/12399) by [@abilliontokens](https://github.com/abilliontokens))
- Pinned Subagents rows can show each agent's current (or most recent) tool call with a one-line detail and an elapsed marker; enable with `display.subagentLivePreview` (off by default) ([#3821](https://github.com/can1357/oh-my-pi/pull/3821) by [@abilliontokens](https://github.com/abilliontokens))
- Model presets: save every role assignment plus the default thinking level under a name and switch between them with `/modelpreset save|switch|delete|list`, pick one interactively with `/modelpreset`, or press `s` in the `/models` Roles view to save the current setup ([#5253](https://github.com/can1357/oh-my-pi/pull/5253) by [@abilliontokens](https://github.com/abilliontokens))
- Subagent tool previews name the files a freeform edit (`apply_patch`, sloppy, hashline) touches ([#11210](https://github.com/can1357/oh-my-pi/pull/11210) by [@DarkPhilosophy](https://github.com/DarkPhilosophy)).

### Changed

- `omp auth-gateway serve` now attributes peers to the socket address by default; deployments behind a trusted reverse proxy can restore forwarded peer headers with `--trust-proxy-headers` ([#13827](https://github.com/can1357/oh-my-pi/pull/13827) by [@shawnkoh](https://github.com/shawnkoh))
- `--no-ui` now also works with `--mode rpc-ui`: extensions run headless while tool UI such as the `ask` tool still reaches the host ([#13718](https://github.com/can1357/oh-my-pi/pull/13718) by [@alphastorm](https://github.com/alphastorm))
- `omp models --json` reports each model's `pricingStatus` (`fixed`, `free`, `included`, `variable`, or `unknown`) ([#11613](https://github.com/can1357/oh-my-pi/pull/11613) by [@will-bogusz](https://github.com/will-bogusz)).

### Fixed

- Fixed the subagent live preview blanking or mislabelling a running call when a sibling call finishes: concurrent calls are tracked by call id and keep their own intent, and the row keeps the last completed call with its success or error mark until the next one starts ([#11210](https://github.com/can1357/oh-my-pi/pull/11210) by [@DarkPhilosophy](https://github.com/DarkPhilosophy)).
- Fixed subagent tool previews rewriting a search pattern that names a home directory: path arguments are now shortened by argument key, so the pattern still shows what was searched ([#11210](https://github.com/can1357/oh-my-pi/pull/11210) by [@DarkPhilosophy](https://github.com/DarkPhilosophy)).
- Fixed background task job progress dropping the current tool's arguments and start time ([#11210](https://github.com/can1357/oh-my-pi/pull/11210) by [@DarkPhilosophy](https://github.com/DarkPhilosophy)).
- Replying `c` during a `/guided-goal` interview now sends `c` as your answer instead of triggering the continue shortcut ([#13819](https://github.com/can1357/oh-my-pi/pull/13819) by [@H4vC](https://github.com/H4vC))
- Cache-warming refreshes cancelled or superseded after the provider accepted them now count toward session usage and cost instead of being dropped ([#13717](https://github.com/can1357/oh-my-pi/pull/13717))
- Fixed Cursor turns that fail with "Cursor stream ended before turnEnded" stopping instead of continuing with their completed tool results kept ([#13684](https://github.com/can1357/oh-my-pi/pull/13684) by [@eggpeat](https://github.com/eggpeat))
- `omp plugin upgrade <name>` now upgrades npm- and git-installed plugins (e.g. `ida-mcp` installed from `github:HexRaysSA/ida-mcp#latest`, which `hcli mcp install` relies on) and resolves a bare marketplace plugin name, instead of failing with "Invalid plugin ID"; the plugin's enabled state and feature selection are kept ([#13812](https://github.com/can1357/oh-my-pi/pull/13812) by [@H4vC](https://github.com/H4vC))
- Extension providers that offer `/login` and also name an env var as their `apiKey` (e.g. the Nexos provider's `NEXOS_API_KEY`) now use the key saved by `/login` when that env var is unset, instead of sending the env var's name as the key, which made their models fail to load or disappear ([#13815](https://github.com/can1357/oh-my-pi/pull/13815) by [@H4vC](https://github.com/H4vC))
- Reduced memory held by finished subagents during long sessions ([#13624](https://github.com/can1357/oh-my-pi/pull/13624) by [@iliaal](https://github.com/iliaal)).
- Fixed role and subagent `retry.fallbackChains` being skipped once the session's thinking level differed from the role's configured one (e.g. `task: grok-4.7:high` running at `:xhigh`), and cold-revived subagents losing the fallback chain they were spawned with ([#13789](https://github.com/can1357/oh-my-pi/issues/13789))
- Fixed compiled OMP extensions importing `@oh-my-pi/pi-catalog` and its provider-model subpaths ([#13731](https://github.com/can1357/oh-my-pi/issues/13731)).
- Explicit `symbolPreset: unicode` now stays Unicode after a Glyph Protocol handshake instead of switching the status bar to Nerd Font icons ([#13865](https://github.com/can1357/oh-my-pi/issues/13865)).
- Fixed rewinding (`/rewind`, `/tree`) during a running turn hiding the queued-prompt bar, making the still-pending queue look deleted and uneditable ([#13680](https://github.com/can1357/oh-my-pi/issues/13680))

## [18.4.4] - 2026-09-29

### Added

- Added `compat.bedrockMessagesApi` to `models.yml`, so Claude reached through a proxy or an `ANTHROPIC_BASE_URL` reroute to Bedrock's `/anthropic` API gets Bedrock request shaping and on-demand compaction; `false` opts a Bedrock URL out ([#13311](https://github.com/can1357/oh-my-pi/pull/13311)).
- Submitting exactly `exit`, `quit`, or `q` (any case, no leading `/`, nothing else in the input) in a session with no messages now quits; turn off with `input.bareExitOnEmptySession` ([#13755](https://github.com/can1357/oh-my-pi/pull/13755) by [@H4vC](https://github.com/H4vC))
- Added the opt-in `input.bareSlashCommands` setting (Interaction > Input): submitting exactly a command name without the leading `/` (e.g. `model`, `compact`, a skill or extension command) runs that slash command. Before the first message it runs at once; after that, the first Enter asks for confirmation and a second Enter runs it (a leading space sends the word as a message) ([#13780](https://github.com/can1357/oh-my-pi/pull/13780) by [@H4vC](https://github.com/H4vC))
- Extensions can now rewrite finalized assistant-message text through the awaited `assistant_message` hook before it reaches context, history, and `message_end` ([#13769](https://github.com/can1357/oh-my-pi/pull/13769) by [@NaC-L](https://github.com/nac-l))
- In Tern (`TERM_PROGRAM=tern`), omp reports its session file to the terminal (OSC 1337 user variable `omp_session_file`) at start and whenever the session changes, so an agent pane Tern's daemon restores after a crash or restart resumes the same session with `--resume`
- Added `additionalContext` to extension and hook `tool_result` results, so success- and failure-specific post-tool guidance reaches the model through the trusted developer channel instead of altering tool output ([#13267](https://github.com/can1357/oh-my-pi/pull/13267) by [@andrebrait](https://github.com/andrebrait)).
- The `ask` tool's custom-answer and note prompts accept pasted images, which reach the model with the answer ([#13774](https://github.com/can1357/oh-my-pi/pull/13774) by [@DrFaustus-vic](https://github.com/DrFaustus-vic))
- Added `/fast ultra` to select OpenAI's Ultrafast service tier on models that offer it (OpenAI API with preview access, or Codex models that advertise it, such as GPT-6.1 Sol once Ultrafast rolls out); `/fast off` clears it and `/fast status` reports `ultra`. `ultrafast` is also accepted by `tier.openai`, `tier.subagent`, `tier.advisor`, and `--service-tier` ([#13782](https://github.com/can1357/oh-my-pi/pull/13782) by [@H4vC](https://github.com/H4vC)).
- RPC clients can now cancel one pending steering or follow-up message with `remove_queued_message`, including its hidden attachment context, without aborting the turn or changing other queued work ([#11872](https://github.com/can1357/oh-my-pi/pull/11872) by [@andrebrait](https://github.com/andrebrait)).
- Added typed queued-message removal to the official Python RPC client, including validated success and refusal results ([#11872](https://github.com/can1357/oh-my-pi/pull/11872) by [@andrebrait](https://github.com/andrebrait)).
- RPC clients can now render the actual pending-message queue instead of tracking it themselves: `get_state` reports a `queuedMessages` snapshot and a new `queue_update` event reports it live as steering/follow-up messages are queued, delivered, removed, or cleared ([#11872](https://github.com/can1357/oh-my-pi/pull/11872) by [@andrebrait](https://github.com/andrebrait)).

### Changed

- `omp stats --summary` now labels costs as API-equivalent estimates and shows subscription usage that has no reference price as `N/A` instead of `$0.0000`, matching `omp-stats`.

### Fixed

- Fixed the `mnemopi.polyphonicRecall` and `mnemopi.enhancedRecall` settings (and `MNEMOPI_POLYPHONIC_RECALL` / `MNEMOPI_ENHANCED_RECALL`) having no effect: polyphonic recall now surfaces graph- and fact-linked memories, enhanced recall caches repeated recalls until the next memory write, and both apply per session instead of through process-wide defaults ([#2323](https://github.com/can1357/oh-my-pi/issues/2323))
- Fixed `computer.window(74)` matching every open window and `computer.window({ id: 74 })` matching none; a numeric id now resolves the same window as `"74"` ([#13649](https://github.com/can1357/oh-my-pi/pull/13649) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/fast on` showing fast mode as active on Codex models whose discovered service tiers list others but not priority; it now reports that fast mode is unavailable for the current model. Models whose tier list is empty keep `/fast` ([#13782](https://github.com/can1357/oh-my-pi/pull/13782) by [@H4vC](https://github.com/H4vC)).
- Cancelling a concurrently queued prompt now preserves the other prompt's hidden keyword context instead of removing it with the cancelled message ([#11872](https://github.com/can1357/oh-my-pi/pull/11872) by [@andrebrait](https://github.com/andrebrait)).
- Hidden attachment context and its queued prompt are now claimed together in `one-at-a-time` mode, preventing successful cancellation after only the companion has been delivered ([#11872](https://github.com/can1357/oh-my-pi/pull/11872) by [@andrebrait](https://github.com/andrebrait)).
- Queued RPC skill commands retain their original invocation for cancellation, and queue editing no longer treats agent-attributed user-role messages as user input ([#11872](https://github.com/can1357/oh-my-pi/pull/11872) by [@andrebrait](https://github.com/andrebrait)).
- Builtin slash commands (including `/record` and `/skills`) no longer erase a draft typed after Ctrl+Enter detached its submission from the editor ([#13026](https://github.com/can1357/oh-my-pi/pull/13026) by [@andrebrait](https://github.com/andrebrait))
- Failed detached submissions, including Ctrl+Enter `/queue`, and failed Enter `/plan`, `/vibe`, `/goal`, or `/guided-goal` commands now restore their text and attachments beside newer typing, with image markers remapped ([#13026](https://github.com/can1357/oh-my-pi/pull/13026) by [@andrebrait](https://github.com/andrebrait))
- Native extension input handlers now intercept main-session Ctrl+Enter, including queued input, with consistent transformations ([#11834](https://github.com/can1357/oh-my-pi/pull/11834) by [@andrebrait](https://github.com/andrebrait))
- `/plan`, `/vibe`, `/goal`, or `/guided-goal` with attachments that starts no turn (for example `/plan` while goal mode is active) now restores its text and attachments beside newer typing instead of re-attaching only its images ahead of the newer draft's own ([#11834](https://github.com/can1357/oh-my-pi/pull/11834) by [@andrebrait](https://github.com/andrebrait))
- Same-named skills from different sources are no longer silently discarded. A duplicate with identical content still collapses without a warning; otherwise the higher-precedence skill (an authored skill over an installed package, a custom-directory skill over a provider skill, else whichever loaded first) keeps its bare name and the other stays reachable as `<namespace>/<name>` via `skill://<namespace>/<name>` and `/skill:<namespace>/<name>`, with a collision warning naming both files. Skill names containing `/` or `\` are now rejected for every provider and custom directory, since `/` is reserved for that addressing ([#12151](https://github.com/can1357/oh-my-pi/pull/12151) by [@andrebrait](https://github.com/andrebrait))
- Added native HUD and UI elements (status, tool cards, usage heatmap) for TSP terminals
- Added support for native-only session info and job dashboard views in TSP terminals
- Inside a Tern pane, the browser tool opens tabs as browser picture-in-pictures over omp's pane and drives their native web view (trusted input, ARIA snapshots, screenshots, PDF, dialogs, downloads, cookies, console, fetch/XHR routes and HAR, recording); it falls back to Chromium when no Tern window can host them. Opt out with `browser.tern`, `PI_BROWSER_TERN=0` or `app.tern: false`; `app.tern: true` requires it
- Fixed the startup "what's new" notice dropping the last unseen release when it was the final section of a changelog ending in a newline.
- xAI web search honors `XAI_BASE_URL` again when the selected model uses the bundled `https://api.x.ai/v1` endpoint; a custom `baseUrl` from models.yml still wins, and official `xai-oauth` OAuth credentials always stay on the bundled endpoint (API keys, including command-backed ones, follow the override as in chat and image generation).

### Removed

- Removed the bash tool's `env` parameter; services inherit the configured shell environment

Older entries are archived in [packages/coding-agent/CHANGELOG.md@5041889e64d3](https://github.com/can1357/oh-my-pi/blob/5041889e64d39ab59633bbc45b6dbb143fc936cc/packages/coding-agent/CHANGELOG.md).
