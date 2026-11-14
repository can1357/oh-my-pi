//! Byte helpers shared by the parser, the printer and the JSON writers.

use alloc::vec::Vec;
use core::fmt;

/// Append the decimal form of `n`.
pub fn push_u32(out: &mut impl Extend<u8>, n: u32) {
	out.extend(n.format_into(&mut fmt::NumBuffer::new()).bytes());
}

/// `[A-Za-z_]`: may start a variable name.
pub const fn is_name_start(c: u8) -> bool {
	c == b'_' || c.is_ascii_alphabetic()
}

/// `[A-Za-z0-9_]`: may continue a variable name.
pub const fn is_name_char(c: u8) -> bool {
	c == b'_' || c.is_ascii_alphanumeric()
}

/// Whether `s` is a valid shell identifier.
pub fn is_identifier(s: &[u8]) -> bool {
	match s.split_first() {
		Some((&c, rest)) => is_name_start(c) && rest.iter().all(|&c| is_name_char(c)),
		None => false,
	}
}

/// Length of the UTF-8 sequence starting with `c` (1 for invalid lead bytes).
pub const fn char_len(c: u8) -> usize {
	match c {
		0xc0..=0xdf => 2,
		0xe0..=0xef => 3,
		0xf0..=0xf7 => 4,
		_ => 1,
	}
}

/// Bytes that end an unquoted word (bash `shellbreak`).
pub const fn is_break(c: u8) -> bool {
	matches!(c, b'(' | b')' | b'<' | b'>' | b';' | b'&' | b'|' | b' ' | b'\t' | b'\n')
}

/// Shell metacharacters (bash `shellmeta`).
pub const fn is_meta(c: u8) -> bool {
	matches!(c, b'(' | b')' | b'<' | b'>' | b';' | b'&' | b'|')
}

/// bash `sh_single_quote`: wrap `s` in single quotes, writing each embedded
/// `'` as `'\''`; a lone `'` becomes `\'`.
pub fn sh_single_quote(out: &mut Vec<u8>, s: &[u8]) {
	if s == b"'" {
		out.extend_from_slice(b"\\'");
		return;
	}
	out.push(b'\'');
	for &c in s {
		if c == b'\'' {
			out.extend_from_slice(b"'\\''");
		} else {
			out.push(c);
		}
	}
	out.push(b'\'');
}

const fn hex_value(c: u8) -> Option<u32> {
	match c {
		b'0'..=b'9' => Some((c - b'0') as u32),
		b'a'..=b'f' => Some((c - b'a' + 10) as u32),
		b'A'..=b'F' => Some((c - b'A' + 10) as u32),
		_ => None,
	}
}

/// Append the UTF-8 encoding of code point `v` (bash `u32cconv` in a UTF-8
/// locale); invalid code points are written as `\uXXXX` text, as bash does
/// when it cannot convert.
fn push_code_point(out: &mut Vec<u8>, v: u32) {
	if let Some(ch) = char::from_u32(v) {
		let mut buf = [0u8; 4];
		out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
	} else {
		out.extend_from_slice(b"\\u");
		for shift in [12u32, 8, 4, 0] {
			out.push(b"0123456789ABCDEF"[((v >> shift) & 0xf) as usize]);
		}
	}
}

/// Decode the body of a `$'…'` string as bash's `ansiexpand` does (the
/// result is cut at the first NUL, like the C string bash keeps).
pub fn ansi_decode(raw: &[u8]) -> Vec<u8> {
	let mut out = ansi_decode_all(raw);
	if let Some(nul) = out.iter().position(|&byte| byte == 0) {
		out.truncate(nul);
	}
	out
}

/// [`ansi_decode`] keeping NULs (zsh's metafied strings hold them).
pub fn ansi_decode_all(raw: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(raw.len());
	let mut pos = 0;
	while pos < raw.len() {
		let byte = raw[pos];
		pos += 1;
		if byte != b'\\' || pos >= raw.len() {
			out.push(byte);
			continue;
		}
		let esc = raw[pos];
		pos += 1;
		match esc {
			b'a' => out.push(7),
			b'v' => out.push(11),
			b'b' => out.push(8),
			b'e' | b'E' => out.push(27),
			b'f' => out.push(12),
			b'n' => out.push(b'\n'),
			b'r' => out.push(b'\r'),
			b't' => out.push(b'\t'),
			b'0'..=b'7' => {
				let mut val = u32::from(esc - b'0');
				let mut count = 0;
				while count < 2 && pos < raw.len() && matches!(raw[pos], b'0'..=b'7') {
					val = val * 8 + u32::from(raw[pos] - b'0');
					pos += 1;
					count += 1;
				}
				out.push((val & 0xff) as u8);
			},
			b'x' => {
				let mut val = 0u32;
				let mut count = 0;
				while count < 2 && pos < raw.len() {
					let Some(digit) = hex_value(raw[pos]) else {
						break;
					};
					val = val * 16 + digit;
					pos += 1;
					count += 1;
				}
				if count == 0 {
					out.extend_from_slice(b"\\x");
				} else {
					out.push((val & 0xff) as u8);
				}
			},
			b'u' | b'U' => {
				let max = if esc == b'u' { 4 } else { 8 };
				let mut val = 0u32;
				let mut count = 0;
				while count < max && pos < raw.len() {
					let Some(digit) = hex_value(raw[pos]) else {
						break;
					};
					val = val.wrapping_mul(16).wrapping_add(digit);
					pos += 1;
					count += 1;
				}
				if count == 0 {
					out.push(b'\\');
					out.push(esc);
				} else if val <= 0x7f {
					out.push(val as u8);
				} else {
					push_code_point(&mut out, val);
				}
			},
			b'\\' | b'\'' | b'"' | b'?' => out.push(esc),
			b'c' => {
				if pos < raw.len() {
					let mut ctl = raw[pos];
					pos += 1;
					if ctl == b'\\' && raw.get(pos) == Some(&b'\\') {
						pos += 1;
					}
					ctl = if ctl == b'?' {
						0x7f
					} else {
						ctl.to_ascii_uppercase() & 0x1f
					};
					out.push(ctl);
				} else {
					out.extend_from_slice(b"\\c");
				}
			},
			_ => {
				out.push(b'\\');
				out.push(esc);
			},
		}
	}
	out
}

/// bash `ansic_shouldquote`: whether `s` holds a byte that is not printable
/// (control characters, DEL, or invalid UTF-8).
pub fn should_ansi_quote(s: &[u8]) -> bool {
	match core::str::from_utf8(s) {
		Ok(text) => text.chars().any(char::is_control),
		Err(_) => true,
	}
}

/// bash `ansic_quote`: `$'…'` form of `s`.
pub fn ansi_quote(out: &mut Vec<u8>, s: &[u8]) {
	out.extend_from_slice(b"$'");
	for &c in s {
		match c {
			7 => out.extend_from_slice(b"\\a"),
			8 => out.extend_from_slice(b"\\b"),
			9 => out.extend_from_slice(b"\\t"),
			10 => out.extend_from_slice(b"\\n"),
			11 => out.extend_from_slice(b"\\v"),
			12 => out.extend_from_slice(b"\\f"),
			13 => out.extend_from_slice(b"\\r"),
			27 => out.extend_from_slice(b"\\E"),
			b'\\' | b'\'' => {
				out.push(b'\\');
				out.push(c);
			},
			0..=31 | 127 => {
				out.push(b'\\');
				out.push(b'0' + (c >> 6));
				out.push(b'0' + ((c >> 3) & 7));
				out.push(b'0' + (c & 7));
			},
			_ => out.push(c),
		}
	}
	out.push(b'\'');
}
