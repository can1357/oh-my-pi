# Changelog

## [Unreleased]

### Fixed

- Fixed orphaned debugger attachments and the Chrome debugging infobar surviving relay outages or extension restarts ([#8930](https://github.com/can1357/oh-my-pi/issues/8930)).
- Fixed reconnect races that could lose, duplicate, or misclassify recovered browser-relay attachments ([#8930](https://github.com/can1357/oh-my-pi/issues/8930)).

## [18.0.7] - 2026-08-26

### Changed

- Clarified the scope of the two browser relay opt-in paths: per-call `app.relay: true` enables relay access for an individual call, while the `browser.relay` setting enables it by default across projects in a profile.

## [17.2.5] - 2026-08-03

### Added

- Initial release of the Chrome MV3 extension, enabling the omp browser tool to attach to and drive existing browser tabs via chrome.debugger.
- Added automatic, robust tab management that groups active agent-driven tabs into a dedicated per-window "omp" tab group and ensures clean dissolution upon disconnect.
