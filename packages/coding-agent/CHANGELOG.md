# Changelog

## [Unreleased]

### Added

- Anthropic web search and Files API uploads follow `PI_ANTHROPIC_API_VERSION=2026-10-21`; web search omits `temperature` under that version ([#16706](https://github.com/can1357/oh-my-pi/pull/16706) by [@H4vC](https://github.com/H4vC))
- llama.cpp auto-discovery now also finds local servers on llama-server's new default port 9931 when nothing answers on 8080 ([#16675](https://github.com/can1357/oh-my-pi/pull/16675) by [@bartbroere](https://github.com/bartbroere))

### Fixed
### Breaking Changes

- SDK: removed `SessionManager.onEntryAppended`; use `SessionManager.subscribeEntryAppended(listener)`, which supports several listeners and returns an unsubscribe function ([#14166](https://github.com/can1357/oh-my-pi/pull/14166) by [@andrebrait](https://github.com/andrebrait))
- SDK: `RpcClient.getAvailableModels()` now returns `Promise<Model[]>` (complete `Model` records, as the host has always sent them) instead of the reduced `ModelInfo[]`; the `ModelInfo` type is no longer exported from the RPC client module ([#14166](https://github.com/can1357/oh-my-pi/pull/14166) by [@andrebrait](https://github.com/andrebrait))
- SDK deep imports: replaced `ACP_BUILTIN_RESERVED_NAMES` with `acpBuiltinReservedNames()` and removed the unused `ACP_BUILTIN_SLASH_COMMANDS` export from `slash-commands/acp-builtins` ([#14166](https://github.com/can1357/oh-my-pi/pull/14166) by [@andrebrait](https://github.com/andrebrait)).

### Added
- Added `computer.backgroundFallback` (`takeover` by default, or `refuse`): when a `computer` window input call has no background route, the tool reruns that one call in takeover, hands focus back to your app and says so in its result; `refuse` fails the call instead and also refuses the agent's own foreground requests (`takeover: true`, `raise()`, an activating `apps.open`, desktop input, and on macOS menus and `AXOpen`) ([#15191](https://github.com/can1357/oh-my-pi/pull/15191) by [@will-bogusz](https://github.com/will-bogusz))

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
- Added `omp --mode host`: a detached session host that several RPC clients can attach to over a local socket or named pipe, with resume, dialog arbitration, and stale-write protection ([#14166](https://github.com/can1357/oh-my-pi/pull/14166) by [@andrebrait](https://github.com/andrebrait)).
- Added experimental hosted sessions: with `tui.hosted` (or `OMP_TUI_HOSTED=1`), or with `omp attach <host ID | session ID | session path>`, an interactive terminal runs as a client of a detached session host. Terminals can detach with `/detach`, attach with `/attach [host|session]`, and share one session; `/exit` stops the host only from its last client. `omp attach` with no target still lists running hosts (`--json` for scripts). Unsent editor drafts are not saved, a lost connection exits with status 1 instead of reconnecting, and TUI-only commands (plan, goal, loop, fork, tree, `!`/`$`, settings, panels, and others) report that they are unavailable when attached. Relative and `local://` links in the host's replies open the host's files (its directory and its session's `local://` directory, in the host's own temp directory for an in-memory session) rather than the terminal's own, while the footer, completion, and `@file` stay local. `worktree.onStart` does not apply to a hosted terminal, and in Tern a hosted terminal reports the host's session file (following its moves and new sessions) instead of its local copy, so Tern's relaunch reattaches to the host. With `--restore`, a host the terminal starts goes on with the interrupted turn and subagents (a failed restore shows as a warning in attached terminals), while a host that already runs the session is attached to as it is and not restored; see the CLI reference ([#14166](https://github.com/can1357/oh-my-pi/pull/14166) by [@andrebrait](https://github.com/andrebrait)).
- Added `RpcClient.detach()` and `RpcClient.exit()` for session hosts; `RpcCommandError` now carries `epoch`, `leafId`, and `hostId` when the host returns them ([#14166](https://github.com/can1357/oh-my-pi/pull/14166) by [@andrebrait](https://github.com/andrebrait)).
- Added `RpcClient.onHostFrame()` for typed session-host frames (`RpcHostFrame`: `attached`, `resumed`, `entry`, `session_replaced`, `clients_changed`, `command_output`, `config_update`, `session_info_update`, and `rpc_frame_error` for a frame dropped over the transport limit; stamped frames keep their `seq`) and `RpcClient.onClose()` for a transport that ended without `stop()`; `prompt`, `steer`, `followUp`, `removeQueuedMessage`, `setModel`, `cycleModel`, `setThinkingLevel`, and `cycleThinkingLevel` accept optional `ifEpoch`/`ifLeaf` preconditions ([#14166](https://github.com/can1357/oh-my-pi/pull/14166) by [@andrebrait](https://github.com/andrebrait)).
- Session hosts send `config_update` to every attached socket client after `set_model`, `cycle_model`, `set_thinking_level`, or `cycle_thinking_level`, so peers show the live model and thinking level; stdio output is unchanged ([#14166](https://github.com/can1357/oh-my-pi/pull/14166) by [@andrebrait](https://github.com/andrebrait)).
- Session hosts: `entry` frames carry the host's active leaf as an optional `leafId`, and attached snapshots show only what `entry` frames have announced, so an entry of a still-publishing atomic batch reaches a client once, after the commit. `queue_update` frames and snapshots (`queueAttachments`) tell socket clients which queued messages carry attachments; stdio is unchanged ([#14166](https://github.com/can1357/oh-my-pi/pull/14166) by [@andrebrait](https://github.com/andrebrait)).
- `remove_queued_message` accepts optional `match: "first" | "last"` and `refuseAttachments`; with `refuseAttachments` a queued prompt that carries an attachment is left in place and the response is `{ removed: false, refused: "attachments" }` ([#14166](https://github.com/can1357/oh-my-pi/pull/14166) by [@andrebrait](https://github.com/andrebrait)).
- `ask` extension UI responses accept `chat: true` (discuss instead of answering) and per-answer `note`, `noteImages`, and `customInputImages` ([#14166](https://github.com/can1357/oh-my-pi/pull/14166) by [@andrebrait](https://github.com/andrebrait)).
- Added `RpcClient.onExtensionUiRequest()`, `RpcClient.sendExtensionUiResponse()`, and `RpcClient.setAskDialog()` ([#14166](https://github.com/can1357/oh-my-pi/pull/14166) by [@andrebrait](https://github.com/andrebrait)).
- Added `RpcClient.promptToCompletion()`: sends a prompt (with optional steering mode and preconditions) and resolves once its work has settled ([#14166](https://github.com/can1357/oh-my-pi/pull/14166) by [@andrebrait](https://github.com/andrebrait)).
- Hosted sessions now generate idle recaps and run idle compaction once, even with no terminals attached; composing a draft in any attached terminal suppresses both ([can1357/oh-my-pi#14468](https://github.com/can1357/oh-my-pi/pull/14468) by [@andrebrait](https://github.com/andrebrait)).
- RPC: added the socket-only `set_idle_activity` command, with which a UI client reports whether it holds an unsent draft (a boolean, never the text). It is answered at once, even while another command runs. Hosted sessions emit the new `idle_recap` event (the full recap reply, journaled in the history database and never added to the transcript) to subscribed clients; `RpcClient.setIdleActivity()` accepts `ifEpoch`/`ifLeaf` preconditions, and the Python, Go and Rust SDKs gain the matching command and event ([can1357/oh-my-pi#14468](https://github.com/can1357/oh-my-pi/pull/14468) by [@andrebrait](https://github.com/andrebrait)).
- SDK: `AgentSession.enableIdleMaintenance()` and `refreshIdleMaintenance()` let an owner opt a session in to the idle recap and idle compaction; `AgentSessionEvent` gains `idle_recap` ([can1357/oh-my-pi#14468](https://github.com/can1357/oh-my-pi/pull/14468) by [@andrebrait](https://github.com/andrebrait)).
- Hosted sessions reconnect automatically after a lost connection and offer to reopen the session in a new host when its host exited ([#15685](https://github.com/can1357/oh-my-pi/pull/15685) by [@andrebrait](https://github.com/andrebrait))

### Changed

- The `computer` tool and its errors no longer tell the model to retry with `takeover: true`, and its instructions tell it never to call `raise()` or `apps.open(…, { activate: true })` to make input work ([#15191](https://github.com/can1357/oh-my-pi/pull/15191) by [@will-bogusz](https://github.com/will-bogusz))
- Computer-use window input with `takeover` omitted now stays in the background after `computer.control.acquire`, so an acquired grant no longer activates the target app or moves the user's pointer; pass `takeover: true` for foreground input ([#15173](https://github.com/can1357/oh-my-pi/pull/15173) by [@will-bogusz](https://github.com/will-bogusz))
- Pressing Escape in your own app no longer stops the `computer` tool's background window input unless task control is held; Escape in omp still interrupts it, and physical Escape still stops takeover input ([#15176](https://github.com/can1357/oh-my-pi/pull/15176) by [@will-bogusz](https://github.com/will-bogusz))
- Added Box questions to `ChainJudge`: they go only to Jev judges that answer them, and the box edges measure the image you passed even when it was padded to fit Jev's size bounds
- A relay `browser.open` without `app.target` now opens its own background tab instead of adopting the visible one (after reinstalling the relay extension; older ones select it), and `browser.close` closes it; `app.target` still borrows an existing tab ([#16119](https://github.com/can1357/oh-my-pi/pull/16119) by [@nnnnoel](https://github.com/nnnnoel) and [@will-bogusz](https://github.com/will-bogusz))
- Computer-use `win.menu.items` now needs `exec` approval and is rejected in `read_only` runs, since on macOS it makes the window key in its own application before reading its menus ([#15184](https://github.com/can1357/oh-my-pi/pull/15184) by [@will-bogusz](https://github.com/will-bogusz))
- The `computer` tool no longer takes over your screen for macOS drags and holds on sliders, scroll bars, splitters and steppers, modified clicks, right-clicks and scrolls; they run in the background ([#15185](https://github.com/can1357/oh-my-pi/pull/15185) by [@will-bogusz](https://github.com/will-bogusz))
- `RpcClient.steer()`, `followUp()`, and `setThinkingLevel()` now reject with `RpcCommandError` when the server reports a failure instead of resolving silently ([#14166](https://github.com/can1357/oh-my-pi/pull/14166) by [@andrebrait](https://github.com/andrebrait)).
- Idle recap and idle compaction now run from one session-owned scheduler. Clearing a draft re-arms the recap and compaction that the stretch still owes, and a view that is returned to receives the recap it still owed; the former per-terminal timers dropped both ([can1357/oh-my-pi#14468](https://github.com/can1357/oh-my-pi/pull/14468) by [@andrebrait](https://github.com/andrebrait)).
- RPC: delta `message_update` frames (`messageUpdates: "delta"`) now carry the block on start/end events and the message on a restart, so a client can rebuild the streaming message; session-host clients can select the projection in their `hello` (`capabilities.messageUpdates`), which also covers a resume's replay ([#16220](https://github.com/can1357/oh-my-pi/pull/16220) by [@andrebrait](https://github.com/andrebrait))
- Hosted sessions stream replies as deltas and rebuild them in the client, so a long reply no longer sends the whole message again with every update ([#16220](https://github.com/can1357/oh-my-pi/pull/16220) by [@andrebrait](https://github.com/andrebrait))

### Changed

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
- Hosted launches reject invalid file attachments before starting a detached session host, avoiding orphaned background sessions ([#14166](https://github.com/can1357/oh-my-pi/pull/14166) by [@andrebrait](https://github.com/andrebrait)).
- RPC mode: an extension dialog opened during `session_start` can be answered instead of hanging startup; other commands still wait for startup to finish ([#14166](https://github.com/can1357/oh-my-pi/pull/14166) by [@andrebrait](https://github.com/andrebrait)).
- Session hosts publish before extension startup, so an attached terminal can answer a startup dialog instead of the launch timing out, and hosted launches with several CLI messages run each as its own turn ([#14166](https://github.com/can1357/oh-my-pi/pull/14166) by [@andrebrait](https://github.com/andrebrait)).
- Prompts, turn-triggering extension and advisor messages, IRC wakes and background launch completions that arrive during idle compaction now wait for it to finish before starting a turn ([can1357/oh-my-pi#14468](https://github.com/can1357/oh-my-pi/pull/14468) by [@andrebrait](https://github.com/andrebrait)).

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
### Breaking Changes


### Added


### Changed


### Changed


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
