# Windows baseline failure inventory (2026-11-09)

Data for [2026-11-09-foundation-infra-windows.md](2026-11-09-foundation-infra-windows.md), Group C. Source: full runs on Windows 11 x64, Bun 1.4.4, HEAD `01f4e57337` (fork), compared with fork baseline `66f8979`; upstream reference `upstream/main` = `0920fabe8e` (can1357/oh-my-pi, 18.18.4), fork base `96e4d8eb5b`. The raw logs are not in the repository; this file is the authoritative copy.

Reproduce: `OMP_TEST_CONCURRENCY=16 bun run test` from `packages/coding-agent` (Bun 1.4.4 first on PATH); `cargo test -p pi-shell`; `cargo clippy -p pi-shell --no-deps -- -D warnings` (toolchain from `rust-toolchain.toml`).

## coding-agent: 81 failing tests in 24 files

`upstream commits` = commits on `96e4d8eb5b..upstream/main` touching that test file (candidate test-side fixes; the source change that broke several of them is already in the fork base, e.g. `5febf19920` introduced `getConversationTip`).

| File | Count | Upstream commits | Test | First error |
|---|---|---|---|---|
| `test/modes/utils/render-initial-messages.test.ts` | 16 | 470f94702e | UiHelpers.renderInitialMessages — hidden tool activity > hides and restores persisted internal activity blocks | TypeError: sessionManager.getConversationTip is not a function. (In 'sessionManager.getConversationTip()', 'sessionManager.getConversationTip' is undefined) |
| `test/modes/utils/render-initial-messages.test.ts` | 16 | 470f94702e | UiHelpers.renderInitialMessages — hidden tool activity > hides replayed tool cards without discarding them from the persisted transcript | TypeError: sessionManager.getConversationTip is not a function. (In 'sessionManager.getConversationTip()', 'sessionManager.getConversationTip' is undefined) |
| `test/modes/utils/render-initial-messages.test.ts` | 16 | 470f94702e | UiHelpers.renderInitialMessages — hidden tool activity > hides the stripped-tool-calls placeholder with tool activity and restores it on r | TypeError: sessionManager.getConversationTip is not a function. (In 'sessionManager.getConversationTip()', 'sessionManager.getConversationTip' is undefined) |
| `test/modes/utils/render-initial-messages.test.ts` | 16 | 470f94702e | UiHelpers.renderInitialMessages — image replay > preserves hidden read images so enabling them later can replay the image | TypeError: sessionManager.getConversationTip is not a function. (In 'sessionManager.getConversationTip()', 'sessionManager.getConversationTip' is undefined) |
| `test/modes/utils/render-initial-messages.test.ts` | 16 | 470f94702e | UiHelpers.renderInitialMessages — image replay > preserves tool-result images while tool activity is hidden so revealing it can replay the | TypeError: sessionManager.getConversationTip is not a function. (In 'sessionManager.getConversationTip()', 'sessionManager.getConversationTip' is undefined) |
| `test/modes/utils/render-initial-messages.test.ts` | 16 | 470f94702e | UiHelpers.renderInitialMessages — image replay > replays reopened session image blocks through the cold-start rebuild path | TypeError: sessionManager.getConversationTip is not a function. (In 'sessionManager.getConversationTip()', 'sessionManager.getConversationTip' is undefined) |
| `test/modes/utils/render-initial-messages.test.ts` | 16 | 470f94702e | UiHelpers.renderInitialMessages — image replay > restores eval image blocks onto rebuilt tool output | TypeError: sessionManager.getConversationTip is not a function. (In 'sessionManager.getConversationTip()', 'sessionManager.getConversationTip' is undefined) |
| `test/modes/utils/render-initial-messages.test.ts` | 16 | 470f94702e | UiHelpers.renderInitialMessages — image replay > restores manual Bash image blocks from persisted message content | TypeError: sessionManager.getConversationTip is not a function. (In 'sessionManager.getConversationTip()', 'sessionManager.getConversationTip' is undefined) |
| `test/modes/utils/render-initial-messages.test.ts` | 16 | 470f94702e | UiHelpers.renderInitialMessages — prompt history isolation > never calls editor.addToHistory when rendering past user messages | TypeError: sessionManager.getConversationTip is not a function. (In 'sessionManager.getConversationTip()', 'sessionManager.getConversationTip' is undefined) |
| `test/modes/utils/render-initial-messages.test.ts` | 16 | 470f94702e | UiHelpers.renderInitialMessages — queued messages > keeps the queued-message bar after a mid-turn rebuild such as rewind (#13680) | TypeError: sessionManager.getConversationTip is not a function. (In 'sessionManager.getConversationTip()', 'sessionManager.getConversationTip' is undefined) |
| `test/modes/utils/render-initial-messages.test.ts` | 16 | 470f94702e | UiHelpers.renderInitialMessages — responsiveness > commits only the latest replay when a second one starts mid-replay | TypeError: sessionManager.getConversationTip is not a function. (In 'sessionManager.getConversationTip()', 'sessionManager.getConversationTip' is undefined) |
| `test/modes/utils/render-initial-messages.test.ts` | 16 | 470f94702e | UiHelpers.renderInitialMessages — responsiveness > keeps the complete transcript visible until an incremental replacement is ready | TypeError: sessionManager.getConversationTip is not a function. (In 'sessionManager.getConversationTip()', 'sessionManager.getConversationTip' is undefined) |
| `test/modes/utils/render-initial-messages.test.ts` | 16 | 470f94702e | UiHelpers.renderInitialMessages — responsiveness > splits a large plain transcript rebuild across event-loop turns | TypeError: sessionManager.getConversationTip is not a function. (In 'sessionManager.getConversationTip()', 'sessionManager.getConversationTip' is undefined) |
| `test/modes/utils/render-initial-messages.test.ts` | 16 | 470f94702e | UiHelpers.renderInitialMessages — responsiveness > yields across a large parallel read-result batch | TypeError: sessionManager.getConversationTip is not a function. (In 'sessionManager.getConversationTip()', 'sessionManager.getConversationTip' is undefined) |
| `test/modes/utils/render-initial-messages.test.ts` | 16 | 470f94702e | UiHelpers.renderSessionContext — error-stop tool calls > keeps the synthetic assistant error result instead of replaying a later tool resu | TypeError: sessionManager.getConversationTip is not a function. (In 'sessionManager.getConversationTip()', 'sessionManager.getConversationTip' is undefined) |
| `test/modes/utils/render-initial-messages.test.ts` | 16 | 470f94702e | UiHelpers.renderSessionContext — mid-stream tool call rebuild > decodes streamed write content from partialJson, not the provider's stale  | TypeError: sessionManager.getConversationTip is not a function. (In 'sessionManager.getConversationTip()', 'sessionManager.getConversationTip' is undefined) |
| `test/cli-responses-websocket-recovery.test.ts` | 13 | 19ef041ec5 | real CLI Responses WebSocket recovery > 426 uses the original HTTP 429 retry, tool and usage path, stays sticky, and resets on RPC newSessio | error: expect(received).toHaveLength(expected) |
| `test/cli-responses-websocket-recovery.test.ts` | 13 | 19ef041ec5 | real CLI Responses WebSocket recovery > an active complete service outage fails boundedly, then same-address restore uses SSE until a new se | error: expect(received).toHaveLength(expected) |
| `test/cli-responses-websocket-recovery.test.ts` | 13 | 19ef041ec5 | real CLI Responses WebSocket recovery > caller cancellation creates no late recovery or sticky downgrade and the next prompt still uses WS | error: Missing expected real CLI event |
| `test/cli-responses-websocket-recovery.test.ts` | 13 | 19ef041ec5 | real CLI Responses WebSocket recovery > first-event timeout remains a local failure and TurnRecovery continues over SSE instead of treating  | error: expect(received).toHaveLength(expected) |
| `test/cli-responses-websocket-recovery.test.ts` | 13 | 19ef041ec5 | real CLI Responses WebSocket recovery > idle timeout remains a local failure and TurnRecovery continues over SSE instead of treating it as c | error: expect(received).toHaveLength(expected) |
| `test/cli-responses-websocket-recovery.test.ts` | 13 | 19ef041ec5 | real CLI Responses WebSocket recovery > keeps an executed bash result when the next response disconnects without executing the call twice | error: Missing expected real CLI event |
| `test/cli-responses-websocket-recovery.test.ts` | 13 | 19ef041ec5 | real CLI Responses WebSocket recovery > keeps default-off setting on HTTP through the real CLI | error: expect(received).toHaveLength(expected) |
| `test/cli-responses-websocket-recovery.test.ts` | 13 | 19ef041ec5 | real CLI Responses WebSocket recovery > keeps explicitly disabled setting on HTTP through the real CLI | error: expect(received).toHaveLength(expected) |
| `test/cli-responses-websocket-recovery.test.ts` | 13 | 19ef041ec5 | real CLI Responses WebSocket recovery > keeps model veto under an enabled setting on HTTP through the real CLI | error: expect(received).toHaveLength(expected) |
| `test/cli-responses-websocket-recovery.test.ts` | 13 | 19ef041ec5 | real CLI Responses WebSocket recovery > never executes incomplete tool arguments and recovers the network failure over SSE | error: expect(received).toHaveLength(expected) |
| `test/cli-responses-websocket-recovery.test.ts` | 13 | 19ef041ec5 | real CLI Responses WebSocket recovery > replaces a successfully completed socket with full history and no old anchor | error: expect(received).toEqual(expected) |
| `test/cli-responses-websocket-recovery.test.ts` | 13 | 19ef041ec5 | real CLI Responses WebSocket recovery > retains text already delivered over RPC and TurnRecovery sends a new SSE continuation, not a replay | error: expect(received).toHaveLength(expected) |
| `test/cli-responses-websocket-recovery.test.ts` | 13 | 19ef041ec5 | real CLI Responses WebSocket recovery > round-trips text, actual bash and another user turn using socket-local incremental history | ? |
| `test/bash-failure-result.test.ts` | 11 | - | BashTool execution results > exposes the session identity to the command over a stale value in its shell | error: Failed to set cwd: /tmp is not an absolute path |
| `test/bash-failure-result.test.ts` | 11 | - | BashTool execution results > gives a call the identity of the session it started in, even if the session changes before it runs | error: Failed to set cwd: /tmp is not an absolute path |
| `test/bash-failure-result.test.ts` | 11 | - | BashTool execution results > gives each command the id of the tool call running it | error: Failed to set cwd: /tmp is not an absolute path |
| `test/bash-failure-result.test.ts` | 11 | - | BashTool execution results > persists the entire bounded trace when its JSON exceeds 200 KB | error: Failed to set cwd: /tmp is not an absolute path |
| `test/bash-failure-result.test.ts` | 11 | - | BashTool execution results > preserves final-stage output when a pipeline ends in head or tail | error: Failed to set cwd: /tmp is not an absolute path |
| `test/bash-failure-result.test.ts` | 11 | - | BashTool execution results > preserves timing-like stdout in shell views at 0 ms | error: Failed to set cwd: /tmp is not an absolute path |
| `test/bash-failure-result.test.ts` | 11 | - | BashTool execution results > preserves timing-like stdout in shell views at 1000 ms | error: Failed to set cwd: /tmp is not an absolute path |
| `test/bash-failure-result.test.ts` | 11 | - | BashTool execution results > resolves with an error result carrying execution details instead of throwing | error: Failed to set cwd: /tmp is not an absolute path |
| `test/bash-failure-result.test.ts` | 11 | - | BashTool execution results > returns a success result with no exit-code detail for a zero exit | error: Failed to set cwd: /tmp is not an absolute path |
| `test/bash-failure-result.test.ts` | 11 | - | BashTool execution results > says a command that printed nothing exited cleanly, so an empty result reads as success | error: Failed to set cwd: /tmp is not an absolute path |
| `test/bash-failure-result.test.ts` | 11 | - | BashTool skill:// containment failures > refuses a read through a symlink past the plugin boundary | error: Failed to set cwd: /tmp is not an absolute path |
| `test/tools/browser-webmcp.test.ts` | 10 | - | browser WebMCP helpers > blames the Chrome version only when invokeTool itself is missing, not for another error saying something wasn't fou | error: net::ERR_CONNECTION_REFUSED at http://localhost:49836/ |
| `test/tools/browser-webmcp.test.ts` | 10 | - | browser WebMCP helpers > cancels the page's tool invocation when the call is aborted | error: net::ERR_CONNECTION_REFUSED at http://localhost:58197/ |
| `test/tools/browser-webmcp.test.ts` | 10 | - | browser WebMCP helpers > discovers, invokes, bounds trust, and reports native registrations | error: net::ERR_CONNECTION_REFUSED at http://localhost:63006/ |
| `test/tools/browser-webmcp.test.ts` | 10 | - | browser WebMCP helpers > forgets a page's tools once it navigates and finds the next page's | error: net::ERR_CONNECTION_REFUSED at http://localhost:54914/first |
| `test/tools/browser-webmcp.test.ts` | 10 | - | browser WebMCP helpers > keeps a page alive whose same-site iframe is touched before it navigates | error: net::ERR_CONNECTION_REFUSED at http://localhost:64531/ |
| `test/tools/browser-webmcp.test.ts` | 10 | - | browser WebMCP helpers > leaves the page's globals and modelContext alone, before and after a webmcp helper runs | error: net::ERR_CONNECTION_REFUSED at http://localhost:56758/ |
| `test/tools/browser-webmcp.test.ts` | 10 | - | browser WebMCP helpers > lists a same-process iframe's tools, registered before the first call, until the iframe navigates | error: net::ERR_CONNECTION_REFUSED at http://localhost:60168/ |
| `test/tools/browser-webmcp.test.ts` | 10 | - | browser WebMCP helpers > lists and invokes a tool a cross-origin iframe registers in its own process | error: net::ERR_CONNECTION_REFUSED at http://localhost:53657/ |
| `test/tools/browser-webmcp.test.ts` | 10 | - | browser WebMCP helpers > never starts the page's tool once the call is aborted | error: net::ERR_CONNECTION_REFUSED at http://localhost:56500/ |
| `test/tools/browser-webmcp.test.ts` | 10 | - | browser WebMCP helpers > stops following a cross-origin iframe's session once the iframe is gone | error: net::ERR_CONNECTION_REFUSED at http://localhost:55207/ |
| `test/sdk-mcp-instructions.test.ts` | 5 | - | createAgentSession MCP server instructions (deferred UI) > adds no route summary for an MCP tool whose docs are inlined | error: expect(received).toContain(expected) |
| `test/sdk-mcp-instructions.test.ts` | 5 | - | createAgentSession MCP server instructions (deferred UI) > bounds mounted route guidance deterministically and points to the live xd:// inve | error: expect(received).toHaveLength(expected) |
| `test/sdk-mcp-instructions.test.ts` | 5 | - | createAgentSession MCP server instructions (deferred UI) > folds server instructions into the prompt once deferred discovery connects | error: expect(received).toContain(expected) |
| `test/sdk-mcp-instructions.test.ts` | 5 | - | createAgentSession MCP server instructions (deferred UI) > lists an inline-policy MCP tool whose docs overflow the cap once, on its route li | error: expect(received).toContain(expected) |
| `test/sdk-mcp-instructions.test.ts` | 5 | - | createAgentSession MCP server instructions (deferred UI) > renders a mounted Context Mode route when initialize omits instructions | error: expect(received).toContain(expected) |
| `test/repro-issue-1955-sendmessage-double-render.test.ts` | 4 | 470f94702e | issue #1955 — sendMessage(display:true) during session_start > after the initial render, sendMessage(display:true) still renders the messa | TypeError: sessionManager.getConversationTip is not a function. (In 'sessionManager.getConversationTip()', 'sessionManager.getConversationTip' is undefined) |
| `test/repro-issue-1955-sendmessage-double-render.test.ts` | 4 | 470f94702e | issue #1955 — sendMessage(display:true) during session_start > defers display rebuilds that arrive during a later incremental replay | TypeError: sessionManager.getConversationTip is not a function. (In 'sessionManager.getConversationTip()', 'sessionManager.getConversationTip' is undefined) |
| `test/repro-issue-1955-sendmessage-double-render.test.ts` | 4 | 470f94702e | issue #1955 — sendMessage(display:true) during session_start > defers display rebuilds that arrive during the incremental initial replay | TypeError: sessionManager.getConversationTip is not a function. (In 'sessionManager.getConversationTip()', 'sessionManager.getConversationTip' is undefined) |
| `test/repro-issue-1955-sendmessage-double-render.test.ts` | 4 | 470f94702e | issue #1955 — sendMessage(display:true) during session_start > renders the custom message exactly once after the initial transcript render | TypeError: sessionManager.getConversationTip is not a function. (In 'sessionManager.getConversationTip()', 'sessionManager.getConversationTip' is undefined) |
| `test/skills.test.ts` | 3 | - | collision handling > drops a provider skill identical to a custom override instead of re-admitting it | error: expect(received).toEqual(expected) |
| `test/skills.test.ts` | 3 | - | collision handling > lets a custom override that matches a namespaced provider alias take the bare name | error: expect(received).toEqual(expected) |
| `test/skills.test.ts` | 3 | - | collision handling > lets a custom-directory skill override a provider skill and keeps a taken namespaced slot suffixed | error: expect(received).toHaveLength(expected) |
| `test/system-prompt-inventory.test.ts` | 2 | c28b3e3e42 4e25949931 | system prompt tool inventory > does not construct descriptor records for a compact native inventory | error: expect(received).toBe(expected) |
| `test/system-prompt-inventory.test.ts` | 2 | c28b3e3e42 4e25949931 | system prompt tool inventory > projects compact metadata in active order without reading descriptors or inactive tools | error: expect(received).toBe(expected) |
| `test/repro-issue-6879-tool-double-render-retry.test.ts` | 2 | 470f94702e | issue #6879 — tool output appears twice after a superseded turn > re-keys a streamed tool card when its id grows across deltas (piped copi | error: expect(received).toBe(expected) |
| `test/repro-issue-6879-tool-double-render-retry.test.ts` | 2 | 470f94702e | issue #6879 — tool output appears twice after a superseded turn > re-keys a streamed tool card when its id is populated after the block ap | error: expect(received).toBe(expected) |
| `test/issue-4348-repro.test.ts` | 1 | 470f94702e | issue #4348: cursor exec-channel tool results pair with synthesized toolCall blocks on rebuild > renders bash toolResult inside a ToolExecut | TypeError: sessionManager.getConversationTip is not a function. (In 'sessionManager.getConversationTip()', 'sessionManager.getConversationTip' is undefined) |
| `test/modes/controllers/event-controller-loader-recovery.test.ts` | 1 | 470f94702e | EventController loader recovery after overflow maintenance > ticks the auto-retry countdown down on spinner ticks instead of freezing | error: expect(received).toContain(expected) |
| `test/modes/controllers/input-controller-tool-expansion.test.ts` | 1 | 470f94702e | InputController tool output expansion > expands children and forces a full repaint so every live block re-renders | TypeError: undefined is not an object (evaluating 'this.ctx.pendingShellContainer.children') |
| `test/agent-session-interrupt-queued-messages.test.ts` | 1 | 470f94702e | AgentSession editor-restoring interrupt > records an extension message the run already took for its next model call exactly once | error: expect(received).toHaveLength(expected) |
| `test/advisor-tool-call-loop-guard.test.ts` | 1 | 470f94702e | advisor tool-call loop guard > redirects the advisor's own repeated tool call and reaches its next request | error: expect(received).toHaveLength(expected) |
| `test/bash-autobg-timer.test.ts` | 1 | - | bash auto-background threshold timer (#7235) > does not keep the event loop alive after a fast command completes | error: expect(received).toBe(expected) |
| `test/cost-gate-skill-description.test.ts` | 1 | 463d44a950 | meters completed background skill compression against the session tree | error: expect(received).toEqual(expected) |
| `test/rpc-goal.test.ts` | 1 | 470f94702e | RPC goal command > an extension session change aborts the detached run's prompt; the command's own result is unaffected | error: Client stopped |
| `test/tools/browser-attach.test.ts` | 1 | adf978c1b6 d45677f999 | pickElectronTarget > waits for a real attached Chromium's first page before opening the managed tab | ? |
| `test/cli-provider-model-deferral.test.ts` | 1 | - | print-mode suggestions for a provider-qualified miss > never lists other providers' models | ? |
| `test/thread/focus-view.test.ts` | 1 | d488335771 | focused view of a worker-homed agent session > cycles the thinking level on both sides and redraws the status line from the mirror | ? |
| `test/tools/browser-storage-state.test.ts` | 1 | - | browser cookie and storage state helpers > imports cookies, round-trips storage, and restores a saved state in a fresh tab | error: expect(received).toEqual(expected) |
| `test/usage-cli.test.ts` | 1 | - | omp usage saved-reset expiry banner > names the stored credential of each same-email Codex workspace | error: expect(received).toContain(expected) |
| `test/tools/browser-cmux-release-mid-run.test.ts` | 1 | adf978c1b6 | browser tab-supervisor — cmux tab close mid-run (#4499) > screenshot coordinate note with measured viewport width | error: expect(received).toContain(expected) |
| `test/settings-live-routing.test.ts` | 1 | - | live routing config files > applies atomic overlay edits to subsequent model selection, fallbacks and account health | ? |

## pi-shell: 59 failing `cargo test -p pi-shell` tests

Same set as the fork baseline (no new failures; one baseline failure now passes). Upstream commits touching `crates/pi-shell` with Windows/clippy fixes since the base: `63fe0eae7a fix(shell): allow unix-only clippy lints on named-pipe pump stubs`, `9e0d6a0588 fix(build): give bazel pi-shell's Windows console terminfo entry`, `fdd10fcf4a Merge PR #18532: feat(shell): run omp zsh on Windows (@H4vC)`, `9f8c1ce438 fix(shell): Windows-only Ctrl-C ignore and utility fallback; /dev/tty, MSYS signal exits, pipeline job lines`, `d6e00e0122 fix(shell): address review of omp zsh on Windows`, `df6fcdf98c feat(shell): run omp zsh on Windows`, `d90207ce3e style(pi-shell): formatted sd write-effect detection for rustfmt and clippy`, `d99617eb59 fix(pi-shell): cover console usability and INT on Windows externals`, `57e28de771 fix(pi-shell): isolate Windows externals from the host console`, `88f9a60516 fix(rust): satisfied the current nightly's clippy lints`, `1202986a2f Merge PR #18042: fix(shell): preserve Windows roots during logical cd (@jchanghong023)`, `3d6344d5ba fix(rust): clear Windows-only clippy errors in pi-shell and pi-vcs`, `1fdc73bc5f fix(shell): preserve Windows roots during logical cd`, `b1d7aa1399 style(rust): resolved clippy and rustfmt findings blocking release`.

| Test | Signature |
|---|---|
| `bash::vm::builtins::zsh_mod_zprof::tests::report_lists_callers_and_callees` | assertion `left == right` failed \| left: "num  calls                time |
| `bash::vm::zle::refresh::tests::region_highlight_entries_and_trashed_display` | assertion `left == right` failed \| left: "\u{1b}[0m\u{1b}[27m\u{1b}[24m\r\u{1b}[2C\u{1b}[1m\u{1b} |
| `output_decode::tests::incomplete_utf8_at_eof_becomes_replacement` | assertion `left == right` failed \| left: "д" |
| `shell::tests::builtins::cmp_is_registered_as_an_in_process_builtin` | assertion `left == right` failed \| left: 2 |
| `shell::tests::builtins::command_v_iterates_all_operands` | out.txt: Os { code: 2, kind: NotFound, message: "The system cannot find the file specified." } \| ---- shell::tests::built |
| `shell::tests::builtins::every_process_builtin_is_installed_and_dispatches` | type.txt: Os { code: 2, kind: NotFound, message: "The system cannot find the file specified." } \| ---- |
| `shell::tests::builtins::every_utility_builtin_is_registered_under_its_own_name` | type.txt: Os { code: 2, kind: NotFound, message: "The system cannot find the file specified." } \| |
| `shell::tests::builtins::fd_builtin_uses_fd_defaults` | fd missed visible file: "" \| ---- shell::tests::env_cwd::inherited_short_temp_matches_pwd_after_cd stdout ---- |
| `shell::tests::builtins::grep_quiet_and_line_regexp` | assertion `left == right` failed: -q match must exit 0 \| left: "" |
| `shell::tests::builtins::moreutils_builtins_are_registered_in_process` | sponge output: Os { code: 2, kind: NotFound, message: "The system cannot find the file specified." } \| ---- s |
| `shell::tests::builtins::rg_builtin_defaults_to_cwd_unless_stdin_is_pipeline` | assertion `left == right` failed \| left: "from-cwd\n" |
| `shell::tests::builtins::rg_builtin_uses_ripgrep_defaults` | rg missed visible file: "" \| ---- testkit::suites::zsh_mod_datetime::langinfo_in_the_c_locale stdout ---- |
| `shell::tests::builtins::sort_merge_into_the_file_on_stdin_keeps_all_input` | assertion `left == right` failed: bash: line 1: cd: C:\Users\spgs\AppData\Local\Temp\.tmpPzmpUU: The fi |
| `shell::tests::builtins::uutils_filters_listing_find_grep` | assertion `left == right` failed \| left: "" |
| `shell::tests::builtins::uutils_find_display_and_actions_split_paths` | assertion `left == right` failed: -path should match the operand-relative path \| left: "" |
| `shell::tests::builtins::uutils_head_help_and_bad_flag_do_not_exit_process` | help.txt: Os { code: 2, kind: NotFound, message: "The system cannot find the file specified." } \| ---- |
| `shell::tests::builtins::uutils_head_streams_stdin_and_reads_files` | assertion `left == right` failed: head file read should succeed \| left: 1 |
| `shell::tests::builtins::uutils_jq_filters_json_and_propagates_exit_status` | assertion `left == right` failed \| left: "" |
| `shell::tests::builtins::uutils_mkdir_help_and_bad_flag_do_not_exit_process` | help.txt: Os { code: 2, kind: NotFound, message: "The system cannot find the file specified." } \| ---- |
| `shell::tests::builtins::uutils_mkdir_resolves_cwd_and_displays_operand` | nested dirs not created under shell cwd \| ---- shell::tests::builtins::uutils_find_display_and_actions_spli |
| `shell::tests::builtins::uutils_rm_and_mv_operate_on_shell_cwd` | assertion `left == right` failed: mv should succeed \| left: 1 |
| `shell::tests::builtins::uutils_rm_missing_file_prints_single_diagnostic` | err.txt: Os { code: 2, kind: NotFound, message: "The system cannot find the file specified." } \| ---- sh |
| `shell::tests::builtins::uutils_sed_substitutes_streams_and_edits_in_place` | assertion `left == right` failed \| left: "" |
| `shell::tests::env_cwd::inherited_short_temp_matches_pwd_after_cd` | assertion `left == right` failed \| left: 1 |
| `shell::tests::env_cwd::session_env_short_temp_matches_pwd_after_cd` | assertion `left == right` failed \| left: 1 |
| `shell::tests::process_control::ps_builtin_lists_one_line_per_thread_with_m` | %CPU: "?" \| ---- shell::tests::builtins::rg_builtin_defaults_to_cwd_unless_stdin_is_pipeline std |
| `testkit::suites::zsh_mod_datetime::langinfo_in_the_c_locale` | assertion `left == right` failed \| left: "zsh:1: $langinfo[CODESET] on this platform: not supported by this |
| `testkit::suites::zsh_mod_datetime::strftime_options` | assertion `left == right` failed \| left: "01/10/08\n01/10/08\n" |
| `testkit::suites::zsh_mod_datetime::strftime_reverse` | assertion `left == right` failed \| left: "1699920000\n1699920000\n1681084800\n1583366400\n1583397000\n1577836800\n1 |
| `testkit::suites::zsh_mod_example::zsh_mod_example_builtin_shows_and_sets_its_parameters` | assertion `left == right` failed \| left: "The example module has now been set up. |
| `testkit::suites::zsh_mod_files::zsh_mod_files_mkdir` | assertion `left == right` failed \| left: "1\n1\n1\n040700\n1\n1\n" |
| `testkit::suites::zsh_mod_files::zsh_mod_files_mv_ln_chmod` | assertion `left == right` failed \| left: "a\nd/g\n1\n1\n1\n1\nd/g\na\n1\n0\na\n0100600\n1\n1\n0100755\n0100700\nd |
| `testkit::suites::zsh_mod_mathfunc::every_function_on_sample_arguments` | assertion `left == right` failed \| left: "3 2.5 1.0471975511965979 0.52359877559829893 0.785398163 |
| `testkit::suites::zsh_mod_system::zsh_mod_system_bad_fds_set_errno` | assertion `left == right` failed \| left: "The operation completed successfully.\n" |
| `testkit::suites::zsh_mod_system::zsh_mod_system_pipes_do_not_seek` | assertion `left == right` failed \| left: "The system cannot write to the specified device.\n" |
| `testkit::suites::zsh_mod_system::zsh_mod_system_syserror` | assertion `left == right` failed \| left: "The storage control block address is invalid.\n2\n1\n" |
| `testkit::suites::zsh_mod_terminfo::another_term_replaces_the_boot_one` | assertion `left == right` failed \| left: "bs=no\n<> 0\nbs=no\n<> 0\n" |
| `testkit::suites::zsh_mod_terminfo::capability_errors` | assertion `left == right` failed \| left: "" |
| `testkit::suites::zsh_mod_terminfo::dumb_terminal` | assertion `left == right` failed \| left: "1\n1\n1\n\n0 44 0 0\n$''\n$'bw' $'no' $'am' $'no' $'xb' $'no' $'xs' $'no' $' |
| `testkit::suites::zsh_mod_terminfo::echotc_xterm_values` | assertion `left == right` failed \| left: "1\n" |
| `testkit::suites::zsh_mod_terminfo::echoti_xterm_values` | assertion `left == right` failed \| left: "" |
| `testkit::suites::zsh_mod_terminfo::held_terminal_from_boot_is_set_up_without_tgetent` | assertion `left == right` failed \| left: "bs=no\n<> 0\nbs=no\n<> 0\n1\nbs=no\n<> 0 |
| `testkit::suites::zsh_mod_terminfo::modules_autoload_on_use` | assertion `left == right` failed \| left: "1\n0\n1\n\n0\n" |
| `testkit::suites::zsh_mod_terminfo::scans_list_the_held_terminal` | assertion `left == right` failed \| left: "0 bw am xb xs xn eo gn hc km hs in da db mi ms os es xt hz ul |
| `testkit::suites::zsh_mod_terminfo::termcap_module_boots_first` | assertion `left == right` failed \| left: "44\nbs=no\n<> 0\n'' 44\nbs=no\n<> 0\n" |
| `testkit::suites::zsh_mod_terminfo::terminfo_termcap_elements` | assertion `left == right` failed \| left: "\n'' '' '' ''\n'' 0 0 0\nassociation-readonly-hide-hideval-specia |
| `testkit::suites::zsh_mod_terminfo::tgetent_adjusts_the_held_terminal` | assertion `left == right` failed \| left: "bs=no\n<> 0\n''\nbs=no\n<> 0\n" |
| `testkit::suites::zsh_mod_terminfo::tgetent_moves_obsolete_defaults` | assertion `left == right` failed \| left: "<>\n''\n<>\n<>\n" |
| `testkit::suites::zsh_mod_zmodload::builtins_autoload_their_module` | assertion `left == right` failed \| left: "1\nzsh/complete\nzsh/main\nzsh/zle\nzsh/zutil\n-b:zformat\n |
| `testkit::suites::zsh_mod_zmodload::module_param_blocked_by_existing_param` | assertion `left == right` failed \| left: ("scrooble\n0\na\nb\nst=2\n+b:strftime\n-p:EPOCHSECO |
| `testkit::suites::zsh_mod_zmodload::typeset_h_on_module_special` | assertion `left == right` failed \| left: ("integer-readonly-hideval-special\ninteger-readonly-hide-hidev |
| `testkit::suites::zsh_mod_zprof::zsh_mod_zprof_counts_calls_of_one_function` | assertion `left == right` failed \| left: "num calls time self name\n---------------------------- |
| `testkit::suites::zsh_mod_zprof::zsh_mod_zprof_lists_callers_and_callees` | assertion `left == right` failed \| left: ["", "", "\t\t\t n 1) 2 # # #% # # #% f", "\t\t\t n 4/4 # |
| `testkit::suites::zsh_mod_zprof::zsh_mod_zprof_names_anonymous_functions_by_file_and_line` | assertion `left == right` failed \| left: ["", "", "\t\t\t n 1) 2 # # #% # # #% (a |
| `testkit::suites::zsh_parity::expandmb_sorting_follows_lc_collate` | assertion `left == right` failed \| left: ("B a b10 b9 drive.py oracle.py oracle_ob.py\noracle_ob.py oracle.p |
| `testkit::suites::zsh_parity::funcs_commands_lists_every_entry_of_path` | assertion `left == right` failed \| left: "ztst.zsh 1 /tmp/ctst/plain\nplain=/tmp/ctst/plain\nsub=/tmp/c |
| `testkit::suites::zsh_prompt_names::attributes_for_dumb` | assertion `left == right` failed \| left: "bxussk\u{1b}[31mr\u{1b}[39m\u{1b}[44mb\u{1b}[49m\u{1b}[3123mn\u{1b}[39 |
| `testkit::suites::zsh_prompt_names::attributes_for_xterm_256color` | assertion `left == right` failed \| left: "bxussk\u{1b}[31mr\u{1b}[39m\u{1b}[44mb\u{1b}[49m\u{1b}[3123m |
| `testkit::suites::zsh_prompt_names::bookmarks_file_registers_named_directories` | assertion `left == right` failed \| left: "st=0\ncfg=/tmp/pn/h/.config\ndl=/tmp/pn/h/Downl |

## pi-shell Clippy on Windows: 865 errors, 80 lints

`cargo clippy -p pi-shell --no-deps -- -D warnings`; every warning is an error because of `-D warnings`. Workspace lint levels: `Cargo.toml` `[workspace.lints.clippy]` (`pedantic`/`nursery`/`perf`/`style` = warn, `correctness`/`suspicious` = deny). Upstream CI runs Clippy through Bazel (`bazel/clippy.bazelrc`, `--config=clippy-strict` for pi-shell) on its Linux runner; whether any upstream job runs it for a Windows target is part of task C-1.

| Lint | Count |
|---|---|
| `clippy::many_single_char_names` | 279 |
| `clippy::missing_const_for_fn` | 89 |
| `clippy::single_match_else` | 57 |
| `clippy::useless_let_if_seq` | 39 |
| `clippy::map_unwrap_or` | 38 |
| `clippy::doc_markdown` | 27 |
| `clippy::needless_pass_by_ref_mut` | 25 |
| `clippy::if_not_else` | 22 |
| `clippy::too_long_first_doc_paragraph` | 20 |
| `clippy::assigning_clones` | 19 |
| `clippy::needless_borrows_for_generic_args` | 16 |
| `clippy::redundant_clone` | 14 |
| `clippy::branches_sharing_code` | 13 |
| `clippy::collapsible_if` | 12 |
| `clippy::chunks_exact_to_as_chunks` | 12 |
| `clippy::suboptimal_flops` | 11 |
| `clippy::option_option` | 10 |
| `clippy::nonminimal_bool` | 10 |
| `clippy::allow_attributes_without_reason` | 9 |
| `clippy::unnecessary_wraps` | 9 |
| `clippy::semicolon_if_nothing_returned` | 6 |
| `clippy::redundant_closure` | 6 |
| `clippy::or_fun_call` | 5 |
| `clippy::type_complexity` | 5 |
| `clippy::explicit_auto_deref` | 5 |
| `clippy::collapsible_match` | 5 |
| `clippy::naive_bytecount` | 4 |
| `clippy::disallowed_names` | 4 |
| `clippy::manual_contains` | 4 |
| `clippy::use_self` | 4 |
| `clippy::ref_option` | 4 |
| `clippy::manual_let_else` | 4 |
| `clippy::needless_option_as_deref` | 4 |
| `dead_code` | 3 |
| `clippy::needless_late_init` | 3 |
| `clippy::format_push_string` | 3 |
| `clippy::byte_char_slices` | 3 |
| `clippy::assign_op_pattern` | 3 |
| `clippy::needless_borrow` | 3 |
| `clippy::needless_range_loop` | 3 |
| `clippy::mem_replace_option_with_some` | 3 |
| `clippy::unused_self` | 3 |
| `clippy::while_let_loop` | 2 |
| `clippy::bool_to_int_with_if` | 2 |
| `clippy::doc_link_code` | 2 |
| `clippy::manual_slice_fill` | 2 |
| `clippy::equatable_if_let` | 2 |
| `clippy::question_mark` | 2 |
| `clippy::manual_is_multiple_of` | 2 |
| `clippy::manual_checked_ops` | 2 |
| `clippy::manual_flatten` | 2 |
| `clippy::int_plus_one` | 1 |
| `clippy::suspicious_operation_groupings` | 1 |
| `clippy::struct_field_names` | 1 |
| `clippy::decimal_bitwise_operands` | 1 |
| `clippy::needless_continue` | 1 |
| `clippy::imprecise_flops` | 1 |
| `clippy::unnecessary_min_or_max` | 1 |
| `clippy::fn_params_excessive_bools` | 1 |
| `clippy::unnecessary_filter_map` | 1 |
| `clippy::uninlined_format_args` | 1 |
| `clippy::cloned_ref_to_slice_refs` | 1 |
| `clippy::redundant_locals` | 1 |
| `clippy::single_match` | 1 |
| `clippy::let_and_return` | 1 |
| `clippy::unnecessary_unwrap` | 1 |
| `clippy::cmp_owned` | 1 |
| `clippy::if_same_then_else` | 1 |
| `clippy::manual_ignore_case_cmp` | 1 |
| `clippy::boxed_local` | 1 |
| `clippy::manual_unwrap_or_default` | 1 |
| `clippy::derivable_impls` | 1 |
| `clippy::needless_collect` | 1 |
| `clippy::ptr_arg` | 1 |
| `clippy::enum_variant_names` | 1 |
| `clippy::manual_repeat_n` | 1 |
| `clippy::non_send_fields_in_send_ty` | 1 |
| `clippy::volatile_composites` | 1 |
| `clippy::implicit_hasher` | 1 |
| `unfulfilled_lint_expectations` | 1 |

| File | Count |
|---|---|
| `crates/pi-shell/src/bash/vm/zle/comp/complist/print.rs` | 47 |
| `crates/pi-shell/src/bash/vm/zle/comp/compmatch/join.rs` | 39 |
| `crates/pi-shell/src/bash/vm/zle/comp/compmatch.rs` | 35 |
| `crates/pi-shell/src/bash/vm/zle/comp/compctl/generate.rs` | 33 |
| `crates/pi-shell/src/bash/vm/zle/comp/compresult.rs` | 33 |
| `crates/pi-shell/src/bash/vm/zle/comp/compresult/list.rs` | 26 |
| `crates/pi-shell/src/bash/vm/builtins/zsh_mod_datetime.rs` | 24 |
| `crates/pi-shell/src/bash/vm/zle/comp/complete.rs` | 21 |
| `crates/pi-shell/src/bash/vm/builtins/zsh_mod_zprof.rs` | 20 |
| `crates/pi-shell/src/bash/vm/zle/exec.rs` | 20 |
| `crates/pi-shell/src/bash/vm/zle/comp/tricky/compstring.rs` | 19 |
| `crates/pi-shell/src/bash/vm/zle/comp/complist/menu.rs` | 18 |
| `crates/pi-shell/src/bash/vm/builtins/history/bang.rs` | 17 |
| `crates/pi-shell/src/bash/syntax/zsh/wordcode.rs` | 16 |
| `crates/pi-shell/src/bash/vm/zle/comp/compcore/add.rs` | 16 |
| `crates/pi-shell/src/bash/vm/zle/comp/compctl/mod.rs` | 14 |
| `crates/pi-shell/src/bash/vm/zle/comp/computil/args.rs` | 14 |
| `crates/pi-shell/src/bash/vm/zle/reader.rs` | 14 |
| `crates/pi-shell/src/bash/vm/zsh/terminfo_db.rs` | 14 |
| `crates/pi-shell/src/bash/vm/builtins/zsh_mod_curses.rs` | 13 |
| `crates/pi-shell/src/bash/vm/builtins/zsh_module.rs` | 13 |
| `crates/pi-shell/src/bash/vm/builtins/zsh_mod_nearcolor.rs` | 12 |
| `crates/pi-shell/src/bash/vm/zle/comp/compcore/strings.rs` | 12 |
| `crates/pi-shell/src/bash/vm/builtins/zsh_mod_zftp/io.rs` | 11 |
| `crates/pi-shell/src/bash/vm/builtins/history/file.rs` | 10 |
| `crates/pi-shell/src/bash/vm/zle/bindkey.rs` | 10 |
| `crates/pi-shell/src/bash/vm/builtins/history/zsh.rs` | 9 |
| `crates/pi-shell/src/bash/vm/builtins/zsh_mod_zutil.rs` | 9 |
| `crates/pi-shell/src/bash/vm/builtins/zsh_prompt.rs` | 9 |
| `crates/pi-shell/src/bash/vm/zle/comp/tricky.rs` | 9 |
| `crates/pi-shell/src/bash/vm/builtins/zsh_mod_files.rs` | 9 |
| `crates/pi-shell/src/bash/vm/zle/params.rs` | 9 |
| `crates/pi-shell/src/bash/syntax/zsh/lex.rs` | 9 |
| `crates/pi-shell/src/bash/vm/zle/comp/computil/files.rs` | 8 |
| `crates/pi-shell/src/bash/vm/zle/widgets/isearch.rs` | 8 |
| `crates/pi-shell/src/bash/vm/builtins/zsh_mod_system.rs` | 8 |
| `crates/pi-shell/src/bash/vm/builtins/zsh_names.rs` | 8 |
| `crates/pi-shell/src/bash/vm/jobctl.rs` | 8 |
| `crates/pi-shell/src/bash/vm/zle/widgets/misc.rs` | 8 |
| `crates/pi-shell/src/sys/langinfo.rs` | 8 |
