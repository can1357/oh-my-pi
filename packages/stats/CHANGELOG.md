# Changelog

## [Unreleased]

## [16.2.0] - 2026-06-27

### Added

- Added a Gain tab to the `omp stats` dashboard (`/#/gain`) to display snapcompact token-savings with project scoping from synced session folders.

## [16.1.17] - 2026-06-24

### Fixed

- Stats sync counted the same provider request multiple times when a forked or branched session file copied the parent's entries verbatim. Inserts now skip rows whose `(entry_id, timestamp)` already exists under a different `session_file`, and a one-shot migration on the next `omp stats` run collapses any pre-existing duplicates ([#3370](https://github.com/can1357/oh-my-pi/issues/3370)).

## [16.1.15] - 2026-06-22

### Added

- Added token usage breakdown by agent type (Main, Subagents, Advisor) to the overview dashboard

## [16.0.10] - 2026-06-18

### Changed

- Updated description of moderated content categories to use more inclusive terminology

### Fixed

- Wide data tables (Requests, Errors, Overview, Projects) overflowed the page horizontally at narrow-desktop widths (768-1023px): the `.stats-table-desktop-only` wrapper used for mobile-card tables lacked the `overflow-x: auto` containment that `.stats-table-container` already has. They now scroll within their own bounds instead of spilling the page body.

## [16.0.5] - 2026-06-17

### Added

- New Projects view summarizing usage, cost, and reliability per project folder (backed by the existing `/api/stats/folders` endpoint).
- System-aware light/dark theme toggle — follows the OS by default, and an explicit choice persists across reloads.

### Changed

- Redesigned the local stats dashboard with an OMP-themed product shell, dedicated per-section views, accessible loading/empty/error states, and flicker-free navigation between screens and time ranges.

### Fixed

- The 1h time-range chart rendered an empty/single-point line; it now buckets at 5-minute granularity for a real trend.

## [15.13.3] - 2026-06-15

### Changed

- Renamed `__omp_stats_sync_worker` to `__omp_worker_stats_sync`.

## [15.13.1] - 2026-06-15

### Fixed

- Dropped `git` from the profanity list so normal repository mentions no longer count as profanity

## [15.12.4] - 2026-06-13

### Fixed

- Fixed the stats dashboard's SQLite init never setting `PRAGMA busy_timeout`, so a concurrent `omp` startup hitting WAL recovery could crash `initDb()` with `SQLITE_BUSY` instead of waiting through it. The busy handler is now installed before `PRAGMA journal_mode=WAL` ([#2421](https://github.com/can1357/oh-my-pi/issues/2421)).

## [15.11.0] - 2026-06-10

### Added

- Added support for prebuilt npm bundle mode via `PI_BUNDLED`, allowing the stats server to use an embedded dashboard bundle in packaged CLI distributions

### Fixed

- Fixed handling of legacy `embedded-client.generated.txt` placeholder content so it is treated as missing archive instead of being decoded into invalid bytes
- Fixed ENOENT handling while scanning dashboard source/build directories so missing `client/` or `dist/client` trees no longer crash startup

## [15.10.11] - 2026-06-10

### Changed

- Bundled-model lookups (`getBundledModel`, `GeneratedProvider`) now import from the new `@pk-nerdsaver-ai/pi-catalog` package instead of the `@pk-nerdsaver-ai/pi-ai` barrel, which no longer re-exports catalog values
- The session-sync worker re-enters the host CLI entry (`workerHostEntry()` + `__omp_stats_sync_worker` argv selector) when running inside omp — source, npm bundle, or compiled binary — and keeps loading its own `sync-worker.ts` module directly for standalone `omp-stats`, bun test, and SDK hosts

## [15.1.6] - 2026-05-19

### Fixed

- Fixed `omp stats` crashing on first session sync in published `omp-{linux,darwin,windows}-*` binaries with `BuildMessage: ModuleNotFound resolving "./packages/stats/src/sync-worker.ts"`; the release build script now lists the stats sync, browser tab, and JS eval workers as explicit `--compile` entrypoints so Bun emits them into bunfs, matching the dev build script and the AGENTS.md worker spawn contract. ([#1150](https://github.com/can1357/oh-my-pi/issues/1150))

## [15.1.0] - 2026-05-15

### Fixed

- Fixed incremental `parseSessionFile(path, fromOffset)` losing the active service tier when resuming past a `service_tier_change` entry, so priority OpenAI replies appended after the offset are now credited with `premiumRequests: 1` (regression introduced by 13f59162e which stopped folding priority-tier into per-message premium counts)

## [15.0.1] - 2026-05-14

### Breaking Changes

- Raised the minimum required Bun version to >=1.3.14 in package metadata

### Changed

- Changed the "Premium Reqs" dashboard card to also include OpenAI priority service-tier requests (`serviceTier: "priority"`), counting each as 1 premium request alongside GitHub Copilot premium calls. Pre-existing sessions are backfilled on the next `omp stats` run: a one-shot `premium_requests_priority_v1` sentinel wipes `file_offsets` so every session re-parses, and `insertMessageStats` now `UPSERT`s `premium_requests` (other columns untouched) using the `service_tier_change` entries already in the session log to retroactively credit priority traffic.

## [14.9.9] - 2026-05-12

### Added

- Added separate input-token and output-token totals to the overview dashboard cards.

### Fixed

- Fixed `omp stats` in compiled binaries by using the serial sync path instead of spawning a raw file-asset worker that cannot import bundled parser code.
- Fixed behavior backfills after failed compiled-binary sync attempts by marking the backfill sentinel only after a successful full sync.

## [14.9.7] - 2026-05-12

### Breaking Changes

- Broke backward compatibility of behavior stats fields by replacing `yellingSentences`/`dramaRuns` with `yelling`/`anguish` and adding `negation`, `repetition`, `blame` in query result types and persisted `user_messages` schema

### Added

- Added `SyncOptions` to `syncAllSessions` with `onProgress` and `workers` to optionally show per-file sync progress and tune parser concurrency
- Added new frustration behavior metrics (`negation`, `repetition`, `blame`) plus a `frustration` aggregate in behavior charts, model tables, and summary cards

### Changed

- Changed sync ingestion to parse session files through a worker pool while applying parsed results and database writes on the main thread
- Changed behavior analysis to strip code blocks, XML/URLs, quoted lines, and placeholders before scoring and to suppress signals on long structured messages
- Changed dashboard metrics labels and totals to the new signal names, including replacing the old three-signal totals with `yelling`, `profanity`, `anguish`, and `frustration`
- Changed sync output to print a live terminal progress indicator while processing session files

### Fixed

- Fixed user-message attribution so assistant model/provider links are backfilled during incremental sync instead of being left unknown
- Fixed word-boundary regex handling in profanity detection so matching now works as intended in normal prose

## [14.9.5] - 2026-05-12

### Added

- Added time range selection options (1h, 24h, 7d, 30d, 90d, All) to the dashboard header and bound them to reloading statistics for the selected window
- Added a **Behavior** dashboard page that tracks user yelling (CAPS), profanity, and dramatic punctuation (`!!!` / `???`) per day, with by-model comparisons mirroring the cost page
- Added a per-model behavior table to the **Behavior** page mirroring the Models table: sortable rows of CAPS / profanity / drama hits per model with sparkline trend and an expandable per-model breakdown chart
- Added optional `range` query parameter support on stats endpoints to retrieve metrics scoped to a requested time window

### Changed

- Changed the Costs dashboard summary to report totals, average per day, and top model for the selected time range instead of a fixed 30-day window and removed the previous-30-day trend comparison
- Changed behavior metrics ingestion to compute yelling from user message sentence-level uppercase ratios, filtering out short uppercase fragments so the behavior data is attributed to messages more accurately
- Removed per-chart 14/30/90 day pickers on Costs and Behavior pages so every page obeys the single time-range selector in the header
- Changed dashboard and stats queries to return data from the selected time window instead of always using all-time aggregates
- Changed the default displayed range in the UI/API to last 24h
- Added support for returning all data when `range=all` is requested

### Fixed

- Fixed handling of unknown `range` values by falling back to the last 24h instead of returning unscoped data
- Fixed `omp stats` failing to build the client on globally-installed installs by promoting `tailwindcss` from `devDependencies` to `dependencies` (the client build runs at runtime)

## [14.5.4] - 2026-04-28

### Fixed

- Fixed GPT cost reporting by deriving missing OpenAI Codex costs from the model catalog and backfilling existing zero-cost rows.

## [13.6.0] - 2026-03-03

### Fixed

- Include subtask session files in usage stats ([#250](https://github.com/can1357/oh-my-pi/issues/250))
