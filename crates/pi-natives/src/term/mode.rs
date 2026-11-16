//! DEC private mode numbers the terminal layer sets, resets, or restores.

/// DECCKM: application cursor keys while set.
pub(crate) const CURSOR_KEYS: u32 = 1;
/// DECAWM.
pub(crate) const AUTOWRAP: u32 = 7;
/// DECTCEM; tracked for show/hide dedupe.
pub(crate) const CURSOR_VISIBLE: u32 = 25;
pub(crate) const MOUSE_CLICKS: u32 = 1000;
pub(crate) const MOUSE_MOTION: u32 = 1003;
pub(crate) const MOUSE_SGR: u32 = 1006;
/// xterm scroll-to-bottom on tty output.
pub(crate) const SCROLL_ON_OUTPUT: u32 = 1010;
/// xterm scroll-to-bottom on key press.
pub(crate) const SCROLL_ON_KEY: u32 = 1011;
/// Alternate screen. The device re-pushes the active keyboard enhancement
/// after entering and pops/reasserts it around leaving.
pub(crate) const ALT_SCREEN: u32 = 1049;
pub(crate) const BRACKETED_PASTE: u32 = 2004;
pub(crate) const SYNCHRONIZED_OUTPUT: u32 = 2026;
/// Appearance (dark/light) change notifications.
pub(crate) const APPEARANCE_REPORTS: u32 = 2031;
pub(crate) const IN_BAND_RESIZE: u32 = 2048;
/// kitty OSC 5522 paste events.
pub(crate) const PASTE_EVENTS: u32 = 5522;
pub(crate) const WIN32_INPUT: u32 = 9001;
