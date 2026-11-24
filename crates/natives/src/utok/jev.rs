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

use std::{
	ops::{ControlFlow, Range},
	sync::LazyLock,
};

use xutf::ToUnicodeNormalized;

use crate::utok::{
	bpe::{self, PieceMemo, RankTable},
	pretoken::Splitter,
	scan,
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
/// Pieces are priced in order until one crosses the budget; no piece after
/// it is merged, and a piece over [`SHORT_PIECE_UNITS`] is merged only
/// through the [`WINDOW`]-byte chunk where it crosses. The NFC quick-check
/// still reads the whole input, and input that needs normalization takes the
/// slower exact path in `truncate_nfc`.
pub fn truncate_u16(units: &[u16], max_tokens: u32) -> usize {
	if units.is_empty() || max_tokens == 0 {
		return 0;
	}
	if !bpe::nfc_quick(units) {
		return truncate_nfc(units, max_tokens);
	}
	find_crossing(units, max_tokens).map_or(units.len(), |c| resolve_crossing(units, &c, max_tokens))
}

/// The first piece whose tokens take the running count past the budget.
struct Crossing {
	/// Last piece boundary at or before `start` that does not follow
	/// non-newline whitespace: every prefix ending at or past it splits the
	/// text before it as the full text does.
	anchor:        usize,
	/// Tokens of the pieces before `anchor`.
	anchor_tokens: u32,
	start:         usize,
	end:           usize,
	/// Longest cut in `start..=end` that fits when the part of the piece it
	/// keeps is priced as one piece.
	best:          usize,
}

fn find_crossing(units: &[u16], max_tokens: u32) -> Option<Crossing> {
	let jev = &*JEV;
	PieceMemo::with(|memo| {
		let mut buf = Vec::new();
		let mut tokens = 0u32;
		let mut anchor = (0usize, 0u32);
		let mut found = None;
		let _ = Splitter::Qwen.try_for_each_piece_range(units, &mut |range| {
			let best = if newline_then_space(&units[range.clone()]) {
				let bytes = bpe::piece_bytes(&units[range.clone()], &mut buf);
				let piece_tokens = count_jev_piece(jev, bytes, memo);
				if tokens.saturating_add(piece_tokens) <= max_tokens {
					tokens += piece_tokens;
					None
				} else {
					Some(refine_newline_run(
						jev,
						units,
						range.start,
						range.end,
						max_tokens - tokens,
						memo,
					))
				}
			} else if range.end - range.start <= SHORT_PIECE_UNITS {
				let bytes = bpe::piece_bytes(&units[range.clone()], &mut buf);
				let piece_tokens = count_jev_piece(jev, bytes, memo);
				if tokens.saturating_add(piece_tokens) <= max_tokens {
					tokens += piece_tokens;
					None
				} else {
					let remaining = max_tokens - tokens;
					Some(if remaining == 0 {
						range.start
					} else {
						refine_short_piece(jev, units, range.start, range.end, remaining, &mut buf, memo)
					})
				}
			} else {
				stream_long_piece(jev, units, range.start, range.end, max_tokens, &mut tokens, memo)
			};
			let Some(best) = best else {
				if !is_open_ws(units[range.end - 1]) {
					anchor = (range.end, tokens);
				}
				return ControlFlow::Continue(());
			};
			found = Some(Crossing {
				anchor: anchor.0,
				anchor_tokens: anchor.1,
				start: range.start,
				end: range.end,
				best,
			});
			ControlFlow::Break(())
		});
		found
	})
}

/// Longest fitting cut given the crossing piece. `find_crossing` prices
/// pieces as the full text splits them, but a whitespace run that gives its
/// last codepoint to the next piece (`ws_end`) keeps it in a prefix cut
/// right after that codepoint. Cuts where that can happen are priced exactly
/// from the anchor.
fn resolve_crossing(units: &[u16], c: &Crossing, max_tokens: u32) -> usize {
	let fits = |k: usize| {
		c.anchor_tokens
			.saturating_add(content_token_count(&units[c.anchor..k]))
			<= max_tokens
	};
	let (start, end) = (c.start, c.end);
	if end < units.len() && is_open_ws(units[end - 1]) && is_ws(units[end]) && fits(end + 1) {
		return end + 1;
	}
	// Past `exact_from`, a prefix keeps the crossing piece's split.
	let exact_from = if c.anchor < start {
		start + usize::from(is_ws(units[start]))
	} else {
		start
	};
	if c.best > exact_from {
		return c.best;
	}
	(c.anchor + 1..=exact_from.min(end))
		.rev()
		.find(|&k| !splits_pair(units, k) && fits(k))
		.unwrap_or(c.anchor)
}

/// Longest fitting cut inside a crossing `\s*[\r\n]+` piece with whitespace
/// after a newline. A prefix of it splits in two: a head through its last
/// newline, priced as a prefix of the piece, and the whitespace after that,
/// priced as a piece of its own. One pass sums the piece's complete
/// [`WINDOW`]s until they alone exceed `remaining`, which no later head
/// fits; cuts below that are then tried from the longest down.
fn refine_newline_run(
	jev: &Jev,
	units: &[u16],
	start: usize,
	end: usize,
	remaining: u32,
	memo: &mut PieceMemo,
) -> usize {
	let mut bytes = Vec::with_capacity(end - start);
	let mut offsets = Vec::with_capacity(end - start + 1);
	let mut sums = vec![0u32];
	let mut limit = end;
	let mut utf8 = [0u8; char::MAX_LEN_UTF8];
	for (i, &u) in units[start..end].iter().enumerate() {
		offsets.push(bytes.len());
		let c = char::from_u32(u32::from(u)).unwrap_or(char::REPLACEMENT_CHARACTER);
		bytes.extend_from_slice(c.encode_utf8(&mut utf8).as_bytes());
		if bytes.len() % WINDOW == 0 {
			let sum =
				sums[sums.len() - 1] + jev.base.count_merged(&bytes[bytes.len() - WINDOW..], memo);
			sums.push(sum);
			if sum > remaining {
				limit = start + i + 1;
				break;
			}
		}
	}
	offsets.push(bytes.len());
	let head = |k: usize, memo: &mut PieceMemo| {
		let len = offsets[k - start];
		if len <= jev.whole.max_token_len && jev.whole.rank(&bytes[..len]).is_some() {
			return 1;
		}
		let partial = &bytes[len - len % WINDOW..len];
		sums[len / WINDOW]
			+ if partial.is_empty() {
				0
			} else {
				jev.base.count_merged(partial, memo)
			}
	};
	// A stretch of other whitespace that `limit` cuts is its own piece, so
	// all of it stays a candidate.
	let mut k = if is_newline(units[limit - 1]) {
		limit
	} else {
		units[limit..end]
			.iter()
			.position(|&u| is_newline(u))
			.map_or(end, |i| limit + i)
	};
	let mut buf = Vec::new();
	while k > start {
		if is_newline(units[k - 1]) {
			if head(k, memo) <= remaining {
				return k;
			}
			k -= 1;
			continue;
		}
		let stretch = units[start..k]
			.iter()
			.rposition(|&u| is_newline(u))
			.map_or(start, |i| start + i + 1);
		let charged = if stretch == start {
			0
		} else {
			head(stretch, memo)
		};
		if charged < remaining {
			let best = fit_piece(jev, units, stretch, k, remaining - charged, &mut buf, memo);
			if best > stretch {
				return best;
			}
		}
		k = stretch;
	}
	start
}

/// Longest cut in `start..=end` whose part of `units[start..end]`, priced
/// as one piece, fits `remaining`.
fn fit_piece(
	jev: &Jev,
	units: &[u16],
	start: usize,
	end: usize,
	remaining: u32,
	buf: &mut Vec<u8>,
	memo: &mut PieceMemo,
) -> usize {
	if end - start <= SHORT_PIECE_UNITS {
		let bytes = bpe::piece_bytes(&units[start..end], buf);
		if count_jev_piece(jev, bytes, memo) <= remaining {
			return end;
		}
		return refine_short_piece(jev, units, start, end, remaining, buf, memo);
	}
	let mut tokens = 0;
	stream_long_piece(jev, units, start, end, remaining, &mut tokens, memo).unwrap_or(end)
}

/// Input that needs NFC. A cut between a base and its combining mark
/// normalizes differently from the normalized text, so cuts are taken on
/// `units` and priced exactly, between an anchor and a bound found on the
/// normalized text.
fn truncate_nfc(units: &[u16], max_tokens: u32) -> usize {
	let mut norm = Vec::with_capacity(units.len());
	for_each_nfc_segment(units, |_, nfc| {
		norm.extend_from_slice(nfc);
		ControlFlow::Continue(())
	});
	let Some(c) = find_crossing(&norm, max_tokens) else {
		return units.len();
	};
	// A prefix that normalizes past `bound` shares the normalized text's
	// pieces up to `bound`, which already exceed the budget.
	let mut bound = c.end;
	while bound < norm.len() && is_ws(norm[bound - 1]) {
		bound = scan::qwen::next_piece(&norm, bound);
	}
	let (mut from, mut from_tokens, mut last) = (0, 0, units.len());
	let mut at = 0;
	for_each_nfc_segment(units, |range, nfc| {
		if at > bound {
			last = range.start - 1;
			return ControlFlow::Break(());
		}
		// The anchor holds when its codepoint stays first in every prefix's
		// normalization, which an unchanged segment guarantees.
		if at == c.anchor && nfc == &units[range.clone()] {
			(from, from_tokens) = (range.start, c.anchor_tokens);
		}
		at += nfc.len();
		ControlFlow::Continue(())
	});
	(from + 1..=last)
		.rev()
		.find(|&k| {
			!splits_pair(units, k)
				&& from_tokens.saturating_add(content_token_count(&units[from..k])) <= max_tokens
		})
		.unwrap_or(from)
}

/// Feed `f` each normalization segment of `units` with its NFC. A segment
/// starts at a codepoint with combining class 0 and `NFC_QC=Yes`, which
/// never composes with what precedes it, so normalizing segments one by one
/// normalizes the text, and a prefix normalizes to the segments before its
/// cut plus its partial segment.
fn for_each_nfc_segment(units: &[u16], mut f: impl FnMut(Range<usize>, &[u16]) -> ControlFlow<()>) {
	let starts_segment = |c: char| {
		xutf::canonical_combining_class(c as u32) == 0 && xutf::is_nfc_codepoints([c as u32])
	};
	let mut buf = Vec::new();
	let mut pos = 0;
	while pos < units.len() {
		let (first, step) = u16::decode(units, pos);
		let mut end = pos + step;
		while end < units.len() {
			let (c, n) = u16::decode(units, end);
			if starts_segment(c) {
				break;
			}
			end += n;
		}
		let nfc: &[u16] = if end == pos + step && starts_segment(first) {
			&units[pos..end]
		} else {
			buf.clear();
			buf.extend(
				String::from_utf16_lossy(&units[pos..end])
					.to_nfc()
					.encode_utf16(),
			);
			&buf
		};
		if f(pos..end, nfc).is_break() {
			return;
		}
		pos = end;
	}
}

/// Whether a newline in `piece` is followed by other whitespace, which a
/// prefix ending there splits off from the newlines before it.
fn newline_then_space(piece: &[u16]) -> bool {
	piece
		.iter()
		.skip_while(|&&u| !is_newline(u))
		.any(|&u| is_open_ws(u))
}

fn is_ws(u: u16) -> bool {
	char::from_u32(u32::from(u)).is_some_and(char::is_whitespace)
}

fn is_newline(u: u16) -> bool {
	u == u16::from(b'\n') || u == u16::from(b'\r')
}

/// Whitespace other than a newline: a piece ending in it can grow when a
/// prefix cuts the run that follows.
fn is_open_ws(u: u16) -> bool {
	is_ws(u) && !is_newline(u)
}

fn splits_pair(units: &[u16], k: usize) -> bool {
	k > 0
		&& k < units.len()
		&& (0xd800..=0xdbff).contains(&units[k - 1])
		&& (0xdc00..=0xdfff).contains(&units[k])
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
/// `count_merged` applies. Whole words and merges make counts non-monotonic
/// in the cut, so every boundary is tried from the longest down.
fn refine_window_bounds(
	jev: &Jev,
	chunk_idx: usize,
	chunk_buf: &[u8],
	bounds: &[(usize, usize)],
	remaining: u32,
	memo: &mut PieceMemo,
) -> Option<usize> {
	if remaining == 0 {
		return None;
	}
	bounds.iter().rev().find_map(|&(u16_end, byte_end)| {
		let slice = &chunk_buf[..byte_end];
		let count = if chunk_idx == 0 && jev.whole.rank(slice).is_some() {
			1
		} else {
			jev.base.count_merged(slice, memo)
		};
		(count <= remaining).then_some(u16_end)
	})
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

	let base = *tokens;
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
		let below = prev_chunk_bounds
			.first()
			.map_or(start, |&(u16_end, _)| u16_end);
		return Some(refine_short_piece(
			jev,
			units,
			start,
			below,
			max_tokens - base,
			&mut Vec::new(),
			memo,
		));
	}
}
