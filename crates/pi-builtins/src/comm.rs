//! `comm` builtin: compare two sorted files line by line.
//!
//! Ported from uutils coreutils 0.8.0.

use std::{
	cmp::Ordering,
	ffi::{OsStr, OsString},
	fs::{self, File},
	io::{self, BufRead, BufReader, Read, Write},
	path::Path,
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use uucore::{display::Quotable, line_ending::LineEnding};

use crate::host::{Host, Utility, format_usage, matches_parser, util};

mod options {
	pub const COLUMN_1: &str = "1";
	pub const COLUMN_2: &str = "2";
	pub const COLUMN_3: &str = "3";
	pub const DELIMITER: &str = "output-delimiter";
	pub const FILE_1: &str = "FILE1";
	pub const FILE_2: &str = "FILE2";
	pub const TOTAL: &str = "total";
	pub const ZERO_TERMINATED: &str = "zero-terminated";
	pub const CHECK_ORDER: &str = "check-order";
	pub const NO_CHECK_ORDER: &str = "nocheck-order";
}

#[derive(Clone, Copy)]
enum FileNumber {
	One,
	Two,
}

impl FileNumber {
	fn as_str(self) -> &'static str {
		match self {
			Self::One => "1",
			Self::Two => "2",
		}
	}
}

struct OrderChecker {
	last_line:   Vec<u8>,
	file_num:    FileNumber,
	check_order: bool,
	has_error:   bool,
}

impl OrderChecker {
	fn new(file_num: FileNumber, check_order: bool) -> Self {
		Self { last_line: Vec::new(), file_num, check_order, has_error: false }
	}

	fn verify_order(&mut self, line: &[u8], stderr: &mut impl Write) -> bool {
		if self.last_line.is_empty() {
			self.last_line = line.to_vec();
			return true;
		}
		let ordered = line >= self.last_line.as_slice();
		if !ordered && !self.has_error {
			let _ = writeln!(stderr, "comm: file {} is not in sorted order", self.file_num.as_str());
			self.has_error = true;
		}
		self.last_line.clear();
		self.last_line.extend_from_slice(line);
		ordered || !self.check_order
	}
}

struct LineReader<'a> {
	line_ending: u8,
	input:       Box<dyn BufRead + 'a>,
}

impl<'a> LineReader<'a> {
	fn new(input: Box<dyn BufRead + 'a>, line_ending: LineEnding) -> Self {
		Self { input, line_ending: line_ending.into() }
	}

	fn read_line(&mut self, buf: &mut Vec<u8>) -> io::Result<usize> {
		let result = self.input.read_until(self.line_ending, buf)?;
		if result != 0 && !buf.ends_with(&[self.line_ending]) {
			buf.push(self.line_ending);
		}
		Ok(result)
	}
}

fn files_identical(path1: &Path, path2: &Path) -> io::Result<bool> {
	let m1 = fs::metadata(path1)?;
	let m2 = fs::metadata(path2)?;
	if !m1.is_file() || !m2.is_file() || m1.len() != m2.len() {
		return Ok(false);
	}
	let mut a = BufReader::new(File::open(path1)?);
	let mut b = BufReader::new(File::open(path2)?);
	let mut ba = [0; 8192];
	let mut bb = [0; 8192];
	loop {
		let na = loop {
			match a.read(&mut ba) {
				Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
				r => break r?,
			}
		};
		let nb = loop {
			match b.read(&mut bb) {
				Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
				r => break r?,
			}
		};
		if na != nb || ba[..na] != bb[..nb] {
			return Ok(false);
		}
		if na == 0 {
			return Ok(true);
		}
	}
}

fn write_delimited(writer: &mut impl Write, delim: &[u8], line: &[u8]) -> io::Result<()> {
	writer.write_all(delim)?;
	writer.write_all(line)
}

fn read_context(reader: &mut LineReader<'_>, buf: &mut Vec<u8>, name: &OsStr) -> Result<usize, String> {
	reader.read_line(buf).map_err(|e| format!("{}: {e}", name.maybe_quote()))
}

fn compare(
	a: &mut LineReader<'_>,
	b: &mut LineReader<'_>,
	name1: &OsStr,
	name2: &OsStr,
	delim: &str,
	opts: &ArgMatches,
	identical: bool,
	stdout: &mut impl Write,
	stderr: &mut impl Write,
) -> Result<bool, String> {
	let col2 = delim.repeat(usize::from(!opts.get_flag(options::COLUMN_1)));
	let col3 = delim.repeat(
		usize::from(!opts.get_flag(options::COLUMN_1))
			+ usize::from(!opts.get_flag(options::COLUMN_2)),
	);
	let (mut ra, mut rb) = (Vec::new(), Vec::new());
	let mut na = read_context(a, &mut ra, name1)?;
	let mut nb = read_context(b, &mut rb, name2)?;
	let (mut n1, mut n2, mut n3) = (0usize, 0usize, 0usize);
	let explicit = opts.get_flag(options::CHECK_ORDER);
	let should_check = !opts.get_flag(options::NO_CHECK_ORDER) && (explicit || !identical);
	let (mut c1, mut c2) = (
		OrderChecker::new(FileNumber::One, explicit),
		OrderChecker::new(FileNumber::Two, explicit),
	);
	let mut delayed_error = false;
	while na != 0 || nb != 0 {
		let ord = match (na, nb) {
			(0, _) => Ordering::Greater,
			(_, 0) => Ordering::Less,
			_ => ra.cmp(&rb),
		};
		match ord {
			Ordering::Less => {
				if should_check && !c1.verify_order(&ra, stderr) {
					break;
				}
				if !opts.get_flag(options::COLUMN_1) {
					stdout.write_all(&ra).map_err(|e| format!("write error: {e}"))?;
				}
				ra.clear();
				na = read_context(a, &mut ra, name1)?;
				n1 += 1;
			},
			Ordering::Greater => {
				if should_check && !c2.verify_order(&rb, stderr) {
					break;
				}
				if !opts.get_flag(options::COLUMN_2) {
					write_delimited(&mut *stdout, col2.as_bytes(), &rb)
						.map_err(|e| format!("write error: {e}"))?;
				}
				rb.clear();
				nb = read_context(b, &mut rb, name2)?;
				n2 += 1;
			},
			Ordering::Equal => {
				if should_check
					&& (!c1.verify_order(&ra, stderr) || !c2.verify_order(&rb, stderr))
				{
					break;
				}
				if !opts.get_flag(options::COLUMN_3) {
					write_delimited(&mut *stdout, col3.as_bytes(), &ra)
						.map_err(|e| format!("write error: {e}"))?;
				}
				ra.clear();
				rb.clear();
				na = read_context(a, &mut ra, name1)?;
				nb = read_context(b, &mut rb, name2)?;
				n3 += 1;
			},
		}
		if (c1.has_error || c2.has_error) && !explicit {
			delayed_error = true;
		}
	}
	if opts.get_flag(options::TOTAL) {
		let ending = LineEnding::from_zero_flag(opts.get_flag(options::ZERO_TERMINATED));
		write!(stdout, "{n1}{delim}{n2}{delim}{n3}{delim}total{ending}")
			.map_err(|e| format!("write error: {e}"))?;
	}
	stdout.flush().map_err(|e| format!("write error: {e}"))?;
	if should_check && (c1.has_error || c2.has_error) {
		if delayed_error {
			let _ = writeln!(stderr, "comm: input is not in sorted order");
		}
		Ok(false)
	} else {
		Ok(true)
	}
}

fn open_file<'a>(
	name: &OsStr,
	resolved: &Path,
	stdin: Option<&'a mut dyn Read>,
	ending: LineEnding,
) -> io::Result<LineReader<'a>> {
	if name == "-" {
		return Ok(LineReader::new(Box::new(BufReader::new(stdin.expect("stdin operand"))), ending));
	}
	if fs::metadata(resolved)?.is_dir() {
		return Err(io::Error::other("is a directory"));
	}
	Ok(LineReader::new(Box::new(BufReader::new(File::open(resolved)?)), ending))
}

/// Parsed `comm` invocation.
pub(crate) struct Comm {
	matches: ArgMatches,
}

matches_parser!(Comm, app);

impl Utility for Comm {
	const NAME: &'static str = "comm";

	fn run(self, host: &mut Host) -> i32 {
		let name1 = self.matches.get_one::<OsString>(options::FILE_1).unwrap();
		let name2 = self.matches.get_one::<OsString>(options::FILE_2).unwrap();
		if name1 == "-" && name2 == "-" {
			host.error("standard input is specified twice", 1);
			return 1;
		}
		let path1 = host.resolve(name1);
		let path2 = host.resolve(name2);
		let delimiters: Vec<_> = self
			.matches
			.get_many::<String>(options::DELIMITER)
			.unwrap()
			.collect();
		if delimiters[1..].iter().any(|d| *d != delimiters[0]) {
			host.error("multiple conflicting output delimiters specified", 1);
			return 1;
		}
		let delim = if delimiters[0].is_empty() { "\0" } else { delimiters[0] };
		let identical = if name1 == "-" || name2 == "-" {
			false
		} else {
			files_identical(&path1, &path2).unwrap_or(false)
		};
		let ending = LineEnding::from_zero_flag(self.matches.get_flag(options::ZERO_TERMINATED));
		// Taken before the `LineReader`s below hold `&mut host.stdin`; a
		// method borrow of `host` would otherwise conflict with them.
		let mut stdout = host.stdout_writer();
		let opened: Result<_, (&OsStr, io::Error)> = if name1 == "-" {
			open_file(name2, &path2, None, ending)
				.map_err(|e| (name2.as_os_str(), e))
				.and_then(|f2| {
					open_file(name1, &path1, Some(&mut host.stdin), ending)
						.map(|f1| (f1, f2))
						.map_err(|e| (name1.as_os_str(), e))
				})
		} else if name2 == "-" {
			open_file(name1, &path1, None, ending)
				.map_err(|e| (name1.as_os_str(), e))
				.and_then(|f1| {
					open_file(name2, &path2, Some(&mut host.stdin), ending)
						.map(|f2| (f1, f2))
						.map_err(|e| (name2.as_os_str(), e))
				})
		} else {
			open_file(name1, &path1, None, ending)
				.map_err(|e| (name1.as_os_str(), e))
				.and_then(|f1| {
					open_file(name2, &path2, None, ending)
						.map(|f2| (f1, f2))
						.map_err(|e| (name2.as_os_str(), e))
				})
		};
		let (mut f1, mut f2) = match opened {
			Ok(files) => files,
			Err((name, e)) => {
				let _ = writeln!(host.stderr, "comm: {}: {e}", name.maybe_quote());
				return 1;
			},
		};
		match compare(
			&mut f1,
			&mut f2,
			name1,
			name2,
			delim,
			&self.matches,
			identical,
			&mut stdout,
			&mut host.stderr,
		) {
			Ok(true) => 0,
			Ok(false) => 1,
			Err(e) => {
				let _ = writeln!(host.stderr, "comm: {e}");
				1
			},
		}
	}
}

fn app() -> Command {
	Command::new(Comm::NAME)
		.version("0.8.0")
		.about("Compare sorted files FILE1 and FILE2 line by line.")
		.override_usage(format_usage("comm [OPTION]... FILE1 FILE2"))
		.infer_long_args(true)
		.args_override_self(true)
		.arg(Arg::new(options::COLUMN_1).short('1').help("suppress column 1 (lines unique to FILE1)").action(ArgAction::SetTrue))
		.arg(Arg::new(options::COLUMN_2).short('2').help("suppress column 2 (lines unique to FILE2)").action(ArgAction::SetTrue))
		.arg(Arg::new(options::COLUMN_3).short('3').help("suppress column 3 (lines that appear in both files)").action(ArgAction::SetTrue))
		.arg(Arg::new(options::DELIMITER).long(options::DELIMITER).help("separate columns with STR").value_name("STR").default_value("\t").allow_hyphen_values(true).action(ArgAction::Append).hide_default_value(true))
		.arg(Arg::new(options::ZERO_TERMINATED).long(options::ZERO_TERMINATED).short('z').overrides_with(options::ZERO_TERMINATED).help("line delimiter is NUL, not newline").action(ArgAction::SetTrue))
		.arg(Arg::new(options::FILE_1).required(true).value_hint(clap::ValueHint::FilePath).value_parser(clap::value_parser!(OsString)))
		.arg(Arg::new(options::FILE_2).required(true).value_hint(clap::ValueHint::FilePath).value_parser(clap::value_parser!(OsString)))
		.arg(Arg::new(options::TOTAL).long(options::TOTAL).help("output a summary").action(ArgAction::SetTrue))
		.arg(Arg::new(options::CHECK_ORDER).long(options::CHECK_ORDER).help("check that input is correctly sorted, even if all input lines are pairable").action(ArgAction::SetTrue))
		.arg(Arg::new(options::NO_CHECK_ORDER).long(options::NO_CHECK_ORDER).help("do not check that input is correctly sorted").action(ArgAction::SetTrue).conflicts_with(options::CHECK_ORDER))
}

/// Creates the `comm` builtin registration.
pub(crate) fn comm_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Comm, SE>()
}

#[cfg(test)]
mod tests {
	use std::fs;

	use super::Comm;
	use crate::host::run_util;

	#[test]
	fn compares_three_columns_and_resolves_relative_paths() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a"), "a\nb\nd\n").unwrap();
		fs::write(dir.path().join("b"), "b\nc\nd\n").unwrap();
		let (code, capture) = run_util::<Comm>(&["a", "b"], "", dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "a\n\t\tb\n\tc\n\t\td\n");
	}

	#[test]
	fn accepts_one_stdin_operand_and_column_suppression() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("b"), "b\nc\n").unwrap();
		let (code, capture) = run_util::<Comm>(&["-1", "-", "b"], "a\nb\n", dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "\tb\nc\n");
	}

	#[test]
	fn rejects_stdin_twice() {
		let (code, capture) = run_util::<Comm>(&["-", "-"], "", "/");
		assert_eq!(code, 1);
		assert_eq!(capture.err(), "comm: standard input is specified twice\n");
	}

	#[test]
	fn supports_delimiter_total_and_zero_termination() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a"), b"a\0b\0").unwrap();
		fs::write(dir.path().join("b"), b"b\0c\0").unwrap();
		let (code, capture) = run_util::<Comm>(
			&["-z", "--output-delimiter=|", "--total", "a", "b"],
			"",
			dir.path(),
		);
		assert_eq!(code, 0);
		assert_eq!(capture.stdout(), b"a\0||b\0|c\01|1|1|total\0");
	}

	#[test]
	fn check_order_reports_unsorted_input() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a"), "b\na\n").unwrap();
		fs::write(dir.path().join("b"), "b\na\n").unwrap();
		let (code, capture) = run_util::<Comm>(&["--check-order", "a", "b"], "", dir.path());
		assert_eq!(code, 1);
		assert!(capture.err().contains("file 1 is not in sorted order"));
	}

	#[test]
	fn nocheck_order_accepts_unsorted_input() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a"), "b\na\n").unwrap();
		fs::write(dir.path().join("b"), "b\na\n").unwrap();
		let (code, _) = run_util::<Comm>(&["--nocheck-order", "a", "b"], "", dir.path());
		assert_eq!(code, 0);
	}
}
