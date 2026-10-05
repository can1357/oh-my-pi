# Changelog

## [Unreleased]

### Breaking Changes

- `createAgentSession` now throws `Could not restore model <provider/id>` when a resumed session's saved models cannot be restored, and `AgentSession.switchSession` throws it, keeping the current session, when it opens such a session; both still fall back with a warning when `hasUI` is set and `retry.modelFallback` is on, and hosts that cannot show that warning can opt out with `allowSessionModelFallback: false` ([#13689](https://github.com/can1357/oh-my-pi/pull/13689) by [@alphastorm](https://github.com/alphastorm)).

### Added

- RPC `open_session` and `switch_session` accept an optional `provider`/`modelId` pair that binds the session to that model instead of its saved one, as `--model` does at startup; `RpcClient.openSession()`/`switchSession()` and the Python client's `open_session()`/`switch_session()` take it too ([#13689](https://github.com/can1357/oh-my-pi/pull/13689) by [@alphastorm](https://github.com/alphastorm))
- Added `compat.statefulResponses` to `models.yml`, so a provider or model can opt into or out of stored Responses chaining without the process-wide `PI_OPENAI_STATEFUL` ([#13686](https://github.com/can1357/oh-my-pi/pull/13686) by [@alphastorm](https://github.com/alphastorm)).
- Added the `app.stt.pushToTalk` keybinding, defaulting to `Space`, so push-to-talk can be remapped or disabled independently from speech-to-text and `app.stt.toggle` ([#6592](https://github.com/can1357/oh-my-pi/pull/6592) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).

### Changed

- Bash commands that print binary or other non-UTF-8 output no longer stall while their output is decoded ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- `@` file mentions autocomplete faster in large repositories ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Large mermaid flowcharts and state diagrams render much faster while a response streams ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed the `/usage` sheet in Tern missing the Close button the other report sheets have ([#14455](https://github.com/can1357/oh-my-pi/pull/14455) by [@H4vC](https://github.com/H4vC)).
- Fixed cancelling a bash command on Windows sometimes terminating an unrelated program ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed `umask` in a bash command changing the umask of omp itself ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed a mermaid `xychart` whose axis range is finer than floating-point precision freezing the terminal ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed resuming a session whose saved model cannot be restored silently sending its transcript to another model. At startup, `--continue`/`--resume` in print, JSON, RPC, and `rpc-ui` modes (and in the TUI with `retry.modelFallback: false`) now exits with an error naming the model instead of using the settings-default or first available model. At runtime, RPC `open_session` and `switch_session`, ACP session load and fork, and extension session switches fail with `Could not restore model <provider/id>` and keep the current session instead of continuing on the current model; TUI `/resume` warns `Could not restore model <provider/id>. Using <provider/id>`, or fails with the error when `retry.modelFallback` is off. `/resume` also restores models from discovery-backed providers the way startup does ([#12274](https://github.com/can1357/oh-my-pi/issues/12274), [#13689](https://github.com/can1357/oh-my-pi/pull/13689) by [@alphastorm](https://github.com/alphastorm)).
- Auto-retry no longer switches to the fallback chain when Codex's native turn lane rejects live steering after the response streamed reasoning; the turn retries on the same model with the steering message as ordinary input, and the chain is consulted only once no same-model retry is left ([#14242](https://github.com/can1357/oh-my-pi/pull/14242) by [@alphastorm](https://github.com/alphastorm))

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

### Changed

- Changed `read` to expand local globs (`src/*.js`) into per-file snapshots, sorted and capped at 50 files, so agents batch orientation reads through `read` instead of `cat` and keep anchors for edits ([#14085](https://github.com/can1357/oh-my-pi/pull/14085) by [@NaC-L](https://github.com/NaC-L)).

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

## [18.4.3] - 2026-09-28

### Added

- Batch `task` calls now start each subagent as soon as its `tasks[]` item finishes streaming instead of waiting for the whole call; launched agents are aborted if the finished call is invalid, blocked, or changed. Controlled by `task.speculativeLaunch` (default on; requires auto-allowed task approval and no extension tool lifecycle handlers)
- Set `PI_SMART_GIT=1` to have every `git worktree add` in the bash tool — including inside compound commands, functions, and loops — copy-on-write clone the checkout (APFS, btrfs/XFS reflink, ReFS) instead of checking out every file, so new worktrees start with ignored build caches (`target/`, `node_modules/`) already in place; every `worktree add` option except `--orphan`, `--no-checkout`, `--track`, and `--relative-paths` is handled, and anything else still runs real git.
- In terminals that speak the Tern Surface Protocol, the working row, todo HUD, subagent HUD, judge/download progress rows, retry hint and stream console are native: the working spinner, message shimmer, elapsed timer and tok/s are terminal-clocked, todos are a phase tree with a progress bar, and clicking a subagent row focuses that agent
- `/usage` refreshes its reports with `r`. In terminals that speak the Tern Surface Protocol it is a glass sheet: provider frames with per-window meters, reset times and banked-reset badges, and a year of activity as a native heatmap with per-day tooltips; `/context` is one frame with a block grid, a legend and a bar marked at the compaction threshold; `/session` info gains a context meter; `/jobs` shows task jobs as live agent rows; `/stats` adds an Open dashboard button
- In terminals that speak the Tern Surface Protocol, MCP tool calls are native cards (an argument grid while running, then a collapsed Args section over highlighted JSON or markdown results) instead of the generic tool card; custom tools can supply their own `describeCall`/`describeResult` hooks for native views
- In terminals that speak the Tern Surface Protocol, a sent prompt's bubble shows its attached images above the text (click one to open the file) and keeps its attachment, skill and model-mention tokens highlighted as the composer drew them
- In terminals that speak the Tern Surface Protocol there is no status bar: the session name (and the branch's PR) is the tab title, Tern's pane header shows the path and branch, each finished turn ends with its time, tokens and cost, the composer carries a model chip (click to switch), an effort meter (click to cycle), a context hairline along its top edge and the context share and session cost, and other configured status segments sit as small facts in the composer; background jobs get a HUD pill
- Added the `/ratchet [flow and goal]` command: the agent asks one batched round of setup questions, builds (or reuses) an eval for the flow you name, gets three approvals (inputs, grader, plan), then hillclimbs it unattended, keeping a change only when it beats the best round on both train and held-out cases. It enables a new `ratchet(flow)` eval global for the session (docs at `xd://eval/ratchet`; persist with `ratchet.enabled`) that stores state in `.omp/ratchet/<flow>/`, invalidates approvals when the approved files change, and prices runs from the model catalog ([#13672](https://github.com/can1357/oh-my-pi/pull/13672) by [@H4vC](https://github.com/H4vC))

### Changed

- Running `omp "prompt"` without a terminal on stdin (scripts, CI, `</dev/null`) now runs the prompt headless like `-p`; a bare `omp` without a terminal exits 2 with an error instead of exiting silently ([#13623](https://github.com/can1357/oh-my-pi/pull/13623) by [@H4vC](https://github.com/H4vC))
- Invalid `--thinking`, `--approval-mode`, and `--mode` values are now rejected with a usage error (exit 2) listing the valid values, instead of being silently ignored ([#13623](https://github.com/can1357/oh-my-pi/pull/13623) by [@H4vC](https://github.com/H4vC))
- The default web search chain is now free-only: Parallel, the session's own model (new `web/hosted`), Exa, Firecrawl, SearXNG, and the credential-free scrapers. Paid engines (Perplexity, Tavily, Brave, Kagi, …) and other providers' chat models run only when you set them on the `web` role or its fallback chain.
- Parallel, Exa, and Firecrawl now run their keyless endpoints in the automatic chain instead of only when explicitly selected.
- Perplexity search no longer falls back to your OpenRouter key; select `openrouter/perplexity/…` explicitly to search through OpenRouter.
- Hosted web search now follows the model rather than the host: GPT-5+ over any Responses API, Claude 4+ over any Messages API, and Gemini 2+ (including Gemini CLI), so `web/hosted` works through proxies and gateways. A model-backed search that returns no sources now counts as a failure, so the chain moves on to the next engine instead of showing an unsourced answer.
- `web/hosted` first tries a cheaper model on the session's own provider (e.g. Opus → Haiku, GPT-5.x → GPT-5.6 Luna, Gemini Pro → Flash) and falls back to the session model itself when the host does not offer it or the call fails.
- Image generation now tries the session provider's own image model first (e.g. GPT-5.x → `gpt-image-2`, Gemini → `gemini-3-pro-image`, Grok → `grok-imagine-image`), and a GPT-5+ session model generates images itself through the hosted image tool when its provider or proxy has no image model.
- The default image model chain now uses `openai/gpt-image-2`, `openai-codex/gpt-image-2`, and the GA `gemini-3-pro-image` (Google and OpenRouter) instead of `gpt-image-1` and the Gemini preview id.
- Reduced CPU while streaming replies and tool calls: the reveal no longer deep-compares frozen leading content on every flush, streamed argument extraction no longer re-verifies the whole prefix, and deltas no longer queue extension notifications when no extension listens for `message_update` ([#13650](https://github.com/can1357/oh-my-pi/pull/13650) by [@H4vC](https://github.com/H4vC)).
- Reduced CPU and allocations for in-memory reads (URLs, notebooks, converted documents), tool-result spill checks, write read-projection guards, and hashline prefix stripping ([#13650](https://github.com/can1357/oh-my-pi/pull/13650) by [@H4vC](https://github.com/H4vC)).

### Fixed

- Fixed alt+p and `/switch` model picker latency by avoiding unnecessary catalog rebuilds
- Fixed `--tools` with an unknown name printing a stack trace and listing only the tools left after filtering; it now prints a clean error naming unknown tools, built-in tools unavailable in the session, and the built-in and registered tools ([#13623](https://github.com/can1357/oh-my-pi/pull/13623) by [@H4vC](https://github.com/H4vC))
- Fixed unknown CLI flags exiting 1 with an extra "ended before completing" line instead of exiting 2 ([#13623](https://github.com/can1357/oh-my-pi/pull/13623) by [@H4vC](https://github.com/H4vC))
- Fixed a mistyped `--model` in print mode telling you to set an API key; it now suggests the closest available models ([#13623](https://github.com/can1357/oh-my-pi/pull/13623) by [@H4vC](https://github.com/H4vC))
- Fixed the alt+p / `/switch` model picker taking seconds to appear: it rebuilt the whole model catalog on every open before painting, and now re-reads it only when startup discovery is still landing or models.yml changed
- Fixed `tool_call` `additionalContext` being delivered more than once when several extension or hook handlers on the same call returned identical text ([#13633](https://github.com/can1357/oh-my-pi/pull/13633) by [@andrebrait](https://github.com/andrebrait))
- Fixed hosted OpenAI web search on hosts that accept only string tool_choice values, such as Command Code ([#13666](https://github.com/can1357/oh-my-pi/pull/13666) by [@riicodespretty](https://github.com/riicodespretty))

### Removed

- Removed the web search provider picker from `omp setup`; set the `web` model role (or keep the free default chain) instead.

## [18.4.2] - 2026-09-28

### Added

- The shell's `cp` builtin accepts macOS's `-c` (clone where possible, else copy; same as `--reflink=auto`).

### Changed

- Removed unused timestamp metadata from model usage tracking queries to optimize database overhead
- Improved session storage reliability by using atomic inode identity verification for lock management
- Optimized internal role chain resolution and caching to reduce event-loop contention during judge initialization
- On macOS, the shell's `cp` builtin now also clones (copy-on-write) when overwriting an existing file, instead of rewriting its data; the destination keeps its permissions, and hard-linked destinations are still written in place.
- The `find` tool now fails with a timeout error after 20 seconds instead of blocking the turn when the judge model stalls.
- Reduced main-thread stalls with many agents running: `read` code summaries now parse off the main thread, streamed tool-call snapshots no longer deep-copy growing argument text on every delta, and model-cache reads skip re-parsing unchanged rows.
- Reduced CPU while an agent streams: the working-row token rate and status line no longer re-tokenize or re-resolve settings every frame, and `^` model mentions no longer rebuild the model scope per keystroke.
- `task` and `/vibe` subagents now get their own Python kernel and JS/Ruby/Julia eval state instead of sharing the parent's, so agents can no longer overwrite each other's variables or reset each other's kernels.
- On Windows, the shell's `cp` builtin now clones files (copy-on-write) on ReFS and Dev Drive volumes by default, falling back to a regular copy elsewhere; `--reflink` and `-c` no longer fail there.

### Fixed

- Fixed mouse handling ignoring per-mode TUI mouse setting
- Fixed the shell's `cp --reflink=always` emptying an existing destination when the filesystem cannot clone; the destination is now left untouched.
- Fixed `block-clone` task isolation on Windows ReFS and Dev Drive volumes failing on files whose size is not a whole number of clusters, larger than 4 GiB, or sparse.
- Fixed Google Antigravity requests failing with `429 RESOURCE_EXHAUSTED` on every turn: the system prompts' RFC 2119 conventions line is reworded so the endpoint no longer rejects it ([#13379](https://github.com/can1357/oh-my-pi/pull/13379) by [@heshuoshuo0512](https://github.com/heshuoshuo0512))
- Fixed CRLF `SKILL.md` files injecting raw YAML frontmatter into user-invoked and autoload skill messages ([#13590](https://github.com/can1357/oh-my-pi/issues/13590)).
- Fixed Cursor native Grep ignoring requested context, Read negative offsets starting at the top, and Delete reporting zero-byte files ([#13600](https://github.com/can1357/oh-my-pi/issues/13600)).

## [18.4.1] - 2026-09-28

### Changed

- With LSP disabled (`--no-lsp` or `lsp.enabled: false`), startup skips language-server discovery and warmup, and the welcome screen no longer shows the LSP Servers section
- The first frame's status bar now renders live at the current terminal width from the cached model, thinking level, and status-line settings instead of replaying an `…`-filled snapshot: path and git branch are always current, the context gauge shows the window without a stale percent, git dirty counts no longer blank out when the session bar takes over, and folders that never ran omp paint the bar (and your theme) too.
- Moved the composer startup cache (theme, welcome, recent sessions, LSP rows, status bar) from per-project JSON files under `cache/composer/` to a single `cache/composer.db`; the old directory is no longer read and can be deleted.
- Improved interactive startup: the session status bar appears sooner because `retry.fallbackChains` validation, the background model-catalog refresh, and project daemon registration no longer block the first session frame.
- Reduced CPU use from subagent HUD repaints during active sessions ([#13245](https://github.com/can1357/oh-my-pi/pull/13245) by [@iliaal](https://github.com/iliaal)).
- Clarified which provider transports honor `thinkingBudgets` and that local OpenAI-compatible models use effort controls instead ([#13503](https://github.com/can1357/oh-my-pi/issues/13503)).
- `/fork` now prints how to resume the session it leaves behind (`omp --resume <id>` or `/resume <id>`) instead of the new transcript's filename ([#13338](https://github.com/can1357/oh-my-pi/pull/13338) by [@LlemonDuck](https://github.com/LlemonDuck))
- `/vibe` status checks no longer redraw every worker the director killed: `vibe_wait` and `vibe_list` leave killed sessions off the wall with a `N killed hidden` count, and `vibe_list` collapses them to one trailing line naming the most recent (transcripts stay at `history://<id>`) ([#13073](https://github.com/can1357/oh-my-pi/pull/13073) by [@igasmi](https://github.com/igasmi)).

### Fixed

- Fixed `find` exhausting memory on trees with many matching lines: its keyword scan now counts matches as they stream in, holding a few hundred MiB where a 5-million-line tree took several GiB, and finishes faster ([#13495](https://github.com/can1357/oh-my-pi/issues/13495))
- Fixed a native compaction speculation that failed for good turning off background compaction for the rest of the cycle. With `compaction.methodOrder` such as `["remote", "soft"]`, speculation now moves to the next configured method and the threshold pass keeps deferring to it, instead of running that method on the blocking path ([#13478](https://github.com/can1357/oh-my-pi/pull/13478) by [@andrebrait](https://github.com/andrebrait)).
- Extensions that register bash through the legacy `createBashTool`/`createBashToolDefinition` with a `spawnHook` no longer make every bash call fail with `ready and env require a service name.` ([#13461](https://github.com/can1357/oh-my-pi/pull/13461) by [@sjawhar](https://github.com/sjawhar))
- Fixed `/new` with automatic thinking starting the new session at the previous session's classified effort instead of the provisional level, both in its first `thinking_level_change` entry and on the wire ([#13383](https://github.com/can1357/oh-my-pi/issues/13383))
- Fixed a corrupt `agent.db` crashing every launch with `no such table` (for example `hint_usage`) instead of being preserved and recreated ([#13530](https://github.com/can1357/oh-my-pi/pull/13530) by [@Hunter-124](https://github.com/Hunter-124))
- Fixed `edit` rejecting a one-line replacement of an `if` opener, `case` label, or function signature with another of the same shape as an "ambiguous boundary" whenever another edit in the same batch broke the file's syntax; it now applies with the usual syntax-error warning. ([#13522](https://github.com/can1357/oh-my-pi/pull/13522))
- Jujutsu status and diffs now report renames and copies (`R`/`C`, `rename from`/`rename to`) the way `jj status` and `jj diff` do, instead of a delete plus an add ([#13406](https://github.com/can1357/oh-my-pi/pull/13406) by [@sjawhar](https://github.com/sjawhar)).
- Fixed a subagent that finished before a later step failed (such as the isolation merge) losing its evidence: the `task` result now names the child's exit status and `agent://` output, keeps that output on disk, and is marked as an error ([#13557](https://github.com/can1357/oh-my-pi/pull/13557) by [@aktanazat](https://github.com/aktanazat))
- Fixed SDK sessions created with `agentDir` loading user rules (`rules/`, `RULES.md`) and custom tools from the default agent dir instead of that `agentDir`; `discoverCustomToolPaths` and `discoverAndLoadCustomTools` accept an `agentDir` argument ([#13558](https://github.com/can1357/oh-my-pi/pull/13558) by [@aktanazat](https://github.com/aktanazat))
- Reduced daemon broker metadata writes for historical services when owners reconnect or the broker restarts ([#13471](https://github.com/can1357/oh-my-pi/pull/13471) by [@Dante-dan](https://github.com/Dante-dan)).
- Fixed compaction re-emitting the whole transcript into native scrollback when `display.collapseCompacted` is off, for both the automatic compaction-end and the manual `/compact` path ([#12140](https://github.com/can1357/oh-my-pi/issues/12140), [#13235](https://github.com/can1357/oh-my-pi/pull/13235) by [@holny](https://github.com/holny))
- Subagents can submit their preceding report with a data-less yield after a finish reminder ([#12837](https://github.com/can1357/oh-my-pi/pull/12837) by [@iliaal](https://github.com/iliaal)).
- Fixed session dispose losing the final message and exit record on SQL/indexed session storage ([#13415](https://github.com/can1357/oh-my-pi/pull/13415) by [@sjawhar](https://github.com/sjawhar))
- Fixed the `recall`, `reflect`, and `memory_edit` tool descriptions naming each other by bare name when those tools are reachable only as `xd://` devices ([#13207](https://github.com/can1357/oh-my-pi/pull/13207) by [@andrebrait](https://github.com/andrebrait)).
- Listed the directories searched for agent files in the `task` tool's unknown-agent error, with the home directory shortened to `~`
- Fixed sessions and subagents of the same agent in different working directories (such as one git worktree per task) never sharing the cached Anthropic system prompt: context files, workspace tree, workspace roots, and other directory-specific sections now come after the static system prompt, which stays a cache hit across directories ([#13104](https://github.com/can1357/oh-my-pi/issues/13104))
- Fixed the startup "What's New" heading and config warnings keeping the dark palette on a light terminal: they were colored before the terminal reported its background, so the heading rendered near-white on white. Both now resolve their color at render time and follow the auto theme switch
- Fixed idle `display: true` custom messages (such as extension `pi.sendMessage` notices sent without starting a turn) not appearing in the transcript until the session was reloaded ([#12718](https://github.com/can1357/oh-my-pi/pull/12718) by [@Broglah1](https://github.com/Broglah1)).
- Fixed `omp usage` ignoring usage providers registered by extensions, which left those accounts listed as having no usage data; `omp usage` now also accepts `-e`/`--extension` and `--no-extensions` ([#13579](https://github.com/can1357/oh-my-pi/issues/13579))
- Fixed a task model saved in `/agents` being ignored for the rest of the session after an Alt+P session-only pick ([#13345](https://github.com/can1357/oh-my-pi/issues/13345)).
- Fixed tool calls made through an `xd://` alias being recorded under the alias, which made OpenAI/OpenRouter Responses replay reject every later request ([#13352](https://github.com/can1357/oh-my-pi/issues/13352)).
- Fixed pasted images in skill invocations not reaching the configured vision model when the main model supports only text ([#13480](https://github.com/can1357/oh-my-pi/issues/13480)).
- A provider listed in `disabledProviders` no longer answers through a retry fallback chain, an advisor or a restored model, and gets no credential however one of its models was selected ([#13194](https://github.com/can1357/oh-my-pi/pull/13194) by [@sjawhar](https://github.com/sjawhar)).
- Fixed `glob` silently clamping `limit` above 200 while advising `Use limit=<clamped>` retries: a clamped request is now disclosed up front and the "Use limit=" advice is dropped once the hard cap is reached ([#13263](https://github.com/can1357/oh-my-pi/issues/13263))
- Fixed subagents that stop to wait for their own background job failing with a missing yield instead of waiting for the job ([#13305](https://github.com/can1357/oh-my-pi/issues/13305)).
- Fixed a failed session append leaving partial bytes behind on Windows, where ftruncate is refused on the append handle: the rollback now reopens the file without O_APPEND and verifies it is still the same file before truncating ([#13362](https://github.com/can1357/oh-my-pi/pull/13362) by [@jchanghong023](https://github.com/jchanghong023))
- Fixed plugin installation failing on Windows outside developer mode by linking the plugin through a directory junction, matching the marketplace link ([#13364](https://github.com/can1357/oh-my-pi/pull/13364) by [@jchanghong023](https://github.com/jchanghong023))
- Fixed the grep tool searching subdirectories for globs whose base path merely resolved to the cwd: only globs spelled without a directory prefix (like `*.ts`) now match at any depth, while `./*.ts` and absolute paths stay scoped to their directory ([#13360](https://github.com/can1357/oh-my-pi/pull/13360) by [@jchanghong023](https://github.com/jchanghong023))
- Fixed the `ask` tool's "Other (type your own)" prompt sending RPC and SDK clients a terminal-rendered title (options with icon glyphs, lines clipped to the terminal width) instead of the question text; the interactive TUI's own ask dialog is unaffected ([#13477](https://github.com/can1357/oh-my-pi/pull/13477) by [@andrebrait](https://github.com/andrebrait))
- Fixed prewalk targets registered by extensions resolving before their provider was loaded. The hand-off now retries after extension registration, preserves role fallback order, and refreshes a cold runtime provider when needed.
- Fixed saving settings on Windows through a symlinked `config.yml` whose target contains `..` writing a file other than the one the link reads, and `agent.db` staying open after its storage is closed ([#13351](https://github.com/can1357/oh-my-pi/pull/13351) by [@Vortex727](https://github.com/Vortex727))
- Fixed grep line ranges (`path:N-M`) returning out-of-range lines for absolute paths with `./` or `..` segments ([#13296](https://github.com/can1357/oh-my-pi/pull/13296) by [@pedropaulovc](https://github.com/pedropaulovc)).
- Fixed service requests the project's service broker cannot parse, such as commands added by a newer omp after an update, waiting 30 seconds to time out; the broker now rejects them immediately with the reason ([#13301](https://github.com/can1357/oh-my-pi/pull/13301) by [@eggpeat](https://github.com/eggpeat)).
- Fixed sessions stopping on "Anthropic stream stalled while waiting for the next event" (and other mid-stream stalls, HTTP/2 resets, premature closes, or sockets closed mid-response) when the connection died after the reply's text had already rendered. Replay was refused to avoid duplicating shown text and the tool-turn continuation needed a tool call, so text-only turns had no recovery; the partial turn is now kept and the model is asked to continue from where it stopped, up to 3 times per prompt when `retry.enabled` is on ([#13333](https://github.com/can1357/oh-my-pi/pull/13333) by [@jerryfane](https://github.com/jerryfane))
- Fixed editing one fallback chain in the model hub, or one agent in `/agents`, saving every chain or agent a `--config` overlay supplies into `config.yml` ([#13308](https://github.com/can1357/oh-my-pi/pull/13308) by [@Vortex727](https://github.com/Vortex727))
- Fixed `omp install --dry-run <local-path>` and `omp plugin link --dry-run` linking the plugin and writing the lockfile instead of only previewing ([#13241](https://github.com/can1357/oh-my-pi/pull/13241)).
- Sessions containing assistant messages with no recorded usage now open with that usage counted as zero, instead of crashing on load with `undefined is not an object (evaluating 'usage.cacheRead')` ([#13386](https://github.com/can1357/oh-my-pi/pull/13386) by [@ParadaCarleton](https://github.com/ParadaCarleton)).
- Fixed rules with an `astCondition` and `interruptMode: always` letting the matching `write` or `edit` run before the interrupt, so the file changed on disk even though the rule fired; the call is now blocked before it executes ([#13303](https://github.com/can1357/oh-my-pi/pull/13303) by [@JYeswak](https://github.com/JYeswak))
- Fixed rules not applying to tool calls made from inside `eval` (for example `tool.write(...)`), which ran without any rule check; they are now checked the same way as direct calls ([#13316](https://github.com/can1357/oh-my-pi/pull/13316) by [@JYeswak](https://github.com/JYeswak))
- Fixed bash calls whose optional fields arrive filled with empty values being rejected as service starts ([#13182](https://github.com/can1357/oh-my-pi/issues/13182)).
- Fixed keyless vLLM providers failing every request with "No API key found" ([#13246](https://github.com/can1357/oh-my-pi/issues/13246)).
- Fixed the Agent Hub usage gauge measuring a subagent against its startup model's context window after a fallback model swap ([#13061](https://github.com/can1357/oh-my-pi/pull/13061)).
- Fixed HTML session exports failing to render offline or under a strict script CSP; the viewer libraries are now inlined ([#12948](https://github.com/can1357/oh-my-pi/issues/12948)).
- Fixed hashline edits rejecting files whose names contain `#` (such as yadm alternate files) ([#13428](https://github.com/can1357/oh-my-pi/pull/13428)).
- Fixed a module created with `write` leaving the importing file stuck on TS2307 in typescript-language-server ([#12925](https://github.com/can1357/oh-my-pi/pull/12925)).
- Fixed startup waiting up to 10s on an unresponsive LM Studio loopback probe; the probe now gives up after 250ms like Ollama and llama.cpp ([#12945](https://github.com/can1357/oh-my-pi/issues/12945)).
- The interactive `/usage` dashboard keeps connected accounts visible when some or all usage lookups fail, showing unavailable usage instead of hiding accounts ([#13476](https://github.com/can1357/oh-my-pi/pull/13476) by [@aktanazat](https://github.com/aktanazat)).
- Fixed multiline pastes splitting into separate submissions after a terminal drops bracketed-paste mode, and text typed right after Enter being erased by the post-submit clear ([#13440](https://github.com/can1357/oh-my-pi/pull/13440) by [@Dante-dan](https://github.com/Dante-dan)).
- Fixed subagents never compacting when the parent sets `compaction.midTurnEnabled: false`; a subagent's run is a single turn, so subagents keep mid-run compaction on unless a spawn overrides it ([#13212](https://github.com/can1357/oh-my-pi/pull/13212)).
- Fixed the exit resume hint so the `omp --resume <id>` command prints on its own line, letting triple-click select just the command ([#12748](https://github.com/can1357/oh-my-pi/pull/12748) by [@F0Rextasy](https://github.com/F0Rextasy)).

## [18.4.0] - 2026-09-28

### Added

- Added the `telemetry.otlpExportEnabled` setting under Settings → Providers → Privacy to disable OTLP trace, log, and metric export even when `OTEL_*` endpoints are configured; exporting remains enabled by default.
- Added a first-launch warning when Python evaluation is enabled but no working Python interpreter is available, with guidance for configuring `python.interpreter` and checking the installation with `omp setup python --check`.

### Changed

- Updated `omp stats` and `/stats` to open the redesigned dashboard immediately while session data synchronizes in the background with live progress; `--json` and `--summary` continue to synchronize before producing output.
- Replaced the stats dashboard’s Behavior page with a Frustration page that can classify messages using the `judge` model role, showing an estimated cost before analysis and recording `/stats` spending in the current session.
- Clarified the `eval` tool documentation to explain that its kernel may be shared with the parent session and concurrent task subagents.

### Fixed

- Fixed `/tree` reopening saved Ask results instead of navigating past them when an optional preview was saved as `null`.
- Fixed the legacy `createGrepTool()` API when searching with both a file path and a `glob` filter.
- Improved task and subagent reliability: eligible saved usage resets are now redeemed automatically when polling is throttled or transient failures occur, concurrent tasks share confirmed resets, headless subagents retain assignments across session transitions, tagged `^model` agents are available to nested subagents, and `wait` returns promptly with information about still-running work when no owned jobs are available.
- Fixed SDK requests using `ApiKeyResolver` to wait for a nearby healthy credential when a drained account’s quota block is about to expire, instead of immediately failing with a multi-hour quota error.
- Fixed Anthropic requests failing after native compaction when experimental context notes were enabled.
- Fixed Windows path handling for 8.3 short paths, including project-directory detection and home-directory display in status, tool labels, and errors.
- Fixed `edit` `PUT >N` producing syntactically invalid code when inserting shallower constructs near closing braces.
- Fixed Windows one-shot commands, including `omp update`, incorrectly reporting successful completion as an error; also fixed this behavior when no user npm or Bun configuration file exists.
- Fixed missing judge token counts corrupting session usage totals and displaying `$NaN`.
- Fixed Cursor sessions under-reporting token usage and cost, compacting based on the wrong context measurement, and applying shell-command timeouts in the wrong units.
- Updated goal mode to wait for user input when all remaining todos are blocked instead of repeatedly requesting approval.
- Fixed `pi-background-tasks` 2.6.0 and later failing to load due to a missing legacy `pi-ai` compatibility export.
- Fixed blob broker requests when `PI_PROXY` is configured.
- Fixed `generate_image` reporting the catalog model instead of the image model actually used by the ChatGPT/Codex backend; saved image metadata now reflects the provider-returned size and quality.
- Fixed fast-model fallback selection so it no longer chooses Gemini or MiniMax models when no `smol` role is configured.
- Fixed extension tool renderers using upstream pi’s `renderCall(args, theme, context)` signature failing to render.
- Fixed Nix flake and NixOS module builds failing because the native package version stamp was not recognized.
- Fixed Nix dependency-lock checks failing after obsolete stats chart dependencies were removed.

## [18.3.5] - 2026-09-27

### Added

- Added API-key-billed OpenAI Responses web search (`openai/gpt-6-luna`, then `openai/gpt-5.6-luna`), tried after every Codex entry in the default search fallback chain so ChatGPT-subscription search is exhausted before any API usage is billed ([#13467](https://github.com/can1357/oh-my-pi/pull/13467) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Added prompt-cache warming, ported from [earendil-works/pi](https://github.com/earendil-works/pi): shortly before a prompt-cache entry expires, the main agent loop replays its last request and cuts the replay off at the first generated token, so idle gaps no longer force a full-prefix cache re-write. A refresh fires only when the expected avoided-miss cost clears its cost by $0.05, and warming stops as soon as a refresh misses the cache. Controlled by `providers.cacheWarming` (`off` / `streaming` / `idle`, default `idle`); idle warming covers 5-minute entries only, and models without a declared `promptCache` lifetime are never warmed. Extensions can override each decision through the `cache_warming_decision` event ([#12699](https://github.com/can1357/oh-my-pi/pull/12699) by [@KamijoToma](https://github.com/KamijoToma)).

## [18.3.4] - 2026-09-27

### Breaking Changes

- Replaced the `task` tool's `complexity` field with `solutionSpace`, a description of how open-ended the subtask is; `auto` thinking for spawned subagents now picks effort from it alone

### Changed

- `auto` thinking now picks effort for every turn by how open-ended the problem is, so large volumes of mechanical work no longer raise it

### Fixed

- Fixed agents looping for hours when every turn spends the whole output limit on reasoning: length-stop retries now tell the model its reasoning was discarded and to act in smaller steps, and a subagent whose length-stop recovery gives up now fails with that error instead of being re-prompted into the same loop
- Fixed tagging a model with `^` mid-session dropping the provider prompt cache for every following turn: new `m<N>` pseudonyms now arrive as a hidden session notice instead of rewriting the `task` description, which only absorbs them at a base-prompt rebuild

## [18.3.3] - 2026-09-27

### Added

- Added a unified predictive text engine with N-gram, SmolLM2, and macOS native providers, including cross-engine blending, background model downloads, and a cross-process prediction daemon.
- Added the `omp predict` command for evaluating completion performance and support for ingesting existing Claude Code and Codex prompt histories to bootstrap predictions on new installations.
- Added `omp skill list [dir] [--json]` to report skills resolved for a session directory, including discovery warnings in JSON output.
- Added a centralized progress display for background tool and model downloads, including support for downloading the SmolLM2-135M word-completion model.
- Added dynamic evaluation guidance through hidden session notices.
- Added a required `complexity` rationale to the `task` tool to improve automatic thinking-depth selection.
- Agents using `task` or `bash` now receive the `wait` tool for background-process coordination, and subagents can receive it when explicitly requested.
- Added context-aware suggestions to empty composers based on agent activity and effort.
- Added optional global or per-project memory scopes to the `retain` and `learn` tools when Mnemopi scoping is enabled.
- Added `/btw` to focused subagent views for asking questions about that agent's transcript with separate side-conversation history.

### Changed

- Completion behavior now uses the N-gram engine for standard `auto` completion across platforms, with blended N-gram and SmolLM confidence scoring where applicable; the SmolLM2 model uses a 145 MB GGUF (Q8_0) download and is prefetched only when explicitly activated.
- Updated `spelling.autocomplete` to use an enum-based engine configuration.
- Completion ghost text is now preserved through manual keystrokes.
- Window input actions now default to background execution; set `takeover: true` to opt into foreground activation, with clarified cross-platform coordinate and activation behavior.
- `omp tiny-models download` can now download the word-completion model.
- Updated `/play` help, read-tool summaries, platform-aware shortcut labels, and other UI hints for clearer interaction guidance.
- Updated the empty-submit behavior to account for live-steered messages and surface pending live-steering status in the UI.
- `ps --all` now includes exited global services, while the default view shows live global services.
- Orchestrator task documentation now follows a Target/Change/Acceptance format.
- Slash-command and hint usage tracking is now persistent and namespaced.

### Fixed

- Preserved MCP `structuredContent` in live tool-result details so evaluation callers can consume server data without reparsing model-facing JSON; spilled results continue to retain an artifact reference without duplicating the payload in session history.
- Fixed Collab hosts becoming unable to reclaim a room after a brief network interruption; hosts now retry room recovery without losing guests or queued updates.
- Fixed one-shot commands that stopped before completing, such as `omp config set` on a fresh Windows profile, incorrectly exiting successfully without output; they now report failure with diagnostic guidance.

## [18.3.2] - 2026-09-25

### Added

- Added `ctx.agent` to the extension context, reporting whether the session is the top-level agent or a subagent, plus its registry id, agent definition name, task depth and parent id, so handlers rebound to subagent sessions can tell which agent they serve ([#13314](https://github.com/can1357/oh-my-pi/pull/13314) by [@andrebrait](https://github.com/andrebrait))
- Added tracking of Anthropic's usage-limit wrap-up allowance for Claude subscription accounts: after the 5-hour or weekly limit is reached, the status line and `/slow status` show `limit reached · wrapping up · resets HH:MM`, and the agent is told to wrap up when neither low priority nor extra usage will continue the work ([#13340](https://github.com/can1357/oh-my-pi/pull/13340) by [@H4vC](https://github.com/H4vC))

### Changed

- `providers.anthropic.slowMode` now controls only the low-priority lane; the usage-limit wrap-up allowance is tracked for every first-party Claude subscription account ([#13340](https://github.com/can1357/oh-my-pi/pull/13340) by [@H4vC](https://github.com/H4vC))
- Enter on the `/model` hub sidebar now moves focus to the model list (like →) instead of acting on the highlighted row ([#13347](https://github.com/can1357/oh-my-pi/pull/13347) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed the Windows bash tool exporting `TEMP`, `TMP`, and `TMPDIR` with 8.3 short names such as `ADMINI~1`, so they now match the long-form `pwd`/`$PWD` after `cd "$TEMP"` ([#13265](https://github.com/can1357/oh-my-pi/pull/13265) by [@CoderTCY](https://github.com/CoderTCY))
- `edit` and `write` no longer refuse handwritten files named `generated.go`, `generated.ts`, `generated.js`, or `generated.py`; these are treated as auto-generated only when their header carries a generated-code marker ([#13138](https://github.com/can1357/oh-my-pi/issues/13138), [#13139](https://github.com/can1357/oh-my-pi/pull/13139) by [@radkawar](https://github.com/radkawar))
- Fixed the `edit` tool warning that valid Go 1.26 `new(expr)` calls (e.g. `new(f(x))`) introduced a syntax error, and `ast_grep`/`ast_edit` reporting parse errors on them ([#13148](https://github.com/can1357/oh-my-pi/issues/13148), [#13149](https://github.com/can1357/oh-my-pi/pull/13149) by [@radkawar](https://github.com/radkawar))
- Fixed hashline `PUT N*` / `CUT N*` on the first statement of a block (for example a Go or Python function that opens with an `if`) also replacing or deleting every statement after it ([#13153](https://github.com/can1357/oh-my-pi/issues/13153), [#13154](https://github.com/can1357/oh-my-pi/pull/13154) by [@radkawar](https://github.com/radkawar))
- Fixed the `Full output: artifact://` link on large background bash and eval results pointing at a truncated copy with `[…elided…]` gaps instead of the complete output ([#13142](https://github.com/can1357/oh-my-pi/issues/13142), [#13143](https://github.com/can1357/oh-my-pi/pull/13143) by [@radkawar](https://github.com/radkawar))
- Fixed `grep` paths like `dir/*.go` also matching files in subdirectories of `dir` ([#13146](https://github.com/can1357/oh-my-pi/issues/13146), [#13150](https://github.com/can1357/oh-my-pi/pull/13150) by [@radkawar](https://github.com/radkawar))
- Fixed auto-compaction re-sending a failed native (server-side) compaction on every turn, re-reading the full context each time; after a failure a retry would repeat, the next configured method runs instead until a compaction succeeds ([#13310](https://github.com/can1357/oh-my-pi/pull/13310) by [@alphastorm](https://github.com/alphastorm))
- Fixed a `/slow off` session resending requests indefinitely when another session had activated the shared Anthropic low-priority lane ([#13340](https://github.com/can1357/oh-my-pi/pull/13340) by [@H4vC](https://github.com/H4vC))

## [18.3.1] - 2026-09-25

### Added

- Added a filter to the Esc Esc rewind selector: press `f` and type to show only items containing every word, then Enter to rewind ([#13295](https://github.com/can1357/oh-my-pi/pull/13295) by [@H4vC](https://github.com/H4vC))
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
- Added stale tool-result eviction for advisors: before each review, an advisor replaces its own `read`/`grep`/`glob` output from reviews older than the latest one with a short placeholder, so it stops re-sending that output on every request. The deltas it reviews, the notes it wrote, and other tool results such as `recall` are never touched. Turn it off with `advisor.evictStaleResults` ([#13238](https://github.com/can1357/oh-my-pi/pull/13238) by [@alnaggar-dev](https://github.com/alnaggar-dev))

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

Older entries are archived in [packages/coding-agent/CHANGELOG.md@bac7e83b5b0e](https://github.com/can1357/oh-my-pi/blob/bac7e83b5b0eb86c909c17830a6666efc359578b/packages/coding-agent/CHANGELOG.md).
