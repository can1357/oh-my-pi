//! bash's quoting styles for re-input: `declare -p` values, `${x@Q}` and
//! `alias` output, `printf %q`, file names in diagnostics, and the escaping
//! of quoted text in patterns.

use std::borrow::Cow;

use bstr::BString;

use super::locale::{self, Charset};

/// `"…"` with `"`, `\`, `$` and `` ` `` escaped, or `$'…'` when needed
/// (`declare -p` values; a UTF-8 locale is assumed, so an invalid byte
/// is octal-escaped).
pub fn declare(b: &[u8]) -> BString {
	if ansic_shouldquote(b, true) {
		return BString::from(ansic(b, true));
	}
	let mut out = Vec::with_capacity(b.len() + 2);
	out.push(b'"');
	for &c in b {
		if matches!(c, b'"' | b'\\' | b'$' | b'`') {
			out.push(b'\\');
		}
		out.push(c);
	}
	out.push(b'"');
	BString::from(out)
}

/// `'…'` with `'` as `'\''`, or `$'…'` when needed (`${x@Q}`, `alias`).
pub fn single(b: &[u8]) -> BString {
	if ansic_shouldquote(b, true) {
		return BString::from(ansic(b, true));
	}
	let mut out = Vec::with_capacity(b.len() + 2);
	out.push(b'\'');
	for &c in b {
		if c == b'\'' {
			out.extend_from_slice(b"'\\''");
		} else {
			out.push(c);
		}
	}
	out.push(b'\'');
	BString::from(out)
}

/// The UTF-8 character at the start of `s` (one byte when it is not a
/// valid one).
fn utf8_char(s: &[u8]) -> &[u8] {
	&s[..locale::char_len(Charset::Utf8, s, false).unwrap_or(1)]
}

/// Whether `ch` (one valid UTF-8 character) is printable (`iswprint`).
fn printable_char(ch: &[u8]) -> bool {
	std::str::from_utf8(ch)
		.ok()
		.and_then(|s| s.chars().next())
		.is_some_and(|c| !c.is_control())
}

/// bash's `ansic_shouldquote`: `s` has a non-printable byte or, in a UTF-8
/// locale, an invalid or non-printable character (outside one, every byte
/// above 0x7f is non-printable).
pub fn ansic_shouldquote(s: &[u8], utf8: bool) -> bool {
	let mut i = 0;
	while i < s.len() {
		let c = s[i];
		if c >= 0x80 {
			if !utf8 {
				return true;
			}
			let ch = utf8_char(&s[i..]);
			if ch.len() == 1 || !printable_char(ch) {
				return true;
			}
			i += ch.len();
			continue;
		}
		if !(0x20..0x7f).contains(&c) {
			return true;
		}
		i += 1;
	}
	false
}

/// bash's `ansic_quote`: `$'…'` with C escapes, printable characters as
/// they are (multibyte ones only in a UTF-8 locale), octal for the rest.
pub fn ansic(s: &[u8], utf8: bool) -> Vec<u8> {
	let mut out = Vec::with_capacity(s.len() * 2 + 3);
	out.extend_from_slice(b"$'");
	let mut i = 0;
	while i < s.len() {
		let c = s[i];
		let esc = match c {
			0x1b => Some(b'E'),
			0x07 => Some(b'a'),
			0x0b => Some(b'v'),
			0x08 => Some(b'b'),
			0x0c => Some(b'f'),
			b'\n' => Some(b'n'),
			b'\r' => Some(b'r'),
			b'\t' => Some(b't'),
			b'\\' | b'\'' => Some(c),
			_ => None,
		};
		if let Some(e) = esc {
			out.extend_from_slice(&[b'\\', e]);
			i += 1;
			continue;
		}
		if c >= 0x80 && utf8 {
			let ch = utf8_char(&s[i..]);
			if ch.len() > 1 && printable_char(ch) {
				out.extend_from_slice(ch);
				i += ch.len();
				continue;
			}
		}
		if (0x20..0x7f).contains(&c) {
			out.push(c);
		} else {
			out.extend_from_slice(&[b'\\', b'0' + (c >> 6), b'0' + ((c >> 3) & 7), b'0' + (c & 7)]);
		}
		i += 1;
	}
	out.push(b'\'');
	out
}

/// bash's `sh_single_quote`: `'…'` with `'` as `'\''` (a lone `'` is
/// `\'`).
pub fn sh_single_quote(s: &[u8]) -> Vec<u8> {
	if s == b"'" {
		return b"\\'".to_vec();
	}
	let mut out = Vec::with_capacity(s.len() + 2);
	out.push(b'\'');
	for &c in s {
		out.push(c);
		if c == b'\'' {
			out.extend_from_slice(b"\\''");
		}
	}
	out.push(b'\'');
	out
}

/// An associative-array key as `declare -p` and `${a[@]@K}` print it (bash
/// `assoc_to_assign`): `$'…'` when [`ansic_shouldquote`], double quotes
/// when it has shell metacharacters or is `@` or `*`, else as it is.
pub fn assoc_key(key: &[u8]) -> Cow<'_, [u8]> {
	if has_shell_metas(key) || ansic_shouldquote(key, true) || matches!(key, b"@" | b"*") {
		Cow::Owned(declare(key).into())
	} else {
		Cow::Borrowed(key)
	}
}

/// bash's `sh_contains_shell_metas`.
fn has_shell_metas(s: &[u8]) -> bool {
	s.iter().enumerate().any(|(i, &c)| match c {
		b' ' | b'\t' | b'\n' | b'\'' | b'"' | b'\\' | b'|' | b'&' | b';' | b'(' | b')' | b'<'
		| b'>' | b'!' | b'{' | b'}' | b'*' | b'[' | b'?' | b']' | b'^' | b'$' | b'`' => true,
		b'~' => i == 0 || matches!(s[i - 1], b'=' | b':'),
		b'#' => i == 0,
		_ => false,
	})
}

/// bash's `printable_filename`: a name as diagnostics print it, `$'…'` when
/// [`ansic_shouldquote`], else (with `metas`, as `hash -l` asks) single
/// quotes when it has shell metacharacters, else as it is.
pub fn printable_filename(name: &[u8], utf8: bool, metas: bool) -> Cow<'_, [u8]> {
	if ansic_shouldquote(name, utf8) {
		Cow::Owned(ansic(name, utf8))
	} else if metas && has_shell_metas(name) {
		Cow::Owned(sh_single_quote(name))
	} else {
		Cow::Borrowed(name)
	}
}

/// Escape glob metacharacters so a quoted string matches literally in a
/// pattern.
pub fn glob_escape(b: &[u8], out: &mut Vec<u8>) {
	for &c in b {
		// `/` too: a quoted `/` must not close a bracket expression when
		// deciding whether a word is a glob pattern (bash
		// `unquoted_glob_pattern_p`).
		if matches!(
			c,
			b'*' | b'?' | b'[' | b']' | b'\\' | b'(' | b')' | b'|' | b'@' | b'!' | b'+' | b'/'
		) {
			out.push(b'\\');
		}
		out.push(c);
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	// Goldens: bash 5.3.20 (LANG=en_US.UTF-8 unless noted): `printf %q`,
	// `"$payload"` → `command not found`, `hash -l`.
	#[test]
	fn printable_filenames_match_bash() {
		let payload = b"5\xa7@3\x99+\xc6S8\x9f\xa2\xea\xb3";
		assert_eq!(
			printable_filename(payload, true, false),
			&br"$'5\247@3\231+\306S8\237\242\352\263'"[..]
		);
		assert_eq!(printable_filename("é".as_bytes(), true, false), "é".as_bytes());
		// LANG=C: every byte above 0x7f is unprintable.
		assert_eq!(printable_filename("é".as_bytes(), false, false), &br"$'\303\251'"[..]);
		assert_eq!(printable_filename(b"a\tb", true, false), &br"$'a\tb'"[..]);
		assert_eq!(printable_filename(b"a b", true, false), &b"a b"[..]);
		assert_eq!(printable_filename(b"a b", true, true), &b"'a b'"[..]);
		assert_eq!(printable_filename(b"x=~", true, true), &b"'x=~'"[..]);
		assert_eq!(printable_filename(b"a~", true, true), &b"a~"[..]);
		assert_eq!(sh_single_quote(b"'"), b"\\'");
		assert_eq!(sh_single_quote(b"a'b"), b"'a'\\''b'");
	}

	// Goldens: bash 5.3.20 `declare -p` and `${x@Q}`.
	#[test]
	fn declare_and_single_match_bash() {
		assert_eq!(declare(b"q\"$`\\x"), "\"q\\\"\\$\\`\\\\x\"");
		assert_eq!(declare(b"x\ny"), "$'x\\ny'");
		assert_eq!(declare(b""), "\"\"");
		assert_eq!(single(b"a'b"), "'a'\\''b'");
		assert_eq!(single(b"a\tb"), "$'a\\tb'");
	}
}
