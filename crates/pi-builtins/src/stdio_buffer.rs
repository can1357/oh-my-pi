//! glibc's accounting of a fully buffered `FILE`'s output buffer: which stdio
//! calls of a program write to its descriptor, and how many bytes.
//!
//! A program dies of SIGPIPE at the `write(2)` that finds a pipe with no
//! reader, and stdio decides when that write happens. glibc (2.37 and later)
//! writes the buffer when a call overflows it, never when a call only fills
//! it, so a program's actions between its writes run or not by these rules:
//!
//! - `fwrite`, `fputs`, `putc` (`_IO_new_file_xsputn`): copy what fits; if
//!   more is left, write the full buffer, then write the whole blocks of the
//!   rest at once and keep the remainder. A stream allocates its buffer at its
//!   first write, so a first call of a whole block writes it at once.
//! - `printf`, `fprintf` (`__printf_buffer_to_file`): format into the buffer;
//!   each time it is full and more output follows, write it.
//! - `fflush`: write what the buffer holds.

#![allow(dead_code, reason = "consumed by the feature-gated utility modules")]

/// glibc's default buffer size (`BUFSIZ`).
const BUFSIZ: usize = 8192;

/// A stdio call that writes to a fully buffered stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StdioCall {
	/// `fwrite`, `fputs` or `putc` of `n` bytes.
	Write(usize),
	/// `printf` or `fprintf` producing `n` bytes.
	Printf(usize),
	/// `fflush`.
	Flush,
}

impl StdioCall {
	/// Bytes the call produces.
	pub(crate) const fn len(self) -> usize {
		match self {
			Self::Write(n) | Self::Printf(n) => n,
			Self::Flush => 0,
		}
	}
}

/// The state of a `FILE`'s output buffer of `cap` bytes (0: unbuffered).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct StdioBuffer {
	/// glibc allocated the buffer (at the stream's first write).
	allocated: bool,
	/// Bytes in the buffer.
	buffered:  usize,
}

impl StdioBuffer {
	/// Bit of [`StdioBuffer::pack`] for [`StdioBuffer::allocated`].
	const ALLOCATED: usize = 1 << (usize::BITS - 1);

	/// Applies `call` to a buffer of `cap` bytes; returns the bytes it writes
	/// to the descriptor (they leave the buffer in order).
	pub(crate) fn apply(&mut self, cap: usize, call: StdioCall) -> usize {
		if cap == 0 {
			// An unbuffered stream writes every call at once.
			return call.len();
		}
		match call {
			StdioCall::Write(n) => self.sputn(cap, n),
			StdioCall::Printf(n) => self.printf(cap, n),
			StdioCall::Flush => std::mem::take(&mut self.buffered),
		}
	}

	/// Bytes in the buffer.
	pub(crate) const fn buffered(self) -> usize {
		self.buffered
	}

	/// `_IO_new_file_xsputn` for `n` bytes.
	fn sputn(&mut self, cap: usize, n: usize) -> usize {
		if n == 0 {
			return 0;
		}
		let room = if self.allocated { cap - self.buffered } else { 0 };
		let copied = room.min(n);
		self.buffered += copied;
		let rest = n - copied;
		if rest == 0 {
			return 0;
		}
		// `_IO_OVERFLOW`: write the (full) buffer, or allocate an empty one.
		let flushed = std::mem::take(&mut self.buffered);
		self.allocated = true;
		// Then the whole blocks of the rest, keeping the remainder.
		let direct = rest - rest % cap;
		self.buffered = rest % cap;
		flushed + direct
	}

	/// `vfprintf` through `__printf_buffer_to_file` for `n` bytes of output:
	/// each time the buffer is full and output remains, glibc writes it.
	fn printf(&mut self, cap: usize, n: usize) -> usize {
		if n == 0 {
			return 0;
		}
		self.allocated = true;
		let total = self.buffered + n;
		let written = (total - 1) / cap * cap;
		self.buffered = total - written;
		written
	}

	/// The state as one word, for an atomic.
	pub(crate) const fn pack(self) -> usize {
		self.buffered | if self.allocated { Self::ALLOCATED } else { 0 }
	}

	/// The state [`StdioBuffer::pack`] packed.
	pub(crate) const fn unpack(word: usize) -> Self {
		Self { allocated: word & Self::ALLOCATED != 0, buffered: word & !Self::ALLOCATED }
	}
}

/// The buffer glibc gives a stream on a file with block size `blksize` (0:
/// unknown): `st_blksize` when it is smaller than `BUFSIZ`, else `BUFSIZ`
/// (`_IO_file_doallocate`).
pub(crate) const fn buffer_size(blksize: u64) -> usize {
	if blksize > 0 && blksize < BUFSIZ as u64 { blksize as usize } else { BUFSIZ }
}

/// The buffer glibc gives a stream on `file`: by its block size for a host
/// file (a pipe's is 4096), and one pipe block for any other.
pub(crate) fn file_buffer_size(file: &pi_vfs::File) -> usize {
	#[cfg(unix)]
	if let Some(native) = file.native() {
		use std::os::unix::fs::MetadataExt;
		return native.metadata().map_or(BUFSIZ, |metadata| buffer_size(metadata.blksize()));
	}
	4096
}

#[cfg(test)]
mod tests {
	use super::{StdioBuffer, StdioCall};

	const CAP: usize = 4096;

	fn run(calls: &[StdioCall]) -> Vec<usize> {
		let mut buffer = StdioBuffer::default();
		calls.iter().map(|&call| buffer.apply(CAP, call)).collect()
	}

	/// Contract: a first `fwrite` of a whole block writes it at once, while a
	/// `printf` of the same size only fills the buffer (GNU find: a 4096-byte
	/// `-printf` literal dies before `-delete`, `%4096s` after it).
	#[test]
	fn a_first_block_is_written_by_fwrite_and_buffered_by_printf() {
		assert_eq!(run(&[StdioCall::Write(CAP)]), [CAP]);
		assert_eq!(run(&[StdioCall::Printf(CAP)]), [0]);
		assert_eq!(run(&[StdioCall::Printf(CAP + 1)]), [CAP]);
	}

	/// Contract: a call that only fills an allocated buffer writes nothing;
	/// the next byte writes the full buffer (GNU sed: a 4095-byte line and its
	/// newline stay buffered).
	#[test]
	fn a_call_that_fills_the_buffer_writes_nothing() {
		assert_eq!(run(&[StdioCall::Write(CAP - 1), StdioCall::Write(1), StdioCall::Write(1)]), [0, 0, CAP]);
		assert_eq!(run(&[StdioCall::Printf(3), StdioCall::Printf(CAP - 3), StdioCall::Printf(1)]), [0, 0, CAP]);
	}

	/// Contract: after an overflow `fwrite` writes the whole blocks of the
	/// rest and keeps the remainder; `printf` keeps up to a full buffer.
	#[test]
	fn an_overflow_keeps_glibcs_remainder() {
		let mut buffer = StdioBuffer::default();
		assert_eq!(buffer.apply(CAP, StdioCall::Write(10)), 0);
		assert_eq!(buffer.apply(CAP, StdioCall::Write(2 * CAP)), 2 * CAP);
		assert_eq!(buffer.buffered(), 10);
		let mut buffer = StdioBuffer::default();
		assert_eq!(buffer.apply(CAP, StdioCall::Printf(2 * CAP)), CAP);
		assert_eq!(buffer.buffered(), CAP);
	}

	/// Contract: `fflush` writes what the buffer holds, and an unbuffered
	/// stream writes every call.
	#[test]
	fn flush_and_unbuffered() {
		assert_eq!(run(&[StdioCall::Write(5), StdioCall::Flush, StdioCall::Flush]), [0, 5, 0]);
		let mut buffer = StdioBuffer::default();
		assert_eq!(buffer.apply(0, StdioCall::Printf(3)), 3);
	}

	#[test]
	fn pack_round_trips() {
		let mut buffer = StdioBuffer::default();
		buffer.apply(CAP, StdioCall::Write(7));
		assert_eq!(StdioBuffer::unpack(buffer.pack()), buffer);
		assert_eq!(StdioBuffer::unpack(StdioBuffer::default().pack()), StdioBuffer::default());
	}
}
