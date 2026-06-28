// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// cSpell:ignore sysconf
use std::io::{self, ErrorKind, Read};
#[cfg(unix)]
use std::io::{Seek, SeekFrom};
#[cfg(unix)]
use std::os::fd::{AsFd, AsRawFd};
#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

#[cfg(unix)]
use libc::{_SC_PAGESIZE, S_IFREG, sysconf};
use uucore::hardware::SimdPolicy;

use super::WordCountable;
use crate::{wc_simd_allowed, word_count::WordCount};
#[cfg(windows)]
const FILE_ATTRIBUTE_ARCHIVE: u32 = 32;
#[cfg(windows)]
const FILE_ATTRIBUTE_NORMAL: u32 = 128;

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
	{
		// pi-uutils: only a real file exposes a usable fd; the context's stdin
		// is a plain streaming reader with no fd, so we obtain the fd from the
		// inner file (when present) and otherwise fall straight through to the
		// read loop below.
		if let Some(file) = handle.inner_file() {
			let stat = rustix::fs::fstat(file.as_fd());
			if let Ok(stat) = stat {
				// `st_size` holds the byte length for regular files. A size of 0
				// means either an empty file or an unknown size (pseudo-fs like
				// /proc), so we fall back to a full read. Files in pseudo-fs may
				// also report `st_size` as a multiple of the page size while
				// holding far less content, so when the size is a page-size
				// multiple we seek near the end and read the rest. Finally, an fd
				// of 0 (stdin via `< file` redirection) cannot be trusted to
				// report remaining stream bytes, so it also falls back to a read.
				if file.as_raw_fd() > 0
					&& (stat.st_mode as libc::mode_t & S_IFREG) != 0
					&& stat.st_size > 0
				{
					let sys_page_size = unsafe { sysconf(_SC_PAGESIZE) as usize };
					if !(stat.st_size as usize).is_multiple_of(sys_page_size) {
						// regular file (or pseudo-fs file) whose size is NOT a
						// multiple of the system page size
						return (stat.st_size as usize, None);
					}
					// On some platforms `stat.st_blksize` and `stat.st_size` are
					// of different widths (i64 vs i32), e.g. macOS on Apple
					// Silicon; the cast keeps the arithmetic uniform.
					#[allow(clippy::unnecessary_cast)]
					let offset = stat.st_size as i64 - stat.st_size as i64 % (stat.st_blksize as i64 + 1);

					if let Ok(n) = file.seek(SeekFrom::Start(offset as u64)) {
						byte_count = n as usize;
					}
				}
				#[cfg(any(target_os = "linux", target_os = "android"))]
				{
					// If our file is a FIFO pipe, use splice to count the bytes.
					if (stat.st_mode as libc::mode_t & S_IFIFO) != 0 {
						match count_bytes_using_splice(&*file) {
							Ok(n) => return (n, None),
							Err(n) => byte_count = n,
						}
					}
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
