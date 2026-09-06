# write

> Create or overwrite a file, writable internal resource, archive entry, SQLite row, or merge-conflict resolution.

## Source
- Entry: `packages/coding-agent/src/tools/write.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/write.md`
- Key collaborators:
  - `packages/utils/src/ar` (`@oh-my-pi/pi-utils/ar`) — unified archive registry: `parseArchivePathCandidates()` parses archive selectors, `readArchiveEntries()`/`writeArchive()` rewrite containers atomically.
  - `packages/coding-agent/src/tools/sqlite-reader.ts` — detect SQLite paths and perform row insert/update/delete.
  - `packages/coding-agent/src/tools/conflict-detect.ts` — parse `conflict://` URIs, register/validate regions, and expand side tokens.
  - `packages/coding-agent/src/internal-urls/router.ts` / `packages/coding-agent/src/tools/xdev.ts` — writable internal resources and `xd://` tool-device dispatch.
  - `packages/coding-agent/src/lsp/index.ts` — format-on-write and diagnostics writethrough.
  - `packages/coding-agent/src/tools/auto-generated-guard.ts` — block overwriting generated files.
  - `packages/coding-agent/src/tools/fs-cache-invalidation.ts` — invalidate shared FS scan caches after writes.
  - `packages/coding-agent/src/tools/plan-mode-guard.ts` — resolve paths and enforce plan-mode write policy.

## Inputs
| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | `string` | Yes | Target path. Plain paths write files. Writable internal URLs delegate to their handler. `xd://<device>` dispatches a mounted tool using JSON in `content`. `archive.ext:inner/path` writes an archive entry for `.zip` and ZIP-format aliases (`.jar`, `.war`, `.ear`, `.apk`, …), `.tar`, `.tar.gz`/`.tgz`, `.tar.zst`/`.tzst`, or `.asar`. `db.sqlite:table` inserts a row; `db.sqlite:table:key` updates/deletes one. `conflict://<id>` resolves a registered conflict and `conflict://*` performs a bulk resolution. A copied `[path#TAG]` wrapper is accepted and removed. |
| `content` | `string` | Yes | Full replacement file/archive/internal-resource content, conflict replacement, or SQLite row payload. SQLite non-delete writes must parse as a JSON5 object; empty or whitespace-only content deletes a keyed row. For `xd://`, this is the mounted tool's JSON argument object. |

Worked examples:

```text
path: "src/generated/config.json"
content: "{\n  \"enabled\": true\n}\n"
```

```text
path: "fixtures/archive.zip:templates/email.txt"
content: "hello\n"
```

```text
path: "data/app.sqlite:users:42"
content: "{name: 'Ada', active: true}"
```

## Outputs
Single-shot result.

- Success always returns at least one text block, except that an `xd://` dispatch preserves the mounted tool's own content/error result.
  - Plain file write: `Successfully wrote <chars> bytes to <relative-path>` (the count is `cleanContent.length`, not encoded byte length).
  - Internal URL write: `Successfully wrote <chars> bytes to <url>`.
  - Archive write: `Successfully wrote <chars> bytes to <relative-archive-path>:<entry-path>`.
  - SQLite write: one of `Inserted row into <table>`, `Updated row '<key>' in <table>`, `No row updated ...`, `Deleted row ...`, `No row deleted ...`.
  - Conflict resolution: conflict-specific success text, with fresh hashline snapshot headers when applicable. Bulk resolution can return `isError: true` after some files succeeded and others failed.
- During execution, `onUpdate` may emit `Writing <chars> bytes to <path>...`; `xd://` forwards the mounted tool's updates.
- If hashline prefixes were copied from `read` output and stripped first, the first text block gets an extra note.
- In hashline display mode, plain file writes (including ACP bridge writes) and conflict resolutions prepend a fresh `[<relative-path>#TAG]` header so the next `edit` has a current snapshot tag without an extra `read`. Bulk conflict resolutions append a `Snapshots:` block listing one header per successfully written file.
- Plain file writes may also return `details.diagnostics` plus `details.meta.diagnostics` when LSP diagnostics-on-write is enabled, and `details.madeExecutable` when a newly written shebang file is chmodded executable.
- Plain/archive/conflict results set `details.resolvedPath` when backed by a file. SQLite writes additionally set `details.meta.source` to the database file through `sourcePath(...)`. Internal URL writes return empty `details`; device dispatch sets `details.xdev`.

## Flow
1. `WriteTool.execute()` unwraps a copied `[path#TAG]` argument and peels a valid read selector from internal URLs so write and read address the same resource. Malformed/range selectors on writable URLs are rejected.
2. In hashline display mode it strips pasted `[PATH#HASH]` headers and `LINE:` prefixes from `content`.
3. It validates URI-like targets. Unknown schemes and common `xd://` misspellings fail instead of becoming local filenames; prefix with `./` to deliberately create a URI-looking POSIX filename.
4. If `path` is an internal URL whose handler exposes `write`, the tool delegates to it. `xd://` validates and dispatches JSON to the mounted tool while preserving its result and approval tier; `local://` falls through to the session-local filesystem path.
5. `conflict://...` is handled next. Scope reads such as `conflict://<id>/ours` are read-only; writable conflict URIs omit the scope. Registered on-disk markers are revalidated before replacement.
6. It calls `#resolveArchiveWritePath()`. Candidate archive files are checked longest-first; when none exists, the shortest candidate archive path is used for creating a new container.
7. Archive writes call `enforcePlanModeWrite(..., { op: exists ? "update" : "create" })`, then `#writeArchiveEntry()`.
   - The parent directory is created recursively.
   - Existing entries are loaded through `readArchiveEntries()`, the target is replaced in the entry map, and `writeArchive()` serializes a complete replacement.
   - The replacement is written to a sibling temporary path and renamed over the destination. Existing archive symlinks are resolved first so the target is updated rather than replacing the symlink.
   - ZIP-format aliases remain ZIP. Tar gzip compression is selected for `.tar.gz`/`.tgz`, zstd for `.tar.zst`/`.tzst`; `.asar` containers are rewritten through the same boundary. Read-only formats (`.7z`, `.rar`, …) are rejected.
   - `invalidateFsScanAfterWrite()` runs on the archive file path.
8. If not an archive, it tries SQLite candidates. Existing non-SQLite files suppress SQLite interpretation.
9. SQLite writes call `enforcePlanModeWrite(..., { op: "update" })`, then `#writeSqliteRow()`.
   - The database must already exist.
   - It opens Bun SQLite with `{ create: false, strict: true }` and `PRAGMA busy_timeout = 3000`.
   - Whitespace-only `content` with a row key deletes a row.
   - Non-empty `content` is parsed with `Bun.JSON5.parse()`, must be an object, and is routed to insert/update helpers.
   - The scan cache is invalidated and the connection closes in `finally`.
10. Otherwise it treats `path` as a plain filesystem file.
   - It rejects high-confidence mis-dispatched read targets: a missing selector-shaped filename with empty content, or a missing semicolon-joined list of selector paths. Existing literal paths win; non-empty content is the escape hatch for a single deliberate selector-shaped filename.
   - Plan-mode policy and path resolution run before mutation. Existing files pass the generated-file guard.
   - ACP bridge `writeTextFile` is tried first when available; otherwise the session writethrough writes the content. LSP settings may format, synchronize, and diagnose the write.
   - A leading shebang may add execute bits. The filesystem scan cache is invalidated.
11. The tool returns text plus optional diagnostics, executable, resolved-path, or device-dispatch metadata.

## Modes / Variants
### Plain file path
- Target is any path that does not resolve as an archive selector and does not resolve as an existing-or-new SQLite selector.
- Existing files are overwritten.
- `write.ts` does not call `fs.mkdir()` on this path; explicit parent-directory creation only exists in the archive branch, but `Bun.write()` itself creates missing parent directories for plain file writes.

Example:

```text
path: "tmp/output.txt"
content: "hello\n"
```

### Archive entry write
- Selector syntax: `archive.ext:inner/path`.
- Supported suffixes: `.zip` and ZIP-format aliases (`.jar`, `.war`, `.ear`, `.apk`, and the other zip-family extensions), `.tar`, `.tar.gz`/`.tgz`, `.tar.zst`/`.tzst`, and `.asar`.
- The inner path is normalized to `/`, strips empty and `.` segments, rejects `..`, and rejects directory targets ending in `/`.
- Rewrites the whole archive through a temporary file and rename after replacing one entry.
- Creates the parent directory for the archive file if needed.

Example:

```text
path: "build/assets.tar.gz:css/app.css"
content: "body { color: black; }\n"
```

### SQLite table insert
- Selector syntax: `db.sqlite:table`.
- `content` must parse as a JSON5 object.
- Empty object is allowed and becomes `INSERT INTO <table> DEFAULT VALUES`.
- Query parameters are rejected for SQLite writes.

Example:

```text
path: "data/app.db:users"
content: "{name: 'Ada', active: true}"
```

### SQLite row update / delete
- Selector syntax: `db.sqlite:table:key`.
- Non-empty `content` updates the row.
- Empty or whitespace-only `content` deletes the row.
- Row lookup uses the single-column primary key if present; otherwise it falls back to `rowid`. Composite primary keys and `WITHOUT ROWID` tables are rejected for key-based writes.

Example update:

```text
path: "data/app.sqlite:users:42"
content: "{email: 'ada@example.com'}"
```

Example delete:

```text
path: "data/app.sqlite:users:42"
content: ""
```

### Writable internal resources and tool devices
- A registered internal handler with a `write` hook owns its resource semantics (for example, `vault://`). `local://` is instead resolved into the session-local artifact sandbox and follows the plain-file path.
- `xd://` lists/dispatches tool devices mounted behind `write`. Read `xd://<name>` first for its generated input documentation, then pass one JSON object as `content`. The device's own schema, updates, result blocks, error flag, renderer metadata, and approval tier are preserved.
- Unknown URI-like schemes are refused to prevent silent local-file creation. Use `./scheme://...` only when that filename is intentional.

### Merge-conflict resolution
- First read `<file>:conflicts`; this registers session-stable ids. `conflict://<N>` replaces only that recorded marker block and rejects stale/missing regions.
- A line exactly equal to `@ours`, `@theirs`, `@base`, or `@both` expands to the recorded side (`@both` is ours then theirs). `@base` requires a diff3 base. Other content is literal.
- `conflict://*` with ordinary content applies the same replacement/token expansion to every registered conflict. Per-id directive content such as `1: @ours\n2: @theirs` resolves only the listed ids; every non-empty directive line must use one side token and ids may not repeat.
- Bulk processing is all-or-nothing per file, applied bottom-up. Other files can still succeed; partial cross-file success returns `isError: true`, while an all-failed pass throws. Successful ids are invalidated and failed-file ids remain registered for retry.
- `/ours`, `/theirs`, `/base`, and `/both` URI scopes are read-only.


## Side Effects
- Filesystem
  - Creates or overwrites plain files.
  - Rewrites entire archive files atomically through a temporary sibling and rename when writing an entry.
  - Explicitly creates parent directories for archive files; the plain-file backend also supports missing parents.
  - Mutates existing SQLite databases; never creates a new SQLite DB.
  - Resolves conflict markers in files for `conflict://...` writes.
  - May chmod a shebang file executable after a successful plain-file write.
- Subprocesses / native bindings
  - Uses Bun SQLite bindings via `bun:sqlite`.
  - Uses the unified archive utilities in `packages/utils/src/ar`: tar serialization plus gzip/zstd framing for compressed tars, `node:zlib`-backed DEFLATE framing for ZIP, and an ASAR encoder.
  - May talk to configured LSP servers through `packages/coding-agent/src/lsp/index.ts`.
- Session state
  - Invalidates shared filesystem scan cache entries through `invalidateFsScanAfterWrite()`.
  - Enforces plan-mode write restrictions before mutating the target.
  - Updates file mutation/snapshot state for plain files and conflict resolutions; resolved conflict ids are invalidated.
  - `xd://` dispatches a mounted tool and may therefore have that tool's documented side effects.
- Background work / cancellation
  - Marks the tool `concurrency = "exclusive"` in `WriteTool`.
  - The write body is wrapped with `untilAborted`; LSP writethrough can schedule deferred diagnostics fetches after a timeout.

## Limits & Caps
- Plain/internal file content has no tool-level byte cap beyond in-memory handling. Archive rewrites inherit archive utility caps: tar/tgz input `256 MiB`, each existing member `64 MiB`, and ZIP output must fit non-ZIP64 32-bit entry/count/offset limits.
- Generated-file detection reads at most `CHECK_BYTE_COUNT = 1024` bytes and `HEADER_LINE_LIMIT = 40` header lines from an existing file in `packages/coding-agent/src/tools/auto-generated-guard.ts`.
- SQLite writes set `PRAGMA busy_timeout = 3000`.
- LSP writethrough uses a `5_000` ms operation timeout in `runLspWritethrough()` and may schedule a deferred diagnostics fetch with `AbortSignal.timeout(25_000)` in `scheduleDeferredDiagnosticsFetch()`.
- Shebang executable handling depends on host filesystem chmod support.

## Errors
- Invalid archive subpaths throw `ToolError` with messages such as:
  - `Archive write path must target a file inside the archive`
  - `Archive write path must target a file, not a directory`
  - `Archive path cannot contain '..'`
- SQLite path parsing throws on unsupported forms:
  - `SQLite write paths do not support query parameters`
  - `SQLite write path must target a table`
  - `SQLite row writes require a non-empty row key`
- Missing SQLite DBs surface as `SQLite database '<path>' not found`.
- SQLite content errors include invalid JSON5, non-object payloads, unknown columns, non-scalar values, empty update objects, composite primary keys, and `WITHOUT ROWID` key lookups.
- Existing plain files may be rejected by `assertEditableFile()` when they look generated.
- URI-like unknown targets and malformed/missing `xd://` devices fail rather than writing local files; mounted devices surface their own schema/tool errors.
- Empty writes to missing selector-shaped targets and semicolon-joined selector lists are rejected as likely read/write mis-dispatches.
- Conflict scope writes are read-only; invalid/stale ids, malformed bulk directives, missing `@base`, and stale marker locations surface `ToolError`.
- Archive read/write failures and unexpected SQLite exceptions are wrapped in `ToolError(error.message)`.
- If no LSP server matches or LSP formatting/diagnostics times out, file writes still complete; diagnostics may be omitted.

## Notes
- Archive path detection runs before SQLite detection. A path that matches an archive selector is never treated as SQLite.
- SQLite detection declines when an existing file with a `.sqlite` / `.db` suffix lacks SQLite magic bytes; the path falls back to a plain file write.
- Archive rewriting uses the unified `readArchiveEntries()` / `writeArchive()` boundary and a temp-file rename. String members are encoded as UTF-8.
- The prompt forbids two common anti-patterns: using `write` for routine edits that should use `edit`, and creating `*.md` / `README` files unless explicitly requested. It also forbids emojis unless requested.
- Plain file and internal URL writes report `cleanContent.length` as “bytes”, which is UTF-16 code units in JS, not an on-disk byte measurement.
- `stripWriteContent()` only removes hashline prefixes when the session’s file display mode has `hashLines` enabled; otherwise content is written unchanged.

- The tool has `strict = true`, `loadMode = "essential"`, and exclusive concurrency. Its renderer shows a 12-line streaming preview and a 6-line completed preview by default; `xd://` results delegate rendering to the mounted device.