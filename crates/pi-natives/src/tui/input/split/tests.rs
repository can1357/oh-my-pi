//! Tests for the sequence splitter.
//!
//! Based on code from `OpenTUI` (<https://github.com/anomalyco/opentui>)
//! MIT License - Copyright (c) 2025 opentui

use super::*;

const PASTE_START: &str = "\x1b[200~";
const PASTE_END: &str = "\x1b[201~";

/// A splitter driven by a virtual clock.
struct Harness {
	splitter: Splitter,
	now:      Millis,
	stalled:  bool,
	events:   Vec<Split>,
}

impl Harness {
	fn new() -> Self {
		Self::with(SplitterOptions { timeout_ms: 10.0, ..SplitterOptions::default() })
	}

	fn with(options: SplitterOptions) -> Self {
		Self {
			splitter: Splitter::new(options),
			now:      0.0,
			stalled:  false,
			events:   Vec::new(),
		}
	}

	fn kitty() -> Self {
		let mut harness = Self::new();
		harness.splitter.set_kitty_active(true);
		harness
	}

	fn feed(&mut self, data: &str) {
		self
			.splitter
			.process(self.now, data, self.stalled, &mut self.events);
	}

	/// Advance the clock, firing every timer that comes due on the way (each
	/// deferred stage is its own tick, like a zero-delay timer).
	fn advance(&mut self, ms: Millis) {
		let target = self.now + ms;
		for _ in 0..100_000 {
			match self.splitter.deadline() {
				Some(at) if at <= target => {
					self.now = self.now.max(at);
					self.splitter.tick(self.now, &mut self.events);
				},
				_ => break,
			}
		}
		self.now = target;
	}

	fn data(&self) -> Vec<&str> {
		self
			.events
			.iter()
			.filter_map(|event| match event {
				Split::Data(sequence) => Some(sequence.as_str()),
				Split::Paste { .. } => None,
			})
			.collect()
	}

	fn pastes(&self) -> Vec<&str> {
		self
			.events
			.iter()
			.filter_map(|event| match event {
				Split::Paste { text, .. } => Some(text.as_str()),
				Split::Data(_) => None,
			})
			.collect()
	}

	fn enters(&self) -> Vec<Option<&str>> {
		self
			.events
			.iter()
			.filter_map(|event| match event {
				Split::Paste { enter, .. } => Some(enter.as_deref()),
				Split::Data(_) => None,
			})
			.collect()
	}

	fn buffered(&self) -> String {
		self.splitter.buffered()
	}
}

/// `text` as one sequence per character.
fn chars(text: &str) -> Vec<String> {
	text.chars().map(String::from).collect()
}

// ── Regular characters ─────────────────────────────────────────────────────

#[test]
fn handles_unicode_characters() {
	let mut h = Harness::new();
	h.feed("hello \u{4e16}\u{754c}");
	assert_eq!(h.data(), ["h", "e", "l", "l", "o", " ", "\u{4e16}", "\u{754c}"]);
}

#[test]
fn emits_astral_code_points_as_one_text_sequence() {
	let mut h = Harness::new();
	h.feed("🙂");
	assert_eq!(h.data(), ["🙂"]);
}

// ── Partial escape sequences ───────────────────────────────────────────────

#[test]
fn buffers_incomplete_mouse_sgr_sequence() {
	let mut h = Harness::new();
	h.feed("\x1b");
	assert!(h.data().is_empty());
	assert_eq!(h.buffered(), "\x1b");

	h.feed("[<35");
	assert!(h.data().is_empty());
	assert_eq!(h.buffered(), "\x1b[<35");

	h.feed(";20;5m");
	assert_eq!(h.data(), ["\x1b[<35;20;5m"]);
	assert_eq!(h.buffered(), "");
}

#[test]
fn buffers_incomplete_csi_sequence() {
	let mut h = Harness::new();
	h.feed("\x1b[");
	assert!(h.data().is_empty());

	h.feed("1;");
	assert!(h.data().is_empty());

	h.feed("5H");
	assert_eq!(h.data(), ["\x1b[1;5H"]);
}

#[test]
fn buffers_split_across_many_chunks() {
	let mut h = Harness::new();
	for chunk in ["\x1b", "[", "<", "3", "5", ";", "2", "0", ";", "5", "m"] {
		h.feed(chunk);
	}
	assert_eq!(h.data(), ["\x1b[<35;20;5m"]);
}

#[test]
fn reassembles_an_osc_whose_st_is_split_exactly_at_the_chunk_boundary() {
	// Chunk 1 ends on the ESC of `ESC \`; chunk 2 opens with the `\`.
	// The resume overlap (`resume_search_from - 1`) must re-inspect the
	// trailing ESC, or the terminator is never seen and the payload
	// leaks via timeout flush as raw bytes.
	let mut h = Harness::new();
	h.feed("\x1b]52;c;aGVsbG8=\x1b");
	assert!(h.data().is_empty());
	assert_eq!(h.buffered(), "\x1b]52;c;aGVsbG8=\x1b");

	h.feed("\\");
	assert_eq!(h.data(), ["\x1b]52;c;aGVsbG8=\x1b\\"]);
	assert_eq!(h.buffered(), "");
}

#[test]
fn reassembles_a_dcs_whose_st_is_split_exactly_at_the_chunk_boundary() {
	let mut h = Harness::new();
	h.feed("\x1bPq#0;2;0;0;0\x1b");
	assert!(h.data().is_empty());

	h.feed("\\");
	assert_eq!(h.data(), ["\x1bPq#0;2;0;0;0\x1b\\"]);
	assert_eq!(h.buffered(), "");
}

#[test]
fn flushes_incomplete_sequence_after_timeout() {
	// Non-mouse CSI partial: ambiguous, so it flushes after the timeout.
	let mut h = Harness::new();
	h.feed("\x1b[1;5");
	assert!(h.data().is_empty());

	h.advance(20.0);
	assert_eq!(h.data(), ["\x1b[1;5"]);
}

#[test]
fn flush_waits_one_extra_tick_so_a_queued_tail_can_cancel_it() {
	// The timeout expiring only marks the flush due; the flush itself runs on
	// the next tick, after stdin had a turn to deliver the tail.
	let mut h = Harness::new();
	h.feed("\x1b[1;5");
	h.now = 10.0;
	h.splitter.tick(10.0, &mut h.events);
	assert!(h.data().is_empty());
	assert_eq!(h.splitter.deadline(), Some(10.0));

	h.feed("H");
	assert_eq!(h.data(), ["\x1b[1;5H"]);
	assert_eq!(h.splitter.deadline(), None);
}

#[test]
fn a_fresh_escape_after_the_timeout_flushes_the_stale_partial_first() {
	let mut h = Harness::new();
	h.feed("\x1b[1;5");
	h.now = 10.0;
	h.splitter.tick(10.0, &mut h.events);

	h.feed("\x1b[A");
	assert_eq!(h.data(), ["\x1b[1;5", "\x1b[A"]);
}

#[test]
fn holds_a_split_sgr_mouse_partial_past_the_flush_timeout_and_reassembles_it() {
	// `\x1b[<…` is unambiguously a mouse report: the partial must never
	// flush on timeout, or its tail leaks as typed text (settings search
	// filling with `[<35;8;16M`).
	let mut h = Harness::new();
	h.feed("\x1b[<35;8;16");
	h.advance(30.0);
	assert!(h.data().is_empty());

	h.feed("M");
	assert_eq!(h.data(), ["\x1b[<35;8;16M"]);
}

#[test]
fn delivers_a_held_mouse_partial_raw_once_the_hold_cap_expires() {
	let mut h = Harness::with(SplitterOptions {
		timeout_ms: 5.0,
		partial_hold_max_ms: 20.0,
		..SplitterOptions::default()
	});
	h.feed("\x1b[<35;8;16");
	h.advance(1000.0);
	// Tail never arrived: delivered as one raw sequence (ESC intact,
	// so downstream treats it as control data, not typed text).
	assert_eq!(h.data(), ["\x1b[<35;8;16"]);
}

#[test]
fn holds_a_lone_esc_while_the_kitty_protocol_is_active_and_joins_the_mouse_tail() {
	// Under kitty the ESC key arrives as \x1b[27u, so a bare \x1b is
	// always the head of a split sequence.
	let mut h = Harness::kitty();
	h.feed("\x1b");
	h.advance(30.0);
	assert!(h.data().is_empty());

	h.feed("[<35;8;16M");
	assert_eq!(h.data(), ["\x1b[<35;8;16M"]);
}

#[test]
fn flushes_a_lone_esc_after_timeout_when_the_kitty_protocol_is_inactive() {
	// Legacy terminals: a bare ESC is a real keypress and must not lag
	// behind the flush timeout by more than the deferral.
	let mut h = Harness::new();
	h.feed("\x1b");
	h.advance(10.0);
	assert_eq!(h.data(), ["\x1b"]);
}

// ── Double-ESC disambiguation ──────────────────────────────────────────────

#[test]
fn joins_a_held_bare_esc_with_a_following_csi_into_one_meta_sequence() {
	let mut h = Harness::new();
	h.feed("\x1b");
	h.feed("\x1b[B");
	assert_eq!(h.data(), ["\x1b\x1b[B"]);
}

#[test]
fn splits_a_bare_esc_from_a_following_sgr_mouse_report() {
	let mut h = Harness::new();
	h.feed("\x1b");
	h.feed("\x1b[<35;22;17M");
	assert_eq!(h.data(), ["\x1b", "\x1b[<35;22;17M"]);
}

#[test]
fn splits_a_trailing_double_esc_into_two_esc_events_after_the_timeout() {
	// A bare `\x1b\x1b` is two real Esc keypresses (or legacy alt+esc).
	// Key parsing recognizes nothing in the combined chunk, so emitting it
	// as one swallows double-escape gestures (#3857). Split on flush so
	// downstream handlers fire twice.
	let mut h = Harness::new();
	h.feed("\x1b\x1b");
	assert!(h.data().is_empty());
	h.advance(20.0);
	assert_eq!(h.data(), ["\x1b", "\x1b"]);
}

#[test]
fn preserves_legacy_alt_chords_batched_after_a_bare_esc() {
	for (input, chord) in
		[("\x1b\x1bX", "\x1bX"), ("\x1b\x1bd", "\x1bd"), ("\x1b\x1b\x7f", "\x1b\x7f")]
	{
		let mut h = Harness::new();
		h.feed(input);
		assert_eq!(h.data(), ["\x1b", chord]);
	}
}

#[test]
fn consumes_a_whole_meta_csi_arrow_in_one_chunk() {
	// alt+up is its own keypress and must never look like two ESC keys.
	let mut h = Harness::new();
	h.feed("\x1b\x1b[A");
	h.advance(20.0);
	assert_eq!(h.data(), ["\x1b\x1b[A"]);
}

// ── Mixed content ──────────────────────────────────────────────────────────

#[test]
fn handles_partial_sequence_with_preceding_characters() {
	let mut h = Harness::new();
	h.feed("abc\x1b[<35");
	assert_eq!(h.data(), ["a", "b", "c"]);
	assert_eq!(h.buffered(), "\x1b[<35");

	h.feed(";20;5m");
	assert_eq!(h.data(), ["a", "b", "c", "\x1b[<35;20;5m"]);
}

#[test]
fn takes_a_multibyte_character_after_esc_as_one_alt_chord() {
	let mut h = Harness::new();
	h.feed("\x1bé\x1bO\u{4e16}x");
	assert_eq!(h.data(), ["\x1bé", "\x1bO\u{4e16}", "x"]);
}

// ── Kitty keyboard protocol ────────────────────────────────────────────────

#[test]
fn handles_multiple_batched_kitty_events() {
	// Press 'a', release 'a', press 'b', release 'b'
	let mut h = Harness::new();
	h.feed("\x1b[97u\x1b[97;1:3u\x1b[98u\x1b[98;1:3u");
	assert_eq!(h.data(), ["\x1b[97u", "\x1b[97;1:3u", "\x1b[98u", "\x1b[98;1:3u"]);
}

#[test]
fn handles_kitty_functional_keys_with_event_type() {
	// Delete key release
	let mut h = Harness::new();
	h.feed("\x1b[3;1:3~");
	assert_eq!(h.data(), ["\x1b[3;1:3~"]);
}

#[test]
fn swallows_the_immediate_bare_duplicate_of_a_kitty_printable() {
	// Buggy double-report: CSI-u event plus the bare char in one write.
	let mut h = Harness::new();
	h.feed("\x1b[97ua");
	assert_eq!(h.data(), ["\x1b[97u"]);
}

#[test]
fn does_not_swallow_a_real_keystroke_after_the_dedup_window_expires() {
	let mut h = Harness::new();
	h.feed("\x1b[97u");
	h.advance(50.0);
	h.feed("a");
	assert_eq!(h.data(), ["\x1b[97u", "a"]);
}

// ── Mouse events ───────────────────────────────────────────────────────────

#[test]
fn handles_mouse_press_and_release_events() {
	let mut h = Harness::new();
	h.feed("\x1b[<0;10;5M");
	h.feed("\x1b[<0;10;5m");
	assert_eq!(h.data(), ["\x1b[<0;10;5M", "\x1b[<0;10;5m"]);
}

#[test]
fn handles_multiple_mouse_events() {
	let mut h = Harness::new();
	h.feed("\x1b[<35;1;1m\x1b[<35;2;2m\x1b[<35;3;3m");
	assert_eq!(h.data(), ["\x1b[<35;1;1m", "\x1b[<35;2;2m", "\x1b[<35;3;3m"]);
}

#[test]
fn handles_old_style_mouse_sequence() {
	// ESC[M + 3 characters.
	let mut h = Harness::new();
	h.feed("\x1b[M abc");
	assert_eq!(h.data(), ["\x1b[M ab", "c"]);
}

#[test]
fn buffers_incomplete_old_style_mouse_sequence() {
	let mut h = Harness::new();
	h.feed("\x1b[M");
	assert_eq!(h.buffered(), "\x1b[M");

	h.feed(" a");
	assert_eq!(h.buffered(), "\x1b[M a");

	h.feed("b");
	assert_eq!(h.data(), ["\x1b[M ab"]);
}

// ── Edge cases ─────────────────────────────────────────────────────────────

#[test]
fn ignores_empty_input() {
	let mut h = Harness::new();
	h.feed("");
	assert!(h.events.is_empty());
	assert_eq!(h.splitter.deadline(), None);
}

#[test]
fn handles_lone_escape_character_with_explicit_flush() {
	let mut h = Harness::new();
	h.feed("\x1b");
	assert!(h.data().is_empty());

	assert_eq!(h.splitter.flush_now(), ["\x1b"]);
}

#[test]
fn handles_very_long_sequences() {
	let long = format!("\x1b[{}H", "1;".repeat(50));
	let mut h = Harness::new();
	h.feed(&long);
	assert_eq!(h.data(), [long.as_str()]);
}

// ── Large plain-text bursts ────────────────────────────────────────────────

#[test]
fn splits_a_large_non_bracketed_burst_into_per_character_events() {
	// Pins the O(n) scan: a per-iteration slice would make this O(n²).
	let content = "0123456789abcdef".repeat(4096); // 64 KB
	let mut h = Harness::new();
	h.feed(&content);
	let data = h.data();
	assert_eq!(data.len(), content.len());
	assert_eq!(data.first(), Some(&"0"));
	assert_eq!(data.last(), Some(&"f"));
}

#[test]
fn keeps_escape_parsing_and_astral_characters_intact_inside_a_burst() {
	let mut h = Harness::new();
	h.feed("abc🙂\x1b[A\u{1f389}def\x1b[<35;20;5m\x1b");
	assert_eq!(h.data(), [
		"a",
		"b",
		"c",
		"🙂",
		"\x1b[A",
		"\u{1f389}",
		"d",
		"e",
		"f",
		"\x1b[<35;20;5m"
	]);
	assert_eq!(h.buffered(), "\x1b");
}

// ── Flush / clear ──────────────────────────────────────────────────────────

#[test]
fn flushes_incomplete_sequences() {
	let mut h = Harness::new();
	h.feed("\x1b[<35");
	assert_eq!(h.splitter.flush_now(), ["\x1b[<35"]);
	assert_eq!(h.buffered(), "");
}

#[test]
fn flush_returns_nothing_when_nothing_is_buffered() {
	let mut h = Harness::new();
	assert!(h.splitter.flush_now().is_empty());
}

#[test]
fn clear_drops_buffered_content_without_emitting() {
	let mut h = Harness::new();
	h.feed("\x1b[<35");
	assert_eq!(h.buffered(), "\x1b[<35");

	h.splitter.clear();
	assert_eq!(h.buffered(), "");
	assert!(h.events.is_empty());
}

#[test]
fn clear_cancels_pending_timeouts() {
	let mut h = Harness::new();
	h.feed("\x1b[<35");
	h.splitter.clear();

	// Wait longer than the timeout: nothing may be emitted.
	h.advance(15.0);
	assert!(h.events.is_empty());
	assert_eq!(h.splitter.deadline(), None);
}

// ── Bracketed paste ────────────────────────────────────────────────────────

#[test]
fn emits_paste_event_for_complete_bracketed_paste() {
	let mut h = Harness::new();
	h.feed(&format!("{PASTE_START}hello world{PASTE_END}"));

	assert_eq!(h.pastes(), ["hello world"]);
	assert!(h.data().is_empty()); // No data events during paste
}

#[test]
fn handles_paste_arriving_in_chunks() {
	let mut h = Harness::new();
	h.feed(PASTE_START);
	assert!(h.splitter.pasting());
	assert!(h.pastes().is_empty());

	h.feed("hello ");
	assert!(h.pastes().is_empty());

	h.feed("world\x1b[201~");
	assert_eq!(h.pastes(), ["hello world"]);
	assert!(h.data().is_empty());
	assert!(!h.splitter.pasting());
}

#[test]
fn handles_paste_with_input_before_and_after() {
	let mut h = Harness::new();
	h.feed("a");
	h.feed("\x1b[200~pasted\x1b[201~");
	h.feed("b");

	assert_eq!(h.data(), ["a", "b"]);
	assert_eq!(h.pastes(), ["pasted"]);
}

#[test]
fn routes_apc_replies_out_of_paste_content_before_the_paste_finishes() {
	let ack = "\x1b_tsp;e;{\"ev\":\"ack\",\"sf\":\"s:1\",\"s\":988}\x1b\\";
	let visible = "\x1b_tsp;e;{\"ev\":\"visible\",\"sf\":\"s:1\",\"visible\":false}\x1b\\";
	let mut h = Harness::new();

	h.feed(&format!("\x1b[200~hello {ack}"));
	assert_eq!(h.data(), [ack]);
	assert!(h.pastes().is_empty());

	h.feed(&format!("{visible}world\x1b[201~\r"));
	assert_eq!(h.data(), [ack, visible]);
	assert_eq!(h.pastes(), ["hello world"]);
	assert_eq!(h.enters(), [Some("\r")]);
}

#[test]
fn reassembles_apc_replies_split_at_every_byte_inside_a_paste() {
	let reply = "\x1b_tsp;e;{\"ev\":\"ack\",\"sf\":\"s:1\",\"s\":989}\x1b\\";
	let mut h = Harness::new();
	h.feed("\x1b[200~before");
	for byte in chars(reply) {
		h.feed(&byte);
	}
	h.feed("after\x1b[201~");

	assert_eq!(h.data(), [reply]);
	assert_eq!(h.pastes(), ["beforeafter"]);
}

#[test]
fn routes_conpty_tsp_reports_with_a_split_osc_prefix_and_bel_terminator() {
	let reply = "\x1b]877;tsp;e;{\"ev\":\"ack\",\"sf\":\"s:1\",\"s\":990}\x07";
	let mut h = Harness::new();
	h.feed("\x1b[200~before");
	for byte in chars(reply) {
		h.feed(&byte);
	}
	h.feed("after\x1b[201~");

	assert_eq!(h.data(), [reply]);
	assert_eq!(h.pastes(), ["beforeafter"]);
}

#[test]
fn preserves_non_apc_pasted_escapes_and_partial_end_markers() {
	let content = "before\x1b[31mred\x1b[0m\x1b[201after\x1b";
	let mut h = Harness::new();
	h.feed(&format!("\x1b[200~{content}"));
	h.feed("\x1b[201~");

	assert!(h.data().is_empty());
	assert_eq!(h.pastes(), [content]);
}

#[test]
fn handles_paste_with_newlines() {
	let mut h = Harness::new();
	h.feed("\x1b[200~line1\nline2\nline3\x1b[201~");

	assert_eq!(h.pastes(), ["line1\nline2\nline3"]);
	assert!(h.data().is_empty());
}

#[test]
fn handles_paste_with_unicode() {
	let mut h = Harness::new();
	h.feed("\x1b[200~Hello \u{4e16}\u{754c} \u{1f389}\x1b[201~");

	assert_eq!(h.pastes(), ["Hello \u{4e16}\u{754c} \u{1f389}"]);
	assert!(h.data().is_empty());
}

#[test]
fn assembles_paste_when_the_end_marker_is_split_across_chunks() {
	let mut h = Harness::new();
	h.feed("\x1b[200~hello world\x1b[201");
	assert!(h.pastes().is_empty());

	h.feed("~");
	assert_eq!(h.pastes(), ["hello world"]);
	assert!(h.data().is_empty());
}

#[test]
fn assembles_paste_when_the_markers_arrive_one_byte_at_a_time() {
	let mut h = Harness::new();
	for byte in chars("\x1b[200~ab\x1b[201~") {
		h.feed(&byte);
	}
	assert_eq!(h.pastes(), ["ab"]);
	assert!(h.data().is_empty());
}

#[test]
fn preserves_trailing_input_after_a_boundary_split_end_marker() {
	let mut h = Harness::new();
	h.feed("\x1b[200~paste\x1b");
	h.feed("[201~x");
	assert_eq!(h.pastes(), ["paste"]);
	assert_eq!(h.enters(), [None]);
	assert_eq!(h.data(), ["x"]);
}

// A paste-and-Enter burst arrives in one read from automation and from
// terminals that batch input. Splitting it lets an overlay the paste opens
// swallow the Enter, so the Enter stays on the paste event in both keyboard
// encodings; anything else after the paste keeps the normal data route.
#[test]
fn keeps_a_same_read_enter_on_the_paste_event() {
	// Legacy `\r`, legacy `\n`, kitty CSI-u, kitty CSI-u with an explicit
	// no-modifier field.
	for enter in ["\r", "\n", "\x1b[13u", "\x1b[13;1u"] {
		let mut h = Harness::new();
		h.feed(&format!("\x1b[200~paste\x1b[201~{enter}"));
		assert_eq!(h.pastes(), ["paste"]);
		assert_eq!(h.enters(), [Some(enter)]);
		assert!(h.data().is_empty());
	}
}

#[test]
fn routes_bytes_after_the_attached_enter_as_ordinary_input() {
	let mut h = Harness::new();
	h.feed("\x1b[200~paste\x1b[201~\rnext");
	assert_eq!(h.enters(), [Some("\r")]);
	assert_eq!(h.data(), ["n", "e", "x", "t"]);
}

#[test]
fn leaves_other_input_after_a_paste_on_the_data_route() {
	// A modified kitty Enter, a DA1 terminal report, an arrow key, printable
	// text.
	for sequence in ["\x1b[13;2u", "\x1b[?1;2c", "\x1b[A", "x"] {
		let mut h = Harness::new();
		h.feed(&format!("\x1b[200~paste\x1b[201~{sequence}"));
		assert_eq!(h.pastes(), ["paste"]);
		assert_eq!(h.enters(), [None]);
		assert_eq!(h.data(), [sequence]);
	}
}

#[test]
fn does_not_attach_an_enter_that_arrives_in_a_later_read() {
	let mut h = Harness::new();
	h.feed("\x1b[200~paste\x1b[201~");
	h.feed("\r");
	assert_eq!(h.enters(), [None]);
	h.advance(20.0);
	assert_eq!(h.data(), ["\r"]);
}

#[test]
fn does_not_end_the_paste_on_a_partial_end_marker_prefix_in_the_body() {
	// Body contains the first five bytes of the end marker but no `~`.
	let mut h = Harness::new();
	h.feed("\x1b[200~before\x1b[201");
	assert!(h.pastes().is_empty());

	h.feed("after\x1b[201~");
	assert_eq!(h.pastes(), ["before\x1b[201after"]);
	assert!(h.data().is_empty());
}

#[test]
fn reconstructs_a_large_paste_delivered_in_many_small_chunks() {
	let content = "0123456789abcdef".repeat(8192); // 128 KB
	let mut h = Harness::new();
	h.feed("\x1b[200~");
	for start in (0..content.len()).step_by(64) {
		h.feed(&content[start..start + 64]);
	}
	h.feed("\x1b[201~");

	assert_eq!(h.pastes(), [content.as_str()]);
	assert!(h.data().is_empty());
}

// ── Raw multiline paste burst (issue #5841) ────────────────────────────────

#[test]
fn coalesces_an_unbracketed_cr_delimited_burst_into_one_paste() {
	// Codex desktop delivers Cmd+V without \x1b[200~…\x1b[201~ markers, so
	// each interior CR would otherwise fire a submit and split the block.
	let mut h = Harness::new();
	h.feed("line 1\rline 2\rline 3");
	assert_eq!(h.pastes(), ["line 1\rline 2\rline 3"]);
	assert!(h.data().is_empty());
}

#[test]
fn coalesces_an_unbracketed_lf_delimited_burst_too() {
	let mut h = Harness::new();
	h.feed("line 1\nline 2\nline 3");
	assert_eq!(h.pastes(), ["line 1\nline 2\nline 3"]);
	assert!(h.data().is_empty());
}

#[test]
fn coalesces_a_crlf_delimited_three_line_burst() {
	let mut h = Harness::new();
	h.feed("line 1\r\nline 2\r\nline 3");
	assert_eq!(h.pastes(), ["line 1\r\nline 2\r\nline 3"]);
	assert!(h.data().is_empty());
}

#[test]
fn coalesces_one_raw_paste_split_across_adjacent_stdin_reads() {
	let mut h = Harness::new();
	h.feed("line 1\r");
	assert!(h.events.is_empty());

	h.feed("line 2\rline 3");
	assert_eq!(h.pastes(), ["line 1\rline 2\rline 3"]);
	assert!(h.data().is_empty());
}

#[test]
fn coalesces_a_paste_whose_first_line_was_delivered_before_a_break_only_read() {
	let mut h = Harness::new();
	h.feed("line 1");
	h.feed("\r");
	h.feed("line 2\rline 3");

	assert_eq!(h.data().concat(), "line 1");
	assert_eq!(h.pastes(), ["\rline 2\rline 3"]);
}

#[test]
fn leaves_a_single_enter_batched_with_a_following_keystroke_on_the_normal_path() {
	// The event loop can batch one Enter plus the next typed char into a
	// single stdin read; that is byte-identical to a two-line paste, so it
	// must keep the Enter's submit rather than coalesce (PR #5843 review).
	let mut h = Harness::new();
	h.feed("a\rb");
	assert!(h.events.is_empty());
	h.advance(10.0);
	assert_eq!(h.data(), ["a", "\r", "b"]);
	assert!(h.pastes().is_empty());
}

#[test]
fn leaves_a_two_line_burst_on_the_normal_path() {
	// One interior break is ambiguous.
	let mut h = Harness::new();
	h.feed("foo\rbar");
	assert!(h.events.is_empty());
	h.advance(10.0);
	assert_eq!(h.data(), ["f", "o", "o", "\r", "b", "a", "r"]);
	assert!(h.pastes().is_empty());
}

#[test]
fn leaves_a_lone_enter_as_a_normal_submit_keypress() {
	let mut h = Harness::new();
	h.feed("\r");
	assert!(h.events.is_empty());
	h.advance(10.0);
	assert_eq!(h.data(), ["\r"]);
	assert!(h.pastes().is_empty());
}

#[test]
fn leaves_typed_text_with_a_trailing_enter_on_the_normal_path() {
	let mut h = Harness::new();
	h.feed("hello\r");
	assert!(h.events.is_empty());
	h.advance(10.0);
	assert_eq!(h.data(), ["h", "e", "l", "l", "o", "\r"]);
	assert!(h.pastes().is_empty());
}

#[test]
fn does_not_coalesce_a_run_of_bare_enters() {
	let mut h = Harness::new();
	h.feed("\r\r");
	assert!(h.events.is_empty());
	h.advance(10.0);
	assert_eq!(h.data(), ["\r", "\r"]);
	assert!(h.pastes().is_empty());
}

#[test]
fn keeps_a_single_line_burst_on_the_per_character_data_path() {
	let mut h = Harness::new();
	h.feed("hello world");
	assert!(h.pastes().is_empty());
	assert_eq!(h.data(), chars("hello world"));
}

#[test]
fn does_not_treat_an_escape_bearing_chunk_as_a_raw_burst() {
	// A CSI arrow key next to a CR must keep its escape parsing.
	let mut h = Harness::new();
	h.feed("\x1b[A\rx");
	assert!(h.pastes().is_empty());
	assert_eq!(h.data(), ["\x1b[A", "\r", "x"]);
}

// Enter batched after the burst (issue #17820).

#[test]
fn submits_a_cr_that_follows_lf_delimited_text_instead_of_pasting_it_as_a_newline() {
	// An automation write plus its Enter, drained in one read by a
	// startup stall before bracketed paste is confirmed.
	let mut h = Harness::new();
	h.feed("line1\nline2\n\n- bullet a\n- bullet b\r");
	assert_eq!(h.pastes(), ["line1\nline2\n\n- bullet a\n- bullet b"]);
	assert_eq!(h.enters(), [Some("\r")]);
	assert!(h.data().is_empty());
}

#[test]
fn keeps_the_final_break_of_a_cr_delimited_paste_inside_the_paste() {
	// Terminals send every pasted newline as CR; a paste ending in a
	// newline must not submit itself.
	let mut h = Harness::new();
	h.feed("line 1\rline 2\rline 3\r");
	assert_eq!(h.pastes(), ["line 1\rline 2\rline 3\r"]);
	assert_eq!(h.enters(), [None]);
}

// Stall probe (issues #12540, #13344).

#[test]
fn replays_a_stall_batched_burst_split_across_same_tick_reads_as_keys() {
	// A stalled loop can drain the pty backlog as several reads before the
	// classification window fires. Once the accumulated candidate
	// classifies, the stall verdict must still turn it back into keystrokes
	// so each batched Enter submits instead of becoming a pasted newline.
	let mut h = Harness::new();
	h.stalled = true;
	h.feed("aaa\r");
	h.feed("bbb\r");
	h.feed("ccc");
	assert!(h.pastes().is_empty());
	assert_eq!(h.data(), ["a", "a", "a", "\r", "b", "b", "b", "\r", "c", "c", "c"]);
}

// ── Paste recovery ─────────────────────────────────────────────────────────

#[test]
fn recovers_from_a_lost_end_marker_via_the_inactivity_watchdog() {
	let mut h = Harness::with(SplitterOptions {
		timeout_ms: 10.0,
		paste_timeout_ms: 20.0,
		..SplitterOptions::default()
	});
	h.feed("\x1b[200~lost marker content");
	assert!(h.pastes().is_empty());

	h.advance(20.0);
	assert_eq!(h.pastes(), ["lost marker content"]);

	// Input is alive again after recovery.
	h.feed("a");
	assert_eq!(h.data(), ["a"]);
}

#[test]
fn does_not_let_terminal_acknowledgements_keep_a_lost_marker_paste_alive() {
	let reply = "\x1b_tsp;e;{\"ev\":\"ack\",\"sf\":\"s:1\",\"s\":988}\x1b\\";
	let mut h = Harness::new();
	h.feed("\x1b[200~pasted");
	for _ in 0..4 {
		h.advance(200.0);
		h.feed(reply);
	}
	h.advance(200.0);
	h.feed("x");

	assert_eq!(h.pastes(), ["pasted"]);
	assert_eq!(h.data(), [reply, reply, reply, reply, "x"]);
}

#[test]
fn keeps_an_incomplete_apc_on_the_report_path_when_paste_recovery_fires() {
	let reply = "\x1b_tsp;e;{\"ev\":\"ack\",\"sf\":\"s:1\",\"s\":989}\x1b\\";
	let mut h = Harness::new();
	h.feed(&format!("\x1b[200~pasted{}", &reply[..reply.len() - 1]));
	h.advance(1000.0);
	assert_eq!(h.pastes(), ["pasted"]);

	h.feed("\\x");
	assert_eq!(h.data(), [reply, "x"]);
}

#[test]
fn re_arms_the_watchdog_while_paste_chunks_keep_arriving() {
	let mut h = Harness::with(SplitterOptions {
		timeout_ms: 10.0,
		paste_timeout_ms: 50.0,
		..SplitterOptions::default()
	});
	h.feed("\x1b[200~part1 ");
	h.advance(20.0);
	h.feed("part2");
	h.advance(20.0);
	assert!(h.pastes().is_empty()); // still inside the re-armed window

	h.feed("\x1b[201~");
	assert_eq!(h.pastes(), ["part1 part2"]);
}

#[test]
fn aborts_paste_mode_when_the_byte_cap_is_exceeded() {
	let mut h = Harness::with(SplitterOptions {
		timeout_ms: 10.0,
		paste_byte_limit: 8,
		..SplitterOptions::default()
	});
	h.feed("\x1b[200~0123456789abcdef");
	assert_eq!(h.pastes(), ["0123456789abcdef"]);

	h.feed("x");
	assert_eq!(h.data(), ["x"]);
}

#[test]
fn counts_the_byte_cap_in_utf8_bytes_for_a_multibyte_paste() {
	let mut h = Harness::with(SplitterOptions {
		timeout_ms: 10.0,
		paste_byte_limit: 8,
		..SplitterOptions::default()
	});
	let content = "é".repeat(5); // 5 characters, 10 bytes
	h.feed(&format!("\x1b[200~{content}"));
	assert_eq!(h.pastes(), [content.as_str()]);
}

// ── Malformed escape bounds (issue #4073 case A) ───────────────────────────

#[test]
fn caps_a_malformed_csi_without_terminator_so_a_single_process_stays_bounded() {
	// A streamed run with no final byte in 0x40-0x7E must not leave the
	// whole prefix in the buffer to be re-inspected forever.
	let input = format!("\x1b[{}", ";".repeat(200_000));
	let mut h = Harness::new();
	h.feed(&input);
	// Cap-flush emitted the leading capped prefix as one raw sequence
	// so progress is guaranteed; the rest is per-scalar plain text.
	let data = h.data();
	assert!(!data.is_empty());
	assert!(data[0].len() < input.len());
	assert_eq!(h.buffered(), "");
}

#[test]
fn resumes_osc_terminator_search_across_chunks() {
	// A legit chunked OSC 5522 payload must not force a full re-scan
	// of the accumulated buffer per chunk. Delivery completes on the
	// terminator; only the assembled sequence is emitted.
	let chunk = "a".repeat(4096);
	let mut h = Harness::new();
	h.feed("\x1b]5522;type=read;");
	for _ in 0..127 {
		h.feed(&chunk);
	}
	h.feed(&format!("{}\x07", &chunk[..4095]));
	let data = h.data();
	assert_eq!(data.len(), 1);
	assert!(data[0].starts_with("\x1b]5522;"));
	assert!(data[0].ends_with('\x07'));
	assert_eq!(h.buffered(), "");
}

#[test]
fn caps_a_streamed_csi_garbage_run_so_the_buffer_never_grows_without_bound() {
	// After the cap fires, the buffer resets so subsequent chunks are
	// re-scanned fresh.
	let mut h = Harness::new();
	h.feed("\x1b[");
	// Ten 8 KiB chunks — the first exceeds MAX_CSI_BYTES (4 KiB) and
	// forces a cap-flush; the buffer must not retain the full run.
	let chunk = ";".repeat(8192);
	for _ in 0..10 {
		h.feed(&chunk);
	}
	assert!(h.buffered().len() < 8192);
}

#[test]
fn resets_the_string_search_hint_before_processing_paste_remainder() {
	// A stale OSC/DCS/APC resume offset must not be reused after paste
	// mode clears the buffer. Otherwise a complete post-paste string
	// sequence whose terminator is before the old offset is retained
	// and later flushed together with trailing text.
	let mut h = Harness::new();
	h.feed(&format!("\x1b]{}", "x".repeat(100)));
	h.feed("\x1b[200~paste\x1b[201~\x1b]z\x07abc");

	assert_eq!(h.data(), ["\x1b]z\x07", "a", "b", "c"]);
	assert_eq!(h.buffered(), "");
}

#[test]
fn discards_an_unterminated_osc_delivered_as_one_oversized_chunk() {
	// A chunk whose OSC payload exceeds the cap with no BEL/ST is torn
	// protocol data: delivering it as raw sequences would type the tail
	// into the focused component as thousands of keystrokes. The junk head
	// is dropped and discard mode swallows everything up to the stream's
	// own terminator.
	let head = "\x1b]5522;";
	let mut h = Harness::new();
	h.feed(&format!("{head}{}xy", "a".repeat(MAX_STRING_SEQ_BYTES - head.len())));

	assert!(h.events.is_empty());
	assert_eq!(h.buffered(), "");

	// Still mid-string: further payload is swallowed, not typed.
	h.feed("zzzz");
	assert!(h.events.is_empty());

	// The torn string's own terminator ends discard mode; input after
	// it parses normally.
	h.feed("tail\x1b\\\x1b]z\x07abc");
	assert_eq!(h.data(), ["\x1b]z\x07", "a", "b", "c"]);
	assert_eq!(h.buffered(), "");
}

#[test]
fn string_discard_recovers_when_the_stream_stops_without_a_terminator() {
	let head = "\x1b]5522;";
	let mut h = Harness::new();
	h.feed(&format!("{head}{}", "a".repeat(MAX_STRING_SEQ_BYTES - head.len())));
	assert!(h.events.is_empty());

	h.advance(STRING_DISCARD_INACTIVITY_MS);
	h.feed("ok");
	assert_eq!(h.data(), ["o", "k"]);
}

// ── Stalled string sequences (OSC 5522 paste) ──────────────────────────────

const HEAD: &str = "\x1b]5522;type=read:status=DATA:mime=dGV4dC9wbGFpbg==;SGVsbG8s";

#[test]
fn completes_an_osc_5522_packet_whose_payload_stalls_for_seconds() {
	// A packet stalled past the flush window (a dictation app serving the
	// clipboard slowly) must not be torn and its base64 payload typed into
	// the composer as text. A tail within the abandonment plus dormant
	// window (15 s) still completes it.
	let mut h = Harness::new();
	h.feed(HEAD);
	h.advance(14_000.0);
	assert!(h.events.is_empty());

	h.feed("IHdvcmxkIQ==\x1b");
	h.feed("\\");
	assert_eq!(h.data(), [format!("{HEAD}IHdvcmxkIQ==\x1b\\")]);
}

#[test]
fn drops_an_abandoned_string_head_when_a_key_arrives_and_delivers_that_key() {
	// Enter, Up arrow, a space in a base64 payload.
	for key in ["\r", "\x1b[A", " "] {
		let mut h = Harness::new();
		h.feed(HEAD);
		h.feed(&format!("{key}a"));
		assert_eq!(h.data(), [key, "a"]);
		assert_eq!(h.buffered(), "");
	}
}

#[test]
fn keeps_a_one_byte_read_inside_the_packet_when_chunking_splits_the_payload() {
	// SSH/tmux chunking does not follow terminal writes: a lone payload
	// byte arriving right after the head is still part of the packet.
	let mut h = Harness::new();
	h.feed(HEAD);
	h.feed("I");
	h.feed("HdvcmxkIQ==\x1b\\");
	assert_eq!(h.data(), [format!("{HEAD}IHdvcmxkIQ==\x1b\\")]);
}

#[test]
fn replays_keys_typed_into_a_stalled_head_once_a_control_key_abandons_it() {
	let mut h = Harness::new();
	h.feed(HEAD);
	h.advance(200.0);
	h.feed("h");
	h.advance(200.0);
	h.feed("i");
	h.feed("\r");
	assert_eq!(h.data(), ["h", "i", "\r"]);
	assert_eq!(h.buffered(), "");
}

#[test]
fn abandons_a_head_with_no_reads_for_the_bound_and_replays_the_keys_typed_into_it() {
	let mut h = Harness::new();
	h.feed(HEAD);
	h.advance(200.0);
	h.feed("h");
	h.advance(200.0);
	h.feed("i");
	h.advance(4000.0);
	assert!(h.events.is_empty());

	h.advance(1000.0);
	assert_eq!(h.data(), ["h", "i"]);
	assert_eq!(h.buffered(), "");

	// The terminal's late tail still completes the packet, not typed.
	h.feed("IHdvcmxkIQ==\x1b\\");
	assert_eq!(h.data(), ["h".to_owned(), "i".to_owned(), format!("{HEAD}IHdvcmxkIQ==\x1b\\")]);
}

#[test]
fn keeps_legacy_alt_chords_batched_with_keys_on_the_key_timer_without_kitty() {
	// Terminal replies open a known way (a numeric OSC command, a DCS or
	// APC reply prefix); a chord plus keys that diverges is not a string.
	// Alt+], Alt+P, Alt+_, and Alt+_ diverging from a TSP opener.
	let cases: [&[&str]; 4] = [&["\x1b]a"], &["\x1bPa"], &["\x1b_a"], &["\x1b_t", "x"]];
	for reads in cases {
		let mut h = Harness::new();
		for read in reads {
			h.feed(read);
		}
		h.advance(100.0);
		assert_eq!(h.data(), [reads.concat()]);
		assert_eq!(h.buffered(), "");
	}
}

#[test]
fn keeps_ecma_48_format_effectors_inside_a_dcs_reply() {
	let reply = "\x1bP1+r544e\r\n=787465726d\x1b\\";
	let mut h = Harness::new();
	h.feed(reply);
	assert_eq!(h.data(), [reply]);
}

#[test]
fn starts_fresh_tracking_for_a_head_that_follows_a_flushed_one() {
	// Stale tracking from the flushed head would make a payload byte that
	// arrived right after the new head look like typing after a stall.
	let mut h = Harness::new();
	h.feed(HEAD);
	h.advance(1000.0);
	assert!(h.splitter.flush_now().is_empty());
	h.feed(HEAD);
	h.feed("I");
	h.feed("\r");
	assert_eq!(h.data(), ["\r"]);
}

#[test]
fn delivers_a_non_payload_key_typed_into_a_stalled_head_exactly_once() {
	let mut h = Harness::new();
	h.feed(HEAD);
	h.advance(200.0);
	h.feed(" ");
	assert_eq!(h.data(), [" "]);
}

#[test]
fn keeps_a_slow_transfer_alive_while_its_chunks_keep_arriving() {
	// Chunks spaced past the flush window over a slow link must keep
	// refreshing the abandonment bound, or the abandoned payload is
	// replayed as typed base64.
	let mut h = Harness::new();
	h.feed(HEAD);
	for _ in 0..20 {
		h.advance(1000.0);
		h.feed("QUJD");
	}
	h.feed("\x1b\\");
	assert_eq!(h.data(), [format!("{HEAD}{}\x1b\\", "QUJD".repeat(20))]);
}

#[test]
fn never_types_multi_byte_payload_when_a_stalled_transfer_dies() {
	let mut h = Harness::new();
	h.feed(HEAD);
	h.advance(200.0);
	h.feed("QUJDREVG");
	h.advance(5000.0);
	assert!(h.events.is_empty());
	assert_eq!(h.buffered(), "");
}

#[test]
fn lets_an_abandoned_head_expire_so_later_bursts_are_delivered() {
	let mut h = Harness::new();
	h.feed(HEAD);
	h.advance(5000.0 + 10_000.0);
	h.feed("hello");
	assert_eq!(h.data(), ["h", "e", "l", "l", "o"]);
}

#[test]
fn drops_a_resumed_head_for_good_when_it_is_abandoned_again() {
	let mut h = Harness::new();
	h.feed(HEAD);
	h.advance(5000.0);
	h.feed("QUJD");
	h.advance(5000.0);
	h.feed("hello");
	assert_eq!(h.data(), ["h", "e", "l", "l", "o"]);
}

#[test]
fn completes_an_abandoned_head_when_a_late_lone_terminator_arrives() {
	// A lone BEL, and the backslash of a split ST.
	for (tail, terminator) in [("", "\x07"), ("\x1b", "\\")] {
		let mut h = Harness::new();
		h.feed(&format!("{HEAD}{tail}"));
		h.advance(5000.0);
		h.feed(terminator);
		assert_eq!(h.data(), [format!("{HEAD}{tail}{terminator}")]);
	}
}

#[test]
fn completes_an_abandoned_head_when_a_late_st_arrives_split_under_kitty() {
	let mut h = Harness::kitty();
	h.feed(HEAD);
	h.advance(5000.0);
	h.feed("\x1b");
	h.feed("\\");
	assert_eq!(h.data(), [format!("{HEAD}\x1b\\")]);
}
