//! DEC private-mode negotiation (DECRQM/DECRPM) and what it enables:
//! in-band resize geometry (DEC 2048), bracketed-paste reassertion (DEC 2004),
//! and xterm scroll-to-bottom suppression (?1010/?1011).

use super::{Session, probe::Owner};
use crate::{
	term::{Device, mode},
	tui::types::{Event, Millis, Size},
};

/// Xterm scroll-to-bottom modes, disabled while the session owns the TTY so
/// typing in the editor does not force a reader scrolled into native history
/// back to the tail.
const XTERM_SCROLL_TO_BOTTOM_MODES: [u32; 2] = [mode::SCROLL_ON_OUTPUT, mode::SCROLL_ON_KEY];

/// DEC private modes probed at input attach, in order. 2026 (synchronized
/// output) gates the renderer's begin/end markers; 2048 (in-band resize) is
/// enabled only after the terminal confirms support; 2031 (appearance change
/// notifications) drives mid-session theme tracking.
///
/// 2004 (bracketed paste) is queried only to confirm the terminal brackets
/// pastes; once confirmed, the input parser's unbracketed raw-paste heuristic
/// consults the host's stall probe so keystrokes an event-loop stall batches
/// into one read stay keys (#12540) while input-method commits still land as
/// one paste (#13344).
///
/// Each probe rides the shared DA1 sentinel, so terminals that ignore DECRQM
/// resolve as unsupported when the DA1 reply arrives.
pub(super) const PROBED_MODES: [u32; 6] = [
	mode::SYNCHRONIZED_OUTPUT,
	mode::IN_BAND_RESIZE,
	mode::APPEARANCE_REPORTS,
	mode::BRACKETED_PASTE,
	mode::SCROLL_ON_OUTPUT,
	mode::SCROLL_ON_KEY,
];

/// DECRPM status: the mode is currently set (1) or permanently set (3).
const fn is_private_mode_set(status: u32) -> bool {
	matches!(status, 1 | 3)
}

/// DECRPM status: anything but unrecognized (0) and permanently reset (4).
const fn is_private_mode_supported(status: u32) -> bool {
	!matches!(status, 0 | 4)
}

/// Resolved private modes and the state they drive.
#[derive(Default)]
pub(super) struct Modes {
	/// Modes whose DECRQM support has resolved (first result wins).
	resolved: Vec<u32>,
	/// Whether output and input reassert DEC 2004: set once DECRPM confirms
	/// it, or at input attach inside a multiplexer that gates paste markers on
	/// the pane's own mode without answering DECRQM (tmux <= 3.5a, #15596).
	pub(super) rearm_bracketed_paste: bool,
	/// DECRPM confirmed DEC 2004: a genuine paste arrives wrapped.
	pub(super) bracketed_paste_confirmed: bool,
	/// Whether DEC 2048 in-band resize notifications are currently enabled.
	pub(super) in_band_resize: bool,
	reported_columns: Option<u32>,
	reported_rows: Option<u32>,
}

impl Session {
	/// Probe a DEC private mode via DECRQM (`CSI ? mode $ p`) plus a DA1
	/// sentinel. The sentinel guarantees resolution even from terminals that
	/// ignore DECRQM. Query and sentinel are fused into one batch.
	pub(super) fn query_private_mode(&mut self, mode: u32, device: &mut Device) {
		if self.link.dead || self.modes.resolved.contains(&mode) {
			return;
		}
		self.probes.push_back(Owner::PrivateMode(mode));
		self.link.send(device, |batch| {
			batch.query_private_mode(mode).query_device_attributes();
		});
	}

	/// DECRPM private-mode report. Resolves the matching probe by mode; the
	/// owner stays in the FIFO and is drained by its DA1 sentinel (a no-op
	/// once resolved). Per DECRPM, status 0 = unrecognized, 1/2 = set/reset,
	/// 3 = permanently set, and 4 = permanently reset.
	pub(super) fn handle_private_mode_report(
		&mut self,
		now: Millis,
		mode: u32,
		status: u32,
		device: &mut Device,
		out: &mut Vec<Event>,
	) {
		let supported = is_private_mode_supported(status);
		self.resolve_private_mode(now, mode, supported, true, Some(status), device, out);
		if XTERM_SCROLL_TO_BOTTOM_MODES.contains(&mode) && is_private_mode_set(status) {
			self.disable_scroll_to_bottom(mode, device);
		}
	}

	/// Record DECRQM support for a private mode (idempotent — first result
	/// wins) and report it. `confirmed` distinguishes an explicit DECRPM
	/// unsupported response from an absent response followed by the DA1
	/// sentinel, which proves only that querying support is unavailable — not
	/// that the private mode itself is unsupported. Enables DEC 2048 in-band
	/// resize only after positive confirmation.
	#[allow(clippy::too_many_arguments, reason = "one resolution, described in full")]
	pub(super) fn resolve_private_mode(
		&mut self,
		now: Millis,
		mode: u32,
		supported: bool,
		confirmed: bool,
		status: Option<u32>,
		device: &mut Device,
		out: &mut Vec<Event>,
	) {
		if self.modes.resolved.contains(&mode) {
			return;
		}
		self.modes.resolved.push(mode);
		out.push(Event::PrivateMode { mode, supported, confirmed, status });
		match mode {
			mode::IN_BAND_RESIZE if supported => self.enable_in_band_resize(device),
			mode::APPEARANCE_REPORTS => self.sync_appearance_polling(now, supported),
			// Confirmed bracketed-paste support means a genuine paste arrives
			// wrapped, so an unmarked multiline burst is an input-method commit
			// (#13344) unless an event-loop stall batched typed keys into one
			// read (#12540). Let the host's stall probe decide per burst.
			// `supported` is only true here after an explicit DECRPM reply (the
			// DA1-sentinel fallback resolves unsupported).
			mode::BRACKETED_PASTE if supported => {
				self.modes.rearm_bracketed_paste = true;
				self.modes.bracketed_paste_confirmed = true;
			},
			_ => {},
		}
	}

	/// Reset an xterm scroll-to-bottom mode the terminal reported set; the
	/// device's exit restore sets it again.
	fn disable_scroll_to_bottom(&self, mode: u32, device: &mut Device) {
		if device.mode(mode) == Some(false) || self.link.dead {
			return;
		}
		self.link.send(device, |batch| {
			batch.reset_mode(mode, false);
		});
	}

	/// Enable DEC 2048 in-band resize notifications. The terminal emits an
	/// initial report immediately, seeding reported geometry and cell
	/// dimensions.
	fn enable_in_band_resize(&mut self, device: &mut Device) {
		if self.modes.in_band_resize || self.link.dead {
			return;
		}
		self.modes.in_band_resize = true;
		self.link.send(device, |batch| {
			batch.set_mode(mode::IN_BAND_RESIZE, false);
		});
	}

	/// Apply an in-band resize report (DEC mode 2048). Unsolicited and not
	/// tied to a sentinel: stores reported geometry so [`size`](Self::size)
	/// reflects in-band values, derives cell pixel size, and emits
	/// [`Event::Resize`] only when the report changes the effective row/column
	/// geometry.
	pub(super) fn handle_in_band_resize(
		&mut self,
		rows: u32,
		columns: u32,
		height_px: u32,
		width_px: u32,
		out: &mut Vec<Event>,
	) {
		let previous = self.size();
		if rows > 0 {
			self.modes.reported_rows = Some(rows);
		}
		if columns > 0 {
			self.modes.reported_columns = Some(columns);
		}
		if columns > 0 && width_px > 0 && rows > 0 && height_px > 0 {
			let cell = |pixels: u32, cells: u32| {
				((f64::from(pixels) / f64::from(cells)).round() as u32).max(1)
			};
			self.report_cell_size(cell(width_px, columns), cell(height_px, rows), false, out);
		}
		if rows > 0 && columns > 0 && (rows != previous.rows || columns != previous.columns) {
			out.push(Event::Resize);
		}
	}

	/// Effective geometry: the in-band report while DEC 2048 is active, else
	/// the OS value.
	pub fn size(&self) -> Size {
		if !self.modes.in_band_resize {
			return self.os;
		}
		Size {
			columns: self.modes.reported_columns.unwrap_or(self.os.columns),
			rows:    self.modes.reported_rows.unwrap_or(self.os.rows),
		}
	}

	/// OS-level resize to `columns` × `rows`; returns whether the effective
	/// geometry changed.
	///
	/// Reconciles cached in-band geometry with the OS. SIGWINCH (POSIX) and
	/// `ConPTY` (Windows) refresh the OS dimensions before the resize is
	/// delivered, so they are authoritative for the new cell geometry. A
	/// cached DEC 2048 report can be stale: the matching post-resize report
	/// may be dropped (split across stdin reads past the flush window, or
	/// interrupted by another escape mid-reassembly), leaving
	/// [`size`](Self::size) pinned to the old size — which freezes the
	/// rendered width because the renderer reflows against it, not the live
	/// OS value. Drop a cached dimension that disagrees with the live OS
	/// value; the terminal's next valid in-band report re-seeds pixel sizing.
	pub fn os_resize(&mut self, columns: u32, rows: u32, device: &mut Device) -> bool {
		let previous = self.size();
		// Conservative: some hosts reset modes across a resize/reattach, so
		// re-establish cursor visibility on the next explicit call.
		self.link.send(device, |batch| {
			batch.forget_cursor();
		});
		self.os = Size { columns, rows };
		if self.modes.in_band_resize {
			if columns > 0
				&& self
					.modes
					.reported_columns
					.is_some_and(|reported| reported != columns)
			{
				self.modes.reported_columns = None;
			}
			if rows > 0
				&& self
					.modes
					.reported_rows
					.is_some_and(|reported| reported != rows)
			{
				self.modes.reported_rows = None;
			}
		}
		self.size() != previous
	}
}
