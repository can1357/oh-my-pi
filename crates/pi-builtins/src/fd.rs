//! In-process `fd` builtin backed by `pi_walker`, `globset`, and `regex`.
//!
//! Relocated from pi-shell's native implementation.

use std::{
	borrow::Cow,
	ffi::{OsStr, OsString},
	io::{self, Write},
	path::{Path, PathBuf},
	sync::Arc,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use clap::{ArgAction, Parser, ValueEnum};
use globset::{GlobBuilder, GlobMatcher};
use pi_walker::{
	Detail, FileType,
	ignore::{Match as RuleMatch, Rules},
	walk::{self, Action, Entry, WalkError, Worker},
};
use pi_vfs::Metadata;
use regex::{Regex, RegexBuilder};

use crate::host::{AsyncUtility, Host, forward_slash_display};

#[derive(Parser, Debug)]
#[command(
	name = "fd",
	version = "10.4.2",
	about = "A program to find entries in your filesystem",
	after_long_help = "Bugs can be reported on GitHub: https://github.com/sharkdp/fd/issues",
	max_term_width = 98,
	args_override_self = true
)]
pub(crate) struct FdCli {
	/// Include hidden directories and files in the search results.
	#[arg(short = 'H', long, overrides_with = "no_hidden")]
	hidden: bool,

	/// Do not include hidden directories and files.
	#[arg(long = "no-hidden", overrides_with = "hidden", hide = true)]
	no_hidden: bool,

	/// Show search results from otherwise ignored files and directories.
	#[arg(short = 'I', long = "no-ignore", overrides_with = "ignore")]
	no_ignore: bool,

	/// Respect ignore files.
	#[arg(long = "ignore", overrides_with = "no_ignore", hide = true)]
	ignore: bool,

	/// Show search results ignored by `.gitignore` files.
	#[arg(long = "no-ignore-vcs", overrides_with = "ignore_vcs")]
	no_ignore_vcs: bool,

	/// Respect `.gitignore` files.
	#[arg(long = "ignore-vcs", overrides_with = "no_ignore_vcs", hide = true)]
	ignore_vcs: bool,

	/// Respect VCS ignore files even outside a git repository.
	#[arg(long = "no-require-git", overrides_with = "require_git")]
	no_require_git: bool,

	/// Require a git repository for VCS ignore files.
	#[arg(long = "require-git", overrides_with = "no_require_git", hide = true)]
	require_git: bool,

	/// Ignore parent-directory ignore files.
	#[arg(long = "no-ignore-parent", overrides_with = "ignore_parent")]
	no_ignore_parent: bool,

	/// Respect parent-directory ignore files.
	#[arg(long = "ignore-parent", overrides_with = "no_ignore_parent", hide = true)]
	ignore_parent: bool,

	/// Perform an unrestricted search, including ignored and hidden files.
	#[arg(short = 'u', long = "unrestricted", action = ArgAction::Count)]
	unrestricted: u8,

	/// Perform a case-sensitive search.
	#[arg(short = 's', long = "case-sensitive", overrides_with = "ignore_case")]
	case_sensitive: bool,

	/// Perform a case-insensitive search.
	#[arg(short = 'i', long = "ignore-case", overrides_with = "case_sensitive")]
	ignore_case: bool,

	/// Perform a glob-based search instead of a regular expression search.
	#[arg(short = 'g', long = "glob", overrides_with = "regex", conflicts_with = "fixed_strings")]
	glob: bool,

	/// Perform a regular-expression based search.
	#[arg(long = "regex", overrides_with = "glob")]
	regex: bool,

	/// Treat the pattern as a literal substring.
	#[arg(short = 'F', long = "fixed-strings", alias = "literal")]
	fixed_strings: bool,

	/// Add additional required search patterns.
	#[arg(long = "and", value_name = "pattern", allow_hyphen_values = true)]
	and_patterns: Vec<String>,

	/// Show absolute instead of relative paths.
	#[arg(short = 'a', long = "absolute-path", overrides_with = "relative_path")]
	absolute_path: bool,

	/// Show relative paths.
	#[arg(long = "relative-path", overrides_with = "absolute_path", hide = true)]
	relative_path: bool,

	/// Use a detailed listing format like `ls -l`.
	#[arg(short = 'l', long = "list-details", hide = true)]
	list_details: bool,

	/// Follow symbolic links.
	#[arg(short = 'L', long = "follow", overrides_with = "no_follow")]
	follow: bool,

	/// Do not follow symbolic links.
	#[arg(long = "no-follow", overrides_with = "follow", hide = true)]
	no_follow: bool,

	/// Match the pattern against the full absolute path.
	#[arg(short = 'p', long = "full-path")]
	full_path: bool,

	/// Separate search results by the null character.
	#[arg(short = '0', long = "print0")]
	print0: bool,

	/// Limit directory traversal depth.
	#[arg(short = 'd', long = "max-depth", value_name = "depth")]
	max_depth: Option<usize>,

	/// Only show search results starting at the given depth.
	#[arg(long = "min-depth", value_name = "depth")]
	min_depth: Option<usize>,

	/// Only show search results at the exact given depth.
	#[arg(long = "exact-depth", value_name = "depth")]
	exact_depth: Option<usize>,

	/// Exclude files/directories that match the given glob pattern.
	#[arg(short = 'E', long = "exclude", value_name = "pattern")]
	excludes: Vec<String>,

	/// Do not traverse into directories that match the search criteria.
	#[arg(long = "prune")]
	prune: bool,

	/// Filter the search by type.
	#[arg(short = 't', long = "type", value_name = "filetype")]
	types: Vec<String>,

	/// Filter search results by extension.
	#[arg(short = 'e', long = "extension", value_name = "ext")]
	extensions: Vec<String>,

	/// Limit results based on file size.
	#[arg(short = 'S', long = "size", value_name = "size")]
	sizes: Vec<String>,

	/// Show files changed within the given duration or after the given date.
	#[arg(
		long = "changed-within",
		alias = "change-newer-than",
		alias = "newer",
		alias = "changed-after",
		value_name = "date|dur"
	)]
	changed_within: Option<String>,

	/// Show files changed before the given duration or date.
	#[arg(
		long = "changed-before",
		alias = "change-older-than",
		alias = "older",
		value_name = "date|dur"
	)]
	changed_before: Option<String>,

	/// Filter files by numeric user and/or group id.
	#[arg(short = 'o', long = "owner", value_name = "user:group")]
	owners: Vec<String>,

	/// Print results according to a template.
	#[arg(long = "format", value_name = "fmt")]
	format_template: Option<String>,

	/// Execute a command for each search result.
	#[arg(short = 'x', long = "exec", value_name = "cmd", num_args = 1.., allow_hyphen_values = true, hide = true)]
	exec: Vec<OsString>,

	/// Execute a command once with all search results as arguments.
	#[arg(short = 'X', long = "exec-batch", value_name = "cmd", num_args = 1.., allow_hyphen_values = true, hide = true)]
	exec_batch: Vec<OsString>,

	/// Maximum number of arguments to pass to the command given with -X.
	#[arg(long = "batch-size", default_value_t = 0, hide = true)]
	batch_size: usize,

	/// Add a custom ignore-file in `.gitignore` format.
	#[arg(long = "ignore-file", value_name = "path")]
	ignore_files: Vec<PathBuf>,

	/// Declare when to use color for pattern match output.
	#[arg(short = 'c', long = "color", value_enum, default_value_t = When::Auto)]
	color: When,

	/// Add a terminal hyperlink to a file:// URL for each path in the output.
	#[arg(long = "hyperlink", value_enum, num_args = 0..=1, default_missing_value = "auto")]
	hyperlink: Option<When>,

	/// Ignore directories containing the named entry.
	#[arg(long = "ignore-contain", value_name = "name")]
	ignore_contains: Vec<OsString>,

	/// Set number of threads to use for searching and executing.
	#[arg(short = 'j', long = "threads", value_name = "num")]
	threads: Option<usize>,

	/// Limit the number of search results and quit immediately.
	#[arg(long = "max-results", value_name = "count")]
	max_results: Option<usize>,

	/// Limit the search to a single result and quit immediately.
	#[arg(short = '1')]
	max_one_result: bool,

	/// Do not print anything; return 0 if there is at least one match.
	#[arg(short = 'q', long = "quiet", alias = "has-results")]
	quiet: bool,

	/// Enable display of filesystem errors.
	#[arg(long = "show-errors")]
	show_errors: bool,

	/// Change the current working directory of fd to the provided path.
	#[arg(short = 'C', long = "base-directory", value_name = "path")]
	base_directory: Option<PathBuf>,

	/// Set the path separator to use when printing file paths.
	#[arg(long = "path-separator", value_name = "separator")]
	path_separator: Option<String>,

	/// Provide paths to search instead of positional path arguments.
	#[arg(long = "search-path", value_name = "search-path")]
	search_paths: Vec<PathBuf>,

	/// Control whether ./ is stripped from command paths.
	#[arg(long = "strip-cwd-prefix", value_enum, num_args = 0..=1, default_missing_value = "always")]
	strip_cwd_prefix: Option<When>,

	/// Do not descend into a different file system.
	#[arg(long = "one-file-system")]
	one_file_system: bool,

	/// The search pattern.
	#[arg(allow_hyphen_values = false)]
	pattern: Option<String>,

	/// Directories where the filesystem search is rooted.
	#[arg(value_name = "path")]
	paths: Vec<PathBuf>,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum When {
	Auto,
	Always,
	Never,
}

#[derive(Clone)]
enum SearchMatcher {
	All,
	Regex(Vec<Regex>),
	Glob(Vec<GlobMatcher>),
	Fixed { patterns: Vec<String>, case_insensitive: bool },
}

impl SearchMatcher {
	fn matches(&self, candidate: &str) -> bool {
		match self {
			Self::All => true,
			Self::Regex(patterns) => patterns.iter().all(|pattern| pattern.is_match(candidate)),
			Self::Glob(patterns) => patterns.iter().all(|pattern| pattern.is_match(candidate)),
			Self::Fixed { patterns, case_insensitive } => {
				if *case_insensitive {
					let candidate = candidate.to_lowercase();
					patterns.iter().all(|pattern| candidate.contains(pattern))
				} else {
					patterns.iter().all(|pattern| candidate.contains(pattern))
				}
			},
		}
	}
}

#[derive(Clone)]
struct Excludes(Arc<Vec<GlobMatcher>>);

impl Excludes {
	fn empty() -> Self {
		Self(Arc::new(Vec::new()))
	}

	fn matches(&self, path: &Path, base_dir: &Path) -> bool {
		if self.0.is_empty() {
			return false;
		}
		let absolute = normalize_display_path(path);
		let relative = path
			.strip_prefix(base_dir)
			.map_or_else(|_| absolute.clone(), normalize_display_path);
		let name = path.file_name().map_or_default(normalize_os_str);
		self.0.iter().any(|pattern| {
			pattern.is_match(&absolute) || pattern.is_match(&relative) || pattern.is_match(&name)
		})
	}
}

/// The rules of one ignore file, matched relative to `base`.
struct IgnoreFile {
	base:  PathBuf,
	rules: Rules,
}

impl IgnoreFile {
	/// Whether the last rule matching `path` ignores it (`Some(true)`) or
	/// re-includes it (`Some(false)`).
	fn matched(&self, path: &Path, is_dir: bool) -> Option<bool> {
		match self.rules.matched_below(&self.base, path, is_dir) {
			RuleMatch::Ignore => Some(true),
			RuleMatch::Whitelist => Some(false),
			RuleMatch::None => None,
		}
	}
}

#[derive(Clone, Default)]
struct TypeFilter {
	regular:    bool,
	directory:  bool,
	symlink:    bool,
	socket:     bool,
	pipe:       bool,
	block:      bool,
	character:  bool,
	executable: bool,
	empty:      bool,
}

impl TypeFilter {
	const fn has_kind(&self) -> bool {
		self.regular
			|| self.directory
			|| self.symlink
			|| self.socket
			|| self.pipe
			|| self.block
			|| self.character
	}
}

#[derive(Clone, Copy)]
enum SizeOrdering {
	LessOrEqual,
	Equal,
	GreaterOrEqual,
}

#[derive(Clone, Copy)]
struct SizeFilter {
	ordering: SizeOrdering,
	bytes:    u64,
}

#[derive(Clone, Copy)]
enum OwnerSide {
	Include(u32),
	Exclude(u32),
}

#[derive(Clone, Copy)]
struct OwnerMatcher {
	user:  Option<OwnerSide>,
	group: Option<OwnerSide>,
}

/// What decides, on the walk's workers, whether an entry is kept or its
/// subtree pruned: every filter but those that need a metadata lookup.
struct Filter {
	fs:             pi_vfs::BlockingFs,
	base_dir:       PathBuf,
	matcher:        SearchMatcher,
	excludes:       Excludes,
	/// `--ignore-file` rules, consulted after the walk's own ignore files.
	ignore_files:   Vec<IgnoreFile>,
	/// `--ignore-contain` names.
	markers:        Vec<OsString>,
	types:          TypeFilter,
	extensions:     Vec<String>,
	sizes:          Vec<SizeFilter>,
	changed_after:  Option<SystemTime>,
	changed_before: Option<SystemTime>,
	min_depth:      usize,
	full_path:      bool,
	prune:          bool,
}

impl Filter {
	/// The walk's verdict on `entry`: kept when it matches; pruned with its
	/// subtree when an `--ignore-file` ignores it, `--exclude` matches it, it
	/// holds an `--ignore-contain` name, or it matches under `--prune`.
	fn decide(&self, worker: &mut Worker<'_>, entry: &Entry<'_>) -> Action {
		let is_dir = entry.file_type == FileType::Dir;
		let path = worker.abs(entry);
		if self.ignored(path, is_dir) || self.excludes.matches(path, &self.base_dir) {
			return if is_dir { Action::SkipDir } else { Action::Skip };
		}
		let target = match_target(path, &self.base_dir, self.full_path);
		if is_dir && (self.holds_marker(path) || (self.prune && self.matcher.matches(&target))) {
			return Action::SkipDir;
		}
		if entry.depth >= self.min_depth && self.accepts(entry, &target) {
			Action::Continue
		} else {
			Action::Skip
		}
	}

	fn ignored(&self, path: &Path, is_dir: bool) -> bool {
		self
			.ignore_files
			.iter()
			.find_map(|ignore| ignore.matched(path, is_dir))
			.unwrap_or(false)
	}

	fn holds_marker(&self, dir: &Path) -> bool {
		self
			.markers
			.iter()
			.any(|name| self.fs.exists(pi_vfs::join_path(dir, Path::new(name))))
	}

	/// The filters the listing answers: kind, extension, the pattern
	/// (against `target`), and, from full listings, size and mtime.
	fn accepts(&self, entry: &Entry<'_>, target: &str) -> bool {
		let types = &self.types;
		if types.has_kind()
			&& !((types.regular && entry.file_type == FileType::File)
				|| (types.directory && entry.file_type == FileType::Dir)
				|| (types.symlink && entry.file_type == FileType::Symlink))
		{
			return false;
		}
		(self.extensions.is_empty() || matches_extension(entry.rel_path(), &self.extensions))
			&& self.matcher.matches(target)
			&& (self.sizes.is_empty() || matches_size_filters(&self.sizes, entry.size))
			&& matches_time_filters(self.changed_after, self.changed_before, entry.mtime)
	}

	/// Sizes and mtimes come with each listed entry.
	fn needs_full_listings(&self) -> bool {
		!self.sizes.is_empty() || self.changed_after.is_some() || self.changed_before.is_some()
	}
}

/// What the search does with kept entries: the filters that need a metadata
/// lookup, then printing.
struct SearchConfig {
	fs:             pi_vfs::Fs,
	base_dir:       PathBuf,
	absolute_roots: Vec<PathBuf>,
	types:          TypeFilter,
	owners:         Vec<OwnerMatcher>,
	absolute_path:  bool,
	separator:      String,
	format:         Option<String>,
	print0:         bool,
	quiet:          bool,
	show_errors:    bool,
}

struct SearchState {
	matches:   usize,
	had_error: bool,
}

impl AsyncUtility for FdCli {
	const NAME: &'static str = "fd";
	const USAGE_ERROR: u8 = 2;

	async fn run(mut self, host: &mut Host) -> i32 {
		let quiet = self.quiet;
		let base_dir = self
			.base_directory
			.as_deref()
			.map_or_else(|| host.cwd().to_path_buf(), |path| host.resolve(path));
		self.ignore_files = self
			.ignore_files
			.iter()
			.map(|path| host.resolve(pi_vfs::absolute_path(&base_dir, path)))
			.collect();
		match search(self, base_dir, host).await {
			Ok(state) => {
				if state.had_error {
					2
				} else if quiet {
					i32::from(state.matches == 0)
				} else {
					0
				}
			},
			// Abort the walk; the host maps the BrokenPipe status.
			Err(err) if err.kind() == io::ErrorKind::BrokenPipe => {
				crate::host::SIGPIPE_EXIT_CODE
			},
			Err(err) => {
				let _ = writeln!(host.stderr, "fd: {err}");
				2
			},
		}
	}
}

/// Searches every path operand on the parallel walker, printing matches in
/// path order as the walk settles them.
async fn search(cli: FdCli, base_dir: PathBuf, host: &mut Host) -> io::Result<SearchState> {
	if cli.list_details || !cli.exec.is_empty() || !cli.exec_batch.is_empty() || cli.batch_size != 0
	{
		return Err(io::Error::new(
			io::ErrorKind::InvalidInput,
			"--list-details, --exec, and --exec-batch are not supported by the in-process fd builtin",
		));
	}
	let _ = (cli.color, cli.hyperlink, cli.strip_cwd_prefix);

	let fs = host.vfs();
	let search_paths = resolve_search_paths(&cli, &base_dir, host)?;
	let absolute_roots = search_paths
		.iter()
		.filter(|path| path.original.is_absolute() || pi_vfs::is_virtual_path(&path.original))
		.map(|path| path.resolved.clone())
		.collect::<Vec<_>>();
	let types = build_type_filter(&cli.types)?;
	let filter = Arc::new(Filter {
		fs: fs.blocking(),
		base_dir: base_dir.clone(),
		matcher: build_matcher(&cli)?,
		excludes: build_excludes(&cli.excludes)?,
		ignore_files: read_ignore_files(&fs, &base_dir, &cli).await?,
		markers: cli.ignore_contains.clone(),
		types: types.clone(),
		extensions: normalize_extensions(&cli.extensions),
		sizes: build_size_filters(&cli.sizes)?,
		changed_after: cli
			.changed_within
			.as_deref()
			.map(parse_time_filter)
			.transpose()?,
		changed_before: cli
			.changed_before
			.as_deref()
			.map(parse_time_filter)
			.transpose()?,
		min_depth: cli.exact_depth.or(cli.min_depth).unwrap_or(0),
		full_path: cli.full_path,
		prune: cli.prune,
	});
	let config = SearchConfig {
		fs,
		base_dir,
		absolute_roots,
		types,
		owners: build_owner_filters(&cli.owners)?,
		absolute_path: cli.absolute_path,
		separator: cli.path_separator.clone().unwrap_or_else(|| "/".to_string()),
		format: cli.format_template.clone(),
		print0: cli.print0,
		quiet: cli.quiet,
		show_errors: cli.show_errors,
	};
	let max_results = if cli.max_one_result || cli.quiet {
		Some(1)
	} else {
		cli.max_results
	};
	let opts = fd_walk_options(&cli, &filter);

	let mut out = host.stdout_writer();
	let mut state = SearchState { matches: 0, had_error: false };
	for search_path in &search_paths {
		if max_results.is_some_and(|max| state.matches >= max) {
			break;
		}
		let root = &search_path.resolved;
		let layer = pi_walker::Fs::new(&config.fs, root);
		let decide = Arc::clone(&filter);
		let walked = walk::ordered(&layer, root, &opts, move |worker, entry| decide.decide(worker, entry));
		let mut walk = match walked.await {
			Ok(walk) => walk,
			Err(WalkError::Root { path, error }) => {
				return Err(io::Error::other(format!("{}: {error}", path.display())));
			},
		};
		let mut pace = host.output_pace();
		let mut complete = true;
		let mut unflushed = false;
		loop {
			if max_results.is_some_and(|max| state.matches >= max) {
				complete = false;
				break;
			}
			// Printed matches wait for the next one no longer than this.
			if unflushed && tokio::time::timeout(OUTPUT_HOLD, walk.wait()).await.is_err() {
				let _ = host.flush_output().await;
				unflushed = false;
			}
			let Some(entry) = walk.next().await else {
				break;
			};
			let path = layer.join(root, entry.path);
			if !passes_lookups(&config, &path).await {
				continue;
			}
			state.matches = state.matches.saturating_add(1);
			if !config.quiet {
				print_match(&config, &path, &mut out)?;
				let _ = host.pace_output(&mut pace).await;
				unflushed = true;
			}
		}
		if complete && config.show_errors {
			for error in walk.into_errors().await {
				state.had_error = true;
				let _ = writeln!(host.stderr, "fd: {}: {}", error.path.display(), error.error);
			}
		}
	}
	out.flush()?;
	let _ = host.flush_output().await;
	Ok(state)
}

/// Longest a printed match waits for the walk before it is handed over.
const OUTPUT_HOLD: Duration = Duration::from_millis(10);

/// The `--ignore-file` rules (none under `--no-ignore`), matched relative to
/// the base directory.
async fn read_ignore_files(
	fs: &pi_vfs::Fs,
	base_dir: &Path,
	cli: &FdCli,
) -> io::Result<Vec<IgnoreFile>> {
	if no_ignore(cli) {
		return Ok(Vec::new());
	}
	let mut files = Vec::new();
	for path in &cli.ignore_files {
		let rules = Rules::read(fs, path)
			.await
			.map_err(|err| io::Error::other(format!("{}: {err}", path.display())))?;
		if !rules.is_empty() {
			files.push(IgnoreFile { base: base_dir.to_path_buf(), rules });
		}
	}
	Ok(files)
}

fn fd_walk_options(cli: &FdCli, filter: &Filter) -> walk::Options {
	let ignore = !no_ignore(cli);
	walk::Options {
		hidden: include_hidden(cli),
		gitignore: ignore && !no_ignore_vcs(cli),
		ignore_file: ignore.then_some(".fdignore"),
		skip_parent_ignores: cli.no_ignore_parent,
		// The walk root is always resolved through symlinks, as fd walks a
		// path operand that is itself a symlink; `-L` extends that to links
		// found during the walk.
		follow_links: cli.follow,
		detail: if filter.needs_full_listings() {
			Detail::Full
		} else {
			Detail::Minimal
		},
		max_depth: cli.exact_depth.or(cli.max_depth),
		same_file_system: cli.one_file_system,
		workers: cli.threads,
		..walk::Options::default()
	}
}

/// Whether a kept entry passes the filters that need its metadata
/// (`--type executable`/`empty`, `--owner`); a plain `fd foo` looks nothing
/// up.
async fn passes_lookups(config: &SearchConfig, path: &Path) -> bool {
	let types = &config.types;
	if !types.executable && !types.empty && config.owners.is_empty() {
		return true;
	}
	let metadata = config.fs.symlink_metadata(path).await.ok();
	let metadata = metadata.as_ref();
	(!types.executable || is_executable(metadata))
		&& (!types.empty || is_empty_entry(&config.fs, path, metadata, types).await)
		&& (config.owners.is_empty() || matches_owner_filters(&config.owners, metadata))
}

/// Prints `path`, a match, as `--format`, the separators, and `-0` ask.
fn print_match<W: Write>(config: &SearchConfig, path: &Path, out: &mut W) -> io::Result<()> {
	let display = display_path(config, path);
	let text = match config.format.as_deref() {
		Some(format) => format_path(format, path, &display),
		None => display,
	};
	out.write_all(text.as_bytes())?;
	out.write_all(if config.print0 { b"\0" } else { b"\n" })
}

#[cfg(unix)]
fn is_executable(metadata: Option<&Metadata>) -> bool {
	metadata.is_some_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(metadata: Option<&Metadata>) -> bool {
	metadata.is_some_and(|meta| meta.is_file())
}

async fn is_empty_entry(
	fs: &pi_vfs::Fs,
	path: &Path,
	metadata: Option<&Metadata>,
	filter: &TypeFilter,
) -> bool {
	let Some(metadata) = metadata else {
		return false;
	};
	if metadata.is_file() {
		return metadata.len() == 0;
	}
	if metadata.is_dir() && (!filter.has_kind() || filter.directory) {
		return fs.read_dir(path).await.is_ok_and(|mut entries| entries.next().is_none());
	}
	false
}

fn matches_extension(path: &Path, extensions: &[String]) -> bool {
	let Some(extension) = path.extension().and_then(OsStr::to_str) else {
		return false;
	};
	extensions.iter().any(|expected| extension == expected)
}

/// Size filters apply to regular files, whose listed size is known.
fn matches_size_filters(filters: &[SizeFilter], size: Option<u64>) -> bool {
	let Some(size) = size else {
		return false;
	};
	filters.iter().all(|filter| match filter.ordering {
		SizeOrdering::LessOrEqual => size <= filter.bytes,
		SizeOrdering::Equal => size == filter.bytes,
		SizeOrdering::GreaterOrEqual => size >= filter.bytes,
	})
}

/// Whether a listed mtime (Unix nanoseconds) falls in the window; an entry
/// without one fails any bound.
fn matches_time_filters(
	after: Option<SystemTime>,
	before: Option<SystemTime>,
	mtime: Option<i64>,
) -> bool {
	if after.is_none() && before.is_none() {
		return true;
	}
	let Some(modified) = mtime
		.and_then(|nanos| u64::try_from(nanos).ok())
		.map(|nanos| UNIX_EPOCH + Duration::from_nanos(nanos))
	else {
		return false;
	};
	after.is_none_or(|after| modified > after) && before.is_none_or(|before| modified < before)
}

/// Owner filters never match entries whose filesystem reports no owner.
fn matches_owner_filters(filters: &[OwnerMatcher], metadata: Option<&Metadata>) -> bool {
	let Some(metadata) = metadata else {
		return false;
	};
	filters.iter().all(|filter| {
		filter
			.user
			.is_none_or(|side| owner_side_matches(side, metadata.uid()))
			&& filter
				.group
				.is_none_or(|side| owner_side_matches(side, metadata.gid()))
	})
}

fn owner_side_matches(side: OwnerSide, actual: Option<u32>) -> bool {
	let Some(actual) = actual else {
		return false;
	};
	match side {
		OwnerSide::Include(expected) => actual == expected,
		OwnerSide::Exclude(expected) => actual != expected,
	}
}

fn resolve_search_paths(
	cli: &FdCli,
	base_dir: &Path,
	host: &Host,
) -> io::Result<Vec<SearchPath>> {
	if !cli.search_paths.is_empty() && !cli.paths.is_empty() {
		return Err(io::Error::new(
			io::ErrorKind::InvalidInput,
			"positional paths cannot be combined with --search-path",
		));
	}
	let raw_paths = if !cli.search_paths.is_empty() {
		cli.search_paths.clone()
	} else if !cli.paths.is_empty() {
		cli.paths.clone()
	} else {
		vec![PathBuf::from(".")]
	};
	Ok(raw_paths
		.into_iter()
		.map(|original| {
			let resolved = host.resolve(pi_vfs::absolute_path(base_dir, &original));
			SearchPath { original, resolved }
		})
		.collect())
}

struct SearchPath {
	original: PathBuf,
	resolved: PathBuf,
}


const fn include_hidden(cli: &FdCli) -> bool {
	(cli.hidden || cli.unrestricted > 0) && !cli.no_hidden
}

const fn no_ignore(cli: &FdCli) -> bool {
	(cli.no_ignore || cli.unrestricted > 0) && !cli.ignore
}

const fn no_ignore_vcs(cli: &FdCli) -> bool {
	cli.no_ignore_vcs && !cli.ignore_vcs
}

fn build_matcher(cli: &FdCli) -> io::Result<SearchMatcher> {
	let mut patterns = Vec::new();
	if let Some(pattern) = cli.pattern.as_ref() {
		patterns.push(pattern.clone());
	}
	patterns.extend(cli.and_patterns.iter().cloned());
	if patterns.is_empty() || patterns.iter().all(String::is_empty) {
		return Ok(SearchMatcher::All);
	}
	let case_insensitive = if cli.ignore_case {
		true
	} else if cli.case_sensitive {
		false
	} else {
		!patterns
			.iter()
			.any(|pattern| pattern.chars().any(char::is_uppercase))
	};

	if cli.glob {
		let mut matchers = Vec::with_capacity(patterns.len());
		for pattern in patterns {
			let glob = GlobBuilder::new(&pattern)
				.literal_separator(true)
				.case_insensitive(case_insensitive)
				.build()
				.map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err.to_string()))?;
			matchers.push(glob.compile_matcher());
		}
		return Ok(SearchMatcher::Glob(matchers));
	}
	if cli.fixed_strings {
		let patterns = if case_insensitive {
			patterns
				.into_iter()
				.map(|pattern| pattern.to_lowercase())
				.collect()
		} else {
			patterns
		};
		return Ok(SearchMatcher::Fixed { patterns, case_insensitive });
	}
	let mut regexes = Vec::with_capacity(patterns.len());
	for pattern in patterns {
		let regex = RegexBuilder::new(&pattern)
			.case_insensitive(case_insensitive)
			.build()
			.map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err.to_string()))?;
		regexes.push(regex);
	}
	Ok(SearchMatcher::Regex(regexes))
}

fn build_excludes(patterns: &[String]) -> io::Result<Excludes> {
	if patterns.is_empty() {
		return Ok(Excludes::empty());
	}
	let mut matchers = Vec::with_capacity(patterns.len());
	for pattern in patterns {
		let glob = GlobBuilder::new(pattern)
			.literal_separator(true)
			.build()
			.map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err.to_string()))?;
		matchers.push(glob.compile_matcher());
	}
	Ok(Excludes(Arc::new(matchers)))
}

fn build_type_filter(types: &[String]) -> io::Result<TypeFilter> {
	let mut filter = TypeFilter::default();
	for value in types {
		match value.as_str() {
			"f" | "file" => filter.regular = true,
			"d" | "dir" | "directory" => filter.directory = true,
			"l" | "symlink" => filter.symlink = true,
			"s" | "socket" => filter.socket = true,
			"p" | "pipe" => filter.pipe = true,
			"b" | "block-device" => filter.block = true,
			"c" | "char-device" => filter.character = true,
			"x" | "executable" => filter.executable = true,
			"e" | "empty" => filter.empty = true,
			_ => {
				return Err(io::Error::new(
					io::ErrorKind::InvalidInput,
					format!("unknown file type: {value}"),
				));
			},
		}
	}
	Ok(filter)
}

fn normalize_extensions(extensions: &[String]) -> Vec<String> {
	extensions
		.iter()
		.map(|extension| extension.trim_start_matches('.').to_string())
		.collect()
}

fn build_size_filters(values: &[String]) -> io::Result<Vec<SizeFilter>> {
	values
		.iter()
		.map(|value| parse_size_filter(value))
		.collect()
}

fn parse_size_filter(value: &str) -> io::Result<SizeFilter> {
	let (ordering, rest) = if let Some(rest) = value.strip_prefix('+') {
		(SizeOrdering::GreaterOrEqual, rest)
	} else if let Some(rest) = value.strip_prefix('-') {
		(SizeOrdering::LessOrEqual, rest)
	} else {
		(SizeOrdering::Equal, value)
	};
	let split = rest
		.char_indices()
		.find(|(_, ch)| !ch.is_ascii_digit())
		.map_or(rest.len(), |(index, _)| index);
	if split == 0 {
		return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("invalid size: {value}")));
	}
	let count = rest[..split]
		.parse::<u64>()
		.map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err.to_string()))?;
	let unit = rest[split..].to_ascii_lowercase();
	let multiplier = match unit.as_str() {
		"" | "b" => 1,
		"k" => 1_000,
		"m" => 1_000_000,
		"g" => 1_000_000_000,
		"t" => 1_000_000_000_000,
		"ki" => 1_024,
		"mi" => 1_048_576,
		"gi" => 1_073_741_824,
		"ti" => 1_099_511_627_776,
		_ => {
			return Err(io::Error::new(
				io::ErrorKind::InvalidInput,
				format!("invalid size unit: {unit}"),
			));
		},
	};
	let bytes = count.checked_mul(multiplier).ok_or_else(|| {
		io::Error::new(io::ErrorKind::InvalidInput, format!("size is too large: {value}"))
	})?;
	Ok(SizeFilter { ordering, bytes })
}

fn parse_time_filter(value: &str) -> io::Result<SystemTime> {
	if let Some(timestamp) = value.strip_prefix('@') {
		let seconds = timestamp
			.parse::<u64>()
			.map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err.to_string()))?;
		return Ok(UNIX_EPOCH + Duration::from_secs(seconds));
	}
	if let Some(duration) = parse_duration(value)? {
		return SystemTime::now().checked_sub(duration).ok_or_else(|| {
			io::Error::new(io::ErrorKind::InvalidInput, format!("duration is too large: {value}"))
		});
	}
	parse_utc_datetime(value)
}

fn parse_duration(value: &str) -> io::Result<Option<Duration>> {
	let trimmed = value.trim();
	let split = trimmed
		.char_indices()
		.find(|(_, ch)| !ch.is_ascii_digit())
		.map_or(trimmed.len(), |(index, _)| index);
	if split == 0 || split == trimmed.len() {
		return Ok(None);
	}
	let count = trimmed[..split]
		.parse::<u64>()
		.map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err.to_string()))?;
	let unit = trimmed[split..].to_ascii_lowercase();
	let seconds = match unit.as_str() {
		"s" | "sec" | "secs" | "second" | "seconds" => count,
		"m" | "min" | "mins" | "minute" | "minutes" => count.saturating_mul(60),
		"h" | "hr" | "hrs" | "hour" | "hours" => count.saturating_mul(60 * 60),
		"d" | "day" | "days" => count.saturating_mul(24 * 60 * 60),
		"w" | "week" | "weeks" => count.saturating_mul(7 * 24 * 60 * 60),
		_ => return Ok(None),
	};
	Ok(Some(Duration::from_secs(seconds)))
}

fn parse_utc_datetime(value: &str) -> io::Result<SystemTime> {
	let (date, time) = value
		.trim()
		.split_once(' ')
		.unwrap_or_else(|| (value.trim(), "00:00:00"));
	let mut date_parts = date.split('-');
	let year = parse_i32_part(date_parts.next(), "year")?;
	let month = parse_u32_part(date_parts.next(), "month")?;
	let day = parse_u32_part(date_parts.next(), "day")?;
	if date_parts.next().is_some() {
		return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("invalid date: {value}")));
	}
	let mut time_parts = time.split(':');
	let hour = parse_u32_part(time_parts.next(), "hour")?;
	let minute = parse_u32_part(time_parts.next(), "minute")?;
	let second = parse_u32_part(time_parts.next(), "second")?;
	if time_parts.next().is_some()
		|| !(1..=12).contains(&month)
		|| !(1..=31).contains(&day)
		|| hour > 23
		|| minute > 59
		|| second > 59
	{
		return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("invalid date: {value}")));
	}
	let days = days_from_civil(year, month, day);
	let seconds = days
		.checked_mul(86_400)
		.and_then(|base| base.checked_add(i64::from(hour * 3_600 + minute * 60 + second)))
		.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "date is out of range"))?;
	if seconds < 0 {
		return Err(io::Error::new(io::ErrorKind::InvalidInput, "dates before 1970 are unsupported"));
	}
	Ok(UNIX_EPOCH + Duration::from_secs(u64::try_from(seconds).unwrap_or(u64::MAX)))
}

fn parse_i32_part(value: Option<&str>, name: &str) -> io::Result<i32> {
	value
		.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, format!("missing {name}")))?
		.parse::<i32>()
		.map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err.to_string()))
}

fn parse_u32_part(value: Option<&str>, name: &str) -> io::Result<u32> {
	value
		.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, format!("missing {name}")))?
		.parse::<u32>()
		.map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err.to_string()))
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
	let year = year - i32::from(month <= 2);
	let era = if year >= 0 { year } else { year - 399 } / 400;
	let year_of_era = year - era * 400;
	let month = i32::try_from(month).unwrap_or(0);
	let day = i32::try_from(day).unwrap_or(0);
	let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
	let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
	i64::from(era) * 146_097 + i64::from(day_of_era) - 719_468
}

fn build_owner_filters(values: &[String]) -> io::Result<Vec<OwnerMatcher>> {
	values
		.iter()
		.map(|value| parse_owner_filter(value))
		.collect()
}

fn parse_owner_filter(value: &str) -> io::Result<OwnerMatcher> {
	let (user, group) = value.split_once(':').unwrap_or((value, ""));
	Ok(OwnerMatcher { user: parse_owner_side(user)?, group: parse_owner_side(group)? })
}

fn parse_owner_side(value: &str) -> io::Result<Option<OwnerSide>> {
	if value.is_empty() {
		return Ok(None);
	}
	let (exclude, raw) = if let Some(raw) = value.strip_prefix('!') {
		(true, raw)
	} else {
		(false, value)
	};
	let id = raw.parse::<u32>().map_err(|_| {
		io::Error::new(
			io::ErrorKind::InvalidInput,
			"owner filters in the in-process fd builtin require numeric uid/gid values",
		)
	})?;
	Ok(Some(if exclude {
		OwnerSide::Exclude(id)
	} else {
		OwnerSide::Include(id)
	}))
}

/// The text a pattern matches for `path`: its file name (borrowed when
/// valid UTF-8), or the full path under `--full-path`.
fn match_target<'p>(path: &'p Path, base_dir: &Path, full_path: bool) -> Cow<'p, str> {
	if full_path {
		return Cow::Owned(normalize_display_path(path));
	}
	// A single name holds no separator to normalize.
	path.file_name().map_or_else(
		|| Cow::Owned(normalize_display_path(path.strip_prefix(base_dir).unwrap_or(path))),
		OsStr::to_string_lossy,
	)
}

fn display_path(config: &SearchConfig, path: &Path) -> String {
	let path = if config.absolute_path || root_was_absolute(path, &config.absolute_roots) {
		path.to_path_buf()
	} else {
		path
			.strip_prefix(&config.base_dir)
			.unwrap_or(path)
			.to_path_buf()
	};
	let mut text = normalize_display_path(&path);
	if config.separator != "/" {
		text = text.replace('/', &config.separator);
	}
	text
}

fn root_was_absolute(path: &Path, roots: &[PathBuf]) -> bool {
	roots.iter().any(|root| path.starts_with(root))
}

fn normalize_display_path(path: &Path) -> String {
	forward_slash_display(path)
		.as_deref()
		.unwrap_or(path)
		.to_string_lossy()
		.into_owned()
}

fn normalize_os_str(value: &OsStr) -> String {
	normalize_display_path(Path::new(value))
}

fn format_path(template: &str, path: &Path, display: &str) -> String {
	let basename = pi_vfs::file_name(path).map_or_default(|name| normalize_os_str(&name));
	let parent = pi_vfs::parent_path(path)
		.map_or_default(normalize_display_path);
	let without_extension = remove_extension(display);
	let basename_without_extension = remove_extension(&basename);
	let mut output = String::new();
	let mut chars = template.chars().peekable();
	while let Some(ch) = chars.next() {
		if ch != '{' {
			output.push(ch);
			continue;
		}
		match chars.peek().copied() {
			Some('{') => {
				chars.next();
				output.push('{');
			},
			Some('}') => {
				chars.next();
				output.push_str(display);
			},
			Some('/') => {
				chars.next();
				match chars.next() {
					Some('}') => output.push_str(&basename),
					Some('.') if chars.next() == Some('}') => {
						output.push_str(&basename_without_extension);
					},
					Some('/') if chars.next() == Some('}') => output.push_str(&parent),
					_ => output.push('{'),
				}
			},
			Some('.') => {
				chars.next();
				if chars.next() == Some('}') {
					output.push_str(&without_extension);
				} else {
					output.push('{');
				}
			},
			_ => output.push('{'),
		}
	}
	output.replace("}}", "}")
}

fn remove_extension(value: &str) -> String {
	let Some((base, extension)) = value.rsplit_once('.') else {
		return value.to_string();
	};
	if extension.contains('/') || base.is_empty() {
		value.to_string()
	} else {
		base.to_string()
	}
}


#[cfg(test)]
mod tests {
	use std::fs;

	use tempfile::{Builder, TempDir};

	use super::FdCli;
	use crate::host::run_async_util;

	/// A fresh temp directory holding a matchable file and a filler file.
	fn seeded_tree(tag: &str) -> TempDir {
		let tree = Builder::new()
			.prefix(&format!("pi-fd-cancel-{tag}-"))
			.tempdir()
			.expect("temp tree should be created");
		fs::write(tree.path().join("haystack.txt"), b"needle\n")
			.expect("seed file should be written");
		fs::write(tree.path().join("filler.txt"), b"filler\n")
			.expect("filler file should be written");
		tree
	}

	/// Matches print in path order; `.fdignore` beats `.gitignore` and prunes
	/// directories, and `-E`, `--min-depth`, and `--size` apply during the
	/// walk.
	#[tokio::test(flavor = "multi_thread")]
	async fn filters_during_the_walk_and_prints_in_path_order() {
		let tree = Builder::new().prefix("fd-filters").tempdir().expect("tempdir");
		for (path, contents) in [
			(".gitignore", "*.log\n"),
			(".fdignore", "!keep.log\nskip/\n"),
			("a/x.txt", "12345"),
			("a-b.txt", ""),
			("a.txt", "1"),
			("keep.log", ""),
			("drop.log", ""),
			("skip/inner.txt", ""),
			("vendor/v.txt", ""),
		] {
			let path = tree.path().join(path);
			fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
			fs::write(path, contents).expect("write");
		}
		let found = async |args: &[&str]| {
			let (code, capture) = run_async_util::<FdCli>(args, "", tree.path()).await;
			assert_eq!(code, 0, "{args:?}: {:?}", capture.stderr());
			capture.out().lines().map(str::to_owned).collect::<Vec<_>>()
		};
		assert_eq!(found(&["-t", "f"]).await, [
			"a-b.txt",
			"a.txt",
			"a/x.txt",
			"keep.log",
			"vendor/v.txt"
		]);
		assert_eq!(found(&["-t", "f", "-E", "vendor", "--min-depth", "2"]).await, ["a/x.txt"]);
		assert_eq!(found(&["-t", "f", "--size", "+2b"]).await, ["a/x.txt"]);
		assert_eq!(found(&["-t", "f", "-u", "log"]).await, ["drop.log", "keep.log"]);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn walk_completes_normally() {
		let tree = seeded_tree("normal");
		let path = tree.path().to_str().expect("utf8 path");
		let (code, capture) = run_async_util::<FdCli>(&["haystack", path], "", tree.path()).await;

		assert_eq!(code, 0);
		assert!(
			capture.out().contains("haystack.txt"),
			"stdout should list the match: {:?}",
			capture.stdout()
		);
		assert!(capture.err().is_empty(), "stderr should stay clean: {:?}", capture.stderr());
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn walks_a_symlinked_root_operand_but_not_nested_links() {
		let tree = Builder::new().prefix("fd-root-link").tempdir().expect("tempdir");
		fs::create_dir_all(tree.path().join("real/sub")).expect("mkdir");
		fs::write(tree.path().join("real/a.txt"), "").expect("write");
		std::os::unix::fs::symlink("real", tree.path().join("link")).expect("link");
		fs::create_dir(tree.path().join("parent")).expect("mkdir");
		std::os::unix::fs::symlink("../real", tree.path().join("parent/inner")).expect("link");
		let list = async |args: &[&str]| {
			let (code, capture) = run_async_util::<FdCli>(args, "", tree.path()).await;
			let mut lines: Vec<String> = capture.out().lines().map(|line| line.trim_end_matches('/').to_owned()).collect();
			lines.sort();
			(code, lines)
		};

		assert_eq!(list(&[".", "link"]).await, (0, vec!["link/a.txt".to_owned(), "link/sub".to_owned()]));
		// Links met during the walk are listed, not entered, unless -L asks.
		assert_eq!(list(&[".", "parent"]).await, (0, vec!["parent/inner".to_owned()]));
		assert_eq!(
			list(&["-L", ".", "parent"]).await,
			(0, vec!["parent/inner".to_owned(), "parent/inner/a.txt".to_owned(), "parent/inner/sub".to_owned()])
		);
	}
}
