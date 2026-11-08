//! Decode child-process stdout/stderr into Unicode.
//!
//! Modern tools emit UTF-8 (Python with `PYTHONUTF8`, Node, Rust). Native
//! Windows programs on a CJK system write the ANSI code page to pipes — CP936
//! (GBK) on Simplified Chinese — and treating those bytes as UTF-8 replaces
//! them with U+FFFD (乱码).
//!
//! Encoding is decided where its unit is known. Each external program writing
//! into the capture or a command substitution writes into its own relay (see
//! [`external_output_decoding`] and the host's output relays) and is decoded on
//! its own: UTF-8 until a complete invalid sequence, then, on Windows, the
//! rest of that program's output from the process ANSI code page (`GetACP`)
//! unless that page is already UTF-8. Builtins write into the capture
//! directly, and what they write is judged line by line ([`CaptureDecoder`]),
//! so a stray byte from `printf` or `cut` cannot change the lines after it.
//! Pipeline pipes and files are never decoded: binary data stays intact.
//!
//! Valid UTF-8 always wins, including bytes that are also valid ACP (GBK 一 is
//! `D2 BB`, which is U+04BB in UTF-8). Overlap is ambiguous; this prefers the
//! modern-tool default over guessing language. Within one program's output
//! the ACP switch is permanent, so once it has shown ACP text, later bytes
//! that are also valid UTF-8 still decode as ACP.

use std::{str, sync::Arc};

use crate::sys::{ByteDecoder, OutputDecoding};

const REPLACEMENT: &str = "\u{FFFD}";
/// UTF-8 console / system code page. Fallback is a no-op: invalid UTF-8 stays
/// replacement characters rather than being re-decoded as itself.
#[cfg(windows)]
const CP_UTF8: u32 = 65001;

enum Mode {
	Utf8,
	#[cfg(windows)]
	Acp,
}

/// Incremental decoder for one stdout/stderr stream.
pub struct OutputDecoder {
	pending:           Vec<u8>,
	mode:              Mode,
	#[cfg(windows)]
	fallback_codepage: u32,
}

impl Default for OutputDecoder {
	fn default() -> Self {
		Self::new()
	}
}

impl OutputDecoder {
	/// Decode with the host ANSI code page as the Windows fallback.
	/// Not `const`: `GetACP` is an FFI call.
	#[cfg(windows)]
	pub fn new() -> Self {
		Self::with_fallback_codepage(acp())
	}

	/// Decode as UTF-8 only; no ANSI fallback exists off Windows.
	#[cfg(not(windows))]
	pub const fn new() -> Self {
		Self { pending: Vec::new(), mode: Mode::Utf8 }
	}

	/// Decode as UTF-8 only, with invalid sequences as U+FFFD.
	pub const fn utf8() -> Self {
		Self {
			pending: Vec::new(),
			mode: Mode::Utf8,
			#[cfg(windows)]
			fallback_codepage: CP_UTF8,
		}
	}

	/// Decode with an explicit ANSI fallback. Used by tests so GBK fixtures
	/// run on any Windows host, not only a Chinese ACP.
	#[cfg(windows)]
	pub const fn with_fallback_codepage(codepage: u32) -> Self {
		Self {
			pending:           Vec::new(),
			mode:              Mode::Utf8,
			fallback_codepage: codepage,
		}
	}

	/// Push the next pipe read. Returns text that is safe to emit now;
	/// incomplete UTF-8 / DBCS sequences stay buffered.
	pub fn push(&mut self, bytes: &[u8]) -> String {
		if bytes.is_empty() {
			return String::new();
		}
		// Common case: nothing held back and the read is valid UTF-8.
		if self.pending.is_empty()
			&& matches!(self.mode, Mode::Utf8)
			&& let Ok(text) = str::from_utf8(bytes)
		{
			return text.to_owned();
		}
		self.pending.extend_from_slice(bytes);
		self.drain(false)
	}

	/// Flush held bytes at EOF.
	pub fn finish(&mut self) -> String {
		self.drain(true)
	}

	fn drain(&mut self, eof: bool) -> String {
		match self.mode {
			Mode::Utf8 => self.drain_utf8(eof),
			#[cfg(windows)]
			Mode::Acp => self.drain_acp(eof),
		}
	}

	/// Decodes `pending` with a cursor and compacts it once at the end, so a
	/// buffer with many invalid sequences costs linear time (draining the
	/// prefix per sequence made it quadratic).
	fn drain_utf8(&mut self, eof: bool) -> String {
		let mut out = String::with_capacity(self.pending.len());
		let mut start = 0;
		while start < self.pending.len() {
			let err = match str::from_utf8(&self.pending[start..]) {
				Ok(text) => {
					out.push_str(text);
					start = self.pending.len();
					break;
				},
				Err(err) => err,
			};
			let valid_end = start + err.valid_up_to();
			// SAFETY: [start..valid_end] is valid UTF-8 by valid_up_to().
			out.push_str(unsafe { str::from_utf8_unchecked(&self.pending[start..valid_end]) });
			start = valid_end;
			if let Some(invalid_len) = err.error_len() {
				#[cfg(windows)]
				if self.can_fallback_to_acp() {
					// One encoding per command. Do not resume UTF-8 after
					// a bad byte: later UTF-8 would be ACP-mojibake, but
					// cmd/chcp emit ACP for the whole stream.
					self.pending.drain(..start);
					self.mode = Mode::Acp;
					out.push_str(&self.drain_acp(eof));
					return out;
				}

				out.push_str(REPLACEMENT);
				start += invalid_len;
				continue;
			}
			// An incomplete sequence ends the buffer: hold it for the next
			// read, or resolve it at EOF.
			if eof {
				#[cfg(windows)]
				if self.can_fallback_to_acp() {
					self.pending.drain(..start);
					self.mode = Mode::Acp;
					out.push_str(&self.drain_acp(true));
					return out;
				}

				out.push_str(REPLACEMENT);
				start = self.pending.len();
			}
			break;
		}
		self.pending.drain(..start);
		out
	}

	#[cfg(windows)]
	const fn can_fallback_to_acp(&self) -> bool {
		has_acp_fallback(self.fallback_codepage)
	}

	#[cfg(windows)]
	fn drain_acp(&mut self, eof: bool) -> String {
		if self.pending.is_empty() {
			return String::new();
		}
		let len = complete_acp_len(self.fallback_codepage, &self.pending, eof);
		if len == 0 {
			return String::new();
		}
		let decoded = decode_codepage(self.fallback_codepage, &self.pending[..len], 0)
			.unwrap_or_else(|| String::from_utf8_lossy(&self.pending[..len]).into_owned());
		self.pending.drain(..len);
		decoded
	}
}

/// The hook that decodes each external program's output with the host ANSI
/// code page as its fallback, or `None` where no fallback exists (off
/// Windows, or a UTF-8 system code page).
pub fn external_output_decoding() -> Option<Arc<dyn OutputDecoding>> {
	#[cfg(windows)]
	{
		let codepage = acp();
		has_acp_fallback(codepage)
			.then(|| Arc::new(AcpOutputDecoding { codepage }) as Arc<dyn OutputDecoding>)
	}
	#[cfg(not(windows))]
	None
}

/// Decodes each external program's output as UTF-8 with an ANSI fallback.
#[cfg(windows)]
struct AcpOutputDecoding {
	codepage: u32,
}

#[cfg(windows)]
impl OutputDecoding for AcpOutputDecoding {
	fn decoder(&self) -> Box<dyn ByteDecoder> {
		Box::new(OutputDecoder::with_fallback_codepage(self.codepage))
	}
}

impl ByteDecoder for OutputDecoder {
	fn push(&mut self, bytes: &[u8]) -> String {
		Self::push(self, bytes)
	}

	fn holds_bytes(&self) -> bool {
		!self.pending.is_empty()
	}

	fn finish(&mut self) -> String {
		Self::finish(self)
	}
}

/// Longest line the capture holds back before judging it anyway.
#[cfg(windows)]
const MAX_HELD_LINE: usize = 64 * 1024;

/// Decodes the shell's capture pipe, judging each line on its own.
///
/// External programs reach the capture already decoded by their relays, so
/// bytes that are not UTF-8 there came through a builtin: `printf '\xeb'`,
/// `cut` through a character, `cat` of a legacy file, or a native program's
/// output passed along a pipeline (`dir | head`). With an ANSI fallback each
/// line is judged on its own (see `judge_line`), so a stray byte cannot
/// change any other line.
pub struct CaptureDecoder {
	mode: CaptureMode,
}

enum CaptureMode {
	/// No ANSI fallback: UTF-8, invalid sequences as U+FFFD.
	Utf8(OutputDecoder),
	#[cfg(windows)]
	Lines(LineDecoder),
}

impl Default for CaptureDecoder {
	fn default() -> Self {
		Self::new()
	}
}

impl CaptureDecoder {
	/// Judges lines against the host ANSI code page where one can decode what
	/// UTF-8 cannot; UTF-8 alone otherwise.
	#[cfg_attr(
		not(windows),
		expect(clippy::missing_const_for_fn, reason = "reads the ANSI code page on Windows")
	)]
	pub fn new() -> Self {
		#[cfg(windows)]
		{
			let codepage = acp();
			if has_acp_fallback(codepage) {
				return Self::with_codepage(codepage);
			}
		}
		Self { mode: CaptureMode::Utf8(OutputDecoder::utf8()) }
	}

	/// Judges lines against `codepage`. Used by tests so code-page fixtures
	/// run on any Windows host.
	#[cfg(windows)]
	fn with_codepage(codepage: u32) -> Self {
		Self { mode: CaptureMode::Lines(LineDecoder::new(codepage)) }
	}

	/// Push the next pipe read. Returns text that is safe to emit now.
	pub fn push(&mut self, bytes: &[u8]) -> String {
		match &mut self.mode {
			CaptureMode::Utf8(decoder) => decoder.push(bytes),
			#[cfg(windows)]
			CaptureMode::Lines(lines) => lines.push(bytes),
		}
	}

	/// Whether part of a line is held back waiting for its end; a reader
	/// releases it with [`Self::flush_line`] once the output goes quiet.
	pub const fn holds_line(&self) -> bool {
		match &self.mode {
			CaptureMode::Utf8(_) => false,
			#[cfg(windows)]
			CaptureMode::Lines(lines) => lines.holds_undecided(),
		}
	}

	/// Judges the held part of the line as if it ended here, except for an
	/// incomplete UTF-8 character at its end, which waits for its next bytes.
	#[cfg_attr(
		not(windows),
		expect(clippy::missing_const_for_fn, reason = "decodes the held line on Windows")
	)]
	pub fn flush_line(&mut self) -> String {
		match &mut self.mode {
			CaptureMode::Utf8(_) => String::new(),
			#[cfg(windows)]
			CaptureMode::Lines(lines) => lines.flush_complete(),
		}
	}

	/// Flush held bytes at EOF.
	pub fn finish(&mut self) -> String {
		match &mut self.mode {
			CaptureMode::Utf8(decoder) => decoder.finish(),
			#[cfg(windows)]
			CaptureMode::Lines(lines) => lines.finish(),
		}
	}
}

/// Judges the capture line by line against an ANSI code page.
#[cfg(windows)]
struct LineDecoder {
	codepage:  u32,
	/// Whether the code page has multibyte characters, so that a UTF-8
	/// character cut short can also read as one (CP949 `EA B0` is 媛). In a
	/// single-byte page a lone `E9` at a line's end is `é`, not a cut.
	multibyte: bool,
	/// The current line from its first non-ASCII byte on, held until the line
	/// ends; ASCII before it reads the same in every code page.
	held:      Vec<u8>,
	/// Whether `held` is only an incomplete UTF-8 character that a flush kept
	/// for its next bytes, so there is nothing to judge until they come.
	tail_kept: bool,
	/// The encoding a partial flush chose for the current line; the rest of
	/// the line keeps it until its newline.
	line:      Option<LineEncoding>,
}

#[cfg(windows)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum LineEncoding {
	Utf8,
	Ansi,
}

#[cfg(windows)]
impl LineDecoder {
	fn new(codepage: u32) -> Self {
		Self {
			codepage,
			multibyte: max_char_size(codepage) > 1,
			held: Vec::new(),
			tail_kept: false,
			line: None,
		}
	}

	/// Emits ASCII as it comes and each line holding other bytes once it ends.
	fn push(&mut self, mut bytes: &[u8]) -> String {
		self.tail_kept = false;
		let mut out = String::with_capacity(bytes.len());
		loop {
			if self.held.is_empty() {
				let ascii = bytes
					.iter()
					.position(|byte| !byte.is_ascii())
					.unwrap_or(bytes.len());
				if bytes[..ascii].contains(&b'\n') {
					self.line = None;
				}
				// SAFETY: ASCII is valid UTF-8.
				out.push_str(unsafe { str::from_utf8_unchecked(&bytes[..ascii]) });
				bytes = &bytes[ascii..];
				if bytes.is_empty() {
					return out;
				}
			}
			let Some(end) = bytes.iter().position(|&byte| byte == b'\n') else {
				self.held.extend_from_slice(bytes);
				if self.held.len() >= MAX_HELD_LINE {
					out.push_str(&self.flush_complete());
				}
				return out;
			};
			self.held.extend_from_slice(&bytes[..end]);
			out.push_str(&self.decode(&self.held, self.encoding_for(&self.held)));
			self.held.clear();
			self.line = None;
			out.push('\n');
			bytes = &bytes[end + 1..];
		}
	}

	const fn holds_undecided(&self) -> bool {
		!self.held.is_empty() && !self.tail_kept
	}

	/// Decodes the held bytes as if the line ended here, keeping back a
	/// character still incomplete in their encoding for its next bytes: an
	/// incomplete UTF-8 sequence when they are UTF-8, otherwise a DBCS lead
	/// byte (`81` in CP936, which is no UTF-8 prefix). The encoding chosen
	/// holds for the rest of the line.
	fn flush_complete(&mut self) -> String {
		let utf8_tail = incomplete_utf8_tail(&self.held);
		let utf8 = match self.line {
			Some(encoding) => encoding == LineEncoding::Utf8,
			None => str::from_utf8(&self.held[..self.held.len() - utf8_tail]).is_ok(),
		};
		let keep = if utf8 {
			utf8_tail
		} else {
			self.held.len() - complete_acp_len(self.codepage, &self.held, false)
		};
		let end = self.held.len() - keep;
		let mut text = String::new();
		if end > 0 {
			let encoding = self.encoding_for(&self.held[..end]);
			text = self.decode(&self.held[..end], encoding);
			self.line = Some(encoding);
		}
		self.held.drain(..end);
		self.tail_kept = !self.held.is_empty();
		text
	}

	fn finish(&mut self) -> String {
		let text = self.decode(&self.held, self.encoding_for(&self.held));
		self.held.clear();
		self.tail_kept = false;
		self.line = None;
		text
	}

	fn encoding_for(&self, bytes: &[u8]) -> LineEncoding {
		self.line.unwrap_or_else(|| self.judge(bytes))
	}

	fn decode(&self, bytes: &[u8], encoding: LineEncoding) -> String {
		match encoding {
			LineEncoding::Utf8 => String::from_utf8_lossy(bytes).into_owned(),
			LineEncoding::Ansi => decode_codepage(self.codepage, bytes, 0)
				.unwrap_or_else(|| String::from_utf8_lossy(bytes).into_owned()),
		}
	}

	/// Judges one line, or the part of it from its first non-ASCII byte.
	/// Valid UTF-8 is UTF-8. Otherwise it is ANSI text when it strict-decodes
	/// in the code page and reads worse as UTF-8 — fewer valid multibyte
	/// characters than invalid sequences — unless, in a multibyte page, its
	/// only flaw is a character cut short at its end, as `cut -c` and
	/// `head -c` leave. Anything else is UTF-8 with U+FFFD, so `ok\xeb` loses
	/// one byte, not the lines after it.
	fn judge(&self, bytes: &[u8]) -> LineEncoding {
		if str::from_utf8(bytes).is_ok() {
			return LineEncoding::Utf8;
		}
		let shape = Utf8Shape::of(bytes);
		let cut_short_only = self.multibyte && shape.invalid == 0 && shape.cut_tail;
		if !cut_short_only
			&& shape.multibyte < shape.invalid + usize::from(shape.cut_tail)
			&& decode_codepage(
				self.codepage,
				bytes,
				windows_sys::Win32::Globalization::MB_ERR_INVALID_CHARS,
			)
			.is_some()
		{
			return LineEncoding::Ansi;
		}
		LineEncoding::Utf8
	}
}

/// Length of the incomplete UTF-8 character `bytes` end in, or 0.
#[cfg(windows)]
fn incomplete_utf8_tail(bytes: &[u8]) -> usize {
	(1..=bytes.len().min(3))
		.find(|&len| {
			str::from_utf8(&bytes[bytes.len() - len..])
				.is_err_and(|err| err.valid_up_to() == 0 && err.error_len().is_none())
		})
		.unwrap_or(0)
}

/// The longest character of `codepage`, in bytes.
#[cfg(windows)]
fn max_char_size(codepage: u32) -> u32 {
	let mut info = windows_sys::Win32::Globalization::CPINFO {
		MaxCharSize: 0,
		DefaultChar: [0; 2],
		LeadByte:    [0; 12],
	};
	// SAFETY: `info` is a valid `CPINFO` for the call to fill.
	let ok = unsafe { windows_sys::Win32::Globalization::GetCPInfo(codepage, &raw mut info) };
	if ok == 0 { 1 } else { info.MaxCharSize }
}

/// How bytes read as UTF-8.
#[cfg(windows)]
struct Utf8Shape {
	/// Valid characters beyond ASCII.
	multibyte: usize,
	/// Invalid sequences, not counting an incomplete one at the end.
	invalid:   usize,
	/// Whether the bytes end in an incomplete character.
	cut_tail:  bool,
}

#[cfg(windows)]
impl Utf8Shape {
	fn of(mut bytes: &[u8]) -> Self {
		let mut shape = Self { multibyte: 0, invalid: 0, cut_tail: false };
		loop {
			let (valid, rest) = match str::from_utf8(bytes) {
				Ok(text) => (text, None),
				Err(err) => {
					// SAFETY: `valid_up_to` bytes are valid UTF-8.
					let valid = unsafe { str::from_utf8_unchecked(&bytes[..err.valid_up_to()]) };
					(valid, Some((err.valid_up_to(), err.error_len())))
				},
			};
			shape.multibyte += valid.chars().filter(|ch| !ch.is_ascii()).count();
			match rest {
				None => return shape,
				Some((_, None)) => {
					shape.cut_tail = true;
					return shape;
				},
				Some((start, Some(len))) => {
					shape.invalid += 1;
					bytes = &bytes[start + len..];
				},
			}
		}
	}
}

/// Whether `codepage` can decode what UTF-8 cannot. A UTF-8 system code page
/// cannot: invalid UTF-8 stays replacement characters rather than being
/// re-decoded as itself.
#[cfg(windows)]
const fn has_acp_fallback(codepage: u32) -> bool {
	codepage != 0 && codepage != CP_UTF8
}

#[cfg(windows)]
fn acp() -> u32 {
	// SAFETY: GetACP has no preconditions.
	unsafe { windows_sys::Win32::Globalization::GetACP() }
}

#[cfg(windows)]
fn is_dbcs_lead(codepage: u32, byte: u8) -> bool {
	// SAFETY: `IsDBCSLeadByteEx` accepts any code-page id; unknown pages return
	// false.
	unsafe { windows_sys::Win32::Globalization::IsDBCSLeadByteEx(codepage, byte) != 0 }
}

/// Bytes at the start of `bytes` that form complete ACP characters.
///
/// A trail byte in GBK/Shift-JIS can itself be a lead-byte value, so holding
/// back whatever happens to be last is wrong — walk from the start of the
/// ACP segment instead.
#[cfg(windows)]
fn complete_acp_len(codepage: u32, bytes: &[u8], eof: bool) -> usize {
	let mut index = 0;
	while index < bytes.len() {
		if is_dbcs_lead(codepage, bytes[index]) {
			if index + 1 < bytes.len() {
				index += 2;
			} else {
				return if eof { bytes.len() } else { index };
			}
		} else {
			index += 1;
		}
	}
	index
}

/// Decodes `bytes` from `codepage`; `flags` are `MultiByteToWideChar`'s
/// (`MB_ERR_INVALID_CHARS` fails on an invalid character instead of
/// replacing it).
#[cfg(windows)]
fn decode_codepage(codepage: u32, bytes: &[u8], flags: u32) -> Option<String> {
	if bytes.is_empty() {
		return Some(String::new());
	}
	let len = i32::try_from(bytes.len()).ok()?;
	// SAFETY: `bytes` is a valid slice of `len` bytes; a null wide-char buffer
	// with cchWideChar=0 is the documented size-query form.
	let needed = unsafe {
		windows_sys::Win32::Globalization::MultiByteToWideChar(
			codepage,
			flags,
			bytes.as_ptr(),
			len,
			std::ptr::null_mut(),
			0,
		)
	};
	if needed <= 0 {
		return None;
	}
	let mut wide = vec![0u16; needed as usize];
	// SAFETY: `wide` has `needed` UTF-16 units, matching the size query.
	let written = unsafe {
		windows_sys::Win32::Globalization::MultiByteToWideChar(
			codepage,
			flags,
			bytes.as_ptr(),
			len,
			wide.as_mut_ptr(),
			needed,
		)
	};
	if written <= 0 {
		return None;
	}
	Some(String::from_utf16_lossy(&wide[..written as usize]))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn utf8_passthrough() {
		let mut decoder = OutputDecoder::new();
		assert_eq!(decoder.push("hello 中文\n".as_bytes()), "hello 中文\n");
		assert_eq!(decoder.finish(), "");
	}

	#[test]
	fn incomplete_utf8_is_held_then_flushed() {
		let mut decoder = OutputDecoder::new();
		// First byte of UTF-8 中 (E4 B8 AD).
		assert_eq!(decoder.push(&[0xe4]), "");
		assert_eq!(decoder.push(&[0xb8, 0xad]), "中");
		assert_eq!(decoder.finish(), "");
	}

	#[test]
	fn incomplete_utf8_at_eof_becomes_replacement() {
		let mut decoder = OutputDecoder::new();
		assert_eq!(decoder.push(&[0xe4]), "");
		assert_eq!(decoder.finish(), "\u{FFFD}");
	}

	#[cfg(windows)]
	#[test]
	fn gbk_decodes_to_chinese() {
		// GBK for 中文.
		let mut decoder = OutputDecoder::with_fallback_codepage(936);
		assert_eq!(decoder.push(&[0xd6, 0xd0, 0xce, 0xc4]), "中文");
		assert_eq!(decoder.finish(), "");
	}

	#[cfg(windows)]
	#[test]
	fn host_acp_decodes_gbk_when_system_is_936() {
		if acp() != 936 {
			return;
		}
		let mut decoder = OutputDecoder::new();
		assert_eq!(decoder.push(&[0xd6, 0xd0, 0xce, 0xc4]), "中文");
		assert_eq!(decoder.finish(), "");
	}

	#[cfg(windows)]
	#[test]
	fn gbk_character_split_across_reads() {
		let mut decoder = OutputDecoder::with_fallback_codepage(936);
		assert_eq!(decoder.push(&[0xd6]), "");
		assert_eq!(decoder.push(&[0xd0, 0xce, 0xc4, b'\n']), "中文\n");
		assert_eq!(decoder.finish(), "");
	}

	#[cfg(windows)]
	#[test]
	fn gbk_holds_real_lead_not_trail_that_looks_like_lead() {
		let mut decoder = OutputDecoder::with_fallback_codepage(936);
		// 文 is CE C4; C4 is also a GBK lead value, so a last-byte heuristic
		// would hold it back and mangle 文.
		assert_eq!(decoder.push(&[0xce, 0xc4]), "文");
		assert_eq!(decoder.finish(), "");
	}

	#[cfg(windows)]
	#[test]
	fn ascii_prefix_then_gbk() {
		let mut decoder = OutputDecoder::with_fallback_codepage(936);
		assert_eq!(decoder.push(b"cmd"), "cmd");
		assert_eq!(decoder.push(&[0xd6, 0xd0, 0xce, 0xc4]), "中文");
		assert_eq!(decoder.finish(), "");
	}

	#[cfg(windows)]
	#[test]
	fn utf8_preferred_over_gbk_fallback() {
		let mut decoder = OutputDecoder::with_fallback_codepage(936);
		assert_eq!(decoder.push("中文".as_bytes()), "中文");
		assert_eq!(decoder.finish(), "");
	}

	#[cfg(windows)]
	#[test]
	fn incomplete_utf8_at_eof_falls_back_to_acp() {
		// CP1252 for é is also an incomplete three-byte UTF-8 prefix. EOF proves
		// this stream is not valid UTF-8, so it must still trigger fallback.
		let mut decoder = OutputDecoder::with_fallback_codepage(1252);
		assert_eq!(decoder.push(&[0xe9]), "");
		assert_eq!(decoder.finish(), "é");
	}

	#[cfg(windows)]
	#[test]
	fn utf8_system_codepage_keeps_replacement() {
		let mut decoder = OutputDecoder::with_fallback_codepage(65001);
		assert_eq!(decoder.push(&[0xff]), "\u{FFFD}");
		assert_eq!(decoder.finish(), "");
	}

	#[cfg(windows)]
	fn encode(codepage: u32, text: &str) -> Vec<u8> {
		let wide: Vec<u16> = text.encode_utf16().collect();
		let mut buf = vec![0u8; wide.len() * 4];
		// SAFETY: `wide` and `buf` are valid for the lengths passed.
		let written = unsafe {
			windows_sys::Win32::Globalization::WideCharToMultiByte(
				codepage,
				0,
				wide.as_ptr(),
				i32::try_from(wide.len()).expect("fixture length"),
				buf.as_mut_ptr(),
				i32::try_from(buf.len()).expect("fixture length"),
				std::ptr::null(),
				std::ptr::null_mut(),
			)
		};
		assert!(written > 0, "encode failed");
		buf.truncate(usize::try_from(written).expect("written length"));
		buf
	}

	/// Decodes `bytes` as one capture, in one read and split in two at every
	/// offset, asserting all agree with `expected`.
	#[cfg(windows)]
	fn assert_capture(codepage: u32, bytes: &[u8], expected: &str) {
		for split in 0..=bytes.len() {
			let mut decoder = CaptureDecoder::with_codepage(codepage);
			let mut out = decoder.push(&bytes[..split]);
			out.push_str(&decoder.push(&bytes[split..]));
			out.push_str(&decoder.finish());
			assert_eq!(out, expected, "cp{codepage} split at {split} of {bytes:02x?}");
		}
	}

	/// A builtin's stray byte (`printf 'ok\n\xeb\n한글\n'`) spoils only its own
	/// line, even where the byte is an ANSI lead byte.
	#[cfg(windows)]
	#[test]
	fn capture_stray_byte_spoils_only_its_line() {
		for codepage in [949, 936, 932] {
			assert_capture(codepage, b"ok\n\xeb\n\xed\x95\x9c\xea\xb8\x80\n", "ok\n\u{FFFD}\n한글\n");
			assert_capture(codepage, b"\xff\n\xed\x95\x9c\n", "\u{FFFD}\n한\n");
		}
		// In a single-byte page every such byte is a letter: `EB` is `ë`.
		assert_capture(1252, b"ok\n\xeb\n\xed\x95\x9c\xea\xb8\x80\n", "ok\n\u{eb}\n한글\n");
	}

	/// `cut -c` and `head -c` cut UTF-8 characters short; in a multibyte page
	/// the remnant is never read as an ANSI character, though `EA B0` is one
	/// in CP949 and GBK.
	#[cfg(windows)]
	#[test]
	fn capture_cut_characters_stay_utf8() {
		for codepage in [949, 936] {
			assert_capture(
				codepage,
				b"\xea\xb0\x80\xeb\n\xed\x95\x9c\xea\n",
				"가\u{FFFD}\n한\u{FFFD}\n",
			);
			assert_capture(
				codepage,
				b"\xea\xb0\n\xeb\x8b\xa4\xec\x9d\x8c \xec\xa4\x84\n",
				"\u{FFFD}\n다음 줄\n",
			);
		}
	}

	/// A single-byte page cannot tell a cut UTF-8 character from a letter, and
	/// a legacy line ending in one (`cat` of CP1252 `caf\xe9`) keeps it.
	#[cfg(windows)]
	#[test]
	fn capture_single_byte_page_keeps_a_letter_at_line_end() {
		assert_capture(1252, b"caf\xe9\n", "café\n");
		assert_capture(1252, b"caf\xe9", "café");
	}

	/// A character a builtin writes in two parts survives the idle flush
	/// between them and the cap on a held line.
	#[cfg(windows)]
	#[test]
	fn capture_flushes_keep_a_split_character() {
		let mut decoder = CaptureDecoder::with_codepage(936);
		assert_eq!(decoder.push(b"\xe4"), "");
		assert_eq!(decoder.flush_line(), "");
		assert!(!decoder.holds_line(), "a kept partial character must not re-arm the idle flush");
		assert_eq!(decoder.push(b"\xb8\xad\n"), "中\n");

		// `D6 D0` is 中; `81` begins 丂 (`81 40`) and is no UTF-8 prefix.
		let mut decoder = CaptureDecoder::with_codepage(936);
		assert_eq!(decoder.push(b"\xd6\xd0\x81"), "");
		assert_eq!(decoder.flush_line(), "中");
		assert!(!decoder.holds_line());
		assert_eq!(decoder.push(b"\x40\n"), "丂\n");

		// Valid UTF-8 is cut at UTF-8 boundaries: `AD` closes 中, though as
		// GBK it would begin a character.
		let mut decoder = CaptureDecoder::with_codepage(936);
		assert_eq!(decoder.push(b"\xe4\xb8\xad"), "");
		assert_eq!(decoder.flush_line(), "中");

		// A line judged ANSI at an idle flush stays ANSI to its newline: GBK
		// `D2 BB` (一) after it is valid UTF-8 (һ) but belongs to the line.
		let mut decoder = CaptureDecoder::with_codepage(936);
		assert_eq!(decoder.push(b"\xd6\xd0"), "");
		assert_eq!(decoder.flush_line(), "中");
		assert_eq!(decoder.push(b"\xd2\xbb\n"), "一\n");
		// The next line is judged afresh.
		assert_eq!(decoder.push("한\n".as_bytes()), "한\n");

		let mut line = "é".as_bytes().to_vec();
		line.resize(MAX_HELD_LINE - 1, b'a');
		line.push(0xe4);
		let mut decoder = CaptureDecoder::with_codepage(936);
		let mut out = decoder.push(&line);
		out.push_str(&decoder.push(b"\xb8\xad\n"));
		out.push_str(&decoder.finish());
		let mut expected = String::from_utf8(line[..line.len() - 1].to_vec()).expect("prefix");
		expected.push_str("中\n");
		assert_eq!(out, expected);
	}

	/// Legacy ANSI output passed along by a builtin (`dir | head`, `cat` of a
	/// legacy file) decodes line by line, beside UTF-8 lines.
	#[cfg(windows)]
	#[test]
	fn capture_ansi_lines_decode_beside_utf8_lines() {
		let cases: [(u32, &str); 9] = [
			(936, " 驱动器 C 中的卷没有标签。\r\n系统找不到指定的文件。\r\n"),
			(936, "涓一一中\r\n"),
			(936, "目录 中文\r\n"),
			(949, "지정된 파일을 찾을 수 없습니다.\r\n"),
			(932, "指定されたファイルが見つかりません。\r\n"),
			(932, "ソ\r\n"),
			(932, "ｿｰｽ\r\n"),
			(950, "許功 程式\r\n"),
			(1252, "Datei nicht gefunden: café\r\n"),
		];
		for (codepage, text) in cases {
			let mut bytes = "héllo\n".as_bytes().to_vec();
			bytes.extend_from_slice(&encode(codepage, text));
			bytes.extend_from_slice("한글\n".as_bytes());
			assert_capture(codepage, &bytes, &format!("héllo\n{text}한글\n"));
		}
	}

	/// ASCII streams at once; a line with other bytes waits for its end or
	/// for the reader to release it (a prompt that ends without a newline).
	#[cfg(windows)]
	#[test]
	fn capture_holds_only_undecided_lines() {
		let mut decoder = CaptureDecoder::with_codepage(936);
		assert_eq!(decoder.push(b"progress 50%\r"), "progress 50%\r");
		assert!(!decoder.holds_line());
		assert_eq!(decoder.push(&encode(936, "请输入:")), "");
		assert!(decoder.holds_line());
		assert_eq!(decoder.flush_line(), "请输入:");
		assert!(!decoder.holds_line());
		assert_eq!(decoder.finish(), "");
	}

	#[cfg(not(windows))]
	#[test]
	fn invalid_utf8_becomes_replacement() {
		let mut decoder = OutputDecoder::new();
		assert_eq!(decoder.push(&[0xff]), "\u{FFFD}");
		assert_eq!(decoder.finish(), "");
	}
}

#[cfg(test)]
mod utf8_tests {
	use super::*;

	#[test]
	fn invalid_sequences_between_text_keep_order_and_hold_the_tail() {
		let mut decoder = OutputDecoder::utf8();
		// Binary-ish output: invalid bytes between text, then the first byte of
		// a three-byte character that the next read completes.
		let mut bytes = Vec::new();
		for _ in 0..1000 {
			bytes.extend_from_slice(&[0xff, b'a', 0xc0, 0x80, b'b']);
		}
		bytes.push(0xe4);
		let decoded = decoder.push(&bytes);
		assert_eq!(decoded, "\u{FFFD}a\u{FFFD}\u{FFFD}b".repeat(1000));
		assert_eq!(decoder.push(&[0xb8, 0xad, b'\n']), "中\n");
		assert_eq!(decoder.finish(), "");
	}
}
