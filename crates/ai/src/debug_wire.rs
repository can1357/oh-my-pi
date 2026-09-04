//! Bounded debug-wire projections.
//!
//! These helpers operate only on private diagnostic copies. Provider request
//! bodies and response semantics are never changed.

use omp_core::{Str, StrMut};
use serde_json::{Map, Value};

const ELISION_PREFIX: &str = "\n… [OMP DEBUG WIRE ELIDED ";
const ELISION_SUFFIX: &str = " BYTES] …\n";

/// Removes presentation-only JSON Schema weight from a debug copy.
///
/// Validation-bearing keywords (`type`, `required`, `properties`, bounds,
/// enums, combinators) are preserved. Descriptions, examples, titles, defaults,
/// and schema IDs are not useful in raw-wire inspection and are dropped.
pub fn shrink_tool_schema(value: &mut Value) {
	match value {
		Value::Array(values) => {
			for value in values {
				shrink_tool_schema(value);
			}
		},
		Value::Object(object) => {
			for key in ["description", "title", "examples", "default", "$id", "$schema"] {
				object.remove(key);
			}
			collapse_nullable_type(object);
			for value in object.values_mut() {
				shrink_tool_schema(value);
			}
		},
		Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {},
	}
}

/// Returns a UTF-8-safe head/tail projection with an explicit byte-count
/// elision marker. Inputs at or below `max_bytes` are copied unchanged.
pub fn trim_wire_text(text: &str, max_bytes: usize) -> String {
	if text.len() <= max_bytes {
		return text.to_owned();
	}
	let marker_budget = ELISION_PREFIX.len() + 20 + ELISION_SUFFIX.len();
	if max_bytes <= marker_budget + 2 {
		return "[OMP DEBUG WIRE ELIDED]"[..max_bytes.min(24)].to_owned();
	}
	let content_budget = max_bytes - marker_budget;
	let head_budget = content_budget.saturating_mul(2) / 3;
	let tail_budget = content_budget.saturating_sub(head_budget);
	let head_end = floor_char_boundary(text, head_budget);
	let tail_start = ceil_char_boundary(text, text.len().saturating_sub(tail_budget));
	let omitted = tail_start.saturating_sub(head_end);
	let mut output = String::with_capacity(max_bytes);
	output.push_str(&text[..head_end]);
	output.push_str(ELISION_PREFIX);
	output.push_str(&omitted.to_string());
	output.push_str(ELISION_SUFFIX);
	output.push_str(&text[tail_start..]);
	output
}

/// Appends a sanitized response-metadata comment to a debug payload.
///
/// Metadata values are escaped so they cannot terminate the private comment.
pub fn response_metadata_comment(
	provider_request_id: Option<&str>,
	status: Option<u16>,
	model: Option<&str>,
) -> Str {
	let mut output = StrMut::new("");
	output.push_str("<!-- omp-response");
	if let Some(status) = status {
		output.push_str(" status=");
		output.push_str(&status.to_string());
	}
	if let Some(request_id) = provider_request_id {
		output.push_str(" request-id=\"");
		push_comment_escaped(&mut output, request_id);
		output.push('"');
	}
	if let Some(model) = model {
		output.push_str(" model=\"");
		push_comment_escaped(&mut output, model);
		output.push('"');
	}
	output.push_str(" -->");
	output.freeze()
}

fn collapse_nullable_type(object: &mut Map<String, Value>) {
	let Some(Value::Array(types)) = object.get_mut("type") else {
		return;
	};
	if types.len() != 2 || !types.iter().any(|value| value.as_str() == Some("null")) {
		return;
	}
	let Some(non_null) = types
		.iter()
		.find(|value| value.as_str() != Some("null"))
		.cloned()
	else {
		return;
	};
	object.insert("type".to_owned(), non_null);
	object.insert("nullable".to_owned(), Value::Bool(true));
}

fn floor_char_boundary(text: &str, mut index: usize) -> usize {
	index = index.min(text.len());
	while !text.is_char_boundary(index) {
		index -= 1;
	}
	index
}

fn ceil_char_boundary(text: &str, mut index: usize) -> usize {
	index = index.min(text.len());
	while index < text.len() && !text.is_char_boundary(index) {
		index += 1;
	}
	index
}

fn push_comment_escaped(output: &mut StrMut, value: &str) {
	for character in value.chars().take(256) {
		match character {
			'"' => output.push_str("&quot;"),
			'<' => output.push_str("&lt;"),
			'>' => output.push_str("&gt;"),
			'&' => output.push_str("&amp;"),
			'\r' | '\n' => output.push(' '),
			_ if !character.is_control() => output.push(character),
			_ => {},
		}
	}
}
