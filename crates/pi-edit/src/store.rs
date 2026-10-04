//! Session-scoped snapshots, clipboard registers, and no-op loop state.

use std::{
	collections::{BTreeSet, HashMap},
	path::{Path, PathBuf},
	sync::{Arc, LazyLock},
};

use parking_lot::Mutex;
use regex::Regex;
use xxhash_rust::{xxh32::Xxh32, xxh64::xxh64};

/// Retained path count before LRU eviction.
pub const DEFAULT_MAX_PATHS: usize = 256;
/// Full-file versions retained per path.
pub const DEFAULT_MAX_VERSIONS_PER_PATH: usize = 4;
/// Global ceiling on snapshot text and buffer allocations, measured in bytes.
///
/// Hash-map buckets, allocator rounding, and snapshots held by callers are
/// outside this budget. Clipboard registers and no-op counters are separate.
pub const DEFAULT_MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;
/// Files larger than this are never snapshotted from disk.
pub const MAX_SNAPSHOT_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// Consecutive identical no-ops before the guard escalates.
pub const NOOP_HARD_LIMIT: u32 = 3;

/// One full-file version observed at a point in time.
#[derive(Debug, Clone)]
pub struct Snapshot {
	/// Canonical path this version belongs to.
	pub path:       PathBuf,
	/// Full LF-normalized, BOM-stripped text.
	pub text:       Arc<str>,
	/// Four-character content tag.
	pub hash:       String,
	/// Lines displayed from this version, when provenance was recorded.
	pub seen_lines: Option<BTreeSet<u32>>,
}

/// Clipboard registers threaded through one patch application.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Clipboard {
	/// Latest anonymous cut.
	pub lines:             Option<Vec<String>>,
	/// Named registers, retained between batches.
	pub named:             Option<HashMap<String, Vec<String>>>,
	/// Anonymous cuts not yet consumed.
	pub pending_anon_cuts: Option<Vec<String>>,
}

impl Clipboard {
	/// Start a batch with named registers only.
	pub fn start_batch(source: &Self) -> Self {
		Self { named: source.named.clone(), ..Self::default() }
	}

	/// Make a transactional deep copy.
	pub fn fork(&self) -> Self {
		self.clone()
	}

	/// Merge named registers from a completed transaction.
	pub fn commit_from(&mut self, fork: &Self) {
		let Some(named) = &fork.named else { return };
		self
			.named
			.get_or_insert_with(HashMap::new)
			.extend(named.clone());
	}
}

/// Compute the four-hex uppercase hashline content tag.
///
/// Hashes the text with trailing spaces, tabs, and CRs stripped from every
/// line. Unchanged runs between stripped spans are fed straight from `text`, so
/// no normalized copy is built.
pub fn file_hash(text: &str) -> String {
	let bytes = text.as_bytes();
	let mut hasher = Xxh32::new(0);
	let mut run_start = 0;
	let mut line_start = 0;
	for segment in text.split_inclusive('\n') {
		let line = segment.strip_suffix('\n').unwrap_or(segment);
		let kept = line.trim_end_matches([' ', '\t', '\r']).len();
		if kept < line.len() {
			hasher.update(&bytes[run_start..line_start + kept]);
			run_start = line_start + line.len();
		}
		line_start += segment.len();
	}
	hasher.update(&bytes[run_start..]);
	format!("{:04X}", hasher.digest() & 0xffff)
}

/// Compute a stable 64-bit key for raw patch input.
pub fn payload_hash(text: &str) -> u64 {
	xxh64(text.as_bytes(), 0)
}

static SEEN_LINE_PREFIX_RE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^[ *]?(\d+)(?:-(\d+))?:").expect("valid hashline prefix regex"));

/// Parse displayed boundary line numbers from a hashline-formatted body.
pub fn seen_lines_from_body(body: &str) -> Vec<u32> {
	let mut seen = Vec::new();
	for row in body.split('\n') {
		let Some(captures) = SEEN_LINE_PREFIX_RE.captures(row) else {
			continue;
		};
		if let Ok(line) = captures[1].parse() {
			seen.push(line);
		}
		if let Some(end) = captures
			.get(2)
			.and_then(|value| value.as_str().parse().ok())
		{
			seen.push(end);
		}
	}
	seen
}

struct StoredSnapshot {
	text:       Arc<str>,
	hash:       String,
	seen_lines: Option<Vec<u32>>,
}

impl StoredSnapshot {
	fn retained_bytes(&self) -> usize {
		(self.text.len() + 2 * size_of::<usize>()).next_multiple_of(size_of::<usize>())
			+ self.hash.capacity()
			+ self
				.seen_lines
				.as_ref()
				.map_or(0, |lines| lines.capacity() * size_of::<u32>())
	}

	fn snapshot(&self, path: &Path) -> Snapshot {
		Snapshot {
			path:       path.to_owned(),
			text:       Arc::clone(&self.text),
			hash:       self.hash.clone(),
			seen_lines: self
				.seen_lines
				.as_ref()
				.map(|lines| lines.iter().copied().collect()),
		}
	}
}

struct PathHistory {
	versions: Vec<StoredSnapshot>,
	touched:  u64,
}

impl PathHistory {
	fn retained_bytes(&self, path_bytes: usize) -> usize {
		path_bytes
			+ self.versions.capacity() * size_of::<StoredSnapshot>()
			+ self
				.versions
				.iter()
				.map(StoredSnapshot::retained_bytes)
				.sum::<usize>()
	}
}

struct StoreState {
	histories:       HashMap<PathBuf, PathHistory>,
	clipboard:       Clipboard,
	noop:            HashMap<PathBuf, (u64, u32)>,
	clock:           u64,
	max_paths:       usize,
	max_versions:    usize,
	max_total_bytes: usize,
	retained_bytes:  usize,
}

impl Default for StoreState {
	fn default() -> Self {
		Self {
			histories:       HashMap::new(),
			clipboard:       Clipboard::default(),
			noop:            HashMap::new(),
			clock:           0,
			max_paths:       DEFAULT_MAX_PATHS,
			max_versions:    DEFAULT_MAX_VERSIONS_PER_PATH,
			max_total_bytes: DEFAULT_MAX_TOTAL_BYTES,
			retained_bytes:  0,
		}
	}
}

/// Thread-safe state shared for the lifetime of an edit session.
#[derive(Default, Clone)]
pub struct EditStore {
	inner: Arc<Mutex<StoreState>>,
}

impl EditStore {
	/// Construct a store with production retention limits.
	pub fn new() -> Self {
		Self::default()
	}

	/// Construct a store with an explicit byte budget and retention limits.
	pub fn with_limits(max_paths: usize, max_versions: usize, max_total_bytes: usize) -> Self {
		let state = StoreState { max_paths, max_versions, max_total_bytes, ..StoreState::default() };
		Self { inner: Arc::new(Mutex::new(state)) }
	}

	/// Record normalized text under a canonical path and return its tag.
	pub fn record(&self, path: &Path, text: &str, seen_lines: Option<&[u32]>) -> String {
		let hash = file_hash(text);
		let mut state = self.inner.lock();
		state.clock = state.clock.wrapping_add(1);
		let touched = state.clock;
		let max_versions = state.max_versions;
		let mut previous_bytes = 0;
		let entry = state.histories.entry(path.to_owned());
		let path_bytes = entry.key().capacity();
		let history = entry
			.and_modify(|history| previous_bytes = history.retained_bytes(path_bytes))
			.or_insert_with(|| PathHistory { versions: Vec::new(), touched });
		history.touched = touched;
		if let Some(index) = history
			.versions
			.iter()
			.position(|version| version.hash == hash && &*version.text == text)
		{
			let mut snapshot = history.versions.remove(index);
			merge_seen(&mut snapshot, seen_lines);
			history.versions.insert(0, snapshot);
		} else if max_versions > 0 {
			let mut snapshot = StoredSnapshot {
				text:       Arc::from(text),
				hash:       hash.clone(),
				seen_lines: None,
			};
			merge_seen(&mut snapshot, seen_lines);
			history.versions.insert(0, snapshot);
			history.versions.truncate(max_versions);
		}
		let current_bytes = history.retained_bytes(path_bytes);
		state.retained_bytes = state.retained_bytes - previous_bytes + current_bytes;
		evict(&mut state);
		hash
	}

	/// Read, normalize, and record a file if it is readable and at most 4 MiB.
	pub fn record_file(&self, absolute: &Path, seen_lines: Option<&[u32]>) -> Option<String> {
		if std::fs::metadata(absolute).ok()?.len() > MAX_SNAPSHOT_FILE_BYTES {
			return None;
		}
		let raw = std::fs::read_to_string(absolute).ok()?;
		if raw.len() as u64 > MAX_SNAPSHOT_FILE_BYTES {
			return None;
		}
		let (_, without_bom) = crate::text::strip_bom(&raw);
		let normalized = crate::text::normalize_to_lf(without_bom);
		let key = crate::path_policy::canonical_key(absolute);
		Some(self.record(&key, &normalized, seen_lines))
	}

	/// Union displayed lines into the most recent version matching a tag.
	pub fn record_seen_lines(&self, path: &Path, hash: &str, lines: &[u32]) {
		let mut state = self.inner.lock();
		touch(&mut state, path);
		let Some(history) = state.histories.get_mut(path) else {
			return;
		};
		let Some(version) = history.versions.iter_mut().find(|v| v.hash == hash) else {
			return;
		};
		let previous_bytes = version.retained_bytes();
		merge_seen(version, Some(lines));
		let current_bytes = version.retained_bytes();
		state.retained_bytes = state.retained_bytes - previous_bytes + current_bytes;
		evict(&mut state);
	}

	/// Return the current version and refresh path recency.
	pub fn head(&self, path: &Path) -> Option<Snapshot> {
		let mut state = self.inner.lock();
		touch(&mut state, path);
		let (path, history) = state.histories.get_key_value(path)?;
		history.versions.first().map(|v| v.snapshot(path))
	}

	/// Every retained snapshot for a path, newest first.
	pub fn versions(&self, path: &Path) -> Vec<Snapshot> {
		let mut state = self.inner.lock();
		touch(&mut state, path);
		state.histories.get(path).map_or_else(Vec::new, |history| {
			history
				.versions
				.iter()
				.map(|version| version.snapshot.clone())
				.collect()
		})
	}

	/// Return the most recent version matching a tag and refresh path recency.
	pub fn by_hash(&self, path: &Path, hash: &str) -> Option<Snapshot> {
		let mut state = self.inner.lock();
		touch(&mut state, path);
		let (path, history) = state.histories.get_key_value(path)?;
		history
			.versions
			.iter()
			.find(|v| v.hash == hash)
			.map(|v| v.snapshot(path))
	}

	/// Return the version with exactly equal text and refresh path recency.
	pub fn by_content(&self, path: &Path, text: &str) -> Option<Snapshot> {
		let mut state = self.inner.lock();
		touch(&mut state, path);
		let (path, history) = state.histories.get_key_value(path)?;
		history
			.versions
			.iter()
			.find(|v| &*v.text == text)
			.map(|v| v.snapshot(path))
	}

	/// Return every retained version matching a tag.
	pub fn find_by_hash(&self, hash: &str) -> Vec<Snapshot> {
		let state = self.inner.lock();
		state
			.histories
			.iter()
			.flat_map(|(path, h)| h.versions.iter().map(move |v| (path, v)))
			.filter(|(_, v)| v.hash == hash)
			.map(|(path, v)| v.snapshot(path))
			.collect()
	}

	/// Remove one path's history.
	pub fn invalidate(&self, path: &Path) {
		let mut state = self.inner.lock();
		if let Some((path, history)) = state.histories.remove_entry(path) {
			state.retained_bytes -= history.retained_bytes(path.capacity());
		}
	}

	/// Move source history and provenance to a destination path.
	pub fn relocate(&self, from: &Path, to: &Path) {
		let mut state = self.inner.lock();
		state.clock = state.clock.wrapping_add(1);
		let touched = state.clock;
		let max_versions = state.max_versions;
		let Some((source_path, source)) = state.histories.remove_entry(from) else {
			return;
		};
		state.retained_bytes -= source.retained_bytes(source_path.capacity());
		let mut merged = source.versions;
		if let Some((destination_path, destination)) = state.histories.remove_entry(to) {
			state.retained_bytes -= destination.retained_bytes(destination_path.capacity());
			merged.extend(destination.versions);
		}
		let mut hashes = BTreeSet::new();
		merged.retain(|version| hashes.insert(version.hash.clone()));
		merged.truncate(max_versions);
		let history = PathHistory { versions: merged, touched };
		let path = to.to_owned();
		state.retained_bytes += history.retained_bytes(path.capacity());
		state.histories.insert(path, history);
		evict(&mut state);
	}

	/// Remove all snapshots, clipboard state, and no-op counters.
	pub fn clear(&self) {
		*self.inner.lock() = StoreState::default();
	}

	/// Start a clipboard batch with persisted named registers.
	pub fn start_clipboard_batch(&self) -> Clipboard {
		Clipboard::start_batch(&self.inner.lock().clipboard)
	}

	/// Publish named registers from a batch fork.
	pub fn commit_clipboard(&self, fork: &Clipboard) {
		self.inner.lock().clipboard.commit_from(fork);
	}

	/// Record an identical no-op and return its consecutive count and escalation
	/// state.
	pub fn record_noop(&self, path: &Path, payload: u64) -> (u32, bool) {
		let mut state = self.inner.lock();
		let count = state
			.noop
			.get(path)
			.filter(|(hash, _)| *hash == payload)
			.map_or(1, |(_, count)| count + 1);
		state.noop.insert(path.to_owned(), (payload, count));
		(count, count >= NOOP_HARD_LIMIT)
	}

	/// Clear one path's no-op counter.
	pub fn reset_noop(&self, path: &Path) {
		self.inner.lock().noop.remove(path);
	}
}

fn merge_seen(snapshot: &mut StoredSnapshot, lines: Option<&[u32]>) {
	let Some(lines) = lines else { return };
	let seen = snapshot.seen_lines.get_or_insert_with(Vec::new);
	let mut added: Vec<_> = lines
		.iter()
		.copied()
		.filter(|line| seen.binary_search(line).is_err())
		.collect();
	added.sort_unstable();
	added.dedup();
	if added.is_empty() {
		return;
	}
	seen.extend(added);
	seen.sort_unstable();
}

fn touch(state: &mut StoreState, path: &Path) {
	if state.histories.contains_key(path) {
		state.clock = state.clock.wrapping_add(1);
		state
			.histories
			.get_mut(path)
			.expect("checked above")
			.touched = state.clock;
	}
}

fn evict(state: &mut StoreState) {
	while state.histories.len() > state.max_paths || state.retained_bytes > state.max_total_bytes {
		let Some(oldest) = state
			.histories
			.iter()
			.min_by_key(|(_, history)| history.touched)
			.map(|(path, _)| path.clone())
		else {
			break;
		};
		if let Some((path, history)) = state.histories.remove_entry(&oldest) {
			state.retained_bytes -= history.retained_bytes(path.capacity());
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn file_hash_matches_typescript() {
		assert_eq!(file_hash("a \n b\t\r\nc"), "80BA");
		assert_eq!(file_hash("hello\n"), "5BF9");
		assert_eq!(file_hash(""), "5D05");
	}

	/// Hashes a normalized copy — the reference `file_hash` must stay
	/// bit-identical to.
	fn file_hash_of_normalized_copy(text: &str) -> String {
		let mut normalized = String::with_capacity(text.len());
		for segment in text.split_inclusive('\n') {
			let (line, newline) = segment
				.strip_suffix('\n')
				.map_or((segment, ""), |line| (line, "\n"));
			normalized.push_str(line.trim_end_matches([' ', '\t', '\r']));
			normalized.push_str(newline);
		}
		format!("{:04X}", xxhash_rust::xxh32::xxh32(normalized.as_bytes(), 0) & 0xffff)
	}

	#[test]
	fn file_hash_streams_the_normalized_text() {
		let long_line = "x".repeat(100);
		let cases = [
			String::new(),
			"\n".to_owned(),
			"\r\n".to_owned(),
			" \t\r".to_owned(),
			"no final newline".to_owned(),
			"no final newline with trailing space \t".to_owned(),
			"crlf\r\nlines\r\nend\r\n".to_owned(),
			"crlf without final\r\nnewline\r".to_owned(),
			"trailing  \nwhitespace\t\t\n  only indent kept\n   \n\t\n".to_owned(),
			"lone\rcarriage\r\rreturns \r\r\n".to_owned(),
			"mixed 😀 \t\r\nünïcödé  \n中文\r".to_owned(),
			format!("{long_line} \n{long_line}\r\n{long_line}\n{long_line}\t"),
			(0..200)
				.map(|n| format!("line {n}{}", ["", " ", "\t", "\r", " \r"][n % 5]))
				.collect::<Vec<_>>()
				.join("\n"),
		];
		for text in &cases {
			assert_eq!(file_hash(text), file_hash_of_normalized_copy(text), "{text:?}");
		}
	}

	#[test]
	fn snapshots_deduplicate_promote_and_union_seen_lines() {
		let store = EditStore::new();
		let path = Path::new("a.ts");
		let first = store.record(path, "one", Some(&[1]));
		store.record(path, "two", Some(&[2]));
		assert_eq!(&*store.head(path).unwrap().text, "two");
		assert_eq!(store.record(path, "one", Some(&[3])), first);
		let head = store.head(path).unwrap();
		assert_eq!(&*head.text, "one");
		assert_eq!(head.seen_lines.unwrap(), BTreeSet::from([1, 3]));
	}

	#[test]
	fn versions_lists_newest_first() {
		let store = EditStore::new();
		let path = Path::new("a.ts");
		store.record(path, "one", Some(&[1]));
		store.record(path, "two", Some(&[2]));
		let texts: Vec<String> = store
			.versions(path)
			.iter()
			.map(|snapshot| snapshot.text.to_string())
			.collect();
		assert_eq!(texts, ["two", "one"]);
	}

	#[test]
	fn version_and_lru_limits_are_enforced() {
		let store = EditStore::with_limits(2, 2, usize::MAX);
		for text in ["one", "two", "three"] {
			store.record(Path::new("a"), text, None);
		}
		assert!(store.by_content(Path::new("a"), "one").is_none());
		store.record(Path::new("b"), "b", None);
		store.head(Path::new("a"));
		store.record(Path::new("c"), "c", None);
		assert!(store.head(Path::new("b")).is_none());
		assert!(store.head(Path::new("a")).is_some());
	}

	#[test]
	fn unicode_snapshot_eviction_counts_utf8_storage() {
		for (text, retained) in [
			("a".repeat(2_000), true),
			("文".repeat(2_000), false),
			("😀".repeat(1_100), false),
			(format!("{}{}", "a".repeat(500), "文".repeat(1_500)), false),
		] {
			let store = EditStore::with_limits(10, 4, 4_096);
			let path = Path::new("unicode");
			store.record(path, &text, None);
			assert_eq!(store.head(path).is_some(), retained, "{} UTF-8 bytes", text.len());
		}
	}

	#[test]
	fn byte_budget_evicts_the_oldest_path() {
		let store = EditStore::with_limits(10, 4, 4_096);
		store.record(Path::new("old"), &"😀".repeat(600), None);
		store.record(Path::new("new"), &"ab".repeat(1_200), None);
		assert!(store.head(Path::new("old")).is_none());
		assert!(store.head(Path::new("new")).is_some());
	}

	#[test]
	fn provenance_growth_evicts_older_snapshots() {
		let store = EditStore::with_limits(10, 4, 4_096);
		let old = Path::new("old");
		let new = Path::new("new");
		store.record(old, &"x".repeat(2_000), None);
		let hash = store.record(new, "read", Some(&[1]));
		assert!(store.head(old).is_some());
		store.record_seen_lines(new, &hash, &(1..=500).rev().collect::<Vec<_>>());
		assert!(store.head(old).is_none());
		assert_eq!(store.head(new).unwrap().seen_lines.unwrap(), (1..=500).collect());
		for _ in 0..4 {
			store.record_seen_lines(new, &hash, &(1..=500).collect::<Vec<_>>());
		}
		assert_eq!(store.head(new).unwrap().seen_lines.unwrap(), (1..=500).collect());
	}

	#[test]
	fn snapshot_metadata_and_initial_provenance_use_the_budget() {
		let store = EditStore::with_limits(10, 4, 1);
		store.record(Path::new("empty"), "", None);
		assert!(store.head(Path::new("empty")).is_none());
		let store = EditStore::with_limits(10, 4, 4_096);
		let path = Path::new("read");
		store.record(path, "x", Some(&(1..=2_000).collect::<Vec<_>>()));
		assert!(store.head(path).is_none());
		let long_path = PathBuf::from("x".repeat(5_000));
		store.record(&long_path, "x", None);
		assert!(store.head(&long_path).is_none());
	}

	#[test]
	fn relocation_merges_and_rewrites_paths() {
		let store = EditStore::new();
		let shared = store.record(Path::new("from"), "same", Some(&[1]));
		store.record(Path::new("to"), "older", None);
		store.relocate(Path::new("from"), Path::new("to"));
		assert!(store.head(Path::new("from")).is_none());
		assert_eq!(store.by_hash(Path::new("to"), &shared).unwrap().path, Path::new("to"));
	}

	#[test]
	fn unicode_budget_survives_promotion_and_version_truncation() {
		let store = EditStore::with_limits(10, 2, 7_200);
		let a = Path::new("a");
		let b = Path::new("b");
		let emoji = "😀".repeat(500);
		let accented = "é".repeat(500);
		let replacement = "x".repeat(1_000);
		store.record(a, &emoji, None);
		store.record(a, &accented, None);
		store.record(b, &"abc".repeat(1_000), None);
		store.record(a, &emoji, None);
		store.record(a, &replacement, None);
		assert!(store.by_content(a, &accented).is_none());
		assert!(store.by_content(a, &emoji).is_some());
		assert!(store.head(b).is_some());
		store.record_seen_lines(a, &file_hash(&replacement), &[1]);
		store.record(Path::new("c"), &"c".repeat(1_000), None);
		assert!(store.head(b).is_none());
		assert_eq!(&*store.head(a).unwrap().text, replacement);
		assert!(store.head(Path::new("c")).is_some());
	}

	#[test]
	fn invalidation_and_eviction_release_their_budget() {
		let store = EditStore::with_limits(10, 2, 4_096);
		store.record(Path::new("old"), &"😀".repeat(600), None);
		store.record(Path::new("next"), &"é".repeat(1_200), None);
		assert!(store.head(Path::new("old")).is_none());
		store.record(Path::new("last"), &"x".repeat(1_000), None);
		assert!(store.head(Path::new("next")).is_some());
		assert!(store.head(Path::new("last")).is_some());
		store.invalidate(Path::new("next"));
		store.invalidate(Path::new("next"));
		store.record(Path::new("replacement"), &"😀".repeat(600), None);
		assert!(store.head(Path::new("last")).is_some());
		assert!(store.head(Path::new("replacement")).is_some());
	}

	#[test]
	fn relocation_releases_duplicate_and_truncated_versions() {
		let store = EditStore::with_limits(10, 2, 12_000);
		let from = Path::new("from");
		let to = Path::new("to");
		let emoji = "😀".repeat(500);
		let accented = "é".repeat(500);
		let truncated = "abc".repeat(1_000);
		store.record(from, &emoji, None);
		store.record(from, &accented, None);
		store.record(to, &emoji, None);
		store.record(to, &truncated, None);
		store.record(Path::new("other"), &"wxyz".repeat(500), None);
		store.relocate(from, to);
		store.relocate(to, to);
		store.relocate(Path::new("missing"), to);
		store.record(Path::new("filler"), &"12345".repeat(1_000), None);
		assert!(store.head(from).is_none());
		assert!(store.by_content(to, &truncated).is_none());
		assert_eq!(store.by_content(to, &emoji).unwrap().path, to);
		assert_eq!(&*store.head(to).unwrap().text, accented);
		assert!(store.head(Path::new("other")).is_some());
		assert!(store.head(Path::new("filler")).is_some());
	}

	#[test]
	fn zero_limits_reject_snapshots_and_clear_restores_default_limits() {
		for (max_paths, max_versions, max_bytes) in [(0, 2, 10), (10, 0, 1), (10, 2, 0)] {
			let store = EditStore::with_limits(max_paths, max_versions, max_bytes);
			store.record(Path::new("empty"), "", None);
			assert!(store.head(Path::new("empty")).is_none());
			store.relocate(Path::new("empty"), Path::new("moved"));
			store.clear();
			store.record(Path::new("after-clear"), "😀", None);
			assert_eq!(&*store.head(Path::new("after-clear")).unwrap().text, "😀");
		}
	}

	#[test]
	fn parses_seen_line_boundaries_only() {
		assert_eq!(seen_lines_from_body("1:x\n*20-30:{ … }\n nope\n 7:y"), vec![1, 20, 30, 7]);
	}

	#[test]
	fn clipboard_batch_fork_and_commit_preserve_named_only() {
		let store = EditStore::new();
		let initial = Clipboard {
			named: Some(HashMap::from([("a".into(), vec!["one".into()])])),
			lines: Some(vec!["anonymous".into()]),
			..Default::default()
		};
		store.commit_clipboard(&initial);
		let mut batch = store.start_clipboard_batch();
		assert!(batch.lines.is_none());
		let mut fork = batch.fork();
		fork
			.named
			.as_mut()
			.unwrap()
			.insert("b".into(), vec!["two".into()]);
		store.commit_clipboard(&fork);
		batch = store.start_clipboard_batch();
		assert_eq!(batch.named.unwrap().len(), 2);
	}

	#[test]
	fn noop_counter_resets_for_new_payload_and_commit() {
		let store = EditStore::new();
		let path = Path::new("a");
		let hash = payload_hash("edit");
		assert_eq!(store.record_noop(path, hash), (1, false));
		assert_eq!(store.record_noop(path, hash), (2, false));
		assert_eq!(store.record_noop(path, hash), (3, true));
		assert_eq!(store.record_noop(path, payload_hash("different")), (1, false));
		store.reset_noop(path);
		assert_eq!(store.record_noop(path, hash), (1, false));
	}

	#[test]
	fn oversized_file_is_not_read() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("large");
		let file = std::fs::File::create(&path).unwrap();
		file.set_len(MAX_SNAPSHOT_FILE_BYTES + 1).unwrap();
		assert!(EditStore::new().record_file(&path, None).is_none());
	}
}
