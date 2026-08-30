//! Shared walker scan cache used by owned-entry collection.

#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};
use std::{
	borrow::Cow,
	collections::HashMap,
	fmt,
	path::{Path, PathBuf},
	sync::{Arc, LazyLock},
	time::{Duration, Instant},
};

use dashmap::DashMap;
use parking_lot::{Condvar, Mutex};
use rayon::{ThreadPool, prelude::*};

use crate::{CollectedEntries, CollectedEntry, FileType, WalkError, WalkOptions};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct CacheKey {
	root:    PathBuf,
	options: WalkOptions,
}

#[derive(Clone)]
struct CacheEntry {
	created_at: Instant,
	entries:    Vec<CollectedEntry>,
}

static CACHE_TTL_MS: LazyLock<u64> =
	LazyLock::new(|| env_uint("FS_SCAN_CACHE_TTL_MS", 1_000, 0, u64::MAX));
static EMPTY_RECHECK_MS: LazyLock<u64> =
	LazyLock::new(|| env_uint("FS_SCAN_EMPTY_RECHECK_MS", 200, 0, u64::MAX));
static MAX_CACHE_ENTRIES: LazyLock<usize> =
	LazyLock::new(|| env_uint("FS_SCAN_CACHE_MAX_ENTRIES", 16, 0, usize::MAX));
const DEFAULT_WALK_WORKERS: usize = 4;

static WALK_WORKERS: LazyLock<usize> = LazyLock::new(|| {
	normalize_worker_count(env_uint("PI_WALK_WORKERS", DEFAULT_WALK_WORKERS, 0, usize::MAX))
});
static WALK_POOL: LazyLock<Option<ThreadPool>> = LazyLock::new(|| {
	let workers = walk_workers();
	if workers <= 1 {
		return None;
	}
	rayon::ThreadPoolBuilder::new()
		.num_threads(workers)
		.thread_name(|index| format!("pi-walker-{index}"))
		.build()
		.ok()
});
static SCAN_CACHE: LazyLock<DashMap<CacheKey, CacheEntry>> = LazyLock::new(DashMap::new);

/// Per-root count of underlying walks; single-flight regression tests only.
#[cfg(test)]
static TEST_WALK_COUNTS: LazyLock<Mutex<HashMap<PathBuf, usize>>> =
	LazyLock::new(|| Mutex::new(HashMap::new()));

#[cfg(test)]
fn record_test_walk(root: &Path) {
	*TEST_WALK_COUNTS
		.lock()
		.entry(root.to_path_buf())
		.or_default() += 1;
}

#[cfg(not(test))]
const fn record_test_walk(_root: &Path) {}

/// Test-only one-shot pause gates for deterministic concurrency regressions:
/// a test arms `(point, root, gate)`, and the next caller reaching that
/// point in [`get_or_scan`] for that root parks until the test opens it.
#[cfg(test)]
static TEST_PAUSE: LazyLock<Mutex<Option<PauseArm>>> = LazyLock::new(|| Mutex::new(None));

/// Shared gate flag plus its condvar for [`TEST_PAUSE`].
#[cfg(test)]
type PauseGate = Arc<(Mutex<bool>, Condvar)>;

/// An armed pause gate: its [`get_or_scan`] point, scoped root, and gate.
#[cfg(test)]
type PauseArm = (&'static str, PathBuf, PauseGate);

/// How many callers have entered an armed [`TEST_PAUSE`] gate.
#[cfg(test)]
static TEST_PAUSE_ARRIVALS: AtomicU64 = AtomicU64::new(0);

/// Park this caller if a test armed a pause gate for `point` on `root`;
/// consumed once.
#[cfg(test)]
fn test_pause(point: &'static str, root: &Path) {
	let Some((armed, expected_root, gate)) = TEST_PAUSE.lock().take() else {
		return;
	};
	if armed != point || expected_root != root {
		*TEST_PAUSE.lock() = Some((armed, expected_root, gate));
		return;
	}
	TEST_PAUSE_ARRIVALS.fetch_add(1, Ordering::Relaxed);
	let (flag, arrived) = &*gate;
	let mut open = flag.lock();
	while !*open {
		arrived.wait(&mut open);
	}
}
/// In-flight directory scans keyed like [`SCAN_CACHE`]; at most one walk runs
/// per key at any time.
static IN_FLIGHT_SCANS: LazyLock<Mutex<HashMap<CacheKey, Arc<ScanFlight>>>> =
	LazyLock::new(|| Mutex::new(HashMap::new()));

/// Outcome a finished flight leaves for its followers.
enum FlightOutcome {
	/// The leader completed; followers reuse this shared result verbatim.
	Shared(Result<CollectedEntries, WalkError<String>>),
	/// The leader failed on its own heartbeat (user cancel, per-call
	/// timeout); followers rerun the walk themselves instead of inheriting
	/// an error that never belonged to them.
	Rerun,
}

/// How a follower's wait on a leader ended.
enum FollowerOutcome {
	/// Reuse the leader-published result.
	Shared(Result<CollectedEntries, WalkError<String>>),
	/// The leader failed; run this caller's own scan.
	Rerun,
	/// This follower's own heartbeat fired while blocked.
	Interrupted(WalkError<String>),
}

/// How often a blocked follower polls its own heartbeat while waiting.
const FOLLOWER_HEARTBEAT_POLL: Duration = Duration::from_millis(50);

/// Shared state of one in-flight directory scan.
struct ScanFlight {
	done:    Condvar,
	/// `None` while the leader is walking, then the shared flight outcome.
	outcome: Mutex<Option<FlightOutcome>>,
}

impl ScanFlight {
	const fn new() -> Self {
		Self { done: Condvar::new(), outcome: Mutex::new(None) }
	}

	/// Publish the leader's outcome and wake every follower.
	fn finish(&self, outcome: FlightOutcome) {
		*self.outcome.lock() = Some(outcome);
		self.done.notify_all();
	}

	/// Block until the leader publishes, polling this caller's heartbeat so
	/// a follower bails out with its own cancellation or timeout rather
	/// than waiting out the leader's entire walk.
	fn wait_for_leader<H, E>(&self, heartbeat: &H) -> FollowerOutcome
	where
		H: Fn() -> std::result::Result<(), E>,
		E: fmt::Display,
	{
		let mut guard = self.outcome.lock();
		loop {
			if let Some(outcome) = guard.as_ref() {
				return match outcome {
					FlightOutcome::Shared(result) => FollowerOutcome::Shared(result.clone()),
					FlightOutcome::Rerun => FollowerOutcome::Rerun,
				};
			}
			drop(guard);
			if let Err(err) = heartbeat() {
				return FollowerOutcome::Interrupted(WalkError::Interrupted(err.to_string()));
			}
			guard = self.outcome.lock();
			if guard.is_some() {
				// The leader published while we ran the heartbeat without
				// holding the lock; don't sleep out a full poll interval.
				continue;
			}
			self.done.wait_for(&mut guard, FOLLOWER_HEARTBEAT_POLL);
		}
	}
}

/// Join the flight for `key`, starting one if no scan is running yet. Returns
/// the shared flight plus whether this caller became its leader.
fn join_or_start_scan(key: &CacheKey) -> (Arc<ScanFlight>, bool) {
	let mut flights = IN_FLIGHT_SCANS.lock();
	if let Some(flight) = flights.get(key).cloned() {
		return (flight, false);
	}
	let flight = Arc::new(ScanFlight::new());
	flights.insert(key.clone(), flight.clone());
	(flight, true)
}

/// Deregisters a leader's flight when it finishes or unwinds. A leader that
/// panics before publishing wakes its followers with an error instead of
/// leaving them blocked forever.
struct ScanLeader {
	key:    CacheKey,
	flight: Arc<ScanFlight>,
}

impl Drop for ScanLeader {
	fn drop(&mut self) {
		if IN_FLIGHT_SCANS.lock().remove(&self.key).is_some() {
			let mut guard = self.flight.outcome.lock();
			if guard.is_none() {
				*guard = Some(FlightOutcome::Shared(Err(WalkError::Interrupted(
					"concurrent directory scan aborted".to_string(),
				))));
				self.flight.done.notify_all();
			}
		}
	}
}

fn env_uint<T>(name: &str, default: T, min: T, max: T) -> T
where
	T: Copy + Ord + std::str::FromStr,
{
	std::env::var(name)
		.ok()
		.and_then(|value| value.parse().ok())
		.unwrap_or(default)
		.clamp(min, max)
}

fn normalize_worker_count_with_available(configured: usize, available: usize) -> usize {
	if configured == 0 {
		available.max(1)
	} else {
		configured.max(1)
	}
}

fn available_worker_count() -> usize {
	std::thread::available_parallelism().map_or(DEFAULT_WALK_WORKERS, usize::from)
}

fn normalize_worker_count(configured: usize) -> usize {
	normalize_worker_count_with_available(configured, available_worker_count())
}

/// Configured cache TTL in milliseconds.
pub fn cache_ttl_ms() -> u64 {
	*CACHE_TTL_MS
}

/// Configured empty-result recheck threshold in milliseconds.
pub fn empty_recheck_ms() -> u64 {
	*EMPTY_RECHECK_MS
}

/// Configured maximum number of cache entries.
pub fn max_cache_entries() -> usize {
	*MAX_CACHE_ENTRIES
}

/// Effective worker count for filesystem traversal and related parallel work.
///
/// `PI_WALK_WORKERS=0` means auto-detect; `PI_WALK_WORKERS=1` forces serial
/// work.
pub fn walk_workers() -> usize {
	*WALK_WORKERS
}

/// Run parallel traversal-adjacent work on the centralized walker pool.
pub fn with_walk_pool<R>(operation: impl FnOnce() -> R + Send) -> R
where
	R: Send,
{
	if let Some(pool) = WALK_POOL.as_ref() {
		pool.install(operation)
	} else {
		operation()
	}
}

const PARALLEL_MIN_FILES: usize = 256;

/// Return whether traversal-adjacent work should run in parallel.
pub fn should_parallelize(item_count: usize) -> bool {
	walk_workers() > 1 && item_count >= PARALLEL_MIN_FILES
}

/// Run traversal-adjacent work serially or on the centralized walker pool.
pub fn parallel_for_each<T, E>(
	items: &[T],
	operation: impl Fn(&T) -> std::result::Result<(), E> + Send + Sync,
) -> std::result::Result<(), E>
where
	T: Sync,
	E: Send,
{
	if !should_parallelize(items.len()) {
		return items.iter().try_for_each(operation);
	}
	with_walk_pool(|| items.par_iter().try_for_each(operation))
}

/// Run traversal-adjacent work with per-worker state on the centralized walker
/// pool.
pub fn parallel_for_each_init<T, S, E>(
	items: &[T],
	init: impl Fn() -> S + Send + Sync,
	operation: impl Fn(&mut S, &T) -> std::result::Result<(), E> + Send + Sync,
) -> std::result::Result<(), E>
where
	T: Sync,
	S: Send,
	E: Send,
{
	if !should_parallelize(items.len()) {
		let mut state = init();
		return items
			.iter()
			.try_for_each(|item| operation(&mut state, item));
	}
	with_walk_pool(|| items.par_iter().try_for_each_init(init, operation))
}

fn evict_oldest() {
	if SCAN_CACHE.len() > *MAX_CACHE_ENTRIES
		&& let Some(oldest_key) = SCAN_CACHE
			.iter()
			.min_by_key(|entry| entry.value().created_at)
			.map(|entry| entry.key().clone())
	{
		SCAN_CACHE.remove(&oldest_key);
	}
}

fn cache_key(root: &Path, mut options: WalkOptions) -> CacheKey {
	options.cache = false;
	CacheKey { root: root.to_path_buf(), options }
}

/// Normalize a filesystem path to a forward-slash relative string.
pub fn normalize_relative_path<'a>(root: &Path, path: &'a Path) -> Cow<'a, str> {
	let relative = path.strip_prefix(root).unwrap_or(path);
	if cfg!(windows) {
		let relative = relative.to_string_lossy();
		if relative.contains('\\') {
			Cow::Owned(relative.replace('\\', "/"))
		} else {
			relative
		}
	} else {
		relative.to_string_lossy()
	}
}

/// Return whether a path contains the exact component name.
pub fn contains_component(path: &Path, target: &str) -> bool {
	path.components().any(|component| {
		component
			.as_os_str()
			.to_str()
			.is_some_and(|value| value == target)
	})
}

/// Return whether user-facing discovery should skip a relative path.
pub fn should_skip_path(path: &Path, mentions_node_modules: bool) -> bool {
	if contains_component(path, ".git") {
		return true;
	}
	if !mentions_node_modules && contains_component(path, "node_modules") {
		return true;
	}
	false
}

fn file_type_from_std(file_type: std::fs::FileType) -> Option<FileType> {
	if file_type.is_symlink() {
		Some(FileType::Symlink)
	} else if file_type.is_dir() {
		Some(FileType::Dir)
	} else if file_type.is_file() {
		Some(FileType::File)
	} else {
		None
	}
}

fn mtime_ms(metadata: &std::fs::Metadata) -> Option<f64> {
	metadata
		.modified()
		.ok()
		.and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
		.map(|duration| duration.as_millis() as f64)
}

/// Classify an existing filesystem path, skipping unsupported special files.
pub fn classify_file_type(path: &Path) -> Option<(FileType, Option<f64>, Option<u64>)> {
	let metadata = std::fs::symlink_metadata(path).ok()?;
	let file_type = file_type_from_std(metadata.file_type())?;
	let size = if file_type == FileType::File {
		Some(metadata.len())
	} else {
		None
	};
	Some((file_type, mtime_ms(&metadata), size))
}

/// Resolve a search path string to a canonical directory path.
pub fn resolve_search_path(path: &str) -> Result<PathBuf, WalkError<String>> {
	let candidate = PathBuf::from(path);
	let root = if candidate.is_absolute() {
		candidate
	} else {
		let cwd = std::env::current_dir().map_err(|err| WalkError::InvalidData {
			path:    PathBuf::from(path),
			message: format!("Failed to resolve cwd: {err}"),
		})?;
		cwd.join(candidate)
	};
	let metadata = std::fs::metadata(&root).map_err(|err| WalkError::InvalidData {
		path:    root.clone(),
		message: format!("Path not found: {err}"),
	})?;
	if !metadata.is_dir() {
		return Err(WalkError::InvalidData {
			path:    root,
			message: "Search path must be a directory".to_string(),
		});
	}
	Ok(std::fs::canonicalize(&root).unwrap_or(root))
}

fn collect_entries_uncached<H, E>(
	root: &Path,
	mut options: WalkOptions,
	heartbeat: &H,
) -> Result<CollectedEntries, WalkError<String>>
where
	H: Fn() -> std::result::Result<(), E> + Sync,
	E: fmt::Display,
{
	options.cache = false;
	record_test_walk(root);
	crate::collect_entries_native(root, options, || heartbeat().map_err(|err| err.to_string()))
}

fn get_or_scan<H, E>(
	root: &Path,
	options: WalkOptions,
	heartbeat: &H,
) -> Result<CollectedEntries, WalkError<String>>
where
	H: Fn() -> std::result::Result<(), E> + Sync,
	E: fmt::Display,
{
	let ttl = *CACHE_TTL_MS;
	if ttl == 0 {
		return collect_entries_uncached(root, options, heartbeat);
	}

	let key = cache_key(root, options);
	loop {
		if let Some(entry) = SCAN_CACHE.get(&key) {
			let age = Instant::now().duration_since(entry.created_at);
			if age < Duration::from_millis(ttl) {
				return Ok(CollectedEntries {
					entries:      entry.entries.clone(),
					cache_age_ms: age.as_millis() as u64,
				});
			}
			// The expired entry is deliberately left in place until a fresh
			// scan replaces it: concurrent callers serve it
			// stale-while-revalidate below, consistent with TTL semantics
			// where data up to one TTL old is acceptable. A failed
			// revalidation likewise keeps serving the stale snapshot instead
			// of leaving later callers uncached.
			drop(entry);
		}

		#[cfg(test)]
		test_pause("before-join", root);

		let (flight, is_leader) = join_or_start_scan(&key);

		if !is_leader {
			// Another thread owns this scan. Serve whatever the cache holds —
			// possibly stale — rather than duplicating the walk; only callers
			// with no cached snapshot block on the shared flight.
			if let Some(entry) = SCAN_CACHE.get(&key) {
				let age = Instant::now().duration_since(entry.created_at);
				return Ok(CollectedEntries {
					entries:      entry.entries.clone(),
					cache_age_ms: age.as_millis() as u64,
				});
			}
			return match flight.wait_for_leader(heartbeat) {
				FollowerOutcome::Shared(result) => result,
				FollowerOutcome::Interrupted(err) => Err(err),
				// The leader died on its own heartbeat. Re-enter coordinated
				// acquisition instead of walking unguarded, so concurrent
				// rerunners still share one flight and one cached result.
				FollowerOutcome::Rerun => continue,
			};
		}

		// This caller owns the scan. Register the leader guard before the
		// recheck below so an early return still deregisters the flight via
		// [`ScanLeader`].
		let _leader = ScanLeader { key: key.clone(), flight: flight.clone() };

		#[cfg(test)]
		test_pause("before-walk", root);

		// Close the miss-to-leadership race: another caller may have finished
		// the whole scan between our stale check above and acquiring
		// leadership here. Serve that fresh snapshot instead of walking over
		// it, and hand it to any follower already blocked on this flight.
		if let Some(entry) = SCAN_CACHE.get(&key) {
			let age = Instant::now().duration_since(entry.created_at);
			if age < Duration::from_millis(ttl) {
				let cached = CollectedEntries {
					entries:      entry.entries.clone(),
					cache_age_ms: age.as_millis() as u64,
				};
				flight.finish(FlightOutcome::Shared(Ok(cached.clone())));
				return Ok(cached);
			}
		}

		// Leader: walk outside all locks, then refresh the cache and publish.
		// Order matters: the cache entry MUST be inserted before `finish` wakes
		// followers. A woken follower can mutate the filesystem and call
		// `invalidate_path` before we insert, and an insert after that would
		// resurrect entries the invalidation just removed.
		match collect_entries_uncached(root, options, heartbeat) {
			Ok(entries) => {
				SCAN_CACHE.insert(key, CacheEntry {
					created_at: Instant::now(),
					entries:    entries.entries.clone(),
				});
				evict_oldest();
				flight.finish(FlightOutcome::Shared(Ok(entries.clone())));
				return Ok(CollectedEntries { entries: entries.entries, cache_age_ms: 0 });
			},
			Err(err @ WalkError::InvalidData { .. }) => {
				// Scan-wide failure independent of any caller's heartbeat;
				// every follower would hit it too. Share it once instead of
				// sending each of them into a duplicate walk.
				flight.finish(FlightOutcome::Shared(Err(err.clone())));
				return Err(err);
			},
			Err(err) => {
				// Never share this failure: it comes from the leader's own
				// heartbeat (user cancel, per-call timeout), which unrelated
				// followers must not inherit. Wake them to rerun the walk with
				// their own heartbeats instead.
				flight.finish(FlightOutcome::Rerun);
				return Err(err);
			},
		}
	}
}

pub fn collect_entries<H, E>(
	root: &Path,
	options: WalkOptions,
	heartbeat: H,
) -> Result<CollectedEntries, WalkError<String>>
where
	H: Fn() -> std::result::Result<(), E> + Sync,
	E: fmt::Display,
{
	if options.cache {
		get_or_scan(root, options, &heartbeat)
	} else {
		collect_entries_uncached(root, options, &heartbeat)
	}
}

/// Invalidate cache entries whose root contains `target`.
pub fn invalidate_path(target: &Path) {
	let keys_to_remove: Vec<CacheKey> = SCAN_CACHE
		.iter()
		.filter(|entry| target.starts_with(&entry.key().root))
		.map(|entry| entry.key().clone())
		.collect();
	for key in keys_to_remove {
		SCAN_CACHE.remove(&key);
	}
}

/// Resolve a possibly relative path and invalidate matching cache roots.
pub fn invalidate_path_string(path: &str) {
	let candidate = PathBuf::from(path);
	let absolute = if candidate.is_absolute() {
		candidate
	} else if let Ok(cwd) = std::env::current_dir() {
		cwd.join(candidate)
	} else {
		PathBuf::from(path)
	};
	let target = std::fs::canonicalize(&absolute)
		.or_else(|_| {
			absolute
				.parent()
				.and_then(|parent| std::fs::canonicalize(parent).ok())
				.and_then(|parent| absolute.file_name().map(|name| parent.join(name)))
				.ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound))
		})
		.unwrap_or(absolute);
	invalidate_path(&target);
}

/// Clear the entire scan cache.
pub fn invalidate_all() {
	SCAN_CACHE.clear();
}

#[cfg(test)]
mod tests {
	#[cfg(unix)]
	use std::{ffi::CString, os::unix::ffi::OsStrExt};
	use std::{
		fs,
		path::{Path, PathBuf},
		sync::{
			Arc,
			atomic::{AtomicU64, Ordering},
		},
		time::{Duration, Instant, SystemTime, UNIX_EPOCH},
	};

	#[cfg(unix)]
	use super::classify_file_type;
	use crate::{CollectedEntry, FileType, WalkError};

	static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

	struct TempDirGuard(PathBuf);

	impl TempDirGuard {
		fn new() -> Self {
			let timestamp = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system time is after UNIX_EPOCH")
				.as_nanos();
			let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
			let path = std::env::temp_dir().join(format!("pi-fs-cache-test-{timestamp}-{counter}"));
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

	#[cfg(unix)]
	fn make_fifo(path: &Path) {
		let fifo_path =
			CString::new(path.as_os_str().as_bytes()).expect("fifo path has no NUL bytes");
		// SAFETY: `fifo_path` is a valid CString (NUL-terminated, no interior NULs),
		// so `as_ptr()` yields a valid C string pointer. `0o600` is a valid mode.
		// The CString is alive for the duration of the call.
		let rc = unsafe { libc::mkfifo(fifo_path.as_ptr(), 0o600) };
		assert_eq!(rc, 0, "create fifo: {}", std::io::Error::last_os_error());
	}

	#[allow(
		clippy::unnecessary_wraps,
		reason = "test heartbeat helper matches production callback signature"
	)]
	fn ok_heartbeat() -> std::result::Result<(), String> {
		Ok(())
	}

	#[test]
	fn worker_count_zero_uses_available_parallelism() {
		assert_eq!(super::normalize_worker_count_with_available(0, 8), 8);
		assert_eq!(super::normalize_worker_count_with_available(0, 0), 1);
		assert_eq!(super::normalize_worker_count_with_available(1, 8), 1);
		assert_eq!(super::normalize_worker_count_with_available(4, 8), 4);
	}

	fn scan_options(
		include_hidden: bool,
		use_gitignore: bool,
		detail: crate::WalkDetail,
	) -> crate::WalkOptions {
		crate::WalkOptions {
			include_hidden,
			use_gitignore,
			skip_git: true,
			skip_node_modules: true,
			follow_links: crate::FollowLinks::Never,
			detail,
			directory_errors: crate::DirectoryErrorMode::SkipSkippable,
			..crate::WalkOptions::default()
		}
	}

	fn assert_file_entry(entries: &[CollectedEntry], path: &str, size: f64) {
		let entry = entries
			.iter()
			.find(|entry| entry.path == path)
			.unwrap_or_else(|| panic!("expected file entry {path}, got {}", entry_paths(entries)));
		assert_eq!(entry.file_type, FileType::File);
		assert!(entry.mtime.is_some(), "full scan should include mtime for {path}");
		assert_eq!(entry.size, Some(size));
	}

	fn assert_dir_entry(entries: &[CollectedEntry], path: &str) {
		let entry = entries
			.iter()
			.find(|entry| entry.path == path)
			.unwrap_or_else(|| panic!("expected dir entry {path}, got {}", entry_paths(entries)));
		assert_eq!(entry.file_type, FileType::Dir);
		assert!(entry.mtime.is_some(), "full scan should include mtime for {path}");
		assert_eq!(entry.size, None);
	}

	fn entry_paths(entries: &[CollectedEntry]) -> String {
		let paths: Vec<&str> = entries.iter().map(|entry| entry.path.as_str()).collect();
		format!("{paths:?}")
	}

	#[cfg(unix)]
	#[test]
	fn classify_file_type_skips_fifo() {
		let root = TempDirGuard::new();
		let fifo = root.path().join("skip-me.fifo");
		make_fifo(&fifo);

		assert_eq!(classify_file_type(&fifo), None);
	}

	#[test]
	fn collect_entries_skips_node_modules() {
		let root = TempDirGuard::new();
		fs::create_dir_all(root.path().join("node_modules/pkg")).unwrap();
		fs::write(root.path().join("node_modules/pkg/index.js"), "nm").unwrap();
		fs::write(root.path().join("real.txt"), "ok").unwrap();

		let entries = super::collect_entries(
			root.path(),
			scan_options(true, false, crate::WalkDetail::Full),
			ok_heartbeat,
		)
		.unwrap();
		let entries = entries.entries;
		let paths: Vec<&str> = entries.iter().map(|entry| entry.path.as_str()).collect();
		assert!(
			!paths.iter().any(|path| path.contains("node_modules")),
			"expected no node_modules entries, got: {paths:?}"
		);
		assert!(paths.iter().any(|path| path == &"real.txt"), "expected real.txt, got: {paths:?}");
	}

	#[cfg(unix)]
	#[test]
	fn collect_entries_follow_links_always() {
		let root = TempDirGuard::new();
		fs::create_dir_all(root.path().join("target")).unwrap();
		fs::write(root.path().join("target/linked.txt"), "linked").unwrap();
		std::os::unix::fs::symlink(root.path().join("target"), root.path().join("link")).unwrap();

		let mut options = scan_options(true, false, crate::WalkDetail::Minimal);
		options.follow_links = crate::FollowLinks::Always;

		let entries = super::collect_entries(root.path(), options, ok_heartbeat).unwrap();
		let paths: Vec<&str> = entries
			.entries
			.iter()
			.map(|entry| entry.path.as_str())
			.collect();
		assert!(
			paths.iter().any(|path| path == &"link/linked.txt"),
			"follow-links always should yield symlink descendants, got: {paths:?}"
		);
	}

	#[test]
	fn traversal_gitignore_excludes_files() {
		let root = TempDirGuard::new();
		fs::create_dir_all(root.path().join(".git")).unwrap();
		fs::write(root.path().join(".gitignore"), "ignored.txt\n").unwrap();
		fs::write(root.path().join("ignored.txt"), "ignored").unwrap();
		fs::write(root.path().join("kept.txt"), "keep").unwrap();

		let collected = super::collect_entries(
			root.path(),
			scan_options(true, true, crate::WalkDetail::Full),
			ok_heartbeat,
		)
		.unwrap();
		let collected = collected.entries;
		assert!(
			!collected.iter().any(|entry| entry.path == "ignored.txt"),
			"collect_entries returned gitignored file: {}",
			entry_paths(&collected)
		);
		assert_file_entry(&collected, "kept.txt", 4.0);
	}

	#[test]
	fn traversal_hidden_disabled_excludes_files_and_descendants() {
		let root = TempDirGuard::new();
		fs::create_dir_all(root.path().join(".hidden-dir")).unwrap();
		fs::write(root.path().join(".hidden-dir/child.txt"), "child").unwrap();
		fs::write(root.path().join(".hidden-file"), "secret").unwrap();
		fs::write(root.path().join("visible.txt"), "visible").unwrap();

		let entries = super::collect_entries(
			root.path(),
			scan_options(false, false, crate::WalkDetail::Full),
			ok_heartbeat,
		)
		.unwrap();
		let entries = entries.entries;
		assert_eq!(
			entries.len(),
			1,
			"only visible.txt should be returned when hidden entries are disabled, got {}",
			entry_paths(&entries)
		);
		assert_file_entry(&entries, "visible.txt", 7.0);
		assert!(
			!entries
				.iter()
				.any(|entry| entry.path.starts_with(".hidden")),
			"hidden entries should be pruned before yielding files or descendants, got {}",
			entry_paths(&entries)
		);
	}

	#[test]
	fn traversal_hidden_enabled_includes_non_ignored_hidden_entries() {
		let root = TempDirGuard::new();
		fs::create_dir_all(root.path().join(".git")).unwrap();
		fs::write(root.path().join(".gitignore"), ".ignored-hidden\n").unwrap();
		fs::create_dir_all(root.path().join(".hidden-dir")).unwrap();
		fs::write(root.path().join(".hidden-dir/child.txt"), "child").unwrap();
		fs::write(root.path().join(".hidden-file"), "secret").unwrap();
		fs::write(root.path().join(".ignored-hidden"), "ignored").unwrap();

		let entries = super::collect_entries(
			root.path(),
			scan_options(true, true, crate::WalkDetail::Full),
			ok_heartbeat,
		)
		.unwrap();
		let entries = entries.entries;
		assert_file_entry(&entries, ".hidden-file", 6.0);
		assert_dir_entry(&entries, ".hidden-dir");
		assert_file_entry(&entries, ".hidden-dir/child.txt", 5.0);
		assert!(
			!entries.iter().any(|entry| entry.path == ".ignored-hidden"),
			"gitignore should still exclude matching hidden files, got {}",
			entry_paths(&entries)
		);
	}

	#[test]
	fn collect_entries_respects_pre_cancelled_token() {
		let root = TempDirGuard::new();
		fs::write(root.path().join("real.txt"), "ok").unwrap();

		std::thread::sleep(Duration::from_millis(1));
		let result = super::collect_entries(
			root.path(),
			scan_options(true, false, crate::WalkDetail::Minimal),
			|| Err("Timeout".to_string()),
		);

		let Err(err) = result else {
			panic!("pre-cancelled scans should fail before returning entries");
		};
		assert!(
			err.to_string().contains("Timeout"),
			"expected timeout cancellation error, got: {err}"
		);
	}

	#[test]
	fn scan_detail_controls_metadata_collection() {
		let root = TempDirGuard::new();
		fs::write(root.path().join("real.txt"), "ok").unwrap();

		let minimal = super::collect_entries(
			root.path(),
			scan_options(true, false, crate::WalkDetail::Minimal),
			ok_heartbeat,
		)
		.unwrap();
		let minimal_file = minimal
			.entries
			.iter()
			.find(|entry| entry.path == "real.txt")
			.expect("minimal scan includes file");
		assert_eq!(minimal_file.mtime, None);
		assert_eq!(minimal_file.size, None);

		let full = super::collect_entries(
			root.path(),
			scan_options(true, false, crate::WalkDetail::Full),
			ok_heartbeat,
		)
		.unwrap();
		let full_file = full
			.entries
			.iter()
			.find(|entry| entry.path == "real.txt")
			.expect("full scan includes file");
		assert!(full_file.mtime.is_some(), "full scan should include mtime");
		assert_eq!(full_file.size, Some(2.0));
	}

	#[test]
	fn sixteen_threads_racing_cold_root_execute_one_walk() {
		use std::sync::Barrier;

		let dir = TempDirGuard::new();
		for index in 0..64 {
			fs::write(dir.path().join(format!("file-{index}.txt")), "payload").unwrap();
		}

		let mut options = scan_options(true, true, crate::WalkDetail::Full);
		options.cache = true;
		let barrier = Arc::new(Barrier::new(16));
		let handles: Vec<_> = (0..16)
			.map(|_| {
				let barrier = barrier.clone();
				let root = dir.path().to_path_buf();
				std::thread::spawn(move || {
					barrier.wait();
					super::collect_entries(&root, options, ok_heartbeat)
						.expect("racing scan should succeed")
						.entries
						.len()
				})
			})
			.collect();
		for handle in handles {
			assert_eq!(handle.join().unwrap(), 64, "every racing caller sees the full scan");
		}

		let walks = super::TEST_WALK_COUNTS
			.lock()
			.get(dir.path())
			.copied()
			.unwrap_or(0);
		assert_eq!(walks, 1, "16 racing cold-start callers must trigger exactly one walk");
	}

	/// Blocks a scan's first heartbeat call until `send` fires, then fails
	/// every subsequent call.
	fn gated_heartbeat(
		gate: Arc<std::sync::Mutex<Option<std::sync::mpsc::Receiver<()>>>>,
		reason: &'static str,
	) -> impl Fn() -> std::result::Result<(), String> + Send + 'static {
		move || {
			let mut slot = gate.lock().expect("gate lock");
			match slot.take() {
				Some(receiver) => {
					let _ = receiver.recv();
					drop(slot);
					Err(reason.to_string())
				},
				None => Err(reason.to_string()),
			}
		}
	}

	fn cold_scan_options() -> crate::WalkOptions {
		let mut options = scan_options(true, true, crate::WalkDetail::Full);
		options.cache = true;
		options
	}

	/// Opens an armed [`super::TEST_PAUSE`] gate on drop, even on panic.
	struct PauseDisarm(Arc<(super::Mutex<bool>, super::Condvar)>);

	impl Drop for PauseDisarm {
		fn drop(&mut self) {
			let (flag, arrived) = &*self.0;
			*flag.lock() = true;
			arrived.notify_all();
		}
	}

	fn arm_pause(point: &'static str, root: &Path) -> PauseDisarm {
		let gate = Arc::new((super::Mutex::new(false), super::Condvar::new()));
		*super::TEST_PAUSE.lock() = Some((point, root.to_path_buf(), gate.clone()));
		PauseDisarm(gate)
	}

	/// Blocks the first heartbeat call until `release` fires, then succeeds.
	/// Lets a test park a leader mid-walk and let it finish cleanly after.
	fn staged_heartbeat(
		release: std::sync::mpsc::Receiver<()>,
	) -> impl Fn() -> std::result::Result<(), String> + Send + 'static {
		let armed = Arc::new(super::Mutex::new(Some(release)));
		move || {
			let staged = armed.lock().take();
			if let Some(receiver) = staged {
				let _ = receiver.recv();
			}
			Ok(())
		}
	}

	fn wait_for_flight(key: &super::CacheKey) -> Arc<super::ScanFlight> {
		for _ in 0..400 {
			let registered = super::IN_FLIGHT_SCANS.lock().get(key).cloned();
			if let Some(flight) = registered {
				return flight;
			}
			std::thread::sleep(Duration::from_millis(5));
		}
		panic!("leader never registered its flight");
	}

	#[test]
	fn leader_heartbeat_failure_does_not_fail_concurrent_follower() {
		use std::sync::mpsc;

		let dir = TempDirGuard::new();
		for index in 0..8 {
			fs::write(dir.path().join(format!("file-{index}.txt")), "payload").unwrap();
		}

		let options = cold_scan_options();
		let key = super::cache_key(dir.path(), options);
		let (gate_tx, gate_rx) = mpsc::channel::<()>();
		let gate = Arc::new(std::sync::Mutex::new(Some(gate_rx)));
		let leader_root = dir.path().to_path_buf();
		let leader_options = cold_scan_options();
		let leader_handle = std::thread::spawn(move || {
			super::collect_entries(
				&leader_root,
				leader_options,
				gated_heartbeat(gate, "leader cancelled"),
			)
		});
		wait_for_flight(&key);

		// The follower joins the live flight; its first heartbeat poll
		// proves it is blocked in wait_for_leader.
		let follower_polls = Arc::new(AtomicU64::new(0));
		let poll_counter = follower_polls.clone();
		let follower_root = dir.path().to_path_buf();
		let follower_options = cold_scan_options();
		let follower_handle = std::thread::spawn(move || {
			let heartbeat = move || -> std::result::Result<(), String> {
				poll_counter.fetch_add(1, Ordering::Relaxed);
				Ok(())
			};
			super::collect_entries(&follower_root, follower_options, heartbeat)
		});
		for _ in 0..400 {
			if follower_polls.load(Ordering::Relaxed) > 0 {
				break;
			}
			std::thread::sleep(Duration::from_millis(5));
		}
		assert!(follower_polls.load(Ordering::Relaxed) > 0, "follower never joined the flight");

		gate_tx.send(()).expect("release leader");
		let leader_err = leader_handle
			.join()
			.unwrap()
			.expect_err("leader should surface its own cancel");
		assert!(
			leader_err.to_string().contains("leader cancelled"),
			"expected the leader's own cancellation, got: {leader_err}"
		);

		let follower_entries = follower_handle.join().unwrap().unwrap_or_else(|err| {
			panic!("follower must not inherit the leader's cancellation, got: {err}")
		});
		assert_eq!(
			follower_entries.entries.len(),
			8,
			"follower should complete its own scan with all entries"
		);

		let walks = super::TEST_WALK_COUNTS
			.lock()
			.get(dir.path())
			.copied()
			.unwrap_or(0);
		assert_eq!(walks, 2, "cancelled leader plus follower rerun must total two walks");
	}

	#[test]
	fn follower_enforces_own_heartbeat_while_blocked_on_leader() {
		use std::sync::mpsc;

		let dir = TempDirGuard::new();
		for index in 0..8 {
			fs::write(dir.path().join(format!("file-{index}.txt")), "payload").unwrap();
		}

		let options = cold_scan_options();
		let key = super::cache_key(dir.path(), options);

		let (gate_tx, gate_rx) = mpsc::channel::<()>();
		let gate = Arc::new(std::sync::Mutex::new(Some(gate_rx)));
		let leader_root = dir.path().to_path_buf();
		let leader_options = cold_scan_options();
		let leader_handle = std::thread::spawn(move || {
			super::collect_entries(
				&leader_root,
				leader_options,
				gated_heartbeat(gate, "leader cancelled"),
			)
		});
		wait_for_flight(&key);

		// Allow a couple of wait-loop polls, then fire this caller's own
		// timeout while the leader stays parked.
		let poll_counter = Arc::new(AtomicU64::new(0));
		let follower_root = dir.path().to_path_buf();
		let follower_options = cold_scan_options();
		let (result_tx, result_rx) = mpsc::channel();
		std::thread::spawn(move || {
			let heartbeat = move || -> std::result::Result<(), String> {
				if poll_counter.fetch_add(1, Ordering::Relaxed) >= 2 {
					return Err("follower timed out".to_string());
				}
				Ok(())
			};
			let _ =
				result_tx.send(super::collect_entries(&follower_root, follower_options, heartbeat));
		});

		let result = result_rx
			.recv_timeout(Duration::from_secs(10))
			.expect("blocked follower ignored its own heartbeat and waited out the leader");
		let err = result.expect_err("follower's own heartbeat fired; scan must fail");
		assert!(
			err.to_string().contains("follower timed out"),
			"expected the follower's own timeout, got: {err}"
		);

		gate_tx.send(()).expect("release leader");
		assert!(leader_handle.join().unwrap().is_err(), "released leader should still fail");

		let walks = super::TEST_WALK_COUNTS
			.lock()
			.get(dir.path())
			.copied()
			.unwrap_or(0);
		assert_eq!(walks, 1, "the follower bailed before running any walk of its own");
	}

	/// Regression (A): after a cancelled leader, rerunning followers must
	/// re-enter coordinated acquisition — exactly one new leader walks, the
	/// rest share its cached result, and later callers must hit that cache.
	#[test]
	fn rerun_followers_reenter_coordinated_acquisition() {
		use std::sync::mpsc;

		let dir = TempDirGuard::new();
		for index in 0..8 {
			fs::write(dir.path().join(format!("file-{index}.txt")), "payload").unwrap();
		}

		let options = cold_scan_options();
		let key = super::cache_key(dir.path(), options);

		let (gate_tx, gate_rx) = mpsc::channel::<()>();
		let gate = Arc::new(std::sync::Mutex::new(Some(gate_rx)));
		let leader_root = dir.path().to_path_buf();
		let leader_options = cold_scan_options();
		let leader_handle = std::thread::spawn(move || {
			super::collect_entries(
				&leader_root,
				leader_options,
				gated_heartbeat(gate, "leader cancelled"),
			)
		});
		wait_for_flight(&key);

		// Park two followers inside wait_for_leader so both receive the
		// cancelled leader's Rerun broadcast while it is still registered.
		let mut follower_polls = Vec::new();
		let mut follower_handles = Vec::new();
		for _ in 0..2 {
			let polls = Arc::new(AtomicU64::new(0));
			let poll_counter = polls.clone();
			follower_polls.push(polls);
			let follower_root = dir.path().to_path_buf();
			let follower_options = cold_scan_options();
			follower_handles.push(std::thread::spawn(move || {
				let heartbeat = move || -> std::result::Result<(), String> {
					poll_counter.fetch_add(1, Ordering::Relaxed);
					Ok(())
				};
				super::collect_entries(&follower_root, follower_options, heartbeat)
			}));
		}
		for polls in &follower_polls {
			for _ in 0..400 {
				if polls.load(Ordering::Relaxed) > 0 {
					break;
				}
				std::thread::sleep(Duration::from_millis(5));
			}
			assert!(polls.load(Ordering::Relaxed) > 0, "follower never joined the flight");
		}

		gate_tx.send(()).expect("release leader");
		leader_handle
			.join()
			.unwrap()
			.expect_err("leader should surface its own cancel");

		for handle in follower_handles {
			let entries = handle
				.join()
				.unwrap()
				.expect("rerunning follower must complete successfully");
			assert_eq!(entries.entries.len(), 8);
		}

		// The coordinated rerun must publish its snapshot: a later caller
		// resolves from cache instead of scanning a third time.
		let later =
			super::collect_entries(dir.path(), cold_scan_options(), ok_heartbeat).expect("later scan");
		assert_eq!(later.entries.len(), 8);

		let walks = super::TEST_WALK_COUNTS
			.lock()
			.get(dir.path())
			.copied()
			.unwrap_or(0);
		assert_eq!(walks, 2, "cancelled leader plus exactly one shared rerun must total two walks");
	}

	/// Regression (B): an unskippable scan-wide failure is shared once with
	/// blocked followers instead of being retried once per caller.
	#[test]
	fn scan_wide_failure_is_shared_with_waiting_followers() {
		let dir = TempDirGuard::new();
		let missing = dir.path().join("never-created");

		// Hold the leader between flight registration and the walk so the
		// followers below are provably blocked on its flight before it fails.
		let disarm = arm_pause("before-walk", &missing);
		let arrived_before = super::TEST_PAUSE_ARRIVALS.load(Ordering::Relaxed);

		let leader_root = missing.clone();
		let leader_handle = std::thread::spawn(move || {
			super::collect_entries(&leader_root, cold_scan_options(), ok_heartbeat)
		});

		for _ in 0..400 {
			if super::TEST_PAUSE_ARRIVALS.load(Ordering::Relaxed) > arrived_before {
				break;
			}
			std::thread::sleep(Duration::from_millis(5));
		}
		assert!(
			super::TEST_PAUSE_ARRIVALS.load(Ordering::Relaxed) > arrived_before,
			"leader never reached the pre-walk pause"
		);

		let mut followers = Vec::new();
		for _ in 0..3 {
			let polls = Arc::new(AtomicU64::new(0));
			let poll_counter = polls.clone();
			let follower_root = missing.clone();
			followers.push((
				polls,
				std::thread::spawn(move || {
					let heartbeat = move || -> std::result::Result<(), String> {
						poll_counter.fetch_add(1, Ordering::Relaxed);
						Ok(())
					};
					super::collect_entries(&follower_root, cold_scan_options(), heartbeat)
				}),
			));
		}
		for (polls, _) in &followers {
			for _ in 0..400 {
				if polls.load(Ordering::Relaxed) > 0 {
					break;
				}
				std::thread::sleep(Duration::from_millis(5));
			}
			assert!(polls.load(Ordering::Relaxed) > 0, "follower never joined the flight");
		}
		drop(disarm);

		leader_handle
			.join()
			.unwrap()
			.expect_err("missing root must fail the leader with a scan-wide InvalidData error");
		for (_, handle) in followers {
			let result = handle.join().unwrap();
			assert!(
				matches!(result, Err(WalkError::InvalidData { .. })),
				"follower must inherit the shared InvalidData failure, got {result:?}"
			);
		}

		let walks = super::TEST_WALK_COUNTS
			.lock()
			.get(&missing)
			.copied()
			.unwrap_or(0);
		assert_eq!(
			walks, 1,
			"one unskippable failure must be shared with followers, not retried per caller"
		);
	}

	/// Regression (E): a caller suspended in the miss-to-leadership window
	/// while another scan completes must serve the fresh snapshot as leader
	/// instead of walking over it.
	#[test]
	fn late_leader_serves_snapshot_completed_during_toctou_window() {
		let dir = TempDirGuard::new();
		for index in 0..4 {
			fs::write(dir.path().join(format!("file-{index}.txt")), "payload").unwrap();
		}

		let disarm = arm_pause("before-join", dir.path());
		let arrived_before = super::TEST_PAUSE_ARRIVALS.load(Ordering::Relaxed);

		let caller_root = dir.path().to_path_buf();
		let caller_handle = std::thread::spawn(move || {
			super::collect_entries(&caller_root, cold_scan_options(), ok_heartbeat)
		});

		for _ in 0..400 {
			if super::TEST_PAUSE_ARRIVALS.load(Ordering::Relaxed) > arrived_before {
				break;
			}
			std::thread::sleep(Duration::from_millis(5));
		}
		assert!(
			super::TEST_PAUSE_ARRIVALS.load(Ordering::Relaxed) > arrived_before,
			"caller never entered the miss-to-leadership window"
		);

		// Another caller completes the entire scan — cache insert, flight
		// deregistration included — while the first caller is suspended.
		let raced = super::collect_entries(dir.path(), cold_scan_options(), ok_heartbeat)
			.expect("racing scan");
		assert_eq!(raced.entries.len(), 4);

		// Resume the suspended caller: it now acquires leadership of a fresh
		// flight and must recheck the cache before walking.
		drop(disarm);
		let entries = caller_handle
			.join()
			.unwrap()
			.expect("suspended caller should succeed");
		assert_eq!(entries.entries.len(), 4);

		let walks = super::TEST_WALK_COUNTS
			.lock()
			.get(dir.path())
			.copied()
			.unwrap_or(0);
		assert_eq!(walks, 1, "caller that lost the toctou race must not walk again");
	}

	/// Regression (F): a follower whose heartbeat was running when the leader
	/// published must return immediately, not sleep out another poll interval.
	#[test]
	fn follower_skips_poll_sleep_when_outcome_lands_during_heartbeat() {
		use std::sync::mpsc;

		let dir = TempDirGuard::new();
		for index in 0..4 {
			fs::write(dir.path().join(format!("file-{index}.txt")), "payload").unwrap();
		}

		let options = cold_scan_options();
		let key = super::cache_key(dir.path(), options);

		// Leader parks on its first heartbeat until we release it, then
		// finishes its walk successfully and publishes the shared outcome.
		let (gate_tx, gate_rx) = mpsc::channel::<()>();
		let leader_root = dir.path().to_path_buf();
		let leader_handle = std::thread::spawn(move || {
			super::collect_entries(&leader_root, cold_scan_options(), staged_heartbeat(gate_rx))
		});
		wait_for_flight(&key);

		// Follower parks inside its own heartbeat poll after finding no
		// cached snapshot, exactly when the outcome lands.
		let (parked_tx, parked_rx) = mpsc::channel::<()>();
		let (release_tx, release_rx) = mpsc::channel::<()>();
		let release_rx = std::sync::Mutex::new(release_rx);
		let follower_root = dir.path().to_path_buf();
		let follower_handle = std::thread::spawn(move || {
			let heartbeat = move || -> std::result::Result<(), String> {
				let _ = parked_tx.send(());
				release_rx
					.lock()
					.expect("release lock")
					.recv()
					.map_err(|_| "release channel closed".to_string())?;
				Ok(())
			};
			super::collect_entries(&follower_root, cold_scan_options(), heartbeat)
		});
		parked_rx
			.recv_timeout(Duration::from_secs(5))
			.expect("follower never parked in its heartbeat");

		// Complete the leader and wait for the published outcome to be
		// observable before releasing the still-parked follower.
		gate_tx.send(()).expect("release leader");
		let leader_entries = leader_handle
			.join()
			.unwrap()
			.expect("leader should succeed");
		assert_eq!(leader_entries.entries.len(), 4);
		for _ in 0..400 {
			if super::SCAN_CACHE.contains_key(&key) {
				break;
			}
			std::thread::sleep(Duration::from_millis(5));
		}
		assert!(super::SCAN_CACHE.contains_key(&key), "leader never published the snapshot");

		let started = Instant::now();
		release_tx.send(()).expect("release follower");
		let entries = follower_handle
			.join()
			.unwrap()
			.expect("follower should reuse the shared result");
		assert_eq!(entries.entries.len(), 4);

		let elapsed = started.elapsed();
		assert!(
			elapsed < Duration::from_millis(40),
			"follower slept out a 50ms poll interval despite a published outcome: {elapsed:?}"
		);
	}
}
