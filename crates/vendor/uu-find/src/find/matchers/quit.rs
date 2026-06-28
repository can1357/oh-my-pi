// Copyright 2017 Tavian Barnes
//
// Use of this source code is governed by a MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

use super::{Matcher, MatcherIO, WalkEntry};

/// This matcher quits the search immediately.
pub struct QuitMatcher;

impl Matcher for QuitMatcher {
	fn matches(&self, _: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
		matcher_io.quit();
		true
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::find::{matchers::tests::get_dir_entry_for, tests::FakeDependencies};

	#[test]
	fn quits_when_matched() {
		let dir = get_dir_entry_for("test_data", "simple");
		let deps = FakeDependencies::new();

		let mut matcher_io = deps.new_matcher_io();
		assert!(!matcher_io.should_quit());
		let matcher = QuitMatcher;
		assert!(matcher.matches(&dir, &mut matcher_io));
		assert!(matcher_io.should_quit());
	}
}
