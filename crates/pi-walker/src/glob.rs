//! Path selection in pi's glob dialect, and the glob search behind the `glob`
//! native.
//!
//! A [`Selector`] is a path glob as every search tool reads it: [`glob`]
//! selects entries with it, [`crate::grep`] and ast-grep discovery restrict the
//! files they read with it, so one pattern means the same paths everywhere.
//! Patterns use [`crate::pattern`] syntax against `/`-separated walk-relative
//! paths, after pi's normalisation: backslashes become `/`, unclosed `{`
//! groups are closed, and in recursive mode a pattern without `/` that does
//! not start with `**` (and is not an exact brace union) matches at any
//! depth, as if prefixed with `**/`. The same compiled glob also prunes the
//! walk: no deeper than the pattern reaches, never into subtrees no match can
//! be in, and into `node_modules` whenever the pattern names it.
//!
//! ```ignore
//! let found = glob::glob(&fs, root, &GlobOptions {
//!     pattern: "*.rs".into(),
//!     recursive: true,
//!     walk: walk::Options { gitignore: true, ..Default::default() },
//!     ..Default::default()
//! }).await?;
//! ```

use std::{cmp::Ordering, fmt, path::Path};

use crate::{
	fs::{Detail, FileType, Fs},
	pattern::{Glob, PatternError},
	walk::{self, Action, Entry, WalkError},
};

/// A compiled path glob in pi's dialect.
#[derive(Clone, Debug)]
pub struct Selector {
	glob:         Glob,
	/// The glob looks beyond base names, so subtrees can be pruned.
	prune:        bool,
	node_modules: bool,
}

/// pi's normalisation: backslashes become `/`, a recursive pattern without
/// `/` that neither starts with `**` nor is an exact brace union gets a
/// `**/` prefix, and unclosed `{` groups are closed.
fn build_pattern(pattern: &str, recursive: bool) -> String {
	let normalized = pattern.replace('\\', "/");
	let mut out = if !recursive
		|| normalized.contains('/')
		|| normalized.starts_with("**")
		|| is_exact_brace_union(&normalized)
	{
		normalized
	} else {
		format!("**/{normalized}")
	};
	let opens = out.bytes().filter(|&b| b == b'{').count();
	let closes = out.bytes().filter(|&b| b == b'}').count();
	out.extend(std::iter::repeat_n('}', opens.saturating_sub(closes)));
	out
}

/// `{a,b}` whose alternatives hold no wildcard, class, or nested group.
fn is_exact_brace_union(pattern: &str) -> bool {
	let Some(inner) = pattern.strip_circumfix('{', '}') else {
		return false;
	};
	!inner.is_empty() && !inner.contains(['*', '?', '[', ']', '{', '}'])
}

impl Selector {
	fn compile(glob: Glob, node_modules: bool) -> Self {
		Self { prune: !glob.basename_only(), glob, node_modules }
	}

	/// Entries whose walk-relative path matches `pattern` (the glob tool).
	pub fn new(pattern: &str, recursive: bool) -> Result<Self, PatternError> {
		let built = build_pattern(pattern, recursive);
		Ok(Self::compile(Glob::new(&built)?, built.contains("node_modules")))
	}

	/// Files a content search scoped by `pattern` reads (grep, ast-grep):
	/// files it matches plus every file under a directory it matches, so
	/// `{src,test}` or `sr?` search those directories; `dir/*.ts` stays
	/// limited to `dir`'s direct children.
	pub fn scope(pattern: &str, recursive: bool) -> Result<Self, PatternError> {
		let built = build_pattern(pattern, recursive);
		let glob = Glob::new(&built)?;
		let base = built.trim_end_matches('/');
		let glob = if base == "**" || base.ends_with("/**") {
			glob
		} else {
			Glob::union([glob, Glob::new(&format!("{base}/**"))?])
		};
		Ok(Self::compile(glob, built.contains("node_modules")))
	}

	/// Entries a content search leaves out (grep's `exclude`): a pattern
	/// without `/` matches at any depth (`*.test.ts`, `vendor`), a leading
	/// `/` anchors it to the root (`/vendor`), trailing slashes are ignored,
	/// and a matched directory is not entered. `None` when no pattern is
	/// left after trimming.
	pub fn exclude<P: AsRef<str>>(patterns: &[P]) -> Result<Option<Self>, PatternError> {
		let mut globs = Vec::new();
		for pattern in patterns {
			let pattern = pattern.as_ref().trim().replace('\\', "/");
			let pattern = pattern.trim_end_matches('/');
			if pattern.is_empty() {
				continue;
			}
			let built = match pattern.strip_prefix('/') {
				Some(anchored) => anchored.to_owned(),
				// Slashless patterns match at any depth, exact brace unions
				// (`{vendor,gen}`) included.
				None if !pattern.contains('/') && !pattern.starts_with("**") => {
					build_pattern(&format!("**/{pattern}"), true)
				},
				None => build_pattern(pattern, true),
			};
			globs.push(Glob::new(&built)?);
		}
		if globs.is_empty() {
			return Ok(None);
		}
		Ok(Some(Self::compile(Glob::union(globs), false)))
	}

	/// Whether the walk-relative `path` is selected.
	pub fn matches(&self, path: &[u8]) -> bool {
		self.glob.is_match(path)
	}

	/// Whether nothing strictly below directory `dir` can be selected, so a
	/// walk may skip its subtree.
	pub fn prunes(&self, dir: &[u8]) -> bool {
		self.prune && !self.glob.may_match_under(dir)
	}

	/// Deepest depth a selected entry can have, `None` when unbounded.
	pub fn max_depth(&self) -> Option<usize> {
		self.glob.max_depth()
	}

	/// The pattern names `node_modules`, so walks must descend into it.
	pub const fn mentions_node_modules(&self) -> bool {
		self.node_modules
	}
}

/// Options of a [`glob`] search.
#[derive(Clone, Debug, Default)]
pub struct GlobOptions {
	/// Pattern; empty or whitespace-only means `*`.
	pub pattern:              String,
	/// See [`Selector::new`].
	pub recursive:            bool,
	/// Keep only entries of this type. With `File` or `Dir`, a symlink whose
	/// target has that type counts as one and is reported with the target's
	/// type, size, and mtime; dangling links are dropped. Without a filter
	/// symlinks are reported as [`FileType::Symlink`].
	pub file_type:            Option<FileType>,
	/// Return at most this many matches; `Some(0)` returns nothing without
	/// walking.
	pub max_results:          Option<usize>,
	/// Newest first (by millisecond, ties by path) with sizes and mtimes;
	/// `max_results` then keeps the newest. Otherwise byte order of paths.
	pub sort_by_mtime:        bool,
	/// Descend into `node_modules`; `None` does so when the pattern names it.
	pub include_node_modules: Option<bool>,
	/// Traversal: `hidden`, `gitignore`, `follow_links`, `cache`, `workers`
	/// are honoured; `.git` is always pruned, and detail, depth, and
	/// `node_modules` pruning follow the pattern and the options above.
	pub walk:                 walk::Options,
}

/// One [`glob`] match.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GlobMatch {
	/// Walk-relative path, `/`-separated, invalid UTF-8 replaced.
	pub path:      String,
	/// Entry type (a resolved symlink's target type under a type filter).
	pub file_type: FileType,
	/// Regular-file size, under `sort_by_mtime` or symlink resolution.
	pub size:      Option<u64>,
	/// Modification time in Unix nanoseconds, under `sort_by_mtime` or
	/// symlink resolution.
	pub mtime:     Option<i64>,
}

/// Why a [`glob`] failed.
#[derive(Debug)]
pub enum GlobError {
	/// The pattern is malformed.
	Pattern(PatternError),
	/// The walk failed.
	Walk(WalkError),
}

impl fmt::Display for GlobError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Pattern(err) => write!(f, "Invalid glob pattern: {err}"),
			Self::Walk(err) => err.fmt(f),
		}
	}
}

impl std::error::Error for GlobError {}

/// Finds the entries below `root` matching `opts.pattern`.
///
/// # Errors
/// A malformed pattern or an unreadable root.
pub async fn glob(fs: &Fs, root: &Path, opts: &GlobOptions) -> Result<Vec<GlobMatch>, GlobError> {
	let pattern = match opts.pattern.trim() {
		"" => "*",
		pattern => pattern,
	};
	let selector = Selector::new(pattern, opts.recursive).map_err(GlobError::Pattern)?;
	if opts.max_results == Some(0) {
		return Ok(Vec::new());
	}
	let depth = match (selector.max_depth(), opts.walk.max_depth) {
		(Some(a), Some(b)) => Some(a.min(b)),
		(a, b) => a.or(b),
	};
	let wopts = walk::Options {
		skip_git: true,
		skip_node_modules: !opts.include_node_modules.unwrap_or(selector.node_modules),
		detail: if opts.sort_by_mtime {
			Detail::Full
		} else {
			Detail::Minimal
		},
		max_depth: depth,
		..opts.walk.clone()
	};
	let file_type = opts.file_type;
	let entries = walk::collect(fs, root, &wopts, !opts.sort_by_mtime, move |_, entry| {
		if selector.matches(entry.path) && wanted(file_type, entry) {
			return Action::Continue;
		}
		if entry.file_type == FileType::Dir && selector.prunes(entry.path) {
			Action::SkipDir
		} else {
			Action::Skip
		}
	})
	.await
	.map_err(GlobError::Walk)?;

	let mut order: Vec<Entry<'_>> = entries.iter().collect();
	if let Some(filter) = file_type.filter(|&filter| filter != FileType::Symlink) {
		resolve_links(fs, root, filter, &mut order).await;
	}
	if opts.sort_by_mtime {
		let limit = opts.max_results.unwrap_or(usize::MAX);
		if limit < order.len() {
			order.select_nth_unstable_by(limit - 1, newer_first);
			order.truncate(limit);
		}
		order.sort_unstable_by(newer_first);
	} else if let Some(limit) = opts.max_results {
		order.truncate(limit);
	}
	let resolved = file_type.is_some();
	Ok(order
		.into_iter()
		.map(|entry| {
			let detailed = opts.sort_by_mtime || resolved;
			GlobMatch {
				path:      entry.path_lossy().into_owned(),
				file_type: entry.file_type,
				size:      entry
					.size
					.filter(|_| detailed && entry.file_type == FileType::File),
				mtime:     entry.mtime.filter(|_| detailed),
			}
		})
		.collect())
}

/// Whether a matching entry can pass the type filter: an entry of that type,
/// or (for a file or directory filter) a symlink to check against its target
/// in [`resolve_links`].
fn wanted(filter: Option<FileType>, entry: &Entry<'_>) -> bool {
	let Some(filter) = filter else {
		return true;
	};
	entry.file_type == filter
		|| (entry.file_type == FileType::Symlink && filter != FileType::Symlink)
}

/// Rewrites each symlink kept for its target's type to describe the target
/// (type, size, mtime); dangling links and links to the other type are
/// dropped.
async fn resolve_links(fs: &Fs, root: &Path, filter: FileType, order: &mut Vec<Entry<'_>>) {
	let mut session = fs.session();
	let mut kept = Vec::with_capacity(order.len());
	for mut entry in order.drain(..) {
		if entry.file_type == FileType::Symlink {
			let abs = fs.join(root, entry.path);
			let Ok(info) = session.stat(&abs, true).await else {
				continue;
			};
			if info.file_type != Some(filter) {
				continue;
			}
			entry.file_type = filter;
			entry.size = (filter == FileType::File).then_some(info.size);
			entry.mtime = Some(info.stamp.mtime);
		}
		kept.push(entry);
	}
	*order = kept;
}

/// Newest first by millisecond, ties (and equal milliseconds) by path.
fn newer_first(a: &Entry<'_>, b: &Entry<'_>) -> Ordering {
	let millis = |e: &Entry<'_>| e.mtime.unwrap_or(0).div_euclid(1_000_000);
	millis(b).cmp(&millis(a)).then_with(|| a.path.cmp(b.path))
}

#[cfg(test)]
mod tests {
	use std::{
		fs,
		path::{Path, PathBuf},
		sync::atomic::{AtomicU64, Ordering},
		time::{Duration, SystemTime, UNIX_EPOCH},
	};

	use super::{GlobError, GlobMatch, GlobOptions, Selector, build_pattern, glob};
	use crate::{
		fs::{FileType, Fs},
		walk,
	};

	struct TempDir(PathBuf);

	impl TempDir {
		fn new() -> Self {
			static COUNTER: AtomicU64 = AtomicU64::new(0);
			let nanos = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.map_or(0, |d| d.as_nanos());
			let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
			let path = std::env::temp_dir()
				.join(format!("pi-walker-glob-{}-{nanos}-{seq}", std::process::id()));
			fs::create_dir_all(&path).expect("create temp dir");
			Self(path.canonicalize().expect("canonical temp dir"))
		}

		fn path(&self) -> &Path {
			&self.0
		}

		fn write(&self, rel: &str) -> PathBuf {
			let path = self.0.join(rel);
			fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
			fs::write(&path, rel).expect("write file");
			path
		}
	}

	impl Drop for TempDir {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	fn set_mtime(path: &Path, secs: u64, millis: u64) {
		let time = UNIX_EPOCH + Duration::from_secs(secs) + Duration::from_millis(millis);
		fs::File::options()
			.write(true)
			.open(path)
			.and_then(|file| file.set_times(fs::FileTimes::new().set_modified(time)))
			.expect("set mtime");
	}

	fn options(pattern: &str) -> GlobOptions {
		GlobOptions {
			pattern: pattern.to_owned(),
			recursive: true,
			walk: walk::Options { hidden: true, ..walk::Options::default() },
			..GlobOptions::default()
		}
	}

	async fn run(root: &Path, opts: &GlobOptions) -> Vec<GlobMatch> {
		glob(&Fs::native(), root, opts)
			.await
			.expect("glob succeeds")
	}

	fn paths(found: &[GlobMatch]) -> Vec<&str> {
		found.iter().map(|m| m.path.as_str()).collect()
	}

	#[test]
	fn patterns_are_normalised_like_pi() {
		assert_eq!(build_pattern("*.ts", true), "**/*.ts");
		assert_eq!(build_pattern("src/*.ts", true), "src/*.ts");
		assert_eq!(build_pattern("**/*.rs", true), "**/*.rs");
		assert_eq!(build_pattern("*.ts", false), "*.ts");
		assert_eq!(build_pattern("src\\**\\*.ts", true), "src/**/*.ts");
		assert_eq!(build_pattern("*.{ts,tsx,js", true), "**/*.{ts,tsx,js}");
		assert_eq!(build_pattern("{a,{b,c}", true), "**/{a,{b,c}}");
		assert_eq!(build_pattern("*.{ts,js}", true), "**/*.{ts,js}");
		assert_eq!(build_pattern("{alpha.txt,beta.txt}", true), "{alpha.txt,beta.txt}");
		assert_eq!(build_pattern("{*.ts,*.tsx}", true), "**/{*.ts,*.tsx}");
		assert!(Selector::new("*.{ts,tsx,js", true).is_ok());
	}

	#[test]
	fn recursive_mode_decides_how_deep_a_bare_pattern_matches() {
		let flat = Selector::new("*.rs", false).expect("compile");
		assert!(flat.matches(b"lib.rs"));
		assert!(!flat.matches(b"src/lib.rs"));
		assert!(!flat.matches(b"lib.ts"));
		let deep = Selector::new("*.rs", true).expect("compile");
		for path in [&b"lib.rs"[..], b"src/lib.rs", b"src/nested/lib.rs"] {
			assert!(deep.matches(path));
		}
		assert!(!deep.matches(b"src/lib.ts"));
	}

	#[test]
	fn depth_bounds_count_pattern_segments() {
		for (pattern, depth) in
			[("*", Some(1)), ("*.json", Some(1)), ("dir/*.ts", Some(2)), ("a/*/c.txt", Some(3))]
		{
			assert_eq!(
				Selector::new(pattern, false).expect("compile").max_depth(),
				depth,
				"{pattern}"
			);
		}
		for pattern in ["**/*", "src/**/*.ts", "*.rs"] {
			assert_eq!(Selector::new(pattern, true).expect("compile").max_depth(), None, "{pattern}");
		}
	}

	#[test]
	fn scope_selects_files_under_matched_directories() {
		let scope = Selector::scope("{src,test}", false).expect("compile");
		assert!(scope.matches(b"src/a/b.rs"));
		assert!(scope.matches(b"test/x.rs"));
		assert!(!scope.matches(b"docs/x.rs"));
		assert!(scope.prunes(b"docs"));
		assert!(!scope.prunes(b"src"));
		let flat = Selector::scope("dir/*.ts", false).expect("compile");
		assert!(flat.matches(b"dir/a.ts"));
		assert!(!flat.matches(b"dir/sub/a.js"));
		assert!(flat.matches(b"dir/x.ts/inner.js"), "a directory named *.ts selects its files");
	}

	#[test]
	fn exclude_patterns_match_at_any_depth_unless_anchored() {
		assert!(Selector::exclude::<&str>(&[]).expect("compile").is_none());
		assert!(Selector::exclude(&[" ", "/"]).expect("compile").is_none());
		let ex = Selector::exclude(&["vendor/", "*.test.ts", "/gen", "{a,b}"])
			.expect("compile")
			.expect("some");
		for path in [&b"vendor"[..], b"src/vendor", b"src/x.test.ts", b"gen", b"a", b"x/b"] {
			assert!(ex.matches(path), "{}", String::from_utf8_lossy(path));
		}
		for path in [&b"src/gen"[..], b"vendored", b"x.ts"] {
			assert!(!ex.matches(path), "{}", String::from_utf8_lossy(path));
		}
		assert!(Selector::exclude(&["["]).is_err());
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn node_modules_is_searched_only_when_named() {
		let dir = TempDir::new();
		dir.write("node_modules/pkg/index.js");
		dir.write("src/index.js");
		assert_eq!(paths(&run(dir.path(), &options("*.js")).await), ["src/index.js"]);
		assert_eq!(paths(&run(dir.path(), &options("node_modules/**/*.js")).await), [
			"node_modules/pkg/index.js"
		]);
		let included = GlobOptions { include_node_modules: Some(true), ..options("*.js") };
		assert_eq!(paths(&run(dir.path(), &included).await), [
			"node_modules/pkg/index.js",
			"src/index.js"
		]);
		assert!(
			Selector::new("node_modules/*", true)
				.expect("compile")
				.mentions_node_modules()
		);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn gitignore_prunes_ignored_directory_but_keeps_matching_sibling() {
		let dir = TempDir::new();
		fs::create_dir_all(dir.path().join(".git")).expect("repo marker");
		fs::write(dir.path().join(".gitignore"), "ignored/\n").expect("write gitignore");
		dir.write("ignored/drop.rs");
		dir.write("kept.rs");
		dir.write(".git/hooks.rs");
		let mut opts = GlobOptions { file_type: Some(FileType::File), ..options("*.rs") };
		opts.walk.gitignore = true;
		assert_eq!(paths(&run(dir.path(), &opts).await), ["kept.rs"]);
		opts.walk.gitignore = false;
		assert_eq!(paths(&run(dir.path(), &opts).await), ["ignored/drop.rs", "kept.rs"]);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn depth_bounded_patterns_still_match_at_their_exact_depth() {
		let dir = TempDir::new();
		dir.write("top.txt");
		dir.write("deep/child.txt");
		dir.write("deep/nested/leaf.txt");
		for sort_by_mtime in [false, true] {
			let found = async |pattern: &str| {
				let opts = GlobOptions { recursive: false, sort_by_mtime, ..options(pattern) };
				let mut found: Vec<String> = run(dir.path(), &opts)
					.await
					.into_iter()
					.map(|m| m.path)
					.collect();
				found.sort_unstable();
				found
			};
			assert_eq!(found("*.txt").await, ["top.txt"]);
			assert_eq!(found("deep/*.txt").await, ["deep/child.txt"]);
			assert_eq!(found("*/nested/leaf.txt").await, ["deep/nested/leaf.txt"]);
			assert_eq!(found("**/*.txt").await, ["deep/child.txt", "deep/nested/leaf.txt", "top.txt"]);
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn path_order_then_limit() {
		let dir = TempDir::new();
		for name in ["b.txt", "a/z.txt", "a.txt", "c/d/e.txt"] {
			dir.write(name);
		}
		let all = run(dir.path(), &options("*.txt")).await;
		assert_eq!(paths(&all), ["a.txt", "a/z.txt", "b.txt", "c/d/e.txt"]);
		assert!(all.iter().all(|m| m.size.is_none() && m.mtime.is_none()));
		let limited = GlobOptions { max_results: Some(2), ..options("*.txt") };
		assert_eq!(paths(&run(dir.path(), &limited).await), ["a.txt", "a/z.txt"]);
		let dirs = GlobOptions { file_type: Some(FileType::Dir), ..options("*") };
		assert_eq!(paths(&run(dir.path(), &dirs).await), ["a", "c", "c/d"]);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn newest_first_by_millisecond_then_path() {
		let dir = TempDir::new();
		for (name, secs, millis) in [
			("old.txt", 1_000, 0),
			("new-b.txt", 2_000, 5),
			("new-a.txt", 2_000, 5),
			("mid.txt", 1_500, 0),
			("sub/newest.txt", 3_000, 0),
		] {
			set_mtime(&dir.write(name), secs, millis);
		}
		let sorted = GlobOptions { sort_by_mtime: true, ..options("*.txt") };
		let all = run(dir.path(), &sorted).await;
		assert_eq!(paths(&all), ["sub/newest.txt", "new-a.txt", "new-b.txt", "mid.txt", "old.txt"]);
		assert_eq!(all[0].mtime, Some(3_000_000_000_000));
		assert_eq!(all[0].size, Some("sub/newest.txt".len() as u64));
		for limit in 1..=5 {
			let top =
				run(dir.path(), &GlobOptions { max_results: Some(limit), ..sorted.clone() }).await;
			assert_eq!(paths(&top), paths(&all)[..limit], "limit {limit}");
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn zero_max_results_does_not_walk() {
		let opts = GlobOptions { max_results: Some(0), ..options("*") };
		let missing = Path::new("/definitely/not/here/pi-walker");
		assert!(
			glob(&Fs::native(), missing, &opts)
				.await
				.expect("no walk")
				.is_empty()
		);
		let bad = GlobOptions { max_results: Some(0), ..options("[") };
		assert!(matches!(glob(&Fs::native(), missing, &bad).await, Err(GlobError::Pattern(_))));
		assert!(matches!(glob(&Fs::native(), missing, &options("*")).await, Err(GlobError::Walk(_))));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn provider_url_trees_list_raw_relative_paths() {
		let (_mem, vfs) = crate::testing::MemFs::with_files(&[
			("mem://root/dir/a.rs", "fn a() {}\n"),
			("mem://root/dir/a%20b.rs", "fn ab() {}\n"),
			("mem://root/dir/sub/b.rs", "fn b() {}\n"),
			("mem://root/dir/sub/c.txt", "c\n"),
			("mem://root/outside.rs", "fn outside() {}\n"),
		]);
		let fs = Fs::Provider(vfs);
		let root = Path::new("mem://root/dir");
		let found = async |opts: &GlobOptions| -> Vec<String> {
			glob(&fs, root, opts)
				.await
				.expect("glob")
				.into_iter()
				.map(|m| m.path)
				.collect()
		};
		assert_eq!(found(&options("*.rs")).await, ["a b.rs", "a.rs", "sub/b.rs"]);
		assert_eq!(found(&GlobOptions { file_type: Some(FileType::Dir), ..options("*") }).await, [
			"sub"
		]);
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn file_filtered_symlinks_keep_target_metadata_and_exclude_dangling_links() {
		let dir = TempDir::new();
		fs::create_dir(dir.path().join("scope")).expect("create scope");
		let target = dir.path().join("target.ts");
		fs::write(&target, "source\n").expect("write source");
		set_mtime(&target, 1_600_000_000, 0);
		std::os::unix::fs::symlink(&target, dir.path().join("scope/source.ts")).expect("link");
		std::os::unix::fs::symlink(dir.path().join("missing"), dir.path().join("scope/dangling.ts"))
			.expect("dangling link");
		std::os::unix::fs::symlink(dir.path(), dir.path().join("scope/up")).expect("dir link");
		for sort_by_mtime in [false, true] {
			let opts = GlobOptions {
				file_type: Some(FileType::File),
				recursive: false,
				sort_by_mtime,
				..options("*")
			};
			let found = run(&dir.path().join("scope"), &opts).await;
			assert_eq!(found, [GlobMatch {
				path:      "source.ts".to_owned(),
				file_type: FileType::File,
				size:      Some(7),
				mtime:     Some(1_600_000_000_000_000_000),
			}]);
			let dirs = GlobOptions { file_type: Some(FileType::Dir), ..opts };
			assert_eq!(paths(&run(&dir.path().join("scope"), &dirs).await), ["up"]);
		}
		let untyped = GlobOptions { recursive: false, ..options("*") };
		let found = run(&dir.path().join("scope"), &untyped).await;
		assert!(found.iter().all(|m| m.file_type == FileType::Symlink), "{found:?}");
		assert_eq!(found.len(), 3);
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn follows_descendant_links_only_when_requested_and_stops_cycles() {
		let dir = TempDir::new();
		fs::create_dir_all(dir.path().join("scope")).expect("create scope");
		dir.write("shared/nested/sequence.py");
		std::os::unix::fs::symlink(dir.path().join("shared"), dir.path().join("scope/link"))
			.expect("link shared");
		std::os::unix::fs::symlink(dir.path().join("scope"), dir.path().join("shared/cycle"))
			.expect("link cycle");
		for follow_links in [false, true] {
			let mut opts = GlobOptions {
				file_type: Some(FileType::File),
				sort_by_mtime: true,
				..options("**/*.py")
			};
			opts.walk.follow_links = follow_links;
			let found = run(&dir.path().join("scope"), &opts).await;
			let want: &[&str] = if follow_links {
				&["link/nested/sequence.py"]
			} else {
				&[]
			};
			assert_eq!(paths(&found), want);
		}
	}
}
