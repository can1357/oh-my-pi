//! Reusable platform directory traversal primitives.
//!
//! # Overview
//! `pi-walker` owns the native directory-read fast path that higher-level tools
//! use for globbing, grep candidate discovery, AST scans, and shell builtins.
//! The crate exposes plain Rust types, visitor interfaces, cache policy, and a
//! caller-supplied heartbeat so consumers do not inherit N-API dependencies.

mod cache;

#[cfg(not(unix))]
use std::ffi::OsString;
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
use std::{
	borrow::Cow,
	cell::{Cell, RefCell},
	cmp::Ordering,
	convert::Infallible,
	ffi::OsStr,
	fmt,
	hash::{Hash, Hasher},
	io::{self, BufRead},
	path::{Path, PathBuf},
	sync::{
		Arc, Mutex,
		atomic::{AtomicBool, Ordering as AtomicOrdering},
	},
};

pub use cache::{
	cache_ttl_ms, classify_file_type, contains_component, empty_recheck_ms, invalidate_all,
	invalidate_path, invalidate_path_string, max_cache_entries, normalize_relative_path,
	parallel_for_each, parallel_for_each_init, resolve_search_path, should_parallelize,
	should_skip_path, walk_workers,
};
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};

const HEARTBEAT_INTERVAL: usize = 128;

/// Filesystem entry kind reported by the walker.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum FileType {
	/// Regular file.
	File,
	/// Directory.
	Dir,
	/// Symbolic link.
	Symlink,
}

/// Amount of metadata to collect while reading directories.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum WalkDetail {
	/// Collect only the entry name and file kind.
	Minimal,
	/// Also collect mtime and byte size for regular files.
	Full,
}

/// Traversal order for entries within each directory.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum WalkOrder {
	/// Visit entries in the order returned by the platform API.
	Unordered,
	/// Sort entries by filename before visiting them.
	Path,
}

/// How directory-open errors are handled during traversal.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum DirectoryErrorMode {
	/// Preserve the native glob fast-path contract: silently skip common race or
	/// permission failures and fail on other directory errors.
	SkipSkippable,
	/// Deliver directory errors to [`EntryVisitor::visit_directory_error`] so
	/// GNU-style consumers can report them and continue.
	Visit,
}

/// Symbolic-link traversal policy.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum FollowLinks {
	/// Never follow symbolic links.
	Never,
	/// Follow root operands when they are symbolic links, but not descendants.
	Roots,
	/// Follow symbolic links at every depth.
	Always,
}

impl From<bool> for FollowLinks {
	fn from(follow: bool) -> Self {
		if follow { Self::Always } else { Self::Never }
	}
}

impl FollowLinks {
	const fn follow_at_depth(self, depth: usize) -> bool {
		match self {
			Self::Never => false,
			Self::Roots => depth == 0,
			Self::Always => true,
		}
	}
}

/// Shared cache use policy for high-level walk requests.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum CachePolicy {
	/// Collect without using or updating the shared scan cache.
	Disabled,
	/// Use the shared scan cache for owned-entry collection.
	Enabled,
}

/// Empty cached-result revalidation policy for [`WalkRequest::collect`].
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum EmptyRecheck {
	/// Never re-scan an empty cached result.
	Never,
	/// Re-scan empty cached results at or above the configured
	/// [`empty_recheck_ms`] threshold.
	Configured,
	/// Re-scan empty cached results at or above this cache age.
	AfterMillis(u64),
}

/// Size metadata policy for high-level requests.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum SizeHintPolicy {
	/// Preserve the request's [`WalkDetail`] setting.
	FromDetail,
	/// Request minimal metadata even on platforms with cheap size hints.
	Never,
	/// Request full metadata only when the platform exposes cheap file sizes.
	WhenCheap,
	/// Request full metadata for every yielded entry.
	Always,
}

/// Directory visit order for high-level requests.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum VisitOrder {
	/// Yield a directory before its children.
	PreOrder,
	/// Yield a directory after its children when supported by the backend.
	ContentsFirst,
}

/// Concrete compiled glob filter for normalized walk-relative paths.
///
/// Patterns are expected to already use the walker's normalized `/` separator
/// form. Each pattern is compiled with [`GlobBuilder::literal_separator`] so
/// wildcard matches never cross path separators. Equality and hashing use only
/// the normalized pattern list, not the compiled matcher internals, which keeps
/// [`WalkFilter`] suitable for static cacheable traversal policy.
#[derive(Clone)]
pub struct CompiledWalkGlob {
	patterns: Arc<[String]>,
	matcher:  Arc<GlobSet>,
}

impl CompiledWalkGlob {
	/// Compile normalized glob patterns for walk-relative paths.
	pub fn new<P, I>(patterns: I) -> Result<Self, globset::Error>
	where
		P: Into<String>,
		I: IntoIterator<Item = P>,
	{
		let mut normalized_patterns = Vec::new();
		let mut builder = GlobSetBuilder::new();
		for pattern in patterns {
			let pattern = pattern.into();
			let glob = GlobBuilder::new(&pattern).literal_separator(true).build()?;
			builder.add(glob);
			normalized_patterns.push(pattern);
		}
		Ok(Self { patterns: normalized_patterns.into(), matcher: Arc::new(builder.build()?) })
	}

	/// Return whether `relative` matches any compiled pattern.
	pub fn is_match(&self, relative: &str) -> bool {
		self.matcher.is_match(relative)
	}

	/// Return the normalized patterns backing this compiled filter.
	pub fn patterns(&self) -> &[String] {
		&self.patterns
	}
}

impl fmt::Debug for CompiledWalkGlob {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("CompiledWalkGlob")
			.field("patterns", &self.patterns)
			.finish()
	}
}

impl PartialEq for CompiledWalkGlob {
	fn eq(&self, other: &Self) -> bool {
		self.patterns == other.patterns
	}
}

impl Eq for CompiledWalkGlob {}

impl Hash for CompiledWalkGlob {
	fn hash<H: Hasher>(&self, state: &mut H) {
		self.patterns.hash(state);
	}
}

/// High-level entry filter applied by collection and streaming APIs.
#[derive(Clone)]
pub struct WalkFilter {
	kind: WalkFilterKind,
	max_file_size: Option<u64>,
	skip_node_modules_unless_seen: bool,
	mentions_node_modules: bool,
	glob: Option<CompiledWalkGlob>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum WalkFilterKind {
	All,
	Files,
	Dirs,
}

impl Default for WalkFilter {
	fn default() -> Self {
		Self::all()
	}
}

impl fmt::Debug for WalkFilter {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("WalkFilter")
			.field("kind", &self.kind)
			.field("max_file_size", &self.max_file_size)
			.field("skip_node_modules_unless_seen", &self.skip_node_modules_unless_seen)
			.field("mentions_node_modules", &self.mentions_node_modules)
			.field("glob", &self.glob)
			.finish()
	}
}

impl PartialEq for WalkFilter {
	fn eq(&self, other: &Self) -> bool {
		self.kind == other.kind
			&& self.max_file_size == other.max_file_size
			&& self.skip_node_modules_unless_seen == other.skip_node_modules_unless_seen
			&& self.mentions_node_modules == other.mentions_node_modules
			&& self.glob == other.glob
	}
}

impl Eq for WalkFilter {}

impl Hash for WalkFilter {
	fn hash<H: Hasher>(&self, state: &mut H) {
		self.kind.hash(state);
		self.max_file_size.hash(state);
		self.skip_node_modules_unless_seen.hash(state);
		self.mentions_node_modules.hash(state);
		self.glob.hash(state);
	}
}

impl WalkFilter {
	/// Return a filter that accepts files and directories.
	pub const fn all() -> Self {
		Self {
			kind: WalkFilterKind::All,
			max_file_size: None,
			skip_node_modules_unless_seen: false,
			mentions_node_modules: false,
			glob: None,
		}
	}

	/// Return a filter that emits only regular files.
	pub const fn files_only() -> Self {
		Self {
			kind: WalkFilterKind::Files,
			max_file_size: None,
			skip_node_modules_unless_seen: false,
			mentions_node_modules: false,
			glob: None,
		}
	}

	/// Return a filter that emits only directories.
	pub const fn dirs_only() -> Self {
		Self {
			kind: WalkFilterKind::Dirs,
			max_file_size: None,
			skip_node_modules_unless_seen: false,
			mentions_node_modules: false,
			glob: None,
		}
	}

	/// Limit emitted regular files to `max_file_size` bytes.
	pub const fn max_file_size(mut self, max_file_size: u64) -> Self {
		self.max_file_size = Some(max_file_size);
		self
	}

	/// Skip `node_modules` entries unless the caller's query mentioned them.
	pub const fn node_modules_unless_mentioned(mut self, mentions_node_modules: bool) -> Self {
		self.skip_node_modules_unless_seen = true;
		self.mentions_node_modules = mentions_node_modules;
		self
	}

	/// Accept only entries whose normalized relative path matches `glob`.
	pub fn glob(mut self, glob: CompiledWalkGlob) -> Self {
		self.glob = Some(glob);
		self
	}

	fn accepts_path(&self, relative_path: &str) -> bool {
		self
			.glob
			.as_ref()
			.is_none_or(|glob| glob.is_match(relative_path))
	}

	fn accepts_collected(&self, entry: &CollectedEntry) -> bool {
		if self.skip_node_modules_unless_seen
			&& !self.mentions_node_modules
			&& entry
				.path
				.split('/')
				.any(|component| component == "node_modules")
		{
			return false;
		}
		if self.max_file_size.is_some_and(|max| {
			entry.file_type == FileType::File && entry.size.is_some_and(|size| size > max as f64)
		}) {
			return false;
		}
		let accepts_kind = match self.kind {
			WalkFilterKind::All => true,
			WalkFilterKind::Files => entry.file_type == FileType::File,
			WalkFilterKind::Dirs => entry.file_type == FileType::Dir,
		};
		accepts_kind && self.accepts_path(&entry.path)
	}

	fn stream_decision(&self, meta: &EntryMeta<'_>) -> WalkDecision {
		if self.skip_node_modules_unless_seen
			&& !self.mentions_node_modules
			&& meta
				.relative_path
				.split('/')
				.any(|component| component == "node_modules")
		{
			return if meta.file_type == FileType::Dir {
				WalkDecision::SkipDescend
			} else {
				WalkDecision::Skip
			};
		}
		if self.max_file_size.is_some_and(|max| {
			meta.file_type == FileType::File && meta.size.is_some_and(|size| size > max as f64)
		}) {
			return WalkDecision::Skip;
		}
		let accepts_kind = match self.kind {
			WalkFilterKind::All => true,
			WalkFilterKind::Files => meta.file_type == FileType::File,
			WalkFilterKind::Dirs => meta.file_type == FileType::Dir,
		};
		if !accepts_kind {
			return WalkDecision::Skip;
		}
		if self.accepts_path(meta.relative_path) {
			WalkDecision::Include
		} else {
			WalkDecision::Skip
		}
	}
}

/// Traversal decision returned by [`WalkPredicate`] and closure streaming APIs.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum WalkDecision {
	/// Emit this entry and continue traversal.
	Include,
	/// Do not emit this entry, but continue traversal.
	Skip,
	/// Do not emit this directory and do not descend into it.
	SkipDescend,
	/// Stop traversal immediately.
	Stop,
}

/// Predicate hook for dynamic walk consumers.
pub trait WalkPredicate {
	/// Decide how the high-level walker should handle `entry`.
	fn decide(&mut self, entry: &EntryMeta<'_>) -> WalkDecision;
}

impl<F> WalkPredicate for F
where
	F: for<'entry, 'meta> FnMut(&'entry EntryMeta<'meta>) -> WalkDecision,
{
	fn decide(&mut self, entry: &EntryMeta<'_>) -> WalkDecision {
		self(entry)
	}
}

#[derive(Clone, Copy, Debug, Default)]
struct IncludeAllPredicate;

impl WalkPredicate for IncludeAllPredicate {
	fn decide(&mut self, _entry: &EntryMeta<'_>) -> WalkDecision {
		WalkDecision::Include
	}
}

/// Borrowed metadata view shared by owned and streaming entries.
pub struct EntryMeta<'a> {
	/// Traversal root used to resolve relative paths.
	pub root:          &'a Path,
	/// Absolute filesystem path.
	pub absolute_path: Cow<'a, Path>,
	/// Relative path from the root, using `/` separators.
	pub relative_path: &'a str,
	/// Filesystem entry kind.
	pub file_type:     FileType,
	/// Modification time in milliseconds since the Unix epoch, when requested.
	pub mtime:         Option<f64>,
	/// File size in bytes for regular files, when requested.
	pub size:          Option<f64>,
	/// Depth below the traversal root. Root depth is 0.
	pub depth:         usize,
}

impl<'a> EntryMeta<'a> {
	/// Build metadata for an owned collected entry.
	pub fn from_collected(root: &'a Path, entry: &'a CollectedEntry) -> Self {
		Self {
			root,
			absolute_path: Cow::Owned(entry.absolute_path(root)),
			relative_path: &entry.path,
			file_type: entry.file_type,
			mtime: entry.mtime,
			size: entry.size,
			depth: entry.depth(),
		}
	}

	/// Build metadata for a borrowed streaming entry.
	pub const fn from_entry(root: &'a Path, entry: &Entry<'a>) -> Self {
		Self {
			root,
			absolute_path: Cow::Borrowed(entry.path),
			relative_path: entry.relative,
			file_type: entry.file_type,
			mtime: entry.mtime,
			size: entry.size,
			depth: entry.depth,
		}
	}
}

/// Owned regular-file candidate returned by high-level file collection.
#[derive(Clone, Debug, PartialEq)]
pub struct FileCandidate {
	/// Absolute filesystem path to the regular file.
	pub path:     PathBuf,
	/// Relative path from the walk root, using `/` separators.
	pub relative: String,
	/// Modification time in milliseconds since the Unix epoch, when requested.
	pub mtime:    Option<f64>,
	/// File size in bytes, when requested.
	pub size:     Option<f64>,
}

impl FileCandidate {
	fn from_entry(root: &Path, entry: CollectedEntry) -> Self {
		Self {
			path:     entry.absolute_path(root),
			relative: entry.path,
			mtime:    entry.mtime,
			size:     entry.size,
		}
	}
}

/// Backend path used by a high-level collection.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum WalkBackend {
	/// The request returned entries from a fresh backend scan.
	Fresh,
	/// The request returned entries from the shared cache.
	Cached,
}

/// Ranking applied to high-level collected entries after filtering.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum WalkRank {
	/// Sort by normalized relative path in ascending byte order.
	PathAsc,
	/// Sort by modification time descending, then normalized relative path
	/// ascending.
	///
	/// Entries without modification times sort after entries with modification
	/// times. [`WalkRequest::collect_ranked_with_heartbeat`] requests full
	/// metadata for this rank so fresh scans can populate the mtime field.
	MtimeDescPathAsc,
}

/// Summary statistics for a high-level collection.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct WalkStats {
	/// Age of the cache entry in milliseconds; zero means freshly scanned.
	pub cache_age_ms:     u64,
	/// Entries before high-level filtering.
	pub scanned_entries:  usize,
	/// Entries removed by high-level filtering.
	pub filtered_entries: usize,
	/// Entries removed by the high-level limit.
	pub limited_entries:  usize,
}

/// Owned entries and metadata returned by [`WalkRequest::collect`].
#[derive(Clone, Debug, PartialEq)]
pub struct WalkOutcome {
	/// Entries after high-level filtering and limits.
	pub entries: Vec<CollectedEntry>,
	/// Collection backend classification.
	pub backend: WalkBackend,
	/// Collection statistics.
	pub stats:   WalkStats,
}

/// Options shared by native traversal consumers.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct WalkOptions {
	/// Include dot-prefixed entries.
	pub include_hidden:    bool,
	/// Honor `.ignore`, `.gitignore`, repository excludes, and global gitignore.
	pub use_gitignore:     bool,
	/// Prune `.git` directories during traversal.
	pub skip_git:          bool,
	/// Prune `node_modules` directories during traversal.
	pub skip_node_modules: bool,
	/// Symbolic-link traversal policy.
	pub follow_links:      FollowLinks,
	/// Metadata detail requested for each yielded entry.
	pub detail:            WalkDetail,
	/// Per-directory visit order.
	pub order:             WalkOrder,
	/// Yield the traversal root as a depth-0 entry before its children.
	pub emit_root:         bool,
	/// Minimum depth yielded to the visitor. Root depth is 0.
	pub min_depth:         usize,
	/// Maximum depth traversed and yielded. Root depth is 0.
	pub max_depth:         usize,
	/// Yield directory entries after their children.
	pub contents_first:    bool,
	/// Directory-open error handling policy.
	pub directory_errors:  DirectoryErrorMode,
	/// Stay on the root filesystem when supported by the platform.
	pub same_file_system:  bool,
	/// Use the shared scan cache when collecting owned entries.
	pub cache:             bool,
}

impl Default for WalkOptions {
	fn default() -> Self {
		Self {
			include_hidden:    true,
			use_gitignore:     false,
			skip_git:          false,
			skip_node_modules: false,
			follow_links:      FollowLinks::Never,
			detail:            WalkDetail::Minimal,
			order:             WalkOrder::Path,
			emit_root:         false,
			min_depth:         1,
			max_depth:         usize::MAX,
			contents_first:    false,
			directory_errors:  DirectoryErrorMode::Visit,
			same_file_system:  false,
			cache:             false,
		}
	}
}

/// High-level traversal request that owns a root and wraps [`WalkOptions`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WalkRequest {
	root:             PathBuf,
	options:          WalkOptions,
	cache_policy:     CachePolicy,
	filter:           WalkFilter,
	limit:            Option<usize>,
	empty_recheck:    EmptyRecheck,
	visit_order:      VisitOrder,
	size_hint_policy: SizeHintPolicy,
}

impl WalkRequest {
	/// Create a request rooted at `root` with default [`WalkOptions`].
	pub fn new(root: impl Into<PathBuf>) -> Self {
		Self::from_options(root, WalkOptions::default())
	}

	/// Create a request from existing low-level options.
	pub fn from_options(root: impl Into<PathBuf>, options: WalkOptions) -> Self {
		let cache_policy = if options.cache {
			CachePolicy::Enabled
		} else {
			CachePolicy::Disabled
		};
		let visit_order = if options.contents_first {
			VisitOrder::ContentsFirst
		} else {
			VisitOrder::PreOrder
		};
		Self {
			root: root.into(),
			options,
			cache_policy,
			filter: WalkFilter::default(),
			limit: None,
			empty_recheck: EmptyRecheck::Configured,
			visit_order,
			size_hint_policy: SizeHintPolicy::FromDetail,
		}
	}

	/// Return the traversal root.
	pub fn root(&self) -> &Path {
		&self.root
	}

	/// Return low-level options after applying high-level policies.
	pub const fn options(&self) -> WalkOptions {
		self.effective_options()
	}

	/// Include or exclude dot-prefixed entries.
	pub const fn hidden(mut self, include_hidden: bool) -> Self {
		self.options.include_hidden = include_hidden;
		self
	}

	/// Enable or disable `.ignore`/gitignore matching.
	pub const fn gitignore(mut self, use_gitignore: bool) -> Self {
		self.options.use_gitignore = use_gitignore;
		self
	}

	/// Enable or disable pruning `.git` directories.
	pub const fn skip_git(mut self, skip_git: bool) -> Self {
		self.options.skip_git = skip_git;
		self
	}

	/// Enable or disable pruning `node_modules` directories during traversal.
	pub const fn skip_node_modules(mut self, skip_node_modules: bool) -> Self {
		self.options.skip_node_modules = skip_node_modules;
		self
	}

	/// Set symbolic-link traversal policy.
	pub const fn follow_links(mut self, follow_links: FollowLinks) -> Self {
		self.options.follow_links = follow_links;
		self
	}

	/// Set metadata detail collected for entries.
	pub const fn detail(mut self, detail: WalkDetail) -> Self {
		self.options.detail = detail;
		self
	}

	/// Set per-directory entry order.
	pub const fn order(mut self, order: WalkOrder) -> Self {
		self.options.order = order;
		self
	}

	/// Enable or disable emitting the root entry.
	pub const fn emit_root(mut self, emit_root: bool) -> Self {
		self.options.emit_root = emit_root;
		self
	}

	/// Set minimum and maximum traversal depth.
	pub const fn depth(mut self, min_depth: usize, max_depth: usize) -> Self {
		self.options.min_depth = min_depth;
		self.options.max_depth = max_depth;
		self
	}

	/// Set directory-open error handling.
	pub const fn directory_errors(mut self, directory_errors: DirectoryErrorMode) -> Self {
		self.options.directory_errors = directory_errors;
		self
	}

	/// Enable or disable staying on the root filesystem.
	pub const fn same_file_system(mut self, same_file_system: bool) -> Self {
		self.options.same_file_system = same_file_system;
		self
	}

	/// Enable or disable the shared scan cache for owned collection.
	pub const fn cache(mut self, cache: bool) -> Self {
		self.cache_policy = if cache {
			CachePolicy::Enabled
		} else {
			CachePolicy::Disabled
		};
		self.options.cache = cache;
		self
	}

	/// Set the static high-level filter.
	pub fn filter(mut self, filter: WalkFilter) -> Self {
		self.filter = filter;
		self
	}

	/// Limit the number of emitted entries after filtering.
	pub const fn limit(mut self, limit: usize) -> Self {
		self.limit = Some(limit);
		self
	}

	/// Remove any high-level entry limit.
	pub const fn no_limit(mut self) -> Self {
		self.limit = None;
		self
	}

	/// Set empty cached-result revalidation policy.
	pub const fn empty_recheck(mut self, empty_recheck: EmptyRecheck) -> Self {
		self.empty_recheck = empty_recheck;
		self
	}

	/// Set high-level directory visit order.
	pub const fn visit_order(mut self, visit_order: VisitOrder) -> Self {
		self.visit_order = visit_order;
		self.options.contents_first = matches!(visit_order, VisitOrder::ContentsFirst);
		self
	}

	/// Set size metadata policy.
	pub const fn size_hints(mut self, size_hint_policy: SizeHintPolicy) -> Self {
		self.size_hint_policy = size_hint_policy;
		self
	}

	/// Collect owned entries, then apply high-level filters, limits, and
	/// empty-cache rechecks.
	pub fn collect(&self) -> std::result::Result<WalkOutcome, WalkError<String>> {
		self.collect_with_heartbeat(|| Ok::<(), Infallible>(()))
	}

	/// Collect owned entries with a caller-supplied heartbeat.
	pub fn collect_with_heartbeat<E, H>(
		&self,
		heartbeat: H,
	) -> std::result::Result<WalkOutcome, WalkError<String>>
	where
		H: Fn() -> std::result::Result<(), E> + Sync,
		E: fmt::Display,
	{
		self.collect_with_rank_and_limit(None, self.limit, heartbeat)
	}

	/// Collect owned entries, apply high-level filters, rank, then truncate to
	/// `limit`.
	///
	/// The request's stored [`WalkRequest::limit`] is intentionally not applied
	/// before ranking; `limit` is the top-N bound for this ranked collection.
	pub fn collect_ranked(
		&self,
		rank: WalkRank,
		limit: usize,
	) -> std::result::Result<WalkOutcome, WalkError<String>> {
		self.collect_ranked_with_heartbeat(rank, limit, || Ok::<(), Infallible>(()))
	}

	/// Collect owned entries with a caller-supplied heartbeat, apply high-level
	/// filters, rank, then truncate to `limit`.
	///
	/// Ranking happens after all high-level filters and before truncation so
	/// top-N callers observe the best matching entries, not the first traversed
	/// entries.
	pub fn collect_ranked_with_heartbeat<E, H>(
		&self,
		rank: WalkRank,
		limit: usize,
		heartbeat: H,
	) -> std::result::Result<WalkOutcome, WalkError<String>>
	where
		H: Fn() -> std::result::Result<(), E> + Sync,
		E: fmt::Display,
	{
		self.collect_with_rank_and_limit(Some(rank), Some(limit), heartbeat)
	}

	/// Collect regular files accepted by this request.
	pub fn collect_files(&self) -> std::result::Result<Vec<CollectedEntry>, WalkError<String>> {
		self.collect_files_with_heartbeat(|| Ok::<(), Infallible>(()))
	}

	/// Collect regular files accepted by this request with a caller-supplied
	/// heartbeat.
	pub fn collect_files_with_heartbeat<E, H>(
		&self,
		heartbeat: H,
	) -> std::result::Result<Vec<CollectedEntry>, WalkError<String>>
	where
		H: Fn() -> std::result::Result<(), E> + Sync,
		E: fmt::Display,
	{
		let outcome = self.collect_with_heartbeat(heartbeat)?;
		Ok(outcome
			.entries
			.into_iter()
			.filter(CollectedEntry::is_file)
			.collect())
	}

	/// Collect directories accepted by this request.
	pub fn collect_dirs(&self) -> std::result::Result<Vec<CollectedEntry>, WalkError<String>> {
		self.collect_dirs_with_heartbeat(|| Ok::<(), Infallible>(()))
	}

	/// Collect directories accepted by this request with a caller-supplied
	/// heartbeat.
	pub fn collect_dirs_with_heartbeat<E, H>(
		&self,
		heartbeat: H,
	) -> std::result::Result<Vec<CollectedEntry>, WalkError<String>>
	where
		H: Fn() -> std::result::Result<(), E> + Sync,
		E: fmt::Display,
	{
		let outcome = self.collect_with_heartbeat(heartbeat)?;
		Ok(outcome
			.entries
			.into_iter()
			.filter(CollectedEntry::is_dir)
			.collect())
	}

	/// Collect regular-file candidates accepted by this request.
	pub fn collect_file_candidates(
		&self,
	) -> std::result::Result<Vec<FileCandidate>, WalkError<String>> {
		self.collect_file_candidates_with_heartbeat(|| Ok::<(), Infallible>(()))
	}

	/// Collect regular-file candidates accepted by this request with a
	/// caller-supplied heartbeat.
	pub fn collect_file_candidates_with_heartbeat<E, H>(
		&self,
		heartbeat: H,
	) -> std::result::Result<Vec<FileCandidate>, WalkError<String>>
	where
		H: Fn() -> std::result::Result<(), E> + Sync,
		E: fmt::Display,
	{
		Ok(self
			.collect_file_candidates_with_stats_with_heartbeat(heartbeat)?
			.0)
	}

	/// Stream entries through `visitor` after applying high-level filters and
	/// limits.
	pub fn stream<V>(&self, visitor: &mut V) -> std::result::Result<WalkStatus, WalkError<V::Error>>
	where
		V: EntryVisitor,
	{
		self.stream_with_heartbeat(visitor, || Ok::<(), V::Error>(()))
	}

	/// Stream entries through `visitor` with a caller-supplied heartbeat.
	pub fn stream_with_heartbeat<V, H>(
		&self,
		visitor: &mut V,
		heartbeat: H,
	) -> std::result::Result<WalkStatus, WalkError<V::Error>>
	where
		V: EntryVisitor,
		H: FnMut() -> std::result::Result<(), V::Error>,
	{
		self.stream_with_predicate_and_heartbeat(visitor, IncludeAllPredicate, heartbeat)
	}

	/// Stream accepted entries through a closure after applying high-level
	/// filters and limits.
	///
	/// This is the closure-based counterpart to [`WalkRequest::stream`]. The
	/// closure receives borrowed [`EntryMeta`] for each entry that passes this
	/// request's static [`WalkFilter`] and dynamic request limit, then returns a
	/// [`WalkDecision`] to control traversal. [`WalkDecision::Include`] and
	/// [`WalkDecision::Skip`] both continue because the entry has already been
	/// delivered to the closure; [`WalkDecision::SkipDescend`] prunes the
	/// current directory's descendants, and [`WalkDecision::Stop`] stops
	/// traversal.
	///
	/// Directory-open errors are ignored and traversal continues when
	/// [`WalkOptions::directory_errors`] is [`DirectoryErrorMode::Visit`]. Use
	/// [`WalkRequest::for_each_entry_with_heartbeat`] to observe those errors or
	/// provide a heartbeat.
	pub fn for_each_entry<E, V>(&self, visit: V) -> std::result::Result<WalkStatus, WalkError<E>>
	where
		V: for<'entry> FnMut(EntryMeta<'entry>) -> std::result::Result<WalkDecision, E>,
	{
		self.for_each_entry_with_heartbeat(
			|| Ok::<(), E>(()),
			visit,
			|_| Ok::<WalkDecision, E>(WalkDecision::Include),
		)
	}

	/// Stream accepted entries through closures with a caller-supplied
	/// heartbeat.
	///
	/// `heartbeat` is invoked by the same traversal machinery used by
	/// [`WalkRequest::stream_with_heartbeat`]. `visit` receives each accepted
	/// [`EntryMeta`] and returns a [`WalkDecision`]: [`WalkDecision::Include`] and
	/// [`WalkDecision::Skip`] continue, [`WalkDecision::SkipDescend`] skips
	/// descendants of the current directory, and [`WalkDecision::Stop`] stops
	/// the walk. `directory_error` receives [`DirectoryError`] values when the
	/// request's [`WalkOptions::directory_errors`] is
	/// [`DirectoryErrorMode::Visit`] and returns the same traversal decision,
	/// letting GNU-style consumers report an error and continue or stop without
	/// implementing [`EntryVisitor`].
	pub fn for_each_entry_with_heartbeat<E, H, V, D>(
		&self,
		heartbeat: H,
		visit: V,
		directory_error: D,
	) -> std::result::Result<WalkStatus, WalkError<E>>
	where
		H: FnMut() -> std::result::Result<(), E>,
		V: for<'entry> FnMut(EntryMeta<'entry>) -> std::result::Result<WalkDecision, E>,
		D: for<'error> FnMut(DirectoryError<'error>) -> std::result::Result<WalkDecision, E>,
	{
		let mut visitor = ClosureEntryVisitor { root: &self.root, visit, directory_error };
		self.stream_with_heartbeat(&mut visitor, heartbeat)
	}

	/// Stream entries through `visitor` with an additional dynamic predicate.
	pub fn stream_with_predicate<V, P>(
		&self,
		visitor: &mut V,
		predicate: P,
	) -> std::result::Result<WalkStatus, WalkError<V::Error>>
	where
		V: EntryVisitor,
		P: WalkPredicate,
	{
		self.stream_with_predicate_and_heartbeat(visitor, predicate, || Ok::<(), V::Error>(()))
	}

	/// Stream entries through `visitor` with a dynamic predicate and
	/// caller-supplied heartbeat.
	pub fn stream_with_predicate_and_heartbeat<V, P, H>(
		&self,
		visitor: &mut V,
		predicate: P,
		mut heartbeat: H,
	) -> std::result::Result<WalkStatus, WalkError<V::Error>>
	where
		V: EntryVisitor,
		P: WalkPredicate,
		H: FnMut() -> std::result::Result<(), V::Error>,
	{
		let options = self.effective_options();
		let mut adapter = RequestVisitor {
			root: &self.root,
			filter: &self.filter,
			limit: self.limit,
			emitted: 0,
			visitor,
			predicate,
		};
		walk_entries(&self.root, options, &mut adapter, &mut heartbeat)
	}

	/// Run `operation` for each accepted regular file.
	pub fn for_each_file<E>(
		&self,
		operation: impl Fn(&Path) -> std::result::Result<(), E> + Send + Sync,
	) -> std::result::Result<WalkStats, WalkError<String>>
	where
		E: fmt::Display + Send,
	{
		self.for_each_file_with_heartbeat(operation, || Ok::<(), Infallible>(()))
	}

	/// Run `operation` for each accepted regular file with a caller-supplied
	/// heartbeat.
	pub fn for_each_file_with_heartbeat<E, HE, H>(
		&self,
		operation: impl Fn(&Path) -> std::result::Result<(), E> + Send + Sync,
		heartbeat: H,
	) -> std::result::Result<WalkStats, WalkError<String>>
	where
		E: fmt::Display + Send,
		H: Fn() -> std::result::Result<(), HE> + Sync,
		HE: fmt::Display,
	{
		self.for_each_file_candidate_with_heartbeat(|candidate| operation(&candidate.path), heartbeat)
	}

	/// Run `operation` for each accepted regular-file candidate.
	pub fn for_each_file_candidate<E>(
		&self,
		operation: impl Fn(&FileCandidate) -> std::result::Result<(), E> + Send + Sync,
	) -> std::result::Result<WalkStats, WalkError<String>>
	where
		E: fmt::Display + Send,
	{
		self.for_each_file_candidate_with_heartbeat(operation, || Ok::<(), Infallible>(()))
	}

	/// Run `operation` for each accepted regular-file candidate with a
	/// caller-supplied heartbeat.
	pub fn for_each_file_candidate_with_heartbeat<E, HE, H>(
		&self,
		operation: impl Fn(&FileCandidate) -> std::result::Result<(), E> + Send + Sync,
		heartbeat: H,
	) -> std::result::Result<WalkStats, WalkError<String>>
	where
		E: fmt::Display + Send,
		H: Fn() -> std::result::Result<(), HE> + Sync,
		HE: fmt::Display,
	{
		let (candidates, stats) =
			self.collect_file_candidates_with_stats_with_heartbeat(heartbeat)?;
		execute_candidates(&candidates, operation)
			.map_err(|err| WalkError::Interrupted(err.to_string()))?;
		Ok(stats)
	}

	/// Visit accepted regular-file candidates using an unordered parallel walk.
	///
	/// This is a files-only API for consumers that own their output ordering.
	/// Candidates may be delivered in any order. [`WalkOptions::order`],
	/// [`WalkRequest::visit_order`], [`WalkOptions::emit_root`], and
	/// [`WalkRequest::limit`] are ignored. Directory-open errors are skipped
	/// with grep-style semantics instead of being delivered to visitors.
	///
	/// [`ParallelWalkControl::Stop`] sets a shared stop flag; workers check that
	/// flag before reading each directory and while processing directory
	/// entries, then the method returns [`WalkStatus::Stopped`] after in-flight
	/// work winds down. If a sink or heartbeat returns an error, the first
	/// error wins and is returned as [`WalkError::Interrupted`].
	pub fn for_each_file_candidate_parallel<E>(
		&self,
		sink: impl Fn(&FileCandidate) -> std::result::Result<ParallelWalkControl, E> + Send + Sync,
		heartbeat: impl Fn() -> std::result::Result<(), E> + Send + Sync,
	) -> std::result::Result<WalkStatus, WalkError<E>>
	where
		E: Send,
	{
		run_file_candidate_parallel(self, &sink, &heartbeat)
	}

	fn collect_with_rank_and_limit<E, H>(
		&self,
		rank: Option<WalkRank>,
		limit: Option<usize>,
		heartbeat: H,
	) -> std::result::Result<WalkOutcome, WalkError<String>>
	where
		H: Fn() -> std::result::Result<(), E> + Sync,
		E: fmt::Display,
	{
		let mut options = self.effective_options();
		if matches!(rank, Some(WalkRank::MtimeDescPathAsc)) {
			options.detail = WalkDetail::Full;
		}
		let mut scan = self.collect_entries_with_options(options, &heartbeat)?;
		let mut backend = if scan.cache_age_ms == 0 {
			WalkBackend::Fresh
		} else {
			WalkBackend::Cached
		};
		let filter_entries = |entries: &mut Vec<CollectedEntry>| {
			let scanned_entries = entries.len();
			entries.retain(|entry| self.filter.accepts_collected(entry));
			(scanned_entries, scanned_entries - entries.len())
		};
		let (mut scanned_entries, mut filtered_entries) = filter_entries(&mut scan.entries);
		if scan.entries.is_empty() && self.should_recheck_empty(scan.cache_age_ms) {
			options.cache = false;
			scan = self.collect_entries_with_options(options, &heartbeat)?;
			backend = WalkBackend::Fresh;
			(scanned_entries, filtered_entries) = filter_entries(&mut scan.entries);
		}
		if let Some(rank) = rank {
			Self::rank_entries(&mut scan.entries, rank);
		}
		let limited_entries = if let Some(limit) = limit {
			let limited_entries = scan.entries.len().saturating_sub(limit);
			scan.entries.truncate(limit);
			limited_entries
		} else {
			0
		};
		let stats = WalkStats {
			cache_age_ms: scan.cache_age_ms,
			scanned_entries,
			filtered_entries,
			limited_entries,
		};
		Ok(WalkOutcome { entries: scan.entries, backend, stats })
	}

	fn rank_entries(entries: &mut [CollectedEntry], rank: WalkRank) {
		match rank {
			WalkRank::PathAsc => entries.sort_by(|left, right| left.path.cmp(&right.path)),
			WalkRank::MtimeDescPathAsc => entries.sort_by(Self::compare_mtime_desc_path_asc),
		}
	}

	fn compare_mtime_desc_path_asc(left: &CollectedEntry, right: &CollectedEntry) -> Ordering {
		let mtime_order = match (left.mtime, right.mtime) {
			(Some(left_mtime), Some(right_mtime)) => right_mtime.total_cmp(&left_mtime),
			(Some(_), None) => Ordering::Less,
			(None, Some(_)) => Ordering::Greater,
			(None, None) => Ordering::Equal,
		};
		mtime_order.then_with(|| left.path.cmp(&right.path))
	}

	const fn effective_options(&self) -> WalkOptions {
		let mut options = self.options;
		options.cache = matches!(self.cache_policy, CachePolicy::Enabled);
		options.contents_first = matches!(self.visit_order, VisitOrder::ContentsFirst);
		match self.size_hint_policy {
			SizeHintPolicy::FromDetail => {},
			SizeHintPolicy::Never => options.detail = WalkDetail::Minimal,
			SizeHintPolicy::WhenCheap => {
				options.detail = if supports_cheap_size_hints() {
					WalkDetail::Full
				} else {
					WalkDetail::Minimal
				};
			},
			SizeHintPolicy::Always => options.detail = WalkDetail::Full,
		}
		if self.filter.max_file_size.is_some() {
			options.detail = WalkDetail::Full;
		}
		options
	}

	fn collect_entries_with_options<E, H>(
		&self,
		options: WalkOptions,
		heartbeat: &H,
	) -> std::result::Result<CollectedEntries, WalkError<String>>
	where
		H: Fn() -> std::result::Result<(), E> + Sync,
		E: fmt::Display,
	{
		collect_entries(&self.root, options, heartbeat)
	}

	fn should_recheck_empty(&self, cache_age_ms: u64) -> bool {
		if cache_age_ms == 0 {
			return false;
		}
		match self.empty_recheck {
			EmptyRecheck::Never => false,
			EmptyRecheck::Configured => {
				let threshold = empty_recheck_ms();
				threshold > 0 && cache_age_ms >= threshold
			},
			EmptyRecheck::AfterMillis(threshold) => cache_age_ms >= threshold,
		}
	}

	fn collect_file_candidates_with_stats_with_heartbeat<E, H>(
		&self,
		heartbeat: H,
	) -> std::result::Result<(Vec<FileCandidate>, WalkStats), WalkError<String>>
	where
		H: Fn() -> std::result::Result<(), E> + Sync,
		E: fmt::Display,
	{
		let outcome = self.collect_with_heartbeat(heartbeat)?;
		let candidates = outcome
			.entries
			.into_iter()
			.filter(CollectedEntry::is_file)
			.map(|entry| FileCandidate::from_entry(&self.root, entry))
			.collect();
		Ok((candidates, outcome.stats))
	}
}

/// Execute work for regular-file candidates using the centralized walker pool.
pub fn execute_candidates<E>(
	candidates: &[FileCandidate],
	operation: impl Fn(&FileCandidate) -> std::result::Result<(), E> + Send + Sync,
) -> std::result::Result<(), E>
where
	E: Send,
{
	parallel_for_each(candidates, operation)
}

/// Execute work for regular-file candidates with per-worker state.
pub fn execute_candidates_init<S, E>(
	candidates: &[FileCandidate],
	init: impl Fn() -> S + Send + Sync,
	operation: impl Fn(&mut S, &FileCandidate) -> std::result::Result<(), E> + Send + Sync,
) -> std::result::Result<(), E>
where
	S: Send,
	E: Send,
{
	parallel_for_each_init(candidates, init, operation)
}

struct SerialCandidateVisitor<'a, S> {
	filter: &'a WalkFilter,
	sink:   &'a S,
}

impl<E, S> EntryVisitor for SerialCandidateVisitor<'_, S>
where
	S: Fn(&FileCandidate) -> std::result::Result<ParallelWalkControl, E> + Sync,
{
	type Error = E;

	fn visit(&mut self, _entry: Entry<'_>) -> std::result::Result<WalkControl, Self::Error> {
		Ok(WalkControl::Continue)
	}

	fn visit_pre_decided(
		&mut self,
		entry: Entry<'_>,
	) -> std::result::Result<WalkControl, Self::Error> {
		if entry.file_type != FileType::File {
			return Ok(WalkControl::Continue);
		}
		let candidate = FileCandidate {
			path:     entry.path.to_path_buf(),
			relative: entry.relative.to_string(),
			mtime:    entry.mtime,
			size:     entry.size,
		};
		match (self.sink)(&candidate)? {
			ParallelWalkControl::Continue => Ok(WalkControl::Continue),
			ParallelWalkControl::Stop => Ok(WalkControl::Quit),
		}
	}

	fn decide_pre_descend(
		&mut self,
		meta: &EntryMeta<'_>,
	) -> std::result::Result<PreDescendDecision, Self::Error> {
		let is_dir = meta.file_type == FileType::Dir;
		Ok(match self.filter.stream_decision(meta) {
			WalkDecision::Include => {
				PreDescendDecision { emit: true, descend: is_dir, stop: false }
			},
			WalkDecision::Skip => {
				PreDescendDecision { emit: false, descend: is_dir, stop: false }
			},
			WalkDecision::SkipDescend => {
				PreDescendDecision { emit: false, descend: false, stop: false }
			},
			WalkDecision::Stop => PreDescendDecision { emit: false, descend: false, stop: true },
		})
	}
}

struct ParallelWalkContext {
	root:    PathBuf,
	options: WalkOptions,
	filter:  WalkFilter,
	matcher: FastIgnore,
}

struct ParallelWalkShared<'a, E, S, H> {
	stop:      AtomicBool,
	error:     Mutex<Option<E>>,
	sink:      &'a S,
	heartbeat: &'a H,
}

impl<'a, E, S, H> ParallelWalkShared<'a, E, S, H> {
	const fn new(sink: &'a S, heartbeat: &'a H) -> Self {
		Self { stop: AtomicBool::new(false), error: Mutex::new(None), sink, heartbeat }
	}

	fn request_stop(&self) {
		self.stop.store(true, AtomicOrdering::Release);
	}

	fn should_stop(&self) -> bool {
		self.stop.load(AtomicOrdering::Acquire)
	}

	fn record_error(&self, error: E) {
		let mut slot = match self.error.lock() {
			Ok(slot) => slot,
			Err(poisoned) => poisoned.into_inner(),
		};
		if slot.is_none() {
			*slot = Some(error);
		}
		self.request_stop();
	}

	fn take_error(&self) -> Option<E> {
		match self.error.lock() {
			Ok(mut slot) => slot.take(),
			Err(poisoned) => poisoned.into_inner().take(),
		}
	}
}

thread_local! {
	static PARALLEL_HEARTBEAT_COUNTER: Cell<usize> = const { Cell::new(0) };
	static PARALLEL_SCRATCH_POOL: RefCell<Vec<DirScratch>> = const { RefCell::new(Vec::new()) };
}

fn should_use_parallel_file_candidate_walk(options: WalkOptions) -> bool {
	walk_workers() > 1 && options.follow_links == FollowLinks::Never && !options.same_file_system
}

fn run_file_candidate_parallel<E, S, H>(
	request: &WalkRequest,
	sink: &S,
	heartbeat: &H,
) -> std::result::Result<WalkStatus, WalkError<E>>
where
	E: Send,
	S: Fn(&FileCandidate) -> std::result::Result<ParallelWalkControl, E> + Sync,
	H: Fn() -> std::result::Result<(), E> + Sync,
{
	let mut options = request.effective_options();
	if options.min_depth > options.max_depth {
		return Ok(WalkStatus::Complete);
	}
	heartbeat().map_err(WalkError::Interrupted)?;
	if !should_use_parallel_file_candidate_walk(options) {
		return run_file_candidate_serial(request, options, sink, heartbeat);
	}

	options.cache = false;
	let Some(root_entry) = root_entry(&request.root, options.detail, options.follow_links)? else {
		return Ok(WalkStatus::Complete);
	};
	let context = ParallelWalkContext {
		root: request.root.clone(),
		options,
		filter: request.filter.clone(),
		matcher: FastIgnore::new(options.use_gitignore),
	};
	let root_ignore = context.matcher.root_state(&context.root);
	let shared = ParallelWalkShared::new(sink, heartbeat);

	if root_entry.file_type == FileType::File && options.min_depth == 0 {
		emit_parallel_root_file(&context, &shared, &root_entry);
	}
	if root_entry.file_type == FileType::Dir && options.max_depth > 0 && !shared.should_stop() {
		let root_dir = context.root.clone();
		cache::with_walk_pool(|| {
			rayon::scope(|scope| {
				scope.spawn(|scope| {
					walk_parallel_dir(
						scope,
						&context,
						&shared,
						root_dir,
						String::new(),
						0,
						root_ignore,
						false,
					);
				});
			});
		});
	}

	if let Some(error) = shared.take_error() {
		Err(WalkError::Interrupted(error))
	} else if shared.should_stop() {
		Ok(WalkStatus::Stopped)
	} else {
		Ok(WalkStatus::Complete)
	}
}

fn run_file_candidate_serial<E, S, H>(
	request: &WalkRequest,
	mut options: WalkOptions,
	sink: &S,
	heartbeat: &H,
) -> std::result::Result<WalkStatus, WalkError<E>>
where
	S: Fn(&FileCandidate) -> std::result::Result<ParallelWalkControl, E> + Sync,
	H: Fn() -> std::result::Result<(), E> + Sync,
{
	options.cache = false;
	options.order = WalkOrder::Unordered;
	options.contents_first = false;
	options.emit_root = true;
	options.directory_errors = DirectoryErrorMode::Visit;
	let mut visitor = SerialCandidateVisitor { filter: &request.filter, sink };
	walk_entries(&request.root, options, &mut visitor, heartbeat)
}

fn emit_parallel_root_file<E, S, H>(
	context: &ParallelWalkContext,
	shared: &ParallelWalkShared<'_, E, S, H>,
	root_entry: &RootEntry,
) where
	E: Send,
	S: Fn(&FileCandidate) -> std::result::Result<ParallelWalkControl, E> + Sync,
	H: Fn() -> std::result::Result<(), E> + Sync,
{
	let meta = EntryMeta {
		root:          &context.root,
		absolute_path: Cow::Borrowed(context.root.as_path()),
		relative_path: "",
		file_type:     FileType::File,
		mtime:         root_entry.mtime,
		size:          root_entry.size,
		depth:         0,
	};
	match context.filter.stream_decision(&meta) {
		WalkDecision::Include => {
			let candidate = FileCandidate {
				path:     context.root.clone(),
				relative: String::new(),
				mtime:    root_entry.mtime,
				size:     root_entry.size,
			};
			let _ = emit_parallel_candidate(shared, &candidate);
		},
		WalkDecision::Stop => shared.request_stop(),
		WalkDecision::Skip | WalkDecision::SkipDescend => {},
	}
}

fn take_parallel_scratch() -> DirScratch {
	let mut scratch = PARALLEL_SCRATCH_POOL
		.with(|pool| pool.borrow_mut().pop())
		.unwrap_or_default();
	scratch.clear_listing();
	scratch
}

fn recycle_parallel_scratch(mut scratch: DirScratch) {
	scratch.clear_listing();
	PARALLEL_SCRATCH_POOL.with(|pool| pool.borrow_mut().push(scratch));
}

fn parallel_heartbeat<E, S, H>(shared: &ParallelWalkShared<'_, E, S, H>) -> bool
where
	E: Send,
	H: Fn() -> std::result::Result<(), E> + Sync,
{
	if shared.should_stop() {
		return false;
	}
	let should_call = PARALLEL_HEARTBEAT_COUNTER.with(|counter| {
		let visited = counter.get();
		if visited == 0 || visited >= HEARTBEAT_INTERVAL {
			counter.set(1);
			true
		} else {
			counter.set(visited + 1);
			false
		}
	});
	if !should_call {
		return true;
	}
	match (shared.heartbeat)() {
		Ok(()) => true,
		Err(error) => {
			shared.record_error(error);
			false
		},
	}
}

fn emit_parallel_candidate<E, S, H>(
	shared: &ParallelWalkShared<'_, E, S, H>,
	candidate: &FileCandidate,
) -> bool
where
	E: Send,
	S: Fn(&FileCandidate) -> std::result::Result<ParallelWalkControl, E> + Sync,
{
	match (shared.sink)(candidate) {
		Ok(ParallelWalkControl::Continue) => true,
		Ok(ParallelWalkControl::Stop) => {
			shared.request_stop();
			false
		},
		Err(error) => {
			shared.record_error(error);
			false
		},
	}
}

fn walk_parallel_dir<'scope, E, S, H>(
	scope: &rayon::Scope<'scope>,
	context: &'scope ParallelWalkContext,
	shared: &'scope ParallelWalkShared<'_, E, S, H>,
	dir: PathBuf,
	relative_dir: String,
	depth: usize,
	ignore_state: Arc<IgnoreState>,
	derive_ignore_from_entries: bool,
) where
	E: Send + 'scope,
	S: Fn(&FileCandidate) -> std::result::Result<ParallelWalkControl, E> + Sync + 'scope,
	H: Fn() -> std::result::Result<(), E> + Sync + 'scope,
{
	if shared.should_stop() {
		return;
	}
	let mut scratch = take_parallel_scratch();
	let ignore_entries = match collect_directory_entries(
		&dir,
		context.options.detail,
		&mut scratch,
		&context.matcher,
		derive_ignore_from_entries,
	) {
		Ok(ignore_entries) => ignore_entries,
		Err(ReadDirError::Io(_) | ReadDirError::Walk(WalkError::InvalidData { .. })) => {
			recycle_parallel_scratch(scratch);
			return;
		},
		Err(ReadDirError::Walk(WalkError::Interrupted(error))) => {
			shared.record_error(error);
			recycle_parallel_scratch(scratch);
			return;
		},
	};
	let dir_ignore = context.matcher.state_from_entries(
		&ignore_state,
		&dir,
		ignore_entries,
		derive_ignore_from_entries,
	);
	let mut absolute = dir;
	let mut relative = relative_dir;

	for index in 0..scratch.entries.len() {
		if !parallel_heartbeat(shared) {
			break;
		}
		let entry = &scratch.entries[index];
		let name = scratch.name(entry);
		if is_dot_entry(name) {
			continue;
		}
		if !context.options.include_hidden && is_hidden_name(name) {
			continue;
		}
		if (context.options.skip_git && is_git_name(name))
			|| (context.options.skip_node_modules && is_node_modules_name(name))
		{
			continue;
		}

		let name_str = entry_name(name);
		if name_str.is_empty() {
			continue;
		}
		let next_depth = depth + 1;
		if next_depth > context.options.max_depth {
			continue;
		}

		let relative_len = relative.len();
		absolute.push(name);
		push_relative_name(&mut relative, &name_str);
		let is_dir = entry.file_type == FileType::Dir;
		if !context.matcher.is_ignored(&dir_ignore, &absolute, is_dir) {
			let decision = {
				let meta = EntryMeta {
					root:          &context.root,
					absolute_path: Cow::Borrowed(absolute.as_path()),
					relative_path: &relative,
					file_type:     entry.file_type,
					mtime:         entry.mtime,
					size:          entry.size,
					depth:         next_depth,
				};
				context.filter.stream_decision(&meta)
			};
			match decision {
				WalkDecision::Include => {
					if entry.file_type == FileType::File && next_depth >= context.options.min_depth {
						let candidate = FileCandidate {
							path:     absolute.clone(),
							relative: relative.clone(),
							mtime:    entry.mtime,
							size:     entry.size,
						};
						if !emit_parallel_candidate(shared, &candidate) {
							absolute.pop();
							relative.truncate(relative_len);
							break;
						}
					}
					if is_dir && next_depth < context.options.max_depth && !shared.should_stop() {
						let child_dir = absolute.clone();
						let child_relative = relative.clone();
						let child_ignore = Arc::clone(&dir_ignore);
						scope.spawn(move |scope| {
							walk_parallel_dir(
								scope,
								context,
								shared,
								child_dir,
								child_relative,
								next_depth,
								child_ignore,
								true,
							);
						});
					}
				},
				WalkDecision::Skip => {
					if is_dir && next_depth < context.options.max_depth && !shared.should_stop() {
						let child_dir = absolute.clone();
						let child_relative = relative.clone();
						let child_ignore = Arc::clone(&dir_ignore);
						scope.spawn(move |scope| {
							walk_parallel_dir(
								scope,
								context,
								shared,
								child_dir,
								child_relative,
								next_depth,
								child_ignore,
								true,
							);
						});
					}
				},
				WalkDecision::SkipDescend => {},
				WalkDecision::Stop => {
					shared.request_stop();
					absolute.pop();
					relative.truncate(relative_len);
					break;
				},
			}
		}
		absolute.pop();
		relative.truncate(relative_len);
	}
	recycle_parallel_scratch(scratch);
}

/// Visitor decision for streaming traversal.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WalkControl {
	/// Continue traversing remaining entries.
	Continue,
	/// Skip descending into this directory entry.
	SkipDescend,
	/// Stop traversal immediately.
	Quit,
}

/// Status returned by native traversal.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WalkStatus {
	/// Traversal visited every reachable entry.
	Complete,
	/// The visitor stopped traversal early.
	Stopped,
}

/// Control returned by unordered parallel file-candidate sinks.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ParallelWalkControl {
	/// Continue walking and delivering candidates.
	Continue,
	/// Stop all workers as promptly as possible.
	Stop,
}

/// Owned entry returned by [`collect_entries`].
#[derive(Clone, Debug, PartialEq)]
pub struct CollectedEntry {
	/// Relative path from the root, using `/` separators.
	pub path:      String,
	/// Filesystem entry kind.
	pub file_type: FileType,
	/// Modification time in milliseconds since the Unix epoch, when requested.
	pub mtime:     Option<f64>,
	/// File size in bytes for regular files, when requested.
	pub size:      Option<f64>,
}

impl CollectedEntry {
	/// Return this entry's absolute path under `root`.
	pub fn absolute_path(&self, root: &Path) -> PathBuf {
		if self.path.is_empty() {
			root.to_path_buf()
		} else {
			root.join(&self.path)
		}
	}

	/// Return this entry's depth below the traversal root.
	pub fn depth(&self) -> usize {
		if self.path.is_empty() {
			0
		} else {
			self
				.path
				.split('/')
				.filter(|component| !component.is_empty())
				.count()
		}
	}

	/// Return whether this entry is a regular file.
	pub const fn is_file(&self) -> bool {
		matches!(self.file_type, FileType::File)
	}

	/// Return whether this entry is a directory.
	pub const fn is_dir(&self) -> bool {
		matches!(self.file_type, FileType::Dir)
	}
}

/// Return whether `parent` is a walk-relative ancestor of `child`.
///
/// Both paths use the walker's normalized `/` separator. The root-relative
/// empty path is an ancestor of every non-root entry.
pub fn is_relative_ancestor(parent: &str, child: &str) -> bool {
	if parent == child {
		return false;
	}
	if parent.is_empty() {
		return !child.is_empty();
	}
	child
		.strip_prefix(parent)
		.is_some_and(|suffix| suffix.starts_with('/'))
}

/// Compare normalized walk-relative paths in depth-first,
/// contents-before-parent order.
pub fn compare_depth_first_paths(left: &str, right: &str) -> Ordering {
	if left == right {
		return Ordering::Equal;
	}
	if is_relative_ancestor(left, right) {
		return Ordering::Greater;
	}
	if is_relative_ancestor(right, left) {
		return Ordering::Less;
	}
	left.cmp(right)
}

/// Sort collected entries in depth-first, contents-before-parent path order.
pub fn sort_collected_depth_first(entries: &mut [CollectedEntry]) {
	entries.sort_unstable_by(|left, right| compare_depth_first_paths(&left.path, &right.path));
}

/// Return whether `relative` is below any pruned normalized directory path.
pub fn is_under_pruned_relative_dir(relative: &str, pruned_dirs: &[String]) -> bool {
	pruned_dirs
		.iter()
		.any(|dir| is_relative_ancestor(dir, relative))
}

/// Return the root device id used by same-filesystem traversal filters.
///
/// Non-Unix platforms return `None`, making same-filesystem filtering a no-op.
#[cfg(unix)]
pub fn root_device_id(path: &Path, follow_links: FollowLinks) -> Option<u64> {
	use std::os::unix::fs::MetadataExt;

	metadata_for_follow_policy(path, follow_links.follow_at_depth(0))
		.ok()
		.map(|metadata| metadata.dev())
}

/// Return the root device id used by same-filesystem traversal filters.
///
/// Non-Unix platforms return `None`, making same-filesystem filtering a no-op.
#[cfg(not(unix))]
pub const fn root_device_id(_path: &Path, _follow_links: FollowLinks) -> Option<u64> {
	None
}

/// Return whether `path` is on the root filesystem represented by
/// `root_device`.
///
/// When `root_device` is `None`, this returns true. On non-Unix platforms this
/// is always true, matching the existing no-op same-filesystem behavior there.
#[cfg(unix)]
pub fn is_path_on_root_file_system(
	path: &Path,
	depth: usize,
	follow_links: FollowLinks,
	root_device: Option<u64>,
) -> bool {
	use std::os::unix::fs::MetadataExt;

	let Some(root_device) = root_device else {
		return true;
	};
	metadata_for_follow_policy(path, follow_links.follow_at_depth(depth))
		.is_ok_and(|metadata| metadata.dev() == root_device)
}

/// Return whether `path` is on the root filesystem represented by
/// `root_device`.
///
/// When `root_device` is `None`, this returns true. On non-Unix platforms this
/// is always true, matching the existing no-op same-filesystem behavior there.
#[cfg(not(unix))]
pub const fn is_path_on_root_file_system(
	_path: &Path,
	_depth: usize,
	_follow_links: FollowLinks,
	_root_device: Option<u64>,
) -> bool {
	true
}

#[cfg(unix)]
fn is_effective_path_on_root_file_system(
	path: &Path,
	depth: usize,
	follow_links: FollowLinks,
	root_device: Option<u64>,
	followed_metadata: Option<&std::fs::Metadata>,
) -> bool {
	use std::os::unix::fs::MetadataExt;

	let Some(root_device) = root_device else {
		return true;
	};
	if let Some(metadata) = followed_metadata {
		return metadata.dev() == root_device;
	}
	metadata_for_follow_policy(path, follow_links.follow_at_depth(depth))
		.is_ok_and(|metadata| metadata.dev() == root_device)
}

#[cfg(not(unix))]
const fn is_effective_path_on_root_file_system(
	_path: &Path,
	_depth: usize,
	_follow_links: FollowLinks,
	_root_device: Option<u64>,
	_followed_metadata: Option<&std::fs::Metadata>,
) -> bool {
	true
}

#[cfg(unix)]
fn metadata_for_follow_policy(path: &Path, follow: bool) -> io::Result<std::fs::Metadata> {
	if follow {
		std::fs::metadata(path)
	} else {
		std::fs::symlink_metadata(path)
	}
}

/// Owned entries returned by [`collect_entries`] plus cache metadata.
#[derive(Clone, Debug, PartialEq)]
pub struct CollectedEntries {
	/// Entries collected with the requested traversal contract.
	pub entries:      Vec<CollectedEntry>,
	/// Age of the cache entry in milliseconds; zero means freshly scanned.
	pub cache_age_ms: u64,
}

/// Borrowed entry passed to [`EntryVisitor`].
pub struct Entry<'a> {
	/// Absolute filesystem path for this entry.
	pub path:      &'a Path,
	/// Relative path from the root, using `/` separators.
	pub relative:  &'a str,
	/// Basename as returned by the platform directory API.
	pub name:      &'a OsStr,
	/// Filesystem entry kind.
	pub file_type: FileType,
	/// Modification time in milliseconds since the Unix epoch, when requested.
	pub mtime:     Option<f64>,
	/// File size in bytes for regular files, when requested.
	pub size:      Option<f64>,
	/// Depth below the traversal root. Direct children have depth 1.
	pub depth:     usize,
}

/// Directory-open error delivered to visitors when configured by
/// [`WalkOptions::directory_errors`].
pub struct DirectoryError<'a> {
	/// Directory path that could not be read.
	pub path:  &'a Path,
	/// Underlying platform I/O error.
	pub error: &'a io::Error,
}

/// Pre-descend decision made before a directory's children are traversed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PreDescendDecision {
	/// Whether this entry should be emitted in the requested visit order.
	pub emit:    bool,
	/// Whether this directory's descendants should be traversed.
	pub descend: bool,
	/// Whether traversal should stop immediately.
	pub stop:    bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum DirectoryIdentity {
	#[cfg(unix)]
	Unix { dev: u64, ino: u64 },
	#[cfg(not(unix))]
	Generic(std::path::PathBuf),
}

#[derive(Default)]
struct SymlinkAncestorStack {
	stack: Vec<DirectoryIdentity>,
}

impl SymlinkAncestorStack {
	fn contains(&self, identity: &DirectoryIdentity) -> bool {
		self.stack.contains(identity)
	}

	fn push(&mut self, identity: DirectoryIdentity) {
		self.stack.push(identity);
	}

	fn pop(&mut self) {
		self.stack.pop();
	}
}

fn directory_identity(path: &Path) -> io::Result<DirectoryIdentity> {
	#[cfg(unix)]
	{
		use std::os::unix::fs::MetadataExt;
		let metadata = std::fs::metadata(path)?;
		Ok(DirectoryIdentity::Unix { dev: metadata.dev(), ino: metadata.ino() })
	}
	#[cfg(not(unix))]
	{
		let canonical = std::fs::canonicalize(path)?;
		Ok(DirectoryIdentity::Generic(canonical))
	}
}

/// Consumer hook invoked for every accepted entry.
pub trait EntryVisitor {
	/// Error type used by visitor and heartbeat callbacks.
	type Error;

	/// Visit one filesystem entry and choose how traversal continues.
	fn visit(&mut self, entry: Entry<'_>) -> std::result::Result<WalkControl, Self::Error>;

	/// Handle a directory-open error and choose whether traversal continues.
	fn visit_directory_error(
		&mut self,
		_error: DirectoryError<'_>,
	) -> std::result::Result<WalkControl, Self::Error> {
		Ok(WalkControl::Continue)
	}

	/// Optional hook for making pre-descend traversal decisions.
	fn decide_pre_descend(
		&mut self,
		_meta: &EntryMeta<'_>,
	) -> std::result::Result<PreDescendDecision, Self::Error> {
		Ok(PreDescendDecision { emit: true, descend: true, stop: false })
	}

	/// Visit an entry whose filter/predicate decisions have already been made.
	fn visit_pre_decided(
		&mut self,
		entry: Entry<'_>,
	) -> std::result::Result<WalkControl, Self::Error> {
		self.visit(entry)
	}
}
struct RequestVisitor<'a, V, P> {
	root:      &'a Path,
	filter:    &'a WalkFilter,
	limit:     Option<usize>,
	emitted:   usize,
	visitor:   &'a mut V,
	predicate: P,
}

impl<V, P> EntryVisitor for RequestVisitor<'_, V, P>
where
	V: EntryVisitor,
	P: WalkPredicate,
{
	type Error = V::Error;

	fn visit(&mut self, entry: Entry<'_>) -> std::result::Result<WalkControl, Self::Error> {
		if self.limit.is_some_and(|limit| self.emitted >= limit) {
			return Ok(WalkControl::Quit);
		}
		let meta = EntryMeta {
			root:          self.root,
			absolute_path: Cow::Borrowed(entry.path),
			relative_path: entry.relative,
			file_type:     entry.file_type,
			mtime:         entry.mtime,
			size:          entry.size,
			depth:         entry.depth,
		};
		match self.filter.stream_decision(&meta) {
			WalkDecision::Include => {},
			WalkDecision::Skip => return Ok(WalkControl::Continue),
			WalkDecision::SkipDescend => return Ok(WalkControl::SkipDescend),
			WalkDecision::Stop => return Ok(WalkControl::Quit),
		}
		match self.predicate.decide(&meta) {
			WalkDecision::Include => {},
			WalkDecision::Skip => return Ok(WalkControl::Continue),
			WalkDecision::SkipDescend => return Ok(WalkControl::SkipDescend),
			WalkDecision::Stop => return Ok(WalkControl::Quit),
		}
		self.emitted += 1;
		self.visitor.visit(entry)
	}

	fn visit_directory_error(
		&mut self,
		error: DirectoryError<'_>,
	) -> std::result::Result<WalkControl, Self::Error> {
		self.visitor.visit_directory_error(error)
	}

	fn visit_pre_decided(
		&mut self,
		entry: Entry<'_>,
	) -> std::result::Result<WalkControl, Self::Error> {
		if self.limit.is_some_and(|limit| self.emitted >= limit) {
			return Ok(WalkControl::Quit);
		}
		self.emitted += 1;
		self.visitor.visit(entry)
	}

	fn decide_pre_descend(
		&mut self,
		meta: &EntryMeta<'_>,
	) -> std::result::Result<PreDescendDecision, Self::Error> {
		let is_dir = meta.file_type == FileType::Dir;

		match self.filter.stream_decision(meta) {
			WalkDecision::Include => {},
			WalkDecision::Skip => {
				return Ok(PreDescendDecision { emit: false, descend: is_dir, stop: false });
			},
			WalkDecision::SkipDescend => {
				return Ok(PreDescendDecision { emit: false, descend: false, stop: false });
			},
			WalkDecision::Stop => {
				return Ok(PreDescendDecision { emit: false, descend: false, stop: true });
			},
		}

		match self.predicate.decide(meta) {
			WalkDecision::Include => {
				Ok(PreDescendDecision { emit: true, descend: is_dir, stop: false })
			},
			WalkDecision::Skip => {
				Ok(PreDescendDecision { emit: false, descend: is_dir, stop: false })
			},
			WalkDecision::SkipDescend => {
				Ok(PreDescendDecision { emit: false, descend: false, stop: false })
			},
			WalkDecision::Stop => {
				Ok(PreDescendDecision { emit: false, descend: false, stop: true })
			},
		}
	}
}
struct ClosureEntryVisitor<'a, V, D> {
	root:            &'a Path,
	visit:           V,
	directory_error: D,
}

impl<E, V, D> EntryVisitor for ClosureEntryVisitor<'_, V, D>
where
	V: for<'entry> FnMut(EntryMeta<'entry>) -> std::result::Result<WalkDecision, E>,
	D: for<'error> FnMut(DirectoryError<'error>) -> std::result::Result<WalkDecision, E>,
{
	type Error = E;

	fn visit(&mut self, entry: Entry<'_>) -> std::result::Result<WalkControl, Self::Error> {
		let meta = EntryMeta {
			root:          self.root,
			absolute_path: Cow::Borrowed(entry.path),
			relative_path: entry.relative,
			file_type:     entry.file_type,
			mtime:         entry.mtime,
			size:          entry.size,
			depth:         entry.depth,
		};
		(self.visit)(meta).map(walk_decision_to_control)
	}

	fn visit_directory_error(
		&mut self,
		error: DirectoryError<'_>,
	) -> std::result::Result<WalkControl, Self::Error> {
		(self.directory_error)(error).map(walk_decision_to_control)
	}
}

const fn walk_decision_to_control(decision: WalkDecision) -> WalkControl {
	match decision {
		WalkDecision::Include | WalkDecision::Skip => WalkControl::Continue,
		WalkDecision::SkipDescend => WalkControl::SkipDescend,
		WalkDecision::Stop => WalkControl::Quit,
	}
}

/// Error returned by native traversal.
#[derive(Debug)]
pub enum WalkError<E> {
	/// A caller-supplied heartbeat or visitor returned an error.
	Interrupted(E),
	/// A platform directory API returned malformed data or an unskippable error.
	InvalidData {
		/// Directory whose scan failed.
		path:    PathBuf,
		/// Human-readable failure detail.
		message: String,
	},
}

impl<E: fmt::Display> fmt::Display for WalkError<E> {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Interrupted(err) => write!(f, "native directory scan interrupted: {err}"),
			Self::InvalidData { path, message } => {
				write!(f, "native directory scan failed for {}: {message}", path.display())
			},
		}
	}
}

impl<E> std::error::Error for WalkError<E>
where
	E: std::error::Error + 'static,
{
	fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
		match self {
			Self::Interrupted(err) => Some(err),
			Self::InvalidData { .. } => None,
		}
	}
}

struct CollectVisitor<E> {
	entries: Vec<CollectedEntry>,
	_error:  std::marker::PhantomData<fn() -> E>,
}

impl<E> CollectVisitor<E> {
	const fn new() -> Self {
		Self { entries: Vec::new(), _error: std::marker::PhantomData }
	}
}

impl<E> EntryVisitor for CollectVisitor<E> {
	type Error = E;

	fn visit(&mut self, entry: Entry<'_>) -> std::result::Result<WalkControl, Self::Error> {
		self.entries.push(CollectedEntry {
			path:      entry.relative.to_string(),
			file_type: entry.file_type,
			mtime:     entry.mtime,
			size:      entry.size,
		});
		Ok(WalkControl::Continue)
	}
}

#[allow(clippy::missing_const_for_fn, reason = "calls non-const root_device_id on unix")]
fn root_device_for_options(root: &Path, options: WalkOptions) -> Option<u64> {
	if options.same_file_system {
		root_device_id(root, options.follow_links)
	} else {
		None
	}
}

struct RawDirEntry<'a> {
	name:      Cow<'a, OsStr>,
	file_type: FileType,
	mtime:     Option<f64>,
	size:      Option<f64>,
}

#[cfg(unix)]
struct DirEntryRecord {
	name_start: usize,
	name_len:   usize,
	file_type:  FileType,
	mtime:      Option<f64>,
	size:       Option<f64>,
}

#[cfg(not(unix))]
struct DirEntryRecord {
	name:      OsString,
	file_type: FileType,
	mtime:     Option<f64>,
	size:      Option<f64>,
}

#[derive(Default)]
struct DirScratch {
	entries:     Vec<DirEntryRecord>,
	#[cfg(unix)]
	name_bytes:  Vec<u8>,
	read_buffer: Vec<u8>,
}

impl DirScratch {
	fn clear_listing(&mut self) {
		self.entries.clear();
		#[cfg(unix)]
		self.name_bytes.clear();
	}

	#[cfg(unix)]
	fn push(&mut self, entry: RawDirEntry<'_>) {
		let name_os: &OsStr = entry.name.as_ref();
		let name = name_os.as_bytes();
		let name_start = self.name_bytes.len();
		self.name_bytes.extend_from_slice(name);
		self.entries.push(DirEntryRecord {
			name_start,
			name_len: name.len(),
			file_type: entry.file_type,
			mtime: entry.mtime,
			size: entry.size,
		});
	}

	#[cfg(not(unix))]
	fn push(&mut self, entry: RawDirEntry<'_>) {
		self.entries.push(DirEntryRecord {
			name:      entry.name.into_owned(),
			file_type: entry.file_type,
			mtime:     entry.mtime,
			size:      entry.size,
		});
	}

	#[cfg(unix)]
	fn sort_by_name(&mut self) {
		let names = &self.name_bytes;
		self.entries.sort_unstable_by(|left, right| {
			let left_name = &names[left.name_start..left.name_start + left.name_len];
			let right_name = &names[right.name_start..right.name_start + right.name_len];
			left_name.cmp(right_name)
		});
	}

	#[cfg(not(unix))]
	fn sort_by_name(&mut self) {
		self
			.entries
			.sort_unstable_by(|left, right| left.name.cmp(&right.name));
	}

	#[cfg(unix)]
	fn name<'a>(&'a self, entry: &DirEntryRecord) -> &'a OsStr {
		OsStr::from_bytes(&self.name_bytes[entry.name_start..entry.name_start + entry.name_len])
	}

	#[cfg(not(unix))]
	#[allow(clippy::unused_self, reason = "matches unix signature where self is used")]
	fn name<'a>(&'a self, entry: &'a DirEntryRecord) -> &'a OsStr {
		&entry.name
	}
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReadDirControl {
	Continue,
	Stop,
}

enum ReadDirError<E> {
	Io(io::Error),
	Walk(WalkError<E>),
}

impl<E> From<io::Error> for ReadDirError<E> {
	fn from(err: io::Error) -> Self {
		Self::Io(err)
	}
}

fn file_type_from_metadata(metadata: &std::fs::Metadata) -> Option<FileType> {
	let file_type = metadata.file_type();
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

struct RootEntry {
	file_type: FileType,
	mtime:     Option<f64>,
	size:      Option<f64>,
}

fn root_entry<E>(
	root: &Path,
	detail: WalkDetail,
	follow_links: FollowLinks,
) -> std::result::Result<Option<RootEntry>, WalkError<E>> {
	let metadata = if follow_links.follow_at_depth(0) {
		match std::fs::metadata(root) {
			Ok(metadata) => metadata,
			Err(err) if is_missing_metadata_error(&err) => {
				std::fs::symlink_metadata(root).map_err(|err| WalkError::InvalidData {
					path:    root.to_path_buf(),
					message: err.to_string(),
				})?
			},
			Err(err) => {
				return Err(WalkError::InvalidData {
					path:    root.to_path_buf(),
					message: err.to_string(),
				});
			},
		}
	} else {
		std::fs::symlink_metadata(root).map_err(|err| WalkError::InvalidData {
			path:    root.to_path_buf(),
			message: err.to_string(),
		})?
	};
	Ok(entry_from_metadata(&metadata, detail))
}

fn entry_from_metadata(metadata: &std::fs::Metadata, detail: WalkDetail) -> Option<RootEntry> {
	let file_type = file_type_from_metadata(metadata)?;
	let size = if detail == WalkDetail::Full && file_type == FileType::File {
		Some(metadata.len() as f64)
	} else {
		None
	};
	let mtime = if detail == WalkDetail::Full {
		metadata
			.modified()
			.ok()
			.and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
			.map(|duration| duration.as_millis() as f64)
	} else {
		None
	};
	Some(RootEntry { file_type, mtime, size })
}

fn is_missing_metadata_error(err: &io::Error) -> bool {
	matches!(err.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory)
}

/// Scans entries using the shared cache when [`WalkOptions::cache`] is true.
///
/// The native scanner implements every [`WalkOptions`] traversal contract.
pub fn collect_entries<E, H>(
	root: &Path,
	options: WalkOptions,
	heartbeat: H,
) -> std::result::Result<CollectedEntries, WalkError<String>>
where
	H: Fn() -> std::result::Result<(), E> + Sync,
	E: fmt::Display,
{
	cache::collect_entries(root, options, heartbeat)
}

fn collect_entries_native<E, H>(
	root: &Path,
	options: WalkOptions,
	heartbeat: H,
) -> std::result::Result<CollectedEntries, WalkError<E>>
where
	H: FnMut() -> std::result::Result<(), E>,
{
	let mut collector = CollectVisitor::new();
	let _status = walk_entries(root, options, &mut collector, heartbeat)?;
	if options.contents_first {
		sort_collected_depth_first(&mut collector.entries);
	} else {
		collector
			.entries
			.sort_unstable_by(|a, b| a.path.cmp(&b.path));
	}
	Ok(CollectedEntries { entries: collector.entries, cache_age_ms: 0 })
}

/// Scans entries without cancellation using platform syscalls when supported.
pub fn collect_entries_without_heartbeat(
	root: &Path,
	options: WalkOptions,
) -> std::result::Result<CollectedEntries, WalkError<String>> {
	collect_entries(root, options, || Ok::<(), Infallible>(()))
}

/// Streams entries using the native scanner for every [`WalkOptions`]
/// traversal contract.
pub fn walk_entries<V, H>(
	root: &Path,
	options: WalkOptions,
	visitor: &mut V,
	heartbeat: H,
) -> std::result::Result<WalkStatus, WalkError<V::Error>>
where
	V: EntryVisitor,
	H: FnMut() -> std::result::Result<(), V::Error>,
{
	if options.min_depth > options.max_depth {
		return Ok(WalkStatus::Complete);
	}

	let root_device = root_device_for_options(root, options);
	let matcher = FastIgnore::new(options.use_gitignore);
	let root_ignore = matcher.root_state(root);

	let mut context = WalkContext {
		root_path: root,
		options,
		root_device,
		symlink_ancestors: SymlinkAncestorStack::default(),
		matcher,
		absolute_path: root.to_path_buf(),
		relative_path: String::new(),
		scratch_pool: Vec::new(),
		visited: 0,
		heartbeat,
	};

	context.walk_root(root, &root_ignore, visitor)
}

struct WalkContext<'a, H> {
	root_path:         &'a Path,
	options:           WalkOptions,
	root_device:       Option<u64>,
	symlink_ancestors: SymlinkAncestorStack,
	matcher:           FastIgnore,
	absolute_path:     PathBuf,
	relative_path:     String,
	scratch_pool:      Vec<DirScratch>,
	visited:           usize,
	heartbeat:         H,
}

impl<H> WalkContext<'_, H> {
	fn walk_root<V>(
		&mut self,
		root: &Path,
		root_ignore: &Arc<IgnoreState>,
		visitor: &mut V,
	) -> std::result::Result<WalkStatus, WalkError<V::Error>>
	where
		V: EntryVisitor,
		H: FnMut() -> std::result::Result<(), V::Error>,
	{
		let root_entry = root_entry(root, self.options.detail, self.options.follow_links)?;
		let Some(root_entry) = root_entry else {
			return Ok(WalkStatus::Complete);
		};

		// Seed the ancestor stack only when descendant symlink traversal can loop.
		if self.options.follow_links == FollowLinks::Always
			&& let Ok(id) = directory_identity(root)
		{
			self.symlink_ancestors.push(id);
		}

		let meta = EntryMeta {
			root,
			absolute_path: Cow::Borrowed(root),
			relative_path: "",
			file_type: root_entry.file_type,
			mtime: root_entry.mtime,
			size: root_entry.size,
			depth: 0,
		};

		let decision = visitor
			.decide_pre_descend(&meta)
			.map_err(WalkError::Interrupted)?;
		if decision.stop {
			return Ok(WalkStatus::Stopped);
		}

		if !self.options.contents_first
			&& self.options.emit_root
			&& self.options.min_depth == 0
			&& decision.emit
		{
			let name = root.file_name().unwrap_or(root.as_os_str());
			match visitor
				.visit_pre_decided(Entry {
					path: root,
					relative: "",
					name,
					file_type: root_entry.file_type,
					mtime: root_entry.mtime,
					size: root_entry.size,
					depth: 0,
				})
				.map_err(WalkError::Interrupted)?
			{
				WalkControl::Quit => return Ok(WalkStatus::Stopped),
				WalkControl::SkipDescend => return Ok(WalkStatus::Complete),
				WalkControl::Continue => {},
			}
		}

		let stopped =
			if root_entry.file_type == FileType::Dir && self.options.max_depth > 0 && decision.descend
			{
				self.walk_dir(0, root_ignore, false, visitor)?
			} else {
				false
			};

		if stopped {
			return Ok(WalkStatus::Stopped);
		}

		if self.options.contents_first
			&& self.options.emit_root
			&& self.options.min_depth == 0
			&& decision.emit
		{
			let name = root.file_name().unwrap_or(root.as_os_str());
			match visitor
				.visit_pre_decided(Entry {
					path: root,
					relative: "",
					name,
					file_type: root_entry.file_type,
					mtime: root_entry.mtime,
					size: root_entry.size,
					depth: 0,
				})
				.map_err(WalkError::Interrupted)?
			{
				WalkControl::Quit => return Ok(WalkStatus::Stopped),
				WalkControl::SkipDescend | WalkControl::Continue => {},
			}
		}

		Ok(WalkStatus::Complete)
	}

	fn take_scratch(&mut self) -> DirScratch {
		let mut scratch = self.scratch_pool.pop().unwrap_or_default();
		scratch.clear_listing();
		scratch
	}

	fn recycle_scratch(&mut self, mut scratch: DirScratch) {
		scratch.clear_listing();
		self.scratch_pool.push(scratch);
	}

	fn push_entry_path(&mut self, name: &OsStr, name_str: &str) -> usize {
		let relative_len = self.relative_path.len();
		self.absolute_path.push(name);
		push_relative_name(&mut self.relative_path, name_str);
		relative_len
	}

	fn pop_entry_path(&mut self, relative_len: usize) {
		self.relative_path.truncate(relative_len);
		self.absolute_path.pop();
	}

	fn walk_dir<V>(
		&mut self,
		depth: usize,
		ignore_state: &Arc<IgnoreState>,
		derive_ignore_from_entries: bool,
		visitor: &mut V,
	) -> std::result::Result<bool, WalkError<V::Error>>
	where
		V: EntryVisitor,
		H: FnMut() -> std::result::Result<(), V::Error>,
	{
		if self.options.follow_links == FollowLinks::Always
			&& let Ok(identity) = directory_identity(&self.absolute_path)
		{
			self.symlink_ancestors.push(identity);
			let result = self.walk_dir_inner(depth, ignore_state, derive_ignore_from_entries, visitor);
			self.symlink_ancestors.pop();
			return result;
		}

		self.walk_dir_inner(depth, ignore_state, derive_ignore_from_entries, visitor)
	}

	fn walk_dir_inner<V>(
		&mut self,
		depth: usize,
		ignore_state: &Arc<IgnoreState>,
		derive_ignore_from_entries: bool,
		visitor: &mut V,
	) -> std::result::Result<bool, WalkError<V::Error>>
	where
		V: EntryVisitor,
		H: FnMut() -> std::result::Result<(), V::Error>,
	{
		let mut scratch = self.take_scratch();
		let ignore_entries = match collect_directory_entries(
			&self.absolute_path,
			self.options.detail,
			&mut scratch,
			&self.matcher,
			derive_ignore_from_entries,
		) {
			Ok(ignore_entries) => ignore_entries,
			Err(err) => {
				let dir = self.absolute_path.clone();
				self.recycle_scratch(scratch);
				return handle_read_dir_error(&dir, err, self.options, visitor);
			},
		};
		if self.options.order == WalkOrder::Path {
			scratch.sort_by_name();
		}
		let dir_ignore = self.matcher.state_from_entries(
			ignore_state,
			&self.absolute_path,
			ignore_entries,
			derive_ignore_from_entries,
		);

		for index in 0..scratch.entries.len() {
			if self.visited == 0 || self.visited >= HEARTBEAT_INTERVAL {
				self.visited = 0;
				(self.heartbeat)().map_err(WalkError::Interrupted)?;
			}
			self.visited += 1;

			let entry = &scratch.entries[index];
			let name = scratch.name(entry);
			if is_dot_entry(name) {
				continue;
			}
			if !self.options.include_hidden && is_hidden_name(name) {
				continue;
			}
			if (self.options.skip_git && is_git_name(name))
				|| (self.options.skip_node_modules && is_node_modules_name(name))
			{
				continue;
			}

			let name_str = entry_name(name);
			if name_str.is_empty() {
				continue;
			}
			let next_depth = depth + 1;
			if next_depth > self.options.max_depth {
				continue;
			}

			let relative_len = self.push_entry_path(name, &name_str);
			let entry_result = self.walk_current_entry(
				name,
				entry.file_type,
				entry.mtime,
				entry.size,
				next_depth,
				&dir_ignore,
				visitor,
			);
			self.pop_entry_path(relative_len);
			if entry_result? {
				self.recycle_scratch(scratch);
				return Ok(true);
			}
		}

		self.recycle_scratch(scratch);
		Ok(false)
	}

	fn walk_current_entry<V>(
		&mut self,
		name: &OsStr,
		entry_file_type: FileType,
		entry_mtime: Option<f64>,
		entry_size: Option<f64>,
		next_depth: usize,
		dir_ignore: &Arc<IgnoreState>,
		visitor: &mut V,
	) -> std::result::Result<bool, WalkError<V::Error>>
	where
		V: EntryVisitor,
		H: FnMut() -> std::result::Result<(), V::Error>,
	{
		let mut file_type = entry_file_type;
		let mut mtime = entry_mtime;
		let mut size = entry_size;
		let mut is_dir = entry_file_type == FileType::Dir;
		let mut descend = is_dir;
		let mut followed_symlink_dir = false;
		let followed_metadata = if entry_file_type == FileType::Symlink
			&& self.options.follow_links == FollowLinks::Always
		{
			match std::fs::metadata(&self.absolute_path) {
				Ok(metadata) => Some(metadata),
				Err(err) => {
					if self.options.directory_errors == DirectoryErrorMode::SkipSkippable
						&& is_skippable_directory_error(&err)
					{
						return Ok(false);
					}
					if self.options.directory_errors == DirectoryErrorMode::Visit {
						match visitor
							.visit_directory_error(DirectoryError {
								path:  &self.absolute_path,
								error: &err,
							})
							.map_err(WalkError::Interrupted)?
						{
							WalkControl::Quit => return Ok(true),
							WalkControl::SkipDescend | WalkControl::Continue => {
								return Ok(false);
							},
						}
					}
					return Err(WalkError::InvalidData {
						path:    self.absolute_path.clone(),
						message: err.to_string(),
					});
				},
			}
		} else {
			None
		};

		if let Some(target_metadata) = followed_metadata.as_ref() {
			let Some(target_file_type) = file_type_from_metadata(target_metadata) else {
				return Ok(false);
			};
			file_type = target_file_type;
			if target_file_type == FileType::Dir {
				is_dir = true;
				descend = true;
				followed_symlink_dir = true;
			} else {
				is_dir = false;
				descend = false;
			}
			if self.options.detail == WalkDetail::Full {
				if target_file_type == FileType::File {
					size = Some(target_metadata.len() as f64);
				} else {
					size = None;
				}
				mtime = target_metadata
					.modified()
					.ok()
					.and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
					.map(|duration| duration.as_millis() as f64);
			}
		}

		if self
			.matcher
			.is_ignored(dir_ignore, &self.absolute_path, is_dir)
		{
			return Ok(false);
		}

		if !is_effective_path_on_root_file_system(
			&self.absolute_path,
			next_depth,
			self.options.follow_links,
			self.root_device,
			followed_metadata.as_ref(),
		) {
			return Ok(false);
		}

		if followed_symlink_dir && descend {
			match directory_identity(&self.absolute_path) {
				Ok(target_id) => {
					if self.symlink_ancestors.contains(&target_id) {
						let loop_err = io::Error::other("filesystem loop detected");
						if self.options.directory_errors == DirectoryErrorMode::Visit {
							match visitor
								.visit_directory_error(DirectoryError {
									path:  &self.absolute_path,
									error: &loop_err,
								})
								.map_err(WalkError::Interrupted)?
							{
								WalkControl::Quit => return Ok(true),
								WalkControl::SkipDescend | WalkControl::Continue => {
									return Ok(false);
								},
							}
						} else if self.options.directory_errors == DirectoryErrorMode::SkipSkippable {
							return Ok(false);
						}
						return Err(WalkError::InvalidData {
							path:    self.absolute_path.clone(),
							message: "filesystem loop detected".to_string(),
						});
					}
				},
				Err(err) => {
					if self.options.directory_errors == DirectoryErrorMode::SkipSkippable
						&& is_skippable_directory_error(&err)
					{
						return Ok(false);
					}
					if self.options.directory_errors == DirectoryErrorMode::Visit {
						match visitor
							.visit_directory_error(DirectoryError {
								path:  &self.absolute_path,
								error: &err,
							})
							.map_err(WalkError::Interrupted)?
						{
							WalkControl::Quit => return Ok(true),
							WalkControl::SkipDescend | WalkControl::Continue => {
								return Ok(false);
							},
						}
					}
					return Err(WalkError::InvalidData {
						path:    self.absolute_path.clone(),
						message: err.to_string(),
					});
				},
			}
		}

		let decision = {
			let meta = EntryMeta {
				root: self.root_path,
				absolute_path: Cow::Borrowed(self.absolute_path.as_path()),
				relative_path: &self.relative_path,
				file_type,
				mtime,
				size,
				depth: next_depth,
			};
			visitor
				.decide_pre_descend(&meta)
				.map_err(WalkError::Interrupted)?
		};
		if decision.stop {
			return Ok(true);
		}

		if !self.options.contents_first && decision.emit && next_depth >= self.options.min_depth {
			match visitor
				.visit_pre_decided(Entry {
					path: self.absolute_path.as_path(),
					relative: &self.relative_path,
					name,
					file_type,
					mtime,
					size,
					depth: next_depth,
				})
				.map_err(WalkError::Interrupted)?
			{
				WalkControl::Quit => return Ok(true),
				WalkControl::SkipDescend => return Ok(false),
				WalkControl::Continue => {},
			}
		}

		let child_stopped = if descend && next_depth < self.options.max_depth && decision.descend {
			self.walk_dir(next_depth, dir_ignore, true, visitor)?
		} else {
			false
		};

		if child_stopped {
			return Ok(true);
		}

		if self.options.contents_first && decision.emit && next_depth >= self.options.min_depth {
			match visitor
				.visit_pre_decided(Entry {
					path: self.absolute_path.as_path(),
					relative: &self.relative_path,
					name,
					file_type,
					mtime,
					size,
					depth: next_depth,
				})
				.map_err(WalkError::Interrupted)?
			{
				WalkControl::Quit => return Ok(true),
				WalkControl::SkipDescend | WalkControl::Continue => {},
			}
		}

		Ok(false)
	}
}

fn collect_directory_entries<E>(
	dir: &Path,
	detail: WalkDetail,
	scratch: &mut DirScratch,
	matcher: &FastIgnore,
	derive_ignore_from_entries: bool,
) -> std::result::Result<IgnoreEntryNames, ReadDirError<E>> {
	scratch.clear_listing();
	let mut ignore_entries = IgnoreEntryNames::default();
	let track_ignore_entries = derive_ignore_from_entries && matcher.use_gitignore;
	let mut read_buffer = std::mem::take(&mut scratch.read_buffer);
	let result = platform::read_dir_entries(dir, detail, &mut read_buffer, |entry| {
		if track_ignore_entries {
			ignore_entries.record(entry.name.as_ref(), entry.file_type);
		}
		scratch.push(entry);
		Ok(ReadDirControl::Continue)
	});
	scratch.read_buffer = read_buffer;
	result?;
	Ok(ignore_entries)
}
/// Return whether [`WalkDetail::Full`] provides file sizes without per-entry
/// metadata syscalls on this platform.
pub const fn supports_cheap_size_hints() -> bool {
	platform::CHEAP_SIZE_HINTS
}

struct IgnoreState {
	parent:              Option<Arc<Self>>,
	ignore_matcher:      Option<ignore::gitignore::Gitignore>,
	gitignore_matcher:   Option<ignore::gitignore::Gitignore>,
	git_exclude_matcher: Option<ignore::gitignore::Gitignore>,
	has_git:             bool,
	chain_has_matchers:  bool,
	any_git:             bool,
}

struct FastIgnore {
	global:        Option<ignore::gitignore::Gitignore>,
	use_gitignore: bool,
}

#[derive(Clone, Copy, Default)]
struct IgnoreEntryNames {
	ignore_file:    bool,
	gitignore_file: bool,
	git_dir:        bool,
	repo_marker:    bool,
}

impl IgnoreEntryNames {
	fn record(&mut self, name: &OsStr, file_type: FileType) {
		if matches!(file_type, FileType::File | FileType::Symlink) {
			if name == OsStr::new(".ignore") {
				self.ignore_file = true;
			} else if name == OsStr::new(".gitignore") {
				self.gitignore_file = true;
			}
		}
		if name == OsStr::new(".git") {
			self.git_dir = true;
			self.repo_marker = true;
		} else if name == OsStr::new(".jj") {
			self.repo_marker = true;
		}
	}

	const fn has_relevant(self) -> bool {
		self.ignore_file || self.gitignore_file || self.git_dir || self.repo_marker
	}
}

fn has_repo_marker(dir: &Path) -> bool {
	dir.join(".git").exists() || dir.join(".jj").exists()
}

fn ignore_line_covers_root(
	matcher_root: &Path,
	source: &Path,
	line: &str,
	explicit_root: &Path,
) -> bool {
	let mut builder = ignore::gitignore::GitignoreBuilder::new(matcher_root);
	builder.add_line(Some(source.to_path_buf()), line).is_ok()
		&& builder.build().is_ok_and(|matcher| {
			matcher
				.matched_path_or_any_parents(explicit_root, true)
				.is_ignore()
		})
}

/// Load an ignore source, removing ancestor rules that cover an explicit walk
/// root.
///
/// Unrelated parent rules remain active, while ignore files discovered at or
/// below the root are loaded without filtering.
fn load_gitignore(
	matcher_root: &Path,
	file: &Path,
	explicit_root: Option<&Path>,
) -> Option<ignore::gitignore::Gitignore> {
	if !file.is_file() {
		return None;
	}
	let mut builder = ignore::gitignore::GitignoreBuilder::new(matcher_root);
	let _ = builder.add(file);
	let matcher = builder.build().ok().filter(|matcher| !matcher.is_empty())?;
	let Some(explicit_root) = explicit_root else {
		return Some(matcher);
	};
	if !matcher
		.matched_path_or_any_parents(explicit_root, true)
		.is_ignore()
	{
		return Some(matcher);
	}

	let handle = std::fs::File::open(file).ok()?;
	let mut filtered = ignore::gitignore::GitignoreBuilder::new(matcher_root);
	let source = Some(file.to_path_buf());
	for (index, line) in io::BufReader::new(handle).lines().enumerate() {
		let Ok(line) = line else {
			break;
		};
		let line = if index == 0 {
			line.trim_start_matches('\u{feff}')
		} else {
			line.as_str()
		};
		if ignore_line_covers_root(matcher_root, file, line, explicit_root) {
			continue;
		}
		let _ = filtered.add_line(source.clone(), line);
	}
	filtered.build().ok().filter(|matcher| !matcher.is_empty())
}

impl IgnoreState {
	fn build(dir: &Path, parent: Option<Arc<Self>>) -> Arc<Self> {
		let has_git = has_repo_marker(dir);
		let git_exclude = dir.join(".git/info/exclude");
		Self::new(
			parent,
			load_gitignore(dir, &dir.join(".ignore"), None),
			load_gitignore(dir, &dir.join(".gitignore"), None),
			if has_git {
				load_gitignore(dir, &git_exclude, None)
			} else {
				None
			},
			has_git,
		)
	}

	fn build_parent(dir: &Path, parent: Option<Arc<Self>>, explicit_root: &Path) -> Arc<Self> {
		let has_git = has_repo_marker(dir);
		let git_exclude = dir.join(".git/info/exclude");
		Self::new(
			parent,
			load_gitignore(dir, &dir.join(".ignore"), Some(explicit_root)),
			load_gitignore(dir, &dir.join(".gitignore"), Some(explicit_root)),
			if has_git {
				load_gitignore(dir, &git_exclude, Some(explicit_root))
			} else {
				None
			},
			has_git,
		)
	}

	fn build_from_entry_names(dir: &Path, parent: &Arc<Self>, names: IgnoreEntryNames) -> Arc<Self> {
		if !names.has_relevant() {
			return Arc::clone(parent);
		}
		let git_exclude = dir.join(".git/info/exclude");
		Self::new(
			Some(Arc::clone(parent)),
			if names.ignore_file {
				load_gitignore(dir, &dir.join(".ignore"), None)
			} else {
				None
			},
			if names.gitignore_file {
				load_gitignore(dir, &dir.join(".gitignore"), None)
			} else {
				None
			},
			if names.git_dir {
				load_gitignore(dir, &git_exclude, None)
			} else {
				None
			},
			names.repo_marker,
		)
	}

	fn new(
		parent: Option<Arc<Self>>,
		ignore_matcher: Option<ignore::gitignore::Gitignore>,
		gitignore_matcher: Option<ignore::gitignore::Gitignore>,
		git_exclude_matcher: Option<ignore::gitignore::Gitignore>,
		has_git: bool,
	) -> Arc<Self> {
		let parent_has_matchers = parent
			.as_ref()
			.is_some_and(|parent| parent.chain_has_matchers);
		let parent_has_git = parent.as_ref().is_some_and(|parent| parent.any_git);
		let has_matchers =
			ignore_matcher.is_some() || gitignore_matcher.is_some() || git_exclude_matcher.is_some();
		Arc::new(Self {
			parent,
			ignore_matcher,
			gitignore_matcher,
			git_exclude_matcher,
			has_git,
			chain_has_matchers: has_matchers || parent_has_matchers,
			any_git: has_git || parent_has_git,
		})
	}

	fn build_parents(root: &Path, use_gitignore: bool) -> Option<Arc<Self>> {
		if !use_gitignore {
			return None;
		}
		let mut ancestors = Vec::new();
		let mut current = root.parent();
		let mut repo_start = None;
		while let Some(path) = current {
			ancestors.push(path);
			if repo_start.is_none() && has_repo_marker(path) {
				repo_start = Some(ancestors.len() - 1);
			}
			current = path.parent();
		}

		let repo_start = repo_start?;
		let mut parent = None;
		for ancestor in ancestors[..=repo_start].iter().rev() {
			parent = Some(Self::build_parent(ancestor, parent, root));
		}
		parent
	}
}

impl FastIgnore {
	fn new(use_gitignore: bool) -> Self {
		let global = if use_gitignore {
			let (matcher, _err) = ignore::gitignore::Gitignore::global();
			if matcher.is_empty() {
				None
			} else {
				Some(matcher)
			}
		} else {
			None
		};
		Self { global, use_gitignore }
	}

	fn root_state(&self, root: &Path) -> Arc<IgnoreState> {
		IgnoreState::build(root, IgnoreState::build_parents(root, self.use_gitignore))
	}

	fn state_from_entries(
		&self,
		parent: &Arc<IgnoreState>,
		dir: &Path,
		names: IgnoreEntryNames,
		derive_ignore_from_entries: bool,
	) -> Arc<IgnoreState> {
		if self.use_gitignore && derive_ignore_from_entries {
			IgnoreState::build_from_entry_names(dir, parent, names)
		} else {
			Arc::clone(parent)
		}
	}

	fn is_ignored(&self, state: &Arc<IgnoreState>, path: &Path, is_dir: bool) -> bool {
		if !self.use_gitignore {
			return false;
		}

		let any_git = state.any_git;
		let global_matcher_applies = any_git && self.global.is_some();
		if !state.chain_has_matchers && !global_matcher_applies {
			return false;
		}

		let mut saw_git = false;
		let mut ignore_match = ignore::Match::None;
		let mut gitignore_match = ignore::Match::None;
		let mut git_exclude_match = ignore::Match::None;

		if state.chain_has_matchers {
			let mut current = Some(state.as_ref());
			while let Some(frame) = current {
				if ignore_match.is_none()
					&& let Some(matcher) = &frame.ignore_matcher
				{
					ignore_match = matcher.matched(path, is_dir);
				}
				if gitignore_match.is_none()
					&& let Some(matcher) = &frame.gitignore_matcher
				{
					gitignore_match = matcher.matched(path, is_dir);
				}
				if any_git
					&& !saw_git
					&& git_exclude_match.is_none()
					&& let Some(matcher) = &frame.git_exclude_matcher
				{
					git_exclude_match = matcher.matched(path, is_dir);
				}
				saw_git = saw_git || frame.has_git;
				current = frame.parent.as_deref();
			}
		}
		match ignore_match {
			ignore::Match::Ignore(_) => return true,
			ignore::Match::Whitelist(_) => return false,
			ignore::Match::None => {},
		}
		match gitignore_match {
			ignore::Match::Ignore(_) => return true,
			ignore::Match::Whitelist(_) => return false,
			ignore::Match::None => {},
		}
		match git_exclude_match {
			ignore::Match::Ignore(_) => return true,
			ignore::Match::Whitelist(_) => return false,
			ignore::Match::None => {},
		}
		if any_git && let Some(global) = &self.global {
			match global.matched(path, is_dir) {
				ignore::Match::Ignore(_) => return true,
				ignore::Match::Whitelist(_) => return false,
				ignore::Match::None => {},
			}
		}
		false
	}
}

fn handle_read_dir_error<V>(
	dir: &Path,
	err: ReadDirError<V::Error>,
	options: WalkOptions,
	visitor: &mut V,
) -> std::result::Result<bool, WalkError<V::Error>>
where
	V: EntryVisitor,
{
	match err {
		ReadDirError::Walk(err) => Err(err),
		ReadDirError::Io(err)
			if options.directory_errors == DirectoryErrorMode::SkipSkippable
				&& is_skippable_directory_error(&err) =>
		{
			Ok(false)
		},
		ReadDirError::Io(err) if options.directory_errors == DirectoryErrorMode::Visit => {
			match visitor
				.visit_directory_error(DirectoryError { path: dir, error: &err })
				.map_err(WalkError::Interrupted)?
			{
				WalkControl::Quit => Ok(true),
				WalkControl::SkipDescend | WalkControl::Continue => Ok(false),
			}
		},
		ReadDirError::Io(err) => {
			Err(WalkError::InvalidData { path: dir.to_path_buf(), message: err.to_string() })
		},
	}
}

fn is_skippable_directory_error(err: &io::Error) -> bool {
	matches!(
		err.kind(),
		io::ErrorKind::NotFound | io::ErrorKind::NotADirectory | io::ErrorKind::PermissionDenied
	)
}

fn is_dot_entry(name: &OsStr) -> bool {
	name == OsStr::new(".") || name == OsStr::new("..")
}

fn is_git_name(name: &OsStr) -> bool {
	name == OsStr::new(".git")
}

fn is_node_modules_name(name: &OsStr) -> bool {
	name == OsStr::new("node_modules")
}

fn entry_name(name: &OsStr) -> Cow<'_, str> {
	name
		.to_str()
		.map_or_else(|| name.to_string_lossy(), Cow::Borrowed)
}

#[cfg(unix)]
fn is_hidden_name(name: &OsStr) -> bool {
	use std::os::unix::ffi::OsStrExt;
	name.as_bytes().first() == Some(&b'.')
}

#[cfg(windows)]
fn is_hidden_name(name: &OsStr) -> bool {
	use std::os::windows::ffi::OsStrExt;
	name.encode_wide().next() == Some(b'.' as u16)
}

#[cfg(not(any(unix, windows)))]
fn is_hidden_name(name: &OsStr) -> bool {
	name
		.to_str()
		.is_some_and(|value| value.as_bytes().first() == Some(&b'.'))
}

fn push_relative_name(relative: &mut String, name: &str) {
	if !relative.is_empty() {
		relative.push('/');
	}
	relative.push_str(name);
}

fn mtime_millis(seconds: i64, nanos: i64) -> Option<f64> {
	if seconds < 0 {
		return None;
	}
	Some((seconds as f64).mul_add(1000.0, nanos.max(0) as f64 / 1_000_000.0))
}

#[cfg(target_os = "macos")]
mod platform {
	use std::{
		borrow::Cow,
		ffi::{CString, OsStr},
		io,
		mem::size_of,
		os::{fd::RawFd, unix::ffi::OsStrExt},
		path::Path,
	};

	use super::{
		FileType, RawDirEntry, ReadDirControl, ReadDirError, WalkDetail, WalkError, mtime_millis,
	};

	/// `getattrlistbulk` can return data length in the same batch, but
	/// requesting full-detail attributes (size + mtime) measurably slows the
	/// bulk scan (~+50% walk time on APFS), which outweighs saving one fstat
	/// per opened file. Benchmarked via `perf_walk_collect_full_detail` vs
	/// minimal detail.
	pub const CHEAP_SIZE_HINTS: bool = false;

	const BUFFER_SIZE: usize = 256 * 1024;
	const VREG: u32 = 1;
	const VDIR: u32 = 2;
	const VLNK: u32 = 5;

	struct FdGuard(RawFd);

	impl Drop for FdGuard {
		fn drop(&mut self) {
			// SAFETY: `FdGuard` owns this file descriptor and closes it exactly once.
			unsafe { libc::close(self.0) };
		}
	}

	pub fn read_dir_entries<F, E>(
		path: &Path,
		detail: WalkDetail,
		buffer: &mut Vec<u8>,
		mut emit: F,
	) -> std::result::Result<ReadDirControl, ReadDirError<E>>
	where
		F: FnMut(RawDirEntry<'_>) -> std::result::Result<ReadDirControl, WalkError<E>>,
	{
		let fd = open_dir(path)?;
		let mut attrs = libc::attrlist {
			bitmapcount: libc::ATTR_BIT_MAP_COUNT,
			reserved:    0,
			commonattr:  libc::ATTR_CMN_NAME | libc::ATTR_CMN_OBJTYPE,
			volattr:     0,
			dirattr:     0,
			fileattr:    0,
			forkattr:    0,
		};
		if detail == WalkDetail::Full {
			attrs.commonattr |= libc::ATTR_CMN_MODTIME;
			attrs.fileattr |= libc::ATTR_FILE_DATALENGTH;
		}

		if buffer.len() != BUFFER_SIZE {
			buffer.resize(BUFFER_SIZE, 0);
		}
		loop {
			// SAFETY: `fd` is an open directory descriptor, `attrs` points to a valid
			// attrlist for the duration of the call, and `buffer` is writable.
			let count = unsafe {
				libc::getattrlistbulk(
					fd.0,
					std::ptr::addr_of_mut!(attrs).cast(),
					buffer.as_mut_ptr().cast(),
					buffer.len(),
					libc::FSOPT_NOFOLLOW as u64,
				)
			};
			if count == 0 {
				break;
			}
			if count < 0 {
				let err = io::Error::last_os_error();
				if err.kind() == io::ErrorKind::Interrupted {
					continue;
				}
				if is_unsupported_dir_scan(&err) {
					return read_dir_entries_std(path, detail, emit);
				}
				return Err(ReadDirError::Io(err));
			}

			let mut offset = 0usize;
			for _ in 0..count {
				if offset + size_of::<u32>() > buffer.len() {
					return Err(invalid_data("truncated getattrlistbulk record length").into());
				}
				let record_len = u32::from_ne_bytes(
					buffer[offset..offset + size_of::<u32>()]
						.try_into()
						.expect("slice length checked"),
				) as usize;
				if record_len < size_of::<u32>() || offset + record_len > buffer.len() {
					return Err(invalid_data("invalid getattrlistbulk record length").into());
				}
				let record = &buffer[offset..offset + record_len];
				if let Some(entry) = parse_record(record, detail)?
					&& emit(entry).map_err(ReadDirError::Walk)? == ReadDirControl::Stop
				{
					return Ok(ReadDirControl::Stop);
				}
				offset += record_len;
			}
		}
		Ok(ReadDirControl::Continue)
	}

	fn read_dir_entries_std<F, E>(
		path: &Path,
		detail: WalkDetail,
		mut emit: F,
	) -> std::result::Result<ReadDirControl, ReadDirError<E>>
	where
		F: FnMut(RawDirEntry<'_>) -> std::result::Result<ReadDirControl, WalkError<E>>,
	{
		let read_dir = std::fs::read_dir(path)?;
		for entry in read_dir {
			let entry = entry?;
			let file_type = match entry.file_type() {
				Ok(file_type) => file_type,
				Err(err) if is_skippable_entry_error(&err) => continue,
				Err(err) => return Err(err.into()),
			};
			let file_type = if file_type.is_symlink() {
				Some(FileType::Symlink)
			} else if file_type.is_dir() {
				Some(FileType::Dir)
			} else if file_type.is_file() {
				Some(FileType::File)
			} else {
				None
			};
			let Some(file_type) = file_type else {
				continue;
			};

			let mut mtime = None;
			let mut size = None;
			if detail == WalkDetail::Full {
				match std::fs::symlink_metadata(entry.path()) {
					Ok(metadata) => {
						if file_type == FileType::File {
							size = Some(metadata.len() as f64);
						}
						mtime = metadata
							.modified()
							.ok()
							.and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
							.map(|duration| duration.as_millis() as f64);
					},
					Err(err) if is_skippable_entry_error(&err) => continue,
					Err(err) => return Err(err.into()),
				}
			}

			let raw_entry =
				RawDirEntry { name: Cow::Owned(entry.file_name()), file_type, mtime, size };

			if emit(raw_entry).map_err(ReadDirError::Walk)? == ReadDirControl::Stop {
				return Ok(ReadDirControl::Stop);
			}
		}
		Ok(ReadDirControl::Continue)
	}

	fn open_dir(path: &Path) -> io::Result<FdGuard> {
		let path = CString::new(path.as_os_str().as_bytes())
			.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
		// SAFETY: `path` is a NUL-terminated C string; flags open the directory for
		// metadata traversal only and do not transfer ownership of the string.
		let fd =
			unsafe { libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
		if fd < 0 {
			Err(io::Error::last_os_error())
		} else {
			Ok(FdGuard(fd))
		}
	}

	fn parse_record(record: &[u8], detail: WalkDetail) -> io::Result<Option<RawDirEntry<'_>>> {
		let mut cursor = size_of::<u32>();
		let name_ref_start = cursor;
		let name_ref = read_value::<libc::attrreference_t>(record, &mut cursor)?;
		let obj_type = read_value::<u32>(record, &mut cursor)?;
		let (mtime, data_length) = if detail == WalkDetail::Full {
			let modified = read_value::<libc::timespec>(record, &mut cursor)?;
			let data_length = read_value::<u64>(record, &mut cursor)?;
			(mtime_millis(modified.tv_sec as i64, modified.tv_nsec as i64), Some(data_length))
		} else {
			(None, None)
		};

		let name_start = checked_attr_offset(name_ref_start, name_ref.attr_dataoffset)?;
		let name_len = name_ref.attr_length as usize;
		if name_len == 0 || name_start + name_len > record.len() {
			return Err(invalid_data("invalid getattrlistbulk name reference"));
		}
		let name_bytes = trim_nul(&record[name_start..name_start + name_len]);
		if name_bytes.is_empty() {
			return Ok(None);
		}

		let Some(file_type) = file_type_from_vtype(obj_type) else {
			return Ok(None);
		};
		let size = if file_type == FileType::File {
			data_length.map(|value| value as f64)
		} else {
			None
		};
		Ok(Some(RawDirEntry { name: OsStr::from_bytes(name_bytes).into(), file_type, mtime, size }))
	}

	fn read_value<T: Copy>(record: &[u8], cursor: &mut usize) -> io::Result<T> {
		let end = cursor.saturating_add(size_of::<T>());
		if end > record.len() {
			return Err(invalid_data("truncated getattrlistbulk attribute"));
		}
		let ptr = record[*cursor..end].as_ptr();
		*cursor = end;
		// SAFETY: Bounds were checked above; `getattrlistbulk` records are byte
		// packed, so unaligned reads are required and do not outlive `record`.
		Ok(unsafe { std::ptr::read_unaligned(ptr.cast::<T>()) })
	}

	fn checked_attr_offset(base: usize, offset: i32) -> io::Result<usize> {
		if offset < 0 {
			return Err(invalid_data("negative getattrlistbulk attribute offset"));
		}
		base
			.checked_add(offset as usize)
			.ok_or_else(|| invalid_data("overflowing getattrlistbulk attribute offset"))
	}

	fn trim_nul(bytes: &[u8]) -> &[u8] {
		let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
		&bytes[..end]
	}

	const fn file_type_from_vtype(value: u32) -> Option<FileType> {
		match value {
			VREG => Some(FileType::File),
			VDIR => Some(FileType::Dir),
			VLNK => Some(FileType::Symlink),
			_ => None,
		}
	}

	fn is_unsupported_dir_scan(err: &io::Error) -> bool {
		matches!(err.raw_os_error(), Some(libc::ENOTSUP | libc::EINVAL))
	}

	fn is_skippable_entry_error(err: &io::Error) -> bool {
		matches!(err.kind(), io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied)
	}

	fn invalid_data(message: &'static str) -> io::Error {
		io::Error::new(io::ErrorKind::InvalidData, message)
	}
}

#[cfg(target_os = "linux")]
mod platform {
	use std::{
		ffi::{CString, OsStr},
		io,
		mem::{size_of, zeroed},
		os::unix::ffi::OsStrExt,
		path::Path,
	};

	use super::{
		FileType, RawDirEntry, ReadDirControl, ReadDirError, WalkDetail, WalkError, mtime_millis,
	};

	pub const CHEAP_SIZE_HINTS: bool = false;

	const BUFFER_SIZE: usize = 256 * 1024;
	const LINUX_DIRENT64_NAME_OFFSET: usize = 19;
	const STATX_TYPE: u32 = 0x0001;
	const STATX_SIZE: u32 = 0x0200;
	const STATX_MTIME: u32 = 0x0040;
	const STATX_BASIC_STATS: u32 = 0x07ff;

	#[repr(C)]
	#[derive(Clone, Copy)]
	struct StatxTimestamp {
		tv_sec:     i64,
		tv_nsec:    u32,
		__reserved: i32,
	}

	#[repr(C)]
	#[derive(Clone, Copy)]
	struct Statx {
		stx_mask:             u32,
		stx_blksize:          u32,
		stx_attributes:       u64,
		stx_nlink:            u32,
		stx_uid:              u32,
		stx_gid:              u32,
		stx_mode:             u16,
		__spare0:             [u16; 1],
		stx_ino:              u64,
		stx_size:             u64,
		stx_blocks:           u64,
		stx_attributes_mask:  u64,
		stx_atime:            StatxTimestamp,
		stx_btime:            StatxTimestamp,
		stx_ctime:            StatxTimestamp,
		stx_mtime:            StatxTimestamp,
		stx_rdev_major:       u32,
		stx_rdev_minor:       u32,
		stx_dev_major:        u32,
		stx_dev_minor:        u32,
		stx_mnt_id:           u64,
		stx_dio_mem_align:    u32,
		stx_dio_offset_align: u32,
		__spare3:             [u64; 12],
	}

	struct FdGuard(libc::c_int);

	impl Drop for FdGuard {
		fn drop(&mut self) {
			// SAFETY: `FdGuard` owns this file descriptor and closes it exactly once.
			unsafe { libc::close(self.0) };
		}
	}

	struct EntryStat {
		file_type: FileType,
		mtime:     Option<f64>,
		size:      Option<f64>,
	}

	pub fn read_dir_entries<F, E>(
		path: &Path,
		detail: WalkDetail,
		buffer: &mut Vec<u8>,
		mut emit: F,
	) -> std::result::Result<ReadDirControl, ReadDirError<E>>
	where
		F: FnMut(RawDirEntry<'_>) -> std::result::Result<ReadDirControl, WalkError<E>>,
	{
		let fd = open_dir(path)?;
		if buffer.len() != BUFFER_SIZE {
			buffer.resize(BUFFER_SIZE, 0);
		}
		loop {
			// SAFETY: `fd` is an open directory descriptor and `buffer` is writable.
			let read = unsafe {
				libc::syscall(
					libc::SYS_getdents64,
					fd.0,
					buffer.as_mut_ptr().cast::<libc::c_void>(),
					buffer.len(),
				)
			};
			if read == 0 {
				break;
			}
			if read < 0 {
				let err = io::Error::last_os_error();
				if err.kind() == io::ErrorKind::Interrupted {
					continue;
				}
				return Err(err.into());
			}

			let mut offset = 0usize;
			let read_len = read as usize;
			while offset < read_len {
				if offset + LINUX_DIRENT64_NAME_OFFSET > read_len {
					return Err(invalid_data("truncated getdents64 record").into());
				}
				let reclen = read_u16(&buffer[offset + 16..read_len])? as usize;
				if reclen < LINUX_DIRENT64_NAME_OFFSET || offset + reclen > read_len {
					return Err(invalid_data("invalid getdents64 record length").into());
				}
				let d_type = buffer[offset + 18];
				let name_bytes =
					trim_nul(&buffer[offset + LINUX_DIRENT64_NAME_OFFSET..offset + reclen]);
				offset += reclen;
				if name_bytes.is_empty() {
					continue;
				}

				let dtype_file_type = file_type_from_dtype(d_type);
				let stat = if detail == WalkDetail::Full || dtype_file_type.is_none() {
					match stat_entry(fd.0, name_bytes, detail) {
						Ok(Some(stat)) => Some(stat),
						Ok(None) => continue,
						Err(err) if is_skippable_entry_error(&err) => continue,
						Err(err) => return Err(err.into()),
					}
				} else {
					None
				};
				let file_type = stat
					.as_ref()
					.map_or(dtype_file_type, |stat| Some(stat.file_type));
				let Some(file_type) = file_type else {
					continue;
				};
				let entry = RawDirEntry {
					name: OsStr::from_bytes(name_bytes).into(),
					file_type,
					mtime: stat.as_ref().and_then(|stat| stat.mtime),
					size: stat.as_ref().and_then(|stat| stat.size),
				};
				if emit(entry).map_err(ReadDirError::Walk)? == ReadDirControl::Stop {
					return Ok(ReadDirControl::Stop);
				}
			}
		}
		Ok(ReadDirControl::Continue)
	}

	fn open_dir(path: &Path) -> io::Result<FdGuard> {
		let path = CString::new(path.as_os_str().as_bytes())
			.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
		// SAFETY: `path` is a NUL-terminated C string; flags request a directory
		// descriptor used only with getdents/statx and do not retain the pointer.
		let fd =
			unsafe { libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
		if fd < 0 {
			Err(io::Error::last_os_error())
		} else {
			Ok(FdGuard(fd))
		}
	}

	fn stat_entry(
		dirfd: libc::c_int,
		name: &[u8],
		detail: WalkDetail,
	) -> io::Result<Option<EntryStat>> {
		let name = CString::new(name)
			.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "entry name contains NUL"))?;
		match statx_entry(dirfd, &name, detail) {
			Ok(value) => Ok(value),
			Err(err) if matches!(err.raw_os_error(), Some(libc::ENOSYS | libc::EINVAL)) => {
				fstatat_entry(dirfd, &name, detail)
			},
			Err(err) => Err(err),
		}
	}

	fn statx_entry(
		dirfd: libc::c_int,
		name: &CString,
		detail: WalkDetail,
	) -> io::Result<Option<EntryStat>> {
		// SAFETY: `Statx` is a plain-old-data buffer whose all-zero value is a
		// valid initialization before the kernel fills it.
		let mut statx = unsafe { zeroed::<Statx>() };
		let mask = if detail == WalkDetail::Full {
			STATX_BASIC_STATS
		} else {
			STATX_TYPE
		};
		// SAFETY: `name` is NUL-terminated, `statx` is writable, and `dirfd` is an
		// open directory descriptor for an AT_* relative metadata query.
		let rc = unsafe {
			libc::syscall(
				libc::SYS_statx,
				dirfd,
				name.as_ptr(),
				libc::AT_SYMLINK_NOFOLLOW | libc::AT_NO_AUTOMOUNT,
				mask,
				std::ptr::addr_of_mut!(statx),
			)
		};
		if rc != 0 {
			return Err(io::Error::last_os_error());
		}
		let Some(file_type) = file_type_from_mode(statx.stx_mode as libc::mode_t) else {
			return Ok(None);
		};
		let mtime = if detail == WalkDetail::Full && statx.stx_mask & STATX_MTIME != 0 {
			mtime_millis(statx.stx_mtime.tv_sec, i64::from(statx.stx_mtime.tv_nsec))
		} else {
			None
		};
		let size = if detail == WalkDetail::Full
			&& file_type == FileType::File
			&& statx.stx_mask & STATX_SIZE != 0
		{
			Some(statx.stx_size as f64)
		} else {
			None
		};
		Ok(Some(EntryStat { file_type, mtime, size }))
	}

	fn fstatat_entry(
		dirfd: libc::c_int,
		name: &CString,
		detail: WalkDetail,
	) -> io::Result<Option<EntryStat>> {
		// SAFETY: `libc::stat` is a POD buffer filled by fstatat.
		let mut stat = unsafe { zeroed::<libc::stat>() };
		// SAFETY: `name` is NUL-terminated, `stat` is writable, and `dirfd` is an
		// open directory descriptor for an AT_* relative metadata query.
		let rc = unsafe {
			libc::fstatat(
				dirfd,
				name.as_ptr(),
				std::ptr::addr_of_mut!(stat),
				libc::AT_SYMLINK_NOFOLLOW,
			)
		};
		if rc != 0 {
			return Err(io::Error::last_os_error());
		}
		let Some(file_type) = file_type_from_mode(stat.st_mode) else {
			return Ok(None);
		};
		let mtime = if detail == WalkDetail::Full {
			mtime_millis(stat.st_mtime, stat.st_mtime_nsec as i64)
		} else {
			None
		};
		let size = if detail == WalkDetail::Full && file_type == FileType::File {
			Some(stat.st_size as f64)
		} else {
			None
		};
		Ok(Some(EntryStat { file_type, mtime, size }))
	}

	fn read_u16(bytes: &[u8]) -> io::Result<u16> {
		if bytes.len() < size_of::<u16>() {
			return Err(invalid_data("truncated u16"));
		}
		Ok(u16::from_ne_bytes(
			bytes[..size_of::<u16>()]
				.try_into()
				.expect("slice length checked"),
		))
	}

	fn trim_nul(bytes: &[u8]) -> &[u8] {
		let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
		&bytes[..end]
	}

	const fn file_type_from_dtype(value: u8) -> Option<FileType> {
		match value {
			libc::DT_REG => Some(FileType::File),
			libc::DT_DIR => Some(FileType::Dir),
			libc::DT_LNK => Some(FileType::Symlink),
			_ => None,
		}
	}

	const fn file_type_from_mode(mode: libc::mode_t) -> Option<FileType> {
		match mode & libc::S_IFMT {
			libc::S_IFREG => Some(FileType::File),
			libc::S_IFDIR => Some(FileType::Dir),
			libc::S_IFLNK => Some(FileType::Symlink),
			_ => None,
		}
	}

	fn is_skippable_entry_error(err: &io::Error) -> bool {
		matches!(
			err.kind(),
			io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied | io::ErrorKind::NotADirectory
		)
	}

	fn invalid_data(message: &'static str) -> io::Error {
		io::Error::new(io::ErrorKind::InvalidData, message)
	}
}

#[cfg(target_os = "windows")]
mod platform {
	use std::{
		ffi::OsString,
		io,
		os::windows::ffi::{OsStrExt, OsStringExt},
		path::Path,
	};

	use windows_sys::{
		Wdk::Storage::FileSystem::{
			FILE_ID_FULL_DIR_INFORMATION, FileIdFullDirectoryInformation, NtQueryDirectoryFile,
		},
		Win32::{
			Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, STATUS_NO_MORE_FILES},
			Storage::FileSystem::{
				CreateFileW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
				FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY,
				FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
			},
			System::IO::IO_STATUS_BLOCK,
		},
	};

	use super::{
		FileType, RawDirEntry, ReadDirControl, ReadDirError, WalkDetail, WalkError, mtime_millis,
	};

	pub const CHEAP_SIZE_HINTS: bool = true;

	const BUFFER_SIZE: usize = 256 * 1024;
	const WINDOWS_TICK: i64 = 10_000_000;
	const UNIX_EPOCH_AS_FILETIME: i64 = 116_444_736_000_000_000;

	struct HandleGuard(HANDLE);

	impl Drop for HandleGuard {
		fn drop(&mut self) {
			// SAFETY: `HandleGuard` owns this handle and closes it exactly once.
			unsafe { CloseHandle(self.0) };
		}
	}

	pub fn read_dir_entries<F, E>(
		path: &Path,
		detail: WalkDetail,
		buffer: &mut Vec<u8>,
		mut emit: F,
	) -> std::result::Result<ReadDirControl, ReadDirError<E>>
	where
		F: FnMut(RawDirEntry<'_>) -> std::result::Result<ReadDirControl, WalkError<E>>,
	{
		let handle = open_dir(path)?;
		if buffer.len() != BUFFER_SIZE {
			buffer.resize(BUFFER_SIZE, 0);
		}
		let mut restart = true;

		loop {
			let mut iosb = IO_STATUS_BLOCK::default();
			// SAFETY: `handle` is an open directory handle, `buffer` is writable, and
			// the query class matches the record parser below.
			let status = unsafe {
				NtQueryDirectoryFile(
					handle.0,
					std::ptr::null_mut(),
					None,
					std::ptr::null(),
					std::ptr::addr_of_mut!(iosb),
					buffer.as_mut_ptr().cast(),
					buffer.len() as u32,
					FileIdFullDirectoryInformation,
					false,
					std::ptr::null(),
					restart,
				)
			};
			restart = false;
			if status == STATUS_NO_MORE_FILES {
				break;
			}
			if status < 0 {
				return Err(io::Error::from_raw_os_error(status).into());
			}

			let mut offset = 0usize;
			loop {
				if offset + std::mem::size_of::<FILE_ID_FULL_DIR_INFORMATION>() > buffer.len() {
					return Err(invalid_data("truncated NtQueryDirectoryFile record").into());
				}
				let info = unsafe {
					// SAFETY: Bounds were checked above; records are byte-packed in the
					// buffer and may not be aligned for Rust references.
					std::ptr::read_unaligned(
						buffer[offset..]
							.as_ptr()
							.cast::<FILE_ID_FULL_DIR_INFORMATION>(),
					)
				};
				let name_offset = offset + std::mem::offset_of!(FILE_ID_FULL_DIR_INFORMATION, FileName);
				let name_len = info.FileNameLength as usize;
				if !name_len.is_multiple_of(2) || name_offset + name_len > buffer.len() {
					return Err(invalid_data("invalid NtQueryDirectoryFile name length").into());
				}
				let name_units: Vec<u16> = buffer[name_offset..name_offset + name_len]
					.as_chunks::<2>()
					.0
					.iter()
					.map(|chunk| u16::from_ne_bytes([chunk[0], chunk[1]]))
					.collect();
				let name = OsString::from_wide(&name_units);
				let file_type = file_type_from_attributes(info.FileAttributes);
				let size = if detail == WalkDetail::Full && file_type == FileType::File {
					Some(info.EndOfFile.max(0) as f64)
				} else {
					None
				};
				let mtime = if detail == WalkDetail::Full {
					mtime_from_filetime(info.LastWriteTime)
				} else {
					None
				};
				let entry = RawDirEntry { name: name.into(), file_type, mtime, size };
				if emit(entry).map_err(ReadDirError::Walk)? == ReadDirControl::Stop {
					return Ok(ReadDirControl::Stop);
				}
				if info.NextEntryOffset == 0 {
					break;
				}
				offset = offset.saturating_add(info.NextEntryOffset as usize);
			}
		}
		Ok(ReadDirControl::Continue)
	}

	fn open_dir(path: &Path) -> io::Result<HandleGuard> {
		let mut path: Vec<u16> = path.as_os_str().encode_wide().collect();
		path.push(0);
		// SAFETY: `path` is NUL-terminated; the returned handle is owned by
		// `HandleGuard` on success.
		let handle = unsafe {
			CreateFileW(
				path.as_ptr(),
				FILE_LIST_DIRECTORY,
				FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
				std::ptr::null(),
				OPEN_EXISTING,
				FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
				std::ptr::null_mut(),
			)
		};
		if handle == INVALID_HANDLE_VALUE {
			Err(io::Error::last_os_error())
		} else {
			Ok(HandleGuard(handle))
		}
	}

	const fn file_type_from_attributes(attributes: u32) -> FileType {
		if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			FileType::Symlink
		} else if attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
			FileType::Dir
		} else {
			FileType::File
		}
	}

	fn mtime_from_filetime(filetime: i64) -> Option<f64> {
		let ticks = filetime.checked_sub(UNIX_EPOCH_AS_FILETIME)?;
		let seconds = ticks / WINDOWS_TICK;
		let nanos = (ticks % WINDOWS_TICK) * 100;
		mtime_millis(seconds, nanos)
	}

	fn invalid_data(message: &'static str) -> io::Error {
		io::Error::new(io::ErrorKind::InvalidData, message)
	}
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
mod platform {
	use std::{borrow::Cow, io, path::Path};

	use super::{FileType, RawDirEntry, ReadDirControl, ReadDirError, WalkDetail, WalkError};

	pub const CHEAP_SIZE_HINTS: bool = false;

	pub fn read_dir_entries<F, E>(
		path: &Path,
		detail: WalkDetail,
		_buffer: &mut Vec<u8>,
		mut emit: F,
	) -> std::result::Result<ReadDirControl, ReadDirError<E>>
	where
		F: FnMut(RawDirEntry<'_>) -> std::result::Result<ReadDirControl, WalkError<E>>,
	{
		let read_dir = std::fs::read_dir(path)?;
		for entry in read_dir {
			let entry = entry?;
			let file_type_res = entry.file_type();
			let file_type = match file_type_res {
				Ok(ft) => ft,
				Err(err) if is_skippable_entry_error(&err) => continue,
				Err(err) => return Err(err.into()),
			};
			let custom_file_type = if file_type.is_symlink() {
				Some(FileType::Symlink)
			} else if file_type.is_dir() {
				Some(FileType::Dir)
			} else if file_type.is_file() {
				Some(FileType::File)
			} else {
				None
			};
			let Some(custom_file_type) = custom_file_type else {
				continue; // skip unsupported special files
			};

			let mut mtime = None;
			let mut size = None;
			if detail == WalkDetail::Full {
				match std::fs::symlink_metadata(entry.path()) {
					Ok(metadata) => {
						if custom_file_type == FileType::File {
							size = Some(metadata.len() as f64);
						}
						mtime = metadata
							.modified()
							.ok()
							.and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
							.map(|duration| duration.as_millis() as f64);
					},
					Err(err) if is_skippable_entry_error(&err) => continue,
					Err(err) => return Err(err.into()),
				}
			}

			let raw_entry = RawDirEntry {
				name: Cow::Owned(entry.file_name()),
				file_type: custom_file_type,
				mtime,
				size,
			};

			if emit(raw_entry).map_err(ReadDirError::Walk)? == ReadDirControl::Stop {
				return Ok(ReadDirControl::Stop);
			}
		}
		Ok(ReadDirControl::Continue)
	}

	fn is_skippable_entry_error(err: &io::Error) -> bool {
		matches!(err.kind(), io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied)
	}
}

#[cfg(test)]
mod tests {
	use std::{
		fs,
		path::PathBuf,
		time::{Duration, SystemTime, UNIX_EPOCH},
	};

	use super::*;

	struct TempTree {
		root: PathBuf,
	}

	impl TempTree {
		fn path(&self) -> &Path {
			&self.root
		}
	}

	impl Drop for TempTree {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.root);
		}
	}

	fn temp_tree(name: &str) -> TempTree {
		let unique = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("system time should be after UNIX_EPOCH")
			.as_nanos();
		let root = std::env::temp_dir().join(format!("pi-walker-{name}-{unique}"));
		fs::create_dir_all(&root).expect("temp root should be created");
		TempTree { root }
	}

	struct CachePathGuard {
		root: PathBuf,
	}

	impl CachePathGuard {
		fn new(root: &Path) -> Self {
			invalidate_path(root);
			Self { root: root.to_path_buf() }
		}
	}

	impl Drop for CachePathGuard {
		fn drop(&mut self) {
			invalidate_path(&self.root);
		}
	}

	fn wait_for_nonzero_cache_age() {
		let started = std::time::Instant::now();
		while started.elapsed() < Duration::from_millis(1) {
			std::thread::yield_now();
		}
	}

	fn test_options() -> WalkOptions {
		WalkOptions {
			include_hidden:    true,
			use_gitignore:     false,
			skip_git:          true,
			skip_node_modules: true,
			follow_links:      FollowLinks::Never,
			detail:            WalkDetail::Minimal,
			order:             WalkOrder::Path,
			emit_root:         false,
			min_depth:         1,
			max_depth:         usize::MAX,
			contents_first:    false,
			directory_errors:  DirectoryErrorMode::SkipSkippable,
			same_file_system:  false,
			cache:             false,
		}
	}

	fn collect_file_paths(root: &Path, use_gitignore: bool) -> Vec<String> {
		WalkRequest::from_options(root, WalkOptions { use_gitignore, ..test_options() })
			.filter(WalkFilter::files_only())
			.collect()
			.expect("walk should collect successfully")
			.entries
			.into_iter()
			.map(|entry| entry.path)
			.collect()
	}

	#[test]
	fn parent_ignore_outside_repo_does_not_filter_explicit_root() {
		let tree = temp_tree("parent-ignore-outside-repo");
		fs::write(tree.path().join(".gitignore"), "*.nix\n")
			.expect("parent gitignore should be written");
		let project = tree.path().join("projects").join("home-manager");
		fs::create_dir_all(project.join("modules").join("common"))
			.expect("project modules should be created");
		fs::write(project.join("flake.nix"), "flake").expect("flake should be written");
		fs::write(project.join("modules").join("common").join("zsh.nix"), "zsh")
			.expect("module should be written");

		let paths = collect_file_paths(&project, true);

		assert_eq!(
			paths,
			vec!["flake.nix", "modules/common/zsh.nix"],
			"an explicit non-repo search root must not inherit ignore files from unrelated parents"
		);
	}

	#[test]
	fn repo_parent_ignore_still_filters_subdirectory_root() {
		let tree = temp_tree("repo-parent-ignore");
		fs::create_dir_all(tree.path().join(".git")).expect("repo marker should be created");
		fs::write(tree.path().join(".gitignore"), "*.nix\n")
			.expect("repo gitignore should be written");
		let project = tree.path().join("projects").join("home-manager");
		fs::create_dir_all(project.join("modules").join("common"))
			.expect("project modules should be created");
		fs::write(project.join("flake.nix"), "flake").expect("flake should be written");
		fs::write(project.join("modules").join("common").join("zsh.nix"), "zsh")
			.expect("module should be written");

		let paths = collect_file_paths(&project, true);

		assert!(
			paths.is_empty(),
			"repo-root .gitignore should still apply when walking a subdirectory root, got {paths:?}"
		);
	}

	#[test]
	fn explicit_ignored_root_keeps_unrelated_parent_and_nested_ignore_rules() {
		let tree = temp_tree("explicit-ignored-root");
		fs::create_dir_all(tree.path().join(".git")).expect("repo marker should be created");
		fs::write(tree.path().join(".gitignore"), "*.log\nignored/**\n")
			.expect("repo gitignore should be written");
		let project = tree.path().join("ignored").join("package");
		let nested = project.join("nested");
		fs::create_dir_all(&nested).expect("ignored project tree should be created");
		fs::write(project.join("keep.ts"), "keep").expect("kept file should be written");
		fs::write(project.join("trace.log"), "trace").expect("parent-ignored file should be written");
		fs::write(nested.join(".gitignore"), "generated.ts\n")
			.expect("nested gitignore should be written");
		fs::write(nested.join("generated.ts"), "generated")
			.expect("nested ignored file should be written");
		fs::write(nested.join("keep.ts"), "nested keep").expect("nested kept file should be written");

		let paths = collect_file_paths(&project, true);

		assert_eq!(paths, vec!["keep.ts", "nested/.gitignore", "nested/keep.ts"]);
	}

	#[test]
	fn walk_request_files_only_returns_relative_files_and_excludes_directories() {
		let tree = temp_tree("request-files-only");
		fs::write(tree.path().join("alpha.txt"), "alpha").expect("top-level file should be written");
		fs::create_dir_all(tree.path().join("nested")).expect("nested dir should be created");
		fs::write(tree.path().join("nested").join("beta.txt"), "beta")
			.expect("nested file should be written");

		let outcome = WalkRequest::from_options(tree.path(), test_options())
			.filter(WalkFilter::files_only())
			.collect()
			.expect("files-only request should collect successfully");
		let paths = outcome
			.entries
			.iter()
			.map(|entry| entry.path.as_str())
			.collect::<Vec<_>>();

		assert_eq!(
			paths,
			vec!["alpha.txt", "nested/beta.txt"],
			"files-only requests should preserve relative file paths and exclude directory entries"
		);
		assert!(
			outcome.entries.iter().all(CollectedEntry::is_file),
			"files-only requests should not return directories or other entry kinds: {:?}",
			outcome.entries
		);
	}

	#[test]
	fn compare_depth_first_paths_orders_children_before_parent() {
		let mut paths = vec!["dir", "alpha", "dir/child", "dir/child/grandchild"];

		paths.sort_unstable_by(|left, right| compare_depth_first_paths(left, right));

		assert_eq!(
			paths,
			vec!["alpha", "dir/child/grandchild", "dir/child", "dir"],
			"depth-first ordering should keep lexical siblings stable while placing descendants \
			 before ancestors"
		);
	}

	#[test]
	fn walk_request_collect_contents_first_uses_collected_fallback() {
		let tree = temp_tree("request-contents-first");
		fs::create_dir_all(tree.path().join("nested")).expect("nested dir should be created");
		fs::write(tree.path().join("nested").join("leaf.txt"), "leaf")
			.expect("nested file should be written");

		let outcome = WalkRequest::from_options(tree.path(), test_options())
			.visit_order(VisitOrder::ContentsFirst)
			.collect()
			.expect("contents-first request should collect through high-level fallback");
		let paths = outcome
			.entries
			.iter()
			.map(|entry| entry.path.as_str())
			.collect::<Vec<_>>();

		assert_eq!(
			paths,
			vec!["nested/leaf.txt", "nested"],
			"contents-first collection should replay children before their directory"
		);
	}

	#[test]
	fn walk_request_stream_fallback_preserves_predicate_skip_descend() {
		struct RecordingVisitor {
			paths: Vec<String>,
		}

		impl EntryVisitor for RecordingVisitor {
			type Error = Infallible;

			fn visit(&mut self, entry: Entry<'_>) -> std::result::Result<WalkControl, Self::Error> {
				self.paths.push(entry.relative.to_string());
				Ok(WalkControl::Continue)
			}
		}

		let tree = temp_tree("request-stream-skip-descend");
		fs::create_dir_all(tree.path().join("keep")).expect("keep dir should be created");
		fs::write(tree.path().join("keep").join("leaf.txt"), "leaf")
			.expect("kept leaf should be written");
		fs::create_dir_all(tree.path().join("skip")).expect("skip dir should be created");
		fs::write(tree.path().join("skip").join("hidden.txt"), "hidden")
			.expect("skipped leaf should be written");

		let mut visitor = RecordingVisitor { paths: Vec::new() };
		let status = WalkRequest::from_options(tree.path(), test_options())
			.visit_order(VisitOrder::ContentsFirst)
			.stream_with_predicate(&mut visitor, |meta: &EntryMeta<'_>| {
				if meta.relative_path == "skip" {
					WalkDecision::SkipDescend
				} else {
					WalkDecision::Include
				}
			})
			.expect("contents-first stream fallback should complete");

		assert_eq!(status, WalkStatus::Complete);
		assert_eq!(
			visitor.paths,
			vec!["keep/leaf.txt", "keep"],
			"predicate SkipDescend should prune the skipped directory and its descendants before \
			 contents-first replay"
		);
	}

	#[test]
	fn walk_request_collect_with_heartbeat_propagates_interruptions() {
		let tree = temp_tree("request-heartbeat");
		fs::write(tree.path().join("alpha.txt"), "alpha").expect("file should be written");

		let result = WalkRequest::from_options(tree.path(), test_options())
			.collect_with_heartbeat(|| Err("stop requested"));

		let Err(WalkError::Interrupted(message)) = result else {
			panic!("heartbeat interruption should be surfaced as WalkError::Interrupted");
		};
		assert_eq!(message, "stop requested");
	}

	#[test]
	fn walk_request_rechecks_stale_empty_cached_files_only_result() {
		let tree = temp_tree("request-empty-recheck");
		let _cache_guard = CachePathGuard::new(tree.path());
		let request = WalkRequest::from_options(tree.path(), test_options())
			.cache(true)
			.filter(WalkFilter::files_only())
			.empty_recheck(EmptyRecheck::Never);

		let primed = request
			.collect()
			.expect("empty request should collect successfully");
		assert_eq!(primed.backend, WalkBackend::Fresh);
		assert!(
			primed.entries.is_empty(),
			"empty root should prime an empty files-only cache entry, got {:?}",
			primed.entries
		);

		fs::write(tree.path().join("created.txt"), "created")
			.expect("file created after cache prime should be written");
		wait_for_nonzero_cache_age();

		let stale = request
			.collect()
			.expect("empty recheck disabled request should read the cached empty result");
		assert_eq!(stale.backend, WalkBackend::Cached);
		assert!(
			stale.stats.cache_age_ms > 0,
			"cached empty result should be old enough to exercise empty recheck"
		);
		assert!(
			stale.entries.is_empty(),
			"disabled empty recheck should leave the cached empty files-only result untouched"
		);

		let refreshed = request
			.empty_recheck(EmptyRecheck::AfterMillis(0))
			.collect()
			.expect("stale empty cache should be rechecked without manual invalidation");
		let paths = refreshed
			.entries
			.iter()
			.map(|entry| entry.path.as_str())
			.collect::<Vec<_>>();

		assert_eq!(
			refreshed.backend,
			WalkBackend::Fresh,
			"stale empty cache recheck should force a fresh scan"
		);
		assert_eq!(
			paths,
			vec!["created.txt"],
			"empty cached files-only requests should observe files created after the cache was primed"
		);
		assert!(
			refreshed.entries.iter().all(CollectedEntry::is_file),
			"files-only empty recheck should still return only files: {:?}",
			refreshed.entries
		);
	}

	#[test]
	fn walk_request_rechecks_stale_cache_empty_after_glob_filter() {
		let tree = temp_tree("request-filtered-empty-recheck");
		let _cache_guard = CachePathGuard::new(tree.path());
		fs::write(tree.path().join("old.txt"), "old")
			.expect("nonmatching file should be written before cache prime");
		let request = WalkRequest::from_options(tree.path(), test_options())
			.cache(true)
			.filter(
				WalkFilter::files_only()
					.glob(CompiledWalkGlob::new(["*.rs"]).expect("test glob should compile")),
			)
			.empty_recheck(EmptyRecheck::Never);

		let primed = request
			.collect()
			.expect("filtered request should prime the raw nonempty cache successfully");
		assert_eq!(primed.backend, WalkBackend::Fresh);
		assert_eq!(
			primed.stats.scanned_entries, 1,
			"cache prime should scan the nonmatching file before filtering"
		);
		assert_eq!(
			primed.stats.filtered_entries, 1,
			"glob filter should remove the nonmatching cached file"
		);
		assert!(
			primed.entries.is_empty(),
			"nonmatching file should leave the filtered prime result empty: {:?}",
			primed.entries
		);

		fs::write(tree.path().join("new.rs"), "new")
			.expect("matching file should be written after cache prime");
		wait_for_nonzero_cache_age();

		let refreshed = request
			.empty_recheck(EmptyRecheck::AfterMillis(0))
			.collect()
			.expect("filtered empty cached result should be rechecked without manual invalidation");
		let paths = refreshed
			.entries
			.iter()
			.map(|entry| entry.path.as_str())
			.collect::<Vec<_>>();

		assert_eq!(
			refreshed.backend,
			WalkBackend::Fresh,
			"stale cache that is empty only after filtering should force a fresh scan"
		);
		assert_eq!(
			paths,
			vec!["new.rs"],
			"filtered empty-cache recheck should return the file that matches the glob"
		);
		assert!(
			refreshed.entries.iter().all(CollectedEntry::is_file),
			"glob-filtered files-only recheck should still return only files: {:?}",
			refreshed.entries
		);
	}

	#[test]
	fn collect_entries_honors_gitignore_without_repo_marker() {
		let tree = temp_tree("plain-gitignore");
		fs::write(tree.path().join(".gitignore"), "ignored.txt\n")
			.expect(".gitignore should be written");
		fs::write(tree.path().join("ignored.txt"), "ignored")
			.expect("ignored file should be written");
		fs::write(tree.path().join("kept.txt"), "keep").expect("kept file should be written");

		let scan = collect_entries(
			tree.path(),
			WalkOptions { use_gitignore: true, cache: false, ..test_options() },
			|| Ok::<(), Infallible>(()),
		)
		.expect("collection should not fail");
		let paths = scan
			.entries
			.into_iter()
			.map(|entry| entry.path)
			.collect::<Vec<_>>();

		assert!(
			paths.iter().any(|path| path == "kept.txt"),
			"collect_entries should include kept.txt from a plain directory, got: {paths:?}"
		);
		assert!(
			!paths.iter().any(|path| path == "ignored.txt"),
			"collect_entries should exclude .gitignore matches without a .git marker, got: {paths:?}"
		);
	}

	#[test]
	fn collect_entries_ignores_parent_gitignore_above_non_repo_root() {
		let tree = temp_tree("ancestor-gitignore-non-repo-root");
		let search_root = tree.path().join("project");
		fs::create_dir_all(&search_root).expect("explicit search root should be created");
		fs::write(tree.path().join(".gitignore"), "*.nix\n")
			.expect("ancestor .gitignore should be written");
		fs::write(search_root.join("module.nix"), "nix").expect("nix file should be written");
		fs::write(search_root.join("kept.txt"), "keep").expect("kept file should be written");

		let scan = collect_entries(
			&search_root,
			WalkOptions { use_gitignore: true, cache: false, ..test_options() },
			|| Ok::<(), Infallible>(()),
		)
		.expect("collection should not fail");
		let paths = scan
			.entries
			.into_iter()
			.map(|entry| entry.path)
			.collect::<Vec<_>>();

		assert!(
			paths.iter().any(|path| path == "module.nix"),
			"ancestor .gitignore outside a non-repo explicit root should not hide module.nix, got: \
			 {paths:?}"
		);
		assert!(
			paths.iter().any(|path| path == "kept.txt"),
			"sanity check should include kept.txt from the explicit root, got: {paths:?}"
		);
	}

	#[test]
	fn collect_entries_applies_repo_root_gitignore_to_subdirectory_search_root() {
		let tree = temp_tree("repo-root-gitignore-subdir-root");
		let search_root = tree.path().join("src");
		fs::create_dir_all(tree.path().join(".git")).expect("repo marker should be created");
		fs::create_dir_all(&search_root).expect("explicit search root should be created");
		fs::write(tree.path().join(".gitignore"), "*.nix\n")
			.expect("repo-root .gitignore should be written");
		fs::write(search_root.join("module.nix"), "nix").expect("ignored nix file should be written");
		fs::write(search_root.join("kept.txt"), "keep").expect("kept file should be written");

		let scan = collect_entries(
			&search_root,
			WalkOptions { use_gitignore: true, cache: false, ..test_options() },
			|| Ok::<(), Infallible>(()),
		)
		.expect("collection should not fail");
		let paths = scan
			.entries
			.into_iter()
			.map(|entry| entry.path)
			.collect::<Vec<_>>();

		assert!(
			!paths.iter().any(|path| path == "module.nix"),
			"repo-root .gitignore should hide module.nix when searching inside that repo, got: \
			 {paths:?}"
		);
		assert!(
			paths.iter().any(|path| path == "kept.txt"),
			"repo subdirectory search should still include nonignored files, got: {paths:?}"
		);
	}

	#[test]
	fn collect_entries_with_exact_workspace_options() {
		let tree = temp_tree("exact-options");
		fs::write(tree.path().join(".gitignore"), "ignored.txt\n")
			.expect(".gitignore should be written");
		fs::write(tree.path().join("ignored.txt"), "ignored")
			.expect("ignored file should be written");
		fs::write(tree.path().join("kept.txt"), "keep").expect("kept file should be written");

		let scan = collect_entries(
			tree.path(),
			WalkOptions {
				include_hidden: false,
				use_gitignore: true,
				detail: WalkDetail::Full,
				max_depth: 4,
				..test_options()
			},
			|| Ok::<(), Infallible>(()),
		)
		.expect("collection should not fail");
		let paths = scan
			.entries
			.into_iter()
			.map(|entry| entry.path)
			.collect::<Vec<_>>();

		assert!(
			!paths.iter().any(|path| path == "ignored.txt"),
			"should exclude ignored.txt, got: {paths:?}"
		);
	}

	#[test]
	fn collect_entries_prunes_hidden_git_and_node_modules() {
		let tree = temp_tree("filters");
		fs::write(tree.path().join("visible.txt"), "ok").expect("visible file should be written");
		fs::write(tree.path().join(".hidden"), "hidden").expect("hidden file should be written");
		fs::create_dir_all(tree.path().join(".git")).expect(".git should be created");
		fs::write(tree.path().join(".git").join("config"), "git")
			.expect("git file should be written");
		fs::create_dir_all(tree.path().join("node_modules")).expect("node_modules should be created");
		fs::write(tree.path().join("node_modules").join("pkg.js"), "pkg")
			.expect("node module file should be written");

		let scan = collect_entries(
			tree.path(),
			WalkOptions { include_hidden: false, ..test_options() },
			|| Ok::<(), Infallible>(()),
		)
		.expect("collection should not fail");
		let paths = scan
			.entries
			.into_iter()
			.map(|entry| entry.path)
			.collect::<Vec<_>>();
		assert_eq!(paths, vec!["visible.txt"]);
	}

	struct PruneVisitor {
		seen: Vec<String>,
	}

	impl EntryVisitor for PruneVisitor {
		type Error = Infallible;

		fn visit(&mut self, entry: Entry<'_>) -> std::result::Result<WalkControl, Self::Error> {
			self.seen.push(entry.relative.to_string());
			if entry.relative == "skip" {
				Ok(WalkControl::SkipDescend)
			} else {
				Ok(WalkControl::Continue)
			}
		}
	}

	#[cfg(unix)]
	struct PathsVisitor {
		seen: Vec<String>,
	}

	#[cfg(unix)]
	impl EntryVisitor for PathsVisitor {
		type Error = Infallible;

		fn visit(&mut self, entry: Entry<'_>) -> std::result::Result<WalkControl, Self::Error> {
			self.seen.push(entry.relative.to_string());
			Ok(WalkControl::Continue)
		}
	}

	#[cfg(unix)]
	fn walk_paths(root: &Path, follow_links: FollowLinks) -> Vec<String> {
		let mut visitor = PathsVisitor { seen: Vec::new() };
		let status =
			walk_entries(root, WalkOptions { follow_links, ..test_options() }, &mut visitor, || {
				Ok::<(), Infallible>(())
			})
			.expect("walk should not fail");
		assert_eq!(status, WalkStatus::Complete);
		visitor.seen
	}

	#[test]
	fn skip_descend_prunes_directory_children() {
		let tree = temp_tree("skip-descend");
		fs::create_dir_all(tree.path().join("keep")).expect("keep dir should be created");
		fs::write(tree.path().join("keep").join("file.txt"), "ok")
			.expect("keep file should be written");
		fs::create_dir_all(tree.path().join("skip")).expect("skip dir should be created");
		fs::write(tree.path().join("skip").join("file.txt"), "no")
			.expect("skip file should be written");

		let mut visitor = PruneVisitor { seen: Vec::new() };
		let _status =
			walk_entries(tree.path(), test_options(), &mut visitor, || Ok::<(), Infallible>(()))
				.expect("walk should not fail");
		assert!(visitor.seen.iter().any(|path| path == "skip"));
		assert!(visitor.seen.iter().any(|path| path == "keep/file.txt"));
		assert!(!visitor.seen.iter().any(|path| path == "skip/file.txt"));
	}

	#[cfg(unix)]
	#[test]
	fn walk_entries_always_follows_descendant_symlink_directories() {
		let tree = temp_tree("follow-always");
		fs::create_dir_all(tree.path().join("target")).expect("target dir should be created");
		fs::write(tree.path().join("target").join("child.txt"), "ok")
			.expect("target child should be written");
		std::os::unix::fs::symlink(tree.path().join("target"), tree.path().join("link"))
			.expect("directory symlink should be created");

		let paths = walk_paths(tree.path(), FollowLinks::Always);

		assert!(
			paths.iter().any(|path| path == "link/child.txt"),
			"FollowLinks::Always should yield descendants through symlink paths, got: {paths:?}"
		);
	}

	#[cfg(unix)]
	#[test]
	fn walk_entries_roots_follows_root_symlink_but_not_descendant_symlinks() {
		let target = temp_tree("follow-roots-target");
		fs::write(target.path().join("child.txt"), "ok").expect("root child should be written");

		let linked_target = temp_tree("follow-roots-linked-target");
		fs::write(linked_target.path().join("linked-child.txt"), "linked")
			.expect("linked child should be written");
		std::os::unix::fs::symlink(linked_target.path(), target.path().join("descendant-link"))
			.expect("descendant directory symlink should be created");

		let link_parent = temp_tree("follow-roots-link-parent");
		let root_link = link_parent.path().join("root-link");
		std::os::unix::fs::symlink(target.path(), &root_link)
			.expect("root directory symlink should be created");

		let paths = walk_paths(&root_link, FollowLinks::Roots);

		assert!(
			paths.iter().any(|path| path == "child.txt"),
			"FollowLinks::Roots should traverse children of a symlink root, got: {paths:?}"
		);
		assert!(
			!paths
				.iter()
				.any(|path| path == "descendant-link/linked-child.txt"),
			"FollowLinks::Roots should not traverse descendant symlink directories, got: {paths:?}"
		);
	}

	#[cfg(unix)]
	#[test]
	fn walk_entries_never_does_not_follow_root_symlink_directory() {
		let target = temp_tree("follow-never-target");
		fs::write(target.path().join("child.txt"), "ok").expect("root child should be written");

		let link_parent = temp_tree("follow-never-link-parent");
		let root_link = link_parent.path().join("root-link");
		std::os::unix::fs::symlink(target.path(), &root_link)
			.expect("root directory symlink should be created");

		let paths = walk_paths(&root_link, FollowLinks::Never);

		assert!(
			!paths.iter().any(|path| path == "child.txt"),
			"FollowLinks::Never should not traverse a symlink root, got: {paths:?}"
		);
	}
}
