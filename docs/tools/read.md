# read

> Read files, directories, archives, SQLite databases, internal resources, images, documents, and URLs through one `path` string.

## Source
- Entry: `packages/coding-agent/src/tools/read.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/read.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/path-utils.ts` — split `path` from trailing selectors; prefer literal filenames; normalize local paths and recover accidental delimited path lists.
  - `packages/utils/src/ar` (`@oh-my-pi/pi-utils/ar`) — unified archive registry: detect `archive.ext:inner/path`, index archives, list/read entries.
  - `packages/coding-agent/src/tools/sqlite-reader.ts` — detect SQLite targets, parse selectors, render tables.
  - `packages/coding-agent/src/tools/fetch.ts` — URL parsing, fetch/render pipeline, URL cache/artifacts.
  - `packages/coding-agent/src/internal-urls/router.ts` — built-in internal-resource registry, including `ssh://` and `xd://`; MCP may advertise additional schemes.
  - `packages/coding-agent/src/edit/notebook.ts` — convert `.ipynb` to editable `# %% [...] cell:N` text.
  - `packages/coding-agent/src/utils/cpuprofile.ts` / `sample-profile.ts` — summarize recognized profiler reports.
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
| `:img` | Rasterize a local `.svg`/`.svgz` file and return it as an image block for vision input. Only local SVG/SVGZ files are supported. |
| `:conflicts` | Scan a local file for unresolved Git merge-conflict regions, register them in session conflict history, and render a compact `#N Lx-Ly` index. |
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
Literal filesystem paths take precedence over selector interpretation, so an existing POSIX filename that ends in selector-looking text is read literally.

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
  - `conflictCount` for `<path>:conflicts`
  - `displayReadTargets` when the tool recovered an accidental delimited list of paths for TUI display
  - `meta` from `packages/coding-agent/src/tools/output-meta.ts`
- `details.meta.source` is set to the backing path, URL, or internal URL.
- `details.meta.truncation` carries shown range, total lines/bytes, next offset, and optional `artifactId` for cached URL output.
- Directory/archive listings and SQLite table lists also set `details.meta.limits` when list limits trigger.

## Flow
1. `ReadTool.execute()` accepts `{ path }`. `file://...` inputs are expanded first with `expandPath()`. `conflict://<N>[/ours|theirs|base|both]` is handled before ordinary URLs; `conflict://*` is write-only.
2. It tries web URL handling via `parseReadUrlTarget()` from `packages/coding-agent/src/tools/fetch.ts`.
   - Plain URL reads call `executeReadUrl()`.
   - URL reads with line selectors fetch/render into the URL cache as needed, then paginate the rendered text locally.
3. It checks the internal URL router, including built-ins and MCP-advertised schemes.
   - `local://` resources backed by actual files are promoted into the local-file path so images, conversion, selectors, and snapshots behave like filesystem reads.
   - `agent://` query extraction (`/path` or `?q=`) bypasses pagination and returns the extracted content directly.
   - `artifact://` uses a bounded file-backed reader rather than loading the full artifact.
   - Other internal resources are paginated in memory by `#buildInMemoryTextResult()`.
4. It prefers an existing literal filesystem path before treating selector-looking colons as archive, SQLite, PDF-image, or line-selector syntax.
5. It tries archive resolution next with `#resolveArchiveReadPath()`.
   - `parseArchivePathCandidates()` recognizes `.tar`, `.tar.gz`, `.tgz`, `.zip`, `.jar`, `.war`, `.ear`, and `.apk` before `:sub/path`.
   - On success, `#readArchive()` either lists a directory or decodes an entry as UTF-8 text.
6. It tries SQLite resolution with `#resolveSqliteReadPath()`.
   - `parseSqlitePathCandidates()` scans for `.sqlite`, `.sqlite3`, `.db`, `.db3` before any `:table`, `:key`, or `?query` suffix.
   - `#readSqlite()` dispatches on `parseSqliteSelector()`.
7. Otherwise it treats the input as a local filesystem path.
   - `resolveReadPath()` expands `~`, resolves relative to session cwd, treats bare `/` as session cwd, and retries macOS screenshot/NFD/curly-quote variants.
   - If the path does not exist, `findUniqueWorkspaceSuffix()` attempts a workspace-wide unique suffix match (skipped for remote mounts). A cwd-root filename matching the active `local://` plan basename may recover that plan. As a final guarded recovery, a mistakenly delimited list of existing paths is read part by part; callers should still issue one `read` per path.
8. Directories go through `#readDirectory()`.
9. Non-directories branch by content type:
   - image metadata / inline image
   - summarized macOS `sample` or V8 `.cpuprofile` report
   - editable notebook text
   - markit-converted document
   - binary-file notice unless `:raw` was explicit
   - structural summary for parseable code/prose
   - streamed text/line-range read
10. Local text reads are streamed by `streamLinesFromFile()` rather than loading the whole file. A single bounded non-raw text range adds `1` leading and `3` trailing context lines on constrained sides; raw and multi-range reads remain exact.
11. Hashline-eligible local reads record a file snapshot into the session snapshot store for later hashline edit verification/recovery. Files over the snapshot byte cap are not snapshotted.
12. If suffix resolution happened, the first text block is prefixed with `[Path '...' not found; resolved to '...' via suffix match]`.

## Modes / Variants

### Local text files
- No selector: if summarization is enabled and the file is eligible, `#trySummarize()` calls `summarizeCode()`.
  - Defaults: `read.summarize.enabled = true`; prose (`.md` variants and `.txt`) stays unsummarized unless `read.summarize.prose = true`; files below `read.summarize.minTotalLines = 100` stay verbatim.
  - Hard guards: file size `<= 2 MiB` (`MAX_SUMMARY_BYTES`), line count `<= 20_000` (`MAX_SUMMARY_LINES`).
  - Summary output keeps selected declarations and replaces elided spans with `…` or merged brace-pair lines containing `{ … }`. When at least one span is elided, the text content ends with a footer like `[…NNln elided; re-read needed ranges, e.g. <path>:5-16,40-80]` using concrete ranges from the actual elisions.
  - When an elided block sits between matching brace lines, `#renderSummary()` may merge them into one anchored line rather than emitting separate opener/closer lines.
- Explicit selector or summarization miss: streamed text read.
  - Default open-ended limit is `read.defaultLimit = 300`, clamped to `[1, DEFAULT_MAX_LINES]`.
  - Single bounded non-raw text ranges add `RANGE_LEADING_CONTEXT_LINES = 1` / `RANGE_TRAILING_CONTEXT_LINES = 3` on constrained sides. Raw and multi-range reads are exact; directory listing selectors slice rendered entries without context.
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

- Supported archive containers (extension table in `packages/utils/src/ar/registry.ts`): tar family `.tar`, `.tar.gz`/`.tgz`, `.tar.bz2`/`.tbz2`/`.tbz`, `.tar.xz`/`.txz`, `.tar.zst`/`.tzst`, `.tar.z`; ZIP family `.zip`, `.jar`, `.war`, `.ear`, `.apk`, `.whl`, `.ipa`, `.xpi`, `.vsix`, `.nupkg`, `.cbz`; standalone `.rar`/`.cbr`, `.7z`, `.iso`, `.cab`, `.cpio`, `.rpm`, `.ar`/`.a`/`.lib`, `.deb`, `.lzh`/`.lha`, `.arj`, `.asar`; single-stream `.gz`, `.bz2`, `.xz`, `.zst`, `.z`, `.lzma`.
- Syntax: `archive.ext`, `archive.ext:path/inside`, `archive.ext:path/inside:50-60`.
- `openArchive()` dispatches through the `@oh-my-pi/pi-utils/ar` registry (`packages/utils/src/ar/open.ts`); limits live in `packages/utils/src/ar/limits.ts`: in-memory archives cap at 256 MiB, index reads at 64 MiB, and individual member extraction at 64 MiB.
- Archive paths normalize `/`, drop `.` segments, and reject `..`.
- Directory reads list immediate children; files show `name` plus ` (size)` when size > 0.
- Directory listing default limit is `500` entries in `#readArchiveDirectory()`.
- File entries are UTF-8 decoded. Non-UTF-8 entries return `[Cannot read binary archive entry '...' (...)]` instead of bytes.
- Text archive entries reuse the normal in-memory pagination/anchoring path.

### Profiler reports
- Recognized macOS `sample` call-tree files (`*.sample.txt`) and V8 `.cpuprofile` JSON are rendered as bottleneck summaries rather than raw dumps when valid and at most `32 MiB`.
- Line selectors page the rendered summary. `:raw` bypasses profile rendering and reads the original file.
- A file that merely has one of those names/extensions but does not parse as the expected report falls through to ordinary text handling.


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
- `read <image>?q=<question>` loads the image for the resolved vision model and returns its answer as one text block.
- Without `?q=`, image-capable active models receive a text note plus an inline image block.
- Without `?q=`, text-only active models receive metadata (MIME, bytes, dimensions, channels, alpha) plus a `?q=<question>` hint.
- `images.questionTimeoutMs` limits each delegated image question; `0` disables the timeout.
- Unsupported/undecodable image formats throw a `ToolError`.

### Internal URLs
- `read` delegates internal and MCP-advertised schemes to `InternalUrlRouter`; the built-in registry currently includes `agent://`, `artifact://`, `history://`, `issue://`, `local://`, `mcp://`, `memory://`, `omp://`, `pr://`, `rule://`, `security://`, `skill://`, `ssh://`, `vault://`, and `xd://`.
  - `security://` is reserved for the OMP-owned, producer-neutral, read-only security-analysis store.
  - `xd://` lists mounted tool devices; `xd://<name>` returns that device's input documentation. Writing JSON to the same URI dispatches the device through `write`.
  - `ssh://host/<path>` reads a remote UTF-8 file or directory; bare `ssh://` lists configured hosts. Remote paths are limited to 1 MiB and require a POSIX remote shell. Percent-encode literal `:`, `?`, or `#` in the path.
- `#handleInternalUrl()` behavior:
  - parses the URL with `parseInternalUrl()` so colons inside the host segment are legal
  - for `agent://`, treats non-root path extraction or `?q=` extraction as a special no-pagination mode
  - routes `artifact://` through a bounded artifact-file reader and large-output workflow hints
  - otherwise paginates the resolved text in memory
  - passes `immutable` through to `resolveFileDisplayMode()` so anchors are suppressed for immutable resources such as artifacts, skills, memory, and agent outputs
  - sets `ignoreResultLimits: true` for `skill://` so the full skill text is paginated only by explicit selectors, not by the normal default line limit
- `conflict://` is handled separately from the router. `<path>:conflicts` registers blocks; `conflict://<N>` reads one registered marker block, and `/ours`, `/theirs`, `/base`, or `/both` selects a side. `conflict://*` is write-only.
- `issue://<N>` / `pr://<N>` (and the long form `issue://<owner>/<repo>/<N>` / `pr://<owner>/<repo>/<N>`) route through the same SQLite cache the `github` tool writes to; `?comments=0` selects the no-comments rendering. Bare `issue://` / `pr://` (and repository-qualified variants) browse live lists with `?state=`, `?limit=`, `?author=`, and `?label=`. PR diffs use `pr://<N>/diff`, `/diff/<i>`, and `/diff/all`. Every repository-qualified form also accepts a GitHub Enterprise host prefix (`pr://ghe.example.com/<owner>/<repo>/<N>`), and a host with no dot (`pr://ghe/<owner>/<repo>/<N>`) is recognized in the numbered form. Short forms resolve the host from the session checkout, so an enterprise repo needs no prefix.
- `memory://` accepts two grammars. `memory://root[/path]` reads file-backed memory artifacts under the project memory root (`memory://root` resolves to the compact startup summary `memory_summary.md`; deeper paths address files such as `MEMORY.md` and `skills/<name>/SKILL.md`, and `memory://root/...` supports glob patterns for `glob`). `memory://<memory-id>` looks up a live Mnemopi memory row by id — working or episodic — and returns the full stored content (not the clipped recall preview) behind a YAML frontmatter header carrying `id`, `bank`, `store`, `memory_type`, `source`, `timestamp`/`created_at`, `importance`, `veracity`, `session_id`, and `metadata`. The id grammar resolves against the calling session: it needs that session on `memory.backend = mnemopi` and searches only its own scoped banks, so a row held by another live session is not reachable; with `hindsight` it returns a corrective pointer (hindsight memories are not addressable), and unknown ids error with a pointer to `recall` for the available ids. This is the read counterpart to `memory_edit update`: read the full row before overwriting a truncated preview.
- `artifact://<id>` resolves a session artifact as plain text. Selector-paginated reads stream from the backing file at any size, but unbounded `:raw` is blocked above `50 KiB` (`MAX_ARTIFACT_RAW_INLINE_BYTES`) with a workflow notice pointing at bounded ranges (`artifact://<id>:1-3000`, `artifact://<id>:raw:1-3000`) and the backing file path. Bare/non-raw reads stream a bounded default page rather than materializing the whole artifact. Protocol-level whole-resource resolution by other consumers is hard-capped at 8 MiB (`MAX_INLINE_ARTIFACT_BYTES` in `packages/coding-agent/src/internal-urls/artifact-protocol.ts`); larger artifacts reject the whole-resource read with the same selector and backing-path hints. Path-only consumers (search/grep, bash URL expansion) skip content materialization and work on artifacts of any size.

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
  - Reads archives through the unified `@oh-my-pi/pi-utils/ar` registry; ZIP is framed in `packages/utils/src/ar/zip.ts` over the `node:zlib` DEFLATE codec.
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
- Local text open-ended default line limit: `read.defaultLimit` (default `300`), clamped to `[1, DEFAULT_MAX_LINES]`.
- Single bounded non-raw text ranges add `1` leading and `3` trailing context lines on constrained sides. Raw and multi-range reads are exact.
- File streaming chunk size: `8 * 1024` bytes (`READ_CHUNK_SIZE`).
- Local streamed byte budget for line reads: `max(DEFAULT_MAX_BYTES, maxLinesToCollect * 512)`.
- Structural summaries only run when file size `<= 2 MiB` and line count `<= 20_000`.
- Profile summaries run only for recognized reports at most `32 MiB`; `:raw` bypasses them.
- Image input max: `20 MiB`.
- Directory tree caps for local directories: depth `2`, per-directory children `12`.
- Archive directory default list cap: `500` entries; archive members cap at `64 MiB`, and tar/tgz containers cap at `256 MiB`.
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
- File snapshot store holds `256` paths with up to `4` versions each (`DEFAULT_MAX_PATHS` / `DEFAULT_MAX_VERSIONS_PER_PATH` in `packages/hashline/src/snapshots.ts`); files over `4 MiB` (`SNAPSHOT_MAX_BYTES`) are not snapshotted.
- An unbounded `artifact://<id>:raw` read is refused when the artifact exceeds `50 KiB`; use a bounded `:raw:N-M` range.

## Errors
- Validation and operational failures surface as `ToolError`.
- Selector errors include:
  - `Line selector 0 is invalid; lines are 1-indexed. Use :1.`
  - invalid `A+B` / `A-B` shapes
  - `Cannot combine query extraction with line selectors` for `agent://.../path:50`
  - multi-ranges on directory/archive-directory listings
- `conflict://*` reads are rejected; unknown/stale conflict ids require re-reading `<path>:conflicts`.
- Missing local/archive/sqlite paths first attempt unique suffix resolution; if no unique match or guarded recovery exists they error.
- Out-of-bounds line reads do not throw. They return explanatory text with a suggestion such as `Use :1 ...` or `Use :<last line> ...`.
- Probable binary local files return a notice unless `:raw` was requested.
- Binary archive entries do not throw; they return a text notice.
- Document conversion failure returns a text notice.
- Image oversize/unsupported/invalid cases throw.
- SQLite parser rejects unsupported parameter combinations early; DB/runtime errors are caught and rethrown as `ToolError(message)`.
- URL fetch failure does not throw when HTTP fetch succeeds but `response.ok === false`; it returns a failed URL read with `method: "failed"` and explanatory notes.
- Large unbounded raw artifact reads return a workflow notice rather than loading the artifact into memory.

## Notes
- Hashline anchors are suppressed for raw reads and immutable internal resources because there is no editable backing target for later `edit` consumption.
- `splitPathAndSel()` intentionally treats unknown trailing `:...` as part of the path so `archive.zip:inner/file` and `db.sqlite:table:key` still work.
- `resolveReadPath()` contains macOS-specific filename fallbacks for screenshot timestamps, NFD Unicode normalization, and curly apostrophes.
- A bare `/` resolves to the session cwd, not the filesystem root.
- URL cache keys are session-scoped and normalized by requested URL + raw/rendered mode; both requested URL and final redirected URL are cached.
- URL line-range reads request `ensureArtifact: true, preferCached: true` so a later paginated read can reopen the same rendered body from artifact storage.
- Raw SQLite `q=` execution is not keyword-restricted beyond “no bound parameters”; the read tool relies on the surrounding contract to keep it read-only.
- The file snapshot store is not a read acceleration cache. It exists to verify and recover hashline edits when the file changed after the read.