// Copyright 2021 Collabora, Ltd.
//
// Use of this source code is governed by a MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

use std::{fs::read_dir, io::Write};

use pi_uutils_ctx::stderr;

use super::{Matcher, MatcherIO, WalkEntry};

pub struct EmptyMatcher;

impl EmptyMatcher {
	pub fn new() -> Self {
		Self
	}
}

impl Matcher for EmptyMatcher {
	fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
		if file_info.file_type().is_file() {
			match file_info.metadata() {
				Ok(meta) => meta.len() == 0,
				Err(err) => {
					writeln!(
						&mut stderr(),
						"Error getting size for {}: {}",
						file_info.path().display(),
						err
					)
					.unwrap();
					false
				},
			}
		} else if file_info.file_type().is_dir() {
			match read_dir(file_info.path()) {
				Ok(mut it) => it.next().is_none(),
				Err(err) => {
					writeln!(
						&mut stderr(),
						"Error getting contents of {}: {}",
						file_info.path().display(),
						err
					)
					.unwrap();
					false
				},
			}
		} else {
			false
		}
	}
}

#[cfg(test)]
mod tests {
	use tempfile::Builder;

	use super::*;
	use crate::find::{matchers::tests::get_dir_entry_for, tests::FakeDependencies};

	#[test]
	fn empty_files() {
		let empty_file_info = get_dir_entry_for("test_data/simple", "abbbc");
		let nonempty_file_info = get_dir_entry_for("test_data/size", "512bytes");

		let matcher = EmptyMatcher::new();
		let deps = FakeDependencies::new();

		assert!(matcher.matches(&empty_file_info, &mut deps.new_matcher_io()));
		assert!(!matcher.matches(&nonempty_file_info, &mut deps.new_matcher_io()));
	}

	#[test]
	fn empty_directories() {
		let temp_dir = Builder::new()
			.prefix("empty_directories")
			.tempdir()
			.unwrap();
		let temp_dir_path = temp_dir.path().to_string_lossy();
		let subdir_name = "subdir";
		std::fs::create_dir(temp_dir.path().join(subdir_name)).unwrap();

		let matcher = EmptyMatcher::new();
		let deps = FakeDependencies::new();

		let file_info = get_dir_entry_for(&temp_dir_path, subdir_name);
		assert!(matcher.matches(&file_info, &mut deps.new_matcher_io()));

		std::fs::File::create(temp_dir.path().join(subdir_name).join("a")).unwrap();

		let file_info = get_dir_entry_for(&temp_dir_path, subdir_name);
		assert!(!matcher.matches(&file_info, &mut deps.new_matcher_io()));
	}
}
