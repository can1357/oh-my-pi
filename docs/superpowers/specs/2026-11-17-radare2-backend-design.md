# radare2 backend for `dsm` — design

**Date:** 2026-11-17
**Status:** approved 2026-11-17 (POSIX-first v1)

## Intent and why

`dsm` currently offers IDA Pro (`idalib`) and Ghidra (`PyGhidra`). Both need large vendor installs; Ghidra is downloaded on first analysis. radare2 is free, scriptable, and often already installed. Adding it as a third backend gives the agent a usable disassembler/decompiler without a vendor license or a large download, and exercises the backend-neutral seam with a genuinely different tool.

## Goals

- Every `dsm` action works under `radare2`: `open`, `list`, `get`, `view` (overview, imports, exports, strings, pseudocode, asm, xrefs), `exec`, `rename`, `comment`, `set_type`, `make_function`, `save`, `close`.
- One r2pipe-driven Python worker per database, supervised by the existing host daemon; no new cross-process protocol.
- Persistent projects in the managed store; source binaries are never modified.
- Backend appears in settings, `omp ps` daemon names, portable handles, prompts, docs, and tests.
- TypeScript + Python only. No Rust, no native addon rebuild.

## Non-goals

- Automatic installation of the radare2 binary. It must be on PATH or explicitly configured.
- Byte-for-byte identical decompiler output to IDA/Ghidra. radare2 uses `pdcj` (pseudo-C) or `pdgj` (r2ghidra) with its own formatting.
- Exact IDA semantics for repeatable comments, per-command cancellation, and a readable dirty bit. Radare2 has none of the three; the approximations below are part of this design.
- Opening an existing radare2 project directory in place. Like Ghidra projects, r2 projects open from the managed store only.

## Constraints

- `DisasmBackendId` and the four hardcoded backend literals drive selection, daemon naming, handle parsing, and schemas (see exact list below).
- Worker scripts are imported as text (`with { type: "text" }`) and staged by the supervisor; the new worker must be a single self-contained `worker.py`.
- Host daemon names are capped at 48 characters; `omp.radare2.<id>` fits.
- Project-rule constraints: no `ReturnType<>`, no TS `private`/`protected`, no inline/dynamic imports, no `as any`, no Rust changes.
- Python deps go in an omp-managed venv. Never install system-wide packages.

## Approaches considered

1. **Full-parity backend (chosen).** Add a real adapter under `src/radare2/`, widen the shared literals, and implement every `dsm` action with documented r2-specific semantics. Larger, but the only option that actually puts radare2 alongside IDA and Ghidra in the same namespace.
2. **Explicit subset first.** Open/views/exec only; mutations throw `ToolError`. Smaller, but the model would hit dead ends on actions that work in the other backends.
3. **Extension-only `registerTool` tool.** Fastest, but invisible to `dsm` and `read <binary>:<view>`; rejected as not meeting the goal.

## Design decisions (calls made here)

- **Auto order becomes `ida → radare2 → ghidra → none`.** IDA stays first. When radare2 is installed, auto avoids the large Ghidra provision. This is a behavior change for hosts with both r2 and no IDA; it is the reason this doc needs approval.
- **No auto-install of radare2.** `radare2Available()` checks a configured binary path or `$which("radare2")`. The small `r2pipe` Python package is provisioned in a managed venv on first use.
- **Analysis level at open is `aa`, not `aaa`/`r2 -A`.** It populates functions and xrefs at lower cost; deeper analysis is available through `db.exec("aaa")`. This is a tunable builder detail, not a contract.
- **Decompiler selection is opportunistic:** try `pdgj` (r2ghidra), fall back to `pdcj` (core pseudo-C). No `r2pm` install from omp.
- **Repeatable comments:** write `CC` at the target and at each address returned by `axtj` for that target. Document as an approximation, not IDA's repeatable flag.
- **Dirty state:** worker-side mutation ledger, cleared by successful `save`. `exec` mutations are tracked by the supervisor's existing `#execSinceSave`, matching IDA-style "changes before a failed exec remain".
- **Cancellation:** on POSIX, a SIGINT handler terminates the r2 child and raises `KeyboardInterrupt`; the Windows interrupt-frame path is implemented only to keep the shared seam intact, with no Windows-specific verification or test matrix in v1 (owner decision). The r2 session is lost on interrupt; the last saved project survives. Document this in the prompt.
- **Project layout:** `dir.projects = <loc.dir>`; project name `omp`; artifact `<loc.dir>/omp/rc.r2`; marker `<loc.dir>/omp.r2` satisfies `prepareStoreDir`'s database lookup. Existing project reopen uses `r2pipe.open("-", flags=["-p", "omp"])`.

## Shared-code changes (exact seams)

All paths below are relative to `packages/coding-agent/`, base `origin/main 1bdbf6d`.

- `src/disasm/backend.ts:3-4,7,36-63` — import `../radare2/worker.py` as text; add `"radare2"` to `DisasmBackendId`; add registry entry (`storeDir: "radare2-projects"`, `databaseExt: ".r2"`, `databaseName: () => "omp.r2"`, `isDatabasePath: () => false`, `workerStageDir: "omp-radare2-worker"`, `interrupt: "signal"`, `projectAlias: false`).
- `src/disasm/protocol.ts:24,90,200` — add `"omp.radare2."` to `DISASM_DAEMON_PREFIXES`; accept `radare2` in the handle hostname check and `hostConfigSchema.backend`.
- `src/disasm/client.ts:55-57,584-631` — `backendForHost()` is a hardcoded `ghidra ? ... : ida` ternary; replace it with a loop over `DISASM_DAEMON_PREFIXES`/`DISASM_BACKENDS` so `omp.radare2.*` hosts get the right label. Leave the IDA-only distribution smoke test alone unless required.
- `src/disasm/active.ts:8-26` — add `radare2` choice branch and reorder auto as above.
- `src/disasm/settings.ts:7,13-34,47` — add `radare2` value, option text, and daemon names in the max-open description.
- `src/disasm/runtime.ts:8-15` — route `radare2` to `resolveRadare2Runtime`; extend install status.
- `src/disasm/prelude-definition.ts:24` — accept `radare2` in `handleFields.backend`.
- `src/config/all-settings.ts:27-29,63-65` — register the `radare2` settings domain.
- `src/tools/read-binary.ts:105-107,120` — name `radare2` in disabled-backend guidance.
- `package.json:282-307` — add `./radare2` and `./radare2/*` exports.

No other changes to `src/disasm/{host,supervisor,client}` protocol handling; those modules are already backend-neutral.

## New adapter: `src/radare2/`

- `settings.ts` — `radare2.python` (interpreter override) and `radare2.r2Path` (explicit binary path, blank = PATH discovery).
- `install.ts` / `runtime.ts` — detect the r2 binary, create a managed venv, install/verify `r2pipe` there, cache runtime per interpreter/binary/cwd like the Ghidra adapter. `DisasmUnavailableError` on failure. `installStatus()` reports provisioning progress.
- `worker.py` — one r2pipe instance and one persistent exec namespace (`NS`), using the existing NDJSON protocol `{id, method, params}` / `{id, ok, result, dirty}`.
  - `open`: apply `scr.color=0`, `scr.utf8=false`, `scr.interactive=false`, `dir.projects=<loc.dir>`, `prj.files=false`; open the staged binary or saved project; run `aa`; write `omp.r2`; return loader info from `iIj`.
  - `view`: `overview` (`iIj`, `iSj`, `iej`, `aflj`), `imports` (`iij`), `exports` (`iEj`), `strings` (`izzj`), `pseudocode` (`pdgj` → `pdcj`), `asm` (`pdfj` → `pdj`), `xrefs` (`axtj`); return `{text}` with the same shape as the other workers.
  - `exec`: same AST-based last-expression handling and captured `{output, value, error}`; preload shared helpers plus `r2`, `help_radare2()`.
  - Helpers: `resolve`, `func`, `name_of`, `pseudocode`, `asm`, `xrefs_to`, `xrefs_from`, `callers`, `callees`, `functions`, `strings`, `imports`, `hexdump`, `read_bytes`, `rename`, `comment`, `set_type`, `make_function`, `help_radare2`.
  - Mutations: `afn <name> @ <addr>`; `CC <text> @ <addr>` (plus xref addresses when `repeatable`); `afs <decl> @ <addr>` with outer quotes stripped and target validated via `?v`; `af @ <addr>`. Each successful mutation marks the ledger dirty.
  - `save`: `Ps omp`, clear ledger, return `{idb: marker}`.
  - `close`: save when requested, then `r2.quit()`.
  - Cancellation: POSIX SIGINT handler and Windows interrupt-frame path both terminate r2 and raise `KeyboardInterrupt`; response frames are written with SIGINT blocked as in the Ghidra worker.
  - `cmdj` failures fall back to `cmd()` output; no `~` filters, no ANSI color.

## Docs and prompts

- `src/prompts/tools/dsm.md` — list radare2 as a backend, document daemon names, r2 namespace (`r2`, `help_radare2`), decompiler fallback, repeatable-comment approximation, and cancellation losing unsaved in-memory state.
- `src/prompts/tools/read-sources.md` — include `radare2` in the list of backends that analysis selectors may open.
- `docs/tools/ida.md` has a sibling `dsm` doc? If no r2 doc exists, add `docs/tools/radare2.md` only if the existing docs pattern requires it; otherwise keep the change in prompts.
- `packages/coding-agent/CHANGELOG.md` — one `### Added` line under `[Unreleased]` with PR link + `@yuzu-octopus` credit, added at PR time.

## Tests

- `test/tools/radare2-worker.test.ts` — stub `r2pipe` via `PYTHONPATH`, run the real worker over `DisasmWorker`; cover open, all views, exec result shape, every mutation, dirty transitions, save, close, and the interrupt frame. No real r2 install needed.
- `test/tools/disasm-binary.test.ts` — explicit `radare2` selection with a temp fake binary path; auto prefers radare2 over Ghidra when available; `none` still disables.
- `test/eval/dsm-prelude.test.ts` — one case with a `dsm://radare2/...` handle round-trip to prove handle parsing and backend-enforcement work.
- Narrow verification: the three test files above, plus `bun check --no-script -p packages/coding-agent/tsconfig.json` and formatter check on edited files. No full-suite run unless asked.

## Acceptance

- A model can `await dsm.open("./binary")` with `disassembler.backend = "radare2"` and call every method in the parity table without a `ToolError` caused by a missing backend implementation.
- Stubbed worker tests prove the exact wire shapes and the three documented r2-specific semantics.
- Auto selection, settings UI, handles, and `omp ps` names include radare2.
- No Rust files changed, no native rebuild, no system-wide package install.
- Design doc approved before any product code is written.

## Builder-discretion details

- Exact r2 JSON field names for each view (research report lists them) and formatting into `{text}`.
- Whether `aa` is enough for a given binary; tune to `aaa` if stub tests or real probes show empty xrefs.
- How to expose `r2pipe` in the managed venv using the existing venv helper.
- Handling of `afs` custom-type rejection: pass through a clear error rather than silently applying a partial rename.

## Research source

`docs/research/radare2-backend-parity/REPORT.md` (primary-source citations, local radare2 6.2.2 probes). Key gaps: no repeatable-comment flag, no exposed dirty bit, no in-command cancellation, `pdc` quality depends on version/plugin.
