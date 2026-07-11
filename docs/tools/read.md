# read

> Read files, directories, archives, SQLite databases, internal resources, images, documents, and URLs through one `path` string.

## Source
- Entry: `packages/coding-agent/src/tools/read.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/read.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/path-utils.ts` — split `path` from trailing selectors; normalize local paths.
  - `packages/coding-agent/src/utils/zip.ts` — the unified ZIP/tar wrapper: detect `archive.ext:inner/path`, index archives, list/read entries.
  - `packages/coding-agent/src/tools/sqlite-reader.ts` — detect SQLite targets, parse selectors, render tables.
  - `packages/coding-agent/src/tools/fetch.ts` — URL parsing, fetch/render pipeline, URL cache/artifacts.
  - `packages/coding-agent/src/internal-urls/router.ts` — resolve `agent://`, `artifact://`, `history://`, `issue://`, `local://`, `mcp://`, `memory://`, `omp://`, `pr://`, `rule://`, `skill://`, and `vault://`.
  - `packages/coding-agent/src/edit/notebook.ts` — convert `.ipynb` to editable `# %% [...] cell:N` text.
  - `packages/coding-agent/src/utils/file-display-mode.ts` — decide hashline vs line-number vs raw display.
  - `packages/coding-agent/src/workspace-tree.ts` — render directory trees.
  - `packages/coding-agent/src/edit/file-snapshot-store.ts` — stores read lines for later hashline edit verification/recovery.
  - `packages/coding-agent/src/tools/index.ts` — registers `read: s => new ReadTool(s)`.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | `string` | Yes | Filesystem path, internal URL, or web URL. May end with a trailing selector such as `:50-100` or `:raw`. |

### Selector grammar

For normal file-like reads, `splitPathAndSel()` in `packages/coding-agent/src/tools/path-utils.ts` recognizes the final suffix only when it matches one of these forms:

| Suffix | Meaning |
| --- | --- |
| `:raw` | Raw/verbatim mode. Disables structural summaries and line prefixes. |
| `:conflicts` | Render unresolved Git merge-conflict regions for a local file. |
| `:N` / `:LN` / `:N-` / `:N..` | Start at 1-indexed line `N`, open-ended. |
| `:A-B` / `:LA-LB` / `:A..B` | Inclusive 1-indexed line range (`..` is a forgiving alias normalized to `-`). |
| `:A+C` / `:LA+LC` | `C` lines starting at `A`; tool converts this to end line `A + C - 1`. |
| `:R1,R2,...` | Multiple ranges, sorted and merged before reading (for example `:5-16,960-973`). |
| `:range:raw` or `:raw:range` | Same line selection, but raw output. |

Validation in `parseLineRangeChunk()`:
- line numbers are 1-indexed; `:0` throws.
- `+` counts must be `>= 1`.
- `-` end must be `>= start`.

Selector parsing intentionally falls through for unrecognized trailing `:...`; archive and SQLite paths consume their own colon syntax.

URL selectors are parsed separately in `packages/coding-agent/src/tools/fetch.ts`, but use the same line-range parser for `:raw`, `:N`, `:A-B`, `:A+C`, `:5-10,20-30`, and `:range:raw` / `:raw:range`. Because URL ports also use `:`, add a trailing slash before a selector on a host/port URL, e.g. `https://example.com/:80`.

## Outputs
- Single-shot `AgentToolResult` built through `toolResult()` in `packages/coding-agent/src/tools/tool-result.ts`.
- `content` is usually one text block. Image reads may return `[text, image]`.
- `details` is path-dependent. `ReadToolDetails` may include:
  - `kind: "file" | "url"` (URL path uses `kind: "url"`; file reads usually omit `kind`)
  - `isDirectory`
  - `resolvedPath`
  - `suffixResolution`
  - URL fields: `url`, `finalUrl`, `contentType`, `method`, `notes`
  - `truncation`
  - `displayContent` (unprefixed text + starting line for TUI rendering)
  - `summary` (`lines`, `elidedSpans`, `elidedLines`) for structural summaries
  - `meta` from `packages/coding-agent/src/tools/output-meta.ts`
- `details.meta.source` is set to the backing path, URL, or internal URL.
- `details.meta.truncation` carries shown range, total lines/bytes, next offset, and optional `artifactId` for cached URL output.
- Directory/archive listings and SQLite table lists also set `details.meta.limits` when list limits trigger.

## Flow
1. `ReadTool.execute()` accepts `{ path }`. `file://...` inputs are expanded first with `expandPath()`.
2. It tries URL handling first via `parseReadUrlTarget()` from `packages/coding-agent/src/tools/fetch.ts`.
   - Plain URL reads call `executeReadUrl()`.
   - URL reads with line selectors load or refresh the URL cache with `loadReadUrlCacheEntry()` and paginate the cached text locally with `#buildInMemoryTextResult()`.
3. If not a web URL, it checks `InternalUrlRouter.instance().canHandle(...)`.
   - Internal URLs are resolved with `internalRouter.resolve()`.
   - `agent://` query extraction (`/path` or `?q=`) bypasses pagination and returns the extracted content directly.
   - Other internal resources are paginated in-memory by `#buildInMemoryTextResult()`.
4. It tries archive resolution next with `#resolveArchiveReadPath()`.
   - `parseArchivePathCandidates()` scans for `.tar`, `.tar.gz`, `.tgz`, or `.zip` anywhere before `:sub/path`.
   - On success, `#readArchive()` either lists a directory or decodes an entry as UTF-8 text.
5. It tries SQLite resolution with `#resolveSqliteReadPath()`.
   - `parseSqlitePathCandidates()` scans for `.sqlite`, `.sqlite3`, `.db`, `.db3` before any `:table`, `:key`, or `?query` suffix.
   - `#readSqlite()` dispatches on `parseSqliteSelector()`.
6. Otherwise it treats the input as a local filesystem path.
   - `resolveReadPath()` expands `~`, resolves relative to session cwd, treats bare `/` as session cwd, and retries macOS screenshot/NFD/curly-quote variants.
   - If the path does not exist, `findUniqueSuffixMatch()` does a workspace glob-based unique suffix lookup (skipped for remote mounts).
7. Directories go through `#readDirectory()`.
8. Non-directories branch by content type:
   - image metadata / inline image
   - editable notebook text
   - markit-converted document
   - structural summary for parseable code/prose
   - streamed text/line-range read
9. Local text reads are streamed by `streamLinesFromFile()` rather than loading the whole file. The tool adds `1` leading and `3` trailing context lines around explicit bounded ranges (constrained sides only).
10. Hashline-eligible local reads record a whole-file snapshot into the session snapshot store (`getFileSnapshotStore()` on `session.fileSnapshotStore`, `packages/coding-agent/src/edit/file-snapshot-store.ts`) for later hashline edit verification/recovery.
11. If suffix resolution happened, the first text block is prefixed with `[Path '...' not found; resolved to '...' via suffix match]`.

## Modes / Variants

### Local text files
- No selector: if summarization is enabled and the file is small enough, `#trySummarize()` calls `summarizeCode()`.
  - Guards: file size `<= 2 MiB` (`MAX_SUMMARY_BYTES`), line count `<= 20_000` (`MAX_SUMMARY_LINES`).
  - Summary output keeps selected declarations and replaces elided spans with `…` or merged brace-pair lines containing `{ … }`. When at least one span is elided, the text content ends with a footer like `[…NNln elided; re-read needed ranges, e.g. <path>:5-16,40-80]` using concrete ranges from the actual elisions.
  - When an elided block sits between matching brace lines, `#renderSummary()` may merge them into one anchored line rather than emitting separate opener/closer lines.
- Explicit selector or summarization miss: streamed text read.
  - Default open-ended limit is `min(session setting read.defaultLimit, DEFAULT_MAX_LINES)`.
  - Explicit ranges expand by `RANGE_LEADING_CONTEXT_LINES = 1` / `RANGE_TRAILING_CONTEXT_LINES = 3` on the constrained sides only.
  - Non-raw output uses `resolveFileDisplayMode()`:
    - hashline numbered output when edit mode is hashline, read is not raw, source is mutable, and the edit tool exists
    - otherwise optional line numbers when `readLineNumbers === true`
    - raw mode suppresses both
- Prefix format in hashline mode is a `[PATH#TAG]` header followed by `LINE:TEXT`, e.g. `[src/foo.ts#0A1B]` and `41:def alpha():`, from the session snapshot store plus `formatNumberedLine()` / `formatHashlineHeader()`.
- The `edit`/hashline path consumes that header plus bare line numbers later; the four-hex tag is a content-derived hash of the whole normalized file, resolvable through the session snapshot store that recorded it. Immutable sources and `:raw` intentionally suppress hashline headers.

### Directory listings
- `#readDirectory()` calls `buildDirectoryTree()` with:
  - `maxDepth = 2`
  - `perDirLimit = 12`
  - `rootLimit = null`
  - `lineCap = limit` when a line selector was present, else unlimited at this layer
- `buildDirectoryTree()` sorts siblings by recency, shows file sizes and relative ages, and may mark `limits.resultLimit` when the tree truncates.
- Empty directories render as `(empty directory)`.

### Archives
- Supported archive containers: `.tar`, `.tar.gz`, `.tgz`, `.zip`.
- Syntax: `archive.ext`, `archive.ext:path/inside`, `archive.ext:path/inside:50-60`.
- `openArchive()` branches by format:
  - tar/tgz reads the whole archive into memory (capped at `MAX_TAR_ARCHIVE_BYTES = 256 MiB`) and indexes it with `new Bun.Archive(bytes)`
  - zip is indexed via ranged central-directory reads (`readZipEntries()`); members are inflated on demand with raw DEFLATE (`node:zlib`), and the read tool caps individual extraction at `MAX_ARCHIVE_MEMBER_BYTES = 64 MiB` in `ArchiveReader.readFile()`
- Archive paths normalize `/`, drop `.` segments, and reject `..`.
- Directory reads list immediate children; files show `name` plus ` (size)` when size > 0.
- Directory listing default limit is `500` entries in `#readArchiveDirectory()`.
- File entries are UTF-8 decoded. Non-UTF-8 entries return `[Cannot read binary archive entry '...' (...)]` instead of bytes.
- Text archive entries reuse the normal in-memory pagination/anchoring path.

### SQLite databases
- Database detection requires both a matching extension and a valid SQLite file header (`isSqliteFile()`).
- Selector forms from `parseSqliteSelector()`:

#### `db.sqlite`
- `kind: "list"`
- Lists non-`sqlite_%` tables with row counts.
- `#readSqlite()` caps the rendered list to `500` tables via `applyListLimit()`.

#### `db.sqlite:table`
- `kind: "schema"`
- Returns `sqlite_master.sql` plus sample rows.
- Sample size is `DEFAULT_SCHEMA_SAMPLE_LIMIT = 5`.

#### `db.sqlite:table:key`
- `kind: "row"`
- Resolves by primary key when the table has exactly one PK column; otherwise falls back to `rowid` lookup.
- No query parameters allowed on row lookups.

#### `db.sqlite:table?limit=...&offset=...&order=...&where=...`
- `kind: "query"`
- Defaults: `limit = 20`, `offset = 0`.
- `limit` is capped at `500`.
- `order` accepts `column` or `column:asc|desc` and must name an existing column.
- `where` is accepted only after `validateWhereClause()` rejects comments, semicolons, and control keywords like `LIMIT`, `OFFSET`, `UNION`, `ATTACH`, `PRAGMA`.
- Unknown query parameters throw.

#### `db.sqlite?q=SELECT ...`
- `kind: "raw"`
- Cannot be combined with table selectors or any other query param.
- Empty `q` throws.
- `executeReadQuery()` prepares the SQL, rejects bound parameters, and collects rows from `statement.iterate()` capped at `MAX_RAW_QUERY_ROWS = 1000`; it does not verify that the SQL starts with `SELECT`.

- Rendering caps in `packages/coding-agent/src/tools/sqlite-reader.ts`:
  - ASCII table width `120` (`MAX_RENDER_WIDTH`)
  - per-column width `40` (`MAX_COLUMN_WIDTH`)
- `#readSqlite()` opens Bun SQLite in `{ readonly: true, strict: true }` and sets `PRAGMA busy_timeout = 3000`.

### Documents
- `CONVERTIBLE_EXTENSIONS` in `packages/coding-agent/src/tools/read.ts` covers `.pdf`, `.doc`, `.docx`, `.ppt`, `.pptx`, `.xls`, `.xlsx`, `.rtf`, `.epub`.
- `convertFileWithMarkit()` converts the file to text/markdown; line-range and `:raw` selectors then apply to the converted output (`file.pdf:50-100`, `:5-16,40-80`).
- For PDFs, embedded images are surfaced as browsable handles. markit emits a `<!-- image: <id> (page N, WxHpt) -->` region for each embedded image; `read.ts` rewrites it into a `read <pdf>:<id>.png` hint (as inline code, so spaces/parens in the path can't break markdown). Reading that handle (`doc.pdf:p11-img0.png`) extracts the image — passing markit an `imageDir` that lands in a session-artifact cache (`<artifacts>/pdf-assets/<key>/`, keyed by size+mtime, converted once per file) — and returns it through the normal image-loading path. `doc.pdf:` lists the extractable members; an unknown member errors with the available list. Requested members are matched against extracted basenames, so `..`/separators cannot escape the cache.
- Conversion failures return a text block like `[Cannot read .pdf file: ...]`.

### Jupyter notebooks
- `.ipynb` goes through `readEditableNotebookText()` unless `:raw` was requested.
- Output is editable plain text with markers like:

```text
# %% [code] cell:0
...
```

- Raw mode bypasses that conversion and falls back to file-text reading.

### Images
- Image detection is metadata-based (`readImageMetadata()`).
- Max accepted image size is `20 MiB` (`MAX_IMAGE_INPUT_BYTES`, re-exported as `MAX_IMAGE_SIZE`). Larger files throw.
- If `inspect_image.enabled` is true, `read` returns metadata only (MIME, bytes, dimensions, channels, alpha) plus a suggestion to call `inspect_image`.
- Otherwise it calls `loadImageInput()` and returns:
  - a text note from the image loader
  - an inline image block
- Unsupported/undecodable image formats throw a `ToolError`.

### Internal URLs
- `read` does not resolve these itself; it delegates to `InternalUrlRouter.instance().resolve()`.
- Registered protocols are outside this file, but the router in `packages/coding-agent/src/internal-urls/router.ts` is built for `agent://`, `artifact://`, `history://`, `issue://`, `local://`, `mcp://`, `memory://`, `omp://`, `pr://`, `rule://`, `skill://`, and `vault://`.
- `#handleInternalUrl()` behavior:
  - parses the URL with `parseInternalUrl()` so colons inside the host segment are legal
  - for `agent://`, treats non-root path extraction or `?q=` extraction as a special no-pagination mode
  - otherwise paginates the resolved text in memory
  - passes `immutable` through to `resolveFileDisplayMode()` so anchors are suppressed for immutable resources such as artifacts, skills, memory, and agent outputs
  - sets `ignoreResultLimits: true` for `skill://` so the full skill text is paginated only by explicit selectors, not by the normal default line limit
- `issue://<N>` / `pr://<N>` (and the long form `issue://<owner>/<repo>/<N>` / `pr://<owner>/<repo>/<N>`) route through the same SQLite cache the `github` tool writes to; `?comments=0` selects the no-comments rendering. Bare `issue://` / `pr://` (and `issue://<owner>/<repo>` / `pr://<owner>/<repo>`) issue a live `gh issue list` / `gh pr list` for browsing, accepting `?state=`, `?limit=`, `?author=`, `?label=`. PR diffs share the same cache through `pr://<N>/diff` (numbered file listing with per-file hints), `pr://<N>/diff/<i>` (single file slice; 1-indexed), and `pr://<N>/diff/all` (verbatim unified diff); the listing and per-file slices are reconstructed from the cached unified-diff payload, so all three variants share one `gh pr diff` invocation per PR. Diff content is served as `text/plain`. Soft TTL `github.cache.softTtlSec` (default 5 minutes), hard TTL `github.cache.hardTtlSec` (default 7 days). Stale-hit returns the cached row and schedules a background refresh.

### Web URLs
- `parseReadUrlTarget()` accepts `http://`, `https://`, or `www.` targets.
- Plain URL reads call `executeReadUrl()` in `packages/coding-agent/src/tools/fetch.ts`.
- `:raw` means raw HTML/body fallback path; plain URL reads prefer rendered/reader-friendly output.
- `:N`, `:A-B`, `:A+C`, and comma-separated multi-ranges do not refetch when cached output is usable. They page over cached output from the prior or current URL render.
- URL render pipeline in `renderUrl()`:
  1. normalize scheme (`https://` added for bare `www.`)
  2. try special handlers for known sites unless raw
  3. fetch with `loadPage()`
  4. if content is image/PDF/DOCX/etc., try binary fetch + markit/image handling
  5. handle JSON directly, feeds via feed parser, plain text directly
  6. for HTML and non-raw mode, try markdown alternates, `URL.md`, content negotiation, feed alternates, HTML-to-text renderers, extracted linked documents, then `llms.txt`
  7. fall back to raw body text/html
- URL output is wrapped with a small header:

```text
URL: ...
Content-Type: ...
Method: ...
Notes: ...

---
```

- `method` records the winning path (`json`, `feed`, `text`, `alternate-markdown`, `md-suffix`, `content-negotiation`, `image`, `markit`, `llms.txt`, `raw`, `raw-html`, etc.).
- URL reads may return an inline image block when the fetched resource is a supported image and survives resizing.

## Side Effects
- Filesystem
  - Opens and streams local files.
  - Reads tar/tgz archives fully into memory before indexing (256 MiB cap); ZIP archives are indexed via ranged central-directory reads.
  - May read URL-cache artifact files from the session artifacts directory.
  - Writes URL output artifacts when URL output is truncated or when line-range pagination needs a persisted cache body.
- Network
  - URL mode performs HTTP fetches, binary refetches, and alternate-endpoint probes.
- Subprocesses / native bindings
  - Uses Bun SQLite for `.db`/`.sqlite*`.
  - Uses `Bun.Archive` for tar/tgz; ZIP is framed in `packages/coding-agent/src/utils/zip.ts` over the `node:zlib` DEFLATE codec.
  - URL HTML rendering can delegate into site handlers and HTML-to-text backends from `packages/coding-agent/src/tools/fetch.ts`.
- Session state
  - Records whole-file snapshots of local text reads into `session.fileSnapshotStore` for later stale-anchor recovery.
  - Passes session `cwd`, `settings`, and `localProtocolOptions` into the process-global `InternalUrlRouter.instance().resolve()` for internal URLs.
  - Uses `session.allocateOutputArtifact()` for cached/truncated URL output.
- Background work / cancellation
  - Only the deterministic disk reads are non-abortable: plain-file line/range reads (`streamLinesFromFile`, multi-range) and directory listings (`#readDirectory`) are called with `undefined` instead of the `AbortSignal`, so an interrupt mid-read can't surface a misleading "Operation aborted" on a read that would have finished instantly. Every other branch keeps the signal and its helpers call `throwIfAborted(signal)` to stop promptly: URL/internal-URL reads (network), archive, sqlite, document conversion, image decode, structural summary, conflict scan, and the suffix-glob path resolution.

## Limits & Caps
- Shared text truncation defaults from `packages/coding-agent/src/session/streaming-output.ts`:
  - `DEFAULT_MAX_LINES = 3000`
  - `DEFAULT_MAX_BYTES = 50 * 1024`
- Local text open-ended default line limit: `read.defaultLimit`, clamped to `[1, DEFAULT_MAX_LINES]`.
- Explicit line ranges add `1` leading and `3` trailing context lines on the constrained sides (`RANGE_LEADING_CONTEXT_LINES` / `RANGE_TRAILING_CONTEXT_LINES`).
- File streaming chunk size: `8 * 1024` bytes (`READ_CHUNK_SIZE`).
- Local streamed byte budget for line reads: `max(DEFAULT_MAX_BYTES, maxLinesToCollect * 512)`.
- Structural summaries only run when file size `<= 2 MiB` and line count `<= 20_000`.
- Image input max: `20 MiB`.
- Directory tree caps for local directories: depth `2`, per-directory children `12`.
- Archive directory default list cap: `500` entries.
- SQLite:
  - default row query limit `20`
  - schema sample limit `5`
  - max query limit `500`
  - raw `?q=` row cap `1000` (`MAX_RAW_QUERY_ROWS`)
  - table list cap `500`
  - render width `120`, column width `40`
  - busy timeout `3000` ms
- URL read result shown to the model is truncated to `300` lines and `50 KiB` in `executeReadUrl()`; full cached output can be attached as an artifact.
- Inline fetched URL images:
  - source bytes cap `20 MiB`
  - post-resize inline output cap `300 KiB`
- Unique suffix auto-resolution glob timeout: `5000` ms.
- File snapshot store holds `30` paths with up to `4` versions each (`DEFAULT_MAX_PATHS` / `DEFAULT_MAX_VERSIONS_PER_PATH` in `packages/hashline/src/snapshots.ts`); files over `4 MiB` (`SNAPSHOT_MAX_BYTES`) are not snapshotted.

## Errors
- Validation and operational failures surface as `ToolError`.
- Selector errors include:
  - `Line selector 0 is invalid; lines are 1-indexed. Use :1.`
  - invalid `A+B` / `A-B` shapes
  - `Cannot combine query extraction with line selectors` for `agent://.../path:50`
- Missing local/archive/sqlite paths first attempt unique suffix resolution; if no unique match exists they error.
- Out-of-bounds line reads do not throw. They return explanatory text with a suggestion such as `Use :1 ...` or `Use :<last line> ...`.
- Binary archive entries do not throw; they return a text notice.
- Document conversion failure returns a text notice.
- Image oversize/unsupported/invalid cases throw.
- SQLite parser rejects unsupported parameter combinations early; DB/runtime errors are caught and rethrown as `ToolError(message)`.
- URL fetch failure does not throw when HTTP fetch succeeds but `response.ok === false`; it returns a failed URL read with `method: "failed"` and explanatory notes.

## Notes
- Hashline anchors are suppressed for raw reads and immutable internal resources because there is no editable backing target for later `edit` consumption.
- `splitPathAndSel()` intentionally treats unknown trailing `:...` as part of the path so `archive.zip:inner/file` and `db.sqlite:table:key` still work.
- `resolveReadPath()` contains macOS-specific filename fallbacks for screenshot timestamps, NFD Unicode normalization, and curly apostrophes.
- A bare `/` resolves to the session cwd, not the filesystem root.
- URL cache keys are session-scoped and normalized by requested URL + raw/rendered mode; both requested URL and final redirected URL are cached.
- URL line-range reads request `ensureArtifact: true, preferCached: true` so a later paginated read can reopen the same rendered body from artifact storage.
- Raw SQLite `q=` execution is not keyword-restricted beyond “no bound parameters”; the read tool relies on the surrounding contract to keep it read-only.
- The file snapshot store is not a read acceleration cache. It exists to verify and recover hashline edits when the file changed after the read.