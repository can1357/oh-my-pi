//! `isutf8` builtin: check whether files (or, with no operands, standard input)
//! are valid UTF-8.
//!
//! This moreutils-inspired implementation runs in process so it can validate
//! shell-relative files without spawning an external command. Diagnostic
//! coordinates follow moreutils semantics: `line` is 1-based (counting `\n`),
//! `char` is the 1-based character position within that line, and `byte` is the
//! 0-based file offset of the first byte of the invalid sequence. Input is
//! streamed in 64 KiB chunks; a multi-byte sequence split across a chunk
//! boundary carries its incomplete tail (at most 3 bytes) into the next chunk,
//! and an incomplete tail at EOF counts as invalid.
//!
//! Standard input is reported as `(standard input)`. With `--invert` the exit
//! status and `--list` output treat valid inputs as failures; the default
//! diagnostic is still printed for invalid inputs. Exit codes: 0 = every input
//! passes the (possibly inverted) predicate, 1 = at least one input fails it,
//! 2 = an I/O error opening or reading a file (remaining files are still
//! checked).

use std::{
	ffi::{OsStr, OsString},
	fs::File,
	io::{self, Read, Write},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser};

use crate::host::{Host, Utility, format_usage, matches_parser, util};

const OPT_QUIET: &str = "quiet";
const OPT_LIST: &str = "list";
const OPT_INVERT: &str = "invert";
const ARG_FILES: &str = "files";
const CHUNK_SIZE: usize = 64 * 1024;
const STDIN_NAME: &str = "(standard input)";

enum Verdict {
	Valid,
	Invalid { line: u64, character: u64, byte: u64 },
	Cancelled,
}

/// Parsed `isutf8` invocation.
pub(crate) struct Isutf8 {
	matches: ArgMatches,
}

matches_parser!(Isutf8, command);

impl Utility for Isutf8 {
	const NAME: &'static str = "isutf8";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		let quiet = self.matches.get_flag(OPT_QUIET);
		let list = self.matches.get_flag(OPT_LIST);
		let invert = self.matches.get_flag(OPT_INVERT);
		let files: Vec<OsString> = self
			.matches
			.get_many::<OsString>(ARG_FILES)
			.map_or_else(Vec::new, |values| values.cloned().collect());
		let cancel = host.cancel_flag();

		let mut any_failed = false;
		let mut io_error = false;
		if files.is_empty() {
			match validate(&mut host.stdin, &cancel) {
				Err(err) => {
				host.error(format!("{STDIN_NAME}: {err}"), 2);
				io_error = true;
				},
				Ok(Verdict::Cancelled) => return 130,
				Ok(verdict) => {
					any_failed = report_verdict(
						host,
						STDIN_NAME,
						verdict,
						quiet,
						list,
						invert,
					);
				},
			}
		} else {
			for name in &files {
				let display = display_name(name);
				let result = if name == "-" {
					validate(&mut host.stdin, &cancel)
				} else {
					File::open(host.resolve(name)).and_then(|mut file| validate(&mut file, &cancel))
				};
				let verdict = match result {
					Err(err) => {
						host.error(format!("{display}: {err}"), 2);
						io_error = true;
						continue;
					},
					Ok(Verdict::Cancelled) => return 130,
					Ok(verdict) => verdict,
				};
				any_failed |= report_verdict(host, &display, verdict, quiet, list, invert);
			}
		}

		if io_error { 2 } else { i32::from(any_failed) }
	}
}

fn report_verdict(
	host: &mut Host,
	display: &str,
	verdict: Verdict,
	quiet: bool,
	list: bool,
	invert: bool,
) -> bool {
	let valid = match verdict {
		Verdict::Valid => true,
		Verdict::Invalid { line, character, byte } => {
			if !quiet && !list {
				let _ = writeln!(
					host.stdout,
					"{display}: line {line}, char {character}, byte {byte}: invalid UTF-8 code"
				);
			}
			false
		},
		Verdict::Cancelled => unreachable!("cancellation is handled by the caller"),
	};
	// An input fails when its validity matches the inversion flag.
	let failed = valid == invert;
	if failed && list && !quiet {
		let _ = writeln!(host.stdout, "{display}");
	}
	failed
}

fn command() -> Command {
	Command::new(Isutf8::NAME)
		.version("isutf8 (pi-shell) 17.2.11")
		.about("Check whether files are valid UTF-8.")
		.override_usage(format_usage("isutf8 [-q|--quiet] [-l|--list] [-i|--invert] [FILE]..."))
		.disable_help_flag(true)
		.disable_version_flag(true)
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_QUIET)
				.short('q')
				.long(OPT_QUIET)
				.help("suppress all output; report via exit status only")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_LIST)
				.short('l')
				.long(OPT_LIST)
				.help("print only the names of files failing the check")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_INVERT)
				.short('i')
				.long(OPT_INVERT)
				.help("invert the check: valid files fail")
				.action(ArgAction::SetTrue),
		)
		.arg(Arg::new("help").long("help").action(ArgAction::Help))
		.arg(
			Arg::new(ARG_FILES)
				.value_name("FILE")
				.num_args(0..)
				.value_parser(ValueParser::os_string()),
		)
}

/// Streams `input` in [`CHUNK_SIZE`] chunks, carrying an incomplete multi-byte
/// tail (at most 3 bytes) across chunk boundaries.
fn validate(input: &mut impl Read, cancel: &Arc<AtomicBool>) -> io::Result<Verdict> {
	let mut buf = vec![0u8; CHUNK_SIZE + 3];
	let mut carry = 0usize; // bytes at buf[..carry] carried from the previous chunk
	let mut offset = 0u64; // file offset of buf[0]
	let mut line = 1u64;
	let mut chars_in_line = 0u64; // complete chars decoded on the current line

	loop {
		if cancel.load(Ordering::Relaxed) {
			return Ok(Verdict::Cancelled);
		}
		let read = input.read(&mut buf[carry..carry + CHUNK_SIZE])?;
		let eof = read == 0;
		let data_len = carry + read;
		if data_len == 0 {
			return Ok(Verdict::Valid);
		}

		let mut pos = 0usize;
		while pos < data_len {
			match std::str::from_utf8(&buf[pos..data_len]) {
				Ok(_) => {
					advance(&buf[pos..data_len], &mut line, &mut chars_in_line);
					pos = data_len;
				},
				Err(err) => {
					advance(&buf[pos..pos + err.valid_up_to()], &mut line, &mut chars_in_line);
					pos += err.valid_up_to();
					if err.error_len().is_some() || eof {
						// Bad sequence, or an incomplete one truncated by EOF.
						return Ok(Verdict::Invalid {
							line,
							character: chars_in_line + 1,
							byte: offset + pos as u64,
						});
					}
					break; // incomplete tail: carry it into the next chunk
				},
			}
		}
		if eof {
			return Ok(Verdict::Valid);
		}
		// Slide the unconsumed tail (at most 3 bytes) to the front of the buffer.
		buf.copy_within(pos..data_len, 0);
		carry = data_len - pos;
		offset += pos as u64;
	}
}

/// Updates line/char counters over `text`, a slice already known to be valid
/// UTF-8 (chars are counted as non-continuation bytes, so no re-decode).
fn advance(text: &[u8], line: &mut u64, chars_in_line: &mut u64) {
	match memchr::memrchr(b'\n', text) {
		Some(last) => {
			*line += memchr::memchr_iter(b'\n', text).count() as u64;
			*chars_in_line = count_chars(&text[last + 1..]);
		},
		None => *chars_in_line += count_chars(text),
	}
}

fn count_chars(bytes: &[u8]) -> u64 {
	bytes.iter().filter(|&&byte| (byte & 0xc0) != 0x80).count() as u64
}

fn display_name(name: &OsStr) -> String {
	if name == "-" {
		STDIN_NAME.to_owned()
	} else {
		name.to_string_lossy().into_owned()
	}
}

/// Creates the `isutf8` builtin registration.
pub(crate) fn isutf8_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Isutf8, SE>()
}

#[cfg(test)]
mod tests {
	use std::fs;

	use super::Isutf8;
	use crate::host::run_util;

	fn run_in(cwd: &std::path::Path, stdin: &str, args: &[&str]) -> (i32, String, String) {
		let (code, capture) = run_util::<Isutf8>(args, stdin, cwd);
		(code, capture.out(), capture.err())
	}

	#[test]
	fn valid_ascii_and_multibyte_pass_silently() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("ok"), "hello é 🎉\nplain ascii\n").unwrap();

		assert_eq!(run_in(dir.path(), "", &["ok"]), (0, String::new(), String::new()));
	}

	#[test]
	fn invalid_sequence_reports_line_char_and_byte() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("bad"), b"ab\xC3(\n").unwrap();
		fs::write(dir.path().join("late"), b"a\nb\n\xFF").unwrap();

		let (code, stdout, stderr) = run_in(dir.path(), "", &["bad"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "bad: line 1, char 3, byte 2: invalid UTF-8 code\n");
		assert_eq!(stderr, "");

		let (code, stdout, _) = run_in(dir.path(), "", &["late"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "late: line 3, char 1, byte 4: invalid UTF-8 code\n");
	}

	#[test]
	fn multibyte_sequence_straddling_chunk_boundary_is_valid() {
		let dir = tempfile::tempdir().unwrap();
		let mut bytes = vec![b'a'; 65535];
		bytes.extend_from_slice("é".as_bytes());
		fs::write(dir.path().join("straddle"), &bytes).unwrap();

		assert_eq!(
			run_in(dir.path(), "", &["straddle"]),
			(0, String::new(), String::new())
		);
	}

	#[test]
	fn truncated_sequence_at_chunk_boundary_is_invalid() {
		let dir = tempfile::tempdir().unwrap();
		let mut bytes = vec![b'a'; 65535];
		bytes.push(0xc3);
		bytes.extend_from_slice(b"zzz");
		fs::write(dir.path().join("cut"), &bytes).unwrap();

		let (code, stdout, stderr) = run_in(dir.path(), "", &["cut"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "cut: line 1, char 65536, byte 65535: invalid UTF-8 code\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn truncated_multibyte_at_eof_is_invalid() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("eof"), b"abc\xE2\x82").unwrap();

		let (code, stdout, _) = run_in(dir.path(), "", &["eof"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "eof: line 1, char 4, byte 3: invalid UTF-8 code\n");
	}

	#[test]
	fn quiet_suppresses_output_but_keeps_status() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("bad"), b"\xFF").unwrap();

		assert_eq!(
			run_in(dir.path(), "", &["-q", "bad"]),
			(1, String::new(), String::new())
		);
	}

	#[test]
	fn list_prints_failing_names_and_invert_flips_them() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("good"), "fine\n").unwrap();
		fs::write(dir.path().join("bad"), b"\xFF\n").unwrap();

		let (code, stdout, stderr) = run_in(dir.path(), "", &["-l", "good", "bad"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (1, "bad\n", ""));

		let (code, stdout, stderr) =
			run_in(dir.path(), "", &["-l", "-i", "good", "bad"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (1, "good\n", ""));
	}

	#[test]
	fn invert_flips_exit_status_without_list() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("good"), "fine\n").unwrap();
		fs::write(dir.path().join("bad"), b"\xFF").unwrap();

		assert_eq!(run_in(dir.path(), "", &["-q", "-i", "good"]).0, 1);
		assert_eq!(run_in(dir.path(), "", &["-q", "-i", "bad"]).0, 0);
	}

	#[test]
	fn stdin_is_validated_when_no_files_given() {
		let dir = tempfile::tempdir().unwrap();

		assert_eq!(
			run_in(dir.path(), "héllo\n", &[]),
			(0, String::new(), String::new())
		);

		assert_eq!(
			run_in(dir.path(), "explicit\n", &["-"]),
			(0, String::new(), String::new())
		);
	}

	#[test]
	fn missing_file_reports_io_error_and_continues() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("bad"), b"\xFF").unwrap();

		let (code, stdout, stderr) = run_in(dir.path(), "", &["nope", "bad"]);
		assert_eq!(code, 2);
		assert_eq!(stdout, "bad: line 1, char 1, byte 0: invalid UTF-8 code\n");
		assert!(stderr.starts_with("isutf8: nope: "), "stderr: {stderr}");
	}
}
