//! Excel 97-2003 binary workbook to deterministic Markdown conversion.

use std::io::{Cursor, Read as _, Seek as _, SeekFrom};

use cfb::OpenOptions;
use omp_core::Str;

use super::MarkitError;

const FORMAT: &str = "xls";
const MAX_MARKDOWN_BYTES: usize = 64 * 1024 * 1024;
const MAX_CFB_STREAM_BUFFER: usize = 64 * 1024;

/// Detects BIFF's package-level encryption marker without reading cell data.
///
/// anydoc collapses format-specific errors while probing, so this check
/// runs before handing the stream to anydoc.
fn workbook_is_encrypted(bytes: &[u8]) -> bool {
	let Ok(mut compound) = OpenOptions::new()
		.max_buffer_size(MAX_CFB_STREAM_BUFFER)
		.open_with(Cursor::new(bytes))
	else {
		return false;
	};
	for path in ["/Workbook", "/Book"] {
		let Ok(mut stream) = compound.open_stream(path) else {
			continue;
		};
		loop {
			let mut header = [0; 4];
			if stream.read_exact(&mut header).is_err() {
				break;
			}
			let kind = u16::from_le_bytes([header[0], header[1]]);
			let length = u16::from_le_bytes([header[2], header[3]]);
			if kind == 0x002f {
				return true;
			}
			if kind == 0x000a || stream.seek(SeekFrom::Current(i64::from(length))).is_err() {
				break;
			}
		}
	}
	false
}

/// Converts an OLE/BIFF workbook through anydoc's in-house BIFF reader.
/// Cached formula results are read, never evaluated; VBA is never executed.
pub(super) fn convert(bytes: &[u8]) -> Result<Str, MarkitError> {
	if workbook_is_encrypted(bytes) {
		return Err(MarkitError::conversion(FORMAT, "document is encrypted"));
	}
	let markdown = anydoc::to_markdown_bytes(bytes, anydoc::Format::Excel)
		.map_err(|error| MarkitError::conversion(FORMAT, error.to_string()))?;
	if markdown.len() > MAX_MARKDOWN_BYTES {
		return Err(MarkitError::conversion(
			FORMAT,
			format!(
				"resource limit exceeded (max_markdown_bytes): rendered workbook is {} bytes (limit \
				 {MAX_MARKDOWN_BYTES})",
				markdown.len()
			),
		));
	}
	Ok(Str::new(markdown))
}
