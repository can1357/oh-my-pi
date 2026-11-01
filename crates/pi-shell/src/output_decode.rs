//! Decode child-process stdout/stderr into Unicode.
//!
//! Modern tools emit UTF-8 (Python with `PYTHONUTF8`, Node, Rust). Native
//! Windows programs on a CJK system write the ANSI code page to pipes — CP936
//! (GBK) on Simplified Chinese — and treating those bytes as UTF-8 replaces
//! them with U+FFFD (乱码).
//!
//! Policy: decode as UTF-8. On Windows, a single invalid byte (std
//! `error_len() == 1`) is code-page evidence: the ANSI character starting
//! there (the byte, or a DBCS lead byte plus the next byte) is strict-decoded
//! with the process ANSI code page (`GetACP`, unless it is already UTF-8). If
//! it is valid ANSI text the remainder of the stream switches to that code
//! page; otherwise the byte becomes U+FFFD and the stream stays UTF-8, so
//! `printf '\xeb\n'` does not corrupt the valid UTF-8 after it (CP949
//! `EB 0A` is not a character). A truncated multibyte UTF-8 prefix (2+
//! bytes, e.g. `cut -c1-2` of Hangul) is not evidence: it becomes U+FFFD even
//! if the remnant happens to be a valid ANSI character. The decision looks
//! at two bytes at most, so it does not depend on read boundaries and never
//! delays output beyond one held lead byte.
//!
//! Valid UTF-8 always wins, including bytes that are also valid ACP (GBK 一 is
//! `D2 BB`, which is U+04BB in UTF-8). Overlap is ambiguous; this prefers the
//! modern-tool default over guessing language. Once switched, the ACP mode is
//! permanent for the stream: command output is one encoding, not mixed. A
//! stray byte that forms a valid ANSI character with the next byte (CP949
//! `EB ED`) still switches the stream.

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
				if self.can_fallback_to_acp() && invalid_len == 1 {
					match self.acp_unit_is_text(start, eof) {
						// The invalid bytes are a valid ANSI character: one
						// encoding per command, so the rest of the stream is
						// ACP too (cmd/chcp emit ACP for the whole stream).
						Some(true) => {
							self.pending.drain(..start);
							self.mode = Mode::Acp;
							out.push_str(&self.drain_acp(eof));
							return out;
						},
						// Not ANSI text: a stray byte; stay in UTF-8.
						Some(false) => {},
						// A lead byte whose trail has not arrived: hold it.
						None => break,
					}
				}

				out.push_str(REPLACEMENT);
				start += invalid_len;
				continue;
			}
			// An incomplete sequence ends the buffer: hold it for the next
			// read, or resolve it at EOF.
			if eof {
				// A tail of 2+ bytes is a cut UTF-8 character, not ANSI
				// evidence; a single byte still goes through the unit check.
				#[cfg(windows)]
				if self.can_fallback_to_acp()
					&& self.pending.len() - start == 1
					&& self.acp_unit_is_text(start, true) == Some(true)
				{
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
		self.fallback_codepage != 0 && self.fallback_codepage != CP_UTF8
	}

	/// Whether the invalid bytes at `start` form one valid ANSI character: a
	/// DBCS lead byte plus the next byte, or a single byte. `None` while a
	/// lead byte waits for its trail byte; at EOF a dangling lead is invalid.
	#[cfg(windows)]
	fn acp_unit_is_text(&self, start: usize, eof: bool) -> Option<bool> {
		let cp = self.fallback_codepage;
		let first = self.pending[start];
		let len = if is_dbcs_lead(cp, first) {
			match self.pending.get(start + 1) {
				Some(_) => 2,
				None if eof => return Some(false),
				None => return None,
			}
		} else {
			1
		};
		let unit = &self.pending[start..start + len];
		Some(
			decode_codepage(cp, unit, windows_sys::Win32::Globalization::MB_ERR_INVALID_CHARS)
				.is_some(),
		)
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
		assert_split_invariant(936, &[0xd6, 0xd0, 0xce, 0xc4], "中文");
	}

	#[cfg(windows)]
	#[test]
	fn host_acp_decodes_gbk_when_system_is_936() {
		if acp() != 936 {
			return;
		}
		let mut decoder = OutputDecoder::new();
		let mut out = decoder.push(&[0xd6, 0xd0, 0xce, 0xc4]);
		out.push_str(&decoder.finish());
		assert_eq!(out, "中文");
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
		// 文 is CE C4; C4 is also a GBK lead value, so a last-byte heuristic
		// would hold it back and mangle 文.
		assert_split_invariant(936, &[0xce, 0xc4], "文");
	}

	#[cfg(windows)]
	#[test]
	fn ascii_prefix_then_gbk() {
		assert_split_invariant(936, b"cmd\xd6\xd0\xce\xc4", "cmd中文");
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

	/// A lone invalid byte that is a DBCS lead (CP949 `EB`) must not swallow
	/// the newline nor turn the valid UTF-8 after it into mojibake.
	#[cfg(windows)]
	#[test]
	fn stray_lead_byte_keeps_following_utf8() {
		for cp in [949, 936] {
			assert_split_invariant(
				cp,
				b"ok\n\xeb\n\xed\x95\x9c\xea\xb8\x80\n",
				"ok\n\u{FFFD}\n한글\n",
			);
			assert_split_invariant(
				cp,
				b"\xea\xb0\x80\xeb\n\xed\x95\x9c\xea\n",
				"가\u{FFFD}\n한\u{FFFD}\n",
			);
		}
	}

	/// `EB ED` is a valid CP949 character, so it still switches the stream,
	/// exactly as before this change.
	#[cfg(windows)]
	#[test]
	fn stray_byte_forming_valid_character_still_switches() {
		let ch = decode_codepage(949, &[0xeb, 0xed], 0).unwrap();
		assert_split_invariant(949, &[0xeb, 0xed, b'\n'], &format!("{ch}\n"));
	}

	/// Legacy ANSI output: once the first invalid unit is valid ANSI text the
	/// stream is ACP, as before, whatever the following lines look like.
	#[cfg(windows)]
	#[test]
	fn legacy_acp_lines_decode_whole() {
		let cases: [(u32, &str); 14] = [
			(936, "中国\r\n"),
			(936, "中文一\n"),
			(936, "中国丂\r\n"),
			(936, " 驱动器 C 中的卷没有标签。\r\n"),
			(936, "中文\r\n系统找不到指定的文件。\r\n"),
			(949, "한글 중국 볼륨에는 이름이 없습니다\r\n"),
			(949, "지정된 파일을 찾을 수 없습니다.\r\n"),
			(932, "指定されたファイルが見つかりません。\r\n"),
			(932, "日本\r\n指定されたファイルが見つかりません。\r\n"),
			(932, "ソース サービス\r\n"),
			(932, "サービス コマンド\r\n"),
			(950, "許功 程式\r\n"),
			(932, "ソ\r\n"),
			(932, "ｿｰｽ\r\n"),
		];
		for (cp, text) in cases {
			assert_split_invariant(cp, &encode_codepage(cp, text), text);
		}
	}

	#[cfg(windows)]
	#[test]
	fn cp949_hangul_bytes_decode_whole() {
		assert_split_invariant(949, b"\xc7\xd1\xb1\xdb", "한글");
		// `EB ED` and `95 9C` are both valid CP949 pairs.
		assert_split_invariant(949, b"\xeb\xed\x95\x9c\n", "鷹븳\n");
	}

	/// Review cases: a lone `0xFF` is emitted on push, not held until EOF.
	#[cfg(windows)]
	#[test]
	fn stray_byte_is_emitted_immediately() {
		for cp in [949, 936] {
			let mut decoder = OutputDecoder::with_fallback_codepage(cp);
			assert_eq!(decoder.push(&[0xff]), "\u{FFFD}", "cp{cp}");
			assert_eq!(decoder.finish(), "");
		}
	}

	/// Shift-JIS `ソ` is `83 5C` (ASCII trail); half-width katakana are
	/// single-byte characters on a DBCS page.
	#[cfg(windows)]
	#[test]
	fn cp932_ascii_trail_and_halfwidth_katakana() {
		assert_split_invariant(932, &encode_codepage(932, "ソ\n"), "ソ\n");
		assert_split_invariant(932, &encode_codepage(932, "ｿｰｽ\n"), "ｿｰｽ\n");
	}

	/// The decision uses at most two bytes, so the read size never matters.
	#[cfg(windows)]
	#[test]
	fn output_does_not_depend_on_read_size() {
		let mut bytes = b"\xd6\xd0".repeat(2048);
		bytes.extend_from_slice(b"\x81\x30\n");
		let decode = |size: usize| {
			let mut decoder = OutputDecoder::with_fallback_codepage(936);
			let mut out: String = bytes
				.chunks(size)
				.map(|chunk| decoder.push(chunk))
				.collect();
			out.push_str(&decoder.finish());
			out
		};
		let expected = decode(bytes.len());
		assert!(expected.starts_with("中中"));
		for size in [1, 2, 3, 4095, 4096, 4097, 65536] {
			assert_eq!(decode(size), expected, "read size {size}");
		}
	}

	/// A dangling invalid prefix at EOF is judged as one character, like any
	/// other: `81 30` is not GBK, `E4 B8` is.
	#[cfg(windows)]
	#[test]
	fn eof_tail_is_judged_per_character() {
		assert_split_invariant(936, b"\x81\x30\xe4", "\u{FFFD}0\u{FFFD}");
		assert_split_invariant(936, b"\x81\x30\xe4\xb8", "\u{FFFD}0\u{FFFD}");
	}

	/// A UTF-8 character cut by a byte-wise `cut` leaves a truncated prefix;
	/// that is not code-page evidence, whatever the remnant decodes to.
	#[cfg(windows)]
	#[test]
	fn cut_utf8_character_does_not_switch_to_acp() {
		for cp in [949, 936] {
			// `cut -c1-2`: 가 (EA B0 80) cut to EA B0, then a valid line.
			assert_split_invariant(
				cp,
				b"\xea\xb0\n\xeb\x8b\xa4\xec\x9d\x8c \xec\xa4\x84\n",
				"\u{FFFD}\n다음 줄\n",
			);
			// `cut -c1-4` of `가나다라`: 가 + 나's first byte.
			assert_split_invariant(
				cp,
				b"\xea\xb0\x80\xeb\n\xed\x95\x9c\xea\n",
				"가\u{FFFD}\n한\u{FFFD}\n",
			);
		}
		// `EA B0` is a valid CP949/CP936 character (媛): still not evidence.
		assert_split_invariant(936, b"\xea\xb0\n\xed\x95\x9c\n", "\u{FFFD}\n한\n");
	}

	/// Legacy text whose first character looks like a cut UTF-8 prefix loses
	/// that character and still switches at its next unit: GBK 涓 is `E4 B8`,
	/// a truncated 3-byte UTF-8 prefix before `D6`.
	#[cfg(windows)]
	#[test]
	fn legacy_text_after_a_truncated_prefix_still_switches() {
		let bytes = encode_codepage(936, "涓中\r\n");
		assert_eq!(&bytes[..2], b"\xe4\xb8");
		assert_split_invariant(936, &bytes, "\u{FFFD}中\r\n");
	}

	/// Many rejected sequences must cost linear time, not a re-walk of the
	/// rest of the buffer each.
	#[cfg(windows)]
	#[test]
	fn many_stray_bytes_decode_in_linear_time() {
		for (cp, byte) in [(949, 0xff), (936, 0xff)] {
			let bytes = vec![byte; 256 * 1024];
			let started = std::time::Instant::now();
			let mut decoder = OutputDecoder::with_fallback_codepage(cp);
			let mut out = decoder.push(&bytes);
			out.push_str(&decoder.finish());
			assert_eq!(out, "\u{FFFD}".repeat(bytes.len()), "cp{cp}");
			assert!(started.elapsed().as_secs() < 5, "cp{cp} took {:?}", started.elapsed());
		}
	}

	/// Single-push output must equal `expected`, and every one- and two-way
	/// split of the input must produce the same text.
	#[cfg(windows)]
	fn assert_split_invariant(codepage: u32, bytes: &[u8], expected: &str) {
		let run = |chunks: &[&[u8]]| {
			let mut decoder = OutputDecoder::with_fallback_codepage(codepage);
			let mut out = String::new();
			for chunk in chunks {
				out.push_str(&decoder.push(chunk));
			}
			out.push_str(&decoder.finish());
			out
		};
		assert_eq!(run(&[bytes]), expected, "cp{codepage} single push of {bytes:02x?}");
		for a in 0..=bytes.len() {
			assert_eq!(
				run(&[&bytes[..a], &bytes[a..]]),
				expected,
				"cp{codepage} split at {a} of {bytes:02x?}"
			);
			for b in a..=bytes.len() {
				assert_eq!(
					run(&[&bytes[..a], &bytes[a..b], &bytes[b..]]),
					expected,
					"cp{codepage} splits at {a},{b} of {bytes:02x?}"
				);
			}
		}
	}

	#[cfg(windows)]
	fn encode_codepage(codepage: u32, text: &str) -> Vec<u8> {
		let wide: Vec<u16> = text.encode_utf16().collect();
		let mut buf = vec![0u8; wide.len() * 4];
		// SAFETY: `wide` and `buf` are valid for the lengths passed.
		let written = unsafe {
			windows_sys::Win32::Globalization::WideCharToMultiByte(
				codepage,
				0,
				wide.as_ptr(),
				wide.len() as i32,
				buf.as_mut_ptr(),
				buf.len() as i32,
				std::ptr::null(),
				std::ptr::null_mut(),
			)
		};
		assert!(written > 0, "encode failed");
		buf.truncate(written as usize);
		buf
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

	/// A decoder that never falls back to an ANSI code page.
	fn utf8_decoder() -> OutputDecoder {
		#[cfg(windows)]
		return OutputDecoder::with_fallback_codepage(CP_UTF8);
		#[cfg(not(windows))]
		return OutputDecoder::new();
	}

	#[test]
	fn invalid_sequences_between_text_keep_order_and_hold_the_tail() {
		let mut decoder = utf8_decoder();
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
