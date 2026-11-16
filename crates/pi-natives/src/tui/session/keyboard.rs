//! Keyboard protocol negotiation: kitty keyboard protocol, with
//! modifyOtherKeys and win32-input-mode as fallbacks.
//!
//! See: <https://sw.kovidgoyal.net/kitty/keyboard-protocol/>

use super::{Session, probe::Owner};
use crate::{
	term::{Device, mode},
	tui::types::{Event, Millis},
};

/// How long the kitty query may go unanswered (by its reply or its DA1
/// sentinel) before the fallback engages.
const KEYBOARD_FALLBACK_MS: Millis = 150.0;

/// Negotiated keyboard enhancement.
#[derive(Default)]
pub(super) struct Keyboard {
	pub(super) kitty:             bool,
	pub(super) modify_other_keys: bool,
	/// Windows console fallback when kitty is unavailable: key records arrive
	/// as win32-input-mode sequences and the input parser decodes them before
	/// they reach the host.
	pub(super) win32_input:       bool,
	pub(super) fallback_at:       Option<Millis>,
}

/// The kitty flags to push given the terminal's current stack-top.
///
/// Any reply to `CSI ? u` means the terminal speaks the kitty keyboard
/// protocol. The reported flag value is the *current* stack-top — fresh
/// terminals report 0 — so support is implied by the reply itself, not by the
/// flag value. Pick the level we want; `CSI > N u` pushes one frame that
/// shutdown's single `CSI < u` pop balances.
const fn kitty_flags(reported: u32, conpty: bool) -> u32 {
	let reports_event_types = reported & 2 != 0;
	if conpty {
		// ConPTY (native Windows and WSL) drops Shift+letter keypresses
		// entirely when flag 4 (report alternate keys) is set (#1216). Use
		// flag 1 (disambiguate only), preserving flag 2 if already active.
		if reports_event_types { 3 } else { 1 }
	} else if reports_event_types {
		// Preserve event-type reporting already enabled by a parent app.
		// Push level-2 to keep its shortcuts reporting consistently.
		7
	} else {
		// Disambiguate escape codes and report base-layout keys for physical
		// shortcut matching, without event reporting that caused regression
		// #3259.
		5
	}
}

impl Session {
	/// Query the terminal for kitty keyboard protocol support; the reply
	/// enables it (see [`handle_kitty_reply`](Self::handle_kitty_reply)).
	pub(super) fn query_keyboard(&mut self, now: Millis, device: &mut Device) {
		// Progressive enhancement query: CSI ?u asks the terminal for its
		// current kitty keyboard flags (no side effect on the stack); the DA1
		// sentinel guarantees a reply even from terminals that ignore CSI ?u.
		self.probes.push_back(Owner::Keyboard);
		self.link.send(device, |batch| {
			batch.query_keyboard().query_device_attributes();
		});
		self.keyboard.fallback_at = Some(now + KEYBOARD_FALLBACK_MS);
	}

	/// `CSI ? flags u`: the terminal speaks the kitty keyboard protocol.
	pub(super) fn handle_kitty_reply(
		&mut self,
		reported_flags: u32,
		device: &mut Device,
		out: &mut Vec<Event>,
	) {
		self.keyboard.fallback_at = None;
		// A DA1 sentinel that beat the kitty reply may have already engaged the
		// modifyOtherKeys fallback (terminals such as Superset/xterm-on-Electron
		// answer DA1 before `CSI ? u`). Kitty is strictly preferred — undo the
		// fallback so the two modes do not stack. See #2042.
		if self.keyboard.modify_other_keys {
			self.keyboard.modify_other_keys = false;
			self.link.send(device, |batch| {
				batch.modify_other_keys(0);
			});
		}
		self.disable_win32_input(device);
		self.keyboard.kitty = true;
		out.push(Event::KeyboardProtocol { kitty: true });
		let flags = kitty_flags(reported_flags, self.facts.conpty);
		// The device remembers the pushed flags: kitty keyboard flags are
		// per-screen, so it re-pushes them after entering the alternate screen.
		self.link.send(device, |batch| {
			batch.keyboard_push(flags);
		});
	}

	/// The kitty reply never came (its DA1 sentinel won, or 150 ms passed):
	/// request the best fallback the terminal is known to tolerate.
	pub(super) fn enable_keyboard_fallback(&mut self, device: &mut Device) {
		if self.keyboard.kitty || self.keyboard.modify_other_keys || self.keyboard.win32_input {
			return;
		}
		let ssh = self.facts.ssh;
		if self.facts.conpty && !ssh {
			// The Windows console host ignores modifyOtherKeys and folds
			// Shift+Enter into a bare CR (Ctrl+Enter into LF). win32-input-mode
			// is answered by the console host serving this process, so it works
			// under every local ConPTY terminal, and under WSL through the
			// `wsl.exe` relay's console host too. Under sshd the console host is
			// fed the remote terminal's VT stream, and the mode splits arrow
			// keys into Escape plus literal text (#14034).
			self.keyboard.win32_input = true;
			self.link.send(device, |batch| {
				batch.set_mode(mode::WIN32_INPUT, false);
			});
			// A WSL pty is not always relayed by a console host (tmux, VS Code
			// Remote-WSL, WSLg terminals). Those ignore 9001 and keep sending
			// plain VT, which the decoder passes through, so also ask for
			// modifyOtherKeys.
			if self.facts.native_windows_console {
				return;
			}
		}
		// A remote terminal with no identifying env may not understand the
		// request.
		if ssh && matches!(self.facts.terminal_id.as_str(), "base" | "trueColor") {
			return;
		}
		self.keyboard.modify_other_keys = true;
		self.link.send(device, |batch| {
			batch.modify_other_keys(2);
		});
	}

	/// Leave win32-input-mode if it was requested. The input parser retires
	/// its decoder when [`input_context`](Self::input_context) stops reporting
	/// the mode; input it still holds belongs to the user (e.g. Escape before
	/// a late kitty reply) and is released then.
	pub(super) fn disable_win32_input(&mut self, device: &mut Device) {
		if !self.keyboard.win32_input {
			return;
		}
		self.keyboard.win32_input = false;
		self.link.send(device, |batch| {
			batch.reset_mode(mode::WIN32_INPUT, false);
		});
	}

	/// Turn every keyboard enhancement off ahead of a drain, so late key
	/// releases do not generate new enhanced sequences.
	pub(super) fn release_keyboard(&mut self, device: &mut Device, out: &mut Vec<Event>) {
		if self.keyboard.kitty {
			// Disable Kitty keyboard protocol first so any late key releases
			// do not generate new Kitty escape sequences.
			self.keyboard.kitty = false;
			self.link.send(device, |batch| {
				batch.keyboard_pop();
			});
			out.push(Event::KeyboardProtocol { kitty: false });
		}
		self.keyboard.fallback_at = None;
		if self.keyboard.modify_other_keys {
			self.keyboard.modify_other_keys = false;
			self.link.send(device, |batch| {
				batch.modify_other_keys(0);
			});
		}
		self.disable_win32_input(device);
	}

	pub(super) fn tick_keyboard(&mut self, now: Millis, device: &mut Device) {
		if super::fired(&mut self.keyboard.fallback_at, now) {
			self.enable_keyboard_fallback(device);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::kitty_flags;

	#[test]
	fn kitty_flags_follow_the_host_and_the_reported_stack_top() {
		// Fresh terminal: disambiguate + alternate keys, no event types (#3259).
		assert_eq!(kitty_flags(0, false), 5);
		// A parent app already reports event types: keep them.
		assert_eq!(kitty_flags(2, false), 7);
		assert_eq!(kitty_flags(3, false), 7);
		// ConPTY drops Shift+letter under flag 4 (#1216).
		assert_eq!(kitty_flags(0, true), 1);
		assert_eq!(kitty_flags(2, true), 3);
	}
}
