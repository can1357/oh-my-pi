use std::{borrow::Cow, io};

use super::PStr;

/// File access and creation flags. Duplicating a descriptor never creates or truncates it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::perl) struct OpenMode {
	/// Permit input.
	pub read: bool,
	/// Permit output.
	pub write: bool,
	/// Each write goes at end of file.
	pub append: bool,
	/// Discard existing contents on open.
	pub truncate: bool,
	/// Create a missing file.
	pub create: bool,
}

impl OpenMode {
	/// Read-only mode, without create or truncate.
	pub(super) const READ: Self = Self { read: true, write: false, append: false, truncate: false, create: false };
	/// Write-only mode, without create or truncate.
	pub(super) const WRITE: Self = Self { read: false, write: true, append: false, truncate: false, create: false };

	const fn file(read: bool, output: u8) -> Self {
		Self { read, write: true, append: output == 2, truncate: output == 1, create: output != 0 }
	}
}

/// How to interpret the operands that follow a three-argument `open` mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::perl) enum ModeKind {
	/// A literal path or a reference to a scalar.
	File,
	/// Read the child's stdout (`-|`).
	PipeRead,
	/// Write the child's stdin (`|-`).
	PipeWrite,
	/// Resolve the operand as a handle name or descriptor number.
	Dup {
		/// `&=` reuses the descriptor; `&` duplicates it.
		same: bool,
	},
}

/// A two-argument `open` operand after trimming and extracting mode syntax.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::perl) enum TwoArgTarget {
	/// An ordinary file path.
	Path(Vec<u8>),
	/// A pipe's shell command line, or `-` for Perl's forking-open special form.
	Command(Vec<u8>),
	/// A handle name or numeric descriptor, resolved in the interpreter.
	Dup {
		/// The uninterpreted destination name or descriptor digits.
		name: Vec<u8>,
		/// Whether the `&=` form requested the same descriptor.
		same: bool,
	},
	/// `-` / `<-` for stdin, `>-` / `>>-` for stdout.
	Std(u8),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Codec {
	#[default]
	Plain,
	Utf8Checked,
	Utf8,
	Latin1,
	Cp1047,
	Cp1252,
}

impl Codec {
	/// Byte-to-code-point table of a single-byte code page other than Latin-1.
	fn table(self) -> Option<&'static [u16; 256]> {
		match self {
			Self::Cp1047 => Some(&super::codepage::CP1047),
			Self::Cp1252 => Some(&super::codepage::CP1252),
			_ => None,
		}
	}
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum BufferStyle {
	#[default]
	Perlio,
	Unix,
	Stdio,
	Mmap,
}

/// The effective PerlIO stack above the buffered descriptor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::perl) struct Layers {
	/// Whether to translate physical CRLF to a logical newline.
	crlf: bool,
	utf8: bool,
	codec: Codec,
	outer_crlf: bool,
	buffer: BufferStyle,
	explicit: u8,
}

const CRLF: u8 = 1;
const UTF8: u8 = 2;
const CODEC: u8 = 4;
const BUFFER: u8 = 8;

impl Default for Layers {
	fn default() -> Self {
		Self { crlf: cfg!(windows), utf8: false, codec: Codec::Plain, outer_crlf: false, buffer: BufferStyle::Perlio, explicit: 0 }
	}
}

impl Layers {
	/// Byte-preserving I/O, including platform newline conventions.
	pub const fn raw() -> Self {
		Self { crlf: false, utf8: false, codec: Codec::Plain, outer_crlf: false, buffer: BufferStyle::Perlio, explicit: CRLF | UTF8 | CODEC }
	}

	/// Parses a layer stack relative to the platform default.
	pub fn parse(spec: &[u8]) -> Result<Self, String> {
		Self::default().apply(spec)
	}

	/// Apply layers relative to an already-open handle.
	pub(super) fn apply(mut self, spec: &[u8]) -> Result<Self, String> {
		let mut spec = spec;
		loop {
			// Layers are separated by colons and/or whitespace; the leading colon is optional.
			let start = spec.iter().position(|&b| b != b':' && !b.is_ascii_whitespace()).unwrap_or(spec.len());
			let rest = &spec[start..];
			let Some(&first) = rest.first() else { break };
			if !first.is_ascii_alphabetic() && first != b'_' {
				return Err(format!(
					"Invalid separator character '{}' in PerlIO layer specification {}", first as char, String::from_utf8_lossy(rest),
				));
			}
			let end = rest.iter().position(|b| !b.is_ascii_alphanumeric() && *b != b'_').unwrap_or(rest.len());
			let (name, tail) = rest.split_at(end);
			let (arg, tail) = if let Some(parenthesized) = tail.strip_prefix(b"(") {
				let mut depth = 1usize;
				let close = parenthesized.iter().position(|&b| {
					match b {
						b'(' => depth += 1,
						b')' => depth -= 1,
						_ => {},
					}
					depth == 0
				});
				let Some(end) = close else {
					return Err(format!("Argument list not closed for PerlIO layer \"{}\"", String::from_utf8_lossy(rest)));
				};
				(Some(trim(&parenthesized[..end])), &parenthesized[end + 1..])
			} else {
				(None, tail)
			};
			match (name, arg) {
				(b"raw", None) => {
					self.crlf = false;
					self.utf8 = false;
					self.codec = Codec::Plain;
					self.outer_crlf = false;
					self.explicit |= CRLF | UTF8 | CODEC;
				},
				(b"unix", None) => { self.buffer = BufferStyle::Unix; self.explicit |= BUFFER; },
				(b"perlio", None) => { self.buffer = BufferStyle::Perlio; self.explicit |= BUFFER; },
				(b"stdio", None) => { self.buffer = BufferStyle::Stdio; self.explicit |= BUFFER; },
				(b"mmap", None) => { self.buffer = BufferStyle::Mmap; self.explicit |= BUFFER; },
				// PerlIO::scalar is the bottom layer of every in-memory handle; naming it changes nothing.
				(b"scalar", None) => {},
				(b"pop", None) => {
					if self.outer_crlf { self.outer_crlf = false; }
					else if self.codec != Codec::Plain { self.codec = Codec::Plain; self.utf8 = false; }
					else if self.crlf { self.crlf = false; }
					else { self.buffer = BufferStyle::Unix; }
					self.explicit |= CRLF | UTF8 | CODEC | BUFFER;
				},
				(b"bytes", None) => {
					self.utf8 = false;
					self.explicit |= UTF8;
				},
				(b"crlf", None) => {
					if self.codec == Codec::Plain { self.crlf = true; }
					else { self.outer_crlf = true; }
					self.explicit |= CRLF;
				},
				(b"utf8", _) => {
					self.utf8 = true;
					self.explicit |= UTF8;
				},
				(b"encoding", Some(name)) => {
					self.codec = if name.eq_ignore_ascii_case(b"utf-8") || name.eq_ignore_ascii_case(b"utf-8-strict") {
						Codec::Utf8Checked
					} else if name.eq_ignore_ascii_case(b"utf8") {
						Codec::Utf8
					} else if name.eq_ignore_ascii_case(b"latin1") || name.eq_ignore_ascii_case(b"iso-8859-1") {
						Codec::Latin1
					} else if name.eq_ignore_ascii_case(b"cp1047") || name.eq_ignore_ascii_case(b"ibm-1047") {
						Codec::Cp1047
					} else if name.eq_ignore_ascii_case(b"cp1252") || name.eq_ignore_ascii_case(b"windows-1252") {
						Codec::Cp1252
					} else {
						return Err(format!("Cannot find encoding \"{}\"", String::from_utf8_lossy(name)));
					};
					self.utf8 = true;
					self.explicit |= UTF8 | CODEC;
				},
				(b"encoding", None) => return Err("Cannot find encoding \"\"".into()),
				_ => return Err(format!("Unknown PerlIO layer \"{}\"", String::from_utf8_lossy(name))),
			}
			spec = tail;
		}
		Ok(self)
	}

	/// A dup inherits the original stack wherever the mode did not override it.
	pub(in crate::perl) fn inherit(mut self, parent: Self) -> Self {
		if self.explicit & CRLF == 0 {
			self.crlf = parent.crlf;
			self.outer_crlf = parent.outer_crlf;
		}
		if self.explicit & UTF8 == 0 {
			self.utf8 = parent.utf8;
		}
		if self.explicit & CODEC == 0 {
			self.codec = parent.codec;
		}
		if self.explicit & BUFFER == 0 { self.buffer = parent.buffer; }
		self
	}

	pub(super) fn crlf(self) -> bool { self.crlf || self.outer_crlf }

	/// An explicit `:perlio` buffer, which delays in-memory writes until a flush.
	pub(super) fn explicit_perlio(self) -> bool { self.explicit & BUFFER != 0 && self.buffer == BufferStyle::Perlio }
	pub(super) fn unbuffered(self) -> bool { self.buffer == BufferStyle::Unix }

	pub(super) fn info(self, mode: OpenMode, scalar: bool, descriptor: Option<i32>) -> Vec<(&'static str, Option<String>, u32)> {
		let mut flags = 0;
		if mode.read { flags |= 0x0400; }
		if mode.write { flags |= 0x0200; }
		if mode.truncate || (mode.create && !mode.append) { flags |= 0x1000; }
		if mode.append { flags |= 0x2000; }
		let std_flags = match descriptor { Some(1) => 0x020000, Some(2) => 0x010000, _ => 0 };
		let mut out = Vec::with_capacity(2 + usize::from(self.crlf) + usize::from(self.outer_crlf) + usize::from(self.codec != Codec::Plain));
		if scalar {
			out.push(("scalar", None, flags | 0x600000));
		} else if self.buffer == BufferStyle::Stdio {
			out.push(("stdio", None, flags | std_flags));
		} else {
			out.push(("unix", None, flags | 0x200000));
			if self.buffer != BufferStyle::Unix { out.push(("perlio", None, flags | std_flags | 0x400000)); }
			if self.buffer == BufferStyle::Mmap { out.push(("mmap", None, flags | 0x400000)); }
		}
		if self.crlf { out.push(("crlf", None, flags | 0x404000)); }
		let encoding = match self.codec {
			Codec::Plain => None, Codec::Utf8Checked => Some("utf-8-strict"),
			Codec::Utf8 => Some("utf8"), Codec::Latin1 => Some("iso-8859-1"),
			Codec::Cp1047 => Some("cp1047"), Codec::Cp1252 => Some("cp1252"),
		};
		if let Some(name) = encoding { out.push(("encoding", Some(name.into()), flags | 0x408000)); }
		if self.outer_crlf { out.push(("crlf", None, flags | 0x404000)); }
		if self.utf8 && let Some((_, _, flags)) = out.last_mut() { *flags |= 0x8000; }
		out
	}

	/// Unbuffered reads must not be used on a UTF-8 flagged stream.
	pub(super) fn sysread_allowed(self) -> bool {
		!self.utf8
	}

	/// Whether physical input uses multibyte characters for `read` and `getc`.
	pub(super) fn unicode_widths(self) -> bool {
		self.utf8 && self.codec != Codec::Latin1 && self.codec.table().is_none()
	}

	/// Decode an input unit and set its Perl UTF-8 flag.
	pub(super) fn decode(self, bytes: Vec<u8>) -> PStr {
		let bytes = match self.codec {
			Codec::Plain | Codec::Utf8 => bytes,
			Codec::Cp1047 | Codec::Cp1252 => {
				let table = self.codec.table().unwrap_or(&super::codepage::CP1252);
				let mut decoded = Vec::with_capacity(bytes.len());
				for &b in &bytes {
					let ch = char::from_u32(u32::from(table[usize::from(b)])).unwrap_or(char::REPLACEMENT_CHARACTER);
					decoded.extend_from_slice(ch.encode_utf8(&mut [0; 4]).as_bytes());
				}
				decoded
			},
			Codec::Latin1 => match latin1_as_utf8(&bytes) {
				Cow::Borrowed(_) => bytes,
				Cow::Owned(encoded) => encoded,
			},
			Codec::Utf8Checked if std::str::from_utf8(&bytes).is_ok() => bytes,
			Codec::Utf8Checked => {
				let mut decoded = Vec::with_capacity(bytes.len());
				for chunk in bytes.utf8_chunks() {
					decoded.extend_from_slice(chunk.valid().as_bytes());
					for &b in chunk.invalid() {
						const HEX: &[u8; 16] = b"0123456789ABCDEF";
						decoded.extend_from_slice(&[b'\\', b'x', HEX[usize::from(b >> 4)], HEX[usize::from(b & 15)]]);
					}
				}
				decoded
			},
		};
		PStr::new(bytes, self.utf8)
	}

	/// Encodes one output string; CRLF conversion happens at the writer to avoid copying.
	pub(super) fn encode<'a>(self, s: &'a PStr) -> (Cow<'a, [u8]>, bool) {
		if let Some(table) = self.codec.table() && self.utf8 {
			let mut encoded = Vec::with_capacity(s.bytes.len());
			for cp in s.chars() {
				match table.iter().position(|&c| u32::from(c) == cp && c != 0xFFFD) {
					Some(byte) => encoded.push(byte as u8),
					None => {
						// Perl's PERLQQ fallback, encoded through the same code page.
						let escape = format!("\\x{{{cp:x}}}");
						encoded.extend(escape.bytes().filter_map(|ascii| table.iter().position(|&c| c == u16::from(ascii)).map(|b| b as u8)));
					},
				}
			}
			return (Cow::Owned(encoded), false);
		}
		if self.codec == Codec::Latin1 && self.utf8 {
			if !s.utf8 || s.bytes.is_ascii() {
				return (Cow::Borrowed(&s.bytes), false);
			}
			let mut encoded = Vec::with_capacity(s.bytes.len());
			for cp in s.chars() {
				if let Ok(byte) = u8::try_from(cp) {
					encoded.push(byte);
				} else {
					use std::io::Write as _;
					let _ = write!(encoded, "\\x{{{cp:x}}}");
				}
			}
			return (Cow::Owned(encoded), false);
		}
		if self.utf8 {
			return (if s.utf8 { Cow::Borrowed(&s.bytes) } else { latin1_as_utf8(&s.bytes) }, false);
		}
		if !s.utf8 || s.bytes.is_ascii() {
			return (Cow::Borrowed(&s.bytes), false);
		}
		// :utf8 can expose malformed input, including overlong encodings.
		// Preserve the original bytes rather than substituting NUL on a raw stream.
		match std::str::from_utf8(&s.bytes).ok().and_then(|valid| valid.chars().map(|c| u8::try_from(u32::from(c)).ok()).collect::<Option<Vec<u8>>>()) {
			Some(bytes) => (Cow::Owned(bytes), false),
			None => (Cow::Borrowed(&s.bytes), true),
		}
	}

	/// Encode the separator in physical file bytes; `None` cannot match.
	pub(super) fn delimiter<'a>(self, sep: &'a PStr) -> io::Result<Option<Cow<'a, [u8]>>> {
		if self.codec == Codec::Latin1 && self.utf8 && sep.utf8 {
			return Ok(sep.downgraded().map(Cow::Owned));
		}
		let (encoded, wide) = self.encode(sep);
		if wide {
			return Err(io::Error::new(io::ErrorKind::InvalidInput, "Wide character in $/"));
		}
		Ok(Some(encoded))
	}
}

fn latin1_as_utf8(bytes: &[u8]) -> Cow<'_, [u8]> {
	if bytes.is_ascii() {
		return Cow::Borrowed(bytes);
	}
	let mut utf8 = Vec::with_capacity(bytes.len());
	for &b in bytes {
		if b < 128 {
			utf8.push(b);
		} else {
			utf8.extend_from_slice(&[0xc0 | (b >> 6), 0x80 | (b & 0x3f)]);
		}
	}
	Cow::Owned(utf8)
}

fn trim_start(bytes: &[u8]) -> &[u8] {
	let start = bytes.iter().position(|&b| !space(b)).unwrap_or(bytes.len());
	&bytes[start..]
}

fn trim(bytes: &[u8]) -> &[u8] {
	let bytes = trim_start(bytes);
	let end = bytes.iter().rposition(|&b| !space(b)).map_or(0, |p| p + 1);
	&bytes[..end]
}

const fn space(b: u8) -> bool {
	b.is_ascii_whitespace() || b == b'\x0b'
}

fn file_prefix(spec: &[u8]) -> Option<(OpenMode, &[u8])> {
	if let Some(rest) = spec.strip_prefix(b"+>>") {
		Some((OpenMode::file(true, 2), rest))
	} else if let Some(rest) = spec.strip_prefix(b"+>") {
		Some((OpenMode::file(true, 1), rest))
	} else if let Some(rest) = spec.strip_prefix(b"+<") {
		Some((OpenMode { write: true, ..OpenMode::READ }, rest))
	} else if let Some(rest) = spec.strip_prefix(b">>") {
		Some((OpenMode::file(false, 2), rest))
	} else if let Some(rest) = spec.strip_prefix(b">") {
		Some((OpenMode::file(false, 1), rest))
	} else {
		spec.strip_prefix(b"<").map(|rest| (OpenMode::READ, rest))
	}
}

fn dup_prefix(spec: &[u8]) -> Option<(bool, &[u8])> {
	let rest = trim_start(spec.strip_prefix(b"&")?);
	Some(match rest.strip_prefix(b"=") {
		Some(rest) => (true, trim_start(rest)),
		None => (false, rest),
	})
}

/// Split a magic open operand into its historical mode and target.
pub(super) fn parse_two_arg(spec: &[u8]) -> Result<(OpenMode, TwoArgTarget, Layers), String> {
	let spec = trim(spec);
	let layers = Layers::default();
	if let Some(command) = spec.strip_prefix(b"|") {
		return Ok((OpenMode::WRITE, TwoArgTarget::Command(trim(command).to_vec()), layers));
	}
	if let Some(command) = spec.strip_suffix(b"|") {
		return Ok((OpenMode::READ, TwoArgTarget::Command(trim(command).to_vec()), layers));
	}
	let (mode, path) = match file_prefix(spec) {
		Some((mode, rest)) => {
			let rest = trim_start(rest);
			if let Some((same, name)) = dup_prefix(rest) {
				let mode = OpenMode { truncate: false, create: false, ..mode };
				return Ok((mode, TwoArgTarget::Dup { name: name.to_vec(), same }, layers));
			}
			(mode, rest)
		},
		None => (OpenMode::READ, spec),
	};
	let target = if path == b"-" {
		TwoArgTarget::Std(u8::from(mode.truncate || mode.append))
	} else {
		TwoArgTarget::Path(path.to_vec())
	};
	Ok((mode, target, layers))
}

/// Parse an explicit mode, including optional PerlIO layers.
pub(super) fn parse_mode(spec: &[u8]) -> Result<(OpenMode, ModeKind, Layers), String> {
	let mode_name = trim(spec);
	let unknown = || format!("Unknown open() mode '{}'", String::from_utf8_lossy(spec));
	let (mode, kind, rest) = if let Some(rest) = mode_name.strip_prefix(b"-|") {
		(OpenMode::READ, ModeKind::PipeRead, trim_start(rest))
	} else if let Some(rest) = mode_name.strip_prefix(b"|-") {
		(OpenMode::WRITE, ModeKind::PipeWrite, trim_start(rest))
	} else if let Some((mode, rest)) = file_prefix(mode_name) {
		let rest = trim_start(rest);
		if let Some((same, rest)) = dup_prefix(rest) {
			(OpenMode { truncate: false, create: false, ..mode }, ModeKind::Dup { same }, rest)
		} else {
			(mode, ModeKind::File, rest)
		}
	} else {
		return Err(unknown());
	};
	if !rest.is_empty() && !rest.starts_with(b":") {
		// A layer name may follow the mode directly ("<raw"); anything else is no mode.
		if rest[0].is_ascii_alphabetic() {
			let mut layers = Vec::with_capacity(rest.len() + 1);
			layers.push(b':');
			layers.extend_from_slice(rest);
			return Ok((mode, kind, Layers::parse(&layers)?));
		}
		return Err(unknown());
	}
	Ok((mode, kind, Layers::parse(rest)?))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn open_explicit_paths_are_literal_but_two_arg_operands_have_syntax() {
		let (mode, kind, layers) = parse_mode(b" +>> :raw :encoding(ISO-8859-1) ").unwrap();
		assert_eq!(kind, ModeKind::File);
		assert!(mode.read && mode.write && mode.append && mode.create && !mode.truncate);
		assert!(layers.utf8 && !layers.crlf);
		assert_eq!(parse_two_arg(b" \t<&= 0  ").unwrap().1, TwoArgTarget::Dup { name: b"0".to_vec(), same: true });
		assert_eq!(parse_two_arg(b"  > - ").unwrap().1, TwoArgTarget::Std(1));
		assert_eq!(parse_two_arg(b" a | ").unwrap().1, TwoArgTarget::Command(b"a".to_vec()));
		assert_eq!(parse_two_arg(b"<:raw word").unwrap().1, TwoArgTarget::Path(b":raw word".to_vec()));
	}
}
