// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// spell-checker:ignore (vars) seekable memrchr

use std::{
	ffi::OsString,
	fs::File,
	io::{self, BufWriter, Read, Seek, SeekFrom, Write},
	num::TryFromIntError,
	path::{Path, PathBuf},
};

use clap::ArgMatches;
use memchr::memrchr_iter;
use thiserror::Error;
use uucore::{
	display::Quotable,
	error::{UError, UResult},
	line_ending::LineEnding,
};

const BUF_SIZE: usize = 65536;

mod cli;
use crate::cli::options;
pub use crate::cli::uu_app;

mod parse;
mod take;
use take::{copy_all_but_n_bytes, copy_all_but_n_lines, take_lines};

#[derive(Error, Debug)]
enum HeadError {
	/// Wrapper around `io::Error`
	#[error("error reading {}: {}", name.quote(), err)]
	Io { name: PathBuf, err: io::Error },

	#[error("{0}")]
	ParseError(String),

	#[error("number of -bytes or -lines is too large")]
	NumTooLarge(#[from] TryFromIntError),

	#[error("clap error: {0}")]
	Clap(#[from] clap::Error),

	#[error("{0}")]
	MatchOption(String),
}

impl UError for HeadError {
	fn code(&self) -> i32 {
		1
	}
}

type HeadResult<T> = Result<T, HeadError>;

#[derive(Debug, PartialEq)]
enum Mode {
	FirstLines(u64),
	AllButLastLines(u64),
	FirstBytes(u64),
	AllButLastBytes(u64),
}

impl Default for Mode {
	fn default() -> Self {
		Self::FirstLines(10)
	}
}

impl Mode {
	fn from(matches: &ArgMatches) -> Result<Self, String> {
		if let Some(v) = matches.get_one::<String>(options::BYTES) {
			let (n, all_but_last) =
				parse::parse_num(v).map_err(|err| format!("invalid number of bytes: {err}"))?;
			if all_but_last {
				Ok(Self::AllButLastBytes(n))
			} else {
				Ok(Self::FirstBytes(n))
			}
		} else if let Some(v) = matches.get_one::<String>(options::LINES) {
			let (n, all_but_last) =
				parse::parse_num(v).map_err(|err| format!("invalid number of lines: {err}"))?;
			if all_but_last {
				Ok(Self::AllButLastLines(n))
			} else {
				Ok(Self::FirstLines(n))
			}
		} else {
			Ok(Self::default())
		}
	}
}

fn arg_iterate<'a>(
	mut args: impl uucore::Args + 'a,
) -> HeadResult<Box<dyn Iterator<Item = OsString> + 'a>> {
	// argv[0] is always present
	let first = args.next().unwrap();
	if let Some(second) = args.next() {
		if let Some(s) = second.to_str() {
			if let Some(v) = parse::parse_obsolete(s) {
				match v {
					Ok(iter) => Ok(Box::new(vec![first].into_iter().chain(iter).chain(args))),
					Err(parse::ParseError) => {
						Err(HeadError::ParseError(format!("bad argument format: {}", s.quote())))
					},
				}
			} else {
				// The second argument contains non-UTF-8 sequences, so it can't be an obsolete
				// option like "-5". Treat it as a regular file argument.
				Ok(Box::new(vec![first, second].into_iter().chain(args)))
			}
		} else {
			// The second argument contains non-UTF-8 sequences, so it can't be an obsolete
			// option like "-5". Treat it as a regular file argument.
			Ok(Box::new(vec![first, second].into_iter().chain(args)))
		}
	} else {
		Ok(Box::new(vec![first].into_iter()))
	}
}

#[derive(Debug, PartialEq, Default)]
struct HeadOptions {
	pub quiet:              bool,
	pub verbose:            bool,
	pub line_ending:        LineEnding,
	pub presume_input_pipe: bool,
	pub mode:               Mode,
	pub files:              Vec<OsString>,
}

impl HeadOptions {
	///Construct options from matches
	pub fn get_from(matches: &ArgMatches) -> Result<Self, String> {
		let mut options = Self::default();

		options.quiet = matches.get_flag(options::QUIET);
		options.verbose = matches.get_flag(options::VERBOSE);
		options.line_ending = LineEnding::from_zero_flag(matches.get_flag(options::ZERO));
		options.presume_input_pipe = matches.get_flag(options::PRESUME_INPUT_PIPE);

		options.mode = Mode::from(matches)?;

		options.files = match matches.get_many::<OsString>(options::FILES) {
			Some(v) => v.cloned().collect(),
			None => vec![OsString::from("-")],
		};

		Ok(options)
	}
}

#[inline]
fn wrap_in_stdout_error(err: io::Error) -> io::Error {
	io::Error::new(err.kind(), format!("error writing 'standard output': {err}"))
}

fn read_n_bytes(input: impl Read, n: u64) -> io::Result<u64> {
	// Read the first `n` bytes from the `input` reader.
	let mut reader = input.take(n);

	// Write those bytes to `stdout`.
	let stdout = pi_uutils_ctx::stdout();
	let mut stdout = stdout.lock();

	let bytes_written = io::copy(&mut reader, &mut stdout).map_err(wrap_in_stdout_error)?;

	// Make sure we finish writing everything to the target before
	// exiting. Otherwise, when Rust is implicitly flushing, any
	// error will be silently ignored.
	stdout.flush().map_err(wrap_in_stdout_error)?;

	Ok(bytes_written)
}

fn read_n_lines(input: &mut impl io::BufRead, n: u64, separator: u8) -> io::Result<u64> {
	// Read the first `n` lines from the `input` reader.
	let mut reader = take_lines(input, n, separator);

	// Write those bytes to `stdout`.
	let stdout = pi_uutils_ctx::stdout();
	let stdout = stdout.lock();
	let mut writer = BufWriter::with_capacity(BUF_SIZE, stdout);

	let bytes_written = io::copy(&mut reader, &mut writer).map_err(wrap_in_stdout_error)?;

	// Make sure we finish writing everything to the target before
	// exiting. Otherwise, when Rust is implicitly flushing, any
	// error will be silently ignored.
	writer.flush().map_err(wrap_in_stdout_error)?;

	Ok(bytes_written)
}

fn catch_too_large_numbers_in_backwards_bytes_or_lines(n: u64) -> Option<usize> {
	usize::try_from(n).ok()
}

fn read_but_last_n_bytes(mut input: impl Read, n: u64) -> io::Result<u64> {
	let mut bytes_written: u64 = 0;
	if let Some(n) = catch_too_large_numbers_in_backwards_bytes_or_lines(n) {
		let stdout = pi_uutils_ctx::stdout();
		let mut stdout = stdout.lock();

		bytes_written = copy_all_but_n_bytes(&mut input, &mut stdout, n)
			.map_err(wrap_in_stdout_error)?
			.try_into()
			.unwrap();

		// Make sure we finish writing everything to the target before
		// exiting. Otherwise, when Rust is implicitly flushing, any
		// error will be silently ignored.
		stdout.flush().map_err(wrap_in_stdout_error)?;
	}
	Ok(bytes_written)
}

fn read_but_last_n_lines(mut input: impl Read, n: u64, separator: u8) -> io::Result<u64> {
	let stdout = pi_uutils_ctx::stdout();
	let mut stdout = stdout.lock();
	if n == 0 {
		return io::copy(&mut input, &mut stdout).map_err(wrap_in_stdout_error);
	}
	let mut bytes_written: u64 = 0;
	if let Some(n) = catch_too_large_numbers_in_backwards_bytes_or_lines(n) {
		bytes_written = copy_all_but_n_lines(input, &mut stdout, n, separator)
			.map_err(wrap_in_stdout_error)?
			.try_into()
			.unwrap();
		// Make sure we finish writing everything to the target before
		// exiting. Otherwise, when Rust is implicitly flushing, any
		// error will be silently ignored.
		stdout.flush().map_err(wrap_in_stdout_error)?;
	}
	Ok(bytes_written)
}

/// Return the index in `input` just after the `n`th line from the end.
///
/// If `n` exceeds the number of lines in this file, then return 0.
/// This function rewinds the cursor to the
/// beginning of the input just before returning unless there is an
/// I/O error.
///
/// # Errors
///
/// This function returns an error if there is a problem seeking
/// through or reading the input.
///
/// # Examples
///
/// The function returns the index of the byte immediately following
/// the line ending character of the `n`th line from the end of the
/// input:
///
/// ```rust,ignore
/// let mut input = Cursor::new("x\ny\nz\n");
/// assert_eq!(find_nth_line_from_end(&mut input, 0, false).unwrap(), 6);
/// assert_eq!(find_nth_line_from_end(&mut input, 1, false).unwrap(), 4);
/// assert_eq!(find_nth_line_from_end(&mut input, 2, false).unwrap(), 2);
/// ```
///
/// If `n` exceeds the number of lines in the file, always return 0:
///
/// ```rust,ignore
/// let mut input = Cursor::new("x\ny\nz\n");
/// assert_eq!(find_nth_line_from_end(&mut input, 3, false).unwrap(), 0);
/// assert_eq!(find_nth_line_from_end(&mut input, 4, false).unwrap(), 0);
/// assert_eq!(find_nth_line_from_end(&mut input, 1000, false).unwrap(), 0);
/// ```
fn find_nth_line_from_end<R>(input: &mut R, n: u64, separator: u8) -> io::Result<u64>
where
	R: Read + Seek,
{
	let file_size = input.seek(SeekFrom::End(0))?;

	let mut buffer = [0u8; BUF_SIZE];

	let mut lines = 0u64;
	let mut check_last_byte_first_loop = true;
	let mut bytes_remaining_to_search = file_size;

	loop {
		// the casts here are ok, `buffer.len()` should never be above a few k
		let bytes_to_read_this_loop = bytes_remaining_to_search.min(buffer.len().try_into().unwrap());
		let read_start_offset = bytes_remaining_to_search - bytes_to_read_this_loop;
		let buffer = &mut buffer[..bytes_to_read_this_loop.try_into().unwrap()];
		bytes_remaining_to_search -= bytes_to_read_this_loop;

		input.seek(SeekFrom::Start(read_start_offset))?;
		input.read_exact(buffer)?;

		// Unfortunately need special handling for the case that the input file doesn't
		// have a terminating `separator` character.
		// If the input file doesn't end with a `separator` character, add an extra line
		// to our `line` counter. In the case that `n` is 0 we need to return here
		// since we've obviously found our 0th-line-from-the-end offset.
		if check_last_byte_first_loop {
			check_last_byte_first_loop = false;
			if let Some(last_byte_of_file) = buffer.last()
				&& last_byte_of_file != &separator
			{
				if n == 0 {
					input.rewind()?;
					return Ok(file_size);
				}
				assert_eq!(lines, 0);
				lines = 1;
			}
		}

		for separator_offset in memrchr_iter(separator, &buffer[..]) {
			lines += 1;
			if lines == n + 1 {
				input.rewind()?;
				return Ok(read_start_offset + TryInto::<u64>::try_into(separator_offset).unwrap() + 1);
			}
		}
		if read_start_offset == 0 {
			input.rewind()?;
			return Ok(0);
		}
	}
}

fn is_seekable(input: &mut File) -> bool {
	let current_pos = input.stream_position();
	current_pos.is_ok()
		&& input.seek(SeekFrom::End(0)).is_ok()
		&& input.seek(SeekFrom::Start(current_pos.unwrap())).is_ok()
}

fn head_backwards_file(input: &mut File, options: &HeadOptions) -> io::Result<u64> {
	let st = input.metadata()?;
	let seekable = is_seekable(input);
	let blksize_limit = uucore::fs::sane_blksize::sane_blksize_from_metadata(&st);
	if !seekable || st.len() <= blksize_limit || options.presume_input_pipe {
		head_backwards_without_seek_file(input, options)
	} else {
		head_backwards_on_seekable_file(input, options)
	}
}

fn head_backwards_without_seek_file(input: &mut File, options: &HeadOptions) -> io::Result<u64> {
	match options.mode {
		Mode::AllButLastBytes(n) => read_but_last_n_bytes(input, n),
		Mode::AllButLastLines(n) => read_but_last_n_lines(input, n, options.line_ending.into()),
		_ => unreachable!(),
	}
}

fn head_backwards_on_seekable_file(input: &mut File, options: &HeadOptions) -> io::Result<u64> {
	match options.mode {
		Mode::AllButLastBytes(n) => {
			let size = input.metadata()?.len();
			if n >= size {
				Ok(0)
			} else {
				read_n_bytes(input, size - n)
			}
		},
		Mode::AllButLastLines(n) => {
			let found = find_nth_line_from_end(input, n, options.line_ending.into())?;
			read_n_bytes(input, found)
		},
		_ => unreachable!(),
	}
}

fn head_file(input: &mut File, options: &HeadOptions) -> io::Result<u64> {
	match options.mode {
		Mode::FirstBytes(n) => read_n_bytes(input, n),
		Mode::FirstLines(n) => read_n_lines(
			&mut io::BufReader::with_capacity(BUF_SIZE, input),
			n,
			options.line_ending.into(),
		),
		Mode::AllButLastBytes(_) | Mode::AllButLastLines(_) => head_backwards_file(input, options),
	}
}

#[allow(clippy::cognitive_complexity)]
fn uu_head(options: &HeadOptions) -> UResult<()> {
	let mut first = true;
	for file in &options.files {
		let res = if file == "-" {
			if (options.files.len() > 1 && !options.quiet) || options.verbose {
				if !first {
					let _ = writeln!(pi_uutils_ctx::stdout());
				}
				let _ = writeln!(pi_uutils_ctx::stdout(), "==> standard input <==");
			}
			// pi-uutils: stdin is routed through the context as a plain reader,
			// so always take the streaming (non-seekable) path.
			let mut stdin = io::BufReader::with_capacity(BUF_SIZE, pi_uutils_ctx::stdin());
			match options.mode {
				Mode::FirstBytes(n) => read_n_bytes(&mut stdin, n),
				Mode::AllButLastBytes(n) => read_but_last_n_bytes(&mut stdin, n),
				Mode::FirstLines(n) => read_n_lines(&mut stdin, n, options.line_ending.into()),
				Mode::AllButLastLines(n) => {
					read_but_last_n_lines(&mut stdin, n, options.line_ending.into())
				},
			}
			.map(|_| ())
		} else {
			// pi-uutils: resolve the operand against the shell working directory
			// for filesystem access; keep `file` for display/headers.
			let fs_path = pi_uutils_ctx::resolve(Path::new(file));
			if fs_path.is_dir() {
				let _ = writeln!(
					pi_uutils_ctx::stderr(),
					"head: error reading {}: Is a directory",
					file.quote()
				);
				pi_uutils_ctx::set_exit_code(1);
				first = false;
				continue;
			}
			let mut file_handle = match File::open(&fs_path) {
				Ok(f) => f,
				Err(err) => {
					let _ = writeln!(
						pi_uutils_ctx::stderr(),
						"head: cannot open {} for reading: {err}",
						file.quote()
					);
					pi_uutils_ctx::set_exit_code(1);
					first = false;
					continue;
				},
			};
			if (options.files.len() > 1 && !options.quiet) || options.verbose {
				if !first {
					let _ = writeln!(pi_uutils_ctx::stdout());
				}
				let _ = write!(pi_uutils_ctx::stdout(), "==> ");
				let _ = pi_uutils_ctx::stdout().write_all(file.as_encoded_bytes());
				let _ = writeln!(pi_uutils_ctx::stdout(), " <==");
			}
			head_file(&mut file_handle, options).map(|_| ())
		};
		if let Err(err) = res {
			let name = if file == "-" {
				"standard input".into()
			} else {
				file.into()
			};
			return Err(HeadError::Io { name, err }.into());
		}
		first = false;
	}
	// Even though this is returning `Ok`, it is possible that a call
	// to `show!()` and thus a call to `set_exit_code()` has been
	// called above. If that happens, then this process will exit with
	// a non-zero exit code.
	Ok(())
}

/// In-process builtin entry point. Keeps head's obsolete `-NUM` argument
/// normalization (`arg_iterate`) and, unlike upstream's `uumain`, renders clap
/// help/usage/version to the context streams and never calls
/// `std::process::exit`, so it is safe inside the host shell process.
pub fn run(argv: Vec<OsString>) -> i32 {
	let args: Vec<OsString> = match arg_iterate(argv.into_iter()) {
		Ok(iter) => iter.collect(),
		Err(err) => {
			let _ = writeln!(pi_uutils_ctx::stderr(), "head: {err}");
			return 1;
		},
	};
	let matches = match uu_app().try_get_matches_from(args) {
		Ok(matches) => matches,
		Err(err) => {
			let rendered = err.to_string();
			if err.use_stderr() {
				let _ = write!(pi_uutils_ctx::stderr(), "{rendered}");
				return 1;
			}
			let _ = write!(pi_uutils_ctx::stdout(), "{rendered}");
			return 0;
		},
	};
	let options = match HeadOptions::get_from(&matches) {
		Ok(options) => options,
		Err(err) => {
			let _ = writeln!(pi_uutils_ctx::stderr(), "head: {}", HeadError::MatchOption(err));
			return 1;
		},
	};
	match uu_head(&options) {
		Ok(()) => pi_uutils_ctx::exit_code(),
		Err(err) => {
			let code = err.code();
			let _ = writeln!(pi_uutils_ctx::stderr(), "head: {err}");
			if code == 0 { 1 } else { code }
		},
	}
}

#[cfg(test)]
mod tests {
	use std::ffi::OsString;

	use io::Cursor;

	use super::*;

	fn options(args: &str) -> Result<HeadOptions, String> {
		let combined = "head ".to_owned() + args;
		let args = combined.split_whitespace().map(OsString::from);
		let matches = uu_app()
			.get_matches_from(arg_iterate(args).map_err(|_| String::from("Arg iterate failed"))?);
		HeadOptions::get_from(&matches)
	}

	#[test]
	fn test_args_modes() {
		let args = options("-n -10M -vz").unwrap();
		assert_eq!(args.line_ending, LineEnding::Nul);
		assert!(args.verbose);
		assert_eq!(args.mode, Mode::AllButLastLines(10 * 1024 * 1024));
	}

	#[test]
	fn test_gnu_compatibility() {
		let args = options("-n 1 -c 1 -n 5 -c kiB -vqvqv").unwrap(); // spell-checker:disable-line
		assert_eq!(args.mode, Mode::FirstBytes(1024));
		assert!(args.verbose);
		assert_eq!(options("-5").unwrap().mode, Mode::FirstLines(5));
		assert_eq!(options("-2b").unwrap().mode, Mode::FirstBytes(1024));
		assert_eq!(options("-5 -c 1").unwrap().mode, Mode::FirstBytes(1));
	}

	#[test]
	#[allow(clippy::cognitive_complexity)]
	fn all_args_test() {
		assert!(options("--silent").unwrap().quiet);
		assert!(options("--quiet").unwrap().quiet);
		assert!(options("-q").unwrap().quiet);
		assert!(options("--verbose").unwrap().verbose);
		assert!(options("-v").unwrap().verbose);
		assert_eq!(options("--zero-terminated").unwrap().line_ending, LineEnding::Nul);
		assert_eq!(options("-z").unwrap().line_ending, LineEnding::Nul);
		assert_eq!(options("--lines 15").unwrap().mode, Mode::FirstLines(15));
		assert_eq!(options("-n 15").unwrap().mode, Mode::FirstLines(15));
		assert_eq!(options("--bytes 15").unwrap().mode, Mode::FirstBytes(15));
		assert_eq!(options("-c 15").unwrap().mode, Mode::FirstBytes(15));
	}

	#[test]
	fn test_options_errors() {
		assert!(options("-n IsThisTheRealLife?").is_err());
		assert!(options("-c IsThisJustFantasy").is_err());
	}

	#[test]
	fn test_options_correct_defaults() {
		let opts = HeadOptions::default();

		assert!(!opts.verbose);
		assert!(!opts.quiet);
		assert_eq!(opts.line_ending, LineEnding::Newline);
		assert_eq!(opts.mode, Mode::FirstLines(10));
		assert!(opts.files.is_empty());
	}

	fn arg_outputs(src: &str) -> Result<String, ()> {
		let split = src.split_whitespace().map(OsString::from);
		match arg_iterate(split) {
			Ok(args) => {
				let vec = args
					.map(|s| s.to_str().unwrap().to_owned())
					.collect::<Vec<_>>();
				Ok(vec.join(" "))
			},
			Err(_) => Err(()),
		}
	}

	#[test]
	fn test_arg_iterate() {
		// test that normal args remain unchanged
		assert_eq!(arg_outputs("head -n -5 -zv"), Ok("head -n -5 -zv".to_owned()));
		// tests that nonsensical args are unchanged
		assert_eq!(
			arg_outputs("head -to_be_or_not_to_be,..."),
			Ok("head -to_be_or_not_to_be,...".to_owned())
		);
		//test that the obsolete syntax is unrolled
		assert_eq!(
			arg_outputs("head -123qvqvqzc"), // spell-checker:disable-line
			Ok("head -q -z -c 123".to_owned())
		);
		//test that bad obsoletes are an error
		assert!(arg_outputs("head -123FooBar").is_err());
		//test overflow
		assert!(arg_outputs("head -100000000000000000000000000000000000000000").is_ok());
		//test that empty args remain unchanged
		assert_eq!(arg_outputs("head"), Ok("head".to_owned()));
	}

	#[test]
	#[cfg(target_os = "linux")]
	fn test_arg_iterate_bad_encoding() {
		use std::os::unix::ffi::OsStringExt;
		let invalid = OsString::from_vec(vec![b'\x80', b'\x81']);
		// this arises from a conversion from OsString to &str
		assert!(arg_iterate(vec![OsString::from("head"), invalid].into_iter()).is_ok());
	}

	#[test]
	fn read_early_exit() {
		let mut empty = io::BufReader::new(Cursor::new(Vec::new()));
		assert!(read_n_bytes(&mut empty, 0).is_ok());
		assert!(read_n_lines(&mut empty, 0, b'\n').is_ok());
	}

	#[test]
	fn test_find_nth_line_from_end() {
		// Make sure our input buffer is several multiples of BUF_SIZE in size
		// such that we can be reasonably confident we've exercised all logic paths.
		// Make the contents of the buffer look like...
		// aaaa\n
		// aaaa\n
		// aaaa\n
		// aaaa\n
		// aaaa\n
		// ...
		// This will make it easier to validate the results since each line will have
		// 5 bytes in it.

		let minimum_buffer_size = BUF_SIZE * 4;
		let mut input_buffer = vec![];
		let mut loop_iteration: u64 = 0;
		while input_buffer.len() < minimum_buffer_size {
			for _n in 0..4 {
				input_buffer.push(b'a');
			}
			loop_iteration += 1;
			input_buffer.push(b'\n');
		}

		let lines_in_input_file = loop_iteration;
		let input_length = lines_in_input_file * 5;
		assert_eq!(input_length, input_buffer.len().try_into().unwrap());
		let mut input = Cursor::new(input_buffer);
		// We now have loop_iteration lines in the buffer Now walk backwards through the
		// buffer to confirm everything parses correctly.
		// Use a large step size to prevent the test from taking too long, but don't use
		// a power of 2 in case we miss some corner case.
		let step_size = 511;
		for n in (0..lines_in_input_file).filter(|v| v % step_size == 0) {
			// The 5*n comes from 5-bytes per row.
			assert_eq!(find_nth_line_from_end(&mut input, n, b'\n').unwrap(), input_length - 5 * n);
		}

		// Now confirm that if we query with a value >= lines_in_input_file we get an
		// offset of 0
		assert_eq!(find_nth_line_from_end(&mut input, lines_in_input_file, b'\n').unwrap(), 0);
		assert_eq!(find_nth_line_from_end(&mut input, lines_in_input_file + 1, b'\n').unwrap(), 0);
		assert_eq!(find_nth_line_from_end(&mut input, lines_in_input_file + 1000, b'\n').unwrap(), 0);
	}

	#[test]
	fn test_find_nth_line_from_end_non_terminated() {
		// Validate the find_nth_line_from_end for files that are not terminated with a
		// final newline character.
		let input_file = "a\nb";
		let mut input = Cursor::new(input_file);
		assert_eq!(find_nth_line_from_end(&mut input, 0, b'\n').unwrap(), 3);
		assert_eq!(find_nth_line_from_end(&mut input, 1, b'\n').unwrap(), 2);
	}

	#[test]
	fn test_find_nth_line_from_end_empty() {
		// Validate the find_nth_line_from_end for files that are empty.
		let input_file = "";
		let mut input = Cursor::new(input_file);
		assert_eq!(find_nth_line_from_end(&mut input, 0, b'\n').unwrap(), 0);
		assert_eq!(find_nth_line_from_end(&mut input, 1, b'\n').unwrap(), 0);
	}
}
