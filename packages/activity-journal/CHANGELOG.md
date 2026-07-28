# Changelog

## [Unreleased]

### Added

- Added `ActivityLedgerReader` and `SqliteActivityLedgerReader`: a query-only view over a ledger owned by another process. It opens the sqlite handle read-only and deliberately skips the `CREATE TABLE IF NOT EXISTS` bootstrap that `SqliteActivityLedger` runs, since that DDL takes a write lock and would contend with the live writer on every open. Adds `listOverlapping(startedAt, endedAt)` for windowed queries.

### Changed

- `SqliteActivityLedger` now opens with `PRAGMA journal_mode = WAL` and `PRAGMA busy_timeout = 5000`. WAL lets readers proceed during writes instead of blocking on the rollback journal; the busy timeout turns a lost write race into a short wait instead of an immediate `SQLITE_BUSY` throw. WAL produces `-wal` and `-shm` sidecar files beside the main database — any code that copies, backs up, or deletes the ledger path must account for them.

## [16.3.0] - 2026-07-23

### Added

- Added a gopk capture-daemon activity sink with capture-root validation and constrained raw-clip cleanup.
- `GopkSinkOptions` accepts an optional structural `logger` (`warn(message, context?)`) so hosts can route the sink's rejection diagnostics through their own logging facility; defaults to `console`.
- Added a local activity-evidence ledger with privacy-first gopk-clips ingestion, raw-clip lifecycle cleanup, deterministic timeline aggregation, and model-safe synthesis facts.

### Fixed

- `gopk-clips.ts`'s `isLocalPointer` only accepted Windows drive paths (`C:\...`) or `file://` URIs, rejecting plain POSIX absolute paths — every clip derivative was silently dropped as "not local" on Linux/macOS. It now accepts single-leading-slash POSIX absolute paths while still rejecting UNC-style `//host/share` network paths.
