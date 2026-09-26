# glob

> Find filesystem paths by glob; use `grep` when you need content matches instead of path matches.

## Source
- Entry: `packages/coding-agent/src/tools/glob.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/glob.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/path-utils.ts` — normalize inputs; split base path vs glob (host paths and internal URLs).
  - `packages/coding-agent/src/internal-urls/url-filesystem.ts` — `InternalUrlFilesystem`, the URL filesystem native glob walks through.
  - `packages/coding-agent/src/tools/list-limit.ts` — apply result-count caps.
  - `packages/coding-agent/src/session/streaming-output.ts` — truncate text output at byte cap.
  - `packages/coding-agent/src/tools/tool-result.ts` — build `content` and `details.meta`.
  - `packages/coding-agent/src/tools/output-meta.ts` — encode limit / truncation metadata.
  - `packages/coding-agent/src/tools/tool-errors.ts` — map user-facing tool errors.
  - `packages/coding-agent/src/tools/index.ts` — register the built-in local implementation.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | `string` | No | Glob, file, directory, internal URL, or internal-URL glob — or several of those as a semicolon-delimited list (`"src/**/*.ts; test/**/*.ts"`); omitted or empty defaults to `.`. Empty entries are rejected. Semicolon-delimited lists split unconditionally; entries accidentally joined with comma or whitespace are expanded only after existence validation; existing paths containing delimiters remain literal. Each target becomes its own walk root and multi-target scans run concurrently. Internal URLs glob below their root (`local://*.md`, `omp://**/*.md`); `ssh://` is rejected because its read tier (`exec`) exceeds this tool's `read` approval. |
| `hidden` | `boolean` | No | Include hidden files. Defaults to `true`. |
| `gitignore` | `boolean` | No | Respect `.gitignore` during local native globbing. Defaults to `true`; set `false` to include gitignored files. |
| `limit` | `number` | No | Max returned paths. Defaults to `200`; finite positive inputs are floored with a minimum of `1`. Requests above `1000` are rejected; partition the pattern or scope to a deeper directory to enumerate more matches. |

`glob` is enabled by default (`glob.enabled = true`) and is an essential tool.

## Outputs
The tool returns a single text block plus structured `details`.

- Success text: matching paths grouped as a multi-level, prefix-folded directory tree (`formatGroupedPaths()`): one `#` per nesting level, single-child directory chains fold into one header (`# a/b/c/`), and files are listed bare under the deepest owning header; root-level matches are listed without a header. Directory matches carry a trailing `/`. Exact file inputs return that file path as one line.
- Empty result text: `No files found matching pattern`, optionally followed by a timeout or missing-path notice.
- Multi-path partial miss: appends `Skipped missing paths: ...` after the result block, or after the empty-result line.
- Result limit reached: below the maximum, `meta.limits.resultLimit` suggests a retry of `min(2 × limit, 1000)` (rendered as `Use limit=N for more`); at `limit: 1000` the text instead ends with `[1000 results maximum reached. Partition the pattern or scope to a deeper directory for more]` and no retry limit is suggested.
- `details` may include:
  - `scopePath`: display form of the searched root or merged roots.
  - `fileCount`: number of paths returned after result limiting.
  - `files`: returned paths as an array.
  - `truncated`: whether result count or byte truncation occurred.
  - `resultLimitReached`: reached result limit.
  - `missingPaths`: skipped missing inputs in multi-path calls.
  - `truncation` / `meta.limits`: structured truncation and limit metadata for renderers.
- Streaming: when the runtime supplies `onUpdate`, the local implementation emits incremental newline-delimited text snapshots during globbing, throttled to 200 ms. Final output is grouped; streaming snapshots are not.

## Flow

1. `GlobTool.execute()` converts the optional semicolon-delimited `path` string into roots (default `.`). Unless custom operations are injected, it expands the roots with `expandDelimitedPathEntries(..., parseFindPattern)`: existing delimiter-containing paths stay intact, semicolon-delimited lists split unconditionally, comma splits are accepted when at least one part resolves, and whitespace splits only when every part resolves.
2. The tool normalizes each entry with `normalizePathLikeInput()`, `/\\/g -> "/"`, and `router.normalize()` (single-slash URL aliases). Empty normalized entries fail with `` `path` must contain non-empty globs or paths ``. It builds one `InternalUrlFilesystem` from `sessionResolveContext()` at the call's approval tier (`read`).
3. For multi-path local calls, `partitionExistingPaths(..., parseFindPattern, urlFilesystem)` (`packages/coding-agent/src/tools/path-utils.ts`) stats each base path through the URL filesystem. Missing entries are skipped; if all are missing, the tool throws `Path not found: ...`. Single missing paths still hard-fail.
4. The tool calls `resolveExplicitFindPatterns()` for multi-entry calls; it parses each entry into its own `(basePath, globPattern, hasGlob)` target so every path is walked as its own root (collapsing to a shared ancestor would scan unrelated siblings). Single-entry calls parse with `parseFindPattern()` directly.
5. `parseFindPattern()` determines `(basePath, globPattern, hasGlob)`:
   - no glob chars (`*`, `?`, `[`, `{`) => search that path with implicit `**/*`.
   - glob in the first segment => search from `.` and, unless the pattern already starts with `**/`, prefix it with `**/`.
   - glob later in the path => split at the first glob-bearing segment.
   - internal URL => split below its `scheme://` root like a later-segment glob (`local://*.md` → base `local://`, non-recursive `*.md`); the glob tail is percent-decoded with encoded metacharacters kept literal, and `router.isGlob()` keeps queries, fragments, and host authorities out of the glob.
6. `resolveSearchBase()` converts the base path to an absolute path under the session cwd; internal URLs stay URLs. A resolved `/` is rejected with `Searching from root directory '/' is not allowed`.
7. `limit` defaults to `DEFAULT_LIMIT` (`200`), must be positive and finite, and is floored with a minimum of `1`; values above `MAX_LIMIT` (`1000`) are rejected before scanning. `hidden` and `gitignore` both default to `true`. An internal timeout of `5` seconds (`5000` ms) is built via `AbortSignal.timeout(...)`.
8. Execution then branches:
   - **Custom operations branch**: if `GlobToolOptions.operations.glob` exists, the tool checks existence with `operations.exists()`, short-circuits exact-file inputs via `operations.stat()` when available, then calls `operations.glob(globPattern, searchPath, { ignore: ["**/node_modules/**", "**/.git/**"], limit })`.
   - **Built-in local branch**: the tool stats each target's `searchPath` (URL targets through the URL filesystem). Exact-file inputs return immediately. Directory inputs call `natives.glob()` with `hidden`, `maxResults: effectiveLimit`, `sortByMtime: true`, `gitignore: useGitignore`, `recursive: false` (recursion comes from the `**/` prefix `parseFindPattern()` adds), the combined abort signal, and `filesystem: urlFilesystem.shellFilesystem()` so URL roots walk natively; multi-target calls run their globs concurrently.
9. In the local branch, optional `onMatch` callbacks convert each match to a display path (cwd-relative for host paths, a full URL with percent-encoded segments below a URL root via `resolveSearchResultPath()`) and emit throttled progress updates.
10. After native glob returns, JS merges per-target results, deduplicates repeated display paths, and sorts the merged list by `mtime` descending before formatting paths.
11. `buildResult()` applies `applyListLimit()` to cap the array again at `effectiveLimit`, formats paths with `formatGroupedPaths()` (from `@oh-my-pi/pi-utils`), appends notices, then runs `truncateHead()` with `maxLines: Number.MAX_SAFE_INTEGER`. In practice this leaves the 50 KB byte cap in place while disabling the default 3000-line cap.
12. `toolResult()` packages text plus `details`, and records result-limit / truncation metadata for renderers. The result-limit retry suggestion is capped at `MAX_LIMIT` so the advertised follow-up is always accepted.

## Modes / Variants
- **Exact file path**: if the parsed input has no glob and the resolved path stats as a file, output is that one path.
- **Directory path**: if the parsed input has no glob and stats as a directory, the tool searches it with implicit `**/*`.
- **Single glob path**: one input parsed by `parseFindPattern()`.
- **Multi-path search**: multiple inputs resolved by `resolveExplicitFindPatterns()` into per-entry targets, each walked as its own root concurrently and merged afterwards.
- **Partial multi-path search with missing inputs**: local multi-path calls skip missing base paths and surface them as `missingPaths` / `Skipped missing paths: ...`.
- **Internal URL input**: native glob walks URLs through the URL filesystem: file-backed schemes (`skill://<name>` walks the skill directory, `local://notes/*.md`, `memory://root/**/*.md`) redirect to their host files, virtual schemes list their rendered entries (`omp://tools/*.md`). Results are full URLs. Schemes above the `read` tier (`ssh://`) are refused before any handler resolves them, so remote hosts are never contacted.
- **Custom delegated search**: uses injected `GlobOperations` instead of local fs + native glob.

## Side Effects
- Filesystem
  - Stats the resolved base path, and in local multi-path mode stats every candidate base path up front.
  - Does not write files.
- Subprocesses / native bindings
  - Built-in local mode calls the native `@oh-my-pi/pi-natives` glob implementation.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Emits structured progress updates when `onUpdate` is provided.
  - Adds truncation / limit metadata to the tool result.
- Background work / cancellation
  - Local globbing is cancellable through the caller abort signal plus the internal timeout.

## Limits & Caps
- Default result limit: `200` (`DEFAULT_LIMIT` in `packages/coding-agent/src/tools/glob.ts`).
- Maximum requested result limit: `1000` (`MAX_LIMIT`); larger requests fail with instructions to partition the pattern or scope to a deeper directory instead of being silently clamped or risking excessive native allocations.
- Local glob timeout: fixed at `5000` ms.
- Output byte cap: `50 * 1024` bytes (`DEFAULT_MAX_BYTES` in `packages/coding-agent/src/session/streaming-output.ts`).
- Default generic line cap in `truncateHead()` is `3000`, but `glob` overrides `maxLines` to `Number.MAX_SAFE_INTEGER`, so byte size — not line count — is the practical output truncation cap.
- Streaming update throttle: `200` ms between `onUpdate` emissions.
- Sort order: most recent `mtime` first in the built-in local branch and promised in the prompt. The tool re-sorts in JS even though native glob receives `sortByMtime: true` so native code can still stop early at `maxResults`.

## Errors
- User-facing `ToolError`s from `GlobTool.execute()` include:
  - `` `path` must contain non-empty globs or paths ``
  - `Path not found: ...`
  - `Searching from root directory '/' is not allowed`
  - `Limit must be a positive number`
  - `Path is not a directory: ...`
  - timeout result text is `glob timed out after <seconds>s; returning <N> partial matches — narrow the pattern instead of retrying blindly` and is returned as a successful, truncated partial result rather than an error.
  - `Cannot glob <url>: <reason>` when a URL target cannot be stat'ed through the URL filesystem: the handler's diagnosis (`Cannot glob artifact://9: Artifact 9 not found. Available: …`; `skill:// URL requires a skill name` for `skill://*/SKILL.md`) or the tier refusal (`ssh:// access needs exec approval; …`).
- If the caller aborts, the local branch converts `AbortError` into `ToolAbortError`.
- Non-`ENOENT` stat failures and other unexpected errors are rethrown.
- Empty matches are not errors; they return the no-files text result.

## Notes
- Reach for `glob` for filename / path discovery. Reach for `grep` when the selection criterion is file contents or regex matches; `grep` takes a `pattern` and returns anchored content matches, while `glob` only returns matching paths (`packages/coding-agent/src/prompts/tools/glob.md`, `packages/coding-agent/src/prompts/tools/grep.md`).
- Bare top-level globs are made recursive. `*.ts` is parsed as base `.` plus glob `**/*.ts`; `src/*.ts` stays rooted at `src` with a non-recursive `*.ts` segment; `src/**/*.ts` preserves explicit recursion.
- `.gitignore` defaults to enabled in the built-in local branch. Use `gitignore: false` to disable it for native traversal.
- `hidden` defaults to `true`; hidden-file exclusion is opt-out, not opt-in.
- Multi-path missing-input tolerance applies in both branches, but only the built-in local branch surfaces `missingPaths` / `Skipped missing paths: ...`. The custom-operations branch hard-fails a missing `searchPath` only for single-input calls; in multi-input calls a missing target silently contributes no results.
- The custom `GlobOperations.glob()` hook receives `ignore` and `limit`, but not the `hidden` flag or an explicit `.gitignore` toggle. A remote delegate must account for that itself if it wants parity with the local branch.
- Built-in local globbing does not force `fileType: File`; it can return files and directories from native glob. Directory outputs also occur through exact-path passthrough or custom delegates that return them.