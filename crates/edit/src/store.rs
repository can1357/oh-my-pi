//! Session-scoped snapshots, clipboard registers, and no-op loop state.

use std::{
	collections::{BTreeSet, HashMap, VecDeque},
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
/// Global ceiling on retained snapshot allocations, measured in estimated
/// bytes. Hash-map buckets, allocator rounding, and caller-held snapshots are
/// outside this budget.
pub const DEFAULT_MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;
/// Files larger than this are never snapshotted from disk: they get a tag
/// (up to [`MAX_TAGGED_FILE_BYTES`]) but no retained text.
pub const MAX_SNAPSHOT_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// Files larger than this get no tag at all: hashing them on every read
/// costs more than anchored edits on them are worth.
pub const MAX_TAGGED_FILE_BYTES: u64 = 64 * 1024 * 1024;
/// Consecutive identical no-ops before the guard escalates.
pub const NOOP_HARD_LIMIT: u32 = 3;
/// Displayed-line ranges kept, across all evicted versions, so a version
/// recorded again after eviction regains what the session displayed of it.
const MAX_RETIRED_RANGES: usize = 64 * 1024;
/// Added plus removed lines past which a version change stops aligning the two
/// texts to carry seen lines (a formatter pass, a wholesale rewrite); only the
/// unchanged leading lines, and trailing ones when the line count holds, carry.
/// Bounds the diff to `O(lines × CARRY_MAX_EDITS)`.
const CARRY_MAX_EDITS: usize = 1024;

/// One full-file version observed at a point in time.
#[derive(Debug, Clone)]
pub struct Snapshot {
	/// Canonical path this version belongs to.
	pub path:           PathBuf,
	/// Full LF-normalized, BOM-stripped text.
	pub text:           Arc<str>,
	/// Four-character content tag.
	pub hash:           String,
	/// Lines displayed from this version, when provenance was recorded. Shared
	/// so lookups hand out snapshots without copying a set that holds one entry
	/// per displayed line.
	pub seen_lines:     Option<Arc<BTreeSet<u32>>>,
	/// Lines whose content an ancestor version displayed at a different number:
	/// an edit or outside change shifted them. The model saw the content but
	/// not these numbers, so they are not seen; the guard accepts an anchor on
	/// one only when the payload identifies the line. Held on the snapshot so
	/// it outlives the version cap. `None` when no line moved.
	pub moved_lines:    Option<Arc<BTreeSet<u32>>>,
	/// Lines ancestors displayed (or held as moved) that this text no longer
	/// contains: a stale payload may have been written from one. Every version
	/// change carried from a parent computes it; `None` when nothing vanished.
	pub vanished_lines: Option<Arc<VanishedLines>>,
}

/// Estimated bytes of vanished-line text one snapshot keeps; past it the set
/// overflows and stops naming its lines.
const VANISHED_LINES_MAX_BYTES: usize = 256 * 1024;

/// Distinct trimmed lines that ancestors of a version displayed and the
/// version no longer contains, accumulated across version changes.
#[derive(Debug, Clone, Default)]
pub struct VanishedLines {
	lines:      BTreeSet<Arc<str>>,
	/// Estimated bytes `lines` holds.
	bytes:      usize,
	/// Lines were dropped (past [`VANISHED_LINES_MAX_BYTES`], or an ancestry
	/// the store no longer holds): the set cannot rule a line out.
	overflowed: bool,
}

impl VanishedLines {
	/// Every vanished line, or `None` when some may be missing.
	pub fn lines(&self) -> Option<&BTreeSet<Arc<str>>> {
		(!self.overflowed).then_some(&self.lines)
	}

	/// Add one trimmed line, overflowing past the byte cap.
	pub(crate) fn insert(&mut self, line: &str) {
		if self.overflowed || line.is_empty() || self.lines.contains(line) {
			return;
		}
		let cost = line.len() + 4 * size_of::<usize>();
		if self.bytes + cost > VANISHED_LINES_MAX_BYTES {
			self.overflow();
			return;
		}
		self.bytes += cost;
		self.lines.insert(Arc::from(line));
	}

	fn overflow(&mut self) {
		self.overflowed = true;
		self.lines = BTreeSet::new();
		self.bytes = 0;
	}

	fn union(&mut self, other: &Self) {
		if other.overflowed {
			self.overflow();
		}
		for line in &other.lines {
			self.insert(line);
		}
	}

	const fn retained_bytes(&self) -> usize {
		2 * size_of::<usize>() + size_of::<Self>() + self.bytes
	}
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
		self.named.get_or_insert_default().extend(named.clone());
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

#[derive(Clone)]
struct StoredSnapshot {
	snapshot: Snapshot,
	/// Lines carried from the version this one replaced, held back while the
	/// version is unrestricted (no seen set, or an empty one): folding them in
	/// would restrict it. They join the seen set once it holds a line.
	carried:  Vec<u32>,
}

/// Estimated bytes of a shared line set.
fn line_set_bytes(lines: Option<&Arc<BTreeSet<u32>>>) -> usize {
	lines.map_or(0, |lines| {
		// BTreeSet does not expose its nodes. Half-full u32 leaves (56 B, 5 of
		// 11 keys) cost about 11 B per key and internal nodes at most 6 B
		// more, so 20 B per line is an upper bound; sorted inserts
		// pack nodes and overcount up to 4×, which only evicts
		// sooner.
		2 * size_of::<usize>()
			+ size_of::<BTreeSet<u32>>()
			+ lines.len() * (size_of::<u32>() + 2 * size_of::<usize>())
	})
}

impl StoredSnapshot {
	fn retained_bytes(&self) -> usize {
		let snapshot = &self.snapshot;
		let text_bytes =
			(snapshot.text.len() + 2 * size_of::<usize>()).next_multiple_of(size_of::<usize>());
		snapshot.path.capacity()
			+ snapshot.hash.capacity()
			+ text_bytes
			+ line_set_bytes(snapshot.seen_lines.as_ref())
			+ line_set_bytes(snapshot.moved_lines.as_ref())
			+ snapshot
				.vanished_lines
				.as_ref()
				.map_or(0, |vanished| vanished.retained_bytes())
			+ self.carried.capacity() * size_of::<u32>()
	}
}

#[derive(Clone)]
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

/// Provenance of an evicted version: what the session displayed of one exact
/// text, kept after its text is dropped. Recording that text again (a re-read
/// after eviction) restores the lines instead of starting from the new
/// display alone, which would narrow what earlier reads showed.
#[derive(Clone)]
struct RetiredProvenance {
	path:      PathBuf,
	/// 64-bit hash of the full text; the 16-bit tag is too weak to key on.
	text_hash: u64,
	/// Displayed lines as inclusive ranges.
	seen:      Vec<(u32, u32)>,
}

#[derive(Clone)]
struct StoreState {
	histories:       HashMap<PathBuf, PathHistory>,
	retired:         VecDeque<RetiredProvenance>,
	retired_ranges:  usize,
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
			retired:         VecDeque::new(),
			retired_ranges:  0,
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

	/// Construct a store with explicit limits.
	pub fn with_limits(max_paths: usize, max_versions: usize, max_total_bytes: usize) -> Self {
		let state = StoreState { max_paths, max_versions, max_total_bytes, ..StoreState::default() };
		Self { inner: Arc::new(Mutex::new(state)) }
	}

	/// Independent copy of the current state (snapshot texts are shared, not
	/// copied). A dry-run staging pass works against a fork: staging records
	/// reveals, reply provenance, and clipboard registers, and none of that may
	/// outlive a probe — a consumed unseen-lines reveal would let the real
	/// apply through.
	pub fn fork(&self) -> Self {
		Self { inner: Arc::new(Mutex::new(self.inner.lock().clone())) }
	}

	/// Record normalized text under a canonical path and return its tag.
	///
	/// Content that differs from the path's current version is a change made
	/// outside the edit tool (formatter, build step, another writer): the lines
	/// the current version displayed keep counting as displayed where they keep
	/// their number and content.
	pub fn record(&self, path: &Path, text: &str, seen_lines: Option<&[u32]>) -> String {
		self.record_version(path, text, seen_lines, None)
	}

	/// Record `after`, which an edit wrote over `before`, and return its tag.
	/// Lines displayed from `before` keep counting as displayed where they keep
	/// their number and content, and restrict the new version the edit's
	/// response rows then join. With no retained version of `before` (or an
	/// unrestricted one) the edit could anchor anywhere, so every such line
	/// carries.
	pub fn record_edit(&self, path: &Path, before: &str, after: &str) -> String {
		self.record_version(path, after, None, Some(before))
	}

	/// `parent` names the text `text` was derived from; `None` takes the
	/// path's current version.
	fn record_version(
		&self,
		path: &Path,
		text: &str,
		seen_lines: Option<&[u32]>,
		parent: Option<&str>,
	) -> String {
		let hash = file_hash(text);
		// Diffed outside the lock: the version change may span a large file.
		let Carry { seen: carried, moved, vanished } = self.carried_from_parent(path, text, parent);
		let mut state = self.inner.lock();
		state.clock = state.clock.wrapping_add(1);
		let touched = state.clock;
		let max_versions = state.max_versions;
		let restored = take_retired(&mut state, path, text);
		let mut previous_bytes = 0;
		let entry = state.histories.entry(path.to_owned());
		let path_bytes = entry.key().capacity();
		let history = entry
			.and_modify(|history| previous_bytes = history.retained_bytes(path_bytes))
			.or_insert_with(|| PathHistory { versions: Vec::new(), touched });
		history.touched = touched;
		let stored = if let Some(index) = history
			.versions
			.iter()
			.position(|version| version.snapshot.hash == hash && &*version.snapshot.text == text)
		{
			let snapshot = history.versions.remove(index);
			history.versions.insert(0, snapshot);
			history.versions.first_mut()
		} else if max_versions > 0 {
			history.versions.insert(0, StoredSnapshot {
				snapshot: Snapshot {
					path:           path.to_owned(),
					text:           Arc::from(text),
					hash:           hash.clone(),
					seen_lines:     None,
					moved_lines:    None,
					vanished_lines: None,
				},
				carried:  Vec::new(),
			});
			history.versions.truncate(max_versions);
			history.versions.first_mut()
		} else {
			None
		};
		if let Some(stored) = stored {
			merge_seen(stored, restored.as_deref());
			merge_seen(stored, seen_lines);
			if parent.is_some() && !carried.is_empty() {
				merge_seen(stored, Some(&carried));
			} else {
				carry_into(stored, carried);
			}
			merge_moved(stored, moved);
			merge_vanished(stored, vanished);
		}
		let current_bytes = history.retained_bytes(path_bytes);
		state.retained_bytes = state.retained_bytes - previous_bytes + current_bytes;
		evict(&mut state);
		hash
	}

	/// Lines of the parent version (`parent`, else the current version) that
	/// `text` keeps at the same number with the same content, filtered by what
	/// the parent displayed, plus the parent's displayed or moved lines `text`
	/// keeps at another number, and the lines the change left vanished.
	fn carried_from_parent(&self, path: &Path, text: &str, parent: Option<&str>) -> Carry {
		let (head, parent_seen, parent_moved, parent_vanished) = {
			let state = self.inner.lock();
			let versions = state
				.histories
				.get(path)
				.map_or(&[][..], |history| history.versions.as_slice());
			match parent {
				Some(before) => {
					let version = versions
						.iter()
						.find(|version| &*version.snapshot.text == before);
					(
						None,
						version.and_then(|version| version.snapshot.seen_lines.clone()),
						version.and_then(|version| version.snapshot.moved_lines.clone()),
						version.map(|version| version.snapshot.vanished_lines.clone()),
					)
				},
				None => match versions.first() {
					Some(version) => (
						Some(version.snapshot.text.clone()),
						version.snapshot.seen_lines.clone(),
						version.snapshot.moved_lines.clone(),
						Some(version.snapshot.vanished_lines.clone()),
					),
					None => return Carry::default(),
				},
			}
		};
		let Some(parent) = parent.or(head.as_deref()) else {
			return Carry::default();
		};
		if parent == text {
			return Carry::default();
		}
		let mut carry =
			carried_seen_lines(parent, text, parent_seen.as_deref(), parent_moved.as_deref());
		carry.vanished = Some(vanished_lines(
			parent,
			text,
			parent_seen.as_deref(),
			parent_moved.as_deref(),
			parent_vanished.is_some(),
			parent_vanished.flatten().as_deref(),
		));
		carry
	}

	/// Read, normalize, and record a file if it is readable and at most 4 MiB.
	///
	/// A larger file (up to [`MAX_TAGGED_FILE_BYTES`]) only gets its tag: no
	/// text or provenance is retained, so an edit under that tag applies while
	/// the live file still hashes to it, with no stale-tag recovery and no
	/// seen-line check beyond the display column cap.
	pub fn record_file(&self, absolute: &Path, seen_lines: Option<&[u32]>) -> Option<String> {
		let size = std::fs::metadata(absolute).ok()?.len();
		if size > MAX_TAGGED_FILE_BYTES {
			return None;
		}
		let raw = std::fs::read_to_string(absolute).ok()?;
		let (_, without_bom) = crate::text::strip_bom(&raw);
		let normalized = crate::text::normalize_to_lf(without_bom);
		if raw.len() as u64 > MAX_SNAPSHOT_FILE_BYTES {
			return Some(file_hash(&normalized));
		}
		let key = crate::path_policy::canonical_key(absolute);
		Some(self.record(&key, &normalized, seen_lines))
	}

	/// Union displayed lines into the most recent version matching a tag.
	pub fn record_seen_lines(&self, path: &Path, hash: &str, lines: &[u32]) {
		let mut state = self.inner.lock();
		touch(&mut state, path);
		if let Some(version) = state
			.histories
			.get_mut(path)
			.and_then(|h| h.versions.iter_mut().find(|v| v.snapshot.hash == hash))
		{
			let previous_bytes = version.retained_bytes();
			merge_seen(version, Some(lines));
			let current_bytes = version.retained_bytes();
			state.retained_bytes = state.retained_bytes - previous_bytes + current_bytes;
			evict(&mut state);
		}
	}

	/// Return the current version and refresh path recency.
	pub fn head(&self, path: &Path) -> Option<Snapshot> {
		let mut state = self.inner.lock();
		touch(&mut state, path);
		state
			.histories
			.get(path)?
			.versions
			.first()
			.map(|v| v.snapshot.clone())
	}

	/// Return the current version's tag and refresh path recency.
	pub fn head_hash(&self, path: &Path) -> Option<String> {
		let mut state = self.inner.lock();
		touch(&mut state, path);
		state
			.histories
			.get(path)?
			.versions
			.first()
			.map(|v| v.snapshot.hash.clone())
	}

	/// Every retained snapshot for a path, newest first.
	#[cfg(test)]
	pub fn versions(&self, path: &Path) -> Vec<Snapshot> {
		let mut state = self.inner.lock();
		touch(&mut state, path);
		state.histories.get(path).map_or_default(|history| {
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
		state
			.histories
			.get(path)?
			.versions
			.iter()
			.find(|v| v.snapshot.hash == hash)
			.map(|v| v.snapshot.clone())
	}

	/// Whether a version matching a tag is retained; refreshes path recency
	/// like [`Self::by_hash`].
	pub fn has_hash(&self, path: &Path, hash: &str) -> bool {
		let mut state = self.inner.lock();
		touch(&mut state, path);
		state
			.histories
			.get(path)
			.is_some_and(|history| history.versions.iter().any(|v| v.snapshot.hash == hash))
	}

	/// Return the version with exactly equal text and refresh path recency.
	pub fn by_content(&self, path: &Path, text: &str) -> Option<Snapshot> {
		let mut state = self.inner.lock();
		touch(&mut state, path);
		state
			.histories
			.get(path)?
			.versions
			.iter()
			.find(|v| &*v.snapshot.text == text)
			.map(|v| v.snapshot.clone())
	}

	/// Path of every retained version matching a tag (one entry per version).
	pub fn paths_with_hash(&self, hash: &str) -> Vec<PathBuf> {
		let state = self.inner.lock();
		state
			.histories
			.values()
			.flat_map(|h| h.versions.iter())
			.filter(|v| v.snapshot.hash == hash)
			.map(|v| v.snapshot.path.clone())
			.collect()
	}

	/// Remove one path's history.
	pub fn invalidate(&self, path: &Path) {
		let mut state = self.inner.lock();
		if let Some((path, history)) = state.histories.remove_entry(path) {
			state.retained_bytes -= history.retained_bytes(path.capacity());
		}
		let mut dropped = 0;
		state.retired.retain(|retired| {
			let keep = retired.path != path;
			if !keep {
				dropped += retired.seen.len();
			}
			keep
		});
		state.retired_ranges -= dropped;
	}

	/// Move source history and provenance to a destination path.
	pub fn relocate(&self, from: &Path, to: &Path) {
		let mut state = self.inner.lock();
		state.clock = state.clock.wrapping_add(1);
		let touched = state.clock;
		let max_versions = state.max_versions;
		let Some((source_path, mut source)) = state.histories.remove_entry(from) else {
			return;
		};
		state.retained_bytes -= source.retained_bytes(source_path.capacity());
		for version in &mut source.versions {
			to.clone_into(&mut version.snapshot.path);
		}
		let mut merged = source.versions;
		if let Some((destination_path, destination)) = state.histories.remove_entry(to) {
			state.retained_bytes -= destination.retained_bytes(destination_path.capacity());
			merged.extend(destination.versions);
		}
		let mut hashes = BTreeSet::new();
		merged.retain(|version| hashes.insert(version.snapshot.hash.clone()));
		merged.truncate(max_versions);
		// `extend` can leave room for both histories; keep only the slots a path
		// may use.
		merged.shrink_to(max_versions);
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

/// Union displayed lines into a version; held-back carried lines join once the
/// set restricts anchors.
///
/// An empty set is authored content (a `write`): the model knows every line,
/// so a later partial display of the same content must not narrow it to the
/// rows that display showed.
fn merge_seen(stored: &mut StoredSnapshot, lines: Option<&[u32]>) {
	let Some(lines) = lines else { return };
	if stored
		.snapshot
		.seen_lines
		.as_ref()
		.is_some_and(|seen| seen.is_empty())
	{
		return;
	}
	// Copies the set only while a lookup still holds the previous version.
	let seen = Arc::make_mut(stored.snapshot.seen_lines.get_or_insert_default());
	seen.extend(lines.iter().copied());
	if !seen.is_empty() {
		seen.extend(std::mem::take(&mut stored.carried));
	}
}

/// Union lines an ancestor displayed at another number into a version.
fn merge_moved(stored: &mut StoredSnapshot, moved: Vec<u32>) {
	if moved.is_empty() {
		return;
	}
	// Copies the set only while a lookup still holds the previous version.
	Arc::make_mut(stored.snapshot.moved_lines.get_or_insert_default()).extend(moved);
}

/// Union lines a change left vanished into a version.
fn merge_vanished(stored: &mut StoredSnapshot, vanished: Option<VanishedLines>) {
	let Some(vanished) =
		vanished.filter(|vanished| vanished.overflowed || !vanished.lines.is_empty())
	else {
		return;
	};
	match stored.snapshot.vanished_lines.as_mut() {
		Some(existing) => Arc::make_mut(existing).union(&vanished),
		None => stored.snapshot.vanished_lines = Some(Arc::new(vanished)),
	}
}

/// Credit a version with lines carried from the version it replaced: into a
/// restricted seen set directly, held back on a version with no provenance
/// yet, dropped on authored content (an empty set), which stays unrestricted.
fn carry_into(stored: &mut StoredSnapshot, carried: Vec<u32>) {
	if carried.is_empty() {
		return;
	}
	match stored.snapshot.seen_lines.as_mut() {
		Some(seen) if !seen.is_empty() => Arc::make_mut(seen).extend(carried),
		Some(_) => {},
		None => {
			stored.carried.extend(carried);
			stored.carried.sort_unstable();
			stored.carried.dedup();
		},
	}
}

/// What a version change carries from the parent version.
#[derive(Default)]
struct Carry {
	/// Child lines the parent displayed at the same number with the same
	/// content.
	seen:     Vec<u32>,
	/// Child lines whose content the parent displayed, or itself held as moved,
	/// at another number — or holds as moved at this number.
	moved:    Vec<u32>,
	/// Lines the child no longer holds that an ancestor displayed; `None` when
	/// nothing was carried.
	vanished: Option<VanishedLines>,
}

/// Lines `child` no longer holds that the parent, or an ancestor before it,
/// displayed: the parent's vanished lines plus its displayed or moved lines
/// (every line, when unrestricted), minus every line `child` holds.
/// A parent version the store no longer retains has unknown ancestry: the
/// result overflows.
fn vanished_lines(
	parent: &str,
	child: &str,
	seen: Option<&BTreeSet<u32>>,
	moved: Option<&BTreeSet<u32>>,
	parent_retained: bool,
	parent_vanished: Option<&VanishedLines>,
) -> VanishedLines {
	let mut vanished = VanishedLines::default();
	if !parent_retained {
		vanished.overflow();
		return vanished;
	}
	let present: std::collections::HashSet<&str> = child.split('\n').map(str::trim).collect();
	if let Some(parent_vanished) = parent_vanished {
		if parent_vanished.overflowed {
			vanished.overflow();
			return vanished;
		}
		for line in &parent_vanished.lines {
			if !present.contains(&**line) {
				vanished.insert(line);
			}
		}
	}
	let seen = seen.filter(|seen| !seen.is_empty());
	for (line, content) in (1_u32..).zip(parent.split('\n')) {
		let displayed = seen.is_none_or(|seen| seen.contains(&line))
			|| moved.is_some_and(|moved| moved.contains(&line));
		let content = content.trim();
		if displayed && !present.contains(content) {
			vanished.insert(content);
		}
	}
	vanished
}

/// Parent lines that keep both their number and content in `child`: every
/// unchanged run the change did not shift (the leading run, plus runs below
/// line-neutral hunks), filtered by `seen`. A missing or empty `seen` is an
/// unrestricted parent, whose every such line carries. Shifted lines never
/// carry: their old numbers name other content. They land in `moved` at their
/// new numbers instead, when the parent displayed them or already held them
/// as moved; `moved` lines in unshifted runs stay moved.
fn carried_seen_lines(
	parent: &str,
	child: &str,
	seen: Option<&BTreeSet<u32>>,
	moved: Option<&BTreeSet<u32>>,
) -> Carry {
	let seen = seen.filter(|seen| !seen.is_empty());
	let old_lines: Vec<&str> = parent.split('\n').collect();
	let new_lines: Vec<&str> = child.split('\n').collect();
	let (old_ids, new_ids) = omp_diff::intern(&old_lines, &new_lines);
	// Unchanged runs as (old range, new start).
	let mut runs_kept = Vec::new();
	if let Some(runs) = omp_diff::myers_diff_within(&old_ids, &new_ids, CARRY_MAX_EDITS) {
		let (mut old_line, mut new_line) = (1_u32, 1_u32);
		for run in runs {
			if run.added {
				new_line += run.count;
			} else if run.removed {
				old_line += run.count;
			} else {
				runs_kept.push((old_line..old_line + run.count, new_line));
				old_line += run.count;
				new_line += run.count;
			}
		}
	} else {
		let prefix = old_ids
			.iter()
			.zip(&new_ids)
			.take_while(|(old, new)| old == new)
			.count() as u32;
		runs_kept.push((1..prefix + 1, 1));
		let (old_len, new_len) = (old_ids.len() as u32, new_ids.len() as u32);
		let suffix = (old_ids
			.iter()
			.rev()
			.zip(new_ids.iter().rev())
			.take_while(|(old, new)| old == new)
			.count() as u32)
			.min(old_len.min(new_len) - prefix);
		runs_kept.push((old_len - suffix + 1..old_len + 1, new_len - suffix + 1));
	}
	let mut carry = Carry::default();
	for (range, new_start) in runs_kept {
		if range.start == new_start {
			match seen {
				Some(seen) => carry.seen.extend(seen.range(range.clone())),
				None => carry.seen.extend(range.clone()),
			}
			if let Some(moved) = moved {
				carry.moved.extend(moved.range(range));
			}
			continue;
		}
		let old_start = range.start;
		let to_new = move |line: u32| line - old_start + new_start;
		match seen {
			Some(seen) => {
				carry
					.moved
					.extend(seen.range(range.clone()).map(|&line| to_new(line)));
				if let Some(moved) = moved {
					carry
						.moved
						.extend(moved.range(range).map(|&line| to_new(line)));
				}
			},
			None => carry.moved.extend(range.map(to_new)),
		}
	}
	carry
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
			retire(state, &path, &history);
		}
	}
}

/// Keep what the session displayed of each version of an evicted history.
fn retire(state: &mut StoreState, path: &Path, history: &PathHistory) {
	for version in &history.versions {
		let Some(seen) = version
			.snapshot
			.seen_lines
			.as_ref()
			.filter(|seen| !seen.is_empty())
		else {
			continue;
		};
		let mut ranges: Vec<(u32, u32)> = Vec::new();
		for &line in seen.iter() {
			match ranges.last_mut() {
				Some((_, end)) if *end + 1 == line => *end = line,
				_ => ranges.push((line, line)),
			}
		}
		if ranges.len() > MAX_RETIRED_RANGES {
			continue;
		}
		state.retired_ranges += ranges.len();
		state.retired.push_back(RetiredProvenance {
			path:      path.to_owned(),
			text_hash: xxh64(version.snapshot.text.as_bytes(), 0),
			seen:      ranges,
		});
	}
	while state.retired_ranges > MAX_RETIRED_RANGES {
		let Some(oldest) = state.retired.pop_front() else {
			break;
		};
		state.retired_ranges -= oldest.seen.len();
	}
}

/// Displayed lines an evicted version of exactly `text` at `path` kept, taken
/// out of the retired list.
fn take_retired(state: &mut StoreState, path: &Path, text: &str) -> Option<Vec<u32>> {
	if !state.retired.iter().any(|retired| retired.path == path) {
		return None;
	}
	let text_hash = xxh64(text.as_bytes(), 0);
	let index = state
		.retired
		.iter()
		.position(|retired| retired.path == path && retired.text_hash == text_hash)?;
	let retired = state.retired.remove(index)?;
	state.retired_ranges -= retired.seen.len();
	Some(
		retired
			.seen
			.into_iter()
			.flat_map(|(start, end)| start..=end)
			.collect(),
	)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn moved(store: &EditStore, path: &Path) -> BTreeSet<u32> {
		store
			.head(path)
			.unwrap()
			.moved_lines
			.map_or_else(BTreeSet::new, |moved| (*moved).clone())
	}

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
		assert_eq!(*head.seen_lines.unwrap(), BTreeSet::from([1, 3]));
	}

	fn lines(count: u32, edit: impl Fn(u32) -> Option<String>) -> String {
		(1..=count)
			.map(|n| edit(n).unwrap_or_else(|| format!("line {n}")))
			.collect::<Vec<_>>()
			.join("\n")
	}

	#[test]
	fn outside_change_carries_only_unshifted_unchanged_seen_lines() {
		let path = Path::new("f.txt");
		let partial_read: Vec<u32> = (47..=55).collect();
		let read_after = |changed: String| {
			let store = EditStore::new();
			store.record(path, &lines(60, |_| None), Some(&(1..=60).collect::<Vec<_>>()));
			store.record(path, &changed, Some(&partial_read));
			store.head(path).unwrap().seen_lines.unwrap()
		};

		let line_50 = read_after(lines(60, |n| (n == 50).then(|| "line FIFTY".into())));
		assert!(line_50.contains(&5) && line_50.contains(&60), "unchanged lines keep their numbers");

		let shifted = read_after(format!("new top\n{}", lines(60, |_| None)));
		assert!(!shifted.contains(&5), "an insertion above shifts line 5");
		assert!(shifted.contains(&50), "the partial read itself still counts");

		let rewritten = read_after(lines(60, |n| (n == 5).then(|| "line FIVE".into())));
		assert!(!rewritten.contains(&5), "a changed line carries nothing");
	}

	#[test]
	fn version_without_provenance_holds_carried_lines_until_it_is_restricted() {
		let store = EditStore::new();
		let path = Path::new("f.txt");
		store.record(path, &lines(10, |_| None), Some(&[5]));
		let changed = lines(10, |n| (n == 9).then(|| "line NINE".into()));
		let tag = store.record(path, &changed, None);
		assert!(
			store.head(path).unwrap().seen_lines.is_none(),
			"carrying must not restrict a version before it is displayed"
		);
		store.record_seen_lines(path, &tag, &[9]);
		assert_eq!(*store.head(path).unwrap().seen_lines.unwrap(), BTreeSet::from([5, 9]));
	}

	#[test]
	fn rereading_an_evicted_version_restores_what_earlier_reads_displayed() {
		let store = EditStore::with_limits(1, 4, DEFAULT_MAX_TOTAL_BYTES);
		let path = Path::new("read.txt");
		let text = lines(100, |_| None);
		store.record(path, &text, Some(&(1..=60).collect::<Vec<_>>()));
		store.record(Path::new("other.txt"), "other", Some(&[1]));
		assert!(store.head(path).is_none(), "the one-path limit evicts read.txt");
		store.record(path, &text, Some(&[90]));
		let seen = store.head(path).unwrap().seen_lines.unwrap();
		assert!(seen.contains(&1) && seen.contains(&60) && seen.contains(&90));
		assert!(!seen.contains(&61));

		let changed = lines(100, |n| (n == 5).then(|| "line FIVE".into()));
		store.record(Path::new("other.txt"), "other", Some(&[1]));
		store.record(path, &changed, Some(&[90]));
		assert_eq!(
			*store.head(path).unwrap().seen_lines.unwrap(),
			BTreeSet::from([90]),
			"other content regains nothing"
		);
	}

	#[test]
	fn authored_version_stays_unrestricted_after_a_partial_display() {
		let store = EditStore::new();
		let path = Path::new("f.txt");
		store.record(path, &lines(10, |_| None), Some(&[5]));
		let written = lines(10, |n| (n == 9).then(|| "line NINE".into()));
		let tag = store.record(path, &written, Some(&[]));
		store.record_seen_lines(path, &tag, &[2, 3]);
		store.record(path, &written, Some(&[4]));
		assert!(store.head(path).unwrap().seen_lines.unwrap().is_empty());
	}

	#[test]
	fn rewrite_past_the_diff_bound_carries_only_the_unchanged_head_and_tail() {
		let store = EditStore::new();
		let path = Path::new("f.txt");
		let count = 3 * CARRY_MAX_EDITS as u32;
		store.record(path, &lines(count, |_| None), Some(&(1..=count).collect::<Vec<_>>()));
		let rewritten =
			lines(count, |n| (n > 100 && n <= count - 100 && n % 2 == 0).then(|| format!("{n}!")));
		store.record(path, &rewritten, Some(&[0]));
		let seen = store.head(path).unwrap().seen_lines.unwrap();
		let expected: BTreeSet<u32> = (0..=101).chain(count - 99..=count).collect();
		assert_eq!(*seen, expected);
	}

	#[test]
	fn shifted_seen_lines_move_to_new_numbers_and_chain_across_edits() {
		let store = EditStore::new();
		let path = Path::new("f.txt");
		let read = lines(30, |_| None);
		store.record(path, &read, Some(&(1..=30).collect::<Vec<_>>()));
		let mut first: Vec<String> = read.split('\n').map(str::to_owned).collect();
		first.splice(5..5, ["ins a".to_owned(), "ins b".to_owned()]);
		let first = first.join("\n");
		store.record_edit(path, &read, &first);
		let head = store.head(path).unwrap();
		assert_eq!(*head.seen_lines.unwrap(), (1..=5).collect::<BTreeSet<_>>());
		assert_eq!(moved(&store, path), (8..=32).collect::<BTreeSet<_>>());

		let second = first.replacen("line 1\n", "line 1\nins c\n", 1);
		store.record_edit(path, &first, &second);
		let seen = store.head(path).unwrap().seen_lines.unwrap();
		assert_eq!(*seen, BTreeSet::from([1]), "shifted lines never join the seen set");
		let expected: BTreeSet<u32> = (3..=6).chain(9..=33).collect();
		assert_eq!(moved(&store, path), expected, "moved lines shift again and the seen ones join");
	}

	#[test]
	fn moved_lines_survive_eviction_of_the_displaying_version() {
		let store = EditStore::new();
		let path = Path::new("f.txt");
		let read = lines(30, |_| None);
		store.record(path, &read, Some(&(1..=30).collect::<Vec<_>>()));
		let mut text = read.clone();
		for edit in 1..=5 {
			let next = text.replacen("line 1\n", &format!("line 1\nnew {edit}\n"), 1);
			store.record_edit(path, &text, &next);
			text = next;
		}
		let versions = store.versions(path);
		assert_eq!(versions.len(), DEFAULT_MAX_VERSIONS_PER_PATH);
		assert!(versions.iter().all(|version| *version.text != *read), "the read is evicted");
		// Old line 2 sits at 7 and old line 30 at 35 after five insertions.
		let moved = moved(&store, path);
		assert!(moved.contains(&7) && moved.contains(&35), "{moved:?}");
		assert!(!moved.contains(&2), "inserted lines were never displayed");
	}

	/// `None` when overflowed; empty when nothing vanished.
	fn vanished(store: &EditStore, path: &Path) -> Option<Vec<String>> {
		let snapshot = store.head(path).unwrap();
		let Some(vanished) = snapshot.vanished_lines else {
			return Some(Vec::new());
		};
		let lines = vanished.lines()?;
		Some(lines.iter().map(|line| line.to_string()).collect())
	}

	/// Retained bytes of a vanished set holding lines of these lengths.
	fn vanished_bytes(lines: &[usize]) -> usize {
		2 * size_of::<usize>()
			+ size_of::<VanishedLines>()
			+ lines
				.iter()
				.map(|len| len + 4 * size_of::<usize>())
				.sum::<usize>()
	}

	#[test]
	fn vanished_lines_chain_across_edits_and_eviction() {
		let store = EditStore::new();
		let path = Path::new("f.txt");
		let read = lines(30, |_| None);
		store.record(path, &read, Some(&(1..=20).collect::<Vec<_>>()));
		assert_eq!(vanished(&store, path), Some(vec![]), "a first read carries nothing");
		// Line 10 was displayed, line 25 was not.
		let first = lines(30, |n| match n {
			10 => Some("line TEN".into()),
			25 => Some("line 25!".into()),
			_ => None,
		});
		store.record_edit(path, &read, &first);
		assert_eq!(vanished(&store, path), Some(vec!["line 10".to_owned()]));
		let mut text = first;
		for edit in 1..=5 {
			let next = text.replacen("line 1\n", &format!("line 1\nnew {edit}\n"), 1);
			store.record_edit(path, &text, &next);
			text = next;
		}
		assert!(store.by_content(path, &read).is_none(), "the read is evicted");
		assert_eq!(vanished(&store, path), Some(vec!["line 10".to_owned()]));
		// A line that comes back is no longer vanished; `line TEN` was never
		// displayed, so its removal adds nothing.
		let restored = text.replacen("line TEN", "line 10", 1);
		store.record_edit(path, &text, &restored);
		assert_eq!(vanished(&store, path), Some(vec![]));
	}

	#[test]
	fn vanished_lines_overflow_past_the_cap_or_an_unknown_parent() {
		let store = EditStore::new();
		let path = Path::new("f.txt");
		let wide = |n: u32| format!("{n:0>300}");
		let count = (VANISHED_LINES_MAX_BYTES / 300 + 10) as u32;
		let read = lines(count, |n| Some(wide(n)));
		store.record(path, &read, Some(&(1..=count).collect::<Vec<_>>()));
		store.record_edit(path, &read, "rewritten");
		assert_eq!(vanished(&store, path), None, "past the cap");
		store.record_edit(path, "rewritten", "rewritten again");
		assert_eq!(vanished(&store, path), None, "overflow chains");

		let store = EditStore::new();
		store.record_edit(path, "never recorded", "after");
		assert_eq!(vanished(&store, path), None, "unknown ancestry");
	}

	#[test]
	fn rewrite_past_the_diff_bound_moves_a_shifted_tail() {
		let store = EditStore::new();
		let path = Path::new("f.txt");
		let count = 3 * CARRY_MAX_EDITS as u32;
		store.record(path, &lines(count, |_| None), Some(&(1..=count).collect::<Vec<_>>()));
		let rewritten =
			lines(count, |n| (n > 100 && n <= count - 100 && n % 2 == 0).then(|| format!("{n}!")));
		let rewritten = rewritten.replacen("line 100\n", "line 100\nextra\n", 1);
		store.record(path, &rewritten, Some(&[0]));
		let seen = store.head(path).unwrap().seen_lines.unwrap();
		assert_eq!(*seen, (0..=100).collect::<BTreeSet<_>>());
		assert_eq!(moved(&store, path), (count - 98..=count + 1).collect::<BTreeSet<_>>());
	}

	#[test]
	fn snapshot_lookups_share_seen_line_provenance() {
		let store = EditStore::new();
		let path = Path::new("source.rs");
		let text = "source";
		let hash = store.record(path, text, Some(&(1..=5_000).collect::<Vec<_>>()));
		let head = store.head(path).unwrap();
		let seen = head.seen_lines.as_ref().unwrap();
		let by_hash = store.by_hash(path, &hash).unwrap();
		let by_content = store.by_content(path, text).unwrap();
		let versions = store.versions(path);
		for snapshot in [&by_hash, &by_content, &versions[0]] {
			assert!(Arc::ptr_eq(seen, snapshot.seen_lines.as_ref().unwrap()));
		}
	}

	#[test]
	fn provenance_growth_evicts_older_history_without_discarding_current() {
		// 64-bit: 8_004 text + 124 metadata + 8 slots; 299 lines add 5_980 B.
		let store = EditStore::with_limits(10, 4, 8_128 + 8 * size_of::<StoredSnapshot>());
		let old = Path::new("old");
		let current = Path::new("current");
		store.record(old, &"x".repeat(8_000), None);
		let hash = store.record(current, "read", Some(&[1]));
		let held = store.head(current).unwrap();
		assert!(store.head(old).is_some());
		store.record_seen_lines(current, &hash, &(2..=300).collect::<Vec<_>>());
		assert!(store.head(old).is_none());
		assert_eq!(store.head(current).unwrap().seen_lines.unwrap().len(), 300);
		assert_eq!(held.seen_lines.unwrap().len(), 1);
		for _ in 0..4 {
			store.record_seen_lines(current, &hash, &(2..=300).collect::<Vec<_>>());
		}
		assert_eq!(store.head(current).unwrap().seen_lines.unwrap().len(), 300);
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
		let store = EditStore::with_limits(10, 4, 4_096);
		store.record(Path::new("ascii"), &"a".repeat(2_000), None);
		assert!(store.head(Path::new("ascii")).is_some());
		store.record(Path::new("cjk"), &"文".repeat(2_000), None);
		assert!(store.head(Path::new("cjk")).is_none());
		store.record(Path::new("emoji"), &"😀".repeat(1_100), None);
		assert!(store.head(Path::new("emoji")).is_none());
	}

	#[test]
	fn snapshot_metadata_and_initial_provenance_use_the_budget() {
		let store = EditStore::with_limits(10, 4, 2);
		store.record(Path::new("empty"), "", None);
		assert!(store.head(Path::new("empty")).is_none());

		let store = EditStore::with_limits(10, 4, 4_096);
		let path = Path::new("read");
		store.record(path, "x", Some(&(1..=300).collect::<Vec<_>>()));
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
		// 64-bit: a + b = 6_000 text + 125 metadata + 8 slots, plus a's vanished
		// lines (the replacement lost the 2_000 B emoji and 1_000 B accented
		// lines, the promoted emoji version the accented one); c adds 1_310 B.
		let vanished = vanished_bytes(&[2_000, 1_000]) + vanished_bytes(&[1_000]);
		let store = EditStore::with_limits(10, 2, 6_125 + 8 * size_of::<StoredSnapshot>() + vanished);
		let a = Path::new("a");
		let b = Path::new("b");
		let emoji = "😀".repeat(500);
		let accented = "é".repeat(500);
		let replacement = "x".repeat(1_000);
		store.record(a, &emoji, None);
		store.record(a, &accented, None);
		store.record(b, &"abc".repeat(1_000), None);
		store.record(a, &emoji, None); // Promotion does not add a version.
		store.record(a, &replacement, None);
		assert!(store.by_content(a, &accented).is_none());
		assert!(store.by_content(a, &emoji).is_some());
		assert!(store.head(b).is_some());
		store.record_seen_lines(a, &file_hash(&replacement), &[1]);
		assert!(store.head(b).is_some());
		assert!(store.head(a).is_some());
		store.record(Path::new("c"), &"c".repeat(1_000), None);
		assert!(store.head(b).is_none());
		assert_eq!(&*store.head(a).unwrap().text, replacement);
		assert!(store.head(Path::new("c")).is_some());
	}

	#[test]
	fn invalidation_and_eviction_release_their_budget() {
		// 64-bit: next + last = 3_400 text + 120 metadata + 8 slots.
		let store = EditStore::with_limits(10, 2, 3_520 + 8 * size_of::<StoredSnapshot>());
		store.record(Path::new("old"), &"😀".repeat(600), None);
		store.record(Path::new("next"), &"é".repeat(1_200), None);
		assert!(store.head(Path::new("old")).is_none());
		store.record(Path::new("last"), &"x".repeat(1_000), None);
		assert!(store.head(Path::new("next")).is_some());
		assert!(store.head(Path::new("last")).is_some());
		store.invalidate(Path::new("next"));
		store.invalidate(Path::new("next")); // An absent history releases nothing.
		store.record(Path::new("replacement"), &"😀".repeat(600), None);
		assert!(store.head(Path::new("last")).is_some());
		assert!(store.head(Path::new("replacement")).is_some());
	}

	#[test]
	fn relocation_releases_duplicate_and_truncated_versions() {
		// 64-bit: initially 8_632 data + 12 slots, 504 B less two slots under the
		// limit. Relocation leaves `to` two slots, so after the filler
		// 9_112 data + 10 slots sit 24 B under it. Both counts include the
		// accented version's vanished emoji line; `to`'s emoji version displays
		// no line, so `abc` loses none and only adds that one-line seen set,
		// which relocation drops with the duplicate.
		let vanished = vanished_bytes(&[2_000]);
		let store =
			EditStore::with_limits(10, 2, 9_136 + 10 * size_of::<StoredSnapshot>() + vanished);
		let from = Path::new("from");
		let to = Path::new("to");
		let emoji = "😀".repeat(500);
		let accented = "é".repeat(500);
		store.record(from, &emoji, None);
		store.record(from, &accented, None);
		store.record(to, &emoji, Some(&[2]));
		store.record(to, &"abc".repeat(500), None);
		store.record(Path::new("other"), &"wxyz".repeat(500), None);
		store.relocate(from, to);
		store.relocate(to, to); // Self-relocation preserves the budget.
		store.relocate(Path::new("missing"), to);
		store.record(Path::new("filler"), &"1234".repeat(1_000), None);
		assert!(store.head(from).is_none());
		assert!(store.by_content(to, &"abc".repeat(500)).is_none());
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
	fn oversized_file_is_tagged_without_a_snapshot() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("large.txt");
		let text = "row\n".repeat(MAX_SNAPSHOT_FILE_BYTES as usize / 4 + 1);
		std::fs::write(&path, &text).unwrap();
		let store = EditStore::new();
		assert_eq!(store.record_file(&path, Some(&[1])), Some(file_hash(&text)));
		assert!(
			store
				.head(&crate::path_policy::canonical_key(&path))
				.is_none()
		);
	}

	#[test]
	fn file_past_the_tag_limit_is_not_read() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("large");
		let file = std::fs::File::create(&path).unwrap();
		file.set_len(MAX_TAGGED_FILE_BYTES + 1).unwrap();
		assert!(EditStore::new().record_file(&path, None).is_none());
	}
}
