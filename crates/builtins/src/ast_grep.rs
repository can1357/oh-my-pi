//! `ast-grep` / `sg` builtin: ast-grep 0.50's `run` (structural search and
//! rewrite), `scan` (YAML rules, `sgconfig.yml` projects), `test` (rule test
//! cases and snapshots) and `outline` (symbol outlines) commands as an
//! in-process shell utility on top of the `omp_ast` search engine, with
//! ast-grep's piped (non-terminal) output: no colors and no file headings
//! unless `--heading always`.

use std::{
	collections::{HashMap, HashSet},
	ffi::OsString,
	fmt::Write as _,
	io::{self, Write},
	path::{Path, PathBuf},
};

use ast_grep_config::{
	DeserializeEnv, Fixer, GlobalRules, LabelStyle, RuleCollection, RuleConfig, RuleCore,
	SerializableRule, Severity, from_yaml_string,
};
use ast_grep_core::tree_sitter::LanguageExt;
use clap::{ArgAction, Args, Parser, Subcommand, ValueEnum};
use codespan_reporting::{
	diagnostic::{Diagnostic, Label as CodeLabel, Severity as CodeSeverity},
	files::SimpleFile,
	term::{self as codespan, DisplayStyle},
};
use futures::StreamExt;
use omp_ast::{
	SupportLang, debug, ops,
	outline::{self, SymbolType},
	search::{
		self, Candidate, Captures, Change, Discover, Error as SearchError, MatchStrictness, Mode,
		Page, Query, Rewrite, Span,
	},
};
use omp_xfs::glob::Selector;
use omp_diff::{HunkLine, diff_line_tokens, line_tokens_str, structured_patch_hunk_rows};
use tokio_util::sync::CancellationToken;

use crate::host::{AsyncUtility, Host};

mod verify;

const DOC_SITE_HOST: &str = "https://ast-grep.github.io";
const PATTERN_GUIDE: &str = "/guide/pattern-syntax.html";
const ESQUERY_GUIDE: &str = "/reference/rule/esquery.html";
const CONFIG_GUIDE: &str = "/guide/rule-config.html";
const CONFIG_REFERENCE: &str = "/reference/sgconfig.html";
const PROJECT_GUIDE: &str = "/guide/scan-project.html";
const UTILITY_RULE: &str = "/guide/rule-config/utility-rule.html";
const TOOL_OVERVIEW: &str = "/guide/tooling-overview.html#parse-code-from-stdin";
const CLI_USAGE: &str = "/reference/cli.html";
const PLAYGROUND: &str = "/playground.html";

/// Display path of code read from stdin.
const STDIN_PATH: &str = "STDIN";

/// ast-grep's project configuration file name.
const PROJECT_CONFIG: &str = "sgconfig.yml";

/// The builtin's subcommands; any other first argument runs `run`.
const COMMANDS: &[&str] = &["run", "scan", "test", "outline", "help"];

/// ast-grep subcommands the builtin does not implement.
const UNSUPPORTED_COMMANDS: &[&str] = &["new", "lsp", "completions"];

/// Options that take a separate value, so their value is never read as a flag.
const VALUE_OPTIONS: &[&str] = &[
	"-p", "--pattern", "-r", "--rewrite", "--rule", "-l", "--lang", "--selector", "--strictness", "--globs",
	"-j", "--threads", "-A", "--after", "-B", "--before", "-C", "--context", "--color", "--heading",
	"--no-ignore", "-c", "--config", "-k", "--kind", "--inline-rules", "--filter", "--report-style",
	"--max-results", "--items", "--type", "--match", "--view", "-t", "--test-dir", "--snapshot-dir", "-f",
];

/// Unsupported ast-grep options, by the spellings that select them.
const UNSUPPORTED_OPTIONS: &[(&str, &[&str])] = &[("--interactive", &["-i", "--interactive"]), ("--inspect", &["--inspect"])];

/// The first ast-grep feature `args` (the arguments after the program name)
/// use that the builtin does not implement.
fn unsupported_feature<'a>(args: impl IntoIterator<Item = Option<&'a str>>) -> Option<&'static str> {
	let mut value_next = false;
	let mut command_seen = false;
	for arg in args {
		if std::mem::take(&mut value_next) {
			continue;
		}
		let Some(arg) = arg else {
			continue;
		};
		if arg == "--" {
			break;
		}
		if !command_seen && !arg.starts_with('-') {
			command_seen = true;
			if let Some(command) = UNSUPPORTED_COMMANDS.iter().find(|name| **name == arg) {
				return Some(*command);
			}
			continue;
		}
		let name = arg.split_once('=').map_or(arg, |(name, _)| name);
		if let Some((option, _)) = UNSUPPORTED_OPTIONS.iter().find(|(_, spellings)| spellings.contains(&name)) {
			return Some(*option);
		}
		value_next = VALUE_OPTIONS.contains(&arg);
	}
	None
}

/// Index of the subcommand in `argv`, past global `-c`/`--config` options;
/// `None` when the first other argument is not a subcommand.
fn command_index(argv: &[OsString]) -> Option<usize> {
	let mut index = 1;
	while let Some(arg) = argv.get(index).and_then(|arg| arg.to_str()) {
		if arg == "-c" || arg == "--config" {
			index += 2;
		} else if arg.starts_with("--config=") || (arg.starts_with("-c") && arg.len() > 2 && !arg.starts_with("--")) {
			index += 1;
		} else {
			return COMMANDS.contains(&arg).then_some(index);
		}
	}
	None
}

#[derive(Parser, Debug)]
#[command(
	name = "ast-grep",
	version = "0.50.0",
	about = "Search and Rewrite code at large scale using AST pattern."
)]
pub(crate) struct AstGrep {
	#[command(subcommand)]
	command: Command,

	/// Path to ast-grep root config, default is sgconfig.yml.
	#[arg(short, long, global = true, value_name = "CONFIG_FILE")]
	config: Option<String>,
}

#[derive(Subcommand, Debug)]
enum Command {
	/// Run one time search or rewrite in command line. (default command)
	Run(Run),
	/// Scan and rewrite code by configuration.
	Scan(Scan),
	/// Test ast-grep rules.
	Test(verify::Test),
	/// Explore code structure for symbols, imports, exports, and members.
	Outline(Outline),
}

#[derive(Args, Debug)]
struct Run {
	/// AST pattern to match.
	#[arg(short, long, value_name = "PATTERN", required_unless_present = "kind")]
	pattern: Option<String>,

	/// AST kind to match (an ESQuery-style selector).
	#[arg(short, long, value_name = "KIND", conflicts_with_all = ["pattern", "selector", "strictness"])]
	kind: Option<String>,

	/// Print the query's tree-sitter tree to stderr; requires `--lang`.
	#[arg(
		long,
		requires = "lang",
		value_name = "FORMAT",
		num_args(0..=1),
		require_equals = true,
		default_missing_value = "pattern"
	)]
	debug_query: Option<DebugFormat>,

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

	#[command(flatten)]
	input: Input,

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

/// Where a command reads code from (ast-grep's `InputArgs`).
#[derive(Args, Debug)]
struct Input {
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
}

/// ast-grep's `--debug-query` formats.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum DebugFormat {
	/// Print the query parsed in Pattern format
	Pattern,
	/// Print the query in tree-sitter AST format, only named nodes are shown
	Ast,
	/// Print the query in tree-sitter CST format, both named and unnamed nodes are shown
	Cst,
	/// Print the query in S-expression format
	Sexp,
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
	print_diff_hunks(out, old, new, context);
}

/// The hunks of [`print_diff`], without the path line.
fn print_diff_hunks(out: &mut Vec<u8>, old: &str, new: &str, context: usize) {
	let old_tokens = line_tokens_str(old);
	let new_tokens = line_tokens_str(new);
	let runs = diff_line_tokens(&old_tokens, &new_tokens);
	let column = |index: Option<usize>, width: usize| match index {
		Some(index) => format!("{:<width$}", index + 1),
		None => format!("{:width$}", ""),
	};
	for hunk in structured_patch_hunk_rows(
		Some(u32::try_from(context).unwrap_or(u32::MAX)),
		&old_tokens,
		&new_tokens,
		&runs,
	) {
		let mut old_index = hunk.old_start as usize - 1;
		let mut new_index = hunk.new_start as usize - 1;
		let old_len = hunk.old_lines as usize;
		let new_len = hunk.new_lines as usize;
		let old_width = (old_index + old_len).checked_ilog10().unwrap_or(0) as usize + 1;
		let new_width = (new_index + new_len).checked_ilog10().unwrap_or(0) as usize + 1;
		let _ = writeln!(out, "@@ -{old_index},{old_len} +{new_index},{new_len} @@");
		for row in hunk.lines {
			let (old_number, new_number, sign, text) = match row {
				HunkLine::Removed(_) => (Some(old_index), None, "-", old_tokens[old_index]),
				HunkLine::Added(_) => (None, Some(new_index), "+", new_tokens[new_index]),
				HunkLine::Context(_) => {
					(Some(old_index), Some(new_index), " ", old_tokens[old_index])
				},
				// Previews retain the original line terminators and do not print
				// unified-patch EOF annotations.
				HunkLine::NoNewlineAtEof => continue,
			};
			let _ = write!(
				out,
				"{} {}│{sign}{text}",
				column(old_number, old_width),
				column(new_number, new_width)
			);
			old_index += usize::from(old_number.is_some());
			new_index += usize::from(new_number.is_some());
		}
	}
}

/// A JSON value with ast-grep's (serde struct) field order.
enum Json {
	Null,
	Num(usize),
	Str(String),
	/// A serde value, written as `serde_json` writes it (rule metadata).
	Value(serde_json::Value),
	Obj(Vec<(&'static str, Json)>),
	Map(Vec<(String, Json)>),
	Arr(Vec<Json>),
}

impl Json {
	/// Writes `self` like `serde_json::to_writer` (`pretty`: `to_writer_pretty`).
	fn write(&self, out: &mut Vec<u8>, pretty: bool, level: usize) {
		match self {
			Self::Null => out.extend_from_slice(b"null"),
			Self::Num(value) => {
				let _ = write!(out, "{value}");
			},
			Self::Value(value) => {
				let _ = serde_json::to_writer(&mut *out, value);
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

impl Input {
	/// Files below every operand, in operand order, displayed as ast-grep does;
	/// walk failures are reported and skipped.
	async fn candidates(&self, host: &mut Host, lang: Option<SupportLang>) -> Result<Vec<Candidate>, i32> {
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
			lang: None,
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
						.filter(|candidate| {
							lang.is_none_or(|lang| {
								SupportLang::from_path(&candidate.path).is_some_and(|found| found.parses_as(lang))
							})
						})
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
}

impl Run {
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

	/// Searches (and with `-r`, previews rewrites of) every file; returns
	/// whether anything matched.
	async fn search_paths(
		&self,
		host: &mut Host,
		pattern: &str,
		out: &mut (dyn Write + Send),
		printer: &mut Printer,
	) -> Result<bool, i32> {
		let candidates = self.input.candidates(host, self.lang).await?;
		let vfs = host.vfs();
		let stop = CancellationToken::new();
		let patterns = [pattern.to_owned()];
		let query = Query {
			patterns:   &patterns,
			lang:       self.lang.map(SupportLang::canonical_name),
			selector:   self.selector.as_deref(),
			strictness: self.strictness(),
			captures:   matches!(printer.mode, Output::Json(_)),
		};
		let rules = self.rewrite.as_ref().map(|template| [(pattern.to_owned(), template.clone())]);
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
	async fn apply_paths(&self, host: &mut Host, pattern: &str) -> Result<usize, i32> {
		let candidates = self.input.candidates(host, self.lang).await?;
		let vfs = host.vfs();
		let rules = [(pattern.to_owned(), self.rewrite.clone().unwrap_or_default())];
		match search::rewrite(&vfs, candidates, &self.rewrite_spec(&rules, Mode::Write)).await {
			Ok(edited) => Ok(edited.files.iter().map(|file| file.changes.len()).sum()),
			Err(SearchError::Stopped) => Err(1),
			Err(error) => Err(parse_pattern_error(host, error.to_string())),
		}
	}

	async fn run_stdin(
		&self,
		host: &mut Host,
		pattern: &str,
		lang: SupportLang,
		out: &mut (dyn Write + Send),
		printer: &mut Printer,
	) -> Result<bool, i32> {
		let source = read_stdin(host).await?;
		let stop = CancellationToken::new();
		let patterns = [pattern.to_owned()];
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
				let rules = [(pattern.to_owned(), template.clone())];
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

	/// `--kind`: every node the selector matches, per file (or stdin), printed
	/// and rewritten like pattern matches.
	async fn search_kind(
		&self,
		host: &mut Host,
		kind: &str,
		lang: Option<SupportLang>,
		out: &mut (dyn Write + Send),
		printer: &mut Printer,
	) -> Result<bool, i32> {
		let captures = matches!(printer.mode, Output::Json(_));
		let mut matchers = KindMatchers::new();
		if self.input.stdin {
			let Some(lang) = lang else {
				return Ok(false);
			};
			let source = read_stdin(host).await?;
			self.compile_kind(host, &mut matchers, kind, lang)?;
			let (matcher, fixer) = &matchers[&lang];
			let found = match_rule(&source, lang, matcher, fixer.as_ref(), captures);
			if found.spans.is_empty() {
				return Ok(false);
			}
			if self.applies() {
				let _ = writeln!(out, "{}", apply_changes(&source, found.changes.as_deref().unwrap_or_default()));
				let _ = writeln!(host.stderr, "Applied {} changes", found.spans.len());
				return Ok(true);
			}
			let mut buffer = Vec::new();
			printer.file(&mut buffer, &found.view(STDIN_PATH, &source, lang));
			let _ = out.write_all(&buffer);
			return Ok(true);
		}
		let candidates = self.input.candidates(host, self.lang).await?;
		let vfs = host.vfs();
		let (mut any, mut applied) = (false, 0);
		for candidate in candidates {
			let Some(file_lang) = lang.or_else(|| SupportLang::from_path(&candidate.path)) else {
				continue;
			};
			if !grammar_installed(file_lang) {
				continue;
			}
			let Ok(source) = vfs.read_to_string(&candidate.path).await else {
				continue;
			};
			self.compile_kind(host, &mut matchers, kind, file_lang)?;
			let (matcher, fixer) = &matchers[&file_lang];
			let found = match_rule(&source, file_lang, matcher, fixer.as_ref(), captures);
			if found.spans.is_empty() {
				continue;
			}
			any = true;
			if self.applies() {
				let changes = found.changes.as_deref().unwrap_or_default();
				if let Err(error) = vfs.write(&candidate.path, apply_changes(&source, changes)).await {
					let _ = writeln!(host.stderr, "ERROR: {}: {error}", candidate.display);
					continue;
				}
				applied += changes.len();
				continue;
			}
			let mut buffer = Vec::new();
			printer.file(&mut buffer, &found.view(&candidate.display, &source, file_lang));
			if out.write_all(&buffer).is_err() {
				break;
			}
			let _ = host.flush_output().await;
		}
		if applied > 0 {
			let _ = writeln!(host.stderr, "Applied {applied} changes");
		}
		Ok(any)
	}

	/// Compiles `kind` (and the rewrite) for `lang` once; a selector that does
	/// not parse is reported (exit status 8).
	fn compile_kind(&self, host: &mut Host, matchers: &mut KindMatchers, kind: &str, lang: SupportLang) -> Result<(), i32> {
		if matchers.contains_key(&lang) {
			return Ok(());
		}
		let matcher = kind_matcher(kind, lang).map_err(|cause| {
			Report {
				warning: false,
				title:   "Cannot parse kind as a valid selector.",
				help:    "Please refer to ast-grep's ESQuery selector guide.",
				link:    Some(ESQUERY_GUIDE),
				cause:   Some(cause),
			}
			.print(host);
			8
		})?;
		let fixer = match &self.rewrite {
			Some(template) => {
				Some(Fixer::from_str(template, &lang).map_err(|error| parse_pattern_error(host, error.to_string()))?)
			},
			None => None,
		};
		matchers.insert(lang, (matcher, fixer));
		Ok(())
	}

	/// `--debug-query`: the query's tree on stderr, as ast-grep prints it.
	fn print_debug_query(&self, host: &mut Host, format: DebugFormat, lang: SupportLang) {
		let Some(query) = self.pattern.as_deref().or(self.kind.as_deref()) else {
			return;
		};
		if !grammar_installed(lang) {
			return;
		}
		let text = match format {
			DebugFormat::Pattern if self.pattern.is_some() => format!("Debug Pattern:\n{}", debug::dump_pattern(query, lang)),
			DebugFormat::Pattern => return,
			DebugFormat::Ast => format!("Debug AST:\n{}", debug::dump_tree(query, lang, true)),
			DebugFormat::Cst => format!("Debug CST:\n{}", debug::dump_tree(query, lang, false)),
			DebugFormat::Sexp => format!("Debug Sexp:\n{}", debug::dump_sexp(query, lang)),
		};
		let _ = writeln!(host.stderr, "{text}");
	}

	async fn execute(&self, host: &mut Host) -> Result<bool, i32> {
		let lang = match (self.input.stdin, self.lang) {
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
		if let (Some(format), Some(lang)) = (self.debug_query, lang) {
			self.print_debug_query(host, format, lang);
		}
		let pattern = self.pattern.as_deref().unwrap_or_default();
		let has_error = match lang {
			Some(lang) if self.kind.is_none() => {
				match ops::compile_pattern(pattern, self.selector.as_deref(), &self.strictness(), lang) {
					Ok(pattern) => pattern.has_error(),
					Err(error) => return Err(parse_pattern_error(host, error.to_string())),
				}
			},
			_ => false,
		};
		let mut out = host.stdout_writer();
		let mut printer = Printer { mode: self.output(), ctx: self.context(), matched: false };
		let mut head = Vec::new();
		printer.before(&mut head);
		let _ = out.write_all(&head);
		let matched = match (&self.kind, lang) {
			(Some(kind), lang) => self.search_kind(host, kind, lang, &mut out, &mut printer).await?,
			(None, Some(lang)) if self.input.stdin => self.run_stdin(host, pattern, lang, &mut out, &mut printer).await?,
			_ if self.applies() => {
				let applied = self.apply_paths(host, pattern).await?;
				if applied > 0 {
					let _ = writeln!(host.stderr, "Applied {applied} changes");
				}
				applied > 0
			},
			_ => self.search_paths(host, pattern, &mut out, &mut printer).await?,
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

/// Reads all of stdin as UTF-8; reports a failure on stderr (exit status 1).
async fn read_stdin(host: &mut Host) -> Result<String, i32> {
	let mut bytes = Vec::new();
	let read = host.read_stdin_to_end(&mut bytes, usize::MAX).await.and_then(|_| {
		String::from_utf8(bytes).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "stream did not contain valid UTF-8"))
	});
	read.map_err(|error| {
		let _ = writeln!(host.stderr, "ERROR: {error}");
		1
	})
}

/// Whether `lang`'s grammar is available to parse with (linked in, or its
/// on-demand WebAssembly grammar installed).
fn grammar_installed(lang: SupportLang) -> bool {
	lang.wasm_grammar().is_none_or(|grammar| grammar.is_installed())
}

/// `--kind` matchers and rewrites, compiled per language.
type KindMatchers = HashMap<SupportLang, (RuleCore, Option<Fixer>)>;

/// The rule a `--kind` selector stands for in `lang`.
fn kind_matcher(kind: &str, lang: SupportLang) -> Result<RuleCore, String> {
	let yaml = format!("kind: {}", serde_json::Value::String(kind.to_owned()));
	let rule: SerializableRule = ast_grep_config::from_str(&yaml).map_err(|error| error.to_string())?;
	let rule = DeserializeEnv::new(lang).deserialize_rule(rule).map_err(|error| error.to_string())?;
	Ok(RuleCore::new(rule))
}

/// One source's matches of a rule, with their rewrites when it has a fixer.
struct RuleMatches {
	spans:    Vec<Span>,
	captures: Vec<Captures>,
	changes:  Option<Vec<Change>>,
}

impl RuleMatches {
	fn view<'a>(&'a self, path: &'a str, source: &'a str, language: SupportLang) -> FileOutput<'a> {
		FileOutput {
			path,
			source,
			language,
			matches: self
				.spans
				.iter()
				.enumerate()
				.map(|(index, span)| MatchRef { span, captures: self.captures.get(index) })
				.collect(),
			changes: self.changes.as_deref(),
		}
	}
}

/// Every match of `matcher` in `source`, outermost first, with `fixer`'s rewrites.
fn match_rule(source: &str, lang: SupportLang, matcher: &RuleCore, fixer: Option<&Fixer>, captures: bool) -> RuleMatches {
	let ast = lang.ast_grep(source);
	let mut found = RuleMatches { spans: Vec::new(), captures: Vec::new(), changes: fixer.map(|_| Vec::new()) };
	for matched in ast.root().find_all(matcher) {
		let span = Span::of(matched.get_node());
		if captures {
			found.captures.push(Captures::of(&matched));
		}
		if let (Some(fixer), Some(changes)) = (fixer, found.changes.as_mut()) {
			let edit = matched.replace_by(fixer);
			changes.push(Change {
				span:           span.clone(),
				before:         matched.text().into_owned(),
				after:          String::from_utf8_lossy(&edit.inserted_text).into_owned(),
				deleted_length: edit.deleted_length,
			});
		}
		found.spans.push(span);
	}
	found
}

/// ast-grep's scan `--report-style` values.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum ReportStyle {
	/// Output a richly formatted diagnostic, with source code previews.
	Rich,
	/// Output a condensed diagnostic, with a line number, severity, message and notes (if any).
	Medium,
	/// Output a short diagnostic, with a line number, severity, and message.
	Short,
}

#[derive(Args, Debug)]
struct Scan {
	/// Scan the codebase with the single rule located at the path RULE_FILE.
	#[arg(short, long, value_name = "RULE_FILE")]
	rule: Option<String>,

	/// Scan the codebase with rules defined by RULE_TEXT (separate rules with `---`).
	#[arg(long, conflicts_with = "rule", value_name = "RULE_TEXT")]
	inline_rules: Option<String>,

	/// Scan the codebase with the rules whose id matches REGEX.
	#[arg(long, value_name = "REGEX")]
	filter: Option<String>,

	/// Output warning/error messages in different styles.
	#[arg(long, default_value = "rich", conflicts_with = "json")]
	report_style: ReportStyle,

	/// Output matches in structured JSON.
	#[arg(
		long,
		value_name = "STYLE",
		num_args(0..=1),
		require_equals = true,
		default_missing_value = "pretty"
	)]
	json: Option<JsonStyle>,

	/// Include rule metadata in the json output.
	#[arg(long, requires = "json")]
	include_metadata: bool,

	/// Apply all rewrite without confirmation.
	#[arg(short = 'U', long)]
	update_all: bool,

	/// Only print the paths of files with at least one match.
	#[arg(long, conflicts_with_all = ["json", "update_all"])]
	files_with_matches: bool,

	/// Show at most NUM results and stop running once the limit is reached.
	#[arg(long, value_name = "NUM")]
	max_results: Option<u16>,

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

	#[command(flatten)]
	input: Input,
}

/// An `sgconfig.yml`: the rule, utility and test directories, relative to it.
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ProjectConfig {
	#[serde(default)]
	rule_dirs: Vec<PathBuf>,
	#[serde(default)]
	util_dirs: Option<Vec<PathBuf>>,
	#[serde(default)]
	test_configs: Option<Vec<TestConfig>>,
}

/// One `testConfigs` entry of an `sgconfig.yml`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestConfig {
	/// Directory of test case YAML files, relative to the project.
	test_dir:     PathBuf,
	/// Snapshot directory, relative to `test_dir`; `__snapshots__` by default.
	snapshot_dir: Option<PathBuf>,
}

/// A loaded `sgconfig.yml` project.
struct Project {
	/// The directory holding `sgconfig.yml`.
	root:   PathBuf,
	config: ProjectConfig,
	/// Every rule of the project's `ruleDirs`.
	rules:  Vec<RuleConfig<SupportLang>>,
}

/// Loads the project of `config` (by default the nearest `sgconfig.yml` at
/// or above the working directory): its configuration, utility rules and the
/// rules of its `ruleDirs`.
async fn load_project(host: &mut Host, config: Option<&str>) -> Result<Project, i32> {
	let cwd = host.resolve(".");
	let vfs = host.vfs();
	let config_path = match config {
		Some(config) => host.resolve(config),
		None => {
			let mut found = None;
			for dir in cwd.ancestors() {
				let candidate = dir.join(PROJECT_CONFIG);
				if vfs.metadata(&candidate).await.is_ok_and(|meta| meta.is_file()) {
					found = Some(candidate);
					break;
				}
			}
			let Some(found) = found else {
				return Err(fail(
					host,
					"No ast-grep project configuration is found.",
					"You need to create an ast-grep project for this command. Try `ast-grep new` to create one.",
					Some(PROJECT_GUIDE),
					None,
					3,
				));
			};
			found
		},
	};
	let text = read_text(
		host,
		&config_path,
		"Cannot read configuration.",
		"Please add an sgconfig.yml configuration file in the project root to run the scan command.",
	)
	.await?;
	let project: ProjectConfig = ast_grep_config::from_str(&text).map_err(|error| {
		fail(
			host,
			"Cannot parse configuration",
			"The sgconfig.yml is not a valid configuration file. Please refer to doc and fix the error.",
			Some(CONFIG_REFERENCE),
			Some(error.to_string()),
			8,
		)
	})?;
	let root = config_path.parent().map_or(cwd, Path::to_path_buf);
	let mut utils = Vec::new();
	for dir in project.util_dirs.iter().flatten() {
		for file in yaml_files(host, &root.join(dir), false).await? {
			let name = file.path.display().to_string();
			let text = read_text(host, &file.path, &format!("Cannot read rule {name}"), "The rule file either does not exist or cannot be opened.").await?;
			utils.push(ast_grep_config::from_str(&text).map_err(|error| {
				fail(host, &format!("Cannot parse rule {name}"), "The file is not a valid ast-grep rule. Please refer to doc and fix the error.", Some(CONFIG_GUIDE), Some(error.to_string()), 8)
			})?);
		}
	}
	let globals = DeserializeEnv::<SupportLang>::parse_global_utils(utils).map_err(|error| {
		fail(
			host,
			"Error occurs when parsing global utility rules",
			"Please check the YAML rules inside the rule directory",
			Some(UTILITY_RULE),
			Some(error.to_string()),
			8,
		)
	})?;
	let mut rules: Vec<RuleConfig<SupportLang>> = Vec::new();
	for dir in &project.rule_dirs {
		for file in yaml_files(host, &root.join(dir), false).await? {
			let name = file.path.display().to_string();
			let text = read_text(host, &file.path, &format!("Cannot read rule {name}"), "The rule file either does not exist or cannot be opened.").await?;
			rules.extend(parse_rules(host, &text, &name, &globals)?);
		}
	}
	let mut seen = HashSet::new();
	if let Some(duplicate) = rules.iter().filter(|rule| !rule.id.is_empty()).find(|rule| !seen.insert(rule.id.as_str())) {
		let title = format!("Duplicate rule id `{}` is found", duplicate.id);
		return Err(fail(
			host,
			&title,
			"Multiple rule files have the same id. Please add a unique `id` field to each rule.",
			Some(CONFIG_GUIDE),
			None,
			8,
		));
	}
	Ok(Project { root, config: project, rules })
}

/// Prints an ast-grep error report and returns its exit status.
fn fail(host: &mut Host, title: &str, help: &str, link: Option<&str>, cause: Option<String>, code: i32) -> i32 {
	Report { warning: false, title, help, link, cause }.print(host);
	code
}

/// The YAML files below `dir`, in path order, optionally following symlinks.
async fn yaml_files(host: &mut Host, dir: &Path, follow_links: bool) -> Result<Vec<Candidate>, i32> {
	let vfs = host.vfs();
	let options = Discover { hidden: true, gitignore: true, follow_links, ..Discover::default() };
	match search::discover(&vfs, dir, &options).await {
		Ok(found) => Ok(found
			.into_iter()
			.filter(|candidate| SupportLang::from_path(&candidate.path) == Some(SupportLang::Yaml))
			.collect()),
		Err(error) => Err(fail(
			host,
			&format!("Cannot read rule directory {}", dir.display()),
			"The rule directory cannot be read or traversed",
			None,
			Some(error.to_string()),
			6,
		)),
	}
}

/// Parses every rule document of `text` (read from `name`).
fn parse_rules(host: &mut Host, text: &str, name: &str, globals: &GlobalRules) -> Result<Vec<RuleConfig<SupportLang>>, i32> {
	from_yaml_string(text, globals).map_err(|error| {
		fail(
			host,
			&format!("Cannot parse rule {name}"),
			"The file is not a valid ast-grep rule. Please refer to doc and fix the error.",
			Some(CONFIG_GUIDE),
			Some(error.to_string()),
			8,
		)
	})
}

/// Reads `path`; reports `title` (exit status 6) when it cannot.
async fn read_text(host: &mut Host, path: &Path, title: &str, help: &str) -> Result<String, i32> {
	match host.vfs().read_to_string(path).await {
		Ok(text) => Ok(text),
		Err(error) => Err(fail(host, title, help, Some(CONFIG_GUIDE), Some(error.to_string()), 6)),
	}
}

/// One scan finding, ready to print.
struct Finding<'r> {
	rule:     &'r RuleConfig<SupportLang>,
	span:     Span,
	captures: Captures,
	message:  String,
	/// `(range, primary, message)` per label.
	labels:  Vec<(std::ops::Range<usize>, bool, Option<String>)>,
	/// The rule's fix applied to this match.
	change:  Option<Change>,
}

const fn severity_name(severity: &Severity) -> &'static str {
	match severity {
		Severity::Hint => "hint",
		Severity::Info => "info",
		Severity::Warning => "warning",
		Severity::Error => "error",
		Severity::Off => "off",
	}
}

impl Scan {
	fn context(&self) -> Context {
		if self.context > 0 {
			(self.context.into(), self.context.into())
		} else {
			(self.before.into(), self.after.into())
		}
	}

	/// The rules to run and the directory their `files`/`ignores` globs are
	/// relative to: `--rule`, `--inline-rules`, or the project's `ruleDirs`.
	async fn load_rules(&self, host: &mut Host, config: Option<&str>) -> Result<(Vec<RuleConfig<SupportLang>>, PathBuf), i32> {
		let cwd = host.resolve(".");
		if let Some(rule) = &self.rule {
			let path = host.resolve(rule);
			let text = read_text(
				host,
				&path,
				&format!("Cannot read rule {rule}"),
				"The rule file either does not exist or cannot be opened.",
			)
			.await?;
			let rules = parse_rules(host, &text, rule, &GlobalRules::default())?;
			return Ok((rules, path.parent().map_or(cwd, Path::to_path_buf)));
		}
		if let Some(text) = &self.inline_rules {
			return Ok((parse_rules(host, text, "INLINE_RULES", &GlobalRules::default())?, cwd));
		}
		let project = load_project(host, config).await?;
		Ok((project.rules, project.root))
	}

	/// The findings of `rules` in one source.
	fn findings<'r>(source: &str, lang: SupportLang, rules: &[&'r RuleConfig<SupportLang>]) -> Vec<Finding<'r>> {
		let ast = lang.ast_grep(source);
		let mut findings = Vec::new();
		for &rule in rules {
			let fixer = rule.get_fixer().ok().and_then(|fixers| fixers.into_iter().next());
			for matched in ast.root().find_all(&rule.matcher) {
				let span = Span::of(matched.get_node());
				let labels = rule
					.get_labels(&matched)
					.into_iter()
					.map(|label| (label.range(), matches!(label.style, LabelStyle::Primary), label.message.map(str::to_owned)))
					.collect();
				let change = fixer.as_ref().map(|fixer| {
					let edit = matched.replace_by(fixer);
					Change {
						span:           span.clone(),
						before:         matched.text().into_owned(),
						after:          String::from_utf8_lossy(&edit.inserted_text).into_owned(),
						deleted_length: edit.deleted_length,
					}
				});
				findings.push(Finding {
					rule,
					message: rule.get_message(&matched),
					captures: Captures::of(&matched),
					span,
					labels,
					change,
				});
			}
		}
		findings
	}

	/// Renders one file's findings in the selected output.
	fn print_findings(&self, out: &mut Vec<u8>, path: &str, source: &str, lang: SupportLang, findings: &[Finding<'_>], first: &mut bool) {
		if self.files_with_matches {
			let _ = writeln!(out, "{path}");
			return;
		}
		if let Some(style) = self.json {
			for finding in findings {
				match (style, *first) {
					(JsonStyle::Pretty, true) => out.push(b'\n'),
					(JsonStyle::Pretty, false) => out.extend_from_slice(b",\n"),
					(JsonStyle::Compact, false) => out.push(b','),
					_ => {},
				}
				*first = false;
				let matched = MatchJson {
					path,
					source,
					language: lang,
					span: &finding.span,
					captures: Some(&finding.captures),
					replacement: finding.change.as_ref(),
				};
				let Json::Obj(mut fields) = matched.to_json(self.context()) else {
					continue;
				};
				let rule = finding.rule;
				fields.push(("ruleId", Json::Str(rule.id.clone())));
				fields.push(("severity", Json::Str(severity_name(&rule.severity).to_owned())));
				fields.push(("note", rule.note.clone().map_or(Json::Null, Json::Str)));
				fields.push(("message", Json::Str(finding.message.clone())));
				let labels: Vec<Json> = finding
					.labels
					.iter()
					.map(|(range, primary, message)| {
						let span = span_of_range(source, range.clone());
						let mut label = vec![("text", Json::Str(source[range.clone()].to_owned())), ("range", range_json(&span))];
						if let Some(message) = message {
							label.push(("message", Json::Str(message.clone())));
						}
						label.push(("style", Json::Str(if *primary { "primary" } else { "secondary" }.to_owned())));
						Json::Obj(label)
					})
					.collect();
				if !labels.is_empty() {
					fields.push(("labels", Json::Arr(labels)));
				}
				if self.include_metadata
					&& let Some(metadata) = &rule.metadata
					&& let Ok(value) = serde_json::to_value(metadata)
				{
					fields.push(("metadata", Json::Value(value)));
				}
				Json::Obj(fields).write(out, style == JsonStyle::Pretty, 0);
				if style == JsonStyle::Stream {
					out.push(b'\n');
				}
			}
			return;
		}
		let file = SimpleFile::new(path.to_owned(), source);
		let (before, after) = self.context();
		let mut config = codespan::Config {
			display_style: match self.report_style {
				ReportStyle::Rich => DisplayStyle::Rich,
				ReportStyle::Medium => DisplayStyle::Medium,
				ReportStyle::Short => DisplayStyle::Short,
			},
			..codespan::Config::default()
		};
		config.start_context_lines = before;
		config.end_context_lines = after;
		let mut fixed_until = 0;
		for finding in findings {
			let rule = finding.rule;
			let note = rule.note.as_deref();
			let Some(change) = &finding.change else {
				let severity = match rule.severity {
					Severity::Error => CodeSeverity::Error,
					Severity::Warning => CodeSeverity::Warning,
					Severity::Info => CodeSeverity::Note,
					Severity::Hint | Severity::Off => CodeSeverity::Help,
				};
				let labels = finding
					.labels
					.iter()
					.map(|(range, primary, message)| {
						let label = if *primary {
							CodeLabel::primary((), range.clone())
						} else {
							CodeLabel::secondary((), range.clone())
						};
						match message {
							Some(message) => label.with_message(message),
							None => label,
						}
					})
					.collect();
				let diagnostic = Diagnostic::new(severity)
					.with_code(&rule.id)
					.with_message(&finding.message)
					.with_notes(note.into_iter().map(str::to_owned).collect())
					.with_labels(labels);
				let _ = codespan::emit_to_io_write(out, &config, &file, &diagnostic);
				continue;
			};
			// A rule with a fix shows the fix as a diff (ast-grep's `print_rule_diffs`).
			if change.span.start < fixed_until {
				continue;
			}
			fixed_until = change.span.end;
			let level = match rule.severity {
				Severity::Error => "error",
				Severity::Warning => "warning",
				Severity::Info => "note",
				Severity::Hint | Severity::Off => "help",
			};
			if self.report_style == ReportStyle::Rich {
				let _ = writeln!(out, "{path}");
			} else {
				let _ = write!(out, "{path}:{}:{}: ", change.span.start_pos.line + 1, change.span.start_pos.column + 1);
			}
			let _ = writeln!(out, "{level}[{}]: {}", rule.id, finding.message);
			if self.report_style == ReportStyle::Rich {
				let fixed = format!("{}{}{}", &source[..change.span.start], change.after, &source[change.span.end..]);
				print_diff_hunks(out, source, &fixed, if before == 0 { 3 } else { before });
			}
			if self.report_style != ReportStyle::Short
				&& let Some(note) = note
			{
				let _ = writeln!(out, "Note:\n{note}");
			}
		}
	}

	async fn execute(&self, host: &mut Host, config: Option<&str>) -> Result<bool, i32> {
		let (mut rules, root) = self.load_rules(host, config).await?;
		rules.retain(|rule| !matches!(rule.severity, Severity::Off));
		if let Some(filter) = &self.filter {
			let filter = regex::Regex::new(filter).map_err(|error| {
				fail(host, "Cannot parse the rule filter", "--filter must be a valid regular expression.", Some(CLI_USAGE), Some(error.to_string()), 8)
			})?;
			rules.retain(|rule| filter.is_match(&rule.id));
		}
		if self.input.stdin {
			let languages: Vec<SupportLang> = rules.iter().map(|rule| rule.language).collect();
			let Some(&lang) = languages.first().filter(|lang| languages.iter().all(|other| other == *lang)) else {
				return Err(fail(
					host,
					"Rules must use one language to scan code from StdIn.",
					"Select rules of a single language with --rule, --inline-rules or --filter.",
					Some(TOOL_OVERVIEW),
					None,
					3,
				));
			};
			let source = read_stdin(host).await?;
			let selected: Vec<&RuleConfig<SupportLang>> = rules.iter().collect();
			let findings = Self::findings(&source, lang, &selected);
			return self.report(host, vec![(STDIN_PATH.to_owned(), PathBuf::new(), source, lang, findings)]).await;
		}
		let collection = RuleCollection::try_new(rules).map_err(|error| {
			fail(
				host,
				"Cannot parse glob pattern in config",
				"The pattern in files/ignore is not a valid glob. Please refer to doc and fix the error.",
				Some(CONFIG_GUIDE),
				Some(error.to_string()),
				9,
			)
		})?;
		let candidates = self.input.candidates(host, None).await?;
		let vfs = host.vfs();
		let mut files = Vec::new();
		let mut budget = self.max_results.map_or(usize::MAX, usize::from);
		for candidate in candidates {
			if budget == 0 {
				break;
			}
			let relative = candidate.path.strip_prefix(&root).unwrap_or(Path::new(&candidate.display));
			let rules = collection.for_path(relative);
			let Some(lang) = rules.first().map(|rule| rule.language) else {
				continue;
			};
			if !grammar_installed(lang) {
				continue;
			}
			let Ok(source) = vfs.read_to_string(&candidate.path).await else {
				continue;
			};
			let mut findings = Self::findings(&source, lang, &rules);
			if findings.is_empty() {
				continue;
			}
			findings.truncate(budget);
			budget -= findings.len();
			files.push((candidate.display, candidate.path, source, lang, findings));
		}
		self.report(host, files).await
	}

	/// Prints (or with `-U` applies) every file's findings; exit status 1
	/// with ast-grep's report when an error-level rule matched.
	async fn report(
		&self,
		host: &mut Host,
		files: Vec<(String, PathBuf, String, SupportLang, Vec<Finding<'_>>)>,
	) -> Result<bool, i32> {
		let errors: usize = files
			.iter()
			.flat_map(|(.., findings)| findings)
			.filter(|finding| matches!(finding.rule.severity, Severity::Error))
			.count();
		if self.update_all {
			let vfs = host.vfs();
			let mut applied = 0;
			for (display, path, source, _, findings) in &files {
				let mut changes: Vec<Change> = findings.iter().filter_map(|finding| finding.change.clone()).collect();
				changes.sort_by_key(|change| change.span.start);
				if changes.is_empty() {
					continue;
				}
				let fixed = apply_changes(source, &changes);
				if display == STDIN_PATH {
					let _ = writeln!(host.stdout_writer(), "{fixed}");
				} else if let Err(error) = vfs.write(path, fixed).await {
					let _ = writeln!(host.stderr, "ERROR: {display}: {error}");
					continue;
				}
				applied += changes.len();
			}
			if applied > 0 {
				let _ = writeln!(host.stderr, "Applied {applied} changes");
			}
		} else {
			let mut out = host.stdout_writer();
			let mut buffer = Vec::new();
			let array = matches!(self.json, Some(JsonStyle::Pretty | JsonStyle::Compact));
			if array {
				buffer.push(b'[');
			}
			let mut first = true;
			for (display, _, source, lang, findings) in &files {
				self.print_findings(&mut buffer, display, source, *lang, findings, &mut first);
				if out.write_all(&buffer).is_err() {
					break;
				}
				buffer.clear();
			}
			if array {
				if self.json == Some(JsonStyle::Pretty) && !first {
					buffer.push(b'\n');
				}
				buffer.extend_from_slice(b"]\n");
			}
			let _ = out.write_all(&buffer);
			let _ = out.flush();
			let _ = host.flush_output().await;
		}
		if errors > 0 && !self.update_all {
			return Err(fail(
				host,
				&format!("{errors} error(s) found in code."),
				"Scan succeeded and found error level diagnostics in the codebase.",
				None,
				None,
				1,
			));
		}
		Ok(true)
	}
}

/// The span `range` covers in `source`, with line and character-column positions.
fn span_of_range(source: &str, range: std::ops::Range<usize>) -> Span {
	let position = |offset: usize| {
		let before = &source[..offset];
		let line_start = before.rfind('\n').map_or(0, |index| index + 1);
		omp_ast::search::Pos { line: before.matches('\n').count(), column: source[line_start..offset].chars().count() }
	};
	Span { start: range.start, end: range.end, start_pos: position(range.start), end_pos: position(range.end) }
}

/// ast-grep outline's `--items` values.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum OutlineItems {
	/// Use `structure` for file or stdin input, `exports` when any directory is given.
	Auto,
	/// Top-level items defined locally in the file, excluding imports.
	Structure,
	/// Top-level items exported from the file or module.
	Exports,
	/// Top-level items imported from other files or modules.
	Imports,
	/// All top-level items, including imports and exports.
	All,
}

/// ast-grep outline's `--view` values.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum OutlineView {
	/// Use `digest` for file or stdin input, `names` when any directory is given.
	Auto,
	/// One grouped name line per symbol type for each file.
	Names,
	/// One source/signature line per top-level item.
	Signatures,
	/// Signatures plus compact member name digests.
	Digest,
	/// Signatures plus one source/signature line per direct member.
	Expanded,
}

#[derive(Args, Debug)]
struct Outline {
	/// Specify the input language (required for stdin).
	#[arg(short, long, value_parser = parse_lang)]
	lang: Option<SupportLang>,

	/// Output outline entries in structured JSON.
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

	/// Select which top-level items to include.
	#[arg(long, default_value = "auto", value_name = "ITEMS")]
	items: OutlineItems,

	/// Keep only top-level items with these comma-separated symbol types.
	#[arg(long = "type", value_name = "TYPE[,TYPE...]")]
	symbol_type: Option<String>,

	/// Keep only top-level items matching this regex.
	#[arg(long = "match", value_name = "REGEX")]
	match_item: Option<String>,

	/// Display only public members in member views.
	#[arg(long)]
	pub_members: bool,

	/// Select the text presentation.
	#[arg(long, default_value = "auto", value_name = "VIEW")]
	view: OutlineView,

	#[command(flatten)]
	input: Input,
}

/// One file's outline as ast-grep's JSON prints it.
#[derive(serde::Serialize)]
struct OutlineFile<'a> {
	path:     &'a str,
	language: String,
	items:    Vec<outline::Item>,
}

/// Names grouped by symbol type in [`SymbolType::ORDER`], each with its
/// occurrence count.
fn grouped_names<'a>(entries: impl Iterator<Item = &'a outline::Entry>) -> Vec<(SymbolType, Vec<(&'a str, usize)>)> {
	let mut groups: Vec<(SymbolType, Vec<(&'a str, usize)>)> = SymbolType::ORDER.iter().map(|symbol| (*symbol, Vec::new())).collect();
	for entry in entries {
		let Some((_, names)) = groups.iter_mut().find(|(symbol, _)| *symbol == entry.symbol_type) else {
			continue;
		};
		match names.iter_mut().find(|(name, _)| *name == entry.name) {
			Some((_, count)) => *count += 1,
			None => names.push((entry.name.as_str(), 1)),
		}
	}
	groups.retain(|(_, names)| !names.is_empty());
	groups
}

fn names_line(symbol: SymbolType, names: &[(&str, usize)]) -> String {
	let names: Vec<String> = names
		.iter()
		.map(|(name, count)| if *count == 1 { (*name).to_owned() } else { format!("{name} ×{count}") })
		.collect();
	format!("{}: {}", symbol.name(), names.join(", "))
}

fn signature_or_name(entry: &outline::Entry) -> &str {
	if entry.signature.is_empty() { &entry.name } else { &entry.signature }
}

impl Outline {
	/// The outline of one source, filtered by `--items`, `--type` and `--match`.
	fn items(&self, source: &str, lang: SupportLang, items: OutlineItems, view: OutlineView, types: Option<&[SymbolType]>, matcher: Option<&regex::Regex>) -> Vec<outline::Item> {
		let mut found = outline::outline(source, lang);
		found.retain(|item| match items {
			OutlineItems::Structure => !item.is_import,
			OutlineItems::Exports => item.is_exported,
			OutlineItems::Imports => item.is_import,
			OutlineItems::All | OutlineItems::Auto => true,
		});
		if let Some(types) = types {
			found.retain(|item| types.contains(&item.entry.symbol_type));
		}
		if let Some(matcher) = matcher {
			found.retain(|item| matcher.is_match(&item.entry.name) || matcher.is_match(&item.entry.signature));
		}
		for item in &mut found {
			if !matches!(view, OutlineView::Digest | OutlineView::Expanded) {
				item.members.clear();
			} else if self.pub_members {
				item.members.retain(|member| member.is_public);
			}
		}
		found
	}

	fn print_text(out: &mut Vec<u8>, path: &str, items: &[outline::Item], view: OutlineView, first: bool) {
		if !first {
			out.push(b'\n');
		}
		let _ = writeln!(out, "{path}");
		if items.is_empty() {
			let _ = writeln!(out, "nothing found");
			return;
		}
		let width = items
			.iter()
			.flat_map(|item| std::iter::once(&item.entry).chain(item.members.iter().map(|member| &member.entry)))
			.map(|entry| entry.range.start.line + 1)
			.max()
			.unwrap_or(1)
			.to_string()
			.len();
		if view == OutlineView::Names {
			for (symbol, names) in grouped_names(items.iter().map(|item| &item.entry)) {
				let _ = writeln!(out, "{}", names_line(symbol, &names));
			}
			return;
		}
		for item in items {
			let _ = writeln!(out, "{:>width$}: {}", item.entry.range.start.line + 1, signature_or_name(&item.entry));
			match view {
				OutlineView::Digest => {
					let public = item.members.iter().filter(|member| member.is_public);
					let private = item.members.iter().filter(|member| !member.is_public);
					for (symbol, names) in grouped_names(public.chain(private).map(|member| &member.entry)) {
						let _ = writeln!(out, "{}{}", " ".repeat(width + 4), names_line(symbol, &names));
					}
				},
				OutlineView::Expanded => {
					for member in &item.members {
						let _ = writeln!(out, "{:>width$}:   {}", member.entry.range.start.line + 1, signature_or_name(&member.entry));
					}
				},
				_ => {},
			}
		}
	}

	async fn execute(&self, host: &mut Host) -> Result<bool, i32> {
		if self.input.stdin && self.lang.is_none() {
			return Err(fail(
				host,
				"Language must be specified for code from StdIn.",
				"Please use `--lang` to specify the code language.",
				Some(TOOL_OVERVIEW),
				None,
				3,
			));
		}
		let types = match &self.symbol_type {
			Some(raw) => {
				let mut types = Vec::new();
				for name in raw.split(',') {
					let Some(symbol) = SymbolType::parse(name.trim()) else {
						return Err(fail(host, &format!("Unknown outline symbol type `{}`", name.trim()), "Use a symbol type such as class, function, method or variable.", Some(CLI_USAGE), None, 2));
					};
					types.push(symbol);
				}
				Some(types)
			},
			None => None,
		};
		let matcher = match self.match_item.as_deref().map(regex::Regex::new).transpose() {
			Ok(matcher) => matcher,
			Err(error) => {
				return Err(fail(host, "Cannot parse outline item matcher", "--match must be a valid regular expression.", Some(CLI_USAGE), Some(error.to_string()), 2));
			},
		};
		let vfs = host.vfs();
		let mut has_directory = false;
		if !self.input.stdin {
			for operand in &self.input.paths {
				has_directory |= vfs.metadata(host.resolve(operand)).await.is_ok_and(|meta| meta.is_dir());
			}
		}
		let items = match (self.items, has_directory) {
			(OutlineItems::Auto, true) => OutlineItems::Exports,
			(OutlineItems::Auto, false) => OutlineItems::Structure,
			(items, _) => items,
		};
		let view = match (self.view, has_directory) {
			(OutlineView::Auto, true) => OutlineView::Names,
			(OutlineView::Auto, false) => OutlineView::Digest,
			(view, _) => view,
		};
		let mut files: Vec<(String, SupportLang, Vec<outline::Item>)> = Vec::new();
		if let (true, Some(lang)) = (self.input.stdin, self.lang) {
			let source = read_stdin(host).await?;
			if grammar_installed(lang) {
				files.push((STDIN_PATH.to_owned(), lang, self.items(&source, lang, items, view, types.as_deref(), matcher.as_ref())));
			}
		} else {
			for candidate in self.input.candidates(host, self.lang).await? {
				let Some(lang) = self.lang.or_else(|| SupportLang::from_path(&candidate.path)) else {
					continue;
				};
				if !grammar_installed(lang) {
					continue;
				}
				let Ok(source) = vfs.read_to_string(&candidate.path).await else {
					continue;
				};
				let found = self.items(&source, lang, items, view, types.as_deref(), matcher.as_ref());
				if found.is_empty() && has_directory {
					continue;
				}
				files.push((candidate.display, lang, found));
			}
		}
		let mut out = host.stdout_writer();
		let mut buffer = Vec::new();
		match self.json {
			None => {
				for (index, (path, _, found)) in files.iter().enumerate() {
					Self::print_text(&mut buffer, path, found, view, index == 0);
				}
				if files.is_empty() {
					let _ = writeln!(buffer, "nothing found");
				}
			},
			Some(style) => {
				for (index, (path, lang, found)) in files.into_iter().enumerate() {
					let file = OutlineFile { path: &path, language: lang.to_string(), items: found };
					match style {
						JsonStyle::Pretty => {
							buffer.extend_from_slice(if index == 0 { b"[\n" } else { b",\n" });
							let object = serde_json::to_string_pretty(&file).unwrap_or_default();
							for line in object.lines() {
								let _ = writeln!(buffer, "  {line}");
							}
						},
						JsonStyle::Compact => {
							buffer.push(if index == 0 { b'[' } else { b',' });
							let _ = serde_json::to_writer(&mut buffer, &file);
						},
						JsonStyle::Stream => {
							let _ = serde_json::to_writer(&mut buffer, &file);
							buffer.push(b'\n');
						},
					}
				}
				match style {
					JsonStyle::Pretty if buffer.is_empty() => buffer.extend_from_slice(b"[]\n"),
					JsonStyle::Pretty => buffer.extend_from_slice(b"]\n"),
					JsonStyle::Compact if buffer.is_empty() => buffer.extend_from_slice(b"[]\n"),
					JsonStyle::Compact => buffer.extend_from_slice(b"]\n"),
					JsonStyle::Stream => {},
				}
			},
		}
		let _ = out.write_all(&buffer);
		let _ = out.flush();
		let _ = host.flush_output().await;
		Ok(true)
	}
}

impl AsyncUtility for AstGrep {
	const NAME: &'static str = "ast-grep";
	const USAGE_ERROR: u8 = 2;

	/// Rejects ast-grep features the builtin does not implement and makes
	/// `run` the default command, as ast-grep does when no command is given.
	fn rewrite_argv(mut argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		if let Some(feature) = unsupported_feature(argv.iter().skip(1).map(|arg| arg.to_str())) {
			return Err(format!("{feature} is not supported by the built-in ast-grep"));
		}
		let first = argv.get(1).and_then(|arg| arg.to_str());
		if command_index(&argv).is_none() && !matches!(first, Some("-h" | "--help" | "-V" | "--version")) {
			argv.insert(1, "run".into());
		}
		Ok(argv)
	}

	async fn run(self, host: &mut Host) -> i32 {
		let config = self.config.as_deref();
		let result = match &self.command {
			Command::Run(run) => run.execute(host).await,
			Command::Scan(scan) => scan.execute(host, config).await,
			Command::Test(test) => test.execute(host, config).await,
			Command::Outline(outline) => outline.execute(host).await,
		};
		match result {
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

	#[test]
	fn preview_preserves_unicode_and_unterminated_lines() {
		let mut out = Vec::new();
		print_diff(&mut out, "file", "α\n古", "α\n新", 3);
		assert_eq!(
			String::from_utf8(out).unwrap(),
			"file\n@@ -0,2 +0,2 @@\n1 1│ α\n2  │-古  2│+新"
		);
	}

	#[test]
	fn preview_numbers_empty_sides_and_zero_context_hunks() {
		let mut out = Vec::new();
		print_diff(&mut out, "file", "", "α\n", 0);
		assert_eq!(String::from_utf8(out).unwrap(), "file\n@@ -0,0 +0,1 @@\n  1│+α\n");

		let mut out = Vec::new();
		print_diff(&mut out, "file", "old\nsame\nlast\n", "new\nsame\nend\n", 0);
		assert_eq!(
			String::from_utf8(out).unwrap(),
			"file\n@@ -0,1 +0,1 @@\n1  │-old\n  1│+new\n@@ -2,1 +2,1 @@\n3  │-last\n  3│+end\n"
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
		assert_eq!(run(&tree, &["lsp"]).await, (2, String::new(), "ast-grep: lsp is not supported by the built-in ast-grep\n".to_owned()));
		assert_eq!(
			run(&tree, &["test", "-i"]).await,
			(2, String::new(), "ast-grep: --interactive is not supported by the built-in ast-grep\n".to_owned())
		);
		assert_eq!(
			run(&tree, &["run", "-p", "foo", "--interactive", "a.rs"]).await,
			(2, String::new(), "ast-grep: --interactive is not supported by the built-in ast-grep\n".to_owned())
		);
	}

	const NO_FOO: &str = "id: no-foo\nlanguage: Rust\nseverity: error\nmessage: Avoid foo\nrule:\n  pattern: foo($$$A)\n";

	#[tokio::test(flavor = "multi_thread")]
	async fn scan_reports_inline_rule_matches_and_fails_on_errors() {
		let tree = tree();
		let (code, out, err) = run(&tree, &["scan", "--inline-rules", NO_FOO, "--report-style", "short", "a.rs", "b.rs"]).await;
		assert_eq!(
			(code, out.as_str()),
			(1, "a.rs:2:13: error[no-foo]: Avoid foo\na.rs:4:13: error[no-foo]: Avoid foo\nb.rs:2:5: error[no-foo]: Avoid foo\n"),
			"{err}"
		);
		assert!(err.starts_with("Error: 3 error(s) found in code."), "{err}");

		let warning = NO_FOO.replace("severity: error", "severity: warning");
		let (code, out, err) = run(&tree, &["scan", "--inline-rules", &warning, "b.rs"]).await;
		assert_eq!(code, 0, "{err}");
		assert!(out.starts_with("warning[no-foo]: Avoid foo\n"), "{out}");
		assert!(out.contains("┌─ b.rs:2:5"), "{out}");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn scan_loads_rules_from_the_project_config() {
		let tree = tree();
		std::fs::write(tree.path().join("sgconfig.yml"), "ruleDirs:\n  - rules\n").unwrap();
		std::fs::create_dir(tree.path().join("rules")).unwrap();
		std::fs::write(tree.path().join("rules").join("no-foo.yml"), NO_FOO).unwrap();
		let (code, out, err) = run(&tree, &["scan", "--report-style=short", "b.rs"]).await;
		assert_eq!((code, out.as_str()), (1, "b.rs:2:5: error[no-foo]: Avoid foo\n"), "{err}");
		let (code, out, err) = run(&tree, &["scan", "--json=compact", "b.rs"]).await;
		assert_eq!(code, 1, "{err}");
		assert!(out.contains(r#""ruleId":"no-foo","severity":"error","note":null,"message":"Avoid foo""#), "{out}");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn run_matches_an_esquery_kind() {
		let tree = tree();
		let (code, out, err) = run(&tree, &["run", "-k", "call_expression", "-l", "rust", "b.rs"]).await;
		assert_eq!((code, out.as_str()), (0, "b.rs:2:    foo(3)\n"), "{err}");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn debug_query_prints_the_pattern_tree_to_stderr() {
		let tree = tree();
		let (code, _, err) = run(&tree, &["run", "-p", "foo($A)", "-l", "rust", "--debug-query=ast", "b.rs"]).await;
		assert_eq!(code, 0, "{err}");
		assert!(err.starts_with("Debug AST:\nsource_file (0,0)-"), "{err}");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn outline_prints_a_file_digest() {
		let tree = tree();
		assert_eq!(run(&tree, &["outline", "a.rs"]).await, (0, "a.rs\n1: fn main()\n".to_owned(), String::new()));
		assert_eq!(run(&tree, &["outline", "--view", "names", "a.rs", "b.rs"]).await.1, "a.rs\nfunction: main\n\nb.rs\nfunction: g\n");
	}

	const NO_BAR: &str = "id: no-bar\nlanguage: Rust\nmessage: Avoid bar\nrule:\n  pattern: bar($A)\nfix: baz($A)\n";
	const NO_FOO_SNAPSHOT: &str =
		"id: no-foo\nsnapshots:\n  foo(1);:\n    labels:\n    - source: foo(1)\n      style: primary\n      start: 0\n      end: 6\n";
	const NO_BAR_SNAPSHOT: &str = "id: no-bar\nsnapshots:\n  \"fn x() {\\n  bar(1);\\n}\":\n    fixed: |-\n      fn x() {\n        \
	                               baz(1);\n      }\n    labels:\n    - source: bar(1)\n      style: primary\n      start: 11\n      \
	                               end: 17\n";
	const MISMATCH_HELP: &str = "Help: Test failed due to mismatching snapshots. Run with `--update-all` to update all snapshots, or \
	                             `--interactive` to update selectively.\nSee also: https://ast-grep.github.io/guide/test-rule.html\n\n";

	/// An ast-grep project with the `no-foo` and `no-bar` rules and a test
	/// case for each, without snapshots.
	fn test_project() -> tempfile::TempDir {
		let tree = tempfile::tempdir().unwrap();
		let path = tree.path();
		std::fs::write(path.join("sgconfig.yml"), "ruleDirs:\n  - rules\ntestConfigs:\n  - testDir: tests\n").unwrap();
		std::fs::create_dir(path.join("rules")).unwrap();
		std::fs::write(path.join("rules").join("no-foo.yml"), NO_FOO).unwrap();
		std::fs::write(path.join("rules").join("no-bar.yml"), NO_BAR).unwrap();
		std::fs::create_dir(path.join("tests")).unwrap();
		std::fs::write(path.join("tests").join("no-foo-test.yml"), "id: no-foo\nvalid:\n  - let a = 1;\ninvalid:\n  - foo(1);\n").unwrap();
		std::fs::write(path.join("tests").join("no-bar-test.yml"), "id: no-bar\ninvalid:\n  - \"fn x() {\\n  bar(1);\\n}\"\n").unwrap();
		tree
	}

	/// Writes `snapshot` as the `id` rule's snapshot file.
	fn write_snapshot(tree: &tempfile::TempDir, id: &str, snapshot: &str) {
		let dir = tree.path().join("tests").join("__snapshots__");
		std::fs::create_dir_all(&dir).unwrap();
		std::fs::write(dir.join(format!("{id}-snapshot.yml")), snapshot).unwrap();
	}

	/// A rule test suite whose snapshots match must pass instead of being
	/// rejected or reporting spurious failures.
	#[tokio::test(flavor = "multi_thread")]
	async fn test_passes_with_matching_snapshots() {
		let tree = test_project();
		write_snapshot(&tree, "no-foo", NO_FOO_SNAPSHOT);
		write_snapshot(&tree, "no-bar", NO_BAR_SNAPSHOT);
		assert_eq!(
			run(&tree, &["test"]).await,
			(
				0,
				"Running 2 tests\n\n----------- Case Details -----------\nPASS no-bar  .\nPASS no-foo  ..\n\ntest result: ok. 2 \
				 passed; 0 failed;\n"
					.to_owned(),
				String::new()
			)
		);
	}

	/// `--update-all` must write missing snapshots in ast-grep's YAML so they
	/// stay byte-identical to the ones the real tool commits.
	#[tokio::test(flavor = "multi_thread")]
	async fn test_update_all_writes_missing_snapshots() {
		let tree = test_project();
		assert_eq!(
			run(&tree, &["test", "-U"]).await,
			(
				0,
				"Running 2 tests\n\n----------- Case Details -----------\n[Updated] Rule no-bar's snapshot baseline has been \
				 updated.\n\n  fn x() {\n    bar(1);\n  }\n\n[Updated] Rule no-foo's snapshot baseline has been updated.\n\n  \
				 foo(1);\n\nPASS no-bar  U\nPASS no-foo  .U\n\ntest result: ok. 2 passed; 0 failed;\n"
					.to_owned(),
				String::new()
			)
		);
		let snapshots = tree.path().join("tests").join("__snapshots__");
		assert_eq!(std::fs::read_to_string(snapshots.join("no-foo-snapshot.yml")).unwrap(), NO_FOO_SNAPSHOT);
		assert_eq!(std::fs::read_to_string(snapshots.join("no-bar-snapshot.yml")).unwrap(), NO_BAR_SNAPSHOT);
	}

	/// A snapshot that differs from what the rule reports must fail with the
	/// YAML diff and the snapshot-mismatch error (exit status 4).
	#[tokio::test(flavor = "multi_thread")]
	async fn test_reports_snapshot_mismatch_diff() {
		let tree = test_project();
		write_snapshot(&tree, "no-foo", &NO_FOO_SNAPSHOT.replace("end: 6", "end: 7"));
		assert_eq!(
			run(&tree, &["test", "-f", "foo"]).await,
			(
				4,
				"Running 1 tests\n\n----------- Case Details -----------\n[Wrong] no-foo snapshot is different from \
				 baseline.\nDiff:\n@@ -1,4 +1,4 @@\n2 2│ - source: foo(1)\n3 3│   style: primary\n4 4│   start: 0\n5  │-  end: \
				 7\n  5│+  end: 6\nFor Code:\n  foo(1);\n\nFAIL no-foo  .W\n\n"
					.to_owned(),
				format!("Error: test failed. 0 passed; 1 failed;\n{MISMATCH_HELP}")
			)
		);
	}

	/// Noisy valid code, missing reports and test cases without a rule must
	/// each fail the run with ast-grep's details and errors.
	#[tokio::test(flavor = "multi_thread")]
	async fn test_fails_on_noisy_missing_and_unmatched_cases() {
		let tree = test_project();
		std::fs::write(
			tree.path().join("tests").join("no-foo-test.yml"),
			"id: no-foo\nvalid:\n  - foo(2);\ninvalid:\n  - let b = 2;\n---\nid: ghost\nvalid: [a]\n",
		)
		.unwrap();
		assert_eq!(
			run(&tree, &["test", "--skip-snapshot-tests"]).await,
			(
				4,
				"Running 3 tests\nConfiguration not found! ghost\n\n----------- Case Details -----------\n[Noisy] Expect no-foo to \
				 report no issue, but some issues found in:\n\n  foo(2);\n\n[Missing] Expect rule no-foo to report issues, but \
				 none found in:\n\n  let b = 2;\n\nPASS no-bar  .\nFAIL no-foo  NM\n\ntest failed. 1 passed; 1 failed;\n"
					.to_owned(),
				"Error: 1 test case(s) matched no rule.\nHelp: You can use ast-grep playground to debug your rules and test \
				 cases.\nSee also: https://ast-grep.github.io/playground.html\n\n"
					.to_owned()
			)
		);
	}
}
