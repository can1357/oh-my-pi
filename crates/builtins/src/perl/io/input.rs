use std::io::{self, Read};

use memchr::memchr;

const CHUNK: usize = 8192;

/// Bytes read ahead but not yet consumed. They remain in their on-disk
/// representation so `tell`, `seek`, and a later `binmode` see the same offsets.
#[derive(Default)]
pub(super) struct Input {
	buf: Vec<u8>,
	start: usize,
	end: usize,
	at_eof: bool,
	/// Scalar sources need not copy ahead when the byte count is known.
	pub(super) direct: bool,
	/// Number of physical bytes consumed, used by unseekable sources.
	pub(super) offset: u64,
	/// Record bytes already consumed when a blocking read was interrupted by
	/// a due `alarm`; the retried record continues from them, as Perl's does.
	partial: Vec<u8>,
}

impl Input {
	/// Bytes read from the descriptor beyond the Perl file position.
	pub(super) fn unread(&self) -> usize {
		self.end - self.start
	}

	/// Discard lookahead and EOF after repositioning or writing.
	pub(super) fn reset(&mut self, offset: u64) {
		self.start = 0;
		self.end = 0;
		self.at_eof = false;
		self.offset = offset;
		self.partial.clear();
	}

	/// Push bytes back so the next read returns them first (`ungetc`).
	pub(super) fn unread_bytes(&mut self, bytes: &[u8]) {
		if bytes.is_empty() {
			return;
		}
		if self.start >= bytes.len() {
			self.start -= bytes.len();
			self.buf[self.start..self.start + bytes.len()].copy_from_slice(bytes);
		} else {
			let mut buf = Vec::with_capacity(bytes.len() + self.unread());
			buf.extend_from_slice(bytes);
			buf.extend_from_slice(&self.buf[self.start..self.end]);
			self.start = 0;
			self.end = buf.len();
			self.buf = buf;
		}
		self.offset = self.offset.saturating_sub(bytes.len() as u64);
	}

	/// Drop the bytes of a record whose read was abandoned (its handler died).
	pub(super) fn discard_partial(&mut self) {
		self.partial.clear();
	}

	/// Keep `out` for the retried read when `err` is an alarm interruption.
	fn keep_partial<T>(&mut self, out: Vec<u8>, err: io::Error) -> io::Result<T> {
		if super::alarm_due(&err) {
			self.partial = out;
		}
		Err(err)
	}

	fn ensure(&mut self, src: &mut impl Read, count: usize, limit: usize) -> io::Result<()> {
		if self.unread() >= count || self.at_eof {
			return Ok(());
		}
		let capacity = if self.direct { limit.clamp(count, CHUNK) } else { CHUNK };
		if self.buf.len() < capacity {
			self.buf.resize(capacity, 0);
		}
		let unread = self.unread();
		if self.start != 0 && unread != 0 {
			self.buf.copy_within(self.start..self.end, 0);
		}
		self.start = 0;
		self.end = unread;
		while self.end < count {
			let n = match src.read(&mut self.buf[self.end..capacity]) {
				Err(err) if err.kind() == io::ErrorKind::Interrupted && !super::alarm_due(&err) => continue,
				result => result?,
			};
			if n == 0 {
				self.at_eof = true;
				break;
			}
			self.end += n;
		}
		Ok(())
	}

	/// Examine buffered bytes without changing the logical file offset.
	pub(super) fn peek(&mut self, src: &mut impl Read) -> io::Result<&[u8]> {
		self.ensure(src, 1, CHUNK)?;
		Ok(&self.buf[self.start..self.end])
	}

	/// A logical window: an unchanged slice or one cooked CRLF newline. In
	/// the latter case consuming one byte advances the physical offset by two.
	fn window(&mut self, src: &mut impl Read, crlf: bool, limit: usize) -> io::Result<(&[u8], bool)> {
		self.ensure(src, 1, limit)?;
		let end = self.start + self.unread().min(limit);
		if crlf && let Some(cr) = memchr(b'\r', &self.buf[self.start..end]) {
			if cr != 0 {
				return Ok((&self.buf[self.start..self.start + cr], false));
			}
			self.ensure(src, 2, limit)?;
			if self.buf[self.start..self.end].starts_with(b"\r\n") {
				return Ok((b"\n", true));
			}
			return Ok((&self.buf[self.start..self.start + 1], false));
		}
		Ok((&self.buf[self.start..end], false))
	}

	fn consume(&mut self, len: usize, crlf: bool) {
		let physical = len + usize::from(crlf);
		self.start += physical;
		self.offset = self.offset.saturating_add(physical as u64);
	}

	/// Drain the remaining source to a single record.
	pub(super) fn to_end(&mut self, src: &mut impl Read, crlf: bool) -> io::Result<Vec<u8>> {
		let mut out = std::mem::take(&mut self.partial);
		match self.to_end_into(src, crlf, &mut out) {
			Ok(()) => Ok(out),
			Err(err) => self.keep_partial(out, err),
		}
	}

	fn to_end_into(&mut self, src: &mut impl Read, crlf: bool, out: &mut Vec<u8>) -> io::Result<()> {
		loop {
			let (bytes, cooked) = self.window(src, crlf, usize::MAX)?;
			if bytes.is_empty() {
				return Ok(());
			}
			out.extend_from_slice(bytes);
			let len = bytes.len();
			self.consume(len, cooked);
		}
	}

	/// Read up to `count` characters, grouping UTF-8 sequences when requested.
	pub(super) fn read_count(&mut self, src: &mut impl Read, count: usize, crlf: bool, unicode: bool) -> io::Result<Vec<u8>> {
		let mut out = std::mem::take(&mut self.partial);
		let done = if unicode { out.iter().filter(|&&b| b & 0xc0 != 0x80).count() } else { out.len() };
		out.reserve(count.saturating_sub(done).min(CHUNK));
		match self.read_count_into(src, count.saturating_sub(done), crlf, unicode, &mut out) {
			Ok(()) => Ok(out),
			Err(err) => self.keep_partial(out, err),
		}
	}

	fn read_count_into(&mut self, src: &mut impl Read, mut count: usize, crlf: bool, unicode: bool, out: &mut Vec<u8>) -> io::Result<()> {
		while count > 0 {
			let limit = if unicode { count.saturating_mul(13) } else { count };
			let (bytes, cooked) = self.window(src, crlf, limit)?;
			if bytes.is_empty() {
				break;
			}
			if !unicode || bytes.is_ascii() {
				let len = bytes.len().min(count);
				out.extend_from_slice(&bytes[..len]);
				self.consume(len, cooked);
				count -= len;
				continue;
			}
			let mut end = 0;
			while count > 0 && end < bytes.len() {
				let width = utf8_width(bytes[end]);
				if width > bytes.len() - end {
					break;
				}
				end += present_width(&bytes[end..], width);
				count -= 1;
			}
			if end != 0 {
				out.extend_from_slice(&bytes[..end]);
				self.consume(end, cooked);
			} else {
				// A UTF-8 character crossing the buffer boundary. Continuations
				// cannot be part of a newline conversion.
				let width = utf8_width(bytes[0]);
				self.ensure(src, width, width)?;
				let available = &self.buf[self.start..self.end];
				let len = present_width(available, width);
				out.extend_from_slice(&available[..len]);
				self.consume(len, false);
				count -= 1;
			}
		}
		Ok(())
	}

	/// The usual short raw record fits in lookahead. Move whole buffers when possible;
	/// otherwise copy just the returned record into its recycled, independently owned SV.
	#[inline]
	pub(super) fn buffered_record(&mut self, delim: u8, spare: &mut Vec<u8>) -> Option<Vec<u8>> {
		if self.direct || !self.partial.is_empty() { return None; }
		let len = memchr(delim, &self.buf[self.start..self.end])? + 1;
		if self.start == 0 && len == self.end && spare.capacity() >= self.buf.len() {
			std::mem::swap(&mut self.buf, spare);
			spare.truncate(len);
			self.start = 0;
			self.end = 0;
			self.offset = self.offset.saturating_add(len as u64);
		} else {
			spare.extend_from_slice(&self.buf[self.start..self.start + len]);
			self.consume(len, false);
		}
		Some(std::mem::take(spare))
	}

	/// Seed the next record allocation without discarding an interrupted record.
	pub(super) fn reuse(&mut self, spare: &mut Vec<u8>) {
		if self.partial.capacity() == 0 {
			std::mem::swap(&mut self.partial, spare);
		}
	}

	/// Reads through the exact delimiter, retaining it in the result.
	pub(super) fn until(&mut self, src: &mut impl Read, sep: &[u8], crlf: bool) -> io::Result<Vec<u8>> {
		let mut out = std::mem::take(&mut self.partial);
		match self.until_into(src, sep, crlf, &mut out) {
			Ok(()) => Ok(out),
			Err(err) => self.keep_partial(out, err),
		}
	}

	fn until_into(&mut self, src: &mut impl Read, sep: &[u8], crlf: bool, out: &mut Vec<u8>) -> io::Result<()> {
		if let [byte] = *sep {
			loop {
				let bytes = self.peek(src)?;
				if bytes.is_empty() { return Ok(()); }
				let found = if crlf { memchr::memchr2(byte, b'\r', bytes) } else { memchr(byte, bytes) };
				if let Some(at) = found && crlf && bytes[at] == b'\r' {
					out.extend_from_slice(&bytes[..at]);
					self.consume(at, false);
					// Only the CR itself needs lookahead (possibly across a refill).
					let (unit, cooked) = self.window(src, true, usize::MAX)?;
					let logical = unit[0];
					out.push(logical);
					self.consume(1, cooked);
					if logical == byte { return Ok(()); }
				} else {
					let len = found.map_or(bytes.len(), |at| at + 1);
					if len >= CHUNK / 2 && len == bytes.len() && self.start == 0 && out.is_empty() {
						// A whole refill belongs to this record. Transfer it rather
						// than copying it into another allocation (including when
						// this is the first fragment of a multi-buffer line).
						std::mem::swap(out, &mut self.buf);
						out.truncate(len);
						self.start = 0;
						self.end = 0;
						self.offset = self.offset.saturating_add(len as u64);
					} else {
						out.extend_from_slice(&self.buf[self.start..self.start + len]);
						self.consume(len, false);
					}
					if found.is_some() { return Ok(()); }
				}
			}
		}
		if sep.is_empty() {
			return self.to_end_into(src, crlf, out);
		}
		// KMP preserves a partial match at buffer boundaries. In particular a
		// repetitive separator never forces rescanning a long prefix per byte.
		let mut small = [0; 16];
		let mut large;
		let fallback = if sep.len() <= small.len() {
			&mut small[..sep.len()]
		} else {
			large = vec![0; sep.len()];
			large.as_mut_slice()
		};
		let mut matched = 0;
		for (i, &byte) in sep.iter().enumerate().skip(1) {
			matched = match_byte(sep, fallback, matched, byte);
			fallback[i] = matched;
		}
		// An interrupted record resumes with the separator state of its tail.
		matched = 0;
		for &byte in out.iter() {
			if matched == sep.len() {
				matched = fallback[matched - 1];
			}
			matched = match_byte(sep, fallback, matched, byte);
		}
		if matched == sep.len() {
			return Ok(());
		}
		loop {
			let (bytes, cooked) = self.window(src, crlf, usize::MAX)?;
			if bytes.is_empty() {
				return Ok(());
			}
			let mut len = 0;
			for &byte in bytes {
				len += 1;
				matched = match_byte(sep, fallback, matched, byte);
				if matched == sep.len() {
					break;
				}
			}
			out.extend_from_slice(&bytes[..len]);
			self.consume(len, cooked);
			if matched == sep.len() {
				return Ok(());
			}
		}
	}

	/// Read up to two newlines and consume any excess paragraph separators.
	pub(super) fn paragraph(&mut self, src: &mut impl Read, crlf: bool) -> io::Result<Vec<u8>> {
		if self.partial.is_empty() {
			self.skip_newlines(src, crlf)?;
		}
		let record = self.until(src, b"\n\n", crlf)?;
		if record.ends_with(b"\n\n")
			&& let Err(err) = self.skip_newlines(src, crlf)
		{
			return self.keep_partial(record, err);
		}
		Ok(record)
	}

	fn skip_newlines(&mut self, src: &mut impl Read, crlf: bool) -> io::Result<()> {
		loop {
			let (bytes, cooked) = self.window(src, crlf, usize::MAX)?;
			let len = bytes.iter().take_while(|&&b| b == b'\n').count();
			if len == 0 {
				return Ok(());
			}
			self.consume(len, cooked);
		}
	}
}

fn match_byte(sep: &[u8], fallback: &[usize], mut matched: usize, byte: u8) -> usize {
	while matched != 0 && sep[matched] != byte {
		matched = fallback[matched - 1];
	}
	matched + usize::from(sep[matched] == byte)
}

fn utf8_width(first: u8) -> usize {
	match first {
		0xc0..=0xdf => 2,
		0xe0..=0xef => 3,
		0xf0..=0xf7 => 4,
		0xf8..=0xfb => 5,
		0xfc..=0xfd => 6,
		0xfe => 7,
		0xff => 13,
		_ => 1,
	}
}

fn present_width(bytes: &[u8], width: usize) -> usize {
	1 + bytes.iter().skip(1).take(width - 1).take_while(|&&b| b & 0xc0 == 0x80).count()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn paragraph_discards_all_excess_newlines_and_accounts_for_physical_offsets() {
		let mut src = &b"\r\n\nfirst\r\n\r\n\r\nlast\r\n"[..];
		let mut input = Input::default();
		assert_eq!(input.paragraph(&mut src, true).unwrap(), b"first\n\n");
		assert_eq!(input.offset, 14);
		assert_eq!(input.paragraph(&mut src, true).unwrap(), b"last\n");
		assert!(input.paragraph(&mut src, true).unwrap().is_empty());
	}

	#[test]
	fn delimiter_and_codepoint_can_cross_the_read_buffer_boundary() {
		let mut bytes = vec![b'a'; CHUNK - 2];
		bytes.extend_from_slice(b"aaab\n\xce\xbb!");
		let mut src = bytes.as_slice();
		let mut input = Input::default();
		assert_eq!(input.until(&mut src, b"aaab", false).unwrap().len(), CHUNK + 2);
		assert_eq!(input.read_count(&mut src, 2, false, true).unwrap(), b"\n\xce\xbb");
		assert_eq!(input.read_count(&mut src, 2, false, true).unwrap(), b"!");

		let mut bytes = vec![b'a'; CHUNK - 1];
		bytes.extend_from_slice(b"\xf0\x9f\x99\x82");
		let mut src = bytes.as_slice();
		let mut input = Input::default();
		assert_eq!(input.read_count(&mut src, CHUNK - 1, false, true).unwrap().len(), CHUNK - 1);
		assert_eq!(input.read_count(&mut src, 1, false, true).unwrap(), b"\xf0\x9f\x99\x82");
	}
}
