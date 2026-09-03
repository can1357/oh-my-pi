//! `wc` builtin: print newline, word, byte, character, and maximum-line-length counts.
//!
//! Ported from uutils coreutils 0.8.0.

mod count_fast {
	use std::io::{self, ErrorKind, Read};
	#[cfg(unix)]
	use std::os::fd::AsRawFd;
	
	#[cfg(unix)]
	use libc::{_SC_PAGESIZE, S_IFREG, sysconf};
	use uucore::hardware::SimdPolicy;
	
	use super::WordCountable;
	use super::{wc_simd_allowed, word_count::WordCount};
	#[cfg(windows)]
	use std::os::windows::fs::MetadataExt;
	#[cfg(windows)]
	const FILE_ATTRIBUTE_ARCHIVE: u32 = 32;
	#[cfg(windows)]
	const FILE_ATTRIBUTE_NORMAL: u32 = 128;
	
	#[cfg(any(target_os = "linux", target_os = "android"))]
	use std::os::fd::AsFd;
	
	#[cfg(any(target_os = "linux", target_os = "android"))]
	use libc::S_IFIFO;
	#[cfg(any(target_os = "linux", target_os = "android"))]
	use uucore::pipes::{MAX_ROOTLESS_PIPE_SIZE, pipe, splice, splice_exact};
	
	const BUF_SIZE: usize = 256 * 1024;
	
	/// This is a Linux-specific function to count the number of bytes using the
	/// `splice` system call, which is faster than using `read`.
	///
	/// On error it returns the number of bytes it did manage to read, since the
	/// caller will fall back to a simpler method.
	#[inline]
	#[cfg(any(target_os = "linux", target_os = "android"))]
	fn count_bytes_using_splice(fd: &impl AsFd) -> Result<usize, usize> {
		let null_file = uucore::pipes::dev_null().ok_or(0_usize)?;
		// todo: avoid generating broker if input is pipe (fcntl_setpipe_size succeed)
		// and directly splice() to /dev/null to save RAM usage
		let (pipe_rd, pipe_wr) = pipe().map_err(|_| 0_usize)?;
	
		let mut byte_count = 0;
		// improve throughput from pipe
		let _ = rustix::pipe::fcntl_setpipe_size(fd, MAX_ROOTLESS_PIPE_SIZE);
		loop {
			match splice(fd, &pipe_wr, MAX_ROOTLESS_PIPE_SIZE) {
				Ok(0) => break,
				Ok(res) => {
					byte_count += res;
					// Silent the warning as we want to the error message
					if splice_exact(&pipe_rd, &null_file, res).is_err() {
						return Err(byte_count);
					}
				},
				Err(_) => return Err(byte_count),
			}
		}
	
		Ok(byte_count)
	}
	
	/// In the special case where we only need to count the number of bytes. There
	/// are several optimizations we can do:
	///   1. On Unix,  we can simply `stat` the file if it is regular.
	///   2. On Linux -- if the above did not work -- we can use splice to count the
	///      number of bytes if the file is a FIFO.
	///   3. On Windows we can use `std::os::windows::fs::MetadataExt` to get file
	///      size for regular files
	///   3. Otherwise, we just read normally, but without the overhead of counting
	///      other things such as lines and words.
	#[inline]
	pub(crate) fn count_bytes_fast<T: WordCountable>(handle: &mut T) -> (usize, Option<io::Error>) {
		let mut byte_count = 0;
	
		#[cfg(unix)]
		if let Some(fd) = handle.inner_fd() {
			let stat = rustix::fs::fstat(fd);
			if let Ok(stat) = stat {
				if (stat.st_mode as libc::mode_t & S_IFREG) != 0 && stat.st_size > 0 {
					let current = unsafe { libc::lseek(fd.as_raw_fd(), 0, libc::SEEK_CUR) };
					if current >= 0 {
						let remaining = stat.st_size.saturating_sub(current) as usize;
						let sys_page_size = unsafe { sysconf(_SC_PAGESIZE) as usize };
						if !(stat.st_size as usize).is_multiple_of(sys_page_size) {
							if unsafe { libc::lseek(fd.as_raw_fd(), 0, libc::SEEK_END) } >= 0 {
								return (remaining, None);
							}
						}
						let offset =
							stat.st_size as i64 - stat.st_size as i64 % (stat.st_blksize as i64 + 1);
						let offset = offset.max(current);
						let sought = unsafe { libc::lseek(fd.as_raw_fd(), offset, libc::SEEK_SET) };
						if sought >= 0 {
							byte_count = (sought - current) as usize;
						}
					}
				}
				#[cfg(any(target_os = "linux", target_os = "android"))]
				if (stat.st_mode as libc::mode_t & S_IFIFO) != 0 {
					match count_bytes_using_splice(&fd) {
						Ok(n) => return (n, None),
						Err(n) => byte_count = n,
					}
				}
			}
		}
	
		#[cfg(windows)]
		{
			if let Some(file) = handle.inner_file() {
				if let Ok(metadata) = file.metadata() {
					let attributes = metadata.file_attributes();
	
					if (attributes & FILE_ATTRIBUTE_ARCHIVE) != 0
						|| (attributes & FILE_ATTRIBUTE_NORMAL) != 0
					{
						return (metadata.file_size() as usize, None);
					}
				}
			}
		}
	
		// Fall back on `read`, but without the overhead of counting words and lines.
		let mut buf = [0_u8; BUF_SIZE];
		loop {
			match handle.read(&mut buf) {
				Ok(0) => return (byte_count, None),
				Ok(n) => {
					byte_count += n;
				},
				Err(ref e) if e.kind() == ErrorKind::Interrupted => (),
				Err(e) => return (byte_count, Some(e)),
			}
		}
	}
	
	/// A simple structure used to align a [`BUF_SIZE`] buffer to 32-byte boundary.
	///
	/// This is useful as bytecount uses 256-bit wide vector operations that run
	/// much faster on aligned data (at least on x86 with AVX2 support).
	#[repr(align(32))]
	struct AlignedBuffer {
		data: [u8; BUF_SIZE],
	}
	
	impl Default for AlignedBuffer {
		fn default() -> Self {
			Self { data: [0; BUF_SIZE] }
		}
	}
	
	/// Returns a [`WordCount`] that counts the number of bytes, lines, and/or the
	/// number of Unicode characters encoded in UTF-8 read via a Reader.
	///
	/// This corresponds to the `-c`, `-l` and `-m` command line flags to wc.
	///
	/// # Arguments
	///
	/// * `R` - A Reader from which the UTF-8 stream will be read.
	pub(crate) fn count_bytes_chars_and_lines_fast<
		R: Read,
		const COUNT_BYTES: bool,
		const COUNT_CHARS: bool,
		const COUNT_LINES: bool,
	>(
		handle: &mut R,
	) -> (WordCount, Option<io::Error>) {
		let mut total = WordCount::default();
		let buf: &mut [u8] = &mut AlignedBuffer::default().data;
		let policy = SimdPolicy::detect();
		let simd_allowed = wc_simd_allowed(policy);
		loop {
			match handle.read(buf) {
				Ok(0) => return (total, None),
				Ok(n) => {
					if COUNT_BYTES {
						total.bytes += n;
					}
					if COUNT_CHARS {
						total.chars += if simd_allowed {
							bytecount::num_chars(&buf[..n])
						} else {
							bytecount::naive_num_chars(&buf[..n])
						};
					}
					if COUNT_LINES {
						total.lines += if simd_allowed {
							bytecount::count(&buf[..n], b'\n')
						} else {
							bytecount::naive_count(&buf[..n], b'\n')
						};
					}
				},
				Err(ref e) if e.kind() == ErrorKind::Interrupted => (),
				Err(e) => return (total, Some(e)),
			}
		}
	}
}

mod countable {
	//! Traits and implementations for iterating over lines in a file-like object.
	//!
	//! This module provides a [`WordCountable`] trait and implementations
	//! for some common file-like objects. Use the [`WordCountable::buffered`]
	//! method to get an iterator over lines of a file-like object.
	use std::{
		fs::File,
		io::{BufRead, BufReader, Read},
	};
	#[cfg(unix)]
	use std::os::fd::{AsFd, BorrowedFd};

	use crate::host::Stdin;

	pub trait WordCountable: Read {
		type Buffered: BufRead;
		fn buffered(self) -> Self::Buffered;
		#[cfg(unix)]
		fn inner_fd(&self) -> Option<BorrowedFd<'_>>;
		#[cfg(windows)]
		fn inner_file(&mut self) -> Option<&mut File>;
	}

	impl WordCountable for &mut Stdin {
		type Buffered = BufReader<Self>;

		fn buffered(self) -> Self::Buffered {
			BufReader::new(self)
		}

		#[cfg(unix)]
		fn inner_fd(&self) -> Option<BorrowedFd<'_>> {
			self.file().try_borrow_as_fd().ok()
		}

		#[cfg(windows)]
		fn inner_file(&mut self) -> Option<&mut File> {
			None
		}
	}

	impl WordCountable for File {
		type Buffered = BufReader<Self>;

		fn buffered(self) -> Self::Buffered {
			BufReader::new(self)
		}

		#[cfg(unix)]
		fn inner_fd(&self) -> Option<BorrowedFd<'_>> {
			Some(self.as_fd())
		}

		#[cfg(windows)]
		fn inner_file(&mut self) -> Option<&mut File> {
			Some(self)
		}
	}
}

mod utf8 {
	
	
	use std::{cmp, str};
	
	pub use read::{BufReadDecoder, BufReadDecoderError};
	
	///
	/// Incremental, zero-copy UTF-8 decoding with error handling
	///
	/// The original implementation was written by Simon Sapin in the utf-8 crate <https://crates.io/crates/utf-8>.
	/// `uu_wc` used to depend on that crate.
	/// The author archived the repository <https://github.com/SimonSapin/rust-utf8>.
	/// They suggested incorporating the source directly into `uu_wc` <https://github.com/uutils/coreutils/issues/4289>.
	
	#[derive(Debug, Copy, Clone)]
	pub struct Incomplete {
		pub buffer:     [u8; 4],
		pub buffer_len: u8,
	}
	
	impl Incomplete {
		pub fn empty() -> Self {
			Self { buffer: [0, 0, 0, 0], buffer_len: 0 }
		}
	
		pub fn is_empty(self) -> bool {
			self.buffer_len == 0
		}
	
		pub fn new(bytes: &[u8]) -> Self {
			let mut buffer = [0, 0, 0, 0];
			let len = bytes.len();
			buffer[..len].copy_from_slice(bytes);
			Self { buffer, buffer_len: len as u8 }
		}
	
		fn take_buffer(&mut self) -> &[u8] {
			let len = self.buffer_len as usize;
			self.buffer_len = 0;
			&self.buffer[..len]
		}
	
		/// `(consumed_from_input, None)`: not enough input
		/// `(consumed_from_input, Some(Err(())))`: error bytes in buffer
		/// `(consumed_from_input, Some(Ok(())))`: UTF-8 string in buffer
		fn try_complete_offsets(&mut self, input: &[u8]) -> (usize, Option<Result<(), ()>>) {
			let initial_buffer_len = self.buffer_len as usize;
			let copied_from_input;
			{
				let unwritten = &mut self.buffer[initial_buffer_len..];
				copied_from_input = cmp::min(unwritten.len(), input.len());
				unwritten[..copied_from_input].copy_from_slice(&input[..copied_from_input]);
			}
			let spliced = &self.buffer[..initial_buffer_len + copied_from_input];
			match str::from_utf8(spliced) {
				Ok(_) => {
					self.buffer_len = spliced.len() as u8;
					(copied_from_input, Some(Ok(())))
				},
				Err(error) => {
					let valid_up_to = error.valid_up_to();
					if valid_up_to > 0 {
						let consumed = valid_up_to.checked_sub(initial_buffer_len).unwrap();
						self.buffer_len = valid_up_to as u8;
						(consumed, Some(Ok(())))
					} else if let Some(invalid_sequence_length) = error.error_len() {
						let consumed = invalid_sequence_length
							.checked_sub(initial_buffer_len)
							.unwrap();
						self.buffer_len = invalid_sequence_length as u8;
						(consumed, Some(Err(())))
					} else {
						self.buffer_len = spliced.len() as u8;
						(copied_from_input, None)
					}
				},
			}
		}
	}

	// Copyright (c) Simon Sapin and many others
	//
	// Permission is hereby granted, free of charge, to any
	// person obtaining a copy of this software and associated
	// documentation files (the "Software"), to deal in the
	// Software without restriction, including without
	// limitation the rights to use, copy, modify, merge,
	// publish, distribute, sublicense, and/or sell copies of
	// the Software, and to permit persons to whom the Software
	// is furnished to do so, subject to the following
	// conditions:
	//
	// The above copyright notice and this permission notice
	// shall be included in all copies or substantial portions
	// of the Software.
	//
	// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
	// ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
	// TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
	// PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
	// SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
	// CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
	// OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
	// IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
	// DEALINGS IN THE SOFTWARE.
	mod read {
		use std::io::{self, BufRead};
		
		use thiserror::Error;
		
		use super::{Incomplete, str};
		
		/// Wraps a `std::io::BufRead` buffered byte stream and decode it as UTF-8.
		pub struct BufReadDecoder<B: BufRead> {
			buf_read:       B,
			bytes_consumed: usize,
			incomplete:     Incomplete,
		}
		
		#[derive(Debug, Error)]
		pub enum BufReadDecoderError<'a> {
			/// Represents one UTF-8 error in the byte stream.
			///
			/// In lossy decoding, each such error should be replaced with U+FFFD.
			/// (See `BufReadDecoder::next_lossy` and `BufReadDecoderError::lossy`.)
			#[error("invalid byte sequence: {:02x?}", .0)]
			InvalidByteSequence(&'a [u8]),
		
			/// An I/O error from the underlying byte stream
			#[error("underlying bytestream error: {}", .0)]
			Io(#[source] io::Error),
		}
		
		impl<B: BufRead> BufReadDecoder<B> {
			pub fn new(buf_read: B) -> Self {
				Self { buf_read, bytes_consumed: 0, incomplete: Incomplete::empty() }
			}
		
			/// Decode and consume the next chunk of UTF-8 input.
			///
			/// This method is intended to be called repeatedly until it returns `None`,
			/// which represents EOF from the underlying byte stream.
			/// This is similar to `Iterator::next`,
			/// except that decoded chunks borrow the decoder (~iterator)
			/// so they need to be handled or copied before the next chunk can start
			/// decoding.
			#[allow(clippy::cognitive_complexity)]
			pub fn next_strict(&mut self) -> Option<Result<&str, BufReadDecoderError<'_>>> {
				enum BytesSource {
					BufRead(usize),
					Incomplete,
				}
				macro_rules! try_io {
					($io_result:expr) => {
						match $io_result {
							Ok(value) => value,
							Err(error) => return Some(Err(BufReadDecoderError::Io(error))),
						}
					};
				}
				let (source, result) = loop {
					if self.bytes_consumed > 0 {
						self.buf_read.consume(self.bytes_consumed);
						self.bytes_consumed = 0;
					}
					let buf = try_io!(self.buf_read.fill_buf());
		
					// Force loop iteration to go through an explicit `continue`
					enum Unreachable {}
					let _: Unreachable = if self.incomplete.is_empty() {
						if buf.is_empty() {
							return None; // EOF
						}
						match str::from_utf8(buf) {
							Ok(_) => break (BytesSource::BufRead(buf.len()), Ok(())),
							Err(error) => {
								let valid_up_to = error.valid_up_to();
								if valid_up_to > 0 {
									break (BytesSource::BufRead(valid_up_to), Ok(()));
								}
								if let Some(invalid_sequence_length) = error.error_len() {
									break (BytesSource::BufRead(invalid_sequence_length), Err(()));
								}
								self.bytes_consumed = buf.len();
								self.incomplete = Incomplete::new(buf);
								// need more input bytes
								continue;
							},
						}
					} else {
						if buf.is_empty() {
							break (BytesSource::Incomplete, Err(())); // EOF with incomplete code point
						}
						let (consumed, opt_result) = self.incomplete.try_complete_offsets(buf);
						self.bytes_consumed = consumed;
						match opt_result {
							None => {
								// need more input bytes
								continue;
							},
							Some(result) => break (BytesSource::Incomplete, result),
						}
					};
				};
				let bytes = match source {
					BytesSource::BufRead(byte_count) => {
						self.bytes_consumed = byte_count;
						let buf = try_io!(self.buf_read.fill_buf());
						&buf[..byte_count]
					},
					BytesSource::Incomplete => self.incomplete.take_buffer(),
				};
				match result {
					Ok(()) => Some(Ok(unsafe { str::from_utf8_unchecked(bytes) })),
					Err(()) => Some(Err(BufReadDecoderError::InvalidByteSequence(bytes))),
				}
			}
		}
	}
}

mod word_count {
	use std::{
		cmp::max,
		ops::{Add, AddAssign},
	};
	
	#[derive(Debug, Default, Copy, Clone)]
	pub struct WordCount {
		pub bytes:           usize,
		pub chars:           usize,
		pub lines:           usize,
		pub words:           usize,
		pub max_line_length: usize,
	}
	
	impl Add for WordCount {
		type Output = Self;
	
		fn add(self, other: Self) -> Self {
			Self {
				bytes:           self.bytes + other.bytes,
				chars:           self.chars + other.chars,
				lines:           self.lines + other.lines,
				words:           self.words + other.words,
				max_line_length: max(self.max_line_length, other.max_line_length),
			}
		}
	}
	
	impl AddAssign for WordCount {
		fn add_assign(&mut self, other: Self) {
			*self = *self + other;
		}
	}
}

use std::{
	borrow::Cow,
	cmp::max,
	ffi::{OsStr, OsString},
	fs::{self, File},
	io::{self, Write},
	iter,
	path::{Path, PathBuf},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser};
use thiserror::Error;
use utf8::{BufReadDecoder, BufReadDecoderError};
use uucore::{
	display::Quotable,
	hardware::{HardwareFeature, HasHardwareFeatures as _, SimdPolicy},
	parser::shortcut_value_parser::ShortcutValueParser,
	quoting_style::{self, QuotingStyle},
};

use self::{
	count_fast::{count_bytes_chars_and_lines_fast, count_bytes_fast},
	countable::WordCountable,
	word_count::WordCount,
};
use crate::host::{Host, Utility, format_usage, matches_parser, os_bytes_lossy, util};

/// The minimum character width for formatting counts when reading from stdin.
const MINIMUM_WIDTH: usize = 7;

struct Settings {
	show_bytes:           bool,
	show_chars:           bool,
	show_lines:           bool,
	show_words:           bool,
	show_max_line_length: bool,
	debug:                bool,
	posixly_correct:      bool,
	files0_from:          Option<Input>,
	total_when:           TotalWhen,
}

impl Default for Settings {
	fn default() -> Self {
		// Defaults if none of -c, -m, -l, -w, nor -L are specified.
		Self {
			show_bytes:           true,
			show_chars:           false,
			show_lines:           true,
			show_words:           true,
			show_max_line_length: false,
			debug:                false,
			posixly_correct:      false,
			files0_from:          None,
			total_when:           TotalWhen::default(),
		}
	}
}

impl Settings {
	fn new(matches: &ArgMatches, host: &Host) -> Self {
		let files0_from = matches
			.get_one::<OsString>(options::FILES0_FROM)
			.map(|path| Input::from(PathBuf::from(path)));

		let total_when = matches
			.get_one::<String>(options::TOTAL)
			.map(Into::into)
			.unwrap_or_default();

		let settings = Self {
			show_bytes: matches.get_flag(options::BYTES),
			show_chars: matches.get_flag(options::CHAR),
			show_lines: matches.get_flag(options::LINES),
			show_words: matches.get_flag(options::WORDS),
			show_max_line_length: matches.get_flag(options::MAX_LINE_LENGTH),
			debug: matches.get_flag(options::DEBUG),
			posixly_correct: host.var("POSIXLY_CORRECT").is_some(),
			files0_from,
			total_when,
		};

		if settings.number_enabled() > 0 {
			settings
		} else {
			Self {
				files0_from: settings.files0_from,
				total_when,
				debug: settings.debug,
				..Default::default()
			}
		}
	}

	fn number_enabled(&self) -> u32 {
		[
			self.show_bytes,
			self.show_chars,
			self.show_lines,
			self.show_max_line_length,
			self.show_words,
		]
		.into_iter()
		.map(Into::<u32>::into)
		.sum()
	}
}

mod options {
	pub static BYTES: &str = "bytes";
	pub static CHAR: &str = "chars";
	pub static FILES0_FROM: &str = "files0-from";
	pub static LINES: &str = "lines";
	pub static MAX_LINE_LENGTH: &str = "max-line-length";
	pub static TOTAL: &str = "total";
	pub static WORDS: &str = "words";
	pub static DEBUG: &str = "debug";
}
static ARG_FILES: &str = "files";
static STDIN_REPR: &str = "-";

/// Supported inputs.
#[derive(Debug)]
enum Inputs {
	/// Default standard input, i.e. no arguments.
	Stdin,
	/// Command-line paths or a small `--files0-from` file.
	Paths(Vec<InputIterItem>),
	/// A streaming or large `--files0-from` source, whose width is not precomputed.
	Files0From(Vec<InputIterItem>),
}

impl Inputs {
	fn new(matches: &ArgMatches, host: &mut Host) -> Result<Self, WcError> {
		let arg_files = matches.get_many::<OsString>(ARG_FILES);
		let files0_from = matches.get_one::<OsString>(options::FILES0_FROM);

		match (arg_files, files0_from) {
			(None, None) => Ok(Self::Stdin),
			(Some(files), None) => Ok(Self::Paths(
				files
					.map(|path| Ok(Input::from(PathBuf::from(path))))
					.collect(),
			)),
			(None, Some(path)) => {
				let input = Input::from(PathBuf::from(path));
				let small = match &input {
					Input::Path(path) => fs::metadata(host.resolve(path))
						.is_ok_and(|meta| meta.is_file() && meta.len() <= (10 << 20)),
					Input::Stdin(_) => false,
				};
				let items: Vec<_> = match &input {
					Input::Path(path) => files0_iter_file(path, host)?.collect(),
					Input::Stdin(_) => files0_iter_stdin(host).collect(),
				};
				let items = validate_files0(items, &input);
				if small { Ok(Self::Paths(items)) } else { Ok(Self::Files0From(items)) }
			},
			(Some(mut files), Some(_)) => Err(WcError::files_disabled(files.next().unwrap())),
		}
	}

	fn iter(&self) -> Box<dyn Iterator<Item = Result<Input, &WcError>> + '_> {
		match self {
			Self::Stdin => Box::new(iter::once(Ok(Input::Stdin(StdinKind::Implicit)))),
			Self::Paths(inputs) | Self::Files0From(inputs) => {
				Box::new(inputs.iter().map(|item| item.as_ref().map(Clone::clone)))
			},
		}
	}
}

#[derive(Clone, Copy, Debug)]
enum StdinKind {
	/// Specified on command-line with "-" ([`STDIN_REPR`]).
	Explicit,
	/// Implied by the lack of any arguments.
	Implicit,
}

/// Represents a single input, either to be counted or processed for other file names.
#[derive(Clone, Debug)]
enum Input {
	Path(PathBuf),
	Stdin(StdinKind),
}

impl From<PathBuf> for Input {
	fn from(path: PathBuf) -> Self {
		if path.as_os_str() == STDIN_REPR {
			Self::Stdin(StdinKind::Explicit)
		} else {
			Self::Path(path)
		}
	}
}

impl Input {
	/// Converts input to the title that appears in stats.
	fn to_title(&self) -> Option<Cow<'_, OsStr>> {
		match self {
			Self::Path(path) => {
				let path = path.as_os_str();
				if path.to_string_lossy().contains('\n') {
					Some(Cow::Owned(quoting_style::locale_aware_escape_name(
						path,
						QuotingStyle::SHELL_ESCAPE,
					)))
				} else {
					Some(Cow::Borrowed(path))
				}
			},
			Self::Stdin(StdinKind::Explicit) => Some(Cow::Borrowed(OsStr::new(STDIN_REPR))),
			Self::Stdin(StdinKind::Implicit) => None,
		}
	}

	/// Converts input into the form that appears in errors.
	fn path_display(&self) -> String {
		match self {
			Self::Path(path) => escape_name_wrapper(path.as_os_str()),
			Self::Stdin(_) => "standard input".to_string(),
		}
	}
}

/// When to show the "total" line
#[derive(Clone, Copy, Default, PartialEq)]
enum TotalWhen {
	#[default]
	Auto,
	Always,
	Only,
	Never,
}

impl<T: AsRef<str>> From<T> for TotalWhen {
	fn from(s: T) -> Self {
		match s.as_ref() {
			"auto" => Self::Auto,
			"always" => Self::Always,
			"only" => Self::Only,
			"never" => Self::Never,
			_ => unreachable!("Should have been caught by clap"),
		}
	}
}

impl TotalWhen {
	fn is_total_row_visible(self, num_inputs: usize) -> bool {
		match self {
			Self::Auto => num_inputs > 1,
			Self::Always | Self::Only => true,
			Self::Never => false,
		}
	}
}

#[derive(Debug, Error)]
enum WcError {
	#[error("extra operand {}\nfile operands cannot be combined with --files0-from", extra.quote())]
	FilesDisabled { extra: Cow<'static, OsStr> },
	#[error("when reading file names from standard input, no file name of '-' allowed")]
	StdinReprNotAllowed,
	#[error("invalid zero-length file name")]
	ZeroLengthFileName,
	#[error("{path}:{idx}: invalid zero-length file name")]
	ZeroLengthFileNameCtx { path: Cow<'static, str>, idx: usize },
	#[error("{context}: {source}")]
	Io {
		context: String,
		#[source]
		source:  io::Error,
	},
}

impl WcError {
	fn zero_len(ctx: Option<(&Input, usize)>) -> Self {
		match ctx {
			Some((input, idx)) => {
				let path = match input {
					Input::Stdin(_) => STDIN_REPR.into(),
					Input::Path(path) => escape_name_wrapper(path.as_os_str()).into(),
				};
				Self::ZeroLengthFileNameCtx { path, idx }
			},
			None => Self::ZeroLengthFileName,
		}
	}

	fn files_disabled(first_extra: &OsString) -> Self {
		let extra = first_extra.clone().into();
		Self::FilesDisabled { extra }
	}
}

/// Parsed `wc` invocation.
pub(crate) struct Wc {
	matches: ArgMatches,
}

matches_parser!(Wc, app);

impl Utility for Wc {
	const NAME: &'static str = "wc";

	fn run(self, host: &mut Host) -> i32 {
		let settings = Settings::new(&self.matches, host);
		let inputs = match Inputs::new(&self.matches, host) {
			Ok(inputs) => inputs,
			Err(error) => {
				host.error(error, 1);
				return host.exit_code();
			},
		};
		wc(&inputs, &settings, host);
		host.exit_code()
	}
}

fn app() -> Command {
	Command::new("wc")
		.version("0.8.0")
		.about(
			"Print newline, word, and byte counts for each FILE, and a total line if more than one \
			 FILE is specified.",
		)
		.override_usage(format_usage("wc [OPTION]... [FILE]..."))
		.infer_long_args(true)
		.args_override_self(true)
		.arg(
			Arg::new(options::BYTES)
				.short('c')
				.long(options::BYTES)
				.help("print the byte counts")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::CHAR)
				.short('m')
				.long(options::CHAR)
				.help("print the character counts")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::FILES0_FROM)
				.long(options::FILES0_FROM)
				.value_name("F")
				.help(
					"read input from the files specified by\nNUL-terminated names in file F;\nIf F is \
					 - then read names from standard input",
				)
				.value_parser(ValueParser::os_string())
				.value_hint(clap::ValueHint::FilePath),
		)
		.arg(
			Arg::new(options::LINES)
				.short('l')
				.long(options::LINES)
				.help("print the newline counts")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::MAX_LINE_LENGTH)
				.short('L')
				.long(options::MAX_LINE_LENGTH)
				.help("print the length of the longest line")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::TOTAL)
				.long(options::TOTAL)
				.value_parser(ShortcutValueParser::new(["auto", "always", "only", "never"]))
				.value_name("WHEN")
				.hide_possible_values(true)
				.help(
					"when to print a line with total counts;\nWHEN can be: auto, always, only, never",
				),
		)
		.arg(
			Arg::new(options::WORDS)
				.short('w')
				.long(options::WORDS)
				.help("print the word counts")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::DEBUG)
				.long(options::DEBUG)
				.action(ArgAction::SetTrue)
				.hide(true),
		)
		.arg(
			Arg::new(ARG_FILES)
				.action(ArgAction::Append)
				.value_parser(ValueParser::os_string())
				.value_hint(clap::ValueHint::FilePath),
		)
}

fn word_count_from_reader<T: WordCountable>(
	mut reader: T,
	settings: &Settings,
) -> (WordCount, Option<io::Error>) {
	match (
		settings.show_bytes,
		settings.show_chars,
		settings.show_lines,
		settings.show_max_line_length,
		settings.show_words,
	) {
		// Specialize scanning loop to improve the performance.
		(false, false, false, false, false) => unreachable!(),

		// show_bytes
		(true, false, false, false, false) => {
			// Fast path when only show_bytes is true.
			let (bytes, error) = count_bytes_fast(&mut reader);
			(WordCount { bytes, ..WordCount::default() }, error)
		},

		// Fast paths that can be computed without Unicode decoding.
		// show_lines
		(false, false, true, false, false) => {
			count_bytes_chars_and_lines_fast::<_, false, false, true>(&mut reader)
		},
		// show_chars
		(false, true, false, false, false) => {
			count_bytes_chars_and_lines_fast::<_, false, true, false>(&mut reader)
		},
		// show_chars, show_lines
		(false, true, true, false, false) => {
			count_bytes_chars_and_lines_fast::<_, false, true, true>(&mut reader)
		},
		// show_bytes, show_lines
		(true, false, true, false, false) => {
			count_bytes_chars_and_lines_fast::<_, true, false, true>(&mut reader)
		},
		// show_bytes, show_chars
		(true, true, false, false, false) => {
			count_bytes_chars_and_lines_fast::<_, true, true, false>(&mut reader)
		},
		// show_bytes, show_chars, show_lines
		(true, true, true, false, false) => {
			count_bytes_chars_and_lines_fast::<_, true, true, true>(&mut reader)
		},
		// show_words
		(_, false, false, false, true) => word_count_from_reader_specialized::<
			_,
			false,
			false,
			false,
			true,
		>(reader, settings.posixly_correct),
		// show_max_line_length
		(_, false, false, true, false) => word_count_from_reader_specialized::<
			_,
			false,
			false,
			true,
			false,
		>(reader, settings.posixly_correct),
		// show_max_line_length, show_words
		(_, false, false, true, true) => word_count_from_reader_specialized::<
			_,
			false,
			false,
			true,
			true,
		>(reader, settings.posixly_correct),
		// show_lines, show_words
		(_, false, true, false, true) => word_count_from_reader_specialized::<
			_,
			false,
			true,
			false,
			true,
		>(reader, settings.posixly_correct),
		// show_lines, show_max_line_length
		(_, false, true, true, false) => word_count_from_reader_specialized::<
			_,
			false,
			true,
			true,
			false,
		>(reader, settings.posixly_correct),
		// show_lines, show_max_line_length, show_words
		(_, false, true, true, true) => word_count_from_reader_specialized::<
			_,
			false,
			true,
			true,
			true,
		>(reader, settings.posixly_correct),
		// show_chars, show_words
		(_, true, false, false, true) => word_count_from_reader_specialized::<
			_,
			true,
			false,
			false,
			true,
		>(reader, settings.posixly_correct),
		// show_chars, show_max_line_length
		(_, true, false, true, false) => word_count_from_reader_specialized::<
			_,
			true,
			false,
			true,
			false,
		>(reader, settings.posixly_correct),
		// show_chars, show_max_line_length, show_words
		(_, true, false, true, true) => word_count_from_reader_specialized::<
			_,
			true,
			false,
			true,
			true,
		>(reader, settings.posixly_correct),
		// show_chars, show_lines, show_words
		(_, true, true, false, true) => word_count_from_reader_specialized::<
			_,
			true,
			true,
			false,
			true,
		>(reader, settings.posixly_correct),
		// show_chars, show_lines, show_max_line_length
		(_, true, true, true, false) => word_count_from_reader_specialized::<
			_,
			true,
			true,
			true,
			false,
		>(reader, settings.posixly_correct),
		// show_chars, show_lines, show_max_line_length, show_words
		(_, true, true, true, true) => word_count_from_reader_specialized::<
			_,
			true,
			true,
			true,
			true,
		>(reader, settings.posixly_correct),
	}
}

fn process_chunk<
	const SHOW_CHARS: bool,
	const SHOW_LINES: bool,
	const SHOW_MAX_LINE_LENGTH: bool,
	const SHOW_WORDS: bool,
>(
	total: &mut WordCount,
	text: &str,
	current_len: &mut usize,
	in_word: &mut bool,
	posixly_correct: bool,
) {
	for ch in text.chars() {
		if SHOW_WORDS {
			let is_space = if posixly_correct {
				matches!(ch, '\t'..='\r' | ' ')
			} else {
				ch.is_whitespace()
			};

			if is_space {
				*in_word = false;
			} else if !(*in_word) {
				// This also counts control characters! (As of GNU coreutils 9.5)
				*in_word = true;
				total.words += 1;
			}
		}
		if SHOW_MAX_LINE_LENGTH {
			match ch {
				'\n' | '\r' | '\x0c' => {
					total.max_line_length = max(*current_len, total.max_line_length);
					*current_len = 0;
				},
				'\t' => {
					*current_len -= *current_len % 8;
					*current_len += 8;
				},
				_ => {
					*current_len += xutf::width_char(ch);
				},
			}
		}
		if SHOW_LINES && ch == '\n' {
			total.lines += 1;
		}
		if SHOW_CHARS {
			total.chars += 1;
		}
	}
	total.bytes += text.len();

	total.max_line_length = max(*current_len, total.max_line_length);
}

fn handle_error(
	error: BufReadDecoderError<'_>,
	total: &mut WordCount,
	in_word: &mut bool,
) -> Option<io::Error> {
	match error {
		BufReadDecoderError::InvalidByteSequence(bytes) => {
			total.bytes += bytes.len();
			if !(*in_word) {
				*in_word = true;
				total.words += 1;
			}
		},
		BufReadDecoderError::Io(e) => return Some(e),
	}
	None
}

fn word_count_from_reader_specialized<
	T: WordCountable,
	const SHOW_CHARS: bool,
	const SHOW_LINES: bool,
	const SHOW_MAX_LINE_LENGTH: bool,
	const SHOW_WORDS: bool,
>(
	reader: T,
	posixly_correct: bool,
) -> (WordCount, Option<io::Error>) {
	let mut total = WordCount::default();
	let mut reader = BufReadDecoder::new(reader.buffered());
	let mut in_word = false;
	let mut current_len = 0;
	while let Some(chunk) = reader.next_strict() {
		match chunk {
			Ok(text) => {
				process_chunk::<SHOW_CHARS, SHOW_LINES, SHOW_MAX_LINE_LENGTH, SHOW_WORDS>(
					&mut total,
					text,
					&mut current_len,
					&mut in_word,
					posixly_correct,
				);
			},
			Err(e) => {
				if let Some(e) = handle_error(e, &mut total, &mut in_word) {
					return (total, Some(e));
				}
			},
		}
	}

	(total, None)
}

enum CountResult {
	/// Nothing went wrong.
	Success(WordCount),
	/// Managed to open but failed to read.
	Interrupted(WordCount, io::Error),
	/// Didn't even manage to open.
	Failure(io::Error),
}

/// If we fail to open a file, we only show the error. If we fail reading the
/// file, we show a count for what we managed to read.
///
/// Therefore, the reading implementations always return a total and sometimes
/// return an error: ([`WordCount`], `Option<io::Error>`).
fn word_count_from_input(input: &Input, settings: &Settings, host: &mut Host) -> CountResult {
	let (total, maybe_err) = match input {
		Input::Stdin(_) => word_count_from_reader(&mut host.stdin, settings),
		Input::Path(path) => match File::open(host.resolve(path)) {
			Ok(file) => word_count_from_reader(file, settings),
			Err(error) => return CountResult::Failure(error),
		},
	};
	match maybe_err {
		None => CountResult::Success(total),
		Some(error) => CountResult::Interrupted(total, error),
	}
}

/// Compute the number of digits needed to represent all counts in all inputs.
///
/// For [`Inputs::Stdin`], [`MINIMUM_WIDTH`] is returned, unless there is only
/// one counter number to be printed, in which case 1 is returned.
///
/// For [`Inputs::Files0From`], [`MINIMUM_WIDTH`] is returned.
///
/// An [`Inputs::Paths`] may include zero or more "-" entries, each of which
/// represents reading from `stdin`. The presence of any such entry causes this
/// function to return a width that is at least [`MINIMUM_WIDTH`].
///
/// If an [`Inputs::Paths`] contains only one path and only one number needs to
/// be printed then this function is optimized to return 1 without making any
/// calls to get file metadata.
///
/// If file metadata could not be read from any of the [`Input::Path`] input,
/// that input does not affect number width computation.  Otherwise, the file
/// sizes from the files' metadata are summed and the number of digits in that
/// total size is returned.
fn compute_number_width(inputs: &Inputs, settings: &Settings, host: &Host) -> usize {
	match inputs {
		Inputs::Stdin if settings.number_enabled() == 1 => 1,
		Inputs::Stdin => MINIMUM_WIDTH,
		Inputs::Files0From(_) => 1,
		Inputs::Paths(inputs) => {
			if settings.number_enabled() == 1 && inputs.len() == 1 {
				return 1;
			}

			let mut minimum_width = 1;
			let mut total: u64 = 0;
			for input in inputs.iter().filter_map(|item| item.as_ref().ok()) {
				match input {
					Input::Stdin(_) => minimum_width = MINIMUM_WIDTH,
					Input::Path(path) => {
						if let Ok(meta) = fs::metadata(host.resolve(path)) {
							if meta.is_file() {
								total += meta.len();
							} else {
								minimum_width = MINIMUM_WIDTH;
							}
						}
					},
				}
			}

			if total == 0 {
				minimum_width
			} else {
				let total_width = (1 + total.ilog10())
					.try_into()
					.expect("ilog of a u64 should fit into a usize");
				max(total_width, minimum_width)
			}
		},
	}
}

type InputIterItem = Result<Input, WcError>;

/// Reads NUL-delimited names from standard input.
fn files0_iter_stdin(host: &mut Host) -> impl Iterator<Item = InputIterItem> + '_ {
	files0_iter(&mut host.stdin, STDIN_REPR.into()).map(|item| match item {
		Ok(Input::Stdin(_)) => Err(WcError::StdinReprNotAllowed),
		_ => item,
	})
}

fn files0_iter_file(
	path: &Path,
	host: &Host,
) -> Result<impl Iterator<Item = InputIterItem>, WcError> {
	let file = File::open(host.resolve(path)).map_err(|source| WcError::Io {
		context: format!(
			"cannot open {} for reading",
			quoting_style::locale_aware_escape_name(
				path.as_os_str(),
				QuotingStyle::SHELL_ESCAPE_QUOTE,
			)
			.into_string()
			.expect("escaped names are valid strings")
		),
		source,
	})?;
	Ok(files0_iter(file, path.into()))
}

fn files0_iter(
	reader: impl io::Read,
	err_path: OsString,
) -> impl Iterator<Item = InputIterItem> {
	use std::io::BufRead;
	let mut iterator = Some(
		io::BufReader::new(reader)
			.split(b'\0')
			.map(move |result| match result {
				Ok(path) if path == STDIN_REPR.as_bytes() => {
					Ok(Input::Stdin(StdinKind::Explicit))
				},
				Ok(path) => {
					#[cfg(unix)]
					{
						use std::os::unix::ffi::OsStringExt;
						Ok(Input::Path(PathBuf::from(OsString::from_vec(path))))
					}
					#[cfg(not(unix))]
					{
						String::from_utf8(path)
							.map(|path| Input::Path(PathBuf::from(path)))
							.map_err(|error| WcError::Io {
								context: format!("{}: read error", escape_name_wrapper(&err_path)),
								source: io::Error::other(error),
							})
					}
				},
				Err(source) => Err(WcError::Io {
					context: format!("{}: read error", escape_name_wrapper(&err_path)),
					source,
				}),
			}),
	);
	iter::from_fn(move || {
		let next = iterator.as_mut().and_then(Iterator::next);
		if matches!(next, Some(Err(_)) | None) {
			iterator = None;
		}
		next
	})
}

fn validate_files0(items: Vec<InputIterItem>, source: &Input) -> Vec<InputIterItem> {
	items
		.into_iter()
		.enumerate()
		.map(|(index, item)| match item {
			Ok(Input::Path(path)) if path.as_os_str().is_empty() => {
				Err(WcError::zero_len(Some((source, index + 1))))
			},
			_ => item,
		})
		.collect()
}

fn escape_name_wrapper(name: &OsStr) -> String {
	quoting_style::locale_aware_escape_name(name, QuotingStyle::SHELL_ESCAPE)
		.into_string()
		.expect("All escaped names with the escaping option return valid strings.")
}

fn hardware_feature_label(feature: HardwareFeature) -> &'static str {
	match feature {
		HardwareFeature::Avx512 => "AVX512F",
		HardwareFeature::Avx2 => "AVX2",
		HardwareFeature::PclMul => "PCLMUL",
		HardwareFeature::Vmull => "VMULL",
		HardwareFeature::Sse2 => "SSE2",
		HardwareFeature::Asimd => "ASIMD",
	}
}

fn is_simd_runtime_feature(feature: HardwareFeature) -> bool {
	matches!(feature, HardwareFeature::Avx2 | HardwareFeature::Sse2 | HardwareFeature::Asimd)
}

fn is_simd_debug_feature(feature: HardwareFeature) -> bool {
	matches!(
		feature,
		HardwareFeature::Avx512
			| HardwareFeature::Avx2
			| HardwareFeature::Sse2
			| HardwareFeature::Asimd
	)
}

struct WcSimdFeatures {
	enabled:          Vec<HardwareFeature>,
	disabled:         Vec<HardwareFeature>,
	disabled_runtime: Vec<HardwareFeature>,
}

fn wc_simd_features(policy: &SimdPolicy) -> WcSimdFeatures {
	let enabled = policy
		.iter_features()
		.filter(|v| is_simd_runtime_feature(*v))
		.collect();

	let mut disabled = Vec::new();
	let mut disabled_runtime = Vec::new();
	for feature in policy.disabled_features() {
		if is_simd_debug_feature(feature) {
			disabled.push(feature);
		}
		if is_simd_runtime_feature(feature) {
			disabled_runtime.push(feature);
		}
	}

	WcSimdFeatures { enabled, disabled, disabled_runtime }
}

pub(crate) fn wc_simd_allowed(policy: &SimdPolicy) -> bool {
	let disabled_features = policy.disabled_features();
	if disabled_features.into_iter().any(is_simd_runtime_feature) {
		return false;
	}
	policy.iter_features().any(is_simd_runtime_feature)
}

fn record_error(host: &mut Host, error: impl std::fmt::Display) {
	host.error(error, 1);
}

fn wc(inputs: &Inputs, settings: &Settings, host: &mut Host) {
	let mut total_word_count = WordCount::default();
	let mut num_inputs: usize = 0;

	let (number_width, are_stats_visible) = match settings.total_when {
		TotalWhen::Only => (1, false),
		_ => (compute_number_width(inputs, settings, host), true),
	};

	if settings.debug {
		let policy = SimdPolicy::detect();
		let features = wc_simd_features(policy);
		let enabled: Vec<_> =
			features.enabled.iter().copied().map(hardware_feature_label).collect();
		let disabled: Vec<_> =
			features.disabled.iter().copied().map(hardware_feature_label).collect();
		let enabled_empty = enabled.is_empty();
		let disabled_empty = disabled.is_empty();
		let runtime_disabled = !features.disabled_runtime.is_empty();

		if enabled_empty && !runtime_disabled {
			let _ = writeln!(host.stderr, "debug: hardware support unavailable on this CPU");
		} else if runtime_disabled {
			let _ = writeln!(
				host.stderr,
				"debug: hardware support disabled by GLIBC_TUNABLES ({})",
				disabled.join(", ")
			);
		} else if !enabled_empty && disabled_empty {
			let _ = writeln!(
				host.stderr,
				"debug: using hardware support (features: {})",
				enabled.join(", ")
			);
		} else {
			let _ = writeln!(
				host.stderr,
				"debug: hardware support limited by GLIBC_TUNABLES (disabled: {}; enabled: {})",
				disabled.join(", "),
				enabled.join(", ")
			);
		}
	}

	for maybe_input in inputs.iter() {
		num_inputs += 1;
		let input = match maybe_input {
			Ok(input) => input,
			Err(error) => {
				record_error(host, error);
				continue;
			},
		};

		let (word_count, deferred_error) = match word_count_from_input(&input, settings, host) {
			CountResult::Success(word_count) => (word_count, None),
			CountResult::Interrupted(word_count, source) => (
				word_count,
				Some(WcError::Io { context: input.path_display(), source }),
			),
			CountResult::Failure(source) => {
				record_error(
					host,
					WcError::Io { context: input.path_display(), source },
				);
				continue;
			},
		};
		total_word_count += word_count;
		if are_stats_visible {
			let title = input.to_title();
			if let Err(source) = print_stats(
				&mut host.stdout,
				settings,
				&word_count,
				title.as_deref(),
				number_width,
			) {
				let title = title.as_deref().unwrap_or(OsStr::new("<stdin>"));
				record_error(
					host,
					WcError::Io {
						context: format!("failed to print result for {}", title.to_string_lossy()),
						source,
					},
				);
				return;
			}
		}
		if let Some(error) = deferred_error {
			let _ = host.stdout.flush();
			record_error(host, error);
		}
	}

	if settings.total_when.is_total_row_visible(num_inputs) {
		let title = are_stats_visible.then_some(OsStr::new("total"));
		if let Err(source) =
			print_stats(&mut host.stdout, settings, &total_word_count, title, number_width)
		{
			record_error(
				host,
				WcError::Io { context: "failed to print total".to_string(), source },
			);
		}
	}
}

fn print_stats(
	stdout: &mut impl Write,
	settings: &Settings,
	result: &WordCount,
	title: Option<&OsStr>,
	number_width: usize,
) -> io::Result<()> {
	let maybe_cols = [
		(settings.show_lines, result.lines),
		(settings.show_words, result.words),
		(settings.show_chars, result.chars),
		(settings.show_bytes, result.bytes),
		(settings.show_max_line_length, result.max_line_length),
	];

	let mut space = "";
	for (_, num) in maybe_cols.iter().filter(|(show, _)| *show) {
		write!(stdout, "{space}{num:number_width$}")?;
		space = " ";
	}

	if let Some(title) = title {
		write!(stdout, "{space}")?;
		stdout.write_all(&os_bytes_lossy(title))?;
	}
	writeln!(stdout)
}

/// Creates the `wc` builtin registration.
pub(crate) fn wc_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Wc, SE>()
}

#[cfg(test)]
mod tests {
	use std::io::{BufRead, Seek, SeekFrom, Write};

	use super::{
		Wc,
		count_fast::count_bytes_fast,
		countable::WordCountable,
		word_count::WordCount,
	};
	use crate::host::run_util;

	#[test]
	fn counts_standard_input() {
		let (code, capture) = run_util::<Wc>(&[], "one two\n", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "      1       2       8\n");
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn resolves_relative_operands_but_prints_original_names() {
		let directory = tempfile::tempdir().unwrap();
		std::fs::write(directory.path().join("input"), b"hello\nworld\n").unwrap();
		let cwd = directory.path().to_str().unwrap();
		let (code, capture) = run_util::<Wc>(&["-l", "input"], "", cwd);
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "2 input\n");
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn reports_failed_operands_and_continues() {
		let directory = tempfile::tempdir().unwrap();
		std::fs::write(directory.path().join("good"), b"x\n").unwrap();
		let cwd = directory.path().to_str().unwrap();
		let (code, capture) = run_util::<Wc>(&["-l", "missing", "good"], "", cwd);
		assert_eq!(code, 1);
		assert!(capture.err().contains("wc: missing:"));
		assert!(capture.out().contains("1 good"));
	}

	#[test]
	fn resolves_files0_from_entries_against_host_cwd() {
		let directory = tempfile::tempdir().unwrap();
		std::fs::write(directory.path().join("first"), b"a\n").unwrap();
		std::fs::write(directory.path().join("names"), b"first\0").unwrap();
		let cwd = directory.path().to_str().unwrap();
		let (code, capture) = run_util::<Wc>(&["-l", "--files0-from", "names"], "", cwd);
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "1 first\n");
	}

	#[test]
	fn count_fast_counts_from_the_current_file_position() {
		let mut file = tempfile::tempfile().unwrap();
		file.write_all(b"abcdef").unwrap();
		file.seek(SeekFrom::Start(2)).unwrap();
		let (bytes, error) = count_bytes_fast(&mut file);
		assert_eq!(bytes, 4);
		assert!(error.is_none());
	}

	#[test]
	fn countable_buffers_files() {
		let mut file = tempfile::tempfile().unwrap();
		file.write_all(b"first\nsecond\n").unwrap();
		file.seek(SeekFrom::Start(0)).unwrap();
		let lines: Vec<_> = file.buffered().lines().collect::<Result<_, _>>().unwrap();
		assert_eq!(lines, ["first", "second"]);
	}

	#[test]
	fn word_counts_add_componentwise_and_take_longest_line() {
		let mut total = WordCount {
			bytes: 2,
			chars: 2,
			lines: 1,
			words: 1,
			max_line_length: 2,
		};
		total += WordCount {
			bytes: 3,
			chars: 3,
			lines: 1,
			words: 2,
			max_line_length: 1,
		};
		assert_eq!(total.bytes, 5);
		assert_eq!(total.chars, 5);
		assert_eq!(total.lines, 2);
		assert_eq!(total.words, 3);
		assert_eq!(total.max_line_length, 2);
	}
}
