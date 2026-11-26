//! Jev golden tests: counts recorded from the live System One API
//! (`usage.input_tokens` minus the 269-token request frame), covering
//! multilingual UDHR text, code, emoji, whitespace, combining marks, NFC and
//! the 512-byte merge window (random-consonant runs of 514/515 bytes and a
//! 179-character Lao word, whose counts flip at the window edge), plus base
//! pieces padding cannot isolate: space runs before CRLF, newline-final
//! punctuation, and byte fragments of kana after a space or plane-4 code
//! points.

use serde::Deserialize;

use crate::utok::{Encoding, jev};

#[derive(Deserialize)]
struct Fixture {
	cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
	text:  String,
	count: u32,
}

fn cases() -> Vec<Case> {
	let fixture: Fixture =
		serde_json::from_str(include_str!("../../../fixtures/jev.json")).expect("fixture parses");
	assert!(fixture.cases.len() >= 300, "fixture corpus unexpectedly small");
	fixture.cases
}

#[test]
fn matches_live_counts() {
	for case in cases() {
		assert_eq!(Encoding::Jev.count(&case.text), case.count, "count mismatch on {:?}", case.text);
	}
}

#[test]
fn utf16_and_utf32_flavor_parity() {
	for case in cases() {
		let u16s: Vec<u16> = case.text.encode_utf16().collect();
		let u32s: Vec<u32> = case.text.chars().map(|c| c as u32).collect();
		assert_eq!(
			Encoding::Jev.count(u16s.as_slice()),
			case.count,
			"utf16 mismatch on {:?}",
			case.text
		);
		assert_eq!(
			Encoding::Jev.count(u32s.as_slice()),
			case.count,
			"utf32 mismatch on {:?}",
			case.text
		);
	}
}

/// `"SELECTING"` is one piece whose prefix counts are non-monotonic
/// (`"SEL"`=1, `"SELE"`=2, `"SELECT"`=1, `"SELECTING"`=3): truncation must
/// keep the whole-word `"SELECT"` that lands exactly on budget, where a
/// bisection over prefix counts settles on `"SEL"`.
#[test]
fn truncate_preserves_non_monotonic_whole_word_select() {
	let text = format!("{}SELECTING! more text follows here", "1".repeat(31_999));
	let u16s: Vec<u16> = text.encode_utf16().collect();
	let end = jev::truncate_u16(&u16s, 32_000);
	assert_eq!(end, 32_005);
	assert_eq!(String::from_utf16(&u16s[31_999..end]).unwrap(), "SELECT");
	assert_eq!(Encoding::Jev.count(&u16s[..end]), 32_000);
}

/// A prefix re-splits the whitespace run at its end: Jev counts
/// `" \u{a0} \u{a0}"` after 2, 3, and 4 units as 32,000, 32,001, and 32,000,
/// so the cut must reach past the over-budget middle to all four.
#[test]
fn truncate_scans_the_whole_whitespace_run() {
	let text = format!("{}{}", "1".repeat(31_999), " \u{a0} \u{a0}🙂");
	let u16s: Vec<u16> = text.encode_utf16().collect();
	let end = jev::truncate_u16(&u16s, 32_000);
	assert_eq!(end, 32_003);
	assert_eq!(Encoding::Jev.count(&u16s[..end]), 32_000);
}

/// NFC input: at budget 1 the cuts after 4..=7 units count 1, 5, 6, 1, and
/// the whole-word 7-unit prefix is the longest that fits.
#[test]
fn truncate_keeps_whole_word_on_nfc_input() {
	let u16s: Vec<u16> = "ություն!e\u{301} xxxxxxxxxxxx".encode_utf16().collect();
	let end = jev::truncate_u16(&u16s, 1);
	assert_eq!(end, 7);
	assert_eq!(Encoding::Jev.count(&u16s[..end]), 1);
}

/// NFC input whose crossing piece spans several merge windows: the cut must
/// still be the longest fitting prefix (cuts are pruned by the complete
/// windows they keep, then priced from the crossing piece).
#[test]
fn truncate_nfc_long_piece_matches_longest_fitting_prefix() {
	let u16s: Vec<u16> = format!("go {} now", "e\u{301}".repeat(600))
		.encode_utf16()
		.collect();
	let total = Encoding::Jev.count(&u16s[..]);
	for budget in [2, total / 3, total / 2, total - 2] {
		let longest = (0..=u16s.len())
			.rev()
			.find(|&k| Encoding::Jev.count(&u16s[..k]) <= budget)
			.unwrap();
		assert_eq!(jev::truncate_u16(&u16s, budget), longest, "budget {budget}");
	}
}

#[test]
fn encode_is_none() {
	assert_eq!(Encoding::Jev.encode("hello"), None);
}

/// A whole-word entry only matches the entire piece; inside a longer piece
/// it falls to the base merge table, where `token` is not reachable.
#[test]
fn whole_words_match_only_whole_pieces() {
	assert_eq!(Encoding::Jev.count("token"), 1);
	assert_eq!(Encoding::Jev.count("tokenize"), 3);
	assert_eq!(Encoding::Jev.count(" information"), 1);
	assert_eq!(Encoding::Jev.count("xinformation"), 3);
}
