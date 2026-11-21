//! zsh's internal string representation.
//!
//! Source: zsh 5.9 `zsh.h`, `lex.c`, `utils.c`: the contract between the zsh
//! lexer (this crate), the zsh pattern compiler (`crate::bash::pattern`) and
//! the zsh expander (`crate::bash`).
//!
//! A zsh word ([`crate::bash::syntax::WordPart::Zsh`]) is **metafied**: every
//! byte that zsh treats as special inside its strings (NUL and `0x83..=0xa2`)
//! is stored as [`META`] followed by the byte XOR 32. Unquoted special
//! characters are replaced by **tokens** (`0x84..=0xa2`), so a literal `*`
//! (quoted) and a glob `*` ([`STAR`]) differ; quotes stay as the null
//! tokens [`SNULL`], [`DNULL`], [`BNULL`], removed by quote removal.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use alloc::vec::Vec;

/// Marks the next byte as `byte ^ 32` (zsh `Meta`).
pub const META: u8 = 0x83;
/// `#` (zsh `Pound`).
pub const POUND: u8 = 0x84;
/// `$` (zsh `String`).
pub const STRING: u8 = 0x85;
/// `^` (zsh `Hat`).
pub const HAT: u8 = 0x86;
/// `*` (zsh `Star`).
pub const STAR: u8 = 0x87;
/// `(` (zsh `Inpar`).
pub const INPAR: u8 = 0x88;
/// `((` of `$((`… (zsh `Inparmath`).
pub const INPARMATH: u8 = 0x89;
/// `)` (zsh `Outpar`).
pub const OUTPAR: u8 = 0x8a;
/// `))` of arithmetic (zsh `Outparmath`).
pub const OUTPARMATH: u8 = 0x8b;
/// `$` inside double quotes (zsh `Qstring`).
pub const QSTRING: u8 = 0x8c;
/// `=` (zsh `Equals`).
pub const EQUALS: u8 = 0x8d;
/// `|` (zsh `Bar`).
pub const BAR: u8 = 0x8e;
/// `{` (zsh `Inbrace`).
pub const INBRACE: u8 = 0x8f;
/// `}` (zsh `Outbrace`).
pub const OUTBRACE: u8 = 0x90;
/// `[` (zsh `Inbrack`).
pub const INBRACK: u8 = 0x91;
/// `]` (zsh `Outbrack`).
pub const OUTBRACK: u8 = 0x92;
/// `` ` `` (zsh `Tick`).
pub const TICK: u8 = 0x93;
/// `<` (zsh `Inang`).
pub const INANG: u8 = 0x94;
/// `>` (zsh `Outang`).
pub const OUTANG: u8 = 0x95;
/// `>` of `>(…)` (zsh `OutangProc`).
pub const OUTANGPROC: u8 = 0x96;
/// `?` (zsh `Quest`).
pub const QUEST: u8 = 0x97;
/// `~` (zsh `Tilde`).
pub const TILDE: u8 = 0x98;
/// `` ` `` inside double quotes (zsh `Qtick`).
pub const QTICK: u8 = 0x99;
/// `,` (zsh `Comma`).
pub const COMMA: u8 = 0x9a;
/// `-` in patterns only (zsh `Dash`).
pub const DASH: u8 = 0x9b;
/// `!` in patterns only (zsh `Bang`).
pub const BANG: u8 = 0x9c;
/// The last token that stands for a character of [`ZTOKENS`]
/// (zsh `LAST_NORMAL_TOK`).
pub const LAST_NORMAL_TOK: u8 = BANG;
/// A single quote (zsh `Snull`).
pub const SNULL: u8 = 0x9d;
/// A double quote (zsh `Dnull`).
pub const DNULL: u8 = 0x9e;
/// A backslash (zsh `Bnull`).
pub const BNULL: u8 = 0x9f;
/// A backslash printed back as `\` (zsh `Bnullkeep`).
pub const BNULLKEEP: u8 = 0xa0;
/// A null argument with no character (zsh `Nularg`).
pub const NULARG: u8 = 0xa1;
/// zsh `Marker` (`rc_expand_param`, key/value assignment, pattern arrays).
pub const MARKER: u8 = 0xa2;

/// The characters the tokens from [`POUND`] to [`BNULLKEEP`] stand for
/// (zsh `ztokens`), indexed by `token - POUND`.
pub const ZTOKENS: &[u8; 29] = b"#$^*(())$=|{}[]`<>>?~`,-!'\"\\\\";

/// Whether `c` is a token (zsh `itok`: `Pound..=Nularg`).
pub const fn is_tok(c: u8) -> bool {
	matches!(c, POUND..=NULARG)
}

/// Whether `c` must be metafied (zsh `imeta`: NUL and `Meta..=Marker`).
pub const fn is_meta(c: u8) -> bool {
	c == 0 || matches!(c, META..=MARKER)
}

/// Whether `c` is a null token removed by quote removal (zsh `inull`).
pub const fn is_null(c: u8) -> bool {
	matches!(c, SNULL..=NULARG)
}

/// The character token `t` stands for (zsh `ztokens[t - Pound]`); `None`
/// for [`NULARG`], [`MARKER`] and non-tokens.
pub const fn tok_char(t: u8) -> Option<u8> {
	if matches!(t, POUND..=BNULLKEEP) {
		Some(ZTOKENS[(t - POUND) as usize])
	} else {
		None
	}
}

/// The byte at `i`, 0 past the end (zsh's terminating NUL).
///
/// This and [`tail`], [`span`] and [`head`] are the ports' C-string
/// accessors: they read past the end the way zsh reads its NUL instead of
/// panicking, and each panicking index would be a panic location, one
/// dynamic relocation the loader applies at every process start.
#[inline]
pub const fn at(s: &[u8], i: usize) -> u8 {
	if i < s.len() { s[i] } else { 0 }
}

/// Store `c` at `i` (nothing past the end): the writing counterpart of
/// [`at`].
#[inline]
pub fn set_at(s: &mut [u8], i: usize, c: u8) {
	if let Some(b) = s.get_mut(i) {
		*b = c;
	}
}

/// `s[i..]`, empty past the end.
#[inline]
pub fn tail<T>(s: &[T], i: usize) -> &[T] {
	s.get(i..).unwrap_or_default()
}

/// `s[a..b]` with `b` cut at the end of `s`, empty when `a` is past `b`.
#[inline]
pub fn span<T>(s: &[T], a: usize, b: usize) -> &[T] {
	s.get(a..b.min(s.len())).unwrap_or_default()
}

/// `s[..b]`, all of a shorter `s`.
#[inline]
pub fn head<T>(s: &[T], b: usize) -> &[T] {
	&s[..b.min(s.len())]
}

/// zsh `metafy`: `raw` bytes with every [`is_meta`] byte escaped.
pub fn metafy(raw: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(raw.len());
	for &c in raw {
		if is_meta(c) {
			out.push(META);
			out.push(c ^ 32);
		} else {
			out.push(c);
		}
	}
	out
}

/// zsh `unmetafy`: the raw bytes of a metafied string (tokens kept as
/// they are).
pub fn unmetafy(s: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(s.len());
	let mut i = 0;
	while i < s.len() {
		if s[i] == META && i + 1 < s.len() {
			out.push(at(s, i + 1) ^ 32);
			i += 2;
		} else {
			out.push(s[i]);
			i += 1;
		}
	}
	out
}

/// zsh `untokenize`: every token back to the character it stands for
/// (the null tokens become the quote characters), [`NULARG`] dropped, in
/// place. The result is still metafied.
pub fn untokenize(s: &mut Vec<u8>) {
	let mut w = 0;
	let mut r = 0;
	while r < s.len() {
		let c = s[r];
		r += 1;
		if c == META && r < s.len() {
			let next = at(s, r);
			set_at(s, w, c);
			set_at(s, w + 1, next);
			w += 2;
			r += 1;
			continue;
		}
		if is_tok(c) {
			if let Some(ch) = tok_char(c) {
				set_at(s, w, ch);
				w += 1;
			}
		} else {
			set_at(s, w, c);
			w += 1;
		}
	}
	s.truncate(w);
}

/// Whether the metafied string `s` holds any token (zsh `has_token`).
pub const fn has_token(s: &[u8]) -> bool {
	let mut i = 0;
	while i < s.len() {
		if s[i] == META {
			i += 2;
			continue;
		}
		if is_tok(s[i]) {
			return true;
		}
		i += 1;
	}
	false
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn metafy_round_trips_every_byte() {
		let raw: Vec<u8> = (0..=255).collect();
		let m = metafy(&raw);
		assert!(m.iter().all(|&c| c != 0));
		assert_eq!(unmetafy(&m), raw);
	}

	#[test]
	fn untokenize_maps_tokens_and_drops_nularg() {
		let mut s = alloc::vec![STAR, b'a', SNULL, b'b', SNULL, NULARG, BNULLKEEP, b'c', STRING];
		untokenize(&mut s);
		assert_eq!(s, b"*a'b'\\c$");
	}

	#[test]
	fn untokenize_keeps_metafied_bytes() {
		let mut s = metafy(&[0x85, b'x']);
		untokenize(&mut s);
		assert_eq!(unmetafy(&s), [0x85, b'x']);
	}
}
