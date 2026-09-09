# Changelog

## [Unreleased]

## [16.3.0] - 2026-07-02

### Breaking Changes

- Upgraded the collaboration protocol to version 3. Guests using version 2 will now be rejected during the handshake with a protocol-mismatch error.

### Added

- Added support for interactive UI request and response frames, enabling browser guests to respond to prompts initiated by the host.

## [16.1.8] - 2026-06-20

### Breaking Changes

- Bumped `COLLAB_PROTO` to `2`. The `welcome` host frame now carries metadata only (`header`, `state`, `agents`, `entryCount`, optional `readOnly`) — the transcript moves to a new `snapshot-chunk` host frame (`{ entries: SessionEntry[]; final: boolean }`) sent immediately after the welcome. Hosts split large snapshots into multiple chunks; the last chunk carries `final: true`. Old guests speaking proto v1 are rejected with the existing protocol-mismatch error. ([#3144](https://github.com/can1357/oh-my-pi/issues/3144))

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
