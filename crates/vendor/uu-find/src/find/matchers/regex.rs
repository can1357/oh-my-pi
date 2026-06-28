// Copyright 2022 Collabora, Ltd.
//
// Use of this source code is governed by a MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

use std::{error::Error, fmt, str::FromStr};

use onig::{Regex, RegexOptions, Syntax};

use super::{Matcher, MatcherIO, WalkEntry};

#[derive(Debug)]
pub struct ParseRegexTypeError(String);

impl Error for ParseRegexTypeError {}

impl fmt::Display for ParseRegexTypeError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(
			f,
			"Invalid regex type: {} (must be one of {})",
			self.0,
			RegexType::VALUES
				.iter()
				.map(|t| format!("'{t}'"))
				.collect::<Vec<_>>()
				.join(", ")
		)
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RegexType {
	#[default]
	Emacs,
	Grep,
	PosixBasic,
	PosixExtended,
}

impl RegexType {
	pub const VALUES: &'static [Self] =
		&[Self::Emacs, Self::Grep, Self::PosixBasic, Self::PosixExtended];
}

impl fmt::Display for RegexType {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Emacs => write!(f, "emacs"),
			Self::Grep => write!(f, "grep"),
			Self::PosixBasic => write!(f, "posix-basic"),
			Self::PosixExtended => write!(f, "posix-extended"),
		}
	}
}

impl FromStr for RegexType {
	type Err = ParseRegexTypeError;

	fn from_str(s: &str) -> Result<Self, Self::Err> {
		match s {
			"emacs" => Ok(Self::Emacs),
			"grep" => Ok(Self::Grep),
			"posix-basic" => Ok(Self::PosixBasic),
			"posix-extended" => Ok(Self::PosixExtended),
			// ed and sed are the same as posix-basic
			"ed" | "sed" => Ok(Self::PosixBasic),
			_ => Err(ParseRegexTypeError(s.to_owned())),
		}
	}
}

pub struct RegexMatcher {
	regex: Regex,
}

impl RegexMatcher {
	pub fn new(
		regex_type: RegexType,
		pattern: &str,
		ignore_case: bool,
	) -> Result<Self, Box<dyn Error>> {
		let syntax = match regex_type {
			RegexType::Emacs => Syntax::emacs(),
			RegexType::Grep => Syntax::grep(),
			RegexType::PosixBasic => Syntax::posix_basic(),
			RegexType::PosixExtended => Syntax::posix_extended(),
		};

		let regex = Regex::with_options(
			pattern,
			if ignore_case {
				RegexOptions::REGEX_OPTION_IGNORECASE
			} else {
				RegexOptions::REGEX_OPTION_NONE
			},
			syntax,
		)?;
		Ok(Self { regex })
	}
}

impl Matcher for RegexMatcher {
	fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
		self
			.regex
			.is_match(file_info.display_path().to_string_lossy().as_ref())
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::find::{matchers::tests::get_dir_entry_for, tests::FakeDependencies};

	const POSIX_BASIC_INTERVALS_RE: &str = r".*/ab\{1,3\}c";
	const POSIX_EXTENDED_INTERVALS_RE: &str = r".*/ab{1,3}c";
	const EMACS_AND_POSIX_EXTENDED_KLEENE_PLUS: &str = r".*/ab+c";

	// Variants of fix_up_slashes that properly escape the forward slashes for
	// being in a regex.
	#[cfg(windows)]
	fn fix_up_regex_slashes(re: &str) -> String {
		re.replace("/", r"\\")
	}

	#[cfg(not(windows))]
	fn fix_up_regex_slashes(re: &str) -> String {
		re.to_owned()
	}

	#[test]
	fn case_sensitive_matching() {
		let abbbc = get_dir_entry_for("test_data/simple", "abbbc");
		let matcher =
			RegexMatcher::new(RegexType::Emacs, &fix_up_regex_slashes(".*/ab.BC"), false).unwrap();
		let deps = FakeDependencies::new();
		assert!(!matcher.matches(&abbbc, &mut deps.new_matcher_io()));
	}

	#[test]
	fn case_insensitive_matching() {
		let abbbc = get_dir_entry_for("test_data/simple", "abbbc");
		let matcher =
			RegexMatcher::new(RegexType::Emacs, &fix_up_regex_slashes(".*/ab.BC"), true).unwrap();
		let deps = FakeDependencies::new();
		assert!(matcher.matches(&abbbc, &mut deps.new_matcher_io()));
	}

	#[test]
	fn emacs_regex() {
		// Emacs syntax is mostly the same as POSIX extended but with escaped
		// brace intervals.
		let abbbc = get_dir_entry_for("test_data/simple", "abbbc");

		let matcher = RegexMatcher::new(
			RegexType::Emacs,
			&fix_up_regex_slashes(EMACS_AND_POSIX_EXTENDED_KLEENE_PLUS),
			true,
		)
		.unwrap();
		let deps = FakeDependencies::new();
		assert!(matcher.matches(&abbbc, &mut deps.new_matcher_io()));

		let matcher = RegexMatcher::new(
			RegexType::Emacs,
			&fix_up_regex_slashes(POSIX_EXTENDED_INTERVALS_RE),
			true,
		)
		.unwrap();
		let deps = FakeDependencies::new();
		assert!(!matcher.matches(&abbbc, &mut deps.new_matcher_io()));
	}

	#[test]
	fn posix_basic_regex() {
		let abbbc = get_dir_entry_for("test_data/simple", "abbbc");

		let matcher = RegexMatcher::new(
			RegexType::PosixBasic,
			&fix_up_regex_slashes(POSIX_BASIC_INTERVALS_RE),
			true,
		)
		.unwrap();
		let deps = FakeDependencies::new();
		assert!(matcher.matches(&abbbc, &mut deps.new_matcher_io()));

		let matcher = RegexMatcher::new(
			RegexType::PosixBasic,
			&fix_up_regex_slashes(POSIX_EXTENDED_INTERVALS_RE),
			true,
		)
		.unwrap();
		let deps = FakeDependencies::new();
		assert!(!matcher.matches(&abbbc, &mut deps.new_matcher_io()));
	}

	#[test]
	fn posix_extended_regex() {
		let abbbc = get_dir_entry_for("test_data/simple", "abbbc");

		let matcher = RegexMatcher::new(
			RegexType::PosixExtended,
			&fix_up_regex_slashes(POSIX_EXTENDED_INTERVALS_RE),
			true,
		)
		.unwrap();
		let deps = FakeDependencies::new();
		assert!(matcher.matches(&abbbc, &mut deps.new_matcher_io()));

		let matcher = RegexMatcher::new(
			RegexType::PosixExtended,
			&fix_up_regex_slashes(POSIX_BASIC_INTERVALS_RE),
			true,
		)
		.unwrap();
		let deps = FakeDependencies::new();
		assert!(!matcher.matches(&abbbc, &mut deps.new_matcher_io()));
	}
}
