//! Kimi K2/K3 pre-tokenizer: hand-written codepoint scanner over `&[U]`.
//!
//! Faithful port of the 8-alternate `pat_str` from `tokenization_kimi.py`
//! (see `KIMI_K2_PATTERN` in `tables.rs`), replicating fancy-regex's
//! leftmost-first alternation and greedy-with-backtracking quantifiers:
//!
//! 1. `[\p{Han}]+`
//! 2. `P? A* B+ C?` — P = `[^\r\n\p{L}\p{N}]`, A = upper set minus Han, B =
//!    lower set minus Han, C = `(?i:'s|'t|'re|'ve|'m|'ll|'d)`
//! 3. `P? A+ B* C?`
//! 4. `\p{N}{1,3}`
//! 5. ` ?[^\s\p{L}\p{N}]+[\r\n]*`
//! 6. `\s*[\r\n]+`
//! 7. `\s+(?!\S)`
//! 8. `\s+`
//!
//! Alternates 4–8 are the shared helpers ([`digits_end`], [`punct_end`]
//! without o200k's `/` tail, [`ws_end`]); only the Han run and the
//! Han-excluded letter cores are Kimi-specific. Alternates are tried in
//! order at each position; every scalar matches one of them, so no gaps
//! arise. Differential-tested against the fancy-regex splitter (the
//! reference tiktoken engine) in `tests` below.

use super::{cls, contraction_end, decode_at, digits_end, punct_end, ws_end};
use crate::utok::utf::Unit;

/// Class A: `[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]`.
#[inline]
fn in_a(c: char) -> bool {
	cls::in_upper_set(c) && !cls::is_han(c)
}

/// Class B: `[\p{Ll}\p{Lm}\p{Lo}\p{M}&&[^\p{Han}]]`.
#[inline]
fn in_b(c: char) -> bool {
	cls::in_lower_set(c) && !cls::is_han(c)
}

/// `A* B+ C?` from `pos`; end unit offset on success.
fn core_lower<U: Unit>(units: &[U], pos: usize) -> Option<usize> {
	// Greedy A*, remembering the end of the last A-scalar that is also in
	// B: backtracking scans A* backward, and the first ∈B scalar found is
	// the last ∈B scalar forward. B's greedy run from there ends where the
	// A run did (nothing between it and the run end is in B).
	let mut i = pos;
	let mut last_b_end = None;
	while let Some((c, n)) = decode_at(units, i) {
		if !in_a(c) {
			break;
		}
		i += n;
		if in_b(c) {
			last_b_end = Some(i);
		}
	}
	// B+ directly after the full A run.
	let mut e = i;
	while let Some((c, n)) = decode_at(units, e) {
		if !in_b(c) {
			break;
		}
		e += n;
	}
	if e > i {
		return Some(contraction_end(units, e));
	}
	last_b_end.map(|e| contraction_end(units, e))
}

/// `A+ B* C?` from `pos`; end unit offset on success. `B*` never forces
/// backtracking, so this is two greedy runs.
fn core_upper<U: Unit>(units: &[U], pos: usize) -> Option<usize> {
	let mut i = pos;
	while let Some((c, n)) = decode_at(units, i) {
		if !in_a(c) {
			break;
		}
		i += n;
	}
	if i == pos {
		return None;
	}
	let mut e = i;
	while let Some((c, n)) = decode_at(units, e) {
		if !in_b(c) {
			break;
		}
		e += n;
	}
	Some(contraction_end(units, e))
}

/// END unit offset of the piece starting at `pos` (`pos < end <= len`).
/// The alternates cover every Unicode scalar, so a piece always exists.
pub fn next_piece<U: Unit>(units: &[U], pos: usize) -> usize {
	let (c0, l0) = U::decode(units, pos);

	// 1: [\p{Han}]+
	if cls::is_han(c0) {
		let mut i = pos + l0;
		while let Some((c, n)) = decode_at(units, i) {
			if !cls::is_han(c) {
				break;
			}
			i += n;
		}
		return i;
	}

	// 2/3: the letter cores, each trying the greedy-optional prefix
	// `[^\r\n\p{L}\p{N}]?` (space, punctuation, symbols, marks, …) before
	// the bare form — regex backtracking order.
	let p = c0 != '\r' && c0 != '\n' && !cls::is_letter(c0) && !cls::is_number(c0);
	if p && let Some(e) = core_lower(units, pos + l0) {
		return e;
	}
	if let Some(e) = core_lower(units, pos) {
		return e;
	}
	if p && let Some(e) = core_upper(units, pos + l0) {
		return e;
	}
	if let Some(e) = core_upper(units, pos) {
		return e;
	}

	// 4: \p{N}{1,3}
	if let Some(e) = digits_end(units, pos) {
		return e;
	}
	// 5: ` ?[^\s\p{L}\p{N}]+[\r\n]*` (no o200k `/` tail)
	if let Some(e) = punct_end(units, pos, false) {
		return e;
	}
	// 6/7/8: whitespace trio
	if let Some(e) = ws_end(units, pos) {
		return e;
	}

	// Unreachable for assigned scalars; consume one as a defensive gap.
	pos + l0
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Split with the scanner over `U` units; pieces come back as decoded
	/// strings for cross-flavor comparison.
	fn scan_pieces<U: Unit>(units: &[U]) -> Vec<String> {
		let mut out = Vec::new();
		let mut pos = 0;
		while pos < units.len() {
			let end = next_piece(units, pos);
			assert!(end > pos && end <= units.len(), "bad piece end {end} at {pos}");
			let mut s = String::new();
			let mut i = pos;
			while i < end {
				let (c, l) = U::decode(units, i);
				s.push(c);
				i += l;
			}
			out.push(s);
			pos = end;
		}
		out
	}

	fn regex_pieces(text: &str) -> Vec<String> {
		crate::utok::pretoken::Splitter::new(&[crate::utok::tables::KIMI_K2_PATTERN])
			.split(text)
			.into_iter()
			.map(str::to_owned)
			.collect()
	}

	fn check(text: &str) {
		let want = regex_pieces(text);
		assert_eq!(scan_pieces(text.as_bytes()), want, "u8 split drift on {text:?}");
		let u16s: Vec<u16> = text.encode_utf16().collect();
		assert_eq!(scan_pieces(u16s.as_slice()), want, "u16 split drift on {text:?}");
		let u32s: Vec<u32> = text.chars().map(|c| c as u32).collect();
		assert_eq!(scan_pieces(u32s.as_slice()), want, "u32 split drift on {text:?}");
	}

	#[test]
	fn kimi_scanner_matches_regex_on_fixtures() {
		let raw = include_str!("../../../fixtures/kimi_k2.json");
		let v: serde_json::Value = serde_json::from_str(raw).unwrap();
		for case in v["cases"].as_array().unwrap() {
			check(case["text"].as_str().unwrap());
		}
	}

	#[test]
	fn kimi_scanner_matches_regex_on_edges() {
		for text in [
			"",
			"'",
			"''",
			"'s",
			"x'S y'RE z'Ll w'ſ q'ſt",   // case-folded contractions incl. U+017F
			"can't CAN'T Can'T can'tt", // contraction then trailing letters
			"HELLO Hello hELLO ǅungla ǄUNGLA", // titlecase Lt
			"a\u{301}\u{301}ABC \u{301}abc \u{301}\u{301}", // marks as P/A/B
			"〇々中文 一二三456 ７８９", // Han Nl/Lm, fullwidth digits
			"中文English中文 中文english ENGLISH中文",
			"!HELLO !hello ¡Hola! ¿qué?",
			" !! !?\r\n\n x",
			"  \t\r\n \n\t  ",
			"\r \n \r\n\r\n\t",
			"a  b   c    ",
			" 12 345 6789 12345",
			"👍🏽x 👨‍👩‍👧‍👦 𝕏≈∑ 𠀀𠀁a𠀂",      // astral: emoji, math letters, Ext-B Han
			"ᵃᵇᶜ modifier ʰʷ letters", // Lm in both A and B
			"ǰŠŽ æÆœŒ ß ẞ",
		] {
			check(text);
		}
	}

	#[test]
	fn kimi_scanner_matches_regex_on_random_text() {
		// Deterministic xorshift over a multilingual pool biased toward the
		// pattern's trouble spots: Han boundaries, case turns, marks,
		// contractions, digits, whitespace shapes, astral scalars.
		let pool: Vec<char> = concat!(
			"abcdefgh XYZ ǅǄǆ 中文漢字词语〇々 ",
			"0123456789٠١٢٣๓๔ ７８",
			"'stremvld ſ ",
			"!?#$%&*()-_=+[]{};:,.<>/\\|\"`~@^",
			" \t\r\n\u{a0}\u{2028}\u{3000}",
			"\u{301}\u{308}\u{4dc}\u{5d0}\u{916}\u{c15}\u{1f600}👍🏽𝕏𠀀𐍈",
			"éàüñ ΑΒΓαβγ АБВабв 가나다 カナかな",
		)
		.chars()
		.collect();
		let mut state = 0x9e37_79b9_7f4a_7c15u64;
		let mut rand = move || {
			state ^= state << 13;
			state ^= state >> 7;
			state ^= state << 17;
			state
		};
		for _ in 0..2000 {
			let len = (rand() % 64) as usize;
			let text: String = (0..len)
				.map(|_| pool[(rand() as usize) % pool.len()])
				.collect();
			check(&text);
		}
	}
}
