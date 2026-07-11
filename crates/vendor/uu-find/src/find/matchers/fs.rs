// This file is part of the uutils findutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.
#[cfg(unix)]
use uucore::error::UResult;

use super::{Matcher, MatcherIO, WalkEntry};

/// The latest mapping from dev_id to fs_type, used for saving mount info reads
#[cfg(unix)]
pub struct Cache {
	dev_id:  String,
	fs_type: String,
}

/// Get the filesystem type of a file.
/// 1. get the metadata of the file
/// 2. get the device ID of the metadata
/// 3. search the cache, then the filesystem list
///
/// Returns an empty string when no file system list matches.
///
/// # Errors
/// Returns an error if the metadata could not be read.
/// Returns an error if the filesystem list could not be read.
///
/// This is only supported on Unix.
#[cfg(unix)]
use std::{cell::RefCell, io::Write, path::Path};

#[cfg(unix)]
use pi_uutils_ctx::stderr;

#[cfg(unix)]
pub fn get_file_system_type(path: &Path, cache: &RefCell<Option<Cache>>) -> UResult<String> {
	use std::os::unix::fs::MetadataExt;

	// use symlink_metadata (lstat under the hood) instead of metadata (stat) to
	// make sure that it does not return an error when there is a (broken) symlink;
	// this is aligned with GNU find.
	let metadata = match path.symlink_metadata() {
		Ok(metadata) => metadata,
		Err(err) => Err(err)?,
	};
	let dev_id = metadata.dev().to_string();

	if let Some(cache) = cache.borrow().as_ref()
		&& cache.dev_id == dev_id
	{
		return Ok(cache.fs_type.clone());
	}

	let fs_list = uucore::fsext::read_fs_list()?;
	let result = fs_list
		.into_iter()
		.find(|fs| fs.dev_id == dev_id)
		.map_or_else(String::new, |fs| fs.fs_type);

	// cache the latest query if not a match before
	cache.replace(Some(Cache { dev_id, fs_type: result.clone() }));

	Ok(result)
}

/// This matcher handles the -fstype argument.
/// It matches the filesystem type of the file.
///
/// This is only supported on Unix.
pub struct FileSystemMatcher {
	#[cfg(unix)]
	fs_text: String,
	#[cfg(unix)]
	cache:   RefCell<Option<Cache>>,
}

impl FileSystemMatcher {
	#[cfg(unix)]
	pub fn new(fs_text: String) -> Self {
		Self { fs_text, cache: RefCell::new(None) }
	}

	#[cfg(not(unix))]
	pub fn new(_fs_text: String) -> Self {
		Self {}
	}
}

impl Matcher for FileSystemMatcher {
	#[cfg(unix)]
	fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
		match get_file_system_type(file_info.path(), &self.cache) {
			Ok(result) => result == self.fs_text,
			Err(_) => {
				writeln!(
					&mut stderr(),
					"Error getting filesystem type for {}",
					file_info.path().to_string_lossy()
				)
				.unwrap();

				false
			},
		}
	}

	#[cfg(not(unix))]
	fn matches(&self, _file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
		false
	}
}

#[cfg(test)]
mod tests {
	#[test]
	#[cfg(unix)]
	fn test_fs_matcher() {
		use std::{cell::RefCell, fs::File};

		use tempfile::Builder;

		use crate::find::{
			matchers::{
				Matcher,
				fs::{Cache, get_file_system_type},
				tests::get_dir_entry_for,
			},
			tests::FakeDependencies,
		};

		let deps = FakeDependencies::new();
		let mut matcher_io = deps.new_matcher_io();

		// create temp file and get its fs type
		// We pass this file and the corresponding file system type into the Matcher for
		// comparison.
		let temp_dir = Builder::new().prefix("fs_matcher").tempdir().unwrap();
		let foo_path = temp_dir.path().join("foo");
		let _ = File::create(foo_path).expect("create temp file");
		let file_info = get_dir_entry_for(&temp_dir.path().to_string_lossy(), "foo");

		// create an empty cache for initial fs type lookup
		let empty_cache = RefCell::new(None);
		let target_fs_type = get_file_system_type(file_info.path(), &empty_cache).unwrap();

		// should work with unmatched cache, and the cache should be set to the last
		// query result
		let unmatched_cache =
			RefCell::new(Some(Cache { dev_id: "foo".to_string(), fs_type: "bar".to_string() }));
		let target_fs_type_unmatched_cache =
			get_file_system_type(file_info.path(), &unmatched_cache).unwrap();
		assert_eq!(
			target_fs_type, target_fs_type_unmatched_cache,
			"get_file_system_type should return correct result with unmatched cache"
		);
		assert_eq!(
			unmatched_cache.borrow().as_ref().unwrap().fs_type,
			target_fs_type,
			"get_file_system_type should set the cache to the last query result"
		);

		// should match fs type
		let matcher = super::FileSystemMatcher::new(target_fs_type.clone());
		assert!(
			matcher.matches(&file_info, &mut matcher_io),
			"{} should match {}",
			file_info.path().to_string_lossy(),
			target_fs_type
		);

		// should not match fs type
		let matcher = super::FileSystemMatcher::new(target_fs_type.clone() + "foo");
		assert!(
			!matcher.matches(&file_info, &mut matcher_io),
			"{} should not match {}",
			file_info.path().to_string_lossy(),
			target_fs_type
		);
	}
}
