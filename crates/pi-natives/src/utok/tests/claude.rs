//! Claude ctok golden tests over the public [`crate::utok::Encoding`] surface.
//!
//! The fixture corpora record reference *message* counts (Python ctok 1.0.0
//! `token_count`, plus raw live `count_tokens` rows for sonnet-5). Public
//! `count()` returns *content* tokens, so each expectation subtracts the
//! fixed per-family frame overhead (v3: 7, v4.7: 11, 5-series: 6); the
//! content/message split itself is asserted by the module's internal tests.

use serde::Deserialize;

use crate::utok::Encoding;

#[derive(Deserialize)]
struct Fixture {
	text: String,
	v3:   u32,
	v4_7: u32,
	v5:   u32,
}

#[derive(Deserialize)]
struct LiveRow {
	text:  String,
	count: u32,
}

const FRAME_V3: u32 = 7;
const FRAME_V47: u32 = 11;
const FRAME_V5: u32 = 6;

#[test]
fn matches_ctok_reference_counts() {
	let fixtures: Vec<Fixture> =
		serde_json::from_str(include_str!("../claude/testdata/fixtures.json"))
			.expect("fixtures parse");
	assert!(fixtures.len() >= 250, "fixture corpus unexpectedly small: {}", fixtures.len());
	for f in &fixtures {
		for (enc, want) in [
			(Encoding::ClaudeV3, f.v3 - FRAME_V3),
			(Encoding::ClaudeV47, f.v4_7 - FRAME_V47),
			(Encoding::ClaudeV5, f.v5 - FRAME_V5),
		] {
			assert_eq!(enc.count(&f.text), want, "encoding {enc:?} text {:?}", f.text);
		}
	}
}

#[test]
fn matches_live_sonnet5_counts() {
	let rows: Vec<LiveRow> =
		serde_json::from_str(include_str!("../claude/testdata/sonnet5_live.json"))
			.expect("rows parse");
	assert!(rows.len() >= 50, "live corpus unexpectedly small: {}", rows.len());
	for row in &rows {
		assert_eq!(
			Encoding::ClaudeV5Sonnet.count(&row.text),
			row.count - FRAME_V5,
			"text {:?}",
			row.text
		);
	}
}

#[test]
fn encode_is_none_for_all_claude_families() {
	// ctok reconstructs counts, not boundaries: no id sequence exists.
	for enc in
		[Encoding::ClaudeV3, Encoding::ClaudeV47, Encoding::ClaudeV5, Encoding::ClaudeV5Sonnet]
	{
		assert_eq!(enc.encode("x"), None, "{enc:?}");
		assert_eq!(enc.encode(""), None, "{enc:?}");
	}
}

#[test]
fn count_routes_per_family() {
	// Each variant must reach its own family table/frame, not a shared one.
	// v3 folds curly quotes and marks 4+ caps runs; v4.7+ does neither.
	let caps = "HELLO “WORLD”";
	let v3 = Encoding::ClaudeV3.count(caps);
	let v47 = Encoding::ClaudeV47.count(caps);
	assert_ne!(v3, v47, "v3 and v4.7 must diverge on caps/quotes");

	// V47 and V5 share a vocabulary but differ on the frame ⟨bow⟩: a
	// leading space is priced differently.
	assert_ne!(
		Encoding::ClaudeV47.count(" hello"),
		Encoding::ClaudeV5.count(" hello"),
		"v4.7 and opus-5 must diverge on the frame bow"
	);

	// Trailing newlines: opus-5 absorbs the run for free, sonnet-5 pays the
	// ladder (tile(run) - 1), v4.7 pays full price — strict ordering at a
	// long run where the tiling needs several pieces.
	let tail = format!("hello{}", "\n".repeat(64));
	let v5 = Encoding::ClaudeV5.count(&tail);
	let s5 = Encoding::ClaudeV5Sonnet.count(&tail);
	let v47 = Encoding::ClaudeV47.count(&tail);
	assert_eq!(v5, Encoding::ClaudeV5.count("hello"), "opus-5 tail is free");
	assert!(s5 > v5, "sonnet-5 tail is not free");
	assert!(s5 < v47, "sonnet-5 tail gets the ladder discount");

	// Empty content is zero on the 5-series; v3/v4.7 still pay the frame
	// ⟨bow⟩ token (matches ctok / the fixture corpus).
	assert_eq!(Encoding::ClaudeV5.count(""), 0);
	assert_eq!(Encoding::ClaudeV5Sonnet.count(""), 0);
	assert_eq!(Encoding::ClaudeV3.count(""), 1);
	assert_eq!(Encoding::ClaudeV47.count(""), 1);
}

#[test]
fn utf16_and_utf32_flavor_parity() {
	// Valid text counts flavor-invariantly through the public generic API.
	let fixtures: Vec<Fixture> =
		serde_json::from_str(include_str!("../claude/testdata/fixtures.json"))
			.expect("fixtures parse");
	let encodings =
		[Encoding::ClaudeV3, Encoding::ClaudeV47, Encoding::ClaudeV5, Encoding::ClaudeV5Sonnet];
	for f in &fixtures {
		let u16s: Vec<u16> = f.text.encode_utf16().collect();
		let u32s: Vec<u32> = f.text.chars().map(u32::from).collect();
		for enc in encodings {
			let want = enc.count(f.text.as_str());
			assert_eq!(enc.count(&u16s), want, "utf16 {enc:?} text {:?}", f.text);
			assert_eq!(enc.count(&u32s), want, "utf32 {enc:?} text {:?}", f.text);
			assert_eq!(enc.encode(&u16s), None, "{enc:?}");
		}
	}
}
