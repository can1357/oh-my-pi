//! Filesystem discovery with glob patterns, ignore semantics, and shared
//! directory-listing reuse.
//!
//! # Overview
//! Resolves a search root, runs `pi_walker::glob`, and optionally streams each
//! returned match through a callback.
//!
//! `pi_walker::glob` never yields `.git`, and skips `node_modules` unless the
//! pattern or options request it.
//!
//! # Example
//! ```ignore
//! // JS: await native.glob({ pattern: "*.rs", path: "." })
//! ```

use napi::{
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;

use crate::{shell::vfs::ShellFilesystem, task};

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

impl From<pi_walker::FileType> for FileType {
	fn from(file_type: pi_walker::FileType) -> Self {
		match file_type {
			pi_walker::FileType::File => Self::File,
			pi_walker::FileType::Dir => Self::Dir,
			pi_walker::FileType::Symlink => Self::Symlink,
		}
	}
}

impl From<FileType> for pi_walker::FileType {
	fn from(file_type: FileType) -> Self {
		match file_type {
			FileType::File => Self::File,
			FileType::Dir => Self::Dir,
			FileType::Symlink => Self::Symlink,
		}
	}
}

/// Input options for `glob`, including traversal, filtering, and cancellation.
#[napi(object, object_to_js = false)]
pub struct GlobOptions<'env> {
	/// Glob pattern to match (e.g., "*.ts").
	pub pattern:              String,
	/// Directory to search: a host path or an absolute `scheme://` URL.
	pub path:                 String,
	/// Filter by file type: "file", "dir", or "symlink". Symlinks are
	/// matched for file/dir filters based on their target type.
	pub file_type:            Option<FileType>,
	/// Match simple patterns recursively by default (`*.ts` -> recursive).
	pub recursive:            Option<bool>,
	/// Follow descendant symbolic links with cycle detection (default: false).
	/// The filesystem provider is responsible for enforcing mount containment.
	pub follow_links:         Option<bool>,
	/// Include hidden files (default: false).
	pub hidden:               Option<bool>,
	/// Maximum number of results to return.
	pub max_results:          Option<u32>,
	/// Respect .gitignore files (default: true).
	pub gitignore:            Option<bool>,
	/// Reuse unchanged directory listings across calls (default: false).
	pub cache:                Option<bool>,
	/// Sort results by mtime (most recent first) before applying limit.
	pub sort_by_mtime:        Option<bool>,
	/// Include `node_modules` entries when the pattern does not explicitly
	/// mention them.
	pub include_node_modules: Option<bool>,
	/// Abort signal for cancelling the operation.
	pub signal:               Option<Unknown<'env>>,
	/// Timeout in milliseconds for the operation.
	pub timeout_ms:           Option<u32>,
	/// Filesystem the search root is resolved and walked through (native when
	/// absent).
	pub filesystem:           Option<ShellFilesystem>,
}

/// Result payload returned by a glob operation.
#[napi(object)]
pub struct GlobResult {
	/// Matched filesystem entries.
	pub matches:       Vec<GlobMatch>,
	/// Number of returned matches (`matches.len()`), clamped to `u32::MAX`.
	pub total_matches: u32,
}

impl From<pi_walker::glob::GlobMatch> for GlobMatch {
	fn from(entry: pi_walker::glob::GlobMatch) -> Self {
		Self {
			path:      entry.path,
			file_type: entry.file_type.into(),
			mtime:     entry.mtime.map(Self::millis),
			size:      entry.size.map(|size| size as f64),
		}
	}
}

impl GlobMatch {
	/// Unix nanoseconds to the milliseconds JavaScript dates use.
	pub(crate) const fn millis(nanos: i64) -> f64 {
		nanos.div_euclid(1_000_000) as f64
	}
}

/// Find filesystem entries matching a glob pattern.
///
/// Resolves the search root, runs the glob search, and optionally streams each
/// returned match through `on_match`.
///
/// # Errors
/// Returns an error when the search path cannot be resolved, the path is not a
/// directory, the glob pattern is invalid, or cancellation/timeout is
/// triggered.
#[napi]
pub fn glob<'env>(
	env: &'env Env,
	options: GlobOptions<'_>,
	#[napi(ts_arg_type = "((error: Error | null, match: GlobMatch) => void) | undefined | null")]
	on_match: Option<ThreadsafeFunction<GlobMatch>>,
) -> Result<PromiseRaw<'env, GlobResult>> {
	let GlobOptions {
		pattern,
		path,
		file_type,
		recursive,
		follow_links,
		hidden,
		max_results,
		gitignore,
		sort_by_mtime,
		cache,
		include_node_modules,
		timeout_ms,
		signal,
		filesystem,
	} = options;

	let filesystem = ShellFilesystem::resolve(filesystem);
	let opts = pi_walker::glob::GlobOptions {
		pattern,
		recursive: recursive.unwrap_or(true),
		file_type: file_type.map(Into::into),
		max_results: max_results.map(|value| value as usize),
		sort_by_mtime: sort_by_mtime.unwrap_or(false),
		include_node_modules,
		walk: pi_walker::walk::Options {
			hidden: hidden.unwrap_or(false),
			gitignore: gitignore.unwrap_or(true),
			follow_links: follow_links.unwrap_or(false),
			cache: cache.unwrap_or(false),
			..Default::default()
		},
	};

	let ct = task::CancelToken::new(timeout_ms, signal);
	task::filesystem_future(env, "glob", ct, filesystem, move |filesystem| async move {
		let root = pi_walker::fs::resolve_dir(&filesystem, std::path::Path::new(&path))
			.await
			.map_err(task::walk_failure)?;
		let fs = pi_walker::Fs::new(&filesystem, &root);
		let matches: Vec<GlobMatch> = pi_walker::glob::glob(&fs, &root, &opts)
			.await
			.map_err(|err| match err {
				pi_walker::glob::GlobError::Walk(err) => task::walk_failure(err),
				err @ pi_walker::glob::GlobError::Pattern(_) => Error::from_reason(err.to_string()),
			})?
			.into_iter()
			.map(GlobMatch::from)
			.collect();
		if let Some(callback) = &on_match {
			for matched in &matches {
				callback.call(Ok(matched.clone()), ThreadsafeFunctionCallMode::NonBlocking);
			}
		}
		let total_matches = crate::utils::clamp_u32(matches.len() as u64);
		Ok(GlobResult { matches, total_matches })
	})
}
