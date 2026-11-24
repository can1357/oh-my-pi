# Changelog

## [Unreleased]

### Added

- Added `@oh-my-pi/pi-tui`, the terminal UI that replaces `@oh-my-pi/pi-tui`: one tree of Tern Surface Protocol nodes drawn natively by Tern and as terminal rows elsewhere, with signals and a compiler-free JSX runtime, role-based painters and widgets, a terminal driver (input, capabilities, multiplexers, images, resize policies, notifications), Markdown and text utilities, themes, and test utilities (`testing/terminal`, `testing/cells`)

### Fixed

- Labeled Markdown `http(s)` links show only their clickable label when the terminal was detected to draw OSC 8, instead of repeating the URL in parentheses. A link whose target is resolved to another URI, OSC 8 forced by `tui.hyperlinks: always` or `PI_FORCE_HYPERLINKS=1`, and terminals without OSC 8 keep the `(url)` suffix ([#12966](https://github.com/can1357/oh-my-pi/pull/12966) by [@razshlomo](https://github.com/razshlomo))
- Corrected math environment detection to properly handle blocks starting with `\begin`
- Cmd+A highlights the full text of editors and inputs when the terminal forwards the shortcut. Typing, deleting or pasting replaces the selected range.
- Native overlays follow the field they are anchored to, including when the field moves or shares its local key with another field.
- Native menu and tree toggles now reach the intended control or branch. Clicking behind an explicitly modal sheet no longer moves keyboard focus out of it.
- In terminal rows, modal sheets block clicks into the screen behind them. Inline clicks and hover follow the visible content after scrolling, and closing a fullscreen view restores the previous mouse setting.
- Returning to the shell after a native session no longer leaves terminal replies in the shell prompt, including after a fatal error.
