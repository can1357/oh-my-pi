//! Structured child-output validation against a caller-provided JSON Schema.
//!
//! `task@1` accepts an invocation-specific `outputSchema`; the spawner
//! validates every child's terminal `yield` data against it before the child
//! result settles.  The validator covers the JSON Schema 2020-12 keywords
//! providers and callers actually emit for tool output (`type`, `properties`,
//! `required`, `additionalProperties`, `items`, `prefixItems`, `enum`, `const`,
//! `anyOf`, `oneOf`, `allOf`, `not`, `minItems`, `maxItems`, `minLength`,
//! `maxLength`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`,
//! `pattern`, `$ref` to `#/$defs/…` or `#/definitions/…`, and boolean schemas).
//! Unknown keywords are ignored, matching the specification's open vocabulary.

use omp_core::{Str, sf};
use serde_json::{Map, Value};

/// Requested enforcement for an effective output schema.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	serde::Deserialize,
	Eq,
	PartialEq,
	schemars::JsonSchema,
	serde::Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum SchemaMode {
	/// Keep bounded invalid output and surface the violation as a warning.
	#[default]
	Permissive,
	/// Turn every invalid final payload into a failed child.
	Strict,
}

/// Validation status of one child's structured output.
#[derive(
	Clone,
	Copy,
	Debug,
	serde::Deserialize,
	Eq,
	PartialEq,
	schemars::JsonSchema,
	serde::Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum OutputStatus {
	/// Data satisfied the effective schema.
	Valid,
	/// Data violated the effective schema.
	Invalid,
	/// The schema itself was unusable, so no verdict exists.
	Unavailable,
}

/// One schema violation, located by JSON pointer.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize, thiserror::Error)]
#[error("output schema violation at `{pointer}`: {reason}")]
pub struct SchemaViolation {
	/// JSON pointer to the offending value (`""` is the root).
	pub pointer: Str,
	/// Human-readable reason, bounded to one keyword.
	pub reason:  Str,
}

/// Structural defect in the caller-provided schema.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum SchemaError {
	/// The schema is neither an object nor a boolean.
	#[error("output schema must be an object or boolean")]
	NotASchema,
	/// A `$ref` pointed outside the local `$defs`/`definitions` table.
	#[error("unresolvable schema reference `{reference}`")]
	UnresolvedRef {
		/// The unresolved `$ref` string.
		reference: Str,
	},
	/// A `pattern` keyword was not a valid regular expression.
	#[error("invalid `pattern` regular expression at `{pointer}`")]
	InvalidPattern {
		/// JSON pointer to the schema carrying the pattern.
		pointer: Str,
	},
}

const _: () = assert!(size_of::<SchemaViolation>() <= 64, "SchemaViolation must stay compact");

/// Validates `data` against `schema`.
///
/// Returns the first violation found in document order; the schema is
/// checked for structural defects as references are followed.
pub fn validate(schema: &Value, data: &Value) -> Result<Result<(), SchemaViolation>, SchemaError> {
	let mut path = String::new();
	let root = schema;
	check(root, schema, data, &mut path)
}

/// Extracts the effective output schema from a caller-provided value.
///
/// `true`/`{}` accept anything, `false` rejects everything, strings are parsed
/// as JSON, and `null` means "no schema".
pub fn normalize(raw: &Value) -> Result<Option<Value>, SchemaError> {
	match raw {
		Value::Null => Ok(None),
		Value::Bool(_) | Value::Object(_) => Ok(Some(raw.clone())),
		Value::String(text) => match serde_json::from_str::<Value>(text) {
			Ok(parsed @ (Value::Bool(_) | Value::Object(_))) => Ok(Some(parsed)),
			_ => Err(SchemaError::NotASchema),
		},
		_ => Err(SchemaError::NotASchema),
	}
}

/// Names the top-level required properties of an object schema.
pub fn required_fields(schema: &Value) -> impl Iterator<Item = &str> + '_ {
	schema
		.get("required")
		.and_then(Value::as_array)
		.into_iter()
		.flatten()
		.filter_map(Value::as_str)
}

fn check(
	root: &Value,
	schema: &Value,
	data: &Value,
	path: &mut String,
) -> Result<Result<(), SchemaViolation>, SchemaError> {
	let object = match schema {
		Value::Bool(true) => return Ok(Ok(())),
		Value::Bool(false) => return Ok(Err(violation(path, sf!("schema rejects every value")))),
		Value::Object(object) => object,
		_ => return Err(SchemaError::NotASchema),
	};
	if let Some(reference) = object.get("$ref").and_then(Value::as_str) {
		let target = resolve_ref(root, reference)?;
		if let Err(error) = check(root, target, data, path)? {
			return Ok(Err(error));
		}
	}
	if let Some(expected) = object.get("type")
		&& !type_matches(expected, data)
	{
		return Ok(Err(violation(path, sf!("expected type {expected}, found {}", type_name(data)))));
	}
	if let Some(expected) = object.get("const")
		&& expected != data
	{
		return Ok(Err(violation(path, sf!("expected constant {expected}"))));
	}
	if let Some(choices) = object.get("enum").and_then(Value::as_array)
		&& !choices.contains(data)
	{
		return Ok(Err(violation(path, sf!("value is not one of the enumerated choices"))));
	}
	if let Some(branches) = object.get("allOf").and_then(Value::as_array) {
		for branch in branches {
			if let Err(error) = check(root, branch, data, path)? {
				return Ok(Err(error));
			}
		}
	}
	if let Some(branches) = object.get("anyOf").and_then(Value::as_array) {
		let mut matched = false;
		for branch in branches {
			if check(root, branch, data, path)?.is_ok() {
				matched = true;
				break;
			}
		}
		if !matched {
			return Ok(Err(violation(path, sf!("value matches no `anyOf` branch"))));
		}
	}
	if let Some(branches) = object.get("oneOf").and_then(Value::as_array) {
		let mut matched = 0usize;
		for branch in branches {
			if check(root, branch, data, path)?.is_ok() {
				matched += 1;
			}
		}
		if matched != 1 {
			return Ok(Err(violation(path, sf!("value matches {matched} `oneOf` branches"))));
		}
	}
	if let Some(negated) = object.get("not")
		&& check(root, negated, data, path)?.is_ok()
	{
		return Ok(Err(violation(path, sf!("value matches the `not` schema"))));
	}
	match data {
		Value::Object(fields) => check_object(root, object, fields, path),
		Value::Array(items) => check_array(root, object, items, path),
		Value::String(text) => Ok(check_string(object, text, path)?),
		Value::Number(number) => Ok(check_number(object, number.as_f64().unwrap_or(0.0), path)),
		Value::Null | Value::Bool(_) => Ok(Ok(())),
	}
}

fn check_object(
	root: &Value,
	schema: &Map<String, Value>,
	fields: &Map<String, Value>,
	path: &mut String,
) -> Result<Result<(), SchemaViolation>, SchemaError> {
	for name in schema
		.get("required")
		.and_then(Value::as_array)
		.into_iter()
		.flatten()
		.filter_map(Value::as_str)
	{
		if !fields.contains_key(name) {
			return Ok(Err(violation(path, sf!("missing required property `{name}`"))));
		}
	}
	let properties = schema.get("properties").and_then(Value::as_object);
	let additional = schema.get("additionalProperties");
	for (name, value) in fields {
		let declared = properties.and_then(|properties| properties.get(name));
		let subschema = match (declared, additional) {
			(Some(subschema), _) => subschema,
			(None, Some(Value::Bool(false))) => {
				return Ok(Err(violation(path, sf!("unexpected property `{name}`"))));
			},
			(None, Some(subschema @ Value::Object(_))) => subschema,
			(None, _) => continue,
		};
		let mark = path.len();
		push_segment(path, name);
		let outcome = check(root, subschema, value, path)?;
		path.truncate(mark);
		if let Err(error) = outcome {
			return Ok(Err(error));
		}
	}
	Ok(Ok(()))
}

fn check_array(
	root: &Value,
	schema: &Map<String, Value>,
	items: &[Value],
	path: &mut String,
) -> Result<Result<(), SchemaViolation>, SchemaError> {
	if let Some(min) = schema.get("minItems").and_then(Value::as_u64)
		&& (items.len() as u64) < min
	{
		return Ok(Err(violation(path, sf!("expected at least {min} items"))));
	}
	if let Some(max) = schema.get("maxItems").and_then(Value::as_u64)
		&& (items.len() as u64) > max
	{
		return Ok(Err(violation(path, sf!("expected at most {max} items"))));
	}
	let prefix = schema
		.get("prefixItems")
		.and_then(Value::as_array)
		.map_or(&[][..], Vec::as_slice);
	let rest = schema.get("items");
	for (index, item) in items.iter().enumerate() {
		let subschema = match (prefix.get(index), rest) {
			(Some(subschema), _) => subschema,
			(None, Some(subschema)) => subschema,
			(None, None) => continue,
		};
		let mark = path.len();
		push_index(path, index);
		let outcome = check(root, subschema, item, path)?;
		path.truncate(mark);
		if let Err(error) = outcome {
			return Ok(Err(error));
		}
	}
	Ok(Ok(()))
}

fn check_string(
	schema: &Map<String, Value>,
	text: &str,
	path: &str,
) -> Result<Result<(), SchemaViolation>, SchemaError> {
	let length = text.chars().count() as u64;
	if let Some(min) = schema.get("minLength").and_then(Value::as_u64)
		&& length < min
	{
		return Ok(Err(violation(path, sf!("expected at least {min} characters"))));
	}
	if let Some(max) = schema.get("maxLength").and_then(Value::as_u64)
		&& length > max
	{
		return Ok(Err(violation(path, sf!("expected at most {max} characters"))));
	}
	if let Some(pattern) = schema.get("pattern").and_then(Value::as_str) {
		let regex = regex::Regex::new(pattern)
			.map_err(|_| SchemaError::InvalidPattern { pointer: Str::new(path) })?;
		if !regex.is_match(text) {
			return Ok(Err(violation(path, sf!("value does not match pattern `{pattern}`"))));
		}
	}
	Ok(Ok(()))
}

fn check_number(
	schema: &Map<String, Value>,
	value: f64,
	path: &str,
) -> Result<(), SchemaViolation> {
	if let Some(min) = schema.get("minimum").and_then(Value::as_f64)
		&& value < min
	{
		return Err(violation(path, sf!("expected a value >= {min}")));
	}
	if let Some(max) = schema.get("maximum").and_then(Value::as_f64)
		&& value > max
	{
		return Err(violation(path, sf!("expected a value <= {max}")));
	}
	if let Some(min) = schema.get("exclusiveMinimum").and_then(Value::as_f64)
		&& value <= min
	{
		return Err(violation(path, sf!("expected a value > {min}")));
	}
	if let Some(max) = schema.get("exclusiveMaximum").and_then(Value::as_f64)
		&& value >= max
	{
		return Err(violation(path, sf!("expected a value < {max}")));
	}
	Ok(())
}

fn type_matches(expected: &Value, data: &Value) -> bool {
	match expected {
		Value::String(name) => type_name_matches(name, data),
		Value::Array(names) => names
			.iter()
			.filter_map(Value::as_str)
			.any(|name| type_name_matches(name, data)),
		_ => true,
	}
}

fn type_name_matches(name: &str, data: &Value) -> bool {
	match name {
		"object" => data.is_object(),
		"array" => data.is_array(),
		"string" => data.is_string(),
		"number" => data.is_number(),
		"integer" => data.as_i64().is_some() || data.as_u64().is_some(),
		"boolean" => data.is_boolean(),
		"null" => data.is_null(),
		_ => true,
	}
}

const fn type_name(data: &Value) -> &'static str {
	match data {
		Value::Null => "null",
		Value::Bool(_) => "boolean",
		Value::Number(_) => "number",
		Value::String(_) => "string",
		Value::Array(_) => "array",
		Value::Object(_) => "object",
	}
}

fn resolve_ref<'s>(root: &'s Value, reference: &str) -> Result<&'s Value, SchemaError> {
	let unresolved = || SchemaError::UnresolvedRef { reference: Str::new(reference) };
	let pointer = reference.strip_prefix('#').ok_or_else(unresolved)?;
	if pointer.is_empty() {
		return Ok(root);
	}
	root.pointer(pointer).ok_or_else(unresolved)
}

fn push_segment(path: &mut String, name: &str) {
	path.push('/');
	for ch in name.chars() {
		match ch {
			'~' => path.push_str("~0"),
			'/' => path.push_str("~1"),
			other => path.push(other),
		}
	}
}

fn push_index(path: &mut String, index: usize) {
	use std::fmt::Write as _;
	let _ = write!(path, "/{index}");
}

fn violation(path: &str, reason: Str) -> SchemaViolation {
	SchemaViolation { pointer: Str::new(path), reason }
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::*;

	fn ok(schema: &Value, data: &Value) -> bool {
		validate(schema, data).expect("schema is usable").is_ok()
	}

	fn pointer(schema: &Value, data: &Value) -> Str {
		validate(schema, data)
			.expect("schema is usable")
			.expect_err("data must be rejected")
			.pointer
	}

	#[test]
	fn required_properties_and_types_are_enforced() {
		let schema = json!({
			"type": "object",
			"properties": {
				"count": {"type": "integer", "minimum": 1},
				"name": {"type": "string", "minLength": 2}
			},
			"required": ["count", "name"],
			"additionalProperties": false
		});
		assert!(ok(&schema, &json!({"count": 3, "name": "ab"})));
		assert_eq!(pointer(&schema, &json!({"name": "ab"})), "");
		assert_eq!(pointer(&schema, &json!({"count": 0, "name": "ab"})), "/count");
		assert_eq!(pointer(&schema, &json!({"count": 1, "name": "a"})), "/name");
		assert_eq!(pointer(&schema, &json!({"count": 1, "name": "ab", "x": 1})), "");
		assert_eq!(pointer(&schema, &json!({"count": 1.5, "name": "ab"})), "/count");
	}

	#[test]
	fn arrays_enums_and_combinators_are_enforced() {
		let schema = json!({
			"type": "object",
			"properties": {
				"tags": {"type": "array", "items": {"enum": ["a", "b"]}, "minItems": 1},
				"kind": {"oneOf": [{"const": "x"}, {"type": "integer"}]},
				"note": {"anyOf": [{"type": "string"}, {"type": "null"}]}
			},
			"required": ["tags"]
		});
		assert!(ok(&schema, &json!({"tags": ["a"], "kind": "x", "note": null})));
		assert_eq!(pointer(&schema, &json!({"tags": []})), "/tags");
		assert_eq!(pointer(&schema, &json!({"tags": ["c"]})), "/tags/0");
		assert_eq!(pointer(&schema, &json!({"tags": ["a"], "kind": true})), "/kind");
		assert_eq!(pointer(&schema, &json!({"tags": ["a"], "note": 1})), "/note");
	}

	#[test]
	fn local_refs_resolve_and_foreign_refs_are_errors() {
		let schema = json!({
			"$defs": {"item": {"type": "object", "required": ["id"]}},
			"type": "array",
			"items": {"$ref": "#/$defs/item"}
		});
		assert!(ok(&schema, &json!([{"id": 1}])));
		assert_eq!(pointer(&schema, &json!([{"id": 1}, {}])), "/1");
		let foreign = json!({"$ref": "https://example.invalid/schema.json"});
		assert_eq!(
			validate(&foreign, &json!({})),
			Err(SchemaError::UnresolvedRef { reference: sf!("https://example.invalid/schema.json") })
		);
	}

	#[test]
	fn patterns_lengths_and_boolean_schemas_behave() {
		let schema = json!({"type": "string", "pattern": "^[a-z]+$", "maxLength": 3});
		assert!(ok(&schema, &json!("abc")));
		assert_eq!(pointer(&schema, &json!("abcd")), "");
		assert_eq!(pointer(&schema, &json!("ABC")), "");
		assert!(ok(&json!(true), &json!(42)));
		assert_eq!(pointer(&json!(false), &json!(42)), "");
		assert_eq!(
			validate(&json!({"type": "string", "pattern": "("}), &json!("x")),
			Err(SchemaError::InvalidPattern { pointer: sf!("") })
		);
	}

	#[test]
	fn normalize_accepts_objects_booleans_and_json_strings() {
		assert_eq!(normalize(&json!(null)), Ok(None));
		assert_eq!(normalize(&json!(true)), Ok(Some(json!(true))));
		assert_eq!(normalize(&json!("{\"type\":\"object\"}")), Ok(Some(json!({"type": "object"}))));
		assert_eq!(normalize(&json!("not json")), Err(SchemaError::NotASchema));
		assert_eq!(normalize(&json!(7)), Err(SchemaError::NotASchema));
	}
}
