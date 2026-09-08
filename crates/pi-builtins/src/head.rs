//! `head` builtin: print the first part of files.
//!
//! Ported from uutils coreutils 0.8.0.

use std::{
	ffi::OsString,
	fs::File,
	io::{self, Read, Seek, SeekFrom, Write},
	num::TryFromIntError,
	path::PathBuf,
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::ArgMatches;
use memchr::memrchr_iter;
use thiserror::Error;
use uucore::{display::Quotable, line_ending::LineEnding};

use crate::host::{Host, Utility, matches_parser, util};

const BUF_SIZE: usize = 65536;

mod cli {
//

use std::ffi::OsString;

use clap::{Arg, ArgAction, Command};
use crate::host::format_usage;

pub(super) mod options {
	pub const BYTES: &str = "BYTES";
	pub const LINES: &str = "LINES";
	pub const QUIET: &str = "QUIET";
	pub const VERBOSE: &str = "VERBOSE";
	pub const ZERO: &str = "ZERO";
	pub const FILES: &str = "FILE";
	pub const PRESUME_INPUT_PIPE: &str = "-PRESUME-INPUT-PIPE";
}

pub(super) fn uu_app() -> Command {
	Command::new("head")
		.version("0.8.0")
		.about(
			"Print the first 10 lines of each FILE to standard output.\nWith more than one FILE, \
			 precede each with a header giving the file name.\nWith no FILE, or when FILE is -, read \
			 standard input.",
		)
		.override_usage(format_usage("head [FLAG]... [FILE]..."))
		.infer_long_args(true)
		.arg(
			Arg::new(options::BYTES)
				.short('c')
				.long("bytes")
				.value_name("[-]NUM")
				.help(
					"print the first NUM bytes of each file;\nwith a leading '-', print all but the \
					 last\nNUM bytes of each file",
				)
				.overrides_with_all([options::BYTES, options::LINES])
				.allow_hyphen_values(true),
		)
		.arg(
			Arg::new(options::LINES)
				.short('n')
				.long("lines")
				.value_name("[-]NUM")
				.help(
					"print the first NUM lines instead of the first 10;\nwith a leading '-', print all \
					 but the last\nNUM lines of each file",
				)
				.overrides_with_all([options::LINES, options::BYTES])
				.allow_hyphen_values(true),
		)
		.arg(
			Arg::new(options::QUIET)
				.short('q')
				.long("quiet")
				.visible_alias("silent")
				.help("never print headers giving file names")
				.overrides_with_all([options::VERBOSE, options::QUIET])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::VERBOSE)
				.short('v')
				.long("verbose")
				.help("always print headers giving file names")
				.overrides_with_all([options::QUIET, options::VERBOSE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::PRESUME_INPUT_PIPE)
				.long("presume-input-pipe")
				.alias("-presume-input-pipe")
				.hide(true)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::ZERO)
				.short('z')
				.long("zero-terminated")
				.help("line delimiter is NUL, not newline")
				.overrides_with(options::ZERO)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::FILES)
				.action(ArgAction::Append)
				.value_parser(clap::value_parser!(OsString))
				.value_hint(clap::ValueHint::FilePath),
		)
}
}

use cli::{options, uu_app};

mod parse {
//

use std::ffi::OsString;

use uucore::parser::{
	parse_signed_num::{SignPrefix, parse_signed_num_max},
	parse_size::ParseSizeError,
};

#[derive(PartialEq, Eq, Debug)]
pub(super) struct ParseError;

/// Parses obsolete syntax
pub(super) fn parse_obsolete(src: &str) -> Option<Result<Vec<OsString>, ParseError>> {
	let mut chars = src.char_indices();
	if let Some((mut num_start, '-')) = chars.next() {
		num_start += 1;
		let mut num_end = src.len();
		let mut has_num = false;
		let mut plus_possible = false;
		let mut last_char = 0 as char;
		for (n, c) in &mut chars {
			if c.is_ascii_digit() {
				has_num = true;
				plus_possible = false;
			} else if c == '+' && plus_possible {
				plus_possible = false;
				num_start += 1;
			} else {
				num_end = n;
				last_char = c;
				break;
			}
		}
		if has_num {
			Some(process_num_block(&src[num_start..num_end], last_char, &mut chars))
		} else {
			None
		}
	} else {
		None
	}
}

/// Processes the numeric block of the input string to generate the appropriate
/// options.
fn process_num_block(
	src: &str,
	last_char: char,
	chars: &mut std::str::CharIndices,
) -> Result<Vec<OsString>, ParseError> {
	let num = match src.parse::<usize>() {
		Ok(n) => n,
		Err(e) if *e.kind() == std::num::IntErrorKind::PosOverflow => usize::MAX,
		_ => return Err(ParseError),
	};
	let mut quiet = false;
	let mut verbose = false;
	let mut zero_terminated = false;
	// Lowercase suffixes are byte multipliers (obsolete BSD `-Nc`/`-Nb`/`-Nk`/`-Nm`);
	// uppercase suffixes mirror the modern `-n NUM<suffix>` form and scale the
	// line count (`head -10K` == `head -n 10240`).
	let mut multiplier = None;
	let mut line_multiplier: usize = 1;
	let mut c = last_char;
	loop {
		match c {
			// we want to preserve order
			// this also saves us 1 heap allocation
			'q' => {
				quiet = true;
				verbose = false;
			},
			'v' => {
				verbose = true;
				quiet = false;
			},
			'z' => zero_terminated = true,
			'c' => multiplier = Some(1),
			'b' => multiplier = Some(512),
			'k' => multiplier = Some(1024),
			'm' => multiplier = Some(1024 * 1024),
			'K' => {
				line_multiplier = 1024;
				multiplier = None;
			},
			'M' => {
				line_multiplier = 1024 * 1024;
				multiplier = None;
			},
			'G' => {
				line_multiplier = 1024 * 1024 * 1024;
				multiplier = None;
			},
			'\0' => {},
			_ => return Err(ParseError),
		}
		if let Some((_, next)) = chars.next() {
			c = next;
		} else {
			break;
		}
	}
	let mut options = Vec::new();
	if quiet {
		options.push(OsString::from("-q"));
	}
	if verbose {
		options.push(OsString::from("-v"));
	}
	if zero_terminated {
		options.push(OsString::from("-z"));
	}
	if let Some(n) = multiplier {
		options.push(OsString::from("-c"));
		let num = num.saturating_mul(n);
		options.push(OsString::from(format!("{num}")));
	} else {
		options.push(OsString::from("-n"));
		let num = num.saturating_mul(line_multiplier);
		options.push(OsString::from(format!("{num}")));
	}
	Ok(options)
}

/// Parses an -c or -n argument,
/// the bool specifies whether to read from the end (all but last N)
pub(super) fn parse_num(src: &str) -> Result<(u64, bool), ParseSizeError> {
	let result = parse_signed_num_max(src)?;
	// head: '-' means "all but last N"
	let all_but_last = result.sign == Some(SignPrefix::Minus);
	Ok((result.value, all_but_last))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn obsolete(src: &str) -> Option<Result<Vec<String>, ParseError>> {
		let r = parse_obsolete(src);
		match r {
			Some(s) => match s {
				Ok(v) => Some(Ok(v
					.into_iter()
					.map(|s| s.to_str().unwrap().to_owned())
					.collect())),
				Err(e) => Some(Err(e)),
			},
			None => None,
		}
	}

	#[expect(clippy::unnecessary_wraps, reason = "test helper")]
	fn obsolete_result(src: &[&str]) -> Option<Result<Vec<String>, ParseError>> {
		Some(Ok(src.iter().map(|&s| s.to_string()).collect()))
	}

	#[test]
	#[allow(clippy::cognitive_complexity, reason = "table-style parser coverage")]
	fn test_parse_numbers_obsolete() {
		assert_eq!(obsolete("-5"), obsolete_result(&["-n", "5"]));
		assert_eq!(obsolete("-100"), obsolete_result(&["-n", "100"]));
		assert_eq!(obsolete("-5m"), obsolete_result(&["-c", "5242880"]));
		assert_eq!(obsolete("-1k"), obsolete_result(&["-c", "1024"]));
		assert_eq!(obsolete("-2b"), obsolete_result(&["-c", "1024"]));
		assert_eq!(obsolete("-1mmk"), obsolete_result(&["-c", "1024"]));
		assert_eq!(obsolete("-10K"), obsolete_result(&["-n", "10240"]));
		assert_eq!(obsolete("-1M"), obsolete_result(&["-n", "1048576"]));
		assert_eq!(obsolete("-1vz"), obsolete_result(&["-v", "-z", "-n", "1"]));
		assert_eq!(
			obsolete("-1vzqvq"),
			obsolete_result(&["-q", "-z", "-n", "1"])
		);
		assert_eq!(obsolete("-1vzc"), obsolete_result(&["-v", "-z", "-c", "1"]));
		assert_eq!(obsolete("-105kzm"), obsolete_result(&["-z", "-c", "110100480"]));
	}

	#[test]
	fn test_parse_errors_obsolete() {
		assert_eq!(obsolete("-5n"), Some(Err(ParseError)));
		assert_eq!(obsolete("-5c5"), Some(Err(ParseError)));
	}

	#[test]
	fn test_parse_obsolete_no_match() {
		assert_eq!(obsolete("-k"), None);
		assert_eq!(obsolete("asd"), None);
	}

	#[test]
	#[cfg(target_pointer_width = "64")]
	fn test_parse_obsolete_overflow_x64() {
		assert_eq!(obsolete("-1000000000000000m"), obsolete_result(&["-c", "18446744073709551615"]));
		assert_eq!(
			obsolete("-10000000000000000000000"),
			obsolete_result(&["-n", "18446744073709551615"])
		);
	}

	#[test]
	#[cfg(target_pointer_width = "32")]
	fn test_parse_obsolete_overflow_x32() {
		assert_eq!(obsolete("-42949672960"), obsolete_result(&["-n", "4294967295"]));
		assert_eq!(obsolete("-42949672k"), obsolete_result(&["-c", "4294967295"]));
	}
}
}

mod take {
//
//! Take all but the last elements of an iterator.
use std::{
	collections::VecDeque,
	io::{ErrorKind, Read, Write},
};

use memchr::memchr_iter;

const BUF_SIZE: usize = 65536;

struct TakeAllBuffer {
	buffer:      Vec<u8>,
	start_index: usize,
}

impl TakeAllBuffer {
	fn new() -> Self {
		Self { buffer: vec![], start_index: 0 }
	}

	fn fill_buffer(&mut self, reader: &mut impl Read) -> std::io::Result<usize> {
		self.buffer.resize(BUF_SIZE, 0);
		self.start_index = 0;
		loop {
			match reader.read(&mut self.buffer[..]) {
				Ok(n) => {
					self.buffer.truncate(n);
					return Ok(n);
				},
				Err(e) if e.kind() == ErrorKind::Interrupted => (),
				Err(e) => return Err(e),
			}
		}
	}

	fn write_bytes_exact(&mut self, writer: &mut impl Write, bytes: usize) -> std::io::Result<()> {
		let buffer_to_write = &self.remaining_buffer()[..bytes];
		writer.write_all(buffer_to_write)?;
		self.start_index += bytes;
		assert!(self.start_index <= self.buffer.len());
		Ok(())
	}

	fn write_all(&mut self, writer: &mut impl Write) -> std::io::Result<usize> {
		let remaining_bytes = self.remaining_bytes();
		self.write_bytes_exact(writer, remaining_bytes)?;
		Ok(remaining_bytes)
	}

	fn write_bytes_limit(
		&mut self,
		writer: &mut impl Write,
		max_bytes: usize,
	) -> std::io::Result<usize> {
		let bytes_to_write = self.remaining_bytes().min(max_bytes);
		self.write_bytes_exact(writer, bytes_to_write)?;
		Ok(bytes_to_write)
	}

	fn remaining_buffer(&self) -> &[u8] {
		&self.buffer[self.start_index..]
	}

	fn remaining_bytes(&self) -> usize {
		self.remaining_buffer().len()
	}

	fn is_empty(&self) -> bool {
		assert!(self.start_index <= self.buffer.len());
		self.start_index == self.buffer.len()
	}
}

/// Function to copy all but `n` bytes from the reader to the writer.
///
/// If `n` exceeds the number of bytes in the input file then nothing is copied.
/// If no errors are encountered then the function returns the number of bytes
/// copied.
///
/// Algorithm for this function is as follows...
/// 1 - Chunks of the input file are read into a queue of [`TakeAllBuffer`]
/// instances.     Chunks are read until at least we have enough data to write
/// out the entire contents of the     first [`TakeAllBuffer`] in the queue
/// whilst still retaining at least `n` bytes in the queue.     If we hit `EoF`
/// at any point, stop reading. 2 - Assess whether we managed to queue up
/// greater-than `n` bytes. If not, we must be done, in     which case break and
/// return. 3 - Write either the full first buffer of data, or just enough bytes
/// to get back down to having     the required `n` bytes of data queued.
/// 4 - Go back to (1).
pub(super) fn copy_all_but_n_bytes(
	reader: &mut impl Read,
	writer: &mut impl Write,
	n: usize,
) -> std::io::Result<usize> {
	let mut buffers: VecDeque<TakeAllBuffer> = VecDeque::new();
	let mut empty_buffer_pool: Vec<TakeAllBuffer> = vec![];
	let mut buffered_bytes: usize = 0;
	let mut total_bytes_copied = 0;
	loop {
		loop {
			// Try to buffer at least enough to write the entire first buffer.
			let front_buffer = buffers.front();
			if let Some(front_buffer) = front_buffer
				&& buffered_bytes >= n + front_buffer.remaining_bytes()
			{
				break;
			}
			let mut new_buffer = empty_buffer_pool.pop().unwrap_or_else(TakeAllBuffer::new);
			let filled_bytes = new_buffer.fill_buffer(reader)?;
			if filled_bytes == 0 {
				// filled_bytes==0 => Eof
				break;
			}
			buffers.push_back(new_buffer);
			buffered_bytes += filled_bytes;
		}

		// If we've got <=n bytes buffered here we have nothing left to do.
		if buffered_bytes <= n {
			break;
		}

		let excess_buffered_bytes = buffered_bytes - n;
		// Since we have some data buffered, can assume we have >=1 buffer - i.e. safe
		// to unwrap.
		let front_buffer = buffers.front_mut().unwrap();
		let bytes_written = front_buffer.write_bytes_limit(writer, excess_buffered_bytes)?;
		buffered_bytes -= bytes_written;
		total_bytes_copied += bytes_written;
		// If the front buffer is empty (which it probably is), push it into the
		// empty-buffer-pool.
		if front_buffer.is_empty() {
			empty_buffer_pool.push(buffers.pop_front().unwrap());
		}
	}
	Ok(total_bytes_copied)
}

struct TakeAllLinesBuffer {
	inner:            TakeAllBuffer,
	terminated_lines: usize,
	partial_line:     bool,
}

struct BytesAndLines {
	bytes:            usize,
	terminated_lines: usize,
}

impl TakeAllLinesBuffer {
	fn new() -> Self {
		Self { inner: TakeAllBuffer::new(), terminated_lines: 0, partial_line: false }
	}

	fn fill_buffer(
		&mut self,
		reader: &mut impl Read,
		separator: u8,
	) -> std::io::Result<BytesAndLines> {
		self.partial_line = false;
		let bytes_read = self.inner.fill_buffer(reader)?;
		// Count the number of lines...
		self.terminated_lines = memchr_iter(separator, self.inner.remaining_buffer()).count();
		if let Some(last_char) = self.inner.remaining_buffer().last()
			&& *last_char != separator
		{
			self.partial_line = true;
		}
		Ok(BytesAndLines { bytes: bytes_read, terminated_lines: self.terminated_lines })
	}

	fn write_lines(
		&mut self,
		writer: &mut impl Write,
		max_lines: usize,
		separator: u8,
	) -> std::io::Result<BytesAndLines> {
		assert!(max_lines > 0, "Must request at least 1 line.");
		let ret;
		if max_lines > self.terminated_lines {
			ret = BytesAndLines {
				bytes:            self.inner.write_all(writer)?,
				terminated_lines: self.terminated_lines,
			};
			self.terminated_lines = 0;
		} else {
			let index = memchr_iter(separator, self.inner.remaining_buffer()).nth(max_lines - 1);
			assert!(
				index.is_some(),
				"Somehow we're being asked to write more lines than we have, that's a bug in \
				 copy_all_but_lines."
			);
			let index = index.unwrap();
			// index is the offset of the separator character, zero indexed. Need to add 1
			// to get the number of bytes to write.
			let bytes_to_write = index + 1;
			self.inner.write_bytes_exact(writer, bytes_to_write)?;
			ret = BytesAndLines { bytes: bytes_to_write, terminated_lines: max_lines };
			self.terminated_lines -= max_lines;
		}
		Ok(ret)
	}

	fn is_empty(&self) -> bool {
		self.inner.is_empty()
	}

	fn terminated_lines(&self) -> usize {
		self.terminated_lines
	}

	fn partial_line(&self) -> bool {
		self.partial_line
	}
}

/// Function to copy all but `n` lines from the reader to the writer.
///
/// Lines are inferred from the `separator` value passed in by the client.
/// If `n` exceeds the number of lines in the input file then nothing is copied.
/// The last line in the file is not required to end with a `separator`
/// character. If no errors are encountered then they function returns the
/// number of bytes copied.
///
/// Algorithm for this function is as follows...
/// 1 - Chunks of the input file are read into a queue of [`TakeAllLinesBuffer`]
/// instances.     Chunks are read until at least we have enough lines that we
/// can write out the entire     contents of the first [`TakeAllLinesBuffer`] in
/// the queue whilst still retaining at least     `n` lines in the queue.
///     If we hit `EoF` at any point, stop reading.
/// 2 - Asses whether we managed to queue up greater-than `n` lines. If not, we
/// must be done, in     which case break and return.
/// 3 - Write either the full first buffer of data, or just enough lines to get
/// back down to     having the required `n` lines of data queued.
/// 4 - Go back to (1).
///
/// Note that lines will regularly straddle multiple [`TakeAllLinesBuffer`]
/// instances. The `partial_line` flag on [`TakeAllLinesBuffer`] tracks this,
/// and we use that to ensure that we write out enough lines in the case that
/// the input file doesn't end with a `separator` character.
pub(super) fn copy_all_but_n_lines<R: Read, W: Write>(
	mut reader: R,
	writer: &mut W,
	n: usize,
	separator: u8,
) -> std::io::Result<usize> {
	// This function requires `n` > 0. Assert it!
	assert!(n > 0);
	let mut buffers: VecDeque<TakeAllLinesBuffer> = VecDeque::new();
	let mut buffered_terminated_lines: usize = 0;
	let mut empty_buffers = vec![];
	let mut total_bytes_copied = 0;
	loop {
		// Try to buffer enough such that we can write out the entire first buffer.
		loop {
			// First check if we have enough lines buffered that we can write out the entire
			// front buffer. If so, break.
			let front_buffer = buffers.front();
			if let Some(front_buffer) = front_buffer
				&& buffered_terminated_lines > n + front_buffer.terminated_lines()
			{
				break;
			}
			// Else we need to try to buffer more data...
			let mut new_buffer = empty_buffers.pop().unwrap_or_else(TakeAllLinesBuffer::new);
			let fill_result = new_buffer.fill_buffer(&mut reader, separator)?;
			if fill_result.bytes == 0 {
				// fill_result.bytes == 0 => EoF.
				break;
			}
			buffered_terminated_lines += fill_result.terminated_lines;
			buffers.push_back(new_buffer);
		}

		// If we've not buffered more lines than we need to hold back we must be done.
		if buffered_terminated_lines < n
			|| (buffered_terminated_lines == n && !buffers.back().unwrap().partial_line())
		{
			break;
		}

		let excess_buffered_terminated_lines = buffered_terminated_lines - n;
		// Since we have some data buffered can assume we have at least 1 buffer, so
		// safe to unwrap.
		let lines_to_write = if buffers.back().unwrap().partial_line() {
			excess_buffered_terminated_lines + 1
		} else {
			excess_buffered_terminated_lines
		};
		let front_buffer = buffers.front_mut().unwrap();
		let write_result = front_buffer.write_lines(writer, lines_to_write, separator)?;
		buffered_terminated_lines -= write_result.terminated_lines;
		total_bytes_copied += write_result.bytes;
		// If the front buffer is empty (which it probably is), push it into the
		// empty-buffer-pool.
		if front_buffer.is_empty() {
			empty_buffers.push(buffers.pop_front().unwrap());
		}
	}
	Ok(total_bytes_copied)
}

/// Like `std::io::Take`, but for lines instead of bytes.
///
/// This struct is generally created by calling [`take_lines`] on a
/// reader. Please see the documentation of [`take_lines`] for more
/// details.
pub(super) struct TakeLines<T> {
	inner:     T,
	limit:     u64,
	separator: u8,
}

impl<T: Read> Read for TakeLines<T> {
	/// Read bytes from a buffer up to the requested number of lines.
	fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
		if self.limit == 0 {
			return Ok(0);
		}
		match self.inner.read(buf) {
			Ok(0) => Ok(0),
			Ok(n) => {
				for i in memchr_iter(self.separator, &buf[..n]) {
					self.limit -= 1;
					if self.limit == 0 {
						return Ok(i + 1);
					}
				}
				Ok(n)
			},
			Err(e) => Err(e),
		}
	}
}

/// Create an adaptor that will read at most `limit` lines from a given reader.
///
/// This function returns a new instance of `Read` that will read at
/// most `limit` lines, after which it will always return EOF
/// (`Ok(0)`).
///
/// The `separator` defines the character to interpret as the line
/// ending. For the usual notion of "line", set this to `b'\n'`.
pub(super) fn take_lines<R>(reader: R, limit: u64, separator: u8) -> TakeLines<R> {
	TakeLines { inner: reader, limit, separator }
}

#[cfg(test)]
mod tests {

	use std::io::{BufRead, BufReader};

	use super::{
		TakeAllBuffer, TakeAllLinesBuffer, copy_all_but_n_bytes, copy_all_but_n_lines, take_lines,
	};

	#[test]
	fn test_take_all_buffer_exact_bytes() {
		let input_buffer = "abc";
		let mut input_reader = std::io::Cursor::new(input_buffer);
		let mut take_all_buffer = TakeAllBuffer::new();
		let bytes_read = take_all_buffer.fill_buffer(&mut input_reader).unwrap();
		assert_eq!(bytes_read, input_buffer.len());
		assert_eq!(take_all_buffer.remaining_bytes(), input_buffer.len());
		assert_eq!(take_all_buffer.remaining_buffer(), input_buffer.as_bytes());
		assert!(!take_all_buffer.is_empty());
		let mut output_reader = std::io::Cursor::new(vec![0x10; 0]);
		for (index, c) in input_buffer.bytes().enumerate() {
			take_all_buffer
				.write_bytes_exact(&mut output_reader, 1)
				.unwrap();
			let buf_ref = output_reader.get_ref();
			assert_eq!(buf_ref.len(), index + 1);
			assert_eq!(buf_ref[index], c);
			assert_eq!(take_all_buffer.remaining_bytes(), input_buffer.len() - (index + 1));
			assert_eq!(take_all_buffer.remaining_buffer(), &input_buffer.as_bytes()[index + 1..]);
		}

		assert!(take_all_buffer.is_empty());
		assert_eq!(take_all_buffer.remaining_bytes(), 0);
		assert_eq!(take_all_buffer.remaining_buffer(), "".as_bytes());
	}

	#[test]
	fn test_take_all_buffer_all_bytes() {
		let input_buffer = "abc";
		let mut input_reader = std::io::Cursor::new(input_buffer);
		let mut take_all_buffer = TakeAllBuffer::new();
		let bytes_read = take_all_buffer.fill_buffer(&mut input_reader).unwrap();
		assert_eq!(bytes_read, input_buffer.len());
		assert_eq!(take_all_buffer.remaining_bytes(), input_buffer.len());
		let mut output_reader = std::io::Cursor::new(vec![0x10; 0]);
		let bytes_written = take_all_buffer.write_all(&mut output_reader).unwrap();
		assert_eq!(bytes_written, input_buffer.len());
		assert_eq!(output_reader.get_ref().as_slice(), input_buffer.as_bytes());

		assert!(take_all_buffer.is_empty());
		assert_eq!(take_all_buffer.remaining_bytes(), 0);
		assert_eq!(take_all_buffer.remaining_buffer(), "".as_bytes());

		// Now do a write_all on an empty TakeAllBuffer. Confirm correct behavior.
		let mut output_reader = std::io::Cursor::new(vec![0x10; 0]);
		let bytes_written = take_all_buffer.write_all(&mut output_reader).unwrap();
		assert_eq!(bytes_written, 0);
		assert_eq!(output_reader.get_ref().as_slice().len(), 0);
	}

	#[test]
	fn test_take_all_buffer_limit_bytes() {
		let input_buffer = "abc";
		let mut input_reader = std::io::Cursor::new(input_buffer);
		let mut take_all_buffer = TakeAllBuffer::new();
		let bytes_read = take_all_buffer.fill_buffer(&mut input_reader).unwrap();
		assert_eq!(bytes_read, input_buffer.len());
		assert_eq!(take_all_buffer.remaining_bytes(), input_buffer.len());
		let mut output_reader = std::io::Cursor::new(vec![0x10; 0]);
		// Write all but 1 bytes.
		let bytes_to_write = input_buffer.len() - 1;
		let bytes_written = take_all_buffer
			.write_bytes_limit(&mut output_reader, bytes_to_write)
			.unwrap();
		assert_eq!(bytes_written, bytes_to_write);
		assert_eq!(output_reader.get_ref().as_slice(), &input_buffer.as_bytes()[..bytes_to_write]);
		assert!(!take_all_buffer.is_empty());
		assert_eq!(take_all_buffer.remaining_bytes(), 1);
		assert_eq!(take_all_buffer.remaining_buffer(), &input_buffer.as_bytes()[bytes_to_write..]);

		// Write 1 more byte - i.e. last byte in buffer.
		let bytes_to_write = 1;
		let bytes_written = take_all_buffer
			.write_bytes_limit(&mut output_reader, bytes_to_write)
			.unwrap();
		assert_eq!(bytes_written, bytes_to_write);
		assert_eq!(output_reader.get_ref().as_slice(), input_buffer.as_bytes());
		assert!(take_all_buffer.is_empty());
		assert_eq!(take_all_buffer.remaining_bytes(), 0);
		assert_eq!(take_all_buffer.remaining_buffer(), "".as_bytes());

		// Write 1 more byte - i.e. confirm behavior on already empty buffer.
		let mut output_reader = std::io::Cursor::new(vec![0x10; 0]);
		let bytes_to_write = 1;
		let bytes_written = take_all_buffer
			.write_bytes_limit(&mut output_reader, bytes_to_write)
			.unwrap();
		assert_eq!(bytes_written, 0);
		assert_eq!(output_reader.get_ref().as_slice().len(), 0);
		assert!(take_all_buffer.is_empty());
		assert_eq!(take_all_buffer.remaining_bytes(), 0);
		assert_eq!(take_all_buffer.remaining_buffer(), "".as_bytes());
	}

	#[test]
	#[allow(clippy::cognitive_complexity, reason = "exercises every buffer transition")]
	fn test_take_all_lines_buffer() {
		// 3 lines with new-lines and one partial line.
		let input_buffer = "a\nb\nc\ndef";
		let separator = b'\n';
		let mut input_reader = std::io::Cursor::new(input_buffer);
		let mut take_all_lines_buffer = TakeAllLinesBuffer::new();
		let fill_result = take_all_lines_buffer
			.fill_buffer(&mut input_reader, separator)
			.unwrap();
		assert_eq!(fill_result.bytes, input_buffer.len());
		assert_eq!(fill_result.terminated_lines, 3);
		assert_eq!(take_all_lines_buffer.terminated_lines(), 3);
		assert!(!take_all_lines_buffer.is_empty());
		assert!(take_all_lines_buffer.partial_line());

		// Write 1st line.
		let mut output_reader = std::io::Cursor::new(vec![0x10; 0]);
		let lines_to_write = 1;
		let write_result = take_all_lines_buffer
			.write_lines(&mut output_reader, lines_to_write, separator)
			.unwrap();
		assert_eq!(write_result.bytes, 2);
		assert_eq!(write_result.terminated_lines, lines_to_write);
		assert_eq!(output_reader.get_ref().as_slice(), "a\n".as_bytes());
		assert!(!take_all_lines_buffer.is_empty());
		assert_eq!(take_all_lines_buffer.terminated_lines(), 2);

		// Write 2nd line.
		let mut output_reader = std::io::Cursor::new(vec![0x10; 0]);
		let lines_to_write = 1;
		let write_result = take_all_lines_buffer
			.write_lines(&mut output_reader, lines_to_write, separator)
			.unwrap();
		assert_eq!(write_result.bytes, 2);
		assert_eq!(write_result.terminated_lines, lines_to_write);
		assert_eq!(output_reader.get_ref().as_slice(), "b\n".as_bytes());
		assert!(!take_all_lines_buffer.is_empty());
		assert_eq!(take_all_lines_buffer.terminated_lines(), 1);

		// Now try to write 3 lines even though we have only 1 line remaining. Should
		// write everything left in the buffer.
		let mut output_reader = std::io::Cursor::new(vec![0x10; 0]);
		let lines_to_write = 3;
		let write_result = take_all_lines_buffer
			.write_lines(&mut output_reader, lines_to_write, separator)
			.unwrap();
		assert_eq!(write_result.bytes, 5);
		assert_eq!(write_result.terminated_lines, 1);
		assert_eq!(output_reader.get_ref().as_slice(), "c\ndef".as_bytes());
		assert!(take_all_lines_buffer.is_empty());
		assert_eq!(take_all_lines_buffer.terminated_lines(), 0);

		// Test empty buffer.
		let input_buffer = "";
		let mut input_reader = std::io::Cursor::new(input_buffer);
		let mut take_all_lines_buffer = TakeAllLinesBuffer::new();
		let fill_result = take_all_lines_buffer
			.fill_buffer(&mut input_reader, separator)
			.unwrap();
		assert_eq!(fill_result.bytes, 0);
		assert_eq!(fill_result.terminated_lines, 0);
		assert_eq!(take_all_lines_buffer.terminated_lines(), 0);
		assert!(take_all_lines_buffer.is_empty());
		assert!(!take_all_lines_buffer.partial_line());

		// Test buffer that ends with newline.
		let input_buffer = "\n";
		let mut input_reader = std::io::Cursor::new(input_buffer);
		let mut take_all_lines_buffer = TakeAllLinesBuffer::new();
		let fill_result = take_all_lines_buffer
			.fill_buffer(&mut input_reader, separator)
			.unwrap();
		assert_eq!(fill_result.bytes, 1);
		assert_eq!(fill_result.terminated_lines, 1);
		assert_eq!(take_all_lines_buffer.terminated_lines(), 1);
		assert!(!take_all_lines_buffer.is_empty());
		assert!(!take_all_lines_buffer.partial_line());
	}

	#[test]
	fn test_copy_all_but_n_bytes() {
		// Test the copy_all_but_bytes fn. Test several scenarios...
		// 1 - Hold back more bytes than the input will provide. Should have nothing
		// written to output.
		let input_buffer = "a\nb\nc\ndef";
		let mut input_reader = std::io::Cursor::new(input_buffer);
		let mut output_reader = std::io::Cursor::new(vec![0x10; 0]);
		let bytes_copied =
			copy_all_but_n_bytes(&mut input_reader, &mut output_reader, input_buffer.len() + 1)
				.unwrap();
		assert_eq!(bytes_copied, 0);

		// 2 - Hold back exactly the number of bytes the input will provide. Should have
		// nothing written to output.
		let mut input_reader = std::io::Cursor::new(input_buffer);
		let mut output_reader = std::io::Cursor::new(vec![0x10; 0]);
		let bytes_copied =
			copy_all_but_n_bytes(&mut input_reader, &mut output_reader, input_buffer.len()).unwrap();
		assert_eq!(bytes_copied, 0);

		// 3 - Hold back 1 fewer byte than input will provide. Should have one byte
		// written to output.
		let mut input_reader = std::io::Cursor::new(input_buffer);
		let mut output_reader = std::io::Cursor::new(vec![0x10; 0]);
		let bytes_copied =
			copy_all_but_n_bytes(&mut input_reader, &mut output_reader, input_buffer.len() - 1)
				.unwrap();
		assert_eq!(bytes_copied, 1);
		assert_eq!(output_reader.get_ref()[..], input_buffer.as_bytes()[0..1]);
	}

	#[test]
	fn test_copy_all_but_n_lines() {
		// Test the copy_all_but_lines fn. Test several scenarios...
		// 1 - Hold back more lines than the input will provide. Should have nothing
		// written to output.
		let input_buffer = "a\nb\nc\ndef";
		let separator = b'\n';
		let mut input_reader = std::io::Cursor::new(input_buffer);
		let mut output_reader = std::io::Cursor::new(vec![0x10; 0]);
		let bytes_copied =
			copy_all_but_n_lines(&mut input_reader, &mut output_reader, 5, separator).unwrap();
		assert_eq!(bytes_copied, 0);

		// 2 - Hold back exactly the number of lines the input will provide. Should have
		// nothing written to output.
		let mut input_reader = std::io::Cursor::new(input_buffer);
		let mut output_reader = std::io::Cursor::new(vec![0x10; 0]);
		let bytes_copied =
			copy_all_but_n_lines(&mut input_reader, &mut output_reader, 4, separator).unwrap();
		assert_eq!(bytes_copied, 0);

		// 3 - Hold back 1 fewer lines than input will provide. Should have one line
		// written to output.
		let mut input_reader = std::io::Cursor::new(input_buffer);
		let mut output_reader = std::io::Cursor::new(vec![0x10; 0]);
		let bytes_copied =
			copy_all_but_n_lines(&mut input_reader, &mut output_reader, 3, separator).unwrap();
		assert_eq!(bytes_copied, 2);
		assert_eq!(output_reader.get_ref()[..], input_buffer.as_bytes()[0..2]);

		// Now test again with an input that has a new-line ending...
		// 4 - Hold back more lines than the input will provide. Should have nothing
		// written to output.
		let input_buffer = "a\nb\nc\ndef\n";
		let mut input_reader = std::io::Cursor::new(input_buffer);
		let mut output_reader = std::io::Cursor::new(vec![0x10; 0]);
		let bytes_copied =
			copy_all_but_n_lines(&mut input_reader, &mut output_reader, 5, separator).unwrap();
		assert_eq!(bytes_copied, 0);

		// 5 - Hold back exactly the number of lines the input will provide. Should have
		// nothing written to output.
		let mut input_reader = std::io::Cursor::new(input_buffer);
		let mut output_reader = std::io::Cursor::new(vec![0x10; 0]);
		let bytes_copied =
			copy_all_but_n_lines(&mut input_reader, &mut output_reader, 4, separator).unwrap();
		assert_eq!(bytes_copied, 0);

		// 6 - Hold back 1 fewer lines than input will provide. Should have one line
		// written to output.
		let mut input_reader = std::io::Cursor::new(input_buffer);
		let mut output_reader = std::io::Cursor::new(vec![0x10; 0]);
		let bytes_copied =
			copy_all_but_n_lines(&mut input_reader, &mut output_reader, 3, separator).unwrap();
		assert_eq!(bytes_copied, 2);
		assert_eq!(output_reader.get_ref()[..], input_buffer.as_bytes()[0..2]);
	}

	#[test]
	fn test_zero_lines() {
		let input_reader = std::io::Cursor::new("a\nb\nc\n");
		let output_reader = BufReader::new(take_lines(input_reader, 0, b'\n'));
		let mut iter = output_reader.lines().map(|l| l.unwrap());
		assert_eq!(None, iter.next());
	}

	#[test]
	fn test_fewer_lines() {
		let input_reader = std::io::Cursor::new("a\nb\nc\n");
		let output_reader = BufReader::new(take_lines(input_reader, 2, b'\n'));
		let mut iter = output_reader.lines().map(|l| l.unwrap());
		assert_eq!(Some(String::from("a")), iter.next());
		assert_eq!(Some(String::from("b")), iter.next());
		assert_eq!(None, iter.next());
	}

	#[test]
	fn test_more_lines() {
		let input_reader = std::io::Cursor::new("a\nb\nc\n");
		let output_reader = BufReader::new(take_lines(input_reader, 4, b'\n'));
		let mut iter = output_reader.lines().map(|l| l.unwrap());
		assert_eq!(Some(String::from("a")), iter.next());
		assert_eq!(Some(String::from("b")), iter.next());
		assert_eq!(Some(String::from("c")), iter.next());
		assert_eq!(None, iter.next());
	}
}
}

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


	#[error("{0}")]
	MatchOption(String),
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

/// True when `token` is an option that takes its value from the *next* argv
/// token, so that value must never be mistaken for an obsolete `-NUM` form
/// (e.g. the `-5` in `head -n -5 file`).
fn consumes_separate_value(token: &str) -> bool {
	if let Some(long) = token.strip_prefix("--") {
		if long.is_empty() || long.contains('=') {
			return false;
		}
		// clap infers unambiguous long-option prefixes.
		return ["lines", "bytes"].iter().any(|name| name.starts_with(long));
	}
	let Some(cluster) = token.strip_prefix('-') else {
		return false;
	};
	let mut chars = cluster.chars();
	while let Some(c) = chars.next() {
		match c {
			// Value-taking shorts: a trailing `-n`/`-c` consumes the next
			// token; anything after them in the cluster is an attached value.
			'n' | 'c' => return chars.next().is_none(),
			'q' | 'v' | 'z' => {},
			_ => return false,
		}
	}
	false
}

/// Rewrites every obsolete `-NUM[suffix]` token (before `--`) into modern
/// options, wherever it appears among flags and operands: GNU/BSD accept
/// `head -q -5 file`, `head file -5`, and `head -5 -20 file`.
fn arg_iterate(argv: Vec<OsString>) -> HeadResult<Vec<OsString>> {
	let mut rewritten = Vec::with_capacity(argv.len() + 1);
	let mut iter = argv.into_iter();
	// argv[0] is always present
	rewritten.extend(iter.next());
	let mut skip_value = false;
	let mut seen_ddash = false;
	for arg in iter {
		if skip_value || seen_ddash {
			skip_value = false;
			rewritten.push(arg);
			continue;
		}
		let Some(token) = arg.to_str() else {
			// Non-UTF-8 can't be an obsolete option like "-5"; treat it as a
			// regular file argument.
			rewritten.push(arg);
			continue;
		};
		if token == "--" {
			seen_ddash = true;
			rewritten.push(arg);
			continue;
		}
		if matches!(token.as_bytes(), [b'-', b'0'..=b'9', ..]) {
			match parse::parse_obsolete(token) {
				Some(Ok(options)) => {
					rewritten.extend(options);
					continue;
				},
				Some(Err(parse::ParseError)) => {
					return Err(HeadError::ParseError(format!(
						"bad argument format: {}",
						token.quote()
					)));
				},
				None => {},
			}
		}
		if token.len() > 1 && token.starts_with('-') {
			skip_value = consumes_separate_value(token);
		}
		rewritten.push(arg);
	}
	Ok(rewritten)
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


fn read_n_bytes(input: impl Read, output: &mut impl Write, n: u64) -> io::Result<u64> {
	let mut reader = input.take(n);
	let bytes_written = io::copy(&mut reader, output).map_err(wrap_in_stdout_error)?;
	output.flush().map_err(wrap_in_stdout_error)?;
	Ok(bytes_written)
}

fn read_n_lines(
	input: &mut impl io::BufRead,
	output: &mut impl Write,
	n: u64,
	separator: u8,
) -> io::Result<u64> {
	let mut reader = take_lines(input, n, separator);
	let bytes_written = io::copy(&mut reader, output).map_err(wrap_in_stdout_error)?;
	output.flush().map_err(wrap_in_stdout_error)?;
	Ok(bytes_written)
}

fn catch_too_large_numbers_in_backwards_bytes_or_lines(n: u64) -> Option<usize> {
	usize::try_from(n).ok()
}

fn read_but_last_n_bytes(mut input: impl Read, output: &mut impl Write, n: u64) -> io::Result<u64> {
	let mut bytes_written: u64 = 0;
	if let Some(n) = catch_too_large_numbers_in_backwards_bytes_or_lines(n) {
		bytes_written = copy_all_but_n_bytes(&mut input, output, n)
			.map_err(wrap_in_stdout_error)?
			.try_into()
			.unwrap();

		// Make sure we finish writing everything to the target before
		// exiting. Otherwise, when Rust is implicitly flushing, any
		// error will be silently ignored.
		output.flush().map_err(wrap_in_stdout_error)?;
	}
	Ok(bytes_written)
}

fn read_but_last_n_lines(mut input: impl Read, output: &mut impl Write, n: u64, separator: u8) -> io::Result<u64> {
	if n == 0 {
		return io::copy(&mut input, output).map_err(wrap_in_stdout_error);
	}
	let mut bytes_written: u64 = 0;
	if let Some(n) = catch_too_large_numbers_in_backwards_bytes_or_lines(n) {
		bytes_written = copy_all_but_n_lines(input, output, n, separator)
			.map_err(wrap_in_stdout_error)?
			.try_into()
			.unwrap();
		// Make sure we finish writing everything to the target before
		// exiting. Otherwise, when Rust is implicitly flushing, any
		// error will be silently ignored.
		output.flush().map_err(wrap_in_stdout_error)?;
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

fn head_backwards_file(input: &mut File, output: &mut impl Write, options: &HeadOptions) -> io::Result<u64> {
	let st = input.metadata()?;
	let seekable = is_seekable(input);
	let blksize_limit = uucore::fs::sane_blksize::sane_blksize_from_metadata(&st);
	if !seekable || st.len() <= blksize_limit || options.presume_input_pipe {
		head_backwards_without_seek_file(input, output, options)
	} else {
		head_backwards_on_seekable_file(input, output, options)
	}
}

fn head_backwards_without_seek_file(input: &mut File, output: &mut impl Write, options: &HeadOptions) -> io::Result<u64> {
	match options.mode {
		Mode::AllButLastBytes(n) => read_but_last_n_bytes(input, output, n),
		Mode::AllButLastLines(n) => read_but_last_n_lines(input, output, n, options.line_ending.into()),
		_ => unreachable!(),
	}
}

fn head_backwards_on_seekable_file(input: &mut File, output: &mut impl Write, options: &HeadOptions) -> io::Result<u64> {
	match options.mode {
		Mode::AllButLastBytes(n) => {
			let size = input.metadata()?.len();
			if n >= size {
				Ok(0)
			} else {
				read_n_bytes(input, output, size - n)
			}
		},
		Mode::AllButLastLines(n) => {
			let found = find_nth_line_from_end(input, n, options.line_ending.into())?;
			read_n_bytes(input, output, found)
		},
		_ => unreachable!(),
	}
}

fn head_file(input: &mut File, output: &mut impl Write, options: &HeadOptions) -> io::Result<u64> {
	match options.mode {
		Mode::FirstBytes(n) => read_n_bytes(input, output, n),
		Mode::FirstLines(n) => read_n_lines(
			&mut io::BufReader::with_capacity(BUF_SIZE, input),
			output,
			n,
			options.line_ending.into(),
		),
		Mode::AllButLastBytes(_) | Mode::AllButLastLines(_) => head_backwards_file(input, output, options),
	}
}

/// Parsed `head` invocation.
pub(crate) struct Head {
	matches: ArgMatches,
}

matches_parser!(Head, uu_app);

impl Utility for Head {
	const NAME: &'static str = "head";
	// Normalize GNU's obsolete `-NUM` syntax before clap sees argv; clap
	// otherwise treats it as an unknown short-option cluster.
	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		arg_iterate(argv).map_err(|err| err.to_string())
	}


	fn run(self, host: &mut Host) -> i32 {
		let options = match HeadOptions::get_from(&self.matches) {
			Ok(options) => options,
			Err(err) => {
				host.error(HeadError::MatchOption(err), 1);
				return 1;
			},
		};

		let print_headers = (options.files.len() > 1 && !options.quiet) || options.verbose;
		// GNU head only emits the blank separator line before a header when a
		// previous file actually produced output; open failures print nothing
		// and must not flip `first`.
		let mut first = true;
		fn print_header(out: &mut impl Write, name: &[u8], first: &mut bool) {
			if !*first {
				let _ = writeln!(out);
			}
			let _ = out.write_all(b"==> ");
			let _ = out.write_all(name);
			let _ = out.write_all(b" <==\n");
			*first = false;
		}
		let mut out = host.stdout_writer();
		for file in &options.files {
			let result = if file == "-" {
				if print_headers {
					print_header(&mut out, b"standard input", &mut first);
				}
				let mut input = io::BufReader::with_capacity(BUF_SIZE, &mut host.stdin);
				match options.mode {
					Mode::FirstBytes(n) => read_n_bytes(&mut input, &mut out, n),
					Mode::AllButLastBytes(n) => {
						read_but_last_n_bytes(&mut input, &mut out, n)
					},
					Mode::FirstLines(n) => {
						read_n_lines(&mut input, &mut out, n, options.line_ending.into())
					},
					Mode::AllButLastLines(n) => read_but_last_n_lines(
						&mut input,
						&mut out,
						n,
						options.line_ending.into(),
					),
				}
			} else {
				let resolved = host.resolve(file);
				if resolved.is_dir() {
					// GNU prints the header before reporting the read error,
					// and that header counts as produced output.
					if print_headers {
						print_header(&mut out, file.as_encoded_bytes(), &mut first);
					}
					host.error(format!("error reading {}: Is a directory", file.quote()), 1);
					continue;
				}
				let mut input = match File::open(&resolved) {
					Ok(input) => input,
					Err(err) => {
						host.error(format!("cannot open {} for reading: {err}", file.quote()), 1);
						continue;
					},
				};
				if print_headers {
					print_header(&mut out, file.as_encoded_bytes(), &mut first);
				}
				head_file(&mut input, &mut out, &options)
			};
			if let Err(err) = result {
				let name = if file == "-" {
					PathBuf::from("standard input")
				} else {
					PathBuf::from(file)
				};
				// A dead pipe ends the whole invocation; any other I/O error
				// only fails this operand, and GNU keeps going.
				if err.kind() == io::ErrorKind::BrokenPipe {
					return crate::host::SIGPIPE_EXIT_CODE;
				}
				host.error(HeadError::Io { name, err }, 1);
			}
		}
		if let Err(err) = out.flush() {
			host.error(wrap_in_stdout_error(err), 1);
		}
		host.exit_code()
	}
}

/// Creates the `head` builtin registration.
pub(crate) fn head_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Head, SE>()
}

#[cfg(test)]
mod tests {
	use std::{ffi::OsString, io::Cursor};

	use clap::Parser;
	use tempfile::tempdir;

	use super::*;
	use crate::host::run_util;

	fn options(args: &str) -> Result<HeadOptions, String> {
		let combined = "head ".to_owned() + args;
		let argv = combined.split_whitespace().map(OsString::from).collect();
		let argv = Head::rewrite_argv(argv)?;
		let parsed = Head::try_parse_from(argv).map_err(|err| err.to_string())?;
		HeadOptions::get_from(&parsed.matches)
	}

	#[test]
	fn argument_modes_and_obsolete_syntax() {
		let args = options("-n -10M -vz").unwrap();
		assert_eq!(args.line_ending, LineEnding::Nul);
		assert!(args.verbose);
		assert_eq!(args.mode, Mode::AllButLastLines(10 * 1024 * 1024));

		assert_eq!(options("-5").unwrap().mode, Mode::FirstLines(5));
		assert_eq!(options("-2b").unwrap().mode, Mode::FirstBytes(1024));
		assert_eq!(options("-5 -c 1").unwrap().mode, Mode::FirstBytes(1));
	}

	#[test]
	fn options_follow_gnu_last_one_wins_rules() {
		let args = options("-n 1 -c 1 -n 5 -c kiB -vqvqv").unwrap();
		assert_eq!(args.mode, Mode::FirstBytes(1024));
		assert!(args.verbose);
		assert!(options("--silent").unwrap().quiet);
		assert_eq!(options("--zero-terminated").unwrap().line_ending, LineEnding::Nul);
	}

	#[test]
	fn option_errors_are_reported() {
		assert!(options("-n IsThisTheRealLife?").is_err());
		assert!(options("-c IsThisJustFantasy").is_err());
		let (code, capture) = run_util::<Head>(&["-123FooBar"], "", "/");
		assert_eq!(code, 1);
		assert_eq!(capture.err(), "head: bad argument format: '-123FooBar'\n");
	}

	fn rewritten(argv: &[&str]) -> Vec<String> {
		Head::rewrite_argv(argv.iter().map(OsString::from).collect())
			.unwrap()
			.into_iter()
			.map(|arg| arg.to_str().unwrap().to_owned())
			.collect()
	}

	// Failure mode: obsolete `-NUM` was only recognized as argv[1], so
	// `head -q -5 file`, `head file -5`, and repeated counts were parse errors.
	#[test]
	fn obsolete_num_is_rewritten_at_any_position() {
		assert_eq!(rewritten(&["head", "-q", "-5", "f"]), ["head", "-q", "-n", "5", "f"]);
		assert_eq!(rewritten(&["head", "-v", "-20", "f"]), ["head", "-v", "-n", "20", "f"]);
		assert_eq!(rewritten(&["head", "f", "-5"]), ["head", "f", "-n", "5"]);
		assert_eq!(
			rewritten(&["head", "-5", "-20", "f"]),
			["head", "-n", "5", "-n", "20", "f"]
		);
		assert_eq!(rewritten(&["head", "-5qz", "f"]), ["head", "-q", "-z", "-n", "5", "f"]);
	}

	// Failure mode: `-5` following a value-taking option is that option's
	// value, and rewriting it would corrupt the invocation.
	#[test]
	fn option_values_and_post_ddash_operands_are_not_rewritten() {
		assert_eq!(rewritten(&["head", "-n", "-5", "f"]), ["head", "-n", "-5", "f"]);
		assert_eq!(rewritten(&["head", "-c", "-5", "f"]), ["head", "-c", "-5", "f"]);
		assert_eq!(rewritten(&["head", "--lines", "-5", "f"]), ["head", "--lines", "-5", "f"]);
		assert_eq!(rewritten(&["head", "--", "-5"]), ["head", "--", "-5"]);
		assert_eq!(rewritten(&["head", "-n5", "-", "f"]), ["head", "-n5", "-", "f"]);
	}

	// Failure mode: uppercase suffixes in the obsolete form were rejected
	// even though `head -n 10K` accepts them.
	#[test]
	fn obsolete_uppercase_suffixes_scale_lines() {
		assert_eq!(options("-10K").unwrap().mode, Mode::FirstLines(10 * 1024));
		assert_eq!(options("-1M").unwrap().mode, Mode::FirstLines(1024 * 1024));
		assert_eq!(options("-1G").unwrap().mode, Mode::FirstLines(1024 * 1024 * 1024));
		// Lowercase suffixes keep their historical byte meaning.
		assert_eq!(options("-1k").unwrap().mode, Mode::FirstBytes(1024));
	}

	// Failure mode: an unreadable operand flipped the separator state and the
	// next header gained a spurious leading blank line; a mid-list open error
	// must also not abort the remaining operands.
	#[test]
	fn open_error_produces_no_separator_and_processing_continues() {
		let dir = tempdir().unwrap();
		std::fs::write(dir.path().join("f1"), b"a\n").unwrap();
		std::fs::write(dir.path().join("f2"), b"b\n").unwrap();
		let (code, capture) = run_util::<Head>(&["-n", "1", "missing", "f1", "f2"], "", dir.path());
		assert_eq!(code, 1);
		assert_eq!(capture.out(), "==> f1 <==\na\n\n==> f2 <==\nb\n");
		assert!(capture.err().contains("cannot open 'missing' for reading"));
	}

	// Failure mode: the `==> dir <==` header was suppressed before the
	// Is-a-directory diagnostic; GNU prints it and counts it as output.
	#[test]
	fn directory_operand_prints_header_before_error() {
		let dir = tempdir().unwrap();
		std::fs::create_dir(dir.path().join("d")).unwrap();
		std::fs::write(dir.path().join("f"), b"a\n").unwrap();
		let (code, capture) = run_util::<Head>(&["-n", "1", "d", "f"], "", dir.path());
		assert_eq!(code, 1);
		assert_eq!(capture.out(), "==> d <==\n\n==> f <==\na\n");
		assert_eq!(capture.err(), "head: error reading 'd': Is a directory\n");
	}

	#[test]
	fn defaults_to_ten_lines_from_stdin() {
		let input = (1..=12).map(|n| format!("{n}\n")).collect::<String>();
		let (code, capture) = run_util::<Head>(&[], &input, "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), (1..=10).map(|n| format!("{n}\n")).collect::<String>());
	}

	#[test]
	fn resolves_operands_against_host_cwd_but_prints_supplied_name() {
		let dir = tempdir().unwrap();
		std::fs::write(dir.path().join("input"), b"a\nb\n").unwrap();
		let (code, capture) = run_util::<Head>(&["-v", "input"], "", dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "==> input <==\na\nb\n");
	}

	#[test]
	fn negative_line_count_on_file_uses_resolved_handle() {
		let dir = tempdir().unwrap();
		std::fs::write(dir.path().join("input"), b"a\nb\nc\n").unwrap();
		let (code, capture) = run_util::<Head>(&["-n", "-1", "input"], "", dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "a\nb\n");
	}

	#[test]
	fn find_nth_line_from_end_handles_large_and_unterminated_inputs() {
		let mut input_buffer = Vec::new();
		while input_buffer.len() < BUF_SIZE * 4 {
			input_buffer.extend_from_slice(b"aaaa\n");
		}
		let input_length = input_buffer.len() as u64;
		let lines = input_length / 5;
		let mut input = Cursor::new(input_buffer);
		for n in (0..lines).filter(|v| v % 511 == 0) {
			assert_eq!(find_nth_line_from_end(&mut input, n, b'\n').unwrap(), input_length - 5 * n);
		}
		assert_eq!(find_nth_line_from_end(&mut input, lines, b'\n').unwrap(), 0);

		let mut input = Cursor::new("a\nb");
		assert_eq!(find_nth_line_from_end(&mut input, 0, b'\n').unwrap(), 3);
		assert_eq!(find_nth_line_from_end(&mut input, 1, b'\n').unwrap(), 2);
	}
}
