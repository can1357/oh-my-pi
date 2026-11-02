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

/// Counting hands the marked stream to the tiler in 128 KiB chunks, holding
/// back its last 8 bytes for the seam rewrite, and writes a word longer than a
/// chunk a piece at a time. None of that may move a count, so every input here
/// crosses at least one flush, and each reference is what the pre-streaming
/// implementation (whole stream built, then tiled) counted.
#[test]
fn counts_across_stream_flushes() {
	let cases = [
		// 1- to 4-byte characters and title/caps words joined by single
		// spaces: flushes land just before an ⟨eow⟩ ' ' ⟨bow⟩ seam.
		("seams", "Über café straße 日本 It's x ÉCOLE 😀 ".repeat(12_000), [
			216_000, 276_000, 275_999, 276_000,
		]),
		// 4-byte HARD letters against 3-byte word letters: a flush splits a
		// 4-byte character, and the seam right after it reads only the kept
		// tail.
		("mid-character", "𐐀ḁaa 𐐨ḁaa ḁ𐐨 Ḁ𐐨 ".repeat(14_000), [
			504_001, 532_001, 531_999, 532_000,
		]),
		// The widest context a flush has to keep: no character wider than
		// three bytes takes an ⟨eow⟩ (astral letters are HARD runs). The
		// stream `⟨bow⟩b…b⟨eow⟩⟨bow⟩xḁ⟨eow⟩` is exactly 128 KiB, so the space
		// after it is the run that flushes, and the seam into `y` reads
		// `ḁ ⟨eow⟩ ' '`: five bytes.
		("seam at flush", format!("{} xḁ y", "b".repeat(128 * 1024 - 8)), [
			65_537, 131_069, 131_069, 131_069,
		]),
		// Single words spanning several chunks in each case form, each
		// followed by a seam into a short word.
		("long literal", format!("{} b", "a".repeat(300_000)), [100_002, 300_001, 300_001, 300_001]),
		("long title ASCII", format!("A{} Bc", "b".repeat(200_000)), [
			100_003, 200_004, 200_004, 200_004,
		]),
		("long title", format!("Ä{} Öl", "ö".repeat(100_000)), [50_006, 50_006, 50_006, 50_006]),
		("long caps", format!("x {} Y", "ÖÄ".repeat(80_000)), [160_003, 320_005, 320_005, 320_005]),
		("long dotted İ", format!("A{} Ab", "bİ".repeat(70_000)), [
			140_003, 140_005, 140_005, 140_005,
		]),
	];
	let encodings =
		[Encoding::ClaudeV3, Encoding::ClaudeV47, Encoding::ClaudeV5, Encoding::ClaudeV5Sonnet];
	for (name, text, want) in &cases {
		for (enc, want) in encodings.into_iter().zip(want) {
			assert_eq!(enc.count(text.as_str()), *want, "{enc:?} {name}");
		}
	}
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
