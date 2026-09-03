//! Offline reconstruction of Claude's tokenizer token counts.
//!
//! Ground-up Rust implementation of the tokenizer-count model reconstructed
//! by [ctok](https://github.com/sanderland/ctok): the algorithm port and its
//! optimizations are this repository's; the measured vocabulary *data* is
//! Sander Land's (MIT — see `data/LICENSE.ctok`), pinned at upstream revision
//! `df3b59b` (v1.0.0), embedded in the front-coded binary form produced by
//! pi-natives' `gen-ctok-vocab.ts` and zstd-compressed by `tools/pack-ctok.ts`
//! into `data/ctok_*.bin.zst`. The research behind the
//! model is described in "On the biology of Claude's tokenizer"
//! (<https://tokencontributions.substack.com/p/on-the-biology-of-claudes-tokenizer>).
//!
//! The reconstruction targets counts, not boundaries, and this port keeps
//! only the counting surface (ctok's `tokenize()` token list, witness
//! verification, and CLI are not ported). For one user message the pipeline
//! is:
//!
//! 1. normalize the text (NFC plus family-specific folding), borrowing it whole
//!    where no rule can fire;
//! 2. rewrite it into a marked byte stream, with word, case and boundary
//!    markers written in as single bytes;
//! 3. min-cost tile the stream over the measured vocabulary and UTF-8 byte
//!    fallback, matching pieces with one Aho-Corasick transition per byte;
//! 4. add the measured message frame.
//!
//! Nothing in the pipeline materializes decoded characters for valid UTF-8
//! input: the stream, the vocabulary and the tiling are all byte-level, and
//! Unicode tables are read only for the non-ASCII, non-ideograph characters
//! whose class needs them. UTF-16/UTF-32 (and malformed UTF-8) input decodes
//! permissively into the normalization stream (utf.rs semantics), so valid
//! text counts flavor-invariantly.
//!
//! Exactness inherited from upstream: 0 mismatches on ~3.4 M recorded
//! `count_tokens` responses across the v3 and v4.7 corpora. The port is
//! validated against Python ctok fixtures in `testdata/fixtures.json`.

mod constants;
mod engine;
mod normalize;

use std::sync::LazyLock;

use engine::VocabCore;
use normalize::{FrameParams, nfc_units, raw_head_space_units, stream_norm, trim_end_ws};

use crate::utok::utf::Unit;

/// One reconstructed tokenizer generation.
///
/// | family | model generation |
/// |---|---|
/// | `V3` | Claude 3 through Opus 4.6 (and every non-opus Claude < 5) |
/// | `V47` | Opus 4.7 through 4.9 |
/// | `V5` | Opus 5 |
/// | `V5Sonnet` | Sonnet 5, Fable 5 (non-opus 5-series) |
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Family {
	/// Claude 3 … Opus 4.5/4.6 vocabulary, curly quotes folded, ⟨caps⟩ at 4+.
	V3,
	/// Opus 4.7+ vocabulary: quotes literal, ⟨caps⟩ disabled.
	V47,
	/// v4.7 vocabulary with the opus-5 message frame: no frame ⟨bow⟩,
	/// trailing ASCII whitespace absorbed for free, overhead 6.
	V5,
	/// v4.7 vocabulary with the sonnet/fable-5 frame: no frame ⟨bow⟩,
	/// overhead 6, and a trailing-newline ladder — the frame appends nothing
	/// but absorbs one token of the content-final newline run
	/// (`tile(run) - 1`). Measured live against `claude-sonnet-5` /
	/// `claude-fable-5` (2026-08-19; ladder dips pinned at run = 32);
	/// upstream ctok's "Sonnet 5 counts like Opus 5" does not hold on
	/// trailing whitespace.
	V5Sonnet,
}

static CORE_V3: LazyLock<VocabCore> = LazyLock::new(|| {
	let raw = zstd::decode_all(&include_bytes!("../../../data/ctok_v3.bin.zst")[..])
		.expect("utoken: ctok v3 zstd decode failed");
	VocabCore::parse(&raw)
});

static CORE_V47: LazyLock<VocabCore> = LazyLock::new(|| {
	let raw = zstd::decode_all(&include_bytes!("../../../data/ctok_v4_7.bin.zst")[..])
		.expect("utoken: ctok v4.7 zstd decode failed");
	VocabCore::parse(&raw)
});

impl Family {
	fn core(self) -> &'static VocabCore {
		match self {
			Self::V3 => &CORE_V3,
			Self::V47 | Self::V5 | Self::V5Sonnet => &CORE_V47,
		}
	}

	fn params(self) -> FrameParams {
		let mut p = self.core().frame_params();
		if matches!(self, Self::V5 | Self::V5Sonnet) {
			// The 5-series reuses v4.7's vocabulary; only the message frame
			// differs (ctok's `FAMILIES` overrides plus the live-measured
			// sonnet/fable split).
			p.message_overhead = 6;
			p.frame_bow = false;
			p.ladder = self == Self::V5Sonnet;
		}
		p
	}

	/// How many newlines the message frame appends after the content on the
	/// ladder families: one token can span into them, so a content-final
	/// newline run of `n` is priced as `tile(n + appended) - 1`. v3/v4.7
	/// frames append ⏎⏎ (free tail dips where `n + 2` is a ladder piece,
	/// e.g. n = 30); the sonnet/fable-5 frame appends nothing (dips at
	/// n = 32 itself), both pinned live against the API.
	const fn appended_newlines(self) -> usize {
		match self {
			Self::V5Sonnet => 0,
			_ => 2,
		}
	}
}

/// Token count of `units` (any UTF flavor) as message *content*: the
/// min-cost tiling of the marked stream, without the fixed per-message
/// frame. This is the right quantity for budget estimates that sum
/// fragments. Valid text counts flavor-invariantly; malformed units decode
/// permissively as U+FFFD (utf.rs semantics).
pub fn content_token_count<U: Unit>(units: &[U], family: Family) -> u32 {
	let core = family.core();
	let p = family.params();
	let head_space = raw_head_space_units(units);
	if p.ladder {
		let norm = nfc_units(units, p.fold_quotes);
		// The frame appends newline(s) and one token can span into them: read
		// the content-final newline run before `stream_norm` strips it.
		let n_tail = norm.bytes().rev().take_while(|&b| b == b'\n').count();
		let stream = stream_norm(&norm, &p, head_space);
		let tail = core.ladder_tail_cost(n_tail, family.appended_newlines());
		if stream.is_empty() {
			return tail;
		}
		core.tile_cost(&stream) + tail
	} else {
		// The v5 frame absorbs raw ASCII whitespace, so strip before NFC:
		// NFC folds NBSP etc. to U+0020, and those are not free at the end.
		let stripped = trim_end_ws(units);
		let norm = nfc_units(stripped, p.fold_quotes);
		let stream = stream_norm(&norm, &p, head_space);
		if stream.is_empty() {
			0
		} else {
			core.tile_cost(&stream)
		}
	}
}

/// Reconstructed `count_tokens` value for `units` as a single user message:
/// content tiling plus the measured message frame (ctok's `token_count`).
// Exercised by the fixture tests; `lib.rs` only routes content counts.
#[cfg_attr(not(test), allow(dead_code, reason = "used only by fixture tests"))]
pub fn message_token_count<U: Unit>(units: &[U], family: Family) -> u32 {
	content_token_count(units, family) + family.params().message_overhead
}

#[cfg(test)]
mod tests {
	use serde::Deserialize;

	use super::{Family, content_token_count, message_token_count};

	#[derive(Deserialize)]
	struct Fixture {
		text: String,
		v3:   u32,
		v4_7: u32,
		v5:   u32,
	}

	/// Ground truth recorded from Python ctok 1.0.0 (`token_count(text, v)`
	/// for v in 3.0/4.7/5.0). Regenerate with a `uv run --with ctok` sweep if
	/// the vendored vocabulary files are updated.
	fn fixtures() -> Vec<Fixture> {
		serde_json::from_str(include_str!("testdata/fixtures.json")).expect("fixtures parse")
	}

	#[test]
	fn matches_reference_counts() {
		let mut checked = 0usize;
		for f in fixtures() {
			for (family, want) in [(Family::V3, f.v3), (Family::V47, f.v4_7), (Family::V5, f.v5)] {
				let got = message_token_count(f.text.as_bytes(), family);
				assert_eq!(got, want, "family {family:?} text {:?}", f.text);
				checked += 1;
			}
		}
		assert!(checked >= 250, "fixture corpus unexpectedly small: {checked}");
	}

	#[test]
	fn matches_live_sonnet5_counts() {
		// The sonnet/fable-5 frame diverges from opus-5 on trailing
		// whitespace and is not modeled by upstream ctok: these rows are raw
		// `count_tokens` responses recorded from `claude-sonnet-5`
		// (2026-08-19), whitespace-edge heavy, ladder dips included.
		#[derive(Deserialize)]
		struct LiveRow {
			text:  String,
			count: u32,
		}
		let rows: Vec<LiveRow> =
			serde_json::from_str(include_str!("testdata/sonnet5_live.json")).expect("rows parse");
		assert!(rows.len() >= 50, "live corpus unexpectedly small: {}", rows.len());
		for row in rows {
			assert_eq!(
				message_token_count(row.text.as_bytes(), Family::V5Sonnet),
				row.count,
				"text {:?}",
				row.text
			);
		}
	}

	#[test]
	fn content_count_is_message_minus_frame() {
		// The public split every consumer relies on: summing fragments must
		// never include per-message frame overhead.
		assert_eq!(content_token_count(b"", Family::V5), 0);
		for (family, overhead) in
			[(Family::V3, 7), (Family::V47, 11), (Family::V5, 6), (Family::V5Sonnet, 6)]
		{
			let text = "hello, world";
			assert_eq!(
				message_token_count(text.as_bytes(), family),
				content_token_count(text.as_bytes(), family) + overhead,
			);
		}
	}

	/// The stream spells markers as bytes no text can produce (`nfc` strips
	/// every C0 control and folds NUL), so text that contains ctok's own marker
	/// noncharacters, private-use codepoints, or raw controls tiles as the text
	/// it is — no escaping stage in between. These rows were verified against
	/// the previous noncharacter-marker encoder, which did escape them.
	#[test]
	fn marker_lookalikes_count_as_text() {
		let rows: &[(&str, [u32; 4])] = &[
			("a\u{fdd0}b", [12, 16, 11, 11]),
			("a\u{fdd1}b", [12, 16, 11, 11]),
			("\u{fdd4}WORD", [13, 18, 12, 12]),
			("\u{fdd0}\u{fdd1}\u{fdd2}\u{fdd3}\u{fdd4}", [23, 27, 21, 21]),
			("hello \u{fdd0}world\u{fdd1} bye", [18, 24, 19, 19]),
			// Private use is stripped, so both neighbours join one word.
			("a\u{e000}b\u{e004}c", [8, 13, 8, 8]),
			("\u{e000}\u{e001}\u{e002}", [8, 12, 6, 6]),
			// C0 controls are stripped; NUL folds to a space instead.
			("a\u{01}\u{08}b\u{7f}c", [8, 13, 8, 8]),
			("a\0b", [9, 13, 8, 8]),
		];
		for (text, want) in rows {
			let families = [Family::V3, Family::V47, Family::V5, Family::V5Sonnet];
			for (family, &expected) in families.into_iter().zip(want) {
				assert_eq!(
					message_token_count(text.as_bytes(), family),
					expected,
					"family {family:?} text {text:?}"
				);
			}
		}
	}

	#[test]
	fn utf16_and_utf32_flavor_parity() {
		// Valid text must count identically in every input flavor: the
		// UTF-16/UTF-32 paths decode into the same normalization stream the
		// &str/u8 path sees.
		let families = [Family::V3, Family::V47, Family::V5, Family::V5Sonnet];
		for f in fixtures() {
			let u16s: Vec<u16> = f.text.encode_utf16().collect();
			let u32s: Vec<u32> = f.text.chars().map(u32::from).collect();
			for family in families {
				let want = content_token_count(f.text.as_bytes(), family);
				assert_eq!(
					content_token_count(&u16s, family),
					want,
					"utf16 family {family:?} text {:?}",
					f.text
				);
				assert_eq!(
					content_token_count(&u32s, family),
					want,
					"utf32 family {family:?} text {:?}",
					f.text
				);
			}
		}
	}
}
