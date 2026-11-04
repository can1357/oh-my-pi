//! The input cursor: source bytes and pushed alias or arithmetic-replay text.
//!
//! Borrowed source and alias values need no allocation. A failed arithmetic
//! recognition pushes its normalized text, as bash's `PSH_DPAREN` does;
//! small handles refer to those parser-owned buffers without self-borrows.

use alloc::vec::Vec;

use super::Parser;

/// A borrowed source/alias value or normalized text owned by the parser.
#[derive(Clone, Copy)]
pub(super) enum Buffer<'s> {
	Borrowed(&'s [u8]),
	Replay(usize),
}

impl Buffer<'_> {
	fn bytes<'a>(&'a self, replay: &'a [Vec<u8>]) -> &'a [u8] {
		match self {
			Self::Borrowed(bytes) => bytes,
			Self::Replay(index) => &replay[*index],
		}
	}

	fn same(self, other: Self) -> bool {
		match (self, other) {
			(Self::Borrowed(a), Self::Borrowed(b)) => core::ptr::eq(a, b),
			(Self::Replay(a), Self::Replay(b)) => a == b,
			_ => false,
		}
	}
}

/// The buffer that was current when an alias expansion was pushed.
pub(super) struct Frame<'s> {
	/// Outer buffer.
	pub buf:         Buffer<'s>,
	/// Cursor in the outer buffer (just after the aliased word).
	pub pos:         usize,
	/// Alias being expanded by the pushed buffer (recursion guard).
	pub alias:       Vec<u8>,
	/// The alias value ends in a blank: check the next word for an alias.
	pub expand_next: bool,
}

/// Here-document bodies read from the lines after the current one (a
/// here-document left open at the end of a command substitution): when the
/// cursor consumes the newline before `at`, it continues at `to`.
#[derive(Clone, Copy, Debug)]
pub(super) struct Skip {
	pub at:   usize,
	pub to:   usize,
	pub line: u32,
}

/// A cursor position to come back to.
#[derive(Clone, Copy)]
pub(super) struct Mark<'s> {
	buf:       Buffer<'s>,
	pos:       usize,
	line:      u32,
	depth:     usize,
	virt_done: bool,
}

/// The space bash returns after the last character of an alias expansion
/// (`shell_getc`'s `END_ALIAS`); a `static` so the buffer has one address.
pub(super) static END_ALIAS_SPACE: [u8; 1] = *b" ";

/// Placeholder buffer of the extra recursion-guard frames of
/// [`Parser::with_resume`].
pub(super) const EMPTY: &[u8] = &[];

impl<'s> Parser<'s> {
	/// The current buffer, borrowed only until the next cursor mutation.
	#[inline]
	pub(super) fn bytes(&self) -> &[u8] {
		self.buf.bytes(&self.replay)
	}

	/// Whether pushed arithmetic text is active, including under an alias.
	pub(super) fn replaying(&self) -> bool {
		matches!(self.buf, Buffer::Replay(_))
			|| self
				.frames
				.iter()
				.any(|f| matches!(f.buf, Buffer::Replay(_)))
	}

	/// Push normalized arithmetic text, without an alias recursion guard or
	/// the synthetic end-of-alias blank.
	pub(super) fn push_replay(&mut self, text: Vec<u8>) {
		let index = self.replay.len();
		self.replay.push(text);
		self.frames.push(Frame {
			buf:         self.buf,
			pos:         self.pos,
			alias:       Vec::new(),
			expand_next: false,
		});
		self.buf = Buffer::Replay(index);
		self.pos = 0;
	}

	/// The next byte, without consuming it; pops finished alias buffers.
	#[inline]
	pub(super) fn peek(&mut self) -> Option<u8> {
		match self.bytes().get(self.pos) {
			Some(&c) => Some(c),
			None => self.peek_slow(),
		}
	}

	#[cold]
	fn peek_slow(&mut self) -> Option<u8> {
		loop {
			if let Some(&c) = self.bytes().get(self.pos) {
				return Some(c);
			}
			let Some(frame) = self.frames.pop() else {
				return if self.virt != 0 && !self.virt_done {
					Some(self.virt)
				} else {
					None
				};
			};
			self.buf = frame.buf;
			self.pos = frame.pos;
			if frame.expand_next {
				self.lx.alexpnext = true;
			}
		}
	}

	/// The byte `n` places after the cursor in the current buffer.
	#[inline]
	pub(super) fn peek_at(&self, n: usize) -> Option<u8> {
		self.bytes().get(self.pos + n).copied()
	}

	/// Consume the byte [`Parser::peek`] returned.
	#[inline]
	pub(super) fn bump(&mut self) {
		if self.pos < self.bytes().len() {
			let nl = self.bytes()[self.pos] == b'\n';
			self.pos += 1;
			if nl && self.in_source() {
				self.base_newline();
			}
		} else if !self.virt_done {
			self.virt_done = true;
			if self.virt == b'\n' {
				self.line += 1;
			}
		}
	}

	const fn base_newline(&mut self) {
		self.line += 1;
		if let Some(sk) = self.skip
			&& sk.at == self.pos
		{
			self.pos = sk.to;
			self.line = sk.line;
			self.skip = None;
		}
	}

	/// Consume `n` bytes of the current buffer that contain no newline.
	#[inline]
	pub(super) const fn advance(&mut self, n: usize) {
		self.pos += n;
	}

	/// Consume `n` bytes of the current buffer, counting newlines.
	pub(super) fn advance_lines(&mut self, n: usize) {
		if self.in_source() {
			let end = self.pos + n;
			if self.skip.is_some() {
				while self.pos < end {
					self.bump();
				}
				return;
			}
			#[allow(clippy::naive_bytecount, reason = "dependency-free no_std crate")]
			let nls = self.bytes()[self.pos..end]
				.iter()
				.filter(|&&c| c == b'\n')
				.count();
			self.line += nls as u32;
			self.pos = end;
		} else {
			self.pos += n;
		}
	}

	/// Offset of the cursor in the source, plus the sub-parser base; inside an
	/// alias expansion, the offset just after the aliased word.
	pub(super) fn off(&self) -> u32 {
		self.base + self.src_pos() as u32
	}

	/// Cursor in the source; inside alias text, just after the aliased word.
	pub(super) fn src_pos(&self) -> usize {
		match self.frames.first() {
			None => self.pos,
			Some(f) => f.pos,
		}
	}

	/// Whether the cursor is in the source (not in alias text).
	pub(super) const fn in_source(&self) -> bool {
		self.frames.is_empty()
	}

	/// The line bash's `line_number` holds after reading up to the cursor:
	/// a newline only counts once the next line is read.
	pub(super) const fn bash_line(&self) -> u32 {
		if !self.in_source() {
			return self.line;
		}
		let after_nl = if self.pos == self.src.len() && self.virt_done && self.virt == b'\n' {
			true
		} else {
			self.pos > 0 && self.src[self.pos - 1] == b'\n'
		};
		if after_nl { self.line - 1 } else { self.line }
	}

	/// Line bash reports at end of input (the source treated as ending with a
	/// newline, plus the empty line bash reads at end of file).
	///
	/// A source ending in an unescaped backslash has no final newline: the
	/// word it ends meets the end of input, and bash counts a line for that
	/// read and one more for the token after it (one only when the backslash
	/// ends a comment).
	pub(super) const fn eof_line(&self) -> u32 {
		match self.virt {
			b'\n' if !self.virt_done => self.line + 1,
			b'\\' if self.virt_done && !self.virt_comment => self.line + 2,
			b'\\' => self.line + 1,
			_ => self.line,
		}
	}

	pub(super) const fn mark(&self) -> Mark<'s> {
		Mark {
			buf:       self.buf,
			pos:       self.pos,
			line:      self.line,
			depth:     self.frames.len(),
			virt_done: self.virt_done,
		}
	}

	/// Return to `m`; fails (and leaves the cursor alone) when an alias
	/// buffer was popped in between.
	pub(super) fn reset(&mut self, m: Mark<'s>) -> bool {
		if self.frames.len() != m.depth || !self.buf.same(m.buf) {
			return false;
		}
		self.pos = m.pos;
		self.line = m.line;
		self.virt_done = m.virt_done;
		true
	}

	/// Skip blanks and line continuations.
	pub(super) fn skip_blanks(&mut self) {
		loop {
			while let Some(c) = self.bytes().get(self.pos).copied() {
				if !matches!(c, b' ' | b'\t') {
					if c != b'\\' {
						return;
					}
					break;
				}
				self.pos += 1;
			}
			match self.peek() {
				Some(b' ' | b'\t') => self.bump(),
				Some(b'\\') if self.peek_at(1) == Some(b'\n') => {
					self.bump();
					self.bump();
				},
				_ => return,
			}
		}
	}

	/// Skip a comment up to (not including) the newline.
	pub(super) fn skip_comment(&mut self) {
		loop {
			let buf = self.bytes();
			let rest = &buf[self.pos.min(buf.len())..];
			if let Some(n) = rest.iter().position(|&c| c == b'\n') {
				self.advance(n);
				return;
			}
			self.advance(rest.len());
			match self.peek() {
				None | Some(b'\n') => return,
				Some(_) => {
					let virt_done = self.virt_done;
					self.bump();
					self.virt_comment |= !virt_done && self.virt_done;
				},
			}
		}
	}

	/// Alias text not yet read: the rest of every pushed buffer, innermost
	/// first.
	pub(super) fn alias_text_left(&self) -> Vec<u8> {
		let mut out = Vec::new();
		if self.frames.is_empty() {
			return out;
		}
		out.extend_from_slice(self.bytes().get(self.pos..).unwrap_or_default());
		for f in self.frames.iter().skip(1).rev() {
			out.extend_from_slice(f.buf.bytes(&self.replay).get(f.pos..).unwrap_or_default());
		}
		out
	}

	/// Alias names still being expanded (recursion guard).
	pub(super) fn active_aliases(&self) -> Vec<Vec<u8>> {
		let mut out: Vec<Vec<u8>> = Vec::new();
		for f in &self.frames {
			if !f.alias.is_empty() && !out.contains(&f.alias) {
				out.push(f.alias.clone());
			}
		}
		out
	}

	/// Whether the byte just consumed was the end-of-alias space.
	pub(super) fn at_alias_space(&self) -> bool {
		self.pos == 1 && core::ptr::eq(self.bytes().as_ptr(), END_ALIAS_SPACE.as_ptr())
	}

	/// Whether alias `name` is being expanded.
	pub(super) fn alias_active(&self, name: &[u8]) -> bool {
		self.frames.iter().any(|f| f.alias == name)
	}
}
