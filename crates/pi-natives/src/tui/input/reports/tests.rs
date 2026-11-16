use super::*;

const ENTER_RECORD: &str = "\x1b[13;28;13;1;0;1_";
const RELAYED_ESC_RECORD: &str = "\x1b[0;0;27;1;0;1_";
const REPORT_BODY: &str = "\x1b[48;61;211;1837;3131";
const RESIZE: Report =
	Report::InBandResize { rows: 61, columns: 211, height_px: 1837, width_px: 3131 };

/// A sequence handler fed pre-split sequences, as the splitter delivers them.
struct Harness {
	reassembler: Reassembler,
	context:     InputContext,
	now:         Millis,
	out:         Vec<Input>,
}

impl Harness {
	fn new() -> Self {
		Self::with(InputContext::default())
	}

	fn with(context: InputContext) -> Self {
		Self { reassembler: Reassembler::default(), context, now: 0.0, out: Vec::new() }
	}

	fn in_band() -> Self {
		Self::with(InputContext { in_band_resize: true, ..InputContext::default() })
	}

	fn send(&mut self, sequence: &str) {
		self
			.reassembler
			.handle(self.now, &mut self.context, sequence.to_owned(), &mut self.out);
	}

	/// Deliver `text` one character per event: the tail of a sequence whose
	/// head was flushed on its own.
	fn send_chars(&mut self, text: &str) {
		for scalar in text.chars() {
			self.send(scalar.encode_utf8(&mut [0; 4]));
		}
	}

	fn tick(&mut self) {
		self
			.reassembler
			.tick(self.now, &mut self.context, &mut self.out);
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
}

// ── Recognizers ────────────────────────────────────────────────────────────

#[test]
fn recognizes_private_csi_partials() {
	assert!(is_private_csi_partial("\x1b[?"));
	assert!(is_private_csi_partial("\x1b[?1;22;23"));
	assert!(is_private_csi_partial("\x1b[?2026;2$"));
	assert!(!is_private_csi_partial("\x1b[?1;2c"));
	assert!(!is_private_csi_partial("\x1b[1;2"));
	assert!(!is_private_csi_partial("\x1b[?1$2"));
}

#[test]
fn parses_in_band_resize_reports_ignoring_subparameters() {
	assert_eq!(in_band_resize_report("\x1b[48;61;211;1837;3131t", true), Some(RESIZE));
	assert_eq!(in_band_resize_report(REPORT_BODY, false), Some(RESIZE));
	// A body is not a terminated report and vice versa.
	assert_eq!(in_band_resize_report(REPORT_BODY, true), None);
	assert_eq!(in_band_resize_report("\x1b[48;61;211;1837;3131t", false), None);
	// `:`-separated subparameters MUST be ignored (#4748).
	assert_eq!(
		in_band_resize_report("\x1b[48;30:1;100;600:2:3;1000:0t", true),
		Some(Report::InBandResize { rows: 30, columns: 100, height_px: 600, width_px: 1000 })
	);
	assert_eq!(in_band_resize_report("\x1b[48;61;211;1837t", true), None);
	assert_eq!(in_band_resize_report("\x1b[48;5u", true), None);
}

#[test]
fn parses_decrpm_da1_and_kitty_replies() {
	assert_eq!(
		private_mode_report("\x1b[?2048;1$y"),
		Some(Report::PrivateMode { mode: 2048, status: 1 })
	);
	assert_eq!(private_mode_report("\x1b[?2048;1y"), None);
	assert_eq!(kitty_keyboard_report("\x1b[?5u"), Some(Report::KittyKeyboard { flags: 5 }));
	assert_eq!(kitty_keyboard_report("\x1b[?u"), None);
	assert_eq!(kitty_keyboard_report("\x1b[97u"), None);

	let sixel = device_attributes_report;
	assert_eq!(sixel("\x1b[?62;4;22;28c"), Some(Report::DeviceAttributes { sixel: true }));
	assert_eq!(sixel("\x1b[?62;4c"), Some(Report::DeviceAttributes { sixel: true }));
	assert_eq!(sixel("\x1b[?61;6;22c"), Some(Report::DeviceAttributes { sixel: false }));
	// The conformance level and other attributes are not SIXEL.
	assert_eq!(sixel("\x1b[?4;14;24;42c"), Some(Report::DeviceAttributes { sixel: false }));
	assert_eq!(sixel("\x1b[?c"), Some(Report::DeviceAttributes { sixel: false }));
	assert_eq!(sixel("\x1b[c"), None);
}

#[test]
fn normalizes_osc_11_channels_of_every_width() {
	assert_eq!(
		background_color_report("\x1b]11;rgb:0000/ffff/8080\x07"),
		Some(Report::BackgroundColor { r: 0.0, g: 1.0, b: f64::from(0x8080) / f64::from(0xffff) })
	);
	assert_eq!(
		background_color_report("\x1b]11;rgba:0/f/80\x1b\\"),
		Some(Report::BackgroundColor { r: 0.0, g: 1.0, b: 128.0 / 255.0 })
	);
	assert_eq!(background_color_report("\x1b]11;rgb:0000/ffff/8080"), None);
	assert_eq!(background_color_report("\x1b]11;rgb:00000/ff/80\x07"), None);
	assert_eq!(background_color_report("\x1b]11;#000000\x07"), None);
}

#[test]
fn parses_osc_99_and_osc_7501_replies() {
	assert_eq!(
		notification_caps_report("\x1b]99;i=omp-probe-1:p=?;p=title,body:a=report\x1b\\"),
		Some(Report::NotificationCaps {
			meta:    "i=omp-probe-1:p=?".to_owned(),
			payload: "p=title,body:a=report".to_owned(),
		})
	);
	assert_eq!(notification_caps_report("\x1b]99;i=1\x07"), None);

	let states = |reply| match program_status_report(reply) {
		Some(Report::ProgramStatus { states }) => Some(states),
		_ => None,
	};
	assert_eq!(states("\x1b]7501;?\x07"), Some(None));
	// The spec allows whitespace around both keys and values.
	assert_eq!(
		states("\x1b]7501;?:v=1: states = working , blocked\x1b\\"),
		Some(Some(vec!["working".to_owned(), "blocked".to_owned()]))
	);
	assert_eq!(states("\x1b]7501;x\x07"), None);
}

#[test]
fn converts_tsp_input_to_apc_form_once_terminated() {
	let apc = "\x1b_tsp;e;{\"ev\":\"ack\"}\x1b\\";
	assert_eq!(complete_tsp_input(apc).as_deref(), Some(apc));
	assert_eq!(complete_tsp_input("\x1b_tsp;e;{\"ev\":\"ack\"}"), None);
	// An OSC 877 message may end with ST or BEL.
	assert_eq!(complete_tsp_input("\x1b]877;tsp;e;{\"ev\":\"ack\"}\x07").as_deref(), Some(apc));
	assert_eq!(complete_tsp_input("\x1b]877;tsp;e;{\"ev\":\"ack\"}\x1b\\").as_deref(), Some(apc));
	assert_eq!(complete_tsp_input("\x1b]877;tsp;e;{\"ev\":\"ack\"}"), None);
}

#[test]
fn parses_cursor_cell_size_and_sixel_graphics_replies() {
	assert_eq!(
		cursor_position_report("\x1b[12;40R"),
		Some(Report::CursorPosition { row: 12, column: 40 })
	);
	assert_eq!(cursor_position_report("\x1b[R"), None);

	assert_eq!(
		cell_size_report("\x1b[6;18;9t"),
		Some(Some(Report::CellSize { height_px: 18, width_px: 9 }))
	);
	// A reply without a usable size is consumed, not reported.
	assert_eq!(cell_size_report("\x1b[6;0;9t"), Some(None));
	assert_eq!(cell_size_report("\x1b[4;600;1000t"), None);
	// iTerm2 reports points, optionally with the display scale.
	assert_eq!(
		cell_size_report("\x1b]1337;ReportCellSize=17.5;8.25;2\x07"),
		Some(Some(Report::CellSize { height_px: 35, width_px: 17 }))
	);
	assert_eq!(
		cell_size_report("\x1b]1337;ReportCellSize=18;9\x1b\\"),
		Some(Some(Report::CellSize { height_px: 18, width_px: 9 }))
	);
	assert_eq!(cell_size_report("\x1b]1337;ReportCellSize=18.;9\x07"), None);

	let supported = |sequence| match sixel_graphics_report(sequence) {
		Some(Report::SixelGraphics { supported }) => Some(supported),
		_ => None,
	};
	assert_eq!(supported("\x1b[?2;0;1692;432S"), Some(true));
	// A terminal without SIXEL reports a zero geometry.
	assert_eq!(supported("\x1b[?2;0;0S"), Some(false));
	// Only status 0 is success; 1..3 are error/failure.
	assert_eq!(supported("\x1b[?2;3;1692;432S"), Some(false));
	assert_eq!(supported("\x1b[?2;3S"), None);
}

// ── Reassembly ─────────────────────────────────────────────────────────────

#[test]
fn forwards_plain_text_and_ordinary_keys() {
	let mut h = Harness::new();
	h.send("a");
	h.send("\x1b[A");
	h.send("\x1b");
	assert_eq!(h.keys(), ["a", "\x1b[A", "\x1b"]);
	assert!(h.reports().is_empty());
}

#[test]
fn reassembles_a_private_csi_reply_whose_tail_arrives_as_characters() {
	// #8542: the reply lands with no sentinel outstanding and must still never
	// reach the composer.
	let mut h = Harness::new();
	h.send("\x1b[?1;22;23");
	h.send_chars(";24;28;32;42;52c");
	assert!(h.keys().is_empty());
	assert_eq!(h.reports(), [Report::DeviceAttributes { sixel: false }]);
}

#[test]
fn a_new_escape_abandons_a_private_csi_partial() {
	let mut h = Harness::new();
	h.send("\x1b[?1;2");
	h.send("\x1b[A");
	h.send("x");
	assert_eq!(h.keys(), ["\x1b[A", "x"]);
}

#[test]
fn drops_a_private_csi_partial_that_diverges() {
	let mut h = Harness::new();
	h.send("\x1b[?1");
	h.send(" ");
	h.send("2");
	assert!(h.out.is_empty());
	h.send("x");
	assert_eq!(h.keys(), ["x"]);
}

#[test]
fn caps_the_private_csi_accumulator() {
	let mut h = Harness::new();
	h.send("\x1b[?1");
	for _ in 0..300 {
		h.send(";");
	}
	// 4 buffered bytes plus 253 `;` cross the 256 cap; the rest are keys again.
	assert_eq!(h.keys().len(), 47);
}

#[test]
fn applies_a_held_body_when_a_keystroke_ends_it_and_swallows_the_late_terminator() {
	let mut h = Harness::in_band();
	h.send(REPORT_BODY);
	assert!(h.out.is_empty());

	h.send("x");
	assert_eq!(h.reports(), [RESIZE]);
	assert_eq!(h.keys(), ["x"]);

	// iTerm2's delayed `t` is the terminator of the applied body…
	h.now += INBAND_TERMINATOR_GRACE_MS - 1.0;
	h.send("t");
	assert_eq!(h.keys(), ["x"]);
	// …and only one: the next `t` is typed.
	h.send("t");
	assert_eq!(h.keys(), ["x", "t"]);
}

#[test]
fn treats_t_as_a_keystroke_once_the_terminator_grace_passed() {
	let mut h = Harness::in_band();
	h.send(REPORT_BODY);
	h.send("x");
	h.now += INBAND_TERMINATOR_GRACE_MS;
	h.send("t");
	assert_eq!(h.keys(), ["x", "t"]);
}

#[test]
fn an_explicit_terminator_leaves_no_pending_late_terminator() {
	let mut h = Harness::in_band();
	h.send(REPORT_BODY);
	h.send("t");
	assert_eq!(h.reports(), [RESIZE]);
	h.send("t");
	assert_eq!(h.keys(), ["t"]);
}

#[test]
fn a_complete_report_replaces_a_stale_in_band_partial() {
	let mut h = Harness::in_band();
	h.send("\x1b[48;1;2");
	h.send("\x1b[48;61;211;1837;3131t");
	assert_eq!(h.reports(), [RESIZE]);
	assert!(h.keys().is_empty());
}

#[test]
fn forwards_a_reassembled_sequence_that_is_not_a_resize_report() {
	// A split kitty `CSI 48;…u` for a digit key.
	let mut h = Harness::in_band();
	h.send("\x1b[48");
	h.send_chars(";5u");
	assert_eq!(h.keys(), ["\x1b[48;5u"]);
	assert!(h.reports().is_empty());
}

#[test]
fn drops_a_garbled_in_band_report() {
	let mut h = Harness::in_band();
	h.send("\x1b[48;61");
	h.send(" ");
	assert!(h.out.is_empty());
	h.send("a");
	assert_eq!(h.keys(), ["a"]);
}

#[test]
fn holds_neither_partials_nor_introducers_while_in_band_resize_is_off() {
	let mut h = Harness::new();
	h.send("\x1b[4");
	h.send("\x1b[");
	assert_eq!(h.keys(), ["\x1b[4", "\x1b["]);
	assert_eq!(h.reassembler.deadline(), None);
	// A complete report is still applied.
	h.send("\x1b[48;61;211;1837;3131t");
	assert_eq!(h.reports(), [RESIZE]);
}

#[test]
fn splits_a_csi_bundled_with_the_next_escape() {
	let mut h = Harness::in_band();
	h.send("\x1b[48;61;211;1837;3131\x1b[");
	// The body is applied when the next introducer interrupts it, and that
	// introducer is held for its own body.
	assert_eq!(h.reports(), [RESIZE]);
	assert!(h.keys().is_empty());
	assert_eq!(h.reassembler.deadline(), Some(CSI_INTRODUCER_GRACE_MS));
}

#[test]
fn releases_a_held_introducer_after_the_grace_window() {
	let mut h = Harness::in_band();
	h.send("\x1b[");
	assert!(h.out.is_empty());

	h.now = CSI_INTRODUCER_GRACE_MS;
	h.tick();
	assert_eq!(h.keys(), ["\x1b["]);
	// A later keystroke is not fused into a synthetic CSI.
	h.send("a");
	assert_eq!(h.keys(), ["\x1b[", "a"]);
}

#[test]
fn reassembles_osc_11_fragments_only_while_a_query_is_pending() {
	let reply = Report::BackgroundColor {
		r: f64::from(0x1111) / 65535.0,
		g: f64::from(0x2222) / 65535.0,
		b: f64::from(0x3333) / 65535.0,
	};
	let mut h = Harness::with(InputContext { osc11_pending: true, ..InputContext::default() });
	h.send("\x1b]11;rgb:1111/2222");
	h.send_chars("/3333");
	h.send("\x07");
	assert_eq!(h.reports(), [reply]);
	assert!(h.keys().is_empty());
	// Answered: a second reply is not consumed.
	assert!(!h.context.osc11_pending);
	h.send("\x1b]11;rgb:1111/2222/3333\x07");
	assert_eq!(h.keys(), ["\x1b]11;rgb:1111/2222/3333\x07"]);
}

#[test]
fn a_new_escape_abandons_an_osc_11_fragment_and_is_delivered() {
	let mut h = Harness::with(InputContext { osc11_pending: true, ..InputContext::default() });
	h.send("\x1b]11;rgb:11");
	h.send("\x1b[A");
	h.send("x");
	assert_eq!(h.keys(), ["\x1b[A", "x"]);
	assert!(h.reports().is_empty());
}

#[test]
fn a_resolved_query_drops_its_reply_fragment() {
	let mut h = Harness::with(InputContext { osc11_pending: true, ..InputContext::default() });
	h.send("\x1b]11;rgb:11");
	// DA1 beat the reply: the session resolved the query as unsupported.
	h.reassembler.clear_background_color_reply();
	h.context.osc11_pending = false;
	h.send("x");
	assert_eq!(h.keys(), ["x"]);
}

#[test]
fn completes_a_string_reply_whose_st_arrives_on_its_own() {
	let mut h = Harness::with(InputContext { osc11_pending: true, ..InputContext::default() });
	h.send("\x1b]11;rgb:00/00/00");
	h.send("\x1b\\");
	assert_eq!(h.reports(), [Report::BackgroundColor { r: 0.0, g: 0.0, b: 0.0 }]);
}

#[test]
fn swallows_program_status_glyph_and_tsp_replies_for_the_whole_session() {
	let mut h = Harness::new();
	h.send("\x1b]7501;?:states=working,blocked\x1b\\");
	h.send("\x1b_25a1;s;fmt=glyf\x1b\\");
	h.send("\x1b_tsp;e;{");
	h.send_chars("\"ev\":\"ack\"}");
	h.send("\x1b\\");
	h.send("\x1b[?997;2n");
	assert!(h.keys().is_empty());
	assert_eq!(h.reports(), [
		Report::ProgramStatus { states: Some(vec!["working".to_owned(), "blocked".to_owned()]) },
		Report::Glyph { sequence: "\x1b_25a1;s;fmt=glyf\x1b\\".to_owned() },
		Report::Tsp { sequence: "\x1b_tsp;e;{\"ev\":\"ack\"}\x1b\\".to_owned() },
		Report::AppearanceChanged,
	]);
}

#[test]
fn drops_an_oversized_program_status_reply() {
	let mut h = Harness::new();
	h.send("\x1b]7501;?");
	h.send(&"x".repeat(MAX_PROGRAM_STATUS_REPLY_BYTES));
	assert!(h.out.is_empty());
	h.send("y");
	assert_eq!(h.keys(), ["y"]);
}

// ── win32-input-mode ───────────────────────────────────────────────────────

fn win32() -> Harness {
	Harness::with(InputContext { win32_input: true, ..InputContext::default() })
}

#[test]
fn a_key_record_interrupts_a_partial_direct_reply() {
	let mut h = win32();
	h.send("\x1b[?1;2");
	h.send(ENTER_RECORD);
	h.send("c");
	// The decoded key is not appended to the dead fragment, and neither is the
	// text after it.
	assert_eq!(h.keys(), ["\r", "c"]);
	assert!(h.reports().is_empty());
}

#[test]
fn passes_records_through_undecoded_while_win32_input_is_off() {
	let mut h = Harness::new();
	h.send(ENTER_RECORD);
	assert_eq!(h.keys(), [ENTER_RECORD]);
}

#[test]
fn releases_a_lone_relayed_escape_one_tick_after_its_timeout() {
	let mut h = win32();
	h.send(RELAYED_ESC_RECORD);
	assert!(h.out.is_empty());
	assert_eq!(h.reassembler.deadline(), Some(WIN32_RELAYED_ESCAPE_TIMEOUT_MS));

	h.now = WIN32_RELAYED_ESCAPE_TIMEOUT_MS;
	h.tick();
	assert!(h.out.is_empty());
	h.tick();
	assert_eq!(h.keys(), ["\x1b"]);
	assert_eq!(h.reassembler.deadline(), None);
}

#[test]
fn waits_the_string_timeout_for_a_relayed_osc() {
	let mut h = win32();
	for unit in "\x1b]877;tsp;e;".encode_utf16() {
		h.send(&format!("\x1b[0;0;{unit};1;0;1_"));
	}
	assert!(h.reassembler.has_pending_win32_string());
	assert_eq!(h.reassembler.deadline(), Some(WIN32_RELAYED_STRING_TIMEOUT_MS));

	// The tail completes the event: reported in APC form, never typed.
	for unit in "{\"a\":1}\x07".encode_utf16() {
		h.send(&format!("\x1b[0;0;{unit};1;0;1_"));
	}
	assert!(h.keys().is_empty());
	assert_eq!(h.reports(), [Report::Tsp { sequence: "\x1b_tsp;e;{\"a\":1}\x1b\\".to_owned() }]);
	assert_eq!(h.reassembler.deadline(), None);
}

#[test]
fn reset_forgets_fragments_and_held_input() {
	let mut h = win32();
	h.send("\x1b[?1;2");
	h.send(RELAYED_ESC_RECORD);
	h.reassembler.reset();
	assert_eq!(h.reassembler.deadline(), None);
	h.send("c");
	assert_eq!(h.keys(), ["c"]);
}
