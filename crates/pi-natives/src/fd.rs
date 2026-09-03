//! Fuzzy file path discovery for autocomplete and @-mention resolution.
//!
//! Searches for files and directories whose paths match a query string via
//! subsequence scoring. Uses `pi-walker` for directory traversal and caching.

use std::{cmp::Ordering, collections::BinaryHeap, path::Path};

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::{iofs, task};

/// Options for fuzzy file path search.
#[napi(object)]
pub struct FuzzyFindOptions<'env> {
	/// Fuzzy query to match against file paths (case-insensitive).
	pub query:       String,
	/// Directory to search.
	pub path:        String,
	/// Include hidden files (default: false).
	pub hidden:      Option<bool>,
	/// Respect .gitignore (default: true).
	pub gitignore:   Option<bool>,
	/// Enable walker scan caching (default: false).
	pub cache:       Option<bool>,
	/// Maximum number of matches to return (default: 100).
	pub max_results: Option<u32>,
	/// Abort signal for cancelling the operation.
	pub signal:      Option<Unknown<'env>>,
	/// Timeout in milliseconds for the operation.
	pub timeout_ms:  Option<u32>,
}

/// A single match in fuzzy find results.
#[napi(object)]
pub struct FuzzyFindMatch {
	/// Relative path from the search root (uses `/` separators).
	pub path:         String,
	/// Whether this entry is a directory.
	pub is_directory: bool,
	/// Match quality score (higher is better).
	pub score:        u32,
}

/// Result of fuzzy file path search.
#[napi(object)]
pub struct FuzzyFindResult {
	/// Matched entries (up to `maxResults`).
	pub matches:       Vec<FuzzyFindMatch>,
	/// Total number of matches found (may exceed `matches.len()`).
	pub total_matches: u32,
}

fn normalize_fuzzy_text(value: &str) -> String {
	value
		.chars()
		.filter(|ch| !ch.is_whitespace() && !matches!(ch, '/' | '\\' | '.' | '_' | '-'))
		.flat_map(|ch| ch.to_lowercase())
		.collect()
}

fn fuzzy_subsequence_score(query_chars: &[char], target: &str) -> u32 {
	if query_chars.is_empty() {
		return 1;
	}
	let mut query_index = 0usize;
	let mut gaps = 0u32;
	let mut last_match_index: Option<usize> = None;
	for (target_index, target_ch) in target.chars().enumerate() {
		if query_index >= query_chars.len() {
			break;
		}
		if query_chars[query_index] == target_ch {
			if let Some(last_index) = last_match_index
				&& target_index > last_index + 1
			{
				gaps = gaps.saturating_add(1);
			}
			last_match_index = Some(target_index);
			query_index += 1;
		}
	}
	if query_index != query_chars.len() {
		return 0;
	}
	let gap_penalty = gaps.saturating_mul(5);
	40u32.saturating_sub(gap_penalty).max(1)
}

fn score_fuzzy_path(
	path: &str,
	is_directory: bool,
	query_lower: &str,
	normalized_query: &str,
	query_chars: &[char],
) -> u32 {
	if query_lower.is_empty() {
		return if is_directory { 11 } else { 1 };
	}

	// Match against the full relative path only when the user typed a path-style
	// query (contains '/'). Plain queries should match by basename only, otherwise
	// '@plan' surfaces every file whose ancestor directories contain 'plan'.
	let query_has_slash = query_lower.contains('/');

	let file_name = Path::new(path)
		.file_name()
		.and_then(|name| name.to_str())
		.unwrap_or(path);
	let lower_file_name = file_name.to_lowercase();

	let mut score = if lower_file_name == query_lower {
		120
	} else if lower_file_name.starts_with(query_lower) {
		100
	} else if lower_file_name.contains(query_lower) {
		80
	} else if !query_has_slash {
		let normalized_file_name = normalize_fuzzy_text(file_name);
		let file_name_fuzzy = fuzzy_subsequence_score(query_chars, &normalized_file_name);
		if file_name_fuzzy > 0 {
			50 + file_name_fuzzy
		} else {
			0
		}
	} else {
		let lower_path = path.to_lowercase();
		if lower_path.contains(query_lower) {
			60
		} else {
			let normalized_file_name = normalize_fuzzy_text(file_name);
			let file_name_fuzzy = fuzzy_subsequence_score(query_chars, &normalized_file_name);
			if file_name_fuzzy > 0 {
				50 + file_name_fuzzy
			} else {
				let normalized_path = normalize_fuzzy_text(path);
				let path_fuzzy = if normalized_path == normalized_query {
					40
				} else {
					fuzzy_subsequence_score(query_chars, &normalized_path)
				};
				if path_fuzzy > 0 { 30 + path_fuzzy } else { 0 }
			}
		}
	};

	if is_directory && score > 0 {
		score += 10;
	}

	score
}

/// Directory depth of a relative match path (trailing slash ignored).
/// Used as a sort tie-break so equally scored matches surface shallow paths
/// first — `@scripts` should rank cwd-root `scripts/` above
/// `packages/*/scripts/`.
fn path_depth(path: &str) -> usize {
	path.trim_end_matches('/').matches('/').count()
}

/// A scored match carrying its precomputed depth, ordered worst-first.
///
/// The ordering is the exact inverse of the final result comparator (score
/// descending, then `path_depth` ascending, then `path` ascending), so the
/// greatest element of a `BinaryHeap<RankedMatch>` is the candidate that must
/// be evicted first, and `into_sorted_vec` yields the final best-first order.
struct RankedMatch {
	depth: usize,
	entry: FuzzyFindMatch,
}

impl RankedMatch {
	fn new(entry: FuzzyFindMatch) -> Self {
		let depth = path_depth(&entry.path);
		Self { depth, entry }
	}
}

impl Ord for RankedMatch {
	fn cmp(&self, other: &Self) -> Ordering {
		other
			.entry
			.score
			.cmp(&self.entry.score)
			.then_with(|| self.depth.cmp(&other.depth))
			.then_with(|| self.entry.path.cmp(&other.entry.path))
	}
}

impl PartialOrd for RankedMatch {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

impl PartialEq for RankedMatch {
	fn eq(&self, other: &Self) -> bool {
		self.cmp(other) == Ordering::Equal
	}
}

impl Eq for RankedMatch {}

/// Bounded collector retaining at most `capacity` best matches while counting
/// every hit, so `totalMatches` stays exact even when it exceeds `maxResults`.
struct TopMatches {
	capacity: usize,
	total:    u64,
	heap:     BinaryHeap<RankedMatch>,
}

impl TopMatches {
	fn new(capacity: usize) -> Self {
		Self { capacity, total: 0, heap: BinaryHeap::with_capacity(capacity.min(256)) }
	}

	fn push(&mut self, entry: FuzzyFindMatch) {
		self.total = self.total.saturating_add(1);
		if self.capacity == 0 {
			return;
		}
		let candidate = RankedMatch::new(entry);
		if self.heap.len() < self.capacity {
			self.heap.push(candidate);
			return;
		}
		// The root is the worst retained candidate; replace it only when the new
		// candidate outranks it under the final comparator.
		if self.heap.peek().is_some_and(|worst| candidate < *worst) {
			self.heap.pop();
			self.heap.push(candidate);
		}
	}

	/// Exact number of scoring hits, clamped to the `u32` wire type.
	const fn total_matches(&self) -> u32 {
		crate::utils::clamp_u32(self.total)
	}

	/// Retained matches ordered by score descending, then shallower paths, then
	/// path ascending.
	fn into_sorted_matches(self) -> Vec<FuzzyFindMatch> {
		self
			.heap
			.into_sorted_vec()
			.into_iter()
			.map(|ranked| ranked.entry)
			.collect()
	}
}

struct FuzzyFindConfig {
	query:       String,
	path:        String,
	hidden:      Option<bool>,
	gitignore:   Option<bool>,
	max_results: Option<u32>,
	cache:       Option<bool>,
}

fn score_entries<I>(
	entries: I,
	query_lower: &str,
	normalized_query: &str,
	query_chars: &[char],
	max_results: usize,
	ct: &task::CancelToken,
) -> Result<TopMatches>
where
	I: IntoIterator<Item = iofs::GlobMatch>,
{
	let mut scored = TopMatches::new(max_results);
	for entry in entries {
		ct.heartbeat()?;
		if entry.file_type == iofs::FileType::Symlink {
			continue;
		}

		let is_directory = entry.file_type == iofs::FileType::Dir;
		let score =
			score_fuzzy_path(&entry.path, is_directory, query_lower, normalized_query, query_chars);
		if score == 0 {
			continue;
		}

		let mut path = entry.path;
		if is_directory {
			path.push('/');
		}
		scored.push(FuzzyFindMatch { path, is_directory, score });
	}
	Ok(scored)
}

fn fuzzy_find_sync(config: FuzzyFindConfig, ct: task::CancelToken) -> Result<FuzzyFindResult> {
	let root = pi_walker::resolve_search_path(&config.path).map_err(iofs::map_walker_error)?;
	let include_hidden = config.hidden.unwrap_or(false);
	let respect_gitignore = config.gitignore.unwrap_or(true);
	let max_results = config.max_results.unwrap_or(100) as usize;
	if max_results == 0 {
		return Ok(FuzzyFindResult { matches: Vec::new(), total_matches: 0 });
	}

	let query_lower = config.query.trim().to_lowercase();
	let normalized_query = normalize_fuzzy_text(&query_lower);
	let query_chars: Vec<char> = normalized_query.chars().collect();
	if !query_lower.is_empty() && normalized_query.is_empty() {
		return Ok(FuzzyFindResult { matches: Vec::new(), total_matches: 0 });
	}

	let outcome = pi_walker::WalkRequest::new(root)
		.hidden(include_hidden)
		.gitignore(respect_gitignore)
		.skip_git(true)
		.skip_node_modules(true)
		.follow_links(pi_walker::FollowLinks::Always)
		.detail(pi_walker::WalkDetail::Minimal)
		.order(pi_walker::WalkOrder::Path)
		.emit_root(false)
		.depth(1, usize::MAX)
		.directory_errors(pi_walker::DirectoryErrorMode::SkipSkippable)
		.cache(config.cache.unwrap_or(false))
		.empty_recheck(pi_walker::EmptyRecheck::Configured)
		.collect_with_heartbeat(|| ct.heartbeat())
		.map_err(iofs::map_walker_error)?;
	let scored = score_entries(
		outcome.entries.into_iter().map(iofs::GlobMatch::from),
		&query_lower,
		&normalized_query,
		&query_chars,
		max_results,
		&ct,
	)?;

	let total_matches = scored.total_matches();
	let matches = scored.into_sorted_matches();
	Ok(FuzzyFindResult { matches, total_matches })
}

/// Fuzzy file path search for autocomplete.
#[napi(js_name = "fuzzyFind")]
pub fn fuzzy_find(options: FuzzyFindOptions<'_>) -> task::Promise<FuzzyFindResult> {
	let FuzzyFindOptions { query, path, hidden, gitignore, cache, max_results, timeout_ms, signal } =
		options;
	let ct = task::CancelToken::new(timeout_ms, signal);
	let config = FuzzyFindConfig { query, path, hidden, gitignore, max_results, cache };
	task::blocking("fuzzy_find", ct, move |ct| fuzzy_find_sync(config, ct))
}

#[cfg(test)]
mod tests {
	#[cfg(unix)]
	use std::{
		fs,
		os::unix::fs as unix_fs,
		path::{Path, PathBuf},
		sync::atomic::{AtomicU64, Ordering},
		time::{SystemTime, UNIX_EPOCH},
	};

	#[cfg(unix)]
	use super::{FuzzyFindConfig, fuzzy_find_sync};
	#[cfg(unix)]
	use crate::task;

	#[cfg(unix)]
	struct TempDirGuard(PathBuf);

	#[cfg(unix)]
	impl TempDirGuard {
		fn new() -> Self {
			static COUNTER: AtomicU64 = AtomicU64::new(0);
			let nanos = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system time is after UNIX_EPOCH")
				.as_nanos();
			let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
			let pid = std::process::id();
			let path = std::env::temp_dir().join(format!("pi-fd-test-{pid}-{nanos}-{seq}"));
			fs::create_dir_all(&path).expect("create temp test directory");
			Self(path)
		}

		fn path(&self) -> &Path {
			&self.0
		}
	}

	#[cfg(unix)]
	impl Drop for TempDirGuard {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	#[cfg(unix)]
	#[test]
	fn fuzzy_find_without_cache_follows_symlinked_directories() {
		let root = TempDirGuard::new();
		let real_dir = root.path().join("zz-real-dir");
		let link_dir_name = "aa-linked-dir";
		let link_dir = root.path().join(link_dir_name);
		let file_name = "follow-links-fuzzy-needle.txt";

		fs::create_dir_all(&real_dir).expect("create real directory");
		fs::write(real_dir.join(file_name), "needle\n").expect("write symlink target file");
		unix_fs::symlink(&real_dir, &link_dir).expect("create directory symlink");

		let result = fuzzy_find_sync(
			FuzzyFindConfig {
				query:       file_name.to_string(),
				path:        root.path().to_string_lossy().into_owned(),
				hidden:      Some(true),
				gitignore:   Some(false),
				max_results: Some(4),
				cache:       Some(false),
			},
			task::CancelToken::default(),
		)
		.expect("fuzzy find succeeds");

		assert!(!result.matches.is_empty(), "expected at least one fuzzy find match");
		let expected_path = format!("{link_dir_name}/{file_name}");
		assert!(
			result
				.matches
				.iter()
				.any(|entry| entry.path == expected_path),
			"expected fuzzy find to include symlink traversal path {expected_path:?}, got {:?}",
			result
				.matches
				.iter()
				.map(|entry| entry.path.as_str())
				.collect::<Vec<_>>()
		);
	}

	#[cfg(unix)]
	#[test]
	fn fuzzy_find_ranks_shallow_paths_first_on_score_tie() {
		let root = TempDirGuard::new();
		// Same-named directories at different depths all score identically
		// (exact basename match + directory bonus); the shallow one must win.
		fs::create_dir_all(root.path().join("scripts")).expect("create root scripts dir");
		fs::create_dir_all(root.path().join(".omp/skills/opt/scripts"))
			.expect("create hidden nested scripts dir");
		fs::create_dir_all(root.path().join("packages/ai/scripts"))
			.expect("create nested scripts dir");

		let result = fuzzy_find_sync(
			FuzzyFindConfig {
				query:       "scripts".to_string(),
				path:        root.path().to_string_lossy().into_owned(),
				hidden:      Some(true),
				gitignore:   Some(false),
				max_results: Some(10),
				cache:       Some(false),
			},
			task::CancelToken::default(),
		)
		.expect("fuzzy find succeeds");

		let paths: Vec<&str> = result
			.matches
			.iter()
			.map(|entry| entry.path.as_str())
			.collect();
		assert_eq!(
			paths.first(),
			Some(&"scripts/"),
			"expected cwd-root scripts/ to rank first, got {paths:?}"
		);
	}

	#[cfg(unix)]
	#[test]
	fn fuzzy_find_reports_exact_total_beyond_max_results() {
		let root = TempDirGuard::new();
		for index in 0..12 {
			fs::write(root.path().join(format!("needle-{index}.txt")), "needle\n")
				.expect("write fixture file");
		}

		let result = fuzzy_find_sync(
			FuzzyFindConfig {
				query:       "needle".to_string(),
				path:        root.path().to_string_lossy().into_owned(),
				hidden:      Some(true),
				gitignore:   Some(false),
				max_results: Some(3),
				cache:       Some(false),
			},
			task::CancelToken::default(),
		)
		.expect("fuzzy find succeeds");

		assert_eq!(result.matches.len(), 3, "retained matches must honor maxResults");
		assert_eq!(result.total_matches, 12, "total must count every hit, not the retained ones");
		let paths: Vec<&str> = result
			.matches
			.iter()
			.map(|entry| entry.path.as_str())
			.collect();
		assert_eq!(
			paths,
			vec!["needle-0.txt", "needle-1.txt", "needle-10.txt"],
			"bounded retention must keep the same order as the full sort"
		);
	}

	#[test]
	fn bounded_retention_matches_reference_ordering_and_total() {
		use super::{FuzzyFindMatch, TopMatches, path_depth};

		// Score ties across depths and directories are the cases where a bounded
		// heap can diverge from the full sort, so cover them explicitly.
		let candidates = [
			("packages/ai/scripts/", true, 130u32),
			("scripts/", true, 130),
			(".omp/skills/opt/scripts/", true, 130),
			("src/scripts.ts", false, 120),
			("src/deep/nested/scripts.ts", false, 120),
			("a/scripts.ts", false, 120),
			("notes/script-notes.md", false, 80),
			("z.txt", false, 51),
		];

		let mut reference: Vec<(u32, usize, String)> = candidates
			.iter()
			.map(|(path, _, score)| (*score, path_depth(path), (*path).to_string()))
			.collect();
		reference.sort_by(|a, b| {
			b.0.cmp(&a.0)
				.then_with(|| a.1.cmp(&b.1))
				.then_with(|| a.2.cmp(&b.2))
		});

		for max_results in 1..=candidates.len() + 2 {
			let mut bounded = TopMatches::new(max_results);
			for (path, is_directory, score) in candidates {
				bounded.push(FuzzyFindMatch { path: path.to_string(), is_directory, score });
			}
			let total = bounded.total_matches();
			let bounded_paths: Vec<String> = bounded
				.into_sorted_matches()
				.into_iter()
				.map(|entry| entry.path)
				.collect();
			let expected_paths: Vec<String> = reference
				.iter()
				.take(max_results)
				.map(|(_, _, path)| path.clone())
				.collect();

			assert_eq!(total, candidates.len() as u32, "total must count every pushed hit");
			assert_eq!(
				bounded_paths, expected_paths,
				"bounded order must match the full sort for max_results={max_results}"
			);
		}
	}

	#[test]
	fn bounded_retention_matches_full_sort_on_large_corpus() {
		use super::{FuzzyFindMatch, TopMatches, path_depth};

		const CANDIDATE_COUNT: usize = 100_000;
		const MAX_RESULTS: usize = 128;

		let mut reference = Vec::with_capacity(CANDIDATE_COUNT);
		let mut bounded = TopMatches::new(MAX_RESULTS);
		for index in 0..CANDIDATE_COUNT {
			let depth = index % 7;
			let path = format!("{}{index:06}-item.txt", "nested/".repeat(depth));
			let score = 50 + (index % 83) as u32;
			reference.push((score, path_depth(&path), path.clone()));
			bounded.push(FuzzyFindMatch { path, is_directory: false, score });
			assert!(
				bounded.heap.len() <= MAX_RESULTS,
				"retention exceeded maxResults after candidate {index}"
			);
		}
		assert_eq!(reference.len(), CANDIDATE_COUNT);
		assert_eq!(bounded.heap.len(), MAX_RESULTS);
		assert_eq!(bounded.total_matches(), CANDIDATE_COUNT as u32);

		reference.sort_by(|a, b| {
			b.0.cmp(&a.0)
				.then_with(|| a.1.cmp(&b.1))
				.then_with(|| a.2.cmp(&b.2))
		});
		let expected: Vec<String> = reference
			.into_iter()
			.take(MAX_RESULTS)
			.map(|(_, _, path)| path)
			.collect();
		let actual: Vec<String> = bounded
			.into_sorted_matches()
			.into_iter()
			.map(|entry| entry.path)
			.collect();

		assert_eq!(actual, expected, "bounded top-K must match the complete baseline sort");
	}

	#[test]
	fn bounded_retention_counts_hits_with_zero_capacity() {
		use super::{FuzzyFindMatch, TopMatches};

		let mut bounded = TopMatches::new(0);
		for index in 0..5 {
			bounded.push(FuzzyFindMatch {
				path:         format!("file-{index}.txt"),
				is_directory: false,
				score:        10,
			});
		}

		assert_eq!(bounded.total_matches(), 5);
		assert!(bounded.into_sorted_matches().is_empty());
	}
}
