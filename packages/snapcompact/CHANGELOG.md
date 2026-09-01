# Changelog

## [Unreleased]

### Added

- Added compat-compiler CLI to manage model identity and capability rules via KDL configuration files
- Consolidated model identity, capability, and policy resolution into a unified rule-based engine
- Implemented declarative rule system for provider-specific model behaviors and compatibility constraints
- Added support for hierarchical cascade resolution of model properties based on class, family, and revision

### Changed

- Refactored model policy resolution to be driven by the generated compat rules instead of imperative code
- Migrated model taxonomy, variant collapse tables, and provider-specific overrides to external KDL files
- Standardized revision handling and model identification across discovery and runtime components

## [17.4.1] - 2026-08-21

### Added

- Restored `providerFrameBudget()` to allow callers to size archives according to the maximum frame budget the provider will send.

### Fixed

- Fixed an issue where character-based truncation could split inline base64 data URLs into corrupted payloads that were rejected by OpenAI-compatible providers. Data URLs are now replaced atomically with placeholders before truncation, and previously affected archives are healed during re-compaction.

## [17.3.8] - 2026-08-19

### Fixed

- Fixed image-based compaction confusing digit `0` with letter `O` and corrupting compacted identifiers (e.g. Slack IDs): the default frame fonts (X.org `8x13`, `6x12`, `5x8`) drew zero as a bare oval indistinguishable from `O`. Zero now carries a disambiguating interior slash (`8x13`) or bar (`6x12`/`5x8`); unscii-8 already shipped a slashed zero ([#8713](https://github.com/can1357/oh-my-pi/issues/8713)).

## [17.2.15] - 2026-08-12

### Fixed

- Fixed Anthropic model ID parsing to be case-insensitive and extended the high-resolution 1932px frame tier to Claude Opus 5 and later, preventing sessions from falling back to lower-resolution 1568px frames and preserving full history per compaction.

## [17.1.5] - 2026-07-27

### Fixed

- Fixed snapcompact resume guides reporting only the HQ grid width for mixed-width foveated archives ([#6712](https://github.com/can1357/oh-my-pi/issues/6712)).

## [17.1.0] - 2026-07-24

### Added

- Added an `includeThinking` serialization option (defaulting to `true`) to allow excluding assistant reasoning (`¶think:` sections) from archived transcripts.

## [16.5.0] - 2026-07-13

### Changed

- Updated archived transcript rendering to use a more compact format with `¶user:`, `¶think:`, `¶ai:`, and `¶call:` scopes, omitting repeated adjacent scope headers and appending tool-call intents as comments.

## [16.3.7] - 2026-07-05

### Fixed

- Fixed `resolveShapeForText(..., "auto")` to correctly select the `silver16-bw` shape for CJK-heavy transcript text while preserving explicit shape overrides.

## [16.2.8] - 2026-06-30

### Fixed

- Fixed large snapcompact archives being reconstructed into unbounded per-request image payloads by adding a frame base64 byte budget and omitting over-budget archive frames from prompt blocks. ([#3792](https://github.com/can1357/oh-my-pi/issues/3792))

## [16.2.7] - 2026-06-30

### Added

- Added the `silver16-bw` shape backed by an embedded Silver TrueType font to support CJK and other non-Latin text.
- Added `resolveShapeForText` to support font-aware shape resolution.

### Changed

- Improved non-ASCII text normalization by folding semantic emojis to ASCII labels (e.g., `[OK]`, `[WARN]`), dropping decorative emojis, and folding box-drawing symbols to ASCII skeletons.
- Enhanced missing glyph rendering to use the embedded Silver TrueType fallback per-character, including support for East Asian wide characters across two grid cells.
- Updated text wrapping, pagination, and provider shape geometries to support wide character footprints and updated X.org 8x13 font metrics.

## [16.1.23] - 2026-06-26

### Added

- Added `archiveSourceText(archive)` to extract a persisted frame archive's source text as plain text for LLM summarization. ([#3561](https://github.com/can1357/oh-my-pi/pull/3561) by [@serverinspector](https://github.com/serverinspector))
- Added `stripPreservedArchive(preserveData)` to drop the persisted frame-archive slot (`PRESERVE_KEY`) and collapse to `undefined` when no other state remains — shared by the agent and coding-agent compaction paths instead of duplicating the strip rule.

## [16.1.13] - 2026-06-22

### Fixed

- Fixed the Umans provider image budget to match its 10-image request cap.

## [16.1.8] - 2026-06-20

### Breaking Changes

- Changed core rendering functions `render` and `renderMany` to be asynchronous

## [16.1.0] - 2026-06-19

### Added

- Added `historyBlocks(archive)` to reconstruct ordered history blocks from archive data

### Changed

- Refactored compaction to be text-sourced, re-rendering from unified `Archive.text` source
- Implemented foveated archive layout (HQ edges, dense LQ middle) for optimized context usage
- Raised `MAX_FRAMES_DEFAULT` to 80 and consolidated `PROVIDER_IMAGE_BUDGETS`
- Updated OpenRouter to use standard 90-image budget
- Updated prompt instructions to clearly distinguish between plain-text and image history regions
- `Options.maxFrames` is now an upper limit clamped to `MAX_FRAMES_DEFAULT`, not a per-call default
- Rewrote the resume summary prompt into a structured reading guide (turn headings, grid/two-column layout, ink notes) and render file operations inline as a `FILES` section instead of a spliced `<files>` tag

### Fixed

- Fixed context budget undercounting by raising `FRAME_TOKEN_ESTIMATE` to 5024
- Improved file list formatting in compaction summaries

## [16.0.11] - 2026-06-19

### Changed

- Refined elision markers for file operations and truncated text for better display consistency
- Updated summary text for consistent descriptions of archived tool output
- Folded a much wider range of Unicode to ASCII in `normalize()` before native rendering: added a per-character Unicode NFKD decomposition fallback (fullwidth forms, super/subscripts, ligatures, circled and math-styled alphanumerics, Roman numerals, vulgar fractions) and expanded the `CHAR_FOLD` punctuation table (more quotes/primes, hyphens, the fraction slash, dot leaders, bullets, and arrows) so undrawable glyphs land on close ASCII equivalents instead of `?`

## [16.0.8] - 2026-06-18

### Added

- Added `<out>` block wrapping for tool results to improve document structure
- Rendered thinking process as italicized blocks above assistant text
- Displayed tool call intents as `//` comments in tool call headers
- Changed conversation role markers to standard Markdown headings

### Changed

- Merged tool results into their corresponding tool call blocks
- Preserved prose formatting around tool calls to maintain conversation flow
- Hidden `_i` argument from tool call output when an intent is provided
- Optimized assistant turn output to group thinking and text blocks efficiently

### Fixed

- Fixed improper splitting of assistant messages around useless tool calls

## [16.0.1] - 2026-06-15

### Added

- Added `openai-codex` to first-party provider image budgets so ChatGPT Plus/Pro Codex sessions use the same 200-image request cap as OpenAI API sessions instead of the unknown-provider floor.

## [15.13.1] - 2026-06-15

### Added

- Added two spacing-tuned frame variants to `SHAPE_VARIANTS`: `8on22-bw` (8x13 glyphs on a 22px pitch — extra line spacing) and `11on16-bw` (8x13 glyphs on an 11px advance — extra letter spacing). Both pin the indexed `stretch: false` path, so the native renderer draws natural-size glyphs on the padded cell box (the Rust path already advances by `cellWidth` and the new variants validate horizontal padding)

### Changed

- **Changed the per-provider default shapes to the spacing-tuned cells.** The previous shapes were tuned on the SQuAD *prose* eval, where dense cells won; a new tool-result legibility benchmark (`research/toolbench.py` — real `search`/`read`/`find` output with structure-sensitive QA) showed the prose-era density erases the line numbers and indentation that code/search output depends on. Anthropic moves from `6x12-dim` to `11on16-bw` (opus-4.8 f1 .806 vs .755 for plain `8on16-bw` and .351 for `6x12-dim`, which fell below the OCR ~16px/char floor and abstained); OpenAI and Google move to `8on22-bw` (gemini-3.5-flash f1 .934 vs .807 for `8on16-bw` and .287 for `doc-8on16-sent-dim`; same leading win on gpt-5.5/gpt-5.4-mini). Kimi and GLM keep their measured `8on16-bw`. The bigger cells pack fewer chars per frame, so inline frame-swapping now breaks even at a larger tool-result size

## [15.12.1] - 2026-06-12

### Changed

- `serializeConversation` now skips tool call/result pairs whose result is flagged contextually useless (`useless: true`, non-error), so archived frames stop carrying zero-match searches and timed-out waits

## [15.11.7] - 2026-06-12

### Added

- Added `SHAPE_VARIANTS`, the catalog of research-eval frame variants the native renderer reproduces faithfully (`8x8r`/`8x8u`/`6x6u`/`5x8` × `sent`/`bw`), with `ShapeVariantName`, `SHAPE_VARIANT_NAMES`, and the `isShapeVariantName` guard
- `resolveShape(api, variant?)` now accepts an explicit variant name (or `"auto"`); forced variants keep their geometry but are re-priced for the target provider's image billing (token estimate and OpenAI `original` detail hint)
- Added the six research-eval winning frame variants to `SHAPE_VARIANTS`: `6x12-dim` (Claude fable), `8x13-bw` (Opus), `8on16-bw` (GPT grid runner-up), `doc-8on16-bw` (GPT), `doc-8on16-sent` (GLM), and `doc-8on16-sent-dim` (Gemini/Kimi), backed by new `Shape` fields `stretch` (disable Lanczos stretch: natural glyphs on a larger cell pitch), `columns` (two word-wrapped newspaper columns), `stopwordDim`, and the X.org `6x12`/`8x13` fonts
- Added `dimStopwords()`, which prints high-frequency function words in dim ink via zero-width markers (skipping spans that are already dim), and `wrap()`, the greedy word-wrap used to typeset doc-layout pages; `geometry`/`render`/`renderMany`/`frames`/`compact` understand doc shapes (wrap once, paginate into `2 * rows`-line pages), and compaction frames persist `columns`/`stopwordDim` for mixed-shape detection
- `resolveShape` now takes a `ShapeTarget` (`{ api, id }` — a pi-ai `Model` works as-is) and detects the ideal shape from the **model id**, not just the wire API: a Claude routed through Vertex or an OpenAI-compatible gateway keeps its Claude shape, with billing still priced by the API family actually carrying the request. `idealShapeVariant(modelId)` exposes the model-line table; unmeasured models fall back to the API family's winner
- `resolveShape` now also resolves an ideal **frame size** per model line, and billing estimates come from verified per-family formulas instead of flat 1568px constants: Anthropic bills 28px patches capped at 4,784 visual tokens (+5% margin), Gemini 3.x bills a fixed 1,120-token `media_resolution` budget per image at any pixel size, and OpenAI bills 32px patches × 1.2 under the 10,000-patch `detail: "original"` budget. High-res Claude lines (Opus 4.7+, Fable, Mythos — native 2576px-edge ingestion) get 1932px frames (same recall and cost, a third fewer frames); Gemini gets 2048px frames (+70% chars per frame at the same bill); GPT and Kimi stay at 1568px (area-proportional billing and a model-side 1792px processor cap, respectively). `idealShapeVariant` now returns an `IdealShape` (`{ variant, frameSize? }`)
- Added per-provider image-count budgets: `PROVIDER_IMAGE_BUDGETS`, `DEFAULT_PROVIDER_IMAGE_BUDGET`, `providerImageBudget()`, and `providerFrameBudget()` (the image budget clamped to `MAX_FRAMES`). OpenRouter is capped at its measured hard limit of 8 images per request (excess images are silently dropped with no error); unknown providers get a safe floor of 5
- Added `Archive.textTail`: archive content past the frame budget is no longer dropped — `compact()` stops rendering at the budget and keeps the newest unframed slice as verbatim text on the summary (capped at two frame capacities with middle elision, counted into `truncatedChars` when elided). The tail persists in `preserveData` and is folded back into frames by the next compaction

### Changed

- Frames are no longer padded to a square: the native renderer clips each PNG's height to the text rows actually printed, so a partially filled frame (typically the newest) bills only the pixel rows it uses
- **Changed the OpenAI default shape from `6x6u-sent` to `8on16-bw`.** A production-regime mono eval (gpt-5.5, the full 800k-char SQuAD flow in one request, n=50) scored the old dense default f1 .602 vs .851 for `8on16-bw` rendered by the production pipeline, at near-equal total cost (the dense cells burned the frame savings on reasoning tokens); chunked exp14 had already scored `8on16-bw` .906. `SHAPES.openaiDense` is renamed to `SHAPES.openai`
- **Changed the Google default shape from `8x8r-sent` to `doc-8on16-sent-dim`.** Production-rendered mono eval on gemini-3.5-flash (400k chars, one request, n=25): f1 .900 vs .853 for the repeated grid at lower cost, agreeing with the chunked round-2 winner
- **Changed the Anthropic default shape from `8x8r-bw` to `6x12-dim`.** Production mono eval on claude-fable (400k chars, one request, n=25): f1 .840 vs .877 for the repeated grid — within noise — at 37% lower cost (12 frames instead of 21 per 400k chars), with clean completions in every probe; opus reads the same trade (.800 vs .833 at 42% lower cost)
- `normalize()` now keeps line structure: whitespace runs containing a line break collapse to `NEWLINE_GLYPH` (U+2588 FULL BLOCK, drawn by the native renderer as a pitch-black cell one character wide) instead of a plain space; leading/trailing breaks are trimmed, and the frame-reading prompt explains the marker
- `normalize()` now skips characters the fonts cannot render instead of printing `?` blanks: whole ANSI escape sequences are stripped, and bare control characters, zero-width format characters (ZWSP, BOM, directional marks), combining marks, and lone surrogates are dropped without occupying a cell; `?` remains the fallback for unsupported graphic characters only

## [15.11.4] - 2026-06-12

### Breaking Changes

- Renamed every export to drop the `snapcompact`/`Snapcompact`/`SNAPCOMPACT_` qualifier — the package is meant to be consumed via `import * as snapcompact from "@oh-my-pi/snapcompact"`. Functions: `snapcompactCompact` → `compact`, `renderSnapcompactFrame` → `render`, `snapcompactGeometry` → `geometry`, `normalizeForSnapcompact` → `normalize`, `serializeSnapcompactConversation` → `serializeConversation`, `snapcompactImages` → `images`, `getPreservedSnapcompactArchive` → `getPreservedArchive`, `isSnapcompactShape` → `isShape`, `resolveSnapcompactShape` → `resolveShape`, `createSnapcompactFileOps` → `createFileOps`, `computeSnapcompactFileLists` → `computeFileLists`, `upsertSnapcompactFileOperations` → `upsertFileOperations`. Types: `SnapcompactShape` → `Shape`, `SnapcompactFrame` → `Frame`, `SnapcompactArchive` → `Archive`, `SnapcompactGeometry` → `Geometry`, `SnapcompactOptions` → `Options`, `SnapcompactSerializeOptions` → `SerializeOptions`, `SnapcompactFileOperations` → `FileOperations`, `SnapcompactCompactionDetails`/`Preparation`/`Result` → `CompactionDetails`/`CompactionPreparation`/`CompactionResult`, `SnapcompactConvertToLlm` → `ConvertToLlm`. Constants: `SNAPCOMPACT_X` → `X` (`SHAPES`, `FRAME_SIZE`, `MAX_FRAMES`, `FRAME_TOKEN_ESTIMATE`, `PRESERVE_KEY`, `TOOL_RESULT_MAX_CHARS`, `TOOL_ARG_MAX_CHARS`, `TOOL_CALL_MAX_CHARS`, `TRUNCATE_HEAD_RATIO`, `DIM_ON`, `DIM_OFF`).

### Added

- Added `renderMany()` for paging arbitrary text into snapcompact PNG frames as LLM image blocks, and `frames()` for predicting the frame count without rendering

## [15.11.0] - 2026-06-10

### Breaking Changes

- Changed `renderSnapcompactFrame` output from `png: Uint8Array` to `data: string` base64, requiring consumers to read frame payloads from `frame.data`

### Added

- Added new serialization options `toolResultMaxChars`, `toolArgMaxChars`, `toolCallMaxChars`, `truncateHeadRatio`, and `dimToolResults` to `snapcompactCompact`/`serializeSnapcompactConversation` so callers can tune how tool results and arguments are archived
- Added exported default constants `SNAPCOMPACT_TOOL_RESULT_MAX_CHARS`, `SNAPCOMPACT_TOOL_ARG_MAX_CHARS`, `SNAPCOMPACT_TOOL_CALL_MAX_CHARS`, and `SNAPCOMPACT_TRUNCATE_HEAD_RATIO` for reuse when configuring truncation limits
- Added provider-specific snapcompact frame-shape presets and shape helpers (`SNAPCOMPACT_SHAPES`, `resolveSnapcompactShape`, `isSnapcompactShape`) so callers can consistently select validated image-frame geometry for archive renders
- Added `file-operations.md` and `snapcompact-summary.md` prompts to preserve file-read/write context and frame metadata in the compaction prompt flow
- Added a full `packages/snapcompact/research` experiment and visualization suite for running snapcompact SQuAD studies, provider probes, and activation-style analyses
- Added package-level TypeScript exports and publication config so consumers can import `@oh-my-pi/snapcompact` with typed access to snapcompact APIs
- Published `@oh-my-pi/snapcompact` as the reusable snapcompact compaction package, including bitmap-frame rendering helpers, archive helpers, and the local `snapcompactCompact()` strategy.

### Changed

- Changed truncation in archived tool output to keep both the beginning and end of long text using a configurable head/tail ratio instead of a single hard cut
- Changed tool-result text rendering so archived tool results are shown in dim gray ink by default and the summary prompt notes that dim text is archived tool output
- Changed `RenderedFrame` visible-character accounting so `chars` no longer includes invisible dim-control markers
- Changed the file-operations summary block to a single `<files>` tag: one grouped, prefix-folded directory tree with per-file `(Read)`/`(Write)`/`(RW)` markers, replacing the separate `<read-files>`/`<modified-files>` lists; `upsertSnapcompactFileOperations` takes the cumulative read set to distinguish `(RW)` from blind writes

### Fixed

- Fixed frame rendering at archive chunk boundaries to reopen dim spans when a chunk ends inside a dimmed tool-result segment
- Fixed message serialization to strip user- and assistant-provided dim markers so only renderer-generated dim spans can be applied
