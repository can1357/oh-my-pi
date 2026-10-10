# write

> Create or overwrite a file, writable internal resource, archive entry, SQLite row, or merge-conflict resolution.

## Source
- Entry: `packages/coding-agent/src/tools/write.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/write.md`
- Key collaborators:
  - `packages/utils/src/ar` (`@oh-my-pi/pi-utils/ar`) — archive selector parsing, member loading, and serialization; the write tool supplies the atomic temp-file/rename boundary.
  - `packages/coding-agent/src/tools/sqlite-reader.ts` — detect SQLite paths and perform row insert/update/delete.
  - `packages/coding-agent/src/tools/conflict-detect.ts` / `conflict-uri.ts` — register/validate conflict regions, expand side tokens, and resolve writes through the internal URL handler.
  - `packages/coding-agent/src/internal-urls/router.ts` / `packages/coding-agent/src/tools/xdev.ts` — writable internal resources and `xd://` tool-device dispatch.
  - `packages/coding-agent/src/lsp/writethrough.ts` — format-on-write and diagnostics writethrough.
  - `packages/coding-agent/src/tools/auto-generated-guard.ts` — block overwriting generated files.
  - `packages/coding-agent/src/tools/fs-cache-invalidation.ts` — invalidate shared FS scan caches after writes.
  - `packages/coding-agent/src/tools/plan-mode-guard.ts` — resolve paths and enforce plan-mode write policy.

## Inputs
| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | `string` | Yes | Target path. Plain paths write files. Writable internal URLs delegate to their handler. `xd://<device>` dispatches a mounted tool using JSON in `content`. `archive.ext:inner/path` writes an archive entry for `.zip` and ZIP-format aliases (`.jar`, `.war`, `.ear`, `.apk`, …), `.tar`, `.tar.gz`/`.tgz`, `.tar.zst`/`.tzst`, or `.asar`. `db.sqlite:table` inserts a row; `db.sqlite:table:key` updates/deletes one. `conflict://<id>` resolves a registered conflict and `conflict://*` performs a bulk resolution. A copied `[path#TAG]` wrapper is accepted and removed. |
| `content` | `string` | Except `proc://<id>/kill` | Full replacement file/archive/internal-resource content, conflict replacement, or SQLite row payload. Ignored for `/kill`. SQLite non-delete writes must parse as a JSON5 object; empty or whitespace-only content deletes a keyed row. For `xd://`, this is the mounted tool's JSON argument object. |

Worked examples:

```text
path: "src/config.json"
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
  - Plain file write: `Successfully wrote <bytes> bytes to <relative-path>` (UTF-8 byte length of the final formatted content; the ACP bridge receipt counts the submitted content).
  - Internal URL write: handler-provided receipt/status text when present; otherwise `Successfully wrote <bytes> bytes to <url>`. File-backed URL writes (`local://`, `vault://`) name the URL too, never the backing path.
  - Archive write: `Successfully wrote <bytes> bytes to <relative-archive-path>:<entry-path>` (UTF-8 member-content size).
  - SQLite write: one of `Inserted row into <table>`, `Updated row '<key>' in <table>`, `No row updated ...`, `Deleted row ...`, `No row deleted ...`.
  - Conflict resolution: conflict-specific success text, with fresh hashline snapshot headers when applicable. Bulk resolution can return `isError: true` after some files succeeded and others failed.
- During execution, `onUpdate` may emit `Writing <bytes> bytes to <path>...` using UTF-8 byte length; `xd://` forwards the mounted tool's updates.
- If hashline prefixes were copied from `read` output and stripped first, the first text block gets an extra note.
- In hashline display mode, plain file writes (including ACP bridge writes) and conflict resolutions prepend a fresh `[<relative-path>#TAG]` header (`[<url>#TAG]` for file-backed URL writes). The snapshot has no seen-line provenance: anchored edits still need to read their anchor lines. Bulk conflict resolutions append a `Snapshots:` block listing one header per successfully written file.
- Plain file writes may also return `details.diagnostics` plus `details.meta.diagnostics` when LSP diagnostics-on-write is enabled, and `details.madeExecutable` when a shebang file gains execute bits.
- Plain/archive/single-conflict results set `details.resolvedPath` when backed by a file. SQLite writes additionally set `details.meta.source` through `sourcePath(...)`. Handler-owned URL writes preserve handler details (for example `details.proc`); generic handler receipts use empty details and device dispatch sets `details.xdev`.

## Flow
1. `WriteTool.execute()` unwraps a copied `[path#TAG]` argument and peels a valid read selector from internal URLs so write and read address the same resource. Malformed/range selectors on writable URLs are rejected.
2. It requires `content` unless the target's write policy makes it optional (`proc://<id>/kill`). Device-only sessions allow device/coordination writes and, in active plan mode, local sandbox drafts; other targets fail before mutation. Hashline display prefixes are stripped from text payloads, but messages, process input, settings, and conflict directives reach their handlers verbatim.
3. It validates URI-like targets. Unknown schemes and common `xd://` misspellings fail instead of becoming local filenames; prefix with `./` to deliberately create a URI-looking POSIX filename.
4. If `path` is an internal URL whose handler exposes `write`, the tool delegates to it. `xd://` validates and dispatches JSON to the mounted tool while preserving its result and approval tier; `local://` falls through to the session-local filesystem path.
5. `conflict://...` is one of those handler-owned writes, implemented by `ConflictProtocolHandler` and `tools/conflict-uri.ts`. Scope reads such as `conflict://<id>/ours` are read-only; writable conflict URIs omit the scope. Registered markers are revalidated before replacement.
6. It calls `#resolveArchiveWritePath()`. Candidate archive files are checked longest-first; when none exists, the shortest candidate archive path is used for creating a new container.
7. Archive writes call `enforcePlanModeWrite(..., { op: exists ? "update" : "create" })`, then `#writeArchiveEntry()`.
   - The parent directory is created recursively.
   - Existing entries are loaded through `readArchiveEntries()`, the target is replaced in the entry map, and `writeArchive()` serializes a complete replacement.
   - Empty writes to missing selector-shaped members are refused. Replacing an existing text member with an incomplete read projection is also refused.
   - The replacement is written to a sibling temporary path and renamed over the destination. Existing archive symlinks are resolved first so the target is updated rather than replacing the symlink.
   - ZIP-format aliases remain ZIP. Tar gzip compression is selected for `.tar.gz`/`.tgz`, zstd for `.tar.zst`/`.tzst`; `.asar` containers are rewritten through the same boundary. Read-only formats (`.7z`, `.rar`, …) are rejected.
   - `invalidateFsScanAfterWrite()` runs on the archive file path.
8. If not an archive, it tries SQLite candidates. Existing non-SQLite files suppress SQLite interpretation; candidates that are neither regular files nor directories (FIFO, device, socket) are rejected before the SQLite header is read.
9. SQLite writes call `enforcePlanModeWrite(..., { op: "update" })`, then `#writeSqliteRow()`.
   - The database must already exist.
   - It opens Bun SQLite with `{ create: false, strict: true }` and `PRAGMA busy_timeout = 3000`.
   - Whitespace-only `content` with a row key deletes a row.
   - Non-empty `content` is parsed with `Bun.JSON5.parse()`, must be an object, and is routed to insert/update helpers.
   - The scan cache is invalidated and the connection closes in `finally`.
10. Otherwise it treats `path` as a plain filesystem file.
   - It rejects high-confidence mis-dispatched read targets: a missing selector-shaped filename with empty content, or a missing semicolon-joined list of selector paths. Existing literal paths win; non-empty content is the escape hatch for a single deliberate selector-shaped filename.
   - Plan-mode policy and path resolution run before mutation. An existing target that is neither a regular file nor a directory (including through a symlink) is refused; existing regular files then pass the generated-file guard, which opens and reads the file head on the main thread and could block forever on such a target.
   - If submitted content ends in an OMP read-truncation notice and covers less than the current source, the overwrite is refused. This also applies to text handler-owned resources; tool-device arguments are exempt.
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
- Row lookup uses a single-column primary key when present, including on `WITHOUT ROWID` tables. Otherwise it falls back to `rowid`. Composite primary keys and unavailable rowid fallbacks are rejected.

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
- `agent://<id>` with non-empty `content` sends a message to that peer (delivery receipt text); `agent://all` broadcasts to visible live peers. This write is read-approved and allowed in plan mode and `deviceOnlyWrite` when messaging is available. `agent://` reads remain output artifacts.
- `proc://<id>` sends `content` to service stdin (Enter appended unless already newline-terminated); empty content sends Enter, never cancels. `write({ path: "proc://<id>/kill" })` cancels a job or owned subagent, or stops a service; `content` is optional and ignored. `proc://<id>/mode` requires `content` of `persist` or `session` to toggle persistence, or `detached` to restart without a PTY and persist beyond the broker. Proc writes require exec approval. Stdin and `/mode` writes are blocked in plan mode and unavailable in `deviceOnlyWrite` sessions; `/kill` is allowed in both. Proc reads do not consume job delivery. `/kill` and `/mode` are write-only.
- A registered internal handler with a `write` hook owns its resource semantics (for example, `cfg://`, `agent://`, `proc://`). File-backed schemes (`local://`, `vault://`) have no hook: the router locates the target file (`local://` in the session-local artifact sandbox, `vault://` under the vault root) and the write follows the plain-file path.
- `xd://` lists/dispatches tool devices mounted behind `write`. Read `xd://<name>` first, then pass one JSON object as `content`. Device schema, updates, result blocks, error flag, renderer metadata, and approval tier are preserved. The outer approval gate uses `tools.approval.<device>` before the generic `write` policy. `xd://report_issue` separately accepts a plain issue description.
- Unknown URI-like schemes are refused to prevent silent local-file creation. Use `./scheme://...` only when that filename is intentional.
- Registered read-only schemes (no write policy: `artifact://`, `skill://`, `history://`, …) are denied at the approval gate (`<scheme>:// URLs are read-only`) without prompting; `edit` and `ast_edit` targets are denied the same way. A trailing line selector on a write, edit, or bash URL target (`local://notes.md:5`) is refused rather than dropped; only `:raw`/`:conflicts` are peeled.

### Merge-conflict resolution
- Read `<file>:conflicts` (or a read window surfacing markers) to register session-stable ids. `conflict://<N>` replaces only that recorded marker block and revalidates it against the file. Copied adjacent context is trimmed when it would duplicate lines outside the block, with a receipt note.
- A line exactly equal to `@ours`, `@theirs`, `@base`, or `@both` expands to the recorded side (`@both` is ours then theirs). `@base` requires a diff3 base. Other content is literal.
- `conflict://*` with ordinary content applies the same replacement/token expansion to every registered conflict. Per-id directive content such as `1: @ours\n2: @theirs` resolves only the listed ids; every non-empty directive line must use one side token and ids may not repeat.
- Bulk processing is all-or-nothing per file, applied bottom-up. Other files can still succeed; partial cross-file success returns `isError: true`, while an all-failed pass throws. Successful ids are invalidated and failed-file ids remain registered for retry.
- Conflict writes bypass LSP formatting/diagnostics while markers remain. Stale duplicate registrations of a region resolved in the same bulk pass are treated as already resolved; distinct identical blocks remain addressable.
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
- Plain/internal file content has no tool-level byte cap beyond in-memory handling. Archive readers default to `256 MiB` in-memory input and `64 MiB` per member. ZIP output emits ZIP64 records for large entry counts, but member sizes and central-directory/member offsets remain below the 32-bit sentinel.
- The generated-file guard delegates to `editAutoGeneratedMessage` in `crates/pi-natives/src/edit.rs`, reading at most `1024` bytes; `crates/pi-edit/src/path_policy.rs` checks at most `40` header lines. `edit.blockAutoGenerated` controls the guard.
- SQLite writes set `PRAGMA busy_timeout = 3000`.
- LSP writethrough (`packages/coding-agent/src/lsp/writethrough.ts`) uses a `5_000` ms operation timeout in `runLspWritethrough()` and may schedule deferred diagnostics with `AbortSignal.timeout(25_000)`.
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
- SQLite content errors include invalid JSON5, non-object payloads, unknown columns, non-scalar values, empty update objects, composite primary keys, and unavailable rowid fallbacks. Read-style `?where=` selectors are not a write workaround.
- Existing plain files may be rejected by `assertEditableFile()` when they look generated.
- Existing plain-file targets and SQLite database candidates that are neither regular files nor directories are refused with `Cannot write '<path>': it is a <kind>, not a regular file or directory.` Opening or reading them in-process can block forever (a FIFO with no writer, a terminal).
- A file-backed URL write whose target is an existing directory fails with `<scheme>:// URL must resolve to a file: <url>`.
- URI-like unknown targets and malformed/missing `xd://` devices fail rather than writing local files; mounted devices surface their own schema/tool errors.
- Empty writes to missing selector-shaped targets and semicolon-joined selector lists are rejected as likely read/write mis-dispatches.
- Incomplete read projections that would discard unseen source are rejected; re-read omitted ranges and replace the whole file, or use `edit` for a partial change.
- Conflict scope writes are read-only; invalid/stale ids, malformed bulk directives, missing `@base`, and stale marker locations surface `ToolError`.
- Archive read/write failures and unexpected SQLite exceptions are wrapped in `ToolError(error.message)`.
- If no LSP server matches or LSP formatting/diagnostics times out, file writes still complete; diagnostics may be omitted.

## Notes
- Archive path detection runs before SQLite detection. A path that matches an archive selector is never treated as SQLite.
- SQLite detection declines when an existing file with a `.sqlite` / `.db` suffix lacks SQLite magic bytes; the path falls back to a plain file write.
- Archive rewriting uses the unified `readArchiveEntries()` / `writeArchive()` boundary and a temp-file rename. String members are encoded as UTF-8.
- For an existing archive symlink, the writer infers format from the resolved target's suffix, falling back to uncompressed tar when that suffix is unknown; the selector's suffix does not override this.
- The prompt forbids two common anti-patterns: using `write` for routine edits that should use `edit`, and creating `*.md` / `README` files unless explicitly requested. It also forbids emojis unless requested.
- Generic write receipts count UTF-8 bytes with `Buffer.byteLength(...)`; handler-owned receipts define their own content/status wording.
- `stripWriteContent()` only removes hashline prefixes when the session’s file display mode has `hashLines` enabled; otherwise content is written unchanged.

- The tool has `strict = true`, `loadMode = "essential"`, and exclusive concurrency. The native transcript view previews the first 8 content lines; `xd://` results delegate rendering to the mounted device.