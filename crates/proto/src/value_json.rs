//! JSON projections of `omp.inference.v1.Value` trees.
//!
//! `ToolResult.details` and other wire facets carry structured data as
//! protobuf `Value` trees; consumers that need `serde_json` views (journal
//! folds, UI payload decoding, ACP bridging) convert here instead of
//! hand-rolling per-crate copies.

use crate::inference::v1::{Value, ValueMap, value};

/// Converts a protobuf `Value` tree into a `serde_json::Value`.
///
/// Returns `None` when any node lacks a `kind` or a double is non-finite
/// (JSON cannot represent NaN/infinity).
pub fn value_to_json(value: &Value) -> Option<serde_json::Value> {
	match value.kind.as_ref()? {
		value::Kind::Null(_) => Some(serde_json::Value::Null),
		value::Kind::Int(number) => Some((*number).into()),
		value::Kind::Uint(number) => Some((*number).into()),
		value::Kind::Double(number) => serde_json::Number::from_f64(*number).map(Into::into),
		value::Kind::Bool(boolean) => Some((*boolean).into()),
		value::Kind::String(string) => Some(string.clone().into()),
		value::Kind::List(list) => list
			.values
			.iter()
			.map(value_to_json)
			.collect::<Option<Vec<_>>>()
			.map(Into::into),
		value::Kind::Map(map) => value_map_to_json(map).map(serde_json::Value::Object),
	}
}

/// Converts a protobuf `ValueMap` into a JSON object map.
///
/// Returns `None` under the same conditions as [`value_to_json`].
pub fn value_map_to_json(map: &ValueMap) -> Option<serde_json::Map<String, serde_json::Value>> {
	let mut object = serde_json::Map::with_capacity(map.fields.len());
	for (key, value) in &map.fields {
		object.insert(key.clone(), value_to_json(value)?);
	}
	Some(object)
}
