# radare2 Backend for dsm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full-parity `radare2` backend to `dsm` alongside IDA and Ghidra.

**Architecture:** Extend the existing backend-neutral seam in `packages/coding-agent/src/disasm/`, add a Python `worker.py` adapter driving one r2pipe instance per database, and reuse the existing broker daemon, NDJSON protocol, handles, and `dsm` prelude. The worker persists r2 projects in the managed store and approximates the three radare2 gaps (repeatable comments, dirty bit, in-command cancel) without changing the protocol.

**Tech Stack:** TypeScript/Bun, Python 3, `r2pipe` in an omp-managed venv, radare2 6.2.x, existing `IpcConnection` NDJSON IPC.

**Spec:** `docs/superpowers/specs/2026-11-17-radare2-backend-design.md` (approved; POSIX-first v1). Research: `docs/research/radare2-backend-parity/REPORT.md`.

## Global Constraints

- Base: `origin/main 1bdbf6d242d99ca62bdf2feeff4519ff992f647d`.
- No Rust files, no native addon rebuild, no system-wide package installs.
- No `ReturnType<>`, TS `private`/`protected`, inline/dynamic imports, or `as any`.
- All Python dependencies go in an omp-managed venv.
- Heavy commands go through `/home/yuzu/projects/oh-my-pi/tmp/heavy.sh <label> -- <cmd>`; typecheck must report the compiler verdict line, not just exit code.
- Narrow verification only: named test files and `bun check --no-script -p packages/coding-agent/tsconfig.json`. No full suite unless asked.
- Commit steps are part of this plan; under the current session rule, do not run `git commit` or `git push` without explicit user approval.
- Changelog: one user-facing line under `[Unreleased]`, PR link + `@yuzu-octopus` credit, added when the PR number exists. Never edit released sections.

## Review Focus

- `omp.radare2.<id>` daemon name must label its host as radare2, not IDA — pinned in Task 1 by `backendForHost()` inference test.
- Portable handle `dsm://radare2/<id>/<uuid>?project=...` must round-trip — pinned in Task 1 by handle parse/format test.
- `comment(..., repeatable: true)` must write at target plus xrefs — pinned in Task 3 by the repeatable-comment stub test.
- Interrupt/timeout must terminate the r2 child and preserve the last saved project — pinned in Task 3 by the interrupt-frame test.
- Missing `pdgj` must fall back to `pdcj` without an error surfacing to the model — pinned in Task 2 by the pseudocode fallback test.

---

### Task 1: Backend identity, runtime, and database lifecycle

**Files:**
- Modify: `packages/coding-agent/src/disasm/backend.ts`
- Modify: `packages/coding-agent/src/disasm/protocol.ts`
- Modify: `packages/coding-agent/src/disasm/client.ts`
- Modify: `packages/coding-agent/src/disasm/prelude-definition.ts`
- Modify: `packages/coding-agent/src/disasm/settings.ts`
- Modify: `packages/coding-agent/src/disasm/active.ts` (explicit selection only; auto order is Task 4)
- Modify: `packages/coding-agent/src/disasm/runtime.ts`
- Modify: `packages/coding-agent/src/config/all-settings.ts`
- Modify: `packages/coding-agent/package.json`
- Modify: `packages/coding-agent/src/tools/read-binary.ts` (name radare2 in disabled-backend guidance)
- Create: `packages/coding-agent/src/radare2/{index,settings,install,runtime}.ts`
- Create: `packages/coding-agent/src/radare2/worker.py`
- Create: `packages/coding-agent/test/tools/radare2-worker.test.ts`

**Interfaces:**
- Consumes: `DisasmBackend`, `DisasmBackendId`, `WorkerRuntime` from `src/disasm/backend.ts`; `DatabaseLocation` from `src/disasm/store.ts`; `DisasmWorker` from `src/disasm/supervisor.ts`; `Settings`, `$which`, `ensureManagedVenv`.
- Produces:
  - `radare2Available(): boolean` — configured path or `$which("radare2")`.
  - `resolveRadare2Runtime(session: ToolSession): Promise<WorkerRuntime>` — Python path with r2pipe in a managed venv, env including resolved r2 binary path.
  - `DISASM_BACKENDS.radare2` — descriptor with `storeDir: "radare2-projects"`, `databaseExt: ".r2"`, `databaseName: () => "omp.r2"`, `isDatabasePath: () => false`, `workerStageDir: "omp-radare2-worker"`, `interrupt: "signal"`, `projectAlias: false`.
  - Worker methods `open`, `save`, `close` returning the same shapes as the other backends.

- [ ] **Step 1: Write failing tests for selection, handle, label, and lifecycle**

In `test/tools/radare2-worker.test.ts`, following `test/tools/ghidra-worker.test.ts`:
- Stub `r2pipe` on `PYTHONPATH` with `open`, `cmd`, `cmdj`, `quit`, `terminate`.
- Test `"opens, saves and closes a radare2 project from a hidden managed store"` — assert `open` result has `idb`, `module`, `format`, `arch`, `bitness`; `save` writes `<loc.dir>/omp.r2`; `close` calls `quit()`.
- Test `"labels omp.radare2.* hosts as radare2"` — assert `backendForHost("omp.radare2.abc")` returns `"radare2"`.

In `test/tools/disasm-binary.test.ts`:
- Test `"selects radare2 explicitly when configured"` with `Settings.isolated({ "disassembler.backend": "radare2", "radare2.r2Path": <temp executable> })` → `cfgDisasmBackend.get(...)` is `"radare2"`.

In `test/eval/dsm-prelude.test.ts` (single added case):
- Test `"round-trips a radare2 dsm handle"` — `formatDatabaseHandle({backend: "radare2", ...})` then `parseDatabaseHandle(...)` returns the same object and does not throw.

- [ ] **Step 2: Run the new tests and confirm they fail**

Run through the heavy gate: `bun test ./packages/coding-agent/test/tools/radare2-worker.test.ts ./packages/coding-agent/test/tools/disasm-binary.test.ts ./packages/coding-agent/test/eval/dsm-prelude.test.ts -t 'radare2'`
Expected: FAIL because `radare2` is not in the backend union/settings and the worker file does not exist.

- [ ] **Step 3: Add the adapter skeleton and shared seam changes**

Implement the interfaces above. In `backend.ts`, import `../radare2/worker.py` as text with `{ type: "text" }`. In `protocol.ts`, add `omp.radare2.` to `DISASM_DAEMON_PREFIXES`, accept `radare2` in the handle hostname check and `hostConfigSchema.backend`. In `client.ts`, replace the `backendForHost()` ternary with a loop over `DISASM_DAEMON_PREFIXES`. In `prelude-definition.ts`, accept `radare2` in `handleFields.backend`. In `settings.ts`, add the value and option; in `active.ts`, add the explicit branch returning `"radare2"` only when `radare2Available()`. In `runtime.ts`, route to `resolveRadare2Runtime` and extend `installStatus()`. Register the settings domain and package exports.

- [ ] **Step 4: Implement worker `open`, `save`, `close`**

In `worker.py`, use the Ghidra worker's NDJSON loop shape. `open` applies `scr.color=0`, `scr.utf8=false`, `scr.interactive=false`, `dir.projects=<loc.dir>`, `prj.files=false`; opens the staged binary (`r2pipe.open(stagedPath, flags=["-N"])`) or saved project (`r2pipe.open("-", flags=["-p", "omp"])`); runs `aa`; writes the `omp.r2` marker; returns `{idb, module, format, arch, bitness}` from `iIj`. `save` runs `Ps omp` and clears the mutation ledger. `close` saves when requested, then `r2.quit()`. Use `DisasmUnavailableError` messages consistent with existing adapters.

- [ ] **Step 5: Run the tests and typecheck**

Run the same three test files through the heavy gate, then `bun check --no-script -p packages/coding-agent/tsconfig.json` through the heavy gate.
Expected: named tests PASS; typecheck prints `No type errors in N files`.

- [ ] **Step 6: Commit (approval required)**

`git commit -m "feat(coding-agent): add radare2 backend identity and project lifecycle"` with explicit file paths only.

---

### Task 2: Views and exec

**Files:**
- Modify: `packages/coding-agent/src/radare2/worker.py`
- Modify: `packages/coding-agent/test/tools/radare2-worker.test.ts`
- Modify: `packages/coding-agent/src/prompts/tools/dsm.md` (r2 namespace and decompiler note only)

**Interfaces:**
- Consumes: worker loop and stub fixture from Task 1.
- Produces: `view` handling for all seven kinds and `exec` returning `{output, value, error}` with a persistent `NS` including `r2` and `help_radare2()`.

- [ ] **Step 1: Write failing view/exec tests**

In `radare2-worker.test.ts`:
- Test `"returns every dsm view from r2 JSON commands"` — for `overview`, `imports`, `exports`, `strings`, `pseudocode`, `asm`, `xrefs`, assert `{text}` is a non-empty string and the stub recorded `iij`, `iEj`, `izzj`, `pdgj`/`pdcj`, `pdfj`/`pdj`, `axtj` as appropriate.
- Test `"falls back to pdcj when pdgj is unavailable"` — stub `cmdj("pdgj...")` to raise, assert the `pseudocode` view still returns text and no `error`.
- Test `"exec captures output, last value and error with a persistent namespace"` — first call sets a variable, second reads it; assert `{output, value, error}` shape and value repr.

- [ ] **Step 2: Run tests and confirm they fail**

Run through the heavy gate: the named tests in `test/tools/radare2-worker.test.ts`.
Expected: FAIL with unknown view / missing helper.

- [ ] **Step 3: Implement view and exec handlers**

Use `cmdj` with fallback to `cmd` for JSON parse failures. Format `{text}` like the Ghidra worker (`overview` includes module, format, arch, bitness, segments, entries, counts, functions). `pseudocode` tries `pdgj`, then `pdcj`. `asm` tries `pdfj`, then `pdj`. `xrefs` calls `axtj` on the resolved target. Preload the shared helpers named in the spec plus `r2` and `help_radare2()`; use the same AST last-expression handling as the other workers.

- [ ] **Step 4: Run tests and typecheck**

Same commands as Task 1 Step 5.
Expected: named tests PASS, typecheck verdict clean.

- [ ] **Step 5: Commit (approval required)**

`git commit -m "feat(coding-agent): add radare2 analysis views and exec"`.

---

### Task 3: Mutations, dirty ledger, and cancellation

**Files:**
- Modify: `packages/coding-agent/src/radare2/worker.py`
- Modify: `packages/coding-agent/test/tools/radare2-worker.test.ts`
- Modify: `packages/coding-agent/src/prompts/tools/dsm.md` (repeatable-comment and cancellation notes)

**Interfaces:**
- Consumes: worker helpers from Task 2.
- Produces: `rename(target, name)`, `comment(target, text, repeatable)`, `set_type(target, decl)`, `make_function(target)`, mutation ledger, SIGINT/interrupt-frame cancellation.

- [ ] **Step 1: Write failing mutation and cancellation tests**

In `radare2-worker.test.ts`:
- Test `"renames, comments, sets types and creates functions"` — assert stub commands `afn <name> @ <addr>`, `CC <text> @ <addr>`, `afs <decl> @ <addr>` (unquoted), `af @ <addr>`; assert response `dirty` flips true and goes false after `save`.
- Test `"repeatable comments are written at the target and its xrefs"` — stub `axtj` with two xref addresses, call `comment(..., repeatable: true)`, assert `CC` recorded at target and both xrefs.
- Test `"rejects a type declaration that r2 cannot parse without renaming the function"` — stub `afs` failure, assert the request errors and no rename is reported.
- Test `"interrupt frame terminates r2 and preserves the last saved project"` — send an `interrupt` frame during a stubbed long `exec`, assert the response is an error containing `interrupted`, `terminate()` was called, and the saved project file still exists.

- [ ] **Step 2: Run tests and confirm they fail**

Run the named tests through the heavy gate.
Expected: FAIL because mutation methods are absent.

- [ ] **Step 3: Implement mutations and cancellation**

`rename` uses `afn <name> @ <addr>`; `comment` uses `CC <text> @ <addr>` plus `axtj` addresses when `repeatable`; `set_type` strips one layer of surrounding quotes and runs `afs <decl> @ <addr>` after resolving the target with `?v`; `make_function` runs `af @ <addr>`. Each successful mutation marks the ledger dirty; responses include `dirty`. Install a POSIX SIGINT handler that terminates r2 and raises `KeyboardInterrupt`; handle the Windows interrupt frame the same way. Block SIGINT while writing response frames as the Ghidra worker does.

- [ ] **Step 4: Run tests and typecheck**

Same commands as Task 1 Step 5.
Expected: named tests PASS, typecheck verdict clean.

- [ ] **Step 5: Commit (approval required)**

`git commit -m "feat(coding-agent): add radare2 mutations and cancellation"`.

---

### Task 4: Auto selection, docs, and end-to-end wiring

**Files:**
- Modify: `packages/coding-agent/src/disasm/active.ts`
- Modify: `packages/coding-agent/src/disasm/settings.ts`
- Modify: `packages/coding-agent/src/prompts/tools/{dsm,read-sources}.md`
- Modify: `packages/coding-agent/CHANGELOG.md`
- Modify: `packages/coding-agent/test/tools/disasm-binary.test.ts`
- Modify: `packages/coding-agent/test/eval/dsm-prelude.test.ts`

**Interfaces:**
- Consumes: `radare2Available()` from Task 1; worker deliverables from Tasks 2–3.
- Produces: `auto` order `ida → radare2 → ghidra → none`; docs and changelog entry.

- [ ] **Step 1: Write failing selection and integration tests**

In `disasm-binary.test.ts`:
- Test `"auto prefers radare2 over provisioning Ghidra when available"` — stub `radare2Available()` true with no idalib, assert `cfgDisasmBackend.get(...)` is `"radare2"`.
- Test `"auto still prefers IDA when available"` — existing idalib fixture plus r2 available, assert `"ida"`.

In `dsm-prelude.test.ts`:
- Test `"dsm.open with backend radare2 routes calls through the r2 fixture"` — set the spied backend to `"radare2"`, issue `view` and `rename`, assert the host request backend field and result.

- [ ] **Step 2: Run tests and confirm they fail**

Run the two named test files through the heavy gate.
Expected: FAIL on the new auto case and backend-enforcement case.

- [ ] **Step 3: Update auto order and docs**

Change `active.ts` auto chain to `ida → radare2 → ghidra → undefined`. Update `settings.ts` descriptions and TUI options with the new order and r2 behavior. Update `dsm.md` to list radare2, its daemon name, `r2`/`help_radare2()` namespace, `pdgj`→`pdcj` fallback, repeatable-comment approximation, and cancellation losing unsaved in-memory state. Update `read-sources.md` to include radare2. Add one `[Unreleased] ### Added` changelog line with the PR link and credit once the PR exists.

- [ ] **Step 4: Run tests, typecheck, and formatter**

Run the two test files plus `radare2-worker.test.ts` through the heavy gate; then typecheck and the formatter check on all edited files.
Expected: all named tests PASS; typecheck verdict clean; formatter clean.

- [ ] **Step 5: Commit (approval required)**

`git commit -m "feat(coding-agent): enable radare2 as third dsm backend"`.

## Final Verification

- [ ] All five Review Focus behaviors have a passing named test.
- [ ] No Rust files changed; `git diff --name-only origin/main...HEAD` contains only TypeScript, Python, prompts/docs, tests, package metadata, and the changelog.
- [ ] Design doc status remains approved; plan and spec are committed only with explicit approval.
