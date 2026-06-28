// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.
// spell-checker:ignore bytestream
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
