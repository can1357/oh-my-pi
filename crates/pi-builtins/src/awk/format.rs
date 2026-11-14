//! `printf`/`sprintf` formatting with C semantics, after GoAWK's
//! `interp/functions.go` (which defers to Go's `fmt`; this formats directly).
//!
//! Conversions: `%c %d %i %o %x %X %u %e %E %f %F %g %G %s %%`, with the
//! flags `-+ #0`, a width and a precision (either may be `*`). C length
//! modifiers (`h`, `l`, `L`, …) are accepted and ignored.

use std::fmt::Write as _;

use super::value::{Value, push_number};

/// Flags, width and precision of one conversion.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct Flags {
	pub minus: bool,
	pub plus:  bool,
	pub space: bool,
	pub hash:  bool,
	pub zero:  bool,
	pub width: usize,
}

/// Number of characters in `s`: UTF-8 lead bytes and stray bytes.
pub(super) fn char_count(s: &[u8]) -> usize {
	s.iter().filter(|&&b| b & 0xC0 != 0x80).count()
}

/// Byte length of the first `chars` characters of `s`.
pub(super) fn char_prefix(s: &[u8], chars: usize) -> usize {
	let mut seen = 0;
	for (index, &b) in s.iter().enumerate() {
		if b & 0xC0 != 0x80 {
			if seen == chars {
				return index;
			}
			seen += 1;
		}
	}
	s.len()
}

/// Appends `sign`, `prefix` and `body` padded to the flags' width.
fn pad(out: &mut Vec<u8>, sign: &str, prefix: &str, body: &[u8], flags: Flags, zero: bool) {
	let len = sign.len() + prefix.len() + char_count(body);
	let fill = flags.width.saturating_sub(len);
	if fill == 0 {
		out.extend_from_slice(sign.as_bytes());
		out.extend_from_slice(prefix.as_bytes());
		out.extend_from_slice(body);
	} else if flags.minus {
		out.extend_from_slice(sign.as_bytes());
		out.extend_from_slice(prefix.as_bytes());
		out.extend_from_slice(body);
		out.resize(out.len() + fill, b' ');
	} else if zero {
		out.extend_from_slice(sign.as_bytes());
		out.extend_from_slice(prefix.as_bytes());
		out.resize(out.len() + fill, b'0');
		out.extend_from_slice(body);
	} else {
		out.resize(out.len() + fill, b' ');
		out.extend_from_slice(sign.as_bytes());
		out.extend_from_slice(prefix.as_bytes());
		out.extend_from_slice(body);
	}
}

const fn sign_of(negative: bool, flags: Flags) -> &'static str {
	if negative {
		"-"
	} else if flags.plus {
		"+"
	} else if flags.space {
		" "
	} else {
		""
	}
}

/// `a` (non-negative, finite) in C's `%.{prec}e` form.
fn exp_form(a: f64, prec: usize, hash: bool) -> String {
	let s = format!("{a:.prec$e}");
	let (mantissa, exp) = s.split_once('e').unwrap_or((&s, "0"));
	let exp: i32 = exp.parse().unwrap_or(0);
	let mut out = String::with_capacity(mantissa.len() + 5);
	out.push_str(mantissa);
	if hash && prec == 0 {
		out.push('.');
	}
	out.push('e');
	out.push(if exp < 0 { '-' } else { '+' });
	let _ = write!(out, "{:02}", exp.unsigned_abs());
	out
}

/// Removes trailing fraction zeros (and a bare `.`) from a `%g` result.
fn strip_zeros(s: &mut String) {
	let exp_at = s.find('e').unwrap_or(s.len());
	let (mantissa, exp) = s.split_at(exp_at);
	if !mantissa.contains('.') {
		return;
	}
	let trimmed = mantissa.trim_end_matches('0').trim_end_matches('.');
	*s = format!("{trimmed}{exp}");
}

/// Appends `n` in a floating-point conversion (`conv` one of `eEfFgG`).
pub(super) fn push_float(out: &mut Vec<u8>, n: f64, conv: u8, prec: usize, flags: Flags) {
	let upper = conv.is_ascii_uppercase();
	let negative = n.is_sign_negative() && !n.is_nan();
	let a = n.abs();
	if !n.is_finite() {
		let body: &[u8] = match (n.is_nan(), upper) {
			(true, false) => b"nan",
			(true, true) => b"NAN",
			(false, false) => b"inf",
			(false, true) => b"INF",
		};
		pad(out, sign_of(negative, flags), "", body, flags, false);
		return;
	}
	let mut body = match conv.to_ascii_lowercase() {
		b'f' => {
			let mut s = format!("{a:.prec$}");
			if flags.hash && prec == 0 {
				s.push('.');
			}
			s
		},
		b'e' => exp_form(a, prec, flags.hash),
		_ => {
			let p = prec.max(1);
			let probe_digits = p - 1;
			let probe = format!("{a:.probe_digits$e}");
			let x: i64 = if a == 0.0 {
				0
			} else {
				probe.split_once('e').and_then(|(_, e)| e.parse().ok()).unwrap_or(0)
			};
			let mut s = if x < p as i64 && x >= -4 {
				let digits = (p as i64 - 1 - x).max(0) as usize;
				let mut s = format!("{a:.digits$}");
				if flags.hash && !s.contains('.') {
					s.push('.');
				}
				s
			} else {
				exp_form(a, p - 1, flags.hash)
			};
			if !flags.hash {
				strip_zeros(&mut s);
			}
			s
		},
	};
	if upper {
		body.make_ascii_uppercase();
	}
	pad(out, sign_of(negative, flags), "", body.as_bytes(), flags, flags.zero && !flags.minus);
}

/// Appends `n` in an integer conversion (`conv` one of `diouxX`).
fn push_int(out: &mut Vec<u8>, n: f64, conv: u8, prec: Option<usize>, flags: Flags) {
	if !n.is_finite() {
		push_float(out, n, b'f', 0, flags);
		return;
	}
	let signed = matches!(conv, b'd' | b'i');
	let (negative, magnitude) = if signed {
		let v = n as i64;
		(v < 0, v.unsigned_abs())
	} else if n < 0.0 {
		(false, (n as i64) as u64)
	} else {
		(false, n as u64)
	};
	let mut digits = match conv {
		b'o' => format!("{magnitude:o}"),
		b'x' => format!("{magnitude:x}"),
		b'X' => format!("{magnitude:X}"),
		_ => magnitude.to_string(),
	};
	if let Some(prec) = prec {
		if prec == 0 && magnitude == 0 {
			digits.clear();
		}
		while digits.len() < prec {
			digits.insert(0, '0');
		}
	}
	let mut prefix = "";
	if flags.hash {
		match conv {
			b'o' if !digits.starts_with('0') => digits.insert(0, '0'),
			b'x' if magnitude != 0 => prefix = "0x",
			b'X' if magnitude != 0 => prefix = "0X",
			_ => {},
		}
	}
	let sign = if signed { sign_of(negative, flags) } else { "" };
	pad(out, sign, prefix, digits.as_bytes(), flags, flags.zero && !flags.minus && prec.is_none());
}

/// Appends a value's string form for `%s`: numbers go through `convfmt`.
fn push_str_value(out: &mut Vec<u8>, value: &Value, convfmt: &[u8]) {
	match value {
		Value::Null => {},
		Value::Num(n) => push_number(out, *n, convfmt),
		Value::Str(s) | Value::StrNum(s) => out.extend_from_slice(s),
	}
}

/// Formats `format` with `args` into `out`, as AWK's `sprintf`.
///
/// # Errors
///
/// A malformed conversion or too few arguments.
pub(super) fn sprintf(out: &mut Vec<u8>, format: &[u8], args: &[Value], convfmt: &[u8]) -> Result<(), String> {
	let mut args = args.iter();
	let missing = || format!("format error: not enough args for format {:?}", String::from_utf8_lossy(format));
	let mut i = 0;
	let mut scratch = Vec::new();
	while i < format.len() {
		let c = format[i];
		if c != b'%' {
			let next = format[i..].iter().position(|&b| b == b'%').map_or(format.len(), |p| i + p);
			out.extend_from_slice(&format[i..next]);
			i = next;
			continue;
		}
		i += 1;
		if i >= format.len() {
			return Err("format error: expected type specifier after %".to_owned());
		}
		if format[i] == b'%' {
			out.push(b'%');
			i += 1;
			continue;
		}
		let mut flags = Flags::default();
		while i < format.len() {
			match format[i] {
				b'-' => flags.minus = true,
				b'+' => flags.plus = true,
				b' ' => flags.space = true,
				b'#' => flags.hash = true,
				b'0' => flags.zero = true,
				_ => break,
			}
			i += 1;
		}
		if format.get(i) == Some(&b'*') {
			let width = args.next().ok_or_else(missing)?.num();
			let width = if width.is_finite() { width as i64 } else { 0 };
			if width < 0 {
				flags.minus = true;
			}
			flags.width = width.unsigned_abs().min(1 << 20) as usize;
			i += 1;
		} else {
			while let Some(d) = format.get(i).filter(|d| d.is_ascii_digit()) {
				flags.width = (flags.width * 10 + usize::from(d - b'0')).min(1 << 20);
				i += 1;
			}
		}
		let mut prec = None;
		if format.get(i) == Some(&b'.') {
			i += 1;
			if format.get(i) == Some(&b'*') {
				let p = args.next().ok_or_else(missing)?.num();
				prec = (p >= 0.0).then(|| p.min(f64::from(1 << 20)) as usize);
				i += 1;
			} else {
				let mut p = 0usize;
				while let Some(d) = format.get(i).filter(|d| d.is_ascii_digit()) {
					p = (p * 10 + usize::from(d - b'0')).min(1 << 20);
					i += 1;
				}
				prec = Some(p);
			}
		}
		while matches!(format.get(i), Some(b'h' | b'l' | b'L' | b'q' | b'j' | b'z' | b't')) {
			i += 1;
		}
		let Some(&conv) = format.get(i) else {
			return Err("format error: expected type specifier after %".to_owned());
		};
		i += 1;
		match conv {
			b'd' | b'i' | b'o' | b'x' | b'X' | b'u' => {
				let n = args.next().ok_or_else(missing)?.num();
				push_int(out, n, conv, prec, flags);
			},
			b'e' | b'E' | b'f' | b'F' | b'g' | b'G' => {
				let n = args.next().ok_or_else(missing)?.num();
				push_float(out, n, conv, prec.unwrap_or(6), flags);
			},
			b'c' => {
				let value = args.next().ok_or_else(missing)?;
				scratch.clear();
				match value.numeric().filter(|_| !matches!(value, Value::Null)) {
					Some(n) if !matches!(value, Value::Str(_)) => {
						let code = if n.is_finite() && n >= 0.0 { n as u32 } else { 0 };
						let c = char::from_u32(code).unwrap_or('\u{FFFD}');
						let mut buf = [0; 4];
						scratch.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
					},
					_ => {
						let mut text = Vec::new();
						push_str_value(&mut text, value, convfmt);
						let len = char_prefix(&text, 1);
						scratch.extend_from_slice(&text[..len]);
					},
				}
				pad(out, "", "", &scratch, flags, flags.zero && !flags.minus);
			},
			b's' => {
				let value = args.next().ok_or_else(missing)?;
				scratch.clear();
				push_str_value(&mut scratch, value, convfmt);
				if let Some(prec) = prec {
					let len = char_prefix(&scratch, prec);
					scratch.truncate(len);
				}
				pad(out, "", "", &scratch, flags, flags.zero && !flags.minus);
			},
			other => {
				return Err(format!("format error: invalid format type {:?}", char::from(other)));
			},
		}
	}
	Ok(())
}

/// Formats `n` with a `CONVFMT`/`OFMT` value that is not the default; a
/// format that cannot take one number is used literally, as gawk does.
pub(super) fn format_number(out: &mut Vec<u8>, n: f64, fmt: &[u8]) {
	let mut formatted = Vec::new();
	match sprintf(&mut formatted, fmt, &[Value::Num(n)], b"%.6g") {
		Ok(()) => out.extend_from_slice(&formatted),
		Err(_) => out.extend_from_slice(fmt),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn f(format: &str, args: &[Value]) -> String {
		let mut out = Vec::new();
		sprintf(&mut out, format.as_bytes(), args, b"%.6g").unwrap();
		String::from_utf8(out).unwrap()
	}

	#[test]
	fn integers() {
		assert_eq!(f("%d|%5d|%-5d|%05d", &[Value::Num(-3.9), Value::Num(42.0), Value::Num(42.0), Value::Num(-42.0)]), "-3|   42|42   |-0042");
		assert_eq!(f("%x %X %#x %o %#o", &[Value::Num(255.0), Value::Num(255.0), Value::Num(255.0), Value::Num(8.0), Value::Num(8.0)]), "ff FF 0xff 10 010");
		assert_eq!(f("%.3d|%+d|% d", &[Value::Num(7.0), Value::Num(7.0), Value::Num(7.0)]), "007|+7| 7");
		assert_eq!(f("%u", &[Value::Num(-1.0)]), "18446744073709551615");
		assert_eq!(f("%i", &[Value::str(b"12abc")]), "12");
	}

	#[test]
	fn floats() {
		assert_eq!(f("%f %.2f %8.3f %-8.1f|", &[Value::Num(3.14159), Value::Num(2.005), Value::Num(3.14159), Value::Num(2.5)]), "3.141590 2.00    3.142 2.5     |");
		assert_eq!(f("%e %E %.0e", &[Value::Num(1234.5), Value::Num(0.00012), Value::Num(5.0)]), "1.234500e+03 1.200000E-04 5e+00");
		assert_eq!(f("%g %g %g %G %#g", &[Value::Num(100000.0), Value::Num(1000000.0), Value::Num(0.0001), Value::Num(1e-5), Value::Num(1.5)]), "100000 1e+06 0.0001 1E-05 1.50000");
		assert_eq!(f("%.3g %g", &[Value::Num(3.14159), Value::Num(0.0)]), "3.14 0");
	}

	#[test]
	fn strings_and_chars() {
		assert_eq!(f("%s|%5s|%-5s|%.2s", &[Value::str(b"abc"), Value::str(b"abc"), Value::str(b"abc"), Value::str(b"abc")]), "abc|  abc|abc  |ab");
		assert_eq!(f("%c%c%c", &[Value::Num(65.0), Value::str(b"hello"), Value::strnum(b"66")]), "AhB");
		assert_eq!(f("%*d|%-*d|%.*f", &[Value::Num(4.0), Value::Num(1.0), Value::Num(3.0), Value::Num(2.0), Value::Num(1.0), Value::Num(2.26)]), "   1|2  |2.3");
		assert_eq!(f("100%%", &[]), "100%");
		assert_eq!(f("%5s|", &[Value::str("é".as_bytes())]), "    é|");
	}

	#[test]
	fn missing_args_and_bad_conversions_fail() {
		let mut out = Vec::new();
		assert!(sprintf(&mut out, b"%s %s", &[Value::str(b"a")], b"%.6g").is_err());
		assert!(sprintf(&mut out, b"%z", &[Value::Num(1.0)], b"%.6g").is_err());
	}
}
