//! Hashline syntax constants and display helpers.

use super::types::Cursor;

/// File-header opening delimiter.
pub const HL_FILE_PREFIX: &str = "[";
/// File-header closing delimiter.
pub const HL_FILE_SUFFIX: &str = "]";
/// Literal payload-row sigil.
pub const HL_PAYLOAD_REPLACE: &str = "+";
/// Write-hunk keyword.
pub const HL_PUT_KEYWORD: &str = "PUT";
/// Cut-hunk keyword.
pub const HL_CUT_KEYWORD: &str = "CUT";
/// Whole-file removal keyword.
pub const HL_REM_KEYWORD: &str = "REM";
/// Whole-file move keyword.
pub const HL_MOVE_KEYWORD: &str = "MV";
/// Header/body delimiter.
pub const HL_HEADER_COLON: &str = ":";
/// Before-anchor gap sigil.
pub const HL_GAP_BEFORE: &str = "<";
/// After-anchor gap sigil.
pub const HL_GAP_AFTER: &str = ">";
/// Syntactic-block locator suffix.
pub const HL_BLOCK_SUFFIX: &str = "*";
/// End-of-file anchor.
pub const HL_EOF_ANCHOR: &str = "$";
/// Clipboard-register sigil.
pub const HL_REGISTER_SIGIL: &str = "@";
/// Path/tag separator.
pub const HL_FILE_HASH_SEP: &str = "#";
/// Canonical inclusive-range separator.
pub const HL_RANGE_SEP: &str = ".=";
/// Numbered-line body separator.
pub const HL_LINE_BODY_SEP: &str = ":";
/// Regex source for a positive line number.
pub const HL_LINE_RE_RAW: &str = r"[1-9]\d*";
/// Capturing regex source for a positive line number.
pub const HL_LINE_CAPTURE_RE_RAW: &str = r"([1-9]\d*)";
/// Number of hexadecimal characters in a snapshot tag.
pub const HL_FILE_HASH_LENGTH: usize = 4;
/// Regex source for a snapshot tag.
pub const HL_FILE_HASH_RE_RAW: &str = r"[0-9A-F]{4}";
/// Capturing regex source for a snapshot tag.
pub const HL_FILE_HASH_CAPTURE_RE_RAW: &str = r"([0-9A-F]{4})";
/// Regex-escaped numbered-line separator.
pub const HL_LINE_BODY_SEP_RE_RAW: &str = ":";
/// Representative snapshot tags used in diagnostics.
pub const HL_FILE_HASH_EXAMPLES: [&str; 3] = ["1A2B", "3C4D", "9F3E"];

/// Format a concrete replacement hunk header.
pub fn format_replace_header(start: u32, end: u32) -> String {
	format!("PUT {start}.={end}:")
}
/// Format a concrete cut hunk header.
pub fn format_cut_header(start: u32, end: u32) -> String {
	format!("CUT {start}.={end}")
}
/// Format a gap locator.
pub fn format_gap_locator(cursor: Cursor) -> String {
	match cursor {
		Cursor::Bof => "<1".into(),
		Cursor::Eof => ">$".into(),
		Cursor::BeforeAnchor(a) => format!("<{}", a.line),
		Cursor::AfterAnchor(a) => format!(">{}", a.line),
	}
}
/// Format an insertion hunk header.
pub fn format_insert_header(cursor: Cursor) -> String {
	format!("PUT {}:", format_gap_locator(cursor))
}
/// Format a named clipboard register.
pub fn format_register(name: &str) -> String {
	format!("@{name}")
}
/// Format representative line anchors for a diagnostic.
pub fn describe_anchor_examples(line_prefix: &str) -> String {
	let examples = if line_prefix.is_empty() {
		["160".to_string(), "42".to_string(), "7".to_string()]
	} else {
		let shortened = line_prefix
			.char_indices()
			.next_back()
			.map_or("4", |(index, _)| &line_prefix[..index]);
		[
			line_prefix.to_string(),
			format!("{}2", if shortened.is_empty() { "4" } else { shortened }),
			"7".to_string(),
		]
	};
	examples.map(|example| format!("\"{example}\"")).join(", ")
}
/// Format a file section header.
pub fn format_hashline_header(path: &str, tag: &str) -> String {
	format!("[{path}#{tag}]")
}
/// Format one numbered source line.
pub fn format_numbered_line(line_number: u32, line: &str) -> String {
	format!("{line_number}:{line}")
}
/// Split text into lines addressable by hashline anchors.
pub fn split_addressable_file_lines(text: &str) -> Vec<&str> {
	let mut lines: Vec<_> = text.split('\n').collect();
	if text.ends_with('\n') {
		lines.pop();
	}
	lines
}
/// Format every LF-delimited row, including a terminal blank sentinel.
pub fn format_numbered_lines(text: &str, start_line: u32) -> String {
	text
		.split('\n')
		.enumerate()
		.map(|(index, line)| {
			format_numbered_line(
				start_line.saturating_add(u32::try_from(index).unwrap_or(u32::MAX)),
				line,
			)
		})
		.collect::<Vec<_>>()
		.join("\n")
}
/// Compute the normalized four-hex content tag.
pub use crate::store::file_hash as compute_file_hash;
