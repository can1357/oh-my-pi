//! Incremental `\n`-delimited framing for `lines` connections.
//!
//! Reads land directly in [`LineReader`]'s buffer. Completed lines leave as one
//! [`LineBatch`] — a byte buffer plus spans — so a batch costs one allocation
//! however many lines it carries, and each line is copied once more only when
//! JavaScript materializes it as a string.

use std::{mem, str};

use memchr::memchr_iter;

/// Spare capacity reserved before each read.
pub const READ_CHUNK: usize = 64 * 1024;
/// Batches up to this size are copied out so the receive buffer is reused;
/// larger ones take the buffer itself and leave a fresh one behind.
const HANDOFF_BYTES: usize = 16 * 1024;

/// A received line exceeded the connection's `maxFrameBytes`.
#[derive(Debug, PartialEq, Eq)]
pub struct FrameTooLarge;

/// How a line's bytes become a JavaScript string.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Text {
	/// 7-bit ASCII: copied verbatim as Latin-1.
	Ascii,
	/// Valid UTF-8 with non-ASCII characters.
	Utf8,
	/// Invalid UTF-8: replaced lossily.
	Invalid,
}

/// One line inside a [`LineBatch`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
	pub start: usize,
	pub end:   usize,
	pub text:  Text,
}

/// Completed lines from one read burst, in arrival order.
pub struct LineBatch {
	pub bytes: Vec<u8>,
	pub spans: Vec<Span>,
}

impl LineBatch {
	/// Bytes of `span` (terminator already stripped).
	pub fn line(&self, span: Span) -> &[u8] {
		&self.bytes[span.start..span.end]
	}
}

/// Splits a byte stream into lines.
///
/// Each line drops its `\n` and one trailing `\r`; empty lines are skipped. A
/// line longer than `max` bytes (after stripping the terminator) is a protocol
/// error.
pub struct LineReader {
	/// Bytes after the last completed line; always starts at a line boundary.
	buf:     Vec<u8>,
	/// `buf[..scanned]` holds no newline.
	scanned: usize,
	max:     usize,
}

impl LineReader {
	/// Reader enforcing `max` bytes per line.
	pub const fn new(max: usize) -> Self {
		Self { buf: Vec::new(), scanned: 0, max }
	}

	/// Buffer to read into, with at least [`READ_CHUNK`] bytes of spare
	/// capacity.
	pub fn spare(&mut self) -> &mut Vec<u8> {
		self.buf.reserve(READ_CHUNK);
		&mut self.buf
	}

	/// Split every completed line off the buffer.
	///
	/// Lines completed before an oversize one are still returned, so callers
	/// can deliver them before closing.
	pub fn take(&mut self) -> (Option<LineBatch>, Result<(), FrameTooLarge>) {
		let mut spans = Vec::new();
		let mut start = 0;
		for newline in memchr_iter(b'\n', &self.buf[self.scanned..]).map(|at| at + self.scanned) {
			let line = strip_cr(&self.buf[start..newline]);
			if line.len() > self.max {
				return (self.split(start, spans), Err(FrameTooLarge));
			}
			if !line.is_empty() {
				spans.push(Span { start, end: start + line.len(), text: classify(line) });
			}
			start = newline + 1;
		}
		self.scanned = self.buf.len();
		// The pending fragment may still gain a `\r` that gets stripped, hence
		// the one byte of slack.
		let outcome = if self.buf.len() - start > self.max + 1 {
			Err(FrameTooLarge)
		} else {
			Ok(())
		};
		(self.split(start, spans), outcome)
	}

	/// Flush an unterminated final line at orderly end of stream.
	pub fn finish(&mut self) -> (Option<LineBatch>, Result<(), FrameTooLarge>) {
		let line = strip_cr(&self.buf);
		if line.len() > self.max {
			return (None, Err(FrameTooLarge));
		}
		if line.is_empty() {
			return (None, Ok(()));
		}
		let span = Span { start: 0, end: line.len(), text: classify(line) };
		self.scanned = 0;
		(Some(LineBatch { bytes: mem::take(&mut self.buf), spans: vec![span] }), Ok(()))
	}

	/// Remove `buf[..end]`, returning it as a batch when it holds any line.
	fn split(&mut self, end: usize, spans: Vec<Span>) -> Option<LineBatch> {
		self.scanned -= end.min(self.scanned);
		if spans.is_empty() {
			self.buf.drain(..end);
			return None;
		}
		let bytes = if end <= HANDOFF_BYTES {
			let bytes = self.buf[..end].to_vec();
			self.buf.drain(..end);
			bytes
		} else {
			let mut tail = Vec::with_capacity((self.buf.len() - end).max(READ_CHUNK));
			tail.extend_from_slice(&self.buf[end..]);
			let mut bytes = mem::replace(&mut self.buf, tail);
			bytes.truncate(end);
			bytes
		};
		Some(LineBatch { bytes, spans })
	}
}

fn strip_cr(line: &[u8]) -> &[u8] {
	line.strip_suffix(b"\r").unwrap_or(line)
}

const fn classify(line: &[u8]) -> Text {
	if line.is_ascii() {
		Text::Ascii
	} else if str::from_utf8(line).is_ok() {
		Text::Utf8
	} else {
		Text::Invalid
	}
}

#[cfg(test)]
mod tests {
	use super::{FrameTooLarge, HANDOFF_BYTES, LineBatch, LineReader, Text};

	fn feed(reader: &mut LineReader, chunk: &[u8]) -> (Vec<String>, Result<(), FrameTooLarge>) {
		reader.spare().extend_from_slice(chunk);
		let (batch, outcome) = reader.take();
		(lines_of(batch), outcome)
	}

	fn lines(batch: &LineBatch) -> Vec<String> {
		batch
			.spans
			.iter()
			.map(|&span| String::from_utf8_lossy(batch.line(span)).into_owned())
			.collect()
	}

	fn feed_all(reader: &mut LineReader, chunks: &[&[u8]]) -> Result<Vec<String>, FrameTooLarge> {
		let mut out = Vec::new();
		for chunk in chunks {
			let (lines, outcome) = feed(reader, chunk);
			out.extend(lines);
			outcome?;
		}
		Ok(out)
	}

	#[test]
	fn joins_lines_split_across_chunks() {
		let mut reader = LineReader::new(1024);
		let lines = feed_all(&mut reader, &[b"he", b"llo\nwor", b"ld", b"\n", b"tail"]).unwrap();
		assert_eq!(lines, ["hello", "world"]);
		let (batch, outcome) = reader.finish();
		assert_eq!(outcome, Ok(()));
		assert_eq!(lines_of(batch), ["tail"]);
	}

	fn lines_of(batch: Option<LineBatch>) -> Vec<String> {
		batch.as_ref().map_or_else(Vec::new, lines)
	}

	#[test]
	fn strips_one_trailing_cr_including_across_chunks() {
		let mut reader = LineReader::new(1024);
		let lines = feed_all(&mut reader, &[b"a\r\nb\r", b"\nc\r\r\n"]).unwrap();
		assert_eq!(lines, ["a", "b", "c\r"]);
	}

	#[test]
	fn skips_empty_lines() {
		let mut reader = LineReader::new(1024);
		let lines = feed_all(&mut reader, &[b"\n\r\n\nx\n\n"]).unwrap();
		assert_eq!(lines, ["x"]);
		let (batch, outcome) = reader.finish();
		assert!(batch.is_none());
		assert_eq!(outcome, Ok(()));
	}

	#[test]
	fn rejects_complete_line_over_max() {
		let mut reader = LineReader::new(4);
		assert_eq!(feed_all(&mut reader, &[b"abcd\nabcde\n"]), Err(FrameTooLarge));
		let mut reader = LineReader::new(4);
		assert_eq!(feed_all(&mut reader, &[b"abcd\r\n"]).unwrap(), ["abcd"]);
	}

	#[test]
	fn keeps_lines_before_overflow() {
		let mut reader = LineReader::new(4);
		let (lines, outcome) = feed(&mut reader, b"ok\ntoolong\n");
		assert_eq!(outcome, Err(FrameTooLarge));
		assert_eq!(lines, ["ok"]);
	}

	#[test]
	fn rejects_unterminated_fragment_over_max() {
		let mut reader = LineReader::new(4);
		assert_eq!(feed_all(&mut reader, &[b"abc", b"de", b"f"]), Err(FrameTooLarge));
		let mut reader = LineReader::new(4);
		assert_eq!(feed_all(&mut reader, &[b"ab", b"cd", b"e\n"]), Err(FrameTooLarge));
	}

	#[test]
	fn classifies_text_for_string_creation() {
		let mut reader = LineReader::new(1024);
		reader
			.spare()
			.extend_from_slice(b"plain\nh\xc3\xa9\na\xffb\n");
		let (batch, _) = reader.take();
		let batch = batch.unwrap();
		let kinds: Vec<Text> = batch.spans.iter().map(|span| span.text).collect();
		assert_eq!(kinds, [Text::Ascii, Text::Utf8, Text::Invalid]);
	}

	#[test]
	fn keeps_the_partial_line_across_large_batches() {
		// A batch over the copy threshold hands the buffer off; the trailing
		// fragment must survive in the fresh buffer.
		let mut reader = LineReader::new(1 << 20);
		let big = "x".repeat(HANDOFF_BYTES + 1);
		let chunk = format!("{big}\npart");
		let (lines, outcome) = feed(&mut reader, chunk.as_bytes());
		assert_eq!(outcome, Ok(()));
		assert_eq!(lines, [big]);
		let (lines, _) = feed(&mut reader, b"ial\n");
		assert_eq!(lines, ["partial"]);
	}
}
