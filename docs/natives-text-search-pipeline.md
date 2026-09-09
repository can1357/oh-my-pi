# Natives Text/Search Pipeline

This document maps the `@oh-my-pi/pi-natives` text/search/code surface from generated JS/TS exports to Rust N-API modules and back to JS result objects.

Terminology follows `docs/natives-architecture.md`:

- **Generated binding**: public API in `packages/natives/native/index.d.ts`.
- **Rust module layer**: N-API exports in `crates/pi-natives/src/*`.
- **Shared scan cache**: `pi-walker`-backed directory-entry cache (`crates/pi-walker/src/cache.rs`) used by discovery flows; N-API filesystem DTOs/conversions live in `crates/pi-natives/src/iofs.rs`.

## Implementation files

- `packages/natives/native/index.d.ts`
- `crates/pi-natives/src/grep.rs`
- `crates/pi-natives/src/glob.rs`
- `crates/pi-natives/src/glob_util.rs`
- `crates/pi-natives/src/fd.rs`
- `crates/pi-natives/src/iofs.rs`
- `crates/pi-walker/src/lib.rs`
- `crates/pi-walker/src/cache.rs`
- `crates/pi-natives/src/ast.rs`
- `crates/pi-natives/src/text.rs`
- `crates/pi-natives/src/highlight.rs`
- `crates/pi-natives/src/tokens.rs`

## JS API ↔ Rust export mapping

| JS API                                                                          | Rust export (`#[napi]`, snake_case -> camelCase) | Rust module    |
| ------------------------------------------------------------------------------- | ------------------------------------------------ | -------------- |
| `grep(options, onMatch?)`                                                       | `grep`                                           | `grep.rs`      |
| `search(content, options)`                                                      | `search`                                         | `grep.rs`      |
| `hasMatch(content, pattern, ignoreCase?, multiline?)`                           | `hasMatch`                                       | `grep.rs`      |
| `fuzzyFind(options)`                                                            | `fuzzyFind`                                      | `fd.rs`        |
| `glob(options, onMatch?)`                                                       | `glob`                                           | `glob.rs`      |
| `invalidateFsScanCache(path?)`                                                  | `invalidateFsScanCache`                          | `iofs.rs`      |
| `astGrep(options)`                                                              | `astGrep`                                        | `ast.rs`       |
| `astMatch(options)`                                                             | `astMatch`                                       | `ast.rs`       |
| `astEdit(options)`                                                              | `astEdit`                                        | `ast.rs`       |
| `wrapTextWithAnsi(text, width, tabWidth)`                                       | `wrapTextWithAnsi`                               | `text.rs`      |
| `truncateToWidth(text, maxWidth, ellipsis, pad, tabWidth)`                      | `truncateToWidth`                                | `text.rs`      |
| `sliceWithWidth(line, startCol, length, strict, tabWidth)`                      | `sliceWithWidth`                                 | `text.rs`      |
| `extractSegments(line, beforeEnd, afterStart, afterLen, strictAfter, tabWidth)` | `extractSegments`                                | `text.rs`      |
| `visibleWidth(text, tabWidth)`                                                  | `visibleWidth`                                   | `text.rs`      |
| `setHangulCompatJamoWidthOverride(value)`                                       | `setHangulCompatJamoWidthOverride`               | `text.rs`      |
| `highlightCode(code, lang, colors)`                                             | `highlightCode`                                  | `highlight.rs` |
| `supportsLanguage(lang)`                                                        | `supportsLanguage`                               | `highlight.rs` |
| `getSupportedLanguages()`                                                       | `getSupportedLanguages`                          | `highlight.rs` |
| `countTokens(input, encoding?)`                                                 | `countTokens`                                    | `tokens.rs`    |

## Pipeline overview by subsystem

## 1) Regex search (`grep`, `search`, `hasMatch`)

### Input/options flow

1. Callers invoke generated native exports directly; there is no package-local TS wrapper that renames `search` to `searchContent`.
2. Rust option structs in `grep.rs` deserialize camelCase fields including `ignoreCase`, `maxCount`, `maxCountPerFile`, `contextBefore`, `contextAfter`, `maxColumns`, and `timeoutMs`.
3. `grep` creates `CancelToken` from `timeoutMs` + `AbortSignal` and runs inside `task::blocking("grep", ...)`. Filesystem grep does not expose or use the shared walker cache.
4. `search` and `hasMatch` operate on provided string/`Uint8Array` content and do not scan the filesystem.

### Execution branches

- **In-memory branch**
  - `search` -> `search_sync` / search helpers over provided content bytes.
  - `hasMatch` compiles/checks pattern against provided content and returns a boolean.
  - No filesystem scan or walker cache.
- **Single-file branch**
  - `grep` resolves path, checks metadata is file, and searches that file.
- **Directory branch**
  - Rust builds a `pi_walker::WalkRequest` with `.cache(false)` hard-coded (`build_grep_walk_request`): directory searches stream while the tree is walked and never read or populate the shared scan cache.
  - The walk yields file candidates directly to searchers (`glob`/type filters run walker-side; the type filter is applied per candidate).
  - Files larger than the size cap are deferred to a trailing prefix pass that reads only the leading window into an owned buffer.

### Search/collection semantics

- Matcher selection: the Rust regex engine is tried first, then PCRE2 for features such as lookaround/backreferences. `OMP_PCRE2_JIT=0`/`false` disables PCRE2 JIT and `1` enables it; when unset, JIT is enabled except on macOS.
- Context resolution:
  - `contextBefore/contextAfter` override legacy `context`.
  - Non-content modes do not collect context.
- Output modes:
  - `content` -> one `GrepMatch` per hit.
  - `count` and `filesWithMatches` map to count-style entries (`lineNumber=0`, `line=""`, `matchCount` set).
  - `offset` and `maxCount` are applied during aggregation across sorted file results; `maxCountPerFile` can additionally prevent one hot file consuming the content-mode budget.
  - Directory streaming model (`run_streaming_grep`):
    - With a content-mode match budget (`maxCount`, no `offset`), the budget terminates the walk itself: small budgets (up to 64 matches) run a sequential early-exit walk, larger ones run a path-ordered walk that searches in windows and commits results after each window (`run_windowed_streaming_grep`), stopping once the budget is satisfied. Deterministic path-ordered first pages are preserved at every budget size.
    - Without an early-stop budget, an unordered work-stealing parallel traversal feeds searchers directly (`run_parallel_streaming_grep`); per-file results are sorted by path afterwards.
    - `maxCountPerFile` (content mode) caps matches collected per file so one hot file cannot exhaust the global `maxCount` budget before other files are reached.
    - Oversized files (beyond the 4 MiB cap) are deferred behind normal-sized results and searched over their leading window only (bounded prefix read via `read_owned_prefix`; no full-file read and no mmap — the bounded owned read avoids mmap page faults).
    - `offset` and `maxCount` are applied while aggregating per-file results; the `onMatch` callback fires after aggregation so callback and returned-result semantics match.

### Result shaping back to JS

- Rust `SearchResult`/`GrepResult` fields map to TS interfaces via N-API object conversion.
- Counters are clamped before crossing N-API where needed.
- `GrepResult.limitReached` is optional and emitted when true; `skippedOversized` counts oversized files that could not be searched even via the trailing bounded prefix pass.
- Streaming callback receives each shaped `GrepMatch` for content or count-style entries.

### Failure behavior

- `search` returns `SearchResult.error` for regex/search failures instead of throwing.
- `grep` rejects on hard errors such as invalid path or cancellation timeout/abort. Patterns rejected by both regex engines fall back to a literal search rather than producing a regex error.
- `hasMatch` returns a boolean on success; matcher construction uses the same tolerant fallback.
- Unreadable/non-regular files in multi-file scans are skipped; oversized files are counted in `skippedOversized`.

### Malformed regex handling

`grep.rs` sanitizes braces before regex compile:

- Invalid repetition-like braces are escaped (`{`/`}` -> `\{`/`\}`) when they cannot form `{N}`, `{N,}`, `{N,M}`.
- This prevents common literal-template fragments (for example `${platform}`) from failing as malformed repetition.
- A compile failure for an unclosed/unopened group triggers one targeted retry with unescaped parentheses escaped while preserving the rest of the regex.
- If both engines still reject the pattern, the entire original pattern is escaped and searched literally.

## 2) File discovery (`glob`) and fuzzy path search (`fuzzyFind`)

`glob` and `fuzzyFind` share the optional `pi-walker` scan cache; matching logic differs. Cache use defaults to `false` for both APIs.

### `glob` flow

1. Caller passes `GlobOptions` directly. `pattern` and `path` are required in the generated type.
2. Rust resolves the search path (via `pi_walker::resolve_search_path`) and normalizes the pattern via `glob_util::build_glob_pattern`, compiled into a walker-side `pi_walker::CompiledWalkGlob` filter.
3. Entry source: a `pi_walker::WalkRequest` with the glob filter pushed down walker-side; `.cache(config.cache)` selects cached vs fresh collection, and the walker's `EmptyRecheck` policy performs one fresh rescan when a cached scan filters to empty.
4. Filtering:
   - skip `.git` always;
   - skip `node_modules` unless requested (`includeNodeModules`) or pattern mentions `node_modules`;
   - apply glob match;
   - apply file-type filter; symlink `file`/`dir` filters resolve target metadata.
5. Optional sort by mtime descending (`sortByMtime`) before truncating to `maxResults`.

### `fuzzyFind` flow

1. Rust implementation lives in `fd.rs`; generated export is `fuzzyFind`.
2. Shared scan source from `pi-walker` with the same cache/no-cache split and walker-side stale-empty recheck policy.
3. Scoring:
   - exact / starts-with / contains / subsequence-based fuzzy score;
   - separator/punctuation-normalized scoring path;
   - directory bonus and deterministic tie-break (`score desc`, then `path asc`).
4. Symlink entries are excluded from fuzzy results.

### Failure behavior

- Invalid glob pattern returns an error from walker glob compilation (`pi_walker::CompiledWalkGlob`).
- Search root must resolve to an existing directory for directory discovery flows.
- Cancellation/timeouts propagate as abort errors via `CancelToken::heartbeat()` checks in walker and result-processing loops.

### Malformed glob handling

`glob_util::build_glob_pattern` is tolerant:

- normalizes `\` to `/`,
- auto-prefixes simple recursive patterns with `**/` when `recursive=true`,
- auto-closes unbalanced `{...` alternation groups before compile.

## 3) AST search/match/edit (`astGrep`, `astMatch`, `astEdit`)

`ast.rs` exposes syntax-aware code search and rewrite operations.

- `astGrep(options)` returns matches with byte/line/column coordinates and optional metavariable bindings.
- `astMatch(options)` runs the same patterns against an in-memory `source` string instead of files; `lang` is required (there is no path to infer it from), and the result keeps matches, `totalMatches`, `limitReached`, and parse errors but omits the file-count fields.
- `astEdit(options)` returns replacement changes, per-file counts, searched/touched file counts, parse errors, and whether edits were applied.
- `dryRun` defaults to true for edit options in the generated documentation.
- Options include language override, path/glob/selector, strictness, limits, parse-error policy, `signal`, and `timeoutMs`.
- For `astGrep` and `astEdit`, a directory `path` uses the shared cache for candidate discovery with configured stale-empty rechecking; a direct file `path` returns that file without traversal or cache access. `astMatch` remains in-memory.

These exports are direct native APIs used by tooling; they are not mediated by a TS wrapper in `packages/natives`.

## 4) Shared scan/cache lifecycle (`pi-walker`)

`pi-walker` owns traversal and cache policy. `crates/pi-natives/src/iofs.rs` contains only JavaScript-facing DTO conversion, error mapping, and the invalidation export.

The cache stores normalized relative entries (`path`, `fileType`, optional `mtime` and regular-file `size`) keyed by canonical search root plus the full traversal-level `WalkOptions` with the cache flag itself excluded — calls that differ only in `cache` share an entry. Keyed dimensions: hidden/gitignore and directory-pruning policy, link following, metadata detail, traversal order/depth, root emission, directory-error handling, and filesystem boundary. `WalkFilter` predicates, ranking, and result limits run after collection and do not independently partition the cache, so requests with different glob, file-type, size-threshold, or limit values can share an entry. A filter or rank that requires extra metadata can still promote the effective detail policy and thereby select a different key.

Configuration is read from environment once:

- `FS_SCAN_CACHE_TTL_MS`: cache TTL, default `1000`.
- `FS_SCAN_EMPTY_RECHECK_MS`: cached-empty recheck age, default `200`.
- `FS_SCAN_CACHE_MAX_ENTRIES`: maximum entries in the cache map, default `16`.
- `PI_WALK_WORKERS`: walker Rayon pool size, default `4`.

### Cache state transitions

1. **Disabled / miss / expired**
   - disabled requests collect fresh without reading or updating the cache;
   - enabled misses and entries at or beyond TTL collect fresh and populate it.
2. **Hit**
   - an entry younger than TTL returns cached entries and cache age.
3. **Stale-empty recheck**
   - when the caller enables configured rechecking, an empty cached query at or beyond the threshold is scanned once again.
4. **Invalidation**
   - `invalidateFsScanCache()` clears all keys;
   - `invalidateFsScanCache(path)` removes every entry whose cached root is a prefix of the target (canonicalization with parent fallback supports create/delete/rename invalidation). The binding lives in `iofs.rs` and forwards to `pi_walker::invalidate_path_string` / `pi_walker::invalidate_all`.

Cache favors low-latency repeated scans over immediate consistency. Explicit invalidation is the correctness hook after writes, edits, renames, or deletes.

## 5) ANSI text utilities (`text`)

These are pure, in-memory utilities.

### Boundaries and responsibilities

- `text.rs` owns terminal-cell semantics:
  - ANSI sequence parsing,
  - grapheme-aware width and slicing,
  - wrap/truncate/slice behavior,
  - explicit tab-width parameter on width-sensitive APIs.
- `grep.rs` line truncation (`maxColumns`) is separate:
  - simple character-boundary truncation of matched lines with `...`,
  - not ANSI-state-preserving and not terminal-cell width aware.

### Key behaviors

- `wrapTextWithAnsi`: wraps by visible width, carries active SGR codes across wrapped lines.
- `truncateToWidth`: visible-cell truncation with ellipsis policy (`Unicode`, `Ascii`, `Omit`), optional right padding.
- `sliceWithWidth`: column slicing with optional strict width enforcement.
- `extractSegments`: extracts before/after segments around an overlay while restoring ANSI state for the `after` segment.
- `setHangulCompatJamoWidthOverride(value)` controls U+3131–U+318E width correction for client-terminal compatibility: `0` uses the platform fallback, `1` forces one cell, `2` forces two, and `3` follows Unicode width.
- `sanitizeText` (ANSI/control/surrogate stripping with line-ending normalization) no longer lives in `text.rs`; it moved to `@oh-my-pi/pi-utils` as a pure-JS implementation in `packages/utils/src/sanitize-text.ts`. The native binding was removed in the same change because the JS version was competitive on the benchmarked workloads, and keeping a Rust copy forced every caller (including `pi-utils`) to pull in `@oh-my-pi/pi-natives`.
- `visibleWidth`: counts visible terminal cells using caller-supplied tab width.

### Failure behavior

Text functions generally return deterministic transformed output; errors are limited to N-API argument/string conversion boundaries.

## 6) Syntax highlighting (`highlight`)

`highlight.rs` is pure transformation; it does not use the filesystem scan cache.

### Flow

1. Caller passes `code`, optional `lang`, and ANSI color palette.
2. Rust resolves syntax by token/name lookup, extension lookup, alias table fallback, then plain-text fallback.
3. Each line is parsed with syntect `ParseState` and scope stack.
4. Scopes map to semantic color categories and ANSI color codes are injected/reset.

### Failure behavior

- Per-line parse failure does not fail the call: that line is appended unhighlighted and processing continues.
- Unknown/unsupported language falls back to plain text syntax.

## 7) Token counting (`tokens`)

`countTokens(input, encoding?)` is an in-memory utility.

- `input` may be a single string or an array of strings.
- Arrays return one aggregate count and are encoded in parallel in Rust.
- Default encoding is `O200kBase`; `Cl100kBase` is also available.
- The implementation uses ordinary tokenization, not special-token handling.

## Pure utility vs filesystem-dependent flows

| Flow                         | Filesystem access | Shared cache | Notes                                                        |
| ---------------------------- | ----------------- | ------------ | ------------------------------------------------------------ |
| `search` / `hasMatch`        | No                | No           | regex on provided bytes/string only                          |
| `text` module functions      | No                | No           | ANSI/width utilities only                                    |
| `highlight` module functions | No                | No           | syntax + ANSI coloring only                                  |
| `countTokens`                | No                | No           | tokenization only                                            |
| `astMatch`                   | No                | No           | in-memory syntax-aware match (no disk)                       |
| `astGrep` / `astEdit`        | Yes               | Always       | directory discovery is cached; a direct file path bypasses it |
| `glob`                       | Yes               | Optional     | directory scans + glob filtering (`cache` opt-in)            |
| `fuzzyFind`                  | Yes               | Optional     | directory scans + fuzzy scoring (`cache` opt-in)             |
| `grep` (file/dir path)       | Yes               | Never        | streaming uncached walk feeding searchers                    |

## End-to-end lifecycle summary

1. Caller invokes generated native export with typed options.
2. Rust validates/normalizes options and builds matcher/search config.
3. For filesystem flows, entries are scanned (cache hit/miss/rescan where applicable) then filtered/scored/searched.
4. Worker loops periodically call cancel heartbeat; timeout/abort can terminate execution.
5. Rust shapes outputs into N-API objects (`lineNumber`, `matchCount`, `limitReached`, etc.).
6. Generated bindings return typed JS objects and optional per-match callbacks for `grep`/`glob`.
