# ida

> Open, edit, and script IDA Pro (idalib) databases hosted by daemon-broker daemons shared by every agent and omp process in the project.

## Source
- Entry: `packages/coding-agent/src/tools/ida.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/ida.md`
- Key collaborators:
  - `packages/coding-agent/src/ida/settings.ts` — `ida.enabled`, `ida.python`, `ida.installDir`, `ida.maxOpen`, `ida.idleCloseSec` settings
  - `packages/coding-agent/src/ida/install.ts` — local install detection (`cfgIdaAvailable`, `cfgIdaInstall`)
  - `packages/coding-agent/src/ida/runtime.ts` — Python interpreter discovery (must import `ida_domain` + `idapro`)
  - `packages/coding-agent/src/ida/store.ts` — executable sniffing, universal Mach-O slice selection, IDB location (`~/.omp/agent/idbs/<sha16>-<name>[.<arch>]/` or in place)
  - `packages/coding-agent/src/ida/client.ts` — omp-side registry: starts/attaches hosts via the project broker, LRU eviction, request forwarding, flush on exit
  - `packages/coding-agent/src/ida/host.ts` — `omp.ida.<id>` daemon (`__omp_worker_ida_host`): IDB lock, socket server, SIGTERM save/close
  - `packages/coding-agent/src/ida/protocol.ts` — daemon naming, endpoints, host config and NDJSON wire schemas
  - `packages/coding-agent/src/ida/supervisor.ts` — `IdaWorker`: the Python worker process inside a host, request queue, idle autosave/close
  - `packages/coding-agent/src/ida/worker.py` — idalib worker: views, edits, `exec` namespace and helpers
  - `packages/coding-agent/src/tools/read-binary.ts` — `read` views on executables and `.i64`/`.idb`
  - `packages/coding-agent/src/tools/tool-timeouts.ts` — `ida` exec timeout clamp

## Availability
- Exposed only when `ida.enabled` (default on) is set **and** a local IDA install shipping idalib is found; otherwise the tool, the `read` executable/IDB views, and the `read` prompt bullet are all absent. Gate: `cfgIdaAvailable` in `IdaTool.createIf` and `isToolAllowed` (`packages/coding-agent/src/tools/index.ts`), reconciled live via `cfgBuiltinToolGates`.
- Install lookup: `ida.installDir` when set (authoritative; no fallback), else `$IDADIR`, `Paths.ida-install-dir` in `ida-config.json` (`$IDAUSR`, then `~/.idapro` or `%APPDATA%\Hex-Rays\IDA Pro`), else standard locations (`/Applications/IDA*.app/Contents/MacOS`, `~/ida*`, `/opt/ida*`, `%ProgramFiles%\IDA*`). The found directory is exported to workers as `IDADIR`.
- `loadMode: "discoverable"` — mounted as `xd://ida` when xdev is on.
- Approval tiers: `list` → read, `exec` → exec, every other action → write.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `"list" \| "open" \| "save" \| "close" \| "exec" \| "rename" \| "comment" \| "set_type" \| "make_function"` | Yes | Dispatch key. |
| `db` | `string` | No | Binary or `.i64`/`.idb` path (cwd-relative), or an open DB id. `<bin>:@<arch>` picks a universal Mach-O slice. Optional when exactly one DB is open; required for `open`. |
| `target` | `string` | No | Symbol name or `0x` address. `_`-prefixed Mach-O names also resolve without the underscore. |
| `name` | `string` | No | New name for `rename`. |
| `text` | `string` | No | Comment text for `comment`. |
| `repeatable` | `boolean` | No | Repeatable comment (default `false`). |
| `decl` | `string` | No | C declaration for `set_type`; a trailing `;` is added. |
| `code` | `string` | No | Python for `exec`. |
| `save` | `boolean` | No | `close`: save first (default `true`). |
| `timeout` | `number` | No | `exec` seconds, default `120`; `clampTimeout("ida", …)` applies the positive `tools.maxTimeout` cap, then `1..3600`. |

### Action-specific requirements
- `open`: `db`
- `rename`: `target`, `name`
- `comment`: `target`, `text`
- `set_type`: `target`, `decl`
- `make_function`: `target`
- `exec`: `code`
- `save` / `close`: the DB must already be open (they never open one).

## Outputs
- `list`: one line per DB in the project — `id  module  format  arch/bitness  idbPath [<method> running]`, `id  (opening)  <ref>` while analyzing, or `No IDA databases open.`
- `open`: `Opened <id> (<module>, <format>, <arch> <bitness>-bit) → <idb>. read <source> for the overview.`
- `save` / `close`: `Saved <idb>` / `Closed <id> (saved | discarded unsaved changes)`.
- Edits: one line, e.g. `Renamed 0x401000 sub_401000 → parse_header`.
- `exec`: captured stdout/stderr, then `=> <repr>` of the last expression, then the traceback on failure (`isError: true`). Text passes through `enforceInlineByteCap`; overflow is saved as an `ida` artifact.
- `details`: `{ action, db?: <id> }`. No custom renderer.

## Flow
1. `#resolveDb`: omitted `db` → the single open DB; an open id or `omp.ida.*` daemon name → that DB; otherwise the path must be a file. Mutating actions and `exec` call `acquireIdaDatabase` (opens or creates); `save`/`close` look up `locateIdb(path).id` among open DBs.
2. Each DB runs in its own host daemon `omp.ida.<id>` under the project's daemon broker (`omp ps` lists, stops, and tails it). The host is an omp worker that holds the IDB lock and one long-lived Python worker (idalib allows one DB per process), and serves NDJSON on a Unix socket / named pipe in the broker runtime dir. `acquireIdaDatabase` attaches to a running host or asks the broker to start one, then waits for the open; concurrent callers share one open, and aborting a caller only stops its wait (idalib ignores SIGINT while opening).
3. Starting a host beyond `ida.maxOpen` (default 4) hosts in the project first saves and closes the least recently used idle one; when every host is busy the open fails with `IDA database limit reached`.
4. Requests from every omp process are serialized per DB in the host. The request timeout covers the queue wait: a request still queued at its deadline fails with `IDA <id> busy: <method> running for <n>s` without interrupting the running request.
5. Timeouts/aborts of a running request send SIGINT; the worker gets 5 s to respond, then it is SIGKILLed. An abort cancels only that caller's request.

## `exec` namespace
Persistent per DB and shared by all agents. Preloaded: `db` (ida_domain `Database`), `ida_domain`, `ida_bytes`, `ida_funcs`, `ida_name`, `ida_typeinf`, `ida_hexrays`, `ida_segment`, `ida_xref`, `ida_ua`, `ida_nalt`, `ida_auto`, `ida_lines`, `ida_loader`, `idautils`, and helpers (targets accept name, `0x` string, or int ea):
- `resolve`, `func`, `name_of`, `pseudocode`, `asm`
- `xrefs_to`, `xrefs_from`, `callers`, `callees`
- `functions(pattern)`, `strings(pattern)`, `imports(pattern)` — optional case-insensitive regex
- `hexdump(t, size=64)`, `read_bytes(t, size)`
- `rename`, `comment`, `set_type`, `make_function` — same implementations as the RPC actions
- `help_ida()` — one line per helper

## Side Effects
- Executables are copied into the IDB store dir; the original binary is never modified. `.i64`/`.idb` open in place.
- Universal (fat) Mach-O: only the selected slice is staged, so IDA analyzes a thin binary. Default slice is the first matching the host CPU (else the first); `:@<arch>` (lipo names, e.g. `x86_64`, `arm64e`; unnamed subtypes as `<family>.<subtype>`) picks another. Each slice gets its own store IDB.
- Changes persist on `save`, `close` (saves by default), idle autosave, idle close, LRU eviction, `omp ps stop`, and omp process exit (each process flushes the DBs it attached to). The worker tracks mutations via IDB/Hex-Rays hooks and reports `dirty` on each response; a dirty DB autosaves 10 s after its queue drains. A new DB is saved by its first autosave. On SIGTERM the host closes the worker, saving when it has hook-tracked changes or ran `exec` since the last save.
- Hosts are non-persistent broker daemons: they stop (SIGTERM, 2 s grace) when the broker idles out after the project's last omp process exits. `omp ps kill` gives 100 ms, so unflushed changes are lost.
- DBs idle for `ida.idleCloseSec` (default 900, `0` = never) are saved and closed and their host exits; reopening resets the `exec` namespace.
- DBs are not tied to session disposal; they outlive compaction and subagents.
- Each host holds the IDB's file lock; a host in another project opening the same IDB fails with `IDB <id> is in use by another omp process outside this project`.

## Errors
- `No IDA database open; pass db=<binary path>` / `Multiple IDA databases open (…); pass db`
- `db not found: <ref>` / `<ref> is not open`
- `no <arch> slice; available: …` / `<path> is not a universal binary; drop :@<arch>`
- `<field> is required for <action>`
- IDA unavailable (no interpreter imports `ida_domain` + `idapro`): install ida-domain or set `ida.python`.
- `IDA database limit reached (<n> open, all busy: …)` — close one or raise `ida.maxOpen`.
- `IDA <id> busy: …` — the queue ahead did not drain within the request timeout.
- `IDA host <name> exited; see \`omp ps logs <name>\`` — the host died mid-request.
- Worker killed after an ignored interrupt: changes since the last save are lost.
