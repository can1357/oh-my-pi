# Changelog

## [Unreleased]

## [16.3.0] - 2026-07-23

### Added

- Added `host-away` / `host-back` relay→guest control messages: the relay now holds a room open for a grace window when the host socket drops instead of closing guests immediately.

### Changed

- Changed the default collaboration relay and encrypted share endpoints to the owned `collab.pkking.computer` service.

## [16.1.9] - 2026-06-20

### Added

- Added remote-control session list/load frames and per-agent cwd metadata to the collab wire contract.

## [15.12.4] - 2026-06-13

### Changed

- Changed `WireModel.contextWindow` and `ContextUsage.contextWindow` to `number | null` to allow representing unavailable context-window values

## [15.12.0] - 2026-06-12

### Added

- Added `readOnly` flags to participant and session payload types to indicate when a guest is connected via a read-only (view) link
- Added `writeToken` to `GuestFrame` hello payloads and parsed collaboration links so full-access links can carry and expose a write-capability token
- Added `ROOM_KEY_BYTES` and `WRITE_TOKEN_BYTES` constants for room key and write-token sizing in the wire protocol
- Added `DEFAULT_SHARE_URL` (`https://my.omp.sh/s`), the default share viewer/upload base for `/share` links

## [15.11.8] - 2026-06-12

### Added

- Added shared collab live-session wire contracts for the host CLI and browser guest client.
