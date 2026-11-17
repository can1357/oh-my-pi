//! Streaming record input, after GoAWK's record splitters in `interp/io.go`.

use std::{
	io::{self, Read},
	rc::Rc,
};

use super::regex::AwkRegex;

/// How `RS` separates records.
#[derive(Clone)]
pub(super) enum RecordSep {
	/// `RS="\n"`: lines, with a `\r` before the newline dropped (as GoAWK).
	Newline,
	/// A single-byte `RS`.
	Byte(u8),
	/// `RS=""`: paragraphs separated by blank lines.
	Paragraph,
	/// Any longer `RS` (gawk): a regular expression.
	Regex(Rc<AwkRegex>),
}

impl RecordSep {
	/// The separator `RS` selects.
	pub fn new(rs: &[u8]) -> Result<Self, String> {
		Ok(match rs {
			b"" => Self::Paragraph,
			b"\n" => Self::Newline,
			[byte] => Self::Byte(*byte),
			_ if std::str::from_utf8(rs).is_ok_and(|s| s.chars().count() == 1) => {
				Self::Regex(Rc::new(AwkRegex::literal(rs)?))
			},
			_ => Self::Regex(Rc::new(AwkRegex::new(rs)?)),
		})
	}
}

const CHUNK: usize = 64 * 1024;

/// A buffered reader that splits its input into records without reading
/// more than it needs.
pub(super) struct RecordReader {
	src:     Box<dyn Read>,
	buf:     Vec<u8>,
	/// Start of unconsumed data in `buf`.
	start:   usize,
	/// How far past `start` the current separator search already looked.
	scanned: usize,
	eof:     bool,
}

impl RecordReader {
	pub fn new(src: Box<dyn Read>) -> Self {
		Self { src, buf: Vec::new(), start: 0, scanned: 0, eof: false }
	}

	/// Reads more input; `false` at end of input.
	fn fill(&mut self) -> io::Result<bool> {
		if self.eof {
			return Ok(false);
		}
		if self.start > 0 {
			self.buf.drain(..self.start);
			self.start = 0;
		}
		let old = self.buf.len();
		self.buf.resize(old + CHUNK, 0);
		let read = loop {
			match self.src.read(&mut self.buf[old..]) {
				Ok(n) => break n,
				Err(err) => {
					self.buf.truncate(old);
					return Err(err);
				},
			}
		};
		self.buf.truncate(old + read);
		if read == 0 {
			self.eof = true;
		}
		Ok(read > 0)
	}

	/// Takes `len` bytes from the unconsumed data into `out` and skips
	/// `skip` more.
	fn take(&mut self, out: &mut Vec<u8>, len: usize, skip: usize) {
		out.extend_from_slice(&self.buf[self.start..self.start + len]);
		self.start += len + skip;
		self.scanned = 0;
	}

	/// Reads the next record into `out` (cleared first); `false` at end of
	/// input.
	pub fn read_record(&mut self, sep: &RecordSep, out: &mut Vec<u8>) -> io::Result<bool> {
		out.clear();
		match sep {
			RecordSep::Newline | RecordSep::Byte(_) => {
				let byte = if let RecordSep::Byte(byte) = sep { *byte } else { b'\n' };
				loop {
					let data = &self.buf[self.start..];
					if let Some(found) = memchr::memchr(byte, &data[self.scanned.min(data.len())..]) {
						let len = self.scanned + found;
						self.take(out, len, 1);
						if byte == b'\n' && out.last() == Some(&b'\r') {
							out.pop();
						}
						return Ok(true);
					}
					self.scanned = data.len();
					if !self.fill()? {
						let got = self.take_rest(out, false);
						if byte == b'\n' && out.last() == Some(&b'\r') {
							out.pop();
						}
						return Ok(got);
					}
				}
			},
			RecordSep::Paragraph => {
				loop {
					while self.start < self.buf.len() && matches!(self.buf[self.start], b'\n' | b'\r') {
						self.start += 1;
					}
					if self.start < self.buf.len() || !self.fill()? {
						break;
					}
				}
				self.scanned = 0;
				loop {
					let data = &self.buf[self.start..];
					let mut found = None;
					let mut i = self.scanned.saturating_sub(2);
					while let Some(nl) = memchr::memchr(b'\n', &data[i..]) {
						let at = i + nl;
						if data.get(at + 1) == Some(&b'\n') {
							found = Some((at, 2));
							break;
						}
						if data.get(at + 1) == Some(&b'\r') && data.get(at + 2) == Some(&b'\n') {
							found = Some((at, 3));
							break;
						}
						i = at + 1;
					}
					if let Some((at, skip)) = found {
						self.take(out, at, skip);
						if out.last() == Some(&b'\r') {
							out.pop();
						}
						return Ok(true);
					}
					self.scanned = data.len();
					if !self.fill()? {
						let got = self.take_rest(out, true);
						if out.last() == Some(&b'\r') {
							out.pop();
						}
						return Ok(got);
					}
				}
			},
			RecordSep::Regex(regex) => loop {
				let data = &self.buf[self.start..];
				let mut from = 0;
				let mut found = None;
				while let Some((s, e)) = regex.find_at(data, from) {
					if e > s {
						found = Some((s, e));
						break;
					}
					from = s + 1;
					if from > data.len() {
						break;
					}
				}
				match found {
					// A match touching the end of the buffer might grow.
					Some((s, e)) if e < data.len() || self.eof => {
						self.take(out, s, e - s);
						return Ok(true);
					},
					_ => {
						if !self.fill()? && found.is_none() {
							return Ok(self.take_rest(out, false));
						}
					},
				}
			},
		}
	}

	/// The final, unterminated record (if any) at end of input.
	fn take_rest(&mut self, out: &mut Vec<u8>, drop_newline: bool) -> bool {
		if self.start >= self.buf.len() {
			return false;
		}
		let mut len = self.buf.len() - self.start;
		if drop_newline && self.buf[self.start + len - 1] == b'\n' {
			len -= 1;
		}
		self.take(out, len, self.buf.len() - self.start - len);
		true
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn records(input: &str, rs: &str) -> Vec<String> {
		let mut reader = RecordReader::new(Box::new(io::Cursor::new(input.as_bytes().to_vec())));
		let sep = RecordSep::new(rs.as_bytes()).unwrap();
		let mut out = Vec::new();
		let mut all = Vec::new();
		while reader.read_record(&sep, &mut out).unwrap() {
			all.push(String::from_utf8(out.clone()).unwrap());
		}
		all
	}

	#[test]
	fn splits_lines_and_bytes() {
		assert_eq!(records("a\r\nb\nc", "\n"), ["a", "b", "c"]);
		assert_eq!(records("a;b;", ";"), ["a", "b"]);
		assert_eq!(records("", "\n"), Vec::<String>::new());
	}

	#[test]
	fn splits_paragraphs() {
		assert_eq!(records("\n\na\nb\n\n\nc\n", ""), ["a\nb", "c"]);
	}

	#[test]
	fn splits_on_regex() {
		assert_eq!(records("a12b345c", "[0-9]+"), ["a", "b", "c"]);
	}
}
