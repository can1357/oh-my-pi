// Copyright 2022 Tavian Barnes
//
// Use of this source code is governed by a MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

use std::os::unix::fs::MetadataExt;

use super::{ComparableValue, Matcher, MatcherIO, WalkEntry};

/// Inode number matcher.
pub struct InodeMatcher {
	ino: ComparableValue,
}

impl InodeMatcher {
	pub fn new(ino: ComparableValue) -> Self {
		Self { ino }
	}
}

impl Matcher for InodeMatcher {
	fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
		match file_info.metadata() {
			Ok(metadata) => self.ino.matches(metadata.ino()),
			Err(_) => false,
		}
	}
}

/// Link count matcher.
pub struct LinksMatcher {
	nlink: ComparableValue,
}

impl LinksMatcher {
	pub fn new(nlink: ComparableValue) -> Self {
		Self { nlink }
	}
}

impl Matcher for LinksMatcher {
	fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
		match file_info.metadata() {
			Ok(metadata) => self.nlink.matches(metadata.nlink()),
			Err(_) => false,
		}
	}
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
	use super::*;
	use crate::find::{matchers::tests::get_dir_entry_for, tests::FakeDependencies};

	#[test]
	fn inode_matcher() {
		let file_info = get_dir_entry_for("test_data/simple", "abbbc");
		let metadata = file_info.metadata().unwrap();
		let deps = FakeDependencies::new();

		let matcher = InodeMatcher::new(ComparableValue::EqualTo(metadata.ino()));
		assert!(matcher.matches(&file_info, &mut deps.new_matcher_io()), "inode number should match");

		let matcher = InodeMatcher::new(ComparableValue::LessThan(metadata.ino()));
		assert!(
			!matcher.matches(&file_info, &mut deps.new_matcher_io()),
			"inode number should not match"
		);

		let matcher = InodeMatcher::new(ComparableValue::MoreThan(metadata.ino()));
		assert!(
			!matcher.matches(&file_info, &mut deps.new_matcher_io()),
			"inode number should not match"
		);
	}

	#[test]
	fn links_matcher() {
		let file_info = get_dir_entry_for("test_data/simple", "abbbc");
		let deps = FakeDependencies::new();

		let matcher = LinksMatcher::new(ComparableValue::EqualTo(1));
		assert!(matcher.matches(&file_info, &mut deps.new_matcher_io()), "link count should match");

		let matcher = LinksMatcher::new(ComparableValue::LessThan(1));
		assert!(
			!matcher.matches(&file_info, &mut deps.new_matcher_io()),
			"link count should not match"
		);

		let matcher = LinksMatcher::new(ComparableValue::MoreThan(1));
		assert!(
			!matcher.matches(&file_info, &mut deps.new_matcher_io()),
			"link count should not match"
		);
	}
}
