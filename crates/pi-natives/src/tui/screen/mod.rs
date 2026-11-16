//! Screen engine: the stateful row renderer.
//!
//! The JS host composes rows (frame provider, overlays, image passes); this
//! module owns everything between those rows and the terminal:
//!
//! - [`frame`]: the normal-buffer paint transaction (history append/replay,
//!   destructive reset, row diffing, row moves, cursor parking).
//! - [`alt`]: the frame entry point (`begin_frame`), alternate-screen and
//!   mouse-tracking transitions, and alternate-buffer paints (fullscreen
//!   overlays and the resize borrow).
//! - [`resize`]: resize transactions (alt borrow, in-place path, settle, CPR
//!   anchor probe) and the native-surface / stop handoffs that unwind them.
//! - [`schedule`]: render scheduling (forced vs ordinary, cadence, adaptive
//!   backpressure, output backlog gate, Ghostty first-image delay).
//!
//! The primitives ([`prepare`], [`sgr`], [`text`], [`images`], [`moves`]) are
//! pure; all state lives in [`Screen`].
//!
//! # Host protocol
//!
//! The engine is sans-IO for time: every call carries the host clock, and
//! [`Screen::deadline`] names the next instant [`Screen::tick`] has work.
//! `tick` pushes [`Event::Render`] when a frame is due; the host answers
//! with [`Screen::begin_frame`], composes what it names, and presents it
//! ([`Screen::present_plan`], [`Screen::present_alt`],
//! [`Screen::present_resize`]). Effects only the host can perform (its frame
//! provider's history replay, frame-text notifications) accumulate in
//! [`HostRequests`], drained with [`Screen::take_host_requests`] after every
//! call and applied before the host composes.
//!
//! The host's inline-image budget is shared state
//! ([`Screen::attach_image_budget`]): the screen starts its alternate-screen
//! lifecycles, drops its transmit tracking before a destructive reset,
//! drains its purges and transmits into every paint, and reads its
//! placement heights.

mod alt;
mod frame;
pub(crate) mod images;
pub(crate) mod moves;
pub(crate) mod overlay;
pub(crate) mod prepare;
mod resize;
mod schedule;
pub(crate) mod sgr;
pub(crate) mod text;

use std::{mem, rc::Rc};

use self::{
	frame::{Placements, RowPainter},
	prepare::{PreparedLine, Preparer},
	resize::ResizeState,
	schedule::Schedule,
};
use super::{
	budget::{FrameImages, SharedBudget},
	types::{Event, Facts, ImageProtocol, Millis, MouseTracking, ResizeScrollback, Size},
};
use crate::term::{Batch, Device, mode};

/// A render request from the host (`requestRender` / `renderNow` in pi-tui).
#[derive(Clone, Copy, Debug, Default)]
pub struct RenderRequest {
	/// A forced frame: rewrites the viewport even when the diff believes
	/// nothing changed, and bypasses the frame cadence.
	pub force:            bool,
	/// Destructive reset: erase native history and repaint from row zero.
	/// Honored with `force` only.
	pub clear_scrollback: bool,
	/// Terminal input arrived: arm the input latch. Without `force` this
	/// requests no frame; the consumers' own requests follow and ride the
	/// input cadence.
	pub input:            bool,
	/// Start the input grace window (Ctrl+C / Esc). Like `input`, requests
	/// no frame by itself.
	pub input_grace:      bool,
	/// A forced frame the host paints in the same turn (`renderNow`,
	/// `resetDisplay`): it ticks right after this call instead of waiting
	/// for its timer. The screen treats it as `force`.
	pub immediate:        bool,
}

/// What the host wants on screen for the frame it is about to compose.
#[derive(Clone, Copy, Debug)]
pub struct FrameView {
	/// The topmost visible overlay is fullscreen: paint it on the alternate
	/// buffer.
	pub alt:   bool,
	/// Mouse reporting wanted for this frame.
	pub mouse: MouseTracking,
}

/// What the host's frame provider can do.
#[derive(Clone, Copy, Debug)]
pub struct ProviderFacts {
	/// The provider implements `beginHistoryReplay`.
	pub history_replay: bool,
}

/// Effects only the host can perform, raised by screen logic and drained
/// with [`Screen::take_host_requests`] after every call. The engine queues
/// them as events ahead of any [`Event::Render`].
#[derive(Clone, Debug, Default)]
pub struct HostRequests {
	/// Call the frame provider's `beginHistoryReplay()` before composing the
	/// next plan frame ([`Event::HistoryReplay`]).
	pub history_replay: bool,
	/// Watched texts a frame write emitted ([`Event::FrameText`]), once per
	/// text per write, in write order.
	pub frame_texts:    Vec<String>,
}

/// The mutable viewport in composer rows (`getMutableViewport` in pi-tui).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MutableViewport {
	pub top:    i32,
	pub length: u32,
}

/// Hardware cursor of the last paint, for debug inspection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DebugCursor {
	pub x:       u32,
	pub y:       u32,
	pub visible: bool,
}

/// The last painted frame, for debug inspection (`getDebugPaint` in pi-tui).
#[derive(Clone, Debug)]
pub struct DebugPaint {
	pub lines:      Vec<String>,
	pub window_top: u32,
	pub alt_screen: bool,
	pub cursor:     Option<DebugCursor>,
}

/// Position and visibility of the hardware cursor as last painted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct HardwareCursor {
	row:     u32,
	col:     u32,
	visible: bool,
}

/// Last painted frame retained for [`Screen::debug_paint`]. The row vector
/// is reused across frames, so recording costs reference-count bumps only.
#[derive(Default)]
struct DebugState {
	painted:    bool,
	lines:      Vec<Rc<str>>,
	window_top: u32,
	alt_screen: bool,
	cursor:     Option<HardwareCursor>,
}

/// An alternate-screen exit held for the frame that replaces the buffer.
#[derive(Clone, Copy, Debug)]
struct AltExit {
	/// Release mouse reporting before the switch.
	mouse_off: bool,
	/// Restore mouse reporting a fullscreen overlay had disabled.
	mouse_on:  bool,
}

impl AltExit {
	fn emit(self, b: &mut Batch<'_>) {
		if self.mouse_off {
			emit_mouse_tracking_off(b);
		}
		if self.mouse_on {
			emit_mouse_tracking_on(b);
		}
		b.reset_mode(mode::ALT_SCREEN, false);
	}
}

// Mouse reporting is scoped to fullscreen overlays that opt into pointer
// interaction, plus the opt-in normal-buffer click capture (`tui.mouse`).
// 1000h = button click tracking, 1003h = any-motion tracking for hover
// targets, and 1006h = SGR extended coordinates past column/row 223.
// Selection-first surfaces leave these modes disabled so the terminal retains
// native text selection.
fn emit_mouse_tracking_on(b: &mut Batch<'_>) {
	b.set_mode(mode::MOUSE_CLICKS, false)
		.set_mode(mode::MOUSE_MOTION, false)
		.set_mode(mode::MOUSE_SGR, false);
}

fn emit_mouse_tracking_off(b: &mut Batch<'_>) {
	b.reset_mode(mode::MOUSE_SGR, false)
		.reset_mode(mode::MOUSE_MOTION, false)
		.reset_mode(mode::MOUSE_CLICKS, false);
}

/// Write one batch. The pending-byte count the device returns is the
/// session's concern (stall watchdog, [`Event::Disconnected`]); the screen
/// receives the backlog through [`Screen::tick`]. A dead device does not run
/// `fill`, so bookkeeping the caller must keep stays outside the closure.
fn emit(device: &mut Device, fill: impl FnOnce(&mut Batch<'_>)) {
	device.emit(fill);
}

/// The stateful renderer: frame painting, resize transactions, and render
/// scheduling. See the [module docs](self) for the host protocol.
pub struct Screen {
	facts:                Facts,
	image_protocol:       Option<ImageProtocol>,
	resize_scrollback:    ResizeScrollback,
	/// Whether DEC 2026 synchronized-output wrappers are emitted around
	/// paints. Starts from conservative terminal/env detection and is
	/// reconciled at runtime against the terminal's DECRQM mode-2026 report.
	synchronized_output:  bool,
	show_hardware_cursor: bool,
	provider:             Option<ProviderFacts>,
	host_requests:        HostRequests,
	/// The host's inline-image budget, once attached.
	budget:               Option<SharedBudget>,

	preparer: Preparer,
	painter:  RowPainter,

	accepted_history_batch_id: u32,
	/// Screen row where the provider's mutable viewport begins (0-based);
	/// rows above it hold history still visible on the physical screen.
	provider_viewport_top: u32,
	/// Net composer-space offset of the published hit-test origin behind the
	/// painted top, from the last paint: replay-replaced rows minus viewport
	/// rows the paint prepended for a short viewport. Negative while
	/// prepended blanks outweigh replaced rows; zero on ordinary frames.
	provider_viewport_pad_top: i32,
	/// Whether native history holds rows the provider committed since the
	/// last destructive reset. Only paints write history and only a
	/// destructive reset erases it; an `append` resize replay keeps the rows
	/// it replays beneath.
	provider_history_written: bool,
	/// Viewport-relative row of the hardware cursor after the last normal
	/// paint (0 = parked at the viewport top). A resize reflows the normal
	/// buffer before the app hears about it; terminals keep the cursor
	/// attached to its logical line through rewrap, so a DSR round trip
	/// against this parked cursor recovers the reflowed viewport anchor (see
	/// `resolve_resize_anchor`).
	parked_viewport_offset: u32,
	/// Rows painted by the previous plan frame, for row diffing. The
	/// structured sidecar owns classification/coalescing results for reuse;
	/// `provider_window` remains the exact normalized string projection used
	/// by the differential comparison and resize accounting.
	provider_window: Vec<Rc<str>>,
	provider_rows: Vec<Rc<PreparedLine>>,
	previous_frame_length: u32,
	previous_width: u32,
	previous_height: u32,
	/// Normal-buffer cursor row, retained while the alternate buffer is
	/// active.
	hardware_cursor_row: u32,
	/// Current buffer's cursor paint/dedupe state.
	hardware_cursor: Option<HardwareCursor>,
	normal_placements: Placements,
	alt_placements: Placements,
	clear_scrollback_on_next_render: bool,
	/// Consumed by the next frame: a user-driven redraw gesture
	/// (`resetDisplay`, a forced render request) that must rewrite the
	/// viewport even when the diff believes nothing changed.
	force_viewport_repaint_on_next_render: bool,
	has_ever_rendered: bool,
	stopped: bool,
	full_redraws: u32,
	debug: DebugState,
	debug_next_window_top: u32,

	// Transient alternate-screen state for a fullscreen overlay. While
	// active, the engine paints only the modal on the alt buffer and leaves
	// every normal-screen accounting field untouched, so exiting reconciles
	// cleanly against the terminal-restored normal screen.
	// `alt_previous_lines` is the last alt frame, diffed row by row against
	// the next one.
	alt_active:         bool,
	mouse_tracking:     MouseTracking,
	alt_previous_lines: Vec<Rc<str>>,
	alt_rows:           Vec<Rc<PreparedLine>>,
	alt_enter_size:     Size,
	/// Holds an alternate-screen exit until its replacement full paint can
	/// emit it atomically. It must survive a deferred Ghostty image frame.
	pending_alt_exit:   Option<AltExit>,

	resize:   ResizeState,
	schedule: Schedule,

	/// Frames go to a Tern Surface Protocol surface instead of rows.
	native_live: bool,
	/// Holds the first paint while the TSP `hello` probe is outstanding, so
	/// a TSP terminal never sees a row paint it would have to erase.
	native_hold: Option<Millis>,
}

impl Screen {
	/// Build the renderer from the host's environment facts.
	pub fn new(facts: &Facts) -> Self {
		Self {
			image_protocol: facts.image_protocol,
			resize_scrollback: facts.resize_scrollback,
			synchronized_output: facts.synchronized_output,
			show_hardware_cursor: facts.show_hardware_cursor,
			provider: None,
			host_requests: HostRequests::default(),
			budget: None,
			preparer: Preparer::new(facts.image_protocol, facts.sgr_coalesce),
			painter: RowPainter::new(facts.tmux_passthrough),
			accepted_history_batch_id: 0,
			provider_viewport_top: 0,
			provider_viewport_pad_top: 0,
			provider_history_written: false,
			parked_viewport_offset: 0,
			provider_window: Vec::new(),
			provider_rows: Vec::new(),
			previous_frame_length: 0,
			previous_width: 0,
			previous_height: 0,
			hardware_cursor_row: 0,
			hardware_cursor: None,
			normal_placements: Placements::default(),
			alt_placements: Placements::default(),
			clear_scrollback_on_next_render: false,
			force_viewport_repaint_on_next_render: false,
			has_ever_rendered: false,
			stopped: false,
			full_redraws: 0,
			debug: DebugState::default(),
			debug_next_window_top: 0,
			alt_active: false,
			mouse_tracking: MouseTracking::Off,
			alt_previous_lines: Vec::new(),
			alt_rows: Vec::new(),
			alt_enter_size: Size { columns: 0, rows: 0 },
			pending_alt_exit: None,
			resize: ResizeState::default(),
			schedule: Schedule::new(facts.frame_interval_ms),
			native_live: false,
			native_hold: None,
			facts: facts.clone(),
		}
	}

	/// Begin (or restart) a session: drop pending render work from the
	/// previous one, open the Ghostty first-image window, and hide the
	/// hardware cursor. Painted-screen accounting survives a stop/start
	/// cycle. The host then requests its first forced render.
	pub fn start(&mut self, now: Millis, device: &mut Device) {
		self.schedule.reset();
		self.stopped = false;
		self.debug.painted = false;
		self.schedule.open_ghostty_window(now);
		emit(device, |b| {
			b.reset_mode(mode::CURSOR_VISIBLE, true);
		});
		self.record_hardware_cursor_hidden();
	}

	/// Fire every timer due at `now`: resize settle, anchor-probe timeout,
	/// the native probe hold, the Ghostty first-image delay, and the render
	/// schedule. Pushes [`Event::Render`] (at most once) when a frame is
	/// due; a frame gated by the output backlog resumes from a later tick
	/// once `pending_output` has drained.
	pub fn tick(
		&mut self,
		now: Millis,
		size: Size,
		pending_output: f64,
		device: &mut Device,
		out: &mut Vec<Event>,
	) {
		if self.stopped {
			return;
		}
		self.resume_after_output_drain(now, pending_output);
		if self.native_hold.is_some_and(|deadline| now >= deadline) {
			self.native_hold = None;
			if !self.native_live {
				self.request_render(now, RenderRequest { force: true, ..RenderRequest::default() });
			}
		}
		self.fire_resize_timers(now, size, device);
		self.run_due_renders(now, pending_output, out);
	}

	/// The earliest instant [`tick`](Self::tick) has work, or `None` while
	/// idle. A deadline at or before the host's clock means "tick now".
	pub fn deadline(&self) -> Option<Millis> {
		if self.stopped {
			return None;
		}
		[self.native_hold, self.resize.deadline(), self.schedule.deadline()]
			.into_iter()
			.flatten()
			.reduce(Millis::min)
	}

	/// Take the host-side effects raised since the last call.
	pub fn take_host_requests(&mut self) -> HostRequests {
		mem::take(&mut self.host_requests)
	}

	/// Install (or remove) the host's frame provider (`setFrameProvider` in
	/// pi-tui): the painted window no longer describes what the new provider
	/// composes, so drop it and force a repaint.
	pub fn set_frame_provider(&mut self, now: Millis, provider: Option<ProviderFacts>) {
		self.provider = provider;
		self.provider_window.clear();
		self.provider_rows.clear();
		self.resize.replay_size = None;
		self.request_render(now, RenderRequest { force: true, ..RenderRequest::default() });
	}

	/// Texts to report when a frame write emits a row containing them
	/// ([`HostRequests::frame_texts`]). An empty list costs nothing per row.
	pub fn set_frame_text_watches(&mut self, texts: Vec<String>) {
		self.painter.set_watches(texts);
	}

	/// The inline image protocol rows are classified and painted for.
	pub const fn image_protocol(&self) -> Option<ImageProtocol> {
		self.image_protocol
	}

	/// Switch the inline image protocol rows are classified and painted for.
	pub const fn set_image_protocol(&mut self, protocol: Option<ImageProtocol>) {
		self.image_protocol = protocol;
		self.preparer.set_image_protocol(protocol);
	}

	/// Cell size in pixels as reported by the terminal (`CSI 6 ; h ; w t` /
	/// iTerm2 `ReportCellSize`), used to crop SIXEL rasters clipped by the
	/// viewport top.
	pub const fn set_cell_size(&mut self, _width_px: u32, height_px: u32) {
		self.painter.set_cell_height(height_px);
	}

	/// Whether the focused component's cursor marker shows the hardware
	/// cursor.
	pub const fn show_hardware_cursor(&self) -> bool {
		self.show_hardware_cursor
	}

	/// Hide the hardware cursor on the host's behalf (overlay open/close)
	/// and record it, so the next alternate-buffer frame knows to place the
	/// cursor again. `force` writes even when the device believes it hidden.
	pub fn hide_cursor(&mut self, force: bool, device: &mut Device) {
		emit(device, |b| {
			b.reset_mode(mode::CURSOR_VISIBLE, !force);
		});
		self.record_hardware_cursor_hidden();
	}

	/// Toggle the hardware cursor; hiding takes effect at once, showing with
	/// the next frame.
	pub fn set_show_hardware_cursor(&mut self, now: Millis, enabled: bool, device: &mut Device) {
		if self.show_hardware_cursor == enabled {
			return;
		}
		self.show_hardware_cursor = enabled;
		if !enabled {
			emit(device, |b| {
				b.reset_mode(mode::CURSOR_VISIBLE, true);
			});
			self.record_hardware_cursor_hidden();
		}
		self.request_render(now, RenderRequest::default());
	}

	/// How settled resizes refresh native scrollback.
	pub const fn resize_scrollback(&self) -> ResizeScrollback {
		self.resize_scrollback
	}

	/// Set how settled resizes refresh native scrollback.
	pub const fn set_resize_scrollback(&mut self, mode: ResizeScrollback) {
		self.resize_scrollback = mode;
	}

	/// Floor between ordinary frames (the `tui.maxFps` ceiling).
	pub const fn set_frame_interval(&mut self, interval_ms: Millis) {
		self.schedule.frame_interval_ms = interval_ms;
	}

	/// Screen row offset of the next plan frame's first row within the
	/// host's composed document, for [`debug_paint`](Self::debug_paint).
	/// Consumed by that frame; provider frames leave it at zero.
	pub const fn set_debug_window_top(&mut self, top: u32) {
		self.debug_next_window_top = top;
	}

	/// Share the host's inline-image budget: frames drain it and alt entries
	/// start its alternate-screen lifecycle.
	pub fn attach_image_budget(&mut self, budget: SharedBudget) {
		self.budget = Some(budget);
	}

	/// Schedule the redraw the image budget asked for (a demotion, a
	/// relaxed threshold, a cap change, an image encode landing).
	pub fn apply_budget_render_request(&mut self, now: Millis) {
		let requested = self
			.budget
			.as_ref()
			.is_some_and(|budget| budget.borrow_mut().take_render_request());
		if requested {
			self.request_render(now, RenderRequest::default());
		}
	}

	/// Delete every tracked Kitty image from the terminal graphics store
	/// (`clearInlineImages` in pi-tui): the image budget's transmitted ids,
	/// whose tracking it drops. Live placements are forgotten with them.
	pub fn clear_inline_images(&mut self, device: &mut Device) {
		if self.stopped {
			return;
		}
		let ids = self
			.budget
			.as_ref()
			.map_or_default(|budget| budget.borrow_mut().take_all_transmitted_ids());
		self.normal_placements.clear();
		self.alt_placements.clear();
		if self.image_protocol != Some(ImageProtocol::Kitty) || ids.is_empty() {
			return;
		}
		let tmux = self.painter.tmux();
		emit(device, |b| {
			for &id in &ids {
				b.text(&images::encode_kitty_delete_image(id, tmux));
			}
		});
	}

	/// `?1049h` was written: the alternate buffer's graphics store and split
	/// start empty.
	fn begin_alt_image_lifecycle(&self) {
		if let Some(budget) = &self.budget {
			budget.borrow_mut().begin_alt_screen_lifecycle();
		}
	}

	/// The image budget holds data transmits not yet written for the surface
	/// its last pass composed.
	fn image_transmits_pending(&self) -> bool {
		self
			.budget
			.as_ref()
			.is_some_and(|budget| budget.borrow().has_pending_transmits())
	}

	/// What the frame about to be painted takes from the image budget;
	/// `reset`: a destructive reset repaints it.
	fn drain_frame_images(&self, reset: bool) -> FrameImages {
		let reset = reset && self.image_protocol == Some(ImageProtocol::Kitty);
		self
			.budget
			.as_ref()
			.map_or_default(|budget| budget.borrow_mut().drain_frame(reset))
	}

	/// A DECRPM report routed from the session. A confirmed report for mode
	/// 2026 is authoritative: enable synchronized output when the terminal
	/// reports support and disable it for an explicit unsupported status. A
	/// DA1 sentinel without a DECRPM reply is inconclusive: many terminals
	/// implement synchronized output without implementing DECRQM, so retain
	/// the statically detected default instead of exposing destructive full
	/// paints. An explicit user opt-out/force still wins, so skip every
	/// probe result in that case (#1765 covers the static env opt-out).
	pub fn note_private_mode(
		&mut self,
		mode: u32,
		supported: bool,
		confirmed: bool,
		status: Option<u32>,
	) {
		if mode != mode::SYNCHRONIZED_OUTPUT || !confirmed {
			return;
		}
		if self.facts.synchronized_output_override {
			return;
		}
		// Some multiplexer VTEs (Herdr's Ghostty pane) honor DEC 2026 even
		// when DECRQM is unanswered or reports unrecognized (status 0). Other
		// confirmed unsupported reports still disable: status 4 is
		// permanently reset, and a report without a status is a definitive
		// unsupported from a terminal that does not distinguish DECRPM codes.
		if !supported && status == Some(0) && self.facts.honors_synchronized_output {
			return;
		}
		self.synchronized_output = supported;
	}

	/// Whether DEC 2026 synchronized-output wrappers are currently emitted
	/// around paints.
	pub const fn synchronized_output(&self) -> bool {
		self.synchronized_output
	}

	/// Number of full alternate-buffer repaints so far.
	pub const fn full_redraws(&self) -> u32 {
		self.full_redraws
	}

	/// Cost in milliseconds of the most recently completed frame, from
	/// [`begin_frame`](Self::begin_frame) to its presentation.
	///
	/// Animation components use this to apply proportional backpressure
	/// after their render request is asynchronously composed and written.
	pub const fn last_frame_cost_ms(&self) -> Millis {
		self.schedule.last_frame_cost_ms
	}

	/// The screen region the last plan frame painted mutable rows into:
	/// where it begins plus its row count. Inline click targets are indexed
	/// into this window (`screen_row - top`). Empty while the alt screen
	/// owns the display, while a resize transaction is settling, and while
	/// a Ghostty image paint is deferred — the painted rows predate the
	/// latest spans in all three cases, so hits would map to unrelated old
	/// rows. The origin is in composer rows: a replay paint replaces leading
	/// composer blanks with history rows and prepends blanks for a short
	/// viewport, so the painted top is backed out by that net pad.
	pub fn mutable_viewport(&self) -> MutableViewport {
		if self.alt_active
			|| self.resize.alt_active
			|| self.resize.probe.is_some()
			|| self.resize.in_place_active
			|| self.schedule.ghostty_deferred()
		{
			return MutableViewport::default();
		}
		MutableViewport {
			top:    self.provider_viewport_top as i32 - self.provider_viewport_pad_top,
			length: self.provider_window.len() as u32,
		}
	}

	/// Rows of native history the last paint left on screen above a mutable
	/// viewport that reached the bottom row, or `None` when that paint left
	/// rows free below it (or none happened, or a destructive reset will
	/// repaint from row zero). Rows above a bottom-reaching viewport may
	/// already sit in native scrollback, which a later shrink cannot pull
	/// back down.
	pub fn filled_history_rows(&self, size: Size) -> Option<u32> {
		if !self.has_ever_rendered || self.clear_scrollback_on_next_render {
			return None;
		}
		let height = size.rows;
		let window = self.provider_window.len() as u32;
		if window == 0 || self.provider_viewport_top + window < height {
			return None;
		}
		Some(self.provider_viewport_top.min(height))
	}

	/// Whether native history holds rows the frame provider committed since
	/// the last destructive reset.
	pub const fn has_provider_history(&self) -> bool {
		self.provider_history_written && !self.clear_scrollback_on_next_render
	}

	/// The last painted frame, or `None` before the first paint of this
	/// session.
	pub fn debug_paint(&self) -> Option<DebugPaint> {
		if !self.debug.painted {
			return None;
		}
		Some(DebugPaint {
			lines:      self
				.debug
				.lines
				.iter()
				.map(|line| String::from(&**line))
				.collect(),
			window_top: self.debug.window_top,
			alt_screen: self.debug.alt_screen,
			cursor:     self.debug.cursor.map(|cursor| DebugCursor {
				x:       cursor.col,
				y:       cursor.row,
				visible: cursor.visible,
			}),
		})
	}

	fn record_debug_paint(
		&mut self,
		lines: &[Rc<str>],
		window_top: u32,
		alt_screen: bool,
		cursor: Option<HardwareCursor>,
	) {
		self.debug.painted = true;
		self.debug.lines.clear();
		self.debug.lines.extend(lines.iter().cloned());
		self.debug.window_top = window_top;
		self.debug.alt_screen = alt_screen;
		self.debug.cursor = cursor;
	}

	/// Raise [`HostRequests::history_replay`] when the provider can replay.
	fn request_history_replay(&mut self) {
		if self
			.provider
			.is_some_and(|provider| provider.history_replay)
		{
			self.host_requests.history_replay = true;
		}
	}

	/// Transition mouse reporting, emitting only the sequences a change
	/// needs.
	fn set_mouse_tracking(&mut self, state: MouseTracking, device: &mut Device) {
		if state == self.mouse_tracking {
			return;
		}
		let was_off = self.mouse_tracking == MouseTracking::Off;
		self.mouse_tracking = state;
		if state == MouseTracking::Off {
			if !was_off {
				emit(device, emit_mouse_tracking_off);
			}
			return;
		}
		// Inline and fullscreen reporting are the same bytes: moving between
		// live modes needs no emission, only entering from off does.
		if was_off {
			emit(device, emit_mouse_tracking_on);
		}
	}

	fn target_hardware_cursor(
		&self,
		row: u32,
		col: u32,
		total_lines: u32,
	) -> Option<HardwareCursor> {
		if total_lines == 0 {
			return None;
		}
		Some(HardwareCursor {
			row: row.min(total_lines - 1),
			col,
			visible: self.show_hardware_cursor,
		})
	}

	const fn record_hardware_cursor(&mut self, state: HardwareCursor) {
		self.hardware_cursor_row = state.row;
		self.hardware_cursor = Some(state);
	}

	const fn record_hardware_cursor_hidden(&mut self) {
		if let Some(state) = &mut self.hardware_cursor {
			state.visible = false;
		}
	}

	const fn forget_hardware_cursor(&mut self) {
		self.hardware_cursor = None;
	}
}
