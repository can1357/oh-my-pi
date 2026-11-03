//! Character stepping over zsh strings: zsh 5.9 `pattern.c`'s multibyte
//! helpers (`metacharinc`, `charref`, `charnext`, `charrefinc`, `charsub`)
//! and `utils.c`'s `mb_charlenconv`, with UTF-8 standing in for the
//! locale's `mbrtowc`.
//!
//! Subject strings are unmetafied bytes; a byte that does not start a
//! valid UTF-8 character is one character of its own, `0xDC00 + byte`
//! (zsh `WCHAR_INVALID`). Without multibyte every byte is a character.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use crate::bash::syntax::zsh::tok::{META, head, is_tok, span, tok_char};

/// How a multibyte character decoded (zsh `ZMB_VALID` and friends).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Zmb {
	/// A whole, valid character.
	Valid,
	/// The string ended inside a character.
	Incomplete,
	/// The bytes are no character.
	Invalid,
}

/// The character zsh uses for a byte that is no valid character (zsh
/// `WCHAR_INVALID`).
#[inline]
pub(super) const fn invalid(b: u8) -> u32 {
	0xdc00 + b as u32
}

/// The first UTF-8 character of `s`: its code point and length, or why
/// there is none (`mbrtowc`).
#[inline]
fn decode(s: &[u8]) -> Result<(u32, usize), Zmb> {
	let take = head(s, 4);
	let valid = match core::str::from_utf8(take) {
		Ok(v) => v,
		Err(e) if e.valid_up_to() > 0 => {
			core::str::from_utf8(head(take, e.valid_up_to())).unwrap_or_default()
		},
		Err(e) if e.error_len().is_none() => return Err(Zmb::Incomplete),
		Err(_) => return Err(Zmb::Invalid),
	};
	valid
		.chars()
		.next()
		.map_or(Err(Zmb::Incomplete), |c| Ok((c as u32, c.len_utf8())))
}

/// zsh `charref`: the character at `pos` of `text[..end]` and how it
/// decoded.
#[inline]
pub(super) fn charref(text: &[u8], pos: usize, end: usize, mb: bool) -> (u32, Zmb) {
	let Some(&byte) = text.get(pos).filter(|_| pos < end) else {
		return (0, Zmb::Valid);
	};
	if !mb || byte & 0x80 == 0 {
		return (byte as u32, Zmb::Valid);
	}
	decode(span(text, pos, end)).map_or_else(|zmb| (invalid(byte), zmb), |(ch, _)| (ch, Zmb::Valid))
}

/// zsh `charnext`: the index after the character at `x` of `s[..y]`.
#[inline]
pub(super) fn charnext(s: &[u8], x: usize, y: usize, mb: bool) -> usize {
	match s.get(x) {
		Some(&b) if mb && b & 0x80 != 0 && x < y => {
			decode(span(s, x, y)).map_or(x + 1, |(_, n)| x + n)
		},
		_ => x + 1,
	}
}

/// zsh `charrefinc`: the character at `*pos` of `text[..end]`, stepping
/// past it; the flag is set for a byte that is no character.
#[inline]
pub(super) fn charrefinc(text: &[u8], pos: &mut usize, end: usize, mb: bool) -> (u32, bool) {
	let byte = text.get(*pos).copied().unwrap_or(0);
	if !mb || byte & 0x80 == 0 || *pos >= end {
		*pos += 1;
		return (byte as u32, false);
	}
	if let Ok((ch, len)) = decode(span(text, *pos, end)) {
		*pos += len;
		(ch, false)
	} else {
		*pos += 1;
		(invalid(byte), true)
	}
}

/// The start of the character that ends at `pos` (a character boundary of
/// `s[start..end]` reached by [`charnext`] from `start`).
///
/// zsh records every character start in an array while it scans forwards
/// (`charstart` in `patmatch` and `patrepeat`); a valid UTF-8 lead byte is
/// always such a start, so looking back at most four bytes finds the same
/// boundary without the array.
#[inline]
pub(super) fn charprev(s: &[u8], start: usize, pos: usize, end: usize, mb: bool) -> usize {
	if mb {
		let lo = pos.saturating_sub(4).max(start);
		for q in (lo..pos).rev() {
			let Some(&b) = s.get(q) else {
				break;
			};
			if b & 0xc0 == 0x80 {
				continue;
			}
			if b & 0x80 != 0 && decode(span(s, q, end)).is_ok_and(|(_, n)| q + n == pos) {
				return q;
			}
			break;
		}
	}
	pos - 1
}

/// zsh `charsub`: the number of characters in `s[x..y]` under the
/// `MULTIBYTE` option; after a byte that is no character every remaining
/// byte counts as one.
pub(super) fn charsub(s: &[u8], mut x: usize, y: usize, multibyte: bool) -> usize {
	if !multibyte {
		return y - x;
	}
	let mut res = 0;
	while x < y {
		match decode(span(s, x, y)) {
			Ok((_, n)) => x += n,
			Err(_) => return res + (y - x),
		}
		res += 1;
	}
	res
}

/// zsh `mb_charlenconv`: the byte length of the character at `x` of
/// `s[..y]` under the `MULTIBYTE` option (1 for a byte that is no
/// character and at the end).
#[inline]
pub(super) fn charlen(s: &[u8], x: usize, y: usize, multibyte: bool) -> usize {
	match s.get(x) {
		Some(&b) if multibyte && b > 0x7f && x < y => decode(span(s, x, y)).map_or(1, |(_, n)| n),
		_ => 1,
	}
}

/// zsh `MB_METASTRLEN`: the number of characters in the metafied string
/// `m`.
pub(super) fn metastrlen(m: &[u8], multibyte: bool) -> usize {
	let raw = crate::bash::syntax::zsh::tok::unmetafy(m);
	let mut n = 0;
	let mut x = 0;
	while x < raw.len() {
		x += charlen(&raw, x, raw.len(), multibyte);
		n += 1;
	}
	n
}

/// zsh `metacharinc`: the character at `*pos` of a metafied, tokenized
/// pattern, stepping past it.
///
/// Tokens stand for their characters; with `mb` a multibyte character is
/// assembled from its (possibly metafied) bytes, and a byte that starts no
/// character steps one byte.
pub(super) fn metacharinc(pat: &[u8], pos: &mut usize, mb: bool) -> u32 {
	let at = |idx: usize| pat.get(idx).copied().unwrap_or(0);
	let unit = |idx: usize| -> (u8, usize) {
		let byte = at(idx);
		if is_tok(byte) {
			(tok_char(byte).unwrap_or(0), 1)
		} else if byte == META {
			(at(idx + 1) ^ 32, 2)
		} else {
			(byte, 1)
		}
	};
	let first = at(*pos);
	if !mb || first & 0x80 == 0 {
		let (ch, len) = unit(*pos);
		*pos += len;
		return ch as u32;
	}
	let mut buf = [0u8; 4];
	let mut len = 0;
	let mut idx = *pos;
	while at(idx) != 0 && len < buf.len() {
		let (byte, step) = unit(idx);
		idx += step;
		buf[len] = byte;
		len += 1;
		match decode(head(&buf, len)) {
			Ok((ch, _)) => {
				*pos = idx;
				return ch;
			},
			Err(Zmb::Incomplete) => {},
			Err(_) => break,
		}
	}
	*pos += 1;
	invalid(first)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn charprev_matches_forward_boundaries() {
		// "é", a stray continuation byte, an invalid lead, "€", "a".
		let s = b"\xc3\xa9\xa9\xc3a\xe2\x82\xaca";
		let mut bounds = alloc_bounds(s);
		bounds.reverse();
		for w in bounds.windows(2) {
			assert_eq!(charprev(s, 0, w[0], s.len(), true), w[1], "before {}", w[0]);
		}
	}

	fn alloc_bounds(s: &[u8]) -> Vec<usize> {
		let mut v = vec![0];
		let mut x = 0;
		while x < s.len() {
			x = charnext(s, x, s.len(), true);
			v.push(x);
		}
		v
	}

	#[test]
	fn charsub_counts_remaining_bytes_after_invalid() {
		assert_eq!(charsub("aé€".as_bytes(), 0, 6, true), 3);
		assert_eq!(charsub(b"a\xffbc", 0, 4, true), 4);
		assert_eq!(charsub("é".as_bytes(), 0, 2, false), 2);
	}

	#[test]
	fn metacharinc_decodes_metafied_multibyte() {
		// "é" is c3 a9; 0xa9 is not a meta byte, "ƃ" is c6 83 and 0x83 is.
		let p = [0xc6, META, 0x83 ^ 32, b'x'];
		let mut i = 0;
		assert_eq!(metacharinc(&p, &mut i, true), 'ƃ' as u32);
		assert_eq!(i, 3);
		let mut j = 0;
		assert_eq!(metacharinc(&p, &mut j, false), 0xc6);
		assert_eq!(j, 1);
	}
}
