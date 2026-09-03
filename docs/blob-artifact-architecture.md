# Blob and artifact storage architecture

This document describes how coding-agent stores large/binary payloads outside session JSONL, how truncated tool output is persisted, and how internal URLs (`artifact://`, `agent://`) resolve back to stored data.

## Why two storage systems exist

The runtime uses two different persistence mechanisms for different data shapes:

- **Content-addressed blobs** (`blob:sha256:<hash>`): global storage used to externalize large image base64 payloads and provider image data URLs from persisted session entries.
- **Session-scoped artifacts** (files under `<sessionFile-without-.jsonl>/`): per-session text files used for full tool outputs and subagent outputs.

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

Artifact types share this directory:

- truncated tool output files: `<numericId>.<toolType>.log` (for `artifact://`)
- subagent output files: `<outputId>.md` (for `agent://`)
- subagent session JSONL sidecars: `<outputId>.jsonl` when task execution receives an artifacts directory

Subagents can adopt the parent `ArtifactManager`; in that case parent and subagent tree share one artifact directory and numeric artifact ID space.

## ID and name allocation schemes

### Blob IDs: content hash

`BlobStore.put()` / `putSync()` computes SHA-256 over the bytes it is given and returns:

- `hash`: hex digest,
- `path`: `<blobsDir>/<hash>`,
- `displayPath`: `<blobsDir>/<hash>.<ext>` when an extension was supplied, otherwise the canonical path,
- `ref`: `blob:sha256:<hash>`.

No session-local counter is used.

### Artifact IDs: session-local monotonic integer

`ArtifactManager` creates the directory lazily and scans existing `*.log` files on first directory-backed allocation to find the maximum numeric ID, setting `nextId = max + 1`. Concurrent first allocations share the same initialization promise so they cannot reseed the counter and hand out duplicates.

Allocation behavior:

- file format: `{id}.{sanitizedToolType}.log`
- tool types collapse characters outside `[A-Za-z0-9_-]` to `_`, trim surrounding underscores, cap at 64 characters, and fall back to `tool`
- IDs are sequential strings (`"0"`, `"1"`, ...)
- resume does not overwrite existing artifacts because scan happens before allocation

If the artifact directory is missing, initialization creates it and allocation starts from `0`.

Non-persistent sessions without an adopted manager can store `saveArtifact(...)` content in memory under numeric IDs, but `artifact://` resolution is file-backed through registered artifact directories.

### Agent output IDs (`agent://`)

`AgentOutputManager` allocates IDs from the requested name, used verbatim the first time and suffixed (`-2`, `-3`, …) only when repeated. Nested outputs use a dot-qualified parent prefix (for example `Parent.Child`). Initialization scans both `.md` outputs and `.jsonl` child-session files so resume cannot clobber either; the reserved advisor transcript stem is never allocated unchanged.

## Persistence dataflow

### 1) Session entry persistence rewrite path

Before a session entry is written — incremental append (`#appendToSessionFile`) or a full-file rewrite (`#rewriteSynchronously` / `#rewriteAtomically`) — `SessionManager` serializes it through `#lineFor()`, which runs `prepareEntryForPersistence()` over the truncation pipeline.

Key behaviors:

1. **Large string truncation**: oversized strings are cut and suffixed with `"[Session persistence truncated large content]"`; signature fields (`thinkingSignature`, `thoughtSignature`, `textSignature`) are cleared instead of truncated.
2. **Transient field stripping**: `partialJson` and `jsonlEvents` are removed from persisted entries.
3. **Image externalization to blobs**:
   - image blocks in `content` arrays are externalized when `data` is not already a blob ref and base64 length is at least threshold (`BLOB_EXTERNALIZE_THRESHOLD = 1024`),
   - provider-style `image_url` data URLs are externalized when they start with `data:image/` and contain `;base64,`,
   - image block `data` is stored as decoded binary bytes,
   - provider data URLs are stored as the original UTF-8 data URL string,
   - persisted values are replaced with `blob:sha256:<hash>`.

This keeps session JSONL compact while preserving recoverability.

### 2) Session load rehydration path

When opening a session (`setSessionFile`), after migrations, `SessionManager` runs `resolveBlobRefsInEntries()`.

For message/custom-message image blocks with `blob:sha256:<hash>` and for persisted provider `image_url` fields with blob refs:

- reads blob bytes from blob store,
- converts image-block bytes back to base64,
- converts provider `image_url` blobs back to the original string,
- mutates in-memory entry fields for runtime consumers.

If a blob is missing:

- image-block resolution logs a warning and keeps the original `blob:sha256:` ref string in memory,
- provider `image_url` resolution logs a warning and keeps the original ref string,
- load continues.

### 3) Tool output spill/truncation path

`OutputSink` powers streaming output in bash/python/ssh and related executors.

Behavior:

1. Every chunk is sanitized with `sanitizeWithOptionalSixelPassthrough(..., sanitizeText)` and appended to in-memory accounting.
2. Optional live `onChunk` receives sanitized pre-column-cap chunks, throttled if configured.
3. A per-line column cap can drop bytes from long lines in the LLM-facing buffer; when this happens, artifact mirroring starts so the on-disk file keeps the full sanitized stream.
4. When the in-memory tail buffer would exceed spill threshold (`DEFAULT_MAX_BYTES`, 50KB), sink marks output truncated and starts artifact mirroring if an artifact path is available.
5. If a file sink is opened, it first writes the current buffer, then all queued/subsequent sanitized chunks.
6. In-memory buffer is trimmed to a tail window, or to head + elision marker + tail when head retention is configured.
7. `dump()` returns summary including `artifactId` only when file sink creation succeeded.

Practical effect:

- UI/tool return shows bounded output,
- full sanitized output is preserved in artifact file and referenced as `artifact://<id>` when file-backed artifact mirroring succeeded.

If file sink creation fails (I/O error, missing path, etc.), sink falls back to in-memory truncation only; full output is not persisted.

## URL access model

### `blob:` references

`blob:sha256:<hash>` is a persistence reference inside session entry payloads, not an internal URL scheme handled by the router. `SessionManager` resolves it during load. Malformed suffixes are rejected by `parseBlobRef()` before any path join, logged, and left unchanged rather than being read from the blob directory.

### `artifact://<id>`

Handled by `ArtifactProtocolHandler` over registered active session artifact directories:

- requires a numeric ID
- prefers the calling session's pinned artifacts directory before other registered sessions, because numeric IDs are session-local
- searches for filename prefix `<id>.`
- returns raw `text/plain` for inline resolution
- when missing, reports available numeric artifact IDs
- refuses to materialize a full artifact larger than 8 MiB; use bounded `read` selectors or the reported backing path for search/copy workflows

Path-only consumers can resolve the backing file at any size without loading its bytes.

Failure behavior:

- if no artifact directories are registered: throws `No session - artifacts unavailable`,
- if registered directories exist but none are present on disk: throws `No artifacts directory found`,
- if ID is not numeric: throws `artifact:// ID must be numeric, got: <id>`.

### `agent://<id>`

Handled by `AgentProtocolHandler` over registered active session artifact directories and `<artifactsDir>/<id>.md`:

- `agent://<id>` returns markdown text
- `agent://Parent/Child` first tries the nested output `Parent.Child.md`
- only when no nested output matches does a slash path fall back to JSON extraction from the base output
- `?q=` always performs JSON extraction
- path and query extraction cannot be combined
- extraction requires valid JSON and returns `application/json`

Failure behavior:

- if no artifact directories are registered: throws `No session - agent outputs unavailable`,
- if registered directories exist but none are present on disk: throws `No artifacts directory found`,
- missing output throws `Not found: <id>` with available `.md` output IDs when directory listing succeeds.

Read tool integration:

- `read` supports line-range and raw selectors for non-extraction internal URL reads
- line selectors are rejected when an `agent://` URL contains path or query extraction syntax; extraction returns directly without pagination

## Resume, fork, and move semantics

### Resume

- `ArtifactManager` scans existing `{id}.*.log` files once on first allocation and continues numbering.
- `AgentOutputManager` scans existing `.md` and child `.jsonl` IDs and continues name suffixing.
- `SessionManager` rehydrates blob refs to base64/data URLs on load.

### Fork

`SessionManager.fork()` creates a new session file with new session ID and `parentSession` link, then returns old/new file paths. Artifact copying is handled by `AgentSession.fork()`:

- flushes current session first,
- attempts recursive copy of old artifact directory to new artifact directory,
- missing old directory is tolerated,
- non-ENOENT copy errors are logged as warnings and fork still completes.

ID implications after fork:

- if copy succeeded, artifact counters in the new session continue after max copied ID when the new `ArtifactManager` first scans,
- if copy failed/skipped, new session artifact IDs start from `0`.

Blob implications after fork:

- blobs are global and content-addressed, so no blob directory copy is required.

### Move to new cwd

`SessionManager.moveTo()` renames both session file and artifact directory to the new default session directory, with rollback logic if a later step fails. This preserves artifact identity while relocating session scope.

## Failure handling and fallback paths

| Case                                                      | Behavior                                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Blob file missing during image-block rehydration          | Warn and keep `blob:sha256:` ref string in memory                                      |
| Blob file missing during provider `image_url` rehydration | Warn and keep `blob:sha256:` ref string in memory                                      |
| Blob read ENOENT via `BlobStore.get`                      | Returns `null`                                                                         |
| Artifact directory missing (`ArtifactManager.listFiles`)  | Returns empty list (allocation can start fresh)                                        |
| No registered artifact dirs (`artifact://`)               | Throws `No session - artifacts unavailable`                                            |
| No registered artifact dirs (`agent://`)                  | Throws `No session - agent outputs unavailable`                                        |
| Registered artifact dirs missing on disk                  | Throws explicit `No artifacts directory found`                                         |
| Artifact ID not found                                     | Throws with available IDs listing                                                      |
| Full `artifact://` resolution exceeds 8 MiB               | Rejects inline materialization; bounded selectors/path-only workflows remain available |
| OutputSink artifact writer init fails                     | Continues with bounded in-memory output only                                           |
| Non-persistent `saveArtifact`                             | Stores text in `SessionManager` memory map; not file-backed URL data                   |

## Binary blob externalization vs text-output artifacts

- **Blob externalization** is for image payloads inside persisted session entry content and provider image data URLs; it replaces inline payload strings in JSONL with stable content refs.
- **Artifacts** are plain text files for execution output and subagent output; file-backed artifacts are addressable by session-local IDs through internal URLs.

The two systems intersect only indirectly: both reduce session JSONL bloat, but they have different identity, lifetime, and retrieval paths.

## Implementation files

- [`src/session/blob-store.ts`](../packages/coding-agent/src/session/blob-store.ts) — blob reference format, hashing, put/get, externalize/resolve helpers.
- [`src/session/artifacts.ts`](../packages/coding-agent/src/session/artifacts.ts) — session artifact directory model and numeric artifact ID/path allocation.
- [`src/session/streaming-output.ts`](../packages/coding-agent/src/session/streaming-output.ts) — `OutputSink` truncation/spill-to-file behavior and summary metadata.
- [`src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts) — `BlobStore`/`ArtifactManager` construction, persistence-transform and blob-rehydration call sites, session fork/move interactions.
- [`src/session/session-persistence.ts`](../packages/coding-agent/src/session/session-persistence.ts) — `prepareEntryForPersistence()`: large-string truncation, transient-field stripping, and synchronous image-blob externalization.
- [`src/session/session-loader.ts`](../packages/coding-agent/src/session/session-loader.ts) — `resolveBlobRefsInEntries()`: blob-ref rehydration to base64 / data URLs on load.
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts) — artifact directory copy during interactive fork.
- [`src/internal-urls/artifact-protocol.ts`](../packages/coding-agent/src/internal-urls/artifact-protocol.ts) — `artifact://` resolver.
- [`src/internal-urls/agent-protocol.ts`](../packages/coding-agent/src/internal-urls/agent-protocol.ts) — `agent://` resolver + JSON extraction.
- [`src/internal-urls/router.ts`](../packages/coding-agent/src/internal-urls/router.ts) — internal URL router wiring.
- [`src/task/output-manager.ts`](../packages/coding-agent/src/task/output-manager.ts) — session-scoped agent output ID allocation for `agent://`.
- [`src/task/executor.ts`](../packages/coding-agent/src/task/executor.ts) — subagent output artifact writes (`<id>.md`) and session JSONL sidecars.
