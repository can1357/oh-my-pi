//! Decode child-process stdout/stderr into Unicode.
//!
//! Modern tools emit UTF-8 (Python with `PYTHONUTF8`, Node, Rust). Native
//! Windows programs on a CJK system write the ANSI code page to pipes — CP936
//! (GBK) on Simplified Chinese — and treating those bytes as UTF-8 replaces
//! them with U+FFFD (乱码).
//!
//! Decode as UTF-8 until a complete invalid sequence; on Windows, switch the
//! remainder to the process ANSI code page (`GetACP`) unless that page is
//! already UTF-8.

use std::str;

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
	pub fn new() -> Self {
		Self {
			pending: Vec::new(),
			mode: Mode::Utf8,
			#[cfg(windows)]
			fallback_codepage: acp(),
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

	fn drain_utf8(&mut self, eof: bool) -> String {
		let mut out = String::new();
		loop {
			if self.pending.is_empty() {
				return out;
			}
			match str::from_utf8(&self.pending) {
				Ok(text) => {
					out.push_str(text);
					self.pending.clear();
					return out;
				},
				Err(err) => {
					let valid_up_to = err.valid_up_to();
					if valid_up_to > 0 {
						// SAFETY: [..valid_up_to] is valid UTF-8 by valid_up_to().
						out.push_str(unsafe { str::from_utf8_unchecked(&self.pending[..valid_up_to]) });
						self.pending.drain(..valid_up_to);
					}
					if let Some(invalid_len) = err.error_len() {
						#[cfg(windows)]
						if self.can_fallback_to_acp() {
							self.mode = Mode::Acp;
							out.push_str(&self.drain_acp(eof));
							return out;
						}
						out.push_str(REPLACEMENT);
						self.pending.drain(..invalid_len);
					} else {
						if eof {
							out.push_str(REPLACEMENT);
							self.pending.clear();
						}
						return out;
					}
				},
			}
		}
	}

	#[cfg(windows)]
	const fn can_fallback_to_acp(&self) -> bool {
		self.fallback_codepage != 0 && self.fallback_codepage != CP_UTF8
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
		let decoded = decode_codepage(self.fallback_codepage, &self.pending[..len])
			.unwrap_or_else(|| String::from_utf8_lossy(&self.pending[..len]).into_owned());
		self.pending.drain(..len);
		decoded
	}
}

/// Decode a complete buffer with the same UTF-8-then-ACP policy as
/// [`OutputDecoder`].
pub fn decode_bytes(bytes: &[u8]) -> String {
	let mut decoder = OutputDecoder::new();
	let mut out = decoder.push(bytes);
	out.push_str(&decoder.finish());
	out
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

#[cfg(windows)]
fn decode_codepage(codepage: u32, bytes: &[u8]) -> Option<String> {
	if bytes.is_empty() {
		return Some(String::new());
	}
	let len = i32::try_from(bytes.len()).ok()?;
	// SAFETY: `bytes` is a valid slice of `len` bytes; a null wide-char buffer
	// with cchWideChar=0 is the documented size-query form.
	let needed = unsafe {
		windows_sys::Win32::Globalization::MultiByteToWideChar(
			codepage,
			0,
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
			0,
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
		assert_eq!(decode_bytes(&[0xd6, 0xd0, 0xce, 0xc4]), "中文");
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
	fn utf8_system_codepage_keeps_replacement() {
		let mut decoder = OutputDecoder::with_fallback_codepage(65001);
		assert_eq!(decoder.push(&[0xff]), "\u{FFFD}");
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
