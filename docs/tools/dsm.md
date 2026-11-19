# dsm

> Open, inspect, edit, and script binary analysis databases (IDA Pro via idalib, or Ghidra via PyGhidra) from eval. Databases are hosted by the omp daemon and shared by every omp process.

`dsm` is an eval prelude namespace, not a standalone tool: it exists as a global in JavaScript and Python cells, with model-facing documentation at `xd://eval/dsm`. There is no `xd://ida` or `xd://ghidra` tool.

## Source

- Eval prelude (host side, action dispatch, approval, reference ownership): `packages/coding-agent/src/disasm/prelude-definition.ts`
- Kernel-side facades: `packages/coding-agent/src/disasm/prelude.js`, `packages/coding-agent/src/disasm/prelude.py`
- Model-facing docs: `packages/coding-agent/src/prompts/tools/dsm.md` (`xd://eval/dsm`), `packages/coding-agent/src/prompts/tools/dsm-guidance.md` (system-prompt guidance)
- Key collaborators:
   - `packages/coding-agent/src/disasm/settings.ts` — `disassembler.backend`, `disassembler.maxOpen`, `disassembler.idleCloseSec`
   - `packages/coding-agent/src/disasm/active.ts` — `cfgDisasmBackend`: resolves the effective backend (or none)
   - `packages/coding-agent/src/disasm/backend.ts` — per-backend contract (`DISASM_BACKENDS`): store dir, database naming, worker script, interrupt mechanism
   - `packages/coding-agent/src/disasm/store.ts` — executable sniffing, universal Mach-O slice selection, database location
   - `packages/coding-agent/src/disasm/metadata.ts` — on-disk Mach-O/ELF/PE metadata for bare `read`
   - `packages/coding-agent/src/disasm/client.ts` — omp-side access: opens/attaches daemon units, forwards NDJSON requests
   - `packages/coding-agent/src/daemon/modules/disasm.ts` — `disasm` daemon module: one unit per open database, reference leases, LRU eviction, idle close
   - `packages/coding-agent/src/disasm/supervisor.ts` — `DisasmWorker`: the backend Python worker, request queue, interrupts, autosave
   - `packages/coding-agent/src/ida/` — IDA install detection, interpreter discovery, `ida.python` / `ida.installDir`, `worker.py`
   - `packages/coding-agent/src/ghidra/` — Ghidra/JDK/PyGhidra discovery and provisioning, `ghidra.installDir` / `ghidra.python`, `worker.py`
   - `packages/coding-agent/src/tools/read-binary.ts` — `read` metadata and explicit analysis views
   - `packages/coding-agent/src/tools/tool-timeouts.ts` — `dsm` exec timeout clamp

## Availability

- `disassembler.backend` (`auto` default, `ida`, `ghidra`, `none`) selects the backend. `cfgDisasmBackend` resolves it:
   - `auto`: IDA when an install shipping idalib is found, else Ghidra when the host is supported, else none.
   - `ida`: IDA only when an install is found; otherwise none.
   - `ghidra`: Ghidra when the host is supported (macOS/Linux x64/arm64, Windows x64); otherwise none.
   - `none`: analysis disabled.
- With a resolved backend, `sdk.ts` adds the `dsm` prelude to eval (only when the `eval` tool is active). With none, `dsm` is absent, `read` analysis selectors fail, and bare executable reads still return metadata.
- IDA install lookup: `ida.installDir` when set (authoritative), else `$IDADIR`, `Paths.ida-install-dir` in `ida-config.json`, else standard install locations. `ida.python` overrides the interpreter, which must import `ida_domain` and `idapro`.
- Ghidra install lookup: `ghidra.installDir` (Ghidra 12+), else `$GHIDRA_INSTALL_DIR`, else Homebrew prefixes, else a managed download of Ghidra 12.2 under the omp data dir. A JDK 25+ comes from `JAVA_HOME` or a managed Temurin JDK 25 download. `ghidra.python` overrides the interpreter (must import `pyghidra`); otherwise a managed venv is built from the install's bundled wheels. Provisioning is lazy: it happens on first analysis, never on bare reads.
- Approval tiers: `list`, `get`, `view` → read; `exec` → exec; every other action → write.

## API

Every call returns a promise. JavaScript and Python expose the same methods; Python uses `set_type` / `make_function` and keyword options.

| Call                                   | Description                                                                                                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dsm.open(path)`                       | Open (or create) a database for an executable, a `<bin>:@<arch>` universal slice, an existing IDA `.i64`/`.idb`, or a portable `db.handle()` string. Returns a handle. |
| `dsm.list()`                           | Descriptors of every open database for the active backend, with portable `handle` strings and live reference counts.                                                 |
| `dsm.get(id?)`                         | Attach to an already-open database; `id` may be omitted only when exactly one is open.                                                                               |
| `db.view(view = "overview")`           | Rendered view using the `read` suffix grammar: `overview`, `<func\|0xaddr>` (pseudocode), `<func>:asm`, `imports`, `exports`, `strings`, `xrefs:<func\|0xaddr>`.       |
| `db.exec(code, { timeout })`           | Run Python in the backend worker. Returns `{ output, value, error }`.                                                                                                 |
| `db.rename(target, name)`              | Rename a symbol/address.                                                                                                                                              |
| `db.comment(target, text, { repeatable })` | Set a comment.                                                                                                                                                    |
| `db.setType(target, decl)`             | Apply a C declaration (IDA) or prototype/type expression (Ghidra).                                                                                                    |
| `db.makeFunction(target)`              | Create a function at an address.                                                                                                                                      |
| `db.save()`                            | Save now.                                                                                                                                                             |
| `db.close({ save = true })`            | Release this handle's reference; the final release closes the database.                                                                                              |
| `db.handle()`                          | Portable string bound to this live database incarnation, for passing to subagents.                                                                                  |

Handles expose `id`, `backend`, `ref`, `path`, and `info`. Targets accept a symbol name, `0x` string, or integer address. Reserved view names win over same-named symbols; use an address for those.

## Read integration

- Bare `read <binary>` (ELF/PE/Mach-O, extensionless included) and bare `read <db>.i64`/`.idb` return on-disk metadata only. They never open a database or provision a backend. The footer lists the explicit analysis selectors and points to `xd://eval/dsm`, or says analysis is disabled.
- Analysis selectors (`bin:overview`, `bin:<func|0xaddr>`, `bin:<func>:asm`, `:imports`, `:exports`, `:strings`, `:xrefs:<func|0xaddr>`) open the database through the same daemon units as `dsm.open`. See [`read`](read.md#executables-and-disassembler-databases).

## Flow

1. `dsm.open` resolves the path (or parses a handle), locates the database, and calls `acquireDatabase`. It attaches to a running `disasm` daemon unit keyed `<backend>:<id>` or asks the daemon to start one, then waits for the open. Opens are not cancellable once analysis starts; an open that outlasts the wait fails with `<Backend> is still analyzing … Retry later`, and a Ghidra install in progress fails with `Ghidra is still being installed (…); it continues in the background. Retry later.`
2. Each open database is a global-scope daemon unit listed by `omp ps` as `omp.ida.<id>` / `omp.ghidra.<id>`, hosting one long-lived Python worker. All omp processes share it.
3. Every `open` or `get` takes an independent reference lease. `close()` releases only that lease; the final release closes the database. Retained references pin the database against idle close and LRU eviction.
4. Opening beyond `disassembler.maxOpen` (default 4, across both backends) evicts the least recently used unreferenced idle database.
5. Requests are serialized per database. Structured edits, views, and `save` use a 120 s request timeout; `exec` defaults to 120 s, clamped by `clampTimeout("dsm", …)` (positive `tools.maxTimeout` cap, then `1..3600`). A timeout or abort interrupts the running request (SIGINT for IDA on Unix, an interrupt frame for Ghidra and on Windows); a worker that does not answer within 5 s is killed.

## `exec` namespace

Python, persistent per database and shared across agents (not per handle); reopening after idle close resets it. Both backends preload:

- `resolve(t)`, `func(t)`, `name_of(ea)`
- `pseudocode(t)`, `asm(t)` → str
- `xrefs_to(t)`, `xrefs_from(t)` → dicts; `callers(t)`, `callees(t)` → names
- `functions(pattern)`, `strings(pattern)`, `imports(pattern)` → tuples; optional case-insensitive regex
- `hexdump(t, size=64)`, `read_bytes(t, size)`
- `rename(t, name)`, `comment(t, text, repeatable=False)`, `set_type(t, decl)`, `make_function(t)`

IDA additionally preloads `db` (ida_domain `Database`), `ida_domain`, `ida_*` modules, `idautils`, and `help_ida()`. Ghidra additionally preloads `program` / `currentProgram`, `project`, `flat`, `monitor`, `pyghidra`, `jpype`, and `help_ghidra()`; its pseudocode falls back to disassembly when the decompiler is unavailable.

## Side Effects

- Executables are analyzed in managed databases under the agent directory (`getAgentDir()`): `idbs/<sha16>-<name>[.<arch>]/` for IDA, `ghidra-projects/<sha16>-<name>[.<arch>]/` for Ghidra. Source binaries are never modified. IDA `.i64`/`.idb` files open in place; Ghidra project paths do not open in place.
- Universal Mach-O: only the selected slice is staged. The default slice matches the host CPU (else the first); `:@<arch>` picks another. Each slice gets its own database.
- Dirty databases autosave after ~10 s idle; `save()` forces it. `close()` requests a save by default; the final release honors any owner's save request, so unsaved changes are discarded only when every released reference chose `save: false`. Orderly `omp ps stop` saves; a crash, forced kill, or unresponsive-worker kill loses changes since the last save.
- Ghidra `exec` database changes roll back on error or interruption (Python variables do not). IDA changes made before an `exec` failure remain.
- Unreferenced databases idle for `disassembler.idleCloseSec` (default 900, `0` = never) are saved and closed.
- Session-owned references are saved and released on session disposal and on conversation or backend change; resumable subagents keep theirs until explicit close or disposal.

## Errors

- `dsm is disabled in the current session.` / `Disassembler backend changed; reopen with dsm.open(path or handle).`
- `Not an executable or supported database: <path>`
- `no <arch> slice; available: …`
- `Database reference is closed or expired; reopen with dsm.open(path or handle).`
- `dsm handle has expired; the original database is no longer open. Ask its owner for a live handle.`
- `<Label> database <id> is in use by another process`
- `<Label> worker for <id> exited (<code>)…` — the worker died; see `omp ps logs`.
- `IDA databases require disassembler.backend=ida and an IDA installation.` — `read` analysis selector on an `.i64`/`.idb` with another backend.
