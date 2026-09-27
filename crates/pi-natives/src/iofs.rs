//! N-API filesystem DTOs and conversion helpers.
//!
//! `pi-walker` owns traversal and cache policy. This module keeps only the
//! JavaScript-facing shapes plus conversions between walker entries and N-API
//! payloads.

use std::path::{Path, PathBuf};

use napi::{JsString, bindgen_prelude::*};
use napi_derive::napi;
use pi_vfs::BlockingFs;

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

/// Absolute spelling of a user search path: URLs and absolute host paths are
/// kept verbatim; relative host paths join the process working directory.
pub(crate) fn absolute_search_path(path: &str) -> Result<PathBuf> {
	let path = Path::new(path);
	if pi_vfs::is_virtual_path(path) || path.is_absolute() {
		return Ok(path.to_path_buf());
	}
	let cwd = std::env::current_dir()
		.map_err(|err| Error::from_reason(format!("Failed to resolve cwd: {err}")))?;
	Ok(pi_vfs::absolute_path(&cwd, path))
}

/// Canonical spelling of an existing `path` on `fs`, or `path` itself when it
/// cannot be canonicalized. A canonical form in another scheme (a URL whose
/// provider resolves it to its backing host file) is ignored, so URL roots
/// keep their URL spelling.
pub(crate) fn canonical_search_path(fs: &BlockingFs, path: PathBuf) -> PathBuf {
	match fs.canonicalize(&path) {
		Ok(canonical) if pi_vfs::url_scheme(&canonical) == pi_vfs::url_scheme(&path) => canonical,
		_ => path,
	}
}

/// Resolve a user search path to the canonical directory a walk starts from,
/// statting and canonicalizing through `fs`.
pub(crate) fn resolve_search_dir(fs: &BlockingFs, path: &str) -> Result<PathBuf> {
	let root = absolute_search_path(path)?;
	let metadata = fs.metadata(&root).map_err(|err| {
		map_walker_error(pi_walker::WalkError::<String>::InvalidData {
			path:    root.clone(),
			message: format!("Path not found: {err}"),
		})
	})?;
	if !metadata.is_dir() {
		return Err(map_walker_error(pi_walker::WalkError::<String>::InvalidData {
			path:    root,
			message: "Search path must be a directory".to_string(),
		}));
	}
	Ok(canonical_search_path(fs, root))
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
