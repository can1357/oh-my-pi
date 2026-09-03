//! tiktoken `cl100k_base` split pattern as a codepoint scanner.
//!
//! Reference (tiktoken-rs 0.7.0 / openai/tiktoken `openai_public`):
//! ```text
//! (?i:'s|'t|'re|'ve|'m|'ll|'d)
//! |[^\r\n\p{L}\p{N}]?\p{L}+
//! |\p{N}{1,3}
//! | ?[^\s\p{L}\p{N}]+[\r\n]*
//! |\s*[\r\n]+
//! |\s+(?!\S)
//! |\s+
//! ```
//! Unlike o200k, the contraction is a standalone *leading* alternate
//! (words split as `that` + `'s`) and letter runs are plain `\p{L}+`
//! (marks excluded, no case split).

use super::{cls, contraction_end, decode_at, digits_end, punct_end, ws_end};
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
	if let Some(e) = digits_end(units, pos) {
		return e;
	}
	if let Some(e) = punct_end(units, pos, false) {
		return e;
	}
	if let Some(e) = ws_end(units, pos) {
		return e;
	}
	// Unreachable for real input; isolate one codepoint so the scan
	// always advances.
	pos + decode_at(units, pos).map_or(1, |(_, n)| n)
}

/// `[^\r\n\p{L}\p{N}]?\p{L}+`. No real backtracking: if the prefix
/// codepoint is present it is not a letter, so a failed `\p{L}+` after it
/// cannot succeed from the prefix position either.
fn word<U: Unit>(units: &[U], pos: usize) -> Option<usize> {
	let (c, n) = decode_at(units, pos)?;
	let start = if c != '\r' && c != '\n' && !cls::is_letter(c) && !cls::is_number(c) {
		pos + n
	} else {
		pos
	};
	let mut i = start;
	while let Some((c, n)) = decode_at(units, i) {
		if !cls::is_letter(c) {
			break;
		}
		i += n;
	}
	(i > start).then_some(i)
}
