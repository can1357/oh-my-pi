//! In-memory sink: encoded UTF-8 held until the owner takes it.
//!
//! Used where the device does not own a terminal (virtual terminals, test
//! harnesses, byte-counting sinks): the owner takes the output and delivers
//! it itself.

use std::mem;

/// Encoded output awaiting [`Capture::take`].
#[derive(Default)]
pub(super) struct Capture {
	bytes: Vec<u8>,
}

impl Capture {
	/// The buffer to encode into.
	pub(super) const fn sink(&mut self) -> &mut Vec<u8> {
		&mut self.bytes
	}

	/// Bytes held.
	pub(super) const fn len(&self) -> usize {
		self.bytes.len()
	}

	/// The bytes appended after offset `start`.
	pub(super) fn since(&self, start: usize) -> &[u8] {
		&self.bytes[start..]
	}

	/// Remove and return everything held, as one chunk (none when empty).
	pub(super) fn take(&mut self) -> Vec<Vec<u8>> {
		if self.bytes.is_empty() {
			return Vec::new();
		}
		vec![mem::take(&mut self.bytes)]
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn output_is_one_chunk_and_taking_empties_the_capture() {
		let mut capture = Capture::default();
		assert!(capture.take().is_empty());
		capture.sink().extend_from_slice(b"\x1b[2K\n\n\n");
		capture.sink().extend_from_slice(b"row");
		assert_eq!(capture.len(), 10);
		assert_eq!(capture.since(7), b"row");
		assert_eq!(capture.take(), [b"\x1b[2K\n\n\nrow".to_vec()]);
		assert!(capture.take().is_empty());
	}
}
