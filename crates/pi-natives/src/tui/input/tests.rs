//! End-to-end tests of the stdin pipeline: raw bytes in, [`Input`]s out.

use std::fmt::Write as _;

use super::*;
use crate::tui::types::Report;

// Records as the Windows console host emits them: CSI Vk;Sc;Uc;Kd;Cs;Rc _
const SHIFT_ENTER: &str = "\x1b[13;28;13;1;16;1_";
const CTRL_ENTER: &str = "\x1b[13;28;10;1;8;1_";
const ENTER: &str = "\x1b[13;28;13;1;0;1_";
const ENTER_UP: &str = "\x1b[13;28;13;0;0;1_";
const KEY_A: &str = "\x1b[65;30;97;1;0;1_";

// DEC 2048 in-band resize reports (`CSI 48;rows;cols;yPx;xPx t`) are
// terminal->host data. A pty read can tear the report before its type field,
// bundle its body with the next report's introducer, or end before its `t`
// terminator. On iTerm2 (Cmd+Tab and tab close) the composer filled with
// `48;rows;cols;hPx;wPx` repeatedly, and the stdin trace showed:
//
//   "\x1b[48;…\x1b["   body without its `t`, next introducer in the same read
//
// Report fragments are never keystrokes, so none of these shapes may reach
// the input handler, and each one that carries a complete body must still
// apply its geometry.
const REPORT_BODY: &str = "48;61;211;1837;3131";
const RESIZE: Report =
	Report::InBandResize { rows: 61, columns: 211, height_px: 1837, width_px: 3131 };

/// A parser driven by a virtual clock.
struct Harness {
	parser:  InputParser,
	now:     Millis,
	stalled: bool,
	out:     Vec<Input>,
}

impl Harness {
	fn new() -> Self {
		Self::with(InputContext::default())
	}

	fn with(context: InputContext) -> Self {
		let mut parser = InputParser::new();
		parser.set_context(context);
		Self { parser, now: 0.0, stalled: false, out: Vec::new() }
	}

	/// DEC 2048 confirmed and enabled.
	fn in_band() -> Self {
		Self::with(InputContext { in_band_resize: true, ..InputContext::default() })
	}

	/// win32-input-mode requested (a `ConPTY` host without kitty).
	fn win32() -> Self {
		Self::with(InputContext { win32_input: true, ..InputContext::default() })
	}

	fn feed(&mut self, data: &str) {
		self.feed_bytes(data.as_bytes());
	}

	fn feed_bytes(&mut self, bytes: &[u8]) {
		self
			.parser
			.feed(self.now, bytes, self.stalled, &mut self.out);
	}

	/// One timer callback at the current clock.
	fn tick(&mut self) {
		self.parser.tick(self.now, &mut self.out);
	}

	/// Advance the clock, firing every timer that comes due on the way (each
	/// deferred stage is its own tick, like a zero-delay timer).
	fn advance(&mut self, ms: Millis) {
		let target = self.now + ms;
		for _ in 0..100_000 {
			match self.parser.deadline() {
				Some(at) if at <= target => {
					self.now = self.now.max(at);
					self.tick();
				},
				_ => break,
			}
		}
		self.now = target;
	}

	fn keys(&self) -> Vec<&str> {
		self
			.out
			.iter()
			.filter_map(|input| match input {
				Input::Key(sequence) => Some(sequence.as_str()),
				_ => None,
			})
			.collect()
	}

	fn reports(&self) -> Vec<Report> {
		self
			.out
			.iter()
			.filter_map(|input| match input {
				Input::Report(report) => Some(report.clone()),
				_ => None,
			})
			.collect()
	}

	fn pastes(&self) -> Vec<(&str, Option<&str>)> {
		self
			.out
			.iter()
			.filter_map(|input| match input {
				Input::Paste { text, enter } => Some((text.as_str(), enter.as_deref())),
				_ => None,
			})
			.collect()
	}
}

/// `text` as `VK_PACKET` key-down records, one per UTF-16 unit.
fn paste_records(text: &str) -> String {
	text.encode_utf16().fold(String::new(), |mut out, unit| {
		let _ = write!(out, "\x1b[231;0;{unit};1;0;1_");
		out
	})
}

/// `text` as the `Vk = 0` text records a VT host is relayed through.
fn relay_records(text: &str) -> Vec<String> {
	text
		.encode_utf16()
		.map(|unit| format!("\x1b[0;0;{unit};1;0;1_"))
		.collect()
}

// ── Bytes and text ─────────────────────────────────────────────────────────

#[test]
fn splits_text_and_escape_sequences_into_keys() {
	let mut h = Harness::new();
	h.feed("ab\x1b[A\x1b[<35;20;5m");
	assert_eq!(h.keys(), ["a", "b", "\x1b[A", "\x1b[<35;20;5m"]);
	assert_eq!(h.parser.deadline(), None);
}

#[test]
fn decodes_a_code_point_split_across_reads() {
	let mut h = Harness::new();
	let bytes = "a\u{4e16}🙂".as_bytes();
	h.feed_bytes(&bytes[..2]);
	assert_eq!(h.keys(), ["a"]);
	h.feed_bytes(&bytes[2..6]);
	assert_eq!(h.keys(), ["a", "\u{4e16}"]);
	h.feed_bytes(&bytes[6..]);
	assert_eq!(h.keys(), ["a", "\u{4e16}", "🙂"]);
}

#[test]
fn replaces_invalid_bytes_instead_of_stalling_on_them() {
	let mut h = Harness::new();
	h.feed_bytes(b"a\xffb");
	assert_eq!(h.keys(), ["a", "\u{fffd}", "b"]);
}

#[test]
fn ignores_an_empty_read() {
	let mut h = Harness::new();
	h.feed("\x1b");
	h.feed("");
	assert!(h.out.is_empty());
	// The held escape keeps its flush deadline.
	h.advance(100.0);
	assert_eq!(h.keys(), ["\x1b"]);
}

#[test]
fn delivers_a_bare_escape_after_the_50ms_flush_window() {
	let mut h = Harness::new();
	h.feed("\x1b");
	h.advance(49.0);
	assert!(h.out.is_empty());
	h.advance(1.0);
	assert_eq!(h.keys(), ["\x1b"]);
}

#[test]
fn a_tail_queued_behind_a_stalled_timer_still_completes_its_sequence() {
	// The loop stalled past the flush timeout: the overdue timer runs first,
	// then the read that was already waiting. The sequence must not be torn.
	let mut h = Harness::new();
	h.feed("\x1b[1;5");
	h.now = 400.0;
	h.tick();
	assert!(h.out.is_empty());
	assert_eq!(h.parser.deadline(), Some(400.0));
	h.feed("H");
	assert_eq!(h.keys(), ["\x1b[1;5H"]);
}

#[test]
fn holds_a_dangling_escape_while_the_kitty_keyboard_protocol_is_active() {
	let mut h = Harness::with(InputContext { kitty_active: true, ..InputContext::default() });
	h.feed("\x1b");
	h.advance(100.0);
	assert!(h.out.is_empty());
	h.feed("[27u");
	assert_eq!(h.keys(), ["\x1b[27u"]);
}

// ── Cooked typeahead (#17820) ──────────────────────────────────────────────

#[test]
fn restores_the_submit_enter_of_cooked_typeahead() {
	assert_eq!(restore_cooked_enter("hello\n").as_deref(), Some("hello\r"));
	// Earlier breaks stay line breaks of the draft; probe replies may follow.
	assert_eq!(restore_cooked_enter("a\nb\n\x1b[?1;2c\n").as_deref(), Some("a\nb\r\x1b[?1;2c\n"));
	// CRLF (a Windows console line) is left alone.
	assert_eq!(restore_cooked_enter("hello\r\n"), None);
	assert_eq!(restore_cooked_enter("hello"), None);
	assert_eq!(restore_cooked_enter("\x1b[?1;2c"), None);
	assert_eq!(restore_cooked_enter("\n").as_deref(), Some("\r"));
}

#[test]
fn applies_the_cooked_enter_fix_to_the_first_read_after_attach_only() {
	let mut h = Harness::new();
	h.parser.note_attach(true);
	h.feed("hi\n");
	h.advance(20.0);
	assert_eq!(h.keys(), ["h", "i", "\r"]);

	h.out.clear();
	h.feed("hi\n");
	h.advance(20.0);
	assert_eq!(h.keys(), ["h", "i", "\n"]);
}

#[test]
fn leaves_the_first_read_alone_when_input_was_already_raw() {
	let mut h = Harness::new();
	h.parser.note_attach(false);
	h.feed("hi\n");
	h.advance(20.0);
	assert_eq!(h.keys(), ["h", "i", "\n"]);
}

// ── Pastes ─────────────────────────────────────────────────────────────────

#[test]
fn reports_a_bracketed_paste_with_the_enter_that_shared_its_read() {
	let mut h = Harness::new();
	h.feed("\x1b[200~hello");
	assert!(h.parser.pasting());
	h.feed(" world\x1b[201~\rx");
	assert!(!h.parser.pasting());
	assert_eq!(h.pastes(), [("hello world", Some("\r"))]);
	assert_eq!(h.keys(), ["x"]);
}

#[test]
fn decodes_tmux_reencoded_controls_inside_a_paste() {
	let mut h = Harness::new();
	h.feed("\x1b[200~line1\x1b[27;5;106~line2\x1b[106;5uline3\x1b[201~");
	assert_eq!(h.pastes(), [("line1\nline2\nline3", None)]);
	assert!(h.keys().is_empty());
}

#[test]
fn classifies_an_unmarked_multiline_burst_as_a_paste() {
	let mut h = Harness::new();
	h.feed("line 1\rline 2\rline 3");
	assert_eq!(h.pastes(), [("line 1\rline 2\rline 3", None)]);
	assert!(h.keys().is_empty());
}

#[test]
fn consults_the_stall_verdict_only_once_bracketed_paste_is_confirmed() {
	// Unconfirmed terminal: the fallback classification is unconditional.
	let mut h = Harness::new();
	h.stalled = true;
	h.feed("aaa\rbbb\rccc");
	assert_eq!(h.pastes(), [("aaa\rbbb\rccc", None)]);

	// Confirmed DEC 2004 and a stalled loop: keystrokes the stall batched
	// into one read stay keys, so every Enter submits (#12540).
	let mut h =
		Harness::with(InputContext { raw_paste_stall_probe: true, ..InputContext::default() });
	h.stalled = true;
	h.feed("aaa\rbbb\rccc");
	assert!(h.pastes().is_empty());
	assert_eq!(h.keys(), ["a", "a", "a", "\r", "b", "b", "b", "\r", "c", "c", "c"]);

	// Confirmed and responsive: an input-method commit lands as one paste
	// (#13344).
	let mut h =
		Harness::with(InputContext { raw_paste_stall_probe: true, ..InputContext::default() });
	h.feed("aaa\rbbb\rccc");
	assert_eq!(h.pastes(), [("aaa\rbbb\rccc", None)]);
}

// ── Terminal reports ───────────────────────────────────────────────────────

#[test]
fn recognizes_probe_replies_without_forwarding_them() {
	let mut h = Harness::new();
	h.feed("\x1b[?2048;1$y\x1b[?0u\x1b[?62;4;22;28c\x1b[?997;1n\x1b[12;40Rx");
	assert_eq!(h.keys(), ["x"]);
	assert_eq!(h.reports(), [
		Report::PrivateMode { mode: 2048, status: 1 },
		Report::KittyKeyboard { flags: 0 },
		Report::DeviceAttributes { sixel: true },
		Report::AppearanceChanged,
		Report::CursorPosition { row: 12, column: 40 },
	]);
}

// #8542: a terminal Device-Attributes reply to the startup capability probe
// leaked into the composer as literal text (`1;22;...;52c`) when it arrived
// after the DA1 sentinel FIFO had already drained. `CSI ? … c` is exclusively
// a terminal->host report, never a keystroke, so it is consumed for the whole
// session lifetime.

#[test]
fn swallows_every_da_reply_however_many_arrive() {
	let mut h = Harness::new();
	for _ in 0..32 {
		h.feed("\x1b[?1;22;23;24;28;32;42;52c");
	}
	assert!(h.keys().is_empty());
	assert_eq!(h.reports().len(), 32);
}

#[test]
fn reassembles_and_swallows_a_da_reply_split_past_the_flush_window() {
	let mut h = Harness::new();
	// The prefix of a slow reply arrives alone and is flushed once the
	// timeout elapses mid-sequence.
	h.feed("\x1b[?1;22;23");
	h.advance(200.0);
	// Tail bytes arrive as ordinary input after the flush.
	h.feed(";24;28;32;42;52c");

	assert!(h.keys().is_empty());
	assert_eq!(h.reports(), [Report::DeviceAttributes { sixel: false }]);
}

#[test]
fn reassembles_a_da1_sixel_advertisement_split_past_the_flush_window() {
	let mut h = Harness::new();
	h.feed("\x1b[?61;4;6;7;14");
	h.advance(51.0);
	assert!(h.out.is_empty());
	h.feed(";21;22;23;24;28;32;42;52cx");

	assert_eq!(h.reports(), [Report::DeviceAttributes { sixel: true }]);
	assert_eq!(h.keys(), ["x"]);
}

#[test]
fn consumes_xtsmgraphics_replies_whole_or_split() {
	let mut h = Harness::new();
	h.feed("\x1b[?62;4;22;28c\x1b[?2;3;0Sx");
	assert_eq!(h.reports(), [Report::DeviceAttributes { sixel: true }, Report::SixelGraphics {
		supported: false,
	}]);
	assert_eq!(h.keys(), ["x"]);

	// Split across the stdin flush deadline.
	let mut h = Harness::new();
	h.feed("\x1b[?2;0;1692");
	h.advance(51.0);
	assert!(h.out.is_empty());
	h.feed(";432Sx");
	assert_eq!(h.reports(), [Report::SixelGraphics { supported: true }]);
	assert_eq!(h.keys(), ["x"]);
}

#[test]
fn reports_cell_size_replies_in_pixels_and_iterm2_points() {
	let mut h = Harness::new();
	h.feed("\x1b[6;18;9t");
	h.feed("\x1b]1337;ReportCellSize=17.5;8.25;2\x07");
	// No usable size: consumed without a report.
	h.feed("\x1b[6;0;0t");
	h.feed("x");
	assert_eq!(h.reports(), [Report::CellSize { height_px: 18, width_px: 9 }, Report::CellSize {
		height_px: 35,
		width_px:  17,
	},]);
	assert_eq!(h.keys(), ["x"]);
}

#[test]
fn reports_osc_replies_only_while_their_query_is_pending() {
	let mut h = Harness::with(InputContext {
		osc11_pending: true,
		osc99_pending: true,
		..InputContext::default()
	});
	h.feed("\x1b]11;rgb:0000/0000/0000\x07");
	h.feed("\x1b]99;i=omp-probe-1:p=?;p=title,body\x1b\\");
	assert_eq!(h.reports(), [
		Report::BackgroundColor { r: 0.0, g: 0.0, b: 0.0 },
		Report::NotificationCaps {
			meta:    "i=omp-probe-1:p=?".to_owned(),
			payload: "p=title,body".to_owned(),
		},
	]);
	assert!(h.keys().is_empty());

	// No query in flight: the same bytes are not ours to consume.
	let mut h = Harness::new();
	h.feed("\x1b]11;rgb:0000/0000/0000\x07");
	assert_eq!(h.keys(), ["\x1b]11;rgb:0000/0000/0000\x07"]);
	assert!(h.reports().is_empty());
}

#[test]
fn reports_tsp_messages_in_apc_form_and_glyph_and_status_replies() {
	let mut h = Harness::new();
	h.feed("\x1b_tsp;r;{\"r\":\"hello\"}\x1b\\");
	h.feed("\x1b]877;tsp;e;{\"ev\":\"ack\"}\x07");
	h.feed("\x1b_25a1;s;fmt=glyf\x1b\\");
	h.feed("\x1b]7501;?:states=working,blocked\x1b\\");
	assert!(h.keys().is_empty());
	assert_eq!(h.reports(), [
		Report::Tsp { sequence: "\x1b_tsp;r;{\"r\":\"hello\"}\x1b\\".to_owned() },
		Report::Tsp { sequence: "\x1b_tsp;e;{\"ev\":\"ack\"}\x1b\\".to_owned() },
		Report::Glyph { sequence: "\x1b_25a1;s;fmt=glyf\x1b\\".to_owned() },
		Report::ProgramStatus { states: Some(vec!["working".to_owned(), "blocked".to_owned()]) },
	]);
}

// ── DEC 2048 report fragments split across stdin reads ─────────────────────

#[test]
fn reflows_when_an_in_band_report_is_split_across_reads_inside_the_flush_window() {
	let mut h = Harness::in_band();
	h.feed("\x1b[48;40;160");
	h.feed(";800;1600t");
	assert_eq!(h.reports(), [Report::InBandResize {
		rows:      40,
		columns:   160,
		height_px: 800,
		width_px:  1600,
	}]);
	assert!(h.keys().is_empty());
}

#[test]
fn ignores_colon_subparameters_in_an_in_band_report() {
	// #4748: the grow-back report carries a spec-permitted subparameter.
	let mut h = Harness::in_band();
	h.feed("\x1b[48;30;100;600;1000:0t");
	assert_eq!(h.reports(), [Report::InBandResize {
		rows:      30,
		columns:   100,
		height_px: 600,
		width_px:  1000,
	}]);
}

#[test]
fn applies_and_swallows_a_report_whose_introducer_was_flushed_alone() {
	let mut h = Harness::in_band();
	h.feed("\x1b[");
	// The splitter flushes the introducer; the body stays inside the
	// introducer's 150ms grace window.
	h.advance(100.0);
	h.feed(REPORT_BODY);
	h.feed("t");

	assert!(h.keys().is_empty());
	assert_eq!(h.reports(), [RESIZE]);
}

#[test]
fn applies_a_report_split_at_the_type_field() {
	let mut h = Harness::in_band();
	h.feed("\x1b[4");
	h.advance(200.0);
	h.feed("8;61;211;1837;3131t");

	assert!(h.keys().is_empty());
	assert_eq!(h.reports(), [RESIZE]);
}

#[test]
fn applies_a_body_bundled_with_the_next_reports_introducer() {
	let mut h = Harness::in_band();
	// The exact delivery the iTerm2 trace captured.
	h.feed("\x1b[48;61;211;1837;3131\x1b[");
	h.advance(100.0);
	h.feed(REPORT_BODY);
	h.feed("t");

	assert!(h.keys().is_empty());
	assert_eq!(h.reports(), [RESIZE, RESIZE]);
}

#[test]
fn applies_a_body_that_arrives_without_its_terminator_and_swallows_the_delayed_one() {
	let mut h = Harness::in_band();
	h.feed("\x1b[48;61;211;1837;3131");
	h.advance(200.0);
	h.feed("t");

	assert!(h.keys().is_empty());
	assert_eq!(h.reports(), [RESIZE]);

	// The terminator was consumed; a later `t` is an ordinary keystroke.
	h.feed("t");
	assert_eq!(h.keys(), ["t"]);
}

#[test]
fn applies_the_report_and_forwards_a_keystroke_that_ended_a_held_body() {
	let mut h = Harness::in_band();
	h.feed("\x1b[48;61;211;1837;3131");
	h.advance(200.0);
	h.feed("x");

	assert_eq!(h.reports(), [RESIZE]);
	assert_eq!(h.keys(), ["x"]);
}

#[test]
fn holds_the_introducer_across_a_pending_private_csi_reply() {
	let mut h = Harness::in_band();
	// A probe partial is pending when the report's introducer arrives; the
	// private reply is dead either way, so the introducer must still be held.
	h.feed("\x1b[?1;2");
	h.advance(100.0);
	h.feed("\x1b[");
	h.advance(100.0);
	h.feed(REPORT_BODY);
	h.feed("t");

	assert!(h.keys().is_empty());
	assert_eq!(h.reports(), [RESIZE]);
}

#[test]
fn releases_a_held_introducer_that_no_body_follows() {
	let mut h = Harness::in_band();
	// The introducer is released to the input handler after the grace
	// window, so a later keystroke is not fused into a synthetic CSI.
	h.feed("\x1b[");
	h.advance(400.0);
	h.feed("a");

	assert_eq!(h.keys(), ["\x1b[", "a"]);
}

#[test]
fn still_forwards_a_split_csi_key_after_a_held_introducer() {
	let mut h = Harness::in_band();
	h.feed("\x1b[");
	h.advance(100.0);
	h.feed("A");

	assert_eq!(h.keys(), ["\x1b[A"]);
	assert!(h.reports().is_empty());
}

#[test]
fn discards_a_stale_report_head_when_an_input_drain_ends() {
	let mut h = Harness::in_band();
	h.feed("\x1b[");
	h.advance(100.0);
	h.parser.discard_report_head();
	h.feed("A");
	assert_eq!(h.keys(), ["A"]);
	assert_eq!(h.parser.deadline(), None);
}

// ── win32-input-mode ───────────────────────────────────────────────────────

#[test]
fn decodes_key_records_and_drops_releases() {
	let mut h = Harness::win32();
	h.feed(SHIFT_ENTER);
	h.feed(ENTER_UP);
	h.feed(CTRL_ENTER);
	// Plain VT keeps passing through next to the records.
	h.feed("\x1b[27;2;13~");
	assert_eq!(h.keys(), ["\x1b[13;2u", "\x1b[13;5u", "\x1b[27;2;13~"]);
}

#[test]
fn keeps_relayed_terminal_replies_out_of_the_composer_while_decoding_keys() {
	let mut h = Harness::win32();
	for record in relay_records("\x1b[?1;0c") {
		h.feed(&record);
	}
	h.feed(KEY_A);
	h.feed("\x1b[8;14;8;1;0;1_");
	h.feed("\x1b[67;46;3;1;8;1_");

	assert_eq!(h.keys(), ["a", "\x7f", "\x03"]);
	assert_eq!(h.reports(), [Report::DeviceAttributes { sixel: false }]);
}

#[test]
fn delivers_a_key_record_that_interrupts_a_partial_direct_terminal_reply() {
	let mut h = Harness::with(InputContext {
		win32_input: true,
		osc11_pending: true,
		..InputContext::default()
	});
	// The OSC 11 reply stalls past the flush window.
	h.feed("\x1b]11;rgb:1111/2222");
	h.advance(67.0);
	h.feed(KEY_A);
	h.feed("\x1b[66;48;98;1;0;1_");

	assert_eq!(h.keys(), ["a", "b"]);
	assert!(h.reports().is_empty());
}

#[test]
fn keeps_a_relayed_tsp_event_out_of_the_composer_when_its_tail_arrives_late() {
	// ConPTY relays an OSC 877 TSP event as one text record per byte. An
	// event-loop stall longer than the 75 ms Escape wait must not release
	// the head and then type the tail.
	let event = relay_records("\x1b]877;tsp;ack;{\"sf\":\"s:1\",\"s\":12}\x07");
	let mut h = Harness::win32();
	for record in &event[..20] {
		h.feed(record);
	}
	h.advance(217.0);
	for record in &event[20..] {
		h.feed(record);
	}
	h.feed(KEY_A);

	assert_eq!(h.keys(), ["a"]);
	assert_eq!(h.reports(), [Report::Tsp {
		sequence: "\x1b_tsp;ack;{\"sf\":\"s:1\",\"s\":12}\x1b\\".to_owned(),
	}]);
}

#[test]
fn keeps_a_relayed_tsp_event_intact_when_a_stalled_timer_fires_before_its_queued_tail() {
	let event = relay_records("\x1b]877;tsp;e;{\"ev\":\"ack\",\"sf\":\"s:1\",\"s\":12}\x07");
	// Split after the ESC record (the Escape wait is running) and inside the
	// string (the string wait is running).
	for (split, stall) in [(1, 75.0), (9, 5000.0)] {
		let mut h = Harness::win32();
		h.feed(&event[..split].concat());
		// The flush timer comes due during the stall, before stdin delivers the
		// rest of the record.
		h.now += stall;
		h.tick();
		h.feed(&event[split..].concat());
		h.feed(KEY_A);

		assert_eq!(h.out, [
			Input::Report(Report::Tsp {
				sequence: "\x1b_tsp;e;{\"ev\":\"ack\",\"sf\":\"s:1\",\"s\":12}\x1b\\".to_owned(),
			}),
			Input::Key("a".to_owned()),
		]);
	}
}

#[test]
fn keeps_a_relayed_tsp_event_out_of_the_composer_when_a_read_splits_one_of_its_records() {
	// The paste-marker normalizer holds the torn record for its own 75 ms
	// window, then hands it to the splitter; its expiry must not release the
	// held string head.
	let event = relay_records("\x1b]877;tsp;ack;{\"sf\":\"s:1\",\"s\":12}\x07");
	let torn = &event[20];
	let mut h = Harness::win32();
	h.feed(&format!("{}{}", event[..20].concat(), &torn[..6]));
	h.advance(87.0);
	assert!(h.out.is_empty());
	h.feed(&format!("{}{}", &torn[6..], event[21..].concat()));
	h.feed(KEY_A);

	assert_eq!(h.keys(), ["a"]);
	assert_eq!(h.reports().len(), 1);
}

#[test]
fn keeps_the_short_escape_wait_for_a_relayed_two_byte_alt_chord_head() {
	let mut h = Harness::win32();
	// `ESC ]` alone is also Alt+]; it must not wait the multi-second string
	// timeout.
	h.feed("\x1b[0;0;27;1;0;1_");
	h.feed("\x1b[0;0;93;1;0;1_");
	assert!(h.out.is_empty());
	h.advance(100.0);
	assert_eq!(h.keys(), ["\x1b]"]);
}

#[test]
fn delivers_a_lone_relayed_escape_after_the_flush_window_when_no_tail_arrives() {
	let mut h = Harness::win32();
	h.feed("\x1b[0;0;27;1;0;1_");
	assert!(h.out.is_empty());
	h.advance(100.0);
	assert_eq!(h.keys(), ["\x1b"]);
}

#[test]
fn pastes_line_breaks_the_console_host_sent_as_key_records() {
	// #14065: the paste arrives split mid-record across stdin reads.
	let mut h = Harness::win32();
	h.feed(&format!("\x1b[200~first{}", &ENTER[..6]));
	h.feed(&format!("{}{ENTER_UP}second\x1b[201~", &ENTER[6..]));
	// A later Enter submits.
	h.feed(ENTER);
	h.feed(ENTER_UP);

	assert_eq!(h.pastes(), [("first\rsecond", None)]);
	assert_eq!(h.keys(), ["\r"]);
}

#[test]
fn treats_paste_delimiters_encoded_as_key_records_as_framing_across_reads() {
	let start = "\x1b[200~".chars().fold(String::new(), |mut out, unit| {
		let _ = write!(out, "{}\x1b[231;0;0;0;0;1_", paste_records(&unit.to_string()));
		out
	});
	let end = paste_records("\x1b[201~");
	let mut h = Harness::win32();
	for read in [&start[..17], &start[17..], "https://example.com", &end[..31], &end[31..]] {
		h.feed(read);
	}
	assert_eq!(h.pastes(), [("https://example.com", None)]);
	assert!(h.keys().is_empty());
}

#[test]
fn decodes_record_encoded_payload_text_and_releases_inside_an_encoded_paste() {
	let mut h = Harness::win32();
	h.feed(&format!(
		"{}\x1b[231;0;126;0;0;1_{}{ENTER}{ENTER_UP}{}{}",
		paste_records("\x1b[200~"),
		paste_records("first"),
		paste_records("second"),
		paste_records("\x1b[201~"),
	));
	assert_eq!(h.pastes(), [("first\rsecond", None)]);
	assert!(h.keys().is_empty());
}

#[test]
fn turning_win32_input_off_delivers_the_input_it_still_holds() {
	// A late kitty reply retires the decoder; an Escape typed just before it
	// still belongs to the user.
	let mut h = Harness::win32();
	h.feed("\x1b[0;0;27;1;0;1_");
	assert!(h.out.is_empty());

	h.parser
		.set_context(InputContext { kitty_active: true, ..InputContext::default() });
	assert_eq!(h.parser.deadline(), Some(h.now));
	h.tick();
	assert_eq!(h.keys(), ["\x1b"]);
	assert_eq!(h.parser.deadline(), None);
}

#[test]
fn release_pending_delivers_held_relayed_input_at_once() {
	let mut h = Harness::win32();
	h.feed("\x1b[0;0;27;1;0;1_");
	h.parser.release_pending(&mut h.out);
	assert_eq!(h.keys(), ["\x1b"]);
	assert_eq!(h.parser.deadline(), None);
}

#[test]
fn reset_drops_everything_buffered() {
	let mut h = Harness::win32();
	h.feed("\x1b[0;0;27;1;0;1_");
	h.feed("\x1b[200~half a paste");
	h.feed_bytes(&"é".as_bytes()[..1]);
	h.parser.reset();
	assert_eq!(h.parser.deadline(), None);
	assert!(!h.parser.pasting());
	h.feed(KEY_A);
	assert_eq!(h.keys(), ["a"]);
	assert!(h.pastes().is_empty());
}
