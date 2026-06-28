// Copyright 2022 Tavian Barnes
//
// Use of this source code is governed by a MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

use faccess::PathExt;

use super::{Matcher, MatcherIO, WalkEntry};

/// Matcher for -{read,writ,execut}able.
pub enum AccessMatcher {
	Readable,
	Writable,
	Executable,
}

impl Matcher for AccessMatcher {
	fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
		let path = file_info.path();

		match self {
			Self::Readable => path.readable(),
			Self::Writable => path.writable(),
			Self::Executable => path.executable(),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::find::{matchers::tests::get_dir_entry_for, tests::FakeDependencies};

	#[test]
	fn access_matcher() {
		let file_info = get_dir_entry_for("test_data/simple", "abbbc");
		let deps = FakeDependencies::new();

		assert!(
			AccessMatcher::Readable.matches(&file_info, &mut deps.new_matcher_io()),
			"file should be readable"
		);

		assert!(
			AccessMatcher::Writable.matches(&file_info, &mut deps.new_matcher_io()),
			"file should be writable"
		);

		#[cfg(unix)]
		assert!(
			!AccessMatcher::Executable.matches(&file_info, &mut deps.new_matcher_io()),
			"file should not be executable"
		);
	}
}
