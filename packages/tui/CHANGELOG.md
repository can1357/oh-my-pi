# Changelog

## [Unreleased]

### Breaking Changes

- `MarkdownLook.linkUrls` is now required. Callers of `setMarkdownLook` must provide this field.

### Added

- Terminal canvas views can handle mouse clicks, motion, and wheel ticks with `onMouse` ([#20819](https://github.com/can1357/oh-my-pi/issues/20819)).
- Added `MarkdownOptions.linkUrls` and `MarkdownLook.linkUrls` to hide the URL drawn after named links whose label is an OSC 8 hyperlink ([#13162](https://github.com/can1357/oh-my-pi/pull/13162) by [@pavel-kalmykov](https://github.com/pavel-kalmykov))
- `ProcessTerminalDriver.setResizeScrollback()` and `FrameWriter.setResizeScrollback()` change the resize scrollback policy of a running driver ([#20845](https://github.com/can1357/oh-my-pi/issues/20845))
- Added opt-in fullscreen terminal rendering: a scrollable transcript above a pinned dock, a draggable scrollbar, character/word/line selection and incremental search. The normal exit can append the transcript or keep the original screen ([#2040](https://github.com/can1357/oh-my-pi/issues/2040), building on [#2103](https://github.com/can1357/oh-my-pi/pull/2103) by [@shoucandanghehe](https://github.com/shoucandanghehe) and [#20766](https://github.com/can1357/oh-my-pi/pull/20766) by [@camjac251](https://github.com/camjac251))
### Added

- `TextEdit.paste` marks an edit that types a bracketed paste ([#20681](https://github.com/can1357/oh-my-pi/issues/20681))
- `Host.requestFrame()` schedules a terminal frame even when nothing on screen changed ([#20704](https://github.com/can1357/oh-my-pi/pull/20704) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- Added `tool.gl` symbol across unicode, nerd, and ascii presets for the GitLab tool ([#20396](https://github.com/can1357/oh-my-pi/pull/20396) by [@asuffield](https://github.com/asuffield))
- Added `MarkdownOptions.linkUrls` and `MarkdownLook.linkUrls` to control whether URLs are displayed after named OSC 8 hyperlinks.
- Added `TextEdit.paste` to identify edits produced by bracketed paste operations.
- Added `tool.gl` symbols to the Unicode, Nerd Font, and ASCII presets for the GitLab tool.
- Terminal painters can attach one-shot marks to rows as they enter scrollback without re-emitting them on redraw.

### Fixed

- Improved performance when editing large documents and updating or closing views with many reactive values.
- Fixed pane resizing in Herdr to avoid repeated redraw loops.
- Fixed SIXEL and iTerm2 images overflowing rows, scrolling the terminal unexpectedly, or rendering incorrectly when they extend beyond the visible screen.
- Fixed fast Vietnamese Telex input on Windows so characters are no longer dropped or duplicated.
- Streaming code blocks now enter terminal scrollback as they move off screen, rather than waiting until the block is complete.
- Reduced idle CPU usage on Windows after `/restart`.
- Improved recovery from lost Tern surfaces and malformed TSP responses.
- Typing in a Tern composer now remains responsive while an agent is streaming, even when Tern is slow to acknowledge frames.
- Clicks in Tern now show their effect while Tern is slow to acknowledge frames: an ask form you submit leaves the screen at once instead of staying with a Submit button that no longer responds.
- Fixed inverse video styling leaking into padding and borders at wrapped line endings.
- Fixed win32 input-mode key records being inserted as literal composer text in certain timing conditions.
- Fixed pastes on Windows Terminal arriving as raw `[Vk;Sc;Uc;…_` key records instead of the pasted text, CJK and line breaks included ([#20718](https://github.com/can1357/oh-my-pi/issues/20718))
- Fixed SIXEL and iTerm2 images losing their bottom cell row in terminals that clear image cells on line erase, such as xterm.js ([#20752](https://github.com/can1357/oh-my-pi/issues/20752))
- Fixed code blocks drawn with `codeIndent: 0` putting their ``` fence rows one column right of the code; fences now sit at column 0 with it, so copying the whole block yields its markdown ([#20752](https://github.com/can1357/oh-my-pi/issues/20752))
- Stopped trusting an inherited `TERM_FEATURES` sync hint inside tmux/screen panes, which caused top-to-bottom redraw flashes while streaming in an inactive tmux 3.6 pane ([#20091](https://github.com/can1357/oh-my-pi/issues/20091))
- Enabled kitty Unicode placeholder image rendering by default in Rex ([#19830](https://github.com/can1357/oh-my-pi/issues/19830))
- Inline images inside tmux on terminals without Kitty Unicode placeholders (e.g. WezTerm) are no longer drawn at tmux's cursor; they use SIXEL when tmux renders it, else are skipped ([#19396](https://github.com/can1357/oh-my-pi/issues/19396))
- Catppuccin, Rosé Pine, GitHub Dark and Celestial themes now draw composer and message text in their palette text color instead of the generic default ([#16374](https://github.com/can1357/oh-my-pi/issues/16374))

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
