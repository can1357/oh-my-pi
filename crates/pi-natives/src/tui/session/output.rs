//! Output-side session state: the health of the link to the terminal, the
//! stall watchdog's episode, the progress indicator, and the plain output ops
//! (title, cursor, opaque writes) with their bracketed-paste reassertion.

use super::{
	Session,
	watchdog::{STDOUT_STALL_POLL_MS, StallWatchdog},
};
use crate::{
	term::{Batch, Device, mode},
	tui::types::{Event, Millis},
};

const TERMINAL_PROGRESS_KEEPALIVE_MS: Millis = 1000.0;
/// OSC 9;4 progress states.
const PROGRESS_CLEAR: u32 = 0;
const PROGRESS_INDETERMINATE: u32 = 3;

/// Whether session output still reaches a terminal.
#[derive(Default)]
pub(super) struct Link {
	/// The terminal is gone: the pump's write failed, or the stall watchdog
	/// gave up on a consumer that stopped reading (a stalled-but-alive PTY
	/// reader never fails a write). Never cleared: a dead terminal stays dead.
	pub(super) dead:    bool,
	/// Between `stop` and the next `start`: the exit restore was the last
	/// output.
	pub(super) stopped: bool,
	/// Why the link died, until the next call that can report it.
	failure:            Option<&'static str>,
}

impl Link {
	/// Write one batch. Dropped once the terminal is dead and after `stop`.
	pub(super) fn send(&self, device: &mut Device, fill: impl FnOnce(&mut Batch<'_>)) {
		if self.dead || self.stopped {
			return;
		}
		// The backlog this leaves behind is sampled by the engine's next tick
		// (see `Session::sample_backlog`).
		device.emit(fill);
	}

	/// Declare the terminal gone; the first reason wins.
	pub(super) const fn fail(&mut self, reason: &'static str) {
		if self.dead {
			return;
		}
		self.dead = true;
		self.failure = Some(reason);
	}
}

/// The stall watchdog and the poll that keeps an armed episode sampled.
#[derive(Default)]
pub(super) struct Stall {
	watchdog: StallWatchdog,
	/// Latest time by which an armed episode must be re-sampled.
	poll_at:  Option<Millis>,
}

impl Stall {
	pub(super) const fn disarm(&mut self) {
		self.watchdog.reset();
		self.poll_at = None;
	}

	pub(super) const fn deadline(&self) -> Option<Millis> {
		self.poll_at
	}

	/// A poll that came due without a sample (the engine samples on every
	/// tick) is pushed out a period, so an armed episode never turns the
	/// host's timer into a busy loop.
	pub(super) fn tick(&mut self, now: Millis) {
		if self.poll_at.is_some_and(|at| at <= now) {
			self.poll_at = Some(now + STDOUT_STALL_POLL_MS);
		}
	}
}

/// OSC 9;4 progress indicator state.
#[derive(Default)]
pub(super) struct Progress {
	active:                  bool,
	pub(super) keepalive_at: Option<Millis>,
}

impl Session {
	/// Report a dead link once: output failures surface as
	/// [`Event::Disconnected`] on the first call that drains events.
	pub(super) fn report_failure(&mut self, out: &mut Vec<Event>) {
		let Some(reason) = self.link.failure.take() else {
			return;
		};
		self.stall.disarm();
		out.push(Event::Disconnected { reason: reason.to_owned() });
	}

	/// Reconcile the output backlog after a write or on a tick: `pending` is
	/// the pump's pending-byte bound, or the host stream's queued bytes for a
	/// capture sink.
	///
	/// The watchdog runs an episode from the moment the backlog crosses the
	/// arm cap until it drains to a healthy level; while an episode is armed
	/// the session keeps a 250 ms deadline so the backlog is re-sampled,
	/// because once the render gate (256 KiB) defers frames, no write is
	/// guaranteed to re-sample it — so a consumer that wedges anywhere above
	/// the healthy threshold, even after the backlog dips below the arm cap,
	/// is still caught. Feeding the live backlog rather than tripping on the
	/// instantaneous byte count lets a single large-but-draining frame (a
	/// resume repaint of many inline images) open normally, while a
	/// never-draining reader is still torn down. See [`StallWatchdog`], #6854,
	/// #10430, and #10434.
	pub fn sample_backlog(&mut self, now: Millis, pending: f64, out: &mut Vec<Event>) {
		if self.link.dead || self.link.stopped {
			self.stall.disarm();
			return;
		}
		if self.stall.watchdog.sample(pending, now) {
			self
				.link
				.fail("stdout backlog stalled without draining; PTY consumer stalled");
			self.report_failure(out);
			return;
		}
		self.stall.poll_at = self
			.stall
			.watchdog
			.armed()
			.then_some(now + STDOUT_STALL_POLL_MS);
	}

	/// Whether existing output reasserts DEC 2004 (see
	/// [`Modes::rearm_bracketed_paste`](super::modes::Modes)).
	pub const fn rearms_bracketed_paste(&self) -> bool {
		self.active && self.modes.rearm_bracketed_paste
	}

	/// Write opaque output.
	pub fn write(&self, text: &str, device: &mut Device) {
		// Hosts can reset bracketed paste (e.g. iTerm2's Terminal State toggle).
		// Reassert it with existing output, never on a timer while idle.
		let rearm = !text.is_empty() && self.rearms_bracketed_paste();
		self.link.send(device, |batch| {
			if rearm {
				batch.set_mode(mode::BRACKETED_PASTE, false);
			}
			batch.text(text);
		});
	}

	/// A batch built by the renderer is existing output too: it carries the
	/// same bracketed-paste reassertion as [`write`](Self::write). Call after
	/// a frame was presented.
	pub fn note_output(&self, device: &mut Device) {
		if self.rearms_bracketed_paste() {
			self.link.send(device, |batch| {
				batch.set_mode(mode::BRACKETED_PASTE, false);
			});
		}
	}

	/// Set the terminal window title.
	pub fn set_title(&self, title: &str, device: &mut Device) {
		self.link.send(device, |batch| {
			batch.title(title);
		});
	}

	/// Set the hardware cursor shape (DECSCUSR `code`). Written whenever it
	/// changes, whether or not the hardware cursor is currently visible:
	/// reshaping a hidden cursor has no visible effect. The device dedupes
	/// against the last shape written so a per-keystroke mode indicator does
	/// not add a sequence to every frame, and its exit restore hands the shape
	/// back to the user's terminal configuration.
	pub fn set_cursor_shape(&self, code: u32, device: &mut Device) {
		self.link.send(device, |batch| {
			batch.cursor_shape(code);
		});
	}

	/// Show the hardware cursor. Same-state calls are deduped against the
	/// visibility last written to the terminal; `force` writes unconditionally
	/// (crash/exit restore paths). Hiding goes through the screen, which
	/// tracks the hardware cursor it paints.
	pub fn show_cursor(&self, force: bool, device: &mut Device) {
		self.link.send(device, |batch| {
			batch.set_mode(mode::CURSOR_VISIBLE, !force);
		});
	}

	/// Turn the OSC 9;4 progress indicator on (indeterminate) or off.
	pub fn set_progress(&mut self, now: Millis, active: bool, device: &mut Device) {
		if active {
			if self.progress.active {
				return;
			}
			self.progress.active = true;
			self.link.send(device, |batch| {
				batch.progress(PROGRESS_INDETERMINATE);
			});
			// Ghostty and Monstar expire OSC 9;4 state without a heartbeat.
			// Persistent hosts such as Windows Terminal restart their
			// indeterminate animation on every write.
			if self.facts.progress_keepalive && self.progress.keepalive_at.is_none() {
				self.progress.keepalive_at = Some(now + TERMINAL_PROGRESS_KEEPALIVE_MS);
			}
		} else {
			self.progress = Progress::default();
			self.link.send(device, |batch| {
				batch.progress(PROGRESS_CLEAR);
			});
		}
	}

	pub(super) fn tick_progress(&mut self, now: Millis, device: &mut Device) {
		if self.progress.keepalive_at.is_some_and(|at| at <= now) {
			self.progress.keepalive_at = Some(now + TERMINAL_PROGRESS_KEEPALIVE_MS);
			self.link.send(device, |batch| {
				batch.progress(PROGRESS_INDETERMINATE);
			});
		}
	}
}
