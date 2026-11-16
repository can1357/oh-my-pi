//! Debug write log: a byte-for-byte record of what the device encoded.

use std::{
	fmt::NumBuffer,
	fs::{File, OpenOptions},
	io::{self, Write},
	path::Path,
};

use memchr::memmem;

/// Append-only log of encoded output.
pub(super) struct WriteLog {
	file:     File,
	/// Output encoded while the pump's queue lock was held, written once it
	/// is released.
	staged:   Vec<u8>,
	redacted: Vec<u8>,
}

impl WriteLog {
	/// Open `path` for appending, creating it when missing.
	///
	/// # Errors
	/// Fails when the file cannot be opened or created.
	pub(super) fn open(path: &Path) -> io::Result<Self> {
		let file = OpenOptions::new().create(true).append(true).open(path)?;
		Ok(Self { file, staged: Vec::new(), redacted: Vec::new() })
	}

	/// Copy `data` aside to log on the next [`flush`](Self::flush).
	pub(super) fn stage(&mut self, data: &[u8]) {
		self.staged.extend_from_slice(data);
	}

	/// Write the staged output.
	pub(super) fn flush(&mut self) {
		if !self.staged.is_empty() {
			append(&mut self.file, &self.staged, &mut self.redacted);
			self.staged.clear();
		}
	}

	/// Append `data` now.
	pub(super) fn write(&mut self, data: &[u8]) {
		if !data.is_empty() {
			append(&mut self.file, data, &mut self.redacted);
		}
	}
}

fn append(file: &mut File, data: &[u8], scratch: &mut Vec<u8>) {
	// A debug aid must never take the terminal down with it: a failed append
	// only loses log lines.
	let _ = file.write_all(redact_clipboard(data, scratch));
}

/// Keep clipboard contents out of the log: every OSC 52 clipboard write
/// (`ESC ] 52 ; selection ; payload` ended by BEL or ST) is recorded with its
/// payload replaced by `<N bytes>`. Returns `data` itself when it holds none.
fn redact_clipboard<'a>(data: &'a [u8], scratch: &'a mut Vec<u8>) -> &'a [u8] {
	const INTRO: &[u8] = b"\x1b]52;";
	const BEL: u8 = 0x07;
	const ESC: u8 = 0x1b;

	scratch.clear();
	// `data[..copied]` is already represented in `scratch`.
	let mut copied = 0;
	let mut search = 0;
	while let Some(found) = memmem::find(&data[search..], INTRO) {
		let selection = search + found + INTRO.len();
		search = selection;
		// The selection runs to the next `;`; a terminator first means this is
		// not a clipboard write.
		let Some(offset) = data[selection..]
			.iter()
			.position(|&byte| matches!(byte, b';' | BEL | ESC))
		else {
			break;
		};
		if data[selection + offset] != b';' {
			continue;
		}
		let payload = selection + offset + 1;
		let Some(offset) = data[payload..]
			.iter()
			.position(|&byte| matches!(byte, BEL | ESC))
		else {
			break;
		};
		let end = payload + offset;
		search = end;
		if data[end] == ESC && data.get(end + 1) != Some(&b'\\') {
			continue;
		}
		scratch.extend_from_slice(&data[copied..payload]);
		scratch.push(b'<');
		scratch.extend_from_slice(
			(end - payload)
				.format_into(&mut NumBuffer::new())
				.as_bytes(),
		);
		scratch.extend_from_slice(b" bytes>");
		copied = end;
	}
	if copied == 0 {
		return data;
	}
	scratch.extend_from_slice(&data[copied..]);
	scratch
}

#[cfg(test)]
mod tests {
	use super::*;

	fn redacted(data: &str) -> String {
		let mut scratch = Vec::new();
		String::from_utf8(redact_clipboard(data.as_bytes(), &mut scratch).to_vec()).unwrap()
	}

	#[test]
	fn clipboard_payloads_are_logged_as_their_length() {
		for end in ["\x07", "\x1b\\"] {
			assert_eq!(
				redacted(&format!("\x1b[2Kframe\x1b]52;c;c2VjcmV0{end}tail")),
				format!("\x1b[2Kframe\x1b]52;c;<8 bytes>{end}tail")
			);
		}
		assert_eq!(
			redacted("\x1b]52;c;QQ==\x07mid\x1b]52;;\x1b\\\x1b]52;p;QUJD\x07"),
			"\x1b]52;c;<4 bytes>\x07mid\x1b]52;;<0 bytes>\x1b\\\x1b]52;p;<4 bytes>\x07"
		);
	}

	#[test]
	fn output_without_a_complete_clipboard_write_is_logged_verbatim() {
		for data in [
			"",
			"plain \x1b[31mrow\x1b[0m",
			// Not OSC 52.
			"\x1b]0;title\x07",
			// No payload separator before the terminator.
			"\x1b]52;c\x07",
			// Unterminated.
			"\x1b]52;c;c2VjcmV0",
			// ESC that is not ST.
			"\x1b]52;c;c2Vj\x1b[K",
		] {
			let mut scratch = Vec::new();
			let logged = redact_clipboard(data.as_bytes(), &mut scratch);
			assert_eq!(logged, data.as_bytes());
			assert!(scratch.is_empty(), "verbatim output must not be copied");
		}
	}

	#[test]
	fn a_broken_clipboard_write_does_not_hide_the_next_one() {
		assert_eq!(
			redacted("\x1b]52;c\x1b]52;c;QUJD\x07 \x1b]52;c;x\x1b[K\x1b]52;c;QQ==\x1b\\"),
			"\x1b]52;c\x1b]52;c;<4 bytes>\x07 \x1b]52;c;x\x1b[K\x1b]52;c;<4 bytes>\x1b\\"
		);
	}

	#[test]
	fn staged_output_is_written_on_flush() {
		let path = std::env::temp_dir().join(format!("pi-term-write-log-{}", std::process::id()));
		let _ = std::fs::remove_file(&path);
		let mut log = WriteLog::open(&path).unwrap();
		log.write(b"first ");
		log.stage(b"\x1b]52;c;");
		log.stage(b"c2VjcmV0\x07");
		log.flush();
		log.flush();
		let logged = std::fs::read(&path).unwrap();
		std::fs::remove_file(&path).unwrap();
		assert_eq!(logged, b"first \x1b]52;c;<8 bytes>\x07");
	}
}
