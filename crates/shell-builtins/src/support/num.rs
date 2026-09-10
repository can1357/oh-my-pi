//! Extended numeric parsing and allocation-free ASCII increment helpers.

use std::{
	cmp::Ordering,
	fmt::{self, Display},
	ops::{Add, Neg, Sub},
};

use bigdecimal::{
	BigDecimal,
	num_bigint::{BigInt, BigUint, Sign},
};
use num_traits::{FromPrimitive, Signed, ToPrimitive, Zero};
use thiserror::Error;

/// An arbitrary-precision decimal extended with IEEE-style special values.
#[derive(Debug, Clone)]
pub(crate) enum ExtendedBigDecimal {
	/// A finite arbitrary-precision decimal.
	BigDecimal(BigDecimal),
	/// Positive infinity.
	Infinity,
	/// Negative infinity.
	MinusInfinity,
	/// Negative zero.
	MinusZero,
	/// Positive NaN.
	Nan,
	/// Negative NaN.
	MinusNan,
}

impl ExtendedBigDecimal {
	/// Returns positive zero.
	pub(crate) fn zero() -> Self {
		Self::BigDecimal(BigDecimal::zero())
	}

	/// Returns one.
	pub(crate) fn one() -> Self {
		Self::BigDecimal(BigDecimal::from(1))
	}

	/// Converts a non-negative integer value to an unsigned big integer.
	pub(crate) fn to_biguint(&self) -> Option<BigUint> {
		match self {
			Self::BigDecimal(decimal) => {
				let (integer, scale) = decimal.as_bigint_and_scale();
				if integer.is_negative() || scale > 0 || scale < -(u32::MAX as i64) {
					return None;
				}
				integer
					.to_biguint()
					.map(|value| value * BigUint::from(10_u32).pow((-scale) as u32))
			},
			_ => None,
		}
	}
}

impl From<f64> for ExtendedBigDecimal {
	fn from(value: f64) -> Self {
		if value.is_nan() {
			if value.is_sign_negative() {
				Self::MinusNan
			} else {
				Self::Nan
			}
		} else if value.is_infinite() {
			if value.is_sign_negative() {
				Self::MinusInfinity
			} else {
				Self::Infinity
			}
		} else if value == 0.0 && value.is_sign_negative() {
			Self::MinusZero
		} else {
			Self::BigDecimal(BigDecimal::from_f64(value).expect("finite f64 converts to BigDecimal"))
		}
	}
}

impl From<u8> for ExtendedBigDecimal {
	fn from(value: u8) -> Self {
		Self::BigDecimal(value.into())
	}
}

impl From<u32> for ExtendedBigDecimal {
	fn from(value: u32) -> Self {
		Self::BigDecimal(value.into())
	}
}

impl Default for ExtendedBigDecimal {
	fn default() -> Self {
		Self::zero()
	}
}

impl Zero for ExtendedBigDecimal {
	fn zero() -> Self {
		Self::zero()
	}

	fn is_zero(&self) -> bool {
		matches!(self, Self::MinusZero) || matches!(self, Self::BigDecimal(value) if value.is_zero())
	}
}

impl Add for ExtendedBigDecimal {
	type Output = Self;

	fn add(self, other: Self) -> Self {
		match (self, other) {
			(Self::BigDecimal(left), Self::BigDecimal(right)) => Self::BigDecimal(left + right),
			(Self::BigDecimal(_), Self::MinusInfinity)
			| (Self::MinusInfinity, Self::BigDecimal(_))
			| (Self::MinusInfinity, Self::MinusInfinity)
			| (Self::MinusInfinity, Self::MinusZero)
			| (Self::MinusZero, Self::MinusInfinity) => Self::MinusInfinity,
			(Self::BigDecimal(_), Self::Infinity)
			| (Self::Infinity, Self::BigDecimal(_))
			| (Self::Infinity, Self::Infinity)
			| (Self::Infinity, Self::MinusZero)
			| (Self::MinusZero, Self::Infinity) => Self::Infinity,
			(Self::BigDecimal(value), Self::MinusZero) => Self::BigDecimal(value),
			(Self::MinusZero, value) => value,
			(Self::Infinity, Self::MinusInfinity) | (Self::MinusInfinity, Self::Infinity) => Self::Nan,
			(Self::Nan, _) | (_, Self::Nan) => Self::Nan,
			(Self::MinusNan, _) | (_, Self::MinusNan) => Self::MinusNan,
		}
	}
}

impl Sub for ExtendedBigDecimal {
	type Output = Self;

	fn sub(self, other: Self) -> Self {
		self + -other
	}
}

impl Neg for ExtendedBigDecimal {
	type Output = Self;

	fn neg(self) -> Self {
		match self {
			Self::BigDecimal(value) if value.is_zero() => Self::MinusZero,
			Self::BigDecimal(value) => Self::BigDecimal(-value),
			Self::MinusZero => Self::zero(),
			Self::Infinity => Self::MinusInfinity,
			Self::MinusInfinity => Self::Infinity,
			Self::Nan => Self::MinusNan,
			Self::MinusNan => Self::Nan,
		}
	}
}

impl PartialEq for ExtendedBigDecimal {
	fn eq(&self, other: &Self) -> bool {
		match (self, other) {
			(Self::BigDecimal(left), Self::BigDecimal(right)) => left == right,
			(Self::Infinity, Self::Infinity)
			| (Self::MinusInfinity, Self::MinusInfinity)
			| (Self::MinusZero, Self::MinusZero) => true,
			_ => false,
		}
	}
}

impl PartialOrd for ExtendedBigDecimal {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		match (self, other) {
			(Self::Nan | Self::MinusNan, _) | (_, Self::Nan | Self::MinusNan) => None,
			(Self::BigDecimal(left), Self::BigDecimal(right)) => left.partial_cmp(right),
			(Self::Infinity, Self::Infinity)
			| (Self::MinusInfinity, Self::MinusInfinity)
			| (Self::MinusZero, Self::MinusZero) => Some(Ordering::Equal),
			(Self::Infinity, _) | (_, Self::MinusInfinity) => Some(Ordering::Greater),
			(Self::MinusInfinity, _) | (_, Self::Infinity) => Some(Ordering::Less),
			(Self::BigDecimal(value), Self::MinusZero) => value.partial_cmp(&BigDecimal::zero()),
			(Self::MinusZero, Self::BigDecimal(value)) => BigDecimal::zero().partial_cmp(value),
		}
	}
}

impl Display for ExtendedBigDecimal {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::BigDecimal(value) => value.fmt(formatter),
			Self::Infinity => formatter.write_str("inf"),
			Self::MinusInfinity => formatter.write_str("-inf"),
			Self::MinusZero => formatter.write_str("-0"),
			Self::Nan => formatter.write_str("nan"),
			Self::MinusNan => formatter.write_str("-nan"),
		}
	}
}

/// A recoverable failure from extended number parsing.
#[derive(Debug, PartialEq, Error)]
pub(crate) enum ExtendedParserError<T> {
	/// No prefix of the input is numeric.
	#[error("input is not numeric")]
	NotNumeric,
	/// A number was parsed, followed by unrecognized input.
	#[error("number has trailing input {1:?}")]
	PartialMatch(T, String),
	/// The parsed value overflowed and was saturated.
	#[error("number overflowed")]
	Overflow(T),
	/// The parsed value underflowed and was saturated.
	#[error("number underflowed")]
	Underflow(T),
}

impl<T: Zero> ExtendedParserError<T> {
	fn extract(self) -> T {
		match self {
			Self::NotNumeric => T::zero(),
			Self::PartialMatch(value, _) | Self::Overflow(value) | Self::Underflow(value) => value,
		}
	}

	fn map<U: Zero>(
		self,
		convert: impl FnOnce(T) -> Result<U, ExtendedParserError<U>>,
	) -> ExtendedParserError<U> {
		fn extract<U: Zero>(value: Result<U, ExtendedParserError<U>>) -> U {
			value.unwrap_or_else(ExtendedParserError::extract)
		}

		match self {
			Self::NotNumeric => ExtendedParserError::NotNumeric,
			Self::PartialMatch(value, rest) => {
				ExtendedParserError::PartialMatch(extract(convert(value)), rest)
			},
			Self::Overflow(value) => ExtendedParserError::Overflow(extract(convert(value))),
			Self::Underflow(value) => ExtendedParserError::Underflow(extract(convert(value))),
		}
	}
}

/// Parses decimal, hexadecimal, octal, and binary numbers with recoverable
/// errors.
pub(crate) trait ExtendedParser: Sized {
	/// Parses a number, retaining the parsed prefix on recoverable failure.
	fn extended_parse(input: &str) -> Result<Self, ExtendedParserError<Self>>;
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Base {
	Binary      = 2,
	Octal       = 8,
	Decimal     = 10,
	Hexadecimal = 16,
}

impl Base {
	fn digit(self, byte: u8) -> Option<u64> {
		match self {
			Self::Binary if matches!(byte, b'0'..=b'1') => Some(u64::from(byte - b'0')),
			Self::Octal if matches!(byte, b'0'..=b'7') => Some(u64::from(byte - b'0')),
			Self::Decimal if byte.is_ascii_digit() => Some(u64::from(byte - b'0')),
			Self::Hexadecimal => match byte {
				b'0'..=b'9' => Some(u64::from(byte - b'0')),
				b'a'..=b'f' => Some(u64::from(byte - b'a') + 10),
				b'A'..=b'F' => Some(u64::from(byte - b'A') + 10),
				_ => None,
			},
			_ => None,
		}
	}

	fn parse_digits(self, input: &str) -> (Option<BigUint>, &str) {
		let (digits, _, rest) = self.parse_digits_count(input, None);
		(digits, rest)
	}

	fn parse_digits_count(
		self,
		input: &str,
		mut digits: Option<BigUint>,
	) -> (Option<BigUint>, i64, &str) {
		let mut count = 0_i64;
		let mut rest = input;
		let mut temporary = 0_u64;
		let mut temporary_count = 0_i64;
		let mut temporary_multiplier = 1_u64;
		while let Some(digit) = rest.as_bytes().first().and_then(|byte| self.digit(*byte)) {
			temporary = temporary * self as u64 + digit;
			temporary_count += 1;
			temporary_multiplier *= self as u64;
			rest = &rest[1..];
			if temporary_count >= 15 {
				digits = Some(digits.unwrap_or_default() * temporary_multiplier + temporary);
				count += temporary_count;
				temporary = 0;
				temporary_count = 0;
				temporary_multiplier = 1;
			}
		}
		if temporary_multiplier > 1 {
			digits = Some(digits.unwrap_or_default() * temporary_multiplier + temporary);
			count += temporary_count;
		}
		(digits, count, rest)
	}
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ParseTarget {
	Decimal,
	Integral,
	Duration,
}

fn parse_digits(base: Base, input: &str, fractional: bool) -> (Option<BigUint>, i64, &str) {
	let (digits, rest) = base.parse_digits(input);
	if fractional && let Some(rest) = rest.strip_prefix('.') {
		return base.parse_digits_count(rest, digits);
	}
	(digits, 0, rest)
}

fn parse_exponent(base: Base, input: &str) -> (Option<BigInt>, &str) {
	let marker = match base {
		Base::Decimal => *b"eE",
		Base::Hexadecimal => *b"pP",
		Base::Binary | Base::Octal => unreachable!(),
	};
	if input
		.as_bytes()
		.first()
		.is_some_and(|byte| marker.contains(byte))
	{
		let after_marker = &input[1..];
		let (sign, unsigned) = if let Some(rest) = after_marker.strip_prefix('-') {
			(Sign::Minus, rest)
		} else if let Some(rest) = after_marker.strip_prefix('+') {
			(Sign::Plus, rest)
		} else {
			(Sign::Plus, after_marker)
		};
		let (digits, rest) = Base::Decimal.parse_digits(unsigned);
		if let Some(digits) = digits {
			return (Some(BigInt::from_biguint(sign, digits)), rest);
		}
	}
	(None, input)
}

fn parse_suffix_multiplier<'a>(input: &'a str, allowed: &[(char, u32)]) -> (u32, &'a str) {
	if let Some(character) = input.chars().next()
		&& let Some(multiplier) = allowed
			.iter()
			.find_map(|(suffix, multiplier)| (*suffix == character).then_some(*multiplier))
	{
		return (multiplier, &input[character.len_utf8()..]);
	}
	(1, input)
}

fn parse_special(
	input: &str,
	negative: bool,
	allowed_suffixes: &[(char, u32)],
) -> Result<ExtendedBigDecimal, ExtendedParserError<ExtendedBigDecimal>> {
	let lower = input.to_ascii_lowercase();
	let (length, mut value) = if lower.starts_with("infinity") {
		(8, ExtendedBigDecimal::Infinity)
	} else if lower.starts_with("inf") {
		(3, ExtendedBigDecimal::Infinity)
	} else if lower.starts_with("nan") {
		(3, ExtendedBigDecimal::Nan)
	} else {
		return Err(ExtendedParserError::NotNumeric);
	};
	if negative {
		value = -value;
	}
	let (_, rest) = parse_suffix_multiplier(&input[length..], allowed_suffixes);
	if rest.is_empty() {
		Ok(value)
	} else {
		Err(ExtendedParserError::PartialMatch(value, rest.to_owned()))
	}
}

fn range_error(overflow: bool, negative: bool) -> ExtendedParserError<ExtendedBigDecimal> {
	let mut value = if overflow {
		ExtendedBigDecimal::Infinity
	} else {
		ExtendedBigDecimal::zero()
	};
	if negative {
		value = -value;
	}
	if overflow {
		ExtendedParserError::Overflow(value)
	} else {
		ExtendedParserError::Underflow(value)
	}
}

fn construct_decimal(
	digits: BigUint,
	negative: bool,
	base: Base,
	scale: i64,
	exponent: BigInt,
) -> Result<ExtendedBigDecimal, ExtendedParserError<ExtendedBigDecimal>> {
	if digits.is_zero() {
		return Ok(if negative {
			ExtendedBigDecimal::MinusZero
		} else {
			ExtendedBigDecimal::zero()
		});
	}
	let sign = if negative { Sign::Minus } else { Sign::Plus };
	let signed_digits = BigInt::from_biguint(sign, digits);
	let decimal = if scale == 0 && exponent.is_zero() {
		BigDecimal::from_bigint(signed_digits, 0)
	} else if base == Base::Decimal {
		if exponent.is_zero() {
			BigDecimal::from_bigint(signed_digits, scale)
		} else {
			let new_scale = -exponent + scale;
			let Some(new_scale) = new_scale.to_i64() else {
				return Err(range_error(new_scale.is_negative(), negative));
			};
			BigDecimal::from_bigint(signed_digits, new_scale)
		}
	} else if base == Base::Hexadecimal {
		if scale > i64::from(u32::MAX) {
			return Err(ExtendedParserError::NotNumeric);
		}
		let decimal = BigDecimal::from_bigint(signed_digits, 0)
			/ BigDecimal::from_bigint(BigInt::from(16).pow(scale as u32), 0);
		let Some(exponent) = exponent.to_i64() else {
			return Err(range_error(exponent.is_positive(), negative));
		};
		decimal * BigDecimal::from(2).powi(exponent)
	} else {
		unreachable!()
	};
	Ok(ExtendedBigDecimal::BigDecimal(decimal))
}

fn parse_number(
	input: &str,
	target: ParseTarget,
	allowed_suffixes: &[(char, u32)],
) -> Result<ExtendedBigDecimal, ExtendedParserError<ExtendedBigDecimal>> {
	let input = input.trim_ascii_start();
	let (negative, unsigned) = if let Some(rest) = input.strip_prefix('-') {
		(true, rest)
	} else if let Some(rest) = input.strip_prefix('+') {
		(false, rest)
	} else {
		(false, input)
	};
	let (base, rest) = if let Some(after_zero) = unsigned.strip_prefix('0') {
		if let Some(rest) = after_zero.strip_prefix(['x', 'X']) {
			(Base::Hexadecimal, rest)
		} else if target == ParseTarget::Integral {
			if let Some(rest) = after_zero.strip_prefix(['b', 'B']) {
				(Base::Binary, rest)
			} else {
				(Base::Octal, unsigned)
			}
		} else {
			(Base::Decimal, unsigned)
		}
	} else {
		(Base::Decimal, unsigned)
	};
	let fractional =
		matches!(base, Base::Decimal | Base::Hexadecimal) && target != ParseTarget::Integral;
	let (digits, scale, rest) = parse_digits(base, rest, fractional);
	let (exponent, rest) = if fractional {
		parse_exponent(base, rest)
	} else {
		(None, rest)
	};
	let Some(digits) = digits else {
		if let Some(partial) = unsigned.strip_prefix('0') {
			let zero = if negative {
				ExtendedBigDecimal::MinusZero
			} else {
				ExtendedBigDecimal::zero()
			};
			return Err(ExtendedParserError::PartialMatch(zero, partial.to_owned()));
		}
		return if target == ParseTarget::Integral {
			Err(ExtendedParserError::NotNumeric)
		} else {
			parse_special(unsigned, negative, allowed_suffixes)
		};
	};
	let (multiplier, rest) = parse_suffix_multiplier(rest, allowed_suffixes);
	let result =
		construct_decimal(digits * multiplier, negative, base, scale, exponent.unwrap_or_default());
	if rest.is_empty() {
		result
	} else {
		Err(ExtendedParserError::PartialMatch(
			result.unwrap_or_else(ExtendedParserError::extract),
			rest.to_owned(),
		))
	}
}

impl ExtendedParser for ExtendedBigDecimal {
	fn extended_parse(input: &str) -> Result<Self, ExtendedParserError<Self>> {
		parse_number(input, ParseTarget::Decimal, &[])
	}
}

impl ExtendedParser for i64 {
	fn extended_parse(input: &str) -> Result<Self, ExtendedParserError<Self>> {
		fn convert(value: ExtendedBigDecimal) -> Result<i64, ExtendedParserError<i64>> {
			match value {
				ExtendedBigDecimal::BigDecimal(decimal) => {
					let (digits, scale) = decimal.into_bigint_and_scale();
					if scale != 0 {
						return Err(ExtendedParserError::NotNumeric);
					}
					let negative = digits.sign() == Sign::Minus;
					i64::try_from(digits).map_err(|_| {
						ExtendedParserError::Overflow(if negative { i64::MIN } else { i64::MAX })
					})
				},
				ExtendedBigDecimal::MinusZero => Ok(0),
				_ => Err(ExtendedParserError::NotNumeric),
			}
		}
		match parse_number(input, ParseTarget::Integral, &[]) {
			Ok(value) => convert(value),
			Err(error) => Err(error.map(convert)),
		}
	}
}

impl ExtendedParser for u64 {
	fn extended_parse(input: &str) -> Result<Self, ExtendedParserError<Self>> {
		fn convert(value: ExtendedBigDecimal) -> Result<u64, ExtendedParserError<u64>> {
			match value {
				ExtendedBigDecimal::BigDecimal(decimal) => {
					let (digits, scale) = decimal.into_bigint_and_scale();
					if scale != 0 {
						return Err(ExtendedParserError::NotNumeric);
					}
					let (sign, digits) = digits.into_parts();
					match u64::try_from(digits) {
						Ok(integer) if sign == Sign::Minus => Ok((!integer).wrapping_add(1)),
						Ok(integer) => Ok(integer),
						Err(_) => Err(ExtendedParserError::Overflow(u64::MAX)),
					}
				},
				ExtendedBigDecimal::MinusZero => Ok(0),
				_ => Err(ExtendedParserError::NotNumeric),
			}
		}
		match parse_number(input, ParseTarget::Integral, &[]) {
			Ok(value) => convert(value),
			Err(error) => Err(error.map(convert)),
		}
	}
}

impl ExtendedParser for f64 {
	fn extended_parse(input: &str) -> Result<Self, ExtendedParserError<Self>> {
		fn convert(value: ExtendedBigDecimal) -> Result<f64, ExtendedParserError<f64>> {
			let value = match value {
				ExtendedBigDecimal::BigDecimal(decimal) => {
					let float = decimal.to_f64().unwrap_or_else(|| {
						if decimal.is_negative() {
							f64::NEG_INFINITY
						} else {
							f64::INFINITY
						}
					});
					if float.is_infinite() {
						return Err(ExtendedParserError::Overflow(float));
					}
					if float == 0.0 && !decimal.is_zero() {
						return Err(ExtendedParserError::Underflow(float));
					}
					float
				},
				ExtendedBigDecimal::MinusZero => -0.0,
				ExtendedBigDecimal::Nan => f64::NAN,
				ExtendedBigDecimal::MinusNan => -f64::NAN,
				ExtendedBigDecimal::Infinity => f64::INFINITY,
				ExtendedBigDecimal::MinusInfinity => f64::NEG_INFINITY,
			};
			Ok(value)
		}
		match parse_number(input, ParseTarget::Decimal, &[]) {
			Ok(value) => convert(value),
			Err(error) => Err(error.map(convert)),
		}
	}
}

/// Adds an ASCII decimal increment to `value[start..end]` in place.
#[inline]
pub(crate) fn fast_inc(value: &mut [u8], start: &mut usize, end: usize, increment: &[u8]) {
	let mut position = end;
	let mut carry = 0_u8;
	for increment_position in (0..increment.len()).rev() {
		debug_assert!(position > 0, "increment buffer needs more headroom");
		position -= 1;
		let mut digit = increment[increment_position] + carry;
		if position >= *start {
			digit += value[position] - b'0';
		}
		if digit > b'9' {
			carry = 1;
			digit -= 10;
		} else {
			carry = 0;
		}
		value[position] = digit;
	}
	if carry == 0 {
		*start = (*start).min(position);
	} else {
		fast_inc_one(value, start, position);
	}
}

/// Adds one to the ASCII decimal in `value[start..end]` in place.
#[inline]
pub(crate) fn fast_inc_one(value: &mut [u8], start: &mut usize, end: usize) {
	let mut position = end;
	while position > *start {
		position -= 1;
		if value[position] == b'9' {
			value[position] = b'0';
		} else {
			value[position] += 1;
			return;
		}
	}
	debug_assert!(*start > 0, "increment buffer needs more headroom");
	value[*start - 1] = b'1';
	*start -= 1;
}

/// Parses a duration number with optional one-character unit multipliers.
pub(super) fn parse_duration_number(
	input: &str,
	allowed_suffixes: &[(char, u32)],
) -> Result<ExtendedBigDecimal, ExtendedParserError<ExtendedBigDecimal>> {
	parse_number(input, ParseTarget::Duration, allowed_suffixes)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn parse(input: &str) -> ExtendedBigDecimal {
		ExtendedBigDecimal::extended_parse(input).unwrap()
	}

	#[test]
	fn parses_decimal_hex_and_special_values() {
		assert_eq!(parse("1.25e2"), ExtendedBigDecimal::BigDecimal(BigDecimal::from(125)));
		assert_eq!(parse("0x1.8p1"), ExtendedBigDecimal::BigDecimal(BigDecimal::from(3)));
		assert_eq!(parse("-0e100"), ExtendedBigDecimal::MinusZero);
		assert_eq!(parse("inf"), ExtendedBigDecimal::Infinity);
		assert_eq!(parse("-Infinity"), ExtendedBigDecimal::MinusInfinity);
		assert!(matches!(parse("nan"), ExtendedBigDecimal::Nan));
		assert!(matches!(parse("-nan"), ExtendedBigDecimal::MinusNan));
	}

	#[test]
	fn reports_partial_and_range_errors() {
		assert!(matches!(
			ExtendedBigDecimal::extended_parse("12wat"),
			Err(ExtendedParserError::PartialMatch(ExtendedBigDecimal::BigDecimal(_), rest)) if rest == "wat"
		));
		assert!(matches!(
			ExtendedBigDecimal::extended_parse("1e92233720368547758080"),
			Err(ExtendedParserError::Overflow(ExtendedBigDecimal::Infinity))
		));
		assert!(matches!(
			ExtendedBigDecimal::extended_parse("-1e-92233720368547758080"),
			Err(ExtendedParserError::Underflow(ExtendedBigDecimal::MinusZero))
		));
	}

	#[test]
	fn special_value_ordering_and_display() {
		assert!(ExtendedBigDecimal::MinusInfinity < ExtendedBigDecimal::MinusZero);
		assert_eq!(
			ExtendedBigDecimal::MinusZero.partial_cmp(&ExtendedBigDecimal::zero()),
			Some(Ordering::Equal)
		);
		assert!(ExtendedBigDecimal::Infinity > ExtendedBigDecimal::zero());
		assert_eq!(ExtendedBigDecimal::MinusZero.to_string(), "-0");
	}

	#[test]
	fn increments_ascii_in_place() {
		let mut value = *b"...7_";
		let mut start = 3;
		fast_inc(&mut value, &mut start, 4, b"543");
		assert_eq!(&value[start..4], b"550");
		fast_inc(&mut value, &mut start, 4, b"543");
		assert_eq!(&value[start..4], b"1093");

		let mut one = *b".99_";
		let mut start = 1;
		fast_inc_one(&mut one, &mut start, 3);
		assert_eq!(&one[start..3], b"100");
	}
}
