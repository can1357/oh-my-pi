//! `seq` builtin: display numbers from FIRST to LAST in steps of INCREMENT.
//!
//! Ported from uutils coreutils 0.8.0.

use std::{
	error::Error,
	ffi::{OsStr, OsString},
	io::{BufWriter, Write},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use num_bigint::BigUint;
use num_traits::{ToPrimitive, Zero};
use uucore::{
	extendedbigdecimal::ExtendedBigDecimal,
	fast_inc::fast_inc,
	format::{Format, num_format, num_format::FloatVariant},
};

use crate::host::{Host, Utility, format_usage, matches_parser, util};

mod number {
use num_traits::Zero;
use uucore::extendedbigdecimal::ExtendedBigDecimal;

/// A number with a specified number of integer and fractional digits.
///
/// This struct can be used to represent a number along with information
/// on how many significant digits to use when displaying the number.
/// The [`PreciseNumber::num_integral_digits`] field also includes the width
/// needed to display the "-" character for a negative number.
/// [`PreciseNumber::num_fractional_digits`] provides the number of decimal
/// digits after the decimal point (a.k.a. precision), or None if that number
/// cannot intuitively be obtained (i.e. hexadecimal floats).
/// Note: Those 2 fields should not necessarily be interpreted literally, but as
/// matching GNU `seq` behavior: the exact way of guessing desired precision
/// from user input is a matter of interpretation.
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

use uucore::{
	extendedbigdecimal::ExtendedBigDecimal,
	parser::num_parser::{ExtendedParser, ExtendedParserError},
};

use super::number::PreciseNumber;

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
	use uucore::extendedbigdecimal::ExtendedBigDecimal;

	use super::{ParseNumberError, super::number::PreciseNumber};

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

	/// Convenience function for making sure the number of fractional digits is
	/// "None"
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
		assert_eq!(parse(".0"), ExtendedBigDecimal::BigDecimal("0.0".parse::<BigDecimal>().unwrap()));
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

// pi-uutils: `translate!` message lookups are literalized with the en-US
// strings from upstream's locales/en-US.ftl.

use thiserror::Error;
use uucore::display::Quotable;

use super::numberparse::ParseNumberError;

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

use self::{error::SeqError, number::PreciseNumber};

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
			v.push(unsafe { OsString::from_encoded_bytes_unchecked(short_arg.to_vec()) });
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
		(Format::<num_format::Float, &ExtendedBigDecimal>::parse(str)?, 0, false)
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
			Some(precision) => num_format::Float {
				variant: FloatVariant::Decimal,
				width: padding,
				alignment: num_format::NumberAlignment::RightZero,
				precision: Some(precision),
				..Default::default()
			},
			// format without precision: hexadecimal floats
			None => num_format::Float { variant: FloatVariant::Shortest, ..Default::default() },
		};
		// Allow fast printing if precision is 0 (integer inputs), `print_seq` will do
		// further checks.
		(Format::from_formatter(formatter), padding, precision == Some(0))
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

	result.map_err(|err| format!("write error: {err}").into())
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
) -> std::io::Result<()> {
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
	format: &Format<num_format::Float, &ExtendedBigDecimal>,
	fast_allowed: bool,
	padding: usize, // Used by fast path only
) -> std::io::Result<()> {
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
		assert_eq!(run(&["foo"]), (1, String::new(), "seq: invalid floating point argument: 'foo'\n".into()));
	}

	#[test]
	fn zero_increment_is_rejected() {
		assert_eq!(run(&["1", "0", "5"]), (1, String::new(), "seq: invalid Zero increment value: '0'\n".into()));
	}

	#[test]
	fn custom_format_is_preserved() {
		assert_eq!(run(&["-f", "%04.1f", "1", "2"]), (0, "01.0\n02.0\n".into(), String::new()));
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
