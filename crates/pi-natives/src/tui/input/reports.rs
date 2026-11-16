//! The stdin sequence handler: recognizes terminal → host reports among the
//! sequences the splitter emits, reassembles the ones a flush timeout tore
//! apart, and forwards everything else as keys.
//!
//! The splitter delivers one complete sequence per event, but a reply the
//! terminal writes slowly (laggy ssh/tmux links, a busy resize) is flushed as
//! a partial head followed by per-character tail events. Each reassembly
//! buffer below owns one reply family and swallows that tail instead of
//! letting it reach the focused component as typed text.

use std::mem;

use super::{
	Deferred, InputContext,
	scan::Scan,
	split::{TSP_OSC_PREFIX, TSP_PREFIX},
	win32::Win32InputModeDecoder,
};
use crate::tui::types::{Input, Millis, Report};

/// How long a relayed ESC record waits for the rest of its sequence before
/// acting as Escape.
const WIN32_RELAYED_ESCAPE_TIMEOUT_MS: Millis = 75.0;
/// How long a relayed OSC/DCS/APC string waits for its terminator. Far longer
/// than a lone ESC: a TSP event split across console-host reads must not be
/// released mid-string (its tail would be typed into the composer), and a
/// stall of the event loop longer than 75 ms fires the timer before the queued
/// tail is read.
const WIN32_RELAYED_STRING_TIMEOUT_MS: Millis = 5000.0;
/// How long a flushed CSI introducer waits for its body before it is released
/// to the input handler as a key. Without a bound, a stray `\x1b[` (Alt+[ on a
/// legacy encoder, or Esc followed by `[`) would fuse with a keystroke made
/// arbitrarily later and rewrite it.
const CSI_INTRODUCER_GRACE_MS: Millis = 150.0;
/// How long a report body applied without its `t` waits for that delayed
/// terminator. Inside the window a lone `t` is treated as the terminator;
/// after it, `t` is a real keystroke again.
const INBAND_TERMINATOR_GRACE_MS: Millis = 300.0;
/// Cap on the private-CSI and in-band accumulators, defending against runaway
/// partials if the terminator never arrives.
const MAX_CSI_REPLY_BYTES: usize = 256;
/// Cap on a buffered OSC 7501 feature reply.
const MAX_PROGRAM_STATUS_REPLY_BYTES: usize = 4096;

/// Private CSI partial: `\x1b[?<digits/semicolons><intermediates>` — an
/// incomplete probe response that the splitter flushed before the terminator
/// arrived (split across stdin reads). Used to reassemble DA1, kitty, and Mode
/// 2031 replies.
fn is_private_csi_partial(sequence: &str) -> bool {
	let mut scan = Scan::new(sequence);
	if !scan.eat("\x1b[?") {
		return false;
	}
	scan.take_while(|byte| byte.is_ascii_digit() || byte == b';');
	scan.take_while(|byte| (0x20..=0x2f).contains(&byte));
	scan.at_end()
}

/// Head of a possible DEC 2048 report: `\x1b[4` then digits, `;`, `:`.
fn is_in_band_resize_partial(sequence: &str) -> bool {
	sequence.strip_prefix("\x1b[4").is_some_and(|body| {
		body
			.bytes()
			.all(|byte| byte.is_ascii_digit() || matches!(byte, b';' | b':'))
	})
}

/// In-band resize report (DEC mode 2048):
/// `\x1b[48;rows;cols;yPixels;xPixels t`. Any field may carry `:`-separated
/// subparameters, which clients MUST ignore per spec (#4748): take the leading
/// digits of each field and skip the subparameter tail instead of dropping the
/// whole report.
///
/// With `terminated` false this matches the same body without its `t`
/// terminator. iTerm2 writes the body and the terminator as separate chunks,
/// and the body alone is unambiguous: no key reply carries a `48;` selector
/// plus four numeric fields.
fn in_band_resize_report(sequence: &str, terminated: bool) -> Option<Report> {
	let mut scan = Scan::new(sequence);
	if !scan.eat("\x1b[48") {
		return None;
	}
	let mut fields = [0; 4];
	for field in &mut fields {
		if !scan.eat(";") {
			return None;
		}
		*field = scan.number()?;
		if scan.eat(":") {
			scan.take_while(|byte| byte.is_ascii_digit() || byte == b':');
		}
	}
	if terminated && !scan.eat("t") {
		return None;
	}
	let [rows, columns, height_px, width_px] = fields;
	scan
		.at_end()
		.then_some(Report::InBandResize { rows, columns, height_px, width_px })
}

/// DECRPM private-mode report (DECRQM reply): `\x1b[?<mode>;<status>$y`. Per
/// DECRPM, status 0 = unrecognized, 1/2 = set/reset, 3 = permanently set, and
/// 4 = permanently reset.
fn private_mode_report(sequence: &str) -> Option<Report> {
	let mut scan = Scan::new(sequence);
	if !scan.eat("\x1b[?") {
		return None;
	}
	let mode = scan.number()?;
	if !scan.eat(";") {
		return None;
	}
	let status = scan.number()?;
	(scan.eat("$y") && scan.at_end()).then_some(Report::PrivateMode { mode, status })
}

/// DA1 (Primary Device Attributes) response: `\x1b[?...c`. Attribute 4
/// advertises SIXEL graphics; it only counts as its own parameter, never as
/// the leading conformance level.
fn device_attributes_report(sequence: &str) -> Option<Report> {
	let mut scan = Scan::new(sequence);
	if !scan.eat("\x1b[?") {
		return None;
	}
	scan.take_while(|byte| byte.is_ascii_digit() || byte == b';');
	(scan.eat("c") && scan.at_end()).then(|| Report::DeviceAttributes {
		sixel: sequence.contains(";4;") || sequence.ends_with(";4c"),
	})
}

/// Kitty protocol response: `\x1b[?<flags>u`.
fn kitty_keyboard_report(sequence: &str) -> Option<Report> {
	let mut scan = Scan::new(sequence);
	if !scan.eat("\x1b[?") {
		return None;
	}
	let flags = scan.number()?;
	(scan.eat("u") && scan.at_end()).then_some(Report::KittyKeyboard { flags })
}

/// One 1-4 digit `XParseColor` hex component, normalized to `0.0..=1.0`.
fn color_channel(scan: &mut Scan<'_>) -> Option<f64> {
	let hex = scan.take_while(|byte| byte.is_ascii_hexdigit());
	if !(1..=4).contains(&hex.len()) {
		return None;
	}
	let value = u32::from_str_radix(hex, 16).ok()?;
	let max = (1u32 << (4 * hex.len())) - 1;
	Some(f64::from(value) / f64::from(max))
}

/// OSC 11 response: `\x1b]11;rgb:RR/GG/BB` or `rgba:RR/GG/BB`, terminated by
/// BEL or ST.
fn background_color_report(buffered: &str) -> Option<Report> {
	let mut scan = Scan::new(buffered);
	if !scan.eat("\x1b]11;rgb") {
		return None;
	}
	scan.eat("a");
	if !scan.eat(":") {
		return None;
	}
	let r = color_channel(&mut scan)?;
	if !scan.eat("/") {
		return None;
	}
	let g = color_channel(&mut scan)?;
	if !scan.eat("/") {
		return None;
	}
	let b = color_channel(&mut scan)?;
	((scan.eat("\x07") || scan.eat("\x1b\\")) && scan.at_end()).then_some(Report::BackgroundColor {
		r,
		g,
		b,
	})
}

/// The payload of an OSC string once its terminator (ST, else BEL) arrived.
fn strip_string_terminator(text: &str) -> Option<&str> {
	text
		.strip_suffix("\x1b\\")
		.or_else(|| text.strip_suffix('\x07'))
}

/// OSC 99 capability reply: `\x1b]99;<meta>;<payload>` + BEL or ST.
fn notification_caps_report(buffered: &str) -> Option<Report> {
	let body = strip_string_terminator(buffered.strip_prefix("\x1b]99;")?)?;
	let (meta, payload) = body.split_once(';')?;
	Some(Report::NotificationCaps { meta: meta.to_owned(), payload: payload.to_owned() })
}

/// OSC 7501 feature reply: `\x1b]7501;?[:key=value…]` + BEL or ST.
fn program_status_report(reply: &str) -> Option<Report> {
	let body = strip_string_terminator(reply.strip_prefix("\x1b]7501;?")?)?;
	if !(body.is_empty() || body.starts_with(':')) || body.contains(['\x07', '\x1b']) {
		return None;
	}
	let mut states = None;
	for pair in body.split(':') {
		// The spec allows whitespace around both keys and values.
		let Some((key, value)) = pair.split_once('=') else {
			continue;
		};
		if key.trim() != "states" {
			continue;
		}
		states = Some(
			value
				.split(',')
				.map(|state| state.trim().to_owned())
				.collect(),
		);
	}
	Some(Report::ProgramStatus { states })
}

/// The TSP message a reassembled input string holds, in APC form, or `None`
/// while its terminator has not arrived. An OSC 877 message may end with ST
/// or BEL (a JSON body never contains BEL).
fn complete_tsp_input(buffered: &str) -> Option<String> {
	let Some(body) = buffered.strip_prefix(TSP_OSC_PREFIX) else {
		return buffered.ends_with("\x1b\\").then(|| buffered.to_owned());
	};
	let body = strip_string_terminator(body)?;
	Some(format!("{TSP_PREFIX}{body}\x1b\\"))
}

/// CPR: `\x1b[row;colR`. The same bytes with row 1 are a modified F3; the
/// screen decides which it is.
fn cursor_position_report(sequence: &str) -> Option<Report> {
	let mut scan = Scan::new(sequence);
	if !scan.eat("\x1b[") {
		return None;
	}
	let row = scan.number()?;
	if !scan.eat(";") {
		return None;
	}
	let column = scan.number()?;
	(scan.eat("R") && scan.at_end()).then_some(Report::CursorPosition { row, column })
}

/// A decimal `digits[.digits]` number.
fn decimal(text: &str) -> Option<f64> {
	let (whole, fraction) = text
		.split_once('.')
		.map_or((text, None), |(whole, fraction)| (whole, Some(fraction)));
	let numeric = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
	if !numeric(whole) || fraction.is_some_and(|fraction| !numeric(fraction)) {
		return None;
	}
	text.parse().ok()
}

/// Cell-size replies: `CSI 6 ; height ; width t` in pixels, and iTerm2's
/// `OSC 1337 ; ReportCellSize = height ; width [; scale] ST` in points.
///
/// `Some(None)` is a recognized reply without a usable size: consumed, not
/// reported.
#[allow(
	clippy::cast_possible_truncation,
	clippy::cast_sign_loss,
	reason = "both sizes are positive and rounded; a float-to-integer `as` saturates"
)]
#[allow(
	clippy::option_option,
	reason = "outer `None` = not this reply, `Some(None)` = consumed without a report; mirrors the \
	          `?`-chained parser and the caller's `if let Some`"
)]
fn cell_size_report(sequence: &str) -> Option<Option<Report>> {
	let (height, width) = if let Some(body) = sequence.strip_prefix("\x1b]1337;ReportCellSize=") {
		let mut fields = strip_string_terminator(body)?.split(';');
		let height = decimal(fields.next()?)?;
		let width = decimal(fields.next()?)?;
		let scale = fields.next().map_or(Some(1.0), decimal)?;
		if fields.next().is_some() {
			return None;
		}
		((height * scale).round(), (width * scale).round())
	} else {
		let mut scan = Scan::new(sequence);
		if !scan.eat("\x1b[6;") {
			return None;
		}
		let height = scan.number()?;
		if !scan.eat(";") {
			return None;
		}
		let width = scan.number()?;
		if !(scan.eat("t") && scan.at_end()) {
			return None;
		}
		(f64::from(height), f64::from(width))
	};
	if height <= 0.0 || width <= 0.0 {
		return Some(None);
	}
	Some(Some(Report::CellSize { height_px: height as u32, width_px: width as u32 }))
}

/// XTSMGRAPHICS item 2 reply `CSI ? 2 ; Ps ; Pv S`: per xterm ctlseqs Ps is
/// the status (0 = success, 1..3 = error/failure) and Pv the maximum SIXEL
/// geometry, which a terminal without SIXEL reports as zero.
fn sixel_graphics_report(sequence: &str) -> Option<Report> {
	let mut scan = Scan::new(sequence);
	if !scan.eat("\x1b[?2;") {
		return None;
	}
	let status = scan.number()?;
	if !scan.eat(";") {
		return None;
	}
	let geometry = scan.take_while(|byte| byte.is_ascii_digit() || byte == b';');
	if geometry.is_empty() || !(scan.eat("S") && scan.at_end()) {
		return None;
	}
	let has_geometry = geometry
		.split(';')
		.any(|part| part.bytes().any(|digit| digit != b'0'));
	Some(Report::SixelGraphics { supported: status == 0 && has_geometry })
}

/// Whether `sequence` is an escape other than a bare string terminator, i.e.
/// something that interrupts an OSC/APC reply being reassembled.
fn interrupts_string_reply(sequence: &str) -> bool {
	sequence.starts_with('\x1b') && sequence != "\x1b\\"
}

/// Stateful sequence handler shared by direct VT input and win32-input-mode
/// relayed text.
#[derive(Default)]
pub(super) struct Reassembler {
	/// Windows console fallback when kitty is unavailable: key records arrive
	/// as win32-input-mode sequences and are decoded before recognition.
	decoder: Win32InputModeDecoder,
	/// Releases a relayed lone ESC (or string) the decoder held for a sequence
	/// tail that never came.
	win32_flush: Deferred,
	private_csi: String,
	/// Reassembly buffer for a DEC 2048 in-band resize report split across
	/// stdin reads.
	in_band_resize: String,
	/// Release deadline of a CSI introducer (`\x1b[`) the splitter flushed
	/// alone. Held so the next event is parsed as its parameter body instead
	/// of being typed into the composer.
	csi_introducer_release: Option<Millis>,
	/// Timestamp of a DEC 2048 report body applied without its `t` terminator.
	/// iTerm2 writes the body and the terminator in separate chunks; a `t`
	/// arriving right after an implicitly completed body is that terminator.
	pending_in_band_terminator: Option<Millis>,
	osc11: String,
	osc99: String,
	program_status: String,
	glyph: String,
	tsp: String,
}

impl Reassembler {
	/// Process one sequence from the splitter (or one decoded relayed key).
	pub(super) fn handle(
		&mut self,
		now: Millis,
		context: &mut InputContext,
		mut sequence: String,
		out: &mut Vec<Input>,
	) {
		if context.win32_input {
			let mut keys = Vec::new();
			if self.decoder.decode(&sequence, &mut keys) {
				self.win32_flush.clear();
				// The record is ESC-led, so it interrupts any direct reply still
				// being reassembled, just as a raw escape does below. Decoded keys
				// carry no ESC of their own and would otherwise be appended to that
				// fragment.
				self.interrupt_replies();
				for key in keys {
					self.handle(now, context, key, out);
				}
				if self.decoder.has_pending_sequence() {
					// An overdue timer runs before the host reads relayed tail
					// records; the deferral gives stdin one pass before releasing a
					// held ESC or string.
					let wait = if self.decoder.has_pending_string() {
						WIN32_RELAYED_STRING_TIMEOUT_MS
					} else {
						WIN32_RELAYED_ESCAPE_TIMEOUT_MS
					};
					self.win32_flush.arm(now + wait);
				}
				return;
			}
		}
		// iTerm2 writes a report body and its `t` terminator in separate
		// chunks. When a body was applied without its terminator (see the
		// body match below), the imminent lone `t` is that terminator and
		// must not reach the composer.
		if sequence == "t"
			&& self.in_band_resize.is_empty()
			&& let Some(applied_at) = self.pending_in_band_terminator.take()
			&& now - applied_at < INBAND_TERMINATOR_GRACE_MS
		{
			return;
		}
		// A pty read can bundle a CSI with the next escape sequence
		// (`\x1b[48;…2912\x1b[`): the reassemblers below take one sequence per
		// event, so split at the embedded ESC and dispatch both halves in
		// order. A CSI can never contain a raw ESC, and X10 mouse bodies
		// (bytes >= 0x20) cannot either, so this is always a sequence
		// boundary.
		if sequence.starts_with("\x1b[")
			&& let Some(embedded) = sequence[1..].find('\x1b')
		{
			let tail = sequence.split_off(embedded + 1);
			self.handle(now, context, sequence, out);
			self.handle(now, context, tail, out);
			return;
		}
		// A splitter flush can end immediately after the CSI introducer:
		// the body then arrives in the next read as bare printable bytes — a
		// DEC 2048 resize report torn this way during a busy resize or a
		// terminal teardown types `48;rows;cols;hPx;wPx` into the composer.
		// Hold the introducer and prepend it to the next event so the
		// completed sequence reaches whichever reassembler owns it: the
		// in-band report buffer below, private-CSI probe reassembly, or the
		// input handler for a genuine key (`\x1b[A`). A fresh ESC-led event
		// interrupts the held head — it is a sequence of its own.
		if self.csi_introducer_release.take().is_some() && !sequence.starts_with('\x1b') {
			sequence.insert_str(0, "\x1b[");
		}
		if sequence == "\x1b[" && context.in_band_resize {
			// A complete body held from the previous read is waiting on its
			// late `t`; apply it now. A mere partial is dead once a new
			// introducer interrupts it.
			if !self.in_band_resize.is_empty() {
				let held_body = in_band_resize_report(&self.in_band_resize, false);
				self.in_band_resize.clear();
				if let Some(report) = held_body {
					self.pending_in_band_terminator = Some(now);
					out.push(Input::Report(report));
				}
			}
			// A new ESC interrupts any private-CSI partial the same way, so
			// holding unconditionally cannot lose a reply and keeps a report
			// body from leaking behind the pending partial.
			self.private_csi.clear();
			self.csi_introducer_release = Some(now + CSI_INTRODUCER_GRACE_MS);
			return;
		}
		// Fast path for plain-text bytes: every report below starts with ESC,
		// so a byte that is not ESC can never match. A non-bracketed paste of
		// N printable chars arrives as N per-scalar events; running the full
		// recognizer suite per event turns a 100 KB paste into a stall. Skip
		// straight to the input handler when no reassembly buffer is holding
		// state that a non-ESC continuation could feed (issue #4073 case C).
		if !sequence.starts_with('\x1b') && self.replies_idle() {
			out.push(Input::Key(sequence));
			return;
		}

		// Reassemble split private CSI responses (DA1, kitty keyboard, Mode
		// 2031). When the terminal writes the response slowly enough that the
		// splitter's flush timeout elapses mid-sequence, the prefix
		// `\x1b[?<digits>` arrives as one event and the tail `;...<terminator>`
		// arrives as individual character events that would otherwise leak into
		// the prompt as keystrokes. See #1238. A private CSI (`\x1b[?…`) is a
		// terminal->host report, never a keystroke, so reassembly stays armed for
		// the whole session — not just while a probe sentinel is outstanding —
		// otherwise a reply that lands after the sentinel FIFO drains (slow
		// SSH/PTY links) leaks its tail into the composer (#8542).
		if !self.private_csi.is_empty() || is_private_csi_partial(&sequence) {
			if !self.private_csi.is_empty() && sequence.starts_with('\x1b') {
				// New escape arrived mid-reassembly — abandon partial and
				// re-process the new sequence.
				self.private_csi.clear();
			} else {
				self.private_csi.push_str(&sequence);
				if self.private_csi.len() > MAX_CSI_REPLY_BYTES {
					self.private_csi.clear();
					return;
				}
				if self
					.private_csi
					.as_bytes()
					.last()
					.is_some_and(|last| (0x40..=0x7e).contains(last))
				{
					// Terminator byte arrived. Fall through to the recognizers with
					// the reassembled sequence so the DA1/kitty/Mode 2031 handlers
					// run.
					sequence = mem::take(&mut self.private_csi);
				} else if is_private_csi_partial(&self.private_csi) {
					// Still accumulating.
					return;
				} else {
					// Diverged from a valid private CSI prefix (unexpected byte).
					// Drop the probe noise we ate; do not forward to the input
					// handler.
					self.private_csi.clear();
					return;
				}
			}
		}

		// In-band resize report (DEC 2048) split across stdin reads. The report
		// is `\x1b[48;rows;cols;yPx;xPx t`; when the splitter flush timeout
		// elapses mid-sequence — common during a rapid resize that keeps the
		// event loop busy — the `\x1b[48;…` prefix arrives as one event and the
		// tail (`…;xPx t`) arrives as bare character events that would otherwise
		// leak into the prompt as literal keystrokes. Reassemble until the
		// terminator, then fall through to the resize handler below. A
		// reassembled sequence that turns out not to be a resize report (e.g. a
		// split kitty `\x1b[48;…u` for a digit key) is forwarded to the input
		// handler rather than dropped.
		let in_band_partial = context.in_band_resize && is_in_band_resize_partial(&sequence);
		if !self.in_band_resize.is_empty() && sequence.starts_with('\x1b') {
			// A new escape interrupted the partial; the stale partial is
			// unrecoverable. If the new escape is itself an in-band prefix,
			// restart reassembly with it; otherwise let it flow through below.
			self.in_band_resize.clear();
			if in_band_partial {
				self.in_band_resize = sequence;
				return;
			}
		} else if !self.in_band_resize.is_empty() || in_band_partial {
			// A held body with all four fields is a complete report only
			// waiting on its late `t`. Any other continuation ends it: apply
			// the report and reprocess the event instead of merging a
			// keystroke into the report body.
			if sequence != "t"
				&& !sequence.starts_with(['\x1b', ';'])
				&& !sequence.starts_with(|first: char| first.is_ascii_digit())
				&& let Some(report) = in_band_resize_report(&self.in_band_resize, false)
			{
				self.in_band_resize.clear();
				self.pending_in_band_terminator = Some(now);
				out.push(Input::Report(report));
				self.handle(now, context, sequence, out);
				return;
			}
			self.in_band_resize.push_str(&sequence);
			if self.in_band_resize.len() > MAX_CSI_REPLY_BYTES {
				self.in_band_resize.clear();
				return;
			}
			if self
				.in_band_resize
				.as_bytes()
				.last()
				.is_some_and(|last| (0x40..=0x7e).contains(last))
			{
				// Terminator arrived: let the resize recognizer below claim it, or
				// fall through to the input handler if it is not a resize report.
				sequence = mem::take(&mut self.in_band_resize);
			} else if is_in_band_resize_partial(&self.in_band_resize) {
				// Still accumulating the report.
				return;
			} else {
				// Diverged from a valid in-band prefix — drop the garbled report.
				self.in_band_resize.clear();
				return;
			}
		}

		// In-band resize report (DEC mode 2048). Unsolicited and not tied to a
		// sentinel.
		if let Some(report) = in_band_resize_report(&sequence, true) {
			// The explicit terminator arrived; a later lone `t` is a keystroke.
			self.pending_in_band_terminator = None;
			out.push(Input::Report(report));
			return;
		}

		// DECRPM, then DA1, then the kitty keyboard reply. `CSI ? … c` is
		// exclusively a terminal->host report, so it is reported (and thereby
		// swallowed) even with no outstanding sentinel — a reply that arrives
		// after the FIFO drains (slow SSH/PTY links) must never reach the
		// composer as literal text (#8542).
		if let Some(report) = private_mode_report(&sequence)
			.or_else(|| device_attributes_report(&sequence))
			.or_else(|| kitty_keyboard_report(&sequence))
		{
			out.push(Input::Report(report));
			return;
		}

		// OSC 11 replies can be split if the splitter flushes a partial sequence.
		// Accumulate fragments until the BEL/ST terminator arrives, then parse
		// once. If a new escape sequence arrives (not the ST terminator), abort
		// buffering and forward it as normal input so user keystrokes are never
		// swallowed.
		if context.osc11_pending && (!self.osc11.is_empty() || sequence.starts_with("\x1b]11;")) {
			if !self.osc11.is_empty() && interrupts_string_reply(&sequence) {
				// New escape sequence arrived mid-buffer — not an OSC 11
				// continuation. Fall through to normal input handling below.
				self.osc11.clear();
			} else {
				self.osc11.push_str(&sequence);
				let Some(report) = background_color_report(&self.osc11) else {
					return;
				};
				// The query is answered: a second reply is not ours to consume.
				context.osc11_pending = false;
				self.osc11.clear();
				out.push(Input::Report(report));
				return;
			}
		}

		if context.osc99_pending && (!self.osc99.is_empty() || sequence.starts_with("\x1b]99;")) {
			if !self.osc99.is_empty() && interrupts_string_reply(&sequence) {
				self.osc99.clear();
			} else {
				self.osc99.push_str(&sequence);
				let Some(report) = notification_caps_report(&self.osc99) else {
					return;
				};
				self.osc99.clear();
				out.push(Input::Report(report));
				return;
			}
		}

		// Swallow OSC 7501 feature replies even after their DA1 sentinel:
		// a delayed terminal answer must not appear in the composer.
		if !self.program_status.is_empty() || sequence.starts_with("\x1b]7501;") {
			if !self.program_status.is_empty() && interrupts_string_reply(&sequence) {
				self.program_status.clear();
			} else {
				self.program_status.push_str(&sequence);
				if self.program_status.len() > MAX_PROGRAM_STATUS_REPLY_BYTES {
					self.program_status.clear();
					return;
				}
				if !self.program_status.ends_with('\x07') && !self.program_status.ends_with("\x1b\\") {
					return;
				}
				let reply = mem::take(&mut self.program_status);
				out.extend(program_status_report(&reply).map(Input::Report));
				return;
			}
		}

		// Tern Surface Protocol APC (`ESC _ tsp ; … ESC \`), or its OSC 877
		// framing through a ConPTY: reported whole, in APC form. The session
		// resolves the hello reply; events are routed to the native backend
		// before key matching.
		if !self.tsp.is_empty()
			|| sequence.starts_with(TSP_PREFIX)
			|| sequence.starts_with(TSP_OSC_PREFIX)
		{
			if !self.tsp.is_empty() && interrupts_string_reply(&sequence) {
				self.tsp.clear();
			} else {
				self.tsp.push_str(&sequence);
				let Some(message) = complete_tsp_input(&self.tsp) else {
					return;
				};
				self.tsp.clear();
				out.push(Input::Report(Report::Tsp { sequence: message }));
				return;
			}
		}

		// Glyph Protocol APC replies (`ESC _ 25a1 ; … ESC \`). Swallowed for
		// the whole session, not just while the probe is outstanding: an APC is
		// exclusively terminal->host data, and registrations use `reply=0`, so
		// any late `r`/`c` acknowledgement must never reach the composer.
		if !self.glyph.is_empty() || sequence.starts_with("\x1b_25a1;") {
			if !self.glyph.is_empty() && interrupts_string_reply(&sequence) {
				self.glyph.clear();
			} else {
				self.glyph.push_str(&sequence);
				if !self.glyph.ends_with("\x1b\\") {
					return;
				}
				let reply = mem::take(&mut self.glyph);
				out.push(Input::Report(Report::Glyph { sequence: reply }));
				return;
			}
		}

		// Mode 2031 change notification: `\x1b[?997;{1=dark,2=light}n`.
		if sequence == "\x1b[?997;1n" || sequence == "\x1b[?997;2n" {
			out.push(Input::Report(Report::AppearanceChanged));
			return;
		}

		// CPR replies (CSI row;col R) are terminal reports while an anchor
		// probe is unanswered and modified F3 otherwise; the screen tells them
		// apart.
		if let Some(report) = cursor_position_report(&sequence) {
			out.push(Input::Report(report));
			return;
		}
		// Consume terminal cell size responses without blocking unrelated input.
		if let Some(report) = cell_size_report(&sequence) {
			out.extend(report.map(Input::Report));
			return;
		}
		if let Some(report) = sixel_graphics_report(&sequence) {
			out.push(Input::Report(report));
			return;
		}

		out.push(Input::Key(sequence));
	}

	/// Fire due timers: release a held CSI introducer that no body followed,
	/// and advance the relayed-input release one stage (see [`Deferred`]).
	pub(super) fn tick(&mut self, now: Millis, context: &mut InputContext, out: &mut Vec<Input>) {
		if self.csi_introducer_release.is_some_and(|at| now >= at) {
			self.csi_introducer_release = None;
			out.push(Input::Key("\x1b[".to_owned()));
		}
		if self.win32_flush.poll(now) {
			self.release_win32_pending(now, context, out);
		}
	}

	/// Earliest instant [`Self::tick`] has work to do.
	pub(super) fn deadline(&self) -> Option<Millis> {
		match (self.csi_introducer_release, self.win32_flush.deadline()) {
			(Some(a), Some(b)) => Some(a.min(b)),
			(a, b) => a.or(b),
		}
	}

	/// Whether the decoder holds a relayed OSC/DCS/APC string (see
	/// [`Win32InputModeDecoder::has_pending_string`]).
	pub(super) const fn has_pending_win32_string(&self) -> bool {
		self.decoder.has_pending_string()
	}

	/// Deliver relayed VT text the decoder is holding (a lone ESC becomes
	/// Escape).
	pub(super) fn release_win32_pending(
		&mut self,
		now: Millis,
		context: &mut InputContext,
		out: &mut Vec<Input>,
	) {
		self.win32_flush.clear();
		if let Some(pending) = self.decoder.flush_pending_sequence() {
			self.handle(now, context, pending, out);
		}
	}

	/// Turn the key records embedded in a bracketed paste back into text
	/// (#14065).
	pub(super) fn decode_win32_paste(&mut self, text: String) -> String {
		self.decoder.decode_paste(text)
	}

	/// Start win32-input-mode decoding from a clean decoder.
	pub(super) fn restart_win32_decoder(&mut self) {
		self.win32_flush.clear();
		self.decoder = Win32InputModeDecoder::default();
	}

	/// Drop the OSC 11 fragment when its query resolved or a new one started.
	pub(super) fn clear_background_color_reply(&mut self) {
		self.osc11.clear();
	}

	/// Drop the OSC 99 fragment when its probe resolved or a new one started.
	pub(super) fn clear_notification_reply(&mut self) {
		self.osc99.clear();
	}

	/// Drop a held CSI introducer and the pending in-band terminator: a report
	/// head captured while no handler could claim its body is stale once the
	/// TTY is handed back.
	pub(super) const fn discard_report_head(&mut self) {
		self.csi_introducer_release = None;
		self.pending_in_band_terminator = None;
	}

	/// Forget every partial reply and held input without delivering it.
	pub(super) fn reset(&mut self) {
		*self = Self::default();
	}

	/// An ESC-led win32 record arrived: every direct reply still being
	/// reassembled is dead.
	fn interrupt_replies(&mut self) {
		self.private_csi.clear();
		self.in_band_resize.clear();
		self.csi_introducer_release = None;
		self.osc11.clear();
		self.osc99.clear();
		self.program_status.clear();
		self.glyph.clear();
		self.tsp.clear();
	}

	/// No reassembly buffer holds state a non-ESC continuation could feed.
	const fn replies_idle(&self) -> bool {
		self.private_csi.is_empty()
			&& self.in_band_resize.is_empty()
			&& self.osc11.is_empty()
			&& self.osc99.is_empty()
			&& self.program_status.is_empty()
			&& self.glyph.is_empty()
			&& self.tsp.is_empty()
	}
}

#[cfg(test)]
mod tests;
