//! Lazily-decoded embedded tables and per-family wiring.
//!
//! Each family agent: add your `LazyLock`, your pattern constant(s), and
//! your arm in [`bpe_for`]. Data blobs live in `data/<name>.bin.zst`
//! (UTOK1 + zstd; see `data/families.json`). Patterns come from
//! `data/families.json` — do not invent them.

use std::sync::LazyLock;

use crate::utok::{
	Encoding,
	bpe::{BpeEncoding, RankTable},
	pretoken::Splitter,
};

// ── OpenAI ──────────────────────────────────────────────────────────────
// Codepoint scanners in src/scan/{o200k,cl100k}.rs, hand-ported from the
// tiktoken-rs 0.7.0 patterns (src/tiktoken_ext/openai_public.rs, identical
// to openai/tiktoken tiktoken_ext/openai_public.py) and differential-tested
// against tiktoken-rs in tests/openai.rs.

static O200K_BASE: LazyLock<BpeEncoding> = LazyLock::new(|| BpeEncoding {
	table:         RankTable::parse(include_bytes!("../../data/o200k_base.bin.zst")),
	splitter:      Splitter::O200k,
	nfc:           false,
	ignore_merges: false,
});

static CL100K_BASE: LazyLock<BpeEncoding> = LazyLock::new(|| BpeEncoding {
	table:         RankTable::parse(include_bytes!("../../data/cl100k_base.bin.zst")),
	splitter:      Splitter::Cl100k,
	nfc:           false,
	ignore_merges: false,
});

// ── Qwen3 ───────────────────────────────────────────────────────────────
// Pattern: qwen3.8.tokenizer.json pre_tokenizer Split regex, verified equal
// to data/families.json qwen3.pre. Note `\p{N}` matches a SINGLE digit
// (unlike cl100k's {1,3}) and letters admit trailing marks `[\p{L}\p{M}]+`.
// Normalizer is NFC (`nfc: true`). The pack (tools/pack-qwen.ts) empties the
// 201 merge-unreachable vocab slots so the engine's whole-piece
// short-circuit cannot emit ids the HF reference (ignore_merges=false)
// never produces.

/// Reference regex, kept as the scanner's dev/test differential oracle
/// (see `scan::qwen` tests).
#[cfg(test)]
pub(crate) const QWEN3_PATTERN: &str = r"(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?[\p{L}\p{M}]+|\p{N}| ?[^\s\p{L}\p{M}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+";

static QWEN3: LazyLock<BpeEncoding> = LazyLock::new(|| BpeEncoding {
	table:         RankTable::parse(include_bytes!("../../data/qwen3.bin.zst")),
	splitter:      Splitter::Qwen,
	nfc:           true,
	ignore_merges: false,
});

// ── DeepSeek ────────────────────────────────────────────────────────────
// Three-stage HF Split(Isolated) chain from data/families.json deepseek3
// (cache/deepseek-v4.tokenizer.json pre_tokenizer; base BPE identical
// V3..V4): digits ≤3, then CJK runs (Han + hiragana + katakana blocks),
// then the main pattern with a punctuation-prefix-letters alternate.

// Stage patterns kept as the dev/test differential reference for the
// scanner (`scan::deepseek`).
#[cfg(test)]
pub(crate) const DEEPSEEK_STAGE_DIGITS: &str = r"\p{N}{1,3}";
#[cfg(test)]
pub(crate) const DEEPSEEK_STAGE_CJK: &str = r"[一-龥぀-ゟ゠-ヿ]+";
#[cfg(test)]
pub(crate) const DEEPSEEK_STAGE_MAIN: &str = concat!(
	r##"[!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~][A-Za-z]+"##,
	r"|[^\r\n\p{L}\p{P}\p{S}]?[\p{L}\p{M}]+",
	r"| ?[\p{P}\p{S}]+[\r\n]*",
	r"|\s*[\r\n]+",
	r"|\s+(?!\S)",
	r"|\s+",
);

static DEEPSEEK3: LazyLock<BpeEncoding> = LazyLock::new(|| BpeEncoding {
	table:         RankTable::parse(include_bytes!("../../data/deepseek3.bin.zst")),
	splitter:      Splitter::DeepSeek,
	nfc:           false,
	ignore_merges: false,
});

// ── Kimi ────────────────────────────────────────────────────────────────
// Runtime split: hand-written scanner (`scan::kimi`), a port of the
// tokenization_kimi.py pat_str (8-alternate join, class intersection
// `&&[^\p{Han}]`, `\s+(?!\S)` lookahead). The regex below is kept as the
// dev/test differential reference; it is verified equal to
// data/families.json kimi_k2.pattern.

#[cfg(test)]
pub(crate) const KIMI_K2_PATTERN: &str = concat!(
	r"[\p{Han}]+",
	r"|[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]*[\p{Ll}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]+(?i:'s|'t|'re|'ve|'m|'ll|'d)?",
	r"|[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]+[\p{Ll}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]*(?i:'s|'t|'re|'ve|'m|'ll|'d)?",
	r"|\p{N}{1,3}",
	r"| ?[^\s\p{L}\p{N}]+[\r\n]*",
	r"|\s*[\r\n]+",
	r"|\s+(?!\S)",
	r"|\s+",
);

static KIMI_K2: LazyLock<BpeEncoding> = LazyLock::new(|| BpeEncoding {
	table:         RankTable::parse(include_bytes!("../../data/kimi_k2.bin.zst")),
	splitter:      Splitter::Kimi,
	nfc:           false,
	ignore_merges: false,
});

// ── GLM ─────────────────────────────────────────────────────────────────
// Pattern: glm-5.tokenizer.json pre_tokenizer Split regex, verified equal
// to data/families.json glm5.pre — and character-identical to tiktoken's
// cl100k_base pattern, so the runtime splitter aliases the cl100k scanner
// (`scan::cl100k`) instead of duplicating it; `glm_scan_tests` below proves
// byte-identical piece boundaries against the GLM reference regex.
// `ignore_merges: true` — whole-piece vocab hits bypass merging; the
// engine's encode_piece short-circuit implements exactly this (proven by
// directed fixtures: greedy-merge-unreachable tokens like ' 参考' encode
// as one id).

/// Reference regex, kept as the dev/test differential oracle for the
/// cl100k-scanner alias.
#[cfg(test)]
pub(crate) const GLM5_PATTERN: &str = r"(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+";

static GLM5: LazyLock<BpeEncoding> = LazyLock::new(|| BpeEncoding {
	table:         RankTable::parse(include_bytes!("../../data/glm5.bin.zst")),
	splitter:      Splitter::Cl100k,
	nfc:           false,
	ignore_merges: true,
});

/// Resolve the BPE encoding for a non-Claude family.
pub(crate) fn bpe_for(enc: Encoding) -> &'static BpeEncoding {
	match enc {
		Encoding::O200kBase => &O200K_BASE,
		Encoding::Cl100kBase => &CL100K_BASE,
		Encoding::Qwen3 => &QWEN3,
		Encoding::DeepSeekV3 => &DEEPSEEK3,
		Encoding::KimiK2 => &KIMI_K2,
		Encoding::Glm5 => &GLM5,
		_ => unreachable!("claude families never reach bpe_for"),
	}
}

#[cfg(test)]
mod glm_scan_tests {
	//! Differential justifying the cl100k-scanner alias: piece boundaries
	//! from `Splitter::Cl100k` vs the GLM-5 reference regex, over the
	//! corpus, every glm5 fixture text, and seeded random CJK/Latin mixes.

	use super::GLM5_PATTERN;
	use crate::utok::pretoken::Splitter;

	/// splitmix64 (same scheme as tests/openai.rs).
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

	#[test]
	fn glm_cl100k_alias_matches_reference_regex() {
		let reference = Splitter::new(&[GLM5_PATTERN]);
		let scanner = Splitter::Cl100k;
		let corpus: Vec<String> =
			serde_json::from_str(include_str!("../../fixtures/corpus.json")).unwrap();
		let fixture: serde_json::Value =
			serde_json::from_str(include_str!("../../fixtures/glm5.json")).unwrap();
		let fixture_texts: Vec<String> = fixture["cases"]
			.as_array()
			.unwrap()
			.iter()
			.map(|c| c["text"].as_str().unwrap().to_string())
			.collect();
		let texts: Vec<String> = corpus
			.into_iter()
			.chain(fixture_texts)
			.chain(random_strings(0x61c8_8646, 400))
			.collect();
		for text in &texts {
			assert_eq!(
				scanner.split(text),
				reference.split(text),
				"piece boundaries diverge on {text:?}"
			);
		}
	}
}
