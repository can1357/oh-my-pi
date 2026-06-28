// Copyright 2017 Google Inc.
//
// Use of this source code is governed by a MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

use super::{Matcher, MatcherIO, WalkEntry, glob::Pattern};

/// This matcher makes a comparison of the path against a shell wildcard
/// pattern. See `glob::Pattern` for details on the exact syntax.
pub struct PathMatcher {
	pattern: Pattern,
}

impl PathMatcher {
	pub fn new(pattern_string: &str, caseless: bool) -> Self {
		let pattern = Pattern::new(pattern_string, caseless);
		Self { pattern }
	}
}

impl Matcher for PathMatcher {
	fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
		let path = file_info.display_path().to_string_lossy();
		self.pattern.matches(&path)
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::find::{matchers::tests::get_dir_entry_for, tests::FakeDependencies};

	// Variants of fix_up_slashes that properly escape the forward slashes for
	// being in a glob.
	#[cfg(windows)]
	fn fix_up_glob_slashes(re: &str) -> String {
		re.replace("/", "\\\\")
	}

	#[cfg(not(windows))]
	fn fix_up_glob_slashes(re: &str) -> String {
		re.to_owned()
	}

	#[test]
	fn matching_against_whole_path() {
		let abbbc = get_dir_entry_for("test_data/simple", "abbbc");
		let matcher = PathMatcher::new(&fix_up_glob_slashes("test_*/*/a*c"), false);
		let deps = FakeDependencies::new();
		assert!(matcher.matches(&abbbc, &mut deps.new_matcher_io()));
	}

	#[test]
	fn not_matching_against_just_name() {
		let abbbc = get_dir_entry_for("test_data/simple", "abbbc");
		let matcher = PathMatcher::new("a*c", false);
		let deps = FakeDependencies::new();
		assert!(!matcher.matches(&abbbc, &mut deps.new_matcher_io()));
	}

	#[test]
	fn not_matching_against_wrong_case() {
		let abbbc = get_dir_entry_for("test_data/simple", "abbbc");
		let matcher = PathMatcher::new(&fix_up_glob_slashes("test_*/*/A*C"), false);
		let deps = FakeDependencies::new();
		assert!(!matcher.matches(&abbbc, &mut deps.new_matcher_io()));
	}

	#[test]
	fn caseless_matching() {
		let abbbc = get_dir_entry_for("test_data/simple", "abbbc");
		let matcher = PathMatcher::new(&fix_up_glob_slashes("test_*/*/A*C"), true);
		let deps = FakeDependencies::new();
		assert!(matcher.matches(&abbbc, &mut deps.new_matcher_io()));
	}
}
