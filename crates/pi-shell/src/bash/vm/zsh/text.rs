//! zsh's string helpers the expander uses: separator splitting and
//! joining (`utils.c` `spacesplit`, `sepsplit`, `sepjoin`, `findword`,
//! `wordcount`), character classes (`inittyptab`, `itype_end`), quoting
//! (`quotestring`, `nicedupstring`), escape decoding
//! (`getkeystring`) and case changes (`hist.c` `casemodify`).
//!
//! Every string here is a zsh string: metafied ([`META`] pairs stand for
//! one byte) and possibly tokenized. Character stepping takes `mb`, zsh's
//! `isset(MULTIBYTE)` in a UTF-8 locale ([`super::params::mb`]): with it a
//! character is a UTF-8 sequence (zsh `MB_METACHARLEN`), without it a byte
//! (a metafied pair counts once).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use crate::bash::syntax::zsh::tok::{
	BNULL, DASH, INBRACE, INBRACK, INPAR, INPARMATH, META, NULARG, OUTBRACE, OUTBRACK, OUTPAR,
	OUTPARMATH, QSTRING, QTICK, STRING, TICK, at, head, is_meta, is_null, is_tok, span, tail,
	tok_char,
};

/// zsh's default `IFS`, metafied (`DEFAULT_IFS`: space, tab, newline, NUL).
pub const DEFAULT_IFS: &[u8] = b" \t\n\x83 ";

/// Characters special to the shell's parser (zsh `SPECCHARS`).
const SPECCHARS: &[u8] = b"#$^*()=|{}[]`<>?~;&\n\t \\'\"";

/// Pattern characters (zsh `PATCHARS`).
const PATCHARS: &[u8] = b"#^*()|[]<>?~\\";

/// The words of a space-separated static name list. The dialect keeps its
/// name tables (reserved words, special parameters, …) as one byte string
/// each: a table of string slices would cost one dynamic relocation per
/// entry at every process start, bash shells included.
pub fn word_list(list: &'static [u8]) -> impl Iterator<Item = &'static [u8]> {
	list.split(|&c| c == b' ')
}

/// Bytes of the character at `s[i..]` (zsh `MB_METACHARLEN`): a UTF-8
/// sequence with `mb`, else a byte (a metafied pair is one character).
/// 1 at the end.
pub fn charlen(s: &[u8], i: usize, mb: bool) -> usize {
	mb_metacharlenconv(s, i, mb).0.max(1)
}

/// Characters in `s` (zsh `MB_METASTRLEN`).
pub fn strlen_chars(s: &[u8], mb: bool) -> usize {
	let mut n = 0;
	let mut i = 0;
	while i < s.len() {
		i += charlen(s, i, mb);
		n += 1;
	}
	n
}

/// zsh `mb_metacharlenconv`: the length in metafied bytes and the code of
/// the character at `s[i..]`; `None` for a token or a byte that starts no
/// valid UTF-8 sequence (then one character long), length 0 at the end.
/// Without `mb` every (possibly metafied) byte is a character.
pub fn mb_metacharlenconv(s: &[u8], i: usize, mb: bool) -> (usize, Option<u32>) {
	let c = at(s, i);
	if i >= s.len() {
		return (0, None);
	}
	if !mb || c <= 0x7f {
		return if c == META && i + 1 < s.len() {
			(2, Some(u32::from(s[i + 1] ^ 32)))
		} else {
			(1, Some(u32::from(c)))
		};
	}
	crate::bash::syntax::zsh::mb_metacharlenconv(s, i)
}

/// A delimiter character at `s[i..]` (zsh `MB_METACHARLENCONV` with a
/// `WEOF` result taken as the byte): its length and code; `(0, 0)` at the
/// end.
pub fn delim_at(s: &[u8], i: usize, mb: bool) -> (usize, u32) {
	let (n, wc) = mb_metacharlenconv(s, i, mb);
	(n, wc.unwrap_or_else(|| u32::from(char_at(s, i))))
}

/// The character at `s[i..]` as a `char` (with `mb`, a decoded UTF-8
/// sequence; else the byte), and its length; `None` for a token or an
/// invalid sequence.
pub fn mb_char_at(s: &[u8], i: usize, mb: bool) -> (usize, Option<char>) {
	let (n, wc) = mb_metacharlenconv(s, i, mb);
	(n.max(1), wc.and_then(char::from_u32))
}

/// The byte a character at `s[i..]` stands for (a metafied pair decoded).
pub const fn char_at(s: &[u8], i: usize) -> u8 {
	if at(s, i) == META && i + 1 < s.len() {
		at(s, i + 1) ^ 32
	} else {
		at(s, i)
	}
}

pub use crate::bash::syntax::zsh::{ident_end, iident};

/// zsh `IUSER`: a character of a user name (`~user`).
const fn iuser(c: u8) -> bool {
	c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.' | DASH)
}

/// zsh `itype_end(s, IUSER, 0)` from `from`.
pub const fn user_end(s: &[u8], from: usize) -> usize {
	let mut i = from;
	while i < s.len() && iuser(s[i]) {
		i += 1;
	}
	i
}

/// zsh `ispecial`.
pub fn ispecial(c: u8) -> bool {
	SPECCHARS.contains(&c)
}

/// zsh `ipattern`.
pub fn ipattern(c: u8) -> bool {
	PATCHARS.contains(&c)
}

/// zsh `inblank`: space, tab, newline.
pub const fn inblank(c: u8) -> bool {
	matches!(c, b' ' | b'\t' | b'\n')
}

/// zsh `iblank`: space, tab.
pub const fn iblank(c: u8) -> bool {
	matches!(c, b' ' | b'\t')
}

/// The separator classes zsh derives from `$IFS` (`inittyptab`'s `ISEP`
/// and `IWSEP`): every `IFS` character separates; a blank one (space,
/// tab, newline) that is not doubled is whitespace, whose runs count as
/// one separator. Non-ASCII `IFS` characters separate only with `mb`
/// (zsh's `ifs_wide`); they are never whitespace.
#[derive(Clone, Debug)]
pub struct Seps {
	sep:    [u64; 4],
	wsep:   [u64; 4],
	/// The non-ASCII `IFS` characters (zsh `ifs_wide`), with `mb` only.
	wide:   Vec<u32>,
	/// Characters are UTF-8 sequences (zsh `isset(MULTIBYTE)`).
	pub mb: bool,
}

impl Seps {
	/// The classes of the metafied `IFS` value `ifs`; `mb` as for
	/// [`charlen`].
	pub fn new(ifs: &[u8], mb: bool) -> Self {
		let mut me = Self { sep: [0; 4], wsep: [0; 4], wide: Vec::new(), mb };
		let mut i = 0;
		while i < ifs.len() {
			let c = char_at(ifs, i);
			let n = charlen(ifs, i, false);
			if c.is_ascii() {
				if inblank(c) {
					if ifs.get(i + n) == Some(&c) {
						i += n;
					} else {
						set_bit(&mut me.wsep, c);
					}
				}
				set_bit(&mut me.sep, c);
			}
			i += n;
		}
		// zsh `set_widearray`: no wide separators unless every character
		// converts.
		if mb {
			let mut i = 0;
			while i < ifs.len() {
				let (n, wc) = mb_metacharlenconv(ifs, i, true);
				match wc {
					Some(w) if w > 0x7f => me.wide.push(w),
					Some(_) => {},
					None => {
						me.wide.clear();
						break;
					},
				}
				i += n.max(1);
			}
		}
		me
	}

	/// zsh `isep`.
	pub const fn isep(&self, c: u8) -> bool {
		self.sep[(c >> 6) as usize] & (1 << (c & 63)) != 0
	}

	/// zsh `iwsep`.
	pub const fn iwsep(&self, c: u8) -> bool {
		self.wsep[(c >> 6) as usize] & (1 << (c & 63)) != 0
	}

	/// Whether the character at `s[i..]` is a separator (zsh
	/// `WC_ZISTYPE(c, ISEP)` after `MB_METACHARLENCONV`; tokens never are).
	pub fn sep_at(&self, s: &[u8], i: usize) -> bool {
		if is_tok(s[i]) {
			return false;
		}
		match mb_metacharlenconv(s, i, self.mb).1 {
			Some(w) if w <= 0x7f => u8::try_from(w).is_ok_and(|c| self.isep(c)),
			Some(w) => self.wide.contains(&w),
			None => false,
		}
	}

	/// [`charlen`] under this `IFS`'s `mb`.
	pub fn charlen(&self, s: &[u8], i: usize) -> usize {
		charlen(s, i, self.mb)
	}

	/// Whether the character at `s[i..]` is a whitespace separator.
	const fn wsep_at(&self, s: &[u8], i: usize) -> bool {
		self.iwsep(char_at(s, i))
	}
}

/// Set bit `c` of a 256-bit set.
const fn set_bit(set: &mut [u64; 4], c: u8) {
	set[(c >> 6) as usize] |= 1 << (c & 63);
}

/// zsh `skipwsep`: skip whitespace separators from `*i`; the count.
/// (Whitespace separators are ASCII, so bytes suffice.)
pub fn skipwsep(seps: &Seps, s: &[u8], i: &mut usize) -> usize {
	let mut n = 0;
	while *i < s.len() && seps.wsep_at(s, *i) {
		*i += charlen(s, *i, false);
		n += 1;
	}
	n
}

/// zsh `findsep`: move `*i` to the next separator (`sep` `None`: an
/// `IFS` character; `Some(b"")`: past one character; else the string).
/// `0` already at one, `1` found later, `-1` none.
fn findsep(seps: &Seps, s: &[u8], i: &mut usize, sep: Option<&[u8]>) -> i32 {
	match sep {
		None => {
			let start = *i;
			let mut t = *i;
			while t < s.len() && !seps.sep_at(s, t) {
				t += seps.charlen(s, t);
			}
			*i = t;
			i32::from(t > start)
		},
		Some([]) => {
			if *i < s.len() {
				*i += seps.charlen(s, *i);
				1
			} else {
				-1
			}
		},
		Some(sep) => {
			let mut n = 0;
			while *i < s.len() {
				if tail(s, *i).starts_with(sep) {
					return i32::from(n > 0);
				}
				*i += seps.charlen(s, *i);
				n += 1;
			}
			-1
		},
	}
}

/// zsh `findword`: the next word of `s` from `*i` (`None` at the end);
/// `*i` moves past it.
pub fn findword(seps: &Seps, s: &[u8], i: &mut usize, sep: Option<&[u8]>) -> Option<usize> {
	if *i >= s.len() {
		return None;
	}
	if let Some(sep) = sep {
		let mut r = *i;
		while findsep(seps, s, i, Some(sep)) == 0 {
			*i += sep.len();
			r = *i;
		}
		return Some(r);
	}
	let mut t = *i;
	while t < s.len() && seps.sep_at(s, t) {
		t += seps.charlen(s, t);
	}
	*i = t;
	findsep(seps, s, i, None);
	Some(t)
}

/// zsh `wordcount`.
pub fn wordcount(seps: &Seps, s: &[u8], sep: Option<&[u8]>, mul: i32) -> usize {
	if let Some(sep) = sep {
		let mut r = 1;
		let sl = sep.len();
		let mut i = 0;
		loop {
			let c = findsep(seps, s, &mut i, Some(sep));
			if c < 0 {
				break;
			}
			if (c != 0 || mul != 0) && (sl != 0 || i + sl < s.len()) {
				r += 1;
			}
			i += sl;
		}
		return r;
	}
	let mut r = 0;
	let mut i = 0;
	let mut t = 0;
	if mul <= 0 {
		skipwsep(seps, s, &mut i);
	}
	if (i < s.len() && seps.sep_at(s, i)) || (mul < 0 && t != i) {
		r += 1;
	}
	while i < s.len() {
		if seps.sep_at(s, i) {
			i += seps.charlen(s, i);
			if mul <= 0 {
				skipwsep(seps, s, &mut i);
			}
		}
		findsep(seps, s, &mut i, None);
		t = i;
		if mul <= 0 {
			skipwsep(seps, s, &mut i);
		}
		r += 1;
	}
	if mul < 0 && t != i {
		r += 1;
	}
	r
}

/// zsh `spacesplit`: `s` split at `IFS` separators (whitespace runs
/// count once; a leading or trailing non-whitespace separator makes an
/// empty field). Without `allownull`, empty fields are [`NULARG`]
/// strings (they survive empty-word removal).
pub fn spacesplit(seps: &Seps, s: &[u8], allownull: bool) -> Vec<Vec<u8>> {
	let mut out = Vec::new();
	let nul = || if allownull { Vec::new() } else { vec![NULARG] };
	let mut i = 0;
	skipwsep(seps, s, &mut i);
	let mut t = 0;
	if i < s.len() && seps.sep_at(s, i) {
		out.push(nul());
	} else if !allownull && t != i {
		out.push(Vec::new());
	}
	while i < s.len() {
		if seps.sep_at(s, i) {
			i += seps.charlen(s, i);
			skipwsep(seps, s, &mut i);
		}
		t = i;
		findsep(seps, s, &mut i, None);
		if i > t || allownull {
			out.push(span(s, t, i).to_vec());
		} else {
			out.push(nul());
		}
		t = i;
		skipwsep(seps, s, &mut i);
	}
	if !allownull && t != i {
		out.push(Vec::new());
	}
	out
}

/// zsh `sepsplit`: `s` split at the string `sep`, or by [`spacesplit`]
/// when `sep` is `None`.
pub fn sepsplit(seps: &Seps, s: &[u8], sep: Option<&[u8]>, allownull: bool) -> Vec<Vec<u8>> {
	let s = if s == [NULARG] { tail(s, 1) } else { s };
	let Some(sep) = sep else {
		return spacesplit(seps, s, allownull);
	};
	let n = wordcount(seps, s, Some(sep), 1);
	let mut out = Vec::with_capacity(n);
	let mut t = 0;
	for _ in 0..n {
		let start = t.min(s.len());
		t = start;
		findsep(seps, s, &mut t, Some(sep));
		out.push(span(s, start, t.min(s.len())).to_vec());
		t += sep.len();
	}
	out
}

/// zsh `sepjoin`: the elements joined with `sep`, or with the first
/// character of `IFS` (`ifs`; a space when unset or when it starts with
/// one); `mb` as for [`charlen`].
pub fn sepjoin(items: &[Vec<u8>], sep: Option<&[u8]>, ifs: Option<&[u8]>, mb: bool) -> Vec<u8> {
	let first;
	let sep: &[u8] = match sep {
		Some(s) => s,
		None => match ifs {
			// An empty `IFS` joins with nothing (its first character is
			// the terminating NUL).
			Some([]) => b"",
			Some(ifs) if ifs[0] != b' ' => {
				first = head(ifs, charlen(ifs, 0, mb));
				first
			},
			_ => b" ",
		},
	};
	let mut out = Vec::with_capacity(items.iter().map(|s| s.len() + sep.len()).sum());
	for (n, it) in items.iter().enumerate() {
		if n > 0 {
			out.extend_from_slice(sep);
		}
		out.extend_from_slice(it);
	}
	out
}

/// zsh `skipparens`: from `*i` (at `inpar`), move past the matching
/// `outpar`; `false` when unbalanced.
pub const fn skipparens(inpar: u8, outpar: u8, s: &[u8], i: &mut usize) -> bool {
	if *i >= s.len() || s[*i] != inpar {
		return true;
	}
	let mut level = 1;
	*i += 1;
	while *i < s.len() && level > 0 {
		if s[*i] == inpar {
			level += 1;
		} else if s[*i] == outpar {
			level -= 1;
		}
		*i += 1;
	}
	level == 0
}

/// Case modification of `${(L)…}`, `:l`, `:u`, `(C)` (zsh `CASMOD_*`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaseMod {
	/// Lower case.
	Lower,
	/// Upper case.
	Upper,
	/// Capitalize words.
	Caps,
}

/// zsh `casemodify`; `mb` as for [`charlen`].
pub fn casemodify(s: &[u8], how: CaseMod, mb: bool) -> Vec<u8> {
	if mb {
		return casemodify_mb(s, how);
	}
	let mut out = Vec::with_capacity(s.len());
	let mut nextupper = true;
	let mut i = 0;
	while i < s.len() {
		// A token (a tokenized word's `(`, `*`, …) stays a token.
		if s[i] != META && is_tok(s[i]) {
			out.push(s[i]);
			i += 1;
			nextupper = true;
			continue;
		}
		let mut c = char_at(s, i);
		i += charlen(s, i, false);
		match how {
			CaseMod::Lower => c = c.to_ascii_lowercase(),
			CaseMod::Upper => c = c.to_ascii_uppercase(),
			CaseMod::Caps => {
				if !c.is_ascii_alphanumeric() {
					nextupper = true;
				} else if nextupper {
					c = c.to_ascii_uppercase();
					nextupper = false;
				} else {
					c = c.to_ascii_lowercase();
				}
			},
		}
		push_char(&mut out, c);
	}
	out
}

/// The one-character case mapping of `c` (C `towupper`/`towlower`): a
/// mapping to several characters (`ß` → `SS`) leaves `c` alone.
fn single_case(c: char, upper: bool) -> char {
	let pick = |it: &mut dyn Iterator<Item = char>| match (it.next(), it.next()) {
		(Some(m), None) => m,
		_ => c,
	};
	if upper {
		pick(&mut c.to_uppercase())
	} else {
		pick(&mut c.to_lowercase())
	}
}

/// zsh `casemodify`'s `MULTIBYTE` branch: UTF-8 characters change case;
/// tokens and invalid bytes are copied and end a word.
fn casemodify_mb(s: &[u8], how: CaseMod) -> Vec<u8> {
	let mut out = Vec::with_capacity(s.len());
	let mut nextupper = true;
	let mut i = 0;
	while i < s.len() {
		let (len, wc) = mb_char_at(s, i, true);
		let Some(c) = wc else {
			out.extend_from_slice(span(s, i, i + len));
			i += len;
			nextupper = true;
			continue;
		};
		let m = match how {
			CaseMod::Lower => single_case(c, false),
			CaseMod::Upper => single_case(c, true),
			CaseMod::Caps => {
				if c != '\0' && super::wcwidth::wcwidth(c) == 0 {
					// zsh `IS_COMBINING`: part of the previous character.
					c
				} else if !c.is_alphanumeric() {
					nextupper = true;
					c
				} else if nextupper {
					nextupper = false;
					single_case(c, true)
				} else {
					single_case(c, false)
				}
			},
		};
		if m == c {
			out.extend_from_slice(span(s, i, i + len));
		} else {
			let mut buf = [0; 4];
			for &b in m.encode_utf8(&mut buf).as_bytes() {
				push_char(&mut out, b);
			}
		}
		i += len;
	}
	out
}

/// Push the byte `c` metafied.
pub fn push_char(out: &mut Vec<u8>, c: u8) {
	if is_meta(c) {
		out.push(META);
		out.push(c ^ 32);
	} else {
		out.push(c);
	}
}

/// zsh quoting styles (`QT_*`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Qt {
	/// Backslashes (`(q)`, `:q`).
	Backslash,
	/// Single quotes (`(qq)`).
	Single,
	/// Double quotes (`(qqq)`).
	Double,
	/// `$'…'` (`(qqqq)`).
	Dollars,
	/// Single quotes only where needed (`(q-)`).
	SingleOptional,
	/// Pattern characters backslashed (`(b)`).
	BackslashPattern,
	/// Backslashes, an empty string as `''`.
	BackslashShownull,
}

/// Options `quotestring` reads.
#[derive(Clone, Copy, Debug, Default)]
pub struct QuoteOpts {
	/// `RC_QUOTES`.
	pub rcquotes:          bool,
	/// `MAGIC_EQUAL_SUBST`.
	pub magic_equal_subst: bool,
	/// `EXTENDED_GLOB`.
	pub extended_glob:     bool,
	/// zsh `bangchar` under `BANGHIST` (`histchars[0]`; 0: none or
	/// `BANGHIST` off): `$'…'` quoting backslashes it.
	pub bang:              u8,
	/// The `bang` character is `ISPECIAL` (zsh `ZTF_BANGCHAR`: an
	/// interactive shell reading its standard input): the other styles
	/// quote it too ([`super::params::bang_quoting`]).
	pub bang_special:      bool,
	/// `MULTIBYTE` in a UTF-8 locale ([`super::params::mb`]): a printable
	/// UTF-8 character is no `$'…'` escape.
	pub mb:                bool,
}

/// zsh `MB_METACHARLENCONV` then `WC_ISPRINT`: the length of the
/// character at `s[u..]` and whether it prints (with `mb`, a UTF-8
/// character that is no control character; without, a printable ASCII
/// byte).
fn printable_at(s: &[u8], u: usize, mb: bool) -> (usize, bool) {
	let (n, wc) = mb_metacharlenconv(s, u, mb);
	let printable = match wc {
		Some(w) if w < 0x80 => u8::try_from(w).is_ok_and(isprint),
		Some(w) if mb => char::from_u32(w).is_some_and(|c| !c.is_control()),
		_ => false,
	};
	(n.max(1), printable)
}

/// zsh `addunprintable`: `$'…'` escapes of the bytes `s[a..b]`.
#[allow(clippy::many_single_char_names, reason = "a direct port of zsh's addunprintable")]
fn addunprintable(out: &mut Vec<u8>, s: &[u8], a: usize, b: usize) {
	let mut u = a;
	while u < b {
		let c = if at(s, u) == META && u + 1 < b {
			u += 1;
			at(s, u) ^ 32
		} else {
			at(s, u)
		};
		match c {
			0 => {
				out.extend_from_slice(b"\\0");
				if s.get(u + 1).is_some_and(|d| (b'0'..=b'7').contains(d)) {
					out.extend_from_slice(b"00");
				}
			},
			7 => out.extend_from_slice(b"\\a"),
			8 => out.extend_from_slice(b"\\b"),
			12 => out.extend_from_slice(b"\\f"),
			b'\n' => out.extend_from_slice(b"\\n"),
			b'\r' => out.extend_from_slice(b"\\r"),
			b'\t' => out.extend_from_slice(b"\\t"),
			11 => out.extend_from_slice(b"\\v"),
			_ => {
				out.push(b'\\');
				out.push(b'0' + ((c >> 6) & 7));
				out.push(b'0' + ((c >> 3) & 7));
				out.push(b'0' + (c & 7));
			},
		}
		u += 1;
	}
}

/// Whether the C locale prints `c` (zsh `WC_ISPRINT` in a single-byte
/// locale).
const fn isprint(c: u8) -> bool {
	c >= 0x20 && c < 0x7f
}

/// zsh `quotestring`: `s` quoted in style `how` (the surrounding quotes
/// of [`Qt::Single`], [`Qt::Double`] and [`Qt::Dollars`] are the
/// caller's).
#[allow(clippy::many_single_char_names, reason = "a direct port of zsh's quotestring")]
pub fn quotestring(s: &[u8], how: Qt, o: QuoteOpts) -> Vec<u8> {
	quotestring_comma(s, how, o, false)
}

/// [`quotestring`] with `,` special as well when `comma` is set (zsh's
/// `makecommaspecial(1)`, which completion turns on inside braces).
#[allow(clippy::many_single_char_names, reason = "a direct port of zsh's quotestring")]
pub fn quotestring_comma(s: &[u8], how: Qt, o: QuoteOpts, comma: bool) -> Vec<u8> {
	let (how, shownull) = match how {
		Qt::BackslashShownull => (Qt::Backslash, true),
		Qt::SingleOptional => (how, true),
		_ => (how, false),
	};
	let mut quotesub = u8::from(how == Qt::SingleOptional);
	let mut v: Vec<u8> = Vec::with_capacity(s.len() + 2);
	let mut quotestart = 0;
	let mut u = 0;
	if how == Qt::Dollars {
		if u < s.len() && is_null(s[u]) {
			u += 1;
		}
		while u < s.len() {
			let (n, printable) = printable_at(s, u, o.mb);
			let c = char_at(s, u);
			if printable {
				if c == b'\\' || c == b'\'' || (o.bang != 0 && c == o.bang) {
					v.push(b'\\');
				}
				v.extend_from_slice(span(s, u, u + n));
			} else {
				addunprintable(&mut v, s, u, u + n);
			}
			u += n;
		}
		return v;
	}
	if how == Qt::BackslashPattern {
		while u < s.len() {
			if ipattern(s[u]) {
				v.push(b'\\');
			}
			v.push(s[u]);
			u += 1;
		}
		return v;
	}
	if shownull && s.is_empty() {
		v.extend_from_slice(b"''");
	}
	while u < s.len() {
		let c = s[u];
		let mut dobackslash = false;
		if c == TICK || c == QTICK {
			v.push(c);
			u += 1;
			while u < s.len() && s[u] != c {
				v.push(s[u]);
				u += 1;
			}
			v.push(c);
			if u < s.len() {
				u += 1;
			}
			continue;
		} else if (c == QSTRING || c == b'$') && s.get(u + 1) == Some(&b'\'') && how == Qt::Double {
			v.push(c);
			u += 1;
			continue;
		} else if (c == STRING || c == QSTRING)
			&& matches!(s.get(u + 1), Some(&(INPAR | INBRACK | INBRACE)))
		{
			let close = match s[u + 1] {
				INPAR => OUTPAR,
				INBRACE => OUTBRACE,
				_ => OUTBRACK,
			};
			let beg = c;
			let mut level = 0;
			v.push(s[u]);
			v.push(s[u + 1]);
			u += 2;
			while u < s.len() && (s[u] != close || level > 0) {
				if s[u] == beg {
					level += 1;
				} else if s[u] == close {
					level -= 1;
				}
				v.push(s[u]);
				u += 1;
			}
			if u < s.len() {
				v.push(s[u]);
				u += 1;
			}
			continue;
		} else if (ispecial(c)
			|| (comma && c == b',')
			|| (o.bang_special && o.bang != 0 && c == o.bang))
			&& ((c != b'=' && c != b'~')
				|| u == 0
				|| (o.magic_equal_subst && matches!(s[u - 1], b'=' | b':'))
				|| (c == b'~' && o.extended_glob))
			&& (how == Qt::Backslash
				|| how == Qt::SingleOptional
				|| (o.bang != 0 && c == o.bang && how != Qt::Single)
				|| (how == Qt::Double && matches!(c, b'$' | b'`' | b'"' | b'\\'))
				|| (how == Qt::Single && c == b'\''))
		{
			if how == Qt::SingleOptional {
				if quotesub == 1 {
					if c == b'\'' {
						v.push(b'\\');
					} else {
						v.insert(quotestart, b'\'');
						quotesub = 2;
					}
					v.push(c);
					u += 1;
					quotestart = v.len();
				} else if c == b'\'' {
					if o.rcquotes {
						v.extend_from_slice(b"''");
					} else {
						v.extend_from_slice(b"'\\'");
						quotesub = 1;
						quotestart = v.len();
					}
					u += 1;
				} else {
					v.push(c);
					u += 1;
				}
				continue;
			} else if c == b'\n' || (how == Qt::Single && c == b'\'') {
				if c == b'\n' {
					v.extend_from_slice(b"$'\\n'");
				} else if o.rcquotes {
					v.extend_from_slice(b"''");
				} else {
					v.extend_from_slice(b"'\\''");
				}
				u += 1;
				continue;
			}
			dobackslash = true;
		}
		if is_tok(c) || how != Qt::Backslash {
			if dobackslash {
				v.push(b'\\');
			}
			if c == INPARMATH {
				let mut inmath = 1;
				v.push(c);
				u += 1;
				while u < s.len() {
					let uc = s[u];
					v.push(uc);
					u += 1;
					if uc == OUTPARMATH {
						inmath -= 1;
						if inmath == 0 {
							break;
						}
					} else if uc == INPARMATH {
						inmath += 1;
					}
				}
			} else {
				v.push(c);
				u += 1;
			}
			continue;
		}
		let (n, printable) = printable_at(s, u, o.mb);
		if printable {
			if dobackslash {
				v.push(b'\\');
			}
			v.extend_from_slice(span(s, u, u + n));
		} else {
			v.extend_from_slice(b"$'");
			addunprintable(&mut v, s, u, u + n);
			v.push(b'\'');
		}
		u += n;
	}
	if quotesub == 2 {
		v.push(b'\'');
	}
	v
}

/// zsh `nicechar` (single byte, not quotable): how `${(V)x}` shows `c`.
fn nicechar(c: u8, out: &mut Vec<u8>) {
	let mut c = c;
	if isprint(c) {
		push_char(out, c);
		return;
	}
	if c & 0x80 != 0 {
		out.extend_from_slice(b"\\M-");
		c &= 0x7f;
		if isprint(c) {
			push_char(out, c);
			return;
		}
	}
	if c == 0x7f {
		out.extend_from_slice(b"^?");
	} else if c == b'\n' {
		out.extend_from_slice(b"\\n");
	} else if c == b'\t' {
		out.extend_from_slice(b"\\t");
	} else {
		out.push(b'^');
		out.push(c + 0x40);
	}
}

/// zsh `nicedupstring`: every character of `s` shown visibly
/// (`${(V)x}`); with `mb` (zsh `mb_niceformat`) a printable UTF-8
/// character stays as it is, another becomes `^X`, `\uXXXX` or
/// `\UXXXXXXXX` (zsh `wcs_nicechar`).
pub fn nicedupstring(s: &[u8], mb: bool) -> Vec<u8> {
	let mut out = Vec::with_capacity(s.len());
	let mut i = 0;
	while i < s.len() {
		if mb
			&& !is_tok(s[i])
			&& let (n, Some(ch)) = mb_char_at(s, i, true)
		{
			let code = u32::from(ch);
			if !ch.is_control() {
				out.extend_from_slice(span(s, i, i + n));
			} else if code >= 0x10000 {
				out.extend_from_slice(format!("\\U{code:08x}").as_bytes());
			} else if code >= 0x100 {
				out.extend_from_slice(format!("\\u{code:04x}").as_bytes());
			} else {
				nicechar(u8::try_from(code).unwrap_or(b'?'), &mut out);
			}
			i += n;
			continue;
		}
		let c = if is_tok(s[i]) && s[i] <= crate::bash::syntax::zsh::tok::COMMA {
			tok_char(s[i]).unwrap_or(s[i])
		} else {
			char_at(s, i)
		};
		nicechar(c, &mut out);
		i += charlen(s, i, false);
	}
	out
}

/// `GETKEY_*` flags of [`getkeystring`].
pub mod getkey {
	/// `\0NNN` and `\NNN` octal escapes.
	pub const OCTAL_ESC: u32 = 1 << 0;
	/// `\C-`, `\M-`, `\e`, `\E`.
	pub const EMACS: u32 = 1 << 1;
	/// `^X` control characters.
	pub const CTRL: u32 = 1 << 2;
	/// `\c` ends the string.
	pub const BACKSLASH_C: u32 = 1 << 3;
	/// `$'…'` processing: stops at the closing quote token, output
	/// metafied.
	pub const DOLLAR_QUOTE: u32 = 1 << 4;
	/// zsh `GETKEYS_DOLLARS_QUOTE`.
	pub const DOLLARS_QUOTE: u32 = OCTAL_ESC | EMACS | DOLLAR_QUOTE;
	/// The locale's charset is single-byte ASCII (`C`): a `\u`/`\U` code
	/// point above 127 cannot be encoded (zsh's `wctomb` fails) and sets
	/// [`super::KeyString::range_err`].
	pub const NARROW: u32 = 1 << 12;
	/// zsh `GETKEYS_SEP` (`(p)` flag arguments).
	pub const SEP: u32 = OCTAL_ESC | EMACS;
	/// `GETKEY_PRINTF_PERCENT`: a `%` produced by a numeric escape is
	/// doubled.
	pub const PRINTF_PERCENT: u32 = 1 << 8;
	/// With [`DOLLAR_QUOTE`]: the `POSIX_STRINGS` option is on, so an
	/// embedded NUL and everything after it are dropped.
	pub const POSIX_STRINGS: u32 = 1 << 9;
	/// zsh `GETKEYS_ECHO`.
	pub const KEYS_ECHO: u32 = BACKSLASH_C;
	/// zsh `GETKEYS_PRINTF_FMT`: `\123` → `S`, `\045` → `%%`.
	pub const KEYS_PRINTF_FMT: u32 = OCTAL_ESC | BACKSLASH_C | PRINTF_PERCENT;
	/// zsh `GETKEYS_PRINTF_ARG` (`%b`): `\0123` → `S`.
	pub const KEYS_PRINTF_ARG: u32 = BACKSLASH_C;
	/// zsh `GETKEYS_PRINT`: `print` without `-e`.
	pub const KEYS_PRINT: u32 = OCTAL_ESC | BACKSLASH_C | EMACS;
	/// zsh `GETKEYS_BINDKEY` (`print -b`).
	pub const KEYS_BINDKEY: u32 = OCTAL_ESC | EMACS | CTRL;
}

/// What [`getkeystring`] produced.
pub struct KeyString {
	/// The decoded text: metafied with [`getkey::DOLLAR_QUOTE`], raw
	/// bytes otherwise.
	pub text:      Vec<u8>,
	/// With [`getkey::DOLLAR_QUOTE`]: the input bytes consumed, up to and
	/// including the closing quote.
	pub consumed:  usize,
	/// With [`getkey::BACKSLASH_C`]: a `\c` ended the text (`print` and
	/// `echo` stop all output there).
	pub cut:       bool,
	/// With [`getkey::NARROW`]: a code point did not convert (zsh's
	/// `character not in range` error).
	pub range_err: bool,
}

/// zsh `getkeystring`: decode the escapes of `s` (metafied) as `how`
/// selects. `\u`/`\U` code points are encoded as UTF-8.
#[expect(clippy::too_many_lines, reason = "a faithful port of one C function")]
#[allow(clippy::many_single_char_names, reason = "a direct port of zsh's getkeystring")]
pub fn getkeystring(s: &[u8], how: u32) -> KeyString {
	use crate::bash::syntax::zsh::tok::SNULL;
	let dq = how & getkey::DOLLAR_QUOTE != 0;
	let mut out = Vec::with_capacity(s.len());
	let mut range_err = false;
	let mut i = 0;
	let mut meta = 0u8;
	let mut control = false;
	// Bytes of the current character, before the meta/control and
	// metafication steps.
	let mut cur: Vec<u8> = Vec::with_capacity(8);
	while i < s.len() {
		cur.clear();
		let c = s[i];
		if c == b'\\' && i + 1 < s.len() {
			i += 1;
			let e = s[i];
			match e {
				b'a' => cur.push(7),
				b'n' => cur.push(b'\n'),
				b'b' => cur.push(8),
				b't' => cur.push(b'\t'),
				b'v' => cur.push(11),
				b'f' => cur.push(12),
				b'r' => cur.push(b'\r'),
				b'E' if how & getkey::EMACS == 0 => {
					cur.push(b'\\');
					i -= 1;
				},
				b'e' | b'E' => cur.push(27),
				b'M' => {
					if how & getkey::EMACS != 0 {
						if s.get(i + 1) == Some(&b'-') {
							i += 1;
						}
						meta = 1 + u8::from(control);
					} else {
						out.push(b'\\');
						i -= 1;
					}
					i += 1;
					continue;
				},
				b'C' => {
					if how & getkey::EMACS != 0 {
						if s.get(i + 1) == Some(&b'-') {
							i += 1;
						}
						control = true;
					} else {
						out.push(b'\\');
						i -= 1;
					}
					i += 1;
					continue;
				},
				META => {
					cur.push(b'\\');
					i -= 1;
				},
				b'c' if how & getkey::BACKSLASH_C != 0 => {
					return KeyString { text: out, consumed: i + 1, cut: true, range_err };
				},
				b'u' | b'U' => {
					let mut wval: u32 = 0;
					let digits = if e == b'u' { 4 } else { 8 };
					for _ in 0..digits {
						match s.get(i + 1) {
							Some(&d) if d.is_ascii_hexdigit() => {
								wval = wval * 16 + (d as char).to_digit(16).unwrap_or(0);
								i += 1;
							},
							_ => break,
						}
					}
					if how & getkey::NARROW != 0 && wval > 0x7f {
						range_err = true;
					} else if let Some(ch) = char::from_u32(wval) {
						let mut buf = [0; 4];
						cur.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
					}
					for &b in &cur {
						if dq {
							push_char(&mut out, b);
						} else {
							out.push(b);
						}
					}
					i += 1;
					continue;
				},
				b'\'' | b'\\' if dq => cur.push(e),
				_ => {
					if (e.is_ascii_digit() && e < b'8') || e == b'x' {
						let mut j = i;
						if how & getkey::OCTAL_ESC == 0 {
							if e == b'0' {
								j += 1;
							} else if e != b'x' {
								cur.push(b'\\');
								i -= 1;
								flush(&mut out, &cur, dq, &mut meta, &mut control);
								i += 1;
								continue;
							}
						}
						let (base, start) = if s.get(j) == Some(&b'x') {
							(16, j + 1)
						} else {
							(8, j)
						};
						let lim = (j + 3).min(s.len());
						let mut k = start;
						let mut v: u32 = 0;
						while k < lim {
							match (s[k] as char).to_digit(base) {
								Some(d) => v = v * base + d,
								None => break,
							}
							k += 1;
						}
						#[expect(clippy::cast_possible_truncation, reason = "zsh stores the low byte")]
						let byte = v as u8;
						cur.push(byte);
						if how & getkey::PRINTF_PERCENT != 0 && byte == b'%' {
							cur.push(b'%');
						}
						i = k;
						flush(&mut out, &cur, dq, &mut meta, &mut control);
						continue;
					}
					if how & getkey::EMACS == 0 && e != b'\\' {
						cur.push(b'\\');
					}
					cur.push(e);
				},
			}
			i += 1;
		} else if dq && c == SNULL {
			if how & getkey::POSIX_STRINGS != 0 {
				cut_at_nul(&mut out);
			}
			return KeyString { text: out, consumed: i + 1, cut: false, range_err };
		} else if c == b'^' && !control && how & getkey::CTRL != 0 && i + 1 < s.len() {
			control = true;
			i += 1;
			continue;
		} else if c == META && i + 1 < s.len() {
			cur.push(s[i + 1] ^ 32);
			i += 2;
		} else if is_tok(c) {
			if meta != 0 || control {
				if dq && c == BNULL && i + 1 < s.len() {
					i += 1;
					cur.push(s[i]);
				} else {
					cur.push(tok_char(c).unwrap_or(c));
				}
				i += 1;
			} else if dq {
				out.push(c);
				if c == BNULL && i + 1 < s.len() {
					i += 1;
					out.push(s[i]);
				}
				i += 1;
				continue;
			} else {
				cur.push(c);
				i += 1;
			}
		} else {
			cur.push(c);
			i += 1;
		}
		flush(&mut out, &cur, dq, &mut meta, &mut control);
	}
	if dq && how & getkey::POSIX_STRINGS != 0 {
		cut_at_nul(&mut out);
	}
	KeyString { text: out, consumed: s.len(), cut: false, range_err }
}

/// zsh `getkeystring` under `POSIX_STRINGS`: the metafied `out` ends
/// before its first NUL character.
fn cut_at_nul(out: &mut Vec<u8>) {
	let mut i = 0;
	while i < out.len() {
		if out[i] == META {
			// A metafied NUL is `Meta` and `0 ^ 32`.
			if out.get(i + 1) == Some(&b' ') {
				out.truncate(i);
				return;
			}
			i += 2;
		} else {
			i += 1;
		}
	}
}

/// The end of one [`getkeystring`] character: meta/control applied to
/// its last byte, then metafied into `out` when `dq`.
fn flush(out: &mut Vec<u8>, cur: &[u8], dq: bool, meta: &mut u8, control: &mut bool) {
	let mut cur = cur.to_vec();
	if let Some(last) = cur.last_mut() {
		if *meta == 2 {
			*last |= 0x80;
			*meta = 0;
		}
		if *control {
			*last = if *last == b'?' { 0x7f } else { *last & 0x9f };
			*control = false;
		}
		if *meta != 0 {
			*last |= 0x80;
			*meta = 0;
		}
	}
	for b in cur {
		if dq {
			push_char(out, b);
		} else {
			out.push(b);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn ws(v: &[Vec<u8>]) -> Vec<&[u8]> {
		v.iter().map(Vec::as_slice).collect()
	}

	#[test]
	fn spacesplit_keeps_empty_fields_for_non_whitespace_separators() {
		let seps = Seps::new(b":", false);
		assert_eq!(ws(&spacesplit(&seps, b"a::b", true)), [&b"a"[..], b"", b"b"]);
		let seps = Seps::new(DEFAULT_IFS, false);
		assert_eq!(ws(&spacesplit(&seps, b"  a  b ", true)), [&b"a"[..], b"b"]);
	}

	#[test]
	fn spacesplit_on_wide_separators_needs_multibyte() {
		let ifs = "«»".as_bytes();
		let s = "a«b»c".as_bytes();
		let seps = Seps::new(ifs, true);
		assert_eq!(ws(&spacesplit(&seps, s, true)), [&b"a"[..], b"b", b"c"]);
		let seps = Seps::new(ifs, false);
		assert_eq!(ws(&spacesplit(&seps, s, true)), [s]);
	}

	#[test]
	fn multibyte_character_lengths() {
		let s = "té€".as_bytes();
		assert_eq!(strlen_chars(s, true), 3);
		assert_eq!(strlen_chars(s, false), 6);
		assert_eq!(charlen(s, 1, true), 2);
		assert_eq!(charlen(s, 3, true), 3);
		// A stray continuation byte is one character.
		assert_eq!(charlen(&[0xa9, b'x'], 0, true), 1);
	}

	#[test]
	fn sepsplit_on_a_string_separator() {
		let seps = Seps::new(DEFAULT_IFS, false);
		assert_eq!(ws(&sepsplit(&seps, b"a::b::", Some(b"::"), true)), [&b"a"[..], b"b", b""]);
	}

	#[test]
	fn sepjoin_uses_the_first_ifs_character() {
		let items = vec![b"a".to_vec(), b"b".to_vec()];
		assert_eq!(sepjoin(&items, None, Some(b":x"), false), b"a:b");
		assert_eq!(sepjoin(&items, None, None, false), b"a b");
		assert_eq!(sepjoin(&items, None, Some("«x".as_bytes()), true), "a«b".as_bytes());
	}

	#[test]
	fn quotestring_styles_match_zsh() {
		let o = QuoteOpts::default();
		// zsh: a='a b'\''c'; print -r ${(q)a} ${(qq)a} ${(q-)a}
		assert_eq!(quotestring(b"a b'c", Qt::Backslash, o), b"a\\ b\\'c");
		assert_eq!(quotestring(b"a b'c", Qt::Single, o), b"a b'\\''c");
		assert_eq!(quotestring(b"a b'c", Qt::SingleOptional, o), b"'a b'\\'c");
		assert_eq!(quotestring(b"", Qt::SingleOptional, o), b"''");
		assert_eq!(quotestring(b"x\ny", Qt::Dollars, o), b"x\\ny");
	}

	#[test]
	fn getkeystring_decodes_escapes() {
		let k = getkeystring(b"a\\tb\\x41\\101", getkey::SEP);
		assert_eq!(k.text, b"a\tbAA");
	}

	#[test]
	fn getkeystring_print_decodes_octal_emacs_and_stops_at_backslash_c() {
		use getkey::{KEYS_ECHO, KEYS_PRINT};
		assert_eq!(getkeystring(b"a\\tb\\101\\x41", KEYS_PRINT).text, b"a\tbAA");
		// Without `DOLLAR_QUOTE` the output is raw: `\M-a` is byte 0xe1.
		assert_eq!(getkeystring(b"\\C-a\\M-a\\e", KEYS_PRINT).text, b"\x01\xe1\x1b");
		let k = getkeystring(b"x\\cy", KEYS_PRINT);
		assert_eq!((k.text.as_slice(), k.cut), (&b"x"[..], true));
		// print drops the backslash of an unknown escape, echo keeps it.
		assert_eq!(getkeystring(b"\\q", KEYS_PRINT).text, b"q");
		assert_eq!(getkeystring(b"\\q", KEYS_ECHO).text, b"\\q");
	}

	#[test]
	fn getkeystring_echo_needs_leading_zero_for_octal() {
		assert_eq!(getkeystring(b"\\0101", getkey::KEYS_ECHO).text, b"A");
		assert_eq!(getkeystring(b"\\101", getkey::KEYS_ECHO).text, b"\\101");
	}

	#[test]
	fn printf_format_doubles_percent_from_escape() {
		assert_eq!(getkeystring(b"\\045", getkey::KEYS_PRINTF_FMT).text, b"%%");
	}

	#[test]
	fn casemodify_capitalizes_words() {
		assert_eq!(casemodify(b"hello wORLD", CaseMod::Caps, false), b"Hello World");
	}

	#[test]
	fn casemodify_multibyte() {
		use crate::bash::syntax::zsh::tok::{metafy, unmetafy};
		// zsh strings are metafied (`É` is c3 89, and 0x89 is a meta byte).
		let cm = |s: &str, how| {
			String::from_utf8(unmetafy(&casemodify(&metafy(s.as_bytes()), how, true))).unwrap()
		};
		assert_eq!(cm("l'état c'est moi", CaseMod::Caps), "L'État C'Est Moi");
		assert_eq!(cm("ténébreux", CaseMod::Caps), "Ténébreux");
		assert_eq!(cm("øpened", CaseMod::Upper), "ØPENED");
		// `ß` has no one-character upper case.
		assert_eq!(cm("ß", CaseMod::Upper), "ß");
		// Without multibyte only ASCII changes.
		assert_eq!(casemodify("é".as_bytes(), CaseMod::Upper, false), "é".as_bytes());
	}
}
