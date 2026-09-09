//! Path searching utilities.

use std::{
	collections::VecDeque,
	path::{Path, PathBuf},
};

use crate::{sys, sys::fs::PathExt};

/// Encapsulates the result of a path search.
pub struct ExecutablePathSearch<PI, N> {
	paths:    VecDeque<PI>,
	filename: N,
}

impl<PI, N> Iterator for ExecutablePathSearch<PI, N>
where
	PI: AsRef<Path>,
	N: AsRef<Path>,
{
	type Item = PathBuf;

	fn next(&mut self) -> Option<Self::Item> {
		while let Some(path) = self.paths.pop_front() {
			let path = PathBuf::from(path.as_ref()).join(self.filename.as_ref());
			// Skip directories outright, then ask the platform to resolve
			// the path to an actual executable file (which, on Windows, may
			// involve appending a PATHEXT extension). The helper takes
			// ownership so Unix — where no resolution is needed — can return
			// the path unchanged without allocating.
			if path.is_dir() {
				continue;
			}
			if let Some(resolved) = sys::fs::resolve_executable(path) {
				return Some(resolved);
			}
		}
		None
	}
}

pub(crate) struct ExecutablePathPrefixSearch<PI> {
	paths:            VecDeque<PI>,
	queued_items:     VecDeque<PathBuf>,
	filename_prefix:  String,
	case_insensitive: bool,
}

impl<PI> Iterator for ExecutablePathPrefixSearch<PI>
where
	PI: AsRef<Path>,
{
	type Item = PathBuf;

	fn next(&mut self) -> Option<Self::Item> {
		// If we already found some items and queued them, then yield one now.
		if let Some(item) = self.queued_items.pop_front() {
			return Some(item);
		}

		while let Some(path) = self.paths.pop_front() {
			let path = PathBuf::from(path.as_ref());

			if let Ok(readdir) = path.read_dir() {
				for entry in readdir.flatten() {
					if let Ok(mut filename) = entry.file_name().into_string() {
						if self.case_insensitive {
							filename = filename.to_ascii_lowercase();
						}

						if !filename.starts_with(&self.filename_prefix) {
							continue;
						}
					}

					let entry_path = entry.path();
					if let Ok(file_type) = entry.file_type() {
						if file_type.is_file() && entry_path.executable() {
							self.queued_items.push_back(entry_path);
							continue;
						}
						if file_type.is_symlink() && entry_path.executable() {
							self.queued_items.push_back(entry_path);
						}
					}
				}
			}
			if let Some(item) = self.queued_items.pop_front() {
				return Some(item);
			}
		}

		None
	}
}

/// Search for the given executable name in the provided paths.
///
/// # Arguments
///
/// * `paths` - An iterator over the paths to search.
/// * `filename` - The name of the executable file to search for.
pub fn search_for_executable<P, PI, N>(paths: P, filename: N) -> ExecutablePathSearch<PI, N>
where
	P: Iterator<Item = PI>,
	PI: AsRef<Path>,
	N: AsRef<Path>,
{
	ExecutablePathSearch { paths: paths.collect(), filename }
}

pub(crate) fn search_for_executable_with_prefix<P, PI>(
	paths: P,
	filename_prefix: &str,
	case_insensitive: bool,
) -> ExecutablePathPrefixSearch<PI>
where
	P: Iterator<Item = PI>,
	PI: AsRef<Path>,
{
	let stored_prefix = if case_insensitive {
		filename_prefix.to_ascii_lowercase()
	} else {
		filename_prefix.into()
	};

	ExecutablePathPrefixSearch {
		paths: paths.collect(),
		queued_items: VecDeque::new(),
		filename_prefix: stored_prefix,
		case_insensitive,
	}
}
