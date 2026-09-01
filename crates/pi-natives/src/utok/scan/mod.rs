//! Hand-written per-family codepoint scanners (runtime pre-tokenization).
//!
//! Contract (see `pretoken`): each family exposes
//! `pub fn next_piece<U: Unit>(units: &[U], pos: usize) -> usize` returning
//! the END unit offset of the piece starting at `pos` (`pos < end <= len`).
//! Scanners run natively over any UTF flavor via [`Unit::decode`] — no
//! regex engine, no transcode. Correctness bar: piece boundaries identical
//! to the family's reference regex under fancy-regex/`regex`-module
//! semantics (leftmost-first alternation, greedy with backtracking);
//! fancy-regex remains a dev/test-only differential reference.
//!
//! Shared pieces: [`cls`] holds the character classes the patterns use,
//! and the helpers below implement whole alternates that recur across
//! families (contraction suffix, digit runs, punctuation runs, the
//! whitespace trio).

pub mod cl100k;
pub mod deepseek;
pub mod kimi;
pub mod o200k;
pub mod qwen;

use crate::utok::utf::Unit;

/// Shared character classes. `\s` in the reference regexes is exactly the
/// Unicode `White_Space` property, i.e. [`char::is_whitespace`];
/// `\p{L}`/`\p{N}`/`\p{M}` are the general-category groups.
///
/// **UCD generation.** `xutf` defaults to UCD 16.0.0 tables to match the
/// reference regex engines (fancy-regex, tiktoken-rs), so lookups call
/// `xutf` directly.
pub mod cls {
	use xutf::{GeneralCategory as GC, GeneralCategoryGroup as GCG, Script, Ucd};

	#[inline]
	pub fn category(c: char) -> GC {
		c.general_category()
	}

	#[inline]
	pub fn group(c: char) -> GCG {
		c.general_category_group()
	}

	#[inline]
	pub fn is_letter(c: char) -> bool {
		if c.is_ascii() {
			return c.is_ascii_alphabetic();
		}
		group(c) == GCG::Letter
	}

	#[inline]
	pub fn is_number(c: char) -> bool {
		if c.is_ascii() {
			return c.is_ascii_digit();
		}
		group(c) == GCG::Number
	}

	#[inline]
	pub fn is_mark(c: char) -> bool {
		!c.is_ascii() && group(c) == GCG::Mark
	}

	#[inline]
	pub const fn is_ws(c: char) -> bool {
		c.is_whitespace()
	}

	/// `\p{Han}` = Script=Han (includes e.g. 〇 U+3007 Nl and 々 U+3005 Lm).
	/// The 17.0 additions include 4321 Han scalars (CJK ext. J, the ext.
	/// B/F tail fills, and U+16FF2..=U+16FF6) that are `Script=Unknown` for
	/// the reference engine.
	#[inline]
	pub fn is_han(c: char) -> bool {
		!c.is_ascii() && c.script() == Script::Han
	}
	/// `[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]` — tiktoken's "uppercase or
	/// caseless letter" set. Overlaps [`in_lower_set`] on `Lm`/`Lo`/`M`.
	#[inline]
	pub fn in_upper_set(c: char) -> bool {
		if c.is_ascii() {
			return c.is_ascii_uppercase();
		}
		let cat = category(c);
		matches!(
			cat,
			GC::UppercaseLetter | GC::TitlecaseLetter | GC::ModifierLetter | GC::OtherLetter
		) || cat.group() == GCG::Mark
	}

	/// `[\p{Ll}\p{Lm}\p{Lo}\p{M}]` — "lowercase or caseless letter" set.
	#[inline]
	pub fn in_lower_set(c: char) -> bool {
		if c.is_ascii() {
			return c.is_ascii_lowercase();
		}
		let cat = category(c);
		matches!(cat, GC::LowercaseLetter | GC::ModifierLetter | GC::OtherLetter)
			|| cat.group() == GCG::Mark
	}
}

/// Decode the codepoint at `i`, or `None` at end of input.
#[inline]
pub(crate) fn decode_at<U: Unit>(units: &[U], i: usize) -> Option<(char, usize)> {
	(i < units.len()).then(|| U::decode(units, i))
}

/// `(?i:'s|'t|'re|'ve|'m|'ll|'d)` at `pos`. Returns the end, or `pos` when
/// absent (the alternate is used both standalone and as an optional
/// suffix). Case-insensitivity is simple case folding, so `'s` also
/// matches U+017F ſ — matching the reference regex engines.
pub(crate) fn contraction_end<U: Unit>(units: &[U], pos: usize) -> usize {
	let Some(('\'', n0)) = decode_at(units, pos) else {
		return pos;
	};
	let Some((c1, n1)) = decode_at(units, pos + n0) else {
		return pos;
	};
	let one = pos + n0 + n1;
	match c1 {
		's' | 'S' | '\u{17f}' | 't' | 'T' | 'm' | 'M' | 'd' | 'D' => one,
		'r' | 'R' | 'v' | 'V' => match decode_at(units, one) {
			Some(('e' | 'E', n2)) => one + n2,
			_ => pos,
		},
		'l' | 'L' => match decode_at(units, one) {
			Some(('l' | 'L', n2)) => one + n2,
			_ => pos,
		},
		_ => pos,
	}
}

/// `\p{N}{1,3}` at `pos`.
pub(crate) fn digits_end<U: Unit>(units: &[U], pos: usize) -> Option<usize> {
	let mut i = pos;
	for _ in 0..3 {
		match decode_at(units, i) {
			Some((c, n)) if cls::is_number(c) => i += n,
			_ => break,
		}
	}
	(i > pos).then_some(i)
}

/// ` ?[^\s\p{L}\p{N}]+[\r\n]*` at `pos`; `trailing_slash` adds o200k's `/`
/// to the tail class (`[\r\n/]*`).
pub(crate) fn punct_end<U: Unit>(units: &[U], pos: usize, trailing_slash: bool) -> Option<usize> {
	let mut i = pos;
	if let Some((' ', n)) = decode_at(units, pos) {
		i += n;
	}
	let start = i;
	while let Some((c, n)) = decode_at(units, i) {
		if cls::is_ws(c) || cls::is_letter(c) || cls::is_number(c) {
			break;
		}
		i += n;
	}
	if i == start {
		return None;
	}
	while let Some((c, n)) = decode_at(units, i) {
		if c == '\r' || c == '\n' || (trailing_slash && c == '/') {
			i += n;
		} else {
			break;
		}
	}
	Some(i)
}

/// The tiktoken whitespace trio `\s*[\r\n]+|\s+(?!\S)|\s+`, in that
/// alternation order, at `pos`:
/// - a run containing a newline matches through its *last* `\r`/`\n` (trailing
///   non-newline whitespace excluded — backtracked `\s*`),
/// - otherwise a run at end of input matches whole,
/// - otherwise the run gives back one codepoint for the `(?!\S)` lookahead
///   (unless it is a single codepoint, which `\s+` takes whole).
pub(crate) fn ws_end<U: Unit>(units: &[U], pos: usize) -> Option<usize> {
	let mut i = pos;
	let mut last_nl_end = None;
	let mut last_len = 0;
	let mut cps = 0usize;
	while let Some((c, n)) = decode_at(units, i) {
		if !cls::is_ws(c) {
			break;
		}
		i += n;
		if c == '\r' || c == '\n' {
			last_nl_end = Some(i);
		}
		last_len = n;
		cps += 1;
	}
	if cps == 0 {
		return None;
	}
	if let Some(e) = last_nl_end {
		return Some(e);
	}
	if i == units.len() {
		return Some(i);
	}
	Some(if cps > 1 { i - last_len } else { i })
}

#[cfg(test)]
mod tests {
	use regex::Regex;
	use xutf::GeneralCategoryGroup as GCG;

	use super::cls;

	/// `xutf` must resolve against UCD 16.0.0 (the default) so the scanners
	/// match the regex-syntax tables.
	#[test]
	fn class_pin_tracks_xutf_ucd_generation() {
		assert_eq!(
			xutf::UCD_VERSION,
			(16, 0, 0),
			"xutf UCD generation moved: must resolve against UCD 16.0.0"
		);
	}

	/// Every scalar the class matches, per the reference regex engine (the
	/// `regex`/fancy-regex `regex-syntax` tables the differential oracles
	/// resolve `\p{…}` through).
	fn reference_members(all: &str, pattern: &str) -> Vec<bool> {
		let re = Regex::new(pattern).unwrap();
		let mut set = vec![false; 0x11_0000];
		for m in re.find_iter(all) {
			for c in m.as_str().chars() {
				set[c as usize] = true;
			}
		}
		set
	}

	/// A reference `\p{…}` pattern paired with the [`cls`] predicate that
	/// must reproduce it.
	type Class = (&'static str, fn(char) -> bool);

	/// Exhaustive scalar sweep: each [`cls`] predicate must agree with its
	/// reference-regex class on all 0x110000 codepoints. This is what the
	/// per-family differential tests sample, so it fails first — and it is
	/// the guard against `xutf`'s UCD generation drifting ahead of the
	/// engine's (unpinned, the 4803 scalars UCD 17.0.0 added over 16.0.0
	/// re-split text and change token ids).
	#[test]
	fn classes_match_reference_regex_on_every_scalar() {
		let all: String = (0..0x11_0000u32).filter_map(char::from_u32).collect();
		let classes: [Class; 8] = [
			(r"\p{L}", cls::is_letter),
			(r"\p{N}", cls::is_number),
			(r"\p{M}", cls::is_mark),
			(r"\s", cls::is_ws),
			(r"\p{Han}", cls::is_han),
			(r"[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]", cls::in_upper_set),
			(r"[\p{Ll}\p{Lm}\p{Lo}\p{M}]", cls::in_lower_set),
			(r"[\p{P}\p{S}]", |c| matches!(cls::group(c), GCG::Punctuation | GCG::Symbol)),
		];
		for (pattern, ours) in classes {
			let theirs = reference_members(&all, pattern);
			let mut bad = Vec::new();
			for c in (0..0x11_0000u32).filter_map(char::from_u32) {
				if ours(c) != theirs[c as usize] {
					bad.push(c as u32);
				}
			}
			assert!(
				bad.is_empty(),
				"{pattern}: {} scalars diverge, first: {:04X?}",
				bad.len(),
				&bad[..bad.len().min(8)]
			);
		}
	}
}
