//! Offline reconstruction of `TypeSafe` Jev's input-token counts (`jev-1.13`).
//!
//! Jev reports only `usage.input_tokens`, so this model was recovered from
//! counts alone: ~628k probes against the live System One API, split into a
//! vocabulary by difference measurements inside neutral padding, then fitted
//! until every recorded count matched (see `data/README.md`). Like the
//! Claude families it reconstructs counts, not token ids.
//!
//! Pipeline for one `state` string:
//!
//! 1. NFC-normalize, then split with Qwen3.5's pre-tokenizer (single digits,
//!    contractions split off, combining marks glued to letters): the same
//!    [`Splitter::Qwen`] scanner and `nfc` flag as [`Encoding::Qwen3`].
//! 2. A piece that is a whole-word entry costs 1. The whole-word vocabulary is
//!    (almost exactly) the o200k tokens that are also Qwen3.5 tokens, plus
//!    every base token.
//! 3. Any other piece is cut into [`WINDOW`]-byte windows, and each window runs
//!    tiktoken's byte-pair merge with o200k ranks, restricted to a ~53k-token
//!    base subset of o200k. Whole-piece hits in the base table are *not*
//!    short-circuited ([`RankTable::count_merged`]): `token` is a whole word
//!    but not a base token, so `tokenize` costs 3.
//!
//! Counts are state *content*: the request frame (question text, template,
//! 269 tokens for a minimal one-noul request) is excluded, matching the
//! other families' "no chat-template frame" semantics.
//!
//! [`Encoding::Qwen3`]: crate::utok::Encoding::Qwen3

use std::sync::LazyLock;

use crate::utok::{
	bpe::{BpeEncoding, RankTable},
	pretoken::Splitter,
	utf::Unit,
};

/// Longest byte span one merge run covers: longer pieces are merged in
/// independent windows (measured: an ASCII run gains a token exactly at
/// byte 513, and a Lao word flips at the 512-byte mark mid-character).
const WINDOW: usize = 512;

struct Jev {
	/// Base merge table (o200k ranks, non-base slots empty) plus the shared
	/// Qwen3.5 splitter and NFC contract.
	bpe:   BpeEncoding,
	/// Whole-word entries; only membership is read.
	whole: RankTable,
}

static JEV: LazyLock<Jev> = LazyLock::new(|| Jev {
	bpe:   BpeEncoding {
		table:         RankTable::parse(include_bytes!("../../data/jev_base.bin.zst")),
		splitter:      Splitter::Qwen,
		nfc:           true,
		ignore_merges: false,
	},
	whole: RankTable::parse(include_bytes!("../../data/jev_whole.bin.zst")),
});

/// Jev input-token count of `units` (any UTF flavor) as state content,
/// excluding the request frame. Valid text counts flavor-invariantly.
pub fn content_token_count<U: Unit>(units: &[U]) -> u32 {
	let jev = &*JEV;
	let mut n = 0u32;
	jev.bpe.run(units, &mut |base, piece| {
		n += if jev.whole.rank(piece).is_some() {
			1
		} else {
			piece.chunks(WINDOW).map(|w| base.count_merged(w)).sum()
		};
	});
	n
}
