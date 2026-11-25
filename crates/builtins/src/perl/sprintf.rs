//! Perl's `sprintf` conversion grammar and formatting rules (`perlfunc`, `perldiag`).

use std::{borrow::Cow, fmt::Write as _};

use super::{
	pack::{encode_utf8, int_bits, sprintf_char},
	limits::check_len,
	value::{Num, PStr, Stringify, Value, format_float},
};

#[derive(Clone, Copy, Default)]
struct Flags {
	plus: bool,
	space: bool,
	left: bool,
	zero: bool,
	alternate: bool,
}

#[derive(Clone, Copy)]
enum Size {
	Default,
	Char,
	Short,
}

#[derive(Clone, Copy)]
enum Field {
	Number(usize),
	Argument(Option<usize>),
}

struct Conversion {
	kind: u8,
	index: Option<usize>,
	flags: Flags,
	separator: Option<Field>,
	width: Option<Field>,
	precision: Option<Field>,
	size: Size,
}

const OVERFLOW: &str = "Integer overflow in format string for sprintf";

// An invalid conversion is diagnosed through `end`, but only the initial % is
// committed to the output. In particular, a % within it can start a new conversion.
enum Parse {
	Valid(Conversion, usize),
	Invalid(usize),
}

fn digits(bytes: &[u8], i: &mut usize) -> Result<Option<usize>, String> {
	let start = *i;
	let mut n = 0usize;
	while let Some(digit @ b'0'..=b'9') = bytes.get(*i) {
		n = n.checked_mul(10)
			.and_then(|n| n.checked_add(usize::from(digit - b'0')))
			.filter(|&n| n < i64::MAX as usize)
			.ok_or_else(|| OVERFLOW.to_owned())?;
		*i += 1;
	}
	Ok((*i != start).then_some(n))
}

fn parse(bytes: &[u8], mut i: usize) -> Result<Parse, String> {
	let start = i;
	let index = if let Some(n) = digits(bytes, &mut i)?
		&& bytes.get(i) == Some(&b'$')
	{
		let Some(index) = n.checked_sub(1) else { return Ok(Parse::Invalid(i + 1)) };
		i += 1;
		Some(index)
	} else {
		i = start;
		None
	};
	let mut flags = Flags::default();
	loop {
		match bytes.get(i) {
			Some(b'+') => flags.plus = true,
			Some(b' ') => flags.space = true,
			Some(b'-') => flags.left = true,
			Some(b'0') => flags.zero = true,
			Some(b'#') => flags.alternate = true,
			_ => break,
		}
		i += 1;
	}
	let mut separator = None;
	let mut width = None;
	if bytes.get(i) == Some(&b'v') {
		separator = Some(Field::Number(0)); // the default separator, not an argument
		i += 1;
	} else if bytes.get(i) == Some(&b'*') {
		i += 1;
		let field = match star(bytes, &mut i)? {
			Ok(field) => field,
			Err(end) => return Ok(Parse::Invalid(end)),
		};
		if bytes.get(i) == Some(&b'v') {
			separator = Some(field);
			i += 1;
		} else {
			width = Some(field);
		}
	}
	if width.is_none() {
		if separator.is_some() {
			while bytes.get(i) == Some(&b'0') {
				flags.zero = true;
				i += 1;
			}
		}
		width = if bytes.get(i) == Some(&b'*') && separator.is_some() {
			i += 1;
			match star(bytes, &mut i)? {
				Ok(field) => Some(field),
				Err(end) => return Ok(Parse::Invalid(end)),
			}
		} else {
			digits(bytes, &mut i)?.map(Field::Number)
		};
	}
	let precision = if bytes.get(i) == Some(&b'.') {
		i += 1;
		Some(if bytes.get(i) == Some(&b'*') {
			i += 1;
			match star(bytes, &mut i)? {
				Ok(field) => field,
				Err(end) => return Ok(Parse::Invalid(end)),
			}
		} else {
			Field::Number(digits(bytes, &mut i)?.unwrap_or(0))
		})
	} else {
		None
	};
	let integer_size = matches!(bytes.get(i), Some(b'h' | b'z' | b't' | b'j'));
	let size = match bytes.get(i) {
		Some(b'h') => {
			i += 1;
			if bytes.get(i) == Some(&b'h') {
				i += 1;
				Size::Char
			} else {
				Size::Short
			}
		},
		Some(b'l') => {
			i += 1;
			if bytes.get(i) == Some(&b'l') {
				i += 1;
			}
			Size::Default
		},
		Some(b'q' | b'L' | b'V' | b'z' | b't' | b'j') => {
			i += 1;
			Size::Default
		},
		_ => Size::Default,
	};
	let Some(&kind) = bytes.get(i) else { return Ok(Parse::Invalid(i)) };
	i += 1;
	if !b"csdiDuUoOxXbBeEfFgGaApn%".contains(&kind)
		|| separator.is_some() && !b"diDuUoOxXbB".contains(&kind)
		|| integer_size && b"eEfFgGaA".contains(&kind)
	{
		return Ok(Parse::Invalid(i));
	}
	Ok(Parse::Valid(Conversion { kind, index, flags, separator, width, precision, size }, i))
}

fn star(bytes: &[u8], i: &mut usize) -> Result<Result<Field, usize>, String> {
	let Some(n) = digits(bytes, i)? else { return Ok(Ok(Field::Argument(None))) };
	if n == 0 {
		return Ok(Err(*i));
	}
	if bytes.get(*i) != Some(&b'$') {
		return Ok(Err((*i + 1).min(bytes.len())));
	}
	*i += 1;
	Ok(Ok(Field::Argument(Some(n - 1))))
}

struct Arguments<'a> {
	values: &'a [Value],
	current: usize,
	explicit: bool,
	missing: bool,
}

impl<'a> Arguments<'a> {
	fn get(&mut self, index: Option<usize>, warn_undef: bool, cx: &mut dyn Stringify) -> Option<Cow<'a, Value>> {
		let index = self.take(index);
		let value = self.values.get(index).map(|value| {
			cx.arg(index).map_or(Cow::Borrowed(value), Cow::Owned)
		});
		if let Some(value) = &value {
			if warn_undef && value.is_undef() {
				cx.warn("Use of uninitialized value in sprintf".into());
			}
		} else {
			self.missing = true;
		}
		value
	}

	fn take(&mut self, index: Option<usize>) -> usize {
		if let Some(index) = index {
			self.explicit = true;
			index
		} else {
			let index = self.current;
			self.current += 1;
			index
		}
	}

	fn field(&mut self, field: Option<Field>, cx: &mut dyn Stringify) -> Result<Option<i64>, String> {
		const LIMIT: i64 = i64::MAX / 2;
		let n = match field {
			None => return Ok(None),
			Some(Field::Number(n)) => n as i64,
			Some(Field::Argument(index)) => match self.get(index, true, cx).map_or(Num::Int(0), |v| number(&v, cx)) {
				Num::Int(n) => n,
				Num::UInt(n) => i64::try_from(n).map_err(|_| OVERFLOW.to_owned())?,
				Num::Float(n) if !n.is_finite() => 0,
				Num::Float(n) => n as i64,
			},
		};
		if !(-LIMIT..=LIMIT).contains(&n) { return Err(OVERFLOW.to_owned()); }
		Ok(Some(n))
	}
}

fn number(value: &Value, cx: &mut dyn Stringify) -> Num {
	if let Value::Str(s) = value
		&& !value.is_numeric_string()
	{
		cx.warn(format!("Argument \"{}\" isn't numeric in sprintf", escaped(s)));
	}
	cx.numify(value)
}

/// Quotes a Perl scalar's contents as used in numeric-conversion diagnostics.
pub(super) fn escaped(s: &PStr) -> String {
	let mut out = String::new();
	for mut c in s.chars() {
		let start = out.len();
		if c >= 128 && s.utf8 {
			let _ = write!(out, "\\x{{{c:x}}}");
		} else {
			if c >= 128 {
				out.push_str("M-");
				c &= 127;
			}
			match c {
				0 => out.push_str("\\0"),
				9 => out.push_str("\\t"),
				10 => out.push_str("\\n"),
				12 => out.push_str("\\f"),
				13 => out.push_str("\\r"),
				92 => out.push_str("\\\\"),
				32..=126 => out.push(c as u8 as char),
				_ => {
					out.push('^');
					out.push((c as u8 ^ 64) as char);
				},
			}
		}
		if out.len() > 56 {
			out.truncate(start);
			out.push_str("...");
			break;
		}
	}
	out
}

fn invalid_warning(fragment: &[u8]) -> String {
	let mut warning = String::from("Invalid conversion in sprintf: ");
	if fragment == b"%" {
		warning.push_str("end of string");
	} else {
		warning.push('"');
		for &b in fragment {
			if (b' '..=b'~').contains(&b) {
				warning.push(b as char);
			} else {
				let _ = write!(warning, "\\{b:03o}");
			}
		}
		warning.push('"');
	}
	warning
}

fn append(out: &mut PStr, bytes: &[u8], utf8: bool) {
	if utf8 {
		out.upgrade();
		out.bytes.extend_from_slice(bytes);
	} else {
		out.push_bytes(bytes);
	}
}

fn pad(out: &mut PStr, byte: u8, n: usize) -> Result<(), String> {
	check_len(out.bytes.len().saturating_add(n), "string")?;
	out.bytes.try_reserve(n).map_err(|_| OVERFLOW.to_owned())?;
	out.bytes.resize(out.bytes.len() + n, byte);
	Ok(())
}

struct Output<'a> {
	out: &'a mut PStr,
	flags: Flags,
	width: usize,
	precision: Option<usize>,
}

impl Output<'_> {
	fn field(&mut self, prefix: &[u8], zeros: usize, bytes: &[u8], len: usize, utf8: bool, zero_pad: bool) -> Result<(), String> {
		let padding = self.width.saturating_sub(prefix.len() + len + zeros);
		let zero_pad = self.flags.zero && zero_pad;
		if !self.flags.left && !zero_pad {
			pad(self.out, b' ', padding)?;
		}
		self.out.bytes.extend_from_slice(prefix);
		let extra_zero = if !self.flags.left && zero_pad { padding } else { 0 };
		pad(self.out, b'0', zeros + extra_zero)?;
		append(self.out, bytes, utf8);
		if self.flags.left {
			pad(self.out, b' ', padding)?;
		}
		Ok(())
	}

	fn string(&mut self, s: &PStr) -> Result<(), String> {
		if self.width == 0 {
			let end = self.precision.map_or(s.bytes.len(), |n| s.char_to_byte(n));
			append(self.out, &s.bytes[..end], s.utf8);
			return Ok(());
		}
		let (end, n) = if let Some(n) = self.precision {
			let end = s.char_to_byte(n);
			(end, if end == s.bytes.len() { s.char_len() } else { n })
		} else {
			(s.bytes.len(), s.char_len())
		};
		self.field(b"", 0, &s.bytes[..end], n, s.utf8, true)
	}

	fn sign(&self, negative: bool) -> &'static [u8] {
		if negative { b"-" } else if self.flags.plus { b"+" } else if self.flags.space { b" " } else { b"" }
	}

	fn special(&mut self, f: f64) -> Result<(), String> {
		let s: &[u8] = if f.is_nan() {
			b"NaN"
		} else if f.is_sign_negative() {
			b"-Inf"
		} else if self.flags.plus || self.flags.space {
			b"+Inf"
		} else {
			b"Inf"
		};
		self.field(b"", 0, s, s.len(), false, true)
	}

	fn character(&mut self, n: Num, byte_semantics: bool) -> Result<(), String> {
		if let Num::Float(f) = n && !f.is_finite() {
			return Err(format!("Cannot printf {} with 'c'", format_float(f).to_string_lossy()));
		}
		let cp = if byte_semantics { u64::from(int_bits(n) as u8) } else { int_bits(n) };
		if cp > i64::MAX as u64 {
			return Err(format!("Use of code point 0x{cp:X} is not allowed; the permissible max is 0x7FFFFFFFFFFFFFFF"));
		}
		let utf8 = self.out.utf8 || cp > 255;
		let mut storage = [0; 13];
		let bytes = if utf8 {
			encode_utf8(cp, &mut storage)
		} else {
			storage[0] = cp as u8;
			&storage[..1]
		};
		let len = bytes.len().min(self.precision.unwrap_or(usize::MAX));
		self.field(b"", 0, &bytes[..len], len, utf8, true)
	}

	fn integer(&mut self, kind: u8, size: Size, n: Num) -> Result<(), String> {
		if let Num::Float(f) = n && !f.is_finite() {
			return self.special(f);
		}
		let bits = int_bits(n) as i64;
		let (mut number, mut prefix) = match kind {
			b'd' | b'i' | b'D' => {
				let v = match (kind, size) {
					(b'D', _) | (_, Size::Default) => bits,
					(_, Size::Short) => i64::from(bits as i16),
					(_, Size::Char) => i64::from(bits as i8),
				};
				(v.unsigned_abs(), self.sign(v < 0))
			},
			_ => {
				let v = match (kind, size) {
					(b'U' | b'O', _) | (_, Size::Default) => bits as u64,
					(_, Size::Short) => u64::from(bits as u16),
					(_, Size::Char) => u64::from(bits as u8),
				};
				(v, b"" as &[u8])
			},
		};
		let base = match kind {
			b'b' | b'B' => 2,
			b'o' | b'O' => 8,
			b'x' | b'X' | b'p' => 16,
			_ => 10,
		};
		let alphabet = if kind == b'X' { b"0123456789ABCDEF" } else { b"0123456789abcdef" };
		let nonzero = number != 0;
		let mut scratch = [0; 64];
		let mut start = scratch.len();
		if number != 0 || self.precision != Some(0) {
			loop {
				start -= 1;
				scratch[start] = alphabet[(number % base) as usize];
				number /= base;
				if number == 0 {
					break;
				}
			}
		}
		let bytes = &scratch[start..];
		let mut zeros = self.precision.unwrap_or(0).saturating_sub(bytes.len());
		if self.flags.alternate {
			match kind {
				b'o' | b'O' if bytes.first() != Some(&b'0') => zeros = zeros.max(1),
				b'x' | b'p' if nonzero => prefix = b"0x",
				b'X' if nonzero => prefix = b"0X",
				b'b' if nonzero => prefix = b"0b",
				b'B' if nonzero => prefix = b"0B",
				_ => {},
			}
		}
		self.field(prefix, zeros, bytes, bytes.len(), false, self.precision.is_none())
	}

	fn float(&mut self, n: f64, kind: u8) -> Result<(), String> {
		if !n.is_finite() {
			return self.special(n);
		}
		let sign = self.sign(n.is_sign_negative());
		let magnitude = n.abs();
		let upper = kind.is_ascii_uppercase();
		let precision = self.precision.unwrap_or(6);
		// perl sizes the C snprintf result up front and refuses what an int cannot count.
		let integer_digits = match kind.to_ascii_lowercase() {
			b'f' if magnitude >= 1.0 => (magnitude.log2() as usize + 1) * 146 / 485 + 1,
			b'a' if self.precision.is_none() => 16,
			_ => 0,
		};
		let need = (7 + integer_digits).saturating_add(precision).max(self.width);
		if need > i32::MAX as usize {
			return Err("Numeric format result too large".into());
		}
		let mut prefix = [0; 3];
		prefix[..sign.len()].copy_from_slice(sign);
		let mut prefix_len = sign.len();
		let s = match kind.to_ascii_lowercase() {
			b'a' => {
				prefix[prefix_len..][..2].copy_from_slice(if upper { b"0X" } else { b"0x" });
				prefix_len += 2;
				hex_float(magnitude, self.precision, self.flags.alternate, upper)?
			},
			b'e' => scientific(magnitude, precision, self.flags.alternate, upper)?,
			b'g' => general(magnitude, precision.max(1), self.flags.alternate, upper)?,
			_ => fixed(magnitude, precision, self.flags.alternate)?,
		};
		self.field(&prefix[..prefix_len], 0, s.as_bytes(), s.len(), false, true)
	}
}

const EXACT_DECIMAL_PLACES: usize = 1074;

fn append_zeroes(text: &mut String, n: usize) -> Result<(), String> {
	check_len(text.len().saturating_add(n), "string")?;
	text.try_reserve(n).map_err(|_| OVERFLOW.to_owned())?;
	text.extend(std::iter::repeat_n('0', n));
	Ok(())
}

fn fixed(n: f64, precision: usize, alternate: bool) -> Result<String, String> {
	// A binary64's denominator divides 2^1074. Any further fractional
	// places are zero, so there is no reason to ask dtoa to compute them.
	let significant_places = precision.min(EXACT_DECIMAL_PLACES);
	let mut s = format!("{n:.significant_places$}");
	if alternate && precision == 0 {
		s.push('.');
	}
	append_zeroes(&mut s, precision - significant_places)?;
	Ok(s)
}

fn scientific_parts(n: f64, precision: usize) -> (String, i32) {
	let mut s = format!("{n:.precision$e}");
	if let Some(i) = s.find('e') {
		let exp = s[i + 1..].parse().unwrap_or(0);
		s.truncate(i);
		(s, exp)
	} else {
		(s, 0)
	}
}

fn add_exp(s: &mut String, exp: i32, marker: char, digits: usize) {
	let sign = if exp < 0 { '-' } else { '+' };
	let mag = exp.unsigned_abs();
	let _ = write!(s, "{marker}{sign}{mag:0digits$}");
}

fn scientific(n: f64, precision: usize, alternate: bool, upper: bool) -> Result<String, String> {
	let places = precision.min(EXACT_DECIMAL_PLACES);
	let (mut s, exp) = scientific_parts(n, places);
	if alternate && precision == 0 {
		s.push('.');
	}
	append_zeroes(&mut s, precision - places)?;
	add_exp(&mut s, exp, if upper { 'E' } else { 'e' }, 2);
	Ok(s)
}

fn general(n: f64, precision: usize, alternate: bool, upper: bool) -> Result<String, String> {
	let places = (precision - 1).min(EXACT_DECIMAL_PLACES);
	let (mut s, exp) = scientific_parts(n, places);
	let scientific = exp < -4 || i64::from(exp) >= precision as i64;
	if !scientific {
		let places = if alternate { precision - 1 } else { places };
		s = fixed(n, places.saturating_add_signed(-(exp as isize)), alternate)?;
	}
	if !alternate && s.contains('.') {
		s.truncate(s.trim_end_matches('0').trim_end_matches('.').len());
	} else if alternate && scientific {
		if precision == 1 {
			s.push('.');
		}
		append_zeroes(&mut s, precision - 1 - places)?;
	}
	if scientific {
		add_exp(&mut s, exp, if upper { 'E' } else { 'e' }, 2);
	}
	Ok(s)
}

fn hex_float(n: f64, precision: Option<usize>, alternate: bool, upper: bool) -> Result<String, String> {
	const FRACTION: u64 = (1 << 52) - 1;
	let bits = n.to_bits();
	let biased = (bits >> 52) as i32;
	let (significand, exp) = if biased != 0 {
		((bits & FRACTION) | (1 << 52), biased - 1023)
	} else if bits != 0 {
		// Darwin normalizes subnormal numbers, unlike glibc's %a.
		if cfg!(target_vendor = "apple") {
			let shift = bits.leading_zeros() - 11;
			(bits << shift, -1022 - shift as i32)
		} else {
			(bits, -1022)
		}
	} else {
		(0, 0)
	};
	let digits = precision.unwrap_or(13).min(13);
	let shift = 4 * (13 - digits);
	let mut value = significand >> shift;
	if shift != 0 {
		let half = 1 << (shift - 1);
		let discarded = significand & ((1 << shift) - 1);
		if discarded > half || (discarded == half && value & 1 != 0) {
			value += 1;
		}
	}
	let table = if upper { b"0123456789ABCDEF" } else { b"0123456789abcdef" };
	let mut s = String::new();
	s.push(table[(value >> (4 * digits)) as usize] as char);
	if digits != 0 || alternate {
		s.push('.');
	}
	for i in (0..digits).rev() {
		s.push(table[((value >> (4 * i)) & 15) as usize] as char);
	}
	if let Some(precision) = precision {
		append_zeroes(&mut s, precision - digits)?;
	} else if digits != 0 {
		s.truncate(s.trim_end_matches('0').len());
		if !alternate && s.ends_with('.') {
			s.pop();
		}
	}
	add_exp(&mut s, exp, if upper { 'P' } else { 'p' }, 1);
	Ok(s)
}

fn string(value: Option<Cow<'_, Value>>, cx: &mut dyn Stringify, bytes: bool) -> PStr {
	let mut s = match value {
		Some(Cow::Owned(Value::Str(s))) => s,
		Some(v) => cx.stringify(&v),
		None => PStr::default(),
	};
	if bytes { s.utf8 = false; }
	s
}

/// Formats a Perl argument list, returning fatal conversion errors without source location.
pub(super) fn sprintf(fmt: &PStr, args: &[Value], cx: &mut dyn Stringify) -> Result<PStr, String> {
	let bytes = cx.bytes();
	let fmt_utf8 = fmt.utf8 && !bytes;
	let mut out = PStr::new(Vec::with_capacity(fmt.bytes.len()), fmt_utf8);
	let (mut counted, mut char_count, mut was_utf8) = (0, 0, fmt_utf8);
	let mut args = Arguments { values: args, current: 0, explicit: false, missing: false };
	let mut literal = 0;
	while let Some(offset) = fmt.bytes[literal..].iter().position(|&b| b == b'%') {
		let percent = literal + offset;
		append(&mut out, &fmt.bytes[literal..percent], fmt_utf8);
		let (conversion, end) = match parse(&fmt.bytes, percent + 1)? {
			Parse::Valid(conversion, end) => (conversion, end),
			Parse::Invalid(end) => {
				cx.warn(invalid_warning(&fmt.bytes[percent..end]));
				args.explicit = true; // an unrecognized conversion suppresses the excess-argument warning
				out.bytes.push(b'%');
				literal = percent + 1;
				continue;
			},
		};
		literal = end;
		let Conversion { kind, index, mut flags, separator, width, precision, size } = conversion;
		args.missing = false;
		args.explicit |= index.is_some();
		let separator = if let Some(Field::Argument(index)) = separator {
			Some(string(args.get(index, true, cx), cx, bytes))
		} else {
			None
		};
		let width = args.field(width, cx)?.unwrap_or(0);
		flags.left |= width < 0;
		let precision = args.field(precision, cx)?.and_then(|p| usize::try_from(p).ok());
		if kind == b'n' {
			let index = args.take(index);
			if args.values.get(index).is_none() {
				return Err("Missing argument for %n in sprintf".into());
			}
			if out.utf8 != was_utf8 {
				char_count = out.char_len();
				was_utf8 = true;
			} else if out.utf8 {
				char_count += out.bytes[counted..].iter().filter(|&&b| b & 0xc0 != 0x80).count();
			} else {
				char_count = out.bytes.len();
			}
			counted = out.bytes.len();
			cx.store_count(index, char_count);
			continue;
		}
		let value = if kind != b'%' { args.get(index, kind != b'p', cx) } else { None };
		if args.missing {
			cx.warn("Missing argument in sprintf".into());
		}
		let mut output = Output { out: &mut out, flags, width: width.unsigned_abs() as usize, precision };
		if conversion.separator.is_some() {
			let s = value.as_deref().and_then(|v| cx.vector(v)).unwrap_or_else(|| string(value, cx, bytes));
			let mut at = 0;
			while at < s.bytes.len() {
				let first = at == 0;
				let cp = if s.utf8 {
					let (cp, n, malformed) = sprintf_char(&s.bytes[at..]);
					if let Some(message) = malformed { cx.warn(message); }
					at += n;
					cp
				} else {
					at += 1;
					u64::from(s.bytes[at - 1])
				};
				if !first {
					output.flags.plus = false;
					output.flags.space = false;
					if let Some(separator) = &separator {
						append(output.out, &separator.bytes, separator.utf8);
					} else {
						output.out.bytes.push(b'.');
					}
				}
				output.integer(kind, Size::Default, Num::UInt(cp))?;
			}
		} else {
			match kind {
				b'%' => {
					let percent = if precision == Some(0) { &b""[..] } else { &b"%"[..] };
					output.field(b"", 0, percent, percent.len(), false, true)?;
				},
				b's' => output.string(&string(value, cx, bytes))?,
				b'p' => output.integer(kind, Size::Default, Num::UInt(value.as_deref().map_or(0, |v| std::ptr::from_ref(v).addr() as u64)))?,
				_ => {
					let n = value.map_or(Num::Int(0), |v| number(&v, cx));
					match kind {
						b'c' => output.character(n, bytes)?,
						b'e' | b'E' | b'f' | b'F' | b'g' | b'G' | b'a' | b'A' => output.float(n.to_f64(), kind)?,
						_ => output.integer(kind, size, n)?,
					}
				},
			}
		}
	}
	append(&mut out, &fmt.bytes[literal..], fmt_utf8);
	if !args.explicit && args.current < args.values.len() {
		cx.warn("Redundant argument in sprintf".into());
	}
	Ok(out)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::perl::value::Plain;

	fn format(fmt: &str, values: &[Value]) -> PStr {
		sprintf(&PStr::from_str(fmt), values, &mut Plain).unwrap()
	}

	#[test]
	fn indexed_stars_leave_the_implicit_cursor_alone() {
		let values = [Value::Int(3), Value::Int(5), Value::Int(1)];
		assert_eq!(format("%*2$d %d %2$.*3$d", &values).bytes, b"    3 5 5");
		assert_eq!(format("%*.*Q %d", &values).bytes, b"%*.*Q 3");
	}

	#[test]
	fn dynamic_fields_reject_wrapped_width_and_precision() {
		for pattern in [b"%*s".as_slice(), b"%.*s"] {
			for value in [Value::UInt(u64::MAX), Value::Int(i64::MIN), Value::Int(i64::MAX)] {
				let r = sprintf(&PStr::from_bytes(pattern), &[value, Value::bytes(b"x")], &mut Plain);
				assert_eq!(r.unwrap_err(), OVERFLOW);
			}
		}
	}

	#[test]
	fn script_sized_padding_is_refused() {
		let one = Value::Int(1);
		for (fmt, values) in [
			("%999999999999d", vec![one.clone()]),
			("%20000000000s", vec![one.clone()]),
			("%2$*1$d", vec![Value::Num(1e11), one.clone()]),
			("%v.9999999999d", vec![Value::str("1")]),
			("%v*d", vec![Value::Num(1e12), Value::str("1.2")]),
			("%.9999999999f", vec![one.clone()]),
		] {
			assert!(sprintf(&PStr::from_str(fmt), &values, &mut Plain).is_err(), "{fmt}");
		}
	}

	#[test]
	fn vector_sign_is_printed_only_once() {
		assert_eq!(format("%+-v3d", &[Value::bytes(b"\x01\x02\x03")]).bytes, b"+1 .2  .3  ");
		assert_eq!(format("%+v3d", &[Value::bytes(b"\x01\x02\x00")]).bytes, b" +1.  2.  0");
	}

	#[test]
	fn flags_sizes_vectors_and_unicode() {
		let values = [Value::str(":"), Value::str("éĀ"), Value::Int(65535), Value::Int(0)];
		assert_eq!(format("%0*2$v4X %3$hd %#.0o", &values).bytes, b"003A -1 0");
		assert_eq!(format("%2$*1$vX", &values).bytes, b"E9:100");
		assert_eq!(format("%v04hhd", &values[1..2]).bytes, b"0233.0256");
		assert_eq!(format("<%5.1s>", &values[1..2]), PStr::from_codepoints([60, 32, 32, 32, 32, 233, 62]));
		let c = format("%5c", &[Value::Int(256)]);
		assert!(c.utf8);
		assert_eq!(c.bytes, b"   \xc4\x80");
	}

	#[test]
	fn warnings_preserve_output_and_argument_cursors() {
		#[derive(Default)]
		struct Log(Vec<String>);
		impl Stringify for Log {
			fn stringify(&mut self, value: &Value) -> PStr { value.to_pstr() }
			fn numify(&mut self, value: &Value) -> Num { value.to_num() }
			fn warn(&mut self, msg: String) { self.0.push(msg); }
		}
		let mut log = Log::default();
		assert_eq!(sprintf(&PStr::from_bytes(b"%.0hf/%jf/%llf"), &[Value::Int(1)], &mut log).unwrap().bytes, b"%.0hf/%jf/1.000000");
		assert_eq!(log.0, ["Invalid conversion in sprintf: \"%.0hf\"", "Invalid conversion in sprintf: \"%jf\""]);
		log.0.clear();
		let pattern = PStr::from_str("%*.*Q %d %*.*d");
		let out = sprintf(&pattern, &[Value::str("3p"), Value::Int(2)], &mut log).unwrap();
		assert_eq!(out.bytes, b"%*.*Q 3   ");
		assert_eq!(log.0, [
			"Invalid conversion in sprintf: \"%*.*Q\"",
			"Argument \"3p\" isn't numeric in sprintf",
			"Missing argument in sprintf",
		]);
		log.0.clear();
		sprintf(&PStr::from_str("%%"), &[Value::Int(1)], &mut log).unwrap();
		assert_eq!(log.0, ["Redundant argument in sprintf"]);
	}

	#[test]
	fn stores_the_character_count_and_reads_live_aliases() {
		struct Live { count: Option<usize>, bytes: bool }
		impl Stringify for Live {
			fn stringify(&mut self, v: &Value) -> PStr { v.to_pstr() }
			fn numify(&mut self, v: &Value) -> Num { v.to_num() }
			fn warn(&mut self, _: String) {}
			fn bytes(&self) -> bool { self.bytes }
			fn arg(&mut self, _: usize) -> Option<Value> { self.count.map(|n| Value::Int(n as i64)) }
			fn store_count(&mut self, _: usize, count: usize) { self.count = Some(count); }
		}
		let pattern = PStr::from_str("é%n%d");
		let args = [Value::Undef, Value::Undef];
		let mut hooks = Live { count: None, bytes: false };
		assert_eq!(sprintf(&pattern, &args, &mut hooks).unwrap().bytes, b"\xc3\xa91");
		assert_eq!(hooks.count, Some(1));
		hooks = Live { count: None, bytes: true };
		assert_eq!(sprintf(&pattern, &args, &mut hooks).unwrap().bytes, b"\xc3\xa92");
		assert_eq!(hooks.count, Some(2));
		assert_eq!(sprintf(&PStr::from_bytes(b"%c"), &[Value::Int(0x263a)], &mut Live { count: None, bytes: true }).unwrap().bytes, b":");
	}

	#[test]
	fn formats_decimal_and_hex_floats() {
		let values = [Value::Num(2.5), Value::Num(3.5), Value::Num(-0.5), Value::Num(999.9), Value::Num(1.5), Value::Num(f64::INFINITY)];
		assert_eq!(format("%.0f %.0f %.0f %.3g %#.0A %+010f", &values).bytes, b"2 4 -0 1e+03 0X2.P+0 000000+Inf");
		assert_eq!(sprintf(&PStr::from_str("%n"), &[], &mut Plain), Err("Missing argument for %n in sprintf".into()));
	}
}
