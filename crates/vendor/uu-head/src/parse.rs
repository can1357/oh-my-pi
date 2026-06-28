// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

use std::ffi::OsString;

use uucore::parser::{
	parse_signed_num::{SignPrefix, parse_signed_num_max},
	parse_size::ParseSizeError,
};

#[derive(PartialEq, Eq, Debug)]
pub struct ParseError;

/// Parses obsolete syntax
/// head -NUM\[kmzv\] // spell-checker:disable-line
pub fn parse_obsolete(src: &str) -> Option<Result<Vec<OsString>, ParseError>> {
	let mut chars = src.char_indices();
	if let Some((mut num_start, '-')) = chars.next() {
		num_start += 1;
		let mut num_end = src.len();
		let mut has_num = false;
		let mut plus_possible = false;
		let mut last_char = 0 as char;
		for (n, c) in &mut chars {
			if c.is_ascii_digit() {
				has_num = true;
				plus_possible = false;
			} else if c == '+' && plus_possible {
				plus_possible = false;
				num_start += 1;
			} else {
				num_end = n;
				last_char = c;
				break;
			}
		}
		if has_num {
			Some(process_num_block(&src[num_start..num_end], last_char, &mut chars))
		} else {
			None
		}
	} else {
		None
	}
}

/// Processes the numeric block of the input string to generate the appropriate
/// options.
fn process_num_block(
	src: &str,
	last_char: char,
	chars: &mut std::str::CharIndices,
) -> Result<Vec<OsString>, ParseError> {
	let num = match src.parse::<usize>() {
		Ok(n) => n,
		Err(e) if *e.kind() == std::num::IntErrorKind::PosOverflow => usize::MAX,
		_ => return Err(ParseError),
	};
	let mut quiet = false;
	let mut verbose = false;
	let mut zero_terminated = false;
	let mut multiplier = None;
	let mut c = last_char;
	loop {
		// note that here, we only match lower case 'k', 'c', and 'm'
		match c {
			// we want to preserve order
			// this also saves us 1 heap allocation
			'q' => {
				quiet = true;
				verbose = false;
			},
			'v' => {
				verbose = true;
				quiet = false;
			},
			'z' => zero_terminated = true,
			'c' => multiplier = Some(1),
			'b' => multiplier = Some(512),
			'k' => multiplier = Some(1024),
			'm' => multiplier = Some(1024 * 1024),
			'\0' => {},
			_ => return Err(ParseError),
		}
		if let Some((_, next)) = chars.next() {
			c = next;
		} else {
			break;
		}
	}
	let mut options = Vec::new();
	if quiet {
		options.push(OsString::from("-q"));
	}
	if verbose {
		options.push(OsString::from("-v"));
	}
	if zero_terminated {
		options.push(OsString::from("-z"));
	}
	if let Some(n) = multiplier {
		options.push(OsString::from("-c"));
		let num = num.saturating_mul(n);
		options.push(OsString::from(format!("{num}")));
	} else {
		options.push(OsString::from("-n"));
		options.push(OsString::from(format!("{num}")));
	}
	Ok(options)
}

/// Parses an -c or -n argument,
/// the bool specifies whether to read from the end (all but last N)
pub fn parse_num(src: &str) -> Result<(u64, bool), ParseSizeError> {
	let result = parse_signed_num_max(src)?;
	// head: '-' means "all but last N"
	let all_but_last = result.sign == Some(SignPrefix::Minus);
	Ok((result.value, all_but_last))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn obsolete(src: &str) -> Option<Result<Vec<String>, ParseError>> {
		let r = parse_obsolete(src);
		match r {
			Some(s) => match s {
				Ok(v) => Some(Ok(v
					.into_iter()
					.map(|s| s.to_str().unwrap().to_owned())
					.collect())),
				Err(e) => Some(Err(e)),
			},
			None => None,
		}
	}

	#[expect(clippy::unnecessary_wraps, reason = "test helper")]
	fn obsolete_result(src: &[&str]) -> Option<Result<Vec<String>, ParseError>> {
		Some(Ok(src.iter().map(|&s| s.to_string()).collect()))
	}

	#[test]
	#[allow(clippy::cognitive_complexity)]
	fn test_parse_numbers_obsolete() {
		assert_eq!(obsolete("-5"), obsolete_result(&["-n", "5"]));
		assert_eq!(obsolete("-100"), obsolete_result(&["-n", "100"]));
		assert_eq!(obsolete("-5m"), obsolete_result(&["-c", "5242880"]));
		assert_eq!(obsolete("-1k"), obsolete_result(&["-c", "1024"]));
		assert_eq!(obsolete("-2b"), obsolete_result(&["-c", "1024"]));
		assert_eq!(obsolete("-1mmk"), obsolete_result(&["-c", "1024"]));
		assert_eq!(obsolete("-1vz"), obsolete_result(&["-v", "-z", "-n", "1"]));
		assert_eq!(
			obsolete("-1vzqvq"), // spell-checker:disable-line
			obsolete_result(&["-q", "-z", "-n", "1"])
		);
		assert_eq!(obsolete("-1vzc"), obsolete_result(&["-v", "-z", "-c", "1"]));
		assert_eq!(obsolete("-105kzm"), obsolete_result(&["-z", "-c", "110100480"]));
	}

	#[test]
	fn test_parse_errors_obsolete() {
		assert_eq!(obsolete("-5n"), Some(Err(ParseError)));
		assert_eq!(obsolete("-5c5"), Some(Err(ParseError)));
	}

	#[test]
	fn test_parse_obsolete_no_match() {
		assert_eq!(obsolete("-k"), None);
		assert_eq!(obsolete("asd"), None);
	}

	#[test]
	#[cfg(target_pointer_width = "64")]
	fn test_parse_obsolete_overflow_x64() {
		assert_eq!(obsolete("-1000000000000000m"), obsolete_result(&["-c", "18446744073709551615"]));
		assert_eq!(
			obsolete("-10000000000000000000000"),
			obsolete_result(&["-n", "18446744073709551615"])
		);
	}

	#[test]
	#[cfg(target_pointer_width = "32")]
	fn test_parse_obsolete_overflow_x32() {
		assert_eq!(obsolete("-42949672960"), obsolete_result(&["-n", "4294967295"]));
		assert_eq!(obsolete("-42949672k"), obsolete_result(&["-c", "4294967295"]));
	}
}
