# glob

> Find filesystem paths by glob; use `grep` when you need content matches instead of path matches.

## Source
- Entry: `packages/coding-agent/src/tools/glob.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/glob.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/path-utils.ts` — normalize inputs; split base path vs glob (host paths and internal URLs).
  - `packages/coding-agent/src/internal-urls/url-filesystem.ts` — `InternalUrlFilesystem`, the URL filesystem native glob walks through.
  - `packages/tui/src/tools/list-limit.ts` — apply result-count caps.
  - `packages/tui/src/tools/streaming-output.ts` — truncate text output at byte cap.
  - `packages/coding-agent/src/tools/tool-result.ts` — build `content` and `details.meta`.
  - `packages/tui/src/tools/output-meta.ts` — limit / truncation metadata.
  - `packages/tui/src/tools/tool-errors.ts`, `packages/coding-agent/src/tools/tool-errors.ts` — user-facing errors and cancellation.
  - `packages/coding-agent/src/tools/index.ts` — register the built-in local implementation.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | `string` | No | Glob, file, directory, internal URL, or internal-URL glob; host paths can form a semicolon-delimited list (`"src/**/*.ts; test/**/*.ts"`). Omitted defaults to `.`; an explicit empty string is rejected. The registered built-in also treats slash-only inputs such as `/` as the session cwd. Existing delimiter-containing paths stay literal; otherwise semicolon splitting needs no existence check, while comma/whitespace splitting is existence-validated. Each target becomes its own walk root and multi-target scans run concurrently. Internal URLs glob below their root (`local://*.md`, `omp://**/*.md`); `ssh://` requires `exec` approval and is rejected at this tool's `read` tier. |
| `hidden` | `boolean` | No | Include hidden files. Defaults to `true`. |
| `gitignore` | `boolean` | No | Respect `.gitignore` during local native globbing. Defaults to `true`; set `false` to include gitignored files. |
| `limit` | `number` | No | Max returned paths. Defaults to `200`; finite positive inputs are floored then clamped to `1..200`. |

`glob` is enabled by default (`glob.enabled = true`) and is an essential tool.

## Outputs
The tool returns a single text block plus structured `details`.

- Success text: matching paths grouped as a multi-level, prefix-folded directory tree (`formatGroupedPaths()`): one `#` per nesting level, single-child directory chains fold into one header (`# a/b/c/`), and files are listed bare under the deepest owning header; root-level matches are listed without a header. Directory matches carry a trailing `/`. Exact file inputs return that file path as one line.
- Empty completed scan: `No files found matching pattern`, optionally followed by a missing-path notice; marked `useless`.
- Timed-out scans return a successful, truncated partial result. With no matches, only an incomplete-scan notice is returned, never a claim of absence; that result is also marked `useless`.
- Nonempty results with `limit > 200` include `Requested limit <N> clamped to the max of 200`. At the hard cap, no unusable larger-limit suggestion is emitted.
- Multi-path partial miss: appends `Skipped missing paths: ...` after the result block, or after the empty-result line.
- `details` may include:
  - `scopePath`: display form of the searched root or merged roots; `cwd`: hyperlink base.
  - `fileCount`: number of paths returned after result limiting.
  - `files`: returned paths as an array.
  - `truncated`: whether result count or byte truncation occurred.
  - `resultLimitReached`: reached result limit.
  - `missingPaths`: skipped missing inputs in multi-path calls.
  - `truncation` / `meta.limits`: structured truncation and limit metadata for renderers.
- Streaming: when the runtime supplies `onUpdate`, the local implementation emits incremental newline-delimited text snapshots during globbing, throttled to 200 ms. Final output is grouped; streaming snapshots are not.

## Flow

1. `GlobTool.execute()` normalizes the optional `path` string into roots (omitted defaults to `.`). Unless custom operations are injected, `expandDelimitedPathEntries(..., parseFindPattern)` preserves existing delimiter-containing paths and internal-URL inputs. Other compound entries split on semicolons without checking each part, on commas when at least one part resolves, or on whitespace when every part resolves.
2. The tool normalizes each entry with `normalizePathLikeInput()`, `/\\/g -> "/"`, and `router.normalize()` (single-slash URL aliases). The registered factory sets `rootPathAlias: true`, remapping slash-only inputs to `.`. Other roots resolving to `/` are rejected. Empty normalized entries fail with `` `path` must contain non-empty globs or paths ``. It builds one `InternalUrlFilesystem` from `sessionResolveContext()` at the call's approval tier (`read`).
3. For multi-path local calls, `partitionExistingPaths(..., parseFindPattern, urlFilesystem)` (`packages/coding-agent/src/tools/path-utils.ts`) stats each base path through the URL filesystem. Missing entries are skipped; if all are missing, the tool throws `Path not found: ...`. Single missing paths still hard-fail.
4. The tool calls `resolveExplicitFindPatterns()` for multi-entry calls; it parses each entry into its own `(basePath, globPattern, hasGlob)` target so every path is walked as its own root (collapsing to a shared ancestor would scan unrelated siblings). Single-entry calls parse with `parseFindPattern()` directly.
5. `parseFindPattern()` determines `(basePath, globPattern, hasGlob)`:
   - no glob chars (`*`, `?`, `[`, `{`) => search that path with implicit `**/*`.
   - glob in the first segment => search from `.` and, unless the pattern already starts with `**/`, prefix it with `**/`.
   - glob later in the path => split at the first glob-bearing segment.
   - internal URL => split below its `scheme://` root like a later-segment glob (`local://*.md` → base `local://`, non-recursive `*.md`); the glob tail is percent-decoded with encoded metacharacters kept literal, and `router.isGlob()` keeps queries, fragments, and host authorities out of the glob.
6. `resolveSearchBase()` converts the base path to an absolute path under the session cwd; internal URLs stay URLs. A remaining resolved `/` is rejected with `Searching from root directory '/' is not allowed`. A directly constructed `GlobTool` without `rootPathAlias` also rejects slash-only inputs.
7. `limit` defaults to `DEFAULT_LIMIT` (`200`), must be positive and finite, is floored, then clamped to `MAX_LIMIT` (`200`). `hidden` and `gitignore` both default to `true`. An internal timeout of `5` seconds (`5000` ms) is built via `AbortSignal.timeout(...)`.
8. Execution then branches:
   - **Custom operations branch**: if `GlobToolOptions.operations.glob` exists, the tool checks existence with `operations.exists()`, short-circuits exact-file inputs via `operations.stat()` when available, then calls `operations.glob(globPattern, searchPath, { ignore: ["**/node_modules/**", "**/.git/**"], limit })`.
   - **Built-in local branch**: the tool stats each target's `searchPath` (URL targets through the URL filesystem). Exact-file inputs return immediately. Directory inputs call `natives.glob()` with `hidden`, `maxResults: effectiveLimit`, `sortByMtime: true`, `gitignore: useGitignore`, `recursive: false` (recursion comes from the `**/` prefix `parseFindPattern()` adds), the combined abort signal, and `filesystem: urlFilesystem.shellFilesystem()` so URL roots walk natively; multi-target calls run their globs concurrently.
9. In the local branch, optional `onMatch` callbacks convert each match to a display path (cwd-relative for host paths, a full URL with percent-encoded segments below a URL root via `resolveSearchResultPath()`) and emit throttled progress updates.
10. After native glob returns, JS merges per-target results, deduplicates repeated display paths, and sorts the merged list by `mtime` descending before formatting paths.
11. `buildResult()` applies `applyListLimit()` to cap the array again at `effectiveLimit`, formats paths with `formatGroupedPaths()` (from `@oh-my-pi/pi-utils`), appends timeout/clamp/missing-path notices, then runs `truncateHead()` with `maxLines: Number.MAX_SAFE_INTEGER`. In practice this leaves the 50 KiB byte cap in place while disabling the default 3000-line cap.
12. `toolResult()` packages text plus `details`, and records result-limit / truncation metadata for renderers.

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
- Maximum result limit: `200` (`MAX_LIMIT`); larger inputs are clamped.
- Local glob timeout: fixed at `5000` ms.
- Output byte cap: `50 * 1024` bytes (`DEFAULT_MAX_BYTES` in `packages/tui/src/tools/streaming-output.ts`).
- Default generic line cap in `truncateHead()` is `3000`, but `glob` overrides `maxLines` to `Number.MAX_SAFE_INTEGER`, so byte size — not line count — is the practical output truncation cap.
- Streaming update throttle: `200` ms between `onUpdate` emissions.
- Sort order: most recent `mtime` first before directory grouping in the built-in local branch. The tool re-sorts merged native results in JS. Mtime ranking still requires walking the searched tree; a narrow filename pattern over a huge root does not avoid that cost.

## Errors
- User-facing `ToolError`s from `GlobTool.execute()` include:
  - `` `path` must contain non-empty globs or paths ``
  - `Path not found: ...`
  - `Searching from root directory '/' is not allowed`
  - `Limit must be a positive number`
  - `Path is not a directory: ...`
  - Timeout returns partial matches with an incomplete-scan notice directing the caller to a deeper directory. With zero matches it explicitly says the scan is `NOT proof of absence`. It is a successful truncated result, not a thrown error.
  - `Cannot glob <url>: <reason>` when a URL target cannot be stat'ed through the URL filesystem: the handler's diagnosis (`Cannot glob artifact://9: Artifact 9 not found. Available: …`; `skill:// URL requires a skill name` for `skill://*/SKILL.md`) or the tier refusal (`ssh:// access needs exec approval; …`).
- If the caller aborts, the local branch converts `AbortError` into `ToolAbortError`.
- Non-`ENOENT` stat failures and other unexpected errors are rethrown.
- Empty matches are not errors; they return the no-files text result.

## Notes
- Reach for `glob` for filename / path discovery. Reach for `grep` when the selection criterion is file contents or regex matches; `grep` takes a `pattern` and returns anchored content matches, while `glob` only returns matching paths (`packages/coding-agent/src/prompts/tools/glob.md`, `packages/coding-agent/src/prompts/tools/grep.md`).
- Bare top-level globs are made recursive. `*.ts` is parsed as base `.` plus glob `**/*.ts`; `src/*.ts` stays rooted at `src` with a non-recursive `*.ts` segment; `src/**/*.ts` preserves explicit recursion.
- An input beginning with an internal URL is preserved rather than delimiter-expanded. Use separate calls for multiple URL scopes instead of joining them into one semicolon string.
- `.gitignore` defaults to enabled in the built-in local branch. Use `gitignore: false` to disable it for native traversal.
- `hidden` defaults to `true`; hidden-file exclusion is opt-out, not opt-in.
- Multi-path missing-input tolerance applies in both branches, but only the built-in local branch surfaces `missingPaths` / `Skipped missing paths: ...`. The custom-operations branch hard-fails a missing `searchPath` only for single-input calls; in multi-input calls a missing target silently contributes no results.
- The custom `GlobOperations.glob()` hook receives `ignore` and `limit`, but not the `hidden` flag or an explicit `.gitignore` toggle. A remote delegate must account for that itself if it wants parity with the local branch.
- Built-in local globbing does not force `fileType: File`; it can return files and directories from native glob. A directory path is a recursive search scope, not exact-directory passthrough.