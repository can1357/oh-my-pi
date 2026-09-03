//! `cmp` builtin: compare two files byte by byte.
//!
//! Ported from the `pi-shell` in-process implementation.

use std::{
	ffi::{OsStr, OsString},
	fs::{self, File},
	io::{self, BufRead, BufReader, Cursor, Read, Seek, SeekFrom, Write},
	path::Path,
	sync::{
		atomic::{AtomicBool, Ordering},
	},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};

use crate::host::{Host, Stdin, Utility, format_usage, matches_parser, util};

const OPT_PRINT_BYTES: &str = "print-bytes";
const OPT_IGNORE_INITIAL: &str = "ignore-initial";
const OPT_VERBOSE: &str = "verbose";
const OPT_BYTES: &str = "bytes";
const OPT_QUIET: &str = "quiet";
const OPT_HEX: &str = "hex";
const OPT_NO_FOLLOW: &str = "no-follow";
const OPT_SIZE_FIRST: &str = "size-first";
const ARG_FILE1: &str = "file1";
const ARG_FILE2: &str = "file2";
const ARG_SKIP1: &str = "skip1";
const ARG_SKIP2: &str = "skip2";
const BUFFER_SIZE: usize = 64 * 1024;

#[derive(Clone, Copy)]
struct Options {
	print_bytes: bool,
	verbose:     bool,
	quiet:       bool,
	hex:         bool,
	no_follow:   bool,
	size_first:  bool,
	limit:       Option<u64>,
	skip1:       u64,
	skip2:       u64,
}

enum InputReader<'a> {
	File(File),
	Stdin(&'a mut Stdin),
	Bytes(Cursor<Vec<u8>>),
}

impl Read for InputReader<'_> {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		match self {
			Self::File(file) => file.read(buf),
			Self::Stdin(stdin) => stdin.read(buf),
			Self::Bytes(bytes) => bytes.read(buf),
		}
	}
}

impl InputReader<'_> {
	fn skip(&mut self, count: u64) -> io::Result<()> {
		match self {
			Self::File(file) => {
				file.seek(SeekFrom::Start(count))?;
			},
			Self::Bytes(bytes) => {
				let length = u64::try_from(bytes.get_ref().len()).unwrap_or(u64::MAX);
				bytes.set_position(count.min(length));
			},
			Self::Stdin(stdin) => {
				io::copy(&mut stdin.take(count), &mut io::sink())?;
			},
		}
		Ok(())
	}
}

struct Input<'a> {
	reader:      BufReader<InputReader<'a>>,
	regular_len: Option<u64>,
}

/// Parsed `cmp` invocation.
pub(crate) struct Cmp {
	matches: ArgMatches,
}

matches_parser!(Cmp, command);

impl Utility for Cmp {
	const NAME: &'static str = "cmp";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		match compare(&self.matches, host) {
			Ok(code) => code,
			Err(message) => {
				host.error(message, 2);
				2
			},
		}
	}
}

fn command() -> Command {
	Command::new(Cmp::NAME)
		.version("cmp (pi-shell) 17.2.11")
		.about("Compare two files byte by byte.")
		.override_usage(format_usage("cmp [OPTION]... FILE1 [FILE2 [SKIP1 [SKIP2]]]"))
		.disable_help_flag(true)
		.disable_version_flag(true)
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_PRINT_BYTES)
				.short('b')
				.long(OPT_PRINT_BYTES)
				.help("print differing bytes")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_IGNORE_INITIAL)
				.short('i')
				.long(OPT_IGNORE_INITIAL)
				.value_name("SKIP[:SKIP2]")
				.help("skip initial bytes of both inputs"),
		)
		.arg(
			Arg::new(OPT_VERBOSE)
				.short('l')
				.long(OPT_VERBOSE)
				.help("print every differing byte")
				.conflicts_with_all([OPT_QUIET, OPT_HEX])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_BYTES)
				.short('n')
				.long(OPT_BYTES)
				.value_name("LIMIT")
				.help("compare at most LIMIT bytes"),
		)
		.arg(
			Arg::new(OPT_QUIET)
				.short('s')
				.long(OPT_QUIET)
				.visible_alias("silent")
				.help("suppress all normal output")
				.conflicts_with_all([OPT_VERBOSE, OPT_HEX])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_HEX)
				.short('x')
				.help("print every difference in hexadecimal with zero-based offsets")
				.conflicts_with_all([OPT_VERBOSE, OPT_QUIET])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_NO_FOLLOW)
				.short('h')
				.help("compare symbolic-link targets instead of following links")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_SIZE_FIRST)
				.short('z')
				.help("compare regular-file sizes before contents")
				.action(ArgAction::SetTrue),
		)
		.arg(Arg::new("help").long("help").action(ArgAction::Help))
		.arg(
			Arg::new("version")
				.short('v')
				.long("version")
				.action(ArgAction::Version),
		)
		.arg(
			Arg::new(ARG_FILE1)
				.required(true)
				.value_name("FILE1")
				.value_parser(clap::value_parser!(OsString)),
		)
		.arg(
			Arg::new(ARG_FILE2)
				.value_name("FILE2")
				.value_parser(clap::value_parser!(OsString)),
		)
		.arg(Arg::new(ARG_SKIP1).value_name("SKIP1"))
		.arg(Arg::new(ARG_SKIP2).value_name("SKIP2"))
}

fn compare(matches: &ArgMatches, host: &mut Host) -> Result<i32, String> {
	let name1 = matches.get_one::<OsString>(ARG_FILE1).unwrap();
	let default_stdin = OsString::from("-");
	let name2 = matches
		.get_one::<OsString>(ARG_FILE2)
		.unwrap_or(&default_stdin);
	if name1 == OsStr::new("-") && name2 == OsStr::new("-") {
		return Ok(0);
	}

	let (skip1, skip2) = skips(matches)?;
	let options = Options {
		print_bytes: matches.get_flag(OPT_PRINT_BYTES),
		verbose: matches.get_flag(OPT_VERBOSE),
		quiet: matches.get_flag(OPT_QUIET),
		hex: matches.get_flag(OPT_HEX),
		no_follow: matches.get_flag(OPT_NO_FOLLOW),
		size_first: matches.get_flag(OPT_SIZE_FIRST),
		limit: matches
			.get_one::<String>(OPT_BYTES)
			.map(|value| parse_count(value))
			.transpose()?,
		skip1,
		skip2,
	};
	let path1 = (name1 != OsStr::new("-")).then(|| host.resolve(name1));
	let path2 = (name2 != OsStr::new("-")).then(|| host.resolve(name2));
	let cancel = host.cancel_flag();

	if name1 == OsStr::new("-") {
		let input1 = stdin_input(&mut host.stdin);
		let input2 = open_input(name2, path2.as_deref().unwrap(), options.no_follow)?;
		compare_inputs(
			input1,
			input2,
			name1,
			name2,
			options,
			&mut host.stdout,
			&mut host.stderr,
			&cancel,
		)
	} else if name2 == OsStr::new("-") {
		let input1 = open_input(name1, path1.as_deref().unwrap(), options.no_follow)?;
		let input2 = stdin_input(&mut host.stdin);
		compare_inputs(
			input1,
			input2,
			name1,
			name2,
			options,
			&mut host.stdout,
			&mut host.stderr,
			&cancel,
		)
	} else {
		let input1 = open_input(name1, path1.as_deref().unwrap(), options.no_follow)?;
		let input2 = open_input(name2, path2.as_deref().unwrap(), options.no_follow)?;
		compare_inputs(
			input1,
			input2,
			name1,
			name2,
			options,
			&mut host.stdout,
			&mut host.stderr,
			&cancel,
		)
	}
}

fn skips(matches: &ArgMatches) -> Result<(u64, u64), String> {
	if let Some(value) = matches.get_one::<String>(OPT_IGNORE_INITIAL) {
		return match value.split_once(':') {
			Some((first, second)) if !first.is_empty() && !second.is_empty() => {
				Ok((parse_count(first)?, parse_count(second)?))
			},
			Some(_) => Err(format!("invalid --ignore-initial value '{value}'")),
			None => {
				let count = parse_count(value)?;
				Ok((count, count))
			},
		};
	}
	let skip1 = matches
		.get_one::<String>(ARG_SKIP1)
		.map(|value| parse_count(value))
		.transpose()?
		.unwrap_or(0);
	let skip2 = matches
		.get_one::<String>(ARG_SKIP2)
		.map(|value| parse_count(value))
		.transpose()?
		.unwrap_or(0);
	Ok((skip1, skip2))
}

fn parse_count(value: &str) -> Result<u64, String> {
	let bytes = value.as_bytes();
	let (radix, digits_start) = if value.starts_with("0x") || value.starts_with("0X") {
		(16, 2)
	} else if bytes.len() > 1 && bytes[0] == b'0' && bytes[1].is_ascii_digit() {
		(8, 1)
	} else {
		(10, 0)
	};
	let mut digits_end = digits_start;
	while bytes
		.get(digits_end)
		.is_some_and(|byte| char::from(*byte).is_digit(radix))
	{
		digits_end += 1;
	}
	if digits_end == digits_start {
		return Err(format!("invalid byte count '{value}'"));
	}
	let parsed = u64::from_str_radix(&value[digits_start..digits_end], radix)
		.map_err(|_| format!("invalid byte count '{value}'"))?;
	let multiplier = match &value[digits_end..] {
		"" => 1,
		"kB" => 1_000,
		"k" | "K" | "KiB" => 1 << 10,
		"MB" => 1_000_000,
		"M" | "MiB" => 1 << 20,
		"GB" => 1_000_000_000,
		"G" | "GiB" => 1 << 30,
		"TB" => 1_000_000_000_000,
		"T" | "TiB" => 1 << 40,
		"PB" => 1_000_000_000_000_000,
		"P" | "PiB" => 1 << 50,
		"EB" => 1_000_000_000_000_000_000,
		"E" | "EiB" => 1 << 60,
		_ => return Err(format!("invalid byte count '{value}'")),
	};
	parsed
		.checked_mul(multiplier)
		.ok_or_else(|| format!("byte count '{value}' is too large"))
}

fn stdin_input(stdin: &mut Stdin) -> Input<'_> {
	Input {
		reader:      BufReader::with_capacity(BUFFER_SIZE, InputReader::Stdin(stdin)),
		regular_len: None,
	}
}

fn open_input<'a>(name: &OsStr, path: &Path, no_follow: bool) -> Result<Input<'a>, String> {
	let metadata = if no_follow {
		fs::symlink_metadata(path)
	} else {
		fs::metadata(path)
	}
	.map_err(|err| input_error(name, &err))?;
	if no_follow && metadata.file_type().is_symlink() {
		let target = fs::read_link(path).map_err(|err| input_error(name, &err))?;
		return Ok(Input {
			reader:      BufReader::with_capacity(
				BUFFER_SIZE,
				InputReader::Bytes(Cursor::new(target.as_os_str().as_encoded_bytes().to_vec())),
			),
			regular_len: None,
		});
	}
	if metadata.is_dir() {
		return Err(format!("{}: Is a directory", display_name(name)));
	}
	let regular_len = metadata.is_file().then_some(metadata.len());
	let file = File::open(path).map_err(|err| input_error(name, &err))?;
	Ok(Input { reader: BufReader::with_capacity(BUFFER_SIZE, InputReader::File(file)), regular_len })
}

fn compare_inputs(
	mut input1: Input<'_>,
	mut input2: Input<'_>,
	name1: &OsStr,
	name2: &OsStr,
	options: Options,
	stdout: &mut impl Write,
	stderr: &mut impl Write,
	cancel: &AtomicBool,
) -> Result<i32, String> {
	if options.size_first
		&& let (Some(len1), Some(len2)) = (input1.regular_len, input2.regular_len)
		&& len1 != len2
	{
		if !options.quiet {
			writeln!(
				stdout,
				"{} {} differ: size",
				display_name(name1),
				display_name(name2)
			)
			.map_err(io_message)?;
		}
		return Ok(1);
	}

	input1
		.reader
		.get_mut()
		.skip(options.skip1)
		.map_err(|err| input_error(name1, &err))?;
	input2
		.reader
		.get_mut()
		.skip(options.skip2)
		.map_err(|err| input_error(name2, &err))?;
	compare_readers(
		&mut input1.reader,
		&mut input2.reader,
		name1,
		name2,
		options,
		stdout,
		stderr,
		cancel,
	)
}

fn compare_readers(
	input1: &mut impl BufRead,
	input2: &mut impl BufRead,
	name1: &OsStr,
	name2: &OsStr,
	options: Options,
	stdout: &mut impl Write,
	stderr: &mut impl Write,
	cancel: &AtomicBool,
) -> Result<i32, String> {
	let mut byte_number = 1u64;
	let mut line_number = 1u64;
	let mut compared = 0u64;
	let mut different = false;

	loop {
		if cancel.load(Ordering::Relaxed) {
			return Err("interrupted".to_string());
		}
		if options.limit.is_some_and(|limit| compared >= limit) {
			break;
		}
		let left = input1.fill_buf().map_err(io_message)?;
		let right = input2.fill_buf().map_err(io_message)?;
		if left.is_empty() || right.is_empty() {
			if left.is_empty() && right.is_empty() {
				break;
			}
			different = true;
			if !options.quiet {
				let eof_name = if left.is_empty() { name1 } else { name2 };
				writeln!(
					stderr,
					"cmp: EOF on {} after byte {}",
					display_name(eof_name),
					compared
				)
				.map_err(io_message)?;
			}
			break;
		}

		let remaining = options.limit.map_or(u64::MAX, |limit| limit - compared);
		let available = left.len().min(right.len());
		let count = available.min(usize::try_from(remaining).unwrap_or(usize::MAX));
		let mut consumed = 0usize;
		for (&left_byte, &right_byte) in left[..count].iter().zip(&right[..count]) {
			if left_byte != right_byte {
				different = true;
				if options.quiet {
					return Ok(1);
				}
				report_difference(
					left_byte,
					right_byte,
					byte_number,
					line_number,
					name1,
					name2,
					options,
					stdout,
				)?;
				if !options.verbose && !options.hex {
					return Ok(1);
				}
			}
			consumed += 1;
			compared += 1;
			byte_number += 1;
			if left_byte == b'\n' {
				line_number += 1;
			}
		}
		input1.consume(consumed);
		input2.consume(consumed);
	}
	Ok(i32::from(different))
}

fn report_difference(
	left: u8,
	right: u8,
	byte_number: u64,
	line_number: u64,
	name1: &OsStr,
	name2: &OsStr,
	options: Options,
	out: &mut impl Write,
) -> Result<(), String> {
	if options.hex {
		return writeln!(out, "{:08x} {left:02x} {right:02x}", byte_number - 1).map_err(io_message);
	}
	if options.verbose {
		write!(out, "{byte_number} {left:3o}").map_err(io_message)?;
		if options.print_bytes {
			write!(out, " ").map_err(io_message)?;
			write_visible_byte_padded(out, left).map_err(io_message)?;
		}
		write!(out, " {right:3o}").map_err(io_message)?;
		if options.print_bytes {
			write!(out, " ").map_err(io_message)?;
			write_visible_byte(out, right).map_err(io_message)?;
		}
		return writeln!(out).map_err(io_message);
	}
	let position_name = if options.print_bytes { "byte" } else { "char" };
	write!(
		out,
		"{} {} differ: {position_name} {byte_number}, line {line_number}",
		display_name(name1),
		display_name(name2)
	)
	.map_err(io_message)?;
	if options.print_bytes {
		write!(out, " is {left:3o} ").map_err(io_message)?;
		write_visible_byte(out, left).map_err(io_message)?;
		write!(out, " {right:3o} ").map_err(io_message)?;
		write_visible_byte(out, right).map_err(io_message)?;
	}
	writeln!(out).map_err(io_message)
}

fn write_visible_byte(out: &mut impl Write, byte: u8) -> io::Result<()> {
	if byte >= 128 {
		out.write_all(b"M-")?;
		return write_visible_byte(out, byte - 128);
	}
	match byte {
		0..=31 => write!(out, "^{}", char::from(byte + 64)),
		32..=126 => write!(out, "{}", char::from(byte)),
		127 => out.write_all(b"^?"),
		_ => unreachable!(),
	}
}

fn write_visible_byte_padded(out: &mut impl Write, byte: u8) -> io::Result<()> {
	write_visible_byte(out, byte)?;
	const SPACES: &[u8] = b"    ";
	let padding = SPACES.len().saturating_sub(visible_byte_width(byte));
	out.write_all(&SPACES[..padding])
}

fn visible_byte_width(byte: u8) -> usize {
	if byte >= 128 {
		2 + visible_byte_width(byte - 128)
	} else if matches!(byte, 32..=126) {
		1
	} else {
		2
	}
}

fn display_name(name: &OsStr) -> String {
	name.to_string_lossy().into_owned()
}

fn input_error(name: &OsStr, err: &io::Error) -> String {
	format!("{}: {}", display_name(name), err)
}

fn io_message(err: io::Error) -> String {
	err.to_string()
}

/// Creates the `cmp` builtin registration.
pub(crate) fn cmp_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Cmp, SE>()
}

#[cfg(test)]
mod tests {
	use std::{fs, path::PathBuf};

	use super::Cmp;
	use crate::host::run_util;

	fn run_in(cwd: PathBuf, stdin: &str, args: &[&str]) -> (i32, String, String) {
		let (code, capture) = run_util::<Cmp>(args, stdin, cwd);
		(code, capture.out(), capture.err())
	}

	fn tempdir() -> (tempfile::TempDir, PathBuf) {
		let dir = tempfile::tempdir().unwrap();
		let path = fs::canonicalize(dir.path()).unwrap();
		(dir, path)
	}

	#[test]
	fn silent_mode_reports_only_status() {
		let (_dir, root) = tempdir();
		fs::write(root.join("a"), b"same").unwrap();
		fs::write(root.join("b"), b"same").unwrap();
		fs::write(root.join("c"), b"different").unwrap();

		assert_eq!(run_in(root.clone(), "", &["-s", "a", "b"]), (0, String::new(), String::new()));
		assert_eq!(run_in(root, "", &["-s", "a", "c"]), (1, String::new(), String::new()));
	}

	#[test]
	fn default_output_reports_first_byte_and_line() {
		let (_dir, root) = tempdir();
		fs::write(root.join("a"), b"one\ntwo\n").unwrap();
		fs::write(root.join("b"), b"one\ntXo\n").unwrap();

		let (code, stdout, stderr) = run_in(root, "", &["a", "b"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "a b differ: char 6, line 2\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn stdin_skips_and_limit_follow_cmp_contract() {
		let (_dir, root) = tempdir();
		fs::write(root.join("file"), b"abc").unwrap();

		assert_eq!(
			run_in(root.clone(), "xxabc", &["-i", "0:2", "file"]),
			(0, String::new(), String::new())
		);
		assert_eq!(run_in(root, "abZ", &["-n", "0x2", "file"]), (0, String::new(), String::new()));
	}

	#[test]
	fn verbose_and_bsd_hex_modes_report_every_difference() {
		let (_dir, root) = tempdir();
		fs::write(root.join("a"), b"abc").unwrap();
		fs::write(root.join("b"), b"axd").unwrap();

		let (code, stdout, stderr) = run_in(root.clone(), "", &["-l", "a", "b"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (1, "2 142 170\n3 143 144\n", ""));

		let (code, stdout, stderr) = run_in(root, "", &["-x", "a", "b"]);
		assert_eq!(
			(code, stdout.as_str(), stderr.as_str()),
			(1, "00000001 62 78\n00000002 63 64\n", "")
		);
	}

	#[cfg(unix)]
	#[test]
	fn no_follow_compares_symlink_targets() {
		let (_dir, root) = tempdir();
		fs::write(root.join("a"), b"same").unwrap();
		fs::write(root.join("b"), b"same").unwrap();
		std::os::unix::fs::symlink("a", root.join("left")).unwrap();
		std::os::unix::fs::symlink("b", root.join("right")).unwrap();

		let (code, stdout, stderr) = run_in(root, "", &["-h", "left", "right"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "left right differ: char 1, line 1\n");
		assert_eq!(stderr, "");
	}
}
