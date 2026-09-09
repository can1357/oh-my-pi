//! Provider-dialect JSON Schema normalization for OpenAI-compatible strict
//! modes.

use serde_json::{Map, Value};

/// JSON Schema dialect selected by the routed codec.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SchemaDialect {
	/// Chat Completions function and response schemas.
	OpenAiChat,
	/// Responses function and response schemas.
	OpenAiResponses,
}

/// Typed reason why requested strict enforcement was not emitted.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StrictFallbackReason {
	/// The compiled route capability was false or unknown.
	Unsupported,
	/// Preserving the declared schema semantics is impossible in strict mode.
	Unrepresentable,
}

impl StrictFallbackReason {
	pub(crate) const fn reason_id(self) -> &'static str {
		match self {
			Self::Unsupported => "catalog.strict-schema-unsupported",
			Self::Unrepresentable => "schema.strict-schema-unrepresentable",
		}
	}
}

/// Schema and strict flag after one route-selected dialect projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SchemaProjection {
	pub(crate) schema:   Value,
	/// `None` means the route must not receive a `strict` field.
	pub(crate) strict:   Option<bool>,
	pub(crate) fallback: Option<StrictFallbackReason>,
}

/// Normalizes a schema once for the selected provider dialect and strict
/// capability.
///
/// Unknown capability is deliberately unsupported (ADR 0017). A strict schema
/// that cannot be represented without changing its accepted values is sent
/// non-strict with a typed fallback reason (ADR 0021).
pub fn normalize_schema(
	schema: &Value,
	requested_strict: bool,
	strict_capability: Option<bool>,
	dialect: SchemaDialect,
) -> SchemaProjection {
	let dialect_schema = normalize_dialect(schema, dialect);
	if strict_capability != Some(true) {
		return SchemaProjection {
			schema:   dialect_schema,
			strict:   None,
			fallback: requested_strict.then_some(StrictFallbackReason::Unsupported),
		};
	}
	if !requested_strict {
		return SchemaProjection { schema: dialect_schema, strict: Some(false), fallback: None };
	}
	match enforce_strict(&dialect_schema) {
		Some(schema) => SchemaProjection { schema, strict: Some(true), fallback: None },
		None => SchemaProjection {
			schema:   dialect_schema,
			strict:   Some(false),
			fallback: Some(StrictFallbackReason::Unrepresentable),
		},
	}
}

fn normalize_dialect(schema: &Value, dialect: SchemaDialect) -> Value {
	match dialect {
		SchemaDialect::OpenAiChat => schema.clone(),
		SchemaDialect::OpenAiResponses => normalize_responses_node(schema),
	}
}

fn normalize_responses_node(value: &Value) -> Value {
	let Value::Object(object) = value else {
		return value.clone();
	};
	let mut output = Map::with_capacity(object.len().saturating_add(1));
	for (key, child) in object {
		if key == "oneOf" && child.is_array() {
			continue;
		}
		let normalized = match key.as_str() {
			"properties" | "patternProperties" | "dependentSchemas" | "$defs" | "definitions" => {
				normalize_schema_map(child)
			},
			"items"
			| "additionalItems"
			| "contains"
			| "contentSchema"
			| "propertyNames"
			| "if"
			| "then"
			| "else"
			| "not"
			| "additionalProperties"
			| "unevaluatedItems"
			| "unevaluatedProperties" => normalize_responses_node(child),
			"anyOf" | "allOf" | "prefixItems" => normalize_schema_array(child),
			_ => child.clone(),
		};
		output.insert(key.clone(), normalized);
	}
	if let Some(Value::Array(one_of)) = object.get("oneOf") {
		let mut branches = output
			.remove("anyOf")
			.and_then(|value| value.as_array().cloned())
			.unwrap_or_default();
		branches.extend(one_of.iter().map(normalize_responses_node));
		output.insert("anyOf".into(), Value::Array(branches));
	}
	if declares_object(object.get("type")) && !object.contains_key("properties") {
		output.insert("properties".into(), Value::Object(Map::new()));
	}
	Value::Object(output)
}

fn normalize_schema_map(value: &Value) -> Value {
	let Value::Object(object) = value else {
		return value.clone();
	};
	Value::Object(
		object
			.iter()
			.map(|(name, schema)| (name.clone(), normalize_responses_node(schema)))
			.collect(),
	)
}

fn normalize_schema_array(value: &Value) -> Value {
	let Value::Array(values) = value else {
		return value.clone();
	};
	Value::Array(values.iter().map(normalize_responses_node).collect())
}

fn declares_object(value: Option<&Value>) -> bool {
	matches!(value, Some(Value::String(kind)) if kind == "object")
		|| matches!(value, Some(Value::Array(kinds)) if kinds.iter().any(|kind| kind == "object"))
}

const STRICT_FORBIDDEN_KEYS: &[&str] = &[
	"format",
	"pattern",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"minItems",
	"maxItems",
	"uniqueItems",
	"multipleOf",
	"$schema",
	"examples",
	"default",
	"title",
	"$comment",
	"if",
	"then",
	"else",
	"not",
	"unevaluatedProperties",
	"unevaluatedItems",
	"patternProperties",
	"propertyNames",
	"contains",
	"minContains",
	"maxContains",
	"dependentRequired",
	"dependentSchemas",
	"contentEncoding",
	"contentMediaType",
	"contentSchema",
	"deprecated",
	"readOnly",
	"writeOnly",
	"minProperties",
	"maxProperties",
	"$dynamicRef",
	"$dynamicAnchor",
	"nullable",
];

fn enforce_strict(schema: &Value) -> Option<Value> {
	if has_unrepresentable_open_map(schema) {
		return None;
	}
	strict_node(schema)
}

fn has_unrepresentable_open_map(value: &Value) -> bool {
	let Value::Object(object) = value else {
		return matches!(value, Value::Bool(_));
	};
	if object.is_empty()
		|| object.contains_key("patternProperties")
		|| (object.contains_key("$ref") && object.len() > 1)
		|| matches!(object.get("additionalProperties"), Some(value) if value != &Value::Bool(false))
	{
		return true;
	}
	for (key, child) in object {
		let incompatible = match key.as_str() {
			"properties" | "dependentSchemas" | "$defs" | "definitions" => child
				.as_object()
				.is_none_or(|schemas| schemas.values().any(has_unrepresentable_open_map)),
			"items" | "additionalItems" | "contains" | "contentSchema" | "propertyNames" | "if"
			| "then" | "else" | "not" => has_unrepresentable_open_map(child),
			"anyOf" | "allOf" | "oneOf" | "prefixItems" => child
				.as_array()
				.is_none_or(|schemas| schemas.iter().any(has_unrepresentable_open_map)),
			_ => false,
		};
		if incompatible {
			return true;
		}
	}
	false
}

fn strict_node(value: &Value) -> Option<Value> {
	let Value::Object(object) = value else {
		return None;
	};
	if object.is_empty() {
		return None;
	}
	let nullable = object.get("nullable") == Some(&Value::Bool(true));
	let original_required = object
		.get("required")
		.and_then(Value::as_array)
		.map(|required| {
			required
				.iter()
				.filter_map(Value::as_str)
				.collect::<std::collections::BTreeSet<_>>()
		})
		.unwrap_or_default();
	let mut output = Map::with_capacity(object.len());
	for (key, child) in object {
		if key == "const" {
			output.insert("enum".into(), Value::Array(vec![child.clone()]));
			continue;
		}
		if key == "additionalProperties" || STRICT_FORBIDDEN_KEYS.contains(&key.as_str()) {
			continue;
		}
		let normalized = match key.as_str() {
			"properties" | "$defs" | "definitions" => strict_schema_map(child)?,
			"items" => {
				if let Value::Array(values) = child {
					Value::Array(values.iter().map(strict_node).collect::<Option<Vec<_>>>()?)
				} else {
					strict_node(child)?
				}
			},
			"anyOf" | "allOf" | "oneOf" | "prefixItems" => {
				let values = child.as_array()?;
				Value::Array(values.iter().map(strict_node).collect::<Option<Vec<_>>>()?)
			},
			_ => child.clone(),
		};
		output.insert(key.clone(), normalized);
	}
	if let Some(Value::Array(types)) = output.get("type").cloned() {
		let description = output.remove("description");
		output.remove("type");
		let mut branches = Vec::with_capacity(types.len());
		for kind in types {
			let Value::String(kind) = kind else {
				return None;
			};
			let mut branch = output.clone();
			if kind != "object" {
				branch.remove("properties");
				branch.remove("required");
				branch.remove("additionalProperties");
			}
			if kind != "array" {
				branch.remove("items");
				branch.remove("prefixItems");
			}
			branch.insert("type".into(), Value::String(kind.clone()));
			if kind == "object" {
				seal_object(&mut branch, &original_required);
			}
			branches.push(Value::Object(branch));
		}
		output = Map::new();
		output.insert("anyOf".into(), Value::Array(branches));
		if let Some(description) = description {
			output.insert("description".into(), description);
		}
	}
	if output.get("type").and_then(Value::as_str) == Some("object") {
		seal_object(&mut output, &original_required);
	}
	if output.get("type").is_none()
		&& output.get("$ref").is_none()
		&& !["anyOf", "allOf", "oneOf"]
			.iter()
			.any(|key| output.get(*key).is_some_and(Value::is_array))
	{
		let inferred = output.get("enum").and_then(infer_primitive_enum_type);
		{
			let kind = inferred?;
			output.insert("type".into(), Value::String(kind.into()));
		}
	}
	let result = Value::Object(output);
	if nullable && !accepts_null(&result) {
		Some(nullable_schema(result))
	} else {
		Some(result)
	}
}

fn seal_object(
	object: &mut Map<String, Value>,
	original_required: &std::collections::BTreeSet<&str>,
) {
	let properties = object
		.remove("properties")
		.and_then(|value| value.as_object().cloned())
		.unwrap_or_default();
	let mut strict_properties = Map::with_capacity(properties.len());
	for (name, schema) in properties {
		let schema = if original_required.contains(name.as_str()) || accepts_null(&schema) {
			schema
		} else {
			nullable_schema(schema)
		};
		strict_properties.insert(name, schema);
	}
	let required = strict_properties
		.keys()
		.cloned()
		.map(Value::String)
		.collect();
	object.insert("properties".into(), Value::Object(strict_properties));
	object.insert("required".into(), Value::Array(required));
	object.insert("additionalProperties".into(), Value::Bool(false));
}

fn strict_schema_map(value: &Value) -> Option<Value> {
	let schemas = value.as_object()?;
	let mut output = Map::with_capacity(schemas.len());
	for (name, schema) in schemas {
		output.insert(name.clone(), strict_node(schema)?);
	}
	Some(Value::Object(output))
}

fn nullable_schema(schema: Value) -> Value {
	let Value::Object(mut object) = schema else {
		return Value::Array(Vec::new());
	};
	let description = object.remove("description");
	let mut wrapper = Map::new();
	let branches = if object.len() == 1 {
		object
			.remove("anyOf")
			.and_then(|value| value.as_array().cloned())
			.map(|mut branches| {
				branches.push(serde_json::json!({"type": "null"}));
				branches
			})
	} else {
		None
	}
	.unwrap_or_else(|| vec![Value::Object(object), serde_json::json!({"type": "null"})]);
	wrapper.insert("anyOf".into(), Value::Array(branches));
	if let Some(description) = description {
		wrapper.insert("description".into(), description);
	}
	Value::Object(wrapper)
}

fn accepts_null(value: &Value) -> bool {
	let Some(object) = value.as_object() else {
		return false;
	};
	matches!(object.get("type"), Some(Value::String(kind)) if kind == "null")
		|| matches!(object.get("type"), Some(Value::Array(kinds)) if kinds.iter().any(|kind| kind == "null"))
		|| object
			.get("anyOf")
			.and_then(Value::as_array)
			.is_some_and(|branches| branches.iter().any(accepts_null))
}

fn infer_primitive_enum_type(value: &Value) -> Option<&'static str> {
	let values = value.as_array()?;
	let first = values.first()?;
	let kind = primitive_type(first)?;
	values
		.iter()
		.all(|value| primitive_type(value) == Some(kind))
		.then_some(kind)
}

fn primitive_type(value: &Value) -> Option<&'static str> {
	match value {
		Value::Null => Some("null"),
		Value::Bool(_) => Some("boolean"),
		Value::Number(number) if number.is_i64() || number.is_u64() => Some("integer"),
		Value::Number(_) => Some("number"),
		Value::String(_) => Some("string"),
		Value::Array(_) | Value::Object(_) => None,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn strict_preserves_optional_semantics_and_strips_unsupported_keywords() {
		let projection = normalize_schema(
			&serde_json::json!({
				"type": "object",
				"properties": {
					"required": {"type": "string", "pattern": "^[a-z]+$"},
					"optional": {"type": "integer", "minimum": 1, "description": "maybe"}
				},
				"required": ["required"]
			}),
			true,
			Some(true),
			SchemaDialect::OpenAiChat,
		);
		assert_eq!(projection.strict, Some(true));
		assert_eq!(projection.schema["additionalProperties"], false);
		assert_eq!(projection.schema["required"], serde_json::json!(["required", "optional"]));
		assert!(
			projection.schema["properties"]["required"]
				.get("pattern")
				.is_none()
		);
		assert_eq!(projection.schema["properties"]["optional"]["anyOf"][1]["type"], "null");
		assert_eq!(projection.schema["properties"]["optional"]["description"], "maybe");
	}

	#[test]
	fn responses_dialect_normalizes_one_of_before_strict_enforcement() {
		let projection = normalize_schema(
			&serde_json::json!({"oneOf": [{"type": "string"}, {"type": "integer"}]}),
			true,
			Some(true),
			SchemaDialect::OpenAiResponses,
		);
		assert_eq!(projection.strict, Some(true));
		assert!(projection.schema.get("oneOf").is_none());
		assert_eq!(projection.schema["anyOf"].as_array().map(Vec::len), Some(2));
	}

	#[test]
	fn unknown_capability_and_open_maps_fail_open_without_mutating_semantics() {
		let schema = serde_json::json!({
			"type": "object",
			"properties": {"known": {"type": "string"}},
			"additionalProperties": true
		});
		let unknown = normalize_schema(&schema, true, None, SchemaDialect::OpenAiChat);
		assert_eq!(unknown.strict, None);
		assert_eq!(unknown.fallback, Some(StrictFallbackReason::Unsupported));
		assert_eq!(unknown.schema, schema);
		let open_map = normalize_schema(&schema, true, Some(true), SchemaDialect::OpenAiChat);
		assert_eq!(open_map.strict, Some(false));
		assert_eq!(open_map.fallback, Some(StrictFallbackReason::Unrepresentable));
		assert_eq!(open_map.schema, schema);
	}
}
