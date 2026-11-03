//! `printf`'s floating-point arguments as bash reads and writes them: bash
//! converts them with `strtold` and prints them with `%Le`, `%Lf`, `%Lg` and
//! `%La`, so their value is a C `long double` and their digits are glibc's
//! exact decimal (or hexadecimal) expansion of it. An `f64` and Rust's own
//! formatting would change both: `printf '%.25f' 0.1` is
//! `0.1000000000000000000013553` in bash on x86-64, and `1e400` is finite.
//!
//! Where a C `long double` is the x87 80-bit format (x86 and x86-64, except
//! MSVC), that format is emulated here: 64 significant bits and exponents
//! from -16382 to 16383. Elsewhere it is taken to be an IEEE double, which
//! is what it is on macOS on arm64 and on Windows; a target whose `long
//! double` is IEEE quadruple precision (Linux on arm64) is printed with an
//! IEEE double's precision.

use std::cmp::Ordering;

/// Significant bits of a C `long double`.
#[cfg(all(any(target_arch = "x86", target_arch = "x86_64"), not(target_env = "msvc")))]
const BITS: u32 = 64;
#[cfg(not(all(any(target_arch = "x86", target_arch = "x86_64"), not(target_env = "msvc"))))]
const BITS: u32 = 53;

/// The binary exponent of the smallest normal value (its leading bit).
#[cfg(all(any(target_arch = "x86", target_arch = "x86_64"), not(target_env = "msvc")))]
const MIN_EXP: i32 = -16382;
#[cfg(not(all(any(target_arch = "x86", target_arch = "x86_64"), not(target_env = "msvc"))))]
const MIN_EXP: i32 = -1022;

/// The binary exponent of the largest finite value (its leading bit).
#[cfg(all(any(target_arch = "x86", target_arch = "x86_64"), not(target_env = "msvc")))]
const MAX_EXP: i32 = 16383;
#[cfg(not(all(any(target_arch = "x86", target_arch = "x86_64"), not(target_env = "msvc"))))]
const MAX_EXP: i32 = 1023;

/// The exponent of a value's last significant bit, smallest (subnormal)
/// and largest: a finite value is `mant * 2^exp` with `mant < 2^BITS`.
const LOW_EXP: i32 = MIN_EXP - (BITS as i32 - 1);
const HIGH_EXP: i32 = MAX_EXP - (BITS as i32 - 1);

/// A `long double`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Float {
	pub neg:  bool,
	pub kind: Kind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
	Zero,
	/// `mant * 2^exp`, with `mant` below `2^BITS` and at least
	/// `2^(BITS-1)` unless `exp` is [`LOW_EXP`] (a subnormal).
	Finite {
		mant: u128,
		exp:  i32,
	},
	Inf,
	Nan,
}

impl Float {
	/// The character code bash reads from a `'c` argument.
	pub fn from_code(code: i64) -> Self {
		let neg = code < 0;
		let mant = u128::from(code.unsigned_abs());
		Self { neg, kind: finite(mant, 0) }
	}

	pub const fn is_finite(&self) -> bool {
		matches!(self.kind, Kind::Zero | Kind::Finite { .. })
	}

	/// The value as an IEEE double (exact where `long double` is one).
	#[cfg(not(all(any(target_arch = "x86", target_arch = "x86_64"), not(target_env = "msvc"))))]
	pub fn to_f64(self) -> f64 {
		let v = match self.kind {
			Kind::Zero => 0.0,
			Kind::Inf => f64::INFINITY,
			Kind::Nan => f64::NAN,
			Kind::Finite { mant, exp } => {
				let mut v = mant as f64;
				let mut left = exp;
				while left != 0 {
					let step = left.clamp(-1000, 1000);
					v *= 2f64.powi(step);
					left -= step;
				}
				v
			},
		};
		if self.neg { -v } else { v }
	}
}

/// `mant * 2^exp` normalized so that its leading bit is the format's.
fn finite(mut mant: u128, mut exp: i32) -> Kind {
	if mant == 0 {
		return Kind::Zero;
	}
	let shift = BITS.saturating_sub(128 - mant.leading_zeros());
	let shift = i32::try_from(shift).unwrap_or(0).min(exp - LOW_EXP).max(0);
	mant <<= shift;
	exp -= shift;
	Kind::Finite { mant, exp }
}

/// C `isspace`.
const fn c_space(c: u8) -> bool {
	matches!(c, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r')
}

/// C `strtold` over a prefix of `arg`: the value, the bytes converted (0
/// for none) and whether it overflowed or underflowed (`ERANGE`): a result
/// too large is infinite, one that rounds to zero or to an inexact
/// subnormal is too small.
pub fn strtold(arg: &[u8]) -> (Float, usize, bool) {
	let mut at = 0;
	while at < arg.len() && c_space(arg[at]) {
		at += 1;
	}
	let mut neg = false;
	if let Some(&sign @ (b'+' | b'-')) = arg.get(at) {
		neg = sign == b'-';
		at += 1;
	}
	let body = &arg[at..];
	let starts =
		|word: &[u8]| body.len() >= word.len() && body[..word.len()].eq_ignore_ascii_case(word);
	if starts(b"inf") {
		let len = if starts(b"infinity") { 8 } else { 3 };
		return (Float { neg, kind: Kind::Inf }, at + len, false);
	}
	if starts(b"nan") {
		let mut len = 3;
		if body.get(3) == Some(&b'(') {
			let inner = body[4..]
				.iter()
				.take_while(|&&b| b.is_ascii_alphanumeric() || b == b'_')
				.count();
			if body.get(4 + inner) == Some(&b')') {
				len = 5 + inner;
			}
		}
		return (Float { neg, kind: Kind::Nan }, at + len, false);
	}
	let hex = body.len() > 2
		&& body[0] == b'0'
		&& matches!(body[1], b'x' | b'X')
		&& (body[2].is_ascii_hexdigit()
			|| (body[2] == b'.' && body.get(3).is_some_and(u8::is_ascii_hexdigit)));
	let (digits, scale, end, radix) = if hex {
		let (digits, frac, end) = mantissa(&body[2..], 16);
		let (exp, end) = exponent(&body[2..], end, b'p');
		let scale = exp.saturating_sub(4i64.saturating_mul(frac as i64));
		(digits, scale, end + 2, 16)
	} else {
		let (digits, frac, end) = mantissa(body, 10);
		if end == 0 {
			return (Float { neg, kind: Kind::Zero }, 0, false);
		}
		let (exp, end) = exponent(body, end, b'e');
		(digits, exp.saturating_sub(frac as i64), end, 10)
	};
	let (kind, erange) = value(&digits, radix, scale);
	(Float { neg, kind }, at + end, erange)
}

/// The digits of a mantissa in `radix` (with one point): their values with
/// leading zeros dropped, how many came after the point, and the bytes
/// used (0 when there is no digit).
fn mantissa(s: &[u8], radix: u32) -> (Vec<u8>, usize, usize) {
	let mut digits = Vec::new();
	let mut frac = 0;
	let mut seen = 0;
	let mut point = false;
	let mut i = 0;
	while let Some(&c) = s.get(i) {
		if c == b'.' && !point {
			point = true;
			i += 1;
			continue;
		}
		let Some(d) = char::from(c).to_digit(radix) else {
			break;
		};
		seen += 1;
		if point {
			frac += 1;
		}
		if d != 0 || !digits.is_empty() {
			digits.push(d as u8);
		}
		i += 1;
	}
	if seen == 0 {
		return (digits, 0, 0);
	}
	(digits, frac, i)
}

/// An exponent (`e`/`p`, a sign, decimal digits) at `end`, saturated; it is
/// taken only with at least one digit.
fn exponent(s: &[u8], end: usize, marker: u8) -> (i64, usize) {
	if s.get(end).map(u8::to_ascii_lowercase) != Some(marker) {
		return (0, end);
	}
	let mut at = end + 1;
	let neg = s.get(at) == Some(&b'-');
	if matches!(s.get(at), Some(b'+' | b'-')) {
		at += 1;
	}
	let start = at;
	let mut v: i64 = 0;
	while let Some(&c @ b'0'..=b'9') = s.get(at) {
		v = v.saturating_mul(10).saturating_add(i64::from(c - b'0'));
		at += 1;
	}
	if at == start {
		return (0, end);
	}
	(if neg { -v } else { v }, at)
}

/// The `long double` nearest `digits * radix^scale` (`radix` 10), or
/// `digits * 2^scale` (`radix` 16, whose digits are hexadecimal), ties to
/// even, and whether it is out of range.
fn value(digits: &[u8], radix: u32, scale: i64) -> (Kind, bool) {
	if digits.is_empty() {
		return (Kind::Zero, false);
	}
	let n = digits.len() as i64;
	// Magnitude bounds, with a margin: past them the value is infinite or
	// rounds to zero whatever the digits, and the exact arithmetic below
	// would only be slower.
	let (high, low) = if radix == 10 {
		// Decimal exponents: log10(2) is 0.30103 to five places.
		let top = (n - 1).saturating_add(scale);
		let max = i64::from(MAX_EXP) * 30_103 / 100_000;
		let min = i64::from(LOW_EXP) * 30_103 / 100_000;
		(top > max + 2, top < min - 2)
	} else {
		let top = (4 * n).saturating_add(scale);
		(top > i64::from(MAX_EXP) + 8, top < i64::from(LOW_EXP) - 8)
	};
	if high {
		return (Kind::Inf, true);
	}
	if low {
		return (Kind::Zero, true);
	}
	let mut num = Big::from_digits(digits, radix);
	let mut den = Big::from(1);
	if radix == 10 {
		let ten = Big::pow5(scale.unsigned_abs());
		if scale >= 0 {
			num = num.mul(&ten);
			num.shl(scale.unsigned_abs());
		} else {
			den = ten;
			den.shl(scale.unsigned_abs());
		}
	} else if scale >= 0 {
		num.shl(scale.unsigned_abs());
	} else {
		den.shl(scale.unsigned_abs());
	}
	round(num, den)
}

/// `num / den` (positive) rounded to a `long double`, ties to even.
fn round(num: Big, den: Big) -> (Kind, bool) {
	// A first exponent that leaves BITS + 1 or BITS + 2 quotient bits.
	let mut exp = num.bits() as i64 - den.bits() as i64 - i64::from(BITS) - 1;
	let (q, rest) = divide(&num, &den, exp);
	// Drop the quotient's extra bits, and those a subnormal cannot hold.
	let mut drop = i64::from(128 - q.leading_zeros()) - i64::from(BITS);
	if exp + drop < i64::from(LOW_EXP) {
		drop = i64::from(LOW_EXP) - exp;
	}
	exp += drop;
	let (mut mant, round_bit, sticky) = if drop <= 0 {
		(q << (-drop), false, rest)
	} else if drop > 127 {
		(0, false, true)
	} else {
		let shift = drop as u32;
		let kept = q >> shift;
		let half = (q >> (shift - 1)) & 1 == 1;
		let below = q & ((1u128 << (shift - 1)) - 1) != 0;
		(kept, half, below || rest)
	};
	let inexact = round_bit || sticky;
	if round_bit && (sticky || mant & 1 == 1) {
		mant += 1;
		if mant >> BITS != 0 {
			mant >>= 1;
			exp += 1;
		}
	}
	if exp > i64::from(HIGH_EXP) {
		return (Kind::Inf, true);
	}
	if mant == 0 {
		return (Kind::Zero, true);
	}
	let subnormal = mant >> (BITS - 1) == 0;
	(Kind::Finite { mant, exp: exp as i32 }, subnormal && inexact)
}

/// `floor(num / (den * 2^exp))` (at most BITS + 2 bits) and whether a
/// remainder is left.
fn divide(num: &Big, den: &Big, exp: i64) -> (u128, bool) {
	let mut n = num.clone();
	let mut d = den.clone();
	if exp >= 0 {
		d.shl(exp.unsigned_abs());
	} else {
		n.shl(exp.unsigned_abs());
	}
	let top = BITS + 2;
	d.shl(u64::from(top));
	let mut q: u128 = 0;
	for bit in (0..=top).rev() {
		if n.cmp(&d) != Ordering::Less {
			n.sub(&d);
			q |= 1u128 << bit;
		}
		d.shr1();
	}
	(q, !n.is_zero())
}

/// What one conversion writes for a value, without its sign: `prefix`
/// (`0x`), `body`, `zeros` more zeros, then `tail` (an exponent).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Text {
	pub prefix: &'static [u8],
	pub body:   Vec<u8>,
	pub zeros:  usize,
	pub tail:   Vec<u8>,
}

impl Text {
	pub const fn len(&self) -> usize {
		self.prefix.len() + self.body.len() + self.zeros + self.tail.len()
	}
}

/// glibc's `%e %f %g %a` (`conv`, either case) of `v` without its sign;
/// `point` is the locale's decimal point.
pub fn format(v: &Float, conv: u8, alt: bool, prec: Option<usize>, point: u8) -> Text {
	let upper = conv.is_ascii_uppercase();
	let mut text = match v.kind {
		Kind::Inf => Text { body: b"inf".to_vec(), ..Text::default() },
		Kind::Nan => Text { body: b"nan".to_vec(), ..Text::default() },
		_ => match conv.to_ascii_lowercase() {
			b'f' => fixed(v.kind, prec.unwrap_or(6), alt, point),
			b'e' => scientific(v.kind, prec.unwrap_or(6), alt, point),
			b'g' => general(v.kind, prec, alt, point),
			_ => hexadecimal(v, prec, alt, point),
		},
	};
	if upper {
		text.prefix = if text.prefix.is_empty() { b"" } else { b"0X" };
		text.body.make_ascii_uppercase();
		text.tail.make_ascii_uppercase();
	}
	text
}

/// The exact decimal digits of a finite value (no leading zero) and how
/// many of them follow the point.
fn exact(kind: Kind) -> (Vec<u8>, usize) {
	let Kind::Finite { mant, exp } = kind else {
		return (b"0".to_vec(), 0);
	};
	let mut n = Big::from(mant);
	if exp >= 0 {
		n.shl(u64::from(exp.unsigned_abs()));
		(n.decimal(), 0)
	} else {
		let k = exp.unsigned_abs();
		n = n.mul(&Big::pow5(u64::from(k)));
		(n.decimal(), k as usize)
	}
}

/// `digits` rounded to their first `keep` (fewer than all), ties to even;
/// one more digit (`1000…`) when the rounding carries out.
fn round_digits(digits: &[u8], keep: usize) -> Vec<u8> {
	let mut out = digits[..keep].to_vec();
	let next = digits[keep];
	let rest = digits[keep + 1..].iter().any(|&d| d != b'0');
	let odd = out.last().is_some_and(|d| (d - b'0') % 2 == 1);
	let up = next > b'5' || (next == b'5' && (rest || odd));
	if up {
		let mut i = out.len();
		loop {
			if i == 0 {
				out.insert(0, b'1');
				break;
			}
			i -= 1;
			if out[i] == b'9' {
				out[i] = b'0';
			} else {
				out[i] += 1;
				break;
			}
		}
	}
	out
}

/// The value rounded to `places` after the point: its digits and how many
/// zeros follow them (all after the point).
fn rounded_fixed(kind: Kind, places: usize) -> (Vec<u8>, usize) {
	let (digits, frac) = exact(kind);
	let whole = digits.len() as i64 - frac as i64;
	let keep = whole.saturating_add(places as i64);
	if keep >= digits.len() as i64 {
		return (digits, places - frac);
	}
	if keep < 0 {
		return (b"0".to_vec(), 0);
	}
	let digits = round_digits(&digits, keep as usize);
	let digits = if digits.iter().all(|&d| d == b'0') {
		b"0".to_vec()
	} else {
		digits
	};
	(digits, 0)
}

/// `%f` with `places` after the point.
fn fixed(kind: Kind, places: usize, alt: bool, point: u8) -> Text {
	let (digits, zeros) = rounded_fixed(kind, places);
	// The value times 10^places is `digits` then `zeros` zeros; the last
	// `places` of those follow the point (`zeros` never exceeds `places`).
	let len = digits.len() + zeros;
	let mut body = Vec::with_capacity(digits.len() + 2);
	if len > places {
		let int = len - places;
		body.extend_from_slice(&digits[..int]);
		if places > 0 || alt {
			body.push(point);
		}
		body.extend_from_slice(&digits[int..]);
	} else {
		body.push(b'0');
		body.push(point);
		body.resize(body.len() + (places - len), b'0');
		body.extend_from_slice(&digits);
	}
	Text { body, zeros, ..Text::default() }
}

/// The first `count` significant digits of a finite value, rounded, the
/// zeros past its exact digits, and its decimal exponent.
fn significant(kind: Kind, count: usize) -> (Vec<u8>, usize, i64) {
	if kind == Kind::Zero {
		return (b"0".to_vec(), count - 1, 0);
	}
	let (digits, frac) = exact(kind);
	let mut exp = digits.len() as i64 - 1 - frac as i64;
	if count >= digits.len() {
		let zeros = count - digits.len();
		return (digits, zeros, exp);
	}
	let mut digits = round_digits(&digits, count);
	if digits.len() > count {
		digits.truncate(count);
		exp += 1;
	}
	(digits, 0, exp)
}

/// `e±dd`: at least two exponent digits.
fn exponent_text(marker: u8, exp: i64) -> Vec<u8> {
	let mut out = vec![marker, if exp < 0 { b'-' } else { b'+' }];
	let digits = exp.unsigned_abs().to_string();
	if digits.len() < 2 {
		out.push(b'0');
	}
	out.extend_from_slice(digits.as_bytes());
	out
}

/// `%e` with `places` after the point.
fn scientific(kind: Kind, places: usize, alt: bool, point: u8) -> Text {
	let (digits, zeros, exp) = significant(kind, places.saturating_add(1));
	let mut body = vec![digits[0]];
	if places > 0 || alt {
		body.push(point);
	}
	body.extend_from_slice(&digits[1..]);
	Text { body, zeros, tail: exponent_text(b'e', exp), ..Text::default() }
}

/// `%g`: `%e` or `%f` with `prec` significant digits, trailing zeros
/// dropped without `#`.
fn general(kind: Kind, prec: Option<usize>, alt: bool, point: u8) -> Text {
	let p = prec.map_or(6, |p| p.max(1));
	let exp = if kind == Kind::Zero {
		0
	} else {
		significant(kind, p).2
	};
	let mut text = if exp < -4 || exp >= p as i64 {
		scientific(kind, p - 1, alt, point)
	} else {
		fixed(kind, (p as i64 - 1 - exp) as usize, alt, point)
	};
	if !alt {
		text.zeros = 0;
		if text.body.contains(&point) {
			while text.body.last() == Some(&b'0') {
				text.body.pop();
			}
			if text.body.last() == Some(&point) {
				text.body.pop();
			}
		}
	}
	text
}

/// `%a` as glibc writes a `long double`: on x87 the first hexadecimal digit
/// holds the significand's top four bits (`0x8p-3` is 1), the other 15
/// digits the rest.
#[cfg(all(any(target_arch = "x86", target_arch = "x86_64"), not(target_env = "msvc")))]
fn hexadecimal(v: &Float, prec: Option<usize>, alt: bool, point: u8) -> Text {
	const DIGITS: usize = 15;
	let (lead, mut digits, mut exp) = match v.kind {
		Kind::Finite { mant, exp } => {
			let digits = format!("{:015x}", mant & ((1u128 << 60) - 1));
			((mant >> 60) as u8, digits.into_bytes(), i64::from(exp) + 60)
		},
		_ => (0, vec![b'0'; DIGITS], 0),
	};
	let mut lead = lead;
	let mut zeros = 0;
	match prec {
		None => {
			while digits.last() == Some(&b'0') {
				digits.pop();
			}
		},
		Some(p) if p < DIGITS => {
			let Kind::Finite { mant, .. } = v.kind else {
				digits.truncate(p);
				return hex_text(lead, &digits, 0, 0, alt, prec, point);
			};
			let drop = 60 - 4 * p as u32;
			let mut kept = mant >> drop;
			let half = (mant >> (drop - 1)) & 1 == 1;
			let below = mant & ((1u128 << (drop - 1)) - 1) != 0;
			if half && (below || kept & 1 == 1) {
				kept += 1;
			}
			if kept >> (4 * p as u32) >= 16 {
				// The leading digit carried out of a hexadecimal digit.
				lead = 1;
				exp += 4;
				digits = vec![b'0'; p];
			} else {
				lead = (kept >> (4 * p as u32)) as u8;
				let low = kept & ((1u128 << (4 * p as u32)) - 1);
				digits = if p == 0 {
					Vec::new()
				} else {
					format!("{low:0p$x}").into_bytes()
				};
			}
		},
		Some(p) => zeros = p - DIGITS,
	}
	hex_text(lead, &digits, zeros, exp, alt, prec, point)
}

/// `%a` of an IEEE double as the C library writes it: `0x1.…p±e`.
#[cfg(not(all(any(target_arch = "x86", target_arch = "x86_64"), not(target_env = "msvc"))))]
fn hexadecimal(v: &Float, prec: Option<usize>, alt: bool, point: u8) -> Text {
	const DIGITS: usize = 13;
	let value = v.to_f64().abs();
	if value == 0.0 {
		let zeros = prec.unwrap_or(0);
		return hex_text(0, &[], zeros, 0, alt, prec, point);
	}
	let bits = value.to_bits();
	let raw_exp = ((bits >> 52) & 0x7ff) as i32;
	let stored = bits & ((1u64 << 52) - 1);
	let (frac, mut exp) = if raw_exp == 0 {
		let shift = stored.leading_zeros() as i32 - 11;
		((stored << shift) & ((1u64 << 52) - 1), -1022 - shift)
	} else {
		(stored, raw_exp - 1023)
	};
	let mut lead = 1u8;
	let mut zeros = 0;
	let digits = match prec {
		Some(p) if p < DIGITS => {
			let drop = 52 - 4 * p as u32;
			let mut kept = frac >> drop;
			let rest = frac & ((1u64 << drop) - 1);
			let half = 1u64 << (drop - 1);
			if rest > half || (rest == half && kept & 1 == 1) {
				kept += 1;
			}
			if kept >> (4 * p as u32) != 0 {
				lead += 1;
				kept &= (1u64 << (4 * p as u32)) - 1;
			}
			if p == 0 {
				Vec::new()
			} else {
				format!("{kept:0p$x}").into_bytes()
			}
		},
		Some(p) => {
			zeros = p - DIGITS;
			format!("{frac:013x}").into_bytes()
		},
		None => {
			let mut s = format!("{frac:013x}").into_bytes();
			while s.last() == Some(&b'0') {
				s.pop();
			}
			s
		},
	};
	if lead == 2 {
		lead = 1;
		exp += 1;
	}
	hex_text(lead, &digits, zeros, i64::from(exp), alt, prec, point)
}

/// `0x` + lead digit + point + digits + zeros + `p±exp`.
fn hex_text(
	lead: u8,
	digits: &[u8],
	zeros: usize,
	exp: i64,
	alt: bool,
	prec: Option<usize>,
	point: u8,
) -> Text {
	let mut body = vec![b"0123456789abcdef"[usize::from(lead)]];
	if alt || !digits.is_empty() || zeros > 0 || prec.is_some_and(|p| p > 0) {
		body.push(point);
	}
	body.extend_from_slice(digits);
	let mut tail = vec![b'p', if exp < 0 { b'-' } else { b'+' }];
	tail.extend_from_slice(exp.unsigned_abs().to_string().as_bytes());
	Text { prefix: b"0x", body, zeros, tail }
}

/// An unsigned integer in base 2^32, least significant limb first, with
/// no high zero limb.
#[derive(Clone, Debug)]
struct Big(Vec<u32>);

impl From<u128> for Big {
	fn from(mut v: u128) -> Self {
		let mut limbs = Vec::new();
		while v != 0 {
			limbs.push(v as u32);
			v >>= 32;
		}
		Self(limbs)
	}
}

impl Big {
	/// Digits (values below `radix`) most significant first.
	fn from_digits(digits: &[u8], radix: u32) -> Self {
		// Several digits per multiplication: 9 decimal or 7 hexadecimal
		// digits fit a limb.
		let per = if radix == 10 { 9 } else { 7 };
		let mut n = Self(Vec::new());
		for chunk in digits.chunks(per) {
			let mut scale = 1u32;
			let mut add = 0u32;
			for &d in chunk {
				scale *= radix;
				add = add * radix + u32::from(d);
			}
			n.mul_small(scale);
			n.add_small(add);
		}
		n
	}

	/// `5^k`.
	fn pow5(k: u64) -> Self {
		let mut n = Self::from(1);
		let mut left = k;
		while left > 0 {
			let step = left.min(13);
			n.mul_small(5u32.pow(step as u32));
			left -= step;
		}
		n
	}

	const fn is_zero(&self) -> bool {
		self.0.is_empty()
	}

	fn bits(&self) -> u64 {
		self
			.0
			.last()
			.map_or(0, |&top| self.0.len() as u64 * 32 - u64::from(top.leading_zeros()))
	}

	fn mul_small(&mut self, m: u32) {
		let mut carry = 0u64;
		for limb in &mut self.0 {
			let v = u64::from(*limb) * u64::from(m) + carry;
			*limb = v as u32;
			carry = v >> 32;
		}
		if carry != 0 {
			self.0.push(carry as u32);
		}
		self.trim();
	}

	fn add_small(&mut self, a: u32) {
		let mut carry = u64::from(a);
		for limb in &mut self.0 {
			if carry == 0 {
				return;
			}
			let v = u64::from(*limb) + carry;
			*limb = v as u32;
			carry = v >> 32;
		}
		if carry != 0 {
			self.0.push(carry as u32);
		}
	}

	fn mul(&self, other: &Self) -> Self {
		let mut out = vec![0u32; self.0.len() + other.0.len()];
		for (i, &a) in self.0.iter().enumerate() {
			let mut carry = 0u64;
			for (j, &b) in other.0.iter().enumerate() {
				let v = u64::from(a) * u64::from(b) + u64::from(out[i + j]) + carry;
				out[i + j] = v as u32;
				carry = v >> 32;
			}
			let mut k = i + other.0.len();
			while carry != 0 {
				let v = u64::from(out[k]) + carry;
				out[k] = v as u32;
				carry = v >> 32;
				k += 1;
			}
		}
		let mut n = Self(out);
		n.trim();
		n
	}

	fn shl(&mut self, bits: u64) {
		if self.is_zero() {
			return;
		}
		let limbs = (bits / 32) as usize;
		let shift = (bits % 32) as u32;
		if shift != 0 {
			let mut carry = 0u32;
			for limb in &mut self.0 {
				let v = (*limb << shift) | carry;
				carry = *limb >> (32 - shift);
				*limb = v;
			}
			if carry != 0 {
				self.0.push(carry);
			}
		}
		self.0.splice(0..0, std::iter::repeat_n(0, limbs));
	}

	fn shr1(&mut self) {
		let mut carry = 0u32;
		for limb in self.0.iter_mut().rev() {
			let v = (*limb >> 1) | (carry << 31);
			carry = *limb & 1;
			*limb = v;
		}
		self.trim();
	}

	fn cmp(&self, other: &Self) -> Ordering {
		self
			.0
			.len()
			.cmp(&other.0.len())
			.then_with(|| self.0.iter().rev().cmp(other.0.iter().rev()))
	}

	/// `self -= other`, with `other <= self`.
	fn sub(&mut self, other: &Self) {
		let mut borrow = 0i64;
		for (i, limb) in self.0.iter_mut().enumerate() {
			let v = i64::from(*limb) - i64::from(other.0.get(i).copied().unwrap_or(0)) - borrow;
			borrow = i64::from(v < 0);
			*limb = (v + (borrow << 32)) as u32;
		}
		self.trim();
	}

	fn trim(&mut self) {
		while self.0.last() == Some(&0) {
			self.0.pop();
		}
	}

	/// Decimal digits, most significant first (`0` for zero).
	fn decimal(&self) -> Vec<u8> {
		if self.is_zero() {
			return b"0".to_vec();
		}
		let mut n = self.0.clone();
		let mut chunks = Vec::new();
		while !n.is_empty() {
			let mut rem = 0u64;
			for limb in n.iter_mut().rev() {
				let v = (rem << 32) | u64::from(*limb);
				*limb = (v / 1_000_000_000) as u32;
				rem = v % 1_000_000_000;
			}
			while n.last() == Some(&0) {
				n.pop();
			}
			chunks.push(rem as u32);
		}
		let mut out = chunks.pop().unwrap_or(0).to_string().into_bytes();
		for chunk in chunks.iter().rev() {
			out.extend_from_slice(format!("{chunk:09}").as_bytes());
		}
		out
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn show(arg: &str, conv: u8, alt: bool, prec: Option<usize>) -> String {
		let (v, ..) = strtold(arg.as_bytes());
		let t = format(&v, conv, alt, prec, b'.');
		let mut s = String::from(if v.neg { "-" } else { "" });
		s.push_str(std::str::from_utf8(t.prefix).unwrap());
		s.push_str(std::str::from_utf8(&t.body).unwrap());
		s.push_str(&"0".repeat(t.zeros));
		s.push_str(std::str::from_utf8(&t.tail).unwrap());
		s
	}

	// Goldens: bash 5.2.21 and 5.3.20 on x86-64 Linux (glibc 2.39).
	#[cfg(all(any(target_arch = "x86", target_arch = "x86_64"), not(target_env = "msvc")))]
	#[test]
	fn long_double_digits_match_glibc() {
		assert_eq!(show("0.1", b'f', false, Some(25)), "0.1000000000000000000013553");
		assert_eq!(show("0.1", b'a', false, None), "0xc.ccccccccccccccdp-7");
		assert_eq!(show("1", b'a', false, None), "0x8p-3");
		assert_eq!(show("0", b'a', false, None), "0x0p+0");
		assert_eq!(show("0x1p-16445", b'a', false, None), "0x0.000000000000001p-16385");
		assert_eq!(show("0xf.8p0", b'a', false, Some(0)), "0x1p+4");
		assert_eq!(show("0x1.ffp0", b'a', false, Some(1)), "0x1.0p+1");
		assert_eq!(show("255", b'A', false, None), "0XF.FP+4");
		assert_eq!(show("1", b'a', true, Some(0)), "0x8.p-3");
		assert_eq!(show("1e400", b'e', false, Some(20)), "1.00000000000000000003e+400");
		assert_eq!(show("0.1", b'g', false, Some(30)), "0.100000000000000000001355252716");
		assert_eq!(show("9.9995", b'e', false, Some(3)), "1.000e+01");
		assert_eq!(show("0x1p-16445", b'g', false, None), "3.6452e-4951");
		assert_eq!(show("0.5", b'f', false, Some(0)), "0");
		assert_eq!(show("2.5", b'f', false, Some(0)), "2");
		assert_eq!(show("1.5", b'f', false, Some(0)), "2");
		assert_eq!(show("-0", b'f', false, None), "-0.000000");
		assert_eq!(show("999999.5", b'g', false, None), "1e+06");
		assert_eq!(show("1", b'g', true, None), "1.00000");
		assert_eq!(show("100000", b'g', false, None), "100000");
		assert_eq!(show("0.0001234", b'g', false, None), "0.0001234");
		assert_eq!(show("1", b'e', true, Some(0)), "1.e+00");
	}

	// Goldens: bash 5.2.21 on x86-64 Linux: which arguments set `ERANGE`.
	#[cfg(all(any(target_arch = "x86", target_arch = "x86_64"), not(target_env = "msvc")))]
	#[test]
	fn range_follows_strtold() {
		assert!(strtold(b"1e-4940").2);
		assert!(!strtold(b"0x1p-16445").2);
		assert!(strtold(b"0x1p-16446").2);
		assert!(strtold(b"1e5000").2);
		assert!(!strtold(b"1e400").2);
		assert!(!strtold(b"0x1.fffffffffffffffep16383").2);
		assert!(strtold(b"0x1.ffffffffffffffffp16383").2);
	}

	// Goldens: bash 5.3.20 on macOS (arm64, whose `long double` is an IEEE
	// double) `printf '%e %g %G %#g %05.1f %-8.3e| %.0e %#.0f %a %A %.2a
	// %10.1a %a'`.
	#[cfg(not(all(any(target_arch = "x86", target_arch = "x86_64"), not(target_env = "msvc"))))]
	#[test]
	fn double_digits_match_the_c_library() {
		assert_eq!(show("0", b'e', false, None), "0.000000e+00");
		assert_eq!(show("1e100", b'g', false, None), "1e+100");
		assert_eq!(show("1e-10", b'G', false, None), "1E-10");
		assert_eq!(show("2.345", b'f', false, Some(1)), "2.3");
		assert_eq!(show("12345.678", b'e', false, Some(3)), "1.235e+04");
		assert_eq!(show("3", b'f', true, Some(0)), "3.");
		assert_eq!(show("1", b'a', false, None), "0x1p+0");
		assert_eq!(show("255", b'A', false, None), "0X1.FEP+7");
		assert_eq!(show("1", b'a', false, Some(2)), "0x1.00p+0");
		assert_eq!(show("3.3", b'a', false, Some(1)), "0x1.ap+1");
		assert_eq!(show("0.1", b'a', false, None), "0x1.999999999999ap-4");
		assert_eq!(show("1e-320", b'a', false, None), "0x1.fap-1064");
		assert_eq!(show("inf", b'f', false, None), "inf");
		assert_eq!(show("nan", b'F', false, None), "NAN");
	}

	#[test]
	fn prefixes_follow_strtold() {
		assert_eq!(strtold(b"1e2x").1, 3);
		assert_eq!(strtold(b"1e").1, 1);
		assert_eq!(strtold(b"0x1p2junk").1, 5);
		assert_eq!(strtold(b"0x1p").1, 3);
		assert_eq!(strtold(b"0x").1, 1);
		assert_eq!(strtold(b"0x.p1").1, 1);
		assert_eq!(strtold(b"1.2.3").1, 3);
		assert_eq!(strtold(b" \r-.5e1x").1, 7);
		assert_eq!(strtold(b"nan(a-1)").1, 3);
		assert_eq!(strtold(b"nan(a_1)").1, 8);
		assert_eq!(strtold(b"infinit").1, 3);
		assert_eq!(strtold(b".").1, 0);
	}
}
