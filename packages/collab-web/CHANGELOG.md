# Changelog

## [Unreleased]

## [16.2.0] - 2026-06-27

### Added

- Added dedicated renderers for glob, grep, and legacy find and search tools to improve the readability of search and file discovery results.

## [16.1.23] - 2026-06-26

### Fixed

- Hid advisory wrapper tags in collab transcript Markdown while preserving their content. ([#3559](https://github.com/can1357/oh-my-pi/issues/3559))

## [16.1.16] - 2026-06-23

### Added

- Added support for Ruby and Julia code cells in the eval tool

### Changed

- Updated the eval tool view to render the new single-cell eval args (flat `language`/`code`/`title`/`timeout`/`reset`) and to highlight Ruby (`rb`) and Julia (`jl`) cells with their own syntax instead of collapsing them to Python, while still parsing legacy multi-cell `cells` arrays and framed `input` strings from older transcripts.

### Fixed

- Improved compatibility with legacy todo task transcripts

## [16.1.8] - 2026-06-20

### Breaking Changes

- Bumped `COLLAB_PROTO` to `2`: the `welcome` frame now carries metadata only (header/state/agents/`entryCount`) and the transcript follows in a train of targeted `snapshot-chunk` frames terminated by `final: true`. Old guests speaking proto v1 are rejected with the existing protocol-mismatch error.

### Changed

- Restyled the collab shell with the stats dashboard theme tokens and added the persisted system/light/dark theme toggle.

### Fixed

- Fixed the guest hanging in the "waiting" phase on large host sessions: the client now accumulates `snapshot-chunk` frames into the transcript snapshot and only transitions to `live` after the final chunk lands (or immediately when the host's snapshot is empty). ([#3144](https://github.com/can1357/oh-my-pi/issues/3144))

## [16.0.10] - 2026-06-18

### Added

- Added support for collab browser wrapper links whose web UI host differs from the relay host, so the connect screen joins the relay encoded in the URL fragment.

## [16.0.5] - 2026-06-17

### Fixed

- Preserved assistant soft line breaks and Markdown paragraph/list indentation in the collab web transcript renderer so tree-shaped prose no longer collapses into one paragraph.
- Changed collab web transcript wrapping to keep Korean/CJK words intact before falling back to emergency breaks for long URLs or identifiers.

## [16.0.3] - 2026-06-16

### Removed

- Removed rendering support for the `render_mermaid` tool from the web tool registry

## [15.13.3] - 2026-06-15

### Fixed

- Wrapped composer button labels to display icon-only on mobile devices for a more compact and readable layout
- Made the connect screen, ended session card, and notification toasts fully responsive for smaller device viewports
- Fixed mobile layout issues where the entire chat flow would overflow horizontally and text was rendered too large on iOS Safari (by setting `text-size-adjust: 100%`)
- Made transcript rows stack vertically on small screens to optimize reading space, and prevented grid track expansion
- Hid non-essential metadata (such as the model name, thinking level, and working directory path) and context gauge tracks on mobile headers to prevent overflow
- Fixed mobile layout issues where the entire chat flow would overflow horizontally and text was rendered too large on iOS Safari (by setting `text-size-adjust: 100%`)
- Made transcript rows stack vertically on small screens to optimize reading space, and prevented grid track expansion
- Hid non-essential metadata (such as the model name, thinking level, and working directory path) and context gauge tracks on mobile headers to prevent overflow
- Wrapped composer button labels to display icon-only on mobile devices for a more compact and readable layout
- Made the connect screen, ended session card, and notification toasts fully responsive for smaller device viewports
- Fixed mobile layout issues where the entire chat flow would overflow horizontally and text was rendered too large on iOS Safari (by setting `text-size-adjust: 100%`)
- Made transcript rows stack vertically on small screens to optimize reading space, and prevented grid track expansion
- Hid non-essential metadata (such as the model name, thinking level, and working directory path) and context gauge tracks on mobile headers to prevent overflow
- Wrapped composer button labels to display icon-only on mobile devices for a more compact and readable layout
- Made the connect screen, ended session card, and notification toasts fully responsive for smaller device viewports

## [15.13.1] - 2026-06-15

### Added

- Added `16px` font-size overrides for all text inputs and textareas on mobile viewports to prevent iOS Safari from automatically zooming in the page on focus
- Added top and bottom safe-area padding (`env(safe-area-inset-*)`) to the header bar, connection card, and composer to prevent them from being covered by notches/home indicators
- Added translucent click-outside-to-close backdrops for the mobile side rail and agent details drawer to match native mobile chat applications
- Disabled vertical bounce reload gesture (`overscroll-behavior-y: none`) on the page body to prevent accidental pull-to-refresh page reloads during scrolling
- Applied global touch responsiveness updates (`touch-action: manipulation` and tap-highlight removals) to links and buttons to improve mobile responsiveness

### Fixed

- Pinned the app shell grid to a single `minmax(0, 1fr)` column so a long session title can no longer set a min-content floor that pushes the header, transcript, and composer wider than narrow or in-app mobile viewports; the title now ellipsizes instead of clipping every row's right edge

## [15.12.4] - 2026-06-13

### Fixed

- Fixed context usage percentage calculations to return null when context window is missing or non-positive, preventing invalid or Infinity/NaN usage display

## [15.12.2] - 2026-06-12

### Fixed

- Link parsing accepts the new dot-joined room secret (`<roomId>.<key>`, `/r/<roomId>.<key>`) and leniently decodes `%23`-mangled legacy deep links (macOS Foundation percent-encodes a second `#` when terminals open clicked links), which previously failed to connect

## [15.12.0] - 2026-06-12

### Added

- Added support for optional write tokens in collaboration links so full links can embed the room key and write token (48-byte fragment) while legacy key-only (32-byte) links remain supported
- Added parsing of web deep links in the form `https://<relay>/#<room>#<key>` so links opened from a page URL hash resolve correctly
- Added a `readOnly` field to guest snapshots to indicate whether the connected guest has view-only access
- Link parsing accepts full web deep links (`https://<relay>/#<link>`) pasted into the connect screen, matching the URL `/collab` now prints
- Site metadata for the deployed client: favicon set, web app manifest, robots.txt, sitemap, JSON-LD, and Open Graph/Twitter cards with a collab-specific og-image; static assets live in `public/` and are copied into `dist/` at build
- Added `src/tool-render/`: a shared per-tool React renderer suite (one view per built-in tool — bash, read, edit diffs, todo boards, eval cells, task batches, LSP, search, browser screenshots, …) with a common chrome (`ToolView`), design tokens that adapt to the host theme, and an `<omp-tool-view>` web-component wrapper; `scripts/build-tool-views.ts` bundles it (React included) for embedding into coding-agent HTML session exports
- Task tool cards now render agent ids as drill-down links: clicking one opens the matching subagent drawer in the live client (and the embedded sub-session overlay in HTML exports) via the new `ToolRenderHost` seam

### Changed

- Changed composer input to disable prompting and show a read-only session placeholder when guests connect in view-only mode
- Changed agent drawer to hide kill/revive controls and message input for read-only guests
- Changed header bar to show a read-only session chip and label read-only participants as view-only
- Restyled the client onto the omp brand palette: deep-purple surfaces, pink accent, cyan focus ring (was warm amber); og-image re-rendered to match
- Transcript tool cards now use the per-tool renderers instead of the generic args/result JSON dump — structured summaries in the collapsed header and tool-specific bodies (commands, diffs, todo boards, result images) when expanded

## [15.11.8] - 2026-06-12

### Added

- Added deep-link auto-connection support from `#<roomId>#<key>` URLs when opening the web app
- Added subagent-focused UI with a side rail and detail drawer that surfaces each subagent’s lifecycle, running progress, and per-subagent transcript
- Added session status controls in the shell, including connection banners, toast notifications, and rejoin/new-link actions after a session ends
- Added the collab web package with the browser guest client, mock host, local relay, and relay contract tests.

### Changed

- Changed relay socket behavior to retry transient disconnections with exponential backoff while treating terminal relay-close conditions and decryption failures as non-retriable
- Changed subagent transcript decoding to handle streamed JSONL payload chunks incrementally by preserving carry-over data across chunks
- Replaced the vendored collab wire type mirror with shared `@pk-nerdsaver-ai/pi-wire` protocol contracts.

### Security

- Hardened transcript Markdown rendering by escaping embedded HTML and allowing only safe link schemes
