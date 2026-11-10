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