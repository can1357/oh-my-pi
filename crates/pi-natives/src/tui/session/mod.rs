//! Terminal session: capability probes and the state negotiated through
//! them.
//!
//! A [`Session`] owns everything a terminal is asked or told that is not a
//! frame: the input-attach sequence and its leak guard, the DA1 sentinel FIFO
//! ([`probe`]), keyboard protocol negotiation ([`keyboard`]), DECRQM-resolved
//! private modes and in-band resize geometry ([`modes`]), dark/light
//! detection ([`appearance`]), single-answer capability probes ([`caps`],
//! [`glyph`]), the exit input drain ([`drain`]), and output health
//! ([`output`], [`watchdog`]).
//!
//! It is sans-IO: the input parser hands it [`Report`]s, every call carries
//! the host's clock, timers are deadlines the host re-arms from
//! [`Session::deadline`] and fires through [`Session::tick`], and results
//! leave as [`Event`]s.

mod appearance;
mod caps;
mod drain;
mod glyph;
mod keyboard;
mod modes;
mod output;
mod probe;
#[cfg(test)]
mod tests;
mod watchdog;

use std::collections::VecDeque;

use self::{
	appearance::Appearance,
	caps::Caps,
	drain::Drain,
	keyboard::Keyboard,
	modes::{Modes, PROBED_MODES},
	output::{Link, Progress, Stall},
	probe::Owner,
};
use super::{
	input::InputContext,
	types::{Event, Facts, ImageProtocol, Millis, Report, Size},
};
use crate::term::{Device, mode};

/// Disarm a one-shot deadline that has come due; true when it fired.
fn fired(deadline: &mut Option<Millis>, now: Millis) -> bool {
	let due = deadline.is_some_and(|at| at <= now);
	if due {
		*deadline = None;
	}
	due
}

/// Probes and negotiated terminal state for one terminal.
pub struct Session {
	facts:          Facts,
	link:           Link,
	/// Geometry the OS reports.
	os:             Size,
	/// Input is attached: explicit probes are safe only once their replies can
	/// be read. False throughout stops.
	active:         bool,
	/// Outstanding DA1 sentinels, oldest first.
	probes:         VecDeque<Owner>,
	keyboard:       Keyboard,
	modes:          Modes,
	appearance:     Appearance,
	caps:           Caps,
	/// The inline image protocol the host renders with; survives restarts.
	image_protocol: Option<ImageProtocol>,
	progress:       Progress,
	stall:          Stall,
	drain:          Option<Drain>,
	drain_serial:   u32,
}

impl Session {
	/// A session for the terminal `facts` describes, at the OS-reported `size`.
	pub fn new(facts: &Facts, size: Size) -> Self {
		Self {
			facts:          facts.clone(),
			link:           Link::default(),
			os:             size,
			active:         false,
			probes:         VecDeque::new(),
			keyboard:       Keyboard::default(),
			modes:          Modes::default(),
			appearance:     Appearance::default(),
			caps:           Caps::default(),
			image_protocol: facts.image_protocol,
			progress:       Progress::default(),
			stall:          Stall::default(),
			drain:          None,
			drain_serial:   0,
		}
	}

	/// Take ownership of the terminal's output. Paint-only: nothing here
	/// elicits a response, so input may stay cooked (kernel echo and line
	/// editing) until [`attach_input`](Self::attach_input).
	pub fn start(&mut self, device: &mut Device) {
		self.link.stopped = false;
		// The host terminal's cursor visibility is unknown until we write it.
		self.link.send(device, |batch| {
			batch.forget_cursor();
		});
	}

	/// Input is attached (stdin is raw and its bytes reach the parser):
	/// normalize input modes and run every capability probe that
	/// elicits a response on stdin.
	///
	/// A terminal that cannot parse a probe may leave concealed bytes on the
	/// cursor row, so the host repaints afterwards.
	pub fn attach_input(&mut self, now: Millis, device: &mut Device, out: &mut Vec<Event>) {
		if self.link.dead {
			return;
		}
		// Enable bracketed paste mode - terminal will wrap pastes in
		// \x1b[200~ ... \x1b[201~
		self.link.send(device, |batch| {
			batch.set_mode(mode::BRACKETED_PASTE, false);
		});
		self.modes.rearm_bracketed_paste = self.facts.gates_bracketed_paste;

		// Force normal cursor-key (DECCKM) and numeric-keypad mode (terminfo
		// `rmkx` = "\x1b[?1l\x1b>"). omp decodes both CSI ("\x1b[A") and SS3
		// ("\x1bOA") arrow encodings, so it never enables application mode
		// itself — but a prior program that left the TTY in application-cursor-
		// keys mode makes arrows arrive as SS3. Normalizing on entry keeps input
		// in the predictable default state; the exit restore does the same.
		// See #6374.
		self.link.send(device, |batch| {
			batch.reset_mode(mode::CURSOR_KEYS, false).keypad_numeric();
		});

		// Every response-eliciting probe goes out inside the leak guard. A
		// terminal that cannot parse a probe prints it as text at the cursor
		// (Apple Terminal drops `ESC _`/`ESC \` and prints APC payloads, and
		// abandons DECRQM at its `$`, printing the final `p`). DECSC, autowrap
		// off, and SGR 8 (conceal) keep that text invisible and on the cursor
		// row, so it can neither wrap nor scroll the screen; the DECRC closing
		// the guard puts the cursor back. The screen owner repaints the row
		// afterwards.
		self.link.send(device, |batch| {
			batch.save_cursor().reset_mode(mode::AUTOWRAP, false).sgr(8);
		});

		// Query and enable Kitty keyboard protocol.
		self.query_keyboard(now, device);
		// Explicit probes are safe only after their replies can be read. Kept
		// false throughout temporary stops.
		self.active = true;

		// Query terminal background color via OSC 11 for dark/light detection.
		self.query_background_color(now, false, None, device);
		self.query_osc99(device);
		self.query_program_status(device);
		self.query_glyph(device);
		self.query_tsp(now, device, out);

		// Subscribe to Mode 2031 appearance change notifications. When the
		// terminal reports a change, OSC 11 is re-queried for the actual
		// background color.
		self.link.send(device, |batch| {
			batch.set_mode(mode::APPEARANCE_REPORTS, false);
		});

		// Probe DEC private-mode support via DECRQM.
		for probed in PROBED_MODES {
			self.query_private_mode(probed, device);
		}

		// Close the leak guard: reveal, autowrap on, DECRC.
		self.link.send(device, |batch| {
			batch
				.sgr(28)
				.set_mode(mode::AUTOWRAP, false)
				.restore_cursor();
		});

		self.query_sixel_graphics(now, device);
		self.query_cell_size(device);
	}

	/// Consume a terminal report. Returns it back when the session does not
	/// own it: a cursor position report belongs to the screen.
	pub fn handle_report(
		&mut self,
		now: Millis,
		report: Report,
		device: &mut Device,
		out: &mut Vec<Event>,
	) -> Option<Report> {
		match report {
			Report::KittyKeyboard { flags } => self.handle_kitty_reply(flags, device, out),
			Report::AppearanceChanged => self.handle_appearance_changed(now),
			Report::BackgroundColor { r, g, b } => self.handle_background_color(r, g, b, out),
			Report::DeviceAttributes { sixel } => {
				self.handle_device_attributes(now, sixel, device, out);
			},
			Report::PrivateMode { mode, status } => {
				self.handle_private_mode_report(now, mode, status, device, out);
			},
			Report::InBandResize { rows, columns, height_px, width_px } => {
				self.handle_in_band_resize(rows, columns, height_px, width_px, out);
			},
			Report::NotificationCaps { meta, payload } => {
				self.handle_notification_caps(&meta, &payload, out);
			},
			Report::ProgramStatus { states } => self.handle_program_status(states.as_deref(), out),
			Report::Glyph { sequence } => self.handle_glyph_reply(&sequence, device, out),
			Report::Tsp { sequence } => self.handle_tsp_message(sequence, out),
			// Consumes terminal cell size responses without blocking unrelated
			// input; the host invalidates so images re-render with correct
			// dimensions.
			Report::CellSize { height_px, width_px } => {
				self.report_cell_size(width_px, height_px, true, out);
			},
			Report::SixelGraphics { supported } => self.handle_sixel_graphics(supported, out),
			report @ Report::CursorPosition { .. } => return Some(report),
		}
		None
	}

	/// Stdin delivered bytes (call before feeding them to the parser);
	/// `pasting` is the parser's bracketed-paste flag.
	pub fn note_input(&mut self, now: Millis, pasting: bool, device: &mut Device) {
		if let Some(drain) = &mut self.drain {
			drain.last_data = now;
		}
		// Recover modes reset by the host before the user's next paste. Not
		// mid-paste: the host is plainly in 2004 then, and per-key reads would
		// turn one paste into thousands of writes (#15757).
		if self.rearms_bracketed_paste() && !pasting {
			self.link.send(device, |batch| {
				batch.set_mode(mode::BRACKETED_PASTE, false);
			});
		}
	}

	/// Fire every deadline that has come due and report a dead output device.
	pub fn tick(&mut self, now: Millis, device: &mut Device, out: &mut Vec<Event>) {
		if device.dead() && !self.link.stopped {
			self.link.fail("stdout failed; output pump died");
		}
		self.report_failure(out);
		self.tick_keyboard(now, device);
		self.tick_appearance(now, device);
		self.tick_caps(now, out);
		self.tick_progress(now, device);
		self.stall.tick(now);
		self.tick_drain(now, out);
	}

	/// The earliest time [`tick`](Self::tick) has work to do.
	pub fn deadline(&self) -> Option<Millis> {
		[
			self.keyboard.fallback_at,
			self.appearance.deadline(),
			self.caps.deadline(),
			self.progress.keepalive_at,
			self.stall.deadline(),
			self.drain.as_ref().map(Drain::deadline),
		]
		.into_iter()
		.flatten()
		.reduce(f64::min)
	}

	/// What the input parser must recognize given the negotiated state. The
	/// engine pushes it to the parser after every session call; when
	/// `win32_input` turns off, the parser releases the input its decoder
	/// still holds.
	pub const fn input_context(&self) -> InputContext {
		InputContext {
			in_band_resize:        self.modes.in_band_resize,
			osc11_pending:         self.appearance.pending,
			osc99_pending:         self.caps.osc99_pending.is_some(),
			win32_input:           self.keyboard.win32_input,
			// Windows console hosts drop AltGr text under kitty (AltGr+F →
			// `CSI 102;3u`); the parser recovers it from the active layout
			// before any keybinding sees an Alt chord.
			kitty_conpty_altgr:    self.keyboard.kitty
				&& self.facts.conpty
				&& self.facts.native_windows_console,
			raw_paste_stall_probe: self.modes.bracketed_paste_confirmed,
			kitty_active:          self.keyboard.kitty,
		}
	}

	/// Whether the kitty keyboard protocol is active.
	pub const fn kitty_active(&self) -> bool {
		self.keyboard.kitty
	}

	/// The last detected appearance (`true` = dark), or `None` if not yet
	/// known.
	pub const fn appearance_dark(&self) -> Option<bool> {
		self.appearance.dark
	}

	/// True while the TSP `hello` probe awaits its reply or DA1 sentinel.
	pub const fn tsp_probe_pending(&self) -> bool {
		self.caps.tsp_pending
	}

	/// Hand the terminal back: write the exit restore, then drop every probe,
	/// timer, and negotiated flag. Events release what the host still holds
	/// for this terminal (kitty key matching, OSC 99, program status, tmux APC
	/// titles).
	///
	/// The restore is the one the output device derives from the state it
	/// tracked. In order, it:
	/// - clears an active OSC 9;4 progress indicator;
	/// - leaves the alternate screen, popping the keyboard enhancement pushed on
	///   it first. DECRST 1049 is written only while that screen is active,
	///   never blindly: Windows' shared VT dispatcher (conhost and Windows
	///   Terminal both use `AdaptDispatch`) executes an unconditional cursor
	///   restore on it — with no prior DECSC save the cursor jumps to the
	///   viewport home, dropping the parent shell prompt on top of the dead
	///   frame after exit;
	/// - leaves the paint-time modes (DEC 2026, autowrap off) even if the
	///   process exits between the begin/end halves of a frame. Safe no-ops on
	///   terminals that ignored them;
	/// - restores normal cursor-key (DECCKM) and numeric-keypad mode (terminfo
	///   `rmkx`). Symmetric with the normalize in
	///   [`attach_input`](Self::attach_input): a TTY-sharing child can leave the
	///   terminal in application-cursor-keys mode, and without this reset the
	///   parent shell inherits SS3 arrows so Up/Down history navigation stays
	///   broken after exit (#6374);
	/// - disables bracketed paste and kitty paste events;
	/// - hands the cursor shape back to the user's terminal configuration; a Vim
	///   Normal-mode block must not outlive the session in their shell;
	/// - disables mouse tracking (enabled only by fullscreen overlays; safe
	///   no-ops otherwise), covering crash paths that reach `stop` without the
	///   screen's own overlay teardown running;
	/// - disables Mode 2031 appearance change notifications;
	/// - sets the xterm scroll-to-bottom modes that were set before startup;
	/// - disables DEC 2048 in-band resize if it was enabled;
	/// - disables the keyboard enhancement (kitty pop, modifyOtherKeys,
	///   win32-input-mode) unless [`drain_input`](Self::drain_input) already
	///   did;
	/// - shows the cursor.
	pub fn stop(&mut self, device: &mut Device, out: &mut Vec<Event>) {
		if self.link.stopped {
			return;
		}
		// Suppress probes and reassertions before anything else.
		self.active = false;
		self.progress = Progress::default();
		if !self.link.dead {
			device.restore();
		}
		// The restore is the last output of this session until `start`.
		self.link.stopped = true;

		self.modes = Modes::default();
		self.appearance.reset();
		self.reset_caps(out);
		self.probes.clear();
		// The restore above already disabled the keyboard enhancement on the
		// terminal; drop the matching input-side state.
		if self.keyboard.kitty {
			out.push(Event::KeyboardProtocol { kitty: false });
		}
		self.keyboard = Keyboard::default();
		self.stall.disarm();
		self.drain = None;
	}
}
