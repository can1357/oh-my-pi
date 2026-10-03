//! Qwen3 (3.5/3.6/3.8) split pattern as a codepoint scanner.
//!
//! Reference (qwen3.8.tokenizer.json `pre_tokenizer`, = families.json qwen3):
//! ```text
//! (?i:'s|'t|'re|'ve|'m|'ll|'d)
//! |[^\r\n\p{L}\p{N}]?[\p{L}\p{M}]+
//! |\p{N}
//! | ?[^\s\p{L}\p{M}\p{N}]+[\r\n]*
//! |\s*[\r\n]+
//! |\s+(?!\S)
//! |\s+
//! ```
//! Deviations from cl100k: letter runs include marks (`[\p{L}\p{M}]+`)
//! and the optional prefix class admits marks (real backtracking: a lone
//! mark is both prefix- and run-eligible), `\p{N}` is a SINGLE codepoint
//! (not `{1,3}`), and punctuation runs exclude marks.
//!
//! NFC is not this layer's concern: the engine normalizes before scanning
//! (`BpeEncoding` nfc funnel).

use super::{cls, contraction_end, decode_at, ws_end};
use crate::utok::utf::Unit;

/// End of the piece starting at `pos` (`pos < units.len()`).
pub fn next_piece<U: Unit>(units: &[U], pos: usize) -> usize {
	let e = contraction_end(units, pos);
	if e > pos {
		return e;
	}
	if let Some(e) = word(units, pos) {
		return e;
	}
	let Some((c, n)) = decode_at(units, pos) else {
		return pos + 1;
	};
	if cls::is_number(c) {
		// `\p{N}`: exactly one codepoint.
		return pos + n;
	}
	if let Some(e) = punct(units, pos) {
		return e;
	}
	if let Some(e) = ws_end(units, pos) {
		return e;
	}
	// Unreachable for real input (the alternates cover every codepoint);
	// isolate one codepoint so the scan always advances.
	pos + n
}

/// `[\p{L}\p{M}]+` run end starting at `pos` (may equal `pos`).
#[inline]
fn lm_run_end<U: Unit>(units: &[U], pos: usize) -> usize {
	let mut i = pos;
	while let Some((c, n)) = decode_at(units, i) {
		if !cls::is_letter(c) && !cls::is_mark(c) {
			break;
		}
		i += n;
	}
	i
}

/// `[^\r\n\p{L}\p{N}]?[\p{L}\p{M}]+`. The prefix class admits marks, which
/// are also run codepoints, so the greedy optional prefix backtracks: when
/// nothing follows a mark prefix, the mark itself is the run.
fn word<U: Unit>(units: &[U], pos: usize) -> Option<usize> {
	let (c, n) = decode_at(units, pos)?;
	if c != '\r' && c != '\n' && !cls::is_letter(c) && !cls::is_number(c) {
		// Greedy: try with the prefix consumed.
		let e = lm_run_end(units, pos + n);
		if e > pos + n {
			return Some(e);
		}
		// Backtrack to no prefix: only a mark is still run-eligible
		// (letters are excluded from the prefix class).
		return cls::is_mark(c).then_some(pos + n);
	}
	// No prefix possible; run only if `c` itself is a letter.
	let e = lm_run_end(units, pos);
	(e > pos).then_some(e)
}

/// ` ?[^\s\p{L}\p{M}\p{N}]+[\r\n]*`. No backtracking needed: the body
/// class excludes whitespace, so a failed body after the optional space
/// cannot succeed from the space either.
fn punct<U: Unit>(units: &[U], pos: usize) -> Option<usize> {
	let (c, n) = decode_at(units, pos)?;
	let start = if c == ' ' { pos + n } else { pos };
	let mut i = start;
	while let Some((c, n)) = decode_at(units, i) {
		if cls::is_ws(c) || cls::is_letter(c) || cls::is_mark(c) || cls::is_number(c) {
			break;
		}
		i += n;
	}
	if i == start {
		return None;
	}
	while let Some((c, n)) = decode_at(units, i) {
		if c != '\r' && c != '\n' {
			break;
		}
		i += n;
	}
	Some(i)
}

#[cfg(test)]
mod tests {
	//! Differential: scanner piece boundaries vs the reference fancy-regex
	//! splitter, over corpus + torture cases + seeded random strings.

	use crate::utok::{pretoken::Splitter, tables::QWEN3_PATTERN};

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

	/// Qwen-torture: mark prefix/run overlap, single-codepoint numbers,
	/// mark-free punctuation runs, contraction folds, whitespace trio.
	const TRICKY: &[&str] = &[
		"\u{301}",            // lone mark: run via prefix backtrack
		"\u{301}abc",         // mark prefix + letter run (one piece)
		"a\u{301}\u{301}b",   // marks ride the run
		"\u{301}\u{301}",     // mark prefix + mark run
		"!\u{301}x .\u{301}", // prefix vs punct on mark boundary
		" \u{301}x",          // space prefix + mark-led run
		"१٣４56 ½Ⅻ①",         // \p{N} single: Devanagari/Arabic/fullwidth/vulgar/roman
		"'ſ 'S it'\u{17f}",   // long-s contraction fold
		"'Re'VE'lL'd 'r 'v",  // two-letter folds and near-misses
		"。汉字，测试！",     // CJK punct prefix on letter runs
		"x \r\n \n y",        // \s*[\r\n]+ through last newline
		"a\r\nb\rc\nd",
		"  \n\t\n  end",
		"tail  ",
		" x  5 ",
		"€100 $5.99",
		"a/b//\n/",
		"\r",
		"\n \n",
		"  ",
	];

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
	fn qwen_scanner_matches_regex() {
		let reference = Splitter::new(&[QWEN3_PATTERN]);
		let scanner = Splitter::Qwen;
		let corpus: Vec<String> =
			serde_json::from_str(include_str!("../../../fixtures/corpus.json")).unwrap();
		let texts: Vec<String> = corpus
			.into_iter()
			.chain(TRICKY.iter().map(|s| s.to_string()))
			.chain(random_strings(0x9e60_03e6, 400))
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
