//! `seq` builtin: display numbers from FIRST to LAST in steps of INCREMENT.
//!
//! Ported from uutils coreutils 0.8.0.

use std::{
	error::Error,
	ffi::{OsStr, OsString},
	io::{BufWriter, Write},
};

use clap::{Arg, ArgAction, ArgMatches, Command};
use num_bigint::BigUint;
use num_traits::{ToPrimitive, Zero};
use omp_shell::{ShellExtensions, builtins::Registration};

use crate::{
	host::{Host, Utility, format_usage, matches_parser, util},
	support::num::{ExtendedBigDecimal, fast_inc},
};

mod seq_format {
	use std::{
		io::{self, Write},
		iter,
	};

	use bigdecimal::{BigDecimal, num_bigint::ToBigInt};
	use num_traits::{Signed, Zero};
	use thiserror::Error;

	use crate::support::num::ExtendedBigDecimal;

	#[derive(Clone, Copy, Debug, Eq, PartialEq)]
	pub(super) enum FloatVariant {
		Decimal,
		Scientific,
		Shortest,
		Hexadecimal,
	}

	#[derive(Clone, Copy, Debug, Eq, PartialEq)]
	enum Case {
		Lower,
		Upper,
	}

	#[derive(Clone, Copy, Debug, Eq, PartialEq)]
	pub(super) enum NumberAlignment {
		Left,
		RightSpace,
		RightZero,
	}

	#[derive(Clone, Copy, Debug)]
	pub(super) struct FloatFormat {
		pub(super) variant:   FloatVariant,
		pub(super) width:     usize,
		pub(super) alignment: NumberAlignment,
		pub(super) precision: Option<usize>,
		case:                 Case,
		force_decimal:        bool,
		positive_sign:        Option<u8>,
	}

	impl Default for FloatFormat {
		fn default() -> Self {
			Self {
				variant:       FloatVariant::Decimal,
				width:         0,
				alignment:     NumberAlignment::Left,
				precision:     None,
				case:          Case::Lower,
				force_decimal: false,
				positive_sign: None,
			}
		}
	}

	#[derive(Debug, Error)]
	pub(super) enum SeqFormatError {
		#[error("format has no % directive")]
		NoDirective,
		#[error("format has too many % directives")]
		TooManyDirectives,
		#[error("invalid conversion specification")]
		InvalidSpecification,
		#[error("formatting width is too large")]
		WidthTooLarge,
	}

	pub(super) struct SeqFormat {
		prefix:    Vec<u8>,
		suffix:    Vec<u8>,
		formatter: FloatFormat,
	}

	impl SeqFormat {
		pub(super) fn from_formatter(formatter: FloatFormat) -> Self {
			Self { prefix: Vec::new(), suffix: Vec::new(), formatter }
		}

		pub(super) fn parse(source: &str) -> Result<Self, SeqFormatError> {
			let bytes = source.as_bytes();
			let mut prefix = Vec::new();
			let mut suffix = Vec::new();
			let mut formatter = None;
			let mut index = 0;
			while index < bytes.len() {
				if bytes[index] != b'%' {
					if formatter.is_some() {
						suffix.push(bytes[index]);
					} else {
						prefix.push(bytes[index]);
					}
					index += 1;
					continue;
				}
				if bytes.get(index + 1) == Some(&b'%') {
					if formatter.is_some() {
						suffix.push(b'%');
					} else {
						prefix.push(b'%');
					}
					index += 2;
					continue;
				}
				if formatter.is_some() {
					return Err(SeqFormatError::TooManyDirectives);
				}

				index += 1;
				let mut left = false;
				let mut plus = false;
				let mut space = false;
				let mut alternate = false;
				let mut zero = false;
				while let Some(flag) = bytes.get(index) {
					match flag {
						b'-' => left = true,
						b'+' => plus = true,
						b' ' => space = true,
						b'#' => alternate = true,
						b'0' => zero = true,
						_ => break,
					}
					index += 1;
				}

				let width_start = index;
				while bytes.get(index).is_some_and(u8::is_ascii_digit) {
					index += 1;
				}
				let width = if index == width_start {
					0
				} else {
					source[width_start..index]
						.parse()
						.map_err(|_| SeqFormatError::WidthTooLarge)?
				};
				if width > 1_000_000 {
					return Err(SeqFormatError::WidthTooLarge);
				}

				let precision = if bytes.get(index) == Some(&b'.') {
					index += 1;
					let precision_start = index;
					while bytes.get(index).is_some_and(u8::is_ascii_digit) {
						index += 1;
					}
					Some(if index == precision_start {
						0
					} else {
						source[precision_start..index]
							.parse()
							.map_err(|_| SeqFormatError::InvalidSpecification)?
					})
				} else {
					None
				};

				if bytes.get(index) == Some(&b'L') {
					index += 1;
				}
				let conversion = *bytes
					.get(index)
					.ok_or(SeqFormatError::InvalidSpecification)?;
				index += 1;
				let (variant, case) = match conversion {
					b'f' => (FloatVariant::Decimal, Case::Lower),
					b'F' => (FloatVariant::Decimal, Case::Upper),
					b'e' => (FloatVariant::Scientific, Case::Lower),
					b'E' => (FloatVariant::Scientific, Case::Upper),
					b'g' => (FloatVariant::Shortest, Case::Lower),
					b'G' => (FloatVariant::Shortest, Case::Upper),
					b'a' => (FloatVariant::Hexadecimal, Case::Lower),
					b'A' => (FloatVariant::Hexadecimal, Case::Upper),
					_ => return Err(SeqFormatError::InvalidSpecification),
				};
				formatter = Some(FloatFormat {
					variant,
					width,
					alignment: if left {
						NumberAlignment::Left
					} else if zero {
						NumberAlignment::RightZero
					} else {
						NumberAlignment::RightSpace
					},
					precision,
					case,
					force_decimal: alternate,
					positive_sign: plus.then_some(b'+').or_else(|| space.then_some(b' ')),
				});
			}

			Ok(Self { prefix, suffix, formatter: formatter.ok_or(SeqFormatError::NoDirective)? })
		}

		pub(super) fn fmt(
			&self,
			mut writer: impl Write,
			value: &ExtendedBigDecimal,
		) -> io::Result<()> {
			writer.write_all(&self.prefix)?;
			self.formatter.fmt(&mut writer, value)?;
			writer.write_all(&self.suffix)
		}
	}

	impl FloatFormat {
		pub(super) fn decimal(width: usize, precision: usize) -> Self {
			Self {
				variant: FloatVariant::Decimal,
				width,
				alignment: NumberAlignment::RightZero,
				precision: Some(precision),
				..Self::default()
			}
		}

		pub(super) fn shortest() -> Self {
			Self { variant: FloatVariant::Shortest, ..Self::default() }
		}

		fn fmt(&self, writer: impl Write, value: &ExtendedBigDecimal) -> io::Result<()> {
			let (absolute, negative) = match value {
				ExtendedBigDecimal::BigDecimal(decimal) => (Some(decimal.abs()), decimal.is_negative()),
				ExtendedBigDecimal::MinusZero => (Some(BigDecimal::zero()), true),
				ExtendedBigDecimal::Infinity => (None, false),
				ExtendedBigDecimal::MinusInfinity => (None, true),
				ExtendedBigDecimal::Nan => (None, false),
				ExtendedBigDecimal::MinusNan => (None, true),
			};
			let finite = absolute.is_some();
			let text = if let Some(decimal) = absolute {
				match self.variant {
					FloatVariant::Decimal => {
						format_decimal(&decimal, self.precision, self.force_decimal)
					},
					FloatVariant::Scientific => {
						format_scientific(&decimal, self.precision, self.case, self.force_decimal)
					},
					FloatVariant::Shortest => {
						format_shortest(&decimal, self.precision, self.case, self.force_decimal)
					},
					FloatVariant::Hexadecimal => {
						format_hexadecimal(&decimal, self.precision, self.case, self.force_decimal)
					},
				}
			} else {
				let mut text =
					if matches!(value, ExtendedBigDecimal::Infinity | ExtendedBigDecimal::MinusInfinity)
					{
						"inf".to_owned()
					} else {
						"nan".to_owned()
					};
				if self.case == Case::Upper {
					text.make_ascii_uppercase();
				}
				text
			};
			let sign = if negative {
				Some(b'-')
			} else {
				self.positive_sign
			};
			let alignment = if finite || self.alignment != NumberAlignment::RightZero {
				self.alignment
			} else {
				NumberAlignment::RightSpace
			};
			write_output(writer, sign, &text, self.width, alignment)
		}
	}

	fn format_decimal(decimal: &BigDecimal, precision: Option<usize>, force: bool) -> String {
		let precision = precision.unwrap_or(6);
		if precision == 0 {
			let (integer, scale) = decimal.as_bigint_and_scale();
			if scale == 0 && !force {
				return integer.to_str_radix(10);
			}
			if force {
				return format!("{decimal:.0}.");
			}
		}
		format!("{decimal:.precision$}")
	}

	fn decimal_digits_with_precision(decimal: &BigDecimal, precision: usize) -> (String, i64) {
		let rounded = decimal.with_prec(precision as u64);
		let (fraction, mut scale) = rounded.as_bigint_and_exponent();
		let mut digits = fraction.to_str_radix(10);
		if digits.len() == precision + 1 {
			digits.truncate(precision);
			scale -= 1;
		}
		(digits, -scale + precision as i64 - 1)
	}

	fn format_scientific(
		decimal: &BigDecimal,
		precision: Option<usize>,
		case: Case,
		force: bool,
	) -> String {
		let precision = precision.unwrap_or(6);
		let exponent_char = if case == Case::Lower { 'e' } else { 'E' };
		if decimal.is_zero() {
			return if force && precision == 0 {
				format!("0.{exponent_char}+00")
			} else {
				format!("{:.precision$}{exponent_char}+00", 0.0)
			};
		}
		let (digits, exponent) = decimal_digits_with_precision(decimal, precision + 1);
		let (first, rest) = digits.split_at(1);
		let dot = if !rest.is_empty() || (precision == 0 && force) {
			"."
		} else {
			""
		};
		format!("{first}{dot}{rest}{exponent_char}{exponent:+03}")
	}

	fn format_shortest(
		decimal: &BigDecimal,
		precision: Option<usize>,
		case: Case,
		force: bool,
	) -> String {
		let precision = precision.unwrap_or(6).max(1);
		if decimal.is_zero() {
			return match (force, precision) {
				(true, 1) => "0.".to_owned(),
				(true, _) => format!("{:.*}", precision - 1, 0.0),
				(false, _) => "0".to_owned(),
			};
		}
		let (digits, exponent) = decimal_digits_with_precision(decimal, precision);
		let mut output = String::with_capacity(precision + 8);
		if exponent < -4 || exponent >= precision as i64 {
			let (first, rest) = digits.split_at(1);
			output.push_str(first);
			output.push('.');
			output.push_str(rest);
			if !force {
				trim_fraction(&mut output);
			}
			output.push(if case == Case::Lower { 'e' } else { 'E' });
			output.push(if exponent < 0 { '-' } else { '+' });
			let absolute = exponent.unsigned_abs();
			if absolute < 10 {
				output.push('0');
			}
			output.push_str(&absolute.to_string());
		} else {
			if exponent < 0 {
				output.push_str("0.");
				output.extend(iter::repeat_n('0', -exponent as usize - 1));
				output.push_str(&digits);
			} else {
				let split = exponent as usize + 1;
				if split < digits.len() {
					let (whole, fraction) = digits.split_at(split);
					output.push_str(whole);
					output.push('.');
					output.push_str(fraction);
				} else {
					output.push_str(&digits);
					output.extend(iter::repeat_n('0', split - digits.len()));
					if force {
						output.push('.');
					}
				}
			}
			if !force {
				trim_fraction(&mut output);
			}
		}
		output
	}

	fn format_hexadecimal(
		decimal: &BigDecimal,
		precision: Option<usize>,
		case: Case,
		force: bool,
	) -> String {
		let max_precision = precision.unwrap_or(15);
		let (prefix, exponent_char) = if case == Case::Lower {
			("0x", 'p')
		} else {
			("0X", 'P')
		};
		if decimal.is_zero() {
			return if force && precision.unwrap_or(0) == 0 {
				format!("{prefix}0.{exponent_char}+0")
			} else {
				format!("{prefix}{:.*}{exponent_char}+0", precision.unwrap_or(0), 0.0)
			};
		}

		let (fraction_10, scale) = decimal.as_bigint_and_exponent();
		let exponent_10 = -scale;
		let (mut fraction_2, mut exponent_2) = if exponent_10 >= 0 {
			(fraction_10 * 5.to_bigint().unwrap().pow(exponent_10 as u32), exponent_10)
		} else {
			let margin = ((max_precision + 1) as i64 * 4 - fraction_10.bits() as i64).max(0)
				+ -exponent_10 * 3
				+ 1;
			(
				(fraction_10 << margin) / 5.to_bigint().unwrap().pow(-exponent_10 as u32),
				exponent_10 - margin,
			)
		};
		const BEFORE_BITS: usize = 4;
		let wanted_bits = (BEFORE_BITS + max_precision * 4) as u64;
		let bits = fraction_2.bits();
		exponent_2 += bits as i64 - wanted_bits as i64;
		if bits > wanted_bits {
			fraction_2 >>= bits - wanted_bits - 1;
			let round_up = fraction_2.bit(0);
			fraction_2 >>= 1;
			if round_up {
				fraction_2 += 1;
				if fraction_2.bits() > wanted_bits {
					fraction_2 >>= 4;
					exponent_2 += 4;
				}
			}
		} else {
			fraction_2 <<= wanted_bits - bits;
		}

		let mut digits = fraction_2.to_str_radix(16);
		if case == Case::Upper {
			digits.make_ascii_uppercase();
		}
		let (first, rest) = digits.split_at(1);
		let mut rest = rest.to_owned();
		if precision.is_none() {
			while rest.ends_with('0') {
				rest.pop();
			}
		}
		let dot = if !rest.is_empty() || (precision.unwrap_or(0) == 0 && force) {
			"."
		} else {
			""
		};
		let exponent = exponent_2 + (4 * max_precision) as i64;
		format!("{prefix}{first}{dot}{rest}{exponent_char}{exponent:+}")
	}

	fn trim_fraction(text: &mut String) {
		if let Some(dot) = text.find('.') {
			while text.ends_with('0') {
				text.pop();
			}
			if text.len() == dot + 1 {
				text.pop();
			}
		}
	}

	fn write_output(
		mut writer: impl Write,
		sign: Option<u8>,
		text: &str,
		width: usize,
		alignment: NumberAlignment,
	) -> io::Result<()> {
		let sign_len = usize::from(sign.is_some());
		let remaining = width.saturating_sub(sign_len);
		if width > 1_000_000 {
			return Err(io::Error::new(io::ErrorKind::OutOfMemory, "formatting width too large"));
		}
		if width == 0 {
			if let Some(sign) = sign {
				writer.write_all(&[sign])?;
			}
			return writer.write_all(text.as_bytes());
		}
		match alignment {
			NumberAlignment::Left => {
				if let Some(sign) = sign {
					writer.write_all(&[sign])?;
				}
				write!(writer, "{text:<remaining$}")
			},
			NumberAlignment::RightSpace => {
				let total = text.len() + sign_len;
				for _ in 0..width.saturating_sub(total) {
					writer.write_all(b" ")?;
				}
				if let Some(sign) = sign {
					writer.write_all(&[sign])?;
				}
				writer.write_all(text.as_bytes())
			},
			NumberAlignment::RightZero => {
				if let Some(sign) = sign {
					writer.write_all(&[sign])?;
				}
				let (prefix, rest) = if text.len() >= 2 && text[..2].eq_ignore_ascii_case("0x") {
					(&text[..2], &text[2..])
				} else {
					("", text)
				};
				writer.write_all(prefix.as_bytes())?;
				let digits_width = remaining.saturating_sub(prefix.len());
				for _ in 0..digits_width.saturating_sub(rest.len()) {
					writer.write_all(b"0")?;
				}
				writer.write_all(rest.as_bytes())
			},
		}
	}
}

mod number {
	use num_traits::Zero;

	use crate::support::num::ExtendedBigDecimal;

	/// A number with a specified number of integer and fractional digits.
	///
	/// This struct can be used to represent a number along with information
	/// on how many significant digits to use when displaying the number.
	/// The [`PreciseNumber::num_integral_digits`] field also includes the width
	/// needed to display the "-" character for a negative number.
	/// [`PreciseNumber::num_fractional_digits`] provides the number of decimal
	/// digits after the decimal point (a.k.a. precision), or None if that number
	/// cannot intuitively be obtained (i.e. hexadecimal floats).
	/// Note: Those 2 fields should not necessarily be interpreted literally, but
	/// as matching GNU `seq` behavior: the exact way of guessing desired
	/// precision from user input is a matter of interpretation.
	///
	/// You can get an instance of this struct by calling [`str::parse`].
	#[derive(Debug)]
	pub struct PreciseNumber {
		pub number:                ExtendedBigDecimal,
		pub num_integral_digits:   usize,
		pub num_fractional_digits: Option<usize>,
	}

	impl PreciseNumber {
		pub fn one() -> Self {
			// We would like to implement `num_traits::One`, but it requires
			// a multiplication implementation, and we don't want to
			// implement that here.
			Self {
				number:                ExtendedBigDecimal::one(),
				num_integral_digits:   1,
				num_fractional_digits: Some(0),
			}
		}

		/// Decide whether this number is zero (either positive or negative).
		pub fn is_zero(&self) -> bool {
			// We would like to implement `num_traits::Zero`, but it
			// requires an addition implementation, and we don't want to
			// implement that here.
			self.number.is_zero()
		}
	}
}

mod numberparse {
	//! Parsing numbers for use in `seq`.
	//!
	//! This module provides an implementation of [`FromStr`] for the
	//! [`PreciseNumber`] struct.
	use std::str::FromStr;

	use super::number::PreciseNumber;
	use crate::support::num::{ExtendedBigDecimal, ExtendedParser, ExtendedParserError};

	/// An error returned when parsing a number fails.
	#[derive(Debug, PartialEq, Eq)]
	pub enum ParseNumberError {
		Float,
		Nan,
	}

	/// Compute the number of integral and fractional digits in input string,
	/// and wrap the result in a PreciseNumber.
	/// We know that the string has already been parsed correctly, so we don't
	/// need to be too careful.
	fn compute_num_digits(input: &str, ebd: ExtendedBigDecimal) -> PreciseNumber {
		let input = input.to_lowercase();
		let input = input.trim_start();

		// Leading + is ignored for this.
		let input = input.strip_prefix('+').unwrap_or(input);

		// Integral digits for any hex number is ill-defined (0 is fine as an output)
		// Fractional digits for an floating hex number is ill-defined, return None
		// as we'll totally ignore that number for precision computations.
		// Still return 0 for hex integers though.
		if input.starts_with("0x") || input.starts_with("-0x") {
			return PreciseNumber {
				number:                ebd,
				num_integral_digits:   0,
				num_fractional_digits: if input.contains('.') || input.contains('p') {
					None
				} else {
					Some(0)
				},
			};
		}

		// Split the exponent part, if any
		let parts: Vec<&str> = input.split('e').collect();
		debug_assert!(parts.len() <= 2);

		// Count all the digits up to `.`, `-` sign is included.
		let (mut int_digits, mut frac_digits) = match parts[0].find('.') {
			Some(i) => {
				// Cover special case .X and -.X where we behave as if there was a leading 0:
				// 0.X, -0.X.
				let int_digits = match i {
					0 => 1,
					1 if parts[0].starts_with('-') => 2,
					_ => i,
				};

				(int_digits, parts[0].len() - i - 1)
			},
			None => (parts[0].len(), 0),
		};

		// If there is an exponent, reparse that (yes this is not optimal,
		// but we can't necessarily exactly recover that from the parsed number).
		if parts.len() == 2 {
			let exp = parts[1].parse::<i64>().unwrap_or(0);
			// For positive exponents, effectively expand the number. Ignore negative
			// exponents. Also ignore overflowed exponents (unwrap_or(0)).
			if exp > 0 {
				int_digits += exp.try_into().unwrap_or(0);
			}
			frac_digits = if exp < frac_digits as i64 {
				// Subtract from i128 to avoid any overflow
				(frac_digits as i128 - exp as i128).try_into().unwrap_or(0)
			} else {
				0
			}
		}

		PreciseNumber {
			number:                ebd,
			num_integral_digits:   int_digits,
			num_fractional_digits: Some(frac_digits),
		}
	}

	// Note: We could also have provided an `ExtendedParser` implementation for
	// PreciseNumber, but we want a simpler custom error.
	impl FromStr for PreciseNumber {
		type Err = ParseNumberError;

		fn from_str(input: &str) -> Result<Self, Self::Err> {
			let ebd = match ExtendedBigDecimal::extended_parse(input) {
				Ok(ebd) => match ebd {
					// Handle special values
					ExtendedBigDecimal::BigDecimal(_) | ExtendedBigDecimal::MinusZero => {
						// TODO: GNU `seq` treats small numbers < 1e-4950 as 0, we could do the same
						// to avoid printing senselessly small numbers.
						ebd
					},
					ExtendedBigDecimal::Infinity | ExtendedBigDecimal::MinusInfinity => {
						return Ok(Self {
							number:                ebd,
							num_integral_digits:   0,
							num_fractional_digits: Some(0),
						});
					},
					ExtendedBigDecimal::Nan | ExtendedBigDecimal::MinusNan => {
						return Err(ParseNumberError::Nan);
					},
				},
				Err(ExtendedParserError::Underflow(ebd)) => ebd, // Treat underflow as 0
				Err(_) => return Err(ParseNumberError::Float),
			};

			Ok(compute_num_digits(input, ebd))
		}
	}

	#[cfg(test)]
	mod tests {
		use bigdecimal::BigDecimal;

		use super::{super::number::PreciseNumber, ParseNumberError};
		use crate::support::num::ExtendedBigDecimal;

		/// Convenience function for parsing a [`Number`] and unwrapping.
		fn parse(s: &str) -> ExtendedBigDecimal {
			s.parse::<PreciseNumber>().unwrap().number
		}

		/// Convenience function for getting the number of integral digits.
		fn num_integral_digits(s: &str) -> usize {
			s.parse::<PreciseNumber>().unwrap().num_integral_digits
		}

		/// Convenience function for getting the number of fractional digits.
		fn num_fractional_digits(s: &str) -> usize {
			s.parse::<PreciseNumber>()
				.unwrap()
				.num_fractional_digits
				.unwrap()
		}

		/// Convenience function for making sure the number of fractional digits
		/// is "None"
		fn num_fractional_digits_is_none(s: &str) -> bool {
			s.parse::<PreciseNumber>()
				.unwrap()
				.num_fractional_digits
				.is_none()
		}

		#[test]
		fn test_parse_minus_zero_int() {
			assert_eq!(parse("-0e0"), ExtendedBigDecimal::MinusZero);
			assert_eq!(parse("-0e-0"), ExtendedBigDecimal::MinusZero);
			assert_eq!(parse("-0e1"), ExtendedBigDecimal::MinusZero);
			assert_eq!(parse("-0e+1"), ExtendedBigDecimal::MinusZero);
			assert_eq!(parse("-0.0e1"), ExtendedBigDecimal::MinusZero);
			assert_eq!(parse("-0x0"), ExtendedBigDecimal::MinusZero);
		}

		#[test]
		fn test_parse_minus_zero_float() {
			assert_eq!(parse("-0.0"), ExtendedBigDecimal::MinusZero);
			assert_eq!(parse("-0e-1"), ExtendedBigDecimal::MinusZero);
			assert_eq!(parse("-0.0e-1"), ExtendedBigDecimal::MinusZero);
		}

		#[test]
		fn test_parse_big_int() {
			assert_eq!(parse("0"), ExtendedBigDecimal::zero());
			assert_eq!(parse("0.1e1"), ExtendedBigDecimal::one());
			assert_eq!(parse("0.1E1"), ExtendedBigDecimal::one());
			assert_eq!(
				parse("1.0e1"),
				ExtendedBigDecimal::BigDecimal("10".parse::<BigDecimal>().unwrap())
			);
		}

		#[test]
		fn test_parse_hexadecimal_big_int() {
			assert_eq!(parse("0x0"), ExtendedBigDecimal::zero());
			assert_eq!(
				parse("0x10"),
				ExtendedBigDecimal::BigDecimal("16".parse::<BigDecimal>().unwrap())
			);
		}

		#[test]
		fn test_parse_big_decimal() {
			assert_eq!(
				parse("0.0"),
				ExtendedBigDecimal::BigDecimal("0.0".parse::<BigDecimal>().unwrap())
			);
			assert_eq!(
				parse(".0"),
				ExtendedBigDecimal::BigDecimal("0.0".parse::<BigDecimal>().unwrap())
			);
			assert_eq!(
				parse("1.0"),
				ExtendedBigDecimal::BigDecimal("1.0".parse::<BigDecimal>().unwrap())
			);
			assert_eq!(
				parse("10e-1"),
				ExtendedBigDecimal::BigDecimal("1.0".parse::<BigDecimal>().unwrap())
			);
			assert_eq!(
				parse("-1e-3"),
				ExtendedBigDecimal::BigDecimal("-0.001".parse::<BigDecimal>().unwrap())
			);
		}

		#[test]
		fn test_parse_inf() {
			assert_eq!(parse("inf"), ExtendedBigDecimal::Infinity);
			assert_eq!(parse("infinity"), ExtendedBigDecimal::Infinity);
			assert_eq!(parse("+inf"), ExtendedBigDecimal::Infinity);
			assert_eq!(parse("+infinity"), ExtendedBigDecimal::Infinity);
			assert_eq!(parse("-inf"), ExtendedBigDecimal::MinusInfinity);
			assert_eq!(parse("-infinity"), ExtendedBigDecimal::MinusInfinity);
		}

		#[test]
		fn test_parse_invalid_float() {
			assert_eq!("1.2.3".parse::<PreciseNumber>().unwrap_err(), ParseNumberError::Float);
			assert_eq!("1e2e3".parse::<PreciseNumber>().unwrap_err(), ParseNumberError::Float);
			assert_eq!("1e2.3".parse::<PreciseNumber>().unwrap_err(), ParseNumberError::Float);
			assert_eq!("-+-1".parse::<PreciseNumber>().unwrap_err(), ParseNumberError::Float);
		}

		#[test]
		fn test_parse_invalid_hex() {
			assert_eq!("0xg".parse::<PreciseNumber>().unwrap_err(), ParseNumberError::Float);
		}

		#[test]
		fn test_parse_invalid_nan() {
			assert_eq!("nan".parse::<PreciseNumber>().unwrap_err(), ParseNumberError::Nan);
			assert_eq!("NAN".parse::<PreciseNumber>().unwrap_err(), ParseNumberError::Nan);
			assert_eq!("NaN".parse::<PreciseNumber>().unwrap_err(), ParseNumberError::Nan);
			assert_eq!("nAn".parse::<PreciseNumber>().unwrap_err(), ParseNumberError::Nan);
			assert_eq!("-nan".parse::<PreciseNumber>().unwrap_err(), ParseNumberError::Nan);
		}

		#[test]
		fn test_num_integral_digits() {
			// no decimal, no exponent
			assert_eq!(num_integral_digits("123"), 3);
			// decimal, no exponent
			assert_eq!(num_integral_digits("123.45"), 3);
			assert_eq!(num_integral_digits("-0.1"), 2);
			assert_eq!(num_integral_digits("-.1"), 2);
			// exponent, no decimal
			assert_eq!(num_integral_digits("123e4"), 3 + 4);
			assert_eq!(num_integral_digits("123e-4"), 3);
			assert_eq!(num_integral_digits("-1e-3"), 2);
			// decimal and exponent
			assert_eq!(num_integral_digits("123.45e6"), 3 + 6);
			assert_eq!(num_integral_digits("123.45e-6"), 3);
			assert_eq!(num_integral_digits("123.45e-1"), 3);
			assert_eq!(num_integral_digits("-0.1e0"), 2);
			assert_eq!(num_integral_digits("-0.1e2"), 4);
			assert_eq!(num_integral_digits("-.1e0"), 2);
			assert_eq!(num_integral_digits("-.1e2"), 4);
			assert_eq!(num_integral_digits("-1.e-3"), 2);
			assert_eq!(num_integral_digits("-1.0e-4"), 2);
			// minus zero int
			assert_eq!(num_integral_digits("-0e0"), 2);
			assert_eq!(num_integral_digits("-0e-0"), 2);
			assert_eq!(num_integral_digits("-0e1"), 3);
			assert_eq!(num_integral_digits("-0e+1"), 3);
			assert_eq!(num_integral_digits("-0.0e1"), 3);
			// minus zero float
			assert_eq!(num_integral_digits("-0.0"), 2);
			assert_eq!(num_integral_digits("-0e-1"), 2);
			assert_eq!(num_integral_digits("-0.0e-1"), 2);

			// TODO In GNU `seq`, the `-w` option does not seem to work with
			// hexadecimal arguments. In order to match that behavior, we
			// report the number of integral digits as zero for hexadecimal
			// inputs.
			assert_eq!(num_integral_digits("0xff"), 0);
		}

		#[test]
		fn test_num_fractional_digits() {
			// no decimal, no exponent
			assert_eq!(num_fractional_digits("123"), 0);
			assert_eq!(num_fractional_digits("0xff"), 0);
			// decimal, no exponent
			assert_eq!(num_fractional_digits("123.45"), 2);
			assert_eq!(num_fractional_digits("-0.1"), 1);
			assert_eq!(num_fractional_digits("-.1"), 1);
			// exponent, no decimal
			assert_eq!(num_fractional_digits("123e4"), 0);
			assert_eq!(num_fractional_digits("123e-4"), 4);
			assert_eq!(num_fractional_digits("123e-1"), 1);
			assert_eq!(num_fractional_digits("-1e-3"), 3);
			// decimal and exponent
			assert_eq!(num_fractional_digits("123.45e6"), 0);
			assert_eq!(num_fractional_digits("123.45e1"), 1);
			assert_eq!(num_fractional_digits("123.45e-6"), 8);
			assert_eq!(num_fractional_digits("123.45e-1"), 3);
			assert_eq!(num_fractional_digits("-0.1e0"), 1);
			assert_eq!(num_fractional_digits("-0.1e2"), 0);
			assert_eq!(num_fractional_digits("-.1e0"), 1);
			assert_eq!(num_fractional_digits("-.1e2"), 0);
			assert_eq!(num_fractional_digits("-1.e-3"), 3);
			assert_eq!(num_fractional_digits("-1.0e-4"), 5);
			// minus zero int
			assert_eq!(num_fractional_digits("-0e0"), 0);
			assert_eq!(num_fractional_digits("-0e-0"), 0);
			assert_eq!(num_fractional_digits("-0e1"), 0);
			assert_eq!(num_fractional_digits("-0e+1"), 0);
			assert_eq!(num_fractional_digits("-0.0e1"), 0);
			// minus zero float
			assert_eq!(num_fractional_digits("-0.0"), 1);
			assert_eq!(num_fractional_digits("-0e-1"), 1);
			assert_eq!(num_fractional_digits("-0.0e-1"), 2);
			// Hexadecimal numbers
			assert_eq!(num_fractional_digits("0xff"), 0);
			assert!(num_fractional_digits_is_none("0xff.1"));
		}

		#[test]
		fn test_parse_min_exponents() {
			// Make sure exponents < i64::MIN do not cause errors
			assert!("1e-9223372036854775807".parse::<PreciseNumber>().is_ok());
			assert!("1e-9223372036854775808".parse::<PreciseNumber>().is_ok());
			assert!("1e-92233720368547758080".parse::<PreciseNumber>().is_ok());
		}

		#[test]
		fn test_parse_max_exponents() {
			// Make sure exponents much bigger than i64::MAX cause errors
			assert!("1e9223372036854775807".parse::<PreciseNumber>().is_ok());
			assert!("1e92233720368547758070".parse::<PreciseNumber>().is_err());
		}
	}
}

mod error {
	//! Errors returned by seq.

	// Message lookups are literalized with the en-US strings from the bundled
	// locale data.

	use thiserror::Error;

	use super::numberparse::ParseNumberError;
	use crate::support::quote::Quotable;

	#[derive(Debug, Error)]
	pub enum SeqError {
		/// An error parsing the input arguments.
		///
		/// The parameters are the [`String`] argument as read from the
		/// command line and the underlying parsing error itself.
		#[error("invalid {} argument: {}", parse_error_type(.1), .0.quote())]
		ParseError(String, ParseNumberError),

		/// The increment argument was zero, which is not allowed.
		///
		/// The parameter is the increment argument as a [`String`] as read
		/// from the command line.
		#[error("invalid Zero increment value: {}", .0.quote())]
		ZeroIncrement(String),

		/// No arguments were passed to this function, 1 or more is required
		#[error("missing operand")]
		NoArguments,

		/// Both a format and equal width where passed to seq
		#[error("format string may not be specified when printing equal width strings")]
		FormatAndEqualWidth,
	}

	fn parse_error_type(e: &ParseNumberError) -> &'static str {
		match e {
			ParseNumberError::Float => "floating point",
			ParseNumberError::Nan => "'not-a-number'",
		}
	}
}

use std::io;

use self::{
	error::SeqError,
	number::PreciseNumber,
	seq_format::{FloatFormat, SeqFormat},
};

const OPT_SEPARATOR: &str = "separator";
const OPT_TERMINATOR: &str = "terminator";
const OPT_EQUAL_WIDTH: &str = "equal-width";
const OPT_FORMAT: &str = "format";

const ARG_NUMBERS: &str = "numbers";

/// How many emitted numbers to print between cancellation polls.
const CANCEL_POLL_INTERVAL: u64 = 4096;

#[derive(Clone)]
struct SeqOptions<'a> {
	separator:   OsString,
	terminator:  OsString,
	equal_width: bool,
	format:      Option<&'a str>,
}

/// A range of floats.
///
/// The elements are (first, increment, last).
type RangeFloat = (ExtendedBigDecimal, ExtendedBigDecimal, ExtendedBigDecimal);

/// Turn short args with attached value, for example "-s,", into two args "-s"
/// and "," to make them work with clap.
fn split_short_args_with_value(args: Vec<OsString>) -> Vec<OsString> {
	let mut v: Vec<OsString> = Vec::new();

	for arg in args {
		let bytes = arg.as_encoded_bytes();

		if bytes.len() > 2
			&& (bytes.starts_with(b"-f") || bytes.starts_with(b"-s") || bytes.starts_with(b"-t"))
		{
			let (short_arg, value) = bytes.split_at(2);
			// SAFETY:
			// Both `short_arg` and `value` only contain content that originated from
			// `OsStr::as_encoded_bytes`
			// SAFETY: Each slice is a contiguous subset of bytes returned by
			// `OsStr::as_encoded_bytes`, so it remains valid for this platform's
			// `OsString` encoding.
			v.push(unsafe { OsString::from_encoded_bytes_unchecked(short_arg.to_vec()) });
			// SAFETY: See the preceding conversion; `value` has the same origin.
			v.push(unsafe { OsString::from_encoded_bytes_unchecked(value.to_vec()) });
		} else {
			v.push(arg);
		}
	}

	v
}

fn select_precision(
	first: &PreciseNumber,
	increment: &PreciseNumber,
	last: &PreciseNumber,
) -> Option<usize> {
	match (first.num_fractional_digits, increment.num_fractional_digits, last.num_fractional_digits)
	{
		(Some(0), Some(0), Some(0)) => Some(0),
		(Some(f), Some(i), Some(_)) => Some(f.max(i)),
		_ => None,
	}
}

/// Parsed `seq` invocation.
pub(crate) struct Seq {
	matches: ArgMatches,
}

matches_parser!(Seq, uu_app);

impl Utility for Seq {
	const NAME: &'static str = "seq";

	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		Ok(split_short_args_with_value(argv))
	}

	fn run(self, host: &mut Host) -> i32 {
		match seq_main(&self.matches, host) {
			Ok(()) => host.exit_code(),
			Err(err) => {
				host.error(err, 1);
				1
			},
		}
	}
}

fn seq_main(matches: &ArgMatches, host: &mut Host) -> Result<(), Box<dyn Error>> {
	let numbers_option = matches.get_many::<String>(ARG_NUMBERS);

	if numbers_option.is_none() {
		return Err(SeqError::NoArguments.into());
	}

	let numbers = numbers_option.unwrap().collect::<Vec<_>>();

	let options = SeqOptions {
		separator:   matches
			.get_one::<OsString>(OPT_SEPARATOR)
			.cloned()
			.unwrap_or_else(|| OsString::from("\n")),
		terminator:  matches
			.get_one::<OsString>(OPT_TERMINATOR)
			.cloned()
			.unwrap_or_else(|| OsString::from("\n")),
		equal_width: matches.get_flag(OPT_EQUAL_WIDTH),
		format:      matches.get_one::<String>(OPT_FORMAT).map(String::as_str),
	};

	if options.equal_width && options.format.is_some() {
		return Err(SeqError::FormatAndEqualWidth.into());
	}

	let first = if numbers.len() > 1 {
		match numbers[0].parse() {
			Ok(num) => num,
			Err(e) => return Err(SeqError::ParseError(numbers[0].to_owned(), e).into()),
		}
	} else {
		PreciseNumber::one()
	};
	let increment = if numbers.len() > 2 {
		match numbers[1].parse() {
			Ok(num) => num,
			Err(e) => return Err(SeqError::ParseError(numbers[1].to_owned(), e).into()),
		}
	} else {
		PreciseNumber::one()
	};
	if increment.is_zero() {
		return Err(SeqError::ZeroIncrement(numbers[1].to_owned()).into());
	}
	let last: PreciseNumber = {
		// We are guaranteed that `numbers.len()` is greater than zero
		// and at most three because of the argument specification in
		// `uu_app()`.
		let n: usize = numbers.len();
		match numbers[n - 1].parse() {
			Ok(num) => num,
			Err(e) => return Err(SeqError::ParseError(numbers[n - 1].to_owned(), e).into()),
		}
	};

	// If a format was passed on the command line, use that.
	// If not, use some default format based on parameters precision.
	let (format, padding, fast_allowed) = if let Some(str) = options.format {
		(SeqFormat::parse(str)?, 0, false)
	} else {
		let precision = select_precision(&first, &increment, &last);

		let padding = if options.equal_width {
			let precision_value = precision.unwrap_or(0);
			first
				.num_integral_digits
				.max(increment.num_integral_digits)
				.max(last.num_integral_digits)
				+ if precision_value > 0 {
					precision_value + 1
				} else {
					0
				}
		} else {
			0
		};

		let formatter = match precision {
			// format with precision: decimal floats and integers
			Some(precision) => FloatFormat::decimal(padding, precision),
			// format without precision: hexadecimal floats
			None => FloatFormat::shortest(),
		};
		// Allow fast printing if precision is 0 (integer inputs), `print_seq` will do
		// further checks.
		(SeqFormat::from_formatter(formatter), padding, precision == Some(0))
	};

	let result = print_seq(
		host,
		(first.number, increment.number, last.number),
		&options.separator,
		&options.terminator,
		&format,
		fast_allowed,
		padding,
	);

	match result {
		Ok(()) => Ok(()),
		Err(err) if err.kind() == io::ErrorKind::BrokenPipe => {
			// GNU seq prints the Broken pipe message but still exits with status 0.
			let _ = writeln!(host.stderr, "seq: write error: {err}");
			Ok(())
		},
		Err(err) => Err(format!("write error: {err}").into()),
	}
}

fn uu_app() -> Command {
	Command::new(Seq::NAME)
		.trailing_var_arg(true)
		.infer_long_args(true)
		.version("0.8.0")
		.about("Display numbers from FIRST to LAST, in steps of INCREMENT.")
		.override_usage(format_usage(
			"seq [OPTION]... LAST\nseq [OPTION]... FIRST LAST\nseq [OPTION]... FIRST INCREMENT LAST",
		))
		.arg(
			Arg::new(OPT_SEPARATOR)
				.short('s')
				.long("separator")
				.help("Separator character (defaults to \\n)")
				.value_parser(clap::value_parser!(OsString)),
		)
		.arg(
			Arg::new(OPT_TERMINATOR)
				.short('t')
				.long("terminator")
				.help("Terminator character (defaults to \\n)")
				.value_parser(clap::value_parser!(OsString)),
		)
		.arg(
			Arg::new(OPT_EQUAL_WIDTH)
				.short('w')
				.long("equal-width")
				.help("Equalize widths of all numbers by padding with zeros")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_FORMAT)
				.short('f')
				.long(OPT_FORMAT)
				.help("use printf style floating-point FORMAT"),
		)
		.arg(
			// we use allow_hyphen_values instead of allow_negative_numbers because clap removed
			// the support for "exotic" negative numbers like -.1 (see https://github.com/clap-rs/clap/discussions/5837)
			Arg::new(ARG_NUMBERS)
				.allow_hyphen_values(true)
				.action(ArgAction::Append)
				.num_args(1..=3),
		)
}

/// Integer print, default format, positive increment: fast code path
/// that avoids reformatting digit at all iterations.
fn fast_print_seq(
	host: &Host,
	mut stdout: impl Write,
	first: &BigUint,
	increment: u64,
	last: &BigUint,
	separator: &OsStr,
	terminator: &OsStr,
	padding: usize,
) -> io::Result<()> {
	// Nothing to do, just return.
	if last < first {
		return Ok(());
	}

	// Do at most u64::MAX loops. We can print in the order of 1e8 digits per
	// second, u64::MAX is 1e19, so it'd take hundreds of years for this to
	// complete anyway. TODO: we can move this test to `print_seq` if we care about
	// this case.
	let loop_cnt = ((last - first) / increment).to_u64().unwrap_or(u64::MAX);

	// Format the first number.
	let first_str = first.to_string();

	// Makeshift log10.ceil
	let last_length = last.to_string().len();

	// Allocate a large u8 buffer, that contains a preformatted string
	// of the number followed by the `separator`.
	//
	// | ... head space ... | number | separator |
	// ^0                   ^ start  ^ num_end   ^ size (==buf.len())
	//
	// We keep track of start in this buffer, as the number grows.
	// When printing, we take a slice between start and end.
	let size = last_length.max(padding) + separator.len();
	// Fill with '0', this is needed for equal_width, and harmless otherwise.
	let mut buf = vec![b'0'; size];
	let buf = buf.as_mut_slice();

	let num_end = buf.len() - separator.len();
	let mut start = num_end - first_str.len();

	// Initialize buf with first and separator.
	buf[start..num_end].copy_from_slice(first_str.as_bytes());
	buf[num_end..].copy_from_slice(separator.as_encoded_bytes());

	// Normally, if padding is > 0, it should be equal to last_length,
	// so start would be == 0, but there are corner cases.
	start = start.min(num_end - padding);

	// Prepare the number to increment with as a string
	let inc_str = increment.to_string();
	let inc_str = inc_str.as_bytes();

	for i in 0..loop_cnt {
		// Poll periodically so shell abort/timeout is observed.
		if i % CANCEL_POLL_INTERVAL == 0 && host.is_cancelled() {
			return Ok(());
		}
		stdout.write_all(&buf[start..])?;
		fast_inc(buf, &mut start, num_end, inc_str);
	}
	// Write the last number without separator, but with terminator.
	stdout.write_all(&buf[start..num_end])?;
	stdout.write_all(terminator.as_encoded_bytes())?;
	stdout.flush()?;
	Ok(())
}

fn done_printing<T: Zero + PartialOrd>(next: &T, increment: &T, last: &T) -> bool {
	if increment >= &T::zero() {
		next > last
	} else {
		next < last
	}
}

/// Arbitrary precision decimal number code path ("slow" path)
fn print_seq(
	host: &Host,
	range: RangeFloat,
	separator: &OsStr,
	terminator: &OsStr,
	format: &SeqFormat,
	fast_allowed: bool,
	padding: usize, // Used by fast path only
) -> io::Result<()> {
	let mut stdout = BufWriter::new(host.stdout_clone());
	let (first, increment, last) = range;

	if fast_allowed {
		// Test if we can use fast code path.
		// First try to convert the range to BigUint (u64 for the increment).
		let (first_bui, increment_u64, last_bui) =
			(first.to_biguint(), increment.to_biguint().and_then(|x| x.to_u64()), last.to_biguint());
		if let (Some(first_bui), Some(increment_u64), Some(last_bui)) =
			(first_bui, increment_u64, last_bui)
		{
			return fast_print_seq(
				host,
				stdout,
				&first_bui,
				increment_u64,
				&last_bui,
				separator,
				terminator,
				padding,
			);
		}
	}

	let mut value = first;

	let mut is_first_iteration = true;
	let mut iterations: u64 = 0;
	while !done_printing(&value, &increment, &last) {
		// Poll periodically so shell abort/timeout is observed.
		if iterations.is_multiple_of(CANCEL_POLL_INTERVAL) && host.is_cancelled() {
			return Ok(());
		}
		iterations += 1;
		if !is_first_iteration {
			stdout.write_all(separator.as_encoded_bytes())?;
		}
		format.fmt(&mut stdout, &value)?;
		// TODO Implement augmenting addition.
		value = value + increment.clone();
		is_first_iteration = false;
	}
	if !is_first_iteration {
		stdout.write_all(terminator.as_encoded_bytes())?;
	}
	stdout.flush()?;
	Ok(())
}
/// Creates the `seq` builtin registration.
pub(crate) fn seq_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Seq, SE>()
}

#[cfg(test)]
mod tests {
	use clap::Parser;

	use super::Seq;
	use crate::host::{Host, Utility, run_util};

	fn run(args: &[&str]) -> (i32, String, String) {
		let (code, capture) = run_util::<Seq>(args, "", "/");
		(code, capture.out(), capture.err())
	}

	#[test]
	fn single_operand_counts_from_one() {
		assert_eq!(run(&["3"]), (0, "1\n2\n3\n".into(), String::new()));
	}

	#[test]
	fn first_increment_last_arithmetic() {
		assert_eq!(run(&["2", "2", "10"]), (0, "2\n4\n6\n8\n10\n".into(), String::new()));
	}

	#[test]
	fn separator_joins_values_terminator_ends_them() {
		assert_eq!(run(&["-s", ",", "1", "3"]), (0, "1,2,3\n".into(), String::new()));
		assert_eq!(run(&["-s,", "1", "3"]), (0, "1,2,3\n".into(), String::new()));
	}

	#[test]
	fn equal_width_pads_with_zeros() {
		assert_eq!(run(&["-w", "8", "10"]), (0, "08\n09\n10\n".into(), String::new()));
	}

	#[test]
	fn float_increment_selects_widest_precision() {
		assert_eq!(run(&["1", "0.5", "2"]), (0, "1.0\n1.5\n2.0\n".into(), String::new()));
	}

	#[test]
	fn invalid_operand_reports_error_and_fails() {
		assert_eq!(
			run(&["foo"]),
			(1, String::new(), "seq: invalid floating point argument: 'foo'\n".into())
		);
	}

	#[test]
	fn zero_increment_is_rejected() {
		assert_eq!(
			run(&["1", "0", "5"]),
			(1, String::new(), "seq: invalid Zero increment value: '0'\n".into())
		);
	}

	#[test]
	fn custom_format_is_preserved() {
		assert_eq!(run(&["-f", "%04.1f", "1", "2"]), (0, "01.0\n02.0\n".into(), String::new()));
	}

	#[test]
	fn custom_general_format_selects_fixed_and_scientific_forms() {
		assert_eq!(
			run(&["-f", "%.3g", "0.00001", "0.00001", "0.00003"]),
			(0, "1e-05\n2e-05\n3e-05\n".into(), String::new())
		);
		assert_eq!(
			run(&["-f", "%.3g", "1", "499", "999"]),
			(0, "1\n500\n999\n".into(), String::new())
		);
	}

	#[test]
	fn custom_scientific_format_preserves_precision_and_literals() {
		assert_eq!(
			run(&["-f", "value=%+.2e%%", "1", "2"]),
			(0, "value=+1.00e+00%\nvalue=+2.00e+00%\n".into(), String::new())
		);
	}

	#[test]
	fn hexadecimal_float_parsing_is_preserved() {
		assert_eq!(run(&["0x1p0", "0x1p0", "0x3p0"]), (0, "1\n2\n3\n".into(), String::new()));
	}

	#[test]
	fn cancelled_host_stops_emission() {
		let seq = Seq::try_parse_from(["seq", "1", "1000000"]).unwrap();
		let (mut host, capture) = Host::for_test("seq", Vec::new(), "/");
		host.cancel_for_test();
		assert_eq!(seq.run(&mut host), 0);
		assert_eq!(capture.out(), "");
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn help_renders_to_stdout() {
		let (code, capture) = run_util::<Seq>(&["--help"], "", "/");
		assert_eq!(code, 0);
		assert!(capture.out().contains("Usage:"));
		assert!(capture.out().contains("steps of INCREMENT"));
		assert_eq!(capture.err(), "");
	}
}
