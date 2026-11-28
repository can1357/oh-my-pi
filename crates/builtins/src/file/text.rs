//! Text classification: character-set detection (`encoding.c`) and the
//! content tests libmagic runs in C rather than through magic rules
//! (`is_tar.c`, `is_json.c`, `is_csv.c`), ported from file 5.41.

use xutf::DecodeError;

/// A character class of `text_chars`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Class {
	/// Never appears in text.
	F,
	/// Plain ASCII text.
	T,
	/// ISO-8859 text.
	I,
	/// Non-ISO extended ASCII (Mac, IBM PC).
	X,
}

/// `text_chars`: printing ASCII plus BEL, BS, HT, LF, FF, CR, ESC and NEL are
/// text; 0xA0 and up are ISO-8859; the rest of the high half is extended.
const fn class(c: u8) -> Class {
	match c {
		7..=13 | 27 | 0x20..=0x7e | 0x85 => Class::T,
		0x80..=0x9f => Class::X,
		0xa0..=0xff => Class::I,
		_ => Class::F,
	}
}

/// What a buffer's bytes are, as `file_encoding` reports it.
pub(super) struct Encoding {
	/// The description's lead: `ASCII`, `Unicode text, UTF-8`, …
	pub code:  &'static str,
	/// The `charset=` value.
	pub mime:  &'static str,
	/// Whether the buffer is text at all.
	pub text:  bool,
	/// The decoded characters, one per code point.
	pub chars: Vec<u32>,
}

/// Decides whether `buf` looks like UTF-8: -1 invalid, 0 valid but with odd
/// control characters, 1 seven-bit text, 2 UTF-8 with multi-byte sequences.
/// Decoded characters are appended to `out`.
pub(super) fn looks_utf8(buf: &[u8], out: Option<&mut Vec<u32>>) -> i32 {
	let (valid, invalid) = match xutf::decode(buf) {
		Ok(text) | Err(DecodeError::Incomplete { valid_prefix: text, .. }) => (text, false),
		Err(DecodeError::Invalid { valid_prefix, .. }) => (valid_prefix, true),
	};
	if let Some(out) = out {
		out.extend(valid.chars().map(u32::from));
	}
	if invalid {
		-1
	} else if valid.bytes().any(|b| b.is_ascii() && class(b) != Class::T) {
		0
	} else if valid.is_ascii() {
		1
	} else {
		2
	}
}

/// Whether every byte of `buf` passes `accept`, widening them into `out`.
fn looks(buf: &[u8], out: &mut Vec<u32>, accept: impl Fn(Class) -> bool) -> bool {
	out.clear();
	for &c in buf {
		if !accept(class(c)) {
			return false;
		}
		out.push(u32::from(c));
	}
	true
}

/// UTF-16 with a byte-order mark: 1 little-endian, 2 big-endian, 0 neither.
fn looks_ucs16(buf: &[u8], out: &mut Vec<u32>) -> u8 {
	let big = match buf {
		[0xff, 0xfe, ..] => false,
		[0xfe, 0xff, ..] => true,
		_ => return 0,
	};
	out.clear();
	for pair in buf[2..].chunks_exact(2) {
		let unit = if big { u16::from_be_bytes([pair[0], pair[1]]) } else { u16::from_le_bytes([pair[0], pair[1]]) };
		if unit == 0xfffe || (unit < 128 && class(unit as u8) != Class::T) {
			return 0;
		}
		out.push(u32::from(unit));
	}
	1 + u8::from(big)
}

/// UTF-32 with a byte-order mark: 1 little-endian, 2 big-endian, 0 neither.
fn looks_ucs32(buf: &[u8], out: &mut Vec<u32>) -> u8 {
	let big = match buf {
		[0xff, 0xfe, 0, 0, ..] => false,
		[0, 0, 0xfe, 0xff, ..] => true,
		_ => return 0,
	};
	out.clear();
	for quad in buf[4..].chunks_exact(4) {
		let raw = [quad[0], quad[1], quad[2], quad[3]];
		let unit = if big { u32::from_be_bytes(raw) } else { u32::from_le_bytes(raw) };
		if unit == 0xfffe || (unit < 128 && class(unit as u8) != Class::T) {
			return 0;
		}
		out.push(unit);
	}
	1 + u8::from(big)
}

/// The EBCDIC-to-ASCII table of the POSIX `dd` rationale.
#[rustfmt::skip]
const EBCDIC_TO_ASCII: [u8; 256] = [
	  0,   1,   2,   3, 156,   9, 134, 127, 151, 141, 142,  11,  12,  13,  14,  15,
	 16,  17,  18,  19, 157, 133,   8, 135,  24,  25, 146, 143,  28,  29,  30,  31,
	128, 129, 130, 131, 132,  10,  23,  27, 136, 137, 138, 139, 140,   5,   6,   7,
	144, 145,  22, 147, 148, 149, 150,   4, 152, 153, 154, 155,  20,  21, 158,  26,
	b' ', 160, 161, 162, 163, 164, 165, 166, 167, 168, 213, b'.', b'<', b'(', b'+', b'|',
	b'&', 169, 170, 171, 172, 173, 174, 175, 176, 177, b'!', b'$', b'*', b')', b';', b'~',
	b'-', b'/', 178, 179, 180, 181, 182, 183, 184, 185, 203, b',', b'%', b'_', b'>', b'?',
	186, 187, 188, 189, 190, 191, 192, 193, 194, b'`', b':', b'#', b'@', b'\'', b'=', b'"',
	195, b'a', b'b', b'c', b'd', b'e', b'f', b'g', b'h', b'i', 196, 197, 198, 199, 200, 201,
	202, b'j', b'k', b'l', b'm', b'n', b'o', b'p', b'q', b'r', b'^', 204, 205, 206, 207, 208,
	209, 229, b's', b't', b'u', b'v', b'w', b'x', b'y', b'z', 210, 211, 212, b'[', 214, 215,
	216, 217, 218, 219, 220, 221, 222, 223, 224, 225, 226, 227, 228, b']', 230, 231,
	b'{', b'A', b'B', b'C', b'D', b'E', b'F', b'G', b'H', b'I', 232, 233, 234, 235, 236, 237,
	b'}', b'J', b'K', b'L', b'M', b'N', b'O', b'P', b'Q', b'R', 238, 239, 240, 241, 242, 243,
	b'\\', 159, b'S', b'T', b'U', b'V', b'W', b'X', b'Y', b'Z', 244, 245, 246, 247, 248, 249,
	b'0', b'1', b'2', b'3', b'4', b'5', b'6', b'7', b'8', b'9', 250, 251, 252, 253, 254, 255,
];

/// `file_encoding`: identifies the character set of the first `max` bytes of
/// `buf` and decodes them.
pub(super) fn detect(buf: &[u8], max: usize) -> Encoding {
	let buf = &buf[..buf.len().min(max)];
	let mut chars = Vec::with_capacity(buf.len());
	let found = |code, mime, chars| Encoding { code, mime, text: true, chars };

	if looks(buf, &mut chars, |class| class == Class::T) {
		// UTF-7 announces itself with an encoded byte-order mark.
		if buf.len() > 4 && buf.starts_with(b"+/v") && matches!(buf[3], b'8' | b'9' | b'+' | b'/') {
			return found("Unicode text, UTF-7", "utf-7", Vec::new());
		}
		return found("ASCII", "us-ascii", chars);
	}
	chars.clear();
	if buf.len() > 3 && buf.starts_with(&[0xef, 0xbb, 0xbf]) && looks_utf8(&buf[3..], Some(&mut chars)) > 0 {
		return found("Unicode text, UTF-8 (with BOM)", "utf-8", chars);
	}
	chars.clear();
	if looks_utf8(buf, Some(&mut chars)) > 1 {
		return found("Unicode text, UTF-8", "utf-8", chars);
	}
	match looks_ucs32(buf, &mut chars) {
		1 => return found("Unicode text, UTF-32, little-endian", "utf-32le", chars),
		2 => return found("Unicode text, UTF-32, big-endian", "utf-32be", chars),
		_ => {},
	}
	match looks_ucs16(buf, &mut chars) {
		1 => return found("Unicode text, UTF-16, little-endian", "utf-16le", chars),
		2 => return found("Unicode text, UTF-16, big-endian", "utf-16be", chars),
		_ => {},
	}
	if looks(buf, &mut chars, |class| matches!(class, Class::T | Class::I)) {
		return found("ISO-8859", "iso-8859-1", chars);
	}
	if looks(buf, &mut chars, |class| class != Class::F) {
		return found("Non-ISO extended-ASCII", "unknown-8bit", chars);
	}
	let translated: Vec<u8> = buf.iter().map(|&c| EBCDIC_TO_ASCII[usize::from(c)]).collect();
	if looks(&translated, &mut chars, |class| class == Class::T) {
		return found("EBCDIC", "ebcdic", chars);
	}
	if looks(&translated, &mut chars, |class| matches!(class, Class::T | Class::I)) {
		return found("International EBCDIC", "ebcdic", chars);
	}
	chars.clear();
	Encoding { code: "unknown", mime: "binary", text: false, chars }
}

/// `encode_utf8`: the decoded characters as UTF-8, using the original
/// six-byte scheme for values past the Unicode range.
pub(super) fn encode_utf8(chars: &[u32]) -> Option<Vec<u8>> {
	let mut out = Vec::with_capacity(chars.len() + chars.len() / 8);
	for &c in chars {
		let extra = match c {
			0..=0x7f => {
				out.push(c as u8);
				continue;
			},
			0x80..=0x7ff => {
				out.push((c >> 6) as u8 + 0xc0);
				1
			},
			0x800..=0xffff => {
				out.push((c >> 12) as u8 + 0xe0);
				2
			},
			0x1_0000..=0x1f_ffff => {
				out.push((c >> 18) as u8 + 0xf0);
				3
			},
			0x20_0000..=0x3ff_ffff => {
				out.push((c >> 24) as u8 + 0xf8);
				4
			},
			0x400_0000..=0x7fff_ffff => {
				out.push((c >> 30) as u8 + 0xfc);
				5
			},
			_ => return None,
		};
		for shift in (0..extra).rev() {
			out.push(((c >> (6 * shift)) & 0x3f) as u8 + 0x80);
		}
	}
	Some(out)
}

/// The line structure `file_ascmagic_with_encoding` reports.
#[derive(Default)]
pub(super) struct Lines {
	pub crlf:       usize,
	pub cr:         usize,
	pub lf:         usize,
	pub nel:        usize,
	/// The longest line past `MAXLINELEN`, 0 when none is.
	pub longest:    usize,
	pub escapes:    bool,
	pub backspace:  bool,
}

/// Counts line terminators and the other text properties of `chars`.
/// `truncated` says the data may have been cut, so a final CR could have been
/// half of a CRLF.
pub(super) fn scan_lines(chars: &[u32], truncated: bool) -> Lines {
	const MAX_LINE: usize = 300;
	let mut lines = Lines::default();
	let mut seen_cr = false;
	// `(size_t)-1` until a line ends; the arithmetic below wraps like C's.
	let mut last_line_end = usize::MAX;
	for (i, &c) in chars.iter().enumerate() {
		if c == u32::from(b'\n') {
			if seen_cr {
				lines.crlf += 1;
			} else {
				lines.lf += 1;
			}
			last_line_end = i;
		} else if seen_cr {
			lines.cr += 1;
		}
		seen_cr = c == u32::from(b'\r');
		if seen_cr {
			last_line_end = i;
		}
		if c == 0x85 {
			lines.nel += 1;
			last_line_end = i;
		}
		if i > last_line_end.wrapping_add(MAX_LINE) {
			lines.longest = lines.longest.max(i.wrapping_sub(last_line_end));
		}
		lines.escapes |= c == 0x1b;
		lines.backspace |= c == 0x08;
	}
	if seen_cr && !truncated {
		lines.cr += 1;
	}
	lines
}

const fn is_c_space(c: u8) -> bool {
	matches!(c, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r')
}

/// `from_oct`: a tar header's octal field, -1 when invalid.
fn from_octal(field: &[u8]) -> i32 {
	let mut i = 0;
	while i < field.len() && is_c_space(field[i]) {
		i += 1;
	}
	if i == field.len() {
		return -1;
	}
	let mut value = 0i32;
	while i < field.len() && (b'0'..=b'7').contains(&field[i]) {
		value = (value << 3) | i32::from(field[i] - b'0');
		i += 1;
	}
	if i < field.len() && field[i] != 0 && !is_c_space(field[i]) {
		return -1;
	}
	value
}

/// `is_tar`: the kind of tar archive `buf` starts, by its header checksum.
pub(super) fn tar_kind(buf: &[u8]) -> Option<&'static str> {
	const CHECKSUM: std::ops::Range<usize> = 148..156;
	let header = buf.get(..512)?;
	let recorded = from_octal(&header[CHECKSUM]);
	// The checksum field itself counts as blanks.
	let mut sum: i32 = header.iter().map(|&c| i32::from(c)).sum();
	sum -= header[CHECKSUM].iter().map(|&c| i32::from(c)).sum::<i32>();
	sum += i32::from(b' ') * 8;
	if sum != recorded {
		return None;
	}
	let magic = &header[257..265];
	Some(if magic == b"ustar  \0" {
		"POSIX tar archive (GNU)"
	} else if magic.starts_with(b"ustar\0") {
		"POSIX tar archive"
	} else {
		"tar archive"
	})
}

/// `csv_parse`: whether `buf` holds lines with a constant, non-zero number
/// of comma-separated fields.
pub(super) fn is_csv(buf: &[u8]) -> bool {
	const LINES: usize = 10;
	let (mut fields, mut expected, mut lines) = (0usize, 0usize, 0usize);
	let mut i = 0;
	while i < buf.len() {
		let c = buf[i];
		i += 1;
		match c {
			b'"' => {
				// To the closing quote; a doubled quote is an escaped one.
				let mut quote = false;
				loop {
					let Some(&c) = buf.get(i) else { break };
					if c != b'"' {
						if quote {
							break;
						}
						i += 1;
						continue;
					}
					i += 1;
					quote = !quote;
				}
			},
			b',' => fields += 1,
			b'\n' => {
				lines += 1;
				if lines == LINES {
					return expected != 0 && expected == fields;
				}
				if expected == 0 {
					if fields == 0 {
						return false;
					}
					expected = fields;
				} else if expected != fields {
					return false;
				}
				fields = 0;
			},
			_ => {},
		}
	}
	expected != 0 && lines > 2
}

/// `is_json.c`'s recursive-descent recogniser, quirks included: constants
/// are matched by length alone, and anything may follow the first value.
struct Json<'b> {
	buf:      &'b [u8],
	at:       usize,
	/// Arrays closed and objects parsed so far.
	compound: usize,
}

impl Json<'_> {
	fn peek(&self) -> Option<u8> {
		self.buf.get(self.at).copied()
	}

	fn skip_space(&mut self) {
		while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
			self.at += 1;
		}
	}

	fn string(&mut self) -> bool {
		while let Some(c) = self.peek() {
			self.at += 1;
			match c {
				0 => return false,
				b'\\' => {
					let Some(escaped) = self.peek() else { return false };
					self.at += 1;
					match escaped {
						b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => {},
						b'u' => {
							if self.buf.len() - self.at < 4 {
								self.at = self.buf.len();
								return false;
							}
							for _ in 0..4 {
								let digit = self.buf[self.at];
								self.at += 1;
								if !digit.is_ascii_hexdigit() {
									return false;
								}
							}
						},
						_ => return false,
					}
				},
				b'"' => return true,
				_ => {},
			}
		}
		false
	}

	fn array(&mut self, level: usize) -> bool {
		while self.at < self.buf.len() {
			if self.buf[self.at] != b']' {
				if !self.value(level + 1) {
					return false;
				}
				match self.peek() {
					Some(b',') => {
						self.at += 1;
						continue;
					},
					Some(b']') => {},
					_ => return false,
				}
			}
			self.compound += 1;
			self.at += 1;
			return true;
		}
		false
	}

	fn object(&mut self, level: usize) -> bool {
		while self.at < self.buf.len() {
			self.skip_space();
			let Some(c) = self.peek() else { return false };
			if c == b'}' {
				self.at += 1;
				return true;
			}
			self.at += 1;
			if c != b'"' || !self.string() {
				return false;
			}
			self.skip_space();
			let Some(c) = self.peek() else { return false };
			self.at += 1;
			if c != b':' || !self.value(level + 1) {
				return false;
			}
			match self.peek() {
				Some(b',') => self.at += 1,
				Some(b'}') => {
					self.at += 1;
					return true;
				},
				_ => return false,
			}
		}
		false
	}

	fn number(&mut self) -> bool {
		let mut got = false;
		if self.peek().is_none() {
			return false;
		}
		if self.peek() == Some(b'-') {
			self.at += 1;
		}
		let digits = |json: &mut Self, got: &mut bool| {
			while json.peek().is_some_and(|c| c.is_ascii_digit()) {
				json.at += 1;
				*got = true;
			}
		};
		digits(self, &mut got);
		if self.peek().is_none() {
			return got;
		}
		if self.peek() == Some(b'.') {
			self.at += 1;
		}
		digits(self, &mut got);
		if self.peek().is_none() {
			return got;
		}
		if got && matches!(self.peek(), Some(b'e' | b'E')) {
			self.at += 1;
			got = false;
			if self.peek().is_none() {
				return got;
			}
			if matches!(self.peek(), Some(b'+' | b'-')) {
				self.at += 1;
			}
			digits(self, &mut got);
		}
		got
	}

	/// `json_parse_const`: consumes the rest of a constant of `len` letters
	/// without comparing them.
	fn constant(&mut self, len: usize) -> bool {
		let rest = len - 1;
		// The C loop only finishes when a byte follows the constant.
		if self.buf.len() - self.at <= rest {
			self.at = self.buf.len();
			return false;
		}
		self.at += rest;
		true
	}

	fn value(&mut self, level: usize) -> bool {
		self.skip_space();
		let Some(c) = self.peek() else { return false };
		if level > 20 {
			return false;
		}
		self.at += 1;
		let matched = match c {
			b'"' => self.string(),
			b'[' => self.array(level + 1),
			b'{' => {
				let parsed = self.object(level + 1);
				self.compound += usize::from(parsed);
				parsed
			},
			b't' | b'n' => self.constant(4),
			b'f' => self.constant(5),
			_ => {
				self.at -= 1;
				self.number()
			},
		};
		self.skip_space();
		matched
	}
}

/// `file_is_json`: whether `buf` starts with a JSON array or object.
pub(super) fn is_json(buf: &[u8]) -> bool {
	let mut json = Json { buf, at: 0, compound: 0 };
	json.value(0) && json.compound != 0
}
