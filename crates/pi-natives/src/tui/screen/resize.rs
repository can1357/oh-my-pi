//! Resize transactions and the handoffs that unwind them.
//!
//! A terminal resize reflows the normal buffer before the application hears
//! about it, so the painted viewport's anchor is stale the moment SIGWINCH
//! arrives. A transaction waits out the drag (on the borrowed alternate
//! buffer, or in place where borrowing is harmful), then either rebuilds
//! history destructively or recovers the reflowed anchor with a CPR round
//! trip against the parked cursor before the settled repaint.

use std::{mem, rc::Rc};

use super::{
	AltExit, RenderRequest, Screen, emit, emit_mouse_tracking_off,
	frame::{emit_erase_below_cursor_row, emit_erase_below_row},
	text,
};
use crate::{
	term::{Batch, Device, mode},
	tui::types::{Millis, MouseTracking, ResizeScrollback, Size},
};

/// Quiet window before restoring the normal buffer after resize.
const RESIZE_VIEWPORT_SETTLE_MS: Millis = 120.0;
/// Longest wait for a CPR reply before the settled repaint falls back.
const RESIZE_PROBE_TIMEOUT_MS: Millis = 200.0;
/// How long after a settle a SIGWINCH is taken as the terminal's own
/// reaction to the buffer switch and answered with a plain forced repaint.
const RESIZE_SUPPRESS_MS: Millis = 100.0;
/// First column usable as a CPR tag (see `begin_resize_anchor_probe`).
const CPR_TAG_FIRST_COLUMN: u32 = 17;
/// Most tag columns in rotation.
const CPR_TAG_MAX_SPAN: u32 = 30;

/// Which settle a quiet resize window ends in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Settle {
	/// Leave the borrowed alternate buffer.
	Alt,
	/// Rebuild or re-anchor the screen that stayed visible.
	InPlace,
}

/// The live-viewport erase a resize transaction opens with, addressed for
/// the geometry of the SIGWINCH that computed it.
#[derive(Clone, Copy, Debug)]
enum LiveErase {
	/// From an absolute row down.
	Absolute { top: u32, height: u32 },
	/// From `up` rows above the parked cursor down.
	Relative { up: u32, width: u32, height: u32 },
}

impl LiveErase {
	/// Both forms leave the cursor on the viewport's top row.
	fn emit(self, b: &mut Batch<'_>) {
		b.reset_mode(mode::CURSOR_VISIBLE, false);
		match self {
			Self::Absolute { top, height } => emit_erase_below_row(b, top, height),
			Self::Relative { up, width, height } => {
				b.up(up);
				emit_erase_below_cursor_row(b, width, height);
			},
		}
	}
}

/// The resize borrow's entry (live-viewport erase, CSI ?1049h; the device
/// re-pushes the active keyboard enhancement after the switch, which can be
/// buffer-local), held for the first resize frame's synchronized update.
/// Written on its own, the terminal can present the blank alternate screen
/// for a frame before the resize frame lands.
#[derive(Clone, Copy, Debug)]
pub(super) struct AltEnter {
	erase: Option<LiveErase>,
}

impl AltEnter {
	pub(super) fn emit(self, b: &mut Batch<'_>) {
		if let Some(erase) = self.erase {
			erase.emit(b);
		}
		b.set_mode(mode::ALT_SCREEN, false);
	}
}

/// In-flight post-resize anchor probe: the stale viewport snapshot and park
/// offset captured when CSI 6n was written, plus the no-reply deadline.
pub(super) struct Probe {
	/// Visible cell width of each row of the stale viewport.
	window:   Rc<[u32]>,
	offset:   u32,
	deadline: Millis,
	epoch:    u64,
	retried:  bool,
}

/// Resize-transaction state of a [`Screen`].
pub(super) struct ResizeState {
	pub(super) probe: Option<Probe>,
	/// Pre-erase viewport snapshot for the settled resize-anchor probe (the
	/// visible width of each row): the erase in `begin_resize_alt_paint`
	/// empties the painted window, so the probe must bound the anchor with
	/// the window that was actually on screen when the resize began (see
	/// the `height - stale_rows` clamp in `resolve_resize_anchor`).
	probe_window: Rc<[u32]>,
	probe_offset: u32,
	/// Direction tracking for the current coalesced resize burst (reset
	/// when a plan frame commits, alongside the committed geometry). A burst
	/// containing any height grow invalidates the multiplexer clip model in
	/// `resolve_resize_anchor`: the grow pulls scrollback into the pane and
	/// moves the parked logical row, so the net shrink no longer telescopes
	/// from pre-burst state.
	burst_grew: bool,
	burst_last_height: Option<u32>,
	/// Sum of every grow step in the burst: bounds how much scrollback a
	/// multiplexer can have pulled down across the whole burst, including a
	/// shrink-then-regrow that never exceeds the pre-burst height (see the
	/// CPR-timeout fallback in `resolve_resize_anchor`).
	burst_pull: u32,
	/// Whether any step of the burst left the committed width / geometry.
	/// The terminal reflowed the normal buffer at every intermediate step,
	/// so a drag that returns to its starting size still shredded retained
	/// history and pushed unerased live rows into it; the settled refresh
	/// must key on the whole burst, not on the net change (see
	/// `prepare_resize_replay`).
	burst_width_changed: bool,
	burst_resized: bool,
	/// A shrink can discard live rows below the cursor and push others into
	/// scrollback. Rebuild must repair that even when the burst ends taller.
	burst_shrank: bool,
	/// Geometry epoch: bumped on every resize transaction entry, so each
	/// CSI 6n request records the geometry it was parked under.
	geometry_epoch: u64,
	/// CPR attribution: each request parks a distinct column (CHA) before
	/// its CSI 6n; the terminal processes requests serially, so every reply
	/// carries its own request's column. That makes attribution exact even
	/// when replies are dropped or arbitrarily delayed — anonymous FIFO
	/// counting cannot survive drops (forgetting retired requests eagerly
	/// misattributes late replies, remembering them forever poisons later
	/// probes with phantoms, and age expiry is unsound because replies carry
	/// no lifetime guarantee). A rewrap can only invalidate a reply's row
	/// via a width-change SIGWINCH, which bumps the geometry epoch and
	/// discards the reply anyway, so the scheme is sound on direct
	/// terminals too. Tags are never expired; a late reply to a dead tag is
	/// stripped and discarded by column. Entries are `(column, epoch)`.
	cpr_column_tags: Vec<(u32, u64)>,
	cpr_probe_seq: u32,
	/// The alternate buffer is borrowed for resize repainting.
	pub(super) alt_active: bool,
	settle: Option<(Millis, Settle)>,
	suppress_until: Millis,
	/// Baseline geometry at the last alt-buffer toggle, plus whether its
	/// echo is still pending. A Warp-only echo is a height-only ±1 SIGWINCH
	/// against this baseline while the CPR probe is in flight. The
	/// expectation is single-shot: the first SIGWINCH after the toggle
	/// consumes it, so a real one-row resize back to the baseline can never
	/// be mistaken for the echo.
	alt_toggle_size: Size,
	alt_toggle_echo_pending: bool,
	/// True while an in-place resize waits for its settled rebuild (tmux) or
	/// anchor recovery (Warp): ordinary paints must not use the stale
	/// anchor.
	pub(super) in_place_active: bool,
	/// Geometry the settled history replay was last offered for.
	pub(super) replay_size: Option<Size>,
	pub(super) pending_alt_enter: Option<AltEnter>,
	/// True while the screen's pending alt exit holds the resize borrow's
	/// own exit: the settle fused it into the destructive rebuild, so the
	/// terminal is still on the borrowed alt buffer until that frame is
	/// written. A SIGWINCH or a fullscreen overlay arriving first adopts the
	/// buffer instead of entering it again (see `settle_resize_alt_paint`).
	pub(super) alt_exit_fused: bool,
}

impl Default for ResizeState {
	fn default() -> Self {
		Self {
			probe:                   None,
			probe_window:            Rc::default(),
			probe_offset:            0,
			burst_grew:              false,
			burst_last_height:       None,
			burst_pull:              0,
			burst_width_changed:     false,
			burst_resized:           false,
			burst_shrank:            false,
			geometry_epoch:          0,
			cpr_column_tags:         Vec::new(),
			cpr_probe_seq:           0,
			alt_active:              false,
			settle:                  None,
			suppress_until:          0.0,
			alt_toggle_size:         Size { columns: 0, rows: 0 },
			alt_toggle_echo_pending: false,
			in_place_active:         false,
			replay_size:             None,
			pending_alt_enter:       None,
			alt_exit_fused:          false,
		}
	}
}

impl ResizeState {
	/// A plan frame committed the geometry: the burst is over.
	pub(super) const fn reset_burst(&mut self) {
		self.burst_grew = false;
		self.burst_shrank = false;
		self.burst_last_height = None;
		self.burst_pull = 0;
		self.burst_width_changed = false;
		self.burst_resized = false;
	}

	pub(super) fn deadline(&self) -> Option<Millis> {
		let settle = self.settle.map(|settle| settle.0);
		let probe = self.probe.as_ref().map(|probe| probe.deadline);
		[settle, probe].into_iter().flatten().reduce(Millis::min)
	}
}

/// Rows `[start, end)` of a previously painted window, given as visible
/// cell widths, re-measured at `width`. Every terminal rewraps content on a
/// width change — including multiplexers: tmux clips in place on height
/// changes only, and reflows the pane (scrollback included) when the width
/// moves, so a row painted wider than the current width spans
/// ceil(cells/width) physical rows everywhere. For height-only resizes the
/// painted rows already fit the width and the count is unchanged.
fn reflowed_row_count(window: &[u32], start: usize, end: usize, width: u32) -> i64 {
	let stop = end.min(window.len());
	let width = width.max(1);
	window[start.min(stop)..stop]
		.iter()
		.map(|cells| i64::from(cells.div_ceil(width).max(1)))
		.sum()
}

impl Screen {
	/// The effective terminal size changed (the SIGWINCH handler body).
	pub fn os_resize(&mut self, now: Millis, size: Size, device: &mut Device) {
		if self.stopped {
			return;
		}
		if self.native_live {
			// The terminal lays the surface out: a resize only refreshes the
			// width the host's fallback nodes render at. No replay.
			return;
		}
		if self.resize.probe.is_some() {
			// Warp echoes a height-only ±1 SIGWINCH on CSI ?1049l. The echo
			// must not restart the alt borrow (that is the flicker loop), but
			// the terminal really did adopt the echoed size, so a CPR reply
			// already in flight may predate it: retire the probe and reissue
			// it at the new geometry. DSR-only, no toggle, so this
			// terminates. A real geometry change restarts the transaction
			// below.
			if self.is_warp_alt_toggle_echo(size) {
				self.resize.probe = None;
				self.track_resize_burst(size);
				self.begin_resize_anchor_probe(now, size, device, false);
				return;
			}
			self.resize.probe = None;
			if self.resize_avoids_alt_buffer() {
				self.begin_resize_in_place_paint(now, size, device);
			} else {
				self.begin_resize_alt_paint(now, size, true);
			}
			return;
		}
		if self.alt_active {
			// A fullscreen overlay owns the alt buffer: repaint the modal at
			// the new size. Never snapshot the normal window or probe its
			// anchor against the alternate grid — not even for a toggle echo.
			self.request_render(now, RenderRequest { force: true, ..RenderRequest::default() });
			return;
		}
		if !self.resize.alt_active && self.is_warp_alt_toggle_echo(size) {
			// Delayed echo that lost the signal-vs-pty race with its own
			// probe's CPR reply: the probe already resolved, so re-probe at
			// the echoed size instead of painting on a stale anchor or
			// suppressing into a forced replay. DSR-only, no borrow.
			// While the resize borrow is active the echo is swallowed without
			// probing: a CPR issued now would snapshot the alternate grid and
			// anchor the normal viewport to its row.
			self.stash_probe_window();
			self.track_resize_burst(size);
			self.begin_resize_anchor_probe(now, size, device, false);
			return;
		}
		if now < self.resize.suppress_until {
			self.request_render(now, RenderRequest { force: true, ..RenderRequest::default() });
			return;
		}
		if self.resize_avoids_alt_buffer() {
			self.begin_resize_in_place_paint(now, size, device);
			return;
		}
		self.begin_resize_alt_paint(now, size, false);
	}

	/// A CPR (`CSI row ; col R`, 1-based) routed from the session. Replies
	/// are consumed while an anchor probe's tag is unanswered; they are
	/// terminal reports, never keystrokes, and must not reach the focused
	/// component. Returns false when the report is not the screen's: the
	/// engine re-emits it as a key (modified F3).
	pub fn handle_cursor_position(
		&mut self,
		now: Millis,
		size: Size,
		row: u32,
		column: u32,
		_device: &mut Device,
	) -> bool {
		let tags = &mut self.resize.cpr_column_tags;
		if tags.is_empty() {
			return false;
		}
		let Some(tag) = tags.iter().position(|entry| entry.0 == column) else {
			// CSI 1;<mod>R with no live tag is modified F3: the modifier
			// parameter spans 2-256 once the lock-state bits (caps 64, num
			// 128) and hyper/meta are included, so no practical tag range
			// escapes it entirely. Anything row-1 we did not tag is treated as
			// a keystroke and left for the focused component; a tagged column
			// hit by a hyper/meta-modified F3 (params 17-64, practically
			// unused) is still gated by the epoch check below.
			//
			// Other unknown-column replies while expecting tagged ones are our
			// requests answered with a clamped or mangled column: strip and
			// discard; the probe timeout covers recovery.
			return !(row == 1 && column >= 2);
		};
		// Column-tagged reply: exact attribution. Resolve only when its
		// request was parked under the active probe's geometry; a reply from
		// an older epoch is stale and discarded.
		let (_, tag_epoch) = tags.remove(tag);
		// tmux can resize its grid before the application receives SIGWINCH.
		// A reply below our known screen is from that newer geometry: do not
		// repaint it using the stale height. Wait for resize or the probe
		// retry.
		if self
			.resize
			.probe
			.as_ref()
			.is_some_and(|probe| probe.epoch == tag_epoch)
			&& row >= 1
			&& row <= size.rows
		{
			self.resolve_resize_anchor(now, size, Some(row - 1));
		}
		true
	}

	/// Switch between the row renderer and a Tern Surface Protocol surface.
	/// Going live after the row renderer painted (the handshake landed late,
	/// with input deferred) leaves the alternate screen if borrowed and
	/// erases the painted viewport so the surface opens where the rows
	/// began. Going back to rows only flips the flag; the host forces the
	/// repaint.
	pub fn set_native_surface(&mut self, _now: Millis, live: bool, device: &mut Device) {
		if live {
			self.erase_row_paint_for_native(device);
		}
		self.native_live = live;
	}

	fn erase_row_paint_for_native(&mut self, device: &mut Device) {
		self.resize.probe = None;
		self.resize.settle = None;
		let leave_alt = self.alt_active || self.resize.alt_active;
		let enter = if leave_alt {
			self.resize.pending_alt_enter.take()
		} else {
			None
		};
		self.alt_active = false;
		self.resize.alt_active = false;
		let mouse_off = self.mouse_tracking != MouseTracking::Off;
		self.mouse_tracking = MouseTracking::Off;
		let erase = (self.previous_frame_length > 0)
			.then(|| i64::from(self.provider_viewport_top) - i64::from(self.hardware_cursor_row));
		if erase.is_some() {
			self.previous_frame_length = 0;
			self.provider_window.clear();
			self.provider_rows.clear();
		}
		emit(device, |b| {
			if leave_alt {
				if let Some(enter) = enter {
					enter.emit(b);
				}
				b.reset_mode(mode::ALT_SCREEN, false);
			}
			if mouse_off {
				emit_mouse_tracking_off(b);
			}
			if let Some(line_diff) = erase {
				emit_relative_move(b, line_diff);
				b.cr().erase_below();
			}
			b.reset_mode(mode::CURSOR_VISIBLE, true);
		});
		self.forget_hardware_cursor();
	}

	/// First half of stopping: unwind every transient terminal state so the
	/// host can retire its remaining history with plain plan frames
	/// ([`present_plan`](Self::present_plan), no `begin_frame`) before
	/// [`stop_handoff`](Self::stop_handoff).
	pub fn prepare_stop(&mut self, _now: Millis, size: Size, device: &mut Device) {
		self.schedule.reset();
		self.native_hold = None;
		self.native_live = false;
		self.resize.settle = None;
		// The hardware cursor sits wherever the drag left it, but tracking
		// still describes the pre-resize row (no alt-buffer restore replays
		// it back). The shell handoff moves relatively from the tracked row,
		// so park absolutely on the bottom row and record it first.
		let park_bottom = self.resize.in_place_active && size.rows > 0;
		if park_bottom {
			self.hardware_cursor_row = size.rows - 1;
		}
		self.resize.in_place_active = false;
		self.resize.alt_toggle_echo_pending = false;
		self.resize.probe = None;
		let leave_resize_alt = mem::take(&mut self.resize.alt_active);
		let pending_exit = self.pending_alt_exit.take();
		let leave_alt = self.alt_active || pending_exit.is_some();
		let mouse_off = self.mouse_tracking != MouseTracking::Off;
		let mut enter = if leave_resize_alt || pending_exit.is_some() {
			self.resize.pending_alt_enter.take()
		} else {
			None
		};
		if park_bottom || leave_resize_alt || leave_alt || mouse_off {
			emit(device, |b| {
				if park_bottom {
					b.move_to(size.rows, 1);
				}
				if leave_resize_alt {
					if let Some(enter) = enter.take() {
						enter.emit(b);
					}
					b.reset_mode(mode::ALT_SCREEN, false);
				}
				// A pending fused exit may have been built without an OFF
				// write to keep inline capture alive across the restore — at
				// process quit nothing continues, so release unconditionally.
				// The pending sequence itself can re-enable tracking
				// (overlay-close restore), so the final OFF goes last or the
				// shell keeps reporting.
				if let Some(exit) = pending_exit {
					if let Some(enter) = enter.take() {
						enter.emit(b);
					}
					exit.emit(b);
					if mouse_off {
						emit_mouse_tracking_off(b);
					}
				} else {
					// Inline capture with no overlay is still owned by us at
					// quit, so release it too — otherwise the parent shell
					// keeps mouse reporting and loses native selection until
					// a manual reset.
					if mouse_off {
						emit_mouse_tracking_off(b);
					}
					if leave_alt {
						b.reset_mode(mode::ALT_SCREEN, false);
					}
				}
			});
		}
		if leave_alt {
			self.alt_active = false;
			self.alt_previous_lines.clear();
			self.alt_rows.clear();
			self.resize.alt_exit_fused = false;
		}
		self.mouse_tracking = MouseTracking::Off;
		// A latched destructive reset (settled rebuild-mode resize, /clear)
		// pairs ED3 with a complete-ledger replay. Running that pair during
		// stop would erase native history and re-stream the whole transcript
		// at quit; drop the latch so the host's flush writes only un-retired
		// rows.
		self.clear_scrollback_on_next_render = false;
		// Transmitted images are deliberately left in the terminal's graphics
		// store: placeholder cells committed to native scrollback render only
		// while their image data lives, so a delete-by-id here would blank
		// every transcript image the instant the session exits. The terminal
		// enforces its own store quota (and live-session ghosts are already
		// bounded by the inline-image budget).
	}

	/// Second half of stopping: hand the terminal to the parent shell.
	///
	/// Place the shell on the first line after the rendered content. When
	/// that line is still inside the viewport, moving there and writing `\r`
	/// is enough; emitting `\r\n` would create an extra blank row. If the
	/// content already reaches the viewport bottom, scroll exactly once so
	/// the prompt lands directly below the last visible row.
	pub fn stop_handoff(&mut self, size: Size, device: &mut Device) {
		self.stopped = true;
		self.schedule.reset();
		let prompt = (self.previous_frame_length > 0).then(|| {
			// Provider frames anchor the mutable viewport below retained
			// history; the shell prompt belongs on the first row after that
			// content.
			let target_row = self.provider_viewport_top + self.previous_frame_length;
			let viewport_bottom = size.rows.saturating_sub(1);
			let clamped_cursor_row = self.hardware_cursor_row.min(viewport_bottom);
			let move_target_row = target_row.min(viewport_bottom);
			(i64::from(move_target_row) - i64::from(clamped_cursor_row), target_row > viewport_bottom)
		});
		emit(device, |b| {
			if let Some((line_diff, scroll)) = prompt {
				emit_relative_move(b, line_diff);
				b.cr();
				if scroll {
					b.lf(1);
				}
			}
			// Force: the parent shell needs the cursor back regardless of
			// what the device's dedupe believes was last written.
			b.set_mode(mode::CURSOR_VISIBLE, false);
		});
		self.forget_hardware_cursor();
	}

	/// Fire the settle and probe timers due at `now`.
	pub(super) fn fire_resize_timers(&mut self, now: Millis, size: Size, device: &mut Device) {
		if let Some((_, settle)) = self.resize.settle.take_if(|settle| now >= settle.0) {
			match settle {
				Settle::Alt => {
					if self.resize.alt_active {
						self.settle_resize_alt_paint(now, size, device);
					}
				},
				Settle::InPlace => self.settle_resize_in_place_paint(now, size, device),
			}
		}
		if let Some(probe) = &self.resize.probe
			&& now >= probe.deadline
		{
			if !probe.retried && (self.facts.inside_multiplexer || self.resize.burst_grew) {
				// A CPR-less resolve is heuristic: a grow's pull span is
				// unknown on any terminal, and SIGWINCH coalescing can hide
				// intermediate grows entirely, so even an observed-monotonic
				// multiplexer shrink cannot be modeled with certainty. A
				// dropped DSR reply is a transient race — multiplexers in
				// particular answer DSR themselves — so ask once more before
				// falling back.
				self.begin_resize_anchor_probe(now, size, device, true);
			} else {
				self.resolve_resize_anchor(now, size, None);
			}
		}
	}

	/// Whether a resize repaints the settled viewport in place, with no alt
	/// borrow and no history replay. Warp re-reports its size on alt-buffer
	/// toggles, so borrowing there self-sustains (`PI_TUI_RESIZE_IN_PLACE`
	/// forces either answer). Inside a multiplexer the mux owns the grid and
	/// consumes the toggles itself, so an inherited Warp marker must not
	/// suppress its replay. tmux's synchronized rebuild is selected
	/// separately in `resize_avoids_alt_buffer`.
	///
	/// A `ConPTY` host is excluded for the same reason as a multiplexer:
	/// conhost owns the grid the application writes to. Measured on conhost,
	/// resizing the pseudoconsole makes it re-emit its whole viewport from
	/// `CSI H` with absolute addressing while the application writes
	/// nothing, and it re-homes the cursor, so the settled DSR reply carries
	/// column 1 instead of the probe's tag column and can never be
	/// attributed. In-place resize has neither of its preconditions there —
	/// a recoverable anchor and a grid nobody else repaints — so keep the
	/// borrow, whose settled transaction ends in the scrollback-mode rebuild
	/// that erases conhost's stale copy.
	const fn resize_repaints_in_place(&self) -> bool {
		if let Some(forced) = self.facts.resize_in_place {
			return forced;
		}
		if self.facts.inside_multiplexer || self.facts.conpty {
			return false;
		}
		self.facts.warp
	}

	fn resize_avoids_alt_buffer(&self) -> bool {
		if self.resize_repaints_in_place() {
			return true;
		}
		// Unlike Warp's viewport-only repaint, tmux still rebuilds history.
		// Restoring an alternate buffer schedules a tmux redraw that ends its
		// synchronized update early, exposing the rest of a long replay.
		!self.resize.alt_active
			&& self.pending_alt_exit.is_none()
			&& self.facts.resize_in_place != Some(false)
			&& self.resize_scrollback == ResizeScrollback::Rebuild
			&& self.synchronized_output
			&& self.facts.multiplexer.alt_restore_ends_synchronized_output
	}

	pub(super) const fn note_alt_buffer_toggle(&mut self, size: Size) {
		self.resize.alt_toggle_size = size;
		self.resize.alt_toggle_echo_pending = true;
	}

	/// Warp-only echo: height-only ±1 SIGWINCH against the pending
	/// alt-toggle baseline. Single-shot: the first SIGWINCH after the toggle
	/// consumes the expectation either way, so at most one signal is ever
	/// swallowed per toggle. Never inside a multiplexer, which consumes the
	/// toggles itself.
	fn is_warp_alt_toggle_echo(&mut self, size: Size) -> bool {
		if !mem::take(&mut self.resize.alt_toggle_echo_pending) {
			return false;
		}
		// Inside a multiplexer the mux consumes alt toggles itself, so no
		// echo is possible: every ±1 resize is real and must restart the
		// transaction.
		if self.facts.inside_multiplexer || !self.facts.warp {
			return false;
		}
		size.columns == self.resize.alt_toggle_size.columns
			&& size.rows.abs_diff(self.resize.alt_toggle_size.rows) <= 1
	}

	/// Fold one SIGWINCH step into the coalesced resize-burst accounting
	/// shared by both resize paths: any grow step poisons the multiplexer
	/// clip model, the accumulated pull bounds CPR-less grow anchors, and
	/// the epoch retires the in-flight CPR tag so a rewrap-invalidated reply
	/// cannot anchor a new geometry.
	fn track_resize_burst(&mut self, size: Size) {
		let resize = &mut self.resize;
		let burst_last_height = resize.burst_last_height.unwrap_or(self.previous_height);
		if size.rows > burst_last_height {
			resize.burst_grew = true;
		}
		if size.rows < burst_last_height {
			resize.burst_shrank = true;
		}
		resize.burst_last_height = Some(size.rows);
		resize.burst_pull += size.rows.saturating_sub(burst_last_height);
		if size.columns != self.previous_width {
			resize.burst_width_changed = true;
		}
		if size.columns != self.previous_width || size.rows != self.previous_height {
			resize.burst_resized = true;
		}
		resize.geometry_epoch += 1;
	}

	/// Snapshot the painted window and park offset for the anchor probe.
	fn stash_probe_window(&mut self) {
		self.resize.probe_window = self
			.provider_window
			.iter()
			.map(|line| text::visible_width(line))
			.collect();
		self.resize.probe_offset = self.parked_viewport_offset;
	}

	/// Coalesced resize without borrowing the alt buffer. Once quiet, tmux
	/// can rebuild directly under synchronized output; viewport-only
	/// repaints recover their anchor with CPR. The existing screen remains
	/// visible while waiting.
	fn begin_resize_in_place_paint(&mut self, now: Millis, size: Size, device: &mut Device) {
		if self.alt_active {
			self.request_render(now, RenderRequest { force: true, ..RenderRequest::default() });
			return;
		}
		self.track_resize_burst(size);
		self.resize.in_place_active = true;
		self.forget_hardware_cursor();
		if let Some(erase) = self.live_viewport_resize_erase(size) {
			emit(device, |b| erase.emit(b));
			// The erase parked the hardware cursor on the viewport's top row;
			// snapshot the parked offset so the settled probe anchors there.
			self.parked_viewport_offset = 0;
		}
		self.resize.settle = Some((now + RESIZE_VIEWPORT_SETTLE_MS, Settle::InPlace));
	}

	fn settle_resize_in_place_paint(&mut self, now: Millis, size: Size, device: &mut Device) {
		self.prepare_resize_replay(size);
		if self.clear_scrollback_on_next_render {
			self.resize.in_place_active = false;
			self.request_render(now, RenderRequest::default());
			return;
		}
		self.stash_probe_window();
		self.begin_resize_anchor_probe(now, size, device, false);
	}

	/// Blank the mutable live viewport on the normal screen before a resize
	/// transaction waits out the drag. The terminal keeps reflowing the
	/// normal buffer during the drag, and a height shrink pushes its top
	/// rows into scrollback; with the live region blanked, only committed
	/// history rows (correct to push) or blanks can leave the screen — never
	/// live placeholder rows such as compact tool dots, whose real blocks
	/// must enter scrollback through the ordered history path. Addressing
	/// depends on the resize direction. Terminals keep the parked cursor
	/// attached to its logical line through width rewrap and height-grow
	/// scrollback pull-down, so cursor-relative movement lands on the
	/// viewport's top row. On height shrink kitty clamps the cursor instead
	/// of moving it with pushed rows, so cursor-relative addressing would
	/// start rows late; fall back to the same bottom-preserving bound as
	/// resize-anchor recovery.
	///
	/// Both erase paths leave the cursor on the viewport's top row. `None`
	/// when there is nothing to erase (multiplexers skip it: an immediate
	/// erase races the pane re-layout and blanks pulled-back committed
	/// rows).
	fn live_viewport_resize_erase(&self, size: Size) -> Option<LiveErase> {
		let window = &self.provider_window;
		if !self.has_ever_rendered || window.is_empty() || self.facts.inside_multiplexer {
			return None;
		}
		if size.rows < self.previous_height {
			let stale_rows = text::reflowed_rows(window, 0, window.len(), size.columns) as u32;
			let top = self
				.provider_viewport_top
				.min(size.rows.saturating_sub(stale_rows));
			return Some(LiveErase::Absolute { top, height: size.rows });
		}
		let up =
			text::reflowed_rows(window, 0, self.parked_viewport_offset as usize, size.columns) as u32;
		Some(LiveErase::Relative { up, width: size.columns, height: size.rows })
	}

	/// Borrow the alternate buffer for stable, history-free resize
	/// repainting. `restarting_probe` marks a transaction restarted by a
	/// SIGWINCH that arrived while the settled anchor probe was in flight:
	/// the live window was already stashed and emptied, so the snapshot
	/// below must be skipped to keep the good stash.
	fn begin_resize_alt_paint(&mut self, now: Millis, size: Size, restarting_probe: bool) {
		if self.alt_active {
			self.request_render(now, RenderRequest { force: true, ..RenderRequest::default() });
			return;
		}
		self.track_resize_burst(size);
		if !self.resize.alt_active && self.resize.alt_exit_fused {
			// The settled rebuild has not been written yet, so its fused exit
			// never left the borrowed buffer: resume the borrow there. The
			// live window was already stashed and the rebuild stays latched,
			// so there is nothing to snapshot or erase, and entering again
			// would stack another alt switch.
			self.resize.alt_active = true;
			self.pending_alt_exit = None;
			self.resize.alt_exit_fused = false;
		} else if !self.resize.alt_active {
			self.resize.alt_active = true;
			self.alt_previous_lines.clear();
			self.alt_rows.clear();
			self.forget_hardware_cursor();
			// Blank the live region as the borrow enters so a reflow-driven
			// scroll can only push committed rows into scrollback. The erase
			// is computed against this SIGWINCH's geometry but rides in the
			// first resize frame's synchronized update with the buffer switch
			// (the pending alt enter), so neither the blanked normal screen
			// nor the empty alternate one is ever presented. The pre-erase
			// window is stashed for the settled CPR probe: its reflowed row
			// count bounds the anchor to `height - stale_rows`, so a
			// mis-parked cursor (a single-step tmux zoom re-lays the pane
			// before SIGWINCH delivery, moving the park target under us)
			// cannot anchor the settled repaint over pulled-back history rows
			// or scroll-push the frame into scrollback again.
			if !restarting_probe {
				self.stash_probe_window();
			}
			let erase = self.live_viewport_resize_erase(size);
			if erase.is_some() {
				// The erase parks the cursor on the viewport's top row, so the
				// parked offset no longer applies; carrying a stale nonzero
				// offset into the probe would anchor the settled repaint above
				// the real viewport top and overwrite visible committed rows.
				self.resize.probe_offset = 0;
				self.provider_window.clear();
				self.provider_rows.clear();
				self.parked_viewport_offset = 0;
			}
			if self.has_ever_rendered
				&& !self.provider_window.is_empty()
				&& self.facts.inside_multiplexer
			{
				// Multiplexers apply the pane re-layout on their own schedule
				// relative to SIGWINCH delivery, so an immediate erase races
				// it: with the pane already re-laid the stale coordinates
				// blank pulled-back committed rows (destroying popped
				// scrollback), and with the pane not yet re-laid the erase
				// lands on rows about to move. Skip it — the settled repaint
				// overwrites the live region at the clip-model anchor and
				// erases below it, race-free after the quiet window.
				self.provider_window.clear();
				self.provider_rows.clear();
				self.parked_viewport_offset = 0;
			}
			self.note_alt_buffer_toggle(size);
			self.begin_alt_image_lifecycle();
			self.resize.pending_alt_enter = Some(AltEnter { erase });
		}
		self.resize.settle = Some((now + RESIZE_VIEWPORT_SETTLE_MS, Settle::Alt));
		self.request_render(now, RenderRequest { force: true, ..RenderRequest::default() });
	}

	/// End the alt-buffer borrow once the resize settles.
	///
	/// A settle that rebuilds history never needs the viewport anchor: the
	/// destructive reset erases the screen and history and repaints from row
	/// zero. Restoring the normal buffer on its own write would only expose
	/// the reflowed stale screen for the CPR round trip, then clear it and
	/// stream the replay — the one flash a large resize (a tmux zoom) still
	/// showed. So that settle latches the rebuild now and fuses the restore
	/// into the same synchronized write as ED2+ED3 and the replay: the
	/// terminal goes straight from the resize frame to the rebuilt screen.
	///
	/// Every other settle restores the normal buffer and probes the reflowed
	/// anchor, which the non-destructive repaint depends on.
	fn settle_resize_alt_paint(&mut self, now: Millis, size: Size, device: &mut Device) {
		self.resize.alt_active = false;
		self.resize.suppress_until = now + RESIZE_SUPPRESS_MS;
		self.alt_previous_lines.clear();
		self.alt_rows.clear();
		// Only the provider plan frame emits a pending exit, and an exit
		// already pending (a fused overlay close) owns that slot.
		if self.provider.is_some() && self.pending_alt_exit.is_none() {
			if self.resize_scrollback == ResizeScrollback::Rebuild {
				self.prepare_resize_replay(size);
			}
			if self.clear_scrollback_on_next_render {
				// An entry no resize frame carried yet rides ahead of this
				// exit in the rebuild frame (see `emit_plan_frame`).
				self.pending_alt_exit = Some(AltExit { mouse_off: false, mouse_on: false });
				self.resize.alt_exit_fused = true;
				self.request_render(now, RenderRequest { force: true, ..RenderRequest::default() });
				return;
			}
		}
		self.note_alt_buffer_toggle(size);
		let enter = self.resize.pending_alt_enter.take();
		emit(device, |b| {
			if let Some(enter) = enter {
				enter.emit(b);
			}
			b.reset_mode(mode::ALT_SCREEN, false);
		});
		self.begin_resize_anchor_probe(now, size, device, false);
	}

	/// Recover the reflowed viewport anchor after the resize settle window
	/// ends. The terminal reflowed the restored normal buffer during the
	/// drag, so the viewport top is in stale grid coordinates; a DSR (CSI
	/// 6n) round trip against the parked cursor reports where the viewport's
	/// logical line landed. The settled repaint waits for the reply (or a
	/// short timeout).
	pub(super) fn begin_resize_anchor_probe(
		&mut self,
		now: Millis,
		size: Size,
		device: &mut Device,
		retry: bool,
	) {
		self.resize.probe = Some(Probe {
			window:   Rc::clone(&self.resize.probe_window),
			offset:   self.resize.probe_offset,
			deadline: now + RESIZE_PROBE_TIMEOUT_MS,
			epoch:    self.resize.geometry_epoch,
			retried:  retry,
		});
		// A ConPTY host re-homes the cursor on every resize, so its reply
		// carries column 1 and can never be attributed to a tag. Sending the
		// DSR would only burn a tag column for the rest of the session (dead
		// tags are deliberately never reclaimed) and stall the settled
		// repaint for the full timeout, so anchor from the fallback
		// immediately. Two exemptions: a multiplexer answers DSR from its own
		// grid, so under WSL-in-tmux the reply is attributable and the
		// width-reflow / hidden-grow / reversed-burst logic still needs it;
		// and PI_TUI_RESIZE_IN_PLACE=1 forces the in-place repaint, whose
		// anchor is only as good as this probe, so the documented escape
		// hatch restores the whole pre-change path.
		if self.facts.conpty
			&& !self.facts.inside_multiplexer
			&& self.facts.resize_in_place != Some(true)
		{
			self.resolve_resize_anchor(now, size, None);
			return;
		}
		// Tags are never expired by age: a reply has no lifetime guarantee,
		// and freeing a column while its reply may still arrive would let
		// that reply match a newer tag on the reused column. Dead tags only
		// accumulate from genuinely dropped replies; a terminal that drops
		// enough of them to exhaust the span earns the timeout-only fallback.
		// Park a distinct column for this request so its reply is
		// self-identifying, then return the cursor to column 1 immediately:
		// the reply snapshots the column when the terminal processes the CSI
		// 6n, but a cursor RESTING on a nonzero column would reflow onto a
		// later visual row if a direct terminal's width later shrank below
		// it, corrupting the next probe's cursor-relative math. Columns 1-16
		// are never used as tags: column 1 cannot be told apart from a
		// spurious or clamped reply, and modified F3 keys encode as CSI
		// 1;<mod>R with modifier codes 2-16, which is byte-identical to a CPR
		// for row 1 on those columns. A column may not be reused while its
		// tag is live — the old request's delayed reply would be attributed
		// to the new epoch — so scan for a free slot.
		let resize = &mut self.resize;
		let span = CPR_TAG_MAX_SPAN.min(size.columns.saturating_sub(CPR_TAG_FIRST_COLUMN - 1));
		if span >= 4 {
			for index in 0..span {
				let candidate = CPR_TAG_FIRST_COLUMN + (resize.cpr_probe_seq + index) % span;
				if resize
					.cpr_column_tags
					.iter()
					.any(|entry| entry.0 == candidate)
				{
					continue;
				}
				resize.cpr_probe_seq += index + 1;
				resize
					.cpr_column_tags
					.push((candidate, resize.geometry_epoch));
				emit(device, |b| {
					b.column(candidate).query_cursor_position().column(1);
				});
				return;
			}
		}
		// Degenerate span or full occupancy: an untagged reply could never be
		// attributed, so no DSR is sent at all; the timeout anchors
		// conservatively on its own.
	}

	/// Anchor the settled post-resize repaint. `reported_row` is the 0-based
	/// CPR row of the parked cursor (`None` = probe timed out). Direct
	/// terminals use `min(reported - park_offset, height - stale_rows)`:
	/// they track the cursor exactly through width rewrap, and the second
	/// bound reconstructs height-shrink scrollback pushes that leave the
	/// cursor behind (kitty clamps the cursor instead of scrolling it) —
	/// bottom-preserving resize guarantees the stale viewport ends on the
	/// last screen row whenever a push happened; validated against kitty's
	/// real core in resize-anchor-recovery.test.ts. Multiplexers clip on
	/// height changes (though they reflow on width changes), so that bound
	/// never applies: monotonic shrinks use the deterministic clip model
	/// below, everything else trusts the CPR directly.
	fn resolve_resize_anchor(&mut self, now: Millis, size: Size, reported_row: Option<u32>) {
		let Some(probe) = self.resize.probe.take() else {
			return;
		};
		self.resize.in_place_active = false;
		// Column tags stay live across resolves: their replies are
		// self-identifying and discarded by tag whenever they arrive.
		let width = size.columns;
		let height = i64::from(size.rows);
		let viewport_top = i64::from(self.provider_viewport_top);
		let previous_height = i64::from(self.previous_height);
		let burst_pull = i64::from(self.resize.burst_pull);
		let burst_grew = self.resize.burst_grew;
		let stale_rows = reflowed_row_count(&probe.window, 0, probe.window.len(), width);
		let park_rows = reflowed_row_count(&probe.window, 0, probe.offset as usize, width);
		let reported_top = reported_row.map_or(viewport_top, |row| i64::from(row) - park_rows);
		let top = if self.facts.inside_multiplexer {
			if reported_row.is_some() {
				// tmux can grow its grid before SIGWINCH reaches the app. A
				// queued retirement frame can then overwrite pulled-down
				// history at the old coordinates and park the cursor there. If
				// a previously full viewport no longer reaches the bottom,
				// replay its semantic history instead of trusting that
				// potentially damaged physical copy. Ordinary grows with an
				// intact bottom anchor still need no replay or additional
				// wait.
				if self.resize_scrollback == ResizeScrollback::Rebuild
					&& self.facts.multiplexer.grows_before_sigwinch
					&& !self.resize_repaints_in_place()
					&& self
						.provider
						.is_some_and(|provider| provider.history_replay)
					&& burst_grew
					&& viewport_top + probe.window.len() as i64 >= previous_height
					&& reported_top + stale_rows < height
				{
					self.prepare_forced_render(true);
				}
				// The parked cursor's reply is exact under multiplexer
				// clipping: discards leave the cursor in place, pushes only
				// occur after everything below it is discarded (the bottom row
				// IS the attached position), and grow pull-down rides it down.
				// It therefore also reflects intermediate geometries that
				// SIGWINCH coalescing hid from the burst tracker, and always
				// outranks the clip model. The `height - stale_rows` bound
				// must NOT apply here: it encodes bottom-preserving rewrap,
				// but a multiplexer shrink may have discarded stale rows below
				// the cursor instead of pushing the top ones. Frame-size
				// clamping happens when the settled plan frame is emitted.
				reported_top.max(0)
			} else if height < previous_height && !burst_grew {
				// Last resort after the retry: model the clip
				// deterministically from the saved parked cursor. Rows
				// strictly below the cursor are discarded first (even
				// non-blank ones — measured against real tmux), and only the
				// remainder of the shrink pushes top rows into scrollback;
				// across an observed burst the totals telescope from pre-burst
				// state. SIGWINCH coalescing can hide a grow from this model,
				// which is why a reply always wins above.
				let parked_row = viewport_top + park_rows;
				let shrink = previous_height - height;
				let discarded_below = shrink.min((previous_height - 1 - parked_row).max(0));
				let pushed = (shrink - discarded_below).max(0);
				(viewport_top - pushed).max(0)
			} else {
				// CPR-less grow or reversed burst: the pre-resize top is
				// stale-low, every grow step already pulled scrollback down.
				// Anchor at the conservative upper bound — pull never exceeds
				// the burst's accumulated growth, and pushes/discards only
				// lower the top. Exact when scrollback covers the pull; when
				// it does not, the repaint lands below the real viewport and
				// leaves stale rows above rather than overwriting committed
				// ones.
				(viewport_top + burst_pull).max(0)
			}
		} else {
			// Direct terminals rewrap bottom-preserving: with `stale_rows`
			// stale rows on screen the viewport top cannot exceed
			// `height - stale_rows` whenever a push happened, so the bound
			// reconstructs height-shrink pushes that leave the cursor behind
			// (kitty clamps the cursor instead of scrolling it). A CPR-less
			// grow is stale-low like the multiplexer case — grow pull-down
			// moved the real viewport — so it anchors at the accumulated pull
			// bound, still under the clamp.
			let fallback_top = if reported_row.is_none() && burst_grew {
				viewport_top + burst_pull
			} else {
				reported_top
			};
			fallback_top.min(height - stale_rows).max(0)
		};
		log::debug!(
			"resize anchor: size={width}x{height} cpr={reported_row:?} park={} stale={stale_rows} \
			 old={viewport_top} top={top}",
			probe.offset,
		);
		self.provider_viewport_top = top.min((height - 1).max(0)) as u32;
		// Resolved geometry invalidates the replay offset with the old
		// anchor; the forced repaint recomputes it (usually zero).
		self.provider_viewport_pad_top = 0;
		self.force_viewport_repaint_on_next_render = true;
		self.request_render(now, RenderRequest { force: true, ..RenderRequest::default() });
	}

	/// Re-offer finalized history once after a settled resize.
	///
	/// Append mode leaves the terminal's prior copy in place and writes a
	/// current-width copy below it. Rebuild mode routes through the
	/// destructive reset latch so ED3 removes stale history before the same
	/// replay.
	///
	/// The append replay only exists to refresh width-shredded scrollback: a
	/// width change leaves the terminal's committed history wrapped at the
	/// old width, so the copy below it is the intended fresh current-width
	/// render. A height-only change reflows nothing (the terminal merely
	/// pulls rows back out of scrollback), so replaying would write an
	/// identical duplicate — the editor/status chrome included — below the
	/// retained copy. Skip it.
	///
	/// Both gates key on the whole coalesced burst, not the net change: the
	/// terminal reflowed the normal buffer at every intermediate geometry,
	/// so a drag that ends where it started (80 → 60 → 80) has still
	/// rewrapped retained history and pushed unerased live rows into it.
	/// Comparing only the settled size against the committed one would skip
	/// the refresh and leave those stale copies stacked above the repainted
	/// viewport.
	pub(super) fn prepare_resize_replay(&mut self, size: Size) {
		let width_changed = self.resize.burst_width_changed || size.columns != self.previous_width;
		let resized = self.resize.burst_resized || width_changed || size.rows != self.previous_height;
		if !self.has_ever_rendered
			|| !resized
			|| self.resize.replay_size == Some(size)
			|| self.resize_scrollback == ResizeScrollback::Preserve
			// In-place resizes (Warp) repaint the settled viewport once the
			// drag goes quiet: no alt borrow, and no ED3 rewrap or history
			// replay, so a drag can neither loop on its own echo nor flash
			// destructive repaints.
			|| self.resize_repaints_in_place()
		{
			return;
		}
		if !self
			.provider
			.is_some_and(|provider| provider.history_replay)
		{
			return;
		}
		self.resize.replay_size = Some(size);
		if self.clear_scrollback_on_next_render {
			self.force_viewport_repaint_on_next_render = true;
			return;
		}
		// A height-only settled resize rewraps nothing — rewrap is a width
		// change everywhere. A pure height grow pulls committed scrollback
		// down without polluting a copy, so the rebuild (an ED3 plus a full
		// ledger replay) would be a destructive repaint that buys nothing.
		// `rebuild` still refreshes on a burst shrink (the multiplexer pushes
		// live pane rows into its scrollback; the destructive refresh is the
		// only purge) and on a host that repaints its own grid (ConPTY's
		// stale re-emission is untrusted).
		if self.resize_scrollback == ResizeScrollback::Rebuild {
			// Every destructive cause warrants a rebuild: a burst shrink can
			// push live rows into history (tmux discards rows below the
			// cursor, then pushes rows above it; a later grow cannot undo
			// that clipping or the provider's retirement), and ConPTY can
			// repaint its own stale grid.
			if !width_changed && !self.facts.conpty && !self.resize.burst_shrank {
				return;
			}
			self.prepare_forced_render(true);
			return;
		}
		if !width_changed {
			return;
		}
		self.request_history_replay();
		self.force_viewport_repaint_on_next_render = true;
	}
}

/// Relative vertical move: negative is up, positive is down.
fn emit_relative_move(b: &mut Batch<'_>, rows: i64) {
	if rows < 0 {
		b.up(rows.unsigned_abs() as u32);
	} else {
		b.down(rows as u32);
	}
}
