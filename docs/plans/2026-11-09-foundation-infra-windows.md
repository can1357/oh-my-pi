# Foundation, Test Infrastructure and Windows Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close F-1..F-4 (foundation follow-ups), INF-1..INF-3 (test infrastructure) and classify the historical Windows failures (Group C), producing fix tasks for owner approval.

**Architecture:** Foundation items are local fixes at existing boundaries (eval tool lookup in the task tool, pi-shell `access`/`host_path`, skill-list test fixture, pi-builtins path resolution). Infrastructure changes live in `scripts/ci-test-ts.ts` plus one shared Bun version guard. Group C is investigation only: it ends with a classification document and proposed fix tasks, then stops for approval.

**Tech Stack:** TypeScript/Bun >=1.4.4, `bun:test`, Rust (pi-shell, pi-builtins, pi-vfs; toolchain from `rust-toolchain.toml`), cargo test/clippy.

**Spec:** [2026-11-09-open-issues-design.md](../specs/2026-11-09-open-issues-design.md), sections **Группа A → Foundation**, **Группа B**, **Группа C**, **Общие требования**. Failure data: [2026-11-09-windows-baseline-data.md](2026-11-09-windows-baseline-data.md) (authoritative copy of the gitignored logs). Prior plan: [2026-11-08-foundation-fixes.md](2026-11-08-foundation-fixes.md).

## Global Constraints

The spec's shared requirements, verbatim:

- Bun 1.4.4 (`>=1.4.4`); на этой машине - явный путь к 1.4.4 первым в `PATH`/`Path`.
- Каждое изменение поведения - регресс-тест, падающий до правки и проходящий после.
- `bun check` пакета `coding-agent` зелёный; Rust - `cargo test -p pi-shell` без новых падений.
- Документация (`docs/a2a.md`, `docs/agent-teams.md`, `docs/settings.md`) и `[Unreleased]` в `packages/coding-agent/CHANGELOG.md` обновляются в задаче, которая меняет поведение.

Application:

- Paths are relative to the repository root unless they start with `src/`/`test/` (then `packages/coding-agent/`).
- Before any run: Bun 1.4.4 directory first in both `PATH` and `Path` (Windows), `bun --version` = `1.4.4`. Under Bun 1.3.x `bun check` is not a built-in and recurses into the package `check` script (exit 23); that is the bug INF-2 fixes, not a code failure.
- The agent shell on the reference machine exports `CI=true`, which makes `scripts/ci-test-ts.ts` run sequentially and stop at the first failing chunk (INF-1). Until Task 5 lands, run the full coding-agent suite with `OMP_TEST_CONCURRENCY=16` set.
- Rust: the spec's comparison command is `cargo test -p pi-shell` (that is how the baseline was measured: 2164 pass / 59 fail on Windows). AGENTS.md prefers `bun run test:rs` / `cargo nextest run -p <crate> -E 'test(<name>)'` for focused runs; use nextest for red/green of single tests and `cargo test -p pi-shell` for the before/after comparison. A cargo test run leaves stray files in `crates/pi-shell/` (`err.txt`, `fd.txt`, `help.txt`, `jq.txt`, `out`, `out.txt`, `out_file.txt`, `p.txt`, `qout.txt`, `rg.txt`, `sed.txt`, `sort.txt`, `type.txt`, `z-output.txt`); delete them, never commit them.
- Changelogs: `packages/coding-agent/CHANGELOG.md` and `crates/pi-shell/CHANGELOG.md` (exists since the foundation plan) `[Unreleased]`. pi-builtins/pi-vfs have no changelog; record their changes in the pi-shell changelog entry that motivates them.
- Red/green discipline: failing test first, record failure, implement, record pass; an import/fixture error is not a valid red.
- One commit per task; stage only that task's files.

## Review Focus

1. F-1 cache must never serve stale eval tool descriptors after kernel tools change (define/undefine in an eval cell, kernel restart).
2. F-4 null-device mapping is exact-match on Windows only; `/dev/null/child`, `/dev/nullx`, relative `dev/null` and every Unix path stay unchanged.
3. INF-1 must keep a non-zero exit when any chunk failed, and keep the parallel path's output unchanged.
4. INF-2 version guard must not run the recursive `check` script before failing.
5. Group C: no fix lands without owner approval of the classification.

## Coverage and execution order

| Item | Task | Deliverable |
| --- | --- | --- |
| F-2 | 1 | pi-shell `access(NUL)` unit tests; stderr positive control |
| F-4 | 2 | `cat`/`head`/`ls` on `/dev/null` work on Windows via one shared mapping |
| F-3 | 3 | Poison fixture cleans created parents on partial setup; non-Windows reachability asserted or skipped with reason |
| F-1 | 4 | Eval tool descriptors looked up once per task call / cached with invalidation |
| INF-1 | 5 | Sequential runner runs every chunk and summarizes failures; `CI` documented |
| INF-2 | 6 | `process.execPath` for child `bun`; shared minimum-version guard in runner and `check` |
| INF-3 | 7 | Four load-flaky tests made deterministic or rebucketed |
| C | 8, 9, 10 | Classification of 81 TS / 59 Rust / 865 Clippy failures, proposed fix tasks; STOP for approval |

Order: 1 → 2 (both Rust, same area), 3, 4, 5 → 6 (same file), 7 (needs 5/6 to reproduce under load), then 8–10 (read-only except the classification docs). Per-task review: concurrency for 4 and 7; security for none; the rest at the final whole-branch review.

## Discrepancies and decisions

- **F-2 scope.** The spec says "для `read`/`write` - тесты `/dev/null` и `NUL` (чтение пустое, запись успешна и ничего не создаёт)". The deferred finding it comes from (foundation ledger, Task 1 review) is about pi-shell's `access()` read/write checks on `NUL` (commit `48f1ef1b33`, `crates/pi-shell/src/sys/fs.rs:831-870`), not the coding-agent `read`/`write` tools. `WriteTool` deliberately rejects `/dev/null` (`test/tools/write-special-files.test.ts:114`, "it is a character device"); changing that is out of scope. Decision: F-2 = unit tests for `access` with `Access::READ`, `Access::WRITE`, `Access::EXEC` on Windows `NUL`, plus the stderr positive control.
- **F-4 placement.** `pi-builtins` cannot call pi-shell's `host_path` (pi-shell depends on pi-builtins and pi-vfs; reverse would be a cycle). The "shared mapping" therefore moves to `pi-vfs` (dependency of both). pi-shell `crates/pi-shell/src/vfs.rs:485-496` has a second private `host_path` without the mapping that only decides routing; do not change routing unless Task 2's reproduction proves it is the cause.
- **INF-2 minimum version source.** The root `package.json` has `"packageManager": "bun@1.4.4"`, no `engines`; `packages/coding-agent/package.json` has `"engines": { "bun": ">=1.4.4" }`. Decision: the guard reads the root `packageManager` version as the minimum (spec: "из корневого package.json") and fails with a message naming both the found and required versions and the executable path.
- **INF-1 docs location.** There is no test documentation under `docs/`. Decision: document `CI`/`isCI()` and `OMP_TEST_CONCURRENCY` in `AGENTS.md` → "Testing Guidance" (the rules file that test runners/agents read), one short paragraph.
- **F-1 cache scope.** The spec asks for a session-scoped cache invalidated on tool rebuild. Eval tools are defined inside kernels at any time, so invalidation needs a kernel-side change signal. Task 4 decides by evidence (see its Step 1).

---

### Task 1: F-2 — `access(NUL)` tests and stderr positive control

**Files:** Modify `crates/pi-shell/src/sys/fs.rs` (test module), `crates/pi-shell/src/shell/tests/session.rs` (test `dev_null_redirects_discard_both_streams_and_exists`, ~2378-2395); `crates/pi-shell/CHANGELOG.md` only if behavior changes (it should not).

- [ ] **Step 1: Tests.** In `fs.rs` tests, `#[cfg(windows)]`: `access(b"/dev/null".as_bstr(), Access::READ)` and `Access::WRITE` return `Ok`, `Access::EXEC` returns `PermissionDenied`; also through `NUL` directly if `access` accepts host-style input (check signature at line 831). Add a Unix counterpart asserting `/dev/null` readable/writable via the native path.
- [ ] **Step 2: Positive control.** In `session.rs` next to the existing Windows test, a case running `{ printf y >&2; }` without redirection and asserting the captured stderr equals `y` (and stdout empty), using the same `TestStdio` capture helpers. This proves the existing "nothing on stderr" assertion can fail.
- [ ] **Step 3: Validate the tests catch regressions.** Temporarily revert the `NUL` branch in `access` (do not commit) and confirm the READ/WRITE tests fail; restore. Record both outputs. Temporarily drop `2>/dev/null` from the existing test script and confirm it fails; restore.
- [ ] **Step 4: Run** `cargo nextest run -p pi-shell -E 'test(access) | test(dev_null)'` (or `cargo test -p pi-shell dev_null` / `access_nul`), then `cargo test -p pi-shell` and compare the failing set with the data file (59 known; no new names).
- [ ] **Step 5: Commit** `test(pi-shell): cover Windows NUL access modes and stderr capture`.

### Task 2: F-4 — pi-builtins on `/dev/null` on Windows

**Files:** Modify `crates/pi-vfs/src/` (new small public function, e.g. `pub fn windows_null_device(path: &[u8]) -> bool` in an existing module such as `lib.rs` or a path helper module), `crates/pi-shell/src/sys/fs.rs` (`host_path` ~426-440 uses it), `crates/pi-builtins/src/host.rs` (`ShellPaths::resolve` ~513, `resolve_link` ~529, and the second `resolve` ~787 if it is a separate impl); tests in `crates/pi-shell/src/shell/tests/` (builtin tests, e.g. `builtins.rs` or `session.rs`); `crates/pi-shell/CHANGELOG.md`.

- [ ] **Step 1: Reproduce.** Windows-only shell tests: `cat /dev/null; echo "cat=$?"`, `head -n 1 /dev/null; echo "head=$?"`, `ls /dev/null; echo "ls=$?"` — expected (POSIX semantics): cat/head print nothing and exit 0; `ls /dev/null` prints `/dev/null` and exits 0. Run with nextest; record which fail and the error text (hypothesis: `ShellPaths::resolve` absolutizes `/dev/null` into `C:\dev\null` before the filesystem layer sees the exact bytes).
- [ ] **Step 2: Implement the shared predicate** in pi-vfs (exact byte equality with `/dev/null`, always false off Windows or compiled only under `cfg(windows)` with a Unix stub). Use it in pi-shell `host_path` (replace the inline comparison, behavior identical) and in pi-builtins resolution so that `/dev/null` reaches the fs layer as `NUL` (or unabsolutized, whichever Step 1 shows is needed). `ls` may need `stat` of `NUL` to report a character device; mirror the `access` handling (failed `GetFileAttributes` on `NUL`) at the same boundary.
- [ ] **Step 3: Negative cases:** `/dev/null/child`, `/dev/nullx`, relative `dev/null` unchanged on Windows; on Unix all unchanged (existing `host_path_maps_only_dev_null_to_nul` covers pi-shell; add the predicate's own unit tests in pi-vfs).
- [ ] **Step 4: Run** focused tests, then `cargo test -p pi-shell`, `cargo test -p pi-builtins`, `cargo test -p pi-vfs`; no new failures vs. data file. Clippy for the touched crates must not gain warnings in touched lines (compare `cargo clippy -p pi-builtins --no-deps` before/after counts).
- [ ] **Step 5: Changelog** pi-shell `[Unreleased]` → `Fixed`: builtins `cat`/`head`/`ls` treat `/dev/null` as the null device on Windows.
- [ ] **Step 6: Commit** `fix(pi-builtins): map /dev/null to NUL on Windows through the shared vfs predicate`.

### Task 3: F-3 — poison fixture isolation

**Files:** Modify `packages/coding-agent/test/cli/skill-list.test.ts` (setup `beforeAll` ~88-105, teardown `afterAll` ~106-112, `removeAmbientPoisonOnExit` ~43, assertions ~405-435).

**Context:** The fixture writes two poison skills into the real home (`<home>/.claude/skills/<CLAUDE_POISON>` or `CLAUDE_CONFIG_DIR`, and `<home>/.agents/skills/<AGENTS_POISON>`) to prove discovery is isolated, then removes only the leaf directories.

- [ ] **Step 1: Failing test for partial setup.** Extract setup into a helper that records every directory it creates (only those that did not exist before) and returns a cleanup function; register cleanup before each creation so a throw mid-setup still cleans. Test: simulate failure after the first poison is written (inject a throwing writer into the helper), assert that every directory the helper created no longer exists, and pre-existing parents are untouched. Red: today's inline setup leaves created parents (`.agents/skills`, `.claude/skills`) behind.
- [ ] **Step 2: Reachability.** The isolation assertion (`poisonHits` empty, ~427) is only meaningful if the poison would be found without isolation. Add an explicit precondition: compute whether the test cwd is under the real home (the ancestor walk can reach `<home>/.agents`). If reachable, assert discovery *with* the real home finds the poison (control) and the isolated run does not. If unreachable (typical on Linux/macOS CI where tmp is outside home), mark the `.agents` ancestor case `test.skipIf(!reachable)` with a reason string naming the condition. Do not silently pass.
- [ ] **Step 3: Run** `bun test test/cli/skill-list.test.ts` (from `packages/coding-agent`) twice; then confirm no `omp-foundation-w6-*` directories remain under the real home.
- [ ] **Step 4: Commit** `test(skill-list): clean poison parents on partial setup and assert reachability`.

### Task 4: F-1 — deduplicate eval tool lookups

**Review:** per-task — concurrency

**Files:** Modify `src/task/index.ts` (`#resolveSpawnPreflight` ~1154-1175, `execute` ~1224-1243, `#runSpawn` ~2080-2092), `src/task/eval-tools.ts` (`describeEvalTools`, `queryAllEvalTools` ~49-113); possibly `src/eval/agent-bridge.ts:196`, `src/eval/workpool-bridge.ts:83`; tests next to existing eval-tool task tests (find with `grep -rn describeEvalTools test/`); `CHANGELOG.md` (`Changed`/performance line).

**Context:** One `task` call with eval-defined `tools` currently queries both kernels up to three times per spawn item: preflight (`#resolveSpawnPreflight`), the plan-mode/validation pass in `execute`, and again in `#runSpawn` → `createEvalCustomTools`.

- [ ] **Step 1: Decide the cache scope from code.** Look for a kernel-side signal that eval tool definitions changed (kernel generation id, tool registry revision, an event when `@tool`/`tool(fn)` runs or a kernel resets). Decision rule: if such a signal exists and is cheap to read, cache descriptors per session keyed by `(kernel identity, revision, sorted names)` and invalidate on change. If not, dedupe per `task` call: resolve descriptors once in `execute` and pass them to preflight and `#runSpawn`; do not add a session cache that can serve stale definitions. Record the decision and evidence (file:line) in the commit message.
- [ ] **Step 2: Failing tests.** (a) A `task` call with 3 items using the same eval tool performs exactly one kernel query (spy on the kernel query function, not on wiring). (b) Staleness: after redefining the tool in the kernel between two `task` calls, the second call sees the new description. (c) An undefined tool still yields the existing "Unknown eval tool(s)" error, once.
- [ ] **Step 3: Run red** (focused file), implement, run green; plus `bun test test/task/` and the eval bridge tests that call `describeEvalTools`.
- [ ] **Step 4: Commit** `perf(task): resolve eval tool descriptors once per task call`.

### Task 5: INF-1 — sequential runner completes and summarizes

**Files:** Modify `scripts/ci-test-ts.ts` (sequential loop ~1029-1036, `runTestCommand` throw ~449, `runTestCommandsInParallel` failure summary ~837-860 for reuse); test `scripts/` test file for ci-test-ts if one exists (`glob scripts/*ci-test*`), else add `scripts/ci-test-ts.test.ts` following `scripts/run-rs-task.test.ts`; `AGENTS.md` ("Testing Guidance").

**Context:** `isCI()` (~611) is true when `Bun.env.CI` is set to a truthy value; the reference agent shell exports `CI=true`. Then `pooled` is false unless `OMP_TEST_CONCURRENCY` is set, and the `for … await runTestCommand(...)` loop throws on the first failing chunk, skipping the rest.

- [ ] **Step 1: Failing test.** Make the runner's command execution injectable (or run the script with `--dry-run`-style fake commands if the script supports it; prefer extracting the sequential loop into an exported function that takes a `run(command)` callback). Three fake chunks: ok, fail, ok → assert all three ran, the result lists the failing chunk, and the process exit code is non-zero.
- [ ] **Step 2: Implement:** sequential path collects `ChunkOutcome` failures exactly like the parallel path and prints the same summary block, then exits non-zero. Retry policy per chunk unchanged.
- [ ] **Step 3: Docs.** AGENTS.md Testing Guidance: `CI` set to a truthy value makes the runner sequential (one chunk at a time, all chunks run, summary at the end); `OMP_TEST_CONCURRENCY=<n|all|max>` forces the pool.
- [ ] **Step 4: Run** the new test; `bun scripts/ci-test-ts.ts coding-agent-heavy --dry-run` output unchanged in shape.
- [ ] **Step 5: Commit** `fix(scripts): run every test chunk sequentially under CI and summarize failures`.

### Task 6: INF-2 — one Bun for the whole run

**Files:** Create `scripts/require-bun.ts` (exported `requireBunVersion(): void` + CLI entry); modify `scripts/ci-test-ts.ts` (every `command: ["bun", ...]`, ~215, ~229, ~326, and any other `"bun"` literal used to spawn), `packages/coding-agent/package.json` (`check` script ~520 prefixed with the guard); test `scripts/require-bun.test.ts`.

- [ ] **Step 1: Failing tests.** (a) `requireBunVersion` with an injected version `1.3.14` and root `packageManager` `bun@1.4.4` throws a message containing `1.3.14`, `1.4.4` and the executable path; with `1.4.4` and `1.5.0` it passes. (b) Runner command construction uses `process.execPath` (assert on the built command array from the exported builder, not by reading source text).
- [ ] **Step 2: Implement.** Runner calls the guard at startup. Child commands use `process.execPath` instead of `"bun"`. Package `check` becomes `bun ../../scripts/require-bun.ts && oxlint . && …` so that under Bun 1.3.x the first command fails with the version message before `check:types` can recurse. Verify under 1.3.14 if available locally (`~/.bun/bin/bun`): `bun run check` in `packages/coding-agent` exits non-zero with the message, without recursion; under 1.4.4 `bun check` passes.
- [ ] **Step 3: Commit** `fix(scripts): pin child test processes to the running Bun and require the minimum version`.

### Task 7: INF-3 — load-flaky tests

**Review:** per-task — concurrency

**Files:** `test/cli-provider-model-deferral.test.ts`, `test/settings-live-routing.test.ts` (and the production writer it exercises if the `rename` is there), `test/tools/browser-attach.test.ts`, `test/tools/browser-storage-state.test.ts`; possibly `scripts/ci-test-ts.ts` bucket markers; `CHANGELOG.md` if production code changes.

Known causes (from the logs and code reading; re-confirm in Step 1):

| Test | Observed failure | Likely cause | Direction |
| --- | --- | --- | --- |
| `cli-provider-model-deferral` (`print-mode suggestions for a provider-qualified miss > never lists other providers' models`, ~71-73) | 60 s timeout | two tests spawn the CLI (`bun src/cli.ts`); cold start under 16-way load exceeds the explicit 60 s per-test ceiling; isolated 27.7–44.7 s | remove the subprocess dependence (call the in-process entry the CLI uses) or, if the subprocess is the subject, move the file to the heavy/singleton bucket |
| `settings-live-routing` (`applies atomic overlay edits…`, ~124) | `EPERM` on `rename(routing.yml.next → routing.yml)` | Windows sharing violation while another handle (watcher/reader) is open | use the existing `replaceFileAtomically` helper at the writer, or make the test wait for the watcher to release; no new retry helper |
| `browser-attach` (`pickElectronTarget > waits for a real attached Chromium…`, ~178-182, cleanup ~296) | `EBUSY` removing the profile dir right after `child.kill()` | process tree not dead yet when cleanup runs | `gracefulKillTreeOnce` + `removeUserDataDir`/`removeWithRetries` (existing helpers) |
| `browser-storage-state` (`imports cookies, round-trips storage…`, ~67-69) | failed once in the full run; isolated 15.6–19.2 s against a 30 s default | wall-clock budget under load | wait on conditions, or move to the heavy bucket |

- [ ] **Step 1: Reproduce under load.** With Tasks 5/6 landed: run the full coding-agent suite with `OMP_TEST_CONCURRENCY=16` twice and record whether each of the four fails; additionally run each file alongside a CPU load (e.g. the singleton bucket in parallel). A test that cannot be made to fail under load after both attempts gets a recorded "not reproduced" and the minimal deterministic hardening from the table, nothing more.
- [ ] **Step 2:** For each reproduced test, fix the cause from the table (no raised timeouts as the only change). Prefer condition waits over sleeps.
- [ ] **Step 3: Verify:** each file passes 5/5 in isolation and in two full parallel runs.
- [ ] **Step 4: Commit** per test or one commit `test: make four load-sensitive tests deterministic`.

### Task 8: C-1 — classify coding-agent Windows failures

**Files:** Create `docs/plans/2026-11-09-windows-baseline-classification.md`. No code changes.

Input: data file table "coding-agent: 81 failing tests in 24 files". Preliminary clusters from the data (verify, do not trust):

| Cluster | Files (count) | Evidence | Candidate decision |
| --- | --- | --- | --- |
| Stale tests vs. base source, upstream test fix exists | `render-initial-messages` (16), `repro-issue-1955` (4), `repro-issue-6879` (2), `issue-4348`, `event-controller-loader-recovery`, `input-controller-tool-expansion`, `agent-session-interrupt-queued-messages`, `advisor-tool-call-loop-guard`, `rpc-goal` | `getConversationTip` added in base `5febf19920`; upstream fixed tests in `470f94702e` (test-only, 2026-11-06) | fix test: cherry-pick test-side commit |
| Upstream test fixes, other commits | `cli-responses-websocket-recovery` (13) `19ef041ec5`; `system-prompt-inventory` (2) `c28b3e3e42 4e25949931`; `cost-gate-skill-description` `463d44a950`; `browser-cmux-release-mid-run` `adf978c1b6`; `thread/focus-view` `d488335771` | data file "Upstream commits" column | check each commit is test-only; cherry-pick or port |
| Windows path assumptions | `bash-failure-result` (11) `Failed to set cwd: /tmp is not an absolute path`; `bash-autobg-timer` | POSIX `/tmp` hard-coded | fix test (use `os.tmpdir()`/TempDir) or `skipIf(win32)` with reason |
| Environment / browser | `browser-webmcp` (10) `ERR_CONNECTION_REFUSED` | local server/browser availability | investigate |
| Ambient environment leakage | `sdk-mcp-instructions` (5) — received prompt contains the host's own system prompt lines; `skills` (3); `usage-cli` | test reads ambient home/config | fix isolation (likely same pattern as F-3) |
| Load-flaky | the four INF-3 tests | Task 7 | covered by Task 7 |

- [ ] **Step 1:** For each of the 81 tests (data file), assign one cluster with one-line evidence (error signature, file:line). Re-run every non-INF-3 failing file once in isolation on Windows to separate deterministic from load-dependent failures.
- [ ] **Step 2:** For each upstream commit candidate, `git show --stat <sha>` against `upstream/main` (`git fetch https://github.com/can1357/oh-my-pi.git main:refs/remotes/upstream/main`) and record whether it touches only tests; if it touches source, record which source change it pairs with.
- [ ] **Step 3:** Decision per cluster: fix code / fix test / platform-inapplicable (`skipIf(process.platform === "win32")` with a reason string). For each "fix" cluster, write a proposed task (files, failing evidence, change, verification) in the classification document.
- [ ] **Step 4: Commit** the classification document only: `docs: classify Windows coding-agent baseline failures`.

### Task 9: C-2 — classify pi-shell test failures

**Files:** Append to `docs/plans/2026-11-09-windows-baseline-classification.md`.

Input: data file table "pi-shell: 59 failing tests". Visible signature groups: missing external tools (`type.txt: Os { code: 2, kind: NotFound }` in `every_process_builtin_is_installed_and_dispatches`, `every_utility_builtin_is_registered_under_its_own_name`); zle/zprof/prompt rendering (`zsh_mod_zprof`, `zle::refresh`, `zsh_prompt_names`); encoding (`output_decode::incomplete_utf8_at_eof_becomes_replacement`); path/temp (`env_cwd_inherited_short_temp`); zsh parity sorting (`expandmb_sorting_follows_lc_collate`). Upstream landed many Windows pi-shell fixes after the fork base (data file lists them, notably `df6fcdf98c`/`fdd10fcf4a` "run omp zsh on Windows", `9f8c1ce438`, `57e28de771`, `d99617eb59`, `1fdc73bc5f`).

- [ ] **Step 1:** Group the 59 by signature and module; for each group, check whether an upstream commit in `96e4d8eb5b..upstream/main -- crates/pi-shell` changes the failing test or the code it exercises (`git log -L` / `git log -S` on the test name).
- [ ] **Step 2:** Decision per group: port upstream fix / fix locally / platform-inapplicable with reason. Note that porting the "omp zsh on Windows" series is large; propose it as one separate task with its commit list rather than piecemeal.
- [ ] **Step 3: Commit** `docs: classify Windows pi-shell baseline failures`.

### Task 10: C-3 — Clippy on Windows; STOP for approval

**Files:** Append to the classification document.

Input: data file "pi-shell Clippy on Windows: 865 errors, 80 lints" (top: `many_single_char_names` 279, `missing_const_for_fn` 89, `single_match_else` 57). Upstream CI runs Clippy via Bazel (`bazel/clippy.bazelrc`, `--config=clippy-strict` for pi-shell, `-Dwarnings`) in `.github/workflows/ci.yml` job `rust_validate` (~229-266) on a non-Windows runner; upstream has Windows-only clippy fix commits (`3d6344d5ba` "clear Windows-only clippy errors in pi-shell and pi-vcs", `63fe0eae7a`, `88f9a60516`, `b1d7aa1399`).

- [ ] **Step 1: Does upstream run Clippy for Windows?** Read `.github/workflows/*.yml` on `upstream/main` for any Windows runner or `x86_64-pc-windows-msvc` target in clippy/bazel steps; record the answer with file:line.
- [ ] **Step 2: Which errors are Windows-only?** For each of the top lints (cover ≥90% of the 865), sample sites from the JSON (`cargo clippy -p pi-shell --no-deps --message-format=json -- -D warnings`) and classify each file/region as `cfg(windows)`-only code vs. common code. If a Linux environment is available (WSL or CI), run the same command there on the same commit and diff the counts; otherwise state that the Linux comparison is missing.
- [ ] **Step 3: Decision.** Windows-only sites: fix in code under `cfg(windows)` (or port upstream `3d6344d5ba`-style fixes). Common-code sites that upstream Linux CI does not report: explain why (different lint config path: Bazel aspect vs. cargo `[workspace.lints]`) before proposing anything. No global lint relaxation.
- [ ] **Step 4: Proposed fix tasks** for C-1..C-3 written in the classification document (files, evidence, change, verification, estimated size).
- [ ] **Step 5: Commit** and **STOP**: present the classification and proposed tasks to the repository owner. Fix tasks are appended to this plan only after explicit approval.
