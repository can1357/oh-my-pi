//! `ast-grep` / `sg` builtin: ast-grep 0.50's `run` command (structural
//! search and rewrite) as an in-process shell utility on top of the `pi_ast`
//! search engine, with ast-grep's piped (non-terminal) output: no colors and
//! no file headings unless `--heading always`.

use std::{
	collections::HashMap,
	ffi::OsString,
	fmt::Write as _,
	io::{self, Write},
	path::Path,
};

use clap::{ArgAction, Parser, ValueEnum};
use futures::StreamExt;
use pi_ast::{
	SupportLang, ops,
	search::{
		self, Candidate, Captures, Change, Discover, Error as SearchError, MatchStrictness, Mode,
		Page, Query, Rewrite, Span,
	},
};
use pi_walker::glob::Selector;
use similar::{ChangeTag, TextDiff};
use tokio_util::sync::CancellationToken;

use crate::host::{AsyncUtility, Host};

const DOC_SITE_HOST: &str = "https://ast-grep.github.io";
const PATTERN_GUIDE: &str = "/guide/pattern-syntax.html";
const TOOL_OVERVIEW: &str = "/guide/tooling-overview.html#parse-code-from-stdin";
const CLI_USAGE: &str = "/reference/cli.html";
const PLAYGROUND: &str = "/playground.html";

/// Display path of code read from stdin.
const STDIN_PATH: &str = "STDIN";

/// ast-grep subcommands the builtin does not implement.
const UNSUPPORTED_COMMANDS: &[&str] = &["scan", "test", "new", "lsp", "outline", "completions"];

/// Options of `run` that take a separate value, so their value is never read as a flag.
const VALUE_OPTIONS: &[&str] = &[
	"-p", "--pattern", "-r", "--rewrite", "-l", "--lang", "--selector", "--strictness", "--globs",
	"-j", "--threads", "-A", "--after", "-B", "--before", "-C", "--context", "--color", "--heading",
	"--no-ignore",
];

/// Unsupported ast-grep options, by the spellings that select them.
const UNSUPPORTED_OPTIONS: &[(&str, &[&str])] = &[
	("--config", &["-c", "--config"]),
	("--interactive", &["-i", "--interactive"]),
	("--kind", &["-k", "--kind"]),
	("--debug-query", &["--debug-query"]),
	("--inspect", &["--inspect"]),
];

#[derive(Parser, Debug)]
#[command(
	name = "ast-grep",
	version = "0.50.0",
	about = "Search and Rewrite code at large scale using AST pattern."
)]
pub(crate) struct AstGrep {
	/// AST pattern to match.
	#[arg(short, long, value_name = "PATTERN")]
	pattern: String,

	/// AST kind to extract sub-part of pattern to match.
	#[arg(long, value_name = "KIND")]
	selector: Option<String>,

	/// The strictness of the pattern.
	#[arg(long, value_name = "STRICTNESS")]
	strictness: Option<Strictness>,

	/// String to replace the matched AST node.
	#[arg(short, long, value_name = "FIX", required_if_eq("update_all", "true"))]
	rewrite: Option<String>,

	/// The language of the pattern.
	#[arg(short, long, value_parser = parse_lang)]
	lang: Option<SupportLang>,

	/// The paths to search.
	#[arg(default_value = ".")]
	paths: Vec<String>,

	/// Follow symbolic links.
	#[arg(long)]
	follow: bool,

	/// Do not respect hidden file system or ignore files.
	#[arg(long, action = ArgAction::Append, value_name = "FILE_TYPE")]
	no_ignore: Vec<IgnoreFile>,

	/// Enable search code from StdIn.
	#[arg(long)]
	stdin: bool,

	/// Include or exclude file paths (`!` excludes).
	#[arg(long, action = ArgAction::Append)]
	globs: Vec<String>,

	/// Set the approximate number of threads to use.
	#[arg(short = 'j', long, default_value = "0", value_name = "NUM")]
	threads: usize,

	/// Apply all rewrite without confirmation.
	#[arg(short = 'U', long)]
	update_all: bool,

	/// Only print the paths of files with at least one match.
	#[arg(long, conflicts_with_all = ["json", "update_all"])]
	files_with_matches: bool,

	/// Output matches in structured JSON.
	#[arg(
		long,
		value_name = "STYLE",
		num_args(0..=1),
		require_equals = true,
		default_missing_value = "pretty"
	)]
	json: Option<JsonStyle>,

	/// Controls output color; the builtin always prints plain text.
	#[arg(long = "color", default_value = "auto", value_name = "WHEN")]
	_color: ColorArg,

	/// Show NUM lines after each match.
	#[arg(short = 'A', long, default_value = "0", conflicts_with = "context", value_name = "NUM")]
	after: u16,

	/// Show NUM lines before each match.
	#[arg(short = 'B', long, default_value = "0", conflicts_with = "context", value_name = "NUM")]
	before: u16,

	/// Show NUM lines around each match.
	#[arg(short = 'C', long, default_value = "0", value_name = "NUM")]
	context: u16,

	/// Controls whether to print the file name as heading (`auto`: never, output is piped).
	#[arg(long, default_value = "auto", value_name = "WHEN")]
	heading: Heading,
}

/// ast-grep's `--strictness` values.
#[derive(Clone, Copy, Debug, ValueEnum)]
enum Strictness {
	Cst,
	Smart,
	Ast,
	Relaxed,
	Signature,
	Template,
}

impl From<Strictness> for MatchStrictness {
	fn from(value: Strictness) -> Self {
		match value {
			Strictness::Cst => Self::Cst,
			Strictness::Smart => Self::Smart,
			Strictness::Ast => Self::Ast,
			Strictness::Relaxed => Self::Relaxed,
			Strictness::Signature => Self::Signature,
			Strictness::Template => Self::Template,
		}
	}
}

/// ast-grep's `--no-ignore` file kinds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum IgnoreFile {
	Hidden,
	Dot,
	Exclude,
	Global,
	Parent,
	Vcs,
}

/// ast-grep's `--json` styles.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum JsonStyle {
	Pretty,
	Stream,
	Compact,
}

/// ast-grep's `--color` values; accepted and ignored.
#[derive(Clone, Copy, Debug, ValueEnum)]
enum ColorArg {
	Auto,
	Always,
	Ansi,
	Never,
}

/// ast-grep's `--heading` values.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum Heading {
	Auto,
	Always,
	Never,
}

fn parse_lang(value: &str) -> Result<SupportLang, String> {
	SupportLang::from_alias(value).ok_or_else(|| format!("{value} is not supported!"))
}

/// An ast-grep `ErrorContext` report: title, help, optional doc link, and
/// causes, printed the way ast-grep prints them to a non-terminal stderr.
struct Report<'a> {
	warning: bool,
	title:   &'a str,
	help:    &'a str,
	link:    Option<&'a str>,
	cause:   Option<String>,
}

impl Report<'_> {
	fn print(&self, host: &mut Host) {
		let (notice, sign) = if self.warning { ("Warning:", "⚠") } else { ("Error:", "✖") };
		let mut text = format!("{notice} {}\nHelp: {}\n", self.title, self.help);
		if let Some(link) = self.link {
			let _ = writeln!(text, "See also: {DOC_SITE_HOST}{link}");
		}
		if let Some(cause) = &self.cause {
			let _ = write!(text, "\n{sign} Caused by\n╰▻ {cause}\n");
		}
		let _ = writeln!(host.stderr, "{text}");
	}
}

/// `Cannot parse query as a valid pattern.` (exit status 8).
fn parse_pattern_error(host: &mut Host, cause: String) -> i32 {
	Report {
		warning: false,
		title:   "Cannot parse query as a valid pattern.",
		help:    "The pattern either fails to parse or contains error. Please refer to pattern syntax guide.",
		link:    Some(PATTERN_GUIDE),
		cause:   Some(cause),
	}
	.print(host);
	8
}

/// Lines of context around matches: (before, after).
type Context = (usize, usize);

/// The lines around a match that ast-grep displays (`DisplayContext`).
struct Display<'s> {
	leading:    &'s str,
	matched:    &'s str,
	trailing:   &'s str,
	/// Zero-based line of the first displayed line.
	start_line: usize,
}

fn display_context<'s>(source: &'s str, span: &Span, (before, after): Context) -> Display<'s> {
	let bytes = source.as_bytes();
	let (mut leading, mut trailing) = (span.start, span.end.min(bytes.len()));
	let mut lines_before = before + 1;
	while leading > 0 {
		if bytes[leading - 1] == b'\n' {
			lines_before -= 1;
			if lines_before == 0 {
				break;
			}
		}
		leading -= 1;
	}
	let mut lines_after = after + 1;
	while trailing < bytes.len() {
		if bytes[trailing] == b'\n' {
			lines_after -= 1;
			if lines_after == 0 {
				break;
			}
		}
		trailing += 1;
	}
	let offset = if lines_before == 0 { before } else { before + 1 - lines_before };
	Display {
		leading:    &source[leading..span.start],
		matched:    &source[span.start..span.end],
		trailing:   &source[span.end.min(trailing)..trailing],
		start_line: span.start_pos.line - offset,
	}
}

/// Appends `matched` with its line terminators normalized as ast-grep does.
fn push_matched(ret: &mut String, matched: &str) {
	for (index, line) in matched.lines().enumerate() {
		if index > 0 {
			ret.push('\n');
		}
		ret.push_str(line);
	}
}

/// Line-oriented rendering of one file's matches (ast-grep's `ColoredPrinter`
/// without colors).
fn print_matches(out: &mut Vec<u8>, path: &str, source: &str, spans: &[&Span], ctx: Context, heading: bool) {
	let separated = ctx.0 + ctx.1 > 0;
	let emit = |out: &mut Vec<u8>, ret: &str, start_line: usize| {
		if heading {
			let max_line = ret.lines().count() + start_line;
			let width = max_line.checked_ilog10().unwrap_or(0) as usize + 1;
			for (offset, line) in ret.lines().enumerate() {
				let _ = writeln!(out, "{:<width$}│{line}", start_line + offset);
			}
			width
		} else {
			for (offset, line) in ret.lines().enumerate() {
				let _ = writeln!(out, "{path}:{}:{line}", start_line + offset);
			}
			0
		}
	};
	if heading {
		let _ = writeln!(out, "{path}");
	}
	let mut spans = spans.iter();
	let Some(first) = spans.next() else {
		return;
	};
	let display = display_context(source, first, ctx);
	let mut last_start_line = display.start_line + 1;
	let mut last_end_line = first.end_pos.line + 1;
	let mut last_trailing = display.trailing;
	let mut last_end_offset = first.end;
	let mut ret = display.leading.to_owned();
	push_matched(&mut ret, display.matched);
	for span in spans {
		if span.start < last_end_offset {
			continue;
		}
		let display = display_context(source, span, ctx);
		if display.start_line <= last_end_line + ctx.1 {
			ret.push_str(&source[last_end_offset..span.start]);
			push_matched(&mut ret, display.matched);
			last_end_offset = span.end;
			last_trailing = display.trailing;
			continue;
		}
		ret.push_str(last_trailing);
		let width = emit(out, &ret, last_start_line);
		if separated {
			if heading {
				let _ = writeln!(out, "{:╴>width$}┤", "");
			} else {
				let _ = writeln!(out, "--");
			}
		}
		last_start_line = display.start_line + 1;
		last_end_line = span.end_pos.line + 1;
		last_trailing = display.trailing;
		last_end_offset = span.end;
		ret = display.leading.to_owned();
		push_matched(&mut ret, display.matched);
	}
	ret.push_str(last_trailing);
	emit(out, &ret, last_start_line);
	if heading {
		let _ = writeln!(out);
	}
}

/// `source` with the non-overlapping `changes` applied, earliest first.
fn apply_changes(source: &str, changes: &[Change]) -> String {
	let mut ret = String::with_capacity(source.len());
	let mut start = 0;
	for change in changes {
		if change.span.start < start {
			continue;
		}
		ret.push_str(&source[start..change.span.start]);
		ret.push_str(&change.after);
		start = change.span.end;
	}
	ret.push_str(&source[start..]);
	ret
}

/// ast-grep's rewrite preview: the path, then unified-diff hunks with old and
/// new line-number columns.
fn print_diff(out: &mut Vec<u8>, path: &str, old: &str, new: &str, context: usize) {
	let _ = writeln!(out, "{path}");
	let diff = TextDiff::from_lines(old, new);
	let column = |index: Option<usize>, width: usize| match index {
		Some(index) => format!("{:<width$}", index + 1),
		None => format!("{:width$}", ""),
	};
	for group in diff.grouped_ops(context) {
		let (Some(first), Some(last)) = (group.first(), group.last()) else {
			continue;
		};
		let old_width = last.old_range().end.checked_ilog10().unwrap_or(0) as usize + 1;
		let new_width = last.new_range().end.checked_ilog10().unwrap_or(0) as usize + 1;
		let (old_len, new_len) = group
			.iter()
			.fold((0, 0), |(old, new), op| (old + op.old_range().len(), new + op.new_range().len()));
		let _ = writeln!(
			out,
			"@@ -{},{old_len} +{},{new_len} @@",
			first.old_range().start,
			first.new_range().start
		);
		for op in &group {
			for change in diff.iter_changes(op) {
				let sign = match change.tag() {
					ChangeTag::Delete => "-",
					ChangeTag::Insert => "+",
					ChangeTag::Equal => " ",
				};
				let _ = write!(
					out,
					"{} {}│{sign}{change}",
					column(change.old_index(), old_width),
					column(change.new_index(), new_width)
				);
			}
		}
	}
}

/// A JSON value with ast-grep's (serde struct) field order.
enum Json {
	Num(usize),
	Str(String),
	Obj(Vec<(&'static str, Json)>),
	Map(Vec<(String, Json)>),
	Arr(Vec<Json>),
}

impl Json {
	/// Writes `self` like `serde_json::to_writer` (`pretty`: `to_writer_pretty`).
	fn write(&self, out: &mut Vec<u8>, pretty: bool, level: usize) {
		match self {
			Self::Num(value) => {
				let _ = write!(out, "{value}");
			},
			Self::Str(value) => {
				let _ = serde_json::to_writer(&mut *out, value);
			},
			Self::Obj(fields) => {
				let fields = fields.iter().map(|(key, value)| (Some(*key), value));
				Self::write_container(out, pretty, level, (b'{', b'}'), fields);
			},
			Self::Map(fields) => {
				let fields = fields.iter().map(|(key, value)| (Some(key.as_str()), value));
				Self::write_container(out, pretty, level, (b'{', b'}'), fields);
			},
			Self::Arr(items) => {
				Self::write_container(out, pretty, level, (b'[', b']'), items.iter().map(|item| (None, item)));
			},
		}
	}

	/// Writes an object (entries with keys) or array (entries without).
	fn write_container<'j>(
		out: &mut Vec<u8>,
		pretty: bool,
		level: usize,
		(open, close): (u8, u8),
		entries: impl ExactSizeIterator<Item = (Option<&'j str>, &'j Self)>,
	) {
		out.push(open);
		let empty = entries.len() == 0;
		for (index, (key, value)) in entries.enumerate() {
			if index > 0 {
				out.push(b',');
			}
			if pretty {
				out.push(b'\n');
				out.extend(std::iter::repeat_n(b' ', 2 * (level + 1)));
			}
			if let Some(key) = key {
				let _ = serde_json::to_writer(&mut *out, key);
				out.extend_from_slice(if pretty { b": " } else { b":" });
			}
			value.write(out, pretty, level + 1);
		}
		if pretty && !empty {
			out.push(b'\n');
			out.extend(std::iter::repeat_n(b' ', 2 * level));
		}
		out.push(close);
	}
}

fn range_json(span: &Span) -> Json {
	let pos = |line: usize, column: usize| Json::Obj(vec![("line", Json::Num(line)), ("column", Json::Num(column))]);
	Json::Obj(vec![
		("byteOffset", Json::Obj(vec![("start", Json::Num(span.start)), ("end", Json::Num(span.end))])),
		("start", pos(span.start_pos.line, span.start_pos.column)),
		("end", pos(span.end_pos.line, span.end_pos.column)),
	])
}

fn node_json(text: &str, span: &Span) -> Json {
	Json::Obj(vec![("text", Json::Str(text.to_owned())), ("range", range_json(span))])
}

fn captures_json(captures: &Captures) -> Json {
	let single = captures
		.single
		.iter()
		.map(|(name, capture)| (name.clone(), node_json(&capture.text, &capture.span)))
		.collect();
	let multi = captures
		.multi
		.iter()
		.map(|(name, nodes)| {
			(name.clone(), Json::Arr(nodes.iter().map(|node| node_json(&node.text, &node.span)).collect()))
		})
		.collect();
	Json::Obj(vec![("single", Json::Map(single)), ("multi", Json::Map(multi)), ("transformed", Json::Map(Vec::new()))])
}

/// One match as ast-grep's `MatchJSON`.
struct MatchJson<'a> {
	path:        &'a str,
	source:      &'a str,
	language:    SupportLang,
	span:        &'a Span,
	captures:    Option<&'a Captures>,
	replacement: Option<&'a Change>,
}

impl MatchJson<'_> {
	fn to_json(&self, ctx: Context) -> Json {
		let display = display_context(self.source, self.span, ctx);
		let mut fields = vec![
			("text", Json::Str(display.matched.to_owned())),
			("range", range_json(self.span)),
			("file", Json::Str(self.path.to_owned())),
			("lines", Json::Str(format!("{}{}{}", display.leading, display.matched, display.trailing))),
			(
				"charCount",
				Json::Obj(vec![
					("leading", Json::Num(display.leading.chars().count())),
					("trailing", Json::Num(display.trailing.chars().count())),
				]),
			),
		];
		if let Some(change) = self.replacement {
			fields.push(("replacement", Json::Str(change.after.clone())));
			fields.push((
				"replacementOffsets",
				Json::Obj(vec![("start", Json::Num(change.span.start)), ("end", Json::Num(change.span.end))]),
			));
		}
		fields.push(("language", Json::Str(self.language.to_string())));
		if let Some(captures) = self.captures.filter(|captures| !captures.single.is_empty() || !captures.multi.is_empty()) {
			fields.push(("metaVariables", captures_json(captures)));
		}
		Json::Obj(fields)
	}
}

/// Stdout framing shared by every output mode.
struct Printer {
	mode:    Output,
	ctx:     Context,
	matched: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Output {
	FilesWithMatches,
	Json(JsonStyle),
	Lines { heading: bool },
}

impl Printer {
	fn before(&self, out: &mut Vec<u8>) {
		if matches!(self.mode, Output::Json(JsonStyle::Pretty | JsonStyle::Compact)) {
			out.push(b'[');
		}
	}

	fn after(&self, out: &mut Vec<u8>) {
		match self.mode {
			Output::Json(JsonStyle::Stream) | Output::FilesWithMatches | Output::Lines { .. } => {},
			Output::Json(style) => {
				if self.matched && style == JsonStyle::Pretty {
					out.push(b'\n');
				}
				out.extend_from_slice(b"]\n");
			},
		}
	}

	/// Renders one file with at least one match.
	fn file(&mut self, out: &mut Vec<u8>, file: &FileOutput<'_>) {
		match self.mode {
			Output::FilesWithMatches => {
				let _ = writeln!(out, "{}", file.path);
			},
			Output::Lines { heading } => match file.changes {
				Some(changes) => {
					let new = apply_changes(file.source, changes);
					let context = if self.ctx.0 == 0 { 3 } else { self.ctx.0 };
					print_diff(out, file.path, file.source, &new, context);
				},
				None => {
					let spans: Vec<&Span> = file.matches.iter().map(|matched| matched.span).collect();
					print_matches(out, file.path, file.source, &spans, self.ctx, heading);
				},
			},
			Output::Json(style) => {
				if self.matched {
					match style {
						JsonStyle::Pretty => out.extend_from_slice(b",\n"),
						JsonStyle::Stream => {},
						JsonStyle::Compact => out.push(b','),
					}
				} else if style == JsonStyle::Pretty {
					out.push(b'\n');
				}
				let replacements: HashMap<usize, &Change> =
					file.changes.unwrap_or_default().iter().map(|change| (change.span.start, change)).collect();
				for (index, matched) in file.matches.iter().enumerate() {
					if index > 0 {
						match style {
							JsonStyle::Pretty => out.extend_from_slice(b",\n"),
							JsonStyle::Stream => {},
							JsonStyle::Compact => out.push(b','),
						}
					}
					let json = MatchJson {
						path:        file.path,
						source:      file.source,
						language:    file.language,
						span:        matched.span,
						captures:    matched.captures,
						replacement: replacements.get(&matched.span.start).copied(),
					};
					json.to_json(self.ctx).write(out, style == JsonStyle::Pretty, 0);
					if style == JsonStyle::Stream {
						out.push(b'\n');
					}
				}
			},
		}
		self.matched = true;
	}
}

/// A match as the printers see it.
struct MatchRef<'a> {
	span:     &'a Span,
	captures: Option<&'a Captures>,
}

/// One file's results as the printers see them.
struct FileOutput<'a> {
	path:     &'a str,
	source:   &'a str,
	language: SupportLang,
	matches:  Vec<MatchRef<'a>>,
	/// The rewrite of each match, when rewriting.
	changes:  Option<&'a [Change]>,
}

/// ast-grep's display spelling of a file found below operand `root`.
fn display_path(root: &str, root_is_dir: bool, candidate: &Candidate) -> String {
	let joined = if root_is_dir { Path::new(root).join(&candidate.display) } else { Path::new(root).to_path_buf() };
	let shown = joined.strip_prefix("./").unwrap_or(&joined);
	shown.to_string_lossy().into_owned()
}

/// Splits `--globs` into include and exclude selectors.
fn glob_selectors(globs: &[String]) -> Result<(Option<Selector>, Option<Selector>), String> {
	let (excluded, included): (Vec<&str>, Vec<&str>) = globs.iter().map(String::as_str).partition(|glob| glob.starts_with('!'));
	let include = match included.as_slice() {
		[] => None,
		[glob] => Some(Selector::new(glob, true).map_err(|error| error.to_string())?),
		globs => Some(Selector::new(&format!("{{{}}}", globs.join(",")), true).map_err(|error| error.to_string())?),
	};
	let excluded: Vec<&str> = excluded.iter().map(|glob| &glob[1..]).collect();
	let exclude = Selector::exclude(&excluded).map_err(|error| error.to_string())?;
	Ok((include, exclude))
}

impl AstGrep {
	fn context(&self) -> Context {
		if self.context > 0 {
			(self.context.into(), self.context.into())
		} else {
			(self.before.into(), self.after.into())
		}
	}

	fn strictness(&self) -> MatchStrictness {
		self.strictness.map_or(MatchStrictness::Smart, Into::into)
	}

	fn output(&self) -> Output {
		if self.files_with_matches {
			Output::FilesWithMatches
		} else if let Some(style) = self.json {
			Output::Json(style)
		} else {
			Output::Lines { heading: self.heading == Heading::Always }
		}
	}

	/// `-U` without `--json`: rewrite files in place.
	fn applies(&self) -> bool {
		self.update_all && self.json.is_none()
	}

	fn rewrite_spec<'a>(&'a self, rules: &'a [(String, String)], mode: Mode) -> Rewrite<'a> {
		Rewrite {
			rules,
			lang: self.lang.map(SupportLang::canonical_name),
			selector: self.selector.as_deref(),
			strictness: self.strictness(),
			max_replacements: usize::MAX,
			max_files: usize::MAX,
			fail_on_parse_error: false,
			mode,
			skip_overlaps: true,
		}
	}

	/// Files below every operand, in operand order, displayed as ast-grep does;
	/// walk failures are reported and skipped.
	async fn candidates(&self, host: &mut Host) -> Result<Vec<Candidate>, i32> {
		let (include, exclude) = match glob_selectors(&self.globs) {
			Ok(selectors) => selectors,
			Err(error) => {
				Report {
					warning: false,
					title:   "Cannot build glob from CLI flag",
					help:    "The patterns in --globs is invalid. Please refer to doc and fix the error.",
					link:    Some(CLI_USAGE),
					cause:   Some(error),
				}
				.print(host);
				return Err(9);
			},
		};
		let ignores = |kind| self.no_ignore.contains(&kind);
		let options = Discover {
			include,
			exclude,
			hidden: ignores(IgnoreFile::Hidden),
			gitignore: !ignores(IgnoreFile::Dot) && !ignores(IgnoreFile::Vcs),
			node_modules: true,
			follow_links: self.follow,
			workers: (self.threads > 0).then_some(self.threads),
			any_file: false,
		};
		let vfs = host.vfs();
		let mut candidates = Vec::new();
		for operand in &self.paths {
			let root = host.resolve(operand);
			let root_is_dir = vfs.metadata(&root).await.is_ok_and(|meta| meta.is_dir());
			match search::discover(&vfs, &root, &options).await {
				Ok(found) => candidates.extend(
					found
						.into_iter()
						.filter(|candidate| self.lang.is_none_or(|lang| SupportLang::from_path(&candidate.path) == Some(lang)))
						.map(|candidate| Candidate { display: display_path(operand, root_is_dir, &candidate), ..candidate }),
				),
				Err(SearchError::Stopped) => return Err(1),
				Err(SearchError::Root { error, .. }) => {
					let _ = writeln!(host.stderr, "ERROR: {operand}: {error}");
				},
				Err(error) => {
					let _ = writeln!(host.stderr, "ERROR: {error}");
				},
			}
		}
		Ok(candidates)
	}

	/// Searches (and with `-r`, previews rewrites of) every file; returns
	/// whether anything matched.
	async fn search_paths(&self, host: &mut Host, out: &mut (dyn Write + Send), printer: &mut Printer) -> Result<bool, i32> {
		let candidates = self.candidates(host).await?;
		let vfs = host.vfs();
		let stop = CancellationToken::new();
		let patterns = [self.pattern.clone()];
		let query = Query {
			patterns:   &patterns,
			lang:       self.lang.map(SupportLang::canonical_name),
			selector:   self.selector.as_deref(),
			strictness: self.strictness(),
			captures:   matches!(printer.mode, Output::Json(_)),
		};
		let rules = self.rewrite.as_ref().map(|template| [(self.pattern.clone(), template.clone())]);
		let rewrite = rules.as_ref().map(|rules| self.rewrite_spec(rules, Mode::Preview));
		let mut any = false;
		let mut finder = search::find(&vfs, candidates, &query);
		while let Some(file) = finder.next().await {
			let file = match file {
				Ok(file) => file,
				Err(SearchError::Stopped) => return Err(1),
				Err(error) => {
					let _ = writeln!(host.stderr, "ERROR: {error}");
					return Ok(any);
				},
			};
			let changes = match &rewrite {
				Some(rewrite) => match search::rewrite_source(&file.source, file.language, rewrite, &stop) {
					Ok(edit) => Some(edit.changes),
					Err(error) => return Err(parse_pattern_error(host, error.to_string())),
				},
				None => None,
			};
			let view = FileOutput {
				path:     &file.display,
				source:   &file.source,
				language: file.language,
				matches:  file.matches.iter().map(|matched| MatchRef { span: &matched.span, captures: matched.captures.as_ref() }).collect(),
				changes:  changes.as_deref(),
			};
			let mut buffer = Vec::new();
			printer.file(&mut buffer, &view);
			any = true;
			if out.write_all(&buffer).is_err() {
				break;
			}
			let _ = host.flush_output().await;
		}
		Ok(any)
	}

	/// `-U` over files: rewrites every file in place and reports the count.
	async fn apply_paths(&self, host: &mut Host) -> Result<usize, i32> {
		let candidates = self.candidates(host).await?;
		let vfs = host.vfs();
		let rules = [(self.pattern.clone(), self.rewrite.clone().unwrap_or_default())];
		match search::rewrite(&vfs, candidates, &self.rewrite_spec(&rules, Mode::Write)).await {
			Ok(edited) => Ok(edited.files.iter().map(|file| file.changes.len()).sum()),
			Err(SearchError::Stopped) => Err(1),
			Err(error) => Err(parse_pattern_error(host, error.to_string())),
		}
	}

	async fn run_stdin(&self, host: &mut Host, lang: SupportLang, out: &mut (dyn Write + Send), printer: &mut Printer) -> Result<bool, i32> {
		let mut bytes = Vec::new();
		let read = host.read_stdin_to_end(&mut bytes, usize::MAX).await.and_then(|_| {
			String::from_utf8(bytes).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "stream did not contain valid UTF-8"))
		});
		let source = match read {
			Ok(source) => source,
			Err(error) => {
				let _ = writeln!(host.stderr, "ERROR: {error}");
				return Err(1);
			},
		};
		let stop = CancellationToken::new();
		let patterns = [self.pattern.clone()];
		let query = Query {
			patterns:   &patterns,
			lang:       None,
			selector:   self.selector.as_deref(),
			strictness: self.strictness(),
			captures:   matches!(printer.mode, Output::Json(_)),
		};
		let found = match search::find_source(&source, lang, &query, Page { offset: 0, limit: usize::MAX }, &stop) {
			Ok(found) => found,
			Err(SearchError::Stopped) => return Err(1),
			Err(error) => return Err(parse_pattern_error(host, error.to_string())),
		};
		if found.matches.is_empty() {
			return Ok(false);
		}
		let edit = match self.rewrite.as_ref() {
			Some(template) => {
				let rules = [(self.pattern.clone(), template.clone())];
				match search::rewrite_source(&source, lang, &self.rewrite_spec(&rules, Mode::Render), &stop) {
					Ok(edit) => Some(edit),
					Err(SearchError::Stopped) => return Err(1),
					Err(error) => return Err(parse_pattern_error(host, error.to_string())),
				}
			},
			None => None,
		};
		if self.applies()
			&& let Some(edit) = &edit
		{
			let _ = writeln!(out, "{}", edit.content);
			let _ = writeln!(host.stderr, "Applied {} changes", edit.changes.len());
			return Ok(true);
		}
		let view = FileOutput {
			path:     STDIN_PATH,
			source:   &source,
			language: lang,
			matches:  found.matches.iter().map(|matched| MatchRef { span: &matched.span, captures: matched.captures.as_ref() }).collect(),
			changes:  edit.as_ref().map(|edit| edit.changes.as_slice()),
		};
		let mut buffer = Vec::new();
		printer.file(&mut buffer, &view);
		let _ = out.write_all(&buffer);
		Ok(true)
	}

	async fn execute(&self, host: &mut Host) -> Result<bool, i32> {
		let lang = match (self.stdin, self.lang) {
			(true, None) => {
				Report {
					warning: false,
					title:   "Language must be specified for code from StdIn.",
					help:    "Please use `--lang` to specify the code language.",
					link:    Some(TOOL_OVERVIEW),
					cause:   None,
				}
				.print(host);
				return Err(3);
			},
			(_, lang) => lang,
		};
		let has_error = match lang {
			Some(lang) => match ops::compile_pattern(&self.pattern, self.selector.as_deref(), &self.strictness(), lang) {
				Ok(pattern) => pattern.has_error(),
				Err(error) => return Err(parse_pattern_error(host, error.to_string())),
			},
			None => false,
		};
		let mut out = host.stdout_writer();
		let mut printer = Printer { mode: self.output(), ctx: self.context(), matched: false };
		let mut head = Vec::new();
		printer.before(&mut head);
		let _ = out.write_all(&head);
		let matched = match lang {
			Some(lang) if self.stdin => self.run_stdin(host, lang, &mut out, &mut printer).await?,
			_ if self.applies() => {
				let applied = self.apply_paths(host).await?;
				if applied > 0 {
					let _ = writeln!(host.stderr, "Applied {applied} changes");
				}
				applied > 0
			},
			_ => self.search_paths(host, &mut out, &mut printer).await?,
		};
		let mut tail = Vec::new();
		printer.after(&mut tail);
		let _ = out.write_all(&tail);
		let _ = out.flush();
		let _ = host.flush_output().await;
		if !matched && has_error {
			Report {
				warning: true,
				title:   "Pattern contains an ERROR node and may cause unexpected results.",
				help:    "ast-grep parsed the pattern but it matched nothing in this run. Try using playground to refine the pattern.",
				link:    Some(PLAYGROUND),
				cause:   None,
			}
			.print(host);
			return Ok(true);
		}
		Ok(matched)
	}
}

impl AsyncUtility for AstGrep {
	const NAME: &'static str = "ast-grep";
	const USAGE_ERROR: u8 = 2;

	/// Drops the `run` subcommand and rejects ast-grep features the builtin
	/// does not implement.
	fn rewrite_argv(mut argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		if let Some(command) = argv.get(1).and_then(|arg| arg.to_str()) {
			if command == "run" {
				argv.remove(1);
			} else if UNSUPPORTED_COMMANDS.contains(&command) {
				return Err(format!("{command} is not supported by the built-in ast-grep"));
			}
		}
		let mut value_next = false;
		for arg in argv.iter().skip(1) {
			if std::mem::take(&mut value_next) {
				continue;
			}
			let Some(arg) = arg.to_str() else {
				continue;
			};
			if arg == "--" {
				break;
			}
			let name = arg.split_once('=').map_or(arg, |(name, _)| name);
			if let Some((option, _)) = UNSUPPORTED_OPTIONS.iter().find(|(_, spellings)| spellings.contains(&name)) {
				return Err(format!("{option} is not supported by the built-in ast-grep"));
			}
			value_next = VALUE_OPTIONS.contains(&arg);
		}
		Ok(argv)
	}

	async fn run(self, host: &mut Host) -> i32 {
		match self.execute(host).await {
			Ok(true) => 0,
			Ok(false) => 1,
			Err(code) => code,
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::host::run_async_util;

	const A_RS: &str = "fn main() {\n    let a = foo(1);\n    let b = 2;\n    let c = foo(a, b);\n    println!(\"{}\", c);\n}\n";
	const B_RS: &str = "fn g() -> i32 {\n    foo(3)\n}\n";

	/// `big.rs`: twenty `let` lines with `foo(1)` on line 3 and `foo(2)` on line 15.
	fn big_rs() -> String {
		(1..=20)
			.map(|line| match line {
				3 => "    foo(1);\n".to_owned(),
				15 => "    foo(2);\n".to_owned(),
				_ => format!("    let x{line} = 0;\n"),
			})
			.collect()
	}

	fn tree() -> tempfile::TempDir {
		let tree = tempfile::tempdir().unwrap();
		std::fs::write(tree.path().join("a.rs"), A_RS).unwrap();
		std::fs::write(tree.path().join("b.rs"), B_RS).unwrap();
		std::fs::write(tree.path().join("big.rs"), big_rs()).unwrap();
		tree
	}

	async fn run(tree: &tempfile::TempDir, args: &[&str]) -> (i32, String, String) {
		let (code, capture) = run_async_util::<AstGrep>(args, "", tree.path()).await;
		(code, capture.out(), capture.err())
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn default_prints_path_line_and_text() {
		let tree = tree();
		let (code, out, err) = run(&tree, &["run", "-p", "foo($A)", "-l", "rust", "a.rs"]).await;
		assert_eq!((code, out.as_str()), (0, "a.rs:2:    let a = foo(1);\n"), "{err}");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn heading_always_prints_numbered_block_per_file() {
		let tree = tree();
		let (code, out, err) = run(&tree, &["-p", "foo($$$A)", "--heading", "always", "a.rs"]).await;
		assert_eq!((code, out.as_str()), (0, "a.rs\n2│    let a = foo(1);\n4│    let c = foo(a, b);\n\n"), "{err}");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn context_lines_are_separated_between_groups() {
		let tree = tree();
		let (code, out, err) = run(&tree, &["run", "-p", "foo($A)", "-C", "1", "big.rs"]).await;
		assert_eq!(
			(code, out.as_str()),
			(
				0,
				"big.rs:2:    let x2 = 0;\nbig.rs:3:    foo(1);\nbig.rs:4:    let x4 = 0;\n--\nbig.rs:14:    let x14 = \
				 0;\nbig.rs:15:    foo(2);\nbig.rs:16:    let x16 = 0;\n"
			),
			"{err}"
		);
		let (code, out, err) = run(&tree, &["run", "-p", "foo($A)", "-A", "1", "--heading", "always", "big.rs"]).await;
		assert_eq!(
			(code, out.as_str()),
			(0, "big.rs\n3│    foo(1);\n4│    let x4 = 0;\n╴┤\n15│    foo(2);\n16│    let x16 = 0;\n\n"),
			"{err}"
		);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn rewrite_prints_diff_hunks() {
		let tree = tree();
		let (code, out, err) = run(&tree, &["run", "-p", "foo($A)", "-r", "bar($A)", "big.rs"]).await;
		assert_eq!(
			(code, out.as_str()),
			(
				0,
				"big.rs\n@@ -0,6 +0,6 @@\n1 1│     let x1 = 0;\n2 2│     let x2 = 0;\n3  │-    foo(1);\n  3│+    \
				 bar(1);\n4 4│     let x4 = 0;\n5 5│     let x5 = 0;\n6 6│     let x6 = 0;\n@@ -11,7 +11,7 @@\n12 12│     \
				 let x12 = 0;\n13 13│     let x13 = 0;\n14 14│     let x14 = 0;\n15   │-    foo(2);\n   15│+    \
				 bar(2);\n16 16│     let x16 = 0;\n17 17│     let x17 = 0;\n18 18│     let x18 = 0;\n"
			),
			"{err}"
		);
		assert_eq!(std::fs::read_to_string(tree.path().join("big.rs")).unwrap(), big_rs());
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn update_all_rewrites_files_and_reports_count() {
		let tree = tree();
		let (code, out, err) = run(&tree, &["run", "-p", "foo($A)", "-r", "bar($A)", "-l", "rust", "-U", "a.rs", "b.rs"]).await;
		assert_eq!((code, out.as_str(), err.as_str()), (0, "", "Applied 2 changes\n"));
		assert_eq!(std::fs::read_to_string(tree.path().join("a.rs")).unwrap(), A_RS.replace("foo(1)", "bar(1)"));
		assert_eq!(std::fs::read_to_string(tree.path().join("b.rs")).unwrap(), B_RS.replace("foo(3)", "bar(3)"));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn json_pretty_prints_match_array() {
		let tree = tree();
		let (code, out, err) = run(&tree, &["run", "-p", "foo($$$A)", "-l", "rust", "--json", "b.rs"]).await;
		let expected = r#"[
{
  "text": "foo(3)",
  "range": {
    "byteOffset": {
      "start": 20,
      "end": 26
    },
    "start": {
      "line": 1,
      "column": 4
    },
    "end": {
      "line": 1,
      "column": 10
    }
  },
  "file": "b.rs",
  "lines": "    foo(3)",
  "charCount": {
    "leading": 4,
    "trailing": 0
  },
  "language": "Rust",
  "metaVariables": {
    "single": {},
    "multi": {
      "A": [
        {
          "text": "3",
          "range": {
            "byteOffset": {
              "start": 24,
              "end": 25
            },
            "start": {
              "line": 1,
              "column": 8
            },
            "end": {
              "line": 1,
              "column": 9
            }
          }
        }
      ]
    },
    "transformed": {}
  }
}
]
"#;
		assert_eq!((code, out.as_str()), (0, expected), "{err}");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn json_stream_prints_one_object_per_line() {
		let tree = tree();
		let (code, out, err) = run(&tree, &["run", "-p", "foo($A)", "--json=stream", "b.rs"]).await;
		let expected = concat!(
			r#"{"text":"foo(3)","range":{"byteOffset":{"start":20,"end":26},"start":{"line":1,"column":4},"end":{"line":1,"column":10}},"#,
			r#""file":"b.rs","lines":"    foo(3)","charCount":{"leading":4,"trailing":0},"language":"Rust","#,
			r#""metaVariables":{"single":{"A":{"text":"3","range":{"byteOffset":{"start":24,"end":25},"start":{"line":1,"column":8},"end":{"line":1,"column":9}}}},"multi":{},"transformed":{}}}"#,
			"\n"
		);
		assert_eq!((code, out.as_str()), (0, expected), "{err}");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn json_compact_with_rewrite_includes_replacement() {
		let tree = tree();
		let (code, out, err) = run(&tree, &["run", "-p", "foo($A)", "-r", "bar($A)", "--json=compact", "b.rs"]).await;
		let expected = concat!(
			r#"[{"text":"foo(3)","range":{"byteOffset":{"start":20,"end":26},"start":{"line":1,"column":4},"end":{"line":1,"column":10}},"#,
			r#""file":"b.rs","lines":"    foo(3)","charCount":{"leading":4,"trailing":0},"replacement":"bar(3)","replacementOffsets":{"start":20,"end":26},"language":"Rust","#,
			r#""metaVariables":{"single":{"A":{"text":"3","range":{"byteOffset":{"start":24,"end":25},"start":{"line":1,"column":8},"end":{"line":1,"column":9}}}},"multi":{},"transformed":{}}}]"#,
			"\n"
		);
		assert_eq!((code, out.as_str()), (0, expected), "{err}");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn files_with_matches_lists_matching_files() {
		let tree = tree();
		let (code, out, err) = run(&tree, &["run", "-p", "foo($$$A)", "--files-with-matches", "a.rs", "b.rs", "big.rs"]).await;
		assert_eq!((code, out.as_str()), (0, "a.rs\nb.rs\nbig.rs\n"), "{err}");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn no_match_exits_one() {
		let tree = tree();
		assert_eq!(run(&tree, &["run", "-p", "nope($A)", "a.rs"]).await, (1, String::new(), String::new()));
		assert_eq!(run(&tree, &["run", "-p", "nope($A)", "--json", "a.rs"]).await, (1, "[]\n".to_owned(), String::new()));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn directory_operand_displays_relative_paths() {
		let tree = tree();
		let (code, out, err) = run(&tree, &["run", "-p", "foo($A)", "-l", "rust"]).await;
		assert_eq!((code, out.as_str()), (0, "a.rs:2:    let a = foo(1);\nb.rs:2:    foo(3)\nbig.rs:3:    foo(1);\nbig.rs:15:    foo(2);\n"), "{err}");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn stdin_requires_lang_and_reads_code() {
		let (code, capture) = run_async_util::<AstGrep>(&["run", "-p", "foo($A)", "-l", "rust", "--stdin"], "let x = foo(1);\n", "/").await;
		assert_eq!((code, capture.out().as_str()), (0, "STDIN:1:let x = foo(1);\n"), "{}", capture.err());
		let (code, capture) = run_async_util::<AstGrep>(&["run", "-p", "foo($A)", "--stdin"], "", "/").await;
		assert_eq!(
			(code, capture.err().as_str()),
			(
				3,
				"Error: Language must be specified for code from StdIn.\nHelp: Please use `--lang` to specify the code \
				 language.\nSee also: https://ast-grep.github.io/guide/tooling-overview.html#parse-code-from-stdin\n\n"
			)
		);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn unsupported_features_exit_two() {
		let tree = tree();
		assert_eq!(run(&tree, &["scan"]).await, (2, String::new(), "ast-grep: scan is not supported by the built-in ast-grep\n".to_owned()));
		assert_eq!(
			run(&tree, &["run", "-p", "foo", "--interactive", "a.rs"]).await,
			(2, String::new(), "ast-grep: --interactive is not supported by the built-in ast-grep\n".to_owned())
		);
	}
}

use brush_core::{ShellExtensions, builtins::Registration};

use crate::host::async_util;

/// Creates the `ast-grep` (and `sg`) builtin registration.
pub(crate) fn ast_grep_builtin<SE: ShellExtensions>() -> Registration<SE> {
	async_util::<AstGrep, SE>()
}
