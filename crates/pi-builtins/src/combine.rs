//! `combine` builtin: boolean set operations on the lines of two files.
//!
//! Ported from the moreutils-inspired in-process implementation in `pi-shell`.
//! Keeping the utility in process lets it use the shell's scoped streams,
//! working directory, and cancellation rather than spawning an external tool.
//!
//! `combine FILE1 OP FILE2` accepts the case-insensitive operators `and`, `not`,
//! `or`, and `xor`. `-` names stdin, but only for one operand. Lines remain raw
//! byte strings; membership ignores a trailing newline, while output preserves
//! each original line exactly.

use std::{
	collections::HashSet,
	ffi::{OsStr, OsString},
	fs::File,
	io::{BufRead, BufReader, Write},
	sync::atomic::{AtomicBool, Ordering},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command, value_parser};

use crate::host::{Host, Utility, format_usage, matches_parser, util};

const ARG_FILE1: &str = "file1";
const ARG_OP: &str = "op";
const ARG_FILE2: &str = "file2";

#[derive(Clone, Copy, PartialEq)]
enum Op {
	And,
	Not,
	Or,
	Xor,
}

enum Error {
	Cancelled,
	Msg(String),
}

/// Parsed `combine` invocation.
pub(crate) struct Combine {
	matches: ArgMatches,
}

matches_parser!(Combine, command);

impl Utility for Combine {
	const NAME: &'static str = "combine";

	fn run(self, host: &mut Host) -> i32 {
		let file1 = self
			.matches
			.get_one::<OsString>(ARG_FILE1)
			.expect("required")
			.clone();
		let op = self.matches.get_one::<String>(ARG_OP).expect("required");
		let file2 = self
			.matches
			.get_one::<OsString>(ARG_FILE2)
			.expect("required")
			.clone();

		match execute(&file1, op, &file2, host) {
			Ok(()) => 0,
			Err(Error::Cancelled) => 130,
			Err(Error::Msg(message)) => {
				host.error(message, 1);
				1
			},
		}
	}
}

/// The `combine` argument model.
fn command() -> Command {
	Command::new(Combine::NAME)
		.version("combine (pi-shell) 17.2.11")
		.about("Combine the lines of two files using boolean operations.")
		.override_usage(format_usage("combine FILE1 and|not|or|xor FILE2"))
		.disable_help_flag(true)
		.disable_version_flag(true)
		.arg(Arg::new("help").long("help").action(ArgAction::Help))
		.arg(
			Arg::new(ARG_FILE1)
				.value_name("FILE1")
				.required(true)
				.value_parser(value_parser!(OsString)),
		)
		.arg(Arg::new(ARG_OP).value_name("OP").required(true))
		.arg(
			Arg::new(ARG_FILE2)
				.value_name("FILE2")
				.required(true)
				.value_parser(value_parser!(OsString)),
		)
}

fn execute(file1: &OsStr, op: &str, file2: &OsStr, host: &mut Host) -> Result<(), Error> {
	let op = match op.to_ascii_lowercase().as_str() {
		"and" => Op::And,
		"not" => Op::Not,
		"or" => Op::Or,
		"xor" => Op::Xor,
		other => {
			return Err(Error::Msg(format!(
				"unknown operation '{other}' (expected and, not, or, xor)"
			)));
		},
	};
	let dash = OsStr::new("-");
	if file1 == dash && file2 == dash {
		return Err(Error::Msg("only one file can be stdin".into()));
	}

	// Open both up front so a missing FILE2 fails before stdin is consumed.
	let input1 = open_input(file1, host)?;
	let input2 = open_input(file2, host)?;
	let cancel = host.cancel_flag();

	match (input1, input2) {
		(Some(input1), Some(input2)) => operate(
			BufReader::new(input1),
			file1,
			BufReader::new(input2),
			file2,
			op,
			&cancel,
			&mut host.stdout,
		),
		(None, Some(input2)) => operate(
			BufReader::new(&mut host.stdin),
			file1,
			BufReader::new(input2),
			file2,
			op,
			&cancel,
			&mut host.stdout,
		),
		(Some(input1), None) => operate(
			BufReader::new(input1),
			file1,
			BufReader::new(&mut host.stdin),
			file2,
			op,
			&cancel,
			&mut host.stdout,
		),
		(None, None) => unreachable!("two stdin operands were rejected above"),
	}
}

fn operate(
	mut input1: impl BufRead,
	file1: &OsStr,
	mut input2: impl BufRead,
	file2: &OsStr,
	op: Op,
	cancel: &AtomicBool,
	out: &mut impl Write,
) -> Result<(), Error> {
	match op {
		Op::And | Op::Not => {
			// Membership side must be fully loaded before streaming FILE1.
			let lines2 = read_lines(&mut input2, file2, cancel)?;
			let set2: HashSet<&[u8]> = lines2.iter().map(|line| key(line)).collect();
			let keep_member = op == Op::And;
			each_line(&mut input1, file1, cancel, |line| {
				if set2.contains(key(line)) == keep_member {
					write_line(out, line)?;
				}
				Ok(())
			})?;
		},
		Op::Or => {
			each_line(&mut input1, file1, cancel, |line| write_line(out, line))?;
			each_line(&mut input2, file2, cancel, |line| write_line(out, line))?;
		},
		Op::Xor => {
			let lines1 = read_lines(&mut input1, file1, cancel)?;
			let lines2 = read_lines(&mut input2, file2, cancel)?;
			let set1: HashSet<&[u8]> = lines1.iter().map(|line| key(line)).collect();
			let set2: HashSet<&[u8]> = lines2.iter().map(|line| key(line)).collect();
			for line in &lines1 {
				if !set2.contains(key(line)) {
					write_line(out, line)?;
				}
			}
			for line in &lines2 {
				if !set1.contains(key(line)) {
					write_line(out, line)?;
				}
			}
		},
	}
	out.flush().map_err(|err| Error::Msg(err.to_string()))?;
	Ok(())
}

fn open_input(name: &OsStr, host: &Host) -> Result<Option<File>, Error> {
	if name == OsStr::new("-") {
		return Ok(None);
	}
	let path = host.resolve(name);
	let file = File::open(path).map_err(|err| Error::Msg(input_error(name, &err.to_string())))?;
	Ok(Some(file))
}

/// Streams `reader` line by line (trailing `\n` retained when present),
/// polling for cancellation between lines.
fn each_line(
	reader: &mut dyn BufRead,
	name: &OsStr,
	cancel: &AtomicBool,
	mut f: impl FnMut(&[u8]) -> Result<(), Error>,
) -> Result<(), Error> {
	let mut line = Vec::new();
	loop {
		if cancel.load(Ordering::Relaxed) {
			return Err(Error::Cancelled);
		}
		line.clear();
		let n = reader
			.read_until(b'\n', &mut line)
			.map_err(|err| Error::Msg(input_error(name, &err.to_string())))?;
		if n == 0 {
			return Ok(());
		}
		f(&line)?;
	}
}

fn read_lines(
	reader: &mut dyn BufRead,
	name: &OsStr,
	cancel: &AtomicBool,
) -> Result<Vec<Vec<u8>>, Error> {
	let mut lines = Vec::new();
	each_line(reader, name, cancel, |line| {
		lines.push(line.to_vec());
		Ok(())
	})?;
	Ok(lines)
}

/// Membership key: the line with any trailing newline stripped, so `foo`
/// (no newline) matches `foo\n`.
fn key(line: &[u8]) -> &[u8] {
	line.strip_suffix(b"\n").unwrap_or(line)
}

fn write_line(out: &mut impl Write, line: &[u8]) -> Result<(), Error> {
	out.write_all(line)
		.map_err(|err| Error::Msg(err.to_string()))
}

fn input_error(name: &OsStr, err: &str) -> String {
	format!("{}: {}", name.to_string_lossy(), err)
}

/// Creates the `combine` builtin registration.
pub(crate) fn combine_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Combine, SE>()
}

#[cfg(test)]
mod tests {
	use std::{fs, path::Path};

	use super::Combine;
	use crate::host::run_util;

	fn run_in(cwd: &Path, stdin: &str, args: &[&str]) -> (i32, Vec<u8>, String) {
		let (code, capture) = run_util::<Combine>(args, stdin, cwd);
		(code, capture.stdout(), capture.err())
	}

	fn fixture() -> tempfile::TempDir {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("one"), b"a\nb\na\nc\n").unwrap();
		fs::write(dir.path().join("two"), b"a\nc\nd\n").unwrap();
		dir
	}

	#[test]
	fn and_keeps_file1_order_and_duplicates() {
		let dir = fixture();
		let (code, stdout, stderr) = run_in(dir.path(), "", &["one", "and", "two"]);
		assert_eq!((code, stdout.as_slice(), stderr.as_str()), (0, b"a\na\nc\n".as_slice(), ""));
	}

	#[test]
	fn not_removes_file2_members() {
		let dir = fixture();
		let (code, stdout, stderr) = run_in(dir.path(), "", &["one", "not", "two"]);
		assert_eq!((code, stdout.as_slice(), stderr.as_str()), (0, b"b\n".as_slice(), ""));
	}

	#[test]
	fn or_concatenates_both_files() {
		let dir = fixture();
		let (code, stdout, stderr) = run_in(dir.path(), "", &["one", "or", "two"]);
		assert_eq!(
			(code, stdout.as_slice(), stderr.as_str()),
			(0, b"a\nb\na\nc\na\nc\nd\n".as_slice(), "")
		);
	}

	#[test]
	fn xor_emits_exclusive_lines_from_both_sides() {
		let dir = fixture();
		let (code, stdout, stderr) = run_in(dir.path(), "", &["one", "XOR", "two"]);
		assert_eq!((code, stdout.as_slice(), stderr.as_str()), (0, b"b\nd\n".as_slice(), ""));
	}

	#[test]
	fn dash_reads_file1_from_stdin() {
		let dir = fixture();
		let (code, stdout, stderr) =
			run_in(dir.path(), "a\nb\na\nc\n", &["-", "and", "two"]);
		assert_eq!((code, stdout.as_slice(), stderr.as_str()), (0, b"a\na\nc\n".as_slice(), ""));
	}

	#[test]
	fn both_sides_stdin_is_rejected() {
		let dir = tempfile::tempdir().unwrap();
		let (code, stdout, stderr) = run_in(dir.path(), "", &["-", "and", "-"]);
		assert_eq!(code, 1);
		assert!(stdout.is_empty());
		assert_eq!(stderr, "combine: only one file can be stdin\n");
	}

	#[test]
	fn non_utf8_lines_survive_byte_exact() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("one"), b"\xff\xfe\n\x80ok\n").unwrap();
		fs::write(dir.path().join("two"), b"\xff\xfe\n").unwrap();
		let (code, stdout, stderr) = run_in(dir.path(), "", &["one", "and", "two"]);
		assert_eq!((code, stdout.as_slice(), stderr.as_str()), (0, b"\xff\xfe\n".as_slice(), ""));
	}

	#[test]
	fn missing_file_reports_error_exit_1() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("one"), b"a\n").unwrap();
		let (code, stdout, stderr) = run_in(dir.path(), "", &["one", "and", "nope"]);
		assert_eq!(code, 1);
		assert!(stdout.is_empty());
		assert!(stderr.starts_with("combine: nope: "), "stderr: {stderr}");
	}

	#[test]
	fn unknown_op_is_usage_error_exit_1() {
		let dir = fixture();
		let (code, stdout, stderr) = run_in(dir.path(), "", &["one", "nand", "two"]);
		assert_eq!(code, 1);
		assert!(stdout.is_empty());
		assert_eq!(stderr, "combine: unknown operation 'nand' (expected and, not, or, xor)\n");
	}

	#[test]
	fn wrong_arg_count_is_usage_error_exit_1() {
		let dir = tempfile::tempdir().unwrap();
		let (code, stdout, stderr) = run_in(dir.path(), "", &["only-one"]);
		assert_eq!(code, 1);
		assert!(stdout.is_empty());
		assert!(stderr.contains("Usage"), "stderr: {stderr}");
	}

	#[test]
	fn last_line_without_newline_matches_and_is_emitted_as_is() {
		// `b` without a trailing newline still counts as a line, matches
		// `b\n` in the other file, and is emitted without adding a newline.
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("one"), b"a\nb").unwrap();
		fs::write(dir.path().join("two"), b"b\n").unwrap();
		let (code, stdout, stderr) = run_in(dir.path(), "", &["one", "and", "two"]);
		assert_eq!((code, stdout.as_slice(), stderr.as_str()), (0, b"b".as_slice(), ""));
	}
}
