# Changelog

## [Unreleased]

## [16.2.0] - 2026-06-27

### Added

- Added `REM` (remove) and `MV` (move/rename) section operations to hashline patches, allowing files to be deleted or relocated (with snapshot history migration) directly within the edit tool.

## [16.1.23] - 2026-06-26

### Added

- Updated prompt documentation to include support for Markdown section operations

### Fixed

- Improved file path recovery to correctly handle read-only or incorrectly typed paths

## [16.1.14] - 2026-06-22

### Fixed

- Improved delimiter-balance repair to correctly identify and spare deleted structural closers
- Prevented premature deletion of structural closers when existing code below the range covers them
- Accurate tracking of inserted lines to improve boundary repair logic for surrounding code blocks
- Fixed delimiter-balance repair so deleted closer suffixes are kept only when the replacement prefix still has unmatched openers for them, avoiding duplicated trailing braces while preserving omitted outer closers.

## [16.1.8] - 2026-06-20

### Fixed

- Fixed multi-hunk delimiter-balance repair so a `SWAP` that drops a structural closer no longer keeps it when another hunk already removed the matching opener (a deliberate wrapper removal); the missing-closer repair now weighs each group against the whole patch's residual delimiter balance — summed per hunk so quote/comment state never bleeds across non-contiguous hunks — and consumes that residual per repair so a genuine missing closer elsewhere still fires. ([#3142](https://github.com/can1357/oh-my-pi/issues/3142))

## [16.1.2] - 2026-06-19

### Changed

- Refined documentation and prompt instructions for clarity and brevity

## [16.0.2] - 2026-06-16

### Fixed

- Auto-repaired duplicated JSX/XML closing boundary lines at the end of single-line replacement expansions. ([#2705](https://github.com/can1357/oh-my-pi/issues/2705))

## [16.0.1] - 2026-06-15

### Fixed

- Auto-repaired one-sided multi-line boundary echoes by dropping delimiter-neutral duplicated boundary lines and emitted a boundary-echo warning
- Parser now treats a leading `\` on inline payload bodies as the payload delimiter, matching standalone payload rows.
- Restored the warning emitted when escaped indented payload rows (`\\    TEXT`) are accepted as payload delimiters.

## [15.13.3] - 2026-06-15

### Changed

- Changed the recommended hashline range separator from `..` to `.=` (e.g. `SWAP 1.=3:`, `DEL 4.=5`) so the inclusive `<=`-style end is self-evident. `HL_RANGE_SEP` is now `.=`; the prompt, grammar, error messages, and emitted headers all use it. The lenient parser still accepts the legacy `..` (and `-`/`…`/space) forms.

## [15.13.2] - 2026-06-15

### Breaking Changes

- Renamed all hashline DSL operators to concise abbreviated keywords:
  - `replace` -> `SWAP`
  - `delete` -> `DEL`
  - `insert before`/`after`/`head`/`tail` -> `INS.PRE`/`POST`/`HEAD`/`TAIL`
  - `replace_block` -> `SWAP.BLK`
  - `delete_block` -> `DEL.BLK`
  - `insert_after_block` -> `INS.BLK.POST`

## [15.13.1] - 2026-06-15

### Breaking Changes

- Rejected edits anchored to lines not displayed in the tagged read/search output, requiring unseen ranges to be re-read before reapplying

### Changed

- Rejected `replace block`, `delete block`, and `insert after block` operations that resolve to a single line and instructed users to use the plain single-line form or anchor the true construct opener

### Fixed

- Normalized cwd-relative hashline paths to forward-slash form on Windows.

## [15.12.5] - 2026-06-13

### Fixed

- Fixed delimiter-balance boundary repair so it does not keep a deleted structural closer when the replacement payload already restates that closer.

## [15.12.0] - 2026-06-12

### Changed

- Condensed all parser/applier/patcher error and warning messages: shorter wording, same diagnostic anchors (op names, line numbers, suggested fallback forms)

## [15.11.4] - 2026-06-12

### Added

- Added inward landing correction for `insert after block N:`: a body indented deeper than the block's closing line now slides back across the block's trailing closer lines and lands inside the block at its claimed depth, with a warning naming the landing line. Same conservative guards as the outward shift — comparable indentation only, closers only, abandoned when another hunk targets a crossed line; plain `insert after M:` stays literal
- Added closer-anchor lowering for `insert after block N:`: anchoring on a pure closing-delimiter line (where no block begins, so resolution previously failed the whole patch) now applies as plain `insert after N:` with a warning teaching the opener-only rule. `resolveBlockEdits` gained an `onWarning` callback; apply, preview, and patcher paths surface it on `warnings`

### Changed

- Condensed the edit-tool prompt: one-line op definitions, 5–20-word rules, and a tighter `<critical>` recap; landing-correction mechanics are no longer described to the agent

## [15.11.1] - 2026-06-11

### Fixed

- Fixed the `insert after block N:` prompt guidance so it explicitly says N must be the block opener, not the closing delimiter or last visible line, and points visible closing-line edits to plain `insert after M:`. ([#2292](https://github.com/can1357/oh-my-pi/issues/2292))

## [15.11.0] - 2026-06-10

### Changed

- Block-unresolved errors (`replace block N:` / `delete block N` / `insert after block N:` failing to resolve a syntactic block) now append a numbered preview of the file around the anchor line — same `*`-marked context rows the hash-mismatch error shows — so the offending line is visible without a re-read

## [15.10.11] - 2026-06-10

### Breaking Changes

- Changed `BlockResolution.isDelete` to `BlockResolution.op` (`"replace" | "delete" | "insert_after"`) so resolutions can describe every block-anchored op

### Added

- Added `insert after block N:` patch syntax to insert body rows after the last line of the tree-sitter-resolved block beginning on line N, so a statement can be placed after a construct without counting to its closing line
- Added depth-guided landing correction for `insert after N:` hunks: a body indented shallower than its anchor line slides past the structural closer lines below the anchor until depth returns to the body's level, with a warning naming the final landing line. The shift never crosses content lines, skips incomparable indentation styles and pure-closer bodies, and is abandoned when another hunk targets a crossed line
- Added a global byte ceiling to `InMemorySnapshotStore` (`maxTotalBytes`, default 64 MiB): the cap was previously per-file only, so a session reading many large files retained up to 30 paths × 4 full-text versions indefinitely

### Changed

- Trimmed the `replace block N:` ops entry in the patch prompt to grammar and pointing rules; the usage doctrine it duplicated stays in the rules section
- Changed `buildCompactDiffPreview` to treat blank rows as gap separators alongside `…` markers: separators never stack (removed lines omitted from the preview no longer leave two adjacent), and leading/trailing separators are trimmed

### Fixed

- Fixed the boundary-echo repair stripping payload edges without the balance-neutrality guard its own documentation promised: in brace-heavy code where bare `}` lines repeat, a payload intentionally beginning/ending with lines identical to the range's neighbors had both edges silently dropped, writing content that differed from what was authored
- Fixed lenient bare-body handling silently mutating payloads: interior blank rows in an un-prefixed body were dropped outright, and a body of numeric-keyed literals (`1: "one"` dict/YAML shapes) satisfied the uniform line-prefix check and had its keys stripped from every line — blank rows are now preserved when proven interior, and the uniform strip refuses lone-literal remainders
- Fixed the multi-section "all-or-nothing" claim being false for write failures: commits run serially, so a mid-batch write error left earlier sections on disk while the thrown error said nothing — the error now lists exactly which sections were written and which were not
- Fixed `delete`/`replace` ranges ending on the phantom trailing line of a newline-terminated file silently stripping the file's final newline; such anchors are now rejected with guidance toward `N-1` / `insert tail:` (inserts there remain valid, and genuine empty last lines of unterminated files stay deletable)

## [15.10.5] - 2026-06-08

### Added

- Added `maxAddedRunContext` option to control how many added lines are shown at each side of collapsed inserted runs, with `maxUnchangedRun` kept as a backward-compatible alias

### Changed

- Changed `buildCompactDiffPreview` to omit removed lines from the preview while preserving removal counts for offset tracking
- Changed `buildCompactDiffPreview` to collapse long contiguous added runs with a bare `…` marker, keeping only the first and last `maxAddedRunContext` lines visible (the surrounding line numbers convey how many were elided)

### Fixed

- Fixed compact edit previews to omit deleted content, keep visible lines anchored to the current file, and collapse long inserted runs with a bare `…` elision marker.
- Fixed compact edit previews to render added/current lines without diff-prefix padding and normalize adjacent ASCII/Unicode elision markers to one `…`.

## [15.10.3] - 2026-06-08

### Added

- Added a `BlockResolution` type and surfaced resolved block spans on `ApplyResult.blockResolutions` / `PatchSectionResult.blockResolutions`. `resolveBlockEdits` now accepts an `onResolved` callback that reports each `replace block N:` / `delete block N` anchor's resolved `[start, end]` span (and whether it was a delete). Spans are surfaced only on the no-drift apply paths, where the resolved line numbers line up with the tag the caller read.

### Changed

- Reworked the `edit` tool prompt (`prompt.md`): added a `replace block N` vs `replace N..M` decision rule, documented that a leading decorator/attribute/doc-comment is a separate node not swept into the block (point N at the first decorator line, or use `replace N..M` for a Rust-style `///` sibling comment), reframed the blast-radius guidance so "block replace" no longer reads as the dangerous option, and added a decorated-definition example.

## [15.10.2] - 2026-06-08

### Fixed

- Stripped read-output line-number prefixes (`N:`) from auto-piped bare body rows so that pasting `3:text` without a `+` prefix no longer injects `3:` as literal content. Stripping is applied only when *every* bare row in the hunk carries the prefix (the signature of a pasted snapshot) and removes at most one prefix per row, so a genuine body that merely starts with `digits:` (YAML port maps, timestamps) is left intact ([#1492](https://github.com/can1357/oh-my-pi/issues/1492)).

## [15.9.67] - 2026-06-06

### Breaking Changes

- Changed hashline file section headers from `¶PATH#TAG` to `[PATH#TAG]` so model-authored edits use ASCII delimiters instead of a pilcrow sigil.

### Fixed

- Fixed missing-header diagnostics and copied-content prefix stripping to consistently teach and recognize 4-hex snapshot tags.

## [15.8.2] - 2026-06-03

### Fixed

- Fixed delimiter-balance boundary repair to also drop a single duplicated structural opener (e.g. a restated `foo(` / `if (x) {` signature line surviving just above the range), not only duplicated closers. Zero-balance duplicates remain untouched.

## [15.8.0] - 2026-06-02

### Fixed

- Fixed hashline replacements that accidentally restated unchanged lines above and below the selected range so they no longer duplicate both boundary lines ([#1664](https://github.com/can1357/oh-my-pi/issues/1664)).

## [15.7.0] - 2026-05-31

### Added

- Added `replace block N:` and `delete block N` patch syntax to replace or delete the entire syntactic block that begins on line N using tree-sitter-resolved spans
- Added `BlockResolver` support in `Patcher` and `PatchSection.applyTo`/`applyPartialTo` to wire language-specific block-resolution at apply time
- Added `resolveBlockEdits` and block edit type definitions to the package API for resolving deferred `replace block` / `delete block` edits

## [15.5.13] - 2026-05-29

### Breaking Changes

- Changed hashline section tags from 3-hex to 4-hex content-hash tags, so legacy 3-digit tags are no longer valid
- Changed hashline syntax to verb-based v4: body-bearing ops are `replace N..M:`, `insert before N:`, `insert after N:`, `insert head:`, and `insert tail:`, while bodyless `delete N..M` handles deletion. Removed `>A..B` repeat rows and the old `prepend:` / `append:` virtual insert headers; `-` rows remain rejected with a teaching error.

### Added

- Added `maxPaths` and `maxVersionsPerPath` options to `InMemorySnapshotStore` to bound tracked paths and per-path snapshot history
- Re-introduced balance-validated boundary repair in `applyEdits`. A replacement hunk (`replace N..M:` + body) is normalized so its payload preserves the deleted region's delimiter balance: when the body restates a closing delimiter that survives just outside the range (duplicate `}` / `);` / `]`) the echo is dropped, and when the range deletes a structural closer the body never restates (missing closer) the closer is spared instead of deleted. A repair fires only when one boundary operation drives the per-channel `()` / `[]` / `{}` imbalance to exactly zero while leaving surrounding text byte-identical (single-line ops are limited to pure structural-closer lines), so balance-preserving edits and intentional balanced duplicates are never touched. Bracket counting skips strings, template literals, and comments. Each repair surfaces a `delimiter-balance` warning through `ApplyResult.warnings`.

### Changed

- Changed patch application to accept edits whenever the live file's normalized content hash matches the section tag, even when that anchor was not covered by a stored snapshot

### Removed

- Removed `SnapshotStore.recordContiguous` and `SnapshotStore.recordSparse` in favor of full-file `record(path, fullText)` snapshots

### Fixed

- Fixed hash mismatch rejections caused by CRLF or trailing spaces/tabs by normalizing those characters before computing file-hash tags

## [15.5.12] - 2026-05-29

### Changed

- `InMemorySnapshotStore` now coalesces consecutive same-path reads into one tag whenever their views agree on every shared line. Overlapping or directly abutting range reads extend the existing snapshot's contiguous run in place; reads separated by a gap union into a `SparseSnapshot` spanning both ranges. A disagreeing shared line is treated as "the file changed on disk" and mints a fresh tag, preserving the prior superset-dedup behavior. This stops sequential range reads of an unchanged file (e.g. `:50-100` then `:100-200`, or `:1-100` then `:150-200`) from fragmenting into separate anchors.

## [15.5.11] - 2026-05-29

### Added

- `MismatchError` now distinguishes "hash recognized but file content drifted" from "hash never recorded for this path". The latter (likely fabricated or carried over from a prior session) emits a dedicated `hash #X is not from this session` rejection message with explicit "never invent the tag" guidance. The `MismatchDetails` interface gains an optional `hashRecognized?: boolean` (defaults to `true` for backward compatibility); `MismatchError` exposes it as a readonly field so callers can branch on the cause.

## [15.5.8] - 2026-05-28

### Breaking Changes

- Removed the single-number hunk header shorthand. A hunk header now REQUIRES two line numbers (`A A` for a single line, `A B` for a range); a bare `A` row throws `single-number hunk header "A" is no longer accepted`. The `&A` body-row shorthand for `&A..A` is unchanged.
- Changed hunk header syntax from `A-B:` to `@@ A..B @@` with `@@ A @@` shorthand for single lines
- Changed repeat payload sigil from `^A-B` to `&A..B` with `&A` shorthand for single lines
- Changed range separator from `-` to `..` in all contexts (anchors and repeats)
- Changed empty hunk behavior: concrete ranges now delete (no blank-line insertion); BOF/EOF empty hunks are now no-ops
- Removed `ApplyOptions` parameter from `applyEdits()` and related APIs; auto-absorb behavior is no longer configurable
- Removed diagnostic warnings for auto-absorbed duplicates from `ApplyResult`; warnings now come only from parser, patcher, or recovery
- Removed legacy hashline block syntax `A-B:`, `A-B:-`, and `^A-B` and replaced edits with `@@ A..B @@` hunks using `+` and `&` body rows
- Removed `A:` shorthand syntax; use explicit `A-A:` for single-line anchors
- Removed `↑` and `↓` payload sigils; use `|TEXT` for literal rows and `^A-B` for repeating original lines
- Removed standalone delete rows; use inline `A-B:-` syntax instead
- Removed `after_anchor` cursor kind; all inserts now use `before_anchor` positioning
- Replaced insert-above/insert-below payload sigils with linear body rows: `|TEXT` emits literal text and `^A-B` repeats original file lines inline.
- Replaced standalone delete rows with inline range deletes: use `A-B:-`.
- Changed empty `A-B:`, `BOF:`, and `EOF:` blocks to write one blank line instead of being rejected.

### Added

- Added compatibility parsing for apply_patch-style and unified-diff row noise by stripping path noise and converting context/delete body rows into hashline-compatible operations with warnings
- Added `A-B:-` inline delete syntax for concrete range anchors
- Added `^A-B` repeat payload syntax to emit original file lines inline
- Added support for empty anchor blocks to write one blank line at the anchor position

### Changed

- Changed unified-diff compatibility mode to silently drop `-old` rows and convert context rows to `+TEXT` literals with a warning instead of rejecting them
- Changed `ABORT_MARKER` behavior to terminate parsing without surfacing a warning
- Changed numeric ranges to `A..B` form and accepted `@@ A @@` as shorthand for `@@ A..A @@`
- Changed empty hunk behavior so a concrete empty hunk deletes the selected range and `BOF`/`EOF` empty hunks no longer insert a blank line
- Changed parse behavior for `*** Abort` to stop processing without returning a speculative truncation warning
- Changed payload row format from three sigils (`|`, `↑`, `↓`) to two (`|`, `^`)
- Changed range anchor syntax to require explicit `A-B` form (no single-line shorthand)
- Changed error messages to reference new syntax and remove references to removed sigils

## [15.5.5] - 2026-05-27

### Breaking Changes

- Changed hashline payload continuations from `+TEXT` to `\TEXT`; use `\` for an explicit blank payload line.

### Added

- Added `parsePatchStreaming(diff)` and `PatchSection.applyPartialTo(text, options)` for incremental diff previews. Both tolerate a trailing in-flight op (no payload yet, or a per-token parse error mid-stream) instead of throwing or emitting a phantom empty-payload edit.
- Added `Executor.endStreaming()` — sibling of `end()` that drops a pending op with no accumulated payload rather than flushing it.

### Fixed

- Parser now skips markdown-style `# ...` lines when they directly precede a hashline operation, making model-generated explanatory rows in prompt examples non-blocking.

### Removed

- Removed the `A-B!` / `A!` deletion operator. Use `A-B:` with the desired payload (or empty payload to blank the range) instead.

All notable changes to this package will be documented in this file.

## [15.5.4] - 2026-05-27

### Added

- Added a high-level `Patcher` API with all-or-nothing `apply` and staged `prepare`/`commit` flows for multi-file patch updates
- Added pluggable `Filesystem` and `SnapshotStore` abstractions with built-in `NodeFilesystem`, `InMemoryFilesystem`, and `InMemorySnapshotStore` adapters
- Added patch parsing that consumes `¶PATH#HASH` hunk headers, validates section file hashes, and supports optional patch envelope markers
- Added tolerant input handling that strips read/search prefixes and supports optional `cwd`/fallback-path resolution when parsing patch payloads
- Added automatic line-ending and BOM normalization on read, with original encoding shape restored on write
- Added follow-up helpers `buildCompactDiffPreview` and `streamHashLines` for compact diff previews and chunked streaming of numbered lines
- Added stale-file-hash recovery that replays edits against snapshots and merges results onto current file content when direct hash validation fails
- Initial standalone release. Extracted from `@pk-nerdsaver-ai/pi-coding-agent`.

### Fixed

- Fixed repeated patch application mutating cached `after_anchor` edits between target snapshots
- Fixed multi-section patching to preflight write policies and reject duplicate canonical targets before any section is committed
- Fixed mixed line-ending restoration to preserve the first newline style instead of rewriting ties to LF
