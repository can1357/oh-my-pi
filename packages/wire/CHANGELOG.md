# Changelog

## [Unreleased]

### Added

- Added `TspToolProps.command` (the command line Copy command copies), `TspToolProps.preview: "children"` (the collapsed body stays whole while its children clamp) and `TspCodeProps.preview`

## [18.8.0] - 2026-10-07

### Changed

- Updated `TspEditorProps.placeholder` and `TspInputProps.placeholder` to accept `TspText`, enabling styled placeholder text.

## [18.5.1] - 2026-10-03

### Added

- Added support for submitting explicit prompts to live editable composers without simulating keyboard input.

## [18.4.11] - 2026-10-02

### Added

- Added support for agent completion estimates in the wire protocol.

## [18.4.9] - 2026-10-01

### Added

- Added terminal scrolling support through the TSP scroll operation, allowing keyboard scrolling of the terminal scroller when supported.
- Added a terminal focus event for requesting keyboard focus on editors and inputs, or returning focus to the preferences sheet.

## [18.4.6] - 2026-10-01

### Added

- Added the `TspMeterMark` component for marking a position on a meter track with a custom icon and a total value that defines the full span of the track.

## [18.4.4] - 2026-09-29

### Added

- Added the Tern Surface Protocol wire contract (`@oh-my-pi/pi-wire`): message framing constants, the component vocabulary, document ops, frames, the handshake and terminal events that let omp render natively in terminals that speak it

## [18.2.11] - 2026-09-23

### Added

- Added public API contract and authentication schemas for the Skillshare registry.

## [18.2.5] - 2026-09-17

### Added

- Added the `omp stream` wire contract (`@oh-my-pi/pi-wire/stream`) for pane screen updates, viewer snapshots and chat, channel metadata, and `live.omp.sh` stream routes.
- Added authentication support for stencil.so streams, including user identity in welcome messages, channel ownership metadata, and explicit unauthorized and forbidden close codes.

### Changed

- Restricted channel names to the Stencil-compatible alphanumeric-and-underscore format and derived host channels from authentication tokens rather than URL path segments.

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
