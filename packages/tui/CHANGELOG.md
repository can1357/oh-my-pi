# Changelog

## [Unreleased]

### Breaking Changes

- Removed `oneLine` from `@oh-my-pi/pi-tui/term/painters/picker`; use `flattenLine` from `@oh-my-pi/pi-tui/text/sanitize` ([#20484](https://github.com/can1357/oh-my-pi/pull/20484) by [@H4vC](https://github.com/H4vC))

### Added

- Added the `change` UI event for an image's annotated picture, delivered to the node's `onChange` without an `item`.

## [19.2.0] - 2026-11-25

### Added

- Added `@oh-my-pi/pi-tui`, a terminal UI with a unified Tern Surface Protocol node tree, native and terminal rendering, reactive signals, compiler-free JSX, role-based painters and widgets, terminal input and capability support, multiplexer and image handling, resize policies, notifications, Markdown and text utilities, themes, and terminal testing utilities.
- Added checkout event support to TSP connections and hosts.
- Added `label` to editor terminal decoration ranges: replacement text drawn in place of a range on rows where it fits and the caret is outside it.

### Changed

- Hosts now report when the terminal displays the checkout itself through `checkoutShown`.
- Theme files are polled for changes, keeping live reload working when editors replace files during save.
- Terminal animations now skip unchanged frames and share redraws with streaming content; shimmer motion runs at 20 fps.

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
