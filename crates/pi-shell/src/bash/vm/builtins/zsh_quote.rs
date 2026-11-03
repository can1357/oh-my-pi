//! zsh's text conversions for builtins: the quoting zsh's listings and
//! `printf %q` use (`quotedzputs`, `quotestring` with
//! `QT_BACKSLASH`, `mb_niceformat`, `nicechar`). Inputs and outputs are raw
//! (unmetafied) bytes, as builtins see them.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use crate::bash::{
	syntax::zsh::tok::{span, tail},
	vm::zsh::text::ispecial,
};

/// zsh's `ZISPRINT` for one byte in the C locale.
const fn zisprint(c: u8) -> bool {
	c >= 0x20 && c < 0x7f
}

/// How characters are classified: a UTF-8 locale with `MULTIBYTE`, and
/// `PRINT_EIGHT_BIT`.
#[derive(Clone, Copy, Debug, Default)]
pub struct Charset {
	/// Characters are UTF-8 sequences (`MULTIBYTE` in a UTF-8 locale).
	pub utf8:        bool,
	/// `PRINT_EIGHT_BIT`: bytes and characters above 0x7f print as they
	/// are.
	pub print_eight: bool,
}

/// The next character of `s` at `i`: its length and code, `None` for a
/// byte that does not decode (every byte decodes outside UTF-8).
fn next_char(s: &[u8], i: usize, cs: Charset) -> (usize, Option<u32>) {
	if !cs.utf8 || s[i] < 0x80 {
		return (1, (s[i] < 0x80).then_some(u32::from(s[i])));
	}
	let (ch, n) = bstr::decode_utf8(tail(s, i));
	match ch {
		Some(ch) => (n, Some(u32::from(ch))),
		None => (n.max(1), None),
	}
}

/// zsh `WC_ISPRINT` for a decoded character.
const fn wc_isprint(c: u32) -> bool {
	(c >= 0x20 && c < 0x7f) || c >= 0xa0
}

/// zsh `nicechar_sel`: byte `c` shown visibly (`^X` or, `quotable`,
/// `\C-X`; `\M-` for the high bit unless `PRINT_EIGHT_BIT`).
pub fn nicechar_sel(c: u8, quotable: bool, print_eight: bool, out: &mut Vec<u8>) {
	let mut c = c;
	if zisprint(c) {
		out.push(c);
		return;
	}
	if c & 0x80 != 0 {
		if print_eight {
			out.push(c);
			return;
		}
		out.extend_from_slice(b"\\M-");
		c &= 0x7f;
		if zisprint(c) {
			out.push(c);
			return;
		}
	}
	if c == 0x7f {
		out.extend_from_slice(if quotable { b"\\C-" } else { b"^" });
		c = b'?';
	} else if c == b'\n' {
		out.push(b'\\');
		c = b'n';
	} else if c == b'\t' {
		out.push(b'\\');
		c = b't';
	} else if c < 0x20 {
		out.extend_from_slice(if quotable { b"\\C-" } else { b"^" });
		c += 0x40;
	}
	out.push(c);
}

/// zsh `wcs_nicechar_sel`: character `c` (source bytes `src`) shown
/// visibly.
fn wcs_nicechar(c: u32, src: &[u8], quotable: bool, print_eight: bool, out: &mut Vec<u8>) {
	if !wc_isprint(c) && (c < 0x80 || !print_eight) {
		if c >= 0x1_0000 {
			out.extend_from_slice(format!("\\U{c:08x}").as_bytes());
		} else if c >= 0x100 {
			out.extend_from_slice(format!("\\u{c:04x}").as_bytes());
		} else {
			// Below 0x100: the byte's own visible form.
			nicechar_sel(c.to_le_bytes()[0], quotable, print_eight, out);
		}
		return;
	}
	out.extend_from_slice(src);
}

/// zsh `mb_niceformat` (`nicezputs`): `s` with unprintable characters
/// shown visibly; `quote` (`NICEFLAG_QUOTE`) also escapes `'` and `\` for
/// use inside `$'…'`.
pub fn niceformat(s: &[u8], quote: bool, cs: Charset) -> Vec<u8> {
	let mut out = Vec::with_capacity(s.len());
	let mut i = 0;
	while i < s.len() {
		let (n, c) = next_char(s, i, cs);
		match c {
			None => nicechar_sel(s[i], quote, cs.print_eight, &mut out),
			Some(0x27) if quote => out.extend_from_slice(b"\\'"),
			Some(0x5c) if quote => out.extend_from_slice(b"\\\\"),
			Some(c) => wcs_nicechar(c, span(s, i, i + n), quote, cs.print_eight, &mut out),
		}
		i += if c.is_none() { 1 } else { n };
	}
	out
}

/// zsh `is_mb_niceformat`: whether [`niceformat`] changes `s`.
pub fn needs_niceformat(s: &[u8], cs: Charset) -> bool {
	let mut i = 0;
	while i < s.len() {
		let (n, c) = next_char(s, i, cs);
		let nice = match c {
			None => !zisprint(s[i]) && (s[i] & 0x80 == 0 || !cs.print_eight),
			Some(c) => !wc_isprint(c) && (c < 0x80 || !cs.print_eight),
		};
		if nice {
			return true;
		}
		i += if c.is_none() { 1 } else { n };
	}
	false
}

/// zsh `quotedzputs`: `s` as a shell word for listings (`typeset -p`,
/// `alias`, `trap`): `''` when empty, `$'…'` when it has unprintable
/// characters, as is without special characters, else single-quoted
/// (`'\''` for a quote, or `''` under `RC_QUOTES`).
pub fn quotedzputs(s: &[u8], rcquotes: bool, cs: Charset) -> Vec<u8> {
	if s.is_empty() {
		return b"''".to_vec();
	}
	if needs_niceformat(s, cs) {
		let mut out = b"$'".to_vec();
		out.extend_from_slice(&niceformat(s, true, cs));
		out.push(b'\'');
		return out;
	}
	if !s.iter().any(|&c| ispecial(c)) {
		return s.to_vec();
	}
	let mut out = Vec::with_capacity(s.len() + 4);
	if rcquotes {
		out.push(b'\'');
		for &c in s {
			if c == b'\'' {
				out.push(b'\'');
			}
			out.push(c);
		}
		out.push(b'\'');
		return out;
	}
	let mut inquote = false;
	for &c in s {
		if c == b'\'' {
			if inquote {
				out.push(b'\'');
				inquote = false;
			}
			out.extend_from_slice(b"\\'");
		} else {
			if !inquote {
				out.push(b'\'');
				inquote = true;
			}
			out.push(c);
		}
	}
	if inquote {
		out.push(b'\'');
	}
	out
}

/// zsh `addunprintable`: bytes `u` as `$'…'` escapes.
fn addunprintable(u: &[u8], next: Option<u8>, out: &mut Vec<u8>) {
	for (k, &c) in u.iter().enumerate() {
		match c {
			0 => {
				out.extend_from_slice(b"\\0");
				let after = u.get(k + 1).copied().or(next);
				if after.is_some_and(|a| (b'0'..=b'7').contains(&a)) {
					out.extend_from_slice(b"00");
				}
			},
			0x07 => out.extend_from_slice(b"\\a"),
			0x08 => out.extend_from_slice(b"\\b"),
			0x0c => out.extend_from_slice(b"\\f"),
			b'\n' => out.extend_from_slice(b"\\n"),
			b'\r' => out.extend_from_slice(b"\\r"),
			b'\t' => out.extend_from_slice(b"\\t"),
			0x0b => out.extend_from_slice(b"\\v"),
			_ => {
				out.push(b'\\');
				out.push(b'0' + ((c >> 6) & 7));
				out.push(b'0' + ((c >> 3) & 7));
				out.push(b'0' + (c & 7));
			},
		}
	}
}

/// Options [`quotestring_backslash`] reads.
#[derive(Clone, Copy, Debug, Default)]
pub struct QuoteOpts {
	/// `EXTENDED_GLOB`: `~` is quoted anywhere.
	pub extended_glob:     bool,
	/// `MAGIC_EQUAL_SUBST`: `=`/`~` after `=` or `:` are quoted.
	pub magic_equal_subst: bool,
	/// Character classification.
	pub cs:                Charset,
}

/// zsh `quotestring(s, QT_BACKSLASH)` (`${(q)x}`, `printf %q`):
/// backslashes before special characters, `$'…'` for unprintable ones;
/// `shownull` (`QT_BACKSLASH_SHOWNULL`) shows an empty string as `''`.
#[allow(clippy::many_single_char_names, reason = "a direct port of zsh's quotestring_backslash")]
pub fn quotestring_backslash(s: &[u8], shownull: bool, o: QuoteOpts) -> Vec<u8> {
	let mut out = Vec::with_capacity(s.len() * 2);
	if shownull && s.is_empty() {
		out.extend_from_slice(b"''");
	}
	let mut i = 0;
	while i < s.len() {
		let c = s[i];
		let dobackslash = ispecial(c)
			&& ((c != b'=' && c != b'~')
				|| i == 0
				|| (o.magic_equal_subst && matches!(s[i - 1], b'=' | b':'))
				|| (c == b'~' && o.extended_glob));
		if dobackslash && c == b'\n' {
			out.extend_from_slice(b"$'\\n'");
			i += 1;
			continue;
		}
		let (n, wc) = next_char(s, i, o.cs);
		let n = if wc.is_none() { 1 } else { n };
		let printable = match wc {
			Some(w) => wc_isprint(w),
			None => false,
		};
		if printable {
			if dobackslash {
				out.push(b'\\');
			}
			out.extend_from_slice(span(s, i, i + n));
		} else {
			out.extend_from_slice(b"$'");
			addunprintable(span(s, i, i + n), s.get(i + n).copied(), &mut out);
			out.push(b'\'');
		}
		i += n;
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn quotestring_backslash_matches_zsh_printf_q() {
		let o = QuoteOpts::default();
		assert_eq!(quotestring_backslash(b"", true, o), b"''");
		assert_eq!(quotestring_backslash(b"a b", true, o), b"a\\ b");
		assert_eq!(quotestring_backslash(b"a\nb", true, o), b"a$'\\n'b");
		assert_eq!(quotestring_backslash(b"~x", true, o), b"\\~x");
		assert_eq!(quotestring_backslash(b"a=b", true, o), b"a=b");
		assert_eq!(quotestring_backslash(b"a#", true, o), b"a\\#");
		assert_eq!(quotestring_backslash(b"\x7f", true, o), b"$'\\177'");
	}

	#[test]
	fn quotedzputs_forms() {
		let cs = Charset::default();
		assert_eq!(quotedzputs(b"", false, cs), b"''");
		assert_eq!(quotedzputs(b"plain", false, cs), b"plain");
		assert_eq!(quotedzputs(b"a b", false, cs), b"'a b'");
		assert_eq!(quotedzputs(b"it's", false, cs), b"'it'\\''s'");
		assert_eq!(quotedzputs(b"l\0o", false, cs), b"$'l\\C-@o'");
	}
}
