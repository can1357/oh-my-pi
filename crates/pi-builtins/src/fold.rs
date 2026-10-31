//! `fold` builtin: wrap each input line to fit in a specified width.
//!
//! Wraps by display columns for multibyte input and supports `-c`.

use std::{
	ffi::OsString,
	io::{self, Read, Write},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use uucore::display::Quotable;

use crate::host::{Host, Utility, format_usage, matches_parser, strip_errno, util};

mod options {
	pub static BYTES: &str = "bytes";
	pub static CHARACTERS: &str = "characters";
	pub static SPACES: &str = "spaces";
	pub static WIDTH: &str = "width";
	pub static FILE: &str = "file";
}

const TAB_WIDTH: usize = 8;
/// GNU's `line_out` capacity (`IO_BUFSIZE`): a longer pending line is
/// written without a newline, which `-s` then cannot reach back into.
const LINE_CAPACITY: usize = 256 * 1024;
const READ_CHUNK: usize = 64 * 1024;
const MAX_WIDTH: usize = usize::MAX - TAB_WIDTH - 1;

/// Parsed `fold` invocation.
pub(crate) struct Fold {
	matches: ArgMatches,
}

matches_parser!(Fold, app);

impl Utility for Fold {
	const NAME: &'static str = "fold";

	/// Obsolete `-NUM`, handled like uutils' `handle_obsolete`: the first
	/// argument that is `-` plus a digit is the width unless `-w` is given.
	/// It moves to the front as `-wNUM`, so an explicit `-w` overrides it.
	fn rewrite_argv(mut argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		// Unlike uutils, the value of a separate `-w`/`--width` word is not
		// mistaken for `-NUM`, so `-w -3` reports the invalid width like GNU.
		let mut value_next = false;
		let obsolete = argv.iter().skip(1).take_while(|arg| *arg != "--").position(|arg| {
			let bytes = arg.as_encoded_bytes();
			let is_value = std::mem::replace(
				&mut value_next,
				bytes == b"-w" || (bytes.len() > 2 && b"--width".starts_with(bytes)),
			);
			!is_value && bytes.len() > 1 && bytes[0] == b'-' && bytes[1].is_ascii_digit()
		});
		if let Some(index) = obsolete {
			let number = argv.remove(index + 1);
			let mut width = OsString::from("-w");
			// SAFETY: dropping the leading ASCII `-` keeps a valid OS string.
			width.push(unsafe { OsString::from_encoded_bytes_unchecked(number.as_encoded_bytes()[1..].to_vec()) });
			argv.insert(1, width);
		}
		Ok(argv)
	}

	fn run(self, host: &mut Host) -> i32 {
		let mode = if self.matches.get_flag(options::BYTES)
			&& last_index(&self.matches, options::BYTES) > last_index(&self.matches, options::CHARACTERS)
		{
			Mode::Bytes
		} else if self.matches.get_flag(options::CHARACTERS) {
			Mode::Characters
		} else {
			Mode::Columns
		};
		let width = match self.matches.get_one::<OsString>(options::WIDTH) {
			None => 80,
			Some(value) => match parse_width(value) {
				Ok(width) => width,
				Err(range) => {
					let suffix = if range { ": Result too large" } else { "" };
					host.error(format!("invalid number of columns: {}{suffix}", value.quote()), 1);
					return 1;
				},
			},
		};
		let files: Vec<OsString> = self
			.matches
			.get_many::<OsString>(options::FILE)
			.map_or_else(|| vec![OsString::from("-")], |files| files.cloned().collect());

		let mut folder = Folder {
			width,
			mode,
			spaces: self.matches.get_flag(options::SPACES),
			utf8: crate::locale::ctype_is_utf8(host),
			last_width: 0,
			line: Vec::new(),
		};
		let mut out = host.stdout_writer();
		let mut failed = false;
		for name in files {
			if host.is_cancelled() {
				break;
			}
			let cancelled = host_cancel(host);
			let result = if name == "-" {
				folder.fold(&mut host.stdin, &mut out, cancelled)
			} else {
				match host.fs().open(host.resolve(&name)) {
					Ok(mut file) => folder.fold(&mut file, &mut out, cancelled),
					Err(error) => Err(FoldError::Read(error)),
				}
			};
			match result {
				Ok(()) => {},
				Err(FoldError::Write(error)) => return write_failure(host, &error),
				Err(FoldError::Read(error)) => {
					let _ = writeln!(host.stderr, "fold: {}: {}", name.maybe_quote(), strip_errno(&error));
					failed = true;
				},
			}
		}
		if let Err(error) = out.flush() {
			return write_failure(host, &error);
		}
		drop(out);
		if failed {
			host.fail(1);
		}
		host.exit_code()
	}
}

fn host_cancel(host: &Host) -> impl Fn() -> bool + use<> {
	let flag = host.cancel_flag();
	move || flag.load(std::sync::atomic::Ordering::Relaxed)
}

fn write_failure(host: &mut Host, error: &io::Error) -> i32 {
	if error.kind() == io::ErrorKind::BrokenPipe {
		return crate::host::SIGPIPE_EXIT_CODE;
	}
	let _ = writeln!(host.stderr, "fold: write error: {}", strip_errno(error));
	1
}

fn last_index(matches: &ArgMatches, id: &str) -> usize {
	if !matches.get_flag(id) {
		return 0;
	}
	matches.index_of(id).map_or(0, |index| index + 1)
}

/// Parses WIDTH with `str::parse::<usize>` like uutils fold, keeping GNU's
/// range 1..=SIZE_MAX-9. `Err(true)` is a range error (GNU appends "Result
/// too large"), `Err(false)` a malformed number.
fn parse_width(value: &OsString) -> Result<usize, bool> {
	let text = value.to_str().ok_or(false)?;
	match text.parse::<usize>() {
		Ok(0) => Err(true),
		Ok(width) if width > MAX_WIDTH => Err(true),
		Ok(width) => Ok(width),
		Err(error) => Err(*error.kind() == std::num::IntErrorKind::PosOverflow),
	}
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
	Columns,
	Bytes,
	Characters,
}

enum FoldError {
	Read(io::Error),
	Write(io::Error),
}

/// One decoded character: `ch` is `None` for an encoding error byte.
#[derive(Clone, Copy)]
struct Mcel {
	ch:  Option<char>,
	len: usize,
}

/// Decodes the character at the start of `bytes` (non-empty) like gnulib
/// `mcel_scan`: a truncated or invalid sequence is a one-byte error.
fn scan(bytes: &[u8], utf8: bool) -> Mcel {
	let lead = bytes[0];
	if lead < 0x80 {
		return Mcel { ch: Some(char::from(lead)), len: 1 };
	}
	if !utf8 {
		return Mcel { ch: None, len: 1 };
	}
	let len = match lead {
		0xC2..=0xDF => 2,
		0xE0..=0xEF => 3,
		0xF0..=0xF4 => 4,
		_ => return Mcel { ch: None, len: 1 },
	};
	match bytes.get(..len).and_then(|seq| std::str::from_utf8(seq).ok()) {
		Some(text) => Mcel { ch: text.chars().next(), len },
		None => Mcel { ch: None, len: 1 },
	}
}

/// GNU `c32issep` on glibc (`c32isblank`): blanks that are not no-break.
const fn is_sep(ch: char) -> bool {
	matches!(
		ch,
		' ' | '\t' | '\u{1680}' | '\u{2000}'..='\u{2006}' | '\u{2008}'..='\u{200A}' | '\u{205F}' | '\u{3000}'
	)
}

/// `c32width`, with GNU fold's fallback of 1 for non-printable characters.
fn char_width(ch: Option<char>) -> usize {
	match ch {
		None => 1,
		Some('\0') => 0,
		Some(c) if c.is_control() => 1,
		Some(c) => xutf::width_char(c),
	}
}

struct Folder {
	width:      usize,
	mode:       Mode,
	spaces:     bool,
	utf8:       bool,
	/// Width of the last counted character; GNU keeps it across lines and files.
	last_width: usize,
	line:       Vec<u8>,
}

impl Folder {
	/// GNU `adjust_column`, including its unsigned wraparound on `\b`.
	fn adjust(&mut self, column: usize, g: Mcel) -> usize {
		if self.mode == Mode::Bytes {
			return column.wrapping_add(g.len);
		}
		match g.ch {
			Some('\u{8}') => {
				if column > 0 {
					column.wrapping_sub(self.last_width)
				} else {
					column
				}
			},
			Some('\r') => 0,
			Some('\t') => column.wrapping_add(TAB_WIDTH - column % TAB_WIDTH),
			ch => {
				self.last_width = if self.mode == Mode::Characters { 1 } else { char_width(ch) };
				column.wrapping_add(self.last_width)
			},
		}
	}

	fn fold(
		&mut self,
		input: &mut dyn Read,
		out: &mut dyn Write,
		cancelled: impl Fn() -> bool,
	) -> Result<(), FoldError> {
		let mut buf = vec![0u8; READ_CHUNK];
		let (mut start, mut end) = (0usize, 0usize);
		let mut eof = false;
		let mut column = 0usize;
		self.line.clear();
		loop {
			if end - start < 4 && !eof {
				buf.copy_within(start..end, 0);
				end -= start;
				start = 0;
				if cancelled() {
					break;
				}
				match input.read(&mut buf[end..]) {
					Ok(0) => eof = true,
					Ok(n) => end += n,
					Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
					Err(error) => {
						self.flush_line(out, false)?;
						return Err(FoldError::Read(error));
					},
				}
				continue;
			}
			if start == end {
				break;
			}
			let g = scan(&buf[start..end], self.utf8);
			let bytes = start..start + g.len;
			start += g.len;
			if g.ch == Some('\n') {
				self.flush_line(out, true)?;
				column = 0;
				continue;
			}
			loop {
				column = self.adjust(column, g);
				if column <= self.width {
					break;
				}
				if self.spaces && let Some(split) = self.last_sep_end() {
					out.write_all(&self.line[..split]).map_err(FoldError::Write)?;
					out.write_all(b"\n").map_err(FoldError::Write)?;
					self.line.drain(..split);
					column = 0;
					let mut at = 0;
					while at < self.line.len() {
						let g2 = scan(&self.line[at..], self.utf8);
						column = self.adjust(column, g2);
						at += g2.len;
					}
					continue;
				}
				if self.line.is_empty() {
					break;
				}
				self.flush_line(out, true)?;
				column = 0;
			}
			if !self.line.is_empty() && LINE_CAPACITY <= self.line.len() + g.len {
				self.flush_line(out, false)?;
			}
			self.line.extend_from_slice(&buf[bytes]);
		}
		self.flush_line(out, false)
	}

	/// End offset of the last separator in the pending line, if any.
	fn last_sep_end(&self) -> Option<usize> {
		let mut at = 0;
		let mut found = None;
		while at < self.line.len() {
			let g = scan(&self.line[at..], self.utf8);
			at += g.len;
			if g.ch.is_some_and(is_sep) {
				found = Some(at);
			}
		}
		found
	}

	fn flush_line(&mut self, out: &mut dyn Write, newline: bool) -> Result<(), FoldError> {
		out.write_all(&self.line).map_err(FoldError::Write)?;
		if newline {
			out.write_all(b"\n").map_err(FoldError::Write)?;
		}
		self.line.clear();
		Ok(())
	}
}

/// The `fold` argument model.
fn app() -> Command {
	Command::new(Fold::NAME)
		.version("9.12")
		.override_usage(format_usage("fold [OPTION]... [FILE]..."))
		.about(
			"Wrap input lines in each FILE, writing to standard output.\n\nWith no FILE, or when \
			 FILE is -, read standard input.",
		)
		.infer_long_args(true)
		.args_override_self(true)
		.arg(
			Arg::new(options::BYTES)
				.short('b')
				.long(options::BYTES)
				.help("count bytes rather than columns")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::CHARACTERS)
				.short('c')
				.long(options::CHARACTERS)
				.help("count characters rather than columns")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::SPACES)
				.short('s')
				.long(options::SPACES)
				.help("break after blanks, or in words greater than WIDTH")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::WIDTH)
				.short('w')
				.long(options::WIDTH)
				.value_name("WIDTH")
				.help("use WIDTH columns instead of 80")
				.allow_hyphen_values(true)
				.value_parser(clap::value_parser!(OsString)),
		)
		.arg(
			Arg::new(options::FILE)
				.hide(true)
				.action(ArgAction::Append)
				.value_parser(clap::value_parser!(OsString))
				.value_hint(clap::ValueHint::FilePath),
		)
}

/// Creates the `fold` builtin registration.
pub(crate) fn fold_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Fold, SE>()
}

#[cfg(test)]
mod tests {
	use std::{fs, path::PathBuf};

	use super::Fold;
	use crate::host::{Host, Utility, run_util};

	fn run(stdin: &[u8], args: &[&str], locale: &str) -> (i32, Vec<u8>, String) {
		run_in(PathBuf::from("."), stdin, args, locale)
	}

	fn run_in(cwd: PathBuf, stdin: &[u8], args: &[&str], locale: &str) -> (i32, Vec<u8>, String) {
		let (mut host, capture) = Host::for_test("fold", stdin.to_vec(), cwd);
		host.set_test_var("LC_ALL", locale);
		let argv: Vec<std::ffi::OsString> = std::iter::once("fold")
			.chain(args.iter().copied())
			.map(Into::into)
			.collect();
		let argv = Fold::rewrite_argv(argv).unwrap();
		let parsed = <Fold as clap::Parser>::try_parse_from(argv).expect("arguments parse");
		let code = parsed.run(&mut host);
		(code, capture.stdout(), capture.err())
	}

	fn ok(stdin: &[u8], args: &[&str], locale: &str) -> Vec<u8> {
		let (code, out, err) = run(stdin, args, locale);
		assert_eq!((code, err.as_str()), (0, ""), "{args:?}");
		out
	}

	#[test]
	fn wraps_long_ascii_line_and_keeps_missing_final_newline() {
		assert_eq!(ok(b"abcdefghijklmnopqrstuvwxyz", &["-w", "10"], "C"), b"abcdefghij\nklmnopqrst\nuvwxyz");
		assert_eq!(ok(b"", &["-w", "3"], "C"), b"");
		assert_eq!(ok(&[b'x'; 85], &[], "C").len(), 86);
	}

	#[test]
	fn spaces_break_after_last_blank_or_mid_word() {
		assert_eq!(ok(b"the quick brown fox\n", &["-s", "-w", "10"], "C"), b"the quick \nbrown fox\n");
		assert_eq!(ok(b"abcdefghij kl\n", &["-s", "-w", "4"], "C"), b"abcd\nefgh\nij \nkl\n");
	}

	#[test]
	fn obsolete_number_options_set_width() {
		assert_eq!(ok(b"abcdefghij\n", &["-5"], "C"), b"abcde\nfghij\n");
		assert_eq!(ok(b"abcdefghij\n", &["-s", "-3"], "C"), b"abc\ndef\nghi\nj\n");
		// An explicit -w wins over the obsolete form, as in uutils.
		assert_eq!(ok(b"abcdefghij\n", &["-12", "-w3"], "C"), b"abc\ndef\nghi\nj\n");
		let (code, out, err) = run(b"x", &["-3s"], "C");
		assert_eq!((code, out.as_slice(), err.as_str()), (1, &b""[..], "fold: invalid number of columns: '3s'\n"));
	}

	#[test]
	fn invalid_widths_match_gnu_diagnostics() {
		for (arg, msg) in [
			("0", "'0': Result too large"),
			("abc", "'abc'"),
			("-3", "'-3'"),
			("18446744073709551607", "'18446744073709551607': Result too large"),
		] {
			let (code, out, err) = run(b"x", &["-w", arg], "C");
			assert_eq!((code, out.len()), (1, 0));
			assert_eq!(err, format!("fold: invalid number of columns: {msg}\n"));
		}
		assert_eq!(ok(b"abcd\n", &["-w", "+03"], "C"), b"abc\nd\n");
	}

	#[test]
	fn control_characters_move_the_column() {
		assert_eq!(ok(b"ab\x08\x08cdefgh\n", &["-w", "3"], "C"), b"ab\x08\x08cde\nfgh\n");
		assert_eq!(ok(b"ab\x08\x08cdefgh\n", &["-b", "-w", "3"], "C"), b"ab\x08\n\x08cd\nefg\nh\n");
		assert_eq!(ok(b"a\tbc\n", &["-w", "9"], "C"), b"a\tb\nc\n");
		assert_eq!(ok(b"abc\rdefg\n", &["-w", "4"], "C"), b"abc\rdefg\n");
		assert_eq!(ok(b"a\0bc\n", &["-w", "2"], "C"), b"a\0b\nc\n");
	}

	#[test]
	fn utf8_locale_counts_display_columns_and_never_splits_characters() {
		let cjk = "你你你\n".as_bytes();
		assert_eq!(ok(cjk, &["-w", "3"], "en_US.UTF-8"), "你\n你\n你\n".as_bytes());
		assert_eq!(ok(cjk, &["-c", "-w", "2"], "en_US.UTF-8"), "你你\n你\n".as_bytes());
		assert_eq!(ok(cjk, &["-b", "-w", "4"], "en_US.UTF-8"), "你\n你\n你\n".as_bytes());
		// The C locale counts bytes as columns and may split characters.
		assert_eq!(ok("你\n".as_bytes(), &["-w", "2"], "C"), b"\xe4\xbd\n\xa0\n");
		// Combining marks are zero width; invalid bytes pass through as width 1.
		assert_eq!(ok("ab\u{e9}\u{301}cd\n".as_bytes(), &["-w", "3"], "en_US.UTF-8"), "ab\u{e9}\u{301}\ncd\n".as_bytes());
		assert_eq!(ok(b"\xe4\xbda\n", &["-w", "1"], "en_US.UTF-8"), b"\xe4\n\xbd\na\n");
		// Backspace after a wide character wraps the unsigned column like GNU.
		assert_eq!(ok("a你\x08\x08xyz\n".as_bytes(), &["-w", "10"], "en_US.UTF-8"), "a你\x08\n\x08xyz\n".as_bytes());
		// No-break space is not a break point; ideographic space is.
		assert_eq!(ok("a\u{a0}b c\n".as_bytes(), &["-s", "-w", "3"], "en_US.UTF-8"), "a\u{a0}b\n c\n".as_bytes());
		assert_eq!(ok("a\u{3000}bcd\n".as_bytes(), &["-s", "-w", "3"], "en_US.UTF-8"), "a\u{3000}\nbcd\n".as_bytes());
	}

	#[test]
	fn missing_file_is_reported_and_later_files_still_fold() {
		let dir = tempfile::tempdir().unwrap();
		let root = fs::canonicalize(dir.path()).unwrap();
		fs::write(root.join("in"), "abcdef").unwrap();
		let (code, out, err) = run_in(root, b"xyz\n", &["-w4", "missing", "in", "-"], "C");
		assert_eq!(code, 1);
		assert_eq!(out, b"abcd\nefxyz\n");
		assert_eq!(err, "fold: missing: No such file or directory\n");
	}

	#[test]
	fn help_mentions_name() {
		let (code, capture) = run_util::<Fold>(&["--help"], "", ".");
		assert_eq!(code, 0);
		assert!(capture.out().contains("fold"));
	}
}
