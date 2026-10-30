# Natives Text/Search Pipeline

This document maps the `@oh-my-pi/pi-natives` text/search/code surface from generated JS/TS exports to Rust N-API modules and back to JS result objects.

Terminology follows `docs/natives-architecture.md`:

- **Generated binding**: public API in `packages/natives/native/index.d.ts`.
- **Rust module layer**: N-API exports in `crates/pi-natives/src/*`.
- **Shared listing cache**: `pi-walker`'s process-wide per-directory listing cache (`crates/pi-walker/src/walk/cache.rs`) used by discovery flows; N-API filesystem DTOs/conversions live in `crates/pi-natives/src/glob.rs`. See `docs/fs-scan-cache-architecture.md`.

## Implementation files

- `packages/natives/native/index.d.ts`
- `crates/pi-natives/src/grep.rs`
- `crates/pi-natives/src/glob.rs`
- `crates/pi-natives/src/fd.rs`
- `crates/pi-walker/src/fs/root.rs`
- `crates/pi-walker/src/lib.rs`
- `crates/pi-walker/src/walk/mod.rs`
- `crates/pi-walker/src/walk/cache.rs`
- `crates/pi-walker/src/glob.rs`
- `crates/pi-walker/src/grep/mod.rs`
- `crates/pi-natives/src/ast.rs`
- `crates/pi-ast/src/ops.rs`
- `crates/pi-natives/src/shell/vfs.rs`
- `crates/pi-vfs/`
- `crates/pi-natives/src/text.rs`
- `crates/pi-natives/src/highlight.rs`
- `crates/pi-natives/src/tokens.rs`
- `crates/pi-natives/src/utok/`

## JS API ↔ Rust export mapping

| JS API                                                                          | Rust N-API symbol                       | Rust module    |
| ------------------------------------------------------------------------------- | --------------------------------------- | -------------- |
| `grep(options, onMatch?)`                                                       | `grep`                                  | `grep.rs`      |
| `search(content, options)`                                                      | `search`                                | `grep.rs`      |
| `hasMatch(content, pattern, ignoreCase?, multiline?)`                           | `has_match`                             | `grep.rs`      |
| `fuzzyFind(options)`                                                            | `fuzzy_find`                            | `fd.rs`        |
| `glob(options, onMatch?)`                                                       | `glob`                                  | `glob.rs`      |
| `astGrep(options)`                                                              | `ast_grep`                              | `ast.rs`       |
| `astMatch(options)`                                                             | `ast_match`                             | `ast.rs`       |
| `astEdit(options)`                                                              | `ast_edit`                              | `ast.rs`       |
| `wrapTextWithAnsi(text, width, tabWidth)`                                       | `wrap_text_with_ansi`                   | `text.rs`      |
| `truncateToWidth(text, maxWidth, ellipsis, pad, tabWidth)`                      | `truncate_to_width`                     | `text.rs`      |
| `sliceWithWidth(line, startCol, length, strict, tabWidth)`                      | `slice_with_width`                      | `text.rs`      |
| `extractSegments(line, beforeEnd, afterStart, afterLen, strictAfter, tabWidth)` | `extract_segments`                      | `text.rs`      |
| `visibleWidth(text, tabWidth)`                                                  | `visible_width`                         | `text.rs`      |
| `setHangulCompatJamoWidthOverride(value)`                                       | `set_hangul_compat_jamo_width_override` | `text.rs`      |
| `highlightCode(code, lang, colors)`                                             | `highlight_code`                        | `highlight.rs` |
| `new HighlightStream(lang, colors)` / `.push(chunk)`                            | `HighlightStream`                       | `highlight.rs` |
| `warmHighlighter()`                                                             | `warm_highlighter`                      | `highlight.rs` |
| `supportsLanguage(lang)`                                                        | `supports_language`                     | `highlight.rs` |
| `getSupportedLanguages()`                                                       | `get_supported_languages`               | `highlight.rs` |
| `countTokens(input, encoding?)`                                                 | `count_tokens`                          | `tokens.rs`    |

## Pipeline overview by subsystem

## 1) Regex search (`grep`, `search`, `hasMatch`)

### Input/options flow

1. Callers invoke generated native exports directly; there is no package-local TS wrapper that renames `search` to `searchContent`.
2. Rust option structs in `grep.rs` deserialize camelCase fields including `ignoreCase`, `maxCount`, `maxCountPerFile`, `contextBefore`, `contextAfter`, `maxColumns`, and `timeoutMs`.
3. `grep` creates `CancelToken` from `timeoutMs` + `AbortSignal` and runs inside `task::filesystem_future(...)`, an async task on Tokio. The pattern compiles once with `pi_walker::grep::Engine::compile`, and the search runs in `pi_walker::grep::grep`. Filesystem grep does not expose or use the shared listing cache. `filesystem?: ShellFilesystem` supplies host-injected stat/walk/read operations, including absolute `scheme://` paths.
4. `search` and `hasMatch` operate on provided string/`Uint8Array` content and do not scan the filesystem.

### Execution branches

- **In-memory branch**
   - `search` -> `search_sync` / search helpers over provided content bytes.
   - `hasMatch` compiles/checks pattern against provided content and returns a boolean.
   - No filesystem scan or listing cache.
- **Single-file branch**
   - `grep` resolves the path through the selected filesystem, checks metadata, and searches a file directly. Oversized files are searched over their leading 4 MiB in a second pass; native oversized file roots are streamed through grep-searcher's reader inline, provider files are read async.
- **Directory branch**
   - `pi_walker::grep::grep` walks with `walk::Options::cache` left `false`: directory searches never read or populate the shared listing cache.
   - The glob compiles to a `pi_walker::glob::Selector::scope` (files it matches plus every file under a directory it matches) that also prunes the walk; `exclude` patterns compile to `Selector::exclude`.
   - Files larger than 4 MiB are searched over their first 4 MiB after all other files.

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
   - Directory execution model (`pi_walker::grep::grep`):
      - Without a match budget, each walker worker lists a directory and scans its selected files itself, reusing its filesystem session, scanner, and read buffer. Files open relative to the live directory handle, or by absolute path for cached listings. Only completed search results cross the bounded output channel; there is no second search pool or candidate handoff. Per-file results are put in path order afterwards.
      - With a match budget (`maxCount`), a `walk::Tree` (`Order::Paths`, a serial async cursor) feeds `exec::ordered`: a fixed pool with worker-local sessions and scanners. Candidates are grouped in batches of up to 16 and at most `parallelism*16` candidates are in flight. Results are consumed strictly in path order; settling the budget drops the stream and stops the producer and workers. Path-ordered first pages are deterministic.
      - `maxCountPerFile` (content mode) caps matches collected per file so one hot file cannot exhaust the global `maxCount` budget before other files are reached.
      - Files over 4 MiB are ordered after all other files and searched over their first 4 MiB only.
      - `offset` and `maxCount` are applied while aggregating per-file results. The positional `onMatch(error, match)` callback is emitted after directory aggregation; the direct-file branch returns its matches without that callback.

### Batched delivery (`onMatches`)

`GrepOptions.onMatches(matches)` is a separate streaming API with no error-first argument. It delivers batches of at most 1024 entries while scanning, with no file-order guarantee. It supports content, count, and files-with-matches output. It cannot be combined with `maxCount` or a nonzero `offset`; `maxCountPerFile` remains available.

Batches flow through a bounded `tokio::sync::mpsc::Sender<Vec<Match>>` (each batch comes from one file) to a forwarder that awaits each JS call (`call_async_catch`) and coalesces queued batches up to 1024 matches; the channel holds 4 batches, so backpressure reaches the scan end to end. Successful completion waits for every callback, returns counters with `matches: []`, and does not call the positional `onMatch`. A callback throw rejects with that error. Cancellation drops the search future, but callbacks already queued on JS may still run.

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

`glob` and `fuzzyFind` share the optional `pi-walker` listing cache; matching logic differs. Cache use defaults to `false` for both APIs.

### `glob` flow

1. Caller passes `GlobOptions` directly. `pattern` and `path` are required in the generated type.
2. Rust resolves the search path through `pi_walker::fs::resolve_dir` using the selected filesystem and runs `pi_walker::glob::glob`, which normalizes and compiles the pattern into a `pi_walker::glob::Selector`. An empty/whitespace pattern becomes `"*"`.
3. Entry source: a `pi_walker::walk::collect` walk pruned by the selector (no deeper than the pattern reaches, never into subtrees no match can be in). `walk::Options::cache` from `GlobOptions.cache` enables the listing cache on the native filesystem for minimal-detail walks.
   - Descendant links are not followed by default. `followLinks: true` uses the walker's cycle-safe link following; the filesystem provider owns mount containment. Glob and find enable it only for explicit `skill://` roots and enforce the plugin/skill boundary in their URL filesystem.
4. Filtering:
   - skip `.git` always;
   - `includeNodeModules`, when supplied, controls node-module inclusion; when omitted, inclusion is inferred from whether the pattern mentions `node_modules`;
   - apply glob match;
   - apply `FileType` enum filtering after walker collection; symlink `File`/`Dir` filters resolve target metadata through the selected filesystem and retain its mtime and regular-file size on accepted matches. Dangling links are excluded by those target-type filters.
5. Optional sort by mtime descending (`sortByMtime`), then path ascending, before truncating to `maxResults`. Callbacks receive the returned, ordered match set; `totalMatches` is its length, not an untruncated total.

### `fuzzyFind` flow

1. Rust implementation lives in `fd.rs`; generated export is `fuzzyFind`.
2. Entries come from `pi_walker::walk::collect` on the native filesystem with the same cache opt-in (`FuzzyFindOptions.cache`).
3. Scoring:
   - exact / starts-with / contains / subsequence-based fuzzy score;
   - queries without `/` match basenames only; path-style queries can also match the full relative path;
   - separator/punctuation-normalized scoring;
   - directory bonus and deterministic tie-break (`score desc`, then path depth ascending, then `path asc`).
4. Symlink entries are excluded, but traversal follows symlinked directories. Directory result paths end in `/`; `totalMatches` counts all scored matches before the `maxResults` top-N bound (default 100).

### Failure behavior

- Invalid glob pattern returns an error from selector compilation (`pi_walker::glob::GlobError::Pattern`).
- Search root must resolve to an existing directory for directory discovery flows.
- Cancellation/timeouts propagate as abort errors: `task::filesystem_future` drops the pi-walker future on abort/timeout, and a drop guard sets the halt flag that cancels its spawned tasks. `walk::Tree` spends tokio's coop budget per entry so raced traversals cancel too.

### Malformed glob handling

`pi_walker::glob::Selector` normalization is tolerant:

- normalizes `\` to `/`,
- auto-prefixes simple recursive patterns with `**/` when `recursive=true`,
- auto-closes unbalanced `{...` alternation groups before compile.

## 3) AST search/match/edit (`astGrep`, `astMatch`, `astEdit`)

`ast.rs` exposes syntax-aware code search and rewrite operations.

- `astGrep`/`astEdit` run under `task::filesystem_future` with the resolved `pi_vfs::Fs`; `pi-ast`'s `discover`, `find`, `find_page`, and `rewrite` are async, with per-file work in `tokio::spawn` tasks kept in candidate order. `astMatch` uses the sync `find_source` on `task::blocking` with a `CancellationToken`.
- `astGrep(options)` returns matches with byte/line/column coordinates and optional metavariable bindings.
- `astMatch(options)` runs the same patterns against an in-memory `source` string instead of files; `lang` is required (there is no path to infer it from), and the result keeps matches, `totalMatches`, `limitReached`, and parse errors but omits the file-count fields.
- `astEdit(options)` returns replacement changes, per-file counts, searched/touched file counts, parse errors, and whether edits were applied.
- `dryRun` defaults to `true` in the implementation. Exact duplicate edits are coalesced. When applying (`dryRun=false`), rewritten files are staged before writes and overlapping edits reject through `pi-ast`'s edit application; dry-run previews do not perform that apply-time validation. File writes are sequential, not a multi-file transaction.
- Options include language override, path/glob/selector, strictness, limits, parse-error policy, `signal`, and `timeoutMs`. `astGrep`/`astEdit` also accept `filesystem`; `astMatch` is in-memory. Find limits default to 50 (and are clamped to at least one); strictness defaults to `"smart"`. Find `context` is reserved and currently unused.
- For `astGrep` and `astEdit`, a directory `path` requests the shared listing cache on native filesystems, and an optional glob compiles to `Selector::scope`; injected providers bypass that cache. A direct file returns that candidate without traversal or cache access. `astMatch` remains in-memory.

These exports are direct native APIs used by tooling; they are not mediated by a TS wrapper in `packages/natives`.

## 4) Shared walk/cache lifecycle (`pi-walker`)

`pi-walker` owns traversal, native/provider root resolution (`pi_walker::fs`), and cache policy. The N-API modules keep only JavaScript-facing DTO conversion and error mapping (`glob.rs` holds `FileType`/`GlobMatch`; `task::walk_failure` maps walk errors).

The cache is process-wide and stores per-directory listings, not per-root entry lists: every walk that enables caching shares them regardless of root or traversal options, and the walker re-applies hidden/ignore policy, pruning, and filters on each walk. Only native-filesystem walks with `Detail::Minimal` and `walk::Options::cache = true` participate, and only on filesystems with stable stamps (APFS; ext4/XFS/Btrfs/tmpfs/F2FS/ZFS/bcachefs; NTFS/ReFS). Any injected filesystem provider disables caching, even if its root redirects to a host path.

Walk parallelism: pi-walker has no runtime of its own. Each walk starts `walk::Options::parallelism` long-lived workers on the current tokio runtime. Workers share a directory queue and retain their own sessions and buffers; no task is spawned per directory or file. `PI_WALK_WORKERS` set to a positive `N` uses `N` workers; unset or `0` uses the per-filesystem default (4 on macOS, 8 on Linux, 4 elsewhere and for providers), capped by available parallelism.

### Cache state transitions

1. **Disabled / ineligible**
   - the directory is listed fresh without reading or updating the cache.
2. **Hit**
   - the directory's stamp (dev/ino/mtime/ctime) and its ignore files' stamps are unchanged: the cached listing is reused at the cost of one metadata call.
3. **Miss / changed**
   - the directory is listed again; the listing is stored only if its stamp is older than the 50 ms racy window. The cache holds about 64 MiB across 64 shards, dropping whole shards when full.

The cache is correct without invalidation because stamps change on every mutation, so it exposes none; direct native `astEdit` writes and agent mutations need no cache bookkeeping.

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

| Flow                         | Filesystem access | Shared cache | Notes                                                                  |
| ---------------------------- | ----------------- | ------------ | ---------------------------------------------------------------------- |
| `search` / `hasMatch`        | No                | No           | regex on provided bytes/string only                                    |
| `text` module functions      | No                | No           | ANSI/width utilities only                                              |
| `highlight` module functions | No                | No           | syntax + ANSI coloring only                                            |
| `countTokens`                | No                | No           | tokenization only                                                      |
| `astMatch`                   | No                | No           | in-memory syntax-aware match (no disk)                                 |
| `astGrep` / `astEdit`        | Yes               | Native-only  | directory discovery requests caching; direct files/providers bypass it |
| `glob`                       | Yes               | Optional     | directory scans + glob filtering (`cache` opt-in)                      |
| `fuzzyFind`                  | Yes               | Optional     | directory scans + fuzzy scoring (`cache` opt-in)                       |
| `grep` (file/dir path)       | Yes               | Never        | uncached parallel walk/search, results in path order                   |

## End-to-end lifecycle summary

1. Caller invokes generated native export with typed options.
2. Rust validates/normalizes options and builds matcher/search config.
3. For filesystem flows, `pi-walker` walks the tree (reusing unchanged directory listings where caching applies), then entries are filtered/scored/searched.
4. Timeout/abort drops the pi-walker future, cancelling its tasks.
5. Rust shapes outputs into N-API objects (`lineNumber`, `matchCount`, `limitReached`, etc.).
6. Generated bindings return typed JS objects. `glob` emits returned matches after ordering; `grep` supports post-aggregation positional directory callbacks or batched `onMatches` delivery during scanning.
