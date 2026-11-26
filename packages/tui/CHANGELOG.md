# Changelog

## [Unreleased]

### Fixed

- Typing in an editor holding thousands of lines is about 3x faster per keystroke ([#20659](https://github.com/can1357/oh-my-pi/pull/20659) by [@H4vC](https://github.com/H4vC))
- Updates no longer slow down sharply when a single reactive computation reads thousands of values ([#20657](https://github.com/can1357/oh-my-pi/pull/20657) by [@H4vC](https://github.com/H4vC))
- SIXEL and iTerm2 images no longer draw over other rows or scroll the terminal under the frame: images taller than the screen are fitted within it, and a live image whose first rows the viewport cuts off is left out until they fit ([#20620](https://github.com/can1357/oh-my-pi/pull/20620) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- Code blocks in a streaming reply now reach scrollback line by line as they scroll off screen, instead of staying out of reach until the block ends ([#13676](https://github.com/can1357/oh-my-pi/issues/13676), [#20561](https://github.com/can1357/oh-my-pi/pull/20561) by [@Frexxis](https://github.com/Frexxis))
- Reduced idle CPU use on Windows after `/restart` ([#20518](https://github.com/can1357/oh-my-pi/pull/20518) by [@ethancawse](https://github.com/ethancawse)).
- Reopened lost Tern surfaces on an `unknown surface` reply, stopped frames if the reopen was rejected, and kept recognizable broken TSP replies out of the editor ([#20550](https://github.com/can1357/oh-my-pi/issues/20550)).
- Typing in a Tern composer keeps echoing while an agent streams, instead of stalling for seconds when Tern is slow to acknowledge frames. ([#20463](https://github.com/can1357/oh-my-pi/pull/20463) by [@Xytronix](https://github.com/Xytronix))

## [19.2.1] - 2026-11-25

### Breaking Changes

- Removed the public `oneLine` export from `@oh-my-pi/pi-tui/term/painters/picker`; use `flattenLine` from `@oh-my-pi/pi-tui/text/sanitize` instead.

### Added

- Added the `change` UI event for annotated images, delivered to the node’s `onChange` handler without an associated item.

### Fixed

- Panes in a background Tern tab no longer log frame-acknowledgment stall warnings.

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
