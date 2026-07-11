// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

//! Fast comparison for strings representing a base 10 number without precision
//! loss.
//!
//! To be able to short-circuit when comparing, [`NumInfo`] must be passed along
//! with each number to [`numeric_str_cmp`]. [`NumInfo`] is generally obtained
//! by calling [`NumInfo::parse`] and should be cached. It is allowed to
//! arbitrarily modify the exponent afterward, which is equivalent to shifting
//! the decimal point.
//!
//! More specifically, exponent can be understood so that the original number is
//! in `(1..10)*10^exponent`. From that follows the constraints of this
//! algorithm: It is able to compare numbers in
//! ±(1*10^[`i64::MIN`]..10*10^[`i64::MAX`]).

use std::{cmp::Ordering, ops::Range};

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord, Clone)]
enum Sign {
	Negative,
	Positive,
}

#[derive(Debug, PartialEq, Eq, Clone)]
pub struct NumInfo {
	exponent: i64,
	sign:     Sign,
}
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct NumInfoParseSettings {
	pub accept_si_units:     bool,
	pub thousands_separator: Option<u8>,
	pub decimal_pt:          Option<u8>,
}

impl Default for NumInfoParseSettings {
	fn default() -> Self {
		Self {
			accept_si_units:     false,
			thousands_separator: None,
			decimal_pt:          Some(b'.'),
		}
	}
}

impl NumInfo {
	/// Parse [`NumInfo`] for this number.
	/// Also returns the range of num that should be passed to
	/// [`numeric_str_cmp`] later.
	///
	/// Leading zeros will be excluded from the returned range. If the number
	/// consists of only zeros, an empty range (idx..idx) is returned so that
	/// idx is the char after the last zero. If the input is not a number (which
	/// has to be treated as zero), the returned empty range will be 0..0.
	#[allow(clippy::cognitive_complexity)]
	pub fn parse(num: &[u8], parse_settings: &NumInfoParseSettings) -> (Self, Range<usize>) {
		let mut exponent = -1;
		let mut had_decimal_pt = false;
		let mut had_digit = false;
		let mut start = None;
		let mut sign = Sign::Positive;

		let mut first_char = true;

		for (idx, &char) in num.iter().enumerate() {
			if first_char && char.is_ascii_whitespace() {
				continue;
			}

			if first_char && char == b'-' {
				sign = Sign::Negative;
				first_char = false;
				continue;
			}
			first_char = false;

			if matches!(
				 parse_settings.thousands_separator,
				 Some(c) if c == char
			) {
				continue;
			}

			if Self::is_invalid_char(char, &mut had_decimal_pt, parse_settings) {
				return if let Some(start) = start {
					let has_si_unit = parse_settings.accept_si_units
						&& matches!(
							char,
							b'K' | b'k' | b'M' | b'G' | b'T' | b'P' | b'E' | b'Z' | b'Y' | b'R' | b'Q'
						);
					(Self { exponent, sign }, start..if has_si_unit { idx + 1 } else { idx })
				} else {
					(
						Self { sign: Sign::Positive, exponent: 0 },
						if had_digit {
							// In this case there were only zeroes.
							// For debug output to work properly, we have to match the character after the
							// last zero.
							idx..idx
						} else {
							// This was no number at all.
							// For debug output to work properly, we have to match 0..0.
							0..0
						},
					)
				};
			}
			if Some(char) == parse_settings.decimal_pt {
				continue;
			}
			had_digit = true;
			if start.is_none() && char == b'0' {
				if had_decimal_pt {
					// We're parsing a number whose first nonzero digit is after the decimal point.
					exponent -= 1;
				} else {
					// Skip leading zeroes
					continue;
				}
			}
			if !had_decimal_pt {
				exponent += 1;
			}
			if start.is_none() && char != b'0' {
				start = Some(idx);
			}
		}
		if let Some(start) = start {
			(Self { exponent, sign }, start..num.len())
		} else {
			(
				Self { sign: Sign::Positive, exponent: 0 },
				if had_digit {
					// In this case there were only zeroes.
					// For debug output to work properly, we have to claim to match the end of the
					// number.
					num.len()..num.len()
				} else {
					// This was no number at all.
					// For debug output to work properly, we have to claim to match the start of the
					// number.
					0..0
				},
			)
		}
	}

	fn is_invalid_char(
		c: u8,
		had_decimal_pt: &mut bool,
		parse_settings: &NumInfoParseSettings,
	) -> bool {
		if Some(c) == parse_settings.decimal_pt {
			if *had_decimal_pt {
				// this is a decimal pt but we already had one, so it is invalid
				true
			} else {
				*had_decimal_pt = true;
				false
			}
		} else {
			!c.is_ascii_digit()
		}
	}
}

fn get_unit(unit: Option<u8>) -> u8 {
	if let Some(unit) = unit {
		match unit {
			b'K' | b'k' => 1,
			b'M' => 2,
			b'G' => 3,
			b'T' => 4,
			b'P' => 5,
			b'E' => 6,
			b'Z' => 7,
			b'Y' => 8,
			b'R' => 9,
			b'Q' => 10,
			_ => 0,
		}
	} else {
		0
	}
}

/// Compare two numbers according to the rules of human numeric comparison.
/// The SI-Unit takes precedence over the actual value (i.e. 2000M < 1G).
pub fn human_numeric_str_cmp(
	(a, a_info): (&[u8], &NumInfo),
	(b, b_info): (&[u8], &NumInfo),
) -> Ordering {
	// 1. Sign
	if a_info.sign != b_info.sign {
		return a_info.sign.cmp(&b_info.sign);
	}
	// 2. Unit
	let a_unit = get_unit(a.iter().next_back().copied());
	let b_unit = get_unit(b.iter().next_back().copied());
	let ordering = a_unit.cmp(&b_unit);
	if ordering == Ordering::Equal {
		// 3. Number
		numeric_str_cmp((a, a_info), (b, b_info))
	} else if a_info.sign == Sign::Negative {
		ordering.reverse()
	} else {
		ordering
	}
}

/// Compare two numbers as strings without parsing them as a number first. This
/// should be more performant and can handle numbers more precisely. [`NumInfo`]
/// is needed to provide a fast path for most numbers.
#[inline(always)]
pub fn numeric_str_cmp((a, a_info): (&[u8], &NumInfo), (b, b_info): (&[u8], &NumInfo)) -> Ordering {
	// check for a difference in the sign
	if a_info.sign != b_info.sign {
		return a_info.sign.cmp(&b_info.sign);
	}

	// check for a difference in the exponent
	let ordering = if a_info.exponent != b_info.exponent && !a.is_empty() && !b.is_empty() {
		a_info.exponent.cmp(&b_info.exponent)
	} else {
		// walk the characters from the front until we find a difference
		let mut a_chars = a.iter().copied().filter(u8::is_ascii_digit);
		let mut b_chars = b.iter().copied().filter(u8::is_ascii_digit);
		loop {
			let a_next = a_chars.next();
			let b_next = b_chars.next();
			match (a_next, b_next) {
				(None, None) => break Ordering::Equal,
				(Some(c), None) => {
					break if c == b'0' && a_chars.all(|c| c == b'0') {
						Ordering::Equal
					} else {
						Ordering::Greater
					};
				},
				(None, Some(c)) => {
					break if c == b'0' && b_chars.all(|c| c == b'0') {
						Ordering::Equal
					} else {
						Ordering::Less
					};
				},
				(Some(a_char), Some(b_char)) => {
					let ord = a_char.cmp(&b_char);
					if ord != Ordering::Equal {
						break ord;
					}
				},
			}
		}
	};

	if a_info.sign == Sign::Negative {
		ordering.reverse()
	} else {
		ordering
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_exp() {
		let n = b"1";
		assert_eq!(
			NumInfo::parse(n, &NumInfoParseSettings::default()),
			(NumInfo { exponent: 0, sign: Sign::Positive }, 0..1)
		);
		let n = b"100";
		assert_eq!(
			NumInfo::parse(n, &NumInfoParseSettings::default()),
			(NumInfo { exponent: 2, sign: Sign::Positive }, 0..3)
		);
		let n = b"1,000";
		assert_eq!(
			NumInfo::parse(n, &NumInfoParseSettings {
				thousands_separator: Some(b','),
				..Default::default()
			}),
			(NumInfo { exponent: 3, sign: Sign::Positive }, 0..5)
		);
		let n = b"1,000";
		assert_eq!(
			NumInfo::parse(n, &NumInfoParseSettings::default()),
			(NumInfo { exponent: 0, sign: Sign::Positive }, 0..1)
		);
		let n = b"1000.00";
		assert_eq!(
			NumInfo::parse(n, &NumInfoParseSettings::default()),
			(NumInfo { exponent: 3, sign: Sign::Positive }, 0..7)
		);
	}
	#[test]
	fn parses_negative_exp() {
		let n = b"0.00005";
		assert_eq!(
			NumInfo::parse(n, &NumInfoParseSettings::default()),
			(NumInfo { exponent: -5, sign: Sign::Positive }, 6..7)
		);
		let n = b"00000.00005";
		assert_eq!(
			NumInfo::parse(n, &NumInfoParseSettings::default()),
			(NumInfo { exponent: -5, sign: Sign::Positive }, 10..11)
		);
	}

	#[test]
	fn parses_sign() {
		let n = b"5";
		assert_eq!(
			NumInfo::parse(n, &NumInfoParseSettings::default()),
			(NumInfo { exponent: 0, sign: Sign::Positive }, 0..1)
		);
		let n = b"-5";
		assert_eq!(
			NumInfo::parse(n, &NumInfoParseSettings::default()),
			(NumInfo { exponent: 0, sign: Sign::Negative }, 1..2)
		);
		let n = b"    -5";
		assert_eq!(
			NumInfo::parse(n, &NumInfoParseSettings::default()),
			(NumInfo { exponent: 0, sign: Sign::Negative }, 5..6)
		);
	}

	fn test_helper(a: &[u8], b: &[u8], expected: Ordering) {
		let (a_info, a_range) = NumInfo::parse(a, &NumInfoParseSettings::default());
		let (b_info, b_range) = NumInfo::parse(b, &NumInfoParseSettings::default());
		let ordering =
			numeric_str_cmp((&a[a_range.clone()], &a_info), (&b[b_range.clone()], &b_info));
		assert_eq!(ordering, expected);
		let ordering = numeric_str_cmp((&b[b_range], &b_info), (&a[a_range], &a_info));
		assert_eq!(ordering, expected.reverse());
	}
	#[test]
	fn test_single_digit() {
		test_helper(b"1", b"2", Ordering::Less);
		test_helper(b"0", b"0", Ordering::Equal);
	}
	#[test]
	fn test_minus() {
		test_helper(b"-1", b"-2", Ordering::Greater);
		test_helper(b"-0", b"-0", Ordering::Equal);
	}
	#[test]
	fn test_different_len() {
		test_helper(b"-20", b"-100", Ordering::Greater);
		test_helper(b"10.0", b"2.000000", Ordering::Greater);
	}
	#[test]
	fn test_decimal_digits() {
		test_helper(b"20.1", b"20.2", Ordering::Less);
		test_helper(b"20.1", b"20.15", Ordering::Less);
		test_helper(b"-20.1", b"+20.15", Ordering::Less);
		test_helper(b"-20.1", b"-20", Ordering::Less);
	}
	#[test]
	fn test_trailing_zeroes() {
		test_helper(b"20.00000", b"20.1", Ordering::Less);
		test_helper(b"20.00000", b"20.0", Ordering::Equal);
	}
	#[test]
	fn test_invalid_digits() {
		test_helper(b"foo", b"bar", Ordering::Equal);
		test_helper(b"20.1", b"a", Ordering::Greater);
		test_helper(b"-20.1", b"a", Ordering::Less);
		test_helper(b"a", b"0.15", Ordering::Less);
	}
	#[test]
	fn test_multiple_decimal_pts() {
		test_helper(b"10.0.0", b"50.0.0", Ordering::Less);
		test_helper(b"0.1.", b"0.2.0", Ordering::Less);
		test_helper(b"1.1.", b"0", Ordering::Greater);
		test_helper(b"1.1.", b"-0", Ordering::Greater);
	}
	#[test]
	fn test_leading_decimal_pts() {
		test_helper(b".0", b".0", Ordering::Equal);
		test_helper(b".1", b".0", Ordering::Greater);
		test_helper(b".02", b"0", Ordering::Greater);
	}
	#[test]
	fn test_leading_zeroes() {
		test_helper(b"000000.0", b".0", Ordering::Equal);
		test_helper(b"0.1", b"0000000000000.0", Ordering::Greater);
		test_helper(b"-01", b"-2", Ordering::Greater);
	}

	#[test]
	fn minus_zero() {
		// This matches GNU sort behavior.
		test_helper(b"-0", b"0", Ordering::Equal);
		test_helper(b"-0x", b"0", Ordering::Equal);
	}
	#[test]
	fn double_minus() {
		test_helper(b"--1", b"0", Ordering::Equal);
	}
	#[test]
	fn single_minus() {
		let info = NumInfo::parse(b"-", &NumInfoParseSettings::default());
		assert_eq!(info, (NumInfo { exponent: 0, sign: Sign::Positive }, 0..0));
	}
	#[test]
	fn invalid_with_unit() {
		let info = NumInfo::parse(b"-K", &NumInfoParseSettings {
			accept_si_units: true,
			..Default::default()
		});
		assert_eq!(info, (NumInfo { exponent: 0, sign: Sign::Positive }, 0..0));
	}
}
