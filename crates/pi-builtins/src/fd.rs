//! In-process `fd` builtin backed by `pi_walker`, `globset`, and `regex`.
//!
//! Relocated from pi-shell's native implementation.

use std::{
	collections::HashMap,
	ffi::{OsStr, OsString},
	fs::{self, Metadata},
	io::{self, BufWriter, Write},
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{ArgAction, Parser, ValueEnum};
use globset::{GlobBuilder, GlobMatcher};
use pi_walker::CollectedEntry;
use regex::{Regex, RegexBuilder};

use crate::host::{Host, Utility, util};

#[derive(Parser, Debug)]
#[command(
	name = "fd",
	version = "10.4.2",
	about = "A program to find entries in your filesystem",
	after_long_help = "Bugs can be reported on GitHub: https://github.com/sharkdp/fd/issues",
	max_term_width = 98,
	args_override_self = true
)]
struct FdCli {
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
		let name = path.file_name().map(normalize_os_str).unwrap_or_default();
		self.0.iter().any(|pattern| {
			pattern.is_match(&absolute) || pattern.is_match(&relative) || pattern.is_match(&name)
		})
	}
}

struct FdIgnoreMatcher {
	enabled: bool,
	root:    PathBuf,
	global:  Vec<ignore::gitignore::Gitignore>,
	states:  HashMap<PathBuf, Arc<FdIgnoreState>>,
}

struct FdIgnoreState {
	parent:  Option<Arc<Self>>,
	matcher: Option<ignore::gitignore::Gitignore>,
}

impl FdIgnoreMatcher {
	fn new(base_dir: &Path, root: &Path, cli: &FdCli) -> io::Result<Self> {
		let root = normalize_fdignore_path(root);
		let enabled = !no_ignore(cli);
		let mut matcher =
			Self { enabled, root: root.clone(), global: Vec::new(), states: HashMap::new() };
		if !enabled {
			return Ok(matcher);
		}

		for ignore_file in &cli.ignore_files {
			let path = if ignore_file.is_absolute() {
				ignore_file.clone()
			} else {
				base_dir.join(ignore_file)
			};
			let mut builder = ignore::gitignore::GitignoreBuilder::new(base_dir);
			if let Some(err) = builder.add(&path) {
				return Err(io::Error::other(err.to_string()));
			}
			let ignore = builder
				.build()
				.map_err(|err| io::Error::other(err.to_string()))?;
			if !ignore.is_empty() {
				matcher.global.push(ignore);
			}
		}

		let parent = if cli.no_ignore_parent {
			None
		} else {
			build_fdignore_parent_states(root.parent())
		};
		let root_state = load_fdignore_state(&root, parent);
		matcher.states.insert(root, root_state);
		Ok(matcher)
	}

	fn is_ignored(&mut self, path: &Path, is_dir: bool) -> bool {
		if !self.enabled {
			return false;
		}
		let path = normalize_fdignore_path(path);
		let state_dir = path.parent().unwrap_or(&self.root).to_path_buf();
		let state = self.state_for_dir(&state_dir);
		if let Some(ignored) = fdignore_state_match(&state, &path, is_dir) {
			return ignored;
		}
		self
			.global
			.iter()
			.find_map(|ignore| fdignore_match(ignore, &path, is_dir))
			.unwrap_or(false)
	}

	fn state_for_dir(&mut self, dir: &Path) -> Arc<FdIgnoreState> {
		if let Some(state) = self.states.get(dir) {
			return Arc::clone(state);
		}
		if !dir.starts_with(&self.root) {
			return self
				.states
				.get(&self.root)
				.map_or_else(|| Arc::new(FdIgnoreState { parent: None, matcher: None }), Arc::clone);
		}
		let parent = if dir == self.root.as_path() {
			self
				.states
				.get(&self.root)
				.and_then(|state| state.parent.as_ref().map(Arc::clone))
		} else {
			dir.parent().map(|parent| self.state_for_dir(parent))
		};
		let state = load_fdignore_state(dir, parent);
		self.states.insert(dir.to_path_buf(), Arc::clone(&state));
		state
	}
}

fn build_fdignore_parent_states(mut dir: Option<&Path>) -> Option<Arc<FdIgnoreState>> {
	let mut ancestors = Vec::new();
	while let Some(path) = dir {
		ancestors.push(path);
		dir = path.parent();
	}
	let mut parent = None;
	for ancestor in ancestors.into_iter().rev() {
		parent = Some(load_fdignore_state(ancestor, parent));
	}
	parent
}

fn normalize_fdignore_path(path: &Path) -> PathBuf {
	path.components().collect()
}

fn load_fdignore_state(dir: &Path, parent: Option<Arc<FdIgnoreState>>) -> Arc<FdIgnoreState> {
	let file = dir.join(".fdignore");
	let matcher = if file.is_file() {
		let mut builder = ignore::gitignore::GitignoreBuilder::new(dir);
		let _ = builder.add(&file);
		builder.build().ok().filter(|ignore| !ignore.is_empty())
	} else {
		None
	};
	Arc::new(FdIgnoreState { parent, matcher })
}

fn fdignore_state_match(state: &Arc<FdIgnoreState>, path: &Path, is_dir: bool) -> Option<bool> {
	let mut current = Some(state.as_ref());
	while let Some(frame) = current {
		if let Some(matcher) = &frame.matcher
			&& let Some(ignored) = fdignore_match(matcher, path, is_dir)
		{
			return Some(ignored);
		}
		current = frame.parent.as_deref();
	}
	None
}

fn fdignore_match(
	matcher: &ignore::gitignore::Gitignore,
	path: &Path,
	is_dir: bool,
) -> Option<bool> {
	match matcher.matched(path, is_dir) {
		ignore::Match::Ignore(_) => Some(true),
		ignore::Match::Whitelist(_) => Some(false),
		ignore::Match::None => None,
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

	const fn is_empty(&self) -> bool {
		!self.has_kind() && !self.executable && !self.empty
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

#[cfg_attr(not(unix), allow(dead_code))]
#[derive(Clone, Copy)]
enum OwnerSide {
	Include(u32),
	Exclude(u32),
}

#[cfg_attr(not(unix), allow(dead_code))]
#[derive(Clone, Copy)]
struct OwnerMatcher {
	user:  Option<OwnerSide>,
	group: Option<OwnerSide>,
}

#[derive(Clone)]
struct SearchConfig {
	base_dir:       PathBuf,
	absolute_roots: Vec<PathBuf>,
	matcher:        Arc<SearchMatcher>,
	excludes:       Excludes,
	types:          TypeFilter,
	extensions:     Vec<String>,
	sizes:          Vec<SizeFilter>,
	changed_after:  Option<SystemTime>,
	changed_before: Option<SystemTime>,
	owners:         Vec<OwnerMatcher>,
	full_path:      bool,
	absolute_path:  bool,
	separator:      String,
	format:         Option<String>,
	print0:         bool,
	quiet:          bool,
	show_errors:    bool,
	prune:          bool,
}

struct SearchState {
	matches:   usize,
	had_error: bool,
}

impl Utility for FdCli {
	const NAME: &'static str = "fd";
	const USAGE_ERROR: u8 = 2;

	fn run(mut self, host: &mut Host) -> i32 {
		let quiet = self.quiet;
		let base_dir = self
			.base_directory
			.as_deref()
			.map_or_else(|| host.cwd().to_path_buf(), |path| host.resolve(path));
		self.ignore_files = self
			.ignore_files
			.iter()
			.map(|path| {
				if path.is_absolute() {
					host.resolve(path)
				} else {
					host.resolve(base_dir.join(path))
				}
			})
			.collect();
		let cancelled = host.cancel_flag();

		match search(self, base_dir, host, &cancelled) {
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

/// Creates the `fd` builtin registration.
pub(crate) fn fd_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<FdCli, SE>()
}

fn search(
	cli: FdCli,
	base_dir: PathBuf,
	host: &mut Host,
	cancelled: &AtomicBool,
) -> io::Result<SearchState> {
	if cli.list_details || !cli.exec.is_empty() || !cli.exec_batch.is_empty() || cli.batch_size != 0
	{
		return Err(io::Error::new(
			io::ErrorKind::InvalidInput,
			"--list-details, --exec, and --exec-batch are not supported by the in-process fd builtin",
		));
	}
	let _ = (cli.color, cli.hyperlink, cli.strip_cwd_prefix);

	let search_paths = resolve_search_paths(&cli, &base_dir, host)?;
	let absolute_roots = search_paths
		.iter()
		.filter(|path| path.original.is_absolute())
		.map(|path| path.resolved.clone())
		.collect::<Vec<_>>();
	let matcher = Arc::new(build_matcher(&cli)?);
	let excludes = build_excludes(&cli.excludes)?;
	let types = build_type_filter(&cli.types)?;
	let sizes = build_size_filters(&cli.sizes)?;
	let changed_after = cli
		.changed_within
		.as_deref()
		.map(parse_time_filter)
		.transpose()?;
	let changed_before = cli
		.changed_before
		.as_deref()
		.map(parse_time_filter)
		.transpose()?;
	let owners = build_owner_filters(&cli.owners)?;
	let max_results = if cli.max_one_result {
		Some(1)
	} else {
		cli.max_results
	};
	let separator = cli
		.path_separator
		.clone()
		.unwrap_or_else(|| std::path::MAIN_SEPARATOR.to_string());
	let config = SearchConfig {
		base_dir,
		absolute_roots,
		matcher,
		excludes,
		types,
		extensions: normalize_extensions(&cli.extensions),
		sizes,
		changed_after,
		changed_before,
		owners,
		full_path: cli.full_path,
		absolute_path: cli.absolute_path,
		separator,
		format: cli.format_template.clone(),
		print0: cli.print0,
		quiet: cli.quiet,
		show_errors: cli.show_errors,
		prune: cli.prune,
	};

	if let Some(state) = try_search_fast(
		&cli,
		&search_paths,
		&config,
		max_results,
		&mut host.stdout,
		&mut host.stderr,
		cancelled,
	)? {
		return Ok(state);
	}

	let use_gitignore = !(no_ignore(&cli) || no_ignore_vcs(&cli));
	let mut out = host.stdout_writer();
	let mut state = SearchState { matches: 0, had_error: false };
	for search_path in &search_paths {
		if cancelled.load(Ordering::Relaxed) || max_results.is_some_and(|max| state.matches >= max) {
			break;
		}
		let mut fd_ignores = FdIgnoreMatcher::new(&config.base_dir, &search_path.resolved, &cli)?;
		let request =
			fd_walk_request(&search_path.resolved, &cli, use_gitignore, cli.one_file_system);
		let outcome = match request.collect_with_heartbeat(cancel_heartbeat(cancelled)) {
			Ok(outcome) => outcome,
			Err(pi_walker::WalkError::Interrupted(_)) if cancelled.load(Ordering::Relaxed) => break,
			Err(err) => return Err(walker_collect_error_to_io(err)),
		};
		let mut pruned_dirs = Vec::new();
		for entry in &outcome.entries {
			if cancelled.load(Ordering::Relaxed) || max_results.is_some_and(|max| state.matches >= max)
			{
				break;
			}
			process_collected_entry(
				&config,
				&cli.ignore_contains,
				&mut fd_ignores,
				&search_path.resolved,
				entry,
				&mut out,
				&mut state,
				&mut pruned_dirs,
			)?;
		}
	}
	out.flush()?;
	Ok(state)
}

fn fd_walk_request(
	root: &Path,
	cli: &FdCli,
	use_gitignore: bool,
	same_file_system: bool,
) -> pi_walker::WalkRequest {
	let min_depth = cli.exact_depth.or(cli.min_depth).unwrap_or(0);
	let max_depth = cli.exact_depth.or(cli.max_depth).unwrap_or(usize::MAX);
	pi_walker::WalkRequest::new(root)
		.hidden(include_hidden(cli))
		.gitignore(use_gitignore)
		.skip_git(false)
		.skip_node_modules(false)
		.follow_links(cli.follow.into())
		.detail(pi_walker::WalkDetail::Minimal)
		.order(pi_walker::WalkOrder::Path)
		.emit_root(true)
		.depth(min_depth, max_depth)
		.directory_errors(pi_walker::DirectoryErrorMode::Visit)
		.same_file_system(same_file_system)
		.cache(false)
		.visit_order(pi_walker::VisitOrder::PreOrder)
}

fn try_search_fast(
	cli: &FdCli,
	search_paths: &[SearchPath],
	config: &SearchConfig,
	max_results: Option<usize>,
	stdout: &mut impl Write,
	stderr: &mut impl Write,
	cancelled: &AtomicBool,
) -> io::Result<Option<SearchState>> {
	if !can_use_fast_search(cli, config) {
		return Ok(None);
	}

	let mut out = BufWriter::new(Vec::new());
	let mut err = Vec::new();
	let mut state = SearchState { matches: 0, had_error: false };
	for search_path in search_paths {
		if cancelled.load(Ordering::Relaxed) || max_results.is_some_and(|max| state.matches >= max) {
			break;
		}
		let mut matches = state.matches;
		let mut had_error = state.had_error;
		let request = fd_walk_request(&search_path.resolved, cli, false, false);
		let status = request.for_each_entry_with_heartbeat(
			cancel_heartbeat(cancelled),
			|entry| {
				if cancelled.load(Ordering::Relaxed) || max_results.is_some_and(|max| matches >= max) {
					return Ok(pi_walker::WalkDecision::Stop);
				}
				let decision = process_walker_entry(
					config,
					&cli.ignore_contains,
					entry.absolute_path.as_ref(),
					entry.depth,
					entry.file_type,
					&mut out,
					&mut matches,
				)?;
				if cancelled.load(Ordering::Relaxed) || max_results.is_some_and(|max| matches >= max) {
					Ok(pi_walker::WalkDecision::Stop)
				} else {
					Ok(decision)
				}
			},
			|error| {
				if config.show_errors {
					had_error = true;
					let _ = writeln!(err, "fd: {}", error.error);
				}
				Ok(pi_walker::WalkDecision::Include)
			},
		);
		state.matches = matches;
		state.had_error = had_error;
		match status {
			Ok(pi_walker::WalkStatus::Complete | pi_walker::WalkStatus::Stopped) => {},
			Err(pi_walker::WalkError::Interrupted(_)) if cancelled.load(Ordering::Relaxed) => break,
			Err(err) => return Err(walker_error_to_io(err)),
		}
	}
	out.flush()?;
	let output = out.into_inner().map_err(|err| err.into_error())?;
	stdout.write_all(&output)?;
	stderr.write_all(&err)?;
	Ok(Some(state))
}

const fn can_use_fast_search(cli: &FdCli, config: &SearchConfig) -> bool {
	no_ignore(cli)
		&& cli.ignore_files.is_empty()
		&& !cli.one_file_system
		&& fast_type_filter_supported(&config.types)
}

const fn fast_type_filter_supported(filter: &TypeFilter) -> bool {
	!filter.socket && !filter.pipe && !filter.block && !filter.character
}

fn process_walker_entry<W: Write>(
	config: &SearchConfig,
	ignore_contains: &[OsString],
	path: &Path,
	depth: usize,
	file_type: pi_walker::FileType,
	out: &mut W,
	matches: &mut usize,
) -> io::Result<pi_walker::WalkDecision> {
	let is_directory = file_type == pi_walker::FileType::Dir;
	if depth == 0 && is_directory {
		return Ok(pi_walker::WalkDecision::Skip);
	}
	if config.excludes.matches(path, &config.base_dir) {
		return Ok(if is_directory {
			pi_walker::WalkDecision::SkipDescend
		} else {
			pi_walker::WalkDecision::Skip
		});
	}
	if is_directory {
		if ignore_contains.iter().any(|name| path.join(name).exists()) {
			return Ok(pi_walker::WalkDecision::SkipDescend);
		}
		if config.prune
			&& config
				.matcher
				.matches(&match_target(path, &config.base_dir, config.full_path))
		{
			return Ok(pi_walker::WalkDecision::SkipDescend);
		}
	}

	let metadata = fs::symlink_metadata(path).ok();
	if !matches_walker_filters(config, path, file_type, metadata.as_ref()) {
		return Ok(pi_walker::WalkDecision::Skip);
	}
	let target = match_target(path, &config.base_dir, config.full_path);
	if !config.matcher.matches(&target) {
		return Ok(pi_walker::WalkDecision::Skip);
	}

	*matches = (*matches).saturating_add(1);
	if config.quiet {
		return Ok(pi_walker::WalkDecision::Include);
	}
	let display = display_path(config, path);
	let text = if let Some(format) = config.format.as_deref() {
		format_path(format, path, &display)
	} else {
		display
	};
	out.write_all(text.as_bytes())?;
	if config.print0 {
		out.write_all(b"\0")?;
	} else {
		out.write_all(b"\n")?;
	}
	Ok(pi_walker::WalkDecision::Include)
}

fn matches_walker_filters(
	config: &SearchConfig,
	path: &Path,
	file_type: pi_walker::FileType,
	metadata: Option<&Metadata>,
) -> bool {
	if !matches_walker_type_filter(&config.types, path, file_type, metadata) {
		return false;
	}
	if !config.extensions.is_empty() && !matches_extension(path, &config.extensions) {
		return false;
	}
	if !config.sizes.is_empty() && !matches_size_filters(&config.sizes, metadata) {
		return false;
	}
	if (config.changed_after.is_some() || config.changed_before.is_some())
		&& !matches_time_filters(config, metadata)
	{
		return false;
	}
	if !config.owners.is_empty() && !matches_owner_filters(&config.owners, metadata) {
		return false;
	}
	true
}

fn matches_walker_type_filter(
	filter: &TypeFilter,
	path: &Path,
	file_type: pi_walker::FileType,
	metadata: Option<&Metadata>,
) -> bool {
	if filter.is_empty() {
		return true;
	}
	let kind_matches = if filter.has_kind() {
		(filter.regular && file_type == pi_walker::FileType::File)
			|| (filter.directory && file_type == pi_walker::FileType::Dir)
			|| (filter.symlink && file_type == pi_walker::FileType::Symlink)
	} else {
		true
	};
	if !kind_matches {
		return false;
	}
	if filter.executable && !is_executable(metadata) {
		return false;
	}
	if filter.empty && !is_empty_entry(path, metadata, filter) {
		return false;
	}
	true
}

/// Builds a walker heartbeat closure that observes the host cancel flag.
///
/// The shared utility adapter flips `cancelled` when the shell cancellation
/// token fires, then awaits the blocking task. Without this closure,
/// `pi_walker`'s per-entry heartbeat never checks the flag and a cancelled walk
/// keeps traversing until the whole tree is collected.
/// Returning [`io::ErrorKind::Interrupted`] surfaces as
/// [`pi_walker::WalkError::Interrupted`], which the callers translate to a
/// silent break — the shared adapter owns the user-visible exit code (130), so
/// no `fd:` diagnostic is emitted.
///
/// Regression cover for #3949 (fd) and #3933 (grep/rg — same class of defect).
fn cancel_heartbeat(cancelled: &AtomicBool) -> impl Fn() -> io::Result<()> + Sync + '_ {
	move || {
		if cancelled.load(Ordering::Relaxed) {
			Err(io::Error::from(io::ErrorKind::Interrupted))
		} else {
			Ok(())
		}
	}
}

fn walker_error_to_io(err: pi_walker::WalkError<io::Error>) -> io::Error {
	match err {
		pi_walker::WalkError::Interrupted(err) => err,
		pi_walker::WalkError::InvalidData { path, message } => {
			io::Error::other(format!("{}: {message}", path.display()))
		},
	}
}

fn walker_collect_error_to_io(err: pi_walker::WalkError<String>) -> io::Error {
	match err {
		pi_walker::WalkError::Interrupted(err) => io::Error::other(err),
		pi_walker::WalkError::InvalidData { path, message } => {
			io::Error::other(format!("{}: {message}", path.display()))
		},
	}
}

fn process_collected_entry<W: Write>(
	config: &SearchConfig,
	ignore_contains: &[OsString],
	fd_ignores: &mut FdIgnoreMatcher,
	root: &Path,
	entry: &CollectedEntry,
	out: &mut W,
	state: &mut SearchState,
	pruned_dirs: &mut Vec<PathBuf>,
) -> io::Result<()> {
	let path = entry.absolute_path(root);
	if pruned_dirs.iter().any(|dir| path.starts_with(dir)) {
		return Ok(());
	}
	let depth = entry.depth();
	let is_directory = entry.file_type == pi_walker::FileType::Dir;
	if depth == 0 && is_directory {
		return Ok(());
	}
	if fd_ignores.is_ignored(&path, is_directory) {
		if is_directory {
			pruned_dirs.push(path);
		}
		return Ok(());
	}
	if config.excludes.matches(&path, &config.base_dir) {
		if is_directory {
			pruned_dirs.push(path);
		}
		return Ok(());
	}
	if is_directory {
		if ignore_contains.iter().any(|name| path.join(name).exists()) {
			pruned_dirs.push(path);
			return Ok(());
		}
		if config.prune
			&& config
				.matcher
				.matches(&match_target(&path, &config.base_dir, config.full_path))
		{
			pruned_dirs.push(path);
			return Ok(());
		}
	}

	let metadata = fs::symlink_metadata(&path).ok();
	if !matches_walker_filters(config, &path, entry.file_type, metadata.as_ref()) {
		return Ok(());
	}
	let target = match_target(&path, &config.base_dir, config.full_path);
	if !config.matcher.matches(&target) {
		return Ok(());
	}

	state.matches = state.matches.saturating_add(1);
	if config.quiet {
		return Ok(());
	}
	let display = display_path(config, &path);
	let text = if let Some(format) = config.format.as_deref() {
		format_path(format, &path, &display)
	} else {
		display
	};
	out.write_all(text.as_bytes())?;
	if config.print0 {
		out.write_all(b"\0")?;
	} else {
		out.write_all(b"\n")?;
	}
	Ok(())
}

#[cfg(unix)]
fn is_executable(metadata: Option<&Metadata>) -> bool {
	use std::os::unix::fs::PermissionsExt;
	metadata.is_some_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(metadata: Option<&Metadata>) -> bool {
	metadata.is_some_and(|meta| meta.is_file())
}

fn is_empty_entry(path: &Path, metadata: Option<&Metadata>, filter: &TypeFilter) -> bool {
	let Some(metadata) = metadata else {
		return false;
	};
	if metadata.is_file() {
		return metadata.len() == 0;
	}
	if metadata.is_dir() && (!filter.has_kind() || filter.directory) {
		return fs::read_dir(path).is_ok_and(|mut entries| entries.next().is_none());
	}
	false
}

fn matches_extension(path: &Path, extensions: &[String]) -> bool {
	let Some(extension) = path.extension().and_then(OsStr::to_str) else {
		return false;
	};
	extensions.iter().any(|expected| extension == expected)
}

fn matches_size_filters(filters: &[SizeFilter], metadata: Option<&Metadata>) -> bool {
	let Some(metadata) = metadata else {
		return false;
	};
	if !metadata.is_file() {
		return false;
	}
	filters.iter().all(|filter| match filter.ordering {
		SizeOrdering::LessOrEqual => metadata.len() <= filter.bytes,
		SizeOrdering::Equal => metadata.len() == filter.bytes,
		SizeOrdering::GreaterOrEqual => metadata.len() >= filter.bytes,
	})
}

fn matches_time_filters(config: &SearchConfig, metadata: Option<&Metadata>) -> bool {
	let Some(modified) = metadata.and_then(|meta| meta.modified().ok()) else {
		return false;
	};
	if let Some(after) = config.changed_after
		&& modified <= after
	{
		return false;
	}
	if let Some(before) = config.changed_before
		&& modified >= before
	{
		return false;
	}
	true
}

#[cfg(unix)]
fn matches_owner_filters(filters: &[OwnerMatcher], metadata: Option<&Metadata>) -> bool {
	use std::os::unix::fs::MetadataExt;
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

#[cfg(not(unix))]
fn matches_owner_filters(filters: &[OwnerMatcher], _metadata: Option<&Metadata>) -> bool {
	filters.is_empty()
}

#[cfg(unix)]
const fn owner_side_matches(side: OwnerSide, actual: u32) -> bool {
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
			let resolved = if original.is_absolute() {
				host.resolve(&original)
			} else {
				host.resolve(base_dir.join(&original))
			};
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

fn match_target(path: &Path, base_dir: &Path, full_path: bool) -> String {
	if full_path {
		return normalize_display_path(path);
	}
	path.file_name().map_or_else(
		|| normalize_display_path(path.strip_prefix(base_dir).unwrap_or(path)),
		normalize_os_str,
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
	path.to_string_lossy().replace('\\', "/")
}

fn normalize_os_str(value: &OsStr) -> String {
	value.to_string_lossy().replace('\\', "/")
}

fn format_path(template: &str, path: &Path, display: &str) -> String {
	let basename = path.file_name().map(normalize_os_str).unwrap_or_default();
	let parent = path
		.parent()
		.map(normalize_display_path)
		.unwrap_or_default();
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
	use std::{
		fs,
		sync::atomic::AtomicBool,
	};

	use tempfile::{Builder, TempDir};

	use super::{FdCli, cancel_heartbeat};
	use crate::host::run_util;

	/// Build a fresh temp directory containing a single matchable file plus a
	/// filler file, so the walker has more than one entry to iterate. Both the
	/// walker-level regressions below and the positive-path search test assert
	/// against this seed.
	fn seeded_tree(tag: &str) -> TempDir {
		let tree = Builder::new()
			.prefix(&format!("brush-fd-cancel-{tag}-"))
			.tempdir()
			.expect("temp tree should be created");
		fs::write(tree.path().join("haystack.txt"), b"needle\n")
			.expect("seed file should be written");
		fs::write(tree.path().join("filler.txt"), b"filler\n")
			.expect("filler file should be written");
		tree
	}

	/// Build the same `WalkRequest` `search`/`try_search_fast` build for the
	/// seeded tree: hidden entries included, gitignore disabled, root emitted.
	/// Keeping the shape in one place so both walker-level regressions exercise
	/// what fd actually asks the walker to do.
	fn walk_request(tree: &std::path::Path) -> pi_walker::WalkRequest {
		pi_walker::WalkRequest::new(tree)
			.hidden(true)
			.gitignore(false)
			.emit_root(true)
	}

	// Regression note (#3949): both call sites in this file feed the walker
	// `cancel_heartbeat(cancelled)` — one via `collect_with_heartbeat` in the
	// gitignore-respecting fallback path, one via `for_each_entry_with_heartbeat`
	// in the fast path. `search`/`try_search_fast` also carry an outer
	// pre-loop `if cancelled { break }` guard that fires when the flag is
	// already set before search runs, so a pre-set-flag test at the `search()`
	// level never reaches the walker (the outer guard short-circuits first) and
	// therefore does not protect the regression. The tests below drive both
	// walker APIs directly with `cancel_heartbeat` so a revert to the pre-fix
	// no-op heartbeat fails immediately.

	#[test]
	fn cancel_heartbeat_aborts_collect_with_heartbeat() {
		// Covers the fallback path's walker call: without `cancel_heartbeat`,
		// `collect_with_heartbeat` returns `Ok(outcome)` even after
		// cancellation and the fd builtin drains the whole tree before
		// observing the flag — the exact bug #3949 reports.
		let tree = seeded_tree("collect");
		let cancelled = AtomicBool::new(true);
		let err = walk_request(tree.path())
			.collect_with_heartbeat(cancel_heartbeat(&cancelled))
			.expect_err("walker must surface the cancel flag as an error");
		assert!(
			matches!(err, pi_walker::WalkError::Interrupted(_)),
			"heartbeat interruption should surface as WalkError::Interrupted, got {err:?}"
		);
	}

	#[test]
	fn cancel_heartbeat_aborts_for_each_entry_with_heartbeat() {
		// Symmetric coverage for the fast path's walker API: the streaming
		// variant must also surface `WalkError::Interrupted`, and the visitor
		// must never see any entry (proving the abort happened at the
		// heartbeat, not after entries were already delivered).
		let tree = seeded_tree("stream");
		let cancelled = AtomicBool::new(true);
		let visited = std::cell::Cell::new(0_usize);
		let result = walk_request(tree.path()).for_each_entry_with_heartbeat(
			cancel_heartbeat(&cancelled),
			|_entry| {
				visited.set(visited.get() + 1);
				Ok::<_, std::io::Error>(pi_walker::WalkDecision::Include)
			},
			|_error| Ok::<_, std::io::Error>(pi_walker::WalkDecision::Include),
		);
		let err = result.expect_err("streaming walker must surface the cancel flag as an error");
		assert!(
			matches!(err, pi_walker::WalkError::Interrupted(_)),
			"heartbeat interruption should surface as WalkError::Interrupted, got {err:?}"
		);
		assert_eq!(
			visited.get(),
			0,
			"visitor must not receive any entry once the heartbeat has aborted the walk",
		);
	}

	#[test]
	fn walk_completes_normally_when_cancel_flag_is_unset() {
		// Pin the non-cancelled contract: adding the cancel-observing heartbeat
		// must not affect a normal walk. `fd` still exercises both `search()`
		// and its walker call (the outer pre-loop guard passes with
		// cancelled=false), then finds the seeded match.
		let tree = seeded_tree("normal");
		let path = tree.path().to_str().expect("utf8 path");
		let (code, capture) = run_util::<FdCli>(&["haystack", path], "", tree.path());

		assert_eq!(code, 0);
		assert!(
			capture.out().contains("haystack.txt"),
			"stdout should list the match: {:?}",
			capture.stdout()
		);
		assert!(capture.err().is_empty(), "stderr should stay clean: {:?}", capture.stderr());
	}
}
