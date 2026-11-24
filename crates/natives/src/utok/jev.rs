//! Offline reconstruction of `TypeSafe` Jev's input-token counts (`jev-1.13`).
//!
//! Jev reports only `usage.input_tokens`, so this model was recovered from
//! counts alone: ~639k probes against the live System One API, split into a
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
//!    tiktoken's byte-pair merge with o200k ranks, restricted to a ~54k-token
//!    base subset of o200k. Whole-piece hits in the base table are *not*
//!    short-circuited ([`RankTable::count_merged`]): `token` is a whole word
//!    but not a base token, so `tokenize` costs 3.
//!
//! Both sets are o200k subsets but keep their own rank tables: merging
//! through the shared o200k table behind a rank-membership filter priced
//! every lookup twice and counted ~23% slower.
//!
//! Counts are state *content*: the request frame (question text, template,
//! 269 tokens for a minimal one-noul request) is excluded, matching the
//! other families' "no chat-template frame" semantics.
//!
//! [`Encoding::Qwen3`]: crate::utok::Encoding::Qwen3

use std::{ops::ControlFlow, sync::LazyLock};

use crate::utok::{
	Encoding,
	bpe::{self, PieceMemo, RankTable},
	pretoken::Splitter,
	utf::Unit,
};

/// Longest byte span one merge run covers: longer pieces are merged in
/// independent windows (measured: a random consonant run matches unwindowed
/// merging through 513 bytes and diverges at 514, and a Lao word gains a token
/// once it crosses byte 512 mid-character).
const WINDOW: usize = 512;

/// Short-piece threshold (in UTF-16 code units). Any piece at or below this
/// length encodes to at most 384 UTF-8 bytes (< [`WINDOW`]), so it never
/// spans multiple 512-byte merge windows and can be refined by an exact
/// backward scan without monotonicity assumptions.
const SHORT_PIECE_UNITS: usize = 128;

struct Jev {
	/// Base merge table (o200k ranks, non-base slots empty).
	base:  RankTable,
	/// Whole-word entries; only membership is read.
	whole: RankTable,
}

static JEV: LazyLock<Jev> = LazyLock::new(|| Jev {
	base:  RankTable::parse(include_bytes!("../../data/jev_base.bin.zst")),
	whole: RankTable::parse(include_bytes!("../../data/jev_whole.bin.zst")),
});

/// Jev input-token count of `units` (any UTF flavor) as state content,
/// excluding the request frame. Valid text counts flavor-invariantly.
pub fn content_token_count<U: Unit>(units: &[U]) -> u32 {
	let jev = &*JEV;
	PieceMemo::with(|memo| {
		let mut n = 0u32;
		bpe::for_each_piece(&Splitter::Qwen, true, units, &mut |piece| {
			n += count_jev_piece(jev, piece, memo);
		});
		n
	})
}

/// Longest UTF-16 prefix of `units` whose Jev token count is at most
/// `max_tokens`, never splitting a surrogate pair.
///
/// Streams long pieces (`> 128` UTF-16 code units) in independent
/// [`WINDOW`]-byte UTF-8 chunks so oversized inputs stop immediately at the
/// first overflowing window without scanning or transcoding the remainder, and
/// resolves non-monotonic `jev.whole` / BPE dips exactly within the crossing
/// piece or window.
pub fn truncate_u16(units: &[u16], max_tokens: u32) -> usize {
	if units.is_empty() || max_tokens == 0 {
		return 0;
	}
	if !bpe::nfc_quick(units) {
		return if content_token_count(units) <= max_tokens {
			units.len()
		} else {
			bpe::bisect_u16(Encoding::Jev, units, max_tokens, units.len())
		};
	}

	let jev = &*JEV;
	let overflow = PieceMemo::with(|memo| {
		let mut buf = Vec::new();
		let mut tokens = 0u32;
		let mut found: Option<(usize, usize)> = None;
		let _ = Splitter::Qwen.try_for_each_piece_range(units, &mut |range| {
			if range.end - range.start <= SHORT_PIECE_UNITS {
				let bytes = bpe::piece_bytes(&units[range.clone()], &mut buf);
				let piece_tokens = count_jev_piece(jev, bytes, memo);
				if tokens.saturating_add(piece_tokens) <= max_tokens {
					tokens += piece_tokens;
					return ControlFlow::Continue(());
				}
				let remaining = max_tokens - tokens;
				let best = if remaining == 0 {
					range.start
				} else {
					refine_short_piece(jev, units, range.start, range.end, remaining, &mut buf, memo)
				};
				found = Some((range.end, best));
				return ControlFlow::Break(());
			}

			match stream_long_piece(jev, units, range.start, range.end, max_tokens, &mut tokens, memo)
			{
				Some(best) => {
					found = Some((range.end, best));
					ControlFlow::Break(())
				},
				None => ControlFlow::Continue(()),
			}
		});
		found
	});

	let Some((range_end, best)) = overflow else {
		return units.len();
	};
	let candidate = bpe::extend_whitespace_fusion(Encoding::Jev, units, best, range_end, max_tokens);
	if content_token_count(&units[..candidate]) <= max_tokens {
		return candidate;
	}
	bpe::bisect_u16(Encoding::Jev, units, max_tokens, candidate)
}

#[inline]
fn count_jev_piece(jev: &Jev, piece: &[u8], memo: &mut PieceMemo) -> u32 {
	if jev.whole.rank(piece).is_some() {
		1
	} else {
		piece
			.chunks(WINDOW)
			.map(|w| jev.base.count_merged(w, memo))
			.sum()
	}
}

/// Exact backward scan inside a single-window piece (`<= SHORT_PIECE_UNITS`),
/// finding the longest UTF-16 prefix with `count_jev_piece <= remaining` even
/// when `jev.whole` makes counts non-monotonic (e.g. `"SELE"`=2, `"SELECT"`=1).
fn refine_short_piece(
	jev: &Jev,
	units: &[u16],
	start: usize,
	end: usize,
	remaining: u32,
	buf: &mut Vec<u8>,
	memo: &mut PieceMemo,
) -> usize {
	let mut pos = bpe::prev_u16_boundary(units, end);
	while pos > start {
		let bytes = bpe::piece_bytes(&units[start..pos], buf);
		if count_jev_piece(jev, bytes, memo) <= remaining {
			return pos;
		}
		pos = bpe::prev_u16_boundary(units, pos);
	}
	start
}

/// Refine inside one `<= WINDOW`-byte chunk using its recorded `(u16_end,
/// byte_end)` scalar boundaries. For `chunk_idx == 0`, checks `jev.whole` in
/// addition to `jev.base.count_merged`; for `chunk_idx > 0`, any prefix ending
/// in this chunk exceeds `WINDOW` bytes (> `jev.whole.max_token_len`) so only
/// `count_merged` applies.
fn refine_window_bounds(
	jev: &Jev,
	chunk_idx: usize,
	chunk_buf: &[u8],
	bounds: &[(usize, usize)],
	remaining: u32,
	memo: &mut PieceMemo,
) -> Option<usize> {
	if remaining == 0 || bounds.is_empty() {
		return None;
	}
	let count_at = |byte_end: usize, memo: &mut PieceMemo| -> u32 {
		let slice = &chunk_buf[..byte_end];
		if chunk_idx == 0 && jev.whole.rank(slice).is_some() {
			1
		} else {
			jev.base.count_merged(slice, memo)
		}
	};

	if bounds.len() <= 64 {
		for &(u16_end, byte_end) in bounds.iter().rev() {
			if count_at(byte_end, memo) <= remaining {
				return Some(u16_end);
			}
		}
		return None;
	}

	// Binary search `bounds` (~8 probes on <= 512 bytes) to find the upper knee,
	// then scan forward up to 64 entries for BPE merge dips and (on chunk 0)
	// backwards across `jev.whole.max_token_len` for whole-word hits.
	let mut lo = 0usize;
	let mut hi = bounds.len();
	while lo < hi {
		let mid = lo + ((hi - lo) >> 1);
		if count_at(bounds[mid].1, memo) <= remaining {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	let mut best_idx = lo.checked_sub(1);
	let scan_end = bounds.len().min(lo.saturating_add(64));
	for (idx, &(_, byte_end)) in bounds[lo..scan_end].iter().enumerate() {
		let c = count_at(byte_end, memo);
		if c <= remaining {
			best_idx = Some(lo + idx);
		} else if c > remaining.saturating_add(4) {
			break;
		}
	}
	if chunk_idx == 0 {
		let max_whole = jev.whole.max_token_len;
		for (idx, &(_, byte_end)) in bounds.iter().enumerate().rev() {
			if byte_end > max_whole {
				continue;
			}
			if best_idx.is_some_and(|best| idx <= best) {
				break;
			}
			if jev.whole.rank(&chunk_buf[..byte_end]).is_some() {
				best_idx = Some(idx);
				break;
			}
		}
	}
	best_idx.map(|idx| bounds[idx].0)
}

/// Stream a long piece (`> SHORT_PIECE_UNITS`) in exact [`WINDOW`]-byte UTF-8
/// chunks, stopping immediately at the first overflowing chunk. Returns
/// `Some(best_u16_end)` if the piece overflows `max_tokens`, or `None` if the
/// entire piece fits (having added its exact token count to `*tokens`).
fn stream_long_piece(
	jev: &Jev,
	units: &[u16],
	start: usize,
	end: usize,
	max_tokens: u32,
	tokens: &mut u32,
	memo: &mut PieceMemo,
) -> Option<usize> {
	let mut chunk_buf: Vec<u8> = Vec::with_capacity(WINDOW + 4);
	let mut chunk_bounds: Vec<(usize, usize)> = Vec::with_capacity(WINDOW);
	let mut prev_chunk_buf: Vec<u8> = Vec::new();
	let mut prev_chunk_bounds: Vec<(usize, usize)> = Vec::new();
	let mut prev_chunk_tokens = 0u32;

	let mut u16_pos = start;
	let mut chunk_idx = 0usize;
	let mut carry_len = 0usize;
	let mut utf8_tmp = [0u8; char::MAX_LEN_UTF8];

	loop {
		chunk_bounds.clear();
		if carry_len > 0 {
			// Trailing bytes of a multi-byte scalar that straddled the prior
			// 512-byte boundary complete that scalar at `u16_pos`.
			chunk_bounds.push((u16_pos, carry_len));
		}
		while chunk_buf.len() < WINDOW && u16_pos < end {
			if let Some(b) = units[u16_pos].ascii() {
				chunk_buf.push(b);
				u16_pos += 1;
				chunk_bounds.push((u16_pos, chunk_buf.len()));
			} else {
				let (ch, step) = u16::decode(units, u16_pos);
				let encoded = ch.encode_utf8(&mut utf8_tmp).as_bytes();
				chunk_buf.extend_from_slice(encoded);
				u16_pos += step;
				if chunk_buf.len() <= WINDOW {
					chunk_bounds.push((u16_pos, chunk_buf.len()));
				}
			}
		}

		// Entire piece fit in a single <= WINDOW-byte chunk: check `jev.whole`.
		if chunk_idx == 0 && u16_pos == end && chunk_buf.len() <= WINDOW {
			let piece_tokens = count_jev_piece(jev, &chunk_buf, memo);
			if tokens.saturating_add(piece_tokens) <= max_tokens {
				*tokens += piece_tokens;
				return None;
			}
			let remaining = max_tokens - *tokens;
			return Some(
				refine_window_bounds(jev, 0, &chunk_buf, &chunk_bounds, remaining, memo)
					.unwrap_or(start),
			);
		}

		let win_len = chunk_buf.len().min(WINDOW);
		let chunk_tokens = jev.base.count_merged(&chunk_buf[..win_len], memo);
		if tokens.saturating_add(chunk_tokens) <= max_tokens {
			*tokens += chunk_tokens;
			prev_chunk_buf.clear();
			prev_chunk_buf.extend_from_slice(&chunk_buf[..win_len]);
			prev_chunk_bounds.clear();
			prev_chunk_bounds.extend_from_slice(&chunk_bounds);
			prev_chunk_tokens = chunk_tokens;

			if chunk_buf.len() > WINDOW {
				carry_len = chunk_buf.len() - WINDOW;
				chunk_buf.copy_within(WINDOW.., 0);
				chunk_buf.truncate(carry_len);
				chunk_idx += 1;
				continue;
			}
			chunk_buf.clear();
			carry_len = 0;
			if u16_pos == end {
				return None;
			}
			chunk_idx += 1;
			continue;
		}

		// Overflow in chunk `chunk_idx`: any prefix longer than `(chunk_idx + 1)
		// * WINDOW` bytes cannot hit `jev.whole` and keeps all `chunk_idx + 1`
		// full chunks intact, so the longest fitting prefix lies in
		// `chunk_bounds` or (if empty/straddling) at the tail of
		// `prev_chunk_bounds`.
		let remaining = max_tokens - *tokens;
		if let Some(best) =
			refine_window_bounds(jev, chunk_idx, &chunk_buf, &chunk_bounds, remaining, memo)
		{
			return Some(best);
		}
		if chunk_idx == 0 {
			return Some(start);
		}
		if carry_len == 0 {
			return Some(
				prev_chunk_bounds
					.last()
					.map_or(start, |&(u16_end, _)| u16_end),
			);
		}
		// A multi-byte scalar straddled the boundary into this chunk, so dropping
		// it trims 1..=3 bytes from `prev_chunk_buf`; confirm the trimmed
		// previous chunk still fits within `max_tokens`.
		let tokens_before_prev = *tokens - prev_chunk_tokens;
		let prev_remaining = max_tokens - tokens_before_prev;
		for &(u16_end, byte_end) in prev_chunk_bounds.iter().rev() {
			let slice = &prev_chunk_buf[..byte_end];
			let c = if chunk_idx == 1 && jev.whole.rank(slice).is_some() {
				1
			} else {
				jev.base.count_merged(slice, memo)
			};
			if c <= prev_remaining {
				return Some(u16_end);
			}
		}
		return Some(start);
	}
}
