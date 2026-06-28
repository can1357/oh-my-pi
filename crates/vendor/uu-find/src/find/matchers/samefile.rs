// This file is part of the uutils findutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

use std::{error::Error, path::Path};

use uucore::fs::FileInformation;

use super::{Follow, Matcher, MatcherIO, WalkEntry, WalkError};

pub struct SameFileMatcher {
	info: FileInformation,
}

/// Gets FileInformation, possibly following symlinks, but falling back on
/// broken links.
fn get_file_info(path: &Path, follow: bool) -> Result<FileInformation, WalkError> {
	if follow {
		let result = FileInformation::from_path(path, true).map_err(WalkError::from);

		match result {
			Ok(info) => return Ok(info),
			Err(e) if !e.is_not_found() => return Err(e),
			_ => {},
		}
	}

	Ok(FileInformation::from_path(path, false)?)
}

impl SameFileMatcher {
	pub fn new(path: impl AsRef<Path>, follow: Follow) -> Result<Self, Box<dyn Error>> {
		let info = get_file_info(&pi_uutils_ctx::resolve(path.as_ref()), follow != Follow::Never)?;
		Ok(Self { info })
	}
}

impl Matcher for SameFileMatcher {
	fn matches(&self, file_info: &WalkEntry, _matcher_io: &mut MatcherIO) -> bool {
		if let Ok(info) = get_file_info(file_info.path(), file_info.follow()) {
			info == self.info
		} else {
			false
		}
	}
}

#[cfg(test)]
mod tests {
	use std::fs::{self, File};

	use tempfile::Builder;

	use super::*;
	use crate::find::{
		matchers::tests::{get_dir_entry_follow, get_dir_entry_for},
		tests::FakeDependencies,
	};

	#[test]
	fn test_samefile() {
		let root = Builder::new().prefix("example").tempdir().unwrap();
		let root_path = root.path();

		let file_path = root_path.join("file");
		File::create(&file_path).unwrap();

		let link_path = root_path.join("link");
		fs::hard_link(&file_path, &link_path).unwrap();

		let other_path = root_path.join("other");
		File::create(&other_path).unwrap();

		let matcher = SameFileMatcher::new(&file_path, Follow::Never).unwrap();

		let root_path = root_path.to_string_lossy();
		let file_entry = get_dir_entry_for(&root_path, "file");
		let link_entry = get_dir_entry_for(&root_path, "link");
		let other_entry = get_dir_entry_for(&root_path, "other");

		let deps = FakeDependencies::new();
		assert!(matcher.matches(&file_entry, &mut deps.new_matcher_io()));
		assert!(matcher.matches(&link_entry, &mut deps.new_matcher_io()));
		assert!(!matcher.matches(&other_entry, &mut deps.new_matcher_io()));
	}

	#[test]
	fn test_follow() {
		let deps = FakeDependencies::new();
		let matcher = SameFileMatcher::new("test_data/links/link-f", Follow::Roots).unwrap();

		let entry = get_dir_entry_follow("test_data/links", "link-f", Follow::Never);
		assert!(!matcher.matches(&entry, &mut deps.new_matcher_io()));

		let entry = get_dir_entry_follow("test_data/links", "abbbc", Follow::Never);
		assert!(matcher.matches(&entry, &mut deps.new_matcher_io()));

		let entry = get_dir_entry_follow("test_data/links", "link-f", Follow::Roots);
		assert!(!matcher.matches(&entry, &mut deps.new_matcher_io()));

		let entry = get_dir_entry_follow("test_data/links", "abbbc", Follow::Roots);
		assert!(matcher.matches(&entry, &mut deps.new_matcher_io()));

		let entry = get_dir_entry_follow("test_data/links", "link-f", Follow::Always);
		assert!(matcher.matches(&entry, &mut deps.new_matcher_io()));

		let entry = get_dir_entry_follow("test_data/links", "abbbc", Follow::Always);
		assert!(matcher.matches(&entry, &mut deps.new_matcher_io()));
	}
}
