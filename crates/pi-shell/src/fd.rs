//! In-process `fd` builtin backed by `ignore`, `globset`, and `regex`.

use std::{
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

use brush_core::{
	Error,
	builtins::{BoxFuture, ContentOptions, ContentType, Registration},
	commands::{CommandArg, ExecutionContext},
	extensions::ShellExtensions,
	openfiles::{OpenFile, OpenFiles, null},
	results::ExecutionResult,
};
use clap::{ArgAction, Parser, ValueEnum, error::ErrorKind};
use globset::{GlobBuilder, GlobMatcher};
use ignore::{DirEntry, WalkBuilder};
use regex::{Regex, RegexBuilder};

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

	fn is_empty(&self) -> bool {
		self.0.is_empty()
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

/// Creates the `fd` shell builtin registration.
pub fn fd_builtin<SE: ShellExtensions>() -> Registration<SE> {
	fn execute<SE: ShellExtensions>(
		context: ExecutionContext<'_, SE>,
		args: Vec<CommandArg>,
	) -> BoxFuture<'_, Result<ExecutionResult, Error>> {
		Box::pin(run_fd(context, args))
	}

	Registration {
		execute_func: execute::<SE>,
		content_func: fd_content,
		disabled: false,
		special_builtin: false,
		declaration_builtin: false,
		transparent_background_wrapper: false,
	}
}

async fn run_fd<SE: ShellExtensions>(
	context: ExecutionContext<'_, SE>,
	args: Vec<CommandArg>,
) -> Result<ExecutionResult, Error> {
	let stdout = context.try_fd(OpenFiles::STDOUT_FD);
	let stderr = context.try_fd(OpenFiles::STDERR_FD);
	let cwd = context.shell.working_dir().to_path_buf();
	let cancel = context.cancel_token();
	let argv: Vec<OsString> = args
		.iter()
		.map(|arg| OsString::from(arg.to_string()))
		.collect();
	drop(context);

	let cancel_flag = Arc::new(AtomicBool::new(false));
	let thread_flag = Arc::clone(&cancel_flag);
	let mut handle = tokio::task::spawn_blocking(move || {
		let mut stdout = stdout.unwrap_or_else(null_sink);
		let mut stderr = stderr.unwrap_or_else(null_sink);
		run_fd_sync(argv, cwd, &mut stdout, &mut stderr, &thread_flag)
	});

	let code = match cancel {
		Some(token) => {
			let token_check = token.clone();
			tokio::select! {
				biased;
				() = token.cancelled() => {
					cancel_flag.store(true, Ordering::Relaxed);
					let _ = (&mut handle).await;
					130
				},
				result = &mut handle => {
					if token_check.is_cancelled() { 130 } else { result.unwrap_or(1) }
				},
			}
		},
		None => handle.await.unwrap_or(1),
	};

	Ok(ExecutionResult::new(exit_status(code)))
}

fn run_fd_sync(
	argv: Vec<OsString>,
	cwd: PathBuf,
	stdout: &mut OpenFile,
	stderr: &mut OpenFile,
	cancelled: &AtomicBool,
) -> i32 {
	let cli = match FdCli::try_parse_from(argv) {
		Ok(cli) => cli,
		Err(err) => {
			let rendered = err.to_string();
			return match err.kind() {
				ErrorKind::DisplayHelp | ErrorKind::DisplayVersion => {
					let _ = write!(stdout, "{rendered}");
					0
				},
				_ => {
					let _ = write!(stderr, "{rendered}");
					2
				},
			};
		},
	};

	let quiet = cli.quiet;
	match search(cli, cwd, stdout, stderr, cancelled) {
		Ok(state) => {
			if state.had_error {
				2
			} else if quiet {
				i32::from(state.matches == 0)
			} else {
				0
			}
		},
		Err(err) => {
			let _ = writeln!(stderr, "fd: {err}");
			2
		},
	}
}

fn search(
	cli: FdCli,
	cwd: PathBuf,
	stdout: &mut OpenFile,
	stderr: &mut OpenFile,
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

	let base_dir = resolve_path(&cwd, cli.base_directory.as_deref());
	let search_paths = resolve_search_paths(&cli, &base_dir)?;
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

	let mut builder = WalkBuilder::new(&search_paths[0].resolved);
	for path in search_paths.iter().skip(1) {
		builder.add(&path.resolved);
	}
	builder.current_dir(&config.base_dir);
	if !no_ignore(&cli) {
		builder.add_custom_ignore_filename(".fdignore");
	}
	builder.hidden(!include_hidden(&cli));
	builder.ignore(!no_ignore(&cli));
	builder.git_ignore(!(no_ignore(&cli) || no_ignore_vcs(&cli)));
	builder.git_global(!(no_ignore(&cli) || no_ignore_vcs(&cli)));
	builder.git_exclude(!(no_ignore(&cli) || no_ignore_vcs(&cli)));
	builder.parents(!(no_ignore(&cli) || cli.no_ignore_parent));
	builder.require_git(!cli.no_require_git);
	builder.follow_links(cli.follow);
	builder.same_file_system(cli.one_file_system);
	if let Some(depth) = cli.exact_depth {
		builder.min_depth(Some(depth));
		builder.max_depth(Some(depth));
	} else {
		builder.min_depth(cli.min_depth);
		builder.max_depth(cli.max_depth);
	}
	if let Some(threads) = cli.threads {
		builder.threads(threads);
	}
	for ignore_file in &cli.ignore_files {
		let path = if ignore_file.is_absolute() {
			ignore_file.clone()
		} else {
			config.base_dir.join(ignore_file)
		};
		if let Some(err) = builder.add_ignore(path) {
			return Err(io::Error::other(err.to_string()));
		}
	}
	if !config.excludes.is_empty() || !cli.ignore_contains.is_empty() || config.prune {
		let excludes = config.excludes.clone();
		let base_dir = config.base_dir.clone();
		let ignore_contains = cli.ignore_contains;
		let matcher = Arc::clone(&config.matcher);
		let prune = config.prune;
		let full_path = config.full_path;
		builder.filter_entry(move |entry| {
			if entry.depth() == 0 {
				return true;
			}
			let path = entry.path();
			if excludes.matches(path, &base_dir) {
				return false;
			}
			if entry
				.file_type()
				.is_some_and(|file_type| file_type.is_dir())
			{
				if ignore_contains.iter().any(|name| path.join(name).exists()) {
					return false;
				}
				if prune && matcher.matches(&match_target(path, &base_dir, full_path)) {
					return false;
				}
			}
			true
		});
	}

	let mut out = BufWriter::new(stdout);
	let mut state = SearchState { matches: 0, had_error: false };
	for entry in builder.build() {
		if cancelled.load(Ordering::Relaxed) || max_results.is_some_and(|max| state.matches >= max) {
			break;
		}
		match entry {
			Ok(entry) => process_entry(&config, &entry, &mut out, &mut state)?,
			Err(err) => {
				if config.show_errors {
					state.had_error = true;
					let _ = writeln!(stderr, "fd: {err}");
				}
			},
		}
	}
	out.flush()?;
	Ok(state)
}

fn process_entry<W: Write>(
	config: &SearchConfig,
	entry: &DirEntry,
	out: &mut W,
	state: &mut SearchState,
) -> io::Result<()> {
	if entry.depth() == 0
		&& entry
			.file_type()
			.is_some_and(|file_type| file_type.is_dir())
	{
		return Ok(());
	}
	let path = entry.path();
	if config.excludes.matches(path, &config.base_dir) {
		return Ok(());
	}
	let metadata = entry.metadata().ok();
	if !matches_filters(config, entry, metadata.as_ref()) {
		return Ok(());
	}
	let target = match_target(path, &config.base_dir, config.full_path);
	if !config.matcher.matches(&target) {
		return Ok(());
	}

	state.matches = state.matches.saturating_add(1);
	if config.quiet {
		return Ok(());
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
	Ok(())
}

fn matches_filters(config: &SearchConfig, entry: &DirEntry, metadata: Option<&Metadata>) -> bool {
	if !matches_type_filter(&config.types, entry, metadata) {
		return false;
	}
	if !config.extensions.is_empty() && !matches_extension(entry.path(), &config.extensions) {
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

fn matches_type_filter(filter: &TypeFilter, entry: &DirEntry, metadata: Option<&Metadata>) -> bool {
	if filter.is_empty() {
		return true;
	}
	let path = entry.path();
	let is_symlink = fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink());
	let file_type = entry.file_type();
	let kind_matches = if filter.has_kind() {
		file_type.is_some_and(|file_type| {
			(filter.regular && file_type.is_file())
				|| (filter.directory && file_type.is_dir())
				|| (filter.symlink && is_symlink)
				|| matches_unix_file_type(filter, file_type)
		})
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

#[cfg(unix)]
fn matches_unix_file_type(filter: &TypeFilter, file_type: fs::FileType) -> bool {
	use std::os::unix::fs::FileTypeExt;
	(filter.socket && file_type.is_socket())
		|| (filter.pipe && file_type.is_fifo())
		|| (filter.block && file_type.is_block_device())
		|| (filter.character && file_type.is_char_device())
}

#[cfg(not(unix))]
fn matches_unix_file_type(_filter: &TypeFilter, _file_type: fs::FileType) -> bool {
	false
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

const fn owner_side_matches(side: OwnerSide, actual: u32) -> bool {
	match side {
		OwnerSide::Include(expected) => actual == expected,
		OwnerSide::Exclude(expected) => actual != expected,
	}
}

fn resolve_search_paths(cli: &FdCli, base_dir: &Path) -> io::Result<Vec<SearchPath>> {
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
				original.clone()
			} else {
				base_dir.join(&original)
			};
			SearchPath { original, resolved }
		})
		.collect())
}

struct SearchPath {
	original: PathBuf,
	resolved: PathBuf,
}

fn resolve_path(cwd: &Path, path: Option<&Path>) -> PathBuf {
	match path {
		Some(path) if path.is_absolute() => path.to_path_buf(),
		Some(path) => cwd.join(path),
		None => cwd.to_path_buf(),
	}
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

fn null_sink() -> OpenFile {
	null().unwrap_or_else(|_| OpenFile::from(io::stdout()))
}

#[allow(
	clippy::unnecessary_wraps,
	reason = "signature must match brush's CommandContentFunc fn pointer"
)]
fn fd_content(
	_name: &str,
	_content_type: ContentType,
	_options: &ContentOptions,
) -> Result<String, Error> {
	Ok("fd: fd [OPTIONS] [pattern] [path]...\n".to_string())
}

fn exit_status(code: i32) -> u8 {
	u8::try_from(code.clamp(0, 255)).unwrap_or(1)
}
