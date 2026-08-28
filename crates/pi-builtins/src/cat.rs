//! `cat` builtin: concatenate files to standard output.
//!
//! Ported from uutils coreutils 0.8.0.

#[cfg(unix)]
use std::os::unix::fs::FileTypeExt;
use std::{
	ffi::OsString,
	fs::{File, metadata},
	io::{self, ErrorKind, Read, Write},
	path::Path,
};

use clap::{Arg, ArgAction, ArgMatches, Command};
use memchr::memchr2;
use thiserror::Error;
use uucore::{display::Quotable, fast_inc::fast_inc_one};

use brush_core::{ShellExtensions, builtins::Registration};

use crate::host::{Host, Utility, format_usage, matches_parser, util};

const LINE_NUMBER_BUF_SIZE: usize = 32;

struct LineNumber {
	buf:         [u8; LINE_NUMBER_BUF_SIZE],
	print_start: usize,
	num_start:   usize,
	num_end:     usize,
}

// Logic to store a string for the line number. Manually incrementing the value
// represented in a buffer like this is significantly faster than storing a
// `usize` and using the standard Rust formatting macros to format a `usize` to
// a string each time it's needed.
// Buffer is initialized to "     1\t" and incremented each time `increment` is
// called, using uucore's fast_inc function that operates on strings.
impl LineNumber {
	fn new() -> Self {
		let mut buf = [b'0'; LINE_NUMBER_BUF_SIZE];

		let init_str = "     1\t";
		let print_start = buf.len() - init_str.len();
		let num_start = buf.len() - 2;
		let num_end = buf.len() - 1;

		buf[print_start..].copy_from_slice(init_str.as_bytes());

		Self { buf, print_start, num_start, num_end }
	}

	fn increment(&mut self) {
		fast_inc_one(&mut self.buf, &mut self.num_start, self.num_end);
		self.print_start = self.print_start.min(self.num_start);
	}

	#[inline]
	fn to_str(&self) -> &[u8] {
		&self.buf[self.print_start..]
	}

	fn write(&self, writer: &mut impl Write) -> io::Result<()> {
		writer.write_all(self.to_str())
	}
}

#[derive(Error, Debug)]
enum CatError {
	/// Wrapper around `io::Error`.
	#[error("{}", strip_errno(.0))]
	Io(io::Error),
	/// The downstream reader closed its pipe; this ends the copy quietly.
	#[error("broken pipe")]
	BrokenPipe,
	/// Unknown file type; it is not a regular file, socket, or known device.
	#[error("unknown filetype: {ft_debug}")]
	UnknownFiletype { ft_debug: String },
	#[error("Is a directory")]
	IsDirectory,
	#[cfg(unix)]
	#[error("No such device or address")]
	NoSuchDeviceOrAddress,
	#[error("Too many levels of symbolic links")]
	TooManySymlinks,
}

impl From<io::Error> for CatError {
	fn from(error: io::Error) -> Self {
		if error.kind() == ErrorKind::BrokenPipe {
			Self::BrokenPipe
		} else {
			Self::Io(error)
		}
	}
}

fn strip_errno(error: &io::Error) -> String {
	let mut message = error.to_string();
	if let Some(position) = message.find(" (os error ") {
		message.truncate(position);
	}
	message
}

type CatResult<T> = Result<T, CatError>;

#[derive(PartialEq)]
enum NumberingMode {
	None,
	NonEmpty,
	All,
}

struct OutputOptions {
	/// Line numbering mode.
	number: NumberingMode,
	/// Suppress repeated empty output lines.
	squeeze_blank: bool,
	/// Display TAB characters as `tab`.
	show_tabs: bool,
	/// Show end of lines.
	show_ends: bool,
	/// Use ^ and M- notation, except for LF and TAB.
	show_nonprint: bool,
}

impl OutputOptions {
	fn tab(&self) -> &'static str {
		if self.show_tabs { "^I" } else { "\t" }
	}

	fn end_of_line(&self) -> &'static str {
		if self.show_ends { "$\n" } else { "\n" }
	}

	/// We can write fast when no output augmentation is requested.
	fn can_write_fast(&self) -> bool {
		!(self.show_tabs
			|| self.show_nonprint
			|| self.show_ends
			|| self.squeeze_blank
			|| self.number != NumberingMode::None)
	}
}

/// State that persists between files on the augmented-output path.
struct OutputState {
	line_number: LineNumber,
	at_line_start: bool,
	skipped_carriage_return: bool,
	one_blank_kept: bool,
}


/// An input stream and whether it is connected to an interactive terminal.
struct InputHandle<R: Read> {
	reader:         R,
	is_interactive: bool,
}

/// Concrete enum of recognized file types.
enum InputType {
	Directory,
	File,
	StdIn,
	SymLink,
	#[cfg(unix)]
	BlockDevice,
	#[cfg(unix)]
	CharacterDevice,
	#[cfg(unix)]
	Fifo,
	#[cfg(unix)]
	Socket,
}

mod options {
	pub static FILE: &str = "file";
	pub static SHOW_ALL: &str = "show-all";
	pub static NUMBER_NONBLANK: &str = "number-nonblank";
	pub static SHOW_NONPRINTING_ENDS: &str = "e";
	pub static SHOW_ENDS: &str = "show-ends";
	pub static NUMBER: &str = "number";
	pub static SQUEEZE_BLANK: &str = "squeeze-blank";
	pub static SHOW_NONPRINTING_TABS: &str = "t";
	pub static SHOW_TABS: &str = "show-tabs";
	pub static SHOW_NONPRINTING: &str = "show-nonprinting";
	pub static IGNORED_U: &str = "ignored-u";
}

/// Parsed `cat` invocation.
pub(crate) struct Cat {
	matches: ArgMatches,
}

matches_parser!(Cat, app);

impl Utility for Cat {
	const NAME: &'static str = "cat";

	fn run(self, host: &mut Host) -> i32 {
		let number_mode = if self.matches.get_flag(options::NUMBER_NONBLANK) {
			NumberingMode::NonEmpty
		} else if self.matches.get_flag(options::NUMBER) {
			NumberingMode::All
		} else {
			NumberingMode::None
		};

		let show_nonprint = [
			options::SHOW_ALL,
			options::SHOW_NONPRINTING_ENDS,
			options::SHOW_NONPRINTING_TABS,
			options::SHOW_NONPRINTING,
		]
		.iter()
		.any(|value| self.matches.get_flag(value));
		let show_ends = [options::SHOW_ENDS, options::SHOW_ALL, options::SHOW_NONPRINTING_ENDS]
			.iter()
			.any(|value| self.matches.get_flag(value));
		let show_tabs = [options::SHOW_ALL, options::SHOW_TABS, options::SHOW_NONPRINTING_TABS]
			.iter()
			.any(|value| self.matches.get_flag(value));
		let options = OutputOptions {
			number: number_mode,
			squeeze_blank: self.matches.get_flag(options::SQUEEZE_BLANK),
			show_tabs,
			show_ends,
			show_nonprint,
		};
		#[allow(clippy::unwrap_used, reason = "clap provides '-' by default")]
		let files = self.matches.get_many::<OsString>(options::FILE).unwrap();
		let mut stdout = host.stdout_writer();
		cat_files(files, &options, host, &mut stdout)
	}
}

/// The `cat` argument model.
fn app() -> Command {
	Command::new(Cat::NAME)
		.version("0.8.0")
		.override_usage(format_usage("cat [OPTION]... [FILE]..."))
		.about(
			"Concatenate FILE(s), or standard input, to standard output\nWith no FILE, or when FILE \
			 is -, read standard input.",
		)
		.infer_long_args(true)
		.args_override_self(true)
		.arg(
			Arg::new(options::FILE)
				.hide(true)
				.action(ArgAction::Append)
				.value_parser(clap::value_parser!(OsString))
				.default_value("-")
				.value_hint(clap::ValueHint::FilePath),
		)
		.arg(
			Arg::new(options::SHOW_ALL)
				.short('A')
				.long(options::SHOW_ALL)
				.help("equivalent to -vET")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NUMBER_NONBLANK)
				.short('b')
				.long(options::NUMBER_NONBLANK)
				.help("number nonempty output lines, overrides -n")
				// This must not override NUMBER: clap overriding is symmetric,
				// while `-b -n` must still use `-b` semantics.
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::SHOW_NONPRINTING_ENDS)
				.short('e')
				.help("equivalent to -vE")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::SHOW_ENDS)
				.short('E')
				.long(options::SHOW_ENDS)
				.help("display $ at end of each line")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NUMBER)
				.short('n')
				.long(options::NUMBER)
				.help("number all output lines")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::SQUEEZE_BLANK)
				.short('s')
				.long(options::SQUEEZE_BLANK)
				.help("suppress repeated empty output lines")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::SHOW_NONPRINTING_TABS)
				.short('t')
				.help("equivalent to -vT")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::SHOW_TABS)
				.short('T')
				.long(options::SHOW_TABS)
				.help("display TAB characters at ^I")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::SHOW_NONPRINTING)
				.short('v')
				.long(options::SHOW_NONPRINTING)
				.help("use ^ and M- notation, except for LF (\\n) and TAB (\\t)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::IGNORED_U)
				.short('u')
				.help("(ignored)")
				.action(ArgAction::SetTrue),
		)
}

fn cat_handle<R: Read>(
	handle: &mut InputHandle<R>,
	options: &OutputOptions,
	state: &mut OutputState,
	stdout: &mut impl Write,
) -> CatResult<()> {
	if options.can_write_fast() {
		write_fast(handle, stdout)
	} else {
		write_lines(handle, options, state, stdout)
	}
}

fn cat_path(
	path: &OsString,
	options: &OutputOptions,
	state: &mut OutputState,
	host: &mut Host,
	stdout: &mut impl Write,
) -> CatResult<()> {
	// Resolve every operand at the boundary, but retain `path` for diagnostics.
	let resolved = host.resolve(path);
	match get_input_type(path, &resolved)? {
		InputType::StdIn => {
			let mut handle = InputHandle { reader: &mut host.stdin, is_interactive: false };
			cat_handle(&mut handle, options, state, stdout)
		},
		InputType::Directory => Err(CatError::IsDirectory),
		#[cfg(unix)]
		InputType::Socket => Err(CatError::NoSuchDeviceOrAddress),
		_ => {
			let file = File::open(resolved)?;
			let mut handle = InputHandle { reader: file, is_interactive: false };
			cat_handle(&mut handle, options, state, stdout)
		},
	}
}

fn cat_files<'a, I>(
	files: I,
	options: &OutputOptions,
	host: &mut Host,
	stdout: &mut impl Write,
) -> i32
where
	I: IntoIterator<Item = &'a OsString>,
{
	let mut state = OutputState {
		line_number:             LineNumber::new(),
		at_line_start:           true,
		skipped_carriage_return: false,
		one_blank_kept:          false,
	};

	for path in files {
		match cat_path(path, options, &mut state, host, stdout) {
			Ok(()) => {},
			Err(CatError::BrokenPipe) => return host.exit_code(),
			Err(error) => host.error(format!("{}: {error}", path.maybe_quote()), 1),
		}
	}
	if state.skipped_carriage_return {
		let _ = stdout.write_all(b"\r");
		let _ = stdout.flush();
	}
	host.exit_code()
}

/// Classifies the input at `resolved`; `path` is retained to recognize `-`.
fn get_input_type(path: &OsString, resolved: &Path) -> CatResult<InputType> {
	if path == "-" {
		return Ok(InputType::StdIn);
	}

	let file_type = match metadata(resolved) {
		Ok(metadata) => metadata.file_type(),
		Err(error) => {
			if let Some(raw_error) = error.raw_os_error() {
				// ELOOP differs on Darwin and FreeBSD.
				#[cfg(not(any(target_os = "macos", target_os = "freebsd")))]
				let too_many_symlink_code = 40;
				#[cfg(any(target_os = "macos", target_os = "freebsd"))]
				let too_many_symlink_code = 62;
				if raw_error == too_many_symlink_code {
					return Err(CatError::TooManySymlinks);
				}
			}
			return Err(CatError::from(error));
		},
	};
	match file_type {
		#[cfg(unix)]
		file_type if file_type.is_block_device() => Ok(InputType::BlockDevice),
		#[cfg(unix)]
		file_type if file_type.is_char_device() => Ok(InputType::CharacterDevice),
		#[cfg(unix)]
		file_type if file_type.is_fifo() => Ok(InputType::Fifo),
		#[cfg(unix)]
		file_type if file_type.is_socket() => Ok(InputType::Socket),
		file_type if file_type.is_dir() => Ok(InputType::Directory),
		file_type if file_type.is_file() => Ok(InputType::File),
		file_type if file_type.is_symlink() => Ok(InputType::SymLink),
		_ => Err(CatError::UnknownFiletype { ft_debug: format!("{file_type:?}") }),
	}
}

/// Writes a handle to stdout with no output transformation.
fn write_fast<R: Read>(
	handle: &mut InputHandle<R>,
	stdout: &mut impl Write,
) -> CatResult<()> {
	let mut buf = [0; 1024 * 64];
	loop {
		match handle.reader.read(&mut buf) {
			Ok(0) => break,
			Ok(n) => stdout.write_all(&buf[..n])?,
			Err(error) if error.kind() == ErrorKind::Interrupted => {},
			Err(error) => return Err(error.into()),
		}
	}
	stdout.flush()?;
	Ok(())
}

/// Outputs a handle line by line with the requested transformations.
fn write_lines<R: Read>(
	handle: &mut InputHandle<R>,
	options: &OutputOptions,
	state: &mut OutputState,
	stdout: &mut impl Write,
) -> CatResult<()> {
	let mut in_buf = [0; 1024 * 31];

	loop {
		let n = match handle.reader.read(&mut in_buf) {
			Ok(0) => break,
			Ok(n) => n,
			Err(error) if error.kind() == ErrorKind::Interrupted => continue,
			Err(error) => return Err(error.into()),
		};
		let in_buf = &in_buf[..n];
		let mut pos = 0;
		while pos < n {
			if in_buf[pos] == b'\n' {
				write_new_line(stdout, options, state, handle.is_interactive)?;
				state.at_line_start = true;
				pos += 1;
				continue;
			}
			if state.skipped_carriage_return {
				stdout.write_all(b"\r")?;
				state.skipped_carriage_return = false;
				state.at_line_start = false;
			}
			state.one_blank_kept = false;
			if state.at_line_start && options.number != NumberingMode::None {
				state.line_number.write(stdout)?;
				state.line_number.increment();
			}

			let offset = write_end(stdout, &in_buf[pos..], options)?;
			if offset + pos == in_buf.len() {
				state.at_line_start = false;
				break;
			}
			if in_buf[pos + offset] == b'\r' {
				state.skipped_carriage_return = true;
			} else {
				assert_eq!(in_buf[pos + offset], b'\n');
				write_end_of_line(stdout, options.end_of_line().as_bytes(), handle.is_interactive)?;
				state.at_line_start = true;
			}
			pos += offset + 1;
		}
		// Flush before a pipe read can block so available output stays visible.
		stdout.flush()?;
	}
	Ok(())
}

/// Writes a newline, accounting for delayed carriage returns and numbering.
fn write_new_line<W: Write>(
	writer: &mut W,
	options: &OutputOptions,
	state: &mut OutputState,
	is_interactive: bool,
) -> CatResult<()> {
	if state.skipped_carriage_return {
		if options.show_ends {
			writer.write_all(b"^M")?;
		} else {
			writer.write_all(b"\r")?;
		}
		state.skipped_carriage_return = false;
		write_end_of_line(writer, options.end_of_line().as_bytes(), is_interactive)?;
		return Ok(());
	}
	if !state.at_line_start || !options.squeeze_blank || !state.one_blank_kept {
		state.one_blank_kept = true;
		if state.at_line_start && options.number == NumberingMode::All {
			state.line_number.write(writer)?;
			state.line_number.increment();
		}
		write_end_of_line(writer, options.end_of_line().as_bytes(), is_interactive)?;
	}
	Ok(())
}

fn write_end<W: Write>(
	writer: &mut W,
	in_buf: &[u8],
	options: &OutputOptions,
) -> io::Result<usize> {
	if options.show_nonprint {
		write_nonprint_to_end(in_buf, writer, options.tab().as_bytes())
	} else if options.show_tabs {
		write_tab_to_end(in_buf, writer)
	} else {
		write_to_end(in_buf, writer)
	}
}

// Write all symbols until newline, carriage return, or the buffer end. The
// nonprinting path need not stop at carriage return because it always emits ^M.
fn write_to_end<W: Write>(in_buf: &[u8], writer: &mut W) -> io::Result<usize> {
	if let Some(position) = memchr2(b'\n', b'\r', in_buf) {
		writer.write_all(&in_buf[..position])?;
		Ok(position)
	} else {
		writer.write_all(in_buf)?;
		Ok(in_buf.len())
	}
}

fn write_tab_to_end<W: Write>(mut in_buf: &[u8], writer: &mut W) -> io::Result<usize> {
	let mut count = 0;
	loop {
		if let Some(position) = in_buf
			.iter()
			.position(|byte| *byte == b'\n' || *byte == b'\t' || *byte == b'\r')
		{
			writer.write_all(&in_buf[..position])?;
			if in_buf[position] == b'\t' {
				writer.write_all(b"^I")?;
				in_buf = &in_buf[position + 1..];
				count += position + 1;
			} else {
				return Ok(count + position);
			}
		} else {
			writer.write_all(in_buf)?;
			return Ok(in_buf.len() + count);
		}
	}
}

fn write_nonprint_to_end<W: Write>(
	in_buf: &[u8],
	writer: &mut W,
	tab: &[u8],
) -> io::Result<usize> {
	let mut count = 0;
	for byte in in_buf.iter().copied() {
		if byte == b'\n' {
			break;
		}
		match byte {
			9 => writer.write_all(tab),
			0..=8 | 10..=31 => writer.write_all(&[b'^', byte + 64]),
			32..=126 => writer.write_all(&[byte]),
			127 => writer.write_all(b"^?"),
			128..=159 => writer.write_all(&[b'M', b'-', b'^', byte - 64]),
			160..=254 => writer.write_all(&[b'M', b'-', byte - 128]),
			_ => writer.write_all(b"M-^?"),
		}?;
		count += 1;
	}
	Ok(count)
}

fn write_end_of_line<W: Write>(
	writer: &mut W,
	end_of_line: &[u8],
	is_interactive: bool,
) -> CatResult<()> {
	writer.write_all(end_of_line)?;
	if is_interactive {
		writer.flush()?;
	}
	Ok(())
}

/// Creates the `cat` builtin registration.
pub(crate) fn cat_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Cat, SE>()
}

#[cfg(test)]
mod tests {
	use std::{fs, io::{BufWriter, sink}};

	use tempfile::tempdir;

	use super::{Cat, LineNumber, write_nonprint_to_end, write_tab_to_end};
	use crate::host::run_util;

	#[test]
	fn test_write_tab_to_end_with_newline() {
		let mut writer = BufWriter::with_capacity(1024 * 64, sink());
		assert_eq!(write_tab_to_end(b"a\tb\tc\n", &mut writer).unwrap(), 5);
	}

	#[test]
	fn test_write_tab_to_end_no_newline() {
		let mut writer = BufWriter::with_capacity(1024 * 64, sink());
		assert_eq!(write_tab_to_end(b"a\tb\tc", &mut writer).unwrap(), 5);
	}

	#[test]
	fn test_write_nonprint_to_end_new_line() {
		let mut writer = BufWriter::with_capacity(1024 * 64, sink());
		write_nonprint_to_end(b"\n", &mut writer, b"").unwrap();
		assert_eq!(writer.buffer().len(), 0);
	}

	#[test]
	fn test_write_nonprint_to_end_9() {
		let mut writer = BufWriter::with_capacity(1024 * 64, sink());
		write_nonprint_to_end(&[9], &mut writer, b"tab").unwrap();
		assert_eq!(writer.buffer(), b"tab");
	}

	#[test]
	fn test_write_nonprint_to_end_0_to_8() {
		for byte in 0_u8..=8 {
			let mut writer = BufWriter::with_capacity(1024 * 64, sink());
			write_nonprint_to_end(&[byte], &mut writer, b"").unwrap();
			assert_eq!(writer.buffer(), [b'^', byte + 64]);
		}
	}

	#[test]
	fn test_write_nonprint_to_end_10_to_31() {
		for byte in 11_u8..=31 {
			let mut writer = BufWriter::with_capacity(1024 * 64, sink());
			write_nonprint_to_end(&[byte], &mut writer, b"").unwrap();
			assert_eq!(writer.buffer(), [b'^', byte + 64]);
		}
	}

	#[test]
	fn test_incrementing_string() {
		let mut number = LineNumber::new();
		assert_eq!(b"     1\t", number.to_str());
		number.increment();
		assert_eq!(b"     2\t", number.to_str());
		for _ in 3..=100 {
			number.increment();
		}
		assert_eq!(b"   100\t", number.to_str());
		for _ in 101..=1_000_000 {
			number.increment();
		}
		assert_eq!(b"1000000\t", number.to_str());
		number.increment();
		assert_eq!(b"1000001\t", number.to_str());
	}

	#[test]
	fn missing_operand_reports_and_later_operand_is_processed() {
		let directory = tempdir().unwrap();
		fs::write(directory.path().join("present"), b"remaining\n").unwrap();
		let (code, capture) = run_util::<Cat>(&["missing", "present"], "", directory.path());
		assert_eq!(code, 1);
		assert_eq!(capture.out(), "remaining\n");
		assert_eq!(capture.err(), "cat: missing: No such file or directory\n");
	}
}
