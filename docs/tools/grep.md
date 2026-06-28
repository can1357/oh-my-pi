# grep

> Grep file contents with a regex across files, directories, globs, and internal URLs.

## Source
- Entry: `packages/coding-agent/src/tools/grep.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/grep.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/match-line-format.ts` — model-facing anchor formatting.
  - `packages/coding-agent/src/tools/path-utils.ts` — path normalization, glob splitting, internal URL resolution.
  - `packages/coding-agent/src/tools/file-recorder.ts` — file ordering for grouped output.
  - `packages/coding-agent/src/tools/grouped-file-output.ts` — grouped per-file text layout.
  - `packages/coding-agent/src/session/streaming-output.ts` — line truncation and final byte truncation.
  - `packages/coding-agent/src/config/settings-schema.ts` — default context lines.
  - `packages/natives/native/index.d.ts` — native `grep()` types exposed to TS.
  - `crates/pi-natives/src/grep.rs` — native regex/file search implementation.
  - `docs/natives-text-search-pipeline.md` — native search pipeline overview.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `pattern` | `string` | Yes | Regex pattern. `grep.ts` rejects whitespace-only input but otherwise preserves the pattern verbatim (leading/trailing whitespace is meaningful in regexes). The native matcher enables multiline only when the pattern text contains a literal newline or the two-character sequence `\\n`. The native layer auto-escapes braces that cannot be valid repetition quantifiers, so patterns like `${platform}` stay searchable (see Notes). |
| `paths` | `string \| string[]` | No | One file path, directory path, glob-like path, archive member, internal URL, or an array of those. Omitted or empty defaults to `.` (the workspace root). Append a line-range selector such as `:50-100` or `:5-16,960-973` to a single file/archive/internal-resource input to constrain matches. Empty strings are rejected after trimming/quote stripping. Single entries accidentally joined with comma, semicolon, or whitespace are expanded only after existence validation; existing paths containing delimiters stay intact. Filesystem-backed internal URLs search their backing file; virtual internal resources search resolved text in memory. Internal URLs cannot contain glob characters. |
| `case` | `boolean` | No | Case-sensitive search. Defaults to `true`. Passed to native `ignoreCase` or JS `RegExp` flags for virtual resources. |
| `gitignore` | `boolean` | No | Respect `.gitignore` during directory scans. Defaults to `true`. Passed to native `gitignore`. |
| `skip` | `number` | No | File-page offset for multi-file results. Defaults to `0`; `grep.ts` floors finite numbers and rejects negative or non-finite values. Single-file searches ignore it because they do not paginate by file. |

## Outputs
The tool returns a single text block in `content[0].text` plus structured `details`.

- Match lines are formatted by `formatMatchLine()` as `*LINE:content` for matches and ` LINE:content` for context under a `[PATH#TAG]` header in hashline mode.
  - Hashline mode: `[src/login.ts#1F2A]`, `*5:content`, ` 9:content`.
  - Plain mode: `*5|content`, ` 9|content`.
- Directory and multi-file results are grouped through `formatGroupedFiles()` as a multi-level, prefix-folded directory tree: one `#` per nesting level, directory headers end with `/`, and file headers carry a `#TAG` suffix when editable hashline anchors are available.
- `details` may include:
  - `scopePath` — formatted search scope.
  - `matchCount`, `fileCount`, `files`, `fileMatches` — counts for the returned page.
  - `fileLimitReached` — more matching files remain beyond the current 20-file page.
  - `perFileLimitReached` — a hot file was trimmed to the per-file match cap.
  - `linesTruncated` — one or more matched lines were shortened to `512` chars plus `…`.
  - `truncated` and `meta.truncation` — final text output was head-truncated by `truncateHead()`.
  - `displayContent` — TUI-only rendering text with `│` gutters instead of model anchors.
  - `missingPaths` — multi-path entries skipped because their base path did not exist.
- No-match result text is `No matches found` (or `No more results (...)` when `skip` points past the last file page), optionally followed by skipped missing-path, unreadable-archive, or oversized-file notes.

## Flow
1. `GrepTool.execute()` validates and normalizes input in `packages/coding-agent/src/tools/grep.ts`:
   - rejects whitespace-only patterns while preserving the pattern verbatim;
   - defaults omitted or empty `paths` to `["."]` (the workspace root);
   - normalizes `skip` to a non-negative integer;
   - expands delimiter-flattened `paths` entries with `expandDelimitedPathEntries()`, keeping existing delimiter-containing paths intact, accepting comma/semicolon splits when at least one part resolves, and accepting whitespace splits only when every part resolves;
   - peels any line-range selector from each resulting entry;
   - reads `grep.contextBefore` and `grep.contextAfter` from session settings (`1` and `3` by default);
   - enables multiline only when `pattern` contains `\n` or an actual newline.
2. Each `paths` entry is normalized with `normalizePathLikeInput()` again during shared scope resolution; this is a no-op for entries already normalized by delimiter expansion.
3. Archive member paths such as `bundle.zip:src/foo.ts` are materialized to temporary UTF-8 scratch files before native grep. Binary or non-UTF-8 archive members are reported as skipped/unreadable.
4. Internal URLs are resolved before filesystem scope resolution:
   - glob metacharacters (`*`, `?`, `[`, `{`) are rejected for internal URLs;
   - resources with `sourcePath` are searched through their backing file;
   - resources without `sourcePath` are searched in memory with JavaScript `RegExp`;
   - `omp://` expands to every embedded documentation file via URL completion;
   - immutable sources are tracked so output can suppress editable hashline numbered output per file.
5. For multi-path calls, `partitionExistingPaths()` skips only ENOENT entries. If every filesystem entry is missing and no virtual internal resources remain, the tool errors.
6. Path resolution branches:
   - one entry: `parseSearchPath()` splits `basePath` and optional glob;
   - multiple entries: `resolveExplicitSearchPaths()` (via `resolveToolSearchScope()`) computes a common base directory, brace-union glob, exact-file list, or per-entry target list. Targets fan out when the common ancestor is not itself a requested scope, or when a plain-file entry would otherwise be demoted into a directory walk's glob union (`fanOutFileTargets`).
7. Line-range selectors are validated after path/archive/internal resolution. They are allowed only for single files, archive members, or virtual resources; glob/directory line-range selectors error.
8. `grep.ts` stats the resolved base path to decide file vs directory behavior.
9. It calls native `grep()` from `@pk-nerdsaver-ai/pi-natives` with:
   - `pattern`, `ignoreCase`, `multiline`, `gitignore`;
   - `hidden: true`;
   - `cache: false`;
   - `contextBefore` / `contextAfter` from settings;
   - `maxColumns: DEFAULT_MAX_COLUMN` (`512`);
   - `maxCount: INTERNAL_TOTAL_CAP` (`2000`);
   - `maxCountPerFile`: the per-file match cap plus one;
   - `mode: content`;
   - the combined abort `signal` and `timeoutMs: SEARCH_GREP_TIMEOUT_MS` (`30_000`).
10. Native execution happens in `crates/pi-natives/src/grep.rs`:
   - `build_matcher()` sanitizes non-quantifier braces before regex compile;
   - if compile fails with unopened/unclosed-group errors, it retries after escaping previously unescaped parentheses;
   - directory scans use the grep pipeline described in `docs/natives-text-search-pipeline.md`.
11. Grep dispatch differs by resolved path set:
   - exact explicit files or fanned-out multi-targets: JS loops over targets, merges `grep()` results itself, and deduplicates overlapping targets by absolute path + line number;
   - single file/directory base: one `grep()` call handles native scanning.
12. Virtual internal resources are searched in JS with `RegExp`; archive scratch paths and virtual paths are remapped back to user-facing selectors before rendering.
13. JS output shaping then:
   - caps multi-file output to 20 files per page (`DEFAULT_FILE_LIMIT`), using `skip` as the next file offset;
   - caps matches per file to 20 for multi-file scopes and 200 for single-file scopes;
   - round-robins selected per-file matches so one file does not monopolize the page;
   - formats lines through `formatMatchLine()` for the model and `formatCodeFrameLine()` for TUI;
   - in hashline mode, records a whole-file snapshot per rendered file with `recordFileSnapshot()` to mint the `#TAG` anchor (archive, virtual, and immutable paths are skipped).
14. Final text is passed through `truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER })`, so the effective cap is the default byte cap from `streaming-output.ts`, not the default line cap.
15. `toolResult()` attaches text plus limit/truncation metadata.

## Modes / Variants
1. **Single file path**
   - `grep()` searches one file.
   - Output is a flat list of match/context lines.
   - Visible limit is the first `200` matches after native matching and JS per-file capping.
2. **Single directory path or single glob-like path**
   - `parseSearchPath()` may split the input into `path` + `glob`.
   - One native `grep()` scans the directory tree with `gitignore` and `hidden:true`.
   - Results are grouped into a 20-file page; use `skip` with the next file offset shown in the limit message.
   - JS round-robins the selected files' matches.
3. **Multiple explicit paths/globs**
   - `resolveExplicitSearchPaths()` collapses them into a common base and either a brace-union glob, an explicit file list, or per-target searches when the common ancestor is not itself a requested scope (or a plain-file entry would be demoted into a directory walk).
   - Missing entries are skipped non-fatally unless all are missing.
4. **Archive member paths**
   - Supported for UTF-8 text entries only. The member is extracted to a temporary scratch file for native grep, then displayed as `archive.ext:member`.
5. **Internal URL paths**
   - Filesystem-backed resources search their resolved `sourcePath`.
   - Virtual resources without `sourcePath` search their resolved content in memory.
   - `omp://` expands to all embedded documentation files so it can be used as a docs search root.
   - No internal-URL globbing.
   - Immutable and virtual sources suppress editable hashline anchors.

## Side Effects
- Filesystem
  - Stats resolved search roots and input paths.
  - Reads matched files through native `grep()`.
  - Records whole-file snapshots into the session file-snapshot store via `recordFileSnapshot()` for hashline anchors.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Reads session settings for context defaults.
  - Uses `session.internalRouter` to resolve internal URLs.
  - Populates tool `details.meta` with truncation/limit metadata.
- Background work / cancellation
  - Wrapped in `untilAborted(signal, ...)` at the JS level.
  - `grep.ts` passes the abort `signal` and `timeoutMs: SEARCH_GREP_TIMEOUT_MS` (`30_000`) into native `grep()`, so native scans are cancellable and time-bounded.

## Limits & Caps
- File page limit: `20` files (`DEFAULT_FILE_LIMIT` in `packages/coding-agent/src/tools/grep.ts`).
- Per-file match caps: `20` for multi-file scopes (`MULTI_FILE_PER_FILE_MATCHES`), `200` for single-file scopes (`SINGLE_FILE_MATCHES`).
- Native/JS preselection cap: `2000` matches (`INTERNAL_TOTAL_CAP`).
- Line truncation: `512` characters per emitted line (`DEFAULT_MAX_COLUMN` in `packages/coding-agent/src/session/streaming-output.ts`). Native grep marks truncated lines; JS reports `linesTruncated`.
- Final text truncation: `truncateHead()` default byte cap `50 * 1024` bytes (`DEFAULT_MAX_BYTES` in `packages/coding-agent/src/session/streaming-output.ts`). `grep.ts` overrides `maxLines` to `Number.MAX_SAFE_INTEGER`, so normal grep output is byte-capped, not line-capped.
- Context defaults: `grep.contextBefore = 1`, `grep.contextAfter = 3` in `packages/coding-agent/src/config/settings-schema.ts`.
- Pagination: `skip` is a file-page offset for multi-file scopes. The result text says `Use skip=<N> for the next page` when more files remain.
- Native directory-scan cache: available in `grep.rs`, but this tool always sets `cache: false`.
- Native grep wall-clock budget: `30_000ms` per invocation (`SEARCH_GREP_TIMEOUT_MS` in `packages/coding-agent/src/tools/grep.ts`); hitting it raises `Grep timed out after 30s; ...`.
- Native per-file size cap: `4 * 1024 * 1024` bytes (`MAX_FILE_BYTES` in `crates/pi-natives/src/grep.rs`, mirrored as `NATIVE_GREP_MAX_FILE_BYTES` in `grep.ts`). Oversized files are silently skipped by native grep; `grep.ts` surfaces a `Skipped oversized file(s)` note (with names for explicit file targets, a count for directory scans).

## Errors
- `Pattern must not be empty` when trimmed `pattern` is empty.
- `Skip must be a non-negative number` for negative or non-finite `skip`.
- `` `paths` must contain non-empty paths or globs `` when any normalized path is empty.
- `Glob patterns are not supported for internal URLs: ...` for internal URL + glob metacharacters.
- Line-range selector errors include `Line-range selector requires a single file, not a glob: ...`, `Line-range selector requires a single file: ... is a directory`, and `Path not found for line-range selector: ...`.
- `Cannot search archive member(s): ...` when all archive selectors are unreadable, binary, or non-UTF-8.
- `Path not found: ...; pass each path as its own array element` when a filesystem-backed resolved base path is missing, or when every multi-path filesystem entry is missing (with an archive hint when unreadable archive members contributed).
- Virtual internal URL regex compile failures are reported as `Invalid regex: ...` from JavaScript `RegExp`; filesystem-backed regex failures beginning with `regex` or `regex parse error` are normalized to `Invalid regex: ...`.
- Multi-file native scans skip per-file open/search failures inside `grep.rs`; the scan continues with surviving files.
- ``Grep timed out after 30s; narrow paths or pattern, or scope with `glob` first`` when native grep hits `SEARCH_GREP_TIMEOUT_MS`.

## Notes
- The model-facing prompt documents Rust regex syntax (RE2-style; no lookaround or backreferences). Filesystem-backed searches use that native engine; virtual internal URL content is searched with JavaScript `RegExp`.
- Native `build_matcher()` already auto-escapes braces that cannot be valid quantifiers, so patterns like `${platform}` become searchable instead of failing. Valid quantifiers like `a{2,4}` remain unchanged.
- Native compile retry also escapes unescaped literal parentheses only after an unopened/unclosed-group parse error. It is a fallback, not a general parser mode.
- Internal URLs are resolved before path existence checks. Backed resources become ordinary filesystem paths; virtual resources stay in memory and do not mint editable hashline anchors.
- `hidden:true` is hard-coded in `grep.ts`; there is no model-facing flag to exclude dotfiles.
- `gitignore:false` only affects native directory traversal. It does not disable the tool's own path normalization or explicit-file handling.
- When `paths` resolves to multiple exact files, each target uses the `2000` internal cap before JS grouping.
- The section tag in hashline mode is a four-hex opaque snapshot tag from the session snapshot store; `grep` records whole-file snapshots when possible and prints bare line numbers beneath the header.
