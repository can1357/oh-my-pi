//! `sd` builtin: intuitive find & replace.
//!
//! Port of [sd](https://github.com/chmln/sd) 1.0.0. Every match of FIND — a
//! regex, or with `-F` a literal string — is replaced in each input taken as a
//! whole, so patterns may span lines (`sd '\n' ','`). Without file operands
//! stdin is filtered to stdout; with them each file is rewritten in place,
//! atomically, unless `--preview` prints the results instead.
//!
//! From upstream's development line since 1.0.0 it takes the lenient escape
//! handling in REPLACE_WITH and the uncoloured preview. Where upstream
//! misbehaves, this port deliberately differs:
//! - `-f w` wraps the whole pattern (`\b(?:…)\b`) and keeps the other flags;
//!   upstream rebuilt the regex there, dropping earlier flags and multi-line
//!   mode.
//! - `\xNN` and `\uNNNN` no longer swallow the character that follows them.
//! - Files without a change are left untouched rather than rewritten.
//! - `--expect N` guards each input's match count before applying `-n`.
//!   `-U N` reports the changes actually written with N lines of context.
//! - `-A`/`--across` is accepted: newer upstream processes line by line unless
//!   given it, and this port always processes inputs whole.
//! - Diagnostics carry the `sd: ` prefix of the other builtins instead of
//!   `error: `, and name the file they concern.

use std::{
	borrow::Cow,
	collections::HashSet,
	ffi::{OsStr, OsString},
	io::{self, Read, Write},
	path::PathBuf,
};

use clap::Parser;
use omp_diff::{HunkLine, diff_line_tokens, line_tokens_str, structured_patch_hunk_rows};
use regex::bytes::{NoExpand, Regex, RegexBuilder};

use crate::{
	atomic_write,
	host::{Host, Utility, strip_errno},
};

/// Parsed `sd` invocation.
#[derive(Parser)]
#[command(
	name = "sd",
	version = "1.0.0",
	about = "An intuitive find & replace CLI",
	max_term_width = 100,
	help_template = "\
{before-help}{name} v{version}
{about-with-newline}
{usage-heading} {usage}

{all-args}{after-help}"
)]
pub(crate) struct Sd {
	/// Display changes in a human reviewable format (the specifics of the
	/// format are likely to change in the future).
	#[arg(short, long)]
	preview: bool,

	/// Treat FIND and REPLACE_WITH args as literal strings
	#[arg(short = 'F', long = "fixed-strings", short_alias = 's', alias = "string-mode")]
	literal: bool,

	/// Limit the number of replacements that can occur per file. 0 indicates
	/// unlimited replacements.
	#[arg(short = 'n', long = "max-replacements", value_name = "LIMIT", default_value_t)]
	max_replacements: usize,

	/// Require exactly N matches per input before applying -n. A mismatch leaves all files untouched.
	#[arg(long, value_name = "N")]
	expect: Option<usize>,

	/// After writing each changed file, print its unified diff with N context lines.
	/// Binary (NUL-containing or non-UTF-8) changes are summarized instead.
	#[arg(short = 'U', long, value_name = "N", requires = "files", conflicts_with = "preview")]
	unified: Option<u32>,

	/// Regex flags. May be combined (like `-f mc`).
	///
	/// c - case-sensitive
	///
	/// e - disable multi-line matching
	///
	/// i - case-insensitive
	///
	/// m - multi-line matching
	///
	/// s - make `.` match newlines
	///
	/// w - match full words only
	#[arg(short, long, verbatim_doc_comment)]
	flags: Option<String>,

	/// Accepted for scripts written against sd releases that process input
	/// line by line unless given it; inputs are always processed whole here.
	#[arg(short = 'A', long = "across", hide = true)]
	_across: bool,

	/// The regexp or string (if using `-F`) to search for.
	find: String,

	/// What to replace each match with. Unless in string mode, you may use
	/// captured values like $1, $2, etc.
	replace_with: String,

	/// The path to file(s). This is optional - sd can also read from STDIN.
	///
	/// Note: sd modifies files in-place by default. See documentation for
	/// examples.
	files: Vec<OsString>,
}

impl Utility for Sd {
	const NAME: &'static str = "sd";
	/// clap's usage-error status, which the standalone `sd` exits with.
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		let replacer = match Replacer::new(&self) {
			Ok(replacer) => replacer,
			Err(message) => {
				host.error(message, 1);
				return 1;
			},
		};
		if self.files.is_empty() {
			filter_stdin(&replacer, host)
		} else if self.preview {
			preview_files(&replacer, &self.files, host)
		} else {
			edit_files(&replacer, &self.files, self.unified, host)
		}
	}
}

/// FIND compiled under its flags, and the REPLACE_WITH substituted for it.
struct Replacer {
	regex:       Regex,
	/// Expanded through `$N`/`${name}` unless `literal`.
	replacement: Vec<u8>,
	literal:     bool,
	/// Replacements per input; 0 is unlimited.
	limit:       usize,
	expect:      Option<usize>,
}

impl Replacer {
	/// # Errors
	///
	/// The diagnostic for an ambiguous capture reference in REPLACE_WITH (see
	/// [`check_captures`]) or a FIND that does not compile.
	fn new(cli: &Sd) -> Result<Self, String> {
		let (pattern, replacement) = if cli.literal {
			(Cow::Owned(regex::escape(&cli.find)), cli.replace_with.as_bytes().to_vec())
		} else {
			check_captures(&cli.replace_with)?;
			(Cow::Borrowed(cli.find.as_str()), unescape(&cli.replace_with).into_bytes())
		};
		let regex = build_regex(&pattern, cli.flags.as_deref().unwrap_or_default())
			.map_err(|err| err.to_string())?;
		Ok(Self {
			regex,
			replacement,
			literal: cli.literal,
			limit: cli.max_replacements,
			expect: cli.expect,
		})
	}

	/// `input` with up to `limit` matches replaced; borrowed when nothing
	/// matched. A count mismatch is diagnosed without performing replacement.
	fn replace<'a>(&self, input: &'a [u8], name: &OsStr, host: &mut Host) -> Option<Cow<'a, [u8]>> {
		if let Some(expected) = self.expect {
			let actual = self.regex.find_iter(input).count();
			if actual != expected {
				host.error(format_args!("{}: expected {expected} matches, found {actual}", name.display()), 1);
				return None;
			}
			if actual == 0 {
				return Some(Cow::Borrowed(input));
			}
		}
		Some(if self.literal {
			self.regex.replacen(input, self.limit, NoExpand(&self.replacement))
		} else {
			self.regex.replacen(input, self.limit, self.replacement.as_slice())
		})
	}
}

/// Compiles `pattern` under sd's `-f` flags, applied in order so a later flag
/// overrides an earlier one: multi-line by default; `c`/`i` set case
/// sensitivity, `e` disables multi-line, `s` lets `.` match newlines (and
/// disables multi-line unless `m` is also given), `w` matches whole words.
/// Unknown flags are ignored, as upstream does.
fn build_regex(pattern: &str, flags: &str) -> Result<Regex, regex::Error> {
	let words;
	let pattern = if flags.contains('w') {
		words = format!(r"\b(?:{pattern})\b");
		&words
	} else {
		pattern
	};
	let mut builder = RegexBuilder::new(pattern);
	builder.multi_line(true);
	for flag in flags.chars() {
		match flag {
			'c' => {
				builder.case_insensitive(false);
			},
			'i' => {
				builder.case_insensitive(true);
			},
			'e' => {
				builder.multi_line(false);
			},
			's' => {
				if !flags.contains('m') {
					builder.multi_line(false);
				}
				builder.dot_matches_new_line(true);
			},
			_ => {},
		}
	}
	builder.build()
}

/// Rejects a numbered capture reference followed by name characters
/// (`$1bad`): the regex crate reads it as the named group `1bad`, which never
/// exists, so it would silently expand to nothing. `$$` and braced references
/// (`${1}bad`) are never ambiguous.
///
/// # Errors
///
/// The first ambiguous reference, rendered by [`ambiguous_capture`].
fn check_captures(replacement: &str) -> Result<(), String> {
	let bytes = replacement.as_bytes();
	let mut at = 0;
	while let Some(offset) = memchr::memchr(b'$', &bytes[at..]) {
		let start = at + offset + 1;
		at = start;
		match bytes.get(start) {
			Some(b'$') => at += 1,
			// Without a closing brace the `{` is literal text.
			Some(b'{') => {
				if let Some(close) = memchr::memchr(b'}', &bytes[start..]) {
					at += close + 1;
				}
			},
			_ => {
				let name = bytes[start..]
					.iter()
					.take_while(|&&b| b == b'_' || b.is_ascii_alphanumeric())
					.count();
				let digits = bytes[start..start + name].iter().take_while(|b| b.is_ascii_digit()).count();
				if digits > 0 && digits < name {
					return Err(ambiguous_capture(replacement, start, name, digits));
				}
				at += name;
			},
		}
	}
	Ok(())
}

/// Upstream's diagnostic for the reference `replacement[start..start + len]`,
/// whose first `digits` bytes are the group number: the replacement on one
/// line with carets under the reference, and the braced spelling as a hint.
fn ambiguous_capture(replacement: &str, start: usize, len: usize, digits: usize) -> String {
	let (number, rest) = replacement[start..start + len].split_at(digits);
	// Line breaks and tabs show as one-column Control Pictures, keeping the
	// replacement on one line and the carets under the reference.
	let shown: String = replacement
		.chars()
		.map(|c| match c {
			'\n' => '␊',
			'\r' => '␍',
			'\t' => '␉',
			c => c,
		})
		.collect();
	let column = replacement[..start].chars().count();
	format!(
		"The numbered capture group `${number}` in the replacement text is ambiguous.\nhint: Use \
		 curly braces to disambiguate it `${{{number}}}{rest}`.\n{shown}\n{:column$}{}",
		"",
		"^".repeat(len)
	)
}

/// Expands the escapes sd recognises in REPLACE_WITH (`\n`, `\r`, `\t`, `\'`,
/// `\"`, `\\`, `\xNN`, `\uNNNN`). Any other backslash, including one starting
/// a malformed `\x`/`\u`, stays as written.
fn unescape(input: &str) -> String {
	let mut out = String::with_capacity(input.len());
	let mut rest = input;
	while let Some(at) = rest.find('\\') {
		out.push_str(&rest[..at]);
		let escape = &rest[at + 1..];
		let (expanded, len) = match escape.as_bytes().first() {
			Some(b'n') => (Some('\n'), 1),
			Some(b'r') => (Some('\r'), 1),
			Some(b't') => (Some('\t'), 1),
			Some(&quoted @ (b'\'' | b'"' | b'\\')) => (Some(char::from(quoted)), 1),
			Some(b'x') => (hex_char(&escape[1..], 2), 3),
			Some(b'u') => (hex_char(&escape[1..], 4), 5),
			_ => (None, 0),
		};
		match expanded {
			Some(c) => {
				out.push(c);
				rest = &escape[len..];
			},
			None => {
				out.push('\\');
				rest = escape;
			},
		}
	}
	out.push_str(rest);
	out
}

/// The character whose code is the `digits` hex digits starting `s`.
fn hex_char(s: &str, digits: usize) -> Option<char> {
	let hex = s.get(..digits).filter(|hex| hex.bytes().all(|b| b.is_ascii_hexdigit()))?;
	char::from_u32(u32::from_str_radix(hex, 16).ok()?)
}

/// Replaces across all of stdin and writes the result to stdout.
fn filter_stdin(replacer: &Replacer, host: &mut Host) -> i32 {
	let mut input = Vec::new();
	if let Err(err) = host.stdin.read_to_end(&mut input) {
		host.error(format_args!("stdin: {}", strip_errno(&err)), 1);
		return 1;
	}
	let Some(output) = replacer.replace(&input, OsStr::new("stdin"), host) else {
		return 1;
	};
	match host.stdout.write_all(&output).and_then(|()| host.stdout.flush()) {
		Ok(()) => 0,
		Err(err) => stdout_failed(host, &err),
	}
}

/// Prints each file's replaced contents, under a `----- FILE <path> -----`
/// header when there are several, leaving the files untouched. An unreadable
/// file is reported and skipped.
fn preview_files(replacer: &Replacer, files: &[OsString], host: &mut Host) -> i32 {
	let mut out = host.stdout_writer();
	let mut emit = |file: &OsStr, contents: &[u8]| -> io::Result<()> {
		if files.len() > 1 {
			writeln!(out, "----- FILE {} -----", file.display())?;
		}
		out.write_all(contents)
	};
	// An unguarded preview streams; a guarded one must not print a partial
	// result if a later operand fails its check.
	let mut pending = Vec::new();
	for file in files {
		if host.is_cancelled() {
			return 130;
		}
		let input = match host.fs().read(host.resolve(file)) {
			Ok(input) => input,
			Err(err) => {
				host.error(format_args!("{}: {}", file.display(), strip_errno(&err)), 1);
				if replacer.expect.is_some() {
					return 1;
				}
				continue;
			},
		};
		let Some(output) = replacer.replace(&input, file, host) else {
			return 1;
		};
		if replacer.expect.is_some() && files.len() > 1 {
			let bytes = match output {
				Cow::Borrowed(_) => input,
				Cow::Owned(bytes) => bytes,
			};
			pending.push((file, bytes));
		} else if let Err(err) = emit(file, &output) {
			return stdout_failed(host, &err);
		}
	}
	for (file, contents) in pending {
		if let Err(err) = emit(file, &contents) {
			return stdout_failed(host, &err);
		}
	}
	if let Err(err) = out.flush() {
		return stdout_failed(host, &err);
	}
	host.exit_code()
}

struct FileEdit<'a> {
	file:   &'a OsStr,
	path:   PathBuf,
	after:  Vec<u8>,
	/// Retain the preimage only when reporting patches.
	before: Option<Vec<u8>>,
}

/// Rewrites each file whose contents change, in place. Every file is read
/// and replaced before any is written, so an unreadable operand leaves all of
/// them untouched. A symlink operand has its target edited and stays a link.
fn edit_files(replacer: &Replacer, files: &[OsString], unified: Option<u32>, host: &mut Host) -> i32 {
	let mut edits = Vec::new();
	for file in files {
		if host.is_cancelled() {
			return 130;
		}
		let path = host.resolve(file);
		match host.fs().read(&path) {
			Ok(input) => {
				let Some(output) = replacer.replace(&input, file, host) else {
					return 1;
				};
				if let Cow::Owned(after) = output
					&& after != input
				{
					edits.push(FileEdit { file, path, after, before: unified.map(|_| input) });
				}
			},
			Err(err) => host.error(format_args!("{}: {}", file.display(), strip_errno(&err)), 1),
		}
	}
	if host.exit_code() != 0 || edits.is_empty() {
		return host.exit_code();
	}
	let mut patches = unified.map(|context| (context, host.stdout_writer()));
	// Duplicate operands (including symlink aliases) describe the same
	// preimage; a second copy of the patch would not be an applied change.
	let mut written = (patches.is_some() && edits.len() > 1).then(HashSet::new);
	for FileEdit { file, path, after, before } in edits {
		if host.is_cancelled() {
			return 130;
		}
		let fs = host.fs();
		let target = match fs.canonicalize(&path) {
			Ok(target) => target,
			Err(err) => {
				host.error(format_args!("{}: {}", file.display(), strip_errno(&err)), 1);
				continue;
			},
		};
		if written.as_ref().is_some_and(|set| set.contains(&target)) {
			continue;
		}
		if let Err(err) = atomic_write::replace(fs, &target, &after, Sd::NAME) {
			host.error(format_args!("{}: {}", file.display(), strip_errno(&err)), 1);
			continue;
		}
		if let (Some((context, out)), Some(before)) = (&mut patches, before) {
			if let Some(written) = &mut written {
				written.insert(target);
			}
			if let Err(err) = write_patch(out, file, &before, &after, *context) {
				return stdout_failed(host, &err);
			}
		}
	}
	if let Some((_, mut out)) = patches
		&& let Err(err) = out.flush()
	{
		return stdout_failed(host, &err);
	}
	host.exit_code()
}

fn write_patch(
	out: &mut impl Write,
	file: &OsStr,
	before: &[u8],
	after: &[u8],
	context: u32,
) -> io::Result<()> {
	fn text(bytes: &[u8]) -> Option<&str> {
		if bytes.contains(&0) { None } else { std::str::from_utf8(bytes).ok() }
	}
	let label = patch_label(file);
	let (Some(old), Some(new)) = (text(before), text(after)) else {
		return writeln!(out, "Binary file {label} changed");
	};
	let old = line_tokens_str(old);
	let new = line_tokens_str(new);
	let runs = diff_line_tokens(&old, &new);
	// The shared hunk builder uses twice the context for joining hunks;
	// limit it to the available lines even on 32-bit targets.
	let available = u32::try_from(old.len().max(new.len())).unwrap_or(u32::MAX);
	let context = context.min(available);
	writeln!(out, "--- {label}\n+++ {label}")?;
	for hunk in structured_patch_hunk_rows(Some(context), &old, &new, &runs) {
		write!(out, "@@ -")?;
		write_range(out, hunk.old_start, hunk.old_lines)?;
		write!(out, " +")?;
		write_range(out, hunk.new_start, hunk.new_lines)?;
		writeln!(out, " @@")?;
		for row in hunk.lines {
			match row {
				HunkLine::Context(line) => writeln!(out, " {line}")?,
				HunkLine::Removed(line) => writeln!(out, "-{line}")?,
				HunkLine::Added(line) => writeln!(out, "+{line}")?,
				HunkLine::NoNewlineAtEof => writeln!(out, "\\ No newline at end of file")?,
			}
		}
	}
	Ok(())
}

fn write_range(out: &mut impl Write, start: u32, count: u32) -> io::Result<()> {
	match count {
		0 => write!(out, "{},0", start - 1),
		1 => write!(out, "{start}"),
		_ => write!(out, "{start},{count}"),
	}
}

/// Git-style quoted labels keep spaces, newlines and arbitrary path bytes
/// unambiguous; ordinary filenames need no allocation.
fn patch_label(file: &OsStr) -> Cow<'_, str> {
	use std::fmt::Write;

	if let Some(name) = file.to_str()
		&& !name.bytes().any(|b| b.is_ascii_control() || matches!(b, b' ' | b'"' | b'\\'))
	{
		return Cow::Borrowed(name);
	}
	let mut label = String::from("\"");
	for &b in file.as_encoded_bytes() {
		match b {
			b'\\' | b'"' => {
				label.push('\\');
				label.push(char::from(b));
			},
			b' '..=b'~' => label.push(char::from(b)),
			_ => write!(label, "\\{b:03o}").unwrap(),
		}
	}
	label.push('"');
	Cow::Owned(label)
}

/// Reports a failed stdout write, unless a closed reader already ended the
/// utility (the adapter then reports the SIGPIPE status).
fn stdout_failed(host: &mut Host, err: &io::Error) -> i32 {
	if !host.sigpipe_hit() {
		host.error(format_args!("stdout: {}", strip_errno(err)), 1);
	}
	1
}

#[cfg(test)]
mod tests {
	use std::fs;

	use super::{Sd, unescape};
	use crate::host::run_util;

	/// Runs `sd` over `stdin` in a scratch directory.
	fn filter(args: &[&str], stdin: &str) -> (i32, String, String) {
		let dir = tempfile::tempdir().unwrap();
		let (code, capture) = run_util::<Sd>(args, stdin, dir.path());
		(code, capture.out(), capture.err())
	}

	#[test]
	fn stdin_replacement_expands_captures_and_escapes() {
		let out = filter(&[r"(\w+)=(\w+)", r"$2\t${1}"], "a=b\nc=d\n");
		assert_eq!(out, (0, "b\ta\nd\tc\n".into(), String::new()));
	}

	#[test]
	fn patterns_match_across_lines() {
		for args in [&[r"\n", ","][..], &["-A", r"\n", ","]] {
			assert_eq!(filter(args, "a\nb\nc\n"), (0, "a,b,c,".into(), String::new()), "{args:?}");
		}
	}

	#[test]
	fn fixed_strings_take_find_and_replacement_literally() {
		let out = filter(&["-F", "$x.*", r"$1fine\n"], "a$x.*b $xyz");
		assert_eq!(out, (0, r"a$1fine\nb $xyz".into(), String::new()));
	}

	#[test]
	fn flags_shape_the_pattern() {
		let cases: [(&[&str], &str, &str); 6] = [
			// Multi-line by default: `^` anchors every line.
			(&["^", "> "], "a\nb", "> a\n> b"),
			(&["-f", "e", "^", "> "], "a\nb", "> a\nb"),
			(&["-f", "s", "a.b", "X"], "a\nb", "X"),
			(&["-f", "i", "abc", "X"], "ABC abc", "X X"),
			(&["-f", "ic", "abc", "X"], "ABC abc", "ABC X"),
			// `w` bounds the whole alternation and keeps `i`.
			(&["-f", "iw", "a|b", "X"], "A ab B", "X ab X"),
		];
		for (args, input, expected) in cases {
			assert_eq!(filter(args, input), (0, expected.into(), String::new()), "{args:?}");
		}
	}

	#[test]
	fn max_replacements_limits_each_file() {
		let dir = tempfile::tempdir().unwrap();
		for name in ["a", "b"] {
			fs::write(dir.path().join(name), "foo foo foo").unwrap();
		}
		let (code, capture) = run_util::<Sd>(&["-n", "2", "foo", "bar", "a", "b"], "", dir.path());
		assert_eq!((code, capture.err()), (0, String::new()));
		for name in ["a", "b"] {
			assert_eq!(fs::read_to_string(dir.path().join(name)).unwrap(), "bar bar foo");
		}
	}

	#[test]
	fn expect_counts_matches_before_limiting_replacement() {
		assert_eq!(
			filter(&["--expect", "3", "-n", "1", r"x(\d)", "$1"], "x1 x2 x3"),
			(0, "1 x2 x3".into(), String::new())
		);
		assert_eq!(
			filter(&["--expect", "0", "-F", ".", "$1"], "abc"),
			(0, "abc".into(), String::new())
		);
		// An identical replacement still counts, and zero is a real guard.
		assert_eq!(
			filter(&["--expect", "0", "-F", ".", "."], "a.b"),
			(1, String::new(), "sd: stdin: expected 0 matches, found 1\n".into())
		);
	}

	#[test]
	fn late_count_mismatch_aborts_edits_and_preview_before_output() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a"), "x").unwrap();
		fs::write(dir.path().join("b"), "x x").unwrap();

		for mode in [&["--unified", "0"][..], &["--preview"]] {
			let mut args = mode.to_vec();
			args.extend(["--expect", "1", "-n", "1", "x", "y", "a", "b"]);
			let (code, capture) = run_util::<Sd>(&args, "", dir.path());
			assert_eq!(code, 1);
			assert_eq!(capture.err(), "sd: b: expected 1 matches, found 2\n");
			assert_eq!(capture.out(), "");
			assert_eq!(fs::read(dir.path().join("a")).unwrap(), b"x");
			assert_eq!(fs::read(dir.path().join("b")).unwrap(), b"x x");
		}
	}

	#[test]
	fn unified_reports_only_applied_changes_with_requested_context() {
		let dir = tempfile::tempdir().unwrap();
		let old = "cut\r\nbefore\r\nx1\r\nafter\r\ncut\r\ncut\r\ncut\r\nx2";
		let name = "a file";
		fs::write(dir.path().join(name), old).unwrap();
		fs::write(dir.path().join("miss"), "no hits").unwrap();

		let args = ["-U", "1", r"x(\d)", "y$1", name, "miss", name];
		let (code, capture) = run_util::<Sd>(&args, "", dir.path());
		assert_eq!((code, capture.err()), (0, String::new()));
		assert_eq!(fs::read_to_string(dir.path().join(name)).unwrap(), old.replace('x', "y"));
		assert_eq!(fs::read(dir.path().join("miss")).unwrap(), b"no hits");
		assert_eq!(
			capture.out(),
			concat!(
				"--- \"a file\"\n+++ \"a file\"\n",
				"@@ -2,3 +2,3 @@\n before\r\n-x1\r\n+y1\r\n after\r\n",
				"@@ -7,2 +7,2 @@\n cut\r\n",
				"-x2\n\\ No newline at end of file\n+y2\n\\ No newline at end of file\n",
			)
		);

		let args = ["-U", "0", "--expect", "2", r"(y\d)", "$1", name];
		let (code, capture) = run_util::<Sd>(&args, "", dir.path());
		assert_eq!((code, capture.err(), capture.out()), (0, String::new(), String::new()));
	}

	#[test]
	fn unified_handles_empty_ranges_and_final_newline_changes() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("f");
		fs::write(&path, "").unwrap();
		for (find, replacement, expected, body) in [
			("^", r"x\n", "x\n", "@@ -0,0 +1 @@\n+x\n"),
			(r"\n", "", "x", "@@ -1 +1 @@\n-x\n+x\n\\ No newline at end of file\n"),
			("x", "", "", "@@ -1 +0,0 @@\n-x\n\\ No newline at end of file\n"),
		] {
			let (code, capture) = run_util::<Sd>(
				&["--unified", "0", "--expect", "1", find, replacement, "f"],
				"",
				dir.path(),
			);
			assert_eq!((code, capture.err()), (0, String::new()));
			assert_eq!(capture.out(), format!("--- f\n+++ f\n{body}"));
			assert_eq!(fs::read_to_string(&path).unwrap(), expected);
		}
	}

	#[test]
	fn binary_changes_report_only_the_filename_and_preserve_bytes() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("nul"), b"x\0").unwrap();
		fs::write(dir.path().join("invalid"), b"\xffx").unwrap();
		let args = ["-F", "-U", "0", "--expect", "1", "x", "$0", "nul", "invalid"];
		let (code, capture) = run_util::<Sd>(&args, "", dir.path());
		assert_eq!((code, capture.err()), (0, String::new()));
		assert_eq!(capture.out(), "Binary file nul changed\nBinary file invalid changed\n");
		assert_eq!(fs::read(dir.path().join("nul")).unwrap(), b"$0\0");
		assert_eq!(fs::read(dir.path().join("invalid")).unwrap(), b"\xff$0");
	}

	#[test]
	fn unified_requires_in_place_operands() {
		for args in [&["-U", "0", "a", "b"][..], &["-p", "-U", "0", "a", "b", "file"]] {
			let (code, out, err) = filter(args, "a");
			assert_eq!((code, out.as_str()), (2, ""));
			assert!(!err.is_empty());
		}
	}

	#[test]
	fn ambiguous_numbered_capture_is_rejected() {
		let err = |replacement: &str| filter(&["find", replacement], "find");
		assert_eq!(
			err("before $1bad after"),
			(
				1,
				String::new(),
				"sd: The numbered capture group `$1` in the replacement text is ambiguous.\nhint: \
				 Use curly braces to disambiguate it `${1}bad`.\nbefore $1bad after\n        ^^^^\n"
					.into()
			)
		);
		// Control characters render one column wide, keeping the carets aligned.
		assert_eq!(
			err("\r\n\t$1bad\r").2,
			"sd: The numbered capture group `$1` in the replacement text is ambiguous.\nhint: Use \
			 curly braces to disambiguate it `${1}bad`.\n␍␊␉$1bad␍\n    ^^^^\n"
		);
		for fine in ["$1 bad", "${1}bad", "$$1bad", "$name1"] {
			assert_eq!(err(fine).0, 0, "{fine:?}");
		}
	}

	#[test]
	fn invalid_regex_reports_the_parse_error() {
		let (code, out, err) = filter(&["(", "x"], "(");
		assert_eq!((code, out.as_str()), (1, ""));
		assert!(err.starts_with("sd: regex parse error:"), "stderr: {err:?}");
	}

	#[test]
	fn in_place_rewrites_only_changed_files() {
		let dir = tempfile::tempdir().unwrap();
		let (hit, miss) = (dir.path().join("hit"), dir.path().join("miss"));
		fs::write(&hit, "old old").unwrap();
		fs::write(&miss, "nothing").unwrap();
		#[cfg(unix)]
		let inode = |path: &std::path::Path| std::os::unix::fs::MetadataExt::ino(&fs::metadata(path).unwrap());
		#[cfg(unix)]
		let miss_inode = inode(&miss);

		let (code, capture) = run_util::<Sd>(&["old", "new", "hit", "miss"], "", dir.path());

		assert_eq!((code, capture.out(), capture.err()), (0, String::new(), String::new()));
		assert_eq!(fs::read_to_string(&hit).unwrap(), "new new");
		assert_eq!(fs::read_to_string(&miss).unwrap(), "nothing");
		#[cfg(unix)]
		assert_eq!(inode(&miss), miss_inode, "an unchanged file must not be replaced");
		let names: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
		assert_eq!(names.len(), 2, "temporary files left behind: {names:?}");
	}

	#[cfg(unix)]
	#[test]
	fn in_place_edits_a_symlink_target_and_keeps_the_link() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("target"), "abc").unwrap();
		std::os::unix::fs::symlink("target", dir.path().join("link")).unwrap();

		let (code, capture) = run_util::<Sd>(&["abc", "def", "link"], "", dir.path());

		assert_eq!((code, capture.err()), (0, String::new()));
		assert_eq!(fs::read_to_string(dir.path().join("target")).unwrap(), "def");
		assert!(fs::symlink_metadata(dir.path().join("link")).unwrap().file_type().is_symlink());
	}

	#[test]
	fn unreadable_operand_aborts_before_any_write() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("good"), "old").unwrap();

		let (code, capture) = run_util::<Sd>(&["old", "new", "good", "missing"], "", dir.path());

		assert_eq!(
			(code, capture.out(), capture.err()),
			(1, String::new(), "sd: missing: No such file or directory\n".into())
		);
		assert_eq!(fs::read_to_string(dir.path().join("good")).unwrap(), "old");
	}

	#[test]
	fn preview_prints_results_without_writing() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a"), "x1").unwrap();
		fs::write(dir.path().join("b"), "y").unwrap();

		let (code, capture) = run_util::<Sd>(&["-p", "x", "z", "a", "b"], "", dir.path());
		assert_eq!(
			(code, capture.out(), capture.err()),
			(0, "----- FILE a -----\nz1----- FILE b -----\ny".into(), String::new())
		);
		let (code, capture) = run_util::<Sd>(&["-p", "x", "z", "a"], "", dir.path());
		assert_eq!((code, capture.out()), (0, "z1".into()));
		assert_eq!(fs::read_to_string(dir.path().join("a")).unwrap(), "x1");
	}

	#[test]
	fn unescape_expands_known_escapes_and_keeps_the_rest() {
		for (input, expected) in [
			(r"a\tb\n", "a\tb\n"),
			// The character after a hex or unicode escape survives.
			(r"\x41B", "AB"),
			(r"\u00e9!", "é!"),
			(r#"\'\"\\n"#, r#"'"\n"#),
			(r"\xG \u00Z1 \q", r"\xG \u00Z1 \q"),
			(r"trailing\", r"trailing\"),
		] {
			assert_eq!(unescape(input), expected, "{input:?}");
		}
	}
}
