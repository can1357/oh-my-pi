//! `OpenAI` family tests: golden fixtures from Python tiktoken, plus a
//! differential test against tiktoken-rs over the corpus and seeded
//! randomized strings.

use serde::Deserialize;

use crate::utok::Encoding;

#[derive(Deserialize)]
struct Fixture {
	#[allow(dead_code, reason = "fixture provenance is deserialized but not asserted")]
	generator: String,
	cases:     Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
	text:  String,
	ids:   Vec<u32>,
	count: u32,
}

fn check_fixture(enc: Encoding, json: &str) {
	let fx: Fixture = serde_json::from_str(json).unwrap();
	assert!(!fx.cases.is_empty());
	for (i, case) in fx.cases.iter().enumerate() {
		let ids = enc.encode(&case.text).expect("BPE family must encode");
		assert_eq!(
			ids,
			case.ids,
			"{enc:?} case {i} ids mismatch: {:?}…",
			&case.text[..case.text.len().min(60)]
		);
		assert_eq!(
			enc.count(&case.text),
			case.count,
			"{enc:?} case {i} count mismatch: {:?}…",
			&case.text[..case.text.len().min(60)]
		);
	}
}

#[test]
fn o200k_fixtures() {
	check_fixture(Encoding::O200kBase, include_str!("../../../fixtures/o200k_base.json"));
}

#[test]
fn cl100k_fixtures() {
	check_fixture(Encoding::Cl100kBase, include_str!("../../../fixtures/cl100k_base.json"));
}

// ── differential vs tiktoken-rs ─────────────────────────────────────────

/// splitmix64: tiny deterministic PRNG, no dev-dep needed.
struct Rng(u64);

impl Rng {
	fn next(&mut self) -> u64 {
		self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
		let mut z = self.0;
		z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
		z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
		z ^ (z >> 31)
	}
}

/// Deterministic pseudo-random test strings: raw bytes laundered through
/// `from_utf8_lossy` (both sides see the same valid-UTF-8 string), plus
/// char-sampled strings biased toward tokenizer-relevant ranges.
fn random_strings(seed: u64, n: usize) -> Vec<String> {
	let mut rng = Rng(seed);
	let mut out = Vec::with_capacity(n * 2);
	for _ in 0..n {
		let len = (rng.next() % 300 + 1) as usize;
		let bytes: Vec<u8> = (0..len).map(|_| rng.next() as u8).collect();
		out.push(String::from_utf8_lossy(&bytes).into_owned());
	}
	for _ in 0..n {
		let len = (rng.next() % 120 + 1) as usize;
		let s: String = (0..len)
			.map(|_| {
				let c = match rng.next() % 8 {
					0 => rng.next() % 0x80,                          // ASCII
					1 => 0x20 + rng.next() % 4,                      // spaces/punct
					2 => rng.next() % 0x250,                         // Latin+ext
					3 => 0x4e00 + rng.next() % 0x100,                // CJK
					4 => 0x1f300 + rng.next() % 0x100,               // emoji
					5 => 0x300 + rng.next() % 0x70,                  // combining marks
					6 => [9, 10, 13, 32][(rng.next() % 4) as usize], // whitespace
					_ => rng.next() % 0x11_0000,
				};
				char::from_u32(c as u32).unwrap_or('\u{fffd}')
			})
			.collect();
		out.push(s);
	}
	out
}

/// Scanner-torture strings: class-overlap backtracking, contraction case
/// folds, whitespace-trio boundaries, o200k slash tails.
const TRICKY: &[&str] = &[
	"ʰAB",              // upper-run backtracks to shared Lm codepoint
	"XYʰZ",             // alt1 wins with "XYʰ" although alt2 would take "XYʰZ"
	"ʰ",                // single shared-class codepoint matches alt1 via backtrack
	"\u{301}a\u{301}",  // mark-initial: prefix-vs-body ambiguity
	"'ſ 'S 'ſt",        // U+017F long s in (?i:'s)
	"'Re'VE'lL'd",      // two-letter contraction folds
	"'r 'v 'l",         // near-miss contractions
	"\u{c}\n\u{fffd}G", // \s*[\r\n]+ vs \s+(?!\S) (the historical cl100k bug)
	"x \t\u{b}\r\n \n\t y",
	"ǅungla ǅ Ǆ", // titlecase letters
	"a/b//\n/",   // o200k punct slash tail
	" /",
	"१२३४ ٣٢١",        // non-ASCII digits, {1,3} grouping
	"?\u{17f}\u{17f}", // prefix + long-s run
	"  ",
	" x",
	"\r",
	"\n \n",
];

fn check_differential(enc: Encoding, reference: &tiktoken_rs::CoreBPE, seed: u64) {
	let corpus: Vec<String> =
		serde_json::from_str(include_str!("../../../fixtures/corpus.json")).unwrap();
	// Multi-seed sweep: broader codepoint coverage against Unicode-table
	// skew between the scanner's class tables and the reference engine.
	let texts: Vec<String> = corpus
		.into_iter()
		.chain(TRICKY.iter().map(|s| s.to_string()))
		.chain((0..4).flat_map(|k| random_strings(seed.wrapping_add(k * 0x9e37), 150)))
		.collect();
	for text in &texts {
		let want: Vec<u32> = reference.encode_ordinary(text);
		let got = enc.encode(text.as_str()).unwrap();
		assert_eq!(got, want, "{enc:?} differential ids mismatch on {text:?}");
		assert_eq!(
			enc.count(text.as_str()),
			want.len() as u32,
			"{enc:?} differential count mismatch on {text:?}"
		);

		// UTF flavor parity: same ids/counts from native u16/u32 scans.
		let u16s: Vec<u16> = text.encode_utf16().collect();
		let u32s: Vec<u32> = text.chars().map(|c| c as u32).collect();
		assert_eq!(enc.encode(&u16s).unwrap(), want, "{enc:?} utf16 parity mismatch on {text:?}");
		assert_eq!(enc.count(&u16s), want.len() as u32, "{enc:?} utf16 count parity on {text:?}");
		assert_eq!(enc.encode(&u32s).unwrap(), want, "{enc:?} utf32 parity mismatch on {text:?}");
		assert_eq!(enc.count(&u32s), want.len() as u32, "{enc:?} utf32 count parity on {text:?}");
	}

	// Ill-formed UTF-16 (lone surrogates) must behave like a lossy JS
	// crossing: identical to the replacement-char string, never panic.
	let mut rng = Rng(seed ^ 0x5107);
	for _ in 0..100 {
		let len = (rng.next() % 40 + 1) as usize;
		let raw: Vec<u16> = (0..len)
			.map(|_| match rng.next() % 4 {
				0 => 0xd800 + (rng.next() % 0x800) as u16, // surrogate soup
				1 => (rng.next() % 0x80) as u16,
				_ => rng.next() as u16,
			})
			.collect();
		let lossy = String::from_utf16_lossy(&raw);
		let want: Vec<u32> = reference.encode_ordinary(&lossy);
		assert_eq!(enc.encode(&raw).unwrap(), want, "{enc:?} lossy utf16 mismatch on {raw:x?}");
		assert_eq!(enc.count(&raw), want.len() as u32, "{enc:?} lossy utf16 count on {raw:x?}");
	}
}

#[test]
fn o200k_differential() {
	check_differential(Encoding::O200kBase, &tiktoken_rs::o200k_base().unwrap(), 0x0200f00d);
}

#[test]
fn cl100k_differential() {
	check_differential(Encoding::Cl100kBase, &tiktoken_rs::cl100k_base().unwrap(), 0x0100beef);
}
