// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// spell-checker:ignore (ToDO) seekable seek'd tail'ing ringbuffer ringbuf
// unwatch spell-checker:ignore (ToDO) Uncategorized filehandle Signum memrchr
// spell-checker:ignore (libs) kqueue
// spell-checker:ignore (acronyms)
// spell-checker:ignore (env/flags)
// spell-checker:ignore (jargon) tailable untailable stdlib
// spell-checker:ignore (names)
// spell-checker:ignore (shell/tools)
// spell-checker:ignore (misc)

pub mod args;
pub mod chunks;
mod follow;
mod parse;
mod paths;
mod platform;
pub mod text;

use std::{
	cmp::Ordering,
	ffi::OsString,
	fs::File,
	io::{self, BufReader, BufWriter, ErrorKind, Read, Seek, SeekFrom, Write},
	path::{Path, PathBuf},
};

pub use args::uu_app;
use args::{ArgsError, FilterMode, Settings, Signum, parse_settings};
use chunks::ReverseChunks;
use follow::Observer;
use memchr::{memchr_iter, memrchr_iter};
use paths::{FileExtTail, HeaderPrinter, Input, InputKind};
use uucore::{
	display::Quotable,
	error::{FromIo, UError, UResult, USimpleError},
};

/// In-process builtin entry point. Unlike upstream's `#[uucore::main] uumain`,
/// this renders clap help/usage/version to the context streams and never calls
/// `std::process::exit`, so it is safe inside the long-lived host shell
/// process. The default (non-follow) path reads stdin/files through
/// [`pi_uutils_ctx`].
pub fn run(args: Vec<OsString>) -> i32 {
	let settings = match parse_settings(args) {
		Ok(settings) => settings,
		Err(ArgsError::Clap(err)) => {
			let rendered = err.to_string();
			if err.use_stderr() {
				let _ = write!(pi_uutils_ctx::stderr(), "{rendered}");
				return 1;
			}
			let _ = write!(pi_uutils_ctx::stdout(), "{rendered}");
			return 0;
		},
		Err(ArgsError::Other(err)) => {
			let code = err.code();
			let _ = writeln!(pi_uutils_ctx::stderr(), "tail: {err}");
			return if code == 0 { 1 } else { code };
		},
	};
	match tail_main(&settings) {
		Ok(()) => pi_uutils_ctx::exit_code(),
		Err(err) => {
			let code = err.code();
			let _ = writeln!(pi_uutils_ctx::stderr(), "tail: {err}");
			if code == 0 { 1 } else { code }
		},
	}
}

fn tail_main(settings: &Settings) -> UResult<()> {
	settings.check_warnings();

	match settings.verify() {
		args::VerificationResult::CannotFollowStdinByName => {
			return Err(USimpleError::new(1, format!("cannot follow {} by name", text::DASH.quote())));
		},
		// Exit early if we do not output anything. Note, that this may break a pipe
		// when tail is on the receiving side.
		args::VerificationResult::NoOutput => return Ok(()),
		args::VerificationResult::Ok => {},
	}

	uu_tail(settings)
}

fn uu_tail(settings: &Settings) -> UResult<()> {
	let mut printer = HeaderPrinter::new(settings.verbose, true);
	let mut observer = Observer::from(settings);

	observer.start(settings)?;

	// Print debug info about the follow implementation being used
	if settings.debug && settings.follow.is_some() {
		if observer.use_polling {
			let _ = writeln!(pi_uutils_ctx::stderr(), "tail: using polling mode");
		} else {
			let _ = writeln!(pi_uutils_ctx::stderr(), "tail: using notification mode");
		}
	}

	// Do an initial tail print of each path's content.
	// Add `path` and `reader` to `files` map if `--follow` is selected.
	for input in &settings.inputs.clone() {
		match input.kind() {
			InputKind::Stdin => {
				tail_stdin(settings, &mut printer, input, &mut observer)?;
			},
			InputKind::File(path) if cfg!(unix) && path == &PathBuf::from(text::DEV_STDIN) => {
				tail_stdin(settings, &mut printer, input, &mut observer)?;
			},
			InputKind::File(path) => {
				tail_file(settings, &mut printer, input, path, &mut observer, 0)?;
			},
		}
	}

	if settings.follow.is_some() {
		/*
		POSIX specification regarding tail -f
		If the input file is a regular file or if the file operand specifies a FIFO, do not
		terminate after the last line of the input file has been copied, but read and copy
		further bytes from the input file when they become available. If no file operand is
		specified and standard input is a pipe or FIFO, the -f option shall be ignored. If
		the input file is not a FIFO, pipe, or regular file, it is unspecified whether or
		not the -f option shall be ignored.
		*/
		if !settings.has_only_stdin() || settings.pid != 0 {
			follow::follow(observer, settings)?;
		}
	}

	Ok(())
}

fn tail_file(
	settings: &Settings,
	header_printer: &mut HeaderPrinter,
	input: &Input,
	path: &Path,
	observer: &mut Observer,
	offset: u64,
) -> UResult<()> {
	// pi-uutils: resolve the operand against the shell working directory for
	// filesystem access; keep `path`/`input.display_name` for display + observer.
	let fs_path = pi_uutils_ctx::resolve(path);
	let md = fs_path.metadata();
	if let Err(ref e) = md
		&& e.kind() == ErrorKind::NotFound
	{
		pi_uutils_ctx::set_exit_code(1);
		let _ = writeln!(
			pi_uutils_ctx::stderr(),
			"tail: cannot open '{}' for reading: No such file or directory",
			input.display_name
		);
		observer.add_bad_path(path, input.display_name.as_str(), false)?;
		return Ok(());
	}

	if fs_path.is_dir() {
		pi_uutils_ctx::set_exit_code(1);

		header_printer.print_input(input);

		let _ = writeln!(
			pi_uutils_ctx::stderr(),
			"tail: error reading '{}': Is a directory",
			input.display_name
		);
		if settings.follow.is_some() {
			let msg = if settings.retry {
				""
			} else {
				"; giving up on this name"
			};
			let _ = writeln!(
				pi_uutils_ctx::stderr(),
				"tail: {}: cannot follow end of this type of file{}",
				input.display_name,
				msg
			);
		}
		if !observer.follow_name_retry() {
			return Ok(());
		}
		observer.add_bad_path(path, input.display_name.as_str(), false)?;
	} else {
		#[cfg(unix)]
		let open_result = open_file(&fs_path, settings.pid != 0);
		#[cfg(not(unix))]
		let open_result = File::open(&fs_path);

		match open_result {
			Ok(mut file) => {
				let st = file.metadata()?;
				let blksize_limit = uucore::fs::sane_blksize::sane_blksize_from_metadata(&st);
				header_printer.print_input(input);
				let mut reader;
				if !settings.presume_input_pipe
					&& file.is_seekable(if input.is_stdin() { offset } else { 0 })
					&& (!st.is_file() || st.len() > blksize_limit)
				{
					bounded_tail(&mut file, settings);
					reader = BufReader::new(file);
				} else {
					reader = BufReader::new(file);
					unbounded_tail(&mut reader, settings)?;
				}
				if input.is_tailable() {
					observer.add_path(
						path,
						input.display_name.as_str(),
						Some(Box::new(reader)),
						true,
					)?;
				} else {
					observer.add_bad_path(path, input.display_name.as_str(), false)?;
				}
			},
			Err(e) if e.kind() == ErrorKind::PermissionDenied => {
				observer.add_bad_path(path, input.display_name.as_str(), false)?;
				let err =
					e.map_err_context(|| format!("cannot open '{}' for reading", input.display_name));
				let _ = writeln!(pi_uutils_ctx::stderr(), "tail: {err}");
				pi_uutils_ctx::set_exit_code(err.code());
			},
			Err(e) => {
				observer.add_bad_path(path, input.display_name.as_str(), false)?;
				return Err(
					e.map_err_context(|| format!("cannot open '{}' for reading", input.display_name)),
				);
			},
		}
	}

	Ok(())
}

/// Opens a file, using non-blocking mode for FIFOs when `use_nonblock_for_fifo`
/// is true.
///
/// When opening a FIFO with `--pid`, we need to use O_NONBLOCK so that:
/// 1. The open() call doesn't block waiting for a writer
/// 2. We can periodically check if the monitored process is still alive
///
/// After opening, we clear O_NONBLOCK so subsequent reads block normally.
/// Without `--pid`, FIFOs block on open() until a writer connects (GNU
/// behavior).
#[cfg(unix)]
fn open_file(path: &Path, use_nonblock_for_fifo: bool) -> io::Result<File> {
	use std::{
		fs::OpenOptions,
		os::{
			fd::AsFd,
			unix::fs::{FileTypeExt, OpenOptionsExt},
		},
	};

	use rustix::fs::{OFlags, fcntl_getfl, fcntl_setfl};

	let is_fifo = path
		.metadata()
		.ok()
		.is_some_and(|m| m.file_type().is_fifo());

	if is_fifo && use_nonblock_for_fifo {
		let file = OpenOptions::new()
			.read(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(path)?;

		// Clear O_NONBLOCK so reads block normally
		let flags = fcntl_getfl(file.as_fd())?;
		let new_flags = flags & !OFlags::NONBLOCK;
		fcntl_setfl(file.as_fd(), new_flags)?;

		Ok(file)
	} else {
		File::open(path)
	}
}

fn tail_stdin(
	settings: &Settings,
	header_printer: &mut HeaderPrinter,
	input: &Input,
	_observer: &mut Observer,
) -> UResult<()> {
	// pi-uutils: the context stdin is a plain reader with no backing file
	// descriptor, so the fd/seekable-stdin tricks (macOS directory detection,
	// bad-fd detection, /dev/fd/0 fifo seek) don't apply; always take the
	// streaming (pipe) path.
	header_printer.print_input(input);
	let mut reader = BufReader::new(pi_uutils_ctx::stdin());
	unbounded_tail(&mut reader, settings)?;
	Ok(())
}

/// Find the index after the given number of instances of a given byte.
///
/// This function reads through a given reader until `num_delimiters`
/// instances of `delimiter` have been seen, returning the index of
/// the byte immediately following that delimiter. If there are fewer
/// than `num_delimiters` instances of `delimiter`, this returns the
/// total number of bytes read from the `reader` until EOF.
///
/// # Errors
///
/// This function returns an error if there is an error during reading
/// from `reader`.
///
/// # Examples
///
/// Basic usage:
///
/// ```rust,ignore
/// use std::io::Cursor;
///
/// let mut reader = Cursor::new("a\nb\nc\nd\ne\n");
/// let i = forwards_thru_file(&mut reader, 2, b'\n').unwrap();
/// assert_eq!(i, 4);
/// ```
///
/// If `num_delimiters` is zero, then this function always returns
/// zero:
///
/// ```rust,ignore
/// use std::io::Cursor;
///
/// let mut reader = Cursor::new("a\n");
/// let i = forwards_thru_file(&mut reader, 0, b'\n').unwrap();
/// assert_eq!(i, 0);
/// ```
///
/// If there are fewer than `num_delimiters` instances of `delimiter`
/// in the reader, then this function returns the total number of
/// bytes read:
///
/// ```rust,ignore
/// use std::io::Cursor;
///
/// let mut reader = Cursor::new("a\n");
/// let i = forwards_thru_file(&mut reader, 2, b'\n').unwrap();
/// assert_eq!(i, 2);
/// ```
fn forwards_thru_file(
	reader: &mut impl Read,
	num_delimiters: u64,
	delimiter: u8,
) -> io::Result<usize> {
	// If num_delimiters == 0, always return 0.
	if num_delimiters == 0 {
		return Ok(0);
	}
	// Use a 32K buffer.
	let mut buf = [0; 32 * 1024];
	let mut total = 0;
	let mut count = 0;
	// Iterate through the input, using `count` to record the number of times
	// `delimiter` is seen. Once we find `num_delimiters` instances, return the
	// offset of the byte immediately following that delimiter.
	loop {
		match reader.read(&mut buf) {
			// Ok(0) => EoF before we found `num_delimiters` instance of `delimiter`.
			// Return the total number of bytes read in that case.
			Ok(0) => return Ok(total),
			Ok(n) => {
				// Use memchr_iter since it greatly improves search performance.
				for offset in memchr_iter(delimiter, &buf[..n]) {
					count += 1;
					if count == num_delimiters {
						// Return offset of the byte after the `delimiter` instance.
						return Ok(total + offset + 1);
					}
				}
				total += n;
			},
			Err(e) if e.kind() == ErrorKind::Interrupted => (),
			Err(e) => return Err(e),
		}
	}
}

/// Iterate over bytes in the file, in reverse, until we find the
/// `num_delimiters` instance of `delimiter`. The `file` is left seek'd to the
/// position just after that delimiter.
fn backwards_thru_file(file: &mut File, num_delimiters: u64, delimiter: u8) {
	if num_delimiters == 0 {
		file.seek(SeekFrom::End(0)).unwrap();
		return;
	}
	// This variable counts the number of delimiters found in the file
	// so far (reading from the end of the file toward the beginning).
	let mut counter = 0;
	let mut first_slice = true;
	for slice in ReverseChunks::new(file) {
		// Iterate over each byte in the slice in reverse order.
		let mut iter = memrchr_iter(delimiter, &slice);

		// Ignore a trailing newline in the last block, if there is one.
		if first_slice {
			if let Some(c) = slice.last()
				&& *c == delimiter
			{
				iter.next();
			}
			first_slice = false;
		}

		// For each byte, increment the count of the number of
		// delimiters found. If we have found more than the specified
		// number of delimiters, terminate the search and seek to the
		// appropriate location in the file.
		for i in iter {
			counter += 1;
			if counter >= num_delimiters {
				// We should never over-count - assert that.
				assert_eq!(counter, num_delimiters);
				// After each iteration of the outer loop, the
				// cursor in the file is at the *beginning* of the
				// block, so seeking forward by `i + 1` bytes puts
				// us right after the found delimiter.
				file.seek(SeekFrom::Current((i + 1) as i64)).unwrap();
				return;
			}
		}
	}
}

/// When tail'ing a file, we do not need to read the whole file from start to
/// finish just to find the last n lines or bytes. Instead, we can seek to the
/// end of the file, and then read the file "backwards" in blocks of size
/// `BLOCK_SIZE` until we find the location of the first line/byte. This ends up
/// being a nice performance win for very large files.
fn bounded_tail(file: &mut File, settings: &Settings) {
	debug_assert!(!settings.presume_input_pipe);
	let mut limit = None;

	// Find the position in the file to start printing from.
	match &settings.mode {
		FilterMode::Lines(Signum::Negative(count), delimiter) => {
			backwards_thru_file(file, *count, *delimiter);
		},
		FilterMode::Lines(Signum::Positive(count), delimiter) if count > &1 => {
			let i = forwards_thru_file(file, *count - 1, *delimiter).unwrap();
			file.seek(SeekFrom::Start(i as u64)).unwrap();
		},
		FilterMode::Lines(Signum::MinusZero, _) => {
			file.seek(SeekFrom::End(0)).unwrap();
		},
		FilterMode::Bytes(Signum::Negative(count)) => {
			if file.seek(SeekFrom::End(-(*count as i64))).is_err() {
				file.seek(SeekFrom::Start(0)).unwrap();
			}
			limit = Some(*count);
		},
		FilterMode::Bytes(Signum::Positive(count)) if count > &1 => {
			// GNU `tail` seems to index bytes and lines starting at 1, not
			// at 0. It seems to treat `+0` and `+1` as the same thing.
			file.seek(SeekFrom::Start(*count - 1)).unwrap();
		},
		FilterMode::Bytes(Signum::MinusZero) => {
			file.seek(SeekFrom::End(0)).unwrap();
		},
		_ => {},
	}

	print_target_section(file, limit);
}

fn unbounded_tail<T: Read>(reader: &mut BufReader<T>, settings: &Settings) -> UResult<()> {
	let mut writer = BufWriter::new(pi_uutils_ctx::stdout().lock());
	match &settings.mode {
		FilterMode::Lines(Signum::Negative(count), sep) => {
			let mut chunks = chunks::LinesChunkBuffer::new(*sep, *count);
			chunks.fill(reader)?;
			chunks.write(&mut writer)?;
		},
		FilterMode::Lines(Signum::PlusZero | Signum::Positive(1), _) => {
			io::copy(reader, &mut writer)?;
		},
		FilterMode::Lines(Signum::Positive(count), sep) => {
			let mut num_skip = *count - 1;
			let mut chunk = chunks::LinesChunk::new(*sep);
			while chunk.fill(reader)?.is_some() {
				let lines = chunk.get_lines() as u64;
				if lines < num_skip {
					num_skip -= lines;
				} else {
					break;
				}
			}
			if chunk.has_data() {
				chunk.write_lines(&mut writer, num_skip as usize)?;
				io::copy(reader, &mut writer)?;
			}
		},
		FilterMode::Bytes(Signum::Negative(count)) => {
			let mut chunks = chunks::BytesChunkBuffer::new(*count);
			chunks.fill(reader)?;
			chunks.print(&mut writer)?;
		},
		FilterMode::Lines(Signum::MinusZero, sep) => {
			let mut chunks = chunks::LinesChunkBuffer::new(*sep, 0);
			chunks.fill(reader)?;
			chunks.write(&mut writer)?;
		},
		FilterMode::Bytes(Signum::PlusZero | Signum::Positive(1)) => {
			io::copy(reader, &mut writer)?;
		},
		FilterMode::Bytes(Signum::Positive(count)) => {
			let mut num_skip = *count - 1;
			let mut chunk = chunks::BytesChunk::new();
			loop {
				if let Some(bytes) = chunk.fill(reader)? {
					let bytes: u64 = bytes as u64;
					match bytes.cmp(&num_skip) {
						Ordering::Less => num_skip -= bytes,
						Ordering::Equal => {
							break;
						},
						Ordering::Greater => {
							writer.write_all(chunk.get_buffer_with(num_skip as usize))?;
							break;
						},
					}
				} else {
					return Ok(());
				}
			}

			io::copy(reader, &mut writer)?;
		},
		_ => {},
	}
	#[cfg(not(target_os = "windows"))]
	writer.flush()?;

	// SIGPIPE is not available on Windows.
	#[cfg(target_os = "windows")]
	writer.flush().inspect_err(|err| {
		if err.kind() == ErrorKind::BrokenPipe {
			std::process::exit(13);
		}
	})?;
	Ok(())
}

fn print_target_section<R>(file: &mut R, limit: Option<u64>)
where
	R: Read + ?Sized,
{
	// Print the target section of the file.
	let stdout = pi_uutils_ctx::stdout();
	let mut stdout = stdout.lock();
	if let Some(limit) = limit {
		let mut reader = file.take(limit);
		io::copy(&mut reader, &mut stdout).unwrap();
	} else {
		io::copy(file, &mut stdout).unwrap();
	}
}

#[cfg(test)]
mod tests {

	use std::io::Cursor;

	use crate::forwards_thru_file;

	#[test]
	fn test_forwards_thru_file_zero() {
		let mut reader = Cursor::new("a\n");
		let i = forwards_thru_file(&mut reader, 0, b'\n').unwrap();
		assert_eq!(i, 0);
	}

	#[test]
	fn test_forwards_thru_file_basic() {
		//                   01 23 45 67 89
		let mut reader = Cursor::new("a\nb\nc\nd\ne\n");
		let i = forwards_thru_file(&mut reader, 2, b'\n').unwrap();
		assert_eq!(i, 4);
	}

	#[test]
	fn test_forwards_thru_file_past_end() {
		let mut reader = Cursor::new("x\n");
		let i = forwards_thru_file(&mut reader, 2, b'\n').unwrap();
		assert_eq!(i, 2);
	}
}
