# Windows coding-agent baseline classification (2026-11-09)

Classification of the 81 failing coding-agent tests from
[2026-11-09-windows-baseline-data.md](2026-11-09-windows-baseline-data.md) (Group C, Task 8 / C-1).
Fork HEAD at classification time: `2e66ccf73e`; upstream reference fetched to `refs/remotes/upstream/main` (`f0200abf28`; the data file was cut against `0920fabe8e`).
Evidence below was verified by `git show --stat` against every candidate commit and by re-running every failing file on the controller's macOS host (fork HEAD). macOS results distinguish "stale test / fork regression / deterministic test bug" (fails identically on macOS) from "Windows-specific" (passes on macOS).

## Cluster summary

| Cluster | Tests | Files | Decision |
| --- | --- | --- | --- |
| A. Stale tests vs base source (`getConversationTip` + friends); upstream test-only fix `470f94702e` | 28 | 9 | fix test: port `470f94702e` |
| B. Upstream test fixes, other commits (verified test-only unless noted) | 16 | 4 | fix test: port each test-side diff |
| B2. Fork-side prompt-template regression (`31b752b304`) — NOT upstream-stale | 2 | 1 | fix source template (restore base shape) |
| C. Windows path assumptions (POSIX `/tmp` cwd) | 12 | 2 | fix test: `os.tmpdir()` |
| D. Environment / browser (`ERR_CONNECTION_REFUSED` on `localhost`) | 10 | 1 | investigate; needs Windows host |
| E. Ambient environment leakage (`sdk-mcp-instructions`) | 5 | 1 | fix isolation (F-3 pattern) |
| E2. Unverified on Windows; macOS passes deterministically | 4 | 2 | pending Windows isolation re-run |
| F. Load-flaky (INF-3) | 4 | 4 | covered by Task 7 (`6ac3ba7d69`) |
| **Total** | **81** | **24** | |

Counts: A 28 + B 16 + B2 2 + C 12 + D 10 + E 5 + E2 4 + F 4 = 81.

## Step 2 — upstream commit verification (test-only?)

| Commit | Files touched | Test-only? | Pairs with source |
| --- | --- | --- | --- |
| `470f94702e` test(coding-agent): adjusted tests for abort handling and rendering expectations (2026-11-06) | 12 files, all under `packages/*/test/` | **Yes** (test + fixtures only) | The source change it adapts to is `5febf19920` (fix(coding-agent): order the replayed recap…, adds `getConversationTip` to `SessionManager`/handle), which is already in the fork base/HEAD — verified `git merge-base --is-ancestor 5febf19920 HEAD` → true |
| `19ef041ec5` fix(ipc): fixed IPC test exit by tightening timeouts and tracking closure | 3 files: `packages/ai/test/openai-responses-websocket.test.ts`, `packages/coding-agent/test/cli-responses-websocket-recovery.test.ts`, `packages/natives/test/ipc.test.ts` | **Yes** (despite `fix(ipc)` subject, diff touches only tests) | None; the websocket hunk raises a `first` timeout from 0.2 s to 1 s ("can expire during the WebSocket handshake on a loaded machine") |
| `c28b3e3e42` feat(catalog): added balanced delegation bias | catalog `axes.ts`/`delegation.ts`, coding-agent `system-prompt.ts`, `prompt-policy.ts`, `tools/eval.ts`, prompts md + tests | **No** | Its own source changes (new `balanced` delegation tier). The test hunks update delegation-bias expectations to match |
| `4e25949931` test(coding-agent): ended the inventory slice at the new section marker | 1 test file | **Yes** | `1c241750ae` (feat(coding-agent/prompts): § → ⁂ section marker) — **not in the fork** (verified), so this hunk is not applicable as-is |
| `463d44a950` test(coding-agent): improved test reliability and environment handling | 3 test/fixture files | **Yes** | None; unsets `PI_TEST_RUNTIME` on the child fixture so it runs outside the test runtime |
| `adf978c1b6` fix(browser): improved process termination robustness | 4 test files (imports existing `gracefulKillTreeOnce` export from src; no src change) | **Yes** | None for the test-only hunks |
| `d45677f999` feat(browser): prevented renderer backgrounding on macOS | `src/tools/browser/launch.ts` (adds `RENDERER_PRIORITY_ARGS`) + 7 test files | **No** | Its own launch.ts change (macOS-only flags) |
| `d488335771` refactor(agent): refined session state synchronization and tool management | `crates/pi-shell/src/bash/mem.rs` + 6 coding-agent src files + 3 test files | **No** | Its own session-mirror delta / MCP tool-version sync refactor (src/thread/*) |
| `4ce16b953f` fix(tui): serialize live events after focus attachment | src (event-controller, session-focus-controller, interactive-mode, ui-helpers) + tests | **No** | Its own source changes (focus-view follow-up) |

## Cluster A — stale tests vs base source (28 tests, 9 files)

Source `5febf19920` added `getConversationTip()` (called at `src/modes/utils/ui-helpers.ts:970`) and changed abort/rendering behavior; the fork's test mocks predate it. Every file in this cluster fails identically on macOS at fork HEAD (deterministic stale tests, not Windows-specific). Upstream fixed all of them test-only in `470f94702e`.

| File (count) | Test | Evidence |
| --- | --- | --- |
| `test/modes/utils/render-initial-messages.test.ts` (16) | all 16 | `TypeError: sessionManager.getConversationTip is not a function` — mocks at :88-101 and :200-215 lack it; source calls it at `src/modes/utils/ui-helpers.ts:970`. macOS run: 16 fail with the exact stack |
| `test/repro-issue-1955-sendmessage-double-render.test.ts` (4) | all 4 | same TypeError; harness mock at ~:138-141 lacks `getConversationTip`. macOS: 4 fail |
| `test/repro-issue-6879-tool-double-render-retry.test.ts` (2) | both `re-keys a streamed tool card…` | `countCommand` (:54-63) counts `$ ${CMD}` text, but streamed cards now draw the command through the shell visualization; upstream rewrote it to count cards. macOS: 2 fail |
| `test/issue-4348-repro.test.ts` (1) | cursor exec-channel rebuild | same TypeError; `makeRenderCtx` mock at ~:80-83. macOS: fail |
| `test/modes/controllers/event-controller-loader-recovery.test.ts` (1) | auto-retry countdown on spinner ticks | spinner ticks land on the shared wall-clock 80 ms grid; upstream added `setSystemTime(1_000_000)` (+ reset in afterEach). macOS: fail |
| `test/modes/controllers/input-controller-tool-expansion.test.ts` (1) | expands children, full repaint | production now reads `ctx.pendingShellContainer.children`; test ctx mock lacks it — `TypeError: undefined is not an object (evaluating 'this.ctx.pendingShellContainer.children')`. macOS: fail |
| `test/agent-session-interrupt-queued-messages.test.ts` (1) | records extension message exactly once | abort now lands before the second model call; `expect(mock.calls).toHaveLength(2)` → 1. macOS: fail |
| `test/advisor-tool-call-loop-guard.test.ts` (1) | redirects advisor's repeated tool call | abort is checked before the next request; `toHaveLength(7)` → 6. macOS: fail |
| `test/rpc-goal.test.ts` (1) | extension session change aborts detached run | `error: Client stopped` — race: test waits for `agent_start`, upstream switched to `message_end` (user) before abort. macOS: fail |

**Decision:** fix test. **Proposed task A1 — port `470f94702e` (test-only):**
- Files: the 9 test files above (`git show 470f94702e` lists them; `test/fixtures/goal-rpc-agent.ts` also changes).
- Failing evidence: macOS run of the 9 files at fork HEAD fails 28 tests with the signatures above.
- Change: cherry-pick `470f94702e` (or apply its test-side diff); drop hunks for files not failing here only if they conflict.
- Verification: `bun test` the 9 files from `packages/coding-agent` (28 fail → 0), plus the two extra files the commit touches that already pass (`thread/subagent-spawn-signal`, `usage-row-placement`) stay green.

## Cluster B — upstream test fixes, other commits (16 tests, 4 files)

| File (count) | Commit | Evidence | Notes |
| --- | --- | --- | --- |
| `test/cli-responses-websocket-recovery.test.ts` (13) | `19ef041ec5` (test-only) | all 13 fail with `expect(received).toHaveLength(expected)` / `Missing expected real CLI event`; first-event deadline 0.2 s expires during the WS handshake under 16-way load (upstream comment in the fix) | macOS: 13/13 pass. Load-dependent thresholds, not Windows logic; upstream raised `first` to 1 s |
| `test/cost-gate-skill-description.test.ts` (1) | `463d44a950` (test-only) | `meters completed background skill compression against the session tree` times out at 5000 ms. **Reproduced on macOS**: `PI_TEST_RUNTIME=1 bun test` → fail (timeout); without → pass. The fork runner sets `PI_TEST_RUNTIME: "1"` on every child (`scripts/ci-test-ts.ts:454`), so it is deterministic under the runner | Fix: `.env({ ...process.env, PI_TEST_RUNTIME: undefined })` on the child + fixture guard `if (isBunTestRuntime()) throw` |
| `test/tools/browser-cmux-release-mid-run.test.ts` (1) | `adf978c1b6` (test-only) | **Reproduced on macOS** with the exact Windows signature: expected `by 0.98 to get viewport CSS pixels`, received `multiply x by 0.98 and y by 1.00 to map to viewport CSS pixels` (test :590-595) | Fix: adopt the upstream assertion text ("multiply x by 0.98") |
| `test/thread/focus-view.test.ts` (1) | `d488335771` (source + test) | Windows first error `?` (no signature captured). macOS: 8/8 pass at fork HEAD. `d488335771` is a source+test refactor (session-mirror deltas, MCP tool versions, pi-shell `mem.rs`) — it does not fix the named test (`cycles the thinking level…` exists in both fork and upstream); `4ce16b953f` is a further source+test follow-up | No clean port; needs Windows isolation re-run (see E2) |

**Decision:** fix test for the three test-only rows.
**Proposed task B1 — port `19ef041ec5` websocket-recovery hunk** (files: `test/cli-responses-websocket-recovery.test.ts` ~:590; evidence: 13 failures under 16-way load on Windows, macOS green; change: first-event timeout 0.2 s → 1 s with upstream's comment; verification: file passes twice under `OMP_TEST_CONCURRENCY=16` full-suite runs).
**Proposed task B2 — port `463d44a950` cost-gate env isolation** (files: `test/cost-gate-skill-description.test.ts` + `test/fixtures/cost-gate-skill-description.ts`; evidence: macOS repro with `PI_TEST_RUNTIME=1`; verification: `PI_TEST_RUNTIME=1 bun test test/cost-gate-skill-description.test.ts` green, and green inside a full runner pass).
**Proposed task B3 — port `adf978c1b6` cmux assertion fix** (files: `test/tools/browser-cmux-release-mid-run.test.ts` :551-595; evidence: macOS repro with identical diff; verification: file green on macOS; the remaining hunks of `adf978c1b6` (gracefulKillTreeOnce teardown in browser-attach etc.) are Task 7 territory).

## Cluster B2 — fork-side prompt-template regression (2 tests, 1 file)

`test/system-prompt-inventory.test.ts` (2): `does not construct descriptor records for a compact native inventory`, `projects compact metadata in active order without reading descriptors or inactive tools`.

- Data-file attribution was `c28b3e3e42`/`4e25949931`, but those commits fix *different* tests in the file (delegation-bias expectations and the `⁂` marker slice). **Verified on macOS**: both tests fail at fork HEAD with `expect(received).toBe(expected)`: rendered inventory contains a spurious blank line between entries (`- Edit: \`apply_patch\`\n \n- Read: \`read\``).
- Root cause: fork commit `31b752b304` (feat(prompts): bake peer-network awareness…) rewrote `src/prompts/system/system-prompt.md` and introduced blank lines inside the `{{#each toolInfo}}` inventory block (base shape at `96e4d8eb5b` has none). Verified: checking out the template from `31b752b304~1` makes all 37 tests in the file pass.
- Upstream's template (base and current `upstream/main`) has no blank lines in that region; the fork's `{{#each}}`/indentation change alone produces them.

**Decision:** fix source template (test is correct).
**Proposed task B4:** files: `packages/coding-agent/src/prompts/system/system-prompt.md` (Tool Inventory block, ~:82-94); evidence: the two failing tests above on any platform (fails on macOS too); change: restore the base template shape for the `toolInfo` each-block (no blank line between `- {{label}}: \`{{name}}\`` entries, closing `{{/each}}`/`{{else}}` at column 0 like `96e4d8eb5b`), keeping the fork's peer-network additions elsewhere in the file; verification: `bun test test/system-prompt-inventory.test.ts` → 37 pass, and prompt snapshots (`test/system-prompt-template.test.ts`, `test/sdk-system-prompt-template.test.ts` if present) stay green.

## Cluster C — Windows path assumptions (12 tests, 2 files)

| File (count) | Evidence |
| --- | --- |
| `test/bash-failure-result.test.ts` (11) | all 11 fail `error: Failed to set cwd: /tmp is not an absolute path` — `makeSession()` sets `cwd: "/tmp"` (test :19); pi-shell's cwd validation (`crates/pi-shell/src/shell.rs:115-125`) requires a platform-absolute path, and `/tmp` is not absolute on win32. The rest of the same file already uses `os.tmpdir()` (:266, :328, :377, :414) |
| `test/bash-autobg-timer.test.ts` (1) | `does not keep the event loop alive…` fails `expect(received).toBe(expected)` — probe fixture `test/fixtures/bash-autobg-exit-probe.ts:23` sets `session.cwd = "/tmp"`; the child's BashTool fails the same cwd validation, so output/exit differ from `{ done: true, output: "hi" }` |

**Decision:** fix test (both are test-harness POSIX assumptions; production code correctly rejects the path).
**Proposed task C1:** files: `test/bash-failure-result.test.ts` :19, `test/fixtures/bash-autobg-exit-probe.ts` :23; failing evidence: the 11+1 Windows failures above (macOS passes both files — `/tmp` is absolute on POSIX); change: replace `"/tmp"` with `os.tmpdir()` (matches the existing pattern at bash-failure-result.test.ts:266); verification: both files green on macOS, and on Windows once host access exists (`bun test test/bash-failure-result.test.ts test/bash-autobg-timer.test.ts`).

## Cluster D — environment/browser (10 tests, 1 file)

`test/tools/browser-webmcp.test.ts` (10): every test fails `net::ERR_CONNECTION_REFUSED at http://localhost:<port>/…` — the local `Bun.serve({ hostname: "localhost", port: 0 })` pages (`servePage`, test :80-87; the OOPIF cases bind `127.0.0.1` at :241-243) are unreachable from the browser's page navigation.

- The suite is already `describe.skipIf(!CHROMIUM_AVAILABLE)`; on win32 the probe (`test/tools/chromium-probe.ts:21-36`) only stats the resolved executable (no live CDP check), so Chromium *launches* but page navigations to `http://localhost:<port>` are refused.
- Primary hypothesis (needs a Windows host to confirm): `localhost` resolves differently for Bun (listener) and Chrome (dialer) across the IPv4/IPv6 stacks on Windows — one side binds/duels only `::1` or only `127.0.0.1`, so the connection is refused. Secondary: the acquired system Chrome (`systemChromiumCandidates()` win32 branch resolves `chrome.exe`/`msedge.exe`) behaves differently from Chrome-for-Testing.
- No upstream commit touches this file since the base (verified `git log 96e4d8eb5b..upstream/main -- …browser-webmcp.test.ts` → empty).

**Decision:** investigate (needs Windows host). **Proposed task D1 (pending host access):** files: `test/tools/browser-webmcp.test.ts` (:80-87 `servePage`, and every `http://localhost:${…}` URL); failing evidence: the 10 Windows failures; change: bind `servePage` explicitly to `127.0.0.1` and navigate to the literal `http://127.0.0.1:${port}/` (mirroring the existing OOPIF iframe pattern), OR if the refusal is in the acquired-browser path, gate on a live launch probe like the Linux branch; verification: file green in a Windows isolation run, and confirm no behavior change on macOS/Linux (localhost vs 127.0.0.1 are same-site for these tests' secure-context requirements — verify the same-site iframe case still holds).

## Cluster E — ambient environment leakage (5 tests, 1 file)

`test/sdk-mcp-instructions.test.ts` (5): all five `createAgentSession MCP server instructions (deferred UI)` tests fail on `expect(received).toContain/toHaveLength(expected)` — per the data file's prose, the received prompt contains the host's own system-prompt lines, i.e. ambient content leaked into the rendered prompt on the Windows host.

- The suite isolates `agentDir` + spies `os.homedir` to a temp home (test :81-98), uses `cwd: tempDir`, `contextFiles: []`, `disableExtensionDiscovery: true` — yet ambient lines still reached the prompt on that host, the same reachability class as F-3 (poison fixture walking from a reachable home/config into discovery).
- macOS: 13/13 pass. No upstream commit touches the file since base.

**Decision:** fix isolation (same pattern as F-3).
**Proposed task E1:** files: `test/sdk-mcp-instructions.test.ts` (beforeAll :81-98; per-test `createAgentSession` options); failing evidence: the 5 Windows failures with leaked host prompt lines; change: identify the leaking source on the Windows host (candidate: a context file such as `AGENTS.md`/`CLAUDE.md` discovered by walking up from a reachable path, or the real user config the isolated home fails to shadow on win32 — e.g. `APPDATA`-resolved roots), then either isolate it like the F-3 fixture or assert-and-skip the unreachable case with a reason string; verification: 13/13 green on Windows isolation re-run and on macOS, and a control that proves the poisoned source would be found without isolation (F-3 Step 2 pattern).

## Cluster E2 — unverified on Windows; pending isolation re-run (4 tests, 2 files)

| File (count) | macOS at fork HEAD | Hypotheses (to confirm on Windows) |
| --- | --- | --- |
| `test/skills.test.ts` (3) — all in `collision handling` | 64/64 pass (collision block: 17/17) | (a) CRLF checkout: collision collapse compares raw bodies byte-for-byte (`src/extensibility/skills.ts:173-175` `e.body === candidateBody`); if the Windows checkout converted fixture SKILL.md bodies to CRLF, identical-body skills stop collapsing. `.gitattributes` forces `* text=auto eol=lf`, so check `git ls-files --eol` on the Windows clone. (b) ambient plugin leakage past the isolated home (:51-81) despite DISABLE_ALL_BUILTIN_SKILLS. Ambient-leak evidence is weak — the file isolates thoroughly — so the preliminary "F-3 pattern" label is NOT confirmed for this file |
| `test/usage-cli.test.ts` (1) — `names the stored credential of each same-email Codex workspace` | 111/111 pass (also under `TZ=Asia/Tokyo`) | Both `Settings.loadReadOnly` and `discoverAuthStorage` are mocked in the failing test (test :2448-2449); the line-offset assertion (`lines[entry + 2]`, test :2467) suggests a Windows-only extra/missing output line (e.g. locale-formatted expiry at `src/cli/usage-cli.ts:802`, or terminal-width wrap). Needs the actual received/expected diff from a Windows run |

**Decision:** pending — one Windows isolation re-run per file (not load-related; both files are singletons in the suite). Record the received/expected diff, then classify as fix-test (platform-normalized fixture/expectation) or fix-isolation. No upstream commit touches either file since base (verified).

## Cluster F — load-flaky (4 tests, covered by Task 7)

`test/cli-provider-model-deferral.test.ts` (60 s subprocess cold-start under 16-way load), `test/settings-live-routing.test.ts` (EPERM on `rename`), `test/tools/browser-attach.test.ts` (`?` — EBUSY profile-dir removal), `test/tools/browser-storage-state.test.ts` (wall-clock budget). All four are Task 7 (INF-3) files and are **already addressed** by commit `6ac3ba7d69` ("test: make four load-sensitive tests deterministic") at fork HEAD. No new classification work; do not double-fix. Note: `browser-attach` also carries upstream test-side teardown robustness (`adf978c1b6`/`d45677f999`) — fold any residual Windows teardown failures into Task 7's verification rather than a new task.

## Windows isolation re-run — pending host access

Step 1's "re-run every non-INF-3 failing file once in isolation on Windows" could not be executed: **no Windows host is available to this workspace** (controller ruling, ledgered). Classification above therefore rests on (a) the committed data file (authoritative per plan) and (b) upstream git history + macOS fork-HEAD re-runs, which deterministically reproduce clusters A, B2, B (cost-gate, cmux) and clear C on POSIX. When Windows host access is granted, run once per non-INF-3 file:

```
cd packages/coding-agent && bun test test/<file>   # single file, no OMP_TEST_CONCURRENCY
```

priorities: `browser-webmcp` (confirm D1 hypothesis), `skills`, `usage-cli`, `thread/focus-view`, `sdk-mcp-instructions` (capture the leaked prompt lines), then spot-check one file each from clusters A/B/C to confirm the ports took effect.

---

# Windows pi-shell baseline classification (2026-11-09)

Classification of the 59 failing `cargo test -p pi-shell` tests from
[2026-11-09-windows-baseline-data.md](2026-11-09-windows-baseline-data.md) (Group C, Task 9 / C-2).
Same references as the coding-agent section: fork HEAD `2e66ccf73e`, upstream
`refs/remotes/upstream/main` at `f0200abf28`, fork base `96e4d8eb5b`
(verified: it is HEAD and upstream/main's merge base). Every failing test
was re-run on the controller's macOS host at fork HEAD
(`cargo test -p pi-shell --lib -- <filter>`); 17 of the 59 fail identically
on macOS (test bugs at fork HEAD on every platform), the other 42 pass.

## Method

All 97 upstream commits in `96e4d8eb5b..upstream/main -- crates/pi-shell`
were mapped to the failing tests via `git log -S <test name>`,
`git log --oneline -- <file>` per failing file, and
`git diff HEAD upstream/main -- <file>`. The `Os { code: 2 }` probe
signatures were traced into the failing tests' own code
(`crates/pi-shell/src/shell/tests/builtins.rs`: `type.txt`/`help.txt`/
`err.txt`/`out.txt` are `.expect()` reads of files the test shell writes
under `cd <temp> && … > file`). Two decisive findings:

1. **The fork's test files carry corrupted string literals.** Upstream
   `5d770d6b17` (style pass, in `96e4d8eb5b..upstream/main`) let rustfmt's
   `format_strings` re-wrap `\n`/`\x1b` escapes into
   `\<newline><indent>n`, changing literal values; upstream fixed the
   fallout in `4f15085863` ("restored string literals that rustfmt split
   mid-escape" — "26 pi-shell tests failed"). `4f15085863` is in the range
   but **not** in the fork, and `git diff HEAD upstream/main` on each
   affected file shows the fork still has the corrupted spellings. macOS
   re-runs reproduce the Windows failures byte-for-byte, with the
   corruption on the `right:` (expected) side.
2. **Upstream `251a2fab8e`** ("bump version to 18.17.0", 2026-11-06; in the
   range, not in the fork) gated libc-dependent zsh module tests to macOS-only
   with `ignore` reasons after the same tests failed on Linux CI ("their
   premise does not hold on glibc/ncurses"); it also guards a null-locale
   `freelocale` segfault in `sys/langinfo.rs` and adds an early return to
   `expandmb_sorting_follows_lc_collate` when `en_US.UTF-8` is not installed.

## Cluster summary

| Cluster | Tests | macOS | Decision |
| --- | --- | --- | --- |
| S1. Corrupted test-string literals — upstream `4f15085863` | 17 | FAIL | fix test: port `4f15085863` (W2) |
| S2. Expected output is macOS libc's — upstream `251a2fab8e` gates | 16 | PASS | fix test: port the ignore gates (W2) |
| S3. `cd` into the Windows temp dir fails → probe-output reads NotFound — omp-zsh series | 16 | PASS | port upstream series (W1) |
| S4. env_cwd short-TEMP expansion (same logical-cd root) | 2 | n/a (cfg(windows)) | port upstream (W1) |
| S5. Windows-platform engine semantics, no single upstream fix | 6 | PASS | fix locally after W1/W2 (W3) |
| S6. Encoding / collation misc (2 core; 5 provisional rows counted in S3) | 2 | PASS | local test fixes (W2/W3) |
| **Total** | **59** | 17 FAIL / 42 PASS | |

## Cluster S1 — corrupted test-string literals (17 tests, 9 files)

Pure test bugs, fail identically on macOS (verified by running each).
Representative macOS evidence: `report_lists_callers_and_callees` expected
side contains `\\\n\t\t\t n 2)` where the actual output has `\n\n 2)`;
`region_highlight_entries…` expected side contains
`x1b[39m\\\n\t\t x1b[4mcd` — a `\x1b` split mid-escape by the rustfmt
continuation; `zsh_mod_zprof_counts_calls_of_one_function` expected
`\n\\\n\t\t\t n 1)` vs actual `\n\n 1)`.

| Test | File |
| --- | --- |
| `bash::vm::builtins::zsh_mod_zprof::tests::report_lists_callers_and_callees` | `src/bash/vm/builtins/zsh_mod_zprof.rs` |
| `bash::vm::zle::refresh::tests::region_highlight_entries_and_trashed_display` | `src/bash/vm/zle/refresh/tests.rs` |
| `testkit::suites::zsh_mod_datetime::strftime_reverse` | `src/testkit/suites/zsh_mod_datetime.rs` |
| `testkit::suites::zsh_mod_datetime::langinfo_in_the_c_locale` | same |
| `testkit::suites::zsh_mod_example::zsh_mod_example_builtin_shows_and_sets_its_parameters` | `src/testkit/suites/zsh_mod_example.rs` |
| `testkit::suites::zsh_mod_files::zsh_mod_files_mv_ln_chmod` | `src/testkit/suites/zsh_mod_files.rs` |
| `testkit::suites::zsh_mod_terminfo::echoti_xterm_values` | `src/testkit/suites/zsh_mod_terminfo.rs` |
| `testkit::suites::zsh_mod_zmodload::builtins_autoload_their_module` | `src/testkit/suites/zsh_mod_zmodload.rs` |
| `testkit::suites::zsh_mod_zmodload::module_param_blocked_by_existing_param` | same |
| `testkit::suites::zsh_mod_zmodload::typeset_h_on_module_special` | same |
| `testkit::suites::zsh_parity::funcs_commands_lists_every_entry_of_path` | `src/testkit/suites/zsh_parity.rs` |
| `testkit::suites::zsh_prompt_names::attributes_for_dumb` | `src/testkit/suites/zsh_prompt_names.rs` |
| `testkit::suites::zsh_prompt_names::attributes_for_xterm_256color` | same |
| `testkit::suites::zsh_prompt_names::bookmarks_file_registers_named_directories` | same |
| `testkit::suites::zsh_mod_zprof::zsh_mod_zprof_counts_calls_of_one_function` | `src/testkit/suites/zsh_mod_zprof.rs` |
| `testkit::suites::zsh_mod_zprof::zsh_mod_zprof_lists_callers_and_callees` | same |
| `testkit::suites::zsh_mod_zprof::zsh_mod_zprof_names_anonymous_functions_by_file_and_line` | same |

Note: this is the same failure family as the fork's own 19-test macOS host
baseline (Task 1/2 full-suite runs) — 17 of those 19 are these S1 tests; the
other 2 (`git::tests::unsupported_invocations_run_the_git_binary`,
`shell::tests::process_control::ps_builtin_supports_extended_format_specifiers`)
are macOS-host issues outside the Windows set. `4f15085863` also restores
the same corruption in `tests/zsh_comp_y01/02/03.rs`, the pi-natives mermaid
parser and the jvm minimizer filter tests (outside the 59; the hunks ride
along in the cherry-pick).

**Decision:** fix test — cherry-pick `4f15085863` (test/literal-only).
Task W2. On macOS this alone should drop the host baseline 19 → 2.

## Cluster S2 — expected output is macOS libc's (15 tests, 4 files)

Upstream `251a2fab8e` gated these tests with
`#[cfg_attr(not(target_os = "macos"), ignore = "…")]` after they failed on
Linux CI; Windows (UCRT, no `/usr/share/terminfo` database) is a third libc
answer, so they fail there for the same reason. The Windows signatures match
the Linux ones upstream recorded: UCRT `strerror` text ("The operation
completed successfully.", "The system cannot write to the specified device.",
"The storage control block address is invalid."), terminfo database contents,
`%x` locale formatting, libm last digits. All pass on macOS at fork HEAD
(verified) — no fork regression; the expectations simply assume macOS libc.

| Test | Upstream ignore reason | macOS |
| --- | --- | --- |
| `testkit::suites::zsh_mod_datetime::strftime_options` | "expects macOS `%x` and an installed en_US.UTF-8 locale" | PASS |
| `testkit::suites::zsh_mod_mathfunc::every_function_on_sample_arguments` | "last-digit results are macOS libm's" | PASS |
| `testkit::suites::zsh_mod_system::zsh_mod_system_bad_fds_set_errno` | strerror family | PASS |
| `testkit::suites::zsh_mod_system::zsh_mod_system_pipes_do_not_seek` | strerror family | PASS |
| `testkit::suites::zsh_mod_system::zsh_mod_system_syserror` | "`strerror` text is macOS libc's" | PASS |
| `testkit::suites::zsh_mod_terminfo::another_term_replaces_the_boot_one` | "expects macOS's terminfo database" | PASS |
| `testkit::suites::zsh_mod_terminfo::capability_errors` | "expects macOS's terminfo database" | PASS |
| `testkit::suites::zsh_mod_terminfo::dumb_terminal` | "expects macOS's terminfo database" | PASS |
| `testkit::suites::zsh_mod_terminfo::echotc_xterm_values` | "expects macOS's terminfo database" | PASS |
| `testkit::suites::zsh_mod_terminfo::held_terminal_from_boot_is_set_up_without_tgetent` | "expects macOS's terminfo database" | PASS |
| `testkit::suites::zsh_mod_terminfo::modules_autoload_on_use` | "expects macOS's terminfo database" | PASS |
| `testkit::suites::zsh_mod_terminfo::scans_list_the_held_terminal` | "expects macOS's terminfo database" | PASS |
| `testkit::suites::zsh_mod_terminfo::termcap_module_boots_first` | "expects macOS's terminfo database" | PASS |
| `testkit::suites::zsh_mod_terminfo::terminfo_termcap_elements` | "expects macOS's terminfo database" | PASS |
| `testkit::suites::zsh_mod_terminfo::tgetent_adjusts_the_held_terminal` | "expects macOS's terminfo database" | PASS |
| `testkit::suites::zsh_mod_terminfo::tgetent_moves_obsolete_defaults` | "expects macOS's terminfo database" | PASS |

(S1's `langinfo_in_the_c_locale` and `strftime_reverse` fail on macOS for
the S1 literal; after `4f15085863` restores the literal, `langinfo…` is
also gated off non-macOS by `251a2fab8e`, and `strftime_reverse`'s Windows
behavior is strptime-through-`uselocale` on a platform without that path
[INFERENCE — needs the Windows re-run to confirm it passes after W2].)

Terminfo mechanics: `terminfo_db.rs` searches `/usr/share/terminfo` (const
`SYSTEM_TERMINFO`, `terminfo_db.rs:644`) plus `$TERMINFO`/`$HOME/.terminfo`;
none of those hold macOS's database on Windows, so the expected cap lists
diverge. The fork base also predates upstream's embedded
`src/bash/vm/zsh/terminfo/xterm-256color` entry (`df6fcdf98c`, with
`9e0d6a0588` fixing its Bazel `compile_data`) — W1 adds it.

**Decision:** fix test — port the `251a2fab8e` ignore-gate hunks (plus its
`sys/langinfo.rs` null-locale guard and `zsh_parity.rs` early return). Task W2.

## Cluster S3 — probe-output reads fail: `cd` into the Windows temp dir breaks (16 tests, 1 file)

Signatures: `type.txt: Os { code: 2, kind: NotFound, … }` and the same for
`out.txt`/`help.txt`/`err.txt`/`sponge output`, plus downstream
`assertion left == right` with empty `left: ""` where the assertion reads
files the shell wrote under `cd <temp>`. All pass on macOS (verified: the
dispatch/registration probes and every sort/mkdir/rm/mv/head/rg/fd/jq/sed
test in this family are green at fork HEAD).

Root cause chain — the data file names it directly:
`sort_merge_into_the_file_on_stdin_keeps_all_input` fails with
`bash: line 1: cd: C:\Users\spgs\AppData\Local\Temp\.tmpPzmpUU: The fi[le…]`.
These tests `cd` into a Windows temp directory and the shell's **logical cd
cannot enter it**: the fork's `dir.rs::logical` predates `1fdc73bc5f`
(no `#[cfg(windows)]` `Component::Prefix` branch), so the drive-rooted
path breaks. Once the `cd` fails, the session's relative redirections
(`> type.txt` etc.) write against the unchanged cwd and the tests'
`.expect("type.txt")` read panics with the recorded `Os code 2 NotFound`.
The interleaved `---- shell::tests::env_cwd::inherited_short_temp…` stdout
chunks in these tests' signatures confirm the shared session-level failure.

Upstream coverage (all in `96e4d8eb5b..upstream/main`, none in the fork):

- `1fdc73bc5f` fix(shell): preserve Windows roots during logical cd — adds
  the `#[cfg(windows)]` `Component::Prefix` branch to `logical()` via
  `pi_vfs::normalize_lexically`; exactly this code path.
- `bbf17a4bcc` fix(shell): let a drive-absolute cd target win over a URL cwd.
- `df6fcdf98c` feat(shell): run omp zsh on Windows — Windows paths in `cd`
  (`zsh_dir.rs`), MSYS `/tmp` translation and `/dev/null`→`NUL`
  (`pi-builtins/host.rs` `normalize_shell_path`), `Host::fallback`
  (builtin utilities as PATH stand-ins, asked after the search fails),
  `sys/user.rs`, `sys/fs.rs`.
- `9f8c1ce438` makes the utility fallback Windows-only — on other platforms
  a missing tool stays missing, preserving the `PATH=` probe semantics.

Tests (16): `cmp_is_registered_as_an_in_process_builtin`,
`command_v_iterates_all_operands`,
`every_process_builtin_is_installed_and_dispatches`,
`every_utility_builtin_is_registered_under_its_own_name`,
`moreutils_builtins_are_registered_in_process`,
`sort_merge_into_the_file_on_stdin_keeps_all_input`,
`uutils_head_help_and_bad_flag_do_not_exit_process`,
`uutils_mkdir_help_and_bad_flag_do_not_exit_process`,
`uutils_rm_missing_file_prints_single_diagnostic`,
`fd_builtin_uses_fd_defaults`, `rg_builtin_uses_ripgrep_defaults`,
`rg_builtin_defaults_to_cwd_unless_stdin_is_pipeline`,
`uutils_mkdir_resolves_cwd_and_displays_operand`,
`uutils_rm_and_mv_operate_on_shell_cwd`,
`uutils_head_streams_stdin_and_reads_files`,
`grep_quiet_and_line_regexp`.

**Decision:** port the upstream series as one task — W1. Not piecemeal: the
fixes interlock (`logical` cd roots + MSYS path normalization + the fallback
trait threaded through `bash/host.rs`, `process/host.rs`, `pi-builtins`,
`testkit/host.rs`).

## Cluster S4 — env_cwd short-TEMP expansion (2 tests)

`inherited_short_temp_matches_pwd_after_cd` and
`session_env_short_temp_matches_pwd_after_cd` (both `#[cfg(windows)]` — they
do not compile on macOS; cross-checked the cfg markers in
`shell/tests/env_cwd.rs:71,92`). Windows failure `left: 1` is the `cd` exit
code: same logical-cd root as S3. The fixture (`short_temp_fixture`,
`shell/tests/mod.rs:172`) hands the session the 8.3 short spelling and
asserts `cd "$TEMP"` lands on the `expand_to_long_path` long form with
`PWD`/`TEMP`/`TMP`/`TMPDIR` all agreeing; the pre-`1fdc73bc5f` logical cd
cannot hold Windows drive roots, so `PWD` never matches.

**Decision:** port upstream (W1). If the series is ever split,
`1fdc73bc5f` + `bbf17a4bcc` are the minimal standalone prefix (both touch
only `dir.rs` + tests + changelog) and could land first.

## Cluster S5 — Windows-platform engine semantics (6 tests, 4 files)

These testkit suites run the engine at `Platform::current()`
(`bash/engine.rs:58` default) against a POSIX-shaped `MemFs`; on a Windows
build the engine's platform-dependent behavior diverges from the
macOS-recorded expectations. All pass on macOS at fork HEAD (verified) —
no fork regression; the expectations encode POSIX answers. Upstream's
answer to exactly this problem is the `windows_platform.rs` suite
`df6fcdf98c` adds: run the zsh dialect on
`EngineConfig { platform: Platform::Windows }` **on any host** — platform
behavior is engine-config, not build-target.

| Test | File | Signature | macOS |
| --- | --- | --- | --- |
| `testkit::suites::zsh_mod_files::zsh_mod_files_mkdir` | `zsh_mod_files.rs` | mode strings `040700`… (mkdir `-m` mode bits + `zstat` display on Windows) | PASS |
| `testkit::suites::zsh_mod_files::zsh_mod_files_mv_ln_chmod` | same | — | FAIL (counted S1: corrupted literal) |
| `testkit::suites::zsh_mod_zprof` (3 tests) | `zsh_mod_zprof.rs` | — | FAIL (counted S1) |
| `testkit::suites::zsh_parity::expandmb_sorting_follows_lc_collate` | `zsh_parity.rs` | — | PASS (counted S6) |
| `shell::tests::process_control::ps_builtin_lists_one_line_per_thread_with_m` | `process_control.rs` | `%CPU: "?"` (Windows `ps` engine semantics; not the macOS-host-baseline `ps_builtin_supports_extended_format_specifiers` sibling) [INFERENCE — pending Windows re-run] | n/a (this test not in the macOS 59 run) |
S5's own membership after S1/S2/S3 are peeled away is: `zsh_mod_files_mkdir`,
`ps_builtin_lists_one_line_per_thread_with_m`, plus the four ""-signature
utility tests (`uutils_filters_listing_find_grep`,
`uutils_find_display_and_actions_split_paths`,
`uutils_jq_filters_json_and_propagates_exit_status`,
`uutils_sed_substitutes_streams_and_edits_in_place`) — all macOS-green,
all likely the S3 cd root [INFERENCE — a Windows re-run after W1 splits
"same root, already fixed" from "separate Windows expectation bug"], leaving
`zsh_mod_files_mkdir` as the clearest engine-semantics member (mode-bit
rendering on a platform without POSIX mode bits).

**Decision:** fix locally (W3) after W1/W2 land, using upstream's
`windows_platform.rs` engine-config pattern as the template: port the
expectation to a `Platform::Windows` engine-config test (runs on any host)
or add `#[cfg_attr(windows, ignore = "…")]` gates with reasons where the
premise is POSIX-only (the `251a2fab8e` pattern). No single upstream commit
fixes these wholesale; do not chase them before the ports land.

## Cluster S6 — encoding / collation misc (2 core members; 5 more provisionally held)

Core membership is disjoint from S3/S5: the two encoding/collation tests
below. The three following rows are provisional members kept here for
traceability only — their counts live in S3 (the 4 `uutils_*` tests) and
S3 (`grep_quiet`), so the 59 partitions exactly once.

| Test | Root cause | Decision |
| --- | --- | --- |
| `output_decode::tests::incomplete_utf8_at_eof_becomes_replacement` | Windows ACP fallback: `OutputDecoder::new()` uses `GetACP()` (`output_decode.rs:59`); on a host whose ANSI page is not 65001 the incomplete UTF-8 lead `0xe4` at EOF re-decodes as ACP — `д` is CP1251's decoding of `0xe4` — instead of U+FFFD (`drain_utf8`'s EOF branch calls `drain_acp`, `output_decode.rs:158-163`). Code is correct (documented one-encoding-per-command fallback); the test must not inherit the host ACP | fix test locally (W3): build the decoder with `OutputDecoder::utf8()` (exists, `output_decode.rs:66`) or `with_fallback_codepage(CP_UTF8)`; one-line change |
| `testkit::suites::zsh_parity::expandmb_sorting_follows_lc_collate` | UCRT has no en_US.UTF-8 collation → `Collator` byte-compares (Windows falls to the stub `mod native` at `sys/langinfo.rs:344-346`); expected order is en_US's | fix test (W2): port `251a2fab8e`'s early-return guard (`Collator::new(b"en_US.UTF-8").is_none() → return`) |
| `grep_quiet_and_line_regexp` (provisional, counted in S3) | `-q match must exit 0`, left "" — [INFERENCE: likely the S3 cd root (fixture under temp); needs Windows re-run] | W1 then W3 (moves to core S6 only if it survives W1) |
| the 4 `uutils_*` ""-signature tests (provisional, counted in S3) | same family as S3 [INFERENCE] | W1 then W3 (moves to core S6 only if they survive W1) |

## Proposed tasks (pi-shell)

**W1 — port the "omp zsh on Windows" series (source + behavior).** Large;
one task, not piecemeal. Commit list (all in `96e4d8eb5b..upstream/main`,
upstream order):

1. `1fdc73bc5f` fix(shell): preserve Windows roots during logical cd
2. `bbf17a4bcc` fix(shell): let a drive-absolute cd target win over a URL cwd
3. `df6fcdf98c` feat(shell): run omp zsh on Windows (core: 44 files, +2897/−392)
4. `d6e00e0122` fix(shell): address review of omp zsh on Windows
5. `9f8c1ce438` fix(shell): Windows-only Ctrl-C ignore and utility fallback; /dev/tty, MSYS signal exits, pipeline job lines
6. `57e28de771` fix(pi-shell): isolate Windows externals from the host console
7. `d99617eb59` fix(pi-shell): cover console usability and INT on Windows externals
8. `b6dd5a8da3` fix(pi-shell): close an owned job's pseudoconsole when its last process exits
9. `9e0d6a0588` fix(build): give bazel pi-shell's Windows console terminfo entry (BUILD.bazel only)

Expected effect: S3 (16) + S4 (2) + the S3-family members of S5/S6 (up to
5) ≈ 18-23 of the 59. Verification: `cargo test -p pi-shell` on macOS (no
regression — the Windows code is `#[cfg(windows)]` or engine-config
platform code), `cargo check -p pi-shell --target aarch64-pc-windows-msvc`,
and a Windows re-run when host access is granted.

**W2 — port the test-only fixes.** Cherry-pick `4f15085863` (restore split
string literals; the 17 S1 tests + comp_y*/jvm/mermaid ride-alongs) and the
`251a2fab8e` test hunks (macOS-only ignore gates for the 16 S2 tests;
`expandmb` early return) + its `sys/langinfo.rs` null-locale guard.
Expected effect on Windows: S1 (17) + S2 (16) + `expandmb` (1) = 34 of the
59. Bonus: on macOS the fork's own 19-test host baseline drops to the 2
git/ps host failures.

**W3 — local Windows-expectation fixes (S5 remainder + S6 encoding),
after W1/W2 land.** Re-run the remaining red set on Windows (pending host
access — same blocker as the coding-agent section). Then per test: port to
the `windows_platform.rs` `Platform::Windows` engine-config pattern or gate
with `#[cfg_attr(windows, ignore = "…")]`; fix
`incomplete_utf8_at_eof_becomes_replacement` with `OutputDecoder::utf8()`.
Expected effect: the last ~5-7 tests (`zsh_mod_files_mkdir` +
`ps_builtin_lists_one_line_per_thread_with_m` + whatever of the
""-signature family survives W1 + `incomplete_utf8…`).

Tally check: W2 34 + W1 ≈ 18-23 + W3 ≈ 5-7 → 59 (W1/W3 boundary is settled
by the Windows re-run after each wave lands; the 59 partitions exactly once
across S1-S6 — S2 is 16, S5 is 6, and S6 core is 2, with the provisional
`uutils_*`/`grep_quiet` rows counted in S3).

## Windows isolation re-run — pending host access (pi-shell)

Same controller ruling as the coding-agent section: no Windows host is
available, so classification rests on the committed data file (authoritative)
+ upstream history + macOS re-runs. When access is granted, run the still-red
set per cluster to confirm the split and resolve the [INFERENCE] markers:
the ""-signature family split (S3/S5), `grep_quiet_and_line_regexp`'s root
cause (S6), `strftime_reverse`'s post-W2 Windows behavior (S2), and
`zsh_mod_files_mkdir`'s exact mode-string diff (S5).

## C-3: pi-shell Clippy on Windows (865 errors, 80 lints)

**Question 1 — does upstream run Clippy for Windows? No.** The only Clippy execution on `upstream/main` is `.github/workflows/ci.yml` job `rust_validate` (upstream lines 244–265; `if: github.event_name != 'pull_request'`, `runs-on: vmon-large/from=omp-ci`, a Linux runner pool): three bazelisk `--config=clippy-strict`/`clippy`/`clippy-ported` builds over `//crates/...` rust_library targets. The only Windows runners in upstream CI (release job, lines 892–893: `windows-2025`, `windows-11-arm`) build and smoke the release binary only. Windows clippy errors reach upstream only through contributor-run fixes (e.g. `3d6344d5ba`, `63fe0eae7a`), never a CI gate.

**Question 2 — which errors are Windows-only? Overwhelmingly none.** Sampling the top-error files (top 10 files ≈ 35% of all 865 errors): `zle/comp/complist/print.rs` (47), `zle/comp/compmatch/join.rs` (39), `zle/comp/compmatch.rs` (35), `zle/comp/compctl/generate.rs` (33), `zle/comp/compresult.rs` (33) + `list.rs` (26), `builtins/zsh_mod_datetime.rs` (24), `zle/comp/complete.rs` (21), `builtins/zsh_mod_zprof.rs` (20), `zle/exec.rs` (20) — **zero `cfg(windows)` occurrences in any of them; all are the platform-independent zle completion engine and zsh module builtins.** Only 16 files in all of `crates/pi-shell/src` contain `cfg(windows)`, and none of those are top-error files. The genuine Windows-only regions are small and already fixed upstream: `sys/langinfo.rs`'s non-apple/non-linux `mod native` stub (8 errors; `missing_const_for_fn`) and `sys/pump/os.rs`'s named-pipe `mod imp` — both addressed by `3d6344d5ba` via targeted `#[expect(..., reason)]` attributes. A Linux comparison run was not possible (no Linux host; the classification host is macOS), so the identical command was run on this macOS host as a near-linux proxy: **856 errors with a near-identical lint and file distribution to the Windows 865** (`many_single_char_names` 279 = 279; `missing_const_for_fn` 81 vs 89; `single_match_else` 58 vs 57; top files identical in the same order). The ~9-error delta matches the platform-gated stubs (langinfo apple-native vs Windows stub, pump/os) — the bulk of the Windows errors are platform-independent.

**Question 3 — why doesn't upstream Linux CI report the common-code sites? Because the fork's Windows repro used `-D warnings`, a stricter severity than upstream's CI.** Upstream runs Clippy through the Bazel aspect with `bazel/clippy.bazelrc`'s `--config=clippy-strict`: groups `nursery`/`pedantic`/`perf`/`style`/`all` at **`-W` (warn, non-failing)** and only `correctness`/`suspicious` at `-D`. The bazel build does not fail on warn-level lints. The data-file repro `cargo clippy -p pi-shell --no-deps -- -D warnings` promotes every warn-level lint to an error, which is what produced "865 errors". Every top lint is a nursery/pedantic/style lint (`many_single_char_names` nursery, `missing_const_for_fn` nursery, `single_match_else` pedantic, `useless_let_if_seq` nursery, `map_unwrap_or` pedantic, `doc_markdown` pedantic, ...), and none of them appear individually in the generated bazelrc. The lint *policy* (`Cargo.toml [workspace.lints]`, mirrored into `bazel/clippy.bazelrc` by `scripts/gen-clippy-bazelrc.ts`) is identical between fork and upstream — there is no policy divergence to fix.

**Classification summary (Step 3 decision):**

| Cluster | Evidence | Decision |
|---|---|---|
| Windows-only sites (`sys/langinfo.rs` native stub, `sys/pump/os.rs` named-pipe imp, and the other `3d6344d5ba`/`63fe0eae7a` files incl. `pi-vcs/git/cli.rs`) | 8+ errors in cfg-gated stubs; upstream fixed them 2026-11-07 | Port upstream fixes (cherry-pick `3d6344d5ba`, `63fe0eae7a`); no local invention |
| Common-code style/nursery lints (~840+ of 865) | All top-error files are `cfg(windows)`-free zle/zsh-module code; lints are warn-level in upstream CI; macOS darwin proxy reproduces 856 of them | No code change; re-baseline the Windows gate to upstream severity (`-D clippy::correctness -D clippy::suspicious`) instead of `-D warnings`. No global lint relaxation — `Cargo.toml [workspace.lints]` stays byte-identical to upstream |

**Proposed fix tasks (C-3):**

**P-C3.1 — Port upstream Windows-only Clippy fixes (cherry-pick).** Files: `crates/pi-shell/src/{host.rs, sys/fs_ops.rs, sys/langinfo.rs, sys/lifecycle.rs, sys/pump/os.rs, sys/spawn/mod.rs, sys/uname.rs, vfs.rs, windows.rs}`, `crates/pi-vcs/src/git/cli.rs`. Evidence: upstream commits `3d6344d5ba` (10 files, +46/−7) and `63fe0eae7a` (pump/os.rs, +18/−2), both on `upstream/main` and absent from fork HEAD; data-file langinfo.rs (8 errors) maps to the stub fixed there. Change: `git cherry-pick 3d6344d5ba 63fe0eae7a`. Verification: `cargo clippy -p pi-shell -p pi-vcs --no-deps -- -D clippy::correctness -D clippy::suspicious` clean on macOS; on Windows the langinfo/pump errors disappear. Size: S (two cherry-picks, ~65 lines).

**P-C3.2 — Re-baseline the Windows Clippy gate to upstream strictness.** Files: `docs/plans/2026-11-09-windows-baseline-data.md` (repro-severity note); optional follow-up CI task (out of scope here) adding a Windows clippy job. Evidence: Question 3 — upstream clippy-strict = warn-level groups + deny correctness/suspicious; the 865 count comes from `-D warnings`. Change: document the Windows acceptance criterion as `cargo clippy -p pi-shell --no-deps -- -D clippy::correctness -D clippy::suspicious`; record the resulting count as the true baseline. No `Cargo.toml` lint-level changes. Verification: rerun the corrected command on Windows; expect near-zero residual. Size: S (doc + one Windows run).

## Consolidated proposed fix tasks (C-1 + C-2 + C-3)

Unified list for the repository owner; fix tasks are appended to the plan only after approval.

| ID | Cluster(s) | Task | Size | Source section |
|---|---|---|---|---|
| A1 | C-1 A (28 tests) | Port `470f94702e` (test-only): 9 test files + goal-rpc fixture | M | C-1 Cluster A |
| B1 | C-1 B (13) | Port `19ef041ec5` websocket-recovery hunk (first-event timeout 0.2 s → 1 s) | S | C-1 Cluster B |
| B2 | C-1 B (1) | Port `463d44a950` cost-gate `PI_TEST_RUNTIME` env isolation | S | C-1 Cluster B |
| B3 | C-1 B (1) | Port `adf978c1b6` cmux assertion fix ("multiply x by 0.98") | S | C-1 Cluster B |
| B4 | C-1 B2 (2) | Fix source template `system-prompt.md` `toolInfo` block (restore base shape, fork regression `31b752b304`) | S | C-1 Cluster B2 |
| C1 | C-1 C (12) | Replace `"/tmp"` with `os.tmpdir()` in `test/bash-failure-result.test.ts` :19 and `test/fixtures/bash-autobg-exit-probe.ts` :23 | S | C-1 Cluster C |
| D1 | C-1 D (10) | Pending Windows host: bind `servePage` to `127.0.0.1` / navigate literal IP, or gate on live launch probe | M | C-1 Cluster D |
| E1 | C-1 E (5) | Isolate ambient prompt leakage in `test/sdk-mcp-instructions.test.ts` (F-3 pattern; identify leaking source on Windows) | M | C-1 Cluster E |
| — | C-1 B focus-view (1) | No task yet: pending Windows isolation re-run of `test/thread/focus-view.test.ts` (`d488335771` is source+test and does not fix the named test) | — | C-1 Cluster B |
| — | C-1 E2 (4) | No task yet: pending Windows isolation re-run of `test/skills.test.ts` (3) + `test/usage-cli.test.ts` (1) | — | C-1 Cluster E2 |
| W1 | C-2 S3+S4 (+~5 of S5/S6) | Port the "omp zsh on Windows" series (9 commits listed in the pi-shell section; core `df6fcdf98c` +2897/−392) | L | C-2 Proposed tasks |
| W2 | C-2 S1+S2 (+expandmb) | Port test-only fixes: `4f15085863` (corrupted string literals) + `251a2fab8e` test hunks & langinfo guard | M | C-2 Proposed tasks |
| W3 | C-2 S5/S6 remainder | Local Windows-expectation fixes after W1/W2 + Windows re-run (`Platform::Windows` config / `#[cfg_attr(windows, ignore)]` / `OutputDecoder::utf8()`) | M | C-2 Proposed tasks |
| P-C3.1 | C-3 Windows-only sites | Cherry-pick `3d6344d5ba` + `63fe0eae7a` (Windows-only clippy `#[expect]` fixes) | S | C-3 above |
| P-C3.2 | C-3 severity gap | Re-baseline Windows clippy gate to upstream severity (`-D clippy::correctness -D clippy::suspicious`); fix doc + record true baseline | S | C-3 above |

Cross-cutting: every Windows verification step in this table is blocked on Windows host access (controller ruling, ledgered; see both "Windows isolation re-run" sections). macOS-verifiable steps (A1, B1–B4, C1, W1 regression, W2, P-C3.1) can land and be verified on this host first.

Out-of-dataset note: `rsync::session::tests::local_copy_byte_totals_are_deterministic`
(`crates/pi-builtins/src/rsync/session/tests.rs:351`) is a pre-existing
non-Windows macOS host flake — fails 4–5/5 at the branch base under
16-way parallel cargo test load (8-byte sent-bytes variance), always passes
serially. It is outside both the Windows 59 dataset and INF-3's TS scope;
recorded here so the Task 2 ledger concern is not lost. Candidate for a
dedicated Rust-side determinism fix (beyond this plan's approved scope).

**STOP — presented to the repository owner for approval.** Fix tasks are appended to `docs/plans/2026-11-09-foundation-infra-windows.md` only after explicit approval.
