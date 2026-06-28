/*
 * This file is part of the uutils findutils package.
 *
 * (c) Arcterus <arcterus@mail.com>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

use std::{
	fs,
	io::{self, Write},
};

use pi_uutils_ctx::stderr;

use super::{Matcher, MatcherIO, WalkEntry};

pub struct DeleteMatcher;

impl DeleteMatcher {
	pub fn new() -> Self {
		Self
	}

	fn delete(&self, entry: &WalkEntry) -> io::Result<()> {
		if entry.file_type().is_dir() && !entry.path_is_symlink() {
			fs::remove_dir(entry.path())
		} else {
			fs::remove_file(entry.path())
		}
	}
}

impl Matcher for DeleteMatcher {
	fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
		let path = file_info.path();
		let path_str = path.to_string_lossy();

		// This is a quirk in find's traditional semantics probably due to
		// POSIX rmdir() not accepting "." (EINVAL). std::fs::remove_dir()
		// inherits the same behavior, so no reason to buck tradition.
		if path_str == "." {
			return true;
		}

		match self.delete(file_info) {
			Ok(()) => true,
			Err(e) => {
				matcher_io.set_exit_code(1);
				writeln!(&mut stderr(), "Failed to delete {path_str}: {e}").unwrap();
				false
			},
		}
	}

	fn has_side_effects(&self) -> bool {
		true
	}
}

#[cfg(test)]
mod tests {
	use std::fs::{File, create_dir};

	use tempfile::Builder;

	use super::*;
	use crate::find::{matchers::tests::get_dir_entry_for, tests::FakeDependencies};

	#[test]
	fn delete_matcher() {
		let matcher = DeleteMatcher::new();
		let deps = FakeDependencies::new();

		let temp_dir = Builder::new().prefix("test_data").tempdir().unwrap();

		let temp_dir_path = temp_dir.path().to_string_lossy();
		File::create(temp_dir.path().join("test")).expect("created test file");
		create_dir(temp_dir.path().join("test_dir")).expect("created test directory");
		let test_entry = get_dir_entry_for(&temp_dir_path, "test");
		assert!(
			matcher.matches(&test_entry, &mut deps.new_matcher_io()),
			"DeleteMatcher should match a simple file",
		);
		assert!(
			!temp_dir.path().join("test").exists(),
			"DeleteMatcher should actually delete files it matches",
		);

		let temp_dir_entry = get_dir_entry_for(&temp_dir_path, "test_dir");
		assert!(
			matcher.matches(&temp_dir_entry, &mut deps.new_matcher_io()),
			"DeleteMatcher should match directories",
		);
		assert!(
			!temp_dir.path().join("test_dir").exists(),
			"DeleteMatcher should actually delete (empty) directories it matches",
		);
	}
}
