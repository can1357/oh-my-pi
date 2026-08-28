//! `diff` builtin: compare files line by line using the `similar` library.
//!
//! Ported from `pi-uu-diff` 0.8.0, extended toward GNU diff: normal output by
//! default, unified (`-u`/`-U`) and context (`-c`/`-C`) formats, whitespace and
//! case ignore flags, `-x` exclusion globs, and `-r`-gated directory recursion.

use std::{
	borrow::Cow,
	collections::BTreeSet,
	ffi::{OsStr, OsString},
	fs,
	io::{Read, Write},
	ops::Range,
	path::{Path, PathBuf},
	time::SystemTime,
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{ArgAction, Parser};
use similar::{Algorithm, DiffOp, DiffTag, capture_diff_slices};

use crate::host::{Host, Utility, util};

/// Parsed `diff` invocation.
#[derive(Parser)]
#[command(
	name = "diff",
	version = "diff (pi-uu-diff) 0.8.0",
	about = "Compare files line by line.",
	override_usage = "diff [OPTION]... FILE1 FILE2",
	infer_long_args = true
)]
pub(crate) struct Diff {
	/// Output 3 lines of unified context.
	#[arg(short = 'u', action = ArgAction::SetTrue)]
	unified_flag: bool,

	/// Output NUM lines of unified context.
	#[arg(short = 'U', long = "unified", value_name = "NUM")]
	unified: Option<usize>,

	/// Output 3 lines of copied context.
	#[arg(short = 'c', action = ArgAction::SetTrue, conflicts_with_all = ["unified_flag", "unified"])]
	context_flag: bool,

	/// Output NUM lines of copied context.
	#[arg(
		short = 'C',
		long = "context",
		value_name = "NUM",
		conflicts_with_all = ["unified_flag", "unified"]
	)]
	context: Option<usize>,

	/// Report only when files differ.
	#[arg(short = 'q', long = "brief", action = ArgAction::SetTrue)]
	brief: bool,

	/// Report when two files are identical.
	#[arg(short = 's', long = "report-identical-files", action = ArgAction::SetTrue)]
	report_identical: bool,

	/// Recursively compare any subdirectories found.
	#[arg(short = 'r', long = "recursive", action = ArgAction::SetTrue)]
	recursive: bool,

	/// Treat absent files as empty.
	#[arg(short = 'N', long = "new-file", action = ArgAction::SetTrue)]
	new_file: bool,

	/// Ignore case differences in file contents.
	#[arg(short = 'i', long = "ignore-case", action = ArgAction::SetTrue)]
	ignore_case: bool,

	/// Ignore all white space.
	#[arg(short = 'w', long = "ignore-all-space", action = ArgAction::SetTrue)]
	ignore_all_space: bool,

	/// Ignore changes in the amount of white space.
	#[arg(short = 'b', long = "ignore-space-change", action = ArgAction::SetTrue)]
	ignore_space_change: bool,

	/// Ignore changes whose lines are all blank.
	#[arg(short = 'B', long = "ignore-blank-lines", action = ArgAction::SetTrue)]
	ignore_blank_lines: bool,

	/// Strip trailing carriage return on input.
	#[arg(long = "strip-trailing-cr", action = ArgAction::SetTrue)]
	strip_trailing_cr: bool,

	/// Exclude files whose base names match the PAT glob (directory diffs).
	#[arg(short = 'x', long = "exclude", value_name = "PAT", action = ArgAction::Append)]
	exclude: Vec<String>,

	/// Use LABEL instead of a file name and timestamp in headers (may be
	/// given twice: first for FILE1, second for FILE2).
	#[arg(short = 'L', long = "label", value_name = "LABEL", action = ArgAction::Append)]
	labels: Vec<OsString>,

	/// Accepted for compatibility; output is never colorized.
	#[arg(
		long = "color",
		value_name = "WHEN",
		num_args = 0..=1,
		require_equals = true,
		default_missing_value = "auto"
	)]
	_color: Option<String>,

	/// Files or directories to compare.
	#[arg(required = true, num_args = 2, value_hint = clap::ValueHint::AnyPath)]
	files: Vec<OsString>,
}

/// Selected output style. Real diff emits normal format unless a unified or
/// context option is given.
#[derive(Clone, Copy)]
enum Format {
	Normal,
	Unified(usize),
	Context(usize),
}

#[derive(Clone, Copy)]
struct Options<'a> {
	format:              Format,
	brief:               bool,
	report_identical:    bool,
	recursive:           bool,
	new_file:            bool,
	ignore_case:         bool,
	ignore_all_space:    bool,
	ignore_space_change: bool,
	ignore_blank_lines:  bool,
	strip_trailing_cr:   bool,
	labels:              &'a [OsString],
	excludes:            &'a [glob::Pattern],
}

/// A classified operand and its resolved filesystem path.
enum Operand {
	/// The builtin's standard input (`-`).
	Stdin,
	/// A regular (or other non-directory) file at the resolved path.
	File(PathBuf),
	/// A directory at the resolved path.
	Dir(PathBuf),
	/// A missing file tolerated by `-N` and compared as empty.
	Absent,
}

impl Utility for Diff {
	const NAME: &'static str = "diff";
	const USAGE_ERROR: u8 = 2;

	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		let mut out = Vec::with_capacity(argv.len());
		let mut iter = argv.into_iter();
		if let Some(name) = iter.next() {
			out.push(name);
		}
		let mut past_separator = false;
		for arg in iter {
			if !past_separator {
				if arg == "--" {
					past_separator = true;
				} else if let Some(rewritten) = rewrite_obsolete_count(&arg) {
					out.push(rewritten);
					continue;
				}
			}
			out.push(arg);
		}
		Ok(out)
	}

	fn run(self, host: &mut Host) -> i32 {
		if self.labels.len() > 2 {
			host.error("too many file label options", 2);
			return 2;
		}
		// Compile `-x` globs once; a syntactically invalid glob falls back to a
		// literal name match, like fnmatch treating a bad bracket literally.
		let excludes: Vec<glob::Pattern> = self
			.exclude
			.iter()
			.map(|pat| {
				glob::Pattern::new(pat).unwrap_or_else(|_| {
					glob::Pattern::new(&glob::Pattern::escape(pat))
						.expect("escaped pattern always compiles")
				})
			})
			.collect();
		let format = if let Some(num) = self.unified {
			Format::Unified(num)
		} else if self.unified_flag {
			Format::Unified(3)
		} else if let Some(num) = self.context {
			Format::Context(num)
		} else if self.context_flag {
			Format::Context(3)
		} else {
			Format::Normal
		};
		let opts = Options {
			format,
			brief: self.brief,
			report_identical: self.report_identical,
			recursive: self.recursive,
			new_file: self.new_file,
			ignore_case: self.ignore_case,
			ignore_all_space: self.ignore_all_space,
			ignore_space_change: self.ignore_space_change,
			ignore_blank_lines: self.ignore_blank_lines,
			strip_trailing_cr: self.strip_trailing_cr,
			labels: &self.labels,
			excludes: &excludes,
		};
		match diff_main(&self.files, opts, host) {
			Ok(code) => code,
			Err(message) => {
				host.error(message, 2);
				2
			},
		}
	}
}

/// Rewrites the obsolete attached count forms `-u3` / `-c3` into `-U3` / `-C3`,
/// which clap can parse. Real GNU diff accepts both spellings.
fn rewrite_obsolete_count(arg: &OsStr) -> Option<OsString> {
	let text = arg.to_str()?;
	let (upper, digits) = text
		.strip_prefix("-u")
		.map(|rest| ('U', rest))
		.or_else(|| text.strip_prefix("-c").map(|rest| ('C', rest)))?;
	if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
		return None;
	}
	Some(OsString::from(format!("-{upper}{digits}")))
}

fn diff_main(files: &[OsString], opts: Options<'_>, host: &mut Host) -> Result<i32, String> {
	let (mut name_a, mut name_b) = (PathBuf::from(&files[0]), PathBuf::from(&files[1]));
	let mut op_a = classify(&name_a, opts.new_file, host)?;
	let mut op_b = classify(&name_b, opts.new_file, host)?;

	// GNU: comparing a directory with a non-directory compares
	// <dir>/<basename-of-other> with the other operand.
	let a_is_dir = matches!(op_a, Operand::Dir(_));
	let b_is_dir = matches!(op_b, Operand::Dir(_));
	if a_is_dir != b_is_dir {
		if matches!(op_a, Operand::Stdin) || matches!(op_b, Operand::Stdin) {
			return Err("cannot compare '-' to a directory".to_string());
		}
		if a_is_dir {
			name_a = descend(&name_a, &name_b)?;
			op_a = classify(&name_a, opts.new_file, host)?;
		} else {
			name_b = descend(&name_b, &name_a)?;
			op_b = classify(&name_b, opts.new_file, host)?;
		}
	}

	let differed = if let (Operand::Dir(res_a), Operand::Dir(res_b)) = (&op_a, &op_b) {
		diff_dirs(&name_a, res_a, &name_b, res_b, opts, host)?
	} else {
		let (bytes_a, mtime_a) = read_operand(&op_a, &name_a, host)?;
		let (bytes_b, mtime_b) = read_operand(&op_b, &name_b, host)?;
		diff_pair(&name_a, &bytes_a, mtime_a, &name_b, &bytes_b, mtime_b, opts, None, host)?
	};
	Ok(i32::from(differed))
}

/// Replaces a directory operand with `<dir>/<basename of other>` for the GNU
/// dir-vs-file comparison form.
fn descend(dir: &Path, other: &Path) -> Result<PathBuf, String> {
	let base = other
		.file_name()
		.ok_or_else(|| format!("cannot compare {} to a directory", other.display()))?;
	Ok(dir.join(base))
}

fn classify(name: &Path, new_file: bool, host: &Host) -> Result<Operand, String> {
	if name.as_os_str() == OsStr::new("-") {
		return Ok(Operand::Stdin);
	}
	// Keep `name` for diagnostics and headers; only filesystem access uses the
	// path resolved against the shell working directory.
	let resolved = host.resolve(name);
	match fs::metadata(&resolved) {
		Ok(meta) if meta.is_dir() => Ok(Operand::Dir(resolved)),
		Ok(_) => Ok(Operand::File(resolved)),
		Err(err) if err.kind() == std::io::ErrorKind::NotFound && new_file => Ok(Operand::Absent),
		Err(err) => Err(format!("{}: {}", name.display(), io_msg(&err))),
	}
}

/// Reads an operand's contents plus the modification time shown in unified and
/// context headers. Stdin has no mtime (the current time is used); a `-N`
/// absent file reports the epoch, like GNU's `/dev/null` stand-in.
fn read_operand(
	op: &Operand,
	name: &Path,
	host: &mut Host,
) -> Result<(Vec<u8>, Option<SystemTime>), String> {
	match op {
		Operand::Stdin => {
			let mut buf = Vec::new();
			host.stdin
				.read_to_end(&mut buf)
				.map_err(|err| format!("-: {}", io_msg(&err)))?;
			Ok((buf, None))
		},
		Operand::File(resolved) => {
			let bytes = fs::read(resolved)
				.map_err(|err| format!("{}: {}", name.display(), io_msg(&err)))?;
			let mtime = fs::metadata(resolved).ok().and_then(|meta| meta.modified().ok());
			Ok((bytes, mtime))
		},
		Operand::Dir(_) => unreachable!("directories are handled by diff_dirs"),
		Operand::Absent => Ok((Vec::new(), Some(SystemTime::UNIX_EPOCH))),
	}
}

/// One input split into lines without terminators, remembering whether the
/// final line is missing its newline (for `\ No newline at end of file`).
struct FileLines<'a> {
	lines:           Vec<&'a str>,
	missing_newline: bool,
}

impl<'a> FileLines<'a> {
	fn split(text: &'a str) -> Self {
		let lines = text
			.split_inclusive('\n')
			.map(|line| line.strip_suffix('\n').unwrap_or(line))
			.collect();
		FileLines { lines, missing_newline: !text.is_empty() && !text.ends_with('\n') }
	}
}

/// Normalizes one line for comparison per the ignore flags. Output always
/// shows the original lines; only equality testing sees this form.
fn normalize_line<'a>(line: &'a str, opts: Options<'_>) -> Cow<'a, str> {
	let mut norm: Cow<'a, str> = Cow::Borrowed(line);
	if opts.strip_trailing_cr {
		if let Some(stripped) = line.strip_suffix('\r') {
			norm = Cow::Borrowed(stripped);
		}
	}
	if opts.ignore_case {
		norm = Cow::Owned(norm.to_lowercase());
	}
	if opts.ignore_all_space {
		if norm.contains(char::is_whitespace) {
			norm = Cow::Owned(norm.chars().filter(|ch| !ch.is_whitespace()).collect());
		}
	} else if opts.ignore_space_change && norm.contains(char::is_whitespace) {
		norm = Cow::Owned(collapse_spaces(norm.trim_end()));
	}
	norm
}

/// Collapses each run of white space to a single space, GNU `-b` style.
fn collapse_spaces(line: &str) -> String {
	let mut out = String::with_capacity(line.len());
	let mut in_space = false;
	for ch in line.chars() {
		if ch.is_whitespace() {
			if !in_space {
				out.push(' ');
			}
			in_space = true;
		} else {
			out.push(ch);
			in_space = false;
		}
	}
	out
}

/// Comparison keys for a whole file. A final line missing its newline gets a
/// NUL sentinel so `"a\n"` and `"a"` still compare unequal after
/// normalization (real diff reports them with the no-newline marker).
fn normalize_lines<'a>(file: &FileLines<'a>, opts: Options<'_>) -> Vec<Cow<'a, str>> {
	let mut norm: Vec<Cow<'a, str>> =
		file.lines.iter().map(|&line| normalize_line(line, opts)).collect();
	if file.missing_newline {
		if let Some(last) = norm.last_mut() {
			last.to_mut().push('\0');
		}
	}
	norm
}

/// `-B`: a change is suppressed when every line it touches is blank.
fn is_suppressed(
	op: &DiffOp,
	norm_a: &[Cow<'_, str>],
	norm_b: &[Cow<'_, str>],
	opts: Options<'_>,
) -> bool {
	if !opts.ignore_blank_lines || op.tag() == DiffTag::Equal {
		return false;
	}
	let blank = |line: &Cow<'_, str>| line.trim().is_empty();
	norm_a[op.old_range()].iter().all(blank) && norm_b[op.new_range()].iter().all(blank)
}

/// Writes one line to the builtin's stdout, mapping I/O failures like the
/// rest of this module.
fn wline(host: &mut Host, line: std::fmt::Arguments<'_>) -> Result<(), String> {
	writeln!(host.stdout, "{line}").map_err(|e| io_msg(&e))
}

/// Diffs one pair of already-read inputs. `prefix` is the `diff -r A/x B/x`
/// line emitted before per-pair output in directory mode.
#[allow(clippy::too_many_arguments)]
fn diff_pair(
	name_a: &Path,
	bytes_a: &[u8],
	mtime_a: Option<SystemTime>,
	name_b: &Path,
	bytes_b: &[u8],
	mtime_b: Option<SystemTime>,
	opts: Options<'_>,
	prefix: Option<&str>,
	host: &mut Host,
) -> Result<bool, String> {
	let label_a = display_label(opts.labels.first(), name_a);
	let label_b = display_label(opts.labels.get(1), name_b);
	if bytes_a == bytes_b {
		if opts.report_identical {
			wline(host, format_args!("Files {label_a} and {label_b} are identical"))?;
		}
		return Ok(false);
	}
	if is_binary(bytes_a) || is_binary(bytes_b) {
		if opts.brief {
			wline(host, format_args!("Files {label_a} and {label_b} differ"))?;
		} else {
			wline(host, format_args!("Binary files {label_a} and {label_b} differ"))?;
		}
		return Ok(true);
	}
	let text_a = String::from_utf8_lossy(bytes_a);
	let text_b = String::from_utf8_lossy(bytes_b);
	let old = FileLines::split(&text_a);
	let new = FileLines::split(&text_b);
	let norm_a = normalize_lines(&old, opts);
	let norm_b = normalize_lines(&new, opts);
	let ops = capture_diff_slices(Algorithm::Myers, &norm_a, &norm_b);
	let suppressed: Vec<bool> =
		ops.iter().map(|op| is_suppressed(op, &norm_a, &norm_b, opts)).collect();
	// Bytes differed, but every change is ignorable (-w/-b/-i/-B/CR): the
	// files count as identical, exit 0.
	if !ops.iter().zip(&suppressed).any(|(op, &sup)| op.tag() != DiffTag::Equal && !sup) {
		if opts.report_identical {
			wline(host, format_args!("Files {label_a} and {label_b} are identical"))?;
		}
		return Ok(false);
	}
	if opts.brief {
		wline(host, format_args!("Files {label_a} and {label_b} differ"))?;
		return Ok(true);
	}
	if let Some(line) = prefix {
		wline(host, format_args!("{line}"))?;
	}
	match opts.format {
		Format::Normal => write_normal(host, &ops, &suppressed, &old, &new)?,
		Format::Unified(context) => {
			wline(host, format_args!("--- {}", header(opts.labels.first(), name_a, mtime_a)))?;
			wline(host, format_args!("+++ {}", header(opts.labels.get(1), name_b, mtime_b)))?;
			write_unified(host, &ops, &suppressed, &old, &new, context)?;
		},
		Format::Context(context) => {
			wline(host, format_args!("*** {}", header(opts.labels.first(), name_a, mtime_a)))?;
			wline(host, format_args!("--- {}", header(opts.labels.get(1), name_b, mtime_b)))?;
			write_context_format(host, &ops, &suppressed, &old, &new, context)?;
		},
	}
	Ok(true)
}

fn display_label(label: Option<&OsString>, name: &Path) -> String {
	label.map_or_else(|| name.display().to_string(), |label| label.to_string_lossy().into_owned())
}

/// Unified/context header field: the label verbatim when given, otherwise
/// `NAME<TAB>TIMESTAMP` with the GNU timestamp format.
fn header(label: Option<&OsString>, name: &Path, mtime: Option<SystemTime>) -> String {
	match label {
		Some(label) => label.to_string_lossy().into_owned(),
		None => format!("{}\t{}", name.display(), timestamp(mtime)),
	}
}

/// GNU header timestamp: `%Y-%m-%d %H:%M:%S.%N %z` in local time. Stdin has
/// no mtime and uses the current time, like GNU.
fn timestamp(mtime: Option<SystemTime>) -> String {
	let time = mtime.unwrap_or_else(SystemTime::now);
	chrono::DateTime::<chrono::Local>::from(time)
		.format("%Y-%m-%d %H:%M:%S%.9f %z")
		.to_string()
}

/// Writes `range` lines of `file` prefixed with `marker`, emitting the GNU
/// `\ No newline at end of file` marker after the file's final line.
fn write_marked(
	host: &mut Host,
	marker: &str,
	range: Range<usize>,
	file: &FileLines<'_>,
) -> Result<(), String> {
	for idx in range {
		wline(host, format_args!("{marker}{}", file.lines[idx]))?;
		if idx + 1 == file.lines.len() && file.missing_newline {
			wline(host, format_args!("\\ No newline at end of file"))?;
		}
	}
	Ok(())
}

/// `N` for a single line, `N,M` for a span; 1-based inclusive, normal format.
fn normal_range(range: &Range<usize>) -> String {
	if range.len() <= 1 {
		(range.start + 1).to_string()
	} else {
		format!("{},{}", range.start + 1, range.end)
	}
}

/// Default diff output: `3c3` / `<` / `---` / `>` change commands.
fn write_normal(
	host: &mut Host,
	ops: &[DiffOp],
	suppressed: &[bool],
	old: &FileLines<'_>,
	new: &FileLines<'_>,
) -> Result<(), String> {
	for (op, &sup) in ops.iter().zip(suppressed) {
		if sup || op.tag() == DiffTag::Equal {
			continue;
		}
		let (old_range, new_range) = (op.old_range(), op.new_range());
		match op.tag() {
			DiffTag::Delete => {
				// `5d4`: the trailing number is the new-file line *after which*
				// the deleted lines would have appeared (0 for a leading delete).
				wline(host, format_args!("{}d{}", normal_range(&old_range), new_range.start))?;
				write_marked(host, "< ", old_range, old)?;
			},
			DiffTag::Insert => {
				wline(host, format_args!("{}a{}", old_range.start, normal_range(&new_range)))?;
				write_marked(host, "> ", new_range, new)?;
			},
			DiffTag::Replace => {
				wline(
					host,
					format_args!("{}c{}", normal_range(&old_range), normal_range(&new_range)),
				)?;
				write_marked(host, "< ", old_range, old)?;
				wline(host, format_args!("---"))?;
				write_marked(host, "> ", new_range, new)?;
			},
			DiffTag::Equal => unreachable!(),
		}
	}
	Ok(())
}

/// Groups changed ops into hunks: two changes share a hunk when the equal run
/// between them is at most `2 * context` lines. Hunks whose every change is
/// `-B`-suppressed are dropped.
fn group_ops(ops: &[DiffOp], suppressed: &[bool], context: usize) -> Vec<(usize, usize)> {
	let mut groups: Vec<(usize, usize)> = Vec::new();
	for (idx, op) in ops.iter().enumerate() {
		if op.tag() == DiffTag::Equal {
			continue;
		}
		if let Some(last) = groups.last_mut() {
			let gap = op.old_range().start - ops[last.1].old_range().end;
			if gap <= 2 * context {
				last.1 = idx;
				continue;
			}
		}
		groups.push((idx, idx));
	}
	groups.retain(|&(first, last)| {
		ops[first..=last]
			.iter()
			.zip(&suppressed[first..=last])
			.any(|(op, &sup)| op.tag() != DiffTag::Equal && !sup)
	});
	groups
}

/// Equal-line context available before and after a hunk, clipped to `context`.
fn group_padding(ops: &[DiffOp], first: usize, last: usize, context: usize) -> (usize, usize) {
	let lead = if first > 0 { context.min(ops[first - 1].old_range().len()) } else { 0 };
	let trail = ops.get(last + 1).map_or(0, |op| context.min(op.old_range().len()));
	(lead, trail)
}

/// `@@` hunk range: `S,N` with 1-based start (the preceding line for an empty
/// range); a count of 1 omits `,N`.
fn unified_range(start: usize, count: usize) -> String {
	match count {
		0 => format!("{start},0"),
		1 => (start + 1).to_string(),
		_ => format!("{},{count}", start + 1),
	}
}

fn write_unified(
	host: &mut Host,
	ops: &[DiffOp],
	suppressed: &[bool],
	old: &FileLines<'_>,
	new: &FileLines<'_>,
	context: usize,
) -> Result<(), String> {
	for (first, last) in group_ops(ops, suppressed, context) {
		let (lead, trail) = group_padding(ops, first, last, context);
		let old_start = ops[first].old_range().start - lead;
		let new_start = ops[first].new_range().start - lead;
		let old_count = ops[last].old_range().end + trail - old_start;
		let new_count = ops[last].new_range().end + trail - new_start;
		wline(
			host,
			format_args!(
				"@@ -{} +{} @@",
				unified_range(old_start, old_count),
				unified_range(new_start, new_count)
			),
		)?;
		write_marked(host, " ", old_start..ops[first].old_range().start, old)?;
		for op in &ops[first..=last] {
			match op.tag() {
				DiffTag::Equal => write_marked(host, " ", op.old_range(), old)?,
				DiffTag::Delete => write_marked(host, "-", op.old_range(), old)?,
				DiffTag::Insert => write_marked(host, "+", op.new_range(), new)?,
				DiffTag::Replace => {
					write_marked(host, "-", op.old_range(), old)?;
					write_marked(host, "+", op.new_range(), new)?;
				},
			}
		}
		let tail = ops[last].old_range().end;
		write_marked(host, " ", tail..tail + trail, old)?;
	}
	Ok(())
}

/// Context-format range: 1-based inclusive `S,E`; single line shows `S` only.
fn context_range(start: usize, count: usize) -> String {
	match count {
		0 => start.to_string(),
		1 => (start + 1).to_string(),
		_ => format!("{},{}", start + 1, start + count),
	}
}

fn write_context_format(
	host: &mut Host,
	ops: &[DiffOp],
	suppressed: &[bool],
	old: &FileLines<'_>,
	new: &FileLines<'_>,
	context: usize,
) -> Result<(), String> {
	for (first, last) in group_ops(ops, suppressed, context) {
		let (lead, trail) = group_padding(ops, first, last, context);
		let old_start = ops[first].old_range().start - lead;
		let new_start = ops[first].new_range().start - lead;
		let old_count = ops[last].old_range().end + trail - old_start;
		let new_count = ops[last].new_range().end + trail - new_start;
		let group = &ops[first..=last];
		wline(host, format_args!("***************"))?;
		wline(host, format_args!("*** {} ****", context_range(old_start, old_count)))?;
		// GNU omits a side's body entirely when it has no changes.
		if group.iter().any(|op| matches!(op.tag(), DiffTag::Delete | DiffTag::Replace)) {
			write_marked(host, "  ", old_start..ops[first].old_range().start, old)?;
			for op in group {
				match op.tag() {
					DiffTag::Equal => write_marked(host, "  ", op.old_range(), old)?,
					DiffTag::Delete => write_marked(host, "- ", op.old_range(), old)?,
					DiffTag::Replace => write_marked(host, "! ", op.old_range(), old)?,
					DiffTag::Insert => {},
				}
			}
			let tail = ops[last].old_range().end;
			write_marked(host, "  ", tail..tail + trail, old)?;
		}
		wline(host, format_args!("--- {} ----", context_range(new_start, new_count)))?;
		if group.iter().any(|op| matches!(op.tag(), DiffTag::Insert | DiffTag::Replace)) {
			write_marked(host, "  ", new_start..ops[first].new_range().start, new)?;
			for op in group {
				match op.tag() {
					DiffTag::Equal => write_marked(host, "  ", op.new_range(), new)?,
					DiffTag::Insert => write_marked(host, "+ ", op.new_range(), new)?,
					DiffTag::Replace => write_marked(host, "! ", op.new_range(), new)?,
					DiffTag::Delete => {},
				}
			}
			let tail = ops[last].new_range().end;
			write_marked(host, "  ", tail..tail + trail, new)?;
		}
	}
	Ok(())
}

/// The `diff [-r] A/x B/x` line printed before each differing pair in
/// directory mode.
fn pair_prefix(name_a: &Path, name_b: &Path, opts: Options<'_>) -> String {
	let flag = if opts.recursive { " -r" } else { "" };
	format!("diff{flag} {} {}", name_a.display(), name_b.display())
}

/// True when a directory entry's base name matches an `-x` glob.
fn is_excluded(name: &OsStr, excludes: &[glob::Pattern]) -> bool {
	if excludes.is_empty() {
		return false;
	}
	let name = name.to_string_lossy();
	excludes.iter().any(|pattern| pattern.matches(&name))
}

/// Compares two directories over the sorted union of their entries, GNU
/// style: subdirectories recurse only under `-r`, otherwise a
/// `Common subdirectories:` line is printed.
fn diff_dirs(
	name_a: &Path,
	res_a: &Path,
	name_b: &Path,
	res_b: &Path,
	opts: Options<'_>,
	host: &mut Host,
) -> Result<bool, String> {
	let mut names: BTreeSet<OsString> = BTreeSet::new();
	for (dir_name, dir_res) in [(name_a, res_a), (name_b, res_b)] {
		let entries = fs::read_dir(dir_res)
			.map_err(|err| format!("{}: {}", dir_name.display(), io_msg(&err)))?;
		for entry in entries {
			let entry = entry.map_err(|err| format!("{}: {}", dir_name.display(), io_msg(&err)))?;
			let name = entry.file_name();
			if !is_excluded(&name, opts.excludes) {
				names.insert(name);
			}
		}
	}

	let mut differed = false;
	for name in names {
		if host.is_cancelled() {
			return Err("interrupted".to_string());
		}
		let (child_name_a, child_name_b) = (name_a.join(&name), name_b.join(&name));
		// Resolve every recursively discovered display path through the host too;
		// the process's current directory is unrelated to the shell's.
		let child_res_a = host.resolve(&child_name_a);
		let child_res_b = host.resolve(&child_name_b);
		let meta_a = fs::metadata(&child_res_a).ok();
		let meta_b = fs::metadata(&child_res_b).ok();
		match (meta_a.as_ref(), meta_b.as_ref()) {
			(Some(ma), Some(mb)) if ma.is_dir() && mb.is_dir() => {
				if opts.recursive {
					differed |= diff_dirs(
						&child_name_a,
						&child_res_a,
						&child_name_b,
						&child_res_b,
						opts,
						host,
					)?;
				} else {
					wline(
						host,
						format_args!(
							"Common subdirectories: {} and {}",
							child_name_a.display(),
							child_name_b.display()
						),
					)?;
				}
			},
			(Some(ma), Some(mb)) if ma.is_dir() != mb.is_dir() => {
				let (dir, file) = if ma.is_dir() {
					(&child_name_a, &child_name_b)
				} else {
					(&child_name_b, &child_name_a)
				};
				wline(
					host,
					format_args!(
						"File {} is a directory while file {} is a regular file",
						dir.display(),
						file.display()
					),
				)?;
				differed = true;
			},
			(Some(ma), Some(mb)) => {
				let bytes_a = fs::read(&child_res_a)
					.map_err(|err| format!("{}: {}", child_name_a.display(), io_msg(&err)))?;
				let bytes_b = fs::read(&child_res_b)
					.map_err(|err| format!("{}: {}", child_name_b.display(), io_msg(&err)))?;
				let prefix = pair_prefix(&child_name_a, &child_name_b, opts);
				differed |= diff_pair(
					&child_name_a,
					&bytes_a,
					ma.modified().ok(),
					&child_name_b,
					&bytes_b,
					mb.modified().ok(),
					opts,
					Some(&prefix),
					host,
				)?;
			},
			(Some(meta), None) | (None, Some(meta)) => {
				let in_a = meta_b.is_none();
				if opts.new_file && meta.is_file() {
					let (present_name, present_res) = if in_a {
						(&child_name_a, &child_res_a)
					} else {
						(&child_name_b, &child_res_b)
					};
					let bytes = fs::read(present_res)
						.map_err(|err| format!("{}: {}", present_name.display(), io_msg(&err)))?;
					let prefix = pair_prefix(&child_name_a, &child_name_b, opts);
					let present_mtime = meta.modified().ok();
					let epoch = Some(SystemTime::UNIX_EPOCH);
					let (ba, bb, mta, mtb): (&[u8], &[u8], _, _) = if in_a {
						(&bytes, &[], present_mtime, epoch)
					} else {
						(&[], &bytes, epoch, present_mtime)
					};
					differed |= diff_pair(
						&child_name_a,
						ba,
						mta,
						&child_name_b,
						bb,
						mtb,
						opts,
						Some(&prefix),
						host,
					)?;
				} else {
					let present_dir = if in_a { name_a } else { name_b };
					wline(
						host,
						format_args!(
							"Only in {}: {}",
							present_dir.display(),
							Path::new(&name).display()
						),
					)?;
					differed = true;
				}
			},
			(None, None) => {},
		}
	}
	Ok(differed)
}

/// NUL byte within the first 8 KiB marks the input as binary, matching GNU
/// diff's heuristic for deciding between text and binary output.
fn is_binary(bytes: &[u8]) -> bool {
	bytes.iter().take(8192).any(|&byte| byte == 0)
}

/// Renders an I/O error without Rust's ` (os error N)` suffix.
fn io_msg(err: &std::io::Error) -> String {
	let msg = err.to_string();
	match msg.find(" (os error") {
		Some(idx) => msg[..idx].to_string(),
		None => msg,
	}
}

/// Creates the `diff` builtin registration.
pub(crate) fn diff_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Diff, SE>()
}

#[cfg(test)]
mod tests {
	use std::{fs, path::Path};

	use super::Diff;
	use crate::host::run_util;

	fn run_in(cwd: &Path, stdin: &str, args: &[&str]) -> (i32, String, String) {
		let (code, capture) = run_util::<Diff>(args, stdin, cwd);
		(code, capture.out(), capture.err())
	}

	fn write_pair(dir: &Path, a: &str, b: &str) {
		fs::write(dir.join("a.txt"), a).unwrap();
		fs::write(dir.join("b.txt"), b).unwrap();
	}

	#[test]
	fn identical_files_print_nothing_and_exit_zero() {
		let dir = tempfile::tempdir().unwrap();
		write_pair(dir.path(), "one\ntwo\n", "one\ntwo\n");
		assert_eq!(run_in(dir.path(), "", &["a.txt", "b.txt"]), (0, String::new(), String::new()));
	}

	// Defends: real diff emits *normal* format by default; unified output
	// without -u broke pipelines expecting `NcN` change commands.
	#[test]
	fn default_output_is_normal_format() {
		let dir = tempfile::tempdir().unwrap();
		write_pair(dir.path(), "one\ntwo\nthree\n", "one\nTWO\nthree\n");
		assert_eq!(
			run_in(dir.path(), "", &["a.txt", "b.txt"]),
			(1, "2c2\n< two\n---\n> TWO\n".to_string(), String::new())
		);
	}

	// Defends: normal-format `d`/`a` commands carry the peer file's position.
	#[test]
	fn normal_format_uses_add_and_delete_commands() {
		let dir = tempfile::tempdir().unwrap();
		write_pair(dir.path(), "one\ntwo\n", "one\n");
		let (code, stdout, _) = run_in(dir.path(), "", &["a.txt", "b.txt"]);
		assert_eq!((code, stdout.as_str()), (1, "2d1\n< two\n"));
		let (code, stdout, _) = run_in(dir.path(), "", &["b.txt", "a.txt"]);
		assert_eq!((code, stdout.as_str()), (1, "1a2\n> two\n"));
	}

	// Defends: a final line without newline must still diff, with the GNU
	// `\ No newline at end of file` marker.
	#[test]
	fn missing_trailing_newline_is_reported() {
		let dir = tempfile::tempdir().unwrap();
		write_pair(dir.path(), "one\n", "one");
		assert_eq!(
			run_in(dir.path(), "", &["a.txt", "b.txt"]),
			(1, "1c1\n< one\n---\n> one\n\\ No newline at end of file\n".to_string(), String::new())
		);
	}

	// Defends: -u emits unified format with GNU `NAME\tTIMESTAMP` headers.
	#[test]
	fn unified_flag_emits_unified_with_timestamped_headers() {
		let dir = tempfile::tempdir().unwrap();
		write_pair(dir.path(), "one\ntwo\nthree\n", "one\nTWO\nthree\n");
		let (code, stdout, stderr) = run_in(dir.path(), "", &["-u", "a.txt", "b.txt"]);
		assert_eq!((code, stderr.as_str()), (1, ""));
		let mut lines = stdout.lines();
		let first = lines.next().unwrap();
		let second = lines.next().unwrap();
		assert!(first.starts_with("--- a.txt\t"), "got: {first}");
		assert!(second.starts_with("+++ b.txt\t"), "got: {second}");
		// Timestamp shape: `2026-08-20 12:34:56.123456789 +0200`.
		let stamp = first.split('\t').nth(1).unwrap();
		assert_eq!((stamp.as_bytes()[4], stamp.as_bytes()[7]), (b'-', b'-'), "got: {stamp}");
		assert!(stamp.contains('.') && (stamp.contains(" +") || stamp.contains(" -")));
		assert!(stdout.contains("@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n"), "got: {stdout}");
	}

	// Defends: -L/--label (twice) replaces name *and* timestamp in headers.
	#[test]
	fn labels_override_unified_headers() {
		let dir = tempfile::tempdir().unwrap();
		write_pair(dir.path(), "old\n", "new\n");
		for args in [&["-u", "-L", "before", "-L", "after"][..], &["-u", "--label", "before", "--label", "after"]] {
			let mut argv = args.to_vec();
			argv.extend(["a.txt", "b.txt"]);
			let (code, stdout, stderr) = run_in(dir.path(), "", &argv);
			assert_eq!((code, stderr.as_str()), (1, ""), "args: {args:?}");
			assert!(stdout.starts_with("--- before\n+++ after\n@@ "), "got: {stdout}");
		}
	}

	// Defends: GNU rejects a third label instead of silently dropping it.
	#[test]
	fn three_labels_are_rejected() {
		let dir = tempfile::tempdir().unwrap();
		write_pair(dir.path(), "x\n", "y\n");
		let (code, _, stderr) =
			run_in(dir.path(), "", &["-L", "1", "-L", "2", "-L", "3", "a.txt", "b.txt"]);
		assert_eq!(code, 2);
		assert!(stderr.contains("too many file label options"), "got: {stderr}");
	}

	// Defends: attached counts (-U0, obsolete -u0) and bundled shorts
	// (-ru, -rq, -urN) all parse — the leading LLM failure mode.
	#[test]
	fn attached_counts_and_bundled_flags_parse() {
		let dir = tempfile::tempdir().unwrap();
		write_pair(dir.path(), "one\ntwo\nthree\n", "one\nTWO\nthree\n");
		for args in [&["-U0"][..], &["-u0"], &["-U", "0"]] {
			let mut argv = args.to_vec();
			argv.extend(["a.txt", "b.txt"]);
			let (code, stdout, stderr) = run_in(dir.path(), "", &argv);
			assert_eq!((code, stderr.as_str()), (1, ""), "args: {args:?}");
			assert!(stdout.contains("@@ -2 +2 @@\n-two\n+TWO\n"), "args: {args:?}: {stdout}");
		}
		let (code, stdout, stderr) = run_in(dir.path(), "", &["-ru", "a.txt", "b.txt"]);
		assert_eq!((code, stderr.as_str()), (1, ""));
		assert!(stdout.starts_with("--- a.txt\t"), "got: {stdout}");
		let (code, _, stderr) = run_in(dir.path(), "", &["-urN", "a.txt", "b.txt"]);
		assert_eq!((code, stderr.as_str()), (1, ""));
		let (code, stdout, stderr) = run_in(dir.path(), "", &["-rq", "a.txt", "b.txt"]);
		assert_eq!(
			(code, stdout.as_str(), stderr.as_str()),
			(1, "Files a.txt and b.txt differ\n", "")
		);
	}

	// Defends: -u and -c are conflicting output styles.
	#[test]
	fn unified_and_context_styles_conflict() {
		let dir = tempfile::tempdir().unwrap();
		write_pair(dir.path(), "x\n", "y\n");
		let (code, _, stderr) = run_in(dir.path(), "", &["-u", "-c", "a.txt", "b.txt"]);
		assert_eq!(code, 2);
		assert!(stderr.contains("cannot be used with"), "got: {stderr}");
	}

	// Defends: -c emits GNU copied-context format with `!` change markers.
	#[test]
	fn context_format_renders_changed_lines() {
		let dir = tempfile::tempdir().unwrap();
		write_pair(dir.path(), "one\ntwo\nthree\n", "one\nTWO\nthree\n");
		let (code, stdout, stderr) = run_in(dir.path(), "", &["-c", "a.txt", "b.txt"]);
		assert_eq!((code, stderr.as_str()), (1, ""));
		assert!(stdout.starts_with("*** a.txt\t"), "got: {stdout}");
		assert!(stdout.contains("\n--- b.txt\t"), "got: {stdout}");
		assert!(
			stdout.contains(
				"***************\n*** 1,3 ****\n  one\n! two\n  three\n--- 1,3 ----\n  one\n! TWO\n  three\n"
			),
			"got: {stdout}"
		);
	}

	// Defends: -w must change the comparison, not just parse.
	#[test]
	fn ignore_all_space_equates_whitespace_only_changes() {
		let dir = tempfile::tempdir().unwrap();
		write_pair(dir.path(), "one  two\n\tthree\n", "onetwo\nthree \n");
		assert_eq!(
			run_in(dir.path(), "", &["-w", "a.txt", "b.txt"]),
			(0, String::new(), String::new())
		);
		// Real changes still surface under -w.
		write_pair(dir.path(), "one\n", "two\n");
		let (code, stdout, _) = run_in(dir.path(), "", &["-w", "a.txt", "b.txt"]);
		assert_eq!((code, stdout.as_str()), (1, "1c1\n< one\n---\n> two\n"));
	}

	// Defends: -b ignores amount-of-whitespace changes but not added
	// whitespace where none existed.
	#[test]
	fn ignore_space_change_collapses_runs_only() {
		let dir = tempfile::tempdir().unwrap();
		write_pair(dir.path(), "one   two \n", "one two\n");
		assert_eq!(
			run_in(dir.path(), "", &["-b", "a.txt", "b.txt"]),
			(0, String::new(), String::new())
		);
		write_pair(dir.path(), "onetwo\n", "one two\n");
		let (code, _, _) = run_in(dir.path(), "", &["-b", "a.txt", "b.txt"]);
		assert_eq!(code, 1);
	}

	// Defends: -i case-insensitive comparison.
	#[test]
	fn ignore_case_equates_case_only_changes() {
		let dir = tempfile::tempdir().unwrap();
		write_pair(dir.path(), "One Two\n", "oNE tWO\n");
		assert_eq!(
			run_in(dir.path(), "", &["-i", "a.txt", "b.txt"]),
			(0, String::new(), String::new())
		);
	}

	// Defends: -B suppresses blank-only hunks; blank-only files compare equal
	// while real changes elsewhere still print (with true line numbers).
	#[test]
	fn ignore_blank_lines_suppresses_blank_only_hunks() {
		let dir = tempfile::tempdir().unwrap();
		write_pair(dir.path(), "one\n\ntwo\n", "one\ntwo\n");
		assert_eq!(
			run_in(dir.path(), "", &["-B", "a.txt", "b.txt"]),
			(0, String::new(), String::new())
		);
		write_pair(
			dir.path(),
			"a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n",
			"a\n\nb\nc\nd\ne\nf\ng\nh\ni\nJ\n",
		);
		let (code, stdout, _) = run_in(dir.path(), "", &["-B", "a.txt", "b.txt"]);
		assert_eq!((code, stdout.as_str()), (1, "10c11\n< j\n---\n> J\n"));
	}

	// Defends: --strip-trailing-cr equates CRLF and LF inputs.
	#[test]
	fn strip_trailing_cr_equates_crlf_and_lf() {
		let dir = tempfile::tempdir().unwrap();
		write_pair(dir.path(), "one\r\ntwo\r\n", "one\ntwo\n");
		assert_eq!(
			run_in(dir.path(), "", &["--strip-trailing-cr", "a.txt", "b.txt"]),
			(0, String::new(), String::new())
		);
		let (code, _, _) = run_in(dir.path(), "", &["a.txt", "b.txt"]);
		assert_eq!(code, 1);
	}

	// Defends: -s reports identical files, including ignore-flag identity.
	#[test]
	fn report_identical_files_prints_message() {
		let dir = tempfile::tempdir().unwrap();
		write_pair(dir.path(), "same\n", "same\n");
		assert_eq!(
			run_in(dir.path(), "", &["-s", "a.txt", "b.txt"]),
			(0, "Files a.txt and b.txt are identical\n".to_string(), String::new())
		);
		write_pair(dir.path(), "same  x\n", "same x\n");
		assert_eq!(
			run_in(dir.path(), "", &["-s", "-w", "a.txt", "b.txt"]),
			(0, "Files a.txt and b.txt are identical\n".to_string(), String::new())
		);
	}

	#[test]
	fn brief_reports_one_line_per_differing_pair() {
		let dir = tempfile::tempdir().unwrap();
		write_pair(dir.path(), "x\n", "y\n");
		assert_eq!(
			run_in(dir.path(), "", &["-q", "a.txt", "b.txt"]),
			(1, "Files a.txt and b.txt differ\n".to_string(), String::new())
		);
	}

	#[test]
	fn color_flag_is_accepted_and_ignored() {
		let dir = tempfile::tempdir().unwrap();
		write_pair(dir.path(), "x\n", "y\n");
		let (code, stdout, stderr) =
			run_in(dir.path(), "", &["--color=always", "a.txt", "b.txt"]);
		assert_eq!((code, stderr.as_str()), (1, ""));
		assert!(!stdout.contains('\u{1b}'), "got: {stdout}");
	}

	#[test]
	fn binary_inputs_report_binary_difference() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a.bin"), b"aa\x00bb").unwrap();
		fs::write(dir.path().join("b.bin"), b"aa\x00cc").unwrap();
		assert_eq!(
			run_in(dir.path(), "", &["a.bin", "b.bin"]),
			(1, "Binary files a.bin and b.bin differ\n".to_string(), String::new())
		);
	}

	#[test]
	fn missing_operand_file_is_trouble() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a.txt"), "x\n").unwrap();
		assert_eq!(
			run_in(dir.path(), "", &["a.txt", "nope.txt"]),
			(2, String::new(), "diff: nope.txt: No such file or directory\n".to_string())
		);
	}

	#[test]
	fn missing_second_operand_is_usage_error() {
		let dir = tempfile::tempdir().unwrap();
		let (code, stdout, stderr) = run_in(dir.path(), "", &["only-one"]);
		assert_eq!(code, 2);
		assert_eq!(stdout, "");
		assert!(stderr.contains("required"), "got: {stderr}");
	}

	#[test]
	fn new_file_treats_missing_operand_as_empty() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a.txt"), "one\n").unwrap();
		assert_eq!(
			run_in(dir.path(), "", &["-N", "nope.txt", "a.txt"]),
			(1, "0a1\n> one\n".to_string(), String::new())
		);
	}

	#[test]
	fn dash_reads_builtin_stdin() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a.txt"), "one\ntwo\n").unwrap();
		assert_eq!(
			run_in(dir.path(), "one\ntwo\n", &["a.txt", "-"]),
			(0, String::new(), String::new())
		);
		let (code, stdout, _) = run_in(dir.path(), "one\nTWO\n", &["a.txt", "-"]);
		assert_eq!((code, stdout.as_str()), (1, "2c2\n< two\n---\n> TWO\n"));
	}

	// Defends: without -r, subdirectories are announced, not recursed into,
	// and their differing contents do not affect the exit code.
	#[test]
	fn directories_do_not_recurse_without_r() {
		let dir = tempfile::tempdir().unwrap();
		let (a, b) = (dir.path().join("a"), dir.path().join("b"));
		fs::create_dir_all(a.join("sub")).unwrap();
		fs::create_dir_all(b.join("sub")).unwrap();
		fs::write(a.join("common.txt"), "same\n").unwrap();
		fs::write(b.join("common.txt"), "same\n").unwrap();
		fs::write(a.join("sub/inner.txt"), "old\n").unwrap();
		fs::write(b.join("sub/inner.txt"), "new\n").unwrap();
		assert_eq!(
			run_in(dir.path(), "", &["a", "b"]),
			(0, "Common subdirectories: a/sub and b/sub\n".to_string(), String::new())
		);
	}

	#[test]
	fn directories_diff_recursively_with_only_in_lines() {
		let dir = tempfile::tempdir().unwrap();
		let (a, b) = (dir.path().join("a"), dir.path().join("b"));
		fs::create_dir_all(a.join("sub")).unwrap();
		fs::create_dir_all(b.join("sub")).unwrap();
		fs::write(a.join("common.txt"), "same\n").unwrap();
		fs::write(b.join("common.txt"), "same\n").unwrap();
		fs::write(a.join("only.txt"), "left\n").unwrap();
		fs::write(b.join("other.txt"), "right\n").unwrap();
		fs::write(a.join("sub/inner.txt"), "old\n").unwrap();
		fs::write(b.join("sub/inner.txt"), "new\n").unwrap();
		let (code, stdout, stderr) = run_in(dir.path(), "", &["-r", "a", "b"]);
		assert_eq!(code, 1);
		assert_eq!(stderr, "");
		assert!(stdout.contains("Only in a: only.txt\n"), "got: {stdout}");
		assert!(stdout.contains("Only in b: other.txt\n"), "got: {stdout}");
		assert!(
			stdout.contains("diff -r a/sub/inner.txt b/sub/inner.txt\n1c1\n< old\n---\n> new\n"),
			"got: {stdout}"
		);
		assert!(!stdout.contains("common.txt"), "got: {stdout}");
	}

	// Defends: -x excludes matching base names from directory walks, both for
	// diffing and for `Only in` reporting.
	#[test]
	fn exclude_globs_skip_matching_names() {
		let dir = tempfile::tempdir().unwrap();
		let (a, b) = (dir.path().join("a"), dir.path().join("b"));
		fs::create_dir_all(a.join(".git")).unwrap();
		fs::create_dir_all(&b).unwrap();
		fs::write(a.join(".git/state"), "x\n").unwrap();
		fs::write(a.join("keep.txt"), "old\n").unwrap();
		fs::write(b.join("keep.txt"), "new\n").unwrap();
		fs::write(a.join("skip.log"), "left\n").unwrap();
		fs::write(b.join("other.log"), "right\n").unwrap();
		let (code, stdout, stderr) =
			run_in(dir.path(), "", &["-r", "-x", "*.log", "-x", ".git", "a", "b"]);
		assert_eq!((code, stderr.as_str()), (1, ""));
		assert!(stdout.contains("diff -r a/keep.txt b/keep.txt\n1c1\n< old\n---\n> new\n"), "got: {stdout}");
		assert!(!stdout.contains(".git"), "got: {stdout}");
		assert!(!stdout.contains(".log"), "got: {stdout}");
	}

	#[test]
	fn identical_directories_exit_zero() {
		let dir = tempfile::tempdir().unwrap();
		let (a, b) = (dir.path().join("a"), dir.path().join("b"));
		fs::create_dir_all(&a).unwrap();
		fs::create_dir_all(&b).unwrap();
		fs::write(a.join("f.txt"), "same\n").unwrap();
		fs::write(b.join("f.txt"), "same\n").unwrap();
		assert_eq!(run_in(dir.path(), "", &["-r", "a", "b"]), (0, String::new(), String::new()));
	}

	#[test]
	fn help_renders_to_builtin_stdout() {
		let dir = tempfile::tempdir().unwrap();
		let (code, capture) = run_util::<Diff>(&["--help"], "", dir.path());
		assert_eq!(code, 0);
		assert!(capture.out().contains("Usage:"));
		assert!(capture.out().contains("Compare files line by line"));
		assert_eq!(capture.err(), "");
	}
}
