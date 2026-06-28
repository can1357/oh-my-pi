// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

use std::{fs::File, path::PathBuf};

use tempfile::TempDir;
use uucore::error::UResult;

use crate::SortError;

/// A wrapper around [`TempDir`] that handles the allocation of new temporary
/// files in the temporary directory.
///
/// The directory is only created once the first file is requested. Cleanup
/// happens automatically when the [`TempDir`] is dropped.
///
/// pi-uutils: upstream installs a process-global `SIGINT` handler (via `ctrlc`)
/// that deletes the temp directory and then calls `std::process::exit`. Both
/// are unsafe inside the long-lived host shell process, so the signal handler
/// has been removed: the host shell owns signal handling, and `TempDir`'s
/// `Drop` still cleans up on normal completion. With the handler gone, the
/// per-instance coordination mutex is no longer needed either (`next_file` only
/// ever runs on the calling thread).
pub struct TmpDirWrapper {
	temp_dir:    Option<TempDir>,
	parent_path: PathBuf,
	size:        usize,
}

impl TmpDirWrapper {
	pub fn new(path: PathBuf) -> Self {
		Self { parent_path: path, size: 0, temp_dir: None }
	}

	fn init_tmp_dir(&mut self) -> UResult<()> {
		assert!(self.temp_dir.is_none());
		assert_eq!(self.size, 0);
		self.temp_dir = Some(
			tempfile::Builder::new()
				.prefix("uutils_sort")
				.tempdir_in(&self.parent_path)
				.map_err(|_| SortError::TmpFileCreationFailed { path: self.parent_path.clone() })?,
		);
		Ok(())
	}

	pub fn next_file(&mut self) -> UResult<(File, PathBuf)> {
		if self.temp_dir.is_none() {
			self.init_tmp_dir()?;
		}

		let file_name = self.size.to_string();
		self.size += 1;
		let path = self.temp_dir.as_ref().unwrap().path().join(file_name);
		Ok((File::create(&path).map_err(|error| SortError::OpenTmpFileFailed { error })?, path))
	}

	/// pi-uutils: no-op retained for call-site compatibility. Upstream blocked
	/// here until the `SIGINT` handler finished deleting the temp dir; with the
	/// handler removed there is nothing to wait for.
	pub fn wait_if_signal(&self) {}
}
