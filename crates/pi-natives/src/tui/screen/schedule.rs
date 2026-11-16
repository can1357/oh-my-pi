//! Render scheduling: when the next frame may start.
//!
//! Forced frames (user gestures, resize, start) are due at the next tick.
//! Ordinary frames are paced: no closer than the `tui.maxFps` ceiling (or
//! the fixed input cadence for a frame a keystroke waits on), no sooner
//! than twice the last frame's cost, and not while the terminal still owes
//! a backlog of output. The host's "next macrotask" hops of the JS
//! scheduler are the `force_due` / `delay_due` flags, both due
//! immediately.

use super::{RenderRequest, Screen};
use crate::tui::types::{Event, ImageProtocol, Millis};

/// Cadence of frames a keystroke is waiting on. Pinned at the historical
/// 30 fps regardless of the `tui.maxFps` ceiling: the ceiling exists to
/// quiet panes nobody is typing in, and the one being typed in must echo
/// within a frame.
const INPUT_FRAME_INTERVAL_MS: Millis = 1000.0 / 30.0;
/// Ctrl+C/Esc use app-level double-press windows. Give those gestures one
/// frame to drain queued input before an ordinary repaint; delaying every
/// key would make idle navigation pay a full frame of latency.
const INPUT_RENDER_GRACE_MS: Millis = INPUT_FRAME_INTERVAL_MS;
/// Cap on the adaptive floor derived from the last frame's cost. Bounds
/// the UI responsiveness at ~5 fps under sustained heavy renders — anything
/// slower feels dead to the user and no longer justifies further CPU
/// savings.
const MAX_ADAPTIVE_RENDER_MS: Millis = 200.0;
/// Output backpressure gate. While the terminal still owes more than this
/// many bytes, composing another frame would only queue a stale paint
/// behind the backlog — and once the kernel PTY buffer is full, handing
/// the writer more bytes only grows the queue. Defer the render (keeping
/// its forced/clear-scrollback intent) until a tick observes the drain; the
/// eventual frame composes the latest component state, so a slow terminal
/// receives only fresh frames instead of every intermediate one.
///
/// This is the terminal's healthy-backlog level (the session watchdog's
/// clear threshold): gating here and ending a stall episode there keeps
/// the stall watchdog armed across exactly the range where frames are
/// deferred (#10434).
const MAX_PENDING_OUTPUT_BYTES: f64 = 256.0 * 1024.0;
/// Ghostty can drop Kitty graphics commands sent during its first
/// post-startup settle window, leaving only Unicode placeholder cells. Hold
/// the first image paint until that window has passed; later images render
/// normally.
const GHOSTTY_INITIAL_IMAGE_DELAY_MS: Millis = 100.0;
/// Longest the first paint waits for the TSP `hello` probe.
const NATIVE_PROBE_HOLD_MS: Millis = 300.0;

/// Render-schedule state of a [`Screen`].
pub(super) struct Schedule {
	/// A render is wanted and not yet started.
	pub(super) requested:          bool,
	/// A forced request is waiting for the next tick.
	pub(super) force_due:          bool,
	/// An ordinary request is waiting for the next tick to compute its
	/// delay (after the frame in progress, so the delay sees its cost).
	pub(super) delay_due:          bool,
	/// When the oldest `force_due` / `delay_due` was raised.
	pub(super) immediate_at:       Millis,
	/// Deadline of the paced ordinary frame.
	pub(super) timer:              Option<Millis>,
	/// A due frame is parked behind the output backlog.
	pub(super) drain_wait:         bool,
	pub(super) last_render_at:     Millis,
	/// Cost of the most recent frame, from `begin_frame` to presentation.
	/// Inflates the next render delay proportionally so a spike of slow
	/// frames (large transcript diffs, huge assistant text wrap,
	/// component-tree walks) does not busy-loop the CPU: the throttle would
	/// otherwise collapse to zero once `elapsed` passes the frame interval
	/// and fire the next frame immediately (see #4145).
	pub(super) last_frame_cost_ms: Millis,
	/// Start of the frame the host is composing.
	pub(super) frame_start:        Option<Millis>,
	/// Set when terminal input arrived, so the pending render is paced at
	/// `INPUT_FRAME_INTERVAL_MS` instead of the ceiling; cleared when that
	/// frame starts.
	pub(super) input_pending:      bool,
	pub(super) input_grace_until:  Millis,
	/// Floor between ordinary frames (the `tui.maxFps` ceiling).
	pub(super) frame_interval_ms:  Millis,
	pub(super) ghostty_done:       bool,
	pub(super) ghostty_timer:      Option<Millis>,
	pub(super) ghostty_ready_at:   Millis,
}

impl Schedule {
	pub(super) const fn new(frame_interval_ms: Millis) -> Self {
		Self {
			requested: false,
			force_due: false,
			delay_due: false,
			immediate_at: 0.0,
			timer: None,
			drain_wait: false,
			last_render_at: 0.0,
			last_frame_cost_ms: 0.0,
			frame_start: None,
			input_pending: false,
			input_grace_until: 0.0,
			frame_interval_ms,
			ghostty_done: false,
			ghostty_timer: None,
			ghostty_ready_at: 0.0,
		}
	}

	/// Drop every pending render (session start and stop).
	pub(super) const fn reset(&mut self) {
		self.requested = false;
		self.force_due = false;
		self.delay_due = false;
		self.timer = None;
		self.drain_wait = false;
		self.frame_start = None;
		self.ghostty_timer = None;
	}

	pub(super) const fn open_ghostty_window(&mut self, now: Millis) {
		self.ghostty_done = false;
		self.ghostty_ready_at = now + GHOSTTY_INITIAL_IMAGE_DELAY_MS;
	}

	/// Whether a Ghostty first-image paint is being held.
	pub(super) const fn ghostty_deferred(&self) -> bool {
		self.ghostty_timer.is_some()
	}

	pub(super) fn deadline(&self) -> Option<Millis> {
		let immediate = (self.force_due || self.delay_due).then_some(self.immediate_at);
		[immediate, self.timer, self.ghostty_timer]
			.into_iter()
			.flatten()
			.reduce(Millis::min)
	}

	const fn mark_immediate(&mut self, now: Millis) {
		if !self.force_due && !self.delay_due {
			self.immediate_at = now;
		}
	}
}

impl Screen {
	/// Ask for a frame. A forced request is due at the next tick and makes
	/// the next paint rewrite the viewport; `clear_scrollback` (honored with
	/// `force` only) latches a destructive reset. An ordinary request is
	/// paced by the frame cadence.
	///
	/// A request flagged `input` / `input_grace` reports terminal input
	/// instead. Every keystroke arms the input latch before any consumer
	/// runs, so whichever consumer requests the paint — an input listener or
	/// the focused component — it is paced at the input cadence, not the
	/// ceiling. Input that triggers no render leaves the latch for the next
	/// frame to consume at the 30 fps floor once; harmless. Unless also
	/// forced, such a request asks for no frame.
	pub fn request_render(&mut self, now: Millis, request: RenderRequest) {
		if self.stopped {
			return;
		}
		if request.input {
			self.schedule.input_pending = true;
		}
		if request.input_grace {
			self.schedule.input_grace_until = now + INPUT_RENDER_GRACE_MS;
		}
		if (request.input || request.input_grace) && !request.force && !request.immediate {
			return;
		}
		if request.force || request.immediate {
			self.prepare_forced_render(request.clear_scrollback);
			self.schedule.requested = true;
			self.schedule.mark_immediate(now);
			self.schedule.force_due = true;
			return;
		}
		// A render while a keystroke's latch is set rides the fixed input
		// cadence: an animation frame parked further out under the
		// `tui.maxFps` ceiling is replaced by one the keystroke can ride.
		// Input listeners (scroll wheel, toggles) and focused components
		// alike request through here.
		if self.schedule.input_pending && self.schedule.timer.is_some() && !self.native_live {
			self.schedule.timer = None;
			self.schedule.requested = true;
			self.schedule_render(now);
			return;
		}
		if self.schedule.requested {
			return;
		}
		self.schedule.requested = true;
		self.schedule.mark_immediate(now);
		self.schedule.delay_due = true;
	}

	/// Hold (or release) the first paint while the TSP `hello` probe is
	/// outstanding. The hold expires on its own after
	/// `NATIVE_PROBE_HOLD_MS`; a hold that ends while no surface took over —
	/// by expiry or by release — forces the repaint it held back.
	pub fn set_native_probe_hold(&mut self, now: Millis, held: bool) {
		if held {
			self.native_hold = Some(now + NATIVE_PROBE_HOLD_MS);
			return;
		}
		if self.native_hold.take().is_some() && !self.native_live {
			self.request_render(now, RenderRequest { force: true, ..RenderRequest::default() });
		}
	}

	pub(super) fn prepare_forced_render(&mut self, clear_scrollback: bool) {
		if clear_scrollback && !self.clear_scrollback_on_next_render {
			self.request_history_replay();
		}
		self.clear_scrollback_on_next_render |= clear_scrollback;
		self.force_viewport_repaint_on_next_render = true;
		if self.schedule.timer.take().is_some() {
			// The cancelled timer was the only callback owed to a pending
			// ordinary request. Every caller paints right after (a forced or
			// ordinary request it issues, or the render already in progress),
			// and that paint serves the request. Leaving the flag set would
			// turn every later ordinary request into a no-op: the resize
			// settle's rebuild and all spinner frames would never paint until
			// some forced render arrived.
			self.schedule.requested = false;
		}
	}

	/// Arm the paced timer for a requested ordinary frame.
	pub(super) fn schedule_render(&mut self, now: Millis) {
		let schedule = &mut self.schedule;
		if self.stopped || schedule.drain_wait || schedule.timer.is_some() || !schedule.requested {
			return;
		}
		let elapsed = now - schedule.last_render_at;
		// Animation and content frames land no closer than the `tui.maxFps`
		// ceiling allows; a frame a keystroke is waiting on keeps the fixed
		// input cadence.
		let frame_interval_ms = if schedule.input_pending {
			INPUT_FRAME_INTERVAL_MS.min(schedule.frame_interval_ms)
		} else {
			schedule.frame_interval_ms
		};
		let cadence_delay = (frame_interval_ms - elapsed).max(0.0);
		// Adaptive backpressure — target ~50% render duty cycle: the next
		// frame starts no sooner than `last_frame_end + last_frame_cost`,
		// i.e. `last_frame_start + 2 × last_frame_cost`. So `elapsed` (which
		// counts from the last frame's start) must already exceed twice the
		// cost before we allow the follow-up render to fire. Capped so a
		// pathological one-off spike doesn't lock the UI (#4145).
		let adaptive_floor = MAX_ADAPTIVE_RENDER_MS.min(schedule.last_frame_cost_ms * 2.0);
		let adaptive_delay = (adaptive_floor - elapsed).max(0.0);
		let input_grace_delay = (schedule.input_grace_until - now).max(0.0);
		// Native frames are paced by the terminal's acknowledgements
		// (credits), not by the row renderer's cadence.
		let delay = if self.native_live {
			0.0
		} else {
			cadence_delay.max(adaptive_delay).max(input_grace_delay)
		};
		schedule.timer = Some(now + delay);
	}

	/// Resume a frame parked behind the output backlog once it has drained.
	pub(super) fn resume_after_output_drain(&mut self, now: Millis, pending_output: f64) {
		if self.schedule.drain_wait && pending_output <= MAX_PENDING_OUTPUT_BYTES {
			self.schedule.drain_wait = false;
			self.schedule_render(now);
		}
	}

	/// Start every render due at `now`; several due at once share one
	/// [`Event::Render`].
	pub(super) fn run_due_renders(
		&mut self,
		now: Millis,
		pending_output: f64,
		out: &mut Vec<Event>,
	) {
		let mut emitted = false;
		if self
			.schedule
			.ghostty_timer
			.is_some_and(|deadline| now >= deadline)
		{
			self.schedule.ghostty_timer = None;
			self.schedule.ghostty_done = true;
			self.execute_render(pending_output, out, &mut emitted);
		}
		if self.schedule.force_due {
			self.schedule.force_due = false;
			if self.schedule.requested {
				self.schedule.requested = false;
				self.execute_render(pending_output, out, &mut emitted);
			}
		}
		if self.schedule.delay_due {
			self.schedule.delay_due = false;
			self.schedule_render(now);
		}
		if self.schedule.timer.is_some_and(|deadline| now >= deadline) {
			self.schedule.timer = None;
			if self.schedule.requested {
				self.schedule.requested = false;
				self.execute_render(pending_output, out, &mut emitted);
			}
		}
	}

	/// Tell the host to render, unless the terminal's output backlog exceeds
	/// `MAX_PENDING_OUTPUT_BYTES`: then the frame stays requested and waits
	/// for a drain; one-shot paint intents (the destructive-reset latch, the
	/// forced viewport repaint) survive untouched for it.
	fn execute_render(&mut self, pending_output: f64, out: &mut Vec<Event>, emitted: &mut bool) {
		if self.schedule.drain_wait {
			self.schedule.requested = true;
			return;
		}
		if pending_output > MAX_PENDING_OUTPUT_BYTES {
			self.schedule.requested = true;
			self.schedule.drain_wait = true;
			return;
		}
		if !*emitted {
			*emitted = true;
			// A frame the host never finished must not stretch this one's
			// cost.
			self.schedule.frame_start = None;
			out.push(Event::Render);
		}
	}

	/// Frame bookkeeping at `begin_frame`: the input latch is consumed and
	/// the frame cost starts counting. A repeated `begin_frame` for the same
	/// frame keeps the first start.
	pub(super) const fn open_frame(&mut self, now: Millis) {
		self.schedule.input_pending = false;
		if self.schedule.frame_start.is_none() {
			self.schedule.frame_start = Some(now);
			self.schedule.last_render_at = now;
		}
	}

	/// The frame opened by `begin_frame` is done (presented, or nothing to
	/// paint): record its cost, which feeds adaptive backpressure, and pace
	/// any render requested while it ran.
	pub(super) fn finish_frame(&mut self, now: Millis) {
		if let Some(start) = self.schedule.frame_start.take() {
			self.schedule.last_frame_cost_ms = now - start;
		}
		if self.schedule.requested {
			self.schedule_render(now);
		}
	}

	/// Whether the composed plan frame must wait out Ghostty's startup
	/// window because it carries the session's first image transmits. The
	/// host drops the composed frame; the delay's expiry renders again.
	pub(super) fn defer_ghostty_initial_image_paint(
		&mut self,
		now: Millis,
		pending_transmits: bool,
	) -> bool {
		let schedule = &mut self.schedule;
		if schedule.ghostty_done {
			return false;
		}
		if self.facts.terminal_id != "ghostty" || self.image_protocol != Some(ImageProtocol::Kitty) {
			schedule.ghostty_done = true;
			return false;
		}
		if !pending_transmits {
			return false;
		}
		if schedule.ghostty_timer.is_some() {
			return true;
		}
		if now >= schedule.ghostty_ready_at {
			schedule.ghostty_done = true;
			return false;
		}
		schedule.ghostty_timer = Some(schedule.ghostty_ready_at);
		true
	}
}
