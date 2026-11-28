//! `grep` builtin implemented on top of the ripgrep libraries.
//!
//! Matching uses `grep-regex`/`grep-searcher`; recursive searches walk
//! through `omp-xfs` and search the files inline, moving to parallel
//! workers once the search runs long, printing files in path order. Also hosts
//! the plumbing `rg` shares with it: exit status, record layout, and the
//! line-length bound.


use std::{
	ffi::{OsStr, OsString},
	fmt,
	io::{self, SeekFrom, Write},
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
};

use clap::{ArgMatches, CommandFactory, FromArgMatches, Parser, ValueEnum, parser::ValueSource};
use globset::{Glob, GlobMatcher};
use grep_matcher::{LineTerminator, Matcher};
use omp_xfs::grep::pcre::RegexMatcherBuilder as PcreMatcherBuilder;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{Searcher, SearcherBuilder, Sink, SinkContext, SinkFinish, SinkMatch};
use omp_xfs::{
	FileType,
	exec,
	fs::FileOpener,
	grep::{Engine, pcre2_jit_enabled},
	walk,
};
use crate::bre;
use crate::host::{AsyncUtility, Host, StdoutFile, StreamWriter, strip_errno};
use crate::root_guard;
use crate::stdio;

/// `grep`'s spelling of the [`root_guard`] escape hatch; it has no depth cap.
const ROOT_FLAGS: root_guard::Flags = root_guard::Flags { allow: "--allow-root", depth: None };

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
	#[arg(short = 'e', long = "regexp", value_name = "PATTERN", allow_hyphen_values = true)]
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

	/// Permit a recursive search of a filesystem root such as /.
	#[arg(long = "allow-root")]
	allow_root: bool,

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
	#[allow(dead_code, reason = "the host always reads raw bytes")]
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
	max_count:           Option<u64>,
	before:              usize,
	after:               usize,
	no_messages:         bool,
	quiet:               bool,
	prefix_filename:     bool,
	initial_tab:         bool,
	record:              RecordFormat,
	group_separator:     Option<Vec<u8>>,
	/// An explicit `-A0`/`-B0`/`-C0`: GNU still separates non-adjacent
	/// matches, which the searcher only does for nonzero context.
	zero_context_groups: bool,
	line_buffered:       bool,
	binary_files:        BinaryFiles,
	/// Whether an input that is the file stdout lands in is refused; see
	/// [`Grep::run`].
	refuse_output_file:  bool,
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

/// The last-given before and after context, or `None` when no context option
/// was given.
fn resolve_context(cli: &GrepArgs, matches: &ArgMatches) -> Option<(usize, usize)> {
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
	if events.is_empty() {
		return None;
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
	Some((before, after))
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
	let mut selected = (0, BinaryFiles::Binary);
	choose_latest(&mut selected, last_index(matches, "text"), BinaryFiles::Text);
	choose_latest(
		&mut selected,
		last_index(matches, "binary_without_match"),
		BinaryFiles::WithoutMatch,
	);
	if let Some(mode) = cli.binary_files {
		choose_latest(&mut selected, last_index(matches, "binary_files"), mode);
	}
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

/// Build a matcher, falling back to a literal match for a pattern whose
/// back-reference the engine cannot run. Any other refusal is an error: the
/// BRE translation has already rejected malformed patterns.
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
			match builder.build(pattern) {
				Ok(_) => Ok(pattern.to_owned()),
				Err(_) if has_backreference(pattern) => Ok(regex::escape(fallback.as_ref())),
				Err(error) => Err(engine_error_message(&error)),
			}
		})
		.collect::<Result<_, _>>()?;
	builder
		.build_many(&sanitized)
		.map_err(|_| engine_error_message(&error))
}

/// Whether a translated pattern holds a `\1`-`\9` back-reference.
fn has_backreference(pattern: &str) -> bool {
	let mut chars = pattern.chars();
	while let Some(c) = chars.next() {
		if c == '\\' && chars.next().is_some_and(|next| matches!(next, '1'..='9')) {
			return true;
		}
	}
	false
}

/// One line for an error the regex engine raised after translation: GNU's
/// wording where glibc has a counterpart, else the engine's own final line,
/// never its multi-line excerpt of the internal `(?:…)` wrapper.
fn engine_error_message(error: &grep_regex::Error) -> String {
	let text = error.to_string();
	let line = text.lines().map(str::trim).rfind(|line| !line.is_empty()).unwrap_or_default();
	let line = line.strip_prefix("error: ").unwrap_or(line);
	if line.starts_with("invalid character class range") {
		bre::BreError::InvalidCharacterRange.gnu_message().to_owned()
	} else if line.contains("size limit") {
		bre::BreError::IntervalTooBig.gnu_message().to_owned()
	} else {
		line.to_owned()
	}
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
			.map_err(|error| engine_error_message(&error));
	}

	// In a UTF-8 locale the letter classes hold the letters that are not ASCII.
	let utf8 = crate::locale::ctype_is_utf8(host);

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
			.map(|pattern| {
				let ere = bre::bre_to_ere(pattern, bre::Backrefs::Unsupported, bre::StackedRepeats::Allowed)?;
				Ok(if utf8 { bre::utf8_letter_classes(ere.into(), ignore_case).into_owned() } else { ere })
			})
			.collect::<Result<_, bre::BreError>>()
			.map_err(|error| error.gnu_message().to_owned())?;
		return build_default_matcher(&builder, &translated, patterns).map(Engine::Rust);
	}

	let patterns = patterns
		.iter()
		.map(|pattern| {
			let ere = bre::ere_to_rust(pattern, true).map_err(|error| error.gnu_message().to_owned())?;
			Ok(if utf8 { bre::utf8_letter_classes(ere, ignore_case) } else { ere })
		})
		.collect::<Result<Vec<_>, String>>()?;

	builder
		.build_many(&patterns)
		.map(Engine::Rust)
		.map_err(|error| engine_error_message(&error))
}

/// The selected records and any binary-match notice for one input.
#[derive(Default)]
struct SearchResult {
	count:        u64,
	last_end:     Option<u64>,
	binary_match: bool,
}

impl SearchResult {
	fn report_binary(&self, err: &mut impl Write, display: &[u8]) -> io::Result<()> {
		if self.binary_match {
			err.write_all(b"grep: ")?;
			err.write_all(display)?;
			err.write_all(b": binary file matches\n")?;
		}
		Ok(())
	}
}

/// A chunk's output with explicit record boundaries, including `-Z` names.
#[derive(Default)]
struct Records {
	bytes: Vec<u8>,
	ends: Vec<usize>,
}

/// The synchronous sink marks boundaries for the asynchronous output drain.
struct RecordWriter<'a>(&'a parking_lot::Mutex<Records>);

impl Write for RecordWriter<'_> {
	fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
		self.0.lock().bytes.extend_from_slice(bytes);
		Ok(bytes.len())
	}

	fn flush(&mut self) -> io::Result<()> {
		let mut records = self.0.lock();
		let end = records.bytes.len();
		records.ends.push(end);
		Ok(())
	}
}

/// Delivers each complete line to the real destination before the next read.
struct RecordDelivery<'a, W> {
	pending: &'a parking_lot::Mutex<Records>,
	out: &'a mut W,
}

impl<W: Write> RecordDelivery<'_, W> {
	async fn drain(&mut self, host: &Host) -> io::Result<()> {
		let mut records = std::mem::take(&mut *self.pending.lock());
		let mut start = 0;
		for end in records.ends.drain(..) {
			self.out.write_all(&records.bytes[start..end])?;
			self.out.flush()?;
			host.sync_output().await?;
			start = end;
		}
		records.bytes.clear();
		*self.pending.lock() = records;
		Ok(())
	}
}

/// A search sink that renders GNU-compatible records and tracks selection.
struct GrepSink<'a, M: Matcher, W: Write> {
	out:        &'a mut W,
	matcher:    &'a M,
	display:    &'a [u8],
	opts:       &'a Options,
	binary:     &'a AtomicBool,
	result:     SearchResult,
	after_left: usize,
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
		// Match the line without its terminator, as GNU grep does, so `$`
		// anchors at its end.
		let line = line.strip_suffix(&[self.opts.record.terminator]).unwrap_or(line);
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
		self.opts.binary_files == BinaryFiles::Binary
			&& self.binary.load(Ordering::Relaxed)
			&& !self.normal_output_is_suppressed()
	}

	/// The user-supplied limit counts selected records, not context records.
	fn limit_reached(&self) -> bool {
		self.opts.max_count == Some(self.result.count)
	}

	/// Writes context and stops once the trailing context at the match limit is complete.
	fn print_context(&mut self, bytes: &[u8], line_number: Option<u64>, offset: u64) -> io::Result<bool> {
		// The searcher can hand over one more record after a sink asked it to
		// stop (inverted matches at the limit); it is past the context.
		if self.limit_reached() && self.after_left == 0 {
			return Ok(false);
		}
		if !self.normal_output_is_suppressed() && !self.opts.only_matching && !self.binary_summary() {
			self.write_prefix(line_number, offset, b'-')?;
			self.write_record(bytes)?;
		}
		if !self.limit_reached() {
			return Ok(true);
		}
		self.after_left -= 1;
		Ok(self.after_left != 0)
	}

	fn write_group_separator(&mut self) -> io::Result<()> {
		if let Some(separator) = &self.opts.group_separator {
			self.out.write_all(separator)?;
			self.out.write_all(&[self.opts.record.terminator])?;
			self.flush_record()?;
		}
		Ok(())
	}
}

impl<M: Matcher, W: Write> Sink for GrepSink<'_, M, W> {
	type Error = io::Error;

	fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, io::Error> {
		if self.opts.binary_files == BinaryFiles::WithoutMatch && self.binary.load(Ordering::Relaxed) {
			return Ok(false);
		}
		let start = mat.absolute_byte_offset();
		if self.limit_reached() {
			return self.print_context(mat.bytes(), mat.line_number(), start);
		}
		let previous = self.result.last_end.replace(start + mat.bytes().len() as u64);
		self.result.count += 1;
		if self.binary_summary() {
			self.result.binary_match = true;
			return Ok(false);
		}
		if self.opts.quiet || self.opts.files_with_matches || self.opts.files_without_match {
			return Ok(false);
		}
		if self.opts.count {
			return Ok(!self.limit_reached());
		}
		if self.opts.zero_context_groups && previous.is_some_and(|end| end != start) {
			self.write_group_separator()?;
		}
		if self.opts.only_matching {
			self.print_only_matching(mat.bytes(), mat.line_number(), start)?;
		} else {
			self.write_prefix(mat.line_number(), start, b':')?;
			self.write_record(mat.bytes())?;
		}
		Ok(!self.limit_reached() || self.after_left != 0)
	}

	fn context(&mut self, _searcher: &Searcher, ctx: &SinkContext<'_>) -> Result<bool, io::Error> {
		self.print_context(ctx.bytes(), ctx.line_number(), ctx.absolute_byte_offset())
	}

	fn context_break(&mut self, _searcher: &Searcher) -> Result<bool, io::Error> {
		if !self.normal_output_is_suppressed()
			&& !self.opts.only_matching
			&& !self.binary_summary()
			&& !self.limit_reached()
		{
			self.write_group_separator()?;
		}
		Ok(true)
	}

	fn finish(&mut self, _searcher: &Searcher, _: &SinkFinish) -> Result<(), io::Error> {
		if self.opts.quiet {
			return Ok(());
		}
		if self.opts.binary_files == BinaryFiles::WithoutMatch && self.binary.load(Ordering::Relaxed) {
			self.result = SearchResult::default();
		}
		if self.opts.files_with_matches {
			if self.result.count != 0 {
				self.write_path_record()?;
			}
		} else if self.opts.files_without_match {
			if self.result.count == 0 {
				self.write_path_record()?;
			}
		} else if self.opts.count {
			self.opts.record.write_count_record(
				self.out,
				self.opts.prefix_filename.then_some(self.display),
				self.result.count,
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

impl FileSearch {
	/// Delivers a completed file's buffered output and tracks its errors.
	fn publish(self, host: &mut Host, out: &mut StreamWriter, had_error: &mut bool) -> io::Result<bool> {
		if !self.out.is_empty() {
			out.write_all(&self.out)?;
		}
		if !self.err.is_empty() {
			let _ = host.stderr.write_all(&self.err);
		}
		*had_error |= self.had_error;
		self.matched
	}
}

/// What one search worker reuses across files: its searcher, read buffer, output buffer, and the opener of a native tree's files.
struct Worker {
	searcher: Searcher,
	buf:      Vec<u8>,
	out:      Vec<u8>,
	opener:   Option<FileOpener>,
	/// Reused for the path of each listed file.
	path:     PathBuf,
	/// Reused for the displayed name of each listed file.
	display:  PathBuf,
}

/// A file being searched.
enum Input {
	/// A regular file a native walk listed, opened relative to its directory.
	Listed(omp_xfs::fs::File),
	Source(stdio::Source),
}

impl Input {
	/// The identity of the file that was opened, read from the handle rather
	/// than from the path it was opened by.
	async fn metadata(&self) -> Option<omp_vfs::Metadata> {
		match self {
			Self::Listed(file) => file.metadata().ok(),
			Self::Source(source) => source.handle_metadata().await,
		}
	}

	/// Reads up to `buf.len()` bytes; 0 at end of input.
	async fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		match self {
			Self::Listed(file) => {
				// Reads never suspend: spend the coop budget so a long run
				// still yields and its cancellation takes effect.
				tokio::task::coop::consume_budget().await;
				file.read(buf).await
			},
			Self::Source(source) => source.read(buf).await,
		}
	}
}

/// A scan's input, with a host only when output can be delivered immediately.
enum ScanInput<'a> {
	Stdin(&'a mut Host),
	File {
		input: &'a mut Input,
		halt: &'a Halt,
		host: Option<&'a mut Host>,
	},
}

impl ScanInput<'_> {
	async fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		match self {
			Self::Stdin(host) => host.read_stdin(buf).await,
			Self::File { input, halt, .. } => {
				if halt.raised() {
					return Err(omp_vfs::cancelled());
				}
				input.read(buf).await
			},
		}
	}

	fn host(&self) -> Option<&Host> {
		match self {
			Self::Stdin(host) => Some(host),
			Self::File { host, .. } => host.as_deref(),
		}
	}
}

/// Searches raw reads and drains any live output before awaiting more input.
async fn scan<M: Matcher, W: Write>(
	input: &mut ScanInput<'_>,
	searcher: &mut Searcher,
	matcher: &M,
	opts: &Options,
	display: &[u8],
	buf: &mut [u8],
	out: &mut W,
) -> io::Result<SearchResult> {
	let binary = AtomicBool::new(false);
	if opts.line_buffered {
		let pending = parking_lot::Mutex::new(Records::default());
		let mut writer = RecordWriter(&pending);
		let sink = GrepSink {
			out: &mut writer,
			matcher,
			display,
			opts,
			binary: &binary,
			result: SearchResult::default(),
			after_left: opts.after,
		};
		scan_into(input, searcher, sink, buf, Some(RecordDelivery { pending: &pending, out })).await
	} else {
		let sink = GrepSink {
			out,
			matcher,
			display,
			opts,
			binary: &binary,
			result: SearchResult::default(),
			after_left: opts.after,
		};
		scan_into::<_, _, W>(input, searcher, sink, buf, None).await
	}
}

/// Classifies each raw buffer before matching even its first complete line.
async fn scan_into<M: Matcher, W: Write, D: Write>(
	input: &mut ScanInput<'_>,
	searcher: &mut Searcher,
	mut sink: GrepSink<'_, M, W>,
	buf: &mut [u8],
	mut delivery: Option<RecordDelivery<'_, D>>,
) -> io::Result<SearchResult> {
	let terminator = bound_terminator(searcher, sink.matcher);
	let binary = sink.binary;
	let mode = sink.opts.binary_files;
	let detect = mode != BinaryFiles::Text && sink.opts.record.terminator != b'\0';
	let mut search = searcher.search_push(sink.matcher, &mut sink);
	let mut run = 0;
	loop {
		let read = input.read(buf).await?;
		if read == 0 {
			break;
		}
		let chunk = &mut buf[..read];
		if detect && let Some(first) = memchr::memchr(0, chunk) {
			binary.store(true, Ordering::Relaxed);
			if mode == BinaryFiles::WithoutMatch {
				break;
			}
			// In binary mode GNU searches each NUL-separated piece as a line.
			for byte in &mut chunk[first..] {
				if *byte == 0 {
					*byte = b'\n';
				}
			}
		}
		check_run(terminator, &mut run, chunk)?;
		let more = search.push(chunk)?;
		deliver_scan_output(input.host(), delivery.as_mut()).await?;
		if !more {
			break;
		}
	}
	search.finish()?;
	deliver_scan_output(input.host(), delivery.as_mut()).await?;
	Ok(sink.result)
}

/// Drains queued records individually, or delivers a plain stdout batch.
async fn deliver_scan_output<W: Write>(
	host: Option<&Host>,
	delivery: Option<&mut RecordDelivery<'_, W>>,
) -> io::Result<()> {
	let Some(host) = host else {
		return Ok(());
	};
	match delivery {
		Some(delivery) => delivery.drain(host).await,
		None => host.flush_output().await,
	}
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

/// The walked files of a directory operand, searched by index.
struct Listed {
	layer: omp_xfs::Fs,
	files: walk::Collection,
}

/// Everything the concurrent per-file searches of one directory operand share.
struct DirSearch<M> {
	fs:       omp_vfs::Fs,
	/// The directory operand's files; a native tree's open through each
	/// worker's [`FileOpener`]. `None` for a file operand.
	listed:   Option<Listed>,
	halt:     Halt,
	operand:  OsString,
	resolved: PathBuf,
	matcher:  M,
	searcher: SearcherBuilder,
	opts:     Options,
	/// The file stdout lands in, when the refusal in [`DirSearch::refused`]
	/// is on and stdout is a regular file.
	stdout:   Option<StdoutFile>,
}

impl<M: Matcher + Send + Sync + 'static> DirSearch<M> {
	/// A worker whose searcher is built once from the shared builder.
	fn worker(&self) -> Worker {
		Worker {
			searcher: self.searcher.build(),
			buf:      vec![0u8; READ_CHUNK],
			out:      Vec::new(),
			opener:   self
				.listed
				.as_ref()
				.filter(|listed| listed.layer.is_native())
				.map(|listed| FileOpener::new(&listed.layer)),
			path:     PathBuf::new(),
			display:  PathBuf::new(),
		}
	}

	/// Classifies one file's search result; a broken pipe stops the search, any other error is reported per file.
	fn finish(&self, display_path: &Path, searched: io::Result<SearchResult>, out: Vec<u8>) -> FileSearch {
		let mut err = Vec::new();
		let mut had_error = false;
		let matched = match searched {
			Ok(result) => {
				let _ = result.report_binary(&mut err, display_path.as_os_str().as_encoded_bytes());
				Ok(result.count != 0)
			},
			// Propagate BrokenPipe to stop the search; the host maps its status.
			Err(error) if error.kind() == io::ErrorKind::BrokenPipe => Err(error),
			Err(error) => {
				had_error = true;
				if !self.opts.no_messages {
					let _ = writeln!(err, "grep: {}: {}", display_path.display(), strip_errno(&error));
				}
				Ok(false)
			},
		};
		FileSearch { out, err, had_error, matched }
	}

	/// Opens `path`: a listed file of a native tree through the worker's
	/// opener, anything that fails there (a special file, an error) through
	/// `fs`, which reports it as a standalone open would.
	async fn open(&self, worker: &mut Worker, path: &Path) -> io::Result<Input> {
		if let Some(opener) = &mut worker.opener
			&& self.fs.is_native_local(path)
			&& let Ok(file) = opener.open(path).await
		{
			return Ok(Input::Listed(file));
		}
		stdio::Source::open(&self.fs, path).await.map(Input::Source)
	}

	/// Searches the `index`th listed file, its paths built in the worker's
	/// buffers.
	async fn search_listed(
		&self,
		worker: &mut Worker,
		index: usize,
		stream: Option<(&mut Host, &mut StreamWriter)>,
	) -> FileSearch {
		let listed = self.listed.as_ref().expect("a directory search lists its files");
		let rel = listed.files.get(index).path;
		let (mut path, mut display) = (std::mem::take(&mut worker.path), std::mem::take(&mut worker.display));
		listed.layer.join_into(&mut path, &self.resolved, rel);
		if listed.layer.is_native() {
			listed.layer.join_into(&mut display, Path::new(&self.operand), rel);
		} else {
			display = display_path_for_operand(&self.operand, &self.resolved, &path);
		}
		let found = self.search_at(worker, &path, &display, stream).await;
		(worker.path, worker.display) = (path, display);
		found
	}

	async fn search(
		&self,
		worker: &mut Worker,
		path: &Path,
		stream: Option<(&mut Host, &mut StreamWriter)>,
	) -> FileSearch {
		let display_path = display_path_for_operand(&self.operand, &self.resolved, path);
		self.search_at(worker, path, &display_path, stream).await
	}

	/// The search of a file that is also the file stdout lands in, refused
	/// the way GNU grep refuses it: the matches written into the file would
	/// be read back and matched again, so the file grows without bound.
	fn refused(&self, display_path: &Path) -> FileSearch {
		let mut err = Vec::new();
		if !self.opts.no_messages {
			let _ = writeln!(
				err,
				"grep: {}: input file is also the output",
				display_path.display()
			);
		}
		FileSearch { out: Vec::new(), err, had_error: true, matched: Ok(false) }
	}

	/// Whether `input` — already opened — is the file stdout lands in.
	///
	/// The decision is made on the handle that was opened, as GNU grep's
	/// `SAME_INODE (st, out_stat)` is, so a path replaced or a symlink
	/// retargeted between the walk and the open cannot slip past the refusal.
	async fn is_output_file(&self, input: &Input) -> bool {
		let Some(stdout) = &self.stdout else {
			return false;
		};
		match input.metadata().await {
			Some(opened) => stdout.matches(&opened),
			None => false,
		}
	}

	async fn search_at(
		&self,
		worker: &mut Worker,
		path: &Path,
		display_path: &Path,
		stream: Option<(&mut Host, &mut StreamWriter)>,
	) -> FileSearch {
		match self.open(worker, path).await {
			Ok(mut input) => {
				if self.opts.refuse_output_file && self.is_output_file(&input).await {
					return self.refused(display_path);
				}
				let display = display_path.as_os_str().as_encoded_bytes();
				let Worker { searcher, buf, out, .. } = worker;
				let searched = match stream {
					Some((host, output)) => {
						let mut input = ScanInput::File { input: &mut input, halt: &self.halt, host: Some(host) };
						scan(&mut input, searcher, &self.matcher, &self.opts, display, buf, output).await
					},
					None => {
						let mut input = ScanInput::File { input: &mut input, halt: &self.halt, host: None };
						scan(&mut input, searcher, &self.matcher, &self.opts, display, buf, out).await
					},
				};
				self.finish(display_path, searched, worker.take_out())
			},
			Err(error) => {
				let mut err = Vec::new();
				if !self.opts.no_messages {
					let _ = writeln!(err, "grep: {}: {}", display_path.display(), strip_errno(&error));
				}
				FileSearch { out: Vec::new(), err, had_error: true, matched: Ok(false) }
			},
		}
	}
}

/// Recursively searches a directory operand ([`exec::adaptive`]: inline, then on parallel workers), pruning
/// excluded directories and writing each file's output in path order.
#[allow(clippy::too_many_arguments)]
async fn search_dir<M: Matcher + Clone + Send + Sync + 'static>(
	host: &mut Host,
	operand: &OsStr,
	resolved: &Path,
	matcher: &M,
	searcher: &SearcherBuilder,
	opts: &Options,
	rules: &PathRules,
	follow_links: bool,
	outer: &Arc<AtomicBool>,
	out: &mut StreamWriter,
	had_error: &mut bool,
) -> io::Result<bool> {
	let vfs = host.vfs();
	let (_guard, scope) = HaltGuard::new();
	let layer = omp_xfs::Fs::new(&vfs, resolved);
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
				let _ = writeln!(host.stderr, "grep: {}: {}", display_path.display(), strip_errno(&error));
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
			let _ = writeln!(host.stderr, "grep: {}: {}", display_path.display(), strip_errno(&error.error));
		}
	}
	let count = files.len();
	let workers = walk_opts.parallelism(&layer);
	let shared = Arc::new(DirSearch {
		fs:       vfs.clone(),
		listed:   Some(Listed { layer, files }),
		halt:     Halt { scope, outer: Arc::clone(outer) },
		operand:  operand.to_owned(),
		resolved: resolved.to_owned(),
		matcher:  matcher.clone(),
		searcher: searcher.clone(),
		opts:     opts.clone(),
		stdout:   host.stdout_file(),
	});
	let mut any = false;
	if opts.line_buffered {
		let mut worker = shared.worker();
		for index in 0..count {
			let found = shared.search_listed(&mut worker, index, Some((host, out))).await;
			any |= found.publish(host, out, had_error)?;
			host.sync_output().await?;
			if opts.quiet && any {
				break;
			}
		}
		return Ok(any);
	}

	let mut failed = None;
	let mut pace = host.output_pace();
	let mut results = exec::adaptive(0..count, workers, exec::INLINE_BUDGET, || shared.worker(), {
		let shared = Arc::clone(&shared);
		move |mut worker: Worker, index: usize| {
			let shared = Arc::clone(&shared);
			async move {
				let found = shared.search_listed(&mut worker, index, None).await;
				(worker, found)
			}
		}
	});
	while let Some(found) = results.next().await {
		match found.publish(host, out, had_error) {
			Ok(matched) => any |= matched,
			Err(error) => {
				failed = Some(error);
				break;
			},
		}
		let delivered = if !results.next_ready() {
			host.flush_output().await
		} else {
			host.pace_output(&mut pace).await
		};
		if let Err(error) = delivered {
			failed = Some(error);
			break;
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
	result.map_err(|error| format!("{}: {}", path.display(), strip_errno(&error)))
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
/// hit, anything else reads as reported. grep itself prints GNU's
/// [`strip_errno`] form instead.
#[cfg_attr(not(feature = "util.rg"), allow(dead_code, reason = "only rg keeps ripgrep's raw error text"))]
pub(crate) fn describe_search_error(error: &io::Error) -> String {
	match error.get_ref().and_then(|inner| inner.downcast_ref::<LineLimitExceeded>()) {
		Some(limit) => limit.to_string(),
		None => error.to_string(),
	}
}

/// Reads a pattern file (`-f`, FIFOs and `<(…)` included) without blocking,
/// refusing one larger than [`MAX_LINE_BYTES`].
pub(crate) async fn read_pattern_file(fs: &omp_vfs::Fs, path: &Path) -> io::Result<Vec<u8>> {
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

fn build_searcher(cli: &GrepArgs, opts: &Options) -> SearcherBuilder {
	let mut builder = SearcherBuilder::new();
	builder
		.line_number(opts.line_number)
		.before_context(opts.before)
		.after_context(opts.after)
		.invert_match(cli.invert)
		.bom_sniffing(false)
		.heap_limit(Some(SEARCH_HEAP_LIMIT));
	if cli.null_data {
		builder.line_terminator(LineTerminator::byte(b'\0'));
	}
	builder
}

/// Searches stdin and restores a seekable offset after a reached match limit.
async fn search_stdin<M: Matcher>(
	host: &mut Host,
	matcher: &M,
	builder: &SearcherBuilder,
	display: &[u8],
	opts: &Options,
	out: &mut StreamWriter,
) -> io::Result<SearchResult> {
	let limit = opts.max_count.filter(|_| !opts.quiet && !opts.files_with_matches && !opts.files_without_match);
	let start = match limit {
		Some(_) => host.stdin.file().seek_async(SeekFrom::Current(0)).await.ok(),
		None => None,
	};
	let mut buf = vec![0u8; READ_CHUNK];
	let result = scan(
		&mut ScanInput::Stdin(host),
		&mut builder.build(),
		matcher,
		opts,
		display,
		&mut buf,
		out,
	)
	.await?;
	// Trailing context is printed, but belongs to the next reader as well.
	if limit == Some(result.count)
		&& let (Some(start), Some(end)) = (start, result.last_end)
	{
		host.stdin.file().seek_async(SeekFrom::Start(start + end)).await?;
	}
	Ok(result)
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
) -> i32 {
	if opts.max_count == Some(0) {
		return 1;
	}
	let builder = build_searcher(cli, opts);
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
			// `--label` names standard input everywhere else, so it names it
			// in the refusal diagnostic too.
			let input_name = cli.label.as_deref().unwrap_or_else(|| OsStr::new("(standard input)"));
			if opts.refuse_output_file && host.stdin_is_stdout() {
				// GNU grep refuses standard input that is the file its output
				// lands in: the matches it writes would be read back and
				// matched again, so the input is never read.
				had_error = true;
				if !opts.no_messages {
					let _ = writeln!(
						host.stderr,
						"grep: {}: input file is also the output",
						input_name.to_string_lossy()
					);
				}
				continue;
			}
			let display = input_name.as_encoded_bytes();
			match search_stdin(host, matcher, &builder, display, opts, &mut out).await {
				Ok(result) => {
					any_match |= result.count != 0;
					let _ = result.report_binary(&mut host.stderr, display);
				},
				// Abort remaining work; the host maps the BrokenPipe status.
				Err(error) if error.kind() == io::ErrorKind::BrokenPipe => {
					return crate::host::SIGPIPE_EXIT_CODE;
				},
				Err(error) => {
					had_error = true;
					if !opts.no_messages {
						let _ = writeln!(host.stderr, "grep: (standard input): {}", strip_errno(&error));
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
					listed:   None,
					halt:     Halt { scope: Arc::clone(&outer), outer: Arc::clone(&outer) },
					operand:  operand.clone(),
					resolved: resolved.clone(),
					matcher:  matcher.clone(),
					searcher: builder.clone(),
					opts:     opts.clone(),
					stdout:   host.stdout_file(),
				};
				let found = if opts.line_buffered {
					shared.search(&mut shared.worker(), &resolved, Some((host, &mut out))).await
				} else {
					// Dropping this body raises the halt flag the search checks between reads.
					match tokio::spawn(async move {
						let mut worker = shared.worker();
						shared.search(&mut worker, &resolved, None).await
					})
					.await
					{
						Ok(found) => found,
						Err(join) => std::panic::resume_unwind(join.into_panic()),
					}
				};
				match found.publish(host, &mut out, &mut had_error) {
					Ok(matched) => any_match |= matched,
					Err(_) => return crate::host::SIGPIPE_EXIT_CODE,
				}
				if host.flush_output().await.is_err() {
					return crate::host::SIGPIPE_EXIT_CODE;
				}
			},
			Err(error) => {
				had_error = true;
				if !opts.no_messages {
					let _ = writeln!(host.stderr, "grep: {}: {}", operand.display(), strip_errno(&error));
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
	/// grep must not read the file its own output lands in.
	const CHECKS_STDOUT_PATH: bool = true;

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
	if directory_action == DirectoryAction::Recurse
		&& !cli.allow_root
		&& let Err(refusal) = root_guard::check(files.iter().map(|file| host.resolve(file)), None, ROOT_FLAGS)
	{
		let _ = writeln!(host.stderr, "grep: {refusal}");
		return 2;
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
	// A search that selects no record never writes to the file it reads, so
	// that file is not its own output and the refusal below must stay off. An
	// empty pattern file leaves nothing to match, and an inverted empty
	// pattern matches every record and so selects none. `-x` and `-w`
	// constrain the empty pattern, so they can still select records.
	let zero_patterns = patterns.is_empty();
	let inverted_empty_pattern = cli.invert
		&& !cli.line_regexp
		&& !cli.word
		&& !zero_patterns
		&& patterns.iter().all(|pattern| pattern.is_empty());
	let selects_no_record = (zero_patterns && !cli.invert) || inverted_empty_pattern;
	patterns.clear();

	let (files_with_matches, files_without_match) = resolve_file_list_modes(&matches);
	let suppress_context =
		cli.count || files_with_matches || files_without_match || cli.quiet || cli.only_matching;
	let context = resolve_context(&cli, &matches);
	let (before, after) = if suppress_context { (0, 0) } else { context.unwrap_or_default() };
	// `-o` zeroes the searcher's context, so only a context the user gave as
	// zero separates its matches.
	let zero_context_groups = context == Some((0, 0));
	let prefix_filename = resolve_filename_prefix(&matches)
		.unwrap_or(directory_action == DirectoryAction::Recurse || files.len() > 1);
	// GNU grep refuses to search the file its own output lands in: the matches
	// it writes would be read back and matched again, so the file grows
	// without bound. It exempts the modes that write at most one line per file
	// (`-q`, `-c`, `-l`, `-L`) and the bounded `-m1`, which stop before their
	// output can feed back into the search, and the searches that select no
	// record at all.
	let refuse_output_file = !cli.quiet
		&& !cli.count
		&& !files_with_matches
		&& !files_without_match
		&& max_count.is_none_or(|count| count > 1)
		&& !selects_no_record;
	let opts = Options {
		line_number: cli.line_number,
		byte_offset: cli.byte_offset,
		count: cli.count,
		files_with_matches,
		files_without_match,
		only_matching: cli.only_matching,
		max_count,
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
		zero_context_groups,
		line_buffered: cli.line_buffered,
		binary_files: resolve_binary_files(&cli, &matches),
		refuse_output_file,
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
		)
		.await,
	}
}
}

#[cfg(test)]
mod tests {
	use std::{
		io::{self, Read, Write},
		sync::Arc,
	};

	use parking_lot::Mutex;

	use super::*;
	use crate::openfile as openfiles;
	use crate::host::{Host, run_async_util, run_caught_async};
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

	impl openfiles::Stream for SnapshottingStdin {}

	async fn run(args: &[&str], stdin: &str) -> (i32, String, String) {
		let (code, capture) = run_async_util::<Grep>(args, stdin, "/").await;
		(code, capture.out(), capture.err())
	}

	/// Failure mode: `grep -r x /` walked the whole disk for hours.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn recursive_search_refuses_the_filesystem_root() {
		// `-q` stops a regression at the first match instead of reading the disk.
		let (code, out, err) = run(&["-rq", "e", "/"], "").await;
		assert_eq!((code, out.as_str()), (2, ""));
		assert!(err.starts_with("grep: refusing") && err.contains("--allow-root"), "stderr: {err}");
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

	/// A NUL-bearing buffer emitted raw matches, including lines before its NUL.
	#[tokio::test(flavor = "multi_thread")]
	async fn binary_detection_applies_to_the_whole_read() {
		let input = "x\na\0b\n";
		let notice = "grep: (standard input): binary file matches\n";
		for (args, code, out, err) in [
			(&["a"][..], 0, "", notice),
			(&["-n", "x"], 0, "", notice),
			(&["-o", "a"], 0, "", notice),
			(&["-s", "a"], 0, "", notice),
			(&["z"], 1, "", ""),
			(&["-a", "a"], 0, "a\0b\n", ""),
			(&["--text", "a"], 0, "a\0b\n", ""),
			(&["--binary-files=without-match", "x"], 1, "", ""),
			(&["-I", "a"], 1, "", ""),
			(&["-c", "a"], 0, "1\n", ""),
			(&["-cI", "a"], 1, "0\n", ""),
			(&["-l", "a"], 0, "(standard input)\n", ""),
			(&["-lI", "a"], 1, "", ""),
			(&["-q", "a"], 0, "", ""),
			(&["-qI", "a"], 1, "", ""),
			(&["-oI", "a"], 1, "", ""),
		] {
			let actual = run(args, input).await;
			assert_eq!((actual.0, actual.1.as_str(), actual.2.as_str()), (code, out, err), "{args:?}");
		}
	}

	/// A binary match used to send data to stdout instead of naming the file on stderr.
	#[tokio::test(flavor = "multi_thread")]
	async fn binary_file_reports_its_operand_on_stderr() {
		let tree = tempfile::tempdir().unwrap();
		std::fs::write(tree.path().join("data"), b"x\na\0b\n").unwrap();
		let (code, capture) = run_async_util::<Grep>(&["-n", "x", "data"], "", tree.path()).await;
		assert_eq!(code, 0);
		assert!(capture.out().is_empty());
		assert_eq!(capture.err(), "grep: data: binary file matches\n");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn max_count_and_no_match_statuses_are_gnu_compatible() {
		let (code, out, err) = run(&["-m1", "hit"], "hit\nmiss\nhit\n").await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "hit\n");
		// Other matching lines within trailing context use the context prefix
		// and don't count toward the limit.
		let (code, out, err) = run(&["-n", "-m1", "-A2", "hit"], "hit\nhit\nctx\nhit\n").await;
		assert_eq!((code, out.as_str(), err.as_str()), (0, "1:hit\n2-hit\n3-ctx\n", ""));
		let (code, out, _) = run(&["absent"], "hit\n").await;
		assert_eq!(code, 1);
		assert!(out.is_empty());
	}

	/// `-e` exists so a pattern may start with `-` (GNU grep); clap used to
	/// read `-e --canary` as an unknown `--canary` flag and exit 2.
	#[tokio::test(flavor = "multi_thread")]
	async fn regexp_operand_may_start_with_a_dash() {
		let input = "x --canary\n-> y\nz\n";
		let (code, out, err) = run(&["-e", "--canary"], input).await;
		assert_eq!((code, out.as_str()), (0, "x --canary\n"), "{err}");
		let (code, out, err) = run(&["-ne", "->", "--regexp", "-z"], input).await;
		assert_eq!((code, out.as_str()), (0, "2:-> y\n"), "{err}");
	}

	/// `$` in `-o` / `-z` patterns anchors at the end of the line, as in GNU grep.
	#[tokio::test(flavor = "multi_thread")]
	async fn only_matching_anchors_at_end_of_terminated_lines() {
		let input = "v1.2.3\nx=42\n";
		for (args, stdin, expected) in [
			(&["-o", "c$"][..], "abc\n", "c\n"),
			(&["-o", "c$"], "abc", "c\n"),
			(&["-oE", "[0-9]+$"], input, "3\n42\n"),
			(&["-nboE", "[0-9]+$"], input, "1:5:3\n2:9:42\n"),
			(&["-zoE", "[0-9]+$"], "v1.2.3\0x=42\0", "3\x0042\0"),
			(&["-zE", "[0-9]+$"], "v1.2.3\0x=42\0", "v1.2.3\0x=42\0"),
			(&["-ox", "abc"], "abc\nab\n", "abc\n"),
			(&["-o", "^.*$"], "a\nb\n", "a\nb\n"),
		] {
			let (code, out, err) = run(args, stdin).await;
			assert_eq!((code, out.as_str()), (0, expected), "grep {args:?}: {err}");
		}
		let (code, out, err) = run(&["-coE", "[0-9]+$"], input).await;
		assert_eq!((code, out.as_str()), (0, "2\n"), "{err}");
		// `$` ends the NUL-terminated record, not a line inside it.
		let (code, out, err) = run(&["-zo", "b$"], "ab\ncd\0").await;
		assert_eq!((code, out.as_str()), (1, ""), "{err}");
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

		let (code, capture) = run_async_util::<Grep>(&["-arl", "needle", "."], "", tree.path()).await;

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

	/// Runs `grep` with `args` in `cwd` and stdout redirected (`>>`) into
	/// `stdout_path`, the way the shell sets it up, returning its exit status
	/// together with the captured stderr.
	async fn run_with_stdout_file(
		args: &[&str],
		cwd: &std::path::Path,
		stdout_path: &std::path::Path,
	) -> (i32, String) {
		let stdout = std::fs::OpenOptions::new()
			.append(true)
			.open(stdout_path)
			.expect("stdout file");
		let (mut host, capture) = Host::for_test_async("grep", "", cwd);
		host.set_test_stdout(openfiles::OpenFile::File(Arc::new(stdout)));
		let code = run_parsed(args, &mut host).await;
		(code, capture.err())
	}

	/// Runs `grep` with `args` and standard input and stdout both on `path`,
	/// the way `… < out >> out` sets them up, returning its exit status
	/// together with the captured stderr.
	async fn run_with_stdin_and_stdout_file(
		args: &[&str],
		cwd: &std::path::Path,
		path: &std::path::Path,
	) -> (i32, String) {
		let stdout = std::fs::OpenOptions::new()
			.append(true)
			.open(path)
			.expect("stdout file");
		let stdin = std::fs::OpenOptions::new()
			.read(true)
			.open(path)
			.expect("stdin file");
		let (mut host, capture) = Host::for_test_async("grep", "", cwd);
		host.set_test_stdin(openfiles::OpenFile::File(Arc::new(stdin)));
		host.set_test_stdout(openfiles::OpenFile::File(Arc::new(stdout)));
		let code = run_parsed(args, &mut host).await;
		(code, capture.err())
	}

	/// Parses `args` as the adapter does, runs `grep` on `host`, and drains
	/// the output the body buffered.
	async fn run_parsed(args: &[&str], host: &mut Host) -> i32 {
		let argv = std::iter::once(OsString::from("grep"))
			.chain(args.iter().copied().map(OsString::from))
			.collect::<Vec<_>>();
		let argv = Grep::rewrite_argv(argv).expect("rewrite argv");
		let parsed = Grep::try_parse_from(argv).expect("parse");
		run_caught_async::<Grep>(parsed, host).await
	}

	/// Contract: grep refuses to search the file its own output lands in.
	///
	/// GNU grep rejects that input with exit status 2 and "input file is also
	/// the output", because the matches it writes would be read back and
	/// matched again. A consumer that redirects grep's output into a file it
	/// also searches must see that diagnostic rather than a growing file.
	#[tokio::test(flavor = "multi_thread")]
	async fn searching_the_output_file_itself_is_refused() {
		let tree = tempfile::tempdir().unwrap();
		let path = tree.path().join("out.txt");
		std::fs::write(&path, "needle\n").unwrap();
		let (code, err) =
			run_with_stdout_file(&["-m2", "needle", "out.txt"], tree.path(), &path).await;
		assert_eq!(code, 2, "{err}");
		assert!(err.contains("input file is also the output"), "{err}");
		// The refused input is left exactly as it was.
		assert_eq!(std::fs::read(&path).unwrap(), b"needle\n");
	}

	/// Contract: grep refuses standard input that is the file its output lands
	/// in.
	///
	/// GNU grep reports `(standard input): input file is also the output` and
	/// exits 2, because the matches it writes would be read back and matched
	/// again; the input is never read at all.
	#[tokio::test(flavor = "multi_thread")]
	async fn reading_standard_input_that_is_the_output_file_is_refused() {
		let tree = tempfile::tempdir().unwrap();
		let path = tree.path().join("out.txt");
		std::fs::write(&path, "needle\n").unwrap();
		let (code, err) =
			run_with_stdin_and_stdout_file(&["needle", "-"], tree.path(), &path).await;
		assert_eq!(code, 2, "{err}");
		assert!(
			err.contains("(standard input): input file is also the output"),
			"{err}"
		);
		// The refused input is left exactly as it was.
		assert_eq!(std::fs::read(&path).unwrap(), b"needle\n");
	}

	/// Contract: `--label` names standard input in the refusal diagnostic.
	///
	/// GNU grep reports the label it was given, not the generic
	/// `(standard input)`, when it refuses an input that is also its output.
	#[tokio::test(flavor = "multi_thread")]
	async fn the_label_names_standard_input_in_the_refusal_diagnostic() {
		let tree = tempfile::tempdir().unwrap();
		let path = tree.path().join("out.txt");
		std::fs::write(&path, "needle\n").unwrap();
		let (code, err) =
			run_with_stdin_and_stdout_file(&["--label=foo", "needle", "-"], tree.path(), &path)
				.await;
		assert_eq!(code, 2, "{err}");
		assert!(err.contains("grep: foo: input file is also the output"), "{err}");
		assert_eq!(std::fs::read(&path).unwrap(), b"needle\n");
	}

	/// Contract: `--no-messages` silences the refusal but keeps its status.
	///
	/// GNU grep still exits 2 for an input that is also its output when `-s`
	/// is given; only the diagnostic is suppressed.
	#[tokio::test(flavor = "multi_thread")]
	async fn no_messages_suppresses_the_refusal_message_but_not_its_status() {
		let tree = tempfile::tempdir().unwrap();
		let path = tree.path().join("out.txt");
		std::fs::write(&path, "needle\n").unwrap();
		let (code, err) =
			run_with_stdout_file(&["-s", "needle", "out.txt"], tree.path(), &path).await;
		assert_eq!(code, 2);
		assert_eq!(err, "");
		assert_eq!(std::fs::read(&path).unwrap(), b"needle\n");
	}

	/// Contract: a recursive search refuses the output file it walks into.
	///
	/// GNU grep names the offending file by its path under the searched
	/// directory and exits 2.
	#[tokio::test(flavor = "multi_thread")]
	async fn a_recursive_search_refuses_the_output_file_it_walks_into() {
		let tree = tempfile::tempdir().unwrap();
		let dir = tree.path().join("tree");
		std::fs::create_dir(&dir).unwrap();
		let path = dir.join("out.txt");
		std::fs::write(&path, "needle\n").unwrap();
		let (code, err) = run_with_stdout_file(&["-r", "needle", "tree"], tree.path(), &path).await;
		assert_eq!(code, 2, "{err}");
		// The name is built with `Path::join`, as the implementation builds
		// it, so the separator is the native one.
		let named = Path::new("tree").join("out.txt");
		assert!(
			err.contains(&format!("{}: input file is also the output", named.display())),
			"{err}"
		);
		assert_eq!(std::fs::read(&path).unwrap(), b"needle\n");
	}

	/// Contract: the modes whose output cannot feed back into the search still
	/// read the file they write to.
	///
	/// GNU grep exempts them from the same-file rejection: `-q`, `-c` and the
	/// list modes write at most one line per file, and `-m1` stops after the
	/// first match. Each row below checks the record the mode leaves in the
	/// file it read, and the exit status it reports.
	#[tokio::test(flavor = "multi_thread")]
	async fn modes_that_cannot_feed_their_output_back_still_read_the_output_file() {
		for (args, expected_code, expected_file) in [
			(&["-q", "needle", "out.txt"][..], 0, &b"needle\n"[..]),
			(&["-c", "needle", "out.txt"][..], 0, &b"needle\n1\n"[..]),
			(&["-l", "needle", "out.txt"][..], 0, &b"needle\nout.txt\n"[..]),
			// A file without a match is the one `-L` lists, so it prints its
			// name and reports that no line matched.
			(&["-L", "absent", "out.txt"][..], 1, &b"needle\nout.txt\n"[..]),
			(&["-m1", "needle", "out.txt"][..], 0, &b"needle\nneedle\n"[..]),
		] {
			let tree = tempfile::tempdir().unwrap();
			let path = tree.path().join("out.txt");
			std::fs::write(&path, "needle\n").unwrap();
			let (code, err) = run_with_stdout_file(args, tree.path(), &path).await;
			assert_eq!(code, expected_code, "{args:?}: {err}");
			assert_eq!(std::fs::read(&path).unwrap(), *expected_file, "{args:?}: {err}");
		}
	}

	/// Contract: the modes whose output cannot feed back into the search still
	/// read standard input that is also the output file.
	///
	/// The exemption holds for standard input as well as for a named file.
	#[tokio::test(flavor = "multi_thread")]
	async fn modes_that_cannot_feed_their_output_back_still_read_standard_input() {
		for (args, expected_code, expected_file) in [
			(&["-q", "needle"][..], 0, &b"needle\n"[..]),
			(&["-c", "needle"][..], 0, &b"needle\n1\n"[..]),
			(&["-l", "needle"][..], 0, &b"needle\n(standard input)\n"[..]),
			(&["-L", "absent"][..], 1, &b"needle\n(standard input)\n"[..]),
			(&["-m1", "needle"][..], 0, &b"needle\nneedle\n"[..]),
		] {
			let tree = tempfile::tempdir().unwrap();
			let path = tree.path().join("out.txt");
			std::fs::write(&path, "needle\n").unwrap();
			let (code, err) =
				run_with_stdin_and_stdout_file(args, tree.path(), &path).await;
			assert_eq!(code, expected_code, "{args:?}: {err}");
			assert_eq!(std::fs::read(&path).unwrap(), *expected_file, "{args:?}: {err}");
		}
	}

	/// Contract: a search with no pattern at all is not reading its own
	/// output.
	///
	/// GNU grep reads a file whose pattern file is empty, reports that no line
	/// matched, and leaves the file alone: the search selects no record, so it
	/// writes nothing that could be read back.
	#[tokio::test(flavor = "multi_thread")]
	async fn a_search_with_no_patterns_is_not_refused_as_the_output_file() {
		let tree = tempfile::tempdir().unwrap();
		let path = tree.path().join("out.txt");
		std::fs::write(&path, "needle\n").unwrap();
		std::fs::write(tree.path().join("patterns"), "").unwrap();
		let (code, err) =
			run_with_stdout_file(&["-f", "patterns", "out.txt"], tree.path(), &path).await;
		assert_eq!(code, 1, "{err}");
		assert!(!err.contains("input file is also the output"), "{err}");
		// The file is read, and left exactly as it was.
		assert_eq!(std::fs::read(&path).unwrap(), b"needle\n");
	}

	/// Contract: an inverted search with no pattern at all is still refused.
	///
	/// The boundary of the exemption above: with no pattern the matcher
	/// matches nothing, and an inverted search of it selects every record.
	/// GNU grep therefore still rejects the file it writes into.
	#[tokio::test(flavor = "multi_thread")]
	async fn an_inverted_search_with_no_patterns_is_still_refused() {
		let tree = tempfile::tempdir().unwrap();
		let path = tree.path().join("out.txt");
		std::fs::write(&path, "needle\n").unwrap();
		std::fs::write(tree.path().join("patterns"), "").unwrap();
		let (code, err) =
			run_with_stdout_file(&["-v", "-f", "patterns", "out.txt"], tree.path(), &path).await;
		assert_eq!(code, 2, "{err}");
		assert!(err.contains("input file is also the output"), "{err}");
		assert_eq!(std::fs::read(&path).unwrap(), b"needle\n");
	}

	/// Contract: an inverted empty pattern is not reading its own output.
	///
	/// GNU grep searches a file with `grep -v ''` and writes nothing: the empty
	/// pattern matches every record, so the inverted search selects none of
	/// them and the file it reads is not its own output.
	#[tokio::test(flavor = "multi_thread")]
	async fn an_inverted_empty_pattern_is_not_refused_as_the_output_file() {
		let tree = tempfile::tempdir().unwrap();
		let path = tree.path().join("out.txt");
		std::fs::write(&path, "needle\nother\n").unwrap();
		let (code, err) =
			run_with_stdout_file(&["-v", "-e", "", "out.txt"], tree.path(), &path).await;
		assert_eq!(code, 1, "{err}");
		assert!(!err.contains("input file is also the output"), "{err}");
		assert_eq!(std::fs::read(&path).unwrap(), b"needle\nother\n");
	}

	/// Contract: an empty pattern constrained by `-x` or `-w` is still refused.
	///
	/// The boundary of the exemption above: `-x` limits the empty pattern to
	/// empty lines and `-w` leaves it matching nothing, so an inverted search
	/// of either still selects records and can write into the file it reads.
	/// GNU grep rejects that file.
	#[tokio::test(flavor = "multi_thread")]
	async fn a_constrained_inverted_empty_pattern_is_still_refused() {
		for args in [
			&["-v", "-x", "-e", "", "out.txt"][..],
			&["-v", "-w", "-e", "", "out.txt"][..],
		] {
			let tree = tempfile::tempdir().unwrap();
			let path = tree.path().join("out.txt");
			std::fs::write(&path, "needle\nother\n").unwrap();
			let (code, err) = run_with_stdout_file(args, tree.path(), &path).await;
			assert_eq!(code, 2, "{args:?}: {err}");
			assert!(err.contains("input file is also the output"), "{args:?}: {err}");
			assert_eq!(
				std::fs::read(&path).unwrap(),
				b"needle\nother\n",
				"{args:?}: {err}"
			);
		}
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

	/// GNU grep 3.11 reads the letter classes as glibc defines them in a
	/// UTF-8 locale: `[[:alpha:]]` holds `ß`, the numeral `Ⅻ` and a digit that
	/// is not ASCII (`٣`), `[[:lower:]]` the ordinal `ª`, both cases the
	/// title-case `ǅ`, and with case ignored `[[:lower:]]` is `[[:alpha:]]`,
	/// which holds `中`, also beside a pattern the engine cannot run and on a
	/// line that is not UTF-8. Regressed: the classes held ASCII letters
	/// alone.
	#[tokio::test(flavor = "multi_thread")]
	async fn utf8_letter_classes_answer_as_gnu() {
		for (args, stdin, expected) in [
			(&["-w", "[[:alpha:]]"][..], "ÀB\nß\n".as_bytes(), "ß\n"),
			(&["-x", "[[:alpha:]]"], "٣\n3\n".as_bytes(), "٣\n"),
			(&["-x", "[[:alnum:]]"], "٣\n3\n".as_bytes(), "٣\n3\n"),
			(&["-x", "[[:lower:]]"], "ª\nǅ\nA\n".as_bytes(), "ª\nǅ\n"),
			(&["-x", "[[:upper:]]"], "ǅ\nÀ\na\n".as_bytes(), "ǅ\nÀ\n"),
			(&["-ix", "[[:lower:]]"], "中\n3\nx\n".as_bytes(), "中\nx\n"),
			(&["-x", "-e", "[[:alpha:]]", "-e", r"\(y\)\1"], "Ⅻ\n".as_bytes(), "Ⅻ\n"),
			(&["-c", "-e", "^[[:alpha:]]", "-e", r"\(x\)\1"], &b"\xc3\xa9\xff\n"[..], "1\n"),
			// The shell hands grep the byte `\351` of `$'\351x'` as U+FFFD.
			(&["-c", "-e", "^[[:alpha:]]", "-e", "\u{fffd}x"], &b"\xc3\xa9\xff\n"[..], "1\n"),
		] {
			let (mut host, capture) = Host::for_test_async("grep", stdin, "/");
			host.set_test_var("LC_ALL", "C.UTF-8");
			if !crate::locale::ctype_is_utf8(&host) {
				eprintln!("skipping: the C.UTF-8 locale is not installed");
				return;
			}
			let code = run_parsed(args, &mut host).await;
			assert_eq!((code, capture.out().as_str()), (0, expected), "grep {args:?}: {}", capture.err());
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn basic_mode_is_posix_bre_and_extended_mode_is_strict() {
		let (code, out, err) = run(&["-A", "1", "fail)"], "ok\n(1 fail)\nnext\n").await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "(1 fail)\nnext\n");
		// GNU grep 3.11 reads an ERE `)` that closes no group as a literal;
		// this was a parse error.
		let (code, out, err) = run(&["-E", "fail)"], "fail)\n").await;
		assert_eq!((code, out.as_str(), err.as_str()), (0, "fail)\n", ""));
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
		let input = "\"tools.commands\": {}\n\"tools.toolbox\": {}\n\"tools.other\": {}\n";
		let (code, out, err) = run(&["-c", r"tools.commands\|tools.toolbox"], input).await;
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
			assert_eq!(err, "grep: Invalid preceding regular expression\n", "{pattern}");
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
	async fn posix_brackets_match_literal_square_brackets() {
		for (mode, pattern, stdin, expected) in [
			("-oE", r"[][\.^$*+?(){}|\\]", "a.b[c]\n", ".\n[\n]\n"),
			("-o", "[.[]", "a[b\n", "[\n"),
		] {
			let (code, out, err) = run(&[mode, pattern], stdin).await;
			assert_eq!((code, out.as_str(), err.as_str()), (0, expected, ""), "{mode} {pattern}");
		}
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

		// An unterminated bracket expression is an error, as in GNU grep, not
		// a literal match of the typed text.
		let (code, out, err) = run(&["-c", "a[d"], "a[d\nplain\n").await;
		assert_eq!((code, out.as_str(), err.as_str()), (2, "", "grep: Unmatched [, [^, [:, [., or [=\n"));
	}

	/// Failure: malformed BREs such as `\(` or `[` exited 1 silently, so a
	/// `grep -q` caller read the error as "no match". Messages are GNU 3.11's.
	#[tokio::test(flavor = "multi_thread")]
	async fn malformed_bre_is_a_gnu_error() {
		for (pattern, want) in [
			(r"\(", r"Unmatched ( or \("),
			(r"a\)", r"Unmatched ) or \)"),
			("[", "Invalid regular expression"),
			("[^", "Invalid regular expression"),
			("[a", "Unmatched [, [^, [:, [., or [="),
			(r"a\{1", r"Unmatched \{"),
			(r"a\{1,x\}", r"Invalid content of \{\}"),
			(r"a\{2,1\}", r"Invalid content of \{\}"),
			(r"a\", "Trailing backslash"),
			(r"\(a\)\2", "Invalid back reference"),
			(r"\(a\1\)", "Invalid back reference"),
			("[z-a]", "Invalid range end"),
		] {
			let (code, out, err) = run(&["-q", pattern], "aa(a)\n").await;
			assert_eq!((code, out.as_str()), (2, ""), "{pattern}");
			assert_eq!(err, format!("grep: {want}\n"), "{pattern}");
		}
		// Valid intervals still match.
		let (code, out, err) = run(&["-c", r"a\{,2\}"], "aa(a)\n").await;
		assert_eq!((code, out.as_str(), err.as_str()), (0, "1\n", ""));
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

		// A real interval with no operand stays refused rather than repeating
		// the empty string at every position.
		let (code, out, _) = run(&["-Ec", "{1}"], input).await;
		assert_eq!(code, 2, "-E {{1}} must stay an error, got {out:?}");
	}

	/// Failure: `grep -E 'a{1'` exited 2 where GNU grep 3.11 reads a `{` whose
	/// interval never closes as a literal, so the search found nothing.
	#[tokio::test(flavor = "multi_thread")]
	async fn an_unterminated_ere_interval_is_literal() {
		let input = "a{1\na{1,\na{,2\na{1,2\nab\naa\n";
		for (pattern, want) in [
			("a{1", "a{1\na{1,\na{1,2\n"),
			("a{1,", "a{1,\na{1,2\n"),
			("a{,2", "a{,2\n"),
			("a{1,2", "a{1,2\n"),
			// `{,m}` is a real interval: zero to m.
			("a{,2}", input),
		] {
			let (code, out, err) = run(&["-E", pattern], input).await;
			assert_eq!((code, out.as_str(), err.as_str()), (0, want, ""), "-E {pattern}");
		}
	}

	/// Failure: an invalid ERE printed ripgrep's multi-line parse report,
	/// quoting the internal `(?:…)` wrapper, instead of GNU grep 3.11's line.
	#[tokio::test(flavor = "multi_thread")]
	async fn invalid_regex_is_one_gnu_diagnostic_line() {
		for (args, want) in [
			(&["-E", "a("][..], r"Unmatched ( or \("),
			(&["-E", "a["], "Invalid regular expression"),
			(&["-E", "[a"], "Unmatched [, [^, [:, [., or [="),
			(&["[[:alpha:"], "Unmatched [, [^, [:, [., or [="),
			(&["-E", "[[:foo:]]"], "Invalid character class name"),
			(&["-E", "[[.ab.]]"], "Invalid collation character"),
			(&["-E", "[z-a]"], "Invalid range end"),
			(&["[a-[:alpha:]]"], "Invalid range end"),
			(&["-E", "a{}"], r"Invalid content of \{\}"),
			(&["-E", "a{2,1}"], r"Invalid content of \{\}"),
			(&["-E", "a{99999}"], "Regular expression too big"),
			(&["-E", r"a\"], "Trailing backslash"),
			(&["-E", r"(a\1)"], "Invalid back reference"),
		] {
			let (code, out, err) = run(args, "a\n").await;
			assert_eq!((code, out.as_str(), err), (2, "", format!("grep: {want}\n")), "{args:?}");
		}

		// A valid back-reference has no glibc error; the engine's refusal
		// still comes out as one line without the wrapper.
		let (code, _, err) = run(&["-E", r"(a)\1"], "a\n").await;
		assert_eq!(code, 2);
		assert!(err.starts_with("grep: ") && err.lines().count() == 1 && !err.contains("(?:"), "{err}");
	}

	/// Failure: `seq 20 | grep -A0 -e 5 -e 15` printed no `--` between the two
	/// groups, which GNU grep prints for an explicit zero context.
	#[tokio::test(flavor = "multi_thread")]
	async fn explicit_zero_context_separates_non_adjacent_matches() {
		let input: String = (1..=20).map(|n| format!("{n}\n")).collect();
		for (args, want) in [
			(&["-A0", "-e", "5", "-e", "15"][..], "5\n--\n15\n"),
			(&["-A0", "-e", "5", "-e", "6", "-e", "15"], "5\n6\n--\n15\n16\n"),
			(&["-C0", "--group-separator=XX", "-e", "5", "-e", "15"], "5\nXX\n15\n"),
			(&["-B0", "--no-group-separator", "-e", "5", "-e", "15"], "5\n15\n"),
			(&["-e", "5", "-e", "15"], "5\n15\n"),
			(&["-o", "-A0", "-e", "5", "-e", "15"], "5\n--\n15\n"),
		] {
			let (code, out, err) = run(args, &input).await;
			assert_eq!((code, out.as_str(), err.as_str()), (0, want, ""), "{args:?}");
		}
	}

	/// Failure: a missing operand or `-f` file printed Rust's ` (os error 2)`
	/// after GNU's `strerror` text.
	#[tokio::test(flavor = "multi_thread")]
	async fn missing_files_report_plain_strerror() {
		let tree = tempfile::tempdir().unwrap();
		for args in [&["x", "missing"][..], &["-f", "missing", "x"]] {
			let (code, capture) = run_async_util::<Grep>(args, "", tree.path()).await;
			assert_eq!(
				(code, capture.err().as_str()),
				(2, "grep: missing: No such file or directory\n"),
				"{args:?}"
			);
		}
	}
}

