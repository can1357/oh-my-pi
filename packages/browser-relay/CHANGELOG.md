# Changelog

## [Unreleased]

### Fixed

- Tabs opened through the relay now open in the background without stealing focus from the user's foreground tab ([#11662](https://github.com/can1357/oh-my-pi/pull/11662) by [@jwaldrip](https://github.com/jwaldrip)).
- Activating a driven tab for screenshots no longer raises or focuses the browser window ([#11662](https://github.com/can1357/oh-my-pi/pull/11662) by [@jwaldrip](https://github.com/jwaldrip)).

## [18.0.7] - 2026-08-26

### Changed

- Clarified the scope of the two browser relay opt-in paths: per-call `app.relay: true` enables relay access for an individual call, while the `browser.relay` setting enables it by default across projects in a profile.

## [17.2.5] - 2026-08-03

### Added

- Initial release of the Chrome MV3 extension, enabling the omp browser tool to attach to and drive existing browser tabs via chrome.debugger.
- Added automatic, robust tab management that groups active agent-driven tabs into a dedicated per-window "omp" tab group and ensures clean dissolution upon disconnect.
