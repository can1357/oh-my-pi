# Blob and artifact storage architecture

This document describes how coding-agent stores large/binary payloads outside session JSONL, how truncated tool output is persisted, and how internal URLs (`local://N.log` spills, `agent://`) resolve back to stored data.

## Why two storage systems exist

The runtime uses two different persistence mechanisms for different data shapes:

- **Content-addressed blobs** (`blob:sha256:<hash>`): global storage used to externalize image base64 payloads, preserved image/frame archives, generated-image results, and provider image data URLs from persisted session entries.
- **Session-scoped artifacts** (files under `<sessionFile-without-.jsonl>/`): per-session text files used for subagent outputs and, in the `local/` subdirectory (the session's `local://` root), for full tool outputs (spills).

They are intentionally separate:

- blob storage optimizes deduplication and stable references by content hash,
- artifact storage optimizes append-only session tooling and human/tool retrieval by local IDs.

## Storage boundaries and on-disk layout

### Blob store boundary (global)

`SessionManager` constructs `BlobStore(getBlobsDir())`, so blob files live in a shared global blob directory, not in a session folder.

Blob file naming:

- file path: `<blobsDir>/<sha256-hex>`
- canonical file has no extension; when a valid extension is supplied (image MIME type), a typed sidecar `<sha256-hex>.<ext>` is hardlinked or copied next to it so OS openers can type-detect
- reference string stored in entries: `blob:sha256:<sha256-hex>`, where the hash must be exactly 64 lowercase hexadecimal characters

Implications:

- same binary content across sessions resolves to the same hash/path,
- writes are idempotent at the content level,
- blobs can outlive any individual session file.

## Artifact boundary (session-local)

`ArtifactManager` derives artifact directory from session file path:

- session file: `.../<timestamp>_<sessionId>.jsonl`
- artifacts directory: `.../<timestamp>_<sessionId>/` (strip `.jsonl`)

Artifact types live in this directory:

- spill files (truncated tool output, shaped/spotlight originals, shake placeholders, minimized bash raw output, async job output): `<numericId>.log` in `<session-dir>/local/`, the session's `local://` root, read as `local://<numericId>.log`
- subagent output files: `<outputId>.md` (for `agent://`), directly in the session directory
- subagent session JSONL sidecars: `<outputId>.jsonl` when task execution receives an artifacts directory

The spill root is `resolveLocalRoot()`: `<session-dir>/local`, except that Windows paths of 180+ characters fall back to `$TMPDIR/omp-local/<sessionId>`. A session without a session file (`--no-session`) spills to `$TMPDIR/omp-local/<sessionId>` on disk; there are no in-memory artifacts.

Subagents adopt the parent `ArtifactManager`; parent and subagent tree share one `local://` root and one numeric spill ID space.

## ID and name allocation schemes

### Blob IDs: content hash

`BlobStore.put()` / `putSync()` computes SHA-256 over the bytes it is given and returns:

- `hash`: hex digest,
- `path`: `<blobsDir>/<hash>`,
- `displayPath`: `<blobsDir>/<hash>.<ext>` when an extension was supplied, otherwise the canonical path,
- `ref`: `blob:sha256:<hash>`.

No session-local counter is used.

### Artifact IDs: session-local monotonic integer

`ArtifactManager` creates the `local://` root lazily and scans existing `<N>.log` files on first allocation to find the maximum numeric ID, setting `nextId = max + 1`. Concurrent first allocations share the same initialization promise so they cannot reseed the counter and hand out duplicates.

Allocation behavior:

- file format: `{id}.log` (no tool type in the name; the tool type passed to `allocateOutputArtifact()` is ignored)
- IDs are sequential strings (`"0"`, `"1"`, ...)
- each id's file is claimed exclusively (`wx`) before content lands, so a model-written `7.log` at the `local://` root is skipped, never overwritten; the spill root is shared with the agent's own `local://` writes
- resume does not overwrite existing spills because the scan happens before allocation

If the root is missing, initialization creates it and allocation starts from `0`.

`ArtifactManager.save()` uses `writeArtifact()`: writes to a temporary sibling, verifies byte count, file size, and readability, then publishes atomically. Failure removes the temporary file and preserves an existing destination.

Spills are ordinary `local://` files: writable, listed, and completed like any other file there. Line-page reads of any `local://` file get the full page budget (`SchemeSpec.unspilledPages`).

### Agent output IDs (`agent://`)

`AgentOutputManager` allocates IDs from the requested name, used verbatim the first time and suffixed (`-2`, `-3`, …) only when repeated. Nested outputs use a dot-qualified parent prefix (for example `Parent.Child`). Initialization scans both `.md` outputs and `.jsonl` child-session files so resume cannot clobber either; the advisor transcript stem and pinned-HUD toggle sentinel are reserved.

## Persistence dataflow

### 1) Session entry persistence rewrite path

Before a session entry is written — incremental append (`#appendToSessionFile`) or a full-file rewrite (`#rewriteSynchronously` / `#rewriteAtomically`) — `SessionManager` serializes it through `#lineFor()`, which runs `prepareEntryForPersistence()` over the truncation pipeline.

Key behaviors:

1. **Large string truncation**: ordinary strings exceeding 500,000 characters are cut and suffixed with `"[Session persistence truncated large content]"`. Signed blocks, signature fields, redacted/encrypted reasoning, Anthropic server-tool history, and Anthropic compaction carriers are preserved verbatim for valid provider replay.
2. **Duplicate/transient field stripping**: `jsonlEvents` is removed. OpenAI Responses thinking signatures already covered by the native provider payload are omitted from the persisted copy, as is MCP `structuredContent` whose rendered output was spilled to an artifact. In-memory entries remain intact.
3. **Image externalization to blobs**:
   - image blocks in `content`, image payloads in `images[]`, snapcompact `frames[]`, and `image_generation_call.result` are externalized when not already blob refs and base64 length is at least threshold (`BLOB_EXTERNALIZE_THRESHOLD = 1024`),
   - provider-style `image_url` data URLs are externalized when they start with `data:image/` and contain `;base64,`,
   - image block `data` is stored as decoded binary bytes,
   - provider data URLs are stored as the original UTF-8 data URL string,
   - persisted values are replaced with `blob:sha256:<hash>`.

This keeps session JSONL compact while preserving recoverability.

### 2) Session load rehydration path

When opening a session (`setSessionFile`), after migrations, `SessionManager` runs `resolveBlobRefsInEntries()`.

For persisted image blocks/image payloads, generated-image results, and provider `image_url` fields with `blob:sha256:<hash>`:

- reads blob bytes from blob store,
- converts image-block bytes back to base64,
- converts provider `image_url` blobs back to the original string,
- mutates in-memory entry fields for runtime consumers.

Snapcompact preserved frames remain blob references on eager load. Context rebuilding checks stored byte sizes and resolves only frames retained by the frame budget; missing frames are dropped rather than sent to a provider as storage references.

If a blob is missing:

- image-block resolution logs a warning and keeps the original `blob:sha256:` ref string in memory,
- provider `image_url` resolution logs a warning and keeps the original ref string,
- load continues.

### 3) Tool output spill/truncation path

`OutputSink` powers streaming output in bash/python/ssh and related executors.

Behavior:

1. Every chunk is sanitized with `sanitizeWithOptionalSixelPassthrough(..., sanitizeText)` and appended to in-memory accounting.
2. Optional live `onChunk` receives sanitized pre-column-cap chunks, throttled if configured.
3. A per-line column cap or a caller-supplied bounded `inline` representation can shorten the LLM-facing buffer; artifact mirroring then keeps the complete sanitized stream. Carriage-return progress updates are normalized to line boundaries, with split CRLF collapsed.
4. When the in-memory tail buffer would exceed spill threshold (`DEFAULT_MAX_BYTES`, 50KB), sink marks output truncated and starts artifact mirroring if an artifact path is available.
5. If a file sink is opened, it first writes the current buffer, then all queued/subsequent sanitized chunks.
6. In-memory buffer is trimmed to a tail window, or to head + elision marker + tail when head retention is configured.
7. `dump()` finalizes the capture and returns `artifactId` only when no artifact I/O failure was observed. `artifactError` records the first failed operation (`open`, `write`, `flush`, or `end`) without persisting raw filesystem error text.

Practical effect:

- UI/tool return shows bounded output,
- full sanitized output (up to the artifact cap) is preserved in the spill file and referenced as `local://<id>.log` when file-backed artifact mirroring succeeded.

If artifact I/O fails, the sink stops further capture attempts, retains the existing bounded inline output, and still closes its writer. The tool's execution result is unchanged; its output metadata and terminal warning state that full output was not saved completely, without advertising the incomplete artifact as a full recovery source. `dump()` and `dispose()` share completion so concurrent finalization cannot publish success before an asynchronous write or close failure settles. Failed capture is not retried. The sink caps the artifact file at `artifactMaxBytes` (default 16 MiB; tool executors pass `tools.artifactMaxBytes`, where `0` = unbounded): it keeps a head window (`artifactHeadBytes`, default 3 MiB but at most half the cap) plus a rolling tail, joined by an `ARTIFACT TRUNCATED` notice. When the cap drops bytes, `dump()` reports them as `artifactElidedBytes`, and the output notice labels `local://<id>.log` as a head/tail sample instead of full output.

The capture warning also survives background job delivery, `wait` recovery, non-consuming `read proc://<id>` inspection, cancellation, and transcript rebuilds. Capture failures belong to individual jobs, not the aggregate report. Oversized recovery snapshots can persist the complete annotated report, including healthy jobs' results, and advertise it as a "full report" rather than a full original command log. Each source capture warning appears once in model-facing text and once on its own live or rebuilt terminal row. Individual incomplete captures are still not re-spilled and advertised as full original output.

Transcript rebuilds also read capture errors from historical per-job fields. A historical aggregate warning is retained when no job identifies its source; it is not repeated when a row already carries the same failure.

## URL access model

### `blob:` references

`blob:sha256:<hash>` is a persistence reference inside session entry payloads, not an internal URL scheme handled by the router. `SessionManager` resolves it during load. Malformed suffixes are rejected by `parseBlobRef()` before any path join, logged, and left unchanged rather than being read from the blob directory.

### `local://<id>.log` (spills)

Spills have no scheme of their own: `local://<id>.log` is handled by the ordinary `LocalProtocolHandler` over the session's `local://` root (see `src/internal-urls/local-root.ts`):

- the id is part of the file name, so the usual `local://` rules apply (listing at `local://`, completion, `write`, selectors such as `:1-30` and `:raw:1-3000`)
- resolution is pinned to the calling session's root, not searched across registered sessions
- whole-resource resolution by consumers other than `read` is capped at 1 MiB (`LOCAL_TEXT_RESOURCE_MAX_BYTES`); a larger file returns a notice pointing at bounded `read` selectors or filesystem path handling

`locate` returns the backing file path at any size without loading its bytes; `read`, search, and the bash URL filesystem go through it. The embedded shell mounts the `local://` root, which covers spills; there is no per-id mount.

Failure behavior:

- with no session available: throws `No session - local:// unavailable`,
- a missing spill reads like any missing `local://` file: `Local file not found: local://<id>.log`.

Old sessions' `artifact://N` links are not migrated and no longer resolve. `omp stats` still recognizes `artifact://N` reads recorded in old sessions.

### `agent://<id>`

Handled by `AgentProtocolHandler` over registered active session artifact directories and `<artifactsDir>/<id>.md`:

- `agent://<id>` returns markdown text; nested subagent outputs use the dotted id (`agent://Parent.Child` reads `Parent.Child.md`)
- resolution refreshes persisted agent-roster references when a calling session file is available and searches that root session's artifact directory before process-global registry directories
- `write agent://<id>` sends a peer message when IRC is available; `agent://all` is a write-only broadcast for the main agent (refused from subagents), not an output file
- a slash path is always JSON extraction: `agent://<id>/<key>/<index>/…` walks object keys and array indexes (`agent://Parent.Child/reports/0/data`)
- extraction reads the `<id>.json` sidecar when present, else parses `<id>.md`; it requires valid JSON and returns `application/json` (a string leaf is returned as `text/markdown` prose)
- an id with no `<id>.md` yet that is registered in the agent registry (the registry `write agent://<id>` delivers to) resolves to a progress document instead of an error: the agent's status, every accepted `yield` payload so far (non-terminal sections included), and its latest assistant text, read from the live session or else its retained session file. Once `<id>.md` exists it wins. JSON-path extraction on such an id throws `Output <id> is not published yet`

Failure behavior:

- if no artifact directories are registered and the id is not a registered agent: throws `No session - agent outputs unavailable`,
- if registered directories exist but none are present on disk and the id is not a registered agent: throws `No artifacts directory found`,
- an unknown id throws `Not found: <id>` followed by at most five near ids (`Did you mean: …`, fuzzy-matched against `.md` output ids and registered agents), or a pointer to `history://` when nothing is close.

Read tool integration:

- `read` supports line-range and raw selectors for non-extraction internal URL reads
- line selectors are rejected for `agent://` JSON-path extraction; extraction returns directly without pagination

## Resume, fork, and move semantics

### Resume

- `ArtifactManager` scans existing `{id}.log` files at the `local://` root once on first allocation and continues numbering.
- `AgentOutputManager` scans existing `.md` and child `.jsonl` IDs and continues name suffixing.
- `SessionManager` rehydrates blob refs to base64/data URLs on load.

### Fork

`SessionManager.fork()` creates a new session file with new session ID and `parentSession` link, then returns old/new file paths. Artifact copying is handled by `AgentSession.fork()`:

- flushes current session first,
- attempts recursive copy of old artifact directory (spills included) to new artifact directory,
- missing old directory is tolerated,
- non-ENOENT copy errors are logged as warnings and fork still completes.

ID implications after fork:

- if copy succeeded, artifact counters in the new session continue after max copied ID when the new `ArtifactManager` first scans,
- if copy failed/skipped, new session artifact IDs start from `0`.

Blob implications after fork:

- blobs are global and content-addressed, so no blob directory copy is required.

### Move to new cwd

`SessionManager.moveTo()` renames both session file and artifact directory to the new default session directory, with rollback logic if a later step fails. This preserves artifact identity while relocating session scope.

When the destination artifact directory already exists — for example, a session returning to a project whose old artifact path a subprocess kept writing to — directories are merged recursively. Entries with a taken name, or a spill ID (`local/<id>.log`) already taken, stay at the source; failed moves are also stranded and logged. Neither copy is overwritten or renumbered. A merged move is not rolled back by renaming the directory back; only the session-file move is. Cross-device relocation uses copy/remove fallbacks.

## Failure handling and fallback paths

| Case                                                      | Behavior                                                                                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Blob file missing during image-block rehydration          | Warn and keep `blob:sha256:` ref string in memory                                                        |
| Blob file missing during provider `image_url` rehydration | Warn and keep `blob:sha256:` ref string in memory                                                        |
| Blob read ENOENT via `BlobStore.get`                      | Returns `null`                                                                                           |
| `local://` root missing (`ArtifactManager.listFiles`)     | Returns empty list (allocation can start fresh)                                                          |
| No session for `local://`                                 | Throws `No session - local:// unavailable`                                                               |
| No registered artifact dirs (`agent://`)                  | Throws `No session - agent outputs unavailable`                                                          |
| Registered artifact dirs missing on disk                  | Throws explicit `No artifacts directory found`                                                           |
| Spill file not found (`local://<id>.log`)                 | Throws `Local file not found`                                                                            |
| Whole `local://` resolution exceeds 1 MiB                 | Returns a notice; `locate`-based reads and search remain available                                       |
| OutputSink artifact writer init fails                     | Continues with bounded in-memory output only                                                             |
| Session without a session file (`saveArtifact`)           | Spills to `$TMPDIR/omp-local/<sessionId>` on disk                                                        |
| Artifact directory already exists at the move destination | Directories merged; an entry whose name or artifact id is taken stays at the source and is logged (warn) |

## Binary blob externalization vs text-output artifacts

- **Blob externalization** is for image payloads inside persisted session entry content and provider image data URLs; it replaces inline payload strings in JSONL with stable content refs.
- **Artifacts** are plain text files for execution output and subagent output; spills are addressable by session-local IDs as `local://<id>.log`, and subagent outputs through `agent://`.

The two systems intersect only indirectly: both reduce session JSONL bloat, but they have different identity, lifetime, and retrieval paths.

## Implementation files

- [`src/session/blob-store.ts`](../packages/coding-agent/src/session/blob-store.ts) — blob reference format, hashing, put/get, externalize/resolve helpers.
- [`src/session/artifacts.ts`](../packages/coding-agent/src/session/artifacts.ts) — spill storage at the `local://` root and numeric spill ID/path allocation.
- [`src/internal-urls/local-root.ts`](../packages/coding-agent/src/internal-urls/local-root.ts) — where the session's `local://` root (and so its spills) lives.
- [`packages/coding-agent/src/tools/streaming-output.ts`](../packages/coding-agent/src/tools/streaming-output.ts) — `OutputSink` truncation/spill-to-file behavior and summary metadata.
- [`src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts) — `BlobStore`/`ArtifactManager` construction, persistence-transform and blob-rehydration call sites, session fork/move interactions.
- [`src/session/session-persistence.ts`](../packages/coding-agent/src/session/session-persistence.ts) — `prepareEntryForPersistence()`: large-string truncation, transient-field stripping, and synchronous image-blob externalization.
- [`src/session/session-loader.ts`](../packages/coding-agent/src/session/session-loader.ts) — `resolveBlobRefsInEntries()`: blob-ref rehydration to base64 / data URLs on load.
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts) — artifact directory copy during interactive fork.
- [`src/internal-urls/local-protocol.ts`](../packages/coding-agent/src/internal-urls/local-protocol.ts) — `local://` resolver, which also serves spills.
- [`src/internal-urls/agent-protocol.ts`](../packages/coding-agent/src/internal-urls/agent-protocol.ts) — `agent://` resolver + JSON extraction.
- [`src/internal-urls/router.ts`](../packages/coding-agent/src/internal-urls/router.ts) — internal URL router wiring.
- [`src/task/output-manager.ts`](../packages/coding-agent/src/task/output-manager.ts) — session-scoped agent output ID allocation for `agent://`.
- [`src/task/executor.ts`](../packages/coding-agent/src/task/executor.ts) — subagent output artifact writes (`<id>.md`) and session JSONL sidecars.
