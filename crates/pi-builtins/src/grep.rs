//! `grep` builtin implemented on top of the ripgrep libraries.
//!
//! Matching uses `grep-regex`/`grep-searcher`; recursive searches walk and
//! run in parallel through `pi-walker`, printing files in path order. Also hosts
//! the plumbing `rg` shares with it: exit status, record layout, and the
//! line-length bound.


use std::{
	ffi::{OsStr, OsString},
	fmt,
	io::{self, Write},
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
};

use brush_core::{ShellExtensions, builtins::Registration};
use futures::{StreamExt, stream};
use clap::{ArgMatches, CommandFactory, FromArgMatches, Parser, ValueEnum, parser::ValueSource};
use globset::{Glob, GlobMatcher};
use grep_matcher::{LineTerminator, Matcher};
use grep_pcre2::RegexMatcherBuilder as PcreMatcherBuilder;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{
	BinaryDetection, Searcher, SearcherBuilder, Sink, SinkContext, SinkFinish, SinkMatch,
};
use pi_walker::{
	FileType,
	exec,
	grep::{Engine, pcre2_jit_enabled},
	walk,
};
use crate::bre;
use crate::host::{AsyncUtility, Host, async_util};
use crate::stdio;

/// Exit status of a `grep` or `rg` run: 0 when a line was selected, 1 when
/// none was, 2 on any error, except that under `-q` a match outranks errors.
pub(crate) const fn exit_status(quiet: bool, any_match: bool, had_error: bool) -> i32 {
	if quiet && any_match {
		0
	} else if had_error {
		2
	} else if any_match {
		0
	} else {
		1
	}
}

/// How `grep` and `rg` lay out the file name and record ends they print.
#[derive(Clone, Copy)]
pub(crate) struct RecordFormat {
	/// Byte printed in place of each `/` in a path (`rg --path-separator`).
	/// On Windows `\` is rewritten too, so displayed paths stay uniform.
	pub path_separator: Option<u8>,
	/// End a printed path with NUL instead of its separator or terminator
	/// (`grep -Z`, `rg -0`).
	pub null_paths:     bool,
	/// Ends each record: `\n`, or NUL under `grep -z`.
	pub terminator:     u8,
}

impl RecordFormat {
	fn write_path<W: Write + ?Sized>(&self, out: &mut W, path: &[u8]) -> io::Result<()> {
		let Some(separator) = self.path_separator else {
			return out.write_all(path);
		};
		let mut rest = path;
		while let Some(pos) = rest
			.iter()
			.position(|&byte| byte == b'/' || (cfg!(windows) && byte == b'\\'))
		{
			out.write_all(&rest[..pos])?;
			out.write_all(&[separator])?;
			rest = &rest[pos + 1..];
		}
		out.write_all(rest)
	}

	/// Writes the `PATH:LINE:COLUMN:OFFSET:` prefix of a line record, skipping
	/// absent fields; under `null_paths` NUL replaces the separator after the
	/// path. Returns whether any field was written.
	pub fn write_prefix<W: Write + ?Sized>(
		&self,
		out: &mut W,
		path: Option<&[u8]>,
		line_number: Option<u64>,
		column: Option<usize>,
		byte_offset: Option<u64>,
		separator: u8,
	) -> io::Result<bool> {
		if let Some(path) = path {
			self.write_path(out, path)?;
			out.write_all(&[if self.null_paths { b'\0' } else { separator }])?;
		}
		if let Some(number) = line_number {
			out.write_all(number.format_into(&mut fmt::NumBuffer::new()).as_bytes())?;
			out.write_all(&[separator])?;
		}
		if let Some(column) = column {
			out.write_all(column.format_into(&mut fmt::NumBuffer::new()).as_bytes())?;
			out.write_all(&[separator])?;
		}
		if let Some(offset) = byte_offset {
			out.write_all(offset.format_into(&mut fmt::NumBuffer::new()).as_bytes())?;
			out.write_all(&[separator])?;
		}
		Ok(path.is_some() || line_number.is_some() || column.is_some() || byte_offset.is_some())
	}

	/// Writes a file-name record (`-l`, `-L`, `rg --files`): the path ended
	/// by NUL under `null_paths`, else by the terminator. An unnamed input
	/// prints only the terminator, and nothing under `null_paths`.
	pub fn write_path_record<W: Write + ?Sized>(
		&self,
		out: &mut W,
		path: Option<&[u8]>,
	) -> io::Result<()> {
		match path {
			Some(path) => {
				self.write_path(out, path)?;
				out.write_all(&[if self.null_paths { b'\0' } else { self.terminator }])
			},
			None if self.null_paths => Ok(()),
			None => out.write_all(&[self.terminator]),
		}
	}

	/// Writes a `-c` record: the optional `PATH:` prefix, then `count`.
	pub fn write_count_record<W: Write + ?Sized>(
		&self,
		out: &mut W,
		path: Option<&[u8]>,
		count: u64,
	) -> io::Result<()> {
		self.write_prefix(out, path, None, None, None, b':')?;
		out.write_all(count.format_into(&mut fmt::NumBuffer::new()).as_bytes())?;
		out.write_all(&[self.terminator])
	}
}

/// Calls `visit` with each non-empty match in `line`, left to right as `-o`
/// prints them, plus its absolute byte offset given the line's `line_offset`.
pub(crate) fn for_each_nonempty_match<M: Matcher>(
	matcher: &M,
	line: &[u8],
	line_offset: u64,
	mut visit: impl FnMut(grep_matcher::Match, u64) -> io::Result<()>,
) -> io::Result<()> {
	let mut at = 0usize;
	while at <= line.len() {
		let Some(found) = matcher
			.find_at(line, at)
			.map_err(|error| io::Error::other(error.to_string()))?
		else {
			break;
		};
		if found.is_empty() {
			at = found.end() + 1;
			continue;
		}
		let match_offset = line_offset.saturating_add(
			u64::try_from(found.start()).map_err(|error| io::Error::other(error.to_string()))?,
		);
		visit(found, match_offset)?;
		at = found.end();
	}
	Ok(())
}

#[derive(Parser, Debug)]
#[command(
	name = "grep",
	version = concat!("grep (pi-uu-grep) ", env!("CARGO_PKG_VERSION")),
	about = "Search for PATTERN in each FILE or standard input.",
	disable_help_flag = true,
	disable_version_flag = true,
	args_override_self = true
)]
struct GrepArgs {
	/// Use PATTERN for matching (may be repeated; all patterns are OR-ed).
	#[arg(short = 'e', long = "regexp", value_name = "PATTERN")]
	patterns: Vec<String>,

	/// Read patterns from FILE, one per line.
	#[arg(short = 'f', long = "file", value_name = "FILE")]
	pattern_files: Vec<OsString>,

	/// Interpret PATTERN as a strict extended regular expression.
	#[arg(short = 'E', long = "extended-regexp")]
	extended: bool,

	/// Interpret PATTERN using the default basic-compatible mode.
	#[arg(short = 'G', long = "basic-regexp")]
	basic: bool,

	/// Interpret PATTERN as a fixed string.
	#[arg(short = 'F', long = "fixed-strings")]
	fixed: bool,

	/// Interpret PATTERN as a Perl-compatible regular expression.
	#[arg(short = 'P', long = "perl-regexp")]
	perl: bool,

	/// Ignore case distinctions in patterns and data.
	#[arg(short = 'i', short_alias = 'y', long = "ignore-case")]
	ignore_case: bool,

	/// Restore case-sensitive matching after an earlier -i.
	#[arg(long = "no-ignore-case")]
	no_ignore_case: bool,

	/// Select non-matching lines.
	#[arg(short = 'v', long = "invert-match")]
	invert: bool,

	/// Match only whole words.
	#[arg(short = 'w', long = "word-regexp")]
	word: bool,

	/// Match only whole lines.
	#[arg(short = 'x', long = "line-regexp")]
	line_regexp: bool,

	/// Print only a count of selected lines per FILE.
	#[arg(short = 'c', long = "count")]
	count: bool,

	/// Print only the names of FILEs with at least one selected line.
	#[arg(short = 'l', long = "files-with-matches")]
	files_with_matches: bool,

	/// Print only the names of FILEs with no selected lines.
	#[arg(short = 'L', long = "files-without-match")]
	files_without_match: bool,

	/// Stop after NUM selected lines in each input.
	#[arg(short = 'm', long = "max-count", value_name = "NUM", allow_hyphen_values = true)]
	max_count: Option<i64>,

	/// Print only the matched non-empty parts of selected lines.
	#[arg(short = 'o', long = "only-matching")]
	only_matching: bool,

	/// Quiet; suppress normal output and stop after the first selected line.
	#[arg(short = 'q', long = "quiet", visible_alias = "silent")]
	quiet: bool,

	/// Suppress error messages about nonexistent or unreadable files.
	#[arg(short = 's', long = "no-messages")]
	no_messages: bool,

	/// Prefix output with the zero-based byte offset.
	#[arg(short = 'b', long = "byte-offset")]
	byte_offset: bool,

	/// Always print the file name with output lines.
	#[arg(short = 'H', long = "with-filename")]
	with_filename: bool,

	/// Never print the file name with output lines.
	#[arg(short = 'h', long = "no-filename")]
	no_filename: bool,

	/// Use LABEL as the displayed name for standard input.
	#[arg(long = "label", value_name = "LABEL")]
	label: Option<OsString>,

	/// Prefix each output line with its one-based line number.
	#[arg(short = 'n', long = "line-number")]
	line_number: bool,

	/// Align line content on a tab stop after output prefixes.
	#[arg(short = 'T', long = "initial-tab")]
	initial_tab: bool,

	/// Write NUL instead of the separator following a file name.
	#[arg(short = 'Z', long = "null")]
	null_paths: bool,

	/// Print NUM lines of trailing context after selected lines.
	#[arg(short = 'A', long = "after-context", value_name = "NUM")]
	after_context: Option<usize>,

	/// Print NUM lines of leading context before selected lines.
	#[arg(short = 'B', long = "before-context", value_name = "NUM")]
	before_context: Option<usize>,

	/// Print NUM lines of leading and trailing context.
	#[arg(short = 'C', long = "context", value_name = "NUM")]
	context: Option<usize>,

	/// Print STRING between non-adjacent groups of context lines.
	#[arg(long = "group-separator", value_name = "STRING")]
	group_separator: Option<String>,

	/// Do not print a separator between context groups.
	#[arg(long = "no-group-separator")]
	no_group_separator: bool,

	/// Process binary input as text.
	#[arg(short = 'a', long = "text")]
	text: bool,

	/// Treat binary input as having no selected lines.
	#[arg(short = 'I')]
	binary_without_match: bool,

	/// Choose how binary input is searched.
	#[arg(long = "binary-files", value_name = "TYPE")]
	binary_files: Option<BinaryFiles>,

	/// Choose how device, FIFO, and socket operands are handled.
	#[arg(short = 'D', long = "devices", value_name = "ACTION")]
	devices: Option<DeviceAction>,

	/// Choose how directory operands are handled.
	#[arg(short = 'd', long = "directories", value_name = "ACTION")]
	directories: Option<DirectoryAction>,

	/// Search files matching GLOB.
	#[arg(long = "include", value_name = "GLOB")]
	include: Vec<String>,

	/// Skip files matching GLOB.
	#[arg(long = "exclude", value_name = "GLOB")]
	exclude: Vec<String>,

	/// Read file exclusion globs from FILE.
	#[arg(long = "exclude-from", value_name = "FILE")]
	exclude_from: Vec<OsString>,

	/// Skip directories matching GLOB during recursive searches.
	#[arg(long = "exclude-dir", value_name = "GLOB")]
	exclude_dir: Vec<String>,

	/// Search directories matching GLOB during recursive searches.
	#[arg(long = "include-dir", value_name = "GLOB")]
	include_dir: Vec<String>,

	/// Recursively search each directory operand.
	#[arg(short = 'r', long = "recursive")]
	recursive: bool,

	/// Recursively search and follow every symbolic link.
	#[arg(short = 'R', long = "dereference-recursive")]
	dereference_recursive: bool,

	/// Follow symbolic links named as command-line operands.
	#[arg(short = 'O')]
	follow_command_line: bool,

	/// Do not follow symbolic links during recursive searches.
	#[arg(short = 'p')]
	no_follow: bool,

	/// Follow every symbolic link during recursive searches.
	#[arg(short = 'S')]
	follow_all: bool,

	/// Flush standard output after each output record.
	#[arg(long = "line-buffered")]
	line_buffered: bool,

	/// Use binary I/O where the platform distinguishes it.
	#[arg(short = 'U', long = "binary")]
	binary_io: bool,

	/// Treat NUL rather than newline as the input and output record delimiter.
	#[arg(short = 'z', long = "null-data")]
	null_data: bool,

	/// Request memory-mapped input where supported.
	#[allow(dead_code, reason = "accepted BSD grep compatibility option")]
	#[arg(long = "mmap")]
	mmap: bool,

	/// Accepted compatibility option with no effect.
	#[allow(dead_code, reason = "accepted GNU grep compatibility option")]
	#[arg(short = 'u')]
	unix_byte_offsets: bool,

	/// Print a help message.
	#[allow(dead_code, reason = "clap consumes help before options are inspected")]
	#[arg(long = "help", action = clap::ArgAction::Help)]
	help: Option<bool>,

	/// Print version information.
	#[allow(dead_code, reason = "clap consumes version before options are inspected")]
	#[arg(short = 'V', long = "version", action = clap::ArgAction::Version)]
	version: Option<bool>,

	/// Accept color configuration without injecting ANSI into redirected output.
	#[allow(dead_code, reason = "color is intentionally disabled for builtin output")]
	#[arg(
		long = "color",
		alias = "colour",
		value_name = "WHEN",
		num_args = 0..=1,
		require_equals = true,
		default_missing_value = "auto",
	)]
	color: Option<String>,

	/// PATTERN followed by FILEs (PATTERN is omitted with -e or -f).
	#[arg(value_name = "ARGS")]
	args: Vec<OsString>,
}

/// Parsed GNU `grep` invocation, including option occurrence order.
pub(crate) struct Grep {
	cli: GrepArgs,
	matches: ArgMatches,
}

impl CommandFactory for Grep {
	fn command() -> clap::Command { GrepArgs::command() }
	fn command_for_update() -> clap::Command { GrepArgs::command_for_update() }
}

impl FromArgMatches for Grep {
	fn from_arg_matches(matches: &ArgMatches) -> Result<Self, clap::Error> {
		Ok(Self { cli: GrepArgs::from_arg_matches(matches)?, matches: matches.clone() })
	}
	fn update_from_arg_matches(&mut self, matches: &ArgMatches) -> Result<(), clap::Error> {
		self.cli.update_from_arg_matches(matches)?;
		self.matches = matches.clone();
		Ok(())
	}
}

impl Parser for Grep {}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum BinaryFiles {
	Binary,
	Text,
	WithoutMatch,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum DeviceAction {
	Read,
	Skip,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum DirectoryAction {
	Read,
	Skip,
	Recurse,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MatchMode {
	Default,
	Extended,
	Fixed,
	Perl,
}

/// Resolved, flag-free options shared with the search [`Sink`].
#[derive(Clone)]
struct Options {
	line_number:         bool,
	byte_offset:         bool,
	count:               bool,
	files_with_matches:  bool,
	files_without_match: bool,
	only_matching:       bool,
	before:              usize,
	after:               usize,
	no_messages:         bool,
	quiet:               bool,
	prefix_filename:     bool,
	initial_tab:         bool,
	record:              RecordFormat,
	group_separator:     Option<Vec<u8>>,
	line_buffered:       bool,
	binary_files:        BinaryFiles,
}

#[derive(Clone)]
struct PathRule {
	include: bool,
	matcher: GlobMatcher,
}

struct RuleSpec {
	index:   usize,
	include: bool,
	pattern: String,
}

#[derive(Clone, Default)]
struct PathRules {
	files: Vec<PathRule>,
	dirs:  Vec<PathRule>,
}

impl PathRules {
	fn allows_file(&self, path: &Path) -> bool {
		Self::allows(&self.files, path)
	}

	fn allows_dir(&self, path: &Path) -> bool {
		Self::allows(&self.dirs, path)
	}

	fn allows(rules: &[PathRule], path: &Path) -> bool {
		let mut allowed = rules.first().is_none_or(|first| !first.include);
		for rule in rules {
			if path_suffix_matches(&rule.matcher, path) {
				allowed = rule.include;
			}
		}
		allowed
	}
}

fn path_suffix_matches(matcher: &GlobMatcher, path: &Path) -> bool {
	let mut components = path.components();
	loop {
		let suffix = components.as_path();
		if suffix.is_empty() {
			return false;
		}
		if matcher.is_match(suffix) {
			return true;
		}
		if components.next().is_none() {
			return false;
		}
	}
}

fn last_index(matches: &ArgMatches, id: &str) -> Option<usize> {
	if matches.value_source(id) != Some(ValueSource::CommandLine) {
		return None;
	}
	matches.indices_of(id).and_then(|indices| indices.max())
}

fn choose_latest<T>(selected: &mut (usize, T), index: Option<usize>, value: T) {
	if let Some(index) = index
		&& index >= selected.0
	{
		*selected = (index, value);
	}
}

fn resolve_match_mode(matches: &ArgMatches) -> MatchMode {
	let mut selected = (0, MatchMode::Default);
	choose_latest(&mut selected, last_index(matches, "basic"), MatchMode::Default);
	choose_latest(&mut selected, last_index(matches, "extended"), MatchMode::Extended);
	choose_latest(&mut selected, last_index(matches, "fixed"), MatchMode::Fixed);
	choose_latest(&mut selected, last_index(matches, "perl"), MatchMode::Perl);
	selected.1
}

fn resolve_ignore_case(matches: &ArgMatches) -> bool {
	let mut selected = (0, false);
	choose_latest(&mut selected, last_index(matches, "ignore_case"), true);
	choose_latest(&mut selected, last_index(matches, "no_ignore_case"), false);
	selected.1
}

fn resolve_filename_prefix(matches: &ArgMatches) -> Option<bool> {
	let mut selected = (0, None);
	choose_latest(&mut selected, last_index(matches, "with_filename"), Some(true));
	choose_latest(&mut selected, last_index(matches, "no_filename"), Some(false));
	selected.1
}

fn resolve_file_list_modes(matches: &ArgMatches) -> (bool, bool) {
	let mut selected = (0, None);
	choose_latest(&mut selected, last_index(matches, "files_with_matches"), Some(true));
	choose_latest(&mut selected, last_index(matches, "files_without_match"), Some(false));
	match selected.1 {
		Some(true) => (true, false),
		Some(false) => (false, true),
		None => (false, false),
	}
}

fn resolve_context(cli: &GrepArgs, matches: &ArgMatches) -> (usize, usize) {
	let mut events = Vec::with_capacity(3);
	if let (Some(index), Some(value)) = (last_index(matches, "after_context"), cli.after_context) {
		events.push((index, false, value));
	}
	if let (Some(index), Some(value)) = (last_index(matches, "before_context"), cli.before_context) {
		events.push((index, true, value));
	}
	if let (Some(index), Some(value)) = (last_index(matches, "context"), cli.context) {
		events.push((index, false, value));
		events.push((index, true, value));
	}
	events.sort_unstable_by_key(|event| event.0);

	let mut before = 0;
	let mut after = 0;
	for (_, is_before, value) in events {
		if is_before {
			before = value;
		} else {
			after = value;
		}
	}
	(before, after)
}

fn resolve_group_separator(cli: &GrepArgs, matches: &ArgMatches) -> Option<Vec<u8>> {
	let mut selected = (0, Some(b"--".to_vec()));
	if let Some(separator) = &cli.group_separator {
		choose_latest(
			&mut selected,
			last_index(matches, "group_separator"),
			Some(separator.as_bytes().to_vec()),
		);
	}
	choose_latest(&mut selected, last_index(matches, "no_group_separator"), None);
	selected.1
}

fn resolve_directory_action(cli: &GrepArgs, matches: &ArgMatches) -> DirectoryAction {
	let mut selected = (0, DirectoryAction::Read);
	choose_latest(&mut selected, last_index(matches, "recursive"), DirectoryAction::Recurse);
	choose_latest(
		&mut selected,
		last_index(matches, "dereference_recursive"),
		DirectoryAction::Recurse,
	);
	if let Some(action) = cli.directories {
		choose_latest(&mut selected, last_index(matches, "directories"), action);
	}
	selected.1
}

/// Whether a recursive search follows symbolic links met below its operands
/// (`-R`, `-S`); a directory operand that is itself a link is always followed.
fn resolve_follow_links(cli: &GrepArgs, matches: &ArgMatches) -> bool {
	let mut selected = (0, false);
	choose_latest(&mut selected, last_index(matches, "recursive"), false);
	choose_latest(&mut selected, last_index(matches, "dereference_recursive"), true);
	if cli.directories == Some(DirectoryAction::Recurse) {
		choose_latest(&mut selected, last_index(matches, "directories"), false);
	}
	choose_latest(&mut selected, last_index(matches, "follow_command_line"), false);
	choose_latest(&mut selected, last_index(matches, "no_follow"), false);
	choose_latest(&mut selected, last_index(matches, "follow_all"), true);
	selected.1
}

fn resolve_binary_files(cli: &GrepArgs, matches: &ArgMatches) -> BinaryFiles {
	// Preserve the builtin's historical byte-transparent default. Explicit
	// GNU/BSD binary controls opt into detection.
	let mut selected = (0, BinaryFiles::Text);
	choose_latest(&mut selected, last_index(matches, "text"), BinaryFiles::Text);
	choose_latest(
		&mut selected,
		last_index(matches, "binary_without_match"),
		BinaryFiles::WithoutMatch,
	);
	if let Some(mode) = cli.binary_files {
		choose_latest(&mut selected, last_index(matches, "binary_files"), mode);
	}
	choose_latest(&mut selected, last_index(matches, "binary_io"), BinaryFiles::Binary);
	selected.1
}

fn resolve_max_count(cli: &GrepArgs) -> Result<Option<u64>, String> {
	match cli.max_count {
		None | Some(-1) => Ok(None),
		Some(value) if value >= 0 => u64::try_from(value)
			.map(Some)
			.map_err(|_| format!("invalid max count: {value}")),
		Some(value) => Err(format!("invalid max count: {value}")),
	}
}

fn option_takes_next_value(arg: &str) -> bool {
	matches!(arg, "-e" | "-f" | "-m" | "-A" | "-B" | "-C" | "-D" | "-d"
		| "--regexp" | "--file" | "--max-count" | "--after-context" | "--before-context"
		| "--context" | "--label" | "--group-separator" | "--binary-files" | "--devices"
		| "--directories" | "--include" | "--exclude" | "--exclude-from" | "--exclude-dir"
		| "--include-dir")
}

fn normalize_context_args(argv: Vec<OsString>) -> Vec<OsString> {
	let mut normalized = Vec::with_capacity(argv.len());
	let mut literal = false;
	let mut value_pending = false;
	for (index, arg) in argv.into_iter().enumerate() {
		if index == 0 || literal || value_pending {
			value_pending = false;
			normalized.push(arg);
			continue;
		}
		let Some(text) = arg.to_str() else { normalized.push(arg); continue };
		if text == "--" { literal = true; normalized.push(arg); continue }
		if let Some(digits) = text.strip_prefix('-')
			&& !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
		{
			normalized.push(OsString::from(format!("--context={digits}")));
			continue;
		}
		value_pending = option_takes_next_value(text);
		normalized.push(arg);
	}
	normalized
}

/// Build a matcher, falling back to a literal match for any pattern the engine
/// refuses.
///
/// `fallbacks` supplies the text to escape when the corresponding entry of
/// `patterns` will not compile. The two differ for a BRE, where `patterns`
/// holds the translated form: a back-reference cannot be compiled by
/// `grep-regex` at all, and escaping the TRANSLATION would make `\(a\)\1`
/// match the text `(a)\1` rather than the bytes the user typed. The literal
/// fallback must reproduce the user's pattern, which is what it did before the
/// translation step existed.
fn build_default_matcher<P: AsRef<str>, F: AsRef<str>>(
	builder: &RegexMatcherBuilder,
	patterns: &[P],
	fallbacks: &[F],
) -> Result<RegexMatcher, String> {
	debug_assert_eq!(patterns.len(), fallbacks.len());
	let error = match builder.build_many(patterns) {
		Ok(matcher) => return Ok(matcher),
		Err(error) => error,
	};
	let sanitized: Vec<String> = patterns
		.iter()
		.zip(fallbacks.iter())
		.map(|(pattern, fallback)| {
			let pattern = pattern.as_ref();
			if builder.build(pattern).is_ok() {
				pattern.to_owned()
			} else {
				regex::escape(fallback.as_ref())
			}
		})
		.collect();
	builder
		.build_many(&sanitized)
		.map_err(|_| error.to_string())
}

/// Compile all patterns using the last-selected matcher mode.
fn build_matcher(
	host: &Host,
	patterns: &[String],
	cli: &GrepArgs,
	mode: MatchMode,
	ignore_case: bool,
) -> Result<Engine, String> {
	if mode == MatchMode::Perl {
		let mut builder = PcreMatcherBuilder::new();
		builder
			.caseless(ignore_case)
			.word(cli.word && !cli.line_regexp)
			.whole_line(cli.line_regexp)
			.utf(true)
			.ucp(true)
			.jit_if_available(pcre2_jit_enabled(host.var("OMP_PCRE2_JIT")));
		return builder
			.build_many(patterns)
			.map(Engine::Pcre)
			.map_err(|error| error.to_string());
	}

	let mut builder = RegexMatcherBuilder::new();
	builder
		.case_insensitive(ignore_case)
		.word(cli.word && !cli.line_regexp)
		.whole_line(cli.line_regexp);
	if cli.null_data {
		builder.line_terminator(Some(b'\0'));
	}
	if mode == MatchMode::Fixed {
		let escaped: Vec<String> = patterns.iter().map(|pattern| regex::escape(pattern)).collect();
		return builder
			.build_many(&escaped)
			.map(Engine::Rust)
			.map_err(|error| error.to_string());
	}

	if mode == MatchMode::Default {
		// BRE is a distinct dialect, not ERE with different escaping: `\+` is
		// the operator and a bare `+` is a literal. Translating through the
		// shared BRE module is what makes `grep 'fo+'` mean "fo+" and
		// `grep '^+'` mean a leading plus, as GNU and BSD grep both do.
		//
		// The ORIGINAL patterns are handed to the fallback. `grep-regex`
		// cannot compile a back-reference, so `\(a\)\1` falls back to a
		// literal match, and it has to be the user's own text - escaping the
		// translated `(a)\1` would silently match different bytes than before
		// this translation step existed.
		let translated: Vec<String> = patterns
			.iter()
			.map(|pattern| bre::bre_to_ere(pattern, bre::Backrefs::Unsupported))
			.collect::<Result<_, _>>()
			.map_err(|e: bre::BreError| e.message().to_owned())?;
		return build_default_matcher(&builder, &translated, patterns).map(Engine::Rust);
	}

	// A `{` that opens no interval is a literal to GNU and BSD grep, but the
	// `regex` crate refuses the whole pattern, so `grep -E '{a}'` failed on
	// patterns real grep matches. An attempted-but-unterminated interval
	// stays an error in both.
	let patterns: Vec<std::borrow::Cow<'_, str>> =
		patterns.iter().map(|p| bre::ere_literalize_braces(p)).collect();

	// `regex` accepts `^+` and compiles it as `(?:^)+`, which matches at every
	// line start. GNU and BSD grep both reject the pattern, so returning every
	// line with exit 0 would be a wrong answer reported as success.
	if let Some(bad) = patterns
		.iter()
		.find(|pattern| bre::ere_repetition_operand_missing(pattern))
	{
		return Err(format!("repetition-operator operand invalid: {bad}"));
	}

	builder
		.build_many(&patterns)
		.map(Engine::Rust)
		.map_err(|error| error.to_string())
}

/// A search sink that renders GNU-compatible records and tracks selection.
struct GrepSink<'a, M: Matcher, W: Write> {
	out:         &'a mut W,
	matcher:     &'a M,
	display:     &'a [u8],
	opts:        &'a Options,
	match_count: u64,
	any_match:   bool,
	binary:      bool,
}

impl<M: Matcher, W: Write> GrepSink<'_, M, W> {
	fn flush_record(&mut self) -> io::Result<()> {
		if self.opts.line_buffered {
			self.out.flush()?;
		}
		Ok(())
	}

	fn write_prefix(
		&mut self,
		line_number: Option<u64>,
		byte_offset: u64,
		separator: u8,
	) -> io::Result<()> {
		let has_prefix = self.opts.record.write_prefix(
			self.out,
			self.opts.prefix_filename.then_some(self.display),
			line_number.filter(|_| self.opts.line_number),
			None,
			self.opts.byte_offset.then_some(byte_offset),
			separator,
		)?;
		if self.opts.initial_tab && has_prefix {
			self.out.write_all(b"\t")?;
		}
		Ok(())
	}

	fn write_record(&mut self, record: &[u8]) -> io::Result<()> {
		self.out.write_all(record)?;
		if record.last().copied() != Some(self.opts.record.terminator) {
			self.out.write_all(&[self.opts.record.terminator])?;
		}
		self.flush_record()
	}

	fn write_path_record(&mut self) -> io::Result<()> {
		self.opts.record.write_path_record(self.out, Some(self.display))?;
		self.flush_record()
	}

	fn print_only_matching(
		&mut self,
		line: &[u8],
		line_number: Option<u64>,
		line_offset: u64,
	) -> io::Result<()> {
		for_each_nonempty_match(self.matcher, line, line_offset, |found, match_offset| {
			self.write_prefix(line_number, match_offset, b':')?;
			self.write_record(&line[found.start()..found.end()])
		})
	}

	fn normal_output_is_suppressed(&self) -> bool {
		self.opts.count
			|| self.opts.files_with_matches
			|| self.opts.files_without_match
			|| self.opts.quiet
	}

	fn binary_summary(&self) -> bool {
		self.binary
			&& self.opts.binary_files == BinaryFiles::Binary
			&& !self.normal_output_is_suppressed()
	}
}

impl<M: Matcher, W: Write> Sink for GrepSink<'_, M, W> {
	type Error = io::Error;

	fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, io::Error> {
		if self.binary && self.opts.binary_files == BinaryFiles::WithoutMatch {
			return Ok(false);
		}
		self.any_match = true;
		self.match_count += 1;
		if self.opts.quiet
			|| self.opts.files_with_matches
			|| self.opts.files_without_match
			|| self.binary_summary()
		{
			return Ok(false);
		}
		if self.opts.count {
			return Ok(true);
		}
		if self.opts.only_matching {
			self.print_only_matching(mat.bytes(), mat.line_number(), mat.absolute_byte_offset())?;
		} else {
			self.write_prefix(mat.line_number(), mat.absolute_byte_offset(), b':')?;
			self.write_record(mat.bytes())?;
		}
		Ok(true)
	}

	fn context(&mut self, _searcher: &Searcher, ctx: &SinkContext<'_>) -> Result<bool, io::Error> {
		if self.normal_output_is_suppressed() || self.opts.only_matching || self.binary_summary() {
			return Ok(true);
		}
		self.write_prefix(ctx.line_number(), ctx.absolute_byte_offset(), b'-')?;
		self.write_record(ctx.bytes())?;
		Ok(true)
	}

	fn context_break(&mut self, _searcher: &Searcher) -> Result<bool, io::Error> {
		if !self.normal_output_is_suppressed()
			&& !self.opts.only_matching
			&& !self.binary_summary()
			&& let Some(separator) = &self.opts.group_separator
		{
			self.out.write_all(separator)?;
			self.out.write_all(&[self.opts.record.terminator])?;
			self.flush_record()?;
		}
		Ok(true)
	}

	fn binary_data(
		&mut self,
		_searcher: &Searcher,
		_binary_byte_offset: u64,
	) -> Result<bool, io::Error> {
		self.binary = true;
		if self.opts.binary_files == BinaryFiles::WithoutMatch {
			self.any_match = false;
			self.match_count = 0;
			return Ok(false);
		}
		Ok(true)
	}

	fn finish(&mut self, _searcher: &Searcher, _: &SinkFinish) -> Result<(), io::Error> {
		if self.opts.quiet {
			return Ok(());
		}
		if self.binary_summary() && self.any_match {
			self.out.write_all(b"Binary file ")?;
			self.out.write_all(self.display)?;
			self.out.write_all(b" matches")?;
			self.out.write_all(&[self.opts.record.terminator])?;
			return self.flush_record();
		}
		if self.opts.files_with_matches {
			if self.any_match {
				self.write_path_record()?;
			}
		} else if self.opts.files_without_match {
			if !self.any_match {
				self.write_path_record()?;
			}
		} else if self.opts.count {
			self.opts.record.write_count_record(
				self.out,
				self.opts.prefix_filename.then_some(self.display),
				self.match_count,
			)?;
			self.flush_record()?;
		}
		Ok(())
	}
}

/// Cancellation seen by the search workers: raised when either the whole
/// utility body or the directory search they serve is dropped.
#[derive(Clone)]
struct Halt {
	scope: Arc<AtomicBool>,
	outer: Arc<AtomicBool>,
}

impl Halt {
	fn raised(&self) -> bool {
		self.scope.load(Ordering::Relaxed) || self.outer.load(Ordering::Relaxed)
	}
}

/// Raises its flag on drop, halting every task that observes it.
struct HaltGuard(Arc<AtomicBool>);

impl HaltGuard {
	fn new() -> (Self, Arc<AtomicBool>) {
		let flag = Arc::new(AtomicBool::new(false));
		(Self(Arc::clone(&flag)), flag)
	}
}

impl Drop for HaltGuard {
	fn drop(&mut self) {
		self.0.store(true, Ordering::Relaxed);
	}
}

/// Bytes requested per asynchronous input read.
const READ_CHUNK: usize = 64 * 1024;

fn display_path_for_operand(operand: &OsStr, resolved: &Path, path: &Path) -> PathBuf {
	let rel = path.strip_prefix(resolved).unwrap_or(path);
	if rel.is_empty() {
		PathBuf::from(operand)
	} else {
		Path::new(operand).join(rel)
	}
}

/// One searched file's output, handed to the consumer in path order.
struct FileSearch {
	out:       Vec<u8>,
	err:       Vec<u8>,
	had_error: bool,
	matched:   io::Result<bool>,
}

/// What one search worker reuses across files: its searcher, read buffer and output buffer.
struct Worker {
	searcher: Searcher,
	buf:      Vec<u8>,
	out:      Vec<u8>,
}

impl Worker {
	/// Hands the file's output to the consumer, leaving an empty buffer in place when nothing was written.
	fn take_out(&mut self) -> Vec<u8> {
		if self.out.is_empty() {
			Vec::new()
		} else {
			std::mem::take(&mut self.out)
		}
	}
}

/// Everything the concurrent per-file searches of one directory operand share.
struct DirSearch<M> {
	fs:       pi_vfs::Fs,
	halt:     Halt,
	operand:  OsString,
	resolved: PathBuf,
	matcher:  M,
	searcher: SearcherBuilder,
	opts:     Options,
}

impl<M: Matcher + Send + Sync + 'static> DirSearch<M> {
	/// A worker whose searcher is built once from the shared builder.
	fn worker(&self) -> Worker {
		Worker { searcher: self.searcher.build(), buf: vec![0u8; READ_CHUNK], out: Vec::new() }
	}

	/// Classifies one file's search result; a broken pipe stops the search, any other error is reported per file.
	fn finish(&self, display_path: &Path, searched: io::Result<bool>, out: Vec<u8>) -> FileSearch {
		let mut err = Vec::new();
		let mut had_error = false;
		let matched = match searched {
			Ok(matched) => Ok(matched),
			// Propagate BrokenPipe to stop the search; the host maps its status.
			Err(error) if error.kind() == io::ErrorKind::BrokenPipe => Err(error),
			Err(error) => {
				had_error = true;
				if !self.opts.no_messages {
					let _ = writeln!(
						err,
						"grep: {}: {}",
						display_path.display(),
						describe_search_error(&error)
					);
				}
				Ok(false)
			},
		};
		FileSearch { out, err, had_error, matched }
	}

	/// Pushes `source` through the worker's searcher into its output buffer, failing with the cancellation error once the halt is raised.
	async fn push_source(
		&self,
		source: &mut stdio::Source,
		display: &[u8],
		worker: &mut Worker,
	) -> io::Result<bool> {
		let Worker { searcher, buf, out } = worker;
		let terminator = bound_terminator(searcher, &self.matcher);
		let mut sink = GrepSink {
			out,
			matcher: &self.matcher,
			display,
			opts: &self.opts,
			match_count: 0,
			any_match: false,
			binary: false,
		};
		let mut search = searcher.search_push(&self.matcher, &mut sink);
		let mut run = 0;
		loop {
			if self.halt.raised() {
				return Err(pi_vfs::cancelled());
			}
			let read = source.read(buf).await?;
			if read == 0 {
				break;
			}
			check_run(terminator, &mut run, &buf[..read])?;
			if !search.push(&buf[..read])? {
				break;
			}
		}
		search.finish()?;
		Ok(sink.any_match)
	}

	async fn search(&self, worker: &mut Worker, path: &Path) -> FileSearch {
		let display_path = display_path_for_operand(&self.operand, &self.resolved, path);
		match stdio::Source::open(&self.fs, path).await {
			Ok(mut source) => {
				let searched = self
					.push_source(&mut source, display_path.as_os_str().as_encoded_bytes(), worker)
					.await;
				self.finish(&display_path, searched, worker.take_out())
			},
			Err(error) => {
				let mut err = Vec::new();
				if !self.opts.no_messages {
					let _ = writeln!(err, "grep: {}: {error}", display_path.display());
				}
				FileSearch { out: Vec::new(), err, had_error: true, matched: Ok(false) }
			},
		}
	}
}

/// Recursively searches a directory operand on parallel workers, pruning
/// excluded directories and writing each file's output in path order.
#[allow(clippy::too_many_arguments)]
async fn search_dir<M: Matcher + Clone + Send + Sync + 'static, W: Write + Send>(
	host: &mut Host,
	operand: &OsStr,
	resolved: &Path,
	matcher: &M,
	searcher: &SearcherBuilder,
	opts: &Options,
	rules: &PathRules,
	follow_links: bool,
	outer: &Arc<AtomicBool>,
	out: &mut W,
	had_error: &mut bool,
) -> io::Result<bool> {
	let vfs = host.vfs();
	let (_guard, scope) = HaltGuard::new();
	let layer = pi_walker::Fs::new(&vfs, resolved);
	let walk_opts = walk::Options { hidden: true, follow_links, ..walk::Options::default() };
	let filter_rules = Arc::new(rules.clone());
	let collected = walk::collect(&layer, resolved, &walk_opts, true, move |_, entry| {
		let rel = entry.rel_path();
		match entry.file_type {
			FileType::Dir if !filter_rules.allows_dir(rel) => walk::Action::SkipDir,
			FileType::File if filter_rules.allows_file(rel) => walk::Action::Continue,
			_ => walk::Action::Skip,
		}
	})
	.await;
	let files = match collected {
		Ok(files) => files,
		Err(walk::WalkError::Root { path, error }) => {
			*had_error = true;
			if !opts.no_messages {
				let display_path = display_path_for_operand(operand, resolved, &path);
				let _ = writeln!(host.stderr, "grep: {}: {error}", display_path.display());
			}
			return Ok(false);
		},
	};
	let mut errors: Vec<_> = files.errors().iter().collect();
	errors.sort_unstable_by(|a, b| a.path.cmp(&b.path));
	for error in errors {
		*had_error = true;
		if !opts.no_messages {
			let display_path = display_path_for_operand(operand, resolved, &error.path);
			let _ = writeln!(host.stderr, "grep: {}: {}", display_path.display(), error.error);
		}
	}
	let paths: Vec<PathBuf> =
		(0..files.len()).map(|index| layer.join(resolved, files.get(index).path)).collect();
	let workers = if opts.line_buffered { 1 } else { walk_opts.parallelism(&layer) };
	let shared = Arc::new(DirSearch {
		fs:       vfs.clone(),
		halt:     Halt { scope, outer: Arc::clone(outer) },
		operand:  operand.to_owned(),
		resolved: resolved.to_owned(),
		matcher:  matcher.clone(),
		searcher: searcher.clone(),
		opts:     opts.clone(),
	});
	let mut any = false;
	let mut failed = None;
	let mut results = exec::ordered(stream::iter(paths), workers, workers, || shared.worker(), {
		let shared = Arc::clone(&shared);
		move |mut worker: Worker, path: PathBuf| {
			let shared = Arc::clone(&shared);
			async move {
				let found = shared.search(&mut worker, &path).await;
				(worker, found)
			}
		}
	});
	while let Some(found) = results.next().await {
		let written = out
			.write_all(&found.out)
			.and_then(|()| if opts.line_buffered { out.flush() } else { Ok(()) });
		if let Err(error) = written {
			failed = Some(error);
			break;
		}
		let _ = host.stderr.write_all(&found.err);
		if let Err(error) = host.flush_output().await {
			failed = Some(error);
			break;
		}
		*had_error |= found.had_error;
		match found.matched {
			Ok(matched) => any |= matched,
			Err(error) => {
				failed = Some(error);
				break;
			},
		}
		if opts.quiet && any {
			break;
		}
	}
	drop(results);
	if let Some(error) = failed {
		return Err(error);
	}
	Ok(any)
}

async fn read_auxiliary_file(host: &mut Host, path: &OsStr) -> Result<Vec<u8>, String> {
	let result = if path == OsStr::new("-") {
		let mut bytes = Vec::new();
		match host.read_stdin_to_end(&mut bytes, MAX_LINE_BYTES).await {
			Ok(_) => Ok(bytes),
			Err(error) if error.kind() == io::ErrorKind::OutOfMemory => Err(io::Error::other(format!(
				"pattern file larger than {} MiB",
				MAX_LINE_BYTES >> 20
			))),
			Err(error) => Err(error),
		}
	} else {
		read_pattern_file(&host.vfs(), &host.resolve(path)).await
	};
	result.map_err(|error| format!("{}: {error}", path.display()))
}

fn pattern_file_lines(bytes: &[u8]) -> Vec<String> {
	if bytes.is_empty() {
		return Vec::new();
	}
	String::from_utf8_lossy(bytes)
		.split_terminator('\n')
		.map(str::to_owned)
		.collect()
}

async fn resolve_patterns(host: &mut Host, cli: &GrepArgs) -> Result<(Vec<String>, Vec<OsString>), String> {
	let has_explicit_patterns = !cli.patterns.is_empty() || !cli.pattern_files.is_empty();
	let mut patterns = Vec::new();
	let mut files = Vec::new();

	if has_explicit_patterns {
		for pattern in &cli.patterns {
			patterns.extend(pattern.split('\n').map(str::to_owned));
		}
		for path in &cli.pattern_files {
			patterns.extend(pattern_file_lines(&read_auxiliary_file(host, path).await?));
		}
		files.clone_from(&cli.args);
		return Ok((patterns, files));
	}

	let mut args = cli.args.iter();
	let Some(pattern) = args.next() else {
		return Err("no pattern given\nUsage: grep [OPTION]... PATTERN [FILE]...".to_owned());
	};
	patterns.extend(pattern.to_string_lossy().split('\n').map(str::to_owned));
	files.extend(args.cloned());
	Ok((patterns, files))
}

async fn collect_rule_specs(
	host: &mut Host,
	cli: &GrepArgs,
	matches: &ArgMatches,
) -> Result<(Vec<RuleSpec>, Vec<RuleSpec>), String> {
	let mut files = Vec::new();
	if let Some(indices) = matches.indices_of("include") {
		for (index, pattern) in indices.zip(&cli.include) {
			files.push(RuleSpec { index, include: true, pattern: pattern.clone() });
		}
	}
	if let Some(indices) = matches.indices_of("exclude") {
		for (index, pattern) in indices.zip(&cli.exclude) {
			files.push(RuleSpec { index, include: false, pattern: pattern.clone() });
		}
	}
	if let Some(indices) = matches.indices_of("exclude_from") {
		for (index, path) in indices.zip(&cli.exclude_from) {
			for pattern in pattern_file_lines(&read_auxiliary_file(host, path).await?) {
				files.push(RuleSpec { index, include: false, pattern });
			}
		}
	}

	let mut dirs = Vec::new();
	if let Some(indices) = matches.indices_of("include_dir") {
		for (index, pattern) in indices.zip(&cli.include_dir) {
			dirs.push(RuleSpec { index, include: true, pattern: pattern.clone() });
		}
	}
	if let Some(indices) = matches.indices_of("exclude_dir") {
		for (index, pattern) in indices.zip(&cli.exclude_dir) {
			dirs.push(RuleSpec { index, include: false, pattern: pattern.clone() });
		}
	}
	Ok((files, dirs))
}

fn compile_rules(mut specs: Vec<RuleSpec>) -> Result<Vec<PathRule>, String> {
	specs.sort_by_key(|spec| spec.index);
	specs
		.into_iter()
		.map(|spec| {
			Glob::new(&spec.pattern)
				.map(|glob| PathRule { include: spec.include, matcher: glob.compile_matcher() })
				.map_err(|error| format!("{}: {error}", spec.pattern))
		})
		.collect()
}

async fn build_path_rules(host: &mut Host, cli: &GrepArgs, matches: &ArgMatches) -> Result<PathRules, String> {
	let (files, dirs) = collect_rule_specs(host, cli, matches).await?;
	Ok(PathRules { files: compile_rules(files)?, dirs: compile_rules(dirs)? })
}

/// Largest line, in bytes, one search may buffer; `grep` and `rg` share it.
/// Both run inside the host process, so their line buffer is the host's
/// memory: without a bound, a file with no line terminator (a sparse file reads
/// as one endless run of NUL bytes) grows it until the kernel kills the host. A
/// longer line is reported as an error for that file and the search goes on.
/// Pattern files (`-f`) are held to the same size.
pub(crate) const MAX_LINE_BYTES: usize = 256 * 1024 * 1024;

/// The searcher's own allocation cap, a backstop behind [`check_run`].
///
/// The bound stops a run one read past [`MAX_LINE_BYTES`], so the buffer needs
/// that much room plus one read's worth of growth before the typed error fires;
/// retained context lines can still push it over, and that rarer failure is
/// reported with the searcher's own message.
pub(crate) const SEARCH_HEAP_LIMIT: usize = MAX_LINE_BYTES + (1 << 20);

/// A search stopped because one record outgrew [`MAX_LINE_BYTES`].
#[derive(Debug)]
pub(crate) struct LineLimitExceeded {
	/// The searcher buffers the whole file (multi-line search), not one line.
	whole_file: bool,
}

impl fmt::Display for LineLimitExceeded {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		let what = if self.whole_file { "file larger than" } else { "line longer than" };
		write!(f, "{what} {} MiB, not searched", MAX_LINE_BYTES >> 20)
	}
}

impl std::error::Error for LineLimitExceeded {}

/// The record terminator `searcher` buffers up to, or `None` when it buffers
/// the whole input (multi-line search).
pub(crate) fn bound_terminator<M: Matcher>(searcher: &Searcher, matcher: M) -> Option<u8> {
	(!searcher.multi_line_with_matcher(matcher)).then(|| searcher.line_terminator().as_byte())
}

/// Accounts one more `chunk` of input against [`MAX_LINE_BYTES`], failing with
/// a typed [`LineLimitExceeded`] instead of letting the searcher's buffer grow.
/// In line mode `run` is the unterminated run carried over from the previous
/// chunks; in whole-file mode (no terminator) every byte counts.
pub(crate) fn check_run(terminator: Option<u8>, run: &mut usize, chunk: &[u8]) -> io::Result<()> {
	let n = chunk.len();
	// Lines strictly inside one read are shorter than the read, which the
	// searcher's heap limit already bounds; only the run crossing into
	// this read and the one left open at its end can grow without bound.
	let (crossing, open) = match terminator {
		Some(byte) => match memchr::memchr(byte, chunk) {
			Some(first) => (*run + first, n - memchr::memrchr(byte, chunk).map_or(0, |last| last + 1)),
			None => (*run + n, *run + n),
		},
		None => (*run + n, *run + n),
	};
	if crossing.max(open) > MAX_LINE_BYTES {
		return Err(io::Error::other(LineLimitExceeded { whole_file: terminator.is_none() }));
	}
	*run = open;
	Ok(())
}

/// The message for a failed search: [`LineLimitExceeded`] says which bound it
/// hit, anything else reads as reported.
pub(crate) fn describe_search_error(error: &io::Error) -> String {
	match error.get_ref().and_then(|inner| inner.downcast_ref::<LineLimitExceeded>()) {
		Some(limit) => limit.to_string(),
		None => error.to_string(),
	}
}

/// Reads a pattern file (`-f`, FIFOs and `<(…)` included) without blocking,
/// refusing one larger than [`MAX_LINE_BYTES`].
pub(crate) async fn read_pattern_file(fs: &pi_vfs::Fs, path: &Path) -> io::Result<Vec<u8>> {
	let mut bytes = Vec::new();
	let mut source = stdio::Source::open(fs, path).await?;
	match source.read_to_end(&mut bytes, MAX_LINE_BYTES).await {
		Ok(_) => Ok(bytes),
		Err(error) if error.kind() == io::ErrorKind::OutOfMemory => {
			Err(io::Error::other(format!("pattern file larger than {} MiB", MAX_LINE_BYTES >> 20)))
		},
		Err(error) => Err(error),
	}
}

fn build_searcher(cli: &GrepArgs, opts: &Options, max_count: Option<u64>) -> SearcherBuilder {
	let binary_detection = if cli.null_data || opts.binary_files == BinaryFiles::Text {
		BinaryDetection::none()
	} else if opts.binary_files == BinaryFiles::WithoutMatch {
		BinaryDetection::quit(b'\0')
	} else {
		BinaryDetection::convert(b'\0')
	};
	let mut builder = SearcherBuilder::new();
	builder
		.line_number(opts.line_number)
		.before_context(opts.before)
		.after_context(opts.after)
		.invert_match(cli.invert)
		.binary_detection(binary_detection)
		.max_matches(max_count)
		.heap_limit(Some(SEARCH_HEAP_LIMIT));
	if cli.null_data {
		builder.line_terminator(LineTerminator::byte(b'\0'));
	}
	builder
}

/// Searches stdin chunk by chunk, flushing output after each chunk so matches
/// are visible before end of input.
async fn search_stdin<M: Matcher + Clone + Send + Sync + 'static>(
	host: &mut Host,
	matcher: &M,
	builder: &SearcherBuilder,
	display: Vec<u8>,
	opts: &Options,
	out: &mut impl Write,
) -> io::Result<bool> {
	let mut searcher = builder.build();
	let terminator = bound_terminator(&searcher, matcher);
	let mut sink = GrepSink {
		out,
		matcher,
		display: &display,
		opts,
		match_count: 0,
		any_match: false,
		binary: false,
	};
	let mut search = searcher.search_push(matcher, &mut sink);
	let mut buf = vec![0u8; READ_CHUNK];
	let mut run = 0;
	loop {
		let read = host.read_stdin(&mut buf).await?;
		if read == 0 {
			break;
		}
		check_run(terminator, &mut run, &buf[..read])?;
		let more = search.push(&buf[..read])?;
		host.flush_output().await?;
		if !more {
			break;
		}
	}
	search.finish()?;
	host.flush_output().await?;
	Ok(sink.any_match)
}

#[allow(clippy::too_many_arguments)]
async fn execute_search<M: Matcher + Clone + Send + Sync + 'static>(
	host: &mut Host,
	cli: &GrepArgs,
	matcher: &M,
	files: &[OsString],
	directory_action: DirectoryAction,
	follow_links: bool,
	rules: &PathRules,
	opts: &Options,
	max_count: Option<u64>,
) -> i32 {
	let builder = build_searcher(cli, opts, max_count);
	let fs = host.vfs();
	let (_guard, outer) = HaltGuard::new();
	let mut out = host.stdout_writer();
	let mut any_match = false;
	let mut had_error = false;

	for operand in files {
		if opts.quiet && any_match {
			break;
		}

		if operand == OsStr::new("-") {
			let display = cli
				.label
				.as_deref()
				.unwrap_or_else(|| OsStr::new("(standard input)"))
				.as_encoded_bytes();
			match search_stdin(host, matcher, &builder, display.to_vec(), opts, &mut out).await {
				Ok(matched) => any_match |= matched,
				// Abort remaining work; the host maps the BrokenPipe status.
				Err(error) if error.kind() == io::ErrorKind::BrokenPipe => {
					return crate::host::SIGPIPE_EXIT_CODE;
				},
				Err(error) => {
					had_error = true;
					if !opts.no_messages {
						let _ = writeln!(
							host.stderr,
							"grep: (standard input): {}",
							describe_search_error(&error)
						);
					}
				},
			}
			continue;
		}

		let resolved = host.resolve(operand);
		match fs.metadata(&resolved).await {
			Ok(metadata) if metadata.is_dir() => match directory_action {
				DirectoryAction::Recurse => {
					if rules.allows_dir(Path::new(operand)) {
						match search_dir(
							host,
							operand.as_os_str(),
							&resolved,
							matcher,
							&builder,
							opts,
							rules,
							follow_links,
							&outer,
							&mut out,
							&mut had_error,
						)
						.await
						{
							Ok(matched) => any_match |= matched,
							Err(_) => return crate::host::SIGPIPE_EXIT_CODE,
						}
					}
				},
				DirectoryAction::Skip => {},
				DirectoryAction::Read => {
					had_error = true;
					let _ = writeln!(
						host.stderr,
						"grep: {}: Is a directory",
						operand.display()
					);
				},
			},
			Ok(metadata) => {
				if cli.devices == Some(DeviceAction::Skip) && !metadata.is_file() {
					continue;
				}
				if !rules.allows_file(Path::new(operand)) {
					continue;
				}
				let shared = DirSearch {
					fs:       fs.clone(),
					halt:     Halt { scope: Arc::clone(&outer), outer: Arc::clone(&outer) },
					operand:  operand.clone(),
					resolved: resolved.clone(),
					matcher:  matcher.clone(),
					searcher: builder.clone(),
					opts:     opts.clone(),
				};
				// Its own task, so dropping this body (cancellation) raises the
				// halt flag the search checks between reads.
				let path = resolved.clone();
				let found = match tokio::spawn(async move {
					let mut worker = shared.worker();
					shared.search(&mut worker, &path).await
				})
				.await
				{
					Ok(found) => found,
					Err(join) => std::panic::resume_unwind(join.into_panic()),
				};
				let written = out
					.write_all(&found.out)
					.and_then(|()| if opts.line_buffered { out.flush() } else { Ok(()) });
				if written.is_err() {
					return crate::host::SIGPIPE_EXIT_CODE;
				}
				let _ = host.stderr.write_all(&found.err);
				if host.flush_output().await.is_err() {
					return crate::host::SIGPIPE_EXIT_CODE;
				}
				had_error |= found.had_error;
				match found.matched {
					Ok(matched) => any_match |= matched,
					Err(_) => return crate::host::SIGPIPE_EXIT_CODE,
				}
			},
			Err(error) => {
				had_error = true;
				if !opts.no_messages {
					let _ =
						writeln!(host.stderr, "grep: {}: {error}", operand.display());
				}
			},
		}
	}

	if let Err(error) = out.flush() {
		if error.kind() == io::ErrorKind::BrokenPipe {
			return crate::host::SIGPIPE_EXIT_CODE;
		}
	}
	if host.flush_output().await.is_err() {
		return crate::host::SIGPIPE_EXIT_CODE;
	}
	exit_status(opts.quiet, any_match, had_error)
}

impl AsyncUtility for Grep {
	const NAME: &'static str = "grep";
	const USAGE_ERROR: u8 = 2;

	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		Ok(normalize_context_args(argv))
	}

	async fn run(self, host: &mut Host) -> i32 {
		let cli = self.cli;
		let matches = self.matches;

	let (mut patterns, mut files) = match resolve_patterns(host, &cli).await {
		Ok(resolved) => resolved,
		Err(error) => {
			let _ = writeln!(host.stderr, "grep: {error}");
			return 2;
		},
	};
	let directory_action = resolve_directory_action(&cli, &matches);
	if files.is_empty() {
		files.push(OsString::from(if directory_action == DirectoryAction::Recurse {
			"."
		} else {
			"-"
		}));
	}

	let max_count = match resolve_max_count(&cli) {
		Ok(max_count) => max_count,
		Err(error) => {
			let _ = writeln!(host.stderr, "grep: {error}");
			return 2;
		},
	};
	let rules = match build_path_rules(host, &cli, &matches).await {
		Ok(rules) => rules,
		Err(error) => {
			let _ = writeln!(host.stderr, "grep: {error}");
			return 2;
		},
	};
	let matcher = match build_matcher(
		host,
		&patterns,
		&cli,
		resolve_match_mode(&matches),
		resolve_ignore_case(&matches),
	) {
		Ok(matcher) => matcher,
		Err(error) => {
			let _ = writeln!(host.stderr, "grep: {error}");
			return 2;
		},
	};
	patterns.clear();

	let (files_with_matches, files_without_match) = resolve_file_list_modes(&matches);
	let suppress_context =
		cli.count || files_with_matches || files_without_match || cli.quiet || cli.only_matching;
	let (before, after) = if suppress_context {
		(0, 0)
	} else {
		resolve_context(&cli, &matches)
	};
	let prefix_filename = resolve_filename_prefix(&matches)
		.unwrap_or(directory_action == DirectoryAction::Recurse || files.len() > 1);
	let opts = Options {
		line_number: cli.line_number,
		byte_offset: cli.byte_offset,
		count: cli.count,
		files_with_matches,
		files_without_match,
		only_matching: cli.only_matching,
		before,
		after,
		no_messages: cli.no_messages,
		quiet: cli.quiet,
		prefix_filename,
		initial_tab: cli.initial_tab,
		record: RecordFormat {
			path_separator: None,
			null_paths:     cli.null_paths,
			terminator:     if cli.null_data { b'\0' } else { b'\n' },
		},
		group_separator: resolve_group_separator(&cli, &matches),
		line_buffered: cli.line_buffered,
		binary_files: resolve_binary_files(&cli, &matches),
	};
	let follow_links = resolve_follow_links(&cli, &matches);

	match matcher {
		Engine::Rust(matcher) => execute_search(
			host,
			&cli,
			&matcher,
			&files,
			directory_action,
			follow_links,
			&rules,
			&opts,
			max_count,
		)
		.await,
		Engine::Pcre(matcher) => execute_search(
			host,
			&cli,
			&matcher,
			&files,
			directory_action,
			follow_links,
			&rules,
			&opts,
			max_count,
		)
		.await,
	}
}
}

/// Creates the GNU `grep` builtin registration.
pub(crate) fn grep_builtin<SE: ShellExtensions>() -> Registration<SE> {
	async_util::<Grep, SE>()
}

#[cfg(test)]
mod tests {
	use std::{
		io::{self, Read, Write},
		sync::Arc,
	};

	use parking_lot::Mutex;

	use super::*;
	use brush_core::openfiles;
	use crate::host::{Host, run_async_util};
	#[cfg(unix)]
	use crate::host::tree_with_sparse_file;

	#[tokio::test(flavor = "multi_thread")]
	async fn path_separator_rewrites_the_native_separator_on_windows() {
		// Defends: --path-separator must rewrite the platform's own separator
		// too, or Windows paths keep mixing `\` and the configured separator.
		let mut out = Vec::new();
		RecordFormat {
			path_separator: Some(b'#'),
			null_paths:     false,
			terminator:     b'\n',
		}
		.write_path(&mut out, b"a\\b/c")
		.unwrap();
		if cfg!(windows) {
			assert_eq!(out, b"a#b#c");
		} else {
			assert_eq!(out, b"a\\b#c");
		}
	}

	struct SnapshottingStdin {
		pos:      usize,
		snapped:  bool,
		stdout:   Arc<Mutex<Option<Arc<Mutex<Vec<u8>>>>>>,
		snapshot: Arc<Mutex<Vec<u8>>>,
	}

	const SNAPSHOT_INPUT: &[u8] = b"hit\nmiss\n";

	impl Read for SnapshottingStdin {
		fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
			if self.pos < SNAPSHOT_INPUT.len() {
				let n = buf.len().min(SNAPSHOT_INPUT.len() - self.pos);
				buf[..n].copy_from_slice(&SNAPSHOT_INPUT[self.pos..self.pos + n]);
				self.pos += n;
				return Ok(n);
			}
			// Input exhausted: grep is back asking for more. Whatever it has
			// already flushed to stdout is what a live consumer would see now.
			if !self.snapped {
				let stdout = self.stdout.lock().clone().expect("stdout buffer is initialized");
				*self.snapshot.lock() = stdout.lock().clone();
				self.snapped = true;
			}
			Ok(0)
		}
	}

	impl Write for SnapshottingStdin {
		fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
			Ok(buf.len())
		}

		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}

	impl openfiles::Stream for SnapshottingStdin {
		fn clone_box(&self) -> Box<dyn openfiles::Stream> {
			Box::new(Self {
				pos:      self.pos,
				snapped:  self.snapped,
				stdout:   Arc::clone(&self.stdout),
				snapshot: Arc::clone(&self.snapshot),
			})
		}

		#[cfg(unix)]
		fn try_clone_to_owned(&self) -> Result<std::os::fd::OwnedFd, brush_core::Error> {
			Err(brush_core::error::ErrorKind::CannotConvertToNativeFd.into())
		}

		#[cfg(unix)]
		fn try_borrow_as_fd(&self) -> Result<std::os::fd::BorrowedFd<'_>, brush_core::Error> {
			Err(brush_core::error::ErrorKind::CannotConvertToNativeFd.into())
		}
	}

	async fn run(args: &[&str], stdin: &str) -> (i32, String, String) {
		let (code, capture) = run_async_util::<Grep>(args, stdin, "/").await;
		(code, capture.out(), capture.err())
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn stdin_matches_are_visible_before_eof() {
		let stdout = Arc::new(Mutex::new(None));
		let snapshot = Arc::new(Mutex::new(Vec::new()));
		let stdin = Box::new(SnapshottingStdin {
			pos: 0,
			snapped: false,
			stdout: Arc::clone(&stdout),
			snapshot: Arc::clone(&snapshot),
		});
		let (mut host, capture) = Host::for_test_with_stdin("grep", stdin, "/");
		*stdout.lock() = Some(capture.stdout_buffer());

		let parsed = Grep::try_parse_from(["grep", "hit", "-"]).unwrap();
		assert_eq!(parsed.run(&mut host).await, 0, "{}", capture.err());

		// A regression re-buffering grep's output makes matches invisible until EOF.
		assert_eq!(snapshot.lock().as_slice(), b"hit\n");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn max_count_and_no_match_statuses_are_gnu_compatible() {
		let (code, out, err) = run(&["-m1", "hit"], "hit\nmiss\nhit\n").await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "hit\n");
		let (code, out, _) = run(&["absent"], "hit\n").await;
		assert_eq!(code, 1);
		assert!(out.is_empty());
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn pattern_file_is_resolved_against_shell_cwd() {
		let tree = tempfile::tempdir().unwrap();
		std::fs::write(tree.path().join("patterns"), "alpha\nbeta\n").unwrap();
		std::fs::write(tree.path().join("haystack"), "alpha\ngamma\nbeta\n").unwrap();
		let (code, capture) = run_async_util::<Grep>(&["-f", "patterns", "haystack"], "", tree.path()).await;
		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(capture.out(), "alpha\nbeta\n");
	}

	/// A file with no line terminator used to make grep buffer it whole: on a
	/// sparse file that is an endless line of NUL bytes, and the host process
	/// grew until the kernel killed it. Now that file is a per-file error and
	/// the walk still reports matches in the other files.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn line_longer_than_the_limit_is_a_file_error_not_unbounded_memory() {
		let tree = tree_with_sparse_file();

		let (code, capture) = run_async_util::<Grep>(&["-rl", "needle", "."], "", tree.path()).await;

		assert_eq!(code, 2, "an unreadable file makes the status 2, as in GNU grep");
		assert_eq!(capture.out(), "./small\n");
		let err = capture.err();
		assert!(err.contains("grep: ./big: line longer than 256 MiB, not searched"), "{err}");
	}

	/// `-f` used to read the whole pattern file into memory, so pointing it at
	/// a sparse file (or an endless stdin) killed the host. Now an over-size
	/// pattern file is refused before anything is searched.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn pattern_file_larger_than_the_limit_is_refused() {
		let tree = tree_with_sparse_file();

		let (code, capture) = run_async_util::<Grep>(&["-f", "big", "small"], "", tree.path()).await;

		assert_eq!(code, 2);
		assert_eq!(capture.out(), "");
		let err = capture.err();
		assert!(err.contains("grep: big: pattern file larger than 256 MiB"), "{err}");
	}

	/// Drains `input` through the line bound, as the searcher would, and
	/// returns the typed limit error if one stopped it.
	fn drain_bounded(input: impl Read, terminator: Option<u8>) -> Option<String> {
		let mut input = input;
		let mut run = 0;
		let mut buf = vec![0u8; 64 * 1024];
		loop {
			let read = input.read(&mut buf).unwrap();
			if read == 0 {
				return None;
			}
			match check_run(terminator, &mut run, &buf[..read]) {
				Ok(()) => {},
				Err(error) => {
					assert!(
						error.get_ref().is_some_and(|inner| inner.is::<LineLimitExceeded>()),
						"untyped error: {error}"
					);
					return Some(describe_search_error(&error));
				},
			}
		}
	}

	/// The bound counts the unterminated run, including one that a terminator
	/// later in the same read closes: a line one byte over fails with the typed
	/// error whether or not it is ever terminated, and a terminator resets it.
	#[test]
	fn line_bound_fails_one_byte_past_the_limit_with_a_typed_error() {
		let limit = MAX_LINE_BYTES as u64;
		let line = || io::repeat(b'x').take(limit);

		assert_eq!(drain_bounded(line().chain(&b"\n"[..]).chain(line()), Some(b'\n')), None);
		let over = Some("line longer than 256 MiB, not searched".to_owned());
		assert_eq!(drain_bounded(line().chain(&b"x"[..]), Some(b'\n')), over);
		assert_eq!(drain_bounded(line().chain(&b"x\nshort\n"[..]), Some(b'\n')), over);
		assert_eq!(
			drain_bounded(line().chain(&b"\n"[..]).chain(line()).chain(&b"\n"[..]), None),
			Some("file larger than 256 MiB, not searched".to_owned())
		);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn perl_mode_supports_lookbehind() {
		let (code, out, err) = run(&["-P", "(?<=foo)bar"], "foobar\nbar\n").await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "foobar\n");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn compact_numeric_context_is_rewritten_before_clap() {
		let input = "a\nhit\nb\ngap\nc\nhit\nd\n";
		let (code, out, err) = run(&["-1", "--group-separator=@", "hit"], input).await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "a\nhit\nb\n@\nc\nhit\nd\n");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn recursive_rules_filter_walk_and_preserve_relative_names() {
		let tree = tempfile::tempdir().unwrap();
		std::fs::write(tree.path().join("keep.rs"), "hit\n").unwrap();
		std::fs::write(tree.path().join("drop.txt"), "hit\n").unwrap();
		std::fs::create_dir(tree.path().join("vendor")).unwrap();
		std::fs::write(tree.path().join("vendor/hidden.rs"), "hit\n").unwrap();
		let (code, capture) = run_async_util::<Grep>(&["-r", "--include=*.rs", "--exclude-dir=vendor", "hit", "."], "", tree.path()).await;
		assert_eq!(code, 0, "{}", capture.err());
		assert!(capture.out().contains("keep.rs:hit"));
		assert!(!capture.out().contains("drop.txt"));
		assert!(!capture.out().contains("hidden.rs"));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn recursive_search_prints_files_in_path_order() {
		let tree = tempfile::tempdir().unwrap();
		let files = ["t/z.txt", "t/b/1.txt", "t/a/c/2.txt", "t/a/b/3.txt", "t/a/0.txt", "t/m.txt"];
		for file in files {
			let path = tree.path().join(file);
			std::fs::create_dir_all(path.parent().unwrap()).unwrap();
			std::fs::write(path, "hit\n").unwrap();
		}
		let (code, capture) = run_async_util::<Grep>(&["-rl", "hit", "t"], "", tree.path()).await;
		assert_eq!(code, 0, "{}", capture.err());
		let expected: String = ["t/a/0.txt", "t/a/b/3.txt", "t/a/c/2.txt", "t/b/1.txt", "t/m.txt", "t/z.txt"]
			.iter()
			.map(|path| format!("{}\n", path.replace('/', std::path::MAIN_SEPARATOR_STR)))
			.collect();
		assert_eq!(capture.out(), expected);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn quiet_match_wins_over_later_error() {
		let tree = tempfile::tempdir().unwrap();
		std::fs::write(tree.path().join("hit"), "needle\n").unwrap();
		let (code, capture) = run_async_util::<Grep>(&["-q", "needle", "hit", "missing"], "", tree.path()).await;
		assert_eq!(code, 0);
		assert!(capture.out().is_empty());
		assert!(capture.err().is_empty());
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn byte_offsets_labels_and_nul_separators_are_rendered() {
		let (code, out, err) = run(&["-bn", "hit"], "no\nhit\n").await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "2:3:hit\n");
		let (code, out, err) = run(&["--label=pipe", "-HZ", "hit"], "hit\n").await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out.as_bytes(), b"pipe\0hit\n");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn basic_mode_is_posix_bre_and_extended_mode_is_strict() {
		let (code, out, err) = run(&["-A", "1", "fail)"], "ok\n(1 fail)\nnext\n").await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "(1 fail)\nnext\n");
		let (code, _, err) = run(&["-E", "fail)"], "fail)\n").await;
		assert_eq!(code, 2);
		assert!(err.contains("grep:"));
		// In a BRE a bare `+` is a LITERAL, so `fo+` does not match `foooo`.
		// This assertion previously expected `foooo`, which is ERE
		// behaviour; `/usr/bin/grep -e 'fo+' -e 'bar)' -h` on this input
		// prints `bar)` alone on both GNU and BSD grep. Use `fo\+` for the
		// quantifier.
		let (code, out, err) =
			run(&["-e", "fo+", "-e", "bar)", "-h"], "foooo\nbar)\nbaz\n").await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "bar)\n");
		let (code, out, err) = run(&["-e", r"fo\+", "-h"], "foooo\nbar)\nbaz\n").await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "foooo\n");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn gnu_basic_alternation_and_color_aliases_are_supported() {
		let input = "\"tools.xdev\": {}\n\"tools.toolbox\": {}\n\"tools.other\": {}\n";
		let (code, out, err) = run(&["-c", r"tools.xdev\|tools.toolbox"], input).await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "2\n");
		for color in ["--color=auto", "--color=always", "--color=never", "--color"] {
			let (code, out, err) = run(&[color, "foo"], "foo\nbar\n").await;
			assert_eq!(code, 0, "{err}");
			assert_eq!(out, "foo\n");
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn version_is_reported_on_stdout() {
		let (code, out, err) = run(&["--version"], "").await;
		assert_eq!(code, 0);
		assert!(err.is_empty());
		assert!(out.contains("grep") && out.contains("pi-uu-grep"));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn repetition_with_no_operand_is_literal_in_bre_and_invalid_in_ere() {
		// Measured against GNU/BSD grep 2.6.0 on the same fixture. Before
		// this, every BRE row below returned 5 - the whole file - because
		// `^+` reached the engine as an operator and compiled to `(?:^)+`,
		// matching the empty string at every line start.
		let input = "alpha\n+added\n-removed\n context\n+another\n";
		for (pattern, want) in
			[("^+", "2\n"), ("^*", "0\n"), ("^?", "0\n"), ("*x", "0\n"), ("^\\+", "2\n")]
		{
			let (code, out, err) = run(&["-c", pattern], input).await;
			assert!(code == 0 || code == 1, "{pattern}: {err}");
			assert_eq!(out, want, "pattern {pattern}");
		}

		// The forms that already agreed must not regress.
		for (pattern, want) in [("+added", "1\n"), ("[+]", "2\n"), ("a\\+", "3\n")] {
			let (code, out, err) = run(&["-c", pattern], input).await;
			assert_eq!(code, 0, "{pattern}: {err}");
			assert_eq!(out, want, "pattern {pattern}");
		}

		// ERE rejects it outright, as the real grep does, rather than
		// silently accepting a repeated anchor. The anchor breaks adjacency
		// to an earlier atom too: `a^+` repeats `^`, not `a`.
		for pattern in ["^+", "a^+", "a$*"] {
			let (code, _, err) = run(&["-Ec", pattern], input).await;
			assert_eq!(code, 2, "-E {pattern:?} must be rejected");
			assert!(err.contains("grep:"), "{pattern}: {err}");
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn no_operand_brace_interval_is_rejected_through_grep() {
		// Covered here rather than only in the translator, because the failure
		// mode was invisible at that level: `^\{2\}` translated to `^{2}`,
		// which `grep-regex` ACCEPTS as `(?:^){2}` and matches at every line
		// start, so the whole file came back with exit 0.
		let input = "alpha\n+added\n-removed\n context\n+another\n";
		for pattern in [r"^\{2\}", r"^\{1,4\}", r"\{1,4\}", r"\(\{2\}\)", r"a\|\{2\}"] {
			let (code, out, err) = run(&["-c", pattern], input).await;
			assert_eq!(code, 2, "{pattern} must be rejected, got {out:?}");
			assert!(err.contains("repetition-operator operand invalid"), "{pattern}: {err}");
		}
		// With an operand it is an ordinary quantifier and still works.
		let (code, out, err) = run(&["-c", r"a\{1,2\}"], input).await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "3\n");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn literal_brace_is_not_rejected_by_the_operand_check() {
		// `grep -E '^{"'` is a real pattern - the common JSON-line filter -
		// and GNU grep accepts it, because a `{` that opens no interval is a
		// literal. An earlier revision of this guard exited 2 on it.
		let input = "{\"a\":1}\n{foo\nplain\n";
		for args in
			[vec!["-c", "^{"], vec!["-Ec", "^\\{"], vec!["-Ec", "^\\{\""], vec!["-c", "{foo"]]
		{
			let (code, _, err) = run(&args, input).await;
			assert!(code == 0 || code == 1, "{args:?} must not error: {err}");
			assert!(!err.contains("operand invalid"), "{args:?}: {err}");
		}
		let (code, out, err) = run(&["-c", "^{"], input).await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "2\n");

		// NOT asserted here, and a known divergence: `-E '{a}'` and `-E 'a{'`
		// are literals to GNU grep but `regex` rejects them in its own parser,
		// which it did before this operand check existed. Making those literal
		// means rewriting ERE patterns rather than validating them.
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn unsupported_backreference_falls_back_to_the_users_own_text() {
		// `grep-regex` cannot compile a back-reference, so the pattern is
		// matched literally. That literal must be what the user typed: after
		// translation the pattern reads `(a)\1`, and escaping THAT made
		// `\(a\)\1` match the text `(a)\1` instead of `\(a\)\1`.
		let (code, out, err) = run(&["-c", r"\(a\)\1"], "x\\(a\\)\\1y\nnope\n").await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "1\n", "fallback must match the original pattern text");
		let (code, out, _) = run(&["-c", r"\(a\)\1"], "x(a)\\1y\nnope\n").await;
		assert_eq!(code, 1, "translated text must not be what is matched");
		assert_eq!(out, "0\n");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn only_the_first_caret_of_a_branch_anchors() {
		// Measured: `grep -c '^^'` counts lines beginning with a literal
		// caret, and `sed 's/^^/X/'` rewrites only those. Treating the second
		// caret as another anchor matched every line.
		let input = "^a\naaa\n^^b\n";
		let (code, out, err) = run(&["-c", "^^"], input).await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "2\n");
		let (code, out, err) = run(&["-c", r"^\^"], input).await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "2\n", "the escaped form must agree with the bare one");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn a_dollar_before_a_branch_boundary_still_anchors() {
		// `$` anchors at the end of a BRE BRANCH, not only at the end of the
		// whole pattern. Escaping it made the first branch unmatchable, so
		// lines ending in `a` were silently dropped from the result.
		let input = "a\nb\nca\nxb\nz\nax\n";
		let (code, out, err) = run(&["-c", r"a$\|b"], input).await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "4\n", "a, b, ca and xb all match");

		// The same alternation written the other way round must agree.
		let (_, out, err) = run(&["-c", r"b\|a$"], input).await;
		assert_eq!(out, "4\n", "{err}");

		// And inside a group, where `\)` ends the branch instead of `\|`.
		let (_, out, err) = run(&["-c", r"\(a$\)"], input).await;
		assert_eq!(out, "2\n", "{err}");

		// A `$` that ends neither is still a literal dollar sign.
		let (_, out, err) = run(&["-c", "a$b"], "a$b\nab\n").await;
		assert_eq!(out, "1\n", "{err}");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn bracket_expressions_are_not_translated_as_bre() {
		// Inside `[...]` the BRE operators are ordinary characters. The
		// translator used to read `\(` as a group opener, producing a pattern
		// the engine refused, which then fell back to a literal match.
		let input = "has ( paren\nhas \\ slash\nplain\n";
		let (code, out, err) = run(&["-c", r"[\(]"], input).await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "2\n", "a backslash OR a parenthesis, as measured");

		// `]` first is a literal, `^` still negates, and a character class
		for (pattern, want) in
			[(r"[]x]", "1\n"), (r"[^abc]", "3\n"), (r"[[:digit:]]", "1\n"), (r"[*+]", "1\n")]
		{
			let (code, out, err) = run(&["-c", pattern], "]\nq7\n*\nabc\n").await;
			assert_eq!(code, 0, "{pattern}: {err}");
			assert_eq!(out, want, "{pattern}");
		}

		// An unterminated bracket expression is not silently swallowed as an
		// empty class: the engine refuses it. In `grep` it then reaches the
		// pre-existing literal fallback - the same path back-references take -
		// so it matches the typed text rather than erroring the way real grep
		// does. That divergence predates this change and is unchanged by it;
		// `sed`, which has no such fallback, reports the error.
		let (code, out, err) = run(&["-c", "a[d"], "a[d\nplain\n").await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "1\n", "falls back to the literal text the user typed");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn a_brace_that_opens_no_interval_is_literal_in_an_ere() {
		// Every expectation below is a measurement from /usr/bin/grep against
		// this same input, not a reading of the spec.
		let input = "{a}\na{\n{foo\na{1}b\nplain\n}\n[{]\n";
		for (pattern, want) in [
			("{a}", "1\n"),
			("a{", "2\n"),
			("{foo", "1\n"),
			("}", "3\n"),
			("[{]", "5\n"),
			(r"\{a\}", "1\n"),
			// Still a real interval, and still applied.
			("a{1}", "4\n"),
			("a{1,2}", "4\n"),
		] {
			let (code, out, err) = run(&["-Ec", pattern], input).await;
			assert_eq!(code, 0, "-E {pattern}: {err}");
			assert_eq!(out, want, "-E {pattern}");
		}

		// The two brace patterns real grep REFUSES must stay refused. A `{`
		// followed by a digit is an attempted interval: unterminated, it is
		// "braces not balanced", and with no operand it is "repetition-operator
		// operand invalid". Escaping those would convert a diagnosed mistake
		// into a silent literal match.
		for pattern in ["a{1,2", "{1}"] {
			let (code, out, _) = run(&["-Ec", pattern], input).await;
			assert_eq!(code, 2, "-E {pattern} must stay an error, got {out:?}");
		}
	}
}

