# Changelog

## [Unreleased]

## [18.13.3] - 2026-10-28

### Changed

- Updated Bun engine requirement to ≥1.4.4

## [18.13.0] - 2026-10-26

### Added

- The extension reports the omp version that installed it, and reloads itself when the relay updates its files after an omp upgrade ([#15105](https://github.com/can1357/oh-my-pi/pull/15105) by [@will-bogusz](https://github.com/will-bogusz))

## [18.12.2] - 2026-10-18

### Fixed

- Fixed a relay tab close failing when Chrome refuses it for a moment (a tab being dragged); the extension retries it ([#16119](https://github.com/can1357/oh-my-pi/pull/16119) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed tabs created for a relay request whose connection dropped mid-create staying open, and answers to such requests going to a later connection ([#16119](https://github.com/can1357/oh-my-pi/pull/16119))
- Fixed the relay resolving an old tab id to a different tab after a browser restart; the extension now reports each browser run ([#16119](https://github.com/can1357/oh-my-pi/pull/16119))

## [18.8.8] - 2026-10-10

### Fixed

- Fixed tabs a relay client asks to open in the background being created as the selected tab ([#15109](https://github.com/can1357/oh-my-pi/pull/15109) by [@will-bogusz](https://github.com/will-bogusz))

## [18.6.3] - 2026-10-06

### Fixed

- Fixed the extension reporting tabs that DevTools or another debugger extension is inspecting as its own attachments, which made the relay skip attaching to them ([#14224](https://github.com/can1357/oh-my-pi/pull/14224) by [@will-bogusz](https://github.com/will-bogusz))

## [18.5.1] - 2026-10-03

### Fixed

- Fixed tab adoption stalling when Chrome discards background tabs.

## [18.3.1] - 2026-09-25

### Fixed

- Fixed browser relay support when multiple browser instances, such as Chrome and Edge, are connected simultaneously, ensuring tabs and relay requests remain associated with the correct browser while preserving single-browser compatibility for extensions without an instance identifier.

## [18.0.7] - 2026-08-26

### Changed

- Clarified the scope of the two browser relay opt-in paths: per-call `app.relay: true` enables relay access for an individual call, while the `browser.relay` setting enables it by default across projects in a profile.

## [17.2.5] - 2026-08-03

### Added

- Initial release of the Chrome MV3 extension, enabling the omp browser tool to attach to and drive existing browser tabs via chrome.debugger.
- Added automatic, robust tab management that groups active agent-driven tabs into a dedicated per-window "omp" tab group and ensures clean dissolution upon disconnect.
