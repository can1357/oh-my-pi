//! The core keyboard's locked and latched modifiers and layout group, cleared
//! for an `XTest` key run and put back after it.
//!
//! The server reads an `XTest` key through the core keyboard's XKB state, the
//! one the user's own keys set: with Caps Lock on, `type("Ab")` arrived as
//! "aB"; a Control that sticky keys latched or locked turned a letter into a
//! shortcut; with a second layout group active the keys typed that layout's
//! characters. Keys are planned on the first group's unshifted and shifted
//! levels (`keymap.rs`), so a run clears what would change those and puts the
//! locks and the group back afterwards. Num Lock stays: it changes only keypad
//! keys, which no plan types text with. A latch is not put back: the run's
//! first key would have used it up.

use x11rb::{
	protocol::{
		xkb::{self, ConnectionExt as _},
		xproto::ModMask,
	},
	rust_connection::RustConnection,
};

use crate::desktop::error::{CoreResult, DesktopError};

/// Core modifier names, by bit.
const MODIFIERS: [&str; 8] =
	["Shift", "Caps Lock", "Control", "Mod1", "Mod2", "Mod3", "Mod4", "Mod5"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct State {
	locked_mods:   u16,
	latched_mods:  u16,
	locked_group:  u8,
	latched_group: i16,
}

impl State {
	fn read(conn: &RustConnection) -> Result<Self, String> {
		let state = conn
			.xkb_get_state(xkb::ID::USE_CORE_KBD.into())
			.map_err(|error| error.to_string())?
			.reply()
			.map_err(|error| error.to_string())?;
		Ok(Self {
			locked_mods:   state.locked_mods.into(),
			latched_mods:  state.latched_mods.into(),
			locked_group:  state.locked_group.into(),
			latched_group: state.latched_group,
		})
	}

	/// The locked modifiers that change a planned key: all but Num Lock's.
	const fn stray_locks(self, num_lock: u16) -> u16 {
		self.locked_mods & !num_lock
	}

	const fn is_neutral(self, num_lock: u16) -> bool {
		self.stray_locks(num_lock) == 0
			&& self.latched_mods == 0
			&& self.locked_group == 0
			&& self.latched_group == 0
	}

	/// Names what keeps this state from neutral, as "locked Caps Lock,
	/// latched Control, layout group 2".
	fn describe(self, num_lock: u16) -> String {
		let named = |mask: u16, how: &'static str| {
			MODIFIERS
				.iter()
				.enumerate()
				.filter(move |&(bit, _)| mask & (1 << bit) != 0)
				.map(move |(_, name)| format!("{how} {name}"))
		};
		let group = (self.locked_group != 0 || self.latched_group != 0).then(|| {
			format!(
				"layout group {}",
				i32::from(self.locked_group) + i32::from(self.latched_group) + 1
			)
		});
		named(self.stray_locks(num_lock), "locked")
			.chain(named(self.latched_mods, "latched"))
			.chain(group)
			.collect::<Vec<_>>()
			.join(", ")
	}
}

/// The keyboard state cleared for one text run; [`Self::restore`] (or, on an
/// unwind, dropping it) puts the locks and the group back.
pub(super) struct NeutralKeyboard<'a> {
	conn:     &'a RustConnection,
	num_lock: u16,
	/// The state before the run, until it is put back.
	before:   Option<State>,
}

impl<'a> NeutralKeyboard<'a> {
	/// Clears the core keyboard's locked modifiers other than `num_lock`, its
	/// latched modifiers and its layout group. Fails, with the state put
	/// back, when the server leaves any of them set.
	pub(super) fn clear(conn: &'a RustConnection, num_lock: u16) -> CoreResult<Self> {
		let before = State::read(conn).map_err(failed)?;
		if before.is_neutral(num_lock) {
			return Ok(Self { conn, num_lock, before: None });
		}
		let keyboard = Self { conn, num_lock, before: Some(before) };
		latch_lock(
			conn,
			before.stray_locks(num_lock),
			0,
			before.locked_group != 0,
			0,
			before.latched_mods,
			before.latched_group != 0,
		)
		.map_err(failed)?;
		let after = State::read(conn).map_err(failed)?;
		if !after.is_neutral(num_lock) {
			return Err(DesktopError::input_failed(format!(
				"the keyboard's {} could not be cleared to type with; no input was sent",
				after.describe(num_lock)
			)));
		}
		Ok(keyboard)
	}

	/// Puts the locks and the group back after the run.
	pub(super) fn restore(mut self) -> CoreResult<()> {
		self.put_back().map_err(|error| {
			DesktopError::input_failed(format!(
				"the keys went out, but the X keyboard's locks or layout group could not be put back \
				 ({error}); Caps Lock or the layout may be off"
			))
		})
	}

	/// Re-locks only the modifiers still clear and the group only while it is
	/// still the first, so a lock or layout the user set during the run
	/// stands. A latch is not put back: the run's first key would have used it.
	fn put_back(&mut self) -> Result<(), String> {
		let Some(before) = self.before.take() else {
			return Ok(());
		};
		let now = State::read(self.conn)?;
		let locks = before.stray_locks(self.num_lock) & !now.locked_mods;
		let group = before.locked_group != 0 && now.locked_group == 0;
		if locks == 0 && !group {
			return Ok(());
		}
		latch_lock(self.conn, locks, locks, group, before.locked_group, 0, false)
	}
}

impl Drop for NeutralKeyboard<'_> {
	fn drop(&mut self) {
		let _ = self.put_back();
	}
}

/// One `LatchLockState`: sets the locks in `affect_locks` to `locks`, locks
/// `group` when `lock_group`, and clears the latches in `clear_latches` and,
/// with `clear_group_latch`, the group latch.
fn latch_lock(
	conn: &RustConnection,
	affect_locks: u16,
	locks: u16,
	lock_group: bool,
	group: u8,
	clear_latches: u16,
	clear_group_latch: bool,
) -> Result<(), String> {
	conn
		.xkb_latch_lock_state(
			xkb::ID::USE_CORE_KBD.into(),
			ModMask::from(affect_locks),
			ModMask::from(locks),
			lock_group,
			xkb::Group::from(group),
			ModMask::from(clear_latches),
			clear_group_latch,
			0,
		)
		.map_err(|error| error.to_string())?
		.check()
		.map_err(|error| error.to_string())
}

fn failed(error: String) -> DesktopError {
	DesktopError::input_failed(format!(
		"cannot read or clear the X keyboard's locks and layout group: {error}; no input was sent"
	))
}

#[cfg(test)]
mod tests {
	use super::*;

	const NUM_LOCK: u16 = 1 << 4;

	#[test]
	fn num_lock_alone_is_neutral_and_the_rest_is_named() {
		let state = |locked_mods, latched_mods, locked_group, latched_group| State {
			locked_mods,
			latched_mods,
			locked_group,
			latched_group,
		};
		assert!(state(NUM_LOCK, 0, 0, 0).is_neutral(NUM_LOCK));
		for stray in
			[state(1 << 1, 0, 0, 0), state(0, 1 << 2, 0, 0), state(0, 0, 1, 0), state(0, 0, 0, 1)]
		{
			assert!(!stray.is_neutral(NUM_LOCK), "{stray:?}");
		}
		let named = state(NUM_LOCK | (1 << 1) | (1 << 2), 1 << 2, 1, 0).describe(NUM_LOCK);
		for part in ["locked Caps Lock", "locked Control", "latched Control", "layout group 2"] {
			assert!(named.contains(part), "{named}");
		}
		assert!(!named.contains("Mod2"), "Num Lock is named: {named}");
	}
}
