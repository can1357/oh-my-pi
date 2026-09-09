//! Semantic LSP result projection shared by model and enhanced TML views.

use omp_core::{Str, StrMut};
use serde_json::Value;

/// Stable `SymbolKind` label.
pub fn symbol_kind(kind: u64) -> &'static str {
	const LABELS: [&str; 27] = [
		"unknown",
		"file",
		"module",
		"namespace",
		"package",
		"class",
		"method",
		"property",
		"field",
		"constructor",
		"enum",
		"interface",
		"function",
		"variable",
		"constant",
		"string",
		"number",
		"boolean",
		"array",
		"object",
		"key",
		"null",
		"enum member",
		"struct",
		"event",
		"operator",
		"type parameter",
	];
	LABELS.get(kind as usize).copied().unwrap_or("symbol")
}

/// Bounded structural JSON projection with symbol labels and location lines.
pub fn structured(value: &Value, limit: usize) -> Str {
	let values = value
		.as_array()
		.map_or_else(|| vec![value], |values| values.iter().take(limit).collect());
	let mut output = StrMut::new("");
	for value in values {
		if let Some(name) = value.get("name").and_then(Value::as_str) {
			let kind = value
				.get("kind")
				.and_then(Value::as_u64)
				.map_or("symbol", symbol_kind);
			output.push_str(kind);
			output.push_str(" ");
			output.push_str(name);
			if let Some(line) = value
				.pointer("/location/range/start/line")
				.or_else(|| value.pointer("/range/start/line"))
				.and_then(Value::as_u64)
			{
				output.push_str(" @ line ");
				output.push_str((line + 1).to_string().as_str());
			}
			output.push_str("\n");
		} else if let Some(uri) = value.get("uri").and_then(Value::as_str) {
			output.push_str(uri);
			if let Some(line) = value.pointer("/range/start/line").and_then(Value::as_u64) {
				output.push_str(":");
				output.push_str((line + 1).to_string().as_str());
			}
			output.push_str("\n");
		} else {
			output.push_str(serde_json::to_string(value).unwrap_or_default().as_str());
			output.push_str("\n");
		}
	}
	output.freeze()
}
