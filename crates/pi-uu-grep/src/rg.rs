//! `rg` implemented as an in-process shell builtin on top of the ripgrep
//! libraries, with ripgrep defaults: recursive directory search, ignore/hidden
//! filtering, and binary-file suppression.

use std::{
	ffi::{OsStr, OsString},
	fs::File,
	io::{self, BufWriter, Read, Write},
	path::{Path, PathBuf},
};

use clap::{ArgAction, Parser};
use grep_matcher::{LineTerminator, Matcher};
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{
	BinaryDetection, Searcher, SearcherBuilder, Sink, SinkContext, SinkFinish, SinkMatch,
};
use ignore::{WalkBuilder, overrides::OverrideBuilder, types::TypesBuilder};

#[derive(Parser, Debug)]
#[command(
	name = "rg",
	version = "15.1.0",
	author = "Andrew Gallant <jamslam@gmail.com>",
	about = "ripgrep recursively searches the current directory for lines matching a regex pattern."
)]
struct RgCli {
	/// A pattern to search for. May be repeated.
	#[arg(short = 'e', long = "regexp", value_name = "PATTERN")]
	patterns: Vec<String>,

	/// Read patterns from a file, one pattern per line.
	#[arg(short = 'f', long = "file", value_name = "PATTERNFILE")]
	pattern_files: Vec<OsString>,

	/// Treat patterns as literals instead of regular expressions.
	#[arg(short = 'F', long = "fixed-strings")]
	fixed_strings: bool,

	/// Re-enable regex parsing after --fixed-strings.
	#[arg(long = "no-fixed-strings")]
	no_fixed_strings: bool,

	/// Search case-insensitively.
	#[arg(short = 'i', long = "ignore-case")]
	ignore_case: bool,

	/// Search case-sensitively.
	#[arg(short = 's', long = "case-sensitive")]
	case_sensitive: bool,

	/// Search case-insensitively when the pattern is all lowercase.
	#[arg(short = 'S', long = "smart-case")]
	smart_case: bool,

	/// Invert matching.
	#[arg(short = 'v', long = "invert-match")]
	invert_match: bool,

	/// Match only whole words.
	#[arg(short = 'w', long = "word-regexp")]
	word_regexp: bool,

	/// Match only whole lines.
	#[arg(short = 'x', long = "line-regexp")]
	line_regexp: bool,

	/// Limit matching lines per searched file.
	#[arg(short = 'm', long = "max-count", value_name = "NUM")]
	max_count: Option<u64>,

	/// Enable multiline search.
	#[arg(short = 'U', long = "multiline")]
	multiline: bool,

	/// Make . match line terminators in multiline mode.
	#[arg(long = "multiline-dotall")]
	multiline_dotall: bool,

	/// Search binary files as text.
	#[arg(short = 'a', long = "text")]
	text: bool,

	/// Search binary files.
	#[arg(long = "binary")]
	binary: bool,

	/// Reduce smart filtering. Repeating includes hidden and binary files.
	#[arg(short = 'u', long = "unrestricted", action = ArgAction::Count)]
	unrestricted: u8,

	/// Follow symbolic links.
	#[arg(short = 'L', long = "follow")]
	follow: bool,

	/// Include or exclude paths with a gitignore-style glob.
	#[arg(short = 'g', long = "glob", value_name = "GLOB")]
	globs: Vec<String>,

	/// Case-insensitive include/exclude glob.
	#[arg(long = "iglob", value_name = "GLOB")]
	iglobs: Vec<String>,

	/// Search hidden files and directories.
	#[arg(short = '.', long = "hidden")]
	hidden: bool,

	/// Do not search hidden files and directories.
	#[arg(long = "no-hidden")]
	no_hidden: bool,

	/// Ignore .gitignore, .ignore and .rgignore files.
	#[arg(long = "no-ignore")]
	no_ignore: bool,

	/// Respect ignore files.
	#[arg(long = "ignore")]
	ignore: bool,

	/// Ignore .ignore and .rgignore files.
	#[arg(long = "no-ignore-dot")]
	no_ignore_dot: bool,

	/// Respect .ignore and .rgignore files.
	#[arg(long = "ignore-dot")]
	ignore_dot: bool,

	/// Ignore repository exclude files.
	#[arg(long = "no-ignore-exclude")]
	no_ignore_exclude: bool,

	/// Respect repository exclude files.
	#[arg(long = "ignore-exclude")]
	ignore_exclude: bool,

	/// Ignore global gitignore files.
	#[arg(long = "no-ignore-global")]
	no_ignore_global: bool,

	/// Respect global gitignore files.
	#[arg(long = "ignore-global")]
	ignore_global: bool,

	/// Ignore parent ignore files.
	#[arg(long = "no-ignore-parent")]
	no_ignore_parent: bool,

	/// Respect parent ignore files.
	#[arg(long = "ignore-parent")]
	ignore_parent: bool,

	/// Ignore VCS ignore files.
	#[arg(long = "no-ignore-vcs")]
	no_ignore_vcs: bool,

	/// Respect VCS ignore files.
	#[arg(long = "ignore-vcs")]
	ignore_vcs: bool,

	/// Respect VCS ignores even outside a repository.
	#[arg(long = "no-require-git")]
	no_require_git: bool,

	/// Require a repository for VCS ignore files.
	#[arg(long = "require-git")]
	require_git: bool,

	/// Limit directory traversal depth.
	#[arg(short = 'd', long = "max-depth", alias = "maxdepth", value_name = "NUM")]
	max_depth: Option<usize>,

	/// Ignore files larger than this size.
	#[arg(long = "max-filesize", value_name = "NUM")]
	max_filesize: Option<String>,

	/// Search only files matching a type.
	#[arg(short = 't', long = "type", value_name = "TYPE")]
	types: Vec<String>,

	/// Do not search files matching a type.
	#[arg(short = 'T', long = "type-not", value_name = "TYPE")]
	type_nots: Vec<String>,

	/// Add a file type glob.
	#[arg(long = "type-add", value_name = "TYPESPEC")]
	type_adds: Vec<String>,

	/// Clear a file type definition.
	#[arg(long = "type-clear", value_name = "TYPE")]
	type_clears: Vec<String>,

	/// Show NUM lines after each match.
	#[arg(short = 'A', long = "after-context", value_name = "NUM")]
	after_context: Option<usize>,

	/// Show NUM lines before each match.
	#[arg(short = 'B', long = "before-context", value_name = "NUM")]
	before_context: Option<usize>,

	/// Show NUM lines before and after each match.
	#[arg(short = 'C', long = "context", value_name = "NUM")]
	context: Option<usize>,

	/// Show line numbers.
	#[arg(short = 'n', long = "line-number")]
	line_number: bool,

	/// Suppress line numbers.
	#[arg(short = 'N', long = "no-line-number")]
	no_line_number: bool,

	/// Show column numbers.
	#[arg(long = "column")]
	column: bool,

	/// Print file paths with matches.
	#[arg(short = 'H', long = "with-filename")]
	with_filename: bool,

	/// Suppress file paths with matches.
	#[arg(short = 'I', long = "no-filename")]
	no_filename: bool,

	/// Print only files containing matches.
	#[arg(short = 'l', long = "files-with-matches")]
	files_with_matches: bool,

	/// Print only files containing no matches.
	#[arg(long = "files-without-match")]
	files_without_match: bool,

	/// Print matching-line counts per file.
	#[arg(short = 'c', long = "count")]
	count: bool,

	/// Print individual match counts per file.
	#[arg(long = "count-matches")]
	count_matches: bool,

	/// Print only matching spans.
	#[arg(short = 'o', long = "only-matching")]
	only_matching: bool,

	/// Suppress normal output and exit on the first match.
	#[arg(short = 'q', long = "quiet")]
	quiet: bool,

	/// Print every match in vimgrep format.
	#[arg(long = "vimgrep")]
	vimgrep: bool,

	/// Print path names followed by NUL.
	#[arg(short = '0', long = "null")]
	null: bool,

	/// Use NUL as a line terminator.
	#[arg(long = "null-data")]
	null_data: bool,

	/// Print files that would be searched.
	#[arg(long = "files")]
	files: bool,

	/// Print all supported file types.
	#[arg(long = "type-list")]
	type_list: bool,

	/// Suppress file-open/read diagnostics.
	#[arg(long = "no-messages")]
	no_messages: bool,

	/// Re-enable diagnostics.
	#[arg(long = "messages")]
	messages: bool,

	/// Sort paths before searching.
	#[arg(long = "sort", value_name = "SORTBY")]
	sort: Option<String>,

	/// Sort paths descending before searching.
	#[arg(long = "sortr", value_name = "SORTBY")]
	sortr: Option<String>,

	/// Deprecated alias for --sort=path.
	#[arg(long = "sort-files")]
	sort_files: bool,

	/// Disable --sort-files.
	#[arg(long = "no-sort-files")]
	no_sort_files: bool,

	/// Print both matching and non-matching lines.
	#[arg(long = "passthru", alias = "passthrough")]
	passthru: bool,

	/// Trim leading ASCII whitespace from printed lines.
	#[arg(long = "trim")]
	trim: bool,

	/// Disable --trim.
	#[arg(long = "no-trim")]
	no_trim: bool,

	/// Omit matching lines longer than this many bytes.
	#[arg(short = 'M', long = "max-columns", value_name = "NUM")]
	max_columns: Option<usize>,

	/// Preview lines omitted by --max-columns.
	#[arg(long = "max-columns-preview")]
	max_columns_preview: bool,

	/// Disable --max-columns-preview.
	#[arg(long = "no-max-columns-preview")]
	no_max_columns_preview: bool,

	/// Disable colors (accepted for CLI compatibility; output is plain text).
	#[arg(long = "color", value_name = "WHEN")]
	_color: Option<String>,

	/// Color style (accepted for CLI compatibility; output is plain text).
	#[arg(long = "colors", value_name = "COLOR_SPEC")]
	_colors: Vec<String>,

	/// Heading mode (accepted; non-TTY builtin output remains grep-like).
	#[arg(long = "heading")]
	_heading: bool,

	/// Disable heading mode.
	#[arg(long = "no-heading")]
	_no_heading: bool,

	/// Pretty output alias (accepted; colors/headings are not emitted).
	#[arg(short = 'p', long = "pretty")]
	_pretty: bool,

	/// Output aggregate stats (accepted; not emitted by this builtin).
	#[arg(long = "stats")]
	_stats: bool,

	/// Disable aggregate stats.
	#[arg(long = "no-stats")]
	_no_stats: bool,

	/// Arguments: PATTERN followed by PATHs unless -e/-f/--files is used.
	#[arg(value_name = "ARGS")]
	args: Vec<OsString>,
}

struct SearchOptions {
	line_number:         bool,
	column:              bool,
	count:               bool,
	count_matches:       bool,
	files_with_matches:  bool,
	files_without_match: bool,
	only_matching:       bool,
	quiet:               bool,
	vimgrep:             bool,
	before:              usize,
	after:               usize,
	passthru:            bool,
	trim:                bool,
	max_columns:         Option<usize>,
	max_columns_preview: bool,
	null_paths:          bool,
	no_messages:         bool,
}

struct SearchOutcome {
	any_match: bool,
	had_error: bool,
}

struct RgSink<'a, W: Write> {
	out:         &'a mut W,
	matcher:     &'a RegexMatcher,
	display:     Option<&'a [u8]>,
	opts:        &'a SearchOptions,
	line_count:  u64,
	match_count: u64,
	any_match:   bool,
}

impl<W: Write> RgSink<'_, W> {
	fn write_path(&mut self) -> io::Result<()> {
		if let Some(name) = self.display {
			self.out.write_all(name)?;
			if self.opts.null_paths {
				self.out.write_all(b"\0")?;
			}
		}
		Ok(())
	}

	fn write_prefix(
		&mut self,
		line_number: Option<u64>,
		column: Option<usize>,
		sep: u8,
	) -> io::Result<()> {
		if self.display.is_some() {
			self.write_path()?;
			self.out.write_all(&[sep])?;
		}
		if self.opts.line_number
			&& let Some(n) = line_number
		{
			write!(self.out, "{n}")?;
			self.out.write_all(&[sep])?;
		}
		if self.opts.column {
			let col = column.unwrap_or(1);
			write!(self.out, "{col}")?;
			self.out.write_all(&[sep])?;
		}
		Ok(())
	}

	fn write_line(&mut self, line: &[u8]) -> io::Result<()> {
		let mut bytes = line;
		if self.opts.trim {
			bytes = trim_ascii_start(bytes);
		}
		if let Some(limit) = self.opts.max_columns
			&& limit > 0
			&& bytes.len() > limit
		{
			if self.opts.max_columns_preview {
				let end = limit.min(bytes.len());
				self.out.write_all(&bytes[..end])?;
				self.out.write_all(b"\n")?;
			} else {
				writeln!(self.out, "[Omitted long matching line]")?;
			}
			return Ok(());
		}
		self.out.write_all(bytes)?;
		if !bytes.ends_with(b"\n") {
			self.out.write_all(b"\n")?;
		}
		Ok(())
	}

	fn print_only_matching(&mut self, line: &[u8], line_number: Option<u64>) -> io::Result<()> {
		let mut at = 0usize;
		while at <= line.len() {
			let Some(m) = self.matcher.find_at(line, at).map_err(io::Error::other)? else {
				break;
			};
			if m.is_empty() {
				at += 1;
				continue;
			}
			self.write_prefix(line_number, Some(m.start() + 1), b':')?;
			self.out.write_all(&line[m.start()..m.end()])?;
			self.out.write_all(b"\n")?;
			at = m.end();
		}
		Ok(())
	}

	fn print_vimgrep(&mut self, line: &[u8], line_number: Option<u64>) -> io::Result<()> {
		let mut at = 0usize;
		let mut printed = false;
		while at <= line.len() {
			let Some(m) = self.matcher.find_at(line, at).map_err(io::Error::other)? else {
				break;
			};
			let next = if m.end() > at { m.end() } else { at + 1 };
			self.write_prefix(line_number, Some(m.start() + 1), b':')?;
			self.write_line(line)?;
			printed = true;
			at = next;
		}
		if !printed {
			self.write_prefix(line_number, Some(1), b':')?;
			self.write_line(line)?;
		}
		Ok(())
	}
}

impl<W: Write> Sink for RgSink<'_, W> {
	type Error = io::Error;

	fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, io::Error> {
		self.any_match = true;
		self.line_count += 1;
		let line = mat.bytes();
		let line_number = mat.line_number();
		let matches_on_line = count_matches(self.matcher, line)?;
		self.match_count += if self.opts.count_matches || self.opts.only_matching {
			matches_on_line.max(1)
		} else {
			1
		};

		if self.opts.quiet || self.opts.files_with_matches {
			return Ok(false);
		}
		if self.opts.files_without_match || self.opts.count || self.opts.count_matches {
			return Ok(true);
		}
		if self.opts.vimgrep {
			self.print_vimgrep(line, line_number)?;
		} else if self.opts.only_matching {
			self.print_only_matching(line, line_number)?;
		} else {
			let column = if self.opts.column {
				first_column(self.matcher, line)?
			} else {
				None
			};
			self.write_prefix(line_number, column, b':')?;
			self.write_line(line)?;
		}
		Ok(true)
	}

	fn context(&mut self, _searcher: &Searcher, ctx: &SinkContext<'_>) -> Result<bool, io::Error> {
		if self.opts.count
			|| self.opts.count_matches
			|| self.opts.files_with_matches
			|| self.opts.files_without_match
			|| self.opts.only_matching
			|| self.opts.vimgrep
		{
			return Ok(true);
		}
		self.write_prefix(ctx.line_number(), None, b'-')?;
		self.write_line(ctx.bytes())?;
		Ok(true)
	}

	fn context_break(&mut self, _searcher: &Searcher) -> Result<bool, io::Error> {
		if !(self.opts.count
			|| self.opts.count_matches
			|| self.opts.files_with_matches
			|| self.opts.files_without_match
			|| self.opts.only_matching
			|| self.opts.vimgrep
			|| self.opts.passthru)
		{
			self.out.write_all(b"--\n")?;
		}
		Ok(true)
	}

	fn finish(&mut self, _searcher: &Searcher, _: &SinkFinish) -> Result<(), io::Error> {
		if self.opts.quiet {
			return Ok(());
		}
		if self.opts.files_with_matches {
			if self.any_match {
				self.write_path()?;
				self.out.write_all(b"\n")?;
			}
		} else if self.opts.files_without_match {
			if !self.any_match {
				self.write_path()?;
				self.out.write_all(b"\n")?;
			}
		} else if self.opts.count || self.opts.count_matches {
			if self.display.is_some() {
				self.write_path()?;
				self.out.write_all(b":")?;
			}
			let count = if self.opts.count_matches {
				self.match_count
			} else {
				self.line_count
			};
			writeln!(self.out, "{count}")?;
		}
		Ok(())
	}
}

fn trim_ascii_start(bytes: &[u8]) -> &[u8] {
	let start = bytes
		.iter()
		.position(|b| !b.is_ascii_whitespace() || *b == b'\n' || *b == b'\r')
		.unwrap_or(bytes.len());
	&bytes[start..]
}

fn first_column(matcher: &RegexMatcher, line: &[u8]) -> io::Result<Option<usize>> {
	Ok(matcher
		.find(line)
		.map_err(io::Error::other)?
		.filter(|m| !m.is_empty())
		.map(|m| m.start() + 1))
}

fn count_matches(matcher: &RegexMatcher, line: &[u8]) -> io::Result<u64> {
	let mut at = 0usize;
	let mut count = 0u64;
	while at <= line.len() {
		let Some(m) = matcher.find_at(line, at).map_err(io::Error::other)? else {
			break;
		};
		if m.is_empty() {
			at += 1;
			continue;
		}
		count += 1;
		at = m.end();
	}
	Ok(count)
}

fn build_matcher(patterns: &[String], cli: &RgCli) -> Result<RegexMatcher, grep_regex::Error> {
	let mut builder = RegexMatcherBuilder::new();
	builder
		.case_insensitive(cli.ignore_case && !cli.case_sensitive)
		.case_smart(cli.smart_case && !cli.ignore_case && !cli.case_sensitive)
		.word(cli.word_regexp && !cli.line_regexp)
		.whole_line(cli.line_regexp)
		.fixed_strings(cli.fixed_strings && !cli.no_fixed_strings)
		.multi_line(true)
		.dot_matches_new_line(cli.multiline && cli.multiline_dotall);
	if cli.null_data {
		builder.line_terminator(Some(b'\0'));
	} else if !cli.multiline {
		builder.line_terminator(Some(b'\n'));
	}
	builder.build_many(patterns)
}

#[derive(Clone, Copy)]
enum BinaryMode {
	Automatic,
	Explicit,
}

fn binary_detection(cli: &RgCli, mode: BinaryMode) -> BinaryDetection {
	if cli.text || cli.null_data {
		return BinaryDetection::none();
	}
	if cli.binary || cli.unrestricted >= 3 || matches!(mode, BinaryMode::Explicit) {
		BinaryDetection::convert(b'\0')
	} else {
		BinaryDetection::quit(b'\0')
	}
}

fn build_searcher(cli: &RgCli, opts: &SearchOptions, mode: BinaryMode) -> Searcher {
	let binary_detection = binary_detection(cli, mode);
	let mut builder = SearcherBuilder::new();
	builder
		.line_number(opts.line_number || opts.column || opts.vimgrep)
		.before_context(opts.before)
		.after_context(opts.after)
		.passthru(opts.passthru)
		.invert_match(cli.invert_match)
		.multi_line(cli.multiline)
		.binary_detection(binary_detection)
		.max_matches(cli.max_count);
	if cli.null_data {
		builder.line_terminator(LineTerminator::byte(b'\0'));
	}
	builder.build()
}

fn read_pattern_file(path: &OsStr) -> Result<Vec<String>, String> {
	let mut text = String::new();
	if path == OsStr::new("-") {
		pi_uutils_ctx::stdin()
			.read_to_string(&mut text)
			.map_err(|err| format!("rg: -: {err}"))?;
	} else {
		let resolved = pi_uutils_ctx::resolve(path);
		File::open(&resolved)
			.and_then(|mut file| file.read_to_string(&mut text))
			.map_err(|err| format!("rg: {}: {err}", path.to_string_lossy()))?;
	}
	Ok(text
		.lines()
		.map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
		.collect())
}

fn resolve_patterns(cli: &RgCli) -> Result<(Vec<String>, Vec<OsString>), String> {
	let mut patterns = cli.patterns.clone();
	for pattern_file in &cli.pattern_files {
		patterns.extend(read_pattern_file(pattern_file.as_os_str())?);
	}
	let mut paths = Vec::new();
	if cli.files || cli.type_list || !cli.patterns.is_empty() || !cli.pattern_files.is_empty() {
		paths = cli.args.clone();
	} else {
		let mut rest = cli.args.iter();
		let Some(pattern) = rest.next() else {
			return Err("rg: required pattern missing".to_string());
		};
		patterns.push(pattern.to_string_lossy().into_owned());
		paths.extend(rest.cloned());
	}
	Ok((patterns, paths))
}

fn search_options(cli: &RgCli) -> SearchOptions {
	let c = cli.context.unwrap_or(0);
	let count_matches = cli.count_matches || (cli.count && cli.only_matching);
	let line_number = (cli.line_number || cli.column || cli.vimgrep) && !cli.no_line_number;
	SearchOptions {
		line_number,
		column: cli.column || cli.vimgrep,
		count: cli.count && !count_matches,
		count_matches,
		files_with_matches: cli.files_with_matches && !cli.files_without_match,
		files_without_match: cli.files_without_match,
		only_matching: cli.only_matching,
		quiet: cli.quiet,
		vimgrep: cli.vimgrep,
		before: cli.before_context.unwrap_or(c),
		after: cli.after_context.unwrap_or(c),
		passthru: cli.passthru,
		trim: cli.trim && !cli.no_trim,
		max_columns: cli.max_columns,
		max_columns_preview: cli.max_columns_preview && !cli.no_max_columns_preview,
		null_paths: cli.null,
		no_messages: cli.no_messages && !cli.messages,
	}
}

fn parse_size(input: &str) -> Result<u64, String> {
	let trimmed = input.trim();
	let Some(last) = trimmed.chars().last() else {
		return Err("empty size".to_string());
	};
	let (digits, multiplier) = match last {
		'K' | 'k' => (&trimmed[..trimmed.len() - 1], 1024),
		'M' | 'm' => (&trimmed[..trimmed.len() - 1], 1024 * 1024),
		'G' | 'g' => (&trimmed[..trimmed.len() - 1], 1024 * 1024 * 1024),
		_ => (trimmed, 1),
	};
	let value = digits
		.parse::<u64>()
		.map_err(|err| format!("invalid size {input:?}: {err}"))?;
	Ok(value.saturating_mul(multiplier))
}

fn type_builder(cli: &RgCli) -> Result<TypesBuilder, String> {
	let mut builder = TypesBuilder::new();
	builder.add_defaults();
	for name in &cli.type_clears {
		builder.clear(name);
	}
	for def in &cli.type_adds {
		builder
			.add_def(def)
			.map_err(|err| format!("rg: --type-add {def:?}: {err}"))?;
	}
	for name in &cli.types {
		builder.select(name);
	}
	for name in &cli.type_nots {
		builder.negate(name);
	}
	Ok(builder)
}

fn print_type_list<W: Write>(cli: &RgCli, out: &mut W) -> Result<(), String> {
	let builder = type_builder(cli)?;
	for def in builder.definitions() {
		write!(out, "{}: ", def.name()).map_err(|err| err.to_string())?;
		for (idx, glob) in def.globs().iter().enumerate() {
			if idx > 0 {
				out.write_all(b", ").map_err(|err| err.to_string())?;
			}
			out.write_all(glob.as_bytes())
				.map_err(|err| err.to_string())?;
		}
		out.write_all(b"\n").map_err(|err| err.to_string())?;
	}
	Ok(())
}

fn configure_walk(cli: &RgCli, root: &Path) -> Result<WalkBuilder, String> {
	let cwd = pi_uutils_ctx::cwd();
	let mut builder = WalkBuilder::new(root);
	builder.current_dir(cwd.clone());
	builder.follow_links(cli.follow);
	builder.max_depth(cli.max_depth);
	if let Some(size) = &cli.max_filesize {
		builder.max_filesize(Some(parse_size(size).map_err(|err| format!("rg: {err}"))?));
	}

	let unrestricted_no_ignore = cli.unrestricted >= 1;
	let include_hidden = (cli.hidden || cli.unrestricted >= 2) && !cli.no_hidden;
	let no_ignore = (cli.no_ignore || unrestricted_no_ignore) && !cli.ignore;
	builder.hidden(!include_hidden);
	builder.parents(!(no_ignore || (cli.no_ignore_parent && !cli.ignore_parent)));
	builder.ignore(!(no_ignore || (cli.no_ignore_dot && !cli.ignore_dot)));
	builder.git_ignore(!(no_ignore || (cli.no_ignore_vcs && !cli.ignore_vcs)));
	builder.git_global(!(no_ignore || (cli.no_ignore_global && !cli.ignore_global)));
	builder.git_exclude(!(no_ignore || (cli.no_ignore_exclude && !cli.ignore_exclude)));
	builder.require_git(!cli.no_require_git || cli.require_git);
	if !(no_ignore || (cli.no_ignore_dot && !cli.ignore_dot)) {
		builder.add_custom_ignore_filename(".rgignore");
	}

	if !cli.globs.is_empty() || !cli.iglobs.is_empty() {
		let mut overrides = OverrideBuilder::new(&cwd);
		for glob in &cli.globs {
			overrides
				.add(glob)
				.map_err(|err| format!("rg: --glob {glob:?}: {err}"))?;
		}
		if !cli.iglobs.is_empty() {
			overrides
				.case_insensitive(true)
				.map_err(|err| format!("rg: --iglob: {err}"))?;
			for glob in &cli.iglobs {
				overrides
					.add(glob)
					.map_err(|err| format!("rg: --iglob {glob:?}: {err}"))?;
			}
		}
		builder.overrides(overrides.build().map_err(|err| format!("rg: {err}"))?);
	}

	if !cli.types.is_empty() || !cli.type_nots.is_empty() {
		builder.types(
			type_builder(cli)?
				.build()
				.map_err(|err| format!("rg: {err}"))?,
		);
	}

	if cli.sort_files || cli.sort.as_deref() == Some("path") {
		builder.sort_by_file_path(|a, b| a.cmp(b));
	} else if cli.sortr.as_deref() == Some("path") {
		builder.sort_by_file_path(|a, b| b.cmp(a));
	}
	Ok(builder)
}

fn display_path(operand: &OsStr, root: &Path, path: &Path) -> PathBuf {
	let rel = path.strip_prefix(root).unwrap_or(path);
	if rel.as_os_str().is_empty() {
		return PathBuf::from(operand);
	}
	if operand == OsStr::new(".") {
		rel.to_path_buf()
	} else {
		Path::new(operand).join(rel)
	}
}

fn process_reader<R: Read, W: Write>(
	matcher: &RegexMatcher,
	searcher: &mut Searcher,
	reader: R,
	display: Option<&[u8]>,
	opts: &SearchOptions,
	out: &mut W,
) -> io::Result<bool> {
	let mut sink =
		RgSink { out, matcher, display, opts, line_count: 0, match_count: 0, any_match: false };
	searcher.search_reader(matcher, reader, &mut sink)?;
	Ok(sink.any_match)
}

fn process_file<W: Write>(
	matcher: &RegexMatcher,
	searcher: &mut Searcher,
	path: &Path,
	display: Option<&[u8]>,
	opts: &SearchOptions,
	out: &mut W,
) -> SearchOutcome {
	match File::open(path) {
		Ok(file) => match process_reader(matcher, searcher, file, display, opts, out) {
			Ok(any_match) => SearchOutcome { any_match, had_error: false },
			Err(err) => SearchOutcome {
				any_match: false,
				had_error: report_path_error(display, path, err, opts),
			},
		},
		Err(err) => {
			SearchOutcome { any_match: false, had_error: report_path_error(display, path, err, opts) }
		},
	}
}

fn report_path_error(
	display: Option<&[u8]>,
	fallback: &Path,
	err: io::Error,
	opts: &SearchOptions,
) -> bool {
	if !opts.no_messages {
		let name = display
			.map(|bytes| String::from_utf8_lossy(bytes).into_owned())
			.unwrap_or_else(|| fallback.display().to_string());
		let _ = writeln!(pi_uutils_ctx::stderr(), "rg: {name}: {err}");
	}
	true
}

#[allow(
	clippy::too_many_arguments,
	reason = "required by standard walk/configure interfaces and search parameters"
)]
fn search_dir<W: Write>(
	cli: &RgCli,
	matcher: &RegexMatcher,
	searcher: &mut Searcher,
	operand: &OsStr,
	root: &Path,
	show_names: bool,
	opts: &SearchOptions,
	out: &mut W,
) -> SearchOutcome {
	let mut any_match = false;
	let mut had_error = false;
	let builder = match configure_walk(cli, root) {
		Ok(builder) => builder,
		Err(err) => {
			if !opts.no_messages {
				let _ = writeln!(pi_uutils_ctx::stderr(), "{err}");
			}
			return SearchOutcome { any_match: false, had_error: true };
		},
	};
	for result in builder.build() {
		if opts.quiet && any_match {
			break;
		}
		let entry = match result {
			Ok(entry) => entry,
			Err(err) => {
				had_error = true;
				if !opts.no_messages {
					let _ = writeln!(pi_uutils_ctx::stderr(), "rg: {err}");
				}
				continue;
			},
		};
		if entry.file_type().is_none_or(|kind| !kind.is_file()) {
			continue;
		}
		let display_path = display_path(operand, root, entry.path());
		let display_bytes = display_path.as_os_str().as_encoded_bytes().to_vec();
		let display = show_names.then_some(display_bytes.as_slice());
		let outcome = process_file(matcher, searcher, entry.path(), display, opts, out);
		any_match |= outcome.any_match;
		had_error |= outcome.had_error;
	}
	SearchOutcome { any_match, had_error }
}

fn list_files<W: Write>(cli: &RgCli, paths: &[OsString], out: &mut W) -> SearchOutcome {
	let mut any = false;
	let mut had_error = false;
	for operand in paths {
		let resolved = pi_uutils_ctx::resolve(operand);
		match std::fs::metadata(&resolved) {
			Ok(meta) if meta.is_dir() => {
				let builder = match configure_walk(cli, &resolved) {
					Ok(builder) => builder,
					Err(err) => {
						let _ = writeln!(pi_uutils_ctx::stderr(), "{err}");
						had_error = true;
						continue;
					},
				};
				for result in builder.build() {
					let entry = match result {
						Ok(entry) => entry,
						Err(err) => {
							let _ = writeln!(pi_uutils_ctx::stderr(), "rg: {err}");
							had_error = true;
							continue;
						},
					};
					if entry.file_type().is_none_or(|kind| !kind.is_file()) {
						continue;
					}
					let display = display_path(operand.as_os_str(), &resolved, entry.path());
					let _ = out.write_all(display.as_os_str().as_encoded_bytes());
					let _ = out.write_all(if cli.null { b"\0" } else { b"\n" });
					any = true;
				}
			},
			Ok(meta) if meta.is_file() => {
				let _ = out.write_all(operand.as_encoded_bytes());
				let _ = out.write_all(if cli.null { b"\0" } else { b"\n" });
				any = true;
			},
			Ok(_) => {},
			Err(err) => {
				let _ = writeln!(pi_uutils_ctx::stderr(), "rg: {}: {err}", operand.to_string_lossy());
				had_error = true;
			},
		}
	}
	SearchOutcome { any_match: any, had_error }
}

fn default_paths(paths: &mut Vec<OsString>, use_implicit_stdin: bool) {
	if !paths.is_empty() {
		return;
	}
	if use_implicit_stdin {
		paths.push(OsString::from("-"));
	} else {
		paths.push(OsString::from("."));
	}
}

fn show_names_for(paths: &[OsString], recursive: bool, cli: &RgCli, opts: &SearchOptions) -> bool {
	if cli.no_filename {
		false
	} else if cli.with_filename || opts.files_with_matches || opts.files_without_match || cli.vimgrep
	{
		true
	} else {
		recursive || paths.len() > 1
	}
}

/// Runs the ripgrep-compatible builtin and returns a process-style exit code.
pub fn run(argv: Vec<OsString>) -> i32 {
	let cli = match RgCli::try_parse_from(argv) {
		Ok(cli) => cli,
		Err(err) => {
			let rendered = err.to_string();
			if err.use_stderr() {
				let _ = write!(pi_uutils_ctx::stderr(), "{rendered}");
				return 2;
			}
			let _ = write!(pi_uutils_ctx::stdout(), "{rendered}");
			return 0;
		},
	};

	let opts = search_options(&cli);
	let mut out = BufWriter::new(pi_uutils_ctx::stdout());
	let (patterns, mut paths) = match resolve_patterns(&cli) {
		Ok(resolved) => resolved,
		Err(err) => {
			let _ = writeln!(pi_uutils_ctx::stderr(), "{err}");
			return 2;
		},
	};
	if cli.type_list {
		return match print_type_list(&cli, &mut out) {
			Ok(()) => 0,
			Err(err) => {
				let _ = writeln!(pi_uutils_ctx::stderr(), "rg: {err}");
				2
			},
		};
	}
	let pattern_stdin_consumed = cli.pattern_files.iter().any(|file| file == OsStr::new("-"));
	default_paths(
		&mut paths,
		!cli.files && !pattern_stdin_consumed && pi_uutils_ctx::stdin_is_search_input(),
	);
	if cli.files {
		let outcome = list_files(&cli, &paths, &mut out);
		let _ = out.flush();
		return if outcome.had_error {
			2
		} else if outcome.any_match {
			0
		} else {
			1
		};
	}
	if patterns.is_empty() {
		return 1;
	}
	let matcher = match build_matcher(&patterns, &cli) {
		Ok(matcher) => matcher,
		Err(err) => {
			let _ = writeln!(pi_uutils_ctx::stderr(), "rg: {err}");
			return 2;
		},
	};
	let mut auto_searcher = build_searcher(&cli, &opts, BinaryMode::Automatic);
	let mut explicit_searcher = build_searcher(&cli, &opts, BinaryMode::Explicit);
	let recursive = paths.iter().any(|path| {
		path.as_os_str() != OsStr::new("-")
			&& std::fs::metadata(pi_uutils_ctx::resolve(path)).is_ok_and(|meta| meta.is_dir())
	});
	let show_names = show_names_for(&paths, recursive, &cli, &opts);
	let mut any_match = false;
	let mut had_error = false;
	for operand in &paths {
		if opts.quiet && any_match {
			break;
		}
		if operand.as_os_str() == OsStr::new("-") {
			let display = show_names.then_some(b"<stdin>".as_slice());
			match process_reader(
				&matcher,
				&mut explicit_searcher,
				pi_uutils_ctx::stdin(),
				display,
				&opts,
				&mut out,
			) {
				Ok(matched) => any_match |= matched,
				Err(err) => {
					had_error = true;
					if !opts.no_messages {
						let _ = writeln!(pi_uutils_ctx::stderr(), "rg: <stdin>: {err}");
					}
				},
			}
			continue;
		}
		let resolved = pi_uutils_ctx::resolve(operand);
		match std::fs::metadata(&resolved) {
			Ok(meta) if meta.is_dir() => {
				let outcome = search_dir(
					&cli,
					&matcher,
					&mut auto_searcher,
					operand.as_os_str(),
					&resolved,
					show_names,
					&opts,
					&mut out,
				);
				any_match |= outcome.any_match;
				had_error |= outcome.had_error;
			},
			Ok(meta) if meta.is_file() => {
				let display = show_names.then_some(operand.as_encoded_bytes());
				let outcome =
					process_file(&matcher, &mut explicit_searcher, &resolved, display, &opts, &mut out);
				any_match |= outcome.any_match;
				had_error |= outcome.had_error;
			},
			Ok(_) => {},
			Err(err) => {
				had_error = true;
				if !opts.no_messages {
					let _ =
						writeln!(pi_uutils_ctx::stderr(), "rg: {}: {err}", operand.to_string_lossy());
				}
			},
		}
	}
	let _ = out.flush();
	if opts.quiet {
		if any_match {
			0
		} else if had_error {
			2
		} else {
			1
		}
	} else if had_error {
		2
	} else if any_match {
		0
	} else {
		1
	}
}
