//! Snapshot-tag mismatch diagnostics.

use std::sync::LazyLock;

use regex::Regex;

use super::{
	format::HL_FILE_HASH_EXAMPLES,
	messages::{format_anchored_context, json_quote},
};
use crate::error::EditError;

static LINE_REF_RE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^\s*[>+\-*]*\s*(\d+)(?::.*)?\s*$").expect("valid regex"));

/// Context needed to explain a stale or unrecognized snapshot tag.
pub struct MismatchDetails {
	pub path:               Option<String>,
	pub expected_file_hash: String,
	pub actual_file_hash:   String,
	pub file_lines:         Vec<String>,
	pub anchor_lines:       Vec<u32>,
	pub hash_recognized:    bool,
}

/// Format the required shape of a tagged line anchor.
pub fn format_full_anchor_requirement(raw: Option<&str>) -> String {
	let received = raw.map_or_else(String::new, |value| format!(" Received {}.", json_quote(value)));
	format!(
		"a bare line number from read/search output plus the section header content-hash tag (for \
		 example [src/foo.ts#{}] and line \"160\"){received}",
		HL_FILE_HASH_EXAMPLES[0]
	)
}

/// Parse a decorated bare line-number reference.
pub fn parse_tag(reference: &str) -> Result<u32, EditError> {
	let Some(captures) = LINE_REF_RE.captures(reference) else {
		return Err(EditError::parse(format!(
			"Invalid line reference. Expected {}.",
			format_full_anchor_requirement(Some(reference))
		)));
	};
	let line = captures[1].parse::<u32>().map_err(|_| {
		EditError::parse(format!(
			"Invalid line reference. Expected {}.",
			format_full_anchor_requirement(Some(reference))
		))
	})?;
	if line < 1 {
		return Err(EditError::parse(format!(
			"Line number must be >= 1, got {line} in \"{reference}\"."
		)));
	}
	Ok(line)
}

/// Validate that a line reference exists in the target.
pub fn validate_line_ref(line: u32, file_lines: &[String]) -> Result<(), EditError> {
	if line < 1 || usize::try_from(line).map_or(true, |line| line > file_lines.len()) {
		return Err(EditError::matched(format!(
			"Line {line} does not exist (file has {} lines)",
			file_lines.len()
		)));
	}
	Ok(())
}

/// Format the complete model-facing snapshot mismatch diagnostic.
pub fn format_mismatch_message(details: &MismatchDetails) -> String {
	let path = details
		.path
		.as_ref()
		.map_or_else(String::new, |path| format!(" for {path}"));
	let mut lines = if details.hash_recognized {
		vec![
			format!("Edit rejected{path}: file changed between read and edit."),
			format!(
				"Section is bound to #{}, but the current file hashes to #{}. If a prior edit in this \
				 session modified this file, copy the [path#newhash] header from that edit's \
				 response; otherwise re-read the file with `read` to refresh the tag before retrying.",
				details.expected_file_hash, details.actual_file_hash
			),
		]
	} else {
		vec![
			format!(
				"Edit rejected{path}: hash #{} is not from this session.",
				details.expected_file_hash
			),
			format!(
				"The current file hashes to #{}. Re-read the file with `read` to copy a current \
				 [path#tag] header — never invent the tag and never reuse one from a prior session.",
				details.actual_file_hash
			),
		]
	};
	let context = format_anchored_context(&details.anchor_lines, &details.file_lines);
	if !context.is_empty() {
		lines.push(String::new());
		lines.extend(context);
	}
	lines.join("\n")
}

/// Construct a match failure from mismatch details.
pub fn mismatch_error(details: &MismatchDetails) -> EditError {
	EditError::matched(format_mismatch_message(details))
}
