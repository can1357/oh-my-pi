// Copyright 2017 Google Inc.
//
// Use of this source code is governed by a MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

use super::{Matcher, MatcherIO, WalkEntry};

/// This matcher checks the type of the file.
pub struct PruneMatcher;

impl PruneMatcher {
	pub fn new() -> Self {
		Self {}
	}
}

impl Matcher for PruneMatcher {
	fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
		if file_info.file_type().is_dir() {
			matcher_io.mark_current_dir_to_be_skipped();
		}

		true
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::find::{matchers::tests::get_dir_entry_for, tests::FakeDependencies};

	#[test]
	fn file_type_matcher() {
		let dir = get_dir_entry_for("test_data", "simple");
		let deps = FakeDependencies::new();

		let mut matcher_io = deps.new_matcher_io();
		assert!(!matcher_io.should_skip_current_dir());
		let matcher = PruneMatcher::new();
		assert!(matcher.matches(&dir, &mut matcher_io));
		assert!(matcher_io.should_skip_current_dir());
	}

	#[test]
	fn only_skips_directories() {
		let abbbc = get_dir_entry_for("test_data/simple", "abbbc");
		let deps = FakeDependencies::new();

		let mut matcher_io = deps.new_matcher_io();
		assert!(!matcher_io.should_skip_current_dir());
		let matcher = PruneMatcher::new();
		assert!(matcher.matches(&abbbc, &mut matcher_io));
		assert!(!matcher_io.should_skip_current_dir());
	}
}
