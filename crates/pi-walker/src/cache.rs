//! Shared walker scan cache used by owned-entry collection.

use std::{
	borrow::Cow,
	collections::HashMap,
	fmt,
	path::{Path, PathBuf},
	sync::{Arc, LazyLock},
	time::{Duration, Instant},
};

use parking_lot::Mutex;
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
	entries:    Arc<Vec<CollectedEntry>>,
	bytes:      usize,
}

struct ScanCache {
	entries:     HashMap<CacheKey, CacheEntry>,
	bytes:       usize,
	generation:  u64,
	ttl:         Duration,
	max_entries: usize,
	max_bytes:   usize,
}

impl ScanCache {
	fn new(ttl: Duration, max_entries: usize, max_bytes: usize) -> Self {
		Self { entries: HashMap::new(), bytes: 0, generation: 0, ttl, max_entries, max_bytes }
	}

	fn remove(&mut self, key: &CacheKey) {
		if let Some(entry) = self.entries.remove(key) {
			self.bytes -= entry.bytes;
		}
	}

	fn expire(&mut self, now: Instant) {
		self.entries.retain(|_, entry| {
			if now.saturating_duration_since(entry.created_at) < self.ttl {
				true
			} else {
				self.bytes -= entry.bytes;
				false
			}
		});
	}

	fn get(&mut self, key: &CacheKey, now: Instant) -> Option<CacheEntry> {
		self.expire(now);
		self.entries.get(key).cloned()
	}

	fn insert(&mut self, key: CacheKey, entry: CacheEntry, generation: u64, now: Instant) {
		self.expire(now);
		if generation != self.generation
			|| self.max_entries == 0
			|| entry.bytes > self.max_bytes
			|| self.max_bytes == 0
			|| now.saturating_duration_since(entry.created_at) >= self.ttl
			|| self
				.entries
				.get(&key)
				.is_some_and(|cached| cached.created_at > entry.created_at)
		{
			return;
		}
		self.remove(&key);
		while self.entries.len() >= self.max_entries || self.bytes > self.max_bytes - entry.bytes {
			let oldest = self
				.entries
				.iter()
				.min_by_key(|(_, value)| value.created_at)
				.map(|(key, _)| key.clone());
			if let Some(oldest) = oldest {
				self.remove(&oldest);
			} else {
				break;
			}
		}
		self.bytes += entry.bytes;
		self.entries.insert(key, entry);
	}

	fn invalidate(&mut self, target: Option<&Path>) {
		self.generation = self.generation.wrapping_add(1);
		self.entries.retain(|key, entry| {
			if target.is_none_or(|target| target.starts_with(&key.root)) {
				self.bytes -= entry.bytes;
				false
			} else {
				true
			}
		});
	}
}

fn entry_bytes(entries: &[CollectedEntry], capacity: usize) -> usize {
	entries
		.iter()
		.fold(capacity.saturating_mul(size_of::<CollectedEntry>()), |bytes, entry| {
			bytes.saturating_add(entry.path.capacity())
		})
}

static CACHE_TTL_MS: LazyLock<u64> =
	LazyLock::new(|| env_uint("FS_SCAN_CACHE_TTL_MS", 1_000, 0, u64::MAX));
static EMPTY_RECHECK_MS: LazyLock<u64> =
	LazyLock::new(|| env_uint("FS_SCAN_EMPTY_RECHECK_MS", 200, 0, u64::MAX));
static MAX_CACHE_ENTRIES: LazyLock<usize> =
	LazyLock::new(|| env_uint("FS_SCAN_CACHE_MAX_ENTRIES", 16, 0, usize::MAX));
static MAX_CACHE_BYTES: LazyLock<usize> =
	LazyLock::new(|| env_uint("FS_SCAN_CACHE_MAX_BYTES", 64 * 1024 * 1024, 0, usize::MAX));
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
static SCAN_CACHE: LazyLock<Mutex<ScanCache>> = LazyLock::new(|| {
	Mutex::new(ScanCache::new(
		Duration::from_millis(*CACHE_TTL_MS),
		*MAX_CACHE_ENTRIES,
		*MAX_CACHE_BYTES,
	))
});

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
	if *CACHE_TTL_MS == 0 || *MAX_CACHE_ENTRIES == 0 || *MAX_CACHE_BYTES == 0 {
		return collect_entries_uncached(root, options, heartbeat);
	}

	heartbeat().map_err(|err| WalkError::Interrupted(err.to_string()))?;
	let key = cache_key(root, options);
	let now = Instant::now();
	let (cached, generation) = {
		let mut cache = SCAN_CACHE.lock();
		(cache.get(&key, now), cache.generation)
	};
	if let Some(entry) = cached {
		let entries = entry.entries.as_ref().clone();
		heartbeat().map_err(|err| WalkError::Interrupted(err.to_string()))?;
		return Ok(CollectedEntries {
			entries,
			cache_age_ms: now.saturating_duration_since(entry.created_at).as_millis() as u64,
		});
	}

	let scan = collect_entries_uncached(root, options, heartbeat)?;
	let bytes = entry_bytes(&scan.entries, scan.entries.capacity());
	if bytes > *MAX_CACHE_BYTES {
		return Ok(scan);
	}
	let entries = Arc::new(scan.entries);
	SCAN_CACHE.lock().insert(
		key,
		CacheEntry { created_at: now, entries: Arc::clone(&entries), bytes },
		generation,
		Instant::now(),
	);
	let entries = Arc::unwrap_or_clone(entries);
	heartbeat().map_err(|err| WalkError::Interrupted(err.to_string()))?;
	Ok(CollectedEntries { entries, cache_age_ms: 0 })
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
	SCAN_CACHE.lock().invalidate(Some(target));
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
	SCAN_CACHE.lock().invalidate(None);
}

#[cfg(test)]
mod tests {
	#[cfg(unix)]
	use std::{ffi::CString, os::unix::ffi::OsStrExt};
	use std::{
		fs,
		path::{Path, PathBuf},
		sync::atomic::{AtomicU64, Ordering},
		time::{Duration, SystemTime, UNIX_EPOCH},
	};

	#[cfg(unix)]
	use super::classify_file_type;
	use crate::{CollectedEntry, FileType};

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

	fn cached_entry(
		path: &str,
		spare_bytes: usize,
		created_at: std::time::Instant,
	) -> super::CacheEntry {
		let mut value = String::with_capacity(path.len() + spare_bytes);
		value.push_str(path);
		let entries = vec![CollectedEntry {
			path:      value,
			file_type: FileType::File,
			mtime:     None,
			size:      None,
		}];
		let bytes = super::entry_bytes(&entries, entries.capacity());
		super::CacheEntry { created_at, entries: std::sync::Arc::new(entries), bytes }
	}

	fn key(name: &str) -> super::CacheKey {
		super::cache_key(Path::new(name), crate::WalkOptions::default())
	}

	#[test]
	fn cache_evicts_oldest_by_allocated_bytes_and_rejects_oversized_scans() {
		let now = std::time::Instant::now();
		let a = cached_entry("a", 512, now);
		let b = cached_entry("b", 512, now + Duration::from_millis(1));
		let c = cached_entry("c", 512, now + Duration::from_millis(2));
		let mut cache = super::ScanCache::new(Duration::from_secs(60), 16, a.bytes + b.bytes);
		cache.insert(key("a"), a, 0, now);
		cache.insert(key("b"), b, 0, now);
		cache.insert(key("c"), c, 0, now);
		assert!(cache.get(&key("a"), now).is_none());
		assert_eq!(cache.get(&key("b"), now).unwrap().entries[0].path, "b");
		assert_eq!(cache.get(&key("c"), now).unwrap().entries[0].path, "c");
		let oversized = cached_entry("too-large", cache.max_bytes, now);
		cache.insert(key("oversized"), oversized, 0, now);
		assert!(cache.get(&key("oversized"), now).is_none());
		assert_eq!(cache.entries.len(), 2);
		assert!(cache.bytes <= cache.max_bytes);
	}

	#[test]
	fn cache_replacements_release_budget_and_old_scans_do_not_replace_newer_results() {
		let now = std::time::Instant::now();
		let large = cached_entry("old", 512, now);
		let mut cache = super::ScanCache::new(Duration::from_secs(60), 16, large.bytes);
		cache.insert(key("root"), large, 0, now);
		cache.insert(key("root"), cached_entry("new", 0, now + Duration::from_millis(1)), 0, now);
		cache.insert(key("other"), cached_entry("other", 0, now), 0, now);
		cache.insert(key("root"), cached_entry("stale", 0, now), 0, now);
		assert_eq!(cache.get(&key("root"), now).unwrap().entries[0].path, "new");
		assert_eq!(cache.get(&key("other"), now).unwrap().entries[0].path, "other");
		assert_eq!(
			cache.bytes,
			cache
				.entries
				.values()
				.map(|entry| entry.bytes)
				.sum::<usize>()
		);
	}

	#[test]
	fn cache_miss_releases_all_expired_payloads_and_rejects_already_expired_scans() {
		let now = std::time::Instant::now();
		let ttl = Duration::from_millis(10);
		let mut cache = super::ScanCache::new(ttl, 16, 4096);
		let expired = cached_entry("expired", 0, now);
		let weak = std::sync::Arc::downgrade(&expired.entries);
		cache.insert(key("expired"), expired, 0, now);
		cache.insert(
			key("fresh"),
			cached_entry("fresh", 0, now + Duration::from_millis(1)),
			0,
			now + Duration::from_millis(1),
		);
		assert!(cache.get(&key("missing"), now + ttl).is_none());
		assert!(weak.upgrade().is_none());
		cache.insert(key("slow"), cached_entry("slow", 0, now), 0, now + ttl);
		assert!(cache.get(&key("slow"), now + ttl).is_none());
		assert_eq!(cache.get(&key("fresh"), now + ttl).unwrap().entries[0].path, "fresh");
	}

	#[test]
	fn invalidation_prevents_inflight_scan_repopulation() {
		let now = std::time::Instant::now();
		let cache = std::sync::Arc::new(parking_lot::Mutex::new(super::ScanCache::new(
			Duration::from_secs(60),
			16,
			4096,
		)));
		let scanned = std::sync::Arc::new(std::sync::Barrier::new(2));
		let invalidated = std::sync::Arc::new(std::sync::Barrier::new(2));
		let worker = {
			let cache = std::sync::Arc::clone(&cache);
			let scanned = std::sync::Arc::clone(&scanned);
			let invalidated = std::sync::Arc::clone(&invalidated);
			std::thread::spawn(move || {
				let generation = cache.lock().generation;
				let entry = cached_entry("stale", 0, now);
				scanned.wait();
				invalidated.wait();
				cache.lock().insert(key("root"), entry, generation, now);
			})
		};
		scanned.wait();
		cache.lock().invalidate(Some(Path::new("root/changed")));
		invalidated.wait();
		worker.join().unwrap();
		let mut cache = cache.lock();
		assert!(cache.get(&key("root"), now).is_none());
		let generation = cache.generation;
		cache.insert(key("root"), cached_entry("fresh", 0, now), generation, now);
		assert_eq!(cache.get(&key("root"), now).unwrap().entries[0].path, "fresh");
	}

	#[test]
	fn concurrent_inserts_enforce_count_and_byte_limits_without_mutating_snapshots() {
		let now = std::time::Instant::now();
		let cache = std::sync::Arc::new(parking_lot::Mutex::new(super::ScanCache::new(
			Duration::from_secs(60),
			3,
			2048,
		)));
		let barrier = std::sync::Arc::new(std::sync::Barrier::new(16));
		let workers: Vec<_> = (0..16)
			.map(|index| {
				let cache = std::sync::Arc::clone(&cache);
				let barrier = std::sync::Arc::clone(&barrier);
				std::thread::spawn(move || {
					let name = index.to_string();
					let entry = cached_entry(&name, 512, now + Duration::from_millis(index));
					let snapshot = std::sync::Arc::clone(&entry.entries);
					barrier.wait();
					let mut cache = cache.lock();
					cache.insert(key(&name), entry, 0, now);
					assert!(cache.bytes <= 2048);
					assert!(cache.entries.len() <= 3);
					drop(cache);
					assert_eq!(snapshot[0].path, name);
				})
			})
			.collect();
		for worker in workers {
			worker.join().unwrap();
		}
		let mut cache = cache.lock();
		cache.invalidate(None);
		assert_eq!(cache.bytes, 0);
		assert!(cache.entries.is_empty());
	}

	#[test]
	fn cache_hits_preserve_owned_results_and_respect_cancellation() {
		let root = TempDirGuard::new();
		fs::write(root.path().join("real.txt"), "ok").unwrap();
		let options = crate::WalkOptions {
			cache: true,
			..scan_options(true, false, crate::WalkDetail::Minimal)
		};
		let mut first = super::collect_entries(root.path(), options, ok_heartbeat).unwrap();
		first.entries[0].path = "changed-by-caller".to_owned();
		std::thread::sleep(Duration::from_millis(2));
		let second = super::collect_entries(root.path(), options, ok_heartbeat).unwrap();
		assert!(second.cache_age_ms > 0, "second collection must use the cached snapshot");
		assert_eq!(second.entries[0].path, "real.txt");
		let cancelled = super::collect_entries(root.path(), options, || Err("cancelled"));
		assert!(
			matches!(cancelled, Err(crate::WalkError::Interrupted(error)) if error == "cancelled")
		);
		let heartbeat_calls = AtomicU64::new(0);
		let cancelled_after_copy = super::collect_entries(root.path(), options, || {
			if heartbeat_calls.fetch_add(1, Ordering::Relaxed) == 0 {
				Ok(())
			} else {
				Err("cancelled after copy")
			}
		});
		assert!(
			matches!(cancelled_after_copy, Err(crate::WalkError::Interrupted(error)) if error == "cancelled after copy")
		);
		super::invalidate_path(root.path());
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
}
