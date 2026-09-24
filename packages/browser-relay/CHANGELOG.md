# Changelog

## [Unreleased]

## [18.3.1] - 2026-09-25

### Fixed

- Fixed browser relay support when multiple browser instances, such as Chrome and Edge, are connected simultaneously, ensuring tabs and relay requests remain associated with the correct browser while preserving single-browser compatibility for extensions without an instance identifier.
### Added

- 0.2.2: re-fetch the tab after creation-time grouping before replying — the object returned by `chrome.tabs.create` snapshots pre-grouping state, so the relay never saw the new groupId and fell back to claim-sync grouping.
- Busy affordances matching Claude in Chrome: the extension now pins a small "⏳" badge on the toolbar icon of the exact tab being driven (complementing the existing "⏳" group-title suffix), while the CLI's tab worker pulses a frame along all four viewport edges of the page and glides a virtual cursor between interaction points for the whole duration of a driving burst.


## [18.0.7] - 2026-08-26

### Changed

- Clarified the scope of the two browser relay opt-in paths: per-call `app.relay: true` enables relay access for an individual call, while the `browser.relay` setting enables it by default across projects in a profile.

## [17.2.5] - 2026-08-03

### Added

- Initial release of the Chrome MV3 extension, enabling the omp browser tool to attach to and drive existing browser tabs via chrome.debugger.
- Added automatic, robust tab management that groups active agent-driven tabs into a dedicated per-window "omp" tab group and ensures clean dissolution upon disconnect.
