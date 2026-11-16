//! What the device knows about the terminal: every value it wrote that a
//! later op dedupes against or that the exit restore must undo.

use super::mode;

/// Tracked terminal state. Only writes made through the device are seen;
/// escape sequences inside opaque text are not parsed.
#[derive(Debug, Default)]
pub(super) struct State {
	/// Last value written per DEC private mode; an absent mode is unknown.
	modes: Vec<(u32, bool)>,
	/// Flags of the kitty keyboard frame this process pushed, while pushed.
	pub(super) kitty: Option<u32>,
	/// The last xterm modifyOtherKeys level written was nonzero.
	pub(super) modify_other_keys: bool,
	/// Last DECSCUSR code written.
	pub(super) cursor_shape: Option<u32>,
	/// The OSC 9;4 progress indicator is showing.
	pub(super) progress: bool,
	/// The open paint bracket, between `frame_begin` and `frame_end`.
	pub(super) frame: Option<Frame>,
}

/// An open paint bracket.
#[derive(Clone, Copy, Debug)]
pub(super) struct Frame {
	/// DEC 2026 was opened with the frame.
	pub(super) sync:    bool,
	/// Re-open DEC 2026 as the frame grows.
	pub(super) renew:   bool,
	/// Encoded size since the frame began or DEC 2026 was last renewed.
	pub(super) emitted: usize,
}

impl State {
	/// The last value written for `mode`, or `None` while unknown.
	pub(super) fn mode(&self, mode: u32) -> Option<bool> {
		self
			.modes
			.iter()
			.find(|entry| entry.0 == mode)
			.map(|entry| entry.1)
	}

	/// Record that `mode` was just written as `set`.
	pub(super) fn record(&mut self, mode: u32, set: bool) {
		match self.modes.iter_mut().find(|entry| entry.0 == mode) {
			Some(entry) => entry.1 = set,
			None => self.modes.push((mode, set)),
		}
	}

	/// Make `mode` unknown again.
	pub(super) fn forget(&mut self, mode: u32) {
		self.modes.retain(|entry| entry.0 != mode);
	}

	/// Whether the hardware cursor is showing, or `None` while unknown.
	#[cfg(test)]
	pub(super) fn cursor_visible(&self) -> Option<bool> {
		self.mode(mode::CURSOR_VISIBLE)
	}

	/// Whether the alternate screen was entered and not left.
	pub(super) fn alt_screen(&self) -> bool {
		self.mode(mode::ALT_SCREEN) == Some(true)
	}
}
