# Changelog

## [Unreleased]

### Added

- Added `@oh-my-pi/pi-tui`, the terminal UI that replaces `@oh-my-pi/pi-tui`: one tree of Tern Surface Protocol nodes drawn natively by Tern and as terminal rows elsewhere, with signals and a compiler-free JSX runtime, role-based painters and widgets, a terminal driver (input, capabilities, multiplexers, images, resize policies, notifications), Markdown and text utilities, themes, and test utilities (`testing/terminal`, `testing/cells`)

### Fixed

- Corrected math environment detection to properly handle blocks starting with `\begin`
- Cmd+A highlights the full text of editors and inputs when the terminal forwards the shortcut. Typing, deleting or pasting replaces the selected range.
- Native overlays follow the field they are anchored to, including when the field moves or shares its local key with another field.
- Native menu and tree toggles now reach the intended control or branch. Clicking behind an explicitly modal sheet no longer moves keyboard focus out of it.
- In terminal rows, modal sheets block clicks into the screen behind them. Inline clicks and hover follow the visible content after scrolling, and closing a fullscreen view restores the previous mouse setting.
- Returning to the shell after a native session no longer leaves terminal replies in the shell prompt, including after a fatal error.
- Fixed the `/pause` screen capturing mouse input it dropped, which blocked selecting text with the mouse while paused ([#9920](https://github.com/can1357/oh-my-pi/issues/9920), [#19945](https://github.com/can1357/oh-my-pi/pull/19945) by [@JamieJ5926](https://github.com/JamieJ5926))
