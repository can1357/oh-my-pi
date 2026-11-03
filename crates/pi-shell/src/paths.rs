//! Host path spellings: Windows 8.3 short names and their long forms.
//!
//! Elsewhere there are no short names and both functions return the path as
//! given.

#[cfg(not(windows))]
use std::path::{Path, PathBuf};

#[cfg(windows)]
pub use crate::windows::{expand_to_long_path, get_short_path};

/// Expand 8.3 short-name components in `path` to their long form (Windows);
/// the path unchanged elsewhere.
#[cfg(not(windows))]
#[must_use]
pub fn expand_to_long_path(path: &Path) -> PathBuf {
	path.to_path_buf()
}

/// The existing 8.3 spelling of `path` (Windows); the path unchanged
/// elsewhere.
#[cfg(not(windows))]
#[must_use]
pub fn get_short_path(path: &Path) -> PathBuf {
	path.to_path_buf()
}
