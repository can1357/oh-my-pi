# Changelog

## [Unreleased]

### Added

- Added `@oh-my-pi/pi-tui`, a terminal UI with a unified Tern Surface Protocol node tree, native and terminal rendering, reactive signals, compiler-free JSX, role-based painters and widgets, terminal input and capability support, multiplexer and image handling, resize policies, notifications, Markdown and text utilities, themes, and terminal testing utilities.
- Added checkout event support to TSP connections and hosts.

### Changed

- Hosts now report when the terminal displays the checkout itself through `checkoutShown`.
- Theme files are polled for changes, keeping live reload working when editors replace files during save.

### Fixed

- Fixed streaming Tern content being unnecessarily redrawn as newly inserted when content above it changes.
- Fixed keyboard events used to open a page from being delivered to the newly opened page as well.
- Fixed detection of LaTeX blocks beginning with `\begin`.
- Fixed Cmd+A selection in terminal-forwarded editors and inputs so typing, deletion, and paste replace the selected text.
- Fixed native overlays losing alignment with their anchored fields when the fields move or share local keys.
- Fixed native menu and tree interactions being delivered to the wrong control or branch, and prevented clicks behind modal sheets from moving focus outside the modal.
- Fixed terminal-row modal sheets allowing interaction with the content behind them, incorrect click and hover targets after scrolling, and mouse settings not being restored after closing fullscreen views.
- Fixed terminal replies leaking into the shell prompt after returning from a native session, including after fatal errors.
- Improved handling of large Tern transcript redraws when resuming sessions or returning from a subagent view.
