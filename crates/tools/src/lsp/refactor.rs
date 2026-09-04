//! Workspace-edit validation and deterministic rename previews.

use std::collections::HashSet;

use omp_core::{Str, StrMut};
use serde_json::Value;

/// Validates an LSP `WorkspaceEdit` before it crosses the transaction boundary.
pub fn validate_workspace_edit(edit: &Value) -> Result<(), &'static str> {
	let mut seen = HashSet::new();
	if let Some(changes) = edit.get("changes").and_then(Value::as_object) {
		for (uri, edits) in changes {
			validate_text_edits(uri, edits, &mut seen)?;
		}
	}
	if let Some(changes) = edit.get("documentChanges").and_then(Value::as_array) {
		if changes.len() > 1_000 {
			return Err("workspace edit exceeds the 1000-file bound");
		}
		for change in changes {
			if change.get("kind").is_none() {
				let uri = change
					.pointer("/textDocument/uri")
					.and_then(Value::as_str)
					.ok_or("text edit omitted URI")?;
				validate_text_edits(uri, change.get("edits").unwrap_or(&Value::Null), &mut seen)?;
			}
		}
	}
	Ok(())
}

fn validate_text_edits(
	uri: &str,
	edits: &Value,
	seen: &mut HashSet<(Str, u64, u64, u64, u64, Str)>,
) -> Result<(), &'static str> {
	let mut ranges = Vec::new();
	for edit in edits
		.as_array()
		.ok_or("workspace text edits must be an array")?
	{
		if edit.get("insertTextFormat").and_then(Value::as_u64) == Some(2)
			|| edit
				.get("newText")
				.and_then(Value::as_str)
				.is_some_and(|text| text.contains("${"))
		{
			return Err("snippet edits are not supported");
		}
		let range = edit.get("range").ok_or("text edit omitted range")?;
		let coordinates = (
			range
				.pointer("/start/line")
				.and_then(Value::as_u64)
				.ok_or("invalid range")?,
			range
				.pointer("/start/character")
				.and_then(Value::as_u64)
				.ok_or("invalid range")?,
			range
				.pointer("/end/line")
				.and_then(Value::as_u64)
				.ok_or("invalid range")?,
			range
				.pointer("/end/character")
				.and_then(Value::as_u64)
				.ok_or("invalid range")?,
		);
		let text = Str::from(
			edit
				.get("newText")
				.and_then(Value::as_str)
				.ok_or("text edit omitted newText")?,
		);
		if !seen.insert((
			Str::from(uri),
			coordinates.0,
			coordinates.1,
			coordinates.2,
			coordinates.3,
			text,
		)) {
			continue;
		}
		ranges.push(coordinates);
	}
	ranges.sort_unstable();
	for pair in ranges.windows(2) {
		let left_end = (pair[0].2, pair[0].3);
		let right_start = (pair[1].0, pair[1].1);
		if left_end > right_start {
			return Err("workspace edit contains overlapping ranges");
		}
	}
	Ok(())
}

/// Produces a bounded deterministic dry-run summary.
pub fn preview(edit: &Value) -> Str {
	let mut output = StrMut::new("");
	if let Some(changes) = edit.get("changes").and_then(Value::as_object) {
		for (uri, edits) in changes {
			output.push_str(uri);
			output.push_str(": ");
			output.push_str(edits.as_array().map_or(0, Vec::len).to_string().as_str());
			output.push_str(" edit(s)\n");
		}
	}
	if let Some(changes) = edit.get("documentChanges").and_then(Value::as_array) {
		output.push_str(changes.len().to_string().as_str());
		output.push_str(" ordered document/resource change(s)\n");
	}
	output.freeze()
}
