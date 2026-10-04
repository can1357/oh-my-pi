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
- `crates/pi-ast/src/ops.rs`
- `crates/pi-natives/src/shell/vfs.rs`
- `crates/pi-vfs/`
- `crates/pi-natives/src/text.rs`
- `crates/pi-natives/src/highlight.rs`
- `crates/pi-natives/src/tokens.rs`
- `crates/pi-natives/src/utok/`

## JS API ↔ Rust export mapping

| JS API                                                                          | Rust N-API symbol                                | Rust module    |
| ------------------------------------------------------------------------------- | ------------------------------------------------ | -------------- |
| `grep(options, onMatch?)`                                                       | `grep`                                           | `grep.rs`      |
| `search(content, options)`                                                      | `search`                                         | `grep.rs`      |
| `hasMatch(content, pattern, ignoreCase?, multiline?)`                           | `has_match`                                      | `grep.rs`      |
| `fuzzyFind(options)`                                                            | `fuzzy_find`                                     | `fd.rs`        |
| `glob(options, onMatch?)`                                                       | `glob`                                           | `glob.rs`      |
| `invalidateFsScanCache(path?)`                                                  | `invalidate_fs_scan_cache`                       | `iofs.rs`      |
| `astGrep(options)`                                                              | `ast_grep`                                       | `ast.rs`       |
| `astMatch(options)`                                                             | `ast_match`                                      | `ast.rs`       |
| `astEdit(options)`                                                              | `ast_edit`                                       | `ast.rs`       |
| `wrapTextWithAnsi(text, width, tabWidth)`                                       | `wrap_text_with_ansi`                            | `text.rs`      |
| `truncateToWidth(text, maxWidth, ellipsis, pad, tabWidth)`                      | `truncate_to_width`                              | `text.rs`      |
| `sliceWithWidth(line, startCol, length, strict, tabWidth)`                      | `slice_with_width`                               | `text.rs`      |
| `extractSegments(line, beforeEnd, afterStart, afterLen, strictAfter, tabWidth)` | `extract_segments`                               | `text.rs`      |
| `visibleWidth(text, tabWidth)`                                                  | `visible_width`                                  | `text.rs`      |
| `setHangulCompatJamoWidthOverride(value)`                                       | `set_hangul_compat_jamo_width_override`           | `text.rs`      |
| `highlightCode(code, lang, colors)`                                             | `highlight_code`                                 | `highlight.rs` |
| `new HighlightStream(lang, colors)` / `.push(chunk)`                              | `HighlightStream`                                | `highlight.rs` |
| `warmHighlighter()`                                                               | `warm_highlighter`                               | `highlight.rs` |
| `supportsLanguage(lang)`                                                        | `supports_language`                              | `highlight.rs` |
| `getSupportedLanguages()`                                                       | `get_supported_languages`                        | `highlight.rs` |
| `countTokens(input, encoding?)`                                                 | `count_tokens`                                   | `tokens.rs`    |

## Pipeline overview by subsystem

## 1) Regex search (`grep`, `search`, `hasMatch`)

### Input/options flow

1. Callers invoke generated native exports directly; there is no package-local TS wrapper that renames `search` to `searchContent`.
2. Rust option structs in `grep.rs` deserialize camelCase fields including `ignoreCase`, `maxCount`, `maxCountPerFile`, `contextBefore`, `contextAfter`, `maxColumns`, and `timeoutMs`.
3. `grep` creates `CancelToken` from `timeoutMs` + `AbortSignal` and runs inside `task::blocking("grep", ...)`. Filesystem grep does not expose or use the shared walker cache. `filesystem?: ShellFilesystem` supplies host-injected stat/walk/read operations, including absolute `scheme://` paths.
4. `search` and `hasMatch` operate on provided string/`Uint8Array` content and do not scan the filesystem.

### Execution branches

- **In-memory branch**
  - `search` -> `search_sync` / search helpers over provided content bytes.
  - `hasMatch` compiles/checks pattern against provided content and returns a boolean.
  - No filesystem scan or walker cache.
- **Single-file branch**
  - `grep` resolves the path through the selected filesystem, checks metadata, and searches a file directly. Oversized files are searched over their leading 4 MiB.
- **Directory branch**
  - Rust builds a `pi_walker::WalkRequest` with `.cache(false)` hard-coded (`build_grep_walk_request`): directory searches stream while the tree is walked and never read or populate the shared scan cache.
  - The walk yields file candidates directly to searchers; glob filtering runs walker-side and the file-type filter is applied per candidate. Size hints use `SizeHintPolicy::WhenCheap`, avoiding provider metadata calls solely for sizes.
  - Files larger than the size cap are deferred to a trailing prefix pass that reads only the leading window into an owned buffer.

### Search/collection semantics

- Matcher selection: the Rust regex engine is tried first, then PCRE2 for features such as lookaround/backreferences. `OMP_PCRE2_JIT=0`/`false` disables PCRE2 JIT and `1` enables it; when unset, JIT is enabled except on macOS.
- Filesystem grep defaults to `hidden=true`, `gitignore=true`, and `recursive=true` for simple glob filters. Directory walks skip `.git` and skip `node_modules` unless the glob mentions it.
- Context resolution:
  - `contextBefore/contextAfter` override legacy `context`.
  - Non-content modes do not collect context.
- Output modes:
  - `content` -> one `GrepMatch` per hit.
  - `count` emits per-file entries with `lineNumber=0`, `line=""`, and `matchCount` set.
  - `filesWithMatches` emits one path-only entry per matched file (`lineNumber=0`, `line=""`, `matchCount` omitted).
  - `offset` and `maxCount` are applied during aggregation across sorted file results; `maxCountPerFile` can additionally prevent one hot file consuming the content-mode budget.
  - Directory streaming model (`run_streaming_grep`):
    - With a content-mode match budget (`maxCount`, no `offset`), the budget terminates the walk itself: budgets up to 64 matches, or any budget with one walker worker, use a sequential early-exit walk. Larger budgets use a path-ordered windowed walk (`run_windowed_streaming_grep`), stopping once the budget is satisfied. Deterministic path-ordered first pages are preserved at every budget size.
    - Without an early-stop budget, an unordered work-stealing parallel traversal feeds searchers directly (`run_parallel_streaming_grep`); per-file results are sorted by path afterwards.
    - `maxCountPerFile` (content mode) caps matches collected per file so one hot file cannot exhaust the global `maxCount` budget before other files are reached.
    - Oversized files (beyond the 4 MiB cap) are deferred behind normal-sized results and searched over their leading window only (bounded prefix read via `read_owned_prefix`; no full-file read and no mmap — the bounded owned read avoids mmap page faults).
    - `offset` and `maxCount` are applied while aggregating per-file results. The positional `onMatch(error, match)` callback is emitted after directory aggregation; the direct-file branch returns its matches without that callback.

### Batched delivery (`onMatches`)

`GrepOptions.onMatches(matches)` is a separate streaming API with no error-first argument. It delivers batches of at most 1024 entries while scanning, with no file-order guarantee. It supports content, count, and files-with-matches output. It cannot be combined with `maxCount` or a nonzero `offset`; `maxCountPerFile` remains available.

The native bridge bounds in-flight delivery to eight batches and checks cancellation every 10ms while waiting for JS consumption. Successful completion waits for every callback, returns counters with `matches: []`, and does not call the positional `onMatch`. A callback throw rejects with that error. Cancellation interrupts delivery/acknowledgement waits, but callbacks already queued on JS may still run.

### Result shaping back to JS

- Rust `SearchResult`/`GrepResult` fields map to TS interfaces via N-API object conversion.
- Counters are clamped before crossing N-API where needed.
- `GrepResult.limitReached` is optional and emitted when true; `skippedOversized` counts oversized files that could not be searched even via the trailing bounded prefix pass.
- `onMatches` receives shaped batches during scanning; the positional directory `onMatch` callback receives one shaped entry after aggregation.

### Failure behavior

- `search` returns `SearchResult.error` for regex/search failures instead of throwing.
- `grep` rejects on hard errors such as invalid path or cancellation timeout/abort. Patterns rejected by both regex engines fall back to a literal search rather than producing a regex error.
- `hasMatch` returns a boolean on success; matcher construction uses the same tolerant fallback.
- Unreadable/non-regular files are skipped. Successfully searched oversized prefixes are not counted as skipped; `skippedOversized` reports oversized files that could not be searched through the prefix pass.

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
2. Rust resolves the search path through `iofs::resolve_search_dir` using the selected filesystem and normalizes the pattern via `glob_util::build_glob_pattern`, compiled into a walker-side `pi_walker::CompiledWalkGlob` filter. An empty/whitespace pattern becomes `"*"`.
3. Entry source: a `pi_walker::WalkRequest` with the glob filter pushed down walker-side. `.cache(config.cache)` requests cached collection on provider-free native filesystems; `EmptyRecheck` can perform one fresh rescan when a sufficiently old cache hit filters to empty.
4. Filtering:
   - skip `.git` always;
   - `includeNodeModules`, when supplied, controls node-module inclusion; when omitted, inclusion is inferred from whether the pattern mentions `node_modules`;
   - apply glob match;
   - apply `FileType` enum filtering after walker collection; symlink `File`/`Dir` filters resolve target metadata through the selected filesystem. This post-collection filter does not trigger empty-cache revalidation.
5. Optional sort by mtime descending (`sortByMtime`), then path ascending, before truncating to `maxResults`. Callbacks receive the returned, ordered match set; `totalMatches` is its length, not an untruncated total.

### `fuzzyFind` flow

1. Rust implementation lives in `fd.rs`; generated export is `fuzzyFind`.
2. Shared scan source from `pi-walker` with the same cache/no-cache split and walker-side stale-empty recheck policy.
3. Scoring:
   - exact / starts-with / contains / subsequence-based fuzzy score;
   - queries without `/` match basenames only; path-style queries can also match the full relative path;
   - separator/punctuation-normalized scoring;
   - directory bonus and deterministic tie-break (`score desc`, then path depth ascending, then `path asc`).
4. Symlink entries are excluded, but traversal follows symlinked directories. Directory result paths end in `/`; `totalMatches` counts all scored matches before the `maxResults` top-N bound (default 100).

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
- `dryRun` defaults to `true` in the implementation. Exact duplicate edits are coalesced. When applying (`dryRun=false`), rewritten files are staged before writes and overlapping edits reject through `pi-ast`'s edit application; dry-run previews do not perform that apply-time validation. File writes are sequential, not a multi-file transaction.
- Options include language override, path/glob/selector, strictness, limits, parse-error policy, `signal`, and `timeoutMs`. `astGrep`/`astEdit` also accept `filesystem`; `astMatch` is in-memory. Find limits default to 50 (and are clamped to at least one); strictness defaults to `"smart"`. Find `context` is reserved and currently unused.
- For `astGrep` and `astEdit`, a directory `path` requests shared caching with configured stale-empty rechecking on native filesystems; injected providers bypass that cache. A direct file returns that candidate without traversal or cache access. `astMatch` remains in-memory.

These exports are direct native APIs used by tooling; they are not mediated by a TS wrapper in `packages/natives`.

## 4) Shared scan/cache lifecycle (`pi-walker`)

`pi-walker` owns traversal and cache policy. `crates/pi-natives/src/iofs.rs` contains JavaScript-facing DTO conversion, error mapping, native/provider root resolution, and the invalidation export.

The cache stores normalized relative entries (`path`, `fileType`, optional `mtime` and regular-file `size`) keyed by the supplied root path plus the full effective `WalkOptions`, excluding its cache bit. Native discovery normally canonicalizes the root first. Hidden/ignore and directory-pruning policy, link following, metadata detail, traversal order/depth, root emission, directory-error handling, and same-filesystem policy partition entries. High-level filters, ranking, and result limits do not independently partition them, but metadata requirements can change effective detail and select another key. Any injected filesystem provider disables shared caching, even if its root redirects to a host path.

Configuration is read from environment once:

- `FS_SCAN_CACHE_TTL_MS`: cache TTL, default `1000`.
- `FS_SCAN_EMPTY_RECHECK_MS`: cached-empty recheck age, default `200`.
- `FS_SCAN_CACHE_MAX_ENTRIES`: maximum entries in the cache map, default `16`.
- `FS_SCAN_CACHE_MAX_BYTES`: maximum retained vector and path-string allocation bytes, default `67108864` (64 MiB).
- `PI_WALK_WORKERS`: walker Rayon pool size, default `4`.

### Cache state transitions

1. **Disabled / miss / expired**
   - disabled requests collect fresh without reading or updating the cache;
   - enabled misses and entries at or beyond TTL collect fresh and populate it.
2. **Hit**
   - an entry younger than TTL returns cached entries and cache age.
3. **Stale-empty recheck**
   - when configured rechecking is enabled, an empty walker-filtered cache hit with nonzero age at or beyond the threshold is scanned once uncached; that retry does not replace or evict the cached entry.
4. **Invalidation**
   - `invalidateFsScanCache()` clears all keys;
   - `invalidateFsScanCache(path)` removes every entry whose cached root is a prefix of the target (canonicalization with parent fallback supports create/delete/rename invalidation). The binding lives in `iofs.rs` and forwards to `pi_walker::invalidate_path_string` / `pi_walker::invalidate_all`.

Cache favors low-latency repeated scans over immediate consistency. Explicit invalidation is the correctness hook after writes, edits, renames, or deletes.

Direct native `astEdit` writes do not invalidate the shared walker cache. Callers applying edits on the native filesystem must invalidate affected paths explicitly; provider-backed discovery already bypasses that cache.

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

- `wrapTextWithAnsi`: wraps by visible width, carries active SGR codes across wrapped lines, and closes/reopens OSC 8 hyperlinks at line boundaries.
- `truncateToWidth`: visible-cell truncation with ellipsis policy (`Unicode` default, `Ascii`, `Omit`), optional right padding (default `false`).
- `sliceWithWidth`: returns `{ text, width }` for a column slice; strict width enforcement defaults to `false`.
- `extractSegments`: extracts before/after segments around an overlay while restoring ANSI state for the `after` segment.
- `setHangulCompatJamoWidthOverride(value)` controls U+3131–U+318E width correction for client-terminal compatibility: `0` uses the platform fallback, `1` forces one cell, `2` forces two, and `3` follows Unicode width.
- `sanitizeText` is not a native export. It lives in `@oh-my-pi/pi-utils` (`packages/utils/src/sanitize-text.ts`) and uses `Bun.stripANSI`, control-character removal, and malformed-surrogate cleanup.
- `visibleWidth`: counts visible terminal cells using caller-supplied tab width. Width-sensitive exports clamp tab width to `1..16`; tabs occupy that fixed width rather than expanding to tab stops.
- Text processing uses JS UTF-16 directly, with an ASCII fast path and grapheme segmentation for non-ASCII. OSC 66 scaled-text payloads contribute visible width instead of being treated as zero-width escapes.

### Failure behavior

Text functions generally return deterministic transformed output; errors are limited to N-API argument/string conversion boundaries.

## 6) Syntax highlighting (`highlight`)

`highlight.rs` is pure transformation; it does not use the filesystem scan cache.

### Flow

1. Caller passes `code`, optional `lang`, and ANSI color palette.
2. Rust resolves syntax by token/name lookup, extension lookup, then alias table fallback. Missing/unknown language returns the original code unchanged.
3. Each line is parsed with syntect `ParseState` and scope stack.
4. Scopes map to semantic color categories and ANSI color codes are injected/reset.

`HighlightStream(lang, colors)` preserves parser/scope state across `push(chunk)` calls and exposes `supported`. Feed complete newline-terminated lines, except that the final chunk may omit its newline; arbitrary mid-line chunks do not have the same guarantee as one-shot highlighting. Unknown language is passthrough.

`warmHighlighter()` initializes grammars/scope matchers and parses representative sources on the blocking pool. The syntax set includes syntect defaults plus bundled Julia, Nix, Mermaid, TypeScript, TSX, and Astro grammars. `getSupportedLanguages()` returns syntax names; `supportsLanguage()` also recognizes aliases, some mapped to a related-language grammar.

The palette requires nine core semantic colors (`comment`, `keyword`, `function`, `variable`, `string`, `number`, `type`, `operator`, `punctuation`); diff `inserted`/`deleted` colors are optional.

### Failure behavior

- Per-line parse failure does not fail the call: that line is appended unhighlighted and processing continues.
- Missing/unknown language returns input unchanged rather than parsing a plain-text fallback.

## 7) Token counting (`tokens`)

`countTokens(input, encoding?)` is an in-memory utility.

- `input` may be a single string or an array of strings.
- Arrays return one aggregate count; batches of at least 16 use Rayon when the global pool is available, otherwise counting is serial.
- Default encoding is `O200kBase`. Others are `Cl100kBase`, `ClaudeV3`, `ClaudeV47`, `ClaudeV5`, `ClaudeV5Sonnet`, `Qwen3`, `DeepSeekV3`, `KimiK2`, `Glm5`, and `Jev`.
- `tokens.rs` dispatches UTF-16 input to embedded `utok`; vocabularies load on first use and are reused. Counts measure content rather than request/message framing; ordinary BPE encoding does not interpret special tokens.

## Pure utility vs filesystem-dependent flows

| Flow                         | Filesystem access | Shared cache | Notes                                                        |
| ---------------------------- | ----------------- | ------------ | ------------------------------------------------------------ |
| `search` / `hasMatch`        | No                | No           | regex on provided bytes/string only                          |
| `text` module functions      | No                | No           | ANSI/width utilities only                                    |
| `highlight` module functions | No                | No           | syntax + ANSI coloring only                                  |
| `countTokens`                | No                | No           | tokenization only                                            |
| `astMatch`                   | No                | No           | in-memory syntax-aware match (no disk)                       |
| `astGrep` / `astEdit`        | Yes               | Native-only  | directory discovery requests caching; direct files/providers bypass it |
| `glob`                       | Yes               | Optional     | directory scans + glob filtering (`cache` opt-in)            |
| `fuzzyFind`                  | Yes               | Optional     | directory scans + fuzzy scoring (`cache` opt-in)             |
| `grep` (file/dir path)       | Yes               | Never        | streaming uncached walk feeding searchers                    |

## End-to-end lifecycle summary

1. Caller invokes generated native export with typed options.
2. Rust validates/normalizes options and builds matcher/search config.
3. For filesystem flows, entries are scanned (cache hit/miss/rescan where applicable) then filtered/scored/searched.
4. Worker loops periodically call cancel heartbeat; timeout/abort can terminate execution.
5. Rust shapes outputs into N-API objects (`lineNumber`, `matchCount`, `limitReached`, etc.).
6. Generated bindings return typed JS objects. `glob` emits returned matches after ordering; `grep` supports post-aggregation positional directory callbacks or batched `onMatches` delivery during scanning.
