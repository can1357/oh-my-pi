//! The TSP `edit` event resolved for an editor: offsets in UTF-16 code
//! units of the text the terminal saw, checked against the current text and
//! mapped to UTF-8 bytes. The `send` event's prompt is sanitized here too.

use xutf::{Utf8, Utf16Le, transcoded_len};

use crate::{editcore::NativeEdit, input::sanitize_paste};

/// Resolves an `edit` event against `current`, the text the field last
/// described.
///
/// The terminal replaced `[from, to)` with `text` and put its caret at
/// `cursor`, in UTF-16 code units of a text `len` units long. When `len` is
/// not `current`'s length, keys in flight changed the text: the edit is
/// stale and `None`. Offsets are clamped and reversed ends swapped; a range
/// end inside a surrogate pair takes the whole character. `text` is
/// sanitized like a paste, and the caret is carried from the terminal's
/// result onto the text the sanitized replacement produces.
#[must_use]
pub fn resolve(
	current: &str,
	from: u32,
	to: u32,
	text: &str,
	cursor: u32,
	len: u32,
) -> Option<NativeEdit> {
	let size = utf16_len(current);
	if len as usize != size {
		return None;
	}
	let (from, to) = ((from.min(to) as usize).min(size), (from.max(to) as usize).min(size));
	let start = byte_at(current, from, false);
	// An empty range stays empty: a caret inside a pair is a move, not a deletion.
	let end = if from == to {
		start
	} else {
		byte_at(current, to, true)
	};
	let insert = sanitize_paste(text);
	let (start16, end16, raw16) =
		(utf16_len(&current[..start]), utf16_len(&current[..end]), utf16_len(text));
	let expected = (cursor as usize).min(size - (end16 - start16) + raw16);
	let cursor = if expected <= start16 {
		byte_at(current, expected, false)
	} else if expected < start16 + raw16 {
		let raw = byte_at(text, expected - start16, false);
		start + insert.floor_char_boundary(raw.min(insert.len()))
	} else {
		start + insert.len() + byte_at(&current[end..], expected - start16 - raw16, false)
	};
	Some(NativeEdit { range: start..end, insert, cursor })
}

/// The prompt a `send` event submits: its `text` sanitized like a paste, or
/// `None` when that is blank, which the protocol defines as a no-op.
#[must_use]
pub fn send_text(text: &str) -> Option<String> {
	let prompt = sanitize_paste(text);
	(!prompt.trim().is_empty()).then_some(prompt)
}

fn utf16_len(text: &str) -> usize {
	transcoded_len::<Utf8, Utf16Le>(text.as_bytes())
}

/// Inside a surrogate pair, rounds down to the character, or up with `ceil`.
fn byte_at(text: &str, units: usize, ceil: bool) -> usize {
	let mut seen = 0;
	for (at, character) in text.char_indices() {
		if seen >= units {
			return at;
		}
		seen += character.len_utf16();
		if seen > units {
			return if ceil { at + character.len_utf8() } else { at };
		}
	}
	text.len()
}

#[cfg(test)]
mod tests {
	use super::{resolve, send_text};
	use crate::editcore::NativeEdit;

	fn edit(range: std::ops::Range<usize>, insert: &str, cursor: usize) -> NativeEdit {
		NativeEdit { range, insert: insert.to_owned(), cursor }
	}

	#[test]
	fn a_selection_replacement_maps_to_bytes_and_the_caret_follows_it() {
		assert_eq!(resolve("hello world", 6, 11, "there", 11, 11), Some(edit(6..11, "there", 11)));
		assert_eq!(resolve("one\ntwo\nthree", 2, 9, "X\nY", 5, 13), Some(edit(2..9, "X\nY", 5)));
	}

	#[test]
	fn a_length_the_text_no_longer_has_makes_the_edit_stale() {
		assert_eq!(resolve("abcd", 0, 3, "", 0, 3), None);
	}

	#[test]
	fn offsets_count_utf16_units_and_never_split_a_surrogate_pair() {
		let text = "a\u{1f600}b\u{1f600}c";
		assert_eq!(resolve(text, 1, 3, "", 1, 7), Some(edit(1..5, "", 1)), "the first emoji exactly");
		let next = "ab\u{1f600}c";
		assert_eq!(
			resolve(next, 2, 3, "", 2, 5),
			Some(edit(2..6, "", 2)),
			"an end inside a pair takes it"
		);
		assert_eq!(
			resolve("x\u{1f600}", 2, 2, "", 2, 3),
			Some(edit(1..1, "", 1)),
			"a caret inside a pair moves to its start and deletes nothing"
		);
		assert_eq!(
			resolve("a\u{e9}b", 1, 2, "\u{1f642}", 3, 3),
			Some(edit(1..3, "\u{1f642}", 5)),
			"a two-byte character replaced by a four-byte one"
		);
	}

	#[test]
	fn offsets_are_clamped_and_reversed_ends_swapped() {
		assert_eq!(resolve("ab\ncd", 4, 4, "", 4, 5), Some(edit(4..4, "", 4)));
		assert_eq!(resolve("ab\ncd", 99, 99, "", 99, 5), Some(edit(5..5, "", 5)));
		assert_eq!(resolve("abc", 3, 1, "", 1, 3), Some(edit(1..3, "", 1)));
	}

	#[test]
	fn the_replacement_is_sanitized_and_the_caret_lands_after_it() {
		assert_eq!(resolve("ab", 1, 1, "x\r\ny\t", 6, 2), Some(edit(1..1, "x\ny   ", 7)));
	}

	#[test]
	fn a_send_is_sanitized_like_a_paste_and_blank_text_is_a_no_op() {
		assert_eq!(send_text("a\r\nb\t\u{7}c").as_deref(), Some("a\nb   c"));
		assert_eq!(send_text("  \r\n\t \u{7}"), None, "whitespace and control bytes alone are blank");
		assert_eq!(send_text(""), None);
		assert_eq!(
			send_text("  cafe\u{301} ").as_deref(),
			Some("  caf\u{e9} "),
			"the prompt is normalized and keeps its own spacing: only blankness is judged trimmed"
		);
	}
}
