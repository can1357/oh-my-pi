// Copyright 2017 Google Inc.
//
// Use of this source code is governed by a MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

use super::{Matcher, MatcherIO, WalkEntry, glob::Pattern};

/// This matcher makes a comparison of the name against a shell wildcard
/// pattern. See `glob::Pattern` for details on the exact syntax.
pub struct NameMatcher {
	pattern: Pattern,
}

impl NameMatcher {
	pub fn new(pattern_string: &str, caseless: bool) -> Self {
		let pattern = Pattern::new(pattern_string, caseless);
		Self { pattern }
	}
}

impl Matcher for NameMatcher {
	fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
		let name = file_info.file_name().to_string_lossy();

		#[cfg(unix)]
		if name.len() > 1 && name.chars().all(|x| x == '/') {
			self.pattern.matches("/")
		} else {
			self.pattern.matches(&name)
		}

		#[cfg(windows)]
		self.pattern.matches(&name)
	}
}

#[cfg(test)]
mod tests {
	use std::io::ErrorKind;
	#[cfg(unix)]
	use std::os::unix::fs::symlink;
	#[cfg(windows)]
	use std::os::windows::fs::symlink_file;

	use super::*;
	use crate::find::{matchers::tests::get_dir_entry_for, tests::FakeDependencies};

	fn create_file_link() {
		#[cfg(unix)]
		if let Err(e) = symlink("abbbc", "test_data/links/link-f") {
			assert!(e.kind() == ErrorKind::AlreadyExists, "Failed to create sym link: {e:?}");
		}
		#[cfg(windows)]
		if let Err(e) = symlink_file("abbbc", "test_data/links/link-f") {
			assert!(e.kind() == ErrorKind::AlreadyExists, "Failed to create sym link: {:?}", e);
		}
	}

	#[test]
	fn matching_with_wrong_case_returns_false() {
		let abbbc = get_dir_entry_for("test_data/simple", "abbbc");
		let matcher = NameMatcher::new("A*C", false);
		let deps = FakeDependencies::new();
		assert!(!matcher.matches(&abbbc, &mut deps.new_matcher_io()));
	}

	#[test]
	fn matching_with_right_case_returns_true() {
		let abbbc = get_dir_entry_for("test_data/simple", "abbbc");
		let matcher = NameMatcher::new("abb?c", false);
		let deps = FakeDependencies::new();
		assert!(matcher.matches(&abbbc, &mut deps.new_matcher_io()));
	}

	#[test]
	fn not_matching_returns_false() {
		let abbbc = get_dir_entry_for("test_data/simple", "abbbc");
		let matcher = NameMatcher::new("shouldn't match", false);
		let deps = FakeDependencies::new();
		assert!(!matcher.matches(&abbbc, &mut deps.new_matcher_io()));
	}

	#[test]
	fn matches_against_link_file_name() {
		create_file_link();

		let link_f = get_dir_entry_for("test_data/links", "link-f");
		let matcher = NameMatcher::new("link?f", false);
		let deps = FakeDependencies::new();
		assert!(matcher.matches(&link_f, &mut deps.new_matcher_io()));
	}

	#[test]
	fn caseless_matching_with_wrong_case_returns_true() {
		let abbbc = get_dir_entry_for("test_data/simple", "abbbc");
		let matcher = NameMatcher::new("A*C", true);
		let deps = FakeDependencies::new();
		assert!(matcher.matches(&abbbc, &mut deps.new_matcher_io()));
	}

	#[test]
	fn caseless_matching_with_right_case_returns_true() {
		let abbbc = get_dir_entry_for("test_data/simple", "abbbc");
		let matcher = NameMatcher::new("abb?c", true);
		let deps = FakeDependencies::new();
		assert!(matcher.matches(&abbbc, &mut deps.new_matcher_io()));
	}

	#[test]
	fn caseless_not_matching_returns_false() {
		let abbbc = get_dir_entry_for("test_data/simple", "abbbc");
		let matcher = NameMatcher::new("shouldn't match", true);
		let deps = FakeDependencies::new();
		assert!(!matcher.matches(&abbbc, &mut deps.new_matcher_io()));
	}

	#[test]
	fn caseless_matches_against_link_file_name() {
		create_file_link();

		let link_f = get_dir_entry_for("test_data/links", "link-f");
		let matcher = NameMatcher::new("linK?f", true);
		let deps = FakeDependencies::new();
		assert!(matcher.matches(&link_f, &mut deps.new_matcher_io()));
	}

	#[test]
	#[cfg(unix)]
	fn slash_match_returns_true() {
		let dir_to_match = get_dir_entry_for("///", "");
		let matcher = NameMatcher::new("/", true);
		let deps = FakeDependencies::new();
		assert!(matcher.matches(&dir_to_match, &mut deps.new_matcher_io()));
	}

	#[test]
	#[cfg(unix)]
	fn only_one_slash() {
		let dir_to_match = get_dir_entry_for("/", "");
		let matcher = NameMatcher::new("/", false);
		let deps = FakeDependencies::new();
		assert!(matcher.matches(&dir_to_match, &mut deps.new_matcher_io()));
	}
}
