//! Matching units: bytes in the C locale, characters in a UTF-8 locale.
//!
//! Patterns and subjects are cut into units the same way, so a match never
//! starts or ends inside a character. A byte that does not begin a valid
//! UTF-8 sequence is a unit of its own, offset by [`INVALID`] so it never
//! equals a code point.

use crate::bash::pattern::class::Class;

/// Added to a stray byte in UTF-8 mode so it never equals a code point.
pub const INVALID: u32 = 0x11_0000;

/// How text is cut into units and compared.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mode {
	/// Units are UTF-8 characters rather than bytes.
	pub utf8:  bool,
	/// `REG_ICASE`: units compare after [`Mode::fold`].
	pub icase: bool,
}

impl Mode {
	/// The unit starting at `bytes[i]` (`i < bytes.len()`) and its length in
	/// bytes.
	pub fn decode(self, bytes: &[u8], i: usize) -> (u32, usize) {
		let b = bytes[i];
		if !self.utf8 || b < 0x80 {
			return (u32::from(b), 1);
		}
		let len = match b {
			0xc2..=0xdf => 2,
			0xe0..=0xef => 3,
			0xf0..=0xf4 => 4,
			_ => 0,
		};
		if len > 0
			&& let Some(chunk) = bytes.get(i..i + len)
			&& let Ok(s) = core::str::from_utf8(chunk)
			&& let Some(c) = s.chars().next()
		{
			return (u32::from(c), len);
		}
		(INVALID | u32::from(b), 1)
	}

	/// The unit that ends at byte `end`, if any (word context before a
	/// position).
	pub fn decode_before(self, bytes: &[u8], end: usize) -> Option<u32> {
		if end == 0 {
			return None;
		}
		if self.utf8 {
			for len in 2..=end.min(4) {
				let (u, l) = self.decode(bytes, end - len);
				if l == len && u < INVALID {
					return Some(u);
				}
			}
		}
		Some(self.decode(bytes, end - 1).0)
	}

	/// Case-fold a unit the way glibc does under `REG_ICASE`: both pattern
	/// and subject are upper-cased. Identity without `icase`, and for
	/// characters whose upper case is not a single character.
	pub fn fold(self, u: u32) -> u32 {
		if !self.icase {
			return u;
		}
		if u < 0x80 {
			return u32::from((u as u8).to_ascii_uppercase());
		}
		if !self.utf8 {
			return u;
		}
		char::from_u32(u).map_or(u, |c| {
			let mut upper = c.to_uppercase();
			match (upper.next(), upper.next()) {
				(Some(one), None) => u32::from(one),
				_ => u,
			}
		})
	}

	/// Whether `u` is a word character (`\w`, `\b`, `\<`, `\>`): alphanumeric
	/// or `_`.
	pub fn is_word(self, u: u32) -> bool {
		if u < 0x80 {
			let b = u as u8;
			return b.is_ascii_alphanumeric() || b == b'_';
		}
		self.utf8 && char::from_u32(u).is_some_and(char::is_alphanumeric)
	}

	/// Whether unit `u` belongs to `class`.
	pub fn in_class(self, class: Class, u: u32) -> bool {
		if u < 0x80 {
			return class.matches(u as u8);
		}
		self.utf8 && char::from_u32(u).is_some_and(|c| class.matches_char(c))
	}
}
