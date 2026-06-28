// Copyright 2017 Google Inc.
//
// Use of this source code is governed by a MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

use std::{io::Write, path::PathBuf};

use pi_uutils_ctx::stderr;

use super::{Matcher, MatcherIO, WalkEntry, glob::Pattern};

fn read_link_target(file_info: &WalkEntry) -> Option<PathBuf> {
	match file_info.path().read_link() {
		Ok(target) => Some(target),
		Err(err) => {
			// If it's not a symlink, then it's not an error that should be
			// shown.
			if err.kind() != std::io::ErrorKind::InvalidInput {
				writeln!(
					&mut stderr(),
					"Error reading target of {}: {}",
					file_info.path().display(),
					err
				)
				.unwrap();
			}

			None
		},
	}
}

/// This matcher makes a comparison of the link target against a shell wildcard
/// pattern. See `glob::Pattern` for details on the exact syntax.
pub struct LinkNameMatcher {
	pattern: Pattern,
}

impl LinkNameMatcher {
	pub fn new(pattern_string: &str, caseless: bool) -> Self {
		let pattern = Pattern::new(pattern_string, caseless);
		Self { pattern }
	}
}

impl Matcher for LinkNameMatcher {
	fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
		if let Some(target) = read_link_target(file_info) {
			self.pattern.matches(&target.to_string_lossy())
		} else {
			false
		}
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
	fn matches_against_link_target() {
		create_file_link();

		let link_f = get_dir_entry_for("test_data/links", "link-f");
		let matcher = LinkNameMatcher::new("ab?bc", false);
		let deps = FakeDependencies::new();
		assert!(matcher.matches(&link_f, &mut deps.new_matcher_io()));
	}

	#[test]
	fn caseless_matches_against_link_target() {
		create_file_link();

		let link_f = get_dir_entry_for("test_data/links", "link-f");
		let matcher = LinkNameMatcher::new("AbB?c", true);
		let deps = FakeDependencies::new();
		assert!(matcher.matches(&link_f, &mut deps.new_matcher_io()));
	}
}
