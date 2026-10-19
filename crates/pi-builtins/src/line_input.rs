//! Byte input for the line-reading builtins (`read`, `mapfile`).

use std::io::{self, Read, Seek, SeekFrom};

use brush_core::openfiles::OpenFile;

/// Bytes per read-ahead.
const BLOCK: usize = 4096;

/// ASCII control character for Ctrl+C (ETX - End of Text).
pub(crate) const CTRL_C: u8 = 0x03;
/// ASCII control character for Ctrl+D (EOT - End of Transmission).
pub(crate) const CTRL_D: u8 = 0x04;

/// The bytes of a read line as text: UTF-8 decoded once per line, invalid
/// sequences replaced rather than each byte read as a Latin-1 character.
pub(crate) fn decode_line(line: Vec<u8>) -> String {
	String::from_utf8(line).unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned())
}

/// When a [`LineInput`] may read past the bytes it hands out.
#[derive(Clone, Copy)]
pub(crate) enum ReadAhead {
	/// The caller consumes everything up to EOF, so reading ahead can never
	/// take input meant for someone else.
	ToEof,
	/// The caller may stop mid-input: read ahead only from a regular file,
	/// whose offset can be given back.
	Seekable,
}

/// A shell descriptor read one byte at a time by its caller.
///
/// Where reading ahead is safe, the descriptor is read a block at a time.
/// On drop, a regular file's shared offset is seeked back over the bytes read
/// but not handed out, so the next reader of the descriptor resumes right
/// after the last one consumed (bash's `read` does the same). Elsewhere every
/// byte is its own read, so nothing past the last consumed byte is taken from
/// a pipe or terminal another command shares.
pub(crate) struct LineInput {
	input:  OpenFile,
	blocks: bool,
	block:  Vec<u8>,
	pos:    usize,
}

impl LineInput {
	/// Terminal input is always read byte by byte, so interactive keys
	/// arrive as typed. Only a plain file handle counts as a regular file:
	/// std's `Stdin` keeps a buffer of its own, which a seek on the
	/// descriptor could not give back.
	pub(crate) fn new(input: OpenFile, read_ahead: ReadAhead) -> Self {
		let blocks = !input.is_terminal()
			&& match read_ahead {
				ReadAhead::ToEof => true,
				ReadAhead::Seekable => {
					matches!(&input, OpenFile::File(file) if file.metadata().is_ok_and(|m| m.is_file()))
				},
			};
		Self { input, blocks, block: Vec::new(), pos: 0 }
	}

	/// The underlying descriptor, e.g. to poll it before a read that could
	/// block.
	pub(crate) const fn input(&self) -> &OpenFile {
		&self.input
	}

	/// Whether reads come from a read-ahead block, never waiting on input.
	pub(crate) const fn reads_ahead(&self) -> bool {
		self.blocks
	}

	/// The next byte, or `None` at end of input.
	pub(crate) fn next_byte(&mut self) -> io::Result<Option<u8>> {
		if !self.blocks {
			let mut byte = [0_u8; 1];
			return Ok((self.input.read(&mut byte)? == 1).then_some(byte[0]));
		}
		if self.pos == self.block.len() {
			self.block.resize(BLOCK, 0);
			let n = self.input.read(&mut self.block)?;
			self.block.truncate(n);
			self.pos = 0;
			if n == 0 {
				return Ok(None);
			}
		}
		self.pos += 1;
		Ok(Some(self.block[self.pos - 1]))
	}

	/// Gives the bytes read ahead but not handed out back to a regular
	/// file's shared offset, so another reader of the descriptor resumes
	/// right after the last byte consumed. Bash's `mapfile` does the same
	/// before each `-C` callback. Read-ahead that cannot be given back is
	/// kept and handed out as usual.
	pub(crate) fn give_back(&mut self) {
		let unread = self.block.len() - self.pos;
		if unread > 0
			&& let OpenFile::File(file) = &mut self.input
			&& file.seek(SeekFrom::Current(-(unread as i64))).is_ok()
		{
			self.block.clear();
			self.pos = 0;
		}
	}
}

impl Drop for LineInput {
	fn drop(&mut self) {
		self.give_back();
	}
}
