//! Stdout stall watchdog: bounds a never-draining output backlog without
//! killing a single large but actively draining frame.

use crate::tui::types::Millis;

/// Backlog ceiling that arms the stall watchdog. A live terminal keeps this
/// near zero; crossing it means either a genuinely wedged PTY reader (#6854)
/// or a single legitimately-huge frame — a `--resume` transcript repaint of
/// many inline images is one multi-tens-of-MiB write (#10430). The two are
/// told apart by [`StallWatchdog`] (drain progress), not by this number
/// alone: inter-frame production is already gated at 256 KiB (the render
/// gate), so the only way to reach this cap is a lone oversized frame or a
/// reader that has stopped consuming entirely.
const MAX_STDOUT_BACKLOG_BYTES: f64 = 64.0 * 1024.0 * 1024.0;

/// Backlog at or below which stdout is healthy again: the pump has kept up,
/// the screen resumes composing frames, and a [`StallWatchdog`] episode ends.
/// The render gate is this same value, so the watchdog stays armed across the
/// entire range where frames are deferred — otherwise a consumer that wedges
/// between this level and the arm cap is never re-sampled and the session
/// freezes instead of disconnecting (#10434 review).
const STDOUT_BACKLOG_CLEAR_BYTES: f64 = 256.0 * 1024.0;

/// How long an armed backlog may go without any drain progress before the
/// consumer is declared gone. A slow-but-alive terminal keeps reaching new
/// low-water marks (so it never trips), but a live one can also stop reading
/// for seconds at a time: a busy tmux server holding a slow client, or a
/// container's attach stream. Waiting costs no memory, because frames are
/// deferred while the backlog is up, so the window is long enough to ride
/// those out; a reader that never comes back is still torn down within it.
const STDOUT_STALL_TIMEOUT_MS: Millis = 60_000.0;

/// Cadence at which the backlog is re-sampled while an episode is armed.
pub(super) const STDOUT_STALL_POLL_MS: Millis = 250.0;

/// Bounds a never-draining stdout backlog without killing a single large but
/// actively-draining frame.
///
/// A stream write only queues once its buffer exceeds the high-water mark,
/// and the off-thread pump's pending count climbs the same way; a
/// stalled-but-alive PTY reader never fails a write, so the byte count is the
/// only signal that output is going nowhere. Tripping on the instantaneous
/// count alone is wrong: a legitimate oversized frame (a resume repaint of
/// dozens of inline screenshots, #10430) briefly exceeds the cap and then
/// drains.
///
/// An episode starts when the backlog first exceeds `arm_bytes` and lasts
/// until it drains back to `clear_bytes` (healthy). The backlog can fall below
/// `arm_bytes` while still unhealthy, so the episode must outlive that dip
/// (#10434): during it the watchdog declares the terminal disconnected only
/// when the backlog makes no drain progress (no new low-water mark) for
/// `stall_ms` — a draining terminal keeps lowering the mark and never trips,
/// while a wedged one (#6854) still tears down within the window.
pub(super) struct StallWatchdog {
	arm_bytes:     f64,
	clear_bytes:   f64,
	stall_ms:      Millis,
	low_water:     f64,
	stalled_since: Millis,
	armed:         bool,
}

impl Default for StallWatchdog {
	fn default() -> Self {
		Self::new(MAX_STDOUT_BACKLOG_BYTES, STDOUT_BACKLOG_CLEAR_BYTES, STDOUT_STALL_TIMEOUT_MS)
	}
}

impl StallWatchdog {
	pub(super) const fn new(arm_bytes: f64, clear_bytes: f64, stall_ms: Millis) -> Self {
		Self {
			arm_bytes,
			clear_bytes,
			stall_ms,
			low_water: f64::INFINITY,
			stalled_since: 0.0,
			armed: false,
		}
	}

	/// True while an episode is active and the backlog must be polled to
	/// completion.
	pub(super) const fn armed(&self) -> bool {
		self.armed
	}

	/// Feed the current pending-byte count and clock reading. Returns true
	/// once an armed episode has gone `stall_ms` with no drain progress, at
	/// which point the caller treats the terminal as disconnected.
	pub(super) fn sample(&mut self, pending: f64, now: Millis) -> bool {
		if !self.armed {
			// Idle: only an oversized backlog starts an episode.
			if pending <= self.arm_bytes {
				return false;
			}
			self.armed = true;
			self.low_water = pending;
			self.stalled_since = now;
			return false;
		}
		if pending <= self.clear_bytes {
			// Drained back to a healthy level: the episode is over.
			self.reset();
			return false;
		}
		if pending < self.low_water {
			// Drain progress: a new low-water mark restarts the stall clock.
			self.low_water = pending;
			self.stalled_since = now;
			return false;
		}
		// Still unhealthy with no new low-water mark since the clock started.
		now - self.stalled_since >= self.stall_ms
	}

	/// Episode ended (drained) or terminal torn down: stop watching.
	pub(super) const fn reset(&mut self) {
		self.armed = false;
		self.low_water = f64::INFINITY;
		self.stalled_since = 0.0;
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	// The session must bound a never-draining stdout consumer (#6854) without
	// killing a single large-but-draining frame — a `--resume` transcript
	// repaint of many inline images is one multi-tens-of-MiB write (#10430).
	// An episode runs from the arm cap until the backlog drains to a healthy
	// level, so a consumer that wedges *below* the arm cap but above the
	// healthy level is still caught (#10434). These tests pin that decision,
	// the contract `Session::sample_backlog` relies on to declare a disconnect.
	const ARM: f64 = 1000.0;
	const CLEAR: f64 = 100.0;
	const STALL_MS: Millis = 2000.0;

	const fn make() -> StallWatchdog {
		StallWatchdog::new(ARM, CLEAR, STALL_MS)
	}

	#[test]
	fn does_not_arm_or_trip_on_a_backlog_that_never_exceeds_the_arm_cap() {
		let mut wd = make();
		for step in 0..100 {
			let t = f64::from(step) * 1000.0;
			assert!(!wd.sample(ARM, t));
			assert!(!wd.sample(ARM - 1.0, t + 1.0)); // between clear and cap, but idle
			assert!(!wd.sample(0.0, t + 2.0));
			assert!(!wd.armed());
		}
	}

	#[test]
	fn declares_a_stall_once_an_armed_backlog_goes_stall_ms_without_draining() {
		// #6854
		let mut wd = make();
		assert!(!wd.sample(ARM + 1.0, 0.0)); // arms and starts the clock
		assert!(!wd.sample(ARM + 1.0, STALL_MS - 1.0)); // window not elapsed
		assert!(wd.sample(ARM + 1.0, STALL_MS)); // no progress for stall_ms
	}

	#[test]
	#[allow(
		clippy::while_float,
		reason = "the backlog steps by exact multiples of 100.0, so the comparison is exact"
	)]
	fn never_trips_while_a_large_backlog_keeps_draining_even_past_stall_ms() {
		// #10430
		let mut wd = make();
		let mut pending = 5000.0;
		let mut t = 0.0;
		while pending > CLEAR {
			assert!(!wd.sample(pending, t));
			pending -= 100.0; // forward progress: a new low-water mark each poll
			t += 300.0; // spans well beyond STALL_MS with no false trip
		}
		assert!(!wd.sample(pending, t)); // drained to healthy: episode ends
		assert!(!wd.armed());
	}

	#[test]
	fn keeps_the_episode_armed_after_the_backlog_dips_below_the_arm_cap_then_stalls() {
		// #10434
		let mut wd = make();
		assert!(!wd.sample(ARM + 500.0, 0.0)); // arm above the cap
		// Drains below the arm cap but stays above the healthy clear level, then
		// the consumer wedges. No write re-arms it, so the episode must persist.
		assert!(!wd.sample(ARM - 100.0, 200.0)); // progress; still armed
		assert!(wd.armed());
		assert!(!wd.sample(ARM - 100.0, 200.0 + STALL_MS - 1.0));
		assert!(wd.sample(ARM - 100.0, 200.0 + STALL_MS)); // wedged below cap → trips
	}

	#[test]
	fn ends_the_episode_and_disarms_once_the_backlog_drains_to_the_clear_level() {
		let mut wd = make();
		assert!(!wd.sample(ARM + 1.0, 0.0));
		assert!(wd.armed());
		assert!(!wd.sample(CLEAR, 100.0)); // healthy again: episode over
		assert!(!wd.armed());
		// A later sub-cap backlog does not re-arm a fresh episode on its own.
		assert!(!wd.sample(ARM - 1.0, 10_000.0));
		assert!(!wd.armed());
	}

	#[test]
	fn counts_the_stall_window_only_since_the_last_drain_progress() {
		let mut wd = make();
		assert!(!wd.sample(ARM + 5000.0, 0.0)); // arm at t=0
		assert!(!wd.sample(ARM + 3000.0, 1500.0)); // progress: clock restarts at 1500
		assert!(!wd.sample(ARM + 3000.0, 1500.0 + STALL_MS - 1.0)); // measured from 1500
		assert!(wd.sample(ARM + 3000.0, 1500.0 + STALL_MS));
	}

	#[test]
	fn does_not_inherit_a_stale_clock_across_a_drained_episode() {
		let mut wd = make();
		assert!(!wd.sample(ARM + 1.0, 0.0));
		assert!(!wd.sample(0.0, 500.0)); // drained under clear: reset
		assert!(!wd.sample(ARM + 1.0, 10_000.0)); // fresh episode arms a new clock
		assert!(!wd.sample(ARM + 1.0, 10_000.0 + STALL_MS - 1.0));
		assert!(wd.sample(ARM + 1.0, 10_000.0 + STALL_MS));
	}

	#[test]
	fn production_window_rides_out_a_terminal_that_pauses_for_seconds() {
		// A live reader can stop consuming for seconds: a busy tmux server
		// holding a slow client, or a container's attach stream. Declaring it
		// gone kills the session (exit 129) although the terminal comes back. A
		// reader that never returns must still be torn down.
		let mut wd = StallWatchdog::default();
		let oversized = 67_108_865.0; // 64 MiB + 1
		assert!(!wd.sample(oversized, 0.0)); // arms
		assert!(!wd.sample(oversized, 10_000.0)); // paused 10 s: still alive
		assert!(!wd.sample(oversized, 60_000.0 - 1.0)); // still inside the window
		assert!(wd.sample(oversized, 60_000.0)); // never came back: disconnect at 60 s
	}
}
