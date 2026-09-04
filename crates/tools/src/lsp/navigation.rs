//! Symbol targeting and bounded normalization for LSP navigation results.

use std::collections::BTreeMap;

use omp_core::{Str, StrMut};
use omp_proto::lsp::PositionEncoding;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

/// Parsed `symbol#N` target, where occurrence is one-based.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SymbolTarget {
	/// Identifier text.
	pub symbol:     Str,
	/// One-based occurrence on the requested line.
	pub occurrence: usize,
}

/// Parses an identifier target with an optional one-based `#N` suffix.
pub fn parse_symbol_target(value: &str) -> Result<SymbolTarget, &'static str> {
	let (symbol, occurrence) = match value.rsplit_once('#') {
		Some((symbol, occurrence))
			if !symbol.is_empty() && occurrence.bytes().all(|byte| byte.is_ascii_digit()) =>
		{
			let occurrence = occurrence
				.parse::<usize>()
				.map_err(|_| "symbol occurrence is too large")?;
			if occurrence == 0 {
				return Err("symbol occurrence must be one-based");
			}
			(symbol, occurrence)
		},
		_ => (value, 1),
	};
	if symbol.is_empty() || !symbol.chars().all(is_word_character) {
		return Err("symbol must contain only identifier word characters");
	}
	Ok(SymbolTarget { symbol: Str::from(symbol), occurrence })
}

/// Resolves a target's zero-based column in the negotiated LSP position
/// encoding on one source line.
pub fn resolve_symbol_column(
	line: &str,
	target: &SymbolTarget,
	encoding: PositionEncoding,
) -> Option<u32> {
	let bytes = line.as_bytes();
	let needle = target.symbol.as_bytes();
	let mut offset = 0;
	let mut occurrence = 0;
	while offset + needle.len() <= bytes.len() {
		let relative = bytes[offset..]
			.windows(needle.len())
			.position(|candidate| candidate == needle)?;
		let start = offset + relative;
		let end = start + needle.len();
		let left_boundary = start == 0 || !is_word_byte(bytes[start - 1]);
		let right_boundary = end == bytes.len() || !is_word_byte(bytes[end]);
		if left_boundary && right_boundary {
			occurrence += 1;
			if occurrence == target.occurrence {
				let prefix = line.get(..start)?;
				let units = match encoding {
					PositionEncoding::Utf8 => prefix.len(),
					PositionEncoding::Utf16 => prefix.encode_utf16().count(),
					PositionEncoding::Utf32 => prefix.chars().count(),
				};
				return u32::try_from(units).ok();
			}
		}
		offset = end;
	}
	None
}
#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn symbol_columns_follow_negotiated_position_encoding() {
		let line = r#"let _ = "😀"; foo();"#;
		let target = parse_symbol_target("foo").expect("valid target");
		assert_eq!(resolve_symbol_column(line, &target, PositionEncoding::Utf8), Some(16));
		assert_eq!(resolve_symbol_column(line, &target, PositionEncoding::Utf16), Some(14));
		assert_eq!(resolve_symbol_column(line, &target, PositionEncoding::Utf32), Some(13));
	}

	#[test]
	fn semantic_locations_are_grouped_and_one_based() {
		let locations = serde_json::json!([
			{"uri":"file:///tmp/a.rs","range":{"start":{"line":2,"character":4},"end":{"line":2,"character":7}}},
			{"uri":"file:///tmp/a.rs","range":{"start":{"line":8,"character":0},"end":{"line":8,"character":3}}},
			{"uri":"untitled:buffer","range":{"start":{"line":0,"character":1},"end":{"line":0,"character":2}}},
		]);
		let groups = group_locations(&locations);
		assert_eq!(groups.len(), 2);
		assert_eq!(groups[0].locations[0], LocationPoint { line: 3, col: 5 });
		let rendered = render_references(&locations);
		assert!(rendered.starts_with("Found 3 references:\n"));
		assert!(rendered.contains("/tmp/a.rs:3:5"));
		assert!(rendered.contains("untitled:buffer:1:2"));
		assert_eq!(render_locations("definition", &serde_json::json!([])), "No definition found");
		assert_eq!(render_references(&serde_json::json!([])), "No references found");
	}
}

const fn is_word_byte(byte: u8) -> bool {
	byte.is_ascii_alphanumeric() || byte == b'_'
}

fn is_word_character(character: char) -> bool {
	character == '_' || character.is_alphanumeric()
}

/// One model-independent location in a grouped navigation result.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocationPoint {
	/// One-based source line.
	pub line: u64,
	/// One-based source column.
	pub col:  u64,
}

/// Locations grouped by their decoded file path for semantic presentation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocationGroup {
	/// Local path when the URI is a file URL; otherwise the original URI.
	pub path:      Str,
	/// Locations in server response order.
	pub locations: Vec<LocationPoint>,
}

/// Normalizes LSP Location and `LocationLink` results to a bounded location
/// list.
pub fn normalize_locations(value: &Value, limit: usize) -> Vec<Value> {
	let values = value
		.as_array()
		.map_or_else(|| vec![value], |values| values.iter().collect());
	values
		.into_iter()
		.filter_map(|location| {
			if location.get("uri").is_some() && location.get("range").is_some() {
				return Some(location.clone());
			}
			let uri = location.get("targetUri")?.clone();
			let range = location
				.get("targetSelectionRange")
				.or_else(|| location.get("targetRange"))?
				.clone();
			Some(serde_json::json!({ "uri": uri, "range": range }))
		})
		.take(limit)
		.collect()
}

/// Groups normalized locations by decoded path without losing response order.
pub fn group_locations(value: &Value) -> Vec<LocationGroup> {
	let mut groups = Vec::<LocationGroup>::new();
	let mut indexes = BTreeMap::<Str, usize>::new();
	for location in value.as_array().into_iter().flatten() {
		let Some(uri) = location.get("uri").and_then(Value::as_str) else {
			continue;
		};
		let path = display_path(uri);
		let line = location
			.pointer("/range/start/line")
			.and_then(Value::as_u64)
			.unwrap_or_default()
			.saturating_add(1);
		let col = location
			.pointer("/range/start/character")
			.and_then(Value::as_u64)
			.unwrap_or_default()
			.saturating_add(1);
		let index = if let Some(index) = indexes.get(&path).copied() {
			index
		} else {
			let index = groups.len();
			indexes.insert(path.clone(), index);
			groups.push(LocationGroup { path, locations: Vec::new() });
			index
		};
		groups[index].locations.push(LocationPoint { line, col });
	}
	groups
}

/// Renders definition-style results with explicit counts and one-based
/// locations.
pub fn render_locations(noun: &str, value: &Value) -> Str {
	render_locations_with_empty(noun, noun, value)
}

/// Renders reference results with a plural empty state.
pub fn render_references(value: &Value) -> Str {
	render_locations_with_empty("reference", "references", value)
}

fn render_locations_with_empty(noun: &str, empty_noun: &str, value: &Value) -> Str {
	let groups = group_locations(value);
	let count = groups
		.iter()
		.map(|group| group.locations.len())
		.sum::<usize>();
	if count == 0 {
		return Str::from(format!("No {empty_noun} found"));
	}
	let mut output = StrMut::new("");
	output.push_str("Found ");
	output.push_str(count.to_string().as_str());
	output.push_str(" ");
	output.push_str(noun);
	output.push_str(if count == 1 { ":\n" } else { "s:\n" });
	for group in groups {
		for location in group.locations {
			output.push_str("  ");
			output.push_str(&group.path);
			output.push_str(":");
			output.push_str(location.line.to_string().as_str());
			output.push_str(":");
			output.push_str(location.col.to_string().as_str());
			output.push_str("\n");
		}
	}
	output.freeze()
}

fn display_path(uri: &str) -> Str {
	Url::parse(uri)
		.ok()
		.filter(|url| url.scheme() == "file")
		.and_then(|url| url.to_file_path().ok())
		.map_or_else(|| Str::from(uri), |path| Str::from(path.to_string_lossy().as_ref()))
}

/// Extracts Markdown, `MarkedString`, and plaintext hover contents.
pub fn hover_text(contents: &Value) -> Str {
	fn append(value: &Value, output: &mut String) {
		match value {
			Value::String(text) => output.push_str(text),
			Value::Array(values) => {
				for (index, value) in values.iter().enumerate() {
					if index > 0 {
						output.push_str("\n\n");
					}
					append(value, output);
				}
			},
			Value::Object(object) => {
				if let Some(Value::String(value)) = object.get("value") {
					output.push_str(value);
				}
			},
			_ => {},
		}
	}
	let mut output = String::new();
	append(contents, &mut output);
	Str::from(output)
}
