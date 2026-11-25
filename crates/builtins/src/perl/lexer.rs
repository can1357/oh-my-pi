//! Byte-level scanners for perldata, perlop, perlsyn and perlrun.
//!
//! The parser chooses which scanner to invoke in a term position. The regular token scanner never
//! guesses whether `/`, `<<`, `<`, or a sigil begins a value or acts as an operator.

use std::{borrow::Cow, rc::Rc};

use super::ast::Location;

/// Regular token category, before term-context reinterpretation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Kind {
	/// Identifier or word operator/keyword.
	Word,
	/// Numeric or v-string literal.
	Number,
	/// Symbol or punctuation token, possibly a multi-byte operator.
	Symbol,
	/// `__DATA__` or `__END__`.
	Data(bool),
	/// End of source after skipping trivia.
	Eof,
}

/// A token refers to input without allocating its spelling.
#[derive(Clone, Debug)]
pub(super) struct Token {
	/// Regular token category.
	pub kind: Kind,
	/// Initial byte offset.
	pub start: usize,
	/// Offset just past the last byte.
	pub end: usize,
	/// Initial logical location.
	pub location: Location,
}

/// Error while scanning a quote, here-doc, format, or variable name.
#[derive(Debug)]
pub(super) struct LexError {
	/// Logical location that opened this construct.
	pub location: Location,
	/// Error text before Perl's location suffix.
	pub message: String,
}

/// Contents of a delimited construct, normalized for its delimiter.
#[derive(Debug)]
pub(super) struct Quoted<'a> {
	/// First byte of the body (distinct from the opening delimiter location).
	pub location: Location,
	/// Body with backslashes before delimiters processed as appropriate to the quote flavor.
	pub bytes: Cow<'a, [u8]>,
	/// Character that opened the quote.
	pub delimiter: u32,
	/// True for a pair of distinct delimiters.
	pub paired: bool,
}

/// How delimiter escapes are carried to the next phase.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum QuoteScan {
	/// Decode escaped delimiters and double backslashes immediately.
	Single,
	/// Leave escaped backslashes encoded for interpolation; decode escaped delimiters.
	Double,
	/// Preserve regex meaning when removing escaped regex delimiters.
	Pattern,
	/// Preserve transliteration escapes, including escaped `-`.
	Transliterate,
	/// Locate a closing delimiter for syntactic lookahead without copying the body.
	Boundary,
}

/// Here-doc interpolation mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum HereKind {
	/// `<<'NAME'` or `<<\NAME`.
	Literal,
	/// `<<NAME` or `<<"NAME"`.
	Interpolate,
	/// Backtick marker.
	Command,
}

/// A here-doc body can be located before ordinary tokens on its introducer line resume.
#[derive(Debug)]
pub(super) struct HereDoc {
	/// First line of the body.
	pub location: Location,
	/// Body excluding terminator and indentation.
	pub bytes: Vec<u8>,
	/// Whether and how to interpolate it.
	pub kind: HereKind,
}

/// Cursor and scopes affecting source interpretation.
#[derive(Clone, Debug)]
pub(super) struct Lexer<'a> {
	/// Original source, never mutated.
	pub source: &'a [u8],
	/// Position immediately after the last scanner result.
	pub pos: usize,
	/// UTF-8 lexical hint.
	pub utf8: bool,
	location: Location,
	// The parser continues scanning the introducer line until it reaches the pending bodies.
	here_skip: Option<HereSkip>,
	external_here: Option<HereTail<'a>>,
	physical_eol: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct HereSkip {
	from: usize,
	to: usize,
	lines: u32,
}

/// Continuation of the enclosing source line for heredocs introduced in quoted code.
#[derive(Clone, Copy, Debug)]
pub(super) struct HereTail<'a> {
	source: &'a [u8],
	skip: HereSkip,
	// True when the slice belongs to the immediate parent's lexer.
	local_to_parent: bool,
}

impl<'a> Lexer<'a> {
	/// Establish a cursor with a logical file, starting line, and source encoding.
	pub fn new(source: &'a [u8], file: Rc<str>, line: u32, utf8: bool) -> Self {
		Self {
			source,
			pos: if source.starts_with(b"\xef\xbb\xbf") { 3 } else { 0 },
			utf8: utf8 || source.starts_with(b"\xef\xbb\xbf"),
			location: Location { file, line },
			here_skip: None,
			external_here: None,
			physical_eol: 0,
		}
	}

	/// Renumber the current and following lines (a `#line` inside quoted code).
	pub fn shift_line(&mut self, delta: i64) {
		self.location.line = u32::try_from((i64::from(self.location.line) + delta).max(1)).unwrap_or(u32::MAX);
	}

	/// Skip whitespace, comments and POD like the regular scanner, honoring `#line`.
	pub fn skip_space(&mut self) {
		self.skip_trivia();
	}

	/// Location of the current cursor.
	pub fn location(&self) -> Location {
		self.location.clone()
	}

	/// Reinterpret a token's bytes as the opening of a context-sensitive term.
	pub fn rewind(&mut self, token: &Token) {
		// Regular tokens do not contain newlines.
		self.pos = token.start;
		self.location = token.location.clone();
	}

	/// Advance through ordinary bytes; count newlines and skip queued here-doc bodies.
	pub fn advance(&mut self, end: usize) {
		let end = end.min(self.source.len());
		if end <= self.pos {
			return;
		}
		if let Some(skip) = self.here_skip && skip.from <= end {
			self.here_skip = None;
			let prefix = self.source.get(self.pos..skip.from).unwrap_or_default();
			let prefix_lines = prefix.iter().filter(|&&b| b == b'\n').count() as u32;
			self.location.line = self.location.line.saturating_add(prefix_lines).saturating_add(skip.lines);
			self.pos = self.pos.max(skip.to);
			self.advance(end);
			return;
		}
		let lines = self.source[self.pos..end].iter().filter(|&&b| b == b'\n').count() as u32;
		self.location.line = self.location.line.saturating_add(lines);
		self.pos = end;
	}

	/// Pass the next physical source line into a parser for text ending inside a quote.
	pub fn heredoc_tail(&mut self) -> Option<HereTail<'a>> {
		if self.physical_eol <= self.pos {
			self.physical_eol = line_end(self.source, self.pos);
		}
		let from = self.physical_eol;
		if from > self.pos && self.source.get(from - 1) == Some(&b'\n') {
			Some(HereTail { source: self.source, skip: self.here_skip.unwrap_or(HereSkip { from, to: from, lines: 0 }), local_to_parent: true })
		} else {
			self.external_here.map(|tail| HereTail { local_to_parent: false, ..tail })
		}
	}

	/// Here-doc bodies read from this lexer's own source but not yet passed over, as the byte
	/// range they occupy: the remainder of an interpolated string must omit them.
	pub fn pending_heredoc_bodies(&self) -> Option<(usize, usize)> {
		self.here_skip.map(|skip| (skip.from, skip.to))
	}

	/// Install the enclosing physical source continuation in a nested parser.
	pub fn set_heredoc_tail(&mut self, tail: Option<HereTail<'a>>) { self.external_here = tail; }

	/// Take the changed skip range, if a virtual quote parser consumed enclosing lines.
	pub fn take_heredoc_tail(&mut self) -> Option<HereTail<'a>> { self.external_here.take() }

	/// Merge body consumption from a parser for interpolation or replacement code.
	pub fn inherit_heredoc_tail(&mut self, tail: HereTail<'_>) {
		if tail.local_to_parent {
			self.here_skip = Some(tail.skip);
		} else if let Some(external) = &mut self.external_here {
			external.skip = tail.skip;
		}
	}

	/// Whether nested code added a body to its external source.
	pub fn heredoc_tail_changed(before: HereTail<'_>, after: HereTail<'_>) -> bool { before.skip != after.skip }

	/// Source spelling of a token.
	pub fn text(&self, token: &Token) -> &'a [u8] {
		&self.source[token.start..token.end]
	}

	/// Scan a regular token, skipping comments/POD and accounting for `#line` directives.
	pub fn next(&mut self) -> Token {
		self.skip_trivia();
		let start = self.pos;
		let mut location = self.location();
		let src = self.source;
		let (kind, end) = match src.get(start).copied() {
			None => {
				if start != 0 && src.get(start - 1) == Some(&b'\n') {
					location.line = location.line.saturating_sub(1).max(1);
				}
				(Kind::Eof, start)
			}
			Some(b'<' | b'=' | b'>') if (start == 0 || src.get(start - 1) == Some(&b'\n')) &&
				matches!(src.get(start..start + 7), Some(b"<<<<<<<" | b"=======" | b">>>>>>>")) => (Kind::Symbol, start + 7),
			Some(b'0'..=b'9') => (Kind::Number, number_end(src, start)),
			Some(b'.') if src.get(start + 1).is_some_and(u8::is_ascii_digit) => {
				(Kind::Number, number_end(src, start))
			}
			Some(b'v') if version_end(src, start, self.utf8).is_some() => {
				(Kind::Number, version_end(src, start, self.utf8).unwrap_or(start + 1))
			}
			Some(_) if let Some(end) = name_end(src, start, self.utf8) => {
				let name = &src[start..end];
				if matches!(name, b"__DATA__" | b"__END__" | b"CORE::__DATA__" | b"CORE::__END__") && !src[end..].trim_ascii_start().starts_with(b"=>") {
					(Kind::Data(name.ends_with(b"__END__")), end)
				} else if name == b"x" && src.get(end) == Some(&b'=') && src.get(end + 1) != Some(&b'>') {
					(Kind::Symbol, end + 1)
				} else {
					(Kind::Word, end)
				}
			}
			Some(_) => {
				let remaining = &src[start..];
				const MULTI: &[&[u8]] = &[
					b"<=>", b"...", b"**=", b"<<=", b">>=", b"&&=", b"||=", b"//=", b"&.=", b"|.=", b"^.=" ,
					b"=>", b"->", b"++", b"--", b"**", b"<<", b">>", b"=~", b"!~", b"==", b"!=", b"<=", b">=", b"~~",
					b"&&", b"||", b"//", b"..", b"+=", b"-=", b"*=", b"/=", b"%=", b".=", b"&=", b"|=", b"^=", b"&.", b"|.", b"^.", b"~.",
				];
				let len = MULTI.iter().find(|op| remaining.starts_with(op)).map_or_else(
					|| unit(src, start, self.utf8).map_or(1, |(_, len)| len),
					|op| op.len(),
				);
				(Kind::Symbol, start + len)
			}
		};
		self.advance(end);
		Token { kind, start, end, location }
	}

	/// Consume only the initial portion of a token being reinterpreted in term position.
	pub fn split_token(&mut self, mut token: Token, end: usize) -> Token {
		self.rewind(&token);
		self.advance(end);
		token.end = end;
		token
	}

	/// Split an apostrophe quote operator from its delimiter in term position only.
	pub fn apostrophe_quote_token(&mut self, token: Token) -> Token {
		if let Some(end) = apostrophe_quote(self.source, token.start) {
			self.split_token(token, end)
		} else { token }
	}

	/// Skip ASCII whitespace and, if requested, comments before a quote delimiter.
	pub fn quote_gap(&mut self, comments: bool) {
		let mut spaced = false;
		loop {
			while self.source.get(self.pos).is_some_and(u8::is_ascii_whitespace) {
				self.advance(self.pos + 1);
				spaced = true;
			}
			if comments && spaced && self.source.get(self.pos) == Some(&b'#') {
				self.advance(line_end(self.source, self.pos));
			} else {
				break;
			}
		}
	}

	fn skip_trivia(&mut self) {
		loop {
			let at_line_start = self.pos == 0 || self.pos == 3 && self.source.starts_with(b"\xef\xbb\xbf")
				|| self.source.get(self.pos.wrapping_sub(1)) == Some(&b'\n');
			match self.source.get(self.pos).copied() {
				Some(b) if b.is_ascii_whitespace() || b == 0 => self.advance(self.pos + 1),
				Some(b'#') => {
					let end = line_end(self.source, self.pos);
					let directive = if at_line_start { line_directive(&self.source[self.pos + 1..end]) } else { None };
					self.advance(end);
					if let Some((line, file)) = directive {
						self.location.line = line;
						if let Some(file) = file { self.location.file = file; }
					}
				}
				Some(b'=') if at_line_start && self.source.get(self.pos + 1).is_some_and(u8::is_ascii_alphabetic) => {
					let mut end = self.pos;
					while end < self.source.len() {
						let next = line_end(self.source, end);
						let line = &self.source[end..next];
						end = next;
						if line.strip_prefix(b"=cut").and_then(|rest| rest.first()).is_some_and(u8::is_ascii_whitespace) {
							break;
						}
					}
					self.advance(end);
				}
				_ => break,
			}
		}
	}

	/// Find a matching delimiter, skipping nested paired delimiters and escaped units.
	/// For the second half of an unpaired substitution, `shared` is its already-consumed delimiter.
	pub fn quote(&mut self, scan: QuoteScan, shared: Option<u32>) -> Result<Quoted<'a>, LexError> {
		let opening = self.location();
		let src = self.source;
		let (delimiter, width) = shared.map(|cp| (cp, 0)).or_else(|| unit(src, self.pos, self.utf8))
			.ok_or_else(|| LexError { location: opening.clone(), message: "Search pattern not terminated".into() })?;
		let (close, paired) = match delimiter {
			40 => (41, true),
			91 => (93, true),
			123 => (125, true),
			60 => (62, true),
			_ => (delimiter, false),
		};
		self.advance(self.pos + width);
		let location = self.location();
		let start = self.pos;
		let mut pos = start;
		let mut chunk = start;
		let mut normalized = None;
		let mut depth = 1usize;
		while let Some((cp, len)) = unit(src, pos, self.utf8) {
			// A pending body can be between two lines of this quote, but none
			// of its delimiters belong to the surrounding quote.
			if let Some(skip) = self.here_skip && pos == skip.from && skip.from < skip.to {
				if scan != QuoteScan::Boundary {
					normalized.get_or_insert_with(Vec::new).extend_from_slice(&src[chunk..pos]);
				}
				chunk = skip.to;
				pos = skip.to;
				continue;
			}
			if cp == u32::from(b'\\') && delimiter != cp && let Some((next, n)) = unit(src, pos + len, self.utf8) {
				let escaped_delim = next == close || next == delimiter;
				let keep_delim_escape = scan == QuoteScan::Pattern && regex_meta(next)
					|| scan == QuoteScan::Double && matches!(next, 36 | 64)
					|| scan == QuoteScan::Transliterate && matches!(next, 45 | 92);
				if scan != QuoteScan::Boundary && (escaped_delim && !keep_delim_escape || next == cp && scan == QuoteScan::Single) {
					normalized.get_or_insert_with(Vec::new).extend_from_slice(&src[chunk..pos]);
					chunk = pos + len;
				}
				pos += len + n;
				continue;
			}
			if cp == close {
				depth -= 1;
				if depth == 0 {
					let bytes = if let Some(mut bytes) = normalized {
						bytes.extend_from_slice(&src[chunk..pos]);
						Cow::Owned(bytes)
					} else { Cow::Borrowed(&src[start..pos]) };
					let bytes = if scan == QuoteScan::Boundary { bytes } else { normalize_lines(bytes) };
					self.advance(pos + len);
					return Ok(Quoted { location, bytes, delimiter, paired });
				}
			} else if paired && cp == delimiter {
				depth += 1;
			}
			pos += len;
		}
		let message = if scan == QuoteScan::Pattern { "Search pattern not terminated".into() } else {
			let ch = char::from_u32(close).unwrap_or('\u{fffd}');
			let surround = if ch == '"' { '\'' } else { '"' };
			format!("Can't find string terminator {surround}{ch}{surround} anywhere before EOF")
		};
		Err(LexError { location: opening, message })
	}

	/// Consume a heredoc marker, find its body, and queue the body for skipping at the newline.
	pub fn heredoc(&mut self) -> Result<HereDoc, LexError> {
		let opening = self.location();
		let src = self.source;
		let indented = src.get(self.pos) == Some(&b'~');
		if indented { self.advance(self.pos + 1); }
		let before_space = self.pos;
		while matches!(src.get(self.pos), Some(b' ' | b'\t')) { self.advance(self.pos + 1); }
		let space_before_marker = self.pos != before_space;
		let mut kind = HereKind::Interpolate;
		let marker = match src.get(self.pos) {
			Some(b'\'' | b'"' | b'`') => {
				kind = match src[self.pos] { b'\'' => HereKind::Literal, b'`' => HereKind::Command, _ => HereKind::Interpolate };
				self.quote(QuoteScan::Single, None).map_err(|_| LexError { location: opening.clone(), message: "Unterminated delimiter for here document".into() })?.bytes
			}
			_ => {
				if src.get(self.pos) == Some(&b'\\') {
					self.advance(self.pos + 1);
					kind = HereKind::Literal;
				}
				if space_before_marker {
					return Err(LexError { location: opening, message: "Use of bare << to mean <<\"\" is forbidden".into() });
				}
				let start = self.pos;
				while let Some(len) = ident_unit(src, self.pos, self.utf8, true) { self.advance(self.pos + len); }
				if start == self.pos {
					return Err(LexError { location: opening, message: "Use of bare << to mean <<\"\" is forbidden".into() });
				}
				Cow::Borrowed(&src[start..self.pos])
			}
		};
		let from = line_end(src, self.pos);
		let local_newline = from > self.pos && src.get(from - 1) == Some(&b'\n');
		let external = if self.here_skip.is_none() && !local_newline { self.external_here } else { None };
		let (src, mut skip) = external.map_or(
			(src, self.here_skip.unwrap_or(HereSkip { from, to: from, lines: 0 })),
			|tail| (tail.source, tail.skip),
		);
		if !local_newline && external.is_none() && self.here_skip.is_none() {
			return Err(missing_heredoc(opening, marker.as_ref()));
		}
		let start = skip.to;
		let mut line = start;
		let mut body_lines = 0u32;
		while line < src.len() || line == src.len() && marker.is_empty() && line > start && src[line - 1] == b'\n' {
			let end = line_end(src, line);
			let text = without_eol(&src[line..end]);
			let indent_len = text.strip_suffix(marker.as_ref()).filter(|prefix| if indented {
				prefix.iter().all(|&b| matches!(b, b' ' | b'\t'))
			} else { prefix.is_empty() }).map(<[u8]>::len);
			if let Some(indent_len) = indent_len {
				let indent = &text[..indent_len];
				let mut bytes = Vec::with_capacity(line - start);
				for (i, raw) in src[start..line].split_inclusive(|&b| b == b'\n').enumerate() {
					if let Some(content) = raw.strip_prefix(indent) {
						append_line(&mut bytes, content);
					} else if without_eol(raw).is_empty() {
						append_line(&mut bytes, raw);
					} else {
						return Err(LexError { location: opening, message: format!("Indentation on line {} of here-doc doesn't match delimiter", i + 1) });
					}
				}
				let location = Location { file: opening.file, line: opening.line.saturating_add(1).saturating_add(skip.lines) };
				let delimiter_line = u32::from(end > line && src.get(end - 1) == Some(&b'\n'));
				skip.to = end;
				skip.lines = skip.lines.saturating_add(body_lines).saturating_add(delimiter_line);
				if let Some(tail) = &mut self.external_here && external.is_some() {
					tail.skip = skip;
				} else {
					self.here_skip = Some(skip);
				}
				return Ok(HereDoc { location, bytes, kind });
			}
			line = end;
			body_lines = body_lines.saturating_add(1);
		}
		Err(missing_heredoc(opening, marker.as_ref()))
	}

	/// Consume a format body beginning on the next line, leaving the cursor after its dot.
	pub fn format(&mut self) -> Result<&'a [u8], LexError> {
		let src = self.source;
		let start = line_end(src, self.pos);
		let mut line = start;
		// perlform: an argument line opening with `{` extends to the matching `}`, so lines
		// inside it (even a nested format's `.`) do not end this format.
		let mut arguments_next = false;
		while line < src.len() {
			let end = line_end(src, line);
			let text = without_eol(&src[line..end]);
			if text == b"." {
				self.advance(end);
				return Ok(&src[start..line]);
			}
			if arguments_next {
				arguments_next = false;
				let code = text.trim_ascii_start();
				if code.starts_with(b"{") && let Some(close) = matching_brace(src, line + text.len() - code.len()) {
					line = line_end(src, close);
					continue;
				}
			} else if !text.starts_with(b"#") {
				arguments_next = text.iter().any(|&b| b == b'@' || b == b'^');
			}
			line = end;
		}
		Err(LexError { location: self.location(), message: "Format not terminated".into() })
	}
}

/// Byte position of the `}` closing the brace at `open`, skipping backslash escapes.
fn matching_brace(src: &[u8], open: usize) -> Option<usize> {
	let mut depth = 0usize;
	let mut at = open;
	while let Some(&b) = src.get(at) {
		match b {
			b'\\' => at += 1,
			b'{' => depth += 1,
			b'}' => {
				depth -= 1;
				if depth == 0 { return Some(at); }
			}
			_ => {}
		}
		at += 1;
	}
	None
}

fn missing_heredoc(location: Location, marker: &[u8]) -> LexError {
	LexError { location, message: format!("Can't find string terminator \"{}\" anywhere before EOF", String::from_utf8_lossy(marker)) }
}

/// End of a qualified identifier, including initial and final package separators.
pub(super) fn name_end(src: &[u8], mut at: usize, utf8: bool) -> Option<usize> {
	let start = at;
	while src.get(at..).is_some_and(|s| s.starts_with(b"::")) {
		at += 2;
	}
	// toke.c parse_ident: a segment after `::` may begin with a digit (`No::1Such`).
	let mut after_separator = false;
	while let Some(len) = ident_unit(src, at, utf8, false)
		.or_else(|| (after_separator && src.get(at).is_some_and(u8::is_ascii_digit)).then_some(1))
	{
		at += len;
		while let Some(len) = ident_unit(src, at, utf8, true) { at += len; }
		if src.get(at..).is_some_and(|s| s.starts_with(b"::")) {
			while src.get(at..).is_some_and(|s| s.starts_with(b"::")) { at += 2; }
			after_separator = true;
		} else if src.get(at) == Some(&b'\'') && ident_unit(src, at + 1, utf8, false).is_some() {
			at += 1;
			after_separator = false;
		} else {
			break;
		}
	}
	(at > start).then_some(at)
}

/// Width of an identifier character under the current source encoding.
pub(super) fn ident_unit(src: &[u8], at: usize, utf8: bool, continuation: bool) -> Option<usize> {
	match *src.get(at)? {
		b'A'..=b'Z' | b'a'..=b'z' | b'_' => Some(1),
		b'0'..=b'9' if continuation => Some(1),
		128..=255 if utf8 => {
			let (cp, len) = unit(src, at, true)?;
			if len == 1 { return None; }
			let ch = char::from_u32(cp)?;
			(if continuation { unicode_ident::is_xid_continue(ch) } else { unicode_ident::is_xid_start(ch) }).then_some(len)
		}
		_ => None,
	}
}

/// Decodes a single source character, falling back to a byte for malformed UTF-8.
pub(super) fn unit(src: &[u8], at: usize, utf8: bool) -> Option<(u32, usize)> {
	let byte = *src.get(at)?;
	let width = if utf8 { match byte { 0xc2..=0xdf => 2, 0xe0..=0xef => 3, 0xf0..=0xf4 => 4, _ => 1 } } else { 1 };
	if width > 1 && let Some(ch) = src.get(at..at + width).and_then(|s| std::str::from_utf8(s).ok()).and_then(|s| s.chars().next()) {
		Some((u32::from(ch), width))
	} else if utf8 && let Some(extended) = extended_unit(src, at) {
		Some(extended)
	} else {
		Some((u32::from(byte), 1))
	}
}

/// Perl's lax/extended UTF-8 (surrogates, code points above U+10FFFF, 0xF8..0xFF lead bytes)
/// that `str` rejects; `None` for malformed sequences or values beyond 32 bits.
fn extended_unit(src: &[u8], at: usize) -> Option<(u32, usize)> {
	let lead = *src.get(at)?;
	let (width, bits) = match lead {
		0xc2..=0xdf => (2, lead & 0x1f), 0xe0..=0xef => (3, lead & 0x0f), 0xf0..=0xf7 => (4, lead & 0x07),
		0xf8..=0xfb => (5, lead & 0x03), 0xfc..=0xfd => (6, lead & 0x01), 0xfe => (7, 0), 0xff => (13, 0),
		_ => return None,
	};
	let tail = src.get(at + 1..at + width)?;
	if !tail.iter().all(|&b| b & 0xc0 == 0x80) { return None; }
	let value = tail.iter().try_fold(u64::from(bits), |value, &b| Some((value << 6) | u64::from(b & 0x3f)).filter(|v| *v <= u64::from(u32::MAX)))?;
	Some((u32::try_from(value).ok()?, width))
}

/// Find the first byte of a name after a sigil, ignoring whitespace and embedded NUL.
pub(super) fn sigil_name_start(src: &[u8], mut at: usize) -> usize {
	while src.get(at).is_some_and(|&b| b == 0 || b.is_ascii_whitespace()) { at += 1; }
	at
}

/// End of a variable name, after its sigil (not including its braces).
pub(super) fn variable_end(src: &[u8], at: usize, utf8: bool, sigil: u8, braced: bool) -> Option<usize> {
	let first = *src.get(at)?;
	// toke.c's VALID_LEN_ONE_IDENT: outside `use utf8`, any graphic Latin-1 byte except the
	// soft hyphen names a length-1 variable.
	if !utf8 && first >= 0xa1 && first != 0xad && matches!(sigil, b'$' | b'@' | b'%' | b'*' | b'&') {
		return Some(at + 1);
	}
	if first.is_ascii_digit() {
		return Some(at + src[at..].iter().take_while(|b| b.is_ascii_digit()).count());
	}
	if first == b'^' {
		let after = src.get(at + 1).copied();
		if after.is_some_and(|b| (b'@'..=b'_').contains(&b) || b == b'?') {
			if braced { return Some(name_end(src, at + 1, utf8).unwrap_or(at + 2)); }
			return Some(at + 2);
		}
		if !braced && matches!(sigil, b'$' | b'@' | b'%' | b'*') { return Some(at + 1); }
		return None;
	}
	if let Some(end) = name_end(src, at, utf8) { return Some(end); }
	if first == b'\'' && let Some(end) = name_end(src, at + 1, utf8) { return Some(end); }
	if first.is_ascii_punctuation() && first != b'{' && (!braced || first != b'}') && matches!(sigil, b'$' | b'@' | b'%' | b'*') {
		return Some(at + 1);
	}
	None
}

/// End of a physical line, including a final newline when present.
pub(super) fn line_end(src: &[u8], at: usize) -> usize {
	src.get(at..).and_then(|tail| tail.iter().position(|&b| b == b'\n')).map_or(src.len(), |i| at + i + 1)
}

fn normalize_lines(bytes: Cow<'_, [u8]>) -> Cow<'_, [u8]> {
	if !bytes.windows(2).any(|pair| pair == b"\r\n") { return bytes; }
	let mut output = Vec::with_capacity(bytes.len());
	for line in bytes.split_inclusive(|&b| b == b'\n') { append_line(&mut output, line); }
	Cow::Owned(output)
}

fn append_line(bytes: &mut Vec<u8>, line: &[u8]) {
	if let Some(raw) = line.strip_suffix(b"\r\n") {
		bytes.extend_from_slice(raw);
		bytes.push(b'\n');
	} else {
		bytes.extend_from_slice(line);
	}
}

fn without_eol(src: &[u8]) -> &[u8] {
	let src = src.strip_suffix(b"\n").unwrap_or(src);
	src.strip_suffix(b"\r").unwrap_or(src)
}

/// `# line NNN ["file"|file]` per perlsyn "Plain Old Comments (Not!)"; anything else is a comment.
fn line_directive(comment: &[u8]) -> Option<(u32, Option<Rc<str>>)> {
	let tab_space = |b: &u8| matches!(b, b' ' | b'\t');
	let rest = comment[comment.iter().take_while(|b| tab_space(b)).count()..].strip_prefix(b"line")?;
	if !rest.first().is_some_and(tab_space) { return None; }
	let rest = &rest[rest.iter().take_while(|b| tab_space(b)).count()..];
	let n = rest.iter().take_while(|b| b.is_ascii_digit()).count();
	if n == 0 { return None; }
	let line = std::str::from_utf8(&rest[..n]).ok()?.parse().ok()?;
	let rest = &rest[n..];
	if !matches!(rest.first(), None | Some(b' ' | b'\t' | b'\r' | b'\n')) { return None; }
	let rest = &rest[rest.iter().take_while(|b| tab_space(b)).count()..];
	let (file, tail) = if rest.first() == Some(&b'"') && let Some(close) = rest[1..].iter().position(|&b| b == b'"') {
		(&rest[1..=close], &rest[close + 2..])
	} else {
		let len = rest.iter().take_while(|b| !b.is_ascii_whitespace()).count();
		(&rest[..len], &rest[len..])
	};
	if !tail.iter().all(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\x0c' | b'\n')) { return None; }
	let file = (!file.is_empty()).then(|| Rc::from(String::from_utf8_lossy(file).as_ref()));
	Some((line, file))
}

fn apostrophe_quote(src: &[u8], start: usize) -> Option<usize> {
	let remaining = src.get(start..)?;
	for name in [b"q'".as_slice(), b"qq'", b"qw'", b"qx'", b"qr'", b"m'", b"s'", b"tr'", b"y'"] {
		if remaining.starts_with(name) { return Some(start + name.len() - 1); }
	}
	None
}

fn regex_meta(cp: u32) -> bool {
	matches!(cp, 36 | 40 | 41 | 42 | 43 | 46 | 63 | 91 | 92 | 93 | 94 | 123 | 124 | 125)
}

fn version_end(src: &[u8], start: usize, utf8: bool) -> Option<usize> {
	let mut at = start + 1;
	if !src.get(at).is_some_and(u8::is_ascii_digit) { return None; }
	while src.get(at).is_some_and(|b| b.is_ascii_digit() || *b == b'_') { at += 1; }
	// `v10::foo` is a package name, not a version string.
	if ident_unit(src, at, utf8, true).is_some() || src[at..].starts_with(b"::") { return None; }
	while src.get(at) == Some(&b'.') && src.get(at + 1).is_some_and(u8::is_ascii_digit) {
		at += 1;
		while src.get(at).is_some_and(|b| b.is_ascii_digit() || *b == b'_') { at += 1; }
	}
	Some(at)
}

fn number_end(src: &[u8], start: usize) -> usize {
	let (digits_start, base) = match src.get(start..start + 2) {
		Some(b"0x" | b"0X") => (start + 2, 16),
		Some(b"0b" | b"0B") => (start + 2, 2),
		Some(b"0o" | b"0O") => (start + 2, 8),
		Some([b'0', b'0'..=b'9' | b'_']) => (start, 8),
		_ => (start, 10),
	};
	let digits = |b: &u8| *b == b'_' || if base == 16 { b.is_ascii_hexdigit() } else { b.is_ascii_digit() };
	let mut at = digits_start;
	while src.get(at).is_some_and(digits) { at += 1; }
	let integer_end = at;
	let mut dots = 0;
	while src.get(at) == Some(&b'.') && src.get(at + 1) != Some(&b'.')
		&& (dots == 0 || base == 10 && src.get(at + 1).is_some_and(digits))
	{
		dots += 1;
		at += 1;
		while src.get(at).is_some_and(digits) { at += 1; }
	}
	// `0xp3`: no digits, so no hexadecimal float exponent either (the `p3` is a separate word).
	if base != 10 && at == digits_start { return integer_end; }
	let exponent = if base == 10 { b"eE" } else { b"pP" };
	if dots <= 1 && src.get(at).is_some_and(|b| exponent.contains(b)) {
		let mut end = at + 1;
		if matches!(src.get(end), Some(b'+' | b'-')) { end += 1; }
		if src.get(end).is_some_and(u8::is_ascii_digit) {
			at = end + 1;
			while src.get(at).is_some_and(|b| b.is_ascii_digit() || *b == b'_') { at += 1; }
			return at;
		}
	}
	if base == 10 { at } else { integer_end }
}
