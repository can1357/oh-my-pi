//! Encoding-generic text input: UTF-8 / UTF-16 / UTF-32, xutf-style.
//!
//! No transcoding, no scratch buffers. The pipeline runs natively in the
//! input's own code units: the pre-tokenizer scans a codepoint cursor over
//! `&[U]`, and the BPE stage looks ranks up in a lazily-expanded per-flavor
//! table view (see `bpe.rs`). A JS UTF-16 string is tokenized directly.
//!
//! Decoding is permissive (xutf semantics): malformed sequences and lone
//! surrogates decode as U+FFFD and consume minimally. Valid text behaves
//! identically across flavors, so counts/ids are flavor-invariant.

use std::hash::Hash;

/// One code unit: `u8` (UTF-8), `u16` (UTF-16 native-endian), `u32` (UTF-32).
pub trait Unit: Copy + Eq + Ord + Hash + 'static {
	/// Decode the codepoint starting at `units[i]`.
	/// Returns `(codepoint, units_consumed)`; permissive on malformed input.
	fn decode(units: &[Self], i: usize) -> (char, usize);

	/// Encode `cp` into `out`, returning the unit count written.
	/// `out` must have room for 4 units.
	fn encode(cp: char, out: &mut [Self]) -> usize;

	/// Identity byte view when this flavor already is UTF-8 (`u8` only).
	/// Lets the engine skip per-piece re-encoding for `str` input.
	fn as_utf8(units: &[Self]) -> Option<&[u8]>;

	/// The unit as an ASCII byte when it encodes one (`< 0x80`).
	fn ascii(self) -> Option<u8>;
}

impl Unit for u8 {
	#[inline]
	fn decode(units: &[Self], i: usize) -> (char, usize) {
		let b = units[i];
		if b < 0x80 {
			return (b as char, 1);
		}
		// Permissive multi-byte decode: on malformed input yield U+FFFD and
		// consume one unit.
		let need = match b {
			0xc0..=0xdf => 2,
			0xe0..=0xef => 3,
			0xf0..=0xf7 => 4,
			_ => return (char::REPLACEMENT_CHARACTER, 1),
		};
		if i + need > units.len() {
			return (char::REPLACEMENT_CHARACTER, 1);
		}
		let mut cp = (b as u32) & (0x7f >> need);
		for k in 1..need {
			let c = units[i + k];
			if c & 0xc0 != 0x80 {
				return (char::REPLACEMENT_CHARACTER, 1);
			}
			cp = cp << 6 | (c & 0x3f) as u32;
		}
		match char::from_u32(cp) {
			Some(c) => (c, need),
			None => (char::REPLACEMENT_CHARACTER, need),
		}
	}

	#[inline]
	fn encode(cp: char, out: &mut [Self]) -> usize {
		cp.encode_utf8(out).len()
	}

	#[inline]
	fn as_utf8(units: &[Self]) -> Option<&[u8]> {
		Some(units)
	}

	#[inline]
	fn ascii(self) -> Option<u8> {
		(self < 0x80).then_some(self)
	}
}

impl Unit for u16 {
	#[inline]
	fn decode(units: &[Self], i: usize) -> (char, usize) {
		let u = units[i];
		if !(0xd800..=0xdfff).contains(&u) {
			// SAFETY-free: non-surrogate u16 is always a valid scalar.
			return (char::from_u32(u as u32).unwrap_or(char::REPLACEMENT_CHARACTER), 1);
		}
		if u < 0xdc00
			&& let Some(&lo) = units.get(i + 1)
			&& (0xdc00..=0xdfff).contains(&lo)
		{
			let cp = 0x10000 + (((u as u32 - 0xd800) << 10) | (lo as u32 - 0xdc00));
			return (char::from_u32(cp).unwrap_or(char::REPLACEMENT_CHARACTER), 2);
		}
		(char::REPLACEMENT_CHARACTER, 1) // lone surrogate
	}

	#[inline]
	fn encode(cp: char, out: &mut [Self]) -> usize {
		cp.encode_utf16(out).len()
	}

	#[inline]
	fn as_utf8(_units: &[Self]) -> Option<&[u8]> {
		None
	}

	#[inline]
	fn ascii(self) -> Option<u8> {
		(self < 0x80).then_some(self as u8)
	}
}

impl Unit for u32 {
	#[inline]
	fn decode(units: &[Self], i: usize) -> (char, usize) {
		(char::from_u32(units[i]).unwrap_or(char::REPLACEMENT_CHARACTER), 1)
	}

	#[inline]
	fn encode(cp: char, out: &mut [Self]) -> usize {
		out[0] = cp as Self;
		1
	}

	#[inline]
	fn as_utf8(_units: &[Self]) -> Option<&[u8]> {
		None
	}

	#[inline]
	fn ascii(self) -> Option<u8> {
		(self < 0x80).then_some(self as u8)
	}
}

/// Borrowable text in any flavor. Public entry type for
/// [`Encoding::count`](crate::utok::Encoding::count) / `encode`.
pub trait Utf {
	type Unit: Unit;
	fn units(&self) -> &[Self::Unit];
}

impl Utf for str {
	type Unit = u8;

	#[inline]
	fn units(&self) -> &[u8] {
		self.as_bytes()
	}
}

impl Utf for String {
	type Unit = u8;

	#[inline]
	fn units(&self) -> &[u8] {
		self.as_bytes()
	}
}

impl Utf for [u16] {
	type Unit = u16;

	#[inline]
	fn units(&self) -> &[u16] {
		self
	}
}

impl Utf for Vec<u16> {
	type Unit = u16;

	#[inline]
	fn units(&self) -> &[u16] {
		self
	}
}

impl Utf for [u32] {
	type Unit = u32;

	#[inline]
	fn units(&self) -> &[u32] {
		self
	}
}

impl Utf for Vec<u32> {
	type Unit = u32;

	#[inline]
	fn units(&self) -> &[u32] {
		self
	}
}

/// Codepoint cursor over units — the pre-tokenizer's scan primitive.
pub struct Cursor<'a, U: Unit> {
	pub units: &'a [U],
	pub pos:   usize,
}

impl<'a, U: Unit> Cursor<'a, U> {
	#[inline]
	pub const fn new(units: &'a [U]) -> Self {
		Self { units, pos: 0 }
	}

	/// Codepoint at the cursor without advancing.
	#[inline]
	pub fn peek(&self) -> Option<(char, usize)> {
		(self.pos < self.units.len()).then(|| U::decode(self.units, self.pos))
	}

	/// Codepoint after `(cp, len)` from `peek` (one-codepoint lookahead).
	#[inline]
	pub fn peek2(&self, first_len: usize) -> Option<(char, usize)> {
		let j = self.pos + first_len;
		(j < self.units.len()).then(|| U::decode(self.units, j))
	}

	#[inline]
	pub const fn advance(&mut self, n: usize) {
		self.pos += n;
	}
}
