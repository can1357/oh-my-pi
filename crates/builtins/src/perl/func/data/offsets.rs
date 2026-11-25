//! Character/byte offset conversion for large UTF-8 scalars.
//!
//! perl caches a UTF-8 string's length and its last offset conversion on the
//! scalar, so loops like `substr($x, $i, 1) for 0 .. length $x` stay linear.
//! This keeps a few such marks per interpreter: the scalar each describes (by
//! address and storage revision), whether the bytes are well-formed UTF-8,
//! the character count, and the last character/byte pair visited. Callers
//! borrow the scalar's storage instead of copying the string.

use std::rc::{Rc, Weak};

use crate::perl::{
	interp::Interp,
	value::{ScalarBody, Sv, Value},
};

/// Scalars whose offsets are remembered at once (most recently used first).
const MARKS: usize = 4;

/// Offsets remembered for one unchanged scalar.
pub(super) struct Utf8Mark {
	cell: Weak<ScalarBody>,
	revision: u64,
	/// Whether the bytes are well-formed UTF-8; other text keeps the general decoder.
	valid: bool,
	/// Character count of the whole string.
	len: usize,
	/// Last visited character boundary.
	byte: usize,
	chars: usize,
}

/// A well-formed UTF-8 string borrowed from a plain scalar, with resumable offset conversion.
pub(super) struct Utf8View<'a> {
	pub bytes: &'a [u8],
	mark: &'a mut Utf8Mark,
}

impl Utf8View<'_> {
	/// Number of characters.
	pub fn len(&self) -> usize { self.mark.len }

	/// Byte offset of character `index` (clamped to the end).
	pub fn byte_of(&mut self, index: usize) -> usize {
		let index = index.min(self.mark.len);
		let (byte, _) = self.walk(index, true);
		byte
	}

	/// Character index of byte offset `byte`, which must be a character boundary.
	pub fn char_of(&mut self, byte: usize) -> usize {
		let (_, chars) = self.walk(byte.min(self.bytes.len()), false);
		chars
	}

	/// Step from the nearest known boundary (start, mark or end) to `target`,
	/// a character index when `by_chars`, else a byte offset; returns (byte, chars).
	fn walk(&mut self, target: usize, by_chars: bool) -> (usize, usize) {
		let key = |byte: usize, chars: usize| if by_chars { chars } else { byte };
		let known = [(0, 0), (self.mark.byte, self.mark.chars), (self.bytes.len(), self.mark.len)];
		let (mut byte, mut chars) = known.into_iter().min_by_key(|&(b, c)| key(b, c).abs_diff(target)).unwrap_or((0, 0));
		while key(byte, chars) < target {
			byte += 1;
			while self.bytes.get(byte).is_some_and(|&b| b & 0xC0 == 0x80) { byte += 1; }
			chars += 1;
		}
		while key(byte, chars) > target {
			byte -= 1;
			while byte > 0 && self.bytes[byte] & 0xC0 == 0x80 { byte -= 1; }
			chars -= 1;
		}
		self.mark.byte = byte;
		self.mark.chars = chars;
		(byte, chars)
	}
}

/// Keep a scalar's mark current across an in-place splice that replaced `removed`
/// characters at character `start` (byte `at`) with the bytes `inserted`.
pub(super) fn spliced(interp: &mut Interp<'_>, sv: &Sv, at: usize, start: usize, removed: usize, inserted: &[u8]) {
	let marks = &mut interp.data.utf8_marks;
	let Some(i) = marks.iter().position(|m| m.cell.as_ptr() == Rc::as_ptr(sv)) else { return };
	match std::str::from_utf8(inserted) {
		Ok(text) if marks[i].valid => {
			let mark = &mut marks[i];
			mark.len = mark.len.saturating_sub(removed) + text.chars().count();
			mark.revision = sv.revision();
			mark.byte = at;
			mark.chars = start;
		}
		_ => { marks.remove(i); }
	}
}

/// Whether a scalar holds a UTF-8 flagged string without magic (so reading it has no side effects).
pub(super) fn plain_utf8(interp: &Interp<'_>, sv: &Sv) -> bool {
	!interp.is_magical_sv(sv) && sv.try_value().is_ok_and(|v| matches!(&*v, Value::Str(s) if s.utf8))
}

/// Run `f` over the borrowed string of a plain, well-formed UTF-8 scalar.
/// `None` (without running `f`) for anything else — magic, non-strings, byte
/// strings, malformed or perl-extended text — which keeps the general path.
pub(super) fn with_utf8<T>(interp: &mut Interp<'_>, sv: &Sv, f: impl FnOnce(&mut Utf8View<'_>) -> T) -> Option<T> {
	if interp.is_magical_sv(sv) { return None; }
	let value = sv.try_value().ok()?;
	let Value::Str(s) = &*value else { return None };
	if !s.utf8 { return None; }
	let revision = sv.revision();
	let marks = &mut interp.data.utf8_marks;
	match marks.iter().position(|m| m.cell.as_ptr() == Rc::as_ptr(sv)) {
		Some(i) if marks[i].revision == revision => marks[..=i].rotate_right(1),
		found => {
			if let Some(i) = found { marks.remove(i); }
			let len = std::str::from_utf8(&s.bytes).ok().map(|text| text.chars().count());
			marks.insert(0, Utf8Mark { cell: Rc::downgrade(sv), revision, valid: len.is_some(), len: len.unwrap_or(0), byte: 0, chars: 0 });
			marks.truncate(MARKS);
		}
	}
	let mark = marks.first_mut().filter(|m| m.valid)?;
	Some(f(&mut Utf8View { bytes: &s.bytes, mark }))
}
