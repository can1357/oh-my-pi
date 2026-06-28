// Copyright 2017 Google Inc.
//
// Use of this source code is governed by a MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

//! find's permission matching uses a very unix-centric approach, that would
//! be tricky to both implement and use on a windows platform. So we don't
//! even try.

use std::{error::Error, io::Write};

use pi_uutils_ctx::stderr;
#[cfg(unix)]
use uucore::mode::{parse_numeric, parse_symbolic};

use super::{Matcher, MatcherIO, WalkEntry};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[cfg(unix)]
pub enum ComparisonType {
	/// mode bits have to match exactly
	Exact,
	/// all specified mode bits must be set. Others can be as well
	AtLeast,
	/// at least one of the specified bits must be set (or if no bits are
	/// specified then any mode will match)
	AnyOf,
}

#[cfg(unix)]
impl ComparisonType {
	fn mode_bits_match(self, pattern: u32, value: u32) -> bool {
		match self {
			Self::Exact => (0o7777 & value) == pattern,
			Self::AtLeast => (value & pattern) == pattern,
			Self::AnyOf => pattern == 0 || (value & pattern) > 0,
		}
	}
}

#[cfg(unix)]
mod parsing {
	use super::{ComparisonType, Error, parse_numeric, parse_symbolic};

	pub fn split_comparison_type(pattern: &str) -> (ComparisonType, &str) {
		let mut chars = pattern.chars();

		match chars.next() {
			Some('-') => (ComparisonType::AtLeast, chars.as_str()),
			Some('/') => (ComparisonType::AnyOf, chars.as_str()),
			_ => (ComparisonType::Exact, pattern),
		}
	}

	pub fn parse_mode(pattern: &str, for_dir: bool) -> Result<u32, Box<dyn Error>> {
		let mode = if pattern.contains(|c: char| c.is_ascii_digit()) {
			parse_numeric(0, pattern, for_dir)?
		} else {
			let mut mode = 0;
			for chunk in pattern.split(',') {
				mode = parse_symbolic(mode, chunk, 0, for_dir)?;
			}
			mode
		};
		Ok(mode)
	}
}

#[cfg(unix)]
#[derive(Debug)]
pub struct PermMatcher {
	comparison_type: ComparisonType,
	file_pattern:    u32,
	dir_pattern:     u32,
}

#[cfg(not(unix))]
pub struct PermMatcher {}

impl PermMatcher {
	#[cfg(unix)]
	pub fn new(pattern: &str) -> Result<Self, Box<dyn Error>> {
		let (comparison_type, pattern) = parsing::split_comparison_type(pattern);
		let file_pattern = parsing::parse_mode(pattern, false)?;
		let dir_pattern = parsing::parse_mode(pattern, false)?;
		Ok(Self { comparison_type, file_pattern, dir_pattern })
	}

	#[cfg(not(unix))]
	pub fn new(_dummy_pattern: &str) -> Result<PermMatcher, Box<dyn Error>> {
		Err(From::from("Permission matching is not available on this platform"))
	}
}

impl Matcher for PermMatcher {
	#[cfg(unix)]
	fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
		use std::os::unix::fs::PermissionsExt;
		match file_info.metadata() {
			Ok(metadata) => {
				let pattern = if metadata.is_dir() {
					self.dir_pattern
				} else {
					self.file_pattern
				};
				self
					.comparison_type
					.mode_bits_match(pattern, metadata.permissions().mode())
			},
			Err(e) => {
				writeln!(
					&mut stderr(),
					"Error getting permissions for {}: {}",
					file_info.path().to_string_lossy(),
					e
				)
				.unwrap();
				false
			},
		}
	}

	#[cfg(not(unix))]
	fn matches(&self, _dummy_file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
		writeln!(&mut stderr(), "Permission matching not available on this platform!").unwrap();
		return false;
	}
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
	use super::{ComparisonType::*, *};
	use crate::find::{matchers::tests::get_dir_entry_for, tests::FakeDependencies};

	#[track_caller]
	fn assert_parse(pattern: &str, comparison_type: ComparisonType, mode: u32) {
		let matcher = PermMatcher::new(pattern).unwrap();
		assert_eq!(matcher.comparison_type, comparison_type);
		assert_eq!(matcher.file_pattern, mode);
		assert_eq!(matcher.dir_pattern, mode);
	}

	#[test]
	fn parsing_prefix() {
		assert_parse("u=rwx", Exact, 0o700);
		assert_parse("-u=rwx", AtLeast, 0o700);
		assert_parse("/u=rwx", AnyOf, 0o700);

		assert_parse("700", Exact, 0o700);
		assert_parse("-700", AtLeast, 0o700);
		assert_parse("/700", AnyOf, 0o700);
	}

	#[test]
	fn parsing_octal() {
		assert_parse("/1", AnyOf, 0o001);
		assert_parse("/7777", AnyOf, 0o7777);
	}

	#[test]
	fn parsing_human_readable_individual_bits() {
		assert_parse("/u=r", AnyOf, 0o400);
		assert_parse("/u=w", AnyOf, 0o200);
		assert_parse("/u=x", AnyOf, 0o100);

		assert_parse("/g=r", AnyOf, 0o040);
		assert_parse("/g=w", AnyOf, 0o020);
		assert_parse("/g=x", AnyOf, 0o010);

		assert_parse("/o+r", AnyOf, 0o004);
		assert_parse("/o+w", AnyOf, 0o002);
		assert_parse("/o+x", AnyOf, 0o001);

		assert_parse("/a+r", AnyOf, 0o444);
		assert_parse("/a+w", AnyOf, 0o222);
		assert_parse("/a+x", AnyOf, 0o111);
	}

	#[test]
	fn parsing_human_readable_multiple_bits() {
		assert_parse("/u=rwx", AnyOf, 0o700);
		assert_parse("/a=rwx", AnyOf, 0o777);
	}

	#[test]
	fn parsing_human_readable_multiple_categories() {
		assert_parse("/u=rwx,g=rx,o+r", AnyOf, 0o754);
		assert_parse("/u=rwx,g=rx,o+r,a+w", AnyOf, 0o776);
		assert_parse("/ug=rwx,o+r", AnyOf, 0o774);
	}

	#[test]
	fn parsing_human_readable_set_id_bits() {
		assert_parse("/u=s", AnyOf, 0o4000);
		assert_parse("/g=s", AnyOf, 0o2000);
		assert_parse("/ug=s", AnyOf, 0o6000);
		assert_parse("/o=s", AnyOf, 0o0000);
	}

	#[test]
	fn parsing_human_readable_sticky_bit() {
		assert_parse("/o=t", AnyOf, 0o1000);
	}

	#[test]
	fn parsing_fails() {
		PermMatcher::new("urwx,g=rx,o+r").expect_err("missing equals should fail");
		PermMatcher::new("d=rwx,g=rx,o+r").expect_err("invalid category should fail");
		PermMatcher::new("u=dwx,g=rx,o+r").expect_err("invalid permission bit should fail");
		PermMatcher::new("u_rwx,g=rx,o+r")
			.expect_err("invalid category/permission separator should fail");
		PermMatcher::new("77777777777777").expect_err("overflowing octal value should fail");

		// FIXME: uucore::mode shouldn't accept this
		// PermMatcher::new("u=rwxg=rx,o+r")
		//     .expect_err("missing comma should fail");
	}

	#[test]
	fn comparison_type_matching() {
		let c = ComparisonType::Exact;
		assert!(c.mode_bits_match(0, 0), "Exact: only 0 should match if pattern is 0");
		assert!(!c.mode_bits_match(0, 0o444), "Exact: only 0 should match if pattern is 0");
		assert!(c.mode_bits_match(0o444, 0o444), "Exact: identical bits should match");
		assert!(!c.mode_bits_match(0o444, 0o777), "Exact: non-identical bits should fail");
		assert!(c.mode_bits_match(0o444, 0o70444), "Exact:high-end bits should be ignored");

		let c = ComparisonType::AtLeast;
		assert!(c.mode_bits_match(0, 0), "AtLeast: anything should match if pattern is 0");
		assert!(c.mode_bits_match(0, 0o444), "AtLeast: anything should match if pattern is 0");
		assert!(c.mode_bits_match(0o444, 0o777), "AtLeast: identical bits should match");
		assert!(c.mode_bits_match(0o444, 0o777), "AtLeast: extra bits should match");
		assert!(!c.mode_bits_match(0o444, 0o700), "AtLeast: missing bits should fail");
		assert!(c.mode_bits_match(0o444, 0o70444), "AtLeast: high-end bits should be ignored");

		let c = ComparisonType::AnyOf;
		assert!(c.mode_bits_match(0, 0), "AnyOf: anything should match if pattern is 0");
		assert!(c.mode_bits_match(0, 0o444), "AnyOf: anything should match if pattern is 0");
		assert!(c.mode_bits_match(0o444, 0o777), "AnyOf: identical bits should match");
		assert!(c.mode_bits_match(0o444, 0o777), "AnyOf: extra bits should match");
		assert!(
			c.mode_bits_match(0o777, 0o001),
			"AnyOf: anything should match as long as it has one bit in common"
		);
		assert!(!c.mode_bits_match(0o010, 0o001), "AnyOf: no matching bits shouldn't match");
		assert!(c.mode_bits_match(0o444, 0o70444), "AnyOf: high-end bits should be ignored");
	}

	#[test]
	fn perm_matches() {
		let file_info = get_dir_entry_for("test_data/simple", "abbbc");
		let deps = FakeDependencies::new();

		let matcher = PermMatcher::new("-u+r").unwrap();
		assert!(
			matcher.matches(&file_info, &mut deps.new_matcher_io()),
			"user-readable pattern should match file"
		);

		let matcher = PermMatcher::new("-u+x").unwrap();
		assert!(
			!matcher.matches(&file_info, &mut deps.new_matcher_io()),
			"user-executable pattern should not match file"
		);
	}
}
