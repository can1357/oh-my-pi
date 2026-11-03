//! Character sets of zsh patterns: zsh 5.9 `pattern.c`'s `range_type`,
//! `patmatchrange` and `mb_patmatchrange`, with the `utils.c` character
//! types (`typtab`, `wcsitype`) behind `[[:IDENT:]]`, `[[:IFS:]]`,
//! `[[:IFSSPACE:]]` and `[[:WORD:]]`.
//!
//! zsh keeps a set as a metafied string with `Meta + PP_*` codes and
//! decodes it at every test; the compiler here decodes it once into
//! [`SetItem`]s, with the same multibyte setting zsh's match-time decoder
//! would use at that point of the pattern.
//!
//! Without multibyte, characters are bytes classified as in the C locale
//! (zsh's `isalpha` and friends); with it, code points classified by
//! Unicode properties standing in for the locale's `iswalpha` family.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use super::{CharEnv, mbchar::Zmb};

/// `[:alpha:]` (zsh `PP_ALPHA`).
pub(super) const PP_ALPHA: u8 = 1;
/// `[:alnum:]` (zsh `PP_ALNUM`).
pub(super) const PP_ALNUM: u8 = 2;
/// `[:ascii:]` (zsh `PP_ASCII`).
pub(super) const PP_ASCII: u8 = 3;
/// `[:blank:]` (zsh `PP_BLANK`).
pub(super) const PP_BLANK: u8 = 4;
/// `[:cntrl:]` (zsh `PP_CNTRL`).
pub(super) const PP_CNTRL: u8 = 5;
/// `[:digit:]` (zsh `PP_DIGIT`).
pub(super) const PP_DIGIT: u8 = 6;
/// `[:graph:]` (zsh `PP_GRAPH`).
pub(super) const PP_GRAPH: u8 = 7;
/// `[:lower:]` (zsh `PP_LOWER`).
pub(super) const PP_LOWER: u8 = 8;
/// `[:print:]` (zsh `PP_PRINT`).
pub(super) const PP_PRINT: u8 = 9;
/// `[:punct:]` (zsh `PP_PUNCT`).
pub(super) const PP_PUNCT: u8 = 10;
/// `[:space:]` (zsh `PP_SPACE`).
pub(super) const PP_SPACE: u8 = 11;
/// `[:upper:]` (zsh `PP_UPPER`).
pub(super) const PP_UPPER: u8 = 12;
/// `[:xdigit:]` (zsh `PP_XDIGIT`).
pub(super) const PP_XDIGIT: u8 = 13;
/// `[:IDENT:]` (zsh `PP_IDENT`).
pub(super) const PP_IDENT: u8 = 14;
/// `[:IFS:]` (zsh `PP_IFS`).
pub(super) const PP_IFS: u8 = 15;
/// `[:IFSSPACE:]` (zsh `PP_IFSSPACE`).
pub(super) const PP_IFSSPACE: u8 = 16;
/// `[:WORD:]` (zsh `PP_WORD`).
pub(super) const PP_WORD: u8 = 17;
/// `[:INCOMPLETE:]` (zsh `PP_INCOMPLETE`).
pub(super) const PP_INCOMPLETE: u8 = 18;
/// `[:INVALID:]` (zsh `PP_INVALID`).
pub(super) const PP_INVALID: u8 = 19;
/// An unknown `[:name:]` (zsh `PP_UNKWN`); never stored.
pub(super) const PP_UNKWN: u8 = 20;

/// The names of `[:name:]`, space separated, in `PP_*` order from 1 (zsh
/// `colon_stuffs`; one string, not a table of slices: no dynamic
/// relocations at process start).
const COLON_STUFFS: &[u8] = b"alpha alnum ascii blank cntrl digit graph lower print punct space \
	upper xdigit IDENT IFS IFSSPACE WORD INCOMPLETE INVALID";

/// One element of a `[...]` set.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SetItem {
	/// A character (a byte without multibyte).
	Char(u32),
	/// A `[:name:]` class, one of the `PP_*` codes.
	Class(u8),
	/// `a-z` (zsh `PP_RANGE`), bounds inclusive.
	Range(u32, u32),
}

/// zsh `range_type`: the `PP_*` code of the class name `name`, or
/// [`PP_UNKWN`].
pub(super) fn range_type(name: &[u8]) -> u8 {
	COLON_STUFFS
		.split(|&c| c == b' ')
		.position(|n| n == name)
		.map_or(PP_UNKWN, |i| i as u8 + 1)
}

/// zsh `patmatchrange` / `mb_patmatchrange`: whether `ch` is in `set`.
/// `zmb` says how `ch` decoded (only `[:INCOMPLETE:]` and `[:INVALID:]`
/// read it, and only with `mb`).
pub(super) fn matchrange(set: &[SetItem], ch: u32, zmb: Zmb, mb: bool, env: &CharEnv) -> bool {
	set.iter().any(|item| match *item {
		SetItem::Char(c) => c == ch,
		SetItem::Range(lo, hi) => lo <= ch && ch <= hi,
		SetItem::Class(PP_INCOMPLETE) => mb && zmb == Zmb::Incomplete,
		SetItem::Class(PP_INVALID) => mb && zmb == Zmb::Invalid,
		SetItem::Class(pp) if mb => wide_class(pp, ch, env),
		SetItem::Class(pp) => byte_class(pp, ch, env),
	})
}

/// A `[:name:]` test of the byte `ch` (zsh `patmatchrange`: `<ctype.h>`
/// in the C locale, and zsh's `typtab` for its own classes).
fn byte_class(pp: u8, ch: u32, env: &CharEnv) -> bool {
	let Ok(b) = u8::try_from(ch) else {
		return false;
	};
	match pp {
		PP_ALPHA => b.is_ascii_alphabetic(),
		PP_ALNUM => b.is_ascii_alphanumeric(),
		PP_ASCII => b < 0x80,
		PP_BLANK => b == b' ' || b == b'\t',
		PP_CNTRL => b.is_ascii_control(),
		PP_DIGIT => b.is_ascii_digit(),
		PP_GRAPH => b.is_ascii_graphic(),
		PP_LOWER => b.is_ascii_lowercase(),
		PP_PRINT => b.is_ascii_graphic() || b == b' ',
		PP_PUNCT => b.is_ascii_punctuation(),
		PP_SPACE => matches!(b, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r'),
		PP_UPPER => b.is_ascii_uppercase(),
		PP_XDIGIT => b.is_ascii_hexdigit(),
		PP_IDENT => iident(b),
		PP_IFS => isep(b, env),
		PP_IFSSPACE => iwsep(b, env),
		PP_WORD => iword(b, env),
		_ => false,
	}
}

/// A `[:name:]` test of the code point `ch` (zsh `mb_patmatchrange`:
/// `iswalpha` and friends, `wcsitype` for zsh's own classes).
fn wide_class(pp: u8, ch: u32, env: &CharEnv) -> bool {
	if ch < 0x80 {
		// The wide classes agree with the C locale on ASCII, and `wcsitype`
		// reads the byte table for an ASCII character.
		return byte_class(pp, ch, env);
	}
	let Some(c) = char::from_u32(ch) else {
		return false;
	};
	match pp {
		PP_ALPHA => c.is_alphabetic(),
		PP_ALNUM => c.is_alphanumeric(),
		PP_ASCII => false,
		PP_BLANK => c.is_whitespace() && !is_line_break(c),
		PP_CNTRL => c.is_control(),
		PP_DIGIT => false,
		PP_GRAPH => !c.is_control() && !c.is_whitespace(),
		PP_LOWER => c.is_lowercase(),
		PP_PRINT => !c.is_control(),
		PP_PUNCT => !c.is_control() && !c.is_whitespace() && !c.is_alphanumeric(),
		PP_SPACE => c.is_whitespace(),
		PP_UPPER => c.is_uppercase(),
		PP_XDIGIT => false,
		PP_IDENT => !env.posix_identifiers && c.is_alphanumeric(),
		PP_IFS => wide_member(env.ifs, ch),
		// `[:IFSSPACE:]` is ASCII only.
		PP_IFSSPACE => false,
		PP_WORD => c.is_alphanumeric() || wide_member(env.wordchars, ch),
		_ => false,
	}
}

/// Whether `c` is a line or paragraph break, which `iswblank` excludes
/// from the blanks.
const fn is_line_break(c: char) -> bool {
	matches!(c, '\u{85}' | '\u{2028}' | '\u{2029}')
}

/// Whether the non-ASCII character `ch` occurs in the raw string `s`
/// decoded as UTF-8 (zsh's `ifs_wide` and `wordchars_wide`).
fn wide_member(s: &[u8], ch: u32) -> bool {
	s.utf8_chunks()
		.flat_map(|chunk| chunk.valid().chars())
		.any(|c| c as u32 == ch)
}

/// zsh `iident` (`typtab` `IIDENT`): ASCII alphanumerics and `_`.
const fn iident(b: u8) -> bool {
	b.is_ascii_alphanumeric() || b == b'_'
}

/// zsh `inblank` (`typtab` `INBLANK`): space, tab, newline.
const fn inblank(b: u8) -> bool {
	matches!(b, b' ' | b'\t' | b'\n')
}

/// zsh `isep` (`typtab` `ISEP`): an ASCII character of `$IFS`.
fn isep(b: u8, env: &CharEnv) -> bool {
	b < 0x80 && env.ifs.contains(&b)
}

/// zsh `iwsep` (`typtab` `IWSEP`): an IFS whitespace character, i.e. a
/// blank in `$IFS` that is not doubled (`inittyptab`).
fn iwsep(b: u8, env: &CharEnv) -> bool {
	if !inblank(b) {
		return false;
	}
	let ifs = env.ifs;
	let mut i = 0;
	while i < ifs.len() {
		let c = ifs[i];
		if c < 0x80 && inblank(c) {
			if ifs.get(i + 1) == Some(&c) {
				i += 2;
				continue;
			}
			if c == b {
				return true;
			}
		}
		i += 1;
	}
	false
}

/// zsh `iword` (`typtab` `IWORD`): ASCII alphanumerics and the ASCII
/// characters of `$WORDCHARS`.
fn iword(b: u8, env: &CharEnv) -> bool {
	b.is_ascii_alphanumeric() || (b < 0x80 && env.wordchars.contains(&b))
}

/// zsh's `ISUPPER`/`TOLOWER` pair used by `CHARMATCH`: the lower case of
/// `c` if it is upper case. With `wide`, Unicode simple case mapping
/// (`towlower`); otherwise ASCII (the C locale).
#[inline]
pub(super) fn fold_lower(c: u32, wide: bool) -> u32 {
	if c < 0x80 {
		return (c as u8).to_ascii_lowercase() as u32;
	}
	if !wide {
		return c;
	}
	match char::from_u32(c) {
		Some(ch) if ch.is_uppercase() => ch.to_lowercase().next().map_or(c, |l| l as u32),
		_ => c,
	}
}

/// zsh's `ISLOWER(c) && TOUPPER(c)` for `(#l)`: the upper case of `c` if
/// `c` is lower case.
#[inline]
pub(super) fn lower_to_upper(c: u32, wide: bool) -> Option<u32> {
	if c < 0x80 {
		let b = c as u8;
		return b
			.is_ascii_lowercase()
			.then(|| b.to_ascii_uppercase() as u32);
	}
	if !wide {
		return None;
	}
	let ch = char::from_u32(c).filter(|ch| ch.is_lowercase())?;
	let mut up = ch.to_uppercase();
	match (up.next(), up.next()) {
		(Some(u), None) => Some(u as u32),
		_ => Some(c),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn range_type_knows_every_name_and_nothing_else() {
		assert_eq!(range_type(b"alpha"), PP_ALPHA);
		assert_eq!(range_type(b"INVALID"), PP_INVALID);
		assert_eq!(range_type(b"WORD"), PP_WORD);
		assert_eq!(range_type(b"word"), PP_UNKWN);
		assert_eq!(range_type(b""), PP_UNKWN);
	}

	#[test]
	fn iwsep_skips_doubled_blanks() {
		let env = CharEnv { ifs: b"  \t:", ..CharEnv::DEFAULT };
		assert!(!iwsep(b' ', &env));
		assert!(iwsep(b'\t', &env));
		assert!(!iwsep(b':', &env));
		assert!(isep(b' ', &env));
	}
}
