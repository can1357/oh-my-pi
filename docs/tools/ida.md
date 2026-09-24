# ida

> Open, edit, and script IDA Pro (idalib) databases held in a process-wide registry shared by every agent in the omp process.

## Source
- Entry: `packages/coding-agent/src/tools/ida.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/ida.md`
- Key collaborators:
  - `packages/coding-agent/src/ida/settings.ts` — `ida.enabled`, `ida.python`, `ida.installDir` settings
  - `packages/coding-agent/src/ida/install.ts` — local install detection (`cfgIdaAvailable`, `cfgIdaInstall`)
  - `packages/coding-agent/src/ida/runtime.ts` — Python interpreter discovery (must import `ida_domain` + `idapro`)
  - `packages/coding-agent/src/ida/store.ts` — executable sniffing, universal Mach-O slice selection, IDB location (`~/.omp/agent/idbs/<sha16>-<name>[.<arch>]/` or in place)
  - `packages/coding-agent/src/ida/supervisor.ts` — per-DB Python worker process, NDJSON RPC, registry, save-on-exit
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
- `list`: one line per DB — `id  module  format  arch/bitness  idbPath`, or `No IDA databases open.`
- `open`: `Opened <id> (<module>, <format>, <arch> <bitness>-bit) → <idb>. read <source> for the overview.`
- `save` / `close`: `Saved <idb>` / `Closed <id> (saved | discarded unsaved changes)`.
- Edits: one line, e.g. `Renamed 0x401000 sub_401000 → parse_header`.
- `exec`: captured stdout/stderr, then `=> <repr>` of the last expression, then the traceback on failure (`isError: true`). Text passes through `enforceInlineByteCap`; overflow is saved as an `ida` artifact.
- `details`: `{ action, db?: <id> }`. No custom renderer.

## Flow
1. `#resolveDb`: omitted `db` → the single open DB; an open id → that DB; otherwise the path must be a file. Mutating actions and `exec` call `acquireIdaDatabase` (opens or creates); `save`/`close` look up `locateIdb(path).id` among open DBs.
2. Each DB runs in its own long-lived Python worker (idalib allows one DB per process). Requests are serialized per DB.
3. Timeouts/aborts send SIGINT; the worker gets 5 s to respond, then it is SIGKILLed.

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
- Changes persist only on `save`, `close` (saves by default), or omp process exit (postmortem closes every DB with save).
- DBs are not tied to session disposal; they outlive compaction and subagents.
- Each DB holds a file lock; another omp process opening the same IDB fails.

## Errors
- `No IDA database open; pass db=<binary path>` / `Multiple IDA databases open (…); pass db`
- `db not found: <ref>` / `<ref> is not open`
- `no <arch> slice; available: …` / `<path> is not a universal binary; drop :@<arch>`
- `<field> is required for <action>`
- IDA unavailable (no interpreter imports `ida_domain` + `idapro`): install ida-domain or set `ida.python`.
- Worker killed after an ignored interrupt: changes since the last save are lost.
