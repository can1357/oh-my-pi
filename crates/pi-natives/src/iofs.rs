//! N-API filesystem DTOs and conversion helpers.
//!
//! `pi-walker` owns traversal and cache policy. This module keeps only the
//! JavaScript-facing shapes plus conversions between walker entries and N-API
//! payloads.

use napi::{JsString, bindgen_prelude::*};
use napi_derive::napi;

use crate::js;

/// Resolved filesystem entry kind for glob filters and match metadata.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi]
pub enum FileType {
	/// Regular file.
	File    = 1,
	/// Directory.
	Dir     = 2,
	/// Symbolic link.
	Symlink = 3,
}

/// A single filesystem entry from a directory scan.
#[derive(Clone)]
#[napi(object)]
pub struct GlobMatch {
	/// Relative path from the search root, using forward slashes.
	pub path:      String,
	/// Resolved filesystem type for the match.
	pub file_type: FileType,
	/// Modification time in milliseconds since Unix epoch.
	pub mtime:     Option<f64>,
	/// File size in bytes for regular files.
	pub size:      Option<f64>,
}

fn walker_error_to_napi<E: std::fmt::Display>(err: pi_walker::WalkError<E>) -> Error {
	match err {
		pi_walker::WalkError::Interrupted(err) => Error::from_reason(err.to_string()),
		pi_walker::WalkError::InvalidData { path, message } => Error::from_reason(format!(
			"Native directory scan failed for {}: {message}",
			path.display()
		)),
	}
}

pub(crate) const fn from_walker_file_type(file_type: pi_walker::FileType) -> FileType {
	match file_type {
		pi_walker::FileType::File => FileType::File,
		pi_walker::FileType::Dir => FileType::Dir,
		pi_walker::FileType::Symlink => FileType::Symlink,
	}
}

impl From<pi_walker::CollectedEntry> for GlobMatch {
	fn from(entry: pi_walker::CollectedEntry) -> Self {
		Self {
			path:      entry.path,
			file_type: from_walker_file_type(entry.file_type),
			mtime:     entry.mtime,
			size:      entry.size,
		}
	}
}

/// Converts a native walker error into an N-API error.
pub(crate) fn map_walker_error<E: std::fmt::Display>(err: pi_walker::WalkError<E>) -> Error {
	walker_error_to_napi(err)
}

/// Invalidate the walker scan cache.
///
/// When called with a path, removes entries for roots containing that path.
/// When called without a path, clears the entire cache.
///
/// Intended to be called after agent file mutations: write, edit, rename, or
/// delete.
#[napi]
pub fn invalidate_fs_scan_cache(path: Option<JsString>) -> Result<()> {
	match path {
		Some(path) => pi_walker::invalidate_path_string(&js::utf8(path)?),
		None => pi_walker::invalidate_all(),
	}
	Ok(())
}
