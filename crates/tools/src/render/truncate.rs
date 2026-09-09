use xutf::{Encoding as _, Utf8};

/// Default maximum number of UTF-16 code units in one rendered line.
pub const DEFAULT_MAX_COLUMN: u32 = 512;

/// A borrowed result from [`truncate_head_bytes`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ByteTruncationResult<'a> {
	/// Longest valid UTF-8 prefix within the byte limit.
	pub text:  &'a str,
	/// UTF-8 byte length of `text`.
	pub bytes: usize,
}

/// Retains the longest valid UTF-8 prefix no larger than `max_bytes`.
///
/// The returned text borrows the input and never ends inside a UTF-8 scalar.
pub fn truncate_head_bytes(text: &str, max_bytes: usize) -> ByteTruncationResult<'_> {
	if text.len() <= max_bytes {
		return ByteTruncationResult { text, bytes: text.len() };
	}

	let mut rest = text.as_bytes();
	let mut end = 0usize;
	while !rest.is_empty() {
		let mut tail = rest;
		Utf8::decode(&mut tail);
		let decoded_bytes = rest.len() - tail.len();
		if end + decoded_bytes > max_bytes {
			break;
		}
		end += decoded_bytes;
		rest = tail;
	}
	ByteTruncationResult { text: &text[..end], bytes: end }
}
