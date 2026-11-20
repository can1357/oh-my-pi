//! tiktoken `o200k_base` split pattern as a codepoint scanner.
//!
//! Reference (tiktoken-rs 0.7.0 / openai/tiktoken `openai_public`):
//! ```text
//! [^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+(?i:'s|'t|'re|'ve|'m|'ll|'d)?
//! |[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*(?i:'s|'t|'re|'ve|'m|'ll|'d)?
//! |\p{N}{1,3}
//! | ?[^\s\p{L}\p{N}]+[\r\n/]*
//! |\s*[\r\n]+
//! |\s+(?!\S)
//! |\s+
//! ```

use super::{cls, contraction_end, decode_at, digits_end, punct_end, ws_end};
use crate::utok::utf::Unit;

/// End of the piece starting at `pos` (`pos < units.len()`).
pub fn next_piece<U: Unit>(units: &[U], pos: usize) -> usize {
	if let Some(e) = word(units, pos) {
		return contraction_end(units, e);
	}
	if let Some(e) = digits_end(units, pos) {
		return e;
	}
	if let Some(e) = punct_end(units, pos, true) {
		return e;
	}
	if let Some(e) = ws_end(units, pos) {
		return e;
	}
	// Unreachable for real input (the alternates cover every codepoint);
	// isolate one codepoint so the scan always advances.
	pos + decode_at(units, pos).map_or(1, |(_, n)| n)
}

/// Word alternates 1 and 2, in leftmost-first order, without the
/// contraction suffix (shared by both):
/// alt1 `[^\r\n\p{L}\p{N}]? upper* lower+`, alt2 `…? upper+ lower*`.
/// Each alternate tries its optional one-codepoint prefix first (greedy
/// `?`), falling back to prefix-absent before yielding to the next
/// alternate.
fn word<U: Unit>(units: &[U], pos: usize) -> Option<usize> {
	let (c, n) = decode_at(units, pos)?;
	let prefix =
		(c != '\r' && c != '\n' && !cls::is_letter(c) && !cls::is_number(c)).then_some(pos + n);
	if let Some(p) = prefix
		&& let Some(e) = body1(units, p)
	{
		return Some(e);
	}
	if let Some(e) = body1(units, pos) {
		return Some(e);
	}
	if let Some(p) = prefix
		&& let Some(e) = body2(units, p)
	{
		return Some(e);
	}
	body2(units, pos)
}

/// `upper* lower+` with greedy backtracking. The classes overlap on
/// `Lm`/`Lo`/`M`: when no `lower` codepoint follows the maximal `upper`
/// run, `upper*` gives back to the *last* run codepoint that is also in
/// the lower set, and `lower+` takes exactly that codepoint (everything
/// to its right is `Lu`/`Lt`, outside the lower set).
fn body1<U: Unit>(units: &[U], pos: usize) -> Option<usize> {
	let mut i = pos;
	let mut last_shared_end = None;
	while let Some((c, n)) = decode_at(units, i) {
		if !cls::in_upper_set(c) {
			break;
		}
		if cls::in_lower_set(c) {
			last_shared_end = Some(i + n);
		}
		i += n;
	}
	if let Some((c, n)) = decode_at(units, i)
		&& cls::in_lower_set(c)
	{
		let mut j = i + n;
		while let Some((c, n)) = decode_at(units, j) {
			if !cls::in_lower_set(c) {
				break;
			}
			j += n;
		}
		return Some(j);
	}
	last_shared_end
}

/// `upper+ lower*` — never backtracks (both suffix parts may be empty).
fn body2<U: Unit>(units: &[U], pos: usize) -> Option<usize> {
	let mut i = pos;
	while let Some((c, n)) = decode_at(units, i) {
		if !cls::in_upper_set(c) {
			break;
		}
		i += n;
	}
	if i == pos {
		return None;
	}
	while let Some((c, n)) = decode_at(units, i) {
		if !cls::in_lower_set(c) {
			break;
		}
		i += n;
	}
	Some(i)
}
