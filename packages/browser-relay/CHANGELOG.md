# Changelog

## [Unreleased]

### Fixed

- Fixed relay sessions leaving an unwanted “omp” tab group in Chrome’s bookmarks bar after closing relay tabs.

## [19.1.1] - 2026-11-23

### Fixed

- The side panel’s Connection settings now show the browser’s specific reason when it refuses the native host (for example, because native messaging is blocked by enterprise policy), instead of incorrectly suggesting that the host may be missing.

## [19.1.0] - 2026-11-21

### Breaking Changes

- The omp extension now uses a pinned Chrome extension ID and connects to the browser relay through its native host. Reinstall the extension using Chrome’s “Load unpacked” flow; the relay port and token options have been removed.

### Added

- Added an omp Chrome side panel with session model selection, role shortcuts, thinking controls, input shortcuts, message queuing, and run interruption controls.
- Added browser interaction features including page overlays, image and element picking, Teach, scheduled shortcuts, and GIF export.

### Changed

- The Chrome side panel shows brief labels for tool steps with structured intents.
- The extension now keeps registered installations up to date across omp upgrades and reloads when idle.
- Browser relay ports are assigned automatically and discovered locally by terminal clients, while sidebar chats continue using their existing connection.
- Side panel sessions now control the connected Chrome browser directly instead of opening a separate headless browser.

### Fixed

- Improved relay recovery so Chrome reconnects automatically when the native host is unavailable or a stale connection drops.

## [19.0.1] - 2026-11-19

### Fixed

- The browser relay extension survives a browser whose loaded permission set predates the `downloads` permission: the service worker keeps working without download pairing instead of crashing before it ever connects ([#19659](https://github.com/can1357/oh-my-pi/pull/19659) by [@pavel-kalmykov](https://github.com/pavel-kalmykov))

## [18.22.1] - 2026-11-17

### Fixed

- Fixed an issue where the browser relay could fail to identify the page and title of a frame it emptied and hid in a tab.

## [18.18.2] - 2026-11-08

### Added

- The browser extension now requests Chrome’s downloads permission so relay tabs can report where downloads were saved to omp.

## [18.18.1] - 2026-11-08

### Changed

- The extension now requests `scripting` and access to all sites (Chrome lists "Read and change all your data on all websites"); it uses them only to empty another extension's frames in a tab omp is driving, when Chrome refuses it the debugger there ([#16908](https://github.com/can1357/oh-my-pi/pull/16908) by [@will-bogusz](https://github.com/will-bogusz))

### Fixed

- Fixed a password manager's inline autofill menu locking omp out of a tab it drives: the extension empties and hides such frames in that tab and retries the attach or command Chrome refused ([#16908](https://github.com/can1357/oh-my-pi/pull/16908) by [@will-bogusz](https://github.com/will-bogusz))

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
