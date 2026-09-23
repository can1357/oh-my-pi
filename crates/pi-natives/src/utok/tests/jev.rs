//! Jev golden tests: counts recorded from the live System One API
//! (`usage.input_tokens` minus the 269-token request frame), covering
//! multilingual UDHR text, code, emoji, whitespace, combining marks, NFC and
//! the 512-byte merge window (random-consonant runs of 514/515 bytes and a
//! 179-character Lao word, whose counts flip at the window edge), plus base
//! pieces padding cannot isolate: space runs before CRLF, newline-final
//! punctuation, and byte fragments of kana after a space or plane-4 code points.

use serde::Deserialize;

use crate::utok::Encoding;

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
