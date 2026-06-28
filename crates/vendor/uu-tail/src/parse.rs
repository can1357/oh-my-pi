// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

use std::ffi::OsString;

#[derive(PartialEq, Eq, Debug, Copy, Clone)]
pub struct ObsoleteArgs {
	pub num:    u64,
	pub plus:   bool,
	pub lines:  bool,
	pub follow: bool,
}

impl Default for ObsoleteArgs {
	fn default() -> Self {
		Self { num: 10, plus: false, lines: true, follow: false }
	}
}

#[derive(PartialEq, Eq, Debug)]
pub enum ParseError {
	Context,
	InvalidEncoding,
}
/// Parses obsolete syntax
/// tail -\[NUM\]\[bcl\]\[f\] and tail +\[NUM\]\[bcl\]\[f\]
pub fn parse_obsolete(src: &OsString) -> Option<Result<ObsoleteArgs, ParseError>> {
	let Some(mut rest) = src.to_str() else {
		return Some(Err(ParseError::InvalidEncoding));
	};
	let sign = if let Some(r) = rest.strip_prefix('-') {
		rest = r;
		'-'
	} else {
		let r = rest.strip_prefix('+')?;
		rest = r;
		'+'
	};

	let end_num = rest
		.find(|c: char| !c.is_ascii_digit())
		.unwrap_or(rest.len());
	let has_num = !rest[..end_num].is_empty();
	let num: u64 = if has_num {
		rest[..end_num].parse().unwrap_or(u64::MAX)
	} else {
		10
	};
	rest = &rest[end_num..];

	let mode = if let Some(r) = rest.strip_prefix('l') {
		rest = r;
		'l'
	} else if let Some(r) = rest.strip_prefix('c') {
		rest = r;
		'c'
	} else if let Some(r) = rest.strip_prefix('b') {
		rest = r;
		'b'
	} else {
		'l'
	};

	let follow = rest.contains('f');
	if !rest.chars().all(|f| f == 'f') {
		// GNU allows an arbitrary amount of following fs, but nothing else
		if sign == '-' && has_num {
			return Some(Err(ParseError::Context));
		}
		return None;
	}

	let multiplier = if mode == 'b' { 512 } else { 1 };
	let num = num.saturating_mul(multiplier);

	Some(Ok(ObsoleteArgs { num, plus: sign == '+', lines: mode == 'l', follow }))
}

#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn test_parse_numbers_obsolete() {
		assert_eq!(
			parse_obsolete(&OsString::from("+2c")),
			Some(Ok(ObsoleteArgs { num: 2, plus: true, lines: false, follow: false }))
		);
		assert_eq!(
			parse_obsolete(&OsString::from("-5")),
			Some(Ok(ObsoleteArgs { num: 5, plus: false, lines: true, follow: false }))
		);
		assert_eq!(
			parse_obsolete(&OsString::from("+100f")),
			Some(Ok(ObsoleteArgs { num: 100, plus: true, lines: true, follow: true }))
		);
		assert_eq!(
			parse_obsolete(&OsString::from("-2b")),
			Some(Ok(ObsoleteArgs { num: 1024, plus: false, lines: false, follow: false }))
		);
	}
	#[test]
	fn test_parse_errors_obsolete() {
		assert_eq!(parse_obsolete(&OsString::from("-5n")), Some(Err(ParseError::Context)));
		assert_eq!(parse_obsolete(&OsString::from("-5c5")), Some(Err(ParseError::Context)));
		assert_eq!(parse_obsolete(&OsString::from("-1vzc")), Some(Err(ParseError::Context)));
		assert_eq!(parse_obsolete(&OsString::from("-5m")), Some(Err(ParseError::Context)));
		assert_eq!(parse_obsolete(&OsString::from("-1k")), Some(Err(ParseError::Context)));
		assert_eq!(parse_obsolete(&OsString::from("-1mmk")), Some(Err(ParseError::Context)));
		assert_eq!(parse_obsolete(&OsString::from("-105kzm")), Some(Err(ParseError::Context)));
		assert_eq!(parse_obsolete(&OsString::from("-1vz")), Some(Err(ParseError::Context)));
		assert_eq!(
			parse_obsolete(&OsString::from("-1vzqvq")), // spell-checker:disable-line
			Some(Err(ParseError::Context))
		);
	}
	#[test]
	fn test_parse_obsolete_no_match() {
		assert_eq!(parse_obsolete(&OsString::from("-k")), None);
		assert_eq!(parse_obsolete(&OsString::from("asd")), None);
		assert_eq!(parse_obsolete(&OsString::from("-cc")), None);
	}
}
