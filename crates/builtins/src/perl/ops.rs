//! Perl's pure scalar operators, specified in perlop and perlnumber.

use std::{borrow::Cow, cmp::Ordering};

use super::value::{Num, PStr, U64_LIMIT, Value};

fn exact_integer(n: Num) -> Option<i128> {
	match n {
		Num::Int(i) => Some(i128::from(i)),
		Num::UInt(u) => Some(i128::from(u)),
		Num::Float(_) => None,
	}
}

fn native_integer(i: i128) -> Option<Num> {
	if let Ok(i) = i64::try_from(i) {
		Some(Num::Int(i))
	} else {
		Some(Num::UInt(u64::try_from(i).ok()?))
	}
}

fn integer_pair(a: Num, b: Num) -> Option<(i128, i128)> {
	Some((exact_integer(a)?, exact_integer(b)?))
}

/// Add two numbers, promoting beyond IV/UV to NV.
#[inline]
pub(in crate::perl) fn add(a: Num, b: Num) -> Num {
	if let (Num::Int(a), Num::Int(b)) = (a, b) && let Some(n) = a.checked_add(b) { return Num::Int(n); }
	integer_pair(a, b)
		.and_then(|(a, b)| native_integer(a + b))
		.unwrap_or_else(|| Num::Float(a.to_f64() + b.to_f64()))
}

/// Subtract two numbers, promoting beyond IV/UV to NV.
#[inline]
pub(in crate::perl) fn sub(a: Num, b: Num) -> Num {
	if let (Num::Int(a), Num::Int(b)) = (a, b) && let Some(n) = a.checked_sub(b) { return Num::Int(n); }
	integer_pair(a, b)
		.and_then(|(a, b)| native_integer(a - b))
		.unwrap_or_else(|| Num::Float(a.to_f64() - b.to_f64()))
}

/// Multiply two numbers, promoting beyond IV/UV to NV.
#[inline]
pub(in crate::perl) fn mul(a: Num, b: Num) -> Num {
	if let (Num::Int(a), Num::Int(b)) = (a, b) && let Some(n) = a.checked_mul(b) { return Num::Int(n); }
	integer_pair(a, b)
		.and_then(|(a, b)| native_integer(a.checked_mul(b)?))
		.unwrap_or_else(|| Num::Float(a.to_f64() * b.to_f64()))
}

/// Divide two numbers, keeping an exact integer quotient when conversion could lose precision.
pub(in crate::perl) fn div(a: Num, b: Num) -> Result<Num, &'static str> {
	let divisor = b.to_f64();
	if divisor == 0.0 { return Err("Illegal division by zero"); }
	if let Some((a, b)) = integer_pair(a, b) {
		if a.unsigned_abs() > 1 << f64::MANTISSA_DIGITS && a % b == 0 {
			if let Some(n) = native_integer(a / b) { return Ok(n); }
		}
	}
	Ok(Num::Float(a.to_f64() / divisor))
}

/// Compute a remainder with the sign of the divisor and Perl's UV-sized truncation rule.
pub(in crate::perl) fn modulo(a: Num, b: Num) -> Result<Num, &'static str> {
	if let (Num::Int(a), Num::Int(b)) = (a, b) && a >= 0 && b > 0 { return Ok(Num::Int(a % b)); }
	fn trunc_mag(n: Num) -> Option<i128> {
		match n {
			Num::Float(f) if f.abs() < U64_LIMIT => Some(f as i128),
			_ => exact_integer(n),
		}
	}
	let small_b = trunc_mag(b);
	if let (Some(a), Some(b)) = (trunc_mag(a), small_b) {
		if b == 0 { return Err("Illegal modulus zero"); }
		let rem = a % b;
		let rem = if rem != 0 && (rem < 0) != (b < 0) { rem + b } else { rem };
		return Ok(native_integer(rem).unwrap_or_else(|| Num::Float(rem as f64)));
	}

	let (a, b_nv) = (a.to_f64(), b.to_f64());
	let (neg_a, neg_b) = (a < 0.0, b_nv < 0.0);
	// A divisor in the UV range is normally truncated. If only the dividend
	// cannot use UV arithmetic, Perl instead rounds an NV divisor by adding
	// half a unit before dropping the fractional part.
	let b_mag = if small_b.is_some() && matches!(b, Num::Float(_)) {
		(b_nv.abs() + 0.5).floor()
	} else {
		b_nv.abs()
	};
	if b_mag == 0.0 { return Err("Illegal modulus zero"); }
	let mut rem = (if neg_a { -a } else { a }) % b_mag;
	if rem != 0.0 && neg_a != neg_b { rem = b_mag - rem; }
	Ok(Num::Float(if neg_b { -rem } else { rem }))
}

/// Exponentiate with an exact integer result where Perl can prove one fits.
pub(in crate::perl) fn pow(a: Num, b: Num) -> Num {
	if let Some((base, exponent)) = integer_pair(a, b) {
		let magnitude = base.unsigned_abs() as u64;
		if magnitude != 0 && !magnitude.is_power_of_two() && exponent >= 0 {
			let bits = u64::BITS - magnitude.leading_zeros();
			// At most this many multiplications can fit a UV, regardless of the
			// actual digits. Powers of two take the exactly representable NV path.
			if exponent <= i128::from(u64::BITS / bits) {
				let result = i128::from(magnitude.pow(exponent as u32));
				let result = if base < 0 && exponent & 1 != 0 { -result } else { result };
			if let Some(n) = native_integer(result) { return n; }
			}
		}
	}
	Num::Float(a.to_f64().powf(b.to_f64()))
}

/// Negate a number or apply Perl's sign-prefix behavior to strings.
pub(in crate::perl) fn neg(v: &Value) -> Value {
	if let Value::Str(s) = v {
		match s.bytes.first() {
			Some(b'a'..=b'z' | b'A'..=b'Z' | b'_') => {
				let mut bytes = Vec::with_capacity(s.bytes.len() + 1);
				bytes.push(b'-');
				bytes.extend_from_slice(&s.bytes);
				return Value::Str(PStr::new(bytes, s.utf8));
			}
			Some(b'+') | Some(b'-') if s.bytes.first() == Some(&b'+') || !v.is_numeric_string() => {
				let mut s = s.clone();
				s.bytes[0] = if s.bytes[0] == b'+' { b'-' } else { b'+' };
				return Value::Str(s);
			}
			_ => {},
		}
	}
	let n = v.to_num();
	exact_integer(n)
		.and_then(|i| native_integer(-i))
		.unwrap_or_else(|| Num::Float(-n.to_f64()))
		.into_value()
}

/// Compare numbers in IV/UV when both are integers, otherwise in NV. NaN is unordered.
#[inline]
pub(in crate::perl) fn num_cmp(a: Num, b: Num) -> Option<Ordering> {
	if let (Num::Int(a), Num::Int(b)) = (a, b) { return Some(a.cmp(&b)); }
	if let Some((a, b)) = integer_pair(a, b) { Some(a.cmp(&b)) } else { a.to_f64().partial_cmp(&b.to_f64()) }
}

/// Compare strings lexicographically by character value.
pub(in crate::perl) fn str_cmp(a: &PStr, b: &PStr) -> Ordering { a.cmp(b) }

/// Repeat a string in its original encoding (zero or negative repetitions yield an empty string).
pub(in crate::perl) fn repeat(s: &PStr, n: i64) -> Result<PStr, String> {
	if s.is_empty() || n <= 0 { return Ok(PStr::new(Vec::new(), s.utf8)); }
	const ERROR: &str = "Out of memory during string extend";
	let capacity = usize::try_from(n)
		.ok()
		.and_then(|n| s.bytes.len().checked_mul(n))
		.ok_or_else(|| ERROR.to_owned())?;
	// The fill below touches every page in one native step: cap the size first (`try_reserve` alone does not).
	super::limits::check_len(capacity, "string")?;
	let mut bytes = Vec::new();
	bytes.try_reserve_exact(capacity).map_err(|_| ERROR.to_owned())?;
	bytes.extend_from_slice(&s.bytes);
	while bytes.len() < capacity {
		let count = bytes.len().min(capacity - bytes.len());
		bytes.extend_from_within(..count);
	}
	Ok(PStr::new(bytes, s.utf8))
}

#[derive(Clone, Copy)]
enum BitOp { And, Or, Xor }

impl BitOp {
	fn apply(self, a: u64, b: u64) -> u64 {
		match self { Self::And => a & b, Self::Or => a | b, Self::Xor => a ^ b }
	}

	fn name(self) -> &'static str {
		match self {
			Self::And => "bitwise and (&)",
			Self::Or => "bitwise or (|)",
			Self::Xor => "bitwise xor (^)",
		}
	}
}

fn wide_bitwise(name: &str) -> String {
	format!("Use of strings with code points over 0xFF as arguments to {name} operator is not allowed")
}

fn force_string(v: &Value) -> Cow<'_, PStr> {
	match v {
		Value::Str(s) => Cow::Borrowed(s),
		Value::Dual(d) => Cow::Borrowed(&d.str),
		_ => Cow::Owned(v.to_pstr()),
	}
}

fn string_bitwise(a: &PStr, b: &PStr, op: BitOp) -> Result<Value, String> {
	let and = matches!(op, BitOp::And);
	let len = if and { a.bytes.len().min(b.bytes.len()) } else { a.bytes.len().max(b.bytes.len()) };
	let mut out = PStr::new(Vec::with_capacity(len), a.utf8 || b.utf8);
	if out.utf8 {
		let (mut a, mut b) = (a.chars(), b.chars());
		loop {
			let (x, y) = (a.next(), b.next());
			if x.is_none() && y.is_none() { break; }
			let (p, q) = (x.unwrap_or(0), y.unwrap_or(0));
			if (p | q) > 255 { return Err(wide_bitwise(op.name())); }
			if !and || (x.is_some() && y.is_some()) {
				out.push_char(op.apply(u64::from(p), u64::from(q)) as u32);
			}
		}
	} else {
		let common = a.bytes.len().min(b.bytes.len());
		out.bytes.extend(a.bytes.iter().zip(&b.bytes).map(|(&x, &y)| op.apply(u64::from(x), u64::from(y)) as u8));
		if !and {
			out.bytes.extend_from_slice(&a.bytes[common..]);
			out.bytes.extend_from_slice(&b.bytes[common..]);
		}
	}
	Ok(Value::Str(out))
}

fn num_bitwise(a: &Value, b: &Value, op: BitOp) -> Value {
	Num::UInt(op.apply(a.to_u64(), b.to_u64())).into_value()
}

fn has_numeric_facet(v: &Value) -> bool {
	matches!(v, Value::Int(_) | Value::UInt(_) | Value::Num(_) | Value::Dual(_))
}

fn legacy_bitwise(a: &Value, b: &Value, op: BitOp) -> Result<Value, String> {
	if !has_numeric_facet(a) && !has_numeric_facet(b) {
		string_bitwise(&force_string(a), &force_string(b), op)
	} else {
		Ok(num_bitwise(a, b, op))
	}
}

/// Legacy bitwise AND (string mode unless either operand has a numeric facet).
pub(in crate::perl) fn bit_and(a: &Value, b: &Value) -> Result<Value, String> { legacy_bitwise(a, b, BitOp::And) }
/// Legacy bitwise OR (string mode unless either operand has a numeric facet).
pub(in crate::perl) fn bit_or(a: &Value, b: &Value) -> Result<Value, String> { legacy_bitwise(a, b, BitOp::Or) }
/// Legacy bitwise XOR (string mode unless either operand has a numeric facet).
pub(in crate::perl) fn bit_xor(a: &Value, b: &Value) -> Result<Value, String> { legacy_bitwise(a, b, BitOp::Xor) }
/// Legacy bitwise complement (string mode for strings, globs and undef).
pub(in crate::perl) fn bit_not(v: &Value) -> Result<Value, String> {
	if matches!(v, Value::Str(_) | Value::Undef | Value::Glob(_)) {
		string_bit_not(&force_string(v), "1's complement (~)")
	} else {
		Ok(num_bit_not(v))
	}
}

/// Feature-enabled numeric AND.
pub(in crate::perl) fn num_bit_and(a: &Value, b: &Value) -> Value { num_bitwise(a, b, BitOp::And) }
/// Feature-enabled numeric OR.
pub(in crate::perl) fn num_bit_or(a: &Value, b: &Value) -> Value { num_bitwise(a, b, BitOp::Or) }
/// Feature-enabled numeric XOR.
pub(in crate::perl) fn num_bit_xor(a: &Value, b: &Value) -> Value { num_bitwise(a, b, BitOp::Xor) }
/// Feature-enabled numeric complement.
pub(in crate::perl) fn num_bit_not(v: &Value) -> Value { Num::UInt(!v.to_u64()).into_value() }

/// Feature-enabled string AND (`&.`).
pub(in crate::perl) fn str_bit_and(a: &Value, b: &Value) -> Result<Value, String> { string_bitwise(&force_string(a), &force_string(b), BitOp::And) }
/// Feature-enabled string OR (`|.`).
pub(in crate::perl) fn str_bit_or(a: &Value, b: &Value) -> Result<Value, String> { string_bitwise(&force_string(a), &force_string(b), BitOp::Or) }
/// Feature-enabled string XOR (`^.`).
pub(in crate::perl) fn str_bit_xor(a: &Value, b: &Value) -> Result<Value, String> { string_bitwise(&force_string(a), &force_string(b), BitOp::Xor) }
/// Feature-enabled string complement (`~.`).
pub(in crate::perl) fn str_bit_not(v: &Value) -> Result<Value, String> { string_bit_not(&force_string(v), "string 1's complement (~)") }

fn string_bit_not(s: &PStr, name: &str) -> Result<Value, String> {
	let mut out = Vec::with_capacity(s.bytes.len());
	for cp in s.chars() {
		out.push(!u8::try_from(cp).map_err(|_| wide_bitwise(name))?);
	}
	Ok(Value::Str(PStr::new(out, false)))
}

fn shift_count(value: &Value) -> (bool, u64) {
	match value.integer_coercion() {
		Num::UInt(u) => (false, u),
		Num::Int(i) => (i < 0, i.unsigned_abs()),
		Num::Float(n) => (n < 0.0, n.abs() as u64),
	}
}

fn shift(a: &Value, b: &Value, left: bool, signed: bool) -> Value {
	let a = a.to_u64();
	let (negative, count) = shift_count(b);
	let left = left ^ negative;
	if signed {
		let a = a as i64;
		let bits = if count >= u64::from(i64::BITS) {
			if !left && a < 0 { -1 } else { 0 }
		} else if left { a << count } else { a >> count };
		Value::Int(bits)
	} else {
		let bits = if count >= u64::from(u64::BITS) { 0 } else if left { a << count } else { a >> count };
		Num::UInt(bits).into_value()
	}
}

/// Logical left shift; a negative count reverses direction, and overshifts produce zero.
pub(in crate::perl) fn shl(a: &Value, b: &Value) -> Value { shift(a, b, true, false) }
/// Logical right shift; a negative count reverses direction, and overshifts produce zero.
pub(in crate::perl) fn shr(a: &Value, b: &Value) -> Value { shift(a, b, false, false) }
/// Signed left shift for `use integer`.
pub(in crate::perl) fn int_shl(a: &Value, b: &Value) -> Value { shift(a, b, true, true) }
/// Arithmetic right shift for `use integer`.
pub(in crate::perl) fn int_shr(a: &Value, b: &Value) -> Value { shift(a, b, false, true) }

fn is_magic_increment(bytes: &[u8]) -> bool {
	if bytes.is_empty() { return false; }
	let letters = bytes.iter().take_while(|b| b.is_ascii_alphabetic()).count();
	bytes[letters..].iter().all(u8::is_ascii_digit)
}

fn magic_increment(bytes: &mut Vec<u8>) {
	for b in bytes.iter_mut().rev() {
		match *b {
			b'z' => *b = b'a',
			b'Z' => *b = b'A',
			b'9' => *b = b'0',
			_ => { *b += 1; return; }
		}
	}
	if let Some(&first) = bytes.first() {
		bytes.insert(0, if first == b'0' { b'1' } else { first });
	}
}

/// Increment a scalar, using Perl's character-class carry for never-numified strings.
pub(in crate::perl) fn incr(v: &Value) -> Value {
	if v.is_undef() || matches!(v, Value::Str(s) if s.is_empty()) { return Value::Int(1); }
	if let Value::Str(s) = v {
		if is_magic_increment(&s.bytes) {
			let mut s = s.clone();
			magic_increment(&mut s.bytes);
			return Value::Str(s);
		}
	}
	add(v.to_num(), Num::Int(1)).into_value()
}

/// Decrement a scalar numerically, including strings without magic carry.
pub(in crate::perl) fn decr(v: &Value) -> Value {
	if v.is_undef() { Value::Int(-1) } else { sub(v.to_num(), Num::Int(1)).into_value() }
}

const RANGE_MEM_ERROR: &str = "Out of memory during list extend";
/// Most elements a list built in one native step may have (the interpreter's array and list-repeat limit).
pub(in crate::perl) const MAX_LIST: usize = 16_777_216;
const RANGE_BOUND_ERROR: &str = "Range iterator outside integer range";

fn forces_numeric_range(v: &Value) -> bool {
	!matches!(v, Value::Str(_) | Value::Undef)
}

fn range_iv(value: &Value) -> Result<i64, String> {
	match value.integer_coercion() {
		Num::Int(i) => Ok(i),
		// NaN and values outside the IV range die ("Range iterator outside integer range").
		Num::Float(n) if (i64::MIN as f64..-(i64::MIN as f64)).contains(&n) => Ok(n as i64),
		_ => Err(RANGE_BOUND_ERROR.to_owned()),
	}
}

fn numeric_range(a: &Value, b: &Value) -> Result<Vec<Value>, String> {
	let (a, b) = (range_iv(a)?, range_iv(b)?);
	if a > b { return Ok(Vec::new()); }
	let len = usize::try_from(i128::from(b) - i128::from(a) + 1).ok().filter(|&n| n <= MAX_LIST).ok_or_else(|| RANGE_MEM_ERROR.to_owned())?;
	let mut out = Vec::new();
	out.try_reserve_exact(len).map_err(|_| RANGE_MEM_ERROR.to_owned())?;
	out.extend((a..=b).map(Value::Int));
	Ok(out)
}

fn is_numeric_range(a: &Value, b: &Value) -> bool {
	let leading_zero = matches!(a, Value::Str(s) if s.bytes.len() > 1 && s.bytes.starts_with(b"0"));
	forces_numeric_range(a) || forces_numeric_range(b)
		|| (!leading_zero && (a.is_undef() || a.is_numeric_string()) && (b.is_undef() || b.is_numeric_string())
			&& !(a.is_undef() && b.is_undef()))
}

/// The inclusive IV bounds of a numeric list-context range (None for a string range), so loops can count lazily.
pub(in crate::perl) fn numeric_range_bounds(a: &Value, b: &Value) -> Option<Result<(i64, i64), String>> {
	if !is_numeric_range(a, b) { return None; }
	Some(range_iv(a).and_then(|a| Ok((a, range_iv(b)?))))
}

/// Produce a list-context range of IVs or auto-incrementing strings.
pub(in crate::perl) fn range(a: &Value, b: &Value) -> Result<Vec<Value>, String> {
	if is_numeric_range(a, b) { return numeric_range(a, b); }

	let mut current = a.to_pstr();
	let end = force_string(b);
	// Perl compares the current representation's byte count with the final
	// string's character count, even in the presence of SvUTF8.
	let limit = end.char_len();
	let magic = is_magic_increment(&current.bytes);
	let mut out = Vec::new();
	while current.bytes.len() <= limit {
		if out.len() >= MAX_LIST { return Err(RANGE_MEM_ERROR.to_owned()); }
		out.try_reserve(1).map_err(|_| RANGE_MEM_ERROR.to_owned())?;
		if !magic || current == *end {
			out.push(Value::Str(current));
			break;
		}
		out.push(Value::Str(current.clone()));
		magic_increment(&mut current.bytes);
	}
	Ok(out)
}

/// Wrapping signed addition under `use integer`.
pub(in crate::perl) fn int_add(a: i64, b: i64) -> i64 { a.wrapping_add(b) }
/// Wrapping signed subtraction under `use integer`.
pub(in crate::perl) fn int_sub(a: i64, b: i64) -> i64 { a.wrapping_sub(b) }
/// Wrapping signed multiplication under `use integer`.
pub(in crate::perl) fn int_mul(a: i64, b: i64) -> i64 { a.wrapping_mul(b) }
/// Wrapping signed division, truncating toward zero under `use integer`.
pub(in crate::perl) fn int_div(a: i64, b: i64) -> Result<i64, &'static str> {
	if b == 0 { Err("Illegal division by zero") } else { Ok(a.wrapping_div(b)) }
}
/// Signed remainder with dividend's sign under `use integer`.
pub(in crate::perl) fn int_mod(a: i64, b: i64) -> Result<i64, &'static str> {
	if b == 0 { Err("Illegal modulus zero") } else { Ok(a.wrapping_rem(b)) }
}
/// Wrapping signed negation under `use integer`.
pub(in crate::perl) fn int_neg(a: i64) -> i64 { a.wrapping_neg() }
/// Signed result of integer AND.
pub(in crate::perl) fn int_bit_and(a: i64, b: i64) -> i64 { a & b }
/// Signed result of integer OR.
pub(in crate::perl) fn int_bit_or(a: i64, b: i64) -> i64 { a | b }
/// Signed result of integer XOR.
pub(in crate::perl) fn int_bit_xor(a: i64, b: i64) -> i64 { a ^ b }
/// Signed result of integer complement.
pub(in crate::perl) fn int_bit_not(a: i64) -> i64 { !a }

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn arithmetic_uses_native_integer_precision_when_available() {
		assert!(matches!(add(Num::Int(i64::MAX), Num::Int(1)), Num::UInt(0x8000_0000_0000_0000)));
		assert!(matches!(mul(Num::Int(i64::MIN), Num::Int(-1)), Num::UInt(0x8000_0000_0000_0000)));
		assert!(matches!(sub(Num::UInt(u64::MAX), Num::UInt(u64::MAX)), Num::Int(0)));
		assert!(matches!(mul(Num::UInt(u64::MAX), Num::UInt(u64::MAX)), Num::Float(_)));
		assert!(matches!(div(Num::Int(6), Num::Int(3)), Ok(Num::Float(2.0))));
		assert!(matches!(div(Num::Int(9_007_199_254_740_993), Num::Int(3)), Ok(Num::Int(3_002_399_751_580_331))));
		assert!(matches!(div(Num::Int(1), Num::Float(-0.0)), Err("Illegal division by zero")));
		assert!(matches!(pow(Num::Int(3), Num::Int(32)), Num::Int(1_853_020_188_851_841)));
		assert!(matches!(pow(Num::Int(-7), Num::Int(19)), Num::Int(-11_398_895_185_373_143)));
		assert!(matches!(pow(Num::Int(2), Num::Int(62)), Num::Float(4_611_686_018_427_387_904.0)));
		assert!(matches!(pow(Num::Int(3), Num::Int(40)), Num::Float(_)));
		assert_eq!(num_cmp(Num::UInt(u64::MAX), Num::Int(-1)), Some(Ordering::Greater));
		assert_eq!(num_cmp(Num::Int(9_007_199_254_740_993), Num::Float(9_007_199_254_740_992.0)), Some(Ordering::Equal));
		assert_eq!(num_cmp(Num::Int(3), Num::Float(f64::NAN)), None);
	}

	#[test]
	fn modulo_and_wrapping_integer_operators() {
		assert!(matches!(modulo(Num::Int(-5), Num::Int(3)), Ok(Num::Int(1))));
		assert!(matches!(modulo(Num::Int(5), Num::Int(-3)), Ok(Num::Int(-1))));
		assert!(matches!(modulo(Num::Float(-1.0e20), Num::Float(3.99)), Ok(Num::Float(0.0))));
		assert!(matches!(modulo(Num::Float(1.0e20), Num::Int(3)), Ok(Num::Float(1.0))));
		assert!(matches!(modulo(Num::Float(-1.0e20), Num::Int(3)), Ok(Num::Float(2.0))));
		assert!(matches!(modulo(Num::Int(-7), Num::Float(3.99)), Ok(Num::Int(2))));
		assert!(matches!(modulo(Num::Float(1.0e20), Num::Float(0.49)), Err("Illegal modulus zero")));
		assert!(matches!(modulo(Num::Float(1.0e20), Num::Float(0.5)), Ok(Num::Float(0.0))));
		assert!(matches!(modulo(Num::Float(1.0e20), Num::Float(-3.99)), Ok(Num::Float(n)) if n == 0.0 && n.is_sign_negative()));
		assert!(matches!(modulo(Num::Float(3.4), Num::Float(1.0e20)), Ok(Num::Float(3.4))));
		assert!(matches!(modulo(Num::Float(-3.4), Num::Float(f64::INFINITY)), Ok(Num::Float(f64::INFINITY))));
		assert!(matches!(modulo(Num::Int(5), Num::Float(-0.9)), Err("Illegal modulus zero")));
		assert_eq!(int_add(i64::MAX, 1), i64::MIN);
		assert_eq!(int_div(i64::MIN, -1), Ok(i64::MIN));
		assert_eq!(int_mod(i64::MIN, -1), Ok(0));
		assert_eq!(int_mod(-5, 3), Ok(-2));
	}

	#[test]
	fn bitwise_mode_encoding_and_shifts() {
		assert_eq!(bit_or(&Value::str("150"), &Value::str("105")).unwrap().to_pstr(), PStr::from_str("155"));
		assert!(matches!(bit_or(&Value::str("150"), &Value::Int(105)), Ok(Value::Int(255))));
		assert!(matches!(num_bit_or(&Value::str("150"), &Value::str("105")), Value::Int(255)));
		let glob = Value::Glob(super::super::value::new_gv("main".into(), "STDOUT".into()));
		assert_eq!(bit_or(&glob, &Value::str("a")).unwrap().to_pstr(), PStr::from_str("kmain::STDOUT"));
		let reference = Value::Ref(super::super::value::Ref::Array(super::super::value::new_av(Vec::new())));
		assert!(matches!(bit_or(&reference, &Value::Undef), Ok(Value::Str(_))));
		assert_eq!(bit_xor(&Value::str("abc"), &Value::str("a")).unwrap().to_pstr().bytes, b"\0bc");
		assert_eq!(bit_and(&Value::str("aĀ"), &Value::str("a")).unwrap_err(),
			"Use of strings with code points over 0xFF as arguments to bitwise and (&) operator is not allowed");
		let complemented = bit_not(&Value::str("é")).unwrap().to_pstr();
		assert_eq!(complemented.bytes, [0x16]);
		assert!(!complemented.utf8);
		assert!(matches!(shr(&Value::Int(-8), &Value::Int(2)), Value::Int(4_611_686_018_427_387_902)));
		assert!(matches!(shr(&Value::Int(-8), &Value::Int(-2)), Value::UInt(18_446_744_073_709_551_584)));
		assert!(matches!(shr(&Value::Int(-8), &Value::UInt(u64::MAX)), Value::Int(0)));
		assert!(matches!(int_shr(&Value::Int(-8), &Value::UInt(u64::MAX)), Value::Int(-1)));
	}

	#[test]
	fn negation_increment_and_list_ranges() {
		assert_eq!(neg(&Value::str("foo")).to_pstr(), PStr::from_str("-foo"));
		assert!(matches!(neg(&Value::str("+12")), Value::Str(_)));
		assert!(matches!(neg(&Value::str("-12")), Value::Int(12)));
		assert_eq!(neg(&Value::str("-foo")).to_pstr(), PStr::from_str("+foo"));
		assert_eq!(neg(&Value::str("NaN")).to_pstr(), PStr::from_str("-NaN"));
		for (a, b) in [("Az", "Ba"), ("zZ9", "aaA0"), ("99", "100"), ("0099", "0100"), ("a9", "b0")] {
			assert_eq!(incr(&Value::str(a)).to_pstr(), PStr::from_str(b));
		}
		assert!(matches!(incr(&Value::Undef), Value::Int(1)));
		assert!(matches!(decr(&Value::str("0099")), Value::Int(98)));
		assert!(matches!(decr(&Value::Int(i64::MIN)), Value::Num(_)));
		let r = |a, b| range(&a, &b).unwrap().into_iter().map(|v| v.to_pstr().to_string_lossy().into_owned()).collect::<Vec<_>>();
		assert_eq!(r(Value::str("01"), Value::str("03")), ["01", "02", "03"]);
		assert_eq!(r(Value::str("01"), Value::Int(3)), ["1", "2", "3"]);
		assert_eq!(r(Value::str("z"), Value::str("ab")), ["z", "aa", "ab"]);
		assert_eq!(r(Value::str("*x"), Value::str("az")), ["*x"]);
		assert_eq!(r(Value::str("a"), Value::str("Ā")).len(), 26);
		assert_eq!(r(Value::str("Ā"), Value::str("Ā")).len(), 0);
		assert_eq!(r(Value::str(""), Value::str("3")), [""]);
		assert_eq!(r(Value::str("-2"), Value::Undef), ["-2", "-1", "0"]);
		assert_eq!(r(Value::Num(-3.9), Value::Num(-1.5)), ["-3", "-2", "-1"]);
		assert_eq!(range(&Value::UInt(u64::MAX), &Value::Int(1)).unwrap_err(), RANGE_BOUND_ERROR);
		assert_eq!(repeat(&PStr::from_str("é"), 2).unwrap().bytes, b"\xc3\xa9\xc3\xa9");
		assert!(repeat(&PStr::from_str("x"), -2).unwrap().is_empty());
		assert_eq!(repeat(&PStr::from_str("foo"), i64::MAX).unwrap_err(), "Out of memory during string extend");
		assert_eq!(range(&Value::Int(i64::MIN), &Value::Int(i64::MAX)).unwrap_err(), RANGE_MEM_ERROR);
	}
}
