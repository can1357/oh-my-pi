//! Filesystem discovery with glob patterns, ignore semantics, and shared scan
//! caching.
//!
//! # Overview
//! Resolves a search root, scans entries via `pi-walker`, applies glob matching
//! plus optional file-type filtering, and optionally streams each accepted
//! match through a callback.
//!
//! The walker always skips `.git`, and skips `node_modules` unless explicitly
//! requested.
//!
//! # Example
//! ```ignore
//! // JS: await native.glob({ pattern: "*.rs", path: "." })
//! ```

use std::{cmp::Ordering, path::Path};

use napi::{
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;

// Re-export entry types so existing `glob::FileType` / `glob::GlobMatch` paths still work.
pub use crate::iofs::{FileType, GlobMatch};
use crate::{glob_util, iofs, task};

/// Input options for `glob`, including traversal, filtering, and cancellation.
#[napi(object)]
pub struct GlobOptions<'env> {
	/// Glob pattern to match (e.g., "*.ts").
	pub pattern:              String,
	/// Directory to search.
	pub path:                 String,
	/// Filter by file type: "file", "dir", or "symlink". Symlinks are
	/// matched for file/dir filters based on their target type.
	pub file_type:            Option<FileType>,
	/// Match simple patterns recursively by default (`*.ts` -> recursive).
	pub recursive:            Option<bool>,
	/// Include hidden files (default: false).
	pub hidden:               Option<bool>,
	/// Maximum number of results to return.
	pub max_results:          Option<u32>,
	/// Respect .gitignore files (default: true).
	pub gitignore:            Option<bool>,
	/// Enable walker scan caching (default: false).
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
}

/// Result payload returned by a glob operation.
#[napi(object)]
pub struct GlobResult {
	/// Matched filesystem entries.
	pub matches:       Vec<GlobMatch>,
	/// Number of returned matches (`matches.len()`), clamped to `u32::MAX`.
	pub total_matches: u32,
}

/// Internal runtime config for a single glob execution.
struct GlobConfig {
	root:                  std::path::PathBuf,
	pattern:               String,
	recursive:             bool,
	include_hidden:        bool,
	file_type_filter:      Option<FileType>,
	max_results:           usize,
	use_gitignore:         bool,
	mentions_node_modules: bool,
	sort_by_mtime:         bool,
	cache:                 bool,
}

fn match_mtime(entry: &GlobMatch) -> f64 {
	entry.mtime.unwrap_or(0.0)
}

fn compare_matches_by_rank(a: &GlobMatch, b: &GlobMatch) -> Ordering {
	match_mtime(b)
		.total_cmp(&match_mtime(a))
		.then_with(|| a.path.cmp(&b.path))
}

fn resolve_symlink_target_type(root: &Path, relative_path: &str) -> Option<FileType> {
	let target_path = root.join(relative_path);
	let metadata = std::fs::metadata(target_path).ok()?;
	if metadata.is_dir() {
		Some(FileType::Dir)
	} else if metadata.is_file() {
		Some(FileType::File)
	} else {
		None
	}
}

fn apply_file_type_filter(entry: &GlobMatch, config: &GlobConfig) -> Option<FileType> {
	let Some(filter) = config.file_type_filter else {
		return Some(entry.file_type);
	};
	if entry.file_type == filter {
		return Some(entry.file_type);
	}
	if entry.file_type != FileType::Symlink {
		return None;
	}
	match filter {
		FileType::File | FileType::Dir => {
			let resolved = resolve_symlink_target_type(&config.root, &entry.path)?;
			if resolved == filter {
				Some(resolved)
			} else {
				None
			}
		},
		FileType::Symlink => None,
	}
}

fn collect_ranked_matches(
	request: &pi_walker::WalkRequest,
	config: &GlobConfig,
	ct: &task::CancelToken,
) -> Result<Vec<GlobMatch>> {
	let outcome = request
		.collect_ranked_with_heartbeat(
			pi_walker::WalkRank::MtimeDescPathAsc,
			config.max_results,
			|| ct.heartbeat(),
		)
		.map_err(iofs::map_walker_error)?;
	Ok(outcome.entries.into_iter().map(GlobMatch::from).collect())
}

fn collect_native_filtered_matches(
	request: &pi_walker::WalkRequest,
	config: &GlobConfig,
	ct: &task::CancelToken,
) -> Result<Vec<GlobMatch>> {
	let outcome = request
		.collect_with_heartbeat(|| ct.heartbeat())
		.map_err(iofs::map_walker_error)?;
	let mut collected = Vec::new();
	for entry in outcome.entries {
		ct.heartbeat()?;
		let mut matched_entry = GlobMatch::from(entry);
		let Some(effective_file_type) = apply_file_type_filter(&matched_entry, config) else {
			continue;
		};
		matched_entry.file_type = effective_file_type;
		collected.push(matched_entry);
		if !config.sort_by_mtime && collected.len() >= config.max_results {
			break;
		}
	}
	Ok(collected)
}

/// Executes walker-owned glob filtering plus optional native file-type
/// filtering, then optionally streams each returned match.
fn run_glob(
	config: GlobConfig,
	on_match: Option<&ThreadsafeFunction<GlobMatch>>,
	ct: task::CancelToken,
) -> Result<GlobResult> {
	let walk_glob_pattern = glob_util::build_glob_pattern(&config.pattern, config.recursive);
	// Non-recursive patterns bound the walk: `dir/*` must not traverse the
	// entire subtree under `dir` to match only direct children.
	let walk_depth_limit = glob_util::walk_depth_bound(&walk_glob_pattern);
	let walk_glob = pi_walker::CompiledWalkGlob::new([walk_glob_pattern])
		.map_err(|err| Error::from_reason(format!("Invalid glob pattern: {err}")))?;
	if config.max_results == 0 {
		return Ok(GlobResult { matches: Vec::new(), total_matches: 0 });
	}

	let scan_detail = if config.sort_by_mtime {
		pi_walker::WalkDetail::Full
	} else {
		pi_walker::WalkDetail::Minimal
	};
	let base_request = pi_walker::WalkRequest::new(config.root.clone())
		.hidden(config.include_hidden)
		.gitignore(config.use_gitignore)
		.skip_git(true)
		.skip_node_modules(!config.mentions_node_modules)
		.follow_links(pi_walker::FollowLinks::Never)
		.detail(scan_detail)
		.order(pi_walker::WalkOrder::Path)
		.emit_root(false)
		.depth(1, walk_depth_limit)
		.directory_errors(pi_walker::DirectoryErrorMode::SkipSkippable)
		.cache(config.cache)
		.empty_recheck(pi_walker::EmptyRecheck::Configured)
		.filter(
			pi_walker::WalkFilter::all()
				.glob(walk_glob)
				.node_modules_unless_mentioned(config.mentions_node_modules),
		);

	let mut matches = if config.sort_by_mtime && config.file_type_filter.is_none() {
		collect_ranked_matches(&base_request, &config, &ct)?
	} else {
		let request = if !config.sort_by_mtime && config.file_type_filter.is_none() {
			base_request.limit(config.max_results)
		} else {
			base_request
		};
		collect_native_filtered_matches(&request, &config, &ct)?
	};

	if config.sort_by_mtime {
		// Sorting mode: rank by mtime descending, then apply max-results truncation.
		matches.sort_by(compare_matches_by_rank);
		matches.truncate(config.max_results);
		if let Some(callback) = on_match {
			for matched_entry in &matches {
				callback.call(Ok(matched_entry.clone()), ThreadsafeFunctionCallMode::NonBlocking);
			}
		}
	}
	if !config.sort_by_mtime
		&& let Some(callback) = on_match
	{
		for matched_entry in &matches {
			callback.call(Ok(matched_entry.clone()), ThreadsafeFunctionCallMode::NonBlocking);
		}
	}
	let total_matches = matches.len().min(u32::MAX as usize) as u32;
	Ok(GlobResult { matches, total_matches })
}

/// Find filesystem entries matching a glob pattern.
///
/// Resolves the search root, scans entries, applies glob and optional file-type
/// filters, and optionally streams each accepted match through `on_match`.
///
/// When `sortByMtime` is enabled, the walker ranks matches by mtime before the
/// native layer applies final symlink-aware file-type filtering and callback
/// emission.
///
/// # Errors
/// Returns an error when the search path cannot be resolved, the path is not a
/// directory, the glob pattern is invalid, or cancellation/timeout is
/// triggered.
#[napi]
pub fn glob(
	options: GlobOptions<'_>,
	#[napi(ts_arg_type = "((error: Error | null, match: GlobMatch) => void) | undefined | null")]
	on_match: Option<ThreadsafeFunction<GlobMatch>>,
) -> task::Promise<GlobResult> {
	let GlobOptions {
		pattern,
		path,
		file_type,
		recursive,
		hidden,
		max_results,
		gitignore,
		sort_by_mtime,
		cache,
		include_node_modules,
		timeout_ms,
		signal,
	} = options;

	let pattern = pattern.trim();
	let pattern = if pattern.is_empty() { "*" } else { pattern };
	let pattern = pattern.to_string();

	let ct = task::CancelToken::new(timeout_ms, signal);

	task::blocking("glob", ct, move |ct| {
		run_glob(
			GlobConfig {
				root: pi_walker::resolve_search_path(&path).map_err(iofs::map_walker_error)?,
				include_hidden: hidden.unwrap_or(false),
				file_type_filter: file_type,
				recursive: recursive.unwrap_or(true),
				max_results: max_results.map_or(usize::MAX, |value| value as usize),
				use_gitignore: gitignore.unwrap_or(true),
				mentions_node_modules: include_node_modules
					.unwrap_or_else(|| pattern.contains("node_modules")),
				sort_by_mtime: sort_by_mtime.unwrap_or(false),
				cache: cache.unwrap_or(false),
				pattern,
			},
			on_match.as_ref(),
			ct,
		)
	})
}

#[cfg(test)]
mod tests {
	use std::{
		fs,
		path::{Path, PathBuf},
		sync::atomic::{AtomicU64, Ordering},
		time::{SystemTime, UNIX_EPOCH},
	};

	static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

	struct TempDirGuard(PathBuf);

	impl TempDirGuard {
		fn new() -> Self {
			let timestamp = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system time is after UNIX_EPOCH")
				.as_nanos();
			let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
			let path = std::env::temp_dir().join(format!("pi-glob-test-{timestamp}-{counter}"));
			fs::create_dir_all(&path).expect("create temp test directory");
			Self(path)
		}

		fn path(&self) -> &Path {
			&self.0
		}
	}

	impl Drop for TempDirGuard {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	fn match_paths(result: &super::GlobResult) -> Vec<&str> {
		result
			.matches
			.iter()
			.map(|entry| entry.path.as_str())
			.collect()
	}

	#[test]
	fn run_glob_with_gitignore_prunes_ignored_directory_but_keeps_matching_sibling() {
		let root = TempDirGuard::new();
		fs::create_dir_all(root.path().join(".git")).expect("create repo marker");
		fs::write(root.path().join(".gitignore"), "ignored/\n").expect("write gitignore");
		fs::create_dir_all(root.path().join("ignored")).expect("create ignored directory");
		fs::write(root.path().join("ignored/drop.rs"), "fn ignored() {}\n")
			.expect("write ignored rust file");
		fs::write(root.path().join("kept.rs"), "fn kept() {}\n").expect("write kept rust file");

		let result = super::run_glob(
			super::GlobConfig {
				root:                  root.path().to_path_buf(),
				pattern:               "*.rs".to_string(),
				recursive:             true,
				include_hidden:        false,
				file_type_filter:      Some(super::FileType::File),
				max_results:           usize::MAX,
				use_gitignore:         true,
				mentions_node_modules: false,
				sort_by_mtime:         false,
				cache:                 false,
			},
			None,
			crate::task::CancelToken::default(),
		)
		.expect("glob succeeds");

		let paths = match_paths(&result);
		assert_eq!(paths, ["kept.rs"]);
		assert_eq!(result.total_matches, 1);
		assert!(
			!result
				.matches
				.iter()
				.any(|entry| entry.path.starts_with("ignored/")),
			"gitignored directory should be pruned before matching, got {paths:?}"
		);
	}

	#[test]
	fn run_glob_depth_bounded_patterns_still_match_at_their_exact_depth() {
		// The walk for non-`**` patterns is depth-bounded (see walk_depth_bound);
		// this defends the boundary: matches AT the bound depth must survive,
		// deeper entries must not appear, and the mtime-ranked mode (the glob
		// tool default) must behave identically to the streaming mode.
		let root = TempDirGuard::new();
		fs::write(root.path().join("top.txt"), "top").expect("write top file");
		fs::create_dir_all(root.path().join("deep/nested")).expect("create nested dirs");
		fs::write(root.path().join("deep/child.txt"), "mid").expect("write mid file");
		fs::write(root.path().join("deep/nested/leaf.txt"), "leaf").expect("write leaf file");

		let run = |pattern: &str| {
			super::run_glob(
				super::GlobConfig {
					root:                  root.path().to_path_buf(),
					pattern:               pattern.to_string(),
					recursive:             false,
					include_hidden:        true,
					file_type_filter:      None,
					max_results:           100,
					use_gitignore:         true,
					mentions_node_modules: false,
					sort_by_mtime:         true,
					cache:                 false,
				},
				None,
				crate::task::CancelToken::default(),
			)
			.expect("glob succeeds")
		};

		let direct = run("*.txt");
		assert_eq!(match_paths(&direct), ["top.txt"]);

		let two_deep = run("deep/*.txt");
		assert_eq!(match_paths(&two_deep), ["deep/child.txt"]);

		let wildcard_dir = run("*/nested/leaf.txt");
		assert_eq!(match_paths(&wildcard_dir), ["deep/nested/leaf.txt"]);

		let recursive = run("**/*.txt");
		let mut recursive_paths = match_paths(&recursive);
		recursive_paths.sort_unstable();
		assert_eq!(recursive_paths, ["deep/child.txt", "deep/nested/leaf.txt", "top.txt"]);
	}
}
