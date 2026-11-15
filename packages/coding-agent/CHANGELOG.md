# Changelog

## [Unreleased]

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
- Browser `waitForUrl`, `waitForResponse` and `requests({ filter })` treat a URL string containing `*` as a glob, like `tab.route()`; other strings still match as substrings
### Added

- Anthropic web search and Files API uploads follow `PI_ANTHROPIC_API_VERSION=2026-10-21`; web search omits `temperature` under that version ([#16706](https://github.com/can1357/oh-my-pi/pull/16706) by [@H4vC](https://github.com/H4vC))
- llama.cpp auto-discovery now also finds local servers on llama-server's new default port 9931 when nothing answers on 8080 ([#16675](https://github.com/can1357/oh-my-pi/pull/16675) by [@bartbroere](https://github.com/bartbroere))
- `display.hideToolOutputDetails` renders each read or tool call as its own one-line summary — folding a call's multiple targets onto that row too — and hides its output body, on the assembled transcript and on Tern's native surface alike; `app.display.toggleDetail` (Ctrl+H) moves that together with the thinking-block toggle from a single key ([#11840](https://github.com/can1357/oh-my-pi/pull/11840) by [@iacore](https://github.com/iacore))

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
- Fixed `read` line selectors on `xd://` docs (`xd://eval/browser:1-200`) failing with `Unknown topic`; `write` now rejects a selector on an `xd://` device URL instead of treating it as part of the device name
- `display.hideToolOutputDetails` no longer swallows a click on a folded call: the collapsed one-row summary reopens its output when the terminal toggles it, while Ctrl+H still folds a call the user had opened ([#11840](https://github.com/can1357/oh-my-pi/pull/11840) by [@iacore](https://github.com/iacore))
- Fixed `omp gc --compress` exiting with "the event loop drained while it was still pending" on Bun 1.3.14 when a session artifact is pretty-printed JSON larger than 1 MiB, and session header probes (gc, session move and transfer) reading whole artifacts on Windows ([#15745](https://github.com/can1357/oh-my-pi/issues/15745), [#16754](https://github.com/can1357/oh-my-pi/pull/16754) by [@wolfiesch](https://github.com/wolfiesch))
- `/resume` into another session now cancels the previous session's background jobs, as `/new` does, instead of delivering their results into the resumed session and starting a turn there ([#16760](https://github.com/can1357/oh-my-pi/pull/16760) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the models config migration writing `models.yml` readable by other users on the machine, and dropping every custom provider when the write was interrupted; the migrated file is now published atomically with owner-only permissions ([#16654](https://github.com/can1357/oh-my-pi/pull/16654) by [@adi-IL](https://github.com/adi-IL))
- Fixed `/memory clear` in one project deleting the memory state of every other project that shares the same agent directory ([#16657](https://github.com/can1357/oh-my-pi/pull/16657) by [@adi-IL](https://github.com/adi-IL))
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
- Fixed `openai-models-list` discovery leaving models that advertise their own reasoning levels (`supported_reasoning_levels` and `default_reasoning_level`, top-level or under `metadata` as codex-lb sends them) non-reasoning when the id is absent from the bundled catalog, so requests never carried `reasoning_effort` ([#16650](https://github.com/can1357/oh-my-pi/pull/16650) by [@Komzpa](https://github.com/Komzpa))
- Fixed marketplace auto-update leaving cloned checkouts behind after startup errors; abandoned clones are removed on a later refresh ([#16693](https://github.com/can1357/oh-my-pi/issues/16693))
- Fixed an extension's idle `pi.sendMessage({ display: true }, { deliverAs: "nextTurn", triggerTurn: false })` clearing and replaying the whole transcript, which froze input for longer as the session grew; the message is now appended to the existing transcript ([#16744](https://github.com/can1357/oh-my-pi/pull/16744) by [@OriginalByteMe](https://github.com/OriginalByteMe))
- Fixed `app.target` rejecting CDP page ids, including fresh `about:blank` pages, and added ids to unmatched-target listings ([#16619](https://github.com/can1357/oh-my-pi/issues/16619))
- Fixed reading `proc://<id>/kill` or `proc://<id>/mode` answering only "writable only", so agents often moved on with the job still running; the error now names the `write` call that cancels the job or sets the mode, with the real id ([#16580](https://github.com/can1357/oh-my-pi/pull/16580) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `history://<id>` failing with "has no transcript: session is gone" for a worker that is still running but has not created its session or transcript file yet; it now answers "No transcript has been written yet". ([#16645](https://github.com/can1357/oh-my-pi/pull/16645) by [@Komzpa](https://github.com/Komzpa))
- Fixed the `eval` tool telling sessions with only the Python runtime to call `tool.<name>(args)` without `await`, which returns a coroutine and never runs the tool ([#16578](https://github.com/can1357/oh-my-pi/pull/16578) by [@will-bogusz](https://github.com/will-bogusz))

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
