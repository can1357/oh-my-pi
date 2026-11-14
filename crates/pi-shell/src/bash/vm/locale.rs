//! The locale as bash sees it, decided from shell variables: the character
//! set (`LC_ALL` > `LC_CTYPE` > `LANG`) and its character boundaries,
//! code-point encoding for `$'\u…'`
//! and `printf '\u…'`, and the decimal point (`LC_ALL` > `LC_NUMERIC` >
//! `LANG`).

use encoding_rs::{DecoderResult, Encoding};

use super::{Kernel, proc::Vproc, state};
use crate::bash::store::{StateStore, StoreError};

/// The character set of a locale.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Charset {
	/// UTF-8.
	Utf8,
	/// `C`, `POSIX`, or a codeset this engine does not know: ASCII, other
	/// bytes as they are.
	Bytes,
	/// ISO 8859-1, exactly (code points U+0000–U+00FF as one byte).
	Latin1,
	/// Another single- or multibyte charset (`big5`, `euc-jp`,
	/// `shift_jis`, `cp1251`, `koi8-r`, …), by its WHATWG encoder.
	Encoding(&'static Encoding),
}

/// `f` of the first of `names` that is set and non-empty, as a shell
/// variable (borrowed, not copied); `None` when none is.
fn first_set<R>(
	root: &state::Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	names: [&[u8]; 3],
	f: impl Fn(&[u8]) -> R,
) -> Result<Option<R>, StoreError> {
	for name in names {
		let found = state::lookup(root, store, vp, name)?
			.and_then(|v| v.as_scalar())
			.filter(|value| !value.is_empty())
			.map(&f);
		if found.is_some() {
			return Ok(found);
		}
	}
	Ok(None)
}

/// The variables [`charset`] reads, in precedence order.
const CTYPE_VARS: [&[u8]; 3] = [b"LC_ALL", b"LC_CTYPE", b"LANG"];

/// The shell's character set: the codeset of the first of `LC_ALL`,
/// `LC_CTYPE` and `LANG` that is set and non-empty, as bash's `setlocale`
/// would see it (see [`charset_of`]). A store failure reads as unset and
/// is recorded on the kernel.
///
/// Every pattern match asks (the compile options hold it), so the answer
/// is kept in [`state::Root::charset`] under [`state::locale_token`]: while
/// none of the three is bound in a scope or assigned by a forked vproc and
/// no root write touched a locale variable, the token is unchanged and the
/// lookups are skipped.
pub fn charset(k: &mut Kernel, store: &mut dyn StateStore, vp: &Vproc) -> Charset {
	charset_root(&mut k.root, store, vp).unwrap_or_else(|e| {
		k.fail(e);
		Charset::Bytes
	})
}

/// [`charset`] on the root state alone (the parse-feature path, which has
/// no kernel).
///
/// # Errors
/// [`StoreError`] when a locale variable cannot be read.
pub fn charset_root(
	root: &mut state::Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<Charset, StoreError> {
	let token = state::locale_token(root, store, vp, &CTYPE_VARS);
	if let (Some(token), Some((at, cs))) = (token, root.charset)
		&& token == at
	{
		return Ok(cs);
	}
	let cs = first_set(root, store, vp, CTYPE_VARS, charset_of)?.unwrap_or(Charset::Bytes);
	if let Some(token) = token {
		root.charset = Some((token, cs));
	}
	Ok(cs)
}

/// Whether the shell's locale is UTF-8 ([`charset`] is [`Charset::Utf8`]).
pub fn is_utf8(k: &mut Kernel, store: &mut dyn StateStore, vp: &Vproc) -> bool {
	charset(k, store, vp) == Charset::Utf8
}

/// The character set of locale name `value` (`lang_TERRITORY.codeset@mod`).
/// `C` and `POSIX` are bytes; a name without a codeset is UTF-8 when the
/// whole name is one (macOS `LC_CTYPE=UTF-8`), else ISO 8859-1 (glibc's
/// default for `lang_TERRITORY`). Codesets compare case-insensitively with
/// `-` and `_` ignored.
pub fn charset_of(value: &[u8]) -> Charset {
	let value = value
		.iter()
		.position(|&c| c == b'@')
		.map_or(value, |at| &value[..at]);
	let Some(dot) = value.iter().position(|&c| c == b'.') else {
		return match value {
			b"C" | b"POSIX" => Charset::Bytes,
			_ if normalized(value) == b"utf8" => Charset::Utf8,
			_ => Charset::Latin1,
		};
	};
	let codeset = &value[dot + 1..];
	match normalized(codeset).as_slice() {
		b"utf8" => Charset::Utf8,
		b"iso88591" | b"latin1" | b"l1" => Charset::Latin1,
		b"big5" => Charset::Encoding(encoding_rs::BIG5),
		b"eucjp" => Charset::Encoding(encoding_rs::EUC_JP),
		b"sjis" | b"shiftjis" => Charset::Encoding(encoding_rs::SHIFT_JIS),
		b"ascii" | b"usascii" | b"ansix3.41968" => Charset::Bytes,
		norm => Encoding::for_label(codeset)
			.or_else(|| Encoding::for_label(norm))
			// Encodings whose encoder writes UTF-8 (UTF-16, `replacement`)
			// are not locale charsets.
			.filter(|e| e.output_encoding() == *e)
			.map_or(Charset::Bytes, |e| {
				if e == encoding_rs::UTF_8 {
					Charset::Utf8
				} else {
					Charset::Encoding(e)
				}
			}),
	}
}

/// A codeset name lower-cased, `-` and `_` removed.
fn normalized(codeset: &[u8]) -> Vec<u8> {
	codeset
		.iter()
		.filter(|&&c| c != b'-' && c != b'_')
		.map(u8::to_ascii_lowercase)
		.collect()
}

/// The byte length of the character at the start of `bytes` in charset
/// `cs` (bash's `mbrlen`): `Some(n)`, where a byte that does not start a
/// valid character is a character by itself (`n == 1`); `None` when
/// `bytes` is a proper prefix of a multibyte character and `more` input
/// could still complete it. `bytes` must not be empty.
pub fn char_len(cs: Charset, bytes: &[u8], more: bool) -> Option<usize> {
	let incomplete = || if more { None } else { Some(1) };
	match cs {
		Charset::Bytes | Charset::Latin1 => Some(1),
		Charset::Utf8 => {
			let need = match bytes[0] {
				0xc2..=0xdf => 2,
				0xe0..=0xef => 3,
				0xf0..=0xf4 => 4,
				_ => return Some(1),
			};
			match core::str::from_utf8(&bytes[..need.min(bytes.len())]) {
				Ok(_) if bytes.len() >= need => Some(need),
				// A valid start that the input ended inside.
				Ok(_) => incomplete(),
				Err(e) if e.error_len().is_none() => incomplete(),
				Err(_) => Some(1),
			}
		},
		Charset::Encoding(enc) => {
			if enc.is_single_byte() {
				return Some(1);
			}
			let mut out = [0u8; 16];
			for n in 1..=bytes.len().min(4) {
				let mut decoder = enc.new_decoder_without_bom_handling();
				let (res, _, written) =
					decoder.decode_to_utf8_without_replacement(&bytes[..n], &mut out, false);
				match res {
					DecoderResult::Malformed(..) => return Some(1),
					DecoderResult::InputEmpty if written == 0 => {},
					_ => return Some(n),
				}
			}
			if bytes.len() < 4 {
				incomplete()
			} else {
				Some(1)
			}
		},
	}
}

/// bash's `u32toutf8`: UTF-8 extended to 31 bits (5- and 6-byte forms past
/// U+1FFFFF, surrogates encoded like any other value); nothing past
/// 0x7FFFFFFF.
fn push_utf8(code: u32, out: &mut Vec<u8>) {
	// Continuation byte `i` (counting from the last) of `code`.
	let cont = |i: u32| 0x80 | ((code >> (6 * i)) & 0x3f) as u8;
	match code {
		0..0x80 => out.push(code as u8),
		0x80..0x800 => out.extend([0xc0 | (code >> 6) as u8, cont(0)]),
		0x800..0x1_0000 => out.extend([0xe0 | (code >> 12) as u8, cont(1), cont(0)]),
		0x1_0000..0x20_0000 => out.extend([0xf0 | (code >> 18) as u8, cont(2), cont(1), cont(0)]),
		0x20_0000..0x400_0000 => {
			out.extend([0xf8 | (code >> 24) as u8, cont(3), cont(2), cont(1), cont(0)]);
		},
		0x400_0000..0x8000_0000 => {
			out.extend([0xfc | (code >> 30) as u8, cont(4), cont(3), cont(2), cont(1), cont(0)]);
		},
		_ => {},
	}
}

/// bash's `u32tocesc`: `\uXXXX` below U+10000, else `\UXXXXXXXX`.
fn push_escape(code: u32, out: &mut Vec<u8>) {
	let text = if code < 0x1_0000 {
		format!("\\u{code:04X}")
	} else {
		format!("\\U{code:08X}")
	};
	out.extend_from_slice(text.as_bytes());
}

/// Append code point `code` in charset `cs`, as bash's `u32cconv` does for
/// `$'\u…'` and `printf '\u…'`: UTF-8 (31-bit, see above) in a UTF-8 locale;
/// the charset's bytes when it has the character; else bash's `\uXXXX` /
/// `\UXXXXXXXX` escape text. ASCII is itself everywhere.
pub fn push_code_point(cs: Charset, code: u32, out: &mut Vec<u8>) {
	if cs == Charset::Utf8 {
		push_utf8(code, out);
		return;
	}
	if code < 0x80 {
		out.push(code as u8);
		return;
	}
	match cs {
		Charset::Latin1 if code <= 0xff => out.push(code as u8),
		Charset::Encoding(enc) => {
			let Some(c) = char::from_u32(code) else {
				push_escape(code, out);
				return;
			};
			let mut buf = [0u8; 4];
			let (bytes, _, unmappable) = enc.encode(c.encode_utf8(&mut buf));
			if unmappable {
				push_escape(code, out);
			} else {
				out.extend_from_slice(&bytes);
			}
		},
		_ => push_escape(code, out),
	}
}

/// The decimal point `printf` uses for `%f`, `%e`, `%g` and `%a`: the
/// `LC_NUMERIC` category (`LC_ALL` > `LC_NUMERIC` > `LANG`). `,` for the
/// languages whose glibc locales use a decimal comma, `.` otherwise (and in
/// `C`/`POSIX`).
pub fn decimal_point(k: &mut Kernel, store: &mut dyn StateStore, vp: &Vproc) -> u8 {
	match first_set(&k.root, store, vp, [b"LC_ALL", b"LC_NUMERIC", b"LANG"], decimal_point_of) {
		Ok(found) => found.unwrap_or(b'.'),
		Err(e) => {
			k.fail(e);
			b'.'
		},
	}
}

/// [`decimal_point`] for locale name `value`.
pub fn decimal_point_of(value: &[u8]) -> u8 {
	let name = value
		.iter()
		.position(|&c| c == b'.' || c == b'@')
		.map_or(value, |end| &value[..end]);
	let (lang, territory) = match name.iter().position(|&c| c == b'_') {
		Some(i) => (&name[..i], &name[i + 1..]),
		None => (name, &b""[..]),
	};
	// Territories whose locale keeps `.` for a decimal-comma language.
	let dot_territory = match lang {
		b"de" | b"it" => territory == b"CH" || territory == b"LI",
		b"es" => matches!(
			territory,
			b"MX" | b"US" | b"PR" | b"GT" | b"HN" | b"NI" | b"PA" | b"SV" | b"DO" | b"PE"
		),
		_ => false,
	};
	let comma = matches!(
		lang,
		b"af"
			| b"az"
			| b"be"
			| b"bg"
			| b"bs"
			| b"ca"
			| b"cs"
			| b"da"
			| b"de"
			| b"el"
			| b"es"
			| b"et"
			| b"eu"
			| b"fi"
			| b"fo"
			| b"fr"
			| b"gl"
			| b"hr"
			| b"hu"
			| b"hy"
			| b"id"
			| b"is"
			| b"it"
			| b"ka"
			| b"kk"
			| b"ky"
			| b"lt"
			| b"lv"
			| b"mk"
			| b"mn"
			| b"nb"
			| b"nl"
			| b"nn"
			| b"no"
			| b"pl"
			| b"pt"
			| b"ro"
			| b"ru"
			| b"sk"
			| b"sl"
			| b"sq"
			| b"sr"
			| b"sv"
			| b"tr"
			| b"uk"
			| b"uz"
			| b"vi"
	);
	if comma && !dot_territory { b',' } else { b'.' }
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn charsets_of_locale_names() {
		assert_eq!(charset_of(b"en_US.UTF-8"), Charset::Utf8);
		assert_eq!(charset_of(b"C.utf8"), Charset::Utf8);
		assert_eq!(charset_of(b"de_DE.UTF-8@euro"), Charset::Utf8);
		assert_eq!(charset_of(b"UTF-8"), Charset::Utf8);
		assert_eq!(charset_of(b"C"), Charset::Bytes);
		assert_eq!(charset_of(b"POSIX"), Charset::Bytes);
		assert_eq!(charset_of(b"fr_FR.ISO8859-1"), Charset::Latin1);
		assert_eq!(charset_of(b"de_DE"), Charset::Latin1);
		assert_eq!(charset_of(b"zh_TW.big5"), Charset::Encoding(encoding_rs::BIG5));
		assert_eq!(charset_of(b"ja_JP.eucJP"), Charset::Encoding(encoding_rs::EUC_JP));
		assert_eq!(charset_of(b"ja_JP.SJIS"), Charset::Encoding(encoding_rs::SHIFT_JIS));
		assert_eq!(charset_of(b"ru_RU.CP1251"), Charset::Encoding(encoding_rs::WINDOWS_1251));
		assert_eq!(charset_of(b"xx_XX.nonsense"), Charset::Bytes);
	}

	/// Goldens: bash 5.3 `printf '\U…' | od -b` (unicode1.sub/unicode2.sub,
	/// glob2.sub).
	#[test]
	fn code_points_encode_like_u32cconv() {
		let enc = |cs, code| {
			let mut out = Vec::new();
			push_code_point(cs, code, &mut out);
			out
		};
		assert_eq!(enc(Charset::Utf8, 0xff), [0o303, 0o277]);
		assert_eq!(enc(Charset::Utf8, 0xffff), [0o357, 0o277, 0o277]);
		assert_eq!(enc(Charset::Utf8, 0x7000_004b), b"\xfd\xb0\x80\x80\x81\x8b");
		assert_eq!(enc(Charset::Utf8, 0xffff_fffe), b"");
		assert_eq!(enc(Charset::Latin1, 0x80), [0x80]);
		assert_eq!(enc(Charset::Latin1, 0x152), b"\\u0152");
		assert_eq!(enc(Charset::Bytes, 0xe9), b"\\u00E9");
		assert_eq!(enc(Charset::Bytes, 0x41), b"A");
		assert_eq!(enc(Charset::Bytes, 0x1_f600), b"\\U0001F600");
		let big5 = Charset::Encoding(encoding_rs::BIG5);
		assert_eq!(enc(big5, 0x3b1), b"\xa3\\");
		assert_eq!(enc(big5, 0x3a8), b"\xa3Z");
		assert_eq!(enc(big5, 0xe9), b"\\u00E9");
	}

	#[test]
	fn character_lengths_follow_mbrlen() {
		let big5 = Charset::Encoding(encoding_rs::BIG5);
		assert_eq!(char_len(Charset::Utf8, "é!".as_bytes(), true), Some(2));
		assert_eq!(char_len(Charset::Utf8, &[0xc3], true), None);
		assert_eq!(char_len(Charset::Utf8, &[0xc3], false), Some(1));
		assert_eq!(char_len(Charset::Utf8, &[0xc3, b'x'], true), Some(1));
		assert_eq!(char_len(Charset::Utf8, &[0xa9], true), Some(1));
		assert_eq!(char_len(Charset::Bytes, &[0xc3, 0xa9], true), Some(1));
		assert_eq!(char_len(big5, b"\xa3\\B", true), Some(2));
		assert_eq!(char_len(big5, &[0xa3], true), None);
		assert_eq!(char_len(big5, b"A", true), Some(1));
		assert_eq!(char_len(Charset::Encoding(encoding_rs::WINDOWS_1251), &[0xff], true), Some(1));
	}

	#[test]
	fn decimal_points() {
		assert_eq!(decimal_point_of(b"de_DE.UTF-8"), b',');
		assert_eq!(decimal_point_of(b"fr_FR.ISO8859-1"), b',');
		assert_eq!(decimal_point_of(b"de_CH.UTF-8"), b'.');
		assert_eq!(decimal_point_of(b"en_US.UTF-8"), b'.');
		assert_eq!(decimal_point_of(b"C"), b'.');
	}
}
