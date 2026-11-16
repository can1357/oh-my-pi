use std::fmt::Write as _;

use super::*;

// Records as the Windows console host emits them: CSI Vk;Sc;Uc;Kd;Cs;Rc _
const SHIFT_ENTER: &str = "\x1b[13;28;13;1;16;1_";
const CTRL_ENTER: &str = "\x1b[13;28;10;1;8;1_";
const CTRL_J: &str = "\x1b[74;36;10;1;8;1_";
const ENTER: &str = "\x1b[13;28;13;1;0;1_";
const ENTER_UP: &str = "\x1b[13;28;13;0;0;1_";

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

fn decode(decoder: &mut Win32InputModeDecoder, data: &str) -> Option<Vec<String>> {
	let mut keys = Vec::new();
	decoder.decode(data, &mut keys).then_some(keys)
}

fn decode_all(decoder: &mut Win32InputModeDecoder, records: &[String]) -> Vec<String> {
	let mut keys = Vec::new();
	for record in records {
		assert!(decoder.decode(record, &mut keys));
	}
	keys
}

fn decode_one(data: &str) -> String {
	let keys = decode(&mut Win32InputModeDecoder::default(), data).expect("a key record");
	assert_eq!(keys.len(), 1, "{data:?} decoded to {keys:?}");
	keys.into_iter().next().unwrap_or_default()
}

#[test]
fn keeps_shift_enter_and_ctrl_enter_distinct_from_enter() {
	assert_eq!(decode_one(ENTER), "\r");
	// kitty CSI-u: shift+enter and ctrl+enter.
	assert_eq!(decode_one(SHIFT_ENTER), "\x1b[13;2u");
	assert_eq!(decode_one(CTRL_ENTER), "\x1b[13;5u");
}

#[test]
fn keeps_ctrl_j_with_uc_lf_as_ctrl_j() {
	// Not a raw LF, which the editor would treat as Enter.
	assert_eq!(decode_one(CTRL_J), "\x1b[106;5u");
}

#[test]
fn drops_key_releases_and_bare_modifier_presses() {
	let mut decoder = Win32InputModeDecoder::default();
	assert_eq!(decode(&mut decoder, ENTER_UP), Some(vec![]));
	assert_eq!(decode(&mut decoder, "\x1b[16;42;0;1;16;1_"), Some(vec![]));
	assert_eq!(decode(&mut decoder, "\x1b[17;29;0;1;8;1_"), Some(vec![]));
}

#[test]
fn passes_non_record_sequences_through_untouched() {
	let mut decoder = Win32InputModeDecoder::default();
	assert_eq!(decode(&mut decoder, "\x1b[A"), None);
	assert_eq!(decode(&mut decoder, "\x1b[200~"), None);
	assert_eq!(decode(&mut decoder, "a"), None);
}

#[test]
fn decodes_text_control_and_alt_chords_to_the_legacy_bytes_key_matching_expects() {
	assert_eq!(decode_one("\x1b[65;30;97;1;0;1_"), "a");
	assert_eq!(decode_one("\x1b[65;30;65;1;16;1_"), "A");
	assert_eq!(decode_one("\x1b[67;46;3;1;8;1_"), "\x03"); // ctrl+c
	assert_eq!(decode_one("\x1b[66;48;98;1;2;1_"), "\x1bb"); // alt+b
	assert_eq!(decode_one("\x1b[9;15;9;1;16;1_"), "\x1b[Z"); // shift+tab
	assert_eq!(decode_one("\x1b[8;14;8;1;2;1_"), "\x1b\x7f"); // alt+backspace
	assert_eq!(decode_one("\x1b[27;1;27;1;0;1_"), "\x1b"); // escape
}

#[test]
fn keeps_ctrl_shift_letter_distinct_from_ctrl_letter() {
	// ctrl+shift+p as CSI-u, not the `\x10` ctrl+p collapses onto.
	assert_eq!(decode_one("\x1b[80;25;16;1;24;1_"), "\x1b[112;6u");
}

#[test]
fn encodes_navigation_keys_with_their_modifiers() {
	assert_eq!(decode_one("\x1b[38;72;0;1;256;1_"), "\x1b[A"); // up
	assert_eq!(decode_one("\x1b[38;72;0;1;264;1_"), "\x1b[1;5A"); // ctrl+up
	assert_eq!(decode_one("\x1b[46;83;0;1;256;1_"), "\x1b[3~"); // delete
	assert_eq!(decode_one("\x1b[116;63;0;1;0;1_"), "\x1b[15~"); // f5
	assert_eq!(decode_one("\x1b[112;59;0;1;0;1_"), "\x1bOP"); // f1 (SS3)
	assert_eq!(decode_one("\x1b[112;59;0;1;16;1_"), "\x1b[1;2P"); // shift+f1
}

#[test]
fn emits_altgr_composed_text_instead_of_a_ctrl_alt_chord() {
	// German layout: AltGr+Q → "@" reported as Right Alt + Left Ctrl.
	assert_eq!(decode_one("\x1b[81;16;64;1;9;1_"), "@");
}

#[test]
fn emits_text_a_dead_key_composed_onto_space_enter_and_tab() {
	// US-International: `'` then Space types `'`; `"` then Space types `"`.
	assert_eq!(decode_one("\x1b[32;57;39;1;0;1_"), "'");
	assert_eq!(decode_one("\x1b[32;57;34;1;0;1_"), "\"");
	// `'` then Enter: the quote rides an Enter record, then Enter itself
	// follows.
	let mut decoder = Win32InputModeDecoder::default();
	assert_eq!(decode(&mut decoder, "\x1b[13;28;39;1;0;1_"), Some(vec!["'".to_owned()]));
	assert_eq!(decode(&mut decoder, ENTER), Some(vec!["\r".to_owned()]));
	assert_eq!(decode_one("\x1b[9;15;39;1;0;1_"), "'");
	// Plain Space and Shift+Space stay a space.
	assert_eq!(decode_one("\x1b[32;57;32;1;0;1_"), " ");
	assert_eq!(decode_one("\x1b[32;57;32;1;16;1_"), " ");
}

#[test]
fn joins_surrogate_halves_delivered_as_separate_records() {
	let mut decoder = Win32InputModeDecoder::default();
	assert_eq!(decode(&mut decoder, "\x1b[231;0;55357;1;0;1_"), Some(vec![]));
	assert_eq!(decode(&mut decoder, "\x1b[231;0;56832;1;0;1_"), Some(vec!["😀".to_owned()]));
}

#[test]
fn delivers_alt_numpad_composition_on_the_alt_release() {
	assert_eq!(decode_one("\x1b[18;56;233;0;32;1_"), "é");
}

#[test]
fn repeats_auto_repeated_keys() {
	let keys = decode(&mut Win32InputModeDecoder::default(), "\x1b[65;30;97;1;0;3_");
	assert_eq!(keys, Some(vec!["a".to_owned(); 3]));
}

#[test]
fn decodes_key_records_inside_a_paste_as_typed_text() {
	let mut decoder = Win32InputModeDecoder::default();
	// Blank line: two Enter down/up pairs; emoji: surrogate halves as VK_PACKET
	// records.
	let pasted =
		format!("a{ENTER}{ENTER_UP}{ENTER}{ENTER_UP}b\x1b[231;0;55357;1;0;1_\x1b[231;0;56832;1;0;1_");
	assert_eq!(decoder.decode_paste(pasted), "a\r\rb😀");
	// Record-shaped text without ESC is ordinary pasted content.
	assert_eq!(
		decoder.decode_paste("see [13;28;13;1;0;1_ here".to_owned()),
		"see [13;28;13;1;0;1_ here"
	);
	// Other escape sequences in the paste are left alone.
	assert_eq!(decoder.decode_paste(format!("\x1b[31mred{ENTER}\x1b[0m")), "\x1b[31mred\r\x1b[0m");
}

#[test]
fn reassembles_escape_sequences_a_vt_host_relays_as_one_text_record_per_byte() {
	// Captured from ConPTY when the host terminal writes `ESC [ 1 ; 3 A`
	// (Alt+Up).
	let mut decoder = Win32InputModeDecoder::default();
	assert_eq!(decode_all(&mut decoder, &relay_records("\x1b[1;3A")), ["\x1b[1;3A"]);
	assert_eq!(decode_all(&mut decoder, &relay_records("\x1b\x1b[A")), ["\x1b\x1b[A"]);
	assert!(!decoder.has_pending_sequence());

	// A lone relayed ESC is held, then released as Escape; plain text is not
	// held.
	assert!(decode_all(&mut decoder, &relay_records("\x1b")).is_empty());
	assert_eq!(decoder.flush_pending_sequence().as_deref(), Some("\x1b"));
	assert_eq!(decode_all(&mut decoder, &relay_records("x")), ["x"]);
	// A real key record ends a held ESC instead of being swallowed into it.
	decode_all(&mut decoder, &relay_records("\x1b"));
	assert_eq!(decode(&mut decoder, ENTER), Some(vec!["\x1b".to_owned(), "\r".to_owned()]));

	// Escape then Alt+d stays two keys; only `ESC ESC [` / `ESC ESC O` group as
	// meta-CSI/SS3.
	assert_eq!(decode_all(&mut decoder, &relay_records("\x1b\x1bd")), ["\x1b", "\x1bd"]);
	assert!(!decoder.has_pending_sequence());
}

#[test]
fn reports_a_held_osc_dcs_apc_string_so_the_caller_can_wait_for_its_terminator() {
	let mut decoder = Win32InputModeDecoder::default();
	assert!(decode_all(&mut decoder, &relay_records("\x1b]877;tsp;e;")).is_empty());
	assert!(decoder.has_pending_sequence());
	assert!(decoder.has_pending_string());
	assert_eq!(decode_all(&mut decoder, &relay_records("{\"a\":1}\x07")), [
		"\x1b]877;tsp;e;{\"a\":1}\x07"
	]);
	assert!(!decoder.has_pending_string());

	// A bare introducer may still be an Alt chord (Alt+], Alt+P, Alt+_).
	decode_all(&mut decoder, &relay_records("\x1b]"));
	assert!(decoder.has_pending_sequence());
	assert!(!decoder.has_pending_string());
	decoder.flush_pending_sequence();

	// A lone ESC or a CSI prefix is not a string: it keeps the short Escape
	// timeout.
	decode_all(&mut decoder, &relay_records("\x1b"));
	assert!(!decoder.has_pending_string());
	decoder.flush_pending_sequence();
	decode_all(&mut decoder, &relay_records("\x1b[1;"));
	assert!(!decoder.has_pending_string());
}

#[test]
fn rejects_records_with_too_many_fields_and_bounds_the_repeat_count() {
	assert!(parse_record("\x1b[65;30;97;1;0;1;7_").is_none());
	let record = parse_record("\x1b[65;30;97;1;0;4000000000_").expect("a key record");
	assert_eq!(record.repeat, u32::from(u16::MAX));
	// Missing fields fall back: no repeat count means one press.
	assert_eq!(parse_record("\x1b[65;30;97;1_").map(|record| record.repeat), Some(1));
}

// ── Paste-marker normalizer ────────────────────────────────────────────────

/// Concatenated output of feeding `reads` through a fresh normalizer and
/// flushing it.
fn normalize(reads: &[&str]) -> String {
	let mut normalizer = Win32PasteMarkerNormalizer::default();
	let mut output = String::new();
	for read in reads {
		output.push_str(&normalizer.process(0.0, read));
	}
	output.push_str(&normalizer.flush());
	output
}

#[test]
fn leaves_non_marker_key_records_unchanged_when_a_prefix_is_interrupted() {
	let prefix = paste_records("\x1b[20");
	let tail = format!("{}{SHIFT_ENTER}", &prefix[8..]);
	assert_eq!(normalize(&[&prefix[..8], tail.as_str()]), format!("{prefix}{SHIFT_ENTER}"));
}

#[test]
fn restores_paste_markers_encoded_as_key_records_across_reads() {
	// Each marker character as a key-down record followed by a key-up record.
	// The release that follows the completed marker passes through; paste
	// decoding drops it with the other releases inside the paste.
	let start = "\x1b[200~".chars().fold(String::new(), |mut out, unit| {
		let _ = write!(out, "{}\x1b[231;0;0;0;0;1_", paste_records(&unit.to_string()));
		out
	});
	let end = paste_records("\x1b[201~");
	let output =
		normalize(&[&start[..17], &start[17..], "https://example.com", &end[..31], &end[31..]]);
	assert_eq!(output, "\x1b[200~\x1b[231;0;0;0;0;1_https://example.com\x1b[201~");
}

#[test]
fn passes_plain_text_through_without_copying() {
	let mut normalizer = Win32PasteMarkerNormalizer::default();
	assert!(matches!(normalizer.process(0.0, "plain text"), Cow::Borrowed("plain text")));
	assert_eq!(normalizer.deadline(), None);
}

#[test]
fn holds_a_torn_record_then_releases_it_one_tick_after_the_timeout() {
	let mut normalizer = Win32PasteMarkerNormalizer::default();
	assert_eq!(normalizer.process(0.0, &ENTER[..6]), "");
	assert_eq!(normalizer.deadline(), Some(NORMALIZER_HOLD_MS));

	// The expiry only marks the release due; it happens on the next tick.
	assert_eq!(normalizer.tick(NORMALIZER_HOLD_MS), None);
	assert_eq!(normalizer.deadline(), Some(NORMALIZER_HOLD_MS));
	assert_eq!(normalizer.tick(NORMALIZER_HOLD_MS).as_deref(), Some(&ENTER[..6]));
	assert_eq!(normalizer.deadline(), None);
}

#[test]
fn completes_a_torn_record_when_its_tail_arrives_in_time() {
	let mut normalizer = Win32PasteMarkerNormalizer::default();
	assert_eq!(normalizer.process(0.0, &ENTER[..6]), "");
	assert_eq!(normalizer.process(10.0, &ENTER[6..]), ENTER);
	assert_eq!(normalizer.deadline(), None);
}
