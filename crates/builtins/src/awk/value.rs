//! AWK values and number/string conversions, after GoAWK's `interp/value.go`.

use std::{io::Write as _, rc::Rc};

/// An immutable byte string shared between values.
pub(super) type Bytes = Rc<[u8]>;

/// An AWK value.
#[derive(Clone, Debug)]
pub(super) enum Value {
	/// Uninitialized: both `""` and `0`, compares numerically.
	Null,
	Num(f64),
	Str(Bytes),
	/// A string from input (fields, `getline`, `ARGV`, `ENVIRON`, `-v`): it
	/// compares as a number when it looks like one.
	StrNum(Bytes),
}

impl Value {
	pub fn str(s: &[u8]) -> Self {
		Self::Str(Rc::from(s))
	}

	pub fn string(s: Vec<u8>) -> Self {
		Self::Str(Rc::from(s))
	}

	pub fn strnum(s: &[u8]) -> Self {
		Self::StrNum(Rc::from(s))
	}

	pub fn boolean(b: bool) -> Self {
		Self::Num(if b { 1.0 } else { 0.0 })
	}

	/// The numeric value, converting a string's leading number.
	pub fn num(&self) -> f64 {
		match self {
			Self::Null => 0.0,
			Self::Num(n) => *n,
			Self::Str(s) | Self::StrNum(s) => parse_prefix(s),
		}
	}

	/// The number this value compares as, or `None` for a true string.
	pub fn numeric(&self) -> Option<f64> {
		match self {
			Self::Null => Some(0.0),
			Self::Num(n) => Some(*n),
			Self::Str(_) => None,
			Self::StrNum(s) => looks_numeric(s),
		}
	}

	/// AWK truth: non-zero numbers, non-empty strings.
	pub fn truthy(&self) -> bool {
		match self {
			Self::Null => false,
			Self::Num(n) => *n != 0.0,
			Self::Str(s) => !s.is_empty(),
			Self::StrNum(s) => looks_numeric(s).map_or(!s.is_empty(), |n| n != 0.0),
		}
	}
}

const fn is_space(c: u8) -> bool {
	matches!(c, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c)
}

fn trim(s: &[u8]) -> &[u8] {
	let start = s.iter().position(|&c| !is_space(c)).unwrap_or(s.len());
	let end = s.iter().rposition(|&c| !is_space(c)).map_or(start, |end| end + 1);
	&s[start..end]
}

/// Parses `+inf`, `-nan` and friends (a sign is required, as in gawk).
fn signed_special(s: &[u8]) -> Option<(f64, usize)> {
	let (&sign, rest) = s.split_first()?;
	if sign != b'+' && sign != b'-' || rest.len() < 3 {
		return None;
	}
	let negative = sign == b'-';
	let word = &rest[..3];
	if word.eq_ignore_ascii_case(b"inf") {
		let len = if rest.len() >= 8 && rest[..8].eq_ignore_ascii_case(b"infinity") { 9 } else { 4 };
		Some((if negative { f64::NEG_INFINITY } else { f64::INFINITY }, len))
	} else if word.eq_ignore_ascii_case(b"nan") {
		Some((f64::NAN, 4))
	} else {
		None
	}
}

/// Length of the decimal number at the start of `s` (sign, digits, fraction,
/// exponent), or 0 when there is none.
fn number_len(s: &[u8]) -> usize {
	let mut i = 0;
	if matches!(s.first(), Some(b'+' | b'-')) {
		i += 1;
	}
	let mut digits = false;
	while i < s.len() && s[i].is_ascii_digit() {
		i += 1;
		digits = true;
	}
	if i < s.len() && s[i] == b'.' {
		i += 1;
		while i < s.len() && s[i].is_ascii_digit() {
			i += 1;
			digits = true;
		}
	}
	if !digits {
		return 0;
	}
	if i < s.len() && (s[i] == b'e' || s[i] == b'E') {
		let mut j = i + 1;
		if j < s.len() && (s[j] == b'+' || s[j] == b'-') {
			j += 1;
		}
		let start = j;
		while j < s.len() && s[j].is_ascii_digit() {
			j += 1;
		}
		if j > start {
			i = j;
		}
	}
	i
}

fn parse_f64(s: &[u8]) -> f64 {
	std::str::from_utf8(s).ok().and_then(|s| s.parse().ok()).unwrap_or(0.0)
}

/// The number a whole string denotes, if it looks numeric (surrounding
/// blanks allowed); POSIX's test for numeric strings.
pub(super) fn looks_numeric(s: &[u8]) -> Option<f64> {
	let s = trim(s);
	if s.is_empty() {
		return None;
	}
	if let Some((n, len)) = signed_special(s) {
		return (len == s.len()).then_some(n);
	}
	let len = number_len(s);
	(len != 0 && len == s.len()).then(|| parse_f64(s))
}

/// The number at the start of `s` (`"1.5foo"` is 1.5), 0 when there is none.
pub(super) fn parse_prefix(s: &[u8]) -> f64 {
	let start = s.iter().position(|&c| !is_space(c)).unwrap_or(s.len());
	let s = &s[start..];
	if let Some((n, _)) = signed_special(s) {
		return n;
	}
	let len = number_len(s);
	if len == 0 { 0.0 } else { parse_f64(&s[..len]) }
}

/// Appends `n` as AWK converts numbers to strings: integers without a
/// fraction, NaN and infinities by name, anything else through `fmt`
/// (`CONVFMT` or `OFMT`).
pub(super) fn push_number(out: &mut Vec<u8>, n: f64, fmt: &[u8]) {
	if n.is_nan() {
		out.extend_from_slice(b"nan");
	} else if n.is_infinite() {
		out.extend_from_slice(if n < 0.0 { b"-inf".as_slice() } else { b"inf".as_slice() });
	} else if n == n.trunc() && n.abs() < 9.2e18 {
		let _ = write!(out, "{}", n as i64);
	} else if fmt == b"%.6g" {
		super::format::push_float(out, n, b'g', 6, super::format::Flags::default());
	} else {
		super::format::format_number(out, n, fmt);
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn numeric_strings() {
		assert_eq!(looks_numeric(b" 12 "), Some(12.0));
		assert_eq!(looks_numeric(b"1e3"), Some(1000.0));
		assert_eq!(looks_numeric(b".5"), Some(0.5));
		assert_eq!(looks_numeric(b"0x1A"), None);
		assert_eq!(looks_numeric(b"12abc"), None);
		assert_eq!(looks_numeric(b"info"), None);
		assert_eq!(looks_numeric(b""), None);
	}

	#[test]
	fn leading_number_prefix() {
		assert_eq!(parse_prefix(b"  3.5kg"), 3.5);
		assert_eq!(parse_prefix(b"1e"), 1.0);
		assert_eq!(parse_prefix(b"info"), 0.0);
		assert_eq!(parse_prefix(b"-inf"), f64::NEG_INFINITY);
	}

	#[test]
	fn number_to_string() {
		let fmt = |n: f64| {
			let mut out = Vec::new();
			push_number(&mut out, n, b"%.6g");
			String::from_utf8(out).unwrap()
		};
		assert_eq!(fmt(3.0), "3");
		assert_eq!(fmt(-0.5), "-0.5");
		assert_eq!(fmt(1.0 / 3.0), "0.333333");
		assert_eq!(fmt(123456789.5), "1.23457e+08");
		assert_eq!(fmt(1e30), "1e+30");
	}
}
