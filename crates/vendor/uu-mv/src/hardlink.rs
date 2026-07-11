// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.
// spell-checker:ignore hardlinked

//! Hardlink preservation utilities for mv operations
//!
//! This module provides functionality to preserve hardlink relationships
//! when moving files across different filesystems/partitions.

use std::{
	io::{self, Write},
	path::{Path, PathBuf},
};

use rustc_hash::FxHashMap;
use uucore::display::Quotable;

/// Tracks hardlinks during cross-partition moves to preserve them
#[derive(Debug, Default)]
pub struct HardlinkTracker {
	/// Maps (device, inode) -> destination path for the first occurrence
	inode_map: FxHashMap<(u64, u64), PathBuf>,
}

/// Pre-scans files to identify hardlink groups with optimized memory usage
#[derive(Debug, Default)]
pub struct HardlinkGroupScanner {
	/// Maps (device, inode) -> list of source paths that are hardlinked together
	hardlink_groups: FxHashMap<(u64, u64), Vec<PathBuf>>,
	/// List of source files/directories being moved (for destination mapping)
	source_files:    Vec<PathBuf>,
	/// Whether scanning has been performed
	scanned:         bool,
}

/// Configuration options for hardlink preservation
#[derive(Debug, Clone, Default)]
pub struct HardlinkOptions {
	/// Whether to show verbose output about hardlink operations
	pub verbose: bool,
}

/// Errors that can occur during hardlink operations
#[derive(Debug)]
pub enum HardlinkError {
	Io(io::Error),
	Scan(String),
	Preservation { source: PathBuf, target: PathBuf },
	Metadata { path: PathBuf, error: io::Error },
}

impl std::fmt::Display for HardlinkError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Io(e) => write!(f, "I/O error during hardlink operation: {e}"),
			Self::Scan(msg) => {
				write!(f, "Failed to scan files for hardlinks: {msg}")
			},
			Self::Preservation { source, target } => {
				write!(f, "Failed to preserve hardlink: {} -> {}", source.quote(), target.quote())
			},
			Self::Metadata { path, error } => {
				write!(f, "Metadata access error for {}: {error}", path.quote())
			},
		}
	}
}

impl std::error::Error for HardlinkError {
	fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
		match self {
			Self::Io(e) => Some(e),
			Self::Metadata { error, .. } => Some(error),
			_ => None,
		}
	}
}

impl From<io::Error> for HardlinkError {
	fn from(error: io::Error) -> Self {
		Self::Io(error)
	}
}

impl From<HardlinkError> for io::Error {
	fn from(error: HardlinkError) -> Self {
		match error {
			HardlinkError::Io(e) => e,
			HardlinkError::Scan(msg) => Self::other(msg),
			HardlinkError::Preservation { source, target } => Self::other(format!(
				"Failed to preserve hardlink: {} -> {}",
				source.quote(),
				target.quote()
			)),

			HardlinkError::Metadata { path, error } => {
				Self::other(format!("Metadata access error for {}: {error}", path.quote(),))
			},
		}
	}
}

impl HardlinkTracker {
	pub fn new() -> Self {
		Self::default()
	}

	/// Check if a file is a hardlink we've seen before, and return the target
	/// path if so
	pub fn check_hardlink(
		&mut self,
		source: &Path,
		dest: &Path,
		scanner: &HardlinkGroupScanner,
		options: &HardlinkOptions,
	) -> Option<PathBuf> {
		use std::os::unix::fs::MetadataExt;

		let metadata = match pi_uutils_ctx::resolve(source).metadata() {
			Ok(meta) => meta,
			Err(e) => {
				// Gracefully handle metadata errors by logging and continuing without hardlink
				// tracking
				if options.verbose {
					let _ = writeln!(
						pi_uutils_ctx::stderr(),
						"warning: cannot get metadata for {}: {e}",
						source.quote()
					);
				}
				return None;
			},
		};

		let key = (metadata.dev(), metadata.ino());

		// Check if we've already processed a file with this inode
		if let Some(existing_path) = self.inode_map.get(&key) {
			// Check if this file is part of a hardlink group from the scanner
			let has_hardlinks = scanner
				.hardlink_groups
				.get(&key)
				.is_some_and(|group| group.len() > 1);

			if has_hardlinks {
				if options.verbose {
					let _ = writeln!(
						pi_uutils_ctx::stderr(),
						"preserving hardlink {} -> {} (hardlinked)",
						source.quote(),
						existing_path.quote()
					);
				}
				return Some(existing_path.clone());
			}
		}

		// This is the first time we see this file, record its destination
		self.inode_map.insert(key, dest.to_path_buf());

		None
	}
}

impl HardlinkGroupScanner {
	pub fn new() -> Self {
		Self::default()
	}

	/// Scan files and group them by hardlinks, including recursive directory
	/// scanning
	pub fn scan_files(&mut self, files: &[PathBuf], options: &HardlinkOptions) {
		if self.scanned {
			return;
		}

		// Store the source files for destination mapping
		self.source_files = files.to_vec();

		for file in files {
			if let Err(e) = self.scan_single_path(file)
				&& options.verbose
			{
				// Only show warnings for verbose mode
				let _ =
					writeln!(pi_uutils_ctx::stderr(), "warning: failed to scan {}: {e}", file.quote());
			}
			// For non-verbose mode, silently continue for missing files
			// This provides graceful degradation - we'll lose hardlink info for
			// this file but can still preserve hardlinks for other files
		}

		self.scanned = true;

		if options.verbose {
			let stats = self.stats();
			if stats.total_groups > 0 {
				let _ = writeln!(
					pi_uutils_ctx::stderr(),
					"found {} hardlink groups with {} total files",
					stats.total_groups,
					stats.total_files
				);
			}
		}
	}

	/// Scan a single path (file or directory)
	fn scan_single_path(&mut self, path: &Path) -> io::Result<()> {
		use std::os::unix::fs::MetadataExt;

		if pi_uutils_ctx::resolve(path).is_dir() {
			// Recursively scan directory contents
			self.scan_directory_recursive(path)?;
		} else {
			let metadata = pi_uutils_ctx::resolve(path).metadata()?;
			if metadata.nlink() > 1 {
				let key = (metadata.dev(), metadata.ino());
				self
					.hardlink_groups
					.entry(key)
					.or_default()
					.push(path.to_path_buf());
			}
		}
		Ok(())
	}

	/// Recursively scan a directory for hardlinked files
	fn scan_directory_recursive(&mut self, dir: &Path) -> io::Result<()> {
		use std::os::unix::fs::MetadataExt;

		let entries = std::fs::read_dir(pi_uutils_ctx::resolve(dir))?;
		for entry in entries {
			let entry = entry?;
			let path = entry.path();

			if path.is_dir() {
				self.scan_directory_recursive(&path)?;
			} else {
				let metadata = path.metadata()?;
				if metadata.nlink() > 1 {
					let key = (metadata.dev(), metadata.ino());
					self.hardlink_groups.entry(key).or_default().push(path);
				}
			}
		}
		Ok(())
	}

	#[cfg(not(unix))]
	pub fn scan_files(
		&mut self,
		files: &[PathBuf],
		_options: &HardlinkOptions,
	) -> HardlinkResult<()> {
		self.source_files = files.to_vec();
		self.scanned = true;
		Ok(())
	}

	#[cfg(not(unix))]
	pub fn stats(&self) -> ScannerStats {
		ScannerStats { total_groups: 0, total_files: 0 }
	}

	/// Get statistics about scanned hardlinks
	#[cfg(unix)]
	pub fn stats(&self) -> ScannerStats {
		let total_groups = self.hardlink_groups.len();
		let total_files = self.hardlink_groups.values().map(Vec::len).sum();

		ScannerStats { total_groups, total_files }
	}
}

/// Statistics about hardlink scanning
#[derive(Debug, Clone)]
pub struct ScannerStats {
	pub total_groups: usize,
	pub total_files:  usize,
}

/// Create a new hardlink tracker and scanner pair
pub fn create_hardlink_context() -> (HardlinkTracker, HardlinkGroupScanner) {
	(HardlinkTracker::new(), HardlinkGroupScanner::new())
}

/// Convenient function to execute operations with proper hardlink context
/// handling
pub fn with_optional_hardlink_context<F, R>(
	tracker: Option<&mut HardlinkTracker>,
	scanner: Option<&HardlinkGroupScanner>,
	operation: F,
) -> R
where
	F: FnOnce(&mut HardlinkTracker, &HardlinkGroupScanner) -> R,
{
	if let (Some(tracker), Some(scanner)) = (tracker, scanner) {
		operation(tracker, scanner)
	} else {
		let (mut dummy_tracker, dummy_scanner) = create_hardlink_context();
		operation(&mut dummy_tracker, &dummy_scanner)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn test_hardlink_tracker_creation() {
		let _tracker = HardlinkTracker::new();
		// Just test that creation works
	}

	#[test]
	fn test_scanner_creation() {
		let scanner = HardlinkGroupScanner::new();
		let stats = scanner.stats();
		assert_eq!(stats.total_groups, 0);
		assert_eq!(stats.total_files, 0);
	}

	#[test]
	fn test_create_hardlink_context() {
		let (_tracker, scanner) = create_hardlink_context();
		let stats = scanner.stats();
		assert_eq!(stats.total_groups, 0);
		assert_eq!(stats.total_files, 0);
	}
}
