//! Left context shared by learning and completion, so both see the same
//! history: the previous one or two prose words, a sentence start, or
//! nothing when code, digits, or markup break the chain.

use crate::prose::is_letter;

/// Sentence/line start pseudo-word (Norvig's `<S>` maps onto it).
pub const BOS: &str = "<s>";

/// How far back (in characters) a gap between two words may reach.
const MAX_GAP: usize = 64;

/// One side of a left context.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Slot {
	/// Unknown: code or symbols broke the chain.
	None,
	/// Sentence or line start.
	Bos,
	/// A prose word, lowercased into the caller's buffer.
	Word,
}

/// Left context of a word: `v` is the word right before it, `u` the one before
/// `v`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Context {
	pub u: Slot,
	pub v: Slot,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Gap {
	Join,
	Stop,
	Break,
}

/// `[\p{L}\p{M}']`, the characters of a word.
#[inline]
fn is_word_code(c: char) -> bool {
	c == '\'' || is_letter(c)
}

/// Characters a prose token may be wrapped in: `( ) " *` and curly quotes.
#[inline]
const fn is_soft_wrap(c: char) -> bool {
	matches!(c, '(' | ')' | '"' | '*' | '\u{201C}' | '\u{201D}' | '\u{2018}' | '\u{2019}')
}

fn classify_gap(gap: &str) -> Gap {
	let mut kind = Gap::Join;
	for c in gap.chars() {
		match c {
			' ' | '\t' | ',' | ';' | '-' | '\u{2013}' | '\u{2014}' => {},
			'\n' | '.' | '!' | '?' | ':' => kind = Gap::Stop,
			c if is_soft_wrap(c) => {},
			_ => return Gap::Break,
		}
	}
	kind
}

/// Start of the gap ending at `end`: walks back over non-word characters,
/// at most [`MAX_GAP`] of them.
fn gap_start(text: &str, end: usize) -> usize {
	let mut at = end;
	for (steps, (i, c)) in text[..end].char_indices().rev().enumerate() {
		if steps >= MAX_GAP || is_word_code(c) {
			break;
		}
		at = i;
	}
	at
}

/// The prose word ending at `end`, lowercased into `out`; returns its start,
/// or `None` when the token looks like code (glued to a symbol, camelCase).
fn word_ending_at(text: &str, end: usize, out: &mut String) -> Option<usize> {
	let mut start = end;
	for (i, c) in text[..end].char_indices().rev() {
		if !is_word_code(c) {
			break;
		}
		start = i;
	}
	if start == end {
		return None;
	}
	if let Some(before) = text[..start].chars().next_back()
		&& !(matches!(before, ' ' | '\t' | '\n' | '-') || is_soft_wrap(before))
	{
		return None;
	}
	let word = &text[start..end];
	let bytes = word.as_bytes();
	if bytes
		.windows(2)
		.any(|pair| pair[0].is_ascii_lowercase() && pair[1].is_ascii_uppercase())
	{
		return None;
	}
	out.clear();
	for c in word.chars() {
		out.extend(c.to_lowercase());
	}
	Some(start)
}

/// Left context of the word starting at byte `end` of `text`. Word slots are
/// lowercased into `u` / `v`.
pub fn context_before(text: &str, end: usize, u: &mut String, v: &mut String) -> Context {
	let g1 = gap_start(text, end);
	if g1 == 0 {
		return Context { u: Slot::None, v: Slot::Bos };
	}
	match classify_gap(&text[g1..end]) {
		Gap::Break => return Context { u: Slot::None, v: Slot::None },
		Gap::Stop => return Context { u: Slot::None, v: Slot::Bos },
		Gap::Join => {},
	}
	let Some(prev) = word_ending_at(text, g1, v) else {
		return Context { u: Slot::None, v: Slot::None };
	};
	let g2 = gap_start(text, prev);
	if g2 == 0 {
		return Context { u: Slot::Bos, v: Slot::Word };
	}
	match classify_gap(&text[g2..prev]) {
		Gap::Break => Context { u: Slot::None, v: Slot::Word },
		Gap::Stop => Context { u: Slot::Bos, v: Slot::Word },
		Gap::Join => {
			let u_slot = if word_ending_at(text, g2, u).is_some() {
				Slot::Word
			} else {
				Slot::None
			};
			Context { u: u_slot, v: Slot::Word }
		},
	}
}

/// Lowercase `text` into `out`.
pub fn lowercase_into(text: &str, out: &mut String) {
	out.clear();
	for c in text.chars() {
		out.extend(c.to_lowercase());
	}
}

/// Case "tail" of a surface form: the word with its first letter lowercased.
/// Sentence-initial capitals are positional, so only the tail identifies a
/// word's own casing (`API`, `PRs`, `OAuth`).
pub fn case_tail_into(surface: &str, out: &mut String) {
	out.clear();
	let mut chars = surface.chars();
	if let Some(first) = chars.next() {
		out.extend(first.to_lowercase());
		out.push_str(chars.as_str());
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn context(text: &str) -> (Option<String>, Option<String>) {
		let (mut u, mut v) = (String::new(), String::new());
		let ctx = context_before(text, text.len(), &mut u, &mut v);
		let show = |slot: Slot, word: String| match slot {
			Slot::None => None,
			Slot::Bos => Some(BOS.to_owned()),
			Slot::Word => Some(word),
		};
		(show(ctx.u, u), show(ctx.v, v))
	}

	#[test]
	fn context_follows_prose_and_stops_at_code_or_sentences() {
		assert_eq!(context("Can you fix the "), (Some("fix".into()), Some("the".into())));
		assert_eq!(context("done. "), (None, Some(BOS.into())));
		assert_eq!(context("done. Then "), (Some(BOS.into()), Some("then".into())));
		assert_eq!(context("Hello, world "), (Some("hello".into()), Some("world".into())));
		assert_eq!(context("run foo_bar "), (None, None));
		assert_eq!(context("the parseArgs "), (None, None));
		assert_eq!(context("Fix "), (Some(BOS.into()), Some("fix".into())));
	}
}
